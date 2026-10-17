//@ts-check
/**
 * @file `diffContracts` against its oracle, acceptance: a change is
 * breaking for an input when a request the old contract accepted is
 * refused by the new one (for an output, when an answer the new contract
 * may send is refused by the old reader), additive when the new one
 * accepts more. Each case pins the classified changes exactly and runs
 * both schemas through `@jarenjs/validate` over constructed witnesses: a
 * breaking class must come with a witness the validator confirms, a diff
 * with neither a breaking nor an unknown change must have none, and an
 * additive class must come with a witness the new schema gained.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { JarenValidator } from '@jarenjs/validate';
import { diffContracts } from '@jarenjs/contract/diff';

/** @param {any} op @param {any} $defs */
const one = (op, $defs) => ({ $contract: '0.1', operations: { 'a.b': op }, $defs });
/**
 * @param {'input' | 'output'} where
 * @param {any} schema
 * @param {any} [$defs] - the document's definitions
 */
const take = (where, schema, $defs = {}) => (where === 'input'
  ? one({ kind: 'command', input: schema, output: true, http: { method: 'POST', path: '/a' } }, $defs)
  : one({ kind: 'read', output: schema, http: { method: 'GET', path: '/a' } }, $defs));
const root = { input: '/operations/a.b/input', output: '/operations/a.b/output' };

/** Each change as [class, rule, kind, pointer below the schema root]. @param {any} d @param {'input' | 'output'} where */
const flat = (d, where) => ['breaking', 'additive', 'neutral', 'unknown'].flatMap((name) =>
  d[name].map((/** @type {any} */ c) => [name, c.rule, c.kind, c.docPath.slice(root[where].length)]));

/**
 * Pin the classified changes, then check them against the validator.
 * @param {'input' | 'output'} where
 * @param {any} a @param {any} b
 * @param {unknown[]} witnesses
 * @param {[string, string, string, string][]} expected
 */
function agrees(where, a, b, witnesses, expected) {
  const d = diffContracts(take(where, a), take(where, b));
  assert.deepStrictEqual(flat(d, where), expected);
  const va = new JarenValidator().compile(a);
  const vb = new JarenValidator().compile(b);
  // what the consumer that kept the old contract can no longer take
  const lost = witnesses.filter((x) => (where === 'input' ? va(x) && !vb(x) : vb(x) && !va(x)));
  const gained = witnesses.filter((x) => (where === 'input' ? vb(x) && !va(x) : va(x) && !vb(x)));
  if (d.breaking.length > 0) assert.ok(lost.length > 0, `breaking without a witness: ${JSON.stringify(d.breaking)}`);
  if (d.breaking.length === 0 && d.unknown.length === 0) assert.deepStrictEqual(lost, [], 'a witness the diff did not class breaking');
  if (d.additive.length > 0) assert.ok(gained.length > 0, `additive without a witness: ${JSON.stringify(d.additive)}`);
}

const string = { type: 'string' };
/** @param {any} schema */
const member = (schema) => ({ type: 'object', properties: { x: schema } });

describe('diffContracts — a member the other side judges by a pattern, an applicator or a requirement alone', () => {
  const pat = { type: 'object', properties: { m: string }, patternProperties: { '^m': {} }, additionalProperties: false };
  const patNo = { type: 'object', patternProperties: { '^m': {} }, additionalProperties: false };
  const witnesses = [{}, { m: 1 }, { m: 'x' }, { mm: true }, { n: 1 }];

  it('a closed object whose patternProperties admits the name: dropping the member widens (was breaking R5 / R6), adding it narrows (was additive R7)', () => {
    agrees('input', pat, patNo, witnesses, [['additive', 'R7', 'input-widened', '/properties/m/type']]);
    agrees('input', patNo, pat, witnesses, [['breaking', 'R6', 'input-narrowed', '/properties/m/type']]);
    agrees('input', member(pat), member(patNo), witnesses.map((x) => ({ x })), [['additive', 'R7', 'input-widened', '/properties/x/properties/m/type']]);
    agrees('input', member(patNo), member(pat), witnesses.map((x) => ({ x })), [['breaking', 'R6', 'input-narrowed', '/properties/x/properties/m/type']]);
    agrees('output', pat, patNo, witnesses, [['breaking', 'R8', 'output-widened', '/properties/m/type']]);
    agrees('output', patNo, pat, witnesses, [['additive', 'R9', 'output-narrowed', '/properties/m/type']]);
  });

  it('patterns both sides apply beside the member mask what they constrain; two patterns on one side only, or patterns that differ, stay R15', () => {
    const capped = { '^m': { maxLength: 3 } };
    agrees('input', { ...pat, patternProperties: capped }, { ...patNo, patternProperties: capped },
      [...witnesses, { m: 'ab' }, { m: 'abcd' }], [['additive', 'R7', 'input-widened', '/properties/m/type']]);
    const two = { '^m': {}, 'm$': {} };
    agrees('input', { ...pat, patternProperties: two }, { ...patNo, patternProperties: two }, witnesses,
      [['additive', 'R7', 'input-widened', '/properties/m/type']]);
    // a member added beside the pattern that already caps it: its own cap moves nothing the pattern lets through
    agrees('input', { ...patNo, patternProperties: capped }, { ...pat, properties: { m: { maxLength: 5 } }, patternProperties: capped },
      [...witnesses, { m: 'abcd' }], [['unknown', 'R15', 'schema-unknown', '/properties/m/maxLength']]);
    // (the patterns that changed report beside it)
    const changed = [['unknown', 'R15', 'schema-unknown', '/properties/m'], ['unknown', 'R15', 'schema-unknown', '/patternProperties']];
    agrees('input', { ...pat, patternProperties: {} }, { ...patNo, patternProperties: two }, witnesses, changed);
    agrees('input', { ...pat, patternProperties: { '^m': { maxLength: 9 } } }, patNo, witnesses, changed);
  });

  it("the input's top level reads an applicator as a nested object does: a member dropped beside one is R15 (was breaking R5)", () => {
    const named = { type: 'object', allOf: [{ properties: { m: string } }], properties: { m: string }, unevaluatedProperties: false };
    const dropped = { type: 'object', allOf: [{ properties: { m: string } }], unevaluatedProperties: false };
    agrees('input', named, dropped, witnesses, [['unknown', 'R15', 'schema-unknown', '/properties/m']]);
    agrees('input', member(named), member(dropped), witnesses.map((x) => ({ x })), [['unknown', 'R15', 'schema-unknown', '/properties/x/properties/m']]);
  });

  it('an applicator none of whose branches may hold the member leaves the member rows: a requirement added or a member dropped beside it stays breaking', () => {
    const unrelated = { anyOf: [{ required: ['x'] }, { required: ['y'] }] };
    const base = { type: 'object', properties: { x: string }, ...unrelated };
    const requiring = { ...base, properties: { x: string, m: string }, required: ['m'] };
    const probes = [{ x: 'a' }, { x: 'a', m: 'b' }, { y: 1 }, {}];
    agrees('input', base, requiring, probes, [['breaking', 'R4', 'input-required-added', '/properties/m']]);
    agrees('input', member(base), member(requiring), probes.map((x) => ({ x })), [['breaking', 'R6', 'input-narrowed', '/properties/x/properties/m']]);
    const closed = { ...base, properties: { x: string, m: string }, additionalProperties: false };
    agrees('input', closed, { ...base, additionalProperties: false }, probes, [['breaking', 'R5', 'input-member-removed', '/properties/m']]);
  });

  it('a member named only in required on one side and in properties on the other compares its schema (was additive R7 alone)', () => {
    const required = { type: 'object', required: ['m'] };
    const declared = { type: 'object', properties: { m: string } };
    agrees('input', required, declared, witnesses,
      [['breaking', 'R6', 'input-narrowed', '/properties/m/type'], ['additive', 'R7', 'input-member-optional', '/properties/m']]);
    agrees('input', required, { type: 'object', properties: { m: false } }, witnesses,
      [['breaking', 'R6', 'input-narrowed', '/properties/m'], ['additive', 'R7', 'input-member-optional', '/properties/m']]);
    agrees('input', declared, required, witnesses,
      [['breaking', 'R4', 'input-required-added', '/properties/m'], ['additive', 'R7', 'input-widened', '/properties/m/type']]);
    agrees('input', member(required), member(declared), witnesses.map((x) => ({ x })),
      [['breaking', 'R6', 'input-narrowed', '/properties/x/properties/m/type'], ['additive', 'R7', 'input-widened', '/properties/x/properties/m']]);
    // an output member no longer guaranteed breaks the client that reads it (was additive R9 alone)
    agrees('output', required, declared, witnesses,
      [['breaking', 'R8', 'output-member-optional', '/properties/m'], ['additive', 'R9', 'output-narrowed', '/properties/m/type']]);
  });
});

describe('diffContracts — a member schema that accepts nothing forbids the member, as false does', () => {
  const samples = [null, true, 0, 1, 1.5, -2, '', 'a', 'abc', [], [1], {}, { k: 1 }];
  /** Shapes the walk proves accept nothing. @type {[string, any][]} */
  const nothing = [
    ['not of everything', { not: {} }],
    ['not of true', { not: true }],
    ['an empty enum', { enum: [] }],
    ['a const outside the type', { type: 'string', const: 1 }],
    ['a const outside the enum', { const: 1, enum: [2] }],
    ['an enum outside the type', { type: 'integer', enum: ['1', 1.5] }],
    ['conjuncts whose types do not meet', { allOf: [{ type: 'string' }, { type: 'number' }] }],
    ['a type and a conjunct that do not meet', { type: 'boolean', allOf: [{ type: ['string', 'null'] }] }],
    ['a conjunct that accepts nothing', { allOf: [{}, { not: {} }] }],
    ['every variant accepts nothing', { anyOf: [{ not: {} }, false] }],
    ['numbers out of order', { type: 'integer', minimum: 3, maximum: 2 }],
    ['lengths out of order', { type: 'string', minLength: 3, maxLength: 2 }],
    ['a required member that accepts nothing', { type: 'object', required: ['k'], properties: { k: { enum: [] } } }],
    ['through a $ref hop', { $ref: '#/$defs/none' }],
  ];
  /** Shapes that look alike but accept something: classed as any constrained member. @type {[string, any][]} */
  const something = [
    ['bounds out of order without a type', { minimum: 3, maximum: 2 }],
    ['bounds out of order beside another type', { type: ['string', 'integer'], minimum: 3, maximum: 2 }],
    ['lengths out of order beside another type', { type: ['string', 'integer'], minLength: 3, maxLength: 2 }],
    ['one variant accepts', { anyOf: [{ not: {} }, string] }],
    ['an integer const under number', { type: 'number', const: 1 }],
    ['an optional member that accepts nothing', { type: 'object', properties: { k: { enum: [] } } }],
  ];
  const $defs = { none: { not: {} } };
  const open = { type: 'object' };
  /** @param {any} m */
  const adding = (m) => ({ type: 'object', properties: { m } });

  it('the validator refuses every sample for the shapes read as accepting nothing, and accepts one for the look-alikes', () => {
    for (const [name, schema] of nothing) {
      const v = new JarenValidator().compile({ $defs, ...schema });
      assert.deepStrictEqual(samples.filter((x) => v(x)), [], name);
    }
    for (const [name, schema] of something) {
      const v = new JarenValidator().compile(schema);
      assert.ok(samples.some((x) => v(x)), name);
    }
  });

  it('added to an open input it refuses every request carrying the member: breaking R6 (was additive R7)', () => {
    for (const [name, m] of nothing) {
      const d = diffContracts(take('input', open, $defs), take('input', adding(m), $defs));
      assert.deepStrictEqual(flat(d, 'input'), [['breaking', 'R6', 'input-narrowed', '/properties/m']], name);
    }
    agrees('input', open, adding({ not: {} }), [{}, { m: 1 }, { m: 'a' }], [['breaking', 'R6', 'input-narrowed', '/properties/m']]);
    for (const [name, m] of something) {
      const d = diffContracts(take('input', open), take('input', adding(m)));
      assert.deepStrictEqual(flat(d, 'input'), [['additive', 'R7', 'input-member-added', '/properties/m']], name);
    }
  });

  it('added to or dropped from a closed object it moves nothing; two schemas that accept nothing are alike', () => {
    const closed = { type: 'object', properties: { x: string }, additionalProperties: false };
    const forbidding = { ...closed, properties: { x: string, m: { not: {} } } };
    agrees('input', closed, forbidding, [{}, { x: 'a' }, { m: 1 }], []);
    agrees('input', forbidding, closed, [{}, { x: 'a' }, { m: 1 }], []);
    agrees('input', member({ type: 'string', const: 1 }), member({ type: 'string', const: 2 }), [{}, { x: 1 }, { x: 2 }, { x: '1' }], []);
    agrees('output', member({ enum: [] }), member({ not: {} }), [{}, { x: 1 }], []);
  });

  it('a schema that accepted nothing and now accepts something widens by its own values (was R15 and a guessed narrowing)', () => {
    agrees('input', member({ not: {} }), member(string), [{}, { x: 'a' }, { x: 1 }], [['additive', 'R7', 'input-widened', '/properties/x']]);
    agrees('input', member(string), member({ not: {} }), [{}, { x: 'a' }, { x: 1 }], [['breaking', 'R6', 'input-narrowed', '/properties/x']]);
    agrees('output', member(string), member({ type: 'string', enum: [1] }), [{}, { x: 'a' }], [['additive', 'R9', 'output-narrowed', '/properties/x']]);
  });
});

describe('diffContracts — not, contains and a union keyed by type and discriminator together read by direction', () => {
  const keyed = { type: 'object', required: ['k'] };
  const inner = { not: { ...keyed, properties: { k: string } } };
  const outer = { not: { type: 'object', properties: { k: string } } };
  const wit = [null, 'a', {}, { k: 'a' }, { k: 1 }];

  it('a not reads its branch anti-monotone: a branch that widens narrows the node (was R15)', () => {
    agrees('input', member(inner), member(outer), wit.map((x) => ({ x })), [['breaking', 'R6', 'input-narrowed', '/properties/x/not/properties/k']]);
    agrees('input', member(outer), member(inner), wit.map((x) => ({ x })), [['additive', 'R7', 'input-widened', '/properties/x/not/properties/k']]);
    agrees('output', outer, inner, wit, [['breaking', 'R8', 'output-widened', '/not/properties/k']]);
    agrees('output', inner, outer, wit, [['additive', 'R9', 'output-narrowed', '/not/properties/k']]);
    agrees('input', member({ not: { maxLength: 5 } }), member({ not: { maxLength: 3 } }), ['ab', 'abcd', 'abcdef', 1].map((x) => ({ x })),
      [['additive', 'R7', 'input-widened', '/properties/x/not/maxLength']]);
  });

  it('a contains reads its branch monotone: a branch that narrows narrows the node (was R15)', () => {
    const wider = { type: 'array', contains: { ...keyed } };
    const narrower = { type: 'array', contains: { type: 'object', required: ['k', 'j'] } };
    const arrays = [[], [{}], [{ k: 1 }], [{ k: 1, j: 2 }], [1]].map((x) => ({ x }));
    agrees('input', member(wider), member(narrower), arrays, [['breaking', 'R6', 'input-narrowed', '/properties/x/contains/required']]);
    agrees('input', member(narrower), member(wider), arrays, [['additive', 'R7', 'input-widened', '/properties/x/contains/required']]);
    agrees('output', member(narrower), member(wider), arrays, [['breaking', 'R8', 'output-member-optional', '/properties/x/contains/required']]);
  });

  it('a union of object variants told apart by a discriminator and variants told apart by type pairs them (was R15)', () => {
    /** @param {string} k @param {string[]} required */
    const variant = (k, required) => ({ type: 'object', required: ['k', ...required], properties: { k: { const: k }, p: string } });
    const strict = { anyOf: [variant('a', ['p']), variant('b', []), { type: 'null' }] };
    const loose = { anyOf: [variant('a', []), variant('b', []), { type: 'null' }] };
    const values = [null, 'a', {}, { k: 'a' }, { k: 'a', p: 'x' }, { k: 'b' }, { k: 'c' }];
    agrees('output', strict, loose, values, [['breaking', 'R8', 'output-member-optional', '/anyOf/0/properties/p']]);
    agrees('input', member(loose), member(strict), values.map((x) => ({ x })), [['breaking', 'R6', 'input-narrowed', '/properties/x/anyOf/0/properties/p']]);
    // reordered: nothing; a variant added under a value no other shares: widened by its own values
    agrees('output', strict, { anyOf: [{ type: 'null' }, variant('b', []), variant('a', ['p'])] }, values, []);
    agrees('output', strict, { anyOf: [...strict.anyOf, variant('c', [])] }, values, [['breaking', 'R8', 'output-widened', '/anyOf/3']]);
  });

  it('stays R15 where neither direction is decided: a not or contains on one side only, contains beside a count, overlapping keys', () => {
    agrees('input', member(string), member({ type: 'string', not: { maxLength: 2 } }), [], [['unknown', 'R15', 'schema-unknown', '/properties/x/not']]);
    agrees('input', member({ type: 'array', contains: { maxLength: 5 }, maxContains: 2 }), member({ type: 'array', contains: { maxLength: 3 }, maxContains: 2 }), [],
      [['unknown', 'R15', 'schema-unknown', '/properties/x/contains']]);
    const variant = (/** @type {any} */ k) => ({ type: 'object', required: ['k'], properties: { k } });
    agrees('input', member({ anyOf: [variant({ const: 'a' }), variant({ const: 'b' }), { type: 'null' }] }),
      member({ anyOf: [variant({ enum: ['a', 'b'] }), variant({ const: 'b' }), { type: 'null' }] }), [],
      [['unknown', 'R15', 'schema-unknown', '/properties/x/anyOf']]);
    // two type sets in a mixed union that overlap (`number` holds every `integer`): the pairing compares the
    // type sets and finds them meeting, so neither direction is decided
    agrees('input', member({ anyOf: [variant({ const: 'a' }), { type: 'number' }, { type: 'null' }] }),
      member({ anyOf: [variant({ const: 'a' }), { type: 'integer' }, { type: 'null' }] }), [],
      [['unknown', 'R15', 'schema-unknown', '/properties/x/anyOf']]);
  });
});
