//@ts-check
/** Isolated installed/source host preparation and fail-closed executable qualification. */
import assert from 'node:assert/strict';
import { copyFileSync, writeFileSync, readFileSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { adoptionRows } from './adoption.js';
import { referenceSearch } from '../../test/adoption/oracles.js';

/** Copy application declarations, assertions and frozen inputs; resolution belongs to the destination. */
export function writeAdoptionConsumer(directory, root) {
  mkdirSync(directory, { recursive: true });
  for (const name of ['adoption', 'adoption-model', 'adoption-fixture'])
    copyFileSync(join(root, `packages/website/src/examples/${name}.js`), join(directory, `${name}.js`));
  copyFileSync(join(root, 'test/consumer/journey.js'), join(directory, 'journey.js'));
  copyFileSync(join(root, 'scripts/lib/adoption.js'), join(directory, 'adoption-rows.js'));
  const manifest = JSON.parse(readFileSync(join(root, 'test/adoption/manifest.json'), 'utf8'));
  const originals = JSON.parse(readFileSync(join(root, 'test/adoption/fixtures/formulas.json'), 'utf8')).formulas;
  const searchFixture = JSON.parse(readFileSync(join(root, 'test/adoption/fixtures/search.json'), 'utf8'));
  const expectedSearch = Object.fromEntries(manifest.consumers.map((definition) => {
    const rows = adoptionRows(definition).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const oracle = referenceSearch(searchFixture, rows);
    const hits = oracle.search('gren tea').map(({ id, score }) => ({ id, score: Number(score.toPrecision(12)) }));
    const hash = createHash('sha256').update(JSON.stringify(hits)).digest('hex');
    oracle.removeAll(); return [definition.id, hash];
  }));
  const file = join(directory, 'journey-entry.js');
  writeFileSync(file, `import { appendFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { nodeDriver } from '@jarenjs/db/node';
import { bunDriver } from '@jarenjs/db/bun';
import { openAdoption } from './adoption.js';
import { adoptionRule } from './adoption-model.js';
import { seedAdoptionFile } from './adoption-fixture.js';
import { adoptionRows } from './adoption-rows.js';
import { runAdoptionJourney } from './journey.js';
async function main() {
  const [phase, id, path] = process.argv.slice(-3);
  const definition = ${JSON.stringify(manifest.consumers)}.find((value) => value.id === id);
  if (!definition || !['all', 'crash', 'recover', 'verify'].includes(phase) || !path) throw new Error('Invalid journey arguments');
  if (phase !== 'all') definition.rows = 256;
  const result = await runAdoptionJourney({ openAdoption, seedAdoptionFile, adoptionRule,
    driver: process.versions.bun ? bunDriver() : nodeDriver(), path, definition, rows: adoptionRows(definition),
    originals: ${JSON.stringify(originals)}, phase,
    remote: (request) => appendFileSync(path + '.remote', JSON.stringify({ url: request.url, body: request.body }) + '\\n', { flush: true }),
    crash: phase === 'crash' ? () => process.exit(73) : undefined });
  if (phase === 'all') assert.equal(result.searchHash, ${JSON.stringify(expectedSearch)}[id], 'retained search membership/order/score parity');
  console.log(JSON.stringify({ ...result, runtime: process.versions.bun ?? process.version,
    heapBytes: process.memoryUsage().heapUsed, peakRssBytes: process.resourceUsage().maxRSS * 1024 }));
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
`);
  return file;
}

/** Every runner must complete both full workloads and recover a deliberately terminated catalog process. */
export function qualifyAdoptionRuntime(command, prefix, directory, label) {
  const run = (phase, id, path, status = 0) => {
    const result = spawnSync(command, [...prefix, phase, id, path], { cwd: directory, encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
    assert.equal(result.status, status, `${label}/${phase}/${id}: ${result.error ?? result.stderr}`);
    return status === 0 ? JSON.parse(result.stdout.trim()) : null;
  };
  const results = [];
  for (const id of ['catalog', 'archive-stock']) {
    const path = join(directory, `${label}-${id}.sqlite`);
    try { results.push(run('all', id, path)); run('verify', id, path); }
    finally { for (const suffix of ['', '-wal', '-shm', '.remote']) rmSync(path + suffix, { force: true }); }
  }
  const path = join(directory, `${label}-crash.sqlite`);
  try {
    run('crash', 'catalog', path, 73);
    assert.ok(statSync(path).size > 0);
    const remote = readFileSync(path + '.remote', 'utf8'); assert.equal(remote.trim().split('\n').length, 2);
    results.push(run('recover', 'catalog', path)); run('verify', 'catalog', path);
    assert.equal(readFileSync(path + '.remote', 'utf8'), remote, 'uncertain success must never be resent');
  }
  finally { for (const suffix of ['', '-wal', '-shm', '.remote']) rmSync(path + suffix, { force: true }); }
  return { label, results, crashExit: 73, remoteSends: 2, recoverySends: 0 };
}
