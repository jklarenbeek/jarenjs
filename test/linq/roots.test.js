//@ts-check
/**
 * @file Entity roots and the asynchronous provider (LINQ-FORMAT §8,
 * §12). A provider's items are bound through ITS root; a store-level
 * provider that serves several roots and none of its own is refused at
 * `from()` time by name (`JL0007`); two providers of one scope join in
 * ONE document — the shape a store answers in one statement; an
 * asynchronous provider receives the whole chain, terminal wrapper
 * included, once, with the bound externals, and a `mapAsync` splits it
 * where `explain()` says; the same chain through `from` and `fromAsync`
 * over a root is one document (the one-operator-set proof, extended to
 * roots); two roots never share a compiled program. The store's own
 * side of the seam is `test/db/provider.test.js`.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { from, fromAsync, fromDocument, LinqBuildError, LinqRuntimeError } from '@jarenjs/linq';
import { canonicalizeJson } from '@jarenjs/json/canonical';
import { compileDocument } from '../../packages/linq/src/provider.js';

const POSTS = [
  { id: 1, title: 'p1', authorId: 'u1', stars: 3 },
  { id: 2, title: 'p2', authorId: 'u2', stars: 1 },
  { id: 3, title: 'p3', authorId: 'u1', stars: 4 },
];

/**
 * A synchronous provider double over one root, recording every call.
 * @param {string | undefined} root
 * @param {{ scope?: object, roots?: string[], answer?: any }} [options]
 */
function recorder(root, { scope, roots, answer = [] } = {}) {
  /** @type {{ document: any, options: any }[]} */
  const calls = [];
  /** @type {any} */
  const provider = {
    execute(document, options) {
      calls.push({ document, options });
      return typeof answer === 'function' ? answer(document) : answer;
    },
  };
  if (root !== undefined) provider.root = root;
  if (scope !== undefined) provider.scope = scope;
  if (roots !== undefined) provider.roots = roots;
  return { provider, calls };
}

/** The asynchronous twin: `execute` answers a promise. */
function asyncRecorder(root, options = undefined) {
  const { provider, calls } = recorder(root, options);
  const sync = provider.execute;
  provider.execute = (document, executeOptions) => Promise.resolve(sync(document, executeOptions));
  return { provider, calls };
}

const codeIs = (code, pattern = undefined) => (e) =>
  (e instanceof LinqBuildError || e instanceof LinqRuntimeError) && e.code === code
  && (pattern === undefined || pattern.test(e.message));

describe('a provider binds its items through its own root (§8)', () => {
  it('from(provider) reads root; the terminal hands the document over whole', () => {
    const { provider, calls } = recorder('$.Post[*]', { answer: POSTS.filter((p) => p.stars >= 3) });
    const chain = from(provider).where((p) => p.stars.ge(3));
    const expected = { $for: { it: '$.Post[*]' }, $where: { $ge: ['$it.stars', 3] }, $return: '$it' };
    assert.deepStrictEqual(chain.toDocument(), expected);
    assert.deepStrictEqual(chain.toArray(), [POSTS[0], POSTS[2]]);
    assert.deepStrictEqual(calls, [{ document: [expected], options: { externals: {} } }]);
    // a provider naming no root is the whole input
    assert.deepStrictEqual(from(recorder(undefined).provider).toDocument(), '$[*]');
  });

  it('a reseat over a named root packs the phrase; the root itself stays bare (D15)', () => {
    const { provider } = recorder('$.Post[*]');
    const doc = from(provider).orderBy((p) => p.stars).where((p) => p.stars.gt(1)).toDocument();
    assert.deepStrictEqual(doc.$for.it,
      [{ $for: { it: '$.Post[*]' }, $orderby: { $key: '$it.stars' }, $return: '$it' }]);
  });

  it('a store-level provider with roots and no root is JL0007 at from() time, naming them', () => {
    const { provider, calls } = recorder(undefined, { roots: ['User', 'Post'] });
    assert.throws(() => from(provider), codeIs('JL0007', /User, Post/));
    assert.throws(() => from(provider), codeIs('JL0007', /store\.entity\(name\)/));
    assert.throws(() => fromAsync(provider), codeIs('JL0007', /User, Post/));
    // fromDocument keeps its own rule: the document IS the root
    const stored = { $for: { it: '$.User[*]' }, $return: '$it.id' };
    fromDocument(provider, stored).toArray();
    assert.deepStrictEqual(calls[0].document, [stored]);
    // an empty roots list serves nothing in particular: the whole input
    assert.deepStrictEqual(from(recorder(undefined, { roots: [] }).provider).toDocument(), '$[*]');
  });

  it('a root that is not a path string is JL0005', () => {
    assert.throws(() => from({ root: 42, execute: () => [] }), codeIs('JL0005', /path expression string/));
    assert.throws(() => from({ root: '', execute: () => [] }), codeIs('JL0005'));
  });
});

describe('one-root joins (§4, §8)', () => {
  const scoped = () => {
    const scope = {};
    return { post: recorder('$.Post[*]', { scope }), user: recorder('$.User[*]', { scope }) };
  };

  it('two providers of one scope join in one document — the two-binding shape', () => {
    const { post, user } = scoped();
    const bare = from(post.provider).join(from(user.provider),
      (p) => p.authorId, (u) => u.id, (p) => p);
    assert.deepStrictEqual(bare.toDocument(), {
      $for: { it: '$.Post[*]', it2: '$.User[*]' },
      $where: { $eq: ['$it.authorId', '$it2.id'] },
      $return: '$it',
    });
    const projected = from(post.provider).join(from(user.provider),
      (p) => p.authorId, (u) => u.id, (p, u) => ({ title: p.title, by: u.email }));
    assert.deepStrictEqual(projected.toDocument().$return, { title: '$it.title', by: '$it2.email' });
    projected.toArray();
    assert.strictEqual(post.calls.length, 1, 'the outer provider receives the one document');
    assert.strictEqual(user.calls.length, 0, 'the inner provider is never called');
  });

  it("groupJoin binds the inner root's matching group as a $let value", () => {
    const { post, user } = scoped();
    const doc = from(user.provider).groupJoin(from(post.provider),
      (u) => u.id, (p) => p.authorId, (u, g) => ({ id: u.id, n: g.count() })).toDocument();
    assert.deepStrictEqual(doc.$for, { it: '$.User[*]' });
    assert.deepStrictEqual(doc.$let.g[0].$for, { it2: '$.Post[*]' });
    assert.deepStrictEqual(doc.$let.g[0].$where, { $eq: ['$it.id', '$it2.authorId'] });
    assert.strictEqual(doc.$return.id, '$it.id');
  });

  it('a filtered inner side is packed; a filtered outer side reseats (the join is over the phrases)', () => {
    const { post, user } = scoped();
    const doc = from(post.provider).where((p) => p.stars.gt(1))
      .join(from(user.provider).where((u) => u.age.gt(21)), (p) => p.authorId, (u) => u.id, (p) => p)
      .toDocument();
    assert.deepStrictEqual(doc.$for.it,
      [{ $for: { it: '$.Post[*]' }, $where: { $gt: ['$it.stars', 1] }, $return: '$it' }]);
    assert.deepStrictEqual(doc.$for.it2,
      [{ $for: { it: '$.User[*]' }, $where: { $gt: ['$it.age', 21] }, $return: '$it' }]);
  });

  it('different scopes, no scope, and concat across two sets are JL0005', () => {
    const { post, user } = scoped();
    const stranger = recorder('$.User[*]', { scope: {} });
    const unscoped = recorder('$.User[*]');
    const join = (inner) => from(post.provider).join(from(inner), (p) => p.authorId, (u) => u.id, (p) => p);
    assert.throws(() => join(stranger.provider), codeIs('JL0005', /same source/));
    assert.throws(() => join(unscoped.provider), codeIs('JL0005', /same source/));
    assert.throws(() => from(unscoped.provider).join(from(user.provider), (u) => u.id, (u) => u.id, (u) => u),
      codeIs('JL0005'));
    // one input per document: concat keeps the same-source rule even within a scope
    assert.throws(() => from(post.provider).concat(from(user.provider)), codeIs('JL0005', /same source/));
    // and a scope on both sides is not a scope on the outer's terms alone
    assert.throws(() => from(post.provider).groupJoin(from(stranger.provider),
      (p) => p.authorId, (u) => u.id, (p) => p), codeIs('JL0005'));
  });

  it("the inner side's parameters ride along; a conflicting binding is JL0004", () => {
    const { post, user } = scoped();
    const inner = from(user.provider).params({ min: 21 }).where((u, q) => u.age.ge(q.min));
    const joined = from(post.provider).join(inner, (p) => p.authorId, (u) => u.id, (p) => p);
    joined.toArray();
    assert.deepStrictEqual(post.calls[0].options, { externals: { min: 21 } });
    assert.throws(() => from(post.provider).params({ min: 1 })
      .join(inner, (p) => p.authorId, (u) => u.id, (p) => p), codeIs('JL0004', /'min'/));
  });
});

describe('the asynchronous provider (§12, D8)', () => {
  it('receives the WHOLE document — terminal wrapper included — once, with the externals', async () => {
    const { provider, calls } = asyncRecorder('$.Post[*]', { answer: ['p1', 'p3'] });
    const titles = await fromAsync(provider).params({ min: 2 })
      .where((p, q) => p.stars.ge(q.min)).select((p) => p.title).toArray();
    assert.deepStrictEqual(titles, ['p1', 'p3']);
    assert.deepStrictEqual(calls, [{
      document: [{ $for: { it: '$.Post[*]' }, $where: { $ge: ['$it.stars', '$min'] }, $return: '$it.title' }],
      options: { externals: { min: 2 } },
    }]);
  });

  it('every terminal pushes its own wrapper, as the synchronous surface does', async () => {
    const pred = { $gt: ['$it.stars', 3] };
    /** @type {[string, (s: any) => Promise<any>, any, any, any][]} */
    const table = [
      ['count', (s) => s.count(), { $count: '$.Post[*]' }, 3, 3],
      ['sum', (s) => s.select((p) => p.stars).sum(),
        { $sum: { $for: { it: '$.Post[*]' }, $return: '$it.stars' } }, 8, 8],
      ['average', (s) => s.select((p) => p.stars).average(),
        { $avg: { $for: { it: '$.Post[*]' }, $return: '$it.stars' } }, 2.5, 2.5],
      ['min', (s) => s.select((p) => p.stars).min(),
        { $min: { $for: { it: '$.Post[*]' }, $return: '$it.stars' } }, 1, 1],
      ['max', (s) => s.select((p) => p.stars).max(),
        { $max: { $for: { it: '$.Post[*]' }, $return: '$it.stars' } }, 4, 4],
      ['any', (s) => s.any(), { $exists: '$.Post[*]' }, true, true],
      ['any(pred)', (s) => s.any((p) => p.stars.gt(3)),
        { $some: { it: '$.Post[*]' }, $satisfies: pred }, true, true],
      ['all', (s) => s.all((p) => p.stars.gt(3)),
        { $every: { it: '$.Post[*]' }, $satisfies: pred }, false, false],
      ['first', (s) => s.first(), [{ $subsequence: ['$.Post[*]', 0, 1] }], [POSTS[0]], POSTS[0]],
      ['firstOrDefault', (s) => s.firstOrDefault(null),
        [{ $subsequence: ['$.Post[*]', 0, 1] }], [POSTS[0]], POSTS[0]],
      ['single', (s) => s.single(), [{ $subsequence: ['$.Post[*]', 0, 2] }], [POSTS[1]], POSTS[1]],
      ['singleOrDefault', (s) => s.singleOrDefault(null),
        [{ $subsequence: ['$.Post[*]', 0, 2] }], [POSTS[1]], POSTS[1]],
      ['last', (s) => s.last(), [{ $subsequence: [{ $reverse: '$.Post[*]' }, 0, 1] }], [POSTS[2]], POSTS[2]],
      ['lastOrDefault', (s) => s.lastOrDefault(null),
        [{ $subsequence: [{ $reverse: '$.Post[*]' }, 0, 1] }], [POSTS[2]], POSTS[2]],
      ['elementAt', (s) => s.elementAt(1), [{ $subsequence: ['$.Post[*]', 1, 1] }], [POSTS[1]], POSTS[1]],
      ['elementAtOrDefault', (s) => s.elementAtOrDefault(1, null),
        [{ $subsequence: ['$.Post[*]', 1, 1] }], [POSTS[1]], POSTS[1]],
      ['toArray', (s) => s.toArray(), ['$.Post[*]'], POSTS, POSTS],
    ];
    for (const [name, run, document, answer, value] of table) {
      const { provider, calls } = asyncRecorder('$.Post[*]', { answer });
      assert.deepStrictEqual(await run(fromAsync(provider)), value, name);
      assert.strictEqual(calls.length, 1, `${name}: one call`);
      assert.deepStrictEqual(calls[0].document, document, name);
    }
  });

  it('the empty and over-full windows keep the codes; a non-array answer is JL2006; the sync surface keeps JL2004', async () => {
    const empty = () => fromAsync(asyncRecorder('$.Post[*]', { answer: [] }).provider);
    await assert.rejects(() => empty().first(), codeIs('JL2001'));
    await assert.rejects(() => empty().single(), codeIs('JL2001'));
    await assert.rejects(() => empty().last(), codeIs('JL2001'));
    await assert.rejects(() => empty().elementAt(5), codeIs('JL2003'));
    assert.strictEqual(await empty().firstOrDefault('none'), 'none');
    assert.strictEqual(await empty().lastOrDefault('none'), 'none');
    assert.strictEqual(await empty().elementAtOrDefault(2, 'none'), 'none');
    const two = () => fromAsync(asyncRecorder('$.Post[*]', { answer: [POSTS[0], POSTS[1]] }).provider);
    await assert.rejects(() => two().single(), codeIs('JL2002'));
    await assert.rejects(() => two().singleOrDefault(null), codeIs('JL2002'));
    const bare = fromAsync(asyncRecorder('$.Post[*]', { answer: () => undefined }).provider);
    await assert.rejects(() => bare.first(), codeIs('JL2006', /first\(\)/));
    await assert.rejects(() => bare.toArray(), codeIs('JL2006', /toArray\(\)/));
    // the value surface still refuses a promise where a value is due
    assert.throws(() => from(asyncRecorder('$.Post[*]').provider).count(), codeIs('JL2004'));
  });

  it('a mapAsync splits: the prefix is pushed whole as rows, the residual streams locally', async () => {
    const { provider, calls } = asyncRecorder('$.Post[*]', { answer: [POSTS[0], POSTS[2]] });
    const seq = fromAsync(provider)
      .where((p) => p.stars.gt(1))
      .mapAsync(async (p) => ({ ...p, seen: true }), { concurrency: 2 })
      .where((p) => p.seen.eq(true));
    const rows = await seq.toArray();
    assert.deepStrictEqual(rows.map((r) => r.seen), [true, true]);
    const pushed = { $for: { it: '$.Post[*]' }, $where: { $gt: ['$it.stars', 1] }, $return: '$it' };
    assert.deepStrictEqual(calls, [{ document: [pushed], options: { externals: {} } }]);
    assert.deepStrictEqual(seq.explain(),
      { barriers: [], hops: [], split: { pushed, residual: ['mapAsync', 'where'] } });
    assert.throws(() => seq.toDocument(), codeIs('JL0005'));
    // a terminal after the split runs locally over the pushed rows
    assert.strictEqual(await seq.count(), 2);
    assert.strictEqual(calls.length, 2);
    assert.deepStrictEqual(calls[1].document, [pushed], 'the prefix is pushed as rows, whatever the terminal');
    // a barrier after the split is this surface's own, and is named
    const sorted = seq.orderByDescending((p) => p.stars);
    assert.deepStrictEqual(sorted.explain().barriers.map((b) => b.operator), ['orderByDescending']);
    assert.deepStrictEqual((await sorted.toArray()).map((p) => p.id), [3, 1]);
  });

  it('explain() on an unsplit provider chain reports the document and no barrier — the provider runs it', () => {
    const { provider } = asyncRecorder('$.Post[*]');
    const seq = fromAsync(provider).orderBy((p) => p.stars).groupBy((p) => p.authorId);
    const explanation = seq.explain();
    assert.deepStrictEqual(explanation.barriers, []);
    assert.deepStrictEqual(explanation.document, seq.toDocument());
  });

  it('the async join rides inside the pushed document; refused off a provider, after a split, or across scopes', async () => {
    const scope = {};
    const post = asyncRecorder('$.Post[*]', { scope, answer: [{ title: 'p1', by: 'ada' }] });
    const user = asyncRecorder('$.User[*]', { scope });
    const joined = fromAsync(post.provider).join(fromAsync(user.provider),
      (p) => p.authorId, (u) => u.id, (p, u) => ({ title: p.title, by: u.email }));
    assert.deepStrictEqual(await joined.toArray(), [{ title: 'p1', by: 'ada' }]);
    assert.deepStrictEqual(post.calls[0].document, [{
      $for: { it: '$.Post[*]', it2: '$.User[*]' },
      $where: { $eq: ['$it.authorId', '$it2.id'] },
      $return: { title: '$it.title', by: '$it2.email' },
    }]);
    assert.strictEqual(user.calls.length, 0);
    const grouped = fromAsync(user.provider).groupJoin(fromAsync(post.provider),
      (u) => u.id, (p) => p.authorId, (u, g) => ({ id: u.id, n: g.count() }));
    assert.deepStrictEqual(grouped.toDocument().$let.g[0].$for, { it2: '$.Post[*]' });

    const by = (p) => p.authorId;
    const to = (u) => u.id;
    const pick = (p) => p;
    assert.throws(() => fromAsync([]).join(fromAsync(user.provider), by, to, pick),
      codeIs('JL0005', /single-pass/));
    assert.throws(() => fromAsync(post.provider).mapAsync(async (p) => p, { concurrency: 1 })
      .join(fromAsync(user.provider), by, to, pick), codeIs('JL0005', /before any mapAsync/));
    assert.throws(() => fromAsync(post.provider).join(fromAsync([]), by, to, pick),
      codeIs('JL0005', /inner side/));
    assert.throws(() => fromAsync(post.provider).join(
      fromAsync(user.provider).mapAsync(async (u) => u, { concurrency: 1 }), by, to, pick),
    codeIs('JL0005', /inner side/));
    assert.throws(() => fromAsync(post.provider).join(from(user.provider), by, to, pick),
      codeIs('JL0005', /inner side/));
    const stranger = asyncRecorder('$.User[*]', { scope: {} });
    assert.throws(() => fromAsync(post.provider).join(fromAsync(stranger.provider), by, to, pick),
      codeIs('JL0005', /same source/));
    assert.throws(() => fromAsync(post.provider).groupJoin(fromAsync(stranger.provider), by, to, pick),
      codeIs('JL0005', /same source/));
    assert.throws(() => fromAsync(post.provider).params({ a: 1 })
      .join(fromAsync(user.provider).params({ a: 2 }), by, to, pick), codeIs('JL0004', /'a'/));
  });
});

describe('one operator set, two drivers — over roots', () => {
  it('the same chain emits byte-identical documents through from and fromAsync', () => {
    const scope = {};
    const post = recorder('$.Post[*]', { scope }).provider;
    const user = recorder('$.User[*]', { scope }).provider;
    const builds = [
      (f) => f(post).where((p) => p.stars.gt(1)).orderBy((p) => p.title).select((p) => ({ t: p.title })),
      (f) => f(post).join(f(user), (p) => p.authorId, (u) => u.id, (p, u) => ({ t: p.title, e: u.email })),
      (f) => f(user).groupJoin(f(post), (u) => u.id, (p) => p.authorId, (u, g) => ({ id: u.id, n: g.count() })),
      (f) => f(post).orderBy((p) => p.stars).skip(1).take(2).distinct(),
    ];
    for (const build of builds) {
      assert.strictEqual(canonicalizeJson(build(fromAsync).toDocument()),
        canonicalizeJson(build(from).toDocument()));
    }
    // and the terminal documents the two surfaces hand a provider are one
    const sync = recorder('$.Post[*]', { answer: 1 });
    const async = asyncRecorder('$.Post[*]', { answer: 1 });
    from(sync.provider).where((p) => p.stars.gt(1)).count();
    return fromAsync(async.provider).where((p) => p.stars.gt(1)).count().then(() => {
      assert.deepStrictEqual(async.calls[0].document, sync.calls[0].document);
    });
  });
});

describe('the semantic cache and roots', () => {
  it('two chains over different roots never share a compiled program; one root twice does', () => {
    const post = recorder('$.Post[*]').provider;
    const user = recorder('$.User[*]').provider;
    const build = (provider) => from(provider).where((r) => r.id.gt(0)).toDocument();
    const compiled = (document) => compileDocument(document, { externals: [] });
    assert.notStrictEqual(compiled(build(post)), compiled(build(user)));
    assert.strictEqual(compiled(build(post)), compiled(build(post)));
  });
});
