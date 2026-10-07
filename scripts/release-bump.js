#!/usr/bin/env node
//@ts-check
/**
 * The version bump, as one command with an exit code.
 *
 *   npm run release:bump            # patch
 *   npm run release:bump -- minor   # a new capability
 *   npm run release:bump -- major
 *
 * Step 2 of the release protocol used to be four commands run in order
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
 *
 * A bump is not idempotent, so it refuses a tree whose root version already
 * differs from the one HEAD carries: running it again after a failed
 * install would bump a second time. A step that fails after the manifests
 * were written stops with the versions and the way out —
 *
 *   npm run release:bump -- --resume
 *
 * which finishes a written bump (install → test:lock → build) without
 * bumping again, and refuses a tree that is not bumped, or bumped in part.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import { isMainModule } from './lib/main-module.js';
import { npmCliPath } from './lib/portable.js';
import { packageFiles, compareVersions } from './version-packages.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

/** The npm this repository's lockfile shape belongs to: the version of the
 * `packageManager` pin, without the `+sha512.…` integrity hash Corepack
 * may append to it. */
export function pinnedNpm(root = ROOT) {
  const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  const pin = String(manifest.packageManager ?? '');
  const match = /^npm@([^+]+)/.exec(pin);
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
 * The version HEAD's root manifest carries, or null when git cannot say (no
 * checkout, no commit, no manifest at HEAD).
 * @param {string} [root]
 * @returns {string | null}
 */
export function headVersion(root = ROOT) {
  try {
    const manifest = execFileSync('git', ['show', 'HEAD:package.json'],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const version = JSON.parse(manifest).version;
    return typeof version === 'string' ? version : null;
  }
  catch {
    return null;
  }
}

/**
 * The command line: one release word (patch by default), or `--resume` alone.
 * @param {string[]} argv - the arguments after the script
 * @returns {{ release: string, resume: boolean } | { refusal: string }}
 */
export function bumpArguments(argv) {
  const resume = argv.includes('--resume');
  const words = argv.filter((arg) => arg !== '--resume');
  if (resume && words.length > 0)
    return { refusal: '--resume finishes the bump already written; it takes no release word.' };
  if (words.length > 1) return { refusal: `one release word — patch, minor or major — not '${words.join(' ')}'.` };
  return { release: words[0] ?? 'patch', resume };
}

/**
 * Why a written bump cannot be finished, or null when it can: the tree must
 * carry a version above HEAD's, in every manifest the bump writes.
 * @param {string} root @param {string} version @param {string} committed
 * @returns {string | null}
 */
function resumeRefusal(root, version, committed) {
  if (compareVersions(version, committed) <= 0) {
    return `nothing to resume: package.json carries ${version}, `
      + (version === committed ? 'which HEAD already carries. ' : `below HEAD's ${committed}. `)
      + 'Run `npm run release:bump` (optionally `-- minor` / `-- major`) to bump.';
  }
  const behind = packageFiles.filter((file) => JSON.parse(readFileSync(resolve(root, file), 'utf8')).version !== version);
  if (behind.length === 0) return null;
  return `cannot resume: ${behind.length} manifest${behind.length === 1 ? ' does' : 's do'} not carry ${version}: ${behind.join(', ')}. `
    + `Restore every manifest to HEAD's ${committed} and bump again.`;
}

/**
 * @typedef {(file: string, args: string[], options: { cwd: string, stdio?: 'inherit' | 'pipe', encoding?: 'utf8' }) => string | Buffer | undefined} Exec
 */

/**
 * The whole bump, over an injected executor: resolve the CLI, check its
 * version, compare the tree's version with HEAD's, then version → install →
 * lock test → build, in that order, aborting at the first failure. Returns
 * the exit code — 0 bumped, 1 a step failed, 2 refused before any write;
 * every step is one `exec` call with a fixed argument vector, and nothing
 * is written before the refusals have passed. `resume` skips the version
 * step and finishes a bump an earlier run wrote; `head` answers HEAD's
 * version (git, unless a test injects it).
 * @param {{ release: string, env: NodeJS.ProcessEnv, execPath: string, root?: string, resume?: boolean,
 *   head?: (root: string) => string | null, exec: Exec, log?: (line: string) => void,
 *   error?: (line: string) => void }} options
 * @returns {number}
 */
export function bump(options) {
  const { release, env, execPath, exec } = options;
  const root = options.root ?? ROOT;
  const resume = options.resume === true;
  const head = options.head ?? headVersion;
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
  const committed = head(root);
  if (committed === null) {
    error('release:bump compares the version it bumps with the one HEAD carries, and this checkout '
      + 'cannot say what HEAD carries (no git, or no commit).');
    return 2;
  }
  if (resume) {
    const cannot = resumeRefusal(root, before, committed);
    if (cannot !== null) {
      error(cannot);
      return 2;
    }
  }
  else if (before !== committed) {
    error(`the tree is already bumped: package.json carries ${before} and HEAD carries ${committed}, so a second `
      + 'bump would skip a version. A bump that stopped part-way is finished with\n\n'
      + '  npm run release:bump -- --resume\n\n'
      + `(install → test:lock → build, no second bump); otherwise restore the manifests to HEAD's ${committed} first.`);
    return 2;
  }
  /** @type {[string, string[]][]} */
  const steps = [
    ...(resume ? [] : /** @type {[string, string[]][]} */ ([['node', ['./scripts/version-packages.js', release]]])),
    ['npm', ['install']],
    ['npm', ['run', 'test:lock']],
    ['npm', ['run', 'build']],
  ];
  for (const [what, args] of steps) {
    log(`\n▸ ${what} ${args.join(' ')}`);
    try {
      if (what === 'npm') npm(args, { stdio: 'inherit' });
      else exec(execPath, args, { cwd: root, stdio: 'inherit' });
    }
    catch (failure) {
      const written = currentVersion(root);
      const cause = String(/** @type {any} */ (failure)?.message ?? failure).split('\n')[0];
      error(written === committed
        ? `release:bump stopped at \`${what} ${args.join(' ')}\` (${cause}) before any version was written; `
          + 'fix it and run the bump again.'
        : `release:bump stopped at \`${what} ${args.join(' ')}\`, after the manifests were set to ${written} `
          + `(HEAD carries ${committed}): ${cause}\nFix the failure above, then finish the bump without bumping again:\n\n`
          + '  npm run release:bump -- --resume\n');
      return 1;
    }
  }
  log(`\nbumped ${committed} → ${currentVersion(root)}; lockfile synced, portable, and built.`);
  log('Nothing was committed, tagged, pushed or deployed.');
  return 0;
}

if (isMainModule(import.meta.url)) {
  const parsed = bumpArguments(process.argv.slice(2));
  if ('refusal' in parsed) {
    console.error(`release:bump: ${parsed.refusal}`);
    process.exit(2);
  }
  process.exit(bump({
    release: parsed.release,
    resume: parsed.resume,
    env: process.env,
    execPath: process.execPath,
    exec: (file, args, options) => execFileSync(file, args, options),
  }));
}
