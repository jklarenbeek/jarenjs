import { describe, it } from 'node:test';
import * as assert from '../../assert.node.js';

import { resolveClock, compileBuckets, resampleSeries, rollingSeries } from '@jarenjs/core/series';
import { partsFromEpoch } from '@jarenjs/core/dates/civil';
import { epochOfRFC3339Parts } from '@jarenjs/core/dates/rfc3339';

// The whole point of D7 is that this file can exist. There is no tzdb in
// the tree and no `Intl` call in the kernel, so a DST gap and a DST fold
// are tested against a provider written here, in thirty lines, whose
// rules are visible rather than inherited from whatever the host's
// operating system was last updated to.
//
// Two zones, because one of them is not enough:
//
//   Test/Amsterdam  transitions at 02:00 local, like the real one. Its
//                   gaps and folds are inside the day, so a daily
//                   bucket boundary never meets one.
//   Test/Midnight   transitions at 00:00 local. On its spring-forward
//                   day there IS no local midnight, so a daily bucket
//                   has no boundary — which is the case a kernel that
//                   assumed 86,400,000 would answer wrong and never
//                   notice.

const HOUR = 3600000;

/** When each scripted zone jumps, and by how much, in 2026. */
const ZONES = {
  'Test/Amsterdam': {
    standard: 60,
    daylight: 120,
    // 02:00 CET → 03:00 CEST, and 03:00 CEST → 02:00 CET
    starts: Date.UTC(2026, 2, 29, 1),
    ends: Date.UTC(2026, 9, 25, 1),
  },
  'Test/Midnight': {
    standard: 0,
    daylight: 60,
    // 00:00 → 01:00, so the day has no midnight
    starts: Date.UTC(2026, 2, 29, 0),
    ends: Date.UTC(2026, 9, 25, 1),
  },
};

/** The offset in force at an instant. */
function offsetAt(epoch, zone) {
  const rule = ZONES[zone];
  if (rule === undefined)
    throw new Error(`no rule for '${zone}'`);
  return (epoch >= rule.starts && epoch < rule.ends) ? rule.daylight : rule.standard;
}

/**
 * The scripted provider. `toEpoch` tries both offsets and keeps the
 * candidates that agree with the offset actually in force there: two
 * survivors is a fold, none is a gap, and `earlier`/`later` are the
 * smaller and larger candidate in both cases.
 */
const provider = {
  toParts: (epoch, zone) => partsFromEpoch(epoch, offsetAt(epoch, zone)),
  toEpoch: (parts, zone, disambiguation) => {
    const rule = ZONES[zone];
    const candidates = [rule.standard, rule.daylight]
      .map((offset) => ({ offset, epoch: epochOfRFC3339Parts({ ...parts, offset }) }));
    const valid = candidates.filter((c) => offsetAt(c.epoch, zone) === c.offset);
    if (valid.length === 1)
      return valid[0].epoch;
    if (disambiguation === 'earlier')
      return Math.min(candidates[0].epoch, candidates[1].epoch);
    if (disambiguation === 'later')
      return Math.max(candidates[0].epoch, candidates[1].epoch);
    return NaN;
  },
};

const iso = (epoch) => new Date(epoch).toISOString();

describe('resolveClock', () => {
  it('should answer UTC with nothing configured', () => {
    const clock = resolveClock();
    assert.strictEqual(clock.zone, 'UTC');
    assert.strictEqual(clock.partsAt(0).hours, 0);
    assert.strictEqual(clock.epochOf({ year: 1970, month: 1, day: 1, hours: 0, minutes: 0, seconds: 0 }), 0);
  });

  it('should take a fixed offset without a provider', () => {
    const clock = resolveClock({ offset: -330 });
    assert.strictEqual(clock.zone, '-05:30');
    assert.strictEqual(clock.partsAt(0).day, 31);
    assert.strictEqual(clock.partsAt(0).hours, 18);
    assert.strictEqual(
      clock.epochOf({ year: 1970, month: 1, day: 1, hours: 0, minutes: 0, seconds: 0 }),
      330 * 60000);
  });

  it('should refuse a named zone with no provider rather than quietly meaning UTC', () => {
    // UTC is right for Amsterdam for none of the year and looks right
    // for eight months of it, which is the worst possible default
    assert.throws(() => resolveClock({ zone: 'Test/Amsterdam' }),
      /needs a provider with toParts\(epoch, zone\)/);
    assert.throws(() => resolveClock({ zone: 'Test/Amsterdam', provider: { toParts: () => ({}) } }),
      /needs a provider/);
  });

  it('should refuse a clock that is both a zone and an offset', () => {
    assert.throws(() => resolveClock({ zone: 'Test/Amsterdam', offset: 60, provider }),
      /a zone or an offset, not both/);
  });

  it('should refuse a disambiguation it does not have', () => {
    assert.throws(() => resolveClock({ disambiguation: 'whichever' }), /disambiguation is/);
  });

  it('should let \'UTC\' through without a provider', () => {
    assert.strictEqual(resolveClock({ zone: 'UTC' }).zone, 'UTC');
  });
});

describe('a named zone through the injected provider', () => {
  const zone = 'Test/Amsterdam';

  it('should read the wall clock the provider reports', () => {
    const clock = resolveClock({ zone, provider });
    // midwinter is +01:00, midsummer +02:00
    assert.strictEqual(clock.partsAt(Date.UTC(2026, 0, 15, 12)).hours, 13);
    assert.strictEqual(clock.partsAt(Date.UTC(2026, 6, 15, 12)).hours, 14);
  });

  it('should refuse a local time that never happened', () => {
    const clock = resolveClock({ zone, provider });
    assert.throws(
      () => clock.epochOf({ year: 2026, month: 3, day: 29, hours: 2, minutes: 30, seconds: 0 }),
      /is ambiguous or does not exist, and disambiguation is 'reject'/);
  });

  it('should refuse a local time that happened twice', () => {
    const clock = resolveClock({ zone, provider });
    assert.throws(
      () => clock.epochOf({ year: 2026, month: 10, day: 25, hours: 2, minutes: 30, seconds: 0 }),
      /is ambiguous or does not exist/);
  });

  it('should resolve the gap and the fold when asked to, and the two answers differ', () => {
    const earlier = resolveClock({ zone, provider, disambiguation: 'earlier' });
    const later = resolveClock({ zone, provider, disambiguation: 'later' });
    const gap = { year: 2026, month: 3, day: 29, hours: 2, minutes: 30, seconds: 0 };
    assert.strictEqual(iso(earlier.epochOf(gap)), '2026-03-29T00:30:00.000Z');
    assert.strictEqual(iso(later.epochOf(gap)), '2026-03-29T01:30:00.000Z');
    const fold = { year: 2026, month: 10, day: 25, hours: 2, minutes: 30, seconds: 0 };
    assert.strictEqual(iso(earlier.epochOf(fold)), '2026-10-25T00:30:00.000Z');
    assert.strictEqual(iso(later.epochOf(fold)), '2026-10-25T01:30:00.000Z');
  });
});

describe('calendar buckets on a named zone', () => {
  const zone = 'Test/Amsterdam';
  const options = { zone, provider };

  it('should make a day a calendar span, and only on a named zone', () => {
    assert.strictEqual(compileBuckets('P1D', options).calendar, true);
    assert.strictEqual(compileBuckets('P1D', options).unit, 'day');
    assert.strictEqual(compileBuckets('P1D').calendar, false);
  });

  it('should keep every daily boundary on local midnight across a 23-hour day', () => {
    const b = compileBuckets('P1D', options);
    // 29 March 2026 is 23 hours long here; a ladder multiplying by
    // 86,400,000 would put every boundary after it an hour early
    assert.strictEqual(iso(b.floor(Date.UTC(2026, 2, 28, 12))), '2026-03-27T23:00:00.000Z');
    assert.strictEqual(iso(b.floor(Date.UTC(2026, 2, 29, 12))), '2026-03-28T23:00:00.000Z');
    assert.strictEqual(iso(b.floor(Date.UTC(2026, 2, 30, 12))), '2026-03-29T22:00:00.000Z');
    assert.strictEqual(iso(b.floor(Date.UTC(2026, 3, 30, 12))), '2026-04-29T22:00:00.000Z');
  });

  it('should keep every daily boundary on local midnight across a 25-hour day', () => {
    const b = compileBuckets('P1D', options);
    assert.strictEqual(iso(b.floor(Date.UTC(2026, 9, 24, 12))), '2026-10-23T22:00:00.000Z');
    assert.strictEqual(iso(b.floor(Date.UTC(2026, 9, 25, 12))), '2026-10-24T22:00:00.000Z');
    assert.strictEqual(iso(b.floor(Date.UTC(2026, 9, 26, 12))), '2026-10-25T23:00:00.000Z');
  });

  it('should put a month boundary on the first of the month, local', () => {
    const b = compileBuckets('P1M', options);
    assert.strictEqual(iso(b.floor(Date.UTC(2026, 6, 15))), '2026-06-30T22:00:00.000Z');
    assert.strictEqual(iso(b.floor(Date.UTC(2026, 0, 15))), '2025-12-31T23:00:00.000Z');
  });

  it('should refuse a boundary that never happened, and resolve it when told how', () => {
    const midnight = { zone: 'Test/Midnight', provider };
    // 29 March 2026 begins at 01:00 local in this zone: there is no
    // midnight to put a boundary on
    assert.throws(() => compileBuckets('P1D', midnight).floor(Date.UTC(2026, 2, 29, 12)),
      /is ambiguous or does not exist, and disambiguation is 'reject'/);
    const later = compileBuckets('P1D', { ...midnight, disambiguation: 'later' });
    assert.strictEqual(iso(later.floor(Date.UTC(2026, 2, 29, 12))), '2026-03-29T00:00:00.000Z');
    const earlier = compileBuckets('P1D', { ...midnight, disambiguation: 'earlier' });
    assert.strictEqual(iso(earlier.floor(Date.UTC(2026, 2, 29, 12))), '2026-03-28T23:00:00.000Z');
  });

  it('should resample a day that is 23 hours long into one bucket', () => {
    // one reading an hour across the transition: the short day holds 23
    const rows = [];
    for (let h = 0; h < 72; h++)
      rows.push({ at: Date.UTC(2026, 2, 27, 23) + h * HOUR, value: 1 });
    const out = resampleSeries(rows, { every: 'P1D', aggregate: 'count', ...options });
    assert.deepStrictEqual(out.map((row) => row.value), [24, 23, 24, 1]);
    assert.deepStrictEqual(out.map((row) => iso(row.at)), [
      '2026-03-27T23:00:00.000Z',
      '2026-03-28T23:00:00.000Z',
      '2026-03-29T22:00:00.000Z',
      '2026-03-30T22:00:00.000Z',
    ]);
  });

  it('should roll a calendar month back through the provider', () => {
    const rows = [
      { at: Date.UTC(2026, 0, 15, 12), value: 1 },
      { at: Date.UTC(2026, 1, 14, 12), value: 2 },
      { at: Date.UTC(2026, 1, 16, 12), value: 4 },
    ];
    const out = rollingSeries(rows, { width: 'P1M', aggregate: 'sum', ...options });
    // 15 January is inside (14 February − one month]; 16 February's
    // window opens on 16 January, so January's reading has left it and
    // only the two February readings remain
    assert.deepStrictEqual(out.map((row) => row.value), [1, 3, 6]);
  });
});

describe('a fixed offset needs no provider anywhere', () => {
  it('should bucket a day on local midnight in +05:30', () => {
    const b = compileBuckets('P1D', { offset: 330 });
    assert.strictEqual(iso(b.floor(Date.UTC(2026, 0, 1, 12))), '2025-12-31T18:30:00.000Z');
    assert.strictEqual(b.calendar, false);
  });

  it('should resample against that offset without a calendar at all', () => {
    const rows = [
      { at: Date.UTC(2025, 11, 31, 19), value: 1 },
      { at: Date.UTC(2026, 0, 1, 18, 29), value: 2 },
      { at: Date.UTC(2026, 0, 1, 18, 30), value: 4 },
    ];
    const out = resampleSeries(rows, { every: 'P1D', offset: 330, aggregate: 'sum' });
    assert.deepStrictEqual(out.map((row) => [iso(row.at), row.value]), [
      ['2025-12-31T18:30:00.000Z', 3],
      ['2026-01-01T18:30:00.000Z', 4],
    ]);
  });
});
