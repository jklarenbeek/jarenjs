//@ts-check
/**
 * @file The chain's calendar-value keys: `instantOf(policy?)` writes `$instant`
 * and `wallClock()` writes `$wall` (QUERY-FORMAT §8.13), a member named
 * `instant` still reads as a member, and a store collection over a declared
 * temporal member answers the chain as the engine does.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { from, fromAsync, federate } from '@jarenjs/linq';
import { createIntlZoneProvider } from '@jarenjs/locales/intl-zones';
import { queryCalendar } from '@jarenjs/json/query/calendar';

const zoneProvider = createIntlZoneProvider({ revision: 'linq' });
const calendar = queryCalendar();
const rows = [
  { id: 'a', on: { kind: 'utc', instant: '2026-01-01T00:00:00.5Z' }, f: { kind: 'floating', date: '2026-07-01', time: '10:00' },
    z: { kind: 'zoned', date: '2026-10-25', time: '02:30', zone: 'Europe/Amsterdam' } },
  { id: 'b', on: { kind: 'utc', instant: '2026-01-01T00:00:00Z' }, f: { kind: 'floating', date: '2026-07-01', time: '09:00:00.000' },
    z: { kind: 'zoned', date: '2026-10-25', time: '01:50', zone: 'Europe/London' } },
];

describe('instantOf and wallClock', () => {
  it('order by the instant and the wall clock, where the instant member orders by its text', () => {
    assert.deepEqual(from(rows, { calendar }).orderBy((r) => r.on.instantOf()).select((r) => r.id).toArray(), ['b', 'a']);
    assert.deepEqual(from(rows, { calendar }).orderBy((r) => r.on.instant).select((r) => r.id).toArray(), ['a', 'b']);
    assert.deepEqual(from(rows, { calendar }).select((r) => r.f.wallClock()).toArray(), ['2026-07-01T10:00:00.000', '2026-07-01T09:00:00.000']);
  });
  it('resolve a zoned value under the policy the call names', () => {
    assert.deepEqual(from(rows, { zoneProvider, calendar }).select((r) => r.z.instantOf('later')).toArray(),
      [Date.parse('2026-10-25T01:30:00Z'), Date.parse('2026-10-25T01:50:00Z')]);
    assert.deepEqual(from(rows, { zoneProvider, calendar }).where((r) => r.z.instantOf('rfc5545').lt(Date.parse('2026-10-25T00:45:00Z'))).select((r) => r.id).toArray(), ['a']);
  });
});

describe('a federation over the calendar seam', () => {
  it('reads a calendar value in what it runs over the fetched sides, and is JQ0003 without it', async () => {
    const source = (/** @type {any[]} */ items) => ({ execute: async () => items });
    const joined = (/** @type {any} */ spec) => {
      const fed = federate({ sources: { left: source(rows), right: source(rows) }, maxRows: 10, maxBytes: 1 << 20, ...spec });
      return fromAsync(fed.source('left'))
        .join(fromAsync(fed.source('right')), (/** @type {any} */ l) => l.id, (/** @type {any} */ r) => r.id,
          (/** @type {any} */ l, /** @type {any} */ r) => ({ id: l.id, wall: r.f.wallClock() }))
        .toArray();
    };
    assert.deepEqual(await joined({ calendar }), [{ id: 'a', wall: '2026-07-01T10:00:00.000' }, { id: 'b', wall: '2026-07-01T09:00:00.000' }]);
    await assert.rejects(async () => joined({}), (/** @type {any} */ e) => e.code === 'JQ0003' && /reads a calendar value/.test(e.message));
  });
});
