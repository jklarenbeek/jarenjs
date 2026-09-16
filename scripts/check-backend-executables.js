//@ts-check
/** Installed, build-selected application binaries run without source or module lookup paths. */
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { createRequire, isBuiltin } from 'node:module';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { compileStandalone } from './lib/standalone.js';

const consumer = process.argv[2] && resolve(process.argv[2]);
if (!consumer || process.argv.length !== 3 || !existsSync(join(consumer, 'receipt.json')))
  throw new Error('Pass the HOST_CONSUMER_OUTPUT directory from test:packed');
if (!process.env.JAREN_PG_URL) throw new Error('Executable qualification requires JAREN_PG_URL');
if (process.platform !== 'linux') throw new Error('This standalone qualification profile currently requires Linux');
const receipt = JSON.parse(readFileSync(join(consumer, 'receipt.json'), 'utf8'));
assert.equal(receipt.source, 'local npm pack; not registry publication');
const directory = mkdtempSync(join(tmpdir(), 'jaren-backend-binaries-'));
const installed = join(directory, 'installed'), isolated = join(directory, 'isolated');
mkdirSync(installed); mkdirSync(isolated);
const tools = createRequire(import.meta.url), copied = new Map();

/** Copy the host's locked pg dependency closure, refusing ambiguous versions.
 * @param {string} name @param {string} parent */
function copyHostPackage(name, parent) {
  const loader = createRequire(join(parent, 'package.json'));
  let source = dirname(loader.resolve(name));
  while (!existsSync(join(source, 'package.json'))
    || JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')).name !== name) {
    const next = dirname(source);
    if (source === next) throw new Error(`Cannot locate host package ${name}`);
    source = next;
  }
  const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
  if (copied.has(name)) { assert.equal(copied.get(name), manifest.version); return; }
  copied.set(name, manifest.version);
  cpSync(source, join(installed, 'node_modules', name), { recursive: true, dereference: true });
  for (const dependency of Object.keys(manifest.dependencies ?? {})) copyHostPackage(dependency, source);
  for (const dependency of Object.keys(manifest.optionalDependencies ?? {})) {
    try { loader.resolve(dependency); }
    catch (error) { if (error.code === 'MODULE_NOT_FOUND') continue; throw error; }
    copyHostPackage(dependency, source);
  }
}

const binaries = [], report = [];
try {
  cpSync(join(consumer, 'node_modules'), join(installed, 'node_modules'), { recursive: true });
  for (const name of ['backend-app.js', 'backend-entry.js']) cpSync(join(consumer, name), join(installed, name));
  writeFileSync(join(installed, 'package.json'), '{"type":"module","private":true}');
  const installedRequire = createRequire(join(installed, 'package.json'));
  for (const { name, version } of receipt.packages) {
    const entry = realpathSync(installedRequire.resolve(name));
    assert.ok(entry.startsWith(join(installed, 'node_modules') + sep), `${name} resolves outside the installed closure`);
    assert.equal(JSON.parse(readFileSync(join(installed, 'node_modules', name, 'package.json'), 'utf8')).version, version);
  }
  assert.equal(existsSync(join(installed, 'node_modules/pg')), false,
    'SQLite must build before the host installs any PostgreSQL client');
  for (const backend of ['sqlite', 'postgres']) {
    if (backend === 'postgres') {
      copyHostPackage('pg', dirname(tools.resolve('pg/package.json')));
      const matrix = JSON.parse(readFileSync(new URL('../docker/postgres/matrix.json', import.meta.url), 'utf8'));
      assert.equal(copied.get('pg'), matrix.driver.version);
    }
    for (const runtime of ['node', 'bun']) {
      const bundle = join(installed, `${backend}-${runtime}.cjs`);
      const built = await build({ entryPoints: [join(installed, 'backend-entry.js')], outfile: bundle,
        absWorkingDir: installed, bundle: true, platform: 'node', format: 'cjs', metafile: true, logLevel: 'silent',
        external: ['bun:sqlite', 'pg-native', 'cloudflare:sockets'],
        define: { 'process.env.JAREN_BACKEND': JSON.stringify(backend), 'process.env.JAREN_RUNTIME': JSON.stringify(runtime) } });
      const output = Object.values(built.metafile.outputs)[0];
      const inputs = Object.entries(output.inputs).filter(([, value]) => value.bytesInOutput > 0).map(([name]) => name);
      if (backend === 'sqlite') {
        assert.ok(!inputs.some(name => /node_modules\/pg(?:-|\/)|db\/src\/drivers\/postgres/.test(name)),
          'the SQLite executable includes PostgreSQL code');
        assert.ok(!output.imports.some(item => item.path === 'pg-native'));
      }
      for (const input of output.imports)
        assert.ok(isBuiltin(input.path) || ['bun:sqlite', 'pg-native', 'cloudflare:sockets'].includes(input.path),
          `unbundled runtime dependency ${input.path}`);
      const binary = join(isolated, `${backend}-${runtime}`);
      compileStandalone(bundle, binary, runtime, { bun: process.env.BUN_BINARY });
      binaries.push({ backend, runtime, binary, bytes: statSync(binary).size,
        sha256: createHash('sha256').update(readFileSync(binary)).digest('hex'),
        bundledBytes: statSync(bundle).size, inputs });
    }
  }
  // Executing elsewhere with all source and packages removed catches dynamic lookups.
  rmSync(installed, { recursive: true, force: true });
  const allowed = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR', 'TZ'];
  const environment = Object.fromEntries(allowed.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  for (const binary of binaries) {
    const output = execFileSync(binary.binary, [], { cwd: isolated, encoding: 'utf8', timeout: 60000,
      env: { ...environment, JAREN_PG_URL: process.env.JAREN_PG_URL,
        // The compiled directive remains authoritative over runtime environment drift.
        JAREN_BACKEND: binary.backend === 'sqlite' ? 'postgres' : 'sqlite' } });
    const result = JSON.parse(output.trim());
    assert.equal(result.backend, binary.backend); assert.equal(result.runtime, binary.runtime);
    report.push({ ...binary, binary: basename(binary.binary), result });
  }
  const evidence = { format: 'jaren-backend-executables/1', platform: process.platform, arch: process.arch,
    source: receipt.source, packages: receipt.packages, hostPackages: Object.fromEntries(copied),
    sourceAndModulesRemoved: true, sqliteBuiltWithoutPg: true, report };
  if (process.env.BACKEND_EXECUTABLE_OUTPUT) {
    const output = resolve(process.env.BACKEND_EXECUTABLE_OUTPUT);
    mkdirSync(output);
    cpSync(isolated, output, { recursive: true });
    writeFileSync(join(output, 'receipt.json'), JSON.stringify(evidence, null, 2) + '\n');
  }
  console.log(JSON.stringify(evidence, null, 2));
}
finally { rmSync(directory, { recursive: true, force: true }); }
