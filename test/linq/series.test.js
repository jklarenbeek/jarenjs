//@ts-check
/**
 * @file The date and time-series families on the fluent surface
 * (LINQ-FORMAT.md §4, QUERY-FORMAT.md §§8.13 and 8.16).
 *
 * One rule is proven here, method by method: **every lowering is the
 * document a hand-writer would have written, and every answer is the
 * one that document gives.** So each case emits the chain, asserts the
 * emitted JSON, and then runs BOTH — the chain and the emitted document
 * straight through the query engine — and asserts they agree. A method
 * that lowered to something plausible but different would pass the
 * first half and fail the second, which is exactly the drift a fluent
 * surface over a document language is prone to.
 *
 * The membership gates at the bottom are the anti-drift half: the
 * methods the source spells, the row LINQ-FORMAT §4 publishes and the
 * operators QUERY-FORMAT publishes must name the same set, so a family
 * cannot gain a method in one place only.
 */

import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import * as assert from 'node:assert';

import { from } from '@jarenjs/linq';
import { compileJsonQuery } from '@jarenjs/json/query';
import { sectionOf } from '../format-sections.js';

// `ms` rather than `at`, deliberately: `at(index)` is path navigation on
// this surface, so a member literally named `at` is read with `get('at')`
// — the same collision `similarity` has, and worth a fixture that does
// not quietly work around it.
const EVENTS = [
  { id: 'a', on: '2026-01-31T09:30:00Z', ms: 1767225600000, value: 1 },
  { id: 'b', on: '2026-02-14T23:15:30.5+01:00', ms: 1767225660000, value: 3 },
  { id: 'c', on: '2026-12-28', ms: 1767225720000, value: null },
];

const SHIFTS = [
  { id: 'morning', span: { start: 0, end: 3600000 } },
  { id: 'evening', span: { start: 3600000, end: 7200000 } },
];

/**
 * Emit a projection, run the chain, and run the emitted document — then
 * assert all three agree. The returned document is what the case pins.
 * @param {any[]} rows
 * @param {any} project
 * @returns {any} the emitted query document
 */
function agrees(rows, project) {
  const query = from(rows).select(project);
  const doc = query.toDocument();
  const viaChain = query.toArray();
  // a projection answers one tuple per row, and the query API spells a
  // ONE-item sequence as the item itself (§2.1's "singleton = item").
  // The fluent surface always hands back an array, so the two agree
  // once that rule is applied rather than papered over with a fixture
  // that happens to have two rows in it
  const answer = compileJsonQuery(doc)(rows);
  const viaDocument = answer === undefined ? [] : rows.length === 1 ? [answer] : answer;
  assert.deepStrictEqual(viaChain, viaDocument,
    `the chain and its own document disagree: ${JSON.stringify(doc)}`);
  return doc;
}

/** Capture one projection's emitted `$return`. @param {any} fn */
const emitted = (fn) => from([]).select(fn).toDocument().$return;

describe('the date family lowers to §8.13, one method per operator', () => {
  it('emits the components, the instants and the predicates', () => {
    const cases = [
      [(e) => e.on.year(), { $year: '$it.on' }],
      [(e) => e.on.month(), { $month: '$it.on' }],
      [(e) => e.on.day(), { $day: '$it.on' }],
      [(e) => e.on.hours(), { $hours: '$it.on' }],
      [(e) => e.on.minutes(), { $minutes: '$it.on' }],
      [(e) => e.on.seconds(), { $seconds: '$it.on' }],
      [(e) => e.on.offset(), { $offset: '$it.on' }],
      [(e) => e.on.week(), { $week: '$it.on' }],
      [(e) => e.on.weekYear(), { '$week-year': '$it.on' }],
      [(e) => e.on.quarter(), { $quarter: '$it.on' }],
      [(e) => e.on.weekday(), { $weekday: '$it.on' }],
      [(e) => e.on.epoch(), { $epoch: '$it.on' }],
      [(e) => e.ms.datetime(), { $datetime: '$it.ms' }],
      [(e) => e.on.isDate(), { '$is-date': '$it.on' }],
      [(e) => e.on.isTime(), { '$is-time': '$it.on' }],
      [(e) => e.on.isDatetime(), { '$is-datetime': '$it.on' }],
      [(e) => e.on.isDuration(), { '$is-duration': '$it.on' }],
    ];
    for (const [project, expected] of cases)
      assert.deepStrictEqual(emitted(project), expected);
  });

  it('emits the calendar arithmetic in both of its arities', () => {
    assert.deepStrictEqual(emitted((e) => e.on.startOf('month')),
      { '$start-of': ['$it.on', 'month'] });
    assert.deepStrictEqual(emitted((e) => e.on.endOf('day')),
      { '$end-of': ['$it.on', 'day'] });
    assert.deepStrictEqual(emitted((e) => e.on.dateAdd('P1M')),
      { '$date-add': ['$it.on', 'P1M'] });
    assert.deepStrictEqual(emitted((e) => e.on.dateAdd(3, 'day')),
      { '$date-add': ['$it.on', 3, 'day'] });
    assert.deepStrictEqual(emitted((e) => e.on.dateSub('PT90M')),
      { '$date-sub': ['$it.on', 'PT90M'] });
    assert.deepStrictEqual(emitted((e) => e.on.dateSub(1, 'week')),
      { '$date-sub': ['$it.on', 1, 'week'] });
    assert.deepStrictEqual(emitted((e) => e.on.dateDiff('2026-06-01', 'month')),
      { '$date-diff': ['$it.on', '2026-06-01', 'month'] });
    assert.deepStrictEqual(emitted((e) => e.on.dateFormat('yyyy-MM-dd')),
      { '$date-format': ['$it.on', 'yyyy-MM-dd'] });
  });

  it('answers what its own document answers, for every method', () => {
    // the date-time rows only: a full-date has no clock and a full-time
    // has no calendar, and asking for the half a value has not got is
    // §8.13's documented refusal rather than something to assert here
    const rows = EVENTS.slice(0, 2);
    agrees(rows, (e) => ({
      y: e.on.year(), mo: e.on.month(), d: e.on.day(),
      h: e.on.hours(), mi: e.on.minutes(), s: e.on.seconds(), off: e.on.offset(),
      w: e.on.week(), wy: e.on.weekYear(), q: e.on.quarter(), wd: e.on.weekday(),
      ms: e.on.epoch(), back: e.ms.datetime(),
      isD: e.on.isDate(), isT: e.on.isTime(), isDt: e.on.isDatetime(),
      som: e.on.startOf('month'), eod: e.on.endOf('day'),
      plus: e.on.dateAdd('P1M'), minus: e.on.dateSub(3, 'day'),
      diff: e.on.dateDiff('2026-06-01', 'month'),
      shown: e.on.dateFormat('yyyy-MM-dd'),
      bucket: e.ms.timeBucket(3600000),
    }));
  });

  it('preserves the lexical form the operators promise', () => {
    // a full-date shifted by a day is still a full-date - the surface
    // adds nothing to that rule and must not quietly break it
    assert.deepStrictEqual(
      from([EVENTS[2]]).select((e) => e.on.dateAdd(1, 'day')).toArray(),
      ['2026-12-29']);
    assert.deepStrictEqual(
      from([EVENTS[0]]).select((e) => e.on.dateAdd(1, 'month')).toArray(),
      ['2026-02-28T09:30:00Z'], 'month arithmetic clamps');
  });

  it("refuses a half the value has not got, as JQ2001 rather than a guess", () => {
    assert.throws(() => from([EVENTS[2]]).select((e) => e.on.hours()).toArray(),
      (error) => error.code === 'JQ2001');
    assert.throws(() => from([EVENTS[2]]).select((e) => e.on.dateAdd(1, 'hour')).toArray(),
      (error) => error.code === 'JQ2001');
  });
});

describe('the series family lowers to §8.16', () => {
  it('emits the scalar pair', () => {
    assert.deepStrictEqual(emitted((e) => e.ms.timeBucket('PT1H')),
      { '$time-bucket': ['$it.ms', 'PT1H'] });
    assert.deepStrictEqual(emitted((e) => e.ms.timeBucket('PT1H', 0)),
      { '$time-bucket': ['$it.ms', 'PT1H', 0] });
    assert.deepStrictEqual(emitted((e) => e.ms.timeBucket('PT1H', undefined, { offset: 60 })),
      { '$time-bucket': ['$it.ms', 'PT1H', null, { offset: 60 }] });
    assert.deepStrictEqual(emitted((s) => s.span.overlaps({ start: 0, end: 10 })),
      { $overlaps: ['$it.span', { $const: { start: 0, end: 10 } }] });
  });

  it('emits the three sequence operators with their spec verbatim', () => {
    assert.deepStrictEqual(emitted((s) => s.rows.all().resample({ every: 'PT1H', fill: 'locf' })),
      { $resample: ['$it.rows[*]', { every: 'PT1H', fill: 'locf' }] });
    assert.deepStrictEqual(emitted((s) => s.rows.all().rolling({ width: 60000, minPeriods: 2 })),
      { $rolling: ['$it.rows[*]', { width: 60000, minPeriods: 2 }] });
    assert.deepStrictEqual(emitted((s) => s.left.all().asof(s.right.all(), { by: '$.k' })),
      { $asof: ['$it.left[*]', '$it.right[*]', { by: '$.k' }] });
    assert.deepStrictEqual(emitted((s) => s.left.all().asof(s.right.all())),
      { $asof: ['$it.left[*]', '$it.right[*]'] });
  });

  it('a spec is captured data, not an expression', () => {
    // the whole reason a spec is a literal: it is read ONCE when the
    // query compiles. A surface that let a spec be built from the row
    // would be offering something the compiler cannot check
    for (const build of [
      (s) => s.rows.all().resample('$.spec'),
      (s) => s.rows.all().rolling([{ width: 1 }]),
      (s) => s.left.all().asof(s.right.all(), 'backward'),
    ]) {
      assert.throws(() => from([]).select(build).toDocument(),
        (error) => error.code === 'JL0005', String(build));
    }
  });

  it('answers what its own document answers, for every method', () => {
    const rows = [{
      rows: [{ at: 0, value: 1 }, { at: 1000, value: 3 }, { at: 90000, value: 5 }],
      left: [{ at: 500, value: 1, k: 'a' }, { at: 90500, value: 2, k: 'b' }],
      right: [{ at: 0, value: 10, k: 'a' }, { at: 60000, value: 20, k: 'b' }],
    }];
    // each sequence operator inside an ARRAY constructor: an object
    // member takes exactly one item, and these three answer a series
    agrees(rows, (s) => ({
      buckets: [s.rows.all().resample({ every: 60000, aggregate: 'sum', fill: 'zero' })],
      window: [s.rows.all().rolling({ width: 60000, aggregate: 'mean' })],
      joined: [s.left.all().asof(s.right.all(), { by: '$.k' })],
    }));
    agrees(SHIFTS, (s) => ({ id: s.id, busy: s.span.overlaps({ start: 1800000, end: 5400000 }) }));
  });

  it('runs the k-shaped composition the format publishes', () => {
    const rows = [
      { at: 0, value: 1 }, { at: 30000, value: 3 },
      { at: 60000, value: 5 }, { at: 61000, value: 7 },
    ];
    const query = from([{ rows }])
      .selectMany((s) => s.rows.all().resample({ every: 60000, aggregate: 'sum' }));
    assert.deepStrictEqual(query.toDocument(), {
      $for: { it: ['$[*]'] },
      $return: {
        $for: { it: { $resample: ['$it.rows[*]', { every: 60000, aggregate: 'sum' }] } },
        $return: '$it',
      },
    });
    assert.deepStrictEqual(query.toArray(), [
      { at: 0, value: 4, count: 2 },
      { at: 60000, value: 12, count: 2 },
    ]);
  });

  it('refuses a broken spec through the compiler, not through the surface', () => {
    // the surface checks that a spec IS a literal; every rule about what
    // it may SAY belongs to the compiler, once
    assert.throws(
      () => from([]).select((s) => s.rows.all().rolling({ width: 1, minPeriod: 2 })).toArray(),
      (error) => error.code === 'JQ0003' && /minPeriods/.test(error.message));
    assert.throws(
      () => from([]).select((s) => s.rows.all().resample({ aggregate: 'mean' })).toArray(),
      (error) => error.code === 'JQ0003');
  });
});

describe('the date and series surfaces are documented exactly once', () => {
  const source = readFileSync(
    new URL('../../packages/linq/src/expression.js', import.meta.url), 'utf8');
  const format = readFileSync(
    new URL('../../packages/linq/docs/LINQ-FORMAT.md', import.meta.url), 'utf8');
  const query = readFileSync(
    new URL('../../packages/json/docs/QUERY-FORMAT.md', import.meta.url), 'utf8');
  const types = readFileSync(
    new URL('../../packages/linq/types/index.d.ts', import.meta.url), 'utf8');

  /**
   * Every operator a §8.n table row defines.
   * @param {string} heading
   * @returns {Set<string>}
   */
  function operatorsOf(heading) {
    const section = sectionOf(query, heading);
    assert.ok(section.length > 0, `QUERY-FORMAT has a ${heading}`);
    const found = new Set();
    for (const row of section.matchAll(/^\| ((?:`\$[a-z0-9-]+` ?)+) \|/gm)) {
      for (const name of row[1].matchAll(/\$[a-z0-9-]+/g)) found.add(name[0]);
    }
    return found;
  }

  /** Every METHODS member that lowers to an operator, from the source. */
  const emits = new Map([...source.matchAll(/\b(\w+): (?:unary|binary)\('(\$[a-z0-9-]+)'\)/g)]
    .map((m) => [m[1], m[2]]));
  // the arity-taking methods spell their operator inside their body
  for (const [, name, op] of source.matchAll(/\b(\w+)\(record[^)]*\) \{[\s\S]{0,400}?'?(\$[a-z0-9-]+)'?:/g))
    if (!emits.has(name)) emits.set(name, op);

  it('publishes one method per §8.13 operator, and every one is typed', () => {
    const operators = operatorsOf('### 8.13');
    const covered = new Set([...emits.values()].filter((op) => operators.has(op)));
    assert.deepStrictEqual([...operators].filter((op) => !covered.has(op)), [],
      'the date family is complete on this surface — §8.13 operators with no method');
    const methods = [...emits].filter(([, op]) => operators.has(op)).map(([name]) => name);
    const row = format.split('\n').find((line) => line.startsWith('| date family (§8.13) |'));
    assert.ok(row !== undefined, 'LINQ-FORMAT §4 has the date row');
    for (const name of methods) {
      assert.ok(new RegExp(`\\b${name}\\b`).test(row), `§4's row does not name ${name}`);
      assert.ok(new RegExp(`\\b${name}\\(`).test(types),
        `the typed surface does not declare ${name}()`);
    }
  });

  it('publishes one method per §8.16 operator, and every one is typed', () => {
    const operators = operatorsOf('### 8.16');
    assert.deepStrictEqual([...operators].sort(),
      ['$asof', '$overlaps', '$resample', '$rolling', '$time-bucket'],
      'the series family is exactly five operators');
    const row = format.split('\n').find((line) => line.startsWith('| series family (§8.16) |'));
    assert.ok(row !== undefined, 'LINQ-FORMAT §4 has the series row');
    for (const name of ['overlaps', 'timeBucket', 'resample', 'rolling', 'asof']) {
      assert.ok(row.includes(`\`${name}(`), `§4's row does not name ${name}`);
      assert.ok(new RegExp(`\\b${name}\\(`).test(types),
        `the typed surface does not declare ${name}()`);
    }
  });
});
