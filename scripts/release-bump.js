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
 * What it does, aborting at the first failure: assert the running npm
 * matches the pin → bump every manifest and every internal range → `npm
 * install` so the lockfile follows → `npm run test:lock` → rebuild. It
 * does not commit, tag, push or deploy: those stay the operator's.
 */

import { execFileSync, execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

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

/** The version the manifests will carry after this bump. */
export function currentVersion(root = ROOT) {
  return JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const release = process.argv[2] ?? 'patch';
  if (!['patch', 'minor', 'major'].includes(release)) {
    console.error(`unknown release '${release}' — patch, minor or major.`);
    process.exit(2);
  }
  // On Windows `npm` is a `.cmd`, which Node will not spawn as a file —
  // so the bump refused to start at all rather than refusing for one of
  // its own reasons. There it goes through the shell as ONE command
  // string (passing arguments beside `shell: true` is deprecated, and
  // concatenating them here is the documented shape); every argument
  // below is a fixed literal, so the shell has nothing to re-interpret.
  /** @param {string[]} args @param {any} [options] */
  const npm = (args, options = {}) => (process.platform === 'win32'
    ? execSync(`npm ${args.join(' ')}`, options)
    : execFileSync('npm', args, options));
  const pinned = pinnedNpm();
  const running = npm(['--version'], { encoding: 'utf8' });
  const refusal = npmMismatch(running, pinned);
  if (refusal !== null) {
    console.error(refusal);
    process.exit(2);
  }

  const before = currentVersion();
  const run = (/** @type {string} */ what, /** @type {string[]} */ args) => {
    console.log(`\n▸ ${what} ${args.join(' ')}`);
    if (what === 'npm') npm(args, { cwd: ROOT, stdio: 'inherit' });
    else execFileSync(what, args, { cwd: ROOT, stdio: 'inherit' });
  };
  run('node', ['./scripts/version-packages.js', release]);
  run('npm', ['install']);
  run('npm', ['run', 'test:lock']);
  run('npm', ['run', 'build']);
  console.log(`\nbumped ${before} → ${currentVersion()}; lockfile synced, portable, and built.`);
  console.log('Nothing was committed, tagged, pushed or deployed.');
}
