//@ts-check
// The two instance maps of a strict profile, where a value could be read two
// ways. At a union, `toProfile` writes a value in the branch it belongs to —
// the first whose original schema accepts it — and `fromProfile` reads an
// answer two branches read differently through the first branch whose
// original accepts what that branch reads. A `null` in an answer, at a member
// the original does not require, is the profile's spelling of an absent
// member: a model under a strict profile has no other way to leave one out.
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { JarenValidator } from '@jarenjs/validate';
import { deriveStrictProfile } from '@jarenjs/validate/strict-profile';
import { compileJsonQuery } from '@jarenjs/json/query';
import query from '@jarenjs/json/schemas/jaren-query.schema.json' with { type: 'json' };

const D20 = 'https://json-schema.org/draft/2020-12/schema';
/** @param {any} schema */
const original = (schema) => new JarenValidator().compile(schema);
/** @param {any} profile */
const profiled = (profile) => new JarenValidator().compile({ $schema: D20, ...profile });
/** A closed object of one required member. @param {string} name @param {unknown} schema */
const closed = (name, schema) => ({ type: 'object', properties: { [name]: schema }, required: [name], additionalProperties: false });
const text = { type: 'string' };

describe('toProfile: a value at a union is written in the branch it belongs to', () => {
  const nullable = closed('a', { type: ['string', 'null'] });
  const other = closed('b', text);

  it('takes the branch whose original accepts the value, whichever branch comes first', () => {
    for (const branches of [[nullable, other], [other, nullable]]) {
      const schema = { anyOf: branches };
      const strict = deriveStrictProfile(schema);
      // filled into the other branch the value would read { a: null }, which the profile accepts
      assert.deepEqual(strict.toProfile({ b: 'x' }), { value: { b: 'x' } });
      assert.deepEqual(strict.toProfile({ a: 'x' }), { value: { a: 'x' } });
      assert.deepEqual(strict.toProfile({ a: null }), { value: { a: null } });
      for (const value of [{ b: 'x' }, { a: 'x' }, { a: null }]) {
        assert.equal(profiled(strict.schema)(strict.toProfile(value)), true);
        assert.deepEqual(strict.fromProfile(strict.toProfile(value)), value);
      }
    }
  });

  it('takes the first of several branches whose original accepts the value', () => {
    const narrow = { type: 'object', properties: { a: text }, additionalProperties: false };
    const wide = { type: 'object', properties: { a: text, b: text }, additionalProperties: false };
    assert.deepEqual(deriveStrictProfile({ anyOf: [narrow, wide] }).toProfile({ a: 'x' }), { value: { a: 'x' } });
    assert.deepEqual(deriveStrictProfile({ anyOf: [wide, narrow] }).toProfile({ a: 'x' }), { value: { a: 'x', b: null } });
    assert.deepEqual(deriveStrictProfile({ anyOf: [narrow, wide] }).toProfile({ a: 'x', b: 'y' }), { value: { a: 'x', b: 'y' } });
  });

  it('writes a value the original refuses in every branch as before: in the first branch its filled value fits, else as it is', () => {
    const strict = deriveStrictProfile({ anyOf: [nullable, other] });
    assert.equal(original({ anyOf: [nullable, other] })({ c: 1 }), false);
    assert.deepEqual(strict.toProfile({ c: 1 }), { value: { a: null } });
    assert.deepEqual(strict.toProfile(5), { value: 5 });
    assert.deepEqual(deriveStrictProfile({ anyOf: [other, closed('c', text)] }).toProfile({ d: 1 }), { value: { d: 1 } });
  });

  it('asks the original\'s branch for an object copied into its branches', () => {
    // the whole object accepts a value of either branch: only the branch tells whose it is
    const schema = { type: 'object', required: ['kind'], properties: { kind: { enum: ['a', 'b'] }, size: { type: ['number', 'null'] } },
      anyOf: [{ properties: { kind: { const: 'a' }, unit: text }, required: ['size'] }, { properties: { kind: { const: 'b' } } }] };
    const strict = deriveStrictProfile(schema);
    assert.deepEqual(strict.toProfile({ kind: 'b' }), { value: { kind: 'b', size: null } });
    assert.deepEqual(strict.toProfile({ kind: 'a', size: 1 }), { value: { kind: 'a', size: 1, unit: null } });
    for (const value of [{ kind: 'b' }, { kind: 'a', size: 1 }, { kind: 'b', size: 2 }, { kind: 'a', size: 1, unit: 'm' }]) {
      assert.equal(profiled(strict.schema)(strict.toProfile(value)), true);
      assert.deepEqual(strict.fromProfile(strict.toProfile(value)), value);
    }
  });

  it('asks the original for a value carried as boxed JSON text', () => {
    // a free-form object beside a string is boxed as { json }; beside it stands a closed object whose member admits null
    const schema = { anyOf: [text, closed('a', { type: ['string', 'null'] }), { type: 'object' }] };
    const strict = deriveStrictProfile(schema);
    assert.deepEqual(strict.toProfile({ b: 1 }), { value: { json: '{"b":1}' } });
    assert.deepEqual(strict.toProfile({ a: null }), { value: { a: null } });
    assert.deepEqual(strict.toProfile('s'), { value: 's' });
    for (const value of [{ b: 1 }, { a: null }, { a: 'x' }, 's', {}]) assert.deepEqual(strict.fromProfile(strict.toProfile(value)), value);
  });

  it('asks every place that declares a member an object and its branch both declare', () => {
    const schema = { type: 'object', properties: { v: { $ref: '#/$defs/t' }, w: text }, allOf: [{ properties: { v: true, u: { $ref: '#/$defs/t' } } }],
      $defs: { t: { anyOf: [text, { type: 'number' }] } } };
    const strict = deriveStrictProfile(schema);
    assert.deepEqual(strict.toProfile({ v: 5, u: 'x' }), { v: 5, w: null, u: 'x' });
    assert.deepEqual(strict.fromProfile(strict.toProfile({ v: 5, u: 'x' })), { v: 5, u: 'x' });
    assert.deepEqual(strict.toProfile({ w: 'y' }), { v: null, w: 'y', u: null });
  });

  it('asks the places that declare a member the object itself does not', () => {
    // v is declared by two branches only, one of them narrowing it: the member stands for both places
    const schema = { type: 'object', allOf: [{ properties: { v: { $ref: '#/$defs/t' } } }, { properties: { v: { maxLength: 3 } } }],
      $defs: { t: { anyOf: [text, { type: 'number' }] } } };
    const strict = deriveStrictProfile(schema);
    assert.deepEqual(strict.toProfile({ v: 'abc' }), { value: { v: 'abc' } });
    assert.deepEqual(strict.toProfile({ v: 7 }), { value: { v: 7 } });
    assert.deepEqual(strict.toProfile({}), { value: { v: null } });
    for (const value of [{ v: 'abc' }, { v: 7 }, {}]) assert.deepEqual(strict.fromProfile(strict.toProfile(value)), value);
  });

  it('writes a member of a map in the first value schema whose original accepts it', () => {
    const schema = { type: 'object', patternProperties: { '^n': { type: 'object', properties: { n: { type: 'number' } }, additionalProperties: false } },
      additionalProperties: { type: 'object', properties: { s: text }, additionalProperties: false } };
    const strict = deriveStrictProfile(schema);
    const value = { n1: { n: 1 }, other: { s: 'x' }, empty: {} };
    assert.deepEqual(strict.toProfile(value), { value: [{ key: 'n1', value: { n: 1 } }, { key: 'other', value: { s: 'x' } }, { key: 'empty', value: { n: null } }] });
    assert.deepEqual(strict.fromProfile(strict.toProfile(value)), value);
  });

  it('leaves a value of undefined as it was read', () => {
    const strict = deriveStrictProfile({ type: 'object', properties: { u: { anyOf: [nullable, other] } } });
    assert.deepEqual(strict.toProfile({ u: undefined }), { u: undefined });
  });
});

describe('fromProfile: an answer two branches read differently', () => {
  // a map that refuses $ names, and a phrase whose one $ name holds a tuple, carried as JSON text
  const map = { type: 'object', patternProperties: { '^\\$': false }, additionalProperties: text };
  const phrase = { type: 'object', propertyNames: { enum: ['$pair'] }, minProperties: 1, additionalProperties: { type: 'array', prefixItems: [{ type: 'number' }, text] } };

  it('is the reading of the first branch whose original accepts what that branch reads', () => {
    for (const branches of [[map, phrase], [phrase, map]]) {
      const schema = { anyOf: branches };
      const strict = deriveStrictProfile(schema);
      const filled = strict.toProfile({ $pair: [1, 'x'] });
      assert.deepEqual(filled, { value: [{ key: '$pair', value: '[1,"x"]' }] });
      assert.equal(profiled(strict.schema)(filled), true);
      // read as the map it would be { $pair: '[1,"x"]' }, which the map refuses for its name
      assert.deepEqual(strict.fromProfile(filled), { $pair: [1, 'x'] });
      assert.deepEqual(strict.fromProfile(strict.toProfile({ a: 'x' })), { a: 'x' });
    }
  });

  it('stays as written where no branch\'s original accepts its reading, for the original to refuse', () => {
    const strict = deriveStrictProfile({ anyOf: [map, phrase] });
    const answer = { value: [{ key: '$other', value: '[1,"x"]' }] };
    assert.equal(profiled(strict.schema)(answer), true);
    assert.deepEqual(strict.fromProfile(answer), [{ key: '$other', value: '[1,"x"]' }]);
    assert.equal(original({ anyOf: [map, phrase] })(strict.fromProfile(answer)), false);
  });

  it('leaves an answer no branch of the profile accepts as it is, for the original to refuse', () => {
    const schema = { anyOf: [closed('a', text), closed('b', text)] };
    const strict = deriveStrictProfile(schema);
    assert.equal(profiled(strict.schema)({ value: 5 }), false);
    assert.equal(strict.fromProfile({ value: 5 }), 5);
    assert.deepEqual(strict.fromProfile({ value: { c: 'x' } }), { c: 'x' });
    assert.equal(original(schema)(strict.fromProfile({ value: { c: 'x' } })), false);
  });

  it('reads an empty entries array beside an array branch as the first of the two', () => {
    const list = { type: 'array', items: text };
    const bag = { type: 'object', additionalProperties: text };
    assert.deepEqual(deriveStrictProfile({ anyOf: [list, bag] }).fromProfile({ value: [] }), []);
    assert.deepEqual(deriveStrictProfile({ anyOf: [bag, list] }).fromProfile({ value: [] }), {});
    // so an empty map beside an array that stands first does not come back
    const strict = deriveStrictProfile({ anyOf: [list, bag] });
    assert.deepEqual(strict.toProfile({}), { value: [] });
    assert.deepEqual(strict.fromProfile(strict.toProfile({})), []);
    assert.deepEqual(strict.fromProfile(strict.toProfile({ a: 'x' })), { a: 'x' });
  });
});

describe('fromProfile: a null at a member the original does not require is the member left out', () => {
  it('removes it whether the member\'s schema refuses null or admits it, and keeps the null of a required member', () => {
    const schema = { type: 'object', required: ['must'], properties: { must: { type: ['string', 'null'] }, refuses: text, admits: { type: ['string', 'null'] } } };
    const strict = deriveStrictProfile(schema);
    assert.deepEqual(strict.fromProfile({ must: null, refuses: null, admits: null }), { must: null });
    assert.deepEqual(strict.fromProfile({ must: 'm', refuses: 'r', admits: 'a' }), { must: 'm', refuses: 'r', admits: 'a' });
    // an instance that leaves members out comes back as it was
    for (const instance of [{ must: null }, { must: 'm' }, { must: 'm', admits: 'a' }]) assert.deepEqual(strict.fromProfile(strict.toProfile(instance)), instance);
  });

  it('does not carry an explicit null at an optional member; requiring the member does', () => {
    const optional = deriveStrictProfile({ type: 'object', properties: { a: { type: ['string', 'null'] } } });
    assert.deepEqual(optional.toProfile({ a: null }), { a: null });
    assert.deepEqual(optional.fromProfile(optional.toProfile({ a: null })), {});
    const required = deriveStrictProfile({ type: 'object', required: ['a'], properties: { a: { type: ['string', 'null'] } } });
    assert.deepEqual(required.fromProfile(required.toProfile({ a: null })), { a: null });
  });

  it('keeps the null the original needs: it refuses the answer without the member and accepts it with the null', () => {
    const needs = { type: 'object', properties: { a: { type: ['string', 'null'] }, b: text, c: { type: ['number', 'null'] } }, dependentRequired: { b: ['a'] } };
    const strict = deriveStrictProfile(needs);
    assert.equal(original(needs)({ b: 'x' }), false);
    // a stays, for b needs it; c does not
    assert.deepEqual(strict.fromProfile({ a: null, b: 'x', c: null }), { a: null, b: 'x' });
    assert.deepEqual(strict.fromProfile({ a: null, b: null, c: null }), {});
    assert.deepEqual(strict.fromProfile({ a: 'v', b: 'x', c: 1 }), { a: 'v', b: 'x', c: 1 });
    // the members stay where the answer wrote them
    assert.deepEqual(Object.keys(/** @type {object} */ (strict.fromProfile({ c: 2, a: null, b: 'x' }))), ['c', 'a', 'b']);
  });

  it('keeps no more nulls than the original needs', () => {
    const some = { type: 'object', properties: { p: { type: ['string', 'null'] }, q: { type: ['string', 'null'] }, r: { type: ['string', 'null'] } }, minProperties: 2 };
    const strict = deriveStrictProfile(some);
    // any two do: the first is left out, the other two stay
    assert.deepEqual(strict.fromProfile({ p: null, q: null, r: null }), { q: null, r: null });
    assert.deepEqual(strict.fromProfile({ p: 'x', q: null, r: null }), { p: 'x', r: null });
    assert.deepEqual(strict.fromProfile({ p: 'x', q: 'y', r: null }), { p: 'x', q: 'y' });
  });

  it('leaves the members out where the original refuses the answer both ways', () => {
    const schema = { type: 'object', required: ['n'], properties: { n: { type: 'number' }, a: { type: ['string', 'null'] } } };
    const strict = deriveStrictProfile(schema);
    assert.deepEqual(strict.fromProfile({ n: 'no number', a: null }), { n: 'no number' });
  });

  it('reads a FLWOR answered in its closed branch as the query written without the unused clauses, and the engine answers alike', () => {
    const strict = deriveStrictProfile(query);
    // every clause present, as a strict decoder writes them, the unused ones null
    const answer = { value: { $fold: null, $for: [{ key: 'x', value: '$.a[*]' }], $let: null, $as: null, $where: null, $groupby: null, $orderby: null, $count: null, $return: '$x' } };
    assert.equal(profiled(strict.schema)(answer), true);
    const written = { $for: { x: '$.a[*]' }, $return: '$x' };
    assert.deepEqual(strict.fromProfile(answer), written);
    const data = { a: [2, 1] };
    assert.deepEqual(compileJsonQuery(/** @type {any} */ (strict.fromProfile(answer)))(data), compileJsonQuery(written)(data));
    assert.deepEqual(compileJsonQuery(written)(data), [2, 1]);
    // the clauses as nulls, which the grammar accepts, are another query: nothing passes a null $where
    assert.equal(compileJsonQuery({ ...written, $where: null })(data), undefined);
    // a clause that is used stays
    const filtered = { value: { ...answer.value, $where: [{ key: '$gt', value: ['$x', 1] }] } };
    const kept = { $for: { x: '$.a[*]' }, $where: { $gt: ['$x', 1] }, $return: '$x' };
    assert.deepEqual(strict.fromProfile(filtered), kept);
    assert.deepEqual(compileJsonQuery(/** @type {any} */ (strict.fromProfile(filtered)))(data), compileJsonQuery(kept)(data));
    assert.equal(compileJsonQuery(kept)(data), 2);
  });
});

describe('a map\'s key note', () => {
  /** @param {any} schema */
  const keyNote = (schema) => deriveStrictProfile(schema).schema.properties.value.items.properties.key.description;

  it('says which names take a pattern\'s value schema, and which names no member may carry', () => {
    assert.equal(keyNote({ type: 'object', additionalProperties: text }), '(strict profile: a member name)');
    assert.equal(keyNote({ type: 'object', patternProperties: { '^x-': text }, additionalProperties: false }),
      '(strict profile: a member name; a name matching "^x-" takes that pattern\'s value schema, and every name matches one; the original schema enforces it)');
    // a pattern whose schema is false gives a name no value
    assert.equal(keyNote({ type: 'object', patternProperties: { '^\\$': false }, additionalProperties: text }),
      '(strict profile: a member name; no name matches "^\\\\$"; the original schema enforces it)');
    assert.equal(keyNote({ type: 'object', patternProperties: { '^x-': text, '^\\$': false, '^_': false }, additionalProperties: { type: 'number' } }),
      '(strict profile: a member name; a name matching "^x-" takes that pattern\'s value schema; no name matches "^\\\\$" or "^_"; the original schema enforces it)');
  });

  it('is what the query grammar\'s map constructor says of a $ name', () => {
    const { schema } = deriveStrictProfile(query);
    assert.equal(schema.$defs.mapConstructor.items.properties.key.description, '(strict profile: a member name; no name matches "^\\\\$"; the original schema enforces it)');
  });
});
