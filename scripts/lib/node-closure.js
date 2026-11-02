//@ts-check
/**
 * @file What a Node server loads for one import. A bundler drops the
 * modules a consumer never reaches; Node's loader does not: importing a
 * subpath loads every module its static import graph names and holds them
 * for the life of the process. This measures that closure for every
 * importable subpath of the given workspaces — the files a fresh Node
 * process loads for that one `import`, attributed to the workspace that
 * owns each, and the live heap they hold — and compares the module counts
 * with a committed measurement (`scripts/check-tree-shaking.js` commits
 * `benchmark/node-closures.json`).
 *
 * The subpaths are `./exports.js`'s census — the JavaScript subpaths the
 * packed-consumer check imports and the README inventories list, a
 * wildcard's committed files one by one. A module is every `file:` URL
 * the loader loads (a JSON module counts; a `node:` built-in does not),
 * attributed to the workspace directory it lies in, or to `(other)`
 * outside every workspace. The live heap is the V8 heap after two forced
 * full collections less the same process's heap before the import: a raw
 * `heapUsed` counts garbage the import left behind, and RSS moves with
 * the allocator rather than the import. The collector runs on the main
 * thread (`--single-threaded-gc`): with helper threads a collection can
 * still be sweeping when the heap is read, so a run reads garbage as live
 * — several times the live set of the smallest closures, and most often
 * on a loaded host. Module counts are a function of the tree and are
 * compared by equality; a heap differs a little between fresh processes
 * and more between hosts, so it is a median over several processes,
 * re-measured and never compared.
 */

import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { exportEntries } from './exports.js';

/** The fresh processes behind each committed heap figure. */
export const CLOSURE_RUNS = 5;

/** The owner of a module that lies in no workspace. Parentheses keep it
 * apart from any name npm accepts for a new package. */
const OTHER = '(other)';

/**
 * The program a fresh process runs to import `specifier`. The load hook is
 * in-thread (`module.registerHooks`) and registered before the import, so
 * it sees every module the import loads; nothing runs between the two heap
 * readings but the import, because anything else (a first `performance`
 * read, say) loads Node internals the import would be charged for.
 * @param {string} specifier
 */
const probeProgram = (specifier) => `
import { registerHooks } from 'node:module';
const loaded = [];
registerHooks({ load(url, context, nextLoad) { if (url.startsWith('file:')) loaded.push(url); return nextLoad(url, context); } });
const collect = () => { globalThis.gc(); globalThis.gc(); };
process.memoryUsage();
collect();
const before = process.memoryUsage().heapUsed;
await import(${JSON.stringify(specifier)});
collect();
const heap = process.memoryUsage().heapUsed - before;
process.stdout.write(JSON.stringify({ loaded, heap }));
`;

/**
 * @typedef {object} ClosureEntry
 * @property {number} modules - every module the import loads
 * @property {Record<string, number>} byPackage - the same, by the owning
 *   workspace's unscoped name (`(other)` outside every workspace)
 * @property {number} heapBytes - the median live heap the import holds
 * @property {number} heapSpreadBytes - the largest run less the smallest
 * @property {string} [wildcard] - the manifest pattern a wildcard file's
 *   subpath was expanded from
 */

/**
 * @typedef {object} ClosureMeasurement
 * @property {string} runtime - the measuring Node's `process.version`
 * @property {string} platform - `<process.platform> <process.arch>`
 * @property {number} runs - fresh processes per subpath
 * @property {Record<string, ClosureEntry>} subpaths
 */

/**
 * @typedef {(specifier: string, cwd: string) => { loaded: string[], heap: number }} ClosureProbe
 */

/**
 * One fresh Node process importing `specifier` from `cwd`: the `file:`
 * URLs it loaded, in load order, and the live heap the import holds.
 * @type {ClosureProbe}
 */
function probeClosure(specifier, cwd) {
  const result = spawnSync(process.execPath,
    ['--expose-gc', '--single-threaded-gc', '--no-warnings', '--input-type=module', '-e', probeProgram(specifier)],
    { cwd, encoding: 'utf8', timeout: 60000, env: { ...process.env, FORCE_COLOR: '0' } });
  if (result.status !== 0) {
    const why = result.error?.message ?? (result.stderr.trim() || `exit ${result.status ?? result.signal}`);
    throw new Error(`${specifier}: a fresh Node process could not import it\n${why}`);
  }
  return JSON.parse(result.stdout);
}

/** `counts` with its keys in order, so equal splits serialize equally.
 * @param {Record<string, number>} counts @returns {Record<string, number>} */
const sortedKeys = (counts) => Object.fromEntries(Object.keys(counts).sort().map((key) => [key, counts[key]]));

/**
 * A module split as a reader reads it: the largest share first, a tie by
 * name (`contract 17, core 16, json 7, validate 6`).
 * @param {Record<string, number>} byPackage
 * @returns {string}
 */
export const splitOf = (byPackage) => Object.entries(byPackage)
  .sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1)).map(([name, n]) => `${name} ${n}`).join(', ');

/** An entry's counts as the check's messages name them: `46 (contract 17, …)`.
 * @param {{ modules: number, byPackage: Record<string, number> }} entry */
const describe = ({ modules, byPackage }) => `${modules} (${splitOf(byPackage)})`;

/** Whether two entries load the same modules from the same packages.
 * @param {{ modules: number, byPackage: Record<string, number> }} a @param {typeof a} b */
const sameCounts = (a, b) => a.modules === b.modules
  && JSON.stringify(sortedKeys(a.byPackage)) === JSON.stringify(sortedKeys(b.byPackage));

/** @param {number[]} sorted @returns {number} */
const median = (sorted) => {
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
};

/**
 * Measure every importable subpath of `workspaces` in fresh Node
 * processes started in `cwd` (where the workspaces resolve by name),
 * `runs` processes per subpath. The runs are interleaved — every subpath
 * once, then every subpath again — so a passing disturbance on the host
 * lands on one run of many subpaths rather than on every run of one. A
 * subpath whose processes loaded different module counts is refused:
 * counts are published as exact.
 * @param {{ cwd: string, workspaces: { name: string, dir: string, pkg: any }[], runs: number, probe?: ClosureProbe }} options
 * @returns {ClosureMeasurement}
 */
export function measureClosures({ cwd, workspaces, runs, probe = probeClosure }) {
  // a module's URL is its real path, so the workspace directories are too;
  // the longest prefix owns a file, should one workspace sit inside another
  const owners = workspaces
    .map(({ name, dir }) => [`${pathToFileURL(realpathSync(dir)).href}/`, name.replace(/^@[^/]+\//, '')])
    .sort(([a], [b]) => b.length - a.length);
  /** @param {string[]} loaded */
  const attribute = (loaded) => {
    /** @type {Record<string, number>} */
    const byPackage = {};
    for (const url of loaded) {
      const owner = owners.find(([prefix]) => url.startsWith(prefix))?.[1] ?? OTHER;
      byPackage[owner] = (byPackage[owner] ?? 0) + 1;
    }
    return { modules: loaded.length, byPackage: sortedKeys(byPackage) };
  };
  const entries = workspaces.flatMap(({ pkg, dir }) => exportEntries(pkg, dir)).filter((entry) => entry.kind === 'javascript');
  /** @type {{ loaded: string[], heap: number }[][]} */
  const samples = entries.map(() => []);
  for (let run = 0; run < runs; run += 1) {
    entries.forEach(({ subpath }, at) => samples[at].push(probe(subpath, cwd)));
  }
  /** @type {Record<string, ClosureEntry>} */
  const subpaths = {};
  entries.forEach(({ subpath, key, expanded }, at) => {
    const [first, ...rest] = samples[at];
    const counted = attribute(first.loaded);
    for (const sample of rest) {
      const again = attribute(sample.loaded);
      if (!sameCounts(again, counted)) {
        throw new Error(`${subpath} loaded different modules in two fresh processes: ${describe(counted)}, then ${describe(again)}`);
      }
    }
    const heaps = samples[at].map(({ heap }) => heap).sort((a, b) => a - b);
    subpaths[subpath] = {
      ...counted,
      heapBytes: median(heaps),
      heapSpreadBytes: heaps[heaps.length - 1] - heaps[0],
      ...(expanded ? { wildcard: key } : {}),
    };
  });
  return { runtime: process.version, platform: `${process.platform} ${process.arch}`, runs, subpaths };
}

/**
 * Every way the committed module counts disagree with the tree's: a
 * subpath whose total or split moved, one the file lacks, and one no
 * manifest exports any longer — a line each, naming both sides. Heap
 * figures are not compared.
 * @param {ClosureMeasurement} committed @param {ClosureMeasurement} measured
 * @returns {string[]}
 */
export function staleClosures(committed, measured) {
  const lines = [];
  for (const [subpath, now] of Object.entries(measured.subpaths)) {
    const was = Object.hasOwn(committed.subpaths, subpath) ? committed.subpaths[subpath] : undefined;
    if (was === undefined) lines.push(`  ${subpath}: not in the committed file, measured ${describe(now)}`);
    else if (!sameCounts(was, now)) lines.push(`  ${subpath}: committed ${describe(was)}, measured ${describe(now)}`);
  }
  for (const [subpath, was] of Object.entries(committed.subpaths)) {
    if (!Object.hasOwn(measured.subpaths, subpath)) lines.push(`  ${subpath}: committed ${describe(was)}, no longer an importable subpath`);
  }
  return lines;
}

/**
 * The committed file's text: the runtime and run count on top, then one
 * line per subpath in subpath order, so a re-measure's diff is a line per
 * subpath that moved.
 * @param {ClosureMeasurement} measurement
 * @returns {string}
 */
export function serializeClosures({ runtime, platform, runs, subpaths }) {
  const rows = Object.keys(subpaths).sort().map((subpath) => {
    const { modules, byPackage, heapBytes, heapSpreadBytes, wildcard } = subpaths[subpath];
    const entry = { modules, byPackage: sortedKeys(byPackage), heapBytes, heapSpreadBytes, ...(wildcard === undefined ? {} : { wildcard }) };
    return `    ${JSON.stringify(subpath)}: ${JSON.stringify(entry)}`;
  });
  return ['{', `  "runtime": ${JSON.stringify(runtime)},`, `  "platform": ${JSON.stringify(platform)},`, `  "runs": ${runs},`,
    '  "subpaths": {', rows.join(',\n'), '  }', '}', ''].join('\n');
}
