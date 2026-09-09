#!/usr/bin/env node
/** The flow benchmark command is itself a composed workflow. Correctness
 * suites may fan out; timed benchmarks run sequentially to avoid CPU contention.
 * --quick is a smoke run, not a publishable measurement. --checkpoint FILE
 * --review pauses for a later --accept or --retry invocation. */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, renameSync, rmSync, mkdtempSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { compileWorkflow } from '@jarenjs/flow';

export const flowBenchmarkDocument = JSON.parse(readFileSync(new URL('./fixtures/flow-workflow.json', import.meta.url), 'utf8'));
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const VERSION = 'flow-harness/1';

/** @param {string[]} args @param {AbortSignal} signal */
function executeNode(args, signal) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, args, { cwd: ROOT, signal, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, killed) => code === 0 ? resolveRun({ ok: true })
      : reject(new Error(`benchmark child failed (${killed ?? code}): ${args.join(' ')}`)));
  });
}

/** The host registry contains process/I/O details; the document contains order,
 * fan-out, review policy and retry bounds. @param {{ execute?: typeof executeNode }} [options] */
export function createFlowBenchmarkTasks(options = {}) {
  const execute = options.execute ?? executeNode;
  const entry = (run) => ({ version: VERSION, run });
  const measure = (name) => entry(async ({ input }, signal) => {
    const directory = mkdtempSync(join(tmpdir(), `jaren-flow-${name}-`));
    const filepath = join(directory, 'report.json');
    try {
      const args = ['--expose-gc', `benchmark/flow-${name}.js`, '--output', 'json', '--filepath', filepath];
      if (input.quick) args.push('--iterations', name === 'fsm' ? '200' : '2');
      await execute(args, signal);
      const report = JSON.parse(readFileSync(filepath, 'utf8'));
      if (name === 'fsm' ? report.wedge?.guardsSurviveJson?.jaren !== true
        : !Array.isArray(report.sync) || !Array.isArray(report.async)) throw new Error(`invalid ${name} benchmark report`);
      return report;
    }
    finally { rmSync(directory, { recursive: true, force: true }); }
  });
  return {
    'verify-fsm': entry((_props, signal) => execute(['--test', 'test/flow/fsm.test.js', 'test/flow/statechart.test.js'], signal)),
    'verify-dag': entry((_props, signal) => execute(['--test', 'test/flow/dag.test.js', 'test/flow/checkpoint.test.js', 'test/flow/task-versions.test.js'], signal)),
    'measure-fsm': measure('fsm'),
    'measure-dag': measure('dag'),
    report: entry(({ input }) => ({
      fsm: input['/states/measure/flow/states/fsm'],
      dag: input['/states/measure/flow/states/dag'],
    })),
  };
}

/** Local-file CAS, with a short exclusive lock around read/compare/rename.
 * A lock held by a crashed process is an explicit error; it is never guessed
 * stale or stolen. The returned store also works for non-benchmark workflows.
 * @param {string} filename */
export function createFlowBenchmarkStore(filename) {
  const path = resolve(filename);
  const read = () => {
    try {
      const value = JSON.parse(readFileSync(path, 'utf8'));
      if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('benchmark checkpoint file must hold a run map');
      return value;
    }
    catch (err) { if (err.code === 'ENOENT') return {}; throw err; }
  };
  return {
    load: (id) => { const all = read(); return Object.hasOwn(all, id) ? all[id] : null; },
    save(id, snapshot, expectedGeneration) {
      mkdirSync(dirname(path), { recursive: true });
      const lock = `${path}.lock`;
      mkdirSync(lock);
      const temporary = join(lock, 'snapshot.json');
      try {
        const all = read();
        if ((Object.hasOwn(all, id) ? all[id].generation : 0) !== expectedGeneration) return false;
        Object.defineProperty(all, id, { value: snapshot, enumerable: true, configurable: true, writable: true });
        writeFileSync(temporary, JSON.stringify(all, null, 2) + '\n');
        renameSync(temporary, path);
        return true;
      }
      finally { rmSync(lock, { recursive: true, force: true }); }
    },
  };
}

async function main() {
  const args = process.argv.slice(2);
  const option = (key) => {
    const index = args.indexOf(key);
    if (index === -1) return undefined;
    if (!args[index + 1] || args[index + 1].startsWith('--')) throw new TypeError(`${key} needs a value`);
    return args[index + 1];
  };
  const file = option('--checkpoint');
  if (args.includes('--review') && !file) throw new TypeError('--review requires --checkpoint so the wait can resume');
  if (args.includes('--accept') && args.includes('--retry')) throw new TypeError('choose either --accept or --retry');
  const store = file ? createFlowBenchmarkStore(file) : undefined;
  const runId = option('--run-id') ?? 'flow-benchmark';
  const saved = store?.load(runId);
  if ((args.includes('--accept') || args.includes('--retry')) && !saved)
    throw new TypeError('--accept/--retry require a saved run selected by --checkpoint and --run-id');
  const input = saved?.context.input ?? { quick: args.includes('--quick'), review: args.includes('--review') };
  const flow = compileWorkflow(flowBenchmarkDocument, { store, tasks: createFlowBenchmarkTasks() });
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort);
  try {
    const result = await flow.run(input, { runId, signal: controller.signal,
      ...(saved ? { expectedGeneration: saved.generation } : {}),
      ...(args.includes('--accept') ? { event: { type: 'accept' } } : args.includes('--retry') ? { event: { type: 'retry' } } : {}),
    });
    const output = option('--filepath');
    if (output) writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
    console.log(`Flow benchmark workflow: ${result.status}; generation ${result.snapshot.generation}.`);
    if (input.quick) console.log('Quick smoke run: these timings are not release measurements.');
    if (result.status === 'waiting') console.log(`Resume with --checkpoint ${file} --run-id ${runId} --accept (or --retry, at most three measurements).`);
  }
  finally { process.removeListener('SIGINT', abort); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
