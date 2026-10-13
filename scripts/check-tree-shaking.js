import { readFileSync, writeFileSync } from 'node:fs';

import { build } from 'esbuild';
import { gzipSync } from 'node:zlib';
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
if (Object.keys(contractResult.metafile.inputs).some(file => file.endsWith('/continuation-node.js')))
  throw new Error('The browser contract entry pulled in its optional Node continuation adapter.');
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
// stale only by failing here (report the loss).
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
// Raised to 38,600 (measured 38528): the shared capture refuses a callback that reads its argument and answers a plain boolean (511) and explains the destructuring read it names (269).
// Raised to 39,000 (measured 38910): the pen boundary that copies caller JSON and words the refusal of a symbol or a prototype-less value add 382.
// Raised to 39,400 (measured 39300): core's deepFreeze, which every pen shares, freezing beneath an already frozen root with a memo of whole frozen subtrees and a cycle guard add 390.
// Raised to 39,700 (measured 39686): the shared capture's coded refusal of JSON.stringify on a captured value add 386.
if (schemaBytes > 39700)
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
// Measured 189359 bytes once the query engine's English message catalog
// rode with it (queryMessagesEn, 12350 bytes of the bundle): every refusal
// names its message, and a locale pack can translate it. Measured 209715
// once the engine wrote and read numbers (QUERY-FORMAT 8.5, 8.7): the F&O
// picture formatter (5193 bytes), the unit registry $quantity converts
// through with its alias table (5603), the seven operators' entries,
// checks and f64 helpers (5678), their 25 English messages (2293) and
// exact decimal rounding (1518). Measured 210541 once $quantity converted
// the decimal its text writes exactly — the core decimal helpers and a unit
// index (the exact path) — and $max/$min ordered signed zeros as IEEE 754:
// 826 bytes.
// Measured 213563 once the capture recorded faithfully and the options of
// the chain's modules became closed vocabularies (each refusal names the
// nearest member): the capture root and expression recording add 1113
// (expression 911, capture-root 202), the document, sequence, async and
// concurrency modules 1417, the JSONPath filter depth counter 91 and the
// RFC 3339 edges 90, less 85 in the query operators.
// Measured 216582 once overlapping intervals joined through an interval
// index with every join probe built on first use (2042), the shared capture
// refused a callback that reads its argument and answers a plain boolean
// (513) and explained the destructuring read it names (209), and the
// compiled query caches were keyed by member order (255).
// Raised to 216,800 (measured 216793): the sequence's per-run bindings, caller JSON copied at its boundary and the bounded push queue add 211.
// Raised to 217,400 (measured 217345): core's deepFreeze, which every pen shares, freezing beneath an already frozen root with a memo of whole frozen subtrees and a cycle guard, and the sequence code it carries add 552.
// Raised to 218,500 (measured 218468): core's corrected date, month, grapheme and moving-average helpers the engine carries add 1123.
// Raised to 218,700 (measured 218633): the engine's group-key identity for bigints and undefined members add 165.
// Raised to 219,200 (measured 219196): core's occupied-bucket resample walk and nearest-rank quantiles the engine carries add 563.
// Raised to 219,600 (measured 219582): the shared capture's coded refusal of JSON.stringify on a captured value add 386.
if (chainBytes > 219600)
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
// Raised to 47,500 (measured 47317): the capture every pen shares records
// faithfully (740) and the entity vocabulary refuses more spellings (225).
// Raised to 50,300 (measured 50249): entity indexes — composite, unique and
// partial, with their conditions — ride in the pen (2149), and the shared capture refuses a callback that reads its argument and answers a plain boolean (514) and explains the destructuring read it names (269).
// Raised to 50,400 (measured 50322): the collection spec's `intervals` option
// and its closed entries (73).
// Raised to 50,800 (measured 50710): caller JSON copied at the pen boundary and worded refusals of symbol and prototype-less values add 388.
// Raised to 51,200 (measured 51102): core's deepFreeze, which every pen shares, freezing beneath an already frozen root with a memo of whole frozen subtrees and a cycle guard add 392.
// Raised to 51,500 (measured 51488): the shared capture's coded refusal of JSON.stringify on a captured value add 386.
if (modelBytes > 51500)
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
// Raised to 21,000 (measured 20668): the shared capture's faithful
// recording (740).
// Raised to 21,500 (measured 21448): the shared capture refuses a callback that reads its argument and answers a plain boolean (511) and explains the destructuring read it names (269).
// Raised to 21,900 (measured 21878): core's deepFreeze, which every pen shares, freezing beneath an already frozen root with a memo of whole frozen subtrees and a cycle guard add 389.
// Raised to 22,300 (measured 22264): the shared capture's coded refusal of JSON.stringify on a captured value add 386.
if (jsltBytes > 22300)
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
// Raised to 26,000 with the host step: `.host(run, version)` and its
// checks ride in the pen, and the document snapshot every pen shares
// copies by an explicit stack (a grouping nested thousands deep by hand no
// longer overflows it). Measured 25601.
// Raised to 27,200 (measured 26807): the shared capture's faithful
// recording (740) and the migration pen's own refusals (136).
// Raised to 27,600 (measured 27586): the shared capture refuses a callback that reads its argument and answers a plain boolean (511) and explains the destructuring read it names (268).
// Raised to 27,700 (measured 27614): caller JSON copied at the pen boundary add 28.
// Raised to 28,100 (measured 28005): core's deepFreeze, which every pen shares, freezing beneath an already frozen root with a memo of whole frozen subtrees and a cycle guard add 391.
// Raised to 28,400 (measured 28391): the shared capture's coded refusal of JSON.stringify on a captured value add 386.
if (migrationBytes > 28400)
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
const asyncLiveLeak = Object.entries(clientInputs).filter(([file, info]) =>
  /packages\/db\/src\/(async-live|live-executor|snapshot)\.js$/.test(file) && info.bytesInOutput > 0);
if (asyncLiveLeak.length)
  throw new Error(`The ordinary client retained optional async maintenance: ${asyncLiveLeak.map(([file]) => file).join(', ')}`);
// Measured 757116 bytes. The closed open options and scope input had already
// taken the client to 739445 without a re-measure of this ceiling (737500);
// whole-transaction retry, the hold limit, one connection-loss rule, the
// Store-bound relational engine with its write rules, and the statement
// finalization under its bounded cache add 17671 more. The optional scheduler
// and evaluator stay outside this closure, checked above. This structural
// allowance does not change application RSS, work or deadline budgets.
// Measured 778772 bytes since: the isolation floor and the owner lease with
// its second check at the gate, the atomic patch with its preconditions and
// all(), keyset pages over column-mapped tables, bound membership lists,
// and migration host steps with atomic runs and the per-link foreign-key
// baseline add 21656. Measured 789872 bytes since: the query engine's
// English message catalog, which the store's evaluator carries, adds 10916.
// Measured 810232 bytes since (789909 at the last release): the engine's
// numbers as text, quantities and exact rounding, which the evaluator
// carries too, add 20323 (the parts the chain bundle's ceiling itemizes).
// Measured 812570 bytes since: parallel root reads — the read gate, the
// cursor that holds one read across its pulls, and the connection's shared
// admission — add 2338. Measured 813018 since: F&O's minimum-size
// adjustments and exponent scaling, the rules for reading a quantity out of
// text, and the cursor's owner check before each pull add 448. Measured
// 833547 since: database rules — the trigger programs the store verifies at
// open field by field, the change test, keyed existence probes and
// increments, and the narrowed physical update — add 9633; several sessions
// per Store — the session router, a transaction context per call, the
// statement that resolves its session at each execution and capture's state
// per transaction — and store rules judged at their own statements, against
// the row as it was and as it is stored, add 10896. Measured 835467 since: a
// transaction's operations taking turns, the owner's slots given back after
// an inline call, a cursor cut short by close refusing its next pull, the
// locked row a store rule judges, a numeric key's text that names no row,
// and the engine's exact quantity conversion (826, the chain's) add 1920.
// Measured 855906 once the store core and the query engine were hardened:
// the tracker's rollback restore, iterative save and key handling add 5257,
// the query engine (closed option bags, the exactness guard with its
// fallback, ordering by declared type) 3007 and the planner 1109 and
// emitter 707, the DDL planner (own relation names, identifier limit, key
// column types) 2105, the entity writer's key checks 1261, rule refusals
// 804, the error table 762, the model normalizer 618, the store 520, jobs
// 384, option vocabularies 269 and JSON patch options 456, and the pens'
// shared capture and closed option bags 1589.
// Measured 894190 since: live maintenance — collection offset windows (476),
// group returns with exact integer sums (219), groupBy emissions (448), flat
// indexed self joins (512), the defects found hunting those strategies (999)
// and the re-run of every live registration on a profiled store with
// whole-collection root reads (2036) — adds 4690; backups — the page-by-page
// Bun copy with progress, abort and safe publication (572), the
// page-identical snapshot (67) and the refusal of targets that alias the live
// database with bounded copies (888) — add 1527; the one row-predicate module
// that lowers rule and index conditions (3255), entity indexes — composite,
// unique and partial (9864) — with their conditions migrated and read back
// (6447), and database rules installed on store-owned tables and verified at
// open (3491) add 23057; journal capture of the rows foreign-key actions
// change (3401), replication of cascading and set-null relations in a safe
// replay order (2518) and the create whose membership the database refuses
// (48), less the referencing read through the cursor (23), add 5944; the
// interval index join with lazily built probes (2043), the refusal of a
// callback that reads its argument with its explanation (514 and 209) and
// compiled query caches keyed by member order (341) add 3107; the log and
// lease statements released after each use take 41 away.
// Measured 925082 since: declared intervals — the vocabulary, the store's
// check, the CHECK on both engines with its PostgreSQL read-back and the exact
// plan (9698), their migration and introspection (1832) and the seek bounded
// on both sides by a maximum duration (245) — add 11775; verified physical
// indexes at every open, existence probes keyed by a unique index and bounded
// integer arithmetic (7263), the application's own index spelling compared by
// tokens and a member that shadows a column refused (1610) add 8873; the
// regrouped disjunction (789), the PostgreSQL typed extraction (305), the
// predicate term bound (1438) and the wrong answers a planner hunt fixed with
// the join refinements it counts (1269) add 3801; the row-value keyset with
// PostgreSQL's physical keyset (1049), a SQLite uuid paged by the text its
// table stores (693) and the defects a keyset hunt fixed (1208) add 2950;
// duplicate keys classified by the key's own constraint (1507); the labelled
// PostgreSQL row estimate (611); PostgreSQL entity migrations — key allocation,
// column and document moves, rebuild casts (694); and statement slots given
// back by job pages, maintenance, trusted statements at the end of their
// transaction and the process host (681).
// Measured 944041 since: floating temporal-bucket sums kept in the engine
// (266); correlated navigation hops in predicates, counts and projections
// (about 6200), typed path comparisons across JSON families with a literal
// $get and the PostgreSQL digit-name guard (about 3400) and groups ordered by
// an integer sum or average (about 700) add 10272 together; join edges limited
// to pairs both engines agree on, grouped joins of entity roots and a row
// identity no member name shadows (2280); windows and counts over constructors
// of total operators (2111); distinct over compound, other-ordered and entity
// projections with group keys read as doubles (3187); and the defects a
// planner hunt fixed (843).
// Raised to 944,200 (measured 944196): the chain's per-run bindings and copied caller JSON, less the planner's single scalar-type table add 155.
// Raised to 948,800 (measured 948704): the store's checked close and worker options, null accepted as no options, refused non-object entity writes and the closed option sets of maintenance, changes, replication, jobs and introspection (2664), the JSON engine's date range and prototype-named members (964) and core's deepFreeze (about 390) add 4508.
// Raised to 950,200 (measured 950165): the same core helpers the store and the engine carry add 1461.
// Raised to 950,500 (measured 950448): the minimum and maximum applied beside a
// numeric exclusive bound, shared by the engine's validator, add 283.
// Raised to 952,800 (measured 952715): relation names read as own members in the db client, misspelt durable and graph options refused (about 1600), and native buckets that count rows without a reading, event-time refusals and a read-only capture record shared by live views (about 700) add 2267.
// Raised to 954,500 (measured 954485): the store's closed options, relation drops beside renames and derived foreign keys (about 1340), and the engine's group-key identity for bigints and undefined members (about 300) add 1770.
// Raised to 955,100 (measured 955085): core's occupied-bucket resample walk, nearest-rank quantiles and the WKT writer's validation add 600.
// Raised to 955,400 (measured 955324): the claim that dead-letters a job whose lease expired past its attempt bound adds 345.
// Raised to 955,600 (measured 955583): SQLite's extremes and projections read
// large integer-valued doubles back as doubles (add 259).
// Raised to 957,100 (measured 957081): the shared capture's coded refusal of JSON.stringify on a captured value (386), the native temporal bucket kept in the engine over a nullable reading and the I-Regexp compile check the validator carries add 1498.
// Raised to 958,200 (measured 958119): an entity comparison of two null-policy columns sent to the engine and the cycle-safe table-first creation order add 1038.
// Raised to 959,000 (measured 958898): the fold that writes the document expression once per column and the validator's per-subtree location scan add 779.
// Raised to 960,400 (measured 960363): the untyped column of an indexed union member, the adoption of a column an earlier store typed and the rebuild a changed union plans add 1465.
// Raised to 961,600 (measured 961595): the profile's predicate on point reads, the keyset load's per-call continuation binding and the term weights of external comparisons add 1232.
// Raised to 963,200 (measured 963128): the guarded reads of an open-container index path, the step kinds a migration compares and the null-counting grouped fold add 1533.
// Raised to 964,100 (measured 964083): the codec agreement check of a model, the text-encoding check at open and the bounded ledger sweep add 955.
if (clientBytes > 964100)
  throw new Error(`The client bundle grew to ${clientBytes} bytes.`);
console.log(`Tree-shaking smoke test passed (${clientBytes} byte client bundle — the store, the validator and the formats ride as declared; no other pen, no emit/refs).`);

// The contract pen (`@jarenjs/linq/contract`) writes `$contract` 0.1
// documents whose schemas are the schema pen's — so the probe measures
// the two together (a contract without a schema builder is not a
// contract), and the ceiling is that measured pair. What it must NOT
// carry: a chain module, a query engine, a validator, another pen, and
// above all any byte of `@jarenjs/contract`, whose compiler is the only
// judge of what the document means. The chain carries no contract
// module in return. Measured 50054 bytes once the pen's path templates
// parse through `@jarenjs/core/route`, the suite's one template parser
// (3211 of them), in place of a scan of its own.
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
// Raised to 51,300 (measured 51005): the shared capture's faithful
// recording (740).
// Raised to 51,800 (measured 51785): the shared capture refuses a callback that reads its argument and answers a plain boolean (514) and explains the destructuring read it names (266).
// Raised to 52,200 (measured 52169): caller JSON copied at the pen boundary and an own-member read of the http `in` map add 384.
// Raised to 52,600 (measured 52562): core's deepFreeze, which every pen shares, freezing beneath an already frozen root with a memo of whole frozen subtrees and a cycle guard add 393.
// Raised to 52,900 (measured 52871): a contract declaration copied from the caller's spec add 309.
// Raised to 53,300 (measured 53257): the shared capture's coded refusal of JSON.stringify on a captured value add 386.
if (contractPenBytes > 53300)
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
// Raised to 21,000 (measured 20726): the shared capture's faithful
// recording (740).
// Raised to 21,600 (measured 21505): the shared capture refuses a callback that reads its argument and answers a plain boolean (511) and explains the destructuring read it names (268).
// Raised to 22,000 (measured 21978): core's deepFreeze, which every pen shares, freezing beneath an already frozen root with a memo of whole frozen subtrees and a cycle guard add 388.
// Raised to 22,400 (measured 22364): the shared capture's coded refusal of JSON.stringify on a captured value add 386.
if (flowPenBytes > 22400)
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
// Raised to 53,800 (measured 53705): the shared capture refuses a callback that reads its argument and answers a plain boolean (514) and explains the destructuring read it names (270).
// Raised to 54,000 (measured 53968): caller JSON copied at the pen boundary and its worded refusals add 263.
// Raised to 54,400 (measured 54359): core's deepFreeze, which every pen shares, freezing beneath an already frozen root with a memo of whole frozen subtrees and a cycle guard add 391.
// Raised to 54,800 (measured 54700): the shared capture's coded refusal of JSON.stringify on a captured value add 386.
if (appPenBytes > 54800)
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
// Raised to 42,800 (measured 42725): the shared capture refuses a callback that reads its argument and answers a plain boolean (541) and explains the destructuring read it names (281).
// Raised to 43,000 (measured 42997): caller JSON copied at the pen boundary and its worded refusals add 272.
// Raised to 43,400 (measured 43389): core's deepFreeze, which every pen shares, freezing beneath an already frozen root with a memo of whole frozen subtrees and a cycle guard add 392.
// Raised to 43,600 (measured 43566): the vacuous assert on a tuple slot the data does not hold yet adds 177.
// Raised to 44,000 (measured 43952): the shared capture's coded refusal of JSON.stringify on a captured value add 386.
if (formsPenBytes > 44000)
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

const formulaPen = await build({ stdin: { contents: "import { defineFormula } from '@jarenjs/linq/formula'; export const doc = defineFormula('amount', { $mul: ['$.price', '$.quantity'] });", resolveDir: process.cwd() }, bundle: true, write: false, format: 'esm', minify: true, metafile: true });
const formulaPenBytes = formulaPen.outputFiles[0].contents.length;
if (formulaPenBytes > 32768) throw new Error('Formula authoring exceeds its 32 KiB bundle ceiling');
if (Object.entries(Object.values(formulaPen.metafile.outputs)[0].inputs).some(([file, info]) => info.bytesInOutput > 0 && /json\/src\/query\/|packages\/(view|app|db|validate)|components\//.test(file))) throw new Error('Formula authoring pulled an evaluator or component into its output');
linqBundles.set('formula', formulaPenBytes);
console.log(`Formula authoring tree shaking passed (${formulaPenBytes} bytes).`);

// ---- the component rule, measured (docs/workflow/CONVENTIONS.md §1) ----
// No component imports another: a host hands mermaid's plugin to md and
// charts' pie renderer to mermaid. The probe reads the IMPORT GRAPH, not a
// tree-shaken bundle — a browser loading these modules unbundled fetches
// every static import whatever is used, so `sideEffects` hints are
// ignored and nothing is shaken: a re-export of a diagram plugin is a
// leak here even where a bundler would drop it.
/** @type {Map<string, number>} */
const componentBundles = new Map();
for (const [entry, forbidden] of [
  ['@jarenjs/md', /components\/(mermaid|charts)\//],
  ['@jarenjs/md/component', /components\/(mermaid|charts)\//],
  ['@jarenjs/md/plugins', /components\/(mermaid|charts)\//],
  ['@jarenjs/mermaid', /components\/(charts|md)\//],
  ['@jarenjs/mermaid/plugin', /components\/(charts|md)\//],
  ['@jarenjs/mermaid/component', /components\/(charts|md)\//],
]) {
  const graph = await build({
    stdin: { contents: `export * from '${entry}';`, resolveDir: process.cwd(), sourcefile: 'component-graph.js' },
    bundle: true, format: 'esm', platform: 'browser', treeShaking: false, ignoreAnnotations: true,
    metafile: true, write: false, logLevel: 'silent',
  });
  const leaked = Object.keys(graph.metafile.inputs).filter((file) => forbidden.test(file));
  if (leaked.length) throw new Error(`${entry} imports another component: ${leaked.join(', ')}`);
}
// what each costs a consumer who uses it and nothing else, tree-shaken
for (const [name, contents] of [
  ['md', "import { parseMarkdown, mdToVnode } from '@jarenjs/md'; export const render = (s) => mdToVnode(parseMarkdown(s));"],
  ['mermaid', "import { diagramToVnode } from '@jarenjs/mermaid'; export const render = (s) => diagramToVnode(s);"],
]) {
  const result = await build({
    stdin: { contents, resolveDir: process.cwd(), sourcefile: `${name}-consumer.js` },
    bundle: true, format: 'esm', platform: 'browser', treeShaking: true, minify: true, write: false,
  });
  componentBundles.set(name, result.outputFiles[0].contents.length);
}
console.log('Component rule passed (md imports no mermaid or charts module, mermaid no charts or md module, '
  + `unbundled; md ${componentBundles.get('md')} bytes, mermaid ${componentBundles.get('mermaid')} bytes tree-shaken).`);

// ---- the measured baseline ----
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
  components: Object.fromEntries(componentBundles),
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
    for (const [key, bytes] of Object.entries(measured.components)) {
      if (was.components?.[key] !== bytes) moved.push(`  components.${key}: committed ${was.components?.[key] ?? '(absent)'}, measured ${bytes}`);
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

// Collection geometry never pulls presentation, storage or retained reference engines into a bundle.
const collectionGeometry = await build({stdin:{contents:"export { fixedRange } from '@jarenjs/core/virtual';",resolveDir:process.cwd()},
  bundle:true,write:false,platform:'neutral',format:'esm',minify:true,metafile:true});
if (collectionGeometry.outputFiles[0].contents.length > 2500) throw new Error('Fixed range bundle exceeds geometry budget');
if (Object.keys(collectionGeometry.metafile.inputs).some((file)=>/packages\/(view|app|db|linq)|components\//.test(file)))
  throw new Error('Geometry imported a presentation or data owner');
const collectionEngine = await build({stdin:{contents:"export { createCollection } from '@jarenjs/collection';",resolveDir:process.cwd()},
  bundle:true,write:false,platform:'neutral',format:'esm',minify:true,metafile:true});
if (Object.keys(collectionEngine.metafile.inputs).some((file)=>/packages\/(app|db|linq)|src\/component\//.test(file)))
  throw new Error('Collection engine imported coordination or the DOM component');
console.log(`Collection geometry/engine tree shaking passed (${collectionGeometry.outputFiles[0].contents.length}/${collectionEngine.outputFiles[0].contents.length} bytes).`);

// Lexical mechanics are an opt-in core closure, independent of host adapters and reference engines.
const lexicalEngine = await build({stdin:{contents:"export { compileLexical } from '@jarenjs/core/search';",resolveDir:process.cwd()},
  bundle:true,write:false,minify:true,format:'esm',platform:'browser',metafile:true});
if (Object.keys(lexicalEngine.metafile.inputs).some(file=>/packages\/(json|linq|db|app|ai|view)|components\/|node_modules\//.test(file)))
  throw new Error('Lexical mechanics imported a host, higher layer or external dependency');
if (gzipSync(lexicalEngine.outputFiles[0].contents).length > 65536) throw new Error('Lexical browser bundle exceeds frozen budget');
console.log(`Lexical tree shaking passed (${gzipSync(lexicalEngine.outputFiles[0].contents).length} gzip bytes).`);

for (const [entry, forbidden] of [
  ["export { createCommand } from '@jarenjs/contract/command';", /packages\/(flow|linq|db|app|ai)/],
  ["export { createExternalEffects } from '@jarenjs/flow';", /packages\/(contract|linq|db|ai)/],
  ["export { createProviderExecutor } from '@jarenjs/contract/provider';", /packages\/(ai|flow|linq|db)|provider\/(compile|run)\.js/],
  ["export { createIngestion } from '@jarenjs/flow';", /packages\/(contract|linq|db|ai)/],
  ["export { createScheduler } from '@jarenjs/core/schedule';", /packages\/(json|contract|flow|linq|db|ai)/],
]) {
  const bundle = await build({ stdin: { contents: entry, resolveDir: process.cwd() },
    bundle: true, minify: true, format: 'esm', platform: 'browser', write: false, metafile: true });
  const retained = Object.values(bundle.metafile.outputs).flatMap((output) => Object.entries(output.inputs));
  if (retained.some(([file, info]) => info.bytesInOutput > 0 && forbidden.test(file))) throw new Error('Provider composition violates owner isolation');
  console.log(`Provider owner isolation passed (${bundle.outputFiles[0].contents.length} bytes).`);
}

const ruleEngine = await build({ stdin: { contents: "export { createRuleEditor } from '@jarenjs/rules';", resolveDir: process.cwd() }, bundle: true, write: false, format: 'esm', minify: true, metafile: true });
if (Object.keys(ruleEngine.metafile.inputs).some((file) => /packages\/(json|app|forms|db|linq)|src\/component\//.test(file))) throw new Error('Rule engine imports orchestration or an evaluator');
const formulaEngine = await build({ stdin: { contents: "export { compileFormula } from '@jarenjs/json/formula';", resolveDir: process.cwd() }, bundle: true, write: false, format: 'esm', minify: true, metafile: true });
if (Object.keys(formulaEngine.metafile.inputs).some((file) => /components\/|packages\/(app|view|db|validate)/.test(file))) throw new Error('Formula engine reverses dependency direction');
console.log(`Rule/formula tree shaking passed (${ruleEngine.outputFiles[0].contents.length}/${formulaEngine.outputFiles[0].contents.length} bytes).`);

// Pure host utilities stay browser-safe; the explicit process owner is never
// resolved through core's root or the search/stats/text barrels.
const hostPrimitives = await build({ stdin: { contents:
  "export {isFn} from '@jarenjs/core'; export {pairedBootstrap} from '@jarenjs/core/stats';"
  + "export {reciprocalRankFusion} from '@jarenjs/core/search'; export {compileTextEdits} from '@jarenjs/core/text/edits';",
  resolveDir: process.cwd() }, bundle: true, write: false, minify: true, metafile: true, platform: 'browser', format: 'esm' });
if (Object.keys(hostPrimitives.metafile.inputs).some(file => file.endsWith('/process-node.js')))
  throw new Error('Pure core browser imports resolved the optional Node process executor.');
console.log('Browser host primitives exclude the Node process executor.');
