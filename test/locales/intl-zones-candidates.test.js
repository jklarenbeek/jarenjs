//@ts-check

/**
 * The Intl provider's optional seam members: `candidates(parts, zone)`,
 * every instant a wall clock names without choosing one, and `identity`,
 * which zone data answers. `toEpoch` decides from the same probe, so the
 * two cannot disagree; the existing intl-zones suite pins `toEpoch`
 * itself, unchanged.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { createIntlZoneProvider } from '@jarenjs/locales/intl-zones';

const provider = createIntlZoneProvider();
const iso = (/** @type {number} */ epoch) => new Date(epoch).toISOString();
const wall = (year, month, day, hours, minutes = 0, seconds = 0) => ({ year, month, day, hours, minutes, seconds });

describe('candidates(parts, zone)', () => {
  it('a time that exists: one instant with its offset', () => {
    const answer = provider.candidates?.(wall(2026, 7, 1, 9), 'Europe/Amsterdam');
    assert.deepStrictEqual(answer, { candidates: [{ instant: Date.parse('2026-07-01T07:00:00Z'), offsetMinutes: 120 }] });
  });

  it('a fold: both instants ascending, and the offsets either side', () => {
    const answer = provider.candidates?.(wall(2026, 10, 25, 2, 30), 'Europe/Amsterdam');
    assert.deepStrictEqual(answer?.candidates.map((c) => [iso(c.instant), c.offsetMinutes]),
      [['2026-10-25T00:30:00.000Z', 120], ['2026-10-25T01:30:00.000Z', 60]]);
    assert.deepStrictEqual(answer?.offsets, { before: 120, after: 60 });
  });

  it('a gap: no instant, and the offsets before and after the change', () => {
    assert.deepStrictEqual(provider.candidates?.(wall(2026, 3, 29, 2, 30), 'Europe/Amsterdam'),
      { candidates: [], offsets: { before: 60, after: 120 } });
    assert.deepStrictEqual(provider.candidates?.(wall(2011, 12, 30, 12), 'Pacific/Apia'),
      { candidates: [], offsets: { before: -600, after: 840 } });
  });

  it('its gap offsets are the readings toEpoch picks: later with before, earlier with after', () => {
    const parts = wall(2026, 3, 8, 2, 30);
    const answer = /** @type {any} */ (provider.candidates?.(parts, 'America/New_York'));
    const asUtc = Date.UTC(2026, 2, 8, 2, 30);
    assert.strictEqual(provider.toEpoch(parts, 'America/New_York', 'later'), asUtc - answer.offsets.before * 60000);
    assert.strictEqual(provider.toEpoch(parts, 'America/New_York', 'earlier'), asUtc - answer.offsets.after * 60000);
  });

  it('parts that are not a civil wall clock are refused, never answered as a gap', () => {
    // each reads back as another wall clock, exactly as a gap does; the day
    // before the change is chosen so the probes do see two offsets
    for (const parts of [wall(2026, 3, 28, 25), wall(2026, 2, 30, 9), wall(2026, 3, 28, 9, 60)]) {
      assert.throws(() => provider.candidates?.(parts, 'Europe/Amsterdam'), /not a civil date and time of day/,
        JSON.stringify(parts));
    }
  });

  it('a fraction finer than a millisecond is cut, so it is the wall clock it is in, never the next second', () => {
    for (const parts of [wall(2026, 3, 28, 9, 0, 5.9996), wall(2026, 7, 1, 9, 0, 5.9996)]) {
      const cut = { ...parts, seconds: 5.999 };
      assert.deepStrictEqual(provider.candidates?.(parts, 'Europe/Amsterdam'), provider.candidates?.(cut, 'Europe/Amsterdam'));
      assert.strictEqual(provider.toEpoch(parts, 'Europe/Amsterdam', 'later'), provider.toEpoch(cut, 'Europe/Amsterdam', 'later'));
    }
    assert.strictEqual(provider.toEpoch(wall(2026, 7, 1, 9, 0, 5.9996), 'Europe/Amsterdam', 'reject'), Date.parse('2026-07-01T07:00:05.999Z'));
  });

  it('absent or negative time members read as midnight, as toEpoch reads them', () => {
    const midnight = provider.candidates?.(/** @type {any} */ ({ year: 2026, month: 7, day: 1, hours: -1 }), 'Europe/Amsterdam');
    assert.deepStrictEqual(midnight, { candidates: [{ instant: Date.parse('2026-06-30T22:00:00Z'), offsetMinutes: 120 }] });
  });

  it('answers are frozen', () => {
    const answer = /** @type {any} */ (provider.candidates?.(wall(2026, 10, 25, 2, 30), 'Europe/Amsterdam'));
    assert.ok(Object.isFrozen(answer) && Object.isFrozen(answer.candidates) && Object.isFrozen(answer.candidates[0])
      && Object.isFrozen(answer.offsets));
  });

  it('refuses an unknown zone, a non-record and a wall clock the platform cannot hold, by name', () => {
    assert.throws(() => provider.candidates?.(wall(2026, 7, 1, 9), 'Mars/Olympus'), /'Mars\/Olympus' is not a time zone/);
    assert.throws(() => provider.candidates?.(/** @type {any} */ (null), 'Europe/Amsterdam'), /a wall clock is a parts record/);
    assert.throws(() => provider.candidates?.(wall(275760, 9, 13, 0), 'UTC'), /names no instant this platform can hold/);
    assert.throws(() => provider.candidates?.(wall(2026, 7, 1, 9), ''), /given explicitly/);
  });
});

describe('identity', () => {
  it('records the caller\'s revision, or unrecorded', () => {
    assert.deepStrictEqual(provider.identity, { name: 'intl', revision: 'unrecorded' });
    assert.deepStrictEqual(createIntlZoneProvider({ revision: '2026e' }).identity, { name: 'intl', revision: '2026e' });
    assert.ok(Object.isFrozen(provider.identity));
  });

  it('refuses a revision that is not a non-empty string', () => {
    for (const revision of ['', 7, {}])
      assert.throws(() => createIntlZoneProvider(/** @type {any} */ ({ revision })), /revision is a non-empty string/, String(revision));
    // null is absent, as it is for `zones`
    assert.strictEqual(createIntlZoneProvider(/** @type {any} */ ({ revision: null })).identity?.revision, 'unrecorded');
  });

  it('carries the four members, frozen', () => {
    assert.deepStrictEqual(Object.keys(provider), ['toParts', 'toEpoch', 'candidates', 'identity']);
    assert.ok(Object.isFrozen(provider));
  });
});
