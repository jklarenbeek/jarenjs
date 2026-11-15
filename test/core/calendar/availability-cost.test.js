//@ts-check

/**
 * The cost of `evaluateAvailability` over fifty layers grows with the
 * horizon: an eightfold longer horizon (45 days, then 360) costs near
 * eight times as much, never the sixty-four a pairwise sweep would.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { evaluateAvailability, weeklyPattern, compileRecurrence, defineSeries, dateValue, utcValue } from '@jarenjs/core/calendar';
import { createIntlZoneProvider } from '@jarenjs/locales/intl-zones';
import { growthRatio } from '../../lib/growth.js';

const DAY = 86400000;
const provider = createIntlZoneProvider({ revision: 'cost' });
const START = Date.parse('2026-01-05T00:00:00Z');

/** Fifty layers: weekly hours, daily utc series and leave days. */
function fiftyLayers() {
  const layers = [];
  for (let i = 0; i < 50; i++) {
    const kind = i % 3;
    if (kind === 0) {
      const from = `${String(6 + (i % 6)).padStart(2, '0')}:00`;
      const to = `${String(14 + (i % 6)).padStart(2, '0')}:30`;
      layers.push({ id: `hours-${i}`, priority: 1 + (i % 9), mode: 'available',
        series: weeklyPattern({ days: { mon: [[from, to]], tue: [[from, to]], wed: [[from, to]], thu: [[from, to]], fri: [[from, '12:00'], ['13:00', to]] } }), source: 'x' });
    }
    else if (kind === 1) {
      layers.push({ id: `daily-${i}`, priority: i % 10, mode: 'busy', source: 'x',
        series: defineSeries({ uid: `d${i}`, base: compileRecurrence({ dtstart: utcValue(START + i * 15 * 60000), duration: 'PT45M', rrule: 'FREQ=DAILY' }) }) });
    }
    else {
      const spans = [];
      for (let d = i; d < 400; d += 17)
        spans.push(dateValue(new Date(START + d * DAY).toISOString().slice(0, 10)));
      layers.push({ id: `leave-${i}`, priority: 1, mode: 'busy', busyType: 'busy-unavailable', spans, source: 'x' });
    }
  }
  return layers;
}

describe('evaluateAvailability grows with its horizon', () => {
  it('fifty layers over 45 then 360 days grows near eightfold, not sixty-four', () => {
    const layers = /** @type {any} */ (fiftyLayers());
    const run = (/** @type {number} */ days) => evaluateAvailability(layers, {
      horizon: [START, START + days * DAY], zone: 'Europe/Amsterdam', provider, policy: 'rfc5545' });
    const small = run(45);
    const large = run(360);
    assert.ok(large.counts.emitted > 7 * small.counts.emitted);
    assert.strictEqual(large.complete, true);
    const ratio = growthRatio(run, 45, 360, { limit: 23 });
    assert.ok(ratio < 23, `an eightfold horizon cost ${ratio.toFixed(1)}x`);
  });
});
