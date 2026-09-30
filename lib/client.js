/**
 * dsh-multi-folder — client half (hand-written factory bundle, no build step).
 *
 * Session-scoped UI: a localized "Multi-folder" (「多工作目录」) button in the
 * conversation session header (`conversation.session.header.actions`, scope:
 * session) that opens a panel in `shell.overlay` listing the project's
 * secondary working directories. All copy goes through the framework locale
 * service (`@deepseek-ai/dsh-client-locale`) — see the "i18n" section below.
 * Mutations go through the Host `/multi-folder` command via the Remote BFF
 * (`ctx.remote.commands.execute(sessionId, line, [])` — DSH 0.1.1 added the
 * composer-images business argument, empty for a plain invocation); the Host
 * answers with a
 * human-readable result carrying a `[MF:JSON]` line the panel parses for
 * structured state.
 *
 * Session-creation page UI (no message sent yet). Three candidate seats are
 * registered, best first, and EXACTLY ONE renders — see "hero seat election":
 * - `conversation.hero.workspaceExtras` (upstream additive hero row; the
 *   `slots.inject` wait is a no-op until a DSH core declares it);
 * - `conversation.input.dock` (shipped since 0.1.9, declared by rc.6): an
 *   in-flow chip row directly ABOVE the composer card, left-aligned with the
 *   official hero chip row — the same band the git-branch chip uses;
 * - `shell.overlay` fixed-position launcher: last-resort fallback for shells
 *   that declare neither slot.
 * All three open the same panel in WORKSPACE mode and drive the sessionless
 * `multiFolder/*` endpoints over the shared RPC channel
 * (`ctx.connection.rpc.call('/api', endpoint, { args })`), keyed by workspace
 * path instead of sessionId.
 *
 * Layout shape: an entry in the session header action row, one chip row above
 * the composer card on the session-creation page, and a frame-wide overlay
 * panel. Every surface reads one tiny module-scoped store; opening the panel
 * refreshes the list from the Host.
 *
 * ## Hero seat election (multi-plugin coexistence)
 *
 * `conversation.input.dock` is a `list` slot, so the framework already
 * arranges co-registered entries for us: entries are sorted by
 * `(priority, order)`, a duplicate `(id, priority)` pair is rejected at
 * registration with an error naming the sitting occupant, and the outlet
 * renders `display:contents` so each entry becomes its own row of the
 * composer stack. This plugin therefore stays a good citizen by construction:
 * one unique `id`, one explicit `order`, and NO absolute positioning that
 * would escape the framework's arrangement and overlap a neighbour.
 *
 * What the framework does NOT do is stop ONE plugin from occupying several
 * alternative seats at once (each is a legitimate, differently-declared
 * slot). That is this plugin's own duty: each seat claims a token when its
 * declaration arrives (`slots.inject` fires only for declared slots), and the
 * components render only while they hold the best live claim, so the
 * session-creation page never shows two Multi-folder entries.
 */
window.__ModuleLoader__.load({
  // The client module id must equal the npm package name: the host's client
  // module system registers graph rows by package name and rejects a bundle
  // that registers a different id ("loaded without registering ... via
  // __ModuleLoader__.load").
  id: '@zfgcta/dsh-multi-folder',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require('react');

    // ------------------------------------------------------------- store
    var listeners = new Set();
    var state = {
      open: false,
      mode: null,
      sessionId: null,
      dirs: [],
      workspace: null,
      busy: false,
      error: null,
      /** Fallback launcher only: hero visibility derived from the DOM. */
      hero: false,
      heroWorkspace: null,
      /** Live hero-seat claims, in claim order (see "hero seat election"). */
      heroClaims: [],
      /** Which surface owns the open panel: 'overlay' | 'dock' | 'extras'. */
      anchor: 'overlay',
      /** Bumped on every workspaceCache write so chips re-read their count. */
      cacheRev: 0,
      /** Owned directory browser (the fallback when no native picker exists). */
      browserOpen: false,
      browser: null,
      /** ANY operation is in flight: gates the controls. */
      browserBusy: false,
      /**
       * The IN-FLIGHT OPERATION IS A FOLDER CREATION. `browserBusy` alone cannot
       * label that action: navigating a level and committing a directory are
       * busy too, and driving the "new folder" button's label off them made it
       * announce "Creating…" while the user was only choosing a directory.
       */
      browserCreating: false,
      browserError: null,
      browserName: '',
      /** Where the open browser commits to: { workspace, sessionMode, sessionId } | null. */
      browserTarget: null,
    };
    function patch(next) {
      state = Object.assign({}, state, next);
      listeners.forEach(function (fn) { fn(); });
    }
    function subscribe(fn) {
      listeners.add(fn);
      return function () { listeners.delete(fn); };
    }
    function getSnapshot() { return state; }
    function useStore() { return React.useSyncExternalStore(subscribe, getSnapshot); }
    /** sessionId -> { dirs, workspace }: avoids re-running the list command
     *  (and its conversation row) on every panel open. */
    var sessionCache = {};
    /** workspacePathKey -> { dirs, workspace }: the workspace-mode twin of
     *  sessionCache, keyed by the sessionless remote's workspace argument. */
    var workspaceCache = {};

    function workspacePathKey(path) {
      return String(path).replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
    }

    function parseJsonLine(text) {
      if (typeof text !== 'string') return null;
      var m = /\[MF:JSON\]\s*(\{.*\})\s*$/s.exec(text);
      if (!m) return null;
      try { return JSON.parse(m[1]); } catch (_) { return null; }
    }

    /** Stand-in for an absent standard-kit selector hook: runs the selector
     *  against no snapshot, so callers keep one unconditional call site. */
    function selectNothing(selector) { return selector(undefined); }

    // -------------------------------------------------- hero seat election
    /** Candidate seats for the session-creation page, best first. */
    var HERO_SEATS = ['extras', 'dock'];
    /** Order of this plugin's `conversation.input.dock` row. The shipped band
     *  already carries other plugins' entries (the aionui drop inlay at 90/91
     *  and the git-branch chip at 100); 120 keeps this row closest to the
     *  composer card without contesting theirs. */
    var DOCK_ORDER = 120;

    /** The best seat currently claimed, or null when only the fallback is left. */
    function bestHeroSeat(claims) {
      for (var i = 0; i < HERO_SEATS.length; i++) {
        if (claims.indexOf(HERO_SEATS[i]) >= 0) return HERO_SEATS[i];
      }
      return null;
    }

    /** Claim a seat for as long as its slot declaration lives. */
    function claimHeroSeat(kind) {
      patch({ heroClaims: getSnapshot().heroClaims.concat([kind]) });
      return function () {
        var claims = getSnapshot().heroClaims.slice();
        var at = claims.indexOf(kind);
        if (at >= 0) claims.splice(at, 1);
        patch({ heroClaims: claims });
      };
    }

    // ------------------------------------------------------------- theme
    /** Official `--dsw-alias-*` design tokens (dsh-client-ui-theme) with inert
     *  fallbacks, so the surfaces follow the active theme and any applied skin
     *  instead of guessing a palette. */
    var TOKEN = {
      border: 'var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
      borderSoft: 'var(--dsw-alias-border-l1, rgba(127,127,127,0.20))',
      borderInput: 'var(--dsw-alias-border-l4, rgba(127,127,127,0.55))',
      surface: 'var(--dsw-alias-bg-overlay, #ffffff)',
      inputBg: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.06))',
      mask: 'var(--dsw-alias-bg-mask-1, rgba(0,0,0,0.45))',
      blur: 'var(--dsw-mask-blur, none)',
      subtle: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.08))',
      fill: 'var(--dsw-alias-button-tool-bar-fill, rgba(127,127,127,0.10))',
      primaryFill: 'var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, #4c6ef5))',
      primaryHover: 'var(--dsw-alias-button-primary-hover, var(--dsw-alias-brand-primary, #4c6ef5))',
      primaryInk: 'var(--dsw-alias-label-primary-foreground, #ffffff)',
      hover: 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.14))',
      active: 'var(--dsw-alias-interactive-bg-active, rgba(127,127,127,0.20))',
      focus: 'var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary, #4c6ef5))',
      ink: 'var(--dsw-alias-label-primary, #1a1a1a)',
      inkSoft: 'var(--dsw-alias-label-secondary, #4a4a4a)',
      inkMuted: 'var(--dsw-alias-label-tertiary, #6b6b6b)',
      inkFaint: 'var(--dsw-alias-label-caption, #8a8a8a)',
      inkDimmed: 'var(--dsw-alias-label-dimmed, #9a9a9a)',
      danger: 'var(--dsw-alias-state-error-primary, #c62828)',
      folder: 'var(--dsw-static-amber-400, #f5b021)',
      accent: 'var(--dsw-alias-brand-primary, #4c6ef5)',
      // Official scales. The "+" popover is a MenuSurface: radius-lg, its own
      // translucent fill, and its own backdrop-filter — the fill is only
      // legible BECAUSE it is paired with that blur, which is exactly what was
      // missing when page text read straight through this dialog.
      radiusLg: 'var(--dsw-radius-lg, 16px)',
      radiusMd: 'var(--dsw-radius-md, 8px)',
      radiusSm: 'var(--dsw-radius-sm, 6px)',
      elevation: 'var(--dsw-elevation-prominent, 0 3px 8px 0 rgba(0,0,0,0.04), 0 0 20px 0 rgba(0,0,0,0.05))',
      shadow: 'var(--dsw-elevation-prominent, 0 3px 8px 0 rgba(0,0,0,0.04), 0 0 20px 0 rgba(0,0,0,0.05))',
      menuFill: 'var(--dsw-menu-surface-fill, rgba(248,249,250,0.58))',
      menuBlur: 'var(--dsw-menu-backdrop-filter, blur(40px) saturate(150%))',
      duration: 'var(--ds-transition-duration, 160ms)',
      ease: 'var(--ds-ease-in-out, ease-in-out)',
    };

    // ------------------------------------------------------------- i18n
    /** Locale namespace owned by this plugin. Dictionaries are registered
     *  with the `locale` service (`@deepseek-ai/dsh-client-locale`, always
     *  composed by the standard web profile), which enforces bilingual
     *  balance: both shipped locales (zh, en) must be registered together. */
    var NS = 'multi-folder';
    /** Simplified Chinese dictionary — the key-set source of truth. */
    var zhDict = {
      'label': '多工作目录',
      'label.open': '多工作目录 ▾',
      'label.withCount': '多工作目录 · {count}',
      'label.heroLauncher': '多工作目录（新会话）',
      'label.heroDock': '多工作目录（输入框上方）',
      'title.header': '多工作目录（副工作目录）',
      'title.remove': '移除此副工作目录',
      'title.close': '关闭',
      'title.heroLauncher.hasWorkspace': '配置此项目的副工作目录（多工作目录）',
      'title.heroLauncher.noWorkspace': '请先选择工作区，再配置多工作目录',
      'title.heroChip': '配置此项目的副工作目录（多工作目录）',
      'panel.title': '多工作目录（副工作目录）',
      'panel.project': '项目：{path}',
      'panel.noWorkspaceHint': '尚未选择工作区。请先在上方选择项目，再配置多工作目录。',
      'panel.empty': '尚未配置副工作目录。',
      'panel.pickWorkspaceHint': '选择工作区后可在此添加副工作目录。',
      'panel.add': '+ 添加目录',
      'panel.adding': '处理中…',
      'panel.remove': '移除',
      'panel.refresh': '刷新',
      'panel.footnote': 'Agent 的主工作目录不变；在 Workspace Write 模式下，Agent 对上述目录拥有与主工作目录同等的读写与命令执行权限。配置变更会在下一条消息或工具调用结束时通知 Agent。',
      'ref.group': '多工作区目录',
      'menu.desc': '添加或移除本项目的副工作目录（Agent 同等读写）',
      'browser.title': '选择工作目录',
      'browser.home': '主目录',
      'browser.pc': '这台电脑',
      'browser.up': '上一级',
      'browser.newFolder': '新建文件夹',
      'browser.folderPlaceholder': '新文件夹名',
      'browser.choose': '选择此目录',
      'browser.cancel': '取消',
      'browser.empty': '此层级没有子目录',
      'browser.truncated': '目录过多，仅显示前 1000 项',
      'browser.creating': '创建中…',
      'browser.noName': '请输入文件夹名称',
      'popup.add': '添加工作目录',
      'popup.addHint': '选择目录后加入，可连续添加多个',
      'popup.empty': '尚未配置副工作目录，点上方添加',
      'popup.noWorkspace': '未识别到工作区，无法配置副工作目录',
      'popup.removed': '已移除',
      'confirm.removeTitle': '移除此副工作目录？',
      'confirm.removeDesc': 'Agent 将失去对该目录的读写与命令执行权限',
      'confirm.ack': '我确认要移除',
      'confirm.cancel': '取消',
      'confirm.ok': '移除',
    };
    /** English dictionary — checked complete against the zh key set. */
    var enDict = {
      'label': 'Multi-folder',
      'label.open': 'Multi-folder ▾',
      'label.withCount': 'Multi-folder · {count}',
      'label.heroLauncher': 'Multi-folder (new session)',
      'label.heroDock': 'Multi-folder (above the composer)',
      'title.header': 'Multi-folder (secondary working directories)',
      'title.remove': 'Remove this secondary working directory',
      'title.close': 'Close',
      'title.heroLauncher.hasWorkspace': 'Configure secondary working directories for this project (Multi-folder)',
      'title.heroLauncher.noWorkspace': 'Pick a workspace first, then configure Multi-folder',
      'title.heroChip': 'Configure secondary working directories for this project (Multi-folder)',
      'panel.title': 'Multi-folder (secondary working directories)',
      'panel.project': 'Workspace: {path}',
      'panel.noWorkspaceHint': 'No workspace selected yet. Pick a project above first, then configure secondary directories.',
      'panel.empty': 'No secondary working directories configured yet.',
      'panel.pickWorkspaceHint': 'Pick a workspace first — secondary directories can be added here afterwards.',
      'panel.add': '+ Add directory',
      'panel.adding': 'Working…',
      'panel.remove': 'Remove',
      'panel.refresh': 'Refresh',
      'panel.footnote': "The agent's primary working directory stays unchanged; under Workspace Write mode the agent has the same read/write and command-execution rights on the listed directories as on the primary workspace. Configuration changes are announced at the next message or tool-call boundary.",
      'ref.group': 'Multi-folder dirs',
      'menu.desc': "Add or remove this project's secondary working directories",
      'browser.title': 'Choose a working directory',
      'browser.home': 'Home',
      'browser.pc': 'This PC',
      'browser.up': 'Up',
      'browser.newFolder': 'New folder',
      'browser.folderPlaceholder': 'Folder name',
      'browser.choose': 'Choose this directory',
      'browser.cancel': 'Cancel',
      'browser.empty': 'No subdirectories here',
      'browser.truncated': 'Too many directories — showing the first 1000',
      'browser.creating': 'Creating…',
      'browser.noName': 'Enter a folder name',
      'popup.add': 'Add working directory',
      'popup.addHint': 'Pick a directory; add several in a row',
      'popup.empty': 'No secondary directories yet — add one above',
      'popup.noWorkspace': 'No workspace detected; cannot configure secondary directories',
      'popup.removed': 'Removed',
      'confirm.removeTitle': 'Remove this secondary working directory?',
      'confirm.removeDesc': 'The agent loses read/write and command-execution rights on it',
      'confirm.ack': 'Yes, remove it',
      'confirm.cancel': 'Cancel',
      'confirm.ok': 'Remove',
    };

    // ------------------------------------------------------------- plugin
    var name = 'dsh-multi-folder';
    // Only services every web profile composes belong here: `inject` is a HARD
    // activation gate, and listing an optional service leaves the whole entry
    // "pending (waiting for service: X)" on shells that do not compose it.
    // Optional ones (`uiWorkspace`, `inputTriggers`, `commandUi`) are resolved
    // lazily / through ctx.inject below, so a missing feature degrades instead
    // of switching the plugin off.
    var inject = ['remote', 'remote.commands', 'slots', 'workspaces', 'connection', 'sessions', 'locale'];

    function apply(ctx) {
      var slots = ctx.slots;
      var remote = ctx.remote;
      var workspaces = ctx.workspaces;
      var connection = ctx.connection;
      var sessions = ctx.sessions;
      var locale = ctx.locale;

      /** Register this plugin's dictionaries for every shipped locale
       *  (bilingual balance is enforced by the locale service). The
       *  registration is an effect on this plugin's fiber, so unloading the
       *  plugin withdraws the dictionaries. */
      ctx.effect(function () {
        return locale.register(NS, { zh: zhDict, en: enDict });
      }, 'dsh-multi-folder: client dictionaries');

      /** Bound translator for slot labels: label thunks re-evaluate per read
       *  (`resolveSlotLabel`), so registration-time text follows the active
       *  locale without re-registering. Components themselves render through
       *  the `t` seat the renderer synthesizes from the declared
       *  `locale:` namespace (which also re-renders them on locale switch). */
      var t = locale.bind(NS);

      // -------------------------------------------------- sessionless RPC
      /** Call one `multiFolder/*` endpoint over the shared /api channel.
       *  The Host gateway answers with the same `{ ok, value }` envelope as
       *  the command remote; business errors surface as thrown Errors. */
      function remoteCall(endpoint, args) {
        if (!connection || !connection.rpc || typeof connection.rpc.call !== 'function') {
          return Promise.reject(new Error('multi-folder: the shared RPC channel (connection service) is unavailable'));
        }
        return connection.rpc.call('/api', endpoint, { args: args }).then(function (envelope) {
          if (!envelope || envelope.ok !== true) {
            var message = envelope && envelope.error !== undefined
              ? String(envelope.error.message !== undefined ? envelope.error.message : envelope.error)
              : 'remote call failed';
            throw new Error('multi-folder: ' + String(message).replace(/^multi-folder:\s*/, ''));
          }
          return envelope.value;
        });
      }

      /** Write one workspace's list into the cache and return it normalized. */
      function storeWorkspace(workspacePath, value) {
        var normalized = value && Array.isArray(value.dirs)
          ? value
          : { workspace: workspacePath, dirs: [] };
        workspaceCache[workspacePathKey(workspacePath)] = normalized;
        return normalized;
      }

      /** Whether the open panel is the one showing `workspacePath`. */
      function panelTargets(workspacePath) {
        var current = getSnapshot();
        return !current.sessionId
          && current.mode === 'workspace'
          && !!current.workspace
          && workspacePathKey(current.workspace) === workspacePathKey(workspacePath);
      }

      /** Patch after a workspace-mode read/write: always publish the new cache
       *  revision (chips show the configured count), and refresh the panel
       *  body only when it is the panel for this workspace. */
      function publishWorkspace(workspacePath, value) {
        var normalized = storeWorkspace(workspacePath, value);
        var next = { busy: false, cacheRev: getSnapshot().cacheRev + 1 };
        if (panelTargets(workspacePath)) {
          next.workspace = normalized.workspace;
          next.dirs = normalized.dirs || [];
        }
        patch(next);
      }

      function refreshWorkspace(workspacePath) {
        if (!workspacePath) return;
        patch({ busy: true, error: null });
        remoteCall('multiFolder/list', { workspace: workspacePath }).then(function (value) {
          publishWorkspace(workspacePath, value);
        }).catch(function (e) {
          patch({ busy: false, error: String(e && e.message ? e.message : e) });
        });
      }

      function mutateWorkspace(workspacePath, endpoint, args) {
        if (!workspacePath) return Promise.resolve({ ok: false, skipped: true });
        patch({ busy: true, error: null });
        var payload = Object.assign({ workspace: workspacePath }, args);
        return remoteCall(endpoint, payload).then(function (value) {
          publishWorkspace(workspacePath, value);
          // Resolved result for callers that need to know (the owned browser);
          // existing callers ignore the return value.
          return { ok: true };
        }).catch(function (e) {
          var message = String(e && e.message ? e.message : e);
          patch({ busy: false, error: message });
          return { ok: false, error: message };
        });
      }

      /** Configured directory count for a workspace, or null while unread. */
      function dirCountOf(workspacePath) {
        if (!workspacePath) return null;
        var cached = workspaceCache[workspacePathKey(workspacePath)];
        return cached && Array.isArray(cached.dirs) ? cached.dirs.length : null;
      }

      /** Open the panel in WORKSPACE mode (session-creation page): a null
       *  workspace shows the "pick a workspace first" hint instead.
       *  `anchor` names the surface that owns the panel — an inline chip
       *  renders it as its own popover, everything else uses the overlay. */
      function openForWorkspace(workspacePath, anchor) {
        var seat = anchor || 'overlay';
        if (!workspacePath) {
          patch({ open: true, mode: 'workspace', sessionId: null, workspace: null, dirs: [], error: null, anchor: seat });
          return;
        }
        var cached = workspaceCache[workspacePathKey(workspacePath)];
        patch({
          open: true,
          mode: 'workspace',
          sessionId: null,
          workspace: workspacePath,
          dirs: cached ? cached.dirs : [],
          error: null,
          anchor: seat,
        });
        if (!cached) refreshWorkspace(workspacePath);
      }

      function runCommand(sessionId, line) {
        // DSH 0.1.1: commands/execute takes three business arguments —
        // (sessionId, line, images) — plus an optional AbortSignal. The
        // plugin never attaches composer images, so the third is `[]`.
        return remote.commands.execute(sessionId, line, []).then(function (envelope) {
          if (!envelope || envelope.ok !== true) {
            throw new Error('multi-folder: ' + (envelope && envelope.error !== undefined ? String(envelope.error) : 'remote call failed'));
          }
          var execution = envelope.value;
          if (execution === undefined || execution === null) {
            throw new Error('multi-folder: command did not match — is the host plugin loaded?');
          }
          var result = execution.result;
          if (!result) throw new Error('multi-folder: command returned no result');
          if (result.kind === 'error') throw new Error(result.text || 'multi-folder: command failed');
          return result.text || '';
        });
      }

      function refresh(sessionId) {
        if (!sessionId) return;
        patch({ busy: true, error: null });
        runCommand(sessionId, '/multi-folder list').then(function (text) {
          var parsed = parseJsonLine(text);
          if (parsed) {
            sessionCache[sessionId] = { workspace: parsed.workspace, dirs: parsed.dirs };
          }
          patch({
            busy: false,
            workspace: parsed ? parsed.workspace : null,
            dirs: parsed ? parsed.dirs : [],
          });
        }).catch(function (e) {
          patch({ busy: false, error: String(e && e.message ? e.message : e) });
        });
      }

      function mutate(sessionId, line) {
        patch({ busy: true, error: null });
        return runCommand(sessionId, line).then(function (text) {
          var parsed = parseJsonLine(text);
          if (parsed) {
            // Keep BOTH caches honest: the session view and the per-workspace
            // count the chips read from.
            sessionCache[sessionId] = { workspace: parsed.workspace, dirs: parsed.dirs };
            if (parsed.workspace) storeWorkspace(parsed.workspace, parsed);
            patch({
              busy: false,
              cacheRev: getSnapshot().cacheRev + 1,
              workspace: parsed.workspace,
              dirs: parsed.dirs,
            });
            return { ok: true };
          }
          refresh(sessionId);
          return { ok: true, unparsed: true };
        }).catch(function (e) {
          var message = String(e && e.message ? e.message : e);
          patch({ busy: false, error: message });
          refresh(sessionId);
          return { ok: false, error: message };
        });
      }

      /**
       * Resolve the native directory picker lazily: `uiWorkspace` (DSH 0.1.2+)
       * with the older `workspaces` service as fallback, or null. Optional
       * services are read through `ctx.get` on demand — never through
       * `exports.inject`, whose entries are hard activation gates.
       */
      function directoryPicker() {
        var uiw = typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : undefined;
        if (uiw && typeof uiw.pickDirectory === 'function') return uiw;
        if (workspaces && typeof workspaces.pickDirectory === 'function') return workspaces;
        return null;
      }

      // Owned directory browser --------------------------------------------
      // `uiWorkspace.pickDirectory()` is native-only: a LAN bind, a remote
      // browser client, or a desktop shell answers
      // `directory-picker/unavailable`, and the shipped in-app browser is
      // closed to plugins. So "Add directory" falls back to a browser this
      // plugin draws itself and serves over `multiFolder/browse` +
      // `multiFolder/makeDir` — one interaction that behaves identically in
      // every deployment. The native picker still wins when it exists.

      /**
       * Add one directory through the mode that owns `target`: a live session
       * runs the host command (which also arms the agent notice), the blank
       * hero session rides the sessionless RPC keyed by workspace.
       */
      function addResolved(target, path) {
        if (target === null || target === undefined) return Promise.resolve();
        // Reuse the panel's own mutators: they own busy/error bookkeeping and
        // never reject, so a failed add surfaces in the store instead of
        // escaping as an unhandled rejection.
        if (target.sessionMode) {
          return mutate(target.sessionId, '/multi-folder add "' + String(path).replace(/"/g, '\\"') + '"');
        }
        return mutateWorkspace(target.workspace, 'multiFolder/add', { path: String(path) });
      }

      /** Commit a chosen directory from the browser through its own target. */
      function commitDirectory(path) {
        var target = getSnapshot().browserTarget;
        if (path === null || path === undefined || path === '') {
          dismissBrowser();
          return undefined;
        }
        patch({ browserBusy: true, browserError: null });
        // The mutators never reject and report an explicit outcome, so a failed
        // add can keep the browser open and show the error inside it instead of
        // vanishing on a user who just clicked "Choose this directory".
        return Promise.resolve(addResolved(target, path)).then(function (result) {
          if (result && result.ok === false) {
            patch({ browserBusy: false, browserError: String(result.error) });
            return;
          }
          dismissBrowser();
        });
      }

      function browseTo(path) {
        patch({ browserBusy: true, browserError: null });
        return remoteCall('multiFolder/browse', { path: path === undefined ? '' : path }).then(function (level) {
          patch({ browserBusy: false, browser: level });
        }).catch(function (e) {
          patch({ browserBusy: false, browserError: String(e && e.message ? e.message : e) });
        });
      }

      /**
       * Open the owned browser. `target` says where a commit should go — the
       * panel passes null and the store's own session/workspace is used, the
       * "+" popup passes the context it was handed because that flow never
       * touches the panel state.
       */
      function openBrowser(target, startPath) {
        var resolved = target !== undefined && target !== null
          ? target
          : (function () {
              var snapshot = getSnapshot();
              if (snapshot.sessionId) return { sessionId: snapshot.sessionId, sessionMode: true, workspace: snapshot.workspace };
              if (snapshot.workspace) return { workspace: snapshot.workspace, sessionMode: false, sessionId: null };
              return null;
            })();
        patch({ browserOpen: true, browser: null, browserBusy: false, browserCreating: false, browserError: null, browserName: '', browserTarget: resolved });
        return browseTo(startPath || '');
      }

      function createFolder() {
        var current = getSnapshot();
        var name = String(current.browserName || '').trim();
        if (current.browser === null || name === '') {
          patch({ browserError: name === '' ? t('browser.noName') : current.browserError });
          return undefined;
        }
        patch({ browserBusy: true, browserCreating: true, browserError: null });
        return remoteCall('multiFolder/makeDir', { parent: current.browser.path, name: name }).then(function (made) {
          patch({ browserBusy: false, browserCreating: false, browserName: '' });
          return browseTo(made.path);
        }).catch(function (e) {
          patch({ browserBusy: false, browserCreating: false, browserError: String(e && e.message ? e.message : e) });
        });
      }

      /**
       * The whole "Add directory" interaction for one target: the native picker
       * when the shell composes one that answers, the owned browser everywhere
       * else (a remote/LAN client gets `directory-picker/unavailable`). Both
       * paths commit through addResolved, so behaviour is identical.
       */
      function pickAndAdd(target) {
        var picker = directoryPicker();
        if (picker === null) {
          openBrowser(target);
          return undefined;
        }
        return picker.pickDirectory().then(function (path) {
          if (path === null || path === undefined) return undefined; // cancelled
          return addResolved(target, path);
        }).catch(function () {
          // The host refused the picker (browse composition, remote client, or
          // no picker at all): degrade to the owned browser, not an error.
          openBrowser(target);
          return undefined;
        });
      }

      function addDirectory() {
        var snapshot = getSnapshot();
        var target = snapshot.sessionId
          ? { sessionId: snapshot.sessionId, sessionMode: true, workspace: snapshot.workspace }
          : (snapshot.workspace ? { workspace: snapshot.workspace, sessionMode: false, sessionId: null } : null);
        if (target === null) {
          patch({ error: 'multi-folder: no workspace to configure' });
          return;
        }
        pickAndAdd(target);
      }

      /** Clearing fragment for the owned browser: opening any panel means the
       *  browser's own target may be stale, so no surface is left dangling. */
      var BROWSER_CLOSED = { browserOpen: false, browser: null, browserName: '', browserError: null, browserTarget: null, browserBusy: false, browserCreating: false };

      /** Open the panel for a session, reusing cached data when present so
       *  pure reads do not produce conversation rows. `anchor` names the
       *  surface that owns the popover ('header' for the session header). */
      function openFor(sessionId, anchor) {
        if (!sessionId) return;
        var cached = sessionCache[sessionId];
        patch(Object.assign({
          open: true,
          mode: 'session',
          sessionId: sessionId,
          dirs: cached ? cached.dirs : [],
          workspace: cached ? cached.workspace : null,
          error: null,
          anchor: anchor || 'overlay',
        }, BROWSER_CLOSED));
        if (cached === undefined) refresh(sessionId);
      }

      // Header button -----------------------------------------------------
      /** Session-header entry: an official-styled compact pill whose popover
       *  anchors directly BELOW the button (menu look: tight rows, hover
       *  highlight, small footer), replacing the old detached overlay panel. */
      function HeaderButton(props) {
        var store = useStore();
        var sessionId = props.sessionId;
        var t = props.t;
        var open = store.open && store.sessionId === sessionId && store.anchor === 'header';
        // Session switch: keep the popover in sync with the session this
        // header belongs to. On a changed sessionId (or first mount) with
        // the popover open, switch its content to this session, reusing
        // cached data (no conversation row) or refreshing from the Host.
        React.useEffect(
          function () {
            var current = getSnapshot();
            if (current.open && current.anchor === 'header' && current.sessionId !== sessionId) {
              openFor(sessionId, 'header');
            }
          },
          [sessionId],
        );
        return React.createElement(
          'div',
          { style: { position: 'relative', display: 'inline-flex', minWidth: 0 } },
          React.createElement(
            'button',
            {
              type: 'button',
              title: t('title.header'),
              onClick: function () {
                var current = getSnapshot();
                var isOpen = current.open && current.sessionId === sessionId && current.anchor === 'header';
                if (isOpen) {
                  patch({ open: false });
                } else {
                  openFor(sessionId, 'header');
                }
              },
              style: {
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                height: 26,
                padding: '0 10px',
                borderRadius: 999,
                border: '1px solid ' + (open ? TOKEN.accent : TOKEN.borderSoft),
                background: open ? TOKEN.hover : TOKEN.fill,
                color: open ? TOKEN.ink : TOKEN.inkSoft,
                fontSize: 12,
                lineHeight: 1,
                whiteSpace: 'nowrap',
                cursor: 'pointer',
                maxWidth: 220,
                overflow: 'hidden',
              },
            },
            React.createElement('span', { style: { fontSize: 11, lineHeight: 1 } }, '⧉'),
            React.createElement(
              'span',
              { style: { overflow: 'hidden', textOverflow: 'ellipsis' } },
              t('label'),
            ),
            React.createElement('span', { style: { color: TOKEN.inkFaint, fontSize: 10 } }, '▾'),
          ),
          open ? React.createElement(Backdrop, { key: 'bd', dim: true }) : null,
          open ? React.createElement(HeaderPopover, { key: 'pop', t: t }) : null,
        );
      }

      /** The header popover: anchored menu-styled body (fixed, right-aligned
       *  under the header row so it survives the header's own overflow). */
      function HeaderPopover(props) {
        var store = useStore();
        var t = props.t;
        return React.createElement(
          'div',
          {
            style: {
              position: 'fixed',
              top: 52,
              right: 16,
              width: 340,
              maxWidth: 'calc(100vw - 32px)',
              zIndex: 120,
              background: TOKEN.surface,
              color: TOKEN.ink,
              border: '1px solid ' + TOKEN.borderSoft,
              borderRadius: 12,
              boxShadow: '0 12px 32px var(--dsw-alias-bg-mask-2, rgba(0,0,0,0.14)), 0 2px 8px var(--dsw-alias-bg-mask-1, rgba(0,0,0,0.08))',
              padding: 6,
              fontSize: 13,
              textAlign: 'left',
            },
          },
          panelBody(store, t, true),
        );
      }

      // Panel body ---------------------------------------------------------
      /** The panel's children, shared by the menu popovers. `compact` renders
       *  the menu-styled variant (tight rows, hover highlight, hairline
       *  separators, one-line footer). Returned as an ARRAY so each wrapper
       *  can spread it as its own direct children. */
      function panelBody(store, t, compact) {
        var sessionMode = store.mode === 'session';
        var usable = sessionMode || !!store.workspace;
        var rowHover = { background: 'transparent' };
        var rows = (store.dirs || []).map(function (dir, index) {
          return React.createElement(
            'div',
            {
              key: index,
              title: dir,
              style: {
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: compact ? '7px 8px' : '6px 8px',
                borderRadius: compact ? 8 : 6,
                background: compact ? rowHover.background : TOKEN.subtle,
                marginBottom: compact ? 0 : 6,
              },
            },
            React.createElement(
              'span',
              { style: { color: TOKEN.inkMuted, fontSize: compact ? 13 : 12, flex: 'none' } },
              '⧉',
            ),
            React.createElement(
              'div',
              {
                style: {
                  flex: 1,
                  minWidth: 0,
                  fontSize: 13,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                },
              },
              dir,
            ),
            React.createElement(
              'button',
              {
                type: 'button',
                title: t('title.remove'),
                disabled: !usable,
                onClick: function () {
                  if (sessionMode) {
                    mutate(store.sessionId, '/multi-folder remove "' + dir.replace(/"/g, '\\"') + '"');
                  } else if (store.workspace) {
                    mutateWorkspace(store.workspace, 'multiFolder/remove', { path: dir });
                  }
                },
                style: {
                  flex: 'none',
                  padding: '2px 8px',
                  borderRadius: 6,
                  border: '1px solid transparent',
                  background: 'transparent',
                  color: TOKEN.danger,
                  fontSize: 12,
                  cursor: usable ? 'pointer' : 'default',
                  opacity: usable ? 1 : 0.5,
                },
              },
              t('panel.remove'),
            ),
          );
        });
        var head = React.createElement(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: compact ? '4px 8px 6px' : undefined,
              marginBottom: compact ? 2 : 10,
            },
          },
          React.createElement(
            'div',
            { style: { fontWeight: 600, fontSize: compact ? 12 : 14, color: TOKEN.inkMuted } },
            t('panel.title'),
          ),
          React.createElement(
            'button',
            {
              type: 'button',
              title: t('title.close'),
              onClick: function () { patch({ open: false }); },
              style: {
                padding: '2px 8px',
                borderRadius: 6,
                border: '1px solid transparent',
                background: 'transparent',
                color: TOKEN.inkMuted,
                fontSize: 12,
                cursor: 'pointer',
              },
            },
            '✕',
          ),
        );
        var list = usable
          ? (rows.length > 0
              ? (compact
                  ? React.createElement('div', { style: { display: 'flex', flexDirection: 'column' } }, rows)
                  : rows)
              : React.createElement(
                  'div',
                  { style: { padding: compact ? '10px 8px' : undefined, marginBottom: compact ? 0 : 8, color: TOKEN.inkMuted, fontSize: 13 } },
                  t('panel.empty'),
                ))
          : React.createElement(
              'div',
              { style: { padding: compact ? '10px 8px' : undefined, marginBottom: compact ? 0 : 8, color: TOKEN.inkMuted, fontSize: 13 } },
              t('panel.pickWorkspaceHint'),
            );
        var actions = React.createElement(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8, padding: compact ? '6px 8px 4px' : undefined, marginTop: compact ? 4 : 4 } },
          React.createElement(
            'button',
            {
              type: 'button',
              disabled: !!store.busy || !usable,
              onClick: function () { addDirectory(); },
              style: {
                flex: compact ? 'none' : 1,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: compact ? '6px 10px' : '6px 10px',
                borderRadius: 8,
                border: '1px solid ' + TOKEN.borderSoft,
                background: TOKEN.fill,
                color: TOKEN.ink,
                fontSize: 12,
                cursor: store.busy || !usable ? 'default' : 'pointer',
                opacity: store.busy || !usable ? 0.6 : 1,
              },
            },
            React.createElement('span', { style: { fontSize: 13, lineHeight: 1 } }, '+'),
            store.busy ? t('panel.adding') : t('panel.add').replace(/^\+\s*/, ''),
          ),
          compact ? null : React.createElement(
            'button',
            {
              type: 'button',
              disabled: !!store.busy || !usable,
              onClick: function () {
                if (sessionMode) {
                  refresh(store.sessionId);
                } else if (store.workspace) {
                  refreshWorkspace(store.workspace);
                }
              },
              style: {
                padding: '6px 10px',
                borderRadius: 8,
                border: '1px solid ' + TOKEN.borderSoft,
                background: 'transparent',
                color: TOKEN.ink,
                fontSize: 12,
                cursor: store.busy || !usable ? 'default' : 'pointer',
                opacity: store.busy || !usable ? 0.6 : 1,
              },
            },
            t('panel.refresh'),
          ),
        );
        var projectLine = store.workspace
          ? React.createElement(
              'div',
              {
                title: store.workspace,
                style: {
                  padding: compact ? '2px 8px 4px' : undefined,
                  marginBottom: compact ? 0 : 8,
                  color: TOKEN.inkFaint,
                  fontSize: 11,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                },
              },
              t('panel.project', { path: store.workspace }),
            )
          : (!sessionMode && !compact
              ? React.createElement(
                  'div',
                  { style: { marginBottom: 8, color: TOKEN.inkMuted } },
                  t('panel.noWorkspaceHint'),
                )
              : null);
        var errorLine = store.error
          ? React.createElement(
              'div',
              { style: { padding: compact ? '4px 8px' : undefined, marginBottom: compact ? 0 : 8, color: TOKEN.danger, fontSize: 12, whiteSpace: 'pre-wrap' } },
              String(store.error),
            )
          : null;
        var footnote = React.createElement(
          'div',
          {
            style: {
              marginTop: compact ? 6 : 10,
              padding: compact ? '6px 8px 4px' : undefined,
              borderTop: compact ? '1px solid ' + TOKEN.borderSoft : undefined,
              fontSize: 10.5,
              lineHeight: 1.5,
              color: TOKEN.inkFaint,
            },
          },
          t('panel.footnote'),
        );
        if (compact) {
          return [head, projectLine, list, errorLine, actions, footnote];
        }
        return [
          head,
          projectLine,
          !sessionMode && !store.workspace
            ? React.createElement('div', { style: { marginBottom: 8, color: TOKEN.inkMuted } }, t('panel.noWorkspaceHint'))
            : null,
          list,
          errorLine,
          actions,
          footnote,
        ];
      }

      /** Spread `children` as the direct children of one element (keeps the
       *  panel's DOM shape identical across both placements). */
      function element(type, props, children) {
        return React.createElement.apply(null, [type, props].concat(children));
      }

      // Overlay panel ------------------------------------------------------
      function Panel(props) {
        var store = useStore();
        var t = props.t;
        if (!store.open || !store.mode) return null;
        // An inline chip owns its own popover; the overlay stands down.
        if (store.anchor !== 'overlay') return null;
        return element(
          'div',
          {
            style: {
              position: 'fixed',
              top: 64,
              right: 20,
              width: 380,
              maxWidth: 'calc(100vw - 40px)',
              zIndex: 400,
              background: TOKEN.surface,
              color: TOKEN.ink,
              border: '1px solid ' + TOKEN.border,
              borderRadius: 12,
              boxShadow: TOKEN.shadow,
              padding: 14,
              fontSize: 13,
            },
          },
          panelBody(store, t),
        );
      }

      // Owned directory browser --------------------------------------------
      var BROWSER_CSS_ID = 'dsh-multi-folder/browser.css';
      var BROWSER_CSS = [
        // Container recipe is the SHIPPED "+" menu's: --dsw-menu-surface-fill is
        // translucent (light #f8f9fa94) and only legible because the shell pairs it
        // with --dsw-menu-backdrop-filter (blur(40px) saturate(150%)). A
        // translucent fill WITHOUT that blur is what let page text read through.
        // Buttons follow Button.sm (28px, radius-sm, borderless ghost with
        // hover/active) and Button.primary for the single action; the text field
        // follows Input.wrap (32px, 0.5px stroke, layer-1 fill, focus colour).
        '.mf-bw-mask{position:absolute;inset:0;background:' + TOKEN.mask + ';backdrop-filter:' + TOKEN.blur + ';-webkit-backdrop-filter:' + TOKEN.blur + '}',
        // The container copies the shipped "+" popover (MenuSurface): its fill
        // is translucent and only legible because it is PAIRED with the menu
        // backdrop blur. A translucent fill without that blur is what let the
        // page text read straight through this dialog.
        '.mf-bw-dialog{position:relative;z-index:1;display:flex;flex-direction:column;width:460px;max-width:100%;max-height:100%;overflow:hidden;border:0;border-radius:' + TOKEN.radiusLg + ';background:' + TOKEN.menuFill + ';backdrop-filter:' + TOKEN.menuBlur + ';-webkit-backdrop-filter:' + TOKEN.menuBlur + ';box-shadow:' + TOKEN.elevation + ';padding:0 0 20px;font-size:13px}',
        '.mf-bw-title{padding:20px 20px 12px;font-size:16px;line-height:24px;font-weight:500;color:' + TOKEN.ink + '}',
        '.mf-bw-root{display:flex;flex-direction:column;gap:12px;padding:0 20px}',
        '.mf-bw-row{display:flex;align-items:center;gap:8px;width:100%;padding:6px 8px;border:0;background:transparent;color:inherit;font:inherit;font-size:13px;line-height:20px;text-align:left;border-radius:' + TOKEN.radiusSm + ';cursor:pointer;transition:background ' + TOKEN.duration + ' ' + TOKEN.ease + '}',
        '.mf-bw-row:hover:not(:disabled){background:' + TOKEN.hover + '}',
        '.mf-bw-row:active:not(:disabled){background:' + TOKEN.active + '}',
        '.mf-bw-row:disabled{opacity:.4;cursor:default}',
        '.mf-bw-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.mf-bw-hidden{opacity:.55}',
        '.mf-bw-glyph{flex:none;display:inline-flex;width:16px;height:16px;align-items:center;justify-content:center}',
        '.mf-bw-glyph svg{width:16px;height:16px;display:block}',
        '.mf-bw-folder{color:' + TOKEN.folder + '}',
        '.mf-bw-drive{color:' + TOKEN.inkMuted + '}',
        '.mf-bw-nav{display:flex;align-items:center;gap:4px;flex-wrap:wrap;font-size:12px;line-height:18px}',
        '.mf-bw-crumb,.mf-bw-up{border:0;background:transparent;color:' + TOKEN.inkSoft + ';font:inherit;font-size:12px;line-height:18px;padding:2px 6px;border-radius:' + TOKEN.radiusSm + ';cursor:pointer;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;transition:background ' + TOKEN.duration + ' ' + TOKEN.ease + '}',
        '.mf-bw-crumb:hover:not(:disabled),.mf-bw-up:hover:not(:disabled){background:' + TOKEN.hover + '}',
        '.mf-bw-up{flex:none;margin-inline-start:auto}',
        '.mf-bw-crumb[aria-current="true"]{color:' + TOKEN.ink + ';font-weight:500;cursor:default}',
        '.mf-bw-sep{color:' + TOKEN.inkDimmed + ';flex:none}',
        '.mf-bw-list{display:flex;flex-direction:column;max-height:min(46vh,340px);overflow-y:auto;margin:0 -4px;padding:0 4px}',
        '.mf-bw-empty{padding:12px 8px;font-size:13px;color:' + TOKEN.inkMuted + '}',
        '.mf-bw-err{padding:6px 8px;font-size:12px;line-height:18px;color:' + TOKEN.danger + ';white-space:pre-wrap;word-break:break-all}',
        '.mf-bw-note{padding:0 8px;font-size:11px;line-height:16px;color:' + TOKEN.inkFaint + '}',
        '.mf-bw-fields{display:flex;align-items:center;gap:8px}',
        '.mf-bw-field{flex:1;min-width:0;display:inline-flex;align-items:center;height:32px;padding:0 8px;border:0.5px solid ' + TOKEN.borderInput + ';border-radius:' + TOKEN.radiusMd + ';background:' + TOKEN.inputBg + ';transition:border-color ' + TOKEN.duration + ' ' + TOKEN.ease + '}',
        '.mf-bw-field:focus-within{border-color:' + TOKEN.focus + '}',
        '.mf-bw-input{flex:1;min-width:0;border:0;outline:0;background:transparent;color:' + TOKEN.ink + ';font:inherit;font-size:14px;line-height:22px}',
        '.mf-bw-input::placeholder{color:' + TOKEN.inkDimmed + '}',
        '.mf-bw-input:disabled{opacity:.5}',
        '.mf-bw-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px}',
        '.mf-bw-btn{display:inline-flex;align-items:center;justify-content:center;gap:4px;height:28px;padding:0 10px;border:0;border-radius:' + TOKEN.radiusSm + ';background:transparent;color:' + TOKEN.ink + ';font:inherit;font-size:12px;line-height:18px;cursor:pointer;white-space:nowrap;transition:background ' + TOKEN.duration + ' ' + TOKEN.ease + '}',
        '.mf-bw-btn:hover:not(:disabled){background:' + TOKEN.hover + '}',
        '.mf-bw-btn:active:not(:disabled){background:' + TOKEN.active + '}',
        '.mf-bw-btn:disabled{opacity:.4;cursor:not-allowed}',
        '.mf-bw-primary{background:' + TOKEN.primaryFill + ';color:' + TOKEN.primaryInk + '}',
        '.mf-bw-primary:hover:not(:disabled){background:' + TOKEN.primaryHover + '}',
        '.mf-bw-primary:active:not(:disabled){background:' + TOKEN.primaryHover + '}',
      ].join('\n');

      function ensureBrowserStyles() {
        if (typeof document === 'undefined' || !document.head || typeof document.createElement !== 'function') return;
        try {
          if (document.querySelector('style[data-plugin-css="' + BROWSER_CSS_ID + '"]')) return;
          var tag = document.createElement('style');
          tag.setAttribute('data-plugin', name);
          tag.setAttribute('data-plugin-css', BROWSER_CSS_ID);
          tag.textContent = BROWSER_CSS;
          document.head.appendChild(tag);
        } catch (_) { /* styling is cosmetic; never throw */ }
      }

      /**
       * Breadcrumb trail for one browsed level: Home plus each segment below
       * it, or a plain split of the absolute path when the level sits outside
       * home (another drive root on Windows, a POSIX path with no home). The
       * last crumb is the current level and renders non-interactive.
       */
      function browserCrumbs(level, homeLabel, pcLabel) {
        var crumbs = [];
        if (!level || typeof level.path !== 'string' || level.path === '') return crumbs;
        // The synthetic volume list is not a directory on any drive: it labels
        // itself and has no ancestry.
        if (level.drives === true || level.path === 'this-pc/') {
          return [{ label: pcLabel, path: 'this-pc/', current: true }];
        }
        var home = typeof level.home === 'string' && level.home !== '' ? level.home.replace(/\/+$/, '') : '';
        var path = level.path.replace(/\/+$/, '') || '/';
        var segments = [];
        if (home !== '' && (path === home || path.indexOf(home + '/') === 0)) {
          segments.push({ label: homeLabel, path: home });
          var acc = home;
          var parts = (path === home ? '' : path.slice(home.length + 1)).split('/').filter(function (s) { return s !== ''; });
          for (var i = 0; i < parts.length; i++) {
            acc = acc + '/' + parts[i];
            segments.push({ label: parts[i], path: acc });
          }
        } else {
          // The drive head is read from the RAW path: a drive root's trailing
          // slash is stripped from `path`, and `C:` alone is drive-relative — a
          // crumb spelled that way renders wrong (the path splits into `/` and
          // `:`) and is rejected as non-absolute when clicked.
          var isWin = /^[A-Za-z]:(\/|$)/.test(level.path);
          var head = isWin ? level.path.slice(0, 2) + '/' : '/';
          var acc2 = head;
          segments.push({ label: isWin ? head.slice(0, 2) : head, path: head });
          var rest = (isWin ? path.slice(2) : path.slice(1)).split('/').filter(function (s) { return s !== ''; });
          for (var j = 0; j < rest.length; j++) {
            acc2 = (acc2 === '/' ? '' : acc2.replace(/\/+$/, '')) + '/' + rest[j];
            segments.push({ label: rest[j], path: acc2 });
          }
        }
        for (var k = 0; k < segments.length; k++) {
          crumbs.push({ label: segments[k].label, path: segments[k].path, current: k === segments.length - 1 });
        }
        return crumbs;
      }

      /** Volume glyph for the synthetic "This PC" level. */
      var DRIVE_SVG =
        '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M3 5h18a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-7.2l.7 2H17v2H7v-2h1.8l.7-2H3a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zm1 2v8h16V7H4zm3 5h2v-2H7v2zm4 0h2v-2h-2v2z"/></svg>';

      /** Close the browser and drop every piece of its state. The field list
       *  lives in BROWSER_CLOSED alone, so no exit path can miss one (an
       *  escaped-Esc that left browserBusy set would grey the whole dialog). */
      function dismissBrowser() {
        patch(Object.assign({}, BROWSER_CLOSED));
      }

      /**
       * The plugin's own directory browser: a level of child directories with
       * breadcrumb navigation, an inline "new folder" affordance, and one
       * primary action that commits the highlighted level. Drawn entirely from
       * official design tokens so it follows the theme and any applied skin.
       */
      function DirectoryBrowser(props) {
        var store = useStore();
        var t = props.t;
        ensureBrowserStyles();
        var level = store.browser;
        var crumbs = browserCrumbs(level, t('browser.home'), t('browser.pc'));
        return element('div', { key: 'root', className: 'mf-bw-root' }, [
          React.createElement('div', { key: 'h', className: 'mf-bw-nav' },
            crumbs.map(function (crumb, index) {
              return React.createElement(React.Fragment, { key: index },
                index > 0 ? React.createElement('span', { className: 'mf-bw-sep' }, '/') : null,
                React.createElement('button', {
                  type: 'button',
                  className: 'mf-bw-crumb',
                  'aria-current': crumb.current ? 'true' : undefined,
                  disabled: !!crumb.current || store.browserBusy,
                  onClick: function () { if (!crumb.current) browseTo(crumb.path); },
                }, crumb.label),
              );
            }),
            level && level.parent
              ? React.createElement('button', {
                  type: 'button',
                  className: 'mf-bw-up',
                  disabled: store.browserBusy,
                  onClick: function () { browseTo(level.parent); },
                }, '↑ ' + t('browser.up'))
              : null,
          ),
          store.browserError
            ? React.createElement('div', { key: 'e', className: 'mf-bw-err' }, String(store.browserError))
            : null,
          level && level.truncated
            ? React.createElement('div', { key: 't', className: 'mf-bw-note' }, t('browser.truncated'))
            : null,
          level && level.entries.length === 0
            ? React.createElement('div', { key: 'm', className: 'mf-bw-empty' }, t('browser.empty'))
            : null,
          level
            ? element('div', { key: 'l', className: 'mf-bw-list' },
                level.entries.map(function (entry, index) {
                  return React.createElement('button', {
                    key: index,
                    type: 'button',
                    className: 'mf-bw-row',
                    title: entry.path,
                    disabled: store.browserBusy,
                    onClick: function () { browseTo(entry.path); },
                  },
                    // Real folder artwork (the shipped menu uses the same one
                    // for its folder rows); a drive glyph for the volume list.
                    React.createElement('span', {
                      className: 'mf-bw-glyph ' + (entry.drive ? 'mf-bw-drive' : 'mf-bw-folder'),
                      'aria-hidden': 'true',
                      dangerouslySetInnerHTML: { __html: entry.drive ? DRIVE_SVG : FOLDER_SVG },
                    }),
                    React.createElement('span', { className: 'mf-bw-name' + (entry.hidden ? ' mf-bw-hidden' : '') }, entry.name),
                  );
                }))
            : null,
          React.createElement('div', { key: 'f', className: 'mf-bw-fields' },
            React.createElement('span', { className: 'mf-bw-field' },
              React.createElement('input', {
                className: 'mf-bw-input',
                type: 'text',
                placeholder: t('browser.folderPlaceholder'),
                value: store.browserName,
                // Creating inside the synthetic volume list is meaningless.
                disabled: store.browserBusy || level === null || level.drives === true,
                onInput: function (event) { patch({ browserName: event.currentTarget.value }); },
                onChange: function (event) { patch({ browserName: event.currentTarget.value }); },
                onKeyDown: function (event) {
                  if (event.key === 'Enter') { event.preventDefault(); createFolder(); }
                },
              }),
            ),
            React.createElement('button', {
              type: 'button',
              className: 'mf-bw-btn',
              disabled: store.browserBusy || level === null || level.drives === true,
              onClick: function () { createFolder(); },
            }, store.browserCreating ? t('browser.creating') : t('browser.newFolder')),
          ),
          // Official dialog footer order: secondary on the left of the single
          // prominent action, both right-aligned; no divider line above it.
          React.createElement('div', { key: 'a', className: 'mf-bw-actions' },
            React.createElement('button', {
              type: 'button',
              className: 'mf-bw-btn',
              onClick: dismissBrowser,
            }, t('browser.cancel')),
            React.createElement('button', {
              type: 'button',
              className: 'mf-bw-btn mf-bw-primary',
              // The volume list is not a directory: nothing to commit.
              disabled: level === null || store.browserBusy || level.drives === true,
              onClick: function () { commitDirectory(level ? level.path : null); },
            }, t('browser.choose')),
          ),
        ]);
      }

      // Anchored popover ---------------------------------------------------
      /** The same panel body as a popover anchored to a chip. `direction`
       *  'up' opens above the chip (the dock row sits above the composer
       *  card), 'down' opens below it (the hero chip row). */
      function AnchoredPanel(props) {
        var store = useStore();
        var t = props.t;
        var up = props.direction !== 'down';
        var placement = up ? { bottom: 'calc(100% + 6px)' } : { top: 'calc(100% + 6px)' };
        return element(
          'div',
          {
            style: Object.assign(
              {
                position: 'absolute',
                left: 0,
                zIndex: 40,
                width: 380,
                maxWidth: 'calc(100vw - 40px)',
                // The composer stack lives in a scroll container with
                // `overflow: hidden auto`; capping the height keeps a tall
                // list inside the viewport instead of clipping it.
                maxHeight: 'min(60vh, 420px)',
                overflowY: 'auto',
                background: TOKEN.surface,
                color: TOKEN.ink,
                border: '1px solid ' + TOKEN.border,
                borderRadius: 12,
                boxShadow: TOKEN.shadow,
                padding: 14,
                fontSize: 13,
                textAlign: 'left',
              },
              placement,
            ),
          },
          panelBody(store, t),
        );
      }

      /** Click-outside catcher for an open popover. */
      function Backdrop() {
        return React.createElement('div', {
          onClick: function () { patch({ open: false }); },
          style: { position: 'fixed', inset: 0, zIndex: 30 },
        });
      }

      /** One chip + its popover, wrapped in the positioning context the
       *  popover anchors to. Shared by the dock row and the hero chip. */
      function chipWithPopover(seat, direction, t, button) {
        var store = getSnapshot();
        var open = store.open && store.anchor === seat;
        return React.createElement(
          'div',
          { style: { position: 'relative', display: 'inline-flex', minWidth: 0 } },
          button,
          open ? React.createElement(Backdrop, { key: 'backdrop' }) : null,
          open ? React.createElement(AnchoredPanel, { key: 'panel', t: t, direction: direction }) : null,
        );
      }

      /** The chip pill, styled from the official chip recipe. */
      function chipButton(options) {
        return React.createElement(
          'button',
          {
            type: 'button',
            title: options.title,
            onClick: options.onClick,
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              height: 24,
              padding: '0 10px',
              borderRadius: 999,
              border: '1px solid ' + (options.open ? TOKEN.accent : TOKEN.border),
              background: options.open ? TOKEN.hover : TOKEN.fill,
              color: options.open ? TOKEN.ink : TOKEN.inkSoft,
              fontSize: 12,
              lineHeight: 1,
              whiteSpace: 'nowrap',
              cursor: 'pointer',
              maxWidth: 260,
              overflow: 'hidden',
              opacity: options.dimmed ? 0.7 : 1,
            },
          },
          React.createElement(
            'span',
            { style: { overflow: 'hidden', textOverflow: 'ellipsis' } },
            options.label,
          ),
          React.createElement('span', { style: { color: TOKEN.inkFaint, fontSize: 10 } }, '▾'),
        );
      }

      // Hero (session-creation page) support --------------------------------
      /** The shell's own hero predicate, read from the dock's owner share: a
       *  blank conversation with an open session. A still-loading blank
       *  session already lists as blank, so it may enter the hero phase
       *  before the composer snapshot settles to `open`.
       *
       *  DSH 0.1.2 exposes no `composerPhase` on SessionSnapshot; the hero
       *  phase there is a settled blank session (mirroring ConversationRoot's
       *  `hero = sessionId === undefined || (shellPhase === 'blank' && ...)`),
       *  so the blank/lifecycle fields are used as the fallback. Newer DSH
       *  shells that do carry `composerPhase` keep their original check. */
      function isHeroPhase(session, blank) {
        if (!session) return false;
        if (session.composerPhase !== undefined) {
          return session.composerPhase === 'blank' && (session.openState === 'open' || blank === true);
        }
        return session.blank === true
          && !session.running
          && !session.promptAttempted
          && (blank === true || session.openState === 'open');
      }

      /** The workspace path a session belongs to, from the workspaces list. */
      function workspacePathIn(snapshot, sessionId) {
        var items = snapshot && snapshot.items ? snapshot.items : [];
        for (var i = 0; i < items.length; i++) {
          var workspace = items[i];
          if (workspace && workspace.path && Array.isArray(workspace.sessionIds) && workspace.sessionIds.indexOf(sessionId) >= 0) {
            return workspace.path;
          }
        }
        return null;
      }

      /** Workspace path of the current session (blank-session hero), or null
       *  while no session/workspace is selected at all. Store-read twin of
       *  `workspacePathIn` for the fallback launcher, which has no props. */
      function heroWorkspacePath() {
        var sessionList = sessions && sessions.list ? sessions.list.getSnapshot() : null;
        var id = sessionList && sessionList.current;
        if (!id) return null;
        var workspaceList = workspaces && workspaces.list ? workspaces.list.getSnapshot() : null;
        var fromWorkspaces = workspacePathIn(workspaceList, id);
        if (fromWorkspaces !== null) return fromWorkspaces;
        var row = sessionList && sessionList.byId ? sessionList.byId[id] : undefined;
        return row && row.cwd ? row.cwd : null;
      }

      /**
       * Session-creation entry: a compact official-styled chip inside the
       * composer tool row (`conversation.input.right`), on the SAME line as
       * the model/permission selectors, right before the submit action —
       * not a separate band above the card.
       *
       * Renders only on the session-creation page (hero phase): an active
       * session keeps its entry in the session header, so the two never
       * appear at once.
       */
      function DockChip(props) {
        var store = useStore();
        var t = props.t;
        var sessionId = props.sessionId;
        // The standard kit always supplies these selector hooks; the absent
        // form keeps the hook call unconditional (stable hook order) for
        // hosts and tests that render the entry without the kit.
        var useSessions = typeof props.useSessions === 'function' ? props.useSessions : selectNothing;
        var useWorkspaces = typeof props.useWorkspaces === 'function' ? props.useWorkspaces : selectNothing;
        var useSession = typeof props.useSession === 'function' ? props.useSession : null;
        var sessionRow = props.session;
        if (!sessionRow && useSession !== null) {
          // `conversation.input.right` supplies the session through a selector
          // hook rather than a prop; select the whole snapshot once.
          sessionRow = useSession(function (s) { return s; });
        }
        var blank = useSessions(function (s) {
          return !!(s && s.byId && sessionId !== undefined && s.byId[sessionId] && s.byId[sessionId].blank === true);
        });
        var cwd = useSessions(function (s) {
          var row = s && s.byId && sessionId !== undefined ? s.byId[sessionId] : undefined;
          return row && row.cwd ? row.cwd : null;
        });
        var fromWorkspaces = useWorkspaces(function (s) { return workspacePathIn(s, sessionId); });
        var workspacePath = fromWorkspaces || cwd;
        var hero = isHeroPhase(sessionRow, blank);
        var mine = bestHeroSeat(store.heroClaims) === 'dock';
        // Fill the count cache once per workspace. Workspace mode rides the
        // sessionless RPC, so this read produces no conversation row.
        React.useEffect(
          function () {
            if (!hero || !mine || !workspacePath) return undefined;
            if (workspaceCache[workspacePathKey(workspacePath)] === undefined) refreshWorkspace(workspacePath);
            return undefined;
          },
          [hero, mine, workspacePath],
        );
        if (!hero || !mine) return null;
        var open = store.open && store.anchor === 'dock';
        var count = dirCountOf(workspacePath);
        return chipWithPopover(
          'dock',
          'up',
          t,
          chipButton({
            open: open,
            dimmed: !workspacePath,
            title: workspacePath ? t('title.heroChip') : t('title.heroLauncher.noWorkspace'),
            label: count !== null && count > 0 ? t('label.withCount', { count: count }) : t('label'),
            onClick: function () {
              if (open) {
                patch({ open: false });
              } else {
                openForWorkspace(workspacePath, 'dock');
              }
            },
          }),
        );
      }

      /** Re-read the conversation root's `data-phase` attribute (authoritative
       *  hero signal) and the derivable workspace, then patch the store. */
      function syncHero() {
        var phaseEl = null;
        try {
          if (typeof document !== 'undefined') phaseEl = document.querySelector('[data-phase]');
        } catch (_) { /* no DOM (tests) */ }
        var hero = !!phaseEl && phaseEl.getAttribute && phaseEl.getAttribute('data-phase') === 'hero';
        var workspacePath = hero ? heroWorkspacePath() : null;
        var current = getSnapshot();
        if (current.hero !== hero || current.heroWorkspace !== workspacePath) {
          patch({ hero: hero, heroWorkspace: workspacePath });
        }
      }

      /** Fixed-position hero launcher: the last-resort fallback, mounted only
       *  while NO declared slot seat is available. Its DOM/store probing (and
       *  the MutationObserver behind it) stays unwired whenever a real seat
       *  holds the page. */
      function HeroLauncher(props) {
        var store = useStore();
        var t = props.t;
        var seat = bestHeroSeat(store.heroClaims);
        React.useEffect(
          function () {
            if (bestHeroSeat(getSnapshot().heroClaims) !== null) return undefined;
            var disposers = [];
            if (sessions && sessions.list && typeof sessions.list.subscribe === 'function') {
              disposers.push(sessions.list.subscribe(syncHero));
            }
            if (workspaces && workspaces.list && typeof workspaces.list.subscribe === 'function') {
              disposers.push(workspaces.list.subscribe(syncHero));
            }
            syncHero();
            var observer = null;
            if (typeof document !== 'undefined' && document.body && typeof MutationObserver !== 'undefined') {
              observer = new MutationObserver(syncHero);
              observer.observe(document.body, {
                subtree: true,
                childList: true,
                attributes: true,
                attributeFilter: ['data-phase'],
              });
            }
            return function () {
              disposers.forEach(function (dispose) { dispose(); });
              if (observer) observer.disconnect();
            };
          },
          [seat],
        );
        if (seat !== null) return null;
        if (!store.hero) return null;
        return React.createElement(
          'button',
          {
            type: 'button',
            title: store.heroWorkspace ? t('title.heroLauncher.hasWorkspace') : t('title.heroLauncher.noWorkspace'),
            onClick: function () { openForWorkspace(store.heroWorkspace, 'overlay'); },
            style: {
              position: 'fixed',
              bottom: 24,
              right: 24,
              zIndex: 300,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '6px 12px',
              borderRadius: 999,
              border: '1px solid ' + TOKEN.border,
              background: TOKEN.surface,
              color: TOKEN.ink,
              fontSize: 13,
              cursor: 'pointer',
              boxShadow: TOKEN.shadow,
              opacity: store.heroWorkspace ? 1 : 0.7,
            },
          },
          t('label'),
        );
      }

      /** Inline chip for the upstream `conversation.hero.workspaceExtras`
       *  slot: rendered beside the workspace picker once the DSH core declares
       *  the slot; a no-op registration until then. Its popover opens
       *  DOWNWARD, matching the official workspace picker on the same row. */
      function HeroChip(props) {
        var store = useStore();
        var t = props.t;
        var workspacePath = props && props.workspacePath ? props.workspacePath : store.heroWorkspace;
        if (bestHeroSeat(store.heroClaims) !== 'extras') return null;
        var open = store.open && store.anchor === 'extras';
        var count = dirCountOf(workspacePath);
        return chipWithPopover(
          'extras',
          'down',
          t,
          chipButton({
            open: open,
            dimmed: !workspacePath,
            title: workspacePath ? t('title.heroChip') : t('title.heroLauncher.noWorkspace'),
            label: count !== null && count > 0 ? t('label.withCount', { count: count }) : t('label'),
            onClick: function () {
              if (open) {
                patch({ open: false });
              } else {
                openForWorkspace(workspacePath, 'extras');
              }
            },
          }),
        );
      }

      // Plus-menu entry (composer bottom-left) ------------------------------
      /** The workspace path for a session, from sessions/workspaces stores. */
      function effectiveWorkspacePath(sessionId) {
        var sessionList = sessions && sessions.list ? sessions.list.getSnapshot() : null;
        var workspaceList = workspaces && workspaces.list ? workspaces.list.getSnapshot() : null;
        if (sessionId) {
          var fromWorkspaces = workspacePathIn(workspaceList, sessionId);
          if (fromWorkspaces !== null) return fromWorkspaces;
          var row = sessionList && sessionList.byId ? sessionList.byId[sessionId] : undefined;
          if (row && row.cwd) return row.cwd;
        }
        // Fall back to the current session's cwd when the session is unknown.
        var current = sessionList && sessionList.current;
        var cur = current !== undefined && sessionList.byId ? sessionList.byId[current] : undefined;
        if (cur && cur.cwd) return cur.cwd;
        return null;
      }

      // @ file-reference source for secondary directories ------------------
      /** Basename of a directory path (either separator spelling). */
      function pathBase(p) {
        var s = String(p).replace(/[\\/]+$/, '');
        var i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
        return i >= 0 ? s.slice(i + 1) : s;
      }

      /** Split a typed absolute path into the directory to list + a name filter. */
      function splitDirAndName(typed) {
        var p = String(typed).replace(/\\/g, '/');
        var trailing = /\/$/.test(p);
        var trimmed = trailing ? p.slice(0, -1) : p;
        var idx = trimmed.lastIndexOf('/');
        // Drive root (`D:`) or POSIX root: nothing left to descend.
        if (idx <= 0 || (idx === 1 && /^[A-Za-z]:$/.test(trimmed))) {
          return { dir: trimmed + '/', nameQuery: '' };
        }
        if (trailing) return { dir: trimmed + '/', nameQuery: '' };
        return { dir: trimmed.slice(0, idx + 1), nameQuery: trimmed.slice(idx + 1) };
      }

      /** Join a directory and one relative segment without doubling slashes. */
      function joinDir(base, segment) {
        var b = String(base).replace(/\\/g, '/').replace(/\/+$/, '');
        return b + '/' + String(segment).replace(/^\/+/, '');
      }

      /**
       * The `@` mention text for a path, mirroring the shipped grammar:
       * directories carry a trailing slash, a path with whitespace is quoted,
       * and a drilled directory keeps the quote OPEN so completion can descend
       * another level (`@"path/`), exactly like `formatFileMention`.
       */
      function mentionFor(path, kind, quoted, keepOpen) {
        var p = String(path).replace(/\\/g, '/').replace(/\/+$/, '');
        var isDir = kind === 'directory';
        var shown = isDir ? p + '/' : p;
        if (!(quoted || /\s/.test(shown))) return '@' + shown;
        if (isDir && keepOpen) return '@"' + shown;
        return '@"' + shown + '"';
      }

      /** Crumb payload shaped like the shipped reference source's. */
      function crumbValue(label, mention) {
        return JSON.stringify({ kind: 'file', fileKind: 'directory', label: label, mention: mention });
      }

      /** Secondary dirs known synchronously for one session (never fetches). */
      function cachedDirsFor(sessionId) {
        var sc = sessionCache[sessionId];
        if (sc && Array.isArray(sc.dirs) && sc.dirs.length > 0) return sc.dirs;
        var wp = effectiveWorkspacePath(sessionId);
        var wc = workspaceCache[workspacePathKey(wp || '')];
        return wc && Array.isArray(wc.dirs) ? wc.dirs : [];
      }

      /**
       * Turn the typed `@` query into the list of directories to enumerate.
       * Two accepted shapes keep the menu usable and the drill chain closed:
       *  - alias form `@<secondary-name>/<rest>` — the first segment picks the
       *    secondary directory, the rest descends inside it;
       *  - absolute form `@D:/abs/path/…` — what a drill inserts, so Tab can be
       *    pressed repeatedly.
       * Each result is { dir, nameQuery }: the directory to list and the
       * partial name to filter its children by.
       */
      function resolveListTargets(dirs, query) {
        var q = String(query || '').replace(/\\/g, '/');
        if (/^[A-Za-z]:\//.test(q) || q.startsWith('/')) {
          var split = splitDirAndName(q);
          return [{ dir: split.dir, nameQuery: split.nameQuery }];
        }
        var slash = q.indexOf('/');
        var head = slash < 0 ? q : q.slice(0, slash);
        var rest = slash < 0 ? '' : q.slice(slash + 1);
        var matched = [];
        for (var i = 0; i < dirs.length; i++) {
          var dir = dirs[i];
          var base = pathBase(dir);
          if (head !== '' && base.toLowerCase().indexOf(head.toLowerCase()) < 0) continue;
          if (rest === '') {
            matched.push({ dir: dir, nameQuery: '' });
            continue;
          }
          var inner = splitDirAndName(joinDir(dir, rest));
          matched.push(inner);
        }
        // No secondary directory matched the head: fall back to filtering every
        // directory's children by the whole query, which is the pre-drill
        // behavior and still finds files by name.
        if (matched.length === 0 && head !== '') {
          for (var j = 0; j < dirs.length; j++) matched.push({ dir: dirs[j], nameQuery: q });
        }
        return matched;
      }

      /** One menu item for a FileReferenceCandidate from a secondary dir. */
      function referenceMenuItem(cand, groupTitle) {
        var slash = cand.path.lastIndexOf('/');
        var name = slash < 0 ? cand.path : cand.path.slice(slash + 1);
        var parent = slash < 0 ? '' : cand.path.slice(0, slash);
        var isDir = cand.kind === 'directory';
        var value = JSON.stringify({ kind: cand.kind, path: cand.path, name: name });
        return {
          name: isDir ? name + '/' : name,
          description: parent,
          icon: isDir ? 'folder' : 'file',
          section: groupTitle,
          value: value,
          // Tab descends into a directory instead of committing it — the same
          // affordance the shipped primary-workspace source offers.
          ...(isDir ? { drill: true } : {}),
        };
      }

      /**
       * The "multi-folder" `@` source: merges files inside the configured
       * secondary working directories into the input trigger's `@` menu,
       * alongside the shipped primary-workspace "reference" source. Each
       * candidate's `path` is the absolute POSIX-slash path so the model can
       * `read` it directly; secondary files appear under their own group
       * title and stay selectable as `@<path>`/`@"<path>"`.
       */
      function buildReferenceSource() {
        return {
          trigger: '@',
          name: 'multi-folder',
          showGroupTitle: false,
          async candidates(session, params) {
            var req = params || {};
            var query = typeof req.query === 'string' ? req.query : '';
            var signal = req.signal;
            try {
              if (!session || !session.sessionId) return [];
              var sessionId = session.sessionId;
              var dirs = cachedDirsFor(sessionId);
              if (dirs.length === 0) {
                var wp2 = effectiveWorkspacePath(sessionId);
                if (wp2) {
                  var value = null;
                  try { value = await remoteCall('multiFolder/list', { workspace: wp2 }); } catch (_) { value = null; }
                  if (value && Array.isArray(value.dirs)) {
                    storeWorkspace(wp2, value);
                    dirs = value.dirs;
                  }
                }
              }
              if (dirs.length === 0) return [];
              var targets = resolveListTargets(dirs, query);
              if (targets.length === 0) return [];
              if (signal && typeof signal.throwIfAborted === 'function') signal.throwIfAborted();
              var lists = await Promise.all(targets.map(function (target) {
                return remoteCall('multiFolder/listFiles', { workspace: effectiveWorkspacePath(sessionId) || '', dir: target.dir, query: target.nameQuery })
                  .catch(function () { return []; });
              }));
              var groupTitle = t('ref.group');
              var items = [];
              for (var i = 0; i < lists.length; i++) {
                var cands = lists[i] || [];
                for (var j = 0; j < cands.length; j++) {
                  var c = cands[j];
                  if (!c || typeof c.path !== 'string' || c.path.length === 0) continue;
                  var item = referenceMenuItem(c, groupTitle);
                  if (item) items.push(item);
                }
              }
              return items.slice(0, 30);
            } catch (error) {
              // A failure here must degrade to an empty group — never reject,
              // never touch the shipped primary-workspace group.
              try { console.error('[dsh-multi-folder] @ candidates failed:', error); } catch (_) {}
              return [];
            }
          },
          /**
           * Breadcrumb header while drilled into a secondary directory: the
           * secondary directory name plus each settled level, so the user can
           * jump back — same interaction as the shipped source's workspace
           * crumbs. Reads only the synchronous caches (a header must not await).
           */
          header(session, req) {
            try {
              if (!session || !req || req.drilled !== true) return void 0;
              var q = String(req.query || '').replace(/\\/g, '/');
              var slash = q.lastIndexOf('/');
              if (slash <= 0) return void 0;
              var chain = q.slice(0, slash + 1);
              var dirs = cachedDirsFor(session.sessionId);
              var root = null;
              for (var i = 0; i < dirs.length; i++) {
                var norm = String(dirs[i]).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
                if (chain.toLowerCase() === norm + '/' || chain.toLowerCase().startsWith(norm + '/')) {
                  if (root === null || norm.length > root.key.length) root = { key: norm, dir: dirs[i] };
                }
              }
              if (root === null) return void 0;
              var rel = chain.slice(root.key.length).split('/').filter(function (s) { return s !== ''; });
              var quoted = req.quoted === true;
              var crumbs = [{
                label: pathBase(root.dir),
                value: crumbValue(pathBase(root.dir), mentionFor(root.dir, 'directory', quoted, true)),
              }];
              for (var j = 0; j < rel.length; j++) {
                crumbs.push({
                  label: rel[j],
                  value: crumbValue(rel[j], mentionFor(joinDir(root.dir, rel.slice(0, j + 1).join('/')), 'directory', quoted, true)),
                  ...(j === rel.length - 1 ? { current: true } : {}),
                });
              }
              return crumbs;
            } catch (_) {
              return void 0;
            }
          },
          onPick(event) {
            var candidate = event && event.candidate;
            if (!candidate || typeof candidate.value !== 'string') return null;
            var v = null;
            try { v = JSON.parse(candidate.value); } catch (_) { v = null; }
            if (!v || typeof v.path !== 'string') {
              // Crumb payloads carry a ready mention instead of a path.
              if (v && v.fileKind === 'directory' && typeof v.mention === 'string' && event && event.action === 'drill') {
                return { text: v.mention, continue: true };
              }
              return null;
            }
            // Commit (Enter/click): a closed mention. Drill (Tab): the same
            // directory with its trailing slash and, for a spaced path, the
            // quote kept OPEN — exactly the shipped grammar — so the menu
            // re-tracks the new query and lists the next level immediately.
            if (v.kind === 'directory' && event && event.action === 'drill') {
              return { text: mentionFor(v.path, 'directory', false, true), continue: true };
            }
            var mention = mentionFor(v.path, v.kind, false, false);
            return {
              insert: {
                source: 'multi-folder',
                ref: mention,
                label: v.name,
                appearance: v.kind === 'directory' ? 'folder' : 'file',
                clipboardText: mention,
              },
            };
          },
          codec: {
            clipboardText: function (ref) { return ref; },
            serialize: function (ref) { return Promise.resolve(ref); },
          },
        };
      }

      // Official "+" menu integration ---------------------------------------
      // The shipped composer "+" popover renders its command group from the
      // slash-command registry, so the host's `/multi-folder` command already
      // appears there. What the shipped menu shows is the bare command name
      // plus its description; a small MutationObserver dresses that row the
      // same way meow-memory dresses its dream row: borrow the official icon
      // and alias classes, swap in a localized label, and prepend an icon —
      // so the entry reads native inside the official menu.
      var MENU_SELECTOR = '[data-trigger-menu]';
      var ROW_ID_PREFIX = 'dsh-slash-option-command-';
      var MF_COMMAND = 'multi-folder';
      /** Official command aliases whose span class is safe to borrow. */
      var OFFICIAL_ALIASES = ['compact', 'model', 'export', 'permission', 'goal', 'plan', 'feedback'];
      var FOLDER_SVG =
        '<svg viewBox="0 0 512 512" aria-hidden="true" focusable="false"><path fill="currentColor" d="M64 480H448c35.3 0 64-28.7 64-64V160c0-35.3-28.7-64-64-64H288c-10.1 0-19.6-4.7-25.6-12.9L243.2 57.6C231.1 41.5 212.1 32 192 32H64C28.7 32 0 60.7 0 96V416c0 35.3 28.7 64 64 64zM64 96h128c10.1 0 19.6 4.7 25.6 12.9l19.2 25.6c12.1 16.1 31.1 25.6 51.2 25.6H448v64H64V96z"/></svg>';

      /** One row's command token: the first direct span whose text equals it. */
      function mfRowOf(menu) {
        var rows = menu.querySelectorAll('button[id^="' + ROW_ID_PREFIX + '"]');
        for (var i = 0; i < rows.length; i++) {
          var spans = rows[i].querySelectorAll(':scope > span');
          for (var j = 0; j < spans.length; j++) {
            if (spans[j].textContent === MF_COMMAND) return { row: rows[i], nameSpan: spans[j] };
          }
        }
        return null;
      }

      /** The icon span class from an official row (first row that has one). */
      function mfOfficialIconClass(menu) {
        var svg = menu.querySelector('button[id^="' + ROW_ID_PREFIX + '"] > span > svg');
        var span = svg && svg.parentElement;
        if (span === null || span === undefined || span.className.length === 0) return null;
        return span.className;
      }

      /** The alias badge class borrowed from a known official row. */
      function mfOfficialAliasClass(menu) {
        var spans = menu.querySelectorAll('button[id^="' + ROW_ID_PREFIX + '"] > span');
        for (var i = 0; i < OFFICIAL_ALIASES.length; i++) {
          for (var j = 0; j < spans.length; j++) {
            var span = spans[j];
            if (span.textContent === OFFICIAL_ALIASES[i] && span.className.length > 0) return span.className;
          }
        }
        return null;
      }

      function mfDecorateRow(hit, iconClass, aliasClass, label, description) {
        var row = hit.row;
        var nameSpan = hit.nameSpan;
        if (row.getAttribute('data-mf-decorated') === '1') return;
        row.setAttribute('data-mf-decorated', '1');
        nameSpan.textContent = label;
        // Icon before the label, borrowing the official class when present.
        var prev = nameSpan.previousElementSibling;
        if (prev === null || !prev.hasAttribute('data-mf-icon')) {
          var icon = document.createElement('span');
          icon.setAttribute('data-mf-icon', '1');
          if (iconClass !== null) icon.className = iconClass;
          else icon.style.cssText = 'display:inline-flex;flex:none;width:14px;height:14px;align-items:center;justify-content:center;';
          icon.innerHTML = FOLDER_SVG;
          nameSpan.parentElement.insertBefore(icon, nameSpan);
        }
        // Alias badge after the label, borrowing the official class when present.
        if (row.querySelector(':scope > span[data-mf-alias]') === null) {
          var alias = document.createElement('span');
          alias.setAttribute('data-mf-alias', '1');
          if (aliasClass !== null) alias.className = aliasClass;
          else alias.style.cssText = 'opacity:.55;font-size:.9em;';
          alias.textContent = MF_COMMAND;
          nameSpan.parentElement.insertBefore(alias, nameSpan.nextSibling);
        }
        // Shorten the description span when the shipped menu shows one.
        var spans = row.querySelectorAll(':scope > span');
        for (var i = 0; i < spans.length; i++) {
          var span = spans[i];
          if (span !== nameSpan && span !== alias && (span.textContent || '').length > 4) {
            span.textContent = description;
            break;
          }
        }
      }

      /** One decorate pass over the live "+" menu (no-throw). */
      function mfDecorateOnce() {
        try {
          if (typeof document === 'undefined') return;
          var menu = document.querySelector(MENU_SELECTOR);
          if (menu === null) return;
          var hit = mfRowOf(menu);
          if (hit === null) return;
          mfDecorateRow(
            hit,
            mfOfficialIconClass(menu),
            mfOfficialAliasClass(menu),
            t('label'),
            t('menu.desc'),
          );
        } catch (_) { /* decoration is cosmetic; never throw */ }
      }

      /** MutationObserver decorating the "+" menu whenever it mounts. */
      function startMenuMultiFolderFace() {
        if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') {
          return function () {};
        }
        var scheduled = false;
        var decorate = function () {
          scheduled = false;
          mfDecorateOnce();
        };
        var schedule = function () {
          if (scheduled) return;
          scheduled = true;
          queueMicrotask(decorate);
        };
        var observer = new MutationObserver(schedule);
        observer.observe(document.body, { childList: true, subtree: true });
        schedule();
        return function () { observer.disconnect(); };
      }

      // Official popupSelect: click the menu row → the shipped picker shell ---
      /** Fold a /multi-folder command result's [MF:JSON] state into both stores. */
      function syncAfterCommand(sessionId, text) {
        var parsed = parseJsonLine(text);
        if (!parsed) return;
        sessionCache[sessionId] = { workspace: parsed.workspace, dirs: parsed.dirs };
        if (parsed.workspace) storeWorkspace(parsed.workspace, parsed);
        patch({ cacheRev: getSnapshot().cacheRev + 1 });
      }

      /** Directory basename for the option label. */
      function dirLabel(dir) {
        var s = String(dir).replace(/[\\/]+$/, '');
        var i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
        return i >= 0 ? s.slice(i + 1) : s;
      }

      /** { workspace, sessionMode, sessionId } for the invoking session, or null. */
      function popupTarget(sessionId) {
        var wp = effectiveWorkspacePath(sessionId);
        if (!wp) return null;
        var sessionList = sessions && sessions.list ? sessions.list.getSnapshot() : null;
        var row = sessionList && sessionList.byId && sessionId !== undefined ? sessionList.byId[sessionId] : undefined;
        // A real (non-blank) session can run host commands, which also arm the
        // change notice for the agent; the blank hero session has no agent yet,
        // so it rides the sessionless multiFolder RPC keyed by workspace.
        var sessionMode = !!(row && row.blank !== true);
        return { workspace: wp, sessionMode: sessionMode, sessionId: sessionId };
      }

      /**
       * The ctx.commandUi decoration spec for the HOST /multi-folder command:
       * picking it in the shipped "+" menu (or submitting it bare) opens the
       * official popupSelect shell — first row adds a directory (native
       * picker), every secondary-directory row removes through the official
       * risk confirmation. Thrown errors surface in the shell and keep it
       * open for retry; a resolved select consumes the token and closes.
       */
      function buildPopupSpec() {
        return {
          kind: 'popupSelect',
          async options(context, signal) {
            var target = context && context.sessionId ? popupTarget(context.sessionId) : null;
            if (target === null) {
              return [{ id: '__none__', label: t('popup.noWorkspace') }];
            }
            var value = await remoteCall('multiFolder/list', { workspace: target.workspace });
            if (signal && signal.aborted) return [];
            var dirs = value && Array.isArray(value.dirs) ? value.dirs : [];
            publishWorkspace(target.workspace, value);
            var rows = [{ id: '__add__', label: t('popup.add'), detail: t('popup.addHint') }];
            for (var i = 0; i < dirs.length; i++) {
              rows.push({
                id: 'dir:' + dirs[i],
                label: dirLabel(dirs[i]),
                detail: dirs[i],
                confirmation: {
                  title: t('confirm.removeTitle'),
                  description: dirs[i] + '\n' + t('confirm.removeDesc'),
                  acknowledgeLabel: t('confirm.ack'),
                  cancelLabel: t('confirm.cancel'),
                  confirmLabel: t('confirm.ok'),
                },
              });
            }
            return rows;
          },
          async onSelect(option, context) {
            if (!option || typeof option.id !== 'string') return;
            if (option.id === '__none__') return;
            var target = context && context.sessionId ? popupTarget(context.sessionId) : null;
            if (target === null) throw new Error(t('popup.noWorkspace'));
            if (option.id === '__add__') {
              // Native picker when it can answer; otherwise the owned browser
              // opens on top of the closed popup. Throwing here would only
              // ever show the user an error they cannot act on.
              await pickAndAdd(target);
              return;
            }
            if (option.id.indexOf('dir:') === 0) {
              var dir = option.id.slice(4);
              if (target.sessionMode) {
                var rmText = await runCommand(target.sessionId, '/multi-folder remove "' + dir.replace(/"/g, '\\"') + '"');
                syncAfterCommand(target.sessionId, rmText);
              } else {
                var removed = await remoteCall('multiFolder/remove', { workspace: target.workspace, path: dir });
                publishWorkspace(target.workspace, removed);
              }
              return;
            }
          },
        };
      }

      /**
       * The browser as a modal: dimming backdrop, centered card, Esc to
       * dismiss. Registered on its own overlay slot so it floats above the "+"
       * menu and the panel alike (the panel stays reachable underneath).
       */
      function BrowserModal(props) {
        var store = useStore();
        var t = props.t;
        React.useEffect(function () {
          if (!store.browserOpen) return undefined;
          function onKey(event) {
            if (event.key === 'Escape') dismissBrowser();
          }
          window.addEventListener('keydown', onKey);
          return function () { window.removeEventListener('keydown', onKey); };
        }, [store.browserOpen]);
        if (!store.browserOpen) return null;
        return element('div', {
          style: {
            position: 'fixed',
            inset: 0,
            zIndex: 700,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 24,
          },
          onMouseDown: function (event) {
            if (event.target === event.currentTarget) dismissBrowser();
          },
        }, [
          // Official Modal.mask: bg-mask-1 + the mask blur. bg-mask-2 with no
          // blur was the see-through layer the page read through.
          element('div', { key: 'm', className: 'mf-bw-mask' }),
          // Official Modal.dialog: opaque layer-2, no border, prominent
          // elevation, panel radius.
          element('div', {
            key: 'd',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': t('browser.title'),
            className: 'mf-bw-dialog',
          }, [
            element('div', {
              key: 't',
              className: 'mf-bw-title',
            }, t('browser.title')),
            React.createElement(DirectoryBrowser, { t: t }),
          ]),
        ]);
      }

      // Registrations ------------------------------------------------------
      // The shipped composer "+" menu is the single entry point:
      // ① the host `/multi-folder` command (registered WITHOUT an input hint,
      //    so the row lists in every draft state like /dream) appears in its
      //    Commands group; startMenuMultiFolderFace dresses that row's label
      //    and icon (cosmetic only — no click interception),
      // ② ctx.commandUi.decorate turns the row's click / bare Enter into the
      //    official popupSelect shell (the same shell the model picker uses):
      //    add row + directory rows, remove behind a risk confirmation.
      slots.inject('shell.overlay', function () {
        return slots.register(
          { name: 'shell.overlay', id: 'multi-folder', order: 100, label: function () { return t('label'); }, locale: NS },
          function (props) { return React.createElement(Panel, props); },
        );
      });
      // The owned browser is a separate modal surface: it must sit above the
      // "+" menu it was opened from, and it opens without the panel ever
      // having been shown.
      slots.inject('shell.overlay', function () {
        return slots.register(
          { name: 'shell.overlay', id: 'multi-folder-browser', order: 110, label: function () { return t('browser.title'); }, locale: NS },
          function (props) { return React.createElement(BrowserModal, props); },
        );
      });
      var mfMenuFaceDisposer = startMenuMultiFolderFace();
      if (typeof ctx.effect === 'function') {
        ctx.effect(function () { return mfMenuFaceDisposer; }, 'dsh-multi-folder: + menu face');
      } else if (typeof mfMenuFaceDisposer === 'function') {
        // The dynamic bridge has no effect seat; wire the disposer into the
        // page's unload cycle directly so HMR does not leak observers.
        window.addEventListener('pagehide', mfMenuFaceDisposer, { once: true });
      }
      // Optional services activate through ctx.inject: it fires when the
      // service appears (possibly later than this apply pass) and simply never
      // fires on shells that do not compose it — so the plugin activates and
      // the missing feature is skipped instead of blocking the whole entry.
      if (typeof ctx.inject === 'function') {
        ctx.inject(['commandUi'], function (scope) {
          var commandUi = scope.get('commandUi');
          if (!commandUi || typeof commandUi.decorate !== 'function') return undefined;
          return scope.effect(function () {
            return commandUi.decorate({
              name: MF_COMMAND,
              available: function () { return true; },
              ui: buildPopupSpec(),
            });
          }, 'dsh-multi-folder: + menu popup');
        });
        ctx.inject(['inputTriggers'], function (scope) {
          var inputTriggers = scope.get('inputTriggers');
          if (!inputTriggers || typeof inputTriggers.registerSource !== 'function') return undefined;
          var refSource = buildReferenceSource();
          return scope.effect(function () { return inputTriggers.registerSource(refSource); }, 'dsh-multi-folder: @ source');
        });
      }
    }

    exports.name = name;
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
