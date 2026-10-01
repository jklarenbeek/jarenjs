//@ts-check
/**
 * @file `app.settled()` (APP-FORMAT §8.1): a host awaits its queued
 * dispatches, or the frame that shows them, instead of guessing how many
 * microtasks the loop and the renderer take.
 *
 * The renders here are scheduled a TASK later, so the two meanings of
 * "settled" come apart: the drain has committed the state while the DOM
 * still shows the old one.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { createApp } from '@jarenjs/app';
import { createStubHost, serialize } from '../view/dom.stub.js';

const document_ = {
  state: { n: 0, tag: 'p' },
  view: [{ match: '$', body: [{ $string: '$.tag' }, {}, '$.n'] }],
  actions: {
    go: { effects: [{ run: 'later' }] },
    bump: { patch: [{ op: 'replace', path: '/n', value: { $add: ['$.n', 1] } }] },
    retag: { patch: [{ op: 'replace', path: '/tag', value: '$payload' }] },
  },
};
const nextTask = (/** @type {() => void} */ flush) => { setTimeout(flush, 0); };
/** A settlement that never comes fails the test instead of hanging the run. */
const WAIT = { timeout: 5_000 };

/** @param {Record<string, any>} [options] */
function mount(options = {}) {
  const { document, container } = createStubHost();
  const app = createApp(document_, { node: container, document, schedule: nextTask, ...options });
  return { app, shown: () => serialize(container) };
}

describe('app.settled() — the drain, or the frame', () => {
  it('after a dispatch from an effect, settled() yields the new state; settled({ frame: true }) the shown one', WAIT, async () => {
    /** @type {any[]} */
    const seen = [];
    /** @type {(value?: any) => void} */
    let done = () => {};
    const finished = new Promise((resolve) => { done = resolve; });
    /** @type {any} */
    let app;
    let shown = () => '';
    ({ app, shown } = mount({ effects: { later: async (/** @type {any} */ _props, /** @type {any} */ dispatch) => {
      dispatch('bump');
      seen.push(['dispatched', app.getState().n]);
      const drained = await app.settled();
      seen.push(['settled', drained.n, shown()]);
      const painted = await app.settled({ frame: true });
      seen.push(['frame', painted.n, shown()]);
      done();
    } } }));
    await app.settled({ frame: true });
    app.dispatch('go');
    await finished;
    assert.deepStrictEqual(seen, [
      ['dispatched', 0],
      ['settled', 1, '<div><p>0</p></div>'],
      ['frame', 1, '<div><p>1</p></div>'],
    ]);
    app.destroy();
  });

  it('an idle app, a headless app and an app with no frame pending answer at once', WAIT, async () => {
    const { app, shown } = mount();
    await app.settled({ frame: true }); // the boot frame is already on screen
    assert.deepStrictEqual(await app.settled(), { n: 0, tag: 'p' });
    assert.deepStrictEqual(await app.settled({ frame: true }), { n: 0, tag: 'p' });
    app.dispatch('bump');
    assert.strictEqual(shown(), '<div><p>0</p></div>');
    assert.strictEqual((await app.settled({ frame: true })).n, 1);
    assert.strictEqual(shown(), '<div><p>1</p></div>');
    app.destroy();
    const headless = createApp(document_, { schedule: nextTask });
    headless.dispatch('bump');
    assert.strictEqual((await headless.settled({ frame: true })).n, 1);
    headless.destroy();
  });

  it('a frame the host paints itself answers the waiter, before the scheduled one', WAIT, async () => {
    const { app, shown } = mount();
    app.dispatch('bump');
    /** @type {string[]} */
    const order = [];
    const waiting = app.settled({ frame: true }).then((state) => { order.push(`settled ${state.n}`); });
    app.render();
    order.push(`painted ${shown()}`);
    await Promise.resolve();
    order.push('a microtask later');
    await waiting;
    assert.deepStrictEqual(order, ['painted <div><p>1</p></div>', 'settled 1', 'a microtask later']);
    app.destroy();
  });

  it('stop() and destroy() answer a waiter: no frame comes after either', WAIT, async () => {
    for (const end of ['stop', 'destroy']) {
      const { app } = mount();
      app.dispatch('bump');
      const waiting = app.settled({ frame: true });
      /** @type {any} */ (app)[end]();
      assert.strictEqual((await waiting).n, 1, end);
      assert.strictEqual((await app.settled({ frame: true })).n, 1, `${end}, then asked again`);
      if (end === 'stop') app.destroy();
    }
  });

  it('a frame that fails to render reports through onError and still answers its waiters', WAIT, async () => {
    /** @type {string[]} */
    const errors = [];
    const { app } = mount({ onError: (/** @type {any} */ error) => errors.push(error.name) });
    app.dispatch('retag', 'not a tag');
    const state = await app.settled({ frame: true });
    assert.strictEqual(state.tag, 'not a tag');
    assert.deepStrictEqual(errors, ['TypeError']);
    app.destroy();
  });

  it('takes { frame } and nothing else', () => {
    const { app } = mount();
    for (const options of [null, 1, [], { frame: 'yes' }, { frames: true }]) {
      assert.throws(() => app.settled(/** @type {any} */ (options)),
        (/** @type {any} */ error) => error instanceof TypeError && /^app\.settled: /.test(error.message), JSON.stringify(options));
    }
    app.destroy();
  });
});

describe("createApp forwards controlled: 'focus' and refuses any other value", () => {
  it('refuses an unknown value before booting', () => {
    const { document, container } = createStubHost();
    assert.throws(() => createApp(document_, { node: container, document, controlled: /** @type {any} */ ('always') }),
      (/** @type {any} */ error) => error instanceof TypeError && /options\.controlled is 'focus'/.test(error.message));
    assert.strictEqual(container.childNodes.length, 0);
  });

  it('a focused field keeps its text through a state change until it loses focus', async () => {
    const { document, container } = createStubHost();
    const app = createApp({
      state: { text: 'server' },
      view: [{ match: '$', body: ['input', { value: '$.text' }] }],
      actions: { refresh: { patch: [{ op: 'replace', path: '/text', value: 'refreshed' }] } },
    }, { node: container, document, schedule: (/** @type {() => void} */ f) => f(), controlled: 'focus' });
    const input = container.childNodes[0];
    input.focus();
    input.value = 'typed';
    app.dispatch('refresh');
    assert.strictEqual(input.value, 'typed');
    document.activeElement = null;
    for (const listener of input.listeners.get('focusout') ?? []) listener({ type: 'focusout', target: input });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.strictEqual(input.value, 'refreshed');
    app.destroy();
  });
});
