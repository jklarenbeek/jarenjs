//@ts-check
import { readFileSync } from 'node:fs';
import { assertMeasurementSources } from './lib/measurement.js';

/** Validate only this instrument's report; other measurement formats retain their own rules.
 * @param {any} report @param {string} runtime @param {string} file */
function measuredReport(report, runtime, file) {
  const check = (valid, field) => {
    if (!valid) throw new Error(`Invalid migration measurement in ${file}: ${field}; rerun both benchmark/migration-identity.js commands`);
  };
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const text = value => typeof value === 'string' && value.trim().length > 0;
  const metric = value => Number.isFinite(value) && value >= 0;
  check(object(report) && report.format === 'jaren-migration-identity-cost/1', 'format');
  check(object(report.runtime) && report.runtime.name === runtime
    && text(report.runtime.version) && text(report.runtime.sqlite), 'runtime');
  check(text(report.measuredAt) && Number.isFinite(Date.parse(report.measuredAt)), 'measuredAt');
  check(text(report.scope), 'scope');
  check(object(report.sourceHashes) && Object.keys(report.sourceHashes).length > 0
    && Object.entries(report.sourceHashes).every(([source, hash]) => text(source)
      && typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash)), 'sourceHashes');
  check(report.rounds === 5, 'rounds');
  check(Number.isSafeInteger(report.calls) && report.calls > 0, 'calls');
  check(object(report.storage), 'storage');
  for (const key of ['links', 'currentDocumentBytes', 'legacyProjectionBytes', 'identityRows', 'identityPayloadBytes', 'databaseGrowthBytes'])
    check(Number.isSafeInteger(report.storage[key]) && report.storage[key] >= 0, `storage.${key}`);
  check(report.storage.links > 0 && report.storage.identityRows === report.storage.links + 1, 'storage.identityRows');
  check(object(report.checks) && ['exactRows', 'synchronousCalls', 'unchangedHistory', 'unchangedIdentity']
    .every(key => report.checks[key] === true), 'checks');
  check(Array.isArray(report.samples) && report.samples.length === report.rounds, 'samples');
  check(object(report.medianMs), 'medianMs');
  const medianMs = {};
  for (const key of ['applyMs', 'statusMs', 'repeatMs', 'observationMs']) {
    check(report.samples.every(sample => object(sample) && metric(sample[key])), `samples.${key}`);
    const median = report.samples.map(sample => sample[key]).sort((a, b) => a - b)[Math.floor(report.rounds / 2)];
    check(metric(report.medianMs[key]) && report.medianMs[key] === median, `medianMs.${key}`);
    medianMs[key] = median;
  }
  return { ...report, medianMs };
}

/** Current migration receipt costs, from actual native Node and Bun samples. */
export const migrationFacts = {
  name: 'exact migration measurements',
  docs: () => ['packages/db/docs/MIGRATION-UPGRADE.md'],
  facts: () => ({
    'migration.costs': () => {
      const reports = ['node', 'bun'].map(runtime => {
        const file = `benchmark/migration-identity-${runtime}-result.json`;
        const report = measuredReport(JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')), runtime, file);
        assertMeasurementSources(report.sourceHashes, source =>
          `Migration evidence drift in ${file}: ${source}; rerun both benchmark/migration-identity.js commands`);
        return report;
      });
      const first = reports[0], size = first.storage;
      if (!reports.every(report => report.rounds === first.rounds && report.calls === first.calls && report.scope === first.scope
        && ['links', 'currentDocumentBytes', 'legacyProjectionBytes'].every(key => report.storage[key] === size[key])))
        throw new Error('Migration measurement workloads differ; rerun both benchmark/migration-identity.js commands');
      return `\n\n${size.links} SQL-only links; ${first.calls} calls per read/repeat loop; medians of ${first.rounds} fresh-database samples. Every sample preserves exact application, normal-history and identity rows.\n\n`
        + '| Native runtime / SQLite | Apply all links ms | Status loop ms | No-op apply loop ms | Observation loop ms | Measured at |\n'
        + '|---|---:|---:|---:|---:|---|\n'
        + reports.map(report => {
          const time = report.medianMs;
          return `| ${report.runtime.name} ${report.runtime.version} / ${report.runtime.sqlite} | ${time.applyMs.toFixed(3)} | ${time.statusMs.toFixed(3)} | ${time.repeatMs.toFixed(3)} | ${time.observationMs.toFixed(3)} | ${report.measuredAt} |`;
        }).join('\n')
        + '\n\n| Native runtime | Current document JSON bytes | Legacy-shaped JSON projection bytes | Side rows / key+value UTF-8 bytes | SQLite page growth bytes |\n'
        + '|---|---:|---:|---:|---:|\n'
        + reports.map(report => {
          const value = report.storage;
          return `| ${report.runtime.name} | ${value.currentDocumentBytes} | ${value.legacyProjectionBytes} | ${value.identityRows} / ${value.identityPayloadBytes} | ${value.databaseGrowthBytes} |`;
        }).join('\n')
        + `\n\n${first.scope}\n\n`;
    },
  }),
};
