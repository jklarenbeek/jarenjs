//@ts-check

/**
 * Recurring events written and read back by the test's own reader: every
 * DAILY and WEEKLY example of RFC 5545 §3.8.5.3 (zoned, expanded under
 * `zones: 'utc'`, against the RFC's own instants; floating, written with
 * its rule and re-expanded by an independent oracle), series with extra
 * dates, excluded dates and overrides in each kind, the weekly-pattern
 * series, a weekly 09:00 series across both 2026 offset changes, and
 * every refusal that stands where a wrong calendar would.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { stringifyIcal, IcalError } from '@jarenjs/josl/ical';
import { defineSeries, compileRecurrence, expandSeries, weeklyPattern, toUtc, formatRRule } from '@jarenjs/core/calendar';
import { createIntlZoneProvider } from '@jarenjs/locales/intl-zones';
import { oracleStarts } from '../core/calendar/rrule-oracle.js';
import fixture from '../core/calendar/fixtures/rfc5545-recurrence/examples.json' with { type: 'json' };
import { readIcal, physicalLines, unfold, splitLine, prop, props, timeOf, durationOf } from './ical-reader.js';
import { checkGrammar } from './ical-grammar.js';

const provider = createIntlZoneProvider({ revision: 'test' });
const runtime = { now: () => Date.parse('2026-01-15T10:20:30Z') };
const DAY = 86400000;

/** @param {string} date @param {string} time @param {string} [zone] */
const zoned = (date, time, zone = 'Europe/Amsterdam') => ({ kind: 'zoned', date, time, zone });
/** @param {string} date @param {string} time */
const floating = (date, time) => ({ kind: 'floating', date, time });
/** @param {string} instant */
const utc = (instant) => ({ kind: 'utc', instant });
/** @param {string} date */
const date = (date) => ({ kind: 'date', date });
const YEAR_2026 = [Date.parse('2026-01-01T00:00:00Z'), Date.parse('2027-01-01T00:00:00Z')];

/**
 * Write a calendar of recurring events and read it back, every line held to the grammar.
 * @param {any[]} series
 * @param {any} [options]
 */
function write(series, options = {}) {
  const text = stringifyIcal({ prodId: '-//Example//Test//EN', components: series.map((s) => ({ type: 'event', series: s, summary: 'Shift' })) },
    { runtime, ...options });
  for (const line of unfold(physicalLines(text)))
    checkGrammar(splitLine(line));
  return { text, calendar: readIcal(text) };
}

/**
 * The occurrences a written VEVENT set makes, by the reader alone: DTSTART,
 * the RRULE (the independent oracle), RDATEs, minus EXDATEs, then the
 * RECURRENCE-ID VEVENTs. Times in milliseconds: UTC instants, or wall
 * clocks read as if UTC.
 * @param {import('./ical-reader.js').Component} calendar
 * @param {string} uid
 * @param {number} stop - no start at or after this is needed from the rule
 * @returns {{ slot: number, start: number, end: number }[]}
 */
function occurrencesOf(calendar, uid, stop) {
  const vevents = calendar.children.filter((c) => prop(c, 'UID')?.value === uid);
  const [master, ...moved] = vevents;
  assert.strictEqual(prop(master, 'RECURRENCE-ID'), undefined, 'the master comes first');
  assert.ok(moved.every((v) => prop(v, 'RECURRENCE-ID') !== undefined));
  /** @param {import('./ical-reader.js').Component} v @param {number} start @param {boolean} isDate */
  const endOf = (v, start, isDate) => {
    const dtend = prop(v, 'DTEND');
    if (dtend)
      return timeOf(dtend.value).at;
    const duration = prop(v, 'DURATION');
    if (duration) {
      const { days, ms } = durationOf(duration.value);
      return start + days * DAY + ms;
    }
    return isDate ? start + DAY : start;
  };
  const start = timeOf(prop(master, 'DTSTART')?.value ?? '');
  const isDate = start.kind === 'date';
  const length = endOf(master, start.at, isDate) - start.at;
  /** @type {Map<number, number>} slot -> end */
  const slots = new Map([[start.at, start.at + length]]);
  const rrule = prop(master, 'RRULE');
  if (rrule) {
    for (const wall of oracleStarts(rrule.value, start.at, isDate, stop))
      slots.set(wall, wall + length);
  }
  for (const rdate of props(master, 'RDATE')) {
    const [from, to] = rdate.value.split('/');
    const at = timeOf(from).at;
    if (!slots.has(at))
      slots.set(at, to === undefined ? at + length : timeOf(to).at);
  }
  for (const exdate of props(master, 'EXDATE'))
    slots.delete(timeOf(exdate.value).at);
  /** @type {{ slot: number, start: number, end: number }[]} */
  const out = [...slots].map(([slot, end]) => ({ slot, start: slot, end }));
  for (const vevent of moved) {
    const slot = timeOf(prop(vevent, 'RECURRENCE-ID')?.value ?? '').at;
    const entry = out.find((o) => o.slot === slot);
    assert.ok(entry, `RECURRENCE-ID ${slot} names a slot of the master's set`);
    entry.start = timeOf(prop(vevent, 'DTSTART')?.value ?? '').at;
    entry.end = endOf(vevent, entry.start, isDate);
  }
  return out.sort((a, b) => a.start - b.start || a.slot - b.slot);
}

/**
 * The same occurrences as the calendar layer answers them for the model.
 * @param {any} series
 * @param {any} horizon
 * @returns {{ slot: number, start: number, end: number }[]}
 */
function expected(series, horizon) {
  const defined = series.kind === 'series' ? series : defineSeries({ ...series, base: series.base ? compileRecurrence(series.base) : null });
  const got = expandSeries(defined, { horizon, provider });
  assert.strictEqual(got.status, 'complete');
  /** @param {any} v */
  const at = (v) => v.kind === 'date' ? Date.parse(`${v.date}T00:00:00Z`) : v.kind === 'utc' ? Date.parse(v.instant)
    : Date.parse(`${v.date}T${v.time.length === 5 ? `${v.time}:00` : v.time}Z`);
  return got.occurrences.map((o) => {
    const id = o.recurrenceId;
    const slot = /** @type {any} */ (o.start).kind === 'zoned'
      ? toUtc(/** @type {any} */ ({ kind: 'zoned', date: id.slice(0, 10), time: id.slice(11), zone: /** @type {any} */ (o.start).zone }),
        { provider, policy: defined.base?.policy ?? 'rfc5545' }).instant
      : Date.parse(id.length === 10 ? `${id}T00:00:00Z` : id.endsWith('Z') ? id : `${id}Z`);
    return { slot, start: o.instants?.start ?? at(o.start), end: o.instants?.end ?? at(o.end) };
  }).sort((a, b) => a.start - b.start || a.slot - b.slot);
}

/**
 * Assert a call is refused with an IcalError of this code.
 * @param {() => unknown} fn @param {string} code @param {string} [docPath]
 * @returns {any}
 */
function refuses(fn, code, docPath = undefined) {
  let caught;
  assert.throws(fn, (/** @type {any} */ error) => {
    caught = error;
    assert.ok(error instanceof IcalError, String(error));
    assert.strictEqual(error.code, code, error.message);
    if (docPath !== undefined)
      assert.strictEqual(error.docPath, docPath, error.message);
    return true;
  });
  return caught;
}

/**
 * `DTSTART;TZID=America/New_York:19970902T090000` as its date and time.
 * @param {string} line
 */
function dtstartOf(line) {
  const form = /** @type {RegExpExecArray} */ (/^DTSTART;TZID=([^:]+):(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(line));
  return { zone: form[1], date: `${form[2]}-${form[3]}-${form[4]}`, time: `${form[5]}:${form[6]}:${form[7]}` };
}

describe('ical series: RFC 5545 §3.8.5.3, every DAILY and WEEKLY example', () => {
  const rows = /** @type {any[]} */ (fixture.examples).filter((row) => row.expected !== undefined);

  it('the fixture holds the 15 DAILY and WEEKLY rows', () => assert.strictEqual(rows.length, 15));

  for (const row of rows) {
    it(`zoned, expanded under zones: utc - ${row.rrule}`, () => {
      const start = dtstartOf(row.dtstart);
      const series = { uid: 'rfc', base: { dtstart: zoned(start.date, start.time, start.zone), rrule: row.rrule } };
      const horizon = row.horizon.map((/** @type {string} */ t) => Date.parse(t));
      const { calendar } = write([series], { zones: 'utc', provider, horizon });
      const [vevent] = calendar.children;
      assert.strictEqual(prop(vevent, 'RRULE'), undefined, 'never a UTC start with a rule');
      const instants = [prop(vevent, 'DTSTART'), ...props(vevent, 'RDATE')].map((p) => timeOf(p?.value ?? ''));
      assert.ok(instants.every((t) => t.kind === 'utc'));
      // the RFC's own list is the oracle: local time and offset alike
      assert.deepStrictEqual(instants.map((t) => t.at), row.expected.map((/** @type {string} */ t) => Date.parse(t)));
    });

    it(`floating, written with its rule - ${row.rrule}`, () => {
      const start = dtstartOf(row.dtstart);
      const rule = row.rrule.replace(/(UNTIL=\d{8}T\d{6})Z/, '$1');
      const series = { uid: 'rfc', base: { dtstart: floating(start.date, start.time), rrule: rule } };
      const { calendar } = write([series]);
      const [vevent] = calendar.children;
      assert.strictEqual(prop(vevent, 'RRULE')?.value, formatRRule(compileRecurrence(series.base)));
      assert.strictEqual(props(vevent, 'RDATE').length, 0, 'a start the rule makes is written once');
      const walls = occurrencesOf(calendar, 'rfc', Date.parse(row.horizon[1])).map((o) => new Date(o.start).toISOString().slice(0, 16));
      assert.deepStrictEqual(walls, row.expected.map((/** @type {string} */ t) => t.slice(0, 16)));
    });
  }
});

describe('ical series: extra dates, excluded dates and overrides in each kind', () => {
  const shapes = /** @type {[string, any, any][]} */ ([
    ['floating with a rule', {
      uid: 'f', sequence: 2, base: { dtstart: floating('2026-03-02', '09:00'), duration: 'PT1H30M', rrule: 'FREQ=WEEKLY;BYDAY=MO,WE;COUNT=8' },
      rdates: [floating('2026-03-07', '10:00'), { start: floating('2026-03-08', '10:00'), end: floating('2026-03-08', '14:00') }],
      exdates: [floating('2026-03-04', '09:00')],
      overrides: [
        { recurrenceId: '2026-03-09T09:00:00', status: 'moved', start: floating('2026-03-09', '11:00') },
        { recurrenceId: '2026-03-11T09:00:00', status: 'moved', start: floating('2026-03-12', '09:00'), end: floating('2026-03-12', '12:00') },
        { recurrenceId: '2026-03-08T10:00:00', status: 'moved', start: floating('2026-03-08', '11:00') },
        { recurrenceId: '2026-03-16T09:00:00', status: 'cancelled' },
      ],
    }, [floating('2026-01-01', '00:00'), floating('2027-01-01', '00:00')]],
    ['floating, with periods on slots the rule makes', {
      uid: 'p', base: { dtstart: floating('2026-03-02', '09:00'), duration: 'PT1H', rrule: 'FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6' },
      rdates: [{ start: floating('2026-03-04', '09:00'), end: floating('2026-03-04', '12:00') },
        { start: floating('2026-03-09', '09:00'), end: floating('2026-03-09', '11:00') },
        { start: floating('2026-03-11', '09:00'), end: floating('2026-03-11', '13:00') },
        floating('2026-03-04', '09:00'),
        { start: floating('2026-03-14', '09:00'), end: floating('2026-03-14', '09:30') }],
      exdates: [floating('2026-03-11', '09:00')],
      overrides: [{ recurrenceId: '2026-03-09T09:00:00', status: 'moved', start: floating('2026-03-10', '09:00') }],
    }, [floating('2026-01-01', '00:00'), floating('2027-01-01', '00:00')]],
    ['floating, a start the rule does not make, with COUNT', {
      uid: 'q', base: { dtstart: floating('2026-03-03', '09:00'), duration: 'PT1H', rrule: 'FREQ=WEEKLY;BYDAY=MO;COUNT=3' },
    }, [floating('2026-01-01', '00:00'), floating('2027-01-01', '00:00')]],
    ['utc, a start the rule does not make, with UNTIL', {
      uid: 'k', base: { dtstart: utc('2026-03-03T08:00:00Z'), rrule: 'FREQ=DAILY;BYHOUR=10;UNTIL=20260306T100000Z' },
    }, YEAR_2026],
    ['dates, a start the rule does not make', {
      uid: 'j', base: { dtstart: date('2026-03-03'), rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR;COUNT=4' }, exdates: [date('2026-03-06')],
    }, [date('2026-01-01'), date('2027-01-01')]],
    ['floating with dtend', {
      uid: 'g', base: { dtstart: floating('2026-03-02', '22:00'), dtend: floating('2026-03-02', '24:00'), rrule: 'FREQ=DAILY;INTERVAL=2;UNTIL=20260320T220000' },
      overrides: [{ recurrenceId: '2026-03-04T22:00:00', status: 'moved', start: floating('2026-03-04', '21:00') }],
    }, [floating('2026-01-01', '00:00'), floating('2027-01-01', '00:00')]],
    ['utc with a rule', {
      uid: 'u', base: { dtstart: utc('2026-03-02T08:00:00Z'), duration: 'P1DT2H', rrule: 'FREQ=WEEKLY;BYDAY=MO,TH;UNTIL=20260402T080000Z' },
      rdates: [utc('2026-03-21T12:00:00Z'), { start: utc('2026-03-22T12:00:00Z'), end: utc('2026-03-22T13:00:00Z') }],
      exdates: [utc('2026-03-05T08:00:00Z')],
      overrides: [{ recurrenceId: '2026-03-09T08:00:00Z', status: 'moved', start: utc('2026-03-09T09:00:00Z') },
        { recurrenceId: '2026-03-22T12:00:00Z', status: 'moved', start: utc('2026-03-22T15:00:00Z') },
        { recurrenceId: '2026-03-12T08:00:00Z', status: 'cancelled' }],
    }, YEAR_2026],
    ['dates with a rule', {
      uid: 'd', base: { dtstart: date('2026-03-02'), duration: 'P2D', rrule: 'FREQ=WEEKLY;COUNT=6' },
      rdates: [date('2026-03-25')], exdates: [date('2026-03-16')],
      overrides: [{ recurrenceId: '2026-03-09', status: 'moved', start: date('2026-03-10') },
        { recurrenceId: '2026-03-23', status: 'moved', start: date('2026-03-24'), end: date('2026-03-27') }],
    }, [date('2026-01-01'), date('2027-01-01')]],
    ['dates with dtend', {
      uid: 'e', base: { dtstart: date('2026-03-02'), dtend: date('2026-03-03'), rrule: 'FREQ=DAILY;COUNT=3' },
    }, [date('2026-01-01'), date('2027-01-01')]],
    ['floating without a rule', {
      uid: 'r', rdates: [floating('2026-03-05', '09:00'), { start: floating('2026-03-02', '09:00'), end: floating('2026-03-02', '10:00') },
        floating('2026-03-09', '09:00')],
      exdates: [floating('2026-03-09', '09:00')],
      overrides: [{ recurrenceId: '2026-03-05T09:00:00', status: 'moved', start: floating('2026-03-06', '09:00') }],
    }, [floating('2026-01-01', '00:00'), floating('2027-01-01', '00:00')]],
    ['utc without a rule', {
      uid: 'v', rdates: [{ start: utc('2026-03-03T08:00:00Z'), end: utc('2026-03-03T09:00:00Z') }, utc('2026-03-02T08:00:00Z')],
    }, YEAR_2026],
    ['dates without a rule', { uid: 'w', rdates: [date('2026-03-02'), date('2026-03-04')] }, [date('2026-01-01'), date('2027-01-01')]],
    ['zoned without a rule, written with no horizon', {
      uid: 'x', rdates: [zoned('2026-03-28', '09:00'), zoned('2026-03-30', '09:00'), { start: zoned('2026-03-29', '01:00'), end: zoned('2026-03-29', '04:00') }],
      overrides: [{ recurrenceId: '2026-03-30T09:00:00', status: 'moved', start: zoned('2026-03-30', '10:00') }],
    }, YEAR_2026],
  ]);

  for (const [name, series, horizon] of shapes) {
    it(`${name}: the reader's occurrences are the calendar layer's`, () => {
      const { calendar } = write([series], { zones: 'utc', provider });
      const stop = horizon[1].kind === undefined ? horizon[1] : Date.parse(`${horizon[1].date}T00:00:00Z`);
      assert.deepStrictEqual(occurrencesOf(calendar, series.uid, stop), expected(series, horizon));
      const vevents = calendar.children;
      const own = series.uid === 'p' ? 1 : 0; // the period on a rule slot with no override of its own
      assert.strictEqual(vevents.length, 1 + own + (series.overrides ?? []).filter((/** @type {any} */ o) => o.status === 'moved').length);
      for (const vevent of vevents) {
        assert.strictEqual(prop(vevent, 'UID')?.value, series.uid);
        assert.strictEqual(prop(vevent, 'SUMMARY')?.value, 'Shift');
        assert.strictEqual(prop(vevent, 'SEQUENCE')?.value, series.sequence === undefined ? undefined : String(series.sequence));
      }
    });
  }

  it('a value defineSeries returned, and its JSON copy, write what its definition writes', () => {
    const [, definition] = shapes[0];
    const defined = defineSeries({ ...definition, base: compileRecurrence(definition.base) });
    assert.strictEqual(write([defined]).text, write([definition]).text);
    assert.strictEqual(write([JSON.parse(JSON.stringify(defined))]).text, write([definition]).text);
    const missing = refuses(() => write([{ kind: 'series' }]), 'ICAL3005', '/components/0/series');
    assert.strictEqual(missing.cause.code, 'JY0014');
    refuses(() => write([{ ...definition, kind: 'recurrence' }]), 'ICAL3003', '/components/0/series/kind');
    refuses(() => write([{ ...definition, base: { ...definition.base, kind: 'series' } }]), 'ICAL3003', '/components/0/series/base/kind');
  });

  it('a period on a slot the rule makes is that slot\'s own VEVENT, never a duplicate RDATE', () => {
    const [, series] = /** @type {any} */ (shapes.find(([name]) => name.startsWith('floating, with periods')));
    const { calendar } = write([series]);
    const [master, ...own] = calendar.children;
    // the plain RDATE given after the period on the same slot loses to it, as in the series
    assert.deepStrictEqual(props(master, 'RDATE').map((p) => p.value), ['20260314T090000/20260314T093000']);
    assert.deepStrictEqual(own.map((v) => [prop(v, 'RECURRENCE-ID')?.value, prop(v, 'DTSTART')?.value, (prop(v, 'DTEND') ?? prop(v, 'DURATION'))?.value]), [
      ['20260309T090000', '20260310T090000', 'PT2H'], ['20260304T090000', '20260304T090000', '20260304T120000']]);
  });

  it('a start the rule does not make is also an RDATE, and its COUNT the UNTIL of the last occurrence', () => {
    const pick = (/** @type {string} */ uid) => /** @type {any} */ (shapes.find(([, s]) => s.uid === uid))[1];
    const { calendar } = write([pick('q'), pick('k'), pick('j')]);
    const lines = calendar.children.map((v) => [prop(v, 'DTSTART')?.value, prop(v, 'RRULE')?.value, props(v, 'RDATE').map((p) => p.value)]);
    assert.deepStrictEqual(lines, [
      ['20260303T090000', 'FREQ=WEEKLY;UNTIL=20260316T090000;BYDAY=MO', ['20260303T090000']],
      ['20260303T080000Z', 'FREQ=DAILY;UNTIL=20260306T100000Z;BYHOUR=10', ['20260303T080000Z']],
      ['20260303', 'FREQ=WEEKLY;UNTIL=20260320;INTERVAL=2;BYDAY=MO,FR', ['20260303']],
    ]);
  });

  it('a rule series writes DURATION or DTEND as given, the canonical RRULE, and cancelled slots as EXDATE', () => {
    const byUid = (/** @type {string} */ uid) => /** @type {any} */ (shapes.find(([, s]) => s.uid === uid))[1];
    const { calendar } = write([byUid('f'), byUid('g')]);
    const [f, g] = ['f', 'g'].map((uid) => /** @type {any} */ (calendar.children.find((c) => prop(c, 'UID')?.value === uid && !prop(c, 'RECURRENCE-ID'))));
    assert.strictEqual(prop(f, 'DURATION')?.value, 'PT1H30M');
    assert.strictEqual(prop(f, 'RRULE')?.value, 'FREQ=WEEKLY;COUNT=8;BYDAY=MO,WE');
    assert.deepStrictEqual(props(f, 'EXDATE').map((p) => p.value), ['20260304T090000', '20260316T090000']);
    assert.deepStrictEqual(props(f, 'RDATE').map((p) => [p.params.VALUE, p.value]), [[undefined, '20260307T100000'], ['PERIOD', '20260308T100000/20260308T140000']]);
    // a moved slot that keeps its length takes the slot's own: the period's, or the rule's
    const moved = calendar.children.filter((c) => prop(c, 'UID')?.value === 'f' && prop(c, 'RECURRENCE-ID'));
    assert.deepStrictEqual(moved.map((v) => [prop(v, 'RECURRENCE-ID')?.value, prop(v, 'DURATION')?.value ?? prop(v, 'DTEND')?.value]), [
      ['20260309T090000', 'PT1H30M'], ['20260311T090000', '20260312T120000'], ['20260308T100000', 'PT4H']]);
    assert.strictEqual(prop(g, 'DTEND')?.value, '20260303T000000');
  });

  it('the weekly-pattern series are written as floating rules, a 24:00 end as the next midnight', () => {
    const pattern = weeklyPattern({ days: { mon: [['09:00', '17:30']], tue: [['20:00', '24:00']], wed: true, thu: false } });
    const { calendar } = write([...pattern]);
    for (const series of pattern) {
      const horizon = [floating('2026-03-02', '00:00'), floating('2026-04-02', '00:00')];
      assert.deepStrictEqual(occurrencesOf(calendar, series.uid, Date.parse('2026-04-02T00:00:00Z'))
        .filter((o) => o.start < Date.parse('2026-04-02T00:00:00Z') && o.end > Date.parse('2026-03-02T00:00:00Z')), expected(series, horizon));
    }
    // every pattern's start is a day its rule makes: written once, the rule as it is
    assert.ok(calendar.children.every((v) => props(v, 'RDATE').length === 0 && !prop(v, 'RRULE')?.value.includes('UNTIL')));
    const night = calendar.children.find((c) => prop(c, 'UID')?.value === 'weekly:20:00:00-24:00:00');
    assert.ok(night);
    assert.ok(props(night, 'DTEND').concat(props(night, 'DURATION')).every((p) => !p.value.includes('T24')));
  });
});

describe('ical series: a zoned weekly 09:00 across both 2026 offset changes', () => {
  const series = { uid: 'standup', base: { dtstart: zoned('2026-01-05', '09:00'), duration: 'PT15M', rrule: 'FREQ=WEEKLY;BYDAY=MO' } };
  const clock = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Amsterdam', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

  it('every occurrence the reader finds is 09:00 in Amsterdam, and the UTC hour moves with the offset', () => {
    const { calendar, text } = write([series], { zones: 'utc', provider, horizon: YEAR_2026 });
    assert.strictEqual(text.includes('RRULE'), false);
    const occurrences = occurrencesOf(calendar, 'standup', YEAR_2026[1]);
    assert.strictEqual(occurrences.length, 52);
    for (const o of occurrences) {
      assert.strictEqual(clock.format(o.start), '09:00', new Date(o.start).toISOString());
      assert.strictEqual(o.end - o.start, 15 * 60000);
    }
    const hours = occurrences.map((o) => new Date(o.start).getUTCHours());
    const summer = occurrences.findIndex((o) => o.start > Date.parse('2026-03-29T01:00:00Z'));
    const winter = occurrences.findIndex((o) => o.start > Date.parse('2026-10-25T01:00:00Z'));
    assert.deepStrictEqual([hours[summer - 1], hours[summer], hours[winter - 1], hours[winter]], [8, 7, 7, 8]);
    assert.ok(hours.slice(0, summer).every((h) => h === 8) && hours.slice(summer, winter).every((h) => h === 7) && hours.slice(winter).every((h) => h === 8));
  });

  it('a series whose length spans an offset change gets its own end where its length differs', () => {
    // a duration of nominal days runs to the same wall clock: 23 hours across the spring change
    const night = { uid: 'night', base: { dtstart: zoned('2026-03-26', '09:00'), duration: 'P1D', rrule: 'FREQ=DAILY;COUNT=5' } };
    const { calendar } = write([night], { zones: 'utc', provider, horizon: YEAR_2026 });
    const rdates = props(calendar.children[0], 'RDATE');
    assert.deepStrictEqual(rdates.map((p) => p.params.VALUE ?? 'DATE-TIME'), ['DATE-TIME', 'PERIOD', 'DATE-TIME', 'DATE-TIME']);
    assert.strictEqual(rdates[1].value, '20260328T080000Z/20260329T070000Z');
    assert.deepStrictEqual(occurrencesOf(calendar, 'night', YEAR_2026[1]), expected(night, YEAR_2026));
  });

  it('without a horizon the series is refused: a UTC start with its rule would move after the change', () => {
    refuses(() => write([series], { zones: 'utc', provider }), 'ICAL3011', '/components/0/series');
    refuses(() => write([series], { provider, horizon: YEAR_2026 }), 'ICAL3008', '/components/0/series');
    refuses(() => write([series], { zones: 'utc', horizon: YEAR_2026 }), 'ICAL3009', '/components/0/series');
  });

  it('a moved slot keeps the RECURRENCE-ID of its original instant, which stays in the master\'s set', () => {
    const moved = { ...series, base: { ...series.base, rrule: 'FREQ=WEEKLY;BYDAY=MO;COUNT=14' },
      overrides: [{ recurrenceId: '2026-03-30T09:00:00', status: 'moved', start: zoned('2026-03-31', '14:00') },
        { recurrenceId: '2026-01-05T09:00:00', status: 'moved', start: zoned('2026-01-05', '10:00') }],
      exdates: [zoned('2026-03-09', '09:00')] };
    const { calendar } = write([moved], { zones: 'utc', provider, horizon: YEAR_2026 });
    const [master, ...overrides] = calendar.children;
    assert.strictEqual(prop(master, 'DTSTART')?.value, '20260105T080000Z');
    assert.deepStrictEqual(overrides.map((v) => [prop(v, 'RECURRENCE-ID')?.value, prop(v, 'DTSTART')?.value]),
      [['20260105T080000Z', '20260105T090000Z'], ['20260330T070000Z', '20260331T120000Z']]);
    assert.ok(props(master, 'RDATE').some((p) => p.value === '20260330T070000Z'));
    assert.ok(!props(master, 'RDATE').some((p) => p.value === '20260309T080000Z'));
    assert.deepStrictEqual(occurrencesOf(calendar, 'standup', YEAR_2026[1]), expected(moved, YEAR_2026));
  });
});

describe('ical series: refused where a calendar would be wrong', () => {
  it('an expansion that stops at a limit, with its counts', () => {
    const series = { uid: 's', base: { dtstart: zoned('2026-01-05', '09:00'), rrule: 'FREQ=DAILY' } };
    const error = refuses(() => write([series], { zones: 'utc', provider, horizon: YEAR_2026, limits: { maxOccurrences: 10 } }), 'ICAL3012', '/components/0/series');
    assert.match(error.message, /stopped at maxOccurrences after 10 occurrences/);
    refuses(() => write([{ uid: 'r', rdates: [floating('2026-03-02', '09:00'), floating('2026-03-04', '09:00')] }], { limits: { maxOccurrences: 1 } }), 'ICAL3012');
  });

  it('a rule asked for one slot, or for its last occurrence, stops at a limit', () => {
    // a COUNT is walked from the start, so the slot ten years on costs a step a day
    const far = { uid: 's', base: { dtstart: floating('2026-03-02', '09:00'), rrule: 'FREQ=DAILY;COUNT=5000' },
      rdates: [{ start: floating('2036-03-02', '09:00'), end: floating('2036-03-02', '12:00') }] };
    assert.ok(write([far]).text.includes('RECURRENCE-ID:20360302T090000'));
    refuses(() => write([far], { limits: { maxWork: 100 } }), 'ICAL3012', '/components/0/series');
    const unsynced = { uid: 'u', base: { dtstart: floating('2026-03-03', '09:00'), rrule: 'FREQ=WEEKLY;BYDAY=MO;COUNT=5' } };
    const error = refuses(() => write([unsynced], { limits: { maxOccurrences: 2 } }), 'ICAL3012', '/components/0/series');
    assert.match(error.message, /after 2 of 5 occurrences/);
  });

  it('a start the rule does not make, with no end, keeps its open rule beside the RDATE', () => {
    const { calendar } = write([{ uid: 'o', base: { dtstart: floating('2026-03-03', '09:00'), rrule: 'FREQ=WEEKLY;BYDAY=MO' } }]);
    const [vevent] = calendar.children;
    assert.deepStrictEqual([prop(vevent, 'RRULE')?.value, props(vevent, 'RDATE').map((p) => p.value)], ['FREQ=WEEKLY;BYDAY=MO', ['20260303T090000']]);
  });

  it('a series with no occurrence to write', () => {
    const series = { uid: 's', base: { dtstart: zoned('2026-01-05', '09:00'), rrule: 'FREQ=DAILY;COUNT=3' } };
    refuses(() => write([series], { zones: 'utc', provider, horizon: [Date.parse('2027-01-01T00:00:00Z'), Date.parse('2028-01-01T00:00:00Z')] }), 'ICAL3013');
    refuses(() => write([{ uid: 'r', rdates: [floating('2026-03-02', '09:00')], exdates: [floating('2026-03-02', '09:00')] }]), 'ICAL3013');
  });

  it('a series without a rule that reaches the calendar\'s last day, where no horizon can hold it', () => {
    refuses(() => write([{ uid: 'r', rdates: [floating('9999-12-31', '09:00')] }]), 'ICAL3012', '/components/0/series');
    refuses(() => write([{ uid: 'r', rdates: [date('9999-12-31')] }]), 'ICAL3012', '/components/0/series');
    assert.ok(write([{ uid: 'r', rdates: [floating('9999-12-30', '09:00')] }]).text.includes('DTSTART:99991230T090000'));
  });

  it('two slots that resolve to one UTC instant', () => {
    // 02:30 falls in the spring gap and moves forward to 03:30, where the 03:30 slot already is
    const series = { uid: 's', base: { dtstart: zoned('2026-03-28', '02:30'), rrule: 'FREQ=DAILY;BYHOUR=2,3;BYMINUTE=30;COUNT=4' } };
    const error = refuses(() => write([series], { zones: 'utc', provider, horizon: YEAR_2026 }), 'ICAL3014', '/components/0/series');
    assert.match(error.message, /2026-03-29T02:30:00 and 2026-03-29T03:30:00 are both 20260329T013000Z/);
  });

  it('an override whose slot the series never makes, by a rule or as its occurrences', () => {
    const off = { recurrenceId: '2026-03-03T09:00:00', status: 'moved', start: floating('2026-03-03', '10:00') };
    refuses(() => write([{ uid: 's', base: { dtstart: floating('2026-03-02', '09:00'), rrule: 'FREQ=WEEKLY;COUNT=3' }, overrides: [off] }]),
      'ICAL3015', '/components/0/series/overrides');
    refuses(() => write([{ uid: 's', base: { dtstart: floating('2026-03-02', '09:00'), rrule: 'FREQ=DAILY;COUNT=3' }, overrides: [off],
      exdates: [floating('2026-03-03', '09:00')] }]), 'ICAL3015');
    refuses(() => write([{ uid: 's', base: { dtstart: zoned('2026-03-02', '09:00'), rrule: 'FREQ=WEEKLY;COUNT=3' },
      overrides: [{ ...off, start: zoned('2026-03-03', '10:00') }] }], { zones: 'utc', provider, horizon: YEAR_2026 }), 'ICAL3015');
  });

  it('an override over this and future occurrences', () => {
    refuses(() => write([{ uid: 's', base: { dtstart: floating('2026-03-02', '09:00'), rrule: 'FREQ=DAILY;COUNT=3' },
      overrides: [{ recurrenceId: '2026-03-03T09:00:00', status: 'moved', start: floating('2026-03-03', '10:00'), range: 'THISANDFUTURE' }] }]),
    'ICAL3016', '/components/0/series/overrides/0/range');
  });

  it('a period of dates, which no RDATE spells', () => {
    refuses(() => write([{ uid: 's', base: { dtstart: date('2026-03-02'), rrule: 'FREQ=DAILY;COUNT=3' },
      rdates: [{ start: date('2026-03-10'), end: date('2026-03-12') }] }]), 'ICAL3017', '/components/0/series/rdates/0');
    refuses(() => write([{ uid: 's', rdates: [date('2026-03-02'), { start: date('2026-03-10'), end: date('2026-03-12') }] }]), 'ICAL3017');
  });

  it('what the calendar layer refuses of a series, with its error as the cause', () => {
    const monthly = refuses(() => write([{ uid: 's', base: { dtstart: floating('2026-03-02', '09:00'), rrule: 'FREQ=MONTHLY;COUNT=3' } }]),
      'ICAL3005', '/components/0/series');
    assert.strictEqual(monthly.cause.code, 'JY0020');
    refuses(() => write([{ uid: 's' }]), 'ICAL3005');
    const backwards = refuses(() => write([{ uid: 's', base: { dtstart: zoned('2026-03-02', '09:00'), rrule: 'FREQ=DAILY' } }],
      { zones: 'utc', provider, horizon: [1, 0] }), 'ICAL3005', '/components/0/series');
    assert.strictEqual(backwards.cause.code, 'JY0014');
  });

  it('a recurring event names no uid, times or sequence of its own, and its series is an object', () => {
    const series = { uid: 's', base: { dtstart: floating('2026-03-02', '09:00'), rrule: 'FREQ=DAILY;COUNT=3' } };
    for (const member of ['uid', 'start', 'end', 'duration', 'sequence', 'policy']) {
      refuses(() => stringifyIcal({ prodId: 'p', components: [{ type: 'event', series, [member]: 1 }] }), 'ICAL3002', `/components/0/${member}`);
    }
    refuses(() => stringifyIcal({ prodId: 'p', components: [{ type: 'event', series: 'weekly' }] }), 'ICAL3001', '/components/0/series');
  });
});
