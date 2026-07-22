//@ts-check
/**
 * @file Non-Error host-boundary closure: JavaScript permits
 * `throw null`, `throw undefined`, strings, numbers and objects, and
 * every documented host extension point (effects, subscriptions,
 * validators, extractors, listeners, observers, widgets, sinks) is
 * covered by one normalization policy — an `Error` passes by identity,
 * anything else wraps in `HostValueError` retaining the original value
 * as an OWN `cause` (set even for `undefined`), parked failures use
 * presence records so a thrown `null` can never read as "no failure",
 * and extractor failure is structurally distinct from an unknown
 * field. Isolation, draining and terminal-idempotence guarantees hold
 * for every thrown value.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { createApp, createFocusEffect, HostValueError } from '@jarenjs/app';
import { createStubHost, serialize } from '../view/dom.stub.js';

const sync = (flush) => flush();

/** Assert the documented cause policy for a wrapped report. */
function assertCause(reported, original) {
  if (original instanceof Error) {
    assert.strictEqual(reported.cause, original, 'Error identity is preserved');
  }
  else {
    assert.ok(reported.cause instanceof HostValueError,
      'a non-Error original is wrapped');
    assert.ok(Object.hasOwn(reported.cause, 'cause'),
      'even a thrown undefined is distinguishable from absence');
    assert.strictEqual(/** @type {any} */ (reported.cause).cause, original,
      'the original thrown value is recoverable by identity');
  }
}

describe('non-Error host-boundary closure', () => {
  it('an effect dispose() throwing null cannot abort terminal teardown', () => {
    const { document, container } = createStubHost();
    const log = [];
    const reported = [];
    const bad = () => {};
    bad.dispose = () => { log.push('bad.dispose'); throw null; };
    const good = () => {};
    good.dispose = () => { log.push('good.dispose'); };

    const app = createApp({
      state: {},
      view: [{ match: '$', body: ['div', {},
        ['jaren-widget', { name: 'probe', props: {} }]] }],
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

    assert.deepStrictEqual(log, ['mount', 'bad.dispose', 'good.dispose', 'unmount'],
      'later disposal and renderer teardown still ran');
    assert.strictEqual(serialize(container), '<div></div>');
    const cleanups = reported.filter((e) => e.code === 'JA2012');
    assert.strictEqual(cleanups.length, 1, 'exactly one JA2012');
    assertCause(cleanups[0], null);
    app.destroy(); // idempotent
    assert.deepStrictEqual(log, ['mount', 'bad.dispose', 'good.dispose', 'unmount']);
  });

  it('a subscription cleanup throwing null cannot skip sibling cleanup or renderer teardown', () => {
    const { document, container } = createStubHost();
    const log = [];
    const reported = [];
    const app = createApp({
      state: {},
      view: [{ match: '$', body: ['div', {},
        ['jaren-widget', { name: 'probe', props: {} }]] }],
      subs: [{ run: 'bad' }, { run: 'good' }],
    }, {
      node: container,
      document,
      schedule: sync,
      onError: (error) => reported.push(error),
      subs: {
        bad: () => () => { log.push('bad.cleanup'); throw null; },
        good: () => () => { log.push('good.cleanup'); },
      },
      widgets: {
        probe: {
          mount() { return {}; },
          unmount() { log.push('unmount'); },
        },
      },
    });

    app.destroy();

    assert.deepStrictEqual(log, ['bad.cleanup', 'good.cleanup', 'unmount']);
    assert.strictEqual(serialize(container), '<div></div>');
    const cleanups = reported.filter((e) => e.code === 'JA2012');
    assert.strictEqual(cleanups.length, 1);
    assertCause(cleanups[0], null);
  });

  it('a listener throwing null is one JA2011; later listeners and the render still converge', () => {
    const { document, container } = createStubHost();
    const seen = [];
    const reported = [];
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
    app.subscribe(() => { throw null; });
    app.subscribe((state) => seen.push(state.n));

    app.dispatch('bump');

    assert.deepStrictEqual(seen, [1], 'the later listener still ran');
    assert.strictEqual(serialize(container), '<div><p>1</p></div>',
      'the DOM converged to the committed state');
    const isolated = reported.filter((e) => e.code === 'JA2011');
    assert.strictEqual(isolated.length, 1);
    assertCause(isolated[0], null);
    app.destroy();
  });

  it('a validator throwing null is JA2015 and queued work still commits', () => {
    const reported = [];
    const app = createApp({
      state: { n: 0 },
      view: [{ match: '$', body: ['p', {}, '$.n'] }],
      actions: {
        start: {
          patch: [{ op: 'replace', path: '/n', value: 1 }],
          effects: [{ run: 'queue' }],
        },
        bad: { patch: [{ op: 'replace', path: '/n', value: 2 }] },
        good: { patch: [{ op: 'replace', path: '/n', value: 3 }] },
      },
    }, {
      schedule: sync,
      onError: (error) => reported.push(error),
      effects: {
        queue: (props, dispatch) => {
          dispatch('bad');
          dispatch('good');
        },
      },
      validateState: (next, context) => {
        if (context.action === 'bad') throw null;
        return true;
      },
    });

    app.dispatch('start');

    assert.strictEqual(app.getState().n, 3, 'the queued good transition committed');
    const validatorFailures = reported.filter((e) => e.code === 'JA2015');
    assert.strictEqual(validatorFailures.length, 1);
    assertCause(validatorFailures[0], null);
    app.destroy();
  });

  it('an extractor throwing null or undefined is JA2002, never JA2009', () => {
    for (const thrown of [null, undefined]) {
      const reported = [];
      const seen = [];
      const app = createApp({
        state: { got: 'unset' },
        view: [{ match: '$', body: ['p', {}, 'x'] }],
        actions: { pick: { state: { got: '$event.tokens' } } },
      }, {
        schedule: sync,
        onError: (error) => reported.push(error),
        eventFields: {
          tokens: () => { throw thrown; },
        },
      });
      app.subscribe((state) => seen.push(state.got));
      app.dispatch('pick', null, { type: 'change' }, ['tokens']);

      assert.deepStrictEqual(seen, [null],
        'the member bound null and the action ran');
      assert.strictEqual(reported.length, 1);
      assert.strictEqual(reported[0].code, 'JA2002',
        `thrown ${String(thrown)} is a failure, not an unknown field`);
      assert.ok(!reported.some((e) => e.code === 'JA2009'));
      assertCause(reported[0], thrown);
      app.destroy();
    }
  });

  it('external and in-hook destroy report one JA2012 for every thrown value class', () => {
    const values = [new Error('boom'), null, undefined, 'failed', { kind: 'failed' }];
    for (const value of values) {
      for (const inHook of [false, true]) {
        const { document, container } = createStubHost();
        const log = [];
        const reported = [];
        /** @type {any} */
        let app = null;
        app = createApp({
          state: { n: 0 },
          view: [{ match: '$', body: ['div', {},
            ['jaren-widget', { name: 'thrower', key: 't', props: { n: '$.n' } }],
            ['jaren-widget', { name: 'sibling', key: 's', props: { n: '$.n' } }],
          ] }],
          actions: { bump: { state: { n: 1 } } },
        }, {
          node: container,
          document,
          schedule: sync,
          onError: (error) => reported.push(error),
          widgets: {
            thrower: {
              mount() { return {}; },
              update() { if (inHook) app.destroy(); },
              unmount() { log.push('unmount:thrower'); throw value; },
            },
            sibling: {
              mount() { return {}; },
              update() {},
              unmount() { log.push('unmount:sibling'); },
            },
          },
        });

        if (inHook) app.dispatch('bump');
        else app.destroy();

        const label = `${inHook ? 'in-hook' : 'external'} ${String(value)}`;
        assert.deepStrictEqual(log, ['unmount:thrower', 'unmount:sibling'], label);
        assert.strictEqual(serialize(container), '<div></div>', label);
        const cleanups = reported.filter((e) => e.code === 'JA2012');
        assert.strictEqual(cleanups.length, 1, label);
        assertCause(cleanups[0], value);
        app.destroy(); // idempotent either way
        assert.deepStrictEqual(log, ['unmount:thrower', 'unmount:sibling'], label);
      }
    }
  });

  it('an onError sink throwing null is retained and surfaces after the drain', () => {
    const app = createApp({
      state: {},
      view: [{ match: '$', body: ['p', {}, 'x'] }],
    }, {
      schedule: sync,
      onError: () => { throw null; },
    });
    assert.throws(
      () => app.dispatch('missing'),
      (thrown) => thrown === null,
      'the sink value surfaces by identity after the drain completes');
    app.destroy();
  });

  it('a focus sink throwing null is retained; sibling intents still resolve', () => {
    const { document, container } = createStubHost();
    const input = document.createElement('input');
    input.setAttribute('data-ref', 'ok');
    container.appendChild(input);

    const focus = createFocusEffect({
      container,
      onError: () => { throw null; },
    });
    const dispatch = () => {};
    focus({ ref: 'missing-a' }, dispatch);
    focus({ ref: 'ok' }, dispatch);

    assert.throws(() => focus.flush(), (thrown) => thrown === null);
    assert.strictEqual(document.activeElement, input,
      'the sibling intent resolved before the sink value surfaced');
    focus.dispose();
  });
});
