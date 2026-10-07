//@ts-check
/**
 * `createApp` and `createCollectionCoordinator` take closed option sets.
 * A misspelt member used to be dropped in silence — an `onerror` handler
 * never saw a failure, which threw past it instead — and a member of the
 * wrong type was accepted until it misbehaved: `disposeProvider: 'false'`
 * disposed the host's provider, `onChange: 'x'` swallowed every
 * publication, `onError: 'log'` broke the error sink. Each is refused when
 * the object is created, naming the member; valid options, including
 * members passed as `undefined`, behave exactly as before.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as vm from 'node:vm';

import { createApp, createArrayRangeProvider, createCollectionCoordinator } from '@jarenjs/app';

const sync = (/** @type {() => void} */ flush) => flush();
const doc = () => ({
  state: { n: 0 },
  view: [{ match: '$', body: ['p', {}, 'x'] }],
  actions: { inc: { patch: [{ op: 'replace', path: '/n', value: 1 }] } },
});

/** @param {() => unknown} run @param {RegExp} message */
function refuses(run, message) {
  assert.throws(run, (/** @type {any} */ err) => {
    assert.equal(err instanceof TypeError, true, `a TypeError, got ${err?.name}: ${err?.message}`);
    assert.match(err.message, message);
    return true;
  });
}

describe('createApp — a closed option set', function () {
  it('refuses a misspelt member, naming the one it meant', function () {
    refuses(() => createApp(doc(), { onerror: () => {} }),
      /^createApp: unknown option 'onerror' — did you mean 'onError'\?$/);
    refuses(() => createApp(doc(), { maxturns: 5 }), /did you mean 'maxTurns'\?/);
  });

  it('refuses a member of the wrong type', function () {
    refuses(() => createApp(doc(), { onError: /** @type {any} */ ('log') }),
      /^createApp: options\.onError must be a function, got "log"$/);
    refuses(() => createApp(doc(), { schedule: /** @type {any} */ (5) }),
      /^createApp: options\.schedule must be a function, got 5$/);
    refuses(() => createApp(doc(), { afterRender: /** @type {any} */ ({}) }),
      /options\.afterRender must be a function, got an object/);
    refuses(() => createApp(doc(), { validateState: /** @type {any} */ (null) }),
      /options\.validateState must be a function, got null/);
    refuses(() => createApp(doc(), { viewModel: /** @type {any} */ (true) }),
      /options\.viewModel must be a function, got true/);
    refuses(() => createApp(doc(), { capturePayloads: /** @type {any} */ ('yes') }),
      /^createApp: options\.capturePayloads must be a boolean, got "yes"$/);
    refuses(() => createApp(doc(), { safe: /** @type {any} */ ('false') }),
      /options\.safe must be a boolean, got "false"/);
    refuses(() => createApp(doc(), { hydrate: /** @type {any} */ (1) }),
      /options\.hydrate must be a boolean, got 1/);
    refuses(() => createApp(doc(), { capabilities: /** @type {any} */ ('all') }),
      /options\.capabilities must be a plain object, got "all"/);
  });

  it('refuses options that are not a plain object', function () {
    refuses(() => createApp(doc(), /** @type {any} */ (null)),
      /^createApp: options must be a plain object, got null$/);
    refuses(() => createApp(doc(), /** @type {any} */ ([])), /options must be a plain object/);
  });

  it('names what was given in place of a plain object, never "an object"', function () {
    class Grants {}
    const effects = { log: () => {} };
    for (const [capabilities, given] of [
      [new Map([['effects', ['log']]]), 'a Map'],
      [[['effects', ['log']]], 'an array'],
      [new Grants(), 'a Grants'],
      [Object.create({ effects: ['log'] }), 'an object with a custom prototype'],
      [vm.runInNewContext('({ effects: ["log"] })'), 'an object from another realm'],
    ]) {
      refuses(() => createApp(doc(), { effects, capabilities: /** @type {any} */ (capabilities) }),
        new RegExp(`^createApp: options\\.capabilities must be a plain object, got ${given}$`));
    }
    refuses(() => createApp(doc(), /** @type {any} */ (new Map())), /^createApp: options must be a plain object, got a Map$/);
    refuses(() => createApp(doc(), /** @type {any} */ ([])), /^createApp: options must be a plain object, got an array$/);
  });

  it('refuses a registry that is not an object — a factory passed uncalled reads as empty', function () {
    const factory = () => ({ formJsonValue: () => null });
    refuses(() => createApp(doc(), { eventFields: /** @type {any} */ (factory) }),
      /^createApp: options\.eventFields must be an object of extractors by name, got a function$/);
    refuses(() => createApp(doc(), { effects: /** @type {any} */ ('log') }),
      /^createApp: options\.effects must be an object of handlers by name, got "log"$/);
    refuses(() => createApp(doc(), { subs: /** @type {any} */ (1) }), /options\.subs must be an object of handlers by name, got 1/);
    refuses(() => createApp(doc(), { widgets: /** @type {any} */ (true) }),
      /options\.widgets must be an object of widget definitions by name, got true/);
    createApp(doc(), { eventFields: factory(), effects: null, subs: undefined, widgets: {} }).destroy();
  });

  it('refuses a registry that is a list, a Map or Set, or a promise — each reads as empty', function () {
    const log = () => {};
    class Deferred { then(/** @type {(value: unknown) => void} */ resolve) { resolve({ log }); } }
    const pending = (async () => ({ log }))();
    for (const [options, message] of [
      [{ effects: [log] }, /^createApp: options\.effects must be an object of handlers by name, got an array$/],
      [{ effects: new Map([['log', log]]) }, /^createApp: options\.effects must be an object of handlers by name, got a Map$/],
      [{ subs: new Set([log]) }, /^createApp: options\.subs must be an object of handlers by name, got a Set$/],
      [{ effects: pending }, /^createApp: options\.effects must be an object of handlers by name, got a Promise$/],
      [{ eventFields: new Deferred() }, /^createApp: options\.eventFields must be an object of extractors by name, got a thenable$/],
      [{ widgets: [] }, /^createApp: options\.widgets must be an object of widget definitions by name, got an array$/],
    ]) {
      refuses(() => createApp(doc(), /** @type {any} */ (options)), /** @type {RegExp} */ (message));
    }
    // registries read through accessors or proxies, frozen, null-prototype and class-instance
    // ones, and an effect that happens to be named `then`, all still boot
    const ran = [];
    const app = createApp({ state: {}, view: doc().view, actions: { go: { effects: [{ run: 'then' }, { run: 'log' }] } } }, {
      schedule: sync,
      effects: { then: () => ran.push('then'), get log() { return () => ran.push('log'); } },
      subs: Object.freeze(Object.assign(Object.create(null), { tick: () => {} })),
      eventFields: new Proxy({}, {}),
      widgets: new (class Widgets {})(),
    });
    app.dispatch('go');
    assert.deepEqual(ran, ['then', 'log']);
    app.destroy();
  });

  it('refuses a misspelt grant list or granted name, naming the one it meant', function () {
    const effects = { log: () => {} };
    refuses(() => createApp(doc(), { effects, capabilities: { efects: ['log'] } }),
      /^createApp: unknown capabilities member 'efects' — did you mean 'effects'\?$/);
    refuses(() => createApp(doc(), { effects, capabilities: { effects: ['lgo'] } }),
      /^createApp: unknown effects capability 'lgo' — did you mean 'log'\?$/);
    refuses(() => createApp(doc(), { effects, capabilities: { effects: ['missing'] } }),
      /^createApp: unknown effects capability 'missing'$/);
    createApp(doc(), { effects, capabilities: { effects: ['log'], subs: [], widgets: [], eventFields: [] } }).destroy();
  });

  it('accepts every documented member, and members passed as undefined, as before', function () {
    const seen = [];
    const app = createApp(doc(), {
      node: undefined, document: undefined, hydrate: undefined, controlled: undefined,
      safe: false, onUnsafe: undefined, capabilities: undefined, effects: {}, subs: {},
      eventFields: {}, widgets: {}, compileTypeTest: undefined, validateState: () => true,
      viewModel: (state) => state, onError: (/** @type {any} */ error) => seen.push(error.code),
      schedule: sync, afterRender: undefined, maxTurns: 10, maxSubInstances: 4,
      capturePayloads: false,
    });
    app.dispatch('nope');
    app.dispatch('inc');
    assert.deepEqual(seen, ['JA2001'], 'the handler sees the unknown action');
    assert.deepEqual(app.getState(), { n: 1 });
    app.destroy();
    createApp(doc(), { onError: null, schedule: null, afterRender: null, viewModel: null }).destroy();
  });
});

describe('createCollectionCoordinator — a closed option set', function () {
  const rows = Array.from({ length: 100 }, (_, i) => ({ id: 'k' + i, n: i }));
  const provider = () => createArrayRangeProvider(rows);

  it('refuses a misspelt member, naming the one it meant', function () {
    refuses(() => createCollectionCoordinator(provider(), { maxrows: 10 }),
      /^createCollectionCoordinator: unknown option 'maxrows' — did you mean 'maxRows'\?$/);
    refuses(() => createCollectionCoordinator(provider(), { pagerows: 5 }), /did you mean 'pageRows'\?/);
    refuses(() => createCollectionCoordinator(provider(), /** @type {any} */ (new Map())),
      /^createCollectionCoordinator: options must be a plain object, got a Map$/);
    refuses(() => createCollectionCoordinator(provider(), /** @type {any} */ ([])),
      /^createCollectionCoordinator: options must be a plain object, got an array$/);
  });

  it('refuses a member of the wrong type, before it can dispose or swallow anything', async function () {
    const owned = provider();
    refuses(() => createCollectionCoordinator(owned, { disposeProvider: /** @type {any} */ ('false') }),
      /^createCollectionCoordinator: options\.disposeProvider must be a boolean, got "false"$/);
    refuses(() => createCollectionCoordinator(provider(), { onChange: /** @type {any} */ ('x') }),
      /^createCollectionCoordinator: options\.onChange must be a function, got "x"$/);
    refuses(() => createCollectionCoordinator(provider(), { onError: /** @type {any} */ (5) }),
      /options\.onError must be a function, got 5/);
    // the host still owns a provider no coordinator was built over
    const coordinator = createCollectionCoordinator(owned, { disposeProvider: false });
    assert.equal((await coordinator.requestRange({ start: 0, end: 4 })).state, 'ready');
    await coordinator.dispose();
    assert.equal((await createCollectionCoordinator(owned).requestRange({ start: 0, end: 4 })).state, 'ready');
  });

  it('refuses options that are not a plain object', function () {
    refuses(() => createCollectionCoordinator(provider(), /** @type {any} */ (null)),
      /^createCollectionCoordinator: options must be a plain object, got null$/);
  });

  it('keeps the bounds refusals a RangeError, naming the bound at fault', function () {
    /** @param {any} options @param {RegExp} message */
    const outOfRange = (options, message) => assert.throws(() => createCollectionCoordinator(provider(), options),
      (/** @type {any} */ err) => err instanceof RangeError && message.test(err.message));
    outOfRange({ maxPages: 0 }, /^createCollectionCoordinator: options\.maxPages must be a positive safe integer, got 0$/);
    outOfRange({ work: 2.5 }, /^createCollectionCoordinator: options\.work must be a positive safe integer, got 2\.5$/);
    outOfRange({ prefetchPages: 4 },
      /^createCollectionCoordinator: options\.prefetchPages must be a safe integer from 0 below options\.maxPages \(4\), got 4$/);
    outOfRange({ prefetchPages: -1, maxPages: 8 }, /options\.prefetchPages must be a safe integer from 0 below options\.maxPages \(8\), got -1/);
    outOfRange({ pageRows: 300 },
      /^createCollectionCoordinator: options\.pageRows \(300\) must not exceed options\.maxRows \(256\)$/);
  });

  it('keeps the bounds refusals and accepts valid options as before', async function () {
    assert.throws(() => createCollectionCoordinator(provider(), { maxPages: 0 }), RangeError);
    const changes = [];
    const coordinator = createCollectionCoordinator(provider(), {
      pageRows: 8, maxPages: 2, maxRows: 16, onChange: (x) => changes.push(x.state),
      onError: undefined, disposeProvider: true,
    });
    const range = await coordinator.requestRange({ start: 0, end: 8 });
    assert.equal(range.state, 'ready');
    assert.ok(changes.includes('ready'));
    await coordinator.dispose();
  });
});
