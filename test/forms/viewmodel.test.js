//@ts-check
import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import {
  buildFormModel,
  compileFormRules,
  buildFormViewModel,
} from '@jarenjs/forms';

const schema = {
  type: 'object',
  title: 'Profile',
  properties: {
    name: { type: 'string', minLength: 2 },
    age: { type: 'integer', minimum: 13 },
    newsletter: { type: 'boolean' },
    plan: { enum: ['free', 'pro'] },
    company: { type: 'string' },
    vatId: {
      type: 'string',
      'x-form': { visible: { $ne: ['$.company', ''] } },
    },
    total: {
      type: 'number',
      'x-form': { computed: { $sum: '$.lines[*]' } },
    },
    lines: { type: 'array', default: [], items: { type: 'number' } },
  },
  required: ['name'],
};

function tree(data, options) {
  const model = buildFormModel(schema);
  return buildFormViewModel(model, data, options);
}

function child(node, key) {
  return node.children.find((c) => c.key === key);
}

describe('buildFormViewModel', function () {
  it('composes fields, pointers and current values into one JSON tree', function () {
    const root = tree({ name: 'Jo', age: 44, newsletter: true });
    assert.strictEqual(root.pointer, '');
    assert.strictEqual(root.label, 'Profile');
    assert.strictEqual(root.control, 'object');
    const name = child(root, 'name');
    assert.strictEqual(name.pointer, '/name');
    assert.strictEqual(name.control, 'text');
    assert.strictEqual(name.value, 'Jo');
    assert.strictEqual(name.required, true);
    assert.strictEqual(child(root, 'age').value, 44);
    assert.strictEqual(child(root, 'newsletter').control, 'checkbox');
    assert.strictEqual(child(root, 'newsletter').value, true);
  });

  it('binds absent values as null, never undefined', function () {
    const name = child(tree({}), 'name');
    assert.strictEqual(name.value, null);
    assert.ok(Object.values(name).every((v) => v !== undefined || v === name.addValue));
  });

  it('precomputes select options with labels and selection', function () {
    const plan = child(tree({ plan: 'pro' }), 'plan');
    assert.strictEqual(plan.control, 'select');
    assert.deepStrictEqual(plan.options, [
      { value: 'free', label: 'free', selected: false },
      { value: 'pro', label: 'pro', selected: true },
    ]);
  });

  it('excludes rule-hidden fields and carries computed values', function () {
    const model = buildFormModel(schema);
    const rules = compileFormRules(model);
    const hidden = buildFormViewModel(model, { company: '', lines: [2, 3] }, { rules });
    assert.strictEqual(child(hidden, 'vatId'), undefined, 'invisible field excluded');
    assert.strictEqual(child(hidden, 'total').value, 5, 'computed wins over data');

    const shown = buildFormViewModel(model, { company: 'ACME', lines: [] }, { rules });
    assert.notStrictEqual(child(shown, 'vatId'), undefined);
  });

  it('folds field validation errors in when asked', function () {
    const bad = tree({ name: 'J', age: 4 }, { validateFields: true });
    assert.strictEqual(child(bad, 'name').errors.length, 1);
    assert.match(child(bad, 'name').errors[0], /at least 2/i);
    assert.strictEqual(child(bad, 'age').errors.length, 1);
    const good = tree({ name: 'Jo', age: 44 }, { validateFields: true });
    assert.deepStrictEqual(child(good, 'name').errors, []);
  });

  it('expands array items with concrete pointers and add/remove info', function () {
    const lines = child(tree({ lines: [1, 2] }), 'lines');
    assert.strictEqual(lines.control, 'array');
    assert.strictEqual(lines.items.length, 2);
    assert.strictEqual(lines.items[0].pointer, '/lines/0');
    assert.strictEqual(lines.items[1].value, 2);
    assert.strictEqual(lines.items[0].removable, true);
    assert.notStrictEqual(lines.addValue, undefined, 'array with item template can add');
  });
});
