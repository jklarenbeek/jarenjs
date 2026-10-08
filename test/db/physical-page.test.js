//@ts-check
/**
 * @file Keyset pages over physical (column-mapped) SQLite entities
 * (MODEL-FORMAT §10.5, §12): one identity model — a continuation names
 * PROPERTIES and carries decoded values, the SQL names the physical
 * columns and compares them as their codecs compare — so a renamed or
 * composite key, a bigint above 2^53 and a text key (whatever collation
 * the table declared) page without skipping or repeating a row. A text
 * key proves per row that it round-trips through the file's text
 * encoding, a uuid key pages by the spelling the table stores (its
 * continuation carries that text, not the lowercase value the entity
 * decodes to), and a codec whose decoded value does not compare as its
 * stored one is refused by name. An ordered `load()` and
 * `execute()` order a text column the same way: by code point. An
 * identity of NOT NULL terms in one direction compares as a row value,
 * which the key's index seeks; a term that can hold NULL, or directions
 * that differ, keep the null-aware expansion.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { compareCodePoints } from '@jarenjs/core/string';

import { adopted, everyPage, keyComparator } from './helpers.js';

const key = { 'x-entity': { key: true } };

/** Four spellings of three uuids: an entity decodes every one to lowercase. */
const UUID = {
  A: 'A0000000-0000-4000-8000-000000000000', a: 'a0000000-0000-4000-8000-000000000000',
  b: 'b0000000-0000-4000-8000-000000000000', C: 'C0000000-0000-4000-8000-000000000000',
};
/** A physical uuid key over `token`, and a text label that tells equal decoded keys apart. */
const tokens = { Token: { schema: { type: 'object', properties: { id: { type: 'string', ...key }, label: { type: 'string' } } },
  physical: { table: 'token', columns: { id: { name: 'id', codec: 'uuid', null: 'reject' },
    label: { name: 'label', codec: 'text', null: 'reject' } } } } };
/** The ids the database file stores, by code point: the order a stored-spelling keyset pages in.
 * @param {string} dbPath @param {string} [sql] @returns {string[]} */
const storedIds = (dbPath, sql = 'SELECT id FROM token') => {
  const raw = new DatabaseSync(dbPath);
  try { return raw.prepare(sql).all().map((row) => String(row.id)).sort(compareCodePoints); }
  finally { raw.close(); }
};

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

  it('a uuid key pages every stored row by its stored spelling, and its continuation carries that text', async () => {
    const { store, dbPath, close } = await adopted(
      'CREATE TABLE token(id TEXT PRIMARY KEY, label TEXT NOT NULL); '
      + `INSERT INTO token VALUES ('${UUID.A}', 'one'), ('${UUID.b}', 'two'), ('${UUID.C}', 'three');`, tokens);
    try {
      const set = store.entity('Token');
      // the table orders A, C, b by code point, and the entity reads them back as a, c, b
      const stored = storedIds(dbPath);
      assert.deepEqual(stored, [UUID.A, UUID.C, UUID.b]);
      const expected = stored.map((id) => id.toLowerCase());
      for (const limit of [1, 2, 3]) {
        const { items, snapshots } = await everyPage(set, {}, limit);
        assert.deepEqual(items.map((item) => item.id), expected, `limit ${limit}`);
        assert.ok(snapshots.every(Boolean), 'a key order is a snapshot');
      }
      // the continuation names the stored text and marks the term that resumes from it
      const first = await set.page({}, { limit: 1 });
      assert.deepEqual(first.items.map((item) => item.id), [UUID.A.toLowerCase()]);
      assert.deepEqual(first.continuation,
        { order: [{ column: 'id', desc: false, nullsFirst: true, stored: true }], keys: [], key: UUID.A });
      // resuming after the stored 'A0...' reads C0 and b0; a seek past the decoded 'a0...' would have skipped C0
      const rest = await set.page({}, { limit: 5, after: first.continuation });
      assert.deepEqual(rest.items.map((item) => item.id), [UUID.C.toLowerCase(), UUID.b]);
      assert.equal(rest.hasMore, false);
      assert.deepEqual((await set.load({ after: first.continuation })).map((item) => item.id), [UUID.C.toLowerCase(), UUID.b]);
      // the statement compares and orders the stored text by code point, and the identity says so
      const plan = await set.explainLoad({ after: first.continuation });
      assert.equal(plan.pagination, 'keyset');
      assert.deepEqual(plan.identity, [{ column: 'id', desc: false, nullsFirst: true, stored: true }]);
      assert.match(plan.sql, /WHERE \(\("r"\."id" COLLATE BINARY\) > \?\) ORDER BY \("r"\."id" COLLATE BINARY\) ASC NULLS FIRST$/);
      // reading without a continuation is unchanged: the key's order, and the engine's decoded order
      assert.deepEqual((await set.load({})).map((item) => item.id), expected);
      assert.deepEqual(await store.execute({ $for: { t: '$.Token[*]' }, $orderby: ['$t.id'], $return: '$t.id' }),
        [UUID.A, UUID.b, UUID.C].map((id) => id.toLowerCase()));
    }
    finally { await close(); }
  });

  it('a continuation without the stored spelling and a bare decoded key are refused JD0035; an explicit orderBy over the uuid stays refused', async () => {
    const { store, close } = await adopted(
      'CREATE TABLE token(id TEXT PRIMARY KEY, label TEXT NOT NULL); '
      + `INSERT INTO token VALUES ('${UUID.A}', 'one'), ('${UUID.b}', 'two'), ('${UUID.C}', 'three');`, tokens);
    try {
      const set = store.entity('Token');
      const first = await set.page({}, { limit: 1 });
      const refused = (/** @type {RegExp} */ message) => (/** @type {any} */ error) =>
        error.code === 'JD0035' && message.test(error.message);
      // the same ordering without the mark: a decoded value cannot be told from a stored one, so it resumes nowhere
      const unmarked = { ...first.continuation, order: [{ column: 'id', desc: false, nullsFirst: true }] };
      await assert.rejects(set.page({}, { limit: 5, after: unmarked }), refused(/this graph orders by \(id asc nulls first stored\)/));
      await assert.rejects(set.load({ after: unmarked }), refused(/this graph orders by \(id asc nulls first stored\)/));
      // a bare key: the decoded 'a0...' a caller reads off the entity
      await assert.rejects(set.page({}, { after: UUID.A.toLowerCase() }), refused(/not a bare key/));
      // the stored text is text
      await assert.rejects(set.page({}, { after: { ...first.continuation, key: 7 } }), refused(/'id' resumes from its stored text/));
      // an explicit order stays refused: load() and execute() order alike, and the engine orders the decoded value
      for (const attempt of [() => set.load({ orderBy: '$it.id' }), () => set.load({ orderBy: '$it.id', after: UUID.a }),
        () => set.page({ orderBy: '$it.id' }, { limit: 1 })]) {
        await assert.rejects(attempt(),
          (/** @type {any} */ error) => error.code === 'JD0032' && /orderBy must address typed entity paths/.test(error.message));
      }
    }
    finally { await close(); }
  });

  it('mixed-case duplicates page once each, and a NOCASE-declared column does not reorder them: pages, load() and execute() agree', async () => {
    // the NOCASE column keeps a BINARY primary-key index, so 'A0...' and 'a0...' are two rows of one table
    for (const [declared, collation] of [['id TEXT PRIMARY KEY, label TEXT NOT NULL', 'default collation'],
      ['id TEXT COLLATE NOCASE NOT NULL, label TEXT NOT NULL, PRIMARY KEY (id COLLATE BINARY)', 'NOCASE']]) {
      const { store, dbPath, close } = await adopted(
        `CREATE TABLE token(${declared}); `
        + `INSERT INTO token VALUES ('${UUID.A}', 'one'), ('${UUID.a}', 'two'), ('${UUID.b}', 'three'), ('${UUID.C}', 'four');`, tokens);
      try {
        const set = store.entity('Token');
        // the table stores four rows of three decoded ids: A and a are two rows and one decoded key
        const rows = await set.load({});
        assert.equal(rows.length, 4, collation);
        assert.equal(new Set(rows.map((row) => row.id)).size, 3, collation);
        // by code point of the stored text: A, C, a, b
        const stored = storedIds(dbPath);
        assert.deepEqual(stored, [UUID.A, UUID.C, UUID.a, UUID.b]);
        const labels = ['one', 'four', 'two', 'three'];
        for (const limit of [1, 2, 3, 4]) {
          const { items } = await everyPage(set, {}, limit);
          assert.deepEqual(items.map((item) => item.label), labels, `${collation}: limit ${limit}`);
          assert.deepEqual(items.map((item) => item.id), stored.map((id) => id.toLowerCase()), `${collation}: limit ${limit}`);
        }
        // each continuation names the spelling its row stores: A, then C, then a (not A again), then b
        /** @type {any[]} */
        const keys = [];
        /** @type {any} */
        let after;
        for (;;) {
          const page = await set.page({}, { limit: 1, ...(after === undefined ? {} : { after }) });
          keys.push(page.continuation.key);
          if (!page.hasMore) break;
          after = page.continuation;
        }
        assert.deepEqual(keys, stored, collation);
        // load(), the native plan and the residual read the rows in that order too
        assert.deepEqual(rows.map((row) => row.label), labels, collation);
        const query = { $for: { t: '$.Token[*]' }, $return: '$t.label' };
        assert.deepEqual(await store.execute(query), labels, collation);
        assert.deepEqual(await store.execute(query, { pushdown: false }), labels, collation);
        const explained = await store.explain(query);
        assert.equal(explained.mode, 'native', collation);
        assert.match(explained.sql, /ORDER BY \("t0"\."id" COLLATE BINARY\)$/);
        // and a page compares the stored text by code point whatever the column declares
        const plan = await set.explainLoad({ after: (await set.page({}, { limit: 1 })).continuation });
        assert.match(plan.sql, /\("r"\."id" COLLATE BINARY\) > \?/, collation);
      }
      finally { await close(); }
    }
  });

  it('a declared order term resumes beside the stored key: ascending as one row value, descending as the expansion', async () => {
    const { store, dbPath, close } = await adopted(
      'CREATE TABLE token(id TEXT PRIMARY KEY, label TEXT NOT NULL); '
      + `INSERT INTO token VALUES ('${UUID.A}', 'x'), ('${UUID.a}', 'x'), ('${UUID.b}', 'y'), ('${UUID.C}', 'x');`, tokens);
    try {
      const set = store.entity('Token');
      const raw = new DatabaseSync(dbPath);
      /** @type {{ label: string, stored: string }[]} */
      let rows;
      try { rows = raw.prepare('SELECT label, id AS stored FROM token').all().map((row) => ({ label: String(row.label), stored: String(row.stored) })); }
      finally { raw.close(); }
      for (const [spec, direction] of /** @type {[any, number][]} */ ([
        [{ orderBy: '$it.label' }, 1], [{ orderBy: { $key: '$it.label', $dir: 'desc' } }, -1],
      ])) {
        // the label by direction, then the stored text ascending: the key is appended ascending
        const ordered = [...rows].sort((a, b) => direction * compareCodePoints(a.label, b.label) || compareCodePoints(a.stored, b.stored));
        const oracle = ordered.map((row) => `${row.label}/${row.stored.toLowerCase()}`);
        for (const limit of [1, 2, 3, 4]) {
          const { items } = await everyPage(set, spec, limit);
          assert.deepEqual(items.map((item) => `${item.label}/${item.id}`), oracle, `${JSON.stringify(spec)} limit ${limit}`);
        }
        // the declared term is the document's value, the key the text its row holds, and only the key's term is marked
        const first = await set.page(spec, { limit: 1 });
        assert.deepEqual(first.continuation.keys, [ordered[0].label]);
        assert.equal(first.continuation.key, ordered[0].stored);
        assert.deepEqual(first.continuation.order.map((/** @type {any} */ term) => term.stored), [undefined, true]);
      }
      // ascending, both terms cannot hold NULL: one row value over the label and the stored text
      const ascending = await set.explainLoad({ orderBy: '$it.label', after: (await set.page({ orderBy: '$it.label' }, { limit: 1 })).continuation });
      assert.match(ascending.sql, /WHERE \(\("r"\."label" COLLATE BINARY\), \("r"\."id" COLLATE BINARY\)\) > \(\?, \?\)/);
    }
    finally { await close(); }
  });

  it('a composite (text, uuid) key pages like the oracle for limits 1, 2, 3 and 7, the uuid ordering the rows of one text value', async () => {
    const { store, dbPath, close } = await adopted(
      'CREATE TABLE tagged(grp TEXT NOT NULL, tok TEXT NOT NULL, PRIMARY KEY (grp, tok)) WITHOUT ROWID; '
      + `INSERT INTO tagged VALUES ('x', '${UUID.b}'), ('x', '${UUID.A}'), ('x', '${UUID.C}'), ('x', '${UUID.a}'), `
      + `('y', '${UUID.A}'), ('y', '${UUID.a}'), ('w', '${UUID.C}'), ('é', '${UUID.b}');`,
      { Tagged: { schema: { type: 'object', properties: { bucket: { type: 'string', ...key }, id: { type: 'string', ...key } } },
        physical: { table: 'tagged', keys: ['bucket', 'id'], columns: {
          bucket: { name: 'grp', codec: 'text', null: 'reject' }, id: { name: 'tok', codec: 'uuid', null: 'reject' } } } } });
    try {
      const set = store.entity('Tagged');
      // the oracle: the stored rows by (text, stored uuid), both by code point
      const raw = new DatabaseSync(dbPath);
      /** @type {{ bucket: string, id: string }[]} */
      let oracle;
      try {
        oracle = raw.prepare('SELECT grp, tok FROM tagged').all()
          .map((row) => ({ bucket: String(row.grp), stored: String(row.tok) }))
          .sort((a, b) => compareCodePoints(a.bucket, b.bucket) || compareCodePoints(a.stored, b.stored))
          .map((row) => ({ bucket: row.bucket, id: row.stored.toLowerCase() }));
      }
      finally { raw.close(); }
      assert.equal(oracle.length, 8);
      for (const limit of [1, 2, 3, 7]) {
        const { items, snapshots } = await everyPage(set, {}, limit);
        assert.deepEqual(items.map((item) => ({ bucket: item.bucket, id: item.id })), oracle, `limit ${limit}`);
        assert.ok(snapshots.every(Boolean), `limit ${limit}: a key order is a snapshot`);
      }
      // the continuation names each key column's stored text, and only the uuid term is marked
      const third = await set.page({}, { limit: 3 });
      assert.deepEqual(third.continuation, {
        order: [{ column: 'bucket', desc: false, nullsFirst: true }, { column: 'id', desc: false, nullsFirst: true, stored: true }],
        keys: [], key: { bucket: 'x', id: UUID.C } });
      // both terms are keys that cannot hold NULL: one row value, each compared by code point
      const plan = await set.explainLoad({ after: third.continuation });
      assert.match(plan.sql, /WHERE \(\("r"\."grp" COLLATE BINARY\), \("r"\."tok" COLLATE BINARY\)\) > \(\?, \?\) ORDER BY \("r"\."grp" COLLATE BINARY\) ASC NULLS FIRST, \("r"\."tok" COLLATE BINARY\) ASC NULLS FIRST$/);
    }
    finally { await close(); }
  });

  it('a predicate or an ordering over a uuid column stays in the engine, so the stored-text comparison reaches keys and nothing else', async () => {
    const { store, close } = await adopted(
      'CREATE TABLE token(id TEXT PRIMARY KEY, label TEXT NOT NULL); '
      + `INSERT INTO token VALUES ('${UUID.A}', 'one'), ('${UUID.b}', 'two');`, tokens);
    try {
      for (const [query, expected] of /** @type {[any, string | string[]][]} */ ([
        // the engine compares decoded values: the stored 'A0...' answers a predicate on 'a0...' (one item is not a sequence)
        [{ $for: { t: '$.Token[*]' }, $where: { $eq: ['$t.id', UUID.a] }, $return: '$t.label' }, 'one'],
        [{ $for: { t: '$.Token[*]' }, $orderby: [{ $key: '$t.id', $dir: 'desc' }], $return: '$t.label' }, ['two', 'one']],
      ])) {
        assert.equal((await store.explain(query)).mode, 'set', JSON.stringify(query));
        assert.deepEqual(await store.execute(query), expected, JSON.stringify(query));
      }
    }
    finally { await close(); }
  });

  it('a codec whose decoded value need not compare as its stored one is refused by name as an order term', async () => {
    const { store, close } = await adopted(
      "CREATE TABLE item(item_id INTEGER PRIMARY KEY, day TEXT, ratio REAL); INSERT INTO item VALUES (1, '2026-01-02', 1.5);",
      { Item: { schema: { type: 'object', properties: { id: { type: 'integer', ...key }, day: { type: 'string' }, ratio: { type: 'number' } } },
        physical: { table: 'item', columns: { id: { name: 'item_id', codec: 'integer', null: 'reject' },
          day: { name: 'day', codec: 'date', null: 'null' }, ratio: { name: 'ratio', codec: 'number', null: 'null' } } } } });
    try {
      for (const [property, codec] of [['day', 'date'], ['ratio', 'number']]) {
        await assert.rejects(store.entity('Item').page({ orderBy: `$it.${property}` }, { limit: 1 }),
          (/** @type {any} */ error) => error.code === 'JD0032'
            && error.message.includes('orders by integer, bigint, text and uuid columns')
            && error.message.includes(`'${property}' is a ${codec} column`));
      }
      assert.equal((await store.entity('Item').load({})).length, 1);
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
