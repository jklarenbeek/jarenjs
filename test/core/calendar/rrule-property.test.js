//@ts-check

/**
 * DAILY and WEEKLY expansion against the independent day-walking oracle
 * (rrule-oracle.js) over seeded random rules: INTERVAL, BYDAY, BYHOUR,
 * BYMINUTE, BYSECOND, COUNT, UNTIL, WKST, BYSETPOS, BYMONTH and (DAILY)
 * BYMONTHDAY, for date, floating, utc and zoned starts, each rule read
 * from its text, a reshuffled lower-case spelling and its JSON form.
 * Zoned rules resolve through the transition-table provider and are
 * checked against the table read with arithmetic only.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { compileRecurrence, expandRecurrence, formatRRule } from '@jarenjs/core/calendar';
import { mulberry32 } from '@jarenjs/core/random';
import { oracleStarts, oracleExpand, oracleId } from './rrule-oracle.js';
import { oracleZone, oracleResolve, offsetAt, tableProvider } from './oracle.js';

const DAY = 86400000;
const MINUTE = 60000;
const NAMES = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
const LIMITS = { maxOccurrences: 100000, maxWork: 10000000, maxProviderCalls: 1000000 };

/** @param {number} wall */
const isoDate = (wall) => new Date(wall).toISOString().slice(0, 10);
/** @param {number} wall */
const isoTime = (wall) => new Date(wall).toISOString().slice(11, 19);
/** @param {number} wall */
const compact = (wall) => new Date(wall).toISOString().slice(0, 19).replace(/[-:]/g, '');

/**
 * @param {() => number} random
 * @param {number} low
 * @param {number} high
 */
const between = (random, low, high) => low + Math.floor(random() * (high - low + 1));

/**
 * @template T
 * @param {() => number} random
 * @param {T[]} from
 * @param {number} most
 * @returns {T[]}
 */
function some(random, from, most) {
  const n = between(random, 1, most);
  const out = new Set();
  while (out.size < n)
    out.add(from[Math.floor(random() * from.length)]);
  return [...out];
}

/**
 * One random rule: its parts in generation order, its start and length.
 * @param {() => number} random
 * @param {'date' | 'floating' | 'utc' | 'zoned'} kind
 */
function generate(random, kind) {
  const day = Math.floor(Date.UTC(2021, 0, 1) / DAY) + between(random, 0, 3650);
  const time = kind === 'date' ? 0 : (between(random, 0, 23) * 60 + between(random, 0, 59)) * MINUTE
    + (random() < 0.2 ? between(random, 0, 59) * 1000 : 0);
  const start = day * DAY + time;
  const weekly = random() < 0.5;
  /** @type {Record<string, any>} */
  const parts = { FREQ: weekly ? 'WEEKLY' : 'DAILY' };
  if (random() < 0.5)
    parts.INTERVAL = between(random, 2, 5);
  const ending = random();
  if (ending < 0.3)
    parts.COUNT = between(random, 1, 40);
  else if (ending < 0.6) {
    const until = start + between(random, -2, 400) * DAY + between(random, -3, 3) * 3600000;
    parts.UNTIL = kind === 'date' ? compact(until).slice(0, 8) : kind === 'floating' ? compact(until) : `${compact(until)}Z`;
  }
  if (kind !== 'date') {
    if (random() < 0.25)
      parts.BYHOUR = some(random, [...Array(24).keys()], 3);
    if (random() < 0.25)
      parts.BYMINUTE = some(random, [0, 15, 30, 45, 59], 2);
    if (random() < 0.15)
      parts.BYSECOND = some(random, [0, 30, 59], 2);
  }
  if (random() < (weekly ? 0.6 : 0.25))
    parts.BYDAY = some(random, NAMES, 4);
  if (random() < 0.2)
    parts.BYMONTH = some(random, [...Array(12).keys()].map((m) => m + 1), 4);
  if (!weekly && random() < 0.2)
    parts.BYMONTHDAY = some(random, [1, 2, 15, 28, 29, 30, 31, -1, -2, -31], 3);
  if (random() < 0.3)
    parts.WKST = NAMES[between(random, 0, 6)];
  const byParts = ['BYHOUR', 'BYMINUTE', 'BYSECOND', 'BYDAY', 'BYMONTH', 'BYMONTHDAY'].some((name) => parts[name] !== undefined);
  if (byParts && random() < 0.25)
    parts.BYSETPOS = some(random, [1, 2, 3, -1, -2, 4], 2);
  const span = kind === 'date' ? between(random, 0, 2) * DAY : between(random, 0, 72) * 30 * MINUTE;
  return { parts, start, span };
}

/** @param {Record<string, any>} parts */
const textOf = (parts) => Object.entries(parts).map(([name, value]) => `${name}=${Array.isArray(value) ? value.join(',') : value}`).join(';');

/**
 * The same rule spelled another way: parts reversed, lower case.
 * @param {Record<string, any>} parts
 */
const respelled = (parts) => textOf(Object.fromEntries(Object.entries(parts).reverse())).toLowerCase();

/**
 * The rule's JSON form, built here from the generated parts.
 * @param {Record<string, any>} parts
 */
function jsonOf(parts) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const [name, value] of Object.entries(parts)) {
    if (name !== 'UNTIL') {
      out[name] = value;
      continue;
    }
    const date = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
    const time = value.length > 8 ? `${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}` : '';
    out.UNTIL = value.length === 8 ? { kind: 'date', date } : value.endsWith('Z')
      ? { kind: 'utc', instant: `${date}T${time}Z` } : { kind: 'floating', date, time };
  }
  return out;
}

/**
 * @param {'date' | 'floating' | 'utc' | 'zoned'} kind
 * @param {number} wall
 * @param {string} [zone]
 */
function startValue(kind, wall, zone) {
  if (kind === 'date')
    return { kind, date: isoDate(wall) };
  if (kind === 'utc')
    return { kind, instant: `${isoDate(wall)}T${isoTime(wall)}Z` };
  if (kind === 'floating')
    return { kind, date: isoDate(wall), time: isoTime(wall) };
  return { kind, date: isoDate(wall), time: isoTime(wall), zone: /** @type {string} */ (zone) };
}

/**
 * A horizon bound of a kind at a wall clock (an instant for utc/zoned).
 * @param {'date' | 'floating' | 'utc' | 'zoned'} kind
 * @param {number} wall
 */
const bound = (kind, wall) => (kind === 'date' ? { kind, date: isoDate(wall) } : kind === 'floating'
  ? { kind, date: isoDate(wall), time: isoTime(wall) } : wall);

/**
 * The wall clock a start or end value reads.
 * @param {any} value
 */
const wallOfValue = (value) => (value.kind === 'utc' ? Date.parse(value.instant)
  : Date.parse(`${value.date}T${value.time ?? '00:00:00'}Z`));

describe('DAILY/WEEKLY expansion equals the day-walking oracle', () => {
  for (const kind of /** @type {const} */ (['floating', 'utc', 'date'])) {
    it(`${kind} starts: 1,000 seeded rules, three spellings each, random horizons`, () => {
      const random = mulberry32(kind === 'floating' ? 51 : kind === 'utc' ? 52 : 53);
      let occurrences = 0;
      for (let i = 0; i < 1000; i++) {
        const { parts, start, span } = generate(random, kind);
        const duration = kind === 'date' ? `P${span / DAY}D` : `PT${span / MINUTE}M`;
        const dtstart = startValue(kind, start);
        const spellings = [textOf(parts), respelled(parts), jsonOf(parts)];
        const compiled = spellings.map((rrule) => compileRecurrence({ dtstart, duration, rrule: /** @type {any} */ (rrule) }));
        const canonical = formatRRule(compiled[0]);
        for (const other of compiled.slice(1))
          assert.strictEqual(formatRRule(other), canonical, `${textOf(parts)}: spellings disagree`);
        assert.strictEqual(formatRRule(canonical), canonical);
        assert.deepStrictEqual(compileRecurrence({ dtstart, duration, rrule: canonical }).rrule, compiled[0].rrule);

        const lowDay = Math.floor(start / DAY) + between(random, -30, 500);
        const low = lowDay * DAY + (kind === 'date' ? 0 : between(random, 0, 23) * 3600000);
        const high = low + between(random, 1, 400) * DAY + (kind === 'date' ? 0 : between(random, 0, 23) * 3600000);
        const expected = oracleExpand(textOf(parts), start, kind === 'date', span, low, high);
        const got = expandRecurrence(compiled[i % 3], { horizon: [bound(kind, low), bound(kind, high)], limits: LIMITS });
        assert.strictEqual(got.status, 'complete');
        const context = `${textOf(parts)} from ${dtstart.date}${'time' in dtstart ? `T${dtstart.time}` : ''} over [${low}, ${high})`;
        assert.deepStrictEqual(got.occurrences.map((o) => o.recurrenceId), expected.map((o) => oracleId(o.start, kind)), context);
        assert.deepStrictEqual(got.occurrences.map((o) => [wallOfValue(o.start), wallOfValue(o.end)]),
          expected.map((o) => [o.start, o.end]), context);
        occurrences += expected.length;
      }
      assert.ok(occurrences > 5000, `the corpus is not trivially empty (${occurrences} occurrences)`);
    });
  }

  it('COUNT keeps its meaning: a horizon after the last occurrence is complete and empty', () => {
    const random = mulberry32(54);
    let checked = 0;
    for (let i = 0; i < 500; i++) {
      const { parts, start, span } = generate(random, 'floating');
      parts.COUNT = between(random, 1, 30);
      delete parts.UNTIL;
      // a rule whose parts rarely meet may not reach COUNT within the window; it says nothing here
      const all = oracleStarts(textOf(parts), start, false, start + 40 * 366 * DAY);
      if (all.length < parts.COUNT)
        continue;
      checked++;
      const last = all[all.length - 1];
      const compiled = compileRecurrence({ dtstart: startValue('floating', start), duration: `PT${span / MINUTE}M`, rrule: textOf(parts) });
      const after = last + span + 1000;
      const got = expandRecurrence(compiled, { horizon: [bound('floating', after), bound('floating', after + 400 * DAY)], limits: LIMITS });
      assert.strictEqual(got.status, 'complete');
      assert.deepStrictEqual(got.occurrences, [], textOf(parts));
    }
    assert.ok(checked > 400, `${checked} rules reached their COUNT`);
  });

  for (const zone of ['Europe/Amsterdam', 'America/New_York', 'Australia/Lord_Howe']) {
    for (const policy of /** @type {const} */ (['rfc5545', 'later', 'reject'])) {
      it(`zoned starts in ${zone} under ${policy}: 300 rules across the table's transitions`, () => {
        const table = oracleZone(zone);
        const provider = tableProvider(zone, table);
        const random = mulberry32(zone.length * 7 + policy.length);
        let refusals = 0;
        let occurrences = 0;
        for (let i = 0; i < 300; i++) {
          const { parts, start, span } = generate(random, 'zoned');
          if (random() < 0.5 && parts.BYHOUR === undefined)
            parts.BYHOUR = [2];
          const compiled = compileRecurrence({ dtstart: startValue('zoned', start, zone), duration: `PT${span / MINUTE}M`,
            rrule: textOf(parts), policy });
          const lowDay = Math.floor(start / DAY) + between(random, -30, 500);
          // cut inside the hours a change moves, not only at UTC midnight
          const low = lowDay * DAY + between(random, 0, 23) * 3600000 + between(random, 0, 3) * 15 * MINUTE;
          const high = low + (random() < 0.3 ? between(random, 1, 8) * 15 * MINUTE : between(random, 1, 400) * DAY);
          const untilText = parts.UNTIL;
          const until = untilText === undefined ? Infinity
            : Date.UTC(Number(untilText.slice(0, 4)), Number(untilText.slice(4, 6)) - 1, Number(untilText.slice(6, 8)),
              Number(untilText.slice(9, 11)), Number(untilText.slice(11, 13)), Number(untilText.slice(13, 15)));
          // a zoned rule's UNTIL is an instant: the oracle walks without it and stops on the resolved instant
          const unbounded = { ...parts };
          delete unbounded.UNTIL;
          const walls = oracleStarts(textOf(unbounded), start, false, high + 3 * DAY);
          let refused = false;
          const expected = [];
          for (const wall of walls) {
            const placed = /** @type {{ instant: number }} */ (oracleResolve(table, wall, 'rfc5545'));
            // instants are not in wall order across a gap: filter, never stop
            if (placed.instant > until)
              continue;
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
          const context = `${textOf(parts)} from ${isoDate(start)}T${isoTime(start)} ${zone} over [${low}, ${high})`;
          assert.deepStrictEqual(got.occurrences.map((o) => ({ id: o.recurrenceId, start: o.instants?.start, end: o.instants?.end })),
            expected, context);
          for (const o of got.occurrences) {
            const startInstant = /** @type {{ start: number, end: number }} */ (o.instants).start;
            const endInstant = /** @type {{ start: number, end: number }} */ (o.instants).end;
            assert.strictEqual(wallOfValue(o.start), startInstant + offsetAt(table, startInstant) * MINUTE, context);
            assert.strictEqual(wallOfValue(o.end), endInstant + offsetAt(table, endInstant) * MINUTE, context);
            assert.deepStrictEqual(o.provider, { name: 'table', revision: 'synthetic' });
          }
          occurrences += expected.length;
        }
        assert.ok(occurrences > 500, `${occurrences} occurrences`);
        if (policy === 'reject')
          assert.ok(refusals > 0, 'the corpus reaches a gap or fold inside a horizon');
      });
    }
  }
});

describe('the oracle itself', () => {
  it('reproduces a hand-checked weekly rule', () => {
    // FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,SU;WKST=MO from Tue 1997-08-05 (RFC 5545 §3.8.5.3)
    const start = Date.UTC(1997, 7, 5, 9);
    const starts = oracleStarts('FREQ=WEEKLY;INTERVAL=2;COUNT=4;BYDAY=TU,SU;WKST=MO', start, false, Infinity);
    assert.deepStrictEqual(starts.map((wall) => isoDate(wall)), ['1997-08-05', '1997-08-10', '1997-08-19', '1997-08-24']);
    const sunday = oracleStarts('FREQ=WEEKLY;INTERVAL=2;COUNT=4;BYDAY=TU,SU;WKST=SU', start, false, Infinity);
    assert.deepStrictEqual(sunday.map((wall) => isoDate(wall)), ['1997-08-05', '1997-08-17', '1997-08-19', '1997-08-31']);
  });
});
