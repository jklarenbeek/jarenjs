//@ts-check
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createRuleEditor } from '@jarenjs/rules';
import { mountRuleEditor, createRuleEditorWidget } from '@jarenjs/rules/component';
import { collectionHost } from '../collection/dom-host.js';

const plan = { id: 'plan', changes: Array.from({ length: 25 }, (_, i) => ({ id: `change-${i}`, entityId: `row-${i}`, field: '/count', before: { present: true, value: 1 }, proposed: 2 })) };
it('draft text and caret survive previews; stale replies cannot authorize a changed draft', async () => {
  const waits = []; let commands = 0;
  const editor = createRuleEditor({ text: '{}', preview: () => new Promise((resolve) => waits.push(resolve)), command: async () => { commands++; return { state: 'committed' }; } });
  const first = editor.preview(); editor.edit('{ "x": 1 }', 3, 4); waits[0](plan); await first;
  assert.equal(editor.state().plan, null); assert.equal(editor.state().text, '{ "x": 1 }'); assert.equal(editor.state().selectionStart, 3);
  const second = editor.preview(); waits[1](plan); await second;
  assert.equal(editor.state().selectionEnd, 4); assert.equal(editor.select('missing'), false);
  editor.select('change-24'); editor.select('change-0'); editor.select('change-0', false);
  const before = editor.state(); assert.deepEqual(before.selected, ['change-24']);
  const commit = editor.commit(); assert.equal(editor.commit(), commit); assert.equal((await commit).state, 'committed'); assert.equal(commands, 1);
  const third = editor.preview(); waits[2](plan); await third; assert.deepEqual(editor.state().selected, ['change-24']);
  editor.edit('broken', 0, 0); assert.equal((await editor.commit()).state, 'refused');
  const late = editor.preview(); editor.dispose(); waits[3](plan); await late;
  assert.equal(editor.state().plan, null); editor.edit('ignored'); assert.equal(editor.select('change-0'), false);
});

it('report-only, preview failures and command failures stay explicit JSON', async () => {
  const report = createRuleEditor({ text: '{}', preview: () => plan }); await report.preview(); report.select('change-0');
  assert.equal((await report.commit()).state, 'refused'); report.dispose();
  const bad = createRuleEditor({ text: '{}', preview: () => { throw Error('parse'); } }); await bad.preview(); assert.equal(bad.state().phase, 'error'); bad.dispose();
  const fail = createRuleEditor({ text: '{}', preview: () => plan, command: () => { throw Error('denied'); } }); await fail.preview(); fail.select('change-0'); assert.equal((await fail.commit()).state, 'error'); fail.dispose();
  assert.throws(() => createRuleEditor({ text: '', preview: null }), TypeError);
});

it('the mounted editor pages by identity and tears down existing widget resources', async () => {
  const env = collectionHost();
  const options = { text: '{}', preview: () => plan, pageSize: 10, schema: { type: 'object', properties: { count: { type: 'number', title: 'Count' } } } };
  const mounted = mountRuleEditor(env.host, options); await mounted.controller.preview();
  assert.equal(env.host.querySelectorAll('[data-rule-change]').length, 10);
  mounted.controller.select('change-24'); mounted.refresh(); assert.deepEqual(mounted.controller.state().selected, ['change-24']);
  mounted.dispose(); mounted.dispose(); assert.equal(env.host.childNodes.length, 0);
  const widget = createRuleEditorWidget(options); const handle = widget.mount(env.host, {}); widget.update(handle); widget.unmount(handle);
});

it('schema controls, delegated input and page actions preserve the current draft', async () => {
  const env = collectionHost(); let commands = 0;
  const mounted = mountRuleEditor(env.host, { text: JSON.stringify({ targets: [{ id: 'a', field: '/count' }] }), preview: () => plan,
    command: async () => { commands++; return { state: 'committed' }; }, schema: { type: 'object', properties: { count: { type: 'number' } } }, pageSize: 10 });
  const fire = (type, selector) => { const target = env.host.querySelector(selector); target.hasAttribute = (name) => target.getAttribute(name) !== null; env.host.fire(type, { target }); };
  const enabled = env.host.querySelector('[data-rule-enabled]'); enabled.checked = false; fire('change', '[data-rule-enabled]');
  assert.equal(JSON.parse(mounted.controller.state().text).targets[0].enabled, false);
  const field = env.host.querySelector('[data-rule-field]'); field.value = '/count'; fire('change', '[data-rule-field]');
  fire('change', '[data-rule-target]');
  const draft = env.host.querySelector('[data-rule-draft]'); draft.value = '{"targets":[null]}'; draft.selectionStart = 2; draft.selectionEnd = 3;
  fire('input', '[data-rule-draft]'); assert.equal(mounted.controller.state().text, '{"targets":[null]}');
  fire('click', '[data-rule-preview]'); await new Promise((resolve) => setImmediate(resolve));
  fire('click', '[data-rule-next]'); assert.equal(env.host.querySelector('[data-rule-change]').getAttribute('data-rule-change'), 'change-10');
  const selected = env.host.querySelector('[data-rule-change]'); selected.checked = true; fire('change', '[data-rule-change]');
  fire('click', '[data-rule-previous]'); assert.equal(env.host.querySelector('[data-rule-change]').getAttribute('data-rule-change'), 'change-0');
  fire('click', '[data-rule-commit]'); await new Promise((resolve) => setImmediate(resolve)); assert.equal(commands, 1);
  mounted.dispose();
});
