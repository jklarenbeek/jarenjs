#!/usr/bin/env node

/**
 * JarenJS JSON Patch (RFC 6902) + JSON Merge Patch (RFC 7396) Benchmark
 *
 * Compares the compiled patch engine (compileJSONPatch, compileMergePatch)
 * against a naive clone-and-interpret implementation (inlined below - the
 * shape most JSON Patch libraries ship: structuredClone the document, then
 * re-parse every pointer and dispatch every operation per application).
 *
 * Columns:
 *   compiled     - compile once, apply per iteration (copy-on-write)
 *   mutate       - compiled applier with { mutate: true } (in place)
 *   one-shot     - applyJSONPatch (compile + apply per iteration)
 *   naive        - structuredClone + interpretive apply per iteration
 *
 * Usage:
 *   node benchmark/jsonpatch.js
 *   node benchmark/jsonpatch.js --iterations 500000
 */

import {
  compileJSONPatch,
  applyJSONPatch,
  compileMergePatch,
  createJSONPatch,
  createMergePatch,
  parseJSONPointer,
} from '@jarenjs/json';

const DEFAULT_ITERATIONS = 200_000;
const WARMUP_ITERATIONS = 5_000;

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
    name: 'proposal example (4 ops, small doc)',
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
];

const DIFF_SCENARIOS = [
  {
    name: 'createJSONPatch (small change, 200-line order)',
    run: () => {
      const source = makeOrder(200);
      const target = structuredClone(source);
      target.lines[100].qty = 9;
      target.customer.tier = 'platinum';
      return () => createJSONPatch(source, target);
    },
  },
  {
    name: 'createMergePatch (small change, 200-line order)',
    run: () => {
      const source = makeOrder(200);
      const target = structuredClone(source);
      target.lines[100].qty = 9;
      target.customer.tier = 'platinum';
      return () => createMergePatch(source, target);
    },
  },
];

//#endregion

//#region measurement

function measureNsPerOp(fn, iterations) {
  for (let i = 0; i < WARMUP_ITERATIONS; i++)
    fn();
  const start = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++)
    fn();
  const end = process.hrtime.bigint();
  return Number(end - start) / iterations;
}

function formatNs(ns) {
  if (ns >= 1e6) return `${(ns / 1e6).toFixed(2)} ms`;
  if (ns >= 1e3) return `${(ns / 1e3).toFixed(2)} µs`;
  return `${ns.toFixed(1)} ns`;
}

function pad(str, width) {
  return String(str).padEnd(width);
}

function padLeft(str, width) {
  return String(str).padStart(width);
}

function printTable(title, columns, rows, iterations) {
  const nameWidth = Math.max(30, ...rows.map((r) => r.name.length + 2));
  const colWidth = 14;
  console.log(`\n${title} (${iterations.toLocaleString()} iterations, ns/op lower is better)\n`);
  console.log(pad('scenario', nameWidth) + columns.map((c) => padLeft(c, colWidth)).join('') + padLeft('speedup', 10));
  console.log('-'.repeat(nameWidth + colWidth * columns.length + 10));
  for (const row of rows) {
    const cols = row.results.map((ns) => padLeft(ns === null ? 'n/a' : formatNs(ns), colWidth));
    // speedup of the compiled applier (first column) over the naive baseline (last column)
    const naive = row.results[row.results.length - 1];
    const speedup = naive !== null ? `${(naive / row.results[0]).toFixed(1)}x` : '-';
    console.log(pad(row.name, nameWidth) + cols.join('') + padLeft(speedup, 10));
  }
}

//#endregion

function main() {
  const args = process.argv.slice(2);
  let iterations = DEFAULT_ITERATIONS;
  const iterIdx = args.indexOf('--iterations');
  if (iterIdx >= 0)
    iterations = parseInt(args[iterIdx + 1], 10);

  console.log(`JSON Patch benchmark - node ${process.version}`);

  const patchRows = PATCH_SCENARIOS.map(({ name, doc, patch }) => {
    const compiled = compileJSONPatch(patch);
    const mutating = compileJSONPatch(patch, { mutate: true });
    // in-place application consumes its input: patch a fresh clone each
    // iteration and subtract the clone cost measured separately
    const cloneNs = measureNsPerOp(() => structuredClone(doc), iterations / 10);
    const mutateNs = measureNsPerOp(() => mutating(structuredClone(doc)), iterations / 10) - cloneNs;
    return {
      name,
      results: [
        measureNsPerOp(() => compiled(doc), iterations),
        Math.max(0, mutateNs),
        measureNsPerOp(() => applyJSONPatch(doc, patch), iterations),
        measureNsPerOp(() => naiveApplyPatch(doc, patch), iterations / 10),
      ],
    };
  });
  printTable('JSON Patch (RFC 6902) apply', ['compiled', 'mutate', 'one-shot', 'naive'], patchRows, iterations);

  const mergeRows = MERGE_SCENARIOS.map(({ name, doc, patch }) => {
    const compiled = compileMergePatch(patch);
    return {
      name,
      results: [
        measureNsPerOp(() => compiled(doc), iterations),
        null,
        null,
        measureNsPerOp(() => naiveMergePatch(doc, patch), iterations / 10),
      ],
    };
  });
  printTable('JSON Merge Patch (RFC 7396) apply', ['compiled', '', '', 'naive'], mergeRows, iterations);

  const diffRows = DIFF_SCENARIOS.map(({ name, run }) => {
    const fn = run();
    return { name, results: [measureNsPerOp(fn, iterations / 10)] };
  });
  printTable('Structural diff', ['jaren'], diffRows, iterations);
}

main();
