#!/usr/bin/env node

/**
 * QT3 compliance runner: a tiered scorecard for the Jaren JSON Query
 * engine, driven through its XQuery text front-end.
 *
 * Runs every tier-A (applicable, see benchmark/qt3-classify.js) test case
 * of the converted W3C QT3 suite: parseXQuery -> compileJsonQuery -> run
 * with externals from the environment's params -> evaluate the QT3 result
 * assertions in JS. Every case lands in exactly one bucket:
 *
 * - pass
 * - unsupported-syntax: the front-end rejected the query (or an assertion
 *   expression) with an `unsupported ...` XQuerySyntaxError. Measures
 *   front-end subset coverage, not engine correctness; counted separately
 *   from failures.
 * - fail-by-design: failing and listed in benchmark/qt3-baseline.json with
 *   a deviation id (D1 doubles, D5 regex, D6 positions, ...).
 * - known-bug: failing and listed in the baseline as a bug.
 * - fail: failing and NOT in the baseline - the regression signal; any
 *   such case makes the exit code nonzero (CI-friendly).
 * - reclassified-C: metadata said applicable but the case turned out to
 *   depend on non-JSON values (params or assert-type types outside the
 *   JSON model); counted with tier C.
 *
 * Usage:
 *   node benchmark/qt3-runner.js                 # full scorecard
 *   node benchmark/qt3-runner.js map-size        # only sets/cases whose name contains the string
 *   node benchmark/qt3-runner.js --verbose       # per-set table + every failure in detail
 *   node benchmark/qt3-runner.js --seed-baseline # write qt3-baseline.seed.json for triage
 *   node benchmark/qt3-runner.js --dump out.json # dump per-case results as JSON
 *
 * See benchmark/qt3-README.md for the harness guide and baseline workflow.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

import { equalsJson } from '@jarenjs/core/object';
import { compileJsonQuery } from '@jarenjs/json';
import { parseXQuery, XQuerySyntaxError } from '@jarenjs/json/xquery';

import { classifyCase, resolveEnvironment, loadConvertedSuite } from './qt3-classify.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = path.join(__dirname, 'qt3-baseline.json');
const SEED_PATH = path.join(__dirname, 'qt3-baseline.seed.json');

//#region error classification

// Pseudo-code for a plain (non-`unsupported`) XQuerySyntaxError: the
// front-end's static syntax error, our XPST0003 analogue.
const SYNTAX = 'SYNTAX';

// Expected QT3 error code -> acceptable harness codes, from the mapping
// column of QUERY-FORMAT.md section 10 (XQuery analogues), read in reverse.
// FORG0001/FORX000x fold into JQ2001 per the spec's cast and regex rules;
// XPST0008 also admits JQ2006 because the engine is open-world (unbound
// variables are externals, detected at run time, QUERY-FORMAT.md section 9).
// XQDY0137 (duplicate map key), XQST0089 (duplicate range variable), and
// XQST0049 (duplicate variable declaration) are made static by the
// front-end, so SYNTAX satisfies them too.
const ERROR_CODE_MAP = {
  XPST0003: [SYNTAX, 'JQ0001', 'JQ0003', 'JQ0004'],
  XPST0017: ['JQ0002'],
  XPST0008: ['JQ0005', 'JQ2006'],
  XQST0031: ['JQ0006'],
  XQST0049: [SYNTAX],
  XQST0089: [SYNTAX, 'JQ0007'],
  XQDY0137: [SYNTAX],
  XPTY0004: ['JQ2001', 'JQ2004', 'JQ2005'],
  FOTY0014: ['JQ2001'], // fn:string of a function item ~ $string of an array/object
  FORG0001: ['JQ2001'],
  FORG0006: ['JQ2001', 'JQ2003'],
  FOAR0001: ['JQ2002'],
  FORX0002: ['JQ2001'],
  FORX0003: ['JQ2001'],
  XPDY0002: ['JQ2006'],
  XPDY0130: ['JQ2007'],
};

const UNSUPPORTED_RE = /^Invalid XQuery: (unsupported[^]*?) at position \d+ in /;

/** The `unsupported ...` detail of an XQuerySyntaxError, or null. */
function unsupportedDetail(e) {
  if (!(e instanceof XQuerySyntaxError))
    return null;
  const m = UNSUPPORTED_RE.exec(e.message);
  return m === null ? null : m[1];
}

function errorMatches(expectedCode, thrownCode) {
  if (expectedCode === '*')
    return thrownCode !== null;
  const accepted = ERROR_CODE_MAP[expectedCode];
  return accepted !== undefined && accepted.includes(thrownCode);
}

//#endregion

//#region bootstrapped evaluation

// Verdicts flow through the assertion tree; see combine rules below.
const PASS = { verdict: 'pass' };
const fail = (reason) => ({ verdict: 'fail', reason });
const unsupported = (detail) => ({ verdict: 'unsupported', detail });
const reclassify = (reason) => ({ verdict: 'reclassify', reason });

/**
 * Evaluate an XQuery expression (a test query, an expected value of
 * assert-eq/deep-eq/permutation, or a param select) to its full result
 * sequence, faithfully: the parsed document is wrapped in a JSON array
 * constructor, which flattens the expression's sequence into the members
 * of one array (QUERY-FORMAT.md section 3.4) - so `items` is exactly the
 * sequence, with no singleton/array ambiguity.
 * @returns {{ items: any[] } | { thrown: string, message: string }
 *   | { verdict: 'unsupported', detail: string }}
 */
function evalSequence(text, externals) {
  let parsed;
  try {
    parsed = parseXQuery(text);
  }
  catch (e) {
    const detail = unsupportedDetail(e);
    if (detail !== null)
      return unsupported(detail);
    if (e instanceof XQuerySyntaxError)
      return { thrown: SYNTAX, message: e.message };
    throw e;
  }
  try {
    const query = compileJsonQuery([parsed]);
    return { items: query(null, externals) };
  }
  catch (e) {
    if (e.name === 'JsonQueryCompileError' || e.name === 'JsonQueryRuntimeError')
      return { thrown: e.code, message: e.message };
    return { thrown: 'CRASH', message: `${e.name}: ${e.message}` };
  }
}

/**
 * Evaluate a QT3 `assert` expression: `$result` is bound to the test
 * result sequence (via a `$let` over an array-typed external - the
 * bootstrap), and the assertion passes iff the expression's effective
 * boolean value is true (the `$boolean` wrapper).
 */
function evalAssertExpression(text, items, externals) {
  let parsed;
  try {
    parsed = parseXQuery(text);
  }
  catch (e) {
    const detail = unsupportedDetail(e);
    if (detail !== null)
      return unsupported(detail);
    if (e instanceof XQuerySyntaxError)
      return fail(`assert expression is invalid: ${e.message}`);
    throw e;
  }
  const doc = { $let: { result: '$__qt3_result[*]' }, $return: { $boolean: parsed } };
  try {
    const query = compileJsonQuery(doc);
    const value = query(null, { ...externals, __qt3_result: items });
    return value === true ? PASS : fail(`assert '${text}' evaluated to ${JSON.stringify(value)}`);
  }
  catch (e) {
    if (e.name === 'JsonQueryCompileError' || e.name === 'JsonQueryRuntimeError')
      return fail(`assert '${text}' raised ${e.code}`);
    return fail(`assert '${text}' crashed: ${e.message}`);
  }
}

//#endregion

//#region assertion evaluation

// String value of one item, per the engine's $string cast table
// (QUERY-FORMAT.md section 8.10). Arrays and objects are not castable
// (JQ2001 there), so they yield null and the assertion fails. Note the
// JS number serialization: 'Infinity' (not XDM's 'INF') and exponent
// forms like '1e+21' - divergences land in the baseline under D1.
function stringValueOf(item) {
  switch (typeof item) {
    case 'string': return item;
    case 'number': return String(item);
    case 'boolean': return item ? 'true' : 'false';
    default: return item === null ? 'null' : null;
  }
}

const normalizeSpace = (s) => s.replace(/[ \t\r\n]+/g, ' ').replace(/^ | $/g, '');

// assert-type: QT3 sequence types mapped coarsely onto the JSON model.
// Types outside the table (dates, durations, QNames, node and function
// types, parameterized map/array types) have no JSON counterpart: the
// case is reclassified to tier C.
const ITEM_TYPE_PREDICATES = {
  'xs:integer': (v) => typeof v === 'number' && Number.isInteger(v),
  'xs:decimal': (v) => typeof v === 'number' && Number.isFinite(v),
  'xs:double': (v) => typeof v === 'number',
  'xs:float': (v) => typeof v === 'number',
  'xs:numeric': (v) => typeof v === 'number',
  'xs:string': (v) => typeof v === 'string',
  'xs:boolean': (v) => typeof v === 'boolean',
  'xs:anyAtomicType': (v) => v === null || typeof v !== 'object',
  'map(*)': (v) => typeof v === 'object' && v !== null && !Array.isArray(v),
  'array(*)': (v) => Array.isArray(v),
  'item()': () => true,
};

function evalAssertType(items, typeText) {
  let type = typeText.trim();
  if (type === 'empty-sequence()')
    return items.length === 0 ? PASS : fail(`expected empty-sequence(), got ${items.length} item(s)`);

  let minCount = 1;
  let maxCount = 1;
  const last = type[type.length - 1];
  if ((last === '?' || last === '*' || last === '+') && !type.endsWith('(*)')) {
    if (last === '?')
      minCount = 0;
    else if (last === '*') {
      minCount = 0;
      maxCount = Infinity;
    }
    else
      maxCount = Infinity;
    type = type.slice(0, -1).trim();
  }

  const predicate = ITEM_TYPE_PREDICATES[type];
  if (predicate === undefined)
    return reclassify(`assert-type '${typeText}' outside the JSON model`);
  if (items.length < minCount || items.length > maxCount)
    return fail(`expected ${typeText}, got ${items.length} item(s)`);
  return items.every(predicate)
    ? PASS
    : fail(`expected ${typeText}, got ${JSON.stringify(items)}`);
}

function multisetEquals(actual, expected) {
  if (actual.length !== expected.length)
    return false;
  const used = new Array(expected.length).fill(false);
  outer: for (const item of actual) {
    for (let i = 0; i < expected.length; i++) {
      if (!used[i] && equalsJson(item, expected[i])) {
        used[i] = true;
        continue outer;
      }
    }
    return false;
  }
  return true;
}

/**
 * Evaluate one converted QT3 assertion node against the outcome of the
 * test query. `ctx` is `{ items, thrown, thrownMessage, externals }`:
 * exactly one of `items` (the result sequence as an array) and `thrown`
 * (a JQxxxx / SYNTAX / CRASH code string) is non-null.
 * @returns {{ verdict: 'pass'|'fail'|'unsupported'|'reclassify', ... }}
 */
function evalAssertion(assertion, ctx) {
  const { kind } = assertion;

  if (kind === 'any-of') {
    let softest = null; // unsupported > reclassify > fail
    for (const child of assertion.children) {
      const result = evalAssertion(child, ctx);
      if (result.verdict === 'pass')
        return result;
      if (result.verdict === 'unsupported' || (result.verdict === 'reclassify' && softest?.verdict !== 'unsupported') || softest === null)
        softest = result;
    }
    return softest ?? fail('empty any-of');
  }
  if (kind === 'all-of') {
    let softest = null;
    for (const child of assertion.children) {
      const result = evalAssertion(child, ctx);
      if (result.verdict === 'fail')
        return result;
      if (result.verdict !== 'pass' && (softest === null || result.verdict === 'unsupported'))
        softest = result;
    }
    return softest ?? PASS;
  }
  if (kind === 'not') {
    const result = evalAssertion(assertion.children[0], ctx);
    if (result.verdict === 'pass')
      return fail('negated assertion passed');
    if (result.verdict === 'fail')
      return PASS;
    return result;
  }

  if (kind === 'error') {
    if (ctx.thrown === null)
      return fail(`expected error ${assertion.code}, got a result`);
    return errorMatches(assertion.code, ctx.thrown)
      ? PASS
      : fail(`expected error ${assertion.code}, got ${ctx.thrown}: ${ctx.thrownMessage}`);
  }
  if (ctx.thrown !== null)
    return fail(`expected a result, got ${ctx.thrown}: ${ctx.thrownMessage}`);

  const { items, externals } = ctx;
  switch (kind) {
    case 'assert-true':
      return items.length === 1 && items[0] === true ? PASS : fail(`expected true, got ${JSON.stringify(items)}`);
    case 'assert-false':
      return items.length === 1 && items[0] === false ? PASS : fail(`expected false, got ${JSON.stringify(items)}`);
    case 'assert-empty':
      return items.length === 0 ? PASS : fail(`expected (), got ${items.length} item(s)`);
    case 'assert-count': {
      const expected = Number(assertion.value);
      return items.length === expected ? PASS : fail(`expected count ${expected}, got ${items.length}`);
    }
    case 'assert-eq': {
      const expected = evalSequence(assertion.value, externals);
      if (expected.verdict === 'unsupported')
        return expected;
      if (expected.thrown !== undefined)
        return fail(`expected value '${assertion.value}' raised ${expected.thrown}`);
      if (items.length !== 1 || expected.items.length !== 1)
        return fail(`eq needs singletons: got ${items.length} vs ${expected.items.length} item(s)`);
      return equalsJson(items[0], expected.items[0])
        ? PASS
        : fail(`expected ${JSON.stringify(expected.items[0])}, got ${JSON.stringify(items[0])}`);
    }
    case 'assert-deep-eq': {
      const expected = evalSequence(assertion.value, externals);
      if (expected.verdict === 'unsupported')
        return expected;
      if (expected.thrown !== undefined)
        return fail(`expected value '${assertion.value}' raised ${expected.thrown}`);
      if (items.length === expected.items.length && items.every((item, i) => equalsJson(item, expected.items[i])))
        return PASS;
      return fail(`expected ${JSON.stringify(expected.items)}, got ${JSON.stringify(items)}`);
    }
    case 'assert-permutation': {
      const expected = evalSequence(assertion.value, externals);
      if (expected.verdict === 'unsupported')
        return expected;
      if (expected.thrown !== undefined)
        return fail(`expected value '${assertion.value}' raised ${expected.thrown}`);
      return multisetEquals(items, expected.items)
        ? PASS
        : fail(`expected a permutation of ${JSON.stringify(expected.items)}, got ${JSON.stringify(items)}`);
    }
    case 'assert-string-value': {
      const parts = items.map(stringValueOf);
      if (parts.includes(null))
        return fail('result contains an array or object (no string value in the JSON model)');
      let actual = parts.join(' ');
      let expected = assertion.value ?? '';
      if (assertion.attrs?.['normalize-space'] === 'true') {
        actual = normalizeSpace(actual);
        expected = normalizeSpace(expected);
      }
      return actual === expected ? PASS : fail(`expected string value ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
    case 'assert-type':
      return evalAssertType(items, assertion.value ?? '');
    case 'assert':
      return evalAssertExpression(assertion.value ?? '', items, externals);
    default:
      // classifier keeps XML/serialization kinds out of tier A
      return fail(`unhandled assertion kind '${kind}'`);
  }
}

//#endregion

//#region case runner

/**
 * Resolve an environment's params to an externals object. Params whose
 * select expression is missing, not parseable, not evaluable, or not a
 * singleton are not JSON-representable: the case reclassifies to tier C.
 * @returns {{ externals: object } | { verdict: 'reclassify', reason }}
 */
export function resolveExternals(env) {
  const externals = {};
  if (env === undefined)
    return { externals };
  for (const param of env.param ?? []) {
    if (param.select === undefined || param.source !== undefined)
      return reclassify(`param $${param.name} has no JSON-representable value`);
    const result = evalSequence(param.select, {});
    if (result.verdict === 'unsupported' || result.thrown !== undefined)
      return reclassify(`param $${param.name} select '${param.select}' is not JSON-representable`);
    if (result.items.length !== 1)
      return reclassify(`param $${param.name} is not a singleton`);
    externals[param.name] = result.items[0];
  }
  return { externals };
}

/**
 * Run one tier-A case end to end.
 * @returns {{ verdict: 'pass'|'fail'|'unsupported'|'reclassify', ... }}
 */
export function runCase(testCase, externals) {
  const outcome = evalSequence(testCase.test, externals);
  if (outcome.verdict === 'unsupported')
    return outcome;
  const ctx = outcome.thrown !== undefined
    ? { items: null, thrown: outcome.thrown, thrownMessage: outcome.message, externals }
    : { items: outcome.items, thrown: null, thrownMessage: null, externals };
  if (ctx.thrown === 'CRASH')
    return fail(`engine crashed: ${ctx.thrownMessage}`);
  return evalAssertion(testCase.result, ctx);
}

//#endregion

//#region reporting

function loadBaseline() {
  if (!fs.existsSync(BASELINE_PATH))
    return { summary: {}, tests: {} };
  const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
  return { summary: baseline.summary ?? {}, tests: baseline.tests ?? {} };
}

function pad(str, width) {
  return String(str).padEnd(width);
}

function padLeft(str, width) {
  return String(str).padStart(width);
}

function main() {
  const options = { filter: null, verbose: false, seed: false, dump: null };
  const argv = process.argv;
  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case '--verbose': case '-v': options.verbose = true; break;
      case '--seed-baseline': options.seed = true; break;
      case '--dump': options.dump = argv[++i]; break;
      case '--help': case '-h':
        console.log('Usage: node benchmark/qt3-runner.js [filter] [--verbose] [--seed-baseline] [--dump file.json]');
        return;
      default:
        if (argv[i].startsWith('--')) {
          console.error(`Unknown option: ${argv[i]}`);
          process.exit(2);
        }
        options.filter = argv[i];
    }
  }

  const { index, sets } = loadConvertedSuite();
  const baseline = loadBaseline();

  const buckets = {
    tierC: 0, reclassified: 0, pass: 0, unsupported: 0,
    deviation: 0, knownBug: 0, fail: 0,
  };
  const deviationCounts = new Map();
  const unsupportedCounts = new Map();
  const regressions = [];
  const surprises = [];
  const records = [];
  const perSet = [];
  const externalsCache = new Map();
  let total = 0;

  for (const set of sets) {
    const setMatches = options.filter === null || set.name.includes(options.filter);
    const setRow = { name: set.name, total: 0, pass: 0, unsupported: 0, fail: 0 };

    for (const testCase of set.testCases) {
      if (!setMatches && !testCase.name.includes(options.filter))
        continue;
      total++;

      const classified = classifyCase(testCase, set, index.environments);
      if (classified.tier === 'C') {
        buckets.tierC++;
        records.push({ set: set.name, name: testCase.name, bucket: 'tier-C', detail: classified.reason });
        continue;
      }
      setRow.total++;

      const entry = baseline.tests[testCase.name];

      // baseline entries marked `skip` are fatal in-process (the engine
      // exhausts the heap materializing the sequence before its JQ2007
      // guard can fire) - counted under their baseline status, never run
      if (entry?.skip === true) {
        if (entry.status === 'deviation') {
          buckets.deviation++;
          deviationCounts.set(entry.id, (deviationCounts.get(entry.id) ?? 0) + 1);
        }
        else {
          buckets.knownBug++;
        }
        records.push({ set: set.name, name: testCase.name, bucket: entry.status === 'deviation' ? 'fail-by-design' : 'known-bug', detail: `skipped: ${entry.issue ?? entry.note ?? ''}` });
        continue;
      }

      const env = resolveEnvironment(testCase, set, index.environments);
      let resolved = externalsCache.get(env ?? null);
      if (resolved === undefined) {
        resolved = resolveExternals(env);
        externalsCache.set(env ?? null, resolved);
      }
      const result = resolved.verdict === 'reclassify' ? resolved : runCase(testCase, resolved.externals);
      let bucket;
      let detail;
      switch (result.verdict) {
        case 'pass':
          buckets.pass++;
          setRow.pass++;
          bucket = 'pass';
          if (entry !== undefined)
            surprises.push(testCase.name);
          break;
        case 'unsupported':
          buckets.unsupported++;
          setRow.unsupported++;
          bucket = 'unsupported-syntax';
          detail = result.detail;
          unsupportedCounts.set(result.detail, (unsupportedCounts.get(result.detail) ?? 0) + 1);
          break;
        case 'reclassify':
          buckets.reclassified++;
          bucket = 'reclassified-C';
          detail = result.reason;
          break;
        default: // fail
          detail = result.reason;
          if (entry?.status === 'deviation') {
            buckets.deviation++;
            bucket = 'fail-by-design';
            deviationCounts.set(entry.id, (deviationCounts.get(entry.id) ?? 0) + 1);
          }
          else if (entry?.status === 'bug') {
            buckets.knownBug++;
            bucket = 'known-bug';
          }
          else {
            buckets.fail++;
            setRow.fail++;
            bucket = 'fail';
            regressions.push({ set: set.name, name: testCase.name, test: testCase.test, reason: result.reason });
          }
          break;
      }
      records.push({ set: set.name, name: testCase.name, bucket, detail });
    }

    if (setRow.total > 0)
      perSet.push(setRow);
  }

  //#region output

  const tierA = total - buckets.tierC;
  console.log(`\nQT3 compliance scorecard - suite ${index.commit?.slice(0, 12) ?? '(unknown)'}, ${total} test cases${options.filter !== null ? ` (filter: '${options.filter}')` : ''}\n`);
  console.log(`tier C (out of scope, not run):    ${padLeft(buckets.tierC, 6)}`);
  console.log(`tier A (applicable):               ${padLeft(tierA, 6)}`);
  console.log(`  reclassified C at runtime:       ${padLeft(buckets.reclassified, 6)}   (non-JSON params / types)`);
  console.log(`  pass:                            ${padLeft(buckets.pass, 6)}`);
  console.log(`  unsupported-syntax:              ${padLeft(buckets.unsupported, 6)}   (front-end subset coverage)`);
  const deviationSummary = [...deviationCounts.entries()].sort().map(([id, n]) => `${id}: ${n}`).join(', ');
  console.log(`  fail-by-design (baseline):       ${padLeft(buckets.deviation, 6)}   ${deviationSummary === '' ? '' : `(${deviationSummary})`}`);
  console.log(`  known bugs (baseline):           ${padLeft(buckets.knownBug, 6)}`);
  console.log(`  FAIL (not in baseline):          ${padLeft(buckets.fail, 6)}   <- regressions`);

  if (options.verbose && unsupportedCounts.size > 0) {
    console.log('\ntop unsupported constructs:');
    for (const [detail, count] of [...unsupportedCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25))
      console.log(`  ${padLeft(count, 6)}  ${detail}`);
  }

  if (options.verbose && perSet.length > 0) {
    console.log(`\n${pad('test set', 44)}${padLeft('applicable', 12)}${padLeft('pass', 8)}${padLeft('unsup', 8)}${padLeft('fail', 8)}`);
    console.log('-'.repeat(80));
    for (const row of perSet)
      console.log(`${pad(row.name, 44)}${padLeft(row.total, 12)}${padLeft(row.pass, 8)}${padLeft(row.unsupported, 8)}${padLeft(row.fail, 8)}`);
  }

  if (surprises.length > 0) {
    console.log(`\n${surprises.length} surprise(s) - baseline entries that now pass (prune them from qt3-baseline.json):`);
    for (const name of surprises.slice(0, options.verbose ? Infinity : 20))
      console.log(`  ${name}`);
    if (!options.verbose && surprises.length > 20)
      console.log(`  ... and ${surprises.length - 20} more (use --verbose)`);
  }

  let failed = false;
  if (regressions.length > 0) {
    failed = true;
    console.log(`\n${regressions.length} REGRESSION(S) - tier-A failures not in the baseline:`);
    for (const r of regressions.slice(0, options.verbose ? Infinity : 25)) {
      console.log(`\n  [${r.set}] ${r.name}`);
      console.log(`    query: ${r.test.length > 200 ? r.test.slice(0, 200) + '...' : r.test}`);
      console.log(`    ${r.reason}`);
    }
    if (!options.verbose && regressions.length > 25)
      console.log(`\n  ... and ${regressions.length - 25} more (use --verbose)`);
  }

  // a full, unfiltered run is also held to the baseline's pass count, so
  // a pass -> unsupported/reclassified flip cannot slip through unnoticed
  if (options.filter === null && typeof baseline.summary.pass === 'number' && buckets.pass < baseline.summary.pass) {
    failed = true;
    console.log(`\nPASS-COUNT REGRESSION: ${buckets.pass} passing, baseline records ${baseline.summary.pass}.`);
  }

  if (options.dump !== null) {
    fs.writeFileSync(options.dump, JSON.stringify({ suite: index.commit, records }, null, 1) + '\n');
    console.log(`\nPer-case results written to ${options.dump}`);
  }

  if (options.seed) {
    const tests = {};
    for (const r of regressions.sort((a, b) => a.name.localeCompare(b.name)))
      tests[r.name] = { status: 'bug', issue: r.reason };
    const seed = {
      summary: { pass: buckets.pass, 'unsupported-syntax': buckets.unsupported },
      tests,
    };
    fs.writeFileSync(SEED_PATH, JSON.stringify(seed, null, 1) + '\n');
    console.log(`\nSeed baseline (every unattributed failure as an untriaged bug) written to ${SEED_PATH}`);
  }

  console.log();
  if (failed)
    process.exit(1);

  //#endregion
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href)
  main();

//#endregion
