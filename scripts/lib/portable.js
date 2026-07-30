//@ts-check
/**
 * Portable launching and path arithmetic for the release scripts.
 *
 * Two Windows facts motivate this module, both found by a consumer running
 * the release gate on native Windows:
 *
 * 1. `npm` and `npx` are `.cmd` batch shims there, and `execFileSync` by bare
 *    name does not launch them (Node documents that `.bat`/`.cmd` need a
 *    shell, `cmd.exe`, or the underlying JavaScript entry point). Worse than
 *    failing loudly, a script that treats "no output" as "offline, skip"
 *    turns that launch failure into a green check.
 * 2. String-prefix containment (`path.startsWith(root + '/')`) is not path
 *    containment: native realpaths carry drive letters and backslashes, so
 *    the check rejects everything — or, with the slash flipped, accepts
 *    `/repo-other` as inside `/repo`.
 *
 * Every release script launches package managers through {@link runNpm} and
 * answers "is this path inside that directory" with {@link isWithin}.
 */

import { execFileSync } from 'node:child_process';
import nodePath from 'node:path';

/**
 * Run the npm CLI portably and return its stdout.
 *
 * The primary route invokes npm's own JavaScript entry point under the
 * current Node executable: when a script runs via `npm run`, npm publishes
 * that path as `npm_execpath`, and launching it directly involves no shim,
 * no shell and no PATH lookup on any platform. The `.js` guard keeps a
 * pnpm/yarn-launched script (whose `npm_execpath` points at their own CLI)
 * off this route.
 *
 * The fallback exists for direct `node scripts/...` invocation and is the
 * documented way to run the shim: the real binary on POSIX, `npm.cmd`
 * through a shell on Windows. It cannot fail silently — a launch error
 * throws, and the callers treat missing output as a failure, never a skip.
 * @param {string[]} args - npm arguments, e.g. `['audit', '--json']`
 * @param {import('node:child_process').ExecFileSyncOptions} [options]
 * @returns {string} stdout
 */
export function runNpm(args, options = {}) {
  const npmCli = process.env.npm_execpath;
  if (typeof npmCli === 'string' && npmCli.endsWith('.js')) {
    return String(execFileSync(process.execPath, [npmCli, ...args],
      { encoding: 'utf8', ...options }));
  }
  const bin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  return String(execFileSync(bin, args,
    { encoding: 'utf8', shell: process.platform === 'win32', ...options }));
}

/**
 * Whether `candidate` is `root` or lies inside it — by path arithmetic, not
 * string formatting. `path.relative` owns the platform rules this has to get
 * right: backslash and slash separators, drive-letter case, and the
 * cross-drive case (which yields an absolute path and is therefore outside).
 *
 * Callers pass REALPATHS for both arguments; symlinks are resolution
 * questions, not arithmetic ones. The `pathImpl` parameter exists so the
 * tests can pin the Windows and POSIX rules from any platform.
 * @param {string} root - The containing directory (a realpath)
 * @param {string} candidate - The path to test (a realpath)
 * @param {nodePath.PlatformPath} [pathImpl] - `node:path` implementation
 * @returns {boolean}
 */
export function isWithin(root, candidate, pathImpl = nodePath) {
  const rel = pathImpl.relative(root, candidate);
  return rel === '' || (
    !pathImpl.isAbsolute(rel)
    && rel !== '..'
    && !rel.startsWith(`..${pathImpl.sep}`)
  );
}
