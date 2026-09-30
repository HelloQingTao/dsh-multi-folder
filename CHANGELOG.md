# Changelog

All notable changes to this project are documented in this file.

## [0.4.1] — 2026-09-29

Polish and fixes for the owned directory browser introduced in 0.4.0, all
reported from real use.

### Fixed

- **`browse` refused a drive root**: `multi-folder: browse requires a fully
  qualified path`. Stepping up out of `C:/Users/…` produced the parent `C:`,
  which is *drive-relative* on Windows and not an absolute path, so the very
  next hop failed — the browser could not reach a volume root, and therefore
  could not change drive at all. Parents are now canonicalized with their
  trailing slash kept (`C:/`, `//server/share/`), validation happens before any
  trimming, and a trailing slash on a request is tolerated.
- **`makeDir` could build a drive-relative path** when handed a bare `C:`; the
  parent now goes through the same canonicalization, so a created folder always
  lands on the intended volume.
- **The browser let page text read through it.** The shipped "+" popover is a
  *MenuSurface*: its fill is translucent (`--dsw-menu-surface-fill`, light
  `#f8f9fa94`) and legible **only because it is paired with**
  `--dsw-menu-backdrop-filter` (`blur(40px) saturate(150%)`). This plugin borrowed
  the translucent fill without the blur. It now borrows the pair, so the surface
  matches the native popup instead of guessing an opaque card.

### Added

- **"This PC" / 这台电脑 volume level.** A drive root has no parent in the
  filesystem tree, so clicking alone could never cross volumes. Up from a drive
  root now opens a synthetic level listing every mounted volume (probed `A:`–`Z:`,
  unready volumes skipped). It is not selectable: *Choose this directory* and
  *New folder* are disabled there, and its crumb is a label rather than an
  ancestry chain.

### Changed

- **Real glyphs.** Rows no longer print a `⧉` character: folders render a folder
  artwork tinted with the official `--dsw-static-amber-400` (the colour the
  shipped file-type icons use for folders), volumes a host glyph. The `@` menu
  rows already passed `icon: 'folder' | 'file'` to the shell renderer and are
  unchanged.
- **Footer buttons follow the official primitives**: `Button.sm` ghost for
  *Cancel* and `Button.primary` for *Choose this directory*, right-aligned with
  the primary last, no borders and no divider line. The text field follows
  `Input.wrap` (32px, 0.5px stroke, `--dsw-alias-bg-layer-1`, business colour on
  focus). Radius and shadow come from `--dsw-radius-lg` /
  `--dsw-elevation-prominent` like the native popover.

### Tests

- `test/token-hygiene.mjs` (new): fails if any `TOKEN.<key>` referenced in code
  is not defined (a deleted key would splice the literal `undefined` into the
  generated CSS), if any token holds a bare colour instead of a theme `var()`,
  and if a colour survives outside a theme fallback in the browser stylesheet.
- `smoke-host` now pins the drive-root parent, `this-pc/` reachability and the
  non-Windows refusal; `browser` walks home → drive root → volume list purely by
  clicking and asserts the list cannot be committed and uses the drive glyph.

## [0.4.0] — 2026-09-29

### Fixed

- **The plugin never activated on profiles that do not compose the workspace
  UI: `web boot: 1 entry did not activate — pending (waiting for service:
  uiWorkspace)`.** `exports.inject` is a hard activation gate, and the client
  half listed three optional services there — `uiWorkspace` (inherited from
  0.2.x) plus `inputTriggers` and `commandUi` (added in 0.3.0). A profile
  without them left the entire entry pending, so even the `/multi-folder`
  command and the sandbox interception went missing.
  - The inject list is now limited to services every web profile composes.
  - `uiWorkspace` resolves lazily at pick time (`ctx.get`), with the older
    `workspaces.pickDirectory` as fallback;
  - `commandUi` and `inputTriggers` attach through `ctx.inject`, which fires
    when the service appears and never fires when the shell does not compose
    it — the feature is skipped instead of blocking the whole entry.
  - Pinned by a regression gate (`test/activation.mjs`) that applies the client
    bundle against a minimal shell (none of the three present) and a full one.
- **A notice could fail the run and strand the session write handle.** The
  notice `source.kind` was the retired catch-all `plugin`; session format v4
  rejects it from the JSONL writer (`format v4 message requires a producer-owned
  source kind`), so logging a notice after an add/remove threw mid-write. That
  is what surfaced as `session/writer-held` on `command.list` — an older session
  whose "+" Commands group came up empty while fresh sessions worked. The kind is
  now the producer-owned `plugin:dsh-multi-folder`, the spelling the v3→v4
  migration itself produces.

### Added

- **`@` references now drill into subdirectories, like the shipped source.**
  Directory rows carry `drill: true`, so Tab descends instead of committing:
  it inserts the directory with a trailing slash (keeping the quote open for
  spaced paths, exactly as `formatFileMention` does) and the menu re-tracks the
  new query. Queries accept both the alias form (`@<dir-name>/rest`) and the
  absolute form a drill inserts, so Tab works repeatedly, and a breadcrumb
  `header` walks back up. Directories sort before files.
- **An owned directory browser for "Add directory".** `uiWorkspace.pickDirectory()`
  is native-only — a LAN bind, a remote browser client, or a desktop shell
  answers `directory-picker/unavailable` — so the interaction now falls back to
  a browser this plugin draws and serves over the new `multiFolder/browse` +
  `multiFolder/makeDir` endpoints (listing rides the `fs` seam every composition
  provides). The native picker still wins wherever it can answer; a picker that
  refuses degrades to the browser instead of showing an unusable error. The
  browser is drawn entirely from `--dsw-alias-*` tokens, so it follows the theme
  and any applied skin.

### Changed

- `multiFolder/listFiles` takes the workspace and **refuses any directory
  outside the configured secondary roots**, so it cannot degrade into a general
  path enumerator.

## [0.3.0] — 2026-09-28

### Added

- **`@` references reach into the secondary directories.** A dedicated `@`-trigger
  source (registered through `ctx.inputTriggers.registerSource` under its own
  name, so it coexists with the shipped file/session source) asks the new host
  endpoint `multiFolder/listFiles` for the entries of every configured directory
  and merges them as absolute paths under a `多工作区目录 / Multi-folder` group.
  A failure in the source degrades to an empty group and never affects the
  shipped results; merged candidates are capped at 30.
- **`+`-menu entry opening the official option picker.** The shipped composer "+"
  menu's Commands group already lists the host-registered `/multi-folder`
  command; `ctx.commandUi.decorate` now hangs a `popupSelect` spec on it, so
  picking the row opens the shell's own picker (the surface behind `model`):
  an "Add working directory" row that runs the native directory picker, and one
  row per configured directory that removes behind the shell's risk confirmation.
  Inside a real session the picker submits `/multi-folder …` (so the agent is
  notified); on the new-session screen it uses the sessionless `multiFolder/*`
  endpoints.
- **Cross-window config coherence.** `loadDirs` serves the in-process cache only
  while `fs.stat` still reports the exact version it was read at (stamped before
  the read, so a racing write can never leave older content cached under a
  newer stamp), so directories added by another window or session — or by a
  direct edit of the JSON file — are recognized on the next read instead of
  surviving until restart. `saveDirs` adopts its own write.

### Fixed

- **The entry vanished whenever the draft was non-empty.** The shipped Commands
  group hides rows that declare an input hint unless the draft is empty
  (`position === 'leading'`), so `/multi-folder` registered without
  `input.hint`; the command handler still parses `rawInput`, so
  `/multi-folder add <path>` keeps working typed by hand.
- **Duplicate adds.** Normalization plus de-duplication on every read collapse
  the same directory spelled in different slash/case styles into one entry, and
  a repeat pick now reports that it was kept as a single entry instead of
  appearing to do nothing.

### Changed

- Single entry point: the session-header button, the session-creation dock chip,
  the hero chip, and the fallback launcher are gone; the `+` menu is the only
  UI the plugin adds, and its remaining visual code is a cosmetic pass giving
  the row a folder glyph and a localized label.
- `README.md` / `README.zh.md` rewritten for the `+`-menu and `@`-reference
  flows, the cross-window config behavior, and the fork provenance. The npm
  badge and the bare-name install command are dropped: this fork is not
  published to npm, so installs must name the git source (a bare
  `dsh-multi-folder` resolves to the upstream package on the registry).

## [0.2.4] — 2026-09-19

### Fixed

- Adapt background runs in secondary directories permission for DSH 0.1.6

## [0.2.3] — 2026-09-17

### Fixed

- Failures when editing files in secondary locations now report the actual error.

## [0.2.2] — 2026-09-02

### Fixed

- Interception now awaits hydration and consults both spelling keys before falling through.

## [0.2.1] — 2026-08-28

### Fixed

- Fix in DSH 0.1.2 session-creation page folder selection missing.
- Fix in DSH 0.1.2 "Add directory" in an existing session did nothing.

## [0.2.0] — 2026-08-28

### Changed

- Adaptive to DSH 0.1.2 alpha, no longer support DSH 0.1.1 or previous version

## [0.1.6] — 2026-08-22

### Fixed

- **DSH 0.1.1 compatibility: `commands/execute` image argument.** The Remote
  BFF's `commands/execute` now takes three business arguments —
  `(sessionId, line, images)` — plus an optional `AbortSignal`; the client
  gateway validates the count and rejected the previous two-argument call
  with `client api: commands/execute expected 3 business argument(s) plus an
  optional AbortSignal, got 2`. The client now passes `[]` (the plugin never
  attaches composer images). `test/smoke-client.mjs` asserts the new call
  shape.

## [0.1.5] — 2026-08-17

### Changed

- **Session-creation page entry moved above the composer.** The new-session
  entry was a fixed launcher pinned to the bottom-right corner of the page,
  detached from the controls it belongs with. It now renders as a chip row in
  the shipped `conversation.input.dock` band — directly above the composer
  card, indented onto the same left edge as the official workspace/preset chips
  and the git-branch chip — and opens the panel as a popover anchored to the
  chip instead of a panel floating in the opposite corner. The chip also shows
  the configured directory count once its (conversation-row-free) workspace
  read lands.
- The dock row is deliberately **in flow** (`display:flex` + the hero row's
  indent, no absolute positioning, no measurement): the framework arranges
  co-registered `list`-slot entries as sibling rows (sorted by
  `priority`/`order`, one cell per `id`, a loud duplicate-`(id, priority)`
  guard, `display:contents` outlets), so an absolutely positioned row would
  leave that arrangement and silently overlap a neighbour's chip.
- Session-creation seats are now **elected, not stacked**: the three candidate
  surfaces (upstream `conversation.hero.workspaceExtras` chip >
  `conversation.input.dock` row > fixed fallback launcher) each claim a token
  while their slot declaration is live, and only the best live claim renders —
  so the page can never show two Multi-folder entries, whichever shell is
  running. The fallback launcher no longer even wires its `MutationObserver`
  while a declared seat holds the page, and the dock chip reads the hero phase
  and target workspace from framework props (the dock owner share plus the
  standard `useSessions`/`useWorkspaces` hooks) instead of probing the DOM.
- The dock chip renders only on the session-creation page; an active session
  keeps its entry in the session header, so the two never appear at once.
- All client surfaces are restyled from the official `--dsw-alias-*` design
  tokens (`dsh-client-ui-theme`) with inert fallbacks, replacing the previous
  `--color-*` names, which matched no shipped token and therefore always fell
  through to hard-coded greys. Themes and applied skins now restyle this
  plugin's chip and panel along with the shell's own controls.
- The panel body is one shared function spread by whichever wrapper owns it
  (fixed overlay for the session-header path, anchored popover for a chip), so
  both placements render one identical panel and the overlay stands down
  whenever a chip owns the open panel.
- `test/smoke-client.mjs`: the `slots.inject` mock is now declaration-aware
  like the real service (waits fire only while their slot is declared, and a
  collapse disposes the registration), covering all three seats and asserting
  that the other two stand down at each step.

## [0.1.4] — 2026-08-17

### Added

- Failure diagnosis for OS-level permission denials touching secondary
  directories: the Windows ACL runner confines each process tree to ONE writable
  root, so a command whose cwd stays the primary workspace cannot create files
  inside a secondary directory (`git -C <secondary> commit` fails with
  `fatal: Unable to create '.../.git/index.lock': Permission denied`, and the
  failure carries no sandbox marker). A `tools/post-execute` heuristic now
  attaches a workdir-fix hint as an additional context when a failed
  `pwsh`/`bash` run mentions a configured secondary directory and ends in a
  denial; the symmetric case (a run re-rooted to a secondary directory denied a
  write OUTSIDE it) gets its own hint. The plugin's `[sandbox: …]` marker lines
  are excluded from the denial scan.

### Changed

- The injected prompt section now states the single-writable-root constraint
  explicitly: file-creating commands (git included) MUST pass `workdir` inside
  the secondary directory, and `git -C <secondary>` / `cd <secondary>` inside a
  command launched from the primary workspace will be denied.
- `README.md` / `README.zh.md`: new "Permission model / 权限模型" section
  documenting the one-root-per-command rule and the diagnostic hint.
- `docs/design.md`: Known limitations now records the single-writable-root
  constraint, the heuristic hint, and the upstream multi-root direction
  (extra write roots on `SandboxExecutionPolicy` + several workspace write SIDs
  on the ACL runner).

## [0.1.3] — 2026-08-15

### Fixed

- Background `pwsh`/`bash` runs (`run_in_background: true`) whose `workdir` lands in
  a secondary directory were passed through to the default pipeline, which re-rooted
  the sandbox at the PRIMARY workspace — writes inside the secondary directory were
  denied (`[sandbox: file access denied under workspace-write mode]`) even though
  the identical command succeeded in the foreground. The interceptor now registers
  these runs with the generic jobs runtime (`ctx.jobs`) under the same re-rooted
  policy as foreground runs, mirroring the shipped shell tools: `kind` = tool name,
  `owner` = calling agent, streamed reads shaped for `job_output` (loss/spill and
  sandbox markers), and a terminal outcome in the `completed`/`killed` vocabulary.

### Changed

- The injected prompt section now states explicitly that shell tools must pass
  `workdir` inside a secondary directory for both foreground and background runs.
- `docs/design.md`: interception walkthrough and Known limitations updated for the
  background-job path (escalation remains on the default pipeline, rooted at the
  primary workspace).

## [0.1.2] — 2026-08-15

### Changed

- Client UI is now localized through `@deepseek-ai/dsh-client-locale`: the
  bundle registers a `multi-folder` dictionary namespace (zh + en, bilingual
  balance enforced by the locale service), declares `locale:` on every slot
  registration (the renderer supplies the `t` seat and re-renders on locale
  switch), renders all panel/header/hero copy through it, and turns every
  list-entry `label` into a thunk that follows the active locale. The UI
  shows "Multi-folder" in English and 「多工作目录」 in Chinese, following the
  browser language or the Language preference in Settings.

## [0.1.1] — 2026-08-15

### Added

- Session-creation page configuration: a sessionless `multiFolder/*` remote API
  (registered through `ctx.typert.register` with hand-written `src-json`
  descriptors, sharing one validated core with the `/multi-folder` command) lets
  the new-session screen read and edit per-workspace directories before any
  session exists. Client entries: a fixed hero launcher (`shell.overlay`, driven
  by the conversation root's `data-phase` attribute) plus an inline chip for the
  upstream `conversation.hero.workspaceExtras` slot (see docs/upstream-hero-slot.md).

## [0.1.0] — 2026-08-14

### Added

- Secondary working directories per project, user-configured via a session-header UI
  panel or the `/multi-folder` slash command (list / add / remove / set).
- Framework-level tool-pipeline interception (`tools/execute`): `write`, `edit`,
  `pwsh`, `bash` calls landing in a configured secondary directory execute with the
  session's sandbox policy re-rooted to that directory — identical semantics to the
  primary workspace in every sandbox mode. No new tools are added.
- Per-session system-prompt section listing the configured directories.
- Non-interrupting change notifications delivered at the next message boundary
  (`agent/pre-step` and `tools/post-execute` channels), fired only when the directory
  set actually changed.
- Explicit rejection of direct agent writes/edits to the configuration file
  (security boundary: configuration is user-managed).
- Client panel: session-switch auto-sync, per-session caching to avoid redundant
  command rows, add/remove/refresh flows via the Remote BFF.
