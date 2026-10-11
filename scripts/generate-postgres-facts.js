//@ts-check
import { readFileSync } from 'node:fs';
import { assertMeasurementSources } from './lib/measurement.js';

/** Refuse an evidence summary whose explicitly recorded source has moved. */
function measured(file) {
  const report = JSON.parse(readFileSync(new URL(`../benchmark/${file}`, import.meta.url), 'utf8'));
  assertMeasurementSources(report.sourceHashes, source =>
    `PostgreSQL evidence drift in ${file}: ${source}; rerun its qualification command`);
  return report;
}

/**
 * The membership measurement as the tables a reader needs: each chain's plan
 * and time, the server's own account of the native statements, then the
 * planner's estimates against the rows returned.
 * @param {any} report
 */
function membershipText(report) {
  const { postgres: server, runtime } = report;
  const ms = (/** @type {number} */ value) => value.toFixed(2);
  const load = (/** @type {number[] | null} */ sample) => (Array.isArray(sample) ? ms(sample[0]) : 'not reported');
  const ratio = (/** @type {number} */ value) => `${value >= 0.1 ? value.toFixed(2) : value.toPrecision(1)}×`;
  const settings = ['jit', 'jit_above_cost', 'jit_inline_above_cost', 'jit_optimize_above_cost']
    .map(name => `${name}=${server[name]}`).join(', ');
  const chains = [...report.chains.map((/** @type {any} */ row) => ['pairs', row]), ['regrouped', report.folded]];
  const native = chains.filter(([, row]) => row.server !== null).map(([, row]) => row.server);
  const range = (/** @type {number[]} */ values, /** @type {(value: number) => string} */ format) => {
    const [low, high] = [Math.min(...values), Math.max(...values)];
    return low === high ? format(low) : `${format(low)} to ${format(high)}`;
  };
  const view = native.length === 0 ? '' : `The native statements under \`EXPLAIN (ANALYZE)\`: the planner priced them at ${
    range(native.map((/** @type {any} */ one) => one.cost), String)} against jit_above_cost=${server.jit_above_cost}, `
    + `the server planned them in ${range(native.map((/** @type {any} */ one) => one.planningMs), ms)} ms and ran them in ${
      range(native.map((/** @type {any} */ one) => one.executionMs), ms)} ms, and its JIT compiled ${
      native.filter((/** @type {any} */ one) => one.jit).length} of the ${native.length}.\n\n`;
  return `\n\nMeasured ${report.measuredAt}: PostgreSQL ${server.version} (${settings}), Node ${runtime.node}, pg ${runtime.pg}; ${report.documents} documents in each table, analyzed first; the median of ${report.iterations} calls after ${report.warmup} warm-up calls; host load (one-minute average) ${load(runtime.loadavg?.before)} before and ${load(runtime.loadavg?.after)} after, on ${runtime.cpus} cores.\n\n`
    + `One statement carries at most ${report.bound} leaf predicates. A chain of \`$and\` pairs (pairs) is not regrouped, so every term is a leaf; the same number of terms written as equalities on one member and ranges on another (regrouped) becomes one membership list and one bound.\n\n`
    + '| Chain | Terms | Leaf predicates | Plan | `execute()` ms | The engine alone, ms | Rows |\n|---|---:|---:|---|---:|---:|---:|\n'
    + chains.map(([kind, row]) => `| ${kind} | ${row.terms} | ${row.leaves} | ${row.mode === 'native' ? 'native' : `engine, \`${row.reason}\``} | ${ms(row.ms)} | ${row.engineMs === null ? 'same route' : ms(row.engineMs)} | ${row.rows} |`).join('\n')
    + `\n\n${view}`
    + 'The planner\'s own estimate, `explain().budget.estimatedRows`, against the rows each statement returns:\n\n'
    + '| Statement | Estimated rows | Actual rows | Estimate / actual |\n|---|---:|---:|---:|\n'
    + report.estimates.map((/** @type {any} */ row) => {
      const estimated = row.estimatedRows === 'unavailable' ? null : row.estimatedRows.rows;
      return `| ${row.label} | ${estimated ?? 'unavailable'} | ${row.actualRows} | ${estimated === null || row.actualRows === 0 ? 'n/a' : ratio(estimated / row.actualRows)} |`;
    }).join('\n')
    + `\n\n${report.scope}\n\n`;
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
    'postgres.sessions': () => {
      const report = measured('postgres-sessions-result.json');
      const one = report.rows.filter((row) => row.shape === 'one store');
      const separate = report.rows.filter((row) => row.shape === 'separate stores');
      const plain = report.routing['one session'].nsPerTransaction;
      const routed = report.routing['two sessions, one client'].nsPerTransaction;
      return `\n\nMeasured ${report.measuredAt}: PostgreSQL ${report.postgres.version} (fsync=${report.postgres.fsync}, synchronous_commit=${report.postgres.synchronous_commit}, full_page_writes=${report.postgres.full_page_writes}), Node ${report.runtime.node}, pg ${report.runtime.pg}; ${report.clients} clients at once, each ${report.perClient} one-document write transactions on keys of its own; the median of ${report.rounds} rounds, each measuring every shape once.\n\n`
        + '| N | One store on N sessions, tx/s | N stores of one session, tx/s | One store over N stores |\n|---:|---:|---:|---:|\n'
        + one.map((row) => {
          const stores = separate.find((other) => other.stores === row.sessions);
          return `| ${row.sessions} | ${row.txPerSecond.toFixed(0)} | ${stores.txPerSecond.toFixed(0)} | ${(row.txPerSecond / stores.txPerSecond).toFixed(2)}× |`;
        }).join('\n')
        + `\n\nOne transaction with nothing beside it: ${(plain / 1e6).toFixed(3)} ms on a store of one session, ${(routed / 1e6).toFixed(3)} ms through the router of a store on two (${((routed - plain) / plain * 100).toFixed(1)}%). A store on one session has no router.\n\n${report.scope}\n\n`;
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
    'postgres.membership': () => {
      const report = measured('postgres-membership-result.json');
      if (report.format !== 'jaren-postgres-membership/1')
        throw new Error(`PostgreSQL evidence in postgres-membership-result.json is a ${report.format} report, expected jaren-postgres-membership/1`);
      return membershipText(report);
    },
  }),
};
