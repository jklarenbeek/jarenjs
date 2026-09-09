//@ts-check
/**
 * @file The host seam end to end, the composition no component order
 * proves alone: a node:sqlite store's cursor → `stringifyCsvStream` /
 * `stringifyJoslStream` → an opaque handler's byte source → the real
 * Node HTTP adapter under the host lifecycle → `typedHttpClient(…).
 * bytes()` → an incremental hash/count sink — 100 MiB of rows in a child
 * whose V8 old space is 48 MiB. Backpressure reaches the cursor: at a
 * quarter consumed the cursor has pulled a bounded prefix of the rows,
 * and queued application bytes stay bounded independently of TCP buffers. A halfway
 * cancellation reaches the byte source's `return()`, the cursor's
 * `return()`, the acquired release and the identity release exactly
 * once, with no pull after cancellation reaches the byte source. The
 * carrier half repeats through the
 * Fetch adapter. The exact figures are in the campaign record; the
 * assertions here are the bounds.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CHILD = fileURLToPath(new URL('./fixtures/host-seam-child.mjs', import.meta.url));
const TOTAL = 100 * 1024 * 1024;

describe('the host seam end to end — a fixed-heap child', () => {
  it('moves 100 MiB of rows as CSV and JOSL from a store cursor to bytes() under a 48 MiB old space; backpressure reaches the cursor; a halfway cancel releases everything once', () => {
    const child = spawnSync(process.execPath, ['--no-warnings=ExperimentalWarning', '--max-old-space-size=48', CHILD, String(TOTAL)],
      { encoding: 'utf8', maxBuffer: 1024 * 1024 });
    assert.strictEqual(child.status, 0, child.stderr);
    const out = JSON.parse(child.stdout.trim().split('\n').pop() ?? '{}');
    assert.strictEqual(out.total, TOTAL);
    assert.ok(out.rows > 20000, `${out.rows} rows`);

    for (const [carrier, run] of [['node', out.node.csv], ['node', out.node.josl], ['fetch', out.fetch.csv]]) {
      assert.ok(run.bytes >= TOTAL, `${carrier}: ${run.bytes} bytes served`);
      assert.strictEqual(run.consumed, run.bytes, `${carrier}: every byte reached the sink`);
      assert.strictEqual(run.pulls, out.rows, `${carrier}: every row pulled exactly once`);
      assert.ok(run.pullsAtQuarter !== null && run.pullsAtQuarter < out.rows,
        `${carrier}: at a quarter consumed the cursor had pulled ${run.pullsAtQuarter} of ${out.rows} rows — it did not run ahead to the end`);
      if (carrier === 'node') {
        assert.ok(run.highWaterMark > 0, 'the real writable queue was observed');
        assert.ok(run.maxProducerAhead <= run.maxChunk, 'the adapter pulls at most one unwritten chunk');
        assert.ok(run.maxApplicationQueued <= run.highWaterMark + run.maxChunk + 8192,
          `the application queued ${run.maxApplicationQueued} bytes (watermark ${run.highWaterMark}, chunk ${run.maxChunk}, HTTP framing allowance 8192)`);
      }
      else {
        // This carrier has no TCP layer: produced minus consumed is
        // entirely application data, bounded by the stream's pull queue.
        assert.ok(run.maxAhead <= 4 * run.maxChunk, `fetch queued ${run.maxAhead} bytes`);
      }
      assert.strictEqual(run.cursorReturns, 0, `${carrier}: an exhausted cursor is done, not returned`);
      assert.strictEqual(run.bodyReturns, 0, `${carrier}: an exhausted body is done, not returned`);
    }
    assert.notStrictEqual(out.node.csv.hash, out.node.josl.hash);
    assert.strictEqual(out.node.csv.hash, out.fetch.csv.hash, 'the same rows serialize to the same CSV on both carriers');

    for (const [carrier, cancel, expectedReleases] of [['node', out.node.cancel, 3], ['fetch', out.fetch.cancel, 5]]) {
      assert.ok(cancel.consumed >= out.cancelAt && cancel.consumed < TOTAL / 2, `${carrier}: cancelled halfway (${cancel.consumed} bytes)`);
      assert.strictEqual(cancel.bodyReturns, 1, `${carrier}: the byte source's return() ran once`);
      assert.strictEqual(cancel.cursorReturns, 1, `${carrier}: the cursor's return() ran once`);
      assert.strictEqual(cancel.pullsAfterCancel, 0, `${carrier}: no pull after cancellation reaches the source`);
      assert.ok(cancel.pulls < out.rows, `${carrier}: the cursor stopped at ${cancel.pulls} of ${out.rows} rows`);
      assert.deepStrictEqual(cancel.releases, { identity: expectedReleases, acquired: expectedReleases }, `${carrier}: acquired and identity released once per request`);
    }
    assert.ok(out.peakRss < 512 * 1024 * 1024, `peak RSS ${Math.round(out.peakRss / 1048576)} MiB`);
  });
});
