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
