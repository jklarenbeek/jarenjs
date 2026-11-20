//@ts-check
/**
 * @file A form field judges every place of its schema that asserts.
 *
 * The form model folded `allOf` branches, and the keywords beside a
 * `$ref`, into one schema by keeping the first value of each keyword, and
 * the field check judged that schema: `{ allOf: [{ minimum: 5 },
 * { minimum: 7 }] }` took `6`, `{ allOf: [{ type: 'string' },
 * { type: 'number' }] }` took `'a'`, and a member two branches describe
 * was judged by the first. The validator applies every branch.
 *
 * The field now keeps what each place asserts (`field.asserted`) and is
 * judged by each; the folded schema is what the control is drawn from,
 * with the tightest of the bounds two places hold.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JarenValidator } from '@jarenjs/validate';
import { buildFormModel, createInitialData, formRulesToQueryAssertions, resolveSchema, validateAllFields, validateField } from '@jarenjs/forms';

const LATEST = 'https://json-schema.org/draft/2020-12/schema';

/** The validator's verdict, the schema read as the latest draft reads it. @param {object} schema @param {unknown} value */
const validatorTakes = (schema, value) => new JarenValidator().compile({ $schema: LATEST, ...schema })(value);

/** `pointer#keyword` for every fault layer 1 reports. @param {object} schema @param {unknown} value */
const faults = (schema, value) => Object.entries(validateAllFields(buildFormModel(schema), value))
  .flatMap(([pointer, errors]) => errors.map((error) => `${pointer}#${error.keyword}`));

const DEFS = { x: { minimum: 7 }, s: { type: 'string', minLength: 3 }, o: { properties: { a: { type: 'string' } } }, any: true, none: false };

describe('every place of a schema that asserts is judged', () => {
  it('judges a keyword two places hold by each of them', () => {
    /** @type {[object, unknown, string[]][]} */
    const table = [
      [{ allOf: [{ minimum: 5 }, { minimum: 7 }] }, 6, ['#minimum']],
      [{ minimum: 5, allOf: [{ minimum: 7 }] }, 6, ['#minimum']],
      [{ allOf: [{ minimum: 5 }, { minimum: 7 }] }, 7, []],
      [{ allOf: [{ type: 'string' }, { type: 'number' }] }, 'a', ['#type']],
      [{ allOf: [{ pattern: '^a' }, { pattern: 'b$' }] }, 'a', ['#pattern']],
      [{ allOf: [{ pattern: '^a' }, { pattern: 'b$' }] }, 'ab', []],
      [{ allOf: [{ multipleOf: 2 }, { multipleOf: 3 }] }, 2, ['#multipleOf']],
      [{ allOf: [{ enum: [1, 2] }, { enum: [2, 3] }] }, 1, ['#enum']],
      [{ allOf: [{ enum: [1, 2] }, { enum: [2, 3] }] }, 2, []],
      [{ allOf: [{ maxLength: 3 }, { maxLength: 1 }, { minLength: 1 }] }, 'ab', ['#maxLength']],
      [{ allOf: [{ allOf: [{ minimum: 5 }, { multipleOf: 2 }] }, { maximum: 9 }] }, 11, ['#multipleOf', '#maximum']],
      [{ $defs: DEFS, $ref: '#/$defs/x', minimum: 5 }, 6, ['#minimum']],
      [{ $defs: DEFS, $ref: '#/$defs/x', minimum: 9 }, 8, ['#minimum']],
      [{ $defs: DEFS, allOf: [{ $ref: '#/$defs/s' }, { maxLength: 4 }] }, 'ab', ['#minLength']],
      [{ $defs: DEFS, $ref: '#/$defs/any', minimum: 5 }, 4, ['#minimum']],
    ];
    for (const [schema, value, expected] of table) {
      assert.deepEqual(faults(schema, value), expected, `${JSON.stringify(schema)} on ${JSON.stringify(value)}`);
      assert.equal(validatorTakes(schema, value), expected.length === 0, `the validator on ${JSON.stringify(schema)}`);
    }
  });

  it('reports each of two different bounds that fail, and one fault once', () => {
    const field = buildFormModel({ allOf: [{ minimum: 5 }, { minimum: 7 }] });
    assert.deepEqual(validateField(field, 3).map((error) => error.message), ['Must be at least 5', 'Must be at least 7']);
    // the same schema reached twice, and one keyword written alike in two places, are one fault
    const twice = buildFormModel({ $defs: DEFS, allOf: [{ $ref: '#/$defs/s' }, { $ref: '#/$defs/s' }, { type: 'string' }] });
    assert.deepEqual(validateField(twice, 5).map((error) => error.message), ['Must be a string']);
    assert.equal(twice.asserted.length, 2);
  });

  it('judges a member, an item and a tuple slot two places describe by both', () => {
    const members = { allOf: [{ properties: { a: { type: 'string' } } }, { properties: { a: { minLength: 3 }, b: { minimum: 5 } }, required: ['a'] }] };
    assert.deepEqual(faults(members, { a: 'x', b: 1 }), ['/a#minLength', '/b#minimum']);
    assert.deepEqual(faults(members, { a: 5 }), ['/a#type']);
    assert.deepEqual(faults(members, {}), ['/a#required']);
    assert.equal(validatorTakes(members, { a: 'x' }), false);
    // the properties beside a $ref and the properties of its target are both members
    const beside = { $defs: DEFS, $ref: '#/$defs/o', properties: { b: { minimum: 5 } } };
    assert.deepEqual(buildFormModel(beside).children.map((child) => child.key), ['a', 'b']);
    assert.deepEqual(faults(beside, { a: 5, b: 1 }), ['/a#type', '/b#minimum']);
    assert.equal(validatorTakes(beside, { a: 5, b: 9 }), false);
    const items = { allOf: [{ items: { type: 'string' } }, { items: { minLength: 3 } }] };
    assert.deepEqual(faults(items, ['x', 5, 'xyz']), ['/0#minLength', '/1#type']);
    const slots = { allOf: [{ prefixItems: [{ type: 'string' }, { minimum: 5 }] }, { prefixItems: [{ minLength: 2 }], items: { type: 'number' } }] };
    const tuple = buildFormModel(slots);
    assert.deepEqual([tuple.tuple.length, tuple.tuple.map((slot) => slot.asserted.length), tuple.item.asserted], [2, [2, 2], [{ type: 'number' }]]);
    assert.deepEqual(faults(slots, ['a', 3, 'x']), ['/0#minLength', '/1#minimum', '/2#type']);
    assert.equal(validatorTakes(slots, ['ab', 5, 1]), true);
    assert.deepEqual(faults(slots, ['ab', 5, 1]), []);
  });

  it('admits null where every place does', () => {
    const cases = /** @type {[object, boolean][]} */ ([
      [{ allOf: [{ type: ['string', 'null'] }, { type: 'string' }] }, false],
      [{ allOf: [{ type: ['string', 'null'] }, { minLength: 2 }] }, true],
      [{ type: ['number', 'null'], allOf: [{ enum: [1, 2] }] }, false],
      [{ allOf: [{ anyOf: [{ type: 'string' }, { type: 'null' }] }, { maxLength: 3 }] }, true],
      [{ $defs: DEFS, $ref: '#/$defs/none' }, false],
      [{ $defs: DEFS, $ref: '#/$defs/any' }, true],
      [true, true],
    ]);
    for (const [schema, nullable] of cases) {
      const field = buildFormModel({ type: 'object', $defs: DEFS, properties: { n: schema }, required: ['n'] }).children[0];
      assert.equal(field.nullable, nullable, JSON.stringify(schema));
      if (schema !== true && !('$defs' in schema)) assert.equal(validatorTakes(schema, null), nullable, `the validator on ${JSON.stringify(schema)}`);
    }
    assert.deepEqual(faults({ allOf: [{ type: ['string', 'null'] }, { type: 'string' }] }, null), ['#type']);
    // a member any value passes takes a null: it reported `required` for one
    assert.deepEqual(faults({ properties: { a: true }, required: ['a'] }, { a: null }), []);
  });

  it('ends where a reference comes back to a schema it is read from', () => {
    const loop = { $defs: { a: { minimum: 5, allOf: [{ $ref: '#/$defs/b' }] }, b: { maximum: 9, $ref: '#/$defs/a' } }, $ref: '#/$defs/a' };
    const field = buildFormModel(loop);
    assert.deepEqual(field.asserted, [{ minimum: 5 }, { maximum: 9 }]);
    assert.deepEqual(faults(loop, 11), ['#maximum']);
    assert.deepEqual(faults({ allOf: [false] }, 5), [], 'a branch no value passes names no keyword of layer 1');
  });

  it('judges a field that holds no record of its places by its schema', () => {
    const { asserted: _asserted, ...field } = buildFormModel({ type: 'string', minLength: 2 });
    assert.deepEqual(validateField(/** @type {any} */ (field), 5).map((error) => error.keyword), ['type']);
    assert.deepEqual(validateField(/** @type {any} */ (field), 'a').map((error) => error.keyword), ['minLength']);
    assert.deepEqual(validateField(/** @type {any} */ ({ kind: 'unknown' }), 5), []);
  });
});

describe('the schema a control is drawn from', () => {
  /** @param {object} schema */
  const drawn = (schema) => {
    const field = buildFormModel(schema);
    return { kind: field.kind, constraints: field.constraints, options: field.enumValues, nullable: field.nullable };
  };

  it('holds the tightest of the bounds and counts two places hold', () => {
    assert.deepEqual(drawn({ allOf: [{ minimum: 5 }, { minimum: 7 }, { maximum: 9 }, { maximum: 8 }] }).constraints, { minimum: 7, maximum: 8 });
    assert.deepEqual(drawn({ minimum: 9, allOf: [{ minimum: '7' }] }).constraints, { minimum: 9 });
    // a draft-04 boolean is the bound it makes exclusive
    assert.deepEqual(drawn({ allOf: [{ minimum: 5, exclusiveMinimum: true }, { minimum: 7 }] }).constraints, { minimum: 7, exclusiveMinimum: 5 });
    assert.deepEqual(drawn({ allOf: [{ maximum: 5, exclusiveMaximum: 9 }, { exclusiveMaximum: 6 }] }).constraints, { maximum: 5, exclusiveMaximum: 6 });
    // a control writes numbers: bigint bounds are compared where no place holds a number
    assert.deepEqual(drawn({ allOf: [{ minimum: 5n }, { minimum: 7 }, { minimum: 6 }] }).constraints, { minimum: 7 });
    assert.deepEqual(drawn({ allOf: [{ maximum: 5n }, { maximum: 3n }] }).constraints, { maximum: 3n });
    assert.deepEqual(drawn({ allOf: [{ minLength: 2, pattern: '^a' }, { minLength: 3, maxLength: 9, pattern: 'b$' }, { maxLength: 5 }] }).constraints,
      { minLength: 3, maxLength: 5, pattern: '^a' });
    assert.deepEqual(drawn({ allOf: [{ minItems: 1, maxItems: 9 }, { minItems: 2, maxItems: 4, uniqueItems: true }, { items: {} }] }).constraints,
      { minItems: 2, maxItems: 4, uniqueItems: true });
    assert.deepEqual(drawn({ type: 'object', allOf: [{ minProperties: 1 }, { minProperties: 2, maxProperties: 5 }, { maxProperties: 3 }] }).constraints,
      { minProperties: 2, maxProperties: 3 });
    assert.deepEqual(drawn({ allOf: [{ uniqueItems: false }, { uniqueItems: true }, { items: {} }] }).constraints, { uniqueItems: true });
    // one place holds the bound: as it is written
    assert.deepEqual(drawn({ allOf: [{ minimum: 5, exclusiveMinimum: true }, { title: 'n' }] }).constraints, { minimum: 5, exclusiveMinimum: true });
  });

  it('offers the options every place lists, under the type every place takes', () => {
    assert.deepEqual(drawn({ allOf: [{ enum: [1, 2, 'a', [1]] }, { enum: [2, 'a', null, [1]] }] }).options, [2, 'a', [1]]);
    assert.equal(drawn({ allOf: [{ type: ['string', 'number'] }, { type: 'number' }] }).kind, 'number');
    assert.equal(drawn({ allOf: [{ type: 'number' }, { type: 'integer' }] }).kind, 'integer');
    assert.equal(drawn({ allOf: [{ type: ['integer', 'null'] }, { type: ['number', 'string'] }] }).kind, 'integer');
    assert.equal(drawn({ allOf: [{ type: 'string' }, { type: 'number' }] }).kind, 'string', 'no shared type: the first');
    assert.equal(drawn({ allOf: [{ type: 'string' }, { minLength: 1 }] }).kind, 'string');
  });

  it('keeps the members, the kind and the starting data of a schema whose places hold different keywords', () => {
    const schema = { type: 'object', allOf: [{ properties: { a: { type: 'string' } } }, { properties: { b: { type: 'number' } } },
      { properties: { c: { type: 'boolean' } }, required: ['c'] }] };
    const model = buildFormModel(schema);
    assert.deepEqual(model.children.map((child) => `${child.key}:${child.kind}:${child.required}`), ['c:boolean:true', 'b:number:false', 'a:string:false']);
    assert.deepEqual(createInitialData(model), { c: false });
    assert.deepEqual(createInitialData(buildFormModel({ properties: { m: { allOf: [{ minItems: 2 }, { uniqueItems: true }] } } })), {});
    assert.deepEqual(resolveSchema({ title: 'T', minimum: 1 }, {}), { title: 'T', minimum: 1 });
    const plain = { type: 'string' };
    assert.equal(resolveSchema(plain, {}), plain, 'a schema with neither a $ref nor an allOf is itself');
    assert.deepEqual(resolveSchema({ title: 'T', allOf: [{ title: 'U', description: 'd' }, { required: ['a'] }, { required: ['b', 'a'] }] }, {}),
      { title: 'T', description: 'd', required: ['a', 'b'] });
  });

  it('copies to the submit layer the rules of the members a $ref names beside its own', () => {
    const schema = {
      $defs: { o: { type: 'object', properties: { a: { type: 'number', 'x-form': { assert: { $gt: ['$value', 0] } } } } } },
      type: 'object',
      properties: { p: { $ref: '#/$defs/o', properties: { b: { type: 'number', 'x-form': { assert: { $lt: ['$value', 9] } } } } } },
    };
    const copy = /** @type {any} */ (formRulesToQueryAssertions(schema));
    assert.equal(copy.allOf.length, 2);
    const validate = new JarenValidator().compile(copy);
    assert.deepEqual([validate({ p: { a: 1, b: 1 } }), validate({ p: { a: -1, b: 1 } }), validate({ p: { a: 1, b: 9 } })], [true, false, false]);
  });
});
