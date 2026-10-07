//@ts-check
/**
 * Repository facts read from git: the provenance the site generators stamp
 * into the built site, and the working-tree status the deploy guards read.
 *
 * The generators derive their timestamps from the HEAD COMMIT rather than
 * the clock, so a rebuild of the same commit is byte-identical — the
 * property the site's generator tests assert. A checkout with no git
 * (a tarball) can answer none of these questions, and every provenance
 * helper here says so with `null` instead of guessing.
 *
 * The status is read in ONE way for every guard: `git status --porcelain
 * -z`. The line form C-quotes any path holding a space, a quote or a
 * non-ASCII byte (`"caf\303\251.json"`), so two guards that parsed it
 * differently disagreed about the same file.
 */

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/**
 * One git fact from the repository root, trimmed — or null when git is
 * unavailable or the command fails.
 * @param {...string} args - git arguments, e.g. `'rev-parse', 'HEAD'`.
 * @returns {string | null}
 */
export function git(...args) {
  try {
    return execFileSync('git', args, {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  }
  catch {
    return null;
  }
}

/**
 * The HEAD commit and its commit date (ISO 8601), read in ONE call so
 * both facts describe the same revision, or `null`s without git.
 * @returns {{ commit: string | null, committed: string | null }}
 */
export function headCommit() {
  const line = git('log', '-1', '--format=%H %cI');
  if (line === null || line === '') return { commit: null, committed: null };
  const at = line.indexOf(' ');
  return { commit: line.slice(0, at), committed: line.slice(at + 1) };
}

/**
 * Whether the working tree carries uncommitted changes. `null` when git
 * cannot answer — which is not the same as "clean" and must not be
 * treated as it.
 * @returns {boolean | null}
 */
export function isDirty() {
  const status = git('status', '--porcelain');
  return status === null ? null : status !== '';
}

/**
 * @typedef {object} StatusEntry
 * @property {string} status - the two-letter `XY` code
 * @property {string} path - the path as the working tree has it: a rename's
 *   or copy's destination, the path that would ship
 * @property {string} [from] - a rename's or copy's original path
 */

/**
 * The entries of `git status --porcelain -z` output, every path verbatim.
 * A rename or copy carries its original path in the field after its own.
 * @param {string} output
 * @returns {StatusEntry[]}
 */
export function statusEntries(output) {
  const fields = output.split('\0');
  /** @type {StatusEntry[]} */
  const entries = [];
  for (let i = 0; i < fields.length; i++) {
    if (fields[i] === '') continue;
    const status = fields[i].slice(0, 2);
    /** @type {StatusEntry} */
    const entry = { status, path: fields[i].slice(3) };
    if (status.includes('R') || status.includes('C')) entry.from = fields[++i];
    entries.push(entry);
  }
  return entries;
}

/**
 * The paths `git status --porcelain -z` reports in a checkout — renames and
 * copies by destination. Throws when git cannot run there, so a caller can
 * tell "nothing changed" from "cannot say".
 * @param {string} root - the checkout to ask
 * @param {string[]} [args] - further `git status` arguments: untracked and
 *   ignored modes, then `--` and the pathspecs
 * @returns {string[]}
 */
export function changedPaths(root, args = []) {
  const output = execFileSync('git', ['status', '--porcelain', '-z', ...args], { cwd: root, encoding: 'utf8' });
  return statusEntries(output).map((entry) => entry.path);
}
