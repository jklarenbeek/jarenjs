//@ts-check
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

/**
 * The input files a bundle of `contents` carries bytes of.
 * @param {string} contents
 * @returns {Promise<string[]>}
 */
async function bundled(contents) {
  const result = await build({ stdin: { contents, resolveDir: process.cwd() }, bundle: true, write: false, metafile: true,
    minify: true, platform: 'neutral', format: 'esm', mainFields: ['module', 'main'], logLevel: 'silent' });
  return Object.entries(Object.values(result.metafile.outputs)[0].inputs)
    .filter(([, info]) => info.bytesInOutput > 0).map(([file]) => file);
}

it('a JSONPath-only bundle carries the descent refusal but not the query catalog', async () => {
  const files = await bundled("export { compileJSONPath } from '@jarenjs/json/path';");
  assert.ok(files.some((file) => /packages\/json\/src\/query\/descent-message\.js$/.test(file)), 'the descent refusal was bundled');
  assert.deepEqual(files.filter((file) => /packages\/json\/src\/query\/messages\.js$/.test(file)), []);
});
