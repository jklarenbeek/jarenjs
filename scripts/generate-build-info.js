#!/usr/bin/env node
//@ts-check
/**
 * Build provenance for the website: which repo version, which runtime,
 * which commit produced the deployed bundle.
 *
 * This is deliberately NOT written into `public/benchmarks/meta.json`.
 * That file's `node`/`cpu`/`platform`/`version`/`generated` members are
 * MEASUREMENT provenance — they describe the machine and the repo state
 * that produced the timings beside them. Refreshing them without
 * re-running the suites would claim numbers were measured on a runtime
 * and a version they never ran on, which is the one thing a benchmark
 * record may never do. Keeping the two apart is what lets the site say
 * "measured at 0.27.2 on Node v22, built at 0.30.9 on Node v24" — the
 * gap becomes visible instead of silently plausible.
 *
 * The timestamp is the COMMIT date, not the wall clock, so the same
 * commit always produces byte-identical output: a rebuild is
 * reproducible, and the built site addresses to the same content hash.
 * Only a checkout with no git available falls back to the clock, and
 * says so.
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const OUT = join(ROOT, 'packages/website/public/build.json');

/** A git fact, or null when git is unavailable (a tarball checkout). */
function git(...args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  }
  catch {
    return null;
  }
}

const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const commit = git('rev-parse', 'HEAD');
const committed = git('log', '-1', '--format=%cI');

const info = {
  version,
  commit,
  // null `commit` means the build could not be tied to a revision, so the
  // clock is the only answer available — recorded as such, never as if it
  // were reproducible
  built: committed ?? new Date().toISOString(),
  reproducible: committed !== null,
  node: process.version,
  platform: `${process.platform} ${process.arch}`,
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(info, null, 2)}\n`);
console.log(`build.json: ${version} @ ${commit === null ? '(no git)' : commit.slice(0, 7)} on ${process.version}`);
