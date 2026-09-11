//@ts-check
import { readFileSync } from 'node:fs';

/** Synthetic adoption results use the existing fact namespace and derivation runner. */
export const adoptionFacts = {
  name: 'portable adoption evidence',
  docs: () => ['docs/ADOPTION-EVIDENCE.md'],
  facts: () => ({
    'adoption.combined': () => {
      const report = JSON.parse(readFileSync(new URL('../benchmark/adoption-journey-result.json', import.meta.url), 'utf8'));
      return '\n\n| Host | Consumer | Rows | Journey ms | Search startup ms | Heap MiB | Peak RSS MiB | Second writes |\n'
        + '|---|---|---:|---:|---:|---:|---:|---:|\n'
        + report.hosts.flatMap((host) => host.results.filter((row) => row.phase === 'all').map((row) =>
          `| ${host.label} | ${row.consumer} | ${row.rows} | ${row.elapsedMs.toFixed(2)} | ${row.searchMs.toFixed(2)} | ${(row.heapBytes / 1048576).toFixed(2)} | ${(row.peakRssBytes / 1048576).toFixed(2)} | ${row.secondWrites} |`)).join('\n')
        + `\n\nRetained reference adapters: ${report.ownership.retainedOracleLines} lines; adopted application policy: ${report.ownership.adoptedPolicyLines} lines. Third-party search/virtualization mechanisms in the application: ${report.ownership.retainedThirdPartyMechanisms.length} → ${report.ownership.adoptedThirdPartyMechanisms.length}.\n\n`
        + report.checks.map((row) => `${row.host}/${row.consumer}: ${row.checks.filter((check) => check.status === 'fail').length} measured budget losses.`).join(' ') + '\n\n';
    },
    'adoption.reference': () => {
      const report = JSON.parse(readFileSync(new URL('../benchmark/adoption-result.json', import.meta.url), 'utf8'));
      const manifest = JSON.parse(readFileSync(new URL('../test/adoption/manifest.json', import.meta.url), 'utf8'));
      if (report.freezeHash !== manifest.freezeHash) throw new Error('adoption report uses another fixture freeze');
      return `\n\nReference-only measurements on ${report.runtime.node}, ${report.runtime.platform}/${report.runtime.arch}, ${report.runtime.cpu}.\n\n`
        + '| Consumer | Rows | Cold index ms | Reload ms | Worst query median ms | Sampled heap MiB | Peak RSS MiB | Search gzip bytes | Grid gzip bytes |\n'
        + '|---|---:|---:|---:|---:|---:|---:|---:|---:|\n'
        + report.consumers.map((row) => {
          const { search, resources, grid } = row.metrics;
          return `| ${row.consumer} | ${row.rows} | ${search.coldIndexMs.toFixed(2)} | ${search.warmIndexMs.toFixed(2)} | ${search.queryMs.toFixed(2)} | ${(resources.sampledHeapBytes / 1048576).toFixed(2)} | ${(resources.peakRssBytes / 1048576).toFixed(2)} | ${search.browserGzipBytes} | ${grid.browserGzipBytes} |`;
        }).join('\n')
        + '\n\n' + report.consumers.map((row) => {
          const checks = Object.values(row.budgets).flat();
          return `${row.consumer}: ${checks.filter((check) => check.status === 'pass').length} measured limits met, ${checks.filter((check) => check.status === 'fail').length} losses, ${checks.filter((check) => check.status === 'pending').length} pending measurements.`;
        }).join(' ') + '\n\n';
    },
  }),
};
