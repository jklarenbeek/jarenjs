//@ts-check
/** Retained SQL versus public native/decoded plans, with bounded scaled windows. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { createHash } from 'node:crypto';
import { loadSqlCensus, storeForSqlCensus } from '../test/db/oracle/harness.js';
import { readAdoption, verifyFreeze } from '../test/adoption/evidence.js';
import { adoptionRows } from '../scripts/lib/adoption.js';

const manifest = readAdoption('manifest.json');
verifyFreeze(manifest);
const census = loadSqlCensus();
const plain = (value) => JSON.parse(JSON.stringify(value));
const timed = async (fn) => {
  const start = performance.now(); const value = await fn();
  return { value, ms: performance.now() - start };
};
const measurements = [];
for (const consumer of [null, ...manifest.consumers]) {
  for (const side of ['indexed', 'unindexed']) {
    const { store, db, calls } = await storeForSqlCensus(side);
    try {
      if (consumer) {
        await db.transaction(() => {
          const catalog = db.prepare('INSERT INTO catalog VALUES(?,?,?)');
          const inventory = db.prepare('INSERT INTO inventory VALUES(?,?,?,?,1)');
          for (const row of adoptionRows(consumer)) {
            const sku = `g${row.id}`;
            catalog.run([sku, sku, 'synthetic']);
            inventory.run([sku, consumer.policy.environment, row.quantity, row.provenance]);
          }
        });
        if (side === 'indexed') db.exec('CREATE INDEX native_inventory_sku ON inventory(sku)');
      }
      for (const read of census.reads.filter((r) => r.query)) {
        const body = structuredClone(read.query[0]);
        let sql = read.sql;
        const params = [];
        if (consumer && ['environment-join', 'correlated-count'].includes(read.id)) {
          const upper = db.prepare('SELECT sku FROM catalog ORDER BY sku LIMIT 1 OFFSET 15').get([]).sku;
          const bound = { $le: ['$c.sku', upper] };
          body.$where = body.$where ? { $and: [...(body.$where.$and ?? [body.$where]), bound] } : bound;
          sql = sql.replace(' ORDER BY c.sku', `${read.id === 'environment-join' ? ' AND' : ' WHERE'} c.sku <= ? ORDER BY c.sku`);
          params.push(upper);
        }
        const document = consumer && read.id !== 'nullable-aggregate' ? [{ $subsequence: [body, 0, read.budget.rows] }] : read.query;
        sql += consumer ? ` LIMIT ${read.budget.rows}` : '';
        const reference = await timed(() => db.prepare(sql).all(params));
        calls.length = 0;
        const native = await timed(() => store.execute(document, { strict: true }));
        const statements = calls.length;
        assert.deepEqual(native.value, plain(reference.value));
        const explained = await store.explain(document);
        const decoded = await timed(() => store.execute(document, { pushdown: false }));
        assert.deepEqual(decoded.value, native.value);
        assert.equal(statements, read.budget.statements);
        assert.ok(explained.admitted.rows <= read.budget.rows);
        assert.ok(explained.admitted.bytes <= read.budget.bytes);
        measurements.push({ consumer: consumer?.id ?? 'frozen-census', rows: consumer?.rows ?? 0,
          side, family: read.id, sqlMs: reference.ms, nativeMs: native.ms, decodedMs: decoded.ms,
          admitted: explained.admitted, scan: explained.scanNarrative,
          latencyLimitMs: consumer?.budgets.relational.queryMs ?? 100,
          latencyStatus: native.ms <= (consumer?.budgets.relational.queryMs ?? 100) ? 'pass' : 'loss',
          sampledHeapBytes: process.memoryUsage().heapUsed });
        console.log(`${consumer?.id ?? 'frozen-census'} ${side} ${read.id}: native ${native.ms.toFixed(2)}ms, decoded ${decoded.ms.toFixed(2)}ms`);
      }
      if (!consumer) for (const family of census.mutations) {
        calls.length = 0;
        const first = await timed(() => store.entity(family.entity).mutate(family.document));
        assert.deepEqual(first.value.rows, family.first);
        assert.equal(calls.length, family.budget.statements);
        const before = db.prepare('SELECT total_changes() AS n').get([]).n;
        const replay = await store.entity(family.entity).mutate(family.document);
        assert.equal(replay.affected, 0);
        assert.equal(db.prepare('SELECT total_changes() AS n').get([]).n, before);
        measurements.push({ consumer: 'frozen-census', rows: 0, side, family: family.id,
          nativeMs: first.ms, admitted: first.value.admitted, replayWrites: 0 });
      }
    }
    finally { await store.close(); }
  }
}
const report = { format: 'jaren-native-measurements/1', at: new Date().toISOString(),
  freezeHash: manifest.freezeHash,
  censusHash: createHash('sha256').update(readFileSync(new URL('../test/db/fixtures/adoption-sql.json', import.meta.url))).digest('hex'),
  runtime: { node: process.version, sqlite: process.versions.sqlite, platform: process.platform, arch: process.arch, cpu: cpus()[0].model },
  qualification: { nativeReadFamilies: 5, nativeMutationFamilies: 3, retainedSqlFamilies: 1,
    retainedReason: 'receipt-history has no declared primary key',
    scaled: 'catalog prefix bounded to sixteen candidates; first sixteen results; complete grouped sums',
    postgres: 'physical adoption and mutations refused; no PostgreSQL native-column claim',
    nativeExecutable: 'pending', downstreamCutover: 'pending', visitedSqlRows: 'unavailable' },
  measurements, peakRssBytes: process.resourceUsage().maxRSS * 1024 };
writeFileSync(new URL('./query-native-result.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log(`${measurements.length} comparisons, ${measurements.filter((r) => r.latencyStatus === 'loss').length} native latency losses; peak RSS ${report.peakRssBytes}`);
