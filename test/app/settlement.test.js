//@ts-check
/**
 * @file DOM-originated settlement: a user event that does NOT change state
 * must still re-render, so a controlled input reconciles back to authoritative
 * state.
 *
 * The app schedules a render on a state change. A no-op, rejected, or failed
 * action leaves state identical, so without a settlement pass a control the
 * user edited would keep the user's value — the exact drift an external
 * re-audit reproduced. Settlement runs for a `binding` (DOM) source only; a
 * programmatic dispatch does not force it, since it cannot desync a control.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';

import { createApp } from '@jarenjs/app';

import { createStubHost, fire } from '../view/dom.stub.js';

const sync = (flush) => flush();

/** An app whose input's value is bound to `state.text`, firing `binding` on
 * input. `actions` is merged so a test can supply a no-op or a rejecting one. */
function inputApp(binding, actions, options = {}) {
  const { document, container } = createStubHost();
  const app = createApp({
    state: { text: 'server' },
    view: [{ match: '$', body: ['input', { value: '$.text', on: { input: binding } }] }],
    actions,
  }, { node: container, document, schedule: sync, ...options });
  return { app, input: () => container.childNodes[0] };
}

describe('app settlement — a DOM-originated no-op reconciles the control', () => {
  it('reasserts a controlled input after a no-op action', () => {
    const { input } = inputApp('noop', { noop: { patch: [] } });
    assert.strictEqual(input().value, 'server');
    input().value = 'user';               // the user types
    fire(input(), 'input', { target: input() });
    assert.strictEqual(input().value, 'server', 'the no-op still settles the DOM back to state');
  });

  it('reasserts a controlled input after a rejected action', () => {
    // validateState rejects the transition, so state is unchanged. The
    // rejection reports JA2005 through the error policy; `onError` receives it
    // so it does not throw, and the settlement render still runs.
    const errors = [];
    const { input } = inputApp('reject',
      { reject: { patch: [{ op: 'replace', path: '/text', value: 'nope' }] } },
      { validateState: (next) => next.text !== 'nope', onError: (e) => errors.push(e.code) });
    input().value = 'user';
    fire(input(), 'input', { target: input() });
    assert.deepStrictEqual(errors, ['JA2005'], 'the transition was rejected');
    assert.strictEqual(input().value, 'server', 'a rejected transition still settles the control');
  });

  it('does not force a settle for a programmatic no-op dispatch', () => {
    // A programmatic dispatch is not a DOM event and cannot have desynced a
    // control, so it must not incur an extra render.
    const { app, input } = inputApp('noop', { noop: { patch: [] } });
    input().value = 'user';
    app.dispatch('noop');
    assert.strictEqual(input().value, 'user', 'a non-DOM dispatch does not settle');
  });

  it('still reconciles normally when the action does change state', () => {
    const { input } = inputApp(
      { action: 'type', event: ['value'] },
      { type: { patch: [{ op: 'replace', path: '/text', value: '$event.value' }] } });
    input().value = 'typed';
    fire(input(), 'input', { target: { value: 'typed' } });
    assert.strictEqual(input().value, 'typed', 'a real state change flows through');
  });
});
