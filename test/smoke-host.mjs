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
assert(Array.isArray(contribution.invocations) && contribution.invocations.length === 5, 'five remote endpoints');
const methods = contribution.invocations.map((d) => d.method).sort().join(',');
assert(methods === 'add,list,listFiles,remove,set', 'endpoint method roster');
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
assert(listFilesParams.join(',') === 'dir,query', 'listFiles wire shape');

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

// ------------------------------------------------------- listFiles (0.3.0)
const READSEC = 'C:\\workspaces\\readsec'
dirStore.set(READSEC, [
  { name: 'alpha.ts', type: 'file' },
  { name: 'pkg', type: 'directory' },
  { name: 'notes.md', type: 'file' },
]);
const all = await api.listFiles(READSEC, '');
assert(Array.isArray(all) && all.length === 3, 'listFiles lists direct children for an empty query');
assert(all.every((c) => c.path.startsWith(READSEC.replace(/\\/g, '/') + '/')), 'listFiles returns slash-normalized absolute paths');
const dirRow = all.filter((c) => c.path.endsWith('/pkg'))[0];
assert(dirRow !== undefined && dirRow.kind === 'directory', 'listFiles keeps directory kind');
assert(all.filter((c) => c.kind === 'file').length === 2, 'listFiles keeps file kind');
const filtered = await api.listFiles(READSEC, 'ALP');
assert(filtered.length === 1 && filtered[0].path.endsWith('alpha.ts'), 'listFiles query matches the name case-insensitively');
const trailing = await api.listFiles(READSEC, 'pkg/alp');
assert(trailing.length === 1 && trailing[0].path.endsWith('alpha.ts'), 'listFiles matches the last segment of a drilled query');
await api.listFiles('C:\\definitely\\not\\a\\directory', '').then(
  (r) => { assert(Array.isArray(r) && r.length === 0, 'listFiles on an unreadable dir returns []'); },
  () => { throw new Error('FAIL: listFiles should not reject for a missing directory'); },
);
assert((await api.listFiles('', 'x')).length === 0, 'listFiles ignores an empty dir');

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
