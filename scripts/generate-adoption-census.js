//@ts-check
/** The frozen adoption baseline stays immutable; this overlay names current owners. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const original = JSON.parse(readFileSync(join(root, 'test/adoption/source-census.json'), 'utf8'));
const families = original.families.map(family => {
  if (!existsSync(join(root, family.path))) {
    if (family.path !== 'packages/ai/src/retry.js') throw new Error(`Unaccounted source family: ${family.path}`);
    return { category: family.category, originalPath: family.path, disposition: 'moved', owner: '@tangleai/models/retry', reason: 'Model transport retry belongs to Tangle; generic concurrency and provider execution remain in Jaren.' };
  }
  const pattern = new RegExp(family.pattern);
  const matches = readFileSync(join(root, family.path), 'utf8').split(/\r?\n/)
    .flatMap((line, index) => pattern.test(line) ? [`${index + 1}:${line}`] : []);
  if (matches.length === 0) throw new Error(`Source family no longer matches: ${family.path}`);
  return { ...family, matches, disposition: 'retained' };
});
const value = JSON.stringify({ historicalSource: 'test/adoption/source-census.json', historicalRevision: original.revision,
  note: 'The original source census remains frozen evidence. This overlay is regenerated from the current source tree.', families }, null, 2) + '\n';
const path = join(root, 'test/adoption/current-source-census.json');
if (process.argv.includes('--check')) {
  if (!existsSync(path) || readFileSync(path, 'utf8') !== value) throw new Error('Current adoption source census drift; run node scripts/generate-adoption-census.js');
}
else writeFileSync(path, value);
