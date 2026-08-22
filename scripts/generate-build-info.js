#!/usr/bin/env node
//@ts-check
/**
 * Build provenance for the website: which repo version, which commit and
 * which runtime produced the deployed bundle.
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
 * The timestamp is the COMMIT date, not the wall clock: on a given
 * runtime, the same commit always produces byte-identical output, so a
 * rebuild is reproducible and the built site addresses to the same
 * content hash. `node` and `platform` are BUILD-ENVIRONMENT facts and
 * they do vary between machines — they are recorded because a bundle's
 * behavior can depend on the toolchain that produced it, and the
 * reproducibility claim above is the one that holds per runtime, not
 * across all of them.
 *
 * `reproducible` therefore means exactly this: the output is tied to a
 * commit AND the working tree matches it. A dirty tree ships code that
 * is in the bundle but not in the revision the bundle names, and there
 * is no rebuilding that from the commit alone.
 *
 * The emit path proves the record against the output schema of the
 * `site.build` operation before it is written — the same compiled
 * document the footer reads it through — so the shape the build writes
 * and the shape the page declares cannot part company.
 */

import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { headCommit, isDirty } from './lib/git.js';
import { assertSiteOutput } from './lib/site-contract.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const OUT = join(ROOT, 'packages/website/public/build.json');

/**
 * @typedef {Object} BuildInfo
 * @property {string} version - The repo version this bundle was built from.
 * @property {string | null} commit - The HEAD commit, or null without git.
 * @property {string} built - The commit date; the clock only when there is
 *   no commit to date the build by.
 * @property {boolean} reproducible - Committed revision + clean tree.
 * @property {string} node - The runtime that ran the build.
 * @property {string} platform - The machine that ran the build.
 */

/**
 * Read the build provenance.
 * @returns {BuildInfo}
 */
export function buildInfo() {
  const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
  const { commit, committed } = headCommit();
  return {
    version,
    commit,
    // null `commit` means the build could not be tied to a revision, so the
    // clock is the only answer available — recorded as such, never as if it
    // were reproducible
    built: committed ?? new Date().toISOString(),
    // `isDirty()` answers null when git cannot say, which is not "clean"
    reproducible: committed !== null && isDirty() === false,
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
  };
}

/**
 * Serialize the provenance exactly as the CLI writes it — the emit path,
 * so the contract check cannot be bypassed by a caller that only wanted
 * the bytes.
 * @param {BuildInfo} info
 * @returns {string}
 * @throws {Error} when the record does not match what `site.build` declares.
 */
export function serializeBuildInfo(info) {
  assertSiteOutput('site.build', info, 'packages/website/public/build.json');
  return `${JSON.stringify(info, null, 2)}\n`;
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const info = buildInfo();
  let text;
  try {
    text = serializeBuildInfo(info);
  }
  catch (error) {
    console.error(/** @type {Error} */ (error).message);
    process.exit(1);
  }
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, text);
  console.log(`build.json: ${info.version} @ ${info.commit === null ? '(no git)' : info.commit.slice(0, 7)}`
    + ` on ${info.node}${info.reproducible ? '' : ' (not reproducible: dirty tree or no git)'}`);
}
