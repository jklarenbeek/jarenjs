//@ts-check
/**
 * @file The standard form controls over a DOM that implements a
 * textarea's default value (jsdom): a textarea's text child is only its
 * default, and once the operator edits it, it keeps its own value. The
 * textarea and json controls must therefore show the state — after an
 * array item is removed, after an action replaces the data — and the
 * json editor, which commits on `change`, must keep the text the
 * operator is typing through a render it did not cause.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { JSDOM } from 'jsdom';

import { createApp, createFormView, createFormActions, formEventFields } from '@jarenjs/app';
import { buildFormModel, buildFormViewModel } from '@jarenjs/forms';

/**
 * A form app over jsdom, rendering synchronously.
 * @param {object} schema
 * @param {any} data
 * @param {Record<string, any>} [actions] - extra actions beside the standard ones
 */
function mountForm(schema, data, actions = {}) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>');
  const root = /** @type {any} */ (dom.window.document.getElementById('root'));
  const model = buildFormModel(schema);
  const app = createApp({
    $app: '0.1',
    state: { data, ticks: 0 },
    view: [...createFormView(), { match: '$', body: ['main', {}, { $apply: '$.form' }] }],
    actions: { ...createFormActions({ dataPointer: '/data' }), ...actions },
  }, {
    node: root,
    schedule: (/** @type {() => void} */ flush) => flush(),
    eventFields: { ...formEventFields() },
    viewModel: (/** @type {any} */ state) => ({ form: buildFormViewModel(model, state.data) }),
  });
  /** The operator edits a control: its value, then the event its binding listens to.
   * @param {any} control @param {string} text @param {string} event */
  const edit = (control, text, event) => {
    control.value = text;
    control.dispatchEvent(new dom.window.Event(event, { bubbles: true }));
  };
  /** @param {string} selector @returns {any[]} */
  const all = (selector) => [...root.querySelectorAll(selector)];
  /** @param {string} pointer @returns {any} */
  const control = (pointer) => root.querySelector(`[data-pointer="${pointer}"] textarea, [data-pointer="${pointer}"] input`);
  const removeFirst = () => root.querySelector('button.jaren-form-remove')
    .dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  return { app, all, control, edit, removeFirst };
}

describe('the textarea and json controls show the state', () => {
  it('removing a textarea item shows the item that moved up, and the next keystroke edits that one', () => {
    const notes = { type: 'object', properties: { notes: { type: 'array', items: { type: 'string', maxLength: 500 } } } };
    const { app, all, edit, removeFirst } = mountForm(notes, { notes: ['', ''] });
    edit(all('textarea')[0], 'FIRST note', 'input');
    edit(all('textarea')[1], 'second note', 'input');
    removeFirst();
    assert.deepStrictEqual(app.getState().data.notes, ['second note']);
    assert.deepStrictEqual(all('textarea').map((t) => t.value), ['second note']);
    edit(all('textarea')[0], `${all('textarea')[0].value}!`, 'input');
    assert.deepStrictEqual(app.getState().data.notes, ['second note!'], 'the removed note never comes back');
    app.destroy();
  });

  it('removing a json item shows the item that moved up', () => {
    const list = { type: 'object', properties: { list: { type: 'array', items: {} } } };
    const { app, all, edit, removeFirst } = mountForm(list, { list: [null, null] });
    edit(all('textarea')[0], '{"first":1}', 'change');
    edit(all('textarea')[1], '{"second":2}', 'change');
    removeFirst();
    assert.deepStrictEqual(app.getState().data.list, [{ second: 2 }]);
    assert.deepStrictEqual(all('textarea').map((t) => t.value), ['{\n  "second": 2\n}']);
    app.destroy();
  });

  it('an action that replaces the data shows the new data in every control', () => {
    const profile = { type: 'object', properties: { bio: { type: 'string', maxLength: 500 }, name: { type: 'string' }, extra: {} } };
    const reset = { patch: [{ op: 'replace', path: '/data', value: '$payload' }] };
    const { app, control, edit } = mountForm(profile, { bio: 'old bio', name: 'old name', extra: { a: 1 } }, { reset });
    edit(control('/bio'), 'typed bio', 'input');
    edit(control('/name'), 'typed name', 'input');
    edit(control('/extra'), '{"b": 2}', 'change');
    app.dispatch('reset', { bio: 'fresh bio', name: 'fresh name', extra: { c: 3 } });
    assert.deepStrictEqual([control('/bio').value, control('/name').value, control('/extra').value],
      ['fresh bio', 'fresh name', '{\n  "c": 3\n}']);
    app.destroy();
  });

  it('a render the operator did not cause keeps the json text they are typing, and the text they typed', () => {
    const profile = { type: 'object', properties: { bio: { type: 'string', maxLength: 500 }, extra: {} } };
    const tick = { patch: [{ op: 'replace', path: '/ticks', value: { $add: ['$.ticks', 1] } }] };
    const { app, control, edit } = mountForm(profile, { bio: 'old bio', extra: { a: 1 } }, { tick });
    edit(control('/bio'), 'typed bio', 'input');
    // half-typed and not committed: a json control commits on change
    control('/extra').value = '{"a": 1, "b":';
    app.dispatch('tick');
    app.dispatch('tick');
    assert.strictEqual(app.getState().ticks, 2);
    assert.strictEqual(control('/extra').value, '{"a": 1, "b":');
    assert.strictEqual(control('/bio').value, 'typed bio');
    app.destroy();
  });

  it('a json commit that does not parse stores null, and the editor shows the state', () => {
    const profile = { type: 'object', properties: { extra: {} } };
    const { app, control, edit } = mountForm(profile, { extra: { a: 1 } });
    edit(control('/extra'), '{oops', 'change');
    assert.strictEqual(app.getState().data.extra, null);
    assert.strictEqual(control('/extra').value, '');
    app.destroy();
  });
});
