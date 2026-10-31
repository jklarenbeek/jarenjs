//@ts-check
/**
 * @file The modules Node loads for `@jarenjs/contract/http`. Serving a
 * contract reads its schemas' same-document references (the public
 * projection keeps the reachable `$defs`), and those readings come from
 * `@jarenjs/validate/references`, which imports neither the validator nor
 * `@jarenjs/json`'s index and query compiler. Bundlers shake unused code
 * out; Node's module loader loads every module a static import names, so
 * the count is what a host pays at startup for this subpath alone.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const ROOT_URL = pathToFileURL(ROOT).href;

// Counts the file: modules one dynamic import loads: the hook registers
// before the import runs, which a static import in this file could not do.
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
function loadedBy(specifier) {
  const result = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', PROBE, specifier],
    { cwd: ROOT, encoding: 'utf8', timeout: 30000, env: { ...process.env, FORCE_COLOR: '0' } });
  assert.strictEqual(result.status, 0, result.error?.message ?? result.stderr);
  return JSON.parse(result.stdout);
}

/** @param {string[]} urls @returns {string} One repository path per line, for a failure message. */
const listing = (urls) => urls.map((url) => (url.startsWith(ROOT_URL) ? url.slice(ROOT_URL.length) : url)).join('\n');

// The ceiling holds contract's transport (serve, dispatch, body and wire,
// the SSE stream server, describe, revision, public and bundle, and the
// runtime, pipeline, host, options, message, error and timer modules they
// share), validate's reference reading (references, with the keyword,
// pattern, origin, dynamic-ref and validator-state modules it imports),
// JSON Pointer and canonical JSON from `@jarenjs/json` with their error
// modules, and the core modules all of those import, with a few modules
// to spare. The normalizer instead of the reference reading would load
// the validator and, through `@jarenjs/json`'s index, the query compiler
// with core's geo, series, dates and math: more than twice the count.
const CEILING = 50;

describe('the modules @jarenjs/contract/http loads', () => {
  const loaded = loadedBy('@jarenjs/contract/http');

  it('stays under its ceiling', () => {
    assert.ok(loaded.length <= CEILING, `${loaded.length} modules (ceiling ${CEILING}):\n${listing(loaded)}`);
  });

  it('loads neither the validator, the normalizer nor the query compiler', () => {
    const heavy = ['packages/validate/src/index.js', 'packages/validate/src/normalize.js',
      'packages/json/src/index.js', 'packages/json/src/query/compile.js'];
    assert.deepStrictEqual(heavy.filter((file) => loaded.some((url) => url.endsWith(`/${file}`))), []);
  });
});
