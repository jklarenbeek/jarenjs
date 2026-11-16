//@ts-check
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/**
 * The gate's own bound on each whole-suite stage: a quarter of the cores,
 * at least 2, never above node's own default (cores - 1).
 */
const BOUND = Math.max(1, Math.min(availableParallelism() - 1, Math.max(2, Math.floor(availableParallelism() / 4))));

/** @param {number} n */
const parallelArgs = (n = BOUND) => [
  ['run', 'lint'], ['test', '--test', `--test-concurrency=${n}`, 'test/**/*.test.js'], ['run', 'benchmark:coverage'],
  ['run', 'docs:check'], ['run', 'test:documents'],
];
const PARALLEL_ARGS = parallelArgs();

/** @param {import('node:test').TestContext} t */
function fixture(t) {
  const temporaryRoot = path.resolve(tmpdir());
  const directory = mkdtempSync(path.join(temporaryRoot, 'jaren-site-gate-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), temporaryRoot);
    rmSync(directory, { recursive: true, force: true });
  });
  const cli = path.join(directory, 'npm-cli.js');
  // the gate runs the package's own `test` script with node directly, its
  // concurrency spliced in after `--test`: this package's script is the stub
  const manifest = path.join(directory, 'package.json');
  writeFileSync(manifest, JSON.stringify({
    scripts: { test: `node "${cli}" test --test "test/**/*.test.js"` },
  }));
  writeFileSync(cli, `
    const fs = require('node:fs');
    const path = require('node:path');
    const args = process.argv.slice(2);
    const name = args[0] === 'test' ? 'test' : args[1];
    const marker = label => path.join(__dirname, label.replaceAll(':', '_') + '.done');
    if (name === 'website:build') {
      for (const prior of ['lint', 'test', 'benchmark:coverage', 'docs:check', 'test:documents']) {
        if (!fs.existsSync(marker(prior))) process.exit(41);
      }
    }
    if (name === 'test:design' && !fs.existsSync(marker('website:build'))) process.exit(42);
    if (name === 'test:browser:prebuilt' && !fs.existsSync(marker('test:design'))) process.exit(43);
    console.log('ARGV ' + JSON.stringify(args));
    if (name === 'benchmark:coverage') console.log('COVERAGE_N ' + process.env.SITE_GATE_TEST_CONCURRENCY);
    if (name === process.env.SITE_GATE_TEST_FAIL) process.exit(23);
    fs.writeFileSync(marker(name), 'done');
  `);
  if (process.platform === 'win32') {
    writeFileSync(path.join(directory, 'npm.cmd'), `@echo off\r\n"${process.execPath}" "${cli}" %*\r\n`);
  }
  else {
    const quote = (/** @type {string} */ value) => "'" + value.replaceAll("'", "'\\''") + "'";
    const shim = path.join(directory, 'npm');
    writeFileSync(shim, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(cli)} "$@"\n`);
    chmodSync(shim, 0o755);
  }
  const env = { ...process.env, npm_execpath: cli, npm_package_json: manifest };
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') ?? 'PATH';
  env[pathKey] = directory + path.delimiter + (env[pathKey] ?? '');
  delete env.SITE_GATE_BROWSER_SHELL;
  delete env.SITE_GATE_TEST_FAIL;
  delete env.SITE_GATE_TEST_CONCURRENCY;
  return {
    env,
    /** @param {string[]} args @param {string | null} [harness] */
    run(args, harness = null) {
      const launch = harness === null
        ? ['scripts/site-gate.js', ...args]
        : ['--input-type=module', '--eval', harness, '--', ...args];
      const result = spawnSync(process.execPath, launch, { cwd: ROOT, env, encoding: 'utf8', timeout: 30_000 });
      assert.ifError(result.error);
      return result;
    },
  };
}

/** @param {string} output @returns {string[][]} */
function stageArgs(output) {
  return [...output.matchAll(/^ARGV (.+)$/gm)].map(match => JSON.parse(match[1]));
}

for (const mode of ['full', 'smoke']) {
  it(`site:gate forwards spaced Playwright arguments intact in ${mode} mode and builds once`, t => {
    const gate = fixture(t);
    const forwarded = ['--grep', 'heading renders', '--grep-invert', 'mobile layout', '--list'];
    const result = gate.run([`--browser=${mode}`, ...forwarded]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const browser = ['run', 'test:browser:prebuilt', '--'];
    if (mode === 'smoke') browser.push('--project=chromium');
    browser.push(...forwarded);
    assert.deepStrictEqual(stageArgs(result.stdout), [
      ...PARALLEL_ARGS, ['run', 'website:build'], ['run', 'test:design'], browser,
    ]);
    assert.equal((result.stdout.match(/\(exit 0\)/g) ?? []).length, 8);
    assert.match(result.stdout, /site:gate GREEN/);
  });
}

it('site:gate bounds both whole-suite stages to the same explicit concurrency, and the override wins', t => {
  const gate = fixture(t);
  const bounded = gate.run(['--browser=skip']);
  assert.equal(bounded.status, 0, bounded.stdout + bounded.stderr);
  assert.deepStrictEqual(stageArgs(bounded.stdout).slice(0, 5), parallelArgs(BOUND));
  assert.match(bounded.stdout, new RegExp(`^COVERAGE_N ${BOUND}$`, 'm'));
  if (availableParallelism() >= 4) assert.ok(BOUND < availableParallelism() - 1, `${BOUND} is below node's default`);

  gate.env.SITE_GATE_TEST_CONCURRENCY = '3';
  const overridden = gate.run(['--browser=skip']);
  assert.equal(overridden.status, 0, overridden.stdout + overridden.stderr);
  assert.deepStrictEqual(stageArgs(overridden.stdout).slice(0, 5), parallelArgs(3));
  assert.match(overridden.stdout, /^COVERAGE_N 3$/m);

  for (const invalid of ['0', '-1', '2.5', 'four', '']) {
    gate.env.SITE_GATE_TEST_CONCURRENCY = invalid;
    const refused = gate.run(['--browser=skip']);
    assert.equal(refused.status, 2, `${JSON.stringify(invalid)}: ${refused.stdout}${refused.stderr}`);
    assert.deepStrictEqual(stageArgs(refused.stdout), []);
    assert.match(refused.stderr, /SITE_GATE_TEST_CONCURRENCY/);
  }
});

it('site:gate refuses a test script it cannot bound instead of running it unbounded', t => {
  const gate = fixture(t);
  writeFileSync(gate.env.npm_package_json ?? '', JSON.stringify({ scripts: { test: 'vitest run' } }));
  const result = gate.run(['--browser=skip']);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /✘ test — .*\(exit 1\)/);
  assert.match(result.stdout, /cannot bound/);
  assert.doesNotMatch(result.stdout, /site:gate GREEN/);
});

it('site:gate keeps the npm shim fallback for direct node invocation', t => {
  const gate = fixture(t);
  delete gate.env.npm_execpath;
  const result = gate.run(['--browser=skip']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepStrictEqual(stageArgs(result.stdout), [
    ...PARALLEL_ARGS, ['run', 'website:build'], ['run', 'test:design'],
  ]);
  assert.match(result.stdout, /browser stage SKIPPED/);
});

it('site:gate stops after a failed build and reports its exit code', t => {
  const gate = fixture(t);
  gate.env.SITE_GATE_TEST_FAIL = 'website:build';
  const result = gate.run([]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.deepStrictEqual(stageArgs(result.stdout), [...PARALLEL_ARGS, ['run', 'website:build']]);
  assert.match(result.stdout, /✘ website:build — .*\(exit 23\)/);
  assert.doesNotMatch(result.stdout, /site:gate GREEN/);
});

for (const mode of ['throw', 'error']) {
  it(`site:gate labels a browser command spawn ${mode} as a failed stage`, t => {
    const gate = fixture(t);
    gate.env.SITE_GATE_BROWSER_SHELL = 'harmless fixture command';
    const harness = `
      import cp from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      const original = cp.spawn;
      cp.spawn = (command, args, options) => {
        if (command !== 'bash') return original(command, args, options);
        ${mode === 'throw'
          ? "throw new Error('GATE_SPAWN_REFUSED');"
          : "return original('__jaren_site_gate_missing_command__', args, options);"}
      };
      syncBuiltinESMExports();
      process.argv = [process.execPath, 'scripts/site-gate.js'];
      await import('./scripts/site-gate.js');
    `;
    const result = gate.run([], harness);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.deepStrictEqual(stageArgs(result.stdout), [
      ...PARALLEL_ARGS, ['run', 'website:build'], ['run', 'test:design'],
    ]);
    assert.match(result.stdout, /✘ test:browser \(full matrix, via SITE_GATE_BROWSER_SHELL\) — .*\(exit 1\)/);
    assert.match(result.stdout, mode === 'throw' ? /GATE_SPAWN_REFUSED/ : /ENOENT/);
    assert.doesNotMatch(result.stderr, /Unhandled 'error' event/);
    assert.doesNotMatch(result.stdout, /site:gate GREEN/);
  });
}

it('site:gate rejects malformed browser modes before any stage, including after skip', () => {
  const harness = `
    import cp from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    cp.spawn = () => { throw new Error('GATE_STAGE_STARTED'); };
    syncBuiltinESMExports();
    process.argv = [process.execPath, 'scripts/site-gate.js', '--browser=skip', process.argv[1]];
    await import('./scripts/site-gate.js');
  `;
  for (const invalid of ['--browser=typo', '--browser=', '--browser']) {
    const result = spawnSync(process.execPath,
      ['--input-type=module', '--eval', harness, '--', invalid],
      { cwd: ROOT, encoding: 'utf8', timeout: 30_000 });
    assert.ifError(result.error);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr.trim(), 'site-gate: use --browser=full|smoke|skip');
  }
});
