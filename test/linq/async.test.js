//@ts-check
/**
 * @file The async surface (QUERY-PEN.md §10): the D5 proof FIRST —
 * the same chain emits a byte-identical document through `from` and
 * `fromAsync` — then streaming (a counting source proves nothing
 * materialises), barriers (named by `explain()`), early close (a
 * recording source proves `.return()` propagates), and the async
 * terminal matrix.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { from, fromAsync } from '@jarenjs/linq';
import { canonicalizeJson } from '@jarenjs/json/canonical';

/** An async source that counts reads and records closure. */
function trackedSource(items) {
  const track = { pulled: 0, closed: false, enumerations: 0 };
  const factory = {
    [Symbol.asyncIterator]() {
      track.enumerations++;
      let i = 0;
      return {
        async next() {
          if (i >= items.length) return { done: true, value: undefined };
          track.pulled++;
          return { done: false, value: items[i++] };
        },
        async return() {
          track.closed = true;
          return { done: true, value: undefined };
        },
        [Symbol.asyncIterator]() { return this; },
      };
    },
  };
  return { factory, track };
}

const USERS = [
  { id: 1, name: 'ada', age: 36 },
  { id: 2, name: 'kid', age: 8 },
  { id: 3, name: 'lin', age: 64 },
];

describe('D5 — one operator set, two drivers', () => {
  it('the same chain emits a byte-identical document through from and fromAsync', () => {
    const build = (f) => f(USERS)
      .where((u) => u.age.gt(21))
      .orderBy((u) => u.name)
      .select((u) => ({ id: u.id, name: u.name }));
    const syncDoc = build(from).toDocument();
    const asyncDoc = build(fromAsync).toDocument();
    assert.strictEqual(canonicalizeJson(asyncDoc), canonicalizeJson(syncDoc));
  });

  it('and the async execution agrees with the sync reference', async () => {
    const build = (f) => f(USERS).where((u) => u.age.gt(21)).select((u) => u.name);
    assert.deepStrictEqual(await build(fromAsync).toArray(), build(from).toArray());
  });
});

describe('streaming and barriers', () => {
  it('where+select+take reads only the rows it needs (a counting source)', async () => {
    const big = Array.from({ length: 1e6 }, (_, i) => ({ n: i }));
    const { factory, track } = trackedSource(big);
    const out = await fromAsync(factory)
      .where((r) => r.n.mod(2).eq(0))
      .select((r) => r.n)
      .take(5)
      .toArray();
    assert.deepStrictEqual(out, [0, 2, 4, 6, 8]);
    assert.strictEqual(track.pulled <= 10, true,
      `pulled ${track.pulled} rows for 5 results — streaming, not materialising`);
    assert.strictEqual(track.closed, true, 'take() closed the source');
  });

  it('a barrier buffers and the engine agrees with the sync surface', async () => {
    const chain = (f) => f(USERS)
      .where((u) => u.age.gt(5))
      .orderByDescending((u) => u.age)
      .groupBy((u) => u.age.ge(21))
      .select((g) => ({ adult: g.key, n: g.items.all().count() }));
    assert.deepStrictEqual(await chain(fromAsync).toArray(), chain(from).toArray());
  });

  it('explain() names the forcing operator and its reason', () => {
    const seq = fromAsync([]).where((u) => u.id.gt(0)).orderBy((u) => u.id);
    const explanation = seq.explain();
    assert.deepStrictEqual(explanation.barriers.map((b) => b.operator), ['orderBy']);
    assert.match(explanation.barriers[0].reason, /\$orderby/);
    assert.ok(explanation.document, 'no mapAsync: the document is representable');
  });

  it('a mapAsync chain refuses toDocument and reports the split instead', () => {
    const seq = fromAsync([]).where((u) => u.id.gt(0))
      .mapAsync(async (u) => u, { concurrency: 2 })
      .where((u) => u.id.lt(9));
    assert.throws(() => seq.toDocument(), (e) => e.code === 'JL0005');
    const explanation = seq.explain();
    assert.deepStrictEqual(explanation.split.residual, ['mapAsync', 'where']);
    assert.ok(explanation.split.pushed, 'the prefix document is reported');
  });
});

describe('early termination closes the source', () => {
  it('first() closes after one hit', async () => {
    const { factory, track } = trackedSource(USERS);
    const hit = await fromAsync(factory).where((u) => u.age.gt(21)).first();
    assert.strictEqual(hit.id, 1);
    assert.strictEqual(track.closed, true);
    assert.strictEqual(track.pulled, 1);
  });

  it('any() closes on the first witness', async () => {
    const { factory, track } = trackedSource(USERS);
    assert.strictEqual(await fromAsync(factory).any((u) => u.age.gt(21)), true);
    assert.strictEqual(track.closed, true);
  });

  it('an exception mid-chain closes the source', async () => {
    const { factory, track } = trackedSource(USERS);
    await assert.rejects(
      () => fromAsync(factory).select((u) => u.age.idiv(0)).toArray(),
      (e) => e.code === 'JQ2002');
    assert.strictEqual(track.closed, true);
  });
});

describe('the async terminal matrix', () => {
  const empty = () => fromAsync([]);
  const two = () => fromAsync([7, 8]);

  it('first/single/last/elementAt with their codes', async () => {
    await assert.rejects(() => empty().first(), (e) => e.code === 'JL2001');
    assert.strictEqual(await two().firstOrDefault('d'), 7);
    await assert.rejects(() => two().single(), (e) => e.code === 'JL2002');
    assert.strictEqual(await two().last(), 8);
    await assert.rejects(() => two().elementAt(9), (e) => e.code === 'JL2003');
    assert.strictEqual(await two().elementAtOrDefault(9, 'd'), 'd');
  });

  it('aggregates run through the engine (identical semantics)', async () => {
    assert.strictEqual(await two().sum(), 15);
    assert.strictEqual(await two().count(), 2);
    await assert.rejects(() => empty().average(), (e) => e.code === 'JL2001');
    assert.strictEqual(await fromAsync(['b', 'a']).min(), 'a');
  });

  it('all() is vacuously true on empty; defaultIfEmpty yields the fallback', async () => {
    assert.strictEqual(await empty().all((n) => n.gt(0)), true);
    assert.deepStrictEqual(await empty().defaultIfEmpty('none').toArray(), ['none']);
    assert.deepStrictEqual(await two().defaultIfEmpty('none').toArray(), [7, 8]);
  });

  it('distinct streams with the grouping relation (NaN groups with NaN)', async () => {
    assert.deepStrictEqual(await fromAsync([1, NaN, 1, NaN, 2]).distinct().count(), 3);
  });

  it('concat appends a constant array; a sequence is refused (single-pass source)', async () => {
    assert.deepStrictEqual(await two().concat([9]).toArray(), [7, 8, 9]);
    assert.throws(() => two().concat(/** @type {any} */ (from([1]))),
      (e) => e.code === 'JL0005');
  });
});

describe('the provider split (Sequence.mapAsync)', () => {
  it('the prefix is pushed whole; the residual runs locally', async () => {
    const calls = [];
    const provider = {
      execute(document, options) {
        calls.push({ document, options });
        return [{ id: 1 }, { id: 2 }, { id: 3 }];
      },
    };
    const seq = from(provider).where((r) => r.id.gt(0))
      .mapAsync(async (r) => ({ id: r.id, score: r.id * 10 }), { concurrency: 2 })
      .where((r) => r.score.gt(10));
    const rows = await seq.toArray();
    assert.deepStrictEqual(rows, [{ id: 2, score: 20 }, { id: 3, score: 30 }]);
    assert.strictEqual(calls.length, 1, 'one provider call, the whole prefix');
    const explanation = seq.explain();
    assert.deepStrictEqual(explanation.split.residual, ['mapAsync', 'where']);
    assert.deepStrictEqual(explanation.split.pushed, {
      $for: { it: '$[*]' }, $where: { $gt: ['$it.id', 0] }, $return: '$it',
    });
  });
});

describe('async surface parity (the remaining operator coverage)', () => {
  const USERS2 = [
    { id: 1, name: 'ada', age: 36, tags: ['dev', 'lead'] },
    { id: 2, name: 'kid', age: 8, tags: [] },
    { id: 3, name: 'lin', age: 64, tags: ['dev'] },
  ];

  it('selectMany, reverse, thenBy/thenByDescending mirror the sync surface', async () => {
    assert.deepStrictEqual(
      await fromAsync(USERS2).selectMany((u) => u.tags.all()).toArray(),
      from(USERS2).selectMany((u) => u.tags.all()).toArray());
    assert.deepStrictEqual(
      await fromAsync([1, 2, 3]).reverse().toArray(), [3, 2, 1]);
    const chain = (f) => f(USERS2)
      .orderBy((u) => u.tags.all().count()).thenBy((u) => u.name)
      .select((u) => u.id);
    assert.deepStrictEqual(await chain(fromAsync).toArray(), chain(from).toArray());
    const desc = (f) => f(USERS2)
      .orderBy((u) => u.tags.all().count()).thenByDescending((u) => u.name)
      .select((u) => u.id);
    assert.deepStrictEqual(await desc(fromAsync).toArray(), desc(from).toArray());
  });

  it('aggregate folds through the engine', async () => {
    assert.deepStrictEqual(
      await fromAsync(USERS2).aggregate(0, (acc, u) => acc.add(u.age)).toArray(),
      [108]);
  });

  it('ofType/cast work with the hook; zip stays unsupported; params validate', async () => {
    const { createTypeTestCompiler } = await import('@jarenjs/validate/query');
    const { JarenValidator } = await import('@jarenjs/validate');
    const compileTypeTest = createTypeTestCompiler(new JarenValidator());
    assert.deepStrictEqual(
      await fromAsync([1, 'a', 2], { compileTypeTest }).ofType({ type: 'number' }).toArray(),
      [1, 2]);
    await assert.rejects(
      () => fromAsync([1, 'a'], { compileTypeTest }).cast({ type: 'number' }).toArray(),
      (e) => e.code === 'JQ2008');
    assert.throws(() => fromAsync([]).zip(), (e) => e.code === 'JL0006');
    assert.throws(() => fromAsync([]).params({ it: 1 }), (e) => e.code === 'JL0004');
    const bound = await fromAsync(USERS2).params({ minAge: 21 })
      .where((u, p) => u.age.ge(p.minAge)).count();
    assert.strictEqual(bound, 2);
  });

  it('singleOrDefault, lastOrDefault and max complete the terminal matrix', async () => {
    assert.strictEqual(await fromAsync([]).singleOrDefault('d'), 'd');
    await assert.rejects(() => fromAsync([1, 2]).singleOrDefault('d'),
      (e) => e.code === 'JL2002');
    assert.strictEqual(await fromAsync([]).lastOrDefault('d'), 'd');
    assert.strictEqual(await fromAsync([1, 9, 3]).max(), 9);
  });

  it('a source failure aborts the in-flight switch task through the outer signal', async () => {
    let taskAborted = false;
    async function* failingSource() {
      yield 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      throw new Error('source broke');
    }
    await assert.rejects(
      () => fromAsync(failingSource())
        .mapAsync((n, signal) => new Promise((resolve, reject) => {
          signal.addEventListener('abort',
            () => { taskAborted = true; reject(signal.reason); }, { once: true });
          setTimeout(() => resolve(n), 200);
        }), { concurrency: 1, mode: 'switch' })
        .toArray(),
      /source broke/);
    assert.strictEqual(taskAborted, true, 'the failure reached the in-flight task');
  });

  it('early termination aborts a switch-mode task through the outer signal', async () => {
    const aborts = [];
    const out = await fromAsync([1, 2, 3, 4])
      .mapAsync(async (n, signal) => {
        signal.addEventListener('abort', () => aborts.push(n), { once: true });
        await new Promise((resolve) => setTimeout(resolve, 15));
        return n;
      }, { concurrency: 1, mode: 'switch' })
      .take(1)
      .toArray();
    assert.strictEqual(out.length, 1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.strictEqual(aborts.length >= 1, true, 'the outer abort reached the task signal');
  });
});
