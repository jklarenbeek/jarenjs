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
 * live in build tooling and — mostly — in benchmark rivals such as
 * `@mermaid-js/parser`, installed so a benchmark can measure against them:
 * pinning one to something other than what we benchmark would make the
 * comparison dishonest. Silencing those with a blanket ignore would also
 * silence the next one, so they are recorded below one ADVISORY at a time, by
 * the id the audit reports (`GHSA-…`), never by the name of the package they
 * sit on:
 *
 * - an advisory the list does not record fails the gate, even on a package
 *   the list already covers for another advisory;
 * - a recorded advisory reported on any package but the one it is recorded
 *   on, instead or as well, fails the gate;
 * - a recorded advisory reported above the severity it was reviewed at, or
 *   at a label off npm's scale, fails the gate, because a re-scored advisory
 *   deserves a fresh review;
 * - a recorded advisory the audit no longer reports fails the gate, so the
 *   list cannot rot. A dependency refresh or an advisory withdrawn upstream
 *   therefore reddens this gate with no change here: deleting the entry the
 *   failure names is the fix.
 *
 * A package the audit flags only through another package's advisory (its
 * `via` names that package — every chevrotain sibling under lodash-es, say) is
 * covered by that advisory's entry; one flagged through no advisory at all is
 * not covered by anything. An audit that did not run — npm's error report
 * when the advisory endpoint fails carries no vulnerability map — fails the
 * gate with npm's message instead of reading as an audit that found nothing.
 *
 * Usage: node scripts/check-dependencies.js [--skip-audit | --audit <file>]
 *   --skip-audit    the structural checks only, for an intentional offline run
 *   --audit <file>  read `npm audit --json` output from a file instead of
 *                   running npm audit; given once
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkIndependentClosure } from './lib/independent-closure.js';
import { isMainModule } from './lib/main-module.js';

import { runNpm } from './lib/portable.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** npm's severity scale, lowest first. */
const SEVERITIES = ['info', 'low', 'moderate', 'high', 'critical'];

/**
 * @typedef {object} KnownAdvisory
 * @property {string} package - the package the advisory is filed against
 * @property {'info' | 'low' | 'moderate' | 'high' | 'critical'} severity - the severity it was reviewed at
 * @property {string} reason - where it lives, and why it is not resolved from here
 */

// the parse benchmark rival: chevrotain (under @mermaid-js/parser) pins the
// vulnerable lodash-es range, and chevrotain, @chevrotain/*, langium and the
// parser itself are flagged through it
const MERMAID_PARSER = 'lodash-es pinned by chevrotain under @mermaid-js/parser, the parse benchmark rival; '
  + 'overriding it would change the artifact we benchmark against';

// minimatch's brace expansion inside eslint, c8 (test-exclude), rimraf and the
// benchmark workspace's glob. Patched releases sit inside the ranges those
// tools declare, so a lockfile refresh clears these; an npm `overrides` entry
// is not the fix (see the note below the list).
const BRACE_EXPANSION = 'minimatch\'s brace expansion in eslint, c8, rimraf and the benchmark workspace\'s glob; '
  + 'build tooling only, cleared by a lockfile refresh, never by an override';

// GHSA-vfj7-8cjw-p6xm (reviewed 2026-10-02): braces <=3.0.3 has unbounded
// recursion for deeply nested brace PATTERNS. There is no patched braces
// release; gh-pages 6.3.0 is also the latest release. The website deploy
// scripts use gh-pages' fixed default patterns, not patterns supplied by site
// visitors. npm suggests downgrading gh-pages to 6.1.1. Keep the current
// deployment tool and name its transitive findings (micromatch, fast-glob,
// globby, gh-pages); none is in a published package's closure.
const GH_PAGES = 'unpatched nested-pattern stack exhaustion in braces under gh-pages (via globby, fast-glob, micromatch); '
  + 'repository-controlled deployment patterns only, absent from shipped packages';

// the Prisma ORM benchmark rival (orm suite): a stack exhaustion in
// `deepmerge-ts` (<8.0.0) when merging RECURSIVE object graphs, reached only
// through Prisma's own config loader (`@prisma/config`). Every Prisma
// release, including the newest 7.x, still pins deepmerge-ts 7.1.x, so there
// is no upgrade that clears it, and npm's suggested "fix" is a DOWNGRADE to
// prisma 6.12.0 — a different artifact from the one the orm suite measures.
const PRISMA = 'deepmerge-ts under prisma\'s config loader, the ORM benchmark rival (benchmark workspace only); '
  + 'the stack exhaustion needs recursive config graphs, unreachable from anything jaren ships';

// the ORM benchmark rival: the orm suite measures Drizzle at the version
// readers actually install; the advisory (identifier escaping in Drizzle's own
// SQL generation) lives entirely inside the rival's machinery.
const DRIZZLE = 'the ORM benchmark rival (benchmark workspace only); the advisory is in Drizzle\'s own SQL generation, '
  + 'not in anything jaren ships';

// @eslint/eslintrc's YAML config loader; a patched 4.x sits inside eslintrc's range.
const JS_YAML = 'js-yaml under @eslint/eslintrc, the linter\'s config loader; build tooling only, cleared by a lockfile refresh';

// Mermaid 12.1.0 still requires KaTeX ^0.16.47; the patch is on 0.18.2,
// outside that range. Keep the rival's supported dependency graph instead of
// measuring an overridden combination.
const KATEX = 'prototype gadget in the Mermaid benchmark rival\'s KaTeX; the patched 0.18.2 is outside Mermaid\'s supported range, '
  + 'absent from published package closures';

// the PouchDB benchmark rival: the db suite measures against the version
// readers actually install; overriding its internals would make the
// comparison a measurement of something nobody runs. The advisory is an
// unbounded-buffer concern in the uuid version pinned inside PouchDB's own
// machinery (every pouchdb-* package is flagged through it).
const POUCHDB = 'uuid pinned inside the pouchdb benchmark rival family (db suite); '
  + 'pinned to the version the store benchmark measures';

/**
 * Advisories known to live in build tooling or a benchmark rival only, keyed
 * by advisory id, each with the package it is filed against, the severity it
 * was reviewed at and the reason it cannot be resolved from here. An advisory
 * that is not recorded here fails the gate; that is the point of recording
 * them one at a time.
 * @type {Readonly<Record<string, KnownAdvisory>>}
 */
export const KNOWN_TOOLING_ADVISORIES = Object.freeze({
  'GHSA-r5fr-rjxr-66jc': { package: 'lodash-es', severity: 'high', reason: MERMAID_PARSER },
  'GHSA-f23m-r3pf-42rh': { package: 'lodash-es', severity: 'moderate', reason: MERMAID_PARSER },
  'GHSA-xxjr-mmjv-4gpg': { package: 'lodash-es', severity: 'moderate', reason: MERMAID_PARSER },
  'GHSA-q2hr-2g5m-vwhr': { package: 'brace-expansion', severity: 'moderate', reason: BRACE_EXPANSION },
  'GHSA-qhr7-859c-m2p7': { package: 'brace-expansion', severity: 'high', reason: BRACE_EXPANSION },
  'GHSA-6j4f-fj2g-mc7p': { package: 'brace-expansion', severity: 'high', reason: BRACE_EXPANSION },
  'GHSA-vfj7-8cjw-p6xm': { package: 'braces', severity: 'high', reason: GH_PAGES },
  'GHSA-ggr8-5vv4-36mx': { package: 'deepmerge-ts', severity: 'high', reason: PRISMA },
  'GHSA-gpj5-g38j-94v9': { package: 'drizzle-orm', severity: 'high', reason: DRIZZLE },
  'GHSA-2883-xcg3-v3hh': { package: 'js-yaml', severity: 'high', reason: JS_YAML },
  'GHSA-238p-pmpm-9mq7': { package: 'katex', severity: 'low', reason: KATEX },
  'GHSA-w5hq-g745-h8pq': { package: 'uuid', severity: 'moderate', reason: POUCHDB },
});

/*
 * A note on why none of these are simply overridden away.
 *
 * An npm `overrides` entry forces one version onto every consumer at once,
 * including the minimatch that eslint still loads, which calls
 * brace-expansion's 1.x export shape: forced onto a newer major it dies with
 * `expand is not a function`, so the "fix" trades a tooling advisory for a
 * broken linter. npm's overrides are repository-wide and cannot express "only
 * where the consumer can take it", and they do not reach into workspace
 * subtrees either. The lodash-es chain is worse: it belongs to
 * `@mermaid-js/parser`, which is installed precisely so the parse benchmark can
 * measure against it, and pinning it elsewhere would make that comparison a
 * measurement of something we do not ship against something nobody runs.
 *
 * So the honest position is the one above: name each advisory, keep proving
 * that none of them can reach a published package, and fail the moment a new
 * one appears or a named one disappears.
 */

/**
 * The id an audit advisory carries: its GHSA, else its url, else npm's
 * numeric source id.
 * @param {any} via - an advisory object from a vulnerability's `via`
 * @returns {string}
 */
export function advisoryId(via) {
  const url = typeof via?.url === 'string' ? via.url : '';
  return /GHSA(?:-[0-9a-z]{4}){3}/i.exec(url)?.[0] ?? (url !== '' ? url : `npm-${via?.source}`);
}

/**
 * @typedef {object} AuditFindings
 * @property {string[]} failures - every reason the gate fails, in report order
 * @property {string[]} lines - one line per recorded advisory the audit reports
 * @property {number} advisories - distinct advisories the audit reports
 * @property {number} packages - packages the audit flags
 */

/**
 * Read an `npm audit --json` vulnerability map against the recorded advisories.
 * @param {Record<string, any>} vulnerabilities - the report's `vulnerabilities` member
 * @param {{ known?: Readonly<Record<string, KnownAdvisory>>, published?: ReadonlySet<string> }} [options]
 *   `published` names the packages no advisory may flag at all
 * @returns {AuditFindings}
 */
export function auditFindings(vulnerabilities, options = {}) {
  const known = options.known ?? KNOWN_TOOLING_ADVISORIES;
  const published = options.published ?? new Set();
  /** @type {string[]} */
  const failures = [];
  const names = Object.keys(vulnerabilities);
  // per advisory: every package that carries it directly (an advisory
  // object in its `via`, not a name), every severity label it is reported
  // at, and the packages flagged only through it
  /** @type {Map<string, { packages: Set<string>, severities: Set<string>, title: string, flags: Set<string> }>} */
  const reported = new Map();
  /** @param {string} name @returns {any[]} */
  const viaOf = (name) => (Array.isArray(vulnerabilities[name]?.via) ? vulnerabilities[name].via : []);

  // Nothing advisory-flagged may sit in a published package's own closure.
  for (const name of names)
    if (published.has(name)) failures.push(`advisory reaches a PUBLISHED package: ${name}`);

  for (const name of names) {
    for (const via of viaOf(name)) {
      if (via === null || typeof via !== 'object') continue;
      const id = advisoryId(via);
      let seen = reported.get(id);
      if (seen === undefined) {
        seen = { packages: new Set(), severities: new Set(), title: String(via.title ?? ''), flags: new Set() };
        reported.set(id, seen);
      }
      seen.packages.add(String(via.dependency ?? name));
      seen.severities.add(String(via.severity ?? vulnerabilities[name].severity));
    }
  }

  // every flagged package resolves, through its `via` chain, to the
  // advisories it carries; one that reaches none is covered by nothing
  /** @param {string} name @param {Set<string>} visiting @returns {string[]} */
  const reach = (name, visiting) => {
    if (visiting.has(name)) return [];
    visiting.add(name);
    return viaOf(name).flatMap((via) => (typeof via === 'string' ? reach(via, visiting)
      : via !== null && typeof via === 'object' ? [advisoryId(via)] : []));
  };
  for (const name of names) {
    const ids = reach(name, new Set());
    if (ids.length === 0) {
      failures.push(`${name} is flagged (${vulnerabilities[name]?.severity ?? 'unknown'}) through no advisory `
        + 'the audit names — refusing to treat it as covered');
    }
    for (const id of ids) {
      const advisory = reported.get(id);
      if (advisory !== undefined && !advisory.packages.has(name)) advisory.flags.add(name);
    }
  }

  /** @type {string[]} */
  const lines = [];
  for (const [id, advisory] of reported) {
    const entry = known[id];
    const carriers = [...advisory.packages].sort().join(', ');
    // a label off npm's scale cannot be compared with the reviewed one
    const unknown = [...advisory.severities].filter((label) => !SEVERITIES.includes(label));
    const severity = unknown[0] ?? SEVERITIES[Math.max(...[...advisory.severities].map((label) => SEVERITIES.indexOf(label)))];
    if (entry === undefined) {
      failures.push(`new advisory not covered by the tooling list: ${id} on ${carriers} (${severity})`
        + (advisory.title === '' ? '' : ` — ${advisory.title}`));
    }
    else if (advisory.packages.size !== 1 || !advisory.packages.has(entry.package)) {
      failures.push(`${id} is recorded on ${entry.package} but reported on ${carriers} — review it again`);
    }
    else if (unknown.length > 0) {
      failures.push(`${id} on ${carriers} is reported at an unknown severity '${unknown.join('\', \'')}' — review it again`);
    }
    else if (SEVERITIES.indexOf(severity) > SEVERITIES.indexOf(entry.severity)) {
      failures.push(`${id} on ${carriers} is now ${severity}, reviewed at ${entry.severity} — review it again`);
    }
    else {
      const flags = advisory.flags.size === 0 ? '' : ` (flags ${[...advisory.flags].join(', ')})`;
      lines.push(`· ${severity.padEnd(8)} ${id} ${carriers}${flags} — ${entry.reason}`);
    }
  }
  for (const [id, entry] of Object.entries(known)) {
    if (!reported.has(id)) failures.push(`recorded advisory ${id} (${entry.package}) is no longer reported — remove its entry`);
  }
  return { failures, lines, advisories: reported.size, packages: names.length };
}

/**
 * A JSON object, not an array or null.
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Every workspace package that is published to npm.
 * @returns {{ pkg: any, manifest: string }[]}
 */
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

/**
 * The whole gate.
 * @param {string[]} argv - the command-line arguments
 * @returns {number} the exit code: 0 passed, 1 a check failed, 2 the arguments are wrong
 */
function main(argv) {
  /** @type {string | undefined} */
  let auditFile;
  let skipAudit = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--skip-audit') skipAudit = true;
    else if (argv[i] === '--audit' && i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      // a second report would silently replace the first, a failing one included
      if (auditFile !== undefined) {
        console.error('check-dependencies: --audit given twice — use --skip-audit or --audit <file>');
        return 2;
      }
      auditFile = argv[++i];
    }
    else {
      console.error(`check-dependencies: unexpected argument '${argv[i]}' — use --skip-audit or --audit <file>`);
      return 2;
    }
  }
  // skipping the audit while handing one in is a contradiction, not a choice
  if (skipAudit && auditFile !== undefined) {
    console.error('check-dependencies: --skip-audit and --audit cannot be combined — use --skip-audit or --audit <file>');
    return 2;
  }

  let failures = 0;
  const fail = (/** @type {string} */ message) => { failures += 1; console.error(`  ✗ ${message}`); };

  console.log('Independent repository closure');
  for (const failure of checkIndependentClosure(ROOT)) fail(failure);

  console.log('Runtime dependency closure');
  const published = publishedPackages();
  if (published.length === 0) fail('no published packages found — the check is not running');

  for (const { pkg, manifest } of published) {
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies });
    const foreign = deps.filter((d) => !d.startsWith('@jarenjs/'));
    if (foreign.length > 0)
      fail(`${manifest} declares third-party runtime dependencies: ${foreign.join(', ')}`);
    // A peer dependency is installed into the consumer's tree just as surely.
    const peers = Object.keys(pkg.peerDependencies ?? {}).filter((d) => !d.startsWith('@jarenjs/'));
    if (peers.length > 0)
      fail(`${manifest} declares third-party peer dependencies: ${peers.join(', ')}`);
  }
  if (failures === 0)
    console.log(`  ✓ ${published.length} published packages, zero third-party runtime or peer dependencies`);

  if (!skipAudit) {
    console.log('\nAdvisories');
    /** @type {string | null} */
    let report = null;
    if (auditFile !== undefined) {
      try { report = readFileSync(auditFile, 'utf8'); }
      catch (error) { fail(`cannot read the audit report ${auditFile}: ${/** @type {Error} */ (error).message}`); }
    }
    else {
      try {
        // `npm audit` exits non-zero when it finds anything, so the output is
        // read from the thrown result rather than treated as a failure.
        report = runNpm(['audit', '--json'], { cwd: ROOT });
      }
      catch (error) {
        // A findings exit carries the report on stdout; a LAUNCH failure
        // carries nothing. Only the former is evidence. This check fails
        // closed: on a Windows runner the old bare-name launch never started
        // npm at all, and "no output, skipping" turned a broken release check
        // into a green one. An intentional offline run says so explicitly
        // with --skip-audit.
        const stdout = /** @type {{stdout?: unknown}} */ (error).stdout;
        report = typeof stdout === 'string' && stdout.length > 0 ? stdout : null;
        if (report === null)
          fail(`npm audit did not run: ${/** @type {Error} */ (error).message}`);
      }
    }

    if (report !== null && report.length === 0) {
      fail('npm audit produced no output — refusing to treat silence as evidence');
      report = null;
    }
    if (report !== null) {
      /** @type {Record<string, any> | null} */
      let vulnerabilities = null;
      try {
        const parsed = JSON.parse(report);
        // A report that ran carries the map, empty when nothing is flagged.
        // An error report (the advisory endpoint failed, no lockfile) has
        // none, and reading it as empty would call every recorded advisory
        // stale.
        if (isPlainObject(parsed) && 'vulnerabilities' in parsed && isPlainObject(parsed.vulnerabilities))
          vulnerabilities = parsed.vulnerabilities;
        else {
          const message = isPlainObject(parsed) ? parsed.message ?? parsed.error?.summary : undefined;
          fail(`npm audit returned no vulnerability map${typeof message === 'string' ? `: ${message}` : ''}`);
        }
      }
      catch (_e) {
        fail('npm audit produced unparseable JSON — refusing to treat it as evidence');
      }
      if (vulnerabilities !== null) {
        const findings = auditFindings(vulnerabilities, { published: new Set(published.map(({ pkg }) => pkg.name)) });
        for (const line of findings.lines) console.log(`  ${line}`);
        for (const failure of findings.failures) fail(failure);
        if (findings.failures.length === 0) {
          console.log(`  ✓ ${findings.advisories} recorded advisories over ${findings.packages} flagged packages, `
            + 'all in build tooling, none reaching shipped code');
        }
      }
    }
  }

  if (failures > 0) {
    console.error(`\n${failures} dependency check(s) failed.`);
    return 1;
  }
  console.log('\nDependency gate passed.');
  return 0;
}

if (isMainModule(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
