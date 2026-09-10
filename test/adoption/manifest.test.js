//@ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { adoptionRows } from '../../scripts/lib/adoption.js';
import { adoptionHash, readAdoption, verifyFreeze, assessBudget, replacementReady } from './evidence.js';

const manifest = readAdoption('manifest.json');
describe('frozen portable evidence', () => {
  it('Git clean filters preserve exact trusted-body CRLF bytes on fresh checkouts', () => {
    const file = 'test/adoption/trusted-bodies.js';
    const root = fileURLToPath(new URL('../../', import.meta.url));
    assert.ok(readFileSync(new URL('trusted-bodies.js', import.meta.url), 'utf8').includes('\r\n'));
    const hash = (args) => execFileSync('git', ['hash-object', ...args, file], { cwd: root, encoding: 'utf8' });
    assert.equal(hash(['--path', file]), hash(['--no-filters']));
  });
  it('pins artifacts, source families, seed, host and independent consumer hashes', () => {
    verifyFreeze(manifest);
    assert.equal(manifest.freezeHash, 'fba6d22f7d055476f7f4ef3d5fa5c7a51e372b3b0266a269e8713c9ec4b3d2b2');
    assert.equal(manifest.categories.length, 5);
    assert.ok(manifest.consumers[1].rows > manifest.consumers[0].rows);
    assert.notDeepEqual(manifest.consumers[0].policy, manifest.consumers[1].policy);
    for (const consumer of manifest.consumers) {
      const rows = adoptionRows(consumer);
      assert.equal(adoptionHash(JSON.stringify(rows)), consumer.workloadHash);
      assert.equal(adoptionHash(JSON.stringify(adoptionRows(consumer))), consumer.workloadHash);
      assert.equal(rows.filter((row) => row.provenance === 'manual').length, Math.ceil(consumer.rows / consumer.policy.protectedEvery));
    }
    for (const category of manifest.categories) {
      assert.ok(category.families.length > 0 && category.pending.length > 0 && category.publicRecipe.length > 0);
      assert.ok(category.fixtures.every((name) => manifest.artifacts[`test/adoption/fixtures/${name}.json`]));
    }
    const census = readAdoption('source-census.json');
    assert.ok(census.families.every((family) => family.matches.length > 0));
    assert.equal(census.revision, manifest.revision);
  });
  it('refuses edited fixtures or budgets and does not convert absent evidence to pass', () => {
    const changed = structuredClone(manifest); changed.consumers[0].budgets.grid.mountedCells++;
    assert.throws(() => verifyFreeze(changed), /manifest freeze changed/);
    changed.artifacts['scripts/lib/adoption.js'] = 'wrong';
    assert.throws(() => verifyFreeze(changed), /frozen artifact changed/);
    assert.deepEqual(assessBudget({ work: 3 }, {}).map((row) => row.status), ['pending']);
    assert.deepEqual(assessBudget({ work: 3 }, { work: 4 }).map((row) => row.status), ['fail']);
    assert.deepEqual(assessBudget({ work: 3 }, { work: NaN }).map((row) => row.status), ['fail']);
    assert.deepEqual(assessBudget({ work: 3 }, { work: 3 }).map((row) => row.status), ['pass']);
    assert.equal(replacementReady(manifest.replacementEvidence), false);
    assert.equal(replacementReady({ library: 'pass', portableConsumer: 'pass', liveHost: 'pass' }), false);
    assert.equal(replacementReady({ library: 'pass', portableConsumer: 'pass', liveHost: 'pass', manualOperator: 'pass' }), true);
  });
  it('pins exact oracle versions and licenses in development tooling only', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../benchmark/package.json', import.meta.url), 'utf8'));
    const lock = JSON.parse(readFileSync(new URL('../../package-lock.json', import.meta.url), 'utf8'));
    for (const oracle of manifest.oracles.filter((entry) => entry.scope === 'benchmark devDependencies')) {
      assert.equal(pkg.devDependencies[oracle.name], oracle.version);
      assert.equal(lock.packages[`node_modules/${oracle.name}`].version, oracle.version);
      assert.equal(lock.packages[`node_modules/${oracle.name}`].license, oracle.license);
      assert.equal(lock.packages[`node_modules/${oracle.name}`].dev, true);
    }
  });
  it('keeps measurements tied to their runner and freeze, with all losses and pending metrics', () => {
    const report = JSON.parse(readFileSync(new URL('../../benchmark/adoption-result.json', import.meta.url), 'utf8'));
    assert.equal(report.freezeHash, manifest.freezeHash);
    assert.equal(report.runnerHash, adoptionHash(readFileSync(new URL('../../benchmark/adoption.js', import.meta.url))));
    assert.equal(report.consumers.length, manifest.consumers.length);
    for (const consumer of manifest.consumers) {
      const measured = report.consumers.find((row) => row.consumer === consumer.id);
      assert.equal(measured.workloadHash, consumer.workloadHash);
      assert.equal(measured.rows, consumer.rows);
      for (const [stage, limits] of Object.entries(consumer.budgets))
        assert.deepEqual(measured.budgets[stage], assessBudget(limits, measured.metrics[stage]));
      assert.ok(measured.metrics.search.browserGzipBytes > 1000);
    }
    assert.equal(replacementReady(report.evidence), false);
  });
});
