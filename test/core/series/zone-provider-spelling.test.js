//@ts-check
/**
 * The series clock spells its zone provider as every core layer does:
 * `zoneProvider`, `provider` kept as the older alias, and `runtime`
 * read when neither is given, through the one shared rule
 * (`zoneProviderOf`) and the one shared check (`zoneProviderNeed`).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createIntlZoneProvider } from '@jarenjs/locales/intl-zones';
import { createRuntime } from '@jarenjs/core/runtime';
import { resolveClock, compileBuckets, resampleSeries, rollingSeries, CLOCK_MEMBERS, RESAMPLE_MEMBERS, ROLLING_MEMBERS } from '@jarenjs/core/series';
import { toUtc, zonedValue } from '@jarenjs/core/calendar';

const intl = createIntlZoneProvider({ revision: 'host' });
const runtime = createRuntime({ zoneProvider: intl });
const zone = 'Europe/Amsterdam';
const text = (/** @type {unknown} */ value) => JSON.stringify(value);
const HOUR = 3600000;
// three days across the spring-forward change, one reading an hour
const start = Date.parse('2026-03-28T00:00:00Z');
const readings = Array.from({ length: 72 }, (_, i) => ({ at: start + i * HOUR, value: i }));
const wall = { year: 2026, month: 3, day: 29, hours: 2, minutes: 30, seconds: 0 };

/** @type {[string, (named: Record<string, unknown>) => unknown][]} */
const ENTRY_POINTS = [
  ['resolveClock epochOf', (named) => resolveClock({ zone, disambiguation: 'later', ...named }).epochOf(wall)],
  ['resolveClock partsAt', (named) => resolveClock({ zone, ...named }).partsAt(start + 30 * HOUR)],
  ['compileBuckets', (named) => {
    const buckets = compileBuckets('P1D', { zone, ...named });
    return readings.map((row) => buckets.floor(row.at));
  }],
  ['resampleSeries', (named) => resampleSeries(readings, { every: 'P1D', zone, aggregate: 'sum', ...named })],
  ['rollingSeries', (named) => rollingSeries(readings, { width: 'P1D', zone, aggregate: 'sum', disambiguation: 'later', ...named })],
];

describe('the series clock: zoneProvider, its older alias provider, or the runtime record', () => {
  it('names all three in every clock-reading spec', () => {
    for (const members of [CLOCK_MEMBERS, RESAMPLE_MEMBERS, ROLLING_MEMBERS])
      for (const name of ['zoneProvider', 'provider', 'runtime']) assert.ok(members.includes(name), name);
  });

  for (const [name, call] of ENTRY_POINTS) {
    it(`${name} answers the same for each`, () => {
      const answer = text(call({ provider: intl }));
      assert.notStrictEqual(answer, undefined);
      assert.strictEqual(text(call({ zoneProvider: intl })), answer);
      assert.strictEqual(text(call({ runtime })), answer);
      assert.strictEqual(text(call({ zoneProvider: intl, provider: intl })), answer);
      // the spec's own member wins over the record's
      const utcOnly = createRuntime({ zoneProvider: /** @type {any} */ ({ toParts: () => ({}), toEpoch: () => NaN }) });
      assert.strictEqual(text(call({ zoneProvider: intl, runtime: utcOnly })), answer);
    });

    it(`${name} refuses zoneProvider and provider naming two providers, in the calendar's words`, () => {
      assert.throws(() => call({ zoneProvider: intl, provider: createIntlZoneProvider() }),
        (error) => error instanceof TypeError
          && error.message.includes('zoneProvider and provider, its older spelling, name two different providers'));
      assert.throws(() => toUtc(zonedValue('2026-03-29', '02:30', zone), { policy: 'rfc5545', zoneProvider: intl, provider: createIntlZoneProvider() }),
        (error) => /** @type {any} */ (error).code === 'JY0014'
          && /** @type {any} */ (error).message.includes('zoneProvider and provider, its older spelling, name two different providers'));
    });
  }

  it('a named zone with neither and no runtime provider is still a refusal, never a quiet UTC', () => {
    for (const named of [{}, { runtime: createRuntime() }, { zoneProvider: undefined }])
      assert.throws(() => resolveClock({ zone, ...named }), /needs a zone provider with toParts\(epoch, zone\)/);
  });

  it('a provider the clock cannot read is refused by the shared check, under either spelling', () => {
    for (const spelling of ['zoneProvider', 'provider'])
      assert.throws(() => resolveClock({ zone, [spelling]: { toParts: intl.toParts } }),
        /needs a zone provider with toEpoch\(parts, zone, disambiguation\)/);
  });

  it('a UTC or fixed-offset clock reads no provider, under any spelling', () => {
    assert.strictEqual(resolveClock({ zoneProvider: intl }).epochOf(wall), Date.UTC(2026, 2, 29, 2, 30));
    assert.strictEqual(resolveClock({ offset: 60, runtime }).epochOf(wall), Date.UTC(2026, 2, 29, 1, 30));
  });
});
