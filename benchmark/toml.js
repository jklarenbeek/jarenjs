#!/usr/bin/env node

/**
 * JarenJS TOML (JOSL) Compliance & Performance Benchmark
 *
 * Runs the official toml-test suite (https://github.com/toml-lang/toml-test,
 * the git submodule at benchmark/toml-test-suite/, TOML 1.0.0 case list)
 * against @jarenjs/josl in strict TOML mode and any contender parsers,
 * then optionally profiles parse/stringify performance.
 *
 * Initialize the suite once:
 *   git submodule update --init benchmark/toml-test-suite
 *
 * Compliance here is accept/reject semantics: a valid document must parse
 * without throwing, an invalid one must throw. Typed value verification
 * for jaren (integers, floats, all four datetime flavours) is covered by
 * `npm run test:josl` (test/josl/compliance.test.js) - contenders differ
 * in their value representations, so accept/reject keeps them comparable.
 *
 * Usage:
 *   node benchmark/toml.js                      # compliance run, all engines
 *   node benchmark/toml.js --verbose            # list every failing case
 *   node benchmark/toml.js --profile            # performance comparison
 *   node benchmark/toml.js --profile --iterations 200
 *   node benchmark/toml.js --engines jaren,smol-toml
 *   node benchmark/toml.js --profile --output json --filepath results.json
 *
 * Exit code is non-zero when jaren fails a compliance test; contender
 * failures never affect the exit code.
 */

/* eslint-disable no-console */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { parseToml, stringifyToml, parseJosl } from '@jarenjs/josl';
import * as smol from 'smol-toml';
import iarna from '@iarna/toml';
import toml from 'toml';

const SUITE = fileURLToPath(new URL('./toml-test-suite/tests/', import.meta.url));
const FILELIST = join(SUITE, 'files-toml-1.0.0');
if (!existsSync(FILELIST)) {
  console.error('toml-test suite not found; initialize it once with:');
  console.error('  git submodule update --init benchmark/toml-test-suite');
  process.exit(1);
}

// Byte-level encoding cases are unreachable once the input is a JS string
// (utf8 decoding has already replaced the offending bytes with U+FFFD).
const SKIP = /^invalid\/encoding\//;

const ENGINES = [
  {
    name: 'jaren',
    parse: (text) => parseToml(text),
    stringify: (value) => stringifyToml(value),
  },
  {
    name: 'smol-toml',
    parse: (text) => smol.parse(text),
    stringify: (value) => smol.stringify(value),
  },
  {
    name: '@iarna/toml',
    parse: (text) => iarna.parse(text),
    stringify: (value) => iarna.stringify(value),
  },
  {
    name: 'toml',
    parse: (text) => toml.parse(text),
    stringify: null, // the original npm package is parse-only
  },
];

//#region cli

const args = process.argv.slice(2);
const flags = {
  profile: args.includes('--profile'),
  verbose: args.includes('--verbose'),
  iterations: Number(args[args.indexOf('--iterations') + 1]) || 100,
  engines: args.includes('--engines')
    ? args[args.indexOf('--engines') + 1].split(',')
    : null,
  output: args.includes('--output') ? args[args.indexOf('--output') + 1] : null,
  filepath: args.includes('--filepath') ? args[args.indexOf('--filepath') + 1] : null,
};
const engines = flags.engines === null
  ? ENGINES
  : ENGINES.filter((e) => flags.engines.includes(e.name));

//#endregion

//#region suite loading

function listCases(kind) {
  return readFileSync(FILELIST, 'utf8')
    .split('\n')
    .filter((f) => f.startsWith(`${kind}/`) && f.endsWith('.toml'))
    .sort()
    .map((file) => ({ file, text: readFileSync(join(SUITE, file), 'utf8') }));
}

const validCases = listCases('valid');
const invalidCases = listCases('invalid').filter((c) => !SKIP.test(c.file));

//#endregion

//#region compliance

function runCompliance() {
  console.log(`toml-test 1.0.0: ${validCases.length} valid, ${invalidCases.length} invalid cases\n`);
  const compliance = {};
  let jarenFailed = 0;
  for (const engine of engines) {
    const failures = [];
    for (const { file, text } of validCases) {
      try {
        engine.parse(text);
      }
      catch (e) {
        failures.push(`${file}: rejected valid input (${String(e.message).split('\n')[0]})`);
      }
    }
    for (const { file, text } of invalidCases) {
      let threw = false;
      try {
        engine.parse(text);
      }
      catch {
        threw = true;
      }
      if (!threw)
        failures.push(`${file}: accepted invalid input`);
    }
    const total = validCases.length + invalidCases.length;
    const pass = total - failures.length;
    const pct = ((pass / total) * 100).toFixed(1);
    console.log(`  ${engine.name.padEnd(14)} ${String(pass).padStart(4)}/${total}  (${pct}%)`);
    if (flags.verbose)
      for (const f of failures)
        console.log(`      ${f}`);
    compliance[engine.name] = { pass, total };
    if (engine.name === 'jaren')
      jarenFailed = failures.length;
  }
  return { jarenFailed, compliance };
}

//#endregion

//#region profile

// Synthetic corpora modelled on real workloads: a record stream (the LLM
// pipeline shape), a config-heavy document, and the full valid corpus.
function buildRecords(n) {
  let out = '';
  for (let i = 0; i < n; ++i)
    out += [
      '[[records]]',
      `id = ${i}`,
      `name = "record number ${i} with some \\"escaped\\" text"`,
      `score = ${(i % 100) / 3}`,
      'active = true',
      'when = 2026-07-18T12:00:00Z',
      `tags = [ "alpha", "beta", "g${i}" ]`,
      '[records.meta]',
      `source = "generator-${i % 7}"`,
      '', ''].join('\n');
  return out;
}

const specExample = readFileSync(join(SUITE, 'valid/spec-example-1.toml'), 'utf8');
const corpora = [
  { name: 'records-1k (~90KB)', text: buildRecords(1000) },
  { name: 'spec-example-1 (small doc)', text: specExample },
  { name: 'valid corpus (each file)', files: validCases },
];

function timeIt(fn, iterations) {
  fn(); // warmup
  fn();
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iterations; ++i)
    fn();
  return Number(process.hrtime.bigint() - t0) / 1e6 / iterations;
}

function runProfile() {
  console.log(`\nparse profile (${flags.iterations} iterations, ms per pass; ratio vs jaren)\n`);
  const parse = [];
  for (const corpus of corpora) {
    console.log(`  ${corpus.name}`);
    const results = {};
    let base = null;
    for (const engine of engines) {
      let ms;
      try {
        ms = corpus.files !== undefined
          ? timeIt(() => {
            for (const { text } of corpus.files) {
              try {
                engine.parse(text);
              }
              catch {
                // contenders that fail compliance still get timed on what
                // they can parse
              }
            }
          }, flags.iterations)
          : timeIt(() => engine.parse(corpus.text), flags.iterations);
      }
      catch {
        console.log(`    ${engine.name.padEnd(14)} error`);
        results[engine.name] = null;
        continue;
      }
      if (engine.name === 'jaren')
        base = ms;
      results[engine.name] = ms;
      const ratio = base !== null ? ` (${(ms / base).toFixed(2)}x)` : '';
      console.log(`    ${engine.name.padEnd(14)} ${ms.toFixed(3).padStart(9)} ms${ratio}`);
    }
    parse.push({ name: corpus.name, results });
  }

  console.log(`\nstringify profile (${flags.iterations} iterations, ms per pass; ratio vs jaren)\n`);
  const value = parseJosl(buildRecords(1000));
  const stringify = {};
  let base = null;
  for (const engine of engines) {
    if (engine.stringify === null)
      continue;
    let ms;
    try {
      ms = timeIt(() => engine.stringify(value), flags.iterations);
    }
    catch (e) {
      console.log(`  ${engine.name.padEnd(14)} error (${String(e.message).split('\n')[0]})`);
      stringify[engine.name] = null;
      continue;
    }
    if (engine.name === 'jaren')
      base = ms;
    stringify[engine.name] = ms;
    const ratio = base !== null ? ` (${(ms / base).toFixed(2)}x)` : '';
    console.log(`  ${engine.name.padEnd(14)} ${ms.toFixed(3).padStart(9)} ms${ratio}`);
  }
  return { parse, stringify };
}

//#endregion

const { jarenFailed, compliance } = runCompliance();
const profile = flags.profile ? runProfile() : null;

if (flags.output === 'json') {
  const data = {
    date: new Date().toISOString(),
    node: process.version,
    engines: engines.map((e) => e.name),
    cases: { valid: validCases.length, invalid: invalidCases.length },
    compliance,
    profile: profile === null ? null : { iterations: flags.iterations, ...profile },
  };
  const json = JSON.stringify(data, null, 2);
  if (flags.filepath !== null) {
    writeFileSync(flags.filepath, json);
    console.log(`\nwrote ${flags.filepath}`);
  }
  else
    console.log(json);
}
process.exit(jarenFailed === 0 ? 0 : 1);
