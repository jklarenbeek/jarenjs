#!/usr/bin/env node
//@ts-check
/**
 * The scripted half of the `docs/DESIGN.md` conformance sweep: the banned
 * hues, over the site's source **and** its build output.
 *
 *   node scripts/check-site-design.js
 *
 * §1 of the design language forbids the pink/purple family. That rule used
 * to be enforced by a grep printed in a document, which means it was
 * enforced by whoever remembered to run it — and the values it hunts are
 * exactly the ones that arrive by accident: a vendored default palette, a
 * library's own accent, a copied gradient. `dist/` is scanned as well as
 * `src/` because a hue can enter through a dependency's stylesheet and
 * never appear in a file this repository authored.
 *
 * The list lives here and nowhere else. DESIGN.md names this script.
 */

import { readFileSync, globSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

/**
 * The banned hues: the pink/purple family §1 refuses, spelled the ways it
 * has actually arrived — hex from vendored palettes and mermaid's own
 * defaults, plus the `hsl(245` opener a gradient tends to come in on.
 * Matching is case-insensitive; a hex is written once, in the case it was
 * first found in.
 */
export const BANNED_HUES = [
  '5646d6', '473bce', '7f75f0', '4f46e5', 'db2777', 'f472b6',
  'ECECFF', '9370DB', 'a626a4', 'c678dd', 'b07aa1', 'ff9da7',
  'hsl(245',
];

/** Where a hue may hide: everything the site ships, source and built. */
const TREES = [
  { dir: 'packages/website/src', patterns: ['**/*.{js,css,html,json,svg}'], required: true },
  { dir: 'packages/website/dist', patterns: ['**/*.{js,css,html,svg}'], required: false },
];

/**
 * @typedef {object} DesignReport
 * @property {number} code - 0 green, 1 failed, 2 unrunnable
 * @property {number} files - files scanned
 * @property {string[]} hits - `file:offset — hue` for every occurrence
 * @property {string[]} notes - why a tree could not be scanned
 */

/**
 * Scan for the banned hues.
 * @param {{ root?: string, trees?: typeof TREES }} [options]
 * @returns {DesignReport}
 */
export function checkSiteDesign(options = {}) {
  const root = options.root ?? ROOT;
  const trees = options.trees ?? TREES;
  const needles = BANNED_HUES.map((h) => h.toLowerCase());
  /** @type {string[]} */
  const hits = [];
  /** @type {string[]} */
  const notes = [];
  let files = 0;
  for (const tree of trees) {
    const dir = join(root, tree.dir);
    if (!existsSync(dir)) {
      notes.push(`${tree.dir} does not exist`
        + (tree.required ? '' : " — run `npm run website:build` first; a hue can enter through a "
          + 'dependency and never appear in a file this repository authored'));
      continue;
    }
    for (const rel of tree.patterns.flatMap((p) => globSync(p, { cwd: dir })).sort()) {
      files += 1;
      const text = readFileSync(join(dir, rel), 'utf8').toLowerCase();
      for (const needle of needles) {
        let at = text.indexOf(needle);
        while (at !== -1) {
          hits.push(`${tree.dir}/${rel}:${at} — ${needle}`);
          at = text.indexOf(needle, at + needle.length);
        }
      }
    }
  }
  const unrunnable = notes.length > 0 && files === 0;
  return { code: hits.length > 0 ? 1 : (unrunnable ? 2 : 0), files, hits, notes };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = checkSiteDesign();
  for (const note of report.notes) console.warn(`WARNING: ${note}`);
  if (report.hits.length > 0) {
    console.error(`banned hues (docs/DESIGN.md §1) — ${report.hits.length} occurrence(s):\n\n`
      + `${report.hits.join('\n')}\n`);
    process.exit(1);
  }
  if (report.code === 2) {
    console.error('nothing was scanned: neither the site source nor a build exists.');
    process.exit(2);
  }
  console.log(`design sweep: 0 banned hues across ${report.files} site source and built files `
    + `(${BANNED_HUES.length} hues checked).`);
}
