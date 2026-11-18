//@ts-check

/**
 * VAVAILABILITY (RFC 7953) read into availability layers: each RFC
 * example, evaluated by `evaluateAvailability`, answers the spans derived
 * by hand from its data (fixtures/ical-availability/expected.json, never
 * from this code), and written, read back and evaluated again answers the
 * same. What a layer cannot hold is withheld (`ICAL1025`).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';

import { availabilityLayers, parseIcal, stringifyIcal } from '@jarenjs/josl/ical';
import { evaluateAvailability } from '@jarenjs/core/calendar';
import { createIntlZoneProvider } from '@jarenjs/locales/intl-zones';
import expected from './fixtures/ical-availability/expected.json' with { type: 'json' };

const provider = createIntlZoneProvider({ revision: 'availability' });
const FIXTURES = new URL('./fixtures/ical-availability/', import.meta.url);
const text = (/** @type {string} */ name) => fs.readFileSync(new URL(name, FIXTURES), 'utf8');
const iso = (/** @type {number} */ at) => new Date(at).toISOString().replace('.000Z', 'Z');
const OUTSIDE = { id: 'outside', priority: 0, mode: 'available', spans: [{}], source: 'request' };

/**
 * The spans an evaluation answers, in the fixture's form.
 * @param {string} source
 * @param {string[]} horizon
 * @param {any[]} [extra]
 */
function spans(source, horizon, extra = []) {
  const { calendar, report, zones } = parseIcal(source, { provider });
  assert.deepStrictEqual(report.unsupported.filter((entry) => entry.withheld), []);
  const answer = evaluateAvailability([...availabilityLayers(calendar.components), ...extra],
    { horizon: horizon.map(Date.parse), provider: zones.provider, policy: 'rfc5545' });
  assert.strictEqual(answer.complete, true);
  return answer.spans.map((span) => [iso(span.start), iso(span.end), span.state, span.busyType ?? null, span.sources.map((s) => s.id)]);
}

describe('ical VAVAILABILITY: the RFC 7953 examples answer the spans their data defines', () => {
  for (const testCase of /** @type {any[]} */ (expected.cases)) {
    it(testCase.name, () => {
      assert.deepStrictEqual(spans(text(testCase.file), testCase.horizon), testCase.spans);
      if (testCase.outside !== undefined) {
        // time no VAVAILABILITY claims turns free; the open layer is named beside each free one, at the lowest rank only
        const turned = testCase.spans.map((/** @type {any[]} */ span) => testCase.outside.find((/** @type {any[]} */ o) => o[0] === span[0])
          ?? (span[2] === 'available' && testCase.lowest ? [...span.slice(0, 4), [...span[4], 'outside']] : span));
        assert.deepStrictEqual(spans(text(testCase.file), testCase.horizon, [OUTSIDE]), turned);
      }
      if (testCase.events !== undefined) {
        const events = testCase.events.map((/** @type {any[]} */ [id, start, end]) => ({ id, priority: 1, mode: 'busy', busyType: 'busy',
          spans: [{ start: Date.parse(start), end: Date.parse(end) }], source: 'events' }));
        assert.deepStrictEqual(spans(text(testCase.file), testCase.horizon, events), testCase.withEvents);
      }
    });
  }
});

describe('ical VAVAILABILITY: written and read back, it answers the same spans', () => {
  for (const testCase of /** @type {any[]} */ (expected.cases)) {
    it(testCase.name, () => {
      const { calendar } = parseIcal(text(testCase.file), { provider });
      const out = stringifyIcal(calendar, { zones: 'embed', provider, horizon: [Date.parse('2011-09-01T00:00:00Z'), Date.parse('2012-01-01T00:00:00Z')] });
      assert.match(out, /BEGIN:VAVAILABILITY\r\n/);
      assert.match(out, /BEGIN:VTIMEZONE\r\nTZID:America\/Montreal\r\n/);
      assert.deepStrictEqual(spans(out, testCase.horizon), testCase.spans);
    });
  }
});

describe('ical VAVAILABILITY: the model', () => {
  it('reads its period, priority and text, and each AVAILABLE as a series with its own text', () => {
    const { calendar, report } = parseIcal(text('rfc7953-appendix-b.ics'), { provider });
    // ORGANIZER is outside the subset, reported and left out
    assert.deepStrictEqual(report.unsupported.map((entry) => `${entry.code} ${entry.name}`), ['ICAL1011 ORGANIZER', 'ICAL1011 ORGANIZER']);
    const [, base, denver] = /** @type {any[]} */ (calendar.components);
    assert.deepStrictEqual([base.type, base.uid, base.start, base.end, base.priority], ['availability', '627A87FA-E5F1-43C0-B3B1-567DA10F2A83',
      { kind: 'zoned', date: '2011-10-02', time: '00:00:00', zone: 'America/Montreal' }, undefined, undefined]);
    assert.deepStrictEqual([denver.priority, denver.available.length, denver.available[0].location, denver.available[0].series.base.rrule.FREQ],
      [1, 1, 'Denver', 'WEEKLY']);
    assert.deepStrictEqual(availabilityLayers(calendar.components).map((layer) => [layer.id, layer.priority, layer.mode, layer.bounds?.length]),
      [['627A87FA-E5F1-43C0-B3B1-567DA10F2A83', 0, 'available', 2], ['F01411E3-38B8-4490-8A1F-0CCEC57A0943', 1, 'available', 2]]);
  });

  const wrap = (/** @type {string[]} */ lines) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:p', 'BEGIN:VAVAILABILITY', 'UID:v', 'DTSTAMP:20260101T000000Z',
    ...lines, 'END:VAVAILABILITY', 'END:VCALENDAR', ''].join('\r\n');
  const available = (/** @type {string[]} */ lines) => ['BEGIN:AVAILABLE', 'UID:a', 'DTSTAMP:20260101T000000Z', ...lines, 'END:AVAILABLE'];

  it('reads a DURATION, an override AVAILABLE, an EXDATE and an RDATE, and writes them back', () => {
    const source = wrap(['DTSTART:20260302T000000Z', 'DURATION:P7D', 'PRIORITY:3', 'BUSYTYPE:BUSY-UNAVAILABLE',
      ...available(['DTSTART:20260302T090000Z', 'DURATION:PT8H', 'RRULE:FREQ=DAILY;COUNT=5', 'EXDATE:20260304T090000Z', 'RDATE:20260307T100000Z']),
      ...available(['RECURRENCE-ID:20260303T090000Z', 'DTSTART:20260303T120000Z', 'DURATION:PT2H'])]);
    const horizon = ['2026-03-01T00:00:00Z', '2026-03-10T00:00:00Z'];
    const free = spans(source, horizon).filter((span) => span[2] === 'available').map((span) => `${span[0]}/${span[1]}`);
    assert.deepStrictEqual(free, ['2026-03-02T09:00:00Z/2026-03-02T17:00:00Z', '2026-03-03T12:00:00Z/2026-03-03T14:00:00Z',
      '2026-03-05T09:00:00Z/2026-03-05T17:00:00Z', '2026-03-06T09:00:00Z/2026-03-06T17:00:00Z', '2026-03-07T10:00:00Z/2026-03-07T18:00:00Z']);
    const [component] = /** @type {any[]} */ (parseIcal(source, { provider }).calendar.components);
    assert.deepStrictEqual([component.end, component.priority, component.busyType], [{ kind: 'utc', instant: '2026-03-09T00:00:00Z' }, 3, 'busy-unavailable']);
    const out = stringifyIcal({ prodId: 'p', components: [component] });
    assert.ok(out.includes('PRIORITY:3\r\nBUSYTYPE:BUSY-UNAVAILABLE\r\n'), out);
    assert.deepStrictEqual(spans(out, horizon), spans(source, horizon));
    // outside its week, unknown; a component with no AVAILABLE is busy-unavailable over its whole period
    const none = spans(wrap(['DTSTART:20260302T000000Z', 'DTEND:20260303T000000Z']), horizon);
    assert.deepStrictEqual(none.map((span) => span.slice(2, 4)), [['unknown', null], ['busy', 'busy-unavailable'], ['unknown', null]]);
  });

  it('gives equal priorities\' overlap to busy, where an AVAILABLE of one meets the other\'s busy time (RFC 7953 §4 leaves it to their creator)', () => {
    const two = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:p',
      'BEGIN:VAVAILABILITY', 'UID:x', 'DTSTART:20260302T000000Z', 'DTEND:20260303T000000Z', ...available(['DTSTART:20260302T090000Z', 'DTEND:20260302T170000Z']), 'END:VAVAILABILITY',
      'BEGIN:VAVAILABILITY', 'UID:y', 'DTSTART:20260302T120000Z', 'DTEND:20260304T000000Z', 'END:VAVAILABILITY', 'END:VCALENDAR', ''].join('\r\n');
    assert.deepStrictEqual(spans(two, ['2026-03-02T00:00:00Z', '2026-03-03T00:00:00Z']).map((span) => `${span[0].slice(11, 16)} ${span[2]} ${span[4]}`),
      ['00:00 busy x', '09:00 available x', '12:00 busy y', '17:00 busy x,y']);
  });

  it('withholds what a layer cannot hold as the RFC reads it (ICAL1025), and a time that is not UTC or zoned (ICAL1018)', () => {
    for (const [lines, code] of /** @type {[string[], string][]} */ ([
      [['BUSYTYPE:BUSY'], 'ICAL1025'], [['BUSYTYPE:BUSY-TENTATIVE'], 'ICAL1025'],
      [[...available(['DTSTART:20260302T090000Z', 'DTEND:20260302T100000Z']), 'BEGIN:AVAILABLE', 'UID:b', 'DTSTART;TZID=Europe/Amsterdam:20260302T090000', 'END:AVAILABLE'], 'ICAL1025'],
      [['DTSTART:20260302T000000'], 'ICAL1018'], [[...available(['DTSTART;VALUE=DATE:20260302'])], 'ICAL1018'], [['PRIORITY:10'], 'ICAL1018'],
      [['DURATION:PT1H'], 'ICAL1017'], [[...available(['RECURRENCE-ID:20260302T090000Z', 'DTSTART:20260302T100000Z'])], 'ICAL1021'],
    ])) {
      const { calendar, report } = parseIcal(wrap(lines), { provider });
      assert.deepStrictEqual([calendar.components.length, report.unsupported.map((entry) => entry.code)], [0, [code]], lines.join(' '));
      assert.throws(() => parseIcal(wrap(lines), { provider, strict: true }), { code });
    }
  });

  it('under zones: \'utc\' writes a zoned recurring AVAILABLE only where the horizon holds its period (ICAL3022)', () => {
    const { calendar } = parseIcal(text('rfc7953-3.1-example-2.ics'), { provider });
    const horizon = [Date.parse('2011-09-01T00:00:00Z'), Date.parse('2012-01-01T00:00:00Z')];
    const out = stringifyIcal(calendar, { zones: 'utc', provider, horizon });
    assert.ok(!out.includes('RRULE'));
    for (const testCase of /** @type {any[]} */ (expected.cases).filter((c) => c.file === 'rfc7953-3.1-example-2.ics'))
      assert.deepStrictEqual(spans(out, testCase.horizon), testCase.spans, testCase.name);
    // example 1 has no end: no horizon holds it
    const open = parseIcal(text('rfc7953-3.1-example-1.ics'), { provider }).calendar;
    assert.throws(() => stringifyIcal(open, { zones: 'utc', provider, horizon }), { code: 'ICAL3022', docPath: '/components/0/available/0/series' });
    assert.throws(() => stringifyIcal(calendar, { zones: 'utc', provider, horizon: [horizon[0], Date.parse('2011-12-01T00:00:00Z')] }), { code: 'ICAL3022' });
  });

  it('refuses to write what it cannot spell', () => {
    const write = (/** @type {Record<string, any>} */ component) => stringifyIcal({ prodId: 'p', components: [{ type: 'availability', uid: 'v', available: [], ...component }] });
    assert.throws(() => write({ busyType: 'busy' }), { code: 'ICAL3003', docPath: '/components/0/busyType' });
    assert.throws(() => write({ priority: 10 }), { code: 'ICAL3003', docPath: '/components/0/priority' });
    assert.throws(() => write({ start: { kind: 'floating', date: '2026-03-02', time: '09:00' } }), { code: 'ICAL3003', docPath: '/components/0/start' });
    assert.throws(() => write({ available: undefined }), { code: 'ICAL3001', docPath: '/components/0/available' });
    assert.throws(() => write({ colour: 'red' }), { code: 'ICAL3002' });
  });
});
