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
 * Which measurements in the tracked directory differ from HEAD: modified,
 * staged, deleted, newly added, untracked — and IGNORED, because a file an
 * ignore rule hides is copied into the site build all the same and is as
 * unreviewed as any other. Read NUL-separated, so a path with a space or
 * a quote is one path and a rename is two.
 * @param {{ root?: string }} [options]
 * @returns {DriftReport}
 */
export function checkBenchmarkDrift(options = {}) {
  const cwd = options.root ?? ROOT;
  let out;
  try {
    out = execFileSync('git', ['status', '--porcelain', '-z', '--untracked-files=all', '--ignored=matching', '--', TRACKED],
      { cwd, encoding: 'utf8' });
  }
  catch (err) {
    return { code: 2, changed: [], reason: String(/** @type {any} */ (err)?.message ?? err) };
  }
  const fields = out.split('\0').filter((field) => field !== '');
  /** @type {string[]} */
  const changed = [];
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i];
    const status = entry.slice(0, 2);
    // `XY path` — a rename or copy carries the ORIGINAL path in the next
    // field; the destination is the one that would ship
    changed.push(entry.slice(3));
    if (status.includes('R') || status.includes('C')) i++;
  }
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
