#!/usr/bin/env node

/**
 * JarenJS Spatial Storage Benchmark — a spatial predicate over
 * @jarenjs/db, before and after the derived index
 *
 * Fifty thousand points over the Netherlands, stored as GeoJSON
 * positions in a collection, probed with one box at ~0.5 % selectivity.
 * The table is the shape a consumer writes (`$within` against a
 * region) measured every way it can run: as a full scan with the exact
 * predicate in the engine, as a deterministic UDF inside the scan, as
 * the two-stage plan over a `derive: 'bbox'` index (box seek in SQLite,
 * exact containment in the engine), as the exact promotions
 * (`$bbox-intersects`, a geohash cell), as a nine-cell proximity probe
 * — the only geohash proximity that is correct at a cell boundary —
 * and, for the row that decides whether the database earns its place
 * at all, as the in-memory engine over the same array with no database
 * behind it.
 *
 * Correctness before timing, and refusal on disagreement: every plan
 * case of the committed spatial corpus runs through the store first and
 * must answer what the JavaScript engine recorded, and every timed
 * shape must return exactly the id set the engine returns over the
 * array. A shape that disagrees is not timed and the run exits
 * non-zero — a benchmark that measures a wrong answer measures nothing.
 *
 * Rivals: none head-to-head, and saying so is the honest move. Nothing
 * else in JavaScript stores GeoJSON in SQLite from a JSON query
 * document. The positioning rivals are named in the notes — MongoDB's
 * `2dsphere` and DuckDB-wasm's `spatial` have real spatial indexes and
 * overlay operations this suite does not; neither runs one document
 * through three executors proven to agree, and neither checks ring closure
 * in a schema. No fabricated head-to-head.
 *
 * The R*Tree row is a physical-mapping comparison, not a shipped path:
 * a hand-built R*Tree beside a generated-box four-column index over the
 * same rows on a raw node:sqlite connection, probed with the same box
 * and refined by the same exact test. It decides whether an R*Tree
 * mapping for `derive: 'bbox'` would be worth building.
 *
 * Usage:
 *   node benchmark/spatial.js                       # full run (50 000 points, 20 repetitions)
 *   node benchmark/spatial.js --quick               # 10 000 points, 5 repetitions
 *   node benchmark/spatial.js --docs N --repetitions N
 *   node benchmark/spatial.js --output json --filepath results.json
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { compileJsonQuery } from '@jarenjs/json/query';
import { containsPosition, geohashEncode } from '@jarenjs/core/geo';

import { deepEquals } from './lib/equals.js';
import { formatNs } from './lib/fmt.js';

//#region setup

const args = process.argv.slice(2);
const flag = (name, fallback) =>
  (args.includes(name) ? parseInt(args[args.indexOf(name) + 1], 10) : fallback);
const flags = {
  quick: args.includes('--quick'),
  docs: flag('--docs', 50_000),
  repetitions: flag('--repetitions', 20),
  output: args.includes('--output') ? args[args.indexOf('--output') + 1] : null,
  filepath: args.includes('--filepath') ? args[args.indexOf('--filepath') + 1] : null,
};
if (flags.quick) {
  flags.docs = Math.min(flags.docs, 10_000);
  flags.repetitions = Math.min(flags.repetitions, 5);
}
const N = flags.docs;
const REPS = flags.repetitions;

/** The Netherlands, as a box; the corpus is uniform over it. */
const NL = [3.3, 50.75, 7.2, 53.55];
/** The probe box: ~0.5 % of a uniform corpus over NL. */
const PROBE = [4.7, 52.30, 5.1, 52.45];
const REGION = {
  type: 'Polygon',
  coordinates: [[
    [PROBE[0], PROBE[1]], [PROBE[2], PROBE[1]], [PROBE[2], PROBE[3]],
    [PROBE[0], PROBE[3]], [PROBE[0], PROBE[1]],
  ]],
};
const CENTRE = [(PROBE[0] + PROBE[2]) / 2, (PROBE[1] + PROBE[3]) / 2];
const RADIUS = 5_000;
const CELL_PRECISION = 6;
const CELL = geohashEncode(CENTRE[0], CENTRE[1], CELL_PRECISION);
/** The selective non-spatial conjunct: one of twenty kinds, ~5 %. */
const KINDS = 20;
const KIND = 'k7';
const LIMIT = 10;

/** A deterministic PRNG, so the corpus is the same on every machine. */
function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = seededRandom(20260822);
const DOCS = [];
for (let i = 0; i < N; i++) {
  const lon = NL[0] + rand() * (NL[2] - NL[0]);
  const lat = NL[1] + rand() * (NL[3] - NL[1]);
  DOCS.push({ id: `p${i}`, kind: `k${i % KINDS}`, at: [lon, lat] });
}
const DOC_BYTES = JSON.stringify(DOCS[0]).length;

const SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string' }, kind: { type: 'string' }, at: { type: ['array', 'object'] },
  },
};
const model = (indexes) => ({
  $model: '0.1',
  collections: { places: { schema: SCHEMA, key: '/id', indexes } },
});
const BY_KIND = { name: 'by_kind', path: '$.kind' };
const DERIVED = [
  { name: 'by_box', path: '$.at', derive: 'bbox' },
  { name: 'by_cell', path: '$.at', derive: 'geohash', precision: CELL_PRECISION },
];

/**
 * The SAME logical indexes with every `bbox` column set realized as an
 * R*Tree virtual table instead of a B-tree over four generated columns
 * (MODEL-FORMAT §2.1, `physical`). Same paths, same derivations, same
 * answers — a different shape on disk, which is the only thing being
 * measured here.
 */
const DERIVED_RTREE = DERIVED.map((index) =>
  (index.derive === 'bbox' ? { ...index, physical: 'rtree' } : index));

const flwor = (where, extra = {}) => ({ $for: { it: '$[*]' }, $where: where, ...extra, $return: '$it' });
const WITHIN_LITERAL = { $within: ['$it.at', REGION] };
const WITHIN_EXTERNAL = { $within: ['$it.at', '$region'] };
const IS_KIND = { $eq: ['$it.kind', KIND] };
const EXTERNALS = { region: REGION };

const asArray = (result) =>
  (result === undefined ? [] : Array.isArray(result) ? result : [result]);
const idsOf = (rows) => rows.map((row) => row.id);

//#endregion

//#region the shapes

/**
 * Every timed shape: the query document, which store it runs against,
 * and the row it is. `reference` is what the engine answers over the
 * array; the ids must agree exactly before the shape is timed.
 * @type {{ key: string, name: string, store: 'plain' | 'indexed',
 *   document: any, externals?: any, table: string }[]}
 */
const SHAPES = [
  // — without a derived index: where a consumer started —
  { key: 'within-scan', table: 'plain',
    name: '$within, external region — full scan, exact test in the engine',
    store: 'plain', document: flwor(WITHIN_EXTERNAL), externals: EXTERNALS },
  { key: 'within-udf', table: 'plain',
    name: '$within, literal region — the deterministic-UDF hatch inside the scan',
    store: 'plain', document: flwor(WITHIN_LITERAL) },
  { key: 'within-udf-selective', table: 'plain',
    name: `$within (UDF) and an indexed kind = '${KIND}' (~${100 / KINDS} %)`,
    store: 'plain', document: flwor({ $and: [IS_KIND, WITHIN_LITERAL] }) },
  { key: 'within-residual-selective', table: 'plain',
    name: `$within (residual) and an indexed kind = '${KIND}' — the same, no UDF`,
    store: 'plain', document: flwor({ $and: [IS_KIND, WITHIN_EXTERNAL] }), externals: EXTERNALS },
  { key: 'within-udf-limit', table: 'plain',
    name: `$within (UDF) with LIMIT ${LIMIT}`,
    store: 'plain', document: { $subsequence: [flwor(WITHIN_LITERAL), 0, LIMIT] } },
  { key: 'within-residual-limit', table: 'plain',
    name: `$within (residual) with LIMIT ${LIMIT} — the same, no UDF`,
    store: 'plain', document: { $subsequence: [flwor(WITHIN_EXTERNAL), 0, LIMIT] },
    externals: EXTERNALS },
  // — with the derived indexes: the two-stage plan —
  { key: 'within-indexed', table: 'indexed',
    name: '$within, external region — bbox seek in SQLite, exact containment in the engine',
    store: 'indexed', document: flwor(WITHIN_EXTERNAL), externals: EXTERNALS },
  { key: 'bbox-intersects', table: 'indexed',
    name: '$bbox-intersects — decided in SQLite, nothing to refine',
    store: 'indexed', document: flwor({ '$bbox-intersects': ['$it.at', REGION] }) },
  { key: 'distance', table: 'indexed',
    name: `bounded $distance (${RADIUS / 1000} km) — circle box seek, exact distance in the engine`,
    store: 'indexed', document: flwor({ $le: [{ $distance: ['$it.at', CENTRE] }, RADIUS] }) },
  { key: 'cell-one', table: 'indexed',
    name: `one geohash cell (${CELL}) — bucketing, not proximity`,
    store: 'indexed',
    document: flwor({ '$starts-with': [{ $geohash: ['$it.at', CELL_PRECISION] }, CELL] }) },
  { key: 'cell-nine', table: 'indexed',
    name: `nine geohash cells around ${CELL} — the proximity probe`,
    store: 'indexed',
    document: flwor({ $exists: { '$index-of': [
      { '$geohash-neighbours': CELL }, { $geohash: ['$it.at', CELL_PRECISION] }] } }) },
  // — the same three box predicates over the OTHER physical mapping —
  { key: 'within-rtree', table: 'rtree',
    name: "$within, external region — R*Tree probe (physical: 'rtree'), same refinement",
    store: 'rtree', document: flwor(WITHIN_EXTERNAL), externals: EXTERNALS },
  { key: 'bbox-intersects-rtree', table: 'rtree',
    name: '$bbox-intersects — R*Tree probe, refined (32-bit float box is a superset)',
    store: 'rtree', document: flwor({ '$bbox-intersects': ['$it.at', REGION] }) },
  { key: 'distance-rtree', table: 'rtree',
    name: `bounded $distance (${RADIUS / 1000} km) — R*Tree probe, exact distance in the engine`,
    store: 'rtree', document: flwor({ $le: [{ $distance: ['$it.at', CENTRE] }, RADIUS] }) },
];

//#endregion

//#region stores

async function openPlaces(indexes) {
  const store = await openStore(model(indexes), { driver: nodeDriver() });
  const sync = store.sync.collection('places');
  // the LOAD is timed here because it is the honest other half of the
  // read: an R*Tree is a second table written inside every write
  // transaction, and a suite that publishes only the probe is marketing
  const start = process.hrtime.bigint();
  store.sync.transaction(() => {
    for (const doc of DOCS) sync.insert(doc);
  });
  const loadNs = Number(process.hrtime.bigint() - start);
  return { store, places: store.collection('places'), loadNs };
}

/**
 * The physical-mapping comparison on a raw connection: the same rows,
 * a generated-box four-column index (the shape the store declares for
 * `derive: 'bbox'` — a point's box is the point) and an R*Tree, probed
 * with the same box and refined by the same exact test. Neither is the
 * store; both are the physical question the store's plan sits on.
 */
function openRaw() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE places (
      id INTEGER PRIMARY KEY,
      doc TEXT NOT NULL,
      w REAL GENERATED ALWAYS AS (json_extract(doc, '$.at[0]')) VIRTUAL,
      e REAL GENERATED ALWAYS AS (json_extract(doc, '$.at[0]')) VIRTUAL,
      s REAL GENERATED ALWAYS AS (json_extract(doc, '$.at[1]')) VIRTUAL,
      n REAL GENERATED ALWAYS AS (json_extract(doc, '$.at[1]')) VIRTUAL
    );
    CREATE INDEX places_by_box ON places (w, e, s, n);
    CREATE VIRTUAL TABLE places_rtree USING rtree(id, minx, maxx, miny, maxy);
  `);
  const insert = db.prepare('INSERT INTO places (id, doc) VALUES (?, ?)');
  const insertBox = db.prepare('INSERT INTO places_rtree VALUES (?, ?, ?, ?, ?)');
  db.exec('BEGIN');
  for (let i = 0; i < DOCS.length; i++) {
    insert.run(i, JSON.stringify(DOCS[i]));
    insertBox.run(i, DOCS[i].at[0], DOCS[i].at[0], DOCS[i].at[1], DOCS[i].at[1]);
  }
  db.exec('COMMIT');
  // the store's own predicate shape: total through IS NOT NULL, which is
  // also what makes the leading term a two-sided range SQLite will seek;
  // both statements order by the row key, as the store's plan does
  const generated = db.prepare(
    'SELECT doc FROM places WHERE w IS NOT NULL AND w <= ? AND e >= ? AND s <= ? AND n >= ? '
    + 'ORDER BY id');
  const rtree = db.prepare(
    'SELECT p.doc FROM places_rtree r JOIN places p ON p.id = r.id '
    + 'WHERE r.minx <= ? AND r.maxx >= ? AND r.miny <= ? AND r.maxy >= ? ORDER BY p.id');
  const params = [PROBE[2], PROBE[0], PROBE[3], PROBE[1]];
  const refine = (rows) => {
    const out = [];
    for (const row of rows) {
      const doc = JSON.parse(row.doc);
      if (containsPosition(REGION, doc.at[0], doc.at[1])) out.push(doc);
    }
    return out;
  };
  return {
    generated: () => refine(generated.all(...params)),
    rtree: () => refine(rtree.all(...params)),
    narrative: (statement) => db.prepare(`EXPLAIN QUERY PLAN ${statement}`).all(...params)
      .map((row) => row.detail).join('; '),
    generatedSql: generated.sourceSQL,
    rtreeSql: rtree.sourceSQL,
    close: () => db.close(),
  };
}

//#endregion

//#region correctness — the gate the timings run behind

const checks = [];
let failures = 0;
const check = (name, agrees, detail) => {
  checks.push({ name, agrees, detail });
  if (!agrees) {
    failures++;
    console.error(`EQUIVALENCE FAILURE: ${name} — ${detail}`);
  }
};

/** The committed spatial corpus's plan cases, through a store that
 * declares the derived indexes: the oracle orders 03 and 05 built. */
async function checkCorpus() {
  const corpus = JSON.parse(readFileSync(
    new URL('../test/json/fixtures/spatial-corpus.json', import.meta.url), 'utf8'));
  const cases = corpus.filter((entry) => entry.collection === true && entry.executors === undefined);
  let agreed = 0;
  for (const entry of cases) {
    const store = await openStore({
      $model: '0.1',
      collections: {
        rows: {
          schema: { type: 'object', properties: { at: { type: ['array', 'object'] } } },
          key: null, identity: 'integer', indexes: DERIVED,
        },
      },
    }, { driver: nodeDriver() });
    try {
      const rows = store.collection('rows');
      for (const doc of entry.data) await rows.insert(doc);
      const actual = await rows.execute(entry.query);
      const agrees = entry.empty === true ? actual === undefined : deepEquals(actual, entry.expected);
      if (agrees) agreed++;
      check(`corpus ${entry.name}`, agrees,
        agrees ? 'answers what the engine recorded'
          : `recorded ${JSON.stringify(entry.expected)}, answered ${JSON.stringify(actual)}`);
    }
    finally {
      await store.close();
    }
  }
  return { cases: cases.length, agreed };
}

//#endregion

//#region run

const time = async (fn) => {
  await fn();
  const start = process.hrtime.bigint();
  for (let i = 0; i < REPS; i++) await fn();
  return Number(process.hrtime.bigint() - start) / REPS;
};
const timeSync = (fn) => {
  fn();
  const start = process.hrtime.bigint();
  for (let i = 0; i < REPS; i++) fn();
  return Number(process.hrtime.bigint() - start) / REPS;
};

console.log(`corpus: ${N} points over the Netherlands (~${DOC_BYTES} JSON bytes each); `
  + `probe box [${PROBE.join(', ')}]; ${REPS} repetitions after one warm execute`);

const corpus = await checkCorpus();
console.log(`spatial corpus: ${corpus.agreed} / ${corpus.cases} plan cases agree with the engine`);

const plain = await openPlaces([BY_KIND]);
const indexed = await openPlaces([BY_KIND, ...DERIVED]);
const rtree = await openPlaces([BY_KIND, ...DERIVED_RTREE]);
const stores = { plain: plain.places, indexed: indexed.places, rtree: rtree.places };
console.log(`engine: node:sqlite :memory:, JSONB documents; capabilities.rtree = ${plain.store.capabilities.rtree}`);

/** @type {Record<string, any>} the measured rows by key */
const measured = {};
for (const shape of SHAPES) {
  const reference = idsOf(asArray(compileJsonQuery(shape.document)(DOCS, shape.externals)));
  const collection = stores[shape.store];
  const actual = idsOf(asArray(await collection.execute(shape.document, { externals: shape.externals })));
  const agrees = deepEquals(actual, reference);
  check(shape.name, agrees, agrees
    ? `${reference.length} rows, the engine's exact set`
    : `${actual.length} rows against the engine's ${reference.length}`);
  if (!agrees) continue;
  const explained = await collection.explain(shape.document, { externals: shape.externals });
  const ns = await time(() => collection.execute(shape.document, { externals: shape.externals }));
  measured[shape.key] = {
    key: shape.key,
    name: shape.name,
    results: [ns],
    rows: reference.length,
    mode: explained.residual === null ? 'native' : explained.residual.mode,
    udf: explained.udfs.length > 0,
    prefilters: explained.prefilters.map((p) => `${p.construct}${p.exact ? '' : ' (refined)'}`),
    narrative: explained.scanNarrative.split('\n')[0],
  };
}

// the write cost of each shape, measured on the same load: one
// transaction, 50 000 inserts, the store's own write path
for (const [key, name, opened] of [
  ['load-columns', "load — derive: 'bbox' over four generated columns under a B-tree", indexed],
  ['load-rtree', "load — derive: 'bbox' as an R*Tree kept in sync by three triggers", rtree],
]) {
  measured[key] = {
    key, name, results: [opened.loadNs], rows: N, mode: 'load', udf: false,
    prefilters: [], narrative: `${N} documents in one transaction`,
  };
}

// the row that decides whether the database earns its place: the same
// $within over the same array, no database behind it — parsed objects
// in, which is the head start it has and the caption states
{
  const document = flwor(WITHIN_LITERAL);
  const compiled = compileJsonQuery(document);
  const reference = idsOf(asArray(compiled(DOCS)));
  const ns = timeSync(() => compiled(DOCS));
  measured.engine = {
    key: 'engine', name: '$within in the JavaScript engine over the parsed array — no database',
    results: [ns], rows: reference.length, mode: '—', udf: false, prefilters: [], narrative: '—',
  };
}

// the physical-mapping comparison, both raw, same refinement
{
  const raw = openRaw();
  const reference = idsOf(asArray(compileJsonQuery(flwor(WITHIN_LITERAL))(DOCS)));
  for (const [key, name, run, sql] of [
    ['generated-raw', 'generated-box four-column index, raw SQL + the same exact test',
      raw.generated, raw.generatedSql],
    ['rtree-raw', 'R*Tree virtual table (hand-built, not a shipped mapping), raw SQL + the same exact test',
      raw.rtree, raw.rtreeSql],
  ]) {
    const actual = idsOf(run());
    const agrees = deepEquals(actual, reference);
    check(name, agrees, agrees
      ? `${reference.length} rows, the engine's exact set`
      : `${actual.length} rows against the engine's ${reference.length}`);
    if (!agrees) continue;
    measured[key] = {
      key, name, results: [timeSync(run)], rows: reference.length, mode: 'raw', udf: false,
      prefilters: [], narrative: raw.narrative(sql),
    };
  }
  raw.close();
}

await plain.store.close();
await indexed.store.close();
await rtree.store.close();

if (failures > 0) {
  console.error(`\n${failures} equivalence failure(s): the timing table is withheld.`);
  process.exit(1);
}

//#endregion

//#region the table

const TABLES = [
  { key: 'plain', title: `Without a derived index — ${N} points, $within at ~0.5 % selectivity` },
  { key: 'indexed', title: `With derive: 'bbox' and derive: 'geohash' — the two-stage plan over the same ${N} points` },
  { key: 'rtree', title: "The store's own R*Tree mapping (physical: 'rtree') — the read, and what the write costs" },
  { key: 'physical', title: 'The physical question — generated-box B-tree against an R*Tree, raw, same refinement' },
];
const rowsFor = {
  plain: SHAPES.filter((s) => s.table === 'plain').map((s) => measured[s.key]),
  indexed: [...SHAPES.filter((s) => s.table === 'indexed').map((s) => measured[s.key]), measured.engine],
  rtree: [...SHAPES.filter((s) => s.table === 'rtree').map((s) => measured[s.key]),
    measured['load-columns'], measured['load-rtree']],
  physical: [measured['generated-raw'], measured['rtree-raw']],
};
const tables = TABLES.map((t) => ({
  title: t.title, columns: ['ms/query'], rows: rowsFor[t.key].filter((row) => row !== undefined),
}));

for (const table of tables) {
  console.log(`\n${table.title}`);
  for (const row of table.rows) {
    console.log(`  ${row.name.padEnd(86)} ${formatNs(row.results[0]).padStart(10)}  ${String(row.rows).padStart(4)} rows  ${row.mode}${row.udf ? ' (udf)' : ''}`);
    console.log(`  ${''.padEnd(86)} ${row.narrative}`);
  }
}

const ms = (key) => measured[key].results[0] / 1e6;
const ratio = (a, b) => Math.round((ms(a) / ms(b)) * 100) / 100;
const figures = {
  // the campaign's headline: what a consumer writes, before and after
  scanVsIndexed: ratio('within-scan', 'within-indexed'),
  // the row the database has to win: not using the database at all
  engineVsIndexed: ratio('engine', 'within-indexed'),
  // the UDF question, the three published shapes (> 1 is a push win)
  udfSolo: ratio('within-scan', 'within-udf'),
  udfSelective: ratio('within-residual-selective', 'within-udf-selective'),
  udfLimit: ratio('within-residual-limit', 'within-udf-limit'),
  // the R*Tree question (> 1 is an R*Tree win)
  rtreeVsGenerated: ratio('generated-raw', 'rtree-raw'),
  // the same question through the STORE, which is what a consumer gets:
  // the raw comparison isolates the mapping, this one pays for JSON
  // parsing, the refinement and the statement overhead too
  storeRtreeVsColumns: ratio('within-indexed', 'within-rtree'),
  // and the price of it: the write side, where the R*Tree is a second
  // table written inside every transaction (> 1 means the R*Tree load
  // is SLOWER, which is the direction to expect)
  rtreeLoadCost: ratio('load-rtree', 'load-columns'),
};
const notes = [
  `the shape a consumer writes ($within against an external region) runs ${figures.scanVsIndexed}x faster `
  + 'over a derive: \'bbox\' index than as a full scan — the two-stage plan is the whole difference',
  `the in-memory engine over the parsed array is the row the database has to beat: it starts from `
  + `objects where the store starts from bytes on a page, and the indexed store is ${figures.engineVsIndexed}x `
  + (figures.engineVsIndexed >= 1 ? 'faster' : 'SLOWER') + ' than it',
  `the UDF hatch for $within: ${figures.udfSolo}x as a sole predicate over a full scan, `
  + `${figures.udfSelective}x beside a selective indexed conjunct, ${figures.udfLimit}x with LIMIT ${LIMIT} `
  + '(> 1 is a push win; the residual comparator pushes everything but the spatial conjunct)',
  `an R*Tree probe is ${figures.rtreeVsGenerated}x the generated-box B-tree on the same rows and box `
  + '(> 1 favours the R*Tree); the R*Tree is a second table kept in sync transactionally and absent on any '
  + 'build without the module',
  `through the STORE, the same $within is ${figures.storeRtreeVsColumns}x over physical: 'rtree' as over `
  + `the four columns — and the load costs ${figures.rtreeLoadCost}x as much, because the R*Tree is a `
  + 'second table written inside every write transaction. Both halves are the price of the mapping',
  'no head-to-head rival: nothing else in JavaScript stores GeoJSON in SQLite from a JSON query document. '
  + 'MongoDB (2dsphere) and DuckDB-wasm (spatial) have real spatial indexes and overlay operations this '
  + 'suite does not; neither runs one document through three executors proven to agree',
];
console.log('');
for (const note of notes) console.log(`  → ${note}`);

if (flags.output === 'json') {
  const payload = {
    meta: {
      docs: N,
      docBytes: DOC_BYTES,
      probe: PROBE,
      repetitions: REPS,
      node: process.version,
      engine: 'node:sqlite :memory:, JSONB documents',
      rtree: plain.store.capabilities.rtree,
      mappings: ['columns', 'rtree'],
      corpus,
      figures,
      notes,
      equivalenceFailures: failures,
    },
    checks,
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

//#endregion
