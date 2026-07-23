//@ts-check
/**
 * @file Scheduler/ownership closure: boot is atomic under EVERY
 * scheduler (a boot frame commits inside the boot window, so the
 * deferred first `afterRender` acts on the final boot DOM); the
 * no-`update` recycle fallback is phase-sensitive (a failure before
 * the old instance's teardown had its chance preserves ownership, so
 * the resource is still released later); an unenumerable effect
 * registry rejects the boot before any resource is acquired; and an
 * in-hook `app.destroy()` still delivers ONE destroy-wide `JA2012`
 * after the deferred renderer teardown completes.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { createApp, createFocusEffect } from '@jarenjs/app';
import { createStubHost, serialize } from '../view/dom.stub.js';

const sync = (flush) => flush();

describe('boot atomicity across schedulers', () => {
  function bootDoc() {
    return {
      state: { show: false },
      view: [{ match: '$', body: ['main', {},
        { $if: ['$.show', ['button', { 'data-ref': 'target' }, 'Target']] },
      ] }],
      actions: {
        reveal: {
          state: { show: true },
          effects: [{ run: 'focus', with: { ref: 'target' } }],
        },
      },
      subs: [{ run: 'eager' }],
    };
  }

  it('a boot subscription that changes state and requests focus settles identically under sync and default schedulers', async () => {
    for (const [label, schedule] of [['sync', sync], ['default', undefined]]) {
      const { document, container } = createStubHost();
      const focus = createFocusEffect({ container });
      const app = createApp(bootDoc(), {
        node: container,
        document,
        ...(schedule !== undefined ? { schedule } : {}),
        effects: { focus },
        afterRender: focus.flush,
        subs: {
          eager: (props, dispatch) => { dispatch('reveal'); },
        },
      });
      // any pending microtasks settle before asserting
      for (let i = 0; i < 8; i++) await Promise.resolve();

      assert.match(serialize(container), /data-ref="target"/,
        `${label}: the boot transaction's final DOM committed`);
      assert.strictEqual(
        document.activeElement?.getAttribute('data-ref'), 'target',
        `${label}: afterRender ran against the final boot DOM, not the old one`);
      app.destroy();
    }
  });
});

describe('phase-sensitive recycle ownership', () => {
  it('a transient unmount lookup failure never leaks the old resource', () => {
    const { document, container } = createStubHost();
    const live = new Set();
    const reported = [];
    let nextId = 0;
    let failLookups = 1; // the first unmount lookup fails, later ones work
    const target = {
      mount(_node, props) {
        const handle = { id: nextId++, n: props.n };
        live.add(handle);
        return handle;
      },
      // no update(): changed props take the recycle fallback
      unmount(handle) {
        live.delete(handle);
      },
    };
    const definition = new Proxy(target, {
      get(t, key, receiver) {
        if (key === 'unmount' && failLookups > 0) {
          failLookups--;
          throw new Error('transient unmount lookup');
        }
        return Reflect.get(t, key, receiver);
      },
    });

    const app = createApp({
      state: { n: 0 },
      view: [{ match: '$', body: ['jaren-widget', { name: 'probe', props: { n: '$.n' } }] }],
      actions: { bump: { patch: [{ op: 'replace', path: '/n', value: '$payload' }] } },
    }, {
      node: container,
      document,
      schedule: sync,
      onError: (error) => reported.push(error),
      widgets: { probe: definition },
    });
    assert.strictEqual(live.size, 1, 'the old resource is acquired');

    app.dispatch('bump', 1); // recycle: the unmount LOOKUP fails
    assert.strictEqual(live.size, 1,
      'ownership of the old resource is preserved — no replacement mounted over it');

    app.dispatch('bump', 2); // the poisoned widget is replaced
    assert.strictEqual(live.size, 1,
      'the old resource was released during replacement, the fresh one acquired');

    app.destroy();
    assert.strictEqual(live.size, 0,
      'terminal destroy releases everything — nothing leaked across the transient failure');
    assert.strictEqual(serialize(container), '<div></div>');
  });
});

describe('effect-registry enumeration and boot ownership', () => {
  it('an unenumerable effect registry rejects the boot before any resource is acquired', () => {
    const { document, container } = createStubHost();
    const log = [];
    const effects = new Proxy({}, {
      ownKeys() { throw new Error('ownKeys failed'); },
    });
    assert.throws(() => createApp({
      state: {},
      view: [{ match: '$', body: ['jaren-widget', { name: 'probe', props: {} }] }],
    }, {
      node: container,
      document,
      schedule: sync,
      effects,
      widgets: {
        probe: {
          mount() { log.push('mount'); return {}; },
          unmount() { log.push('unmount'); },
        },
      },
    }), (error) => error?.code === 'JA0007');
    assert.deepStrictEqual(log, [],
      'rejection happened before ownership: nothing was ever acquired');
  });
});

describe('in-hook destroy keeps the single cleanup aggregate', () => {
  it('an effect disposal failure plus a deferred widget unmount failure deliver ONE JA2012', () => {
    const { document, container } = createStubHost();
    const reported = [];
    const effectCause = new Error('effect dispose');
    const widgetCause = new Error('widget unmount');
    const eff = () => {};
    eff.dispose = () => { throw effectCause; };
    /** @type {any} */
    let app = null;
    app = createApp({
      state: { n: 0 },
      view: [{ match: '$', body: ['jaren-widget', { name: 'probe', props: { n: '$.n' } }] }],
      actions: { bump: { patch: [{ op: 'replace', path: '/n', value: 1 }] } },
    }, {
      node: container,
      document,
      schedule: sync,
      onError: (error) => reported.push(error),
      effects: { eff },
      widgets: {
        probe: {
          mount() { return {}; },
          update() { app.destroy(); },
          unmount() { throw widgetCause; },
        },
      },
    });

    app.dispatch('bump');

    assert.strictEqual(serialize(container), '<div></div>');
    const cleanups = reported.filter((e) => e.code === 'JA2012');
    assert.strictEqual(cleanups.length, 1,
      'the collector stayed open across the deferred renderer teardown');
    const cause = cleanups[0].cause;
    assert.ok(cause instanceof AggregateError);
    assert.deepStrictEqual(cause.errors, [effectCause, widgetCause],
      'occurrence order: effect disposal first, the deferred widget walk second');
    app.destroy();
    assert.strictEqual(reported.filter((e) => e.code === 'JA2012').length, 1);
  });
});
