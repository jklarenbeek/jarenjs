//@ts-check
/**
 * @file The validator's first-calls tables: Jaren and Ajv each validate
 * one official JSON-Schema-Test-Suite group's tests over their first calls
 * in a fresh process, before either engine has settled. The validator's
 * own rows (benchmark/profiler.js) are timed after 2,000 untimed passes;
 * these are the passes before them. One call validates every test of the
 * group once, as one profiler pass does. Each cell is a fresh child of
 * this script, the median of three (see benchmark/lib/first-calls.js).
 *
 * Usage:
 *   node benchmark/validate-first-calls.js [--output json --filepath FILE]
 */

import { readFileSync, writeFileSync } from 'node:fs';

import { loadRemoteJson } from './loader.js';
import { TestRunner } from './runner.js';
import * as ajv from './adaptors/ajv.js';
import * as jaren from './adaptors/jaren.js';
import { firstCallsCell, measureFirstCalls, runFirstCallsCell } from './lib/first-calls.js';
import { formatNs } from './lib/fmt.js';

const DRAFT = 'draft2020-12';
const FIRST_CALLS = [1_000, 10_000];
const FIRST_CASES = [
  { key: 'properties', name: 'properties — object properties validation', file: 'properties', group: 0 },
  { key: 'ref', name: 'ref — relative pointer ref to object', file: 'ref', group: 1 },
  { key: 'oneOf', name: 'oneOf — oneOf with base schema', file: 'oneOf', group: 1 },
  { key: 'unevaluated', name: 'unevaluatedProperties — unevaluatedProperties schema', file: 'unevaluatedProperties', group: 1 },
];
const ADAPTORS = { jaren, ajv };
const FIRST_ENGINES = [
  { key: 'jaren', label: 'Jaren' },
  { key: 'ajv', label: 'Ajv' },
];

/** The group's schema compiled by one engine, untimed; one call validates each of its tests. */
async function firstCallsOp(caseKey, engineKey) {
  const c = FIRST_CASES.find((x) => x.key === caseKey);
  const group = JSON.parse(readFileSync(new URL(`./suite/tests/${DRAFT}/${c.file}.json`, import.meta.url), 'utf8'))[c.group];
  const remotes = await loadRemoteJson();
  TestRunner.load(remotes);
  const adaptor = ADAPTORS[engineKey];
  const validator = adaptor.setup(adaptor.loader(DRAFT, remotes), group.schema, c.file);
  const data = group.tests.map((t) => t.data);
  return { op: () => { for (const item of data) adaptor.run(validator, item); } };
}

const cell = firstCallsCell();
if (cell !== null) {
  await runFirstCallsCell(cell, firstCallsOp, FIRST_CALLS);
  process.exit(0);
}

const args = process.argv.slice(2);
const output = args.includes('--output') ? args[args.indexOf('--output') + 1] : 'console';
const filepath = args.includes('--filepath') ? args[args.indexOf('--filepath') + 1] : null;

const firstCalls = measureFirstCalls(import.meta.url, {
  operation: `one pass over a ${DRAFT} test group`,
  counts: FIRST_CALLS,
  cases: FIRST_CASES,
  engines: FIRST_ENGINES,
});
for (const t of firstCalls.tables) {
  console.log(`\n${t.title}`);
  for (const row of t.rows)
    console.log(`  ${row.name.padEnd(56)} ${row.results.map((ns, i) => `${FIRST_ENGINES[i].label} ${formatNs(ns)}`).join('   ')}`);
}
if (output === 'json') {
  const json = JSON.stringify({ date: new Date().toISOString(), node: process.version, firstCalls }, null, 2);
  if (filepath !== null) writeFileSync(filepath, json);
  else console.log(json);
}
