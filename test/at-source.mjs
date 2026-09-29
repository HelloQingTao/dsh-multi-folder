/**
 * @-source behavior: query resolution (alias + absolute drill), Tab drill
 * outcome, breadcrumb header, and degradation. The source object is captured
 * from the real bundle by letting ctx.inject fire against a mock inputTriggers,
 * so this exercises the shipped code path rather than a copy of it.
 * Run: node test/at-source.mjs
 */
import { readFileSync } from 'node:fs';

let captured = null;
globalThis.window = { __ModuleLoader__: { load(record) { captured = record; } }, addEventListener() {} };
globalThis.document = { body: {}, querySelector() { return null; } };
(0, eval)(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'));

const fail = (msg) => { console.error('FAIL:', msg); process.exit(1); };
const assert = (cond, msg) => { if (!cond) fail(msg); };
assert(captured && typeof captured.factory === 'function', 'bundle captured');

const reactShim = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
  useEffect: (fn) => { fn(); return undefined; },
};
const moduleExport = captured.factory((spec) => {
  if (spec === 'react') return reactShim;
  throw new Error('unexpected require: ' + spec);
});

const MAIN = 'D:/proj/main';
const SEC = 'D:/proj/secondary';
const SPACED = 'D:/proj/my docs';

// RPC mock: answers multiFolder/list and records every listFiles call.
const listFilesCalls = [];
const fsTree = {
  [SEC]: [
    { path: SEC + '/src', kind: 'directory' },
    { path: SEC + '/readme.md', kind: 'file' },
  ],
  [SEC + '/src/']: [{ path: SEC + '/src/app.ts', kind: 'file' }],
  [SPACED]: [{ path: SPACED + '/notes.md', kind: 'file' }],
};
const connection = {
  rpc: {
    async call(channel, endpoint, payload) {
      if (endpoint === 'multiFolder/list') {
        return { ok: true, value: { workspace: payload.args.workspace, dirs: [SEC, SPACED] } };
      }
      if (endpoint === 'multiFolder/listFiles') {
        listFilesCalls.push(payload.args);
        return { ok: true, value: fsTree[payload.args.dir] ?? [] };
      }
      return { ok: false, error: { message: 'unexpected endpoint ' + endpoint } };
    },
  },
};

const sessions = {
  list: {
    getSnapshot: () => ({ byId: { s1: { cwd: MAIN, blank: false } }, current: 's1' }),
    subscribe: () => () => {},
  },
};
const services = {
  locale: { register: () => () => {}, bind: () => (key) => key },
  sessions,
  workspaces: { list: { getSnapshot: () => ({ items: [] }), subscribe: () => () => {} } },
  connection,
  remote: { commands: { execute: async () => ({ ok: true, value: { result: { kind: 'success', text: '' } } }) } },
  slots: { inject: (n, cb) => { const d = cb(); return () => { if (typeof d === 'function') d(); }; }, register: () => () => {} },
  inputTriggers: { registerSource(src) { this.sources.push(src); return () => {}; }, sources: [] },
  commandUi: { decorate: () => () => {}, decorations: [] },
  uiWorkspace: { pickDirectory: async () => null },
};
const ctx = {
  ...Object.fromEntries(Object.entries(services).filter(([name]) => moduleExport.inject.includes(name))),
  get: (name) => services[name],
  effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {}; },
  inject: (deps, callback) => {
    if (deps.every((d) => services[d] !== undefined)) callback({ get: (name) => services[name], effect: ctx.effect });
    return Promise.resolve();
  },
  on: () => () => {},
};
moduleExport.apply(ctx);

const source = services.inputTriggers.sources.find((s) => s.name === 'multi-folder');
assert(source !== undefined, 'the @ source registered through ctx.inject');
assert(source.trigger === '@', 'the @ source uses the @ trigger');

const candidates = (query) => source.candidates({ sessionId: 's1' }, { query, signal: undefined });

// ---- 1. empty query lists every configured secondary root ----------------
{
  listFilesCalls.length = 0;
  const items = await candidates('');
  assert(listFilesCalls.length === 2, 'empty query enumerates both secondary directories');
  assert(listFilesCalls.every((c) => c.workspace === MAIN), 'listFiles carries the workspace (fence argument)');
  assert(items.some((i) => i.name === 'src/') && items.some((i) => i.name === 'readme.md'), 'children surface as items');
  const dirItem = items.find((i) => i.name === 'src/');
  assert(dirItem.drill === true, 'a directory row is drillable (Tab descends)');
  const fileItem = items.find((i) => i.name === 'readme.md');
  assert(fileItem.drill === undefined, 'a file row is not drillable');
}

// ---- 2. alias form: @<secondary-name>/<rest> ------------------------------
{
  listFilesCalls.length = 0;
  await candidates('secondary/src/');
  assert(listFilesCalls.length === 1, 'alias query enumerates only the matched secondary directory');
  assert(listFilesCalls[0].dir === SEC + '/src/', 'alias + rest resolves to the nested directory: ' + listFilesCalls[0].dir);
  assert(listFilesCalls[0].query === '', 'a trailing slash means no name filter');
  const items = await candidates('secondary/src/');
  assert(items.some((i) => i.name === 'app.ts'), 'the nested level lists');
}

// ---- 3. absolute form: what a drill inserts keeps working ----------------
{
  listFilesCalls.length = 0;
  await candidates(SEC + '/pkg/alp');
  assert(listFilesCalls.length === 1, 'absolute query enumerates exactly one directory');
  assert(listFilesCalls[0].dir === SEC + '/pkg/', 'absolute query splits into dir: ' + listFilesCalls[0].dir);
  assert(listFilesCalls[0].query === 'alp', 'and the partial name filter');
}

// ---- 4. no name match falls back to filtering every root -----------------
{
  listFilesCalls.length = 0;
  await candidates('readme');
  assert(listFilesCalls.length === 2, 'a bare name query still searches every secondary root');
}

// ---- 5. Tab drill inserts the directory and keeps the menu open ----------
{
  const items = await candidates('');
  const dirItem = items.find((i) => i.name === 'src/');
  const drilled = source.onPick({ candidate: dirItem, action: 'drill' });
  assert(drilled !== null && drilled.continue === true, 'drilling keeps the menu open');
  assert(drilled.text === '@' + SEC + '/src/', 'drill inserts the directory with a trailing slash: ' + drilled.text);
  assert(drilled.insert === undefined, 'drill does not commit a chip');
  const committed = source.onPick({ candidate: dirItem, action: 'pick' });
  assert(committed.insert !== undefined && committed.insert.ref === '@' + SEC + '/src/', 'Enter commits a chip');
  assert(committed.insert.appearance === 'folder', 'a directory chip keeps the folder glyph');
  const fileItem = items.find((i) => i.name === 'readme.md');
  assert(source.onPick({ candidate: fileItem, action: 'pick' }).insert.ref === '@' + SEC + '/readme.md', 'file mention');
}

// ---- 6. spaced paths are quoted, and stay OPEN while drilling ------------
{
  const items = await candidates('');
  const spaced = items.find((i) => i.name === 'notes.md');
  assert(spaced !== undefined, 'the spaced-path root contributed its file');
  const spacedDir = (await candidates('my docs/')).find((i) => i.name === 'notes.md');
  assert(spacedDir !== undefined, 'alias with a space resolves');
  const commit = source.onPick({ candidate: spaced, action: 'pick' });
  assert(commit.insert.ref === '@"' + SPACED + '/notes.md"', 'a spaced mention is quoted and closed: ' + commit.insert.ref);
  const spacedDirItem = (await candidates('')).find((i) => i.name === 'docs/' || i.name === 'my docs/');
  const drilledSpaced = source.onPick(
    { candidate: { name: 'x/', value: JSON.stringify({ kind: 'directory', path: SPACED, name: 'x' }) }, action: 'drill' },
  );
  assert(drilledSpaced.text === '@"' + SPACED + '/', 'a spaced directory keeps the quote OPEN while drilling: ' + drilledSpaced.text);
  void spacedDirItem;
}

// ---- 7. breadcrumb header while drilled ----------------------------------
{
  await candidates('');
  const crumbs = source.header({ sessionId: 's1' }, { query: SEC + '/src/', drilled: true, quoted: false });
  assert(Array.isArray(crumbs) && crumbs.length === 2, 'header publishes crumbs while drilled: ' + JSON.stringify(crumbs));
  assert(crumbs[0].label === 'secondary', 'the first crumb is the secondary directory name');
  assert(crumbs[1].current === true, 'the deepest crumb is marked current');
  const crumbValue = JSON.parse(crumbs[0].value);
  assert(crumbValue.mention === '@' + SEC + '/', 'a crumb carries an open, drillable mention');
  assert(source.header({ sessionId: 's1' }, { query: '', drilled: false }) === undefined, 'no header when not drilled');
  // A crumb pick routes through onPick as a drill and must keep the menu open.
  const crumbItem = { name: 'secondary', value: crumbs[0].value };
  const back = source.onPick({ candidate: crumbItem, action: 'drill' });
  assert(back.continue === true && back.text === '@' + SEC + '/', 'crumb navigation returns a level');
}

// ---- 8. degradation: no session, and a failing RPC ----------------------
{
  assert((await source.candidates({}, { query: '' })).length === 0, 'no session yields no candidates');
  assert((await source.candidates({ sessionId: 's1' }, { query: '', signal: { throwIfAborted() { throw new Error('aborted'); } } })).length === 0,
    'an aborted signal degrades to an empty group instead of rejecting');
}

console.log('at-source: all assertions passed');
