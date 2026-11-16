#!/usr/bin/env node
//@ts-check
/**
 * The full gate, as one command with an exit code. The independent read-only
 * stages — lint, the test suite, the dead-code audit, the derived-text check
 * and the document check — can run together. This runner:
 *
 *   1. runs those five stages CONCURRENTLY,
 *   2. then builds the website ONCE,
 *   3. then runs `test:design` (it reads the built `dist/`),
 *   4. then runs the Playwright matrix against that same build.
 *
 * The test suite and the dead-code audit (`benchmark:coverage`, the same
 * suite under c8) each run EVERY test file. Left at node's default — one
 * file per core — the two together asked for twice the host's cores: on 16
 * cores the one-minute load reached 35–60 (a single suite alone drives
 * about 2 per file slot: the files spawn processes, workers and database
 * connections) and timing, heap and lease tests that pass alone failed the
 * gate. So the gate bounds BOTH to the same explicit `--test-concurrency`:
 * a quarter of the cores, at least 2, never above node's own default
 * (cores − 1) — 4 on 16 cores, measured at load 14 for the same phase-1
 * wall time. `SITE_GATE_TEST_CONCURRENCY=<n>` overrides it (a positive
 * integer; anything else is refused before any stage starts). The `test`
 * stage runs the package's own `test` script with node directly, the bound
 * spliced in after its `--test` (npm cannot place a flag before the
 * script's glob); the audit reads the same variable. A plain `npm test`
 * outside the gate keeps node's default.
 *
 * Output is buffered per stage and printed whole when the stage settles, so
 * nothing interleaves and a record can still quote every stage's counts.
 * The first failure aborts the run (remaining children are killed) and the
 * failing stage's output is what you see last. The exit code is the gate.
 *
 * Browser scope (`--browser=`):
 *   full   (default) — the three-engine matrix, required for any change
 *                      that touches the website workspace or anything it
 *                      imports, and before every release;
 *   smoke            — chromium only, allowed for changes that cannot
 *                      affect the site (CI's browser job still runs the
 *                      full matrix on every push, so the backstop holds);
 *   skip             — no browser stage at all; for tight inner loops
 *                      only, never the gate a change lands on.
 *
 * Every other argument (e.g. `--workers=1` on a loaded host) is forwarded
 * to Playwright verbatim: `npm run site:gate -- --browser=smoke --workers=1`.
 *
 * A host that cannot launch every engine directly (missing system
 * libraries for one of them, say) sets `SITE_GATE_BROWSER_SHELL` to the
 * COMPLETE command that runs the matrix — e.g. a `podman exec … npx
 * playwright test -c packages/website/playwright.config.js` into a
 * container that has the libraries; the site is already built, on the
 * host, by the time it runs. In full mode the runner then executes that
 * command verbatim (forwarded Playwright arguments do not apply — bake
 * them into the command); smoke mode always runs chromium on the host.
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import process from 'node:process';
import { npmCliPath } from './lib/portable.js';

/** @typedef {{ name: string, args: string[] }} Stage */

const argv = process.argv.slice(2);
/** @type {'full' | 'smoke' | 'skip'} */
let browser = 'full';
/** @type {string[]} */
const playwrightArgs = [];
for (const arg of argv) {
  const match = /^--browser=(full|smoke|skip)$/.exec(arg);
  if (match !== null) browser = /** @type {any} */ (match[1]);
  else if (arg === '--browser' || arg.startsWith('--browser=')) {
    console.error('site-gate: use --browser=full|smoke|skip');
    process.exit(2);
  }
  else playwrightArgs.push(arg);
}

const cores = availableParallelism();
const override = process.env.SITE_GATE_TEST_CONCURRENCY;
if (override !== undefined && !/^[1-9]\d*$/.test(override)) {
  console.error(`site-gate: SITE_GATE_TEST_CONCURRENCY must be a positive integer (got ${JSON.stringify(override)})`);
  process.exit(2);
}
/** files each whole-suite stage runs at once (see the header) */
const testConcurrency = override !== undefined
  ? Number(override)
  : Math.max(1, Math.min(cores - 1, Math.max(2, Math.floor(cores / 4))));
// the audit's own `node --test` run reads it from here
process.env.SITE_GATE_TEST_CONCURRENCY = String(testConcurrency);

/** @type {Map<string, import('node:child_process').ChildProcess>} */
const running = new Map();
let failed = false;

/**
 * Run one command with buffered output and a labeled result, including
 * launch failures that happen before a child can produce output.
 * @param {string} label
 * @param {string} command
 * @param {string[]} args
 * @param {boolean} [shell]
 * @returns {Promise<{ label: string, code: number, output: string, seconds: string }>}
 */
function commandStage(label, command, args, shell = false) {
  return new Promise((resolve) => {
    const started = Date.now();
    let output = '';
    let finished = false;
    /** @param {number} code */
    function finish(code) {
      if (finished) return;
      finished = true;
      running.delete(label);
      resolve({
        label,
        code,
        output,
        seconds: ((Date.now() - started) / 1000).toFixed(1),
      });
    }
    /** @param {unknown} error */
    function fail(error) {
      output += `${error instanceof Error ? error.message : String(error)}\n`;
      finish(1);
    }
    try {
      const child = spawn(command, args, { env: process.env, shell });
      running.set(label, child);
      child.stdout?.on('data', (chunk) => { output += chunk; });
      child.stderr?.on('data', (chunk) => { output += chunk; });
      child.on('error', fail);
      child.on('close', (code) => finish(code === null ? 1 : code));
    }
    catch (error) {
      fail(error);
    }
  });
}

/**
 * Run npm's JavaScript entry point directly when npm run supplied it, so
 * forwarded arguments stay intact on Windows too. Direct node invocation
 * keeps the npm executable/shim fallback shared with the release scripts.
 * @param {string} label
 * @param {string[]} args
 * @returns {Promise<{ label: string, code: number, output: string, seconds: string }>}
 */
function stage(label, args) {
  const cli = npmCliPath();
  if (cli !== null) return commandStage(label, process.execPath, [cli, ...args]);
  const windows = process.platform === 'win32';
  return commandStage(label, windows ? 'npm.cmd' : 'npm', args, windows);
}

/**
 * The package's `test` script as a node argv with the bound spliced in
 * after `--test`, or the reason it cannot be bounded. The script is read
 * from the manifest npm names (`npm_package_json`), else this package's.
 * @returns {{ args: string[] } | { reason: string }}
 */
function boundedTestArgs() {
  const manifest = process.env.npm_package_json
    ?? new URL('../package.json', import.meta.url);
  const script = JSON.parse(readFileSync(manifest, 'utf8')).scripts?.test;
  const tokens = typeof script === 'string'
    ? [...script.matchAll(/"([^"]*)"|(\S+)/g)].map((match) => match[1] ?? match[2])
    : [];
  const at = tokens.indexOf('--test');
  if (tokens[0] !== 'node' || at < 0 || tokens.some((token) => token.startsWith('--test-concurrency'))) {
    return { reason: `site-gate: cannot bound the test script ${JSON.stringify(script)} — `
      + 'expected `node … --test …` without its own --test-concurrency' };
  }
  return { args: [...tokens.slice(1, at + 1), `--test-concurrency=${testConcurrency}`, ...tokens.slice(at + 1)] };
}

/**
 * The `test` stage: the package's own suite, bounded.
 * @returns {Promise<{ label: string, code: number, output: string, seconds: string }>}
 */
function testStage() {
  const bounded = boundedTestArgs();
  if ('reason' in bounded) return Promise.resolve({ label: 'test', code: 1, output: `${bounded.reason}\n`, seconds: '0.0' });
  return commandStage('test', process.execPath, bounded.args);
}

/** @param {{ label: string, code: number, output: string, seconds: string }} result */
function report(result) {
  const mark = result.code === 0 ? '✔' : '✘';
  console.log(`\n${mark} ${result.label} — ${result.seconds}s (exit ${result.code})`);
  console.log(result.output.trimEnd());
  if (result.code !== 0) failed = true;
}

function abortRemaining() {
  for (const child of running.values()) child.kill('SIGTERM');
}

// ---- phase 1: the independent stages, concurrently --------------------
const PARALLEL = [
  ['lint', ['run', 'lint']],
  ['test', null],
  ['benchmark:coverage', ['run', 'benchmark:coverage']],
  ['docs:check', ['run', 'docs:check']],
  ['test:documents', ['run', 'test:documents']],
];

console.log(`site:gate — ${PARALLEL.length} concurrent stages (both test suites at --test-concurrency=${testConcurrency}), `
  + `then build → design → browser (${browser})`);

const phase1Started = Date.now();
const settled = await Promise.all(PARALLEL.map(([label, args]) => {
  const promise = args === null ? testStage() : stage(String(label), /** @type {string[]} */ (args));
  promise.then((result) => { if (result.code !== 0) abortRemaining(); });
  return promise;
}));
for (const result of settled) report(result);
console.log(`\nphase 1 settled in ${((Date.now() - phase1Started) / 1000).toFixed(1)}s`);
if (failed) {
  console.error('\nsite:gate FAILED in the concurrent stages (any killed stage reports its partial output above)');
  process.exit(1);
}

// ---- phase 2: build once, then everything that reads the build --------
report(await stage('website:build', ['run', 'website:build']));
if (failed) process.exit(1);

report(await stage('test:design', ['run', 'test:design']));
if (failed) process.exit(1);

if (browser === 'skip') {
  console.log('\n⚠ browser stage SKIPPED (--browser=skip) — this run is NOT the full gate');
}
else {
  const shell = process.env.SITE_GATE_BROWSER_SHELL;
  if (browser === 'full' && typeof shell === 'string' && shell.trim() !== '') {
    if (playwrightArgs.length > 0) {
      console.log(`\n⚠ SITE_GATE_BROWSER_SHELL is set — forwarded arguments (${playwrightArgs.join(' ')}) do NOT apply; bake them into the command`);
    }
    report(await commandStage('test:browser (full matrix, via SITE_GATE_BROWSER_SHELL)', 'bash', ['-c', shell]));
  }
  else {
    const args = ['run', 'test:browser:prebuilt', '--'];
    if (browser === 'smoke') args.push('--project=chromium');
    args.push(...playwrightArgs);
    report(await stage(browser === 'smoke' ? 'test:browser (smoke: chromium)' : 'test:browser (full matrix)', args));
  }
  if (failed) process.exit(1);
  if (browser === 'smoke') {
    console.log('\n⚠ browser stage ran the chromium SMOKE only — allowed for changes that cannot affect the site; CI runs the full matrix on push');
  }
}

console.log('\nsite:gate GREEN');
