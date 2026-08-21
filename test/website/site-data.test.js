//@ts-check
/**
 * @file The site's generated data, gated: the package census the docs
 * rail renders and the build provenance the footer shows.
 *
 * The census exists because the site used to keep its package list as
 * source, and source drifts — three published workspaces were missing
 * from it. So the gate is not "the generator runs": it is that the
 * census equals the root manifest's public workspaces, walked here
 * INDEPENDENTLY of the generator. Add a workspace and forget the site,
 * and this suite fails.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { buildSiteData, serializeSiteData } from '../../scripts/generate-site-data.js';
import { buildInfo } from '../../scripts/generate-build-info.js';
import { git, headCommit, isDirty } from '../../scripts/lib/git.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (...parts) => JSON.parse(readFileSync(join(ROOT, ...parts), 'utf8'));

/** The public workspaces, walked from the root manifest without the generator. */
function publicWorkspaces() {
  return read('package.json').workspaces
    .map((/** @type {string} */ entry) => entry.replace(/^\.\//, ''))
    .filter((/** @type {string} */ dir) => read(dir, 'package.json').private !== true);
}

describe('the package census (scripts/generate-site-data.js)', function () {
  it('lists exactly the root manifest\'s public workspaces, in manifest order', function () {
    const census = buildSiteData();
    const dirs = publicWorkspaces();
    assert.deepStrictEqual(census.packages.map((p) => p.dir), dirs,
      'a workspace added to the root manifest must appear on the site');
    for (const entry of census.packages) {
      const manifest = read(entry.dir, 'package.json');
      assert.strictEqual(entry.name, manifest.name);
      assert.strictEqual(entry.version, manifest.version);
      assert.strictEqual(entry.description, manifest.description);
    }
    // the three newest workspaces are the reason this gate exists
    const names = census.packages.map((p) => p.name);
    for (const name of ['@jarenjs/contract', '@jarenjs/studio', '@jarenjs/play']) {
      assert.ok(names.includes(name), `${name} is in the census`);
    }
    assert.ok(!names.includes('@jarenjs/website'), 'private workspaces stay out of a published list');
  });

  it('names a directory that really carries the README the site links to', function () {
    for (const entry of buildSiteData().packages) {
      assert.ok(existsSync(join(ROOT, entry.dir, 'README.md')),
        `${entry.name}: ${entry.dir}/README.md exists`);
    }
  });

  it('describes every package — the rail has no blank tooltips', function () {
    for (const entry of buildSiteData().packages) {
      assert.ok(typeof entry.description === 'string' && entry.description.trim() !== '',
        `${entry.name} carries a description`);
    }
  });

  it('is byte-identical run over run — the timestamp is the commit, not the clock', function () {
    const first = serializeSiteData(buildSiteData());
    const second = serializeSiteData(buildSiteData());
    assert.strictEqual(first, second);
    const { commit, committed } = headCommit();
    const census = buildSiteData();
    assert.strictEqual(census.commit, commit);
    assert.strictEqual(census.generated, committed);
  });
});

describe('the build provenance (scripts/generate-build-info.js)', function () {
  it('carries the version, the revision and the commit date the footer prints', function () {
    const info = buildInfo();
    assert.strictEqual(info.version, read('package.json').version);
    assert.strictEqual(info.commit, git('rev-parse', 'HEAD'));
    assert.match(info.built, /^\d{4}-\d{2}-\d{2}T/);
  });

  it('claims reproducible only for a committed revision AND a clean tree', function () {
    const dirty = isDirty();
    const expected = headCommit().committed !== null && dirty === false;
    assert.strictEqual(buildInfo().reproducible, expected,
      'uncommitted changes are in the bundle but not in the commit it names');
  });

  it('records the runtime it was built on as a build-environment fact', function () {
    const info = buildInfo();
    assert.strictEqual(info.node, process.version);
    assert.strictEqual(info.platform, `${process.platform} ${process.arch}`);
  });
});
