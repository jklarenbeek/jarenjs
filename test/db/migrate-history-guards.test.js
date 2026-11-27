//@ts-check
/**
 * @file The history guards of a chain of links: a link checks the history
 * and identity rows it reads against the ones the run last attested, so a
 * step that edits an earlier row, a trigger that rewrites a receipt as it is
 * written, and a second connection that edits the history between two links
 * are each refused `JD0022`, while an untouched chain records one history row
 * and one receipt per link.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';

import { openStore, planModelMigration, migrate, sqliteDialect } from '@jarenjs/db';
import { adaptNodeDatabase } from '@jarenjs/db/node';
import { tempDbPath } from './helpers.js';

const MODEL = { $model: '0.1', collections: { c: { identity: 'integer', schema: { type: 'object' } } } };
const RUNTIME = { now: () => 1700000000000 };
const CHANGED = 'JD0022: a migration changed its existing history or identity metadata';
const ACQUIRED = 'JD0022: migration history changed while acquiring its writer; no step ran';

/** A chain of `n` unchanged-model links; link `at` also runs `sql`.
 * @param {number} n @param {number} [at] @param {string} [sql] */
const chainOf = (n, at = -1, sql = '') => Array.from({ length: n }, (_, k) => {
  const link = planModelMigration(MODEL, MODEL, { dialect: sqliteDialect, id: `m${k}` }).migration;
  return k === at ? { ...link, steps: [...link.steps, { kind: 'sql', sql }] } : link;
});

/** A node:sqlite driver that calls `onBegin` before each transaction begins.
 * @param {(() => void) | null} onBegin */
const driver = (onBegin = null) => ({
  name: 'node-sqlite', dialect: sqliteDialect,
  open: (/** @type {string} */ file, /** @type {any} */ options) => {
    const db = new DatabaseSync(file, options?.timeout === undefined ? {} : { timeout: options.timeout });
    const begin = (/** @type {string} */ sql) => { if (/^\s*BEGIN/i.test(sql)) onBegin?.(); };
    return adaptNodeDatabase({
      exec: (/** @type {string} */ sql) => { begin(sql); return db.exec(sql); },
      prepare: (/** @type {string} */ sql) => { begin(sql); return db.prepare(sql); },
      function: (/** @type {string} */ name, /** @type {any} */ o, /** @type {any} */ fn) => db.function(name, o, fn),
      aggregate: (/** @type {string} */ name, /** @type {any} */ spec) => db.aggregate(name, spec),
      createSession: (/** @type {any} */ o) => (o === undefined ? db.createSession() : db.createSession(o)),
      close: () => db.close(),
    });
  },
});

/** Run a chain on a fresh store; answer the refusal's message (or the
 * applied ids) and the history ids and identity keys it left.
 * @param {any[]} links @param {{ atomic: boolean, onBegin?: (path: string) => (() => void) }} options */
async function run(links, { atomic, onBegin }) {
  const { dbPath, cleanup } = tempDbPath();
  try {
    await (await openStore(MODEL, { driver: driver(), path: dbPath })).close();
    let outcome;
    try {
      const result = await migrate({ driver: driver(onBegin?.(dbPath) ?? null), path: dbPath }, links,
        { baseline: MODEL, model: MODEL, shadow: false, runtime: RUNTIME, atomic });
      outcome = result.applied;
    }
    catch (error) { outcome = /** @type {any} */ (error).message; }
    const db = new DatabaseSync(dbPath);
    const read = (/** @type {string} */ sql) => { try { return db.prepare(sql).all().map((row) => Object.values(row).join('|')); } catch { return null; } };
    const left = { history: read('SELECT id, checksum FROM _jaren_migrations ORDER BY rowid'),
      identity: read('SELECT key FROM _jaren_migration_identity ORDER BY key') };
    db.close();
    return { outcome, ...left };
  }
  finally { cleanup(); }
}

describe('the history guards of a chain of links', () => {
  it('an untouched chain records one history row and one receipt per link, atomic or link by link', async () => {
    for (const atomic of [true, false]) {
      const { outcome, history, identity } = await run(chainOf(4), { atomic });
      assert.deepStrictEqual(outcome, ['m0', 'm1', 'm2', 'm3'], `atomic: ${atomic}`);
      assert.deepStrictEqual(history?.map((row) => row.split('|')[0]), ['m0', 'm1', 'm2', 'm3']);
      assert.deepStrictEqual(identity, ['header', 'receipt:0', 'receipt:1', 'receipt:2', 'receipt:3']);
    }
  });

  it('a step that edits, removes or adds a history row is refused, whichever row', async () => {
    for (const sql of [
      `UPDATE _jaren_migrations SET checksum = 'edited' WHERE id = 'm0'`,
      `DELETE FROM _jaren_migrations WHERE id = 'm0'`,
      `INSERT INTO _jaren_migrations (id, applied_at, from_hash, to_hash, checksum, steps) VALUES ('x', 0, 'a', 'b', 'c', 0)`,
      `UPDATE _jaren_migration_identity SET value = value || ' ' WHERE key = 'receipt:0'`,
      `UPDATE _jaren_migration_identity SET value = value || ' ' WHERE key = 'header'`,
    ]) {
      // atomic: the whole chain rolls back
      assert.deepStrictEqual(await run(chainOf(4, 2, sql), { atomic: true }),
        { outcome: CHANGED, history: null, identity: null }, sql);
      // link by link: the links before it stand, untouched
      const each = await run(chainOf(4, 2, sql), { atomic: false });
      assert.strictEqual(each.outcome, CHANGED, sql);
      assert.deepStrictEqual(each.history?.map((row) => row.split('|')[0]), ['m0', 'm1'], sql);
      assert.deepStrictEqual(each.identity, ['header', 'receipt:0', 'receipt:1'], sql);
    }
  });

  it('a receipt rewritten as it is written is refused by the read that follows the write', async () => {
    const rewrite = (/** @type {string} */ key) => 'CREATE TEMP TRIGGER rewrite AFTER INSERT ON main._jaren_migration_identity '
      + `BEGIN UPDATE main._jaren_migration_identity SET value = value || ' ' WHERE key = ${key}; END`;
    for (const atomic of [true, false]) {
      assert.strictEqual((await run(chainOf(4, 2, rewrite('NEW.key')), { atomic })).outcome,
        'JD0022: migration identity receipt 2 is not canonical JSON text', `atomic: ${atomic}`);
      assert.strictEqual((await run(chainOf(4, 2, rewrite(`'receipt:0'`)), { atomic })).outcome,
        'JD0022: migration identity receipt 0 is not canonical JSON text', `atomic: ${atomic}`);
    }
  });

  it('a second connection that edits the history between two links is refused before the next link runs', async () => {
    for (const sql of [
      `UPDATE _jaren_migrations SET applied_at = applied_at + 1 WHERE id = 'm0'`,
      `UPDATE _jaren_migration_identity SET value = value || ' ' WHERE key = 'receipt:0'`,
      `INSERT INTO _jaren_migrations (id, applied_at, from_hash, to_hash, checksum, steps) VALUES ('x', 0, 'a', 'b', 'c', 0)`,
    ]) {
      let begins = 0;
      const onBegin = (/** @type {string} */ file) => () => {
        // the third transaction is the third link's: the first two committed
        if (++begins !== 3) return;
        const other = new DatabaseSync(file);
        try { other.exec(sql); }
        finally { other.close(); }
      };
      const { outcome, history } = await run(chainOf(4), { atomic: false, onBegin });
      assert.strictEqual(outcome, ACQUIRED, sql);
      assert.deepStrictEqual(history?.map((row) => row.split('|')[0]).filter((id) => id !== 'x'), ['m0', 'm1'], sql);
    }
  });
});
