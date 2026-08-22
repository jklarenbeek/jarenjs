#!/usr/bin/env node
//@ts-check
/**
 * The deploy guard: refuse to publish while the tracked benchmark
 * measurements differ from HEAD.
 *
 *   node scripts/check-benchmark-drift.js
 *
 * `packages/website/public/benchmarks/*.json` are the committed
 * measurements every published figure derives from — the site's tables,
 * the README's markers, the docs gate. The deploy path used to regenerate
 * them implicitly, which meant that whichever machine happened to deploy
 * silently rewrote the repository's numbers with its own hardware's, and
 * the deploy went out carrying figures no commit had ever reviewed.
 *
 * So re-measuring is now an act with a name (`deploy:remeasure`), and this
 * gate stands between an uncommitted measurement and a publish. A dirty
 * artifact is one of exactly two things, and the refusal says which
 * command answers each: a deliberate re-measure (commit it), or an
 * accident (reset it).
 */

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const TRACKED = 'packages/website/public/benchmarks';

/**
 * @typedef {object} DriftReport
 * @property {number} code - 0 clean, 1 dirty, 2 not a git checkout
 * @property {string[]} changed - repo-relative paths that differ from HEAD
 * @property {string} [reason] - why the check could not run
 */

/**
 * Which tracked measurements differ from HEAD (modified, staged, deleted
 * or newly added — an untracked artifact is as unreviewed as a changed one).
 * @param {{ root?: string }} [options]
 * @returns {DriftReport}
 */
export function checkBenchmarkDrift(options = {}) {
  const cwd = options.root ?? ROOT;
  let out;
  try {
    out = execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '--', TRACKED],
      { cwd, encoding: 'utf8' });
  }
  catch (err) {
    return { code: 2, changed: [], reason: String(/** @type {any} */ (err)?.message ?? err) };
  }
  const changed = out.split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    // `XY path` — and a rename carries ` -> `, whose destination is the one
    // that would ship
    .map((line) => line.slice(2).trim().split(' -> ').pop() ?? '');
  return { code: changed.length > 0 ? 1 : 0, changed };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = checkBenchmarkDrift();
  if (report.code === 2) {
    console.error(`cannot read the measurement state: ${report.reason}`);
    process.exit(2);
  }
  if (report.code === 1) {
    console.error(`the tracked benchmark measurements differ from HEAD `
      + `(${report.changed.length}):\n\n  ${report.changed.join('\n  ')}\n`);
    console.error('a deploy publishes figures derived from these files, so they must be the ones\n'
      + 'HEAD carries. Either:\n\n'
      + '  • the re-measure was deliberate — commit it, then deploy; or\n'
      + `  • it was not — \`git checkout -- ${TRACKED}\` and deploy.\n\n`
      + 'To re-measure ON PURPOSE as part of publishing, run `npm run deploy:remeasure`\n'
      + 'from packages/website; it is the only script that regenerates timings.');
    process.exit(1);
  }
  console.log('benchmark measurements match HEAD.');
}
