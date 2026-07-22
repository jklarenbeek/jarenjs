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
 *   3. imports every explicit JavaScript export subpath under plain
 *      Node ESM,
 *   4. type-checks a strict TypeScript consumer of the same subpaths
 *      against the packed declarations (`tsc --noEmit`, strict, no
 *      `skipLibCheck`),
 *   5. repeats the runtime imports under Bun when a `bun` binary is on
 *      PATH (consumers ship Bun single-binaries); `--require-bun`
 *      makes a missing Bun a gate FAILURE (release CI must pass it —
 *      an optional leg cannot prove a release claim).
 *
 * An undeclared import fails here with ERR_MODULE_NOT_FOUND even though
 * the workspace test suite passes — exactly the class of defect this
 * gate exists to catch; a declaration missing from a tarball fails the
 * TypeScript leg the same way. The claim under test is "every explicit
 * JavaScript export key" — wildcard export patterns (`./x/*`) and
 * non-JavaScript subpaths (schemas, package.json) are NOT covered.
 *
 * Portability: paths derive from `fileURLToPath` (a URL `pathname` is
 * not a Windows filesystem path), npm runs through its own JS
 * entrypoint (`npm_execpath`) under the current Node executable (the
 * Windows `npm` shim is not a portable `execFileSync` target), and the
 * temporary work directory is removed in `finally`, also on failure.
 *
 * Run: `node scripts/check-packed-consumers.js [--require-bun]`
 * (or `npm run test:packed`).
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const requireBun = process.argv.includes('--require-bun');

/**
 * Run the npm CLI portably: through its own JS entrypoint under the
 * current Node when launched from an npm script (`npm_execpath`), else
 * through the platform binary as a deliberate direct-execution
 * fallback (`npm.cmd` needs a shell on Windows).
 * @param {string[]} args
 * @param {string} cwd
 * @returns {string}
 */
function npm(args, cwd) {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath !== undefined && npmExecPath.endsWith('.js')) {
    return execFileSync(process.execPath, [npmExecPath, ...args], { cwd, encoding: 'utf8' });
  }
  const bin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  return execFileSync(bin, args, {
    cwd, encoding: 'utf8', shell: process.platform === 'win32',
  });
}

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

const tscBin = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
if (!existsSync(tscBin)) {
  console.error('the TypeScript compiler is not installed at the workspace root; '
    + 'the packed-declaration leg cannot run (npm ci first)');
  process.exit(1);
}

const bunProbe = spawnSync('bun', ['--version'], {
  encoding: 'utf8', shell: process.platform === 'win32',
});
const bun = bunProbe.status === 0;
if (!bun && requireBun) {
  console.error('--require-bun: no bun binary on PATH — the Bun consumer leg is mandatory in release mode.');
  process.exit(1);
}
if (!bun) console.log('(no bun binary on PATH — the Bun consumer leg is skipped)');

const packages = publishableWorkspaces();
const byName = new Map(packages.map((entry) => [entry.name, entry]));
const work = mkdtempSync(join(tmpdir(), 'jaren-packed-'));
let failures = 0;

try {
  const tarballDir = join(work, 'tarballs');
  mkdirSync(tarballDir);

  console.log(`Packing ${packages.length} packages...`);
  /** @type {Map<string, string>} package name → tarball path */
  const tarballs = new Map();
  for (const { dir, name } of packages) {
    const out = npm(['pack', '--silent', '--pack-destination', tarballDir], join(root, dir))
      .trim().split('\n').pop();
    tarballs.set(name, join(tarballDir, /** @type {string} */ (out)));
  }

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

    // strict TypeScript consumer against the PACKED declarations: every
    // explicit JS subpath must resolve a declaration from the tarball
    writeFileSync(join(consumerDir, 'consumer.ts'),
      subpaths.map((s, i) => `import * as m${i} from ${JSON.stringify(s)};\nvoid m${i};`).join('\n') + '\n');
    writeFileSync(join(consumerDir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {
        noEmit: true, strict: true, skipLibCheck: false,
        module: 'nodenext', moduleResolution: 'nodenext',
        target: 'esnext', lib: ['esnext', 'dom'],
      },
      files: ['consumer.ts'],
    }));
    const tsc = spawnSync(process.execPath, [tscBin, '--noEmit', '-p', consumerDir],
      { cwd: consumerDir, encoding: 'utf8' });
    if (tsc.status !== 0) {
      failures++;
      console.error(`✗ ${name} (types): ${tsc.stdout.split('\n').find((l) => l.trim() !== '') ?? 'failed'}`);
      continue;
    }

    if (bun) {
      const bunRun = spawnSync('bun', ['-e', program], {
        cwd: consumerDir, encoding: 'utf8', shell: process.platform === 'win32',
      });
      if (bunRun.status !== 0) {
        failures++;
        console.error(`✗ ${name} (bun): ${bunRun.stderr.split('\n').find((l) => l.trim() !== '') ?? 'failed'}`);
        continue;
      }
    }

    console.log(`✓ ${name} — ${subpaths.length} subpath(s), closure of ${declaredClosure(byName, name).size} package(s), node+types${bun ? '+bun' : ''}`);
  }
}
finally {
  rmSync(work, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} package(s) failed the packed-consumer gate.`);
  process.exit(1);
}
console.log('\nEvery explicit JavaScript export key of every packed package imports and type-checks from its declared closure.');
