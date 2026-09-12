//@ts-check
/** Fresh-process import costs. RSS deltas are observations, not an application budget. */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cpus } from 'node:os';
const root = fileURLToPath(new URL('../', import.meta.url));
const entry = fileURLToPath(import.meta.url);
if (process.argv[2] === '--probe') {
  const require = createRequire(join(process.argv[3], 'package.json'));
  globalThis.gc();
  const before = process.memoryUsage();
  const start = performance.now();
  for (const specifier of JSON.parse(process.argv[4])) await import(pathToFileURL(require.resolve(specifier)).href);
  const elapsedMs = performance.now() - start;
  globalThis.gc();
  const after = process.memoryUsage();
  console.log(JSON.stringify({ elapsedMs, rssBytes: after.rss, rssDeltaBytes: after.rss - before.rss, heapDeltaBytes: after.heapUsed - before.heapUsed }));
}
else {
  const args = process.argv.slice(2);
  const samplesAt = args.indexOf('--samples'), baselineAt = args.indexOf('--baseline');
  const samples = samplesAt < 0 ? 3 : Number(args[samplesAt + 1]);
  if (!Number.isSafeInteger(samples) || samples < 3) throw new Error('samples must be an integer >= 3');
  const variants = [
    ...(baselineAt < 0 ? [] : [{ name: 'published-root', directory: args[baselineAt + 1], imports: ['@jarenjs/db'] }]),
    { name: 'candidate-root', directory: root, imports: ['@jarenjs/db'] },
    { name: 'candidate-engines', directory: root, imports: ['@jarenjs/db/query', '@jarenjs/db/model', '@jarenjs/db/entity'] },
    { name: 'candidate-relational', directory: root, imports: ['@jarenjs/db/relational'] },
  ];
  const measured = variants.map((variant) => {
    const runs = Array.from({ length: samples }, () => {
      const result = spawnSync(process.execPath, ['--expose-gc', entry, '--probe', variant.directory, JSON.stringify(variant.imports)], { encoding: 'utf8' });
      if (result.status !== 0) throw new Error(result.stderr);
      return JSON.parse(result.stdout);
    });
    return { name: variant.name, imports: variant.imports, samples: runs,
      median: Object.fromEntries(Object.keys(runs[0]).map((key) => [key, runs.map((run) => run[key]).sort((a, b) => a - b)[Math.floor(runs.length / 2)]])) };
  });
  const report = { node: process.version, platform: process.platform, cpu: cpus()[0].model,
    candidateVersion: JSON.parse(readFileSync(join(root, 'packages/db/package.json'), 'utf8')).version,
    measurements: measured, limitation: 'Fresh-process import deltas only; application RSS and allocations during queries are separate measurements.' };
  if (args.includes('--write')) writeFileSync(new URL('relational-imports-result.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
