//@ts-check
/**
 * Every number control in the suite reads the text it is handed as the
 * standard number action does: `<input type=number>` hands over HTML
 * floating-point text (`.5`, `-.5`, `01`) that a bare `$number` refuses.
 * The standard action's reading is `FORM_NUMBER_VALUE`, and the actions
 * that write a number control of their own — the flow inspector's, the
 * play page's, the unit converter's — read with it too.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createApp, createFormActions, FORM_NUMBER_VALUE } from '@jarenjs/app';
import { FLOW_ACTIONS } from '@jarenjs/studio/flow';
import { calcActions } from '@jarenjs/calc/component';
import { ACTIONS as SITE_ACTIONS } from '../../packages/website/src/app/actions.js';

const READS = /** @type {const} */ ([['.5', 0.5], ['-.5', -0.5], ['01', 1], ['3', 3], ['', null]]);
const schedule = (/** @type {() => void} */ f) => f();

/**
 * Each control: its app, the action it dispatches, its payload, and where its number lands.
 * @type {Record<string, () => { app: any, action: string, payload: any, read: (state: any) => unknown }>}
 */
const CONTROLS = {
  'the standard number action': () => ({
    app: createApp({ state: { data: {} }, view: [], actions: createFormActions({ cleared: 'empty' }) }, { schedule }),
    action: 'form/number', payload: { pointer: '/n' }, read: (state) => state.data.n,
  }),
  'the flow inspector': () => ({
    app: createApp({ state: { flow: { doc: { a: {} }, selection: { path: '/a' } } }, view: [], actions: FLOW_ACTIONS }, { schedule }),
    action: 'flow/f-number', payload: { pointer: '/n' }, read: (state) => state.flow.doc.a.n,
  }),
  'the play page': () => ({
    app: createApp({ state: { play: { dataValue: {} } }, view: [], actions: SITE_ACTIONS }, { schedule }),
    action: 'play/f-number', payload: { pointer: '/n' }, read: (state) => state.play.dataValue.n,
  }),
  'the unit converter': () => ({
    app: createApp({ state: { calc: { conv: { value: 2 } } }, view: [], actions: calcActions }, { schedule }),
    action: 'calc/conv-value', payload: null, read: (state) => state.calc.conv.value,
  }),
};

describe('number controls', () => {
  it('the standard number action reads with FORM_NUMBER_VALUE', () => {
    assert.ok(Object.isFrozen(FORM_NUMBER_VALUE));
    for (const cleared of /** @type {const} */ (['remove', 'empty'])) {
      assert.deepEqual(/** @type {any} */ (createFormActions({ cleared }))['form/number'].$let.v, FORM_NUMBER_VALUE);
    }
  });

  for (const [name, make] of Object.entries(CONTROLS)) {
    it(`${name} reads number text as the standard action does`, () => {
      const { app, action, payload, read } = make();
      for (const [text, value] of READS) {
        app.dispatch(action, payload, { type: 'input', target: { value: text } });
        assert.equal(read(app.getState()), value, `${JSON.stringify(text)} reads ${value}`);
      }
    });

    it(`${name} still refuses text that is no number`, () => {
      const { app, action, payload, read } = make();
      app.dispatch(action, payload, { type: 'input', target: { value: '7' } });
      for (const text of ['5.', '.', 'e5']) {
        assert.throws(() => app.dispatch(action, payload, { type: 'input', target: { value: text } }),
          { code: 'JA2002' }, JSON.stringify(text));
        assert.equal(read(app.getState()), 7);
      }
    });
  }
});
