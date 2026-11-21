import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { JarenValidator } from '@jarenjs/validate';

// A collecting validation keeps each distinct error once: an error the same
// as one the list holds already (same keyword, instance location, schema
// location and params) is not kept again, and the errors keep the order in
// which they first appeared. Branches that enter one definition on one
// member through references give its kept answer again per branch, at every
// level below, so a list that kept every repeat grew with the branches tried
// to the power of the nesting.

const COLLECT = { skipErrors: false, collectErrors: true };

const op = (name) => ({
  type: 'object',
  propertyNames: { const: name },
  additionalProperties: { type: 'array', items: { $ref: '#/definitions/expr' } },
});
// an expression: a number, or one of six operator phrases whose operands are expressions
const grammar = { definitions: { expr: { oneOf: [{ type: 'number' }, ...['$a', '$b', '$c', '$d', '$e', '$f'].map(op)] } }, $ref: '#/definitions/expr' };
// a phrase `depth` phrases down that holds a member no phrase takes
const nested = (depth) => {
  let doc = { $a: [1], plain: 1 };
  for (let i = 0; i < depth; i++) doc = { $a: [doc] };
  return doc;
};

const exact = (e) => JSON.stringify([e.keyword, e.instancePath, e.schemaPath, e.params]);
const place = (e) => `${e.instancePath} ${e.keyword} ${e.schemaPath.replace(/^[^#]*/, '')}${e.params.propertyName === undefined ? '' : ` ${e.params.propertyName}`}`;
const collect = (schema, data, options = {}) => new JarenValidator({ ...COLLECT, ...options }).compile(schema)(data);

describe('collected errors: each distinct error once', () => {
  it('grows with the nesting, not with the branches tried to its power', () => {
    const validate = new JarenValidator(COLLECT).compile(grammar);
    const counts = [1, 2, 3, 4, 5].map((depth) => {
      const { valid, errors } = validate(nested(depth));
      assert.strictEqual(valid, false);
      assert.strictEqual(new Set(errors.map(exact)).size, errors.length, `a repeat at depth ${depth}`);
      return errors.length;
    });
    // each level adds the same errors once (the full list grew six times per level)
    assert.deepStrictEqual(counts, [32, 45, 58, 71, 84]);
  });

  it('keeps each record once while it walks, not one copy per branch that gave it again', () => {
    // a format that reads the list the walk keeps, after the walk
    let kept = -1;
    const validate = new JarenValidator({ ...COLLECT, formatAssertion: true })
      .addFormats({ probe: (schemaObj) => () => { kept = schemaObj.root.errors.length; return true; } })
      .compile({ definitions: grammar.definitions, allOf: [{ $ref: '#/definitions/expr' }, { format: 'probe' }] });
    const lengths = [1, 2, 3, 4, 5].map((depth) => { validate(nested(depth)); return kept; });
    // (a list that kept every copy grew six times per level)
    assert.deepStrictEqual(lengths, [52, 46, 59, 72, 85]);
  });

  it('keeps a record once that two entries of one definition gave again, one inside the other', () => {
    // `r` on a member is entered again from inside `r` on its parent, through two branch walks
    let kept = -1;
    const r = { $ref: '#/definitions/r' };
    const validate = new JarenValidator({ ...COLLECT, formatAssertion: true })
      .addFormats({ probe: (schemaObj) => () => { kept = schemaObj.root.errors.length; return true; } })
      .compile({
        definitions: { r: { allOf: [{ anyOf: [{ properties: { p: r } }] }, { anyOf: [{ allOf: [{ type: 'string' }, { properties: { p: r } }] }] }] } },
        allOf: [r, { format: 'probe' }],
      });
    const lengths = [{ p: { p: 10 } }, { p: { p: { p: 1 } } }, { p: { p: { p: { p: 1 } } } }].map((doc) => { validate(doc); return kept; });
    assert.deepStrictEqual(lengths, [38, 78, 143]);
  });

  it('keeps a record once that an entry gave again two entries down', () => {
    let kept = -1;
    const r = { $ref: '#/definitions/r' };
    const validate = new JarenValidator({ ...COLLECT, formatAssertion: true })
      .addFormats({ probe: (schemaObj) => () => { kept = schemaObj.root.errors.length; return true; } })
      .compile({
        definitions: { r: { allOf: [{ allOf: [{ properties: { q: r } }, { properties: { p: r } }] }, { properties: { p: { allOf: [{ minimum: 9 }] }, q: { anyOf: [{ allOf: [r] }] } } }] } },
        allOf: [r, { format: 'probe' }],
      });
    const doc = { q: { p: { q: { p: 1 } } } };
    // (the first validation resolves the references)
    validate(doc);
    validate(doc);
    assert.strictEqual(kept, 29);
  });

  it('keeps the order in which the errors first appeared where a kept answer is given again after a discard', () => {
    const r = { $ref: '#' };
    const schema = { allOf: [{ oneOf: [{ properties: { q: { if: r, else: { properties: { q: r } } } } }, { allOf: [{ properties: { p: r } }] }] }, { properties: { p: r } }] };
    const validate = new JarenValidator(COLLECT).compile(schema);
    const doc = { p: { p: { p: {}, q: { q: 5 } }, q: { q: {} } }, q: {} };
    validate(doc);
    assert.deepStrictEqual(validate(doc).errors.map(place), [
      '/p/q/q oneOf #/allOf/0', '/p/q/q allOf #', '/p/p/q/q oneOf #/allOf/0', '/p/p/q/q allOf #',
      '/p/p/p oneOf #/allOf/0', '/p/p/p allOf #', '/p/p allOf #/allOf/0/oneOf/1', '/p/p oneOf #/allOf/0', '/p/p allOf #',
      '/p allOf #/allOf/0/oneOf/1', '/p oneOf #/allOf/0', '/p allOf #', ' allOf #',
    ]);
  });

  it('keeps the order in which the errors first appeared', () => {
    const schema = { oneOf: [{ items: { type: 'string' } }, { items: { $ref: '#/definitions/s' } }], definitions: { s: { type: 'string' } } };
    assert.deepStrictEqual(collect(schema, [1, 2]).errors.map(place), [
      '/0 type #/oneOf/0/items', '/1 type #/oneOf/0/items', ' items #/oneOf/0',
      '/0 type #/definitions/s', '/1 type #/definitions/s', ' items #/oneOf/1', ' oneOf #',
    ]);
  });

  it('keeps one error of an allOf whose branches fail alike', () => {
    assert.deepStrictEqual(collect({ allOf: [false, false] }, 1).errors.map(place), [' allOf #']);
    assert.deepStrictEqual(collect({ allOf: [{ type: 'string' }, { type: 'string' }] }, 1).errors.map(place),
      [' type #/allOf/0', ' allOf #', ' type #/allOf/1']);
  });

  it('reads params in depth when it tells two errors apart', () => {
    // one definition entered twice where no answer is kept: its errors once, params of objects included
    const definitions = { d: { const: { a: [1] }, enum: [{ a: [2] }, 3] } };
    const { errors } = collect({ allOf: [{ $ref: '#/definitions/d' }, { $ref: '#/definitions/d' }], definitions }, { a: [9] });
    assert.deepStrictEqual(errors.map((e) => [e.keyword, e.params]),
      [['const', { allowedValue: { a: [1] } }], ['enum', { allowedValues: [{ a: [2] }, 3] }], ['allOf', {}]]);
    // the same keyword at the same place, apart by a param alone
    const names = collect({ required: ['a', 'b', 'c'] }, {}).errors;
    assert.deepStrictEqual(names.map((e) => e.params.missingProperty), ['a', 'b', 'c']);
  });

  it('keeps an error again that a discard took from the list (not, if, contains, a matching anyOf)', () => {
    const definitions = { inner: { type: 'string' }, outer: { allOf: [{ $ref: '#/definitions/inner' }, { minLength: 3 }] } };
    const both = { allOf: [{ $ref: '#/definitions/inner' }, { $ref: '#/definitions/outer' }] };
    // inside the discarded subschema `outer` is entered with `inner`'s error in the list already;
    // its kept answer is given again after the discard, and must hold that error
    assert.deepStrictEqual(collect({ definitions, anyOf: [{ allOf: [{ not: both }, { $ref: '#/definitions/outer' }] }, { type: 'null' }] }, 5).errors.map(place),
      [' type #/definitions/inner', ' allOf #/definitions/outer', ' allOf #/anyOf/0', ' type #/anyOf/1', ' anyOf #']);
    assert.deepStrictEqual(collect({ definitions, oneOf: [{ if: both, then: true, else: { $ref: '#/definitions/outer' } }, { type: 'null' }] }, 5).errors.map(place),
      [' type #/definitions/inner', ' allOf #/definitions/outer', ' type #/oneOf/1', ' oneOf #']);
    assert.deepStrictEqual(collect({ definitions, anyOf: [{ items: { allOf: [{ $ref: '#/definitions/inner' }] }, contains: both }, { type: 'null' }] }, [5, 6]).errors.map(place), [
      '/0 type #/definitions/inner', '/0 allOf #/anyOf/0/items', '/1 type #/definitions/inner', '/1 allOf #/anyOf/0/items',
      ' items #/anyOf/0', ' contains #/anyOf/0', ' type #/anyOf/1', ' anyOf #',
    ]);
    const capped = { inner: { type: 'string' }, outer: { allOf: [{ $ref: '#/definitions/inner' }, { maximum: 1 }] } };
    assert.deepStrictEqual(collect({ definitions: capped, allOf: [{ anyOf: [{ $ref: '#/definitions/outer' }, true] }, { oneOf: [{ $ref: '#/definitions/outer' }, { $ref: '#/definitions/inner' }] }] }, 5).errors.map(place),
      [' type #/definitions/inner', ' allOf #/definitions/outer', ' maximum #/definitions/outer/allOf/1', ' oneOf #/allOf/1', ' allOf #']);
  });

  it('tells apart the errors of two names a propertyNames subschema refused', () => {
    const schema = {
      definitions: { name: { minLength: 3, pattern: '^x' } },
      oneOf: [{ propertyNames: { $ref: '#/definitions/name' } }, { propertyNames: { allOf: [{ $ref: '#/definitions/name' }] } }, { type: 'null' }],
    };
    assert.deepStrictEqual(collect(schema, { ab: 1, cd: 2 }).errors.map(place), [
      ' minLength #/definitions/name ab', ' pattern #/definitions/name ab', ' minLength #/definitions/name cd', ' pattern #/definitions/name cd',
      ' allOf #/oneOf/1/propertyNames ab', ' allOf #/oneOf/1/propertyNames cd', ' type #/oneOf/2', ' oneOf #',
    ]);
  });

  it('keeps the same list where no answer is kept (unevaluated*, a dynamic anchor)', () => {
    const kept = collect(grammar, nested(3)).errors.map(place);
    const tracked = collect({ ...grammar, unevaluatedProperties: true }, nested(3)).errors.map(place);
    const dynamic = collect({ $schema: 'https://json-schema.org/draft/2020-12/schema', $defs: { scope: { $dynamicAnchor: 'unused' } }, ...grammar }, nested(3)).errors.map(place);
    assert.strictEqual(kept.length, 58);
    assert.deepStrictEqual(tracked, kept);
    assert.deepStrictEqual(dynamic.map((p) => p.replace(' #/$defs/', ' #/definitions/')), kept);
  });

  it('gives the validator\'s errors property one record per distinct error', () => {
    const validate = new JarenValidator({ skipErrors: false }).compile({ allOf: [false, false, { $ref: '#/definitions/s' }, { $ref: '#/definitions/s' }], definitions: { s: { type: 'string' } } });
    assert.strictEqual(validate(1), false);
    assert.strictEqual(validate.errors.length, 2);
    assert.strictEqual(validate.errors, validate.errors);
  });

  it('gives the errors property of each validation without its repeats, read once or again', () => {
    // two entries of one definition where no answer is kept: one error read from two records
    const schema = { allOf: [{ $ref: '#/definitions/s' }, { $ref: '#/definitions/s' }, { maximum: 3 }], definitions: { s: { type: 'string' } } };
    const records = (options) => {
      const validate = new JarenValidator({ skipErrors: false, ...options }).compile(schema);
      validate(1);
      const first = validate.errors.length;
      validate(9);
      return [first, validate.errors.length, validate.errors.length];
    };
    assert.deepStrictEqual(records(), [2, 3, 3]);
    // the collecting result and the property read the same records
    assert.deepStrictEqual(records(COLLECT), [2, 3, 3]);
  });

  it('starts each validation with a list of its own', () => {
    const validate = new JarenValidator(COLLECT).compile(grammar);
    validate(nested(2));
    assert.deepStrictEqual(validate(nested(4)).errors, new JarenValidator(COLLECT).compile(grammar)(nested(4)).errors);
    assert.deepStrictEqual(validate(nested(1)).errors.length, 32);
  });
});
