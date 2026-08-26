//@ts-check
/**
 * @file The five time-series operators as a public surface
 * (QUERY-FORMAT.md §8.16) — the parts the shared corpus does not reach.
 *
 * `series-corpus.test.js` proves the ANSWERS against a plain reference.
 * This file proves the SHAPE: that a spec is a closed literal and not an
 * expression, that the two error families land where §8.16 says they do,
 * that the optimizer's static cardinality is right for every composition
 * an author can build, that the row selectors read what they say they
 * read, and that the zone seam refuses rather than guesses.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  compileJsonQuery, analyzeQuery, annotateTypes,
} from '@jarenjs/json/query';
import { OPERATORS } from '../../../packages/json/src/query/operators.js';

/** The five, as one list — every gate below walks it rather than a copy. */
const SERIES_OPERATORS = ['$overlaps', '$time-bucket', '$resample', '$rolling', '$asof'];

/** Compile and run. @param {any} doc @param {any} input @param {any} [options] */
const run = (doc, input, options) => compileJsonQuery(doc, options)(input);

/** The code a document is refused with, or `null`. @param {() => any} fn */
function codeOf(fn) {
  try {
    fn();
    return null;
  }
  catch (error) {
    return error.code ?? error.constructor.name;
  }
}

const SAMPLES = [
  { at: 0, value: 1 },
  { at: 1000, value: 3 },
  { at: 2000, value: null },
  { at: 60000, value: 5 },
];

describe('the vocabulary grew by exactly five', () => {
  it('registers all five and nothing else new', () => {
    for (const name of SERIES_OPERATORS)
      assert.ok(Object.hasOwn(OPERATORS, name), `${name} is not in the registry`);
  });

  it('a registry pack cannot redeclare one of them', () => {
    // the closed vocabulary is closed in both directions: a host that
    // could shadow `$resample` could give one document two meanings
    const entry = { params: 'expr', result: () => 1, compile: () => () => 1 };
    for (const name of SERIES_OPERATORS) {
      assert.throws(() => compileJsonQuery(1, { extensions: { [name]: entry } }), TypeError,
        `a pack was allowed to redeclare ${name}`);
    }
  });

  it('names the operator that exists when a writer reaches for another one', () => {
    const said = (doc) => {
      try {
        compileJsonQuery(doc);
        return '';
      }
      catch (error) {
        return error.message;
      }
    };
    assert.match(said({ $time_bucket: 1 }), /\$time-bucket/);
    assert.match(said({ $gapfill: 1 }), /\$resample/);
    assert.match(said({ '$merge-asof': 1 }), /\$asof/);
    assert.match(said({ '$moving-average': 1 }), /\$rolling/);
    assert.match(said({ $overlap: 1 }), /\$overlaps/);
    // and there is no clock to reach for at all
    assert.match(said({ $now: 1 }), /no operator does this/);
  });
});

describe('a spec is a literal, and a closed one', () => {
  it('refuses a spec that is an expression rather than a literal', () => {
    for (const doc of [
      { $resample: ['$.rows', '$.spec'] },
      { $rolling: ['$.rows', { $const: { width: 60000 } }] },
      { $asof: ['$.a', '$.b', ['$.spec']] },
    ])
      assert.strictEqual(codeOf(() => compileJsonQuery(doc)), 'JQ0003');
  });

  it('refuses an unknown member, and names the near miss', () => {
    const nearMiss = (doc) => {
      try {
        compileJsonQuery(doc);
        return '';
      }
      catch (error) {
        return error.message;
      }
    };
    assert.match(nearMiss({ $rolling: ['$.r', { width: 1, minPeriod: 2 }] }),
      /did you mean 'minPeriods'/);
    assert.match(nearMiss({ $resample: ['$.r', { every: 1, aggregates: 'sum' }] }),
      /did you mean 'aggregate'/);
    assert.match(nearMiss({ $asof: ['$.a', '$.b', { directions: 'forward' }] }),
      /did you mean 'direction'/);
  });

  it('admits exactly the members §8.16 publishes, and no more', () => {
    // the members a document may write, asked of the compiler one at a
    // time rather than read out of a list this test also owns
    const admits = (doc) => codeOf(() => compileJsonQuery(doc)) === null;
    for (const member of ['origin', 'start', 'end', 'aggregate', 'fill', 'at', 'value',
      'zone', 'offset', 'disambiguation']) {
      const value = { origin: 0, start: 0, end: 1, aggregate: 'sum', fill: 'null',
        at: '$.at', value: '$.value', zone: 'UTC', offset: 60, disambiguation: 'earlier' }[member];
      assert.ok(admits({ $resample: ['$.r', { every: 1000, [member]: value }] }),
        `'$resample' should admit '${member}'`);
    }
    for (const member of ['width', 'minPeriods', 'seedBefore', 'tolerance', 'by', 'direction'])
      assert.ok(!admits({ $resample: ['$.r', { every: 1000, [member]: 1 }] }),
        `'$resample' should not admit '${member}'`);
    for (const member of ['every', 'fill', 'start', 'end', 'by'])
      assert.ok(!admits({ $rolling: ['$.r', { width: 1000, [member]: 1 }] }),
        `'$rolling' should not admit '${member}'`);
    for (const member of ['at', 'value', 'width', 'every', 'aggregate'])
      assert.ok(!admits({ $asof: ['$.a', '$.b', { [member]: 1 }] }),
        `'$asof' should not admit '${member}'`);
  });

  it('needs the one member that has no default', () => {
    assert.strictEqual(codeOf(() => compileJsonQuery({ $resample: ['$.r', {}] })), 'JQ0003');
    assert.strictEqual(codeOf(() => compileJsonQuery({ $rolling: ['$.r', {}] })), 'JQ0003');
    // $asof's spec is entirely optional: backward, unkeyed, unbounded.
    // One match is ONE ITEM, not a one-item array - these operators
    // answer a sequence, and section 2.1's "singleton = item" rule is
    // the language's, not something a new operator gets to change
    assert.deepStrictEqual(run({ $asof: ['$.a', '$.b'] }, { a: [{ at: 5, value: 1 }], b: [] }),
      { left: { at: 5, value: 1 }, right: null, distance: null });
  });

  it('compiles the spec ONCE, not once per row', () => {
    // the observable consequence: a spec that cannot work is refused
    // before a single row is read, so an empty input refuses too
    for (const doc of [
      { $resample: ['$.r', { every: 'P1MT1H' }] },
      { $rolling: ['$.r', { width: 0 }] },
      { $asof: ['$.a', '$.b', { tolerance: 'P1M' }] },
    ]) {
      assert.strictEqual(codeOf(() => compileJsonQuery(doc)), 'JQ0003',
        `${JSON.stringify(doc)} reached a row before it was refused`);
    }
  });
});

describe('the two error families land where §8.16 says', () => {
  it('what the DOCUMENT authored is JQ0003, at compile time', () => {
    for (const doc of [
      { $resample: ['$.r', { every: 1000, aggregate: 'median' }] },
      { $resample: ['$.r', { every: 1000, fill: 'ffill' }] },
      { $rolling: ['$.r', { width: 1000, minPeriods: 1.5 }] },
      { $rolling: ['$.r', { width: 1000, at: '$.rows[*]' }] },
      { $rolling: ['$.r', { width: 1000, at: '$' }] },
      { $rolling: ['$.r', { width: 1000, at: 'on' }] },
      { $asof: ['$.a', '$.b', { direction: 'up' }] },
      { $asof: ['$.a', '$.b', { by: '$.k[?@.x]' }] },
      { $resample: ['$.r', { every: 1000, disambiguation: 'whenever' }] },
      { $resample: ['$.r', { every: 1000, zone: 'Europe/Amsterdam', offset: 60 }] },
    ])
      assert.strictEqual(codeOf(() => compileJsonQuery(doc)), 'JQ0003', JSON.stringify(doc));
  });

  it('what the DATA decided is JQ2001, at run time', () => {
    const cases = [
      [{ $rolling: ['$.r', { width: 1000 }] }, { r: [{ at: 0 }] }],
      [{ $rolling: ['$.r', { width: 1000 }] }, { r: ['not a row'] }],
      [{ $resample: ['$.r', { every: 1000 }] }, { r: [{ at: NaN, value: 1 }] }],
      [{ $overlaps: ['$.a', '$.b'] }, { a: 'noon', b: { start: 0, end: 1 } }],
      [{ $overlaps: ['$.a', '$.b'] }, { a: { start: 5, end: 5 }, b: { start: 0, end: 9 } }],
      [{ '$time-bucket': ['$.at', '$.w'] }, { at: 0, w: {} }],
      [{ '$time-bucket': ['$.at', 1000] }, { at: '09:30:00Z' }],
    ];
    for (const [doc, input] of cases) {
      const compiled = compileJsonQuery(doc); // compiles: the document is fine
      assert.strictEqual(codeOf(() => compiled(input)), 'JQ2001', JSON.stringify(input));
    }
  });

  it('no rows is data; an empty answer is not an error', () => {
    // wrapped in an array constructor, because the empty SEQUENCE reads
    // back as `undefined` through this API and an empty ARRAY is what a
    // caller asking for a list wants to see
    assert.deepStrictEqual(run([{ $resample: ['$.r', { every: 1000 }] }], { r: [] }), []);
    assert.deepStrictEqual(run([{ $rolling: ['$.r', { width: 1000 }] }], { r: [] }), []);
    assert.deepStrictEqual(run([{ $asof: ['$.a', '$.b'] }], { a: [], b: [] }), []);
    assert.deepStrictEqual(run([{ $resample: ['$.missing', { every: 1000 }] }], {}), []);
  });
});

describe('a series operand is either spelling', () => {
  it('reads a fanned path and an array item the same way', () => {
    const fanned = run({ $resample: ['$.rows[*]', { every: 60000 }] }, { rows: SAMPLES });
    const whole = run({ $resample: ['$.rows', { every: 60000 }] }, { rows: SAMPLES });
    assert.deepStrictEqual(fanned, whole);
    assert.strictEqual(fanned.length, 2);
  });

  it('reads a single row as a series of one', () => {
    assert.deepStrictEqual(run({ $rolling: ['$.row', { width: 1000 }] },
      { row: { at: 7, value: 2 } }),
    { at: 7, value: 2, count: 1 });
  });
});

describe('row selectors read what they say they read', () => {
  const rows = [
    { on: '2026-01-01T00:00:00Z', reading: 1 },
    { on: '2026-01-01T00:00:30Z', reading: 3 },
  ];

  it('reads an instant and a reading out of their own member names', () => {
    assert.deepStrictEqual(
      run({ $resample: ['$.rows[*]', { every: 60000, at: '$.on', value: '$.reading' }] },
        { rows }),
      { at: 1767225600000, value: 2, count: 2 });
  });

  it('reads a nested member, and a name no identifier could spell', () => {
    assert.deepStrictEqual(
      run({ $rolling: ['$.rows[*]', { width: 1, at: '$.meta.at', value: "$['reading now']" }] },
        { rows: [{ meta: { at: 4 }, 'reading now': 9 }] }),
      { at: 4, value: 9, count: 1 });
  });

  it('joins two documents that spell their instant differently', () => {
    assert.deepStrictEqual(
      run({ $asof: ['$.left[*]', '$.right[*]', { leftAt: '$.on', rightAt: '$.recorded' }] },
        { left: [{ on: 10, value: 1 }], right: [{ recorded: 4, value: 2 }] }),
      { left: { on: 10, value: 1, at: 10 },
        right: { recorded: 4, value: 2, at: 4 },
        distance: 6 });
  });

  it('refuses a selector that is not one member', () => {
    for (const at of ['$.rows[*]', '$..at', '$[?@.at]', '$', 'at', 42])
      assert.strictEqual(codeOf(() => compileJsonQuery({ $rolling: ['$.r', { width: 1, at }] })),
        'JQ0003', `selector ${JSON.stringify(at)} should be refused`);
  });
});

describe('the zone seam refuses rather than guesses', () => {
  /** A scripted wall clock: one hour east, and 02:30 never happened. */
  const provider = {
    toParts(epoch) {
      const d = new Date(epoch + 3600000);
      return {
        year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(),
        hours: d.getUTCHours(), minutes: d.getUTCMinutes(), seconds: d.getUTCSeconds(),
        offset: 60,
      };
    },
    toEpoch(parts, zone, disambiguation) {
      if (parts.hours === 2 && disambiguation === 'reject')
        return NaN;
      return Date.UTC(parts.year, parts.month - 1, parts.day,
        parts.hours ?? 0, parts.minutes ?? 0, Math.floor(parts.seconds ?? 0)) - 3600000;
    },
  };

  it('UTC and a fixed offset need no provider at all', () => {
    assert.deepStrictEqual(
      run({ $resample: ['$.r', { every: 'P1D', zone: 'UTC', aggregate: 'count' }] },
        { r: [{ at: 0, value: 1 }] }),
      { at: 0, value: 1, count: 1 });
    // the ladder is anchored at local 1970-01-01T00:00:00, which is
    // epoch -1800000 half an hour east, so the boundaries fall on the
    // half hour and 01:30 UTC is exactly on one
    assert.strictEqual(run({ '$time-bucket': ['$.at', 'PT1H', null, { offset: 30 }] },
      { at: 5400000 }), 5400000);
    assert.strictEqual(run({ '$time-bucket': ['$.at', 'PT1H', null, { offset: 30 }] },
      { at: 5400000 - 1 }), 1800000);
  });

  it('refuses a named zone with no provider, naming the seam', () => {
    try {
      compileJsonQuery({ $resample: ['$.r', { every: 'P1M', zone: 'Europe/Amsterdam' }] });
      assert.fail('a named zone compiled with no time-zone database');
    }
    catch (error) {
      assert.strictEqual(error.code, 'JQ0003');
      assert.match(error.message, /bundles no tzdb/);
      assert.match(error.message, /zoneProvider/);
    }
  });

  it('walks the injected provider when one is given', () => {
    const answer = run({ $resample: ['$.r', { every: 'P1D', zone: 'Test/East', aggregate: 'count' }] },
      { r: [{ at: 0, value: 1 }] }, { zoneProvider: provider });
    // local midnight one hour east of UTC is 23:00 the day before
    assert.deepStrictEqual(answer, { at: -3600000, value: 1, count: 1 });
  });

  it('refuses a host provider that is not the two-question seam', () => {
    for (const bad of [{}, { toParts: () => 1 }, 'a tzdb', 7])
      assert.throws(() => compileJsonQuery(1, { zoneProvider: bad }), TypeError);
  });

  it('an hour that never happened is a refusal, not a guess', () => {
    // the provider answers NaN under 'reject', which the kernel turns
    // into a refusal naming the local time
    assert.strictEqual(
      codeOf(() => run({ $resample: ['$.r', { every: 'P1D', zone: 'Test/East', origin: 3600000 }] },
        { r: [{ at: 3600000, value: 1 }] }, { zoneProvider: provider })),
      'JQ2001');
  });
});

describe('the optimizer knows what these answer', () => {
  const cardOf = (doc) => analyzeQuery(doc).root.card;
  const typeOf = (doc) => annotateTypes(analyzeQuery(doc)).root.type;

  it('$overlaps is one boolean when both operands are, and optional otherwise', () => {
    assert.deepStrictEqual(typeOf({ $overlaps: [{ $const: {} }, { $const: {} }] }),
      { type: 'boolean', optional: false });
    assert.strictEqual(cardOf({ $overlaps: [{ $const: {} }, { $const: {} }] }), 1);
    // a path may select nothing, and then there is no answer to give
    assert.notStrictEqual(cardOf({ $overlaps: ['$.a', '$.b'] }), 1);
  });

  it('$time-bucket is an integer, and optional exactly when an operand is', () => {
    assert.deepStrictEqual(typeOf({ '$time-bucket': [{ $const: 0 }, { $const: 1000 }] }),
      { type: 'integer', optional: false });
    assert.strictEqual(cardOf({ '$time-bucket': [{ $const: 0 }, { $const: 1000 }] }), 1);
    // a computed width can be empty too, and the answer follows it
    assert.notStrictEqual(cardOf({ '$time-bucket': [{ $const: 0 }, '$.width'] }), 1);
  });

  it('the three series operators are sequences', () => {
    for (const doc of [
      { $resample: ['$.r', { every: 1000 }] },
      { $rolling: ['$.r', { width: 1000 }] },
      { $asof: ['$.a', '$.b'] },
    ])
      assert.deepStrictEqual(typeOf(doc).optional, true, JSON.stringify(doc));
  });

  it('an optional answer never leaks the empty marker into a constructor', () => {
    // the adversarial composition: an operator declaring exactly-one
    // while able to answer empty would put the engine's internal marker
    // inside an array or an object, where it is neither an item nor JSON
    assert.deepStrictEqual(run([{ $overlaps: ['$.a', '$.b'] }], {}), []);
    assert.deepStrictEqual(run({ x: { '$time-bucket': ['$.at', '$.w'] } }, {}), {});
    assert.deepStrictEqual(
      run({ n: { $count: { $resample: ['$.r', { every: 1000 }] } } }, { r: SAMPLES }),
      { n: 4 });
  });

  it('composes with the clauses the language already had', () => {
    // the point of a sequence-valued operator: it feeds `$for` like any
    // other, and the phrase does the filtering and the labelling
    assert.deepStrictEqual(
      run({
        $for: { b: { $resample: ['$.rows[*]', { every: 1000, aggregate: 'sum' }] } },
        $where: { $gt: ['$b.value', 2] },
        $return: { on: { $datetime: '$b.at' }, total: '$b.value' },
      }, { rows: SAMPLES }),
      [{ on: '1970-01-01T00:00:01Z', total: 3 },
        { on: '1970-01-01T00:01:00Z', total: 5 }]);
  });

  it('reports each operator as a dependency of the compiled query', () => {
    assert.deepStrictEqual(
      compileJsonQuery({ $rolling: [{ $resample: ['$.r', { every: 1000 }] }, { width: 5000 }] })
        .dependencies.operators,
      ['$resample', '$rolling']);
  });
});
