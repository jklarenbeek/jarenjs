//@ts-check
/**
 * Repository facts read from git, for the generators that stamp
 * provenance into the built site.
 *
 * Both callers derive their timestamps from the HEAD COMMIT rather than
 * the clock, so a rebuild of the same commit is byte-identical — the
 * property the site's generator tests assert. A checkout with no git
 * (a tarball) can answer none of these questions, and every helper here
 * says so with `null` instead of guessing.
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
