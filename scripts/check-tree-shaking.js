import { readFileSync, writeFileSync } from 'node:fs';

import { build } from 'esbuild';
import { AUTHORED_PEN_PROBES } from './lib/authored-pen-probes.js';

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
  .filter(([file, info]) => /packages\/locales\/src\/intl-(dates|zones)\.js$/.test(file) && info.bytesInOutput > 0);
if (intlLeak.length > 0)
  throw new Error(`compileDateLocale pulled an opt-in Intl provider into the bundle: ${intlLeak.map(([file]) => file).join(', ')}`);

const packLeak = Object.entries(localeInputs)
  .filter(([file, info]) => /packages\/locales\/src\/(ar|de|es|fr|ja|ko|nl|pt|ru|tr|zh-tw)\.js$/.test(file)
    && info.bytesInOutput > 0);
if (packLeak.length > 0)
  throw new Error(`compileDateLocale pulled locale packs into the bundle: ${packLeak.map(([file]) => file).join(', ')}`);

console.log('Tree-shaking smoke test passed (compileDateLocale carries neither Intl provider and no locale pack).');

// Every `@jarenjs/linq` subpath's measured size, collected as the probes
// run and checked against docs/CONSUMING.md's table at the end: a price
// this repository publishes is a price this gate measured, so it can go
// stale only by failing here (D11 — report the loss).
/** @type {Map<string, number>} */
const linqBundles = new Map();

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
linqBundles.set('schema', schemaBytes);
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
// The budget includes the shared JSON boundary's name-map validation and
// the pen's many-to-many relation lowering through the join root. Their
// diagnostics belong in this bundle: keep useful refusals within the
// budget rather than shortening messages to hide unrelated growth.
if (schemaBytes > 38000)
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
linqBundles.set('chain', chainBytes);
const chainInputs = Object.values(chainResult.metafile.outputs)[0].inputs;
// What of the chain bundle is the CHAIN, and what is the engine under
// it. QUERY-PEN.md §17 publishes both, because "173 kB" alone reads as
// the price of the fluent surface when it is mostly the price of running
// a query at all.
const chainOwnBytes = Object.entries(chainInputs)
  .filter(([file]) => file.includes('packages/linq/src/'))
  .reduce((total, [, info]) => total + info.bytesInOutput, 0);
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

// The chain and a pen SHARE the expression capture and the coded errors,
// and a bundler counts a shared module once — so the two figures do not
// add up, and QUERY-PEN.md §17 says by how much. Measured rather than
// asserted: the saving moves whenever `expression.js` does.
const chainPairResult = await build({
  stdin: {
    contents: "import { from } from '@jarenjs/linq'; import * as s from '@jarenjs/linq/schema'; "
      + "export const both = [from([1]).toArray(), s.object({ id: s.string() }).schema];",
    resolveDir: process.cwd(),
    sourcefile: 'chain-and-schema-consumer.js',
  },
  bundle: true,
  format: 'esm',
  metafile: true,
  minify: true,
  platform: 'neutral',
  treeShaking: true,
  write: false,
});
const chainPairBytes = chainPairResult.outputFiles[0].contents.length;
const chainSharedBytes = chainBytes + schemaBytes - chainPairBytes;
if (chainSharedBytes <= 0)
  throw new Error(`The chain and the schema pen share nothing (${chainPairBytes} bytes together).`);

console.log(`Tree-shaking smoke test passed (${chainOwnBytes} of the chain bundle's `
  + `${chainBytes} bytes are the chain's own modules; with the schema pen it is `
  + `${chainPairBytes}, sharing ${chainSharedBytes}).`);

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
linqBundles.set('model', modelBytes);
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
// The budget includes member validation (column-bearing kinds, integer
// versions, the closed entity vocabulary, and valid rename hints), with
// diagnostics that explain the accepted spelling at build time. It also
// includes the same many-to-many relation lowering as the schema pen.
if (modelBytes > 46500)
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
linqBundles.set('jslt', jsltBytes);
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
linqBundles.set('migration', migrationBytes);
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
// Raised to 25,000 with the schema and model pens, and for the same
// reason: the capture's hop machinery gained the second link a
// many-to-many relation lowers through, and every pen carries it.
if (migrationBytes > 25000)
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
linqBundles.set('db', clientBytes);
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
// The client carries the store's replication ledger and bounded live
// dependency strategies. The measured fixture is 623,994 bytes; this
// ceiling leaves room for local changes while the import-edge assertions
// above continue to prohibit unrelated packages and transport clients.
if (clientBytes > 635000)
  throw new Error(`The client bundle grew to ${clientBytes} bytes.`);
console.log(`Tree-shaking smoke test passed (${clientBytes} byte client bundle — the store, the validator and the formats ride as declared; no other pen, no emit/refs).`);

// The contract pen (`@jarenjs/linq/contract`) writes `$contract` 0.1
// documents whose schemas are the schema pen's — so the probe measures
// the two together (a contract without a schema builder is not a
// contract), and the ceiling is that measured pair. What it must NOT
// carry: a chain module, a query engine, a validator, another pen, and
// above all any byte of `@jarenjs/contract`, whose compiler is the only
// judge of what the document means. The chain carries no contract
// module in return.
const contractPenResult = await build({
  stdin: {
    contents: "import { defineContract, read, http } from '@jarenjs/linq/contract'; import * as s from '@jarenjs/linq/schema'; export const C = defineContract({ id: 'c' }, { 'a.b': read({ output: s.object({ id: s.string() }), http: http({ method: 'GET', path: '/a' }) }) }).document;",
    resolveDir: process.cwd(),
    sourcefile: 'contract-pen-consumer.js',
  },
  bundle: true,
  format: 'esm',
  metafile: true,
  minify: true,
  platform: 'neutral',
  treeShaking: true,
  write: false,
});

const contractPenBytes = contractPenResult.outputFiles[0].contents.length;
linqBundles.set('contract', contractPenBytes);
const contractPenInputs = Object.values(contractPenResult.metafile.outputs)[0].inputs;
const contractPenChainLeak = Object.entries(contractPenInputs)
  .filter(([file, info]) => /packages\/linq\/src\/(sequence|document|async|concurrency|provider|sources|schema-of)\.js$/.test(file)
    && info.bytesInOutput > 0);
if (contractPenChainLeak.length > 0)
  throw new Error(`The contract pen pulled chain modules into the bundle: ${contractPenChainLeak.map(([file]) => file).join(', ')}`);
const contractPenPackageLeak = Object.entries(contractPenInputs)
  .filter(([file, info]) => /packages\/(contract|validate|emit|db|formats|refs|json)\//.test(file)
    && info.bytesInOutput > 0);
if (contractPenPackageLeak.length > 0)
  throw new Error(`The contract pen pulled a package it must not carry into the bundle: ${contractPenPackageLeak.map(([file]) => file).join(', ')}`);
const contractPenLeak = Object.entries(contractPenInputs)
  .filter(([file, info]) => /packages\/linq\/src\/(model|jslt|migration|flow|app|forms|db)\//.test(file) && info.bytesInOutput > 0);
if (contractPenLeak.length > 0)
  throw new Error(`The contract pen pulled another pen into the bundle: ${contractPenLeak.map(([file]) => file).join(', ')}`);
if (contractPenBytes > 50500)
  throw new Error(`The contract pen bundle grew to ${contractPenBytes} bytes.`);
const chainContractLeak = Object.entries(chainInputs)
  .filter(([file, info]) => file.includes('packages/linq/src/contract/') && info.bytesInOutput > 0);
if (chainContractLeak.length > 0)
  throw new Error(`The chain pulled the contract pen into the bundle: ${chainContractLeak.map(([file]) => file).join(', ')}`);
const schemaContractLeak = Object.entries(schemaInputs)
  .filter(([file, info]) => file.includes('packages/linq/src/contract/') && info.bytesInOutput > 0);
if (schemaContractLeak.length > 0)
  throw new Error(`The schema pen pulled the contract pen into the bundle: ${schemaContractLeak.map(([file]) => file).join(', ')}`);

console.log(`Tree-shaking smoke test passed (${contractPenBytes} byte contract-pen bundle, the schema pen included; no chain module, no @jarenjs/contract bytes, no other pen; the chain and the schema pen carry no contract module).`);

// The flow pen (`@jarenjs/linq/flow`) writes machine and dataflow
// documents whose guards, effect props, node queries and edge selectors
// are captures — so it carries `expression.js` and the shared root
// capture by construction, and nothing else: no chain module, no engine,
// no schema module beyond `brand.js` (a `context`/`payload` builder is a
// TYPE, and the brand is how the pen tells one), and above all no byte
// of `@jarenjs/flow`, whose compiler is the only judge of what the
// document means. The chain carries no flow module in return.
const flowPenResult = await build({
  stdin: {
    contents: "import { defineFsm, on, state, effect } from '@jarenjs/linq/flow'; export const M = defineFsm({ initial: 'a', states: ['a', state('b', { final: true })], transitions: [on('a', 'go').when((s) => s.payload.ok).to('b').effects([effect('toast', () => ({ text: 'hi' }))])] });",
    resolveDir: process.cwd(),
    sourcefile: 'flow-pen-consumer.js',
  },
  bundle: true,
  format: 'esm',
  metafile: true,
  minify: true,
  platform: 'neutral',
  treeShaking: true,
  write: false,
});

const flowPenBytes = flowPenResult.outputFiles[0].contents.length;
linqBundles.set('flow', flowPenBytes);
const flowPenInputs = Object.values(flowPenResult.metafile.outputs)[0].inputs;
const flowPenChainLeak = Object.entries(flowPenInputs)
  .filter(([file, info]) => /packages\/linq\/src\/(sequence|document|async|concurrency|provider|sources|schema-of)\.js$/.test(file)
    && info.bytesInOutput > 0);
if (flowPenChainLeak.length > 0)
  throw new Error(`The flow pen pulled chain modules into the bundle: ${flowPenChainLeak.map(([file]) => file).join(', ')}`);
const flowPenPackageLeak = Object.entries(flowPenInputs)
  .filter(([file, info]) => /packages\/(flow|contract|validate|emit|db|formats|refs|json)\//.test(file)
    && info.bytesInOutput > 0);
if (flowPenPackageLeak.length > 0)
  throw new Error(`The flow pen pulled a package it must not carry into the bundle: ${flowPenPackageLeak.map(([file]) => file).join(', ')}`);
const flowPenSchemaLeak = Object.entries(flowPenInputs)
  .filter(([file, info]) => /packages\/linq\/src\/schema\/(?!brand\.js)/.test(file) && info.bytesInOutput > 0);
if (flowPenSchemaLeak.length > 0)
  throw new Error(`The flow pen pulled schema-pen modules into the bundle: ${flowPenSchemaLeak.map(([file]) => file).join(', ')}`);
const flowPenLeak = Object.entries(flowPenInputs)
  .filter(([file, info]) => /packages\/linq\/src\/(model|jslt|migration|contract|app|forms|db)\//.test(file) && info.bytesInOutput > 0);
if (flowPenLeak.length > 0)
  throw new Error(`The flow pen pulled another pen into the bundle: ${flowPenLeak.map(([file]) => file).join(', ')}`);
if (flowPenBytes > 20000)
  throw new Error(`The flow pen bundle grew to ${flowPenBytes} bytes.`);
const chainFlowLeak = Object.entries(chainInputs)
  .filter(([file, info]) => file.includes('packages/linq/src/flow/') && info.bytesInOutput > 0);
if (chainFlowLeak.length > 0)
  throw new Error(`The chain pulled the flow pen into the bundle: ${chainFlowLeak.map(([file]) => file).join(', ')}`);
const schemaFlowLeak = Object.entries(schemaInputs)
  .filter(([file, info]) => file.includes('packages/linq/src/flow/') && info.bytesInOutput > 0);
if (schemaFlowLeak.length > 0)
  throw new Error(`The schema pen pulled the flow pen into the bundle: ${schemaFlowLeak.map(([file]) => file).join(', ')}`);

console.log(`Tree-shaking smoke test passed (${flowPenBytes} byte flow-pen bundle; no chain module, no @jarenjs/flow bytes, no schema module beyond brand.js, no other pen; the chain and the schema pen carry no flow module).`);

// The app pen (`@jarenjs/linq/app`) writes `jaren-app` 0.1 documents
// whose state is a schema-pen builder, whose view is the JSLT pen's
// stylesheet and whose actions are captures — so the probe measures the
// three pens together (an app without a view and a state is not an app),
// and the ceiling is that measured set. What it must NOT carry: a chain
// module, and above all any byte of `@jarenjs/app`, `@jarenjs/view` or
// `@jarenjs/json` — the loop's compiler is the only judge of what an app
// means. The chain carries no app module in return.
const appPenResult = await build({
  stdin: {
    contents: "import { defineApp, action, transition, append, bind } from '@jarenjs/linq/app'; import { rule } from '@jarenjs/linq/jslt'; import * as s from '@jarenjs/linq/schema'; export const A = defineApp({ state: s.object({ todos: s.array(s.string()).default([]) }), view: [rule('$', (v) => ['ul', { on: { click: bind('todo/add', { payload: { text: v.draft } }) } }])], actions: { 'todo/add': action((st, x) => transition({ patch: [append((c) => c.todos, x.payload)] })) } }).document;",
    resolveDir: process.cwd(),
    sourcefile: 'app-pen-consumer.js',
  },
  bundle: true,
  format: 'esm',
  metafile: true,
  minify: true,
  platform: 'neutral',
  treeShaking: true,
  write: false,
});

const appPenBytes = appPenResult.outputFiles[0].contents.length;
linqBundles.set('app', appPenBytes);
const appPenInputs = Object.values(appPenResult.metafile.outputs)[0].inputs;
const appPenChainLeak = Object.entries(appPenInputs)
  .filter(([file, info]) => /packages\/linq\/src\/(sequence|document|async|concurrency|provider|sources|schema-of)\.js$/.test(file)
    && info.bytesInOutput > 0);
if (appPenChainLeak.length > 0)
  throw new Error(`The app pen pulled chain modules into the bundle: ${appPenChainLeak.map(([file]) => file).join(', ')}`);
const appPenPackageLeak = Object.entries(appPenInputs)
  .filter(([file, info]) => /packages\/(app|view|forms|flow|contract|validate|emit|db|formats|refs|json)\//.test(file)
    && info.bytesInOutput > 0);
if (appPenPackageLeak.length > 0)
  throw new Error(`The app pen pulled a package it must not carry into the bundle: ${appPenPackageLeak.map(([file]) => file).join(', ')}`);
const appPenLeak = Object.entries(appPenInputs)
  .filter(([file, info]) => /packages\/linq\/src\/(model|migration|contract|flow|forms|db)\//.test(file) && info.bytesInOutput > 0);
if (appPenLeak.length > 0)
  throw new Error(`The app pen pulled another pen into the bundle: ${appPenLeak.map(([file]) => file).join(', ')}`);
if (appPenBytes > 53000)
  throw new Error(`The app pen bundle grew to ${appPenBytes} bytes.`);
const chainAppLeak = Object.entries(chainInputs)
  .filter(([file, info]) => file.includes('packages/linq/src/app/') && info.bytesInOutput > 0);
if (chainAppLeak.length > 0)
  throw new Error(`The chain pulled the app pen into the bundle: ${chainAppLeak.map(([file]) => file).join(', ')}`);
const schemaAppLeak = Object.entries(schemaInputs)
  .filter(([file, info]) => file.includes('packages/linq/src/app/') && info.bytesInOutput > 0);
if (schemaAppLeak.length > 0)
  throw new Error(`The schema pen pulled the app pen into the bundle: ${schemaAppLeak.map(([file]) => file).join(', ')}`);

console.log(`Tree-shaking smoke test passed (${appPenBytes} byte app-pen bundle, the schema and JSLT pens included; no chain module, no @jarenjs/app or @jarenjs/view bytes, no other pen; the chain and the schema pen carry no app module).`);

// The forms pen (`@jarenjs/linq/forms`) is the schema pen plus one
// annotation method and the submit twin, so its bundle IS a schema-pen
// bundle by construction — what the probe holds is that it stays one:
// no `@jarenjs/forms` bytes (the model reader is the only judge of what
// a rule means), no model pen (the two subclass the same base and must
// not drag each other in), no chain module beyond the shared capture.
const formsPenResult = await build({
  stdin: {
    contents: "import * as f from '@jarenjs/linq/forms'; import { assertOnSubmit } from '@jarenjs/linq/forms'; export const F = assertOnSubmit(f.object({ vatId: f.string().form({ visible: (c) => c.root.company.ne(''), assert: (c) => c.value.ne(''), message: 'required' }) }));",
    resolveDir: process.cwd(),
    sourcefile: 'forms-pen-consumer.js',
  },
  bundle: true,
  format: 'esm',
  metafile: true,
  minify: true,
  platform: 'neutral',
  treeShaking: true,
  write: false,
});

const formsPenBytes = formsPenResult.outputFiles[0].contents.length;
linqBundles.set('forms', formsPenBytes);
const formsPenInputs = Object.values(formsPenResult.metafile.outputs)[0].inputs;
const formsPenChainLeak = Object.entries(formsPenInputs)
  .filter(([file, info]) => /packages\/linq\/src\/(sequence|document|async|concurrency|provider|sources|schema-of)\.js$/.test(file)
    && info.bytesInOutput > 0);
if (formsPenChainLeak.length > 0)
  throw new Error(`The forms pen pulled chain modules into the bundle: ${formsPenChainLeak.map(([file]) => file).join(', ')}`);
const formsPenPackageLeak = Object.entries(formsPenInputs)
  .filter(([file, info]) => /packages\/(forms|app|view|flow|contract|validate|emit|db|formats|refs|json)\//.test(file)
    && info.bytesInOutput > 0);
if (formsPenPackageLeak.length > 0)
  throw new Error(`The forms pen pulled a package it must not carry into the bundle: ${formsPenPackageLeak.map(([file]) => file).join(', ')}`);
const formsPenLeak = Object.entries(formsPenInputs)
  .filter(([file, info]) => /packages\/linq\/src\/(model|jslt|migration|contract|flow|app|db)\//.test(file) && info.bytesInOutput > 0);
if (formsPenLeak.length > 0)
  throw new Error(`The forms pen pulled another pen into the bundle: ${formsPenLeak.map(([file]) => file).join(', ')}`);
if (formsPenBytes > 42500)
  throw new Error(`The forms pen bundle grew to ${formsPenBytes} bytes.`);
const chainFormsLeak = Object.entries(chainInputs)
  .filter(([file, info]) => file.includes('packages/linq/src/forms/') && info.bytesInOutput > 0);
if (chainFormsLeak.length > 0)
  throw new Error(`The chain pulled the forms pen into the bundle: ${chainFormsLeak.map(([file]) => file).join(', ')}`);
const schemaFormsLeak = Object.entries(schemaInputs)
  .filter(([file, info]) => file.includes('packages/linq/src/forms/') && info.bytesInOutput > 0);
if (schemaFormsLeak.length > 0)
  throw new Error(`The schema pen pulled the forms pen into the bundle: ${schemaFormsLeak.map(([file]) => file).join(', ')}`);

console.log(`Tree-shaking smoke test passed (${formsPenBytes} byte forms-pen bundle; no chain module, no @jarenjs/forms bytes, no model pen).`);

// Every authored-format entry point is isolated from target engines and the chain.
for (const [pen, probe] of Object.entries(AUTHORED_PEN_PROBES)) {
  const result = await build({
    stdin: { contents: probe.source, resolveDir: process.cwd(), sourcefile: `${pen}-pen-consumer.js` },
    bundle: true, format: 'esm', metafile: true, minify: true,
    platform: 'neutral', treeShaking: true, write: false,
  });
  const bytes = result.outputFiles[0].contents.length;
  const inputs = Object.entries(Object.values(result.metafile.outputs)[0].inputs)
    .filter(([, info]) => info.bytesInOutput > 0).map(([file]) => file);
  const forbidden = inputs.filter((file) =>
    /components\//.test(file)
    || /packages\/(?!core\/|linq\/)/.test(file)
    || (/packages\/linq\/src\/[^/]+\//.test(file) && !file.includes(`/src/${pen}/`))
    || /packages\/linq\/src\/(sequence|document|async|concurrency|provider|sources|schema-of)\.js$/.test(file));
  if (forbidden.length) throw new Error(`${pen} pen imported runtime engines, another pen or chain modules: ${forbidden}`);
  if (bytes > probe.maxBytes) throw new Error(`${pen} pen grew to ${bytes} bytes (budget ${probe.maxBytes})`);
  for (const inputs of [chainInputs, schemaInputs]) {
    if (Object.entries(inputs).some(([file, info]) => file.includes(`/src/${pen}/`) && info.bytesInOutput > 0))
      throw new Error(`The chain or schema pen imported the ${pen} pen`);
  }
  linqBundles.set(pen, bytes);
  console.log(`Tree-shaking passed (${pen}: ${bytes} bytes; no target engine or chain modules).`);
}

// ---- the measured baseline (D11) ----
// Every figure this repository publishes about a `@jarenjs/linq` subpath
// — docs/CONSUMING.md's rounded table, each pen document's `## 7. Cost`
// headline, the chain's four §17 figures, and every sentence in one
// document that quotes another subpath's price — is baked from the file
// written here, through the same marker layer the benchmark figures use
// (`npm run docs:derive`). This script is where the measuring
// happens and therefore where the baseline is written; it is not where
// prose is read.
//
// That split is the point. Reading the documents HERE is what this
// script used to do, with one bespoke regex per shape, and it could only
// check the shapes somebody remembered to write a regex for: the ten
// sentences that quote another subpath's price had none, and were 94
// bytes stale across seven documents before anything noticed. A baked
// figure has no such gap — there is one number, and every quotation of
// it is spliced from that number.
const BASELINE = 'benchmark/bundle-sizes.json';
const kb = (bytes) => Math.round(bytes / 1000);
const measured = {
  bundles: Object.fromEntries(linqBundles),
  chain: { own: chainOwnBytes, withSchemaPen: chainPairBytes, shared: chainSharedBytes },
};
const asJson = `${JSON.stringify(measured, null, 2)}\n`;

if (process.argv.includes('--write')) {
  writeFileSync(BASELINE, asJson);
  console.log(`Tree-shaking baseline WRITTEN to ${BASELINE} (${linqBundles.size} subpaths). `
    + 'Run `npm run docs:derive` to bake the documents from it.');
}
else {
  const committed = readFileSync(BASELINE, 'utf8');
  if (committed !== asJson) {
    const was = JSON.parse(committed);
    const moved = [...linqBundles]
      .filter(([name, bytes]) => was.bundles?.[name] !== bytes)
      .map(([name, bytes]) => `  ${name}: committed ${was.bundles?.[name] ?? '(absent)'}, measured ${bytes}`);
    for (const [key, bytes] of Object.entries(measured.chain)) {
      if (was.chain?.[key] !== bytes) moved.push(`  chain.${key}: committed ${was.chain?.[key] ?? '(absent)'}, measured ${bytes}`);
    }
    throw new Error(`${BASELINE} is stale:\n${moved.join('\n') || '  (formatting only)'}\n`
      + 'Re-measure with `npm run test:tree-shaking -- --write`, then bake the documents '
      + 'with `npm run docs:derive`. Every published subpath price derives from this file.');
  }
  console.log(`Tree-shaking smoke test passed (${linqBundles.size} @jarenjs/linq subpath bundles `
    + `equal to the committed baseline: `
    + [...linqBundles].map(([name, bytes]) => `${name} ${kb(bytes)} kB`).join(', ') + ').');
}

// Browser consumers retain wasm/storage support without any Node transport.
const dbBrowser = await build({
  stdin: { contents: "export { openStore } from '@jarenjs/db'; export { wasmDriver, sqlite3Handle, indexedDbSnapshotHandle } from '@jarenjs/db/wasm';",
    resolveDir: process.cwd(), sourcefile: 'db-browser-consumer.js' },
  bundle: true, format: 'esm', platform: 'browser', treeShaking: true,
  minify: true, metafile: true, write: false,
});
const remoteInputs = Object.keys(dbBrowser.metafile.inputs).filter((file) =>
  /drivers\/(node|worker-)/.test(file));
if (remoteInputs.length) throw new Error(`Node worker transport entered browser bundle: ${remoteInputs.join(', ')}`);
console.log(`DB browser isolation passed (${dbBrowser.outputFiles[0].contents.length} bytes; zero Node transport modules).`);

// Flat machines keep their small pure surface; statecharts add control only.
// Composition remains browser-compatible and imports no Node scheduler/store.
for (const [name, symbol, forbidden] of [
  ['fsm', 'compileFsm', ['statechart.js', 'workflow.js', 'dag.js']],
  ['statechart', 'compileStatechart', ['workflow.js', 'dag.js']],
  ['workflow', 'compileWorkflow', []],
]) {
  const result = await build({
    stdin: { contents: `export { ${symbol} } from '@jarenjs/flow';`, resolveDir: process.cwd(), sourcefile: `flow-${name}-consumer.js` },
    bundle: true, format: 'esm', platform: 'browser', treeShaking: true,
    minify: true, metafile: true, write: false,
  });
  const inputs = Object.entries(Object.values(result.metafile.outputs)[0].inputs);
  const leaked = inputs.filter(([path, info]) => info.bytesInOutput > 0
    && forbidden.some((file) => path.endsWith(`packages/flow/src/${file}`)));
  if (leaked.length) throw new Error(`Flow ${name} retained unrelated engines: ${leaked.map(([path]) => path).join(', ')}`);
  console.log(`Flow ${name} browser isolation passed (${result.outputFiles[0].contents.length} bytes).`);
}
