//@ts-check
/**
 * @file A string the database would read as another string, where no
 * literal names it. A driver binds a lone surrogate as U+FFFD, and
 * PostgreSQL holds no U+0000 and refuses a lone surrogate's JSON escape,
 * so an external holding one diverts at bind and the engine answers
 * (SQLite reads a membership list's JSON escape as written, so a list
 * there stays native). A graph load and a native mutation have no engine
 * path, so a predicate comparing a lone surrogate refuses by code; an
 * entity query's literal holding U+0000 runs in the residual on
 * PostgreSQL, as a collection's does. Every answer is the engine's
 * (`pushdown: false`).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { openStore, reasonId } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';

import { onBothEngines, onBothEnginesPhysical } from './query-core-engines.js';

const MODEL = {
  $model: '0.1',
  collections: {
    t: {
      key: '/id',
      schema: { type: 'object', properties: { id: { type: 'string' }, s: { type: 'string' } } },
      indexes: [{ name: 'by_s', path: '$.s' }],
    },
  },
  entities: {
    User: { schema: { type: 'object', required: ['id'], properties: { id: { type: 'string', 'x-entity': { key: true } },
      name: { type: 'string' }, meta: { type: 'object', properties: { n: { type: 'string' } } } } } },
  },
};

const sorted = (/** @type {any} */ value) => [value ?? []].flat().sort();
/** The reason ids of a plan, its own and its residual's. @param {any} plan */
const reasonIds = (plan) => (plan.reasons ?? plan.residual?.reasons ?? []).map((/** @type {any} */ reason) => reasonId(reason.reason));

describe('an external string the database would read as another string', () => {
  it('a collection external diverts at bind and answers what the engine answers', async () => {
    await onBothEngines(MODEL, async (store, host) => {
      const sqlite = host === 'sqlite';
      const rows = store.collection('t');
      // PostgreSQL holds no lone surrogate and no U+0000 in a document
      for (const [id, s] of sqlite ? [['a', 'x\uD800'], ['b', 'x\uFFFD'], ['c', 'xy'], ['n', 'y\u0000z']]
        : [['b', 'x\uFFFD'], ['c', 'xy']]) await rows.insert({ id, s });
      const document = { $for: { e: '$[*]' }, $where: { $eq: ['$e.s', '$x'] }, $return: '$e.id' };
      for (const [x, expected, diverts] of /** @type {[string, string[], boolean][]} */ ([
        ['x\uD800', sqlite ? ['a'] : [], true],
        ['x\uFFFD', ['b'], false],
        ['y\u0000z', sqlite ? ['n'] : [], !sqlite],
      ])) {
        const options = { externals: { x } };
        assert.deepEqual(sorted(await rows.execute(document, { ...options, pushdown: false })), expected, JSON.stringify(x));
        assert.deepEqual(sorted(await rows.execute(document, options)), expected, JSON.stringify(x));
        const plan = await rows.explain(document, options);
        assert.equal(reasonIds(plan).includes('bind.external'), diverts, `${host}: ${JSON.stringify(x)}`);
        assert.equal(plan.streaming, diverts ? 'buffered' : 'row', `${host}: ${JSON.stringify(x)}`);
        const items = [];
        for await (const item of rows.query(document, options)) items.push(item);
        assert.deepEqual(items.sort(), expected, JSON.stringify(x));
      }
    });
  });

  it('a membership list rides the statement on SQLite, whose JSON reads the escape as written', async () => {
    await onBothEngines(MODEL, async (store, host) => {
      const sqlite = host === 'sqlite';
      const rows = store.collection('t');
      for (const [id, s] of sqlite ? [['a', 'x\uD800'], ['b', 'x\uFFFD']] : [['b', 'x\uFFFD']]) await rows.insert({ id, s });
      const document = { $for: { e: '$[*]' }, $where: { $eq: ['$e.s', '$x[*]'] }, $return: '$e.id' };
      for (const [x, expected] of /** @type {[string[], string[]][]} */ ([
        [['x\uD800'], sqlite ? ['a'] : []], [['x\uD800', 'x\uFFFD'], sqlite ? ['a', 'b'] : ['b']], [['y\u0000z'], []],
      ])) {
        const options = { externals: { x } };
        assert.deepEqual(sorted(await rows.execute(document, { ...options, pushdown: false })), expected, JSON.stringify(x));
        assert.deepEqual(sorted(await rows.execute(document, options)), expected, JSON.stringify(x));
        assert.equal(reasonIds(await rows.explain(document, options)).includes('bind.external'), !sqlite, `${host}: ${JSON.stringify(x)}`);
      }
    });
  });

  it("an entity query's external diverts at bind and answers what the engine answers", async () => {
    await onBothEngines(MODEL, async (store, host) => {
      const sqlite = host === 'sqlite';
      const users = store.entity('User');
      // a document member keeps a lone surrogate on SQLite; a column stores only well-formed text
      if (sqlite) await users.create({ id: 'u1', name: 'a', meta: { n: 'x\uD800' } });
      await users.create({ id: 'u2', name: 'x\uFFFD', meta: { n: 'x\uFFFD' } });
      const over = (/** @type {string} */ path) => ({ $for: { it: '$.User[*]' }, $where: { $eq: [path, '$x'] }, $return: '$it.id' });
      for (const [path, x, expected, diverts] of /** @type {[string, string, string[], boolean][]} */ ([
        ['$it.name', 'x\uD800', [], true],
        ['$it.meta.n', 'x\uD800', sqlite ? ['u1'] : [], true],
        ['$it.name', 'x\uFFFD', ['u2'], false],
        ['$it.name', 'y\u0000z', [], !sqlite],
      ])) {
        const options = { externals: { x } };
        const label = `${host}: ${path} = ${JSON.stringify(x)}`;
        assert.deepEqual(sorted(await users.execute(over(path), { ...options, pushdown: false })), expected, label);
        assert.deepEqual(sorted(await users.execute(over(path), options)), expected, label);
        const items = [];
        for await (const item of users.cursor(over(path), options)) items.push(item);
        assert.deepEqual(items.sort(), expected, label);
        assert.equal(users.cursor(over(path), options).streaming, diverts ? 'buffered' : 'row', label);
      }
    });
  });
});

describe("an entity query's literal holding U+0000", () => {
  it('runs in the residual on PostgreSQL, which holds none, and natively on SQLite', async () => {
    await onBothEngines(MODEL, async (store, host) => {
      const sqlite = host === 'sqlite';
      const users = store.entity('User');
      if (sqlite) await users.create({ id: 'u1', name: 'y\u0000z' });
      await users.create({ id: 'u2', name: 'xy' });
      for (const [where, expected] of /** @type {[any, string[]][]} */ ([
        [{ $eq: ['$it.name', 'y\u0000z'] }, sqlite ? ['u1'] : []],
        [{ $eq: ['$it.meta.n', 'y\u0000z'] }, []],
        [{ $ne: ['$it.name', 'y\u0000z'] }, ['u2']],
      ])) {
        const document = { $for: { it: '$.User[*]' }, $where: where, $return: '$it.id' };
        assert.deepEqual(sorted(await users.execute(document, { pushdown: false })), expected, JSON.stringify(where));
        assert.deepEqual(sorted(await users.execute(document)), expected, JSON.stringify(where));
        const plan = await users.explain(document);
        assert.equal(plan.mode, sqlite ? 'native' : 'set', `${host}: ${JSON.stringify(where)}`);
        if (!sqlite) assert.deepEqual(reasonIds(plan).slice(0, 1), ['bind.serverText']);
      }
    });
  });
});

const PHYSICAL = (/** @type {string | null} */ schema) => ({ $model: '0.1', entities: { P: {
  schema: { type: 'object', required: ['id', 'name'], properties: { id: { type: 'integer', 'x-entity': { key: true } },
    name: { type: 'string' } } },
  physical: { ...(schema === null ? {} : { schema }), table: 'p', columns: {
    id: { name: 'id', codec: 'integer', null: 'reject' }, name: { name: 'name', codec: 'text', null: 'reject' } } } } } });
const PHYSICAL_DDL = (/** @type {string} */ prefix) => `CREATE TABLE ${prefix}p (id integer PRIMARY KEY, name text NOT NULL)`;

describe('a statement with no engine path, comparing a lone surrogate', () => {
  it('a graph load and a native mutation refuse it by code and change nothing; a well-formed string still runs', async () => {
    await onBothEnginesPhysical(PHYSICAL, PHYSICAL_DDL, async (store, host) => {
      const p = store.entity('P');
      await p.create({ id: 1, name: 'x\uFFFD' });
      await p.create({ id: 2, name: 'xy' });
      const stored = async () => (await p.load({})).map((/** @type {any} */ row) => [row.id, row.name]);
      const lone = { $eq: ['$it.name', 'x\uD800'] };
      // the engine compares the string as written: no row holds it
      assert.deepEqual(await p.execute({ $for: { it: '$.P[*]' }, $where: lone, $return: '$it.id' }, { pushdown: false }), undefined);
      await assert.rejects(async () => p.load({ where: lone }), { code: 'JD0032', message: /lone surrogate/ }, host);
      await assert.rejects(async () => p.load({ where: { $or: [{ $eq: ['$it.name', 'q'] }, { '$starts-with': ['$it.name', 'x\uDC00'] }] } }),
        { code: 'JD0032', message: /lone surrogate/ }, host);
      await assert.rejects(async () => p.mutate({ op: 'update', where: lone, set: { name: 'hit' } }), { code: 'JD0038', message: /lone surrogate/ }, host);
      await assert.rejects(async () => p.mutate({ op: 'delete', where: { $not: lone } }), { code: 'JD0038', message: /lone surrogate/ }, host);
      assert.deepEqual(await stored(), [[1, 'x\uFFFD'], [2, 'xy']], host);
      assert.deepEqual((await p.load({ where: { $eq: ['$it.name', 'x\uFFFD'] } })).map((/** @type {any} */ row) => row.id), [1], host);
      // SQLite holds U+0000, so a literal holding one still loads natively there
      if (host === 'sqlite') assert.deepEqual(await p.load({ where: { $eq: ['$it.name', 'x\u0000'] } }), []);
      assert.equal((await p.mutate({ op: 'update', where: { $eq: ['$it.name', 'xy'] }, set: { name: 'xz' } })).affected, 1, host);
      assert.deepEqual(await stored(), [[1, 'x\uFFFD'], [2, 'xz']], host);
    });
  });

  it("a document entity's load refuses it too", async () => {
    await onBothEngines(MODEL, async (store, host) => {
      const users = store.entity('User');
      await users.create({ id: 'u2', name: 'x\uFFFD' });
      await assert.rejects(async () => users.load({ where: { $eq: ['$it.name', 'x\uD800'] } }), { code: 'JD0032', message: /lone surrogate/ }, host);
      assert.deepEqual((await users.load({ where: { $eq: ['$it.name', 'x\uFFFD'] } })).map((/** @type {any} */ row) => row.id), ['u2']);
    });
  });
});

describe("a profile's mandatory predicate comparing a lone surrogate", () => {
  it("is a host error on an entity, as on a collection: it would keep the rows holding U+FFFD", async () => {
    const lone = { $eq: ['$it.name', 'x\uD800'] };
    const store = await openStore(MODEL, { driver: nodeDriver(), profile: { maxRows: 100,
      predicates: { User: lone, t: { $eq: ['$it.s', 'x\uD800'] } } } });
    try {
      await assert.rejects(async () => store.entity('User').execute({ $for: { it: '$.User[*]' }, $return: '$it.id' }),
        { name: 'TypeError', message: /lone surrogate/ });
      await assert.rejects(async () => store.entity('User').load({}), { name: 'TypeError', message: /lone surrogate/ });
      await assert.rejects(async () => store.collection('t').execute({ $for: { e: '$[*]' }, $return: '$e.id' }), { name: 'TypeError' });
    }
    finally {
      await store.close();
    }
    const plain = await openStore(MODEL, { driver: nodeDriver(), profile: { maxRows: 100, predicates: { User: { $eq: ['$it.name', 'x\uFFFD'] } } } });
    try {
      await plain.entity('User').create({ id: 'u2', name: 'x\uFFFD' });
      await plain.entity('User').create({ id: 'u3', name: 'xy' });
      assert.deepEqual(await plain.entity('User').execute({ $for: { it: '$.User[*]' }, $return: '$it.id' }), 'u2');
    }
    finally {
      await plain.close();
    }
  });
});
