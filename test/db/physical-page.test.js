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
 * `execute()` order a text column the same way: by code point. An
 * identity of NOT NULL terms in one direction compares as a row value,
 * which the key's index seeks; a term that can hold NULL, or directions
 * that differ, keep the null-aware expansion.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { adopted, everyPage, keyComparator } from './helpers.js';

const key = { 'x-entity': { key: true } };

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

describe('a keyset page over a physical table seeks as a row value', () => {
  it('every page sequence equals the oracle for limits 1, 2, 3 and 7 over integer, bigint, text and (bigint, text) keys', async () => {
    const { store, close } = await adopted(
      'CREATE TABLE item(item_id INTEGER PRIMARY KEY, label TEXT); '
      + "INSERT INTO item VALUES (5, 'e'), (1, 'a'), (3, 'c'), (2, 'b'), (4, 'd'), (-7, 'z'); "
      + 'CREATE TABLE big(id INTEGER PRIMARY KEY); '
      + 'INSERT INTO big VALUES (9007199254740993), (1), (9007199254740994), (-9223372036854775808), (0); '
      + 'CREATE TABLE word(w TEXT COLLATE NOCASE PRIMARY KEY); '
      + "INSERT INTO word VALUES ('b'), ('A'), ('é'), ('a2'), ('B2'), ('😀'), ('z'), ('￿'), (''); "
      + 'CREATE TABLE pair(a TEXT NOT NULL, b INTEGER NOT NULL, PRIMARY KEY (b, a)) WITHOUT ROWID; '
      + "INSERT INTO pair VALUES ('x', 9007199254740993), ('y', 9007199254740993), ('x', 9007199254740994), "
      + "('x', 1), ('z', -9223372036854775808), ('', 1);",
      {
        Item: { schema: { type: 'object', properties: { id: { type: 'integer', ...key }, name: { type: 'string' } } },
          physical: { table: 'item', columns: { id: { name: 'item_id', codec: 'integer', null: 'reject' },
            name: { name: 'label', codec: 'text', null: 'null' } } } },
        Big: { schema: { type: 'object', properties: { id: { type: 'string', ...key } } },
          physical: { table: 'big', columns: { id: { name: 'id', codec: 'bigint', null: 'reject' } } } },
        Word: { schema: { type: 'object', properties: { id: { type: 'string', ...key } } },
          physical: { table: 'word', columns: { id: { name: 'w', codec: 'text', null: 'reject' } } } },
        Pair: { schema: { type: 'object', properties: { name: { type: 'string', ...key }, sequence: { type: 'string', ...key } } },
          physical: { table: 'pair', keys: ['sequence', 'name'], columns: {
            name: { name: 'a', codec: 'text', null: 'reject' }, sequence: { name: 'b', codec: 'bigint', null: 'reject' } } } },
      });
    try {
      for (const [name, keys] of /** @type {[string, { property: string, codec: string }[]][]} */ ([
        ['Item', [{ property: 'id', codec: 'integer' }]],
        ['Big', [{ property: 'id', codec: 'bigint' }]],
        ['Word', [{ property: 'id', codec: 'text' }]],
        ['Pair', [{ property: 'sequence', codec: 'bigint' }, { property: 'name', codec: 'text' }]],
      ])) {
        const set = store.entity(name);
        // the oracle: the rows the engine answers, in the order it gives their decoded keys
        const oracle = (await store.execute({ $for: { it: `$.${name}[*]` }, $return: '$it' }, { pushdown: false }))
          .sort(keyComparator(keys));
        assert.ok(oracle.length >= 5, name);
        for (const limit of [1, 2, 3, 7]) {
          const { items, snapshots } = await everyPage(set, {}, limit);
          assert.deepEqual(items, oracle, `${name} limit ${limit}`);
          assert.ok(snapshots.every(Boolean), `${name}: a key order is a snapshot`);
        }
        const first = await set.page({}, { limit: 1 });
        assert.equal((await set.explainLoad({ after: first.continuation })).pagination, 'keyset');
      }
      // exact: code point orders U+FFFF before an astral character, where UTF-16 units would not
      assert.deepEqual((await everyPage(store.entity('Word'), {}, 2)).items.map((row) => row.id),
        ['', 'A', 'B2', 'a2', 'b', 'z', 'é', '￿', '😀']);
      // the composite key compares as ONE row value: both terms are key columns, ascending
      const pair = store.entity('Pair');
      const plan = await pair.explainLoad({ after: (await pair.page({}, { limit: 2 })).continuation });
      assert.match(plan.sql, /WHERE \("r"\."b", \("r"\."a" COLLATE BINARY\)\) > \(\?, \?\) ORDER BY "r"\."b" ASC NULLS FIRST, \("r"\."a" COLLATE BINARY\) ASC NULLS FIRST$/);
      // a one-term identity is the plain comparison it always was
      const item = store.entity('Item');
      assert.match((await item.explainLoad({ after: (await item.page({}, { limit: 2 })).continuation })).sql,
        /WHERE \("r"\."item_id" > \?\) ORDER BY "r"\."item_id" ASC NULLS FIRST$/);
    }
    finally { await close(); }
  });

  it('at 95% depth over 200,000 rows the page statement seeks the primary key (SEARCH, never SCAN)', async () => {
    const { store, dbPath, close } = await adopted(
      'CREATE TABLE pair(a TEXT NOT NULL, b INTEGER NOT NULL, label TEXT, PRIMARY KEY (b, a)) WITHOUT ROWID; '
      + 'WITH RECURSIVE g(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM g WHERE n < 200000) '
      + "INSERT INTO pair SELECT hex(randomblob(4)), n / 10, 'x' FROM g; ANALYZE;",
      { Pair: { schema: { type: 'object', properties: { name: { type: 'string', ...key }, seq: { type: 'integer', ...key }, label: { type: 'string' } } },
        physical: { table: 'pair', keys: ['seq', 'name'], columns: {
          name: { name: 'a', codec: 'text', null: 'reject' }, seq: { name: 'b', codec: 'integer', null: 'reject' },
          label: { name: 'label', codec: 'text', null: 'null' } } } } });
    try {
      const set = store.entity('Pair');
      const first = await set.page({}, { limit: 10 });
      assert.deepEqual(first.continuation.order, [{ column: 'seq', desc: false, nullsFirst: true }, { column: 'name', desc: false, nullsFirst: true }]);
      // 95% of the way down the key, and the statement's plan with the continuation's values written out in identity order
      const deep = { ...first.continuation, key: { seq: 19000, name: '8' } };
      const plan = await set.explainLoad({ after: deep });
      assert.equal(plan.pagination, 'keyset');
      assert.match(plan.sql, /WHERE \("r"\."b", \("r"\."a" COLLATE BINARY\)\) > \(\?, \?\) ORDER BY/);
      const raw = new DatabaseSync(dbPath);
      try {
        const steps = raw.prepare(`EXPLAIN QUERY PLAN ${plan.sql}`).all(19000, '8').map((row) => String(row.detail));
        assert.ok(steps.some((step) => step.startsWith('SEARCH r USING PRIMARY KEY')), steps.join(' | '));
        assert.ok(!steps.some((step) => step.startsWith('SCAN')), steps.join(' | '));
      }
      finally { raw.close(); }
      const page = await set.page({}, { limit: 10, after: deep });
      assert.equal(page.items.length, 10);
      assert.ok(page.items.every((row) => row.seq > 19000 || (row.seq === 19000 && row.name > '8')));
    }
    finally { await close(); }
  });

  it('a non-key term keeps the expansion where its column can hold NULL or the directions differ, and joins the row value where the catalog declares it NOT NULL', async () => {
    const { store, close } = await adopted(
      'CREATE TABLE item(item_id INTEGER PRIMARY KEY, label TEXT, rank INTEGER NOT NULL); '
      + "INSERT INTO item VALUES (1, 'b', 2), (2, 'a', 2), (3, 'c', 1);",
      { Item: { schema: { type: 'object', properties: { id: { type: 'integer', ...key }, name: { type: 'string' }, rank: { type: 'integer' } } },
        physical: { table: 'item', columns: { id: { name: 'item_id', codec: 'integer', null: 'reject' },
          name: { name: 'label', codec: 'text', null: 'reject' }, rank: { name: 'rank', codec: 'integer', null: 'null' } } } } });
    try {
      const set = store.entity('Item');
      const resumed = async (/** @type {any} */ spec) => set.explainLoad({ ...spec, after: (await set.page(spec, { limit: 1 })).continuation });
      // declared `reject`, but the catalog lets the column hold NULL: a row value would skip a stray NULL silently, so the expansion stays
      assert.match((await resumed({ orderBy: '$it.name' })).sql,
        /WHERE \(\("r"\."label" COLLATE BINARY\) > \? OR \(\("r"\."label" COLLATE BINARY\) = \? AND "r"\."item_id" > \?\)\)/);
      // the catalog's NOT NULL is the fact, whatever policy the model declares: a row value
      assert.match((await resumed({ orderBy: '$it.rank' })).sql,
        /WHERE \("r"\."rank", "r"\."item_id"\) > \(\?, \?\) ORDER BY "r"\."rank" ASC NULLS FIRST, "r"\."item_id" ASC NULLS FIRST$/);
      // the appended key ascends: a descending term makes the directions differ, and the expansion stays
      const descending = (await resumed({ orderBy: { $key: '$it.rank', $dir: 'desc' } })).sql;
      assert.match(descending, /"r"\."rank" < \?/);
      assert.match(descending, /"r"\."rank" = \? AND "r"\."item_id" > \?/);
      assert.doesNotMatch(descending, /\("r"\."rank", /);
      for (const [spec, expected] of /** @type {[any, number[]][]} */ ([
        [{ orderBy: '$it.name' }, [2, 1, 3]],
        [{ orderBy: '$it.rank' }, [3, 1, 2]],
        [{ orderBy: { $key: '$it.rank', $dir: 'desc' } }, [1, 2, 3]],
      ])) {
        for (const limit of [1, 2, 3]) {
          const { items } = await everyPage(set, spec, limit);
          assert.deepEqual(items.map((row) => row.id), expected, `${JSON.stringify(spec)} limit ${limit}`);
        }
      }
    }
    finally { await close(); }
  });

  it('an explicit orderBy over a bigint column stays refused: SQL orders it by value, the engine its decoded string by code point', async () => {
    const { store, close } = await adopted(
      'CREATE TABLE big(id INTEGER PRIMARY KEY, n INTEGER NOT NULL); INSERT INTO big VALUES (9007199254740993, 1), (10, 2), (9, 3);',
      { Big: { schema: { type: 'object', properties: { id: { type: 'string', ...key }, n: { type: 'integer' } } },
        physical: { table: 'big', columns: { id: { name: 'id', codec: 'bigint', null: 'reject' }, n: { name: 'n', codec: 'integer', null: 'reject' } } } } });
    try {
      const set = store.entity('Big');
      await assert.rejects(set.load({ orderBy: '$it.id' }),
        (/** @type {any} */ error) => error.code === 'JD0032' && /orderBy must address typed entity paths/.test(error.message));
      // the key still pages in key order, by value
      assert.deepEqual((await everyPage(set, {}, 2)).items.map((row) => row.id), ['9', '10', '9007199254740993']);
      // and the engine orders the decoded string by code point, which is why the two cannot be one order
      assert.deepEqual(await store.execute({ $for: { it: '$.Big[*]' }, $orderby: ['$it.id'], $return: '$it.id' }), ['10', '9', '9007199254740993']);
    }
    finally { await close(); }
  });
});
