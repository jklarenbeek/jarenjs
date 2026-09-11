//@ts-check
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { adoptionHash, readAdoption } from './evidence.js';

it('combined and executable evidence names the current source, unchanged workloads and explicit qualifications', () => {
  const manifest = readAdoption('manifest.json');
  for (const name of ['adoption-journey-result', 'adoption-hosts-result']) {
    const report = JSON.parse(readFileSync(new URL(`../../benchmark/${name}.json`, import.meta.url), 'utf8'));
    assert.equal(report.freezeHash, manifest.freezeHash);
    for (const [file, hash] of Object.entries(report.sourceHashes))
      assert.equal(adoptionHash(readFileSync(new URL(`../../${file}`, import.meta.url))), hash, `stale combined measurement: ${file}`);
    const hosts = report.hosts ?? report.report;
    assert.ok(hosts.length >= 2);
    for (const host of hosts) {
      for (const consumer of manifest.consumers) {
        const row = host.results.find((row) => row.consumer === consumer.id && row.phase === 'all');
        assert.equal(row.rows, consumer.rows);
        assert.equal(row.startupDDL, 0); assert.equal(row.secondWrites, 0);
        assert.equal(row.secondRevisions, 0); assert.ok(row.elapsedMs > 0 && row.heapBytes > 0 && row.peakRssBytes > 0);
      }
      assert.equal(host.crashExit, 73); assert.equal(host.remoteSends, 2); assert.equal(host.recoverySends, 0);
    }
  }
  const report = JSON.parse(readFileSync(new URL('../../benchmark/adoption-journey-result.json', import.meta.url), 'utf8'));
  assert.equal(report.evidence.actualDownstream, 'pending'); assert.equal(report.evidence.actualProvider, 'pending');
  assert.equal(report.evidence.manual, 'pending'); assert.ok(report.census.command.length > 2);
  for (const file of report.ownership.adoptedPolicyFiles) {
    const source = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /minisearch|@tanstack|trusted-bodies|\.sql\b|(?:db|connection|driver)\.prepare\(/);
    assert.ok([...source.matchAll(/from '([^']+)'/g)].every((match) => match[1].startsWith('@jarenjs/') || match[1].startsWith('./adoption-model')));
  }
});
