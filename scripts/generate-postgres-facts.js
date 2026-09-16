//@ts-check
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

/** Refuse an evidence summary whose explicitly recorded source has moved. */
function measured(file) {
  const report = JSON.parse(readFileSync(new URL(`../benchmark/${file}`, import.meta.url), 'utf8'));
  for (const [source, hash] of Object.entries(report.sourceHashes)) {
    if (createHash('sha256').update(readFileSync(new URL(`../${source}`, import.meta.url))).digest('hex') !== hash)
      throw new Error(`PostgreSQL evidence drift in ${file}: ${source}; rerun its qualification command`);
  }
  return report;
}

/** Backend costs derive from the measured source rather than a handwritten table. */
export const postgresFacts = {
  name: 'PostgreSQL portability measurements',
  docs: () => ['packages/db/README.md', 'packages/db/docs/POSTGRESQL.md'],
  facts: () => ({
    'postgres.portability': () => {
      const report = measured('postgres-result.json');
      const { sqlite, native } = report;
      const ms = value => (value / 1e6).toFixed(3);
      const operations = Object.keys(sqlite.rows);
      return `\n\nMeasured ${report.measuredAt}: ${report.documents} documents, Node ${report.runtime.node}, SQLite ${report.runtime.sqlite}, PostgreSQL ${report.postgres.version}, pg ${report.runtime.pg}. Durability settings: fsync=${report.postgres.fsync}, synchronous_commit=${report.postgres.synchronous_commit}, full_page_writes=${report.postgres.full_page_writes}.\n\n`
        + '| Operation | SQLite ms | PostgreSQL ms | PG / SQLite | Client query calls per PG operation | Iterations |\n|---|---:|---:|---:|---:|---:|\n'
        + operations.map(key => `| ${key} | ${ms(sqlite.rows[key])} | ${ms(native.rows[key])} | ${(native.rows[key] / sqlite.rows[key]).toFixed(1)}× | ${native.queryCalls[key]} | ${native.iterations[key]} |`).join('\n')
        + `\n| migration (one index) | ${ms(sqlite.migrationNs)} | ${ms(native.migrationNs)} | ${(native.migrationNs / sqlite.migrationNs).toFixed(1)}× | not separately counted | 1 |\n\n`
        + `Sequential insert throughput: SQLite ${sqlite.insertPerSecond.toFixed(0)}, PostgreSQL ${native.insertPerSecond.toFixed(0)} documents/second.\n\n`
        + '| First-row probe | SQLite | PostgreSQL |\n|---|---:|---:|\n'
        + `| First row ms | ${sqlite.first.firstRowMs.toFixed(3)} | ${native.first.firstRowMs.toFixed(3)} |\n`
        + `| First row plus cleanup ms | ${sqlite.first.firstRowAndCleanupMs.toFixed(3)} | ${native.first.firstRowAndCleanupMs.toFixed(3)} |\n`
        + `| Returned rows | 1 | 1 |\n| Fetched native rows / normalized bytes | not instrumented | ${native.first.fetchedRows} / ${native.first.fetchedBytes} |\n`
        + `| Session peak native frame rows / bytes | not instrumented | ${native.first.sessionPeakRows} / ${native.first.sessionPeakBytes} |\n`
        + `| Client query calls including cleanup | no network | ${native.first.queryCalls} |\n`
        + `| Sampled RSS before / after MiB | ${(sqlite.memoryBefore.rss / 1048576).toFixed(2)} / ${(sqlite.memoryAfter.rss / 1048576).toFixed(2)} | ${(native.memoryBefore.rss / 1048576).toFixed(2)} / ${(native.memoryAfter.rss / 1048576).toFixed(2)} |\n`
        + `| Sampled heap before / after MiB | ${(sqlite.memoryBefore.heapUsed / 1048576).toFixed(2)} / ${(sqlite.memoryAfter.heapUsed / 1048576).toFixed(2)} | ${(native.memoryBefore.heapUsed / 1048576).toFixed(2)} / ${(native.memoryAfter.heapUsed / 1048576).toFixed(2)} |\n\n`
        + `After close: driver active=${native.admission.active}, queued=${native.admission.queued}; native cursors=${native.settled.cursors}, prepared statements=${native.settled.statements}; host pool total=${native.poolCounts.total}, idle=${native.poolCounts.idle}, waiting=${native.poolCounts.waiting}.\n\n${report.scope}\n\n`;
    },
    'postgres.executables': () => {
      const report = measured('backend-executables-result.json');
      return `\n\n${report.platform}/${report.arch}, ${report.packages.length} locally packed public packages; ${report.source}.\n\n`
        + '| Backend | Runtime | Binary bytes | Application ms | Sampled RSS / heap MiB | Raw process max RSS MiB |\n|---|---|---:|---:|---:|---:|\n'
        + report.report.map(row => `| ${row.backend} | ${row.runtime} ${row.result.version} | ${row.bytes} | ${row.result.elapsedMs.toFixed(2)} | ${(row.result.rssBytes / 1048576).toFixed(2)} / ${(row.result.heapBytes / 1048576).toFixed(2)} | ${(row.result.peakRssBytes / 1048576).toFixed(2)} |`).join('\n')
        + `\n\n${report.resourceScope}\n\n`;
    },
    'postgres.recovery': () => {
      const report = measured('postgres-operations-result.json');
      return '\n\n| Logical backup / restore server | Tables / rows | Archive bytes | Omitted metadata cases detected | Elapsed ms |\n|---|---:|---:|---:|---:|\n'
        + report.logicalBackups.map(row => `| ${row.postgres.version} | ${row.tables} / ${row.rows} | ${row.archiveBytes} | ${row.metadataOmissionCases} | ${row.elapsedMs.toFixed(2)} |`).join('\n')
        + `\n\nArchived WAL: ${report.pitr.postgres.version}, ${report.pitr.tables} tables / ${report.pitr.rows} rows, ${report.pitr.elapsedMs.toFixed(2)} ms; source stopped before promotion: ${report.pitr.sourceStoppedBeforePromotion}. Physical sequence advances are retained in the result. Power loss and fleet failover were not tested.\n\n`;
    },
    'postgres.adoption-resources': () => {
      const report = measured('adoption-hosts-result.json');
      const manifest = JSON.parse(readFileSync(new URL('../test/adoption/manifest.json', import.meta.url), 'utf8'));
      return '\n\n| Existing SQLite adoption executable | Workload | RSS bytes | Frozen reference bytes | RSS disposition |\n|---|---|---:|---:|---|\n'
        + report.report.filter(host => host.label.endsWith('-executable')).flatMap(host =>
          host.results.filter(row => row.phase === 'all').map(row => {
            const budget = manifest.consumers.find(consumer => consumer.id === row.consumer).budgets.resources.peakRssBytes;
            return `| ${host.label} | ${row.consumer} | ${row.peakRssBytes} | ${budget} | ${row.peakRssBytes > budget ? `loss (+${row.peakRssBytes - budget})` : 'within reference'} |`;
          })).join('\n')
        + '\n\nThese larger physical SQLite workloads are separate from the small build-selected managed application. Functional recovery success does not imply memory-budget success. Earlier samples remain in the resource history.\n\n';
    },
  }),
};
