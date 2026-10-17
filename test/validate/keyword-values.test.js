//@ts-check
/**
 * @file A keyword whose value is not of the shape its draft's meta-schema
 * requires is refused when the schema compiles (`JK0013`, `JK0014` for a
 * regular expression that does not compile), located at the keyword or at
 * the member of it that is wrong. Each refused shape used to compile and
 * answer wrong (the constraint dropped, every value accepted) or crash with
 * an uncoded error. The shapes that answered right keep answering, each
 * with its own case below: a value the validator reads by design (a `$data`
 * reference, a number written as a string, a boolean exclusive bound, a
 * `RegExp` pattern, `required: true`), an annotation, and a keyword the
 * place does not read (one its draft does not define, `then` without `if`).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { JarenValidator, SchemaCompileError } from '@jarenjs/validate';

const D07 = 'http://json-schema.org/draft-07/schema#';
const D19 = 'https://json-schema.org/draft/2019-09/schema';
const D20 = 'https://json-schema.org/draft/2020-12/schema';

/**
 * The refusal a compile throws, as code and location, or null.
 * @param {any} schema
 * @param {object} [options]
 */
function refusal(schema, options = undefined) {
  try {
    new JarenValidator(options).compile(schema);
  }
  catch (e) {
    return { code: e.code, docPath: e.docPath, coded: e instanceof SchemaCompileError };
  }
  return null;
}

/**
 * The answers of a schema for each instance, in boolean mode.
 * @param {any} schema
 * @param {unknown[]} instances
 */
function answers(schema, instances) {
  const validate = new JarenValidator().compile(schema);
  return instances.map((x) => validate(x));
}

describe('a keyword value of the wrong shape is refused at compile (JK0013)', () => {
  /** [schema, docPath]: each compiled before and answered wrong or crashed uncoded. */
  const REFUSED = /** @type {[any, string][]} */ ([
    [{ type: 1 }, '#/type'],
    [{ type: null }, '#/type'],
    [{ type: 'strin' }, '#/type'],
    [{ type: ['string', 2] }, '#/type/1'],
    [{ type: ['string', 'strin'] }, '#/type/1'],
    [{ type: [] }, '#/type'],
    [{ enum: 5 }, '#/enum'],
    [{ required: 'a' }, '#/required'],
    [{ required: ['a', 1] }, '#/required/1'],
    [{ properties: 5 }, '#/properties'],
    [{ properties: { a: 5 } }, '#/properties/a'],
    [{ patternProperties: { '^a': 5 } }, '#/patternProperties/%5Ea'],
    [{ additionalProperties: 5 }, '#/additionalProperties'],
    [{ propertyNames: 5 }, '#/propertyNames'],
    [{ items: 5 }, '#/items'],
    [{ items: [{}, 5] }, '#/items/1'],
    [{ items: [{}], additionalItems: 5 }, '#/additionalItems'],
    [{ contains: 5 }, '#/contains'],
    [{ allOf: 5 }, '#/allOf'],
    [{ allOf: [5] }, '#/allOf/0'],
    [{ anyOf: [] }, '#/anyOf'],
    [{ oneOf: [] }, '#/oneOf'],
    [{ anyOf: {} }, '#/anyOf'],
    [{ not: 5 }, '#/not'],
    [{ if: 5 }, '#/if'],
    [{ if: {}, then: 5 }, '#/then'],
    [{ if: {}, else: 'x' }, '#/else'],
    [{ dependencies: 5 }, '#/dependencies'],
    [{ dependencies: { a: 5 } }, '#/dependencies/a'],
    [{ dependencies: { a: ['b', 1] } }, '#/dependencies/a/1'],
    [{ dependentRequired: { a: 'b' } }, '#/dependentRequired/a'],
    [{ dependentSchemas: { a: 5 } }, '#/dependentSchemas/a'],
    [{ unevaluatedProperties: 5 }, '#/unevaluatedProperties'],
    [{ unevaluatedItems: 5 }, '#/unevaluatedItems'],
    [{ prefixItems: 5 }, '#/prefixItems'],
    [{ minLength: 'abc' }, '#/minLength'],
    [{ minLength: -1 }, '#/minLength'],
    [{ minLength: 1.5 }, '#/minLength'],
    [{ maxLength: -1 }, '#/maxLength'],
    [{ minItems: 1.5 }, '#/minItems'],
    [{ maxItems: '' }, '#/maxItems'],
    [{ minProperties: true }, '#/minProperties'],
    [{ maxProperties: [2] }, '#/maxProperties'],
    [{ contains: {}, minContains: 'x' }, '#/minContains'],
    [{ contains: {}, maxContains: -1 }, '#/maxContains'],
    [{ minimum: 'abc' }, '#/minimum'],
    [{ minimum: null }, '#/minimum'],
    [{ maximum: {} }, '#/maximum'],
    [{ exclusiveMaximum: 'x' }, '#/exclusiveMaximum'],
    [{ multipleOf: 0 }, '#/multipleOf'],
    [{ multipleOf: 'x' }, '#/multipleOf'],
    [{ uniqueItems: 1 }, '#/uniqueItems'],
    [{ uniqueItems: 'true' }, '#/uniqueItems'],
    [{ pattern: 5 }, '#/pattern'],
    [{ pattern: null }, '#/pattern'],
    [{ $ref: 5 }, '#/%24ref'],
  ]);

  it('refuses each, coded and located, in both modes', () => {
    const expected = REFUSED.map(([, docPath]) => ({ code: 'JK0013', docPath, coded: true }));
    assert.deepEqual(REFUSED.map(([schema]) => refusal(schema)), expected);
    assert.deepEqual(REFUSED.map(([schema]) => refusal(schema, { collectErrors: true })), expected);
  });

  it('names the keyword, the shape it takes and the value it got', () => {
    const message = (/** @type {any} */ schema) => {
      try {
        new JarenValidator().compile(schema);
      }
      catch (e) {
        return e.message;
      }
      return null;
    };
    assert.equal(message({ type: 'strin' }),
      "JK0013: 'type' takes a type name (array, boolean, integer, null, number, object, string) or a non-empty array of type names, got 'strin'; a value of another shape is no constraint the validator reads at #/type");
    assert.equal(message({ required: 'a' }),
      "JK0013: 'required' takes an array of member names, got 'a'; a value of another shape is no constraint the validator reads at #/required");
    assert.equal(message({ properties: { a: { minLength: -1 } } }),
      "JK0013: 'minLength' takes a non-negative integer, got -1; a value of another shape is no constraint the validator reads at #/properties/a/minLength");
    assert.equal(message({ properties: { a: 5 } }),
      "JK0013: 'properties' takes an object whose members are schemas (objects or booleans), got 5 for member 'a'; a value of another shape is no constraint the validator reads at #/properties/a");
  });

  it('locates a nested place by its pointer into the compiled document, with or without a root $id', () => {
    for (const root of [{}, { $id: 'https://x.test/order' }]) {
      assert.deepEqual(refusal({ ...root, properties: { a: { items: { type: 'strin' } } } }),
        { code: 'JK0013', docPath: '#/properties/a/items/type', coded: true });
    }
  });

  it('refuses the keywords each declared draft reads', () => {
    assert.deepEqual(refusal({ $schema: D20, prefixItems: [5] }), { code: 'JK0013', docPath: '#/prefixItems/0', coded: true });
    assert.deepEqual(refusal({ $schema: D20, $dynamicRef: 5 }), { code: 'JK0013', docPath: '#/%24dynamicRef', coded: true });
    assert.deepEqual(refusal({ $schema: D19, $recursiveRef: 5 }), { code: 'JK0013', docPath: '#/%24recursiveRef', coded: true });
    assert.deepEqual(refusal({ $schema: D19, contains: {}, minContains: 'x' }), { code: 'JK0013', docPath: '#/minContains', coded: true });
    assert.deepEqual(refusal({ $schema: D07, dependencies: { a: 5 } }), { code: 'JK0013', docPath: '#/dependencies/a', coded: true });
  });

  it('refuses an item schema the required-only fast path would read', () => {
    assert.deepEqual(refusal({ items: { required: [1] } }), { code: 'JK0013', docPath: '#/items/required/0', coded: true });
  });
});

describe('a regular expression that does not compile is refused (JK0014)', () => {
  it('refuses pattern and a patternProperties name, located, with the RegExp error as the cause', () => {
    assert.deepEqual(refusal({ pattern: '[' }), { code: 'JK0014', docPath: '#/pattern', coded: true });
    assert.deepEqual(refusal({ patternProperties: { '[': {} } }), { code: 'JK0014', docPath: '#/patternProperties/%5B', coded: true });
    try {
      new JarenValidator().compile({ pattern: '(' });
      assert.fail('compiled');
    }
    catch (e) {
      assert.equal(e.code, 'JK0014');
      assert.ok(e.cause instanceof SyntaxError);
    }
  });
});

describe('the shapes that answered right keep answering', () => {
  it('reads a $data reference where the keyword takes one', () => {
    assert.deepEqual(answers({ properties: { s: { minLength: { $data: '1/n' } }, n: {} } }, [{ s: 'ab', n: 3 }, { s: 'abc', n: 3 }]), [false, true]);
    assert.deepEqual(answers({ properties: { s: { required: { $data: '1/r' } }, r: {} } }, [{ s: {}, r: ['x'] }, { s: { x: 1 }, r: ['x'] }]), [false, true]);
  });

  it('reads a number written as a string as that number', () => {
    assert.deepEqual(answers({ minLength: '3' }, ['ab', 'abc', 1]), [false, true, true]);
    assert.deepEqual(answers({ minItems: '2' }, [[1], [1, 2]]), [false, true]);
    assert.deepEqual(answers({ minimum: '3' }, [2, 3]), [false, true]);
    assert.deepEqual(answers({ exclusiveMinimum: '3' }, [3, 4]), [false, true]);
    assert.deepEqual(answers({ multipleOf: '2' }, [3, 4]), [false, true]);
  });

  it('reads a negative multipleOf as its magnitude', () => {
    assert.deepEqual(answers({ multipleOf: -2 }, [2, -2, -1, 0]), [true, true, false, true]);
  });

  it('reads a boolean exclusive bound beside its bound, and a bigint bound', () => {
    assert.deepEqual(answers({ minimum: 1, exclusiveMinimum: true }, [1, 2]), [false, true]);
    assert.deepEqual(answers({ maximum: 1, exclusiveMaximum: true }, [1, 0]), [false, true]);
    assert.deepEqual(answers({ exclusiveMinimum: false }, [-5]), [true]);
    assert.equal(refusal({ minimum: 3n, multipleOf: 2n }), null);
  });

  it('reads the type names, lists and values it reads by design', () => {
    assert.deepEqual(answers({ type: ['string', 'string'] }, ['a', 1]), [true, false]);
    assert.deepEqual(answers({ type: ['string', null] }, [null, 1]), [true, false]);
    assert.deepEqual(answers({ type: new Set(['string']) }, ['a', 1]), [true, false]);
    assert.deepEqual(answers({ type: 'bigint' }, [1n, 1]), [true, false]);
  });

  it('reads required as a list with repeats, and required: true as presence', () => {
    assert.deepEqual(answers({ required: ['a', 'a'] }, [{}, { a: 1 }]), [false, true]);
    assert.deepEqual(answers({ type: 'number', required: true }, [undefined, 1]), [false, true]);
  });

  it('reads the empty lists that constrain nothing', () => {
    assert.deepEqual(answers({ allOf: [] }, [1]), [true]);
    assert.deepEqual(answers({ $schema: D20, prefixItems: [] }, [[1]]), [true]);
    assert.deepEqual(answers({ required: [] }, [{}]), [true]);
  });

  it('applies an items array under 2020-12 as the tuple it was read as', () => {
    assert.deepEqual(answers({ $schema: D20, items: [{ type: 'string' }] }, [['a'], [1]]), [true, false]);
  });

  it('reads a RegExp pattern and a v-mode literal', () => {
    assert.deepEqual(answers({ pattern: /^a/ }, ['ab', 'b']), [true, false]);
    assert.equal(refusal({ pattern: '/[\\p{L}--[a-z]]/v' }), null);
  });

  it('leaves the annotations, identifiers, storage, format and content keywords as they were', () => {
    for (const schema of [{ title: 5 }, { description: [] }, { default: 1 }, { examples: 5 }, { readOnly: 'x' }, { $comment: 5 },
      { deprecated: 1 }, { $id: 5 }, { $defs: 5 }, { definitions: { a: 5 } }, { format: 5 }, { contentEncoding: 5 },
      { contentMediaType: 5 }, { $schema: D20, contentSchema: 5 }, { 'x-anything': 5 }, { nullable: 'yes' }]) {
      assert.deepEqual(answers(schema, ['a', 1]), [true, true], JSON.stringify(schema));
    }
  });

  it('does not read a keyword the place does not read', () => {
    assert.deepEqual(answers({ then: 5 }, [1]), [true]);
    assert.deepEqual(answers({ else: 5 }, [1]), [true]);
    assert.deepEqual(answers({ additionalItems: 5 }, [[1]]), [true]);
    assert.deepEqual(answers({ items: {}, additionalItems: 5 }, [[1]]), [true]);
    assert.deepEqual(answers({ minContains: 'x' }, [[1]]), [true]);
    assert.deepEqual(answers({ $schema: D07, prefixItems: 5, dependentRequired: 5, unevaluatedProperties: 5 }, [[1], { a: 1 }]), [true, true]);
    assert.deepEqual(answers({ $schema: D07, $ref: '#/definitions/s', definitions: { s: { type: 'string' } }, minLength: -1 }, ['', 1]), [true, false]);
    assert.deepEqual(answers({ $schema: D20, $recursiveRef: 5 }, [1]), [true]);
  });

  it('does not read a validation keyword under a dialect that turns the vocabulary off', () => {
    const validator = new JarenValidator().addSchema({
      $schema: D20,
      $id: 'https://x.test/no-validation',
      $vocabulary: {
        'https://json-schema.org/draft/2020-12/vocab/core': true,
        'https://json-schema.org/draft/2020-12/vocab/applicator': true,
      },
    });
    const validate = validator.compile({ $schema: 'https://x.test/no-validation', type: 1, minLength: -1, required: 'a', properties: { a: false } });
    assert.deepEqual([validate(1), validate({ a: 1 })], [true, false]);
  });

  it('leaves the extension keywords to their own rules', () => {
    assert.deepEqual(answers({ properties: { s: { data: { maxLength: '1/m' } }, m: {} } }, [{ s: 'xyz', m: 1 }, { s: 'x', m: 1 }]), [false, true]);
  });
});

describe('an empty enum', () => {
  it('admits no value', () => {
    assert.deepEqual(answers({ enum: [] }, [1, 'a', null, {}]), [false, false, false, false]);
    assert.deepEqual(answers({ $schema: D20, enum: [] }, [1]), [false]);
    const validate = new JarenValidator({ collectErrors: true }).compile({ enum: [] });
    assert.equal(validate(1).valid, false);
  });
});
