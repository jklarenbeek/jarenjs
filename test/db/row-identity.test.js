//@ts-check
/**
 * @file A member named like SQLite's row identity. SQLite resolves a name to a
 * column of the table before it resolves it to the row, so a member named
 * `rowid`, `oid` or `_rowid_` (in any case) hides that spelling of the
 * insertion order every join, fetch and load reads the rows in. The statements
 * read the first spelling the table does not take, and a table that takes all
 * three has none: its rows are the residual's, under a name.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';

import { IDENTITY_WORLDS, onWorldHosts, checkWorld, openSqliteWorld } from './oracle/join-worlds.js';
import { liveOracle } from './oracle/replication.js';

const world = (/** @type {string} */ name) => {
  const found = IDENTITY_WORLDS.find((entry) => entry.name === name);
  assert.ok(found, name);
  return found;
};
const grouped = IDENTITY_WORLDS[0].queries[2].query;

describe('a table with a member named like the row identity', () => {
  for (const entry of IDENTITY_WORLDS) {
    it(`${entry.name}: every query plans as its world says and answers the engine`, async () => {
      await onWorldHosts(entry, async (store, host) => {
        assert.deepEqual(await checkWorld(store, entry, host), []);
      });
    });
  }

  it('the same worlds on bun:sqlite', (t) => {
    const which = spawnSync('bun', ['--version'], { encoding: 'utf8' });
    if (which.status !== 0) return t.skip('no bun binary on PATH');
    const fixture = fileURLToPath(new URL('./fixtures/join-worlds-bun.mjs', import.meta.url));
    const run = spawnSync('bun', ['run', fixture, 'identity'], { encoding: 'utf8', cwd: fileURLToPath(new URL('../..', import.meta.url)) });
    const report = JSON.parse(run.stdout.trim().split('\n').at(-1) ?? 'null');
    assert.equal(report?.runtime, 'bun', run.stderr);
    assert.deepEqual(report.failures, []);
    assert.equal(run.status, 0);
  });

  it('numbers the rows of a join by the first spelling the table does not take', async () => {
    // the member and the spelling it leaves: `rowid` and `ROWID` hide `rowid`, so `oid` stands; `_rowid_` and `oid` hide theirs
    for (const [member, spelling] of /** @type {[string, string][]} */ ([['rowid', 'oid'], ['ROWID', 'oid'], ['_rowid_', 'rowid'], ['oid', 'rowid']])) {
      const store = await openSqliteWorld(nodeDriver(), world(`a table with a member named ${member}`));
      try {
        const { sql } = await store.explain(grouped);
        assert.ok(sql.includes(`ROW_NUMBER() OVER (ORDER BY "t0"."${spelling}", "t1"."rowid") AS "_rn"`), `${member}: ${sql}`);
        const ungrouped = await store.explain({ $for: { a: '$.A[*]', b: '$.B[*]' }, $where: { $eq: ['$b.aid', '$a.id'] }, $return: '$b.id' });
        assert.ok(ungrouped.sql.endsWith(`ORDER BY "t0"."${spelling}", "t1"."rowid"`), `${member}: ${ungrouped.sql}`);
      }
      finally { await store.close(); }
    }
  });

  it('loads the rows in insertion order, whatever the member holds', async () => {
    const store = await openSqliteWorld(nodeDriver(), world('a table with a member named rowid'));
    try {
      assert.deepEqual((await store.entity('A').load({})).map((/** @type {any} */ row) => row.id), ['z', 'y', 'x']);
    }
    finally { await store.close(); }
  });

  it('a table that takes every spelling plans the engine, which strict mode refuses by name', async () => {
    const store = await openSqliteWorld(nodeDriver(), world('a table with members named rowid, oid, _rowid_'));
    try {
      const query = { $for: { a: '$.A[*]' }, $return: '$a.id' };
      const explained = await store.explain(query);
      assert.equal(explained.mode, 'set');
      assert.equal(explained.reasons[0].construct, 'identity');
      await assert.rejects(async () => store.execute(query, { strict: true }), { code: 'JD0010' });
    }
    finally { await store.close(); }
  });

  it('a live join over such a table equals a fresh run after every write', async () => {
    const entry = world('a table with a member named rowid');
    // the join is maintained only over an indexed edge: the rows come back in the order of the position each one holds
    const model = structuredClone(entry.model);
    model.entities.B.schema.properties.aid['x-entity'] = { index: true };
    const store = await openStore(model, { driver: nodeDriver(), capture: true });
    try {
      for (const [name, rows] of Object.entries(/** @type {Record<string, any[]>} */ (entry.documents))) for (const row of rows) await store.entity(name).create(row);
      const join = [{ $for: { a: '$.A[*]', b: '$.B[*]' }, $where: { $eq: ['$b.aid', '$a.id'] }, $return: { a: '$a.id', b: '$b.id' } }];
      const live = await store.live(join);
      assert.deepEqual(live.mode, { strategy: 'join', mode: 'incremental' });
      const oracle = liveOracle(live, () => store.execute(join));
      await oracle.check();
      for (const write of [
        () => store.entity('B').create({ id: 'b4', aid: 'x' }),
        () => store.entity('A').create({ id: 'w', rowid: 5 }),
        () => store.entity('B').create({ id: 'b5', aid: 'w' }),
        () => store.entity('A').update('y', { rowid: 9 }),
        () => store.entity('B').delete('b1'),
      ]) {
        await write();
        await oracle.check();
      }
      oracle.close();
      live.close();
    }
    finally { await store.close(); }
  });
});
