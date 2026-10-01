//@ts-check
/**
 * @file Keyset pages over physical (column-mapped) SQLite entities
 * (MODEL-FORMAT §10.5, §12): one identity model — a continuation names
 * PROPERTIES and carries decoded values, the SQL names the physical
 * columns and compares them as their codecs compare — so a renamed or
 * composite key, a bigint above 2^53 and a text key (whatever collation
 * the table declared) page without skipping or repeating a row. A text
 * key proves per row that it round-trips through the file's text
 * encoding, and a codec whose decoded value does not compare as its
 * stored one (uuid) is refused by name. An ordered `load()` and
 * `execute()` order a text column the same way: by code point.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { tempDbPath } from './helpers.js';

const key = { 'x-entity': { key: true } };

/**
 * Open an adopted store over a fresh file prepared by `ddl`.
 * @param {string} ddl @param {Record<string, any>} entities
 */
async function adopted(ddl, entities) {
  const { dbPath, cleanup } = tempDbPath();
  const db = new DatabaseSync(dbPath);
  db.exec(ddl);
  db.close();
  const store = await openStore({ $model: '0.1', entities }, { driver: nodeDriver(), path: dbPath, adopt: true });
  return { store, dbPath, close: async () => { await store.close(); cleanup(); } };
}

/**
 * Every page of `spec` at `limit`, following continuations.
 * @param {any} set @param {any} spec @param {number} limit
 * @returns {Promise<{ items: any[], snapshots: boolean[] }>}
 */
async function everyPage(set, spec, limit) {
  const items = [];
  const snapshots = [];
  /** @type {any} */
  let after;
  for (let pages = 0; pages < 100; pages++) {
    const page = await set.page(spec, { limit, ...(after === undefined ? {} : { after }) });
    items.push(...page.items);
    snapshots.push(page.snapshot);
    if (!page.hasMore) return { items, snapshots };
    after = page.continuation;
  }
  throw new Error('a hundred pages: the continuation does not advance');
}

describe('a keyset page over a physical table', () => {
  it('a renamed integer key: every row once, snapshot', async () => {
    const { store, close } = await adopted(
      'CREATE TABLE item(item_id INTEGER PRIMARY KEY, label TEXT); '
      + 'INSERT INTO item VALUES (5, \'e\'), (1, \'a\'), (3, \'c\'), (2, \'b\'), (4, \'d\');',
      { Item: { schema: { type: 'object', properties: { id: { type: 'integer', ...key }, name: { type: 'string' } } },
        physical: { table: 'item', columns: { id: { name: 'item_id', codec: 'integer', null: 'reject' },
          name: { name: 'label', codec: 'text', null: 'null' } } } } });
    try {
      const { items, snapshots } = await everyPage(store.entity('Item'), {}, 2);
      assert.deepEqual(items.map((item) => item.id), [1, 2, 3, 4, 5]);
      assert.ok(snapshots.every(Boolean));
      // the continuation names the PROPERTY, never the physical column
      const first = await store.entity('Item').page({}, { limit: 2 });
      assert.deepEqual(first.continuation, { order: [{ column: 'id', desc: false, nullsFirst: true }], keys: [], key: 2 });
      // a declared order term over a renamed column, resumed
      const byName = await everyPage(store.entity('Item'), { orderBy: '$it.name' }, 2);
      assert.deepEqual(byName.items.map((item) => item.name), ['a', 'b', 'c', 'd', 'e']);
      assert.ok(byName.snapshots.every((snapshot) => snapshot === false), 'a mutable order key is live pagination');
      // the single-column keyset over a renamed unique key column
      const loaded = await store.entity('Item').load({ orderBy: '$it.id', after: 3 });
      assert.deepEqual(loaded.map((item) => item.id), [4, 5]);
    }
    finally { await close(); }
  });

  it('a renamed composite key of a bigint and a text column, two sequences one apart above 2^53', async () => {
    const { store, close } = await adopted(
      'CREATE TABLE pair(a TEXT, b INTEGER, PRIMARY KEY (b, a)) WITHOUT ROWID; '
      + "INSERT INTO pair VALUES ('x', 9007199254740993), ('y', 9007199254740993), ('x', 9007199254740994), "
      + "('x', 1), ('z', -9223372036854775808);",
      { Pair: { schema: { type: 'object', properties: { name: { type: 'string', ...key }, sequence: { type: 'string', ...key } } },
        physical: { table: 'pair', keys: ['sequence', 'name'], columns: {
          name: { name: 'a', codec: 'text', null: 'reject' }, sequence: { name: 'b', codec: 'bigint', null: 'reject' } } } } });
    try {
      for (const limit of [1, 2, 3]) {
        const { items, snapshots } = await everyPage(store.entity('Pair'), {}, limit);
        assert.deepEqual(items.map((item) => `${item.sequence}/${item.name}`), [
          '-9223372036854775808/z', '1/x', '9007199254740993/x', '9007199254740993/y', '9007199254740994/x',
        ], `limit ${limit}`);
        assert.ok(snapshots.every(Boolean));
      }
    }
    finally { await close(); }
  });

  it('a text key in code-point order, whatever collation the table declared, non-ASCII included', async () => {
    const { store, close } = await adopted(
      'CREATE TABLE word(w TEXT COLLATE NOCASE PRIMARY KEY); '
      + "INSERT INTO word VALUES ('b'), ('A'), ('é'), ('a2'), ('B2'), ('😀'), ('z');",
      { Word: { schema: { type: 'object', properties: { id: { type: 'string', ...key } } },
        physical: { table: 'word', columns: { id: { name: 'w', codec: 'text', null: 'reject' } } } } });
    try {
      const expected = ['A', 'B2', 'a2', 'b', 'z', 'é', '😀'];
      for (const limit of [1, 2, 4]) {
        const { items } = await everyPage(store.entity('Word'), {}, limit);
        assert.deepEqual(items.map((item) => item.id), expected, `limit ${limit}`);
      }
      // the load and the query order the column alike
      assert.deepEqual((await store.entity('Word').load({ orderBy: '$it.id' })).map((item) => item.id), expected);
      assert.deepEqual(await store.execute({ $for: { it: '$.Word[*]' }, $orderby: ['$it.id'], $return: '$it.id' }), expected);
      // the price, stated: a code-point comparison cannot seek a NOCASE index
      const plan = await store.entity('Word').explainLoad({ orderBy: '$it.id' });
      assert.match(plan.sql, /COLLATE BINARY/);
    }
    finally { await close(); }
  });

  it('a text key that does not survive its text encoding refuses before a continuation is built on it', async () => {
    const { store, close } = await adopted(
      "CREATE TABLE item(id TEXT PRIMARY KEY); INSERT INTO item VALUES ('a'), (CAST(X'ff' AS TEXT)), "
      + "(CAST(X'ff41' AS TEXT)), ('b');",
      { Item: { schema: { type: 'object', properties: { id: { type: 'string', ...key } } },
        physical: { table: 'item', columns: { id: { name: 'id', codec: 'text', null: 'reject' } } } } });
    try {
      const set = store.entity('Item');
      const unsound = (/** @type {any} */ error) => error.code === 'JD0032'
        && /cannot round-trip through its SQLite text encoding/.test(error.message);
      // the look-ahead that decides `hasMore` reads the malformed row already
      await assert.rejects(set.page({}, { limit: 2 }), unsound);
      // without it, the sound first page arrives, and the next one refuses
      const first = await set.page({}, { limit: 2, lookahead: false });
      assert.deepEqual(first.items.map((/** @type {any} */ item) => item.id), ['a', 'b']);
      await assert.rejects(set.page({}, { limit: 2, lookahead: false, after: first.continuation }), unsound);
      // a scalar `after` seeks past the caller's last value: the same proof
      await assert.rejects(set.load({ orderBy: '$it.id', after: 'a' }), unsound);
      // a plain load emits no continuation, and is not refused
      assert.equal((await set.load({})).length, 4);
      assert.equal((await set.load({ orderBy: '$it.id' })).length, 4);
    }
    finally { await close(); }
  });

  it('a nullable text order column holding NULLs pages as it loads, in both directions', async () => {
    const { store, close } = await adopted(
      'CREATE TABLE item(item_id INTEGER PRIMARY KEY, label TEXT); '
      + "INSERT INTO item VALUES (1, 'b'), (2, NULL), (3, 'a'), (4, NULL), (5, 'c');",
      { Item: { schema: { type: 'object', properties: { id: { type: 'integer', ...key }, name: { type: 'string' } } },
        physical: { table: 'item', columns: { id: { name: 'item_id', codec: 'integer', null: 'reject' },
          name: { name: 'label', codec: 'text', null: 'null' } } } } });
    try {
      const set = store.entity('Item');
      for (const [spec, expected] of /** @type {[any, number[]][]} */ ([
        [{ orderBy: '$it.name' }, [2, 4, 3, 1, 5]],
        [{ orderBy: { $key: '$it.name', $dir: 'desc' } }, [5, 1, 3, 2, 4]],
        [{ orderBy: { $key: '$it.name', $empty: 'greatest' } }, [3, 1, 5, 2, 4]],
      ])) {
        assert.deepEqual((await set.load(spec)).map((/** @type {any} */ item) => item.id), expected);
        for (const limit of [1, 2, 3]) {
          const { items } = await everyPage(set, spec, limit);
          assert.deepEqual(items.map((item) => item.id), expected, `${JSON.stringify(spec)} limit ${limit}`);
        }
      }
    }
    finally { await close(); }
  });

  it('a view is refused by name — it enforces no key, and a continuation past a repeated one would skip a row', async () => {
    const { store, close } = await adopted(
      'CREATE TABLE src(id INTEGER, label TEXT); '
      + "INSERT INTO src VALUES (1, 'a'), (2, 'b'), (2, 'b2'), (3, 'c'); "
      + 'CREATE VIEW v AS SELECT id, label FROM src;',
      { V: { schema: { type: 'object', properties: { id: { type: 'integer', ...key }, label: { type: 'string' } } },
        physical: { table: 'v', kind: 'view', columns: { id: { name: 'id', codec: 'integer', null: 'reject' },
          label: { name: 'label', codec: 'text', null: 'null' } } } } });
    try {
      const set = store.entity('V');
      const refused = (/** @type {any} */ error) => error.code === 'JD0032'
        && /a keyset continuation over a view is not qualified/.test(error.message);
      await assert.rejects(set.page({}, { limit: 1 }), refused);
      await assert.rejects(set.load({ orderBy: '$it.id', after: 1 }), refused);
      // a load emits no continuation: every row, the repeated key twice
      assert.deepEqual((await set.load({})).map((/** @type {any} */ row) => `${row.id}/${row.label}`).sort(),
        ['1/a', '2/b', '2/b2', '3/c']);
    }
    finally { await close(); }
  });

  it('explainLoad().order names the declared terms by property, and a physical table\'s key closes it', async () => {
    const { store, close } = await adopted(
      'CREATE TABLE item(item_id INTEGER PRIMARY KEY, label TEXT); '
      + "INSERT INTO item VALUES (1, 'a'), (2, 'b'), (3, 'c');",
      { Item: { schema: { type: 'object', properties: { id: { type: 'integer', ...key }, name: { type: 'string' } } },
        physical: { table: 'item', columns: { id: { name: 'item_id', codec: 'integer', null: 'reject' },
          name: { name: 'label', codec: 'text', null: 'null' } } } } });
    try {
      const set = store.entity('Item');
      const terms = (/** @type {any} */ plan) => plan.order.map((/** @type {any} */ term) =>
        `${term.source}:${term.column}${term.tieBreaker ? ' (tie)' : ''}`);
      for (const [spec, expected] of /** @type {[any, string[]][]} */ ([
        [{ orderBy: '$it.id' }, ['column:id']],
        [{ orderBy: '$it.name' }, ['column:name', 'column:id (tie)']],
        [{}, ['column:id (tie)']],
      ])) {
        const first = await set.page(spec, { limit: 1 });
        const paged = await set.explainLoad({ ...spec, after: first.continuation });
        assert.deepEqual(terms(paged), expected, `keyset ${JSON.stringify(spec)}`);
        // outside keyset mode the ORDER BY still ends with the key, not a row identity
        assert.deepEqual(terms(await set.explainLoad(spec)), expected, `load ${JSON.stringify(spec)}`);
      }
    }
    finally { await close(); }
  });

  it('a uuid key is refused by codec — it reads back lowercase, whatever the table stores', async () => {
    const { store, close } = await adopted(
      "CREATE TABLE token(id TEXT PRIMARY KEY); INSERT INTO token VALUES ('A0000000-0000-4000-8000-000000000000'), "
      + "('b0000000-0000-4000-8000-000000000000'), ('C0000000-0000-4000-8000-000000000000');",
      { Token: { schema: { type: 'object', properties: { id: { type: 'string', ...key } } },
        physical: { table: 'token', columns: { id: { name: 'id', codec: 'uuid', null: 'reject' } } } } });
    try {
      await assert.rejects(store.entity('Token').page({}, { limit: 1 }),
        (/** @type {any} */ error) => error.code === 'JD0032' && /'id' is a uuid column/.test(error.message));
      // reading every row without a continuation is unaffected
      assert.equal((await store.entity('Token').load({})).length, 3);
    }
    finally { await close(); }
  });
});
