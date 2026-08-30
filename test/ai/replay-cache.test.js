//@ts-check
/**
 * @file The live tiers' file-backed replay store: a round trip, the
 * `fresh` mode that remembers without answering, persistence across
 * adapters over one directory, and the key check that turns a hash
 * collision into a miss.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createEmbeddingClient } from '@jarenjs/ai';

import { createFileReplayCache } from '../../benchmark/lib/replay-cache.js';

/** @param {(dir: string) => void | Promise<void>} run */
async function inTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), 'replay-cache-'));
  try {
    await run(join(dir, 'replay'));
  }
  finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('benchmark — the file replay cache', function () {
  it('round-trips a value, keeps the key beside it, and counts its files', async function () {
    await inTempDir((dir) => {
      const cache = createFileReplayCache(dir);
      assert.strictEqual(cache.size(), 0, 'nothing before the first set, and no directory either');
      assert.strictEqual(cache.get('k'), undefined);
      cache.set('k', { vector: [1, 2.5, -3], ms: 12 });
      assert.deepStrictEqual(cache.get('k'), { vector: [1, 2.5, -3], ms: 12 });
      assert.strictEqual(cache.size(), 1);
      const [file] = readdirSync(dir);
      const stored = JSON.parse(readFileSync(join(dir, file), 'utf8'));
      assert.strictEqual(stored.key, 'k');
      assert.ok(/^[0-9a-f]{64}\.json$/.test(file), 'the file is named by the sha256 of the key');
    });
  });

  it('fresh answers nothing while still remembering what is bought', async function () {
    await inTempDir((dir) => {
      const fresh = createFileReplayCache(dir, { fresh: true });
      fresh.set('k', { value: 1 });
      assert.strictEqual(fresh.get('k'), undefined);
      assert.deepStrictEqual(createFileReplayCache(dir).get('k'), { value: 1 }, 'a plain adapter over the same directory sees what fresh bought');
    });
  });

  it('a second adapter over the same directory answers the first\'s entries', async function () {
    await inTempDir((dir) => {
      createFileReplayCache(dir).set('shared', { value: 'yes' });
      assert.deepStrictEqual(createFileReplayCache(dir).get('shared'), { value: 'yes' });
    });
  });

  it('a file whose recorded key differs is a miss, never someone else\'s answer', async function () {
    await inTempDir((dir) => {
      const cache = createFileReplayCache(dir);
      cache.set('real', { value: 'mine' });
      const [file] = readdirSync(dir);
      writeFileSync(join(dir, file), JSON.stringify({ key: 'other', value: 'theirs' }));
      assert.strictEqual(cache.get('real'), undefined);
    });
  });

  it('carries an embedding client\'s vectors across two client lifetimes', async function () {
    await inTempDir(async (dir) => {
      const calls = [];
      const make = () => createEmbeddingClient({
        provider: 'ollama', model: 'nomic-embed-text', cache: createFileReplayCache(dir),
        fetch: (url, init) => {
          const input = JSON.parse(init.body).input;
          calls.push(input);
          return Promise.resolve(new Response(JSON.stringify({
            data: input.map((text, index) => ({ index, embedding: [text.length, 0.5, -0.25] })),
          }), { status: 200 }));
        },
      });
      const [first] = await make().embed(['hello']);
      const [again] = await make().embed(['hello']);
      assert.deepStrictEqual(calls, [['hello']], 'the second client bought nothing');
      assert.deepStrictEqual(Array.from(again), Array.from(first));
      assert.ok(again instanceof Float32Array);
    });
  });
});
