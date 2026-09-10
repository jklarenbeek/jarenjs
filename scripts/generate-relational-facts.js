//@ts-check
import { readFileSync } from 'node:fs';

/** Relational measurements share the repository's fact derivation gate. */
export const relationalFacts = {
  name: 'relational adoption evidence',
  docs: () => ['benchmark/README.md'],
  facts: () => ({
    'relational.measurements': () => {
      const report = JSON.parse(readFileSync(new URL('../benchmark/relational-result.json', import.meta.url), 'utf8'));
      const manifest = JSON.parse(readFileSync(new URL('../test/adoption/manifest.json', import.meta.url), 'utf8'));
      if (report.freezeHash !== manifest.freezeHash) throw new Error('relational report uses another fixture freeze');
      return `\n\nMeasured on ${report.runtime.node}, SQLite ${report.runtime.sqlite}, ${report.runtime.platform}/${report.runtime.arch}, ${report.runtime.cpu}.\n\n`
        + '| Consumer | Generated rows | SQL statements reference / scoped | Worst SQL ms reference / scoped | WAL recovery ms | Open ms | Mapped point read ms | Bounded load rows / bytes | Decoded full scan ms | Sampled heap MiB | Peak RSS MiB |\n'
        + '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n'
        + report.consumers.map((r) => `| ${r.consumer} | ${r.rows} | ${r.baseline.statements} / ${r.final.statements} | ${r.baseline.queryMs.toFixed(2)} / ${r.final.queryMs.toFixed(2)} | ${r.final.recoveryMs.toFixed(2)} | ${r.mapping.openMs.toFixed(2)} | ${r.mapping.pointReadMs.toFixed(2)} | ${r.mapping.loadedRows} / ${r.mapping.loadedBytes} | ${r.mapping.decodedScanMs.toFixed(2)} | ${(r.resources.sampledHeapBytes / 1048576).toFixed(2)} | ${(r.resources.peakRssBytes / 1048576).toFixed(2)} |`).join('\n')
        + '\n\n' + report.consumers.map((r) => {
          const checks = Object.values(r.budgets).flat();
          return `${r.consumer}: ${checks.filter((c) => c.status === 'pass').length} measured limits met, ${checks.filter((c) => c.status === 'fail').length} losses, ${checks.filter((c) => c.status === 'pending').length} pending.`;
        }).join(' ') + '\n\n';
    },
  }),
};
