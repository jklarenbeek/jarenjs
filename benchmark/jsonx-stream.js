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
 *
 * JSON.parse is the baseline — a native full-text parser without
 * incremental input or document-order events; the delta is the price of
 * streaming. Result equality is asserted before timing.
 *
 * Usage:
 *   node benchmark/jsonx-stream.js
 *   node benchmark/jsonx-stream.js --iterations 2000 --chunk 16
 */

/* eslint-disable no-console */

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
