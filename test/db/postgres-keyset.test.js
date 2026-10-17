//@ts-check
/**
 * @file Keyset pages over physical PostgreSQL entities (MODEL-FORMAT
 * §10.5, §12): the one identity model SQLite's pages follow — a
 * continuation names PROPERTIES and carries decoded values, the SQL names
 * the physical columns and compares each as its codec compares — over
 * integer, bigint (bound as its exact decimal string), text and uuid keys
 * (a native uuid orders as the code-point order of its lowercase text).
 * An identity of NOT NULL terms in one direction compares as a row value,
 * which the key's index seeks; a text term addresses the bare column where
 * its collation is a code-point one and `COLLATE "C"` otherwise (correct,
 * unseekable, visible in `explainLoad().sql`); a text keyset requires the
 * UTF8 database encoding, read at open, where no per-row byte proof runs.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { adoptedPostgres, everyPage, keyComparator } from './helpers.js';

const url = process.env.JAREN_PG_URL;
const key = { 'x-entity': { key: true } };
/** @param {string} name @param {string} codec @param {string} [policy] */
const column = (name, codec, policy = 'reject') => ({ name, codec, null: policy });
const UUIDS = ['0f000000-0000-4000-8000-000000000000', 'a0000000-0000-4000-8000-000000000000',
  'b0000000-0000-4000-8000-000000000000', 'c0000000-0000-4000-8000-000000000000'];

/** Every key shape, its rows written out of order, uuids in both cases. */
const KEYS_DDL = `CREATE TABLE item(item_id integer PRIMARY KEY, label text);
  INSERT INTO item VALUES (5, 'e'), (1, 'a'), (3, 'c'), (2, 'b'), (4, 'd'), (-7, 'z');
  CREATE TABLE big(id bigint PRIMARY KEY);
  INSERT INTO big VALUES (9007199254740993), (1), (9007199254740994), (-9223372036854775808), (0);
  CREATE TABLE word(w text PRIMARY KEY);
  INSERT INTO word VALUES ('b'), ('A'), ('é'), ('a2'), ('B2'), ('😀'), ('z'), (U&'\\FFFF'), ('');
  CREATE TABLE pair(a text NOT NULL, b bigint NOT NULL, PRIMARY KEY (b, a));
  INSERT INTO pair VALUES ('x', 9007199254740993), ('y', 9007199254740993), ('x', 9007199254740994), ('x', 1), ('z', -9223372036854775808), ('', 1);
  CREATE TABLE token(id uuid PRIMARY KEY);
  INSERT INTO token VALUES ('A0000000-0000-4000-8000-000000000000'), ('b0000000-0000-4000-8000-000000000000'),
    ('C0000000-0000-4000-8000-000000000000'), ('0F000000-0000-4000-8000-000000000000');
  CREATE TABLE tagged(seq bigint NOT NULL, id uuid NOT NULL, owner uuid, label text, PRIMARY KEY (seq, id));
  INSERT INTO tagged VALUES (1, 'c0000000-0000-4000-8000-000000000000', NULL, NULL), (1, 'A0000000-0000-4000-8000-000000000000', NULL, 'x'),
    (9007199254740993, 'b0000000-0000-4000-8000-000000000000', 'a0000000-0000-4000-8000-000000000000', NULL);`;
const KEYS_ENTITIES = {
  Item: { schema: { type: 'object', properties: { id: { type: 'integer', ...key }, name: { type: 'string' } } },
    physical: { table: 'item', columns: { id: column('item_id', 'integer'), name: column('label', 'text', 'null') } } },
  Big: { schema: { type: 'object', properties: { id: { type: 'string', ...key } } },
    physical: { table: 'big', columns: { id: column('id', 'bigint') } } },
  Word: { schema: { type: 'object', properties: { id: { type: 'string', ...key } } },
    physical: { table: 'word', columns: { id: column('w', 'text') } } },
  Pair: { schema: { type: 'object', properties: { name: { type: 'string', ...key }, sequence: { type: 'string', ...key } } },
    physical: { table: 'pair', keys: ['sequence', 'name'], columns: { name: column('a', 'text'), sequence: column('b', 'bigint') } } },
  Token: { schema: { type: 'object', properties: { id: { type: 'string', ...key } } },
    physical: { table: 'token', columns: { id: column('id', 'uuid') } } },
  Tagged: { schema: { type: 'object', properties: { sequence: { type: 'string', ...key }, id: { type: 'string', ...key },
    owner: { type: 'string' }, label: { type: 'string' } } },
  physical: { table: 'tagged', keys: ['sequence', 'id'], columns: { sequence: column('seq', 'bigint'), id: column('id', 'uuid'),
    owner: column('owner', 'uuid', 'null'), label: column('label', 'text', 'null') } } },
};

/** The six words of the collation fixtures, in code-point order. */
const WORDS = ['A', 'B2', 'a2', 'b', 'z', 'é'];
const WORDS_DDL = (/** @type {string} */ table, /** @type {string} */ collation) =>
  `CREATE TABLE ${table}(w text${collation} PRIMARY KEY, n integer NOT NULL);
   INSERT INTO ${table} VALUES ('b', 1), ('A', 2), ('é', 3), ('a2', 4), ('B2', 5), ('z', 6);`;
const wordEntity = (/** @type {string} */ table) => ({
  schema: { type: 'object', properties: { id: { type: 'string', ...key }, n: { type: 'integer' } } },
  physical: { table, columns: { id: column('w', 'text'), n: column('n', 'integer') } } });

/**
 * A driver whose connection answers the catalog's row of the database as
 * `catalog` rewrites it: what the open reads of the database's encoding,
 * scripted (a test owns schemas, never a database of another encoding).
 * @param {(metadata: any) => any} catalog
 */
const scriptedCatalog = (catalog) => (/** @type {(...args: any[]) => any} */ open) => async (/** @type {any[]} */ ...args) => {
  const connection = await open(...args);
  return { ...connection, get mustQueue() { return connection.mustQueue; },
    prepare: async (/** @type {string} */ sql, /** @type {any} */ options) => {
      const statement = await connection.prepare(sql, options);
      if (!sql.includes('pg_encoding_to_char')) return statement;
      return new Proxy(statement, { get(target, property) {
        if (property === 'all') {
          return async (/** @type {any[]} */ params) => (await target.all(params)).map((/** @type {any} */ row) => (row.type === 'schema'
            ? { ...row, metadata: JSON.stringify(catalog(JSON.parse(String(row.metadata)))) } : row));
        }
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
    } };
};

describe('a keyset page over a physical PostgreSQL table', { skip: !url && 'JAREN_PG_URL is not set' }, () => {
  it('every page sequence equals the oracle for limits 1, 2, 3 and 7 over integer, bigint, text, (bigint, text), uuid and (bigint, uuid) keys', async () => {
    const { store, close } = await adoptedPostgres(KEYS_DDL, KEYS_ENTITIES);
    try {
      for (const [name, keys] of /** @type {[string, { property: string, codec: string }[]][]} */ ([
        ['Item', [{ property: 'id', codec: 'integer' }]],
        ['Big', [{ property: 'id', codec: 'bigint' }]],
        ['Word', [{ property: 'id', codec: 'text' }]],
        ['Pair', [{ property: 'sequence', codec: 'bigint' }, { property: 'name', codec: 'text' }]],
        ['Token', [{ property: 'id', codec: 'uuid' }]],
        ['Tagged', [{ property: 'sequence', codec: 'bigint' }, { property: 'id', codec: 'uuid' }]],
      ])) {
        const set = store.entity(name);
        // the oracle: the rows the engine answers, in the order it gives their decoded keys
        const oracle = (await store.execute({ $for: { it: `$.${name}[*]` }, $return: '$it' }, { pushdown: false }))
          .sort(keyComparator(keys));
        assert.ok(oracle.length >= 3, name);
        for (const limit of [1, 2, 3, 7]) {
          const { items, snapshots } = await everyPage(set, {}, limit);
          assert.deepEqual(items, oracle, `${name} limit ${limit}`);
          assert.ok(snapshots.every(Boolean), `${name}: a key order is a snapshot`);
        }
        const first = await set.page({}, { limit: 1 });
        assert.equal((await set.explainLoad({ after: first.continuation })).pagination, 'keyset');
      }
      // exact: a native uuid orders as the code-point order of its lowercase text, whatever case the rows were written in
      assert.deepEqual((await everyPage(store.entity('Token'), {}, 3)).items.map((row) => row.id), UUIDS);
      // exact: text in code-point order, U+FFFF before an astral character
      assert.deepEqual((await everyPage(store.entity('Word'), {}, 2)).items.map((row) => row.id),
        ['', 'A', 'B2', 'a2', 'b', 'z', 'é', '￿', '😀']);
      // exact: two bigint sequences one apart above 2^53
      assert.deepEqual((await everyPage(store.entity('Pair'), {}, 2)).items.map((row) => `${row.sequence}/${row.name}`),
        ['-9223372036854775808/z', '1/', '1/x', '9007199254740993/x', '9007199254740993/y', '9007199254740994/x']);
      assert.deepEqual((await everyPage(store.entity('Tagged'), {}, 2)).items.map((row) => `${row.sequence}/${row.id}`),
        [`1/${UUIDS[1]}`, `1/${UUIDS[3]}`, `9007199254740993/${UUIDS[2]}`]);
      // the composite keys compare as ONE row value, bound positionally; a one-term identity is the plain comparison
      const pair = store.entity('Pair');
      assert.match((await pair.explainLoad({ after: (await pair.page({}, { limit: 2 })).continuation })).sql,
        /WHERE \("r"\."b", "r"\."a"\) > \(\$1, \$2\) ORDER BY "r"\."b" ASC NULLS FIRST, "r"\."a" ASC NULLS FIRST$/);
      const tagged = store.entity('Tagged');
      assert.match((await tagged.explainLoad({ after: (await tagged.page({}, { limit: 2 })).continuation })).sql,
        /WHERE \("r"\."seq", "r"\."id"\) > \(\$1, \$2\) ORDER BY "r"\."seq" ASC NULLS FIRST, "r"\."id" ASC NULLS FIRST$/);
      const token = store.entity('Token');
      assert.match((await token.explainLoad({ after: (await token.page({}, { limit: 2 })).continuation })).sql,
        /WHERE \("r"\."id" > \$1\) ORDER BY "r"\."id" ASC NULLS FIRST$/);
    }
    finally { await close(); }
  });

  it('a managed entity with a composite key pages it as a row value, and a declared term keeps the expansion', async () => {
    const { store, close } = await adoptedPostgres('', { Line: { schema: { type: 'object', required: ['order', 'seq'], properties: {
      order: { type: 'integer', ...key }, seq: { type: 'integer', ...key }, qty: { type: 'integer', 'x-entity': { index: true } } } } } },
    { label: 'managed', adopt: false });
    try {
      const lines = store.entity('Line');
      for (const order of [1, 2, 3]) for (const seq of [1, 2]) await lines.create({ order, seq, qty: order === 2 ? 5 : 3 });
      for (const limit of [1, 2, 3, 7]) {
        const { items } = await everyPage(lines, {}, limit);
        assert.deepEqual(items.map((row) => `${row.order}/${row.seq}`), ['1/1', '1/2', '2/1', '2/2', '3/1', '3/2'], `limit ${limit}`);
      }
      const first = await lines.page({}, { limit: 2 });
      const explained = await lines.explainLoad({ after: first.continuation });
      assert.equal(explained.pagination, 'keyset');
      assert.match(explained.sql, /WHERE \("r"\."order", "r"\."seq"\) > \(\$1, \$2\) ORDER BY "r"\."order" ASC NULLS FIRST, "r"\."seq" ASC NULLS FIRST$/);
      // a declared term of a managed entity can hold NULL: the expansion, the key appended whole
      const byQty = await lines.explainLoad({ orderBy: '$it.qty', after: (await lines.page({ orderBy: '$it.qty' }, { limit: 1 })).continuation });
      // the `integer` term reads the double a writer's digits stand for, the key columns bare
      assert.match(byQty.sql.replace(/\(CASE WHEN abs\(("r"\."\w+")\) < .*? END\)/g, 'double($1)'),
        /WHERE \(double\("r"\."qty"\) > \$1 OR \(double\("r"\."qty"\) = \$2 AND "r"\."order" > \$3\) OR \(double\("r"\."qty"\) = \$4 AND "r"\."order" = \$5 AND "r"\."seq" > \$6\)\)/);
      assert.deepEqual((await everyPage(lines, { orderBy: '$it.qty' }, 2)).items.map((row) => `${row.order}/${row.seq}`),
        ['1/1', '1/2', '3/1', '3/2', '2/1', '2/2']);
    }
    finally { await close(); }
  });

  it('at 95% depth over 200,000 rows the page statement seeks the key index as a row value, over a default-collated text key', async () => {
    const { store, pool, close } = await adoptedPostgres(
      'CREATE TABLE kv(a integer NOT NULL, b text NOT NULL, PRIMARY KEY (a, b)); '
      + 'INSERT INTO kv SELECT g / 10, md5(g::text) FROM generate_series(1, 200000) g; ANALYZE kv;',
      { Kv: { schema: { type: 'object', properties: { seq: { type: 'integer', ...key }, name: { type: 'string', ...key } } },
        physical: { table: 'kv', keys: ['seq', 'name'], columns: { seq: column('a', 'integer'), name: column('b', 'text') } } } },
      { label: 'depth' });
    try {
      const set = store.entity('Kv');
      const first = await set.page({}, { limit: 10 });
      const deep = { ...first.continuation, key: { seq: 19000, name: '8' } };
      // the page's own statement: the continuation and the page's limit
      const plan = await set.explainLoad({ after: deep, take: 10 });
      assert.equal(plan.pagination, 'keyset');
      // this database's default collation is a code-point one, so the text term is the bare column: no COLLATE, and no byte projection
      assert.match(plan.sql, /WHERE \("r"\."a", "r"\."b"\) > \(\$1, \$2\) ORDER BY "r"\."a" ASC NULLS FIRST, "r"\."b" ASC NULLS FIRST/);
      assert.doesNotMatch(plan.sql, /COLLATE|BLOB/);
      // the continuation's values, written out in identity order: the row value is the key index's condition, and no filter removes rows
      const explained = (await pool.query({ text: `EXPLAIN ${plan.sql}`, values: [19000, '8'] })).rows.map((row) => row['QUERY PLAN']).join('\n');
      assert.match(explained, /Index Cond: \(ROW\(a, b\) > ROW\(19000, '8'::text\)\)/);
      assert.doesNotMatch(explained, /Filter:/);
      const page = await set.page({}, { limit: 10, after: deep });
      assert.equal(page.items.length, 10);
      assert.ok(page.items.every((row) => row.seq > 19000 || (row.seq === 19000 && row.name > '8')));
    }
    finally { await close(); }
  });

  it('a text key of another collation pages in code-point order under COLLATE "C", which its index cannot serve; every comparison that is not a load\'s term keeps COLLATE "C"', async () => {
    const { store, close } = await adoptedPostgres(
      `${WORDS_DDL('word', ' COLLATE "unicode"')} ${WORDS_DDL('plain', '')} ${WORDS_DDL('cword', ' COLLATE "C"')}`,
      { Word: wordEntity('word'), Plain: wordEntity('plain'), Cword: wordEntity('cword') },
      { label: 'collation' });
    try {
      for (const [name, priced] of /** @type {[string, boolean][]} */ ([['Word', true], ['Plain', false], ['Cword', false]])) {
        const set = store.entity(name);
        for (const limit of [1, 2, 4]) {
          assert.deepEqual((await everyPage(set, {}, limit)).items.map((row) => row.id), WORDS, `${name} limit ${limit}`);
        }
        const plan = await set.explainLoad({ after: (await set.page({}, { limit: 1 })).continuation });
        // the price, visible where it is paid: a collation that is not code point compares under COLLATE "C"
        assert.equal(/COLLATE "C"/.test(plan.sql), priced, plan.sql);
        assert.doesNotMatch(plan.sql, /BLOB/);
        // the load and the query order the column alike, and a scalar `after` seeks past the caller's value
        assert.deepEqual((await set.load({ orderBy: '$it.id' })).map((row) => row.id), WORDS, name);
        assert.deepEqual(await store.execute({ $for: { it: `$.${name}[*]` }, $orderby: ['$it.id'], $return: '$it.id' }), WORDS, name);
        assert.deepEqual((await set.load({ orderBy: '$it.id', after: 'a2' })).map((row) => row.id), ['b', 'z', 'é'], name);
      }
      // a predicate, the ordering of a query and a join edge over physical text columns keep COLLATE "C", whatever the column's collation
      const spelled = (/** @type {string} */ sql) => (sql.match(/\."w"\)::text COLLATE "C"\)/g) ?? []).length;
      const gt = { $for: { it: '$.Plain[*]' }, $where: { $gt: ['$it.id', 'a2'] }, $orderby: ['$it.id'], $return: '$it.id' };
      const gtPlan = await store.explain(gt);
      assert.equal(gtPlan.mode, 'native');
      assert.ok(spelled(gtPlan.sql) >= 2, gtPlan.sql);
      assert.deepEqual(await store.execute(gt), ['b', 'z', 'é']);
      const join = { $for: { p: '$.Plain[*]', c: '$.Cword[*]' }, $where: { $eq: ['$p.id', '$c.id'] }, $orderby: ['$p.id'], $return: '$p.n' };
      const joinPlan = await store.explain(join);
      assert.equal(joinPlan.mode, 'native');
      assert.ok(spelled(joinPlan.sql) >= 3, joinPlan.sql);
      assert.deepEqual(await store.execute(join), [2, 5, 4, 1, 6, 3]);
    }
    finally { await close(); }
  });

  it('a collation a user made and called "C" is read as the collation it is, not by its name: the load and the query order the column alike', async () => {
    // the schema's own "C" is an ICU collation; the server's, in pg_catalog, is not the one the column names
    const { store, close } = await adoptedPostgres(
      `CREATE COLLATION "C" (provider = icu, locale = 'und');
       DO $$ BEGIN EXECUTE format('CREATE TABLE spoof(w text COLLATE %I.%I PRIMARY KEY, n integer NOT NULL)', current_schema(), 'C'); END $$;
       INSERT INTO spoof VALUES ('b', 1), ('A', 2), ('é', 3), ('a2', 4), ('B2', 5), ('z', 6);`,
      { Spoof: wordEntity('spoof') }, { label: 'spoof' });
    try {
      const set = store.entity('Spoof');
      for (const limit of [1, 2, 4]) {
        assert.deepEqual((await everyPage(set, {}, limit)).items.map((row) => row.id), WORDS, `limit ${limit}`);
      }
      assert.deepEqual((await set.load({ orderBy: '$it.id' })).map((row) => row.id), WORDS);
      assert.deepEqual(await store.execute({ $for: { it: '$.Spoof[*]' }, $orderby: ['$it.id'], $return: '$it.id' }), WORDS);
      // the price of a collation that is not known to be code point, visible where it is paid
      const plan = await set.explainLoad({ after: (await set.page({}, { limit: 1 })).continuation });
      assert.match(plan.sql, /COLLATE "C"/, plan.sql);
    }
    finally { await close(); }
  });

  it('a text keyset requires the UTF8 database encoding, read at open: a catalog answering SQL_ASCII refuses it by name before any statement, and an integer key still pages', async () => {
    /** @type {string[]} */
    const statements = [];
    const { store, close } = await adoptedPostgres(
      "CREATE TABLE word(w text PRIMARY KEY); INSERT INTO word VALUES ('a'), ('b'); CREATE TABLE item(id integer PRIMARY KEY); INSERT INTO item VALUES (1), (2);",
      { Word: { schema: { type: 'object', properties: { id: { type: 'string', ...key } } }, physical: { table: 'word', columns: { id: column('w', 'text') } } },
        Item: { schema: { type: 'object', properties: { id: { type: 'integer', ...key } } }, physical: { table: 'item', columns: { id: column('id', 'integer') } } } },
      { label: 'encoding', statements, open: scriptedCatalog((metadata) => ({ ...metadata, encoding: 'SQL_ASCII' })) });
    try {
      const word = store.entity('Word');
      const refused = (/** @type {any} */ error) => error.code === 'JD0032' && /UTF8/.test(error.message) && /SQL_ASCII/.test(error.message);
      const sent = statements.length;
      await assert.rejects(() => word.page({}, { limit: 1 }), refused);
      await assert.rejects(() => word.load({ orderBy: '$it.id', after: 'a' }), refused);
      await assert.rejects(async () => word.explainLoad({ after: { order: [{ column: 'id', desc: false, nullsFirst: true }], keys: [], key: 'a' } }), refused);
      assert.equal(statements.length, sent, 'refused before any statement');
      assert.deepEqual((await everyPage(store.entity('Item'), {}, 1)).items.map((row) => row.id), [1, 2]);
      // a load without a continuation seeks nothing, and still answers
      assert.deepEqual((await word.load({ orderBy: '$it.id' })).map((row) => row.id), ['a', 'b']);
    }
    finally { await close(); }
  });

  it('an explicit orderBy over a uuid column orders natively as execute() orders the decoded text; a bigint column stays refused, and no native predicate widens', async () => {
    const { store, close } = await adoptedPostgres(KEYS_DDL, KEYS_ENTITIES, { label: 'order' });
    try {
      const token = store.entity('Token');
      assert.deepEqual((await token.load({ orderBy: '$it.id' })).map((row) => row.id), UUIDS);
      assert.deepEqual((await token.load({ orderBy: { $key: '$it.id', $dir: 'desc' } })).map((row) => row.id), [...UUIDS].reverse());
      const ordered = { $for: { it: '$.Token[*]' }, $orderby: ['$it.id'], $return: '$it.id' };
      assert.deepEqual(await store.execute(ordered), UUIDS);
      // the engine orders the decoded text; the load orders the native column: one order
      assert.equal((await store.explain(ordered)).mode, 'set');
      // the bare native column, and the key the ORDER BY of every load over a physical table ends with
      assert.match((await token.explainLoad({ orderBy: '$it.id' })).sql, /ORDER BY "r"\."id" ASC NULLS FIRST, "r"\."id"$/);
      assert.deepEqual((await token.load({ orderBy: '$it.id', after: UUIDS[1] })).map((row) => row.id), UUIDS.slice(2));
      // a uuid equality against a mixed-case literal stays in the engine: the native column would match it, the decoded value does not
      const mixed = { $for: { it: '$.Token[*]' }, $where: { $eq: ['$it.id', 'A0000000-0000-4000-8000-000000000000'] }, $return: '$it.id' };
      assert.equal((await store.explain(mixed)).mode, 'set');
      const engine = await store.execute(mixed, { pushdown: false });
      assert.ok(engine === undefined || engine.length === 0, 'the decoded value is lowercase, and matches no other spelling');
      assert.deepEqual(await store.execute(mixed), engine);
      // bigint: SQL orders by value, the engine the decoded string by code point; a JavaScript number is not its value
      const refusedOrder = (/** @type {any} */ error) => error.code === 'JD0032' && /orderBy must address typed entity paths/.test(error.message);
      await assert.rejects(() => store.entity('Big').load({ orderBy: '$it.id' }), refusedOrder);
      assert.equal((await store.explain({ $for: { it: '$.Big[*]' }, $where: { $eq: ['$it.id', 1] }, $return: '$it.id' })).mode, 'set');
      // a uuid column that can hold NULL stays refused, as a nullable text column is: the typed path requires a value
      await assert.rejects(() => store.entity('Tagged').load({ orderBy: '$it.owner' }), refusedOrder);
      await assert.rejects(() => store.entity('Tagged').load({ orderBy: '$it.label' }), refusedOrder);
    }
    finally { await close(); }
  });
});
