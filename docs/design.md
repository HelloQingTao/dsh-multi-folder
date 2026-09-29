# Design

Architecture and invariants of `dsh-multi-folder`.

> **Version note (0.3.0).** The client entry points described below under
> "hero seat election" — the session-header button, the `conversation.input.dock`
> chip, the upstream hero chip, and the fixed fallback launcher — were replaced by
> a single integration with the shell's own surfaces: the `/multi-folder` command
> row in the composer **"+" menu**, which `ctx.commandUi.decorate` opens as the
> official `popupSelect` picker, plus an `@`-trigger source for secondary
> directories. Those sections are kept as design history; for the shipped UI see
> the "Client: shell surfaces (0.3.0)" section below. The host half (interception,
> prompt injection, notifications, config store, remote API) is unchanged.

## Goal

One DSH project (workspace) gains a user-managed set of **secondary working
directories**. The agent's core `cwd` stays the primary workspace; framework-level
interception makes the existing tools work inside the secondary directories under the
session's current sandbox mode; prompt injection and boundary notifications keep the
agent informed. No new tools are added.

## Planes

| Half | File | Role |
| ---- | ---- | ---- |
| Host | `lib/index.js` | Config store, tool-pipeline interception, prompt section, notifications, `/multi-folder` command, sessionless `multiFolder/*` remote API |
| Client | `lib/client.js` | 0.3.0: a `ctx.commandUi.decorate` `popupSelect` spec on the `/multi-folder` "+"-menu row, an `@`-trigger source for the secondary directories, and a cosmetic pass on the menu row — all driving the host through the Remote BFF / shared RPC channel. (Earlier releases registered their own chips and panels; see the version note and Client sections.) |

The package declares both faces: `dsh.bundle.patch` (the host row inserted by
`cordis.patch.yml`) and `dsh.client` (the web bundle at `exports["./client"]`).

## Host: interception

A listener on the `tools/execute` around-dispatch waterfall handles `write`, `edit`,
`pwsh`, and `bash`:

1. Resolve the session's standing policy via
   `sandboxPolicy.resolve({ session: exec.agent.session })`.
2. Canonicalize the target path (`write`/`edit`: `fs.resolve(file_path, { cwd: primary })`
   + `fs.processPath`; `pwsh`/`bash`: the same treatment for the resolved `workdir`).
   This makes `..`, symlinks, and case differences match correctly.
3. **Config guard**: if the canonical path equals the host-owned config file,
   short-circuit with an explicit rejection (see Security).
4. If the canonical path is inside a configured secondary directory, execute the
   operation directly with `{ ...standingPolicy, workspaceRoot: <secondary dir> }`:
   - `write`/`edit` → `fs.writeText` / `fs.editText`;
   - `pwsh`/`bash`, foreground → `shell.resolve({ command, workdir, dshEnv,
     sandboxPolicy })` + `shell.run`, with the canonical workdir so the confinement
     root and the process cwd agree exactly;
   - `pwsh`/`bash`, background (`run_in_background: true`) → the same re-rooted
     request registered through the generic jobs runtime (`ctx.jobs`) exactly like
     the shipped shell tools (`kind` = tool name, `owner` = calling agent, streamed
     reads shaped for `job_output` with sandbox markers, terminal outcome in the
     `completed`/`killed`/`failed` vocabulary). `shell.start` is **async** (it
     publishes the handle only once launch preparation — Windows ACL grants
     included — succeeded, and rejects when preparation is cancelled or fails), so
     the launch is adapted to the jobs runtime's synchronous `run(): JobHooks`
     contract the same way the shipped tools' `processJob` does: the handle is
     awaited, the job-owned `AbortSignal` travels into `shell.resolve` (a cancelled
     job aborts preparation, not just an already-published process), a rejected
     preparation settles the job as `failed` with the real cause, and a read before
     publication is empty. A caller-aborted call falls through to the
     default pipeline, which raises the canonical abort error.
   The result carries the same canonical value/content shapes as the shipped tools, so
   downstream presentation keeps working.
5. Anything else — unknown tools, paths outside every secondary directory, missing
   optional services (`shell`, `jobs`), or a failure **before** the target is
   resolved into a secondary directory (path resolution, config lookup, service
   lookup) — falls through to `next()` and the default pipeline. An explicit
   escalation request (`sandbox_permissions` carrying a non-empty mode string) also
   belongs to the default pipeline, which owns the approval flow; a `null`/empty
   value is not a request and is intercepted normally.

**Why mode parity is free:** the mode field of the standing policy is never touched.
The DSH sandbox backends treat the per-call policy as fully specified and fence by its
`workspaceRoot` + `mode`. `read-only` sessions therefore keep getting denied in
secondary directories exactly as in the primary workspace.

Reads (`read`, `glob`, `grep`) need no interception: the DSH filesystem backend does
not policy-fence read paths.

### Service resolution must be lazy

Loader rows activate in dependency order, and this row deliberately declares no hard
dependency on the shell executor or the command registry. Capturing `ctx.get('shell')`
at apply time can yield `undefined` when the provider row activates later. Therefore:

- `shell` / `shellEnv` are resolved **per call** inside the listener;
- the `/multi-folder` command is registered through
  `ctx.inject(['commands'], ctx => ctx.commands.register(...))`, which activates
  whenever the service appears and is disposed with the plugin fiber.

## Host: configuration store

- Canonical location: `<DSH_HOME>/storages/multi-folder/<workspace-key>.json`
  (`DSH_HOME` falls back to `~/.dsh`), i.e. **outside every agent sandbox root**.
- Writes happen only from user-initiated flows (the `/multi-folder` command
  handler and the `multiFolder/*` remote endpoints) with an explicit
  `workspace-write` policy rooted at the config directory.
- A per-process cache keyed by normalized workspace path hydrates lazily (on
  `agent/created`, `agent/pre-step`, and `tools/execute`). On the interception
  path hydration is **awaited**, not fire-and-forget: a first call that landed
  before the config read resolved would otherwise see an empty cache, fall
  through to the default pipeline, and be fenced against the PRIMARY workspace
  root — a spurious `[sandbox: file access denied under workspace-write mode]`
  for a secondary-directory mutation. Because `sandbox-policy` realpath-canonicalizes
  the policy workspace root while hydration is keyed by the session cwd **as
  spelled in the header**, a workspace reached through a symlinked/junctioned
  ancestor can spell the two differently; the interception consults BOTH keys (and
  the config guard checks both config-path spellings) before falling through.
- **The cache is kept coherent with the file, not frozen at first read.** Each
  cached entry records the `FsVersion` (`dev:ino:size:mtime:ctime`, from
  `fs.stat`) it was read at; a later read reuses the cache only while the file
  still reports that same version, and otherwise re-reads from disk. A directory
  added in **another window or session**, or a **hand edit** of the JSON file, is
  therefore seen on the next read with no restart. Two invariants protect this:
  the version is stamped **before** the read (a write racing in between leaves an
  older stamp, so the next read mismatches and re-reads — stamping after the read
  could cache older content under a newer version), and the config path is
  re-`fs.resolve`d each time (a memoized `FsTarget` goes stale once the file
  appears, since resolve realpaths an existing file, and a stale target would
  defeat the check). `saveDirs` adopts its own write and its new version, so a
  self-write never looks like an external change. The steady cost is one
  resolve + one stat per read.
- Entries are normalized and **de-duplicated on every read** (`sanitizeDirs`,
  keyed by the case-insensitive, slash-normalized path), so the same directory
  repeated on disk — by any spelling — collapses to one row; a repeat add keeps
  a single entry and reports that it did.
- One shared **core** (`coreList` / `coreAdd` / `coreRemove` / `coreSet`)
  implements validation, canonicalization, sanitization, cache write-through,
  and persistence. The command channel and the remote channel both call it, so
  the security surface stays identical on both. Core errors carry bare
  messages; each channel adds its own `multi-folder: ` prefix.

## Host: sessionless remote API

The session-creation page has no session (and no `sessionId`), so the
agent-scoped `commands/execute` remote cannot serve it. Instead the plugin
opens its own **sessionless** endpoints on the shared `/api` RPC channel:

- A **plain-object service** is registered with `ctx.provide('multiFolder', api)`.
  The object carries the gateway-visible binding
  `typertRemote = { service, serviceKey: 'multiFolder', namespace: 'multiFolder' }`
  (frozen), which is exactly what the gateway's `validateBinding` expects.
- A **hand-written Typert contribution** is registered through
  `ctx.inject(['typert'], (t) => t.typert.register(REMOTE_CONTRIBUTION))` —
  the sanctioned manual path documented by `dsh-typert-loader` ("Manual
  `ctx.typert.register()` remains available for contributions that do not use
  a `./typert` artifact"). All five descriptors use `src-json` codecs (no zod
  schemas needed) with `invocation: { kind: 'direct' }`:

  | Endpoint | Parameters (wire) | Result |
  | -------- | ----------------- | ------ |
  | `multiFolder/list` | `workspace` | `{ workspace, dirs, changed: false }` |
  | `multiFolder/add` | `workspace`, `path` | `{ workspace, dirs, changed }` (plus a `note` when the path was already configured) |
  | `multiFolder/remove` | `workspace`, `path` | `{ workspace, dirs, changed }` |
  | `multiFolder/set` | `workspace`, `dirs` | `{ workspace, dirs, changed }` |
  | `multiFolder/listFiles` | `dir`, `query` | `[{ path, kind }]` — direct children of one directory, `path` absolute with POSIX slashes, `query` matched against the last path segment (case-insensitive `includes`) |

  `listFiles` exists for the `@`-reference source: it enumerates the direct
  children of a directory through `fs.resolve` + `fs.listDir`, keeping the
  read-only "list the entries" surface separate from the config-management
  methods (it takes no workspace argument, and `fs.listDir` never reads file
  contents).

  The workspace argument is a **path**, not a session id; the client derives
  it from the workspaces store (`WorkspaceView.path`). Business errors throw
  and arrive at the browser as `{ ok: false, error: { message } }`.
- Gateway mechanics verified against `dsh-api-gateway` + `dsh-typert-registry`:
  `resolveDescriptor` finds the endpoint in `typert.local` (claimable on
  `/api`), direct invocation resolves the receiver through
  `ctx.get('multiFolder')` (global shared store), `validateBinding` reads the
  frozen `typertRemote` property, and src-json parameters tolerate omitted
  wire fields. Both registrations are owned by the plugin fiber, so unloading
  the plugin withdraws them together.
- No notice is armed on the remote channel: pre-session changes have no agent
  to notify. The session created afterwards hydrates the cache on
  `agent/created` and the prompt section renders the directories in the very
  first assembly.
- Note: `src-json` descriptors are boundary-validated only for JSON safety
  (the gateway's `assertJsonValue`), not schema-validated. The service itself
  must therefore treat every argument as hostile — the shared core already
  does (type checks, absolute-path requirement, canonicalization, sanitization,
  primary-workspace exclusion).

## Host: prompt injection and notifications

- One global `systemPrompt.section` (`multi-folder:secondary-dirs`, order 160) whose
  text provider evaluates per assembly: it reads `context.agent.session.header.cwd`
  and renders the configured directories only for sessions that have them.
- Change notifications use the framework's plugin-sourced `notice` context:
  - the command handler arms a pending notice **only when the directory set changed**;
  - the next boundary consumes it — `agent/pre-step` prepends it to the entering
    message batch, or `tools/post-execute` attaches it as `additionalContexts` —
    whichever fires first. No turn is ever interrupted.

## Client

`lib/client.js` is a **hand-maintained factory bundle** in the DSH client-modules
format — no build toolchain:

```js
window.__ModuleLoader__.load({
  id: 'dsh-multi-folder',
  factory: (require) => { /* CJS-style module body; exports = { name, inject, apply } */ },
})
```

### Client: shell surfaces (0.3.0, current)

From 0.3.0 the plugin adds **no widget of its own**. It integrates with two
surfaces the shell already renders, so the entry looks native by construction
(the earlier chips/panels — documented further below as design history — were
replaced because a hand-drawn popup could never match the shell's own styling,
and a click-hijack of the menu row proved unreliable):

- **"+"-menu row from the host command.** The host already registers
  `/multi-folder` with the human-command registry, which is what feeds the
  composer "+" menu's Commands group. Two details matter:
  - the command is registered **without** `input.hint`, because the shipped
    group hides hinted rows unless the draft is empty (`position === 'leading'`);
    without this the entry disappears the moment the user has typed anything.
    The command handler still parses `rawInput`, so `/multi-folder add <path>`
    keeps working when typed by hand.
  - `ctx.commandUi.decorate({ name: 'multi-folder', ui })` hangs a `popupSelect`
    spec on that host command, so a pick (or a bare Enter) opens the shell's own
    option picker — the same surface behind `model` — instead of inserting a bare
    command line. The plugin supplies only data:
    - an "Add working directory" row whose `onSelect` runs `uiWorkspace.pickDirectory()`
      then submits the add;
    - one row per configured directory carrying a `confirmation`
      (`SelectConfirmation`) so removal goes through the shell's tick-to-acknowledge gate.
    - In a real session the picker submits `/multi-folder …` through the Remote BFF
      (so the agent gets the change notice and the run appends to the conversation);
      on the new-session screen it uses the sessionless `multiFolder/*` endpoints,
      keyed by workspace path. `syncAfterCommand` folds the `[MF:JSON]` line the
      command returns back into both client stores.
  - `commandUi` is resolved defensively (`ctx.commandUi` with a `ctx.get` fallback
    and an availability guard), so a shell without the command-ui package simply
    skips the popup and keeps the command usable.
- **A cosmetic menu-row pass.** A `MutationObserver` on `[data-trigger-menu]`
  finds the `dsh-slash-option-command-*` row whose text is `multi-folder` and
  gives it a folder glyph and the localized label, borrowing the official icon /
  alias classes. It is purely visual, idempotent (`data-mf-decorated`), never
  throws, and intercepts nothing.
- **`@` references into secondary directories.** `ctx.inputTriggers.registerSource`
  adds a second `@`-trigger source (its own `name`, so it coexists with the
  shipped `reference` source and renders as its own group). Its `candidates` asks
  the host `multiFolder/listFiles` endpoint per configured directory and returns
  absolute-path rows so the agent can `read` them directly. The whole body is
  wrapped in try/catch and capped (30 rows): a failure degrades to an empty group
  and, per the trigger pipeline's `source-failed` semantics, never affects the
  shipped primary-workspace results.

`inject` (0.3.0): `['remote', 'remote.commands', 'slots', 'workspaces', 'uiWorkspace', 'connection', 'sessions', 'locale', 'inputTriggers', 'commandUi']`.

### Client: earlier surfaces (≤0.2.x, design history)

The bullets below describe the pre-0.3.0 client (session-header button, overlay
panel, and the elected session-creation seats) and are kept for the mechanism
details they document (bundle contract, localization, two-channel host
communication); those UI registrations are no longer made.

- `inject: ['remote', 'remote.commands', 'slots', 'workspaces', 'connection', 'sessions', 'locale']`; the package's
  `dsh.client.inject` lists the packages providing them
  (`@deepseek-ai/dsh-api-gateway`, `@deepseek-ai/dsh-api-remotes`,
  `@deepseek-ai/dsh-client-connection`, `@deepseek-ai/dsh-client-locale`).
- UI registrations: `conversation.session.header.actions` (session-scoped button),
  `shell.overlay` panel, `conversation.input.dock` chip row (session-scoped
  list entry above the composer card — the session-creation page's shipped
  seat), `shell.overlay` hero launcher (root-scoped fixed-position fallback),
  and `conversation.hero.workspaceExtras` (upstream slot; see below). One
  module-level store is shared by all of them, and only ONE session-creation
  entry ever renders (see "hero seat election").
- **Localization (zh / en).** All client copy goes through
  `@deepseek-ai/dsh-client-locale` (always composed by the standard web
  profile). The bundle registers a `multi-folder` dictionary namespace with
  `ctx.effect(() => locale.register(NS, { zh, en }))` — the locale service
  enforces bilingual balance, and the effect ties the dictionaries to the
  plugin fiber. Every slot registration declares `locale: 'multi-folder'`,
  so the renderer synthesizes the `t` seat on component props and
  re-renders mounted outlets on locale switch; list-entry `label`s are
  thunks (`() => t('label')`) that `resolveSlotLabel` re-evaluates per read,
  so registration-time text follows the active locale without
  re-registering. The active locale is the browser language or the user's
  Language preference in Settings; the English UI reads "Multi-folder", the
  Chinese UI keeps 「多工作目录」.
- Host communication, two channels:
  - session mode: `ctx.remote.commands.execute(sessionId, line, [])`. Since
    DSH 0.1.1 the remote takes the composer-images argument as its third
    business argument (empty array for a plain invocation). The return
    value is the RPC envelope `{ ok, value }` where `value` is the
    `CommandExecution`; command result text carries a `[MF:JSON] {…}` line the
    panel parses for structured state.
  - workspace mode (session-creation page): `ctx.connection.rpc.call('/api',
    'multiFolder/<op>', { args })` against the sessionless remote endpoints.
    The panel runs in either mode according to how it was opened; mutations
    and refreshes route per mode, and both modes share the same row/error UI.
- Session switch: a `React.useEffect` on `sessionId` re-points the open panel
  to the current session (reusing the per-session cache) — this also folds a
  workspace-mode panel back into session mode once the first message creates
  the session.
- Caching: per-session cache (`sessionCache`) keeps pure reads off the
  conversation; per-workspace cache (`workspaceCache`) plays the same role for
  the sessionless channel.
- Hero (session-creation page) support — **three candidate seats, one visible
  entry**:
  - The **dock chip** (`conversation.input.dock`, id `multi-folder`,
    order 120) is the shipped seat: a `list` slot the rc.6 shell declares and
    renders directly ABOVE the composer card, in the same band as the
    git-branch chip. The entry receives the dock owner share (`{ session,
    input }`) plus the standard `useSessions` / `useWorkspaces` selector hooks,
    so the hero phase and the target workspace come from framework props instead
    of DOM probing. Detection is DSH-version-adaptive: a shell whose
    `SessionSnapshot` carries `composerPhase` uses
    `composerPhase === 'blank' && (openState === 'open' || blank)`, while DSH
    0.1.2 (no `composerPhase`) uses the settled-blank fallback
    `blank && !running && !promptAttempted && (openState === 'open' || blank)`.
    The row stays **in flow** — `display:flex` with the official hero
    row's 20px indent, no absolute positioning — so the framework's list-slot
    arrangement keeps it clear of every other plugin's dock row. It renders
    only on the session-creation page; an active session keeps its entry in the
    session header, so the two never appear together.
  - The **hero chip** registers into `conversation.hero.workspaceExtras` via
    `slots.inject`, which waits for the declaration: with an upstream DSH
    build that declares the slot, the chip renders inline beside the workspace
    picker; without one, the registration contributes nothing.
  - The **hero launcher** (`shell.overlay` entry, `multi-folder-hero`) is the
    last-resort fallback for shells that declare neither slot. Only then does
    it subscribe to `sessions.list` + `workspaces.list` and observe the
    conversation root's `data-phase="hero"` attribute (MutationObserver on
    `document.body`) to render a fixed-position button; the
    workspace path is derived from the current (blank) session's
    `WorkspaceView.path`, falling back to `SessionSummary.cwd`.
  - **Hero seat election.** Each seat claims a token while its slot declaration
    is live (`slots.inject` fires only for declared slots and disposes on
    collapse); the components render only while holding the best live claim
    (`extras` > `dock` > fallback). The framework arranges *different plugins*
    on a shared `list` slot but has no opinion about one plugin holding several
    alternative seats, so this election is the plugin's own duty.
  - Clicking any of them opens the panel in workspace mode; without a selected
    workspace the panel shows the "pick a workspace first" hint.
- Panel placement: one `panelBody(store, t)` function returns the panel's
  children, spread by whichever wrapper owns the panel — the fixed
  `shell.overlay` panel (session-header path) or an `AnchoredPanel` popover
  rendered by the chip itself (opening upward from the dock row, downward from
  the hero row). `store.anchor` names the owner, and the overlay wrapper stands
  down whenever a chip owns it, so the panel never renders twice.
- Styling: all surfaces use the official `--dsw-alias-*` design tokens
  (`dsh-client-ui-theme`) with inert fallbacks, so themes and applied skins
  restyle this plugin's chip and panel along with the shell's own controls.

## Known limitations

- Each confined command runs under exactly ONE writable root: the Windows ACL
  runner grants a single workspace write SID per process tree (`--write-sid`
  must match `--workspace`), and re-rooting replaces the root. A command whose
  cwd stays the primary workspace therefore cannot create files inside a
  secondary directory — `git -C <secondary> commit`, `cd <secondary>` inside a
  script, `git clone <url> <secondary>`, and absolute-path writes fail with an
  OS-level `Permission denied` (`fatal: Unable to create '.../.git/index.lock':
  Permission denied`) that carries no sandbox marker. Symmetrically, a command
  re-rooted to a secondary directory cannot write the primary workspace in the
  same invocation. The injected prompt states the workdir rule, and a
  `tools/post-execute` heuristic attaches a workdir-fix hint when a failed
  `pwsh`/`bash` run both mentions a configured secondary directory and ends in
  a denial (`permission denied` / `access … denied` / `is denied` / `eacces`;
  the plugin's own `[sandbox: …]` marker lines are excluded from the scan).
  Lifting this to real multi-root confinement needs an upstream change
  (`SandboxExecutionPolicy` carrying extra write roots and the ACL runner
  accepting several workspace write SIDs).
- A **relative** `workdir` never re-roots a run: the shipped shell tools resolve
  it against the session workspace (the primary root), so only an ABSOLUTE path
  into a secondary directory is intercepted. Likewise, changing the process
  directory inside the command (`Set-Location` / `cd`) moves the process cwd but
  not the ACL write root — the reported symptom is an OS-level access denial on
  the file write (Windows error 5, e.g. `torch.save`'s
  `open file failed with error code: 5`), not a sandbox marker. On a BACKGROUND
  run that denial surfaces in the job's `job_output` stream after the tool call
  has already returned, so the `tools/post-execute` hint cannot see it; the fix
  is the same — re-run with an absolute `workdir` inside the secondary directory.
- Intercepted secondary-directory mutations do not participate in the
  `fs/write-intent` / `fs/edit-intent` intent guards (the interception calls
  the backend unconditionally, as a full replacement of the tool body), but
  they DO emit `fs/observed` with a presence observation after success, exactly
  like the shipped tools — so the observation layer stays coherent with the
  file content a re-rooted write/edit produced.
- `presentationMeta` is not computed on the short-circuit path; tool cards fall back to
  their default presentation.
- `sandbox_permissions` escalation on `pwsh`/`bash` calls in secondary directories is
  passed through to the default pipeline, which re-roots the escalated run at the
  PRIMARY workspace — escalation never widens a secondary root. (Background runs are
  NOT passed through: they register with `ctx.jobs` under the same re-rooted policy
  as foreground runs.)
- The interceptor registers a background `pwsh`/`bash` job whenever `ctx.jobs` is
  available; it cannot read the shipped shell tools' per-tool
  `enableRunInBackground: false` config, so a deployment that disables background
  execution would still serve secondary-dir background jobs. Deployments that
  disable background execution should also disable this plugin's shell interception
  or accept that exception.
- The `/multi-folder` command lifecycle rows (`command/run`, `command/done`) are
  visible in the conversation UI by framework design; they are log-only and never
  reach the model. Workspace-mode (session-creation page) operations avoid them
  entirely by using the sessionless remote channel.
- The 0.3.0 surfaces depend on shell internals to different degrees. The
  **`popupSelect` entry** is wired purely through the declared `ctx.commandUi`
  contract (decorate-by-command-name), so it rides the documented API — but a
  decoration never manufactures a row: the name must exist in that session's host
  command catalog, which is why the host half owns the `commands.register`. The
  **"always visible" property** is a shell rule the host half works around: the
  Commands group drops rows carrying an `input.hint` unless the draft is empty,
  so the command must stay hint-less. The **cosmetic menu-row pass** is the only
  part that touches internals — it locates the row via `[data-trigger-menu]`, the
  `dsh-slash-option-command-` row-id prefix, and the bare command name, and borrows
  an official icon/alias class. It is guarded (missing DOM degrades to "row keeps
  its bare name") and a shell restyle can only lose the glyph or localized label,
  never the picker itself. The **`@` source** rides `ctx.inputTriggers.registerSource`;
  its `name` must stay unique under the `@` trigger to coexist with the shipped
  `reference` source, and a failure there only drops its own group.
- Sharing the trigger namespace is safe by construction (unique `name`, one group
  per source) but the trigger order within the `@` menu is a shared space the
  plugin does not control; likewise the Commands group ordering is the shell's.
  Absolute-positioned neighbours in the composer band are no longer a concern
  because the plugin no longer places a widget there.
- The `multiFolder/*` endpoints use hand-written `src-json` Typert descriptors
  registered through `ctx.typert.register`. `src-json` gives JSON-safety
  boundary checks, not schema validation; the shared core performs all
  business validation server-side. DSH versions that change the Typert
  registry contract would need this contribution revisited (the tests assert
  the descriptor shape).

## Tests

`test/smoke-host.mjs` and `test/intercept.mjs` run without the DSH runtime using
mock services and assert: interception, canonicalization, the config guard, both
notification channels, notice gating, command flows, and the sessionless remote
contribution — shape (`add/list/listFiles/remove/set` with `src-json` codecs and
direct invocations) and behavior (list/add/set/remove, idempotence,
sanitization, error prefixing, cross-channel cache coherence). The host mocks also
pin the 0.3.0 config semantics: an unchanged file is served from the cache with
no re-read, an out-of-process edit is picked up on the next read, duplicate
spellings collapse to one entry, a repeat add reports a `note`, and `listFiles`
enumerates a directory (absolute slash paths, kinds preserved, name matching,
last-segment matching on a drilled query, empty result instead of rejection).

`test/smoke-client.mjs` still targets the **pre-0.3.0** client (session-header
button, overlay panel, and the three elected session-creation seats) and
therefore **fails against the 0.3.0 UI**; it needs rewriting against the current
surfaces — the `ctx.commandUi.decorate` `popupSelect` spec (options rows,
add/remove routing, confirmation payload) and the `@`-trigger source (group
merge, absolute paths, error degradation to an empty group). Its
declaration-aware `slots.inject` mock and React shim remain reusable for that.

