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
// The ceiling moved from 32,000 to 32,500 at the campaign's close-out: the
// shared JSON boundary gained `requireNameMap`, the one refusal that keeps
// a `__proto__:` key in a spec literal from eating a member silently, and
// `json-boundary.js` rides in EVERY pen bundle. Raising the ceiling with
// the reason is the honest move; shaving the message is not.
if (schemaBytes > 32500)
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
// The ceiling moved from 40,000 to 41,000 when the pen started mirroring
// four more of the store's member rules — `key()`/`unique()`/`index()`
// off a kind that can hold no column, `version()` off an integer, an
// `x-entity` member outside the closed vocabulary, and a `renamedFrom()`
// hint the document has no place for. Almost all of it is message text:
// a refusal that names the rule and the spelling that works is the point
// of raising it at build rather than at `openStore`, so the honest move
// is to raise the ceiling with the reason, never to shave the message.
if (modelBytes > 41000)
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
if (clientBytes > 520000)
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
if (contractPenBytes > 46000)
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
if (appPenBytes > 48000)
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
if (formsPenBytes > 40000)
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

// ---- the published prices (D11) ----
// docs/CONSUMING.md states one figure per `@jarenjs/linq` subpath, each
// beside a `<!--bundle:NAME-->` marker. Every one is compared with the
// bundle measured above, so a published price cannot go stale without
// this gate going red — and no number in that table was ever typed.
const consuming = readFileSync('docs/CONSUMING.md', 'utf8');
const kb = (bytes) => Math.round(bytes / 1000);
const stale = [];
for (const [name, bytes] of linqBundles) {
  const marker = `<!--bundle:linq-${name}-->`;
  const stated = new RegExp(`${marker}(\\d+) kB`).exec(consuming);
  if (stated === null) stale.push(`${marker} is missing (measured ${kb(bytes)} kB)`);
  else if (Number(stated[1]) !== kb(bytes)) {
    stale.push(`${marker} states ${stated[1]} kB, measured ${kb(bytes)} kB (${bytes} bytes)`);
  }
}
if (stale.length > 0) {
  throw new Error('docs/CONSUMING.md\'s subpath prices are stale:\n  '
    + stale.join('\n  ') + '\nRefresh the figure beside each marker.');
}

console.log(`Tree-shaking smoke test passed (docs/CONSUMING.md states all ${linqBundles.size} `
  + `@jarenjs/linq subpath prices, each equal to the bundle measured here: `
  + [...linqBundles].map(([name, bytes]) => `${name} ${kb(bytes)} kB`).join(', ') + ').');

// ---- the pen documents' EXACT figures ----
// Each pen document's `## 7. Cost` opens with the byte count this script
// measures. CONSUMING.md's rounded table was gated above and these were
// not, so 0.52.7's schema-pen change moved five of them 157 bytes out of
// date at once and nothing said so. Same rule as the table: the number is
// derived, never typed, and a stale one is red here rather than wrong in
// a document somebody reads. The chain's own document is checked below
// the loop: it carries four figures, not one, and its Cost section is
// numbered §17.
const PEN_DOCS = new Map([
  ['schema', 'SCHEMA-PEN.md'], ['model', 'MODEL-PEN.md'], ['jslt', 'JSLT-PEN.md'],
  ['migration', 'MIGRATION-PEN.md'], ['db', 'DB-CLIENT.md'], ['contract', 'CONTRACT-PEN.md'],
  ['flow', 'FLOW-PEN.md'], ['app', 'APP-PEN.md'], ['forms', 'FORMS-PEN.md'],
]);
const grouped = (bytes) => bytes.toLocaleString('en-US');
const drifted = [];
for (const [name, file] of PEN_DOCS) {
  const bytes = linqBundles.get(name);
  if (bytes === undefined) throw new Error(`no bundle was measured for the ${name} subpath`);
  const doc = readFileSync(`packages/linq/docs/${file}`, 'utf8');
  const start = doc.indexOf('\n## 7. Cost');
  if (start < 0) { drifted.push(`${file} has no '## 7. Cost' section`); continue; }
  const rest = doc.slice(start + 1);
  const next = rest.slice(1).search(/^## /m);
  const section = next < 0 ? rest : rest.slice(0, next + 1);
  const stated = /\*\*([\d,]+) bytes\*\*/.exec(section);
  if (stated === null) drifted.push(`${file} §7 states no byte count (measured ${grouped(bytes)})`);
  else if (stated[1] !== grouped(bytes)) {
    drifted.push(`${file} §7 states ${stated[1]} bytes, measured ${grouped(bytes)}`);
  }
}

// The chain's document keeps its own twelve sections (D2 forbids
// renumbering it), so its Cost section is §17 — and it publishes FOUR
// figures rather than one: the bundle, the chain's own modules inside
// it, the bundle a consumer taking the schema pen as well pays, and what
// the two share. All four are read in the order the section states them.
const chainDoc = readFileSync('packages/linq/docs/QUERY-PEN.md', 'utf8');
const chainCost = chainDoc.slice(chainDoc.indexOf('\n## 17. Cost') + 1);
const chainStated = [...chainCost.matchAll(/\*\*([\d,]+) bytes\*\*/g)].map((m) => m[1]);
const chainExpected = [chainBytes, chainOwnBytes, chainPairBytes, chainSharedBytes].map(grouped);
if (chainStated.join(' | ') !== chainExpected.join(' | ')) {
  drifted.push(`QUERY-PEN.md §17 states ${chainStated.join(', ') || '(nothing)'}, `
    + `measured ${chainExpected.join(', ')}`);
}

if (drifted.length > 0) {
  throw new Error('a pen document\'s §7 Cost figure is stale:\n  '
    + drifted.join('\n  ') + '\nRefresh the figure; it is measured, never typed.');
}

console.log(`Tree-shaking smoke test passed (${PEN_DOCS.size} pen documents state their §7 Cost `
  + `in bytes and QUERY-PEN.md its §17's four, each equal to a bundle measured here).`);
