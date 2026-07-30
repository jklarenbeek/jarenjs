//@ts-check
/**
 * The dependency gate.
 *
 * Two questions, in order of how much they matter to someone installing this:
 *
 * 1. **Can a published package pull third-party code into a consumer's
 *    runtime?** This is structural and provable from the manifests: every
 *    published `@jarenjs/*` package must declare runtime dependencies on
 *    `@jarenjs/*` packages and nothing else. It needs no registry, no network
 *    and no advisory database, and it is the claim the README and SECURITY.md
 *    make on a consumer's behalf.
 *
 * 2. **Does `npm audit` report anything that reaches shipped code?** Because
 *    (1) holds, the answer is structurally no — but "structurally impossible"
 *    is worth checking rather than asserting, and the advisories that DO exist
 *    in the build tooling deserve to be named rather than waved away.
 *
 * The second check is deliberately not "npm audit must be clean". The findings
 * live in eslint, c8 and — mostly — in `@mermaid-js/parser`, which is a
 * BENCHMARK RIVAL: it is installed so the parse benchmark can measure against
 * it, and pinning it to something other than what we benchmark would make the
 * comparison dishonest. Silencing those with a blanket ignore would also
 * silence the next one, so they are listed individually below and a finding
 * outside the list fails the gate.
 *
 * Usage: node scripts/check-dependencies.js [--skip-audit]
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runNpm } from './lib/portable.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Advisories known to live in build tooling only, each with the reason it
 * cannot be resolved from here. A new advisory is NOT covered by this list and
 * fails the gate; that is the point of naming them one at a time.
 */
const KNOWN_TOOLING_ADVISORIES = {
  'lodash-es': 'chevrotain (via @mermaid-js/parser, a benchmark rival) pins a vulnerable range; overriding it would change the artifact we benchmark against',
  'chevrotain': 'transitive under @mermaid-js/parser (benchmark rival)',
  '@chevrotain/gast': 'transitive under @mermaid-js/parser (benchmark rival)',
  '@chevrotain/cst-dts-gen': 'transitive under @mermaid-js/parser (benchmark rival)',
  'langium': 'transitive under @mermaid-js/parser (benchmark rival)',
  '@mermaid-js/parser': 'benchmark rival; pinned to the version the parse benchmark measures',
  'brace-expansion': 'reached through minimatch from eslint, c8 and the benchmark workspace; forcing the patched 5.0.8 onto every consumer breaks eslint, which needs the 1.x export shape',
  '@eslint/config-array': 'transitive under eslint, via the minimatch chain above',
  '@eslint/eslintrc': 'transitive under eslint, via the minimatch chain above',
  'eslint': 'the linter itself, via the minimatch chain above',
  'minimatch': 'depends on the vulnerable brace-expansion range; see above',
  'glob': 'transitive under c8 and the benchmark workspace, via minimatch',
  'test-exclude': 'transitive under c8, via glob',
  'c8': 'the coverage runner used by the dead-code audit, via test-exclude',
};

/*
 * A note on why none of these are simply overridden away.
 *
 * `brace-expansion` has a patched 5.0.8, and an npm `overrides` entry does
 * force it — onto every consumer at once, including the `minimatch@1.x` that
 * eslint's config-array still loads. That version calls the 1.x export shape
 * and dies with `expand is not a function`, so the "fix" trades a tooling
 * advisory for a broken linter. npm's overrides are repository-wide and cannot
 * express "only where the consumer can take it", and they do not reach into
 * workspace subtrees either. The lodash-es chain is worse: it belongs to
 * `@mermaid-js/parser`, which is installed precisely so the parse benchmark can
 * measure against it, and pinning it elsewhere would make that comparison a
 * measurement of something we do not ship against something nobody runs.
 *
 * So the honest position is the one above: name each finding, keep proving
 * that none of them can reach a published package, and fail the moment a new
 * one appears.
 */

/** Every workspace package that is published to npm. */
function publishedPackages() {
  const out = [];
  for (const group of ['packages', 'components']) {
    const dir = join(ROOT, group);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const manifest = join(dir, name, 'package.json');
      if (!existsSync(manifest)) continue;
      const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
      if (pkg.private === true || typeof pkg.name !== 'string') continue;
      out.push({ pkg, manifest: `${group}/${name}/package.json` });
    }
  }
  return out;
}

let failures = 0;
const fail = (message) => { failures += 1; console.error(`  ✗ ${message}`); };

console.log('Runtime dependency closure');
const published = publishedPackages();
if (published.length === 0) fail('no published packages found — the check is not running');

for (const { pkg, manifest } of published) {
  const deps = Object.keys(pkg.dependencies ?? {});
  const foreign = deps.filter((d) => !d.startsWith('@jarenjs/'));
  if (foreign.length > 0)
    fail(`${manifest} declares third-party runtime dependencies: ${foreign.join(', ')}`);
  // A peer dependency is installed into the consumer's tree just as surely.
  const peers = Object.keys(pkg.peerDependencies ?? {}).filter((d) => !d.startsWith('@jarenjs/'));
  if (peers.length > 0)
    fail(`${manifest} declares third-party peer dependencies: ${peers.join(', ')}`);
}
if (failures === 0)
  console.log(`  ✓ ${published.length} published packages, zero third-party runtime dependencies`);

if (!process.argv.includes('--skip-audit')) {
  console.log('\nAdvisories');
  let report = null;
  try {
    // `npm audit` exits non-zero when it finds anything, so the output is read
    // from the thrown result rather than treated as a failure.
    report = runNpm(['audit', '--json'], { cwd: ROOT });
  }
  catch (error) {
    // A findings exit carries the report on stdout; a LAUNCH failure carries
    // nothing. Only the former is evidence. This check fails closed: on a
    // Windows runner the old bare-name launch never started npm at all, and
    // "no output, skipping" turned a broken release check into a green one.
    // An intentional offline run says so explicitly with --skip-audit.
    const stdout = /** @type {{stdout?: unknown}} */ (error).stdout;
    report = typeof stdout === 'string' && stdout.length > 0 ? stdout : null;
    if (report === null)
      fail(`npm audit did not run: ${/** @type {Error} */ (error).message}`);
  }

  if (report !== null && report.length === 0) {
    fail('npm audit produced no output — refusing to treat silence as evidence');
    report = null;
  }
  if (report !== null) {
    let vulnerabilities = null;
    try {
      vulnerabilities = JSON.parse(report).vulnerabilities ?? {};
    }
    catch (_e) {
      fail('npm audit produced unparseable JSON — refusing to treat it as evidence');
    }
    if (vulnerabilities !== null) {
      const names = Object.keys(vulnerabilities);
      const unexpected = names.filter((name) => !(name in KNOWN_TOOLING_ADVISORIES));
      const publishedNames = new Set(published.map(({ pkg }) => pkg.name));
      // Nothing advisory-flagged may sit in a published package's own closure.
      for (const name of names)
        if (publishedNames.has(name))
          fail(`advisory reaches a PUBLISHED package: ${name}`);

      for (const name of names) {
        const reason = KNOWN_TOOLING_ADVISORIES[name];
        const severity = vulnerabilities[name].severity;
        if (reason) console.log(`  · ${severity.padEnd(8)} ${name} — ${reason}`);
      }
      for (const name of unexpected)
        fail(`new advisory not covered by the tooling list: ${name} (${vulnerabilities[name].severity})`);

      if (unexpected.length === 0)
        console.log(`  ✓ ${names.length} advisories, all in build tooling, none reaching shipped code`);
    }
  }
}

if (failures > 0) {
  console.error(`\n${failures} dependency check(s) failed.`);
  process.exit(1);
}
console.log('\nDependency gate passed.');
