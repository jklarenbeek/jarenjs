#!/usr/bin/env node
//@ts-check
/**
 * Exact migration receipt costs on a borrowed native SQLite connection.
 * Run both runtimes, retaining every sample:
 *   node --no-warnings=ExperimentalWarning benchmark/migration-identity.js --write
 *   bun benchmark/migration-identity.js --write
 * The legacy-shaped document projection measures serialization only. It never
 * executes a legacy artifact or grants migration authority.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { cpus, loadavg } from 'node:os';
import { migrate, migrationHistory, migrationStatus } from '@jarenjs/db';
import { defineMigration } from '@jarenjs/linq/migration';

for (const arg of process.argv.slice(2)) assert.equal(arg, '--write', 'unknown argument');
const runtime = process.versions.bun ? 'bun' : 'node';
const driver = runtime === 'bun' ? (await import('@jarenjs/db/bun')).bunDriver()
  : (await import('@jarenjs/db/node')).nodeDriver();
const model = { $model: '0.1', collections: {} };
const links = 10, calls = 500, rounds = 5;
const documents = Array.from({ length: links }, (_, i) =>
  defineMigration({ id: `link-${i}`, from: model, to: model }).sql(`INSERT INTO witness VALUES (${i})`).document);
const legacyProjection = documents.map(document => {
  const legacy = { ...document, $migration: '0.1' };
  delete legacy.identity;
  return legacy;
});
const bytes = value => Buffer.byteLength(JSON.stringify(value));
const samples = [];
let storage, sqlite;

for (let round = 0; round < rounds; round++) {
  const connection = await driver.open(':memory:');
  /** Read and release one native statement, outside the measured API loop. */
  const all = sql => {
    const statement = connection.prepare(sql);
    try { return statement.all([]); }
    finally { statement.finalize?.(); }
  };
  const databaseBytes = () => all('PRAGMA page_count')[0].page_count * all('PRAGMA page_size')[0].page_size;
  try {
    connection.exec('CREATE TABLE witness (n INTEGER)');
    sqlite = all('SELECT sqlite_version() AS version')[0].version;
    const beforeBytes = databaseBytes();
    const started = performance.now();
    const applied = migrate({ connection }, documents, { baseline: model, shadow: false });
    const applyMs = performance.now() - started;
    assert.equal(applied?.then, undefined);
    assert.equal(applied.applied.length, links);
    const history = migrationHistory({ connection });
    const normal = all('SELECT CAST(rowid AS TEXT) AS rowid, * FROM _jaren_migrations ORDER BY _jaren_migrations.rowid');
    const side = all('SELECT key, value FROM _jaren_migration_identity ORDER BY key');
    assert.deepEqual(normal.map(row => row.id), documents.map(document => document.id));
    assert.deepEqual(side.map(row => row.key), ['header', ...documents.map((_, i) => `receipt:${i}`)]);
    assert.equal(history.history.rows.length, links);
    const currentStorage = {
      links, currentDocumentBytes: bytes(documents), legacyProjectionBytes: bytes(legacyProjection),
      identityRows: side.length,
      identityPayloadBytes: side.reduce((sum, row) => sum + Buffer.byteLength(row.key) + Buffer.byteLength(row.value), 0),
      databaseGrowthBytes: databaseBytes() - beforeBytes,
    };
    if (storage) assert.deepEqual(currentStorage, storage);
    storage = currentStorage;
    const times = { applyMs };
    for (const name of ['status', 'repeat', 'observation']) {
      const start = performance.now();
      for (let call = 0; call < calls; call++) {
        const result = name === 'status' ? migrationStatus({ connection }, documents)
          : name === 'repeat' ? migrate({ connection }, documents, { baseline: model, shadow: false })
            : migrationHistory({ connection });
        assert.equal(result?.then, undefined);
        if (name === 'observation') assert.deepEqual(result, history);
        else {
          assert.equal(result.upToDate, true);
          if (name === 'repeat') assert.deepEqual(result.applied, []);
        }
      }
      times[`${name}Ms`] = performance.now() - start;
    }
    assert.deepEqual(all('SELECT CAST(rowid AS TEXT) AS rowid, * FROM _jaren_migrations ORDER BY _jaren_migrations.rowid'), normal);
    assert.deepEqual(all('SELECT key, value FROM _jaren_migration_identity ORDER BY key'), side);
    assert.deepEqual(all('SELECT n FROM witness ORDER BY n').map(row => row.n), Array.from({ length: links }, (_, i) => i));
    assert.equal(databaseBytes() - beforeBytes, storage.databaseGrowthBytes);
    samples.push(times);
  }
  finally { connection.close(); }
}

const sources = [
  'benchmark/migration-identity.js', 'packages/core/src/model.js', 'packages/core/src/schema.js',
  'packages/json/src/canonical.js', 'packages/linq/src/migration/define.js', 'packages/linq/src/migration/steps.js',
  'packages/db/src/migrate.js', 'packages/db/src/migration-history.js', 'packages/db/src/model.js',
  'packages/db/src/migration-target.js', 'packages/db/src/document-steps.js',
  'packages/db/src/schema-positions.js', 'packages/validate/src/schema-keywords.js',
  'packages/db/src/driver.js',
  `packages/db/src/drivers/${runtime}.js`,
];
const sourceHashes = Object.fromEntries(sources.map(file => [file,
  createHash('sha256').update(readFileSync(new URL(`../${file}`, import.meta.url))).digest('hex')]));
const report = {
  format: 'jaren-migration-identity-cost/1', measuredAt: new Date().toISOString(),
  runtime: { name: runtime, version: process.versions.bun ?? process.versions.node,
    sqlite, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model, loadavg: loadavg() },
  sourceHashes, rounds, calls, storage, samples,
  medianMs: Object.fromEntries(Object.keys(samples[0]).map(key => [key,
    samples.map(sample => sample[key]).sort((a, b) => a - b)[Math.floor(rounds / 2)]])),
  checks: { exactRows: true, synchronousCalls: true, unchangedHistory: true, unchangedIdentity: true },
  scope: 'Ten SQL-only links on a borrowed synchronous in-memory SQLite connection; shadow replay is disabled. Each sample uses a fresh database. Timed loops include result assertions; observations compare complete receipts. All samples are retained, with medians reported. Shared-host elapsed costs are not production latency or a causal comparison with the old protocol. Legacy projection bytes compare JSON serialization only; no legacy document executes. Page growth includes both history tables and application writes, not only receipt payload.',
};
console.log(JSON.stringify(report, null, 2));
if (process.argv.includes('--write'))
  writeFileSync(new URL(`./migration-identity-${runtime}-result.json`, import.meta.url), JSON.stringify(report, null, 2) + '\n');
