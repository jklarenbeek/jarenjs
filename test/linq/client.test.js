//@ts-check
/**
 * @file The client (`@jarenjs/linq/db`): `open()` fronts a store with
 * handles built from the model's names; every read is the chain and
 * pushes down (`explain()` names the translator); `include()` EMITS the
 * store's `load` spec byte for byte and the store runs it in one
 * statement (a counting driver says so); `link`/`unlink` reach the
 * store's own membership API through `saveChanges()` (two-run checked);
 * `live` is the store's registration with the chain's bindings; the
 * default validator asserts formats; `JL0107` names what the client
 * refuses; and the store's own refusals surface unchanged.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { open, defaultValidator } from '@jarenjs/linq/db';
import { from, fromAsync } from '@jarenjs/linq';
import * as m from '@jarenjs/linq/model';
import { JarenValidator } from '@jarenjs/validate';
import { stringFormats } from '@jarenjs/formats';
import { nodeDriver, adaptNodeDatabase } from '@jarenjs/db/node';

import { compileArtifact } from '../json/schema-artifact-helpers.js';
import { placesModel } from './model-corpus.js';
import { FIXTURE_MODEL } from '../db/emit-model-fixture.js';

// a model with a format, two many-to-many members, an auto key and a
// two-level include path — every shape the client's claims name
const User = m.object({
  id: m.string().identity('uuid'),
  email: m.string().email(),
  age: m.integer().optional(),
  posts: m.rel.hasMany('Post', { via: 'authorId', onDelete: 'cascade' }),
  labels: m.rel.belongsToMany('Label'),
});
const Post = m.object({
  pid: m.integer().identity('auto'),
  title: m.string(),
  stars: m.integer(),
  authorId: m.string(),
  author: m.rel.hasOne('User', { via: 'authorId', onDelete: 'cascade' }),
  comments: m.rel.hasMany('Comment', { via: 'postId', onDelete: 'cascade' }),
  tags: m.rel.belongsToMany('Label', { through: 'post_tags' }),
});
const Comment = m.object({
  cid: m.integer().identity('auto'),
  text: m.string(),
  postId: m.integer(),
});
const Label = m.object({ name: m.string().key() });
const model = m.defineModel({ entities: { User, Post, Comment, Label } });

const codeIs = (code, pattern = undefined) => (e) =>
  e.code === code && (pattern === undefined || pattern.test(e.message));

/** The error a build raises, for a message a test reads rather than matches. */
function refusalOf(build) {
  try { build(); }
  catch (err) { return /** @type {any} */ (err); }
  return assert.fail('expected a refusal');
}

/** A counting shim: every statement execution counted. */
function countedDriver(counters) {
  const db = new DatabaseSync(':memory:');
  const count = (fn) => (...params) => {
    counters.executed++;
    return fn(...params);
  };
  return {
    open: () => adaptNodeDatabase({
      exec: count((sql) => db.exec(sql)),
      prepare: (sql) => {
        const statement = db.prepare(sql);
        return {
          run: count((...p) => statement.run(...p)),
          get: count((...p) => statement.get(...p)),
          all: count((...p) => statement.all(...p)),
          iterate: count((...p) => statement.iterate(...p)),
        };
      },
      function: (name, options, fn) => db.function(name, options, fn),
      aggregate: (name, spec) => db.aggregate(name, spec),
      createSession: (options) => db.createSession(options),
      close: () => db.close(),
    }),
  };
}

/** Two users, four posts, comments on the first two, three labels. */
async function seeded(options = {}) {
  const client = await open(model, { driver: nodeDriver(), ...options });
  const ada = await client.entities.User.create({ email: 'ada@x.test', age: 36 });
  const lin = await client.entities.User.create({ email: 'lin@x.test', age: 64 });
  const posts = [];
  for (const [title, stars, author] of [['p1', 3, ada], ['p2', 1, ada], ['p3', 4, lin], ['p4', 5, ada]]) {
    posts.push(await client.entities.Post.create({ title, stars, authorId: author.id }));
  }
  for (const post of posts.slice(0, 2)) {
    for (const text of ['c1', 'c2']) await client.entities.Comment.create({ text, postId: post.pid });
  }
  for (const name of ['admin', 'dev', 'ops']) await client.entities.Label.create({ name });
  return { client, ada, lin, posts };
}

describe('open(): the store behind a client', () => {
  it('forwards the store options, wires the default validator, and builds frozen handles from the model', async () => {
    const { client } = await seeded();
    assert.strictEqual(client.capabilities.validated, true);
    assert.strictEqual(client.capabilities, client.store.capabilities);
    assert.deepStrictEqual(Object.keys(client.entities), ['User', 'Post', 'Comment', 'Label']);
    assert.deepStrictEqual(Object.keys(client.collections), []);
    assert.ok(Object.isFrozen(client) && Object.isFrozen(client.entities) && Object.isFrozen(client.entities.User));
    assert.strictEqual(client.entities.Nope, undefined, 'no Proxy: an unknown name is undefined');
    // the pass-throughs, and the transaction client: the callback gets a
    // client of the same shape, over the store INSIDE the transaction
    assert.strictEqual(await client.transaction(async (tx) => {
      assert.deepStrictEqual(Object.keys(tx.entities), Object.keys(client.entities));
      assert.ok(Object.isFrozen(tx) && Object.isFrozen(tx.entities));
      assert.strictEqual(typeof tx.saveChanges, 'function');
      assert.strictEqual(typeof tx.transaction, 'function');
      return (await tx.store.entity('User').get('nope'))
        ?? (await tx.entities.User.where((u) => u.id.eq('nope')).firstOrDefault())
        ?? 42;
    }), 42);
    assert.strictEqual(typeof client.store.entity, 'function');
    await client.close();
  });

  it('the default validator asserts formats; a given validator is used; an explicit compileSchema wins', async () => {
    const { client } = await seeded();
    await assert.rejects(client.entities.User.create({ email: 'nope' }),
      (e) => e.code === 'JD2003' && e.errors.some((issue) => issue.keyword === 'format'));
    assert.ok(defaultValidator() instanceof JarenValidator);
    await client.close();

    // a validator that answers a boolean: the refusal carries no issue list
    const plain = new JarenValidator().addFormats(stringFormats);
    const given = await open(model, { driver: nodeDriver(), validator: plain });
    assert.strictEqual(given.capabilities.validated, true);
    await assert.rejects(given.entities.User.create({ email: 'nope' }),
      (e) => e.code === 'JD2003' && e.errors === undefined);
    await given.close();

    // compileSchema, given, is the store's hook — the validator is not consulted
    const accepting = await open(model, {
      driver: nodeDriver(), validator: plain, compileSchema: () => () => true,
    });
    const made = await accepting.entities.User.create({ email: 'nope' });
    assert.strictEqual(made.email, 'nope');
    await accepting.close();

    // an unvalidated store is chosen by name, never by omission
    const unvalidated = await open(model, { driver: nodeDriver(), validator: null });
    assert.strictEqual(unvalidated.capabilities.validated, false);
    assert.strictEqual((await unvalidated.entities.User.create({ email: 'nope' })).email, 'nope');
    await unvalidated.close();
    await assert.rejects(open(model, /** @type {any} */ (undefined)), TypeError);
    await assert.rejects(open(model, { driver: nodeDriver(), validator: /** @type {any} */ (42) }),
      (e) => e instanceof TypeError && /JarenValidator/.test(e.message));
  });

  it('a JSON model opens the same way; a collections-only model has no unit of work', async () => {
    const json = await open(FIXTURE_MODEL, { driver: nodeDriver() });
    assert.deepStrictEqual(Object.keys(json.entities), ['User', 'Post', 'Label', 'Grade']);
    const ada = await json.entities.User.create({ email: 'ada@x' });
    assert.deepStrictEqual(await json.entities.User.select((u) => u.email).toArray(), ['ada@x']);
    assert.strictEqual(typeof json.saveChanges, 'function');
    await json.close();
    void ada;

    const places = await open(placesModel, { driver: nodeDriver() });
    assert.deepStrictEqual(Object.keys(places.collections), ['places', 'log']);
    assert.strictEqual(places.saveChanges, undefined);
    assert.strictEqual(places.live, undefined);
    await places.close();
  });
});

describe('entity handles: the set, the chain, the provider', () => {
  it('carries every member of the store\'s entity set and starts the chain over it', async () => {
    const { client } = await seeded();
    const handle = client.entities.Post;
    for (const member of ['create', 'get', 'update', 'delete', 'load', 'explainLoad', 'add', 'put',
      'remove', 'discard', 'link', 'unlink', 'asNoTracking', 'execute', 'explain',
      'where', 'select', 'orderBy', 'join', 'toArray', 'first', 'count', 'params', 'mapAsync', 'toDocument',
      'include', 'live']) {
      assert.strictEqual(typeof handle[member], 'function', member);
    }
    assert.strictEqual(handle.root, '$.Post[*]');
    assert.strictEqual(handle.scope, client.entities.User.scope, 'one scope per store');
    assert.deepStrictEqual(Object.keys(handle.relations), ['author', 'comments', 'tags']);
    assert.strictEqual(typeof handle[Symbol.asyncIterator], 'function');
    await client.close();
  });

  it('a chain over a handle pushes down: explain() names the translator and no residual', async () => {
    const { client } = await seeded();
    const chain = client.entities.Post.where((p) => p.stars.ge(3));
    const expected = { $for: { it: '$.Post[*]' }, $where: { $ge: ['$it.stars', 3] }, $return: '$it' };
    assert.deepStrictEqual(chain.toDocument(), expected);
    assert.deepStrictEqual(chain.explain(), { barriers: [], streaming: 'row', barrier: null, hops: [], bindings: {}, document: expected });
    const explained = await client.entities.Post.explain(chain.toDocument());
    assert.strictEqual(explained.mode, 'native');
    assert.deepStrictEqual(explained.referenced, ['Post']);
    assert.match(explained.sql, /^SELECT /);
    const rows = await chain.orderBy((p) => p.pid).select((p) => p.title).toArray();
    assert.deepStrictEqual(rows, ['p1', 'p3', 'p4']);
    // the handle's own explain(): the empty chain
    assert.deepStrictEqual(client.entities.Post.explain(),
      { barriers: [], streaming: 'row', barrier: null, hops: [], bindings: {}, document: '$.Post[*]' });
    assert.strictEqual(client.entities.Post.toDocument(), '$.Post[*]');
    // terminals, a hop, params, the iterator, and fromAsync over the handle itself
    assert.strictEqual(await client.entities.Post.count(), 4);
    assert.strictEqual((await client.entities.Post.orderByDescending((p) => p.stars).first()).title, 'p4');
    assert.deepStrictEqual(
      await client.entities.Post.where((p) => p.author.email.eq('lin@x.test')).select((p) => p.title).toArray(),
      ['p3']);
    assert.deepStrictEqual(
      await client.entities.Post.params({ min: 4 }).where((p, q) => p.stars.ge(q.min)).select((p) => p.title).toArray(),
      ['p3', 'p4']);
    const seen = [];
    for await (const user of client.entities.User) seen.push(user.email);
    assert.deepStrictEqual(seen.sort(), ['ada@x.test', 'lin@x.test']);
    assert.strictEqual(await fromAsync(client.entities.User).count(), 2);
    // two handles of one client join in one document (the inner is a chain,
    // as the async join demands: `fromAsync(handle)` is the whole set)
    const joined = await client.entities.Post
      .join(fromAsync(client.entities.User), (p) => p.authorId, (u) => u.id, (p, u) => ({ t: p.title, e: u.email }))
      .toArray();
    assert.deepStrictEqual(joined.map((r) => r.e).sort(), ['ada@x.test', 'ada@x.test', 'ada@x.test', 'lin@x.test']);
    await client.close();
  });
});

describe('include(): the emitted load spec, the one statement, the widened rows', () => {
  it('emits the spec MODEL-FORMAT §10.4 reads, byte for byte, and loads in one statement', async () => {
    const counters = { executed: 0 };
    const { client, ada } = await seeded({ driver: countedDriver(counters) });
    const graph = client.entities.User.include((u) => u.posts, { where: (p) => p.stars.ge(3), take: 2 });
    const expected = { include: { posts: { where: { $ge: ['$it.stars', 3] }, take: 2 } } };
    assert.strictEqual(JSON.stringify(graph.toSpec()), JSON.stringify(expected), 'byte-equal, member order included');
    assert.strictEqual(JSON.stringify(graph), JSON.stringify(expected), 'toJSON() is the document, as a pen\'s');
    assert.deepStrictEqual(graph.toSpec(), graph.toSpec(), 'two builds are one document');
    assert.ok(Object.isFrozen(graph.toSpec()) && Object.isFrozen(graph.toSpec().include.posts));
    counters.executed = 0;
    const users = await graph.orderBy((u) => u.email).toArray();
    assert.strictEqual(counters.executed, 1, `expected ONE statement, counted ${counters.executed}`);
    assert.deepStrictEqual(users.map((u) => [u.email, u.posts.map((p) => p.title)]),
      [['ada@x.test', ['p1', 'p4']], ['lin@x.test', ['p3']]]);
    assert.strictEqual(users[0].id, ada.id);
    // the graph's explain() is the store's explainLoad
    const explained = graph.explain();
    assert.deepStrictEqual(explained.includes, [{ path: 'posts', kind: 'oneToMany', count: false }]);
    assert.strictEqual(explained.pagination, 'none');
    assert.match(explained.sql, /json_group_array/);
    await client.close();
  });

  it('accumulates includes, counts, nested includes and every root clause; the store keys pagination', async () => {
    const { client, posts } = await seeded();
    const graph = client.entities.Post
      .include((p) => p.author, { include: { labels: true } })
      .include((p) => p.comments, { count: true })
      .where((p) => p.stars.ge(1))
      .where((p) => p.title.ne('none'))
      .orderBy((p) => p.pid)
      .take(2)
      .after(posts[0].pid)
      .maxDepth(4);
    assert.deepStrictEqual(graph.toSpec(), {
      where: { $and: [{ $ge: ['$it.stars', 1] }, { $ne: ['$it.title', 'none'] }] },
      orderBy: '$it.pid',
      take: 2,
      after: posts[0].pid,
      maxDepth: 4,
      include: { author: { include: { labels: true } }, comments: { count: true } },
    });
    assert.strictEqual(graph.explain().pagination, 'keyset');
    const rows = await graph.toArray();
    assert.deepStrictEqual(rows.map((p) => [p.title, p.author.email, p.author.labels, p.comments]),
      [['p2', 'ada@x.test', [], 2], ['p3', 'lin@x.test', [], 0]]);
    // ordering spellings on a graph: a bare key ascending, a spec otherwise;
    // skip is offset (on the handle itself these members start the CHAIN —
    // a graph is opened by include)
    const ordered = client.entities.Post.include((p) => p.comments, { count: true })
      .orderByDescending((p) => p.stars).thenBy((p) => p.title, { empty: 'greatest' }).thenByDescending((p) => p.pid)
      .skip(1).take(2);
    assert.deepStrictEqual(ordered.toSpec(), {
      orderBy: [{ $key: '$it.stars', $dir: 'desc' }, { $key: '$it.title', $empty: 'greatest' }, { $key: '$it.pid', $dir: 'desc' }],
      take: 2, skip: 1,
      include: { comments: { count: true } },
    });
    assert.strictEqual(ordered.explain().pagination, 'offset');
    assert.deepStrictEqual((await ordered.toArray()).map((p) => [p.title, p.comments]), [['p3', 0], ['p1', 2]]);
    assert.ok(client.entities.Post.orderByDescending((p) => p.stars).toSpec === undefined, 'the handle starts the chain');
    // an include spec's orderBy takes the same spellings
    const spelled = client.entities.User.include((u) => u.posts, {
      orderBy: [{ key: (p) => p.stars, desc: true }, (p) => p.pid], skip: 1, take: 1,
    });
    assert.deepStrictEqual(spelled.toSpec().include.posts,
      { orderBy: [{ $key: '$it.stars', $dir: 'desc' }, '$it.pid'], take: 1, skip: 1 });
    assert.deepStrictEqual((await spelled.where((u) => u.email.eq('ada@x.test')).toArray())[0].posts.map((p) => p.title), ['p1']);
    // a bracketed pick and asNoTracking()
    const tracked = client.store.stats().tracker.tracked;
    const bare = await client.entities.User.include((u) => u.get('labels')).asNoTracking().toArray();
    assert.deepStrictEqual(bare.map((u) => u.labels), [[], []]);
    assert.strictEqual(client.store.stats().tracker.tracked, tracked, 'asNoTracking registers nothing');
    await client.close();
  });

  it('refuses what it cannot spell, and passes the store\'s own refusals through', async () => {
    const { client } = await seeded();
    const users = client.entities.User;
    assert.throws(() => users.include((u) => u.email), codeIs('JL0107', /'posts', 'labels'/));
    assert.throws(() => users.include((u) => u.age.ge(1)), codeIs('JL0107', /operator result/));
    assert.throws(() => users.include(/** @type {any} */ ('posts')), codeIs('JL0101', /callback/));
    assert.throws(() => users.include((u) => u.posts, /** @type {any} */ ({ wehre: 1 })), codeIs('JL0101', /'wehre'/));
    assert.throws(() => users.include((u) => u.posts, /** @type {any} */ ({ after: 1 })), codeIs('JL0101', /after\(\) on the graph/));
    assert.throws(() => users.include((u) => u.posts, /** @type {any} */ ({ count: 1 })), codeIs('JL0101', /count takes true/));
    assert.throws(() => users.include((u) => u.posts, /** @type {any} */ ({ orderBy: 5 })), codeIs('JL0101', /key callback/));
    assert.throws(() => users.include((u) => u.posts, /** @type {any} */ ({ include: { nope: true } })), codeIs('JL0107', /'nope'/));
    assert.throws(() => users.include((u) => u.posts, /** @type {any} */ ({ include: 3 })), codeIs('JL0101', /record of relation members/));
    assert.throws(() => users.include((u) => u.posts, /** @type {any} */ ({ take: new Date(0) })), codeIs('JL0101', /Date/));
    assert.throws(() => users.include((u) => u.posts, /** @type {any} */ (7)), codeIs('JL0101'));
    // the shape message and the member check must not disagree: the first
    // listed `after?` while the second refused `after` by name, so a reader
    // who believed the message met the refusal. The list is derived from
    // INCLUDE_KEYS now, and this holds the two together.
    const shape = refusalOf(() => users.include((u) => u.posts, /** @type {any} */ (7)));
    const named = [...shape.message.matchAll(/(\w+)\?/g)].map((m) => m[1]);
    assert.ok(named.length >= 5, `the shape message lists its members: ${shape.message}`);
    for (const member of named) {
      // an `undefined` value passes the member-SET check and is then skipped,
      // so anything that throws here is a member the spec does not take
      assert.doesNotThrow(() => users.include((u) => u.posts, /** @type {any} */ ({ [member]: undefined })),
        `the shape message names '${member}', which the member check refuses`);
    }
    assert.throws(() => users.include((u) => u.posts).thenBy((u) => u.email), codeIs('JL0005', /orderBy/));
    assert.throws(() => users.include((u) => u.posts).where(/** @type {any} */ ((u, p) => u.age.gt(p.min))), codeIs('JL0004'));
    // the store's: a count beside a take, a clause the load engine cannot translate
    assert.throws(() => users.include((u) => u.posts, /** @type {any} */ ({ count: true, take: 1 })).explain(), codeIs('JD0032', /count: true/));
    assert.throws(() => client.entities.Post.include((p) => p.comments, { where: (c) => c.text.length().gt(1) }).explain(),
      codeIs('JD0032', /not translatable/));
    await client.close();
  });
});

describe('link() and unlink(): the store\'s membership API, typed by the relation table', () => {
  it('a link saves one join row; the same link saved again changes nothing; unlink removes it', async () => {
    const { client, ada } = await seeded();
    const users = client.entities.User;
    users.link(ada, 'labels', 'admin');
    assert.strictEqual((await client.saveChanges()).joinInserted, 1);
    users.link(ada.id, 'labels', { name: 'admin' });
    const again = await client.saveChanges();
    assert.strictEqual(again.joinInserted, 0);
    assert.strictEqual(again.statements.length, 0, 'two-run: nothing to write');
    const withLabels = await users.include((u) => u.labels).where((u) => u.id.eq(ada.id)).toArray();
    assert.deepStrictEqual(withLabels[0].labels.map((l) => l.name), ['admin']);
    users.unlink(ada, 'labels', 'admin');
    assert.strictEqual((await client.saveChanges()).joinDeleted, 1);
    assert.strictEqual((await client.saveChanges()).statements.length, 0);
    await client.close();
  });

  it('refuses a member that is not many-to-many (JL0107) and an unsaved own key (the store\'s own words)', async () => {
    const { client, ada } = await seeded();
    assert.throws(() => client.entities.User.link(ada, 'posts', 1), codeIs('JL0107', /oneToMany/));
    assert.throws(() => client.entities.Post.link(1, 'author', ada.id), codeIs('JL0107', /oneToOne/));
    assert.throws(() => client.entities.User.unlink(ada, 'email', 'x'), codeIs('JL0107', /'labels'/));
    assert.throws(() => client.entities.Comment.link(1, 'nope', 'x'), codeIs('JL0107', /declares none/));
    // a key the SAVE allocates is attached from the insert's RETURNING —
    // one save, the row and its join row
    const draft = client.entities.Post.add({ title: 'draft', stars: 0, authorId: ada.id });
    client.entities.Post.link(draft, 'tags', 'admin');
    assert.strictEqual((await client.saveChanges()).joinInserted, 1);
    // …and a document that belongs to nothing tracked still refuses
    assert.throws(() => client.entities.Post.link({ title: 'never added' }, 'tags', 'admin'),
      codeIs('JD2003', /save the entity first, then attach/));
    const saved = await client.entities.Post.where((p) => p.title.eq('draft')).single();
    client.entities.Post.link(saved, 'tags', 'dev');
    assert.strictEqual((await client.saveChanges()).joinInserted, 1);
    assert.strictEqual(client.store.stats().tracker.pendingMemberships, 0);
    await client.close();
  });
});

describe('live(): the store\'s registration with the chain\'s document and bindings', () => {
  it('an entity chain registers in re-run mode and follows writes; JD0050 without capture', async () => {
    const { client } = await seeded();
    await assert.rejects(client.live(client.entities.Post.where((p) => p.stars.ge(3))), codeIs('JD0050'));
    await client.close();

    const { client: live, ada } = await seeded({ capture: true });
    const query = await live.live(live.entities.Post.where((p) => p.stars.ge(3)));
    assert.deepStrictEqual(Object.keys(query).sort(),
      ['close', 'error', 'mode', 'result', 'state', 'stats', 'subscribe'].sort());
    assert.deepStrictEqual(query.mode, { strategy: 'rerun', mode: 'rerun', reason: 'entity queries re-run in this version' });
    assert.strictEqual(query.result.rows.length, 3);
    const emissions = [];
    const stop = query.subscribe((event) => emissions.push(event));
    await live.entities.Post.create({ title: 'p5', stars: 9, authorId: ada.id });
    assert.strictEqual(query.result.rows.length, 4, 'the re-run saw the write');
    assert.ok(emissions.length >= 1 && Array.isArray(emissions[0].patch));
    stop();
    query.close();
    // the chain's bindings are the externals; options.externals merge over them
    const bound = await live.live(live.entities.Post.params({ min: 4 }).where((p, q) => p.stars.ge(q.min)));
    assert.strictEqual(bound.result.rows.length, 3);
    const overridden = await live.live(
      live.entities.Post.params({ min: 4 }).where((p, q) => p.stars.ge(q.min)), { externals: { min: 9 } });
    assert.strictEqual(overridden.result.rows.length, 1);
    // the handle's live(): the whole set when nothing is given; a document is accepted too
    const whole = await live.entities.User.live();
    assert.strictEqual(whole.result.rows.length, 2);
    const doc = await live.live({ $for: { it: '$.User[*]' }, $where: { $gt: ['$it.age', 40] }, $return: '$it' });
    assert.strictEqual(doc.result.rows.length, 1);
    // a chain split by a host callback has no document to register
    await assert.rejects(async () => live.live(
      live.entities.Post.mapAsync(async (p) => p, { concurrency: 1 })), codeIs('JL0005', /mapAsync/));
    await live.close();
  });

  it('a collection handle chains, explains and maintains its own live query', async () => {
    const places = await open(placesModel, { driver: nodeDriver(), capture: true });
    const handle = places.collections.places;
    for (const [id, t] of [['p1', 1], ['p2', 2], ['p3', 3]]) {
      await handle.insert({ id, loc: [4.9, 52.3], series: 's', t });
    }
    assert.strictEqual((await handle.get('p1')).t, 1);
    const chain = handle.where((p) => p.t.gt(1)).select((p) => p.id);
    assert.deepStrictEqual(await chain.toArray(), ['p2', 'p3']);
    assert.strictEqual((await handle.explain(handle.where((p) => p.t.gt(1)).toDocument())).mode, 'native');
    assert.strictEqual((await handle.explain(chain.toDocument())).mode, 'native', 'one member path projects natively');
    assert.strictEqual(handle.explain().document, '$[*]');
    const query = await handle.live(handle.where((p) => p.t.gt(1)));
    assert.strictEqual(query.mode.mode, 'incremental');
    assert.strictEqual(query.result.rows.length, 2);
    await handle.insert({ id: 'p4', loc: [4.9, 52.3], series: 's', t: 4 });
    assert.strictEqual(query.result.rows.length, 3);
    query.close();
    const seen = [];
    for await (const row of handle) seen.push(row.id);
    assert.deepStrictEqual(seen.sort(), ['p1', 'p2', 'p3', 'p4']);
    await places.close();
  });
});

describe('the in-memory chain agrees with the client\'s', () => {
  it('the same chain over the handle and over the rows answers the same', async () => {
    const { client } = await seeded();
    const rows = await client.entities.Post.asNoTracking().load({ orderBy: '$it.pid' });
    const build = (source) => from(source).where((p) => p.stars.ge(3)).orderByDescending((p) => p.stars).select((p) => p.title);
    assert.deepStrictEqual(await client.entities.Post.where((p) => p.stars.ge(3)).orderByDescending((p) => p.stars).select((p) => p.title).toArray(),
      build(rows).toArray());
    await client.close();
  });
});

describe('the chain and the client emit jaren-query documents', () => {
  // The agreement's grammar cell for the `.` entry and for `./db`. Every
  // pen validates its emission against the published artifact of the
  // format it writes; the chain writes query documents, so this is that
  // same check for the one "pen" that was here before the word existed —
  // over the corpus a generator produced from real chains (which is why
  // no document below was typed by hand) and over documents this suite's
  // own client emits.
  const load = (file) => JSON.parse(fs.readFileSync(new URL(file, import.meta.url), 'utf8'));
  const grammars = [
    ['2020-12', compileArtifact(load('../../packages/json/schemas/jaren-query.schema.json'))],
    ['draft-07', compileArtifact(load('../../packages/json/schemas/jaren-query.draft-07.schema.json'))],
  ];

  it('the grammar check is load-bearing', () => {
    for (const [draft, validate] of grammars) {
      assert.strictEqual(validate({ $for: { it: '$[*]' }, $return: '$it' }), true, draft);
      assert.strictEqual(validate({ $for: 'not an object', $return: '$it' }), false, draft);
      assert.strictEqual(validate({ $nonsense: 1 }), false, draft);
    }
  });

  it('every document of the generated roots and hops corpora validates under both artifacts', () => {
    let checked = 0;
    for (const file of ['14-linq-roots.json', '15-linq-hops.json']) {
      const { cases } = load(`../db/oracle/relations/${file}`);
      assert.ok(cases.length > 0, `${file} carries cases`);
      for (const entry of cases) {
        // a terminal that emits an aggregate is one bare document; every
        // other case is the one-item window array the chain hands a provider
        const emitted = Array.isArray(entry.query) ? entry.query : [entry.query];
        for (const document of emitted) {
          for (const [draft, validate] of grammars) {
            assert.strictEqual(validate(document), true,
              `${file} :: ${entry.name} under ${draft}: ${JSON.stringify(document)}`);
          }
          checked++;
        }
      }
    }
    assert.ok(checked >= 20, `${checked} generated chain documents checked`);
  });

  it('a client chain, a hop, an ordered window and a terminal window all validate', async () => {
    const { client } = await seeded();
    try {
      const documents = [
        client.entities.Post.where((p) => p.stars.ge(3)).toDocument(),
        client.entities.Post.where((p) => p.author.email.eq('ada@x.test')).toDocument(),
        client.entities.Post.orderBy((p) => p.stars).skip(1).take(2).toDocument(),
        client.entities.Post.select((p) => ({ t: p.title, n: p.stars })).toDocument(),
        client.entities.Post.groupBy((p) => p.authorId).toDocument(),
        from([{ a: 1 }]).where((r) => r.a.gt(0)).toDocument(),
      ];
      for (const document of documents) {
        for (const [draft, validate] of grammars) {
          assert.strictEqual(validate(document), true,
            `under ${draft}: ${JSON.stringify(document)}`);
        }
      }
    }
    finally {
      await client.close();
    }
  });
});

describe('transaction(): a typed client bound to the transaction', () => {
  it('hands the callback the same handles, over the store inside the transaction', async () => {
    const { client, ada } = await seeded();
    const out = await client.transaction(async (tx) => {
      assert.deepStrictEqual(Object.keys(tx.entities), Object.keys(client.entities));
      assert.deepStrictEqual(Object.keys(tx.collections), Object.keys(client.collections));
      assert.strictEqual(tx.capabilities, client.capabilities);
      // the chain, the graph and the unit of work are all there
      const titles = await tx.entities.Post
        .where((p) => p.authorId.eq(ada.id)).select((p) => p.title).toArray();
      const graph = await tx.entities.User.include((u) => u.posts).toArray();
      tx.entities.Post.add({ title: 'inside', stars: 2, authorId: ada.id });
      const saved = await tx.saveChanges();
      assert.strictEqual(saved.inserted, 1);
      return { titles: titles.sort(), roots: graph.length };
    });
    assert.deepStrictEqual(out, { titles: ['p1', 'p2', 'p4'], roots: 2 });
    assert.strictEqual(await client.entities.Post.where((p) => p.title.eq('inside')).count(), 1);
    await client.close();
  });

  it('the transaction rolls back everything its client wrote', async () => {
    const { client, ada } = await seeded();
    const before = await client.entities.Post.count();
    await assert.rejects(() => client.transaction(async (tx) => {
      tx.entities.Post.add({ title: 'doomed', stars: 0, authorId: ada.id });
      await tx.saveChanges();
      await tx.entities.Label.create({ name: 'doomed-label' });
      throw new Error('abort');
    }), /abort/);
    assert.strictEqual(await client.entities.Post.count(), before);
    assert.strictEqual(await client.entities.Label.where((l) => l.name.eq('doomed-label')).count(), 0);
    await client.close();
  });

  it('two transactions hold independent trackers, and neither sees the other', async () => {
    const { client, ada } = await seeded();
    const seed = await client.entities.User.get(ada.id);
    // a change staged on the CLIENT's own unit of work
    client.entities.User.put({ ...seed, age: 99 });

    const inside = await client.transaction(async (tx) => {
      const mine = await tx.entities.User.get(ada.id);
      assert.strictEqual(mine.age, 36, "the client's pending change is not in here");
      tx.entities.User.put({ ...mine, age: 7 });
      assert.strictEqual(tx.store.stats().tracker.tracked, 1,
        'this transaction tracks its own record, not the client’s');
      return (await tx.saveChanges()).updated;
    });
    assert.strictEqual(inside, 1);
    assert.strictEqual((await client.entities.User.asNoTracking().get(ada.id)).age, 7);

    // one rolling back leaves the other's pending change intact
    await assert.rejects(() => client.transaction(async (tx) => {
      const mine = await tx.entities.User.get(ada.id);
      tx.entities.User.put({ ...mine, age: 1000 });
      await tx.saveChanges();
      throw new Error('abort');
    }), /abort/);
    assert.strictEqual((await client.saveChanges()).updated, 1,
      "the client's own pending change survived both transactions");
    assert.strictEqual((await client.entities.User.asNoTracking().get(ada.id)).age, 99);
    await client.close();
  });

  it("unitOfWork: 'shared' saves what was staged outside the transaction", async () => {
    const { client, ada } = await seeded();
    const seed = await client.entities.User.get(ada.id);
    client.entities.User.put({ ...seed, age: 51 });
    const report = await client.transaction(
      async (tx) => tx.saveChanges(), { unitOfWork: 'shared' });
    assert.strictEqual(report.updated, 1);
    assert.strictEqual((await client.entities.User.asNoTracking().get(ada.id)).age, 51);
    await client.close();
  });

  it('a root handle awaited from inside the transaction is JD0012, naming the fix', async () => {
    const { client } = await seeded({ queueTimeout: 40 });
    const started = Date.now();
    await assert.rejects(() => client.transaction(async (tx) => {
      await tx.entities.User.count();
      // the mistake: the CLIENT's handle, from inside the transaction
      // that owns the connection — it waits for itself
      await client.entities.User.count();
    }), (error) => /** @type {any} */ (error).code === 'JD0012'
      && /tx\.entities/.test(/** @type {any} */ (error).message));
    assert.ok(Date.now() - started < 2000, 'bounded, never a hang');
    await client.close();
  });

  it('it nests, and the nested client is bound to the savepoint', async () => {
    const { client, ada } = await seeded();
    await client.transaction(async (tx) => {
      tx.entities.Post.add({ title: 'outer', stars: 1, authorId: ada.id });
      await tx.saveChanges();
      await assert.rejects(() => tx.transaction(async (inner) => {
        inner.entities.Post.add({ title: 'inner', stars: 1, authorId: ada.id });
        await inner.saveChanges();
        throw new Error('inner boom');
      }), /inner boom/);
    });
    assert.strictEqual(await client.entities.Post.where((p) => p.title.eq('outer')).count(), 1);
    assert.strictEqual(await client.entities.Post.where((p) => p.title.eq('inner')).count(), 0);
    await client.close();
  });

  it('registers a live query from inside the transaction, and it outlives it', async () => {
    const { client, ada } = await seeded({ capture: true });
    const live = await client.transaction(async (tx) =>
      tx.live(tx.entities.Post.where((p) => p.stars.ge(4))));
    assert.deepStrictEqual(live.result.rows.map((/** @type {any} */ r) => r.title).sort(),
      ['p3', 'p4']);
    // the registration survives the commit, and later writes reach it
    await client.entities.Post.create({ title: 'p5', stars: 5, authorId: ada.id });
    assert.deepStrictEqual(live.result.rows.map((/** @type {any} */ r) => r.title).sort(),
      ['p3', 'p4', 'p5']);
    live.close();
    await client.close();
  });
});

describe('the typed client over the corrected scopes (order 07)', () => {
  it("capture + unitOfWork: 'own' keeps client and transaction trackers independent", async () => {
    // the C4 twin, through the typed door: the capture wrapper used to
    // drop ownWork, so the transaction consumed the client's pending state
    const { client, ada } = await seeded({ capture: true });
    const seed = await client.entities.User.get(ada.id);
    client.entities.User.put({ ...seed, age: 99 });   // staged on the CLIENT
    const inside = await client.transaction(async (tx) => {
      const mine = await tx.entities.User.get(ada.id);
      tx.entities.User.put({ ...mine, age: 7 });
      return (await tx.saveChanges()).updated;
    });
    assert.strictEqual(inside, 1, "the transaction's value lands first");
    assert.strictEqual((await client.saveChanges()).updated, 1,
      "the client's pending value still saves once afterwards");
    assert.strictEqual((await client.entities.User.asNoTracking().get(ada.id)).age, 99);
    await client.close();
  });

  it('a cancelled queued transaction never runs, capture on (JD2064)', async () => {
    const { client, ada } = await seeded({ capture: true });
    /** @type {(value?: any) => void} */
    let release = () => {};
    const gate = new Promise((resolve) => { release = resolve; });
    const holder = client.transaction(async () => { await gate; return 'held'; });
    const controller = new AbortController();
    let ran = false;
    const queued = client.transaction(async (tx) => {
      ran = true;
      await tx.entities.Post.create({ title: 'never', stars: 0, authorId: ada.id });
    }, { signal: controller.signal }).then(() => 'ran', (error) => error.code);
    controller.abort();
    const outcome = await queued;
    release();
    assert.strictEqual(await holder, 'held');
    assert.strictEqual(ran, false);
    assert.strictEqual(outcome, 'JD2064');
    assert.strictEqual(await client.entities.Post.where((p) => p.title.eq('never')).count(), 0);
    await client.close();
  });

  it('forwards tx.savepoints: partial rollback with the tracker agreeing', async () => {
    const { client, ada } = await seeded();
    await client.transaction(async (tx) => {
      await tx.savepoints.create('before-optional');
      tx.entities.Post.add({ title: 'optional', stars: 0, authorId: ada.id });
      assert.strictEqual((await tx.saveChanges()).inserted, 1);
      await tx.savepoints.rollbackTo('before-optional');
      // the database inside the transaction no longer holds the row,
      // and the withdrawn intention is PENDING again…
      assert.strictEqual(
        await tx.entities.Post.where((p) => p.title.eq('optional')).count(), 0);
      // …so the next save retries it exactly once
      assert.strictEqual((await tx.saveChanges()).inserted, 1);
      await tx.savepoints.release('before-optional');
    });
    assert.strictEqual(await client.entities.Post.where((p) => p.title.eq('optional')).count(), 1,
      'the retried save wrote once, never twice');
    assert.strictEqual(/** @type {any} */ (client).savepoints, undefined,
      'the root client deliberately has no twin');
    await client.close();
  });

  it('a client handle retained past its transaction is JD2070, never a later write', async () => {
    const { client, ada } = await seeded();
    /** @type {any} */
    let escaped;
    await client.transaction(async (tx) => { escaped = tx.entities.Post; });
    assert.throws(() => escaped.add({ title: 'smuggled', stars: 0, authorId: ada.id }),
      (error) => /** @type {any} */ (error).code === 'JD2070',
      'local bookkeeping refuses before touching any tracker');
    await assert.rejects(() => escaped.create({ title: 'direct', stars: 0, authorId: ada.id }),
      (error) => /** @type {any} */ (error).code === 'JD2070');
    const later = await client.transaction(async (tx) => (await tx.saveChanges()).inserted);
    assert.strictEqual(later, 0, 'no later scope inherits the escaped handle\'s work');
    assert.strictEqual(await client.entities.Post.where((p) => p.title.eq('smuggled')).count(), 0);
    await client.close();
  });
});
