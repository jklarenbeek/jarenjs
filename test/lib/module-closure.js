//@ts-check
/**
 * The modules Node loads for one import. A child process registers an
 * in-thread load hook (`module.registerHooks`) before it imports the
 * specifier, so the hook sees every module the import loads, which a static
 * import in the test file could not arrange. Bundlers shake unused modules
 * out; Node's module loader loads every module a static import names, so the
 * list is what a host pays at startup for that import alone.
 */

import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const ROOT_URL = pathToFileURL(ROOT).href;

const PROBE = `
import { registerHooks } from 'node:module';
const loaded = [];
registerHooks({ load(url, context, nextLoad) { if (url.startsWith('file:')) loaded.push(url); return nextLoad(url, context); } });
await import(process.argv[1]);
console.log(JSON.stringify(loaded));
`;

/**
 * The file: URLs one import loads, in load order.
 * @param {string} specifier
 * @returns {string[]}
 */
export function loadedBy(specifier) {
  const result = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', PROBE, specifier],
    { cwd: ROOT, encoding: 'utf8', timeout: 30000, env: { ...process.env, FORCE_COLOR: '0' } });
  assert.strictEqual(result.status, 0, result.error?.message ?? result.stderr);
  return JSON.parse(result.stdout);
}

/** @param {string[]} urls @returns {string} One repository path per line, for a failure message. */
export const listing = (urls) => urls.map((url) => (url.startsWith(ROOT_URL) ? url.slice(ROOT_URL.length) : url)).join('\n');

/**
 * The repository files among `files` that `urls` loaded (a suffix match on
 * the raw URLs, so it cannot pass vacuously where the root's prefix differs).
 * @param {string[]} urls
 * @param {string[]} files
 * @returns {string[]}
 */
export const loadedAmong = (urls, files) => files.filter((file) => urls.some((url) => url.endsWith(`/${file}`)));
