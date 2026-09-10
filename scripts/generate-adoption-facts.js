//@ts-check
import { readFileSync } from 'node:fs';

/** Synthetic adoption results use the existing fact namespace and derivation runner. */
export const adoptionFacts = {
  name: 'portable adoption evidence',
  docs: () => ['docs/ADOPTION-EVIDENCE.md'],
  facts: () => ({
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
