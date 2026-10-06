//@ts-check
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const source = 'measurement fixture\n';
const hash = createHash('sha256').update(source).digest('hex');
const timingKeys = ['applyMs', 'statusMs', 'repeatMs', 'observationMs'];
const scope = 'Synthetic formatter fixture; no benchmark is run by this test.';
/** @returns {any} */
const report = runtime => ({
  format: 'jaren-migration-identity-cost/1', measuredAt: '2026-10-06T18:00:00.000Z',
  runtime: { name: runtime, version: 'fixture', sqlite: 'fixture', platform: 'test', arch: 'test', cpu: 'test', loadavg: [0, 0, 0] },
  sourceHashes: { 'source.js': hash }, rounds: 5, calls: 500,
  storage: { links: 10, currentDocumentBytes: 2511, legacyProjectionBytes: 1301,
    identityRows: 11, identityPayloadBytes: 5134, databaseGrowthBytes: 16384 },
  samples: [5, 1, 9, 3, 7].map(value => Object.fromEntries(timingKeys.map((key, i) => [key, value + i]))),
  medianMs: { applyMs: 5, statusMs: 6, repeatMs: 7, observationMs: 8 },
  checks: { exactRows: true, synchronousCalls: true, unchangedHistory: true, unchangedIdentity: true },
  scope,
});

/** Exercise the real file-reading entry point without reading or changing measured artifacts. */
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'jaren-migration-facts-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'scripts/lib'), { recursive: true });
  mkdirSync(join(root, 'benchmark'));
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  for (const file of ['generate-migration-facts.js', 'lib/measurement.js'])
    writeFileSync(join(root, 'scripts', file), readFileSync(new URL(`../../scripts/${file}`, import.meta.url)));
  writeFileSync(join(root, 'source.js'), source);
  const path = runtime => join(root, 'benchmark', `migration-identity-${runtime}-result.json`);
  const write = (runtime, value) => writeFileSync(path(runtime), JSON.stringify(value));
  for (const runtime of ['node', 'bun']) write(runtime, report(runtime));
  const { migrationFacts } = await import(pathToFileURL(join(root, 'scripts/generate-migration-facts.js')).href);
  return {
    root, write,
    raw: (runtime, change) => writeFileSync(path(runtime), change(readFileSync(path(runtime), 'utf8'))),
    render: () => migrationFacts.facts()['migration.costs'](),
  };
}

it('migration facts preserve the exact valid output and use numerical medians of retained samples', async t => {
  const f = await fixture(t);
  assert.equal(f.render(), `\n\n10 SQL-only links; 500 calls per read/repeat loop; medians of 5 fresh-database samples. Every sample preserves exact application, normal-history and identity rows.\n\n`
    + '| Native runtime / SQLite | Apply all links ms | Status loop ms | No-op apply loop ms | Observation loop ms | Measured at |\n'
    + '|---|---:|---:|---:|---:|---|\n'
    + '| node fixture / fixture | 5.000 | 6.000 | 7.000 | 8.000 | 2026-10-06T18:00:00.000Z |\n'
    + '| bun fixture / fixture | 5.000 | 6.000 | 7.000 | 8.000 | 2026-10-06T18:00:00.000Z |\n\n'
    + '| Native runtime | Current document JSON bytes | Legacy-shaped JSON projection bytes | Side rows / key+value UTF-8 bytes | SQLite page growth bytes |\n'
    + '|---|---:|---:|---:|---:|\n'
    + '| node | 2511 | 1301 | 11 / 5134 | 16384 |\n'
    + '| bun | 2511 | 1301 | 11 / 5134 | 16384 |\n\n'
    + `${scope}\n\n`);
});

it('migration facts allow zero timings and different runtime costs without changing workload claims', async t => {
  const f = await fixture(t);
  const changed = report('bun');
  changed.samples = changed.samples.map(sample => Object.fromEntries(Object.keys(sample).map(key => [key, 0])));
  changed.medianMs = Object.fromEntries(timingKeys.map(key => [key, 0]));
  changed.storage.databaseGrowthBytes = 0;
  changed.storage.identityPayloadBytes += 1;
  f.write('bun', changed);
  assert.match(f.render(), /\| bun fixture \/ fixture \| 0\.000 \| 0\.000 \| 0\.000 \| 0\.000 \|/);
  assert.match(f.render(), /\| bun \| 2511 \| 1301 \| 11 \/ 5135 \| 0 \|/);
});

it('migration facts retain stale-source and missing-source refusals from the shared helper', async t => {
  const f = await fixture(t);
  writeFileSync(join(f.root, 'source.js'), 'different\n');
  assert.throws(f.render, { message: 'Migration evidence drift in benchmark/migration-identity-node-result.json: source.js; rerun both benchmark/migration-identity.js commands' });
  rmSync(join(f.root, 'source.js'));
  assert.throws(f.render, { code: 'ENOENT' });
});

it('migration facts refuse other report formats and a runtime filed under the wrong name', async t => {
  const f = await fixture(t);
  for (const change of [value => { value.format = 'other/1'; }, value => { delete value.format; }, value => { value.runtime.name = 'bun'; }]) {
    const value = report('node'); change(value); f.write('node', value);
    assert.throws(f.render, /Invalid migration measurement.*(?:format|runtime)/);
  }
});

it('migration facts refuse missing rendered provenance and scope', async t => {
  const f = await fixture(t);
  for (const change of [value => { value.runtime.version = ''; }, value => { delete value.runtime.sqlite; },
    value => { value.measuredAt = 'not a date'; }, value => { value.scope = ''; }]) {
    const value = report('node'); change(value); f.write('node', value);
    assert.throws(f.render, /Invalid migration measurement/);
  }
});

it('migration facts require nonempty valid source hash declarations', async t => {
  const f = await fixture(t);
  for (const hashes of [{}, [], null, { 'source.js': 'not-a-hash' }, { '': hash }]) {
    const value = report('node'); value.sourceHashes = hashes; f.write('node', value);
    assert.throws(f.render, /Invalid migration measurement.*sourceHashes/);
  }
});

it('migration facts require all five complete retained samples', async t => {
  const f = await fixture(t);
  for (const change of [value => { value.samples = []; }, value => { value.samples.pop(); },
    value => { value.samples.push(value.samples[0]); }, value => { value.rounds = 4; value.samples.pop(); },
    value => { delete value.samples[2].observationMs; }]) {
    const value = report('node'); change(value); f.write('node', value);
    assert.throws(f.render, /Invalid migration measurement.*(?:rounds|samples)/);
  }
});

it('migration facts refuse each failed or missing preservation check', async t => {
  const f = await fixture(t);
  for (const key of Object.keys(report('node').checks)) {
    for (const value of [false, undefined]) {
      const changed = report('node'); changed.checks[key] = value; f.write('node', changed);
      assert.throws(f.render, /Invalid migration measurement.*checks/);
    }
  }
});

it('migration facts refuse invalid sample values and disagreeing or incomplete medians', async t => {
  const f = await fixture(t);
  for (const key of timingKeys) {
    for (const value of [-1, null, '2']) {
      const changed = report('node'); changed.samples[0][key] = value; f.write('node', changed);
      assert.throws(f.render, /Invalid migration measurement.*samples/);
    }
    for (const value of [999, undefined, null, '2']) {
      const changed = report('node'); changed.medianMs[key] = value; f.write('node', changed);
      assert.throws(f.render, /Invalid migration measurement.*medianMs/);
    }
  }
  f.write('node', report('node'));
  f.raw('node', text => text.replace('"applyMs":5', '"applyMs":1e309'));
  assert.throws(f.render, /Invalid migration measurement.*samples/);
});

it('migration facts refuse nonnumeric, negative or fractional counts and byte sizes', async t => {
  const f = await fixture(t);
  for (const key of Object.keys(report('node').storage)) {
    for (const value of [-1, null, '10', 1.5]) {
      const changed = report('node'); changed.storage[key] = value; f.write('node', changed);
      assert.throws(f.render, /Invalid migration measurement.*storage/);
    }
  }
  for (const calls of [0, -1, null, '500', 1.5]) {
    const changed = report('node'); changed.calls = calls; f.write('node', changed);
    assert.throws(f.render, /Invalid migration measurement.*calls/);
  }
});

it('migration facts refuse different workload or scope in the second runtime', async t => {
  const f = await fixture(t);
  for (const change of [value => { value.calls = 1; }, value => { value.storage.links = 9; value.storage.identityRows = 10; },
    value => { value.storage.currentDocumentBytes += 1; }, value => { value.storage.legacyProjectionBytes += 1; },
    value => { value.scope = 'Different workload'; }]) {
    const value = report('bun'); change(value); f.write('bun', value);
    assert.throws(f.render, /Migration measurement workloads differ/);
  }
});
