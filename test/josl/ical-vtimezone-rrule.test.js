//@ts-check

/**
 * `onsets: 'rrule'`: a VTIMEZONE written under `zones: 'embed'` with
 * RRULE observances (RFC 5545 §3.6.5) where a zone's onsets follow a
 * yearly rule, RDATEs elsewhere. Proof: the written VTIMEZONE, read back
 * through the file alone (no provider), answers the offsets the writing
 * provider answers at every change of the zdump transition oracle
 * (test/core/calendar/fixtures/zone-transitions) inside the horizon, a
 * second either side of it and halfway to the next; and it is never
 * longer than the RDATE form.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { parseIcal, stringifyIcal } from '@jarenjs/josl/ical';
import { createIntlZoneProvider } from '@jarenjs/locales/intl-zones';
import transitions from '../core/calendar/fixtures/zone-transitions/transitions.json' with { type: 'json' };

const provider = createIntlZoneProvider({ revision: 'rrule' });
const HORIZON = /** @type {[number, number]} */ ([Date.parse('2000-01-01T00:00:00Z'), Date.parse('2041-01-01T00:00:00Z')]);

/** @param {string} zone @param {'rdate' | 'rrule'} onsets */
function written(zone, onsets) {
  return stringifyIcal({ prodId: '-//Test//EN', components: [{ type: 'event', dtstamp: 0, uid: 'e',
    start: { kind: 'zoned', date: '2026-03-02', time: '09:00:00', zone }, policy: 'rfc5545' }] },
  { zones: 'embed', provider, horizon: HORIZON, onsets });
}
const vtimezone = (/** @type {string} */ text) => text.slice(text.indexOf('BEGIN:VTIMEZONE'), text.indexOf('END:VTIMEZONE') + 'END:VTIMEZONE\r\n'.length);

describe('ical writer: a VTIMEZONE by RRULE', () => {
  const zones = /** @type {Record<string, { transitions: { at: string, before: number, after: number }[] }>} */ (transitions.zones);
  /** RRULE lines and bytes per zone, recorded */
  const shapes = /** @type {Record<string, [number, number, number]>} */ ({
    'America/New_York': [4, 1702, 751], 'Europe/Amsterdam': [2, 1702, 441], 'Australia/Lord_Howe': [2, 1705, 872],
    'Pacific/Apia': [2, 950, 783], UTC: [0, 161, 161] });

  for (const zone of Object.keys(shapes)) {
    it(`${zone}: read back alone, the same offsets as the provider at every oracle change of 2000-2040; its bytes`, () => {
      const text = written(zone, 'rrule');
      const { report, zones: read } = parseIcal(text, { strict: true });
      assert.deepStrictEqual(report.unsupported, []);
      const changes = zones[zone].transitions.map((change) => Date.parse(change.at)).filter((at) => at >= HORIZON[0] && at < HORIZON[1]);
      const probes = [HORIZON[0], HORIZON[1] - 1000, ...changes.flatMap((at, i) => [at - 1000, at, at + 1000,
        Math.floor((at + (changes[i + 1] ?? HORIZON[1])) / 2)])];
      for (const at of probes) {
        assert.strictEqual(read.provider.toParts(at, zone).offset, provider.toParts(at, zone).offset, `${zone} at ${new Date(at).toISOString()}`);
      }
      for (const change of zones[zone].transitions) {
        const at = Date.parse(change.at);
        assert.deepStrictEqual([read.provider.toParts(at - 1000, zone).offset, read.provider.toParts(at, zone).offset], [change.before, change.after]);
      }
      const ruled = vtimezone(text);
      const plain = vtimezone(written(zone, 'rdate'));
      assert.deepStrictEqual([ruled.split('\r\n').filter((line) => line.startsWith('RRULE:')).length, plain.length, ruled.length], shapes[zone]);
      assert.ok(zone === 'UTC' ? ruled === plain : ruled.length < plain.length);
    });
  }

  it('New York: the 2007 rule change is an UNTIL on the old rules and a DTSTART of the new', () => {
    const lines = vtimezone(written('America/New_York', 'rrule')).split('\r\n');
    assert.deepStrictEqual(lines.filter((line) => /^(DTSTART|RRULE|RDATE)/.test(line)).slice(1), [
      'DTSTART:20000402T020000', 'RRULE:FREQ=YEARLY;BYMONTH=4;BYDAY=1SU;UNTIL=20060402T070000Z',
      'DTSTART:20070311T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU',
      'DTSTART:20001029T020000', 'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU;UNTIL=20061029T060000Z',
      'DTSTART:20071104T020000', 'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU']);
  });

  it('is never longer than the RDATE form: over 2004-2011 New York\'s runs cost more as rules and stay RDATEs', () => {
    const horizon = /** @type {[number, number]} */ ([Date.parse('2004-01-01T00:00:00Z'), Date.parse('2011-01-01T00:00:00Z')]);
    const model = { prodId: '-//Test//EN', components: [{ type: 'event', dtstamp: 0, uid: 'e',
      start: { kind: 'zoned', date: '2005-03-02', time: '09:00:00', zone: 'America/New_York' }, policy: 'rfc5545' }] };
    const options = { zones: /** @type {const} */ ('embed'), provider, horizon };
    assert.strictEqual(stringifyIcal(model, { ...options, onsets: 'rrule' }), stringifyIcal(model, options));
  });

  it('the default is every onset an RDATE, as before', () => {
    assert.strictEqual(written('Europe/Amsterdam', /** @type {any} */ (undefined)), written('Europe/Amsterdam', 'rdate'));
    assert.doesNotMatch(written('Europe/Amsterdam', 'rdate'), /RRULE/);
  });

  it('refuses another spelling', () => {
    assert.throws(() => written('Europe/Amsterdam', /** @type {any} */ ('RRULE')), (/** @type {any} */ error) => /onsets/.test(error.message));
  });
});
