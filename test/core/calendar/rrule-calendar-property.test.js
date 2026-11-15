//@ts-check

/**
 * MONTHLY and YEARLY expansion against the independent day-walking oracle
 * (rrule-oracle.js) over seeded random rules and horizons of up to three
 * years: INTERVAL, BYMONTH, BYWEEKNO with every WKST, BYYEARDAY,
 * BYMONTHDAY and BYDAY with and without ordinals (mixed too), negative
 * indexes, BYSETPOS, BYHOUR/BYMINUTE/BYSECOND, COUNT and UNTIL, for date,
 * floating and utc starts, and zoned starts across the Amsterdam changes
 * under each policy. Unlike the dateutil fixture, every shape is in: the
 * classes where dateutil reads RFC 5545 otherwise are checked here.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { compileRecurrence, expandRecurrence, formatRRule } from '@jarenjs/core/calendar';
import { mulberry32 } from '@jarenjs/core/random';
import { oracleStarts, oracleExpand, oracleId } from './rrule-oracle.js';
import { oracleZone, oracleResolve, tableProvider } from './oracle.js';

const DAY = 86400000;
const MINUTE = 60000;
const NAMES = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
const LIMITS = { maxOccurrences: 100000, maxWork: 10000000, maxProviderCalls: 1000000 };

/** @param {number} wall */
const iso = (wall) => new Date(wall).toISOString();
/** @param {number} wall */
const compact = (wall) => iso(wall).slice(0, 19).replace(/[-:]/g, '');
/** @param {() => number} random @param {number} low @param {number} high */
const between = (random, low, high) => low + Math.floor(random() * (high - low + 1));

/**
 * Up to `most` distinct values, sorted.
 * @param {() => number} random
 * @param {() => number} draw
 * @param {number} most
 */
function some(random, draw, most) {
  const n = between(random, 1, most);
  const out = new Set();
  while (out.size < n)
    out.add(draw());
  return [...out].sort((a, b) => a - b);
}

/** @param {() => number} random @param {number} top - a signed index from ±1 to ±top */
const signed = (random, top) => () => between(random, 1, top) * (random() < 0.35 ? -1 : 1);

/**
 * One random rule.
 * @param {() => number} random
 * @param {'date' | 'floating' | 'utc' | 'zoned'} kind
 */
function generate(random, kind) {
  const day = Math.floor(Date.UTC(2018, 0, 1) / DAY) + between(random, 0, 3650);
  const time = kind === 'date' ? 0 : (between(random, 0, 23) * 60 + between(random, 0, 59)) * MINUTE;
  // a quarter of the starts sit on a month's last days, where invalid dates are skipped, not clamped
  const start = (random() < 0.25 ? Math.floor(Date.UTC(2018 + between(random, 0, 9), between(random, 1, 12), 0) / DAY) - between(random, 0, 2)
    : day) * DAY + time;
  const yearly = random() < 0.5;
  /** @type {Record<string, any>} */
  const parts = { FREQ: yearly ? 'YEARLY' : 'MONTHLY' };
  if (random() < 0.4)
    parts.INTERVAL = between(random, 2, yearly ? 3 : 7);
  const ending = random();
  if (ending < 0.3)
    parts.COUNT = between(random, 1, 30);
  else if (ending < 0.55) {
    const until = start + between(random, -2, 1000) * DAY + between(random, -3, 3) * 3600000;
    parts.UNTIL = kind === 'date' ? compact(until).slice(0, 8) : kind === 'floating' ? compact(until) : `${compact(until)}Z`;
  }
  if (kind !== 'date' && random() < 0.15)
    parts.BYHOUR = some(random, () => between(random, 0, 23), 2);
  if (kind !== 'date' && random() < 0.1)
    parts.BYMINUTE = some(random, () => between(random, 0, 59), 2);
  if (random() < (yearly ? 0.35 : 0.25))
    parts.BYMONTH = some(random, () => between(random, 1, 12), 4);
  const weekNo = yearly && random() < 0.3;
  if (weekNo)
    parts.BYWEEKNO = some(random, signed(random, 53), 3);
  if (yearly && random() < 0.2)
    parts.BYYEARDAY = some(random, signed(random, 366), 4);
  if (random() < (yearly ? 0.3 : 0.45))
    parts.BYMONTHDAY = some(random, signed(random, 31), 4);
  if (random() < 0.55) {
    const top = !yearly || parts.BYMONTH !== undefined ? 5 : 53;
    const n = between(random, 1, 4);
    const items = new Set();
    while (items.size < n) {
      const ordinal = weekNo || random() < 0.45 ? '' : String(between(random, 1, top) * (random() < 0.4 ? -1 : 1));
      items.add(`${ordinal}${NAMES[between(random, 0, 6)]}`);
    }
    parts.BYDAY = [...items];
  }
  if (Object.keys(parts).some((name) => name.startsWith('BY')) && random() < 0.25)
    parts.BYSETPOS = some(random, signed(random, 8), 3);
  if (random() < (weekNo ? 0.7 : 0.25))
    parts.WKST = NAMES[between(random, 0, 6)];
  const span = kind === 'date' ? between(random, 0, 2) * DAY : between(random, 0, 72) * 30 * MINUTE;
  return { parts, start, span };
}

/** @param {Record<string, any>} parts */
const textOf = (parts) => Object.entries(parts).map(([name, value]) => `${name}=${Array.isArray(value) ? value.join(',') : value}`).join(';');

/**
 * @param {'date' | 'floating' | 'utc' | 'zoned'} kind
 * @param {number} wall
 * @param {string} [zone]
 */
function startValue(kind, wall, zone) {
  const text = iso(wall);
  if (kind === 'date')
    return { kind, date: text.slice(0, 10) };
  if (kind === 'utc')
    return { kind, instant: `${text.slice(0, 19)}Z` };
  if (kind === 'floating')
    return { kind, date: text.slice(0, 10), time: text.slice(11, 19) };
  return { kind, date: text.slice(0, 10), time: text.slice(11, 19), zone: /** @type {string} */ (zone) };
}

/** @param {'date' | 'floating' | 'utc' | 'zoned'} kind @param {number} wall */
const bound = (kind, wall) => (kind === 'date' ? { kind, date: iso(wall).slice(0, 10) } : kind === 'floating'
  ? { kind, date: iso(wall).slice(0, 10), time: iso(wall).slice(11, 19) } : wall);

/** @param {any} value */
const wallOfValue = (value) => (value.kind === 'utc' ? Date.parse(value.instant) : Date.parse(`${value.date}T${value.time ?? '00:00:00'}Z`));

describe('MONTHLY/YEARLY expansion equals the day-walking oracle', () => {
  for (const [kind, rules] of /** @type {const} */ ([['floating', 1000], ['date', 500], ['utc', 500]])) {
    it(`${kind} starts: ${rules} seeded rules over horizons of up to three years`, () => {
      const random = mulberry32(kind === 'floating' ? 61 : kind === 'utc' ? 62 : 63);
      let occurrences = 0;
      let skippedAhead = 0;
      for (let i = 0; i < rules; i++) {
        const { parts, start, span } = generate(random, kind);
        const duration = kind === 'date' ? `P${span / DAY}D` : `PT${span / MINUTE}M`;
        const dtstart = startValue(kind, start);
        const compiled = compileRecurrence({ dtstart, duration, rrule: textOf(parts) });
        assert.deepStrictEqual(compileRecurrence({ dtstart, duration, rrule: formatRRule(compiled) }).rrule, compiled.rrule);
        const lowDay = Math.floor(start / DAY) + between(random, -40, 800);
        const low = lowDay * DAY + (kind === 'date' ? 0 : between(random, 0, 23) * 3600000);
        const high = low + between(random, 1, 1096) * DAY;
        const expected = oracleExpand(textOf(parts), start, kind === 'date', span, low, high);
        const got = expandRecurrence(compiled, { horizon: [bound(kind, low), bound(kind, high)], limits: LIMITS });
        assert.strictEqual(got.status, 'complete');
        const context = `${textOf(parts)} from ${iso(start).slice(0, 19)} over [${iso(low)}, ${iso(high)})`;
        assert.deepStrictEqual(got.occurrences.map((o) => o.recurrenceId), expected.map((o) => oracleId(o.start, kind)), context);
        assert.deepStrictEqual(got.occurrences.map((o) => [wallOfValue(o.start), wallOfValue(o.end)]),
          expected.map((o) => [o.start, o.end]), context);
        occurrences += expected.length;
        skippedAhead += parts.COUNT === undefined && low - start > 400 * DAY ? 1 : 0;
      }
      assert.ok(occurrences > 3000, `${occurrences} occurrences`);
      assert.ok(skippedAhead > rules / 10, `${skippedAhead} horizons far enough for the walk to skip ahead`);
    });
  }

  it('COUNT keeps its meaning: a horizon after the last occurrence is complete and empty', () => {
    const random = mulberry32(64);
    let checked = 0;
    for (let i = 0; i < 300; i++) {
      const { parts, start } = generate(random, 'floating');
      parts.COUNT = between(random, 1, 20);
      delete parts.UNTIL;
      const all = oracleStarts(textOf(parts), start, false, start + 30 * 366 * DAY);
      if (all.length < parts.COUNT)
        continue;
      checked++;
      const after = all[all.length - 1] + 1000;
      const compiled = compileRecurrence({ dtstart: startValue('floating', start), rrule: textOf(parts) });
      const got = expandRecurrence(compiled, { horizon: [bound('floating', after), bound('floating', after + 800 * DAY)], limits: LIMITS });
      assert.strictEqual(got.status, 'complete');
      assert.deepStrictEqual(got.occurrences, [], textOf(parts));
      // and the whole list from DTSTART is the oracle's
      const whole = expandRecurrence(compiled, { horizon: [bound('floating', start), bound('floating', after)], limits: LIMITS });
      assert.deepStrictEqual(whole.occurrences.map((o) => o.recurrenceId), all.map((wall) => oracleId(wall, 'floating')), textOf(parts));
    }
    assert.ok(checked > 150, `${checked} rules reached their COUNT`);
  });

  for (const policy of /** @type {const} */ (['rfc5545', 'later', 'reject'])) {
    it(`zoned starts in Europe/Amsterdam under ${policy}: 200 rules across the table's transitions`, () => {
      const zone = 'Europe/Amsterdam';
      const table = oracleZone(zone);
      const provider = tableProvider(zone, table);
      const random = mulberry32(70 + policy.length);
      let occurrences = 0;
      let refusals = 0;
      for (let i = 0; i < 200; i++) {
        const { parts, start, span } = generate(random, 'zoned');
        delete parts.UNTIL;
        // the changes fall on the last Sunday of March and October, at 02:00 and 03:00 local
        if (random() < 0.5) {
          parts.BYDAY = ['-1SU'];
          delete parts.BYMONTHDAY;
          delete parts.BYYEARDAY;
          delete parts.BYWEEKNO;
          delete parts.BYSETPOS;
          parts.BYHOUR = [2];
        }
        const compiled = compileRecurrence({ dtstart: startValue('zoned', start, zone), duration: `PT${span / MINUTE}M`, rrule: textOf(parts), policy });
        const low = (Math.floor(start / DAY) + between(random, -30, 800)) * DAY + between(random, 0, 23) * 3600000;
        const high = low + between(random, 1, 1096) * DAY;
        const walls = oracleStarts(textOf(parts), start, false, high + 3 * DAY);
        let refused = false;
        const expected = [];
        for (const wall of walls) {
          const placed = /** @type {{ instant: number }} */ (oracleResolve(table, wall, 'rfc5545'));
          const end = placed.instant + span;
          if (!(placed.instant < high && (end > low || placed.instant >= low)))
            continue;
          const resolved = oracleResolve(table, wall, policy);
          if (resolved === null) {
            refused = true;
            break;
          }
          expected.push({ id: oracleId(wall, 'zoned'), start: resolved.instant, end: resolved.instant + span });
        }
        expected.sort((a, b) => a.start - b.start);
        const run = () => expandRecurrence(compiled, { horizon: [low, high], provider, limits: LIMITS });
        if (refused) {
          refusals++;
          assert.throws(run, (/** @type {any} */ error) => error.code === 'JY0002' || error.code === 'JY0003', textOf(parts));
          continue;
        }
        const got = run();
        assert.deepStrictEqual(got.occurrences.map((o) => ({ id: o.recurrenceId, start: o.instants?.start, end: o.instants?.end })),
          expected, `${textOf(parts)} from ${iso(start)} over [${low}, ${high})`);
        occurrences += expected.length;
      }
      assert.ok(occurrences > 300, `${occurrences} occurrences`);
      if (policy === 'reject')
        assert.ok(refusals > 0, 'the corpus reaches a gap or fold inside a horizon');
    });
  }
});

describe('the oracle itself, on hand-checked rules', () => {
  /** @param {string} rule @param {number} start @param {number} [stop] */
  const dates = (rule, start, stop = Date.UTC(2100, 0, 1)) => oracleStarts(rule, start, false, stop).map((wall) => iso(wall).slice(0, 10));

  it('the last Friday of each month, and Feb 29 kept only in leap years', () => {
    assert.deepStrictEqual(dates('FREQ=MONTHLY;COUNT=4;BYDAY=-1FR', Date.UTC(2026, 0, 30, 9)),
      ['2026-01-30', '2026-02-27', '2026-03-27', '2026-04-24']);
    assert.deepStrictEqual(dates('FREQ=YEARLY;COUNT=3', Date.UTC(2024, 1, 29, 9)), ['2024-02-29', '2028-02-29', '2032-02-29']);
  });

  it('week 1 under WKST=MO and WKST=SU, with its days in December', () => {
    // 2026-01-01 is a Thursday: ISO week 1 runs Mon 2025-12-29 to Sun 2026-01-04
    assert.deepStrictEqual(dates('FREQ=YEARLY;COUNT=3;BYWEEKNO=1;BYDAY=MO,SU', Date.UTC(2025, 11, 29, 9)),
      ['2025-12-29', '2026-01-04', '2027-01-04']);
    // with WKST=SU the week holding 1 January has only three days of 2026, so week 1 runs Sun 2026-01-04 to Sat 2026-01-10
    assert.deepStrictEqual(dates('FREQ=YEARLY;COUNT=3;BYWEEKNO=1;BYDAY=MO,SU;WKST=SU', Date.UTC(2026, 0, 4, 9)),
      ['2026-01-04', '2026-01-05', '2027-01-03']);
  });
});
