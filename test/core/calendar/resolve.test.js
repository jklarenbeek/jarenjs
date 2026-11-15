//@ts-check

/**
 * Classifying and resolving a local time, proved against an oracle the
 * code under test never touches: a fixed-offset table of every change
 * 2000-2040 for New York, Amsterdam, Lord Howe (a 30-minute change) and
 * Apia (the skipped 2011-12-30), plus UTC. Every 30 minutes across every
 * change the classification and every policy's instant must equal the
 * table's; the named gap and fold cases are pinned outright; and a
 * provider without `candidates` is refused, never guessed through.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { classifyLocal, resolveLocal, RESOLUTION_POLICIES, CalendarError, CALENDAR_CODES } from '@jarenjs/core/calendar';
import { createIntlZoneProvider } from '@jarenjs/locales/intl-zones';
import { ORACLE_ZONES, oracleZone, oracleClassify, sweepOf, partsOf } from './oracle.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MINUTE = 60000;
const provider = createIntlZoneProvider({ revision: 'pinned-for-test' });
const iso = (/** @type {number} */ epoch) => new Date(epoch).toISOString();

/**
 * @param {string} code
 * @returns {(error: unknown) => boolean}
 */
const refusal = (code) => (error) => error instanceof CalendarError && error.code === code;

describe('the oracle sweep: every 30 minutes across every change 2000-2040', () => {
  for (const zone of ORACLE_ZONES) {
    it(`${zone}: classification and every policy's instant match the transcribed table`, () => {
      const table = oracleZone(zone);
      const walls = sweepOf(zone);
      const seen = new Map();
      for (const { wall, change } of walls) {
        const parts = partsOf(wall);
        const expected = oracleClassify(table, wall);
        const at = `${zone} ${iso(wall).slice(0, 16)} local`;
        assert.deepStrictEqual({ ...classifyLocal(parts, zone, provider) }, expected, at);
        if (expected.kind !== 'exists')
          seen.set(change, expected.kind);
        for (const policy of RESOLUTION_POLICIES) {
          let want;
          if (expected.kind === 'exists')
            want = expected.candidates[0];
          else if (policy === 'reject')
            want = null;
          else if (expected.kind === 'fold')
            want = expected.candidates[policy === 'later' ? 1 : 0];
          else {
            const offsets = /** @type {{ before: number, after: number }} */ (expected.offsets);
            want = { instant: wall - offsets.before * MINUTE, offsetMinutes: offsets.after };
          }
          if (want === null) {
            assert.throws(() => resolveLocal(parts, zone, { provider, policy }),
              refusal(expected.kind === 'gap' ? 'JY0002' : 'JY0003'), `${at} ${policy}`);
            continue;
          }
          const { instant, resolution } = resolveLocal(parts, zone, { provider, policy });
          assert.strictEqual(iso(instant), iso(want.instant), `${at} ${policy}`);
          assert.deepStrictEqual({ ...resolution }, {
            kind: expected.kind, policy, zone, offsetMinutes: want.offsetMinutes,
            provider: { name: 'intl', revision: 'pinned-for-test' },
          }, `${at} ${policy}`);
        }
      }
      // every change was met inside its gap or fold, so no change was
      // swept past - Lord Howe's 30-minute spans included
      assert.strictEqual(seen.size, table.changes.length, `${zone}: changes met in their span`);
      assert.ok(walls.length > 0);
    });
  }

  it('the table holds the changes the database lists for 2000-2040', () => {
    assert.deepStrictEqual([...ORACLE_ZONES], ['America/New_York', 'Europe/Amsterdam', 'Australia/Lord_Howe', 'Pacific/Apia', 'UTC']);
    assert.strictEqual(oracleZone('Pacific/Apia').changes.length, 23);
    assert.strictEqual(oracleZone('UTC').changes.length, 0);
    for (const zone of ['America/New_York', 'Europe/Amsterdam', 'Australia/Lord_Howe'])
      assert.strictEqual(oracleZone(zone).changes.length, 82, zone);
  });
});

describe('the named cases, pinned', () => {
  const at = (year, month, day, hours, minutes = 0) => ({ year, month, day, hours, minutes });

  it('Amsterdam 2026-03-29 02:30 is a gap; rfc5545 and later move it forward, reject refuses it', () => {
    const parts = at(2026, 3, 29, 2, 30);
    assert.deepStrictEqual(classifyLocal(parts, 'Europe/Amsterdam', provider),
      { kind: 'gap', candidates: [], offsets: { before: 60, after: 120 } });
    for (const policy of ['rfc5545', 'later']) {
      const { instant, resolution } = resolveLocal(parts, 'Europe/Amsterdam', { provider, policy: /** @type {any} */ (policy) });
      assert.strictEqual(iso(instant), '2026-03-29T01:30:00.000Z', policy);
      assert.strictEqual(resolution.kind, 'gap');
      assert.strictEqual(resolution.offsetMinutes, 120);
    }
    assert.throws(() => resolveLocal(parts, 'Europe/Amsterdam', { provider, policy: 'reject' }),
      (error) => refusal('JY0002')(error) && /** @type {Error} */ (error).message
        === "JY0002: 2026-03-29T02:30:00 never happens in 'Europe/Amsterdam': the clock moves from +01:00 to +02:00 at /parts");
  });

  it('Amsterdam 2026-10-25 02:30 is a fold; rfc5545 takes the earlier, later the later, reject refuses it', () => {
    const parts = at(2026, 10, 25, 2, 30);
    const found = classifyLocal(parts, 'Europe/Amsterdam', provider);
    assert.strictEqual(found.kind, 'fold');
    assert.deepStrictEqual(found.candidates.map((c) => [iso(c.instant), c.offsetMinutes]),
      [['2026-10-25T00:30:00.000Z', 120], ['2026-10-25T01:30:00.000Z', 60]]);
    assert.deepStrictEqual(found.offsets, { before: 120, after: 60 });
    assert.strictEqual(iso(resolveLocal(parts, 'Europe/Amsterdam', { provider, policy: 'rfc5545' }).instant),
      '2026-10-25T00:30:00.000Z');
    assert.strictEqual(iso(resolveLocal(parts, 'Europe/Amsterdam', { provider, policy: 'later' }).instant),
      '2026-10-25T01:30:00.000Z');
    assert.throws(() => resolveLocal(parts, 'Europe/Amsterdam', { provider, policy: 'reject' }),
      (error) => refusal('JY0003')(error) && /** @type {Error} */ (error).message
        === "JY0003: 2026-10-25T02:30:00 happens twice in 'Europe/Amsterdam': at +02:00 and again at +01:00 at /parts");
  });

  it('New York 2026-03-08 02:30 is a gap and 2026-11-01 01:30 a fold', () => {
    assert.strictEqual(iso(resolveLocal(at(2026, 3, 8, 2, 30), 'America/New_York', { provider, policy: 'rfc5545' }).instant),
      '2026-03-08T07:30:00.000Z');
    assert.strictEqual(iso(resolveLocal(at(2026, 11, 1, 1, 30), 'America/New_York', { provider, policy: 'rfc5545' }).instant),
      '2026-11-01T05:30:00.000Z');
    assert.strictEqual(iso(resolveLocal(at(2026, 11, 1, 1, 30), 'America/New_York', { provider, policy: 'later' }).instant),
      '2026-11-01T06:30:00.000Z');
  });

  it('Lord Howe moves 30 minutes: 2026-10-04 02:00 is a gap, 2026-04-05 01:30 a fold', () => {
    assert.deepStrictEqual(classifyLocal(at(2026, 10, 4, 2, 0), 'Australia/Lord_Howe', provider),
      { kind: 'gap', candidates: [], offsets: { before: 630, after: 660 } });
    assert.strictEqual(classifyLocal(at(2026, 10, 4, 2, 30), 'Australia/Lord_Howe', provider).kind, 'exists');
    assert.strictEqual(iso(resolveLocal(at(2026, 10, 4, 2, 0), 'Australia/Lord_Howe', { provider, policy: 'rfc5545' }).instant),
      '2026-10-03T15:30:00.000Z');
    const fold = classifyLocal(at(2026, 4, 5, 1, 30), 'Australia/Lord_Howe', provider);
    assert.deepStrictEqual(fold.candidates.map((c) => [iso(c.instant), c.offsetMinutes]),
      [['2026-04-04T14:30:00.000Z', 660], ['2026-04-04T15:00:00.000Z', 630]]);
  });

  it('Apia skipped 2011-12-30: every hour of it is one gap a day wide', () => {
    for (const hours of [0, 12, 23]) {
      assert.deepStrictEqual(classifyLocal(at(2011, 12, 30, hours), 'Pacific/Apia', provider),
        { kind: 'gap', candidates: [], offsets: { before: -600, after: 840 } }, `hour ${hours}`);
    }
    const noon = resolveLocal(at(2011, 12, 30, 12), 'Pacific/Apia', { provider, policy: 'rfc5545' });
    assert.strictEqual(iso(noon.instant), '2011-12-30T22:00:00.000Z');  // 2011-12-31 12:00 at +14:00
    assert.strictEqual(noon.resolution.offsetMinutes, 840);
    assert.strictEqual(classifyLocal(at(2011, 12, 29, 23, 30), 'Pacific/Apia', provider).kind, 'exists');
    assert.strictEqual(classifyLocal(at(2011, 12, 31, 0, 0), 'Pacific/Apia', provider).kind, 'exists');
  });

  it('UTC has neither: every local time exists once', () => {
    const found = classifyLocal(at(2026, 3, 29, 2, 30), 'UTC', provider);
    assert.deepStrictEqual(found, { kind: 'exists', candidates: [{ instant: Date.parse('2026-03-29T02:30:00Z'), offsetMinutes: 0 }] });
  });

  it('a millisecond fraction is kept, and the answers are frozen', () => {
    const { instant, resolution } = resolveLocal({ year: 2026, month: 7, day: 1, hours: 9, minutes: 0, seconds: 5.25 },
      'Europe/Amsterdam', { provider, policy: 'reject' });
    assert.strictEqual(iso(instant), '2026-07-01T07:00:05.250Z');
    assert.ok(Object.isFrozen(resolution) && Object.isFrozen(resolution.provider));
    const found = classifyLocal({ year: 2026, month: 10, day: 25, hours: 2 }, 'Europe/Amsterdam', provider);
    assert.ok(Object.isFrozen(found) && Object.isFrozen(found.candidates) && Object.isFrozen(found.candidates[0])
      && Object.isFrozen(found.offsets));
  });
});

describe('policies are named, never defaulted', () => {
  const parts = { year: 2026, month: 7, day: 1, hours: 9 };

  it('no policy is JY0006, even for a time that exists', () => {
    assert.throws(() => resolveLocal(parts, 'Europe/Amsterdam', /** @type {any} */ ({ provider })), refusal('JY0006'));
    assert.throws(() => resolveLocal(parts, 'Europe/Amsterdam', /** @type {any} */ (undefined)), refusal('JY0006'));
    assert.throws(() => resolveLocal(parts, 'Europe/Amsterdam', /** @type {any} */ ({ provider, policy: null })), refusal('JY0006'));
  });

  it('an unknown policy is JY0005, including the seam\'s own disambiguation names', () => {
    for (const policy of ['earlier', 'compatible', 'RFC5545', '', 5545]) {
      assert.throws(() => resolveLocal(parts, 'Europe/Amsterdam', /** @type {any} */ ({ provider, policy })),
        refusal('JY0005'), String(policy));
    }
  });

  it('lists exactly the three policies', () => {
    assert.deepStrictEqual(RESOLUTION_POLICIES, ['rfc5545', 'later', 'reject']);
    assert.ok(Object.isFrozen(RESOLUTION_POLICIES));
  });
});

describe('parts that are not a civil date and time are refused before the provider is asked', () => {
  // an impossible date reads back as another wall clock, as a gap does:
  // without this refusal a policy would "resolve" the thirtieth of February
  const counting = () => {
    let calls = 0;
    return {
      provider: { ...provider, candidates: (p, z) => { calls++; return provider.candidates(p, z); } },
      calls: () => calls,
    };
  };

  for (const [label, parts, path] of /** @type {[string, any, string][]} */ ([
    ['February 30', { year: 2026, month: 2, day: 30 }, '/parts/day'],
    ['February 29 off a leap year', { year: 2026, month: 2, day: 29 }, '/parts/day'],
    ['month 13', { year: 2026, month: 13, day: 1 }, '/parts/month'],
    ['hour 24', { year: 2026, month: 3, day: 29, hours: 24 }, '/parts/hours'],
    ['hour 25', { year: 2026, month: 3, day: 29, hours: 25 }, '/parts/hours'],
    ['a negative hour', { year: 2026, month: 3, day: 29, hours: -1 }, '/parts/hours'],
    ['minute 60', { year: 2026, month: 3, day: 29, hours: 2, minutes: 60 }, '/parts/minutes'],
    ['a leap second', { year: 2026, month: 3, day: 29, hours: 2, seconds: 60 }, '/parts/seconds'],
    ['a fractional minute', { year: 2026, month: 3, day: 29, hours: 2, minutes: 30.5 }, '/parts/minutes'],
    ['year 10000', { year: 10000, month: 1, day: 1 }, '/parts/year'],
    ['a negative year', { year: -1, month: 1, day: 1 }, '/parts/year'],
    ['a string year', { year: '2026', month: 1, day: 1 }, '/parts/year'],
    ['NaN seconds', { year: 2026, month: 1, day: 1, seconds: NaN }, '/parts/seconds'],
    ['a fraction past the millisecond', { year: 2026, month: 1, day: 1, seconds: 59.9996 }, '/parts/seconds'],
    ['a microsecond', { year: 2026, month: 1, day: 1, seconds: 5.000001 }, '/parts/seconds'],
    ['null', null, '/parts'],
    ['an array', [2026, 3, 29], '/parts'],
  ])) {
    it(`${label} is JY0007 at ${path}`, () => {
      const probe = counting();
      const check = (error) => refusal('JY0007')(error) && /** @type {any} */ (error).docPath === path;
      assert.throws(() => classifyLocal(parts, 'Europe/Amsterdam', probe.provider), check);
      assert.throws(() => resolveLocal(parts, 'Europe/Amsterdam', { provider: probe.provider, policy: 'later' }), check);
      assert.strictEqual(probe.calls(), 0);
    });
  }

  it('a whole-millisecond fraction is admitted', () => {
    for (const seconds of [5.123, 59.999, 1.005, 0.1 + 0.2]) {
      const { instant } = resolveLocal({ year: 2026, month: 1, day: 1, seconds }, 'UTC', { provider, policy: 'reject' });
      assert.strictEqual(instant, Date.UTC(2026, 0, 1, 0, 0, 0, Math.round(seconds * 1000)), String(seconds));
    }
  });

  it('absent time members are midnight, and February 29 of a leap year exists', () => {
    assert.strictEqual(iso(resolveLocal({ year: 2028, month: 2, day: 29 }, 'UTC', { provider, policy: 'reject' }).instant),
      '2028-02-29T00:00:00.000Z');
  });

  it('a parts record\'s own offset is not read: the zone decides', () => {
    const { instant } = resolveLocal(/** @type {any} */ ({ year: 2026, month: 7, day: 1, hours: 9, offset: -300 }),
      'Europe/Amsterdam', { provider, policy: 'reject' });
    assert.strictEqual(iso(instant), '2026-07-01T07:00:00.000Z');
  });
});

describe('the provider seam', () => {
  const parts = { year: 2026, month: 3, day: 29, hours: 2, minutes: 30 };

  it('a provider without candidates is refused with JY0004, never guessed through toEpoch', () => {
    let toEpochCalls = 0;
    const legacy = {
      toParts: provider.toParts,
      toEpoch: (/** @type {any[]} */ ...args) => { toEpochCalls++; return provider.toEpoch(args[0], args[1], args[2]); },
    };
    assert.throws(() => classifyLocal(parts, 'Europe/Amsterdam', /** @type {any} */ (legacy)), refusal('JY0004'));
    for (const policy of RESOLUTION_POLICIES) {
      assert.throws(() => resolveLocal(parts, 'Europe/Amsterdam', { provider: /** @type {any} */ (legacy), policy }),
        refusal('JY0004'), policy);
    }
    assert.strictEqual(toEpochCalls, 0);
    for (const bad of [undefined, null, 'intl', {}]) {
      assert.throws(() => classifyLocal(parts, 'Europe/Amsterdam', /** @type {any} */ (bad)), refusal('JY0004'), String(bad));
      assert.throws(() => resolveLocal(parts, 'Europe/Amsterdam', /** @type {any} */ ({ provider: bad, policy: 'later' })),
        refusal('JY0004'), String(bad));
    }
  });

  it('an unknown zone is JY0001, carrying what the provider threw', () => {
    assert.throws(() => classifyLocal(parts, 'Mars/Olympus', provider),
      (error) => refusal('JY0001')(error) && /** @type {any} */ (error).cause instanceof TypeError
        && /Mars\/Olympus/.test(/** @type {Error} */ (error).message));
    for (const zone of ['', undefined, null, 42])
      assert.throws(() => classifyLocal(parts, /** @type {any} */ (zone), provider), refusal('JY0001'), String(zone));
  });

  it('a provider whose candidates throws for a known zone is JY0004 with the cause', () => {
    const broken = { ...provider, candidates: () => { throw new RangeError('boom'); } };
    assert.throws(() => classifyLocal(parts, 'Europe/Amsterdam', broken),
      (error) => refusal('JY0004')(error) && /** @type {any} */ (error).cause instanceof RangeError);
  });

  it('a malformed candidates answer is JY0004, never a classification', () => {
    const answering = (answer) => ({ ...provider, candidates: () => answer });
    for (const [label, answer] of /** @type {[string, any][]} */ ([
      ['no answer', undefined],
      ['a bare array', [{ instant: 0, offsetMinutes: 0 }]],
      ['three candidates', { candidates: [1, 2, 3].map((instant) => ({ instant, offsetMinutes: 0 })) }],
      ['a candidate without an offset', { candidates: [{ instant: 0 }] }],
      ['a non-finite instant', { candidates: [{ instant: NaN, offsetMinutes: 0 }] }],
      ['a descending fold', { candidates: [{ instant: 2, offsetMinutes: 60 }, { instant: 1, offsetMinutes: 120 }] }],
      ['a repeated instant', { candidates: [{ instant: 1, offsetMinutes: 60 }, { instant: 1, offsetMinutes: 60 }] }],
      ['a gap without offsets', { candidates: [] }],
      ['a gap with a half offsets record', { candidates: [], offsets: { before: 60 } }],
    ])) {
      assert.throws(() => classifyLocal(parts, 'Europe/Amsterdam', answering(answer)), refusal('JY0004'), label);
    }
  });

  it('a fold answered without offsets takes them from its two candidates', () => {
    const fold = { ...provider, candidates: () => ({ candidates: [{ instant: 1, offsetMinutes: 120 }, { instant: 2, offsetMinutes: 60 }] }) };
    assert.deepStrictEqual(classifyLocal(parts, 'Europe/Amsterdam', fold).offsets, { before: 120, after: 60 });
  });

  it('a resolution names the provider: its identity, or unrecorded', () => {
    const anonymous = { toParts: provider.toParts, toEpoch: provider.toEpoch, candidates: provider.candidates };
    const exists = { year: 2026, month: 7, day: 1, hours: 9 };
    assert.deepStrictEqual(resolveLocal(exists, 'Europe/Amsterdam', { provider: anonymous, policy: 'later' }).resolution.provider,
      { name: 'unrecorded', revision: 'unrecorded' });
    assert.deepStrictEqual(resolveLocal(exists, 'Europe/Amsterdam', { provider: createIntlZoneProvider(), policy: 'later' })
      .resolution.provider, { name: 'intl', revision: 'unrecorded' });
    const own = { ...anonymous, identity: { name: 'table', revision: 'r7' } };
    const recorded = resolveLocal(exists, 'Europe/Amsterdam', { provider: own, policy: 'later' }).resolution.provider;
    assert.deepStrictEqual(recorded, { name: 'table', revision: 'r7' });
    assert.ok(Object.isFrozen(recorded));
    for (const identity of [null, 'intl', { name: 'x' }, { name: '', revision: 'r' }, { name: 'x', revision: 7 }]) {
      assert.throws(() => resolveLocal(exists, 'Europe/Amsterdam', { provider: { ...anonymous, identity }, policy: 'later' }),
        refusal('JY0004'), JSON.stringify(identity));
    }
  });

  it('agrees with the seam\'s toEpoch: later is toEpoch later, rfc5545 is earlier in a fold and later in a gap', () => {
    for (const zone of ORACLE_ZONES) {
      for (const { wall } of sweepOf(zone)) {
        const parts = partsOf(wall);
        const kind = classifyLocal(parts, zone, provider).kind;
        const rfc = resolveLocal(parts, zone, { provider, policy: 'rfc5545' }).instant;
        const later = resolveLocal(parts, zone, { provider, policy: 'later' }).instant;
        assert.strictEqual(later, provider.toEpoch(parts, zone, 'later'), `${zone} ${iso(wall)}`);
        assert.strictEqual(rfc, provider.toEpoch(parts, zone, kind === 'fold' ? 'earlier' : 'later'), `${zone} ${iso(wall)}`);
        if (kind === 'exists')
          assert.strictEqual(rfc, provider.toEpoch(parts, zone, 'reject'));
        else
          assert.ok(Number.isNaN(provider.toEpoch(parts, zone, 'reject')));
      }
    }
  });
});

describe('the host zone is never read', () => {
  it('answers the same digest under TZ=UTC, Asia/Tokyo and America/Los_Angeles', () => {
    const probe = `
      import { classifyLocal, resolveLocal } from '@jarenjs/core/calendar';
      import { createIntlZoneProvider } from '@jarenjs/locales/intl-zones';
      const provider = createIntlZoneProvider();
      const out = [];
      for (const zone of ['Europe/Amsterdam', 'Australia/Lord_Howe', 'Pacific/Apia'])
        for (const [y, m, d] of [[2026, 3, 29], [2026, 10, 25], [2026, 10, 4], [2026, 4, 5], [2011, 12, 30]])
          for (let h = 0; h < 24; h++)
            for (const minutes of [0, 30]) {
              const parts = { year: y, month: m, day: d, hours: h, minutes };
              const c = classifyLocal(parts, zone, provider);
              out.push(c.kind + ':' + c.candidates.map((x) => x.instant).join('/') + ':'
                + resolveLocal(parts, zone, { provider, policy: 'later' }).instant);
            }
      console.log(out.join('|'));
    `;
    const answers = ['UTC', 'Asia/Tokyo', 'America/Los_Angeles'].map((tz) => execFileSync(process.execPath,
      ['--input-type=module', '-e', probe], { cwd: REPO_ROOT, encoding: 'utf8', env: { ...process.env, TZ: tz, FORCE_COLOR: '0' } }));
    assert.strictEqual(answers[1], answers[0]);
    assert.strictEqual(answers[2], answers[0]);
    assert.ok(answers[0].includes('gap:') && answers[0].includes('fold:'));
  });
});

describe('the code table', () => {
  it('allocates fourteen codes, each thrown by this layer', () => {
    assert.deepStrictEqual(Object.keys(CALENDAR_CODES), ['JY0001', 'JY0002', 'JY0003', 'JY0004', 'JY0005', 'JY0006', 'JY0007',
      'JY0008', 'JY0009', 'JY0010', 'JY0011', 'JY0012', 'JY0013', 'JY0014']);
    const error = new CalendarError('JY0002', 'a reason', '/parts');
    assert.strictEqual(error.name, 'CalendarError');
    assert.strictEqual(error.message, 'JY0002: a reason at /parts');
    assert.ok(!Object.hasOwn(error, 'cause'));
  });
});
