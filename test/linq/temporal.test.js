//@ts-check
/**
 * @file The chain's calendar-value keys: `instantOf(policy?)` writes `$instant`
 * and `wallClock()` writes `$wall` (QUERY-FORMAT §8.13), a member named
 * `instant` still reads as a member, and a store collection over a declared
 * temporal member answers the chain as the engine does.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { from } from '@jarenjs/linq';
import { createIntlZoneProvider } from '@jarenjs/locales/intl-zones';

const zoneProvider = createIntlZoneProvider({ revision: 'linq' });
const rows = [
  { id: 'a', on: { kind: 'utc', instant: '2026-01-01T00:00:00.5Z' }, f: { kind: 'floating', date: '2026-07-01', time: '10:00' },
    z: { kind: 'zoned', date: '2026-10-25', time: '02:30', zone: 'Europe/Amsterdam' } },
  { id: 'b', on: { kind: 'utc', instant: '2026-01-01T00:00:00Z' }, f: { kind: 'floating', date: '2026-07-01', time: '09:00:00.000' },
    z: { kind: 'zoned', date: '2026-10-25', time: '01:50', zone: 'Europe/London' } },
];

describe('instantOf and wallClock', () => {
  it('order by the instant and the wall clock, where the instant member orders by its text', () => {
    assert.deepEqual(from(rows).orderBy((r) => r.on.instantOf()).select((r) => r.id).toArray(), ['b', 'a']);
    assert.deepEqual(from(rows).orderBy((r) => r.on.instant).select((r) => r.id).toArray(), ['a', 'b']);
    assert.deepEqual(from(rows).select((r) => r.f.wallClock()).toArray(), ['2026-07-01T10:00:00.000', '2026-07-01T09:00:00.000']);
  });
  it('resolve a zoned value under the policy the call names', () => {
    assert.deepEqual(from(rows, { zoneProvider }).select((r) => r.z.instantOf('later')).toArray(),
      [Date.parse('2026-10-25T01:30:00Z'), Date.parse('2026-10-25T01:50:00Z')]);
    assert.deepEqual(from(rows, { zoneProvider }).where((r) => r.z.instantOf('rfc5545').lt(Date.parse('2026-10-25T00:45:00Z'))).select((r) => r.id).toArray(), ['a']);
  });
});
