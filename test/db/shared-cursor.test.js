//@ts-check
/**
 * @file The cursor decorator a store reading in parallel admits its root
 * cursors through (`shareCursor`, MODEL-FORMAT §5.1), on its own: its read
 * taken on the first pull, held across the pulls and given back at the end.
 * An internal module, so this file stays out of the installed-package check.
 */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { shareCursor } from '../../packages/db/src/cursor.js';

it('a shared cursor with no owner lease to ask pulls through one read and gives it back', async () => {
  const rows = ['a', 'b'];
  let at = 0;
  const cursor = { streaming: 'row', barrier: null, get settled() { return at > rows.length; },
    next: async () => (at < rows.length ? { done: false, value: rows[at++] } : (at++, { done: true, value: undefined })),
    return: async () => ({ done: true, value: undefined }) };
  let reads = 0;
  let ended = 0;
  const share = (/** @type {any} */ fn) => {
    reads++;
    return Promise.resolve(fn((/** @type {() => any} */ next) => next())).finally(() => { ended++; });
  };
  const owners = new Set();
  const shared = shareCursor(cursor, share, undefined, 'a pull', owners);
  const seen = [];
  for await (const row of shared) seen.push(row);
  assert.deepEqual(seen, rows);
  assert.deepEqual([reads, ended, owners.size], [1, 1, 0], 'one read for the stream, given back at its end');
});
