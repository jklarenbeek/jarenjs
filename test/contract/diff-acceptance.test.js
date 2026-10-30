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
  const samples = [null, true, 0, 1, 1.5, 2, 3, 3.25, -2, '', 'a', 'abc', 'xa', 'a\n', [], [1], {}, { k: 1 }, { k: 'x' }];
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
  ];
  /**
   * Shapes that accept nothing in a way the procedure does not read (a
   * lookaround, a word boundary): still classed as any constrained member.
   * @type {[string, any][]}
   */
  const unread = [
    ['a pattern whose lookahead contradicts it', { type: 'string', pattern: '(?=a)b' }],
    ['a pattern of a word boundary and its negation', { type: 'string', pattern: '\\b\\B' }],
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

describe('diffContracts — under a draft before 2019-09 the counts and unevaluatedProperties are no keywords', () => {
  const draft7 = 'http://json-schema.org/draft-07/schema#';

  it('a contains beside minContains 0 is read as a contains that needs one match may be: R15, not "no change"', () => {
    const arrays = (/** @type {string[]} */ required) => ({ $schema: draft7, type: 'object', properties: { x: { type: 'array', contains: { required }, minContains: 0 } } });
    agrees('input', arrays(['a']), arrays(['a', 'b']), [{ x: [{ a: 1 }] }, { x: [] }], [['unknown', 'R15', 'schema-unknown', '/properties/x/contains']]);
  });

  it('an object closed by unevaluatedProperties requiring a member is no empty schema there: added to an open input it is the additive R7 row', () => {
    const closed = { type: 'object', required: ['k'], unevaluatedProperties: false };
    const adding = { $schema: draft7, type: 'object', properties: { m: closed } };
    assert.strictEqual(new JarenValidator().compile(adding)({ m: { k: 1 } }), true);
    const d = diffContracts(take('input', { $schema: draft7, type: 'object' }), take('input', adding));
    assert.deepStrictEqual(flat(d, 'input'), [['additive', 'R7', 'input-member-added', '/properties/m']]);
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
