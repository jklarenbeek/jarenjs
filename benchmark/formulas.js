//@ts-check
/** Frozen source corpus and two portable workloads, with native overhead reported. */
import { readFileSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { createHash } from 'node:crypto';
import { adoptionRows } from '../scripts/lib/adoption.js';
import { qualifyFormulaSources, runFormulaConsumer, qualifyRuleCommand } from '../test/consumer/formulas.js';
import { openRuleExample, savedRule } from '../packages/website/src/examples/reviewed-rules.js';

const manifest = JSON.parse(readFileSync(new URL('../test/adoption/manifest.json', import.meta.url), 'utf8'));
const sources = JSON.parse(readFileSync(new URL('../test/adoption/fixtures/formulas.json', import.meta.url), 'utf8')).formulas;
const result = { format: 'jaren-formula-measurements/1', freezeHash: manifest.freezeHash,
  runnerHash: createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex'),
  runtime: { node: process.version, platform: process.platform, arch: process.arch, cpu: cpus()[0].model },
  scope: 'Synthetic public APIs only. Static arithmetic is faster; native costs include compilation, immutable snapshots, bounded outcomes and dependency memoization. Real saved-corpus, manual and physical-device acceptance remains pending.',
  sources: await qualifyFormulaSources(sources), consumers: manifest.consumers.map((definition) => runFormulaConsumer(definition, adoptionRows(definition))),
  command: await qualifyRuleCommand(openRuleExample, savedRule) };
writeFileSync(new URL('./formula-result.json', import.meta.url), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
