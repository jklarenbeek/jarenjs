//@ts-check
/**
 * @file The durable ledger EXAMPLE of docs/CONTRACT-FORMAT.md §8.1,
 * executed: `createSqliteLedger` over `node:sqlite` (built into Node
 * ≥ 24, so the example is as dependency-free as the package) mirrors
 * `createMemoryLedger`'s semantics exactly — claim/commit/fail/lookup,
 * expiry, sweep, the stale-ref identity — carries `serveHttp`
 * idempotency end-to-end, and survives a process boundary (a second
 * open on the same file replays the first one's commit). The listing
 * between the markers is the documentation, verbatim; the last test
 * pins the decision that the package EXPORTS no sqlite ledger — the
 * interface is the product, this is a host's ~60 lines.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { compileContract } from '@jarenjs/contract';
import { serveHttp } from '@jarenjs/contract/http';
import { jsonReq, json, load, shopHandlers } from './helpers.js';

// —— the example (docs/CONTRACT-FORMAT.md §8.1) ——
import { DatabaseSync } from 'node:sqlite';

/** A durable Ledger over one SQLite file — a host's example, not an export. */
export function createSqliteLedger(path, { ttlMs = 86_400_000, now: clock = Date.now } = {}) {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS ledger (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE, op TEXT NOT NULL, scope TEXT NOT NULL, key TEXT NOT NULL,
      hash TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('started', 'committed', 'failed')),
      response TEXT, retryable INTEGER,
      createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, expiresAt INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS ledger_by_expires ON ledger (expiresAt);
    CREATE INDEX IF NOT EXISTS ledger_by_status ON ledger (status);`);
  const one = db.prepare('SELECT * FROM ledger WHERE id = ?');
  const put = db.prepare("INSERT INTO ledger (id, op, scope, key, hash, status, createdAt, updatedAt, expiresAt) VALUES (?, ?, ?, ?, ?, 'started', ?, ?, ?)");
  const drop = db.prepare('DELETE FROM ledger WHERE id = ?');
  // the ref is the AUTOINCREMENT seq of one specific insert — never
  // reused (a bare rowid WOULD be), so a settle can never touch a record
  // a later claim re-created: the memory ledger's object-identity guard,
  // spelled in SQL
  const settle = db.prepare("UPDATE ledger SET status = ?, response = ?, retryable = ?, updatedAt = ? WHERE seq = ? AND status = 'started'");
  const reap = db.prepare('DELETE FROM ledger WHERE expiresAt <= ?');
  const stored = (/** @type {any} */ row) => (row.response === null ? null : JSON.parse(row.response));
  return {
    claim({ op, scope, key, hash, now }) {
      const at = typeof now === 'number' ? now : clock();
      const id = `${op}|${scope}|${key}`;
      db.exec('BEGIN IMMEDIATE'); // one writer: two processes cannot both claim the key
      try {
        const row = /** @type {any} */ (one.get(id));
        if (row !== undefined) {
          if (row.expiresAt <= at) drop.run(id);
          else if (row.hash !== hash) { db.exec('COMMIT'); return { state: 'mismatch' }; }
          else if (row.status === 'started') { db.exec('COMMIT'); return { state: 'in-progress' }; }
          else if (row.status === 'committed') { db.exec('COMMIT'); return { state: 'replay', response: stored(row) }; }
          else if (row.retryable !== 1 && row.response !== null) { db.exec('COMMIT'); return { state: 'replay', response: stored(row) }; }
          else drop.run(id); // a retryable failure: the key runs again
        }
        const ref = { seq: put.run(id, op, scope, key, hash, at, at, at + ttlMs).lastInsertRowid };
        db.exec('COMMIT');
        return { state: 'new', ref };
      }
      catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
    commit(ref, response) {
      settle.run('committed', JSON.stringify(response), null, clock(), /** @type {any} */ (ref).seq);
    },
    fail(ref, retryable, response) {
      settle.run('failed', response === undefined ? null : JSON.stringify(response), retryable === true ? 1 : 0, clock(), /** @type {any} */ (ref).seq);
    },
    lookup({ op, scope, key }) {
      const row = /** @type {any} */ (one.get(`${op}|${scope}|${key}`));
      if (row === undefined) return null;
      if (row.expiresAt <= clock()) {
        drop.run(row.id);
        return null;
      }
      const record = { ...row, response: stored(row), retryable: row.retryable === null ? null : row.retryable === 1 };
      delete record.seq; // the record shape is exactly LedgerRecord (§8)
      return record;
    },
    sweep: () => Number(reap.run(clock()).changes),
    close: () => db.close(),
  };
}
// —— end of the example ——

const dir = mkdtempSync(join(tmpdir(), 'jaren-ledger-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const CLAIM = { op: 'product.save', scope: '', key: 'k1', hash: 'a'.repeat(64) };
const RESPONSE = { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' }, body: '{"id":1}' };

describe('the §8.1 sqlite ledger — the memory ledger contract, durable', () => {
  it('claim → commit → replay verbatim; mismatch; in-progress; retryable re-runs; non-retryable replays the stored failure', () => {
    const ledger = createSqliteLedger(join(dir, 'contract.db'), { now: () => 1000 });
    const first = /** @type {any} */ (ledger.claim({ ...CLAIM, now: 1000 }));
    assert.strictEqual(first.state, 'new');
    // in-progress while started; mismatch beats it on a different hash
    assert.deepStrictEqual(ledger.claim({ ...CLAIM, now: 1001 }), { state: 'in-progress' });
    assert.deepStrictEqual(ledger.claim({ ...CLAIM, hash: 'b'.repeat(64), now: 1001 }), { state: 'mismatch' });
    ledger.commit(first.ref, RESPONSE);
    assert.deepStrictEqual(ledger.claim({ ...CLAIM, now: 1002 }), { state: 'replay', response: RESPONSE });
    const record = /** @type {any} */ (ledger.lookup(CLAIM));
    assert.strictEqual(record.status, 'committed');
    assert.strictEqual(record.retryable, null);
    assert.deepStrictEqual(record.response, RESPONSE);
    // a retryable failure hands the key back; a non-retryable one replays
    const again = /** @type {any} */ (ledger.claim({ ...CLAIM, key: 'k2', now: 1000 }));
    ledger.fail(again.ref, true, undefined);
    assert.strictEqual(/** @type {any} */ (ledger.claim({ ...CLAIM, key: 'k2', now: 1001 })).state, 'new');
    const third = /** @type {any} */ (ledger.claim({ ...CLAIM, key: 'k3', now: 1000 }));
    const failure = { status: 412, headers: {}, body: '{"code":"JC2014"}' };
    ledger.fail(third.ref, false, failure);
    assert.deepStrictEqual(ledger.claim({ ...CLAIM, key: 'k3', now: 1001 }), { state: 'replay', response: failure });
    ledger.close();
  });

  it('expiry on claim and lookup; sweep() drops the rest', () => {
    let at = 1000;
    const ledger = createSqliteLedger(join(dir, 'expiry.db'), { ttlMs: 50, now: () => at });
    const a = /** @type {any} */ (ledger.claim({ ...CLAIM, now: 1000 }));
    ledger.commit(a.ref, RESPONSE);
    assert.notStrictEqual(ledger.lookup(CLAIM), null);
    at = 1051; // past expiresAt: the key is new again, the record gone on lookup
    assert.strictEqual(/** @type {any} */ (ledger.claim({ ...CLAIM, key: 'other', now: 1051 })).state, 'new');
    assert.strictEqual(ledger.lookup(CLAIM), null);
    at = 1200;
    assert.strictEqual(ledger.sweep(), 1, 'the surviving claim of "other" expired too');
    ledger.close();
  });

  it('a stale ref cannot settle over a re-claimed record (the rowid identity)', () => {
    const ledger = createSqliteLedger(join(dir, 'stale.db'));
    const first = /** @type {any} */ (ledger.claim({ ...CLAIM, now: 1000 }));
    ledger.fail(first.ref, true, undefined); // released: the key may re-run
    const second = /** @type {any} */ (ledger.claim({ ...CLAIM, now: 1001 }));
    assert.strictEqual(second.state, 'new');
    ledger.commit(first.ref, { status: 200, headers: {}, body: 'STALE' }); // the dead ref
    assert.deepStrictEqual(ledger.claim({ ...CLAIM, now: 1002 }), { state: 'in-progress' }, 'the re-claim is untouched');
    ledger.commit(second.ref, RESPONSE);
    assert.deepStrictEqual(ledger.claim({ ...CLAIM, now: 1003 }), { state: 'replay', response: RESPONSE });
    ledger.close();
  });

  it('serveHttp carries idempotency over it end-to-end: the duplicate replays, the handler ran once', async () => {
    const shop = compileContract(load('./fixtures/shop.contract.json'));
    const ledger = createSqliteLedger(join(dir, 'serve.db'));
    let calls = 0;
    const server = serveHttp(shop, { ...shopHandlers(), 'product.save': () => { calls += 1; return { id: 1, name: `call-${calls}`, price: 1 }; } }, { ledger });
    const SAVE = { revision: 1, product: { id: 1, name: 'x', price: 1 } };
    const a = await server.dispatch(jsonReq('PUT', '/api/products/1/master', SAVE, { 'idempotency-key': 'e2e' }));
    const b = await server.dispatch(jsonReq('PUT', '/api/products/1/master', SAVE, { 'idempotency-key': 'e2e' }));
    assert.strictEqual(a.status, 200);
    assert.strictEqual(b.status, 200);
    assert.strictEqual(b.headers['idempotent-replayed'], 'true');
    assert.deepStrictEqual(json(b), { id: 1, name: 'call-1', price: 1 });
    assert.strictEqual(calls, 1);
    ledger.close();
  });

  it('durability: a second open on the same file replays the first process\'s commit', () => {
    const file = join(dir, 'durable.db');
    const first = createSqliteLedger(file);
    const claim = /** @type {any} */ (first.claim({ ...CLAIM, now: 1000 }));
    first.commit(claim.ref, RESPONSE);
    first.close();
    const second = createSqliteLedger(file); // "the restart"
    assert.deepStrictEqual(second.claim({ ...CLAIM, now: 2000 }), { state: 'replay', response: RESPONSE });
    second.close();
  });

  it('the package exports no sqlite ledger — the interface is the product, the example is the host\'s', async () => {
    const ledgerModule = await import('@jarenjs/contract/ledger');
    assert.strictEqual('createSqliteLedger' in ledgerModule, false);
    const pkg = JSON.parse(readFileSync(new URL('../../packages/contract/package.json', import.meta.url), 'utf8'));
    assert.strictEqual(JSON.stringify(pkg.exports).includes('sqlite'), false);
    assert.strictEqual(pkg.dependencies['node:sqlite'], undefined);
  });
});
