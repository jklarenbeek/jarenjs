#!/usr/bin/env node
//@ts-check
/**
 * JarenJS Vector Benchmark — k-nearest over a `derive: 'vector'` column,
 * every physical path it can take, against the extension that exists to
 * do this.
 *
 * Seeded unit vectors are loaded through the REAL store write path (no
 * hand-packed blobs), at two corpus sizes and two widths, and the same
 * ten probes are answered six ways:
 *
 *   1  engine resident sweep   the kernels over a contiguous Float32
 *                              matrix in RAM — no database at all
 *   2  the k-nearest plan      `collection.execute` end to end: the
 *                              column cuts, the engine decides, the
 *                              winners' documents are fetched
 *   3  raw fetch + sweep       the plan's own statement, run by hand,
 *                              ranked in the engine — the plan's cost,
 *                              isolated
 *   4  ORDER BY over a UDF     a benchmark-local deterministic function
 *                              inside the scan, with the probe hoisted
 *                              out of the per-row call (its fastest
 *                              route); the shape the store deliberately
 *                              does NOT emit, re-measured against the
 *                              real column rather than assumed
 *   5  JSON-doc sweep          the same query document over a twin
 *                              collection with no vector column: the
 *                              row the column exists to beat
 *   6  sqlite-vec              the rival — a `vec0` virtual table over
 *                              the same bytes, same k, same probes
 *
 * Correctness before timing, and refusal on disagreement. The stored
 * column is compared BYTE for byte against what the kernels pack, then
 * paths 1-5 must answer the identical top-k — ids and order — for every
 * probe of every leg, before a single number prints. The rival is
 * compared the same way and every disagreement is counted into a named
 * class with a pinned size: a rival that answers differently is a
 * finding, not a reason to drop the row.
 *
 * Both halves of the price are published. The read is the table above;
 * the write is the load row — the same documents inserted in one
 * transaction with and without the `derive: 'vector'` index, because the
 * column costs a JSON round trip of the member plus a normalize and a
 * pack on every write. So is the storage: bytes per vector packed
 * against the same vector as JSON inside the document, and the database
 * size with the column and without it.
 *
 * Two rows will lose and both stay in. The resident sweep beats every
 * path that touches SQLite — it starts from decoded floats in RAM and
 * pays nothing for durability, where the store starts from bytes on a
 * page — and the rival is a purpose-built extension. What the store
 * buys for the difference is durability, filters that compose with the
 * ranking, and one storage story on stock SQLite with no extension to
 * load.
 *
 * Raw SQL appears here for the same reason it does in the spatial
 * suite: paths 3 and 4 measure a PHYSICAL question the store's plan
 * sits on. Path 3's statement is the plan's own, read out of
 * `explain()` rather than typed, so it cannot drift from what the store
 * runs.
 *
 * Usage:
 *   node benchmark/vector.js                      # the full grid
 *   node benchmark/vector.js --quick              # one small leg
 *   node benchmark/vector.js --sizes 10000 --dims 768
 *   node benchmark/vector.js --check-only         # equivalence only
 *   node benchmark/vector.js --output json --filepath results.json
 */

import { writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { openStore, sqliteDialect, probeVector, columnScore } from '@jarenjs/db';
import { adaptNodeDatabase } from '@jarenjs/db/node';
import { packVector, unpackVector, l2Normalize, dotProduct } from '@jarenjs/core/vector';

import { formatNs } from './lib/fmt.js';
import { quantile } from './lib/horizon.js';

//#region flags

const argv = process.argv.slice(2);
const list = (name, fallback) => (argv.includes(name)
  ? argv[argv.indexOf(name) + 1].split(',').map((s) => parseInt(s.trim(), 10))
  : fallback);
const one = (name, fallback) =>
  (argv.includes(name) ? parseInt(argv[argv.indexOf(name) + 1], 10) : fallback);

const flags = {
  quick: argv.includes('--quick'),
  checkOnly: argv.includes('--check-only'),
  sizes: list('--sizes', null),
  dims: list('--dims', null),
  k: one('--k', 10),
  queries: one('--queries', 10),
  warmup: one('--warmup', 3),
  seed: one('--seed', 20260825),
  output: argv.includes('--output') ? argv[argv.indexOf('--output') + 1] : null,
  filepath: argv.includes('--filepath') ? argv[argv.indexOf('--filepath') + 1] : null,
};
if (argv.includes('--help') || argv.includes('-h')) {
  console.log('Usage: node benchmark/vector.js [--quick] [--sizes a,b] [--dims a,b] [--k N]');
  console.log('  [--queries N] [--warmup N] [--seed N] [--check-only] [--output json --filepath PATH]');
  process.exit(0);
}

/** The §2.2 grid this suite reproduces against the real store. */
const SIZES = flags.sizes ?? (flags.quick ? [2000] : [10_000, 50_000]);
const DIMS = flags.dims ?? (flags.quick ? [384] : [384, 768]);
const K = flags.k;
const PROBES = flags.quick ? Math.min(flags.queries, 5) : flags.queries;
const WARMUP = flags.quick ? Math.min(flags.warmup, 2) : flags.warmup;

/**
 * The largest corpus the JSON-doc row runs at. Above it the twin
 * collection is loaded, measured for what it costs to write and to
 * store, and closed: sweeping ten thousand parsed vectors per query is
 * already the row's whole point, and doing it fifty thousand at a time
 * buys minutes of runtime for a number the shape of the one below it.
 */
const JSON_DOC_MAX = 10_000;

//#endregion

//#region corpus

/** A deterministic PRNG, so every host measures the same corpus. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    kind: { type: 'string' },
    text: { type: 'string' },
    embedding: { type: 'array', items: { type: 'number' } },
  },
};
const model = (indexes) => ({
  $model: '0.1',
  collections: { docs: { schema: SCHEMA, key: null, identity: 'integer', indexes } },
});
const vectorIndex = (dims) => [{ name: 'by_vec', path: '$.embedding', derive: 'vector', dims }];

/** The published recipe (QUERY-FORMAT §8.15), at one k. */
const knnDocument = (k) => ({
  $subsequence: [{
    $for: { r: '$[*]' },
    $orderby: [{ $key: { $similarity: ['$r.embedding', '$q'] }, $dir: 'desc', $empty: 'least' },
      '$r.id'],
    $return: '$r',
  }, 0, k],
});

/**
 * One leg's corpus: a seed the documents replay from, the probes, and
 * the matrix the column will hold.
 *
 * Nothing keeps the documents. Fifty thousand 768-component members
 * held as JavaScript arrays is a third of a gigabyte the measurement
 * has no use for, so they are regenerated from the seed on each pass —
 * deterministic, and the same documents every time — while the one
 * thing every path needs, the matrix, is kept as a single contiguous
 * `Float32Array`.
 *
 * A member is a unit vector in binary32 — the form an embedding arrives
 * in — written into the document as plain numbers. The matrix row is
 * what the store's write path makes of that member (`l2Normalize` then
 * `packVector`), unpacked: so the resident sweep and the fetched column
 * rank by the SAME numbers, and any difference against the engine's
 * cosine over the raw member is the binary32 gap the plan's margin
 * exists to absorb.
 */
function buildCorpus(n, d, seed) {
  const rand = mulberry32(seed ^ 0x5bf03635);
  const raw = new Float32Array(d);
  const queries = [];
  for (let q = 0; q < PROBES; q++) {
    for (let j = 0; j < d; j++) raw[j] = rand() * 2 - 1;
    queries.push(Array.from(/** @type {Float32Array} */ (l2Normalize(raw))));
  }
  return { n, d, seed, matrix: new Float32Array(n * d), queries };
}

/** Replay the corpus, one document at a time, in insertion order. */
function eachDocument(corpus, fn) {
  const rand = mulberry32(corpus.seed);
  const raw = new Float32Array(corpus.d);
  for (let i = 0; i < corpus.n; i++) {
    for (let j = 0; j < corpus.d; j++) raw[j] = rand() * 2 - 1;
    fn(i, { id: `m${i}`, kind: `k${i % 20}`, text: `document ${i}`,
      embedding: Array.from(/** @type {Float32Array} */ (l2Normalize(raw))) });
  }
}

//#endregion

//#region top-k

/**
 * The k best of `n` scored rows, highest first, ties by id ascending —
 * the ordering `$orderby` on a `$similarity` key with `$r.id` as its
 * second term produces. An insertion-sorted window of k, because k is
 * ten and n is fifty thousand.
 * @param {(i: number) => number} score
 * @param {number} n
 * @param {number} k
 * @returns {number[]} row indices
 */
function topK(score, n, k) {
  /** @type {{ i: number, s: number }[]} */
  const best = [];
  for (let i = 0; i < n; i++) {
    const s = score(i);
    if (best.length === k && s <= best[k - 1].s) continue;
    let at = best.length;
    while (at > 0 && (best[at - 1].s < s
      || (best[at - 1].s === s && `m${best[at - 1].i}` > `m${i}`))) at--;
    best.splice(at, 0, { i, s });
    if (best.length > k) best.pop();
  }
  return best.map((entry) => entry.i);
}

/** The resident sweep: the kernels over the contiguous matrix. */
function residentTopK(corpus, probe, k) {
  const { matrix, d, n } = corpus;
  return topK((i) => {
    const row = matrix.subarray(i * d, i * d + d);
    let sum = 0;
    for (let j = 0; j < d; j++) sum += row[j] * probe[j];
    return sum;
  }, n, k);
}

const idsOf = (indices) => indices.map((i) => `m${i}`);
const asArray = (result) =>
  (result === undefined ? [] : Array.isArray(result) ? result : [result]);

//#endregion

//#region measurement

/**
 * One path's cost: every probe answered once after `WARMUP` unmeasured
 * passes, reported as the median. A mean over ten queries of a
 * hundred-millisecond sweep hides which probe was slow; the median is
 * what the baseline this reproduces published.
 * @param {(query: any) => Promise<any> | any} run
 * @param {any[]} queries
 */
async function medianMs(run, queries) {
  for (let w = 0; w < WARMUP; w++) await run(queries[w % queries.length]);
  const samples = [];
  for (const query of queries) {
    const start = process.hrtime.bigint();
    await run(query);
    samples.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  return quantile(samples, 0.5);
}

/** The database's own size, in bytes — pages times page size. */
function databaseBytes(db) {
  const pages = Number(/** @type {any} */ (db.prepare('PRAGMA page_count').get()).page_count);
  const size = Number(/** @type {any} */ (db.prepare('PRAGMA page_size').get()).page_size);
  return pages * size;
}

/**
 * The bytes one column of one table actually holds, summed. The page
 * count above is what the database COSTS; this is what it carries, and
 * the two answer different questions — a column whose bytes fit in the
 * slack SQLite already leaves on a page costs nothing until they do not.
 */
function payloadBytes(db, table, column) {
  const row = /** @type {any} */ (
    db.prepare(`SELECT sum(length("${column}")) AS bytes FROM "${table}"`).get());
  return Number(row.bytes ?? 0);
}

//#endregion

//#region checks

const checks = [];
let failures = 0;
/** Record an equivalence check; a failure withholds every timing. */
function check(name, agrees, detail) {
  checks.push({ name, agrees, detail });
  if (!agrees) {
    failures++;
    console.error(`EQUIVALENCE FAILURE: ${name} — ${detail}`);
  }
}

/**
 * How the rival's answers relate to this suite's, counted into classes
 * with pinned sizes. Pinning the sizes rather than asserting agreement
 * means a change in either engine's answer fails the run instead of
 * being absorbed by a looser rule — and a class that is SUPPOSED to be
 * empty says so with a zero.
 */
const RIVAL_CLASSES = {
  same: {
    expected: null, entries: [],
    name: 'sqlite-vec agrees (same ids, same order)',
    note: '',
  },
  order: {
    expected: 0, entries: [],
    name: 'sqlite-vec returns the same ids in a different order',
    note: 'a tie-order difference: two rows within the extension\'s arithmetic of each other, '
      + 'ordered by whatever its scan reached first',
  },
  members: {
    expected: 0, entries: [],
    name: 'sqlite-vec returns a different set of ids',
    note: 'a metric-definition or precision difference — the two engines would be answering '
      + 'different questions, which is a finding and not a tolerance',
  },
};

//#endregion

//#region the rival

/**
 * The rival, or the reason there is none. `node:sqlite` must be opened
 * with `allowExtension` and the extension must load on THIS host; a
 * failure is recorded verbatim and every other row still lands.
 * @returns {Promise<{ ok: true, load: (db: any) => void, version: string }
 *   | { ok: false, reason: string }>}
 */
async function loadRival() {
  try {
    const sqliteVec = await import('sqlite-vec');
    const db = new DatabaseSync(':memory:', { allowExtension: true });
    sqliteVec.load(db);
    const version = String(/** @type {any} */ (db.prepare('SELECT vec_version() AS v').get()).v);
    db.close();
    return { ok: true, load: (target) => sqliteVec.load(target), version };
  }
  catch (error) {
    return { ok: false, reason: `${/** @type {any} */ (error)?.message ?? error}` };
  }
}

/**
 * The rival's table: one `vec0` virtual table over exactly the bytes
 * the store's column holds, in its own database.
 *
 * Two things are stated rather than hidden. The vectors are unit
 * length, so the extension's default L2 distance orders them exactly as
 * cosine does (`|a-b|² = 2 - 2·cos`) — its fastest documented route for
 * this data, which is the route it is measured through. And this table
 * holds vectors and nothing else, where the store's column shares its
 * pages with the documents; the fetch rows below carry that difference
 * as a number instead of a caveat.
 */
function buildRival(rival, corpus) {
  const db = new DatabaseSync(':memory:', { allowExtension: true });
  rival.load(db);
  db.exec(`CREATE VIRTUAL TABLE vec_docs USING vec0(embedding float[${corpus.d}])`);
  const insert = db.prepare('INSERT INTO vec_docs(rowid, embedding) VALUES (?, ?)');
  const start = process.hrtime.bigint();
  db.exec('BEGIN');
  for (let i = 0; i < corpus.n; i++) {
    insert.run(BigInt(i), /** @type {Uint8Array} */ (packVector(corpus.matrix.subarray(i * corpus.d, (i + 1) * corpus.d))));
  }
  db.exec('COMMIT');
  const loadNs = Number(process.hrtime.bigint() - start);
  const probeStatement = db.prepare(
    'SELECT rowid AS rid FROM vec_docs WHERE embedding MATCH ? AND k = ? ORDER BY distance');
  return {
    loadNs,
    bytes: databaseBytes(db),
    run: (probe) => probeStatement.all(
      /** @type {Uint8Array} */ (packVector(probe)), BigInt(K)).map((row) => Number(row.rid)),
    close: () => db.close(),
  };
}

//#endregion

//#region one leg

/**
 * A store over a database this suite owns, so the raw statements of
 * paths 3 and 4 and the store's own plan run against ONE table in ONE
 * database — the only way "what the plan itself costs" is a difference
 * rather than a comparison of two databases.
 */
async function openOwned(indexes) {
  const db = new DatabaseSync(':memory:');
  const driver = { name: 'node-sqlite', dialect: sqliteDialect, open: () => adaptNodeDatabase(db) };
  const store = await openStore(model(indexes), { driver });
  return { db, store, docs: store.collection('docs') };
}

/** How many documents are generated between two timed insert batches. */
const LOAD_CHUNK = 500;

/**
 * Load a corpus through the real write path, in one transaction,
 * timing the INSERTS and not the corpus that feeds them: the documents
 * are replayed a chunk at a time with the clock stopped, so the row
 * measures the store and the row without the column measures the same
 * store minus one derived value. `onDocument` sees every document
 * outside the timer.
 */
function loadStore(store, corpus, onDocument) {
  const sync = store.sync.collection('docs');
  let ns = 0n;
  store.sync.transaction(() => {
    let chunk = [];
    const flush = () => {
      const start = process.hrtime.bigint();
      for (const doc of chunk) sync.insert(doc);
      ns += process.hrtime.bigint() - start;
      chunk = [];
    };
    eachDocument(corpus, (i, doc) => {
      if (onDocument !== undefined) onDocument(i, doc);
      chunk.push(doc);
      if (chunk.length === LOAD_CHUNK) flush();
    });
    if (chunk.length > 0) flush();
  });
  return Number(ns);
}

/**
 * Everything one (n × d) leg measures. Built and torn down in place:
 * a fifty-thousand-document corpus at 768 dimensions is a gigabyte of
 * database, and two of them at once is a swap file.
 */
async function runLeg(n, d, rival) {
  const label = `${n.toLocaleString('en-US')} × ${d}`;
  console.log(`\n— ${label} —`);
  const corpus = buildCorpus(n, d, flags.seed + n + d);
  const document = knnDocument(K);
  /** @type {Record<string, any>} */
  const leg = { n, d, label, rows: {}, storage: {} };

  // -- the twin without the column: what the write and the bytes cost
  // without it, and (at the smaller sizes) the row the column beats
  const plain = await openOwned([]);
  leg.rows.loadPlain = loadStore(plain.store, corpus, (i, doc) => {
    if (i === 0) leg.storage.jsonBytes = JSON.stringify(doc.embedding).length;
    corpus.matrix.set(
      /** @type {Float32Array} */ (unpackVector(
        /** @type {Uint8Array} */ (packVector(l2Normalize(doc.embedding))), d)), i * d);
  });
  leg.storage.plainBytes = databaseBytes(plain.db);
  leg.storage.docPayload = payloadBytes(plain.db, 'docs', 'doc');
  const jsonDocRow = n <= JSON_DOC_MAX;
  if (!jsonDocRow) await plain.store.close();

  // -- the store the campaign built
  const indexed = await openOwned(vectorIndex(d));
  leg.rows.loadIndexed = loadStore(indexed.store, corpus);
  leg.storage.indexedBytes = databaseBytes(indexed.db);

  // the plan's own statement and column, read out of explain() rather
  // than typed — a hand-written copy would drift from what runs
  const explained = await indexed.docs.explain(document, { externals: { q: corpus.queries[0] } });
  if (explained.mode !== 'knn') {
    check(`${label} plan mode`, false, `explain() says '${explained.mode}', not 'knn'`);
    await indexed.store.close();
    if (jsonDocRow) await plain.store.close();
    return leg;
  }
  leg.column = explained.rank.column;
  leg.fetchSql = explained.sql;
  leg.storage.columnPayload = payloadBytes(indexed.db, 'docs', explained.rank.column);

  // -- the column is what the kernels pack, byte for byte, in row order,
  // which is also what makes a fetched identity nameable as a document
  const identityOf = new Map();
  {
    const fetched = indexed.db.prepare(explained.sql).all();
    let mismatch = -1;
    let ascending = true;
    for (let i = 0; i < fetched.length; i++) {
      if (i > 0 && Number(fetched[i].rid) <= Number(fetched[i - 1].rid)) ascending = false;
      identityOf.set(Number(fetched[i].rid), i);
      const want = /** @type {Uint8Array} */ (packVector(corpus.matrix.subarray(i * d, (i + 1) * d)));
      const got = /** @type {Uint8Array} */ (fetched[i].vec);
      if (mismatch < 0
        && (got.byteLength !== want.byteLength || !want.every((b, at) => b === got[at]))) mismatch = i;
    }
    check(`${label} stored column`, fetched.length === n && ascending && mismatch < 0,
      mismatch >= 0 ? `row ${mismatch}'s column is not what packVector produces`
        : fetched.length !== n ? `${fetched.length} rows fetched, not ${n}`
          : !ascending ? 'the fetch is not in row-identity order'
            : `${n} rows, ${4 * d} bytes each, identical to the kernels' packing`);
  }

  // -- path 4's function: benchmark-local, on this connection only. The
  // shipped store registers nothing for a vector column (a stored
  // column needs no function to be read), which is exactly why this row
  // has to be measured here to be measured at all.
  // the probe is hoisted: SQLite's determinism contract is per
  // STATEMENT, and the probe is constant for one, so the row measures
  // the per-row host call and the dot product rather than unpacking the
  // same query vector fifty thousand times — the shape's fastest route,
  // which is the one every engine here is driven through
  let udfProbe = /** @type {Float32Array} */ (probeVector(corpus.queries[0], d));
  indexed.db.function('jv_dot', { deterministic: true },
    (bytes) => dotProduct(/** @type {any} */ (unpackVector(/** @type {any} */ (bytes), d)), udfProbe));
  const udfSql = `SELECT "rowid" AS "rid" FROM "docs" `
    + `ORDER BY jv_dot("${leg.column}") DESC LIMIT ${K}`;
  const udfStatement = indexed.db.prepare(udfSql);
  leg.udfSql = udfSql;
  const fetchStatement = indexed.db.prepare(explained.sql);

  // -- the six answers
  const paths = [
    { key: 'resident', name: 'engine resident sweep (a Float32 matrix in RAM, no database)',
      run: (query) => idsOf(residentTopK(corpus, /** @type {any} */ (probeVector(query, d)), K)) },
    { key: 'plan', name: 'the k-nearest plan — column cut, engine rank, winners fetched',
      run: async (query) =>
        asArray(await indexed.docs.execute(document, { externals: { q: query } })).map((row) => row.id) },
    { key: 'fetch', name: 'raw fetch + engine sweep — the plan\'s statement, by hand',
      run: (query) => {
        const probe = /** @type {any} */ (probeVector(query, d));
        const rows = fetchStatement.all();
        const scored = rows.map((row) => columnScore(row.vec, d, probe) ?? -Infinity);
        return idsOf(topK((i) => scored[i], rows.length, K)
          .map((i) => identityOf.get(Number(rows[i].rid))));
      } },
    { key: 'udf', name: 'ORDER BY over a registered function — the shape the store does not emit',
      run: (query) => {
        udfProbe = /** @type {Float32Array} */ (probeVector(query, d));
        return udfStatement.all().map((row) => `m${identityOf.get(Number(row.rid))}`);
      } },
  ];
  if (jsonDocRow) {
    paths.push({ key: 'jsonDoc', name: 'JSON-doc sweep — the same query with no vector column',
      run: async (query) =>
        asArray(await plain.docs.execute(document, { externals: { q: query } })).map((row) => row.id) });
    const set = await plain.docs.explain(document, { externals: { q: corpus.queries[0] } });
    check(`${label} twin plan mode`, set.mode === 'set',
      `the column-less twin plans as '${set.mode}' (the honest whole-collection residual)`);
  }

  // -- equivalence, before any timing
  const answers = {};
  for (const path of paths) {
    const got = [];
    for (const query of corpus.queries) got.push(await path.run(query));
    answers[path.key] = got;
  }
  const reference = answers.resident;
  for (const path of paths.slice(1)) {
    let bad = -1;
    for (let q = 0; q < reference.length; q++) {
      if (JSON.stringify(answers[path.key][q]) !== JSON.stringify(reference[q])) { bad = q; break; }
    }
    check(`${label} ${path.key} vs resident sweep`, bad < 0,
      bad < 0 ? `${reference.length} probes, identical top-${K}`
        : `probe ${bad}: ${JSON.stringify(answers[path.key][bad])} against ${JSON.stringify(reference[bad])}`);
  }

  // -- the rival, classed
  /** @type {any} */
  let rivalTable = null;
  if (rival.ok) {
    rivalTable = buildRival(rival, corpus);
    for (let q = 0; q < corpus.queries.length; q++) {
      const theirs = idsOf(rivalTable.run(/** @type {any} */ (probeVector(corpus.queries[q], d))));
      const ours = reference[q];
      const bucket = JSON.stringify(theirs) === JSON.stringify(ours) ? 'same'
        : JSON.stringify([...theirs].sort()) === JSON.stringify([...ours].sort()) ? 'order' : 'members';
      RIVAL_CLASSES[bucket].entries.push(`${label} probe ${q}`
        + (bucket === 'same' ? '' : `: ${JSON.stringify(theirs)} against ${JSON.stringify(ours)}`));
    }
    leg.rows.loadRival = rivalTable.loadNs;
    leg.storage.rivalBytes = rivalTable.bytes;
  }

  // -- timings
  if (!flags.checkOnly && failures === 0) {
    for (const path of paths)
      leg.rows[path.key] = (await medianMs(path.run, corpus.queries)) * 1e6;
    if (rivalTable !== null) {
      leg.rows.rival = (await medianMs(
        (query) => rivalTable.run(/** @type {any} */ (probeVector(query, d))), corpus.queries)) * 1e6;
    }
    leg.stats = indexed.docs.stats().knn;
  }
  leg.names = Object.fromEntries(paths.map((path) => [path.key, path.name]));

  if (rivalTable !== null) rivalTable.close();
  await indexed.store.close();
  if (jsonDocRow) await plain.store.close();

  leg.storage.packedBytes = 4 * d;
  return leg;
}

//#endregion
//#region run

const rival = await loadRival();
console.log('\nVector benchmark — k-nearest over a derive: \'vector\' column');
console.log(`Node ${process.version}; k = ${K}, ${PROBES} probes, median after ${WARMUP} warm-ups`);
console.log(rival.ok
  ? `rival: sqlite-vec ${rival.version} loaded into node:sqlite with allowExtension`
  : `rival: sqlite-vec UNAVAILABLE on this host — ${rival.reason}`);

const legs = [];
for (const n of SIZES) {
  for (const d of DIMS) legs.push(await runLeg(n, d, rival));
}

// the rival's answers, as classes with pinned sizes — counted last so
// that a class is a check like any other and withholds the table too
if (rival.ok) {
  for (const cls of Object.values(RIVAL_CLASSES)) {
    check(cls.name, cls.expected === null || cls.entries.length === cls.expected,
      `${cls.entries.length} probe(s)`
      + (cls.expected === null ? '' : ` against a pinned ${cls.expected}`)
      + (cls.note === '' ? '' : ` — ${cls.note}`));
  }
}

console.log('\nResult equivalence (asserted before any timing)\n');
const width = Math.max(...checks.map((c) => c.name.length)) + 2;
for (const c of checks)
  console.log(`  ${c.agrees ? 'ok  ' : 'DIFF'}  ${c.name.padEnd(width)}${c.detail}`);
for (const key of ['order', 'members']) {
  if (RIVAL_CLASSES[key].entries.length === 0) continue;
  console.log(`\n  ${RIVAL_CLASSES[key].name} — ${RIVAL_CLASSES[key].entries.length} probe(s)`);
  for (const entry of RIVAL_CLASSES[key].entries) console.log(`    ${entry}`);
}

if (failures > 0) {
  console.error(`\n${failures} equivalence failure(s): the timing table is withheld.`);
  process.exit(1);
}
console.log('\nevery path answers the identical top-k on every probe.');
if (flags.checkOnly) process.exit(0);

//#endregion

//#region the tables

/** The leg every headline figure is quoted at, and the last one the
 * JSON-doc row ran at — both named, because a number without its
 * coordinates is whichever row sorted last. */
const largest = legs[legs.length - 1];
const jsonLeg = [...legs].reverse().find((leg) => leg.rows.jsonDoc !== undefined) ?? null;

const ms = (ns) => (ns === undefined ? '—' : formatNs(ns));
const count = (n) => (n === undefined ? '—' : n.toLocaleString('en-US'));
const times = (a, b) => (a === undefined || b === undefined ? '—' : `${(a / b).toFixed(2)}×`);
const ORDER = [
  ['resident', 'engine resident sweep (no database)'],
  ['plan', 'the k-nearest plan (column cut + engine rank + fetch)'],
  ['fetch', 'raw fetch + engine sweep (the plan\'s statement)'],
  ['udf', 'ORDER BY over a registered function'],
  ['jsonDoc', 'JSON-doc sweep (no vector column)'],
  ['rival', `sqlite-vec${rival.ok ? ` ${rival.version}` : ''}`],
];

const queryTable = {
  title: `One k-nearest query, k = ${K} — median of ${PROBES} probes`,
  head: ['path', ...legs.map((leg) => leg.label)],
  rows: ORDER.map(([key, name]) => ({
    cells: [name, ...legs.map((leg) => ms(leg.rows[key]))],
    strong: key === 'plan',
  })),
  note: 'Lower is better. Every path answered the identical top-k on every probe before it was'
    + ' timed. The resident sweep starts from decoded floats in RAM and pays nothing for'
    + ' durability, where every SQLite path starts from bytes on a page — it is the row the'
    + ' database has to be worth, not a row it can win. The JSON-doc row is what a collection'
    + ` without the column still runs, measured up to ${JSON_DOC_MAX.toLocaleString('en-US')} documents.`
    + (rival.ok
      ? ' sqlite-vec holds the same bytes in a vec0 table that carries no documents, so its probe'
        + ' reads far fewer pages than a fetch over the collection — the storage table below is'
        + ' how much less it stores.'
      : ` sqlite-vec did not load on the measuring host: ${rival.reason}`),
};

const writeTable = {
  title: 'The write half of the price — one transaction through the store\'s own write path',
  head: ['leg', 'no column', 'with the column', 'write cost', 'sqlite-vec insert'],
  rows: legs.map((leg) => ({
    cells: [leg.label, ms(leg.rows.loadPlain), ms(leg.rows.loadIndexed),
      times(leg.rows.loadIndexed, leg.rows.loadPlain), ms(leg.rows.loadRival)],
    strong: false,
  })),
  note: 'The column costs a JSON round trip of the member plus an l2-normalize and a pack on'
    + ' every write. A suite that published only queries would leave this out, and a consumer'
    + ' choosing the column has to see it beside what the query saves. The rival column inserts'
    + ' the same packed bytes into its own table and stores no document at all.',
};

const storageTable = {
  title: 'The storage half — what the column carries, and what it costs',
  head: ['leg', 'documents (JSONB)', 'the column', 'database without', 'database with',
    'sqlite-vec database'],
  rows: legs.map((leg) => ({
    cells: [leg.label, count(leg.storage.docPayload), count(leg.storage.columnPayload),
      count(leg.storage.plainBytes), count(leg.storage.indexedBytes), count(leg.storage.rivalBytes)],
    strong: false,
  })),
  note: 'The first two columns are payload — the bytes those columns hold, summed. The next two are'
    + ' what the database costs: pages allocated, read from the connection. They answer different'
    + ' questions, and they can disagree: a column whose bytes fit in slack SQLite was already'
    + ` leaving on the page costs nothing until they do not. One ${largest.d}-dimension vector is`
    + ` ${count(largest.storage.packedBytes)} bytes packed against ${count(largest.storage.jsonBytes)}`
    + ' as a JSON number array inside the document it is derived from — the document carries the'
    + ' vector either way, which is why the column adds bytes rather than replacing them. The'
    + ' rival\'s database holds the vectors and nothing else.',
};

const tables = [queryTable, writeTable, storageTable];
for (const table of tables) {
  console.log(`\n${table.title}`);
  const w = Math.max(...table.rows.map((r) => String(r.cells[0]).length), table.head[0].length) + 2;
  console.log(`  ${String(table.head[0]).padEnd(w)}${table.head.slice(1).map((h) => String(h).padStart(18)).join('')}`);
  for (const row of table.rows)
    console.log(`  ${String(row.cells[0]).padEnd(w)}${row.cells.slice(1).map((c) => String(c).padStart(18)).join('')}`);
}

//#endregion

//#region the derived figures

const ratio = (a, b) => Math.round((a / b) * 100) / 100;
/** A ratio as prose reads it: two decimals, so `1` never prints as parity it did not measure. */
const x = (r) => r.toFixed(2);

/**
 * The rate a path scans at, as the least-squares slope of its cost
 * against `n · d` over the legs it ran, in nanoseconds per vector
 * component, with the fixed cost as the intercept. Exact brute force is
 * linear in exactly that product, which is what makes a ceiling
 * derivable instead of guessed — and taking the SLOPE rather than a
 * mean of ratios is what keeps the per-query overhead out of the rate.
 * Null under two distinct legs: one point is not a line.
 */
function fit(key) {
  const points = legs.filter((leg) => leg.rows[key] !== undefined)
    .map((leg) => ({ x: leg.n * leg.d, y: leg.rows[key] }));
  if (new Set(points.map((p) => p.x)).size < 2) return null;
  const mx = points.reduce((sum, p) => sum + p.x, 0) / points.length;
  const my = points.reduce((sum, p) => sum + p.y, 0) / points.length;
  let top = 0;
  let bottom = 0;
  for (const p of points) {
    top += (p.x - mx) * (p.y - my);
    bottom += (p.x - mx) ** 2;
  }
  const slope = top / bottom;
  return { slope, intercept: my - slope * mx };
}

/**
 * The corpus size at which one query of width `d` costs `budgetMs`,
 * rounded to a thousand — the fit read backwards.
 */
function ceilingAt(line, budgetMs, d) {
  if (line === null) return null;
  const n = (budgetMs * 1e6 - line.intercept) / (line.slope * d);
  return n <= 0 ? 0 : Math.round(n / 1000) * 1000;
}

const planFit = fit('plan');
const rivalFit = fit('rival');
const perComponent = (line) => (line === null ? null : Math.round(line.slope * 1000) / 1000);

const figures = {
  // the row the column exists to beat, and the row it cannot
  jsonDocVsPlan: jsonLeg === null ? null : ratio(jsonLeg.rows.jsonDoc, jsonLeg.rows.plan),
  jsonDocLeg: jsonLeg === null ? null : jsonLeg.label,
  planVsResident: ratio(largest.rows.plan, largest.rows.resident),
  // what the plan itself costs over the statement it runs
  planVsFetch: ratio(largest.rows.plan, largest.rows.fetch),
  // the decision D7 rests on: pushing the rank into SQL against not
  // pushing it (> 1 means the UDF is slower, which is why it is not emitted)
  udfVsFetch: ratio(largest.rows.udf, largest.rows.fetch),
  udfVsFetchLow: ratio(Math.min(...legs.map((leg) => leg.rows.udf / leg.rows.fetch)), 1),
  udfVsFetchHigh: ratio(Math.max(...legs.map((leg) => leg.rows.udf / leg.rows.fetch)), 1),
  // the price of the column, both halves
  loadCost: ratio(largest.rows.loadIndexed, largest.rows.loadPlain),
  storageCost: ratio(largest.storage.indexedBytes, largest.storage.plainBytes),
  columnShare: ratio(largest.storage.columnPayload, largest.storage.docPayload),
  packedVsJson: ratio(largest.storage.jsonBytes, largest.storage.packedBytes),
  // the rival, whichever way it fell
  rivalVsPlan: largest.rows.rival === undefined ? null : ratio(largest.rows.plan, largest.rows.rival),
  rivalStorage: largest.storage.rivalBytes === undefined ? null
    : ratio(largest.storage.indexedBytes, largest.storage.rivalBytes),
  largest: largest.label,
  // the ceiling, as numbers
  planNsPerComponent: perComponent(planFit),
  rivalNsPerComponent: perComponent(rivalFit),
  ceiling100msAt768: ceilingAt(planFit, 100, 768),
  ceiling1sAt768: ceilingAt(planFit, 1000, 768),
  rivalCeiling1sAt768: ceilingAt(rivalFit, 1000, 768),
};

const thousands = (n) => n.toLocaleString('en-US');
const notes = [
  figures.jsonDocVsPlan === null
    ? 'the JSON-doc row did not run at any measured size, so the row the column exists to beat is unmeasured here'
    : `the row the column exists to beat: at ${figures.jsonDocLeg} the same query document over a`
      + ` collection with no vector column costs ${x(figures.jsonDocVsPlan)}× the k-nearest plan`,
  `the row the database cannot win: the k-nearest plan is ${x(figures.planVsResident)}× the resident`
    + ` sweep over a Float32 matrix at ${figures.largest} — that sweep starts from decoded floats in`
    + ' RAM and pays nothing for durability, filters or a process that can restart',
  `the plan costs ${x(figures.planVsFetch)}× its own statement run by hand, which is what the cut, the`
    + ' engine re-rank and the winners fetch add over fetch-and-sweep',
  `pushing the rank into SQL, re-measured against the real column: ORDER BY over a registered`
    + ` function is ${x(figures.udfVsFetch)}× the fetch-and-rank at ${figures.largest}`
    + ` (${x(figures.udfVsFetchLow)}–${x(figures.udfVsFetchHigh)}× across the grid), so it`
    + (figures.udfVsFetchLow >= 1.1 ? ' loses on speed'
      : figures.udfVsFetchHigh <= 0.9 ? ' WINS on speed'
        : ' is at rough parity on speed')
    + '. The plan still does not emit it, and after this measurement the reasons are not speed:'
    + ' bun\'s SQLite binding has no user-function API at all, so a plan that needed one would'
    + ' exclude an executor; and an ORDER BY over the column\'s own score decides the order in SQL,'
    + ' where the engine — the only party that can see the document\'s secondary keys — has to'
    + ' decide it for the three executors to agree on ties',
  `the column costs ${x(figures.loadCost)}× the write; its bytes are ${x(figures.columnShare)}× the`
    + ` documents' own and the database measures ${x(figures.storageCost)}× as large`
    + (figures.storageCost < 1.02
      ? ' — at this row size they fit in slack SQLite was already leaving on the page'
      : '')
    + `. Packed, one vector is ${x(figures.packedVsJson)}× smaller than the same vector as JSON in`
    + ' the document beside it',
  figures.rivalVsPlan === null
    ? `no rival row: sqlite-vec did not load on the measuring host — ${rival.ok ? 'no reason recorded' : rival.reason}`
    : `sqlite-vec answers the same probes ${figures.rivalVsPlan >= 1 ? `${x(figures.rivalVsPlan)}× faster` : `${x(ratio(1, figures.rivalVsPlan))}× slower`}`
      + ` than the plan at ${figures.largest}, out of a database ${x(figures.rivalStorage)}× smaller`
      + ' that holds the vectors and no documents',
  figures.planNsPerComponent === null
    ? 'the ceiling needs at least two legs of different n·d to fit; this run measured one'
    : `the ceiling, measured: the plan scans at ${figures.planNsPerComponent} ns per vector component,`
      + ` so one query reaches 100 ms at about ${thousands(figures.ceiling100msAt768)}`
      + ` vectors of 768 dimensions and one second at about ${thousands(figures.ceiling1sAt768)}.`
      + ' Past that this design is the wrong tool: exact brute force is linear in n·d and no margin'
      + ' changes that'
      + (figures.rivalCeiling1sAt768 === null ? '.'
        : `. sqlite-vec's cost is linear in the same product on this build`
          + ` (${figures.rivalNsPerComponent} ns per component, one second at about`
          + ` ${thousands(figures.rivalCeiling1sAt768)} vectors), so what lies past the ceiling is`
          + ' an approximate index that neither of these rows is'),
];

console.log('');
for (const note of notes) console.log(`  → ${note}`);

/**
 * The page's callout: the flagship row, the row it beats, the row it
 * cannot, and the rival — every comparison word derived from the
 * measurements, so a re-measure that flips one rewrites the sentence.
 */
const headline = {
  title: `k-nearest over a stored vector column: ${ms(largest.rows.plan)} for the top ${K}`
    + ` of ${largest.label}`,
  text: `The k-nearest plan — the column cuts the candidates, the engine orders them, the`
    + ` winners' documents are fetched — answers ${largest.label} in ${ms(largest.rows.plan)}.`
    + (figures.jsonDocVsPlan === null ? ''
      : ` The same query document over a collection with no vector column costs`
        + ` ${x(figures.jsonDocVsPlan)}× that at ${figures.jsonDocLeg}, which is the row the column`
        + ' exists to beat.')
    + ` The row it cannot beat is the one with no database in it: the same top-${K} over a resident`
    + ` Float32 matrix is ${ms(largest.rows.resident)}, ${x(figures.planVsResident)}× faster,`
    + ' starting from decoded floats in RAM and paying nothing for durability, filters or a process'
    + ` that can restart. Pushing the rank into SQL — ORDER BY over a registered function — measures`
    + ` ${x(figures.udfVsFetchLow)}–${x(figures.udfVsFetchHigh)}× the fetch-and-rank across the grid,`
    + ' which is close enough that the reason the plan does not emit it is portability and tie'
    + ' correctness rather than speed: bun has no user-function API, and only the engine can break'
    + ' a tie by the document\'s own keys. The column is not free: it costs'
    + ` ${x(figures.loadCost)}× the write and its bytes are ${x(figures.columnShare)}× the`
    + ' documents\' own.'
    + (figures.rivalVsPlan === null
      ? ` sqlite-vec, the extension built for this, did not load on the measuring host.`
      : ` sqlite-vec, the extension built for this, answers the same probes`
        + ` ${figures.rivalVsPlan >= 1 ? `${x(figures.rivalVsPlan)}× faster` : `${x(ratio(1, figures.rivalVsPlan))}× slower`}`
        + ` out of a database ${x(figures.rivalStorage)}× smaller that holds no documents — and it is`
        + ' a native extension, which is the thing this store does not require.')
    + (figures.planNsPerComponent === null ? ''
      : ` The ceiling is arithmetic, not opinion: at ${figures.planNsPerComponent} ns per vector`
        + ` component one query reaches one second at about ${thousands(figures.ceiling1sAt768)}`
        + ' vectors of 768 dimensions, and past that an exact brute-force scan is the wrong tool.'),
};

//#endregion

//#region output

if (flags.output === 'json') {
  const payload = {
    meta: {
      suite: 'vector',
      title: 'Vector — k-nearest over a stored column, every way it runs',
      description: 'One k-nearest query over a derive: \'vector\' column measured every physical'
        + ' way it can run — the resident sweep with no database, the shipped plan, its own'
        + ' statement by hand, ORDER BY over a registered function, the same query with no column'
        + ' at all, and sqlite-vec — equivalence-gated, with what the column costs to write and to'
        + ' store, and the brute-force ceiling as numbers.',
      date: new Date().toISOString(),
      node: process.version,
      seed: flags.seed,
      k: K,
      probes: PROBES,
      warmup: WARMUP,
      quick: flags.quick,
      engine: 'node:sqlite :memory:, JSONB documents, one packed Float32 BLOB column',
      legs: legs.map((leg) => ({ n: leg.n, dims: leg.d, label: leg.label,
        column: leg.column ?? null,
        candidates: leg.stats === undefined ? null : Math.round(leg.stats.candidates / leg.stats.queries) })),
      rival: rival.ok
        ? { name: 'sqlite-vec', version: rival.version, table: 'vec0',
          metric: 'l2 over unit vectors, which orders them exactly as cosine does' }
        : { name: 'sqlite-vec', unavailable: rival.reason },
      classes: Object.entries(RIVAL_CLASSES).map(([key, cls]) => ({
        key, name: cls.name, expected: cls.expected, count: cls.entries.length, note: cls.note,
      })),
      figures,
      notes,
      equivalenceFailures: failures,
    },
    headline,
    checks,
    tables,
    rows: legs.flatMap((leg) => [
      ...ORDER.filter(([key]) => leg.rows[key] !== undefined)
        .map(([key, name]) => ({ n: leg.n, dims: leg.d, path: key, label: name, ns: leg.rows[key] })),
      { n: leg.n, dims: leg.d, path: 'load-plain', label: 'load, no column', ns: leg.rows.loadPlain },
      { n: leg.n, dims: leg.d, path: 'load-indexed', label: 'load, with the column', ns: leg.rows.loadIndexed },
    ]),
    storage: legs.map((leg) => ({ n: leg.n, dims: leg.d, ...leg.storage })),
  };
  const json = JSON.stringify(payload, null, 2);
  if (flags.filepath !== null) {
    writeFileSync(flags.filepath, json);
    console.log(`\nwrote ${flags.filepath}`);
  }
  else console.log(json);
}

//#endregion
