//@ts-check
/**
 * The Node closure figures: what a server loads for each subpath, written
 * into `docs/CONSUMING.md` between `<!--fact:closure.*-->` … `<!--/fact-->`
 * markers by `scripts/derive-docs.js` from `benchmark/node-closures.json`,
 * the measurement `scripts/check-tree-shaking.js --write` commits. This
 * reads the committed file and never measures: a measurement starts
 * hundreds of Node processes, and a derivation must be instant and the
 * same on every machine.
 *
 * The file holds every importable subpath of every public package. The
 * document publishes one table per server package, over the subpaths its
 * manifest names; a wildcard's files (`@jarenjs/core/dates/*`) stay in the
 * file, which keeps the tables readable and their row rule one filter.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { splitOf } from './lib/node-closure.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const FILE = 'benchmark/node-closures.json';
const MIB = 1024 * 1024;

/** The packages a Node server imports, in the order the document publishes their tables. */
export const SERVER_PACKAGES = ['@jarenjs/contract', '@jarenjs/db', '@jarenjs/linq', '@jarenjs/json', '@jarenjs/validate', '@jarenjs/core'];

/**
 * One package's table: every subpath its manifest names, the root first,
 * with the modules it loads, their split by package and its live heap.
 * @param {import('./lib/node-closure.js').ClosureMeasurement} measurement
 * @param {string} name - the package, `@jarenjs/<name>`
 * @returns {string} a block: the markers stay on their own lines
 */
export function closureTable(measurement, name) {
  const rows = Object.entries(measurement.subpaths)
    .filter(([subpath, entry]) => (subpath === name || subpath.startsWith(`${name}/`)) && entry.wildcard === undefined)
    .map(([subpath, entry]) => /** @type {const} */ ([`.${subpath.slice(name.length)}`, entry]))
    .sort(([a], [b]) => (a < b ? -1 : 1));
  if (rows.length === 0) {
    throw new Error(`${FILE} has no subpath of ${name} — re-measure with \`npm run test:tree-shaking -- --write\``);
  }
  return `\n${['| Subpath | Modules | By package | Live heap MiB |', '|---|---:|---|---:|',
    ...rows.map(([subpath, { modules, byPackage, heapBytes }]) =>
      `| \`${subpath}\` | ${modules} | ${splitOf(byPackage)} | ${(heapBytes / MIB).toFixed(1)} |`)].join('\n')}\n`;
}

/**
 * Every closure figure the document quotes, over the measurement `read`
 * returns: a table per server package, and the method the paragraph above
 * them states — the run count, the widest spread between one subpath's
 * runs, the measuring runtime, and how many subpaths the file holds.
 * @param {() => import('./lib/node-closure.js').ClosureMeasurement} read
 * @returns {Record<string, () => string>}
 */
export function closureFigures(read) {
  return {
    ...Object.fromEntries(SERVER_PACKAGES.map((name) =>
      [`closure.${name.replace(/^@jarenjs\//, '')}`, () => closureTable(read(), name)])),
    'closure.runs': () => String(read().runs),
    // rounded up, so the stated bound is never below a spread the file holds
    'closure.spread': () => `${Math.ceil(Math.max(0, ...Object.values(read().subpaths)
      .map(({ heapSpreadBytes }) => heapSpreadBytes)) / 1024)} KiB`,
    'closure.host': () => `Node ${read().runtime} on ${read().platform}`,
    'closure.subpaths': () => String(Object.keys(read().subpaths).length),
  };
}

/** @type {import('./lib/node-closure.js').ClosureMeasurement | undefined} */
let committed;

/** @type {import('./lib/derive.js').Registry} */
export const closureFacts = {
  name: 'the Node closure measurement',
  docs: () => ['docs/CONSUMING.md'],
  facts: () => closureFigures(() => (committed ??= JSON.parse(readFileSync(join(ROOT, FILE), 'utf8')))),
};
