import { describe, it } from 'node:test';
import { strictEqual, deepStrictEqual, notStrictEqual } from 'node:assert';

import { compileNormalizer } from '@jarenjs/validate/normalize';
import { JarenValidator } from '@jarenjs/validate';

// Every normalization is opt-in, so most cases enable exactly what they test.
const ALL = {
  useDefaults: true,
  removeAdditional: true,
  coerceTypes: true,
  trimStrings: true,
};

describe('compileNormalizer — the non-mutation contract', () => {
  it('returns a new value and leaves the input untouched', () => {
    const normalize = compileNormalizer({
      type: 'object',
      properties: {
        name: { type: 'string' },
        port: { type: 'integer', default: 8080 },
      },
      additionalProperties: false,
    }, ALL);

    const input = { name: '  jaren  ', port: '9000', stray: 1 };
    const before = { ...input };
    deepStrictEqual(normalize(input), { name: 'jaren', port: 9000 });
    deepStrictEqual(input, before);
  });

  it('normalizes a deep-frozen document', () => {
    // Frozen input is the strongest statement of "never mutates": any
    // in-place write would throw in strict mode.
    const normalize = compileNormalizer({
      type: 'object',
      properties: {
        a: { type: 'object', properties: { b: { type: 'array', items: { type: 'string' } } } },
      },
    }, ALL);
    const input = Object.freeze({ a: Object.freeze({ b: Object.freeze(['  x  ']) }) });
    deepStrictEqual(normalize(input), { a: { b: ['x'] } });
  });

  it('returns the input reference when nothing changes', () => {
    const normalize = compileNormalizer({
      type: 'object',
      properties: { name: { type: 'string' }, port: { type: 'integer', default: 8080 } },
      additionalProperties: false,
    }, ALL);
    const clean = { name: 'jaren', port: 8080 };
    strictEqual(normalize(clean), clean);
  });

  it('shares untouched subtrees by reference', () => {
    const normalize = compileNormalizer({
      type: 'object',
      properties: { keep: { type: 'object' }, fix: { type: 'integer' } },
    }, ALL);
    const input = { keep: { big: 'subtree' }, fix: '42' };
    const out = normalize(input);
    notStrictEqual(out, input);
    strictEqual(out.keep, input.keep);
    strictEqual(out.fix, 42);
  });

  it('is the identity when no option is enabled', () => {
    const normalize = compileNormalizer({ type: 'object', properties: { a: { type: 'integer' } } });
    const input = { a: '1' };
    strictEqual(normalize(input), input);
  });
});

describe('compileNormalizer — defaults', () => {
  it('materializes defaults recursively for absent properties only', () => {
    const normalize = compileNormalizer({
      type: 'object',
      properties: {
        a: { type: 'integer', default: 1 },
        nested: {
          type: 'object',
          properties: { b: { type: 'string', default: 'x' } },
        },
      },
    }, { useDefaults: true });
    deepStrictEqual(normalize({ nested: {} }), { nested: { b: 'x' }, a: 1 });
    // present-but-falsy stays: a default fills absence, not emptiness
    deepStrictEqual(normalize({ a: 0, nested: { b: '' } }), { a: 0, nested: { b: '' } });
  });

  it('gives each result its own copy of a container default', () => {
    const normalize = compileNormalizer({
      type: 'object',
      properties: { list: { type: 'array', default: [] } },
    }, { useDefaults: true });
    const first = normalize({});
    const second = normalize({});
    first.list.push(1);
    deepStrictEqual(second.list, []);
  });

  it('applies a root default to an absent document', () => {
    const normalize = compileNormalizer(
      { type: 'object', default: { a: 1 }, properties: {} },
      { useDefaults: true });
    deepStrictEqual(normalize(undefined), { a: 1 });
  });
});

describe('compileNormalizer — removeAdditional', () => {
  it('true strips only where additionalProperties is false', () => {
    const closed = { type: 'object', properties: { a: {} }, additionalProperties: false };
    const open = { type: 'object', properties: { a: {} } };
    deepStrictEqual(compileNormalizer(closed, { removeAdditional: true })({ a: 1, z: 2 }), { a: 1 });
    deepStrictEqual(compileNormalizer(open, { removeAdditional: true })({ a: 1, z: 2 }), { a: 1, z: 2 });
  });

  it("'all' strips wherever a shape is declared", () => {
    const open = { type: 'object', properties: { a: {} } };
    deepStrictEqual(compileNormalizer(open, { removeAdditional: 'all' })({ a: 1, z: 2 }), { a: 1 });
  });

  it('never empties an object whose shape is undeclared', () => {
    deepStrictEqual(compileNormalizer({ type: 'object' }, { removeAdditional: 'all' })({ a: 1 }), { a: 1 });
  });

  it('keeps a declared property whose subschema normalizes nothing', () => {
    // A declared name with no work to do must not read as "unknown".
    deepStrictEqual(
      compileNormalizer({ type: 'object', properties: { a: {} }, additionalProperties: false },
        { removeAdditional: true })({ a: 1, z: 2 }),
      { a: 1 });
    deepStrictEqual(
      compileNormalizer({ type: 'object', patternProperties: { '^k': {} }, additionalProperties: false },
        { removeAdditional: true })({ ka: 1, z: 2 }),
      { ka: 1 });
  });

  it('strips nested objects too', () => {
    const normalize = compileNormalizer({
      type: 'object',
      properties: {
        inner: { type: 'object', properties: { a: {} }, additionalProperties: false },
      },
      additionalProperties: false,
    }, { removeAdditional: true });
    deepStrictEqual(normalize({ inner: { a: 1, z: 2 }, y: 3 }), { inner: { a: 1 } });
  });
});

describe('compileNormalizer — coercion and trimming', () => {
  const coerce = type => compileNormalizer({ type }, { coerceTypes: true });

  it('converts strings that are exactly JSON numbers', () => {
    strictEqual(coerce('number')('1e5'), 100000);
    strictEqual(coerce('number')('-0.5'), -0.5);
    strictEqual(coerce('integer')('42'), 42);
  });

  it('leaves anything outside the grammar alone for validation to reject', () => {
    strictEqual(coerce('integer')('4.5'), '4.5');
    strictEqual(coerce('number')('0x10'), '0x10');
    strictEqual(coerce('number')(''), '');
    strictEqual(coerce('number')('  '), '  ');
    strictEqual(coerce('boolean')('yes'), 'yes');
  });

  it('converts booleans, strings and null only in the unambiguous direction', () => {
    strictEqual(coerce('boolean')('true'), true);
    strictEqual(coerce('boolean')('false'), false);
    strictEqual(coerce('string')(42), '42');
    strictEqual(coerce('string')(true), 'true');
    strictEqual(coerce('null')('null'), null);
  });

  it('skips coercion for a union type', () => {
    strictEqual(compileNormalizer({ type: ['string', 'number'] }, { coerceTypes: true })('5'), '5');
  });

  it('trims before coercing, so padded transport values decode', () => {
    strictEqual(compileNormalizer({ type: 'integer' }, ALL)('  42  '), 42);
    strictEqual(compileNormalizer({ type: 'string' }, { trimStrings: true })('  hi  '), 'hi');
  });
});

describe('compileNormalizer — schema shapes', () => {
  it('walks patternProperties', () => {
    const normalize = compileNormalizer({
      type: 'object', patternProperties: { '^n_': { type: 'integer' } },
    }, { coerceTypes: true });
    deepStrictEqual(normalize({ n_a: '1', other: '2' }), { n_a: 1, other: '2' });
  });

  it('walks both tuple spellings', () => {
    const draft2020 = compileNormalizer({
      type: 'array', prefixItems: [{ type: 'integer' }, { type: 'boolean' }], items: { type: 'string' },
    }, { coerceTypes: true });
    deepStrictEqual(draft2020(['1', 'true', 5, 6]), [1, true, '5', '6']);

    const draft7 = compileNormalizer({
      type: 'array', items: [{ type: 'integer' }], additionalItems: { type: 'string' },
    }, { coerceTypes: true });
    deepStrictEqual(draft7(['1', 5]), [1, '5']);
  });

  it('follows same-document $ref, including recursion', () => {
    const tree = {
      type: 'object',
      properties: { name: { type: 'string' }, kids: { type: 'array', items: { $ref: '#' } } },
    };
    deepStrictEqual(
      compileNormalizer(tree, ALL)({ name: '  a  ', kids: [{ name: '  b  ', kids: [{ name: '  c  ' }] }] }),
      { name: 'a', kids: [{ name: 'b', kids: [{ name: 'c' }] }] });

    const defs = { $defs: { S: { type: 'string' } }, type: 'object', properties: { v: { $ref: '#/$defs/S' } } };
    deepStrictEqual(compileNormalizer(defs, ALL)({ v: '  q  ' }), { v: 'q' });
  });

  it('does not apply structure from a $ref it cannot follow', () => {
    // Refs into other documents are not resolved here, so the target's
    // shape contributes nothing. Node-level trimming still applies, since
    // it does not depend on knowing the target.
    const normalize = compileNormalizer({
      type: 'object', properties: { v: { $ref: 'https://example.com/other#' } },
    }, { useDefaults: true, removeAdditional: 'all' });
    const input = { v: { anything: 1 } };
    strictEqual(normalize(input), input);
  });

  it('composes allOf branches without letting one strip the others', () => {
    const normalize = compileNormalizer({
      allOf: [
        { type: 'object', properties: { a: { type: 'integer' } } },
        { type: 'object', properties: { b: { type: 'integer' } } },
      ],
    }, ALL);
    deepStrictEqual(normalize({ a: '1', b: '2' }), { a: 1, b: 2 });
  });

  it('does not descend anyOf/oneOf/if branches', () => {
    // Which branch applies is only known after validating, so normalizing
    // under one could change which branch validates.
    const normalize = compileNormalizer({
      anyOf: [{ type: 'object', properties: { a: { type: 'integer', default: 1 } } }],
    }, ALL);
    const input = { b: '2' };
    strictEqual(normalize(input), input);
  });

  it('keeps __proto__ an own data property', () => {
    const normalize = compileNormalizer({
      type: 'object', properties: { ['__proto__']: { type: 'integer' } },
    }, { coerceTypes: true });
    const out = normalize(JSON.parse('{"__proto__": "1"}'));
    strictEqual(Object.getPrototypeOf(out), Object.prototype);
    strictEqual(Object.getOwnPropertyDescriptor(out, '__proto__').value, 1);
    strictEqual({}.polluted, undefined);
  });
});

describe('compileNormalizer — composed with a validator', () => {
  it('turns input that fails validation into input that passes', () => {
    const schema = {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1 },
        port: { type: 'integer', default: 8080 },
      },
      required: ['name', 'port'],
      additionalProperties: false,
    };
    const normalize = compileNormalizer(schema, ALL);
    const validate = new JarenValidator({ collectErrors: true }).compile(schema);

    const raw = { name: '  jaren  ', stray: true };
    strictEqual(validate(raw).valid, false);

    const shaped = normalize(raw);
    deepStrictEqual(shaped, { name: 'jaren', port: 8080 });
    strictEqual(validate(shaped).valid, true);
  });
});

describe('validator options — an unset option keeps its per-draft default', () => {
  // Constructing with an options object must not silently change a default
  // the caller never mentioned.
  const draft7Base64 = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'string',
    contentEncoding: 'base64',
  };

  it('asserts contentEncoding under draft-07 whether or not options are passed', () => {
    strictEqual(new JarenValidator().compile(draft7Base64)('!!!not-base64!!!'), false);
    strictEqual(
      new JarenValidator({ collectErrors: true }).compile(draft7Base64)('!!!not-base64!!!').valid,
      false);
  });

  it('still honors an explicit contentValidation: false', () => {
    strictEqual(
      new JarenValidator({ collectErrors: true, contentValidation: false })
        .compile(draft7Base64)('!!!not-base64!!!').valid,
      true);
  });

  it('leaves contentEncoding annotation-only from 2019-09 on', () => {
    const draft2020 = { ...draft7Base64, $schema: 'https://json-schema.org/draft/2020-12/schema' };
    strictEqual(
      new JarenValidator({ collectErrors: true }).compile(draft2020)('!!!not-base64!!!').valid,
      true);
  });
});

describe('compileNormalizer — per-node control', () => {
  // A whole-schema switch is the wrong granularity for a real contract: a
  // service typically trims a handful of fields and must leave the rest
  // exactly as supplied. A compile-time predicate expresses that without
  // costing anything at runtime.
  const tenant = {
    type: 'object',
    properties: {
      name: { type: 'string', 'x-trim': true },
      slug: { type: 'string', 'x-trim': true },
      defaultTimeZone: { type: 'string' },
    },
  };

  it('trims only the nodes the predicate selects', () => {
    const normalize = compileNormalizer(tenant,
      { trimStrings: (node) => node['x-trim'] === true });
    deepStrictEqual(
      normalize({ name: '  Acme  ', slug: '  acme  ', defaultTimeZone: ' Europe/Amsterdam ' }),
      { name: 'Acme', slug: 'acme', defaultTimeZone: ' Europe/Amsterdam ' });
  });

  it('coerces only the nodes the predicate selects', () => {
    const normalize = compileNormalizer({
      type: 'object',
      properties: { a: { type: 'integer', 'x-coerce': true }, b: { type: 'integer' } },
    }, { coerceTypes: (node) => node['x-coerce'] === true });
    deepStrictEqual(normalize({ a: '1', b: '2' }), { a: 1, b: '2' });
  });

  it('materializes only the defaults the predicate selects', () => {
    const normalize = compileNormalizer({
      type: 'object',
      properties: { a: { default: 1, 'x-default': true }, b: { default: 2 } },
    }, { useDefaults: (node) => node['x-default'] === true });
    deepStrictEqual(normalize({}), { a: 1 });
  });

  it('keeps the boolean forms behaving exactly as before', () => {
    deepStrictEqual(
      compileNormalizer(tenant, { trimStrings: true })({ name: ' a ', slug: ' b ', defaultTimeZone: ' c ' }),
      { name: 'a', slug: 'b', defaultTimeZone: 'c' });
    deepStrictEqual(
      compileNormalizer(tenant, { trimStrings: false })({ name: ' a ' }), { name: ' a ' });
  });
});

describe('compileNormalizer — member schemas compose', () => {
  it('applies properties and every matching patternProperties in turn', () => {
    const both = compileNormalizer({
      type: 'object', patternProperties: { '^a': { type: 'integer' }, 'b$': { type: 'string' } },
    }, { coerceTypes: true });
    // '^a' coerces to a number, then 'b$' coerces back to a string
    deepStrictEqual(both({ ab: '5' }), { ab: '5' });

    // The named step trims and coerces to a number; the pattern step then
    // coerces that number back to a string. Both ran, in order.
    const named = compileNormalizer({
      type: 'object', properties: { a1: { type: 'integer' } }, patternProperties: { '^a': { type: 'string' } },
    }, { coerceTypes: true, trimStrings: true });
    deepStrictEqual(named({ a1: '  7  ' }), { a1: '7' });
  });

  it('runs a materialized container default through its own schema', () => {
    const normalize = compileNormalizer({
      type: 'object',
      properties: {
        cfg: { type: 'object', default: { port: '8080' }, properties: { port: { type: 'integer' } } },
      },
    }, { useDefaults: true, coerceTypes: true });
    deepStrictEqual(normalize({}), { cfg: { port: 8080 } });
  });

  it('materializes nested defaults inside a materialized default', () => {
    const normalize = compileNormalizer({
      type: 'object',
      properties: {
        cfg: { type: 'object', default: {}, properties: { port: { type: 'integer', default: 80 } } },
      },
    }, { useDefaults: true });
    deepStrictEqual(normalize({}), { cfg: { port: 80 } });
  });
});
