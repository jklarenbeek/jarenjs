//@ts-check
/**
 * @file A keyset walk shares one plan: every page after the first resumes
 * from a continuation whose VALUES are bound per call, and only its shape
 * (which order keys are NULL) is part of the statement's identity. A walk
 * of n pages compiles two statements, not n; the continuation is still
 * checked against the ordering on every page, a plan hit included; and a
 * long walk no longer evicts the other plans of a bounded cache. The same
 * cases run on SQLite and, where JAREN_PG_URL is set, on PostgreSQL.
 */

import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert';

import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { postgresDriver } from '@jarenjs/db/postgres';

const MODEL = {
  $model: '0.1',
  entities: {
    User: {
      schema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', 'x-entity': { key: true } },
          age: { type: 'integer', 'x-entity': { index: true } },
          score: { type: ['integer', 'null'], 'x-entity': { index: true } },
          tier: { type: ['integer', 'null'], 'x-entity': { index: true } },
        },
      },
    },
  },
};

/** Twelve users: ages and scores tie, four scores and six tiers are null. */
const USERS = [
  ['u01', 20, 5, 1], ['u02', 20, null, 2],
  ['u03', 21, 5, null], ['u04', 21, 7, null],
  ['u05', 21, null, 1], ['u06', 22, 1, 3],
  ['u07', 22, null, null], ['u08', 22, 7, 1],
  ['u09', 23, 5, 2], ['u10', 23, 1, null],
  ['u11', 24, null, null], ['u12', 24, 7, null],
].map(([id, age, score, tier]) => ({ id, age, score, tier }));

const url = process.env.JAREN_PG_URL;

/**
 * Each host opens the model with a cache bound and answers the store and what releases it.
 * @type {{ name: string, skip: string | false, open: (bound: number) => Promise<{ store: any, release: () => Promise<void> }> }[]}
 */
const HOSTS = [
  { name: 'SQLite', skip: false, open: async (bound) => {
    const store = await openStore(MODEL, { driver: nodeDriver(), statementCacheBound: bound });
    return { store, release: () => store.close() };
  } },
  { name: 'PostgreSQL', skip: !url && 'JAREN_PG_URL is not set', open: async (bound) => {
    const pg = (await import('pg')).default;
    const schema = `jaren_keyset_reuse_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const pool = new pg.Pool({ connectionString: url, max: 1 });
    try {
      const store = await openStore(MODEL, { driver: postgresDriver(pool, { schema }), statementCacheBound: bound });
      return { store, release: async () => {
        await store.close().catch(() => {});
        await pool.end().catch(() => {});
        try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
        finally { await admin.end(); }
      } };
    }
    catch (error) {
      await pool.end().catch(() => {});
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
      await admin.end();
      throw error;
    }
  } },
];

/** A store holding the twelve users. @param {(typeof HOSTS)[number]} host @param {number} statementCacheBound */
async function seeded(host, statementCacheBound) {
  const opened = await host.open(statementCacheBound);
  for (const user of USERS) await opened.store.entity('User').create(user);
  return opened;
}

/** @param {any} store @param {() => Promise<any>} run the cache counters it moved */
async function counted(store, run) {
  const before = store.stats().statementCache;
  const result = await run();
  const now = store.stats().statementCache;
  return { result, hits: now.hits - before.hits, misses: now.misses - before.misses, evictions: now.evictions - before.evictions };
}

/** Walk every page; answer the ids in order. @param {any} set @param {any} spec @param {number} limit */
async function walk(set, spec, limit) {
  /** @type {string[]} */
  const ids = [];
  let from = undefined;
  for (let pages = 0; pages < 20; pages++) {
    const page = await set.page(spec, { limit, after: from });
    ids.push(...page.items.map((/** @type {any} */ row) => row.id));
    if (!page.hasMore) return ids;
    from = page.continuation;
  }
  throw new assert.AssertionError({ message: `a walk of twelve rows did not end in 20 pages: ${ids.join(',')}` });
}

/** @param {string} code @param {RegExp} [pattern] */
const codeIs = (code, pattern = undefined) => (/** @type {any} */ error) =>
  error.code === code && (pattern === undefined || pattern.test(error.message));

for (const host of HOSTS) describe(`${host.name}: a keyset walk shares one plan`, { skip: host.skip }, () => {
  /** @type {any} */
  let store = null;
  /** @type {(() => Promise<void>) | null} */
  let release = null;
  /** @type {any} */
  let users = null;

  before(async () => {
    ({ store, release } = await seeded(host, 128));
    users = store.entity('User');
  });
  after(async () => {
    if (release !== null) await release();
  });

  it('twelve users in pages of two: the first page and the first continuation compile, the other four pages hit', async () => {
    const run = await counted(store, () => walk(users, { orderBy: '$it.id' }, 2));
    assert.deepStrictEqual(run.result, USERS.map((user) => user.id));
    assert.deepStrictEqual([run.misses, run.hits], [2, 4]);
    // a second walk compiles nothing
    const again = await counted(store, () => walk(users, { orderBy: '$it.id' }, 2));
    assert.deepStrictEqual(again.result, USERS.map((user) => user.id));
    assert.deepStrictEqual([again.misses, again.hits], [0, 6]);
  });

  it('an ordering that crosses its NULLs compiles one statement for each shape, and answers as the engine orders', async () => {
    // nulls first: the continuation is NULL while the walk is among them, then not
    const spec = { orderBy: '$it.score' };
    const whole = (await users.asNoTracking().load(spec)).map((/** @type {any} */ user) => user.id);
    assert.deepStrictEqual(whole, ['u02', 'u05', 'u07', 'u11', 'u06', 'u10', 'u01', 'u03', 'u09', 'u04', 'u08', 'u12']);
    const run = await counted(store, () => walk(users, spec, 2));
    assert.deepStrictEqual(run.result, whole);
    // the first page, a NULL continuation, a non-NULL continuation: three statements, three hits
    assert.deepStrictEqual([run.misses, run.hits], [3, 3]);
    const descending = { orderBy: { $key: '$it.score', $dir: 'desc' } };
    const wholeDescending = (await users.asNoTracking().load(descending)).map((/** @type {any} */ user) => user.id);
    assert.deepStrictEqual((await walk(users, descending, 5)), wholeDescending);
  });

  it('a continuation that cannot belong to the ordering is refused on a plan hit as on a miss', async () => {
    const spec = { orderBy: '$it.age' };
    const first = await users.page(spec, { limit: 3 });
    const second = await users.page(spec, { limit: 3, after: first.continuation });
    assert.deepStrictEqual(second.items.map((/** @type {any} */ user) => user.id), ['u04', 'u05', 'u06']);
    // the plan for this shape is cached now; the same shape with a foreign ordering or a key of
    // the wrong kind must still be JD0035, and so must another count of keys (another shape)
    const cached = await counted(store, () => users.page(spec, { limit: 3, after: second.continuation }));
    assert.deepStrictEqual([cached.misses, cached.hits], [0, 1]);
    const foreign = { ...second.continuation, order: [{ column: 'score', desc: false, nullsFirst: true }, { column: 'id', desc: false, nullsFirst: true }] };
    await assert.rejects(async () => users.page(spec, { limit: 3, after: foreign }),
      codeIs('JD0035', /it was emitted for the ordering \(score asc nulls first, id asc nulls first\); this graph orders by \(age asc nulls first, id asc nulls first\)/));
    await assert.rejects(async () => users.page(spec, { limit: 3, after: { ...second.continuation, key: { id: 'u06' } } }),
      codeIs('JD0035', /'key' must be the row's primary key, a scalar/));
    await assert.rejects(async () => users.page(spec, { limit: 3, after: { ...second.continuation, keys: [22, 1] } }),
      codeIs('JD0035', /it carries 2 order-key value\(s\); the ordering declares 1/));
    await assert.rejects(async () => users.explainLoad({ ...spec, after: foreign }), codeIs('JD0035'));
    await assert.rejects(async () => users.asNoTracking().load({ ...spec, after: foreign }), codeIs('JD0035'));
    // and the refusals left the cached plan serving the real continuation
    const again = await users.page(spec, { limit: 3, after: second.continuation });
    assert.deepStrictEqual(again.items.map((/** @type {any} */ user) => user.id), ['u07', 'u08', 'u09']);
  });

  it('the continuation reaches every surface by value: load, loadCursor, page and explainLoad', async () => {
    const spec = { orderBy: '$it.age' };
    const first = await users.page(spec, { limit: 5 });
    const resumed = { ...spec, after: first.continuation };
    const expected = ['u06', 'u07', 'u08', 'u09', 'u10', 'u11', 'u12'];
    assert.deepStrictEqual((await users.asNoTracking().load(resumed)).map((/** @type {any} */ user) => user.id), expected);
    /** @type {string[]} */
    const pulled = [];
    for await (const user of users.loadCursor(resumed)) pulled.push(user.id);
    assert.deepStrictEqual(pulled, expected);
    // a second continuation of the same shape binds its own values in the shared plan
    const later = await users.page(spec, { limit: 5, after: first.continuation });
    const last = await users.page(spec, { limit: 5, after: later.continuation });
    assert.deepStrictEqual(last.items.map((/** @type {any} */ user) => user.id), ['u11', 'u12']);
    const explained = await users.explainLoad({ ...spec, after: later.continuation });
    // an `integer` column holds a writer's digits on PostgreSQL: its term reads the double there
    const age = host.name === 'PostgreSQL' ? 'double\\("r"\\."age"\\)' : '"r"\\."age"';
    assert.match(explained.sql.replace(/\(CASE WHEN abs\(("r"\."\w+")\) < .*? END\)/g, 'double($1)'),
      new RegExp(`WHERE \\(${age} > [?$]\\d* OR \\(${age} = [?$]\\d* AND "r"\\."id" > [?$]\\d*\\)\\)`));
    assert.strictEqual(explained.pagination, 'keyset');
  });

  it('a scalar after is bound by value too: a walk by a unique column compiles two statements', async () => {
    const run = await counted(store, async () => {
      /** @type {string[]} */
      const ids = [];
      let from = undefined;
      for (;;) {
        const rows = await users.asNoTracking().load({ orderBy: '$it.id', take: 5, ...(from === undefined ? {} : { after: from }) });
        ids.push(...rows.map((/** @type {any} */ user) => user.id));
        if (rows.length < 5) return ids;
        from = rows[rows.length - 1].id;
      }
    });
    assert.deepStrictEqual(run.result, USERS.map((user) => user.id));
    assert.deepStrictEqual([run.misses, run.hits], [2, 1]);
  });

  it('two nullable order keys: a continuation whose second key flips between NULL and not keeps its own statement, whatever the direction', async () => {
    const orderings = [
      ['$it.score', '$it.tier'],
      [{ $key: '$it.score', $dir: 'desc' }, '$it.tier'],
      ['$it.score', { $key: '$it.tier', $dir: 'desc' }],
      [{ $key: '$it.score', $dir: 'desc' }, { $key: '$it.tier', $dir: 'desc' }],
    ];
    for (const orderBy of orderings) {
      const whole = (await users.asNoTracking().load({ orderBy })).map((/** @type {any} */ user) => user.id);
      assert.strictEqual(new Set(whole).size, USERS.length);
      for (const limit of [1, 2, 3]) {
        assert.deepStrictEqual(await walk(users, { orderBy }, limit), whole, `${JSON.stringify(orderBy)} in pages of ${limit}`);
      }
    }
    // the walk's tail: the first key is set and the second flips between NULL and not on every other page
    const spec = { orderBy: ['$it.score', '$it.tier'] };
    const seen = [];
    let from = undefined;
    for (let pages = 0; pages < 20; pages++) {
      const page = await users.page(spec, { limit: 1, after: from });
      if (page.continuation !== null) seen.push(page.continuation.keys.map((/** @type {any} */ key) => key === null));
      if (!page.hasMore) break;
      from = page.continuation;
    }
    assert.deepStrictEqual(seen.slice(4, 10), [[false, true], [false, false], [false, true], [false, false], [false, false], [false, true]]);
  });

  it('a long walk no longer evicts the other plans of the cache', async () => {
    // three entries: the plan already held and the two a walk compiles; six pages that each
    // compiled would push the plan out
    const { store: small, release: releaseSmall } = await seeded(host, 3);
    try {
      const other = { orderBy: { $key: '$it.age', $dir: 'desc' } };
      const held = small.entity('User');
      await held.asNoTracking().load(other);
      const warm = await counted(small, () => held.asNoTracking().load(other));
      assert.deepStrictEqual([warm.misses, warm.hits], [0, 1]);
      const run = await counted(small, () => walk(held, { orderBy: '$it.id' }, 2));
      assert.deepStrictEqual([run.misses, run.hits, run.evictions], [2, 4, 0]);
      const kept = await counted(small, () => held.asNoTracking().load(other));
      assert.deepStrictEqual([kept.misses, kept.hits], [0, 1]);
    }
    finally {
      await releaseSmall();
    }
  });
});
