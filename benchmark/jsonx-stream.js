#!/usr/bin/env node

/**
 * JarenJS JSONX streaming reader benchmark
 *
 * Measures the two consumption shapes of createJsonxStreamReader:
 *
 *  - message feed: MANY small complete JSON documents, one reader per
 *    document (the WebSocket shape — e.g. one exchange ticker message
 *    per frame). This isolates the per-document reader setup overhead
 *    and answers whether a reset()-for-reuse API is worth having:
 *    setup is a flat object allocation, so reader-per-document is the
 *    design; the number below keeps that claim honest.
 *  - incremental document: ONE large document fed in small chunks (the
 *    LLM token-output shape), compared with parsing the same text in
 *    one call.
 *  - retained memory: a record-per-line document consumed record by
 *    record, with and without `detach`. This one measures bytes rather
 *    than nanoseconds, because for a document larger than memory the
 *    question is not how fast it parses but whether it parses at all.
 *    Needs `--expose-gc`; without it the section says so rather than
 *    printing a number taken from a heap nobody collected.
 *
 * JSON.parse is the baseline — a native full-text parser without
 * incremental input or document-order events; the delta is the price of
 * streaming. Result equality is asserted before timing.
 *
 * Usage:
 *   node benchmark/jsonx-stream.js
 *   node benchmark/jsonx-stream.js --iterations 2000 --chunk 16
 *   node --expose-gc benchmark/jsonx-stream.js --features 20000
 */

import { writeFileSync } from 'node:fs';

import { parseJsonx, createJsonxStreamReader } from '@jarenjs/josl';
import { deepStrictEqual } from 'node:assert';

//#region options

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};
const ITERATIONS = opt('iterations', 1000);
const CHUNK = opt('chunk', 16);
const FEATURES = opt('features', 20_000);
const OUTPUT = args.includes('--output') ? args[args.indexOf('--output') + 1] : null;
const FILEPATH = args.includes('--filepath') ? args[args.indexOf('--filepath') + 1] : null;
const WARMUP = Math.max(10, Math.floor(ITERATIONS / 10));

//#endregion

//#region fixtures

// one exchange-style ticker message (the many-small-documents shape)
const MESSAGE = JSON.stringify({
  e: '24hrMiniTicker', E: 1721556000000, s: 'BTCUSDT',
  c: '64123.45000000', o: '63321.00000000',
  h: '64800.10000000', l: '62950.00000000',
  v: '18234.51230000', q: '1167034521.11220000',
});

// one large nested document (the incremental LLM-output shape)
const LARGE = JSON.stringify({
  run: Array.from({ length: 500 }, (_, i) => ({
    suite: i % 8, name: `case-${i}`, opsPerSecond: 1000 + i * 3.5,
    ok: i % 7 !== 0, tags: ['a', 'b', 'c'].slice(0, (i % 3) + 1),
  })),
});

function chunksOf(text, size) {
  const out = [];
  for (let i = 0; i < text.length; i += size)
    out.push(text.slice(i, i + size));
  return out;
}
const LARGE_CHUNKS = chunksOf(LARGE, CHUNK);

function streamParse(chunks, options) {
  const reader = createJsonxStreamReader(options);
  for (const chunk of chunks)
    reader.feed(chunk);
  return reader.end();
}

//#endregion

//#region timing

function measure(label, run) {
  for (let i = 0; i < WARMUP; i++) run(i);
  const start = process.hrtime.bigint();
  for (let i = 0; i < ITERATIONS; i++) run(i);
  const ns = Number(process.hrtime.bigint() - start) / ITERATIONS;
  return { label, ns };
}

function fmt(ns) {
  if (ns < 1000) return `${ns.toFixed(0)} ns`;
  if (ns < 1e6) return `${(ns / 1000).toFixed(1)} µs`;
  return `${(ns / 1e6).toFixed(2)} ms`;
}

function printTable(title, rows) {
  console.log(`\n${title}`);
  const base = rows[0].ns;
  for (const row of rows) {
    const ratio = row.ns / base;
    const suffix = row === rows[0] ? '' : `  (${ratio >= 1 ? ratio.toFixed(1) + 'x slower' : (1 / ratio).toFixed(1) + 'x faster'} than ${rows[0].label})`;
    console.log(`  ${row.label.padEnd(34)} ${fmt(row.ns).padStart(10)}${suffix}`);
  }
}

//#endregion

//#region equivalence gate

deepStrictEqual(streamParse([MESSAGE], { mode: 'json' }), JSON.parse(MESSAGE));
deepStrictEqual(streamParse(LARGE_CHUNKS, { mode: 'json' }), JSON.parse(LARGE));
deepStrictEqual(parseJsonx(LARGE, { mode: 'json' }), JSON.parse(LARGE));
console.log(`equivalence: stream (single + ${LARGE_CHUNKS.length}-chunk) === JSON.parse`);

//#endregion

//#region scenarios

console.log(`\nmessage: ${MESSAGE.length} B, document: ${LARGE.length} B, `
  + `chunk: ${CHUNK} B, iterations: ${ITERATIONS} (+${WARMUP} warmup), node ${process.version}`);

const messageRows = [
  measure('JSON.parse', () => JSON.parse(MESSAGE)),
  measure('parseJsonx (json mode)', () => parseJsonx(MESSAGE, { mode: 'json' })),
  measure('stream reader per document', () => streamParse([MESSAGE], { mode: 'json' })),
].sort((a, b) => a.ns - b.ns);
printTable(`message feed — one ${MESSAGE.length} B document per reader`, messageRows);

const documentRows = [
  measure('JSON.parse (whole text)', () => JSON.parse(LARGE)),
  measure('parseJsonx (whole text)', () => parseJsonx(LARGE, { mode: 'json' })),
  measure('stream reader (whole text)', () => streamParse([LARGE], { mode: 'json' })),
  measure(`stream reader (${CHUNK} B chunks)`, () => streamParse(LARGE_CHUNKS, { mode: 'json' })),
].sort((a, b) => a.ns - b.ns);
printTable(`incremental document — ${LARGE.length} B in ${LARGE_CHUNKS.length} chunks`, documentRows);

if (OUTPUT === 'json') {
  // The website-data shape (benchmark/website-data.js → the JOSL suite's
  // `stream` block): the two consumption shapes, each a {label, ns} list.
  const data = {
    date: new Date().toISOString(),
    node: process.version,
    iterations: ITERATIONS,
    messageBytes: MESSAGE.length,
    documentBytes: LARGE.length,
    chunkBytes: CHUNK,
    chunks: LARGE_CHUNKS.length,
    message: messageRows,
    document: documentRows,
  };
  const json = JSON.stringify(data, null, 2);
  if (FILEPATH !== null) {
    writeFileSync(FILEPATH, json);
    console.log(`\nwrote ${FILEPATH}`);
  }
  else {
    console.log(json);
  }
}

console.log('\nMethodology: strict-JSON mode throughout so JSON.parse is an apples-to-apples');
console.log('baseline; a fresh reader per document is the intended usage for message feeds');
console.log('(reader construction is a flat object allocation - no reset() API needed).');

//#endregion

//#region retained memory

/**
 * A synthetic FeatureCollection: one 40-vertex polygon per feature, the
 * shape of an OpenStreetMap administrative extract. Built as text
 * because that is what a reader is given — a file, a socket, a fetch
 * body — and the point of the exercise is never to hold the parse of it.
 */
function featureCollection(count) {
  const parts = ['{"type":"FeatureCollection","name":"synthetic","features":['];
  for (let i = 0; i < count; i++) {
    const lon = -180 + (i % 3600) * 0.1;
    const lat = -80 + (i % 1600) * 0.1;
    const ring = [];
    for (let v = 0; v <= 40; v++) {
      const a = ((v % 40) / 40) * Math.PI * 2;
      ring.push(`[${(lon + Math.cos(a) * 0.05).toFixed(5)},${(lat + Math.sin(a) * 0.05).toFixed(5)}]`);
    }
    parts.push(`${i === 0 ? '' : ','}{"type":"Feature","properties":{"id":${i},`
      + `"name":"region-${i}","pop":${1000 + i}},"geometry":{"type":"Polygon",`
      + `"coordinates":[[${ring.join(',')}]]}}`);
  }
  parts.push(']}');
  return parts.join('');
}

/**
 * Read `doc` in 64 kB chunks, consuming every feature as it completes
 * and then dropping it — a real sink, not a counter that lets the
 * engine optimize the work away.
 *
 * The peak reported is the **live set**: the heap after a forced
 * collection, sampled a handful of times across the read. Sampling
 * `heapUsed` without collecting first would measure how lazily V8 gets
 * around to sweeping, which grows with the heap and says nothing about
 * whether the document fits — under that measure a detached read looks
 * like it grows too, because the records it drops are still garbage
 * that has not been swept yet.
 *
 * @param {string} doc @param {number} count features in `doc`
 * @param {(string|number)[]} [detach]
 */
function readFeatures(doc, count, detach) {
  global.gc();
  global.gc();
  const before = process.memoryUsage().heapUsed;
  const every = Math.max(1, Math.floor(count / 8));
  let peak = 0;
  let seen = 0;
  let vertices = 0;
  const reader = createJsonxStreamReader({
    mode: 'json',
    detach,
    onEvent: (e) => {
      if (e.type !== 'object-end' || e.path.length !== 2) return;
      seen++;
      vertices += e.value.geometry.coordinates[0].length;
      if (seen % every === 0) {
        global.gc();
        const live = process.memoryUsage().heapUsed - before;
        if (live > peak) peak = live;
      }
    },
  });
  const size = 64 * 1024;
  for (let i = 0; i < doc.length; i += size)
    reader.feed(doc.slice(i, i + size));
  const root = reader.end();
  global.gc();
  const retained = process.memoryUsage().heapUsed - before;
  return { peak, retained, seen, vertices, held: root.features.length };
}

/**
 * Heap deltas, with an explicit floor. A forced-collection delta can
 * land a little either side of zero, and printing "-0.5 MB retained" as
 * though it meant something is worse than saying it is unmeasurable.
 */
const FLOOR = 104857.6; // 0.1 MB
const mb = (n) => (n < FLOOR ? '< 0.1 MB' : `${(n / 1048576).toFixed(1)} MB`);

if (typeof global.gc !== 'function') {
  console.log('\nretained memory: skipped — re-run with `node --expose-gc` to measure it.');
}
else {
  const doc = featureCollection(FEATURES);
  const hold = readFeatures(doc, FEATURES, undefined);
  const detached = readFeatures(doc, FEATURES, ['features', '*']);
  // four times the records: whether the number moves is the whole claim
  const bigger = readFeatures(featureCollection(FEATURES * 4), FEATURES * 4, ['features', '*']);

  // Both modes must have SEEN every feature and read every vertex —
  // otherwise the cheap one is cheap because it did less work.
  deepStrictEqual(
    [hold.seen, hold.vertices],
    [detached.seen, detached.vertices],
    'detach changed what the consumer saw');

  console.log(`\nretained memory — ${FEATURES} features, ${(doc.length / 1048576).toFixed(1)} MB of text, 64 kB chunks`);
  console.log('  (peak = live set after a forced collection, sampled 8x across the read)');
  const row = (label, m, count) =>
    console.log(`  ${label.padEnd(34)} peak ${mb(m.peak).padStart(9)}   `
      + `end ${mb(m.retained).padStart(9)}   root holds ${String(m.held).padStart(7)} of ${count}`);
  row('default (whole tree retained)', hold, FEATURES);
  row("detach ['features','*']", detached, FEATURES);
  row(`the same, ${FEATURES * 4} features`, bigger, FEATURES * 4);

  // Below the floor the ratio is noise over noise, so say so instead of
  // quoting a four-digit multiple that means nothing.
  const bothTiny = detached.peak < FLOOR && bigger.peak < FLOOR;
  const growth = bigger.peak / detached.peak;
  const verdict = bothTiny || growth <= 1.5
    ? 'flat in document size: the peak is the feed buffer and one feature at a time'
    : `${growth.toFixed(1)}x for 4x the records, so it is NOT flat — investigate before claiming it is`;
  console.log(`\n  detached peak: ${mb(detached.peak)} at ${FEATURES} features, `
    + `${mb(bigger.peak)} at ${FEATURES * 4} — ${verdict}.`);
  console.log(bothTiny
    ? `  Holding the tree instead costs ${mb(hold.peak)} and grows with every record read.`
    : `  Holding the tree instead costs ${(hold.peak / detached.peak).toFixed(0)}x that, `
      + 'and grows with every record read.');
}

//#endregion
