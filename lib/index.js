/**
 * dsh-multi-folder — host half.
 *
 * Secondary working directories for a project, delivered as framework-level
 * and UI-level changes only (no new tools):
 *
 * 1. Per-workspace config in a HOST-OWNED store outside the agent's sandbox
 *    (`<DSH_HOME>/storages/multi-folder/<workspace-key>.json`, JSON array of
 *    absolute secondary directory paths), cached in memory and hydrated
 *    lazily per session. Direct write/edit attempts against the config file
 *    are rejected with an explicit message, so the agent can NEVER
 *    self-grant directories — configuration is user-managed by design.
 * 2. Tool-pipeline interception (`tools/execute` around-dispatch waterfall):
 *    `write` / `edit` / `pwsh` / `bash` calls whose path (or resolved
 *    `workdir`) lands inside a configured secondary directory are serviced
 *    here with the session's standing sandbox policy re-rooted to that
 *    directory — identical semantics to the primary workspace in every mode
 *    (read-only denies, workspace-write allows, danger-full-access allows).
 *    Interception OWNS such a call from the moment its target is resolved
 *    inside a secondary directory: an interception failure is reported as the
 *    call's own error and NEVER falls through to the default pipeline, which
 *    fences every call against the PRIMARY workspace root and would therefore
 *    turn any ordinary failure (a missing `old_string`, a locked target, an
 *    unreadable file) into the spurious
 *    `[sandbox: file access denied under workspace-write mode]` marker.
 *    Interception hydrates the configuration AWAITED (never a fire-and-forget
 *    read) and looks the dirs up by BOTH the policy root and the header cwd
 *    spelling, so a cold first call and a symlinked workspace cannot fall
 *    through to the default pipeline and surface a spurious workspace-write
 *    denial for a secondary-directory mutation. Successful write/edit
 *    short-circuits emit `fs/observed` like the shipped tools.
 *    Background shell runs (`run_in_background: true`) register with the
 *    generic jobs runtime (`ctx.jobs`) under the same re-rooted policy,
 *    mirroring the shipped pwsh/bash tools so `job_output` / `job_kill` and
 *    finish notices keep working. `shell.start` is ASYNC (it publishes the
 *    handle only once launch preparation, Windows ACL grants included,
 *    succeeded), so the launcher is adapted to the jobs runtime's synchronous
 *    hooks contract exactly like the shipped tools' `processJob`: the job-owned
 *    AbortSignal drives preparation cancellation and a rejected preparation
 *    settles the job as `failed`. Reads (read/glob/grep) are unfenced and
 *    already work.
 * 3. Prompt injection: one ordered system-prompt section rendered per
 *    assembly from the configured directories of the assembling session.
 * 4. Non-interrupting change notification: configuration changes made via
 *    the `/multi-folder` command arm a pending notice — only when the
 *    directory set actually changed — delivered at the NEXT message
 *    boundary: the next `agent/pre-step` (user send) or the next
 *    `tools/post-execute` (tool-call end), through the framework's native
 *    plugin-sourced `notice` context channel.
 * 5. `/multi-folder` command (list/add/remove/set): the human-command
 *    registry entry the browser UI drives through the Remote BFF.
 * 6. Sessionless remote API: a `multiFolder` namespace registered through
 *    the Typert registry with hand-written `src-json` descriptors and a
 *    plain-object service (`ctx.provide('multiFolder', …)`). Methods are
 *    keyed by workspace PATH (not sessionId), so the session-creation page
 *    — where no session exists yet — can read and edit the configuration
 *    directly. The `/multi-folder` command and the remote methods share
 *    one core so validation, canonicalization, and the config guard are
 *    identical on both channels.
 * 7. Failure diagnosis: a `pwsh`/`bash` run that ends in an OS-level
 *    `Permission denied` touching a secondary working directory (the ACL
 *    runner confines each process tree to ONE writable root, so `git -C
 *    <secondary>` launched from the primary workspace cannot write the
 *    repo) gets a workdir-fix hint attached as an additional context at
 *    the `tools/post-execute` boundary.
 */

import { join } from 'node:path'
import os from 'node:os'
import { mkdir, readdir, stat } from 'node:fs/promises'
import { statSync } from 'node:fs'

export const name = 'dsh-multi-folder'
export const inject = ['fs', 'sandboxPolicy', 'systemPrompt']

/** Cap for one level of the plugin's own directory browser. */
const MAX_BROWSE_ENTRIES = 1000

/**
 * Virtual level listing the Windows volumes. A drive root has no parent in the
 * filesystem tree, so without this the browser can never walk from one volume
 * to another; the client renders it as "This PC" and must not commit it.
 */
const DRIVE_LIST = 'this-pc/'

/** Enumerate existing drive roots (A:–Z:) as browser entries. */
function listDrives() {
  const entries = []
  for (let code = 65; code <= 90; code++) {
    const letter = String.fromCharCode(code)
    try {
      if (statSync(letter + ':/', { throwIfNoEntry: false })?.isDirectory()) {
        entries.push({ name: letter + ':', path: letter + ':/', hidden: false, drive: true })
      }
    } catch {
      // An absent or not-ready volume (empty DVD drive, offline network share)
      // simply does not appear.
    }
  }
  return entries
}

/**
 * Whether one child read straight off the filesystem is a directory the browser
 * may descend into. `readdir` types answer plain entries; a symlink or Windows
 * junction needs one follow-up `stat`. A child that cannot be probed (EPERM on a
 * system directory, EBUSY on a page file) is simply not offered — it must never
 * take the whole listing down, which is what makes volume roots listable.
 */
async function isBrowsableDirectory(parentPhysical, dirent) {
  if (dirent.isDirectory()) return true
  if (!dirent.isSymbolicLink()) return false
  try {
    return (await stat(join(parentPhysical, dirent.name))).isDirectory()
  } catch {
    return false
  }
}

/**
 * Whether this dsh's shell service speaks the `execute` contract. dsh-shell
 * replaced `run`/`start` with `resolve` + `execute`: a plugin that only knows
 * the old shape throws `shell.run is not a function` on a current host, and
 * guessing the other way throws `shell.start is not a function`. Probing per
 * call keeps one build working on both generations.
 */
const shellUsesExecute = (shell) =>
  shell !== undefined && shell !== null && typeof shell.execute === 'function'

/** Host-owned store, outside every agent sandbox root. */
const configDir = () => join(process.env.DSH_HOME || join(os.homedir(), '.dsh'), 'storages', 'multi-folder')
const configFileName = (ws) => String(ws).replace(/[^a-z0-9]+/gi, '-').toLowerCase() + '.json'
const configPathFor = (ws) => join(configDir(), configFileName(ws))
const SECTION_NAME = 'multi-folder:secondary-dirs'
/** Tool guidance sections use orders 100–129; sit clearly after them. */
const SECTION_ORDER = 160
const COMMAND_NAME = 'multi-folder'
const INTERCEPT_TOOLS = new Set(['write', 'edit', 'pwsh', 'bash'])
/** Marker line the browser UI parses out of command results. */
const JSON_MARK = '[MF:JSON]'
const CONFIG_GUARD_TEXT =
  'This file is managed by the dsh-multi-folder plugin. Secondary working directories may only be ' +
  'configured by the user through the UI (session header or session-creation page) or the /multi-folder command; direct edits are rejected.'

export function apply(ctx) {
  const { fs, sandboxPolicy, systemPrompt } = ctx
  // NOTE: shell, shellEnv, and commands are deliberately NOT captured here.
  // Loader rows activate in dependency order, and this row declares no hard
  // dependency on those services — capturing them at apply time can yield
  // `undefined` when their provider rows activate later. The shell executor
  // is resolved per call below, and the command is registered through
  // ctx.inject so it activates whenever the commands service appears.

  let noteSeq = 0
  /** wsKey(primary) -> { dirs: string[] } */
  const dirsCache = new Map()
  /** String(sessionId) -> notice text awaiting the next message boundary. */
  const pendingNotices = new Map()

  // ---------------------------------------------------------------- helpers
  const wsKey = (p) => String(p).replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '')
  const isAbsolute = (p) => /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('/') || p.startsWith('\\\\')
  const pathInside = (p, root) => {
    const P = wsKey(p)
    const R = wsKey(root)
    return P === R || P.startsWith(R + '/')
  }
  const displayPathOf = (target, fallback) =>
    target.displayPath !== undefined && target.displayPath !== null ? String(target.displayPath) : fallback
  const longestRootFirst = (dirs) => [...dirs].sort((a, b) => b.length - a.length)

  /**
   * Canonical form of ONE directory level for the browser, keeping roots
   * fully qualified. `C:` is NOT absolute on Windows (it means "current dir on
   * drive C"), so a drive root has to keep its slash or the next hop rejects
   * it — the reason stepping up to `C:/` used to fail. POSIX `/` and a UNC
   * share root behave the same way.
   */
  function canonicalLevel(p) {
    const raw = String(p).trim().replace(/\\/g, '/')
    if (raw === '') return ''
    const stripped = raw.replace(/\/+$/, '')
    if (stripped === '') return '/'                                      // POSIX root
    if (/^[A-Za-z]:$/.test(stripped)) return stripped + '/'             // C:/
    if (/^\/\/[^/]+\/[^/]+$/.test(stripped)) return stripped + '/'      // //server/share/
    return stripped
  }

  /** Root forms are canonical levels whose parent is nothing. */
  const isRootLevel = (l) => l === '/' || /^[A-Za-z]:\/$/.test(l) || /^\/\/[^/]+\/[^/]+\/$/.test(l)

  /** The parent of one level (canonicalized first), or null at any root. */
  function parentOfLevel(level) {
    const l = canonicalLevel(level)
    if (isRootLevel(l)) return null
    const idx = l.lastIndexOf('/')
    if (idx < 0) return null
    return canonicalLevel(l.slice(0, idx)) || '/'
  }

  /** Join a canonical level with one child name without doubling separators. */
  function childOfLevel(level, name) {
    const l = canonicalLevel(level)
    return isRootLevel(l) ? l + name : l + '/' + name
  }

  /**
   * One level of child directories for the owned browser.
   *
   * The `fs` seam's `listDir` is tried first — it is the sandbox-aware and
   * mockable path — but it probes EVERY child (realpath + stat) and fails the
   * whole directory when one child cannot be probed. Every Windows volume root
   * is exactly that case (`System Volume Information` is EPERM,
   * `hiberfil.sys`/`pagefile.sys` are EBUSY), so a drive root could never be
   * listed and the "This PC" volume list stayed unreachable. A directory the
   * seam cannot answer for is therefore read through node:fs, where only the
   * unreadable children drop out. That is the native picker's own privilege
   * level, and `listDrives`/`makeDir` in this plugin already work that way.
   */
  async function listBrowseChildren(target) {
    try {
      const children = await fs.listDir(target)
      return (children ?? [])
        .filter((child) => child !== null && child !== undefined && child.type === 'directory')
        .map((child) => ({ name: String(child.name) }))
    } catch {
      const physical = fs.processPath(target)
      const dirents = await readdir(physical, { withFileTypes: true })
      const out = []
      for (const dirent of dirents) {
        if (await isBrowsableDirectory(physical, dirent)) out.push({ name: String(dirent.name) })
      }
      return out
    }
  }

  // ----------------------------------------------------------- config store
  function sanitizeDirs(list, ws) {
    const out = []
    const seen = new Set()
    for (const item of list) {
      if (typeof item !== 'string' || item.trim().length === 0) continue
      const abs = item.trim()
      if (!isAbsolute(abs)) continue
      if (wsKey(abs) === wsKey(ws)) continue // never the primary workspace itself
      const key = wsKey(abs)
      if (seen.has(key)) continue
      seen.add(key)
      out.push(abs)
    }
    return out
  }

  /** Canonical absolute path for a user-supplied directory (handles `..`, symlinks). */
  async function canonicalizeAbs(path) {
    try {
      const target = await fs.resolve(path.trim())
      return fs.processPath(target)
    } catch {
      return null
    }
  }

  /**
   * Sentinel for "the config file does not exist". `undefined` stays reserved
   * for "version unknown" (a failed stat), which must force a re-read instead
   * of matching a cached entry.
   */
  const ABSENT = Symbol('mf-config-absent')

  /**
   * Current on-disk version of the config file, or ABSENT (absent file) /
   * undefined (stat failed).
   *
   * The path is re-resolved on every call on purpose: a memoized FsTarget goes
   * stale once the file appears (resolve realpaths an existing file, not an
   * absent one), and a stale target would silently defeat the version check.
   */
  async function configVersion(ws) {
    try {
      const info = await fs.stat(await fs.resolve(configPathFor(ws)))
      return info === undefined ? ABSENT : info.version
    } catch {
      return undefined
    }
  }

  /**
   * Read the workspace's secondary directories.
   *
   * The in-process cache is kept coherent with the on-disk config instead of
   * being read once and frozen: the cached copy is served only while `fs.stat`
   * still reports the exact version it was read at, so a configuration written
   * by ANOTHER window, another session, or a direct edit of the JSON file is
   * picked up on the next read rather than surviving until restart. The steady
   * cost is one stat per read; a symlinked workspace cannot confuse the check
   * because the version is `dev:ino:size:mtime:ctime` of the resolved target.
   */
  async function loadDirs(ws) {
    if (typeof ws !== 'string' || ws.length === 0) return { dirs: [] }
    const key = wsKey(ws)
    const cached = dirsCache.get(key)
    if (cached !== undefined) {
      const version = await configVersion(ws)
      // undefined (stat failed) falls through and re-reads conservatively.
      if (version !== undefined && version === cached.version) return cached
    }
    // Stamp the version BEFORE reading. A write that lands between the stat and
    // the read then leaves the cached copy stamped with the OLDER version, so
    // the next read mismatches and re-reads; stamping after the read could
    // cache older content under a version that already covers a newer write.
    const version = await configVersion(ws)
    const fresh = { dirs: [], version }
    try {
      const target = await fs.resolve(configPathFor(ws))
      const raw = await fs.readText(target)
      const parsed = JSON.parse(raw)
      // sanitizeDirs de-duplicates externally-written entries too, so the same
      // directory spelled twice on disk still shows up once.
      if (Array.isArray(parsed)) fresh.dirs = sanitizeDirs(parsed, ws)
    } catch {
      // absent or unreadable config -> empty list
    }
    dirsCache.set(key, fresh)
    return fresh
  }

  function hydrate(ws) {
    if (typeof ws === 'string' && ws.length > 0) void loadDirs(ws)
  }

  async function saveDirs(ws, dirs) {
    const content = JSON.stringify(dirs, null, 2) + '\n'
    const target = await fs.resolve(configPathFor(ws))
    // Config writes are user-initiated (via the UI command); the store lives
    // outside every agent sandbox root, so the explicit policy is rooted at
    // the host-owned config directory itself.
    await fs.writeText(target, content, undefined, undefined, {
      mode: 'workspace-write',
      workspaceRoot: configDir(),
    })
    // Adopt what we just wrote, including its new version, so our own write
    // never looks like an external change to the next read.
    const key = wsKey(ws)
    const entry = dirsCache.get(key)
    if (entry === undefined) dirsCache.set(key, { dirs: [...dirs], version: await configVersion(ws) })
    else {
      entry.dirs = [...dirs]
      entry.version = await configVersion(ws)
    }
  }

  function dirsForSync(ws) {
    if (typeof ws !== 'string' || ws.length === 0) return null
    const entry = dirsCache.get(wsKey(ws))
    if (entry === undefined || entry.dirs.length === 0) return null
    return entry.dirs
  }

  function dirsText(ws, dirs) {
    if (dirs.length === 0) return 'No secondary working directories configured for ' + ws + '.'
    return 'Secondary working directories for ' + ws + ':\n' + dirs.map((d) => '- ' + d).join('\n')
  }

  // ----------------------------------------------------- shared config core
  // One validated, canonicalizing write-through core shared by the
  // `/multi-folder` command and the sessionless `multiFolder/*` remote
  // endpoints. Errors thrown here carry bare messages; each channel adds
  // its own `multi-folder: ` prefix.

  const requireWorkspace = (ws) => {
    if (typeof ws !== 'string' || ws.length === 0) throw new Error('workspace is required')
    return ws
  }

  const coreList = async (ws) => {
    ws = requireWorkspace(ws)
    const entry = await loadDirs(ws)
    return { workspace: ws, dirs: [...entry.dirs], changed: false }
  }

  const coreAdd = async (ws, path) => {
    ws = requireWorkspace(ws)
    if (typeof path !== 'string' || path.length === 0) throw new Error('add requires a path')
    if (!isAbsolute(path)) throw new Error('add requires an absolute path')
    const canonical = await canonicalizeAbs(path)
    if (canonical === null) throw new Error('cannot resolve path "' + path + '"')
    const entry = await loadDirs(ws)
    const next = sanitizeDirs([...entry.dirs, canonical], ws)
    const changed = next.length !== entry.dirs.length
    entry.dirs = next
    if (changed) await saveDirs(ws, next)
    // A repeat pick is not an error: the entry stays single. Say so, so the
    // user sees why the count did not move.
    let note
    if (!changed) {
      note =
        wsKey(canonical) === wsKey(ws)
          ? 'Note: that is the primary workspace itself, so it is not listed as a secondary directory.'
          : 'Note: already configured, kept as one entry (no duplicate added).'
    }
    return { workspace: ws, dirs: [...next], changed, note }
  }

  const coreRemove = async (ws, path) => {
    ws = requireWorkspace(ws)
    if (typeof path !== 'string' || path.length === 0) throw new Error('remove requires a path')
    const canonical = await canonicalizeAbs(path)
    const key = wsKey(canonical === null ? path : canonical)
    const entry = await loadDirs(ws)
    const next = entry.dirs.filter((d) => wsKey(d) !== key)
    const changed = next.length !== entry.dirs.length
    entry.dirs = next
    if (changed) await saveDirs(ws, next)
    return { workspace: ws, dirs: [...next], changed }
  }

  const coreSet = async (ws, paths) => {
    ws = requireWorkspace(ws)
    if (!Array.isArray(paths)) throw new Error('set requires an array of absolute paths')
    const canon = []
    for (const p of paths) {
      if (!isAbsolute(p)) throw new Error('set requires absolute paths')
      const c = await canonicalizeAbs(p)
      if (c === null) throw new Error('cannot resolve path "' + p + '"')
      canon.push(c)
    }
    const entry = await loadDirs(ws)
    const next = sanitizeDirs(canon, ws)
    const changed = JSON.stringify(next) !== JSON.stringify(entry.dirs)
    entry.dirs = next
    if (changed) await saveDirs(ws, next)
    return { workspace: ws, dirs: [...next], changed }
  }

  // ----------------------------------------------- sessionless remote API
  // `multiFolder/*` endpoints over the Typert gateway. Hand-written
  // `src-json` descriptors registered through ctx.typert.register (the
  // sanctioned manual path documented by dsh-typert-loader) plus a
  // plain-object service carrying the gateway's typertRemote binding.
  // No session is involved: parameters are the workspace path and paths.

  const remoteErrorMessage = (e) =>
    'multi-folder: ' + String(e && e.message ? e.message : e).replace(/^multi-folder:\s*/, '')

  const multiFolderApi = {
    async list(workspace) {
      try {
        return await coreList(workspace)
      } catch (e) {
        throw new Error(remoteErrorMessage(e))
      }
    },
    async add(workspace, path) {
      try {
        return await coreAdd(workspace, path)
      } catch (e) {
        throw new Error(remoteErrorMessage(e))
      }
    },
    async remove(workspace, path) {
      try {
        return await coreRemove(workspace, path)
      } catch (e) {
        throw new Error(remoteErrorMessage(e))
      }
    },
    async set(workspace, dirs) {
      try {
        return await coreSet(workspace, dirs)
      } catch (e) {
        throw new Error(remoteErrorMessage(e))
      }
    },
    /**
     * Enumerate the direct children of one directory as `@` file-reference
     * candidates. Powers the "type @ to reference files inside the secondary
     * working directories" feature: the client calls this for a configured
     * secondary directory (or, while the user drills with Tab, for any
     * subdirectory inside one) and merges the results into the @ menu.
     *
     * SECURITY FENCE: `dir` must live inside one of the workspace's configured
     * secondary directories — this endpoint must never degrade into a general
     * directory enumerator for arbitrary host paths. Reads only list names,
     * never content, but the fence keeps the surface honest.
     *
     * Returns path-only candidates whose `path` is the absolute (POSIX-slash)
     * file path, so the model can `read` it directly; directories sort first
     * (matching the shipped @ menu's kindRank) so drilling is discoverable.
     */
    async listFiles(workspace, dir, query) {
      try {
        if (typeof dir !== 'string' || dir.length === 0) return []
        const roots = (await loadDirs(requireWorkspace(workspace))).dirs
        const target = String(dir).replace(/\\/g, '/')
        const inside = roots.some((root) => pathInside(target, root))
        if (!inside) return []
        let fsTarget
        try {
          fsTarget = await fs.resolve(dir)
        } catch {
          return []
        }
        const abs = fs.processPath(fsTarget).replace(/[\\/]+$/, '')
        let listing
        try {
          listing = await fs.listDir(fsTarget)
        } catch {
          return []
        }
        if (!Array.isArray(listing)) return []
        const needle = (typeof query === 'string' ? query : '').replace(/\\/g, '/').toLowerCase()
        // When the query carries a trailing path (e.g. `sub/na`), only the last
        // segment is matched against the entry name; a bare query matches name
        // or presence anywhere in the path.
        const lastSeg = needle.lastIndexOf('/') >= 0 ? needle.slice(needle.lastIndexOf('/') + 1) : needle
        const out = []
        for (const entry of listing) {
          if (entry.type !== 'file' && entry.type !== 'directory') continue
          const name = String(entry.name)
          if (lastSeg !== '' && !name.toLowerCase().includes(lastSeg)) continue
          out.push({ path: abs.replace(/\\/g, '/') + '/' + name, kind: entry.type })
        }
        out.sort((a, b) => {
          if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1
          return a.path < b.path ? -1 : a.path > b.path ? 1 : 0
        })
        return out
      } catch (e) {
        throw new Error(remoteErrorMessage(e))
      }
    },
    /**
     * List the child DIRECTORIES of one path for the plugin's own directory
     * browser. Exists because `uiWorkspace.pickDirectory()` is native-only: a
     * LAN bind, a remote browser client, or a desktop shell answers
     * `directory-picker/unavailable`, and the shipped in-app browser is closed
     * to plugins. Listing rides the `fs` seam every composition provides, so
     * the browser works everywhere. Names only — never content — capped so one
     * huge level cannot flood the RPC, and it never touches the config store.
     */
    async browse(path) {
      try {
        // `fs.resolve` is fed the OS-native spelling; only what goes back to
        // the client is normalized to slashes.
        const homeNative = os.homedir()
        const home = homeNative.replace(/\\/g, '/')
        const wanted = typeof path === 'string' ? path.trim() : ''
        // The drive list: the only click path between volumes on Windows, since
        // a drive root has no parent in the filesystem tree. Not selectable —
        // the client must disable "choose" while it is showing.
        if (wanted === DRIVE_LIST) {
          if (process.platform !== 'win32') throw new Error('no drive list on this platform')
          return { path: DRIVE_LIST, parent: null, home, drives: true, truncated: false, entries: await listDrives() }
        }
        let absolute
        if (wanted === '') {
          absolute = homeNative
        } else {
          // Validate BEFORE trimming: a drive root's trailing slash is part of
          // being absolute (`C:` alone means "current dir on C", not a path).
          if (!isAbsolute(wanted)) throw new Error('browse requires a fully qualified path')
          absolute = wanted
        }
        let target
        try {
          target = await fs.resolve(absolute)
        } catch {
          throw new Error('cannot resolve "' + absolute + '"')
        }
        const normalized = canonicalLevel(fs.processPath(target))
        let children
        try {
          children = await listBrowseChildren(target)
        } catch {
          throw new Error('not a readable directory: ' + normalized)
        }
        const entries = []
        for (const child of children) {
          const entryName = String(child.name)
          if (entryName === '.' || entryName === '..') continue
          entries.push({
            name: entryName,
            path: childOfLevel(normalized, entryName),
            hidden: entryName.startsWith('.'),
          })
        }
        entries.sort((a, b) => a.name.localeCompare(b.name))
        const truncated = entries.length > MAX_BROWSE_ENTRIES
        if (truncated) entries.length = MAX_BROWSE_ENTRIES
        // Stepping up out of a drive root lands on the drive list; that is what
        // makes "choose a directory on another volume" reachable by clicking.
        const parent = parentOfLevel(normalized)
        return {
          path: normalized,
          parent: parent === null && process.platform === 'win32' && /^[A-Za-z]:\/$/.test(normalized)
            ? DRIVE_LIST
            : parent,
          home,
          truncated,
          entries,
        }
      } catch (e) {
        throw new Error(remoteErrorMessage(e))
      }
    },
    /**
     * Create one child directory for the browser. Mirrors the shipped browse
     * backend by calling Node's `mkdir` (the `fs` seam exposes no creation
     * primitive) on a validated single segment under a fully qualified parent.
     * Non-recursive on purpose: the browser shows the parent, so a missing
     * level is a real failure, not a level to invent.
     */
    async makeDir(parent, name) {
      try {
        if (typeof parent !== 'string' || !isAbsolute(parent.trim())) {
          throw new Error('makeDir requires a fully qualified parent path')
        }
        const segment = typeof name === 'string' ? name.trim() : ''
        if (segment === '' || segment === '.' || segment === '..' || /[/\\]/.test(segment)) {
          throw new Error('makeDir requires a single path segment name')
        }
        // canonicalLevel keeps a drive root absolute (`C:/`, not `C:`), so the
        // child path stays volume-qualified instead of becoming drive-relative.
        const level = canonicalLevel(parent.trim())
        const target = join(level, segment)
        try {
          await mkdir(target)
        } catch (e) {
          if (e && e.code === 'EEXIST') throw new Error('"' + target + '" already exists')
          throw new Error('cannot create "' + target + '": ' + String(e && e.message ? e.message : e))
        }
        return { path: target.replace(/\\/g, '/'), parent: level }
      } catch (e) {
        throw new Error(remoteErrorMessage(e))
      }
    },
  }
  Object.defineProperty(multiFolderApi, 'typertRemote', {
    value: Object.freeze({
      service: multiFolderApi,
      serviceKey: 'multiFolder',
      namespace: 'multiFolder',
    }),
  })

  const remoteParam = (name) => ({ name, wire: name, source: 'json', codec: { mode: 'src-json' } })
  const remoteInvocation = (method, params) => ({
    id: 'dsh-multi-folder#multiFolder/' + method,
    service: 'multiFolder',
    namespace: 'multiFolder',
    method,
    invocation: { kind: 'direct' },
    parameters: params.map(remoteParam),
    result: { mode: 'src-json' },
  })
  const REMOTE_CONTRIBUTION = {
    package: 'dsh-multi-folder',
    face: 'host',
    schemas: [],
    model: { services: [], events: [], objects: [] },
    invocations: [
      remoteInvocation('list', ['workspace']),
      remoteInvocation('add', ['workspace', 'path']),
      remoteInvocation('remove', ['workspace', 'path']),
      remoteInvocation('set', ['workspace', 'dirs']),
      remoteInvocation('listFiles', ['workspace', 'dir', 'query']),
      remoteInvocation('browse', ['path']),
      remoteInvocation('makeDir', ['parent', 'name']),
    ],
  }

  // -------------------------------------------------------- notice channel
  /**
   * The notice's source kind MUST be producer-owned (`plugin:<plugin>`), not the
   * retired catch-all `plugin`: session format v4 rejects the latter —
   * `session-format-v3-to-v4` throws `format v4 message requires a producer-owned
   * source kind` from the JSONL writer on every appended event, which fails the
   * run the moment a notice is logged and can leave the session write handle
   * retained (surfacing later as `session/writer-held` on command.list). The
   * `plugin:<plugin>` spelling is also what the v3→v4 migration produces for a
   * non-first-party producer, so older logs converge on it.
   */
  const NOTICE_KIND = 'plugin:' + name
  const noticeMessage = (text) => ({
    id: 'mf-note-' + (++noteSeq),
    role: 'user',
    content: [{ type: 'text', text }],
    source: {
      kind: NOTICE_KIND,
      plugin: name,
      form: 'notice',
      summary: String(text).split('\n')[0].slice(0, 120),
    },
  })

  const armNotice = (agent, text) => {
    if (!agent || !agent.session) return
    pendingNotices.set(String(agent.session.id), text)
  }

  const takeNotice = (agent) => {
    if (!agent || !agent.session) return undefined
    const key = String(agent.session.id)
    const text = pendingNotices.get(key)
    if (text !== undefined) pendingNotices.delete(key)
    return text
  }

  // -------------------------------------------- failure diagnosis (post-exec)
  // The Windows ACL runner confines each process tree to exactly ONE writable
  // workspace root (a single `--write-sid` that must match `--workspace`). A
  // command that creates files inside a secondary directory while its cwd is
  // confined elsewhere therefore fails with an OS-level `Permission denied`
  // (git: `fatal: Unable to create '.../.git/index.lock': Permission denied`)
  // and carries NO sandbox marker — the sandbox worked as designed. These
  // helpers surface the workdir fix at the next tool-call boundary instead.

  const DENIAL_MARK = /permission denied|access(?: is)? denied|eacces|is denied/i

  const flattenResultText = (result) => {
    const parts = []
    if (result && Array.isArray(result.content)) {
      for (const block of result.content) {
        if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
      }
    }
    const value = result && result.value
    if (value && typeof value === 'object') {
      for (const stream of [value.stdout, value.stderr]) {
        if (stream && typeof stream.text === 'string') parts.push(stream.text)
      }
    }
    // The plugin's own `[sandbox: ...]` markers describe runner-level denials,
    // not path-level EACCES; keep them out of the scan.
    return parts
      .join('\n')
      .split('\n')
      .filter((line) => !line.startsWith('[sandbox:'))
      .join('\n')
  }

  /** The configured secondary dir a call's workdir lands in, or null. */
  const workdirHitFor = async (exec) => {
    if (!exec || !exec.agent || !exec.agent.session || !exec.agent.session.header) return null
    const primary = exec.agent.session.header.cwd
    if (typeof primary !== 'string' || primary.length === 0) return null
    const dirs = dirsForSync(primary)
    if (dirs === null) return null
    const args = exec.arguments || {}
    const rawWorkdir = typeof args.workdir === 'string' ? args.workdir : null
    const joined =
      rawWorkdir === null
        ? String(primary)
        : isAbsolute(rawWorkdir)
          ? rawWorkdir
          : String(primary).replace(/[\\/]+$/, '') + '/' + rawWorkdir
    const target = await fs.resolve(joined, { cwd: primary })
    const abs = fs.processPath(target)
    return longestRootFirst(dirs).find((d) => pathInside(abs, d)) ?? null
  }

  /**
   * A user-visible diagnostic for a shell run that ended in an OS-level
   * permission denial touching a secondary working directory. Returns the
   * hint text or undefined. Never throws — a hint failure must never touch
   * the tool pipeline.
   */
  const permissionHint = async (exec, result) => {
    try {
      if (!exec || (exec.name !== 'pwsh' && exec.name !== 'bash')) return undefined
      if (!exec.agent || !exec.agent.session || !exec.agent.session.header) return undefined
      const exitCode =
        result && result.value && typeof result.value.exitCode === 'number' ? result.value.exitCode : null
      if (exitCode !== null && exitCode === 0) return undefined
      if (!DENIAL_MARK.test(flattenResultText(result))) return undefined
      const primary = exec.agent.session.header.cwd
      if (typeof primary !== 'string' || primary.length === 0) return undefined
      const dirs = dirsForSync(primary)
      if (dirs === null) return undefined
      const reRooted = await workdirHitFor(exec)
      if (reRooted !== null) {
        return (
          'This command ran confined to the secondary working directory "' +
          reRooted +
          '", so writes OUTSIDE that directory (for example to the primary workspace or another secondary directory) were denied at the OS level. ' +
          "Split the work into per-directory commands and set each command's `workdir` to the directory it writes into."
        )
      }
      const cmdNorm = wsKey(String((exec.arguments || {}).command || ''))
      const referenced = longestRootFirst(dirs).find((d) => cmdNorm.includes(wsKey(d)))
      if (referenced === undefined) return undefined
      return (
        'This command ran with its cwd confined to the primary workspace, so creating files inside the secondary working directory "' +
        referenced +
        '" was denied at the OS level — each command can write inside only ONE root. ' +
        'Re-run it with `workdir` set to that directory; for git, run the command from inside the repository instead of using `git -C` from the primary workspace.'
      )
    } catch {
      return undefined
    }
  }

  // ------------------------------------------------------ prompt injection
  systemPrompt.section({
    name: SECTION_NAME,
    order: SECTION_ORDER,
    text: (context) => {
      const ws =
        context.agent && context.agent.session && context.agent.session.header
          ? context.agent.session.header.cwd
          : undefined
      if (typeof ws !== 'string' || ws.length === 0) return ''
      const dirs = dirsForSync(ws)
      if (dirs === null) return ''
      return (
        'Secondary working directories are available in this session (dsh-multi-folder plugin):\n' +
        dirs.map((d) => '- ' + d).join('\n') +
        '\nYou have the SAME read/write/edit and command-execution permissions on these directories as on the primary workspace under the current sandbox mode, ' +
        'but each command can write inside only ONE root — the directory its workdir resolves to. ' +
        'A command whose cwd stays the primary workspace CANNOT create files inside a secondary directory. ' +
        'For shell tools, pass `workdir` holding the ABSOLUTE path of one of these directories — foreground and background (`run_in_background`) runs alike. ' +
        'A relative `workdir` is resolved against the PRIMARY workspace, never against a secondary directory. ' +
        'File-creating commands, git included, MUST set `workdir` to the secondary directory: do not run `git -C <secondary>` or `cd <secondary>` inside a command launched from the primary workspace — changing the process directory inside the command (`Set-Location` / `cd`) does NOT widen the writable root, so writes into a secondary directory then fail with an OS-level access denial (Windows error 5). ' +
        'Reads from these directories work without `workdir`. The primary workspace remains the default working directory.'
      )
    },
  })

  // ----------------------------------------------- notification (pre-step)
  ctx.on('agent/pre-step', async (payload, next) => {
    if (payload.agent && payload.agent.session && payload.agent.session.header) {
      hydrate(payload.agent.session.header.cwd)
    }
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    const text = takeNotice(payload.agent)
    if (text === undefined) return decision
    return { kind: 'enter', messages: [noticeMessage(text), ...decision.messages] }
  })

  // --------------------------------------- notification (tool-call boundary)
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    const extras = []
    const notice = takeNotice(exec.agent)
    if (notice !== undefined) extras.push(notice)
    const hint = await permissionHint(exec, result)
    if (hint !== undefined) extras.push(hint)
    if (extras.length === 0) return decision
    const msgs = extras.map((text) => noticeMessage(text))
    if (decision.kind === 'block') {
      return {
        kind: 'block',
        feedback: decision.feedback,
        additionalContexts: [...msgs, ...(decision.additionalContexts || [])],
      }
    }
    return { ...decision, additionalContexts: [...msgs, ...(decision.additionalContexts || [])] }
  })

  // ------------------------------------------------- tool-pipeline intercept
  const shellRender = (value) => {
    let text = value.stdout && typeof value.stdout.text === 'string' ? value.stdout.text : ''
    if (value.stderr && typeof value.stderr.text === 'string' && value.stderr.text.length > 0) {
      text += text.endsWith('\n') ? '' : '\n'
      text += value.stderr.text
    }
    if (value.exitCode !== 0) {
      text += text.endsWith('\n') ? '' : '\n'
      text += '[exit code: ' + value.exitCode + ']'
    }
    if (value.sandbox && value.sandbox.denied) {
      text += '\n[sandbox: file access denied under ' + value.sandbox.mode + ' mode]'
    }
    return text
  }

  /** Terminal outcome for a background process, in the jobs-registry vocabulary. */
  const processOutcome = (proc) => {
    if (proc.status === 'killed') {
      return {
        status: 'killed',
        detail: proc.signal !== null && proc.signal !== undefined ? 'signal: ' + proc.signal : 'killed before exit',
      }
    }
    return {
      status: 'completed',
      detail: 'exit code: ' + (proc.exitCode === undefined || proc.exitCode === null ? 0 : proc.exitCode),
    }
  }

  /**
   * Adapt one asynchronous background launch to the jobs runtime's SYNCHRONOUS
   * hooks contract, mirroring the shipped pwsh/bash tools' `processJob`.
   *
   * Both shell generations are ASYNC at launch: the legacy `shell.start` and the
   * current `shell.execute` resolve the process handle only after launch
   * preparation (Windows ACL grants included) and reject when preparation is
   * cancelled or fails — so the handle can never be dereferenced from `run()`.
   * Calling it as if it returned a process made every background run in a
   * secondary directory fail immediately with
   * `Cannot read properties of undefined (reading 'then')` (`proc.done` read
   * off the un-awaited promise). The job-owned AbortSignal travels into
   * `shell.resolve`, so `cancel` stops a launch that has not published a handle
   * yet, and a rejected preparation settles the job as `failed` instead of
   * leaving it running forever. A background process outlives the tool call, so
   * no CALLER signal is forwarded; `shell.start` ignores `timeoutMs` by design.
   */
  const startBackgroundJob = (shell, request) => {
    const controller = new AbortController()
    let proc
    const done = (async () => {
      try {
        const resolved = shell.resolve({ ...request, signal: controller.signal })
        // A background run has no caller deadline to arm: `onExpiry: 'none'`
        // leaves the process alive after the tool call returns, which is what the
        // legacy `shell.start` did by ignoring `timeoutMs` by design.
        proc = shellUsesExecute(shell)
          ? await shell.execute({ ...resolved, onExpiry: 'none' })
          : await shell.start(resolved)
        try {
          if (controller.signal.aborted) proc.kill()
        } finally {
          await proc.done
        }
        return processOutcome(proc)
      } catch (error) {
        return {
          status: controller.signal.aborted && proc === undefined ? 'killed' : 'failed',
          detail: error && error.message !== undefined ? String(error.message) : String(error),
        }
      }
    })()
    return {
      cancel: (reason) => {
        if (controller.signal.aborted) return
        controller.abort(reason)
        if (proc !== undefined) proc.kill()
      },
      done,
      readOutput: () => (proc === undefined ? '' : renderProcessRead(proc.readOutput(), proc.sandbox)),
    }
  }

  /**
   * One consuming background read, shaped for `job_output`: the raw delta plus
   * loss/spill notices and sandbox markers, mirroring the shipped pwsh/bash
   * tools' background rendering. No escalation hint is appended — escalation
   * calls stay on the default pipeline, which re-roots at the primary
   * workspace, so this job can never receive a wider policy.
   */
  const renderProcessRead = (read, sandbox) => {
    const notices = []
    if (read.lossy) {
      const paths = [read.stdoutSpillPath, read.stderrSpillPath].filter((path) => path !== undefined)
      notices.push(
        '[some output was dropped from memory; full output: ' +
          (paths.length > 0 ? paths.join(', ') : '(unavailable)') +
          ']',
      )
    }
    if (sandbox && sandbox.runnerFailed) {
      notices.push(
        '[sandbox: the sandbox runner itself failed under ' + sandbox.mode +
          ' mode — the command did not run; this is a sandbox problem, not a command failure]',
      )
    } else if (sandbox && sandbox.denied) {
      notices.push('[sandbox: file access denied under ' + sandbox.mode + ' mode]')
    }
    if (notices.length === 0) return read.delta
    return read.delta + (read.delta.length > 0 && !read.delta.endsWith('\n') ? '\n' : '') + notices.join('\n')
  }

  /**
   * Model-facing failure for a call the interception OWNS (see the ownership
   * rule below). A claimed call is never handed back to the default pipeline,
   * so its real error reaches the model in the shipped tools' error envelope —
   * `Error: <message>` plus the `FS_*` code — instead of the primary-rooted
   * sandbox denial. A genuine sandbox denial (read-only mode) keeps the standard
   * marker plus the one-shot escalation hint, exactly as the shipped
   * `write`/`edit` tools render it, so the escalation flow is unchanged.
   */
  const ownedFailure = (error, policy) => {
    const code = error && typeof error.code === 'string' && error.code.length > 0 ? error.code : undefined
    const message =
      code === 'FS_SANDBOX_DENIED'
        ? '[sandbox: file access denied under ' + policy.mode + ' mode]\n' +
          '[sandbox: escalation available \u2014 retry this exact operation once with sandbox_permissions ' +
          '(the narrowest wider mode that suffices) + justification; the approval prompt asks the user]'
        : String(error && error.message ? error.message : error)
    return {
      isError: true,
      error: { message, ...(code === undefined ? {} : { info: { code } }) },
      content: [{ type: 'text', text: 'Error: ' + message }],
    }
  }

  ctx.on('tools/execute', async (exec, next) => {
    // Hydration must be AWAITED on the interception path, not fire-and-forget:
    // a first call that arrives before the config read resolves would see an
    // empty dirs cache, fall through to the default pipeline, and be fenced
    // against the PRIMARY workspace root — surfacing as a spurious
    // `[sandbox: file access denied under workspace-write mode]` for a
    // secondary-directory write/edit. `loadDirs` caches, so only the first
    // call pays the read.
    const headerCwd =
      exec.agent && exec.agent.session && exec.agent.session.header
        ? exec.agent.session.header.cwd
        : undefined
    if (typeof headerCwd === 'string' && headerCwd.length > 0) {
      await loadDirs(headerCwd)
    }
    if (!INTERCEPT_TOOLS.has(exec.name)) return next()
    // Non-null once the call's target has been resolved into a configured
    // secondary directory: from that point the interception OWNS the call and a
    // failure must be reported as this call's error, never handed back to the
    // default pipeline (which fences against the PRIMARY workspace root and
    // would answer any failure with the spurious workspace-write denial).
    let owned = null
    try {
      const args = exec.arguments
      const standing = sandboxPolicy.resolve(exec.agent ? { session: exec.agent.session } : {})
      const primary = standing.workspaceRoot
      // An explicit escalation request belongs to the default pipeline (it owns
      // the approval flow). Only a non-empty mode string is a request: a
      // null/empty value is not, and must not hand a secondary-directory
      // mutation to the primary-rooted pipeline.
      if (args && typeof args.sandbox_permissions === 'string' && args.sandbox_permissions.length > 0) return next()
      // The policy root is realpath-canonicalized by sandbox-policy while
      // hydration is keyed by the session cwd as spelled in the header; on a
      // workspace reached through a symlinked/junctioned ancestor the two
      // spellings differ, so consult both keys before falling through.
      const dirs =
        dirsForSync(primary) ??
        (typeof headerCwd === 'string' && headerCwd.length > 0 ? dirsForSync(headerCwd) : null)

      if (exec.name === 'write' || exec.name === 'edit') {
        const filePath = args && typeof args.file_path === 'string' ? args.file_path : null
        if (filePath === null) return next()
        // Resolve first so `..`, symlinks, and case differences canonicalize
        // before containment matching (same cwd the shipped tools use).
        let target
        try {
          target = await fs.resolve(filePath, { cwd: primary })
        } catch (error) {
          // An unresolvable ABSOLUTE path that is lexically inside a secondary
          // directory is still this plugin's call to answer: the default pipeline
          // would resolve it against the PRIMARY root and report the sandbox
          // denial, hiding the resolution failure.
          if (dirs !== null && isAbsolute(filePath)) {
            const rawHit = longestRootFirst(dirs).find((d) => pathInside(filePath, d))
            if (rawHit !== undefined) return ownedFailure(error, { ...standing, workspaceRoot: rawHit })
          }
          return next()
        }
        const abs = fs.processPath(target)
        // Security boundary: configuration is user-managed. Reject direct
        // write/edit attempts against the host-owned config file, even before
        // any directory matching. Both spellings of the workspace key are
        // checked (see the dirs lookup above).
        const guardHits = new Set(
          [primary, headerCwd].filter((p) => typeof p === 'string' && p.length > 0).map((p) => wsKey(configPathFor(p))),
        )
        if (guardHits.has(wsKey(abs))) {
          return {
            isError: true,
            error: { message: 'multi-folder configuration is user-managed' },
            content: [{ type: 'text', text: CONFIG_GUARD_TEXT }],
          }
        }
        if (dirs === null) return next()
        const hit = longestRootFirst(dirs).find((d) => pathInside(abs, d))
        if (hit === undefined) return next()
        const policy = { ...standing, workspaceRoot: hit }

        if (exec.name === 'write') {
          owned = { policy }
          const outcome = await fs.writeText(target, String(args.content), undefined, exec.signal, policy)
          // Keep the observation layer coherent with the shipped write tool's
          // contract: a successful create/update is a presence observation.
          if (typeof ctx.emit === 'function') {
            ctx.emit('fs/observed', target, { kind: 'present', version: outcome.version }, exec)
          }
          const displayPath = displayPathOf(target, filePath)
          const value = {
            path: displayPath,
            operation: outcome.operation === 'create' ? 'create' : 'update',
            before: outcome.before === undefined || outcome.before === null ? null : outcome.before,
            after: outcome.after === undefined ? null : outcome.after,
          }
          const content = [{
            type: 'text',
            text:
              '<path>' + displayPath + '</path>\n<type>file</type>\n<content>\n' +
              (outcome.operation === 'create' ? 'Created' : 'Updated') +
              ' file\n</content>',
          }]
          return { isError: false, value, content }
        }

        const oldString = args && typeof args.old_string === 'string' ? args.old_string : null
        const newString = args && typeof args.new_string === 'string' ? args.new_string : null
        if (oldString === null || newString === null) return next()
        const replaceAll = args.replace_all === true
        owned = { policy }
        const outcome = await fs.editText(
          target,
          { oldString, newString, replaceAll },
          undefined,
          exec.signal,
          policy,
        )
        if (typeof ctx.emit === 'function') {
          ctx.emit('fs/observed', target, { kind: 'present', version: outcome.version }, exec)
        }
        const displayPath = displayPathOf(target, filePath)
        const value = { path: displayPath, before: outcome.before, after: outcome.after }
        const text = replaceAll
          ? 'The file ' + displayPath + ' has been updated. All occurrences were successfully replaced.'
          : 'The file ' + displayPath + ' has been updated successfully.'
        return { isError: false, value, content: [{ type: 'text', text }] }
      }

      if (exec.name === 'pwsh' || exec.name === 'bash') {
        const shell = ctx.get('shell')
        if (shell === undefined) return next()
        if (dirs === null) return next()
        const rawWorkdir = args && typeof args.workdir === 'string' ? args.workdir : null
        const joined = rawWorkdir === null
          ? String(primary)
          : isAbsolute(rawWorkdir)
            ? rawWorkdir
            : String(primary).replace(/[\\/]+$/, '') + '/' + rawWorkdir
        // Canonicalize before containment matching, then run in the canonical
        // directory so confinement root and process cwd agree exactly.
        const workdirTarget = await fs.resolve(joined, { cwd: primary })
        const absWorkdir = fs.processPath(workdirTarget)
        const hit = longestRootFirst(dirs).find((d) => pathInside(absWorkdir, d))
        if (hit === undefined) return next()
        const policy = { ...standing, workspaceRoot: hit }
        const shellEnv = ctx.get('shellEnv')
        const request = {
          command: String(args.command),
          workdir: absWorkdir,
          ...(args && args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
          ...(shellEnv !== undefined ? { dshEnv: shellEnv.collect(exec) } : {}),
          sandboxPolicy: policy,
        }

        // Background runs get the SAME re-rooted policy as foreground runs.
        // They register with the generic jobs runtime (`ctx.jobs`) exactly
        // like the shipped pwsh/bash tools do, so `job_output` / `job_kill`
        // and the finish notice keep working for the intercepted job.
        if (args && args.run_in_background === true) {
          // An aborted call belongs to the default pipeline, which raises the
          // canonical abort error before anything starts.
          if (exec.signal && exec.signal.aborted) return next()
          const jobs = ctx.get('jobs')
          if (jobs === undefined) return next()
          owned = { policy }
          const jobId = jobs.start({
            kind: exec.name,
            label: String(args.command),
            ...(exec.agent ? { owner: exec.agent } : {}),
            run: () => startBackgroundJob(shell, request),
          })
          return {
            isError: false,
            value: { kind: 'background', jobId },
            content: [{ type: 'text', text: 'started background job ' + jobId }],
          }
        }

        owned = { policy }
        const spec = shell.resolve({ ...request, signal: exec.signal })
        // `execute` returns the live handle; its `result()` is the foreground
        // projection. The legacy `shell.run` resolved that projection directly.
        const result = shellUsesExecute(shell)
          ? await (await shell.execute(spec)).result()
          : await shell.run(spec)
        if (result.aborted) {
          return {
            isError: true,
            error: { message: 'tool call aborted' },
            content: [{ type: 'text', text: '[aborted]' }],
          }
        }
        const stream = (s) => ({
          text: s && typeof s.text === 'string' ? s.text : '',
          truncated: !!(s && s.truncated),
          ...(s && s.spillPath !== undefined ? { spillPath: s.spillPath } : {}),
        })
        const value = {
          kind: 'foreground',
          exitCode: result.exitCode === undefined ? null : result.exitCode,
          signal: result.signal === undefined ? null : result.signal,
          timedOut: !!result.timedOut,
          aborted: false,
          timeoutMs: result.timeoutMs === undefined ? null : result.timeoutMs,
          stdout: stream(result.stdout),
          stderr: stream(result.stderr),
          ...(result.sandbox !== undefined
            ? {
                sandbox: {
                  mode: String(result.sandbox.mode),
                  denied: !!result.sandbox.denied,
                  ...(result.sandbox.enforcement !== undefined
                    ? { enforcement: String(result.sandbox.enforcement) }
                    : {}),
                  ...(result.sandbox.runnerFailed !== undefined
                    ? { runnerFailed: !!result.sandbox.runnerFailed }
                    : {}),
                },
              }
            : {}),
        }
        return { isError: false, value, content: [{ type: 'text', text: shellRender(value) }] }
      }
      return next()
    } catch (error) {
      // A failure BEFORE the call was claimed (path resolution, config lookup,
      // shell service lookup) falls back to the default pipeline. A failure
      // AFTER the claim — the mutation or the shell run itself — does not: the
      // default pipeline fences the call against the PRIMARY workspace root, so
      // it could only answer with the spurious workspace-write denial and would
      // hide the real cause (for example a missing `old_string`).
      return owned === null ? next() : ownedFailure(error, owned.policy)
    }
  })

  // ---------------------------------------------------- hydration on start
  ctx.on('agent/created', (payload) => {
    const agent = payload && payload.agent
    if (agent && agent.session && agent.session.header) hydrate(agent.session.header.cwd)
  })

  // ------------------------------------------------------ /multi-folder cmd
  ctx.inject(['commands'], (c) => {
    const commands = c.commands
    const parseArgs = (raw) => {
      const out = []
      let cur = ''
      let inQuote = false
      for (const ch of String(raw)) {
        if (ch === '"') {
          inQuote = !inQuote
        } else if (!inQuote && (ch === ' ' || ch === '\t')) {
          if (cur.length > 0) {
            out.push(cur)
            cur = ''
          }
        } else {
          cur += ch
        }
      }
      if (cur.length > 0) out.push(cur)
      return out
    }

    const jsonLine = (obj) => JSON_MARK + ' ' + JSON.stringify(obj)
    // The [MF:JSON] marker must stay the LAST line (the client parses it with
    // an anchored regex), so any note is inserted before it.
    const resultText = (ws, dirs, changed, note) =>
      dirsText(ws, dirs) + (typeof note === 'string' && note.length > 0 ? '\n' + note : '') + '\n' + jsonLine({ workspace: ws, dirs, changed })

    return commands.register({
      name: COMMAND_NAME,
      description: 'Manage multi-folder secondary working directories',
      // No `input.hint` on purpose: the shipped + menu filters hinted rows out
      // unless the draft is empty (position 'leading'), and we want this row to
      // list there in every state. The handler still parses rawInput, so
      // `/multi-folder add <path>` keeps working typed by hand.
      async handler(invocation) {
        try {
          const ws =
            invocation.agent && invocation.agent.session && invocation.agent.session.header
              ? String(invocation.agent.session.header.cwd)
              : undefined
          if (typeof ws !== 'string' || ws.length === 0) {
            return { kind: 'error', text: 'multi-folder: session workspace is unknown' }
          }
          const argv = parseArgs(invocation.rawInput)
          const sub = argv.length === 0 ? 'list' : argv[0].toLowerCase()
          let outcome
          if (sub === 'list') {
            outcome = await coreList(ws)
          } else if (sub === 'add') {
            outcome = await coreAdd(ws, argv.slice(1).join(' '))
          } else if (sub === 'remove') {
            outcome = await coreRemove(ws, argv.slice(1).join(' '))
          } else if (sub === 'set') {
            outcome = await coreSet(ws, argv.slice(1))
          } else {
            return {
              kind: 'error',
              text: 'multi-folder: unknown subcommand "' + sub + '" (use list / add / remove / set)',
            }
          }
          if (outcome.changed) {
            armNotice(
              invocation.agent,
              'Secondary working directories changed (dsh-multi-folder):\n' + dirsText(ws, outcome.dirs),
            )
          }
          return { kind: 'success', text: resultText(outcome.workspace, outcome.dirs, outcome.changed, outcome.note) }
        } catch (e) {
          return {
            kind: 'error',
            text: 'multi-folder: ' + String(e && e.message ? e.message : e).replace(/^multi-folder:\s*/, ''),
          }
        }
      },
    })
  })

  // ------------------------------------------ sessionless remote API mounts
  // The plain-object service must be reachable through ctx.get('multiFolder')
  // with a visible typertRemote binding, and the typert registry entry makes
  // the endpoints claimable on the shared /api channel. Both are owned by
  // this plugin fiber, so unloading the plugin withdraws them together.
  ctx.provide('multiFolder', multiFolderApi)
  ctx.inject(['typert'], (t) => t.typert.register(REMOTE_CONTRIBUTION))
}
