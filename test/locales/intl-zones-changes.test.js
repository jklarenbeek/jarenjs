//@ts-check

/**
 * The Intl provider's `offsetChanges(from, to, zone)`: the offset read a
 * step apart and bisected to the millisecond where two readings differ.
 * Exact while a zone's offset changes at most once per step: the host's
 * IANA data is scanned to show its closest two changes are farther apart
 * than the default step; the list equals the zdump transition table
 * (test/core/calendar/fixtures/zone-transitions) for every zone and year
 * there; a real pair of changes inside a step too wide is the documented
 * limit; and a zoned SECONDLY walk through the provider asks about hours,
 * not seconds.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { createIntlZoneProvider } from '@jarenjs/locales/intl-zones';
import { compileRecurrence, expandRecurrence } from '@jarenjs/core/calendar';

const DAY = 86400000;
const ZONEINFO = '/usr/share/zoneinfo';
const TABLE = JSON.parse(readFileSync(new URL('../core/calendar/fixtures/zone-transitions/transitions.json', import.meta.url), 'utf8'));
const provider = createIntlZoneProvider({ revision: 'test' });

/**
 * The instants (seconds) at which a TZif file's UT offset changes: its
 * 64-bit block when it has one (version 2 and later), else the 32-bit
 * one (RFC 8536 §3).
 * @param {Buffer} data
 * @returns {number[] | null}
 */
function changesOf(data) {
  if (data.length < 44 || data.toString('latin1', 0, 4) !== 'TZif')
    return null;
  const counts = (/** @type {number} */ at) => [20, 24, 28, 32, 36, 40].map((offset) => data.readUInt32BE(at + offset));
  let [isut, isstd, leap, timecnt, typecnt, charcnt] = counts(0);
  let base = 44;
  let size = 4;
  if (data[4] >= 0x32) {
    const second = 44 + timecnt * 5 + typecnt * 6 + charcnt + leap * 8 + isstd + isut;
    [isut, isstd, leap, timecnt, typecnt, charcnt] = counts(second);
    base = second + 44;
    size = 8;
  }
  const times = Array.from({ length: timecnt }, (_, i) => (size === 8 ? Number(data.readBigInt64BE(base + i * 8)) : data.readInt32BE(base + i * 4)));
  const index = base + timecnt * size;
  const types = base + timecnt * (size + 1);
  const out = [];
  let previous;
  for (let i = 0; i < timecnt; i++) {
    const offset = data.readInt32BE(types + data[index + i] * 6);
    if (previous !== undefined && offset !== previous)
      out.push(times[i]);
    previous = offset;
  }
  return out;
}

/** @param {string} dir @returns {string[]} */
const filesUnder = (dir) => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  if (name === 'posix' || name === 'right')
    return [];
  return statSync(path).isDirectory() ? filesUnder(path) : [path];
});

describe('offsetChanges: exact while a zone changes its offset at most once a step', () => {
  it('the host\'s IANA data has no two changes of one zone closer than the default step (a day)', {
    skip: !existsSync(ZONEINFO) && `no IANA zone files at ${ZONEINFO} on this host (Windows ships none)`,
  }, () => {
    let closest = Infinity;
    let where = '';
    let zones = 0;
    for (const path of filesUnder(ZONEINFO)) {
      let changes;
      try {
        changes = changesOf(readFileSync(path));
      }
      catch {
        continue;
      }
      if (changes === null)
        continue;
      zones++;
      for (let i = 1; i < changes.length; i++) {
        if (changes[i] - changes[i - 1] < closest) {
          closest = changes[i] - changes[i - 1];
          where = `${path.slice(ZONEINFO.length + 1)} ${new Date(changes[i - 1] * 1000).toISOString()}`;
        }
      }
    }
    assert.ok(zones > 300, `${zones} zone files read`);
    // 2026e: 601200 seconds, America/Recife in 2000 and Asia/Gaza in years to come
    assert.ok(closest * 1000 > DAY, `the closest two changes are ${closest} s apart (${where})`);
  });

  for (const zone of Object.keys(TABLE.zones)) {
    it(`${zone}: every year 2000-2040 lists the zdump table's changes, to the millisecond`, () => {
      const rows = TABLE.zones[zone].transitions.map((/** @type {any} */ row) => ({ at: Date.parse(row.at), before: row.before, after: row.after }));
      for (let year = 2000; year <= 2040; year++) {
        const from = Date.UTC(year, 0, 1);
        const to = Date.UTC(year + 1, 0, 1) - 1;
        const got = provider.offsetChanges(from, to, zone);
        assert.ok(Object.isFrozen(got));
        assert.deepEqual(got.map((change) => ({ ...change })), rows.filter((row) => row.at >= from && row.at <= to), `${zone} ${year}`);
      }
    });
  }

  it('lists a change at either end of the span, and none for an empty one', () => {
    const at = Date.parse('2026-03-29T01:00:00Z');
    assert.deepEqual(provider.offsetChanges(at, at, 'Europe/Amsterdam').map((c) => c.at), [at]);
    assert.deepEqual(provider.offsetChanges(at - DAY, at, 'Europe/Amsterdam').map((c) => c.at), [at]);
    assert.deepEqual(provider.offsetChanges(at + 1, at + DAY, 'Europe/Amsterdam'), []);
    assert.deepEqual(provider.offsetChanges(at, at - 1, 'Europe/Amsterdam'), []);
    assert.deepEqual(provider.offsetChanges(Date.UTC(2026, 0, 1), Date.UTC(2027, 0, 1), 'UTC'), []);
  });

  it('a change and its undoing inside one step are not seen: the documented limit, and a host lowers the step', () => {
    // Recife kept daylight time for one week in 2000: -03:00 to -02:00 on 8 October, back on 15 October
    const from = Date.UTC(2000, 9, 1);
    const to = Date.UTC(2000, 9, 29);
    const week = provider.offsetChanges(from, to, 'America/Recife');
    assert.deepEqual(week.map((c) => [new Date(c.at).toISOString(), c.before, c.after]),
      [['2000-10-08T03:00:00.000Z', -180, -120], ['2000-10-15T02:00:00.000Z', -120, -180]]);
    // read four weeks apart, the offset is -03:00 at both ends and the week is passed over
    assert.deepEqual(createIntlZoneProvider({ step: 28 * DAY }).offsetChanges(from, to, 'America/Recife'), []);
    assert.deepEqual(createIntlZoneProvider({ step: 3600000 }).offsetChanges(from, to, 'America/Recife'), week);
  });

  it('a step holding changes to three offsets still lists each: the scan goes on from the change it found', () => {
    // Apia in 2011: -10:00 to -11:00 on 2 April, to -10:00 on 24 September, to +14:00 on 30 December (the skipped day)
    const from = Date.UTC(2011, 0, 1);
    const to = Date.UTC(2012, 0, 1) - 1;
    const rows = TABLE.zones['Pacific/Apia'].transitions.map((/** @type {any} */ row) => ({ at: Date.parse(row.at), before: row.before, after: row.after }))
      .filter((/** @type {any} */ row) => row.at >= from && row.at <= to);
    assert.equal(rows.length, 3);
    assert.deepEqual(createIntlZoneProvider({ step: 366 * DAY }).offsetChanges(from, to, 'Pacific/Apia').map((change) => ({ ...change })), rows);
  });

  it('refuses a span that is not two instants, an unknown zone and a step that is not a positive whole number', () => {
    assert.throws(() => provider.offsetChanges(/** @type {any} */ ('0'), 1, 'UTC'), TypeError);
    assert.throws(() => provider.offsetChanges(0, Infinity, 'UTC'), TypeError);
    assert.throws(() => provider.offsetChanges(0, 1, 'Not/AZone'), /Not\/AZone/);
    for (const step of [0, -1, 1.5, '1', NaN])
      assert.throws(() => createIntlZoneProvider(/** @type {any} */ ({ step })), /step is a positive whole number/, String(step));
  });
});

describe('a zoned SECONDLY walk through the Intl provider asks about hours, not seconds', () => {
  it('New York, the day after the change: the change hours by the second, every other hour twice', () => {
    const { offsetChanges, ...bare } = provider;
    assert.equal(typeof offsetChanges, 'function');
    const rule = compileRecurrence({ dtstart: { kind: 'zoned', date: '2026-03-01', time: '00:00:00', zone: 'America/New_York' }, rrule: 'FREQ=SECONDLY' });
    const horizon = [Date.parse('2026-03-09T00:00:00Z'), Date.parse('2026-03-09T00:00:10Z')];
    const listed = expandRecurrence(rule, { horizon, zoneProvider: provider });
    const asked = expandRecurrence(rule, { horizon, zoneProvider: bare, limits: { maxProviderCalls: 1000000 } });
    assert.deepEqual(listed.occurrences, asked.occurrences);
    assert.equal(listed.occurrences.length, 10);
    assert.ok(listed.counts.providerCalls < 3 * 3600 + 2 * 26 + 100, `${listed.counts.providerCalls} provider calls`);
    assert.ok(asked.counts.providerCalls > 60000, `${asked.counts.providerCalls} provider calls without the list`);
    // an ordinary day: two calls an hour
    const june = [Date.parse('2026-06-01T12:00:00Z'), Date.parse('2026-06-01T12:00:10Z')];
    assert.ok(expandRecurrence(rule, { horizon: june, zoneProvider: provider }).counts.providerCalls < 100);
  });
});
