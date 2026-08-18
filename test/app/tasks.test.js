//@ts-check
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { readFileSync } from 'node:fs';

import { createApp, createTaskEffect } from '@jarenjs/app';
import { JarenValidator } from '@jarenjs/validate';

/** Synchronous render scheduler for deterministic assertions. */
const sync = (flush) => flush();

/** Drain the microtask queue (no wall-clock timers anywhere here). */
async function drain() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

/**
 * The app document under test IS the worked example in
 * packages/app/docs/TASKS.md — extracted from the doc's single ```json
 * block, so the documentation cannot drift from the engine.
 */
function tasksDoc() {
  const md = readFileSync(
    new URL('../../packages/app/docs/TASKS.md', import.meta.url), 'utf8');
  const blocks = [...md.matchAll(/```json\n([\s\S]*?)```/g)];
  assert.strictEqual(blocks.length, 1,
    'TASKS.md carries exactly one json block: the complete runnable example');
  return JSON.parse(blocks[0][1]);
}

/**
 * A manually settled `run`: every invocation parks in `calls` with its
 * props, signal and resolvers.
 */
function deferredRunner() {
  const calls = [];
  const run = (props, signal) => new Promise((resolve, reject) => {
    calls.push({ props, signal, resolve, reject });
  });
  return { calls, run };
}

/** Mount the TASKS.md document headless, recording every completion dispatch. */
function mountTasks(options = {}) {
  const { calls, run } = deferredRunner();
  const taskEffect = createTaskEffect(run);
  const dispatches = [];
  const transitions = [];
  let tick = null;
  const app = createApp(tasksDoc(), {
    schedule: sync,
    effects: {
      http: (props, dispatch) => taskEffect(props, (name, payload) => {
        dispatches.push([name, payload]);
        dispatch(name, payload);
      }),
    },
    subs: {
      every: (props, dispatch) => {
        tick = () => dispatch(props.action);
        return () => { tick = null; };
      },
    },
    ...options,
  });
  app.subscribe((state) => transitions.push(state));
  return { app, calls, dispatches, transitions, tick: () => tick?.() };
}

describe('the async-task convention (docs/TASKS.md, run verbatim)', function () {
  it('the worked example validates against the shipped app meta-schema unchanged', function () {
    const load = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
    const validate = new JarenValidator()
      .addSchema(load('../../packages/json/schemas/jaren-query.schema.json'))
      .addSchema(load('../../packages/json/schemas/jaren-jslt.schema.json'))
      .compile(load('../../packages/app/schemas/jaren-app.schema.json'));
    assert.strictEqual(validate(tasksDoc()), true,
      'the convention is ordinary state/actions/effects — no schema extension');
  });

  it('happy path: start → resolve → done dispatched with {id, result} → status flipped', async function () {
    const { app, calls, dispatches } = mountTasks();
    app.dispatch('loadList');
    assert.deepStrictEqual(app.getState().tasks.list,
      { id: 1, status: 'loading', error: null });
    assert.strictEqual(calls[0].props.id, 1,
      'the effect got the NEW id — the pre-transition-$ increment expression');
    calls[0].resolve(['apples', 'pears']);
    await drain();
    assert.deepStrictEqual(dispatches, [['listLoaded', { id: 1, result: ['apples', 'pears'] }]]);
    assert.deepStrictEqual(app.getState().items, ['apples', 'pears']);
    assert.deepStrictEqual(app.getState().tasks.list,
      { id: 1, status: 'done', error: null });
  });

  it('out-of-order staleness: the older response arrives last and is a provable no-op', async function () {
    const { app, calls, dispatches, transitions } = mountTasks();
    app.dispatch('loadList');   // id 1
    app.dispatch('loadList');   // id 2
    assert.strictEqual(app.getState().tasks.list.id, 2);
    calls[1].resolve(['fresh']);
    await drain();
    assert.deepStrictEqual(app.getState().items, ['fresh']);
    const seen = transitions.length;

    calls[0].resolve(['stale']);   // the aborted request had already resolved
    await drain();
    assert.deepStrictEqual(dispatches[1], ['listLoaded', { id: 1, result: ['stale'] }],
      'the stale completion WAS dispatched — cancellation is not the guarantee');
    assert.deepStrictEqual(app.getState().items, ['fresh'],
      'the id guard produced the empty sequence: state keeps id 2\'s result');
    assert.strictEqual(app.getState().tasks.list.status, 'done');
    assert.strictEqual(transitions.length, seen,
      'no transition fired for the stale response — subscribers never woke');
  });

  it('supersede aborts the in-flight signal; an AbortError rejection dispatches nothing', async function () {
    const { app, calls, dispatches, transitions } = mountTasks();
    app.dispatch('loadList');
    assert.strictEqual(calls[0].signal.aborted, false);
    app.dispatch('loadList');
    assert.strictEqual(calls[0].signal.aborted, true,
      'starting a task aborts the slot\'s predecessor');
    const seen = transitions.length;
    calls[0].reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    await drain();
    assert.deepStrictEqual(dispatches, [], 'a superseded task is dead by design');
    assert.strictEqual(transitions.length, seen);
    assert.strictEqual(app.getState().tasks.list.status, 'loading');
  });

  it('a NON-abort rejection after supersede still dispatches, and the id guard rejects it', async function () {
    const { app, calls, dispatches } = mountTasks();
    app.dispatch('loadList');   // id 1
    app.dispatch('loadList');   // id 2
    calls[1].resolve(['fresh']);
    await drain();
    calls[0].reject(new Error('connection reset'));   // belt and suspenders
    await drain();
    assert.deepStrictEqual(dispatches[1],
      ['listLoaded', { id: 1, error: 'connection reset' }],
      'the failure was dispatched — only the state guard stops it');
    assert.deepStrictEqual(app.getState().items, ['fresh']);
    assert.strictEqual(app.getState().tasks.list.status, 'done',
      'the stale failure could not flip the status either');
  });

  it('rejections route through "done" with an {id, error} string when no "fail" is given', async function () {
    const { app, calls } = mountTasks();
    app.dispatch('loadList');
    calls[0].reject(new Error('boom'));
    await drain();
    assert.deepStrictEqual(app.getState().tasks.list,
      { id: 1, status: 'error', error: 'boom' });
    assert.strictEqual(typeof app.getState().tasks.list.error, 'string',
      'never an Error object — JSON only crosses the boundary');
  });

  it('rejections route through "fail" when given; a non-Error reason stringifies', async function () {
    const { app, calls } = mountTasks();
    app.dispatch('openDetail', 7);
    assert.strictEqual(calls[0].props.url, '/api/items/7');
    calls[0].reject('wire down');
    await drain();
    assert.deepStrictEqual(app.getState().tasks.detail,
      { id: 1, status: 'error', error: 'wire down' });
    assert.strictEqual(app.getState().detail, null);
  });

  it('slots are isolated: list and detail tasks never abort each other', async function () {
    const { app, calls } = mountTasks();
    app.dispatch('loadList');
    app.dispatch('openDetail', 3);
    assert.strictEqual(calls[0].signal.aborted, false);
    assert.strictEqual(calls[1].signal.aborted, false);
    calls[1].resolve({ id: 3, name: 'Pepper' });
    calls[0].resolve(['a']);
    await drain();
    assert.deepStrictEqual(app.getState().detail, { id: 3, name: 'Pepper' });
    assert.deepStrictEqual(app.getState().items, ['a']);
  });

  it('a settled task releases its slot; a superseded settle leaves the successor armed', async function () {
    const { app, calls } = mountTasks();
    app.dispatch('loadList');
    calls[0].resolve(['a']);
    await drain();
    app.dispatch('loadList');
    assert.strictEqual(calls[0].signal.aborted, false,
      'a completed task\'s controller was cleared — nothing left to abort');

    app.dispatch('loadList');           // supersedes call 1
    calls[1].reject(Object.assign(new Error('x'), { name: 'AbortError' }));
    await drain();
    app.dispatch('loadList');           // must abort call 2, whose slot is still live
    assert.strictEqual(calls[2].signal.aborted, true,
      'the superseded task\'s late settle did not evict its successor\'s controller');
  });

  it('missing id/done in the effect props is a TypeError, surfaced as JA2007', function () {
    const errors = [];
    const doc = {
      state: {},
      view: [{ match: '$', body: ['p', {}, 'x'] }],
      actions: {
        noId: { effects: [{ run: 'http', with: { done: 'noId' } }] },
        noDone: { effects: [{ run: 'http', with: { id: 1 } }] },
      },
    };
    const app = createApp(doc, {
      schedule: sync,
      effects: { http: createTaskEffect(() => Promise.resolve(null)) },
      onError: (err) => errors.push(err),
    });
    app.dispatch('noId');
    app.dispatch('noDone');
    assert.strictEqual(errors.length, 2);
    for (const err of errors) {
      assert.strictEqual(/** @type {any} */ (err).code, 'JA2007');
      assert.ok(err.cause instanceof TypeError);
    }
  });

  it('capability proof: polling + two overlapping loads, the older response cannot win', async function () {
    const { app, calls, transitions, tick } = mountTasks();
    app.dispatch('startPolling');
    tick();   // poll 1 → id 1
    tick();   // poll 2 → id 2, aborts poll 1
    assert.strictEqual(calls.length, 2);
    assert.strictEqual(calls[0].signal.aborted, true);

    calls[1].resolve(['newer']);
    await drain();
    const seen = transitions.length;
    calls[0].resolve(['older']);   // arrives last
    await drain();
    assert.deepStrictEqual(app.getState().items, ['newer'],
      'documented vocabulary only: the older response provably cannot overwrite');
    assert.strictEqual(transitions.length, seen);

    app.dispatch('stopPolling');
    tick();
    assert.strictEqual(calls.length, 2, 'the subscription cleanup stopped the ticker');
  });
});

describe('createTaskEffect({ projectError }) — the structured error door', function () {
  function dispatcher() {
    const dispatched = [];
    return { dispatched, dispatch: (name, payload) => dispatched.push([name, payload]) };
  }
  /** An HTTP-shaped rejection: what a fetch wrapper throws for a non-2xx. */
  function httpError(status, body) {
    const err = new Error(`HTTP ${status}`);
    /** @type {any} */ (err).status = status;
    /** @type {any} */ (err).body = body;
    return err;
  }
  const projectHttp = (err, props) => (
    typeof err === 'object' && err !== null && 'status' in err
      ? { status: /** @type {any} */ (err).status, code: /** @type {any} */ (err).body?.code ?? null,
        message: /** @type {any} */ (err).message, operation: props.operation ?? null }
      : undefined);

  it('a projected rejection dispatches the projector\'s JSON as `error`', async function () {
    const { calls, run } = deferredRunner();
    const task = createTaskEffect(run, { projectError: projectHttp });
    const { dispatched, dispatch } = dispatcher();
    task({ id: 1, done: 'done', operation: 'catalog.load' }, dispatch);
    calls[0].reject(httpError(409, { code: 'REVISION_CONFLICT' }));
    await drain();
    assert.deepStrictEqual(dispatched, [['done', {
      id: 1,
      error: { status: 409, code: 'REVISION_CONFLICT', message: 'HTTP 409', operation: 'catalog.load' },
    }]]);
  });

  it('the projector receives the effect props verbatim and routes through `fail`', async function () {
    const { calls, run } = deferredRunner();
    let seenProps = null;
    const task = createTaskEffect(run, {
      projectError: (err, props) => { seenProps = props; return { kind: 'x' }; },
    });
    const { dispatched, dispatch } = dispatcher();
    const props = { id: 3, done: 'done', fail: 'failed', url: '/api/x', slot: 'detail' };
    task(props, dispatch);
    calls[0].reject(new Error('boom'));
    await drain();
    assert.strictEqual(seenProps, props);
    assert.deepStrictEqual(dispatched, [['failed', { id: 3, error: { kind: 'x' } }]]);
  });

  it('an AbortError never reaches the projector and still dispatches nothing', async function () {
    const { calls, run } = deferredRunner();
    let projections = 0;
    const task = createTaskEffect(run, { projectError: () => { projections++; return { no: 1 }; } });
    const { dispatched, dispatch } = dispatcher();
    task({ id: 1, done: 'done' }, dispatch);
    task({ id: 2, done: 'done' }, dispatch); // switch: supersedes #1
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    calls[0].reject(abort);
    calls[1].resolve({ ok: true });
    await drain();
    assert.strictEqual(projections, 0);
    assert.deepStrictEqual(dispatched, [['done', { id: 2, result: { ok: true } }]]);
  });

  it('a projector that declines (undefined) falls back to the string projection', async function () {
    const { calls, run } = deferredRunner();
    const task = createTaskEffect(run, { projectError: projectHttp });
    const { dispatched, dispatch } = dispatcher();
    task({ id: 1, done: 'done' }, dispatch);
    calls[0].reject(new TypeError('network down')); // no `status`: projector declines
    await drain();
    assert.deepStrictEqual(dispatched, [['done', { id: 1, error: 'network down' }]]);
  });

  it('a projector that throws falls back to the string projection — settlement stays total', async function () {
    const { calls, run } = deferredRunner();
    const task = createTaskEffect(run, { projectError: () => { throw new Error('projector bug'); } });
    const { dispatched, dispatch } = dispatcher();
    task({ id: 1, done: 'done' }, dispatch);
    calls[0].reject(new Error('boom'));
    await drain();
    assert.deepStrictEqual(dispatched, [['done', { id: 1, error: 'boom' }]]);
  });

  it('a projection that is not JSON falls back — no host object crosses into state', async function () {
    const cases = [
      ['the Error itself', (err) => err],
      ['an Error nested in details', (err) => ({ status: 500, cause: err })],
      ['a function', () => () => 1],
      ['a Response-like class instance', () => new (class Response {})()],
      ['a cycle', () => { const o = { a: 1 }; o.self = o; return o; }],
      ['a non-finite number', () => ({ retryAfter: Infinity })],
    ];
    for (const [label, projectError] of cases) {
      const { calls, run } = deferredRunner();
      const task = createTaskEffect(run, { projectError });
      const { dispatched, dispatch } = dispatcher();
      task({ id: 1, done: 'done' }, dispatch);
      calls[0].reject(new Error('boom'));
      await drain();
      assert.deepStrictEqual(dispatched, [['done', { id: 1, error: 'boom' }]], label);
    }
  });

  it('projected JSON lands in app state through the ordinary completion action', async function () {
    // The TASKS.md document as shipped: `error` is stored verbatim by the
    // completion action, so with a projector the state carries the object.
    const { calls, run } = deferredRunner();
    const taskEffect = createTaskEffect(run, { projectError: projectHttp });
    const app = createApp(tasksDoc(), {
      schedule: sync,
      effects: { http: (props, dispatch) => taskEffect(props, dispatch) },
      subs: { every: () => () => {} },
    });
    app.dispatch('loadList');
    calls[0].reject(httpError(404, { code: 'NOT_FOUND' }));
    await drain();
    assert.deepStrictEqual(app.getState().tasks.list, {
      id: 1, status: 'error',
      error: { status: 404, code: 'NOT_FOUND', message: 'HTTP 404', operation: null },
    });
    app.destroy();
  });

  it('a non-function projectError is a host programming error', function () {
    assert.throws(() => createTaskEffect(() => 1, { projectError: /** @type {any} */ ('nope') }),
      /"projectError" must be a function/);
  });
});
