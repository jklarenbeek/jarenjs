//@ts-check
/**
 * @file Implementation-neutral tar extraction arguments for the
 * packed-consumer gate.
 *
 * The portable subset shared by GNU tar and the bsdtar Windows ships is
 * `-xzf`, `--strip-components=1` and `-C` over RELATIVE paths: an
 * absolute Windows path carries a drive colon that GNU tar reads as
 * `host:file`, and the flag that suppresses that reading
 * (`--force-local`) is GNU-only — bsdtar refuses it before extracting
 * anything. So no brand is detected and no brand-specific flag is
 * passed: both the tarball and the destination already live below the
 * gate's one working directory, and tar runs with that directory as
 * `cwd` and plain forward-slash relative paths as arguments.
 */

/**
 * Turn an absolute path under `workDir` into a relative forward-slash
 * path — no drive colon, no backslashes, nothing outside the tree.
 * Pure over both POSIX and Windows-shaped inputs.
 * @param {string} workDir - the gate's working directory
 * @param {string} absolute - a path constructed below it
 * @returns {string}
 */
export function workRelative(workDir, absolute) {
  const normalize = (/** @type {string} */ path) =>
    String(path).replaceAll('\\', '/').replace(/\/+$/, '');
  const work = normalize(workDir);
  const target = normalize(absolute);
  if (!target.startsWith(`${work}/`)) {
    throw new Error(
      `packed-consumer extraction: '${absolute}' is not under the working directory '${workDir}'`);
  }
  const relative = target.slice(work.length + 1);
  if (relative === '' || /(^|\/)\.\.(\/|$)/.test(relative)) {
    throw new Error(
      `packed-consumer extraction: '${absolute}' does not name a file below '${workDir}'`);
  }
  return relative;
}

/**
 * The argv that extracts `tarball` into `destination`, both below
 * `workDir`; run it with `{ cwd: workDir }`. Every argument is a
 * relative forward-slash path or a flag both tar brands understand.
 * @param {string} workDir
 * @param {string} tarball - the packed tarball's absolute path
 * @param {string} destination - the extraction directory's absolute path
 * @returns {string[]}
 */
export function tarExtractArgs(workDir, tarball, destination) {
  return ['-xzf', workRelative(workDir, tarball),
    '--strip-components=1', '-C', workRelative(workDir, destination)];
}
