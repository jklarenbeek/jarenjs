/**
 * A query document never carries the zone provider: it is a compile
 * option, `zoneProvider`. The kernel's new spelling (`zoneProvider`,
 * with `provider` its alias and `runtime` beside them) is no more a
 * document member than `provider` was, and every series operator answers
 * through the compile option exactly as before.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { compileJsonQuery } from '@jarenjs/json';
import { CLOCK_MEMBERS as KERNEL_CLOCK_MEMBERS, resampleSeries, rollingSeries, compileBuckets } from '@jarenjs/core/series';
import { createIntlZoneProvider } from '@jarenjs/locales/intl-zones';
import { CLOCK_MEMBERS, RESAMPLE_MEMBERS, ROLLING_MEMBERS } from '../../../packages/json/src/query/series.js';

const zoneProvider = createIntlZoneProvider();
const HOUR = 3600000;
const start = Date.parse('2026-03-28T00:00:00Z');
const r = Array.from({ length: 72 }, (_, i) => ({ at: start + i * HOUR, value: i }));
const zone = 'Europe/Amsterdam';

describe('the query language and the kernel\'s zoneProvider spelling', () => {
  it('spells none of zoneProvider, provider and runtime in a document', () => {
    for (const name of ['zoneProvider', 'provider', 'runtime']) {
      assert.ok(KERNEL_CLOCK_MEMBERS.includes(name), name);
      for (const members of [CLOCK_MEMBERS, RESAMPLE_MEMBERS, ROLLING_MEMBERS]) assert.ok(!members.includes(name), name);
    }
  });

  it('refuses each of them as a spec member, the way it refuses provider', () => {
    const refusal = (spec) => {
      try {
        compileJsonQuery({ $resample: ['$.r', { every: 'P1D', zone, ...spec }] }, { zoneProvider });
      }
      catch (error) {
        return error.code;
      }
      return 'compiled';
    };
    const asProvider = refusal({ provider: 'x' });
    assert.notStrictEqual(asProvider, 'compiled');
    assert.strictEqual(refusal({ zoneProvider: 'x' }), asProvider);
    assert.strictEqual(refusal({ runtime: 'x' }), asProvider);
  });

  it('answers $resample, $rolling and $time-bucket through the compile option as the kernel does with zoneProvider', () => {
    assert.deepStrictEqual(
      compileJsonQuery({ $resample: ['$.r', { every: 'P1D', zone, aggregate: 'sum' }] }, { zoneProvider })({ r }),
      resampleSeries(r, { every: 'P1D', zone, aggregate: 'sum', zoneProvider }));
    assert.deepStrictEqual(
      compileJsonQuery({ $rolling: ['$.r', { width: 'P1D', zone, aggregate: 'sum', disambiguation: 'later' }] }, { zoneProvider })({ r }),
      rollingSeries(r, { width: 'P1D', zone, aggregate: 'sum', disambiguation: 'later', zoneProvider }));
    const buckets = compileBuckets('P1D', { zone, zoneProvider });
    const bucket = compileJsonQuery({ '$time-bucket': ['$.at', 'P1D', null, { zone }] }, { zoneProvider });
    for (const row of r) assert.strictEqual(bucket(row), buckets.floor(row.at));
  });
});
