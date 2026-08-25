#!/usr/bin/env node
//@ts-check
/**
 * The full gate, as one command with an exit code — now shaped by what the
 * stages actually cost instead of run as a flat serial chain.
 *
 * Measured on the reference host, the serial chain spent ~85% of its wall
 * clock in the browser matrix and built the website twice (once as its own
 * stage, once again inside `test:browser`). The independent read-only
 * stages — lint, the test suite, the dead-code audit, the figure check and
 * the document check — ran one after another although nothing orders them.
 * So this runner:
 *
 *   1. runs those five stages CONCURRENTLY (wall clock: the slowest one,
 *      the ~30s dead-code audit, instead of their sum),
 *   2. then builds the website ONCE,
 *   3. then runs `test:design` (it reads the built `dist/`),
 *   4. then runs the Playwright matrix against that same build.
 *
 * Output is buffered per stage and printed whole when the stage settles, so
 * nothing interleaves and a record can still quote every stage's counts.
 * The first failure aborts the run (remaining children are killed) and the
 * failing stage's output is what you see last. The exit code is the gate.
 *
 * Browser scope (`--browser=`):
 *   full   (default) — the three-engine matrix, required for any change
 *                      that touches the website workspace or anything it
 *                      imports, and for phase-close / close-out orders;
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
import process from 'node:process';

/** @typedef {{ name: string, args: string[] }} Stage */

const argv = process.argv.slice(2);
/** @type {'full' | 'smoke' | 'skip'} */
let browser = 'full';
/** @type {string[]} */
const playwrightArgs = [];
for (const arg of argv) {
  const match = /^--browser=(full|smoke|skip)$/.exec(arg);
  if (match !== null) browser = /** @type {any} */ (match[1]);
  else if (arg === '--browser') {
    console.error('site-gate: use --browser=full|smoke|skip');
    process.exit(2);
  }
  else playwrightArgs.push(arg);
}

/** @type {Map<string, import('node:child_process').ChildProcess>} */
const running = new Map();
let failed = false;

/**
 * Run one npm script (or raw command) with buffered output.
 * @param {string} label
 * @param {string[]} args - passed to `npm`
 * @returns {Promise<{ label: string, code: number, output: string, seconds: string }>}
 */
function stage(label, args) {
  return new Promise((resolve) => {
    const started = Date.now();
    // npm is npm.cmd on Windows, and Node only spawns a .cmd through a
    // shell; every argument this runner passes is space-free
    const child = process.platform === 'win32'
      ? spawn('npm.cmd', args, { env: process.env, shell: true })
      : spawn('npm', args, { env: process.env });
    running.set(label, child);
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('close', (code) => {
      running.delete(label);
      resolve({
        label,
        code: code === null ? 1 : code,
        output,
        seconds: ((Date.now() - started) / 1000).toFixed(1),
      });
    });
  });
}

/**
 * Run one complete shell command with buffered output (the
 * SITE_GATE_BROWSER_SHELL escape hatch).
 * @param {string} label
 * @param {string} command
 * @returns {Promise<{ label: string, code: number, output: string, seconds: string }>}
 */
function shellStage(label, command) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn('bash', ['-c', command], { env: process.env });
    running.set(label, child);
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('close', (code) => {
      running.delete(label);
      resolve({
        label,
        code: code === null ? 1 : code,
        output,
        seconds: ((Date.now() - started) / 1000).toFixed(1),
      });
    });
  });
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
  ['test', ['test']],
  ['benchmark:coverage', ['run', 'benchmark:coverage']],
  ['docs:check', ['run', 'docs:check']],
  ['test:documents', ['run', 'test:documents']],
];

console.log(`site:gate — ${PARALLEL.length} concurrent stages, then build → design → browser (${browser})`);

const settled = await Promise.all(PARALLEL.map(([label, args]) => {
  const promise = stage(String(label), /** @type {string[]} */ (args));
  promise.then((result) => { if (result.code !== 0) abortRemaining(); });
  return promise;
}));
for (const result of settled) report(result);
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
    report(await shellStage('test:browser (full matrix, via SITE_GATE_BROWSER_SHELL)', shell));
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
