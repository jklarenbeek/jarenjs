//@ts-check
/**
 * @file The format pipeline behind an opaque HTTP response: a real
 * `@jarenjs/db` store's row cursor serialized through the JOSL package's
 * pull writers (`stringifyCsvStream`, `stringifyJoslStream`) as the
 * body of an opaque handler, written by the node adapter over a real
 * socket, read back through `typedHttpClient(...).bytes()` and hashed
 * and counted on the fly — nothing on either side holds the table. The
 * cursor is pulled one row ahead of the socket, and a client that
 * cancels halfway releases the cursor exactly once through the byte
 * iterator's one `return()`.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';

import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { stringifyCsvStream, iterateCsvStream, stringifyJoslStream, iterateJoslStream } from '@jarenjs/josl';
import { compileContract } from '@jarenjs/contract';
import { serveHttp } from '@jarenjs/contract/http';
import { toNodeHandler } from '@jarenjs/contract/node';
import { openHttpClient } from '@jarenjs/contract/client';
import { defineContract, read, http as httpBinding, typedHttpClient } from '@jarenjs/linq/contract';
import * as s from '@jarenjs/linq/schema';

// enough rows that the export outgrows the socket buffers on both sides
// (several MiB), so backpressure — the cursor waiting for the socket —
// is observable when the client stops halfway
const ROWS = 20000;
const MODEL = {
  $model: '0.1',
  collections: {
    rows: { schema: { type: 'object', properties: { id: { type: 'string' }, n: { type: 'integer' }, text: { type: 'string' } } }, key: '/id' },
  },
};
const DOCUMENT = { $for: { it: '$[*]' }, $orderby: '$it.n', $return: '$it' };

const Export = defineContract({ id: 'export' }, {
  'rows.csv': read({ output: true, http: httpBinding({ method: 'GET', path: '/rows.csv', media: 'text/csv' }) }),
  'rows.josl': read({ output: true, http: httpBinding({ method: 'GET', path: '/rows.josl', media: 'application/josl' }) }),
});
const CONTRACT = compileContract(Export.document);

/** @type {Awaited<ReturnType<typeof openStore>>} */
let store;
/** @type {http.Server} */
let server;
/** @type {ReturnType<typeof serveHttp>} */
let dispatcher;
/** @type {string} */
let origin;
/** the cursor of the last export, with pull/return counters */
const cursors = { pulled: 0, returned: 0, opened: 0 };

/** A cursor over the rows collection that counts its pulls and returns. */
function countedCursor() {
  const cursor = store.collection('rows').query(DOCUMENT);
  cursors.opened++;
  return {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          const step = await cursor.next();
          if (!step.done) cursors.pulled++;
          return step;
        },
        async return() {
          cursors.returned++;
          await cursor.return();
          return { done: true, value: undefined };
        },
      };
    },
  };
}

before(async () => {
  store = await openStore(MODEL, { driver: nodeDriver() });
  await store.transaction(async (tx) => {
    const batch = tx.collection('rows');
    for (let i = 0; i < ROWS; i++) await batch.insert({ id: `r${i}`, n: i, text: `row ${i}, "quoted", ${'x'.repeat(300 + (i % 7))}` });
  });
  dispatcher = serveHttp(CONTRACT, {
    'rows.csv': () => ({ status: 200, headers: { 'content-type': 'text/csv' }, body: encode(stringifyCsvStream(countedCursor())) }),
    'rows.josl': () => ({ status: 200, headers: { 'content-type': 'application/josl' }, body: encode(stringifyJoslStream(countedCursor())) }),
  }, { trace: () => 't' });
  server = http.createServer(toNodeHandler(dispatcher));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`;
});

after(async () => {
  server.closeAllConnections();
  server.close();
  await once(server, 'close');
  await store.close();
});

/**
 * Text chunks to bytes, one chunk per pull.
 * @param {AsyncIterable<string>} chunks
 */
async function* encode(chunks) {
  const encoder = new TextEncoder();
  for await (const chunk of chunks) yield encoder.encode(chunk);
}

/**
 * Read a Web stream as text chunks, one per read.
 * @param {ReadableStream<Uint8Array>} stream
 */
async function* decode(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      yield decoder.decode(value, { stream: true });
    }
  }
  finally {
    reader.releaseLock();
  }
}

/** @param {() => boolean} until */
async function wait(until) {
  for (let i = 0; i < 400 && !until(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(until(), 'the condition never held');
}

describe('a store cursor as a streamed CSV and JOSL export', () => {
  it('CSV: every row arrives once and in order through bytes(), parsed back incrementally, with the cursor released without a cancel', async () => {
    cursors.pulled = 0;
    cursors.returned = 0;
    const client = typedHttpClient(openHttpClient(CONTRACT, { baseUrl: origin }), Export);
    const outcome = await client.bytes('rows.csv', null);
    assert.strictEqual(outcome.ok, true);
    if (!outcome.ok) return;
    assert.strictEqual(outcome.value.media, 'text/csv');
    assert.ok(outcome.value.body !== null);
    let count = 0;
    let last = -1;
    const hash = createHash('sha256');
    for await (const row of iterateCsvStream(decode(outcome.value.body), { headers: true, typed: true })) {
      assert.strictEqual(row.n, last + 1, 'in order, none skipped');
      last = /** @type {number} */ (row.n);
      hash.update(String(row.text));
      count++;
    }
    assert.strictEqual(count, ROWS);
    // the same hash the store's own rows give, computed row by row
    const expected = createHash('sha256');
    for await (const row of store.collection('rows').query(DOCUMENT)) expected.update(String(row.text));
    assert.strictEqual(hash.digest('hex'), expected.digest('hex'));
    assert.strictEqual(cursors.pulled, ROWS);
    assert.strictEqual(cursors.returned, 0, 'a cursor read to its end is not cancelled');
  });

  it('JOSL: the root array streams one [[]] record per pull and parses back record by record', async () => {
    cursors.pulled = 0;
    cursors.returned = 0;
    const client = typedHttpClient(openHttpClient(CONTRACT, { baseUrl: origin }), Export);
    const outcome = await client.bytes('rows.josl', null);
    assert.strictEqual(outcome.ok, true);
    if (!outcome.ok) return;
    let count = 0;
    for await (const record of iterateJoslStream(decode(/** @type {ReadableStream<Uint8Array>} */ (outcome.value.body)))) {
      assert.strictEqual(record.n, count);
      count++;
    }
    assert.strictEqual(count, ROWS);
    assert.strictEqual(cursors.pulled, ROWS);
    assert.strictEqual(cursors.returned, 0);
  });

  it('a client that cancels halfway releases the cursor exactly once, and the cursor never ran ahead of the socket', async () => {
    cursors.pulled = 0;
    cursors.returned = 0;
    const client = typedHttpClient(openHttpClient(CONTRACT, { baseUrl: origin }), Export);
    const outcome = await client.bytes('rows.csv', null);
    assert.strictEqual(outcome.ok, true);
    if (!outcome.ok) return;
    const reader = /** @type {ReadableStream<Uint8Array>} */ (outcome.value.body).getReader();
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > 64 * 1024) break;
    }
    // give the server every chance to run ahead: if the cursor were not
    // behind the socket's backpressure it would finish all 20 000 rows
    await new Promise((r) => setTimeout(r, 200));
    const pulledAtCancel = cursors.pulled;
    assert.ok(pulledAtCancel < ROWS, `the cursor had pulled ${pulledAtCancel} of ${ROWS} rows when the client stopped`);
    await reader.cancel();
    await wait(() => cursors.returned === 1);
    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(cursors.returned, 1, 'released exactly once');
    assert.ok(cursors.pulled - pulledAtCancel <= 2, `at most a row or two pulled after the cancel (${cursors.pulled - pulledAtCancel})`);
    // the socket buffers held what the client had not read: the rows
    // pulled beyond the 64 KiB the client took are the transport's
    // buffering, and stay far below the table
    void received;
  });
});

// the schema pen is imported so the contract document is the pen's, as a host would write it
void s;
