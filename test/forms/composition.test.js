//@ts-check
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { buildFormModel, buildFormViewModel, compileFormRules } from '@jarenjs/forms';
import { compositionFixture, compositionProjectors } from '../../benchmark/forms-composition.js';

it('the addressing contenders agree on escaped keys, arrays and absent ancestors', () => {
  const fixture = compositionFixture(3, 8);
  const projectors = compositionProjectors(fixture);
  for (const data of [fixture.data, {}, { 'level/0~': null }]) {
    const input = { ...fixture, data };
    const expected = projectors.rootPointers(input);
    assert.deepEqual(projectors.carriedCursors(input), expected);
    assert.deepEqual(projectors.foldStylesheet(input), expected);
  }
});

it('carried form cursors keep raw descendants, escaped pointers and presence-aware session state', () => {
  const model = buildFormModel({ type: 'object', properties: {
    'a/b~': { type: 'object', 'x-form': { computed: { $const: { value: 'computed' } } }, properties: {
      value: { type: 'string' }, rows: { type: 'array', items: { type: 'object', properties: { n: { type: 'number' } } } },
    } },
  } });
  const data = { 'a/b~': { value: 'raw', rows: [{ n: null }, { n: 2 }] } };
  const root = buildFormViewModel(model, data, { rules: compileFormRules(model), session: { initial: { 'a/b~': { value: 'raw', rows: [{}] } } } });
  const parent = root.children[0];
  assert.deepEqual(parent.value, { value: 'computed' });
  assert.equal(parent.children[0].value, 'raw');
  assert.equal(parent.children[0].dirty, false);
  const rows = parent.children[1];
  assert.equal(rows.items[0].children[0].pointer, '/a~1b~0/rows/0/n');
  assert.equal(rows.items[0].children[0].dirty, true, 'missing to null remains a presence change');
  assert.equal(rows.items[1].children[0].value, 2);
  assert.equal(rows.items[1].children[0].dirty, true, 'missing baseline ancestors never restart from the baseline root');
});
