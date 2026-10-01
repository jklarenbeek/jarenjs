//@ts-check
/**
 * @file The ledger contract as one reusable harness (docs/CONTRACT-FORMAT.md
 * §8): every claim state, the stored-response replay, the two failure
 * kinds, expiry on claim and lookup, `sweep`, the id spelling, and the
 * generation fence — a ref of an earlier generation settles nothing and
 * the settlement is refused by code. `createMemoryLedger`, the §8.1
 * `node:sqlite` example and `createDbLedger` (`@jarenjs/linq/db`) all
 * run it: one semantic oracle, three implementations. Every call is
 * awaited, so a synchronous ledger and an asynchronous one fit alike.
 *
 * `ledgerLifecycleContract` adds the rules of a ledger a host operates
 * (both suite ledgers carry them): a failure for good carries the
 * response it replays, a `started` claim blocks its key only for its
 * lease (`startedTtlMs`), and `inFlight` / `release` find and free the
 * claims an interrupted request left behind.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { ledgerId } from '@jarenjs/contract/ledger';

export const CLAIM = { op: 'product.save', scope: '', key: 'k1', hash: 'a'.repeat(64) };
export const RESPONSE = { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' }, body: '{"id":1}' };

/**
 * @typedef {Object} LedgerUnderTest
 * @property {any} ledger - the ledger (claim/commit/fail/lookup/sweep)
 * @property {string} staleCode - the code a stale or repeated settlement is refused with
 * @property {string} [failCode] - the code `fail(ref, false)` without a response is refused with
 * @property {() => any} [close]
 */

/**
 * @typedef {(options: { ttlMs?: number, startedTtlMs?: number, now?: () => number }) => LedgerUnderTest | Promise<LedgerUnderTest>} LedgerFactory
 */

/** @param {LedgerUnderTest} under @param {() => Promise<void>} body */
async function using(under, body) {
  try {
    await body();
  }
  finally {
    if (under.close !== undefined) await under.close();
  }
}

/** @param {LedgerFactory} factory @param {boolean} failure */
async function expiredSettlement(factory, failure) {
  for (const explicit of [true, false]) {
    for (const when of [1049, 1050, 1051]) {
      let at = 1000;
      let reads = 0;
      const under = await factory({ ttlMs: 50, now: () => { reads++; return at; } });
      await using(under, async () => {
        const { ledger, staleCode } = under;
        const claimed = await ledger.claim({ ...CLAIM, now: 1000 });
        at = when;
        reads = 0;
        const now = explicit ? at : undefined;
        const settle = async () => failure
          ? ledger.fail(claimed.ref, false, RESPONSE, now)
          : ledger.commit(claimed.ref, RESPONSE, now);
        if (at < 1050) {
          await settle();
          assert.strictEqual(reads, explicit ? 0 : 1, 'one instant judges and stamps a settlement');
          const record = await ledger.lookup({ ...CLAIM, now: at });
          assert.strictEqual(record.status, failure ? 'failed' : 'committed');
          assert.strictEqual(record.updatedAt, 1049);
        }
        else {
          await assert.rejects(settle, (/** @type {any} */ err) => err.code === staleCode,
            `a ${failure ? 'failure' : 'commit'} at ${at} cannot settle a claim expiring at 1050`);
          assert.strictEqual(reads, explicit ? 0 : 1, 'expiry uses the same single clock read');
          const renewed = await ledger.claim({ ...CLAIM, now: at });
          assert.strictEqual(renewed.state, 'new');
          assert.notStrictEqual(renewed.ref.generation, claimed.ref.generation);
          assert.deepStrictEqual(await ledger.claim({ ...CLAIM, now: at }), { state: 'in-progress' });
        }
      });
    }
  }
}

/**
 * The cases, each over a fresh ledger from the factory; exported one by
 * one so a test can prove a case FAILS against a ledger whose fence was
 * removed.
 * @type {Record<string, (factory: LedgerFactory) => Promise<void>>}
 */
export const cases = {
  async states(factory) {
    const under = await factory({ now: () => 1000 });
    await using(under, async () => {
      const { ledger } = under;
      const first = await ledger.claim({ ...CLAIM, now: 1000 });
      assert.strictEqual(first.state, 'new');
      assert.strictEqual(typeof first.ref.id, 'string');
      assert.strictEqual(typeof first.ref.generation, 'string');
      assert.ok(first.ref.generation.length > 0);
      // in-progress while started; mismatch beats it on a different hash
      assert.deepStrictEqual(await ledger.claim({ ...CLAIM, now: 1001 }), { state: 'in-progress' });
      assert.deepStrictEqual(await ledger.claim({ ...CLAIM, hash: 'b'.repeat(64), now: 1001 }), { state: 'mismatch' });
      await ledger.commit(first.ref, RESPONSE, 1002);
      assert.deepStrictEqual(await ledger.claim({ ...CLAIM, now: 1002 }), { state: 'replay', response: RESPONSE });
      const record = await ledger.lookup({ ...CLAIM, now: 1003 });
      assert.strictEqual(record.id, ledgerId(CLAIM.op, CLAIM.scope, CLAIM.key));
      assert.strictEqual(record.generation, first.ref.generation);
      assert.strictEqual(record.status, 'committed');
      assert.strictEqual(record.retryable, null);
      assert.deepStrictEqual(record.response, RESPONSE);
      assert.deepStrictEqual([record.op, record.scope, record.key, record.hash], [CLAIM.op, CLAIM.scope, CLAIM.key, CLAIM.hash]);
      assert.strictEqual(record.createdAt, 1000);
      assert.strictEqual(record.updatedAt, 1002);
      // the record is the caller's copy: mutating it changes nothing stored
      record.status = 'started';
      assert.strictEqual((await ledger.lookup({ ...CLAIM, now: 1003 })).status, 'committed');
    });
  },

  async failures(factory) {
    const under = await factory({ now: () => 1000 });
    await using(under, async () => {
      const { ledger } = under;
      // a retryable failure hands the key back; a non-retryable one replays
      const again = await ledger.claim({ ...CLAIM, key: 'k2', now: 1000 });
      await ledger.fail(again.ref, true, undefined, 1000);
      const rec = await ledger.lookup({ ...CLAIM, key: 'k2', now: 1000 });
      assert.strictEqual(rec.status, 'failed');
      assert.strictEqual(rec.retryable, true);
      assert.strictEqual(rec.response, null);
      const reclaimed = await ledger.claim({ ...CLAIM, key: 'k2', now: 1001 });
      assert.strictEqual(reclaimed.state, 'new');
      assert.notStrictEqual(reclaimed.ref.generation, again.ref.generation, 'a re-run is a new generation');
      const third = await ledger.claim({ ...CLAIM, key: 'k3', now: 1000 });
      const failure = { status: 412, headers: {}, body: '{"code":"JC2014"}' };
      await ledger.fail(third.ref, false, failure, 1000);
      assert.deepStrictEqual(await ledger.claim({ ...CLAIM, key: 'k3', now: 1001 }), { state: 'replay', response: failure });
      assert.strictEqual((await ledger.lookup({ ...CLAIM, key: 'k3', now: 1001 })).retryable, false);
    });
  },

  async expiry(factory) {
    let at = 1000;
    const under = await factory({ ttlMs: 50, now: () => at });
    await using(under, async () => {
      const { ledger } = under;
      const a = await ledger.claim({ ...CLAIM, now: 1000 });
      await ledger.commit(a.ref, RESPONSE, 1000);
      assert.notStrictEqual(await ledger.lookup({ ...CLAIM, now: 1000 }), null);
      at = 1051; // past expiresAt: the key is new again, the record gone on lookup
      const other = await ledger.claim({ ...CLAIM, key: 'other', now: 1051 });
      assert.strictEqual(other.state, 'new');
      assert.strictEqual(await ledger.lookup({ ...CLAIM, now: 1051 }), null);
      const renewed = await ledger.claim({ ...CLAIM, now: 1051 });
      assert.strictEqual(renewed.state, 'new', 'an expired key is claimed afresh');
      assert.notStrictEqual(renewed.ref.generation, a.ref.generation);
      at = 1200;
      assert.strictEqual(await ledger.sweep(1200), 2, 'the surviving claims expired too');
      assert.strictEqual(await ledger.lookup({ ...CLAIM, key: 'other', now: 1200 }), null);
    });
  },

  async fence(factory) {
    const under = await factory({ now: () => 1000 });
    await using(under, async () => {
      const { ledger, staleCode } = under;
      const first = await ledger.claim({ ...CLAIM, now: 1000 });
      await ledger.fail(first.ref, true, undefined, 1000); // released: the key may re-run
      const second = await ledger.claim({ ...CLAIM, now: 1001 });
      assert.strictEqual(second.state, 'new');
      assert.notStrictEqual(second.ref.generation, first.ref.generation);
      // the dead ref: refused by code, the re-claim untouched (a failure
      // for good carries its response, so the stale one does too)
      await assert.rejects(async () => ledger.commit(first.ref, { status: 200, headers: {}, body: 'STALE' }, 1002),
        (/** @type {any} */ err) => err.code === staleCode);
      await assert.rejects(async () => ledger.fail(first.ref, false, { status: 400, headers: {}, body: 'STALE' }, 1002),
        (/** @type {any} */ err) => err.code === staleCode);
      assert.deepStrictEqual(await ledger.claim({ ...CLAIM, now: 1002 }), { state: 'in-progress' });
      assert.strictEqual((await ledger.lookup({ ...CLAIM, now: 1002 })).generation, second.ref.generation);
      await ledger.commit(second.ref, RESPONSE, 1003);
      assert.deepStrictEqual(await ledger.claim({ ...CLAIM, now: 1003 }), { state: 'replay', response: RESPONSE });
      // a settled record is settled once
      await assert.rejects(async () => ledger.commit(second.ref, RESPONSE, 1004), (/** @type {any} */ err) => err.code === staleCode);
      // a ref this ledger never issued
      await assert.rejects(async () => ledger.commit({ id: 'nope', generation: 'x' }, RESPONSE, 1004), (/** @type {any} */ err) => err.code === staleCode);
      await assert.rejects(async () => ledger.fail(null, true, undefined, 1004), (/** @type {any} */ err) => err.code === staleCode);
    });
  },

  /** A failure for good replays its response, so it must carry one:
   * without it the settlement is refused and the claim stays started. */
  async missingResponse(factory) {
    const under = await factory({ now: () => 1000 });
    await using(under, async () => {
      const { ledger, failCode } = under;
      assert.ok(typeof failCode === 'string', 'the ledger under test names its refusal code');
      const claimed = await ledger.claim({ ...CLAIM, now: 1000 });
      for (const response of [undefined, null]) {
        await assert.rejects(async () => ledger.fail(claimed.ref, false, response, 1001),
          (/** @type {any} */ err) => err.code === failCode, `fail(ref, false, ${response})`);
      }
      // nothing changed: the claim is still in progress, not a key to re-run
      assert.deepStrictEqual(await ledger.claim({ ...CLAIM, now: 1002 }), { state: 'in-progress' });
      assert.strictEqual((await ledger.lookup({ ...CLAIM, now: 1002 })).status, 'started');
      // a retryable failure needs no response; one for good, with its response, settles
      const failure = { status: 422, headers: {}, body: '{"code":"JC2003"}' };
      await ledger.fail(claimed.ref, false, failure, 1003);
      assert.deepStrictEqual(await ledger.claim({ ...CLAIM, now: 1004 }), { state: 'replay', response: failure });
    });
  },

  /** A started claim blocks its key for its lease only; a settled one is
   * retained for `ttlMs` from its claim. */
  async startedLease(factory) {
    let at = 1000;
    const under = await factory({ ttlMs: 1000, startedTtlMs: 50, now: () => at });
    await using(under, async () => {
      const { ledger, staleCode } = under;
      const first = await ledger.claim({ ...CLAIM, now: 1000 });
      at = 1049;
      assert.deepStrictEqual(await ledger.claim({ ...CLAIM, now: 1049 }), { state: 'in-progress' });
      at = 1050; // the lease ran out: the interrupted claim no longer blocks the key
      const second = await ledger.claim({ ...CLAIM, now: 1050 });
      assert.strictEqual(second.state, 'new');
      assert.notStrictEqual(second.ref.generation, first.ref.generation, 'reclaimed under a new generation');
      // the interrupted request's late settlement is fenced off
      await assert.rejects(async () => ledger.commit(first.ref, RESPONSE, 1051), (/** @type {any} */ err) => err.code === staleCode);
      await ledger.commit(second.ref, RESPONSE, 1060);
      // settled, it is retained from its claim for ttlMs — far past the lease
      at = 2000;
      assert.deepStrictEqual(await ledger.claim({ ...CLAIM, now: 2000 }), { state: 'replay', response: RESPONSE });
      assert.strictEqual((await ledger.lookup({ ...CLAIM, now: 2000 })).expiresAt, 1050 + 1000);
      at = 2050;
      assert.strictEqual(await ledger.lookup({ ...CLAIM, now: 2050 }), null);
    });
  },

  /** `inFlight` lists the claims still blocking their key, oldest first. */
  async inFlight(factory) {
    let at = 1000;
    const under = await factory({ ttlMs: 1000, startedTtlMs: 100, now: () => at });
    await using(under, async () => {
      const { ledger } = under;
      const b = await ledger.claim({ ...CLAIM, key: 'b', now: 1010 });
      const a = await ledger.claim({ ...CLAIM, key: 'a', now: 1000 });
      const other = await ledger.claim({ ...CLAIM, op: 'order.place', key: 'c', now: 1020 });
      const done = await ledger.claim({ ...CLAIM, key: 'done', now: 1005 });
      await ledger.commit(done.ref, RESPONSE, 1006);
      at = 1030;
      const all = await ledger.inFlight({ now: 1030 });
      assert.deepStrictEqual(all, [
        { op: CLAIM.op, scope: CLAIM.scope, key: 'a', generation: a.ref.generation, claimedAt: 1000 },
        { op: CLAIM.op, scope: CLAIM.scope, key: 'b', generation: b.ref.generation, claimedAt: 1010 },
        { op: 'order.place', scope: CLAIM.scope, key: 'c', generation: other.ref.generation, claimedAt: 1020 },
      ], 'started claims only, oldest first');
      assert.deepStrictEqual((await ledger.inFlight({ op: 'order.place', now: 1030 })).map((c) => c.key), ['c']);
      assert.deepStrictEqual((await ledger.inFlight({ olderThan: 1010, now: 1030 })).map((c) => c.key), ['a']);
      assert.deepStrictEqual((await ledger.inFlight({ limit: 2, now: 1030 })).map((c) => c.key), ['a', 'b']);
      assert.deepStrictEqual(await ledger.inFlight({ scope: 'elsewhere', now: 1030 }), []);
      // a claim whose lease ran out blocks nothing, so it is not in flight
      at = 1105;
      assert.deepStrictEqual((await ledger.inFlight({ now: 1105 })).map((c) => c.key), ['b', 'c']);
      await assert.rejects(async () => ledger.inFlight({ opp: 'x' }), (/** @type {any} */ err) => err instanceof TypeError && /'op'/.test(err.message));
      await assert.rejects(async () => ledger.inFlight({ limit: 0 }), TypeError);
      // a tie breaks by the id in code-point order, the order a database
      // compares text by: U+FF01 comes before U+1F600, whose UTF-16 form
      // (a surrogate pair from U+D83D) would sort first
      const astral = await ledger.claim({ ...CLAIM, key: 'tie-\u{1F600}', now: 1110 });
      const high = await ledger.claim({ ...CLAIM, key: 'tie-\uFF01', now: 1110 });
      assert.deepStrictEqual((await ledger.inFlight({ olderThan: 1111, now: 1110 })).filter((c) => c.claimedAt === 1110)
        .map((c) => c.generation), [high.ref.generation, astral.ref.generation]);
    });
  },

  /** A lease is whole milliseconds on every ledger. */
  async wholeMilliseconds(factory) {
    for (const options of [{ ttlMs: 1000.5 }, { ttlMs: 1000, startedTtlMs: 100.5 }, { ttlMs: 2 ** 53 }]) {
      await assert.rejects(async () => factory(options),
        (/** @type {any} */ err) => err instanceof TypeError && /whole number of milliseconds/.test(err.message), JSON.stringify(options));
    }
  },

  /** `release` frees one interrupted claim as a server fault would. */
  async release(factory) {
    const under = await factory({ now: () => 1000 });
    await using(under, async () => {
      const { ledger, staleCode } = under;
      const claimed = await ledger.claim({ ...CLAIM, now: 1000 });
      // a generation that is not the claim's releases nothing
      assert.strictEqual(await ledger.release({ ...tuple(CLAIM), generation: 'another', now: 1001 }), false);
      assert.strictEqual((await ledger.lookup({ ...CLAIM, now: 1001 })).status, 'started');
      assert.strictEqual(await ledger.release({ ...tuple(CLAIM), generation: claimed.ref.generation, now: 1002 }), true);
      const record = await ledger.lookup({ ...CLAIM, now: 1002 });
      assert.deepStrictEqual([record.status, record.retryable, record.response], ['failed', true, null],
        'exactly what a server fault leaves');
      // twice is nothing
      assert.strictEqual(await ledger.release({ ...tuple(CLAIM), now: 1003 }), false);
      // the interrupted request's own settlement is fenced off, and the key re-runs
      await assert.rejects(async () => ledger.commit(claimed.ref, RESPONSE, 1004), (/** @type {any} */ err) => err.code === staleCode);
      const rerun = await ledger.claim({ ...CLAIM, now: 1005 });
      assert.strictEqual(rerun.state, 'new');
      await ledger.commit(rerun.ref, RESPONSE, 1006);
      // a settled key has nothing to release, and neither has an unknown one
      assert.strictEqual(await ledger.release({ ...tuple(CLAIM), now: 1007 }), false);
      assert.strictEqual(await ledger.release({ ...tuple(CLAIM), key: 'never', now: 1007 }), false);
      assert.deepStrictEqual(await ledger.claim({ ...CLAIM, now: 1008 }), { state: 'replay', response: RESPONSE });
      await assert.rejects(async () => ledger.release({ ...tuple(CLAIM), gen: 'x' }), (/** @type {any} */ err) => err instanceof TypeError && /'generation'/.test(err.message));
      // the recipe for a single-process host at startup: release every
      // claim a previous run left behind
      const left = [await ledger.claim({ ...CLAIM, key: 'x', now: 1010 }), await ledger.claim({ ...CLAIM, key: 'y', now: 1011 })];
      for (const claim of await ledger.inFlight({ now: 1012 })) assert.strictEqual(await ledger.release({ ...claim, now: 1012 }), true);
      assert.deepStrictEqual(await ledger.inFlight({ now: 1013 }), []);
      for (const claim of left) assert.strictEqual((await ledger.claim({ ...CLAIM, key: JSON.parse(claim.ref.id.slice(2))[2], now: 1014 })).state, 'new');
    });
  },

  async ids(factory) {
    const under = await factory({ now: () => 1000 });
    await using(under, async () => {
      const { ledger } = under;
      // tuples that spelled ONE id under "<op>|<scope>|<key>" are distinct claims
      const tuples = [['a|b', '', 'c'], ['a', 'b|', 'c'], ['a', 'b', '|c'], ['a', '', 'b|c'], ['a b', '', 'c'], ['a', String.fromCharCode(10), 'c'], ['ä', '', 'c'], ['a', '', ' c']];
      const ids = new Set();
      for (const [op, scope, key] of tuples) {
        const claimed = await ledger.claim({ op, scope, key, hash: CLAIM.hash, now: 1000 });
        assert.strictEqual(claimed.state, 'new', `${JSON.stringify([op, scope, key])} is its own key`);
        assert.strictEqual(claimed.ref.id, ledgerId(op, scope, key));
        ids.add(claimed.ref.id);
      }
      assert.strictEqual(ids.size, tuples.length);
      assert.strictEqual(ledgerId('product.save', 'tenant-a', 'k-1'), '1:["product.save","tenant-a","k-1"]');
      assert.strictEqual((await ledger.lookup({ op: 'a|b', scope: '', key: 'c', now: 1000 })).op, 'a|b');
    });
  },
};

/** The `(op, scope, key)` of a claim. @param {{ op: string, scope: string, key: string }} claim */
const tuple = (claim) => ({ op: claim.op, scope: claim.scope, key: claim.key });

/**
 * Register the whole contract for one ledger implementation.
 * @param {string} name
 * @param {LedgerFactory} factory
 */
export function ledgerContract(name, factory) {
  describe(`${name} — the ledger contract`, () => {
    it('claim → commit → replay verbatim; mismatch; in-progress; lookup answers a copy', () => cases.states(factory));
    it('a retryable failure re-runs under a new generation; a non-retryable one replays the stored failure', () => cases.failures(factory));
    it('expiry on claim and lookup; sweep() drops the rest', () => cases.expiry(factory));
    it('an expired claim refuses commit without needing a lookup, sweep or reclaim first', () => expiredSettlement(factory, false));
    it('an expired claim refuses fail without needing a lookup, sweep or reclaim first', () => expiredSettlement(factory, true));
    it('the generation fence: a stale ref, a repeated settlement and a foreign ref are refused by code and change nothing', () => cases.fence(factory));
    it('the id is the versioned JSON tuple: separators, controls and Unicode in a member never collide', () => cases.ids(factory));
  });
}

/**
 * Register the rules of a ledger a host operates (both suite ledgers
 * carry them) for one implementation.
 * @param {string} name
 * @param {LedgerFactory} factory
 */
export function ledgerLifecycleContract(name, factory) {
  describe(`${name} — the ledger an operator runs`, () => {
    it('fail(ref, false) without a response is refused by code, and the claim stays started', () => cases.missingResponse(factory));
    it('a started claim blocks its key for startedTtlMs; its late settlement is fenced; a settled record keeps ttlMs', () => cases.startedLease(factory));
    it('inFlight lists the claims still blocking their key, oldest first, narrowed by op, scope, olderThan and limit', () => cases.inFlight(factory));
    it('release frees one interrupted claim as a server fault would, once, and only its own generation', () => cases.release(factory));
    it('a lease is whole milliseconds: a fraction is refused when the ledger is made', () => cases.wholeMilliseconds(factory));
  });
}
