//@ts-check
/** Repeatable SQL coexistence and explicit-column costs against the frozen inputs. */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { nodeDriver } from '@jarenjs/db/node';
import { openStore, readSchema } from '@jarenjs/db';
import { adoptionRows } from '../scripts/lib/adoption.js';
import { readAdoption, verifyFreeze, adoptionHash, assessBudget } from '../test/adoption/evidence.js';
const manifest = readAdoption('manifest.json');
verifyFreeze(manifest);
const fixture = readAdoption('fixtures/relational.json');
const column = (name, codec, nullPolicy = 'reject') => ({ name, codec, null: nullPolicy });
const model = { $model: '0.1', entities: {
  Setting: { schema: { type: 'object', properties: {
    id: { type: 'string', 'x-entity': { key: true } }, value: { type: 'string' },
  } }, physical: { table: 'app_settings', columns: { id: column('key', 'text'), value: column('value', 'text') } } },
  Receipt: { schema: { type: 'object', properties: {
    id: { type: 'integer', 'x-entity': { key: true } }, body: { type: 'string' },
  } }, physical: { table: 'receipt', columns: { id: column('id', 'integer'), body: column('body', 'blob-hex') } } },
  Item: { schema: { type: 'object', properties: {
    id: { type: 'string', 'x-entity': { key: true } }, sku: { type: 'string' },
    quantity: { type: ['integer', 'null'] }, provenance: { type: ['string', 'null'] },
  } }, physical: { table: 'items', columns: { id: column('id', 'text'), sku: column('sku', 'text'),
    quantity: column('quantity', 'integer', 'null'), provenance: column('provenance', 'text', 'null') } } },
} };
const plain = (value) => JSON.parse(JSON.stringify(value));
const measure = async (consumer) => {
  const dir = mkdtempSync(join(tmpdir(), 'jaren-relational-bench-'));
  let store;
  const rows = adoptionRows(consumer);
  const sample = () => process.memoryUsage().heapUsed;
  let sampledHeapBytes = sample();
  try {
    const path = join(dir, 'fixture.sqlite');
    const driver = nodeDriver();
    const seed = await driver.open(path);
    for (const sql of [...fixture.ddl, ...fixture.seed]) seed.exec(sql);
    seed.exec('CREATE TABLE items(id TEXT PRIMARY KEY,sku TEXT,quantity INTEGER,provenance TEXT)');
    seed.transaction(() => {
      const insert = seed.prepare('INSERT INTO items VALUES(?,?,?,?)');
      for (const row of rows) insert.run([row.id, row.sku, row.quantity, row.provenance]);
    });
    const baseline = { statements: 0, queryMs: 0 };
    seed.exec('BEGIN');
    for (const read of fixture.reads) {
      const start = performance.now();
      assert.deepEqual(plain(seed.prepare(read.sql).all([])), read.expected);
      baseline.queryMs = Math.max(baseline.queryMs, performance.now() - start); baseline.statements++;
    }
    for (const mutation of fixture.mutations) { assert.deepEqual(plain(seed.prepare(mutation.sql).all([])), mutation.first); baseline.statements++; }
    seed.exec('ROLLBACK');
    const source = JSON.stringify(await readSchema(seed)); seed.close();
    const opening = performance.now();
    store = await openStore(model, { driver, path, adopt: true });
    const openMs = performance.now() - opening;
    const final = { statements: 0, queryMs: 0, recoveryMs: null };
    await store.transaction((tx) => {
      for (const read of fixture.reads) {
        const start = performance.now();
        assert.deepEqual(plain(tx.sql.prepare(read.sql, { access: 'read' }).all([])), read.expected);
        final.queryMs = Math.max(final.queryMs, performance.now() - start); final.statements++;
      }
      for (const mutation of fixture.mutations) {
        const statement = tx.sql.prepare(mutation.sql, { access: 'write' });
        assert.deepEqual(plain(statement.all([])), mutation.first); final.statements++;
        assert.deepEqual(statement.all([]), []);
        assert.equal(tx.sql.prepare('SELECT changes() AS n', { access: 'read' }).get([]).n, 0);
      }
    });
    const startGet = performance.now();
    assert.equal((await store.entity('Item').get(rows[0].id)).sku, '00000000');
    const pointReadMs = performance.now() - startGet;
    const startLoad = performance.now();
    const loaded = await store.entity('Item').load({ take: 256 });
    const boundedLoadMs = performance.now() - startLoad;
    assert.equal(loaded.length, Math.min(256, rows.length));
    const query = { $count: { $for: { item: '$.Item[*]' }, $where: { $eq: ['$item.provenance', 'manual'] }, $return: '$item.id' } };
    const startResidual = performance.now();
    assert.equal(await store.execute(query), rows.filter((r) => r.provenance === 'manual').length);
    const decodedScanMs = performance.now() - startResidual;
    sampledHeapBytes = Math.max(sampledHeapBytes, sample());
    const teardown = performance.now(); await store.close(); store = null;
    const teardownMs = performance.now() - teardown;
    const check = await driver.open(path); assert.equal(JSON.stringify(await readSchema(check)), source); check.close();
    const recoveryPath = join(dir, 'wal.sqlite');
    const recoveryStart = performance.now();
    const child = spawnSync(process.execPath, ['--no-warnings=ExperimentalWarning', fileURLToPath(new URL('../test/adoption/wal-writer.js', import.meta.url)), recoveryPath], { encoding: 'utf8', timeout: 10000 });
    assert.equal(child.status, 0, child.stderr);
    const recoveryModel = { $model: '0.1', entities: { Receipt: model.entities.Receipt } };
    const recovered = await openStore(recoveryModel, { driver, path: recoveryPath, adopt: true });
    assert.equal((await recovered.entity('Receipt').load({})).length, 2); await recovered.close();
    final.recoveryMs = performance.now() - recoveryStart;
    const resources = { sampledHeapBytes, peakRssBytes: process.resourceUsage().maxRSS * 1024,
      peakHeapBytes: null, teardownMs, remainingHandles: null };
    return { consumer: consumer.id, rows: consumer.rows, workloadHash: consumer.workloadHash, baseline, final,
      mapping: { openMs, pointReadMs, boundedLoadMs, loadedRows: loaded.length, loadedBytes: Buffer.byteLength(JSON.stringify(loaded)),
        decodedScanMs, decodedScanRows: rows.length }, resources,
      budgets: { relational: assessBudget(consumer.budgets.relational, final), resources: assessBudget(consumer.budgets.resources, resources) } };
  }
  finally { await store?.close(); rmSync(dir, { recursive: true, force: true }); }
};
const id = process.argv.find((arg) => arg.startsWith('--consumer='))?.slice(11);
if (id) {
  const consumer = manifest.consumers.find((row) => row.id === id);
  if (!consumer) throw new Error('unknown frozen consumer');
  console.log(JSON.stringify(await measure(consumer)));
}
else {
  const consumers = manifest.consumers.map((consumer) => {
    const child = spawnSync(process.execPath, ['--no-warnings=ExperimentalWarning', fileURLToPath(import.meta.url), `--consumer=${consumer.id}`],
      { encoding: 'utf8', timeout: 120000 });
    assert.equal(child.status, 0, child.stderr); return JSON.parse(child.stdout);
  });
  const report = { format: 'jaren-relational-report/1', freezeHash: manifest.freezeHash,
    runnerHash: adoptionHash(readFileSync(fileURLToPath(import.meta.url))),
    runtime: { node: process.version, sqlite: process.versions.sqlite, platform: process.platform, arch: process.arch, cpu: cpus()[0].model },
    consumers, limitations: [
      'SQL budgets count six reads and three first mutations; seed, transaction admission, metadata, second-run assertions and mapped reads are additional work.',
      'The frozen relational SQL subset is small in both profiles; Item measurements separately use every generated consumer row.',
      'Physical Query IR evaluation decodes a full scan; its cost is reported separately and does not qualify bounded query pushdown.',
      'The heap is sampled, not an exact peak; open-handle teardown and PostgreSQL/native-binary deployment remain pending.',
      'Source SQL retirement and real downstream cutover remain pending; the reference oracle stays executable.',
    ] };
  if (process.argv.includes('--write')) writeFileSync(new URL('relational-result.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
