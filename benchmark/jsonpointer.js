#!/usr/bin/env node

/**
 * JarenJS JSON Pointer (RFC 6901) Performance Benchmark
 *
 * Compares the compiled pointer engine (compileJSONPointer,
 * compileRelativeJSONPointer, compileDataRef) against the historical
 * interpretive resolver (inlined below, as it shipped before the compiled
 * rewrite) and the `jsonpointer` npm package (absolute pointers only).
 *
 * The relative-pointer scenarios mirror the validator's `$data` keyword:
 * a compile-time-constant ref resolved at a realistic instance depth.
 *
 * Usage:
 *   node benchmark/jsonpointer.js
 *   node benchmark/jsonpointer.js --iterations 5000000
 */

import {
  compileJSONPointer,
  compileRelativeJSONPointer,
  compileDataRef,
  JSONPOINTER_NOTHING,
} from '@jarenjs/json';
import jsonpointerNpm from 'jsonpointer';

const DEFAULT_ITERATIONS = 1_000_000;
const WARMUP_ITERATIONS = 10_000;

//#region legacy interpretive resolver (pre-compile implementation, verbatim)

function legacyParseJsonPointer(pointer) {
  if (!pointer || pointer === '') {
    return [];
  }
  if (!pointer.startsWith('/')) {
    throw new Error(`Invalid JSON Pointer: '${pointer}' - must start with '/'`);
  }
  return pointer.slice(1).split('/').map(segment =>
    segment.replace(/~1/g, '/').replace(/~0/g, '~')
  );
}

function legacyParseRelativeJsonPointer(pointer) {
  if (!pointer || pointer === '') {
    throw new Error('Invalid relative JSON Pointer: empty string');
  }
  const match = pointer.match(/^(\d+)(.*)$/);
  if (!match) {
    throw new Error(`Invalid relative JSON Pointer: '${pointer}' - must start with a number`);
  }
  const levels = parseInt(match[1], 10);
  const rest = match[2];
  if (rest === '#') {
    return { levels, pointer: '', hash: true };
  }
  if (rest === '' || rest.startsWith('/')) {
    return { levels, pointer: rest, hash: false };
  }
  throw new Error(`Invalid relative JSON Pointer: '${pointer}'`);
}

function legacyGetValueByJsonPointer(dataRoot, dataPath, pointer) {
  try {
    const segments = legacyParseJsonPointer(pointer);
    let current = dataRoot;
    for (const segment of segments) {
      if (current === null || current === undefined) {
        return { value: undefined, found: false };
      }
      if (Array.isArray(current)) {
        const index = parseInt(segment, 10);
        if (isNaN(index) || index < 0 || index >= current.length) {
          return { value: undefined, found: false };
        }
        current = current[index];
      } else if (typeof current === 'object') {
        if (!(segment in current)) {
          return { value: undefined, found: false };
        }
        current = current[segment];
      } else {
        return { value: undefined, found: false };
      }
    }
    return { value: current, found: true };
  } catch (e) {
    return { value: undefined, found: false };
  }
}

function legacyResolveRelativePointer(dataRoot, dataPath, relativePointer) {
  try {
    const parsed = legacyParseRelativeJsonPointer(relativePointer);
    const currentSegments = legacyParseJsonPointer(dataPath || '');
    if (parsed.levels > currentSegments.length) {
      return { value: undefined, found: false };
    }
    const targetSegments = currentSegments.slice(0, currentSegments.length - parsed.levels);
    if (parsed.hash) {
      if (targetSegments.length === 0) {
        return { value: '', found: true };
      }
      return { value: targetSegments[targetSegments.length - 1], found: true };
    }
    let current = dataRoot;
    for (const segment of targetSegments) {
      if (Array.isArray(current)) {
        const index = parseInt(segment, 10);
        if (isNaN(index) || index < 0 || index >= current.length) {
          return { value: undefined, found: false };
        }
        current = current[index];
      } else if (typeof current === 'object' && current !== null) {
        if (!(segment in current)) {
          return { value: undefined, found: false };
        }
        current = current[segment];
      } else {
        return { value: undefined, found: false };
      }
    }
    if (parsed.pointer) {
      return legacyGetValueByJsonPointer(current, '', parsed.pointer);
    }
    return { value: current, found: true };
  } catch (e) {
    return { value: undefined, found: false };
  }
}

function legacyResolveDataRef(dataRoot, dataPath, ref) {
  if (typeof ref !== 'string') {
    return { value: undefined, found: false };
  }
  if (/^\d/.test(ref)) {
    return legacyResolveRelativePointer(dataRoot, dataPath, ref);
  }
  if (ref.startsWith('/')) {
    return legacyGetValueByJsonPointer(dataRoot, dataPath, ref);
  }
  if (ref === '') {
    return { value: dataRoot, found: true };
  }
  return { value: undefined, found: false };
}

//#endregion

//#region scenarios

const document = {
  value: 5,
  limits: { min: 2, max: 9 },
  'a/b': { 'm~n': 8 },
  items: [],
  deep: { level1: { level2: { level3: { level4: { leaf: 'found' } } } } },
  order: {
    customer: { name: 'Ada', discount: 0.1 },
    lines: [],
  },
};
for (let i = 0; i < 100; i++) {
  document.items.push({ id: i, name: `item-${i}`, price: (i * 7919) % 1000 / 10 });
  document.order.lines.push({ sku: `sku-${i}`, qty: i % 7, maxQty: 10 });
}

// Absolute pointers, resolved from the document root.
const ABSOLUTE_SCENARIOS = [
  { name: 'root', pointer: '' },
  { name: 'shallow member', pointer: '/value' },
  { name: 'two members', pointer: '/limits/min' },
  { name: 'deep member (6 segments)', pointer: '/deep/level1/level2/level3/level4/leaf' },
  { name: 'array index', pointer: '/items/42/name' },
  { name: 'escaped keys', pointer: '/a~1b/m~0n' },
  { name: 'not found', pointer: '/items/42/nosuch' },
];

// Relative pointers at realistic $data depths: the ref is a schema
// constant, the location varies per validated value.
const RELATIVE_SCENARIOS = [
  { name: 'sibling (1/sibling)', pointer: '1/maxQty', dataPath: '/order/lines/13/qty' },
  { name: 'current (0)', pointer: '0', dataPath: '/order/customer/discount' },
  { name: 'member name (0#)', pointer: '0#', dataPath: '/order/customer/name' },
  { name: 'grandparent walk (2/customer/discount)', pointer: '2/customer/discount', dataPath: '/order/lines/13' },
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
  const colWidth = 16;
  console.log(`\n${title} (${iterations.toLocaleString()} iterations, ns/op lower is better)\n`);
  console.log(pad('scenario', nameWidth) + columns.map((c) => padLeft(c, colWidth)).join('') + padLeft('speedup', 10));
  console.log('-'.repeat(nameWidth + colWidth * columns.length + 10));
  for (const row of rows) {
    const cols = row.results.map((ns) => padLeft(ns === null ? 'n/a' : formatNs(ns), colWidth));
    // speedup of the compiled getter (first column) over the legacy resolver (second column)
    const speedup = row.results[1] !== null ? `${(row.results[1] / row.results[0]).toFixed(1)}x` : '-';
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

  let sink = 0; // defeat dead-code elimination
  const consume = (v) => { if (v !== JSONPOINTER_NOTHING) sink++; };

  // absolute pointers: compiled vs legacy vs jsonpointer npm
  const absoluteRows = [];
  for (const { name, pointer } of ABSOLUTE_SCENARIOS) {
    const compiled = compileJSONPointer(pointer);
    const npmCompiled = pointer === '' ? null : jsonpointerNpm.compile(pointer);
    absoluteRows.push({
      name,
      results: [
        measureNsPerOp(() => consume(compiled(document)), iterations),
        measureNsPerOp(() => consume(legacyGetValueByJsonPointer(document, '', pointer).value), iterations),
        npmCompiled === null ? null : measureNsPerOp(() => consume(npmCompiled.get(document)), iterations),
        pointer === '' ? null : measureNsPerOp(() => consume(jsonpointerNpm.get(document, pointer)), iterations),
      ],
    });
  }
  printTable(
    'Absolute JSON Pointer',
    ['jaren compiled', 'jaren legacy', 'npm compiled', 'npm interpret'],
    absoluteRows,
    iterations);

  // relative pointers: compiled vs legacy (the npm package has no relative support)
  const relativeRows = [];
  for (const { name, pointer, dataPath } of RELATIVE_SCENARIOS) {
    const compiled = compileRelativeJSONPointer(pointer);
    relativeRows.push({
      name,
      results: [
        measureNsPerOp(() => consume(compiled(document, dataPath)), iterations),
        measureNsPerOp(() => consume(legacyResolveRelativePointer(document, dataPath, pointer).value), iterations),
      ],
    });
  }
  printTable(
    'Relative JSON Pointer (the $data hot path)',
    ['jaren compiled', 'jaren legacy'],
    relativeRows,
    iterations);

  // the data-ref dispatch as the validator uses it: compiled resolver vs
  // the legacy per-call resolver
  const dataRefRows = [];
  for (const { name, ref, dataPath } of [
    { name: 'absolute ref (/limits/min)', ref: '/limits/min', dataPath: '/value' },
    { name: 'relative ref (1/maxQty)', ref: '1/maxQty', dataPath: '/order/lines/13/qty' },
  ]) {
    const compiled = compileDataRef(ref);
    dataRefRows.push({
      name,
      results: [
        measureNsPerOp(() => consume(compiled(document, dataPath)), iterations),
        measureNsPerOp(() => consume(legacyResolveDataRef(document, dataPath, ref).value), iterations),
      ],
    });
  }
  printTable(
    'Data reference dispatch',
    ['jaren compiled', 'jaren legacy'],
    dataRefRows,
    iterations);

  // compile cost: parse + compile every scenario pointer once
  const allAbsolute = ABSOLUTE_SCENARIOS.map((s) => s.pointer);
  const allRelative = RELATIVE_SCENARIOS.map((s) => s.pointer);
  const compileIterations = Math.max(1000, Math.floor(iterations / 100));
  const compileNs = measureNsPerOp(() => {
    for (const p of allAbsolute)
      consume(compileJSONPointer(p));
    for (const p of allRelative)
      consume(compileRelativeJSONPointer(p));
  }, compileIterations);
  const npmCompileNs = measureNsPerOp(() => {
    for (const p of allAbsolute) {
      if (p !== '')
        consume(jsonpointerNpm.compile(p));
    }
  }, compileIterations);
  console.log(`\ncompile cost: jaren ${formatNs(compileNs)} for ${allAbsolute.length + allRelative.length} pointers, `
    + `jsonpointer npm ${formatNs(npmCompileNs)} for ${allAbsolute.length - 1} pointers`);

  console.log(`\n(sink: ${sink > 0 ? 'ok' : 'ZERO - results were not consumed!'})\n`);
}

main();
