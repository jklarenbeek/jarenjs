//@ts-check
/**
 * @file A specification is closed: a member the kernel does not know is
 * a refusal, not a silent default.
 *
 * `minPeriod` for `minPeriods`, `agregate` for `aggregate`, `timezone`
 * for `zone` — every one of them used to be accepted and ignored, so
 * the answer was a plausible number computed from a specification
 * nobody wrote. The zone case is the worst of them: a named zone with
 * no provider is a refusal (`zone.js`), but a MISSPELLED zone member
 * fell all the way through to UTC, which is right for Amsterdam for
 * none of the year and looks right for eight months of it — exactly
 * the failure the zone seam exists to prevent.
 *
 * `@jarenjs/json` has refused an unknown spec member since the five
 * operators arrived. This file holds the KERNEL to the same rule, and
 * `test/json/query/series-ops.test.js` pins that both layers read the
 * one list.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  resampleSeries, rollingSeries, asOfJoin, downsampleSeries,
  findSlots, mergeIntervals,
  RESAMPLE_MEMBERS, ROLLING_MEMBERS, ASOF_MEMBERS, DOWNSAMPLE_MEMBERS,
  SLOTS_MEMBERS, MERGE_MEMBERS, CLOCK_MEMBERS,
} from '@jarenjs/core/series';

const ROWS = [{ at: 0, value: 1 }, { at: 1000, value: 2 }];
const SPANS = [{ start: 0, end: 10 }, { start: 10, end: 20 }];

/** Every kernel that takes a specification, with a valid one and the closed list. */
const KERNELS = [
  { name: 'resampleSeries', members: RESAMPLE_MEMBERS,
    run: (spec) => resampleSeries(ROWS, { every: 1000, ...spec }) },
  { name: 'rollingSeries', members: ROLLING_MEMBERS,
    run: (spec) => rollingSeries(ROWS, { width: 1000, ...spec }) },
  { name: 'asOfJoin', members: ASOF_MEMBERS,
    run: (spec) => asOfJoin(ROWS, ROWS, { ...spec }) },
  { name: 'downsampleSeries', members: DOWNSAMPLE_MEMBERS,
    run: (spec) => downsampleSeries(ROWS, { target: 2, ...spec }) },
  { name: 'findSlots', members: SLOTS_MEMBERS,
    run: (spec) => findSlots(SPANS, { duration: 5, ...spec }) },
  { name: 'mergeIntervals', members: MERGE_MEMBERS,
    run: (spec) => mergeIntervals(SPANS, { ...spec }) },
];

describe('a kernel specification is closed', () => {
  for (const { name, run } of KERNELS) {
    it(`${name} refuses a member it does not know`, () => {
      assert.throws(() => run({ notAMember: 1 }),
        (error) => {
          assert.ok(error instanceof TypeError, `${name} threw ${error}`);
          assert.match(/** @type {Error} */ (error).message, /notAMember/,
            'the refusal names the member that was not admitted');
          return true;
        });
    });

    it(`${name} still answers every member it does admit`, () => {
      assert.doesNotThrow(() => run({}));
    });
  }

  it('names the near miss, because that is the whole cost of the bug', () => {
    // one letter, and the window silently had no minimum at all
    assert.throws(() => rollingSeries(ROWS, { width: 1000, minPeriod: 2 }),
      /minPeriod.*minPeriods/s);
    assert.throws(() => resampleSeries(ROWS, { every: 1000, agregate: 'sum' }),
      /agregate.*aggregate/s);
  });

  it('a misspelled zone member is a refusal, never a quiet UTC answer', () => {
    // the one that matters most: `zone` with no provider already
    // refuses, so the only way to reach a silent UTC ladder was to
    // misspell the member the refusal keys on
    assert.throws(() => resampleSeries(ROWS, { every: 'P1D', timezone: 'Europe/Amsterdam' }),
      /timezone.*'zone'/s);
    assert.throws(() => resampleSeries(ROWS, { every: 'P1D', zone: 'Europe/Amsterdam' }),
      /needs a provider/);
  });

  it('the case of a member is part of its name', () => {
    assert.throws(() => resampleSeries(ROWS, { every: 1000, Fill: 'zero' }), /Fill/);
    assert.throws(() => rollingSeries(ROWS, { width: 1000, Width: 5 }), /Width/);
  });

  it('every published list is frozen and non-empty', () => {
    for (const { name, members } of KERNELS) {
      assert.ok(Object.isFrozen(members), `${name}'s member list is not frozen`);
      assert.ok(members.length > 0, `${name} publishes no members`);
      assert.deepStrictEqual([...new Set(members)], [...members],
        `${name}'s member list repeats itself`);
    }
  });
});

describe('the language and the kernel read ONE list', () => {
  it('spells every kernel member a document can carry, and only those', async () => {
    // §8.16's `$resample` and `$rolling` specs are the kernel's own
    // members, minus the one JSON has no value for. A member added to a
    // kernel therefore reaches the language in the same change, and a
    // member the language grew alone fails right here.
    const json = await import('../../../packages/json/src/query/series.js');
    const NO_VALUE_IN_JSON = ['provider'];
    for (const [name, kernel] of /** @type {[string, readonly string[]][]} */ ([
      ['CLOCK_MEMBERS', CLOCK_MEMBERS],
      ['RESAMPLE_MEMBERS', RESAMPLE_MEMBERS],
      ['ROLLING_MEMBERS', ROLLING_MEMBERS],
    ])) {
      assert.deepStrictEqual([...json[name]],
        kernel.filter((member) => !NO_VALUE_IN_JSON.includes(member)),
        `${name} disagrees between @jarenjs/core/series and the query language`);
    }
    // a function is not a JSON value, so the provider is the one member
    // a document cannot spell; it arrives as `options.zoneProvider`
    assert.ok(CLOCK_MEMBERS.includes('provider'));
    assert.ok(!json.CLOCK_MEMBERS.includes('provider'));
  });

  it('translates the as-of spec rather than sharing it, and both are closed', async () => {
    // the one operator whose document spelling differs: `asOfJoin` takes
    // nested `left`/`right` selector records and §8.16 flattens them, so
    // the two lists are the same SIZE and a different vocabulary
    const json = await import('../../../packages/json/src/query/series.js');
    assert.deepStrictEqual([...ASOF_MEMBERS], ['direction', 'tolerance', 'key', 'left', 'right']);
    assert.deepStrictEqual([...json.ASOF_MEMBERS],
      ['direction', 'tolerance', 'by', 'leftAt', 'rightAt']);
    assert.strictEqual(ASOF_MEMBERS.length, json.ASOF_MEMBERS.length,
      'a member on one side with no spelling on the other is a hole');
  });
});
