//@ts-check
/**
 * @file Regressions for the quirks a reading of the package found — each
 * one a concrete input that answered wrongly, quietly, and now answers
 * exactly. The reproductions are the tests: an item that is an array
 * stays one item on both surfaces, a document is a snapshot on both
 * surfaces, constants and parameters cross the JSON boundary, the
 * compiled-program cache never answers another document's member order,
 * captures nest, `selectMany` flattens as typed, a `groupJoin` group is
 * the array its type says, the ordered `mapAsync` window fails closed,
 * `get()` reaches every key, and a push queue fed after its end says so
 * with a runtime code.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import {
  from, fromAsync, fromDocument, createPushQueue, LinqBuildError, LinqRuntimeError,
} from '@jarenjs/linq';
import { queryJson } from '@jarenjs/json/query';

const USERS = [{ id: 1, name: 'ada' }, { id: 2, name: 'kid' }, { id: 3, name: 'lin' }];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('an item is an item (the C# element contract on both surfaces)', () => {
  const ROWS = [[1, 2], [3]];

  it('an array-valued row survives where/select/count unsplit, and the two surfaces agree', async () => {
    assert.deepStrictEqual(from(ROWS).where(() => true).toArray(), [[1, 2], [3]]);
    assert.strictEqual(from(ROWS).where(() => true).count(), 2);
    assert.strictEqual(from(ROWS).count(), 2);
    assert.deepStrictEqual(from(ROWS).select((r) => r.at(0)).toArray(), [1, 3]);
    assert.deepStrictEqual(from(ROWS).select((r) => r.all().count()).toArray(), [2, 1]);
    assert.deepStrictEqual(await fromAsync(ROWS).where(() => true).toArray(), [[1, 2], [3]]);
    assert.deepStrictEqual(await fromAsync(ROWS).select((r) => r.at(0)).toArray(), [1, 3]);
  });

  it('the CSV-row chain answers the rows on both surfaces', async () => {
    const rows = [['row0', 0], ['row1', 1]];
    const run = (q) => q.where((r) => r.at(1).exists()).select((r) => r.at(0));
    assert.deepStrictEqual(run(from(rows)).toArray(), ['row0', 'row1']);
    assert.deepStrictEqual(await run(fromAsync(rows)).toArray(), ['row0', 'row1']);
  });

  it('a reseated phrase, a join side and an ordered/grouped/folded phrase keep items too', () => {
    assert.deepStrictEqual(from(ROWS).orderBy(() => 1).where(() => true).toArray(), [[1, 2], [3]]);
    assert.deepStrictEqual(from(ROWS).skip(0).where(() => true).toArray(), [[1, 2], [3]]);
    assert.deepStrictEqual(from(ROWS).groupBy((r) => r.all().count()).toArray().map((g) => g.items),
      [[[1, 2]], [[3]]]);
    assert.deepStrictEqual(from(ROWS).aggregate(0, (acc) => acc.add(1)).toArray(), [2]);
    const joined = from(ROWS).join(from(ROWS), (a) => a.at(0), (b) => b.at(0), (a, b) => [a, b]);
    assert.deepStrictEqual(joined.toArray(), [[[1, 2], [1, 2]], [[3], [3]]]);
  });

  it('the packed source is the engine’s own non-unpacking binding, and the hash join survives it', () => {
    const doc = from(ROWS).where(() => true).toDocument();
    assert.deepStrictEqual(doc, { $for: { it: ['$[*]'] }, $where: true, $return: '$it' });
    assert.deepStrictEqual(queryJson(doc, ROWS), [[1, 2], [3]]);
    // the join shape packs both sides; the rewrite is keyed on the
    // bindings, so 3000×3000 answers in milliseconds, not seconds
    const n = 3000;
    const L = Array.from({ length: n }, (_, i) => ({ id: i, side: 'l' }));
    const q = from(L).join(from(L), (a) => a.id, (b) => b.id, (a, b) => ({ a: a.id, b: b.id }));
    const started = performance.now();
    assert.strictEqual(q.toArray().length, n);
    assert.ok(performance.now() - started < 500, 'the hash join rewrite still applies to packed sources');
  });

  it('a provider’s own root stays bare; a reseat over it is packed', () => {
    const documents = [];
    const provider = { execute(document) { documents.push(document); return []; } };
    from(provider).where((r) => r.n.gt(1)).toArray();
    assert.deepStrictEqual(documents[0],
      [{ $for: { it: '$[*]' }, $where: { $gt: ['$it.n', 1] }, $return: '$it' }]);
    from(provider).orderBy((r) => r.n).where((r) => r.n.gt(1)).toArray();
    assert.deepStrictEqual(documents[1][0].$for.it,
      [{ $for: { it: '$[*]' }, $orderby: { $key: '$it.n' }, $return: '$it' }]);
  });
});

describe('selectMany flattens as typed', () => {
  it('an array member fans out one level; a nested array stays one item', () => {
    assert.deepStrictEqual(from([{ tags: ['x', 'y'] }]).selectMany((u) => u.tags).toArray(), ['x', 'y']);
    assert.deepStrictEqual(from([{ tags: [[1], [2]] }]).selectMany((u) => u.tags).toArray(), [[1], [2]]);
    assert.deepStrictEqual(from([{ a: 1, b: 2 }]).selectMany((u) => [u.a, u.b]).toArray(), [1, 2]);
  });

  it('on the async surface too', async () => {
    assert.deepStrictEqual(await fromAsync([{ tags: ['x', 'y'] }]).selectMany((u) => u.tags).toArray(), ['x', 'y']);
  });
});

describe('the version envelope is honoured', () => {
  it('exactly { $query: "0.1", $expr } unwraps; anything else gets the engine’s verdict', () => {
    assert.deepStrictEqual(fromDocument([1], { $query: '0.1', $expr: '$[*]' }).toArray(), [1]);
    assert.throws(() => fromDocument([1], { $query: '9.9', $expr: '$[*]' }), (e) => e.code === 'JQ0006');
    assert.throws(() => fromDocument([1], { $query: 42, $expr: '$[*]' }), (e) => e.code === 'JQ0006');
    assert.throws(() => fromDocument([1], { $query: '0.1', $expr: '$[*]', extra: 1 }),
      (e) => e.code === 'JQ0001');
    assert.throws(() => fromDocument([1], { $expr: '$[*]' }), (e) => e.code === 'JQ0003');
  });
});

describe('documents are snapshots on the async surface', () => {
  it('mutating toDocument() or explain().document changes no later answer', async () => {
    const q = fromAsync([{ x: 1 }, { x: 2 }]).where((r) => r.x.eq(1));
    assert.deepStrictEqual(await q.toArray(), [{ x: 1 }]);
    q.toDocument().$where.$eq[1] = 2;
    q.explain().document.$where.$eq[1] = 3;
    assert.deepStrictEqual(await q.toArray(), [{ x: 1 }]);
  });

  it('and the split’s pushed document is a snapshot too', async () => {
    const q = from([{ x: 1 }]).where((r) => r.x.eq(1)).mapAsync(async (r) => r, { concurrency: 1 });
    q.explain().split.pushed.$where.$eq[1] = 9;
    assert.deepStrictEqual(await q.toArray(), [{ x: 1 }]);
  });
});

describe('parameters survive composition and cross the JSON boundary', () => {
  it('the inner side’s bindings ride along on concat, join and groupJoin', () => {
    const b = from(USERS);
    const one = b.params({ k: 1 }).where((u, p) => u.id.eq(p.k));
    const three = b.params({ k: 3 }).where((u, p) => u.id.eq(p.k));
    assert.throws(() => one.concat(three), (e) => e.code === 'JL0004');
    const other = b.params({ j: 3 }).where((u, p) => u.id.eq(p.j));
    assert.deepStrictEqual(one.concat(other).select((u) => u.id).toArray(), [1, 3]);
    assert.deepStrictEqual(one.concat(other).explain().externals.sort(), ['j', 'k']);
    assert.deepStrictEqual(
      one.join(other, (u) => u.id, (v) => v.id.sub(2), (u, v) => [u.id, v.id]).toArray(),
      [[1, 3]]);
    assert.deepStrictEqual(
      one.groupJoin(other, (u) => u.id, (v) => v.id.sub(2), (u, g) => ({ id: u.id, n: g.count() })).toArray(),
      [{ id: 1, n: 1 }]);
  });

  it('a params() after a mapAsync split rebinds the pushed prefix as well', async () => {
    const s = from(USERS).params({ min: 1 }).where((u, p) => u.id.ge(p.min))
      .mapAsync(async (u) => u.id, { concurrency: 1 });
    assert.deepStrictEqual(await s.params({ min: 3 }).toArray(), [3]);
    assert.deepStrictEqual(await s.toArray(), [1, 2, 3]);
  });

  it('a Date, a Map, NaN or -0 is refused as a binding or a concat constant', async () => {
    assert.throws(() => from(USERS).params({ d: new Date(0) }), (e) => e.code === 'JL0004');
    assert.throws(() => from(USERS).params({ m: new Map() }), (e) => e.code === 'JL0004');
    assert.throws(() => from(USERS).params({ z: -0 }), (e) => e.code === 'JL0004');
    assert.throws(() => fromAsync(USERS).params({ n: NaN }), (e) => e.code === 'JL0004');
    assert.throws(() => from([1]).concat([new Date(0)]), (e) => e.code === 'JL0005');
    assert.throws(() => fromAsync([1]).concat([new Map()]), (e) => e.code === 'JL0005');
    assert.throws(() => from([1]).concat([NaN, -0, Infinity]), (e) => e.code === 'JL0005');
    assert.deepStrictEqual(await fromAsync([1]).concat([{ a: 1 }]).toArray(), [1, { a: 1 }]);
  });
});

describe('the compiled-program cache is order-sensitive', () => {
  it('two projections differing only in member order answer their own order in one process', () => {
    from(USERS).select((u) => ({ id: u.id, name: u.name })).toArray();
    const warm = from(USERS).select((u) => ({ name: u.name, id: u.id })).toArray();
    assert.deepStrictEqual(Object.keys(warm[0]), ['name', 'id']);
    assert.deepStrictEqual(Object.keys(from(USERS).select((u) => ({ id: u.id, name: u.name })).toArray()[0]),
      ['id', 'name']);
  });
});

describe('captures nest', () => {
  it('a chain built and run inside a callback leaves the enclosing proxies live', () => {
    const rows = from([{ id: 1 }]).select((u) => {
      const n = from([1, 2]).where((v) => v.gt(1)).count();
      return { id: u.id, n };
    }).toArray();
    assert.deepStrictEqual(rows, [{ id: 1, n: 1 }]);
  });

  it('an enclosing capture’s proxy used inside the nested one is refused by name', () => {
    assert.throws(
      () => from([{ id: 1 }]).where((u) => from([{ id: 1 }]).where((v) => v.id.eq(u.id)).any()),
      (e) => e instanceof LinqBuildError && e.code === 'JL0002' && /nested capture/.test(e.message));
  });
});

describe('the groupJoin group is the array its type says', () => {
  const NAMES = [{ id: 1, n: 'a' }, { id: 2, n: 'b' }, { id: 3, n: 'a' }];

  it('at(0), all(), a member position and the fanned aggregates all work', () => {
    const q = from(NAMES).groupJoin(from(NAMES), (u) => u.n, (v) => v.n,
      (u, g) => ({ id: u.id, first: g.at(0).id, n: g.count(), sum: g.all().id.sum(), all: g, any: g.exists() }));
    assert.deepStrictEqual(q.toArray(), [
      { id: 1, first: 1, n: 2, sum: 4, all: [{ id: 1, n: 'a' }, { id: 3, n: 'a' }], any: true },
      { id: 2, first: 2, n: 1, sum: 2, all: [{ id: 2, n: 'b' }], any: true },
      { id: 3, first: 1, n: 2, sum: 4, all: [{ id: 1, n: 'a' }, { id: 3, n: 'a' }], any: true },
    ]);
    assert.deepStrictEqual(q.toDocument().$let, {
      g: [{
        $for: { it2: ['$[*]'] },
        $where: { $eq: ['$it.n', '$it2.n'] },
        $return: '$it2',
      }],
    });
  });

  it('an empty group is an empty array: count 0, exists false, isEmpty true', () => {
    const q = from(NAMES).groupJoin(from(NAMES), (u) => u.id, (v) => v.id.add(10),
      (u, g) => ({ id: u.id, n: g.count(), any: g.exists(), none: g.isEmpty(), all: g }));
    assert.deepStrictEqual(q.first(), { id: 1, n: 0, any: false, none: true, all: [] });
  });
});

describe('the ordered mapAsync window fails closed', () => {
  it('no callback starts after a sibling rejected; every in-flight sibling is aborted', async () => {
    const started = [];
    const aborted = [];
    await assert.rejects(
      fromAsync([1, 2, 3, 4, 5, 6]).mapAsync(async (n, signal) => {
        started.push(n);
        if (n === 2) throw new Error('boom');
        await sleep(20);
        aborted.push([n, signal.aborted]);
        return n;
      }, { concurrency: 2 }).toArray(),
      /boom/);
    await sleep(40);
    assert.deepStrictEqual(started, [1, 2], 'task 3 never started');
    assert.deepStrictEqual(aborted, [[1, true]], 'the sibling saw the abort');
  });

  it('while a chain that never fails still pulls the whole source in order', async () => {
    assert.deepStrictEqual(
      await fromAsync([1, 2, 3, 4]).mapAsync(async (n) => { await sleep(5 - n); return n; }, { concurrency: 3 }).toArray(),
      [1, 2, 3, 4]);
  });
});

describe('streamed constants are copies', () => {
  it('writing into a yielded fallback or concat constant does not rewrite the next enumeration', async () => {
    const q = fromAsync([]).defaultIfEmpty({ a: 1 });
    (await q.first()).a = 77;
    assert.deepStrictEqual(await q.first(), { a: 1 });
    const c = fromAsync([0]).concat([{ a: 1 }]);
    (await c.toArray())[1].a = 55;
    assert.deepStrictEqual(await c.toArray(), [0, { a: 1 }]);
  });
});

describe('get() reaches every key', () => {
  it('control characters in a key are escaped into the bracket selector', () => {
    const rows = [{ 'a\tb': 1, 'a\nb': 2, 'ab': 3, "it's": 4, 'back\\slash': 5 }];
    assert.deepStrictEqual(from(rows).select((r) => r.get('a\tb')).toArray(), [1]);
    assert.deepStrictEqual(from(rows).select((r) => r['a\nb']).toArray(), [2]);
    assert.deepStrictEqual(from(rows).select((r) => r.get('ab')).toArray(), [3]);
    assert.deepStrictEqual(from(rows).select((r) => r.get("it's")).toArray(), [4]);
    assert.deepStrictEqual(from(rows).select((r) => r.get('back\\slash')).toArray(), [5]);
    assert.strictEqual(from(rows).select((r) => r.get('a\tb')).toDocument().$return, "$it['a\\tb']");
  });
});

describe('what the surface says of itself', () => {
  it('a push queue fed after end() is a runtime code', () => {
    const queue = createPushQueue();
    queue.end();
    assert.throws(() => queue.feed(1), (e) => e instanceof LinqRuntimeError && e.code === 'JL2005');
  });

  it('an unseeded aggregate is the recorded unsupported operator, named', () => {
    assert.throws(() => from([1, 2]).aggregate((acc, x) => acc.add(x)),
      (e) => e.code === 'JL0006' && /seed/.test(e.message));
  });

  it('explain() names operators as written, and thenBy rides the orderBy barrier', () => {
    const q = fromAsync([]).orderByDescending((k) => k).thenByDescending((k) => k);
    assert.deepStrictEqual(q.explain().barriers.map((b) => b.operator), ['orderByDescending']);
    const split = fromAsync([]).mapAsync(async (x) => x, { concurrency: 1 })
      .selectMany((x) => x).orderBy((x) => x).thenBy((x) => x).explain().split;
    assert.deepStrictEqual(split.residual, ['mapAsync', 'selectMany', 'orderBy', 'thenBy']);
  });

  it('a provider answering an element terminal with no array is named, not indexed', () => {
    assert.throws(() => from({ execute: () => undefined }).toArray(),
      (e) => e instanceof LinqRuntimeError && e.code === 'JL2006' && /undefined/.test(e.message));
    assert.throws(() => from({ execute: () => 7 }).first(), (e) => e.code === 'JL2006');
    assert.strictEqual(from({ execute: () => 7 }).count(), 7, 'an aggregate terminal is a value');
  });

  it('a callback is captured once, whatever the terminal count', () => {
    let calls = 0;
    const q = from([1, 2]).where((x) => { calls++; return x.gt(0); });
    q.toArray(); q.toArray(); q.toDocument(); q.count();
    assert.strictEqual(calls, 1);
  });
});
