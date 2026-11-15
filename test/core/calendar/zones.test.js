//@ts-check

/**
 * Zone-name checks and the civil date now: both ask an injected provider,
 * and "now" reads the injected runtime clock - never the host's zone and
 * never the platform clock directly.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

import { isZone, assertZone, todayIn, CalendarError } from '@jarenjs/core/calendar';
import { createRuntime } from '@jarenjs/core/runtime';
import { createIntlZoneProvider } from '@jarenjs/locales/intl-zones';

const provider = createIntlZoneProvider();
const refusal = (/** @type {string} */ code) => (/** @type {unknown} */ error) => error instanceof CalendarError && error.code === code;
const clock = (/** @type {string} */ instant) => createRuntime({ now: () => Date.parse(instant) });

describe('isZone and assertZone', () => {
  it('answers what the provider knows', () => {
    assert.strictEqual(isZone('Europe/Amsterdam', provider), true);
    assert.strictEqual(isZone('UTC', provider), true);
    assert.strictEqual(isZone('Mars/Olympus', provider), false);
    for (const name of ['', undefined, null, 7, {}])
      assert.strictEqual(isZone(name, provider), false, String(name));
  });

  it('accepts what the zone data accepts: a link name and a case variant, not only canonical names', () => {
    assert.strictEqual(isZone('US/Eastern', provider), true);
    assert.strictEqual(isZone('europe/amsterdam', provider), true);
  });

  it('assertZone returns the name, or throws JY0001 naming it', () => {
    assert.strictEqual(assertZone('Pacific/Apia', provider), 'Pacific/Apia');
    assert.throws(() => assertZone('Mars/Olympus', provider),
      (error) => refusal('JY0001')(error) && /'Mars\/Olympus'/.test(/** @type {Error} */ (error).message));
    assert.throws(() => assertZone('', provider), refusal('JY0001'));
    assert.throws(() => assertZone(undefined, provider), refusal('JY0001'));
  });

  it('a missing provider is JY0004, never an answer', () => {
    for (const bad of [undefined, null, {}, { toEpoch: () => 0 }]) {
      assert.throws(() => isZone('Europe/Amsterdam', /** @type {any} */ (bad)), refusal('JY0004'), String(bad));
      assert.throws(() => assertZone('Europe/Amsterdam', /** @type {any} */ (bad)), refusal('JY0004'), String(bad));
    }
  });

  it('a provider without candidates still answers zone checks', () => {
    const legacy = { toParts: provider.toParts, toEpoch: provider.toEpoch };
    assert.strictEqual(isZone('Europe/Amsterdam', legacy), true);
    assert.strictEqual(assertZone('Europe/Amsterdam', legacy), 'Europe/Amsterdam');
  });
});

describe('todayIn', () => {
  it('reads the runtime clock in the named zone', () => {
    // 10:30Z on New Year's Day is 23:30 in Apia (+13:00), 05:30 in New York
    // and still New Year's Eve in Pago Pago (-11:00)
    const runtime = clock('2026-01-01T10:30:00Z');
    assert.strictEqual(todayIn('Pacific/Apia', { runtime, provider }), '2026-01-01');
    assert.strictEqual(todayIn('America/New_York', { runtime, provider }), '2026-01-01');
    assert.strictEqual(todayIn('Pacific/Pago_Pago', { runtime, provider }), '2025-12-31');
    assert.strictEqual(todayIn('Pacific/Apia', { runtime: clock('2026-01-01T11:00:00Z'), provider }), '2026-01-02');
  });

  it('takes the runtime\'s zoneProvider when none is passed', () => {
    const runtime = createRuntime({ now: () => Date.parse('2011-12-30T10:00:00Z'), zoneProvider: provider });
    // the first instant after Apia skipped 2011-12-30
    assert.strictEqual(todayIn('Pacific/Apia', { runtime }), '2011-12-31');
    assert.strictEqual(todayIn('Pacific/Apia', { runtime: clock('2011-12-30T09:59:59Z'), provider }), '2011-12-29');
  });

  it('pads a year before 1000', () => {
    assert.strictEqual(todayIn('UTC', { runtime: clock('0999-03-04T00:00:00Z'), provider }), '0999-03-04');
  });

  it('refuses no provider (JY0004), an unknown zone (JY0001) and a clock with no instant (TypeError)', () => {
    const runtime = clock('2026-01-01T10:30:00Z');
    assert.throws(() => todayIn('Europe/Amsterdam', { runtime }), refusal('JY0004'));
    assert.throws(() => todayIn('Europe/Amsterdam'), refusal('JY0004'));
    assert.throws(() => todayIn('Mars/Olympus', { runtime, provider }),
      (error) => refusal('JY0001')(error) && /** @type {any} */ (error).cause instanceof TypeError);
    assert.throws(() => todayIn(/** @type {any} */ (undefined), { runtime, provider }), refusal('JY0001'));
    assert.throws(() => todayIn('UTC', { runtime: createRuntime({ now: () => NaN }), provider }), TypeError);
    assert.throws(() => todayIn('UTC', { runtime: /** @type {any} */ ({ clock: () => 0 }), provider }), TypeError);
  });

  it('refuses a provider whose wall clock is not a date (JY0004)', () => {
    const runtime = clock('2026-01-01T10:30:00Z');
    const answering = (/** @type {any} */ parts) => ({ toParts: (/** @type {number} */ epoch, /** @type {string} */ zone) => {
      if (epoch === 0) return provider.toParts(0, zone);
      if (parts instanceof Error) throw parts;
      return parts;
    }, toEpoch: provider.toEpoch });
    for (const parts of [null, 'x', { year: 2026, month: 13, day: 1 }, { year: 10000, month: 1, day: 1 }, { year: 2026, month: 1 }])
      assert.throws(() => todayIn('UTC', { runtime, provider: answering(parts) }), refusal('JY0004'), JSON.stringify(parts));
    assert.throws(() => todayIn('UTC', { runtime, provider: answering(new RangeError('boom')) }),
      (error) => refusal('JY0004')(error) && /** @type {any} */ (error).cause instanceof RangeError);
  });

  it('never reads the platform clock or the host zone directly', () => {
    const dir = new URL('../../../packages/core/src/calendar/', import.meta.url);
    for (const file of ['index.js', 'resolve.js', 'zones.js', 'errors.js']) {
      const source = readFileSync(new URL(file, dir), 'utf8');
      for (const forbidden of ['Date.now', 'new Date(', 'resolvedOptions', 'getTimezoneOffset', 'Intl.', 'process.env'])
        assert.ok(!source.includes(forbidden), `${file} mentions ${forbidden}`);
    }
  });
});
