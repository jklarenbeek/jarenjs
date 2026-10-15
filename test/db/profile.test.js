//@ts-check
/**
 * @file One profile, every engine (MODEL-FORMAT §8): the same profile
 * applies to collection, entity, graph, include and store-root
 * execution with the same refusal; an entity residual that would fetch
 * every referenced root is refused before the fetch under
 * `refuseFullScan`; a budget the engine counts is enforced and one it
 * cannot count is refused on plan shape or reported unavailable, never
 * estimated; `explain()` names the profile and the budgets that applied;
 * and `signal`/`deadline` are honoured before a statement and at every
 * row boundary.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';

import { createRuntime } from '@jarenjs/core/runtime';
import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';

import { statementCountingDriver } from './helpers.js';

const MODEL = {
  $model: '0.1',
  collections: {
    docs: {
      schema: { type: 'object', properties: {
        id: { type: 'string' }, tenant: { type: 'string' }, n: { type: 'integer' }, body: { type: 'string' } } },
      key: '/id',
      indexes: [{ name: 'by_tenant', path: '$.tenant' }],
    },
  },
  entities: {
    User: {
      schema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'integer', 'x-entity': { key: true } },
          tenant: { type: 'string', 'x-entity': { index: true } },
          age: { type: 'integer' },
          body: { type: 'string' },
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
          tenant: { type: 'string' },
          authorId: { type: 'integer' },
          title: { type: 'string' },
          comments: { 'x-entity': { relation: { to: 'Comment', many: true, via: 'postId', onDelete: 'cascade' } } },
        },
      },
    },
    Comment: {
      schema: {
        type: 'object',
        required: ['cid'],
        properties: { cid: { type: 'integer', 'x-entity': { key: true } }, postId: { type: 'integer' } },
      },
    },
  },
};

/** Two tenants, `a` and `b`, three users and six posts each side. */
async function seeded(options = {}) {
  const counters = { iterate: 0, next: 0, return: 0, all: 0 };
  const store = await openStore(MODEL, { driver: statementCountingDriver(counters), ...options });
  const sync = store.sync;
  sync.transaction(() => {
    let pid = 1;
    for (const tenant of ['a', 'b']) {
      for (let i = 1; i <= 3; i++) {
        const id = tenant === 'a' ? i : 10 + i;
        sync.collection('docs').insert({ id: `${tenant}${i}`, tenant, n: i, body: 'x'.repeat(i === 3 ? 400 : 8) });
        sync.entity('User').create({ id, tenant, age: 20 + i, body: 'x'.repeat(i === 3 ? 400 : 8) });
        for (let p = 0; p < 2; p++) sync.entity('Post').create({ pid: pid++, tenant, authorId: id, title: `t${pid}` });
      }
    }
  });
  for (const key of Object.keys(counters)) counters[key] = 0;
  return { store, counters };
}

const codeIs = (code, pattern = undefined) => (error) =>
  error.code === code && (pattern === undefined || pattern.test(error.message));

const TENANT_A = {
  collections: ['docs', 'User', 'Post'],
  predicates: {
    docs: { $eq: ['$it.tenant', 'a'] },
    User: { $eq: ['$it.tenant', 'a'] },
    Post: { $eq: ['$it.tenant', 'a'] },
  },
  maxRows: 10,
};

describe('a profile applies identically to collection, entity, graph, include and store-root execution', () => {
  it('the mandatory predicate binds every engine\'s fetch, and the allow-list refuses each with one code', async () => {
    const { store } = await seeded();
    const profile = TENANT_A;
    // the collection
    const docs = await Promise.resolve(store.collection('docs').execute(
      { $for: { it: '$[*]' }, $orderby: ['$it.id'], $return: '$it.id' }, { profile }));
    assert.deepStrictEqual(docs, ['a1', 'a2', 'a3']);
    // the entity engine, native and residual, through the set and the store root
    const users = store.entity('User');
    const native = { $for: { u: '$.User[*]' }, $orderby: ['$u.id'], $return: '$u' };
    const residual = { $for: { u: '$.User[*]' }, $let: { k: 1 }, $orderby: ['$u.id'], $return: '$u' };
    for (const document of [native, residual]) {
      const viaSet = await Promise.resolve(users.execute(document, { profile }));
      const viaRoot = await Promise.resolve(store.execute(document, { profile }));
      assert.deepStrictEqual(viaSet.map((u) => u.id), [1, 2, 3], JSON.stringify(document));
      assert.deepStrictEqual(viaRoot, viaSet);
      const streamed = [];
      for await (const u of users.cursor(document, { profile })) streamed.push(u.id);
      assert.deepStrictEqual(streamed, [1, 2, 3]);
    }
    // the graph: the root and every include wear their entity's predicate
    const spec = { orderBy: '$it.id', include: { posts: true } };
    const loaded = [];
    for await (const u of users.loadCursor(spec, { profile })) loaded.push(u);
    assert.deepStrictEqual(loaded.map((u) => [u.id, u.posts.map((p) => p.tenant)]),
      [[1, ['a', 'a']], [2, ['a', 'a']], [3, ['a', 'a']]]);
    const page = await users.page(spec, { profile, limit: 2 });
    assert.deepStrictEqual(page.items.map((u) => u.id), [1, 2]);
    assert.strictEqual(users.explainLoad(spec, { profile }).budget.rows, 10);
    // the store-level profile reaches load() too
    const narrowed = await openStore(MODEL, { driver: nodeDriver(), profile: { ...profile } });
    await narrowed.entity('User').create({ id: 99, tenant: 'b', age: 1 });
    await narrowed.entity('User').create({ id: 98, tenant: 'a', age: 1 });
    assert.deepStrictEqual((await narrowed.entity('User').asNoTracking().load()).map((u) => u.id), [98]);
    await narrowed.close();

    // the allow-list: the same code and the same shape of reason, per engine
    const denied = { collections: ['docs', 'User'] };
    await assert.rejects(async () => (store.entity('Post').execute(
      { $for: { p: '$.Post[*]' }, $return: '$p' }, { profile: denied })),
    codeIs('JD0011', /does not allow querying entity 'Post'/));
    await assert.rejects(async () => (store.execute(
      { $for: { p: '$.Post[*]' }, $return: '$p' }, { profile: denied })),
    codeIs('JD0011', /does not allow querying entity 'Post'/));
    assert.throws(() => users.cursor({ $for: { p: '$.Post[*]' }, $return: '$p' }, { profile: denied }),
      codeIs('JD0011', /does not allow querying entity 'Post'/));
    assert.throws(() => users.explainLoad({ include: { posts: true } }, { profile: denied }),
      codeIs('JD0011', /does not allow loading entity 'Post' \(include path: posts\)/));
    await assert.rejects(() => users.page({ include: { posts: true } }, { profile: denied }),
      codeIs('JD0011', /does not allow loading entity 'Post'/));
    await assert.rejects(async () => (store.collection('docs').execute(
      { $for: { it: '$[*]' }, $return: '$it' }, { profile: { collections: ['User'] } })),
    codeIs('JD0011', /does not allow querying collection 'docs'/));
    await store.close();
  });

  it('the row bound is counted on every engine: the native answer, the residual\'s input, the cursor, the load', async () => {
    const { store } = await seeded();
    const bounded = { maxRows: 4 };
    const rows = codeIs('JD2007', /maxRows bound of 4/);
    await assert.rejects(async () => (store.collection('docs').execute(
      { $for: { it: '$[*]' }, $return: '$it' }, { profile: bounded })), rows);
    await assert.rejects(async () => (store.entity('User').execute(
      { $for: { u: '$.User[*]' }, $return: '$u' }, { profile: bounded })), rows);
    await assert.rejects(async () => (store.entity('User').execute(
      { $for: { u: '$.User[*]' }, $let: { k: 1 }, $return: '$u' }, { profile: bounded })), rows);
    await assert.rejects(async () => {
      for await (const u of store.entity('User').cursor({ $for: { u: '$.User[*]' }, $return: '$u' }, { profile: bounded })) void u;
    }, rows);
    await assert.rejects(async () => {
      for await (const u of store.entity('User').loadCursor({}, { profile: bounded })) void u;
    }, codeIs('JD2007', /the load crossed the profile's maxRows bound of 4/));
    await assert.rejects(() => store.entity('User').page({}, { profile: bounded, limit: 10 }), codeIs('JD2007'));
    // within the bound, every engine answers
    const within = { maxRows: 6 };
    assert.strictEqual((await Promise.resolve(store.entity('User').execute(
      { $for: { u: '$.User[*]' }, $return: '$u' }, { profile: within }))).length, 6);
    assert.strictEqual((await store.entity('User').page({}, { profile: within, limit: 5 })).items.length, 5);
    await store.close();
  });
});

describe('refusal of an unbounded residual fetch', () => {
  it('an entity residual that would fetch every referenced root is refused, coded, before the fetch', async () => {
    const { store, counters } = await seeded();
    const profile = { refuseFullScan: true };
    const residual = { $for: { u: '$.User[*]' }, $let: { k: 1 }, $return: '$u' };
    const refusal = codeIs('JD0011', /refuses a full-table scan, and the residual this document needs fetches every row of User \('\$let'/);
    await assert.rejects(async () => (store.entity('User').execute(residual, { profile })), refusal);
    assert.throws(() => store.entity('User').cursor(residual, { profile }), refusal);
    await assert.rejects(() => store.entity('User').explain(residual, { profile }), refusal);
    assert.strictEqual(counters.all + counters.iterate, 0, 'nothing was fetched');
    // a native plan without an index is a scan by the database's own account
    await assert.rejects(async () => (store.entity('User').execute(
      { $for: { u: '$.User[*]' }, $where: { $gt: ['$u.age', 1] }, $return: '$u' }, { profile })),
    codeIs('JD0011', /refuses a full-table scan of User \(SCAN t0/));
    // a native plan that seeks through the index runs
    const seeking = await Promise.resolve(store.entity('User').execute(
      { $for: { u: '$.User[*]' }, $where: { $eq: ['$u.tenant', 'a'] }, $return: '$u' }, { profile }));
    assert.strictEqual(seeking.length, 3);
    await store.close();
  });
});

describe('a budget the engine counts is enforced; one it cannot count is refused on shape or reported unavailable', () => {
  it('the graph caps are hard maxima, the byte bound is per item, and the driver slots are named unavailable', async () => {
    const { store } = await seeded();
    const users = store.entity('User');
    assert.throws(() => users.explainLoad({ include: { posts: { maxRows: 5 } } }, { profile: { maxIncludedRows: 2 } }),
      codeIs('JD0011', /caps included rows per root at 2; the include 'posts' declares 5/));
    assert.throws(() => users.explainLoad({ include: { posts: { maxRows: Infinity } } }, { profile: { maxIncludedRows: 2 } }),
      codeIs('JD0011', /declares no bound \(Infinity\)/));
    assert.strictEqual(users.explainLoad({ include: { posts: { take: 2 } } }, { profile: { maxIncludedRows: 2 } }).budget.includedRows, 2);
    assert.throws(() => users.explainLoad({ include: { posts: { include: { comments: true } } } }, { profile: { maxDepth: 1 } }),
      codeIs('JD0011', /caps the include depth at 1; this load asks for 3/));
    const tiny = { maxBytes: 100 };
    const bytes = codeIs('JD2076', /exceeds the profile's maxBytes bound of 100/);
    await assert.rejects(async () => (store.collection('docs').execute(
      { $for: { it: '$[*]' }, $return: '$it' }, { profile: tiny })), bytes);
    await assert.rejects(async () => {
      for await (const d of store.collection('docs').query({ $for: { it: '$[*]' }, $return: '$it' }, { profile: tiny })) void d;
    }, bytes);
    await assert.rejects(async () => (users.execute({ $for: { u: '$.User[*]' }, $return: '$u' }, { profile: tiny })), bytes);
    await assert.rejects(async () => {
      for await (const u of users.loadCursor({}, { profile: tiny })) void u;
    }, bytes);
    // the slots SQLite cannot fill are declared, not guessed
    assert.strictEqual(store.capabilities.statementTimeout, false);
    const explained = await store.collection('docs').explain(
      { $for: { it: '$[*]' }, $return: '$it' }, { profile: { refuseFullScan: true, maxRows: 7 } });
    assert.deepStrictEqual(explained.budget, {
      profile: { source: 'call', name: 'custom' },
      rows: 7, includedRows: null, depth: null, bytes: null,
      limits: { sequenceItems: 100_000, resultItems: 10_000, steps: 1_000_000, depth: 32 },
      scan: 'refused-by-shape', time: 'unavailable', estimatedRows: 'unavailable',
    });
    await store.close();
  });

  it('no estimated-row arithmetic exists anywhere in the engines: the planner\'s answer is asked for at one site and handed over', () => {
    const names = /** @type {string[]} */ (fs.readdirSync('packages/db/src', { recursive: true }))
      .map((name) => String(name).replaceAll('\\', '/')).filter((name) => name.endsWith('.js'));
    const sources = new Map(names.map((name) => [name, fs.readFileSync(`packages/db/src/${name}`, 'utf8')]));
    const code = (/** @type {string} */ line) => !/^\s*(\/\/|\*|\/\*)/.test(line);
    const occurrences = (/** @type {string} */ needle) => [...sources].flatMap(([name, source]) =>
      source.split('\n').filter((line) => code(line) && line.includes(needle)).map(() => name));
    // one helper asks the database, one dialect member reads the answer,
    // and the one dialect that has an answer says whose number it is
    assert.deepStrictEqual(occurrences('.explainEstimate('), ['query.js']);
    assert.deepStrictEqual(occurrences('.readEstimate('), ['query.js']);
    assert.deepStrictEqual(occurrences("'postgresql-planner'"), ['dialects/postgres.js']);
    // every code line of the engines that names an estimate is a capability slot, a dialect
    // member passed through, the helper or the budget slot — or merely hands the answer on
    const DEFINITIONS = new Set([
      'rowEstimates: false,',
      'explainEstimate: spec.explainEstimate ?? null,',
      'readEstimate: spec.readEstimate ?? null,',
      'function budgetOf(profile, source, capabilities, estimate = null) {',
      "estimatedRows: estimate ?? 'unavailable',",
      'function estimateOf(connection, dialect, sql, params) {',
      "if (connection.capabilities?.rowEstimates !== true || typeof dialect.explainEstimate !== 'function') return null;",
      'return useStatementOnce(connection, dialect.explainEstimate(sql), (statement) =>',
      'chain(statement.all(params), (rows) => dialect.readEstimate(rows)), { readOnly: true });',
    ]);
    for (const [name, source] of sources) {
      if (name.includes('/')) continue;
      for (const line of source.split('\n').filter((text) => code(text) && /estimat/i.test(text))) {
        if (DEFINITIONS.has(line.trim())) continue;
        assert.match(line, /\bestimate\b|\bestimateOf\(/, `${name}: ${line.trim()} — an estimate is the database's answer, not a computed number`);
        assert.doesNotMatch(line.replace(/'[^']*'/g, ''), /[-+*/%]/,
          `${name}: ${line.trim()} — nothing computes with a row estimate`);
      }
    }
  });
});

describe('explain() names the profile that applied and the budgets imposed', () => {
  it('store-level and per-call profiles are told apart, and no profile is null', async () => {
    const { store } = await seeded({ profile: 'safe' });
    const document = { $for: { u: '$.User[*]' }, $return: '$u' };
    const stored = await store.entity('User').explain(document);
    assert.deepStrictEqual(stored.budget.profile, { source: 'store', name: 'safe' });
    assert.strictEqual(stored.budget.rows, 1000);
    const called = await store.entity('User').explain(document, { profile: { maxRows: 3 } });
    assert.deepStrictEqual([called.budget.profile, called.budget.rows], [{ source: 'call', name: 'custom' }, 3]);
    assert.deepStrictEqual(store.entity('User').explainLoad({}).budget.profile, { source: 'store', name: 'safe' });
    await store.close();
    const plain = await openStore(MODEL, { driver: nodeDriver() });
    const none = await plain.collection('docs').explain({ $for: { it: '$[*]' }, $return: '$it' });
    assert.deepStrictEqual(none.budget, {
      profile: null, rows: null, includedRows: null, depth: null, bytes: null, limits: null,
      scan: 'unbounded', time: 'unavailable', estimatedRows: 'unavailable',
    });
    await plain.close();
  });
});

describe('signal and deadline are declared per call and honoured', () => {
  it('an aborted call and a passed deadline issue no statement; a cursor checks the deadline at every row', async () => {
    let now = 1_000;
    const { store, counters } = await seeded({ runtime: createRuntime({ now: () => now }) });
    const aborted = AbortSignal.abort();
    const document = { $for: { u: '$.User[*]' }, $return: '$u' };
    await assert.rejects(async () => (store.entity('User').execute(document, { signal: aborted })), codeIs('JD2072'));
    await assert.rejects(async () => (store.collection('docs').execute({ $for: { it: '$[*]' }, $return: '$it' }, { signal: aborted })), codeIs('JD2072'));
    assert.throws(() => store.entity('User').cursor(document, { deadline: now - 1 }), codeIs('JD2075', /passed before the call ran/));
    await assert.rejects(() => store.entity('User').page({}, { deadline: now - 1 }), codeIs('JD2075'));
    assert.strictEqual(counters.all + counters.iterate, 0, 'no statement ran for any of them');
    assert.throws(() => store.entity('User').cursor(document, { deadline: /** @type {any} */ ('soon') }),
      codeIs('JD0013', /'deadline' must be a finite timestamp/));
    const soon = store.entity('User').cursor(document, { deadline: now + 40 });
    assert.strictEqual((await soon.next()).done, false);
    now += 60;
    await assert.rejects(() => soon.next(), codeIs('JD2075', /passed before the next row/));
    assert.strictEqual(counters.return, 1, 'released at the row boundary');
    await store.close();
  });
});

describe('the member allow-list: what a caller may read, per root', () => {
  const MEMBERS = {
    ...TENANT_A,
    members: { docs: ['$.id', '$.n'], User: ['$.id', '$.age'] },
  };

  it('a projection of allowed members answers; a denied member is JD0011 naming root, member and document path', async () => {
    const { store } = await seeded();
    const rows = await Promise.resolve(store.collection('docs').execute(
      { $for: { it: '$[*]' }, $orderby: ['$it.id'], $return: { id: '$it.id', n: '$it.n' } },
      { profile: MEMBERS }));
    assert.deepStrictEqual(rows, [{ id: 'a1', n: 1 }, { id: 'a2', n: 2 }, { id: 'a3', n: 3 }]);

    await assert.rejects(
      async () => store.collection('docs').execute(
        { $for: { it: '$[*]' }, $return: { b: '$it.body' } }, { profile: MEMBERS }),
      codeIs('JD0011', /does not allow the member 'body' of 'docs'.*at \/\$return\/b/));
    // the same policy over a predicate, an ordering and an external
    // comparison — one collector, every clause
    for (const document of [
      { $for: { it: '$[*]' }, $where: { $eq: ['$it.body', 'x'] }, $return: { id: '$it.id' } },
      { $for: { it: '$[*]' }, $orderby: ['$it.body'], $return: { id: '$it.id' } },
      { $count: { $for: { it: '$[*]' }, $return: '$it.body' } },
    ]) {
      await assert.rejects(async () => store.collection('docs').execute(document, { profile: MEMBERS }),
        codeIs('JD0011', /does not allow the member 'body' of 'docs'/), JSON.stringify(document));
    }
    await store.close();
  });

  it('a bare-root return does not bypass the list — it reads the whole item, and says so', async () => {
    const { store } = await seeded();
    await assert.rejects(
      async () => store.collection('docs').execute({ $for: { it: '$[*]' }, $return: '$it' },
        { profile: MEMBERS }),
      codeIs('JD0011', /allows only the members \(\$\.id, \$\.n\) of 'docs'.*reads the whole item/));
    // an alias through $let is the same read under another name
    await assert.rejects(
      async () => store.collection('docs').execute(
        { $for: { it: '$[*]' }, $let: { alias: '$it' }, $return: { b: '$alias.body' } },
        { profile: MEMBERS }),
      codeIs('JD0011', /reads the whole item/));
    // and so is a wildcard with no singular prefix
    await assert.rejects(
      async () => store.collection('docs').execute(
        { $for: { it: '$[*]' }, $return: { any: { $count: '$it[*]' } } }, { profile: MEMBERS }),
      codeIs('JD0011', /reads the whole item/));
    await store.close();
  });

  it('allowing a member allows what is under it, and never its siblings', async () => {
    const { store } = await seeded();
    // `$.o` allows `$.o.k`; `$.o.k` does not allow `$.o`
    const nested = { $model: '0.1', collections: { rows: {
      schema: { type: 'object', properties: { id: { type: 'string' },
        o: { type: 'object', properties: { k: { type: 'integer' }, secret: { type: 'string' } } } } },
      key: '/id' } } };
    const inner = await openStore(nested, { driver: nodeDriver() });
    await inner.collection('rows').insert({ id: 'r1', o: { k: 4, secret: 'no' } });
    const under = await Promise.resolve(inner.collection('rows').execute(
      { $for: { it: '$[*]' }, $return: { k: '$it.o.k' } }, { profile: { members: { rows: ['$.o'] } } }));
    assert.deepStrictEqual(under, { k: 4 });
    await assert.rejects(
      async () => inner.collection('rows').execute(
        { $for: { it: '$[*]' }, $return: { o: '$it.o' } },
        { profile: { members: { rows: ['$.o.k'] } } }),
      codeIs('JD0011', /does not allow the member 'o' of 'rows'/),
      'reading the parent exposes the sibling the list withheld');
    await inner.close();
    await store.close();
  });

  it('the entity engine applies it per referenced root, and a graph load is refused whole', async () => {
    const { store } = await seeded();
    const users = await Promise.resolve(store.entity('User').execute(
      { $for: { u: '$.User[*]' }, $orderby: ['$u.id'], $return: { id: '$u.id', age: '$u.age' } },
      { profile: MEMBERS }));
    assert.deepStrictEqual(users, [{ id: 1, age: 21 }, { id: 2, age: 22 }, { id: 3, age: 23 }]);
    await assert.rejects(
      async () => store.entity('User').execute(
        { $for: { u: '$.User[*]' }, $return: { b: '$u.body' } }, { profile: MEMBERS }),
      codeIs('JD0011', /does not allow the member 'body' of 'User'/));
    // Post carries no list, so its members stay readable in the same document
    const joined = await Promise.resolve(store.entity('User').execute({
      $for: { u: '$.User[*]', p: '$.Post[*]' },
      $where: { $eq: ['$u.id', '$p.authorId'] },
      $orderby: ['$p.pid'],
      $return: { id: '$u.id', title: '$p.title' },
    }, { profile: MEMBERS }));
    assert.strictEqual(Array.isArray(joined) && joined.length, 6);
    // a graph load answers whole documents: refused by name, with the
    // allowed members in the message
    assert.throws(() => store.entity('User').explainLoad({}, { profile: MEMBERS }),
      codeIs('JD0011', /a graph load answers whole documents/));
    await assert.rejects(() => store.entity('User').page({}, { profile: MEMBERS }),
      codeIs('JD0011', /a graph load answers whole documents/));
    // an entity with no list loads as before
    assert.ok(typeof store.entity('Post').explainLoad({}, { profile: MEMBERS }).sql === 'string');
    await store.close();
  });

  it('an undeclared root in the list refuses before any statement, at the store and per call', async () => {
    await assert.rejects(
      () => openStore(MODEL, { driver: nodeDriver(), profile: { members: { nope: ['$.id'] } } }),
      codeIs('JD0011', /names 'nope', which the model does not declare/));
    const { store, counters } = await seeded();
    await assert.rejects(
      async () => store.collection('docs').execute({ $for: { it: '$[*]' }, $return: { id: '$it.id' } },
        { profile: { members: { nope: ['$.id'] } } }),
      codeIs('JD0011', /names 'nope'/));
    assert.strictEqual(counters.all + counters.iterate, 0, 'no statement ran');
    await store.close();
  });

  it('a malformed list is host misuse, refused at normalization', async () => {
    for (const members of [
      { docs: [] },
      { docs: 'name' },
      { docs: ['name'] },
      { docs: ['$.a[*]'] },
      { docs: ['$..a'] },
      { docs: [3] },
    ]) {
      assert.throws(() => openStore(MODEL, { driver: nodeDriver(), profile: { members } }),
        TypeError, JSON.stringify(members));
    }
    assert.throws(() => openStore(MODEL, { driver: nodeDriver(), profile: { members: ['$.id'] } }),
      TypeError);
  });
});

describe('a profile predicate the statement cannot spell is refused JD0011 on a collection as on an entity', () => {
  // a member name holding a double quote has no SQLite JSON path; the
  // collection's residual fetch let the emitter's internal error escape
  const predicate = { $eq: ['$it["a\\"b"]', 'x'] };
  it('every query refuses it by name; a point read, which the engine judges, answers', async () => {
    const store = await openStore({ $model: '0.1', collections: { ev: { key: '/id', schema: { type: 'object' } } },
      entities: { E: { schema: { type: 'object', required: ['id'], properties: { id: { type: 'string', 'x-entity': { key: true } } } } } } },
    { driver: nodeDriver(), profile: { predicates: { ev: predicate, E: predicate } } });
    try {
      for (const id of ['1', '2']) {
        await store.collection('ev').insert({ id, 'a"b': id === '1' ? 'x' : 'y' });
        await store.entity('E').create({ id, 'a"b': id === '1' ? 'x' : 'y' });
      }
      const refused = (/** @type {string} */ root) => (/** @type {any} */ error) => error.code === 'JD0011'
        && error.message.startsWith(`JD0011: the profile's predicate for '${root}' compares a string this server cannot hold`);
      await assert.rejects(async () => store.collection('ev').execute({ $for: { it: '$[*]' }, $return: '$it.id' }), refused('ev'));
      await assert.rejects(async () => store.collection('ev').all(), refused('ev'));
      await assert.rejects(async () => store.execute({ $for: { e: '$.E[*]' }, $return: '$e.id' }), refused('E'));
      assert.deepStrictEqual(await store.collection('ev').get('1'), { id: '1', 'a"b': 'x' });
      assert.strictEqual(await store.collection('ev').get('2'), undefined);
      assert.strictEqual(await store.entity('E').get('2'), undefined);
    }
    finally { await store.close(); }
  });
});
