//@ts-check
/**
 * @file `@jarenjs/validate/references`: the validator's reading of a schema
 * document's references, served without the validator. The normalizer's
 * subpath serves the same functions (one implementation, two entries), and
 * importing this one loads neither the validator, the normalizer nor
 * `@jarenjs/json`'s index and query compiler.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as references from '@jarenjs/validate/references';
import * as normalize from '@jarenjs/validate/normalize';
import { JarenValidator } from '@jarenjs/validate';

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

const NAMES = ['collectSameDocumentAnchors', 'createSchemaPatternTester', 'detectSchemaDraft', 'indexSchemaResources',
  'readsRefAlone', 'referenceText', 'resolveSameDocumentRef', 'resolveSchemaReference', 'schemaPlace'];

describe('@jarenjs/validate/references', () => {
  it('serves exactly the reference readings, the very functions the normalizer subpath serves', () => {
    assert.deepStrictEqual(Object.keys(references).sort(), NAMES);
    for (const name of NAMES) assert.strictEqual(references[name], normalize[name], name);
  });

  it('resolves a same-document reference and a plain name as the validator does', () => {
    const root = { $defs: { a: { $anchor: 'top', type: 'string' }, 'b/c': { type: 'integer' } } };
    const anchors = references.collectSameDocumentAnchors(root);
    assert.deepStrictEqual([...anchors.keys()], ['top']);
    assert.strictEqual(references.resolveSameDocumentRef('#top', root, anchors), root.$defs.a);
    assert.strictEqual(references.resolveSameDocumentRef('#/$defs/b~1c', root, anchors), root.$defs['b/c']);
    assert.strictEqual(references.resolveSameDocumentRef('#/%24defs/a', root, anchors), root.$defs.a);
    assert.strictEqual(references.resolveSameDocumentRef('other.json#/a', root, anchors), undefined);
  });

  it('reads a validator given as dialects, and names its own function when the value is none', () => {
    const index = references.indexSchemaResources({ $schema: 'https://example.test/dialect' }, { dialects: new JarenValidator() });
    assert.strictEqual(typeof index.held?.get, 'function');
    assert.throws(() => references.indexSchemaResources({}, { dialects: {} }),
      { name: 'TypeError', message: "indexSchemaResources: 'dialects' must be a JarenValidator, whose held meta-schemas name the dialects" });
  });

  // The ceiling holds references and the keyword, pattern, origin,
  // dynamic-ref and validator-state modules it imports, JSON Pointer from
  // `@jarenjs/json` with its error modules, and the core modules those
  // import, with a few modules to spare.
  const CEILING = 28;

  it('loads neither the validator, the normalizer nor the query compiler', () => {
    const loaded = loadedBy('@jarenjs/validate/references');
    assert.ok(loaded.length <= CEILING, `${loaded.length} modules (ceiling ${CEILING}):\n${listing(loaded)}`);
    const heavy = ['packages/validate/src/index.js', 'packages/validate/src/normalize.js', 'packages/validate/src/traverse.js',
      'packages/json/src/index.js', 'packages/json/src/query/compile.js'];
    assert.deepStrictEqual(heavy.filter((file) => loaded.some((url) => url.endsWith(`/${file}`))), []);
  });
});
