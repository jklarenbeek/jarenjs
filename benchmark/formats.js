#!/usr/bin/env node

/**
 * JarenJS string format Performance Benchmark
 *
 * Compares `@jarenjs/formats` against `ajv-formats`, compiled validator
 * to compiled validator: both engines are handed `{type: 'string',
 * format}` and timed on the function that comes back, so the numbers
 * include whatever dispatch each engine puts in front of the predicate.
 *
 * Two tables, because the interesting comparison is not the same in
 * both halves:
 *
 *   1. Formats both engines implement — a ratio means something.
 *   2. Formats only Jaren implements — the internationalized ones
 *      (`iri`, `idn-hostname`) and Jaren's extras. Ajv has no answer
 *      here, so the column reads `n/a` and the story is the absolute
 *      cost, not a ratio. Leaving these out entirely would flatter the
 *      first table by hiding where the work actually went.
 *
 * Every scenario carries a value that must be accepted AND one that must
 * be rejected, and both engines are checked against both before being
 * timed. An engine that waves the invalid value through is not doing the
 * work being measured, so its column is dropped rather than reported.
 *
 * Usage:
 *   node benchmark/formats.js
 *   node benchmark/formats.js --iterations 500000
 *   node benchmark/formats.js --filter iri
 *   node benchmark/formats.js --output json --filepath results.json
 */

import * as fs from 'fs';

import { JarenValidator } from '@jarenjs/validate';
import * as jarenFormats from '@jarenjs/formats';

import Ajv from 'ajv';
import ajvFormats from 'ajv-formats';

import { pad, padLeft, formatNs } from './lib/fmt.js';
import { measureNsPerOp as measureNs } from './lib/measure.js';
import { writeJsonResults } from './lib/results.js';

const DEFAULT_ITERATIONS = 200_000;
const WARMUP_ITERATIONS = 20_000;

const measureNsPerOp = (fn, iterations) => measureNs(fn, iterations, WARMUP_ITERATIONS);

//#region scenarios

/**
 * Formats both engines implement. `valid` must be accepted and
 * `invalid` rejected by each engine that claims the format.
 */
const SHARED_SCENARIOS = [
  { format: 'date-time', valid: '2024-01-15T13:45:30Z', invalid: '2024-13-45T99:99:99Z' },
  { format: 'date', valid: '2024-01-15', invalid: '2024-13-45' },
  { format: 'time', valid: '13:45:30Z', invalid: '25:99:99Z' },
  { format: 'duration', valid: 'P3DT4H', invalid: 'P3X' },
  { format: 'email', valid: 'user.name@example.com', invalid: 'user@@example.com' },
  { format: 'hostname', valid: 'sub.example.com', invalid: '-bad.example.com' },
  { format: 'ipv4', valid: '192.168.0.1', invalid: '256.1.1.1' },
  { format: 'ipv6', valid: '2001:db8::8a2e:370:7334', invalid: '2001:db8::8a2e::7334' },
  { format: 'uri', valid: 'https://example.com/a/b?q=1#f', invalid: 'http://x/a|b' },
  { format: 'uri-reference', valid: '/a/b?q=1', invalid: 'a\\b' },
  { format: 'uri-template', valid: '/users/{id}', invalid: '/users/{id' },
  { format: 'url', valid: 'https://example.com/a', invalid: 'example.com' },
  { format: 'uuid', valid: '550e8400-e29b-41d4-a716-446655440000', invalid: '550e8400-e29b-41d4-a716-44665544000g' },
  { format: 'regex', valid: '^[a-z]+$', invalid: '^(abc]' },
  { format: 'json-pointer', valid: '/store/book/0/title', invalid: 'store/book' },
  { format: 'relative-json-pointer', valid: '1/sibling', invalid: '/nope' },
];

/** Formats Ajv does not implement at all. */
const JAREN_ONLY_SCENARIOS = [
  { format: 'iri', valid: 'https://例え.jp/テスト?q=1#f', invalid: 'https://例え.jp/a|b' },
  { format: 'iri-reference', valid: '/パス?q=1', invalid: 'a\\b' },
  { format: 'idn-hostname', valid: '例え.テスト.jp', invalid: '-bad.例え.jp' },
  { format: 'idn-email', valid: 'user@例え.jp', invalid: 'user@@例え.jp' },
  { format: 'iregexp', valid: '[a-c]+', invalid: '\\d+' },
  { format: 'json-path', valid: '$.store.book[?@.price < 10]', invalid: '$.store.book[?' },
  { format: 'iban', valid: 'NL91ABNA0417164300', invalid: 'NL91ABNA0417164301' },
  { format: 'country2', valid: 'NL', invalid: 'USA' },
  { format: 'mac', valid: '00:1B:44:11:3A:B7', invalid: 'GG:HH:II:JJ:KK:LL' },
  { format: 'base64', valid: 'SGVsbG8gV29ybGQ=', invalid: 'A=AA' },
  { format: 'isbn13', valid: 'ISBN 978-0-306-40615-7', invalid: 'ISBN 12-3' },
];

//#endregion

//#region engines

function createJaren() {
  // Draft 2020-12 makes `format` annotation-only unless assertion is
  // asked for; without this the validator would return true for
  // everything and the benchmark would measure nothing.
  const jaren = new JarenValidator({ formatAssertion: true });
  jaren.addFormats(jarenFormats.stringFormats);
  jaren.addFormats(jarenFormats.dateTimeFormats);
  jaren.addFormats(jarenFormats.jsonFormats);
  return (format) => {
    try {
      return jaren.compile({ type: 'string', format });
    }
    catch {
      return null;
    }
  };
}

function createAjv() {
  // `logger: false` because an unknown format is an expected outcome
  // here, not a warning: it is exactly what the second table reports.
  const ajv = new Ajv({ strict: false, allErrors: false, logger: false });
  ajvFormats(ajv);
  return (format) => {
    try {
      const validate = ajv.compile({ type: 'string', format });
      // An unknown format compiles to a no-op under `strict: false`.
      return validate;
    }
    catch {
      return null;
    }
  };
}

/**
 * A compiled validator, or null when the engine cannot honestly answer
 * for this format — unknown to it, or accepting the value it should
 * reject.
 */
function usableValidator(compile, scenario) {
  const validate = compile(scenario.format);
  if (validate === null) return null;
  if (validate(scenario.valid) !== true) return null;
  if (validate(scenario.invalid) !== false) return null;
  return validate;
}

//#endregion

//#region conformance

const FORMAT_SUITE_DIR = 'benchmark/suite/tests/draft2020-12/optional/format';

/**
 * Score the registered testers against the official JSON-Schema-Test-Suite
 * `optional/format` cases. Run against the testers rather than through a
 * schema on purpose: under 2020-12 `format` is annotation-only by
 * default, so a schema-level run would pass every case vacuously.
 *
 * Returns null when the suite submodule is not checked out - the
 * benchmark still works, it just cannot report correctness.
 *
 * @returns {{pass: number, total: number, formats: number, unregistered: string[]}|null}
 */
function scoreConformance() {
  if (!fs.existsSync(FORMAT_SUITE_DIR)) return null;
  const testers = jarenFormats.formatTesters;
  let pass = 0;
  let total = 0;
  let formats = 0;
  const unregistered = [];
  for (const file of fs.readdirSync(FORMAT_SUITE_DIR).sort()) {
    if (!file.endsWith('.json')) continue;
    const name = file.slice(0, -5);
    const tester = testers[name];
    if (tester === undefined) {
      unregistered.push(name);
      continue;
    }
    formats++;
    const groups = JSON.parse(fs.readFileSync(`${FORMAT_SUITE_DIR}/${file}`, 'utf8'));
    for (const group of groups) {
      for (const test of group.tests) {
        // A format only constrains strings; every other type is valid.
        if (typeof test.data !== 'string') continue;
        total++;
        if (tester(test.data) === test.valid) pass++;
      }
    }
  }
  return { pass, total, formats, unregistered };
}

//#endregion

//#region measurement

function printTable(title, columns, rows, iterations) {
  const nameWidth = Math.max(30, ...rows.map((r) => r.name.length + 2));
  const colWidth = 16;
  console.log(`\n${title} (${iterations.toLocaleString()} iterations, ns/op lower is better)\n`);
  console.log(pad('scenario', nameWidth) + columns.map((c) => padLeft(c, colWidth)).join('') + padLeft('speedup', 10));
  console.log('-'.repeat(nameWidth + colWidth * columns.length + 10));
  for (const row of rows) {
    const cols = row.results.map((ns) => padLeft(ns === null ? 'n/a' : formatNs(ns), colWidth));
    const [jaren, rival] = row.results;
    const speedup = rival !== null && jaren !== null ? `${(rival / jaren).toFixed(1)}x` : '-';
    console.log(pad(row.name, nameWidth) + cols.join('') + padLeft(speedup, 10));
  }
}

//#endregion

/**
 * Time one scenario on both engines. A row is `[jaren, ajv]` so the
 * generic table renderer and the overview's rival ranking both read the
 * Jaren column first.
 */
function measureScenario(scenario, jarenCompile, ajvCompile, iterations) {
  const jarenValidate = usableValidator(jarenCompile, scenario);
  const ajvValidate = usableValidator(ajvCompile, scenario);
  const { valid, invalid } = scenario;
  return {
    name: scenario.format,
    results: [
      jarenValidate === null ? null
        : measureNsPerOp(() => { jarenValidate(valid); jarenValidate(invalid); }, iterations),
      ajvValidate === null ? null
        : measureNsPerOp(() => { ajvValidate(valid); ajvValidate(invalid); }, iterations),
    ],
  };
}

function main() {
  const args = process.argv.slice(2);
  const options = {
    output: 'console',
    filepath: null,
    iterations: DEFAULT_ITERATIONS,
    filter: null,
  };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--iterations': case '-i': options.iterations = parseInt(args[++i], 10); break;
      case '--output': case '-o': options.output = args[++i]; break;
      case '--filepath': case '-f': options.filepath = args[++i]; break;
      case '--filter': options.filter = args[++i]; break;
      case '--help': case '-h':
        console.log('Usage: node benchmark/formats.js [--iterations N] [--filter substr] [--output json --filepath FILE]');
        return;
      default:
        console.error(`Unknown option: ${args[i]}`);
        process.exit(2);
    }
  }
  if (!Number.isFinite(options.iterations) || options.iterations <= 0) {
    console.error('--iterations must be a positive number');
    process.exit(2);
  }

  const jarenCompile = createJaren();
  const ajvCompile = createAjv();
  const keep = (s) => options.filter === null || s.format.includes(options.filter);

  const tables = [];
  for (const [title, scenarios, note] of [
    ['Formats both engines implement', SHARED_SCENARIOS, 'jaren vs ajv-formats'],
    ['Formats only Jaren implements', JAREN_ONLY_SCENARIOS, 'ajv-formats has no validator for these'],
  ]) {
    const rows = scenarios.filter(keep)
      .map((s) => measureScenario(s, jarenCompile, ajvCompile, options.iterations));
    if (rows.length === 0) continue;
    const columns = ['jaren', 'ajv-formats'];
    printTable(`${title} — ${note}`, columns, rows, options.iterations);
    tables.push({ title, note, columns, rows });
  }

  if (tables.length === 0) {
    console.error(`No scenarios matched --filter ${options.filter}`);
    process.exit(2);
  }

  console.log('\nEach iteration validates one accepted and one rejected value, so a row is the cost of two calls.');

  const conformance = scoreConformance();
  if (conformance === null) {
    console.log('Conformance not scored: the JSON-Schema-Test-Suite submodule is not checked out.');
  }
  else {
    console.log(`\nOfficial optional/format suite: ${conformance.pass} / ${conformance.total} cases`
      + ` across ${conformance.formats} registered formats`
      + (conformance.unregistered.length === 0 ? ''
        : ` (not registered: ${conformance.unregistered.join(', ')})`));
  }
  writeJsonResults('formats', { conformance, tables }, options);
}

main();
