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
import { compileContract } from '@jarenjs/contract';
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
  const samples = [null, true, 0, 0.10000001, 0.3, 1, 1.0000005, 1.5, 2, 3, 3.25, -2, '', 'a', 'abc', 'xa', 'a\n', [], [1], {}, { k: 1 }, { k: 'x' }];
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
    ['exclusive bounds that cross', { type: 'number', exclusiveMinimum: 3, exclusiveMaximum: 3 }],
    ['a minimum at an exclusive maximum', { type: 'number', minimum: 3, exclusiveMaximum: 3 }],
    ['an exclusive minimum at a maximum', { type: 'integer', exclusiveMinimum: 3, maximum: 3 }],
    ['an integer range holding no integer', { type: 'integer', minimum: 1.2, maximum: 1.8 }],
    ['an exclusive integer range holding no integer', { type: 'integer', exclusiveMinimum: 1, exclusiveMaximum: 2 }],
    ['a closed object requiring a member it does not admit', { type: 'object', required: ['k'], additionalProperties: false }],
    ['an object closed by unevaluatedProperties requiring a member', { type: 'object', required: ['k'], unevaluatedProperties: false }],
    ['a required member a matching pattern refuses', { type: 'object', required: ['k'], patternProperties: { '^k': false } }],
    ['a closed object whose pattern misses the required name', { type: 'object', required: ['k'], patternProperties: { '^a': {} }, additionalProperties: false }],
    ['a pattern of an empty class', { type: 'string', pattern: '[]' }],
    ['a pattern with a caret after a character', { type: 'string', pattern: 'a^' }],
    ['a pattern with a dollar before a character', { type: 'string', pattern: '$a' }],
    ['a pattern of a negative lookahead of nothing', { type: 'string', pattern: '(?!)' }],
    ['a pattern of a class that admits nothing', { type: 'string', pattern: '[^\\s\\S]' }],
    ['a pattern repeating a match anchored at the start', { type: 'string', pattern: '(^a){2}' }],
    ['a pattern every alternative of which is empty', { type: 'string', pattern: 'x[]+|y$z' }],
    ['a draft-04 boolean exclusive maximum at the minimum', { type: 'number', minimum: 3, maximum: 3, exclusiveMaximum: true }],
    ['items out of order', { type: 'array', minItems: 3, maxItems: 2 }],
    ['member counts out of order', { type: 'object', minProperties: 2, maxProperties: 1 }],
    ['fewer members allowed than it requires', { type: 'object', required: ['a', 'b', 'a'], maxProperties: 1 }],
    ['a range holding no multiple', { type: 'number', minimum: 1.1, maximum: 1.9, multipleOf: 1 }],
    ['an open decimal range holding no multiple', { type: 'number', exclusiveMinimum: 0.31, exclusiveMaximum: 0.39, multipleOf: 0.1 }],
    ['an integer range holding no multiple', { type: 'integer', minimum: 1, maximum: 4, multipleOf: 5 }],
    // the validator decides a multiple exactly: an open end at one excludes it, and a value near one is none
    ['an open range between consecutive multiples', { type: 'number', exclusiveMinimum: 0.1, exclusiveMaximum: 0.2, multipleOf: 0.1 }],
    ['a range starting just past a multiple, ending before the next', { type: 'number', minimum: 1.0000001, maximum: 1.5, multipleOf: 1 }],
    ['a propertyNames refusing the required name', { type: 'object', required: ['k'], propertyNames: { maxLength: 0 } }],
    ['a propertyNames pattern refusing the required name', { type: 'object', required: ['k'], propertyNames: { not: { pattern: '^k' } } }],
  ];
  /** Shapes that look alike but accept something: classed as any constrained member. @type {[string, any][]} */
  const something = [
    ['bounds out of order without a type', { minimum: 3, maximum: 2 }],
    ['bounds out of order beside another type', { type: ['string', 'integer'], minimum: 3, maximum: 2 }],
    ['lengths out of order beside another type', { type: ['string', 'integer'], minLength: 3, maxLength: 2 }],
    ['one variant accepts', { anyOf: [{ not: {} }, string] }],
    ['an integer const under number', { type: 'number', const: 1 }],
    ['an optional member that accepts nothing', { type: 'object', properties: { k: { enum: [] } } }],
    ['exclusive bounds apart', { type: 'number', exclusiveMinimum: 3, exclusiveMaximum: 3.5 }],
    ['crossing exclusive bounds without a type', { exclusiveMinimum: 3, exclusiveMaximum: 3 }],
    ['an integer range holding one integer', { type: 'integer', minimum: 1, maximum: 1 }],
    ['an integer range between fractions holding an integer', { type: 'integer', minimum: 1.5, maximum: 2.5 }],
    ['a closed object naming its required member', { type: 'object', required: ['k'], properties: { k: {} }, additionalProperties: false }],
    ['a closed object whose pattern admits the required name', { type: 'object', required: ['k'], patternProperties: { '^k': {} }, additionalProperties: false }],
    ['unevaluatedProperties beside a conjunct naming the member', { type: 'object', required: ['k'], unevaluatedProperties: false, allOf: [{ properties: { k: true } }] }],
    ['a pattern of an optional empty class', { type: 'string', pattern: '[]?' }],
    ['a pattern of an empty class repeated any number of times', { type: 'string', pattern: '[]*' }],
    ['a pattern of a dollar then a caret', { type: 'string', pattern: '$^' }],
    ['a pattern one alternative of which matches', { type: 'string', pattern: 'a|[]' }],
    ['items in order', { type: 'array', minItems: 1, maxItems: 1 }],
    ['items out of order without a type', { minItems: 3, maxItems: 2 }],
    ['the required members within the member count', { type: 'object', required: ['k', 'k'], maxProperties: 1 }],
    ['a range holding a multiple', { type: 'number', minimum: 1.1, maximum: 2.1, multipleOf: 1 }],
    ['a range holding a decimal multiple', { type: 'number', minimum: 0.25, maximum: 0.35, multipleOf: 0.1 }],
    ['a range about zero holding its multiple', { type: 'number', minimum: -0.5, maximum: 0.5, multipleOf: 1 }],
    ['an open end at a multiple, the next one inside', { type: 'number', exclusiveMinimum: 0.2, maximum: 0.3, multipleOf: 0.1 }],
    ['an open end just below a multiple', { type: 'number', exclusiveMinimum: 0.25, maximum: 0.35, multipleOf: 0.1 }],
    ['a range starting just before a multiple', { type: 'number', minimum: 0.9999999, maximum: 1.5, multipleOf: 1 }],
    ['a propertyNames admitting the required name', { type: 'object', required: ['k'], propertyNames: { maxLength: 1 } }],
  ];
  /**
   * Shapes that accept nothing in a way the procedure does not read (a
   * lookaround, a word boundary): still classed as any constrained member.
   * @type {[string, any][]}
   */
  const unread = [
    ['a pattern whose lookahead contradicts it', { type: 'string', pattern: '(?=a)b' }],
    ['a pattern of a word boundary and its negation', { type: 'string', pattern: '\\b\\B' }],
    ['an integer range holding a multiple only between its integers', { type: 'integer', minimum: 6, maximum: 9, multipleOf: 2.5 }],
    ['a propertyNames spelled with a keyword not read on a literal', { type: 'object', required: ['k'], propertyNames: { if: { minLength: 1 }, then: false } }],
  ];
  const $defs = { none: { not: {} } };
  const open = { type: 'object' };
  /** @param {any} m */
  const adding = (m) => ({ type: 'object', properties: { m } });

  it('the validator refuses every sample for the shapes read as accepting nothing, and accepts one for the look-alikes', () => {
    for (const [name, schema] of [...nothing, ...unread]) {
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
    for (const [name, m] of [...something, ...unread]) {
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

  it('stays R15 where neither direction is decided: a not that may have moved out of a conjunct, contains under both counts, overlapping keys', () => {
    // the conjunct dropped the not the node now carries: the two accept the same values
    agrees('input', member({ allOf: [{ not: { const: 1 } }] }), member({ not: { const: 1 }, allOf: [{}] }), [{ x: 1 }, { x: 2 }],
      [['unknown', 'R15', 'schema-unknown', '/properties/x/allOf/0/not'], ['unknown', 'R15', 'schema-unknown', '/properties/x/not']]);
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

describe('diffContracts — a conditional, a not or a contains read by direction where only one side changes it', () => {
  const kind = (/** @type {any} */ k) => ({ properties: { kind: k }, required: ['kind'] });
  const card = { type: 'object', if: kind({ const: 'card' }), then: { required: ['number'] } };
  const cardOrDebit = { ...card, if: kind({ enum: ['card', 'debit'] }) };
  const objects = [{}, { kind: 'card' }, { kind: 'debit' }, { kind: 'debit', number: 1 }, { kind: 'card', number: 1 }, { kind: 'cash' }];

  it('an if beside only a then reads anti-monotone: a member value the if gains is one the then now judges (was R15)', () => {
    agrees('input', member(card), member(cardOrDebit), objects.map((x) => ({ x })), [['breaking', 'R6', 'input-narrowed', '/properties/x/if/properties/kind/enum']]);
    agrees('input', member(cardOrDebit), member(card), objects.map((x) => ({ x })), [['additive', 'R7', 'input-widened', '/properties/x/if/properties/kind/const']]);
    agrees('output', cardOrDebit, card, objects, [['breaking', 'R8', 'output-widened', '/if/properties/kind/const']]);
    // a required member dropped from the if: more objects must pass the then
    agrees('input', member({ if: { required: ['a', 'c'] }, then: { required: ['b'] } }), member({ if: { required: ['a'] }, then: { required: ['b'] } }),
      [{ a: 1 }, { a: 1, c: 1 }, { b: 1 }].map((x) => ({ x })), [['breaking', 'R6', 'input-narrowed', '/properties/x/if/required']]);
  });

  it("the input's own if reads as a member's does: a requirement the then adds for more requests is breaking R6 (was R15)", () => {
    agrees('input', card, cardOrDebit, objects, [['breaking', 'R6', 'input-narrowed', '/if/properties/kind/enum']]);
    agrees('input', { type: 'object', not: { required: ['a'] } }, { type: 'object' }, [{}, { a: 1 }], [['additive', 'R7', 'input-widened', '/not']]);
    agrees('input', { type: 'object' }, { type: 'object', not: { required: ['a'] } }, [{}, { a: 1 }], [['breaking', 'R6', 'input-narrowed', '/not']]);
  });

  it('an if beside only an else reads monotone: a requirement the if adds sends more requests to the else (was R15)', () => {
    const lax = { if: { required: ['a'] }, else: { required: ['b'] } };
    const strict = { if: { required: ['a', 'c'] }, else: { required: ['b'] } };
    const probes = [{ a: 1 }, { a: 1, c: 1 }, { b: 1 }, {}];
    agrees('input', member(lax), member(strict), probes.map((x) => ({ x })), [['breaking', 'R6', 'input-narrowed', '/properties/x/if/required']]);
    agrees('input', member(strict), member(lax), probes.map((x) => ({ x })), [['additive', 'R7', 'input-widened', '/properties/x/if/required']]);
    agrees('output', strict, lax, probes, [['breaking', 'R8', 'output-member-optional', '/if/required']]);
  });

  it('an if judges nothing beside no branch, nor a then or an else beside no if: a change there is no change (was R15)', () => {
    const probes = [{}, { a: 1 }, { b: 1 }];
    agrees('input', member({ type: 'object', if: { required: ['a'] } }), member({ type: 'object', if: { required: ['b'] } }), probes.map((x) => ({ x })), []);
    agrees('input', member({ type: 'object' }), member({ type: 'object', if: { required: ['b'] } }), probes.map((x) => ({ x })), []);
    agrees('input', member({ then: { required: ['a'] } }), member({ then: { required: ['b'] } }), probes.map((x) => ({ x })), []);
    agrees('output', { else: false }, { else: true }, probes, []);
    // beside unevaluatedProperties an if's annotations decide members: still R15
    agrees('input', member({ type: 'object', if: { properties: { a: true } }, unevaluatedProperties: false }),
      member({ type: 'object', if: { properties: { b: true } }, unevaluatedProperties: false }), [], [['unknown', 'R15', 'schema-unknown', '/properties/x/if']]);
  });

  it('a then or an else that appears beside the same if narrows by what it refuses, keyword by keyword (was R15)', () => {
    const probes = [{}, { a: 1 }, { a: 1, b: 1 }, { b: 1 }];
    agrees('input', member({ if: { required: ['a'] } }), member({ if: { required: ['a'] }, then: { required: ['b'] } }), probes.map((x) => ({ x })),
      [['breaking', 'R6', 'input-narrowed', '/properties/x/then/required']]);
    agrees('input', member({ if: { required: ['a'] }, else: { required: ['b'] } }), member({ if: { required: ['a'] } }), probes.map((x) => ({ x })),
      [['additive', 'R7', 'input-widened', '/properties/x/else/required']]);
  });

  it('a change that moves only values of types the branch never sees is no change: an if beside a then of another type, a then behind an if of another type', () => {
    const strings = [{}, { a: 1 }, { a: 1, c: 1 }, 'abcd', 'ab'];
    agrees('input', member({ if: { required: ['a'] }, then: { maxLength: 3 } }), member({ if: { required: ['a', 'c'] }, then: { maxLength: 3 } }), strings.map((x) => ({ x })), []);
    // (was breaking R6: the then judged a string the if never lets through)
    agrees('input', member({ if: { type: 'object' }, then: { maxLength: 5 } }), member({ if: { type: 'object' }, then: { maxLength: 3 } }), strings.map((x) => ({ x })), []);
    // a then that judges the type the if gained reads it
    agrees('input', member({ if: { type: 'string' }, then: { maxLength: 3 } }), member({ if: { type: ['string', 'object'] }, then: { maxLength: 3 } }),
      strings.map((x) => ({ x })), []);
    // an if that trades strings for numbers: the strings it drops are freed, the numbers it gains pass the then
    agrees('input', member({ if: { type: 'string' }, then: { maxLength: 3 } }), member({ if: { type: 'number' }, then: { maxLength: 3 } }),
      ['abcd', 'ab', 1].map((x) => ({ x })), [['additive', 'R7', 'input-widened', '/properties/x/if/type']]);
    agrees('input', member({ if: { type: 'object' }, then: { required: ['a'] } }), member({ if: { type: ['object', 'string'] }, then: { maxLength: 3 } }),
      [], [['unknown', 'R15', 'schema-unknown', '/properties/x/if'], ['unknown', 'R15', 'schema-unknown', '/properties/x/then']]);
  });

  it('stays R15 beside both a then and an else, and where the if and its branch change together', () => {
    agrees('input', member({ if: { required: ['a'] }, then: { required: ['b'] }, else: { required: ['c'] } }),
      member({ if: { required: ['a', 'd'] }, then: { required: ['b'] }, else: { required: ['c'] } }), [], [['unknown', 'R15', 'schema-unknown', '/properties/x/if']]);
    agrees('input', member({ if: { type: 'string' }, then: { maxLength: 5 } }), member({ if: { type: 'number' }, then: { maxLength: 3 } }), [],
      [['unknown', 'R15', 'schema-unknown', '/properties/x/if'], ['unknown', 'R15', 'schema-unknown', '/properties/x/then']]);
    // the then bounds the same keyword the if moves: it may let every moved value through
    agrees('input', member({ if: { maxLength: 2 }, then: { maxLength: 3 } }), member({ if: { maxLength: 4 }, then: { maxLength: 3 } }), [],
      [['unknown', 'R15', 'schema-unknown', '/properties/x/if/maxLength']]);
  });

  it('a not added narrows and one dropped widens by its own values, unless it refuses nothing the node lets through (was R15)', () => {
    const texts = ['', 'a', 1].map((x) => ({ x }));
    agrees('input', member(string), member({ type: 'string', not: { const: '' } }), texts, [['breaking', 'R6', 'input-narrowed', '/properties/x/not']]);
    agrees('input', member({ type: 'string', not: { const: '' } }), member(string), texts, [['additive', 'R7', 'input-widened', '/properties/x/not']]);
    agrees('output', { type: 'string', not: { const: '' } }, string, ['', 'a'], [['breaking', 'R8', 'output-widened', '/not']]);
    agrees('input', member({ type: 'object' }), member({ type: 'object', not: { type: 'string' } }), [{}, 'a'].map((x) => ({ x })), []);
    agrees('input', member(string), member({ type: 'string', not: { not: {} } }), texts, []);
  });

  it('a contains added narrows and one dropped widens, unless a count or the node type lets every array through (was R15)', () => {
    const arrays = [[], [{}], [{ id: 1 }], 'a'].map((x) => ({ x }));
    const list = { type: 'array' };
    agrees('input', member(list), member({ ...list, contains: { required: ['id'] } }), arrays, [['breaking', 'R6', 'input-narrowed', '/properties/x/contains']]);
    agrees('input', member({ ...list, contains: { required: ['id'] } }), member(list), arrays, [['additive', 'R7', 'input-widened', '/properties/x/contains']]);
    agrees('output', list, { ...list, contains: { required: ['id'] } }, [[], [{ id: 1 }]], [['additive', 'R9', 'output-narrowed', '/contains']]);
    agrees('input', member({ ...list, minContains: 0 }), member({ ...list, minContains: 0, contains: { required: ['id'] } }), arrays, []);
    agrees('input', member(string), member({ ...string, contains: { required: ['id'] } }), arrays, []);
  });

  it('a contains reads by its counts: monotone under minContains alone, anti-monotone under maxContains with minContains 0 (was R15)', () => {
    const arrays = [[], [{ a: 1 }], [{ a: 1 }, { a: 1 }], [{ a: 1, b: 1 }, { a: 1, b: 1 }], [{}, {}]].map((x) => ({ x }));
    const counted = (/** @type {string[]} */ required, /** @type {any} */ counts) => member({ type: 'array', contains: { required }, ...counts });
    agrees('input', counted(['a'], { minContains: 2 }), counted(['a', 'b'], { minContains: 2 }), arrays,
      [['breaking', 'R6', 'input-narrowed', '/properties/x/contains/required']]);
    agrees('input', counted(['a', 'b'], { minContains: 0, maxContains: 1 }), counted(['a'], { minContains: 0, maxContains: 1 }), arrays,
      [['breaking', 'R6', 'input-narrowed', '/properties/x/contains/required']]);
    agrees('input', counted(['a'], { minContains: 0, maxContains: 1 }), counted(['a', 'b'], { minContains: 0, maxContains: 1 }), arrays,
      [['additive', 'R7', 'input-widened', '/properties/x/contains/required']]);
    agrees('input', counted(['a'], { minContains: 0 }), counted(['a', 'b'], { minContains: 0 }), arrays, []);
    // a count that moved beside it: what matches and how many must are read together, R15
    agrees('input', counted(['a'], { minContains: 2 }), member({ type: 'array', contains: {}, minContains: 3 }), arrays,
      [['unknown', 'R15', 'schema-unknown', '/properties/x/contains'], ['unknown', 'R15', 'schema-unknown', '/properties/x/minContains']]);
  });
});

describe('diffContracts — each schema place read under the draft its $schema names', () => {
  const draft7 = 'http://json-schema.org/draft-07/schema#';
  const draft2019 = 'https://json-schema.org/draft/2019-09/schema';
  const draft2020 = 'https://json-schema.org/draft/2020-12/schema';
  /** @param {string} type */
  const tuple = (type) => ({ type: 'array', prefixItems: [{ type }] });
  const tuples = [['a'], [1], [], 'a'].map((x) => ({ x }));

  /**
   * {@link agrees}, the witnesses read by the two contracts' own
   * validators, which compile each schema inside its document.
   * @param {'input' | 'output'} where
   * @param {any} a @param {any} b
   * @param {any} defsA @param {any} defsB
   * @param {unknown[]} witnesses
   * @param {[string, string, string, string][]} expected
   */
  function agreesInDocument(where, a, b, defsA, defsB, witnesses, expected) {
    const before = compileContract(take(where, a, defsA));
    const after = compileContract(take(where, b, defsB));
    const d = diffContracts(before, after);
    assert.deepStrictEqual(flat(d, where), expected);
    const accepts = (/** @type {any} */ contract, /** @type {unknown} */ x) => contract.operations['a.b'][where].validate(x).valid;
    const lost = witnesses.filter((x) => (where === 'input' ? accepts(before, x) && !accepts(after, x) : accepts(after, x) && !accepts(before, x)));
    if (d.breaking.length > 0) assert.ok(lost.length > 0, `breaking without a witness: ${JSON.stringify(d.breaking)}`);
    if (d.breaking.length === 0 && d.unknown.length === 0) assert.deepStrictEqual(lost, [], 'a witness the diff did not class breaking');
  }

  it('the validator reads prefixItems from 2020-12 and the other keywords the walk gates from 2019-09, and contains, if and both exclusive bound spellings under every draft', () => {
    /** Each keyword, a schema of it and a value it refuses where it is read. @type {[string, any, unknown][]} */
    const keywords = [
      ['prefixItems', { prefixItems: [{ type: 'string' }] }, [1]],
      ['dependentSchemas', { dependentSchemas: { a: { required: ['b'] } } }, { a: 1 }],
      ['dependentRequired', { dependentRequired: { a: ['b'] } }, { a: 1 }],
      ['minContains', { contains: { const: 1 }, minContains: 2 }, [1]],
      ['maxContains', { contains: { const: 1 }, maxContains: 1 }, [1, 1]],
      ['unevaluatedProperties', { unevaluatedProperties: false }, { a: 1 }],
      ['unevaluatedItems', { unevaluatedItems: false }, [1]],
      ['contains', { contains: { const: 1 } }, [2]],
      ['if', { if: { const: 1 }, then: false }, 1],
      ['exclusiveMaximum', { exclusiveMaximum: 3 }, 3],
      ['a boolean exclusiveMaximum', { maximum: 3, exclusiveMaximum: true }, 3],
    ];
    const names = keywords.map(([name]) => name);
    const reads = (/** @type {string | undefined} */ $schema) => keywords
      .filter(([, schema, refused]) => !new JarenValidator().compile($schema === undefined ? schema : { $schema, ...schema })(refused))
      .map(([name]) => name);
    assert.deepStrictEqual(reads(undefined), names);
    assert.deepStrictEqual(reads(draft2020), names);
    assert.deepStrictEqual(reads(draft2019), names.filter((name) => name !== 'prefixItems'));
    for (const $schema of ['http://json-schema.org/draft-04/schema#', 'http://json-schema.org/draft-06/schema#', draft7, 'https://example.com/a-dialect']) {
      assert.deepStrictEqual(reads($schema), ['contains', 'if', 'exclusiveMaximum', 'a boolean exclusiveMaximum'], $schema);
    }
  });

  it('a prefixItems entry or a dependentSchemas member that changed where the draft does not read it changes nothing (was breaking R6 beside additive R7)', () => {
    /** @param {string} $schema @param {string} type */
    const spelled = ($schema, type) => ({ $schema, ...member(tuple(type)) });
    agrees('input', spelled(draft7, 'string'), spelled(draft7, 'number'), tuples, []);
    agrees('input', spelled(draft2019, 'string'), spelled(draft2019, 'number'), tuples, []);
    // a dialect the validator does not know reads as draft-07
    agrees('input', spelled('https://example.com/a-dialect', 'string'), spelled('https://example.com/a-dialect', 'number'), tuples, []);
    agrees('input', spelled(draft2020, 'string'), spelled(draft2020, 'number'), tuples,
      [['breaking', 'R6', 'input-narrowed', '/properties/x/prefixItems/0/type'], ['additive', 'R7', 'input-widened', '/properties/x/prefixItems/0/type']]);
    /** @param {string} $schema @param {string} required */
    const dependent = ($schema, required) => ({ $schema, type: 'object', dependentSchemas: { a: { required: [required] } } });
    const objects = [{ a: 1, b: 1 }, { a: 1, c: 1 }, { a: 1 }, {}];
    agrees('input', dependent(draft7, 'b'), dependent(draft7, 'c'), objects, []);
    agrees('input', dependent(draft2019, 'b'), dependent(draft2019, 'c'), objects,
      [['breaking', 'R6', 'input-narrowed', '/dependentSchemas/a/required'], ['additive', 'R7', 'input-widened', '/dependentSchemas/a/required']]);
  });

  it('unevaluatedProperties: false where the draft does not read it closes nothing: an output member added is additive R9 (was breaking R8)', () => {
    /** @param {Record<string, any>} properties */
    const output = (properties) => ({ $schema: draft7, type: 'object', properties, unevaluatedProperties: false });
    agrees('output', output({ a: string }), output({ a: string, b: string }), [{ a: 'x', b: 'y' }, { a: 'x', b: 1 }],
      [['additive', 'R9', 'output-member-added', '/properties/b']]);
    // a nullable union respelled as a type array reads its branch where the branch sits
    /** @param {any} v */
    const holder = (v) => ({ $schema: draft7, type: 'object', properties: { v } });
    const union = holder({ anyOf: [{ type: 'object', properties: { a: string }, unevaluatedProperties: false }, { type: 'null' }] });
    const array = holder({ type: ['object', 'null'], properties: { a: string, b: string }, unevaluatedProperties: false });
    agrees('output', union, array, [{ v: null }, { v: { a: 'x', b: 'y' } }, { v: { a: 'x', b: 1 } }],
      [['additive', 'R9', 'output-member-added', '/properties/v/properties/b'], ['neutral', 'R16', 'schema-respelled', '/properties/v']]);
  });

  it('a member that declares draft-07 is read under it: a constrained member added beside its unevaluatedProperties narrows the member (was additive R7)', () => {
    /** @param {Record<string, any>} properties */
    const x = (properties) => member({ $schema: draft7, type: 'object', properties, unevaluatedProperties: false });
    agrees('input', x({ n: {} }), x({ n: {}, m: string }), [{ x: { m: 1 } }, { x: { m: 'a' } }, { x: { n: 1 } }],
      [['breaking', 'R6', 'input-narrowed', '/properties/x/properties/m']]);
  });

  it('under draft-07 minContains is no keyword: a contains beside minContains 0 still needs one match, so a contains that narrows narrows the node (was R15)', () => {
    const arrays = (/** @type {string[]} */ required) => ({ $schema: draft7, type: 'object', properties: { x: { type: 'array', contains: { required }, minContains: 0 } } });
    agrees('input', arrays(['a']), arrays(['a', 'b']), [{ x: [{ a: 1 }] }, { x: [] }], [['breaking', 'R6', 'input-narrowed', '/properties/x/contains/required']]);
  });

  it('an object closed by unevaluatedProperties requiring a member is no empty schema there: added to an open input it is the additive R7 row', () => {
    const closed = { type: 'object', required: ['k'], unevaluatedProperties: false };
    const adding = { $schema: draft7, type: 'object', properties: { m: closed } };
    assert.strictEqual(new JarenValidator().compile(adding)({ m: { k: 1 } }), true);
    const d = diffContracts(take('input', { $schema: draft7, type: 'object' }), take('input', adding));
    assert.deepStrictEqual(flat(d, 'input'), [['additive', 'R7', 'input-member-added', '/properties/m']]);
  });

  it('a definition that declares its own draft is read under it behind a $ref; a $schema moved to a draft that reads the keyword is reported where the keyword sits (was nothing)', () => {
    /** @param {string} $schema @param {string} type */
    const defs = ($schema, type) => ({ T: { $schema, ...tuple(type) } });
    const ref = { $ref: '#/$defs/T' };
    agreesInDocument('input', member(ref), member(ref), defs(draft7, 'string'), defs(draft7, 'number'), tuples, []);
    agreesInDocument('output', ref, ref, defs(draft7, 'string'), defs(draft7, 'number'), [['a'], [1]], []);
    agreesInDocument('input', member(ref), member(ref), defs(draft7, 'string'), defs(draft2020, 'string'), tuples,
      [['unknown', 'R15', 'schema-unknown', '/properties/x/prefixItems']]);
    agrees('input', { $schema: draft7, ...member(tuple('string')) }, { $schema: draft2020, ...member(tuple('string')) }, tuples,
      [['unknown', 'R15', 'schema-unknown', '/properties/x/prefixItems']]);
    // compared by its text, an if beside both branches validates apart where its keywords are read apart
    /** @param {string} $schema */
    const conditional = ($schema) => ({ $schema, ...member({ if: { dependentRequired: { a: ['b'] } }, then: { required: ['c'] }, else: { required: ['d'] } }) });
    agrees('input', conditional(draft7), conditional(draft2020), [{ x: { a: 1, c: 1 } }, { x: { a: 1, b: 1, c: 1 } }, { x: { d: 1 } }],
      [['unknown', 'R15', 'schema-unknown', '/properties/x/if/dependentRequired']]);
  });

  it('a definition below a resource declaring draft-07 is read under it from a $ref below the schema, under none at the end of a chain the schema starts: a change there is R15 (was breaking R6 beside additive R7)', () => {
    /** @param {string} type */
    const defs = (type) => ({ lib: { $schema: draft7, $defs: { T: tuple(type) } } });
    const ref = { $ref: '#/$defs/lib/$defs/T' };
    agreesInDocument('input', member(ref), member(ref), defs('string'), defs('number'), tuples,
      [['unknown', 'R15', 'schema-unknown', '/properties/x/prefixItems/0/type']]);
    agreesInDocument('output', ref, ref, defs('string'), defs('number'), [['a'], [1]],
      [['unknown', 'R15', 'schema-unknown', '/prefixItems/0/type']]);
    agreesInDocument('input', member(ref), member(ref), defs('string'), defs('string'), tuples, []);
    // alike as text beside a resource that now declares a draft reading the keyword, it may have moved
    agreesInDocument('input', member(ref), member(ref), defs('string'), { lib: { $schema: draft2020, $defs: { T: tuple('string') } } }, tuples,
      [['unknown', 'R15', 'schema-unknown', '/properties/x/prefixItems']]);
  });

  it('an input in another document that declares no $schema of its own may sit under any draft: a keyword the drafts read apart leaves it compared by its text (was breaking R5)', () => {
    // the compiled contract does not carry the draft-07 the document declares above the definition
    /** @param {Record<string, any>} properties */
    const compiled = (properties) => compileContract(take('input', { $ref: 'https://x.example/lib.json#/$defs/In' }), {
      schemas: [{ $id: 'https://x.example/lib.json', $schema: draft7, $defs: { In: { type: 'object', properties, unevaluatedProperties: false } } }],
    });
    const before = compiled({ m: string, n: string });
    assert.deepStrictEqual(flat(diffContracts(before, compiled({ m: string })), 'input'), [['unknown', 'R15', 'schema-unknown', '']]);
    assert.deepStrictEqual(flat(diffContracts(before, compiled({ m: string, n: string })), 'input'), []);
  });
});

describe('diffContracts — exclusive bounds, multipleOf and the item, member and contains counts read by direction', () => {
  const numbers = [-1, 0, 0.3, 0.5, 1, 1.5, 2, 2.5, 3, 4, 5, 5.5, 6, 7, 10].map((x) => ({ x }));
  /** @param {Record<string, any>} bounds */
  const number = (bounds) => member({ type: 'number', ...bounds });

  it('an exclusive bound reads as maximum and minimum do, each end one bound with the plain keyword beside it (was R15)', () => {
    agrees('input', number({ exclusiveMaximum: 10 }), number({ exclusiveMaximum: 5 }), numbers, [['breaking', 'R6', 'input-narrowed', '/properties/x/exclusiveMaximum']]);
    agrees('input', number({ exclusiveMinimum: 5 }), number({ exclusiveMinimum: 1 }), numbers, [['additive', 'R7', 'input-widened', '/properties/x/exclusiveMinimum']]);
    agrees('input', number({}), number({ exclusiveMinimum: 1 }), numbers, [['breaking', 'R6', 'input-narrowed', '/properties/x/exclusiveMinimum']]);
    // an exclusive bound at the maximum takes that one value out
    agrees('input', number({ maximum: 5 }), number({ maximum: 5, exclusiveMaximum: 5 }), numbers, [['breaking', 'R6', 'input-narrowed', '/properties/x/exclusiveMaximum']]);
    // a change the other keyword of its end masks moves nothing
    agrees('input', number({ maximum: 3, exclusiveMaximum: 10 }), number({ maximum: 3, exclusiveMaximum: 5 }), numbers, []);
    // respelled from one keyword to the other: read where b bounds the end
    agrees('input', number({ maximum: 5 }), number({ exclusiveMaximum: 6 }), numbers, [['additive', 'R7', 'input-widened', '/properties/x/exclusiveMaximum']]);
    agrees('output', { type: 'number', exclusiveMaximum: 5 }, { type: 'number', exclusiveMaximum: 10 }, numbers.map(({ x }) => x),
      [['breaking', 'R8', 'output-widened', '/exclusiveMaximum']]);
  });

  it('a draft-04 boolean exclusive bound makes the plain bound beside it open: set or cleared it moves that one value, beside no plain bound nothing (was R15)', () => {
    agrees('input', number({ maximum: 5 }), number({ maximum: 5, exclusiveMaximum: true }), numbers, [['breaking', 'R6', 'input-narrowed', '/properties/x/exclusiveMaximum']]);
    agrees('input', number({ minimum: 1, exclusiveMinimum: true }), number({ minimum: 1, exclusiveMinimum: false }), numbers,
      [['additive', 'R7', 'input-widened', '/properties/x/exclusiveMinimum']]);
    agrees('input', number({ maximum: 5, exclusiveMaximum: true }), number({ maximum: 6, exclusiveMaximum: true }), numbers,
      [['additive', 'R7', 'input-widened', '/properties/x/maximum']]);
    agrees('input', number({}), number({ exclusiveMaximum: true }), numbers, []);
  });

  it('where both sides admit only integers an end is the first or last integer it admits, and a bound beside a type that admits no value it judges moves nothing (was R6 or R15)', () => {
    /** @param {Record<string, any>} bounds */
    const integer = (bounds) => member({ type: 'integer', ...bounds });
    const integers = [3, 4, 5, 6].map((x) => ({ x }));
    agrees('input', integer({ exclusiveMaximum: 6 }), integer({ maximum: 5 }), integers, []);
    agrees('input', integer({ maximum: 5, exclusiveMaximum: true }), integer({ maximum: 4 }), integers, []);
    agrees('input', integer({ maximum: 4.5 }), integer({ maximum: 4 }), integers, []);
    agrees('input', integer({ maximum: 5 }), integer({ maximum: 4.5 }), integers, [['breaking', 'R6', 'input-narrowed', '/properties/x/maximum']]);
    const values = ['', 'ab', 1, [1, 2, 3]].map((x) => ({ x }));
    agrees('input', member({ type: 'integer' }), member({ type: 'integer', maxLength: 1 }), values, []);
    agrees('input', member({ type: 'string' }), member({ type: 'string', maxItems: 2 }), values, []);
    agrees('input', member({ type: 'string', pattern: '^a' }), member({ type: 'integer', pattern: '^b' }), values,
      [['breaking', 'R6', 'input-narrowed', '/properties/x/type'], ['additive', 'R7', 'input-widened', '/properties/x/type']]);
  });

  it('a bound a conjunct changes while another holds the other keyword of its end is R15, and so is one that may have moved into an applicator: what the node admits need not move', () => {
    agrees('input', member({ allOf: [{ exclusiveMaximum: 5 }, { maximum: 2 }] }), member({ allOf: [{ exclusiveMaximum: 4 }, { maximum: 2 }] }), numbers,
      [['unknown', 'R15', 'schema-unknown', '/properties/x/allOf/0/exclusiveMaximum']]);
    agrees('input', member({ allOf: [{ exclusiveMaximum: 5 }] }), member({ exclusiveMaximum: 5, allOf: [{}] }), numbers,
      [['unknown', 'R15', 'schema-unknown', '/properties/x/allOf'], ['unknown', 'R15', 'schema-unknown', '/properties/x/exclusiveMaximum']]);
  });

  it('multipleOf narrows to a whole multiple of its step and widens to a whole fraction of it, on the decimals it spells; a step neither divides stays R15 (was R15)', () => {
    agrees('input', number({ multipleOf: 1 }), number({ multipleOf: 2 }), numbers, [['breaking', 'R6', 'input-narrowed', '/properties/x/multipleOf']]);
    agrees('input', number({ multipleOf: 0.5 }), number({ multipleOf: 0.1 }), numbers, [['additive', 'R7', 'input-widened', '/properties/x/multipleOf']]);
    // 0.3 is three times 0.1 on the decimals, not on the binary fractions nearest them
    agrees('input', number({ multipleOf: 0.1 }), number({ multipleOf: 0.3 }), [0.1, 0.3, 0.6].map((x) => ({ x })),
      [['breaking', 'R6', 'input-narrowed', '/properties/x/multipleOf']]);
    agrees('input', number({ multipleOf: 0.01 }), number({ multipleOf: 0.1 }), [0.07, 0.3, 1].map((x) => ({ x })),
      [['breaking', 'R6', 'input-narrowed', '/properties/x/multipleOf']]);
    agrees('input', number({}), number({ multipleOf: 2 }), numbers, [['breaking', 'R6', 'input-narrowed', '/properties/x/multipleOf']]);
    agrees('input', number({ multipleOf: 2 }), number({}), numbers, [['additive', 'R7', 'input-widened', '/properties/x/multipleOf']]);
    agrees('input', number({ multipleOf: 2 }), number({ multipleOf: 3 }), numbers, [['unknown', 'R15', 'schema-unknown', '/properties/x/multipleOf']]);
  });

  it('the item and member counts read as the lengths do, and a bound that admits every value moves nothing (was R15; a minLength of 0 added was breaking R6)', () => {
    const arrays = [[], [1], [1, 2], [1, 2, 3]].map((x) => ({ x }));
    agrees('input', member({ type: 'array', maxItems: 3 }), member({ type: 'array', maxItems: 2 }), arrays, [['breaking', 'R6', 'input-narrowed', '/properties/x/maxItems']]);
    agrees('input', member({ type: 'array' }), member({ type: 'array', minItems: 1 }), arrays, [['breaking', 'R6', 'input-narrowed', '/properties/x/minItems']]);
    agrees('input', member({ type: 'array', minItems: 2 }), member({ type: 'array' }), arrays, [['additive', 'R7', 'input-widened', '/properties/x/minItems']]);
    agrees('input', member({ type: 'array' }), member({ type: 'array', minItems: 0 }), arrays, []);
    const objects = [{}, { a: 1 }, { a: 1, b: 1 }].map((x) => ({ x }));
    agrees('input', member({ type: 'object', maxProperties: 2 }), member({ type: 'object', maxProperties: 1 }), objects,
      [['breaking', 'R6', 'input-narrowed', '/properties/x/maxProperties']]);
    agrees('input', member({ type: 'object', minProperties: 1 }), member({ type: 'object', minProperties: 0 }), objects,
      [['additive', 'R7', 'input-widened', '/properties/x/minProperties']]);
    agrees('output', { type: 'array', maxItems: 1 }, { type: 'array', maxItems: 2 }, [[], [1], [1, 2]], [['breaking', 'R8', 'output-widened', '/maxItems']]);
    agrees('input', member(string), member({ type: 'string', minLength: 0 }), ['', 'a'].map((x) => ({ x })), []);
  });

  it('a contains count reads by direction beside a contains alike on both sides, one match by default; beside one that changed it stays R15, beside none it judges nothing (was R15)', () => {
    const arrays = [[], [1], [1, 1], [1, 1, 1], [2]].map((x) => ({ x }));
    /** @param {Record<string, any>} counts @param {any} [contains] */
    const counted = (counts, contains = { const: 1 }) => member({ type: 'array', contains, ...counts });
    agrees('input', counted({ minContains: 1 }), counted({ minContains: 2 }), arrays, [['breaking', 'R6', 'input-narrowed', '/properties/x/minContains']]);
    agrees('input', counted({}), counted({ maxContains: 2 }), arrays, [['breaking', 'R6', 'input-narrowed', '/properties/x/maxContains']]);
    agrees('input', counted({ maxContains: 1 }), counted({ maxContains: 3 }), arrays, [['additive', 'R7', 'input-widened', '/properties/x/maxContains']]);
    agrees('input', counted({}), counted({ minContains: 1 }), arrays, []);
    agrees('input', counted({}), counted({ minContains: 0 }), arrays, [['additive', 'R7', 'input-widened', '/properties/x/minContains']]);
    agrees('input', member({ type: 'array', minContains: 1 }), member({ type: 'array', minContains: 3 }), arrays, []);
    agrees('input', counted({ minContains: 1 }), counted({ minContains: 2 }, { const: 2 }), arrays,
      [['unknown', 'R15', 'schema-unknown', '/properties/x/contains'], ['unknown', 'R15', 'schema-unknown', '/properties/x/minContains']]);
  });
});

describe('diffContracts — const and enum read as one value set', () => {
  it('a value set respelled between const and enum moves only the values it adds or drops (was breaking R6 beside additive R7)', () => {
    const values = ['a', 'b', 'c'].map((x) => ({ x }));
    agrees('input', member({ enum: ['a'] }), member({ const: 'a' }), values, []);
    agrees('input', member({ enum: ['a', 'b'] }), member({ const: 'a' }), values, [['breaking', 'R6', 'input-narrowed', '/properties/x/const']]);
    agrees('input', member({ const: 'a' }), member({ enum: ['a', 'b'] }), values, [['additive', 'R7', 'input-widened', '/properties/x/enum']]);
    agrees('input', member({ const: 'a', enum: ['a', 'b'] }), member({ const: 'a' }), values, []);
    // inside a not, a respelling that moved nothing stays nothing (was breaking R6)
    agrees('input', member({ not: { enum: ['a'] } }), member({ not: { const: 'a' } }), values, []);
  });
});

describe('diffContracts — a pattern no string matches', () => {
  /** Strings of up to three characters over a, b and a line break, and a few more. */
  const strings = [''];
  for (let length = 1; length <= 3; length++) {
    for (const s of strings.filter((x) => x.length === length - 1)) strings.push(s + 'a', s + 'b', s + '\n');
  }
  strings.push('A', 'z', '\u{1F600}', 'a\u{1F600}', '\u0001');
  /**
   * Which of `patterns` the diff reads as accepting nothing: each is a
   * member added to an open input, which answers breaking R6 on the member
   * exactly then.
   * @param {string[]} patterns
   */
  const provenEmpty = (patterns) => {
    const properties = Object.fromEntries(patterns.map((pattern, i) => ['m' + i, { type: 'string', pattern }]));
    const d = diffContracts(take('input', { type: 'object' }), take('input', { type: 'object', properties }));
    return new Set(d.breaking.map((/** @type {any} */ c) => patterns[Number(c.docPath.slice(c.docPath.lastIndexOf('/m') + 2))]));
  };

  it('reads each construct as the validator compiles it', () => {
    /** Each pattern, and whether the diff proves it matches nothing. @type {[string, boolean][]} */
    const cases = [
      ['[]', true], ['[]?', false], ['[]*', false], ['[]+', true], ['[]{0}', false], ['[]{2,}', true], ['(?:[])', true], ['([])', true], ['(?<n>[])', true],
      ['a^', true], ['^a', false], ['$a', true], ['a$', false], ['$^', false], ['(^a){2}', true], ['(^a)?^', false], ['x[]+|y$z', true],
      ['(?!)', true], ['(?<!)', true], ['(?=a)b', false], ['(?<=a)', false], ['\\b\\B', false], ['(a)\\1[]', true], ['(?<n>a)\\k<n>^', true],
      ['[^\\s\\S]', true], ['[^\\d\\D]', true], ['[^\\w\\W]', true], ['[^]', false], ['[^\\s]', false], ['[\\]]$a', true],
      ['\\p{L}^', true], ['\\x41^', true], ['\\cA^', true], ['\\u0041^', true], ['\\u{1F600}^', true], ['\\uD83D\\uDE00{0}^', false],
      ['\\u{1F600}{0}^', false], ['\u{1F600}{0}^', false], ['(?i:a^)', false], ['[\\u{1F600}]$a', true], ['.^', true],
      ['(a?)\\1^', false], ['\\b^a', false], ['a??^', false], ['a{2}?^', true],
      ['/a^/m', true], ['(', false],
    ];
    const proven = provenEmpty(cases.map(([pattern]) => pattern).filter((pattern) => pattern !== '('));
    assert.deepStrictEqual(cases.filter(([pattern]) => pattern !== '(').map(([pattern]) => [pattern, proven.has(pattern)]), cases.filter(([pattern]) => pattern !== '('));
    // a source that does not compile in Unicode mode is never read
    assert.throws(() => new JarenValidator().compile({ type: 'string', pattern: '(' }));
  });

  it('never proves a pattern empty that a string matches: every pattern of up to three tokens', () => {
    const tokens = ['a', '^', '$', '[]', '(', ')', '|', '*', '?', '{2}', '(?!)', '.', '[^]'];
    /** @type {string[]} */
    const patterns = [];
    const grow = (/** @type {string} */ prefix, /** @type {number} */ depth) => {
      for (const token of tokens) {
        const pattern = prefix + token;
        try {
          void new RegExp(pattern, 'u');
          patterns.push(pattern);
        }
        catch {
          // the validator reads it as a literal, or refuses it
        }
        if (depth > 1) grow(pattern, depth - 1);
      }
    };
    grow('', 3);
    const proven = provenEmpty(patterns);
    const unsound = [...proven].filter((pattern) => strings.some((s) => new RegExp(pattern, 'u').test(s)));
    assert.deepStrictEqual(unsound, []);
    // 828 patterns compile in Unicode mode; 389 of them are read as matching nothing
    assert.deepStrictEqual([patterns.length, proven.size], [828, 389]);
  });
});
