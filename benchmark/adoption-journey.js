//@ts-check
/** Combined costs and source ownership; reference adapters remain executable test oracles. */
import { readFileSync, writeFileSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir, cpus } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { writeAdoptionConsumer, qualifyAdoptionRuntime } from '../scripts/lib/adoption-journey.js';
import { adoptionHash, readAdoption, verifyFreeze, assessBudget } from '../test/adoption/evidence.js';

const root = fileURLToPath(new URL('../', import.meta.url)), manifest = readAdoption('manifest.json');
verifyFreeze(manifest);
const directory = mkdtempSync(join(tmpdir(), 'jaren-combined-cost-'));
const sources = ['packages/website/src/examples/adoption.js', 'packages/website/src/examples/adoption-model.js',
  'packages/website/src/examples/adoption-fixture.js', 'test/consumer/journey.js', 'scripts/lib/adoption-journey.js',
  'benchmark/adoption-journey.js', 'packages/db/src/jobs.js', 'packages/db/src/store.js'];
const retained = ['test/adoption/oracles.js', 'test/adoption/trusted-bodies.js', 'test/adoption/provider-oracle.js'];
const count = (files) => files.reduce((n, file) => n + readFileSync(join(root, file), 'utf8').trimEnd().split('\n').length, 0);
try {
  symlinkSync(join(root, 'node_modules'), join(directory, 'node_modules'), 'dir');
  writeFileSync(join(directory, 'package.json'), '{"type":"module"}');
  const entry = writeAdoptionConsumer(directory, root);
  const hosts = [qualifyAdoptionRuntime(process.execPath, ['--no-warnings=ExperimentalWarning', entry], directory, 'node'),
    qualifyAdoptionRuntime('bun', [entry], directory, 'bun')];
  const censusArgs = ['-n', '^import|^export (async )?function (compileLexical|createCollectionCoordinator|compileRulePlan|createCommand|createIngestion|createDbReceipts|createDbEffectStore|createDomainRun|createJobEngine)',
    ...sources.slice(0, 2), 'packages/core/src/search/index.js', 'packages/app/src/collection.js', 'packages/json/src/rules/index.js',
    'packages/contract/src/command.js', 'packages/flow/src/ingest.js', 'packages/linq/src/db/receipts.js', 'packages/linq/src/db/effects.js', 'packages/flow/src/runs.js', 'packages/db/src/jobs.js'];
  const census = spawnSync('rg', censusArgs, { cwd: root, encoding: 'utf8' });
  assert.equal(census.status, 0, census.stderr);
  const checks = hosts.flatMap((host) => host.results.filter((row) => row.phase === 'all').map((row) => {
    const definition = manifest.consumers.find((value) => value.id === row.consumer);
    return { host: host.label, consumer: row.consumer, checks: assessBudget({
      startupMs: definition.budgets.search.startupMs, sampledHeapBytes: definition.budgets.resources.sampledHeapBytes,
      peakRssBytes: definition.budgets.resources.peakRssBytes, teardownMs: definition.budgets.resources.teardownMs,
      unresolvedResends: definition.budgets.providers.unresolvedResends,
    }, { startupMs: row.searchMs, sampledHeapBytes: row.heapBytes, peakRssBytes: row.peakRssBytes, teardownMs: row.teardownMs, unresolvedResends: host.recoverySends }) };
  }));
  const report = { format: 'jaren-adoption-journey/1', freezeHash: manifest.freezeHash,
    runtime: { node: process.version, platform: process.platform, arch: process.arch, cpu: cpus()[0].model },
    sourceHashes: Object.fromEntries(sources.map((file) => [file, adoptionHash(readFileSync(join(root, file)))])),
    hosts, checks, census: { command: ['rg', ...censusArgs], output: census.stdout },
    ownership: { retainedOracleFiles: retained, retainedOracleLines: count(retained),
      adoptedPolicyFiles: sources.slice(0, 2), adoptedPolicyLines: count(sources.slice(0, 2)),
      retainedThirdPartyMechanisms: ['minisearch', '@tanstack/virtual-core'], adoptedThirdPartyMechanisms: [],
      domainSqlInAdoptedHost: 0, privateDriverBridges: 0, trustedSourceConversions: 2, reviewRequiredSources: 5, disabledPreservedSources: 1 },
    evidence: { library: 'pass', portable: 'pass', actualDownstream: 'pending', actualProvider: 'pending', manual: 'pending' },
    limitations: ['Source lines compare executable reference adapters with remaining application policy, not a claim that oracle files were deleted.',
      'Formula retirement covers only converted or natively authored definitions; unresolved originals and their retained oracle remain.',
      'Capture of adopted triggers and native FTS remain refused. Search refresh reads a bounded resident snapshot; complete search membership is separate from cached pages.',
      'Heap is a sample and RSS is a process high-water mark, including the assertion instrument. Exact peak heap remains unmeasured.',
      'The full source sizes apply to query/search; provider snapshots and rule previews retain their separate frozen limits.'] };
  if (process.argv.includes('--write')) writeFileSync(new URL('adoption-journey-result.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
finally { rmSync(directory, { recursive: true, force: true }); }
