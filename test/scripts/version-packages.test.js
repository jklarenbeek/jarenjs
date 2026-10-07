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
 *
 * It also holds the internal edges exact. The suite is released in
 * lockstep, so every `@jarenjs/*` edge names the suite version itself: a
 * range let a consumer's resolution mix packages of two releases. An exact
 * edge is only safe while it equals the workspace's version — otherwise
 * npm quietly fetches the registry tarball into a nested `node_modules`
 * and the workspace link stops being what runs — so the lockfile half
 * proves every `@jarenjs/*` package is a root-level workspace link.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

import { compareVersions, dependencyFields, packageFiles, rangeOnlyFiles, rootFile, updateInternalRanges } from '../../scripts/version-packages.js';

/**
 * Every internal edge of the given manifests that is not the exact suite version.
 * @param {{ file: string, manifest: Record<string, any> }[]} manifests
 * @param {string} version
 * @returns {string[]}
 */
function internalEdgeDrift(manifests, version) {
  const drift = [];
  for (const { file, manifest } of manifests) {
    for (const field of dependencyFields) {
      for (const [name, range] of Object.entries(manifest[field] ?? {})) {
        if (name.startsWith('@jarenjs/') && range !== version) drift.push(`${file} ${field} ${name}: ${range}`);
      }
    }
  }
  return drift;
}

/**
 * Every `@jarenjs/*` lockfile entry that is not a root-level workspace link,
 * and every workspace entry whose recorded internal edge is not exact.
 * @param {{ packages?: Record<string, any> }} lock
 * @param {string} version
 * @returns {string[]}
 */
function lockfileDrift(lock, version) {
  const drift = [];
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    const at = key.lastIndexOf('node_modules/@jarenjs/');
    if (at > 0) drift.push(`${key} is a nested copy (${entry.version ?? '?'}${entry.resolved ? ` from ${entry.resolved}` : ''})`);
    else if (at === 0 && entry.link !== true) drift.push(`${key} is not a workspace link (${entry.resolved ?? entry.version ?? '?'})`);
    else if (at === -1 && !key.includes('node_modules/')) {
      for (const field of dependencyFields) {
        for (const [name, range] of Object.entries(entry[field] ?? {})) {
          if (name.startsWith('@jarenjs/') && !String(range).startsWith('file:') && range !== '*' && range !== version) {
            drift.push(`lockfile entry '${key}' records ${field} ${name}: ${range}`);
          }
        }
      }
    }
  }
  return drift;
}

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

describe('internal edges are the exact suite version', () => {
  const version = JSON.parse(fs.readFileSync(rootFile, 'utf8')).version;

  it('every @jarenjs/* edge of the root and the publishable manifests is exact', () => {
    const manifests = [rootFile, ...packageFiles].map((file) => ({ file, manifest: JSON.parse(fs.readFileSync(file, 'utf8')) }));
    assert.deepStrictEqual(internalEdgeDrift(manifests, version), []);
  });

  it('the lockfile links every @jarenjs/* package to its workspace and records exact edges', () => {
    assert.deepStrictEqual(lockfileDrift(JSON.parse(fs.readFileSync('package-lock.json', 'utf8')), version), []);
  });

  it('the checks name a caret edge, a nested registry copy and an unlinked package', () => {
    const manifests = [{ file: 'packages/app/package.json', manifest: {
      dependencies: { '@jarenjs/core': '^0.92.0', 'left-pad': '^1.0.0' },
      peerDependencies: { '@jarenjs/db': '0.92.0' },
    } }];
    assert.deepStrictEqual(internalEdgeDrift(manifests, '0.92.0'), ['packages/app/package.json dependencies @jarenjs/core: ^0.92.0']);
    const lock = { packages: {
      '': { devDependencies: { '@jarenjs/core': '0.92.0' } },
      'packages/app': { dependencies: { '@jarenjs/core': '^0.92.0' } },
      'packages/website': { dependencies: { '@jarenjs/core': 'file:../core' } },
      'node_modules/@jarenjs/app': { resolved: 'packages/app', link: true },
      'node_modules/@jarenjs/core': { version: '0.91.4', resolved: 'https://registry.npmjs.org/@jarenjs/core/-/core-0.91.4.tgz' },
      'packages/app/node_modules/@jarenjs/json': { version: '0.91.4', resolved: 'https://registry.npmjs.org/@jarenjs/json/-/json-0.91.4.tgz' },
    } };
    assert.deepStrictEqual(lockfileDrift(lock, '0.92.0'), [
      "lockfile entry 'packages/app' records dependencies @jarenjs/core: ^0.92.0",
      'node_modules/@jarenjs/core is not a workspace link (https://registry.npmjs.org/@jarenjs/core/-/core-0.91.4.tgz)',
      'packages/app/node_modules/@jarenjs/json is a nested copy (0.91.4 from https://registry.npmjs.org/@jarenjs/json/-/json-0.91.4.tgz)',
    ]);
  });

  it('the writer pins every internal edge exactly and leaves the rest alone', () => {
    const manifest = {
      dependencies: { '@jarenjs/core': '^0.91.4', 'left-pad': '^1.3.0' },
      devDependencies: { '@jarenjs/json': '^0.91.4' },
      peerDependencies: { '@jarenjs/db': '^0.91.4' },
      peerDependenciesMeta: { '@jarenjs/db': { optional: true } },
    };
    const names = new Set(['@jarenjs/core', '@jarenjs/json', '@jarenjs/db']);
    let changed = 0;
    for (const field of dependencyFields) changed += updateInternalRanges(/** @type {any} */ (manifest)[field], names, '0.92.0');
    assert.strictEqual(changed, 3);
    assert.deepStrictEqual(manifest, {
      dependencies: { '@jarenjs/core': '0.92.0', 'left-pad': '^1.3.0' },
      devDependencies: { '@jarenjs/json': '0.92.0' },
      peerDependencies: { '@jarenjs/db': '0.92.0' },
      peerDependenciesMeta: { '@jarenjs/db': { optional: true } },
    });
    let again = 0;
    for (const field of dependencyFields) again += updateInternalRanges(/** @type {any} */ (manifest)[field], names, '0.92.0');
    assert.strictEqual(again, 0, 'a second run changes nothing');
  });

  it('`pin` rewrites the edges to the root version, changes no version, and is idempotent', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jaren-pin-'));
    try {
      const script = path.resolve('scripts/version-packages.js');
      const write = (/** @type {string} */ file, /** @type {object} */ value) => {
        fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
        fs.writeFileSync(path.join(dir, file), `${JSON.stringify(value, null, 2)}\n`);
      };
      write(rootFile, { name: 'suite', version: '1.2.3', devDependencies: { '@jarenjs/core': '^1.2.3' } });
      for (const file of packageFiles) {
        write(file, { name: `@jarenjs/${path.basename(path.dirname(file))}`, version: '1.2.3',
          dependencies: file === 'packages/core/package.json' ? {} : { '@jarenjs/core': '^1.2.2', 'left-pad': '^1.3.0' } });
      }
      const first = execFileSync(process.execPath, [script, 'pin'], { cwd: dir, encoding: 'utf8' });
      assert.match(first, new RegExp(`^Pinned ${packageFiles.length} internal edges to 1\\.2\\.3; no version changed\\.`));
      const bytes = () => [rootFile, ...packageFiles].map((file) => fs.readFileSync(path.join(dir, file), 'utf8'));
      const after = bytes();
      for (const text of after) {
        const manifest = JSON.parse(text);
        assert.strictEqual(manifest.version, '1.2.3');
        for (const field of dependencyFields) {
          for (const [name, range] of Object.entries(manifest[field] ?? {})) {
            assert.strictEqual(range, name.startsWith('@jarenjs/') ? '1.2.3' : '^1.3.0');
          }
        }
      }
      const second = execFileSync(process.execPath, [script, 'pin'], { cwd: dir, encoding: 'utf8' });
      assert.match(second, /^Pinned 0 internal edges to 1\.2\.3/);
      assert.deepStrictEqual(bytes(), after, 'the second run changes nothing');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('an explicit version moves the suite forward or is refused', () => {
  const script = path.resolve('scripts/version-packages.js');
  /** A disposable tree of every manifest the script writes, all at `version`. */
  function tree(/** @type {string} */ version) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jaren-version-'));
    const write = (/** @type {string} */ file, /** @type {object} */ value) => {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), `${JSON.stringify(value, null, 2)}\n`);
    };
    write(rootFile, { name: 'suite', version });
    for (const file of packageFiles) write(file, { name: `@jarenjs/${path.basename(path.dirname(file))}`, version });
    const bytes = () => [rootFile, ...packageFiles].map((file) => fs.readFileSync(path.join(dir, file), 'utf8'));
    return { dir, bytes, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
  }

  it('orders versions by semantic-version precedence, a pre-release before its release', () => {
    const ordered = ['0.9.9', '1.2.3-alpha', '1.2.3-alpha.1', '1.2.3-alpha.beta', '1.2.3-beta.2', '1.2.3-beta.11', '1.2.3-rc.1', '1.2.3', '1.2.10', '1.10.0', '2.0.0'];
    for (let i = 0; i < ordered.length; i++) {
      assert.strictEqual(compareVersions(ordered[i], ordered[i]), 0, ordered[i]);
      for (let j = i + 1; j < ordered.length; j++) {
        assert.ok(compareVersions(ordered[i], ordered[j]) < 0, `${ordered[i]} < ${ordered[j]}`);
        assert.ok(compareVersions(ordered[j], ordered[i]) > 0, `${ordered[j]} > ${ordered[i]}`);
      }
    }
  });

  it('refuses a downgrade, the current version, a pre-release of it and a non-version, writing nothing', () => {
    const t = tree('1.2.3');
    try {
      const before = t.bytes();
      for (const target of ['0.1.0', '1.2.2', '1.2.3', '1.2.3-rc.1']) {
        const result = spawnSync(process.execPath, [script, target], { cwd: t.dir, encoding: 'utf8' });
        assert.strictEqual(result.status, 2, `${target}: ${result.stdout}${result.stderr}`);
        assert.match(result.stderr, new RegExp(`refusing ${target.replace(/\./g, '\\.')}: a release must be greater than the current 1\\.2\\.3`));
      }
      for (const target of ['v1.3.0', '1.3', 'latest']) {
        const result = spawnSync(process.execPath, [script, target], { cwd: t.dir, encoding: 'utf8' });
        assert.strictEqual(result.status, 2, target);
        assert.match(result.stderr, /Usage: node scripts\/version-packages\.js patch\|minor\|major\|<version>\|pin/);
      }
      assert.deepStrictEqual(t.bytes(), before, 'nothing was written');
    }
    finally { t.cleanup(); }
  });

  it('refuses a target the semantic-version grammar does not admit, though it would sort higher', () => {
    // each sorts above 1.2.3, so only the grammar can refuse it: a leading
    // zero in a numeric part or a numeric pre-release identifier, an empty
    // identifier
    const t = tree('1.2.3');
    try {
      const before = t.bytes();
      for (const target of ['01.3.0', '1.03.0', '1.3.00', '1.3.0-a..b', '1.3.0-01', '1.3.0-rc.01', '1.3.0-rc.', '1.3.0-']) {
        const result = spawnSync(process.execPath, [script, target], { cwd: t.dir, encoding: 'utf8' });
        assert.strictEqual(result.status, 2, `${target}: ${result.stdout}${result.stderr}`);
        assert.match(result.stderr, new RegExp(`'${target.replace(/\./g, '\\.')}' is not a semantic version`), target);
        assert.match(result.stderr, /Usage: node scripts\/version-packages\.js patch\|minor\|major\|<version>\|pin/);
      }
      assert.deepStrictEqual(t.bytes(), before, 'nothing was written');
    }
    finally { t.cleanup(); }
  });

  it('takes a greater version, a pre-release of the next release included', () => {
    for (const target of ['1.2.4', '1.3.0-rc.1', '1.3.0-0', '1.3.0-0a.x-y', '2.0.0']) {
      const t = tree('1.2.3');
      try {
        execFileSync(process.execPath, [script, target], { cwd: t.dir, encoding: 'utf8' });
        for (const text of t.bytes()) assert.strictEqual(JSON.parse(text).version, target);
      }
      finally { t.cleanup(); }
    }
  });
});
