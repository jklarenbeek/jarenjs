//@ts-check

/**
 * The opt-in `Intl` zone provider: the transition corpus - every gap and
 * fold around a dozen real transitions answered exactly per
 * `earlier`/`later`/`reject` against a scripted oracle whose rules are
 * visible - the refusals, the kernel wired through it across a DST
 * boundary, and the three properties that make it safe to ship: it never
 * reads the host's zone, it bundles no table, and importing it costs no
 * `Intl` construction.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { createIntlZoneProvider, ZONE_CACHE_LIMIT } from '@jarenjs/locales/intl-zones';
import { resolveClock, compileBuckets, resampleSeries } from '@jarenjs/core/series';
import { partsFromEpoch } from '@jarenjs/core/dates/civil';
import { epochOfRFC3339Parts } from '@jarenjs/core/dates/rfc3339';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PROVIDER_SOURCE = readFileSync(resolve(REPO_ROOT, 'packages/locales/src/intl-zones.js'), 'utf8');

/** Run one module snippet in a child node with a chosen environment. */
function runNode(source, env = {}) {
  return execFileSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

const MINUTE = 60000;
const HOUR = 3600000;
const DAY = 86400000;
const iso = (epoch) => (Number.isNaN(epoch) ? 'NaN' : new Date(epoch).toISOString());
const sameAnswer = (a, b) => Object.is(a, b) || (Number.isNaN(a) && Number.isNaN(b));
/** A wall clock as the kernel spells it. */
const wall = (year, month, day, hours = 0, minutes = 0, seconds = 0) =>
  ({ year, month, day, hours, minutes, seconds });
const describeWall = (p) => `${p.year}-${p.month}-${p.day}T${p.hours}:${p.minutes}:${p.seconds}`;

/**
 * The corpus. One record per transition: the instant the clock changed,
 * and the offset (minutes east) in force before and after it. A rule is
 * only claimed for the day either side, which is all the sweeps read.
 * Every instant below was checked against the host's ICU before it was
 * written, and every one is settled law or history rather than a rule
 * that might still move.
 */
const TRANSITIONS = [
  { what: 'a spring-forward gap', zone: 'Europe/Amsterdam', at: Date.UTC(2026, 2, 29, 1), before: 60, after: 120 },
  { what: 'a fall-back fold', zone: 'Europe/Amsterdam', at: Date.UTC(2026, 9, 25, 1), before: 120, after: 60 },
  { what: 'a gap west of Greenwich', zone: 'America/New_York', at: Date.UTC(2026, 2, 8, 7), before: -300, after: -240 },
  { what: 'a fold west of Greenwich', zone: 'America/New_York', at: Date.UTC(2026, 10, 1, 6), before: -240, after: -300 },
  { what: 'a southern-hemisphere autumn fold', zone: 'Australia/Sydney', at: Date.UTC(2026, 3, 4, 16), before: 660, after: 600 },
  { what: 'a southern-hemisphere spring gap', zone: 'Australia/Sydney', at: Date.UTC(2026, 9, 3, 16), before: 600, after: 660 },
  { what: 'a half-hour zone folding', zone: 'Australia/Adelaide', at: Date.UTC(2026, 3, 4, 16, 30), before: 630, after: 570 },
  { what: 'a half-hour zone gapping', zone: 'Australia/Adelaide', at: Date.UTC(2026, 9, 3, 16, 30), before: 570, after: 630 },
  { what: 'a midnight gap: the day has no 00:00', zone: 'America/Santiago', at: Date.UTC(2026, 8, 6, 4), before: -240, after: -180 },
  { what: 'a historical offset change forward', zone: 'Europe/Moscow', at: Date.UTC(2011, 2, 26, 23), before: 180, after: 240 },
  { what: 'a historical offset change back', zone: 'Europe/Moscow', at: Date.UTC(2014, 9, 25, 22), before: 240, after: 180 },
  { what: 'the day that never happened', zone: 'Pacific/Apia', at: Date.UTC(2011, 11, 30, 10), before: -600, after: 840 },
  { what: 'a sub-minute historical offset', zone: 'Africa/Monrovia', at: Date.UTC(1972, 0, 7, 0, 44, 30), before: -44.5, after: 0 },
];

/** Zones with nothing to disambiguate, swept the same way on a DST day. */
const STEADY = [
  { what: 'a non-hour offset', zone: 'Asia/Kolkata', offset: 330 },
  { what: 'a quarter-hour offset', zone: 'Asia/Kathmandu', offset: 345 },
  { what: 'no DST', zone: 'Asia/Tokyo', offset: 540 },
  { what: 'the canonical UTC alias', zone: 'Etc/UTC', offset: 0 },
].map((steady) => ({ ...steady, at: Date.UTC(2026, 2, 29, 1), before: steady.offset, after: steady.offset }));

/**
 * The oracle: the same scripted provider the kernel is tested with,
 * parameterised by one transition. Its rules are visible, so a
 * disagreement is a defect in the `Intl` provider rather than a fact
 * inherited from whatever tzdata the host was last updated to.
 */
function oracle(rule) {
  const offsetAt = (epoch) => (epoch < rule.at ? rule.before : rule.after);
  const offsets = rule.before === rule.after ? [rule.before] : [rule.before, rule.after];
  return {
    offsetAt,
    toParts: (epoch) => partsFromEpoch(epoch, offsetAt(epoch)),
    toEpoch: (parts, disambiguation) => {
      const candidates = offsets.map((offset) => epochOfRFC3339Parts({ ...parts, offset }));
      const valid = candidates.filter((epoch, i) => offsetAt(epoch) === offsets[i]);
      if (valid.length === 1) return valid[0];
      if (disambiguation === 'earlier') return Math.min(...candidates);
      if (disambiguation === 'later') return Math.max(...candidates);
      return NaN;
    },
  };
}

describe('createIntlZoneProvider — the transition corpus', () => {
  const provider = createIntlZoneProvider();

  for (const rule of [...TRANSITIONS, ...STEADY]) {
    const expected = oracle(rule);
    const gap = rule.after > rule.before;
    const fold = rule.after < rule.before;

    it(`${rule.zone}: ${rule.what} — toParts round-trips for a day either side`, () => {
      for (let t = rule.at - 12 * HOUR; t <= rule.at + 12 * HOUR; t += 15 * MINUTE) {
        const parts = provider.toParts(t, rule.zone);
        assert.deepStrictEqual(parts, expected.toParts(t), `${rule.zone} at ${iso(t)}`);
        const reject = provider.toEpoch(parts, rule.zone, 'reject');
        const earlier = provider.toEpoch(parts, rule.zone, 'earlier');
        const later = provider.toEpoch(parts, rule.zone, 'later');
        // an instant reads back as itself unless its wall clock happened
        // twice, and then it is one of the two
        assert.ok(Number.isNaN(reject) || reject === t, `${iso(t)} rejected as ${iso(reject)}`);
        assert.ok(earlier === t || later === t, `${iso(t)} came back as ${iso(earlier)} / ${iso(later)}`);
      }
    });

    it(`${rule.zone}: ${rule.what} — toEpoch answers every wall clock exactly, all three ways`, () => {
      let unresolved = 0;
      const lo = rule.at + Math.min(rule.before, rule.after) * MINUTE - 12 * HOUR;
      const hi = rule.at + Math.max(rule.before, rule.after) * MINUTE + 12 * HOUR;
      for (let w = lo; w <= hi; w += 15 * MINUTE) {
        const parts = partsFromEpoch(w, 0);
        for (const disambiguation of ['reject', 'earlier', 'later']) {
          const got = provider.toEpoch(parts, rule.zone, disambiguation);
          const want = expected.toEpoch(parts, disambiguation);
          assert.ok(sameAnswer(got, want),
            `${rule.zone} ${describeWall(parts)} ${disambiguation}: ${iso(got)}, oracle ${iso(want)}`);
        }
        if (Number.isNaN(provider.toEpoch(parts, rule.zone, 'reject'))) {
          unresolved += 1;
          const earlier = provider.toEpoch(parts, rule.zone, 'earlier');
          const later = provider.toEpoch(parts, rule.zone, 'later');
          assert.strictEqual(later - earlier, Math.abs(rule.after - rule.before) * MINUTE,
            `${describeWall(parts)}: the two answers are one transition apart`);
          const readsBack = (epoch) => {
            const p = provider.toParts(epoch, rule.zone);
            return p.year === parts.year && p.month === parts.month && p.day === parts.day
              && p.hours === parts.hours && p.minutes === parts.minutes;
          };
          if (fold) assert.ok(readsBack(earlier) && readsBack(later), `${describeWall(parts)} happened twice`);
          if (gap) assert.ok(!readsBack(earlier) && !readsBack(later), `${describeWall(parts)} never happened`);
        }
      }
      // the sweep must have met the transition, or it proved nothing
      const width = Math.abs(rule.after - rule.before) * MINUTE;
      const expectedUnresolved = gap || fold ? Math.ceil(width / (15 * MINUTE)) : 0;
      assert.strictEqual(unresolved, expectedUnresolved,
        `${rule.zone}: ${unresolved} wall clocks were unresolved, ${expectedUnresolved} expected`);
    });
  }
});

describe('createIntlZoneProvider — named answers', () => {
  const provider = createIntlZoneProvider();
  const gap = wall(2026, 3, 29, 2, 30);
  const fold = wall(2026, 10, 25, 2, 30);

  it('resolves the Amsterdam gap and fold exactly as the kernel documents', () => {
    assert.strictEqual(iso(provider.toEpoch(gap, 'Europe/Amsterdam', 'reject')), 'NaN');
    assert.strictEqual(iso(provider.toEpoch(gap, 'Europe/Amsterdam', 'earlier')), '2026-03-29T00:30:00.000Z');
    assert.strictEqual(iso(provider.toEpoch(gap, 'Europe/Amsterdam', 'later')), '2026-03-29T01:30:00.000Z');
    assert.strictEqual(iso(provider.toEpoch(fold, 'Europe/Amsterdam', 'reject')), 'NaN');
    assert.strictEqual(iso(provider.toEpoch(fold, 'Europe/Amsterdam', 'earlier')), '2026-10-25T00:30:00.000Z');
    assert.strictEqual(iso(provider.toEpoch(fold, 'Europe/Amsterdam', 'later')), '2026-10-25T01:30:00.000Z');
    // the default disambiguation is the kernel's
    assert.strictEqual(iso(provider.toEpoch(fold, 'Europe/Amsterdam')), 'NaN');
  });

  it('answers a whole skipped day: 30 December 2011 never happened in Samoa', () => {
    const noon = wall(2011, 12, 30, 12);
    assert.ok(Number.isNaN(provider.toEpoch(noon, 'Pacific/Apia', 'reject')));
    assert.strictEqual(iso(provider.toEpoch(noon, 'Pacific/Apia', 'earlier')), '2011-12-29T22:00:00.000Z');
    assert.strictEqual(iso(provider.toEpoch(noon, 'Pacific/Apia', 'later')), '2011-12-30T22:00:00.000Z');
    assert.strictEqual(provider.toParts(Date.UTC(2011, 11, 30, 9), 'Pacific/Apia').day, 29);
    assert.strictEqual(provider.toParts(Date.UTC(2011, 11, 30, 11), 'Pacific/Apia').day, 31);
  });

  it('carries a sub-minute offset exactly, in minutes east', () => {
    const parts = provider.toParts(Date.UTC(1972, 0, 7, 0, 30), 'Africa/Monrovia');
    assert.deepStrictEqual(parts, { year: 1972, month: 1, day: 6, hours: 23, minutes: 45, seconds: 30, offset: -44.5 });
    assert.ok(Number.isNaN(provider.toEpoch(wall(1972, 1, 7, 0, 15), 'Africa/Monrovia')));
    assert.strictEqual(provider.toEpoch(wall(1972, 1, 6, 23, 45, 30), 'Africa/Monrovia'), Date.UTC(1972, 0, 7, 0, 30));
  });

  it('keeps milliseconds and fractional seconds through both directions', () => {
    const at = Date.UTC(2026, 6, 1, 6, 30, 30, 250);
    const parts = provider.toParts(at, 'Asia/Kolkata');
    assert.strictEqual(parts.seconds, 30.25);
    assert.strictEqual(parts.offset, 330);
    assert.strictEqual(provider.toEpoch(parts, 'Asia/Kolkata'), at);
    assert.strictEqual(provider.toEpoch(wall(2026, 7, 1, 12, 0, 30.25), 'Asia/Kolkata'), at);
  });

  it('keeps a year below 100 and a year before 1 as the kernel counts them', () => {
    assert.strictEqual(provider.toParts(Date.UTC(-50, 0, 1), 'Etc/UTC').year, -50);
    const fiftyAD = new Date(0);
    fiftyAD.setUTCFullYear(50, 0, 1);
    fiftyAD.setUTCHours(0, 0, 0, 0);
    assert.strictEqual(provider.toParts(fiftyAD.getTime(), 'Asia/Tokyo').year, 50);
    assert.strictEqual(provider.toEpoch(wall(50, 1, 1), 'Etc/UTC'), fiftyAD.getTime());
    // and Tokyo in the year 50 is its local mean time, not +09:00: the
    // provider answers what the host's tzdata says, never a rounded guess
    assert.strictEqual(provider.toEpoch(wall(50, 1, 1), 'Asia/Tokyo'), fiftyAD.getTime() - (9 * HOUR + 18 * MINUTE + 59000));
  });

  it('reads an absent or negative time member as midnight, the way the kernel does', () => {
    assert.strictEqual(provider.toEpoch({ year: 2026, month: 7, day: 1 }, 'Asia/Tokyo'), Date.UTC(2026, 5, 30, 15));
    assert.strictEqual(provider.toEpoch({ year: 2026, month: 7, day: 1, hours: -1, minutes: -1, seconds: -1 }, 'Asia/Tokyo'),
      Date.UTC(2026, 5, 30, 15));
  });

  it('refuses a disambiguation it does not have and a wall clock that is not a record', () => {
    assert.throws(() => provider.toEpoch(gap, 'Europe/Amsterdam', 'nearest'), /'reject', 'earlier', 'later', not 'nearest'/);
    assert.throws(() => provider.toEpoch(null, 'Europe/Amsterdam'), /a wall clock is a parts record/);
    assert.throws(() => provider.toParts(Number.NaN, 'Europe/Amsterdam'), /finite number of epoch milliseconds/);
    assert.throws(() => provider.toParts('0', 'Europe/Amsterdam'), /finite number of epoch milliseconds/);
    // beyond what a Date can hold: refused by name here, never ICU's own
    // 'Invalid time value' that names nothing
    assert.throws(() => provider.toParts(8.7e15, 'Asia/Tokyo'), /within ±8640000000000000, not 8700000000000000/);
    assert.throws(() => provider.toParts(-8.7e15, 'Asia/Tokyo'), /within ±8640000000000000/);
    assert.ok(Number.isNaN(provider.toEpoch(wall(275760, 9, 13), 'Etc/UTC')), 'the last representable day names no instant a probe can bracket');
    assert.ok(Number.isNaN(provider.toEpoch(wall(300000, 1, 1), 'Etc/UTC')));
    assert.ok(Number.isNaN(provider.toEpoch(wall(-1, 1, 1), 'Etc/UTC')), 'a wall clock before year 0 names no instant');
  });
});

describe('createIntlZoneProvider — the refusals', () => {
  const provider = createIntlZoneProvider();

  it('refuses an unknown IANA name by name, never a quiet UTC', () => {
    assert.throws(() => provider.toParts(0, 'Mars/Olympus'), /'Mars\/Olympus' is not a time zone this host's ICU knows/);
    assert.throws(() => provider.toEpoch(wall(2026, 1, 1), 'Mars/Olympus'), /'Mars\/Olympus' is not a time zone/);
    assert.throws(() => provider.toParts(0, 'Europe/Amsterdam '), /'Europe\/Amsterdam ' is not a time zone/);
    // and a name that is not given at all is a refusal too: there is no
    // "the host's" zone to fall back on
    for (const missing of [undefined, null, '', 0]) {
      assert.throws(() => provider.toParts(0, /** @type {any} */ (missing)), /a zone is an IANA name, given explicitly/);
      assert.throws(() => provider.toEpoch(wall(2026, 1, 1), /** @type {any} */ (missing)), /a zone is an IANA name, given explicitly/);
    }
  });

  it('is a refusal through the kernel as well, naming the zone', () => {
    const clock = resolveClock({ zone: 'Mars/Olympus', provider });
    assert.throws(() => clock.partsAt(0), /'Mars\/Olympus' is not a time zone/);
    assert.throws(() => clock.epochOf(wall(2026, 1, 1)), /'Mars\/Olympus' is not a time zone/);
  });

  it('turns a rejected gap and fold into the kernel\'s refusal naming the local time', () => {
    const clock = resolveClock({ zone: 'Europe/Amsterdam', provider });
    assert.throws(() => clock.epochOf(wall(2026, 3, 29, 2, 30)),
      /2026-03-29T02:30:00 in 'Europe\/Amsterdam' is ambiguous or does not exist, and disambiguation is 'reject'/);
    assert.throws(() => clock.epochOf(wall(2026, 10, 25, 2, 30)),
      /2026-10-25T02:30:00 in 'Europe\/Amsterdam' is ambiguous or does not exist, and disambiguation is 'reject'/);
    const earlier = resolveClock({ zone: 'Europe/Amsterdam', provider, disambiguation: 'earlier' });
    const later = resolveClock({ zone: 'Europe/Amsterdam', provider, disambiguation: 'later' });
    assert.strictEqual(iso(earlier.epochOf(wall(2026, 10, 25, 2, 30))), '2026-10-25T00:30:00.000Z');
    assert.strictEqual(iso(later.epochOf(wall(2026, 10, 25, 2, 30))), '2026-10-25T01:30:00.000Z');
    assert.strictEqual(later.epochOf(wall(2026, 10, 25, 2, 30)) - earlier.epochOf(wall(2026, 10, 25, 2, 30)), HOUR);
  });
});

describe('createIntlZoneProvider — the bounded formatter cache', () => {
  it('has a documented, positive cap and refuses any other', () => {
    assert.ok(Number.isInteger(ZONE_CACHE_LIMIT) && ZONE_CACHE_LIMIT > 0);
    assert.throws(() => createIntlZoneProvider({ zones: 0 }), /positive whole number/);
    assert.throws(() => createIntlZoneProvider({ zones: 1.5 }), /positive whole number/);
    assert.throws(() => createIntlZoneProvider({ zones: /** @type {any} */ ('8') }), /positive whole number/);
  });

  it('answers the same after eviction as before it', () => {
    const small = createIntlZoneProvider({ zones: 2 });
    const reference = createIntlZoneProvider();
    const zones = ['Europe/Amsterdam', 'America/New_York', 'Australia/Adelaide', 'Asia/Kolkata', 'Europe/Amsterdam'];
    const at = Date.UTC(2026, 2, 29, 1, 30);
    for (let round = 0; round < 3; round++) {
      for (const zone of zones) {
        assert.deepStrictEqual(small.toParts(at, zone), reference.toParts(at, zone), zone);
        assert.strictEqual(small.toEpoch(wall(2026, 3, 29, 2, 30), zone, 'later'),
          reference.toEpoch(wall(2026, 3, 29, 2, 30), zone, 'later'), zone);
      }
    }
    // an unknown zone is refused every time, and never occupies a slot
    for (let i = 0; i < 3; i++)
      assert.throws(() => small.toParts(at, 'Mars/Olympus'), /'Mars\/Olympus' is not a time zone/);
  });
});

describe('createIntlZoneProvider — through @jarenjs/core/series across a DST boundary', () => {
  const provider = createIntlZoneProvider();
  const amsterdam = { zone: 'Europe/Amsterdam', provider };

  it('keeps every daily boundary on local midnight across the 23-hour and the 25-hour day', () => {
    const b = compileBuckets('P1D', amsterdam);
    assert.strictEqual(iso(b.floor(Date.UTC(2026, 2, 28, 12))), '2026-03-27T23:00:00.000Z');
    assert.strictEqual(iso(b.floor(Date.UTC(2026, 2, 29, 12))), '2026-03-28T23:00:00.000Z');
    assert.strictEqual(iso(b.floor(Date.UTC(2026, 2, 30, 12))), '2026-03-29T22:00:00.000Z');
    assert.strictEqual(iso(b.floor(Date.UTC(2026, 9, 25, 12))), '2026-10-24T22:00:00.000Z');
    assert.strictEqual(iso(b.floor(Date.UTC(2026, 9, 26, 12))), '2026-10-25T23:00:00.000Z');
  });

  it('lands a monthly ladder on the first of the month, local, not 24 hours later', () => {
    const b = compileBuckets('P1M', amsterdam);
    assert.strictEqual(iso(b.floor(Date.UTC(2026, 2, 15))), '2026-02-28T23:00:00.000Z');
    assert.strictEqual(iso(b.floor(Date.UTC(2026, 3, 15))), '2026-03-31T22:00:00.000Z');
    const rows = [];
    for (let d = 0; d < 120; d++)
      rows.push({ at: Date.UTC(2026, 1, 1, 12) + d * DAY, value: 1 });
    const out = resampleSeries(rows, { every: 'P1M', aggregate: 'count', ...amsterdam });
    assert.deepStrictEqual(out.map((row) => iso(row.at)), [
      '2026-01-31T23:00:00.000Z',
      '2026-02-28T23:00:00.000Z',
      '2026-03-31T22:00:00.000Z',
      '2026-04-30T22:00:00.000Z',
    ]);
    assert.deepStrictEqual(out.map((row) => row.value), [28, 31, 30, 31]);
  });

  it('resamples the 23-hour day into one bucket of 23', () => {
    const rows = [];
    for (let h = 0; h < 72; h++)
      rows.push({ at: Date.UTC(2026, 2, 27, 23) + h * HOUR, value: 1 });
    const out = resampleSeries(rows, { every: 'P1D', aggregate: 'count', ...amsterdam });
    assert.deepStrictEqual(out.map((row) => row.value), [24, 23, 24, 1]);
  });

  it('refuses a daily boundary on a day with no midnight, and resolves it when told how', () => {
    const santiago = { zone: 'America/Santiago', provider };
    assert.throws(() => compileBuckets('P1D', santiago).floor(Date.UTC(2026, 8, 6, 12)),
      /2026-09-06T00:00:00 in 'America\/Santiago' is ambiguous or does not exist, and disambiguation is 'reject'/);
    assert.strictEqual(iso(compileBuckets('P1D', { ...santiago, disambiguation: 'later' }).floor(Date.UTC(2026, 8, 6, 12))),
      '2026-09-06T04:00:00.000Z');
    assert.strictEqual(iso(compileBuckets('P1D', { ...santiago, disambiguation: 'earlier' }).floor(Date.UTC(2026, 8, 6, 12))),
      '2026-09-06T03:00:00.000Z');
  });

  it('walks a southern-hemisphere half-hour zone through its 25-hour day', () => {
    const b = compileBuckets('P1D', { zone: 'Australia/Adelaide', provider });
    assert.strictEqual(iso(b.floor(Date.UTC(2026, 3, 4, 12))), '2026-04-03T13:30:00.000Z');
    assert.strictEqual(iso(b.floor(Date.UTC(2026, 3, 5, 12))), '2026-04-04T13:30:00.000Z');
    assert.strictEqual(iso(b.floor(Date.UTC(2026, 3, 6, 12))), '2026-04-05T14:30:00.000Z');
  });
});

describe('createIntlZoneProvider — the drift gates', () => {
  it('never reads the host\'s own zone: the answers are the same under any TZ', () => {
    const probe = `
      import { createIntlZoneProvider } from '@jarenjs/locales/intl-zones';
      const p = createIntlZoneProvider();
      const out = [];
      for (const zone of ['Europe/Amsterdam', 'America/Santiago', 'Pacific/Apia', 'Asia/Kathmandu']) {
        for (const [y, m, d, h] of [[2026, 3, 29, 2], [2026, 10, 25, 2], [2011, 12, 30, 12], [2026, 9, 6, 0]]) {
          const parts = { year: y, month: m, day: d, hours: h, minutes: 30, seconds: 0 };
          out.push(zone, p.toEpoch(parts, zone, 'reject'), p.toEpoch(parts, zone, 'earlier'), p.toEpoch(parts, zone, 'later'));
          out.push(JSON.stringify(p.toParts(Date.UTC(y, m - 1, d, h), zone)));
        }
      }
      console.log(out.join('|'));
    `;
    const answers = ['Pacific/Kiritimati', 'America/Anchorage', 'UTC', 'Europe/Amsterdam']
      .map((tz) => runNode(probe, { TZ: tz }));
    for (const answer of answers.slice(1))
      assert.strictEqual(answer, answers[0]);
    assert.ok(answers[0].includes('NaN|'), 'the probe met a gap or a fold');
  });

  it('contains no ambient-zone read in its source', () => {
    for (const forbidden of ['resolvedOptions', 'getTimezoneOffset', 'toLocale', 'toString()', 'timeZone: undefined']) {
      assert.ok(!PROVIDER_SOURCE.includes(forbidden), `the provider source mentions ${forbidden}`);
    }
    // every Date getter or setter it uses is the UTC one
    const localAccessor = /\.(get|set)(?!UTC)(FullYear|Month|Date|Day|Hours|Minutes|Seconds|Milliseconds)\(/;
    assert.ok(!localAccessor.test(PROVIDER_SOURCE), 'the provider source reads a local Date member');
    assert.ok(!/new Date\(\)/.test(PROVIDER_SOURCE), 'the provider source reads the current instant');
  });

  it('bundles nothing: no offset table, no transition table, in locales or in core', () => {
    const zoneSource = readFileSync(resolve(REPO_ROOT, 'packages/core/src/series/zone.js'), 'utf8');
    for (const [name, source] of [['intl-zones.js', PROVIDER_SOURCE], ['zone.js', zoneSource]]) {
      assert.ok(!/\b(1[6-9]|20)\d\d\b/.test(source), `${name} carries a year literal`);
      assert.ok(!/Date\.UTC\(\s*\d/.test(source), `${name} carries an instant literal`);
      assert.ok(!/\b(tzdata|zoneinfo|transitions)\s*[=:[(]/i.test(source), `${name} declares a zone table`);
      assert.ok(!/\[\s*-?\d+\s*,\s*-?\d+\s*,\s*-?\d+/.test(source), `${name} carries a numeric table`);
    }
    assert.ok(!zoneSource.includes('Intl.'), 'the kernel seam reaches for Intl');
    const manifest = JSON.parse(readFileSync(resolve(REPO_ROOT, 'packages/locales/package.json'), 'utf8'));
    assert.deepStrictEqual(Object.keys(manifest.dependencies), ['@jarenjs/core']);
  });

  it('appears only by explicit construction: importing it allocates no Intl object', () => {
    const probe = runNode(`
      let touched = 0;
      globalThis.Intl = new Proxy(Intl, { get(t, k) { touched += 1; return Reflect.get(t, k); } });
      const { resolveClock } = await import('@jarenjs/core/series');
      resolveClock({ offset: 330 }).partsAt(0);
      const afterKernel = touched;
      const { createIntlZoneProvider } = await import('@jarenjs/locales/intl-zones');
      const importedOnly = touched;
      createIntlZoneProvider().toParts(0, 'Europe/Amsterdam');
      console.log(JSON.stringify({ afterKernel, importedOnly, afterIntl: touched }));
    `);
    const counts = JSON.parse(probe);
    assert.strictEqual(counts.afterKernel, 0, 'the kernel reached for Intl');
    assert.strictEqual(counts.importedOnly, 0, 'importing the zone provider allocated at module load');
    assert.ok(counts.afterIntl > 0, 'the zone provider did not use Intl');
  });
});
