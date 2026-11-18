//@ts-check
/**
 * One admission and one spelling of a zone provider across the core
 * layers: a runtime record a host built is handed unchanged to every
 * calendar and assignment entry point that resolves zones, `zoneProvider`
 * is the spelling (`provider` its older alias), and a call that needs a
 * member the provider lacks is refused at that call, by name.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createIntlZoneProvider } from '@jarenjs/locales/intl-zones';
import { createRuntime } from '@jarenjs/core/runtime';
import { resolveClock } from '@jarenjs/core/series';
import {
  resolveLocal, bindFloating, toUtc, shiftCivil, splitByCivilDay, zonedValue, parseTemporal, floatingValue, dateValue,
  compileRecurrence, expandRecurrence, nextOccurrences, defineSeries, expandSeries, evaluateAvailability,
  vtimezoneFor, todayIn, utcValue,
} from '@jarenjs/core/calendar';
import { civilDays } from '@jarenjs/core/assign/days';

const intl = createIntlZoneProvider({ revision: 'host' });
const now = () => Date.parse('2026-03-29T00:30:00Z');
const runtime = createRuntime({ zoneProvider: intl, now });
const zone = 'Europe/Amsterdam';
const policy = /** @type {const} */ ('rfc5545');
const text = (/** @type {unknown} */ value) => JSON.stringify(value);
const zoned = compileRecurrence({ dtstart: zonedValue('2026-03-27', '02:30', zone), duration: 'PT1H', rrule: 'FREQ=DAILY;COUNT=4' });
const horizon = [utcValue('2026-03-26T00:00:00Z'), utcValue('2026-04-02T00:00:00Z')];
const series = defineSeries({ uid: 's', base: zoned });

/**
 * Every entry point that resolves zones, with the options it takes beside the provider.
 * @type {[string, (named: Record<string, unknown>) => unknown][]}
 */
const ENTRY_POINTS = [
  ['resolveLocal', (named) => resolveLocal({ year: 2026, month: 3, day: 29, hours: 2, minutes: 30 }, zone, /** @type {any} */ ({ ...named, policy }))],
  ['bindFloating', (named) => bindFloating(dateValue('2026-03-29'), { zone, policy, ...named })],
  ['toUtc', (named) => toUtc(zonedValue('2026-03-29', '02:30', zone), { policy, ...named })],
  ['shiftCivil', (named) => shiftCivil(zonedValue('2026-03-22', '02:30', zone), { days: 7 }, { policy, ...named })],
  ['splitByCivilDay', (named) => splitByCivilDay({ start: Date.parse('2026-03-28T20:00:00Z'), end: Date.parse('2026-03-30T06:00:00Z') },
    /** @type {any} */ ({ zone, policy, ...named }))],
  ['zonedValue', (named) => zonedValue('2026-03-29', '09:00', zone, named)],
  ['parseTemporal', (named) => parseTemporal({ kind: 'zoned', date: '2026-03-29', time: '09:00', zone }, named)],
  ['expandRecurrence', (named) => expandRecurrence(zoned, { horizon, ...named })],
  ['nextOccurrences', (named) => nextOccurrences(zoned, utcValue('2026-03-26T00:00:00Z'), 2, named)],
  ['expandSeries', (named) => expandSeries(series, { horizon, ...named })],
  ['evaluateAvailability', (named) => evaluateAvailability([{ id: 'open', priority: 5, mode: 'available', series, source: 'c' }],
    { horizon, zone, policy, ...named })],
  ['vtimezoneFor', (named) => vtimezoneFor(zone, { horizon: [utcValue('2026-01-01T00:00:00Z'), utcValue('2027-01-01T00:00:00Z')], ...named })],
  ['todayIn', (named) => todayIn('Pacific/Apia', { runtime: createRuntime({ now }), ...named })],
  ['civilDays', (named) => civilDays(/** @type {any} */ ({ policy, ...named })).provider],
];

describe('one spelling: zoneProvider, its older alias provider, or the runtime record', () => {
  for (const [name, call] of ENTRY_POINTS) {
    it(`${name} answers the same for each`, () => {
      const answer = text(call({ zoneProvider: intl }));
      assert.strictEqual(text(call({ runtime })), answer);
      if (name !== 'civilDays') assert.strictEqual(text(call({ provider: intl })), answer);
      if (name !== 'civilDays') assert.strictEqual(text(call({ provider: intl, zoneProvider: intl })), answer);
      // the call's own option wins over the record's member
      const other = createRuntime({ zoneProvider: createIntlZoneProvider({ revision: 'other' }), now });
      assert.strictEqual(text(call({ zoneProvider: intl, runtime: other })), answer);
    });
  }

  for (const [name, call] of ENTRY_POINTS.filter(([entry]) => entry !== 'civilDays')) {
    it(`${name} refuses zoneProvider and provider naming two providers`, () => {
      assert.throws(() => call({ zoneProvider: intl, provider: createIntlZoneProvider() }),
        (error) => /** @type {any} */ (error).code === 'JY0014' && /\/provider$/.test(/** @type {any} */ (error).docPath)
          && /zoneProvider and provider, its older spelling, name two different providers/.test(/** @type {any} */ (error).message));
    });
  }

  it('civilDays takes no provider: its spelling was zoneProvider already', () => {
    assert.throws(() => civilDays(/** @type {any} */ ({ provider: intl, policy })), (error) => /** @type {any} */ (error).code === 'JN0015');
  });
});

describe('one admission: a call needs the members it reads, and is refused there, by name', () => {
  // a provider with the series clock's two members and no candidates: the runtime admits it
  const twoMembers = { toParts: intl.toParts, toEpoch: intl.toEpoch };
  const plain = createRuntime({ zoneProvider: twoMembers, now });

  it('the runtime record admits it, and a call that reads only toParts answers', () => {
    assert.strictEqual(plain.zoneProvider, twoMembers);
    assert.strictEqual(todayIn('Pacific/Apia', { runtime: plain }), '2026-03-29');
    assert.strictEqual(typeof vtimezoneFor(zone, { runtime: plain, horizon: [utcValue('2026-01-01T00:00:00Z'), utcValue('2027-01-01T00:00:00Z')] }).tzid, 'string');
    assert.strictEqual(resolveClock({ zone, provider: plain.zoneProvider }).epochOf({ year: 2026, month: 7, day: 1, hours: 9, minutes: 0, seconds: 0 }),
      Date.parse('2026-07-01T07:00:00Z'));
  });

  it('a call that classifies is refused at the call, naming candidates', () => {
    for (const [name, call] of ENTRY_POINTS) {
      if (['zonedValue', 'parseTemporal', 'vtimezoneFor', 'todayIn'].includes(name)) continue;
      assert.throws(() => call({ runtime: plain }), (error) => {
        const e = /** @type {any} */ (error);
        const calendar = e.code === 'JN0015' ? e.cause : e;
        return calendar.code === 'JY0004' && /needs a zone provider with candidates\(parts, zone\)/.test(calendar.message);
      }, name);
    }
  });

  it('each layer words a missing member the same, in its own error class', () => {
    const lacking = { toParts: intl.toParts };
    const wording = 'a zone provider with toEpoch(parts, zone, disambiguation)';
    assert.throws(() => createRuntime({ zoneProvider: /** @type {any} */ (lacking) }),
      (error) => error instanceof TypeError && error.message.endsWith(wording));
    assert.throws(() => resolveClock({ zone, provider: /** @type {any} */ (lacking) }),
      (error) => error instanceof TypeError && error.message.includes(wording));
    const noParts = { candidates: intl.candidates };
    assert.throws(() => todayIn(zone, { zoneProvider: /** @type {any} */ (noParts) }),
      (error) => /** @type {any} */ (error).code === 'JY0004' && /** @type {any} */ (error).message.includes('a zone provider with toParts(epoch, zone)'));
    assert.throws(() => createRuntime({ zoneProvider: /** @type {any} */ (noParts) }),
      (error) => error instanceof TypeError && error.message.endsWith('a zone provider with toParts(epoch, zone)'));
  });

  it('a runtime without a provider is a refusal naming what the call needs, never a quiet UTC', () => {
    assert.throws(() => toUtc(zonedValue('2026-03-29', '02:30', zone), { policy, runtime: createRuntime() }),
      (error) => /** @type {any} */ (error).code === 'JY0004');
    // and a value that only checks a zone when a provider is named checks none
    assert.strictEqual(zonedValue('2026-03-29', '09:00', 'Mars/Olympus', { runtime: createRuntime() }).zone, 'Mars/Olympus');
    assert.throws(() => zonedValue('2026-03-29', '09:00', 'Mars/Olympus', { runtime }), (error) => /** @type {any} */ (error).code === 'JY0001');
  });

  it('floating values never ask a provider', () => {
    assert.strictEqual(text(bindFloating(floatingValue('2026-03-29', '09:00'))), text(bindFloating(floatingValue('2026-03-29', '09:00'), { runtime })));
  });
});
