//@ts-check
/**
 * @file The packed-consumer release gate.
 *
 * The monorepo masks dependency-closure defects: a package can import a
 * sibling it never declared, because every sibling is always installed
 * at the workspace root. This gate reproduces what a REAL consumer
 * experiences: for every publishable package it
 *
 *   1. packs the tarball (`npm pack`),
 *   2. installs it in a fresh directory with ONLY its declared
 *      `@jarenjs/*` dependency closure (extracted from the packed
 *      tarballs, nothing hoisted, nothing extra),
 *   3. imports every public export subpath under plain Node ESM,
 *   4. repeats the imports under Bun when a `bun` binary is on PATH
 *      (consumers ship Bun single-binaries).
 *
 * An undeclared import fails here with ERR_MODULE_NOT_FOUND even though
 * the workspace test suite passes — exactly the class of defect this
 * gate exists to catch. Wildcard export patterns (`./x/*`) and
 * non-JavaScript subpaths (schemas, package.json) are skipped; the
 * entry points and named subpaths are the contract under test.
 *
 * Run: `node scripts/check-packed-consumers.js` (or `npm run test:packed`).
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;

/** Publishable workspaces: every non-private workspace package. */
function publishableWorkspaces() {
  const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const dirs = rootPkg.workspaces
    .map((w) => w.replace(/^\.\//, ''))
    .filter((w) => !w.startsWith('benchmark'));
  const packages = [];
  for (const dir of dirs) {
    const pkg = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'));
    if (pkg.private === true) continue;
    packages.push({ dir, name: pkg.name, pkg });
  }
  return packages;
}

/** The importable export subpaths of a package (no wildcards/assets). */
function importSubpaths(pkg) {
  const subpaths = [];
  const exports = pkg.exports ?? { '.': pkg.main ?? './src/index.js' };
  for (const key of Object.keys(exports)) {
    if (key.includes('*')) continue;
    if (key === './package.json') continue;
    const target = typeof exports[key] === 'string'
      ? exports[key]
      : exports[key]?.default ?? exports[key]?.import;
    if (typeof target !== 'string' || !target.endsWith('.js')) continue;
    subpaths.push(key === '.' ? pkg.name : pkg.name + key.slice(1));
  }
  return subpaths;
}

/** The transitive DECLARED `@jarenjs/*` dependency closure of a package. */
function declaredClosure(byName, name, seen = new Set()) {
  if (seen.has(name)) return seen;
  seen.add(name);
  const entry = byName.get(name);
  if (entry === undefined) {
    throw new Error(`${name} is declared as a dependency but is not a publishable workspace`);
  }
  for (const dep of Object.keys(entry.pkg.dependencies ?? {})) {
    if (dep.startsWith('@jarenjs/')) declaredClosure(byName, dep, seen);
  }
  return seen;
}

const packages = publishableWorkspaces();
const byName = new Map(packages.map((entry) => [entry.name, entry]));
const work = mkdtempSync(join(tmpdir(), 'jaren-packed-'));
const tarballDir = join(work, 'tarballs');
mkdirSync(tarballDir);

console.log(`Packing ${packages.length} packages...`);
/** @type {Map<string, string>} package name → tarball path */
const tarballs = new Map();
for (const { dir, name } of packages) {
  const out = execFileSync('npm', ['pack', '--silent', '--pack-destination', tarballDir],
    { cwd: join(root, dir), encoding: 'utf8' }).trim().split('\n').pop();
  tarballs.set(name, join(tarballDir, /** @type {string} */ (out)));
}

const bun = spawnSync('bun', ['--version'], { encoding: 'utf8' }).status === 0;
if (!bun) console.log('(no bun binary on PATH — the Bun consumer leg is skipped)');

let failures = 0;
for (const { name, pkg } of packages) {
  const consumerDir = join(work, name.replace('/', '__'));
  const modulesDir = join(consumerDir, 'node_modules');
  mkdirSync(modulesDir, { recursive: true });
  writeFileSync(join(consumerDir, 'package.json'),
    JSON.stringify({ name: 'consumer', private: true, type: 'module' }));

  // install ONLY the declared closure, from the packed tarballs
  for (const dep of declaredClosure(byName, name)) {
    const dest = join(modulesDir, dep);
    mkdirSync(dest, { recursive: true });
    execFileSync('tar', ['-xzf', /** @type {string} */ (tarballs.get(dep)),
      '--strip-components=1', '-C', dest]);
  }

  const subpaths = importSubpaths(pkg);
  const program = subpaths.map((s) => `await import(${JSON.stringify(s)});`).join('\n');

  const node = spawnSync(process.execPath, ['--input-type=module', '-e', program],
    { cwd: consumerDir, encoding: 'utf8' });
  if (node.status !== 0) {
    failures++;
    console.error(`✗ ${name} (node): ${node.stderr.split('\n').find((l) => l.trim() !== '') ?? 'failed'}`);
    continue;
  }

  if (bun) {
    const bunRun = spawnSync('bun', ['-e', program],
      { cwd: consumerDir, encoding: 'utf8' });
    if (bunRun.status !== 0) {
      failures++;
      console.error(`✗ ${name} (bun): ${bunRun.stderr.split('\n').find((l) => l.trim() !== '') ?? 'failed'}`);
      continue;
    }
  }

  console.log(`✓ ${name} — ${subpaths.length} subpath(s), closure of ${declaredClosure(byName, name).size} package(s)${bun ? ', node+bun' : ''}`);
}

rmSync(work, { recursive: true, force: true });
if (failures > 0) {
  console.error(`\n${failures} package(s) failed the packed-consumer gate.`);
  process.exit(1);
}
console.log('\nEvery packed package imports cleanly from its declared closure.');
