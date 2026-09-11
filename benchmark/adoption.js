//@ts-check
/** Frozen synthetic reference costs. Native, live-host and manual claims stay separate. */
import { readFileSync, writeFileSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir, cpus, totalmem, availableParallelism, release } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import MiniSearch from 'minisearch';
import { build } from 'esbuild';
import { adoptionRows } from '../scripts/lib/adoption.js';
import { adoptionHash, readAdoption, verifyFreeze, assessBudget } from '../test/adoption/evidence.js';
import { referenceSearch, referenceGrid, searchOptions } from '../test/adoption/oracles.js';
import { readProviderTranscript } from '../test/adoption/provider-oracle.js';
import { trustedBodies, SKIP } from '../test/adoption/trusted-bodies.js';

if (process.argv.includes('--combined')) {
  await import('./adoption-journey.js');
  process.exit(0);
}

const manifest = readAdoption('manifest.json');
verifyFreeze(manifest);
const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const childId = args.find((arg) => arg.startsWith('--consumer='))?.slice('--consumer='.length);
const knownArgs = args.every((arg) => arg.startsWith('--consumer=') || arg === '--write');
if (!knownArgs || (childId && !manifest.consumers.some((c) => c.id === childId)))
  throw new Error('Usage: node benchmark/adoption.js [--write] [--consumer=<frozen-id>]');

/** @param {() => any} run */
function timed(run) {
  const start = performance.now(); const value = run();
  return { ms: performance.now() - start, value };
}

/** Measure one declared consumer in a fresh process, with no native comparison.
 * @param {any} consumer */
async function measure(consumer) {
  let sampledHeapBytes = 0;
  const sample = () => { sampledHeapBytes = Math.max(sampledHeapBytes, process.memoryUsage().heapUsed); };
  const startup = performance.now();
  const documents = adoptionRows(consumer);
  const encoded = JSON.stringify(documents);
  assert.equal(adoptionHash(encoded), consumer.workloadHash);
  sample();
  const searchFixture = readAdoption('fixtures/search.json');
  const cold = timed(() => referenceSearch(searchFixture, documents)); sample();
  const snapshot = JSON.stringify(cold.value); sample();
  const warm = timed(() => MiniSearch.loadJSON(snapshot, searchOptions(searchFixture))); sample();
  const startupMs = performance.now() - startup;
  const queries = searchFixture.queries.map((query) => {
    const runs = Array.from({ length: 5 }, () => timed(() => warm.value.search(query.text)));
    sample();
    const sorted = runs.map((run) => run.ms).sort((a, b) => a - b);
    const result = runs[0].value;
    return { text: query.text, medianMs: sorted[2], matches: result.length,
      resultHash: adoptionHash(JSON.stringify(result.map(({ id, score }) => ({ id, score })))) };
  });
  const bundles = {};
  for (const [name, entry] of [['search', 'minisearch'], ['grid', '@tanstack/virtual-core']]) {
    const contents = name === 'search' ? `export { default as MiniSearch } from '${entry}';` : `export * from '${entry}';`;
    const output = await build({ stdin: { contents, resolveDir: root },
      bundle: true, minify: true, format: 'esm', platform: 'browser', write: false, logLevel: 'silent' });
    assert.ok(output.outputFiles[0].contents.byteLength > 0, `empty ${name} bundle`);
    bundles[name] = gzipSync(output.outputFiles[0].contents).byteLength;
  }
  sample();
  const gridFixture = readAdoption('fixtures/grid.json');
  const profile = { ...gridFixture[consumer.grid], count: consumer.rows };
  const grids = profile.offsets.map((offset) => {
    const construction = timed(() => referenceGrid(profile, offset));
    const { virtualizer, dispose } = construction.value;
    const interaction = timed(() => {
      virtualizer.scrollOffset = offset + profile.estimateSize;
      return virtualizer.getVirtualItems();
    });
    const result = { offset, nextOffset: offset + profile.estimateSize, initializationMs: construction.ms, interactionMs: interaction.ms,
      logicalRows: consumer.rows, virtualRows: interaction.value.length,
      potentialCells: interaction.value.length * profile.columns };
    sample(); dispose(); return result;
  });

  const relationalFixture = readAdoption('fixtures/relational.json');
  const db = new DatabaseSync(':memory:');
  let statements = 0;
  let queryMs = 0;
  const plans = [];
  try {
    for (const sql of [...relationalFixture.ddl, ...relationalFixture.seed]) db.exec(sql);
    for (const read of relationalFixture.reads) {
      const result = timed(() => db.prepare(read.sql).all()); statements++;
      assert.deepEqual(JSON.parse(JSON.stringify(result.value)), read.expected);
      queryMs = Math.max(queryMs, result.ms);
      plans.push({ family: read.id, sql: read.sql, plan: db.prepare(`EXPLAIN QUERY PLAN ${read.sql}`).all() });
    }
    for (const mutation of relationalFixture.mutations) {
      assert.deepEqual(JSON.parse(JSON.stringify(db.prepare(mutation.sql).all())), mutation.first); statements++;
      assert.deepEqual(db.prepare(mutation.sql).all(), []);
      assert.equal(db.prepare('SELECT changes() AS n').get().n, 0);
    }
  }
  finally { db.close(); }
  const dir = mkdtempSync(join(tmpdir(), 'jaren-adoption-recovery-'));
  const recovery = timed(() => {
    const file = join(dir, 'receipt.sqlite');
    try {
      const child = spawnSync(process.execPath, ['--no-warnings=ExperimentalWarning',
        join(root, 'test/adoption/wal-writer.js'), file], { encoding: 'utf8', timeout: 10000 });
      assert.equal(child.status, 0, child.stderr);
      assert.ok(statSync(`${file}-wal`).size > 32);
      const reopened = new DatabaseSync(file);
      try { assert.equal(reopened.prepare('SELECT count(*) AS n FROM history').get().n, 2); }
      finally { reopened.close(); }
    }
    finally { rmSync(dir, { recursive: true, force: true }); }
  });
  const formulas = readAdoption('fixtures/formulas.json');
  const originalFormulas = JSON.stringify(formulas);
  let errors = 0;
  const evaluation = timed(() => {
    for (const formula of formulas.formulas) {
      if (!formula.enabled) continue;
      try { trustedBodies[formula.id](formula.input, { SKIP }); }
      catch { errors++; }
    }
  });
  const providers = readAdoption('fixtures/providers.json').dialects.map((dialect) => ({
    dialect: dialect.id, ...readProviderTranscript(dialect),
  }));
  sample();
  const teardown = timed(() => { cold.value.removeAll(); warm.value.removeAll(); });
  assert.equal(cold.value.documentCount + warm.value.documentCount, 0);
  const metrics = {
    relational: { statements, queryMs, recoveryMs: recovery.ms },
    search: { startupMs, coldIndexMs: cold.ms, warmIndexMs: warm.ms,
      queryMs: Math.max(...queries.map((query) => query.medianMs)), sourceBytes: Buffer.byteLength(encoded),
      indexBytes: Buffer.byteLength(snapshot), browserGzipBytes: bundles.search },
    grid: { interactionMs: Math.max(...grids.map((grid) => grid.interactionMs)), mountedCells: null,
      loadedRows: null, loadedBytes: null, browserGzipBytes: bundles.grid },
    formulas: { evaluationMs: evaluation.ms, errors, originalByteChanges: originalFormulas === JSON.stringify(formulas) ? 0 : 1 },
    providers: { pages: Math.max(...providers.map((provider) => provider.pages.length)),
      rows: Math.max(...providers.map((provider) => provider.ids.length)),
      bytes: Math.max(...providers.map((provider) => Buffer.byteLength(JSON.stringify(provider.pages)))),
      attempts: null, unresolvedResends: null },
    resources: { sampledHeapBytes, peakRssBytes: process.resourceUsage().maxRSS * 1024,
      peakHeapBytes: null, teardownMs: teardown.ms, remainingHandles: null },
  };
  const budgets = Object.fromEntries(Object.entries(consumer.budgets).map(([stage, limits]) => [stage, assessBudget(limits, metrics[stage])]));
  return { consumer: consumer.id, workloadHash: consumer.workloadHash, rows: consumer.rows,
    metrics, budgets, queries, grids, plans, providers: providers.map(({ pages, ...rest }) => ({ ...rest, pages: pages.length })),
    limitations: ['sampled heap is a lower bound, exact peak heap pending',
      'grid timings are headless retained ranges; mounted cells, interactions and provider caches need browser/native evidence',
      'formula and provider timings cover the small labelled subsets; full saved corpus and production effects are pending',
      'relational statement budget counts the six reads and three first mutations; seed, EXPLAIN and second-run checks are separate instrumentation',
      'reference losses do not change frozen ceilings or qualify native replacements'] };
}

if (childId) {
  console.log(JSON.stringify(await measure(manifest.consumers.find((consumer) => consumer.id === childId))));
}
else {
  const consumers = [];
  for (const consumer of manifest.consumers) {
    const child = spawnSync(process.execPath, ['--no-warnings=ExperimentalWarning', fileURLToPath(import.meta.url), `--consumer=${consumer.id}`],
      { cwd: root, encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
    assert.equal(child.status, 0, child.stderr);
    consumers.push(JSON.parse(child.stdout));
  }
  const report = { format: 'jaren-adoption-report/1', freezeHash: manifest.freezeHash,
    runtime: { node: process.version, sqlite: process.versions.sqlite, platform: process.platform, arch: process.arch,
      cpu: cpus()[0].model, logicalCpus: cpus().length, availableParallelism: availableParallelism(),
      totalMemoryBytes: totalmem(), osRelease: release() },
    runnerHash: adoptionHash(readFileSync(fileURLToPath(import.meta.url))),
    evidence: { automatedReference: 'pass', ...manifest.replacementEvidence }, consumers };
  if (args.includes('--write')) writeFileSync(new URL('adoption-result.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
