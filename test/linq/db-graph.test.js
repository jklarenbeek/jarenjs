//@ts-check
/**
 * @file The graph cursor and the per-root include bounds. `graph.cursor()`
 * yields ONE root graph per pull with its includes attached, from the
 * same one statement `load` runs; breaking, throwing or aborting
 * releases that statement exactly once. A root whose include exceeds
 * its declared bound — rows per parent, serialised bytes per parent —
 * is the coded refusal `JD2073` naming the root, the member and the
 * bound, never a truncated graph; a bound always exists (the store
 * default, or the include's own `take`), and only a spelled `Infinity`
 * lifts it. The cursor registers no snapshots unless asked.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';

import { open } from '@jarenjs/linq/db';
import * as m from '@jarenjs/linq/model';
import { INCLUDE_ROWS_DEFAULT, INCLUDE_BYTES_DEFAULT } from '@jarenjs/db';

import { statementCountingDriver } from '../db/helpers.js';

const User = m.object({
  id: m.integer().key(),
  name: m.string(),
  posts: m.rel.hasMany('Post', { via: 'authorId', onDelete: 'cascade' }),
});
const Post = m.object({
  pid: m.integer().key(),
  title: m.string(),
  authorId: m.integer(),
  author: m.rel.hasOne('User', { via: 'authorId', onDelete: 'cascade' }),
  comments: m.rel.hasMany('Comment', { via: 'postId', onDelete: 'cascade' }),
});
const Comment = m.object({
  cid: m.integer().key(),
  text: m.string(),
  postId: m.integer(),
});
const model = m.defineModel({ entities: { User, Post, Comment } });

const codeIs = (code, pattern = undefined) => (error) =>
  error.code === code && (pattern === undefined || pattern.test(error.message));

/**
 * A client over the counting driver: `users` users with `postsEach`
 * posts each, the first post of every user carrying two comments; the
 * unit of work emptied after seeding.
 */
async function seeded(users = 20, postsEach = 3) {
  const counters = { iterate: 0, next: 0, return: 0, all: 0 };
  const client = await open(model, { driver: statementCountingDriver(counters), validator: null });
  const sync = client.store.sync;
  sync.transaction(() => {
    let pid = 1;
    let cid = 1;
    for (let u = 1; u <= users; u++) {
      sync.entity('User').create({ id: u, name: `user ${u}` });
      for (let p = 0; p < postsEach; p++) {
        sync.entity('Post').create({ pid, title: `post ${pid}`, authorId: u });
        if (p === 0) {
          for (const text of ['first', 'second']) sync.entity('Comment').create({ cid: cid++, text, postId: pid });
        }
        pid++;
      }
    }
  });
  for (const name of ['User', 'Post', 'Comment']) {
    // a create is a tracked write; the unit of work starts empty here
    const set = sync.entity(name);
    for (const doc of set.asNoTracking().load()) set.discard(doc);
  }
  for (const key of Object.keys(counters)) counters[key] = 0;
  return { client, counters };
}

describe('graph cursor yields one root per pull', () => {
  it('breaking after 3 of 10,000 roots with includes grows the heap by a bounded amount (forced GC, subprocess)', () => {
    const script = `
      import { open } from '@jarenjs/linq/db';
      import { nodeDriver } from '@jarenjs/db/node';
      const model = { $model: '0.1', entities: {
        User: { schema: { type: 'object', required: ['id'], properties: {
          id: { type: 'integer', 'x-entity': { key: true } }, name: { type: 'string' },
          posts: { 'x-entity': { relation: { to: 'Post', many: true, via: 'authorId', onDelete: 'cascade' } } } } } },
        Post: { schema: { type: 'object', required: ['pid', 'authorId'], properties: {
          pid: { type: 'integer', 'x-entity': { key: true } }, title: { type: 'string' },
          authorId: { type: 'integer' } } } } } };
      const client = await open(model, { driver: nodeDriver(), validator: null });
      const sync = client.store.sync;
      sync.transaction(() => {
        let pid = 1;
        for (let u = 1; u <= 10000; u++) {
          sync.entity('User').create({ id: u, name: 'user ' + u + ' ' + 'x'.repeat(60) });
          for (let p = 0; p < 3; p++) sync.entity('Post').create({ pid: pid++, title: 'post ' + 'y'.repeat(60), authorId: u });
        }
      });
      globalThis.gc();
      const before = process.memoryUsage().heapUsed;
      let count = 0;
      let first = null;
      for await (const user of client.entities.User.include((u) => u.posts).cursor()) {
        if (first === null) { globalThis.gc(); first = process.memoryUsage().heapUsed - before; }
        if (user.posts.length !== 3) throw new Error('includes attached');
        if (++count === 3) break;
      }
      console.log(JSON.stringify({ count, growthKiB: Math.round(first / 1024) }));
      await client.close();
    `;
    const out = execFileSync(process.execPath,
      ['--no-warnings=ExperimentalWarning', '--expose-gc', '--input-type=module', '-e', script],
      { encoding: 'utf8', cwd: process.cwd() });
    const { count, growthKiB } = JSON.parse(out.trim().split('\n').pop() ?? '{}');
    assert.strictEqual(count, 3);
    assert.ok(growthKiB < 2048,
      `the heap grew ${growthKiB} KiB before the first root — the whole graph was read to yield three`);
  });

  it('one statement, one row per pull, the includes attached, nothing materialised', async () => {
    const { client, counters } = await seeded();
    const seen = [];
    for await (const user of client.entities.User.include((u) => u.posts, { include: { comments: true } })
      .orderBy((u) => u.id).cursor()) {
      seen.push({ id: user.id, posts: user.posts.map((p) => [p.pid, p.comments.length]) });
      if (seen.length === 2) break;
    }
    assert.deepStrictEqual(seen, [
      { id: 1, posts: [[1, 2], [2, 0], [3, 0]] },
      { id: 2, posts: [[4, 2], [5, 0], [6, 0]] },
    ]);
    assert.strictEqual(counters.iterate, 1, 'the one load statement');
    assert.strictEqual(counters.next, 2);
    assert.strictEqual(counters.all, 0);
    assert.strictEqual(counters.return, 1);
    await client.close();
  });

  it('the cursor agrees with toArray(), and toArray() is unchanged: one all()', async () => {
    const { client, counters } = await seeded(4, 2);
    const graph = client.entities.User.include((u) => u.posts, { take: 1 }).orderByDescending((u) => u.id);
    const streamed = [];
    for await (const user of graph.cursor()) streamed.push(user);
    const whole = await graph.toArray();
    assert.deepStrictEqual(streamed, whole);
    assert.strictEqual(counters.all, 1);
    assert.strictEqual(counters.iterate, 1);
    await client.close();
  });
});

describe('breaking a graph cursor releases every statement exactly once', () => {
  it('after a break, after a throw, after an abort — the graph holds one statement', async () => {
    const { client, counters } = await seeded(6);
    const graph = client.entities.User.include((u) => u.posts).orderBy((u) => u.id);
    for await (const user of graph.cursor()) {
      void user;
      break;
    }
    assert.deepStrictEqual([counters.iterate, counters.return], [1, 1]);

    await assert.rejects(async () => {
      for await (const user of graph.cursor()) {
        void user;
        throw new Error('consumer failed');
      }
    }, /consumer failed/);
    assert.deepStrictEqual([counters.iterate, counters.return], [2, 2]);

    const controller = new AbortController();
    const cursor = graph.cursor({ signal: controller.signal });
    assert.strictEqual(cursor.streaming, 'row');
    assert.strictEqual(cursor.barrier, null);
    assert.strictEqual((await cursor.next()).value.id, 1);
    const pulled = counters.next;
    controller.abort();
    await assert.rejects(() => cursor.next(), codeIs('JD2072'));
    await cursor.return();
    assert.strictEqual(counters.next, pulled, 'no pull after the abort');
    assert.deepStrictEqual([counters.iterate, counters.return], [3, 3]);
    await client.close();
  });
});

describe('one root with excessive included children is refused', () => {
  it('maxRows: a coded refusal naming the root, the member and the bound — on the cursor and on toArray()', async () => {
    const { client } = await seeded(3, 5);
    const graph = client.entities.User.include((u) => u.posts, { maxRows: 3 }).orderBy((u) => u.id);
    const refusal = codeIs('JD2073', /'posts' of User 1 holds more than 3 rows — its maxRows bound/);
    await assert.rejects(async () => {
      for await (const user of graph.cursor()) void user;
    }, refusal);
    await assert.rejects(() => graph.toArray(), refusal);
    await assert.rejects(() => client.entities.User.asNoTracking().load({ include: { posts: { maxRows: 3 } } }),
      refusal);
    // the refusal carries the root as data too
    await assert.rejects(() => graph.toArray(), (error) => error.collection === 'User' && error.key === 1);
    await client.close();
  });

  it('maxBytes: the same refusal over serialised bytes; a nested include is bounded per ITS parent', async () => {
    const { client } = await seeded(2, 2);
    await assert.rejects(
      () => client.entities.User.include((u) => u.posts, { maxBytes: 40 }).toArray(),
      codeIs('JD2073', /'posts' of User 1 holds \d+ serialised bytes, more than 40 — its maxBytes bound/));
    await assert.rejects(
      () => client.entities.User.include((u) => u.posts, { include: { comments: { maxRows: 1 } } }).toArray(),
      codeIs('JD2073', /'comments' of Post 1 holds more than 1 rows — its maxRows bound/));
    await client.close();
  });

  it('the refusal names the two alternatives: a count include, or paging the relation', async () => {
    const { client } = await seeded(1, 4);
    await assert.rejects(
      () => client.entities.User.include((u) => u.posts, { maxRows: 2 }).toArray(),
      codeIs('JD2073', /read \{ count: true \} for the size, or page the relation separately/));
    await assert.rejects(
      () => client.entities.User.include((u) => u.posts, { maxRows: 2 }).toArray(),
      codeIs('JD2073', /Declare maxRows: Infinity on the include to load it whole by decision/));
    await client.close();
  });

  it('a bound is enforced at the bound: the subquery carries LIMIT maxRows + 1, and a take IS the row bound', async () => {
    const { client } = await seeded(1, 1);
    const bounded = client.entities.User.include((u) => u.posts, { maxRows: 7 }).explain();
    assert.match(bounded.sql, /LIMIT 8\)/);
    const windowed = client.entities.User.include((u) => u.posts, { take: 2 }).explain();
    assert.match(windowed.sql, /LIMIT 2\)/);
    assert.deepStrictEqual(windowed.bounds, [{ path: 'posts', maxRows: 2, maxBytes: INCLUDE_BYTES_DEFAULT }]);
    await client.close();
  });
});

describe('an include with no declared bound inherits the store default; Infinity must be spelled', () => {
  it('the defaults are the constants, and a spelled Infinity emits null and lifts the bound', async () => {
    const { client } = await seeded(1, 1);
    const plain = client.entities.User.include((u) => u.posts, { include: { comments: true } });
    assert.deepStrictEqual(plain.explain().bounds, [
      { path: 'posts', maxRows: INCLUDE_ROWS_DEFAULT, maxBytes: INCLUDE_BYTES_DEFAULT },
      { path: 'posts.comments', maxRows: INCLUDE_ROWS_DEFAULT, maxBytes: INCLUDE_BYTES_DEFAULT },
    ]);
    assert.match(plain.explain().sql, new RegExp(`LIMIT ${INCLUDE_ROWS_DEFAULT + 1}\\)`));
    const unbounded = client.entities.User.include((u) => u.posts, { maxRows: Infinity, maxBytes: Infinity });
    assert.deepStrictEqual(unbounded.toSpec(), { include: { posts: { maxRows: null, maxBytes: null } } });
    assert.deepStrictEqual(unbounded.explain().bounds, [{ path: 'posts', maxRows: null, maxBytes: null }]);
    assert.doesNotMatch(unbounded.explain().sql, /LIMIT/);
    // a count carries no bound and takes none beside it
    assert.deepStrictEqual(client.entities.User.include((u) => u.posts, { count: true }).explain().bounds, []);
    assert.throws(() => client.entities.User.include((u) => u.posts, /** @type {any} */ ({ count: true, maxRows: 2 })).explain(),
      codeIs('JD0032', /count: true counts every related row and takes no maxRows/));
    for (const bad of [0, -1, 1.5, 'many']) {
      assert.throws(() => client.entities.User.include((u) => u.posts, /** @type {any} */ ({ maxRows: bad })).explain(),
        codeIs('JD0032', /maxRows must be a positive integer, or Infinity/));
    }
    await client.close();
  });

  it('a relation past the default is refused by default and loads whole once Infinity is spelled', async () => {
    const { client } = await seeded(1, INCLUDE_ROWS_DEFAULT + 1);
    await assert.rejects(() => client.entities.User.include((u) => u.posts).toArray(),
      codeIs('JD2073', new RegExp(`more than ${INCLUDE_ROWS_DEFAULT} rows`)));
    const [user] = await client.entities.User.include((u) => u.posts, { maxRows: Infinity }).toArray();
    assert.strictEqual(user.posts.length, INCLUDE_ROWS_DEFAULT + 1);
    const [counted] = await client.entities.User.include((u) => u.posts, { count: true }).toArray();
    assert.strictEqual(counted.posts, INCLUDE_ROWS_DEFAULT + 1);
    await client.close();
  });
});

describe('a graph cursor registers no snapshots unless asked', () => {
  it('untracked by default; tracking: true registers the root and every included child', async () => {
    const { client } = await seeded(2, 2);
    const graph = client.entities.User.include((u) => u.posts);
    for await (const user of graph.cursor()) void user;
    assert.strictEqual(client.store.stats().tracker?.tracked, 0);
    for await (const user of graph.cursor({ tracking: true })) void user;
    assert.strictEqual(client.store.stats().tracker?.tracked, 2 + 4, 'two roots and their four posts');
    await client.close();
  });

  it('a transaction view pins its graph cursor to its exact scope', async () => {
    const { client } = await seeded(2, 1);
    /** @type {any} */
    let begun = null;
    await client.transaction(async (tx) => {
      const graph = tx.entities.User.include((u) => u.posts).orderBy((u) => u.id);
      const walked = [];
      for await (const user of graph.cursor()) walked.push(user.id);
      assert.deepStrictEqual(walked, [1, 2]);
      begun = graph.cursor();
      assert.strictEqual((await begun.next()).value.id, 1);
    });
    await assert.rejects(() => begun.next(), codeIs('JD2070'));
    await client.close();
  });
});

describe('the drift gates', () => {
  const code = (file) => fs.readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  const between = (source, from, to) => {
    const start = source.indexOf(from);
    assert.ok(start >= 0, `${from} exists`);
    const end = source.indexOf(to, start);
    return source.slice(start, end < 0 ? undefined : end);
  };

  it('the graph cursor path calls no .all() and no toArray(); it opens its iterator as a cursor source', () => {
    const query = code('packages/db/src/query.js');
    // one graph source: `openCursor` opens the load statement as a cursor
    // source, and both the cursor and the page reach it
    const source = between(query, 'const openCursor = (entry, signal, register, deadline = undefined) => {', 'const continuationOf =');
    assert.doesNotMatch(source, /\.all\(|toArray/);
    assert.match(source, /open: \(\) =>/);
    const load = between(query, 'loadCursor(spec, options = undefined, register = undefined) {', 'explainLoad(spec) {');
    assert.doesNotMatch(load, /\.all\(|toArray/);
    assert.strictEqual((load.match(/openCursor\(/g) ?? []).length, 2, 'the cursor and the page open the same source');
    const graph = between(code('packages/linq/src/db/include.js'), 'cursor(options) {', 'toSpec()');
    assert.match(graph, /loadCursor\(/);
    assert.doesNotMatch(graph, /toArray|\.load\(/);
  });

  it('every row-projecting include carries both bounds: the tree builder sets them once, for every kind', () => {
    const builder = between(code('packages/db/src/query.js'), 'const include = {', 'node.includes.push(include);');
    assert.match(builder, /maxRows:/);
    assert.match(builder, /maxBytes:/);
    // and the one parser enforces them — for the root row and for a nested child alike
    const parser = code('packages/db/src/graph.js');
    assert.strictEqual((parser.match(/checkBounds\(/g) ?? []).length, 3, 'one definition, two call sites');
  });
});
