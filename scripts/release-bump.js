#!/usr/bin/env node
//@ts-check
/**
 * The version bump, as one command with an exit code.
 *
 *   npm run release:bump            # patch
 *   npm run release:bump -- minor   # a phase-opening order or a new capability
 *   npm run release:bump -- major
 *
 * Step 2 of the close-out protocol used to be four commands run in order
 * from memory, and the first of them has a trap: `npm install` under a
 * DIFFERENT npm than the one `packageManager` pins rewrites the lockfile
 * in a shape the pinned npm then refuses, which has cost this repository a
 * red Windows CI more than once. So the pin is asserted before anything is
 * written, not diagnosed afterwards.
 *
 * The npm it runs is the one that launched it: `npm run` publishes its own
 * CLI path as `npm_execpath`, and the bump executes that file under the
 * current Node with a fixed argument vector — no PATH lookup, no shell, no
 * command string, on any platform (a `.cmd` shim on Windows is exactly
 * what this avoids). A missing or foreign `npm_execpath` is a refusal
 * before any write, naming the invocation that supplies it; there is no
 * fallback to a bare `npm`.
 *
 * What it does, aborting at the first failure: resolve the executing CLI →
 * assert its version matches the pin → bump every manifest and every
 * internal range → `npm install` so the lockfile follows → `npm run
 * test:lock` → rebuild. It does not commit, tag, push or deploy: those stay
 * the operator's.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import { npmCliPath } from './lib/portable.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

/** The npm this repository's lockfile shape belongs to. */
export function pinnedNpm(root = ROOT) {
  const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  const pin = String(manifest.packageManager ?? '');
  const match = /^npm@(.+)$/.exec(pin);
  if (match === null) {
    throw new Error(`the root manifest pins '${pin}', which is not an npm version`);
  }
  return match[1];
}

/**
 * Refuse a bump under an npm that is not the pinned one.
 * @param {string} running - `npm --version` output
 * @param {string} pinned
 * @returns {string | null} the refusal, or null when it may proceed
 */
export function npmMismatch(running, pinned) {
  if (running.trim() === pinned) return null;
  return `this repository pins npm@${pinned} (root \`packageManager\`) and npm ${running.trim()} `
    + 'is running.\nA lockfile written by another npm is one the pinned npm refuses, and the '
    + 'failure\nsurfaces in CI rather than here. Run:\n\n'
    + `  npm i -g npm@${pinned}\n`;
}

/**
 * The command that runs the executing npm CLI: the current Node executable
 * over the CLI file `npm run` published, so a path with spaces, a drive
 * letter or a backslash is one argument, never a string a shell re-reads.
 * @param {NodeJS.ProcessEnv} env - `process.env`, or a test's
 * @param {string} execPath - `process.execPath`, or a test's
 * @returns {{ file: string, prefix: string[] } | { refusal: string }}
 */
export function resolveNpmCommand(env, execPath) {
  const cli = npmCliPath(env);
  if (cli === null) {
    return { refusal: 'release:bump runs the npm that launched it, and none did: `npm_execpath` '
      + `is ${env.npm_execpath === undefined ? 'unset' : `'${env.npm_execpath}'`}, which is not an npm CLI. `
      + 'Run it as `npm run release:bump` (optionally `-- minor` / `-- major`) under the pinned npm, '
      + 'not as `node scripts/release-bump.js` and not under another package manager.' };
  }
  return { file: execPath, prefix: [cli] };
}

/** The version the manifests will carry after this bump. */
export function currentVersion(root = ROOT) {
  return JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version;
}

/**
 * @typedef {(file: string, args: string[], options: { cwd: string, stdio?: 'inherit' | 'pipe', encoding?: 'utf8' }) => string | Buffer | undefined} Exec
 */

/**
 * The whole bump, over an injected executor: resolve the CLI, check its
 * version, then version → install → lock test → build, in that order,
 * aborting at the first failure. Returns the exit code; every step is one
 * `exec` call with a fixed argument vector, and nothing is written before
 * the two refusals have passed.
 * @param {{ release: string, env: NodeJS.ProcessEnv, execPath: string, root?: string,
 *   exec: Exec, log?: (line: string) => void, error?: (line: string) => void }} options
 * @returns {number}
 */
export function bump(options) {
  const { release, env, execPath, exec } = options;
  const root = options.root ?? ROOT;
  const log = options.log ?? ((line) => console.log(line));
  const error = options.error ?? ((line) => console.error(line));
  if (!['patch', 'minor', 'major'].includes(release)) {
    error(`unknown release '${release}' — patch, minor or major.`);
    return 2;
  }
  const command = resolveNpmCommand(env, execPath);
  if ('refusal' in command) {
    error(command.refusal);
    return 2;
  }
  const npm = (/** @type {string[]} */ args, /** @type {any} */ extra = {}) =>
    exec(command.file, [...command.prefix, ...args], { cwd: root, ...extra });
  const pinned = pinnedNpm(root);
  const running = String(npm(['--version'], { encoding: 'utf8', stdio: 'pipe' }) ?? '');
  const refusal = npmMismatch(running, pinned);
  if (refusal !== null) {
    error(refusal);
    return 2;
  }
  const before = currentVersion(root);
  const step = (/** @type {string} */ what, /** @type {string[]} */ args) => {
    log(`\n▸ ${what} ${args.join(' ')}`);
    if (what === 'npm') npm(args, { stdio: 'inherit' });
    else exec(execPath, args, { cwd: root, stdio: 'inherit' });
  };
  step('node', ['./scripts/version-packages.js', release]);
  step('npm', ['install']);
  step('npm', ['run', 'test:lock']);
  step('npm', ['run', 'build']);
  log(`\nbumped ${before} → ${currentVersion(root)}; lockfile synced, portable, and built.`);
  log('Nothing was committed, tagged, pushed or deployed.');
  return 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(bump({
    release: process.argv[2] ?? 'patch',
    env: process.env,
    execPath: process.execPath,
    exec: (file, args, options) => execFileSync(file, args, options),
  }));
}
