//@ts-check
/**
 * @file Worlds for the join-edge rule and for the row identity, read by the
 * SQLite and PostgreSQL tests and by the Bun run, so a host cannot drift
 * from the others unseen. A world is a model with its rows — documents for
 * a store-owned model, the tables' DDL for adopted ones — and the queries
 * asked of it, each with the plan it must have on each host. Every query
 * must answer as the engine answers over the documents the store holds,
 * natively where it plans native (under `strict`) and in the engine with
 * `pushdown: false`.
 *
 * What the worlds pin: a join edge's family is the family the column
 * STORES and the engine DECODES, never a union's first type (a schema that
 * claims another kind than its codec decodes is refused by the model, so no
 * world holds one); two columns that can each read a NULL as a present
 * `null` pair differently in the engine and the database, and every other
 * combination of null readings pairs alike; a mapped column is the only
 * member an edge reads; and a member named like SQLite's row identity does
 * not move the order a join or a fetch comes in.
 */

import { openStore, reasonId } from '@jarenjs/db';

import { onBothEngines, onBothEnginesPhysical } from '../query-core-engines.js';

const KEY = { 'x-entity': { key: true } };

/** @typedef {'native' | 'set'} Mode */
/**
 * A query's plan mode is `Mode`, one for each host, or `'any'` when the world asks only that the store answer as the
 * engine does, whichever way it plans. A world whose columns the PostgreSQL adoption cannot guarantee is `sqliteOnly`.
 * @typedef {{ name: string, query: any, mode: Mode | 'any' | { sqlite: Mode, postgres: Mode },
 *   reason?: string | { sqlite?: string, postgres?: string }, answer?: any, throws?: string }} WorldQuery
 * @typedef {{ name: string, model: any, ddl?: (prefix: string) => string, sqliteOnly?: boolean,
 *   documents?: Record<string, any[]>, queries: WorldQuery[] }} World
 */

/**
 * Open the world on a SQLite driver: the tables first when they are adopted,
 * the documents created through the entity sets otherwise.
 * @param {any} driver
 * @param {World} world
 * @returns {Promise<any>} the store
 */
export async function openSqliteWorld(driver, world) {
  if (world.ddl !== undefined) {
    const db = await driver.open(':memory:');
    db.exec(world.ddl(''));
    return openStore(world.model(null), { driver: { ...driver, open: async () => db }, adopt: true });
  }
  const store = await openStore(world.model, { driver });
  await seedDocuments(store, world.documents ?? {});
  return store;
}

/**
 * @param {any} store
 * @param {Record<string, any[]>} documents
 */
export async function seedDocuments(store, documents) {
  for (const [name, rows] of Object.entries(documents)) for (const row of rows) await store.entity(name).create(row);
}

/**
 * Run `fn` on the world on every host the caller reaches: SQLite in memory,
 * and PostgreSQL in a schema of its own when `JAREN_PG_URL` names a server.
 * @param {World} world
 * @param {(store: any, host: 'sqlite' | 'postgres') => Promise<void>} fn
 */
export async function onWorldHosts(world, fn) {
  if (world.sqliteOnly === true) {
    const { nodeDriver } = await import('@jarenjs/db/node');
    const store = await openSqliteWorld(nodeDriver(), world);
    try {
      await fn(store, 'sqlite');
    }
    finally {
      await store.close();
    }
    return;
  }
  if (world.ddl !== undefined) return onBothEnginesPhysical(world.model, world.ddl, fn);
  return onBothEngines(world.model, async (store, host) => {
    await seedDocuments(store, world.documents ?? {});
    await fn(store, host);
  });
}

/**
 * Hold a world to the engine on one host.
 * @param {any} store
 * @param {World} world
 * @param {'sqlite' | 'postgres'} host
 * @returns {Promise<string[]>} one message for each check that does not hold
 */
export async function checkWorld(store, world, host) {
  /** @type {string[]} */
  const failures = [];
  const run = (/** @type {any} */ query, /** @type {any} */ options) =>
    Promise.resolve().then(() => store.execute(query, options)).then(
      (value) => JSON.stringify(value === undefined ? '__empty__' : value), (error) => `throws ${error.code}`);
  for (const kase of world.queries) {
    const label = `${host}: ${world.name}: ${kase.name}`;
    let explained;
    try {
      explained = await store.explain(kase.query);
    }
    catch (error) {
      failures.push(`${label}: explain throws ${/** @type {any} */ (error).code}`);
      continue;
    }
    const want = kase.mode === 'any' ? explained.mode : typeof kase.mode === 'string' ? kase.mode : kase.mode[host];
    if (explained.mode !== want) failures.push(`${label}: plans ${explained.mode}, wanted ${want}`);
    const reason = typeof kase.reason === 'object' ? kase.reason[host] : kase.reason;
    if (explained.mode === 'set' && reason !== undefined) {
      const named = reasonId(explained.residual.reasons[0].reason);
      if (named !== reason) failures.push(`${label}: names ${named}, wanted ${reason}`);
    }
    const engine = await run(kase.query, { pushdown: false });
    const native = await run(kase.query, want === 'native' ? { strict: true } : undefined);
    if (native !== engine) failures.push(`${label}: the store answers ${native}, the engine ${engine}`);
    if (kase.answer !== undefined && engine !== JSON.stringify(kase.answer === null ? '__empty__' : kase.answer))
      failures.push(`${label}: the engine answers ${engine}, wanted ${JSON.stringify(kase.answer)}`);
    if (kase.throws !== undefined && engine !== `throws ${kase.throws}`)
      failures.push(`${label}: the engine answers ${engine}, wanted it to throw ${kase.throws}`);
  }
  return failures;
}

// ————— the comparison family a join edge reads —————

const join = (/** @type {any} */ where, /** @type {any} */ ret = { a: '$a.id', b: '$b.id' }) =>
  ({ $for: { a: '$.A[*]', b: '$.B[*]' }, $where: where, $return: ret });
const eq = (/** @type {string} */ left, /** @type {string} */ right) => ({ $eq: [left, right] });

/**
 * Tables `a` and `b` (and `c`), each an integer key `id` and one member `v`:
 * the model's claim on the property, the column's codec and NULL policy, the
 * SQL type and the rows.
 * @param {Record<string, { claim: any, codec: string, policy?: string, sql: string, rows: string[] }>} tables
 * @param {boolean} [indexed] - an index over each `v`
 * @returns {Pick<World, 'model' | 'ddl'>}
 */
function adoptedPair(tables, indexed = false) {
  return {
    model: (/** @type {string | null} */ schema) => ({ $model: '0.1', entities: Object.fromEntries(Object.entries(tables).map(([table, spec]) => [
      table.toUpperCase(), {
        schema: { type: 'object', required: ['id'], properties: { id: { type: 'integer', ...KEY }, v: spec.claim } },
        physical: { ...(schema === null ? {} : { schema }), table, columns: {
          id: { name: 'id', codec: 'integer', null: 'reject' },
          v: { name: 'v', codec: spec.codec, null: spec.policy ?? 'reject' } } },
      }])) }),
    ddl: (/** @type {string} */ prefix) => Object.entries(tables).map(([table, spec]) =>
      `CREATE TABLE ${prefix}${table} (id integer PRIMARY KEY, v ${spec.sql.replace('REAL', prefix === '' ? 'real' : 'double precision').replace('BOOL', prefix === '' ? 'integer' : 'boolean')}${spec.policy === 'reject' || spec.policy === undefined ? ' NOT NULL' : ''});\n`
      + spec.rows.map((row, i) => `INSERT INTO ${prefix}${table} VALUES (${i + 1}, ${row});`).join('\n')
      + (indexed ? `\nCREATE INDEX ${table}_v ON ${prefix}${table} (v);` : '')).join('\n'),
  };
}

/**
 * Column worlds in which the schema's claim and the column's storage part:
 * a union whose first type is not what the column holds (a type over a codec
 * of another kind is no world: the model refuses it). SQLite pairs `'1'` with `1` by affinity and
 * PostgreSQL raises `JD2005` (`operator does not exist`) where the engine
 * pairs nothing; the same columns correlate a hop and refine an edge the same
 * way.
 * @type {World[]}
 */
export const FAMILY_WORLDS = [
  {
    name: 'a union over a text column',
    ...adoptedPair({
      a: { claim: { type: ['integer', 'string'] }, codec: 'text', sql: 'text', rows: ["'1'", "'abc'"] },
      b: { claim: { type: 'integer' }, codec: 'integer', sql: 'integer', rows: ['1', '2'] },
      c: { claim: { type: 'number' }, codec: 'number', sql: 'REAL', rows: ['1.0', '2.5'] },
    }),
    queries: [
      { name: 'against an integer column', query: join(eq('$a.v', '$b.v')), mode: 'set', reason: 'entity.joinKey', answer: null },
      { name: 'against a number column', mode: 'set', reason: 'entity.joinKey', answer: null,
        query: { $for: { a: '$.A[*]', c: '$.C[*]' }, $where: eq('$a.v', '$c.v'), $return: { a: '$a.id', c: '$c.id' } } },
      { name: 'grouped', mode: 'set', reason: 'entity.joinKey',
        query: { ...join(eq('$a.v', '$b.v'), { k: '$k', n: { $count: '$b' } }), $groupby: { k: '$a.id' } } },
      { name: 'a refinement beside a key edge', mode: 'set', reason: 'entity.conjunctBinding', answer: null,
        query: join({ $and: [eq('$a.id', '$b.id'), { $lt: ['$a.v', '$b.v'] }] }) },
      { name: 'a hop correlated on the columns', mode: 'set', reason: 'entity.hopShape',
        query: { $for: { a: '$.A[*]' }, $where: { $ge: [{ $count: { $for: { r: '$.B[*]' }, $where: eq('$r.v', '$a.v'), $return: '$r' } }, 1] }, $return: '$a.id' } },
    ],
  },
  {
    // the first type is the column's kind, so SQL and the engine would pair alike here; a union is refused whatever its order
    name: 'a union whose first type is the column\'s kind',
    ...adoptedPair({
      a: { claim: { type: ['string', 'integer'] }, codec: 'text', sql: 'text', rows: ["'1'", "'abc'"] },
      b: { claim: { type: 'string' }, codec: 'text', sql: 'text', rows: ["'abc'", "'2'"] },
    }),
    queries: [
      { name: 'against a text column', query: join(eq('$a.v', '$b.v')), mode: 'set', reason: 'entity.joinKey', answer: { a: 2, b: 1 } },
    ],
  },
  {
    name: 'columns whose claim and storage agree',
    ...adoptedPair({
      a: { claim: { type: 'string' }, codec: 'text', sql: 'text', rows: ["'1'", "'2'"] },
      b: { claim: { type: 'string' }, codec: 'text', sql: 'text', rows: ["'2'", "'3'"] },
      d: { claim: { type: 'number' }, codec: 'number', sql: 'REAL', rows: ['2.0', '5.5'] },
      e: { claim: { type: 'integer' }, codec: 'integer', sql: 'integer', rows: ['2', '7'] },
    }),
    queries: [
      { name: 'text against text', query: join(eq('$a.v', '$b.v')), mode: 'native', answer: { a: 2, b: 1 } },
      { name: 'a number against an integer', mode: 'native', answer: { d: 1, e: 1 },
        query: { $for: { d: '$.D[*]', e: '$.E[*]' }, $where: eq('$d.v', '$e.v'), $return: { d: '$d.id', e: '$e.id' } } },
    ],
  },
];

// ————— the matrix: every claim over every codec —————

/** What a property can claim of a column. */
const MATRIX_CLAIMS = {
  integer: { type: 'integer' }, number: { type: 'number' }, string: { type: 'string' }, boolean: { type: 'boolean' },
  'integer|string': { type: ['integer', 'string'] }, 'string|null': { type: ['string', 'null'] },
  'integer|null': { type: ['integer', 'null'] }, date: { type: 'string', format: 'date' },
  'date-time': { type: 'string', format: 'date-time' }, untyped: {},
};
/** The codecs a column holds, with the SQL type and the rows each is given. */
const MATRIX_CODECS = {
  text: { sql: 'text', rows: ["'1'", "'2'", "'2020-01-01'", "'2020-01-01T00:00:00Z'"] },
  integer: { sql: 'integer', rows: ['1', '2', '3', '0'] },
  number: { sql: 'REAL', rows: ['1.0', '2.5', '3.0', '0.0'] },
  boolean: { sql: 'BOOL', rows: ['TRUE', 'FALSE', 'TRUE', 'FALSE'] },
  date: { sql: 'text', rows: ["'2020-01-01'", "'2020-01-02'", "'2021-01-01'", "'2021-01-02'"] },
  datetime: { sql: 'text', rows: ["'2020-01-01T00:00:00Z'", "'2020-01-02T00:00:00Z'", "'2021-01-01T00:00:00Z'", "'2021-01-02T00:00:00Z'"] },
};
/** The comparison family a claim names, and the one a codec stores: a column has a family only where the two are one. */
const CLAIM_FAMILY = { integer: 'number', number: 'number', string: 'string', 'string|null': 'string', 'integer|null': 'number', date: 'string', 'date-time': 'string' };
const CODEC_FAMILY = { text: 'string', integer: 'number', number: 'number' };

/**
 * One claim over one codec, joined to an integer column and to a text column
 * on their values. A join is native exactly where both columns have the same
 * family, and every cell answers as the engine does, whichever way it plans.
 * The date codecs are SQLite's only (PostgreSQL cannot guarantee them over
 * text), and their cells ask only for the engine's answer.
 * @param {string} claim
 * @param {string} codec
 * @returns {World}
 */
function matrixWorld(claim, codec) {
  const exact = codec in CODEC_FAMILY || codec === 'boolean';
  const family = /** @type {any} */ (CLAIM_FAMILY)[claim] === /** @type {any} */ (CODEC_FAMILY)[codec] ? /** @type {any} */ (CODEC_FAMILY)[codec] ?? null : null;
  const plan = (/** @type {string} */ other) => (!exact ? { mode: /** @type {const} */ ('any') }
    : family !== null && family === other ? { mode: /** @type {Mode} */ ('native') }
      : { mode: /** @type {Mode} */ ('set'), reason: 'entity.joinKey' });
  const held = /** @type {any} */ (MATRIX_CODECS)[codec];
  return {
    name: `a ${claim} claim over a ${codec} column`,
    sqliteOnly: !exact,
    ...adoptedPair({
      a: { claim: /** @type {any} */ (MATRIX_CLAIMS)[claim], codec, sql: held.sql, rows: held.rows },
      b: { claim: { type: 'integer' }, codec: 'integer', sql: 'integer', rows: MATRIX_CODECS.integer.rows },
      c: { claim: { type: 'string' }, codec: 'text', sql: 'text', rows: MATRIX_CODECS.text.rows },
    }),
    queries: [
      { name: 'against an integer column', query: join(eq('$a.v', '$b.v')), ...plan('number') },
      { name: 'against a text column', ...plan('string'),
        query: { $for: { a: '$.A[*]', c: '$.C[*]' }, $where: eq('$a.v', '$c.v'), $return: { a: '$a.id', c: '$c.id' } } },
    ],
  };
}

/** The kinds a claim admits of a stored value, `null` for a claim that names none. */
const CLAIM_KINDS = { integer: ['number'], number: ['number'], string: ['string'], boolean: ['boolean'],
  'integer|string': ['number', 'string'], 'string|null': ['string'], 'integer|null': ['number'], date: ['string'],
  'date-time': ['string'], untyped: null };
/** The kind a codec decodes to. */
const CODEC_KIND = { text: 'string', integer: 'number', number: 'number', boolean: 'boolean', date: 'string', datetime: 'string' };

const MATRIX_CELLS = Object.keys(MATRIX_CLAIMS).flatMap((claim) => Object.keys(MATRIX_CODECS).map((codec) => {
  const kinds = /** @type {any} */ (CLAIM_KINDS)[claim];
  return { claim, codec, admitted: kinds === null || kinds.includes(/** @type {any} */ (CODEC_KIND)[codec]) };
}));

/** Every claim over every codec the model admits, as the review's matrix drew it. @type {World[]} */
export const FAMILY_MATRIX_WORLDS = MATRIX_CELLS.filter((cell) => cell.admitted).map((cell) => matrixWorld(cell.claim, cell.codec));

/** Every claim the model refuses over the codec it disagrees with, as a world to open. @type {World[]} */
export const REFUSED_CLAIM_WORLDS = MATRIX_CELLS.filter((cell) => !cell.admitted).map((cell) => matrixWorld(cell.claim, cell.codec));

// ————— the nulls a join edge may pair —————

const pairs = (/** @type {string} */ left, /** @type {string} */ right) => ({
  $for: { u: '$.U[*]', p: '$.P[*]' }, $where: eq(left, right), $return: { u: '$u.id', p: '$p.pid' } });

/**
 * A store-owned column whose NULL reads back as no member (policy `absent`)
 * hands the engine an empty sequence, which pairs with nothing, as SQL's
 * unknown does: so a nullable member joins natively against a key, against
 * another nullable member holding its NULLs and absences on both sides, and
 * as a declared optional foreign key. Indexed or not.
 * @param {boolean} indexed
 * @returns {World[]}
 */
function absentWorlds(indexed) {
  const index = indexed ? { 'x-entity': { index: true } } : {};
  const tag = '$p.tag';
  return [
    {
      name: `a nullable member${indexed ? ' (indexed)' : ''}`,
      model: { $model: '0.1', entities: {
        U: { schema: { type: 'object', required: ['id'], properties: {
          id: { type: 'integer', ...KEY }, tag: { type: ['string', 'null'], ...index } } } },
        P: { schema: { type: 'object', required: ['pid'], properties: {
          pid: { type: 'integer', ...KEY }, tag: { type: ['string', 'null'], ...index }, ref: { type: ['string', 'null'], ...index } } } } } },
      documents: {
        U: [{ id: 1, tag: null }, { id: 2, tag: 'x' }, { id: 3 }, { id: 4, tag: 'y' }, { id: 5, tag: null }],
        P: [{ pid: 1, tag: null, ref: 'x' }, { pid: 2, tag: 'x', ref: null }, { pid: 3, ref: 'y' }, { pid: 4, tag: 'z' }, { pid: 5, tag: null, ref: 'x' }],
      },
      queries: [
        { name: 'against another nullable member, a NULL on each side', query: pairs(tag, '$u.tag'), mode: 'native', answer: { u: 2, p: 2 } },
        { name: 'against another nullable member, the other way', query: pairs('$u.tag', tag), mode: 'native', answer: { u: 2, p: 2 } },
        { name: 'with a difference beside it', mode: 'set', reason: 'entity.conjunctBinding',
          query: { $for: { u: '$.U[*]', p: '$.P[*]' }, $where: { $and: [eq(tag, '$u.tag'), { $ne: ['$p.ref', '$u.tag'] }] }, $return: { u: '$u.id', p: '$p.pid' } } },
      ],
    },
    {
      name: `a nullable member against a key${indexed ? ' (indexed)' : ''}`,
      model: { $model: '0.1', entities: {
        U: { schema: { type: 'object', required: ['id'], properties: { id: { type: 'string', ...KEY } } } },
        P: { schema: { type: 'object', required: ['pid'], properties: {
          pid: { type: 'integer', ...KEY }, ref: { type: ['string', 'null'], ...index } } } } } },
      documents: {
        U: [{ id: 'u1' }, { id: 'u2' }, { id: 'u3' }],
        P: [{ pid: 1, ref: 'u1' }, { pid: 2, ref: null }, { pid: 3 }, { pid: 4, ref: 'u2' }, { pid: 5, ref: 'ghost' }, { pid: 6, ref: 'u1' }],
      },
      queries: [
        { name: 'the member first', query: pairs('$p.ref', '$u.id'), mode: 'native' },
        { name: 'the key first', query: pairs('$u.id', '$p.ref'), mode: 'native' },
        { name: 'grouped by the key', mode: { sqlite: 'native', postgres: 'set' }, query: { $for: { u: '$.U[*]', p: '$.P[*]' }, $where: eq('$p.ref', '$u.id'),
          $groupby: { k: '$u.id' }, $return: { k: '$k', n: { $count: '$p' } } } },
      ],
    },
    {
      name: `a declared optional foreign key${indexed ? ' (indexed)' : ''}`,
      model: { $model: '0.1', entities: {
        U: { schema: { type: 'object', required: ['id'], properties: { id: { type: 'string', ...KEY }, name: { type: 'string' },
          posts: { 'x-entity': { relation: { to: 'P', many: true, via: 'authorId', onDelete: 'cascade' } } } } } },
        P: { schema: { type: 'object', required: ['pid'], properties: {
          pid: { type: 'integer', ...KEY }, authorId: { type: ['string', 'null'], ...index } } } } } },
      documents: { U: [{ id: 'u1', name: 'one' }, { id: 'u2', name: 'two' }], P: [{ pid: 1, authorId: 'u1' }, { pid: 2, authorId: null }, { pid: 3 }, { pid: 4, authorId: 'u2' }] },
      queries: [
        { name: 'the idiom', query: pairs('$p.authorId', '$u.id'), mode: 'native' },
      ],
    },
  ];
}

/**
 * Adopted columns, three combinations of readings. A column whose policy
 * reads a NULL as a present `null` pairs, in the engine, with another such
 * column's `null` and with nothing else; SQL pairs none. So two of them are
 * the engine's, and one against a key or against a column whose NULL reads
 * as no member is native (PostgreSQL keeps every such column out of a native
 * statement, so its plan is the engine's whatever the combination).
 * @param {boolean} indexed
 * @param {any} claim - the schema's claim on the null-policy column
 * @returns {World[]}
 */
function presentWorlds(indexed, claim) {
  const label = `${indexed ? ' (indexed)' : ''}${Array.isArray(claim.type) ? ', typed to admit null' : ''}`;
  const native = { sqlite: /** @type {Mode} */ ('native'), postgres: /** @type {Mode} */ ('set') };
  const onV = (/** @type {string} */ l, /** @type {string} */ r) => join(eq(l, r));
  return [
    {
      name: `a null-policy column against a key${label}`,
      ...adoptedPair({
        a: { claim, codec: 'text', policy: 'null', sql: 'text', rows: ['NULL', "'x'", "'y'", 'NULL'] },
        b: { claim: { type: 'string' }, codec: 'text', sql: 'text', rows: ["'x'", "'y'", "'z'"] },
      }, indexed),
      queries: [
        { name: 'the column first', query: onV('$a.v', '$b.v'), mode: native, answer: [{ a: 2, b: 1 }, { a: 3, b: 2 }] },
        { name: 'the key first', query: join(eq('$b.v', '$a.v'), { a: '$a.id', b: '$b.id' }), mode: native },
      ],
    },
    {
      name: `two null-policy columns${label}`,
      ...adoptedPair({
        a: { claim, codec: 'text', policy: 'null', sql: 'text', rows: ['NULL', "'x'", 'NULL'] },
        b: { claim, codec: 'text', policy: 'null', sql: 'text', rows: ['NULL', "'x'", "'y'"] },
      }, indexed),
      queries: [
        { name: 'the engine pairs the nulls', query: onV('$a.v', '$b.v'), mode: 'set', reason: 'entity.joinKey',
          answer: [{ a: 1, b: 1 }, { a: 2, b: 2 }, { a: 3, b: 1 }] },
      ],
    },
    {
      name: `a null-policy column against a column whose NULL reads as no member${label}`,
      ...adoptedPair({
        a: { claim, codec: 'text', policy: 'null', sql: 'text', rows: ['NULL', "'x'", "'y'"] },
        b: { claim: { type: ['string', 'null'] }, codec: 'text', policy: 'absent', sql: 'text', rows: ['NULL', "'x'", 'NULL'] },
      }, indexed),
      queries: [
        { name: 'the null-policy column first', query: onV('$a.v', '$b.v'), mode: native, answer: { a: 2, b: 2 } },
        { name: 'the other first', query: join(eq('$b.v', '$a.v'), { a: '$a.id', b: '$b.id' }), mode: native, answer: { a: 2, b: 2 } },
      ],
    },
    {
      name: `two columns whose NULL reads as no member${label}`,
      ...adoptedPair({
        a: { claim: { type: ['string', 'null'] }, codec: 'text', policy: 'absent', sql: 'text', rows: ['NULL', "'x'", 'NULL', "'y'"] },
        b: { claim: { type: ['string', 'null'] }, codec: 'text', policy: 'absent', sql: 'text', rows: ['NULL', "'x'", "'z'", 'NULL'] },
      }, indexed),
      queries: [
        { name: 'a NULL on each side', query: onV('$a.v', '$b.v'), mode: 'native', answer: { a: 2, b: 2 } },
      ],
    },
  ];
}

/** The null combinations a join edge sees, every one indexed and unindexed. @type {World[]} */
export const NULL_WORLDS = [false, true].flatMap((indexed) => [
  ...absentWorlds(indexed),
  ...presentWorlds(indexed, { type: 'string' }),
  ...presentWorlds(indexed, { type: ['string', 'null'] }),
]);

// ————— only a mapped column is an edge —————

/**
 * An epoch member (a date-time string kept in the document beside an integer
 * column) and a nested document member have the family of the column they are
 * compared with, and are no edge: the first stores an integer beside the
 * string the engine reads, the second is not a column at all.
 * @type {World[]}
 */
export const FLAVOR_WORLDS = [{
  name: 'members that are not plain columns',
  model: { $model: '0.1', entities: {
    U: { schema: { type: 'object', required: ['id'], properties: {
      id: { type: 'integer', ...KEY }, joined: { type: 'string', format: 'date-time', 'x-entity': { column: 'integer' } },
      meta: { type: 'object', properties: { tag: { type: 'string' } } }, label: { type: 'string' } } } },
    P: { schema: { type: 'object', required: ['pid'], properties: {
      pid: { type: 'integer', ...KEY }, uid: { type: 'integer' }, when: { type: 'string', format: 'date-time', 'x-entity': { column: 'integer' } },
      tag: { type: 'string' } } } } } },
  documents: {
    U: [{ id: 1, joined: '2026-01-01T00:00:00Z', meta: { tag: 'a' }, label: 'a' }, { id: 2, joined: '2026-01-02T00:00:00Z', meta: { tag: 'b' }, label: 'b' }],
    P: [{ pid: 1, uid: 1, when: '2026-01-01T00:00:00Z', tag: 'a' }, { pid: 2, uid: 2, when: '2026-01-03T00:00:00Z', tag: 'b' },
      { pid: 3, uid: 1, when: '2026-01-02T00:00:00Z', tag: 'b' }],
  },
  queries: [
    { name: 'two epoch members', query: pairs('$u.joined', '$p.when'), mode: 'set', reason: 'entity.joinKey' },
    { name: 'a nested member against a column', query: pairs('$u.meta.tag', '$p.tag'), mode: 'set', reason: 'entity.joinKey' },
    { name: 'an epoch member beside a key edge', mode: 'set', reason: 'entity.conjunctBinding',
      query: { $for: { u: '$.U[*]', p: '$.P[*]' }, $where: { $and: [eq('$p.uid', '$u.id'), eq('$u.joined', '$p.when')] }, $return: { u: '$u.id', p: '$p.pid' } } },
    { name: 'a nested member beside a key edge', mode: 'set', reason: 'entity.conjunctBinding',
      query: { $for: { u: '$.U[*]', p: '$.P[*]' }, $where: { $and: [eq('$p.uid', '$u.id'), eq('$u.meta.tag', '$p.tag')] }, $return: { u: '$u.id', p: '$p.pid' } } },
    { name: 'the plain columns of the same tables', query: pairs('$p.uid', '$u.id'), mode: 'native' },
  ],
}];

// ————— a member named like the row identity —————

/**
 * SQLite resolves a name to a column of the table before it resolves it to
 * the row: a member named `rowid`, `oid` or `_rowid_` (in any case) shadows
 * that spelling of the row identity, and the order the rows come in, which is
 * the insertion order, must be read through a spelling that is left. Rows
 * with tied values of the member, so that reading the member instead of the
 * row would put the groups and the rows in another order than the engine's.
 * @param {string[]} members - the members the table declares
 * @param {boolean} spelled - a spelling is left: the insertion order is the answer
 * @returns {World}
 */
function identityWorld(members, spelled) {
  const tied = (/** @type {number} */ i) => Object.fromEntries(members.map((name) => [name, [5, 5, 1][i]]));
  /** @type {{ sqlite: Mode, postgres: Mode }} */
  const alone = { sqlite: spelled ? 'native' : 'set', postgres: 'native' };
  /** @type {{ sqlite: Mode, postgres: Mode }} */
  const grouped = { sqlite: spelled ? 'native' : 'set', postgres: 'set' };
  const reason = spelled ? {} : { reason: { sqlite: 'bind.identity', postgres: 'bind.entityGrouping' } };
  const answered = (/** @type {any} */ answer) => (spelled ? { answer } : {});
  return {
    name: `a table with ${members.length === 1 ? `a member named ${members[0]}` : `members named ${members.join(', ')}`}`,
    model: { $model: '0.1', entities: {
      A: { schema: { type: 'object', required: ['id'], properties: {
        id: { type: 'string', ...KEY }, ...Object.fromEntries(members.map((name) => [name, { type: 'integer' }])) } } },
      B: { schema: { type: 'object', required: ['id'], properties: { id: { type: 'string', ...KEY }, aid: { type: 'string' } } } } } },
    documents: {
      A: ['z', 'y', 'x'].map((id, i) => ({ id, ...tied(i) })),
      B: [{ id: 'b1', aid: 'x' }, { id: 'b2', aid: 'y' }, { id: 'b3', aid: 'z' }],
    },
    queries: [
      { name: 'the rows of one table', query: { $for: { a: '$.A[*]' }, $return: '$a.id' }, mode: alone,
        ...(spelled ? {} : { reason: 'bind.identity' }), ...answered(['z', 'y', 'x']) },
      { name: 'a join', query: { $for: { a: '$.A[*]', b: '$.B[*]' }, $where: eq('$b.aid', '$a.id'), $return: '$b.id' }, mode: alone,
        ...(spelled ? {} : { reason: 'bind.identity' }), ...answered(['b3', 'b2', 'b1']) },
      { name: 'a grouped join', mode: grouped, ...reason,
        query: { $for: { a: '$.A[*]', b: '$.B[*]' }, $where: eq('$b.aid', '$a.id'), $groupby: { k: '$a.id' }, $return: { k: '$k', n: { $count: '$b' } } },
        ...answered([{ k: 'z', n: 1 }, { k: 'y', n: 1 }, { k: 'x', n: 1 }]) },
    ],
  };
}

/**
 * A foreign key is a column too: one named `rowid` (a relation's `via`, no
 * property declares it) shadows the spelling the same way. The child rows come
 * in insertion order, `b1`, `b2`, `b3`, though the keys they hold run the
 * other way.
 * @type {World}
 */
const KEY_NAMED_LIKE_THE_IDENTITY = {
  name: 'a table whose foreign key is named rowid',
  model: { $model: '0.1', entities: {
    A: { schema: { type: 'object', required: ['id'], properties: { id: { type: 'string', ...KEY },
      bs: { 'x-entity': { relation: { to: 'B', many: true, via: 'rowid', onDelete: 'cascade' } } } } } },
    B: { schema: { type: 'object', required: ['id'], properties: { id: { type: 'string', ...KEY } } } } } },
  documents: {
    A: [{ id: 'x' }, { id: 'y' }, { id: 'z' }],
    B: [{ id: 'b1', rowid: 'z' }, { id: 'b2', rowid: 'y' }, { id: 'b3', rowid: 'x' }],
  },
  queries: [
    { name: 'the rows of one table', query: { $for: { b: '$.B[*]' }, $return: '$b.id' }, mode: 'native', answer: ['b1', 'b2', 'b3'] },
    { name: 'a join', mode: 'native', answer: ['b1', 'b2', 'b3'],
      query: { $for: { b: '$.B[*]', a: '$.A[*]' }, $where: eq('$b.rowid', '$a.id'), $return: '$b.id' } },
  ],
};

/**
 * Each spelling alone, and all of them: with every spelling taken the table
 * has no row identity to order by, and its rows are the residual's, in the
 * order of the spelling it shadows.
 * @type {World[]}
 */
export const IDENTITY_WORLDS = [
  ...['rowid', 'ROWID', '_rowid_', 'oid'].map((name) => identityWorld([name], true)),
  identityWorld(['rowid', 'oid', '_rowid_'], false),
  KEY_NAMED_LIKE_THE_IDENTITY,
];

// ————— the one reading of a null, asked by an ordering —————

const ordered = (/** @type {string} */ key) => ({ $for: { e: '$.E[*]' }, $orderby: [key], $return: '$e.id' });
const grouped = (/** @type {string} */ key) =>
  ({ $for: { e: '$.E[*]' }, $groupby: { g: key }, $orderby: ['$g'], $return: { g: '$g', n: { $count: '$e' } } });

/**
 * A column whose NULL reads back as no member orders natively (the engine
 * places an empty key by `$empty`, SQL by NULLS FIRST), and a document member
 * that admits `null`, or a column whose policy reads a NULL as a `null`, does
 * not: the engine refuses to order a `null` (`JQ2005`).
 * @type {World[]}
 */
export const ORDER_WORLDS = [
  {
    name: 'an ordering over nullable members',
    model: { $model: '0.1', entities: {
      E: { schema: { type: 'object', required: ['id'], properties: {
        id: { type: 'integer', ...KEY }, tag: { type: ['string', 'null'] },
        meta: { type: 'object', properties: { tag: { type: ['string', 'null'] } } } } } } } },
    documents: { E: [{ id: 1, tag: 'b', meta: { tag: 'b' } }, { id: 2, tag: null, meta: { tag: null } }, { id: 3, tag: 'a', meta: { tag: 'a' } }, { id: 4 }] },
    queries: [
      { name: 'a nullable column', query: ordered('$e.tag'), mode: 'native', answer: [2, 4, 3, 1] },
      { name: 'a nullable document member', query: ordered('$e.meta.tag'), mode: 'set', reason: 'entity.order' },
      // the engine places the group with no key first, as SQL places a NULL, but a grouping orders only
      // keys it has proved: this one stays the engine's, beside a key that cannot be null
      { name: 'a grouping ordered by a nullable column', query: grouped('$e.tag'), mode: 'set', reason: 'entity.projection',
        answer: [{ n: 2 }, { g: 'a', n: 1 }, { g: 'b', n: 1 }] },
      { name: 'a grouping ordered by a column that holds no null', query: grouped('$e.id'),
        mode: { sqlite: 'native', postgres: 'set' }, reason: { postgres: 'bind.entityGrouping' },
        answer: [{ g: 1, n: 1 }, { g: 2, n: 1 }, { g: 3, n: 1 }, { g: 4, n: 1 }] },
    ],
  },
  {
    // the engine refuses to order or fold a boolean, where SQL orders and folds the 0/1 it stores
    name: 'a column that stores a boolean',
    ...adoptedPair({ a: { claim: { type: 'boolean' }, codec: 'boolean', sql: 'BOOL', rows: ['TRUE', 'FALSE', 'TRUE'] } }),
    queries: [
      { name: 'an ordering by the column', query: { $for: { a: '$.A[*]' }, $orderby: ['$a.v'], $return: '$a.id' },
        mode: 'set', reason: 'entity.order', throws: 'JQ2005' },
      { name: 'a maximum of the column per group', mode: 'set', reason: 'entity.projection', throws: 'JQ2001',
        query: { $for: { a: '$.A[*]' }, $groupby: { k: '$a.id' }, $return: { k: '$k', m: { $max: '$a.v' } } } },
      { name: 'a minimum of the column per group of a join', mode: 'set', reason: 'entity.projection', throws: 'JQ2001',
        query: { $for: { a: '$.A[*]', b: '$.A[*]' }, $where: { $eq: ['$a.id', '$b.id'] }, $groupby: { k: '$a.id' }, $return: { k: '$k', m: { $min: '$b.v' } } } },
      { name: 'groups ordered by the column', mode: 'set', reason: 'entity.projection', throws: 'JQ2005',
        query: { $for: { a: '$.A[*]' }, $groupby: { k: '$a.v' }, $orderby: ['$k'], $return: { k: '$k', n: { $count: '$a' } } } },
    ],
  },
  {
    name: 'an ordering over a column whose NULL reads as a null',
    ...adoptedPair({ e: { claim: { type: 'string' }, codec: 'text', policy: 'null', sql: 'text', rows: ["'b'", 'NULL', "'a'"] } }),
    queries: [
      { name: 'the column', query: ordered('$e.v'), mode: 'set', reason: 'entity.order' },
    ],
  },
];
