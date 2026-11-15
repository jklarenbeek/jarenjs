//@ts-check

/**
 * Recurring series: RDATE, EXDATE and overrides over a base rule, in the
 * documented precedence, against a naive set oracle built in this file
 * (the base rule expanded over a wide window, then the three layers
 * applied by hand) with the horizon cut at every boundary. Also: slots
 * moved into and out of the horizon, orphans, the RANGE refusal, a
 * shared budget, and immutability.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  compileRecurrence, expandRecurrence, defineSeries, expandSeries, floatingValue, dateValue, zonedValue, CalendarError,
} from '@jarenjs/core/calendar';
import { mulberry32 } from '@jarenjs/core/random';
import { oracleZone, tableProvider } from './oracle.js';

const amsterdam = tableProvider('Europe/Amsterdam', oracleZone('Europe/Amsterdam'));
const at = (/** @type {string} */ text) => Date.parse(text);
const f = (/** @type {string} */ date, /** @type {string} */ time) => floatingValue(date, time);
const wallOf = (/** @type {any} */ value) => Date.parse(`${value.date}T${value.time ?? '00:00:00'}Z`);

/**
 * @param {() => unknown} run
 * @param {string} code
 * @param {string} path
 */
function refuses(run, code, path) {
  assert.throws(run, (/** @type {any} */ error) => {
    assert.ok(error instanceof CalendarError, String(error));
    assert.strictEqual(error.code, code, error.message);
    assert.strictEqual(error.docPath, path, error.message);
    return true;
  });
}

const mondays = compileRecurrence({ dtstart: f('2026-01-05', '09:00'), duration: 'PT1H', rrule: 'FREQ=WEEKLY;BYDAY=MO' });
const january = /** @type {[any, any]} */ ([dateValue('2026-01-01'), dateValue('2026-02-01')]);
const ids = (/** @type {any} */ result) => result.occurrences.map((/** @type {any} */ o) => o.recurrenceId);

describe('precedence: union with RDATEs, minus EXDATEs, then overrides', () => {
  it('an RDATE duplicating a base slot is one occurrence, with the RDATE period\'s length', () => {
    const series = defineSeries({ uid: 's', base: mondays, rdates: [{ start: f('2026-01-12', '09:00'), end: f('2026-01-12', '09:30') }, f('2026-01-14', '18:00')] });
    const got = expandSeries(series, { horizon: january });
    assert.deepStrictEqual(ids(got), ['2026-01-05T09:00:00', '2026-01-12T09:00:00', '2026-01-14T18:00:00', '2026-01-19T09:00:00', '2026-01-26T09:00:00']);
    assert.deepStrictEqual(got.occurrences[1].end, { kind: 'floating', date: '2026-01-12', time: '09:30:00' });
    assert.deepStrictEqual(got.occurrences[2].end, { kind: 'floating', date: '2026-01-14', time: '19:00:00' });
    assert.ok(got.occurrences.every((o) => o.uid === 's' && o.moved === undefined));
  });

  it('an EXDATE removes exactly its slot; a cancelled override removes its slot; a moved one keeps its id', () => {
    const series = defineSeries({
      uid: 's', revision: 'r7', base: mondays,
      exdates: [f('2026-01-12', '09:00'), f('2026-01-12', '10:00')],
      overrides: [
        { recurrenceId: '2026-01-19T09:00:00', status: 'cancelled' },
        { recurrenceId: '2026-01-26T09:00:00', status: 'moved', start: f('2026-01-27', '14:00'), payload: { reason: 'holiday' } },
      ],
    });
    const got = expandSeries(series, { horizon: january });
    assert.deepStrictEqual(ids(got), ['2026-01-05T09:00:00', '2026-01-26T09:00:00']);
    const moved = got.occurrences[1];
    assert.deepStrictEqual([moved.moved, moved.payload, moved.start, moved.end], [true, { reason: 'holiday' },
      { kind: 'floating', date: '2026-01-27', time: '14:00:00' }, { kind: 'floating', date: '2026-01-27', time: '15:00:00' }]);
    assert.ok(got.occurrences.every((o) => o.seriesRevision === 'r7'));
    assert.deepStrictEqual(got.orphans, { count: 0, ids: [] });
  });

  it('a slot moved from outside the horizon into it appears; one moved out disappears; both keep their id', () => {
    const series = defineSeries({
      uid: 's', base: mondays,
      overrides: [
        { recurrenceId: '2026-03-02T09:00:00', status: 'moved', start: f('2026-01-15', '09:00'), end: f('2026-01-15', '11:00') },
        { recurrenceId: '2026-01-12T09:00:00', status: 'moved', start: f('2026-04-01', '09:00') },
      ],
    });
    const got = expandSeries(series, { horizon: january });
    assert.deepStrictEqual(ids(got), ['2026-01-05T09:00:00', '2026-03-02T09:00:00', '2026-01-19T09:00:00', '2026-01-26T09:00:00']);
    const april = expandSeries(series, { horizon: [dateValue('2026-04-01'), dateValue('2026-04-02')] });
    assert.deepStrictEqual(ids(april), ['2026-01-12T09:00:00']);
    assert.strictEqual(april.occurrences[0].moved, true);
    const march = expandSeries(series, { horizon: [dateValue('2026-03-01'), dateValue('2026-03-08')] });
    assert.deepStrictEqual(ids(march), []);
  });

  it('an override the series never makes is an orphan: listed, not applied, not dropped', () => {
    const series = defineSeries({
      uid: 's', base: compileRecurrence({ dtstart: f('2026-01-05', '09:00'), duration: 'PT1H', rrule: 'FREQ=WEEKLY;BYDAY=MO;COUNT=3' }),
      rdates: [f('2026-02-20', '08:00')],
      exdates: [f('2026-01-12', '09:00')],
      overrides: [
        { recurrenceId: '2026-01-06T09:00:00', status: 'moved', start: f('2026-01-07', '09:00') },
        { recurrenceId: '2026-01-26T09:00:00', status: 'cancelled' },
        { recurrenceId: '2026-01-12T09:00:00', status: 'moved', start: f('2026-01-13', '09:00') },
        { recurrenceId: '2026-02-20T08:00:00', status: 'moved', start: f('2026-01-30', '08:00') },
      ],
    });
    const got = expandSeries(series, { horizon: january });
    assert.deepStrictEqual(ids(got), ['2026-01-05T09:00:00', '2026-01-19T09:00:00', '2026-02-20T08:00:00']);
    assert.deepStrictEqual(got.orphans, { count: 3, ids: ['2026-01-06T09:00:00', '2026-01-12T09:00:00', '2026-01-26T09:00:00'] });
    assert.strictEqual(got.status, 'complete');
  });

  it('a series of RDATEs alone', () => {
    const series = defineSeries({ uid: 'one-offs', rdates: [{ start: dateValue('2026-01-02'), end: dateValue('2026-01-04') }, dateValue('2026-01-20')] });
    const got = expandSeries(series, { horizon: january });
    assert.deepStrictEqual(got.occurrences.map((o) => [o.recurrenceId, /** @type {any} */ (o.end).date]),
      [['2026-01-02', '2026-01-04'], ['2026-01-20', '2026-01-21']]);
  });

  it('a zoned rule\'s UTC UNTIL bounds the slots an override may name', () => {
    const base = compileRecurrence({ dtstart: zonedValue('2026-01-01', '09:00', 'Europe/Amsterdam'), rrule: 'FREQ=DAILY;UNTIL=20260103T080000Z' });
    const series = defineSeries({
      uid: 'z', base,
      overrides: [
        { recurrenceId: '2026-01-04T09:00:00', status: 'moved', start: zonedValue('2026-01-02', '12:00', 'Europe/Amsterdam') },
        { recurrenceId: '2026-01-03T09:00:00', status: 'moved', start: zonedValue('2026-01-02', '14:00', 'Europe/Amsterdam') },
      ],
    });
    const got = expandSeries(series, { horizon: [at('2026-01-02T00:00:00Z'), at('2026-01-03T00:00:00Z')], provider: amsterdam });
    assert.deepStrictEqual(ids(got), ['2026-01-02T09:00:00', '2026-01-03T09:00:00']);
    assert.deepStrictEqual(got.orphans, { count: 1, ids: ['2026-01-04T09:00:00'] });
  });

  it('a zoned series resolves its RDATEs and moves through the provider', () => {
    const base = compileRecurrence({ dtstart: zonedValue('2026-03-23', '02:30', 'Europe/Amsterdam'), duration: 'PT1H', rrule: 'FREQ=WEEKLY' });
    const series = defineSeries({
      uid: 'z', base,
      rdates: [zonedValue('2026-03-29', '02:15', 'Europe/Amsterdam')],
      overrides: [{ recurrenceId: '2026-03-30T02:30:00', status: 'moved', start: zonedValue('2026-03-30', '12:00', 'Europe/Amsterdam') }],
    });
    const got = expandSeries(series, { horizon: [at('2026-03-29T00:00:00Z'), at('2026-04-01T00:00:00Z')], provider: amsterdam });
    assert.deepStrictEqual(got.occurrences.map((o) => [o.recurrenceId, new Date(/** @type {any} */ (o.instants).start).toISOString(), o.moved]), [
      ['2026-03-29T02:15:00', '2026-03-29T01:15:00.000Z', undefined],
      ['2026-03-30T02:30:00', '2026-03-30T10:00:00.000Z', true],
    ]);
    refuses(() => defineSeries({ uid: 'z', base, rdates: [zonedValue('2026-03-29', '02:15', 'Europe/Berlin')] }), 'JY0013', '/rdates/0/zone');
    refuses(() => expandSeries(series, { horizon: [0, 1] }), 'JY0004', '/provider');
  });
});

describe('the set oracle, with the horizon cut at every boundary', () => {
  it('120 seeded series agree with the oracle on every cut', () => {
    const random = mulberry32(3);
    const pick = (/** @type {number} */ n) => Math.floor(random() * n);
    const W = /** @type {[any, any]} */ ([dateValue('2025-12-01'), dateValue('2026-05-01')]);
    let cuts = 0;
    for (let i = 0; i < 120; i++) {
      const base = compileRecurrence({
        dtstart: f('2026-01-05', `${String(8 + pick(4)).padStart(2, '0')}:00`), duration: `PT${30 * (1 + pick(6))}M`,
        rrule: ['FREQ=WEEKLY;BYDAY=MO,WE', 'FREQ=DAILY;INTERVAL=3;COUNT=20', 'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,FR;BYHOUR=9,15'][pick(3)],
      });
      const all = expandRecurrence(base, { horizon: W }).occurrences;
      const day = () => `2026-0${1 + pick(3)}-${String(1 + pick(28)).padStart(2, '0')}`;
      const rdates = [...Array(pick(4))].map(() => (random() < 0.5 ? f(day(), '12:00')
        : { start: f(day(), '07:00'), end: f(day(), '23:00') })).filter((r) => !('start' in r) || wallOf(r.end) >= wallOf(r.start));
      const slotIds = [...all.map((o) => o.recurrenceId), ...rdates.map((r) => ('start' in r ? r.start : r)).map((v) => `${v.date}T${v.time}:00`)];
      const exdates = [...Array(pick(3))].map(() => slotIds[pick(slotIds.length)]).map((id) => f(id.slice(0, 10), id.slice(11, 16)));
      const overrideIds = [...new Set([...Array(pick(5))].map(() => (random() < 0.8 ? slotIds[pick(slotIds.length)] : `${day()}T03:00:00`)))];
      const overrides = overrideIds.map((recurrenceId) => {
        if (random() < 0.4)
          return { recurrenceId, status: /** @type {const} */ ('cancelled') };
        const moved = day();
        return { recurrenceId, status: /** @type {const} */ ('moved'), start: f(moved, '20:00'), ...(random() < 0.5 ? { end: f(moved, '21:30') } : {}) };
      });
      const series = defineSeries({ uid: `s${i}`, base, rdates, exdates, overrides });

      // the oracle: everything over the wide window, then the three layers by hand
      const length = (/** @type {any} */ o) => wallOf(o.end) - wallOf(o.start);
      /** @type {Map<string, { start: number, end: number, moved?: boolean }>} */
      const set = new Map(all.map((o) => [o.recurrenceId, { start: wallOf(o.start), end: wallOf(o.end) }]));
      const baseLength = all.length > 0 ? length(all[0]) : 0;
      /** @type {Map<string, number>} */
      const slotLength = new Map();
      for (const r of rdates) {
        const start = wallOf('start' in r ? r.start : r);
        const end = 'start' in r ? wallOf(r.end) : start + baseLength;
        const id = new Date(start).toISOString().slice(0, 19);
        if (!slotLength.has(id)) {
          slotLength.set(id, end - start);
          set.set(id, { start, end });
        }
      }
      for (const e of exdates)
        set.delete(new Date(wallOf(e)).toISOString().slice(0, 19));
      const orphans = [];
      for (const o of overrides) {
        if (!set.has(o.recurrenceId)) {
          orphans.push(o.recurrenceId);
          continue;
        }
        if (o.status === 'cancelled')
          set.delete(o.recurrenceId);
        else {
          const start = wallOf(o.start);
          set.set(o.recurrenceId, { start, end: o.end ? wallOf(o.end) : start + (slotLength.get(o.recurrenceId) ?? baseLength), moved: true });
        }
      }
      const points = [...new Set([...set.values()].flatMap(({ start, end }) => [start, end, start - 1000, end + 1000]))].sort((a, b) => a - b);
      for (let c = 0; c + 1 < points.length; c += 1 + pick(3)) {
        const low = points[c];
        const high = points[Math.min(points.length - 1, c + 1 + pick(6))];
        if (!(high > low))
          continue;
        const iso = (/** @type {number} */ ms) => new Date(ms).toISOString();
        const expected = [...set.entries()]
          .filter(([, o]) => o.start < high && (o.end > low || o.start >= low))
          .sort(([a, x], [b, y]) => x.start - y.start || (a < b ? -1 : 1))
          .map(([id, o]) => [id, o.start, o.end, o.moved === true]);
        const got = expandSeries(series, { horizon: [f(iso(low).slice(0, 10), iso(low).slice(11, 19)), f(iso(high).slice(0, 10), iso(high).slice(11, 19))] });
        assert.deepStrictEqual(got.occurrences.map((o) => [o.recurrenceId, wallOf(o.start), wallOf(o.end), o.moved === true]), expected,
          `${series.uid} over [${iso(low)}, ${iso(high)})`);
        assert.deepStrictEqual(got.orphans.ids, [...orphans].sort());
        cuts++;
      }
    }
    assert.ok(cuts > 1000, `${cuts} horizon cuts`);
  });
});

describe('the RANGE refusal, the shared budget and immutability', () => {
  it('RANGE=THISANDFUTURE is kept by defineSeries and refused by expandSeries', () => {
    const override = { recurrenceId: '2026-01-12T09:00:00', status: /** @type {const} */ ('moved'), start: f('2026-01-12', '10:00'),
      range: /** @type {const} */ ('THISANDFUTURE') };
    const series = defineSeries({ uid: 's', base: mondays, overrides: [override] });
    assert.deepStrictEqual(series.overrides[0], override);
    refuses(() => expandSeries(series, { horizon: january }), 'JY0021', '/overrides/0/range');
    refuses(() => defineSeries({ uid: 's', base: mondays, overrides: [{ ...override, range: /** @type {any} */ ('THISANDPRIOR') }] }),
      'JY0014', '/overrides/0/range');
  });

  it('10,000 RDATEs under maxWork 500 stop incomplete with exact counts, inputs unchanged', () => {
    const rdates = [...Array(10000).keys()].map((i) => dateValue(new Date(Date.UTC(2026, 0, 1) + i * 86400000).toISOString().slice(0, 10)));
    const copy = structuredClone(rdates);
    const series = defineSeries({ uid: 'many', rdates });
    const got = expandSeries(series, { horizon: [dateValue('2026-01-01'), dateValue('2030-01-01')], limits: { maxWork: 500 } });
    assert.deepStrictEqual([got.status, got.limit, got.counts], ['incomplete', 'maxWork', { emitted: 0, work: 500, providerCalls: 0 }]);
    assert.deepStrictEqual(rdates, copy);
    const enough = expandSeries(series, { horizon: [dateValue('2026-01-01'), dateValue('2026-02-01')] });
    assert.deepStrictEqual([enough.status, enough.counts], ['complete', { emitted: 31, work: 10000, providerCalls: 0 }]);
  });

  it('maxOccurrences counts what is left after the layers, across a list of series', () => {
    const a = defineSeries({ uid: 'a', base: mondays, exdates: [f('2026-01-05', '09:00')] });
    const b = defineSeries({ uid: 'b', base: compileRecurrence({ dtstart: f('2026-01-06', '09:00'), rrule: 'FREQ=WEEKLY' }) });
    const got = expandSeries([a, b], { horizon: january, limits: { maxOccurrences: 3 } });
    assert.deepStrictEqual([got.status, got.limit, got.occurrences.map((o) => `${o.uid} ${o.recurrenceId}`)],
      ['incomplete', 'maxOccurrences', ['b 2026-01-06T09:00:00', 'a 2026-01-12T09:00:00', 'b 2026-01-13T09:00:00']]);
    assert.strictEqual(expandSeries([a, b], { horizon: january }).occurrences.length, 7);
    // the rule is asked for one more per EXDATE, so what the EXDATE removes does not cut the answer short
    const exactly = expandSeries(a, { horizon: january, limits: { maxOccurrences: 3 } });
    assert.deepStrictEqual([exactly.status, ids(exactly)], ['complete', ['2026-01-12T09:00:00', '2026-01-19T09:00:00', '2026-01-26T09:00:00']]);
  });

  it('a slot whose end passes 9999-12-31 makes the series answer incomplete and keeps the others', () => {
    const base = compileRecurrence({ dtstart: f('9999-12-27', '09:00'), duration: 'P1D', rrule: 'FREQ=WEEKLY' });
    const series = defineSeries({ uid: 'late', base, rdates: [f('9999-12-29', '09:00'), f('9999-12-31', '10:00')] });
    const got = expandSeries(series, { horizon: [dateValue('9999-12-27'), floatingValue('9999-12-31', '24:00', { bound: 'end' })] });
    assert.deepStrictEqual([got.status, got.limit, ids(got)], ['incomplete', 'calendar-end', ['9999-12-27T09:00:00', '9999-12-29T09:00:00']]);
    const ruleOnly = defineSeries({ uid: 'rule', base: compileRecurrence({ dtstart: f('9999-12-30', '09:00'), duration: 'P1D', rrule: 'FREQ=DAILY' }) });
    const tail = expandSeries(ruleOnly, { horizon: [dateValue('9999-12-30'), floatingValue('9999-12-31', '24:00', { bound: 'end' })] });
    assert.deepStrictEqual([tail.status, tail.limit, ids(tail)], ['incomplete', 'calendar-end', ['9999-12-30T09:00:00']]);
  });

  it('a series is frozen and owns its lists; the caller\'s copies may change', () => {
    const exdates = [f('2026-01-12', '09:00')];
    const overrides = [{ recurrenceId: '2026-01-19T09:00:00', status: /** @type {const} */ ('cancelled') }];
    const series = defineSeries({ uid: 's', base: mondays, exdates, overrides });
    exdates.push(f('2026-01-05', '09:00'));
    overrides.length = 0;
    assert.ok(Object.isFrozen(series) && Object.isFrozen(series.exdates) && Object.isFrozen(series.overrides) && Object.isFrozen(series.overrides[0]));
    assert.deepStrictEqual(ids(expandSeries(series, { horizon: january })), ['2026-01-05T09:00:00', '2026-01-26T09:00:00']);
  });
});

describe('defineSeries refusals', () => {
  it('names the member at fault', () => {
    refuses(() => defineSeries(/** @type {any} */ (null)), 'JY0014', '/');
    refuses(() => defineSeries(/** @type {any} */ ({ base: mondays })), 'JY0014', '/uid');
    refuses(() => defineSeries({ uid: 's', base: mondays, sequence: -1 }), 'JY0014', '/sequence');
    refuses(() => defineSeries({ uid: 's', base: mondays, revision: /** @type {any} */ (3) }), 'JY0014', '/revision');
    refuses(() => defineSeries({ uid: 's', base: null }), 'JY0014', '/base');
    refuses(() => defineSeries({ uid: 's', base: /** @type {any} */ ({ kind: 'recurrence' }) }), 'JY0014', '/compiled');
    refuses(() => defineSeries({ uid: 's', base: mondays, rdates: /** @type {any} */ ('x') }), 'JY0014', '/rdates');
    refuses(() => defineSeries({ uid: 's', base: mondays, rdates: [dateValue('2026-01-01')] }), 'JY0013', '/rdates/0/kind');
    refuses(() => defineSeries({ uid: 's', base: mondays, rdates: [/** @type {any} */ ({ start: f('2026-01-01', '09:00'), end: f('2026-01-01', '08:00') })] }),
      'JY0014', '/rdates/0/end');
    refuses(() => defineSeries({ uid: 's', base: mondays, rdates: [/** @type {any} */ ({ start: f('2026-01-01', '09:00'), until: 1 })] }), 'JY0014', '/rdates/0');
    refuses(() => defineSeries({ uid: 's', base: mondays, rdates: [f('2026-01-01', '09:00:00.250')] }), 'JY0013', '/rdates/0');
    refuses(() => defineSeries({ uid: 's', base: mondays, exdates: [dateValue('2026-01-01')] }), 'JY0013', '/exdates/0/kind');
    const ok = { recurrenceId: '2026-01-12T09:00:00', status: /** @type {const} */ ('cancelled') };
    refuses(() => defineSeries({ uid: 's', base: mondays, overrides: [ok, ok] }), 'JY0014', '/overrides/1/recurrenceId');
    refuses(() => defineSeries({ uid: 's', base: mondays, overrides: [{ ...ok, recurrenceId: '2026-01-12T09:00' }] }), 'JY0014', '/overrides/0/recurrenceId');
    refuses(() => defineSeries({ uid: 's', base: mondays, overrides: [{ ...ok, recurrenceId: '2026-02-30T09:00:00' }] }), 'JY0014', '/overrides/0/recurrenceId');
    refuses(() => defineSeries({ uid: 's', base: mondays, overrides: [{ ...ok, recurrenceId: '2026-01-12T09:00:00Z' }] }), 'JY0014', '/overrides/0/recurrenceId');
    refuses(() => defineSeries({ uid: 's', base: mondays, overrides: [{ ...ok, status: /** @type {any} */ ('deleted') }] }), 'JY0014', '/overrides/0/status');
    refuses(() => defineSeries({ uid: 's', base: mondays, overrides: [{ ...ok, start: f('2026-01-12', '10:00') }] }), 'JY0014', '/overrides/0/start');
    refuses(() => defineSeries({ uid: 's', base: mondays, overrides: [{ ...ok, status: 'moved' }] }), 'JY0014', '/overrides/0/start');
    refuses(() => defineSeries({ uid: 's', base: mondays, overrides: [{ ...ok, status: 'moved', start: f('2026-01-12', '10:00'), end: f('2026-01-12', '09:00') }] }),
      'JY0014', '/overrides/0/end');
    refuses(() => defineSeries({ uid: 's', base: mondays, overrides: [/** @type {any} */ ({ ...ok, note: 'x' })] }), 'JY0014', '/overrides/0/note');
    refuses(() => defineSeries({ uid: 's', base: mondays, overrides: [/** @type {any} */ (3)] }), 'JY0014', '/overrides/0');
    refuses(() => defineSeries({ uid: 'd', base: compileRecurrence({ dtstart: dateValue('2026-01-05'), rrule: 'FREQ=DAILY' }),
      overrides: [{ recurrenceId: '2026-01-05T00:00:00', status: 'cancelled' }] }), 'JY0014', '/overrides/0/recurrenceId');
  });

  it('expandSeries refuses what defineSeries did not make and lists that mix kinds', () => {
    refuses(() => defineSeries(/** @type {any} */ ({ uid: 's', base: mondays, bases: [] })), 'JY0014', '/bases');
    refuses(() => expandSeries(defineSeries({ uid: 's', base: mondays }), /** @type {any} */ ({ horizon: january, zone: 'UTC' })),
      'JY0014', '/options/zone');
    refuses(() => expandSeries(/** @type {any} */ ({ kind: 'series' }), { horizon: january }), 'JY0014', '/series');
    refuses(() => expandSeries([], { horizon: january }), 'JY0014', '/series');
    const dates = defineSeries({ uid: 'd', rdates: [dateValue('2026-01-05')] });
    refuses(() => expandSeries([defineSeries({ uid: 's', base: mondays }), dates], { horizon: january }), 'JY0014', '/series/1');
    refuses(() => expandSeries(dates, /** @type {any} */ (null)), 'JY0014', '/options');
  });
});
