//@ts-check

/**
 * `evaluateAvailability` against the independent minute-grid oracle
 * (availability-oracle.js) on seeded random layer stacks: up to six
 * layers of mixed priorities and modes over 14-day horizons (some across
 * Amsterdam's spring and autumn changes), explicit instant spans (open
 * ends included), floating spans, dates and date ranges, weekly patterns
 * and a utc daily series, closed and open bounds (a bounded available
 * layer claims its whole period), with and without a zone. Under tiny limits an expansion stops, and every minute the
 * engine still calls available or busy is checked against the unlimited
 * truth: a stopped expansion may only add unknown time.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { evaluateAvailability, utcValue } from '@jarenjs/core/calendar';
import { createIntlZoneProvider } from '@jarenjs/locales/intl-zones';
import { mulberry32 } from '@jarenjs/core/random';
import { oracleZone } from './oracle.js';
import { layersOf, oracleGrid, engineGrid, MINUTE, DAY } from './availability-oracle.js';

const provider = createIntlZoneProvider({ revision: 'host' });
const table = oracleZone('Europe/Amsterdam');
const HOUR = 60 * MINUTE;
const STARTS = ['2026-03-22', '2026-10-18', '2026-06-01', '2026-03-29'].map((d) => Date.parse(`${d}T00:00:00Z`));
const PRIORITIES = [0, 1, 2, 5, 5, 9];
const BUSY = [undefined, 'busy', 'busy-unavailable', 'busy-tentative'];

/**
 * @param {() => number} random
 * @param {number} low
 * @param {number} high
 */
const between = (random, low, high) => low + Math.floor(random() * (high - low + 1));
/** @template T @param {() => number} random @param {readonly T[]} list @returns {T} */
const pick = (random, list) => list[Math.floor(random() * list.length)];

/**
 * A random case over `[low, low + 14 days)`.
 * @param {() => number} random
 * @param {number} low
 * @returns {import('./availability-oracle.js').CaseLayer[]}
 */
function randomCase(random, low) {
  const high = low + 14 * DAY;
  const firstDay = Math.floor(low / DAY);
  const quarter = () => between(random, 0, 95) * 15 * MINUTE;
  const instant = () => low - DAY + between(random, 0, 16 * 96) * 15 * MINUTE;
  const count = between(random, 1, 6);
  /** @type {import('./availability-oracle.js').CaseLayer[]} */
  const layers = [];
  for (let n = 0; n < count; n++) {
    const mode = random() < 0.5 ? 'available' : 'busy';
    /** @type {any} */
    const layer = { id: `L${n}`, priority: pick(random, PRIORITIES), mode, bounds: [null, null] };
    if (mode === 'busy') {
      const type = pick(random, BUSY);
      if (type !== undefined)
        layer.busyType = type;
    }
    if (random() < 0.3)
      layer.revision = `r${between(random, 1, 9)}`;
    const shape = random();
    if (shape < 0.3) {
      const slots = between(random, 1, 2);
      layer.weekly = [];
      for (let s = 0; s < slots; s++) {
        const from = between(random, 0, 46) * 30 * MINUTE;
        const to = Math.min(DAY, from + between(random, 1, 20) * 30 * MINUTE);
        const days = [0, 1, 2, 3, 4, 5, 6].filter(() => random() < 0.5);
        layer.weekly.push({ days: days.length === 0 ? [between(random, 0, 6)] : days, from, to });
      }
    }
    else if (shape < 0.4)
      layer.daily = { start: low - between(random, 0, 3) * DAY + quarter(), minutes: between(random, 1, 40) * 15 };
    else {
      layer.items = [];
      for (let k = between(random, 1, 4); k > 0; k--) {
        const kind = random();
        if (kind < 0.4) {
          const a = instant();
          const b = a + between(random, 1, 4 * 96) * 15 * MINUTE;
          layer.items.push({ type: 'instants', start: random() < 0.1 ? null : a, end: random() < 0.1 ? null : b, utc: random() < 0.5 });
        }
        else if (kind < 0.7) {
          const from = between(random, 0, 95) * 15 * MINUTE;
          const to = random() < 0.15 ? DAY : Math.min(DAY, from + between(random, 1, 40) * 15 * MINUTE);
          layer.items.push({ type: 'floating', day: firstDay + between(random, -1, 14), from, to });
        }
        else layer.items.push({ type: 'dates', day: firstDay + between(random, -1, 14), days: between(random, 1, 3) });
      }
    }
    if (random() < 0.4) {
      const bound = () => (random() < 0.5 ? { type: 'instant', at: instant() } : { type: 'date', day: firstDay + between(random, 0, 13) });
      let b0 = random() < 0.6 ? bound() : null;
      let b1 = random() < 0.6 ? bound() : null;
      if (b0 !== null && b1 !== null && b0.type === b1.type) {
        const key = (/** @type {any} */ b) => (b.type === 'instant' ? b.at : b.day);
        if (key(b0) === key(b1))
          b1 = null;
        else if (key(b0) > key(b1))
          [b0, b1] = [b1, b0];
      }
      layer.bounds = [b0, b1];
      layer.bounded = true;
    }
    layers.push(layer);
  }
  void high;
  return layers;
}

describe('evaluateAvailability equals the minute-grid oracle', () => {
  it('on 1200 seeded random stacks, with and without a zone', () => {
    const random = mulberry32(0xA7A1);
    let compared = 0;
    let unknownMinutes = 0;
    let boundedAvailable = 0;
    for (let n = 0; n < 1200; n++) {
      const low = pick(random, STARTS) + between(random, 0, 3) * 6 * HOUR;
      const high = low + 14 * DAY;
      const layers = randomCase(random, low);
      if (layers.some((layer) => layer.bounded && layer.mode === 'available'))
        boundedAvailable++;
      const zoned = random() < 0.7;
      const policy = random() < 0.5 ? 'rfc5545' : 'later';
      const fallback = random() < 0.8 ? 'unknown' : 'busy';
      const result = evaluateAvailability(/** @type {any} */ (layersOf(layers)), {
        horizon: [utcValue(low), high], zone: zoned ? 'Europe/Amsterdam' : null, zoneSource: 'explicit',
        provider, policy, default: fallback,
      });
      assert.strictEqual(result.complete, true);
      for (const span of result.spans)
        assert.ok(span.start % MINUTE === 0 && span.end % MINUTE === 0, `case ${n}: a span edge off the minute grid`);
      const want = oracleGrid(layers, { low, high, table: zoned ? table : null, policy, fallback });
      const got = engineGrid(result, low, high);
      for (let i = 0; i < want.length; i++) {
        if (got[i] !== want[i]) {
          assert.fail(`case ${n} at ${new Date(low + i * MINUTE).toISOString()}: engine ${got[i]}, oracle ${want[i]}\n${
            JSON.stringify({ zoned, policy, fallback, layers })}`);
        }
        if (want[i].startsWith('unknown'))
          unknownMinutes++;
      }
      // tiling: sorted, contiguous, no two neighbours alike
      for (let i = 1; i < result.spans.length; i++)
        assert.strictEqual(result.spans[i].start, result.spans[i - 1].end);
      compared += want.length;
    }
    assert.ok(compared === 1200 * 14 * 1440);
    assert.ok(unknownMinutes > 0);
    assert.ok(boundedAvailable > 200, `only ${boundedAvailable} stacks hold a bounded available layer`);
  });

  it('a stopped expansion only ever adds unknown time (tiny limits, multi-slot patterns)', () => {
    const random = mulberry32(0xB2B2);
    let incomplete = 0;
    for (let n = 0; n < 400; n++) {
      const low = pick(random, STARTS);
      const high = low + 14 * DAY;
      const layers = randomCase(random, low);
      const zoned = random() < 0.8;
      const limits = random() < 0.5 ? { maxOccurrences: between(random, 0, 4) }
        : random() < 0.5 ? { maxWork: between(random, 1, 40) } : { maxHorizonDays: between(random, 1, 10) };
      const options = { horizon: /** @type {[any, any]} */ ([low, high]), zone: zoned ? 'Europe/Amsterdam' : null, provider, policy: /** @type {const} */ ('rfc5545') };
      const limited = evaluateAvailability(/** @type {any} */ (layersOf(layers)), { ...options, limits });
      const truth = oracleGrid(layers, { low, high, table: zoned ? table : null, policy: 'rfc5545', fallback: 'unknown' });
      const got = engineGrid(limited, low, high);
      if (!limited.complete) {
        incomplete++;
        assert.ok(limited.layers.some((layer) => layer.status === 'incomplete' && layer.limit !== undefined));
      }
      for (let i = 0; i < got.length; i++) {
        const [state, , , ids] = got[i].split('|');
        if (state === 'available')
          assert.strictEqual(got[i], truth[i], `case ${n} minute ${i}: available where the truth is ${truth[i]}`);
        else if (state === 'busy')
          assert.strictEqual(truth[i].split('|')[0], 'busy', `case ${n} minute ${i}: busy [${ids}] where the truth is ${truth[i]}`);
        else if (got[i].includes('|incomplete|'))
          assert.strictEqual(limited.complete, false);
      }
    }
    assert.ok(incomplete > 50, `only ${incomplete} cases stopped`);
  });
});
