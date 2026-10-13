//@ts-check
/**
 * @file Grouping the rows of a join of entity arrays. A connected join groups
 * in one statement on SQLite: the join is a derived table that numbers its
 * rows in the engine's nested-loop order (each binding's row identity, in
 * binding order), and the groups come out by the number of their first row,
 * which is the engine's order of first appearance. Keys and aggregates read
 * either binding. On PostgreSQL the runtime guards of an entity grouping are
 * qualified for one adopted table alone, so a join of any layout is grouped
 * by the engine, under a name. The answer is the engine's whichever host
 * computes it; a grouping the proof does not reach stays in the engine under
 * the reason it always had.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { openStore, reasonId } from '@jarenjs/db';
import { nodeDriver, adaptNodeDatabase } from '@jarenjs/db/node';
import { postgresDriver } from '@jarenjs/db/postgres';

import { loadRelationGroups, storeForEntityGroup, runEntityCase } from './oracle/harness.js';
import { liveOracle } from './oracle/replication.js';
import { openNullPolicy } from './oracle/typed-paths.js';
import { onBothEngines, onBothEnginesPhysical } from './query-core-engines.js';

const URL = process.env.JAREN_PG_URL;

/** @param {string} name */
const groupNamed = (name) => {
  const group = loadRelationGroups().find((entry) => entry.group === name);
  assert.ok(group, name);
  return group;
};
/** @param {any} group @param {string} name */
const caseOf = (group, name) => {
  const found = group.cases.find((/** @type {any} */ entry) => entry.name === name);
  assert.ok(found, name);
  return found;
};
/** @param {any} store @param {Record<string, any[]>} documents */
async function seed(store, documents) {
  for (const [name, rows] of Object.entries(documents)) for (const row of rows) await store.entity(name).create(row);
}
/** The reason id a residual `explain()` names first. @param {any} explained */
const reasonOf = (explained) => reasonId(explained.residual.reasons[0].reason);

let schemas = 0;
/**
 * Run `fn` once per available host with a way to open a driver of it: SQLite in
 * memory, and PostgreSQL in schemas of its own (a pool of two, every schema
 * dropped afterwards) when `JAREN_PG_URL` names an endpoint.
 * @param {(host: 'sqlite' | 'postgres', driverOf: () => Promise<any>) => Promise<void>} fn
 */
async function onHosts(fn) {
  await fn('sqlite', async () => nodeDriver());
  if (!URL) return;
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: URL, max: 2 });
  /** @type {string[]} */
  const made = [];
  try {
    await fn('postgres', async () => {
      const schema = `group_joins_${process.pid}_${++schemas}`;
      await pool.query(`CREATE SCHEMA "${schema}"`);
      made.push(schema);
      return postgresDriver(pool, { schema });
    });
  }
  finally {
    for (const schema of made) await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  }
}

const JOINS = '34 entity group joins';
const TYPES = '35 entity group joins over three bindings';
const THROUGH_TABLE = '36 entity group joins through a join table';

/** The groups the engine forms over the join of users and posts, written out so that agreeing with it is not agreeing on a mistake. */
const STATED = new Map(/** @type {[string, any][]} */ ([
  ['count per parent, the parent bound first', [{ who: 'u2', n: 3 }, { who: 'u1', n: 2 }]],
  ['count per parent, the child bound first', [{ who: 'u1', n: 2 }, { who: 'u2', n: 3 }]],
  ["the parent's age summed by the child's stars", [{ n: 1, a: 3 }, { s: 4, n: 2, a: 8 }, { s: 1, n: 1, a: 3 }, { s: 7, n: 1, a: 5 }]],
  ["extremes and mean of the child's stars by the parent's name", [{ who: 'a', top: 7, avg: 5.5 }, { who: 'b', top: 4, avg: 2.5 }]],
]));

/** Why the cases the proof does not reach stay in the engine, by corpus group. */
const KEPT = new Map([
  ["an ordered grouping over a join is the engine's", 'entity.projection'],
  ["a window over the groups of a join is the engine's", 'entity.projection'],
  ["a floating sum over a join is the engine's", 'entity.projection'],
  ["a floating mean over a join is the engine's", 'entity.projection'],
  ['a binding with no equality to the others is a product, and the engine groups it', 'entity.joinKey'],
  ["a return reading the whole binding is the engine's", 'entity.projection'],
  ["the nullable form of a sum over the first binding of a join is the engine's", 'entity.projection'],
  ["the nullable form of a sum over a join is the engine's", 'entity.projection'],
  ["a floating mean over three bindings is the engine's", 'entity.projection'],
  ["an ordered grouping over three bindings is the engine's", 'entity.projection'],
  ['a third binding nothing connects is a product, and the engine groups it', 'entity.joinKey'],
]);
/** The cases planned native whose rows hold a group past the exactness bound: the run answers from the engine. */
const PAST_THE_BOUND = new Set([
  "a parent's value repeated by its children passes the exactness bound",
  "a parent's value repeated by its children, averaged",
]);

describe('a grouping over a join of entity arrays', () => {
  it('answers the groups the engine forms, in the order it meets them, from one statement', async () => {
    const group = groupNamed(JOINS);
    await onBothEngines(group.model, async (store, host) => {
      await seed(store, group.documents);
      for (const [name, answer] of STATED) {
        const label = `${host}: ${name}`;
        const query = caseOf(group, name).query;
        const explained = await store.explain(query);
        if (host === 'sqlite') {
          assert.equal(explained.mode, 'native', label);
          assert.ok(explained.sql.includes('ROW_NUMBER() OVER (ORDER BY "t0"."rowid", "t1"."rowid") AS "_rn"'), `${label}: ${explained.sql}`);
          assert.ok(explained.sql.endsWith('GROUP BY "vk0", "tk0" ORDER BY MIN("_rn")'), `${label}: ${explained.sql}`);
          assert.deepEqual(await store.execute(query, { strict: true }), answer, label);
        }
        else {
          assert.equal(explained.mode, 'set', label);
          assert.equal(reasonOf(explained), 'bind.entityGrouping', label);
          assert.deepEqual(await store.execute(query), answer, label);
        }
        assert.deepEqual(await store.execute(query, { pushdown: false }), answer, `${label} (engine)`);
      }
    });
  });

  for (const name of [JOINS, TYPES, THROUGH_TABLE]) {
    it(`${name}: every case is planned as its reason says, and answers the engine's`, async () => {
      const group = groupNamed(name);
      const root = { ...group.documents, ...(group.memberships ?? {}) };
      await onHosts(async (host, driverOf) => {
        for (const side of /** @type {const} */ (['indexed', 'unindexed'])) {
          const { store } = await storeForEntityGroup(group, await driverOf(), side);
          try {
            for (const kase of group.cases) {
              const label = `${host} ${side}: ${kase.name}`;
              const kept = KEPT.get(kase.name) ?? (host === 'postgres' ? 'bind.entityGrouping' : undefined);
              const explained = await store.explain(kase.query, { externals: kase.externals });
              if (kept === undefined) assert.equal(explained.mode, 'native', label);
              else {
                assert.equal(explained.mode, 'set', label);
                assert.equal(reasonOf(explained), kept, label);
              }
              assert.equal(await runEntityCase(store, root, kase, 'native'), null, label);
              assert.equal(await runEntityCase(store, root, kase, 'residual'), null, `${label} (engine)`);
              if (host === 'sqlite' && PAST_THE_BOUND.has(kase.name)) {
                const after = await store.explain(kase.query, { externals: kase.externals });
                assert.equal(after.mode, 'set', label);
                assert.equal(reasonOf(after), 'bind.accumulation', label);
              }
            }
          }
          finally { await store.close(); }
        }
      });
    });
  }
});

/** Two adopted tables with compound keys, each read in key order. */
const JOINED_DDL = (/** @type {string} */ prefix) => `CREATE TABLE ${prefix}a (k1 integer NOT NULL, k2 integer NOT NULL, g text NOT NULL, PRIMARY KEY (k1, k2));
  CREATE TABLE ${prefix}b (j1 integer NOT NULL, j2 integer NOT NULL, r1 integer NOT NULL, r2 integer NOT NULL, w integer, PRIMARY KEY (j1, j2));
  INSERT INTO ${prefix}a VALUES (1,9,'A'),(2,0,'A'),(1,5,'B'),(3,3,'B');
  INSERT INTO ${prefix}b VALUES (1,1,1,9,10),(1,2,2,0,20),(2,1,1,5,30),(2,2,3,3,40),(3,1,1,9,50)`;
const joinedModel = (/** @type {string | null} */ schema) => ({ $model: '0.1', entities: {
  A: {
    schema: { type: 'object', properties: {
      k1: { type: 'integer', 'x-entity': { key: true } }, k2: { type: 'integer', 'x-entity': { key: true } }, g: { type: 'string' } } },
    physical: { ...(schema === null ? {} : { schema }), table: 'a', keys: ['k1', 'k2'], columns: {
      k1: { name: 'k1', codec: 'integer', null: 'reject' }, k2: { name: 'k2', codec: 'integer', null: 'reject' },
      g: { name: 'g', codec: 'text', null: 'reject' } } },
  },
  B: {
    schema: { type: 'object', properties: {
      j1: { type: 'integer', 'x-entity': { key: true } }, j2: { type: 'integer', 'x-entity': { key: true } },
      r1: { type: 'integer' }, r2: { type: 'integer' }, w: { type: 'integer' } } },
    physical: { ...(schema === null ? {} : { schema }), table: 'b', keys: ['j1', 'j2'], columns: {
      j1: { name: 'j1', codec: 'integer', null: 'reject' }, j2: { name: 'j2', codec: 'integer', null: 'reject' },
      r1: { name: 'r1', codec: 'integer', null: 'reject' }, r2: { name: 'r2', codec: 'integer', null: 'reject' },
      w: { name: 'w', codec: 'integer', null: 'absent' } } },
  },
} });

describe('a join that is not grouped', () => {
  it('orders its rows by every binding\'s identity, in binding order', async () => {
    const group = groupNamed(JOINS);
    await onBothEngines(group.model, async (store, host) => {
      await seed(store, group.documents);
      const query = { $for: { u: '$.User[*]', p: '$.Post[*]' }, $where: { $eq: ['$p.authorId', '$u.id'] }, $return: '$p.pid' };
      const { sql } = await store.explain(query);
      const tail = host === 'sqlite' ? 'ORDER BY "t0"."rowid", "t1"."rowid"' : 'ORDER BY "t0"."rid", "t1"."rid"';
      assert.ok(sql.endsWith(tail), `${host}: ${sql}`);
      assert.deepEqual(await store.execute(query), [2, 3, 6, 1, 4], host);
    });
  });

  it('orders the rows of adopted tables by every key column of each', async () => {
    await onBothEnginesPhysical(joinedModel, JOINED_DDL, async (store, host) => {
      const query = { $for: { a: '$.A[*]', b: '$.B[*]' },
        $where: { $and: [{ $eq: ['$b.r1', '$a.k1'] }, { $eq: ['$b.r2', '$a.k2'] }] }, $return: { g: '$a.g', w: '$b.w' } };
      const { sql } = await store.explain(query);
      assert.ok(sql.endsWith('ORDER BY "t0"."k1", "t0"."k2", "t1"."j1", "t1"."j2"'), `${host}: ${sql}`);
      assert.deepEqual(await store.execute(query), [{ g: 'B', w: 30 }, { g: 'A', w: 10 }, { g: 'A', w: 50 }, { g: 'A', w: 20 }, { g: 'B', w: 40 }], host);
    });
  });
});

describe('a grouping over a join of adopted tables', () => {
  it('numbers the rows by every key column of every table, so a group appears where its first tuple does', async () => {
    await onBothEnginesPhysical(joinedModel, JOINED_DDL, async (store, host) => {
      // the rows come in key order: a(1,5) B, a(1,9) A, a(2,0) A, a(3,3) B, each with the b rows that name it.
      // B appears first. The minima of the key columns, one column at a time, would put A (1, 0) before B (1, 3)
      const query = { $for: { a: '$.A[*]', b: '$.B[*]' },
        $where: { $and: [{ $eq: ['$b.r1', '$a.k1'] }, { $eq: ['$b.r2', '$a.k2'] }] },
        $groupby: { g: '$a.g' }, $return: { g: '$g', n: { $count: '$b' }, w: { $sum: '$b.w' } } };
      const answer = [{ g: 'B', n: 2, w: 70 }, { g: 'A', n: 3, w: 80 }];
      const explained = await store.explain(query);
      if (host === 'sqlite') {
        assert.equal(explained.mode, 'native', host);
        assert.ok(explained.sql.includes('ROW_NUMBER() OVER (ORDER BY "t0"."k1", "t0"."k2", "t1"."j1", "t1"."j2")'), explained.sql);
        assert.ok(explained.sql.includes('ORDER BY MIN("_rn")'), explained.sql);
        assert.deepEqual(await store.execute(query, { strict: true }), answer, host);
      }
      else {
        assert.equal(explained.mode, 'set', host);
        assert.equal(reasonOf(explained), 'bind.entityGrouping', host);
        assert.deepEqual(await store.execute(query), answer, host);
      }
      assert.deepEqual(await store.execute(query, { pushdown: false }), answer, `${host} (engine)`);
    });
  });
});

const FOREIGN_KEY_MODEL = { $model: '0.1', entities: {
  Author: { schema: { type: 'object', required: ['id'], properties: {
    id: { type: 'string', 'x-entity': { key: true } }, name: { type: 'string' },
    posts: { 'x-entity': { relation: { to: 'Post', many: true, via: 'authorId', onDelete: 'cascade' } } } } } },
  Post: { schema: { type: 'object', required: ['id'], properties: {
    id: { type: 'string', 'x-entity': { key: true } }, stars: { type: 'integer' } } } },
} };
const FOREIGN_KEY_DOCUMENTS = {
  Author: [{ id: 'a2', name: 'two' }, { id: 'a1', name: 'one' }, { id: 'a3', name: 'three' }],
  Post: [{ id: 'p1', authorId: 'a1', stars: 4 }, { id: 'p2', authorId: 'a2', stars: 5 }, { id: 'p3', authorId: 'a1', stars: 1 },
    { id: 'p4', authorId: 'a2' }, { id: 'p5', stars: 9 }],
};
const PER_AUTHOR = { $for: { a: '$.Author[*]', p: '$.Post[*]' }, $where: { $eq: ['$p.authorId', '$a.id'] },
  $groupby: { who: '$a.name' }, $return: { who: '$who', n: { $count: '$p' }, stars: { $sum: '$p.stars' } } };

describe('a grouping over a join whose foreign key no property declares', () => {
  it('groups the rows of the key it references, natively on SQLite', async () => {
    await onBothEngines(FOREIGN_KEY_MODEL, async (store, host) => {
      await seed(store, FOREIGN_KEY_DOCUMENTS);
      const answer = [{ who: 'two', n: 2, stars: 5 }, { who: 'one', n: 2, stars: 5 }];
      const explained = await store.explain(PER_AUTHOR);
      if (host === 'sqlite') {
        assert.equal(explained.mode, 'native', host);
        assert.deepEqual(await store.execute(PER_AUTHOR, { strict: true }), answer, host);
      }
      else {
        assert.equal(explained.mode, 'set', host);
        assert.equal(reasonOf(explained), 'bind.entityGrouping', host);
      }
      assert.deepEqual(await store.execute(PER_AUTHOR), answer, host);
      assert.deepEqual(await store.execute(PER_AUTHOR, { pushdown: false }), answer, `${host} (engine)`);
    });
  });
});

describe('a grouping over a join whose undeclared foreign key references an integer key', () => {
  it('groups natively on SQLite, and refuses the key against a column of another family', async () => {
    const model = { $model: '0.1', entities: {
      Author: { schema: { type: 'object', required: ['id'], properties: {
        id: { type: 'integer', 'x-entity': { key: true } }, name: { type: 'string' },
        posts: { 'x-entity': { relation: { to: 'Post', many: true, via: 'authorId', onDelete: 'cascade' } } } } } },
      Post: { schema: { type: 'object', required: ['id'], properties: {
        id: { type: 'string', 'x-entity': { key: true } }, stars: { type: 'integer' } } } },
    } };
    await onBothEngines(model, async (store, host) => {
      await seed(store, { Author: [{ id: 1, name: 'one' }, { id: 2, name: '2' }],
        Post: [{ id: 'p1', authorId: 2, stars: 4 }, { id: 'p2', authorId: 1, stars: 5 }, { id: 'p3', authorId: 2, stars: 1 }] });
      const keyed = { $for: { a: '$.Author[*]', p: '$.Post[*]' }, $where: { $eq: ['$p.authorId', '$a.id'] },
        $groupby: { who: '$a.name' }, $return: { who: '$who', stars: { $sum: '$p.stars' } } };
      const answer = [{ who: 'one', stars: 5 }, { who: '2', stars: 5 }];
      const explained = await store.explain(keyed);
      if (host === 'sqlite') {
        assert.equal(explained.mode, 'native', host);
        assert.deepEqual(await store.execute(keyed, { strict: true }), answer, host);
      }
      else assert.equal(reasonOf(explained), 'bind.entityGrouping', host);
      assert.deepEqual(await store.execute(keyed, { pushdown: false }), answer, `${host} (engine)`);
      // the key is the number 2 and the name the string '2': the engine pairs them with nothing
      const across = { ...keyed, $where: { $eq: ['$p.authorId', '$a.name'] } };
      const refused = await store.explain(across);
      assert.equal(refused.mode, 'set', host);
      assert.equal(reasonOf(refused), 'entity.joinKey', host);
      assert.equal(await store.execute(across), undefined, host);
    });
  });
});

describe('a column that reads a NULL back as a present null', () => {
  // the engine refuses a sequence holding a null in a sum, an extreme or an ordering; SQL skips the NULL
  /** @param {(store: any, host: string) => Promise<void>} fn */
  async function onNullPolicy(fn) {
    const sqlite = await openNullPolicy({ kind: 'sqlite', driver: nodeDriver() });
    try {
      await fn(sqlite.store, 'sqlite');
    }
    finally {
      await sqlite.close();
    }
    if (!URL) return;
    const pg = (await import('pg')).default;
    const admin = new pg.Client({ connectionString: URL });
    const pool = new pg.Pool({ connectionString: URL, max: 2 });
    const schema = `group_joins_null_${process.pid}`;
    await admin.connect();
    try {
      await admin.query(`CREATE SCHEMA "${schema}"`);
      const opened = await openNullPolicy({ kind: 'postgres', admin, pool, schema });
      try {
        await fn(opened.store, 'postgres');
      }
      finally {
        await opened.close();
      }
    }
    finally {
      await pool.end().catch(() => {});
      try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
      finally { await admin.end(); }
    }
  }
  /** @param {any} store @param {any} document @param {any} [options] */
  const answerOf = (store, document, options) => Promise.resolve().then(() => store.execute(document, options))
    .then((value) => JSON.stringify(value), (error) => `throws ${error.code}`);

  it('counts the nulls of a grouped sum, mean or extreme, which the engine refuses', async () => {
    await onNullPolicy(async (store, host) => {
      for (const [name, aggregate] of [['sum', '$sum'], ['mean', '$avg'], ['least', '$min'], ['greatest', '$max']]) {
        for (const member of ['b', 'c']) {
          if (member === 'c' && (aggregate === '$sum' || aggregate === '$avg')) continue;
          const query = { $for: { t: '$.T[*]' }, $groupby: { k: '$t.id' }, $return: { k: '$k', v: { [aggregate]: `$t.${member}` } } };
          const label = `${host}: the ${name} of ${member}`;
          // PostgreSQL qualifies no column of this policy for native reads, so the engine keeps it there
          const explained = await store.explain(query);
          assert.equal(explained.mode, host === 'sqlite' ? 'native' : 'set', label);
          if (host !== 'sqlite') assert.equal(reasonOf(explained), 'entity.projection', label);
          const engine = await answerOf(store, query, { pushdown: false });
          assert.equal(engine, 'throws JQ2001', label);
          assert.equal(await answerOf(store, query), engine, label);
          if (host === 'sqlite') assert.equal(await answerOf(store, query, { strict: true }), engine, label);
          // the rows of b the engine reads no null from are answered, in SQL
          if (member === 'b') {
            const clean = { ...query, $where: { $and: [{ $ge: ['$t.id', 2] }, { $le: ['$t.id', 3] }] } };
            const expected = JSON.stringify([{ k: 2, v: 3 }, { k: 3, v: 5 }]);
            assert.equal(await answerOf(store, clean, { pushdown: false }), expected, `${label} (engine)`);
            assert.equal(await answerOf(store, clean), expected, label);
            if (host === 'sqlite') assert.equal(await answerOf(store, clean, { strict: true }), expected, label);
          }
        }
      }
    });
  });

  it('keeps the groups ordered by such a key in the engine, which refuses to order the null', async () => {
    await onNullPolicy(async (store, host) => {
      const query = { $for: { t: '$.T[*]' }, $groupby: { z: '$t.a' }, $orderby: ['$z'], $return: { z: '$z', n: { $count: '$t' } } };
      const explained = await store.explain(query);
      assert.equal(explained.mode, 'set', host);
      assert.equal(reasonOf(explained), 'entity.projection', host);
      assert.equal(await answerOf(store, query, { pushdown: false }), 'throws JQ2005', host);
      assert.equal(await answerOf(store, query), 'throws JQ2005', host);
      // the null is a key of its own, and a count of the rows beside it needs no order
      const unordered = { $for: { t: '$.T[*]' }, $groupby: { z: '$t.a' }, $return: { z: '$z', n: { $count: '$t' } } };
      const expected = JSON.stringify([{ z: null, n: 2 }, { z: 'x', n: 1 }, { z: 'y', n: 1 }]);
      assert.equal(await answerOf(store, unordered, { pushdown: false }), expected, `${host} (engine)`);
      assert.equal(await answerOf(store, unordered), expected, host);
      if (host === 'sqlite') assert.equal((await store.explain(unordered)).mode, 'native', host);
    });
  });
});

describe('a live grouping', () => {
  // a group holds the rows of many tuples, so no tuple is maintained alone: the view re-runs, and equals a fresh run
  it('re-runs after every write, over one binding or a join', async () => {
    const store = await openStore(FOREIGN_KEY_MODEL, { driver: nodeDriver(), capture: true });
    try {
      await seed(store, FOREIGN_KEY_DOCUMENTS);
      const documents = /** @type {[string, any][]} */ ([
        ['one binding', [{ $for: { p: '$.Post[*]' }, $groupby: { s: '$p.stars' }, $return: { s: '$s', n: { $count: '$p' } } }]],
        ['a join', [PER_AUTHOR]],
      ]);
      const registered = [];
      for (const [name, document] of documents) {
        const live = await store.live(document);
        assert.deepEqual(live.mode, { strategy: 'rerun', mode: 'rerun', reason: 'an entity grouping has no bounded tuple accumulator' }, name);
        // a grouping was accepted as an incremental join before, and drifted
        await assert.rejects(async () => store.live(document, { mode: 'incremental' }), { code: 'JD0051' }, name);
        registered.push({ name, live, oracle: liveOracle(live, () => store.execute(document)) });
      }
      for (const write of [
        () => store.entity('Post').create({ id: 'p6', authorId: 'a3', stars: 4 }),
        () => store.entity('Post').update('p1', { authorId: 'a3' }),
        () => store.entity('Post').delete('p2'),
        () => store.entity('Author').create({ id: 'a4', name: 'four' }),
        () => store.entity('Post').create({ id: 'p7', authorId: 'a4', stars: 4 }),
      ]) {
        await write();
        for (const { name, oracle } of registered) await oracle.check().catch((error) => { throw new Error(`${name}: ${error.message}`); });
      }
      for (const { live, oracle } of registered) { oracle.close(); live.close(); }
    }
    finally { await store.close(); }
  });
});

describe('a profile that refuses a full-table scan', () => {
  // one user by its key, joined to the posts that name it: the posts are probed by an index or scanned whole
  // the names are short on purpose: a scan narrative names a table by a prefix, so a derived table
  // called `rows` would read as a full scan of `r`
  const scanned = (/** @type {boolean} */ indexed) => ({ $model: '0.1', entities: {
    r: { schema: { type: 'object', required: ['id'], properties: {
      id: { type: 'string', 'x-entity': { key: true } }, name: { type: 'string' } } } },
    q: { schema: { type: 'object', required: ['pid'], properties: {
      pid: { type: 'integer', 'x-entity': { key: true } },
      authorName: { type: 'string', ...(indexed ? { 'x-entity': { index: true } } : {}) } } } },
  } });
  const documents = {
    r: Array.from({ length: 12 }, (_, i) => ({ id: `u${i + 1}`, name: `n${i % 4}` })),
    q: Array.from({ length: 40 }, (_, i) => ({ pid: i + 1, authorName: `n${i % 4}` })),
  };
  const grouped = [{ $for: { u: '$.r[*]', p: '$.q[*]' },
    $where: { $and: [{ $eq: ['$u.id', 'u7'] }, { $eq: ['$p.authorName', '$u.name'] }] },
    $groupby: { who: '$u.id' }, $return: { who: '$who', n: { $count: '$p' } } }];
  const profile = { refuseFullScan: true, maxRows: 100 };
  /** @param {boolean} indexed @param {(store: any) => Promise<void>} fn */
  async function withStore(indexed, fn) {
    // the planner may otherwise build an index for the probe, and the scan is gone
    const raw = new DatabaseSync(':memory:');
    raw.exec('PRAGMA automatic_index = OFF');
    const db = await adaptNodeDatabase({ exec: (sql) => raw.exec(sql), close: () => raw.close(), prepare: (sql) => raw.prepare(sql) });
    const store = await openStore(scanned(indexed), { driver: { ...nodeDriver(), open: async () => db } });
    try {
      await seed(store, documents);
      await fn(store);
    }
    finally { await store.close(); }
  }

  it('refuses the grouped join as it refuses the join, over a column no index probes', async () => {
    await withStore(false, async (store) => {
      assert.equal((await store.explain(grouped, { profile })).mode, 'native');
      await assert.rejects(async () => store.execute(grouped, { profile }), { code: 'JD0011' });
      assert.deepEqual(await store.execute(grouped, { pushdown: false }), [{ who: 'u7', n: 10 }]);
    });
  });

  it('runs the grouped join where every table is read by a key or an index', async () => {
    await withStore(true, async (store) => {
      assert.deepEqual(await store.execute(grouped, { profile, strict: true }), [{ who: 'u7', n: 10 }]);
    });
  });
});

describe('a profile with mandatory predicates', () => {
  // the predicate of each entity narrows its binding inside the derived table, so a group counts only the rows the profile shows
  it('narrows both bindings of a grouped join, as it narrows the engine', async () => {
    const group = groupNamed(JOINS);
    const profile = { predicates: { Post: { $ge: ['$it.stars', 2] }, User: { $gt: ['$it.age', 3] } } };
    await onBothEngines(group.model, async (store, host) => {
      await seed(store, group.documents);
      const options = { profile };
      for (const name of ['count per parent, the parent bound first', 'every aggregate side by side']) {
        const query = caseOf(group, name).query;
        const label = `${host}: ${name}`;
        const explained = await store.explain(query, options);
        if (host === 'sqlite') assert.equal(explained.mode, 'native', label);
        else assert.equal(reasonOf(explained), 'bind.entityGrouping', label);
        const answer = await store.execute(query, { ...options, pushdown: false });
        assert.deepEqual(await store.execute(query, options), answer, label);
      }
      // users above three: u1 and u4; posts of two stars or more: 1, 3, 4, 7 - so u1 holds posts 1 and 4
      assert.deepEqual(await store.execute(caseOf(group, 'count per parent, the parent bound first').query, options),
        { who: 'u1', n: 2 }, host);
    });
  });
});

describe('the groupings of the joins corpus', () => {
  it('lower on SQLite, indexed or not, and run in the engine on PostgreSQL; a key that is an instant stays there on both', async () => {
    const group = groupNamed('12 joins');
    const counted = ['grouping a join counts related rows per parent', 'aggregates over the grouped join'];
    /** @param {any} groupby @param {any} ret */
    const byInstant = (groupby, ret) => ({ $for: { u: '$.User[*]', p: '$.Post[*]' },
      $where: { $eq: ['$p.authorId', '$u.id'] }, $groupby: groupby, $return: ret });
    await onHosts(async (host, driverOf) => {
      for (const side of /** @type {const} */ (['indexed', 'unindexed'])) {
        const { store } = await storeForEntityGroup(group, await driverOf(), side);
        try {
          for (const name of counted) {
            const kase = caseOf(group, name);
            const label = `${host} ${side}: ${name}`;
            const explained = await store.explain(kase.query);
            if (host === 'sqlite') assert.equal(explained.mode, 'native', label);
            else {
              assert.equal(explained.mode, 'set', label);
              assert.equal(reasonOf(explained), 'bind.entityGrouping', label);
            }
            assert.equal(await runEntityCase(store, group.documents, kase, 'native'), null, label);
          }
          // a key that is an instant reads its epoch column beside the document string: the engine's
          for (const [name, query] of /** @type {[string, any][]} */ ([
            ['an instant key', byInstant({ j: '$u.joined' }, { j: '$j', n: { $count: '$p' } })],
            ['an instant key beside a sum', byInstant({ j: '$u.joined' }, { n: { $sum: '$p.stars' } })],
          ])) {
            const explained = await store.explain(query);
            assert.equal(explained.mode, 'set', `${host} ${side}: ${name}`);
            assert.equal(reasonOf(explained), 'entity.projection', `${host} ${side}: ${name}`);
            assert.deepEqual(await store.execute(query), await store.execute(query, { pushdown: false }), `${host} ${side}: ${name}`);
          }
        }
        finally { await store.close(); }
      }
    });
  });
});
