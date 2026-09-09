// The campaign's north star in one child: a node:sqlite store's cursor,
// pulled one row at a time into `stringifyCsvStream` / `stringifyJoslStream`,
// encoded as an opaque handler's `AsyncIterable<Uint8Array>`, served
// through the real Node HTTP adapter under the host lifecycle, read with
// `typedHttpClient(...).bytes()` into an incremental hash/count sink —
// under a V8 old space far below the payload (`--max-old-space-size=48`
// for 100 MiB). Backpressure is measured where it matters: the rows the
// cursor pulled while the client had consumed a quarter, and the application writable queue (independent of TCP buffers). A halfway cancellation must
// reach every finalizer exactly once: the byte source's `return()`, the
// DB cursor's `return()`, the acquired release and the identity release,
// with no later pull once cancellation reaches the byte source. The
// carrier half is repeated through the Fetch
// adapter in-process. One JSON line is printed; nothing retains a body.
import http from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileContract } from '@jarenjs/contract';
import { serveHttp } from '@jarenjs/contract/http';
import { toNodeHandler } from '@jarenjs/contract/node';
import { toFetchHandler } from '@jarenjs/contract/fetch';
import { openHttpClient } from '@jarenjs/contract/client';
import { defineContract, read, http as bind, typedHttpClient } from '@jarenjs/linq/contract';
import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { stringifyCsvStream, stringifyJoslStream } from '@jarenjs/josl';

const TOTAL = Number(process.argv[2] ?? process.env.SEAM_BYTES ?? 100 * 1024 * 1024);
/** Each row carries a 4 KiB payload, so the payloads alone reach TOTAL and every serialization exceeds it. */
const PAYLOAD = 4096;
const ROWS = Math.ceil(TOTAL / PAYLOAD);
const CANCEL_AT = Math.floor(TOTAL / 4);

let peakRss = 0;
const sample = () => {
  const rss = process.memoryUsage().rss;
  if (rss > peakRss) peakRss = rss;
};

// ——— the store: a node:sqlite FILE, ROWS rows in one synchronous transaction ———
const dir = mkdtempSync(join(tmpdir(), 'jaren-seam-'));
const store = await openStore({
  $model: '0.1',
  collections: {
    rows: {
      schema: { type: 'object', required: ['id'], properties: { id: { type: 'integer' }, name: { type: 'string' }, payload: { type: 'string' } } },
      key: '/id',
      indexes: [],
    },
  },
}, { driver: nodeDriver(), path: join(dir, 'rows.db') });
const filler = 'x'.repeat(PAYLOAD - 16);
// bounded transactions: a transaction holds its own writes until it
// commits, so the seed is committed in pages of 256 rows — the same
// discipline the read side is measured under
const PAGE = 256;
for (let from = 0; from < ROWS; from += PAGE) {
  store.sync.transaction(() => {
    const rows = store.sync.collection('rows');
    for (let i = from; i < Math.min(from + PAGE, ROWS); i++) rows.insert({ id: i, name: `row-${i}`, payload: `${String(i).padStart(8, '0')}:${filler}` });
  });
}
// the whole collection as ONE ROW PER PULL: the `$for` phrase the store
// streams from an open statement (a bare `'$[*]'` is planned as the
// same scan); an array constructor (`[{ $for … }]`) would answer its
// whole result as one item — not a row cursor
const SCAN = { $for: { r: '$[*]' }, $return: '$r' };

// ——— the contract: two opaque reads, written with the pen ———
const pen = defineContract({ id: 'seam' }, {
  'rows.csv': read({ output: true, http: bind({ method: 'GET', path: '/rows.csv', media: 'text/csv' }) }),
  'rows.josl': read({ output: true, http: bind({ method: 'GET', path: '/rows.josl', media: 'application/josl' }) }),
});
const contract = compileContract(pen.document);

/** The counters of one served body, from the cursor to the socket. */
function counters() {
  return { pulls: 0, cursorReturns: 0, bodyReturns: 0, encoded: 0, pullsAfterCancel: 0, cancelled: false,
    written: 0, maxChunk: 0, maxProducerAhead: 0, maxApplicationQueued: 0, highWaterMark: 0 };
}

/**
 * The DB cursor, counted: every row pulled, every `return()`.
 * @param {ReturnType<typeof counters>} c
 */
function countedCursor(c) {
  const cursor = store.collection('rows').query(SCAN);
  const inner = cursor[Symbol.asyncIterator]();
  return {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          const step = await inner.next();
          if (!step.done) {
            c.pulls += 1;
            if (c.cancelled) c.pullsAfterCancel += 1;
          }
          return step;
        },
        async return(value) {
          c.cursorReturns += 1;
          if (typeof inner.return === 'function') await inner.return();
          return { done: true, value };
        },
      };
    },
  };
}

/**
 * Text chunks encoded as bytes, counted; its `return()` is the byte
 * source's finalizer the consumer's cancel must reach.
 * @param {AsyncIterable<string>} text
 * @param {ReturnType<typeof counters>} c
 */
function encoded(text, c) {
  const encoder = new TextEncoder();
  return {
    [Symbol.asyncIterator]() {
      const inner = text[Symbol.asyncIterator]();
      return {
        async next() {
          const step = await inner.next();
          if (step.done) return step;
          const bytes = encoder.encode(step.value);
          c.encoded += bytes.byteLength;
          c.maxChunk = Math.max(c.maxChunk, bytes.byteLength);
          c.maxProducerAhead = Math.max(c.maxProducerAhead, c.encoded - c.written);
          return { done: false, value: bytes };
        },
        async return(value) {
          // TCP cancellation reaches the source after the client stops;
          // count later pulls from this producer-side boundary.
          c.cancelled = true;
          c.bodyReturns += 1;
          if (typeof inner.return === 'function') await inner.return();
          return { done: true, value };
        },
      };
    },
  };
}

/** The lifecycle's releases, counted per request. */
const releases = { identity: 0, acquired: 0 };
/** @type {Record<string, ReturnType<typeof counters>>} the counters of the body in flight, by format */
const live = {};

function server() {
  return serveHttp(contract, {
    'rows.csv': () => {
      const c = counters();
      live.csv = c;
      return { status: 200, headers: { 'content-type': 'text/csv' }, body: encoded(stringifyCsvStream(countedCursor(c), { fields: ['id', 'name', 'payload'] }), c) };
    },
    'rows.josl': () => {
      const c = counters();
      live.josl = c;
      return { status: 200, headers: { 'content-type': 'application/josl' }, body: encoded(stringifyJoslStream(countedCursor(c)), c) };
    },
  }, {
    identify: () => ({ host: { who: 'identity' }, release: () => { releases.identity += 1; } }),
    acquire: (input, identity, enter) => enter({ host: { who: 'acquired' }, release: () => { releases.acquired += 1; } }),
  });
}

/**
 * Read a body to the end (or to `cancelAt` bytes, then cancel), hashing
 * and counting; records the cursor's pulls when a quarter was consumed
 * and the most encoded bytes ever ahead of the consumer.
 * @param {ReadableStream<Uint8Array>} stream
 * @param {() => ReturnType<typeof counters>} of
 * @param {number | null} cancelAt
 */
async function sink(stream, of, cancelAt) {
  const h = createHash('sha256');
  const reader = stream.getReader();
  let consumed = 0;
  let maxAhead = 0;
  let pullsAtQuarter = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    h.update(value);
    consumed += value.byteLength;
    const c = of();
    const ahead = c.encoded - consumed;
    if (ahead > maxAhead) maxAhead = ahead;
    if (pullsAtQuarter === null && consumed >= TOTAL / 4) pullsAtQuarter = c.pulls;
    sample();
    if (cancelAt !== null && consumed >= cancelAt) {
      await reader.cancel();
      break;
    }
  }
  return { hash: h.digest('hex'), consumed, maxAhead, pullsAtQuarter };
}

/** Wait until a counter settles (the cancel reaches the finalizers asynchronously). @param {() => boolean} until */
async function settle(until) {
  for (let i = 0; i < 400 && !until(); i++) await new Promise((r) => setTimeout(r, 5));
}

// ——— the Node carrier: CSV and JOSL whole, then CSV cancelled halfway ———
const dispatcher = server();
const nodeHandler = toNodeHandler(dispatcher);
const nodeServer = http.createServer((request, response) => {
  const write = response.write.bind(response);
  response.write = function (chunk, ...args) {
    const c = request.url === '/rows.josl' ? live.josl : live.csv;
    const accepted = write(chunk, ...args);
    c.written += chunk.byteLength;
    c.highWaterMark = response.writableHighWaterMark;
    // Writable queue bytes belong to the application. Bytes already
    // accepted by the kernel do not, regardless of TCP autotuning.
    c.maxApplicationQueued = Math.max(c.maxApplicationQueued, response.writableLength);
    return accepted;
  };
  void nodeHandler(request, response);
});
nodeServer.listen(0, '127.0.0.1');
await once(nodeServer, 'listening');
const client = typedHttpClient(openHttpClient(contract, { baseUrl: `http://127.0.0.1:${nodeServer.address().port}` }), pen);

const started = Date.now();
const csv = await client.bytes('rows.csv', null);
if (!csv.ok) throw new Error(`csv failed: ${JSON.stringify(csv)}`);
const csvRead = await sink(csv.value.body, () => live.csv, null);
await settle(() => releases.identity === 1);
const csvSummary = { ...csvRead, ...live.csv, bytes: live.csv.encoded, releases: { ...releases } };

const josl = await client.bytes('rows.josl', null);
if (!josl.ok) throw new Error(`josl failed: ${JSON.stringify(josl)}`);
const joslRead = await sink(josl.value.body, () => live.josl, null);
await settle(() => releases.identity === 2);
const joslSummary = { ...joslRead, ...live.josl, bytes: live.josl.encoded, releases: { ...releases } };

const cancelled = await client.bytes('rows.csv', null);
if (!cancelled.ok) throw new Error(`cancel run failed: ${JSON.stringify(cancelled)}`);
const cancelRead = await sink(cancelled.value.body, () => live.csv, CANCEL_AT);
await settle(() => live.csv.bodyReturns >= 1 && live.csv.cursorReturns >= 1 && releases.identity === 3);
await new Promise((r) => setTimeout(r, 50)); // any late pull would land here
const cancelSummary = { consumed: cancelRead.consumed, pulls: live.csv.pulls, pullsAfterCancel: live.csv.pullsAfterCancel, cursorReturns: live.csv.cursorReturns, bodyReturns: live.csv.bodyReturns, releases: { ...releases } };
const nodeMs = Date.now() - started;

// ——— the Fetch carrier, in-process: CSV whole and cancelled ———
const fetchDispatcher = server();
const fetchHandler = toFetchHandler(fetchDispatcher);
const fetchClient = typedHttpClient(openHttpClient(contract, { baseUrl: 'http://contract.local', fetch: (url, init) => fetchHandler(new Request(url, init)) }), pen);
const fetchStarted = Date.now();
const fcsv = await fetchClient.bytes('rows.csv', null);
if (!fcsv.ok) throw new Error(`fetch csv failed: ${JSON.stringify(fcsv)}`);
const fetchRead = await sink(fcsv.value.body, () => live.csv, null);
await settle(() => releases.identity === 4);
const fetchSummary = { ...fetchRead, ...live.csv, bytes: live.csv.encoded, releases: { ...releases } };
const fcancel = await fetchClient.bytes('rows.csv', null);
if (!fcancel.ok) throw new Error(`fetch cancel run failed: ${JSON.stringify(fcancel)}`);
const fetchCancelRead = await sink(fcancel.value.body, () => live.csv, CANCEL_AT);
await settle(() => live.csv.bodyReturns >= 1 && live.csv.cursorReturns >= 1 && releases.identity === 5);
await new Promise((r) => setTimeout(r, 50));
const fetchCancelSummary = { consumed: fetchCancelRead.consumed, pulls: live.csv.pulls, pullsAfterCancel: live.csv.pullsAfterCancel, cursorReturns: live.csv.cursorReturns, bodyReturns: live.csv.bodyReturns, releases: { ...releases } };
const fetchMs = Date.now() - fetchStarted;

client.close();
fetchClient.close();
nodeServer.closeAllConnections();
nodeServer.close();
await store.close();
rmSync(dir, { recursive: true, force: true });
process.stdout.write(`${JSON.stringify({
  total: TOTAL, rows: ROWS, payload: PAYLOAD, page: PAGE, cancelAt: CANCEL_AT,
  node: { csv: csvSummary, josl: joslSummary, cancel: cancelSummary, ms: nodeMs },
  fetch: { csv: fetchSummary, cancel: fetchCancelSummary, ms: fetchMs },
  peakRss,
})}\n`);
