//@ts-check
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

/** Relational measurements share the repository's fact derivation gate. */
export const relationalFacts = {
  name: 'relational adoption evidence',
  docs: () => ['benchmark/README.md'],
  facts: () => ({
    'query-native.measurements': () => {
      const report = JSON.parse(readFileSync(new URL('../benchmark/query-native-result.json', import.meta.url), 'utf8'));
      const censusHash = createHash('sha256').update(readFileSync(new URL('../test/db/fixtures/adoption-sql.json', import.meta.url))).digest('hex');
      if (report.censusHash !== censusHash) throw new Error('native report uses another SQL census');
      return `\n\nMeasured on ${report.runtime.node}, SQLite ${report.runtime.sqlite}, ${report.runtime.platform}/${report.runtime.arch}.\n\n`
        + '| Consumer | Rows | Index side | Family | SQL ms | Native ms | Decoded ms | Admitted statements / rows / bytes | Latency |\n'
        + '|---|---:|---|---|---:|---:|---:|---|---|\n'
        + report.measurements.map((r) => `| ${r.consumer} | ${r.rows} | ${r.side} | ${r.family} | ${r.sqlMs?.toFixed(2) ?? '—'} | ${r.nativeMs.toFixed(2)} | ${r.decodedMs?.toFixed(2) ?? '—'} | ${r.admitted.statements} / ${r.admitted.rows} / ${r.admitted.bytes} | ${r.latencyStatus ?? 'no-op replay proved'} |`).join('\n')
        + `\n\n${report.measurements.filter((r) => r.latencyStatus === 'loss').length} native latency losses against frozen consumer ceilings. Peak process RSS ${(report.peakRssBytes / 1048576).toFixed(2)} MiB.\n\n`;
    },
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
