//@ts-check
/**
 * @file `$distinct` over entity arrays. The leaves of the return are mapped
 * columns of scalar types, so the database groups them by what the column stores
 * and the engine decodes, and the groups come out in the order the engine meets
 * the rows: a binding's key, or, over a join, the number of the row in the
 * nested loop. On PostgreSQL the runtime guards of a grouping are qualified for
 * one adopted table with no document column alone, so a store-owned table and a
 * join plan the engine under the named reason.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { openStore, reasonId } from '@jarenjs/db';
import { loadRelationGroups, storeForEntityGroup, runEntityCase } from './oracle/harness.js';
import { onBothEnginesPhysical } from './query-core-engines.js';

const PG_URL = process.env.JAREN_PG_URL;
let schemas = 0;

/**
 * Run `fn` once per available host with a way to open a driver of it: SQLite
 * in memory, and PostgreSQL in schemas of its own when `JAREN_PG_URL` names an
 * endpoint.
 * @param {(host: 'sqlite' | 'postgres', driverOf: () => Promise<any>) => Promise<void>} fn
 */
async function onHosts(fn) {
  const { nodeDriver } = await import('@jarenjs/db/node');
  await fn('sqlite', async () => nodeDriver());
  if (!PG_URL) return;
  const { default: pg } = await import('pg');
  const { postgresDriver } = await import('@jarenjs/db/postgres');
  const pool = new pg.Pool({ connectionString: PG_URL, max: 2 });
  /** @type {string[]} */
  const made = [];
  try {
    await fn('postgres', async () => {
      const schema = `entity_distinct_${process.pid}_${++schemas}`;
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

/** A `$distinct` over `it` ranging over an entity array. */
function distinct(/** @type {any} */ ret, /** @type {{ where?: any, order?: any[], over?: any }} */ { where, order, over } = {}) {
  return { $distinct: { $for: over ?? { it: '$.Item[*]' }, ...(where === undefined ? {} : { $where: where }),
    ...(order === undefined ? {} : { $orderby: order }), $return: ret } };
}

describe('every case of the entity corpus group is lowered or kept by the rule its name states', () => {
  const group = loadRelationGroups().find((entry) => entry.group === 'entity distinct over mapped columns');

  it('the group exists and names its residual cases', () => {
    assert.ok(group);
    const kept = group.cases.filter((kase) => kase.name.endsWith('stays in the engine'));
    assert.equal(group.cases.length - kept.length, 30);
    assert.equal(kept.length, 11);
  });

  for (const side of /** @type {const} */ (['indexed', 'unindexed'])) {
    it(`plans each case native on SQLite, in the engine under its reason on PostgreSQL, and answers as the engine — ${side}`, async () => {
      assert.ok(group);
      await onHosts(async (host, driverOf) => {
        const { store } = await storeForEntityGroup(group, await driverOf(), side);
        try {
          for (const kase of group.cases) {
            const label = `${host} ${side}: ${kase.name}`;
            const explained = await store.explain(kase.query);
            const kept = kase.name.endsWith('stays in the engine');
            if (kept) {
              assert.equal(explained.mode, 'set', label);
              assert.equal(reasonId(explained.residual.reasons[0].reason),
                kase.name.startsWith('a count of a distinct') ? 'entity.notFlwor' : 'entity.distinct', label);
            }
            else if (host === 'sqlite') {
              assert.equal(explained.mode, 'native', label);
              assert.match(explained.sql, /GROUP BY "vk0", "tk0"/, label);
            }
            else {
              // the guards of an entity grouping are qualified for one adopted table: a store-owned table is the engine's
              assert.equal(explained.mode, 'set', label);
              assert.equal(reasonId(explained.residual.reasons[0].reason), 'bind.entityGrouping', label);
            }
            assert.equal(await runEntityCase(store, group.documents, kase, 'native'), null, label);
          }
        }
        finally { await store.close(); }
      });
    });
  }
});

describe('a profile bounds the groups of an entity distinct', () => {
  it('counts the groups against maxRows and each group\'s item against maxBytes, where the engine path counts every row', async () => {
    const group = loadRelationGroups().find((entry) => entry.group === 'entity distinct over mapped columns');
    assert.ok(group);
    const { store } = await storeForEntityGroup(group);
    try {
      const cities = group.cases.find((entry) => entry.name === 'distinct city')?.query;
      const pairs = group.cases.find((entry) => entry.name === 'a compound of a string and an integer')?.query;
      const answer = await store.execute(cities, { pushdown: false });
      // four cities among eleven persons: the bound is crossed by the rows the engine path fetches, not by the groups
      assert.equal(answer.length, 4);
      assert.deepEqual(await store.execute(cities, { profile: { maxRows: 4 } }), answer);
      await assert.rejects(Promise.resolve().then(() => store.execute(cities, { profile: { maxRows: 4 }, pushdown: false })), { code: 'JD2007' });
      // more groups than the bound cross it
      await assert.rejects(Promise.resolve().then(() => store.execute(pairs, { profile: { maxRows: 4 } })), { code: 'JD2007' });
      // an item larger than the byte bound crosses it
      await assert.rejects(Promise.resolve().then(() => store.execute(cities, { profile: { maxRows: 1000, maxBytes: 5 } })), { code: 'JD2076' });
    }
    finally { await store.close(); }
  });
});

describe('a distinct over a join numbers the rows of the nested loop', () => {
  it('lowers to a derived table of numbered rows and takes each group at its first row', async () => {
    const group = loadRelationGroups().find((entry) => entry.group === 'entity distinct over mapped columns');
    assert.ok(group);
    const { store } = await storeForEntityGroup(group);
    try {
      const kase = group.cases.find((entry) => entry.name === 'a compound of columns of the joined bindings');
      assert.ok(kase);
      const explained = await store.explain(kase.query);
      assert.equal(explained.mode, 'native');
      assert.match(explained.sql, /ROW_NUMBER\(\) OVER \(ORDER BY .*\) AS "_rn".* AS "0rows" GROUP BY "vk0", "tk0", "vk1", "tk1" ORDER BY MIN\("_rn"\)$/);
    }
    finally { await store.close(); }
  });
});

// ————— an adopted table, which PostgreSQL qualifies —————

/** @param {string} prefix */
const ITEMS_DDL = (prefix) => {
  const pg = prefix !== '';
  const T = pg ? 'true' : '1';
  const F = pg ? 'false' : '0';
  return `CREATE TABLE ${prefix}items (id integer PRIMARY KEY, g text NOT NULL, c text, v bigint, f ${pg ? 'double precision' : 'REAL'},
    b ${pg ? 'boolean' : 'integer CHECK (b IN (0, 1))'});
  INSERT INTO ${prefix}items VALUES (1,'A','x',3,1.5,${T}),(2,'A','x',3,1.5,${T}),(3,'B','y',NULL,2.5,${F}),(4,'B',NULL,3,NULL,NULL),
  (5,'C','',0,-1,${T}),(6,'A','x',7,1.5,${F}),(7,'D',NULL,NULL,NULL,NULL),(8,'A','x',3,2.5,${T})`;
};
/** The adopted table as an entity: `NULL` reads back as no member in every column. @param {string | null} schema */
const itemsModel = (schema) => ({ $model: '0.1', entities: { Item: {
  schema: { type: 'object', properties: {
    id: { type: 'integer', 'x-entity': { key: true } }, g: { type: 'string' }, c: { type: 'string' }, v: { type: 'integer' },
    f: { type: 'number' }, b: { type: 'boolean' } } },
  physical: { ...(schema === null ? {} : { schema }), table: 'items', columns: {
    id: { name: 'id', codec: 'integer', null: 'reject' }, g: { name: 'g', codec: 'text', null: 'reject' },
    c: { name: 'c', codec: 'text', null: 'absent' }, v: { name: 'v', codec: 'integer', null: 'absent' },
    f: { name: 'f', codec: 'number', null: 'absent' }, b: { name: 'b', codec: 'boolean', null: 'absent' } } },
} } });

describe('a distinct over one adopted table with no document column', () => {
  const CASES = /** @type {[string, any, any][]} */ ([
    ['a text column', distinct('$it.g'), ['A', 'B', 'C', 'D']],
    ['a nullable text column', distinct('$it.c'), ['x', 'y', '']],
    ['a nullable integer column', distinct('$it.v'), [3, 0, 7]],
    ['a nullable number column', distinct('$it.f'), [1.5, 2.5, -1]],
    ['a nullable boolean column', distinct('$it.b'), [true, false]],
    ['two columns', distinct({ g: '$it.g', c: '$it.c' }), [{ g: 'A', c: 'x' }, { g: 'B', c: 'y' }, { g: 'B' }, { g: 'C', c: '' }, { g: 'D' }]],
    ['three columns of three codecs', distinct({ v: '$it.v', f: '$it.f', b: '$it.b' }),
      [{ v: 3, f: 1.5, b: true }, { f: 2.5, b: false }, { v: 3 }, { v: 0, f: -1, b: true }, { v: 7, f: 1.5, b: false }, {}, { v: 3, f: 2.5, b: true }]],
    ['a column beside a filter', distinct({ g: '$it.g', v: '$it.v' }, { where: { $ne: ['$it.g', 'A'] } }),
      [{ g: 'B' }, { g: 'B', v: 3 }, { g: 'C', v: 0 }, { g: 'D' }]],
    ['a window of one over a column', { $subsequence: [distinct('$it.v'), 1, 1] }, 0],
    ['a window over a compound', { $subsequence: [distinct({ g: '$it.g', c: '$it.c' }), 1, 2] }, [{ g: 'B', c: 'y' }, { g: 'B' }]],
  ]);

  it('lowers natively on every host, in the order the engine meets the rows', async () => {
    await onBothEnginesPhysical(itemsModel, ITEMS_DDL, async (store, host) => {
      for (const [name, query, expected] of CASES) {
        const label = `${host}: ${name}`;
        const explained = await store.explain(query);
        assert.equal(explained.mode, 'native', label);
        const engine = await store.execute(query, { pushdown: false });
        assert.deepEqual(await store.execute(query, { strict: true }), engine, label);
        assert.deepEqual(engine, expected, `${label} (the engine)`);
      }
    });
  });

  it('keeps an ordering of its own, a document member and an unmapped column in the engine', async () => {
    await onBothEnginesPhysical(itemsModel, ITEMS_DDL, async (store, host) => {
      const ordered = distinct('$it.g', { order: ['$it.id'] });
      for (const query of [ordered, distinct({ who: '$it' }), distinct('$it.missing'), distinct({ g: '$it.g', o: '$it.o.k' })]) {
        const label = `${host}: ${JSON.stringify(query)}`;
        const explained = await store.explain(query);
        assert.equal(explained.mode, 'set', label);
        assert.equal(reasonId(explained.residual.reasons[0].reason), 'entity.distinct', label);
        await assert.rejects(Promise.resolve().then(() => store.execute(query, { strict: true })), { code: 'JD0010' }, label);
      }
    });
  });
});

/** @param {string} prefix */
const COMPOUND_DDL = (prefix) => `CREATE TABLE ${prefix}t (k1 integer NOT NULL, k2 integer NOT NULL, g text NOT NULL, PRIMARY KEY (k1, k2));
  INSERT INTO ${prefix}t VALUES (1,9,'A'),(2,0,'A'),(1,5,'B'),(3,3,'B')`;
/** @param {string | null} schema */
const compoundModel = (schema) => ({ $model: '0.1', entities: { T: {
  schema: { type: 'object', properties: {
    k1: { type: 'integer', 'x-entity': { key: true } }, k2: { type: 'integer', 'x-entity': { key: true } }, g: { type: 'string' } } },
  physical: { ...(schema === null ? {} : { schema }), table: 't', keys: ['k1', 'k2'], columns: {
    k1: { name: 'k1', codec: 'integer', null: 'reject' }, k2: { name: 'k2', codec: 'integer', null: 'reject' },
    g: { name: 'g', codec: 'text', null: 'reject' } } },
} } });

describe('a distinct over a table with a compound physical key', () => {
  it('is the engine\'s, whose first appearance is a key tuple that independent minima do not give', async () => {
    await onBothEnginesPhysical(compoundModel, COMPOUND_DDL, async (store, host) => {
      const query = distinct('$it.g', { over: { it: '$.T[*]' } });
      const explained = await store.explain(query);
      assert.equal(explained.mode, 'set', host);
      assert.equal(reasonId(explained.residual.reasons[0].reason), 'entity.groupOrder', host);
      // the rows come in key order (1,5) B, (1,9) A, (2,0) A, (3,3) B; the least k1 and the least k2 of each group name A first
      assert.deepEqual(await store.execute(query), ['B', 'A'], host);
    });
  });
});

/** @param {string} prefix */
const DATES_DDL = (prefix) => `CREATE TABLE ${prefix}d (id integer PRIMARY KEY, day ${prefix === '' ? 'text' : 'date'}, n integer, "__proto__" ${prefix === '' ? 'text' : 'date'});
  INSERT INTO ${prefix}d VALUES (1,'2026-01-02',1,'2026-03-04'),(2,'2026-01-02',2,'2026-03-04'),(3,'2026-02-03',1,'2026-05-06')`;
/** @param {string | null} schema */
const datesModel = (schema) => ({ $model: '0.1', entities: { D: {
  // computed keys: the member named `__proto__` is an own property of the model, not a prototype
  schema: { type: 'object', properties: {
    id: { type: 'integer', 'x-entity': { key: true } }, day: { type: 'string', format: 'date' }, n: { type: 'integer' },
    ['__proto__']: { type: 'string', format: 'date' } } },
  physical: { ...(schema === null ? {} : { schema }), table: 'd', columns: {
    id: { name: 'id', codec: 'integer', null: 'reject' }, day: { name: 'day', codec: 'date', null: 'reject' },
    n: { name: 'n', codec: 'integer', null: 'reject' }, ['__proto__']: { name: '__proto__', codec: 'date', null: 'reject' } } },
} } });

describe('a distinct of a column whose codec decodes what it stores', () => {
  it('is the engine\'s: equal stored dates are one date, but the guard that reads them back is not qualified', async () => {
    await onBothEnginesPhysical(datesModel, DATES_DDL, async (store, host) => {
      for (const query of [distinct('$it.day', { over: { it: '$.D[*]' } }), distinct({ n: '$it.n', day: '$it.day' }, { over: { it: '$.D[*]' } })]) {
        const label = `${host}: ${JSON.stringify(query)}`;
        const explained = await store.explain(query);
        assert.equal(explained.mode, 'set', label);
        assert.equal(reasonId(explained.residual.reasons[0].reason), 'entity.distinct', label);
      }
      assert.deepEqual(await store.execute(distinct('$it.n', { over: { it: '$.D[*]' } })), [1, 2], host);
    });
  });

  it('reads a codec column named __proto__ back as a member of the row', async () => {
    await onBothEnginesPhysical(datesModel, DATES_DDL, async (store, host) => {
      const [first] = await store.execute({ $for: { it: '$.D[*]' }, $return: '$it' });
      assert.equal(Object.getOwnPropertyDescriptor(first, '__proto__')?.value, '2026-03-04', host);
    });
  });
});

describe('a distinct of a foreign key no property declares', () => {
  // the relation's `via` names a column the schema declares no property for: its table stores the key's type, and no
  // schema places the member, so nothing proves the column holds the scalars a grouping needs
  const KEY = { 'x-entity': { key: true } };
  const MODEL = { $model: '0.1', entities: {
    Author: { schema: { type: 'object', required: ['id'], properties: { id: { type: 'string', ...KEY }, name: { type: 'string' },
      posts: { 'x-entity': { relation: { to: 'Post', many: true, via: 'authorId', onDelete: 'cascade' } } } } } },
    Post: { schema: { type: 'object', required: ['id'], properties: { id: { type: 'string', ...KEY }, title: { type: 'string' } } } } } };

  it('is the engine\'s', async () => {
    await onHosts(async (host, driverOf) => {
      const store = await openStore(MODEL, { driver: await driverOf() });
      try {
        for (const [id, name] of [['a1', 'A'], ['a2', 'B']]) await store.entity('Author').create({ id, name });
        for (const [id, authorId] of [['p1', 'a1'], ['p2', 'a1'], ['p3', 'a2']]) await store.entity('Post').create({ id, authorId, title: id });
        for (const query of [{ $distinct: { $for: { p: '$.Post[*]' }, $return: '$p.authorId' } },
          { $distinct: { $for: { p: '$.Post[*]' }, $return: { who: '$p.authorId', title: '$p.title' } } }]) {
          const label = `${host}: ${JSON.stringify(query)}`;
          const explained = await store.explain(query);
          assert.equal(explained.mode, 'set', label);
          assert.equal(reasonId(explained.residual.reasons[0].reason), 'entity.distinct', label);
          assert.deepEqual(await store.execute(query), await store.execute(query, { pushdown: false }), label);
        }
      }
      finally { await store.close(); }
    });
  });
});

describe('an entity property named __proto__ is a member of the documents read', () => {
  // the table stores it as a column like any other; a row builder that assigns by name would drop it, and then the
  // engine, which reads the rebuilt documents, would disagree with a statement that reads the column
  const SCHEMA = JSON.parse('{"type":"object","required":["id"],"properties":{"id":{"type":"integer","x-entity":{"key":true}},'
    + '"__proto__":{"type":"string"},"name":{"type":"string"}}}');
  const QUERIES = /** @type {[string, any][]} */ ([
    ['the rows', { $for: { p: '$.P[*]' }, $return: '$p' }],
    ['a projection of it', JSON.parse('{"$for":{"p":"$.P[*]"},"$return":{"w":"$p.__proto__"}}')],
    ['a distinct of it', JSON.parse('{"$distinct":{"$for":{"p":"$.P[*]"},"$return":"$p.__proto__"}}')],
    ['a distinct constructor of it', JSON.parse('{"$distinct":{"$for":{"p":"$.P[*]"},"$return":{"w":"$p.__proto__","n":"$p.name"}}}')],
    ['a distinct constructor naming a member so', JSON.parse('{"$distinct":{"$for":{"p":"$.P[*]"},"$return":{"__proto__":"$p.name","w":"$p.__proto__"}}}')],
  ]);

  it('reads back as written, and the statements agree with the engine', async () => {
    await onHosts(async (host, driverOf) => {
      const store = await openStore({ $model: '0.1', entities: { P: { schema: SCHEMA } } }, { driver: await driverOf() });
      try {
        for (let i = 1; i <= 4; i++) await store.entity('P').create(JSON.parse(`{"id":${i},"__proto__":"v${i % 2}","name":"n${i % 3}"}`));
        const row = await store.entity('P').get(1);
        assert.deepEqual(Object.keys(row), ['id', '__proto__', 'name'], host);
        assert.equal(Object.getOwnPropertyDescriptor(row, '__proto__')?.value, 'v1', host);
        for (const [name, query] of QUERIES) {
          const label = `${host}: ${name}`;
          const engine = await store.execute(query, { pushdown: false });
          assert.ok(JSON.stringify(engine).includes('v1'), `${label} (the engine reads the member)`);
          assert.deepEqual(await store.execute(query), engine, label);
        }
      }
      finally { await store.close(); }
    });
  });
});

describe('the rows of a graph load keep a column and a foreign key named __proto__', () => {
  // a child's column, a foreign key no property declares (a child's, and a root's own) are members of the documents
  // loaded; the model is JSON text, since an object literal naming `__proto__` would set a prototype instead
  const MODEL = JSON.parse(`{"$model":"0.1","entities":{
    "Owner":{"schema":{"type":"object","required":["id"],"properties":{"id":{"type":"integer","x-entity":{"key":true}},
      "things":{"x-entity":{"relation":{"to":"Thing","many":true,"via":"owner","onDelete":"cascade"}}},
      "extras":{"x-entity":{"relation":{"to":"Extra","many":true,"via":"__proto__","onDelete":"cascade"}}}}}},
    "Thing":{"schema":{"type":"object","required":["tid"],"properties":{"tid":{"type":"integer","x-entity":{"key":true}},
      "owner":{"type":"integer"},"__proto__":{"type":"string"}}}},
    "Extra":{"schema":{"type":"object","required":["eid"],"properties":{"eid":{"type":"integer","x-entity":{"key":true}}}}}}}`);
  const member = (/** @type {any} */ row) => Object.getOwnPropertyDescriptor(row, '__proto__')?.value;

  it('reads the child column, the child foreign key and the root foreign key back', async () => {
    await onHosts(async (host, driverOf) => {
      const store = await openStore(MODEL, { driver: await driverOf() });
      try {
        await store.entity('Owner').create({ id: 1 });
        await store.entity('Thing').create(JSON.parse('{"tid":1,"owner":1,"__proto__":"t1"}'));
        await store.entity('Extra').create(JSON.parse('{"eid":1,"__proto__":1}'));
        const [owner] = await store.entity('Owner').load({ include: { things: {}, extras: {} } });
        assert.equal(member(owner.things[0]), 't1', `${host}: a child column`);
        assert.equal(member(owner.extras[0]), 1, `${host}: a child foreign key`);
        const [extra] = await store.entity('Extra').load({});
        assert.equal(member(extra), 1, `${host}: a root foreign key`);
      }
      finally { await store.close(); }
    });
  });
});
