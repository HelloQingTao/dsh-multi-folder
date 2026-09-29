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
  id: 'dsh-multi-folder',
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
      surface: 'var(--dsw-alias-bg-overlay, #ffffff)',
      subtle: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.08))',
      fill: 'var(--dsw-alias-button-tool-bar-fill, rgba(127,127,127,0.10))',
      hover: 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.14))',
      ink: 'var(--dsw-alias-label-primary, #1a1a1a)',
      inkSoft: 'var(--dsw-alias-label-secondary, #4a4a4a)',
      inkMuted: 'var(--dsw-alias-label-tertiary, #6b6b6b)',
      inkFaint: 'var(--dsw-alias-label-caption, #8a8a8a)',
      danger: 'var(--dsw-alias-state-error-primary, #c62828)',
      accent: 'var(--dsw-alias-brand-primary, #4c6ef5)',
      shadow: '0 8px 24px var(--dsw-alias-bg-mask-2, rgba(0,0,0,0.18))',
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
    var inject = ['remote', 'remote.commands', 'slots', 'workspaces', 'uiWorkspace', 'connection', 'sessions', 'locale', 'inputTriggers', 'commandUi'];

    function apply(ctx) {
      var slots = ctx.slots;
      var remote = ctx.remote;
      var workspaces = ctx.workspaces;
      var uiWorkspace = ctx.uiWorkspace;
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
        if (!workspacePath) return Promise.resolve();
        patch({ busy: true, error: null });
        var payload = Object.assign({ workspace: workspacePath }, args);
        return remoteCall(endpoint, payload).then(function (value) {
          publishWorkspace(workspacePath, value);
        }).catch(function (e) {
          patch({ busy: false, error: String(e && e.message ? e.message : e) });
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
            sessionCache[sessionId] = { workspace: parsed.workspace, dirs: parsed.dirs };
            patch({
              busy: false,
              workspace: parsed.workspace,
              dirs: parsed.dirs,
            });
          } else {
            refresh(sessionId);
          }
        }).catch(function (e) {
          patch({ busy: false, error: String(e && e.message ? e.message : e) });
          refresh(sessionId);
        });
      }

      function addDirectory() {
        // DSH 0.1.2 moved the directory picker onto `uiWorkspace`; earlier
        // shells kept it on `workspaces`. Pick whichever service actually
        // exposes it (and call it with the right receiver), surfacing a clear
        // error when neither does instead of throwing synchronously.
        var picker = (uiWorkspace && typeof uiWorkspace.pickDirectory === 'function')
          ? uiWorkspace
          : (workspaces && typeof workspaces.pickDirectory === 'function') ? workspaces : null;
        if (picker === null) {
          patch({ error: 'multi-folder: the directory picker service is unavailable' });
          return;
        }
        picker.pickDirectory().then(function (path) {
          if (path === null || path === undefined) return;
          var snapshot = getSnapshot();
          if (snapshot.sessionId) {
            mutate(snapshot.sessionId, '/multi-folder add "' + path.replace(/"/g, '\\"') + '"');
          } else if (snapshot.workspace) {
            mutateWorkspace(snapshot.workspace, 'multiFolder/add', { path: path });
          }
        }).catch(function (e) {
          patch({ error: String(e && e.message ? e.message : e) });
        });
      }

      /** Open the panel for a session, reusing cached data when present so
       *  pure reads do not produce conversation rows. `anchor` names the
       *  surface that owns the popover ('header' for the session header). */
      function openFor(sessionId, anchor) {
        if (!sessionId) return;
        var cached = sessionCache[sessionId];
        patch({
          open: true,
          mode: 'session',
          sessionId: sessionId,
          dirs: cached ? cached.dirs : [],
          workspace: cached ? cached.workspace : null,
          error: null,
          anchor: anchor || 'overlay',
        });
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
              var dirs = [];
              var sc = sessionCache[sessionId];
              if (sc && Array.isArray(sc.dirs) && sc.dirs.length > 0) {
                dirs = sc.dirs;
              } else {
                var wp = effectiveWorkspacePath(sessionId);
                var key = workspacePathKey(wp || '');
                var wc = workspaceCache[key];
                if (wc && Array.isArray(wc.dirs) && wc.dirs.length > 0) dirs = wc.dirs;
              }
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
              if (signal && typeof signal.throwIfAborted === 'function') signal.throwIfAborted();
              var lists = await Promise.all(dirs.map(function (dir) {
                return remoteCall('multiFolder/listFiles', { dir: dir, query: query }).catch(function () { return []; });
              }));
              var groupTitle = t('ref.group');
              var items = [];
              for (var i = 0; i < dirs.length; i++) {
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
          onPick(event) {
            var candidate = event && event.candidate;
            if (!candidate || typeof candidate.value !== 'string') return null;
            var v = null;
            try { v = JSON.parse(candidate.value); } catch (_) { v = null; }
            if (!v || typeof v.path !== 'string') return null;
            var mention = v.path.indexOf(' ') >= 0 ? '@"' + v.path + '"' : '@' + v.path;
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

      /** Sync both stores from the [MF:JSON] line a /multi-folder run returned. */
      function syncAfterCommand(sessionId, text) {
        var parsed = parseJsonLine(text);
        if (!parsed) return;
        sessionCache[sessionId] = { workspace: parsed.workspace, dirs: parsed.dirs };
        if (parsed.workspace) storeWorkspace(parsed.workspace, parsed);
        patch({ cacheRev: getSnapshot().cacheRev + 1 });
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
              if (!uiWorkspace || typeof uiWorkspace.pickDirectory !== 'function') {
                throw new Error('multi-folder: the directory picker service is unavailable');
              }
              var picked = await uiWorkspace.pickDirectory();
              if (picked === null || picked === undefined) return; // cancelled: close quietly
              if (target.sessionMode) {
                var addText = await runCommand(target.sessionId, '/multi-folder add "' + String(picked).replace(/"/g, '\\"') + '"');
                syncAfterCommand(target.sessionId, addText);
              } else {
                var added = await remoteCall('multiFolder/add', { workspace: target.workspace, path: String(picked) });
                publishWorkspace(target.workspace, added);
              }
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
      var mfMenuFaceDisposer = startMenuMultiFolderFace();
      if (typeof ctx.effect === 'function') {
        ctx.effect(function () { return mfMenuFaceDisposer; }, 'dsh-multi-folder: + menu face');
      } else if (typeof mfMenuFaceDisposer === 'function') {
        // The dynamic bridge has no effect seat; wire the disposer into the
        // page's unload cycle directly so HMR does not leak observers.
        window.addEventListener('pagehide', mfMenuFaceDisposer, { once: true });
      }
      if (typeof ctx.get === 'function' && typeof ctx.commandUi !== 'undefined' && ctx.commandUi !== null) {
        ctx.effect(function () {
          return ctx.commandUi.decorate({
            name: MF_COMMAND,
            available: function () { return true; },
            ui: buildPopupSpec(),
          });
        }, 'dsh-multi-folder: + menu popup');
      }

      // "@" file-reference source: merge files inside the secondary working
      // directories into the input trigger's @ menu. Co-exists with the
      // shipped "reference" @ source (different name, same trigger) — the
      // trigger pipeline renders both as separate groups, and a failure in
      // this source only drops this source's group (source-failed degrades
      // silently per source), never the shipped group.
      if (typeof ctx.get === 'function') {
        var inputTriggers = ctx.get('inputTriggers');
        if (inputTriggers && typeof inputTriggers.registerSource === 'function') {
          var refSource = buildReferenceSource();
          ctx.effect(function () { return inputTriggers.registerSource(refSource); }, 'dsh-multi-folder: @ source');
        }
      }
    }

    exports.name = name;
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
