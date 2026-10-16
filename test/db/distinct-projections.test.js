//@ts-check
/**
 * @file `$distinct` over scalar leaves. A distinct item is deep equality: a
 * string by its code points, a number by its value (`1` and `1.0` alike), a
 * boolean by its value, `null` by itself, an absent member by being absent,
 * and an object member by member regardless of order. The database groups a
 * scalar by its value and JSON type, so a leaf the schema declares as scalars
 * and nothing else groups as the engine does; an object or an array groups by
 * its text, which keeps the order of its members. A constructor of such
 * leaves, a distinct ordered by other paths, and the key relation a
 * `$groupby` shares with `$distinct` are proven here against the engine on
 * SQLite and PostgreSQL, indexed and not.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { compileJsonQuery } from '@jarenjs/json/query';
import { JarenValidator } from '@jarenjs/validate';
import { openStore, planQuery, reasonId } from '@jarenjs/db';
import { nodeDriver, adaptNodeDatabase } from '@jarenjs/db/node';
import { from } from '@jarenjs/linq';

import { loadGroups, storeForGroup, runCase } from './oracle/harness.js';

const PG_URL = process.env.JAREN_PG_URL;
let schemas = 0;

/**
 * Run `fn` once per available host with a way to open a driver of it: SQLite
 * in memory, and PostgreSQL in schemas of its own (a pool of two, every
 * schema dropped afterwards) when `JAREN_PG_URL` names an endpoint. `raw`
 * runs a statement over the same database, the way a trusted write reaches
 * it, and answers its rows.
 * @param {(host: 'sqlite' | 'postgres', driverOf: () => Promise<any>,
 *   raw: (sql: (table: string) => string) => Promise<any[]>) => Promise<void>} fn
 */
async function onHosts(fn) {
  /** @type {DatabaseSync[]} */
  const handles = [];
  /** @type {DatabaseSync | null} */
  let current = null;
  await fn('sqlite', async () => {
    const handle = new DatabaseSync(':memory:');
    handles.push(handle);
    current = handle;
    const db = await adaptNodeDatabase({
      exec: (sql) => handle.exec(sql), close: () => handle.close(),
      prepare: (sql) => handle.prepare(sql),
    });
    return { ...nodeDriver(), open: async () => db };
  }, async (sql) => /** @type {DatabaseSync} */ (current).prepare(sql('"rows"')).all());
  if (!PG_URL) return;
  const { default: pg } = await import('pg');
  const { postgresDriver } = await import('@jarenjs/db/postgres');
  const pool = new pg.Pool({ connectionString: PG_URL, max: 2 });
  /** @type {string[]} */
  const made = [];
  try {
    await fn('postgres', async () => {
      const schema = `distinct_${process.pid}_${++schemas}`;
      await pool.query(`CREATE SCHEMA "${schema}"`);
      made.push(schema);
      return postgresDriver(pool, { schema });
    }, async (sql) => (await pool.query(sql(`"${made[made.length - 1]}"."rows"`))).rows);
  }
  finally {
    for (const schema of made) await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  }
}

/** Members compare regardless of their order, as the engine's distinct does. */
function canonical(/** @type {any} */ value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

/** What a call answered: its value, or the code it raised. */
async function outcome(/** @type {() => any} */ call) {
  try { return { value: canonical(await call()) }; }
  catch (error) { return { code: /** @type {any} */ (error).code }; }
}

/** The engine's outcome for a document over raw documents. */
function engineOutcome(/** @type {any} */ query, /** @type {any} */ documents) {
  try { return { value: canonical(compileJsonQuery(query)(structuredClone(documents))) }; }
  catch (error) { return { code: /** @type {any} */ (error).code }; }
}

/** A `$distinct` over `it`, with the clauses given. */
function distinct(/** @type {any} */ ret, /** @type {{ where?: any, order?: any[] }} */ { where, order } = {}) {
  return { $distinct: { $for: { it: '$[*]' }, ...(where === undefined ? {} : { $where: where }),
    ...(order === undefined ? {} : { $orderby: order }), $return: ret } };
}

/** @param {string} path @param {'asc' | 'desc'} [dir] @param {'least' | 'greatest'} [empty] */
function key(path, dir, empty) {
  return { $key: path, ...(dir === undefined ? {} : { $dir: dir }), ...(empty === undefined ? {} : { $empty: empty }) };
}

/** One collection model, its documents inserted. */
function modelOf(/** @type {any} */ schema, /** @type {any[]} */ indexes = []) {
  return { $model: '0.1', collections: { rows: { key: null, identity: 'integer', indexes, schema } } };
}

// ————— the shapes this planner lowers, with the answers the engine gives —————

const COMPOUND_SCHEMA = { type: 'object', properties: { id: { type: 'string' }, s: { type: 'string' }, n: { type: 'number' },
  o: { type: 'object', properties: { p: { type: 'number' }, q: { type: 'number' } } }, b: { type: 'boolean' },
  ns: { type: ['string', 'null'] } } };
const COMPOUND_DATA = [
  { id: 'a', s: 'x', n: 1, o: { p: 1, q: 2 }, b: true, ns: null },
  { id: 'b', s: 'x', n: 1, o: { q: 2, p: 1 }, b: true },
  { id: 'c', s: 'x', n: 1.5, o: { p: 1 }, b: false, ns: 'x' },
  { id: 'd', n: 1, b: true, ns: null },
  { id: 'e', s: 'x', n: 1.5, o: { p: 1.0 } },
];
const ORDERED_SCHEMA = { type: 'object', properties: { id: { type: 'string' }, s: { type: 'string' }, k: { type: 'number' } } };
const ORDERED_DATA = [
  { id: 'a', s: 'x', k: 2 }, { id: 'b', s: 'y' }, { id: 'c', s: 'x', k: 1 }, { id: 'd', s: 'z', k: 2 },
  { id: 'e', s: 'y', k: 3 }, { id: 'f', k: 0 }, { id: 'g', s: 'w' },
];

/** Every host, indexed and not: `fn` gets the collection, its raw documents and the label. */
async function overCollection(/** @type {any} */ schema, /** @type {any[]} */ documents,
  /** @type {any[]} */ indexes, /** @type {(rows: any, label: string, host: string) => Promise<void>} */ fn) {
  await onHosts(async (host, driverOf) => {
    for (const side of ['indexed', 'unindexed']) {
      const store = await openStore(modelOf(schema, side === 'indexed' ? indexes : []), { driver: await driverOf() });
      try {
        const rows = store.collection('rows');
        for (const document of documents) await rows.insert(document);
        await fn(rows, `${host} ${side}`, host);
      }
      finally { await store.close(); }
    }
  });
}

describe('a distinct over a compound of scalar leaves lowers to one grouped statement', () => {
  const CASES = /** @type {[string, any, any[]][]} */ ([
    ['{s, n}', distinct({ s: '$it.s', n: '$it.n' }), [{ s: 'x', n: 1 }, { s: 'x', n: 1.5 }, { n: 1 }]],
    ['{ns}', distinct({ ns: '$it.ns' }), [{ ns: null }, {}, { ns: 'x' }]],
    ['{b, n}', distinct({ b: '$it.b', n: '$it.n' }), [{ b: true, n: 1 }, { b: false, n: 1.5 }, { n: 1.5 }]],
  ]);

  it('answers what the engine answers, natively, in first-occurrence order', async () => {
    await overCollection(COMPOUND_SCHEMA, COMPOUND_DATA, [{ name: 'by_s', path: '$.s' }, { name: 'by_n', path: '$.n' }],
      async (rows, label) => {
        for (const [name, query, expected] of CASES) {
          assert.deepEqual(engineOutcome(query, COMPOUND_DATA), { value: canonical(expected) }, `${label}: ${name} (the engine)`);
          const explained = await rows.explain(query);
          assert.equal(explained.mode, 'native', `${label}: ${name}`);
          assert.match(explained.sql, /GROUP BY "vk0", "tk0", "vk1", "tk1" ORDER BY MIN\("(?:rowid|rid)"\)$|GROUP BY "vk0", "tk0" ORDER BY MIN\("(?:rowid|rid)"\)$/, `${label}: ${name}`);
          assert.deepEqual(await outcome(() => rows.execute(query)), { value: canonical(expected) }, `${label}: ${name}`);
          assert.deepEqual(await outcome(() => rows.execute(query, { strict: true })), { value: canonical(expected) }, `${label}: ${name} (strict)`);
          assert.deepEqual(await outcome(() => rows.execute(query, { pushdown: false })), { value: canonical(expected) }, `${label}: ${name} (the residual)`);
        }
      });
  });

  it('keeps an object leaf in the engine, which compares objects by member, wherever they were written', async () => {
    const query = distinct({ o: '$it.o' });
    await overCollection(COMPOUND_SCHEMA, COMPOUND_DATA, [{ name: 'by_s', path: '$.s' }], async (rows, label) => {
      const expected = [{ o: { p: 1, q: 2 } }, { o: { p: 1 } }, {}];
      assert.deepEqual(engineOutcome(query, COMPOUND_DATA), { value: canonical(expected) }, label);
      const explained = await rows.explain(query);
      assert.equal(explained.mode, 'set', label);
      assert.equal(reasonId(explained.residual.reasons[0].reason), 'plan.distinctProjection', label);
      assert.deepEqual(await outcome(() => rows.execute(query)), { value: canonical(expected) }, label);
    });
  });
});

describe('a distinct ordered by another path numbers the rows in that order and groups them', () => {
  const ANSWERS = /** @type {[string, string, string[]][]} */ ([
    ['asc', 'least', ['y', 'w', 'x', 'z']], ['asc', 'greatest', ['x', 'z', 'y', 'w']],
    ['desc', 'least', ['y', 'x', 'z', 'w']], ['desc', 'greatest', ['y', 'w', 'x', 'z']],
  ]);

  it('keeps the rows without the order key in the ordering, wherever $empty places them', async () => {
    await overCollection(ORDERED_SCHEMA, ORDERED_DATA, [{ name: 'by_s', path: '$.s' }, { name: 'by_k', path: '$.k' }],
      async (rows, label) => {
        for (const [dir, empty, expected] of ANSWERS) {
          const query = distinct('$it.s', { order: [key('$it.k', /** @type {any} */ (dir), /** @type {any} */ (empty))] });
          const name = `${label}: ${dir}, ${empty}`;
          assert.deepEqual(engineOutcome(query, ORDERED_DATA), { value: expected }, `${name} (the engine)`);
          const explained = await rows.explain(query);
          assert.equal(explained.mode, 'native', name);
          assert.match(explained.sql, /ROW_NUMBER\(\) OVER \(ORDER BY .*\) AS "_rn".* AS "0rows" GROUP BY "vk0", "tk0" ORDER BY MIN\("_rn"\)$/, name);
          assert.deepEqual(await outcome(() => rows.execute(query)), { value: expected }, name);
        }
      });
  });
});

describe('every case of the corpus group is lowered or kept by the rule its name states', () => {
  const group = loadGroups().find((entry) => entry.group === 'distinct projections over scalar leaves');
  it('the group exists and names its residual cases', () => {
    assert.ok(group);
    const kept = group.cases.filter((kase) => kase.name.endsWith('stays in the engine'));
    assert.equal(group.cases.length - kept.length, 63);
    assert.equal(kept.length, 16);
  });

  for (const side of /** @type {const} */ (['indexed', 'unindexed'])) {
    it(`plans each case native or in the engine under the reason distinctProjection, and answers as the engine — ${side}`, async () => {
      assert.ok(group);
      await onHosts(async (host, driverOf) => {
        const { store, collection } = await storeForGroup(group, await driverOf(), side);
        try {
          for (const kase of group.cases) {
            const label = `${host} ${side}: ${kase.name}`;
            const explained = await collection.explain(kase.query);
            if (kase.name.endsWith('stays in the engine')) {
              assert.equal(explained.mode, 'set', label);
              assert.equal(reasonId(explained.residual.reasons[0].reason), 'plan.distinctProjection', label);
            }
            else assert.equal(explained.mode, 'native', label);
            assert.equal(await runCase(collection, group.documents, kase, 'native'), null, label);
          }
        }
        finally { await store.close(); }
      });
    });
  }
});

// ————— a leaf that may hold an object or an array —————

describe('a leaf the schema lets hold an object or an array is grouped by the engine', () => {
  // `{p: 1, q: 2}` and `{q: 2, p: 1}` are one item to the engine; a database that groups the text of an
  // object keeps them apart (SQLite stores the members in the order they were written)
  const SCHEMA = { type: 'object', properties: { id: { type: 'integer' }, x: { type: ['string', 'object'] },
    y: { type: ['integer', 'array'] }, s: { type: 'string' },
    t: { type: 'array', prefixItems: [{ type: 'object' }], items: { type: 'string' } } } };
  const DOCUMENTS = [
    { id: 1, x: { p: 1, q: 2 }, y: [1, 2], s: 'a', t: [{ p: 1, q: 2 }] }, { id: 2, x: { q: 2, p: 1 }, y: [1, 2], s: 'a', t: [{ q: 2, p: 1 }] },
    { id: 3, x: 'a', y: 5, s: 'b', t: [{ p: 1 }, 'z'] }, { id: 4, x: { p: 1 }, y: [2, 1], s: 'b' }, { id: 5, x: { p: 1, q: 2 }, y: 5, s: 'a', t: [{ p: 1, q: 2 }] },
  ];
  const QUERIES = /** @type {[string, any][]} */ ([
    ['one such leaf', distinct('$it.x')],
    ['the last element of a tuple whose first is an object', distinct('$it.t[-1]')],
    ['a grouping keyed by the last element of such a tuple', { $for: { it: '$[*]' }, $groupby: { g: '$it.t[-1]' }, $return: { g: '$g', n: { $count: '$it' } } }],
    ['one such leaf, ordered by another path', distinct('$it.x', { order: [key('$it.id', 'desc')] })],
    ['a constructor holding one', distinct({ x: '$it.x', s: '$it.s' })],
    ['a constructor holding an array', distinct({ y: '$it.y' })],
    ['a grouping keyed by one', { $for: { it: '$[*]' }, $groupby: { g: '$it.x' }, $return: { g: '$g', n: { $count: '$it' } } }],
    ['a grouping keyed by an array', { $for: { it: '$[*]' }, $groupby: { g: '$it.y' }, $return: { g: '$g', n: { $count: '$it' } } }],
  ]);

  it('keeps each such query in the engine and answers its items', async () => {
    await overCollection(SCHEMA, DOCUMENTS, [], async (rows, label) => {
      for (const [name, query] of QUERIES) {
        const expected = engineOutcome(query, DOCUMENTS);
        assert.equal(expected.code, undefined, `${label}: ${name}`);
        assert.equal((await rows.explain(query)).mode, 'set', `${label}: ${name}`);
        assert.deepEqual(await outcome(() => rows.execute(query)), expected, `${label}: ${name}`);
      }
    });
  });

  it('plans the same queries natively under a schema that declares scalars alone', async () => {
    const scalars = { type: 'object', properties: { id: { type: 'integer' }, x: { type: ['string', 'integer'] },
      y: { type: ['integer', 'null'] }, s: { type: 'string' } } };
    const documents = [{ id: 1, x: 1, y: null, s: 'a' }, { id: 2, x: '1', y: 5, s: 'a' }, { id: 3, x: 1, y: 5, s: 'b' }, { id: 4, y: null, s: 'b' }];
    await overCollection(scalars, documents, [], async (rows, label) => {
      for (const [name, query] of QUERIES.filter(([title]) => !title.includes('tuple'))) {
        const expected = engineOutcome(query, documents);
        assert.equal((await rows.explain(query)).mode, 'native', `${label}: ${name}`);
        assert.deepEqual(await outcome(() => rows.execute(query)), expected, `${label}: ${name}`);
      }
    });
  });
});

// ————— one number written two ways —————

describe('a number written as 2.0 beside the same number written as 2 is one key', () => {
  // a store writes `2` for 2 and 2.0 alike, so the other spelling reaches a document only through a write the
  // store did not make (SQLite keeps `integer` and `real` apart, PostgreSQL keeps the scale of a number)
  const SCHEMA = { type: 'object', properties: { id: { type: 'integer' }, n: { type: 'number' }, s: { type: 'string' } } };
  const DOCUMENTS = [{ id: 1, n: 2, s: 'a' }, { id: 2, n: 3, s: 'b' }, { id: 3, n: 2, s: 'c' }, { id: 4, n: 0.5, s: 'd' }, { id: 5, n: 2, s: 'a' }];
  const QUERIES = /** @type {[string, any][]} */ ([
    ['one number', distinct('$it.n')],
    ['one number, ordered by another path', distinct('$it.n', { order: [key('$it.id', 'desc')] })],
    ['a constructor of a number and a string', distinct({ n: '$it.n', s: '$it.s' })],
    ['a constructor of the number alone', distinct({ n: '$it.n' })],
    ['a grouping keyed by the number', { $for: { it: '$[*]' }, $groupby: { g: '$it.n' }, $return: { g: '$g', c: { $count: '$it' } } }],
    // the order names the one key, so the groups are ordered by it alone: the two spellings are one group, never a tie
    ['a grouping ordered by the number', { $for: { it: '$[*]' }, $groupby: { g: '$it.n' }, $orderby: ['$g'], $return: { g: '$g', c: { $count: '$it' } } }],
    ['a grouping ordered by the number, descending',
      { $for: { it: '$[*]' }, $groupby: { g: '$it.n' }, $orderby: [{ $key: '$g', $dir: 'desc' }], $return: { g: '$g', c: { $count: '$it' } } }],
  ]);

  it('groups the two spellings together, native and in the engine alike', async () => {
    await onHosts(async (host, driverOf, raw) => {
      for (const side of ['indexed', 'unindexed']) {
        const store = await openStore(modelOf(SCHEMA, side === 'indexed' ? [{ name: 'by_n', path: '$.n' }] : []), { driver: await driverOf() });
        try {
          const rows = store.collection('rows');
          for (const document of DOCUMENTS) await rows.insert(document);
          // the third document's number is written 2.0, the way a trusted write or a migration fold leaves it
          if (host === 'sqlite') await raw(() => `UPDATE rows SET doc = jsonb_set(doc, '$.n', 2.0) WHERE json_extract(doc, '$.id') = 3`);
          else await raw((table) => `UPDATE ${table} SET doc = jsonb_set(doc, '{n}', '2.0'::jsonb) WHERE (doc ->> 'id') = '3'`);
          const spelled = host === 'sqlite'
            ? (await raw(() => `SELECT json_type(doc, '$.n') AS t FROM rows ORDER BY rowid`)).map((row) => row.t)
            : (await raw((table) => `SELECT doc #>> '{n}' AS t FROM ${table} ORDER BY rid`)).map((row) => row.t);
          assert.deepEqual(spelled, host === 'sqlite' ? ['integer', 'integer', 'real', 'real', 'integer'] : ['2', '3', '2.0', '0.5', '2'],
            `${host} ${side}: the write left the other spelling`);
          for (const [name, query] of QUERIES) {
            const label = `${host} ${side}: ${name}`;
            const expected = engineOutcome(query, DOCUMENTS);
            assert.equal(expected.code, undefined, label);
            assert.equal((await rows.explain(query)).mode, 'native', label);
            assert.deepEqual(await outcome(() => rows.execute(query)), expected, label);
          }
        }
        finally { await store.close(); }
      }
    });
  });
});

// ————— whole numbers beyond 2^53 —————

describe('a whole number beyond 2^53 is one key, as the engine parses it', () => {
  // a client that writes doubles leaves a nanosecond timestamp as digits beyond 2^53, which SQLite stores as an integer
  // that its driver cannot hand over exactly; a group key is read as the double the engine parses, so no statement
  // raises where the engine answers, and the integer and the real spelling of one number are one key
  const SCHEMA = { type: 'object', properties: { id: { type: 'integer' }, ts: { type: 'number' }, at: { type: 'integer' },
    s: { type: 'string' }, w: { type: ['string', 'integer'] } } };
  const NS = 1700000000000000000;
  const DOCUMENTS = Array.from({ length: 6 }, (_, i) => ({ id: i + 1, ts: NS + (i % 3) * 1e9, at: NS + (i % 3) * 1e9, s: `s${i % 2}`, w: i % 2 ? NS : 'x' }));
  const grouping = (/** @type {string} */ path) => ({ $for: { it: '$[*]' }, $groupby: { g: path }, $return: { g: '$g', c: { $count: '$it' } } });
  const QUERIES = /** @type {[string, any][]} */ ([
    ['one number', distinct('$it.ts')],
    ['one integer', distinct('$it.at')],
    ['one string or integer', distinct('$it.w')],
    ['a constructor of the number and a string', distinct({ ts: '$it.ts', s: '$it.s' })],
    ['a constructor of the integer and a string', distinct({ at: '$it.at', s: '$it.s' })],
    ['a constructor of the string or integer and a string', distinct({ w: '$it.w', s: '$it.s' })],
    ['a string ordered by the number', distinct('$it.s', { order: [key('$it.ts', 'desc')] })],
    ['a constructor ordered by the number', distinct({ s: '$it.s' }, { order: [key('$it.ts', 'desc')] })],
    ['a window over a constructor of the number', { $subsequence: [distinct({ ts: '$it.ts', s: '$it.s' }), 0, 2] }],
    ['a grouping keyed by the number', grouping('$it.ts')],
    ['a grouping keyed by the integer', grouping('$it.at')],
    ['a grouping keyed by the string or integer', grouping('$it.w')],
  ]);

  it('answers what the engine answers, natively, beside the same instant written as a real', async () => {
    assert.deepEqual(engineOutcome(QUERIES[0][1], DOCUMENTS), { value: [NS, NS + 1e9, NS + 2e9] });
    await onHosts(async (host, driverOf, raw) => {
      for (const side of ['indexed', 'unindexed']) {
        const store = await openStore(modelOf(SCHEMA, side === 'indexed' ? [{ name: 'by_ts', path: '$.ts' }, { name: 'by_at', path: '$.at' }] : []),
          { driver: await driverOf() });
        try {
          const rows = store.collection('rows');
          for (const document of DOCUMENTS) await rows.insert(document);
          for (const rewritten of [false, true]) {
            if (rewritten) {
              // the fourth document's instant is the first one's: a trusted write leaves it as a real, in both members
              if (host === 'sqlite') {
                await raw(() => `UPDATE rows SET doc = jsonb_set(doc, '$.ts', 1.7e18, '$.at', 1.7e18) WHERE json_extract(doc, '$.id') = 4`);
                const spelled = (await raw(() => `SELECT json_type(doc, '$.ts') AS t, json_type(doc, '$.at') AS a FROM rows ORDER BY rowid`)).map((row) => `${row.t}/${row.a}`);
                assert.deepEqual(spelled, ['integer/integer', 'integer/integer', 'integer/integer', 'real/real', 'integer/integer', 'integer/integer'], `${host} ${side}`);
              }
              else await raw((table) => `UPDATE ${table} SET doc = jsonb_set(jsonb_set(doc, '{ts}', '1.7e18'::jsonb), '{at}', '1.7e18'::jsonb) WHERE (doc ->> 'id') = '4'`);
            }
            for (const [name, query] of QUERIES) {
              const label = `${host} ${side}${rewritten ? ' (one real)' : ''}: ${name}`;
              const expected = engineOutcome(query, DOCUMENTS);
              assert.equal(expected.code, undefined, label);
              assert.equal((await rows.explain(query)).mode, 'native', label);
              assert.deepEqual(await outcome(() => rows.execute(query)), expected, label);
            }
          }
        }
        finally { await store.close(); }
      }
    });
  });

  it('keeps the boundaries of the double apart where the engine does', async () => {
    // 2^53 and the next double are two numbers; 2^62, a negative one and a fraction beside them are three more
    const documents = [2 ** 53, 2 ** 53 + 2, -(2 ** 53), 2 ** 62, 0.5, 2 ** 53, 1e21].map((ts, i) => ({ id: i + 1, ts, at: Number.isInteger(ts) ? ts : 0, s: 'x' }));
    const queries = /** @type {[string, any][]} */ ([['one number', distinct('$it.ts')], ['a grouping keyed by it', grouping('$it.ts')],
      ['a constructor with a string', distinct({ ts: '$it.ts', s: '$it.s' })], ['one integer', distinct('$it.at')]]);
    await overCollection(SCHEMA, documents, [{ name: 'by_ts', path: '$.ts' }], async (rows, label) => {
      for (const [name, query] of queries) {
        const expected = engineOutcome(query, documents);
        assert.equal(expected.code, undefined, `${label}: ${name}`);
        assert.equal((await rows.explain(query)).mode, 'native', `${label}: ${name}`);
        assert.deepEqual(await outcome(() => rows.execute(query)), expected, `${label}: ${name}`);
      }
    });
  });
});

describe('a group key is read as a number only where its member may hold one', () => {
  const SCHEMA = { type: 'object', properties: { id: { type: 'integer' }, s: { type: 'string' }, n: { type: 'number' },
    b: { type: 'boolean' }, m: { type: ['string', 'integer'] }, z: { type: ['string', 'null'] } } };
  const keyed = (/** @type {string} */ path) => ({ $for: { it: '$[*]' }, $groupby: { g: path }, $return: { g: '$g', c: { $count: '$it' } } });

  it('leaves the statement of a key that holds no number as it reads a member', async () => {
    await overCollection(SCHEMA, [{ id: 1, s: 'a', n: 1, b: true, m: 1, z: null }], [], async (rows, label, host) => {
      // a number is read as the double the engine parses (SQLite) or as the numeric itself (PostgreSQL), so a whole number
      // beyond 2^53 and the spellings 2 and 2.0 cannot split or raise; only a member that may also hold a string is read guarded
      const reads = host === 'sqlite' ? /CAST\(jsonb_extract\(/ : /::numeric/;
      const guarded = host === 'sqlite' ? /THEN CAST\(jsonb_extract\(/ : /trim_scale\(/;
      const folds = /IN \('integer', 'real'\) THEN 'integer'/;
      for (const [path, kind] of /** @type {[string, 'none' | 'pure' | 'mixed'][]} */ ([
        ['$it.s', 'none'], ['$it.b', 'none'], ['$it.z', 'none'], ['$it.n', 'pure'], ['$it.m', 'mixed']])) {
        for (const query of [keyed(path), distinct(path)]) {
          const explained = await rows.explain(query);
          const at = `${label}: ${path} ${JSON.stringify(query).slice(0, 20)}`;
          assert.equal(explained.mode, 'native', at);
          assert.equal(reads.test(explained.sql), kind !== 'none', `${at} (read as a number)`);
          assert.equal(guarded.test(explained.sql), kind === 'mixed', `${at} (guarded by its type)`);
          if (host === 'sqlite') assert.equal(folds.test(explained.sql), kind !== 'none', `${at} (one type for both spellings)`);
        }
      }
    });
  });
});

// ————— a member named like the prototype —————

describe('a constructor member named __proto__ is a member of every decoded item', () => {
  // `out[name] = value` on a plain object does not make a member of `__proto__`; the engine does, so the decoders
  // of the native statements must (the queries are JSON text: a JS object literal would set a prototype instead)
  const SCHEMA = { type: 'object', properties: { id: { type: 'integer' }, s: { type: 'string' }, n: { type: 'number' } } };
  const DOCUMENTS = [{ id: 1, s: 'x', n: 1 }, { id: 2, s: 'x', n: 1.5 }, { id: 3, s: 'y', n: 1 }, { id: 4, n: 2 }];
  const flwor = (/** @type {string} */ clauses) => JSON.parse(`{"$for":{"it":"$[*]"},${clauses}}`);
  const QUERIES = /** @type {[string, any][]} */ ([
    ['a plain projection', flwor('"$return":{"__proto__":"$it.s","n":"$it.n"}')],
    ['a grouping\'s return', flwor('"$groupby":{"g":"$it.s"},"$return":{"__proto__":"$g","c":{"$count":"$it"}}')],
    ['a distinct constructor', { $distinct: flwor('"$return":{"__proto__":"$it.s","n":"$it.n"}') }],
    ['a distinct constructor ordered by another path', { $distinct: flwor('"$orderby":["$it.id"],"$return":{"__proto__":"$it.s","n":"$it.n"}') }],
    ['a distinct constructor of that member alone', { $distinct: flwor('"$return":{"__proto__":"$it.s"}') }],
    ['a distinct constructor nesting it', { $distinct: flwor('"$return":{"a":{"__proto__":"$it.s"},"n":"$it.n"}') }],
  ]);

  it('keeps the member the engine builds, on every host', async () => {
    await overCollection(SCHEMA, DOCUMENTS, [{ name: 'by_s', path: '$.s' }], async (rows, label) => {
      for (const [name, query] of QUERIES) {
        const expected = engineOutcome(query, DOCUMENTS);
        assert.equal(expected.code, undefined, `${label}: ${name}`);
        assert.ok(JSON.stringify(expected.value).includes('__proto__'), `${label}: ${name} (the engine keeps it)`);
        assert.equal((await rows.explain(query)).mode, 'native', `${label}: ${name}`);
        assert.deepEqual(await outcome(() => rows.execute(query)), expected, `${label}: ${name}`);
      }
    });
  });

  it('keeps it in a temporal bucket whose aggregate is named so', async () => {
    const T0 = 1767225600000;
    const model = { $model: '0.1', collections: { sample: { key: null, identity: 'integer',
      schema: { type: 'object', properties: { series: { type: 'string' }, at: { type: 'integer' }, hits: { type: 'integer' } } },
      indexes: [{ name: 'by_series_at', path: ['$.series', '$.at'] }] } } };
    const documents = Array.from({ length: 12 }, (_, i) => ({ series: 'a', at: T0 + i * 20000, hits: i }));
    const query = JSON.parse(JSON.stringify({ $for: { s: '$[*]' },
      $where: { $and: [{ $eq: ['$s.series', 'a'] }, { $ge: ['$s.at', T0] }, { $lt: ['$s.at', T0 + 3600000] }] },
      $groupby: { b: { '$time-bucket': ['$s.at', 60000, T0] } }, $orderby: ['$b'],
      $return: { at: '$b', value: { $sum: '$s.hits' } } }).replace('"value"', '"__proto__"'));
    await onHosts(async (host, driverOf) => {
      const store = await openStore(model, { driver: await driverOf() });
      try {
        const sample = store.collection('sample');
        for (const document of documents) await sample.insert(document);
        const expected = engineOutcome(query, documents);
        assert.ok(JSON.stringify(expected.value).includes('__proto__'), host);
        assert.equal((await sample.explain(query)).mode, 'native', host);
        assert.deepEqual(await outcome(() => sample.execute(query)), expected, host);
      }
      finally { await store.close(); }
    });
  });
});

// ————— the proof that a path holds a scalar or nothing —————

describe('a path is a distinct leaf only where the schema places a scalar at it', () => {
  const ABSENT = Symbol('absent');
  /** Member schemas whose element and member steps the proof reads: tuples, plain and untyped `items`, `contains`, digit names, nesting, and the unions of scalars with containers. */
  const SCHEMAS = /** @type {Record<string, any>} */ ({
    string: { type: 'string' },
    number: { type: 'number' },
    boolean: { type: 'boolean' },
    nullableString: { type: ['string', 'null'] },
    stringOrInteger: { type: ['string', 'integer'] },
    booleanOrInteger: { type: ['boolean', 'integer'] },
    integerOrString: { type: ['integer', 'string'] },
    numberOrBoolean: { type: ['number', 'boolean'] },
    stringOrObject: { type: ['string', 'object'] },
    stringOrArray: { type: ['string', 'array'] },
    objectOrNull: { type: ['object', 'null'] },
    object: { type: 'object', properties: { p: { type: 'number' }, q: { type: 'number' } } },
    objectOfObject: { type: 'object', properties: { p: { type: 'object' }, q: { type: 'string' } } },
    array: { type: 'array' },
    untyped: {},
    items: { type: 'array', items: { type: 'string' } },
    itemsOfObjects: { type: 'array', items: { type: 'object' } },
    tuple: { type: 'array', prefixItems: [{ type: 'number' }], items: { type: 'string' } },
    tupleOfObject: { type: 'array', prefixItems: [{ type: 'object' }], items: { type: 'string' } },
    tuple2: { type: 'array', prefixItems: [{ type: 'string' }, { type: 'number' }], items: { type: 'string' } },
    openTail: { type: 'array', prefixItems: [{ type: 'string' }] },
    closedTuple: { type: 'array', prefixItems: [{ type: 'string' }, { type: 'string' }], items: false },
    untypedItems: { items: { type: 'string' } },
    contains: { type: 'array', contains: { type: 'string' } },
    arrayItems: { type: 'array', items: [{ type: 'string' }] },
    digitNames: { properties: { 0: { type: 'string' } } },
    objectDigits: { type: 'object', properties: { 0: { type: 'string' }, '-1': { type: 'string' } } },
    nullableArray: { type: ['array', 'null'], items: { type: 'string' } },
    nested: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
    nestedTuple: { type: 'array', items: { type: 'array', prefixItems: [{ type: 'number' }], items: { type: 'string' } } },
    nestedObject: { type: 'object', properties: { x: { type: 'string' } } },
  });
  const PATHS = ['$it.a', '$it.a[0]', '$it.a[1]', '$it.a[2]', '$it.a[-1]', '$it.a[-2]', "$it.a['0']", "$it.a['-1']", '$it.a[0][0]',
    '$it.a[0][1]', '$it.a[0][-1]', '$it.a[-1][0]', '$it.a.x', '$it.a.p'];
  /** Values a member may hold: scalars of every kind, arrays of every length and mix, nested arrays, objects whose members are written in two orders, objects named like indexes, null, nothing. */
  const POOL = [ABSENT, null, 5, 5.5, 's', '', true, false, [], [1], ['s'], [1, 's'], ['s', 1], [1, 's', 't'], ['s', 't'],
    [{ p: 1, q: 2 }], [{ q: 2, p: 1 }], [[1, 2]], [[2, 1]], [['s']], [['s', 't']], [[1, 's']], { p: 1, q: 2 }, { q: 2, p: 1 }, { p: 1 },
    { 0: 's' }, { 0: 5 }, { '-1': 's' }, { '-1': 5 }, {}, { x: 's' }, { x: 5 }, { x: { p: 1, q: 2 } }, { x: { q: 2, p: 1 } }];
  /** The paths the planner takes as a distinct leaf, for each schema. */
  const ACCEPTED = /** @type {Record<string, string[]>} */ ({
    string: ['$it.a'],
    number: ['$it.a'],
    boolean: ['$it.a'],
    nullableString: ['$it.a'],
    stringOrInteger: ['$it.a'],
    booleanOrInteger: ['$it.a'],
    integerOrString: ['$it.a'],
    numberOrBoolean: ['$it.a'],
    stringOrObject: [],
    stringOrArray: [],
    objectOrNull: [],
    object: ['$it.a.p'],
    objectOfObject: [],
    array: [],
    untyped: [],
    items: ['$it.a[0]', '$it.a[1]', '$it.a[2]'],
    itemsOfObjects: [],
    tuple: ['$it.a[0]', '$it.a[1]', '$it.a[2]'],
    tupleOfObject: ['$it.a[1]', '$it.a[2]'],
    tuple2: ['$it.a[0]', '$it.a[1]', '$it.a[2]'],
    openTail: ['$it.a[0]'],
    closedTuple: ['$it.a[0]', '$it.a[1]'],
    untypedItems: ['$it.a[0]', '$it.a[1]', '$it.a[2]'],
    contains: [],
    arrayItems: [],
    digitNames: ["$it.a['0']"],
    objectDigits: ["$it.a['0']", "$it.a['-1']"],
    nullableArray: ['$it.a[0]', '$it.a[1]', '$it.a[2]'],
    nested: ['$it.a[0][0]', '$it.a[0][1]'],
    nestedTuple: ['$it.a[0][0]', '$it.a[0][1]'],
    nestedObject: ['$it.a.x'],
  });

  for (const [name, member] of Object.entries(SCHEMAS)) {
    it(`${name}: a leaf the planner takes answers as the engine does, over every document the schema admits`, async () => {
      const check = new JarenValidator().compile(member);
      const conforming = POOL.filter((value) => value === ABSENT || check(value));
      assert.ok(conforming.length >= 3, `${name}: the pool holds documents that conform`);
      const documents = conforming.map((value, i) => (value === ABSENT ? { id: i } : { id: i, a: value }));
      const schema = { type: 'object', properties: { id: { type: 'integer' }, a: member } };
      const shape = { collection: 'rows', schema, columnByCanonical: new Map() };
      /** @type {string[]} */
      const accepted = [];
      /** @type {string[]} */
      const taken = [];
      for (const path of PATHS) {
        const single = planQuery(distinct(path), shape).mode === 'native';
        const compound = planQuery(distinct({ v: path, w: path }), shape).mode === 'native';
        assert.equal(single, compound, `${name} ${path}: one proof decides a leaf alone and in a constructor`);
        if (single) accepted.push(path);
      }
      assert.deepEqual(accepted, ACCEPTED[name], name);
      taken.push(...accepted);
      await overCollection(schema, documents, [], async (rows, label) => {
        for (const path of taken) {
          for (const query of [distinct(path), distinct({ v: path }), distinct(path, { order: [key('$it.id', 'desc')] }),
            distinct({ v: path, i: '$it.id' }, { order: [key(path, 'asc', 'greatest')] })]) {
            const text = `${label}: ${name} ${path} ${JSON.stringify(query)}`;
            const expected = engineOutcome(query, documents);
            const explained = await rows.explain(query);
            if (explained.mode === 'native') assert.deepEqual(await outcome(() => rows.execute(query)), expected, text);
          }
        }
      });
    });
  }
});

// ————— what a profile bounds —————

describe('a profile bounds the groups a distinct fetches, and the engine limits bound the engine alone', () => {
  const SCHEMA = { type: 'object', properties: { id: { type: 'integer' }, s: { type: 'string' }, n: { type: 'integer' }, k: { type: 'integer' } } };
  const DOCUMENTS = Array.from({ length: 60 }, (_, i) => ({ id: i, s: ['a', 'b', 'c', 'd'][i % 4], n: i % 3, k: (i * 7) % 11 }));
  const COMPOUND = distinct({ s: '$it.s', n: '$it.n' });
  const ORDERED = distinct('$it.s', { order: [key('$it.k', 'desc')] });

  it('counts the groups against maxRows, where the engine path counts every row it fetches', async () => {
    await overCollection(SCHEMA, DOCUMENTS, [], async (rows, label) => {
      for (const [name, query] of /** @type {[string, any][]} */ ([['a compound', COMPOUND], ['an ordered distinct', ORDERED]])) {
        const expected = compileJsonQuery(query)(structuredClone(DOCUMENTS));
        const profile = { maxRows: 13 };
        assert.deepEqual(await rows.execute(query, { profile }), expected, `${label}: ${name}`);
        // the engine path fetches the 60 rows and crosses the bound
        await assert.rejects(Promise.resolve().then(() => rows.execute(query, { profile, pushdown: false })), { code: 'JD2007' }, `${label}: ${name}`);
        // and the groups cross it where there are more of them than the bound
        await assert.rejects(Promise.resolve().then(() => rows.execute(query, { profile: { maxRows: expected.length - 1 } })),
          { code: 'JD2007' }, `${label}: ${name}`);
      }
    });
  });

  it('reads no document, so the byte bound of a profile bounds only the engine path', async () => {
    await overCollection(SCHEMA, DOCUMENTS, [], async (rows, label) => {
      const profile = { maxRows: 1000, maxBytes: 20 };
      assert.deepEqual(await rows.execute(COMPOUND, { profile }), compileJsonQuery(COMPOUND)(structuredClone(DOCUMENTS)), label);
      await assert.rejects(Promise.resolve().then(() => rows.execute(COMPOUND, { profile, pushdown: false })), { code: 'JD2076' }, label);
    });
  });

  it('applies the engine limits to the engine path, which a statement-answered result is not', async () => {
    await overCollection(SCHEMA, DOCUMENTS, [], async (rows, label) => {
      for (const limits of [{ resultItems: 3 }, { sequenceItems: 3 }]) {
        const profile = { maxRows: 1000, limits };
        const text = `${label}: ${JSON.stringify(limits)}`;
        assert.deepEqual(await rows.execute(COMPOUND, { profile }), compileJsonQuery(COMPOUND)(structuredClone(DOCUMENTS)), text);
        await assert.rejects(Promise.resolve().then(() => rows.execute(COMPOUND, { profile, pushdown: false })), { code: 'JQ2009' }, text);
      }
    });
  });
});

describe('rows numbered by a key reached by a negative index through a tuple', () => {
  // the last element of [5] is its prefix item, a number, where the schema's `items` says string: the engine
  // cannot order a number against a string (JQ2005) and the database would
  const SCHEMA = { type: 'object', properties: { id: { type: 'integer' }, s: { type: 'string' },
    t: { type: 'array', prefixItems: [{ type: 'number' }], items: { type: 'string' } } } };
  const DOCUMENTS = [{ id: 1, s: 'a', t: [1, 'y'] }, { id: 2, s: 'b', t: [5] }, { id: 3, s: 'a', t: [2, 'p', 'q'] }, { id: 4, s: 'c' }];

  it('stays in the engine, which raises where the statement would answer', async () => {
    await overCollection(SCHEMA, DOCUMENTS, [], async (rows, label) => {
      for (const query of [distinct('$it.s', { order: [key('$it.t[-1]')] }), distinct({ s: '$it.s' }, { order: [key('$it.t[-1]', 'desc')] })]) {
        const text = `${label}: ${JSON.stringify(query)}`;
        const expected = engineOutcome(query, DOCUMENTS);
        assert.equal(expected.code, 'JQ2005', text);
        assert.equal((await rows.explain(query)).mode, 'set', text);
        assert.deepEqual(await outcome(() => rows.execute(query)), expected, text);
      }
      // a key reached by a non-negative index is typed as the schema places it
      const forward = distinct('$it.s', { order: [key('$it.t[1]')] });
      assert.equal((await rows.explain(forward)).mode, 'native', label);
      assert.deepEqual(await outcome(() => rows.execute(forward)), engineOutcome(forward, DOCUMENTS), label);
    });
  });
});

describe('a distinct beside a conjunct that runs as a registered function', () => {
  // the database may leave such a conjunct unevaluated on a row the engine evaluates and raises on, so only a path
  // alone, unordered or ordered by itself, lowers beside one
  const SCHEMA = { type: 'object', properties: { id: { type: 'string' }, s: { type: 'string' }, n: { type: 'number' }, k: { type: 'number' } } };
  const shape = { collection: 'rows', schema: SCHEMA, columnByCanonical: new Map() };
  const udf = () => ({ name: 'registered_stub', key: 'stub' });
  const where = { $eq: [{ $upper: '$it.s' }, 'A'] };

  it('keeps a constructor, and an ordering by other paths, in the engine under the reason that names the function', () => {
    for (const [name, query, mode] of /** @type {[string, any, string][]} */ ([
      ['one path', distinct('$it.s', { where }), 'native'],
      ['one path ordered by itself', distinct('$it.s', { where, order: [key('$it.s', 'desc')] }), 'native'],
      ['a constructor', distinct({ s: '$it.s', n: '$it.n' }, { where }), 'set'],
      ['one path ordered by another', distinct('$it.s', { where, order: [key('$it.k')] }), 'set'],
      ['a constructor ordered by another', distinct({ s: '$it.s' }, { where, order: [key('$it.k')] }), 'set'],
    ])) {
      const planned = planQuery(query, shape, { udf });
      assert.equal(planned.mode, mode, name);
      if (mode === 'set') assert.equal(reasonId(planned.reasons[0].reason), 'plan.registeredFunction', name);
    }
  });
});

describe('a LINQ chain that deduplicates what it projects', () => {
  const SCHEMA = { type: 'object', properties: { id: { type: 'integer' }, s: { type: 'string' }, n: { type: 'integer' }, k: { type: 'integer' } } };
  const DOCUMENTS = [{ id: 1, s: 'x', n: 1, k: 2 }, { id: 2, s: 'y', n: 1, k: 1 }, { id: 3, s: 'x', n: 1, k: 3 },
    { id: 4, s: 'x', n: 2, k: 0 }, { id: 5, s: 'z', n: 2, k: 1 }, { id: 6, n: 2, k: 4 }];
  const CHAINS = /** @type {[string, (source: any[]) => any][]} */ ([
    ['an object of members', (source) => from(source).select((r) => ({ s: r.s, n: r.n })).distinct()],
    ['one member ordered by another', (source) => from(source).orderBy((r) => r.k).select((r) => r.s).distinct()],
    ['an object ordered descending by another member', (source) => from(source).orderByDescending((r) => r.k).select((r) => ({ s: r.s, n: r.n })).distinct()],
    ['a window over the distinct items', (source) => from(source).select((r) => ({ s: r.s, n: r.n })).distinct().skip(1).take(2)],
  ]);

  it('plans the document it emits natively and answers what the chain answers in memory', async () => {
    await overCollection(SCHEMA, DOCUMENTS, [{ name: 'by_s', path: '$.s' }], async (rows, label) => {
      for (const [name, chain] of CHAINS) {
        const document = chain(DOCUMENTS).toDocument();
        assert.equal((await rows.explain(document)).mode, 'native', `${label}: ${name}`);
        assert.deepEqual(await outcome(() => rows.execute(document)), { value: canonical(chain(DOCUMENTS).toArray()) }, `${label}: ${name}`);
      }
    });
  });
});
