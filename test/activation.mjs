/**
 * Activation gate: exports.inject is a HARD activation condition, so it may
 * only list services every web profile composes. A profile that does not
 * compose an optional service must still activate the plugin (otherwise the
 * whole entry goes "pending (waiting for service: X)" and even the
 * /multi-folder command and the sandbox interception disappear — the 0.3.0
 * regression this test pins).
 *
 * Two scenarios:
 *  A. minimal shell  — none of uiWorkspace / inputTriggers / commandUi exist:
 *                      apply() completes, the always-on seats register, and the
 *                      optional features are skipped without throwing.
 *  B. full shell     — all three exist: the @ source registers and commandUi
 *                      gets decorated.
 * Run: node test/activation.mjs
 */
import { readFileSync } from 'node:fs';

let captured = null;
globalThis.window = {
  __ModuleLoader__: { load(record) { captured = record; } },
  addEventListener() {},
};
globalThis.document = {
  body: {},
  querySelector() { return null; },
};

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
(0, eval)(source);

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

// ---- the contract under test: inject lists only always-composed services ----
const OPTIONAL = ['uiWorkspace', 'inputTriggers', 'commandUi'];
assert(Array.isArray(moduleExport.inject), 'inject is an array');
for (const name of OPTIONAL) {
  assert(
    !moduleExport.inject.includes(name),
    `exports.inject must NOT hard-require optional service "${name}" (it would leave the entry pending on shells that do not compose it)`,
  );
}
for (const required of ['remote', 'slots', 'connection', 'sessions', 'locale']) {
  assert(moduleExport.inject.includes(required), `inject keeps the always-composed service "${required}"`);
}

// ---- shared mock plumbing ------------------------------------------------
const locale = {
  register: () => () => {},
  bind: () => (key) => key,
};
const makeCtx = ({ withOptional }) => {
  const registrations = [];
  const effects = [];
  const injections = [];
  const services = {
    locale,
    sessions: { list: { getSnapshot: () => ({ byId: {}, current: undefined }), subscribe: () => () => {} } },
    workspaces: { list: { getSnapshot: () => ({ items: [] }), subscribe: () => () => {} } },
    connection: { rpc: { call: async () => ({ ok: true, value: { workspace: null, dirs: [] } }) } },
    remote: { commands: { execute: async () => ({ ok: true, value: { result: { kind: 'success', text: '' } } }) } },
    slots: {
      inject: (slotName, callback) => {
        // Slots are treated as declared: the callback runs immediately.
        const dispose = callback();
        return () => { if (typeof dispose === 'function') dispose(); };
      },
      register: (options, component) => {
        registrations.push({ options, component });
        return () => {};
      },
    },
  };
  if (withOptional) {
    services.uiWorkspace = { pickDirectory: async () => null };
    const inputTriggers = { registerSource: (src) => { inputTriggers.sources.push(src); return () => {}; }, sources: [] };
    const commandUi = { decorate: (deco) => { commandUi.decorations.push(deco); return () => {}; }, decorations: [] };
    services.inputTriggers = inputTriggers;
    services.commandUi = commandUi;
  }
  const ctx = {
    // The real host exposes every service named in exports.inject as a direct
    // context property (that is what the hard gate guarantees); mirror that.
    ...Object.fromEntries(Object.entries(services).filter(([name]) => moduleExport.inject.includes(name))),
    get: (name) => services[name],
    effect: (fn, label) => { const d = fn(); effects.push(label ?? ''); if (typeof d !== 'function') return () => {}; return d; },
    inject: (deps, callback) => {
      injections.push(deps.join('+'));
      const present = deps.every((d) => services[d] !== undefined);
      if (!present) return Object.assign(Promise.resolve(), { dispose: () => {} });
      const scope = {
        get: (name) => services[name],
        effect: ctx.effect,
      };
      const r = callback(scope);
      return Object.assign(Promise.resolve(), { dispose: () => { if (typeof r === 'function') r(); } });
    },
    on: () => () => {},
  };
  return { ctx, services, registrations, effects, injections };
};

// ---- A. minimal shell: no optional services at all ----------------------
{
  const { ctx, registrations, injections } = makeCtx({ withOptional: false });
  let threw = null;
  try { moduleExport.apply(ctx); } catch (error) { threw = error; }
  assert(threw === null, `apply() must not throw on a shell without the optional services: ${threw && threw.message}`);
  assert(
    registrations.some((r) => r.options.name === 'shell.overlay' && r.options.id === 'multi-folder'),
    'the always-on overlay panel still registers on a minimal shell',
  );
  // The optional features ARE requested — but through ctx.inject, whose
  // callback simply never fires when the shell does not compose the service.
  assert(
    injections.includes('commandUi') && injections.includes('inputTriggers'),
    'optional features are requested via ctx.inject (lazy), not exports.inject (hard gate)',
  );
}

// ---- B. full shell: optional services present --------------------------
{
  const { ctx, services, registrations } = makeCtx({ withOptional: true });
  let threw = null;
  try { moduleExport.apply(ctx); } catch (error) { threw = error; }
  assert(threw === null, `apply() must not throw on a full shell: ${threw && threw.message}`);
  assert(
    registrations.some((r) => r.options.name === 'shell.overlay'),
    'overlay panel registers on a full shell',
  );
  // Optional features attach through ctx.inject; give the microtask a chance.
  await new Promise((resolve) => { setTimeout(resolve, 0); });
  assert(
    services.inputTriggers.sources.some((s) => s.name === 'multi-folder' && s.trigger === '@'),
    'the @ source registers when inputTriggers is composed',
  );
  assert(
    services.commandUi.decorations.some((d) => d.name === 'multi-folder' && d.ui.kind === 'popupSelect'),
    'the popupSelect decoration registers when commandUi is composed',
  );
}

console.log('activation: all assertions passed');
