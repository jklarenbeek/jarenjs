//@ts-check
/**
 * @file An awaiting action (APP-FORMAT §3.3): one action document that
 * commits its start transition, awaits a registered effect, and continues
 * with the effect's result — or its coded failure — in a transaction of
 * its own. The identity of an await is its slot: a newer await on the
 * slot supersedes the one in flight, which is aborted and never applies
 * its result, whatever order the settlements arrive in.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createApp, compileActions } from '@jarenjs/app';

/** Synchronous render scheduler for deterministic assertions. */
const sync = (flush) => flush();

/** Drain the microtask queue (no wall-clock timers anywhere here). */
async function drain() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

/** An awaited effect every call of which parks with its resolvers. */
function deferredEffect() {
  /** @type {Array<{ props: any, signal: AbortSignal, resolve: (value: any) => void, reject: (reason: any) => void }>} */
  const calls = [];
  /** @type {(props: any, dispatch: any, context: { signal: AbortSignal }) => Promise<any>} */
  const effect = (props, dispatch, context) => new Promise((resolve, reject) => {
    calls.push({ props, signal: context.signal, resolve, reject });
  });
  return { calls, effect };
}

const SEARCH = {
  state: { status: 'idle', query: '', users: [], error: null },
  view: [],
  actions: {
    search: { $await: {
      start: { patch: [
        { op: 'replace', path: '/status', value: 'loading' },
        { op: 'replace', path: '/query', value: '$payload' }] },
      run: 'fetchJson',
      with: { url: { $concat: ['/api/users?q=', '$.query'] } },
      then: { patch: [
        { op: 'replace', path: '/status', value: 'done' },
        { op: 'replace', path: '/users', value: '$result' }] },
      catch: { patch: [
        { op: 'replace', path: '/status', value: 'error' },
        { op: 'replace', path: '/error', value: '$error' }] },
    } },
  },
};

/** The search document with its `$await` members replaced or removed. */
function searchWith(members) {
  const doc = structuredClone(SEARCH);
  const awaiting = doc.actions.search.$await;
  for (const [key, value] of Object.entries(members)) {
    if (value === undefined) delete awaiting[key];
    else awaiting[key] = value;
  }
  return doc;
}

/** Mount headless with a deferred `fetchJson`, collecting errors, records and states. */
function mount(doc = SEARCH, options = {}) {
  const { calls, effect } = deferredEffect();
  /** @type {any[]} */
  const errors = [];
  /** @type {any[]} */
  const records = [];
  /** @type {any[]} */
  const states = [];
  const app = createApp(doc, {
    schedule: sync,
    effects: { fetchJson: effect },
    onError: (error) => errors.push(error),
    ...options,
  });
  app.observe((tx) => records.push([tx.action, tx.source, tx.status, tx.errorCode, tx.scheduledEffects]));
  app.subscribe((state) => states.push(state.status));
  return { app, calls, errors, records, states };
}

describe('an awaiting action compiles once, with its continuations', () => {
  it('compiles the $await form and keeps every other action on the query path', () => {
    const compiled = compileActions({ plain: { patch: [] }, search: SEARCH.actions.search }, {});
    assert.equal(typeof compiled.get('plain').first, 'function');
    assert.equal(compiled.get('search').first, undefined);
    assert.equal(compiled.get('search').run, 'fetchJson');
    assert.equal(compiled.get('search').slot, null);
  });

  for (const [label, entry, docPath, reason] of [
    ['a sibling member', { $await: { run: 'f' }, patch: [] }, '/actions/a/patch',
      'an awaiting action is the single member {"$await": ...}; found \'patch\' beside it'],
    ['a value that is not an object', { $await: 'f' }, '/actions/a/$await',
      '"$await" must be an object naming at least the effect it runs'],
    ['no run', { $await: { then: {} } }, '/actions/a/$await/run',
      '"run" must name a registered effect (a non-empty string)'],
    ['an empty slot', { $await: { run: 'f', slot: '' } }, '/actions/a/$await/slot',
      '"slot" must be a non-empty string'],
    ['an unknown member', { $await: { run: 'f', thne: {} } }, '/actions/a/$await/thne',
      'unknown member \'thne\' — "$await" takes start, run, with, slot, then and catch'],
  ]) {
    it(`refuses ${label} as JA0004 at its location`, () => {
      assert.throws(() => createApp({ view: [], actions: { a: entry } }),
        (/** @type {any} */ error) => error.code === 'JA0004' && error.docPath === docPath
          && error.reason === `action 'a': ${reason}`);
    });
  }

  for (const [member, doc, variable] of [
    ['then', { run: 'f', then: { patch: [{ op: 'replace', path: '/x', value: '$reslt' }] } }, 'reslt'],
    ['catch', { run: 'f', catch: '$result' }, 'result'],
    ['with', { run: 'f', with: '$result' }, 'result'],
  ]) {
    it(`closes the variables of "${member}": a $${variable} is a compile error, not a runtime one`, () => {
      assert.throws(() => createApp({ view: [], actions: { a: { $await: doc } } }),
        (/** @type {any} */ error) => error.code === 'JA0004'
          && error.docPath === `/actions/a/$await/${member}`
          && error.cause.message.includes(variable));
    });
  }

  it('locates a failing action whose name holds "/" or "~" by an escaped pointer', () => {
    for (const [name, docPath] of [['list/start', '/actions/list~1start'], ['a~b', '/actions/a~0b']]) {
      assert.throws(() => createApp({ view: [], actions: { [name]: { $bogus: 1 } } }),
        (/** @type {any} */ error) => error.code === 'JA0004' && error.docPath === docPath);
      assert.throws(() => createApp({ view: [], actions: { [name]: { $await: { run: '' } } } }),
        (/** @type {any} */ error) => error.code === 'JA0004' && error.docPath === `${docPath}/$await/run`);
    }
  });
});

describe('no action that compiled before takes the new path', () => {
  it('every action of the website, the task convention and the counter compiles to a query', async () => {
    const { ACTIONS } = await import('../../packages/website/src/app/actions.js');
    const md = fs.readFileSync(new URL('../../packages/app/docs/TASKS.md', import.meta.url), 'utf8');
    const tasks = JSON.parse(/```json\n([\s\S]*?)```/.exec(md)?.[1] ?? 'null');
    for (const actions of [ACTIONS, tasks.actions]) {
      const compiled = compileActions(actions, {});
      assert.equal(compiled.size, Object.keys(actions).length);
      for (const [name, query] of compiled) assert.equal(typeof query.first, 'function', name);
    }
  });
});

describe('the start commits as an ordinary transaction, the continuation is its own', () => {
  it('commits the start, awaits the effect with props read from the started state, continues with $result', async () => {
    const { app, calls, errors, records, states } = mount();
    app.dispatch('search', 'ada');
    assert.deepEqual(app.getState(), { status: 'loading', query: 'ada', users: [], error: null });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].props, { url: '/api/users?q=ada' }, '"with" reads the state the start produced');
    assert.equal(calls[0].signal.aborted, false);
    calls[0].resolve([{ name: 'Ada' }]);
    await drain();
    assert.deepEqual(app.getState(), { status: 'done', query: 'ada', users: [{ name: 'Ada' }], error: null });
    assert.deepEqual(states, ['loading', 'done']);
    assert.deepEqual(records, [
      ['search', 'dispatch', 'applied', null, ['fetchJson']],
      ['search', 'await', 'applied', null, []],
    ]);
    assert.deepEqual(errors, []);
  });

  it('hands the continuation the original $payload and $event, and the transaction context the action name', async () => {
    /** @type {any[]} */
    const contexts = [];
    const doc = searchWith({ then: { patch: [{ op: 'replace', path: '/users', value: ['$payload', '$event', '$result'] }] } });
    const { app, calls } = mount(doc, {
      validateState: (next, context) => { contexts.push([context.action, context.payload, context.changes]); return true; },
    });
    app.dispatch('search', 'ada');
    calls[0].resolve(7);
    await drain();
    assert.deepEqual(app.getState().users, ['ada', null, 7]);
    assert.deepEqual(contexts, [
      [null, null, null],
      ['search', 'ada', ['/status', '/query']],
      ['search', 'ada', ['/users']],
    ]);
  });

  it('runs the awaited effect after the start\'s own effects, in the start\'s transaction', () => {
    /** @type {string[]} */
    const order = [];
    const doc = searchWith({ start: { patch: [], effects: [{ run: 'note', with: 'start effect' }] } });
    const app = createApp(doc, {
      schedule: sync,
      effects: {
        note: (props) => { order.push(props); },
        fetchJson: () => { order.push('awaited effect'); return new Promise(() => {}); },
      },
    });
    app.subscribe(() => order.push('listener'));
    app.dispatch('search', 'ada');
    assert.deepEqual(order, ['start effect', 'awaited effect']);
  });

  it('awaits without a start, and an absent "with" hands the effect null', async () => {
    const { app, calls, records } = mount(searchWith({ start: undefined, with: undefined }));
    app.dispatch('search');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].props, null);
    assert.deepEqual(records, [['search', 'dispatch', 'applied', null, ['fetchJson']]]);
    calls[0].resolve(undefined);
    await drain();
    assert.deepEqual(app.getState().users, null, 'a result of undefined continues as null');
  });

  it('a start that yields the empty sequence awaits nothing', () => {
    const doc = searchWith({ start: { $if: [{ $eq: ['$.status', 'idle'] }, { patch: [{ op: 'replace', path: '/status', value: 'loading' }] }] } });
    const { app, calls, records } = mount(doc);
    app.dispatch('search', 'ada');
    app.dispatch('search', 'adam');
    assert.equal(calls.length, 1, 'the second start yielded nothing: no await, the first stays live');
    assert.equal(calls[0].signal.aborted, false);
    assert.deepEqual(records.map((r) => r[2]), ['applied', 'noop']);
  });

  it('a start that fails or is refused awaits nothing and leaves the slot\'s await live', async () => {
    const doc = searchWith({ start: { patch: [{ op: 'replace', path: '/status', value: '$payload' }] } });
    const { app, calls, errors, records } = mount(doc, {
      validateState: (next) => next.status !== 'refused',
    });
    app.dispatch('search', 'loading');
    app.dispatch('search', 'refused');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].signal.aborted, false);
    assert.deepEqual(errors.map((e) => e.code), ['JA2005']);
    calls[0].resolve([1]);
    await drain();
    assert.deepEqual(app.getState().users, [1]);
    assert.deepEqual(records.map((r) => r.slice(1, 4)), [
      ['dispatch', 'applied', null], ['dispatch', 'rejected', 'JA2005'], ['await', 'applied', null]]);
  });

  it('a "with" that throws fails the start whole: nothing commits, nothing is awaited', () => {
    const doc = searchWith({ with: { $add: ['$.query', 1] } });
    const { app, calls, errors } = mount(doc);
    app.dispatch('search', 'ada');
    assert.deepEqual(app.getState(), SEARCH.state);
    assert.equal(calls.length, 0);
    assert.deepEqual(errors.map((e) => e.code), ['JA2002']);
  });

  it('a setState between start and settlement: the continuation applies to the replaced state', async () => {
    const { app, calls } = mount();
    app.dispatch('search', 'ada');
    app.setState({ status: 'loading', query: 'hydrated', users: [], error: null });
    calls[0].resolve(['x']);
    await drain();
    assert.deepEqual(app.getState(), { status: 'done', query: 'hydrated', users: ['x'], error: null });
  });
});

describe('a superseded await never applies its result', () => {
  it('the newer await on the slot aborts the older; the older\'s late result is dropped', async () => {
    const { app, calls, records, errors } = mount();
    app.dispatch('search', 'ada');
    app.dispatch('search', 'adam');
    assert.equal(calls[0].signal.aborted, true);
    assert.equal(calls[1].signal.aborted, false);
    calls[1].resolve(['Adam']);
    await drain();
    calls[0].resolve(['Ada']);
    await drain();
    assert.deepEqual(app.getState(), { status: 'done', query: 'adam', users: ['Adam'], error: null });
    assert.deepEqual(records.map((r) => r[1]), ['dispatch', 'dispatch', 'await']);
    assert.deepEqual(errors, []);
  });

  it('in the reverse order too: the older settles first and is dropped, the newer applies', async () => {
    const { app, calls, records } = mount();
    app.dispatch('search', 'ada');
    app.dispatch('search', 'adam');
    calls[0].resolve(['Ada']);
    await drain();
    assert.deepEqual(app.getState().users, [], 'the superseded result did not land');
    assert.equal(app.getState().status, 'loading');
    calls[1].resolve(['Adam']);
    await drain();
    assert.deepEqual(app.getState().users, ['Adam']);
    assert.deepEqual(records.map((r) => r[1]), ['dispatch', 'dispatch', 'await']);
  });

  it('a superseded await that fails reaches neither catch nor onError', async () => {
    const { app, calls, errors } = mount(searchWith({ catch: undefined }));
    app.dispatch('search', 'ada');
    app.dispatch('search', 'adam');
    calls[0].reject(new Error('HTTP 500'));
    await drain();
    assert.deepEqual(errors, []);
    assert.equal(app.getState().status, 'loading');
    calls[1].resolve([]);
    await drain();
    assert.equal(app.getState().status, 'done');
  });

  it('slots are independent; a shared "slot" supersedes across actions', async () => {
    const doc = structuredClone(SEARCH);
    doc.actions.other = { $await: { run: 'fetchJson', then: { patch: [{ op: 'replace', path: '/error', value: '$result' }] } } };
    doc.actions.clear = { $await: { slot: 'search', run: 'fetchJson', start: { patch: [{ op: 'replace', path: '/status', value: 'idle' }] } } };
    const { app, calls } = mount(doc);
    app.dispatch('search', 'ada');
    app.dispatch('other');
    assert.equal(calls[0].signal.aborted, false, 'a different slot (the action name) leaves it alone');
    app.dispatch('clear');
    assert.equal(calls[0].signal.aborted, true, 'the "search" slot was superseded by "clear"');
    assert.equal(calls[1].signal.aborted, false);
    calls[0].resolve(['Ada']);
    calls[1].resolve('other');
    calls[2].resolve(null);
    await drain();
    assert.deepEqual(app.getState(), { status: 'idle', query: 'ada', users: [], error: 'other' });
  });
});

describe('failures continue through catch with a coded $error', () => {
  it('a rejection: $error is { code: "JA2028", message }', async () => {
    const { app, calls, errors, records } = mount();
    app.dispatch('search', 'ada');
    calls[0].reject(new Error('HTTP 500'));
    await drain();
    assert.deepEqual(app.getState(), { status: 'error', query: 'ada', users: [], error: { code: 'JA2028', message: 'HTTP 500' } });
    assert.deepEqual(errors, []);
    assert.deepEqual(records[1], ['search', 'await', 'applied', null, []]);
  });

  it('an AbortError the runtime did not cause is a failure too', async () => {
    const { app, calls } = mount();
    app.dispatch('search', 'ada');
    const abort = new Error('The operation was aborted.');
    abort.name = 'AbortError';
    calls[0].reject(abort);
    await drain();
    assert.deepEqual(app.getState().error, { code: 'JA2028', message: 'The operation was aborted.' });
  });

  for (const [label, effects, error] of [
    ['an unregistered effect', {}, { code: 'JA2006', message: 'action \'search\' awaited unregistered effect \'fetchJson\'' }],
    ['a synchronous throw', { fetchJson: () => { throw new TypeError('bad url'); } }, { code: 'JA2028', message: 'bad url' }],
    ['a non-JSON result', { fetchJson: async () => new Date(0) }, { code: 'JA2028', message: 'action \'search\' awaited effect \'fetchJson\', which resolved a value JSON cannot carry (a Date)' }],
    ['a thrown non-Error', { fetchJson: () => Promise.reject(404) }, { code: 'JA2028', message: '404' }],
  ]) {
    it(`${label} continues through catch`, async () => {
      const app = createApp(SEARCH, { schedule: sync, effects });
      app.dispatch('search', 'ada');
      await drain();
      assert.deepEqual(app.getState().error, error);
      assert.equal(app.getState().status, 'error');
    });
  }

  it('without catch, the failure is reported through onError with its code and cause', async () => {
    const { app, calls, errors, records } = mount(searchWith({ catch: undefined }));
    app.dispatch('search', 'ada');
    const cause = new Error('HTTP 500');
    calls[0].reject(cause);
    await drain();
    assert.equal(errors.length, 1);
    assert.equal(errors[0].code, 'JA2028');
    assert.equal(errors[0].reason, 'action \'search\' awaited effect \'fetchJson\', which failed: HTTP 500');
    assert.equal(errors[0].docPath, '/actions/search/$await');
    assert.equal(errors[0].cause, cause);
    assert.deepEqual(records[1], ['search', 'await', 'failed', 'JA2028', []]);
    assert.equal(app.getState().status, 'loading');
  });

  it('a registry read that throws is JA2007: through catch, or reported without one', async () => {
    for (const doc of [SEARCH, searchWith({ catch: undefined })]) {
      let armed = false;
      /** @type {any[]} */
      const errors = [];
      const app = createApp(doc, {
        schedule: sync,
        onError: (error) => errors.push(error),
        effects: { get fetchJson() { if (armed) throw new Error('registry offline'); return () => null; } },
      });
      armed = true;
      app.dispatch('search', 'ada');
      await drain();
      const reason = 'effect \'fetchJson\' threw during lookup: registry offline';
      if (doc === SEARCH) {
        assert.deepEqual(app.getState().error, { code: 'JA2007', message: reason });
        assert.deepEqual(errors, []);
      }
      else {
        assert.deepEqual(errors.map((e) => [e.code, e.reason, e.docPath, e.cause.message]),
          [['JA2007', reason, '/actions/search/$await', 'registry offline']]);
      }
    }
  });

  it('a granted-out effect is unregistered for the document (capabilities)', async () => {
    const { app, errors } = mount(searchWith({ catch: undefined }), { capabilities: { effects: [] } });
    app.dispatch('search', 'ada');
    await drain();
    assert.deepEqual(errors.map((e) => [e.code, e.docPath]), [['JA2006', '/actions/search/$await']]);
  });

  it('a continuation that throws is JA2002, and under the rethrowing sink it is raised on its own microtask', async () => {
    const doc = searchWith({ then: { patch: [{ op: 'replace', path: '/users', value: { $add: ['$result', 1] } }] } });
    const raised = [];
    const original = globalThis.queueMicrotask;
    const app = createApp(doc, { schedule: sync, effects: { fetchJson: async () => 'text' } });
    globalThis.queueMicrotask = (task) => { raised.push(task); };
    try {
      app.dispatch('search', 'ada');
      for (let i = 0; i < 8; i++) await Promise.resolve();
    }
    finally {
      globalThis.queueMicrotask = original;
    }
    assert.equal(raised.length, 1);
    assert.throws(raised[0], (/** @type {any} */ error) => error.code === 'JA2002');
    assert.equal(app.getState().status, 'loading');
  });
});

describe('cancellation', () => {
  for (const end of ['destroy', 'stop']) {
    it(`${end}() aborts every await in flight, and a late settlement does nothing`, async () => {
      const { app, calls, errors, records, states } = mount();
      app.dispatch('search', 'ada');
      app[end]();
      assert.equal(calls[0].signal.aborted, true);
      calls[0].resolve(['late']);
      await drain();
      assert.equal(app.getState().status, 'loading');
      assert.deepEqual(states, ['loading']);
      assert.equal(records.length, 1, 'the start alone: the dropped settlement is no transaction');
      assert.deepEqual(errors, []);
    });
  }
});

describe('settled({ awaits: true }) waits for the awaits in flight', () => {
  it('settled() answers while the effect is in flight; awaits: true after its continuation', async () => {
    const { app, calls } = mount();
    app.dispatch('search', 'ada');
    assert.equal((await app.settled()).status, 'loading');
    /** @type {any[]} */
    const seen = [];
    const waiting = app.settled({ awaits: true }).then((state) => seen.push(state.status));
    await drain();
    assert.deepEqual(seen, [], 'the effect has not settled');
    calls[0].resolve(['Ada']);
    await waiting;
    assert.deepEqual(seen, ['done']);
    assert.deepEqual(app.getState().users, ['Ada']);
  });

  it('resolves at once when nothing is in flight, and after a failure continued through catch', async () => {
    const { app, calls } = mount();
    assert.equal((await app.settled({ awaits: true })).status, 'idle');
    app.dispatch('search', 'ada');
    const waiting = app.settled({ awaits: true });
    calls[0].reject(new Error('offline'));
    assert.deepEqual((await waiting).error, { code: 'JA2028', message: 'offline' });
  });

  it('waits past a superseded await for the one its slot holds', async () => {
    const { app, calls } = mount();
    app.dispatch('search', 'a');
    app.dispatch('search', 'ab');
    /** @type {any[]} */
    const seen = [];
    const waiting = app.settled({ awaits: true }).then((state) => seen.push(state.users));
    calls[0].resolve(['dropped']);
    await drain();
    assert.deepEqual(seen, [], 'the superseded settlement ends no wait');
    calls[1].resolve(['kept']);
    await waiting;
    assert.deepEqual(seen, [['kept']]);
  });

  it('waits for an await the continuation\'s transaction started', async () => {
    const { app, calls } = mount();
    let again = true;
    app.subscribe((state) => {
      if (state.status === 'done' && again) {
        again = false;
        app.dispatch('search', 'second');
      }
    });
    app.dispatch('search', 'first');
    /** @type {any[]} */
    const seen = [];
    const waiting = app.settled({ awaits: true }).then((state) => seen.push([state.query, state.status]));
    calls[0].resolve(['one']);
    await drain();
    assert.equal(calls.length, 2, 'the continuation\'s transaction started a second await');
    assert.deepEqual(seen, []);
    calls[1].resolve(['two']);
    await waiting;
    assert.deepEqual(seen, [['second', 'done']]);
  });

  it('stop() answers a waiter with the state then; the late settlement changes nothing', async () => {
    const { app, calls } = mount();
    app.dispatch('search', 'ada');
    const waiting = app.settled({ awaits: true });
    app.stop();
    assert.equal((await waiting).status, 'loading');
    calls[0].resolve(['late']);
    await drain();
    assert.equal(app.getState().status, 'loading');
  });

  it('a signal bounds the wait: its abort rejects with the reason, and the app goes on', async () => {
    const { app, calls } = mount();
    app.dispatch('search', 'ada');
    const controller = new AbortController();
    const waiting = app.settled({ awaits: true, signal: controller.signal });
    const reason = new Error('took too long');
    controller.abort(reason);
    await assert.rejects(waiting, (error) => error === reason);
    const aborted = AbortSignal.abort('already');
    await assert.rejects(app.settled({ signal: aborted }), (error) => error === 'already');
    calls[0].resolve(['Ada']);
    assert.equal((await app.settled({ awaits: true, signal: new AbortController().signal })).status, 'done');
  });

  it('refuses an option of the wrong kind', () => {
    const { app } = mount();
    assert.throws(() => app.settled({ awaits: 'yes' }), { name: 'TypeError', message: 'app.settled: options.awaits is a boolean' });
    assert.throws(() => app.settled({ signal: {} }), { name: 'TypeError', message: 'app.settled: options.signal is an AbortSignal' });
    assert.throws(() => app.settled({ await: true }),
      { name: 'TypeError', message: "app.settled: does not take 'await' — it takes frame, awaits and signal" });
  });
});

describe('the README example runs as written', () => {
  it('a model-authored action awaiting a fetch effect: loading, superseded, done', async () => {
    const md = fs.readFileSync(new URL('../../packages/app/README.md', import.meta.url), 'utf8');
    const start = md.indexOf('## Awaiting an effect in the document');
    assert.ok(start >= 0, 'the README section exists');
    const fence = /```javascript\n([\s\S]*?)```/.exec(md.slice(start));
    assert.ok(fence !== null);
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
    const dir = path.join(root, 'node_modules', '.cache-app-await');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'readme.mjs');
    fs.writeFileSync(file, `${fence[1]}\nexport { app };\n`);

    /** @type {Array<{ url: string, signal: AbortSignal, resolve: (value: any) => void }>} */
    const requests = [];
    /** @type {string[]} */
    const logged = [];
    const originalFetch = globalThis.fetch;
    // the README logs through the console; capture what it prints
    const terminal = globalThis.console;
    const originalLog = terminal.log;
    globalThis.fetch = /** @type {any} */ ((url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const abort = new Error('The operation was aborted.');
        abort.name = 'AbortError';
        reject(abort);
      });
      requests.push({ url, signal: init.signal, resolve: (body) => resolve({ json: async () => body }) });
    }));
    terminal.log = (...args) => { logged.push(JSON.stringify(args)); };
    try {
      const { app } = await import(`${pathToFileURL(file).href}?${Date.now()}`);
      assert.deepEqual(requests.map((r) => [r.url, r.signal.aborted]),
        [['/api/users?q=ada', true], ['/api/users?q=adam', false]]);
      requests[1].resolve([{ name: 'Adam' }]);
      await drain();
      requests[0].resolve([{ name: 'Ada' }]);
      await drain();
      assert.deepEqual(logged, [
        '["loading",[]]',
        '["loading",[]]',
        '["done",[{"name":"Adam"}]]',
      ]);
      assert.deepEqual(app.getState().users, [{ name: 'Adam' }]);
    }
    finally {
      globalThis.fetch = originalFetch;
      terminal.log = originalLog;
    }
  });
});
