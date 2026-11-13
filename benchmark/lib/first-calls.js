//#region first calls
// A suite's first-calls tables: what an operation costs over its first
// calls in a fresh process, before its engine has settled, as a service's
// first requests after a start meet it. The suite's other tables time an
// engine once it has settled, which can take some engines tens of
// thousands of calls. Each cell is a child process of the suite script
// (`--first-calls <case>/<engine>`) that builds the operation untimed,
// times its first calls without a single call before them, and writes
// the ns/op of the first `counts[k]` calls; the cell is the median of
// FIRST_PROCESSES such children. BENCH_FIRST_PROCESSES overrides that
// count (website-data runs a suite in three processes and takes the
// median of theirs, so it asks each for one).

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { refuseThenable } from './measure.js';

const FIRST_PROCESSES = processesFromEnv();

function processesFromEnv() {
  const raw = process.env.BENCH_FIRST_PROCESSES;
  if (raw === undefined || raw === '')
    return 3;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1)
    throw new Error(`BENCH_FIRST_PROCESSES must be a positive integer, got ${JSON.stringify(raw)}`);
  return n;
}

/**
 * This process's first-calls cell, when it is a first-calls child: the
 * `--first-calls <case>/<engine>` and `--first-calls-out <file>` flags.
 * A suite reads it before anything that would call an engine (priming,
 * equivalence checks), so the child's timed calls are its first.
 * @param {string[]} [argv]
 * @returns {{ caseKey: string, engineKey: string, out: string } | null}
 */
export function firstCallsCell(argv = process.argv) {
  const at = argv.indexOf('--first-calls');
  if (at === -1)
    return null;
  const cell = argv[at + 1] ?? '';
  const slash = cell.indexOf('/');
  const outAt = argv.indexOf('--first-calls-out');
  if (slash <= 0 || slash === cell.length - 1 || outAt === -1 || argv[outAt + 1] === undefined)
    throw new Error(`--first-calls needs <case>/<engine> and --first-calls-out <file>, got ${JSON.stringify(argv.slice(2))}`);
  return { caseKey: cell.slice(0, slash), engineKey: cell.slice(slash + 1), out: argv[outAt + 1] };
}

/**
 * The ns/op of an operation's first `counts[k]` calls, cumulatively: the
 * first figure covers calls 1..counts[0], the next 1..counts[1].
 * @param {(i: number) => unknown} op
 * @param {number[]} counts - ascending
 * @param {{ awaited?: boolean }} [options] - await each call
 * @returns {Promise<Record<number, number>>}
 */
export async function timeFirstCalls(op, counts, { awaited = false } = {}) {
  const out = {};
  let done = 0;
  let ns = 0;
  for (const calls of counts) {
    const start = process.hrtime.bigint();
    if (awaited) {
      for (; done < calls; done++)
        await op(done);
    }
    else {
      if (done === 0) {
        refuseThenable(op(0), 'first calls');
        done = 1;
      }
      for (; done < calls; done++)
        op(done);
    }
    ns += Number(process.hrtime.bigint() - start);
    out[calls] = ns / calls;
  }
  return out;
}

/**
 * Run this process's cell: build the operation, time its first calls and
 * write them where the parent reads them.
 * @param {{ caseKey: string, engineKey: string, out: string }} cell
 * @param {(caseKey: string, engineKey: string) => Promise<{ op: (i: number) => unknown, awaited?: boolean }> | { op: (i: number) => unknown, awaited?: boolean }} build
 * @param {number[]} counts
 */
export async function runFirstCallsCell(cell, build, counts) {
  const { op, awaited = false } = await build(cell.caseKey, cell.engineKey);
  writeFileSync(cell.out, JSON.stringify(await timeFirstCalls(op, counts, { awaited })));
}

/** The middle value of an odd count, or the mean of the middle two. */
function medianOf(values) {
  const sorted = values.toSorted((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Measure a suite's first-calls tables: every case × engine cell in
 * FIRST_PROCESSES fresh children of `script`, one table per count.
 * @param {string} script - the suite's `import.meta.url`
 * @param {object} spec
 * @param {string} spec.operation - what one call does, for the titles
 * @param {number[]} spec.counts - ascending call counts, one table each
 * @param {{ key: string, name: string }[]} spec.cases - the rows
 * @param {{ key: string, label: string }[]} spec.engines - the columns
 * @param {(caseKey: string, engineKey: string) => boolean} [spec.skip] - cells left as a dash
 * @param {string[]} [spec.args] - extra arguments every child gets
 * @returns {{ operation: string, counts: number[], processes: number, tables: { title: string, columns: string[], rows: { name: string, results: (number | null)[] }[] }[] }}
 */
export function measureFirstCalls(script, { operation, counts, cases, engines, skip = () => false, args = [] }) {
  const self = fileURLToPath(script);
  const dir = mkdtempSync(join(tmpdir(), 'jaren-first-calls-'));
  const cells = {};
  try {
    for (const c of cases) {
      cells[c.key] = {};
      for (const e of engines) {
        if (skip(c.key, e.key)) continue;
        const runs = [];
        for (let p = 0; p < FIRST_PROCESSES; p++) {
          const out = join(dir, `${c.key}.${e.key}.${p}.json`);
          const result = spawnSync(process.execPath, [...process.execArgv, self, ...args,
            '--first-calls', `${c.key}/${e.key}`, '--first-calls-out', out], { stdio: ['ignore', 'ignore', 'inherit'] });
          if (result.status !== 0)
            throw new Error(`first calls of ${c.key}/${e.key} exited with status ${result.status}`);
          runs.push(JSON.parse(readFileSync(out, 'utf8')));
        }
        cells[c.key][e.key] = Object.fromEntries(counts.map((n) => [n, medianOf(runs.map((run) => run[n]))]));
      }
    }
  }
  finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return {
    operation,
    counts,
    processes: FIRST_PROCESSES,
    tables: counts.map((n) => ({
      title: `First ${n.toLocaleString('en-US')} calls in a fresh process — ${operation}`,
      columns: engines.map((e) => e.label),
      rows: cases.map((c) => ({ name: c.name, results: engines.map((e) => cells[c.key][e.key]?.[n] ?? null) })),
    })),
  };
}

//#endregion
