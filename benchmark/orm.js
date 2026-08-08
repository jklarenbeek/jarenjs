#!/usr/bin/env node

/**
 * JarenJS ORM Benchmark — phase B against the tools it will actually
 * be compared to: Prisma, Drizzle and Kysely, over SQLite, on Node
 * and on Bun (D16). Every loss is published in the same tables with a
 * one-line reason.
 *
 * Rival routes, because they decide the numbers:
 *
 *  - **Prisma** (@prisma/client, generated from benchmark/orm/
 *    schema.prisma, engine warmed by $connect): the schema-first ORM
 *    default. Statement counts come from its own `$on('query')`
 *    event. Its SQLite connector has no Json field type, so the JSONB
 *    rows run Prisma's only available route: fetch and filter in JS —
 *    stated beside the number, because that IS the comparison.
 *  - **Drizzle** (drizzle-orm over better-sqlite3 on Node,
 *    bun:sqlite on Bun): prepared statements for the hot paths, the
 *    relational query builder for the graph load.
 *  - **Kysely** (SqliteDialect over better-sqlite3): a typed query
 *    BUILDER, not an ORM — it writes whatever SQL you write. Its
 *    graph row is a hand-written json_group_array select, which is
 *    the honest contrast: one statement, but you authored it.
 *
 * Fairness rules paid for elsewhere in this repo: every engine gets
 * WAL journal mode and a fresh file database; every engine must
 * produce the SAME normalized result before it is timed
 * (lib/equals.js); indexes are declared per engine's own vocabulary
 * (age, the two foreign keys; the JSONB rows run indexed via an
 * expression index AND unindexed, both published); async APIs are
 * timed through their async surface.
 *
 * Usage:
 *   node benchmark/orm.js [--quick] [--output json --filepath f]
 *   bun  benchmark/orm.js …   # the Bun table (capability cliff stated)
 */

import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import * as os from 'node:os';

import { openStore } from '@jarenjs/db';
import { JarenValidator } from '@jarenjs/validate';

import { deepEquals } from './lib/equals.js';
import { formatNs } from './lib/fmt.js';

//#region setup

const IS_BUN = typeof globalThis.Bun !== 'undefined';
const args = process.argv.slice(2);
const flags = {
  quick: args.includes('--quick'),
  output: args.includes('--output') ? args[args.indexOf('--output') + 1] : null,
  filepath: args.includes('--filepath') ? args[args.indexOf('--filepath') + 1] : null,
};

const USERS = flags.quick ? 150 : 500;
const POSTS_PER_USER = 5;
const COMMENTS_PER_POST = 2;
const POSTS = USERS * POSTS_PER_USER;
const COMMENTS = POSTS * COMMENTS_PER_POST;
const PAGE = 20;
const DEEP_SKIP = Math.floor(COMMENTS * 0.8);
const CITIES = ['ede', 'breda', 'delft', 'zwolle'];
const NAMES = ['ada', 'lin', 'zed', 'kid', 'mo', 'pax', 'rio', 'sol'];

function makeData() {
  const users = [];
  const posts = [];
  const comments = [];
  let pid = 0;
  let cid = 0;
  for (let i = 0; i < USERS; i++) {
    users.push({
      id: `u${i}`,
      name: NAMES[i % NAMES.length] + (i % 97),
      age: i % 90,
      profile: { city: CITIES[i % CITIES.length], joined: 2000 + (i % 26) },
    });
    for (let p = 0; p < POSTS_PER_USER; p++) {
      pid += 1;
      posts.push({ pid, title: `post ${pid}`, stars: pid % 6, authorId: `u${i}` });
      for (let c = 0; c < COMMENTS_PER_POST; c++) {
        cid += 1;
        comments.push({ cid, text: `comment ${cid}`, postId: pid });
      }
    }
  }
  return { users, posts, comments };
}
const DATA = makeData();

const AGE_ONE = 83;        // ~1.1% of users
const AGE_TEN = 81;        // age >= 81 → ~10%
const GRAPH_AGE = 88;      // ~1% of users carry the whole graph load
const CITY = 'ede';        // 25% of users

const MODEL = {
  $model: '0.1',
  entities: {
    User: {
      schema: {
        type: 'object',
        required: ['id', 'name', 'age'],
        properties: {
          id: { type: 'string', 'x-entity': { key: true } },
          name: { type: 'string' },
          age: { type: 'integer', 'x-entity': { index: true } },
          profile: { type: 'object', properties: {
            city: { type: 'string' }, joined: { type: 'integer' } } },
          posts: { 'x-entity': { relation: { to: 'Post', many: true, via: 'authorId', onDelete: 'cascade' } } },
        },
      },
    },
    Post: {
      schema: {
        type: 'object',
        required: ['pid', 'authorId'],
        properties: {
          pid: { type: 'integer', 'x-entity': { key: true } },
          title: { type: 'string' },
          stars: { type: 'integer' },
          authorId: { type: 'string' },
          comments: { 'x-entity': { relation: { to: 'Comment', many: true, via: 'postId', onDelete: 'cascade' } } },
        },
      },
    },
    Comment: {
      schema: {
        type: 'object',
        required: ['cid', 'postId'],
        properties: {
          cid: { type: 'integer', 'x-entity': { key: true } },
          text: { type: 'string' },
          postId: { type: 'integer' },
        },
      },
    },
  },
};
// the JSONB-indexed variant rides the phase-A collection surface: a
// generated column over $.profile.city with a declared index
const CITY_MODEL = {
  $model: '0.1',
  collections: {
    users: {
      schema: MODEL.entities.User.schema,
      key: '/id',
      indexes: [{ name: 'by_city', path: '$.profile.city' }],
    },
  },
};

const tmp = mkdtempSync(path.join(os.tmpdir(), 'orm-bench-'));
const fileOf = (name) => path.join(tmp, name);

async function timeAsync(fn, iterations) {
  await fn();
  await fn();
  const start = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) await fn();
  return Number(process.hrtime.bigint() - start) / iterations;
}
async function timeOnceAsync(fn) {
  const start = process.hrtime.bigint();
  await fn();
  return Number(process.hrtime.bigint() - start);
}
const idSet = (ids) => [...ids].sort();

/** Wrap a better-sqlite3/bun:sqlite-shaped db so every statement
 * execution is counted (the rivals' statement-count instrument). */
function countingDb(db, counters) {
  return new Proxy(db, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === 'prepare') {
        return (sql) => {
          const statement = target.prepare(sql);
          return new Proxy(statement, {
            get(st, sp, stProxy) {
              const member = Reflect.get(st, sp);
              if (sp === 'run' || sp === 'get' || sp === 'all' || sp === 'iterate'
                || sp === 'values') {
                return (...params) => {
                  counters.executed++;
                  return member.apply(st, params);
                };
              }
              if (typeof member !== 'function') return member;
              return (...params) => {
                const result = member.apply(st, params);
                // chainable configuration (raw(), pluck(), …) returns
                // the statement — keep the counting proxy on it
                return result === st ? stProxy : result;
              };
            },
          });
        };
      }
      if (prop === 'exec') {
        return (sql) => {
          counters.executed++;
          return target.exec(sql);
        };
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

//#endregion

//#region engines

async function jarenEngine() {
  const driver = IS_BUN
    ? (await import('@jarenjs/db/bun')).bunDriver()
    : (await import('@jarenjs/db/node')).nodeDriver();
  const store = await openStore(MODEL, { driver, path: fileOf('jaren.db') });
  const validator = new JarenValidator();
  const validated = await openStore(MODEL, {
    driver: IS_BUN
      ? (await import('@jarenjs/db/bun')).bunDriver()
      : (await import('@jarenjs/db/node')).nodeDriver(),
    path: fileOf('jaren-validated.db'),
    compileSchema: (schema) => validator.compile(schema),
  });
  const cityStore = await openStore(CITY_MODEL, {
    driver: IS_BUN
      ? (await import('@jarenjs/db/bun')).bunDriver()
      : (await import('@jarenjs/db/node')).nodeDriver(),
    path: fileOf('jaren-city.db'),
  });

  const seedInto = (target) => {
    for (const user of DATA.users) target.entity('User').add(user);
    for (const post of DATA.posts) target.entity('Post').add(post);
    for (const comment of DATA.comments) target.entity('Comment').add(comment);
    return target.sync.saveChanges();
  };

  const GRAPH_SPEC = {
    where: { $ge: ['$it.age', GRAPH_AGE] },
    orderBy: '$it.id',
    include: { posts: { orderBy: '$it.pid', include: { comments: { orderBy: '$it.cid' } } } },
  };
  const CITY_QUERY = {
    $for: { u: '$.User[*]' },
    $where: { $eq: ['$u.profile.city', CITY] },
    $return: '$u.id',
  };
  const CITY_QUERY_COLLECTION = {
    $for: { it: '$[*]' },
    $where: { $eq: ['$it.profile.city', CITY] },
    $return: '$it.id',
  };

  return {
    label: 'jaren (@jarenjs/db)',
    adapter: `${IS_BUN ? 'bun:sqlite' : 'node:sqlite'} file db (WAL), entities with `
      + 'FK+age indexes; validation OFF except the validated row',
    insertSingle: async () => {
      const fresh = await openStore(MODEL, {
        driver: IS_BUN
          ? (await import('@jarenjs/db/bun')).bunDriver()
          : (await import('@jarenjs/db/node')).nodeDriver(),
        path: fileOf(`jaren-ins-${Math.random().toString(36).slice(2)}.db`),
      });
      const t = await timeOnceAsync(() => fresh.transaction(async () => {
        for (const user of DATA.users) await fresh.entity('User').create(user);
      }));
      await fresh.close();
      return t / USERS;
    },
    insertBatched: async () => {
      const fresh = await openStore(MODEL, {
        driver: IS_BUN
          ? (await import('@jarenjs/db/bun')).bunDriver()
          : (await import('@jarenjs/db/node')).nodeDriver(),
        path: fileOf(`jaren-batch-${Math.random().toString(36).slice(2)}.db`),
      });
      const t = await timeOnceAsync(async () => {
        for (const user of DATA.users) fresh.entity('User').add(user);
        await fresh.saveChanges();
      });
      await fresh.close();
      return t / USERS;
    },
    insertValidated: async () => {
      // the same workload as the batched row, validation ON
      const t = await timeOnceAsync(async () => {
        for (const user of DATA.users) validated.entity('User').add(user);
        await validated.saveChanges();
      });
      return t / USERS;
    },
    seed: async () => {
      await Promise.resolve(seedInto(store));
      const syncUsers = cityStore.sync.collection('users');
      cityStore.sync.transaction(() => {
        for (const user of DATA.users) syncUsers.insert(user);
      });
    },
    point: (key) => store.entity('User').asNoTracking().get(key),
    pointSync: store.sync === undefined
      ? null
      : (key) => store.sync.entity('User').asNoTracking().get(key),
    predicate: async (query) => {
      // whole documents: a projection is residual (§10.6), the bare
      // binding is the native path — ids extract only for the gate
      const result = await Promise.resolve(store.execute(query));
      const items = Array.isArray(result) ? result : result === undefined ? [] : [result];
      return idSet(items.map((doc) => doc.id));
    },
    graph: async () => normalizeGraph(
      await store.entity('User').asNoTracking().load(GRAPH_SPEC)),
    groupCounts: async () => normalizeCounts(
      (await store.entity('User').asNoTracking().load(
        { orderBy: '$it.id', include: { posts: { count: true } } }))
        .map((user) => [user.id, user.posts])),
    groupResidual: async () => normalizeCounts(
      await Promise.resolve(store.execute({
        $for: { u: '$.User[*]', p: '$.Post[*]' },
        $where: { $eq: ['$p.authorId', '$u.id'] },
        $groupby: { who: '$u.id' },
        $return: ['$who', { $count: '$p' }],
      }))),
    pageOffset: async (skip) => (await store.entity('Comment').asNoTracking()
      .load({ orderBy: '$it.cid', take: PAGE, skip })).map((c) => c.cid),
    pageKeyset: async (after) => (await store.entity('Comment').asNoTracking()
      .load({ orderBy: '$it.cid', take: PAGE, after })).map((c) => c.cid),
    updateUow: async (key, name) => {
      const users = store.entity('User');
      users.discard(key);
      const doc = await users.get(key);
      users.put({ ...doc, name });
      await store.saveChanges();
    },
    updateExplicit: (key, name) => store.entity('User').update(key, { name }),
    jsonbUnindexed: async () => {
      const result = await Promise.resolve(store.execute(CITY_QUERY));
      return idSet(result);
    },
    jsonbIndexed: async () => {
      const result = await Promise.resolve(
        cityStore.collection('users').execute(CITY_QUERY_COLLECTION));
      return idSet(result);
    },
    close: async () => {
      await store.close();
      await validated.close();
      await cityStore.close();
    },
  };

}

function normalizeGraph(loaded) {
  return loaded.map((user) => ({
    id: user.id,
    posts: (user.posts ?? []).map((post) => ({
      pid: post.pid,
      comments: (post.comments ?? []).map((comment) => comment.cid),
    })),
  }));
}
function normalizeCounts(pairs) {
  return [...pairs].map(([who, n]) => [who, Number(n)])
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

async function drizzleEngine() {
  const counters = { executed: 0 };
  let db;
  let raw;
  if (IS_BUN) {
    const { Database } = await import('bun:sqlite');
    const { drizzle } = await import('drizzle-orm/bun-sqlite');
    raw = new Database(fileOf('drizzle.db'));
    raw.exec('PRAGMA journal_mode = WAL');
    db = { drizzle, raw: countingDb(raw, counters) };
  }
  else {
    const { default: Database } = await import('better-sqlite3');
    const { drizzle } = await import('drizzle-orm/better-sqlite3');
    raw = new Database(fileOf('drizzle.db'));
    raw.pragma('journal_mode = WAL');
    db = { drizzle, raw: countingDb(raw, counters) };
  }
  const { sqliteTable, text, integer } = await import('drizzle-orm/sqlite-core');
  const { relations, eq, gte, sql, count, asc, desc, gt } = await import('drizzle-orm');

  const users = sqliteTable('users', {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    age: integer('age').notNull(),
    profile: text('profile', { mode: 'json' }),
  });
  const posts = sqliteTable('posts', {
    pid: integer('pid').primaryKey(),
    title: text('title'),
    stars: integer('stars'),
    authorId: text('author_id').notNull().references(() => users.id),
  });
  const comments = sqliteTable('comments', {
    cid: integer('cid').primaryKey(),
    text: text('text'),
    postId: integer('post_id').notNull().references(() => posts.pid),
  });
  const usersRelations = relations(users, ({ many }) => ({ posts: many(posts) }));
  const postsRelations = relations(posts, ({ one, many }) => ({
    author: one(users, { fields: [posts.authorId], references: [users.id] }),
    comments: many(comments),
  }));
  const commentsRelations = relations(comments, ({ one }) => ({
    post: one(posts, { fields: [comments.postId], references: [posts.pid] }),
  }));
  const orm = db.drizzle(db.raw, {
    schema: { users, posts, comments, usersRelations, postsRelations, commentsRelations },
  });
  const ddl = [
    'CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL, age INTEGER NOT NULL, profile TEXT)',
    'CREATE TABLE posts (pid INTEGER PRIMARY KEY, title TEXT, stars INTEGER, author_id TEXT NOT NULL REFERENCES users(id))',
    'CREATE TABLE comments (cid INTEGER PRIMARY KEY, text TEXT, post_id INTEGER NOT NULL REFERENCES posts(pid))',
    'CREATE INDEX users_age ON users (age)',
    'CREATE INDEX posts_author ON posts (author_id)',
    'CREATE INDEX comments_post ON comments (post_id)',
  ];
  for (const statement of ddl) raw.exec(statement);

  const pointPrepared = orm.select().from(users)
    .where(eq(users.id, sql.placeholder('key'))).prepare();
  const updatePrepared = orm.update(users)
    .set({ name: sql.placeholder('name') })
    .where(eq(users.id, sql.placeholder('key'))).prepare();

  return {
    label: 'Drizzle',
    adapter: `drizzle-orm over ${IS_BUN ? 'bun:sqlite' : 'better-sqlite3'} (WAL), `
      + 'prepared statements, relational query builder for the graph',
    counters,
    insertSingle: async () => {
      const t = await timeOnceAsync(() => orm.transaction((tx) => {
        for (const user of DATA.users) {
          tx.insert(users).values({ ...user, profile: user.profile }).run();
        }
      }));
      raw.exec('DELETE FROM users');
      return t / USERS;
    },
    insertBatched: async () => {
      const t = await timeOnceAsync(() => orm.transaction((tx) => {
        for (let at = 0; at < DATA.users.length; at += 100)
          tx.insert(users).values(DATA.users.slice(at, at + 100)).run();
      }));
      raw.exec('DELETE FROM users');
      return t / USERS;
    },
    seed: () => orm.transaction((tx) => {
      for (let at = 0; at < DATA.users.length; at += 100)
        tx.insert(users).values(DATA.users.slice(at, at + 100)).run();
      for (let at = 0; at < DATA.posts.length; at += 100)
        tx.insert(posts).values(DATA.posts.slice(at, at + 100)).run();
      for (let at = 0; at < DATA.comments.length; at += 100)
        tx.insert(comments).values(DATA.comments.slice(at, at + 100)).run();
    }),
    point: (key) => pointPrepared.get({ key }),
    predicateOne: () => idSet(orm.select().from(users)
      .where(eq(users.age, AGE_ONE)).all().map((row) => row.id)),
    predicateTen: () => idSet(orm.select().from(users)
      .where(gte(users.age, AGE_TEN)).all().map((row) => row.id)),
    predicateAll: () => idSet(orm.select().from(users)
      .where(gte(users.age, 0)).all().map((row) => row.id)),
    graph: async () => normalizeGraph(await orm.query.users.findMany({
      where: gte(users.age, GRAPH_AGE),
      orderBy: asc(users.id),
      with: { posts: { orderBy: asc(posts.pid),
        with: { comments: { orderBy: asc(comments.cid) } } } },
    })),
    groupCounts: () => normalizeCounts(orm
      .select({ who: users.id, n: count(posts.pid) })
      .from(users)
      .leftJoin(posts, eq(posts.authorId, users.id))
      .groupBy(users.id).all()
      .map((row) => [row.who, row.n])),
    pageOffset: (skip) => orm.select({ cid: comments.cid }).from(comments)
      .orderBy(asc(comments.cid)).limit(PAGE).offset(skip).all()
      .map((row) => row.cid),
    pageKeyset: (after) => orm.select({ cid: comments.cid }).from(comments)
      .where(gt(comments.cid, after)).orderBy(asc(comments.cid)).limit(PAGE).all()
      .map((row) => row.cid),
    update: (key, name) => updatePrepared.run({ key, name }),
    jsonbUnindexed: () => idSet(orm.select({ id: users.id }).from(users)
      .where(sql`json_extract(${users.profile}, '$.city') = ${CITY}`).all()
      .map((row) => row.id)),
    prepareJsonbIndex: () => raw.exec(
      "CREATE INDEX users_city ON users (json_extract(profile, '$.city'))"),
    dropJsonbIndex: () => raw.exec('DROP INDEX users_city'),
    close: () => raw.close(),
    _desc: desc,
  };
}

async function kyselyEngine() {
  const counters = { executed: 0 };
  const { default: Database } = await import('better-sqlite3');
  const { Kysely, SqliteDialect, sql } = await import('kysely');
  const raw = new Database(fileOf('kysely.db'));
  raw.pragma('journal_mode = WAL');
  const db = new Kysely({
    dialect: new SqliteDialect({ database: countingDb(raw, counters) }),
  });
  const ddl = [
    'CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL, age INTEGER NOT NULL, profile TEXT)',
    'CREATE TABLE posts (pid INTEGER PRIMARY KEY, title TEXT, stars INTEGER, author_id TEXT NOT NULL REFERENCES users(id))',
    'CREATE TABLE comments (cid INTEGER PRIMARY KEY, text TEXT, post_id INTEGER NOT NULL REFERENCES posts(pid))',
    'CREATE INDEX users_age ON users (age)',
    'CREATE INDEX posts_author ON posts (author_id)',
    'CREATE INDEX comments_post ON comments (post_id)',
  ];
  for (const statement of ddl) raw.exec(statement);

  return {
    label: 'Kysely',
    adapter: 'kysely SqliteDialect over better-sqlite3 (WAL); a typed SQL '
      + 'builder — the graph row is hand-written json_group_array',
    counters,
    insertSingle: async () => {
      const t = await timeOnceAsync(() => db.transaction().execute(async (tx) => {
        for (const user of DATA.users) {
          await tx.insertInto('users')
            .values({ ...user, profile: JSON.stringify(user.profile) }).execute();
        }
      }));
      raw.exec('DELETE FROM users');
      return t / USERS;
    },
    insertBatched: async () => {
      const t = await timeOnceAsync(() => db.transaction().execute(async (tx) => {
        for (let at = 0; at < DATA.users.length; at += 100) {
          await tx.insertInto('users').values(DATA.users.slice(at, at + 100)
            .map((user) => ({ ...user, profile: JSON.stringify(user.profile) })))
            .execute();
        }
      }));
      raw.exec('DELETE FROM users');
      return t / USERS;
    },
    seed: () => db.transaction().execute(async (tx) => {
      for (let at = 0; at < DATA.users.length; at += 100) {
        await tx.insertInto('users').values(DATA.users.slice(at, at + 100)
          .map((user) => ({ ...user, profile: JSON.stringify(user.profile) }))).execute();
      }
      for (let at = 0; at < DATA.posts.length; at += 100) {
        await tx.insertInto('posts').values(DATA.posts.slice(at, at + 100)
          .map((post) => ({ pid: post.pid, title: post.title, stars: post.stars,
            author_id: post.authorId }))).execute();
      }
      for (let at = 0; at < DATA.comments.length; at += 100) {
        await tx.insertInto('comments').values(DATA.comments.slice(at, at + 100)
          .map((comment) => ({ cid: comment.cid, text: comment.text,
            post_id: comment.postId }))).execute();
      }
    }),
    point: (key) => db.selectFrom('users').selectAll()
      .where('id', '=', key).executeTakeFirst(),
    predicateOne: async () => idSet((await db.selectFrom('users').selectAll()
      .where('age', '=', AGE_ONE).execute()).map((row) => row.id)),
    predicateTen: async () => idSet((await db.selectFrom('users').selectAll()
      .where('age', '>=', AGE_TEN).execute()).map((row) => row.id)),
    predicateAll: async () => idSet((await db.selectFrom('users').selectAll()
      .where('age', '>=', 0).execute()).map((row) => row.id)),
    graph: async () => {
      // the hand-written one-statement graph: what a query builder
      // makes possible and does not write for you
      const { rows } = await sql`
        SELECT u.id, (
          SELECT json_group_array(json_object('pid', p.pid, 'comments', (
            SELECT json_group_array(c.cid) FROM comments c
            WHERE c.post_id = p.pid ORDER BY c.cid)))
          FROM posts p WHERE p.author_id = u.id ORDER BY p.pid
        ) AS posts
        FROM users u WHERE u.age >= ${GRAPH_AGE} ORDER BY u.id`.execute(db);
      return rows.map((row) => ({
        id: row.id,
        // the inner aggregate embeds as REAL JSON inside the outer one
        // (the JSON subtype), so only the outer text parses
        posts: JSON.parse(row.posts ?? '[]').map((post) => ({
          pid: post.pid,
          comments: Array.isArray(post.comments)
            ? post.comments : JSON.parse(post.comments ?? '[]'),
        })),
      }));
    },
    groupCounts: async () => normalizeCounts((await db.selectFrom('users')
      .leftJoin('posts', 'posts.author_id', 'users.id')
      .select(['users.id', db.fn.count('posts.pid').as('n')])
      .groupBy('users.id').execute())
      .map((row) => [row.id, Number(row.n)])),
    pageOffset: async (skip) => (await db.selectFrom('comments').select('cid')
      .orderBy('cid', 'asc').limit(PAGE).offset(skip).execute())
      .map((row) => row.cid),
    pageKeyset: async (after) => (await db.selectFrom('comments').select('cid')
      .where('cid', '>', after).orderBy('cid', 'asc').limit(PAGE).execute())
      .map((row) => row.cid),
    update: (key, name) => db.updateTable('users').set({ name })
      .where('id', '=', key).execute(),
    jsonbUnindexed: async () => idSet((await db.selectFrom('users').select('id')
      .where(sql`json_extract(profile, '$.city')`, '=', CITY).execute())
      .map((row) => row.id)),
    prepareJsonbIndex: () => raw.exec(
      "CREATE INDEX users_city ON users (json_extract(profile, '$.city'))"),
    dropJsonbIndex: () => raw.exec('DROP INDEX users_city'),
    close: () => db.destroy(),
  };
}

async function prismaEngine() {
  const { PrismaClient } = await import('@prisma/client');
  const dbFile = fileOf('prisma.db');
  // prisma's own route to a fresh schema: db push against the file
  const pushed = spawnSync('npx', ['prisma', 'db', 'push',
    '--schema', 'benchmark/orm/schema.prisma', '--skip-generate'], {
    env: { ...process.env, ORM_BENCH_DB: `file:${dbFile}` },
    encoding: 'utf8',
  });
  if (pushed.status !== 0) throw new Error(`prisma db push failed: ${pushed.stderr}`);
  const counters = { executed: 0 };
  const prisma = new PrismaClient({
    datasources: { db: { url: `file:${dbFile}` } },
    log: [{ emit: 'event', level: 'query' }],
  });
  prisma.$on('query', () => counters.executed++);
  await prisma.$connect();
  await prisma.$queryRawUnsafe('PRAGMA journal_mode = WAL');

  return {
    label: 'Prisma',
    adapter: '@prisma/client (generated, engine warmed by $connect) over its '
      + 'SQLite connector (WAL); profile is TEXT — no Json type on SQLite',
    counters,
    insertSingle: async () => {
      const t = await timeOnceAsync(() => prisma.$transaction(async (tx) => {
        for (const user of DATA.users) {
          await tx.user.create({ data: { ...user, profile: JSON.stringify(user.profile) } });
        }
      }, { timeout: 120000 }));
      await prisma.user.deleteMany();
      return t / USERS;
    },
    insertBatched: async () => {
      const t = await timeOnceAsync(() => prisma.user.createMany({
        data: DATA.users.map((user) => ({ ...user, profile: JSON.stringify(user.profile) })),
      }));
      await prisma.user.deleteMany();
      return t / USERS;
    },
    seed: async () => {
      await prisma.user.createMany({
        data: DATA.users.map((user) => ({ ...user, profile: JSON.stringify(user.profile) })) });
      await prisma.post.createMany({ data: DATA.posts });
      await prisma.comment.createMany({ data: DATA.comments });
    },
    point: (key) => prisma.user.findUnique({ where: { id: key } }),
    predicateOne: async () => idSet((await prisma.user.findMany({
      where: { age: AGE_ONE } })).map((row) => row.id)),
    predicateTen: async () => idSet((await prisma.user.findMany({
      where: { age: { gte: AGE_TEN } } })).map((row) => row.id)),
    predicateAll: async () => idSet((await prisma.user.findMany())
      .map((row) => row.id)),
    graph: async () => normalizeGraph((await prisma.user.findMany({
      where: { age: { gte: GRAPH_AGE } },
      orderBy: { id: 'asc' },
      include: { posts: { orderBy: { pid: 'asc' },
        include: { comments: { orderBy: { cid: 'asc' } } } } },
    })).map((user) => ({
      id: user.id,
      posts: user.posts.map((post) => ({ pid: post.pid, comments: post.comments })),
    }))),
    groupCounts: async () => {
      const grouped = await prisma.post.groupBy({
        by: ['authorId'], _count: { pid: true } });
      const map = new Map(grouped.map((row) => [row.authorId, row._count.pid]));
      const all = await prisma.user.findMany({ select: { id: true } });
      return normalizeCounts(all.map((row) => [row.id, map.get(row.id) ?? 0]));
    },
    pageOffset: async (skip) => (await prisma.comment.findMany({
      orderBy: { cid: 'asc' }, take: PAGE, skip, select: { cid: true } }))
      .map((row) => row.cid),
    pageKeyset: async (after) => (await prisma.comment.findMany({
      orderBy: { cid: 'asc' }, take: PAGE, skip: 1,
      cursor: { cid: after }, select: { cid: true } }))
      .map((row) => row.cid),
    update: (key, name) => prisma.user.update({ where: { id: key }, data: { name } }),
    jsonbUnindexed: async () => {
      // Prisma's only route on SQLite: fetch and filter in JS
      const all = await prisma.user.findMany({ select: { id: true, profile: true } });
      return idSet(all.filter((row) => JSON.parse(row.profile).city === CITY)
        .map((row) => row.id));
    },
    close: () => prisma.$disconnect(),
  };
}

//#endregion

//#region cold start

const COLD_SCRIPTS = {
  'jaren (@jarenjs/db)': (dbFile) => `
    const t0 = process.hrtime.bigint();
    const { openStore } = await import('@jarenjs/db');
    const { nodeDriver } = await import('@jarenjs/db/node');
    const store = await openStore(${JSON.stringify(MODEL)},
      { driver: nodeDriver(), path: ${JSON.stringify(dbFile)} });
    await store.entity('User').asNoTracking().get('u1');
    console.log(Number(process.hrtime.bigint() - t0));
    await store.close();`,
  Drizzle: (dbFile) => `
    const t0 = process.hrtime.bigint();
    const { default: Database } = await import('better-sqlite3');
    const { drizzle } = await import('drizzle-orm/better-sqlite3');
    const { sqliteTable, text, integer } = await import('drizzle-orm/sqlite-core');
    const { eq } = await import('drizzle-orm');
    const users = sqliteTable('users', { id: text('id').primaryKey(),
      name: text('name'), age: integer('age'), profile: text('profile') });
    const db = drizzle(new Database(${JSON.stringify(dbFile)}));
    db.select().from(users).where(eq(users.id, 'u1')).get();
    console.log(Number(process.hrtime.bigint() - t0));`,
  Kysely: (dbFile) => `
    const t0 = process.hrtime.bigint();
    const { default: Database } = await import('better-sqlite3');
    const { Kysely, SqliteDialect } = await import('kysely');
    const db = new Kysely({ dialect: new SqliteDialect({
      database: new Database(${JSON.stringify(dbFile)}) }) });
    await db.selectFrom('users').selectAll().where('id', '=', 'u1').executeTakeFirst();
    console.log(Number(process.hrtime.bigint() - t0));
    await db.destroy();`,
  Prisma: (dbFile) => `
    const t0 = process.hrtime.bigint();
    const { PrismaClient } = await import('@prisma/client');
    const prisma = new PrismaClient({
      datasources: { db: { url: 'file:' + ${JSON.stringify(dbFile)} } } });
    await prisma.user.findUnique({ where: { id: 'u1' } });
    console.log(Number(process.hrtime.bigint() - t0));
    await prisma.$disconnect();`,
};

function coldStart(label, dbFile) {
  const script = COLD_SCRIPTS[label]?.(dbFile);
  if (script === undefined) return null;
  const samples = [];
  for (let i = 0; i < 3; i++) {
    const out = spawnSync(process.execPath,
      ['--no-warnings=ExperimentalWarning', '--input-type=module', '-e', script],
      { encoding: 'utf8' });
    if (out.status !== 0) return null;
    samples.push(Number(out.stdout.trim().split('\n').pop()));
  }
  samples.sort((a, b) => a - b);
  return samples[1]; // the median of three
}

//#endregion

//#region run

const tables = [];
const notes = [];
let equivalenceFailures = 0;

function verify(name, expected, actual, engineLabel) {
  if (!deepEquals(actual, expected)) {
    equivalenceFailures++;
    console.error(`  EQUIVALENCE FAILURE [${name}] ${engineLabel}`);
    console.error(`    expected: ${JSON.stringify(expected).slice(0, 200)}`);
    console.error(`    actual:   ${JSON.stringify(actual).slice(0, 200)}`);
    return false;
  }
  return true;
}

async function main() {
  console.log(`ORM benchmark — ${USERS} users / ${POSTS} posts / ${COMMENTS} comments`
    + ` on ${IS_BUN ? `Bun ${globalThis.Bun.version}` : `Node ${process.version}`}`);
  console.log('journal_mode=WAL for every engine; fresh file databases; '
    + 'validation OFF unless the row says otherwise\n');

  const engines = [await jarenEngine()];
  try {
    engines.push(await drizzleEngine());
  }
  catch (error) {
    notes.push(`Drizzle omitted: ${error.message}`);
  }
  if (!IS_BUN) {
    try {
      engines.push(await kyselyEngine());
    }
    catch (error) {
      notes.push(`Kysely omitted: ${error.message}`);
    }
    try {
      engines.push(await prismaEngine());
    }
    catch (error) {
      notes.push(`Prisma omitted: ${error.message.slice(0, 200)}`);
    }
  }
  else {
    notes.push('Bun capability cliff: Kysely\'s better-sqlite3 dialect and '
      + 'Prisma\'s engine have no first-party bun:sqlite route, so their rows '
      + 'are Node-only; on Bun there is also no UDF hatch and no session '
      + 'capture (bun:sqlite has no function/aggregate/createSession).');
  }

  // ————— 1. insert —————
  {
    const rows = [];
    for (const engine of engines) {
      if (engine.insertSingle !== undefined) {
        rows.push({ name: `${engine.label} — single creates (one txn)`,
          results: [await engine.insertSingle()] });
      }
      if (engine.insertBatched !== undefined) {
        rows.push({ name: `${engine.label} — batched`,
          results: [await engine.insertBatched()] });
      }
    }
    const jaren = engines[0];
    rows.push({ name: 'jaren — batched, schema-VALIDATED writes',
      results: [await jaren.insertValidated()],
      note: 'no rival row exists: none of them validates documents at all' });
    tables.push({ title: `Insert (ns/row over ${USERS} users; batched = multi-row VALUES)`,
      columns: ['ns/row'], rows });
  }

  // seed every engine for the read phases
  for (const engine of engines) await engine.seed();

  // ————— 2. point read —————
  {
    const rows = [];
    const keys = Array.from({ length: 200 }, (_, i) => `u${(i * 7) % USERS}`);
    for (const engine of engines) {
      let i = 0;
      const ns = await timeAsync(() => engine.point(keys[i++ % keys.length]), 2000);
      rows.push({ name: engine.label, results: [ns] });
      if (engine.pointSync) {
        let j = 0;
        const sync = await timeAsync(() => engine.pointSync(keys[j++ % keys.length]), 2000);
        rows.push({ name: 'jaren (store.sync)', results: [sync] });
      }
    }
    tables.push({ title: 'Point read by primary key (ns/op)', columns: ['ns/op'], rows });
  }

  // ————— 3. indexed predicate 1% / 10% / 100% —————
  {
    const jaren = engines[0];
    const expectOne = await jaren.predicate({
      $for: { u: '$.User[*]' }, $where: { $eq: ['$u.age', AGE_ONE] }, $return: '$u' });
    const expectTen = await jaren.predicate({
      $for: { u: '$.User[*]' }, $where: { $ge: ['$u.age', AGE_TEN] }, $return: '$u' });
    const expectAll = await jaren.predicate({
      $for: { u: '$.User[*]' }, $where: { $ge: ['$u.age', 0] }, $return: '$u' });
    const rows = [];
    const jarenRun = (query) => () => jaren.predicate(query);
    rows.push({ name: `jaren — 1% (age = ${AGE_ONE})`, results: [await timeAsync(
      jarenRun({ $for: { u: '$.User[*]' }, $where: { $eq: ['$u.age', AGE_ONE] }, $return: '$u' }), 300)] });
    rows.push({ name: `jaren — 10% (age >= ${AGE_TEN})`, results: [await timeAsync(
      jarenRun({ $for: { u: '$.User[*]' }, $where: { $ge: ['$u.age', AGE_TEN] }, $return: '$u' }), 300)] });
    rows.push({ name: 'jaren — 100%', results: [await timeAsync(
      jarenRun({ $for: { u: '$.User[*]' }, $where: { $ge: ['$u.age', 0] }, $return: '$u' }), 100)] });
    for (const engine of engines.slice(1)) {
      if (verify('predicate 1%', expectOne, await engine.predicateOne(), engine.label)) {
        rows.push({ name: `${engine.label} — 1%`,
          results: [await timeAsync(() => engine.predicateOne(), 300)] });
      }
      if (verify('predicate 10%', expectTen, await engine.predicateTen(), engine.label)) {
        rows.push({ name: `${engine.label} — 10%`,
          results: [await timeAsync(() => engine.predicateTen(), 300)] });
      }
      if (verify('predicate 100%', expectAll, await engine.predicateAll(), engine.label)) {
        rows.push({ name: `${engine.label} — 100%`,
          results: [await timeAsync(() => engine.predicateAll(), 100)] });
      }
    }
    tables.push({ title: `Indexed predicate over ${USERS} users, ids only (ns/query)`,
      columns: ['ns/query'], rows });
  }

  // ————— 4. the graph load (the headline) —————
  {
    const jaren = engines[0];
    const expected = await jaren.graph();
    if (expected.length === 0) throw new Error('graph selection is empty — dataset bug');
    const rows = [];
    for (const engine of engines) {
      const actual = await engine.graph();
      if (!verify('graph', expected, actual, engine.label)) continue;
      if (engine.counters) engine.counters.executed = 0;
      await engine.graph();
      const statements = engine.counters ? engine.counters.executed : null;
      const ns = await timeAsync(() => engine.graph(), 100);
      rows.push({
        name: `${engine.label}${statements !== null ? ` — ${statements} statement(s)` : ' — 1 statement (asserted by test)'}`,
        results: [ns],
      });
    }
    tables.push({
      title: `Graph load: users (age >= ${GRAPH_AGE}) with posts and comments, two levels `
        + '(ns/load; STATEMENT COUNTS beside the label are the structural claim)',
      columns: ['ns/load'], rows,
    });
  }

  // ————— 5. aggregate + group by over a join —————
  {
    const jaren = engines[0];
    const expected = await jaren.groupCounts();
    const rows = [];
    rows.push({ name: 'jaren — load include count (1 statement)',
      results: [await timeAsync(() => jaren.groupCounts(), 100)] });
    const residual = await jaren.groupResidual();
    if (verify('groupby', expected, residual, 'jaren residual')) {
      rows.push({ name: 'jaren — $groupby document (set residual; pushdown is §10.6 future work)',
        results: [await timeAsync(() => jaren.groupResidual(), 50)] });
    }
    for (const engine of engines.slice(1)) {
      if (engine.groupCounts === undefined) continue;
      const actual = await engine.groupCounts();
      if (!verify('groupby', expected, actual, engine.label)) continue;
      rows.push({ name: `${engine.label} — GROUP BY`,
        results: [await timeAsync(() => engine.groupCounts(), 100)] });
    }
    tables.push({ title: 'Posts per user: aggregate + group over a join (ns/query)',
      columns: ['ns/query'], rows });
  }

  // ————— 6. pagination —————
  {
    const jaren = engines[0];
    const expectP1 = await jaren.pageOffset(0);
    const expectDeep = await jaren.pageOffset(DEEP_SKIP);
    const expectKeyset = await jaren.pageKeyset(DEEP_SKIP);
    if (!deepEquals(expectDeep, expectKeyset))
      throw new Error('keyset and offset disagree — dataset bug');
    const rows = [];
    for (const engine of engines) {
      const p1 = await engine.pageOffset(0);
      const deep = await engine.pageOffset(DEEP_SKIP);
      const keyset = await engine.pageKeyset(DEEP_SKIP);
      if (!verify('page 1', expectP1, p1, engine.label)
        || !verify('deep page', expectDeep, deep, engine.label)
        || !verify('keyset page', expectKeyset, keyset, engine.label)) continue;
      rows.push({ name: `${engine.label} — offset, page 1`,
        results: [await timeAsync(() => engine.pageOffset(0), 300)] });
      rows.push({ name: `${engine.label} — offset, skip ${DEEP_SKIP}`,
        results: [await timeAsync(() => engine.pageOffset(DEEP_SKIP), 300)] });
      rows.push({ name: `${engine.label} — keyset at the same depth`,
        results: [await timeAsync(() => engine.pageKeyset(DEEP_SKIP), 300)] });
    }
    tables.push({ title: `Pagination over ${COMMENTS} comments, page size ${PAGE} (ns/page)`,
      columns: ['ns/page'], rows });
  }

  // ————— 7. update —————
  {
    const jaren = engines[0];
    const rows = [];
    let n = 0;
    rows.push({ name: 'jaren — unit of work (get, put, saveChanges)',
      results: [await timeAsync(() => jaren.updateUow('u1', `n${n++}`), 300)],
      note: 'minimal diffed statement; a mixed read/write workload measured a 10% whole-row fallback rate' });
    rows.push({ name: 'jaren — explicit update()',
      results: [await timeAsync(() => jaren.updateExplicit('u1', `n${n++}`), 300)] });
    for (const engine of engines.slice(1)) {
      if (engine.update === undefined) continue;
      rows.push({ name: `${engine.label} — update by key`,
        results: [await timeAsync(() => engine.update('u1', `n${n++}`), 300)] });
    }
    await jaren.updateExplicit('u1', DATA.users[1].name === undefined ? 'ada0' : DATA.users[1].name);
    tables.push({ title: 'Update one column by primary key (ns/op)', columns: ['ns/op'], rows });
  }

  // ————— 8. cold start —————
  if (!IS_BUN) {
    const rows = [];
    const dbFiles = {
      'jaren (@jarenjs/db)': fileOf('jaren.db'),
      Drizzle: fileOf('drizzle.db'),
      Kysely: fileOf('kysely.db'),
      Prisma: fileOf('prisma.db'),
    };
    for (const engine of engines) {
      const ns = coldStart(engine.label, dbFiles[engine.label]);
      if (ns !== null) rows.push({ name: engine.label, results: [ns] });
    }
    tables.push({
      title: 'Cold start: fresh process, import + open + first point read (ns, median of 3)',
      columns: ['ns'], rows,
    });
  }
  else {
    notes.push('cold start is measured on the Node run (spawned node processes).');
  }

  // ————— 9. the JSONB hybrid —————
  {
    const jaren = engines[0];
    const expected = await jaren.jsonbUnindexed();
    const rows = [];
    rows.push({ name: 'jaren — entity doc path (guarded scan, no index declared)',
      results: [await timeAsync(() => jaren.jsonbUnindexed(), 200)] });
    const indexed = await jaren.jsonbIndexed();
    if (verify('jsonb indexed', expected, indexed, 'jaren collection')) {
      rows.push({ name: 'jaren — declared JSONPath index ($.profile.city, generated column)',
        results: [await timeAsync(() => jaren.jsonbIndexed(), 300)] });
    }
    for (const engine of engines.slice(1)) {
      if (engine.jsonbUnindexed === undefined) continue;
      const actual = await engine.jsonbUnindexed();
      if (!verify('jsonb', expected, actual, engine.label)) continue;
      rows.push({
        name: `${engine.label} — ${engine.label === 'Prisma'
          ? 'fetch all + filter in JS (no Json type on SQLite)'
          : 'json_extract scan'}`,
        results: [await timeAsync(() => engine.jsonbUnindexed(), 200)],
      });
      if (engine.prepareJsonbIndex !== undefined) {
        engine.prepareJsonbIndex();
        rows.push({ name: `${engine.label} — hand-created expression index`,
          results: [await timeAsync(() => engine.jsonbUnindexed(), 300)] });
        engine.dropJsonbIndex();
      }
    }
    tables.push({
      title: `Nested JSON member filter (profile.city = '${CITY}', 25% of ${USERS} users; `
        + 'indexed AND unindexed, both published)',
      columns: ['ns/query'], rows,
    });
  }

  // headline: our one-statement graph vs the best multi-statement rival
  const graphTable = tables.find((table) => table.title.startsWith('Graph load'));
  const jarenGraph = graphTable.rows[0].results[0];
  const rivalGraphRows = graphTable.rows.slice(1);
  const prismaRow = rivalGraphRows.find((row) => row.name.startsWith('Prisma'));
  const headlineRival = prismaRow ?? rivalGraphRows[0];
  const headlineRatio = headlineRival
    ? Number((headlineRival.results[0] / jarenGraph).toFixed(1))
    : null;
  if (headlineRatio !== null) {
    notes.push(`graph-load headline: jaren answers the two-level graph in one statement, `
      + `${headlineRatio}x faster than ${headlineRival.name.split(' — ')[0]} on this corpus`);
  }

  const meta = {
    runtime: IS_BUN ? `bun ${globalThis.Bun.version}` : `node ${process.version}`,
    users: USERS, posts: POSTS, comments: COMMENTS,
    engines: engines.map((engine) => ({ label: engine.label, adapter: engine.adapter })),
    headlineRatio,
    notes,
    equivalenceFailures,
  };

  for (const table of tables) {
    console.log(`\n${table.title}`);
    for (const row of table.rows) {
      console.log(`  ${row.name.padEnd(72)} ${formatNs(row.results[0]).padStart(12)}`
        + `${row.note ? `  (${row.note})` : ''}`);
    }
  }
  console.log(`\nequivalence failures: ${equivalenceFailures}`);
  for (const note of notes) console.log(`note: ${note}`);

  if (flags.output === 'json' && flags.filepath) {
    writeFileSync(flags.filepath, JSON.stringify({ meta, tables }));
    console.log(`\nwrote ${flags.filepath}`);
  }

  for (const engine of engines) await engine.close();
  rmSync(tmp, { recursive: true, force: true });
  if (equivalenceFailures > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  rmSync(tmp, { recursive: true, force: true });
  process.exit(1);
});

//#endregion
