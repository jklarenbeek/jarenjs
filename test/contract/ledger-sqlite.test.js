//@ts-check
/**
 * @file The durable ledger EXAMPLE of docs/CONTRACT-FORMAT.md §8.1,
 * executed: `createSqliteLedger` over `node:sqlite` (built into Node
 * ≥ 24, so the example is as dependency-free as the package) runs the
 * same ledger contract as `createMemoryLedger` — claim/commit/fail/
 * lookup, expiry, sweep, the persisted generation fence — carries
 * `serveHttp` idempotency end-to-end, and survives a process boundary
 * (a second open on the same file replays the first one's commit). The
 * listing between the markers is the documentation, verbatim; the last
 * test pins the decision that the package EXPORTS no sqlite ledger —
 * the interface is the product, this is a host's ~60 lines.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { compileContract } from '@jarenjs/contract';
import { serveHttp } from '@jarenjs/contract/http';
import { jsonReq, json, load, shopHandlers } from './helpers.js';
import { ledgerContract, CLAIM, RESPONSE } from './ledger-contract.js';

// —— the example (docs/CONTRACT-FORMAT.md §8.1) ——
import { DatabaseSync } from 'node:sqlite';
import { ledgerId } from '@jarenjs/contract/ledger';

/** A durable Ledger over one SQLite file — a host's example, not an export. */
export function createSqliteLedger(path, { ttlMs = 86_400_000, now: clock = Date.now } = {}) {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS ledger (
      id TEXT PRIMARY KEY, generation TEXT NOT NULL, op TEXT NOT NULL, scope TEXT NOT NULL, key TEXT NOT NULL,
      hash TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('started', 'committed', 'failed')),
      response TEXT, retryable INTEGER,
      createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, expiresAt INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS ledger_by_expires ON ledger (expiresAt);
    CREATE INDEX IF NOT EXISTS ledger_by_status ON ledger (status);`);
  const one = db.prepare('SELECT * FROM ledger WHERE id = ?');
  const put = db.prepare("INSERT INTO ledger (id, generation, op, scope, key, hash, status, createdAt, updatedAt, expiresAt) VALUES (?, ?, ?, ?, ?, ?, 'started', ?, ?, ?)");
  const drop = db.prepare('DELETE FROM ledger WHERE id = ?');
  // the fence: a settlement names the id AND the generation of the claim
  // that started the record, so a ref of an earlier claim matches no row
  const settle = db.prepare("UPDATE ledger SET status = ?, response = ?, retryable = ?, updatedAt = ? WHERE id = ? AND generation = ? AND status = 'started'");
  const reap = db.prepare('DELETE FROM ledger WHERE expiresAt <= ?');
  const stored = (/** @type {any} */ row) => (row.response === null ? null : JSON.parse(row.response));
  const at = (/** @type {number | undefined} */ now) => (typeof now === 'number' ? now : clock());
  const settled = (/** @type {any} */ ref, /** @type {any} */ changes) => {
    if (changes !== 1) throw Object.assign(new Error(`ledger: ${ref?.id ?? 'a foreign ref'} settles no started record`), { code: 'JC1011' });
  };
  return {
    claim({ op, scope, key, hash, now }) {
      const id = ledgerId(op, scope, key);
      db.exec('BEGIN IMMEDIATE'); // one writer: two processes cannot both claim the key
      try {
        const row = /** @type {any} */ (one.get(id));
        if (row !== undefined) {
          if (row.expiresAt <= at(now)) drop.run(id);
          else if (row.hash !== hash) { db.exec('COMMIT'); return { state: 'mismatch' }; }
          else if (row.status === 'started') { db.exec('COMMIT'); return { state: 'in-progress' }; }
          else if (row.status === 'committed') { db.exec('COMMIT'); return { state: 'replay', response: stored(row) }; }
          else if (row.retryable !== 1 && row.response !== null) { db.exec('COMMIT'); return { state: 'replay', response: stored(row) }; }
          else drop.run(id); // a retryable failure: the key runs again
        }
        const generation = crypto.randomUUID();
        put.run(id, generation, op, scope, key, hash, at(now), at(now), at(now) + ttlMs);
        db.exec('COMMIT');
        return { state: 'new', ref: { id, generation } };
      }
      catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
    commit(ref, response, now) {
      settled(ref, settle.run('committed', JSON.stringify(response), null, at(now), /** @type {any} */ (ref)?.id ?? '', /** @type {any} */ (ref)?.generation ?? '').changes);
    },
    fail(ref, retryable, response, now) {
      settled(ref, settle.run('failed', response === undefined ? null : JSON.stringify(response), retryable === true ? 1 : 0, at(now), /** @type {any} */ (ref)?.id ?? '', /** @type {any} */ (ref)?.generation ?? '').changes);
    },
    lookup({ op, scope, key, now }) {
      const row = /** @type {any} */ (one.get(ledgerId(op, scope, key)));
      if (row === undefined) return null;
      if (row.expiresAt <= at(now)) {
        drop.run(row.id);
        return null;
      }
      return { ...row, response: stored(row), retryable: row.retryable === null ? null : row.retryable === 1 }; // exactly LedgerRecord (§8)
    },
    sweep: (/** @type {number | undefined} */ now) => Number(reap.run(at(now)).changes),
    close: () => db.close(),
  };
}
// —— end of the example ——

const dir = mkdtempSync(join(tmpdir(), 'jaren-ledger-'));
after(() => rmSync(dir, { recursive: true, force: true }));

let n = 0;
ledgerContract('the §8.1 sqlite ledger', (options) => {
  const ledger = createSqliteLedger(join(dir, `contract-${n++}.db`), options);
  return { ledger, staleCode: 'JC1011', close: () => ledger.close() };
});

describe('the §8.1 sqlite ledger — durable, and carried by serveHttp', () => {
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

  it('durability: a second open on the same file replays the first process\'s commit and keeps its generation', () => {
    const file = join(dir, 'durable.db');
    const first = createSqliteLedger(file);
    const claim = /** @type {any} */ (first.claim({ ...CLAIM, now: 1000 }));
    first.commit(claim.ref, RESPONSE, 1000);
    first.close();
    const second = createSqliteLedger(file); // "the restart"
    assert.deepStrictEqual(second.claim({ ...CLAIM, now: 2000 }), { state: 'replay', response: RESPONSE });
    assert.strictEqual(/** @type {any} */ (second.lookup({ ...CLAIM, now: 2000 })).generation, claim.ref.generation);
    second.close();
  });

  it('the listing in CONTRACT-FORMAT.md §8.1 is this file\'s example, verbatim', () => {
    const source = readFileSync(new URL('./ledger-sqlite.test.js', import.meta.url), 'utf8');
    const own = source.slice(source.indexOf("import { DatabaseSync } from 'node:sqlite';"), source.indexOf('// —— end of the example ——')).trimEnd();
    const doc = readFileSync(new URL('../../packages/contract/docs/CONTRACT-FORMAT.md', import.meta.url), 'utf8');
    const start = doc.indexOf("import { DatabaseSync } from 'node:sqlite';");
    const listing = doc.slice(start, doc.indexOf('\n```', start)).trimEnd();
    // the documentation drops the type annotations the test file carries under //@ts-check
    const bare = (/** @type {string} */ text) => text.replace(/\/\*\* @type \{[^}]*\} \*\/ /g, '').replace(/\(\/\*\* @type \{[^}]*\} \*\/ \(([^)]*)\)\)/g, '($1)');
    assert.strictEqual(bare(own), listing);
  });

  it('the package exports no sqlite ledger — the interface is the product, the example is the host\'s', async () => {
    const ledgerModule = await import('@jarenjs/contract/ledger');
    assert.strictEqual('createSqliteLedger' in ledgerModule, false);
    const pkg = JSON.parse(readFileSync(new URL('../../packages/contract/package.json', import.meta.url), 'utf8'));
    assert.strictEqual(JSON.stringify(pkg.exports).includes('sqlite'), false);
    assert.strictEqual(pkg.dependencies['node:sqlite'], undefined);
  });
});
