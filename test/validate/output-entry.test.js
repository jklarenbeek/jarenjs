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

it('a validator given no output format ships none of @jarenjs/validate/output', async () => {
  const plain = await bundled("import { JarenValidator } from '@jarenjs/validate';\n"
    + "export const v = new JarenValidator({ collectErrors: true }).compile({ type: 'string' });");
  assert.ok(plain.some((file) => /packages\/validate\/src\/index\.js$/.test(file)), 'the validator was bundled');
  assert.deepEqual(plain.filter((file) => /packages\/validate\/src\/output\.js$/.test(file)), []);
  const formatted = await bundled("import { JarenValidator } from '@jarenjs/validate';\n"
    + "import { listOutput } from '@jarenjs/validate/output';\n"
    + "export const v = new JarenValidator({ outputFormat: listOutput }).compile({ type: 'string' });");
  assert.equal(formatted.filter((file) => /packages\/validate\/src\/output\.js$/.test(file)).length, 1);
});
