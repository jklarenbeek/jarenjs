import { readFileSync } from 'node:fs';

import { build } from 'esbuild';

const result = await build({
  stdin: {
    contents: "import { compileJSONPointer } from '@jarenjs/json'; export const getName = compileJSONPointer('/name');",
    resolveDir: process.cwd(),
    sourcefile: 'tree-shaking-consumer.js',
  },
  bundle: true,
  format: 'esm',
  metafile: true,
  minify: true,
  platform: 'neutral',
  treeShaking: true,
  write: false,
});

const bundleBytes = result.outputFiles[0].contents.length;
const output = Object.values(result.metafile.outputs)[0];
const unwantedBytes = Object.entries(output.inputs)
  .filter(([file, info]) => file.includes('/query/') && info.bytesInOutput > 0);

if (bundleBytes > 2500)
  throw new Error(`JSON Pointer bundle grew to ${bundleBytes} bytes.`);
if (unwantedBytes.length > 0)
  throw new Error(`Unrelated query modules survived tree shaking: ${unwantedBytes.map(([file]) => file).join(', ')}`);

console.log(`Tree-shaking smoke test passed (${bundleBytes} byte JSON Pointer bundle).`);

// The `.` entry of @jarenjs/contract must not pull @jarenjs/emit (a
// dependency reached only from the ./project subpath) into a bundle
// that never imports ./project — sideEffects:false is what a bundler
// needs to drop it, and this is the proof it stays droppable.
const contractResult = await build({
  stdin: {
    contents: "import { compileContract } from '@jarenjs/contract'; export const c = compileContract({ $contract: '0.1', operations: { a: { kind: 'read', output: true, http: { method: 'GET', path: '/a' } } } });",
    resolveDir: process.cwd(),
    sourcefile: 'contract-consumer.js',
  },
  bundle: true,
  format: 'esm',
  metafile: true,
  minify: true,
  platform: 'neutral',
  treeShaking: true,
  write: false,
});

const contractInputs = Object.values(contractResult.metafile.outputs)[0].inputs;
const emitLeak = Object.entries(contractInputs)
  .filter(([file, info]) => (file.includes('packages/emit/') || file.includes('contract/src/project/')) && info.bytesInOutput > 0);
if (emitLeak.length > 0)
  throw new Error(`The contract '.' entry pulled projection modules into the bundle: ${emitLeak.map(([file]) => file).join(', ')}`);

console.log('Tree-shaking smoke test passed (the contract "." entry carries no emit/projection modules).');

// The default calendar language must stay separable from the opt-in
// `Intl` one — that is the whole reason the repository owns the month
// names — and from the eleven packs, which each construct `Intl`
// singletons at module load. `sideEffects:false` is what lets a bundler
// drop them; this is the proof it still can.
const localesResult = await build({
  stdin: {
    contents: "import { compileDateLocale } from '@jarenjs/locales';"
      + " export const names = compileDateLocale().names;",
    resolveDir: process.cwd(),
    sourcefile: 'locales-consumer.js',
  },
  bundle: true,
  format: 'esm',
  metafile: true,
  minify: true,
  platform: 'neutral',
  treeShaking: true,
  write: false,
});

const localeInputs = Object.values(localesResult.metafile.outputs)[0].inputs;
const intlLeak = Object.entries(localeInputs)
  .filter(([file, info]) => file.includes('packages/locales/src/intl-dates.js') && info.bytesInOutput > 0);
if (intlLeak.length > 0)
  throw new Error('compileDateLocale pulled the opt-in Intl provider into the bundle.');

const packLeak = Object.entries(localeInputs)
  .filter(([file, info]) => /packages\/locales\/src\/(ar|de|es|fr|ja|ko|nl|pt|ru|tr|zh-tw)\.js$/.test(file)
    && info.bytesInOutput > 0);
if (packLeak.length > 0)
  throw new Error(`compileDateLocale pulled locale packs into the bundle: ${packLeak.map(([file]) => file).join(', ')}`);

console.log('Tree-shaking smoke test passed (compileDateLocale carries no Intl provider and no locale pack).');

// The schema pen (`@jarenjs/linq/schema`) is a subpath a consumer may take
// WITHOUT the chain: a schema-only bundle must carry none of the chain's
// modules and no engine (the pen imports no `@jarenjs/json`, `validate`,
// `emit` or `db`). Two things ride along by construction and are part of
// the measured ceiling: the recording proxy in `expression.js`, which
// `check()` captures `$query` through (a class method cannot be shaken),
// and every factory function, built as one closure per class set so the
// model pen constructs its subclasses through the same wiring. Conversely a chain-only bundle carries nothing from the
// pen's directory: the chain recognises a builder by a registry symbol, not
// by an import.
const schemaResult = await build({
  stdin: {
    contents: "import * as s from '@jarenjs/linq/schema'; export const U = s.object({ id: s.string() }).schema;",
    resolveDir: process.cwd(),
    sourcefile: 'schema-pen-consumer.js',
  },
  bundle: true,
  format: 'esm',
  metafile: true,
  minify: true,
  platform: 'neutral',
  treeShaking: true,
  write: false,
});

const schemaBytes = schemaResult.outputFiles[0].contents.length;
const schemaInputs = Object.values(schemaResult.metafile.outputs)[0].inputs;
const chainLeak = Object.entries(schemaInputs)
  .filter(([file, info]) => /packages\/linq\/src\/(sequence|document|async|concurrency|provider|sources|schema-of)\.js$/.test(file)
    && info.bytesInOutput > 0);
if (chainLeak.length > 0)
  throw new Error(`The schema pen pulled chain modules into the bundle: ${chainLeak.map(([file]) => file).join(', ')}`);
const engineLeak = Object.entries(schemaInputs)
  .filter(([file, info]) => /packages\/(json|validate|emit|db|formats|refs)\//.test(file) && info.bytesInOutput > 0);
if (engineLeak.length > 0)
  throw new Error(`The schema pen pulled an engine into the bundle: ${engineLeak.map(([file]) => file).join(', ')}`);
if (schemaBytes > 32000)
  throw new Error(`The schema pen bundle grew to ${schemaBytes} bytes.`);

console.log(`Tree-shaking smoke test passed (${schemaBytes} byte schema-pen bundle; no chain module, no engine).`);

const chainResult = await build({
  stdin: {
    contents: "import { from } from '@jarenjs/linq'; export const rows = from([1]).toArray();",
    resolveDir: process.cwd(),
    sourcefile: 'chain-consumer.js',
  },
  bundle: true,
  format: 'esm',
  metafile: true,
  minify: true,
  platform: 'neutral',
  treeShaking: true,
  write: false,
});

const chainBytes = chainResult.outputFiles[0].contents.length;
const chainInputs = Object.values(chainResult.metafile.outputs)[0].inputs;
const penLeak = Object.entries(chainInputs)
  .filter(([file, info]) => file.includes('packages/linq/src/schema/') && info.bytesInOutput > 0);
if (penLeak.length > 0)
  throw new Error(`The chain pulled the schema pen into the bundle: ${penLeak.map(([file]) => file).join(', ')}`);
// The package's one runtime edge is the client subpath's (`./db` imports
// the store, the validator and the formats as optional peers): the `.`
// entry carries no client module and not one byte of the three, so a
// consumer of the chain alone installs nothing new.
const chainClientLeak = Object.entries(chainInputs)
  .filter(([file, info]) => file.includes('packages/linq/src/db/') && info.bytesInOutput > 0);
if (chainClientLeak.length > 0)
  throw new Error(`The chain pulled the client into the bundle: ${chainClientLeak.map(([file]) => file).join(', ')}`);
const chainEdgeLeak = Object.entries(chainInputs)
  .filter(([file, info]) => /packages\/(db|validate|formats|emit|refs)\//.test(file) && info.bytesInOutput > 0);
if (chainEdgeLeak.length > 0)
  throw new Error(`The chain pulled an optional peer into the bundle: ${chainEdgeLeak.map(([file]) => file).join(', ')}`);
if (chainBytes > 180000)
  throw new Error(`The chain bundle grew to ${chainBytes} bytes.`);

console.log(`Tree-shaking smoke test passed (${chainBytes} byte chain bundle; no schema-pen module, no client module, no store/validator/formats bytes).`);

// The model pen (`@jarenjs/linq/model`) subclasses the schema pen: a
// model-only bundle carries the schema pen's classes and no chain module,
// no store, no engine; and the schema pen never carries the model pen —
// the subclasses are built by the model subpath, not patched onto the
// base classes.
const modelResult = await build({
  stdin: {
    contents: "import * as m from '@jarenjs/linq/model'; export const M = m.defineModel({ entities: { User: m.object({ id: m.string().key().uuid() }) } });",
    resolveDir: process.cwd(),
    sourcefile: 'model-pen-consumer.js',
  },
  bundle: true,
  format: 'esm',
  metafile: true,
  minify: true,
  platform: 'neutral',
  treeShaking: true,
  write: false,
});

const modelBytes = modelResult.outputFiles[0].contents.length;
const modelInputs = Object.values(modelResult.metafile.outputs)[0].inputs;
const modelChainLeak = Object.entries(modelInputs)
  .filter(([file, info]) => /packages\/linq\/src\/(sequence|document|async|concurrency|provider|sources|schema-of)\.js$/.test(file)
    && info.bytesInOutput > 0);
if (modelChainLeak.length > 0)
  throw new Error(`The model pen pulled chain modules into the bundle: ${modelChainLeak.map(([file]) => file).join(', ')}`);
const modelEngineLeak = Object.entries(modelInputs)
  .filter(([file, info]) => /packages\/(json|validate|emit|db|formats|refs)\//.test(file) && info.bytesInOutput > 0);
if (modelEngineLeak.length > 0)
  throw new Error(`The model pen pulled an engine or the store into the bundle: ${modelEngineLeak.map(([file]) => file).join(', ')}`);
if (modelBytes > 40000)
  throw new Error(`The model pen bundle grew to ${modelBytes} bytes.`);
const schemaModelLeak = Object.entries(schemaInputs)
  .filter(([file, info]) => file.includes('packages/linq/src/model/') && info.bytesInOutput > 0);
if (schemaModelLeak.length > 0)
  throw new Error(`The schema pen pulled the model pen into the bundle: ${schemaModelLeak.map(([file]) => file).join(', ')}`);

console.log(`Tree-shaking smoke test passed (${modelBytes} byte model-pen bundle; no chain module, no store; the schema pen carries no model module).`);

// The JSLT pen (`@jarenjs/linq/jslt`) writes stylesheets whose bodies are
// captures, so it carries `expression.js` (and the shared root capture) by
// construction — and nothing else of the chain: no sequence/document/
// provider module, no engine, and no schema module beyond `brand.js` (a
// `schema` match may be a builder; the brand is how the pen tells). The
// chain and the schema pen carry nothing from `jslt/` in return. The
// capture module is the one shared machine (a pen never re-implements it),
// so what it carries for the chain — the relation-hop lowering a member
// access dispatches to — rides into every pen bundle and is part of each
// measured ceiling.
const jsltResult = await build({
  stdin: {
    contents: "import { rule, stylesheet } from '@jarenjs/linq/jslt'; export const S = stylesheet([rule('$..price', (v) => v.mul(1.21))]);",
    resolveDir: process.cwd(),
    sourcefile: 'jslt-pen-consumer.js',
  },
  bundle: true,
  format: 'esm',
  metafile: true,
  minify: true,
  platform: 'neutral',
  treeShaking: true,
  write: false,
});

const jsltBytes = jsltResult.outputFiles[0].contents.length;
const jsltInputs = Object.values(jsltResult.metafile.outputs)[0].inputs;
const jsltChainLeak = Object.entries(jsltInputs)
  .filter(([file, info]) => /packages\/linq\/src\/(sequence|document|async|concurrency|provider|sources|schema-of)\.js$/.test(file)
    && info.bytesInOutput > 0);
if (jsltChainLeak.length > 0)
  throw new Error(`The JSLT pen pulled chain modules into the bundle: ${jsltChainLeak.map(([file]) => file).join(', ')}`);
const jsltSchemaLeak = Object.entries(jsltInputs)
  .filter(([file, info]) => /packages\/linq\/src\/schema\/(?!brand\.js)/.test(file) && info.bytesInOutput > 0);
if (jsltSchemaLeak.length > 0)
  throw new Error(`The JSLT pen pulled schema-pen modules into the bundle: ${jsltSchemaLeak.map(([file]) => file).join(', ')}`);
const jsltEngineLeak = Object.entries(jsltInputs)
  .filter(([file, info]) => /packages\/(json|validate|emit|db|formats|refs)\//.test(file) && info.bytesInOutput > 0);
if (jsltEngineLeak.length > 0)
  throw new Error(`The JSLT pen pulled an engine into the bundle: ${jsltEngineLeak.map(([file]) => file).join(', ')}`);
if (jsltBytes > 20000)
  throw new Error(`The JSLT pen bundle grew to ${jsltBytes} bytes.`);
const chainJsltLeak = Object.entries(chainInputs)
  .filter(([file, info]) => file.includes('packages/linq/src/jslt/') && info.bytesInOutput > 0);
if (chainJsltLeak.length > 0)
  throw new Error(`The chain pulled the JSLT pen into the bundle: ${chainJsltLeak.map(([file]) => file).join(', ')}`);
const schemaJsltLeak = Object.entries(schemaInputs)
  .filter(([file, info]) => file.includes('packages/linq/src/jslt/') && info.bytesInOutput > 0);
if (schemaJsltLeak.length > 0)
  throw new Error(`The schema pen pulled the JSLT pen into the bundle: ${schemaJsltLeak.map(([file]) => file).join(', ')}`);

console.log(`Tree-shaking smoke test passed (${jsltBytes} byte JSLT-pen bundle; no chain module, no schema module beyond brand.js, no engine; the chain and the schema pen carry no jslt module).`);

// The migration pen (`@jarenjs/linq/migration`) writes migration documents
// whose transforms are bodies (the JSLT pen's capture) and whose identity
// is the store's shape hash — so it carries `expression.js`, the body
// module, `@jarenjs/json`'s canonicalizer and `@jarenjs/core`'s hash by
// construction, and nothing else: no chain module, no query engine, no
// validator, no store, no schema or model module. The chain and the
// schema pen carry nothing from `migration/` in return.
const migrationResult = await build({
  stdin: {
    contents: "import { defineMigration } from '@jarenjs/linq/migration'; export const M = defineMigration({ id: 'm', from: { $model: '0.1', entities: {} }, to: { $model: '0.1', entities: {} } }).ddl('SELECT 1').document;",
    resolveDir: process.cwd(),
    sourcefile: 'migration-pen-consumer.js',
  },
  bundle: true,
  format: 'esm',
  metafile: true,
  minify: true,
  platform: 'neutral',
  treeShaking: true,
  write: false,
});

const migrationBytes = migrationResult.outputFiles[0].contents.length;
const migrationInputs = Object.values(migrationResult.metafile.outputs)[0].inputs;
const migrationChainLeak = Object.entries(migrationInputs)
  .filter(([file, info]) => /packages\/linq\/src\/(sequence|document|async|concurrency|provider|sources|schema-of)\.js$/.test(file)
    && info.bytesInOutput > 0);
if (migrationChainLeak.length > 0)
  throw new Error(`The migration pen pulled chain modules into the bundle: ${migrationChainLeak.map(([file]) => file).join(', ')}`);
const migrationPenLeak = Object.entries(migrationInputs)
  .filter(([file, info]) => /packages\/linq\/src\/(schema|model)\//.test(file) && info.bytesInOutput > 0);
if (migrationPenLeak.length > 0)
  throw new Error(`The migration pen pulled the schema or model pen into the bundle: ${migrationPenLeak.map(([file]) => file).join(', ')}`);
const migrationEngineLeak = Object.entries(migrationInputs)
  .filter(([file, info]) => (/packages\/(validate|emit|db|formats|refs)\//.test(file)
    || (file.includes('packages/json/') && !/packages\/json\/src\/(canonical|pointer)\.js$/.test(file)))
    && info.bytesInOutput > 0);
if (migrationEngineLeak.length > 0)
  throw new Error(`The migration pen pulled an engine or the store into the bundle: ${migrationEngineLeak.map(([file]) => file).join(', ')}`);
if (migrationBytes > 24000)
  throw new Error(`The migration pen bundle grew to ${migrationBytes} bytes.`);
const chainMigrationLeak = Object.entries(chainInputs)
  .filter(([file, info]) => file.includes('packages/linq/src/migration/') && info.bytesInOutput > 0);
if (chainMigrationLeak.length > 0)
  throw new Error(`The chain pulled the migration pen into the bundle: ${chainMigrationLeak.map(([file]) => file).join(', ')}`);
const schemaMigrationLeak = Object.entries(schemaInputs)
  .filter(([file, info]) => file.includes('packages/linq/src/migration/') && info.bytesInOutput > 0);
if (schemaMigrationLeak.length > 0)
  throw new Error(`The schema pen pulled the migration pen into the bundle: ${schemaMigrationLeak.map(([file]) => file).join(', ')}`);

console.log(`Tree-shaking smoke test passed (${migrationBytes} byte migration-pen bundle; no chain module, no schema/model module, no engine beyond the canonicalizer and its pointer encoder; the chain and the schema pen carry no migration module).`);

// The client (`@jarenjs/linq/db`) is the package's one runtime edge: it
// carries the store, the validator and the formats — its optional peers —
// beside the chain, by construction, and that price is published (the
// figure below is what docs/CONSUMING.md states, held equal here so the
// number can go stale only by failing this gate). It carries no other
// pen: not the contract, flow, app or forms pens, nor emit or refs.
const clientResult = await build({
  stdin: {
    contents: "import { open } from '@jarenjs/linq/db'; export const opening = open({ $model: '0.1', entities: {} }, { driver: { open: () => null } });",
    resolveDir: process.cwd(),
    sourcefile: 'client-consumer.js',
  },
  bundle: true,
  format: 'esm',
  metafile: true,
  minify: true,
  platform: 'neutral',
  treeShaking: true,
  write: false,
});

const clientBytes = clientResult.outputFiles[0].contents.length;
const clientInputs = Object.values(clientResult.metafile.outputs)[0].inputs;
const clientPenLeak = Object.entries(clientInputs)
  .filter(([file, info]) => /packages\/linq\/src\/(contract|flow|app|forms)\//.test(file) && info.bytesInOutput > 0);
if (clientPenLeak.length > 0)
  throw new Error(`The client pulled another pen into the bundle: ${clientPenLeak.map(([file]) => file).join(', ')}`);
const clientEngineLeak = Object.entries(clientInputs)
  .filter(([file, info]) => /packages\/(contract|flow|app|forms|emit|refs)\//.test(file) && info.bytesInOutput > 0);
if (clientEngineLeak.length > 0)
  throw new Error(`The client pulled an unrelated package into the bundle: ${clientEngineLeak.map(([file]) => file).join(', ')}`);
const clientEdge = ['db', 'validate', 'formats'].filter((name) => Object.entries(clientInputs)
  .some(([file, info]) => file.includes(`packages/${name}/`) && info.bytesInOutput > 0));
if (clientEdge.length !== 3)
  throw new Error(`The client bundle is missing one of its peers: carried ${clientEdge.join(', ') || 'none'}`);
if (clientBytes > 520000)
  throw new Error(`The client bundle grew to ${clientBytes} bytes.`);
const consuming = readFileSync('docs/CONSUMING.md', 'utf8');
const stated = /<!--bundle:linq-db-->(\d+) kB/.exec(consuming);
const measuredKb = Math.round(clientBytes / 1000);
if (stated === null || Number(stated[1]) !== measuredKb) {
  throw new Error(`docs/CONSUMING.md states the client bundle as ${stated === null ? 'nothing' : `${stated[1]} kB`}; `
    + `measured ${measuredKb} kB (${clientBytes} bytes) — refresh the figure beside the <!--bundle:linq-db--> marker.`);
}

console.log(`Tree-shaking smoke test passed (${clientBytes} byte client bundle — the store, the validator and the formats ride as declared; no other pen, no emit/refs; CONSUMING states ${measuredKb} kB).`);
