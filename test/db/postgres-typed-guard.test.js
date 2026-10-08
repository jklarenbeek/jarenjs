//@ts-check
/**
 * @file On PostgreSQL a literal comparison, a membership list and a
 * string operator over a collection member or an entity's document
 * member read the member's typed extraction alone — the generated
 * column where one is declared, else the typed CASE that column would
 * hold — because that value's own SQL NULL already stands for an absent
 * member, a stored JSON null and every other JSON type: no `jsonb_typeof`
 * discriminator sits beside it. `$ne` keeps presence through the
 * member's JSON value, so a null and a value of another type differ and
 * an absent member does not. Externals and type tests keep the
 * discriminator. The spec member is pure text; the oracle is the engine
 * (`pushdown: false`): comparisons and lists over documents whose members
 * hold their own type, the other scalar type, booleans, null, an object,
 * an array or nothing at all, on indexed and unindexed members; string
 * operators over members holding strings or nothing (the engine raises
 * `JQ2001` on a string operator over another type or a stored null, so
 * there is no answer to equal there). Under `JAREN_PG_URL`.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { openStore, createDialect, sqliteDialect } from '@jarenjs/db';
import { postgresDriver, postgresDialect } from '@jarenjs/db/postgres';

import { fullDoubleDialect } from './helpers.js';

const url = process.env.JAREN_PG_URL;
const key = { 'x-entity': { key: true } };
const MODEL = {
  $model: '0.1',
  collections: {
    items: {
      schema: { type: 'object', properties: {
        id: { type: 'string' }, s: { type: 'string' }, n: { type: 'number' },
        t: { type: 'string' }, m: { type: 'number' }, u: {} } },
      key: '/id', indexes: [{ name: 's', path: '$.s' }, { name: 'n', path: '$.n' }],
    },
    words: {
      schema: { type: 'object', properties: { id: { type: 'string' }, s: { type: 'string' }, t: { type: 'string' } } },
      key: '/id', indexes: [{ name: 's', path: '$.s' }],
    },
  },
  entities: {
    Item: { schema: { type: 'object', properties: {
      id: { type: 'string', ...key },
      s: { type: 'string', 'x-entity': { index: true } }, n: { type: 'number', 'x-entity': { index: true } },
      // a nested member rides the entity's document
      p: { type: 'object', properties: { t: { type: 'string' }, m: { type: 'number' }, u: {} } } } } },
    Word: { schema: { type: 'object', properties: {
      id: { type: 'string', ...key }, p: { type: 'object', properties: { t: { type: 'string' } } } } } },
  },
};
/** Strings of one, two and three UTF-16 code units: code-unit and code-point orders differ. */
const STRINGS = ['', 'a', 'A', 'ab', 'é', '中', '😀', '\u{10000}', '￿', 'x', '5'];
const NUMBERS = [-1, 0, 0.5, 1, 2, 5, 10, 1e6, -2.5];
const OTHERS = [true, false, null, { k: 1 }, [1, 'x'], undefined];
const VALUES = [...STRINGS, ...NUMBERS, ...OTHERS];
const TEXTS = [...STRINGS, undefined];
/** Three times round the value list, so every member meets every value on several rows. */
const ROWS = VALUES.length * 3;
const WORD_ROWS = TEXTS.length * 3;
const LITERALS = ['a', 'é', '￿', '\u{10000}', '', 1, 0.5, -1, 1e6, true, false, null];
const OPS = ['$eq', '$ne', '$lt', '$le', '$gt', '$ge'];
const PATTERNS = ['a', 'é', '', '😀', 'ab'];
const STROPS = ['$starts-with', '$ends-with', '$contains'];
/** The discriminator `jsonTypeOf` writes on PostgreSQL: a three-call CASE over the document, counted in the WHERE. */
const discriminators = (/** @type {string} */ sql) =>
  ((/\sWHERE (.*) ORDER BY /s.exec(sql)?.[1] ?? '').match(/THEN 'text' WHEN jsonb_typeof/g) ?? []).length;

/** The value member `j` of row `i` holds: 5 is coprime with both list lengths, so each member walks its whole list. */
const valueAt = (/** @type {number} */ i, /** @type {number} */ j) => VALUES[(i * 5 + j * 7) % VALUES.length];
const textAt = (/** @type {number} */ i, /** @type {number} */ j) => TEXTS[(i * 5 + j * 7) % TEXTS.length];
/** @param {string} id @param {string[]} members @param {(j: number) => any} at */
const documentOf = (id, members, at) => {
  /** @type {Record<string, any>} */
  const doc = { id };
  for (const [j, member] of members.entries()) {
    const value = at(j);
    if (value !== undefined) doc[member] = value;
  }
  return doc;
};
const itemDocument = (/** @type {number} */ i) => documentOf(`d${String(i).padStart(3, '0')}`, ['s', 'n', 't', 'm', 'u'], (j) => valueAt(i, j));
const wordDocument = (/** @type {number} */ i) => documentOf(`w${String(i).padStart(3, '0')}`, ['s', 't'], (j) => textAt(i, j));
/** An entity row keeps its typed columns typed; the nested object carries the mixed values, and every thirteenth row has none. */
const itemRow = (/** @type {number} */ i) => ({
  id: `e${String(i).padStart(3, '0')}`, s: STRINGS[i % STRINGS.length], n: NUMBERS[i % NUMBERS.length],
  ...(i % 13 === 12 ? {} : { p: documentOf('', ['t', 'm', 'u'], (j) => valueAt(i, j + 2)) }),
});
const wordRow = (/** @type {number} */ i) => ({
  id: `x${String(i).padStart(3, '0')}`,
  ...(i % 13 === 12 ? {} : { p: documentOf('', ['t'], () => textAt(i, 1)) }),
});

/**
 * Every comparison and list the typed forms answer (`typed`), the type
 * tests an equality against a boolean or null literal becomes
 * (`typeTest`), and the constant forms an ordering against one is (neither).
 */
const comparisonsOver = (/** @type {string} */ member) => {
  /** @type {{ where: any, typed: boolean, typeTest: boolean }[]} */
  const out = [];
  for (const op of OPS) {
    for (const lit of LITERALS) {
      const scalar = typeof lit !== 'boolean' && lit !== null;
      out.push({ where: { [op]: [member, lit] }, typed: scalar, typeTest: !scalar && (op === '$eq' || op === '$ne') });
    }
  }
  out.push({ where: { $or: [{ $eq: [member, 'a'] }, { $eq: [member, 'é'] }, { $eq: [member, 1] }] }, typed: true, typeTest: false });
  out.push({ where: { $or: [{ $eq: [member, 'x'] }, { $eq: [member, '5'] }] }, typed: true, typeTest: false });
  out.push({ where: { $or: [{ $eq: [member, 5] }, { $eq: [member, 0.5] }] }, typed: true, typeTest: false });
  return out;
};
/** Every string operator over a member, `typed` where the planner promotes it (a non-empty pattern). */
const stringOperatorsOver = (/** @type {string} */ member) => {
  /** @type {{ where: any, typed: boolean, typeTest: boolean }[]} */
  const out = [];
  for (const pattern of PATTERNS) for (const op of STROPS) out.push({ where: { [op]: [member, pattern] }, typed: pattern !== '', typeTest: false });
  return out;
};
/** @param {any} predicate */
const overCollection = (predicate) => ({ $for: { it: '$[*]' }, $where: predicate, $return: '$it.id' });
/** @param {string} entity @param {any} predicate */
const overEntity = (entity, predicate) => ({ $for: { it: `$.${entity}[*]` }, $where: predicate, $orderby: ['$it.id'], $return: '$it.id' });
/** The ids a query answers, as one sorted list: a single row comes back as its value, none as nothing. @param {any} rows */
const sorted = (rows) => (Array.isArray(rows) ? [...rows] : rows === undefined ? [] : [rows]).sort();

describe('the typed extraction is a dialect spec member', () => {
  it('PostgreSQL declares it; SQLite and a spec that says nothing do not', () => {
    assert.equal(postgresDialect().typedExtract, true);
    assert.equal(sqliteDialect.typedExtract, false);
    assert.equal(fullDoubleDialect(createDialect).typedExtract, false);
  });
});

describe('PostgreSQL: the typed forms answer as the engine does', { skip: !url && 'JAREN_PG_URL is not set' }, () => {
  /** @type {any} */
  let admin;
  /** @type {any} */
  let pool;
  /** @type {any} */
  let store;
  const schema = `jaren_typed_guard_${process.pid}`;

  before(async () => {
    const pg = (await import('pg')).default;
    admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new pg.Pool({ connectionString: url, max: 1 });
    pool.on('connect', (/** @type {any} */ client) => { client.query('SET statement_timeout = 30000').catch(() => {}); });
    store = await openStore(MODEL, { driver: postgresDriver(pool, { schema }) });
    await store.transaction(async (/** @type {any} */ tx) => {
      for (let i = 0; i < ROWS; i++) {
        await tx.collection('items').put(itemDocument(i));
        await tx.entity('Item').create(itemRow(i));
      }
      for (let i = 0; i < WORD_ROWS; i++) {
        await tx.collection('words').put(wordDocument(i));
        await tx.entity('Word').create(wordRow(i));
      }
      // the presence cases by name: a stored null, another type, nothing, the value itself
      await tx.collection('items').put({ id: 'z-null', s: null });
      await tx.collection('items').put({ id: 'z-number', s: 5 });
      await tx.collection('items').put({ id: 'z-absent' });
      await tx.collection('items').put({ id: 'z-text', s: 'a' });
    });
  });

  after(async () => {
    await store?.close().catch(() => {});
    await pool?.end().catch(() => {});
    await admin?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
    await admin?.end().catch(() => {});
  });

  /**
   * Every predicate, plain and negated, natively against the engine; the
   * native plan of a typed form carries no discriminator, a type test keeps it.
   * @param {(predicate: any) => any} queryOf
   * @param {(query: any, options?: any) => Promise<any>} execute
   * @param {(query: any) => Promise<any>} explain
   * @param {{ where: any, typed: boolean, typeTest: boolean }[]} predicates
   * @param {boolean} nativeOnly - whether every typed plan must be native (an untyped member may not be)
   * @param {number} expectedTyped - the typed plans the member must reach natively
   * @param {any} t - the test context, which reports the count reached
   */
  const agree = async (queryOf, execute, explain, predicates, nativeOnly, expectedTyped, t) => {
    let typedPlans = 0;
    for (const { where, typed, typeTest } of predicates) {
      for (const predicate of [where, { $not: where }]) {
        const query = queryOf(predicate);
        assert.deepEqual(sorted(await execute(query)), sorted(await execute(query, { pushdown: false })), JSON.stringify(predicate));
      }
      const plan = await explain(queryOf(where));
      if (typed && nativeOnly) assert.equal(plan.mode, 'native', JSON.stringify(where));
      if (plan.mode !== 'native') continue;
      if (typed) {
        assert.equal(discriminators(plan.sql), 0, `${JSON.stringify(where)}: ${plan.sql}`);
        typedPlans++;
      }
      else if (typeTest) assert.ok(discriminators(plan.sql) >= 1, `a type test keeps the discriminator: ${JSON.stringify(where)}`);
    }
    t.diagnostic(`${typedPlans} typed native plans`);
    assert.equal(typedPlans, expectedTyped);
  };
  /** Six operators over nine scalar literals, plus three lists. */
  const COMPARISONS = 57;
  /** Three operators over the four non-empty patterns. */
  const STRING_OPERATORS = 12;
  const collection = (/** @type {string} */ name) => {
    const handle = store.collection(name);
    return {
      execute: (/** @type {any} */ query, /** @type {any} */ options) => handle.execute(query, options),
      explain: (/** @type {any} */ query) => handle.explain(query),
    };
  };

  it('$ne keeps presence: a null and another type differ, an absent member does not', async () => {
    const items = store.collection('items');
    const named = (/** @type {any[]} */ rows) => sorted(rows.filter((id) => id.startsWith('z-')));
    const differs = overCollection({ $ne: ['$it.s', 'a'] });
    assert.deepEqual(named(await items.execute(differs)), ['z-null', 'z-number']);
    assert.deepEqual(named(await items.execute(differs)), named(await items.execute(differs, { pushdown: false })));
    const equals = overCollection({ $eq: ['$it.s', 'a'] });
    assert.deepEqual(named(await items.execute(equals)), ['z-text']);
    const absentOrEqual = overCollection({ $not: { $ne: ['$it.s', 'a'] } });
    assert.deepEqual(named(await items.execute(absentOrEqual)), ['z-absent', 'z-text']);
    assert.deepEqual(named(await items.execute(absentOrEqual)), named(await items.execute(absentOrEqual, { pushdown: false })));
    const plan = await items.explain(differs);
    assert.equal(plan.mode, 'native');
    assert.equal(discriminators(plan.sql), 0);
    assert.match(plan.sql, /\("doc" #> '\{"s"\}'\) IS NOT NULL AND \("gx_s" IS NULL OR "gx_s" <> \$1\)/);
  });

  for (const member of ['$it.s', '$it.n', '$it.t', '$it.m', '$it.u']) {
    it(`collection member ${member}: every comparison and list, plain and negated, equals the engine over mixed types`, async (t) => {
      const { execute, explain } = collection('items');
      await agree(overCollection, execute, explain, comparisonsOver(member), true, COMPARISONS, t);
    });
  }
  for (const member of ['$it.s', '$it.t']) {
    it(`collection member ${member}: every string operator, plain and negated, equals the engine`, async (t) => {
      const { execute, explain } = collection('words');
      await agree(overCollection, execute, explain, stringOperatorsOver(member), true, STRING_OPERATORS, t);
    });
  }

  for (const member of ['$it.p.t', '$it.p.m', '$it.p.u']) {
    it(`entity document member ${member}: every comparison and list, plain and negated, equals the engine over mixed types`, async (t) => {
      await agree((predicate) => overEntity('Item', predicate), (query, options) => store.execute(query, options),
        (query) => store.explain(query), comparisonsOver(member), true, COMPARISONS, t);
    });
  }
  it('entity document member $it.p.t: every string operator, plain and negated, equals the engine', async (t) => {
    await agree((predicate) => overEntity('Word', predicate), (query, options) => store.execute(query, options),
      (query) => store.explain(query), stringOperatorsOver('$it.p.t'), true, STRING_OPERATORS, t);
  });

  it('an external operand keeps the discriminator and still answers as the engine does', async () => {
    const items = store.collection('items');
    const query = overCollection({ $eq: ['$it.s', '$x'] });
    for (const x of ['a', 1, 'é']) {
      const options = { externals: { x } };
      assert.deepEqual(sorted(await items.execute(query, options)),
        sorted(await items.execute(query, { ...options, pushdown: false })));
    }
    const plan = await items.explain(query, { externals: { x: 'a' } });
    assert.equal(plan.mode, 'native');
    assert.ok(discriminators(plan.sql) >= 2);
  });
});

describe('PostgreSQL: a profile reads the plan the database chooses for the typed form', { skip: !url && 'JAREN_PG_URL is not set' }, () => {
  /** A skewed table: 800 of 2,000 rows share one indexed value; statistics are gathered before the first query. */
  const SKEW = {
    $model: '0.1',
    collections: {
      skew: {
        schema: { type: 'object', properties: { id: { type: 'string' }, sku: { type: 'string' }, n: { type: 'integer' } } },
        key: '/id', indexes: [{ name: 'sku', path: '$.sku' }],
      },
    },
  };
  const ROWS = 2000;
  const HOT = 800;
  /** @type {any} */
  let admin;
  /** @type {any} */
  let pool;
  /** @type {any} */
  let store;
  const schema = `jaren_typed_scan_${process.pid}`;

  before(async () => {
    const pg = (await import('pg')).default;
    admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new pg.Pool({ connectionString: url, max: 1 });
    pool.on('connect', (/** @type {any} */ client) => { client.query('SET statement_timeout = 30000').catch(() => {}); });
    store = await openStore(SKEW, { driver: postgresDriver(pool, { schema }) });
    await store.transaction(async (/** @type {any} */ tx) => {
      for (let i = 0; i < ROWS; i++)
        await tx.collection('skew').put({ id: `d${String(i).padStart(4, '0')}`, sku: i < HOT ? 'hot' : `r${i}`, n: i });
    });
    // the scan check is remembered per prepared statement, so the
    // statistics exist before the first query reads them
    await admin.query(`ANALYZE "${schema}"."skew"`);
    await admin.query(`SET search_path TO "${schema}"`);
  });

  after(async () => {
    await store?.close().catch(() => {});
    await pool?.end().catch(() => {});
    await admin?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
    await admin?.end().catch(() => {});
  });

  /** The first scan line of the plan PostgreSQL chooses for a query's statement. */
  const scanLine = async (/** @type {any} */ query) => {
    const plan = await store.collection('skew').explain(query);
    const rows = (await admin.query({ text: `EXPLAIN ${plan.sql}`, values: plan.params.map((/** @type {any} */ p) => p.literal) })).rows;
    return rows.map((/** @type {any} */ row) => row['QUERY PLAN']).find((/** @type {string} */ line) => /Scan/.test(line)) ?? '';
  };

  it('a common value is refused as the sequential scan it is; a rare value seeks the index', async () => {
    const skew = store.collection('skew');
    const profile = { refuseFullScan: true };
    const hot = overCollection({ $eq: ['$it.sku', 'hot'] });
    const rare = overCollection({ $eq: ['$it.sku', 'r1999'] });
    // the typed form is the column itself, so the planner prices the
    // value's true selectivity: 40% of the rows, which it scans
    assert.match(await scanLine(hot), /Seq Scan on skew/);
    assert.match(await scanLine(rare), /Index Scan using .* on skew/);
    assert.equal(sorted(await skew.execute(hot)).length, HOT);
    assert.deepEqual(sorted(await skew.execute(hot)), sorted(await skew.execute(hot, { pushdown: false })));
    await assert.rejects(() => skew.execute(hot, { profile }), { code: 'JD0011' });
    await assert.rejects(() => skew.execute(overCollection({ '$starts-with': ['$it.sku', 'ho'] }), { profile }), { code: 'JD0011' });
    assert.deepEqual(sorted(await skew.execute(rare, { profile })), ['d1999']);
  });
});
