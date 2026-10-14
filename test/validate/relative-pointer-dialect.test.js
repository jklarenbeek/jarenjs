//@ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JarenValidator, ValidationOptions, ValidatorOptions } from '@jarenjs/validate';
import { jsonFormats } from '@jarenjs/formats';

/**
 * `relativePointerDialect` selects the Relative JSON Pointer grammar of the
 * `data` and `$data` keywords and of the `relative-json-pointer` format.
 * `'handrews-01'` is the default (the grammar the official format suite
 * asserts); `'bhutton-00'` adds index manipulation (`0+1`, `1-1/name`, `0-1#`).
 */
const BHUTTON = { relativePointerDialect: /** @type {const} */ ('bhutton-00') };
const HANDREWS = { relativePointerDialect: /** @type {const} */ ('handrews-01') };

/**
 * @param {object} options
 * @param {any} schema
 */
const compile = (options, schema) => new JarenValidator(options).compile(schema);

describe('relativePointerDialect: the data keyword', () => {
  // Each item must not exceed the item after it (the last has none).
  const ascending = { type: 'array', items: { type: 'number', data: { maximum: '0+1' } } };

  it('refuses index manipulation when the schema compiles, by default and as handrews-01', () => {
    for (const options of [{}, HANDREWS]) {
      assert.throws(() => compile(options, ascending), { name: 'JSONPointerSyntaxError', message: /'0\+1'/ });
    }
  });

  it('resolves 0+1 to the next sibling under bhutton-00', () => {
    const validate = compile(BHUTTON, ascending);
    assert.equal(validate([1, 2, 3]), true);
    assert.equal(validate([1, 3, 2]), false);
    assert.equal(validate([5]), true);
    assert.equal(validate([]), true);
  });

  it('resolves a shifted pointer with a trailing path and a negative shift', () => {
    // Each item's value must be at least the `floor` of the item before it.
    const schema = { type: 'array', items: { type: 'object', properties: { v: { type: 'number', data: { minimum: '1-1/floor' } } } } };
    const validate = compile(BHUTTON, schema);
    assert.equal(validate([{ v: 0 }, { floor: 3, v: 3 }, { v: 4 }]), true);
    assert.equal(validate([{ v: 0 }, { floor: 3, v: 3 }, { v: 2 }]), false);
  });

  it('still takes every default-grammar reference under bhutton-00', () => {
    const schema = { type: 'object', properties: { limit: { type: 'number' }, n: { type: 'number', data: { maximum: '1/limit' } } } };
    const validate = compile(BHUTTON, schema);
    assert.equal(validate({ limit: 5, n: 5 }), true);
    assert.equal(validate({ limit: 5, n: 6 }), false);
  });
});

describe('relativePointerDialect: the $data keyword', () => {
  const ascending = { type: 'array', items: { type: 'number', maximum: { $data: '0+1' } } };

  it('refuses index manipulation by default, accepts it under bhutton-00', () => {
    assert.throws(() => compile({}, ascending), { name: 'JSONPointerSyntaxError', message: /'0\+1'/ });
    const validate = compile(BHUTTON, ascending);
    assert.equal(validate([1, 2, 3]), true);
    assert.equal(validate([1, 3, 2]), false);
  });

  it('reaches the $data-only required and uniqueItems', () => {
    const required = { type: 'array', items: { type: 'object', required: { $data: '0+1/req' } } };
    assert.throws(() => compile({}, required), { name: 'JSONPointerSyntaxError' });
    const mustHave = compile(BHUTTON, required);
    assert.equal(mustHave([{ x: 1 }, { req: ['x'] }]), true);
    assert.equal(mustHave([{ x: 1 }, { req: ['y'] }]), false);

    const unique = { type: 'array', items: { uniqueItems: { $data: '0+1/u' } } };
    assert.throws(() => compile({}, unique), { name: 'JSONPointerSyntaxError' });
    const mustBeUnique = compile(BHUTTON, unique);
    assert.equal(mustBeUnique([[1, 1], { u: true }]), false);
    assert.equal(mustBeUnique([[1, 1], { u: false }]), true);
    assert.equal(mustBeUnique([[1, 2], { u: true }]), true);
  });
});

describe('relativePointerDialect: the relative-json-pointer format', () => {
  const schema = { format: 'relative-json-pointer' };
  const both = (/** @type {object} */ options) => compile({ formatAssertion: true, formats: jsonFormats, ...options }, schema);

  it('keeps the default grammar: index manipulation and +1/foo/bar are invalid', () => {
    for (const options of [{}, HANDREWS]) {
      const validate = both(options);
      assert.deepEqual(['0+1', '1-1/name', '0-1#', '+1/foo/bar'].map((v) => validate(v)), [false, false, false, false]);
      assert.deepEqual(['0', '1/foo', '0#', '12/a/b'].map((v) => validate(v)), [true, true, true, true]);
    }
  });

  it('accepts index manipulation under bhutton-00 and still refuses what neither draft allows', () => {
    const validate = both(BHUTTON);
    assert.deepEqual(['0+1', '1-1/name', '0-1#'].map((v) => validate(v)), [true, true, true]);
    assert.deepEqual(['0', '1/foo', '0#'].map((v) => validate(v)), [true, true, true]);
    assert.deepEqual(['+1/foo/bar', '0+', '0+1x', '01+1', '0+01', '0+1#x', 'a', ''].map((v) => validate(v)), [false, false, false, false, false, false, false, false]);
  });

  it('answers the same with errors collected', () => {
    const validate = both({ ...BHUTTON, collectErrors: true });
    assert.equal(validate('0+1').valid, true);
    const result = validate('+1/foo/bar');
    assert.equal(result.valid, false);
    assert.equal(result.errors[0].keyword, 'format');
    assert.equal(both({ collectErrors: true })('0+1').valid, false);
  });

  it('is what the format compiler reads from the validation object', () => {
    const make = (/** @type {any} */ options) => jsonFormats['relative-json-pointer'](
      { options: { skipErrors: true, ...options }, createErrorHandler: () => () => false },
      { format: 'relative-json-pointer' });
    assert.equal(make({})('0+1'), false);
    assert.equal(make({ relativePointerDialect: 'handrews-01' })('0+1'), false);
    assert.equal(make({ relativePointerDialect: 'bhutton-00' })('0+1'), true);
    assert.throws(() => make({ relativePointerDialect: 'bhutton' }), { name: 'TypeError', message: /dialect must be/ });
  });

  it('reaches a format named by the data keyword', () => {
    // Each string must match the format its next sibling names.
    const named = { type: 'array', items: { type: 'string', data: { format: '0+1' } } };
    const items = ['0+1', 'relative-json-pointer'];
    const options = { formatAssertion: true, formats: jsonFormats };
    assert.throws(() => compile(options, named), { name: 'JSONPointerSyntaxError' });
    const shifted = compile({ ...options, ...BHUTTON }, named);
    assert.equal(shifted(items), true);
    assert.equal(shifted(['+1/foo/bar', 'relative-json-pointer']), false);
  });

  it('reaches a format named by a data keyword whose own reference is in the default grammar', () => {
    const named = { type: 'object', properties: { f: { type: 'string' }, v: { type: 'string', data: { format: '1/f' } } } };
    const options = { formatAssertion: true, formats: jsonFormats };
    assert.equal(compile(options, named)({ f: 'relative-json-pointer', v: '0+1' }), false);
    assert.equal(compile({ ...options, ...BHUTTON }, named)({ f: 'relative-json-pointer', v: '0+1' }), true);
    assert.equal(compile({ ...options, ...BHUTTON }, named)({ f: 'relative-json-pointer', v: '+1/foo/bar' }), false);
  });
});

describe('relativePointerDialect: the option', () => {
  it('is spelled on the validator, on ValidationOptions (named and positional) and on ValidatorOptions', () => {
    const ascending = { type: 'array', items: { type: 'number', data: { maximum: '0+1' } } };
    const positional = new ValidationOptions(true, true, false, null, 7, true, null, true, 'ignore', false, 'bhutton-00');
    assert.equal(positional.relativePointerDialect, 'bhutton-00');
    assert.equal(new ValidationOptions().relativePointerDialect, 'handrews-01');
    assert.equal(new ValidatorOptions().validation.relativePointerDialect, 'handrews-01');
    assert.equal(new ValidatorOptions(BHUTTON).validation.relativePointerDialect, 'bhutton-00');
    for (const validator of [
      new JarenValidator(BHUTTON),
      new JarenValidator(new ValidatorOptions(BHUTTON)),
      new JarenValidator({ validation: positional }),
      new JarenValidator({ ...BHUTTON, collectErrors: true, useGrapheme: false }),
    ]) {
      const validate = /** @type {any} */ (validator.compile(ascending));
      const verdict = (/** @type {any} */ v) => { const r = validate(v); return typeof r === 'boolean' ? r : r.valid; };
      assert.equal(verdict([1, 2]), true);
      assert.equal(verdict([2, 1]), false);
    }
  });

  it('survives a draft-detected compile and a second compile on the same validator', () => {
    const validator = new JarenValidator(BHUTTON);
    const ascending = { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'array', items: { type: 'number', data: { maximum: '0+1' } } };
    assert.equal(validator.compile(ascending)([1, 2]), true);
    assert.equal(validator.compile({ ...ascending, $schema: 'http://json-schema.org/draft-07/schema#' })([2, 1]), false);
  });

  it('refuses a value that names no grammar when any schema compiles', () => {
    for (const bad of ['bhutton', 'handrews', 'Bhutton-00', '', 0, true]) {
      assert.throws(
        () => compile({ relativePointerDialect: bad }, { type: 'string' }),
        { name: 'TypeError', message: /relativePointerDialect must be 'handrews-01' or 'bhutton-00'/ },
        JSON.stringify(bad));
    }
  });
});
