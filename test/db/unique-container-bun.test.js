//@ts-check
/**
 * @file The key a unique index holds for a container on SQLite is written by
 * triggers in the file itself, so a store Bun opens over a file another
 * runtime created refuses a container equal to a stored one in another member
 * order, and writes the key node:sqlite writes. In a file of its own: a host
 * without Bun skips it by name.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';

import { tempDbPath } from './helpers.js';

describe('a container key in a file two runtimes write', () => {
  it('refuses a reordered duplicate Bun writes, and Bun writes the key node:sqlite writes', async (t) => {
    const which = spawnSync('bun', ['--version'], { encoding: 'utf8' });
    if (which.error !== undefined || which.status !== 0) return t.skip('no bun binary on PATH');
    const { dbPath, cleanup } = tempDbPath();
    try {
      const model = { $model: '0.1', collections: { c: { key: '/id',
        schema: { type: 'object', properties: { id: { type: 'string' }, q: { type: ['string', 'object', 'array'] } } },
        indexes: [{ name: 'by_q', path: '$.q', unique: true }] } } };
      const store = await openStore(model, { driver: nodeDriver(), path: dbPath });
      try {
        await store.collection('c').insert({ id: 'a', q: { x: 1, y: 2 } });
        await store.collection('c').insert({ id: 'e', q: [1, { a: 1, b: 2 }, 3] });
      }
      finally { await store.close(); }
      const fixture = fileURLToPath(new URL('./fixtures/unique-container-bun.mjs', import.meta.url));
      const run = spawnSync('bun', ['run', fixture, dbPath], { encoding: 'utf8', timeout: 60000,
        cwd: fileURLToPath(new URL('../..', import.meta.url)) });
      const report = JSON.parse(run.stdout.trim().split('\n').at(-1) ?? 'null');
      assert.equal(report?.runtime, 'bun', run.stderr);
      assert.equal(run.status, 0, run.stderr);
      assert.deepEqual(report.answers, ['JD2005', 'stored', 'stored']);
      assert.deepEqual(report.keys, [
        ['a', `'$."q"' object,'$."q".x' 1.0,'$."q".y' 2.0`],
        ['c', `'$."q"' array,'$."q"[0]' 1.0,'$."q"[1]' object,'$."q"[1].a' 1.0,'$."q"[1].b' 2.0`],
        ['d', `'$."q"' object,'$."q".x' 1.0,'$."q".y' 3.0`],
        ['e', `'$."q"' array,'$."q"[0]' 1.0,'$."q"[1]' object,'$."q"[1].a' 1.0,'$."q"[1].b' 2.0,'$."q"[2]' 3.0`],
      ]);
    }
    finally { cleanup(); }
  });
});
