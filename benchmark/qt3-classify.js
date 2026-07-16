#!/usr/bin/env node

/**
 * QT3 test-case classifier for the QT3 compliance harness.
 *
 * Assigns every converted QT3 test case a tier, decided from converted
 * metadata alone (before anything runs):
 *
 * - tier C ("out of scope", never run): dependencies on XML/XSD machinery
 *   the JSON engine cannot have (schema awareness/import, higher-order
 *   functions, modules, serialization, static typing, ...), environments
 *   with XML source documents or collections, XML-shaped result assertions
 *   (assert-xml, serialization-matches, ...), and spec dependencies that
 *   exclude XQuery/XPath 3.1.
 * - tier A ("applicable"): everything else. Tier-A cases are runnable and
 *   are sub-bucketed at runtime by benchmark/qt3-runner.js (pass /
 *   unsupported-syntax / fail-by-design / fail).
 *
 * The classification logic is importable by the runner; invoking this file
 * directly prints tier counts per test set:
 *
 *   node benchmark/qt3-classify.js [--verbose]
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const QT3_JSON_DIR = path.join(__dirname, 'qt3-json');

//#region classification rules

// Spec tokens that admit XQuery/XPath 3.1: the exact 3.1 specs plus any
// "or later" (+-suffixed) XQuery/XPath spec at or below 3.1. XSLT tokens
// (XT30+) never admit - the front-end parses XQuery/XPath text only - but
// a spec list is a disjunction, so XT30+ alongside XQ31+ is fine.
function specTokenAdmits31(token) {
  return token === 'XQ31' || token === 'XP31'
    || /^(XQ|XP)(10|20|30|31)\+$/.test(token);
}

function specAdmits31(value) {
  return String(value).trim().split(/\s+/).some(specTokenAdmits31);
}

// Every QT3 feature names a capability outside the JSON engine's scope
// (schema awareness, higher-order functions, module import, serialization,
// XSLT interop, collations, collections, DTDs, ...). A test that requires
// any feature is tier C; a test that requires a feature to be *absent*
// (satisfied="false") matches this implementation and stays applicable.
function dependencyExcludes(dep) {
  switch (dep.type) {
    case 'spec':
      return specAdmits31(dep.value) ? null : `spec ${dep.value}`;
    case 'feature':
      return dep.satisfied === 'false' ? null : `feature ${dep.value}`;
    default:
      // xml-version, xsd-version, unicode-version/-normalization-form,
      // language, default-language, limits, calendar,
      // format-integer-sequence: all XML/XSD/i18n machinery out of scope
      return `${dep.type} ${dep.value}`;
  }
}

// Environment content that injects XML documents or other node-model
// state. Namespace declarations (the map/array function namespaces) and
// decimal formats are harmless; params are judged at runtime (a param
// whose value is not JSON-representable reclassifies the case to C).
const ENVIRONMENT_XML_TAGS = ['source', 'collection', 'schema', 'resource', 'collation', 'context-item'];

function environmentExcludes(env) {
  if (env === undefined)
    return null;
  for (const tag of ENVIRONMENT_XML_TAGS) {
    if (env[tag] !== undefined && env[tag].length > 0)
      return `environment ${tag}`;
  }
  return null;
}

// Result assertions that compare XML or serialized output.
const XML_ASSERTION_KINDS = new Set([
  'assert-xml', 'serialization-matches', 'assert-serialization-error', 'assert-serialization',
]);

function assertionExcludes(assertion) {
  if (assertion === undefined)
    return 'missing result assertion';
  if (XML_ASSERTION_KINDS.has(assertion.kind))
    return `assertion ${assertion.kind}`;
  for (const child of assertion.children ?? []) {
    const reason = assertionExcludes(child);
    if (reason !== null)
      return reason;
  }
  return null;
}

//#endregion

//#region public API

/**
 * Resolve a test case's environment: an inline environment is used as is,
 * a `{ ref }` is looked up in the test set first, then in the catalog
 * (index.json) environments. Returns undefined when the case has none.
 */
export function resolveEnvironment(testCase, testSet, catalogEnvironments) {
  const env = testCase.environment;
  if (env === undefined)
    return undefined;
  if (env.ref === undefined)
    return env;
  return testSet.environments?.[env.ref] ?? catalogEnvironments?.[env.ref];
}

/**
 * Classify one converted QT3 test case, using only converted metadata.
 * @returns {{ tier: 'A' } | { tier: 'C', reason: string }}
 */
export function classifyCase(testCase, testSet, catalogEnvironments) {
  for (const dep of [...(testSet.dependencies ?? []), ...(testCase.dependencies ?? [])]) {
    const reason = dependencyExcludes(dep);
    if (reason !== null)
      return { tier: 'C', reason };
  }

  if (testCase.modules !== undefined && testCase.modules.length > 0)
    return { tier: 'C', reason: 'module import' };

  const env = resolveEnvironment(testCase, testSet, catalogEnvironments);
  if (testCase.environment !== undefined && env === undefined)
    return { tier: 'C', reason: `unresolved environment ref '${testCase.environment.ref}'` };
  const envReason = environmentExcludes(env);
  if (envReason !== null)
    return { tier: 'C', reason: envReason };

  const assertReason = assertionExcludes(testCase.result);
  if (assertReason !== null)
    return { tier: 'C', reason: assertReason };

  return { tier: 'A' };
}

/**
 * Load the converted suite (index + every test set) from qt3-json/.
 * Exits with init instructions when the conversion has not been run.
 */
export function loadConvertedSuite() {
  const indexPath = path.join(QT3_JSON_DIR, 'index.json');
  if (!fs.existsSync(indexPath)) {
    console.error(`Converted QT3 suite not found at ${indexPath}.`);
    console.error('Initialize the submodule and convert it first:');
    console.error('  git submodule update --init benchmark/qt3tests');
    console.error('  npm run qt3:convert');
    process.exit(2);
  }
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  const sets = index.sets.map((entry) =>
    JSON.parse(fs.readFileSync(path.join(QT3_JSON_DIR, entry.file), 'utf8')));
  return { index, sets };
}

//#endregion

//#region cli

function main() {
  const verbose = process.argv.includes('--verbose');
  const { index, sets } = loadConvertedSuite();
  const reasons = new Map();
  let tierA = 0;
  let tierC = 0;
  for (const set of sets) {
    let setA = 0;
    for (const testCase of set.testCases) {
      const c = classifyCase(testCase, set, index.environments);
      if (c.tier === 'A') {
        tierA++;
        setA++;
      }
      else {
        tierC++;
        const key = c.reason.split(' ')[0] + ' ' + (c.reason.split(' ')[1] ?? '');
        reasons.set(key, (reasons.get(key) ?? 0) + 1);
      }
    }
    if (verbose && setA > 0)
      console.log(`${set.name}: ${setA}/${set.testCases.length} applicable`);
  }
  console.log(`\ntier A (applicable):   ${tierA}`);
  console.log(`tier C (out of scope): ${tierC}`);
  console.log('\ntier C reasons:');
  for (const [reason, count] of [...reasons.entries()].sort((a, b) => b[1] - a[1]))
    console.log(`  ${String(count).padStart(6)}  ${reason}`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href)
  main();

//#endregion
