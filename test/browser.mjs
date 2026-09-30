/**
 * Owned directory browser: the fallback UI this plugin draws when the shell
 * cannot offer a native picker, served by multiFolder/browse + makeDir.
 * Everything is driven through the REAL rendered handlers (buttons captured
 * from the component tree), so the wiring — not just the helpers — is covered.
 * Run: node test/browser.mjs
 */
import { readFileSync } from 'node:fs';

let captured = null;
const styleTags = [];
globalThis.window = {
  __ModuleLoader__: { load(record) { captured = record; } },
  addEventListener() {},
};
globalThis.document = {
  head: { appendChild(node) { styleTags.push(node); } },
  body: {},
  querySelector(selector) {
    // Answer style-tag lookups honestly so "inject once" is a real assertion.
    const hit = /^style\[data-plugin-css="([^"]+)"\]$/.exec(selector);
    if (hit === null) return null;
    return styleTags.find((tag) => tag.attrs['data-plugin-css'] === hit[1]) ?? null;
  },
  createElement(tag) {
    return { tag, attrs: {}, textContent: '', setAttribute(k, v) { this.attrs[k] = v; } };
  },
};
(0, eval)(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'));

const fail = (msg) => { console.error('FAIL:', msg); process.exit(1); };
const assert = (cond, msg) => { if (!cond) fail(msg); };
assert(captured && typeof captured.factory === 'function', 'bundle captured');

// React shim that INVOKES function components, so the whole tree and every
// onClick is reachable.
const reactShim = {
  createElement(type, props, ...children) {
    if (typeof type === 'function') return type(props ?? {});
    return { type, props: props ?? {}, children };
  },
  Fragment: '$fragment',
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
  useEffect: (fn) => { fn(); return undefined; },
};
const moduleExport = captured.factory((spec) => {
  if (spec === 'react') return reactShim;
  throw new Error('unexpected require: ' + spec);
});

const WS = 'D:/proj/main';
const HOME = 'C:/Users/tester';

// ---- RPC mock: an in-memory tree, one level per directory ----------------
const rpc = [];
const homeEntries = () => [{ name: 'docs', path: HOME + '/docs', hidden: false }];
const tree = {
  // The host resolves an empty browse path to home, so both keys agree.
  '': () => level(HOME, null, homeEntries()),
  [HOME]: () => level(HOME, null, homeEntries()),
  [HOME + '/docs']: () => level(HOME + '/docs', HOME, []),
};
function level(path, parent, entries, truncated) {
  return { path, parent, home: HOME, entries, truncated: truncated === true };
}
let failNextBrowse = false;
let failNextAdd = false;
// A held response, so a test can look at the dialog while an operation is
// genuinely in flight: the busy LABEL must belong to the creating action only.
let rpcGate = null;
let gatedEndpoint = null;
const connection = {
  rpc: {
    async call(channel, endpoint, payload) {
      rpc.push({ endpoint, args: payload.args });
      if (gatedEndpoint !== null && endpoint === gatedEndpoint && rpcGate !== null) await rpcGate;
      if (endpoint === 'multiFolder/list') return { ok: true, value: { workspace: WS, dirs: [] } };
      if (endpoint === 'multiFolder/browse') {
        if (failNextBrowse) { failNextBrowse = false; return { ok: false, error: { message: 'not a readable directory: X' } }; }
        const maker = tree[payload.args.path];
        if (maker === undefined) return { ok: false, error: { message: 'not a readable directory: ' + payload.args.path } };
        return { ok: true, value: maker() };
      }
      if (endpoint === 'multiFolder/makeDir') {
        const made = payload.args.parent + '/' + payload.args.name;
        tree[made] = () => level(made, payload.args.parent, []);
        return { ok: true, value: { path: made, parent: payload.args.parent } };
      }
      if (endpoint === 'multiFolder/add') {
        if (failNextAdd) { failNextAdd = false; return { ok: false, error: { message: 'add requires an absolute path' } }; }
        return { ok: true, value: { workspace: WS, dirs: [payload.args.path] } };
      }
      return { ok: false, error: { message: 'unexpected endpoint ' + endpoint } };
    },
  },
};

const registrations = new Map();
const decorations = [];
const services = {
  locale: { register: () => () => {}, bind: () => (key) => key },
  // One blank (hero) session: the popup then rides the sessionless RPC, which
  // is the path the owned browser must commit through.
  sessions: {
    list: {
      getSnapshot: () => ({ byId: { blank: { cwd: WS, blank: true } }, current: 'blank' }),
      subscribe: () => () => {},
    },
  },
  workspaces: { list: { getSnapshot: () => ({ items: [] }), subscribe: () => () => {} } },
  connection,
  remote: { commands: { execute: async () => ({ ok: true, value: { result: { kind: 'success', text: '' } } }) } },
  slots: {
    inject: (slotName, callback) => { const d = callback(); return () => { if (typeof d === 'function') d(); }; },
    register(options, component) {
      const list = registrations.get(options.id) ?? [];
      list.push(component);
      registrations.set(options.id, list);
      return () => {};
    },
  },
  inputTriggers: { registerSource: () => () => {}, sources: [] },
  commandUi: { decorate: (d) => { decorations.push(d); return () => {}; }, decorations },
};
// `uiWorkspace` is deliberately NOT composed at first: that is exactly the
// remote / LAN / desktop-shell case the owned browser exists to serve.
const ctx = {
  ...Object.fromEntries(Object.entries(services).filter(([n]) => moduleExport.inject.includes(n))),
  get: (name) => services[name],
  effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {}; },
  inject: (deps, callback) => {
    if (deps.every((d) => services[d] !== undefined)) callback({ get: (name) => services[name], effect: ctx.effect });
    return Promise.resolve();
  },
  on: () => () => {},
};
moduleExport.apply(ctx);

const t = (key) => key;
const modal = () => registrations.get('multi-folder-browser');
const render = () => (modal() ? modal()[0]({ t }) : null);
const openAdd = async () => {
  await decorations[0].ui.onSelect({ id: '__add__' }, { sessionId: 'blank' });
  await settle();
};

function findAll(node, predicate, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out;
  if (Array.isArray(node)) { for (const item of node) findAll(item, predicate, out); return out; }
  if (node.props !== undefined && typeof node.props.className === 'string' && predicate(node)) out.push(node);
  if (node.children !== undefined) findAll(node.children, predicate, out);
  return out;
}
const byClass = (root, cls) => findAll(root, (n) => n.props.className.split(/\s+/).includes(cls));
/** The rendered TEXT of a shim node: children sit on node.children. */
const textOf = (node) => {
  const c = node === null || node === undefined ? undefined : node.children;
  if (c === undefined || c === null) return '';
  if (Array.isArray(c)) return c.map((x) => (x !== null && typeof x === 'object' ? '' : String(x))).join('');
  return typeof c === 'object' ? '' : String(c);
};
/** First node with `cls` whose rendered text contains `needle`. */
const byText = (root, cls, needle) => byClass(root, cls).find((n) => textOf(n).includes(needle));
/** Every className present in a rendered tree — for readable failures. */
function allClasses(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out;
  if (Array.isArray(node)) { for (const item of node) allClasses(item, out); return out; }
  if (node.props !== undefined && typeof node.props.className === 'string') out.push(node.props.className);
  if (node.children !== undefined) allClasses(node.children, out);
  return out;
}
const texts = (node) => JSON.stringify(node);
const click = (node) => node.props.onClick({ target: node, currentTarget: node, preventDefault() {}, key: 'Enter' });
const settle = () => new Promise((resolve) => { setTimeout(resolve, 0); });
const lastRpc = () => rpc[rpc.length - 1];
const dismiss = async () => {
  const cancel = byText(render(), 'mf-bw-btn', 'browser.cancel');
  assert(cancel !== undefined, 'a cancel button is offered');
  click(cancel);
  await settle();
};

// ---- 1. closed by default ------------------------------------------------
assert(render() === null, 'the modal renders nothing until opened');

// ---- 2. no native picker -> the browser opens at home -------------------
assert(decorations.length === 1 && decorations[0].ui.kind === 'popupSelect', 'the popup decoration registered');
await openAdd();
assert(lastRpc().endpoint === 'multiFolder/browse' && lastRpc().args.path === '', 'an empty path starts at home');
{
  const root = render();
  assert(root !== null, 'the browser opened instead of erroring');
  assert(byClass(root, 'mf-bw-row').length === 1,
    'one child directory row renders; classes present: ' + JSON.stringify(allClasses(root)));
  assert(texts(root).includes('browser.choose'), 'the primary action is offered');
  assert(texts(root).includes('browser.newFolder'), 'the new-folder action is offered');
}

// ---- 3. drilling into a child, empty level disclosed --------------------
{
  click(byClass(render(), 'mf-bw-row')[0]);
  await settle();
  assert(lastRpc().args.path === HOME + '/docs', 'clicking a row browses into it');
  const deep = render();
  assert(byClass(deep, 'mf-bw-empty').length === 1, 'an empty level says so rather than showing a blank box');
  const crumbs = byClass(deep, 'mf-bw-crumb');
  assert(crumbs.length >= 2, 'home + current crumbs render: ' + crumbs.length);
  assert(textOf(crumbs[crumbs.length - 1]) === 'docs', 'the last crumb is the current segment: ' + textOf(crumbs[crumbs.length - 1]));
  assert(crumbs[crumbs.length - 1].props['aria-current'] === 'true', 'the current crumb is marked and inert');
}

// ---- 4. a crumb click walks back up -------------------------------------
{
  const homeCrumb = byText(render(), 'mf-bw-crumb', 'browser.home');
  click(homeCrumb);
  await settle();
  assert(lastRpc().args.path === HOME, 'a crumb click re-lists that level');
}

// ---- 5. new folder: blank refused, then created and entered ------------
{
  const btn = () => byText(render(), 'mf-bw-btn', 'browser.newFolder');
  byClass(render(), 'mf-bw-input')[0].props.onChange({ currentTarget: { value: '   ' } });
  click(btn());
  await settle();
  assert(texts(render()).includes('browser.noName'), 'a blank name is refused with a message');
  assert(rpc[rpc.length - 1].endpoint !== 'multiFolder/makeDir', 'a blank name never reaches makeDir');

  byClass(render(), 'mf-bw-input')[0].props.onChange({ currentTarget: { value: 'notes' } });
  click(btn());
  await settle();
  const made = rpc.find((c) => c.endpoint === 'multiFolder/makeDir');
  assert(made !== undefined && made.args.name === 'notes' && made.args.parent === HOME, 'makeDir gets a single segment');
  assert(lastRpc().endpoint === 'multiFolder/browse' && lastRpc().args.path === HOME + '/notes',
    'after creating, the browser enters the new folder');
}

// ---- 6. truncation is disclosed ----------------------------------------
{
  tree[HOME] = () => level(HOME, null, [{ name: 'docs', path: HOME + '/docs', hidden: false }], true);
  click(byText(render(), 'mf-bw-crumb', 'browser.home'));
  await settle();
  assert(texts(render()).includes('browser.truncated'), 'a capped level tells the user');
  tree[HOME] = () => level(HOME, null, [{ name: 'docs', path: HOME + '/docs', hidden: false }]);
}

// ---- 7. choosing the current level adds it and closes ------------------
{
  click(byText(render(), 'mf-bw-crumb', 'browser.home'));
  await settle();
  const addsBefore = rpc.filter((c) => c.endpoint === 'multiFolder/add').length;
  click(byClass(render(), 'mf-bw-primary')[0]);
  await settle();
  const adds = rpc.filter((c) => c.endpoint === 'multiFolder/add');
  assert(adds.length === addsBefore + 1, 'choosing a directory commits one add');
  assert(adds[adds.length - 1].args.path === HOME && adds[adds.length - 1].args.workspace === WS,
    'the add carries the browsed path and the workspace: ' + JSON.stringify(adds[adds.length - 1].args));
  assert(render() === null, 'a successful add closes the modal');
}

// ---- 8. a failed add keeps the browser open with the error inline ------
{
  failNextAdd = true;
  await openAdd();
  assert(render() !== null, 'the browser opened');
  click(byClass(render(), 'mf-bw-primary')[0]);
  await settle();
  assert(render() !== null, 'a failed add does NOT swallow the browser');
  const errs = byClass(render(), 'mf-bw-err');
  assert(errs.length === 1 && texts(errs[0]).includes('absolute path'), 'the failure shows inside the browser: ' + texts(errs[0]));
  await dismiss();
  assert(render() === null, 'cancel closes the modal');
}

// ---- 9. a failed first listing surfaces inline, invents nothing --------
{
  failNextBrowse = true;
  await decorations[0].ui.onSelect({ id: '__add__' }, { sessionId: 'blank' });
  await settle();
  assert(render() !== null, 'a failed listing still shows the browser');
  assert(byClass(render(), 'mf-bw-err').length === 1, 'the browse error is shown inline');
  assert(byClass(render(), 'mf-bw-row').length === 0, 'no rows are invented');
  await dismiss();
}

// ---- 10. the native picker wins when the shell can answer --------------
{
  let pickerUsed = 0;
  services.uiWorkspace = { async pickDirectory() { pickerUsed += 1; return 'D:/picked/native'; } };
  const before = rpc.length;
  await decorations[0].ui.onSelect({ id: '__add__' }, { sessionId: 'blank' });
  await settle();
  assert(pickerUsed === 1, 'the native picker is preferred when available');
  const added = rpc.slice(before).find((c) => c.endpoint === 'multiFolder/add');
  assert(added !== undefined && added.args.path === 'D:/picked/native', 'the native pick commits through the same channel');
  assert(rpc.slice(before).every((c) => c.endpoint !== 'multiFolder/browse'), 'the owned browser is not consulted');
  assert(render() === null, 'the owned browser stays closed when the picker answered');
}

// ---- 11. a picker that refuses degrades instead of erroring -----------
{
  services.uiWorkspace = { async pickDirectory() { throw new Error('directory-picker/unavailable'); } };
  await decorations[0].ui.onSelect({ id: '__add__' }, { sessionId: 'blank' });
  await settle();
  assert(render() !== null, 'a refused picker falls back to the owned browser');
  assert(byClass(render(), 'mf-bw-row').length >= 1, 'the fallback browser is usable');
  await dismiss();
  delete services.uiWorkspace;
}

// ---- 12. styles: injected once, theme tokens only ---------------------
{
  assert(styleTags.length === 1, 'the browser stylesheet is injected exactly once: ' + styleTags.length);
  const css = styleTags.map((tag) => tag.textContent).join('\n');
  assert(css.includes('--dsw-alias-'), 'the browser styles use official design tokens');
  // Any theme token counts as themed — the shell also ships --dsw-radius-*,
  // --dsw-elevation-*, --dsw-menu-*, --dsw-mask-*, --dsw-static-* and --ds-*.
  // Strip nested var() calls so a fallback like rgba(...) is not mistaken for
  // a hard-coded colour.
  const unthemed = css.replace(/\bvar\((--[A-Za-z0-9-]+)([^()]|\([^()]*\))*\)/g, 'VAR');
  assert(!/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(unthemed),
    'no raw color sits outside a theme fallback: ' + JSON.stringify((unthemed.match(/#[0-9a-fA-F]{3,8}|\w+\(/g) || []).slice(0, 5)));
}

// ---- 13. the volume list: reachable, labelled, and not committable -----
{
  // Seed a second volume under home, whose parent is the synthetic list, so the
  // client can be walked there purely by clicking: home -> D:/ -> Up.
  tree['this-pc/'] = () => ({
    path: 'this-pc/', parent: null, home: HOME, drives: true, truncated: false,
    entries: [
      { name: 'C:', path: 'C:/', hidden: false, drive: true },
      { name: 'D:', path: 'D:/', hidden: false, drive: true },
    ],
  });
  tree['D:/'] = () => level('D:/', 'this-pc/', [{ name: 'tools', path: 'D:/tools', hidden: false }]);
  // The browser opens at an EMPTY path, which the host resolves to home: both
  // keys must agree or the seeded volumes never appear.
  const homeWithVolumes = () => level(HOME, null, homeEntries().concat([{ name: 'D:', path: 'D:/', hidden: false }]));
  tree[''] = homeWithVolumes;
  tree[HOME] = homeWithVolumes;

  const spec = services.commandUi.decorations[0].ui;
  await spec.onSelect({ id: '__add__' }, { sessionId: 'blank' });
  await settle();
  const opened = render();
  assert(byClass(opened, 'mf-bw-row').length === 2, 'home now shows docs and the second volume: ' + JSON.stringify(allClasses(opened)));
  click(byClass(opened, 'mf-bw-row')[1]);           // into D:/
  await settle();
  const driveLevel = render();
  assert(lastRpc().args.path === 'D:/', 'a volume row browses to its drive root');
  assert(byClass(driveLevel, 'mf-bw-up').length === 1, 'a drive root still offers Up (to the volume list)');
  click(byClass(driveLevel, 'mf-bw-up')[0]);
  await settle();

  const root = render();
  assert(lastRpc().args.path === 'this-pc/', 'Up from a drive root asks for the volume list');
  assert(byClass(root, 'mf-bw-row').length === 2, 'every volume renders as its own row');
  assert(byClass(root, 'mf-bw-crumb').length === 1, 'exactly one crumb renders for the synthetic level');
  assert(textOf(byClass(root, 'mf-bw-crumb')[0]) === 'browser.pc', 'the crumb reads as a label, not the raw marker');
  const choose = byText(root, 'mf-bw-primary', 'browser.choose');
  assert(choose.props.disabled === true, 'the volume list cannot be committed as a directory');
  assert(byText(root, 'mf-bw-btn', 'browser.newFolder').props.disabled === true, 'no folder creation inside the volume list');
  const glyphs = findAll(byClass(root, 'mf-bw-row')[0], (n) => n.props.className.split(/\s+/).includes('mf-bw-glyph'));
  assert(glyphs.length === 1 && glyphs[0].props.className.includes('mf-bw-drive'), 'volume rows use the drive glyph');
  await dismiss();

  // Positive control: an ordinary folder row uses the folder glyph instead.
  await spec.onSelect({ id: '__add__' }, { sessionId: 'blank' });
  await settle();
  const folderGlyphs = findAll(byClass(render(), 'mf-bw-row')[0], (n) => n.props.className.split(/\s+/).includes('mf-bw-glyph'));
  assert(folderGlyphs.length === 1 && folderGlyphs[0].props.className.includes('mf-bw-folder'),
    'folder rows use the folder glyph: ' + JSON.stringify(folderGlyphs.map((g) => g.props.className)));
  assert(!JSON.stringify(folderGlyphs).includes('\u29c9'), 'the text placeholder glyph is gone');
  await dismiss();
}

// ---- 14. a drive root's crumb is ONE fully qualified level --------------
{
  // The mock must be able to answer the level BELOW a drive root: `D:/` lists a
  // `tools` row in section 13, but the level itself was never seeded.
  tree['D:/tools'] = () => level('D:/tools', 'D:/', []);
  const spec = services.commandUi.decorations[0].ui;
  await spec.onSelect({ id: '__add__' }, { sessionId: 'blank' });
  await settle();
  // home still carries the seeded second volume as the second row.
  click(byClass(render(), 'mf-bw-row')[1]);          // into D:/
  await settle();
  const driveAgain = render();
  const driveCrumbs = byClass(driveAgain, 'mf-bw-crumb');
  assert(driveCrumbs.length === 1, 'a drive root renders exactly one crumb: ' + JSON.stringify(driveCrumbs.map(textOf)));
  assert(textOf(driveCrumbs[0]) === 'D:', 'the drive crumb is labelled D:: ' + JSON.stringify(textOf(driveCrumbs[0])));
  assert(byClass(driveAgain, 'mf-bw-sep').length === 0, 'no separator splits the drive root path apart');

  click(byClass(driveAgain, 'mf-bw-row')[0]);        // into D:/tools
  await settle();
  await settle();
  const below = render();
  assert(lastRpc().args.path === 'D:/tools', 'a folder under a drive root browses: ' + JSON.stringify(lastRpc().args.path));
  const driveCrumb = byClass(below, 'mf-bw-crumb')[0];
  assert(textOf(driveCrumb) === 'D:', 'the crumb below a drive root reads D:: ' + JSON.stringify(textOf(driveCrumb)));
  assert(
    driveCrumb.props['aria-current'] !== 'true',
    'the drive crumb is only inert while current: '
      + JSON.stringify(byClass(below, 'mf-bw-crumb').map((c) => ({ l: textOf(c), cur: c.props['aria-current'] })))
      + ' rpc=' + JSON.stringify(lastRpc().args.path),
  );
  click(driveCrumb);
  await settle();
  assert(
    lastRpc().args.path === 'D:/',
    'clicking the drive crumb asks for the fully qualified root, not the drive-relative D:: ' + JSON.stringify(lastRpc().args.path),
  );
  await dismiss();
}

// ---- 15. the busy label belongs to the CREATING action only ------------
{
  const spec = services.commandUi.decorations[0].ui;
  await spec.onSelect({ id: '__add__' }, { sessionId: 'blank' });
  await settle();
  const label = () => {
    const root = render();
    if (byText(root, 'mf-bw-btn', 'browser.creating') !== undefined) return 'browser.creating';
    if (byText(root, 'mf-bw-btn', 'browser.newFolder') !== undefined) return 'browser.newFolder';
    return 'missing';
  };
  assert(label() === 'browser.newFolder', 'an idle browser labels the action New folder: ' + label());

  // (a) NAVIGATING is busy but is not creating — the shipped bug announced
  //     "Creating…" here, and the same for committing a directory.
  let releaseBrowse = null;
  rpcGate = new Promise((resolve) => { releaseBrowse = resolve; });
  gatedEndpoint = 'multiFolder/browse';
  click(byClass(render(), 'mf-bw-row')[0]);
  await settle();
  assert(label() === 'browser.newFolder', 'navigating a level must not claim to be creating: ' + label());
  assert(byText(render(), 'mf-bw-primary', 'browser.choose').props.disabled === true, 'choosing stays disabled while navigating');
  gatedEndpoint = null;
  rpcGate = null;
  releaseBrowse();
  await settle();
  await settle();

  // (b) CREATING is the one state that says so.
  byClass(render(), 'mf-bw-input')[0].props.onChange({ currentTarget: { value: 'fresh' } });
  let releaseCreate = null;
  rpcGate = new Promise((resolve) => { releaseCreate = resolve; });
  gatedEndpoint = 'multiFolder/makeDir';
  click(byText(render(), 'mf-bw-btn', 'browser.newFolder'));
  await settle();
  assert(label() === 'browser.creating', 'an in-flight folder creation is the one "Creating…": ' + label());
  gatedEndpoint = null;
  rpcGate = null;
  releaseCreate();
  await settle();
  await settle();
  assert(label() === 'browser.newFolder', 'the label returns to New folder when creation settles: ' + label());
  await dismiss();
}

console.log('browser: all assertions passed');
