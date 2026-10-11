//@ts-check
/**
 * @file Forms behaviour that was wrong without failing a gate, each defect
 * reproduced before it was fixed:
 *
 * 1. A name every object inherits (`constructor`, `toString`, `__proto__`)
 *    answered as a format, a message id and a member of the data.
 * 2. An array-item template's rules applied to the tuple slots in front of
 *    it, and the submit-time copy of an `items` array (draft-07 tuple) and
 *    of `additionalItems` did not exist.
 * 3. Layer 1 judged a string, an array or a date a number because it
 *    converts to one, where the validator does not; the input coercion
 *    turned blank text into `0`.
 * 4. `removeItemAt` removed the last item for index -1 and rewrote the
 *    document for an index past the end.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import {
  buildFormModel, buildFormViewModel, compileFormRules, evaluateFormRules, createRuleMemo,
  formRulesToQueryAssertions, getFormatInfo, parseFieldInput, removeItemAt, renderFormsMessage,
  validateField,
} from '@jarenjs/forms';
import { JarenValidator } from '@jarenjs/validate';

const INHERITED = ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf'];

describe('forms — names every object inherits are not members', () => {
  it('a format name that Object.prototype answers is an unknown format', () => {
    for (const name of INHERITED) assert.strictEqual(getFormatInfo(name), null, name);
    const model = buildFormModel({ type: 'string', format: 'constructor' });
    assert.strictEqual(model.control, 'text');
    assert.deepStrictEqual(validateField(model, 'anything'), []);
  });

  it('a message id that Object.prototype answers renders as the id, in a catalog or without one', () => {
    for (const name of INHERITED) assert.strictEqual(renderFormsMessage(undefined, name, {}), name, name);
    const catalog = Object.freeze({ 'form/required': () => 'Verplicht' });
    assert.strictEqual(renderFormsMessage(catalog, 'toString', {}), 'toString');
    assert.strictEqual(renderFormsMessage(catalog, 'form/required', {}), 'Verplicht');
  });

  it('an x-form message id that Object.prototype answers falls through to the inline text, then the default', () => {
    const ruled = (message) => buildFormModel({
      type: 'object',
      properties: { a: { type: 'string', 'x-form': { assert: { $eq: ['$.a', 'x'] }, message } } },
    });
    const messageOf = (model) => evaluateFormRules(compileFormRules(model), { a: 'y' })['/a'].errors[0].message;
    assert.strictEqual(messageOf(ruled({ $msgid: 'toString', message: 'Must be x' })), 'Must be x');
    assert.strictEqual(messageOf(ruled({ $msgid: 'constructor' })), 'Invalid value');
    assert.strictEqual(messageOf(ruled({ $msgid: '__proto__' })), 'Invalid value');
  });

  it('a rule inside an array item reads an absent member as null, as the same rule outside one does', () => {
    const rule = { type: 'string', 'x-form': { assert: { $eq: ['$value', { $const: null }] } } };
    const flat = buildFormModel({ type: 'object', properties: { constructor: rule, toString: rule } });
    assert.deepStrictEqual(evaluateFormRules(compileFormRules(flat), {}), { '/constructor': {}, '/toString': {} });
    const nested = buildFormModel({
      type: 'object',
      properties: { rows: { type: 'array', items: { type: 'object', properties: { constructor: rule, toString: rule } } } },
    });
    assert.deepStrictEqual(evaluateFormRules(compileFormRules(nested), { rows: [{}] }),
      { '/rows/0/constructor': {}, '/rows/0/toString': {} });
  });

  it('a rule inside an array item reads an element of an array only by index', () => {
    const rule = { type: 'number', 'x-form': { computed: { $add: ['$value', 1] } } };
    const model = buildFormModel({
      type: 'object',
      properties: { grid: { type: 'array', items: { type: 'array', prefixItems: [rule], items: { type: 'number' } } } },
    });
    // `length` is an own property of an array but not a member of the data
    const lengthRule = buildFormModel({
      type: 'object',
      properties: { grid: { type: 'array', items: { type: 'object', properties: { length: { type: 'number', 'x-form': { computed: '$value' } } } } } },
    });
    const state = evaluateFormRules(compileFormRules(lengthRule), { grid: [[1, 2], { length: 5 }] });
    assert.deepStrictEqual(state, { '/grid/0/length': { computed: null }, '/grid/1/length': { computed: 5 } });
    assert.deepStrictEqual(evaluateFormRules(compileFormRules(model), { grid: [[4, 5]] }),
      { '/grid/0/0': { computed: 5 } });
  });
});

describe('forms — an array item template applies after the tuple slots', () => {
  const schema = {
    type: 'object',
    properties: {
      t: {
        type: 'array',
        prefixItems: [{ type: 'string', 'x-form': { visible: { $eq: ['$value', 'show'] } } }],
        items: { type: 'string', 'x-form': { enabled: true } },
      },
    },
  };

  it('the rules of the template never replace the rules of a slot', () => {
    const rules = compileFormRules(buildFormModel(schema));
    assert.deepStrictEqual(evaluateFormRules(rules, { t: ['hide', 'b'] }),
      { '/t/0': { visible: false }, '/t/1': { enabled: true } });
  });

  it('a slot its own rule hides is not rendered, and the template still renders what follows', () => {
    const model = buildFormModel(schema);
    const rules = compileFormRules(model);
    const tree = buildFormViewModel(model, { t: ['hide', 'b'] }, { rules });
    assert.deepStrictEqual(tree.children[0].items.map((item) => item.pointer), ['/t/1']);
  });

  it('a memoized evaluation agrees after an edit of the slot', () => {
    const rules = compileFormRules(buildFormModel(schema));
    const memo = createRuleMemo();
    evaluateFormRules(rules, { t: ['hide', 'b'] }, undefined, memo);
    const next = evaluateFormRules(rules, { t: ['show', 'b'] }, undefined, memo);
    assert.deepStrictEqual(next, { '/t/0': { visible: true }, '/t/1': { enabled: true } });
  });
});

describe('forms — the submit-time copy of tuple asserts', () => {
  const ok = { type: 'string', 'x-form': { assert: { $eq: ['$value', 'ok'] } } };
  const accepts = (schema, t) => new JarenValidator().compile(formRulesToQueryAssertions(schema))({ t });

  it('an items array (draft-07 tuple) copies the assert of a slot, as prefixItems does', () => {
    const schema = { type: 'object', properties: { t: { type: 'array', items: [ok, { type: 'string' }] } } };
    assert.strictEqual(accepts(schema, ['ok', 'free']), true);
    assert.strictEqual(accepts(schema, ['bad', 'free']), false);
  });

  it('additionalItems is the template after an items array, and not the slots before it', () => {
    const schema = { type: 'object', properties: { t: { type: 'array', items: [{ type: 'string' }], additionalItems: ok } } };
    const out = /** @type {any} */ (formRulesToQueryAssertions(schema));
    assert.deepStrictEqual(out.allOf[0].$query.$every, { _item0: "$['t'][1:]" });
    assert.strictEqual(accepts(schema, ['free', 'ok']), true);
    assert.strictEqual(accepts(schema, ['free', 'bad']), false);
    assert.strictEqual(accepts(schema, ['free']), true);
  });

  it('items beside prefixItems quantifies from the end of the prefix', () => {
    const schema = { type: 'object', properties: { t: { type: 'array', prefixItems: [{ type: 'string' }], items: ok } } };
    const out = /** @type {any} */ (formRulesToQueryAssertions(schema));
    assert.deepStrictEqual(out.allOf[0].$query.$every, { _item0: "$['t'][1:]" });
    assert.strictEqual(accepts(schema, ['free', 'ok', 'ok']), true);
    assert.strictEqual(accepts(schema, ['free', 'ok', 'bad']), false);
  });

  it('items without a tuple still quantifies over every element', () => {
    const schema = { type: 'object', properties: { t: { type: 'array', items: ok } } };
    const out = /** @type {any} */ (formRulesToQueryAssertions(schema));
    assert.deepStrictEqual(out.allOf[0].$query.$every, { _item0: "$['t'][*]" });
    assert.strictEqual(accepts(schema, ['ok', 'bad']), false);
  });
});

describe('forms — the submit-time copy follows $ref as the model does', () => {
  const accepts = (schema, data) => new JarenValidator().compile(formRulesToQueryAssertions(schema))(data);
  const row = { type: 'object', properties: { n: { type: 'string', 'x-form': { assert: { $eq: ['$value', 'ok'] } } } } };

  it('an item schema named by $ref carries its asserts to submit', () => {
    const schema = { type: 'object', $defs: { row }, properties: { rows: { type: 'array', items: { $ref: '#/$defs/row' } } } };
    assert.strictEqual(accepts(schema, { rows: [{ n: 'ok' }, { n: 'ok' }] }), true);
    assert.strictEqual(accepts(schema, { rows: [{ n: 'ok' }, { n: 'bad' }] }), false);
  });

  it('a property, a tuple slot and an array item named by $ref do too', () => {
    const schema = {
      type: 'object',
      $defs: { cell: { type: 'string', 'x-form': { assert: { $eq: ['$value', 'ok'] } } } },
      properties: {
        one: { $ref: '#/$defs/cell' },
        pair: { type: 'array', prefixItems: [{ $ref: '#/$defs/cell' }], items: { $ref: '#/$defs/cell' } },
      },
    };
    assert.strictEqual(accepts(schema, { one: 'ok', pair: ['ok', 'ok'] }), true);
    assert.strictEqual(accepts(schema, { one: 'bad', pair: ['ok'] }), false);
    assert.strictEqual(accepts(schema, { one: 'ok', pair: ['bad'] }), false);
    assert.strictEqual(accepts(schema, { one: 'ok', pair: ['ok', 'ok', 'bad'] }), false);
  });

  it('a $ref to an array walks it by index, and a recursive $ref ends', () => {
    const schema = {
      type: 'object',
      $defs: { line: { type: 'array', items: { type: 'string', 'x-form': { assert: { $eq: ['$value', 'ok'] } } } } },
      properties: { grid: { type: 'array', items: { $ref: '#/$defs/line' } } },
    };
    assert.strictEqual(accepts(schema, { grid: [['ok'], []] }), true);
    assert.strictEqual(accepts(schema, { grid: [[], ['bad']] }), false);
    const tree = {
      type: 'object',
      $defs: { node: { type: 'object', 'x-form': { assert: true }, properties: { kids: { type: 'array', items: { $ref: '#/$defs/node' } } } } },
      properties: { root: { $ref: '#/$defs/node' } },
    };
    assert.doesNotThrow(() => formRulesToQueryAssertions(tree));
  });
});

describe('forms — the submit-time copy of an assert on arrays inside arrays', () => {
  const ok = { type: 'string', 'x-form': { assert: { $eq: ['$value', 'ok'] } } };
  const accepts = (schema, data) => new JarenValidator().compile(formRulesToQueryAssertions(schema))(data);
  const keystrokeErrors = (schema, data) => Object.keys(evaluateFormRules(compileFormRules(buildFormModel(schema)), data))
    .filter((pointer) => evaluateFormRules(compileFormRules(buildFormModel(schema)), data)[pointer].errors !== undefined);

  it('a matrix cell is judged at submit as it is while typing', () => {
    const schema = { type: 'object', properties: { grid: { type: 'array', items: { type: 'array', items: ok } } } };
    for (const [grid, valid] of [[[['ok', 'ok'], ['ok']], true], [[['ok'], ['bad']], false], [[['bad']], false], [[[]], true], [[], true]]) {
      assert.strictEqual(accepts(schema, { grid }), valid, JSON.stringify(grid));
      assert.strictEqual(keystrokeErrors(schema, { grid }).length === 0, valid, JSON.stringify(grid));
    }
  });

  it('three levels deep, and under a tuple prefix', () => {
    const cube = { type: 'object', properties: { c: { type: 'array', items: { type: 'array', items: { type: 'array', items: ok } } } } };
    assert.strictEqual(accepts(cube, { c: [[['ok'], ['ok', 'ok']]] }), true);
    assert.strictEqual(accepts(cube, { c: [[['ok'], ['ok', 'bad']]] }), false);
    const tuple = { type: 'object', properties: { t: { type: 'array', prefixItems: [{}], items: { type: 'array', items: ok } } } };
    assert.strictEqual(accepts(tuple, { t: ['free', ['ok'], ['ok']] }), true);
    assert.strictEqual(accepts(tuple, { t: ['free', ['ok'], ['bad']] }), false);
    assert.strictEqual(accepts(tuple, { t: [['bad'], ['ok']] }), true, 'the slot in front of the template is not an element of it');
  });

  it('a row that may be null is walked by index too, and a null row holds no cell', () => {
    const schema = { type: 'object', properties: { grid: { type: 'array', items: { type: ['array', 'null'], items: ok } } } };
    for (const [grid, valid] of [[[['ok'], null, ['ok', 'ok']], true], [[null, ['ok', 'bad']], false], [[null], true]]) {
      assert.strictEqual(accepts(schema, { grid }), valid, JSON.stringify(grid));
      assert.strictEqual(keystrokeErrors(schema, { grid }).length === 0, valid, JSON.stringify(grid));
    }
  });

  it('an assert on the inner array itself sees the array, not its members', () => {
    const schema = {
      type: 'object',
      properties: { rows: { type: 'array', items: { type: 'array', items: { type: 'string' }, 'x-form': { assert: { $gt: [{ $count: '$value[*]' }, 0] } } } } },
    };
    assert.strictEqual(accepts(schema, { rows: [['a'], ['b', 'c']] }), true);
    assert.strictEqual(accepts(schema, { rows: [['a'], []] }), false);
    assert.strictEqual(keystrokeErrors(schema, { rows: [['a'], []] }).length, 1);
  });

  it('an element schema that names no type may be an array too', () => {
    const schema = {
      type: 'object',
      properties: { rows: { type: 'array', items: { 'x-form': { assert: { $gt: [{ $count: '$value[*]' }, 0] } } } } },
    };
    assert.strictEqual(accepts(schema, { rows: [['a'], ['b']] }), true);
    assert.strictEqual(accepts(schema, { rows: [['a'], []] }), false);
    assert.strictEqual(keystrokeErrors(schema, { rows: [['a'], []] }).length, 1);
  });
});

describe('forms — a number is a number', () => {
  const number = buildFormModel({ type: 'number' });
  const types = (value) => validateField(number, value).map((error) => `${error.keyword}:${error.params.type}`);

  it('layer 1 refuses what the validator refuses: a string, an array, a date', () => {
    for (const value of ['', '  ', '5', [], [7], new Date(0), {}, true]) {
      assert.deepStrictEqual(types(value), ['type:number'], JSON.stringify(value) ?? String(value));
    }
    for (const value of [0, -1.5, 1e21, 10n]) assert.deepStrictEqual(types(value), [], String(value));
  });

  it('blank and non-finite text stays text, so it is reported rather than becoming 0 or Infinity', () => {
    for (const raw of ['  ', '\t', 'Infinity', '-Infinity']) {
      assert.strictEqual(parseFieldInput(number, raw), raw, JSON.stringify(raw));
      assert.deepStrictEqual(types(parseFieldInput(number, raw)), ['type:number']);
    }
    assert.strictEqual(parseFieldInput(number, ' 7 '), 7);
    assert.strictEqual(parseFieldInput(number, '1e3'), 1000);
    assert.strictEqual(parseFieldInput(number, ''), undefined);
  });
});

describe('forms — removeItemAt removes the item it names', () => {
  const data = { a: [1, 2, 3] };

  it('an index that names no item removes nothing and returns the document itself', () => {
    for (const index of [-1, 3, 9, 1.5, NaN, Infinity]) assert.strictEqual(removeItemAt(data, '/a', index), data, String(index));
  });

  it('the canonical text of an index names the item, as a dataset or a payload carries it', () => {
    assert.deepStrictEqual(removeItemAt(data, '/a', '1'), { a: [1, 3] });
    assert.deepStrictEqual(removeItemAt(data, '/a', '0'), { a: [2, 3] });
    for (const index of ['01', '-1', '1.5', ' 1', '', 'x', '3', null, undefined]) {
      assert.strictEqual(removeItemAt(data, '/a', /** @type {any} */ (index)), data, String(index));
    }
  });

  it('an index that names an item removes exactly it', () => {
    assert.deepStrictEqual(removeItemAt(data, '/a', 0), { a: [2, 3] });
    assert.deepStrictEqual(removeItemAt(data, '/a', 2), { a: [1, 2] });
    assert.deepStrictEqual(data, { a: [1, 2, 3] });
  });
});
