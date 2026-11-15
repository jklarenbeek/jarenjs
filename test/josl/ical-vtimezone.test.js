//@ts-check

/**
 * VTIMEZONE both ways: the reader compiles a file's definitions and uses
 * them for their TZIDs (RFC 5545's rule, by default), reporting where
 * they disagree with the caller's provider or do not reach; the writer's
 * `zones: 'embed'` writes each zone it uses as a VTIMEZONE of RDATE
 * onsets, so a zoned series keeps its rule and reads back to the same
 * instants.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseIcal, stringifyIcal, createIcalWriter, createIcalReader } from '@jarenjs/josl/ical';
import { CalendarError, compileRecurrence, defineSeries, expandSeries, toUtc, utcValue, zonedValue } from '@jarenjs/core/calendar';
import { createIntlZoneProvider } from '@jarenjs/locales/intl-zones';
import { oracleZone, partsOf, sweepOf, tableProvider } from '../core/calendar/oracle.js';

const provider = createIntlZoneProvider({ revision: 'test' });
const DIR = new URL('./fixtures/ical-vtimezone/', import.meta.url);
const at = (/** @type {string} */ iso) => Date.parse(iso);

/**
 * A calendar of the given lines inside the head.
 * @param {string[]} lines
 */
const cal = (lines) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//EN', ...lines, 'END:VCALENDAR', ''].join('\r\n');
/** @param {string[]} lines */
const vevent = (lines) => ['BEGIN:VEVENT', 'DTSTAMP:20260101T000000Z', ...lines, 'END:VEVENT'];
/** @param {any} report */
const codes = (report) => report.unsupported.map((/** @type {any} */ e) => e.code);
/** @param {number} n */
const rfc = (n) => fs.readFileSync(new URL(`rfc5545-vtimezone-${n}.ics`, DIR), 'utf8').trimEnd().split('\r\n');

/** New York by the rules before 2007 only, as a stale exporter still writes it. */
const STALE_NEW_YORK = ['BEGIN:VTIMEZONE', 'TZID:America/New_York',
  'BEGIN:STANDARD', 'DTSTART:19701025T020000', 'RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=10', 'TZOFFSETFROM:-0400', 'TZOFFSETTO:-0500', 'END:STANDARD',
  'BEGIN:DAYLIGHT', 'DTSTART:19700426T020000', 'RRULE:FREQ=YEARLY;BYDAY=1SU;BYMONTH=4', 'TZOFFSETFROM:-0500', 'TZOFFSETTO:-0400', 'END:DAYLIGHT',
  'END:VTIMEZONE'];

/**
 * A VTIMEZONE of a name, with observances given as [type, DTSTART, FROM, TO, RRULE?].
 * @param {string} tzid
 * @param {[string, string, string, string, string?][]} observances
 */
const vtimezone = (tzid, observances) => ['BEGIN:VTIMEZONE', `TZID:${tzid}`, ...observances.flatMap(([type, start, from, to, rule]) =>
  [`BEGIN:${type}`, `DTSTART:${start}`, `TZOFFSETFROM:${from}`, `TZOFFSETTO:${to}`, ...(rule === undefined ? [] : [`RRULE:${rule}`]), `END:${type}`]),
'END:VTIMEZONE'];

const WINTER_SUMMER = /** @type {[string, string, string, string, string?][]} */ ([
  ['STANDARD', '16011028T030000', '+0200', '+0100', 'FREQ=YEARLY;BYDAY=-1SU;BYMONTH=10'],
  ['DAYLIGHT', '16010325T020000', '+0100', '+0200', 'FREQ=YEARLY;BYDAY=-1SU;BYMONTH=3'],
]);

describe('the RFC 5545 §3.6.5 VTIMEZONE examples, vendored', () => {
  /** @param {number} n @param {object} [options] */
  const compiled = (n, options = {}) => {
    const { report, zones } = parseIcal(cal(rfc(n)), { provider, ...options });
    assert.deepStrictEqual(report.unsupported, [], `example ${n}: LAST-MODIFIED, TZURL and TZNAME change no instant and are read without report`);
    return Object.values(zones.compiled)[0];
  };
  const changes = (/** @type {any} */ zone, /** @type {number} */ from, /** @type {number} */ to) => zone.transitions
    .filter((/** @type {any} */ c) => c.at >= from && c.at < to).map(({ at: when, before, after }) => ({ at: when, before, after }));

  it('1: every New York rule since 1967 gives the 82 changes of 2000-2040 the database lists', () => {
    const zone = compiled(1);
    assert.deepStrictEqual(changes(zone, Date.UTC(2000, 0, 1), Date.UTC(2041, 0, 1)), oracleZone('America/New_York').changes);
    assert.strictEqual(zone.horizon.start, at('1967-04-30T07:00:00Z'));
    // 1974's January and 1975's February daylight time, by DTSTART and RDATE
    assert.deepStrictEqual(changes(zone, Date.UTC(1974, 0, 1), Date.UTC(1975, 2, 1)).map((c) => [new Date(c.at).toISOString(), c.after]),
      [['1974-01-06T07:00:00.000Z', -240], ['1974-10-27T06:00:00.000Z', -300], ['1975-02-23T07:00:00.000Z', -240]]);
  });

  it('2: DTSTART alone covers only from its earliest onset, as the RFC says', () => {
    const zone = compiled(2);
    assert.deepStrictEqual([zone.horizon.start, zone.initial, zone.transitions.length], [at('2007-03-11T07:00:00Z'), -240, 1]);
    assert.throws(() => zone.toParts(Date.UTC(2007, 0, 1), 'America/New_York'), (error) => error instanceof CalendarError && error.code === 'JY0024');
  });

  it('3: the current New York rules by RRULE give the database\'s changes from 2008 to 2040', () => {
    const zone = compiled(3);
    assert.deepStrictEqual(changes(zone, Date.UTC(2008, 0, 1), Date.UTC(2041, 0, 1)),
      oracleZone('America/New_York').changes.filter((c) => c.at >= Date.UTC(2008, 0, 1)));
  });

  it('4 and 5: a DAYLIGHT rule that ends, and a second one that picks up', () => {
    const ended = compiled(4);
    assert.deepStrictEqual(ended.transitions.length, 22);
    assert.strictEqual(new Date(ended.transitions[21].at).toISOString(), '1997-10-26T06:00:00.000Z');
    assert.strictEqual(ended.toParts(Date.UTC(2030, 6, 1), 'Fictitious').offset, -300);
    const resumed = compiled(5);
    assert.deepStrictEqual(changes(resumed, Date.UTC(1998, 0, 1), Date.UTC(2000, 0, 1)).map((c) => [new Date(c.at).toISOString(), c.after]),
      // the second rule's DTSTART is a Saturday (1999-04-24): DTSTART is an onset whatever the rule says, so the change is on it
      [['1999-04-24T07:00:00.000Z', -240], ['1999-10-31T06:00:00.000Z', -300]]);
  });
});

describe('ical reader: a VTIMEZONE in the file defines its TZID', () => {
  it('a prefixed or Windows name resolves through its definition, as the file says', () => {
    const tzid = '/mozilla.org/20050126_1/Europe/Amsterdam';
    const { calendar, report, zones } = parseIcal(cal([...vtimezone(tzid, WINTER_SUMMER),
      ...vevent(['UID:a', `DTSTART;TZID=${tzid}:20260706T090000`, `DTEND;TZID=${tzid}:20260706T100000`])]), { provider });
    assert.deepStrictEqual(report.unsupported, []);
    assert.strictEqual(toUtc(calendar.components[0].start, { provider: zones.provider, policy: 'rfc5545' }).instant, at('2026-07-06T07:00:00Z'));
    assert.deepStrictEqual(zones.undeclared, []);
    assert.deepStrictEqual(zones.provider.identity.name, 'vtimezone');
    // the same file, the same identity
    assert.deepStrictEqual(parseIcal(cal(vtimezone(tzid, WINTER_SUMMER)), { provider }).zones.provider.identity, zones.provider.identity);
  });

  it('vtimezone chooses the source; a disagreement for an IANA name is reported either way, never silently picked', () => {
    const text = cal([...STALE_NEW_YORK, ...vevent(['UID:a', 'DTSTART;TZID=America/New_York:20260309T090000'])]);
    const embedded = parseIcal(text, { provider });
    assert.deepStrictEqual(codes(embedded.report), ['ICAL1023']);
    assert.match(embedded.report.unsupported[0].reason, /-05:00 in the file, -04:00 by the provider\); the file's definition is used/);
    assert.strictEqual(toUtc(embedded.calendar.components[0].start, { provider: embedded.zones.provider, policy: 'rfc5545' }).instant,
      at('2026-03-09T14:00:00Z'));
    const theirs = parseIcal(text, { provider, vtimezone: 'provider' });
    assert.deepStrictEqual(codes(theirs.report), ['ICAL1023']);
    assert.match(theirs.report.unsupported[0].reason, /the provider is used/);
    assert.strictEqual(toUtc(theirs.calendar.components[0].start, { provider: theirs.zones.provider, policy: 'rfc5545' }).instant,
      at('2026-03-09T13:00:00Z'));
    assert.deepStrictEqual(Object.keys(theirs.zones.compiled), ['America/New_York']);
    assert.strictEqual(theirs.zones.provider.identity, provider.identity);
    // a recurring series runs on: a March occurrence years later is compared too
    const series = parseIcal(cal([...STALE_NEW_YORK, ...vevent(['UID:s', 'DTSTART;TZID=America/New_York:20260105T090000', 'RRULE:FREQ=WEEKLY'])]), { provider });
    assert.deepStrictEqual(codes(series.report), ['ICAL1023']);
    assert.match(series.report.unsupported[0].reason, /disagree at 2026-03-08T07:00:00\.000Z/);
    // agreement where the file uses it is no entry
    assert.deepStrictEqual(codes(parseIcal(cal([...STALE_NEW_YORK, ...vevent(['UID:a', 'DTSTART;TZID=America/New_York:20260709T090000'])]), { provider }).report), []);
  });

  it('under vtimezone: \'provider\' a name only the file defines is withheld, as before', () => {
    const { calendar, report } = parseIcal(cal([...vtimezone('Custom', WINTER_SUMMER), ...vevent(['UID:a', 'DTSTART;TZID=Custom:20260706T090000'])]),
      { provider, vtimezone: 'provider' });
    assert.deepStrictEqual([calendar.components, codes(report)], [[], ['ICAL1019']]);
  });

  it('a value outside what the definition covers: the provider answers an IANA name, anything else refuses when resolved', () => {
    const horizon = [utcValue('2026-01-01T00:00:00Z'), utcValue('2027-01-01T00:00:00Z')];
    const iana = parseIcal(cal([...vtimezone('Europe/Amsterdam', WINTER_SUMMER), ...vevent(['UID:a', 'DTSTART;TZID=Europe/Amsterdam:20280706T090000'])]),
      { provider, zoneHorizon: horizon });
    assert.deepStrictEqual(codes(iana.report), ['ICAL1024']);
    assert.match(iana.report.unsupported[0].reason, /the provider answers there/);
    assert.strictEqual(toUtc(iana.calendar.components[0].start, { provider: iana.zones.provider, policy: 'rfc5545' }).instant, at('2028-07-06T07:00:00Z'));
    const own = parseIcal(cal([...vtimezone('Custom', WINTER_SUMMER), ...vevent(['UID:a', 'DTSTART;TZID=Custom:20280706T090000'])]),
      { provider, zoneHorizon: horizon });
    assert.deepStrictEqual(codes(own.report), ['ICAL1024']);
    assert.match(own.report.unsupported[0].reason, /refused when resolved/);
    assert.throws(() => toUtc(own.calendar.components[0].start, { provider: own.zones.provider, policy: 'rfc5545' }),
      (error) => error instanceof CalendarError && error.code === 'JY0024');
  });

  it('a TZID used but not defined resolves through the provider and is listed, not refused, under strict too', () => {
    const text = cal(vevent(['UID:a', 'DTSTART;TZID=Europe/Amsterdam:20260706T090000']));
    const { report, zones } = parseIcal(text, { provider, strict: true });
    assert.deepStrictEqual([report.unsupported, zones.undeclared, zones.compiled], [[], ['Europe/Amsterdam'], {}]);
    assert.strictEqual(zones.provider.identity, provider.identity);
  });

  it('a definition read after its first use cannot define a name no provider knows', () => {
    const { calendar, report } = parseIcal(cal([...vevent(['UID:a', 'DTSTART;TZID=Custom Zone:20260706T090000']), ...vtimezone('Custom Zone', WINTER_SUMMER)]),
      { provider });
    assert.deepStrictEqual([calendar.components, codes(report)], [[], ['ICAL1019']]);
    assert.match(report.unsupported[0].reason, /no VTIMEZONE read before it defines it/);
  });

  it('the provider is live while the input is fed', () => {
    const reader = createIcalReader({ provider });
    // END:VTIMEZONE is whole once the octet after its line break is read
    reader.feed(cal(vtimezone('Custom', WINTER_SUMMER)).replace('ND:VCALENDAR\r\n', ''));
    assert.strictEqual(reader.provider.toParts(Date.UTC(2026, 6, 1), 'Custom').offset, 120);
    assert.strictEqual(reader.provider.toParts(Date.UTC(2026, 6, 1), 'Europe/Lisbon').offset, 60);
    reader.feed('ND:VCALENDAR\r\n');
    assert.deepStrictEqual(Object.keys(reader.end().zones.compiled), ['Custom']);
    const alone = parseIcal(cal(vtimezone('Custom', WINTER_SUMMER)));
    assert.throws(() => alone.zones.provider.toParts(0, 'Europe/Lisbon'), TypeError);
    assert.throws(() => alone.zones.provider.candidates({ year: 2026, month: 1, day: 1 }, 'Europe/Lisbon'), TypeError);
    assert.strictEqual(alone.zones.provider.toEpoch({ year: 2026, month: 7, day: 1 }, 'Custom', 'reject'), Date.UTC(2026, 5, 30, 22));
    const noCandidates = parseIcal(cal([]), { provider: { toParts: provider.toParts, toEpoch: provider.toEpoch } });
    assert.throws(() => noCandidates.zones.provider.candidates({ year: 2026, month: 1, day: 1 }, 'Europe/Lisbon'), /no candidates/);
  });

  it('refuses mistyped zone options', () => {
    for (const options of [{ vtimezone: 'file' }, { zoneHorizon: [0] }, { zoneLimits: [] }])
      assert.throws(() => parseIcal(cal([]), /** @type {any} */ (options)), TypeError, JSON.stringify(options));
  });
});

describe('ical reader: adversarial VTIMEZONEs are reported, and their TZID resolves as an undefined one does', () => {
  /** @param {string[]} zone @param {string} tzid @param {object} [options] */
  const readWith = (zone, tzid, options = {}) => parseIcal(cal([...zone, ...vevent(['UID:a', `DTSTART;TZID=${tzid}:20260706T090000`])]), { provider, ...options });

  it('no observance: reported; an IANA name falls back to the provider, another is withheld', () => {
    const iana = readWith(['BEGIN:VTIMEZONE', 'TZID:Europe/Amsterdam', 'END:VTIMEZONE'], 'Europe/Amsterdam');
    assert.deepStrictEqual(codes(iana.report), ['ICAL1014']);
    assert.strictEqual(iana.report.unsupported[0].cause?.code, 'JY0022');
    assert.strictEqual(toUtc(iana.calendar.components[0].start, { provider: iana.zones.provider, policy: 'rfc5545' }).instant, at('2026-07-06T07:00:00Z'));
    const own = readWith(['BEGIN:VTIMEZONE', 'TZID:Custom', 'END:VTIMEZONE'], 'Custom');
    assert.deepStrictEqual(codes(own.report), ['ICAL1014', 'ICAL1019']);
  });

  it('overlapping observances, a second VTIMEZONE of a TZID, and a hostile observance count', () => {
    const overlap = readWith(vtimezone('Custom', [['DAYLIGHT', '20260329T020000', '+0100', '+0200'], ['DAYLIGHT', '20260329T020000', '+0100', '+0300']]), 'Custom');
    assert.deepStrictEqual([codes(overlap.report), overlap.report.unsupported[0].cause?.code], [['ICAL1014', 'ICAL1019'], 'JY0023']);
    const twice = readWith([...vtimezone('Custom', WINTER_SUMMER), ...vtimezone('Custom', [['STANDARD', '20000101T000000', '+0500', '+0500']])], 'Custom');
    assert.deepStrictEqual(codes(twice.report), ['ICAL1014']);
    assert.match(twice.report.unsupported[0].reason, /a second VTIMEZONE of the TZID 'Custom'; the first is kept/);
    assert.strictEqual(toUtc(twice.calendar.components[0].start, { provider: twice.zones.provider, policy: 'rfc5545' }).instant, at('2026-07-06T07:00:00Z'));
    const many = readWith(vtimezone('Custom', WINTER_SUMMER), 'Custom', { zoneLimits: { maxObservances: 1 } });
    assert.deepStrictEqual([codes(many.report), many.report.unsupported[0].cause?.code], [['ICAL1014', 'ICAL1019'], 'JY0025']);
    const stopped = readWith(vtimezone('Custom', WINTER_SUMMER), 'Custom', { zoneLimits: { maxTransitions: 50 } });
    assert.deepStrictEqual(codes(stopped.report), ['ICAL1014', 'ICAL1024']);
    assert.match(stopped.report.unsupported[0].reason, /stopped at maxTransitions/);
    assert.throws(() => toUtc(stopped.calendar.components[0].start, { provider: stopped.zones.provider, policy: 'rfc5545' }),
      (error) => error instanceof CalendarError && error.code === 'JY0024');
  });

  it('under strict an entry inside a VTIMEZONE refuses with its own code, not as an unreadable VTIMEZONE', () => {
    assert.throws(() => parseIcal(cal(['BEGIN:VTIMEZONE', 'TZID:Custom', 'X-LIC-LOCATION:Custom', 'END:VTIMEZONE']), { provider, strict: true }),
      (/** @type {any} */ error) => error.code === 'ICAL1011');
    assert.throws(() => parseIcal(cal(['BEGIN:VTIMEZONE', 'TZID:Custom', 'END:VTIMEZONE']), { provider, strict: true }),
      (/** @type {any} */ error) => error.code === 'ICAL1014');
  });

  it('what the mapping cannot read is ICAL1014; what changes no instant is reported as everywhere else', () => {
    const unreadable = [
      [['BEGIN:VTIMEZONE', 'BEGIN:STANDARD', 'DTSTART:20000101T000000', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0100', 'END:STANDARD', 'END:VTIMEZONE'], /names its TZID/],
      [['BEGIN:VTIMEZONE', 'TZID:Custom', 'TZID:Other', 'END:VTIMEZONE'], /TZID once/],
      [vtimezone('Custom', [['STANDARD', '20000101', '+0100', '+0100']]), /is a DATE-TIME/],
      [vtimezone('Custom', [['STANDARD', '20000101T000000', '+1', '+0100']]), /UTC offset/],
      [['BEGIN:VTIMEZONE', 'TZID:Custom', 'BEGIN:STANDARD', 'DTSTART:20000101T000000', 'TZOFFSETFROM:+0100', 'END:STANDARD', 'END:VTIMEZONE'], /has a TZOFFSETTO/],
      [['BEGIN:VTIMEZONE', 'TZID:Custom', 'BEGIN:STANDARD', 'DTSTART:20000101T000000', 'DTSTART:20010101T000000', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0100',
        'END:STANDARD', 'END:VTIMEZONE'], /DTSTART once/],
      [['BEGIN:VTIMEZONE', 'TZID:Custom', 'BEGIN:STANDARD', 'DTSTART;VALUE=DATE:20000101', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0100',
        'END:STANDARD', 'END:VTIMEZONE'], /VALUE=DATE/],
      [['BEGIN:VTIMEZONE', 'TZID:Cus\\xtom', 'END:VTIMEZONE'], /escape/],
    ];
    for (const [zone, reason] of unreadable) {
      const { report } = parseIcal(cal(/** @type {string[]} */ (zone)), { provider });
      assert.deepStrictEqual(codes(report), ['ICAL1014'], String(reason));
      assert.match(report.unsupported[0].reason, /** @type {RegExp} */ (reason));
    }
    const { report, zones } = parseIcal(cal(['BEGIN:VTIMEZONE', 'TZID:Cus\\,tom', 'X-LIC-LOCATION:Custom', 'TZUNTIL:20300101T000000Z',
      'BEGIN:STANDARD', 'DTSTART;VALUE=DATE-TIME:20000101T000000', 'TZOFFSETFROM;X-P=1:+0100', 'TZOFFSETTO:+0100', 'TZNAME:CET', 'TZNAME:MEZ',
      'COMMENT:read', 'X-ONE:1', 'RDATE:20100101T000000,20110101T000000', 'BEGIN:X-PART', 'END:X-PART', 'END:STANDARD',
      'BEGIN:X-ZONE', 'END:X-ZONE', 'END:VTIMEZONE']), { provider });
    assert.deepStrictEqual(report.unsupported.map((e) => `${e.code} ${e.name}`),
      ['ICAL1011 X-LIC-LOCATION', 'ICAL1013 X-PART', 'ICAL1012 TZOFFSETFROM;X-P', 'ICAL1011 X-ONE', 'ICAL1013 X-ZONE']);
    assert.deepStrictEqual(Object.keys(zones.compiled), ['Cus,tom']);
    assert.strictEqual(zones.compiled['Cus,tom'].horizon.end, Date.UTC(2030, 0, 1));
  });
});

describe('ical writer: zones: \'embed\'', () => {
  const horizon = /** @type {[unknown, unknown]} */ ([utcValue('2026-01-01T00:00:00Z'), utcValue('2028-01-01T00:00:00Z')]);
  const options = { zones: /** @type {const} */ ('embed'), provider, horizon };
  const HORIZON_UTC = /** @type {[any, any]} */ ([utcValue('2026-01-01T00:00:00Z'), utcValue('2028-01-01T00:00:00Z')]);
  /** @param {any} series @param {any} zoneProvider */
  const instants = (series, zoneProvider) => expandSeries(series, { horizon: HORIZON_UTC, provider: zoneProvider }).occurrences
    .map((o) => [o.recurrenceId, o.instants?.start, o.instants?.end]);

  it('writes a TZID and, before the first component that uses a zone, its VTIMEZONE once', () => {
    const text = stringifyIcal({ prodId: '-//t//EN', components: [
      { type: 'event', uid: 'a', dtstamp: 0, start: zonedValue('2026-07-06', '09:00:00', 'Europe/Amsterdam'), duration: 'P1D', policy: 'rfc5545' },
      { type: 'event', uid: 'b', dtstamp: 0, start: zonedValue('2026-07-07', '09:00:00', 'Europe/Amsterdam'),
        end: zonedValue('2026-07-07', '10:00:00', 'Europe/Amsterdam'), policy: 'rfc5545' },
    ] }, options);
    assert.deepStrictEqual(text.split('\r\n'), ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//t//EN',
      // two days either side of the horizon, so a time at its edge reads back
      'BEGIN:VTIMEZONE', 'TZID:Europe/Amsterdam', 'TZUNTIL:20280103T000000Z',
      'BEGIN:STANDARD', 'DTSTART:20251230T010000', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0100', 'END:STANDARD',
      'BEGIN:DAYLIGHT', 'DTSTART:20260329T020000', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0200', 'RDATE:20270328T020000', 'END:DAYLIGHT',
      'BEGIN:STANDARD', 'DTSTART:20261025T030000', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'RDATE:20271031T030000', 'END:STANDARD',
      'END:VTIMEZONE',
      'BEGIN:VEVENT', 'UID:a', 'DTSTAMP:19700101T000000Z', 'DTSTART;TZID=Europe/Amsterdam:20260706T090000', 'DURATION:P1D', 'END:VEVENT',
      'BEGIN:VEVENT', 'UID:b', 'DTSTAMP:19700101T000000Z', 'DTSTART;TZID=Europe/Amsterdam:20260707T090000',
      'DTEND;TZID=Europe/Amsterdam:20260707T100000', 'END:VEVENT', 'END:VCALENDAR', '']);
    // under zones: 'utc' the same event is its instant, with no VTIMEZONE
    const utc = stringifyIcal({ prodId: '-//t//EN', components: [{ type: 'event', uid: 'a', dtstamp: 0,
      start: zonedValue('2026-07-06', '09:00:00', 'Europe/Amsterdam'), policy: 'rfc5545' }] }, { ...options, zones: 'utc' });
    assert.ok(!utc.includes('VTIMEZONE') && utc.includes('DTSTART:20260706T070000Z'));
  });

  it('a time at either edge of the horizon reads back through the written definition alone', () => {
    const custom = tableProvider('Edge/Zone', { initial: 60, changes: [{ at: Date.UTC(2027, 5, 1), before: 60, after: 120 }] });
    const text = stringifyIcal({ prodId: 'p', components: [
      { type: 'event', uid: 'first', dtstamp: 0, start: zonedValue('2026-01-01', '01:00:00', 'Edge/Zone'), policy: 'rfc5545' },
      { type: 'event', uid: 'last', dtstamp: 0, start: zonedValue('2028-01-01', '00:30:00', 'Edge/Zone'), policy: 'rfc5545' },
    ] }, { ...options, provider: custom });
    const { calendar, report, zones } = parseIcal(text, { strict: true });
    assert.deepStrictEqual(report.unsupported, []);
    assert.deepStrictEqual(calendar.components.map((c) => toUtc(c.start, { provider: zones.provider, policy: 'rfc5545' }).instant),
      [at('2026-01-01T00:00:00Z'), at('2027-12-31T22:30:00Z')]);
  });

  it('streams each VTIMEZONE in the chunk of the first component that uses its zone', () => {
    /** @type {string[]} */
    const chunks = [];
    const writer = createIcalWriter({ prodId: 'p', onChunk: (chunk) => chunks.push(chunk), ...options });
    writer.write({ type: 'event', uid: 'u', dtstamp: 0, start: utcValue('2026-07-06T07:00:00Z') });
    writer.write({ type: 'event', uid: 'a', dtstamp: 0, start: zonedValue('2026-07-06', '09:00:00', 'Europe/Amsterdam'), policy: 'rfc5545' });
    writer.write({ type: 'event', uid: 'b', dtstamp: 0, start: zonedValue('2026-07-06', '09:00:00', 'Europe/Amsterdam'), policy: 'rfc5545' });
    writer.end();
    assert.deepStrictEqual(chunks.map((chunk) => (chunk.match(/BEGIN:VTIMEZONE/g) ?? []).length), [0, 0, 1, 0, 0]);
    assert.ok(chunks[2].indexOf('END:VTIMEZONE') < chunks[2].indexOf('BEGIN:VEVENT'));
  });

  for (const zone of ['America/New_York', 'Europe/Amsterdam', 'Australia/Lord_Howe', 'Pacific/Apia', 'UTC']) {
    it(`${zone}: a weekly series keeps its rule, and reads back to the provider's occurrences and instants over the horizon`, () => {
      const series = defineSeries({ uid: 's', base: compileRecurrence({ dtstart: zonedValue('2026-01-04', '02:30:00', zone), duration: 'PT1H',
        rrule: 'FREQ=WEEKLY;BYDAY=SU' }), exdates: [zonedValue('2026-01-11', '02:30:00', zone)],
      overrides: [{ recurrenceId: '2026-01-18T02:30:00', status: 'moved', start: zonedValue('2026-01-18', '04:00:00', zone) }] });
      const text = stringifyIcal({ prodId: 'p', components: [{ type: 'event', series, dtstamp: 0 }] }, options);
      assert.match(text, new RegExp(`DTSTART;TZID=${zone}:20260104T023000\r\nDURATION:PT1H\r\nRRULE:FREQ=WEEKLY;BYDAY=SU\r\n`));
      const { calendar, report, zones } = parseIcal(text, { provider });
      assert.deepStrictEqual(report.unsupported, []);
      assert.deepStrictEqual(instants(calendar.components[0].series, zones.provider), instants(series, provider));
      // and the compiled definition answers as the provider does on every swept change inside the horizon
      const compiled = zones.compiled[zone];
      for (const { wall } of sweepOf(zone).filter(({ wall: w }) => w > Date.UTC(2026, 0, 3) && w < Date.UTC(2027, 11, 30)))
        assert.deepStrictEqual(compiled.candidates(partsOf(wall), zone), provider.candidates(partsOf(wall), zone), new Date(wall).toISOString());
    });
  }

  it('a rule that does not make its own start: COUNT becomes a UTC UNTIL and the start an RDATE with its TZID', () => {
    const series = defineSeries({ uid: 's', base: compileRecurrence({ dtstart: zonedValue('2026-03-03', '09:00:00', 'America/New_York'),
      rrule: 'FREQ=WEEKLY;BYDAY=MO;COUNT=3' }) });
    const text = stringifyIcal({ prodId: 'p', components: [{ type: 'event', series, dtstamp: 0 }] }, options);
    assert.match(text, /RRULE:FREQ=WEEKLY;UNTIL=20260316T130000Z;BYDAY=MO\r\nRDATE;TZID=America\/New_York:20260303T090000\r\n/);
    const read = parseIcal(text, { provider });
    assert.deepStrictEqual(instants(read.calendar.components[0].series, read.zones.provider), instants(series, provider));
    const until = defineSeries({ uid: 'u', base: compileRecurrence({ dtstart: zonedValue('2026-03-03', '09:00:00', 'America/New_York'),
      rrule: { FREQ: 'WEEKLY', BYDAY: ['MO'], UNTIL: utcValue('2026-03-16T13:00:00Z') } }) });
    assert.match(stringifyIcal({ prodId: 'p', components: [{ type: 'event', series: until, dtstamp: 0 }] }, options),
      /RRULE:FREQ=WEEKLY;UNTIL=20260316T130000Z;BYDAY=MO\r\n/);
  });

  it('a fold time under later is its instant; a gap under later is the RFC\'s instant too; a series under later is written by its occurrences', () => {
    const fold = zonedValue('2026-10-25', '02:30:00', 'Europe/Amsterdam');
    const gap = zonedValue('2026-03-29', '02:30:00', 'Europe/Amsterdam');
    const text = stringifyIcal({ prodId: 'p', components: [{ type: 'event', uid: 'f', dtstamp: 0, start: fold, policy: 'later' },
      { type: 'event', uid: 'r', dtstamp: 0, start: fold, policy: 'rfc5545' }, { type: 'event', uid: 'g', dtstamp: 0, start: gap, policy: 'later' }] }, options);
    assert.match(text, /UID:f\r\nDTSTAMP:19700101T000000Z\r\nDTSTART:20261025T013000Z\r\n/);
    assert.match(text, /UID:r\r\nDTSTAMP:19700101T000000Z\r\nDTSTART;TZID=Europe\/Amsterdam:20261025T023000\r\n/);
    assert.match(text, /UID:g\r\nDTSTAMP:19700101T000000Z\r\nDTSTART;TZID=Europe\/Amsterdam:20260329T023000\r\n/);
    const back = parseIcal(text, { provider });
    assert.deepStrictEqual(back.calendar.components.map((c) => (c.start.kind === 'utc' ? Date.parse(c.start.instant)
      : toUtc(c.start, { provider: back.zones.provider, policy: 'rfc5545' }).instant)),
    [at('2026-10-25T01:30:00Z'), at('2026-10-25T00:30:00Z'), at('2026-03-29T01:30:00Z')]);
    const later = defineSeries({ uid: 'l', base: compileRecurrence({ dtstart: zonedValue('2026-03-22', '02:30:00', 'Europe/Amsterdam'),
      rrule: 'FREQ=WEEKLY;COUNT=3', policy: 'later' }) });
    const written = stringifyIcal({ prodId: 'p', components: [{ type: 'event', series: later, dtstamp: 0 }] }, options);
    assert.ok(!written.includes('RRULE') && written.includes('DTSTART:20260322T013000Z'));
  });

  it('a zone name with a comma is a quoted TZID, and reads back through its own definition', () => {
    const table = { initial: 60, changes: [{ at: Date.UTC(2026, 5, 1), before: 60, after: 120 }] };
    const custom = tableProvider('Test,Zone', table);
    const text = stringifyIcal({ prodId: 'p', components: [{ type: 'event', uid: 'q', dtstamp: 0,
      start: zonedValue('2026-07-01', '09:00:00', 'Test,Zone'), policy: 'rfc5545' }] }, { ...options, provider: custom });
    assert.match(text, /TZID:Test\\,Zone\r\n/);
    assert.match(text, /DTSTART;TZID="Test,Zone":20260701T090000\r\n/);
    const { calendar, zones, report } = parseIcal(text);
    assert.deepStrictEqual(report.unsupported, []);
    assert.strictEqual(toUtc(calendar.components[0].start, { provider: zones.provider, policy: 'rfc5545' }).instant, at('2026-07-01T07:00:00Z'));
  });

  it('refuses no horizon, a time outside it, and a zone the provider cannot write', () => {
    const start = zonedValue('2026-07-06', '09:00:00', 'Europe/Amsterdam');
    /** @param {unknown} components @param {object} opts @param {string} code @param {string} path */
    const refuses = (components, opts, code, path) => assert.throws(() => stringifyIcal({ prodId: 'p', components: /** @type {any} */ (components) }, opts),
      (/** @type {any} */ error) => error.code === code && error.docPath === path, code);
    refuses([{ type: 'event', uid: 'a', start, policy: 'rfc5545' }], { zones: 'embed', provider }, 'ICAL3019', '/components/0/start');
    refuses([{ type: 'event', uid: 'a', start: zonedValue('2029-07-06', '09:00:00', 'Europe/Amsterdam'), policy: 'rfc5545' }], options, 'ICAL3020', '/components/0/start');
    const blind = { toParts: () => { throw new TypeError('no zone data'); }, toEpoch: provider.toEpoch, candidates: provider.candidates };
    refuses([{ type: 'event', uid: 'a', start, policy: 'rfc5545' }], { ...options, provider: blind }, 'ICAL3005', '/components/0');
    refuses([{ type: 'event', uid: 'a', start: zonedValue('2026-07-06', '09:00:00', 'Bad"Zone'), policy: 'rfc5545' }],
      { ...options, provider: tableProvider('Bad"Zone', { initial: 0, changes: [] }) }, 'ICAL3003', '/components/0/start');
  });
});
