//@ts-check
/**
 * @file Hostile-value closure: the host-failure policy is TOTAL. A
 * revoked proxy, a proxy with throwing traps, an Error with a throwing
 * `message` accessor, objects with hostile `name`/`toString`/
 * `Symbol.toPrimitive`, functions with hostile coercion — none may
 * break isolation, draining, settlement or terminal teardown, none may
 * produce a framework-originated unhandled rejection, and dual
 * failures in one frame both stay observable in that frame.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import {
  createApp, createFocusEffect, createTaskEffect, HostValueError,
} from '@jarenjs/app';
import { compileJsonQuery } from '@jarenjs/json/query';
import { createDomRenderer } from '@jarenjs/view';
import { createStubHost, serialize } from '../view/dom.stub.js';

const sync = (flush) => flush();

function revokedProxy() {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  return proxy;
}

/** Assert the total cause policy for a wrapped report. */
function assertCause(reported, original) {
  let isError = false;
  try {
    isError = original instanceof Error;
  }
  catch { /* hostile classification counts as non-Error */ }
  if (isError) {
    assert.strictEqual(reported.cause, original, 'Error identity survives');
  }
  else {
    assert.ok(reported.cause instanceof HostValueError);
    assert.ok(Object.hasOwn(reported.cause, 'cause'));
    assert.strictEqual(/** @type {any} */ (reported.cause).cause, original);
  }
}

function hostileMatrix() {
  const hostileMessage = new Error('x');
  Object.defineProperty(hostileMessage, 'message', {
    get() { throw new Error('message getter ran'); },
  });
  const proxiedError = new Proxy(new Error('inner'), {
    get() { throw new Error('get trap ran'); },
  });
  const throwingProto = new Proxy({}, {
    getPrototypeOf() { throw new Error('proto trap ran'); },
  });
  const hostileObject = {
    get name() { throw new Error('name getter ran'); },
    toString() { throw new Error('toString ran'); },
    [Symbol.toPrimitive]() { throw new Error('toPrimitive ran'); },
  };
  function hostileFunction() {}
  hostileFunction.toString = () => { throw new Error('function toString ran'); };
  return [
    ['revoked proxy', revokedProxy()],
    ['throwing getPrototypeOf trap', throwingProto],
    ['Error with throwing message getter', hostileMessage],
    ['proxy-wrapped Error with throwing get trap', proxiedError],
    ['object with hostile name/toString/toPrimitive', hostileObject],
    ['function with throwing toString', hostileFunction],
    ['bigint', 7n],
    ['boolean', true],
  ];
}

describe('total normalization at terminal teardown (P0)', () => {
  it('a dispose() throwing a revoked proxy cannot permanently abort destroy', () => {
    const { document, container } = createStubHost();
    const log = [];
    const reported = [];
    const proxy = revokedProxy();
    const bad = () => {};
    bad.dispose = () => { log.push('bad.dispose'); throw proxy; };
    const good = () => {};
    good.dispose = () => log.push('good.dispose');

    const app = createApp({
      state: {},
      view: [{ match: '$', body: ['div', {},
        ['jaren-widget', { name: 'w', props: {} }]] }],
    }, {
      node: container,
      document,
      schedule: sync,
      onError: (error) => reported.push(error),
      effects: { bad, good },
      widgets: {
        w: {
          mount() { log.push('mount'); return {}; },
          unmount() { log.push('unmount'); },
        },
      },
    });

    app.destroy();

    assert.deepStrictEqual(log, ['mount', 'bad.dispose', 'good.dispose', 'unmount']);
    assert.strictEqual(serialize(container), '<div></div>');
    const cleanups = reported.filter((e) => e.code === 'JA2012');
    assert.strictEqual(cleanups.length, 1);
    assertCause(cleanups[0], proxy);
    app.destroy(); // still an exact no-op
    assert.deepStrictEqual(log, ['mount', 'bad.dispose', 'good.dispose', 'unmount']);
  });

  it('every hostile value class settles terminal unmount with one JA2012 and full cause policy', () => {
    for (const [label, value] of hostileMatrix()) {
      const { document, container } = createStubHost();
      const log = [];
      const reported = [];
      const app = createApp({
        state: {},
        view: [{ match: '$', body: ['div', {},
          ['jaren-widget', { name: 'thrower', key: 't', props: {} }],
          ['jaren-widget', { name: 'sibling', key: 's', props: {} }],
        ] }],
      }, {
        node: container,
        document,
        schedule: sync,
        onError: (error) => reported.push(error),
        widgets: {
          thrower: {
            mount() { return {}; },
            unmount() { log.push('unmount:thrower'); throw value; },
          },
          sibling: {
            mount() { return {}; },
            unmount() { log.push('unmount:sibling'); },
          },
        },
      });

      app.destroy();

      assert.deepStrictEqual(log, ['unmount:thrower', 'unmount:sibling'], label);
      assert.strictEqual(serialize(container), '<div></div>', label);
      const cleanups = reported.filter((e) => e.code === 'JA2012');
      assert.strictEqual(cleanups.length, 1, label);
      assertCause(cleanups[0], value);
      app.destroy();
      assert.deepStrictEqual(log, ['unmount:thrower', 'unmount:sibling'], label);
    }
  });

  it('a direct renderer surfaces a hostile unmount value by identity', () => {
    const { document, container } = createStubHost();
    const proxy = revokedProxy();
    const render = createDomRenderer(container, {
      document,
      widgets: {
        w: {
          mount() { return {}; },
          unmount() { throw proxy; },
        },
      },
    });
    render(['jaren-widget', { name: 'w', props: {} }]);
    assert.throws(() => render.destroy(), (thrown) => thrown === proxy);
    assert.strictEqual(serialize(container), '<div></div>');
  });
});

describe('total normalization inside transactions (P0)', () => {
  it('a listener throwing a revoked proxy cannot break convergence', () => {
    const { document, container } = createStubHost();
    const seen = [];
    const reported = [];
    const proxy = revokedProxy();
    const app = createApp({
      state: { n: 0 },
      view: [{ match: '$', body: ['p', {}, '$.n'] }],
      actions: { bump: { state: { n: 1 } } },
    }, {
      node: container,
      document,
      schedule: sync,
      onError: (error) => reported.push(error),
    });
    app.subscribe(() => { throw proxy; });
    app.subscribe((state) => seen.push(state.n));

    app.dispatch('bump');

    assert.deepStrictEqual(seen, [1]);
    assert.strictEqual(serialize(container), '<div><p>1</p></div>');
    const isolated = reported.filter((e) => e.code === 'JA2011');
    assert.strictEqual(isolated.length, 1);
    assertCause(isolated[0], proxy);
    app.destroy();
  });

  it('validator and extractor hostility keep their stable codes', () => {
    const proxy = revokedProxy();
    const reported = [];
    const app = createApp({
      state: { n: 0, got: 'unset' },
      view: [{ match: '$', body: ['p', {}, 'x'] }],
      actions: {
        bad: { patch: [{ op: 'replace', path: '/n', value: 1 }] },
        good: { patch: [{ op: 'replace', path: '/n', value: 2 }] },
        pick: { state: { n: '$.n', got: '$event.tokens' } },
      },
    }, {
      schedule: sync,
      onError: (error) => reported.push(error),
      validateState: (next, context) => {
        if (context.action === 'bad') throw proxy;
        return true;
      },
      eventFields: {
        tokens: () => { throw proxy; },
      },
    });
    app.dispatch('bad');
    app.dispatch('good');
    assert.strictEqual(app.getState().n, 2, 'the queue drained past the hostile validator');
    const validator = reported.filter((e) => e.code === 'JA2015');
    assert.strictEqual(validator.length, 1);
    assertCause(validator[0], proxy);

    app.dispatch('pick', null, { type: 'change' }, ['tokens']);
    assert.strictEqual(app.getState().got, null);
    const extractor = reported.filter((e) => e.code === 'JA2002');
    assert.strictEqual(extractor.length, 1);
    assertCause(extractor[0], proxy);
    app.destroy();
  });

  it('a boot subscription throwing a revoked proxy rolls back as JA0007 with a safe message', () => {
    const proxy = revokedProxy();
    assert.throws(() => createApp({
      state: {},
      view: [{ match: '$', body: ['p', {}, 'x'] }],
      subs: [{ run: 'eager' }],
    }, {
      schedule: sync,
      subs: { eager: () => { throw proxy; } },
    }), (error) => error?.code === 'JA0007' && typeof error.message === 'string');
  });

  it('a hostile compileTypeTest keeps the stable compile code and the original cause', () => {
    for (const thrown of [null, revokedProxy()]) {
      let queryError = null;
      try {
        compileJsonQuery({ $valid: ['$', { type: 'object' }] }, {
          compileTypeTest: () => { throw thrown; },
        });
      }
      catch (caught) {
        queryError = caught;
      }
      assert.strictEqual(queryError?.code, 'JQ0009');
      assert.ok(Object.hasOwn(queryError, 'cause'));
      assert.strictEqual(queryError.cause, thrown);

      let appError = null;
      try {
        createApp({
          state: {},
          view: [{ match: '$', body: ['p', {}, 'x'] }],
          actions: { check: { $valid: ['$', { type: 'object' }] } },
        }, {
          schedule: sync,
          compileTypeTest: () => { throw thrown; },
        });
      }
      catch (caught) {
        appError = caught;
      }
      assert.strictEqual(appError?.code, 'JA0004');
      assert.strictEqual(appError.cause?.code, 'JQ0009');
      assert.strictEqual(appError.cause.cause, thrown);
    }
  });
});

describe('total task settlement (P1)', () => {
  /** Let the uniform promise boundary settle. */
  async function settled() {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  }

  it('hostile rejection values settle exactly one failure dispatch, never an unhandled rejection', async () => {
    const hostileName = {};
    Object.defineProperty(hostileName, 'name', {
      get() { throw new Error('name getter ran'); },
    });
    function hostileFunction() {}
    hostileFunction.toString = () => { throw new Error('function toString ran'); };

    for (const [label, rejected] of [
      ['throwing name getter', hostileName],
      ['throwing function toString', hostileFunction],
      ['revoked proxy', revokedProxy()],
      ['Error with throwing message getter', (() => {
        const e = new Error('x');
        Object.defineProperty(e, 'message', { get() { throw new Error('boom'); } });
        return e;
      })()],
    ]) {
      const dispatches = [];
      const task = createTaskEffect(() => Promise.reject(rejected));
      task({ id: 1, done: 'done', fail: 'fail' },
        (name, payload) => dispatches.push([name, payload]));
      await settled();
      assert.strictEqual(dispatches.length, 1, label);
      assert.strictEqual(dispatches[0][0], 'fail', label);
      assert.strictEqual(dispatches[0][1].id, 1, label);
      assert.strictEqual(typeof dispatches[0][1].error, 'string', label);
      task.dispose();
    }
  });

  it('settlement stays total across cancel and dispose races', async () => {
    const proxy = revokedProxy();
    /** @type {any[]} */
    const afterCancel = [];
    let rejectLater;
    const task = createTaskEffect(() => new Promise((resolve, reject) => { rejectLater = reject; }));
    task({ id: 1, done: 'done', fail: 'fail' },
      (name, payload) => afterCancel.push([name, payload]));
    task.cancel();
    rejectLater(proxy);
    await settled();
    assert.strictEqual(afterCancel.length, 1,
      'a superseded task\'s NON-abort hostile failure still dispatches; the id guard is the authority');

    const afterDispose = [];
    let rejectLater2;
    const task2 = createTaskEffect(() => new Promise((resolve, reject) => { rejectLater2 = reject; }));
    task2({ id: 1, done: 'done', fail: 'fail' },
      (name, payload) => afterDispose.push([name, payload]));
    task2.dispose();
    rejectLater2(proxy);
    await settled();
    assert.strictEqual(afterDispose.length, 0, 'after dispose nothing dispatches');
  });
});

describe('dual-failure frame settlement (P1)', () => {
  const doc = {
    state: { n: 0 },
    view: [{ match: '$', body: ['main', {},
      ['output', {}, '$.n'],
      ['jaren-widget', { name: 'probe', props: { n: '$.n' } }],
    ] }],
    actions: { bump: { patch: [{ op: 'replace', path: '/n', value: 1 }] }, calm: { patch: [{ op: 'replace', path: '/n', value: 2 }] } },
  };

  it('a JA2014 focus flush cannot hide the same frame\'s widget error', () => {
    const { document, container } = createStubHost();
    const updateError = new Error('widget update');
    const reported = [];
    const focus = createFocusEffect({ container });
    const app = createApp(doc, {
      node: container,
      document,
      schedule: sync,
      onError: (error) => reported.push(error),
      effects: { focus },
      afterRender: () => focus.flush(),
      widgets: {
        probe: {
          mount() { return {}; },
          update(handle, props) { if (props.n === 1) throw updateError; },
          unmount() {},
        },
      },
    });

    focus({ ref: 'missing', op: 'focus' }, () => {});
    app.dispatch('bump');

    assert.match(serialize(container), /<output>1<\/output>/);
    assert.strictEqual(reported.length, 2, 'both same-frame failures reported');
    assert.strictEqual(reported[0].code, 'JA2014',
      'the afterRender failure is reported first');
    assert.strictEqual(reported[1], updateError,
      'the parked widget error follows, by identity, in the SAME frame');

    app.dispatch('calm');
    assert.strictEqual(reported.length, 2, 'no stale failure leaks into a later frame');
    app.destroy();
  });

  it('a throwing custom afterRender cannot hide parked null, Error or hostile values', () => {
    for (const parkedValue of [null, new Error('parked'), revokedProxy()]) {
      const { document, container } = createStubHost();
      const afterError = new Error('after boom');
      const reported = [];
      let armed = false;
      const app = createApp(doc, {
        node: container,
        document,
        schedule: sync,
        onError: (error) => reported.push(error),
        afterRender: () => { if (armed) throw afterError; },
        widgets: {
          probe: {
            mount() { return {}; },
            update(handle, props) { if (props.n === 1) throw parkedValue; },
            unmount() {},
          },
        },
      });
      armed = true;
      app.dispatch('bump');

      assert.strictEqual(reported.length, 2);
      assert.strictEqual(reported[0], afterError,
        'the afterRender failure is reported first');
      let parkedIsError = false;
      try {
        parkedIsError = parkedValue instanceof Error;
      }
      catch { /* hostile classification counts as non-Error */ }
      if (parkedIsError) {
        assert.strictEqual(reported[1], parkedValue,
          'a parked Error surfaces by identity in the same frame');
      }
      else {
        assert.ok(reported[1] instanceof HostValueError);
        assert.ok(Object.hasOwn(reported[1], 'cause'));
        assert.strictEqual(/** @type {any} */ (reported[1]).cause, parkedValue);
      }
      app.destroy();
    }
  });

  it('the default sink surfaces both same-frame failures in one aggregate', () => {
    const { document, container } = createStubHost();
    const afterError = new Error('after boom');
    const updateError = new Error('update boom');
    let armed = false;
    const app = createApp(doc, {
      node: container,
      document,
      schedule: sync,
      afterRender: () => { if (armed) throw afterError; },
      widgets: {
        probe: {
          mount() { return {}; },
          update(handle, props) { if (props.n === 1) throw updateError; },
          unmount() {},
        },
      },
    });
    armed = true;
    let surfaced = null;
    try {
      app.dispatch('bump');
    }
    catch (caught) {
      surfaced = caught;
    }
    assert.ok(surfaced instanceof AggregateError,
      'two rethrown failures cross the caller boundary as one aggregate');
    assert.deepStrictEqual(surfaced.errors, [afterError, updateError],
      'both by identity, in reporting order');
    app.destroy();
  });

  it('two throwing cleanups aggregate under one JA2012 with both causes observable', () => {
    const { document, container } = createStubHost();
    const first = new Error('first cleanup');
    const second = revokedProxy();
    const reported = [];
    const app = createApp({
      state: {},
      view: [{ match: '$', body: ['div', {},
        ['jaren-widget', { name: 'a', key: 'a', props: {} }],
        ['jaren-widget', { name: 'b', key: 'b', props: {} }],
      ] }],
    }, {
      node: container,
      document,
      schedule: sync,
      onError: (error) => reported.push(error),
      widgets: {
        a: { mount() { return {}; }, unmount() { throw first; } },
        b: { mount() { return {}; }, unmount() { throw second; } },
      },
    });

    app.destroy();

    assert.strictEqual(serialize(container), '<div></div>');
    const cleanups = reported.filter((e) => e.code === 'JA2012');
    assert.strictEqual(cleanups.length, 1, 'still exactly one JA2012 delivery');
    const cause = cleanups[0].cause;
    assert.ok(cause instanceof AggregateError, 'multiple cleanup failures aggregate');
    assert.strictEqual(cause.errors[0], first, 'the first failure is primary');
    assert.strictEqual(cause.errors[1], second, 'the second stays observable');
  });
});
