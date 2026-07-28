#!/usr/bin/env node

/**
 * JarenJS JSON Patch (RFC 6902) + JSON Merge Patch (RFC 7396) Benchmark
 *
 * Compares the compiled patch engine (compileJSONPatch, compileMergePatch)
 * against a naive clone-and-interpret implementation (inlined below - the
 * shape most JSON Patch libraries ship: structuredClone the document, then
 * re-parse every pointer and dispatch every operation per application).
 *
 * Before timing anything the tool replays the official json-patch-tests
 * vectors (vendored under test/json/fixtures/json-patch/) through
 * applyJSONPatch - correctness first, then speed.
 *
 * Columns (RFC 6902 table):
 *   jaren compiled - compile once, apply per iteration (copy-on-write)
 *   jaren mutate   - compiled applier with { mutate: true } (in place)
 *   jaren one-shot - applyJSONPatch (compile + apply per iteration)
 *   naive          - structuredClone + interpretive apply per iteration
 *
 * Usage:
 *   node benchmark/jsonpatch.js
 *   node benchmark/jsonpatch.js --iterations 500000
 *   node benchmark/jsonpatch.js --output json --filepath results.json
 */

import * as fs from 'fs';
import { fileURLToPath } from 'url';

import { equalsJson } from '@jarenjs/core/object';
import {
  compileJSONPatch,
  applyJSONPatch,
  compileMergePatch,
  createJSONPatch,
  createMergePatch,
  parseJSONPointer,
} from '@jarenjs/json';

import { pad, padLeft, formatNs } from './lib/fmt.js';
import { measureNsPerOp as measureNs } from './lib/measure.js';

const DEFAULT_ITERATIONS = 200_000;
const WARMUP_ITERATIONS = 5_000;

const measureNsPerOp = (fn, iterations) => measureNs(fn, iterations, WARMUP_ITERATIONS);

//#region official test vectors (correctness gate)

const FIXTURES_DIR = fileURLToPath(new URL('../test/json/fixtures/json-patch/', import.meta.url));

function runConformance() {
  const files = {};
  let total = 0;
  let pass = 0;
  for (const name of ['spec_tests.json', 'tests.json']) {
    const cases = JSON.parse(fs.readFileSync(FIXTURES_DIR + name, 'utf8'));
    let fileTotal = 0;
    let filePass = 0;
    for (const test of cases) {
      if (test.disabled)
        continue;
      fileTotal++;
      try {
        const result = applyJSONPatch(test.doc, test.patch);
        if (test.error === undefined && (test.expected === undefined || equalsJson(result, test.expected)))
          filePass++;
      }
      catch {
        if (test.error !== undefined)
          filePass++;
      }
    }
    files[name] = { total: fileTotal, pass: filePass };
    total += fileTotal;
    pass += filePass;
  }
  return { total, pass, files };
}

//#endregion

//#region naive interpretive implementation (typical library shape)

function naiveGetParent(doc, segments) {
  let v = doc;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    v = Array.isArray(v) ? v[Number(seg)] : v[seg];
    if (v === undefined)
      throw new Error(`path does not exist: ${segments.join('/')}`);
  }
  return v;
}

function naiveApplyOp(doc, op) {
  const segments = parseJSONPointer(op.path);
  if (segments.length === 0) {
    if (op.op === 'add' || op.op === 'replace')
      return op.value;
    if (op.op === 'test')
      return doc;
    throw new Error(`cannot ${op.op} the root`);
  }
  const parent = naiveGetParent(doc, segments);
  const last = segments[segments.length - 1];
  switch (op.op) {
    case 'add':
      if (Array.isArray(parent)) {
        const idx = last === '-' ? parent.length : Number(last);
        parent.splice(idx, 0, op.value);
      }
      else {
        parent[last] = op.value;
      }
      break;
    case 'remove':
      if (Array.isArray(parent))
        parent.splice(Number(last), 1);
      else
        delete parent[last];
      break;
    case 'replace':
      parent[Array.isArray(parent) ? Number(last) : last] = op.value;
      break;
    case 'test': {
      const actual = parent[Array.isArray(parent) ? Number(last) : last];
      if (JSON.stringify(actual) !== JSON.stringify(op.value))
        throw new Error('test failed');
      break;
    }
    default:
      throw new Error(`unsupported op ${op.op}`);
  }
  return doc;
}

function naiveApplyPatch(doc, patch) {
  let result = structuredClone(doc);
  for (const op of patch)
    result = naiveApplyOp(result, op);
  return result;
}

function naiveMergePatch(target, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch))
    return structuredClone(patch);
  const out = (target !== null && typeof target === 'object' && !Array.isArray(target))
    ? structuredClone(target)
    : {};
  for (const key of Object.keys(patch)) {
    const v = patch[key];
    if (v === null)
      delete out[key];
    else
      out[key] = naiveMergePatch(out[key], v);
  }
  return out;
}

//#endregion

//#region scenarios

function makeOrder(lines) {
  return {
    id: 'ord-1042',
    version: 7,
    customer: { name: 'Alice', tier: 'gold', address: { city: 'Berlin', zip: '10115' } },
    lines: Array.from({ length: lines }, (_, i) => ({
      sku: `sku-${i}`, qty: (i % 5) + 1, price: 9.99 + i,
    })),
    meta: { updated: '2026-07-17', tags: ['b2b', 'eu'] },
  };
}

const PATCH_SCENARIOS = [
  {
    name: 'small update (4 ops, small doc)',
    doc: { baz: 'qux', foo: 'bar', numbers: [1, 2, 3] },
    patch: [
      { op: 'replace', path: '/baz', value: 'boo' },
      { op: 'add', path: '/hello', value: ['world'] },
      { op: 'remove', path: '/foo' },
      { op: 'add', path: '/numbers/-', value: 4 },
    ],
  },
  {
    name: 'guarded update (test + 2 ops, 20-line order)',
    doc: makeOrder(20),
    patch: [
      { op: 'test', path: '/version', value: 7 },
      { op: 'replace', path: '/customer/address/zip', value: '10999' },
      { op: 'add', path: '/meta/tags/-', value: 'priority' },
    ],
  },
  {
    name: 'one spine, many ops (5 ops, 200-line order)',
    doc: makeOrder(200),
    patch: [
      { op: 'replace', path: '/lines/100/qty', value: 9 },
      { op: 'replace', path: '/lines/100/price', value: 1.5 },
      { op: 'add', path: '/lines/100/note', value: 'rush' },
      { op: 'replace', path: '/customer/tier', value: 'platinum' },
      { op: 'replace', path: '/version', value: 8 },
    ],
  },
];

const MERGE_SCENARIOS = [
  {
    name: 'RFC 7396 example shape (small doc)',
    doc: {
      title: 'Goodbye!',
      author: { givenName: 'John', familyName: 'Doe' },
      tags: ['example', 'sample'],
      content: 'This will be unchanged',
    },
    patch: {
      title: 'Hello!',
      phoneNumber: '+01-123-456-7890',
      author: { familyName: null },
      tags: ['example'],
    },
  },
  {
    name: 'nested field update (200-line order)',
    doc: makeOrder(200),
    patch: { customer: { address: { zip: '10999' } }, version: 8 },
  },
  {
    name: 'no-op merge (identity, 200-line order)',
    doc: makeOrder(200),
    patch: { customer: { tier: 'gold' } },
  },
];

function makeDiffPair() {
  const source = makeOrder(200);
  const target = structuredClone(source);
  target.lines[100].qty = 9;
  target.customer.tier = 'platinum';
  return { source, target };
}

//#endregion

//#region measurement

function printTable(table, iterations) {
  const nameWidth = Math.max(30, ...table.rows.map((r) => r.name.length + 2));
  const colWidth = 16;
  console.log(`\n${table.title} (${iterations.toLocaleString()} iterations, ns/op lower is better)\n`);
  console.log(pad('scenario', nameWidth) + table.columns.map((c) => padLeft(c, colWidth)).join('') + padLeft('speedup', 10));
  console.log('-'.repeat(nameWidth + colWidth * table.columns.length + 10));
  for (const row of table.rows) {
    const cols = row.results.map((ns) => padLeft(ns === null ? 'n/a' : formatNs(ns), colWidth));
    // speedup of the first column over the last (the naive baseline)
    const naive = row.results[row.results.length - 1];
    const speedup = (naive !== null && row.results.length > 1) ? `${(naive / row.results[0]).toFixed(1)}x` : '-';
    console.log(pad(row.name, nameWidth) + cols.join('') + padLeft(speedup, 10));
  }
}

//#endregion

function collectTables(iterations) {
  const patchTable = {
    key: 'patch',
    title: 'JSON Patch (RFC 6902) apply',
    columns: ['jaren compiled', 'jaren mutate', 'jaren one-shot', 'naive'],
    rows: PATCH_SCENARIOS.map(({ name, doc, patch }) => {
      const compiled = compileJSONPatch(patch);
      const mutating = compileJSONPatch(patch, { mutate: true });
      // in-place application consumes its input: patch a fresh clone each
      // iteration and subtract the clone cost measured separately
      const cloneNs = measureNsPerOp(() => structuredClone(doc), iterations / 10);
      const mutateNs = measureNsPerOp(() => mutating(structuredClone(doc)), iterations / 10) - cloneNs;
      return {
        name,
        ops: patch.length,
        results: [
          measureNsPerOp(() => compiled(doc), iterations),
          Math.max(0, mutateNs),
          measureNsPerOp(() => applyJSONPatch(doc, patch), iterations),
          measureNsPerOp(() => naiveApplyPatch(doc, patch), iterations / 10),
        ],
      };
    }),
  };

  const mergeTable = {
    key: 'merge',
    title: 'JSON Merge Patch (RFC 7396) apply',
    columns: ['jaren compiled', 'naive'],
    rows: MERGE_SCENARIOS.map(({ name, doc, patch }) => {
      const compiled = compileMergePatch(patch);
      return {
        name,
        results: [
          measureNsPerOp(() => compiled(doc), iterations),
          measureNsPerOp(() => naiveMergePatch(doc, patch), iterations / 10),
        ],
      };
    }),
  };

  const { source, target } = makeDiffPair();
  const diffTable = {
    key: 'diff',
    title: 'Structural diff (small change, 200-line order)',
    columns: ['jaren'],
    rows: [
      { name: 'createJSONPatch', results: [measureNsPerOp(() => createJSONPatch(source, target), iterations / 10)] },
      { name: 'createMergePatch', results: [measureNsPerOp(() => createMergePatch(source, target), iterations / 10)] },
    ],
  };

  return [patchTable, mergeTable, diffTable];
}

function measureCompile(iterations) {
  const patches = PATCH_SCENARIOS.map((s) => s.patch);
  const ops = patches.reduce((sum, p) => sum + p.length, 0);
  const ns = measureNsPerOp(() => {
    for (const patch of patches)
      compileJSONPatch(patch);
  }, Math.min(iterations, 100_000));
  return { jaren: { ns, patches: patches.length, ops } };
}

function main() {
  const args = process.argv.slice(2);
  const options = { iterations: DEFAULT_ITERATIONS, output: 'console', filepath: null };
  const iterIdx = args.indexOf('--iterations');
  if (iterIdx >= 0)
    options.iterations = parseInt(args[iterIdx + 1], 10);
  const outIdx = args.findIndex((a) => a === '--output' || a === '-o');
  if (outIdx >= 0)
    options.output = args[outIdx + 1];
  const fileIdx = args.indexOf('--filepath');
  if (fileIdx >= 0)
    options.filepath = args[fileIdx + 1];

  console.log(`JSON Patch benchmark - node ${process.version}`);

  const conformance = runConformance();
  console.log(`\njson-patch-tests conformance: ${conformance.pass}/${conformance.total} `
    + `(${Object.entries(conformance.files).map(([f, s]) => `${f}: ${s.pass}/${s.total}`).join(', ')})`);
  if (conformance.pass !== conformance.total)
    throw new Error('conformance failures - fix the engine before benchmarking it');

  const tables = collectTables(options.iterations);
  const compile = measureCompile(options.iterations);

  for (const table of tables)
    printTable(table, options.iterations);
  console.log(`\ncompile cost: ${formatNs(compile.jaren.ns / compile.jaren.patches)} per patch `
    + `(${compile.jaren.patches} patches, ${compile.jaren.ops} ops in ${formatNs(compile.jaren.ns)})`);

  if (options.output === 'json' && options.filepath !== null) {
    const content = JSON.stringify({
      mode: 'patch',
      date: new Date().toISOString(),
      node: process.version,
      iterations: options.iterations,
      conformance,
      tables,
      compile,
    }, null, 2);
    fs.writeFileSync(options.filepath, content);
    console.log(`Results written to ${options.filepath}`);
  }
}

main();
