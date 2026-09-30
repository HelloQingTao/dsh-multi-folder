/**
 * Host-half smoke test: import the real plugin module, apply it against a mock
 * ctx, and assert the apply body registers its contributions without throwing.
 * Also exercises the sessionless `multiFolder/*` remote service (list / add /
 * set / remove) end to end through the provided plain-object service.
 * Does not require the DSH runtime. Run: node test/smoke-host.mjs
 */
import { name, inject, apply } from '../lib/index.js';
import { join } from 'node:path';
import os from 'node:os';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';

const listeners = new Map(); // eventName -> [fn]
const sections = [];
const commandsRegistered = [];
const typertContributions = [];
const provided = new Map(); // serviceName -> value
const fileStore = new Map(); // absolute path -> text
const dirStore = new Map(); // absolute dir path -> FsDirEntry[]
const fsReads = []; // every readText target, to observe cache behavior
const configDir = join(process.env.DSH_HOME || join(os.homedir(), '.dsh'), 'storages', 'multi-folder');

const fsMock = {
  async resolve(path) {
    return { fakePath: String(path) };
  },
  processPath(target) {
    return String(target && target.fakePath !== undefined ? target.fakePath : target);
  },
  async stat(target) {
    const key = String(target && target.fakePath !== undefined ? target.fakePath : target);
    if (!fileStore.has(key)) return undefined; // absent, per the fs contract
    // Any content change moves the version, like dev:ino:size:mtime would.
    return { type: 'file', version: 'v1:' + fileStore.get(key) };
  },
  async readText(target) {
    const key = String(target && target.fakePath !== undefined ? target.fakePath : target);
    fsReads.push(key);
    if (fileStore.has(key)) return fileStore.get(key);
    throw new Error('no such file');
  },
  async writeText(target, content, expected, signal, policy) {
    const key = String(target && target.fakePath !== undefined ? target.fakePath : target);
    fileStore.set(key, String(content));
    return { operation: 'create', before: null, after: String(content), policy };
  },
  async listDir(target) {
    const key = String(target && target.fakePath !== undefined ? target.fakePath : target);
    const entries = dirStore.get(key);
    if (entries === undefined) throw new Error('not a directory');
    return entries;
  },
};

const mockCtx = {
  fs: fsMock,
  sandboxPolicy: {
    resolve() { return { mode: 'workspace-write', workspaceRoot: 'D:\\Projects\\node\\DSH-multi-folder' }; },
  },
  systemPrompt: {
    section(section) { sections.push(section); return () => {}; },
  },
  get(name) { return undefined; }, // shell / shellEnv all absent
  provide(name, value) {
    provided.set(name, value);
    return () => {};
  },
  inject(names, callback) {
    if (names.includes('typert')) {
      return callback({
        typert: {
          register(contribution) {
            typertContributions.push(contribution);
            return () => {};
          },
        },
      });
    }
    return () => {}; // commands never appears
  },
  on(event, fn) {
    const list = listeners.get(event) ?? [];
    list.push(fn);
    listeners.set(event, list);
    return () => {};
  },
};

apply(mockCtx);

const assert = (cond, msg) => { if (!cond) throw new Error('FAIL: ' + msg); };

assert(name === 'dsh-multi-folder', 'plugin name');
assert(Array.isArray(inject) && inject.includes('fs') && inject.includes('sandboxPolicy') && inject.includes('systemPrompt'), 'inject list');
assert(sections.length === 1, 'prompt section registered');
assert(sections[0].name === 'multi-folder:secondary-dirs', 'section name');
assert(typeof sections[0].text === 'function', 'section text provider');
assert(sections[0].text({}) === '', 'section provider: empty without agent context');
const ws = 'D:\\Projects\\node\\DSH-multi-folder';
assert(sections[0].text({ agent: { session: { header: { cwd: ws } } } }) === '', 'section provider: empty without configured dirs');
assert(listeners.has('agent/pre-step'), 'pre-step listener');
assert(listeners.has('tools/post-execute'), 'post-execute listener');
assert(listeners.has('tools/execute'), 'tools/execute listener');
assert(listeners.has('agent/created'), 'agent/created listener');
assert(commandsRegistered.length === 0, 'no commands registered without commands service');

// tools/execute pass-through: absent shell and no dirs -> next() result passes through
const nextResult = { isError: false, value: { ok: 1 }, content: [{ type: 'text', text: 'pass' }] };
const executeListener = listeners.get('tools/execute')[0];
await executeListener(
  { name: 'write', arguments: { file_path: 'x.txt', content: 'x' }, agent: null, signal: undefined },
  async () => nextResult,
).then((r) => {
  assert(r === nextResult, 'tools/execute falls back to next() for unknown workspaces');
});

// ------------------------------------------------------------ remote API
assert(typertContributions.length === 1, 'typert contribution registered');
const contribution = typertContributions[0];
assert(contribution.package === 'dsh-multi-folder' && contribution.face === 'host', 'contribution identity');
assert(Array.isArray(contribution.invocations) && contribution.invocations.length === 7, 'seven remote endpoints');
const methods = contribution.invocations.map((d) => d.method).sort().join(',');
assert(methods === 'add,browse,list,listFiles,makeDir,remove,set', 'endpoint method roster');
for (const descriptor of contribution.invocations) {
  assert(descriptor.namespace === 'multiFolder' && descriptor.service === 'multiFolder', 'namespace/service: ' + descriptor.method);
  assert(descriptor.invocation && descriptor.invocation.kind === 'direct', 'direct invocation: ' + descriptor.method);
  assert(descriptor.result && descriptor.result.mode === 'src-json', 'src-json result: ' + descriptor.method);
  for (const parameter of descriptor.parameters) {
    assert(parameter.source === 'json' && parameter.codec.mode === 'src-json', 'src-json parameter: ' + descriptor.method + '/' + parameter.name);
  }
}
const listParams = contribution.invocations.find((d) => d.method === 'list').parameters.map((p) => p.wire);
assert(listParams.join(',') === 'workspace', 'list wire shape');
const setParams = contribution.invocations.find((d) => d.method === 'set').parameters.map((p) => p.wire);
assert(setParams.join(',') === 'workspace,dirs', 'set wire shape');
const listFilesParams = contribution.invocations.find((d) => d.method === 'listFiles').parameters.map((p) => p.wire);
assert(listFilesParams.join(',') === 'workspace,dir,query', 'listFiles wire shape');

const api = provided.get('multiFolder');
assert(api !== undefined, 'multiFolder service provided');
assert(api.typertRemote && api.typertRemote.service === api, 'typertRemote binding points at the service');
assert(api.typertRemote.serviceKey === 'multiFolder' && api.typertRemote.namespace === 'multiFolder', 'typertRemote binding fields');

// Remote flows: list (empty) -> add -> idempotent add -> set -> remove.
const SEC = 'C:\\workspaces\\secondary';
const SEC2 = 'C:\\workspaces\\secondary-2';

const initial = await api.list(ws);
assert(Array.isArray(initial.dirs) && initial.dirs.length === 0, 'remote list starts empty');

const added = await api.add(ws, SEC);
assert(added.changed === true && added.dirs.length === 1 && added.dirs[0] === SEC, 'remote add applies');
const addedAgain = await api.add(ws, SEC);
assert(addedAgain.changed === false && addedAgain.dirs.length === 1, 'remote add is idempotent');

// The remote write must land in the host-owned store through the guarded policy.
const configFile = join(configDir, String(ws).replace(/[^a-z0-9]+/gi, '-').toLowerCase() + '.json');
assert(fileStore.has(configFile), 'config persisted through the shared core');

// Cross-channel coherence: the prompt section reads the same cache the remote wrote.
const sectionText = sections[0].text({ agent: { session: { header: { cwd: ws } } } });
assert(sectionText.includes(SEC), 'prompt section sees remote-configured dirs');

const setOut = await api.set(ws, [SEC2, SEC2, ws]); // dedupe + primary-workspace exclusion
assert(setOut.changed === true && setOut.dirs.length === 1 && setOut.dirs[0] === SEC2, 'remote set sanitizes');

const removed = await api.remove(ws, SEC2);
assert(removed.changed === true && removed.dirs.length === 0, 'remote remove clears');
const afterRemove = sections[0].text({ agent: { session: { header: { cwd: ws } } } });
assert(afterRemove === '', 'prompt section empty again after removal');

// ------------------------------------------------- cache coherence (0.3.0)
// Reads are served from the cache while the config file still reports the
// version they were read at, so repeated lists do not touch the file...
await api.add(ws, SEC);
const readsBeforeWarm = fsReads.length;
await api.list(ws); await api.list(ws); await api.list(ws);
assert(fsReads.length === readsBeforeWarm, 'unchanged config is served from the cache (no re-read)');
// ...and an EXTERNAL change (another window / hand edit) is picked up at once.
const configFileKey = join(configDir, String(ws).replace(/[^a-z0-9]+/gi, '-').toLowerCase() + '.json');
fileStore.set(configFileKey, JSON.stringify([SEC, 'C:\\workspaces\\external']))
const seenExternal = await api.list(ws);
assert(seenExternal.dirs.includes('C:\\workspaces\\external'), 'a config edited out-of-process is seen on the next read');
assert(fsReads.length === readsBeforeWarm + 1, 'the version change forced exactly one re-read');
// Duplicate spellings on disk collapse to one entry.
fileStore.set(configFileKey, JSON.stringify([SEC, SEC + '\\', 'c:\\WorkSpaces\\Secondary']))
const deduped = await api.list(ws);
assert(deduped.dirs.length === 1, 'same directory in different spellings de-duplicates to one entry');
// Adding a repeat is a no-op that reports why.
const repeat = await api.add(ws, SEC);
assert(repeat.changed === false && Array.isArray(repeat.dirs), 'repeat add reports unchanged');
assert(typeof repeat.note === 'string' && repeat.note.length > 0, 'repeat add carries a note');
await api.remove(ws, SEC);

// ------------------------------------------------------- listFiles (0.3.x)
// The endpoint is fenced: `dir` must live inside one of the workspace's
// configured secondary directories, so it can never enumerate arbitrary paths.
const READSEC = 'C:\\workspaces\\readsec'
dirStore.set(READSEC, [
  { name: 'alpha.ts', type: 'file' },
  { name: 'pkg', type: 'directory' },
  { name: 'notes.md', type: 'file' },
]);
await api.set(ws, [READSEC]);
const all = await api.listFiles(ws, READSEC, '');
assert(Array.isArray(all) && all.length === 3, 'listFiles lists direct children for an empty query');
assert(all.every((c) => c.path.startsWith(READSEC.replace(/\\/g, '/') + '/')), 'listFiles returns slash-normalized absolute paths');
const dirRow = all.filter((c) => c.path.endsWith('/pkg'))[0];
assert(dirRow !== undefined && dirRow.kind === 'directory', 'listFiles keeps directory kind');
assert(all.filter((c) => c.kind === 'file').length === 2, 'listFiles keeps file kind');
// Directories sort first so drilling is discoverable (matches the shipped kindRank).
assert(all[0].kind === 'directory' && all[0].path.endsWith('/pkg'), 'listFiles sorts directories before files');
const filtered = await api.listFiles(ws, READSEC, 'ALP');
assert(filtered.length === 1 && filtered[0].path.endsWith('alpha.ts'), 'listFiles query matches the name case-insensitively');
const trailing = await api.listFiles(ws, READSEC, 'pkg/alp');
assert(trailing.length === 1 && trailing[0].path.endsWith('alpha.ts'), 'listFiles matches the last segment of a drilled query');
await api.listFiles(ws, 'C:\\definitely\\not\\a\\directory', '').then(
  (r) => { assert(Array.isArray(r) && r.length === 0, 'listFiles on an unreadable dir returns []'); },
  () => { throw new Error('FAIL: listFiles should not reject for a missing directory'); },
);
assert((await api.listFiles(ws, '', 'x')).length === 0, 'listFiles ignores an empty dir');
// FENCE: a directory outside every configured secondary root returns nothing,
// even though the fs could read it. This is the security-relevant case.
const OUTSIDE = 'C:\\Windows\\System32';
dirStore.set(OUTSIDE, [{ name: 'secret.txt', type: 'file' }]);
assert((await api.listFiles(ws, OUTSIDE, '')).length === 0, 'listFiles refuses a path outside the configured secondary directories');
// A subdirectory of a configured root stays reachable (the drill chain).
dirStore.set(READSEC + '/pkg/', [{ name: 'deep.ts', type: 'file' }]);
const drilled = await api.listFiles(ws, READSEC + '/pkg/', '');
assert(drilled.length === 1 && drilled[0].path.endsWith('deep.ts'), 'listFiles reaches subdirectories of a configured root');
assert(drilled[0].path.indexOf('//') < 0, 'listFiles never emits doubled separators for a trailing-slash dir');
await api.remove(ws, READSEC);

// ------------------------------------------------- browse (the owned browser)
dirStore.set('C:\\levels', [
  { name: 'Beta', type: 'directory' },
  { name: 'alpha', type: 'directory' },
  { name: '.hidden', type: 'directory' },
  { name: 'afile.ts', type: 'file' },
]);
const level = await api.browse('C:\\levels');
assert(level.path === 'C:/levels', 'browse canonicalizes the level path to slashes: ' + level.path);
// The parent of a level under a drive root must KEEP the trailing slash:
// 'C:' alone is drive-relative, not absolute, and feeding it back to browse is
// exactly what used to fail with "requires a fully qualified path".
assert(level.parent === 'C:/', 'browse reports a fully qualified parent: ' + level.parent);
// Walking up to the drive root itself must work, and must hand back the volume
// list as its parent (a drive root has no parent in the tree, so this is the
// only click path to another drive).
dirStore.set('C:/', [{ name: 'Users', type: 'directory' }, { name: 'proj', type: 'directory' }]);
const driveRoot = await api.browse('C:/');
assert(driveRoot.path === 'C:/', 'browse accepts a drive root: ' + driveRoot.path);
assert(driveRoot.entries.length === 2, 'drive root lists its children');
assert(driveRoot.parent === 'this-pc/', 'drive root walks up to the volume list: ' + driveRoot.parent);
assert(driveRoot.entries.every((e) => e.path.indexOf('//') < 0), 'no doubled separators under a drive root');
// The volume list only exists on Windows; anything else refuses cleanly.
if (process.platform === 'win32') {
  const drives = await api.browse('this-pc/');
  assert(drives.drives === true, 'the volume list is flagged non-selectable');
  assert(Array.isArray(drives.entries) && drives.entries.length >= 1, 'drives enumerable on this machine: ' + JSON.stringify(drives.entries.map((d) => d.name)));
  assert(drives.entries.every((d) => d.drive === true && /^[A-Z]:\/$/.test(d.path)), 'drive entries carry a canonical root path');
  assert(drives.parent === null, 'the volume list has no parent above it');
} else {
  await api.browse('this-pc/').then(
    () => { throw new Error('FAIL: the volume list should not exist off Windows'); },
    () => { /* expected rejection */ },
  );
}
// POSIX root handling (platform-independent via the fence-free path logic).
// The mock resolves by raw string, so seed the trailing-slash spelling too;
// the real fs.resolve canonicalizes before listDir is reached.
dirStore.set('C:/levels/', [
  { name: 'Beta', type: 'directory' },
  { name: 'alpha', type: 'directory' },
  { name: '.hidden', type: 'directory' },
  { name: 'afile.ts', type: 'file' },
]);
assert((await api.browse('C:/levels/')).path === 'C:/levels', 'a trailing slash on the request is tolerated');
assert(level.home === os.homedir().replace(/\\/g, '/'), 'browse carries the home directory');
assert(level.entries.length === 3, 'browse lists directories only (files dropped): ' + JSON.stringify(level.entries.map((e) => e.name)));
// A level the `fs` seam CANNOT list must still browse. The seam's `listDir`
// probes every child (realpath + stat) and fails the WHOLE level when one child
// is unprobeable — every Windows volume root is that case (`System Volume
// Information` EPERM, `pagefile.sys`/`hiberfil.sys` EBUSY) — which is exactly
// why `C:/` could never be listed and "This PC" stayed unreachable. The
// fallback lists through node:fs and drops only the unreadable children.
const fallbackRoot = await mkdtemp(join(os.tmpdir(), 'multi-folder-browse-'));
await mkdir(join(fallbackRoot, 'alpha'));
await mkdir(join(fallbackRoot, 'beta'));
await writeFile(join(fallbackRoot, 'note.txt'), 'x');
const fallback = await api.browse(fallbackRoot);
assert(
  fallback.entries.map((e) => e.name).join(',') === 'alpha,beta',
  'an unlistable seam level falls back to node:fs, directories only: ' + JSON.stringify(fallback.entries.map((e) => e.name)),
);
assert(
  fallback.path === fallbackRoot.replace(/\\/g, '/'),
  'fallback level keeps the canonical path: ' + fallback.path,
);
// localeCompare ordering is locale-dependent (and the browser shows Chinese
// directory names), so assert "sorted, not insertion order" rather than a
// fixed permutation.
const names = level.entries.map((e) => e.name);
assert(names.join(',') !== 'Beta,alpha,.hidden', 'browse sorts instead of returning insertion order');
assert(
  names.every((n, i) => i === 0 || names[i - 1].localeCompare(n) <= 0),
  'browse entries are ordered by name: ' + names.join(','),
);
assert(level.entries.find((e) => e.name === '.hidden').hidden === true, 'browse flags hidden entries for the client to style');
assert(level.entries.find((e) => e.name === 'alpha').hidden === false, 'visible entries are not flagged');
assert(level.truncated === false, 'browse reports cap state');
// The mock resolves by raw path string, so seed the real home directory too.
dirStore.set(os.homedir(), [{ name: 'seeded', type: 'directory' }]);
const fromHome = await api.browse('');
assert(fromHome.path === os.homedir().replace(/\\/g, '/'), 'an empty browse path starts at home');
assert(fromHome.entries.length === 1 && fromHome.entries[0].name === 'seeded', 'home listing returns an entries array');
await api.browse('relative/path').then(
  () => { throw new Error('FAIL: browse should require a fully qualified path'); },
  (e) => { assert(String(e.message).includes('fully qualified'), 'browse rejects a relative path'); },
);
dirStore.delete('C:\\missing');
await api.browse('C:\\missing').then(
  () => { throw new Error('FAIL: browse should reject an unreadable directory'); },
  (e) => { assert(String(e.message).includes('not a readable directory'), 'browse reports an unreadable directory'); },
);

// makeDir runs against a real temporary directory (the fs seam has no create).
const tmpRoot = await mkdtemp(join(os.tmpdir(), 'mf-browse-'));
const made = await api.makeDir(tmpRoot, 'created-by-test');
assert(made.path.replace(/\\/g, '/').endsWith('/created-by-test'), 'makeDir returns the created path');
await api.makeDir(tmpRoot, 'created-by-test').then(
  () => { throw new Error('FAIL: makeDir should reject an existing name'); },
  (e) => { assert(String(e.message).includes('already exists'), 'makeDir surfaces EEXIST as a clear error (proves the directory was created)'); },
);
for (const [badParent, badName, label] of [
  ['relative/parent', 'x', 'a relative parent'],
  [tmpRoot, 'a/b', 'a nested name'],
  [tmpRoot, '..', 'a traversal name'],
  [tmpRoot, '  ', 'a blank name'],
]) {
  await api.makeDir(badParent, badName).then(
    () => { throw new Error('FAIL: makeDir should reject ' + label); },
    (e) => { assert(/fully qualified|single path segment/.test(String(e.message)), 'makeDir rejects ' + label); },
  );
}

// Error surface: business failures reject with a prefixed message.
await api.add(ws, 'relative\\path').then(
  () => { throw new Error('FAIL: remote add should reject relative paths'); },
  (e) => { assert(String(e.message).startsWith('multi-folder: add requires an absolute path'), 'remote error prefix'); },
);
await api.list(undefined).then(
  () => { throw new Error('FAIL: remote list should require a workspace'); },
  (e) => { assert(String(e.message).includes('workspace is required'), 'remote workspace requirement'); },
);

console.log('smoke-host: all assertions passed');
