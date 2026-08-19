//@ts-check
/**
 * @file The version-packages drift gate. `scripts/version-packages.js`
 * bumps a hand-maintained list of manifests; the root `package.json`
 * `workspaces` is the other list of what the suite ships. Nothing kept
 * them in agreement, and on 2026-08-19 the 22nd package had been
 * registered in `clean`/`pack:check`/`publish` but not here, so a
 * close-out left it a version behind. This gate holds the script's list
 * equal, as a set, to the `package.json` of every non-private workspace,
 * and pins that the root manifest is bumped with them.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';

import { packageFiles, rangeOnlyFiles, rootFile } from '../../scripts/version-packages.js';

/** The `package.json` path of every workspace the root manifest declares. */
function workspaceManifests() {
  const root = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  return root.workspaces.map((/** @type {string} */ w) => `${w.replace(/^\.\//, '')}/package.json`);
}

describe('version-packages manifest list agrees with the workspaces', () => {
  const manifests = workspaceManifests();
  const publishable = manifests.filter((file) => JSON.parse(fs.readFileSync(file, 'utf8')).private !== true);
  const privates = manifests.filter((file) => !publishable.includes(file));

  it('the script bumps exactly the non-private workspaces', () => {
    assert.deepStrictEqual([...packageFiles].sort(), [...publishable].sort());
  });

  it('no private workspace is versioned; the range-only list names only existing manifests', () => {
    for (const file of privates) assert.ok(!packageFiles.includes(file), `${file} is private and must not be versioned`);
    for (const file of rangeOnlyFiles) assert.ok(fs.existsSync(file), `${file} does not exist`);
  });

  it('the root manifest is bumped with the packages and carries the suite version', () => {
    assert.strictEqual(rootFile, 'package.json');
    const version = JSON.parse(fs.readFileSync(rootFile, 'utf8')).version;
    for (const file of packageFiles) {
      assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).version, version, `${file} is not at the suite version ${version}`);
    }
  });
});
