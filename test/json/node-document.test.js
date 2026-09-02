//@ts-check
/**
 * @file `@jarenjs/json/node` — the shared document loader: every
 * extension of the set (and the `.d.ts` exclusion), `default` over the
 * named export, a pen-shaped `toJSON()` emission, the refusals (no
 * document, not JSON, not an object, unreadable, unknown extension,
 * missing module, the `.ts` strip-types hint), and purity as two FRESH
 * evaluations — proven on ESM and CommonJS alike by a module that
 * counts its own evaluations in process-visible state. The boundary
 * tests hold the package layout: only this subpath imports a Node
 * builtin, and the two CLIs that share it keep their own edges.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadDocument, isDocumentFile, DOCUMENT_EXTENSIONS } from '@jarenjs/json/node';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
/** @type {string} */
let dir = '';
const at = (/** @type {string} */ name) => path.join(dir, name);
const write = (/** @type {string} */ name, /** @type {string} */ text) => {
  fs.writeFileSync(at(name), text);
  return at(name);
};

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jaren-json-node-'));
});
after(() => {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('loadDocument — files and exports', () => {
  it('parses a .json file; an unreadable one is refused naming the purpose and the file', async () => {
    const json = write('doc.json', '{"a":1}');
    assert.deepStrictEqual(await loadDocument(json), { a: 1 });
    assert.deepStrictEqual(await loadDocument(write('bom.json', '\uFEFF{"a":2}')), { a: 2 }, 'a byte-order mark is stripped');
    await assert.rejects(loadDocument(at('missing.json'), { what: 'contract' }), /^Error: cannot read contract '.*missing\.json': /);
    await assert.rejects(loadDocument(write('bad.json', '{nope'), { what: '--from' }), /cannot read --from '.*bad\.json'/);
  });

  it('accepts exactly the module extensions; a .d.ts and an unknown extension are refused by name', async () => {
    assert.deepStrictEqual([...DOCUMENT_EXTENSIONS], ['.json', '.js', '.mjs', '.cjs', '.ts', '.mts', '.cts']);
    for (const ext of ['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.json']) assert.strictEqual(isDocumentFile(`x${ext}`), true, ext);
    for (const name of ['x.d.ts', 'x.d.mts', 'x.d.cts', 'x.txt', 'x.jsonc', 'x']) assert.strictEqual(isDocumentFile(name), false, name);
    await assert.rejects(loadDocument(write('doc.txt', '{}'), { what: 'model' }), /cannot read model '.*doc\.txt': neither a \.json file nor a module/);
    await assert.rejects(loadDocument(write('doc.d.ts', 'export declare const x: 1;')), /neither a \.json file nor a module/);
  });

  it('a default export wins; without one the named export is read; neither is a refusal', async () => {
    const both = write('both.mjs', "export default { by: 'default' }; export const contract = { by: 'named' };");
    assert.deepStrictEqual(await loadDocument(both, { exportName: 'contract' }), { by: 'default' });
    const named = write('named.mjs', "export const contract = { by: 'named' };");
    assert.deepStrictEqual(await loadDocument(named, { exportName: 'contract' }), { by: 'named' });
    const none = write('none.mjs', 'export const other = { by: 42 };');
    await assert.rejects(loadDocument(none, { exportName: 'contract' }), /module '.*none\.mjs' exports neither a default nor a 'contract' document/);
    const scalar = write('scalar.mjs', 'export default 42;');
    await assert.rejects(loadDocument(scalar, { exportName: 'contract' }), /exports neither a default nor a 'contract' document/);
  });

  it('a pen-shaped export emits through toJSON(); an array, a cycle and a non-JSON value are refused', async () => {
    const pen = write('pen.mjs', "export default { toJSON() { return { $contract: '0.1', operations: {} }; } };");
    assert.deepStrictEqual(await loadDocument(pen, { exportName: 'contract' }), { $contract: '0.1', operations: {} });
    await assert.rejects(loadDocument(write('array.mjs', 'export default [1, 2];')), /the document emission is not a document/);
    await assert.rejects(loadDocument(write('cycle.mjs', 'const a = {}; a.self = a; export default a;'), { exportName: 'model' }),
      /module '.*cycle\.mjs': the model emission is not JSON \(/);
    await assert.rejects(loadDocument(write('bigint.mjs', 'export default { n: 1n };')), /the document emission is not JSON/);
  });

  it('a module that does not load is refused naming the purpose; a .ts carries the strip-types hint only where types are not stripped', async () => {
    await assert.rejects(loadDocument(at('missing.mjs'), { what: 'migration' }), /cannot load migration module '.*missing\.mjs': /);
    await assert.rejects(loadDocument(write('broken.mjs', 'export default {'), { what: 'model' }), /cannot load model module '.*broken\.mjs': /);
    const ts = write('doc.ts', 'const doc: { a: number } = { a: 1 };\nexport default doc;\n');
    assert.deepStrictEqual(await loadDocument(ts), { a: 1 }, 'Node strips types by default');
    const script = write('probe.mjs', [
      `import { loadDocument } from '${pathToFileURL(path.join(ROOT, 'packages/json/src/node.js')).href}';`,
      `loadDocument(${JSON.stringify(ts)}, { what: 'model' }).then(() => process.stdout.write('loaded'), (e) => process.stdout.write(e.message));`,
      '',
    ].join('\n'));
    const refused = spawnSync(process.execPath, ['--no-warnings=ExperimentalWarning', '--no-strip-types', script], { encoding: 'utf8' });
    assert.match(refused.stdout, /cannot load model module '.*doc\.ts': .* — a \.ts module loads only where Node strips types/);
  });
});

describe('loadDocument — purity as two fresh evaluations', () => {
  it('an ESM module is evaluated twice — the count is process-visible state, not a cache alias', async () => {
    const counted = write('counted.mjs', [
      "globalThis.__jarenEsmLoads = (globalThis.__jarenEsmLoads ?? 0) + 1;",
      "export default { kind: 'esm' };",
      '',
    ].join('\n'));
    assert.deepStrictEqual(await loadDocument(counted), { kind: 'esm' });
    assert.strictEqual(/** @type {any} */ (globalThis).__jarenEsmLoads, 2);
    await loadDocument(counted);
    assert.strictEqual(/** @type {any} */ (globalThis).__jarenEsmLoads, 4, 'every load is two evaluations');
  });

  it('a CommonJS module is evaluated twice too — its require cache entry is dropped before each load', async () => {
    const counted = write('counted.cjs', [
      "globalThis.__jarenCjsLoads = (globalThis.__jarenCjsLoads ?? 0) + 1;",
      "module.exports = { kind: 'cjs' };",
      '',
    ].join('\n'));
    assert.deepStrictEqual(await loadDocument(counted), { kind: 'cjs' });
    assert.strictEqual(/** @type {any} */ (globalThis).__jarenCjsLoads, 2);
    const namedCjs = write('named.cjs', "exports.contract = { by: 'cjs-named' };");
    assert.deepStrictEqual(await loadDocument(namedCjs, { exportName: 'contract' }), { by: 'cjs-named' });
  });

  it('an emission that differs between the evaluations is refused, naming the module and the purpose, with the advice', async () => {
    const impure = write('impure.mjs', "export default { at: Date.now() + Math.random() };");
    await assert.rejects(loadDocument(impure, { what: 'contract' }),
      /^Error: the contract module '.*impure\.mjs' is not pure — two loads emitted different documents; no clock, no env, no randomness in a contract module$/);
    const counted = write('impure-counted.mjs', "globalThis.__jarenImpure = (globalThis.__jarenImpure ?? 0) + 1; export default { n: globalThis.__jarenImpure };");
    await assert.rejects(loadDocument(counted, { what: 'model', impure: 'no clock, no env, no randomness in a model or migration module' }),
      /the model module '.*impure-counted\.mjs' is not pure — two loads emitted different documents; no clock, no env, no randomness in a model or migration module/);
  });
});

describe('the package layout the loader keeps', () => {
  /** Every import specifier of a source file. @param {string} file */
  const importsOf = (file) => [...fs.readFileSync(file, 'utf8').matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
  /** Every .js file under a directory, recursively. @param {string} root */
  const sources = (root) => fs.readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.js')).map((name) => path.join(root, name));

  it('only the ./node subpath of @jarenjs/json imports a Node builtin; the root and every other subpath stay platform-neutral', () => {
    const src = path.join(ROOT, 'packages/json/src');
    const offenders = sources(src).filter((file) => path.relative(src, file) !== 'node.js' && importsOf(file).some((s) => s.startsWith('node:')));
    assert.deepStrictEqual(offenders, []);
    assert.ok(importsOf(path.join(src, 'node.js')).every((s) => s.startsWith('node:') || s === './canonical.js'));
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'packages/json/package.json'), 'utf8'));
    assert.deepStrictEqual(pkg.exports['./node'], { types: './dist/types/node.d.ts', default: './src/node.js' });
    assert.ok(!fs.readFileSync(path.join(src, 'index.js'), 'utf8').includes('node.js'), 'the root index never re-exports the Node subpath');
  });

  it('both CLIs take the loader from the subpath, keep no loader of their own, and keep their edges: contract imports neither linq nor db, db imports no contract', () => {
    const db = fs.readFileSync(path.join(ROOT, 'packages/db/src/cli.js'), 'utf8');
    const contract = fs.readFileSync(path.join(ROOT, 'packages/contract/src/cli.js'), 'utf8');
    for (const [name, text] of [['db', db], ['contract', contract]]) {
      assert.ok(text.includes("from '@jarenjs/json/node'"), `${name} CLI imports the shared loader`);
      assert.ok(!/jaren-db-load=|jaren-contract-load=|\bemissionOf\b|MODULE_EXT/.test(text), `${name} CLI keeps no private loader`);
    }
    const contractSources = sources(path.join(ROOT, 'packages/contract/src')).flatMap(importsOf);
    assert.deepStrictEqual(contractSources.filter((s) => /^@jarenjs\/(linq|db)(\/|$)/.test(s)), []);
    const dbSources = sources(path.join(ROOT, 'packages/db/src')).flatMap(importsOf);
    assert.deepStrictEqual(dbSources.filter((s) => /^@jarenjs\/contract(\/|$)/.test(s)), []);
  });
});
