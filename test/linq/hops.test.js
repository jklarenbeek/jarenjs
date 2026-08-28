//@ts-check
/**
 * @file Relation navigation, desugared by the pen (LINQ-FORMAT §3, §4
 * "relation navigation"): over a provider that carries a relation
 * table, `p.author.email`, `u.posts.all().count()` and
 * `u.posts.all().exists()` are captured as HOPS and lowered to the
 * correlated phrases the engine and the store both run — byte-equal to
 * the hand-written documents here — so the emitted document carries no
 * relation name; `explain().hops` lists the hops; a many-to-many hop is
 * `JL0105` at build time naming the join table; the hop bindings `r<n>`
 * are reserved. The store's side of the seam — the rows, the residual
 * reasons, the strict refusal — is `test/db/provider.test.js` and the
 * generated oracle group.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { from, fromAsync, fromDocument, LinqBuildError } from '@jarenjs/linq';
import { canonicalizeJson } from '@jarenjs/json/canonical';
import { queryJson } from '@jarenjs/json/query';

/** The tables a store exposes (MODEL-FORMAT §10.1), as the fixture
 * model declares them: `User.posts` ↔ `Post.author` over `authorId`,
 * `User.labels` through a join table. */
const TABLES = Object.freeze({
  User: Object.freeze({
    posts: Object.freeze({ to: 'Post', kind: 'oneToMany', via: 'authorId', fkEntity: 'Post', fkTargets: 'User', targetKey: 'id' }),
    labels: Object.freeze({ to: 'Label', kind: 'manyToMany', joinTable: 'Label_User', targetKey: 'name' }),
  }),
  Post: Object.freeze({
    author: Object.freeze({ to: 'User', kind: 'oneToOne', via: 'authorId', fkEntity: 'Post', fkTargets: 'User', targetKey: 'id' }),
  }),
  Label: Object.freeze({}),
});

const ROOT = {
  User: [{ id: 'u1', email: 'a@x', name: 'ada' }, { id: 'u2', email: 'b@x', name: 'lin' }, { id: 'u3', email: 'c@x', name: 'kid' }],
  Post: [
    { pid: 1, title: 'p1', authorId: 'u1', stars: 3 },
    { pid: 2, title: 'p2', authorId: 'u2', stars: 1 },
    { pid: 3, title: 'p3', authorId: 'u1', stars: 4 },
    { pid: 4, title: 'orphan', stars: 2 },
  ],
};

/**
 * A provider double over one entity root of a scope that carries every
 * root's relation table — the shape a store's entity set has; `execute`
 * runs the document over the in-memory root, which is what the store's
 * residual does.
 * @param {string} name
 * @param {object} scope
 */
function entitySet(name, scope) {
  return {
    root: `$.${name}[*]`,
    scope,
    relations: TABLES[name],
    execute: (document, options) => queryJson(document, structuredClone(ROOT), options.externals),
  };
}
const scope = { relations: TABLES };
const posts = () => from(entitySet('Post', scope));
const users = () => from(entitySet('User', scope));

const AUTHOR = (ret = '$r1') => ({
  $for: { r1: '$.User[*]' }, $where: { $eq: ['$r1.id', '$it.authorId'] }, $return: ret,
});
const POSTS = (ret = '$r1', binding = 'r1', subject = '$it') => ({
  $for: { [binding]: '$.Post[*]' }, $where: { $eq: [`$${binding}.authorId`, `${subject}.id`] }, $return: ret,
});

const codeIs = (code, pattern = undefined) => (e) =>
  e instanceof LinqBuildError && e.code === code && (pattern === undefined || pattern.test(e.message));

describe('a to-one hop lowers to the correlated phrase (§4, relation navigation)', () => {
  it('in a projection: the phrase returns the member over the hop binding, and no relation name survives', () => {
    const chain = posts().select((p) => ({ title: p.title, by: p.author.email }));
    const doc = chain.toDocument();
    assert.deepStrictEqual(doc, {
      $for: { it: '$.Post[*]' },
      $return: { title: '$it.title', by: AUTHOR('$r1.email') },
    });
    // the relation NAME is nowhere in the document (`authorId` is the
    // declared key column, not the member `author`)
    assert.strictEqual(/\bauthor\b/.test(JSON.stringify(doc)), false);
    assert.deepStrictEqual(chain.toArray(), [
      { title: 'p1', by: 'a@x' }, { title: 'p2', by: 'b@x' }, { title: 'p3', by: 'a@x' }, { title: 'orphan' },
    ]);
    // the bare hop is the related row (zero or one): a value, an operand
    assert.deepStrictEqual(posts().select((p) => p.author).toDocument().$return, AUTHOR());
  });

  it('in a filter and under an ordering: the phrase is the operand, an unmatched row an empty key', () => {
    const filtered = posts().where((p) => p.author.email.eq('a@x'));
    assert.deepStrictEqual(filtered.toDocument(), {
      $for: { it: '$.Post[*]' }, $where: { $eq: [AUTHOR('$r1.email'), 'a@x'] }, $return: '$it',
    });
    assert.deepStrictEqual(filtered.select((p) => p.pid).toArray(), [1, 3]);
    const ordered = posts().orderBy((p) => p.author.name).thenBy((p) => p.pid).select((p) => p.pid);
    assert.deepStrictEqual(ordered.toDocument().$orderby, [{ $key: AUTHOR('$r1.name') }, { $key: '$it.pid' }]);
    assert.deepStrictEqual(ordered.toArray(), [4, 1, 3, 2], 'the orphan sorts first: its key is empty');
    // absence and presence of the related row
    assert.deepStrictEqual(posts().where((p) => p.author.isEmpty()).select((p) => p.pid).toArray(), [4]);
    assert.deepStrictEqual(posts().where((p) => p.author.exists()).count(), 3);
  });

  it('a nested member of the target extends the path; get() reaches an odd key and hops a relation', () => {
    assert.strictEqual(posts().select((p) => p.author.profile.bio).toDocument().$return.$return, '$r1.profile.bio');
    assert.strictEqual(posts().select((p) => p.author.get('odd key')).toDocument().$return.$return, "$r1['odd key']");
    assert.deepStrictEqual(posts().select((p) => p.get('author').email).toDocument().$return, AUTHOR('$r1.email'));
  });
});

describe('a to-many hop is the array of related rows; fanned, their sequence', () => {
  it('count and existence apply to the fan — the measured $count/$exists phrases', () => {
    const counted = users().where((u) => u.posts.all().count().ge(2));
    assert.deepStrictEqual(counted.toDocument(), {
      $for: { it: '$.User[*]' }, $where: { $ge: [{ $count: POSTS() }, 2] }, $return: '$it',
    });
    assert.deepStrictEqual(counted.select((u) => u.id).toArray(), ['u1']);
    const any = users().where((u) => u.posts.all().exists());
    assert.deepStrictEqual(any.toDocument(), {
      $for: { it: '$.User[*]' }, $where: { $exists: POSTS() }, $return: '$it',
    });
    assert.deepStrictEqual(any.select((u) => u.id).toArray(), ['u1', 'u2']);
    // the array value's own aggregates range over the rows too, as a
    // group-join's group's do
    assert.deepStrictEqual(users().where((u) => u.posts.exists()).toDocument().$where, { $exists: POSTS() });
    assert.deepStrictEqual(users().select((u) => u.posts.count()).toArray(), [2, 1, 0]);
    assert.deepStrictEqual(users().where((u) => u.posts.all().isEmpty()).select((u) => u.id).toArray(), ['u3']);
  });

  it('as a value it is the packed array; a member is read off the fan, an element by index', () => {
    const value = users().select((u) => ({ id: u.id, posts: u.posts }));
    assert.deepStrictEqual(value.toDocument().$return, { id: '$it.id', posts: [POSTS()] });
    assert.deepStrictEqual(value.toArray().map((u) => u.posts.map((p) => p.pid)), [[1, 3], [2], []]);
    const titles = users().select((u) => ({ id: u.id, titles: [u.posts.all().title] }));
    assert.deepStrictEqual(titles.toDocument().$return, { id: '$it.id', titles: [POSTS('$r1.title')] });
    assert.deepStrictEqual(titles.toArray(), [
      { id: 'u1', titles: ['p1', 'p3'] }, { id: 'u2', titles: ['p2'] }, { id: 'u3', titles: [] },
    ]);
    const first = users().select((u) => u.posts.at(0).title);
    assert.deepStrictEqual(first.toDocument().$return, { $get: [{ $get: [[POSTS()], 0] }, 'title'] });
    assert.deepStrictEqual(first.toArray(), ['p1', 'p2']);
    // a member off the ARRAY is refused with the fix named, where the
    // same read off a stored array would answer nothing
    assert.throws(() => users().select((u) => u.posts.title),
      codeIs('JL0005', /\.all\(\)\.title/));
  });
});

describe('hops chain, and hop from every binding that holds rows', () => {
  it('two hops nest: the inner phrase correlates with the outer binding (r1, r2)', () => {
    const chain = posts().select((p) => ({ pid: p.pid, siblings: p.author.posts.all().count() }));
    assert.deepStrictEqual(chain.toDocument().$return, {
      pid: '$it.pid',
      siblings: { $count: AUTHOR(POSTS('$r2', 'r2', '$r1')) },
    });
    assert.deepStrictEqual(chain.toArray(), [
      { pid: 1, siblings: 2 }, { pid: 2, siblings: 1 }, { pid: 3, siblings: 2 }, { pid: 4, siblings: 0 },
    ]);
    // a hop off a fanned to-many is a sequence, one target per row
    const authors = users().select((u) => ({ id: u.id, by: [u.posts.all().author.email] }));
    assert.deepStrictEqual(authors.toDocument().$return.by, [{
      $for: { r1: '$.Post[*]' }, $where: { $eq: ['$r1.authorId', '$it.id'] },
      $return: { $for: { r2: '$.User[*]' }, $where: { $eq: ['$r2.id', '$r1.authorId'] }, $return: '$r2.email' },
    }]);
    assert.deepStrictEqual(authors.toArray(), [
      { id: 'u1', by: ['a@x', 'a@x'] }, { id: 'u2', by: ['b@x'] }, { id: 'u3', by: [] },
    ]);
    // two hops in one callback are two bindings
    assert.deepStrictEqual(posts().select((p) => ({ a: p.author.email, b: p.author.name })).explain().hops,
      [{ member: 'author', kind: 'oneToOne', binding: 'r1' }, { member: 'author', kind: 'oneToOne', binding: 'r2' }]);
  });

  it("a hop from a join's it2 and from a group-join's fanned group", () => {
    const joined = posts().join(users(), (p) => p.authorId, (u) => u.id,
      (p, u) => ({ title: p.title, n: u.posts.all().count() }));
    assert.deepStrictEqual(joined.toDocument(), {
      $for: { it: '$.Post[*]', it2: '$.User[*]' },
      $where: { $eq: ['$it.authorId', '$it2.id'] },
      $return: { title: '$it.title', n: { $count: POSTS('$r1', 'r1', '$it2') } },
    });
    assert.deepStrictEqual(joined.toArray(), [{ title: 'p1', n: 2 }, { title: 'p2', n: 1 }, { title: 'p3', n: 2 }]);
    // the group's rows are bound first, so each hops from its own row
    const grouped = users().groupJoin(posts(), (u) => u.id, (p) => p.authorId,
      (u, g) => ({ id: u.id, names: [g.all().author.name] }));
    assert.deepStrictEqual(grouped.toDocument().$return.names, [{
      $for: { r1: '$g[*]' },
      $return: { $for: { r2: '$.User[*]' }, $where: { $eq: ['$r2.id', '$r1.authorId'] }, $return: '$r2.name' },
    }]);
    assert.deepStrictEqual(grouped.toArray(), [
      { id: 'u1', names: ['ada', 'ada'] }, { id: 'u2', names: ['lin'] }, { id: 'u3', names: [] },
    ]);
    // the group itself is an array: a relation name on it is a plain path
    assert.strictEqual(users().groupJoin(posts(), (u) => u.id, (p) => p.authorId,
      (u, g) => g.author).toDocument().$return, '$g.author');
  });

  it('a projection ends navigation: the items are no longer rows', () => {
    const projected = posts().select((p) => ({ a: p.author })).where((x) => x.a.email.eq('a@x'));
    assert.deepStrictEqual(projected.toDocument().$where, { $eq: ['$it.a.email', 'a@x'] });
    assert.deepStrictEqual(projected.select((x) => x.a.id).toArray(), ['u1', 'u1']);
    for (const build of [
      (s) => s.groupBy((p) => p.stars).where((x) => x.author.exists()),
      (s) => s.aggregate(0, (acc) => acc.add(1)).where((x) => x.author.exists()),
      (s) => s.join(users(), (p) => p.authorId, (u) => u.id, (p) => p).where((x) => x.author.exists()),
    ]) {
      assert.deepStrictEqual(build(posts()).toDocument().$where, { $exists: '$it.author' });
    }
    // and the non-projecting stages keep it
    const kept = posts().where((p) => p.stars.gt(0)).orderBy((p) => p.pid).skip(0).take(9).distinct()
      .reverse().defaultIfEmpty(null).where((p) => p.author.exists());
    assert.deepStrictEqual(kept.toDocument().$where, { $exists: AUTHOR() });
  });
});

describe('the seam: which providers navigate, and how the two surfaces agree', () => {
  it('a provider without a table, a fromDocument, and an unresolved target read relation names as members', () => {
    const bare = { root: '$.Post[*]', execute: () => [] };
    assert.strictEqual(from(bare).select((p) => p.author.email).toDocument().$return, '$it.author.email');
    assert.strictEqual(fromDocument(entitySet('Post', scope), '$.Post[*]')
      .select((p) => p.author.email).toDocument().$return, '$it.author.email');
    // a scope without the target's table: the first hop lowers, the target's members are paths
    const alone = { root: '$.Post[*]', relations: TABLES.Post, execute: () => [] };
    assert.deepStrictEqual(from(alone).select((p) => p.author.posts).toDocument().$return, AUTHOR('$r1.posts'));
    assert.deepStrictEqual(from(entitySet('Post', {})).select((p) => p.author.posts).toDocument().$return, AUTHOR('$r1.posts'));
  });

  it('from and fromAsync emit byte-identical hop documents, and both explain the hops', async () => {
    const builds = [
      (f) => f(entitySet('Post', scope)).select((p) => ({ title: p.title, by: p.author.email })),
      (f) => f(entitySet('User', scope)).where((u) => u.posts.all().count().ge(2)),
      (f) => f(entitySet('Post', scope)).orderBy((p) => p.author.name).select((p) => p.author.posts.all().count()),
      (f) => f(entitySet('Post', scope)).join(f(entitySet('User', scope)), (p) => p.authorId, (u) => u.id,
        (p, u) => ({ t: p.title, n: u.posts.all().count() })),
    ];
    for (const build of builds) {
      assert.strictEqual(canonicalizeJson(build(fromAsync).toDocument()), canonicalizeJson(build(from).toDocument()));
      assert.deepStrictEqual(build(fromAsync).explain().hops, build(from).explain().hops);
    }
    const first = builds[0](from);
    assert.deepStrictEqual(first.explain().hops, [{ member: 'author', kind: 'oneToOne', binding: 'r1' }]);
    assert.deepStrictEqual(builds[2](from).explain().hops, [
      { member: 'author', kind: 'oneToOne', binding: 'r1' },
      { member: 'author', kind: 'oneToOne', binding: 'r1' },
      { member: 'posts', kind: 'oneToMany', binding: 'r2' },
    ], 'per phrase: each clause numbers its own hops');
    assert.deepStrictEqual(await builds[0](fromAsync).toArray(), first.toArray());
    // a chain with no hop says so; a mapAsync split keeps the pushed prefix's hops
    assert.deepStrictEqual(posts().where((p) => p.stars.gt(1)).explain().hops, []);
    const split = fromAsync(entitySet('Post', scope)).where((p) => p.author.exists())
      .mapAsync(async (p) => p, { concurrency: 1 }).where((p) => p.author.exists());
    assert.deepStrictEqual(split.explain().hops, [{ member: 'author', kind: 'oneToOne', binding: 'r1' }]);
    assert.deepStrictEqual(split.explain().split.residual, ['mapAsync', 'where']);
  });

  it('the hop bindings r1, r2, … are reserved parameter names (JL0004), as it/it2/acc/g are', () => {
    for (const name of ['r1', 'r2', 'r10', 'it', 'it2', 'acc', 'g']) {
      assert.throws(() => posts().params({ [name]: 1 }), codeIs('JL0004', /reserved/), name);
      assert.throws(() => fromAsync(entitySet('Post', scope)).params({ [name]: 1 }), codeIs('JL0004', /reserved/), name);
    }
    // r0, r01 and rx are ordinary names: the bindings count from r1
    for (const name of ['r0', 'r01', 'rx', 'r']) posts().params({ [name]: 1 });
    assert.match(String((() => { try { posts().params({ r1: 1 }); } catch (e) { return e.message; } return ''; })()),
      /r1, r2, …/);
  });

  it('JL0105: a many-to-many hop names the join table and load({ include }); a broken entry is refused', () => {
    assert.throws(() => users().where((u) => u.labels.all().count().ge(1)),
      codeIs('JL0105', /'Label_User'/));
    assert.throws(() => users().select((u) => u.labels),
      codeIs('JL0105', /load\(\{ include: \{ labels: true \} \}\)/));
    assert.throws(() => fromAsync(entitySet('User', scope)).select((u) => u.labels), codeIs('JL0105'));
    const broken = (author) => from({ root: '$.Post[*]', relations: { author }, execute: () => [] })
      .select((p) => p.author.email);
    assert.throws(() => broken({ to: 'User', kind: 'oneToOne', via: 'authorId', fkEntity: 'Post', fkTargets: 'User' }),
      codeIs('JL0105', /composite or undeclared/));
    assert.throws(() => broken({ to: 'User', kind: 'sideways', targetKey: 'id', via: 'x' }), codeIs('JL0105', /sideways/));
    assert.throws(() => broken('User'), codeIs('JL0105', /not a relation record/));
  });
});
