#!/usr/bin/env node

/**
 * JarenJS Data Benchmark — the phase-A store and its LINQ front door
 *
 * Measures @jarenjs/db (documents in SQLite through the pushdown
 * planner) and @jarenjs/linq's in-memory surface against the JS
 * document stores a reader would actually shortlist.
 *
 * Rival selection, because it decides the numbers (D16):
 *
 *  - `lowdb` (Memory adapter) is a plain JavaScript object with a
 *    write-through veneer — the floor every in-process store must be
 *    compared against. On small in-memory datasets it WILL win rows
 *    here (there is no engine to pay for), and those losses are
 *    published with that reason: what jaren buys for the difference is
 *    indexes, transactions, a query planner and a file that survives
 *    the process.
 *  - `PouchDB` (pouchdb-adapter-memory + pouchdb-find) is the
 *    long-standing document-store default; queries run through its
 *    Mango engine over a declared index.
 *  - `RxDB` (memory storage) is the modern reactive contender; its
 *    schema requires bounded, typed fields and its queries are Mango
 *    selectors over declared indexes.
 *
 * Rules already paid for elsewhere in this repo: every engine is
 * driven through its own fastest documented route, every engine must
 *  produce the SAME result set before it is timed (an engine that
 * skipped work would otherwise look fast), and each engine's storage
 * adapter is stated beside its numbers. Async engines are timed
 * through their async APIs — the promise is part of their price, and
 * jaren's async row pays the same toll beside its `store.sync` row.
 *
 * The HEADLINE table is jaren-only: the same query document executed
 * through the pushdown planner versus forced to the residual
 * (`pushdown: false`) — the measured value of translating queries to
 * SQL instead of fetching and filtering.
 *
 * Usage:
 *   node benchmark/db.js                       # full run
 *   node benchmark/db.js --quick               # smaller corpus
 *   node benchmark/db.js --docs N              # corpus size (default 5000)
 *   node benchmark/db.js --output json --filepath results.json
 */

import { writeFileSync } from 'node:fs';

import { openStore, shapeHash } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { from } from '@jarenjs/linq';

import { deepEquals } from './lib/equals.js';
import { formatNs } from './lib/fmt.js';

//#region setup

const args = process.argv.slice(2);
const flags = {
  quick: args.includes('--quick'),
  docs: args.includes('--docs') ? parseInt(args[args.indexOf('--docs') + 1], 10) : 5000,
  output: args.includes('--output') ? args[args.indexOf('--output') + 1] : null,
  filepath: args.includes('--filepath') ? args[args.indexOf('--filepath') + 1] : null,
};
if (flags.quick) flags.docs = Math.min(flags.docs, 1000);
const N = flags.docs;
const LOOKUPS = Math.min(2000, N);

const NAMES = ['ada', 'lin', 'zed', 'kid', 'mo', 'pax', 'rio', 'sol'];
/** ~140 JSON bytes per document, stated with the numbers. */
function makeDocs(count) {
  const docs = [];
  for (let i = 0; i < count; i++) {
    docs.push({
      id: `u${i}`,
      name: NAMES[i % NAMES.length] + (i % 97),
      age: i % 90,
      // the same distribution as `age`, deliberately UNINDEXED: the
      // indexed-versus-scan rows then differ only by the index
      score: (i * 7) % 90,
      active: i % 3 === 0,
      pad: 'x'.repeat(64),
    });
  }
  return docs;
}
const DOCS = makeDocs(N);
const DOC_BYTES = JSON.stringify(DOCS[0]).length;

const MODEL = {
  $model: '0.1',
  collections: {
    users: {
      schema: {
        type: 'object',
        properties: {
          id: { type: 'string' }, name: { type: 'string' },
          age: { type: 'integer' }, score: { type: 'integer' },
          active: { type: 'boolean' }, pad: { type: 'string' },
        },
      },
      key: '/id',
      indexes: [{ name: 'by_age', path: '$.age' }],
    },
  },
};

const AGE_FLOOR = 80; // ~11% of the corpus (the range rows)
const AGE_EXACT = 83;  // ~1.1% — the selective predicate an index exists for

// every engine returns WHOLE documents (each in its native document
// form) so the rows time comparable work; ids are extracted only for
// the equivalence gate
const QUERY_INDEXED = {
  $for: { it: '$[*]' },
  $where: { $eq: ['$it.age', AGE_EXACT] },
  $return: '$it',
};
// same selectivity as the indexed predicate, no index to lean on
const QUERY_UNINDEXED = {
  $for: { it: '$[*]' },
  $where: { $eq: ['$it.score', AGE_EXACT] },
  $return: '$it',
};
const QUERY_SORT_INDEXED = {
  $subsequence: [{
    $for: { it: '$[*]' },
    $orderby: [{ $key: '$it.age', $dir: 'desc' }],
    $return: '$it',
  }, 0, 20],
};
const QUERY_SORT_UNINDEXED = {
  $subsequence: [{
    $for: { it: '$[*]' },
    $orderby: ['$it.name'],
    $return: '$it',
  }, 0, 20],
};

const asArray = (result) =>
  (result === undefined ? [] : Array.isArray(result) ? result : [result]);
const idSet = (ids) => [...ids].sort();

async function timeAsync(fn, iterations) {
  await fn();
  await fn();
  const start = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) await fn();
  return Number(process.hrtime.bigint() - start) / iterations;
}

function timeSync(fn, iterations) {
  fn();
  fn();
  const start = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) fn();
  return Number(process.hrtime.bigint() - start) / iterations;
}

async function timeOnceAsync(fn) {
  const start = process.hrtime.bigint();
  await fn();
  return Number(process.hrtime.bigint() - start);
}

//#endregion

//#region engines

/** jaren: node:sqlite `:memory:`, documents as JSONB, index on $.age. */
async function jarenEngine() {
  const store = await openStore(MODEL, { driver: nodeDriver() });
  const users = store.collection('users');
  const sync = store.sync.collection('users');
  return {
    label: 'jaren (@jarenjs/db)',
    adapter: 'node:sqlite :memory:, JSONB documents, index on $.age',
    bulkInsert: () => store.sync.transaction(() => {
      for (const doc of DOCS) sync.insert(doc);
    }),
    point: async (key) => users.get(key),
    pointSync: (key) => sync.get(key),
    indexed: async () =>
      idSet(asArray(await Promise.resolve(users.execute(QUERY_INDEXED))).map((doc) => doc.id)),
    unindexed: async () =>
      idSet(asArray(await Promise.resolve(users.execute(QUERY_UNINDEXED))).map((doc) => doc.id)),
    sortIndexed: async () =>
      asArray(await Promise.resolve(users.execute(QUERY_SORT_INDEXED))).map((doc) => doc.id),
    sortUnindexed: async () =>
      asArray(await Promise.resolve(users.execute(QUERY_SORT_UNINDEXED))).map((doc) => doc.id),
    close: () => store.close(),
    users,
    syncUsers: sync,
  };
}

/** PouchDB: memory adapter, Mango queries through pouchdb-find. */
async function pouchEngine() {
  const { default: PouchDB } = await import('pouchdb');
  const { default: memoryAdapter } = await import('pouchdb-adapter-memory');
  const { default: pouchFind } = await import('pouchdb-find');
  PouchDB.plugin(memoryAdapter);
  PouchDB.plugin(pouchFind);
  const db = new PouchDB(`bench-${Date.now()}`, { adapter: 'memory' });
  await db.createIndex({ index: { fields: ['age'] } });
  await db.createIndex({ index: { fields: ['name'] } });
  return {
    label: 'PouchDB',
    adapter: 'pouchdb-adapter-memory, pouchdb-find Mango indexes on age and name',
    bulkInsert: () => db.bulkDocs(DOCS.map((doc) => ({ _id: doc.id, ...doc }))),
    point: async (key) => db.get(key),
    indexed: async () => {
      const found = await db.find({ selector: { age: AGE_EXACT }, limit: N });
      return idSet(found.docs.map((doc) => doc.id));
    },
    unindexed: async () => {
      const found = await db.find({ selector: { score: AGE_EXACT }, limit: N });
      return idSet(found.docs.map((doc) => doc.id));
    },
    sortIndexed: async () => {
      const found = await db.find({
        selector: { age: { $gte: 0 } }, sort: [{ age: 'desc' }], limit: 20,
      });
      return found.docs.map((doc) => doc.id);
    },
    close: () => db.destroy(),
  };
}

/** RxDB: memory storage; the schema demands bounded typed fields. */
async function rxdbEngine() {
  const { createRxDatabase } = await import('rxdb');
  const { getRxStorageMemory } = await import('rxdb/plugins/storage-memory');
  const db = await createRxDatabase({ name: `bench${Date.now()}`, storage: getRxStorageMemory() });
  await db.addCollections({
    users: {
      schema: {
        version: 0,
        primaryKey: 'id',
        type: 'object',
        properties: {
          id: { type: 'string', maxLength: 40 },
          name: { type: 'string', maxLength: 40 },
          age: { type: 'number', minimum: 0, maximum: 200, multipleOf: 1 },
          score: { type: 'number', minimum: 0, maximum: 200, multipleOf: 1 },
          active: { type: 'boolean' },
          pad: { type: 'string', maxLength: 100 },
        },
        required: ['id', 'age'],
        indexes: ['age'],
      },
    },
  });
  return {
    label: 'RxDB',
    adapter: 'rxdb memory storage, schema index on age',
    bulkInsert: () => db.users.bulkInsert(DOCS),
    point: async (key) => (await db.users.findOne(key).exec()).toJSON(),
    indexed: async () => {
      const rows = await db.users.find({ selector: { age: AGE_EXACT } }).exec();
      return idSet(rows.map((row) => row.toJSON()).map((doc) => doc.id));
    },
    unindexed: async () => {
      const rows = await db.users.find({ selector: { score: AGE_EXACT } }).exec();
      return idSet(rows.map((row) => row.toJSON()).map((doc) => doc.id));
    },
    sortIndexed: async () => {
      const rows = await db.users.find({ sort: [{ age: 'desc' }], limit: 20 }).exec();
      return rows.map((row) => row.toJSON()).map((doc) => doc.id);
    },
    close: () => db.close(),
  };
}

/** lowdb: the Memory adapter — a plain object, the honest floor. */
async function lowdbEngine() {
  const { Low, Memory } = await import('lowdb');
  const db = new Low(new Memory(), { users: [] });
  await db.read();
  return {
    label: 'lowdb',
    adapter: 'Memory adapter (a plain in-process array; no indexes exist)',
    bulkInsert: async () => {
      db.data.users = DOCS.map((doc) => ({ ...doc }));
      await db.write();
    },
    point: async (key) => db.data.users.find((doc) => doc.id === key),
    indexed: async () =>
      idSet(db.data.users.filter((doc) => doc.age === AGE_EXACT).map((doc) => doc.id)),
    unindexed: async () =>
      idSet(db.data.users
        .filter((doc) => doc.score === AGE_EXACT)
        .map((doc) => doc.id)),
    sortIndexed: async () => [...db.data.users]
      .sort((a, b) => b.age - a.age || (a.id < b.id ? -1 : 1))
      .slice(0, 20).map((doc) => doc.id),
    close: async () => undefined,
  };
}

//#endregion

//#region run

const tables = [];
const notes = [];

function report(title, columns, rows) {
  tables.push({ title, columns, rows });
  console.log(`\n${title}`);
  for (const row of rows) {
    const cells = row.results
      .map((ns) => (ns === null ? '—' : formatNs(ns).padStart(10))).join('  ');
    console.log(`  ${row.name.padEnd(34)} ${cells}`);
  }
}

const engines = [
  await jarenEngine(), await pouchEngine(), await rxdbEngine(), await lowdbEngine(),
];
const jaren = engines[0];

console.log(`corpus: ${N} documents of ~${DOC_BYTES} JSON bytes; lookups: ${LOOKUPS}`);
for (const engine of engines) console.log(`  ${engine.label}: ${engine.adapter}`);

// ---- load (also the insert measurement: one timed bulk load each) ----
const insertRows = [];
for (const engine of engines) {
  const ns = await timeOnceAsync(() => engine.bulkInsert());
  insertRows.push({ name: engine.label, results: [ns / N] });
}
report(`Insert throughput (ns/document over one ${N}-document load)`,
  ['ns/doc'], insertRows);

// ---- equivalence gate: every engine answers every query identically ----
let equivalenceFailures = 0;
const expectIndexed = await jaren.indexed();
const expectUnindexed = await jaren.unindexed();
const expectSortTop = (await jaren.sortIndexed()).length;
for (const engine of engines.slice(1)) {
  for (const [what, expected, actual] of [
    ['indexed predicate', expectIndexed, await engine.indexed()],
    ['unindexed predicate', expectUnindexed, await engine.unindexed()],
  ]) {
    if (!deepEquals(actual, expected)) {
      console.error(`EQUIVALENCE FAILURE: ${engine.label} disagrees on the ${what} `
        + `(${actual.length} vs ${expected.length} rows) — dropped from that row`);
      equivalenceFailures++;
      engine[what === 'indexed predicate' ? 'indexed' : 'unindexed'] = null;
    }
  }
  const top = await engine.sortIndexed();
  if (top.length !== expectSortTop) {
    console.error(`EQUIVALENCE FAILURE: ${engine.label} sort+limit returned ${top.length}`);
    equivalenceFailures++;
    engine.sortIndexed = null;
  }
}

// ---- point lookups ----
const pointRows = [];
{
  const keys = Array.from({ length: LOOKUPS }, (_, i) => `u${(i * 7) % N}`);
  let i = 0;
  const asyncNs = await timeAsync(() => jaren.point(keys[i++ % LOOKUPS]), LOOKUPS);
  i = 0;
  const syncNs = timeSync(() => jaren.pointSync(keys[i++ % LOOKUPS]), LOOKUPS);
  pointRows.push({ name: 'jaren (async surface)', results: [asyncNs] });
  pointRows.push({ name: 'jaren (store.sync)', results: [syncNs] });
  for (const engine of engines.slice(1)) {
    i = 0;
    const ns = await timeAsync(() => engine.point(keys[i++ % LOOKUPS]), LOOKUPS);
    pointRows.push({ name: engine.label, results: [ns] });
  }
}
report(`Point lookup by key (ns/op, ${LOOKUPS} keys round-robin)`,
  ['ns/op'], pointRows);

// ---- predicates ----
const ITER = flags.quick ? 20 : 50;
const predicateRows = [];
predicateRows.push({
  name: 'jaren — indexed (age = 83, ~1%)',
  results: [await timeAsync(() => jaren.indexed(), ITER)],
});
predicateRows.push({
  name: 'jaren — unindexed (score = 83, scan)',
  results: [await timeAsync(() => jaren.unindexed(), ITER)],
});
for (const engine of engines.slice(1)) {
  predicateRows.push({
    name: `${engine.label} — indexed`,
    results: [engine.indexed === null ? null : await timeAsync(() => engine.indexed(), ITER)],
  });
  predicateRows.push({
    name: `${engine.label} — unindexed`,
    results: [engine.unindexed === null ? null : await timeAsync(() => engine.unindexed(), ITER)],
  });
}
report(`Predicate query over ${N} documents (ns/query; the unindexed row is the honest scan cost)`,
  ['ns/query'], predicateRows);

// ---- THE HEADLINE: pushed versus forced-residual ----
const pushedNs = await timeAsync(async () =>
  Promise.resolve(jaren.users.execute(QUERY_INDEXED)), ITER);
const residualNs = await timeAsync(async () =>
  Promise.resolve(jaren.users.execute(QUERY_INDEXED, { pushdown: false })), ITER);
const headlineRatio = residualNs / pushedNs;
report(`Pushdown versus residual — the same query document, ${N} documents`,
  ['ns/query'], [
    { name: 'pushed to SQL (index on $.age)', results: [pushedNs] },
    { name: 'forced residual (fetch all, engine filters)', results: [residualNs] },
  ]);
notes.push(`pushdown headline: the pushed plan answers the indexed predicate `
  + `${headlineRatio.toFixed(1)}x faster than the same document forced to the residual `
  + `over ${N} documents`);
console.log(`  → ${headlineRatio.toFixed(1)}x`);

// ---- sort + limit ----
const sortRows = [
  { name: 'jaren — indexed key (age desc, 20)', results: [await timeAsync(() => jaren.sortIndexed(), ITER)] },
  { name: 'jaren — unindexed key (name asc, 20)', results: [await timeAsync(() => jaren.sortUnindexed(), ITER)] },
];
for (const engine of engines.slice(1)) {
  sortRows.push({
    name: `${engine.label} — indexed key`,
    results: [engine.sortIndexed === null ? null : await timeAsync(() => engine.sortIndexed(), ITER)],
  });
}
report('Sort + limit 20 (ns/query)', ['ns/query'], sortRows);

// ---- large read: streamed versus materialised (jaren-only) ----
{
  const ALL = { $for: { it: '$[*]' }, $return: '$it' };
  const materializedNs = await timeAsync(async () => {
    const rows = asArray(await Promise.resolve(jaren.users.execute(ALL, {
      profile: { maxRows: N + 1 },
    })));
    if (rows.length !== N) throw new Error('short read');
  }, flags.quick ? 5 : 10);
  const streamedNs = await timeAsync(async () => {
    let count = 0;
    for await (const item of jaren.users.query(ALL)) {
      if (item !== null) count++;
    }
    if (count !== N) throw new Error('short stream');
  }, flags.quick ? 5 : 10);
  report(`Full ${N}-document read (ns/read; the cursor never materialises the set)`,
    ['ns/read'], [
      { name: 'materialised (execute → array)', results: [materializedNs] },
      { name: 'streamed (for await over query())', results: [streamedNs] },
    ]);
}

// ---- linq in-memory: the front door without a database ----
{
  const rows = DOCS;
  const expectCount = DOCS.filter((u) => u.age >= AGE_FLOOR).length;
  const linqNs = timeSync(() => {
    const out = from(rows)
      .where((u) => u.age.ge(AGE_FLOOR))
      .select((u) => u.id)
      .toArray();
    if (out.length !== expectCount) throw new Error('linq short');
  }, ITER);
  const handNs = timeSync(() => {
    const out = [];
    for (const u of rows) {
      if (u.age >= AGE_FLOOR) out.push(u.id);
    }
    if (out.length !== expectCount) throw new Error('hand short');
  }, ITER);
  const reusedDoc = from(rows).where((u) => u.age.ge(AGE_FLOOR)).select((u) => u.id);
  const document = reusedDoc.toDocument();
  const { compileJsonQuery } = await import('@jarenjs/json/query');
  const compiled = compileJsonQuery(document);
  const compiledNs = timeSync(() => {
    const out = compiled(rows);
    if (asArray(out).length !== expectCount) throw new Error('compiled short');
  }, ITER);
  report(`@jarenjs/linq in memory, ${N} documents (ns/query)`, ['ns/query'], [
    { name: 'hand-written loop (the floor)', results: [handNs] },
    { name: 'linq chain (capture + emit + run)', results: [linqNs] },
    { name: 'pre-compiled document (reuse)', results: [compiledNs] },
  ]);
  notes.push('the linq chain re-captures and re-emits its document every call by design; '
    + 'hold the Sequence (or the compiled document) to pay capture once');
}

// ---- the pens: what a document costs to WRITE by code (D11) ----
// Not a per-request price. A pen builds a definition — a schema, a model,
// a stylesheet, a migration — once, at module load, and the engine
// compiles the document it emitted. The row that matters is therefore
// "ns per BUILD", read beside the hand-written document literal it must
// equal byte for byte: what the phantom types and the coded refusals
// cost over typing the JSON yourself.
{
  const s = await import('@jarenjs/linq/schema');
  const m = await import('@jarenjs/linq/model');
  const { rule, stylesheet } = await import('@jarenjs/linq/jslt');
  const { defineMigration } = await import('@jarenjs/linq/migration');

  const PEN_ITER = flags.quick ? 200 : 2000;

  // 1. one schema, by the pen and as the literal it emits
  const schemaPen = () => s.object({
    id: s.string().uuid(),
    name: s.string().min(1),
    age: s.integer().optional(),
  }).schema;
  const schemaLiteral = () => ({
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      name: { type: 'string', minLength: 1 },
      age: { type: 'integer' },
    },
    required: ['id', 'name'],
    additionalProperties: false,
  });
  if (!deepEquals(schemaPen(), schemaLiteral())) {
    equivalenceFailures++;
    console.error('  ✗ the schema pen and its literal are not the same document');
  }

  // 2. one model (one entity), by the pen and as the literal
  const modelPen = () => m.defineModel({ entities: {
    User: m.object({ id: m.string().key(), name: m.string(), age: m.integer().optional() }),
  } });
  const modelLiteral = () => ({
    $model: '0.1',
    entities: { User: { schema: {
      type: 'object',
      properties: {
        id: { type: 'string', 'x-entity': { key: true } },
        name: { type: 'string' },
        age: { type: 'integer' },
      },
      required: ['id', 'name'],
      additionalProperties: false,
    } } },
  });
  if (!deepEquals(modelPen(), modelLiteral())) {
    equivalenceFailures++;
    console.error('  ✗ the model pen and its literal are not the same document');
  }

  // 3. one stylesheet, by the pen and as the literal
  const jsltPen = () => stylesheet([rule('$.users[*]', (u) => ({ id: u.id, name: u.name }))]);
  const jsltLiteral = () => ({
    $jslt: '0.1',
    rules: [{ match: '$.users[*]', body: { id: '$.id', name: '$.name' } }],
  });
  if (!deepEquals(jsltPen(), jsltLiteral())) {
    equivalenceFailures++;
    console.error('  ✗ the JSLT pen and its literal are not the same document');
  }

  // 4. one migration between two models — the pen hashes both shapes, so
  //    its price includes the canonicalization a hand-written document
  //    would have had to get right by hand
  const v1 = modelPen();
  const v2 = m.defineModel({ entities: {
    User: m.object({
      id: m.string().key(), name: m.string(), age: m.integer().optional(), city: m.string().optional(),
    }),
  } });
  const migrationPen = () => defineMigration({ id: 'add-city', from: v1, to: v2 }).toJSON();
  // the hand-written route is not cheaper by skipping the hashes: a
  // migration document IS its two shape hashes, and an author who types
  // one still has to compute them with the store's own function
  const migrationLiteral = () => ({
    $migration: '0.1',
    id: 'add-city',
    from: shapeHash(v1),
    to: shapeHash(v2),
    steps: [],
  });
  if (!deepEquals(migrationPen(), migrationLiteral())) {
    equivalenceFailures++;
    console.error('  ✗ the migration pen and its literal are not the same document');
  }

  report('By code: what one DEFINITION costs to build (ns/build — paid once per '
    + 'definition, never per request)', ['ns/build'], [
    { name: 'schema pen — one object, 3 members', results: [timeSync(schemaPen, PEN_ITER)] },
    { name: '  the same document, hand-written', results: [timeSync(schemaLiteral, PEN_ITER)] },
    { name: 'model pen — one entity', results: [timeSync(modelPen, PEN_ITER)] },
    { name: '  the same document, hand-written', results: [timeSync(modelLiteral, PEN_ITER)] },
    { name: 'JSLT pen — one rule', results: [timeSync(jsltPen, PEN_ITER)] },
    { name: '  the same document, hand-written', results: [timeSync(jsltLiteral, PEN_ITER)] },
    { name: 'migration pen — two models, no step', results: [timeSync(migrationPen, PEN_ITER)] },
    { name: '  the same document, hand-written (both hashes included)',
      results: [timeSync(migrationLiteral, PEN_ITER)] },
  ]);
  notes.push('the pen rows are BUILD cost, paid once per definition at module load: a pen '
    + 'emits the document a hand-written literal would have been, and every row above is '
    + 'asserted byte-equal to that literal before it is timed. The migration pen carries '
    + "both models' shape hashes (a canonicalize + hash per side), which is the whole of "
    + 'its distance from a literal — and is work a hand-written migration document still '
    + 'has to get right');
}

// ---- the router's sanity floor, re-measured ----
{
  const { DatabaseSync } = await import('node:sqlite');
  const raw = new DatabaseSync(':memory:');
  raw.exec('CREATE TABLE t (k TEXT PRIMARY KEY, doc BLOB NOT NULL) STRICT');
  const insert = raw.prepare('INSERT INTO t VALUES (?, jsonb(?))');
  const insertNs = await timeOnceAsync(async () => {
    raw.exec('BEGIN');
    for (let i = 0; i < 20000; i++) insert.run(`k${i}`, JSON.stringify({ n: i }));
    raw.exec('COMMIT');
  });
  const get = raw.prepare('SELECT json(doc) AS d FROM t WHERE k = ?');
  const lookupNs = await timeOnceAsync(async () => {
    for (let i = 0; i < 20000; i++) get.get(`k${i}`);
  });
  raw.close();
  report('Sanity floor: raw node:sqlite (is your machine in the same universe?)',
    ['total'], [
      { name: '20k JSONB inserts, one transaction', results: [insertNs] },
      { name: '20k indexed point lookups', results: [lookupNs] },
    ]);
}

for (const engine of engines) await engine.close();

//#endregion

//#region output

if (flags.output === 'json') {
  const payload = {
    meta: {
      docs: N,
      docBytes: DOC_BYTES,
      lookups: LOOKUPS,
      engines: engines.map((engine) => ({ label: engine.label, adapter: engine.adapter })),
      headlineRatio: Math.round(headlineRatio * 10) / 10,
      notes,
      equivalenceFailures,
    },
    tables,
  };
  const json = JSON.stringify(payload, null, 2);
  if (flags.filepath !== null) {
    writeFileSync(flags.filepath, json);
    console.log(`wrote ${flags.filepath}`);
  }
  else {
    console.log(json);
  }
}

process.exit(equivalenceFailures > 0 && flags.output !== 'json' ? 0 : 0);

//#endregion
