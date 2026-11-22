//@ts-check
/**
 * @file `jaren-db plan --store` compares the store with the from-model as
 * `openStore` reads it: a physical layout (MODEL-FORMAT §12) by its shape,
 * as its open verifies it, so a table the application wrote in its own
 * spelling, which the open adopts, is not refused for its text; a table the
 * store owns by its stored CREATE text, as its open compares it. A model that
 * matches its snapshot plans nothing and reads no store.
 * `migrationStatus` reads a physical layout the same way.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { migrationStatus, openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { removeTempDirectory } from './helpers.js';

const CLI = resolve('packages/db/src/cli.js');
/** @param {string} dir @param {string[]} args */
const run = (dir, ...args) => spawnSync(process.execPath, ['--no-warnings=ExperimentalWarning', CLI, ...args],
  { encoding: 'utf8', cwd: dir, input: '', env: { ...process.env, FORCE_COLOR: '0' } });
const ITEM = { $model: '0.1', entities: { Item: { schema: { type: 'object', properties: {
  id: { type: 'integer', 'x-entity': { key: true } }, name: { type: 'string' } } },
physical: { table: 'item', columns: { id: { name: 'id', codec: 'integer', null: 'reject' }, name: { name: 'name', codec: 'text', null: 'null' } } } } } };
const OWNED = { $model: '0.1', entities: { T: { schema: { type: 'object', required: ['id'],
  properties: { id: { type: 'string', 'x-entity': { key: true } }, n: { type: 'integer' } } } } } };

/** A directory with the models written in it. @param {(dir: string) => Promise<void>} fn */
async function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'jaren-db-plan-store-'));
  try {
    writeFileSync(join(dir, 'item.json'), JSON.stringify(ITEM));
    writeFileSync(join(dir, 'owned.json'), JSON.stringify(OWNED));
    await fn(dir);
  }
  finally { removeTempDirectory(dir); }
}
/** A SQLite file holding `sql`. @param {string} file @param {string} sql */
const holding = (file, sql) => {
  const db = new DatabaseSync(file);
  try { db.exec(sql); }
  finally { db.close(); }
};

describe('jaren-db plan --store over a physical layout', () => {
  it('compares a table the application spelled its own way by its shape, as the open adopts it, and refuses one the open refuses', async () => {
    await withDir(async (dir) => {
      holding(join(dir, 'hand.db'), 'create table item (\n  id integer primary key,\n  name text\n)');
      await (await openStore(ITEM, { driver: nodeDriver(), path: join(dir, 'hand.db'), adopt: true })).close();
      const planned = run(dir, 'plan', '--from', 'item.json', '--to', 'item.json', '--store', 'hand.db');
      assert.equal(planned.status, 0, planned.stderr);
      assert.deepEqual(JSON.parse(planned.stdout).steps, []);
      // a column the layout maps that the table lacks, which the open refuses too
      holding(join(dir, 'bare.db'), 'create table item (id integer primary key)');
      await assert.rejects(openStore(ITEM, { driver: nodeDriver(), path: join(dir, 'bare.db'), adopt: true }), { code: 'JD0002' });
      const refused = run(dir, 'plan', '--from', 'item.json', '--to', 'item.json', '--store', 'bare.db');
      assert.equal(refused.status, 1);
      assert.match(refused.stderr, /^jaren-db: the store does not match the from-model \(physical 'item': /);
      // the status of a chain over it reads the layout the same way
      const status = await migrationStatus({ driver: nodeDriver(), path: join(dir, 'hand.db') }, [], { model: ITEM });
      assert.deepEqual([status.drift, status.upToDate], [null, true]);
      assert.match(String((await migrationStatus({ driver: nodeDriver(), path: join(dir, 'bare.db') }, [], { model: ITEM })).drift), /^physical 'item': /);
    });
  });
});

describe('jaren-db plan --model --snapshot --store with no model change', () => {
  it('plans nothing and reads no store: a store behind its snapshot (a written plan not applied yet) is no refusal', async () => {
    await withDir(async (dir) => {
      assert.equal(run(dir, 'snapshot', '--model', 'owned.json').status, 0);
      holding(join(dir, 'hand.db'), 'CREATE TABLE T (id text primary key, n integer, doc blob not null) strict');
      const unchanged = run(dir, 'plan', '--model', 'owned.json', '--store', 'hand.db');
      assert.deepEqual([unchanged.status, unchanged.stdout.trim()], [0, 'no change — the model matches its snapshot (model.snapshot.json); nothing to plan']);
      // a change is planned from the snapshot, which the store is compared with first
      writeFileSync(join(dir, 'owned.json'), JSON.stringify({ ...OWNED, entities: { T: { ...OWNED.entities.T, indexes: [{ name: 'by_n', path: '$.n' }] } } }));
      const drifted = run(dir, 'plan', '--model', 'owned.json', '--store', 'hand.db');
      assert.equal(drifted.status, 1);
      assert.match(drifted.stderr, /the store does not match the from-model \(table:T differs/);
      assert.equal(existsSync(join(dir, 'none.db')), false);
      assert.equal(run(dir, 'plan', '--model', 'owned.json', '--store', 'none.db').status, 1);
      assert.equal(existsSync(join(dir, 'none.db')), false);
    });
  });
});
