//@ts-check
/** Final comparison consumes the recorded scopes without rerunning unrelated censuses. */
import { readFileSync, writeFileSync } from 'node:fs';
import { summarizeAdoption } from '../scripts/lib/adoption-program.js';
import { readAdoption, verifyFreeze, adoptionHash } from '../test/adoption/evidence.js';

if (process.argv.slice(2).some((arg) => !['--final', '--write'].includes(arg))) throw new Error('Usage: node benchmark/adoption.js --final [--write]');
const manifest = readAdoption('manifest.json'); verifyFreeze(manifest);
const names = ['adoption', 'adoption-journey', 'relational', 'collection', 'lexical', 'formula', 'providers'];
const reports = Object.fromEntries(names.map((name) => [name, JSON.parse(readFileSync(new URL(`${name}-result.json`, import.meta.url), 'utf8'))]));
const files = [...names.map((name) => `benchmark/${name}-result.json`), 'benchmark/adoption-hosts-result.json',
  'benchmark/durable-result.json', 'benchmark/adoption-program.js', 'scripts/lib/adoption-program.js'];
const report = { ...summarizeAdoption(manifest, reports),
  sourceHashes: Object.fromEntries(files.map((file) => [file, adoptionHash(readFileSync(new URL(`../${file}`, import.meta.url)))])),
  limitations: [
    'Focused metrics keep their original workload and host scope. Resources are compared on the combined journey, never chosen from a cheaper focused leg.',
    'Provider pages/rows/bytes measure complete synthetic ingestion; attempts per request remain unmeasured here. Recovery resends cover the terminated catalog fixture.',
    'Pending means no matching measurement in this scope, even when a focused test or another host passes. Exact combined peak heap and host-wide remaining handles are pending.',
    'Linux executables and automated browser composition do not establish other operating systems, PostgreSQL, native OS IME, assistive technology, real providers or downstream approval.',
    'Original saved sources and all retained oracles remain. Library readiness never authorizes their deletion.',
  ] };
if (process.argv.includes('--write')) writeFileSync(new URL('adoption-program-result.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
