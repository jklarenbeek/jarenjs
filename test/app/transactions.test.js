//@ts-check
import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { createApp, AppRuntimeError } from '@jarenjs/app';
import { createStubHost, fire, serialize } from '../view/dom.stub.js';

/** Synchronous render scheduler for deterministic assertions. */
const sync = (flush) => flush();

/** Two independent counters plus actions to move them. */
function abDoc() {
  return {
    state: { a: 0, b: 0 },
    view: [{ match: '$', body: ['p', {}, 'a=', '$.a', ' b=', '$.b'] }],
    actions: {
      setA: { patch: [{ op: 'replace', path: '/a', value: 1 }] },
      setB: { patch: [{ op: 'replace', path: '/b', value: 1 }] },
      loop: { effects: [{ run: 'again' }] },
    },
  };
}

describe('the FIFO transaction queue (APP-FORMAT §8)', function () {
  it('a listener dispatch queues behind the current transaction: every listener observes every transaction, in the same order', function () {
    // the adversarial probe: without the queue, L2 observes the inner
    // /b transaction before the outer /a, and the /a notification
    // already carries b=1
    const log = [];
    const app = createApp(abDoc(), { schedule: sync });
    let fired = false;
    app.subscribe((state, changes) => {
      log.push(['L1', state.a, state.b, changes?.[0] ?? null]);
      if (!fired) {
        fired = true;
        app.dispatch('setB');
      }
    });
    app.subscribe((state, changes) => {
      log.push(['L2', state.a, state.b, changes?.[0] ?? null]);
    });
    app.dispatch('setA');
    assert.deepStrictEqual(log, [
      ['L1', 1, 0, '/a'],
      ['L2', 1, 0, '/a'],
      ['L1', 1, 1, '/b'],
      ['L2', 1, 1, '/b'],
    ], 'transaction order is identical for every listener, and each notification carries the state of exactly that transaction');
  });

  it('an effect dispatch queues: the outer transition settles before the inner action runs', function () {
    const order = [];
    const doc = abDoc();
    doc.actions.fetch = { effects: [{ run: 'fake' }] };
    const app = createApp(doc, {
      schedule: sync,
      effects: {
        fake: (props, dispatch) => {
          dispatch('setA');
          order.push(['effect-returned', app.getState().a]);
        },
      },
    });
    app.subscribe((state, changes) => order.push(['tx', changes?.[0] ?? null, state.a]));
    app.dispatch('fetch');
    assert.deepStrictEqual(order, [
      ['effect-returned', 0],
      ['tx', '/a', 1],
    ], 'the nested dispatch ran after the effect (and its transaction) completed');
    assert.strictEqual(app.getState().a, 1);
  });

  it('a widget emit during mount queues under the synchronous scheduler', function () {
    const { document, container } = createStubHost();
    const doc = {
      state: { mounted: 0 },
      view: [{
        match: '$',
        body: ['main', {}, ['jaren-widget', { name: 'probe' }]],
      }],
      actions: {
        hello: { patch: [{ op: 'replace', path: '/mounted', value: { $add: ['$.mounted', 1] } }] },
      },
    };
    const app = createApp(doc, {
      node: container, document, schedule: sync,
      widgets: {
        probe: {
          mount: (host, props, emit) => { emit('hello'); return null; },
        },
      },
    });
    assert.strictEqual(app.getState().mounted, 1,
      'the mount-time emit dispatched exactly once, after the frame committed');
  });

  it('a subscription handler dispatch during start queues; its condition-flip stops the just-started resource via the ordinary stop path', function () {
    const log = [];
    const doc = abDoc();
    doc.state = { on: true };
    doc.subs = [{ run: 'probe', when: '$.on' }];
    doc.actions = {
      off: { patch: [{ op: 'replace', path: '/on', value: false }] },
    };
    const app = createApp(doc, {
      schedule: sync,
      subs: {
        probe: (props, dispatch) => {
          log.push('start');
          dispatch('off'); // makes the own `when` false — queued, never nested
          return () => log.push('cleanup');
        },
      },
    });
    assert.deepStrictEqual(log, ['start', 'cleanup'],
      'the acquired resource was committed, then disposed by the queued transaction');
    assert.strictEqual(app.getState().on, false);
    app.stop();
    assert.deepStrictEqual(log, ['start', 'cleanup'], 'no double cleanup on stop');
  });

  it('a subscription callback dispatch (a tick) runs as its own ordered transaction', function () {
    const doc = abDoc();
    doc.subs = [{ run: 'ticker' }];
    let tick = null;
    const app = createApp(doc, {
      schedule: sync,
      subs: { ticker: (props, dispatch) => { tick = () => dispatch('setA'); } },
    });
    tick();
    assert.strictEqual(app.getState().a, 1);
  });

  it('several queued actions coalesce into one scheduled render', function () {
    const { document, container } = createStubHost();
    let flushes = 0;
    /** @type {(() => void)[]} */
    const pending = [];
    const app = createApp(abDoc(), {
      node: container, document,
      schedule: (flush) => { flushes++; pending.push(flush); },
      effects: {},
    });
    const doc2 = abDoc();
    void doc2;
    app.dispatch('setA');
    app.dispatch('setB');
    assert.strictEqual(flushes, 1, 'the second transaction reused the scheduled render');
    pending.forEach((flush) => flush());
    assert.match(serialize(container), /a=1 b=1/);
  });

  it('an error in one listener is isolated (JA2011): the drain completes and later dispatches work', function () {
    const errors = [];
    const app = createApp(abDoc(), {
      schedule: sync,
      onError: (err) => errors.push(err),
    });
    const seen = [];
    app.subscribe(() => { throw new Error('broken listener'); });
    app.subscribe((state) => seen.push(state.a + state.b));
    app.dispatch('setA');
    app.dispatch('setB');
    assert.strictEqual(errors.length, 2);
    assert.strictEqual(/** @type {any} */ (errors[0]).code, 'JA2011');
    assert.deepStrictEqual(seen, [1, 2],
      'the second listener observed both transactions despite the first throwing');
  });

  it('with the default rethrowing sink, an isolated error surfaces to the dispatch caller only after the drain completed', function () {
    const app = createApp(abDoc(), { schedule: sync });
    app.subscribe(() => { throw new Error('broken listener'); });
    assert.throws(() => app.dispatch('setA'), /broken listener/);
    assert.strictEqual(app.getState().a, 1,
      'the transition still applied — the queue was never corrupted');
    assert.throws(() => app.dispatch('setB'), /broken listener/);
    assert.strictEqual(app.getState().b, 1);
  });

  it('stop() while work is queued clears the queue', function () {
    const doc = abDoc();
    doc.actions.stopThenMore = { effects: [{ run: 'stopper' }] };
    let app;
    const effects = {
      stopper: (props, dispatch) => {
        dispatch('setA'); // queued...
        app.stop();       // ...but stop clears the queue first
      },
    };
    app = createApp(doc, { schedule: sync, effects });
    app.dispatch('stopThenMore');
    assert.strictEqual(app.getState().a, 0, 'the queued dispatch never ran');
  });

  it('an accidental dispatch loop diagnoses as JA2010 instead of hanging', function () {
    const errors = [];
    const doc = abDoc();
    const app = createApp(doc, {
      schedule: sync,
      maxTurns: 5,
      onError: (err) => errors.push(err),
      effects: { again: (props, dispatch) => dispatch('loop') },
    });
    app.dispatch('loop');
    assert.strictEqual(errors.length, 1);
    assert.strictEqual(/** @type {any} */ (errors[0]).code, 'JA2010');
    assert.ok(errors[0] instanceof AppRuntimeError);
    app.dispatch('setA');
    assert.strictEqual(app.getState().a, 1, 'the app recovered after abandoning the loop');
  });

  it('native event data is reduced to JSON synchronously, before queuing', function () {
    const { document, container } = createStubHost();
    const doc = {
      state: { last: null },
      view: [{ match: '$', body: ['button', { on: { click: { action: 'capture', event: ['clientX'] } } }, 'go'] }],
      actions: {
        capture: { patch: [{ op: 'add', path: '/last', value: '$event' }] },
        first: { patch: [{ op: 'add', path: '/first', value: true }] },
      },
    };
    const app = createApp(doc, { node: container, document, schedule: sync });
    // a listener dispatch delays the click transaction; by then the
    // event object has been recycled by the (simulated) browser
    const event = fire(container.childNodes[0], 'click', { clientX: 42 });
    event.clientX = -1; // recycled after the handler returned
    assert.strictEqual(app.getState().last.clientX, 42,
      'the queued transaction carried the JSON snapshot, not the live event');
  });
});

describe('validateState context (changed-path validation)', function () {
  it('receives { previous, action, payload, changes } beside the candidate state', function () {
    const seen = [];
    const app = createApp({
      state: { n: 0 },
      view: [{ match: '$', body: ['p', {}, '$.n'] }],
      actions: {
        set: { patch: [{ op: 'replace', path: '/n', value: '$payload' }] },
        swap: { state: { n: 99 } },
      },
    }, {
      schedule: sync,
      validateState: (next, context) => {
        seen.push({
          next: next.n,
          previous: context.previous === null ? null : context.previous.n,
          action: context.action,
          payload: context.payload,
          changes: context.changes,
        });
        return true;
      },
    });
    app.dispatch('set', 5);
    app.dispatch('swap');
    assert.deepStrictEqual(seen, [
      { next: 0, previous: null, action: null, payload: null, changes: null },
      { next: 5, previous: 0, action: 'set', payload: 5, changes: ['/n'] },
      { next: 99, previous: 5, action: 'swap', payload: null, changes: null },
    ], 'boot validates the initial state with the null boot context; patch transitions carry '
      + 'pointers; whole-state swaps carry null = validate fully');
  });
});

describe('transaction observers (APP-FORMAT §8.3)', function () {
  it('receives one bounded record per transaction, after it settled, without payloads by default', function () {
    const records = [];
    const doc = abDoc();
    doc.actions.noop = {};
    doc.actions.eff = { effects: [{ run: 'log' }] };
    const app = createApp(doc, {
      schedule: sync,
      effects: { log: () => {} },
      onError: () => {}, // the failed-transaction record is the assertion
    });
    app.observe((tx) => records.push(tx));
    app.dispatch('setA', { secret: true });
    app.dispatch('noop');
    app.dispatch('eff');
    app.dispatch('missing-action');

    assert.strictEqual(records.length, 4);
    assert.deepStrictEqual(records.map((tx) => [tx.seq, tx.action, tx.source, tx.status, tx.errorCode]), [
      [1, 'setA', 'dispatch', 'applied', null],
      [2, 'noop', 'dispatch', 'noop', null],
      [3, 'eff', 'dispatch', 'applied', null],
      [4, 'missing-action', 'dispatch', 'failed', 'JA2001'],
    ]);
    assert.deepStrictEqual(records[0].changedPaths, ['/a']);
    assert.deepStrictEqual(records[2].scheduledEffects, ['log']);
    assert.ok(typeof records[0].durationMs === 'number');
    assert.ok(!('payload' in records[0]),
      'payload capture is off by default — diagnostics must not leak data');
  });

  it('tags the dispatch source: binding, effect, subscription', function () {
    const { document, container } = createStubHost();
    const doc = {
      state: { n: 0 },
      view: [{ match: '$', body: ['button', { on: { click: 'bump' } }, 'go'] }],
      actions: {
        bump: { patch: [{ op: 'replace', path: '/n', value: { $add: ['$.n', 1] } }] },
        viaEffect: { effects: [{ run: 'fake' }] },
      },
      subs: [{ run: 'ticker' }],
    };
    let tick = null;
    const records = [];
    const app = createApp(doc, {
      node: container, document, schedule: sync,
      effects: { fake: (props, dispatch) => dispatch('bump') },
      subs: { ticker: (props, dispatch) => { tick = () => dispatch('bump'); } },
    });
    app.observe((tx) => records.push([tx.action, tx.source]));
    fire(container.childNodes[0], 'click');
    app.dispatch('viaEffect');
    tick();
    assert.deepStrictEqual(records, [
      ['bump', 'binding'],
      ['viaEffect', 'dispatch'],
      ['bump', 'effect'],
      ['bump', 'subscription'],
    ]);
  });

  it('capturePayloads opts records into payload/event values', function () {
    const records = [];
    const app = createApp(abDoc(), { schedule: sync, capturePayloads: true });
    app.observe((tx) => records.push(tx));
    app.dispatch('setA', { note: 'hello' });
    assert.deepStrictEqual(records[0].payload, { note: 'hello' });
    assert.strictEqual(records[0].event, null);
  });

  it('a throwing observer is isolated (JA2011) and never corrupts the queue', function () {
    const errors = [];
    const records = [];
    const app = createApp(abDoc(), { schedule: sync, onError: (err) => errors.push(err) });
    app.observe(() => { throw new Error('broken observer'); });
    app.observe((tx) => records.push(tx.seq));
    app.dispatch('setA');
    app.dispatch('setB');
    assert.strictEqual(errors.filter((e) => /** @type {any} */ (e).code === 'JA2011').length, 2);
    assert.deepStrictEqual(records, [1, 2], 'the second observer saw both transactions');
  });
});
