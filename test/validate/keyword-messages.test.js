//@ts-check
/**
 * The keywords whose failures name what the instance needed: the expected
 * value of `const`, the allowed list of `enum`, the property and the missing
 * dependency of `dependentRequired` (and draft-07 `dependencies`), and the
 * member or index `unevaluatedProperties`/`unevaluatedItems` rejected.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JarenValidator, messagesEn, compileMessageCatalog, localizeErrors } from '@jarenjs/validate';

/**
 * The collected errors of one keyword.
 * @param {any} schema
 * @param {unknown} data
 * @param {string} keyword
 * @param {number} [draftVersion]
 */
function failures(schema, data, keyword, draftVersion = 2020) {
  const result = new JarenValidator({ collectErrors: true, draftVersion }).compile(schema)(data);
  assert.equal(result.valid, false);
  return result.errors.filter((/** @type {any} */ e) => e.keyword === keyword)
    .map((/** @type {any} */ e) => ({ instancePath: e.instancePath, msgid: e.msgid, params: e.params, message: e.message }));
}

describe('const names the value it expected', () => {
  it('a scalar, a string and a structured value', () => {
    assert.deepEqual(failures({ const: 3 }, 4, 'const'),
      [{ instancePath: '', msgid: 'const', params: { allowedValue: 3 }, message: 'must be equal to constant 3' }]);
    assert.deepEqual(failures({ const: 'EUR' }, 'USD', 'const')[0].message, 'must be equal to constant "EUR"');
    assert.deepEqual(failures({ const: null }, 0, 'const')[0].params, { allowedValue: null });
    assert.deepEqual(failures({ properties: { a: { const: { b: [1] } } } }, { a: 2 }, 'const'),
      [{ instancePath: '/a', msgid: 'const', params: { allowedValue: { b: [1] } }, message: 'must be equal to constant {"b":[1]}' }]);
  });

  it('the value a data reference resolved, not the reference', () => {
    assert.deepEqual(failures({ properties: { v: { const: { $data: '1/w' } } } }, { v: 3, w: 4 }, 'const'),
      [{ instancePath: '/v', msgid: 'const', params: { allowedValue: 4 }, message: 'must be equal to constant 4' }]);
    assert.deepEqual(failures({ properties: { v: { data: { const: '1/w' } } } }, { v: 3, w: 'x' }, 'const')[0].params, { allowedValue: 'x' });
  });

  it('a BigInt constant renders as its digits instead of throwing', () => {
    assert.deepEqual(failures({ const: 10n }, 3, 'const'),
      [{ instancePath: '', msgid: 'const', params: { allowedValue: 10n }, message: 'must be equal to constant 10' }]);
    assert.equal(failures({ const: [10n] }, 3, 'const')[0].message, 'must be equal to constant ["10"]');
  });
});

describe('enum names the values it allows', () => {
  it('scalars and structured values', () => {
    assert.deepEqual(failures({ enum: [1, 'a', null] }, 4, 'enum'),
      [{ instancePath: '', msgid: 'enum', params: { allowedValues: [1, 'a', null] }, message: 'must be equal to one of the allowed values: 1, "a", null' }]);
    assert.equal(failures({ enum: [{ a: 1 }, [2]] }, 4, 'enum')[0].message, 'must be equal to one of the allowed values: {"a":1}, [2]');
  });

  it('the list a data reference resolved, and a BigInt member', () => {
    assert.deepEqual(failures({ properties: { v: { enum: { $data: '1/e' } } } }, { v: 3, e: [1, 2] }, 'enum')[0].params, { allowedValues: [1, 2] });
    assert.equal(failures({ enum: [10n, 'a'] }, 3, 'enum')[0].message, 'must be equal to one of the allowed values: 10, "a"');
  });
});

describe('dependentRequired names the property and the dependency it misses', () => {
  it('one error per present property, at the property, naming its first missing dependency', () => {
    assert.deepEqual(failures({ dependentRequired: { a: ['b', 'c'] } }, { a: 1, c: 2 }, 'dependentRequired'),
      [{ instancePath: '/a', msgid: 'dependentRequired', params: { property: 'a', missingProperty: 'b' }, message: "must have property 'b' when property 'a' is present" }]);
    assert.deepEqual(failures({ dependentRequired: { a: ['b', 'c'], d: ['c'] } }, { a: 1, b: 2, d: 3 }, 'dependentRequired').map((e) => e.params),
      [{ property: 'a', missingProperty: 'c' }, { property: 'd', missingProperty: 'c' }]);
  });

  it('a property named by the empty string is still named', () => {
    assert.equal(failures({ dependentRequired: { '': ['x'] } }, { '': 1 }, 'dependentRequired')[0].message,
      "must have property 'x' when property '' is present");
  });

  it('draft-07 dependencies, its array form, says the same', () => {
    assert.deepEqual(failures({ dependencies: { a: ['b'] } }, { a: 1 }, 'dependencies', 7),
      [{ instancePath: '/a', msgid: 'dependencies', params: { property: 'a', missingProperty: 'b' }, message: "must have property 'b' when property 'a' is present" }]);
    assert.deepEqual(failures({ dependencies: { a: ['b'], c: { required: ['d'] }, e: ['f', 'g'] } }, { a: 1, e: 1, f: 1 }, 'dependencies', 7).map((e) => e.params),
      [{ property: 'a', missingProperty: 'b' }, { property: 'e', missingProperty: 'g' }]);
  });
});

describe('unevaluatedProperties and unevaluatedItems name what they rejected', () => {
  it('the false form and the schema form', () => {
    assert.deepEqual(failures({ properties: { a: {} }, unevaluatedProperties: false }, { a: 1, x: 2 }, 'unevaluatedProperties'),
      [{ instancePath: '', msgid: 'unevaluatedProperties', params: { unevaluatedProperty: 'x' }, message: "unevaluated property 'x' fails the 'unevaluatedProperties' schema" }]);
    assert.deepEqual(failures({ unevaluatedProperties: { type: 'string' } }, { p: 1, q: 'a' }, 'unevaluatedProperties').map((e) => e.message),
      ["unevaluated property 'p' fails the 'unevaluatedProperties' schema"]);
    assert.deepEqual(failures({ prefixItems: [{}], unevaluatedItems: false }, [1, 2], 'unevaluatedItems'),
      [{ instancePath: '', msgid: 'unevaluatedItems', params: { unevaluatedItem: 1 }, message: "unevaluated item at index 1 fails the 'unevaluatedItems' schema" }]);
    assert.deepEqual(failures({ unevaluatedItems: { type: 'string' } }, ['a', 2], 'unevaluatedItems').map((e) => e.message),
      ["unevaluated item at index 1 fails the 'unevaluatedItems' schema"]);
  });

  it('index 0 and the empty member name are named', () => {
    assert.equal(failures({ unevaluatedItems: false }, [1], 'unevaluatedItems')[0].message,
      "unevaluated item at index 0 fails the 'unevaluatedItems' schema");
    assert.equal(failures({ unevaluatedProperties: false }, { '': 1 }, 'unevaluatedProperties')[0].message,
      "unevaluated property '' fails the 'unevaluatedProperties' schema");
  });
});

describe('the catalog entries', () => {
  it('render a reason without their params, as a hand-built error has none', () => {
    const catalog = compileMessageCatalog(messagesEn);
    assert.deepEqual(['const', 'enum', 'dependentRequired', 'dependencies', 'unevaluatedProperties', 'unevaluatedItems', 'subschema'].map((key) => catalog[key]({})), [
      'must be equal to constant',
      'must be equal to one of the allowed values',
      'must have the properties its present properties depend on',
      'must have the properties its present properties depend on',
      "unevaluated properties fail the 'unevaluatedProperties' schema",
      "unevaluated items fail the 'unevaluatedItems' schema",
      'A subschema had errors.',
    ]);
  });

  it('re-render through another catalog with the same params', () => {
    const result = new JarenValidator({ collectErrors: true }).compile({ const: 3, enum: [1, 2] })(4);
    localizeErrors(result.errors, compileMessageCatalog({ const: (/** @type {any} */ p) => `= ${p.allowedValue}`, enum: (/** @type {any} */ p) => `in ${p.allowedValues.join('|')}` }));
    assert.deepEqual(result.errors.map((/** @type {any} */ e) => e.message).sort(), ['= 3', 'in 1|2']);
  });
});
