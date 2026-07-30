//@ts-check
/**
 * The source-consumer fixture.
 *
 * `check-packed-consumers.js` proves a REGISTRY-shaped consumer works: pack
 * the tarballs, install them, import them. That is the wrong shape for anyone
 * vendoring this repo as a git submodule, and it leaves the question they
 * actually care about unanswered:
 *
 *   **Did every `@jarenjs/*` import resolve to the vendored source, or did one
 *   of them quietly come from the registry?**
 *
 * That question is sharp for pnpm specifically. Internal edges in this repo
 * are ordinary semver ranges (`^0.22.26`), not the `workspace:` protocol —
 * npm, which this repo uses, does not understand `workspace:`, so it cannot be
 * adopted here without breaking publishing. pnpm 9 also defaults
 * `link-workspace-packages` to **false**. Together that means adding the
 * vendored packages to `pnpm-workspace.yaml` is NOT sufficient: the internal
 * edges can still resolve to whatever the registry offers, producing a build
 * that silently mixes vendored and published code.
 *
 * So this fixture builds the documented fail-closed recipe and then checks the
 * only thing that settles it — the realpath of every resolved `@jarenjs/*`
 * package. Anything outside this repository fails the gate.
 *
 * Usage: node scripts/check-source-consumer.js [--require-pnpm]
 */

import { mkdtempSync, writeFileSync, rmSync, readdirSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { isWithin, runNpm } from './lib/portable.js';

const ROOT = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '..'));
const REQUIRE_PNPM = process.argv.includes('--require-pnpm');

/**
 * The exact pnpm this fixture speaks for. The consumer this recipe exists for
 * runs 9.15.4, and a floating `pnpm@9` would let the fixture drift onto a
 * version nobody vendored against; the pin moves only when the consumer's
 * does. Obtained through npm's own exec so no `.cmd` shim is ever launched —
 * `npx pnpm` by bare name never started on a Windows runner, and the fixture
 * misread that launch failure as "pnpm unavailable".
 */
const PNPM_VERSION = '9.15.4';

/** Run the pinned pnpm through the portable npm launcher. */
function pnpm(args, options = {}) {
  return runNpm(
    ['exec', '--yes', `--package=pnpm@${PNPM_VERSION}`, '--', 'pnpm', ...args],
    options);
}

/** The closure a validating consumer actually needs. */
const CONSUMED = ['@jarenjs/validate', '@jarenjs/formats', '@jarenjs/refs', '@jarenjs/emit'];

/** Every published `@jarenjs/*` package and the directory it lives in. */
function sourcePackages() {
  /** @type {Record<string,string>} */
  const out = {};
  for (const group of ['packages', 'components']) {
    const dir = join(ROOT, group);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const manifest = join(dir, name, 'package.json');
      if (!existsSync(manifest)) continue;
      const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
      if (pkg.private === true || typeof pkg.name !== 'string') continue;
      out[pkg.name] = join(dir, name);
    }
  }
  return out;
}

function pnpmVersion() {
  try {
    // From a NEUTRAL directory, never the repo root: the root package.json
    // pins `packageManager: npm@…`, and pnpm honors that field by refusing
    // to run in the project that declares it. The fixture's consumer lives
    // in a temp directory for the same reason.
    return pnpm(['--version'],
      { cwd: tmpdir(), stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  }
  catch {
    return null;
  }
}

const version = pnpmVersion();
if (version === null) {
  const message = `pnpm ${PNPM_VERSION} is unavailable, so the source-consumer fixture did not run`;
  if (REQUIRE_PNPM) {
    console.error(`✗ ${message} (--require-pnpm)`);
    process.exit(1);
  }
  console.log(`! ${message}. Pass --require-pnpm to make this a failure.`);
  process.exit(0);
}

console.log(`Source-consumer fixture (pnpm ${version})`);
const packages = sourcePackages();
const consumer = mkdtempSync(join(tmpdir(), 'jaren-source-consumer-'));
let failures = 0;
const fail = (message) => { failures += 1; console.error(`  ✗ ${message}`); };

try {
  // Every internal edge is pinned to the local directory. This is the part
  // that makes the topology fail-closed: an override the registry cannot
  // satisfy is an install error, not a silent substitution.
  const overrides = Object.fromEntries(
    Object.entries(packages).map(([name, dir]) => [name, `link:${dir}`]));

  writeFileSync(join(consumer, 'package.json'), `${JSON.stringify({
    name: 'jaren-source-consumer',
    private: true,
    type: 'module',
    dependencies: Object.fromEntries(CONSUMED.map((name) => [name, `link:${packages[name]}`])),
    pnpm: { overrides },
  }, null, 2)}\n`);

  // pnpm 9 defaults this to false; the recipe depends on it being true.
  writeFileSync(join(consumer, '.npmrc'),
    'link-workspace-packages=true\nprefer-workspace-packages=true\n');

  writeFileSync(join(consumer, 'probe.mjs'), `
import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { JarenValidator } from '@jarenjs/validate';
import * as formats from '@jarenjs/formats';

// Walk the WHOLE @jarenjs closure, not just the direct dependencies. The
// internal edges are ordinary semver ranges, so a transitive @jarenjs/core is
// exactly what a registry could satisfy behind our back.
//
// Each edge is resolved FROM ITS PARENT, because pnpm's isolated layout does
// not hoist a transitive dependency to the consumer root — resolving
// everything from here would report a phantom failure and hide the real
// question.
const resolved = {};
const queue = ${JSON.stringify(CONSUMED)}.map((name) => [name, import.meta.url]);
while (queue.length > 0) {
  const [name, from] = queue.pop();
  if (name in resolved) continue;
  const manifest = realpathSync(createRequire(from).resolve(name + '/package.json'));
  resolved[name] = manifest;
  const pkg = createRequire(manifest)(manifest);
  for (const dep of Object.keys(pkg.dependencies ?? {}))
    if (dep.startsWith('@jarenjs/')) queue.push([dep, manifest]);
}

const validate = new JarenValidator({ collectErrors: true })
  .addFormats(formats.formatValidators ?? formats)
  .compile({ type: 'object', properties: { id: { type: 'string', minLength: 3 } }, required: ['id'] });

console.log(JSON.stringify({
  resolved,
  ok: validate({ id: 'abc' }).valid === true,
  rejects: validate({ id: 'a' }).valid === false,
}));
`);

  pnpm(['install', '--ignore-scripts'], { cwd: consumer, stdio: 'pipe' });

  const output = execFileSync(process.execPath, ['probe.mjs'],
    { cwd: consumer, encoding: 'utf8' });
  const result = JSON.parse(output.trim().split('\n').pop() ?? '{}');

  if (result.ok !== true) fail('the vendored validator did not accept a valid document');
  if (result.rejects !== true) fail('the vendored validator did not reject an invalid document');

  // The predicate has to be able to say no, or the ticks below mean nothing.
  // An end-to-end teeth test is confounded here: the vendored repo's own
  // node_modules (npm workspace symlinks) satisfies the internal edges before
  // any package-manager setting applies, so pointing an override elsewhere
  // does not actually move the resolution. Checking the detector directly is
  // what keeps this gate from being vacuous. Containment is path arithmetic
  // (`isWithin`, via path.relative), never a string prefix: native Windows
  // realpaths carry drive letters and backslashes, and a `${ROOT}/` prefix
  // check rejected every one of them.
  const insideRepo = (path) => typeof path === 'string' && isWithin(ROOT, path);
  if (insideRepo(join(tmpdir(), 'somewhere-else', 'node_modules', '@jarenjs', 'core', 'package.json')))
    fail('the realpath check accepts a path outside the checkout — the gate is vacuous');
  if (!insideRepo(join(ROOT, 'packages', 'core', 'package.json')))
    fail('the realpath check rejects a path inside the checkout — the gate cannot pass honestly');

  for (const [name, path] of Object.entries(result.resolved ?? {})) {
    if (insideRepo(path))
      console.log(`  ✓ ${name} -> ${relative(ROOT, path)}`);
    else
      fail(`${name} resolved OUTSIDE the vendored source: ${path}`);
  }
  if (Object.keys(result.resolved ?? {}).length < CONSUMED.length)
    fail('not every consumed package reported a resolved path');
}
catch (error) {
  fail(`the fixture did not complete: ${error.stderr || error.message}`);
}
finally {
  rmSync(consumer, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} source-consumer check(s) failed.`);
  process.exit(1);
}
console.log('\nSource-consumer fixture passed: every @jarenjs import came from this checkout.');
