//@ts-check
/**
 * @file `afterRender` is a committed-live-frame boundary: it runs
 * exactly once per settled, NONTERMINAL committed frame — including a
 * frame that parks a widget hook error, delivered afterwards — and
 * never after terminal teardown. Focus/measurement intents therefore
 * see the committed DOM of their own transition, and error delivery
 * cannot starve the committed frame's callback.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { createApp, createFocusEffect } from '@jarenjs/app';
import { createStubHost, serialize } from '../view/dom.stub.js';

const appDoc = {
  state: { n: 0, show: false },
  view: [{ match: '$', body: ['main', {},
    ['output', {}, '$.n'],
    { $if: ['$.show', ['button', { 'data-ref': 'target' }, 'Target']] },
    ['jaren-widget', { name: 'probe', props: { n: '$.n' } }],
  ] }],
  actions: { bump: { state: { n: 1, show: true } } },
};

describe('afterRender is a committed-live-frame boundary', () => {
  it('does not run after update-triggered terminal teardown', () => {
    const { document, container } = createStubHost();
    let afterFrames = 0;
    let app;

    app = createApp(appDoc, {
      node: container,
      document,
      schedule: (flush) => flush(),
      afterRender: () => { afterFrames++; },
      widgets: {
        probe: {
          mount() { return {}; },
          update() { app.destroy(); },
          unmount() {},
        },
      },
    });

    assert.strictEqual(afterFrames, 1);
    app.dispatch('bump');
    assert.strictEqual(afterFrames, 1,
      'terminal teardown is not a committed live frame');
    assert.strictEqual(serialize(container), '<div></div>');
  });

  it('runs once when a committed frame parks a widget update Error', () => {
    const { document, container } = createStubHost();
    const updateError = new Error('update boom');
    const reported = [];
    const focus = createFocusEffect({ container });
    let afterFrames = 0;

    const app = createApp(appDoc, {
      node: container,
      document,
      schedule: (flush) => flush(),
      onError: (error) => reported.push(error),
      effects: { focus },
      afterRender: () => {
        afterFrames++;
        focus.flush();
      },
      widgets: {
        probe: {
          mount() { return {}; },
          update() { throw updateError; },
          unmount() {},
        },
      },
    });

    assert.strictEqual(afterFrames, 1);
    focus({ ref: 'target', op: 'focus' }, () => {});
    app.dispatch('bump');

    assert.match(serialize(container), /<output>1<\/output>/,
      'the state frame committed despite the parked widget error');
    assert.strictEqual(afterFrames, 2,
      'that committed frame receives exactly one afterRender');
    assert.strictEqual(
      document.activeElement?.getAttribute('data-ref'),
      'target',
      'focus.flush runs against the committed frame',
    );
    assert.deepStrictEqual(reported, [updateError]);
    app.destroy();
  });

  it('runs before the default sink rethrows a parked widget Error', () => {
    const { document, container } = createStubHost();
    const updateError = new Error('update boom');
    const focus = createFocusEffect({ container });
    let afterFrames = 0;

    const app = createApp(appDoc, {
      node: container,
      document,
      schedule: (flush) => flush(),
      effects: { focus },
      afterRender: () => {
        afterFrames++;
        focus.flush();
      },
      widgets: {
        probe: {
          mount() { return {}; },
          update() { throw updateError; },
          unmount() {},
        },
      },
    });

    focus({ ref: 'target', op: 'focus' }, () => {});
    assert.throws(
      () => app.dispatch('bump'),
      (error) => error === updateError,
      'the default sink still surfaces the original parked error',
    );

    assert.match(serialize(container), /<output>1<\/output>/);
    assert.strictEqual(afterFrames, 2,
      'default error delivery cannot starve afterRender');
    assert.strictEqual(
      document.activeElement?.getAttribute('data-ref'),
      'target',
    );
    app.destroy();
  });
});
