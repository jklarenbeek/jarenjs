//@ts-check
/** Source hosts and relocated standalone executables exercise the same application assertions. */
import { mkdtempSync, rmSync, writeFileSync, copyFileSync, mkdirSync, symlinkSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { writeAdoptionConsumer, qualifyAdoptionRuntime } from './lib/adoption-journey.js';
import { adoptionHash, readAdoption, verifyFreeze } from '../test/adoption/evidence.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = mkdtempSync(join(tmpdir(), 'jaren-adoption-hosts-'));
const report = [];
const manifest = readAdoption('manifest.json'); verifyFreeze(manifest);
if (process.argv.slice(2).some((arg) => !['--native', '--native-only', '--write'].includes(arg))) throw new Error('Unknown adoption host argument');
try {
  writeFileSync(join(directory, 'package.json'), '{"type":"module"}');
  symlinkSync(join(root, 'node_modules'), join(directory, 'node_modules'), 'dir');
  const entry = writeAdoptionConsumer(directory, root);
  if (!process.argv.includes('--native-only')) {
    report.push(qualifyAdoptionRuntime(process.execPath, ['--no-warnings=ExperimentalWarning', entry], directory, 'node'));
    report.push(qualifyAdoptionRuntime('bun', [entry], directory, 'bun'));
  }
  if (process.argv.includes('--native') || process.argv.includes('--native-only')) {
    const isolated = join(directory, 'isolated'); mkdirSync(isolated);
    const bunBinary = join(isolated, 'adoption-bun');
    execFileSync('bun', ['build', '--compile', entry, '--outfile', bunBinary], { cwd: directory, stdio: 'pipe' });
    const bundled = join(directory, 'adoption.cjs');
    await build({ entryPoints: [entry], outfile: bundled, bundle: true, platform: 'node', format: 'cjs', external: ['bun:sqlite'], logLevel: 'silent' });
    const config = join(directory, 'sea.json'), blob = join(directory, 'sea.blob');
    writeFileSync(config, JSON.stringify({ main: bundled, output: blob, disableExperimentalSEAWarning: true, useCodeCache: false, useSnapshot: false }));
    execFileSync(process.execPath, ['--experimental-sea-config', config], { stdio: 'pipe' });
    const nodeBinary = join(isolated, 'adoption-node'); copyFileSync(process.execPath, nodeBinary);
    execFileSync('npx', ['--yes', 'postject@1.0.0-alpha.6', nodeBinary, 'NODE_SEA_BLOB', blob,
      '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'], { stdio: 'pipe' });
    // Remove every source and module lookup path before executing either binary.
    rmSync(join(directory, 'node_modules'));
    for (const name of ['adoption.js', 'adoption-model.js', 'adoption-fixture.js', 'journey.js', 'adoption-rows.js', 'journey-entry.js', 'adoption.cjs']) rmSync(join(directory, name));
    report.push({ ...qualifyAdoptionRuntime(bunBinary, [], isolated, 'bun-executable'), binaryBytes: statSync(bunBinary).size });
    report.push({ ...qualifyAdoptionRuntime(nodeBinary, [], isolated, 'node-executable'), binaryBytes: statSync(nodeBinary).size });
  }
  const files = ['scripts/check-adoption-journeys.js', 'scripts/lib/adoption-journey.js', 'test/consumer/journey.js',
    'packages/website/src/examples/adoption.js', 'packages/website/src/examples/adoption-model.js', 'packages/website/src/examples/adoption-fixture.js',
    'packages/db/src/jobs.js', 'packages/db/src/store.js'];
  const result = { format: 'jaren-adoption-hosts/1', freezeHash: manifest.freezeHash, platform: process.platform, arch: process.arch,
    sourceHashes: Object.fromEntries(files.map((file) => [file, adoptionHash(readFileSync(join(root, file)))])), report };
  if (process.argv.includes('--write')) writeFileSync(join(root, 'benchmark/adoption-hosts-result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
}
finally { rmSync(directory, { recursive: true, force: true }); }
