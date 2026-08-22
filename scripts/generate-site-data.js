#!/usr/bin/env node
//@ts-check
/**
 * The package census the website reads: which workspaces this repository
 * publishes, at which version, described in their own words.
 *
 * The workspace manifests are the only place that answer actually lives,
 * and a copy of it kept anywhere else drifts from them. So the site is
 * handed the derivation instead: root `workspaces` in order, each
 * workspace's own `package.json` for the name, version and description,
 * and private workspaces (the website itself, the benchmark harness)
 * left out of a list of PUBLISHED packages.
 *
 * Provenance comes from the HEAD commit, never the clock, so a rebuild
 * of the same revision writes byte-identical output — asserted by the
 * census test, because a generated file that churns per run cannot be
 * diffed and cannot be cached. A checkout without git carries no
 * revision to name and says so with nulls rather than stamping a wall
 * clock that would break that property.
 *
 * Nothing is written that the site could not read: the emit path proves
 * the census against the output schema of the `site.packages` operation
 * — the same compiled document the browser reads it through — and
 * refuses rather than shipping a shape a reader would have to discover.
 */

import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { headCommit } from './lib/git.js';
import { assertSiteOutput } from './lib/site-contract.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const OUT = join(ROOT, 'packages/website/public/site/packages.json');

/**
 * @typedef {Object} CensusEntry
 * @property {string} name - The published package name.
 * @property {string} dir - Repo-relative workspace directory (the README base).
 * @property {string} version
 * @property {string} description - The manifest's own description.
 */

/**
 * @typedef {Object} SiteCensus
 * @property {string | null} generated - The HEAD commit's date.
 * @property {string | null} commit - The HEAD commit.
 * @property {CensusEntry[]} packages - Public workspaces, in manifest order.
 */

/** The root manifest's workspace directories, repo-relative. */
export function workspaceDirs() {
  const root = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  return root.workspaces.map((/** @type {string} */ entry) => entry.replace(/^\.\//, ''));
}

/**
 * Build the census document.
 * @returns {SiteCensus}
 */
export function buildSiteData() {
  const { commit, committed } = headCommit();
  /** @type {CensusEntry[]} */
  const packages = [];
  for (const dir of workspaceDirs()) {
    const manifest = JSON.parse(readFileSync(join(ROOT, dir, 'package.json'), 'utf8'));
    if (manifest.private === true) continue;
    packages.push({
      name: manifest.name,
      dir,
      version: manifest.version,
      description: manifest.description ?? '',
    });
  }
  return { generated: committed, commit, packages };
}

/**
 * Serialize the census exactly as the CLI writes it — the emit path, so
 * the contract check cannot be bypassed by a caller that only wanted the
 * bytes.
 * @param {SiteCensus} census
 * @returns {string}
 * @throws {Error} when the census does not match what `site.packages` declares.
 */
export function serializeSiteData(census) {
  assertSiteOutput('site.packages', census, 'packages/website/public/site/packages.json');
  return `${JSON.stringify(census, null, 2)}\n`;
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const census = buildSiteData();
  let text;
  try {
    text = serializeSiteData(census);
  }
  catch (error) {
    console.error(/** @type {Error} */ (error).message);
    process.exit(1);
  }
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, text);
  console.log(`site/packages.json: ${census.packages.length} published workspaces`
    + ` @ ${census.commit === null ? '(no git)' : census.commit.slice(0, 7)}`);
}
