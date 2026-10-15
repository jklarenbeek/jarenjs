//@ts-check
/**
 * @file Correlated navigation hops over a store's entities. A hop is a plain
 * inner FLWOR over a declared entity, correlated with the outer row by column
 * equalities: in a comparison, an existence or emptiness test, a count, a
 * root quantifier, an order key or a projection leaf it lowers to a
 * correlated subselect in the one statement, and answers what the in-memory
 * engine answers. The shapes without that proof stay in the engine under a
 * named reason that strict mode refuses. Every host the file reaches runs the
 * same cases: SQLite always, PostgreSQL where JAREN_PG_URL names a server.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { openStore, reasonId, PLANNER_REASONS } from '@jarenjs/db';
import { nodeDriver, adaptNodeDatabase } from '@jarenjs/db/node';
import { postgresDriver } from '@jarenjs/db/postgres';
import { compileJsonQuery } from '@jarenjs/json/query';

import {
  leafWorld, leafQueries, nullPolicyWorld, nullPolicyQueries, openAdopted, checkAdoptedHops,
  HIDING_PROFILE, hidesFirst,
} from './oracle/adopted-hops.js';
import { loadRelationGroups, storeForEntityGroup } from './oracle/harness.js';
import { liveOracle } from './oracle/replication.js';

const url = process.env.JAREN_PG_URL;
const key = { 'x-entity': { key: true } };

/** Users `u1 ada 36`, `u2 lin 64`, `u3 ada 8`, `u4 mo` (no age); posts that
 * lack a star count or an author. */
const MODEL = {
  $model: '0.1',
  entities: {
    User: { schema: { type: 'object', required: ['id'], properties: {
      id: { type: 'string', ...key }, name: { type: 'string' }, age: { type: 'integer' } } } },
    Post: { schema: { type: 'object', required: ['pid'], properties: {
      pid: { type: 'integer', ...key }, title: { type: 'string' }, stars: { type: 'integer' },
      authorId: { type: 'string' } } } },
  },
};
const DOCUMENTS = {
  User: [{ id: 'u1', name: 'ada', age: 36 }, { id: 'u2', name: 'lin', age: 64 },
    { id: 'u3', name: 'ada', age: 8 }, { id: 'u4', name: 'mo' }],
  Post: [{ pid: 1, title: 'ada', stars: 5, authorId: 'u1' }, { pid: 2, title: 'beta', stars: 1, authorId: 'u4' },
    { pid: 3, title: 'lin', authorId: 'u2' }, { pid: 4, title: 'orphan', stars: 3 }],
};

/** The hop from a post to its author, returning `member`. @param {string} member */
const hop = (member) => ({ $for: { r1: '$.User[*]' }, $where: { $eq: ['$r1.id', '$it.authorId'] }, $return: member });
/** The hop from a user to its posts, counted. */
const postCount = { $count: { $for: { r1: '$.Post[*]' }, $where: { $eq: ['$r1.authorId', '$it.id'] }, $return: '$r1' } };
/** @param {any} extra @param {string} [ret] */
const posts = (extra, ret = '$it.pid') => [{ $for: { it: '$.Post[*]' }, ...extra, $return: ret }];
/** @param {any} extra */
const users = (extra) => [{ $for: { it: '$.User[*]' }, ...extra, $return: '$it.id' }];

/** @typedef {{ name: string, pg: boolean }} Host */
/** @type {Host[]} */
const HOSTS = [{ name: 'sqlite', pg: false }, ...(url ? [{ name: 'postgres', pg: true }] : [])];

/** @type {any} */
let pg = null;
/** @type {any} */
let admin = null;
/** @type {any} */
let pool = null;
const schemas = /** @type {string[]} */ ([]);
let counter = 0;

/** A driver for one store on the host: a fresh disposable schema on PostgreSQL. @param {Host} host */
async function driverFor(host) {
  if (!host.pg) return nodeDriver();
  counter += 1;
  const schema = `jaren_hops_${process.pid}_${counter}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  schemas.push(schema);
  return postgresDriver(pool, { schema });
}

/** The host in the shape the adopted-table oracle opens tables on: a fresh schema on PostgreSQL. @param {Host} host */
async function adoptedHost(host) {
  if (!host.pg) return { kind: /** @type {const} */ ('sqlite'), driver: nodeDriver() };
  counter += 1;
  const schema = `jaren_hops_${process.pid}_${counter}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  schemas.push(schema);
  return { kind: /** @type {const} */ ('postgres'), admin, pool, schema };
}

/** @param {Host} host @param {any} model @param {Record<string, any[]>} documents */
async function open(host, model, documents) {
  const store = await openStore(model, { driver: await driverFor(host) });
  for (const [name, rows] of Object.entries(documents)) for (const row of rows) await store.entity(name).create(row);
  return store;
}

/**
 * Run `body` against a fresh store on the host and close the store however it
 * ends: a store holds a pooled connection until it is closed.
 * @param {Host} host @param {any} model @param {Record<string, any[]>} documents
 * @param {(store: any) => Promise<void>} body
 */
async function using(host, model, documents, body) {
  const store = await open(host, model, documents);
  try { await body(store); }
  finally { await store.close(); }
}

/** The reason id a residual explanation names first. @param {any} explained */
const reasonOf = (explained) => reasonId(explained.reasons[0].reason);

before(async () => {
  if (!url) return;
  pg = (await import('pg')).default;
  admin = new pg.Client({ connectionString: url });
  await admin.connect();
  pool = new pg.Pool({ connectionString: url, max: 2 });
});
after(async () => {
  await pool?.end().catch(() => {});
  if (admin) {
    try { for (const schema of schemas) await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
    finally { await admin.end(); }
  }
});

for (const host of HOSTS) {
  describe(`correlated hops: the counterexamples, ${host.name}`, () => {
    /** @type {any} */
    let store;
    before(async () => { store = await open(host, MODEL, DOCUMENTS); });
    after(async () => { await store.close(); });
    /** @param {any} document */
    const engine = (document) => compileJsonQuery(document)(structuredClone(DOCUMENTS));

    /** The document plans native, runs under strict mode, and answers `expected` as the engine does. */
    const native = async (/** @type {any} */ document, /** @type {any} */ expected) => {
      const explained = await store.explain(document);
      assert.equal(explained.mode, 'native', JSON.stringify(explained.reasons));
      assert.deepEqual(await store.execute(document, { strict: true }), expected);
      assert.deepEqual(await store.execute(document, { pushdown: false }), expected);
      assert.deepEqual(engine(document), expected, "the engine's own answer");
    };

    it('an empty hop is a NOT EXISTS that tests the member it returns', async () => {
      await native(posts({ $where: { $empty: hop('$r1.age') } }), [2, 4]);
    });
    it('an existing hop is an EXISTS that tests the member it returns', async () => {
      await native(posts({ $where: { $exists: hop('$r1.age') } }), [1, 3]);
    });
    it('a hop compared with a literal is an existential comparison', async () => {
      await native(posts({ $where: { $ge: [hop('$r1.age'), 30] } }), [1, 3]);
      await native(posts({ $where: { $ne: [hop('$r1.age'), 36] } }), [3]);
    });
    it('a count compares with a number; any other scalar makes the comparison a constant', async () => {
      const everyone = ['u1', 'u2', 'u3', 'u4'];
      await native(users({ $where: { $ne: [postCount, 'x'] } }), everyone);
      await native(users({ $where: { $ne: [postCount, null] } }), everyone);
      for (const op of ['$eq', '$lt', '$ge']) await native(users({ $where: { [op]: [postCount, 'x'] } }), []);
      await native(users({ $where: { $ge: [postCount, 1] } }), ['u1', 'u2', 'u4']);
      await native(users({ $where: { $eq: [postCount, 0] } }), ['u3']);
      await native(users({ $where: { $ge: [postCount, 2] } }), []);
    });
    it('a count against NaN or an infinity is a constant, a fraction the integers it admits', async () => {
      const everyone = ['u1', 'u2', 'u3', 'u4'];
      await native(users({ $where: { $ne: [postCount, NaN] } }), everyone);
      for (const op of ['$eq', '$lt', '$le', '$gt', '$ge']) await native(users({ $where: { [op]: [postCount, NaN] } }), []);
      await native(users({ $where: { $lt: [postCount, Infinity] } }), everyone);
      await native(users({ $where: { $gt: [postCount, -Infinity] } }), everyone);
      await native(users({ $where: { $ge: [postCount, Infinity] } }), []);
      await native(users({ $where: { $ge: [postCount, 0.5] } }), ['u1', 'u2', 'u4']);
      await native(users({ $where: { $lt: [1, postCount] } }), []);
    });
    it('a window around a quantifier, or the existence of a count, is not a hop plan', async () => {
      const windowed = [{ $subsequence: [{ $some: { it: '$.Post[*]' }, $satisfies: { $gt: ['$it.stars', 4] } }, 0, 1] }];
      const counted = users({ $where: { $exists: postCount } });
      const uncounted = users({ $where: { $empty: postCount } });
      for (const [document, reason] of /** @type {[any, string][]} */ ([
        [windowed, 'entity.notFlwor'], [counted, 'predicate.existence'], [uncounted, 'predicate.existence']])) {
        const explained = await store.explain(document);
        assert.equal(explained.mode, 'set');
        assert.equal(reasonOf(explained), reason);
        assert.deepEqual(await store.execute(document), engine(document));
      }
    });
    it('a $let read beyond `$count: $g[*]` stays a $let', async () => {
      for (const counted of ['$g[0]', '$g..[*]', '$g..title']) {
        const document = [{ $for: { it: '$.User[*]' }, $let: { g: [{ $for: { r1: '$.Post[*]' },
          $where: { $eq: ['$r1.authorId', '$it.id'] }, $return: '$r1' }] },
        $return: { id: '$it.id', n: { $count: counted } } }];
        const explained = await store.explain(document);
        assert.equal(explained.mode, 'set', counted);
        assert.equal(reasonOf(explained), 'kind.let', counted);
        assert.deepEqual(await store.execute(document), engine(document), counted);
      }
    });
    it('a hop used as a value without the key proof stays in the engine and raises what the engine raises', async () => {
      // two users are named `ada`, so the correlation on the name finds two items
      const document = [{ $for: { it: '$.Post[*]' }, $return: { pid: '$it.pid', age: {
        $for: { r1: '$.User[*]' }, $where: { $eq: ['$r1.name', '$it.title'] }, $return: '$r1.age' } } }];
      const explained = await store.explain(document);
      assert.equal(explained.mode, 'set');
      assert.equal(reasonOf(explained), 'entity.hopValue');
      await assert.rejects(async () => store.execute(document), { code: 'JQ2001' });
      await assert.rejects(async () => store.execute(document, { strict: true }), { code: 'JD0010' });
    });
    it('a hop key orders the unmatched row by the empty placement', async () => {
      await native(posts({ $orderby: [{ $key: hop('$r1.age'), $dir: 'desc' }, { $key: '$it.pid' }] }), [3, 1, 2, 4]);
    });
    it('the quantifiers answer a boolean', async () => {
      await native({ $every: { it: '$.Post[*]' }, $satisfies: { $gt: ['$it.stars', 0] } }, false);
      await native({ $some: { it: '$.Post[*]' }, $satisfies: { $gt: ['$it.stars', 4] } }, true);
      await native({ $every: { it: '$.Post[*]' }, $satisfies: { $ge: ['$it.pid', 1] } }, true);
      await native({ $some: { it: '$.Post[*]' }, $satisfies: { $gt: ['$it.stars', 5] } }, false);
    });
    it('a cursor over a hop plan and over a quantifier answers what execute answers', async () => {
      const documents = [posts({ $where: { $ge: [hop('$r1.age'), 30] } }),
        { $some: { it: '$.Post[*]' }, $satisfies: { $gt: ['$it.stars', 4] } }];
      for (const document of documents) {
        const items = [];
        for await (const item of store.entity('Post').cursor(document, { strict: true })) items.push(item);
        assert.deepEqual(items, [await store.execute(document, { strict: true })]);
      }
    });
    it('the order a hop key reports names the hop binding and the column it reads', async () => {
      const explained = await store.explain(posts({ $orderby: [{ $key: hop('$r1.age'), $dir: 'desc' }, { $key: '$it.pid' }] }));
      assert.deepEqual(explained.order.slice(0, 2).map((/** @type {any} */ { source, binding, column, desc }) =>
        ({ source, binding, column, desc })),
      [{ source: 'column', binding: 'r1', column: 'age', desc: true },
        { source: 'column', binding: 'it', column: 'pid', desc: false }]);
    });
    it('a to-one hop in the filter is one statement with the comparison inside its EXISTS', async () => {
      const explained = await store.explain(posts({ $where: { $ge: [hop('$r1.age'), 30] } }));
      assert.equal(explained.mode, 'native');
      const sql = explained.sql;
      const start = sql.search(/EXISTS \(SELECT 1 FROM (?:"[^"]+"\.)?"User"/);
      assert.notEqual(start, -1, sql);
      // the parenthesised subselect, matched by depth
      let depth = 0;
      let end = -1;
      for (let i = sql.indexOf('(', start); i < sql.length; i++) {
        if (sql[i] === '(') depth++;
        else if (sql[i] === ')' && --depth === 0) { end = i; break; }
      }
      const inner = sql.slice(start, end + 1);
      assert.match(inner, /"authorId"/, 'the correlation is inside the subselect');
      assert.match(inner, /"age" >= /, 'the comparison is inside the subselect');
      assert.equal((sql.match(/SELECT/g) ?? []).length, 2, 'one outer select and one subselect');
    });
  });
}

describe('correlated hops: the shapes without the proof stay in the engine, named', () => {
  const REFUSALS = /** @type {[string, any, string, any?][]} */ ([
    ['an inner ordering', posts({ $where: { $exists: { $for: { r1: '$.User[*]' },
      $where: { $eq: ['$r1.id', '$it.authorId'] }, $orderby: ['$r1.age'], $return: '$r1' } } }), 'entity.hopShape'],
    ['two hops chained', [{ $for: { it: '$.Post[*]' }, $return: { pid: '$it.pid', siblings: { $count: {
      $for: { r1: '$.User[*]' }, $where: { $eq: ['$r1.id', '$it.authorId'] },
      $return: { $for: { r2: '$.Post[*]' }, $where: { $eq: ['$r2.authorId', '$r1.id'] }, $return: '$r2' } } } } }],
    'entity.hopShape'],
    ['a correlation by an inequality', posts({ $where: { $exists: { $for: { r1: '$.User[*]' },
      $where: { $lt: ['$r1.age', '$it.stars'] }, $return: '$r1' } } }), 'entity.hopShape'],
    ['a to-many hop as an array member', [{ $for: { it: '$.User[*]' }, $return: { id: '$it.id', titles: [{
      $for: { r1: '$.Post[*]' }, $where: { $eq: ['$r1.authorId', '$it.id'] }, $return: '$r1.title' }] } }],
    'entity.hopValue'],
    ['a hop order key without the key proof', posts({ $orderby: [{ $key: {
      $for: { r1: '$.User[*]' }, $where: { $eq: ['$r1.name', '$it.title'] }, $return: '$r1.age' } }, { $key: '$it.pid' }] }),
    'entity.hopValue'],
    ['a count against an external', users({ $where: { $ge: [postCount, '$n'] } }), 'entity.external', { n: 2 }],
  ]);
  for (const host of HOSTS) {
    describe(host.name, () => {
      /** @type {any} */
      let store;
      before(async () => { store = await open(host, MODEL, DOCUMENTS); });
      after(async () => { await store.close(); });
      for (const [name, document, reason, externals] of REFUSALS) {
        it(`${name} is ${reason}`, async () => {
          const explained = await store.explain(document);
          assert.equal(explained.mode, 'set');
          assert.equal(reasonOf(explained), reason);
          await assert.rejects(async () => store.execute(document, { strict: true, externals }), (error) => {
            assert.equal(/** @type {any} */ (error).code, 'JD0010');
            assert.ok(/** @type {any} */ (error).message.includes(PLANNER_REASONS[reason].text));
            return true;
          });
          // the engine runs it: the store's residual is the engine's answer, and raises its codes
          let expected;
          try { expected = compileJsonQuery(document)(structuredClone(DOCUMENTS), externals); }
          catch (error) { expected = `throws ${/** @type {any} */ (error).code}`; }
          let actual;
          try { actual = await store.execute(document, { externals }); }
          catch (error) { actual = `throws ${/** @type {any} */ (error).code}`; }
          assert.deepEqual(actual, expected);
        });
      }
    });
  }
});

describe('correlated hops: the correlation must equate columns of one family that admit no null', () => {
  const FAMILY = {
    $model: '0.1',
    entities: {
      U: { schema: { type: 'object', required: ['id'], properties: { id: { type: 'integer', ...key } } } },
      P: { schema: { type: 'object', required: ['pid'], properties: {
        pid: { type: 'integer', ...key }, ref: { type: 'string' }, tag: { type: ['string', 'null'] } } } },
      Q: { schema: { type: 'object', required: ['qid'], properties: {
        qid: { type: 'integer', ...key }, tag: { type: ['string', 'null'] } } } },
    },
  };
  const FAMILY_DOCUMENTS = {
    U: [{ id: 1 }, { id: 2 }],
    P: [{ pid: 1, ref: '1', tag: null }, { pid: 2, ref: '2', tag: 'a' }, { pid: 3, ref: '9' }],
    Q: [{ qid: 1, tag: null }, { qid: 2, tag: 'a' }],
  };
  for (const host of HOSTS) {
    it(`a string foreign key against an integer key matches nothing, ${host.name}`, () => using(host, FAMILY, FAMILY_DOCUMENTS, async (store) => {
      const exists = [{ $for: { p: '$.P[*]' }, $where: { $exists: { $for: { u: '$.U[*]' },
        $where: { $eq: ['$u.id', '$p.ref'] }, $return: '$u' } }, $return: '$p.pid' }];
      const counted = [{ $for: { p: '$.P[*]' }, $return: { pid: '$p.pid', n: { $count: { $for: { u: '$.U[*]' },
        $where: { $eq: ['$u.id', '$p.ref'] }, $return: '$u' } } } }];
      for (const document of [exists, counted]) {
        const explained = await store.explain(document);
        assert.equal(explained.mode, 'set');
        assert.equal(reasonOf(explained), 'entity.hopShape');
        assert.deepEqual(await store.execute(document), compileJsonQuery(document)(structuredClone(FAMILY_DOCUMENTS)));
      }
      assert.deepEqual(await store.execute(exists), []);
      assert.deepEqual((await store.execute(counted)).map((/** @type {any} */ row) => row.n), [0, 0, 0]);
    }));
    it(`members that admit null never correlate natively, ${host.name}`, () => using(host, FAMILY, FAMILY_DOCUMENTS, async (store) => {
      const joined = [{ $for: { p: '$.P[*]' }, $where: { $exists: { $for: { q: '$.Q[*]' },
        $where: { $eq: ['$q.tag', '$p.tag'] }, $return: '$q' } }, $return: '$p.pid' }];
      const explained = await store.explain(joined);
      assert.equal(explained.mode, 'set');
      assert.equal(reasonOf(explained), 'entity.hopShape');
      // the engine answers over the documents the store holds: a `null` member
      // of a column is stored absent, so the two `null` tags pair with nothing
      const held = Object.fromEntries(await Promise.all(['U', 'P', 'Q'].map(async (name) =>
        [name, await store.execute([{ $for: { x: `$.${name}[*]` }, $return: '$x' }])])));
      assert.deepEqual(await store.execute(joined), compileJsonQuery(joined)(held));
      assert.deepEqual(await store.execute(joined), [2]);
    }));
  }
});

describe('correlated hops: a profile predicate narrows the related rows too', () => {
  // the user `u3` (age 8) and `u4` (no age) are outside the profile
  const profile = { predicates: { User: { $ge: ['$it.age', 30] } } };
  const DOCS = /** @type {[string, any][]} */ ([
    ['a hop comparison', posts({ $where: { $ne: [hop('$r1.name'), 'ada'] } })],
    ['an existing hop', posts({ $where: { $exists: hop('$r1') } })],
    ['an empty hop', posts({ $where: { $empty: hop('$r1') } })],
    ['a hop count', users({ $where: { $ge: [{ $count: { $for: { r1: '$.User[*]' }, $where: { $eq: ['$r1.name', '$it.name'] }, $return: '$r1' } }, 1] } })],
    ['a hop order key', posts({ $orderby: [{ $key: hop('$r1.name') }, { $key: '$it.pid' }] })],
    ['a hop leaf', [{ $for: { it: '$.Post[*]' }, $return: { pid: '$it.pid', by: hop('$r1.name') } }]],
    ['a root quantifier', { $some: { it: '$.Post[*]' }, $satisfies: { $eq: [hop('$r1.name'), 'mo'] } }],
    ['a quantifier over the narrowed entity', { $every: { it: '$.User[*]' }, $satisfies: { $ge: ['$it.age', 30] } }],
  ]);
  for (const host of HOSTS) {
    it(`every hop site wears the related entity's predicate, ${host.name}`, () => using(host, MODEL, DOCUMENTS, async (store) => {
      for (const [name, document] of DOCS) {
        const explained = await store.explain(document, { profile });
        assert.equal(explained.mode, 'native', `${name}: ${JSON.stringify(explained.reasons)}`);
        const narrowed = await store.execute(document, { profile, strict: true });
        assert.deepEqual(narrowed, await store.execute(document, { profile, pushdown: false }), name);
        // the profile changes the answer, so the case can tell a leak from a pass
        assert.notDeepEqual(narrowed, await store.execute(document, { pushdown: false }), name);
      }
    }));
  }
});

describe('correlated hops: a live query over a hop equals a fresh run after every write', () => {
  const WRITES = /** @type {((store: any) => Promise<any>)[]} */ ([
    // the related entity changes under a row that did not
    (store) => store.entity('User').update('u3', { age: 50 }),
    (store) => store.entity('Post').create({ pid: 5, title: 'late', stars: 4, authorId: 'u1' }),
    (store) => store.entity('User').update('u2', { name: 'lin2' }),
    (store) => store.entity('Post').update(4, { authorId: 'u2' }),
    (store) => store.entity('User').delete('u1'),
  ]);
  const LIVE = /** @type {[string, any][]} */ ([
    ['a hop in a filter', posts({ $where: { $ge: [hop('$r1.age'), 30] } })],
    ['a count in a filter', users({ $where: { $ge: [postCount, 1] } })],
    ['a hop leaf', [{ $for: { it: '$.Post[*]' }, $return: { pid: '$it.pid', by: hop('$r1.name') } }]],
    ['a hop key', posts({ $orderby: [{ $key: hop('$r1.age') }, { $key: '$it.pid' }] })],
    ['a quantifier', [{ $some: { it: '$.Post[*]' }, $satisfies: { $ge: [hop('$r1.age'), 60] } }]],
  ]);
  for (const [name, document] of LIVE) {
    it(`${name} re-runs, because it reads the related rows outside the join bindings`, async () => {
      const store = await openStore(MODEL, { driver: nodeDriver(), capture: true });
      try {
        for (const [entity, rows] of Object.entries(DOCUMENTS)) for (const row of rows) await store.entity(entity).create(row);
        assert.equal((await store.explain(document)).mode, 'native');
        const live = await store.live(document, { mode: 'auto' });
        const oracle = liveOracle(live, () => store.execute(document));
        try {
          assert.equal(live.mode.strategy, 'rerun');
          await oracle.check();
          for (const write of WRITES) {
            await write(store);
            await oracle.check();
          }
        }
        finally {
          oracle.close();
          live.close();
        }
      }
      finally { await store.close(); }
    });
  }
});

describe('correlated hops: adopted columns, whatever their codec and null policy', () => {
  for (const host of HOSTS) {
    it(`a hop that reaches no row leaves its member out, ${host.name}`, async () => {
      const { store, close } = await openAdopted(await adoptedHost(host), leafWorld);
      try {
        const queries = leafQueries();
        const plain = await checkAdoptedHops(store, ['A', 'B'], queries);
        assert.deepEqual(plain.problems, []);
        // PostgreSQL keeps a column that holds a present `null` in the engine
        assert.ok(plain.native >= (host.pg ? 60 : 110), `${plain.native} of ${queries.length} plan native`);
        // the related row a profile hides is a row the hop does not reach either
        const hidden = await checkAdoptedHops(store, ['A', 'B'], queries, { profile: HIDING_PROFILE, visible: hidesFirst });
        assert.deepEqual(hidden.problems, []);
        assert.equal(hidden.native, plain.native);
      }
      finally { await close(); }
    });
    it(`the leaf answers the engine's members, ${host.name}`, async () => {
      const { store, close } = await openAdopted(await adoptedHost(host), leafWorld);
      try {
        const leaf = (/** @type {string} */ name) => [{ $for: { it: '$.B[*]' }, $return: { id: '$it.bid', v: {
          $for: { a: '$.A[*]' }, $where: { $eq: ['$a.aid', '$it.aref'] }, $return: `$a.${name}` } } }];
        // a dangling key (3) and a NULL key (4) reach no row; row 2 of A holds a NULL where the policy allows one
        assert.deepEqual(await store.execute(leaf('integer_reject'), { strict: true }),
          [{ id: 1, v: 5 }, { id: 2, v: 6 }, { id: 3 }, { id: 4 }, { id: 5, v: 7 }]);
        assert.deepEqual(await store.execute(leaf('integer_absent')),
          [{ id: 1, v: 5 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5, v: 7 }]);
        assert.deepEqual(await store.execute(leaf('integer_null')),
          [{ id: 1, v: 5 }, { id: 2, v: null }, { id: 3 }, { id: 4 }, { id: 5, v: 7 }]);
        assert.deepEqual(await store.execute(leaf('text_reject'), { profile: HIDING_PROFILE }),
          [{ id: 1 }, { id: 2, v: 'y' }, { id: 3 }, { id: 4 }, { id: 5, v: 'z' }]);
      }
      finally { await close(); }
    });
  }
  it('a NULL that a rejecting column holds is refused through a hop as it is everywhere', async () => {
    // the table does not forbid the NULL its policy rejects: the hop that reads it raises, native or not
    const model = { $model: '0.1', entities: {
      A: { schema: { type: 'object', properties: { aid: { type: 'integer', ...key }, v: { type: 'integer' } } },
        physical: { table: 'a', columns: { aid: { name: 'aid', codec: 'integer', null: 'reject' }, v: { name: 'v', codec: 'integer', null: 'reject' } } } },
      B: { schema: { type: 'object', properties: { bid: { type: 'integer', ...key }, aref: { type: 'integer' } } },
        physical: { table: 'b', columns: { bid: { name: 'bid', codec: 'integer', null: 'reject' }, aref: { name: 'aref', codec: 'integer', null: 'absent' } } } },
    } };
    const dir = mkdtempSync(join(tmpdir(), 'jaren-hops-'));
    const path = join(dir, 'rejecting.sqlite');
    const db = await nodeDriver().open(path);
    db.exec(`CREATE TABLE a(aid INTEGER PRIMARY KEY, v INTEGER); CREATE TABLE b(bid INTEGER PRIMARY KEY, aref INTEGER);
      INSERT INTO a VALUES (1, 5), (2, NULL); INSERT INTO b VALUES (1, 1), (2, 2), (3, 9)`);
    db.close();
    const store = await openStore(model, { driver: nodeDriver(), path, adopt: true });
    try {
      const document = [{ $for: { it: '$.B[*]' }, $return: { id: '$it.bid', v: {
        $for: { a: '$.A[*]' }, $where: { $eq: ['$a.aid', '$it.aref'] }, $return: '$a.v' } } }];
      assert.equal((await store.explain(document)).mode, 'native');
      await assert.rejects(async () => store.execute(document, { strict: true }), { code: 'JD2003' });
      await assert.rejects(async () => store.execute(document, { pushdown: false }), { code: 'JD2003' });
    }
    finally {
      await store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('correlated hops: a correlation over a column that can hold a null', () => {
  for (const host of HOSTS) {
    it(`never pairs in SQL, whatever the schema says, ${host.name}`, async () => {
      const { store, close } = await openAdopted(await adoptedHost(host), nullPolicyWorld);
      try {
        const checked = await checkAdoptedHops(store, ['C', 'D'], nullPolicyQueries());
        assert.deepEqual(checked.problems, []);
        // the policy alone says a NULL is a `null`: the engine pairs it with a `null`, SQL with nothing
        assert.deepEqual([...checked.planned].filter(([, plan]) => plan.mode !== 'set' || plan.reason !== 'entity.hopShape')
          .map(([name]) => name), []);
      }
      finally { await close(); }
    });
  }
});

describe('correlated hops: the proof that a hop reaches one row reads the related entity\'s side only', () => {
  // `Y` has a column named like the key of `X`, and the correlation equates it with a member of `X` that is no key
  const KEYED = {
    $model: '0.1',
    entities: {
      X: { schema: { type: 'object', required: ['id'], properties: { id: { type: 'string', ...key }, tag: { type: 'string' } } } },
      Y: { schema: { type: 'object', required: ['yid'], properties: { yid: { type: 'integer', ...key }, id: { type: 'string' } } } },
    },
  };
  const KEYED_DOCUMENTS = {
    X: [{ id: 'x1', tag: 'k' }, { id: 'x2', tag: 'k' }, { id: 'x3', tag: 'm' }],
    Y: [{ yid: 1, id: 'k' }, { yid: 2, id: 'm' }, { yid: 3, id: 'zz' }],
  };
  for (const host of HOSTS) {
    it(`two rows reached keep the engine's error, ${host.name}`, () => using(host, KEYED, KEYED_DOCUMENTS, async (store) => {
      const document = [{ $for: { y: '$.Y[*]' }, $return: { yid: '$y.yid', found: {
        $for: { x: '$.X[*]' }, $where: { $eq: ['$x.tag', '$y.id'] }, $return: '$x.id' } } }];
      const explained = await store.explain(document);
      assert.equal(explained.mode, 'set');
      assert.equal(reasonOf(explained), 'entity.hopValue');
      await assert.rejects(async () => store.execute(document), { code: 'JQ2001' });
    }));
  }
});

describe('correlated hops: a profile that refuses a full-table scan sees the scan inside a hop', () => {
  // one outer row by its key, and a related table with no index on the correlated column
  const SCANNED = {
    $model: '0.1',
    entities: {
      U: { schema: { type: 'object', required: ['id'], properties: { id: { type: 'string', ...key }, name: { type: 'string' } } } },
      P: { schema: { type: 'object', required: ['pid'], properties: { pid: { type: 'integer', ...key }, authorName: { type: 'string' } } } },
    },
  };
  const SCANNED_DOCUMENTS = {
    U: Array.from({ length: 12 }, (_, i) => ({ id: `u${i + 1}`, name: `n${i % 4}` })),
    P: Array.from({ length: 40 }, (_, i) => ({ pid: i + 1, authorName: `n${i % 4}` })),
  };
  const profile = { refuseFullScan: true, maxRows: 100 };
  const hopped = [{ $for: { u: '$.U[*]' }, $where: { $and: [{ $eq: ['$u.id', 'u7'] }, { $exists: {
    $for: { p: '$.P[*]' }, $where: { $eq: ['$p.authorName', '$u.name'] }, $return: '$p' } }] }, $return: '$u.id' }];
  const joined = [{ $for: { u: '$.U[*]', p: '$.P[*]' }, $where: { $and: [{ $eq: ['$u.id', 'u7'] },
    { $eq: ['$p.authorName', '$u.name'] }] }, $return: '$u.id' }];
  it('SQLite refuses the hop as it refuses the join', async () => {
    // the planner may otherwise build an index for the probe, and the scan is gone
    const raw = new DatabaseSync(':memory:');
    raw.exec('PRAGMA automatic_index = OFF');
    const db = await adaptNodeDatabase({ exec: (sql) => raw.exec(sql), close: () => raw.close(), prepare: (sql) => raw.prepare(sql) });
    const store = await openStore(SCANNED, { driver: { ...nodeDriver(), open: async () => db } });
    try {
      for (const [name, rows] of Object.entries(SCANNED_DOCUMENTS)) for (const row of rows) await store.entity(name).create(row);
      await assert.rejects(async () => store.execute(joined, { profile }), { code: 'JD0011' });
      await assert.rejects(async () => store.execute(hopped, { profile }), { code: 'JD0011' });
      assert.deepEqual(await store.execute(hopped, { pushdown: false }), ['u7']);
    }
    finally { await store.close(); }
  });
  for (const host of HOSTS.filter((entry) => entry.pg)) {
    it(`PostgreSQL refuses the hop as it refuses the join, ${host.name}`, () => using(host, SCANNED, SCANNED_DOCUMENTS, async (store) => {
      await assert.rejects(async () => store.execute(joined, { profile }), { code: 'JD0011' });
      await assert.rejects(async () => store.execute(hopped, { profile }), { code: 'JD0011' });
    }));
  }
});

describe('correlated hops: adopted tables with a composite key', () => {
  /** @param {string | undefined} schema */
  const adopted = (schema) => ({ $model: '0.1', entities: {
    Line: { schema: { type: 'object', properties: {
      acct: { type: 'string', ...key }, seq: { type: 'string', ...key }, qty: { type: 'integer' } } },
    physical: { ...(schema === undefined ? {} : { schema }), table: 'lines', keys: ['acct', 'seq'], columns: {
      acct: { name: 'acct', codec: 'text', null: 'reject' }, seq: { name: 'seq', codec: 'text', null: 'reject' },
      qty: { name: 'qty', codec: 'integer', null: 'absent' } } } },
    Entry: { schema: { type: 'object', properties: {
      eid: { type: 'integer', ...key }, acct: { type: 'string' }, seq: { type: 'string' }, memo: { type: 'string' } } },
    physical: { ...(schema === undefined ? {} : { schema }), table: 'entries', columns: {
      eid: { name: 'eid', codec: 'integer', null: 'reject' }, acct: { name: 'acct', codec: 'text', null: 'absent' },
      seq: { name: 'seq', codec: 'text', null: 'absent' }, memo: { name: 'memo', codec: 'text', null: 'absent' } } } },
  } });
  const ROWS = `INSERT INTO lines VALUES ('a','1',5),('a','2',NULL),('b','1',7);
    INSERT INTO entries VALUES (1,'a','1','m1'),(2,'a','2','m2'),(3,'b','9','m3'),(4,NULL,NULL,'m4'),(5,'b','1','m5')`;
  const root = {
    Line: [{ acct: 'a', seq: '1', qty: 5 }, { acct: 'a', seq: '2' }, { acct: 'b', seq: '1', qty: 7 }],
    Entry: [{ eid: 1, acct: 'a', seq: '1', memo: 'm1' }, { eid: 2, acct: 'a', seq: '2', memo: 'm2' },
      { eid: 3, acct: 'b', seq: '9', memo: 'm3' }, { eid: 4, memo: 'm4' }, { eid: 5, acct: 'b', seq: '1', memo: 'm5' }],
  };
  const line = (/** @type {any} */ where, /** @type {string} */ member) =>
    ({ $for: { r1: '$.Line[*]' }, $where: where, $return: member });
  const both = { $and: [{ $eq: ['$r1.acct', '$it.acct'] }, { $eq: ['$r1.seq', '$it.seq'] }] };
  const byAccount = { $eq: ['$r1.acct', '$it.acct'] };
  const entries = (/** @type {any} */ extra, ret = '$it.eid') => [{ $for: { it: '$.Entry[*]' }, ...extra, $return: ret }];
  /** @type {[string, any, string | null][]} the document, and the reason it stays in the engine */
  const CASES = [
    ['an existence over the whole key', entries({ $where: { $exists: line(both, '$r1') } }), null],
    ['a comparison over the whole key', entries({ $where: { $ge: [line(both, '$r1.qty'), 6] } }), null],
    ['a leaf over the whole key', entries({}, { eid: '$it.eid', qty: line(both, '$r1.qty') }), null],
    ['an order key over the whole key', entries({ $orderby: [{ $key: line(both, '$r1.qty'), $dir: 'desc' }, { $key: '$it.eid' }] }), null],
    ['a count over part of the key', entries({ $where: { $ge: [{ $count: line(byAccount, '$r1') }, 2] } }), null],
    ['a leaf over part of the key', entries({}, { eid: '$it.eid', qty: line(byAccount, '$r1.qty') }), 'entity.hopValue'],
    ['a quantifier', { $some: { it: '$.Line[*]' }, $satisfies: { $gt: ['$it.qty', 6] } }, null],
  ];
  for (const host of HOSTS) {
    it(`the key is proven from the declared columns, ${host.name}`, async () => {
      /** @type {any} */
      let store;
      /** @type {string | undefined} */
      let dir;
      if (host.pg) {
        counter += 1;
        const schema = `jaren_hops_${process.pid}_${counter}`;
        await admin.query(`CREATE SCHEMA "${schema}"`);
        schemas.push(schema);
        await admin.query(`CREATE TABLE "${schema}".lines(acct text NOT NULL, seq text NOT NULL, qty integer, PRIMARY KEY (acct, seq));
          CREATE TABLE "${schema}".entries(eid integer PRIMARY KEY, acct text, seq text, memo text); ${ROWS.replaceAll('INTO lines', `INTO "${schema}".lines`).replaceAll('INTO entries', `INTO "${schema}".entries`)}`);
        store = await openStore(adopted(schema), { driver: postgresDriver(pool, { schema }), adopt: true });
      }
      else {
        dir = mkdtempSync(join(tmpdir(), 'jaren-hops-'));
        const path = join(dir, 'adopted.sqlite');
        const db = await nodeDriver().open(path);
        db.exec(`CREATE TABLE lines(acct TEXT NOT NULL, seq TEXT NOT NULL, qty INTEGER, PRIMARY KEY (acct, seq)) WITHOUT ROWID;
          CREATE TABLE entries(eid INTEGER PRIMARY KEY, acct TEXT, seq TEXT, memo TEXT); ${ROWS}`);
        db.close();
        store = await openStore(adopted(undefined), { driver: nodeDriver(), path, adopt: true });
      }
      try {
        for (const [name, document, reason] of CASES) {
          const explained = await store.explain(document);
          assert.equal(explained.mode, reason === null ? 'native' : 'set', `${name}: ${JSON.stringify(explained.reasons)}`);
          if (reason !== null) assert.equal(reasonOf(explained), reason, name);
          assert.deepEqual(await store.execute(document), compileJsonQuery(document)(structuredClone(root)), name);
        }
      }
      finally {
        await store.close();
        if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});

describe('correlated hops: a declared join table is a related entity too', () => {
  const group = loadRelationGroups().find((entry) => entry.group === 'join-table roots');
  const memberships = (/** @type {string} */ ret, /** @type {string} */ owner = '$m.Person_key') =>
    ({ $for: { m: '$.Person_Tag[*]' }, $where: { $eq: [owner, '$it.id'] }, $return: ret });
  const person = (/** @type {string} */ ret) =>
    ({ $for: { p: '$.Person[*]' }, $where: { $eq: ['$p.id', '$it.Person_key'] }, $return: ret });
  const DOCUMENTS_OF = /** @type {[string, any][]} */ ([
    ['an existence over the memberships', [{ $for: { it: '$.Person[*]' }, $where: { $exists: memberships('$m') }, $return: '$it.id' }]],
    ['an emptiness over the memberships', [{ $for: { it: '$.Person[*]' }, $where: { $empty: memberships('$m') }, $return: '$it.id' }]],
    ['a member of the memberships', [{ $for: { it: '$.Person[*]' }, $where: { $eq: [memberships('$m.Tag_key'), 'red'] }, $return: '$it.id' }]],
    ['a count of the memberships', [{ $for: { it: '$.Person[*]' }, $return: { id: '$it.id', n: { $count: memberships('$m') } } }]],
    ['the owner read from a membership', [{ $for: { it: '$.Person_Tag[*]' }, $orderby: ['$it.Person_key', '$it.Tag_key'],
      $return: { tag: '$it.Tag_key', who: person('$p.name') } }]],
    ['the owner as an order key of a membership', [{ $for: { it: '$.Person_Tag[*]' },
      $orderby: [{ $key: person('$p.name'), $dir: 'desc' }, '$it.Tag_key'], $return: '$it.Tag_key' }]],
    ['a quantifier over the memberships', { $every: { it: '$.Person_Tag[*]' }, $satisfies: { $eq: ['$it.Tag_key', 'red'] } }],
  ]);
  for (const host of HOSTS) {
    it(`each shape is one statement that answers the engine's, ${host.name}`, async () => {
      assert.ok(group);
      const { store } = await storeForEntityGroup(group, await driverFor(host));
      try {
        const root = { ...group.documents, ...group.memberships };
        for (const [name, document] of DOCUMENTS_OF) {
          const explained = await store.explain(document);
          assert.equal(explained.mode, 'native', `${name}: ${JSON.stringify(explained.reasons)}`);
          assert.deepEqual(await store.execute(document, { strict: true }),
            compileJsonQuery(document)(structuredClone(root)), name);
        }
      }
      finally { await store.close(); }
    });
  }
});

describe('correlated hops: the corpus group', () => {
  const RESIDUAL = /** @type {Record<string, string>} */ ({
    'a hop returning the binding, compared with a number': 'predicate.operands',
    'a count compared with an external': 'entity.external',
    'a hop ordering over a member of two types': 'entity.order',
    'a hop ordering without the key proof': 'entity.hopValue',
    'a hop ordering over the binding': 'entity.hopValue',
    'an ordering by a count': 'entity.order',
    'a hop leaf without the key proof': 'entity.hopValue',
    'a to-many hop as an array member': 'entity.hopValue',
    'a hop leaf returning the binding': 'entity.hopValue',
    'two hops chained': 'entity.hopShape',
    'a hop with an inner ordering': 'entity.hopShape',
    'a hop that is not correlated': 'entity.conjunctBinding',
    'a hop correlated by an inequality': 'entity.hopShape',
    'a hop over a string foreign key and an integer key': 'entity.hopShape',
    'a count over a string foreign key and an integer key': 'entity.hopShape',
    'a hop whose correlation admits null on the outer side': 'entity.hopShape',
    'a hop whose correlation admits null on the inner side': 'entity.hopShape',
    'a group join read beyond its count': 'kind.let',
    "a hop from a group join's fanned group": 'kind.let',
    'a sum over a hop leaf': 'entity.scalarAggregate',
    'a hop in a join, correlated with both bindings': 'entity.conjunctBinding',
  });
  /** The grouping hop: native on SQLite; PostgreSQL runs every entity grouping in the engine. */
  const GROUPED = 'a hop beneath a grouping';
  const group = loadRelationGroups().find((entry) => entry.group === '24 correlated hops');

  it('names every case, and only cases that exist', () => {
    assert.ok(group);
    const names = new Set(group.cases.map((kase) => kase.name));
    for (const name of Object.keys(RESIDUAL)) assert.ok(names.has(name), name);
    assert.ok(names.has(GROUPED));
  });
  for (const host of HOSTS) {
    for (const side of /** @type {const} */ (['indexed', 'unindexed'])) {
      it(`every case plans as claimed, and the native ones answer under strict mode, ${host.name} ${side}`, async () => {
        assert.ok(group);
        const { store } = await storeForEntityGroup(group, await driverFor(host), side);
        try {
          for (const kase of group.cases) {
            const expectedReason = kase.name === GROUPED ? (host.pg ? 'bind.entityGrouping' : undefined) : RESIDUAL[kase.name];
            const explained = await store.explain(kase.query);
            if (expectedReason === undefined) {
              assert.equal(explained.mode, 'native', `${kase.name}: ${JSON.stringify(explained.reasons)}`);
              const expected = compileJsonQuery(kase.query)(structuredClone(group.documents), kase.externals);
              assert.deepEqual(await store.execute(kase.query, { externals: kase.externals, strict: true }),
                expected, kase.name);
            }
            else {
              assert.equal(explained.mode, 'set', kase.name);
              assert.equal(reasonOf(explained), expectedReason, kase.name);
              await assert.rejects(async () => store.execute(kase.query, { externals: kase.externals, strict: true }),
                { code: 'JD0010' }, kase.name);
            }
          }
        }
        finally { await store.close(); }
      });
    }
  }
});

if (url) {
  describe('correlated hops: the predicate term bound counts a hop\'s inner leaves (PostgreSQL)', () => {
    /** The dialect's bound on the leaf predicates one statement carries. */
    const BOUND = 128;
    /** An inner filter of `count` inequalities on the author's age, none of which regroups. @param {number} count */
    const inner = (count) => ({ $and: [{ $eq: ['$r1.id', '$it.authorId'] },
      ...Array.from({ length: count }, (_, i) => ({ $ne: ['$r1.age', i + 1000] }))] });
    /** @param {number} count */
    const bounded = (count) => posts({ $where: { $exists: { $for: { r1: '$.User[*]' }, $where: inner(count), $return: '$r1' } } });

    it('128 inner leaves stay native, 129 run in the engine with the same answer', () => using(HOSTS[1], MODEL, DOCUMENTS, async (store) => {
      const within = await store.explain(bounded(128));
      assert.equal(within.mode, 'native', JSON.stringify(within.reasons));
      const above = await store.explain(bounded(129));
      assert.equal(above.mode, 'set');
      assert.equal(reasonOf(above), 'predicate.termBound');
      await assert.rejects(async () => store.execute(bounded(129), { strict: true }), { code: 'JD0010' });
      assert.deepEqual(await store.execute(bounded(129)), await store.execute(bounded(129), { pushdown: false }));
      assert.deepEqual(await store.execute(bounded(128), { strict: true }), [1, 3]);
    }));
    it('a value leaf counts its filter twice, the statement reads it for the value and for the type', () => using(HOSTS[1], MODEL, DOCUMENTS, async (store) => {
      /** @param {number} count */
      const leaf = (count) => [{ $for: { it: '$.Post[*]' }, $return: { pid: '$it.pid', by: {
        $for: { r1: '$.User[*]' }, $where: inner(count), $return: '$r1.name' } } }];
      const within = await store.explain(leaf(BOUND / 2));
      assert.equal(within.mode, 'native', JSON.stringify(within.reasons));
      const above = await store.explain(leaf(BOUND / 2 + 1));
      assert.equal(above.mode, 'set');
      assert.equal(reasonOf(above), 'predicate.termBound');
      assert.deepEqual(await store.execute(leaf(BOUND / 2 + 1)), await store.execute(leaf(BOUND / 2 + 1), { pushdown: false }));
      // the filter's `$ne` literals are one negated list, which the statement reads for the value and for the type
      assert.equal((within.sql.match(/<>/g) ?? []).length, 0);
      assert.equal((within.sql.match(/NOT \("h\d"\."age" IS NOT NULL AND "h\d"\."age" IN \(SELECT/g) ?? []).length, 2,
        'the statement carries the filter the bound counted twice');
    }));
    it('an order key counts its filter once', () => using(HOSTS[1], MODEL, DOCUMENTS, async (store) => {
      /** @param {number} count */
      const keyed = (count) => posts({ $orderby: [{ $key: { $for: { r1: '$.User[*]' }, $where: inner(count), $return: '$r1.name' } },
        { $key: '$it.pid' }] });
      assert.equal((await store.explain(keyed(BOUND))).mode, 'native');
      const above = await store.explain(keyed(BOUND + 1));
      assert.equal(above.mode, 'set');
      assert.equal(reasonOf(above), 'predicate.termBound');
      assert.deepEqual(await store.execute(keyed(BOUND + 1)), await store.execute(keyed(BOUND + 1), { pushdown: false }));
    }));
    it('a profile predicate is read twice by a value leaf and counts twice', () => using(HOSTS[1], MODEL, DOCUMENTS, async (store) => {
      const profileOf = (/** @type {number} */ count) => ({ predicates: { User: { $and: Array.from({ length: count }, (_, i) => ({ $ne: ['$it.age', i + 1000] })) } } });
      const leaf = [{ $for: { it: '$.Post[*]' }, $return: { pid: '$it.pid', by: hop('$r1.name') } }];
      assert.equal((await store.explain(leaf, { profile: profileOf(BOUND / 2) })).mode, 'native');
      const above = await store.explain(leaf, { profile: profileOf(BOUND / 2 + 1) });
      assert.equal(above.mode, 'set');
      assert.equal(reasonOf(above), 'predicate.termBound');
    }));
    it('a profile predicate counts once for every hop that wears it', () => using(HOSTS[1], MODEL, DOCUMENTS, async (store) => {
      const profile = { predicates: { User: { $and: Array.from({ length: 70 }, (_, i) => ({ $ne: ['$it.age', i + 1000] })) } } };
      const one = posts({ $where: { $exists: hop('$r1') } });
      const two = posts({ $where: { $and: [{ $exists: hop('$r1') }, { $exists: hop('$r1.name') }] } });
      assert.equal((await store.explain(one, { profile })).mode, 'native');
      const explained = await store.explain(two, { profile });
      assert.equal(explained.mode, 'set');
      assert.equal(reasonOf(explained), 'predicate.termBound');
    }));
  });
}
