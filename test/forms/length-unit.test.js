//@ts-check
/**
 * @file A form counts string length in the unit its model was built with.
 *
 * The field check counted graphemes whatever the host's validator
 * counted: `buildFormModel` read no unit (a `lengthUnit` handed to it was
 * ignored without a word), so a host that validates in code points got a
 * form that took `maxLength: 1` for a two-code-point cluster its
 * validator refuses. `buildFormModel` now takes the validator's own two
 * options, `lengthUnit` and `useGrapheme`, and every field below the root
 * counts in that unit.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JarenValidator } from '@jarenjs/validate';
import { buildFormModel, buildFormViewModel, validateAllFields, validateField } from '@jarenjs/forms';

const E_COMBINING = 'e\u{0301}'; // 2 UTF-16 units, 2 code points, 1 grapheme
const FACE = '\u{1F600}'; // 2, 1, 1
const FAMILY = '\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}'; // 8, 5, 1

const schema = {
  type: 'object',
  properties: {
    name: { type: 'string', maxLength: 1 },
    tags: { type: 'array', items: { type: 'string', maxLength: 1 } },
    pair: { type: 'array', prefixItems: [{ type: 'string', maxLength: 1 }], items: { maxLength: 1 } },
    deep: { type: 'object', properties: { inner: { minLength: 2 } } },
  },
};

/** Every field of a model, the root first. @param {any} field @returns {any[]} */
const fieldsOf = (field) => [field, ...(field.children ?? []).flatMap(fieldsOf), ...(field.tuple ?? []).flatMap(fieldsOf), ...(field.item ? fieldsOf(field.item) : [])];

describe('buildFormModel takes the validator\'s length unit', () => {
  it('counts graphemes by default, on every field', () => {
    const fields = fieldsOf(buildFormModel(schema));
    assert.equal(fields.length, 9);
    assert.deepEqual([...new Set(fields.map((field) => field.lengthUnit))], ['grapheme']);
  });

  it('gives every field below the root the unit: a member, an item, a tuple slot, a nested member', () => {
    for (const unit of ['grapheme', 'codepoint', 'utf16']) {
      const fields = fieldsOf(buildFormModel(schema, { lengthUnit: unit }));
      assert.deepEqual([...new Set(fields.map((field) => field.lengthUnit))], [unit]);
    }
  });

  it('reads useGrapheme as the validator does, lengthUnit winning', () => {
    /** @type {[object | undefined, string][]} */
    const table = [
      [undefined, 'grapheme'], [{}, 'grapheme'], [{ useGrapheme: true }, 'grapheme'], [{ useGrapheme: false }, 'utf16'],
      [{ lengthUnit: undefined, useGrapheme: false }, 'utf16'], [{ lengthUnit: null, useGrapheme: false }, 'utf16'],
      [{ useGrapheme: false, lengthUnit: 'codepoint' }, 'codepoint'], [{ useGrapheme: false, lengthUnit: 'grapheme' }, 'grapheme'],
      [{ useGrapheme: true, lengthUnit: 'utf16' }, 'utf16'],
    ];
    for (const [options, unit] of table) assert.equal(buildFormModel(schema, options).lengthUnit, unit, JSON.stringify(options));
  });

  it('refuses a unit that names none, as the validator does: read on, it would count graphemes', () => {
    for (const unit of ['bytes', 'Codepoint', 'utf-16', '', 5, true, {}]) {
      assert.throws(() => buildFormModel(schema, { lengthUnit: unit }), (error) => error instanceof TypeError
        && /^buildFormModel: lengthUnit must be 'grapheme', 'codepoint' or 'utf16', got /.test(error.message), JSON.stringify(unit));
      assert.throws(() => new JarenValidator({ lengthUnit: unit }).compile(schema), TypeError, JSON.stringify(unit));
    }
    assert.throws(() => buildFormModel(schema, { lengthUnit: 'bytes' }), { message: 'buildFormModel: lengthUnit must be \'grapheme\', \'codepoint\' or \'utf16\', got "bytes"' });
  });

  it('keeps the translation hook beside the unit', () => {
    const model = buildFormModel(schema, { lengthUnit: 'codepoint', t: (msgid, fallback) => (msgid === '/name#label' ? 'Naam' : fallback) });
    assert.deepEqual([model.children[0].label, model.children[0].lengthUnit], ['Naam', 'codepoint']);
  });
});

describe('a field counts in its unit, as a validator with that unit', () => {
  /** @param {object} options @param {object} data */
  const both = (options, data) => {
    const form = Object.fromEntries(Object.entries(validateAllFields(buildFormModel(schema, options), data))
      .map(([pointer, errors]) => [pointer, errors.map((error) => `${error.keyword} ${/** @type {any} */ (error.params).len}`)]));
    const result = new JarenValidator({ ...options, collectErrors: true }).compile(schema)(data);
    // the validator also names `items` on the array above an item that failed
    return [form, [...new Set(result.errors.filter((/** @type {any} */ error) => error.keyword !== 'items').map((/** @type {any} */ error) => error.instancePath))].sort()];
  };

  it('counts a member, an item, a tuple slot and a nested member in the unit', () => {
    const data = { name: E_COMBINING, tags: ['a', E_COMBINING], pair: [E_COMBINING, E_COMBINING], deep: { inner: E_COMBINING } };
    const [graphemes, refusedByDefault] = both({}, data);
    assert.deepEqual(graphemes, { '/deep/inner': ['minLength 1'] });
    assert.deepEqual(refusedByDefault, ['/deep/inner']);
    for (const options of [{ lengthUnit: 'codepoint' }, { lengthUnit: 'utf16' }, { useGrapheme: false }]) {
      const [form, refused] = both(options, data);
      assert.deepEqual(form, { '/name': ['maxLength 2'], '/tags/1': ['maxLength 2'], '/pair/0': ['maxLength 2'], '/pair/1': ['maxLength 2'] }, JSON.stringify(options));
      assert.deepEqual(refused, ['/name', '/pair/0', '/pair/1', '/tags/1'], JSON.stringify(options));
    }
  });

  it('tells the three units apart on one string', () => {
    /** @type {[string, object, number][]} */
    const table = [
      [FACE, {}, 1], [FACE, { lengthUnit: 'codepoint' }, 1], [FACE, { lengthUnit: 'utf16' }, 2],
      [FAMILY, {}, 1], [FAMILY, { lengthUnit: 'codepoint' }, 5], [FAMILY, { lengthUnit: 'utf16' }, 8],
      [E_COMBINING, { lengthUnit: 'grapheme' }, 1], [E_COMBINING, { lengthUnit: 'codepoint' }, 2],
    ];
    for (const [text, options, length] of table) {
      const field = buildFormModel({ maxLength: 0 }, options);
      assert.deepEqual(validateField(field, text).map((error) => error.params), [{ limit: 0, len: length }], `${JSON.stringify(options)} ${length}`);
      const atLimit = { maxLength: length, minLength: length };
      assert.deepEqual(validateField(buildFormModel(atLimit, options), text), []);
      assert.equal(new JarenValidator(options).compile(atLimit)(text), true);
      assert.equal(new JarenValidator(options).compile({ maxLength: length - 1 })(text), false);
    }
  });

  it('counts in the unit in the view model too', () => {
    const model = buildFormModel(schema, { lengthUnit: 'codepoint' });
    const tree = buildFormViewModel(model, { name: E_COMBINING }, { validateFields: true });
    assert.deepEqual(tree.children[0].errors, ['Must be at most 1 character (currently 2)']);
    assert.deepEqual(buildFormViewModel(buildFormModel(schema), { name: E_COMBINING }, { validateFields: true }).children[0].errors, []);
  });

  it('counts graphemes on a field that holds no unit', () => {
    const { lengthUnit: _unit, ...field } = buildFormModel({ maxLength: 1 }, { lengthUnit: 'codepoint' });
    assert.deepEqual(validateField(/** @type {any} */ (field), E_COMBINING), []);
  });
});
