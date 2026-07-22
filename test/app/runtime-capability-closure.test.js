//@ts-check
/**
 * @file Capability-acquisition and multi-failure closure: the sink
 * failure collector is framework-owned (no reflection on values the
 * `onError` sink throws, host AggregateErrors kept as one element by
 * identity), optional lifecycle method LOOKUP shares the isolation
 * boundary of its invocation (effect `dispose`, widget
 * `update`/`unmount`, effect/subscription registry reads), every
 * cleanup failure of one frame or one destroy stays observable under
 * one documented aggregate shape, and boot is atomic for `afterRender`.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { createApp } from '@jarenjs/app';
import { createStubHost, serialize } from '../view/dom.stub.js';

const sync = (flush) => flush();

function revokedProxy() {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  return proxy;
}

describe('framework-owned sink failure collection (§10.1)', () => {
  it('a hostile onError during multiple reports cannot abort terminal cleanup', () => {
    const { document, container } = createStubHost();
    const log = [];
    const proxy = revokedProxy();
    const bad1 = () => {};
    bad1.dispose = () => { log.push('bad1.dispose'); throw new Error('one'); };
    const bad2 = () => {};
    bad2.dispose = () => { log.push('bad2.dispose'); throw new Error('two'); };
    const good = () => {};
    good.dispose = () => log.push('good.dispose');

    const app = createApp({
      state: {},
      view: [{ match: '$', body: ['jaren-widget', { name: 'probe', props: {} }] }],
    }, {
      node: container,
      document,
      schedule: sync,
      onError: () => { throw proxy; },
      effects: { bad1, bad2, good },
      widgets: {
        probe: {
          mount() { log.push('mount'); return {}; },
          unmount() { log.push('unmount'); },
        },
      },
    });

    let surfaced = null;
    try {
      app.destroy();
    }
    catch (caught) {
      surfaced = caught;
    }
    assert.deepStrictEqual(log,
      ['mount', 'bad1.dispose', 'bad2.dispose', 'good.dispose', 'unmount'],
      'every disposer and the renderer teardown ran despite the hostile sink');
    assert.strictEqual(serialize(container), '<div></div>');
    assert.strictEqual(surfaced, proxy,
      'one sink failure crosses by identity, unreflected');
    app.destroy();
    assert.deepStrictEqual(log,
      ['mount', 'bad1.dispose', 'bad2.dispose', 'good.dispose', 'unmount']);
  });

  it('multiple sink-thrown values cross in report order without flattening a host AggregateError', () => {
    const hostEnvelope = new AggregateError([new Error('inner')],
      'multiple failures surfaced in one drain');
    const second = revokedProxy();
    const thrown = [hostEnvelope, second];
    let call = 0;
    const app = createApp({
      state: { n: 0 },
      view: [{ match: '$', body: ['p', {}, '$.n'] }],
      actions: { bump: { state: { n: 1 } } },
    }, {
      schedule: sync,
      onError: () => { throw thrown[call++]; },
    });
    app.subscribe(() => { throw null; });   // report 1 → sink throws hostEnvelope
    app.subscribe(() => { throw null; });   // report 2 → sink throws the proxy

    let surfaced = null;
    try {
      app.dispatch('bump');
    }
    catch (caught) {
      surfaced = caught;
    }
    assert.strictEqual(app.getState().n, 1, 'the transaction committed');
    assert.ok(surfaced instanceof AggregateError);
    assert.strictEqual(surfaced.errors.length, 2);
    assert.strictEqual(surfaced.errors[0], hostEnvelope,
      'the host-created AggregateError stays ONE element by identity — never flattened');
    assert.strictEqual(surfaced.errors[1], second);
    app.destroy();
  });
});

describe('lifecycle capability acquisition (§10.2)', () => {
  it('a throwing dispose getter is one cleanup failure; later disposers and teardown run', () => {
    const { document, container } = createStubHost();
    const log = [];
    const reported = [];
    const marker = new Error('dispose getter ran');
    const bad = new Proxy(() => {}, {
      get(target, key, receiver) {
        if (key === 'dispose') throw marker;
        return Reflect.get(target, key, receiver);
      },
    });
    const good = () => {};
    good.dispose = () => log.push('good.dispose');

    const app = createApp({
      state: {},
      view: [{ match: '$', body: ['jaren-widget', { name: 'probe', props: {} }] }],
    }, {
      node: container,
      document,
      schedule: sync,
      onError: (error) => reported.push(error),
      effects: { bad, good },
      widgets: {
        probe: {
          mount() { log.push('mount'); return {}; },
          unmount() { log.push('unmount'); },
        },
      },
    });

    app.destroy();

    assert.deepStrictEqual(log, ['mount', 'good.dispose', 'unmount']);
    assert.strictEqual(serialize(container), '<div></div>');
    const cleanups = reported.filter((e) => e.code === 'JA2012');
    assert.strictEqual(cleanups.length, 1);
    assert.strictEqual(cleanups[0].cause, marker, 'the getter failure is the JA2012 cause');
    app.destroy();
    assert.deepStrictEqual(log, ['mount', 'good.dispose', 'unmount']);
  });

  it('a throwing unmount getter is collected; every sibling unmounts and the container clears', () => {
    const { document, container } = createStubHost();
    const log = [];
    const reported = [];
    const definition = new Proxy({
      mount() { log.push('mount:a'); return {}; },
    }, {
      get(target, key, receiver) {
        if (key === 'unmount') throw new Error('unmount getter ran');
        return Reflect.get(target, key, receiver);
      },
    });

    const app = createApp({
      state: {},
      view: [{ match: '$', body: ['div', {},
        ['jaren-widget', { name: 'hostile', key: 'a', props: {} }],
        ['jaren-widget', { name: 'plain', key: 'b', props: {} }],
      ] }],
    }, {
      node: container,
      document,
      schedule: sync,
      onError: (error) => reported.push(error),
      widgets: {
        hostile: definition,
        plain: {
          mount() { log.push('mount:b'); return {}; },
          unmount() { log.push('unmount:b'); },
        },
      },
    });

    app.destroy();

    assert.deepStrictEqual(log, ['mount:a', 'mount:b', 'unmount:b'],
      'the sibling still unmounted after the hostile lookup');
    assert.strictEqual(serialize(container), '<div></div>', 'ownership was released');
    const cleanups = reported.filter((e) => e.code === 'JA2012');
    assert.strictEqual(cleanups.length, 1);
    assert.strictEqual(cleanups[0].cause?.message, 'unmount getter ran');
    app.destroy();
  });

  it('a throwing update getter poisons the widget; the frame settles and the next render replaces it', () => {
    const { document, container } = createStubHost();
    const log = [];
    const reported = [];
    let hostileUpdates = 0;
    const definition = new Proxy({
      mount() { log.push('mount'); return {}; },
      unmount() { log.push('unmount'); },
    }, {
      get(target, key, receiver) {
        if (key === 'update') {
          hostileUpdates++;
          throw new Error('update getter ran');
        }
        return Reflect.get(target, key, receiver);
      },
    });

    const app = createApp({
      state: { n: 0 },
      view: [{ match: '$', body: ['main', {},
        ['jaren-widget', { name: 'probe', props: { n: '$.n' } }],
        ['output', {}, '$.n'],
      ] }],
      actions: { bump: { patch: [{ op: 'replace', path: '/n', value: '$payload' }] } },
    }, {
      node: container,
      document,
      schedule: sync,
      onError: (error) => reported.push(error),
      widgets: { probe: definition },
    });

    app.dispatch('bump', 1);
    assert.match(serialize(container), /<output>1<\/output>/,
      'the frame settled: the later sibling converged despite the hostile lookup');
    assert.strictEqual(hostileUpdates, 1);
    assert.deepStrictEqual(log, ['mount'],
      'the widget is poisoned, not yet replaced — replacement is next-render policy');

    app.dispatch('bump', 2);
    assert.match(serialize(container), /<output>2<\/output>/, 'later frames converge');
    assert.deepStrictEqual(log, ['mount', 'unmount', 'mount'],
      'the next render replaced the poisoned widget with a fresh lifecycle');
    assert.strictEqual(hostileUpdates, 1,
      'the poisoned instance never has its update looked up again');
    assert.ok(reported.length >= 1, 'the lookup failure was reported');
    app.destroy();
  });

  it('hostile effect/subscription registry member reads keep their stable codes and the loop alive', () => {
    const reported = [];
    const seen = [];
    const effects = new Proxy({}, {
      get(target, key) {
        if (key === 'boomEffect') throw new Error('effect registry get ran');
        return undefined;
      },
    });
    const subs = new Proxy({}, {
      get(target, key) {
        if (key === 'boomSub') throw new Error('sub registry get ran');
        return undefined;
      },
    });
    const app = createApp({
      state: { on: false, n: 0 },
      view: [{ match: '$', body: ['p', {}, '$.n'] }],
      actions: {
        go: { state: { on: true, n: 1 }, effects: [{ run: 'boomEffect' }] },
        after: { patch: [{ op: 'replace', path: '/n', value: 2 }] },
      },
      subs: [{ run: 'boomSub', when: '$.on' }],
    }, {
      schedule: sync,
      onError: (error) => reported.push(error),
      effects,
      subs,
    });
    app.subscribe((state) => seen.push(state.n));

    app.dispatch('go');
    app.dispatch('after');

    assert.deepStrictEqual(seen, [1, 2], 'the loop kept draining');
    assert.ok(reported.some((e) => e.code === 'JA2007'
      && e.cause?.message === 'effect registry get ran'));
    assert.ok(reported.some((e) => e.code === 'JA2013'
      && e.cause?.message === 'sub registry get ran'));
    app.destroy();
  });
});

describe('cleanup aggregation scope (§10.4)', () => {
  it('failures from separate sibling removals in one frame both stay observable', async () => {
    const { createDomRenderer } = await import('@jarenjs/view');
    const { document, container } = createStubHost();
    const first = new Error('first removal');
    const second = new Error('second removal');
    const probe = (id) => ['jaren-widget', { name: id, key: id, props: {} }];
    const render = createDomRenderer(container, {
      document,
      widgets: {
        a: { mount() { return {}; }, unmount() { throw first; } },
        b: { mount() { return {}; }, unmount() { throw second; } },
      },
    });
    render(['div', {}, probe('a'), ['span', { key: 's' }, 'x'], probe('b')]);
    // dropping both widgets removes them through SEPARATE destroyNode
    // calls within one frame — the second failure must not vanish
    let surfaced = null;
    try {
      render(['div', {}, ['span', { key: 's' }, 'x']]);
    }
    catch (caught) {
      surfaced = caught;
    }
    assert.ok(surfaced instanceof AggregateError,
      'both same-frame cleanup failures surface');
    assert.strictEqual(surfaced.errors[0], first);
    assert.strictEqual(surfaced.errors[1], second);
    render.destroy();
  });

  it('one app.destroy() delivers ONE JA2012 aggregating subscription, effect and widget failures', () => {
    const { document, container } = createStubHost();
    const reported = [];
    const subCause = new Error('sub cleanup');
    const effectCause = new Error('effect dispose');
    const widgetCause = new Error('widget unmount');
    const eff = () => {};
    eff.dispose = () => { throw effectCause; };
    const app = createApp({
      state: {},
      view: [{ match: '$', body: ['jaren-widget', { name: 'probe', props: {} }] }],
      subs: [{ run: 'live' }],
    }, {
      node: container,
      document,
      schedule: sync,
      onError: (error) => reported.push(error),
      effects: { eff },
      subs: { live: () => () => { throw subCause; } },
      widgets: {
        probe: {
          mount() { return {}; },
          unmount() { throw widgetCause; },
        },
      },
    });

    app.destroy();

    assert.strictEqual(serialize(container), '<div></div>');
    const cleanups = reported.filter((e) => e.code === 'JA2012');
    assert.strictEqual(cleanups.length, 1,
      'one terminal operation, one machine-readable cleanup outcome');
    const cause = cleanups[0].cause;
    assert.ok(cause instanceof AggregateError);
    assert.deepStrictEqual(cause.errors, [subCause, effectCause, widgetCause],
      'occurrence order: subscriptions, effect disposal, renderer walk');
    app.destroy();
    assert.strictEqual(reported.filter((e) => e.code === 'JA2012').length, 1);
  });
});

describe('boot-atomic afterRender (§10.5)', () => {
  const doc = {
    state: { n: 0 },
    view: [{ match: '$', body: ['main', {},
      ['jaren-widget', { name: 'probe', props: {} }]] }],
  };

  it('a failed boot never invokes afterRender, under sync and deferred schedulers', async () => {
    for (const schedule of [sync, undefined]) {
      let afterFrames = 0;
      assert.throws(() => createApp(doc, {
        node: createStubHost().container,
        document: createStubHost().document,
        ...(schedule !== undefined ? { schedule } : {}),
        afterRender: () => { afterFrames++; },
        widgets: {
          probe: {
            mount() { throw new Error('mount boom'); },
          },
        },
      }), (error) => error?.code === 'JA0007');
      // let any deferred scheduling settle before asserting
      for (let i = 0; i < 8; i++) await Promise.resolve();
      assert.strictEqual(afterFrames, 0,
        'no post-render side effect escapes a boot transaction that rolled back');
    }
  });

  it('a successful boot fires exactly one deferred afterRender', () => {
    const { document, container } = createStubHost();
    let afterFrames = 0;
    const app = createApp(doc, {
      node: container,
      document,
      schedule: sync,
      afterRender: () => { afterFrames++; },
      widgets: {
        probe: { mount() { return {}; }, unmount() {} },
      },
    });
    assert.strictEqual(afterFrames, 1,
      'the boot transaction settles into one committed-frame callback');
    app.destroy();
    assert.strictEqual(afterFrames, 1);
  });
});
