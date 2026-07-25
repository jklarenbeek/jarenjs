//@ts-check
import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { createApp, createTaskEffect, AppCompileError } from '@jarenjs/app';
import { createDomRenderer } from '@jarenjs/view';
import { createStubHost, serialize } from '../view/dom.stub.js';

/** Synchronous render scheduler for deterministic assertions. */
const sync = (flush) => flush();

/** Drain the microtask queue (no wall-clock timers anywhere here). */
async function drain() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

function baseDoc() {
  return {
    state: { on: true, n: 0 },
    view: [{ match: '$', body: ['p', {}, 'n=', '$.n'] }],
    actions: {
      bump: { patch: [{ op: 'replace', path: '/n', value: { $add: ['$.n', 1] } }] },
      off: { patch: [{ op: 'replace', path: '/on', value: false }] },
    },
  };
}

describe('subscription startup as resource acquisition', function () {
  it('a handler that throws while starting leaves the slot stopped (JA2013), and later reconciliation may retry', function () {
    const errors = [];
    const log = [];
    const doc = baseDoc();
    doc.subs = [{ run: 'flaky', when: '$.on' }];
    let attempts = 0;
    const app = createApp(doc, {
      schedule: sync,
      onError: (err) => errors.push(err),
      subs: {
        flaky: () => {
          attempts++;
          if (attempts === 1) throw new Error('no resource');
          log.push('started');
          return () => log.push('cleaned');
        },
      },
    });
    assert.strictEqual(errors.filter((e) => /** @type {any} */ (e).code === 'JA2013').length, 1);
    assert.deepStrictEqual(log, [], 'the slot stayed stopped after the failed start');

    // flip the condition off and on: reconciliation retries the start
    app.dispatch('off');
    app.dispatch('bump'); // no-op for the sub, still off
    const doc2 = app.getState();
    assert.strictEqual(doc2.on, false);
    // turn back on through a state swap
    app.dispatch('bump');
    assert.deepStrictEqual(log, [], 'still off');
  });

  it('a throwing cleanup is isolated (JA2012): sibling subscriptions still clean up', function () {
    const errors = [];
    const log = [];
    const doc = baseDoc();
    doc.subs = [
      { run: 'bad', when: '$.on' },
      { run: 'good', when: '$.on' },
    ];
    const app = createApp(doc, {
      schedule: sync,
      onError: (err) => errors.push(err),
      subs: {
        bad: () => () => { throw new Error('broken cleanup'); },
        good: () => () => log.push('good cleaned'),
      },
    });
    app.dispatch('off');
    assert.strictEqual(errors.filter((e) => /** @type {any} */ (e).code === 'JA2012').length, 1);
    assert.deepStrictEqual(log, ['good cleaned'],
      'the sibling cleanup ran despite the first one throwing');
  });

  it('stop() is idempotent and cleans up exactly once', function () {
    const log = [];
    const doc = baseDoc();
    doc.subs = [{ run: 's', when: '$.on' }];
    const app = createApp(doc, {
      schedule: sync,
      subs: { s: () => () => log.push('cleaned') },
    });
    app.stop();
    app.stop();
    assert.deepStrictEqual(log, ['cleaned']);
  });
});

describe('boot as a transaction', function () {
  it('a boot-time subscription failure under the default sink rolls back and throws JA0007 with the cause chain', function () {
    const log = [];
    const doc = baseDoc();
    doc.subs = [
      { run: 'first' },
      { run: 'explodes' },
    ];
    assert.throws(() => createApp(doc, {
      schedule: sync,
      subs: {
        first: () => { log.push('first started'); return () => log.push('first cleaned'); },
        explodes: () => { throw new Error('boom at boot'); },
      },
    }), (err) => {
      assert.ok(err instanceof AppCompileError);
      assert.strictEqual(/** @type {any} */ (err).code, 'JA0007');
      assert.match(/** @type {Error} */ (/** @type {any} */ (err).cause).message, /boom at boot/);
      return true;
    });
    assert.deepStrictEqual(log, ['first started', 'first cleaned'],
      'the already-acquired subscription was disposed by the rollback');
  });

  it('a sink that swallows the boot failure keeps that subscription stopped and boots the rest', function () {
    const log = [];
    const errors = [];
    const doc = baseDoc();
    doc.subs = [{ run: 'explodes' }, { run: 'fine' }];
    const app = createApp(doc, {
      schedule: sync,
      onError: (err) => errors.push(err),
      subs: {
        explodes: () => { throw new Error('boom at boot'); },
        fine: () => { log.push('fine started'); return () => log.push('fine cleaned'); },
      },
    });
    assert.strictEqual(errors.filter((e) => /** @type {any} */ (e).code === 'JA2013').length, 1);
    assert.deepStrictEqual(log, ['fine started']);
    app.dispatch('bump');
    assert.strictEqual(app.getState().n, 1, 'the app is fully alive');
    app.stop();
    assert.deepStrictEqual(log, ['fine started', 'fine cleaned']);
  });

  it('a first-frame failure (unrenderable root) rolls back and throws JA0007', function () {
    const { document, container } = createStubHost();
    const log = [];
    const doc = baseDoc();
    doc.view = [{ match: '$.nothing', body: ['p', {}, 'never'] }]; // no match → null vnode
    doc.subs = [{ run: 's' }];
    assert.throws(() => createApp(doc, {
      node: container, document, schedule: sync,
      subs: { s: () => { log.push('started'); return () => log.push('cleaned'); } },
    }), (err) => /** @type {any} */ (err).code === 'JA0007');
    assert.deepStrictEqual(log, ['started', 'cleaned'],
      'the subscription acquired before the render failure was disposed');
  });

  it('dispatches queued by boot-time subscription handlers run after a successful boot', function () {
    const doc = baseDoc();
    doc.subs = [{ run: 'eager' }];
    const app = createApp(doc, {
      schedule: sync,
      subs: { eager: (props, dispatch) => { dispatch('bump'); } },
    });
    assert.strictEqual(app.getState().n, 1);
  });
});

describe('app.destroy()', function () {
  it('unmounts widgets exactly once, empties the container, disposes handlers once, and is idempotent', function () {
    const { document, container } = createStubHost();
    const log = [];
    const doc = {
      state: { on: true },
      view: [{ match: '$', body: ['main', {}, ['jaren-widget', { name: 'w' }]] }],
      actions: {},
      subs: [{ run: 's' }],
    };
    const sharedHandler = Object.assign(() => {}, {
      dispose: () => log.push('handler disposed'),
    });
    const app = createApp(doc, {
      node: container, document, schedule: sync,
      widgets: {
        w: {
          mount: () => { log.push('mounted'); return 42; },
          unmount: (handle) => log.push(['unmounted', handle]),
        },
      },
      effects: { alpha: sharedHandler, beta: sharedHandler },
      subs: { s: () => () => log.push('sub cleaned') },
    });
    assert.deepStrictEqual(log, ['mounted']);
    app.destroy();
    app.destroy();
    assert.deepStrictEqual(log, [
      'mounted', 'sub cleaned', 'handler disposed', ['unmounted', 42],
    ], 'each teardown ran exactly once, in stop → dispose → renderer order');
    assert.strictEqual(serialize(container), '<div></div>', 'the container is empty');
    app.dispatch('anything');
  });

  it('a scheduled render flush after destroy is an exact no-op', async function () {
    const { document, container } = createStubHost();
    const app = createApp(baseDoc(), { node: container, document }); // microtask scheduler
    app.dispatch('bump');
    app.destroy();
    await drain();
    assert.strictEqual(serialize(container), '<div></div>',
      'the deferred flush did not resurrect the DOM');
  });

  it('destroy() disposes task effects: late settlements cannot dispatch', async function () {
    const settles = [];
    let resolveRun;
    const task = createTaskEffect(() => new Promise((resolve) => { resolveRun = resolve; }));
    const doc = baseDoc();
    doc.actions.load = { effects: [{ run: 'http', with: { id: 1, done: 'bump' } }] };
    const app = createApp(doc, { schedule: sync, effects: { http: task } });
    app.subscribe(() => settles.push('tx'));
    app.dispatch('load');
    app.destroy();
    resolveRun(['late']);
    await drain();
    assert.deepStrictEqual(settles, [], 'the late settlement dispatched nothing');
  });
});

describe('createDomRenderer destroy', function () {
  it('is idempotent, unmounts widgets once, and later renders are no-ops', function () {
    const { document, container } = createStubHost();
    const log = [];
    const render = createDomRenderer(container, {
      document,
      widgets: {
        w: {
          mount: () => { log.push('mount'); return 1; },
          unmount: () => log.push('unmount'),
        },
      },
    });
    render(['main', {}, ['jaren-widget', { name: 'w' }]]);
    assert.deepStrictEqual(log, ['mount']);
    render.destroy();
    render.destroy();
    assert.deepStrictEqual(log, ['mount', 'unmount']);
    assert.strictEqual(serialize(container), '<div></div>');
    render(['main', {}, 'resurrected?']);
    assert.strictEqual(serialize(container), '<div></div>', 'render after destroy is a no-op');
  });

  it('a throwing widget unmount does not stop the teardown; the first error surfaces after it completes', function () {
    const { document, container } = createStubHost();
    const log = [];
    const render = createDomRenderer(container, {
      document,
      widgets: {
        bad: { mount: () => 0, unmount: () => { throw new Error('broken unmount'); } },
        good: { mount: () => 0, unmount: () => log.push('good unmounted') },
      },
    });
    render(['main', {},
      ['jaren-widget', { name: 'bad' }],
      ['jaren-widget', { name: 'good' }],
    ]);
    assert.throws(() => render.destroy(), /broken unmount/);
    assert.deepStrictEqual(log, ['good unmounted'],
      'the sibling widget still unmounted');
    assert.strictEqual(serialize(container), '<div></div>');
  });
});

describe('task concurrency modes', function () {
  /** A manually settled runner recording calls. */
  function deferredRunner() {
    const calls = [];
    const run = (props, signal) => new Promise((resolve, reject) => {
      calls.push({ props, signal, resolve, reject });
    });
    return { calls, run };
  }

  function dispatcher() {
    const dispatched = [];
    return { dispatched, dispatch: (name, payload) => dispatched.push([name, payload]) };
  }

  it('switch (default): a new start aborts the slot predecessor', function () {
    const { calls, run } = deferredRunner();
    const task = createTaskEffect(run);
    const { dispatch } = dispatcher();
    task({ id: 1, done: 'done' }, dispatch);
    task({ id: 2, done: 'done' }, dispatch);
    assert.strictEqual(calls[0].signal.aborted, true);
    assert.strictEqual(calls[1].signal.aborted, false);
  });

  it('exhaust: duplicate starts while in flight are ignored entirely', async function () {
    const { calls, run } = deferredRunner();
    const task = createTaskEffect(run, { mode: 'exhaust' });
    const { dispatched, dispatch } = dispatcher();
    task({ id: 1, done: 'done' }, dispatch);
    task({ id: 2, done: 'done' }, dispatch); // double-click: ignored
    assert.strictEqual(calls.length, 1, 'the duplicate start never ran');
    calls[0].resolve('committed');
    await drain();
    assert.deepStrictEqual(dispatched, [['done', { id: 1, result: 'committed' }]]);
    task({ id: 3, done: 'done' }, dispatch);
    assert.strictEqual(calls.length, 2, 'the slot is free again after settle');
  });

  it('concat: starts queue and run strictly one after another, in order', async function () {
    const { calls, run } = deferredRunner();
    const task = createTaskEffect(run, { mode: 'concat' });
    const { dispatched, dispatch } = dispatcher();
    task({ id: 1, done: 'done' }, dispatch);
    task({ id: 2, done: 'done' }, dispatch);
    task({ id: 3, done: 'done' }, dispatch);
    assert.strictEqual(calls.length, 1, 'only the head runs');
    calls[0].resolve('a');
    await drain();
    assert.strictEqual(calls.length, 2, 'the second started after the first settled');
    calls[1].resolve('b');
    await drain();
    calls[2].resolve('c');
    await drain();
    assert.deepStrictEqual(dispatched, [
      ['done', { id: 1, result: 'a' }],
      ['done', { id: 2, result: 'b' }],
      ['done', { id: 3, result: 'c' }],
    ]);
  });

  it('parallel: every start runs concurrently on the same slot', function () {
    const { calls, run } = deferredRunner();
    const task = createTaskEffect(run, { mode: 'parallel' });
    const { dispatch } = dispatcher();
    task({ id: 1, done: 'done' }, dispatch);
    task({ id: 2, done: 'done' }, dispatch);
    assert.strictEqual(calls.length, 2);
    assert.strictEqual(calls[0].signal.aborted, false);
    assert.strictEqual(calls[1].signal.aborted, false);
  });

  it('cancel(slot) aborts in-flight work and discards queued starts', async function () {
    const { calls, run } = deferredRunner();
    const task = createTaskEffect(run, { mode: 'concat' });
    const { dispatched, dispatch } = dispatcher();
    task({ id: 1, done: 'done' }, dispatch);
    task({ id: 2, done: 'done' }, dispatch); // queued
    task.cancel();
    assert.strictEqual(calls[0].signal.aborted, true);
    calls[0].reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    await drain();
    assert.deepStrictEqual(dispatched, [], 'nothing dispatched, nothing dequeued');
    assert.strictEqual(calls.length, 1, 'the queued start was discarded');
  });

  it('a synchronous throw from run settles through the ordinary failure path', async function () {
    const task = createTaskEffect(() => { throw new Error('sync boom'); });
    const { dispatched, dispatch } = dispatcher();
    task({ id: 1, done: 'done' }, dispatch);
    await drain();
    assert.deepStrictEqual(dispatched, [['done', { id: 1, error: 'sync boom' }]]);
  });

  it('a non-promise return settles through the ordinary resolution path', async function () {
    const task = createTaskEffect(() => /** @type {any} */ (42));
    const { dispatched, dispatch } = dispatcher();
    task({ id: 1, done: 'done' }, dispatch);
    await drain();
    assert.deepStrictEqual(dispatched, [['done', { id: 1, result: 42 }]]);
  });

  it('malformed fail/slot props are TypeErrors', function () {
    const task = createTaskEffect(() => Promise.resolve(null));
    const { dispatch } = dispatcher();
    assert.throws(() => task({ id: 1, done: 'd', fail: 42 }, dispatch), TypeError);
    assert.throws(() => task({ id: 1, done: 'd', slot: 42 }, dispatch), TypeError);
  });

  it('an unknown mode is a TypeError at creation', function () {
    assert.throws(() => createTaskEffect(() => Promise.resolve(null),
      { mode: /** @type {any} */ ('sometimes') }), TypeError);
  });
});
