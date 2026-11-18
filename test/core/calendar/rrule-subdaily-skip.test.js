//@ts-check

/**
 * A zoned SECONDLY or MINUTELY walk before its horizon, through a
 * provider that lists its offset changes: only the wall-clock hours that
 * hold a change are resolved time by time, and the walk goes on passing
 * the clean hours after them. The answers are compared with the exact
 * walk (the same provider without its list, which resolves every time)
 * over the zdump tables (fixtures/zone-transitions) and a compiled
 * VTIMEZONE; the cost is read from the provider-call counter.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { compileRecurrence, compileVtimezone, expandRecurrence } from '@jarenjs/core/calendar';
import { ORACLE_ZONES, oracleZone, tableProvider } from './oracle.js';

const HOUR = 3600000;
const DAY = 24 * HOUR;
const at = (/** @type {string} */ text) => Date.parse(text);
/** @param {string} zone @param {string} date @param {string} time */
const zoned = (zone, date, time) => ({ kind: /** @type {const} */ ('zoned'), date, time, zone });
/** @param {any} provider */
const bareOf = (provider) => {
  const { offsetChanges, ...bare } = provider;
  assert.equal(typeof offsetChanges, 'function');
  return bare;
};

/** New York by rule from 2007, as the IANA database has it. */
const NEW_YORK = Object.freeze({
  tzid: 'America/New_York',
  observances: [
    { type: 'daylight', start: '2007-03-11T02:00:00', offsetFrom: '-05:00', offsetTo: '-04:00', rrule: 'FREQ=YEARLY;BYMONTH=3;BYDAY=2SU' },
    { type: 'standard', start: '2007-11-04T02:00:00', offsetFrom: '-04:00', offsetTo: '-05:00', rrule: 'FREQ=YEARLY;BYMONTH=11;BYDAY=1SU' },
  ],
});

describe('a zoned sub-daily walk passes the clean hours after an hour holding a change', () => {
  const zone = compileVtimezone(NEW_YORK, { horizon: [Date.UTC(2020, 0, 1), Date.UTC(2031, 0, 1)] });
  const bare = bareOf(zone);
  const limits = { maxProviderCalls: 1000000 };

  it('SECONDLY through a compiled VTIMEZONE: the hours at the change cost a call per time, every other hour of the day two', () => {
    // the day before each horizon starts at local midnight, so the change (02:00 local) lies at its start: the rest of the
    // day, about 22 hours of seconds, was resolved second by second once the walk met the change hour
    for (const low of ['2026-03-09T00:00:00Z', '2026-11-02T00:00:00Z']) {
      const rule = compileRecurrence({ dtstart: zoned(zone.tzid, '2026-03-01', '00:00:00'), rrule: 'FREQ=SECONDLY' });
      const horizon = [at(low), at(low) + 10000];
      const listed = expandRecurrence(rule, { horizon, zoneProvider: zone, limits });
      const asked = expandRecurrence(rule, { horizon, zoneProvider: bare, limits });
      assert.equal(listed.status, 'complete');
      assert.deepEqual(listed.occurrences, asked.occurrences, low);
      assert.equal(listed.occurrences.length, 10);
      // the hour whose end falls in the gap or fold, the change's own hour, and (spring) the hour starting at the
      // change's instant: at most three hours of 3600 seconds, plus two calls an hour
      assert.ok(listed.counts.providerCalls < 3 * 3600 + 2 * 26 + 100, `${low}: ${listed.counts.providerCalls} provider calls`);
      assert.ok(asked.counts.providerCalls > 60000, `${low}: ${asked.counts.providerCalls} provider calls without the list`);
    }
  });

  it('with COUNT the walk counts every time from DTSTART and asks only about the day before the horizon', () => {
    const rule = compileRecurrence({ dtstart: zoned(zone.tzid, '2026-03-07', '00:00:00'), rrule: 'FREQ=SECONDLY;COUNT=1000000' });
    const horizon = [at('2026-03-09T00:00:00Z'), at('2026-03-09T00:00:10Z')];
    const listed = expandRecurrence(rule, { horizon, zoneProvider: zone, limits });
    const asked = expandRecurrence(rule, { horizon, zoneProvider: bare, limits });
    assert.deepEqual(listed.occurrences, asked.occurrences);
    assert.equal(listed.occurrences.length, 10);
    assert.ok(listed.counts.providerCalls < 3 * 3600 + 2 * 26 + 100, `${listed.counts.providerCalls} provider calls`);
  });

  it('the calls grow with the hours holding a change, not with the times: one change pair against eight', () => {
    // a made-up zone moving +01:00 -> +01:20 and back, `pairs` times in the day before the horizon, two hours apart
    const tableOf = (/** @type {number} */ pairs) => ({
      initial: 60,
      changes: Array.from({ length: pairs }, (_, i) => [
        { at: at('2026-03-01T00:10:00Z') + i * 2 * HOUR, before: 60, after: 80 },
        { at: at('2026-03-01T01:10:00Z') + i * 2 * HOUR, before: 80, after: 60 },
      ]).flat(),
    });
    const rule = compileRecurrence({ dtstart: zoned('Test/Pairs', '2026-02-27', '00:00:00'), rrule: 'FREQ=MINUTELY' });
    const horizon = [at('2026-03-02T00:00:00Z'), at('2026-03-02T00:10:00Z')];
    /** @type {number[]} */
    const calls = [];
    for (const pairs of [1, 8]) {
      const listing = tableProvider('Test/Pairs', tableOf(pairs));
      const listed = expandRecurrence(rule, { horizon, zoneProvider: listing, limits });
      const asked = expandRecurrence(rule, { horizon, zoneProvider: bareOf(listing), limits });
      assert.deepEqual(listed.occurrences, asked.occurrences, `${pairs}`);
      assert.equal(listed.occurrences.length, 10);
      // each change makes at most three unclean hours of 60 minutes; every hour costs two calls
      assert.ok(listed.counts.providerCalls >= pairs * 2 * 60, `${pairs}: ${listed.counts.providerCalls}`);
      assert.ok(listed.counts.providerCalls <= pairs * 2 * 3 * 60 + 2 * 26 + 40, `${pairs}: ${listed.counts.providerCalls}`);
      assert.ok(asked.counts.providerCalls > 1440, `${pairs}: ${asked.counts.providerCalls} without the list`);
      calls.push(listed.counts.providerCalls);
    }
    // eight times the changes: the calls past the hourly two grow by four to ten times; the times did not change
    const growth = (calls[1] - 2 * 26) / (calls[0] - 2 * 26);
    assert.ok(growth > 4 && growth < 10, `${calls[0]} -> ${calls[1]}`);
  });
});

describe('the walk that resumes skipping answers as the exact walk does, over the zdump tables', () => {
  const RULES = ['FREQ=MINUTELY;INTERVAL=7', 'FREQ=SECONDLY;INTERVAL=37', 'FREQ=MINUTELY;INTERVAL=5;COUNT=100000'];
  for (const name of ORACLE_ZONES.filter((zone) => zone !== 'UTC')) {
    const table = oracleZone(name);
    const listing = tableProvider(name, table);
    const bare = bareOf(listing);
    // every change of 2026 (and Apia's of 2011, the skipped day among them)
    const changes = table.changes.filter((change) => new Date(change.at).getUTCFullYear() === (name === 'Pacific/Apia' ? 2011 : 2026));
    it(`${name}: ${changes.length} changes, the horizon 5 minutes to 23 hours after each, both policies`, () => {
      assert.ok(changes.length >= 2);
      for (const change of changes) {
        const day = new Date(change.at - 2 * DAY).toISOString().slice(0, 10);
        for (const rrule of RULES) {
          for (const policy of /** @type {const} */ (['rfc5545', 'later'])) {
            const rule = compileRecurrence({ dtstart: zoned(name, day, '00:00:00'), rrule, policy });
            for (const after of [5 * 60000, 20 * 60000, 2 * HOUR, 12 * HOUR, 23 * HOUR]) {
              const horizon = [change.at + after, change.at + after + 2 * HOUR];
              const listed = expandRecurrence(rule, { horizon, zoneProvider: listing, limits: { maxProviderCalls: 1000000 } });
              const asked = expandRecurrence(rule, { horizon, zoneProvider: bare, limits: { maxProviderCalls: 1000000 } });
              const label = `${new Date(change.at).toISOString()} + ${after / 60000} min ${rrule} ${policy}`;
              assert.equal(listed.status, 'complete', label);
              assert.ok(listed.occurrences.length > 0, label);
              assert.deepEqual(listed.occurrences, asked.occurrences, label);
            }
          }
        }
      }
    });
  }

  it('Amsterdam\'s gap: a clean hour after it whose times start before the horizon, while the gap hour\'s own do not', () => {
    // 2026-03-29 01:00Z: 02:00 becomes 03:00. The gap's 02:20-02:55 start at 01:20Z-01:55Z (offset before the change);
    // the next hour's 03:00-03:15 start at 01:00Z-01:15Z, before a horizon starting 01:20Z, and are passed over
    const listing = tableProvider('Europe/Amsterdam', oracleZone('Europe/Amsterdam'));
    const rule = compileRecurrence({ dtstart: zoned('Europe/Amsterdam', '2026-03-27', '00:00:00'), rrule: 'FREQ=MINUTELY;INTERVAL=5' });
    const whole = expandRecurrence(rule, { horizon: [at('2026-03-28T20:00:00Z'), at('2026-03-29T03:00:00Z')], zoneProvider: listing });
    for (const low of ['2026-03-29T01:05:00Z', '2026-03-29T01:20:00Z', '2026-03-29T01:40:00Z', '2026-03-29T02:00:00Z']) {
      const horizon = [at(low), at('2026-03-29T03:00:00Z')];
      const listed = expandRecurrence(rule, { horizon, zoneProvider: listing });
      assert.deepEqual(listed.occurrences, expandRecurrence(rule, { horizon, zoneProvider: bareOf(listing) }).occurrences, low);
      assert.deepEqual(listed.occurrences, whole.occurrences.filter((o) => /** @type {any} */ (o.instants).start >= at(low)), low);
    }
    const ids = expandRecurrence(rule, { horizon: [at('2026-03-29T01:20:00Z'), at('2026-03-29T01:30:00Z')], zoneProvider: listing })
      .occurrences.map((o) => o.recurrenceId.slice(11, 16));
    assert.deepEqual(ids, ['02:20', '03:20', '02:25', '03:25']);
  });
});
