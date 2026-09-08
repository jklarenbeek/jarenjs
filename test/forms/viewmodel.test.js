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

  it('carries the format\'s preview hint through to the node, as data', function () {
    // the host decides: one with a map renderer draws `preview.kind ===
    // 'map'` beside the control, one without ignores the member
    const model = buildFormModel({
      type: 'object',
      properties: {
        where: { type: 'string', format: 'geojson' },
        mail: { type: 'string', format: 'email' },
      },
    });
    const root = buildFormViewModel(model, { where: '{"type":"Point","coordinates":[4.9,52.4]}' });
    const where = child(root, 'where');
    assert.deepStrictEqual(where.preview, { kind: 'map' });
    assert.strictEqual(where.control, 'textarea');
    assert.strictEqual(where.value, '{"type":"Point","coordinates":[4.9,52.4]}', 'the value stays the text');
    assert.strictEqual(child(root, 'mail').preview, null);
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
      { value: 'free', key: '"free"', label: 'free', selected: false },
      { value: 'pro', key: '"pro"', label: 'pro', selected: true },
    ]);
  });

  it('gives every option a reversible key for string-valued controls', function () {
    const typed = buildFormViewModel(
      buildFormModel({
        type: 'object',
        properties: { size: { enum: [1, 2.5, true, null, 'x'] } },
      }),
      { size: 2.5 });
    assert.deepStrictEqual(child(typed, 'size').options.map((o) => o.key),
      ['1', '2.5', 'true', 'null', '"x"']);
    // the key round-trips to the typed value, which String(v) would not
    for (const option of child(typed, 'size').options)
      assert.deepStrictEqual(JSON.parse(option.key), option.value);
  });

  it('selects structured enum values by JSON equality after a data round trip', function () {
    const values = [{ x: 1 }, { x: 2 }, [1, { x: 2 }]];
    const model = buildFormModel({ enum: values });
    for (let i = 0; i < values.length; i++) {
      const data = JSON.parse(JSON.stringify(values[i]));
      const node = buildFormViewModel(model, data);
      assert.deepStrictEqual(node.options.map((option) => option.selected),
        values.map((_, index) => index === i));
    }
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

  it('fills remaining tuple prefixes before using the tail item starter in both schema dialects', function () {
    const prefix = [{ type: 'string', default: 'prefix' }, { type: 'boolean', default: true }];
    const rest = { type: 'number', default: 7 };
    for (const tupleSchema of [
      { type: 'array', prefixItems: prefix, items: rest },
      { type: 'array', items: prefix, additionalItems: rest },
    ]) {
      const model = buildFormModel(tupleSchema);
      const data = [];
      for (const expected of ['prefix', true, 7]) {
        const node = buildFormViewModel(model, data);
        assert.strictEqual(node.addValue, expected);
        data.push(node.addValue);
      }
      assert.deepStrictEqual(data, ['prefix', true, 7]);
    }
  });
});
