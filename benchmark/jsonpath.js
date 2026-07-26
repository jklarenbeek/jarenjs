#!/usr/bin/env node

/**
 * JarenJS JSONPath (RFC 9535) Compliance & Performance Benchmark
 *
 * Runs the official JSONPath Compliance Test Suite (the git submodule at
 * benchmark/jsonpath-suite/, from
 * https://github.com/jsonpath-standard/jsonpath-compliance-test-suite)
 * against Jaren's JSONPath compiler and any contender engines, then
 * optionally profiles query performance per test case.
 *
 * This is a separate tool from profiler.js on purpose: profiler.js is
 * wired to JSON Schema drafts, remotes and schema adaptors, none of
 * which apply to JSONPath queries.
 *
 * Usage:
 *   node benchmark/jsonpath.js                        # compliance run, all engines
 *   node benchmark/jsonpath.js 'functions, match'     # only tests whose name contains the string
 *   node benchmark/jsonpath.js --verbose              # show every failure in detail
 *   node benchmark/jsonpath.js --profile              # performance comparison on CTS queries
 *   node benchmark/jsonpath.js --profile --iterations 5000
 *   node benchmark/jsonpath.js --profile --top 10     # show only top N slowest queries
 *   node benchmark/jsonpath.js --profile --scale      # add synthetic large-document scenarios
 *   node benchmark/jsonpath.js --engines jaren        # restrict engines (comma-separated)
 *   node benchmark/jsonpath.js --output json --filepath results.json
 *   node benchmark/jsonpath.js --output csv --filepath results.csv
 *
 * Exit code is non-zero when Jaren fails a compliance test; contender
 * failures never affect the exit code.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CTS_PATH = path.join(__dirname, 'jsonpath-suite', 'cts.json');

const DEFAULT_ITERATIONS = 1000;
const WARMUP_ITERATIONS = 100;

//#region engines

// Each engine adaptor: compile(selector) throws on an invalid selector;
// query(compiled, document) returns the nodelist as an array of values;
// paths(compiled, document) is optional and must return RFC 9535
// normalized paths (only engines that produce them are checked).
//
// `first`/`exists` are ARRAYS of routes to the same answer, and the
// early-exit profile reports the FASTEST of an engine's routes per
// selector. Picking one route per engine ourselves would decide the
// result: json-p3's match() is its purpose-built first-match call, yet
// its plain query() beats it on a singular selector and its lazyQuery()
// generator beats it on a descendant one. Measuring every route and
// taking the best means a rival can never be made to look slow by a
// choice of ours, and the same rule is applied to Jaren.
const ENGINE_LOADERS = {
  jaren: async () => {
    const { compileJSONPath } = await import('@jarenjs/json');
    return {
      key: 'jaren',
      name: 'Jaren',
      compile: (selector) => compileJSONPath(selector),
      query: (compiled, document) => compiled(document),
      paths: (compiled, document) => compiled.paths(document),
      first: [
        (compiled, document) => compiled.first(document),
        (compiled, document) => compiled.iterate(document).next().value,
        (compiled, document) => compiled(document)[0],
      ],
      exists: [
        (compiled, document) => compiled.exists(document),
        (compiled, document) => compiled(document).length !== 0,
      ],
    };
  },
  'json-p3': async () => {
    const p3 = await import('json-p3');
    return {
      key: 'json-p3',
      name: `json-p3@${p3.version}`,
      compile: (selector) => p3.compile(selector),
      query: (compiled, document) => compiled.query(document).values(),
      // json-p3 paths are dotted (e.g. $.a[0]), not RFC-normalized; skip
      first: [
        (compiled, document) => compiled.match(document),
        (compiled, document) => compiled.lazyQuery(document).next().value,
        (compiled, document) => compiled.query(document).values()[0],
      ],
      exists: [
        (compiled, document) => compiled.match(document) !== undefined,
        (compiled, document) => compiled.lazyQuery(document).next().done === false,
        (compiled, document) => !compiled.query(document).empty(),
      ],
    };
  },
};

async function loadEngines(keys) {
  const engines = [];
  for (const key of keys) {
    const loader = ENGINE_LOADERS[key];
    if (loader === undefined) {
      console.error(`Unknown engine '${key}'. Available: ${Object.keys(ENGINE_LOADERS).join(', ')}`);
      process.exit(2);
    }
    try {
      engines.push(await loader());
    }
    catch (e) {
      console.warn(`warning: engine '${key}' could not be loaded (${e.message}); skipping`);
    }
  }
  if (engines.length === 0) {
    console.error('No engines could be loaded.');
    process.exit(2);
  }
  return engines;
}

//#endregion

//#region helpers

function deepEquals(a, b) {
  if (a === b)
    return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null)
    return false;
  const aIsArray = Array.isArray(a);
  if (aIsArray !== Array.isArray(b))
    return false;
  if (aIsArray) {
    if (a.length !== b.length)
      return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEquals(a[i], b[i]))
        return false;
    }
    return true;
  }
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length)
    return false;
  for (const key of aKeys) {
    if (!Object.hasOwn(b, key) || !deepEquals(a[key], b[key]))
      return false;
  }
  return true;
}

function formatNs(ns) {
  if (ns >= 1e6) return `${(ns / 1e6).toFixed(2)} ms`;
  if (ns >= 1e3) return `${(ns / 1e3).toFixed(2)} µs`;
  return `${ns.toFixed(0)} ns`;
}

function pad(str, width) {
  return String(str).padEnd(width);
}

function padLeft(str, width) {
  return String(str).padStart(width);
}

function groupOf(testName) {
  return testName.split(',')[0].trim();
}

//#endregion

//#region compliance

/**
 * Run one CTS case against one engine.
 * @returns {{ ok: boolean, reason?: string }}
 */
function runComplianceCase(engine, test) {
  if (test.invalid_selector === true) {
    try {
      engine.compile(test.selector);
      return { ok: false, reason: 'invalid selector was accepted' };
    }
    catch {
      return { ok: true };
    }
  }

  let compiled;
  try {
    compiled = engine.compile(test.selector);
  }
  catch (e) {
    return { ok: false, reason: `valid selector was rejected: ${e.message}` };
  }

  let values;
  try {
    values = engine.query(compiled, test.document);
  }
  catch (e) {
    return { ok: false, reason: `query threw: ${e.message}` };
  }

  const expected = test.results ?? [test.result];
  const matchIndex = expected.findIndex((alt) => deepEquals(values, alt));
  if (matchIndex < 0) {
    return {
      ok: false,
      reason: `got ${JSON.stringify(values)}, expected ${expected.map((e) => JSON.stringify(e)).join(' or ')}`,
    };
  }

  // engines that produce RFC 9535 normalized paths are held to them;
  // the matched values alternative fixes which paths alternative applies
  if (engine.paths !== undefined) {
    const expectedPaths = test.results_paths?.[matchIndex] ?? test.result_paths;
    if (expectedPaths !== undefined) {
      let paths;
      try {
        paths = engine.paths(compiled, test.document);
      }
      catch (e) {
        return { ok: false, reason: `paths threw: ${e.message}` };
      }
      if (!deepEquals(paths, expectedPaths)) {
        return {
          ok: false,
          reason: `paths ${JSON.stringify(paths)}, expected ${JSON.stringify(expectedPaths)}`,
        };
      }
    }
  }

  return { ok: true };
}

function runCompliance(engines, tests) {
  const groups = new Map(); // group -> { total, pass: Map<engineKey, count> }
  const failures = []; // { engine, test, reason }

  for (const test of tests) {
    const group = groupOf(test.name);
    let entry = groups.get(group);
    if (entry === undefined) {
      entry = { total: 0, pass: new Map(engines.map((e) => [e.key, 0])) };
      groups.set(group, entry);
    }
    entry.total++;

    for (const engine of engines) {
      const result = runComplianceCase(engine, test);
      if (result.ok)
        entry.pass.set(engine.key, entry.pass.get(engine.key) + 1);
      else
        failures.push({ engine: engine.key, name: test.name, selector: test.selector, reason: result.reason });
    }
  }

  return { groups, failures };
}

function printCompliance(engines, tests, groups, failures, options) {
  const nameWidth = Math.max(20, ...[...groups.keys()].map((g) => g.length + 2));
  const colWidth = Math.max(12, ...engines.map((e) => e.name.length + 2));

  console.log(`\nJSONPath Compliance Test Suite: ${tests.length} tests${options.filter ? ` (filter: '${options.filter}')` : ''}\n`);
  console.log(pad('group', nameWidth) + engines.map((e) => padLeft(e.name, colWidth)).join(''));
  console.log('-'.repeat(nameWidth + colWidth * engines.length));

  for (const [group, entry] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const cols = engines.map((e) => {
      const passed = entry.pass.get(e.key);
      const mark = passed === entry.total ? ' ' : '*';
      return padLeft(`${passed}/${entry.total}${mark}`, colWidth);
    });
    console.log(pad(group, nameWidth) + cols.join(''));
  }

  console.log('-'.repeat(nameWidth + colWidth * engines.length));
  const totals = engines.map((e) => {
    let passed = 0;
    for (const entry of groups.values())
      passed += entry.pass.get(e.key);
    return padLeft(`${passed}/${tests.length}`, colWidth);
  });
  console.log(pad('TOTAL', nameWidth) + totals.join(''));

  if (failures.length > 0) {
    console.log(`\n${failures.length} failure(s)${options.verbose ? ':' : ' (use --verbose for details)'}`);
    if (options.verbose) {
      for (const f of failures) {
        console.log(`\n  [${f.engine}] ${f.name}`);
        console.log(`    selector: ${f.selector}`);
        console.log(`    ${f.reason}`);
      }
    }
  }
  console.log();
}

//#endregion

//#region profile

function measureNsPerOp(fn, iterations) {
  for (let i = 0; i < WARMUP_ITERATIONS; i++)
    fn();
  const start = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++)
    fn();
  const end = process.hrtime.bigint();
  return Number(end - start) / iterations;
}

function makeScaleDocument(items) {
  const document = { items: [] };
  for (let i = 0; i < items; i++) {
    document.items.push({
      id: i,
      name: `item-${i}`,
      price: (i * 7919) % 1000 / 10,
      tags: ['alpha', 'beta', i % 2 === 0 ? 'even' : 'odd'],
      nested: { deep: { value: i } },
    });
  }
  return document;
}

const SCALE_QUERIES = [
  '$.items[42].name',
  '$.items[*].id',
  '$.items[100:200].id',
  '$.items[?@.price < 10].name',
  '$.items[?match(@.name, "item-1.*")].id',
  '$..value',
];

// Selectors for the early-exit scenarios, run against the same document
// as SCALE_QUERIES so the two tables read directly against each other:
// what the full nodelist costs, and what only wanting the first answer
// costs. The singular selector is the control - it addresses one node
// either way, so there is nothing for early exit to win there.
const EARLY_EXIT_QUERIES = [
  '$.items[42].name',
  '$.items[*].id',
  '$.items[?@.price < 10].name',
  '$..value',
];

const EARLY_EXIT_OPS = ['first', 'exists'];

function runProfile(engines, tests, options) {
  const rows = [];

  // per-CTS-case query timing (valid selectors only)
  for (const test of tests) {
    if (test.invalid_selector === true)
      continue;
    const row = { name: test.name, selector: test.selector, engines: {} };
    for (const engine of engines) {
      try {
        const compiled = engine.compile(test.selector);
        row.engines[engine.key] = measureNsPerOp(() => engine.query(compiled, test.document), options.iterations);
      }
      catch {
        row.engines[engine.key] = null; // engine cannot run this query
      }
    }
    rows.push(row);
  }

  // compile-time benchmark over all valid selectors
  const validSelectors = tests.filter((t) => t.invalid_selector !== true).map((t) => t.selector);
  const compileRow = { name: `compile all ${validSelectors.length} valid selectors`, selector: '(compile)', engines: {} };
  for (const engine of engines) {
    compileRow.engines[engine.key] = measureNsPerOp(() => {
      for (const selector of validSelectors)
        engine.compile(selector);
    }, Math.max(10, Math.floor(options.iterations / 100)));
  }

  // synthetic large-document scenarios
  const scaleRows = [];
  const earlyExitRows = [];
  if (options.scale) {
    const document = makeScaleDocument(1000);
    const scaleIterations = Math.max(100, Math.floor(options.iterations / 10));
    for (const selector of SCALE_QUERIES) {
      const row = { name: 'scale(1000 items)', selector, engines: {} };
      for (const engine of engines) {
        try {
          const compiled = engine.compile(selector);
          row.engines[engine.key] = measureNsPerOp(() => engine.query(compiled, document), scaleIterations);
        }
        catch {
          row.engines[engine.key] = null;
        }
      }
      scaleRows.push(row);
    }

    for (const op of EARLY_EXIT_OPS) {
      for (const selector of EARLY_EXIT_QUERIES) {
        const row = { name: op, selector, label: `${op}: ${selector}`, engines: {} };
        for (const engine of engines) {
          const routes = engine[op];
          // no early-exit entry point at all: the engine has no answer
          // here that is not the full nodelist, and saying so is the point
          if (routes === undefined) {
            row.engines[engine.key] = null;
            continue;
          }
          let best = null;
          for (const run of routes) {
            try {
              const compiled = engine.compile(selector);
              const ns = measureNsPerOp(() => run(compiled, document), scaleIterations);
              if (best === null || ns < best)
                best = ns;
            }
            catch {
              // this route cannot run this selector; the others may
            }
          }
          row.engines[engine.key] = best;
        }
        earlyExitRows.push(row);
      }
    }
  }

  return { rows, compileRow, scaleRows, earlyExitRows };
}

function printProfileTable(engines, rows, title) {
  const labelOf = (row) => row.label ?? row.selector;
  const selWidth = Math.min(56, Math.max(28, ...rows.map((r) => labelOf(r).length + 2)));
  const colWidth = Math.max(14, ...engines.map((e) => e.name.length + 2));

  console.log(`\n${title}\n`);
  console.log(pad('selector', selWidth) + engines.map((e) => padLeft(e.name, colWidth)).join('') + padLeft('vs jaren', 10));
  console.log('-'.repeat(selWidth + colWidth * engines.length + 10));

  for (const row of rows) {
    const label = labelOf(row);
    const selector = label.length > selWidth - 2 ? label.slice(0, selWidth - 5) + '...' : label;
    const cols = engines.map((e) => {
      const ns = row.engines[e.key];
      return padLeft(ns === null ? 'n/a' : formatNs(ns), colWidth);
    });
    const jarenNs = row.engines.jaren;
    const otherNs = engines.filter((e) => e.key !== 'jaren').map((e) => row.engines[e.key]).find((v) => v != null);
    const ratio = (jarenNs != null && otherNs != null) ? padLeft(`${(otherNs / jarenNs).toFixed(1)}x`, 10) : padLeft('-', 10);
    console.log(pad(selector, selWidth) + cols.join('') + ratio);
  }
}

function printProfile(engines, profile, options) {
  const { rows, compileRow, scaleRows, earlyExitRows } = profile;

  // summary: totals and mean ratio vs jaren
  console.log(`\nJSONPath query profile: ${rows.length} CTS queries, ${options.iterations} iterations each\n`);
  const colWidth = Math.max(16, ...engines.map((e) => e.name.length + 2));
  console.log(pad('engine', colWidth) + padLeft('total', 14) + padLeft('mean/query', 14) + padLeft('vs jaren', 10));
  console.log('-'.repeat(colWidth + 14 + 14 + 10));
  const totals = {};
  for (const engine of engines) {
    let total = 0;
    let count = 0;
    for (const row of rows) {
      const ns = row.engines[engine.key];
      if (ns != null) {
        total += ns;
        count++;
      }
    }
    totals[engine.key] = { total, count };
  }
  for (const engine of engines) {
    const { total, count } = totals[engine.key];
    const ratio = engine.key === 'jaren' ? '1.0x' : `${(total / totals.jaren.total).toFixed(1)}x`;
    console.log(
      pad(engine.name, colWidth)
      + padLeft(formatNs(total), 14)
      + padLeft(formatNs(total / count), 14)
      + padLeft(ratio, 10));
  }

  // compile cost
  console.log();
  console.log(pad('compile (all valid selectors once)', 40)
    + engines.map((e) => `${e.name}: ${formatNs(compileRow.engines[e.key])}`).join('   '));

  // top-N slowest queries for jaren
  const top = options.top ?? 15;
  const slowest = [...rows]
    .filter((r) => r.engines.jaren != null)
    .sort((a, b) => b.engines.jaren - a.engines.jaren)
    .slice(0, top);
  printProfileTable(engines, slowest, `Top ${slowest.length} slowest CTS queries (by Jaren time, ns/op lower is better)`);

  if (scaleRows.length > 0)
    printProfileTable(engines, scaleRows, 'Synthetic 1000-item document scenarios');

  if (earlyExitRows.length > 0) {
    printProfileTable(engines, earlyExitRows,
      'Early exit on the same 1000-item document (first match / any match)');
    console.log('\n  Compare against the table above: those rows build the whole nodelist,');
    console.log('  these ask only for the first answer. Each engine is timed on the');
    console.log('  FASTEST of its own routes to that answer, so no rival is held to a');
    console.log('  route it would not use. A singular selector addresses one node either');
    console.log('  way and is the control row: there is nothing there for early exit to win.');
  }

  console.log();
}

//#endregion

//#region output files

function writeResults(mode, engines, data, options) {
  if (options.output === 'console' || options.filepath === null)
    return;

  let content;
  if (options.output === 'json') {
    content = JSON.stringify({
      mode,
      date: new Date().toISOString(),
      engines: engines.map((e) => e.name),
      ...data,
    }, null, 2);
  }
  else { // csv
    const lines = [];
    if (mode === 'compliance') {
      lines.push(['group', ...engines.map((e) => e.name), 'total'].join(','));
      for (const [group, entry] of data.groups)
        lines.push([JSON.stringify(group), ...engines.map((e) => entry.pass[e.key]), entry.total].join(','));
    }
    else {
      lines.push(['name', 'selector', ...engines.map((e) => `${e.name} ns/op`)].join(','));
      for (const row of [...data.rows, ...data.scaleRows, ...data.earlyExitRows])
        lines.push([JSON.stringify(row.name), JSON.stringify(row.selector), ...engines.map((e) => row.engines[e.key] ?? '')].join(','));
    }
    content = lines.join('\n') + '\n';
  }

  fs.writeFileSync(options.filepath, content);
  console.log(`Results written to ${options.filepath}`);
}

//#endregion

//#region cli

function parseArgs(argv) {
  const options = {
    profile: false,
    verbose: false,
    scale: false,
    iterations: DEFAULT_ITERATIONS,
    engines: Object.keys(ENGINE_LOADERS),
    output: 'console',
    filepath: null,
    top: null,
    filter: null,
    help: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--profile': options.profile = true; break;
      case '--verbose': case '-v': options.verbose = true; break;
      case '--scale': options.scale = true; break;
      case '--iterations': case '-i': options.iterations = parseInt(argv[++i], 10); break;
      case '--engines': options.engines = argv[++i].split(',').map((s) => s.trim()); break;
      case '--output': case '-o': options.output = argv[++i]; break;
      case '--filepath': case '-f': options.filepath = argv[++i]; break;
      case '--top': options.top = parseInt(argv[++i], 10); break;
      case '--help': case '-h': options.help = true; break;
      default:
        if (arg.startsWith('--')) {
          console.error(`Unknown option: ${arg}`);
          process.exit(2);
        }
        options.filter = arg;
    }
  }
  return options;
}

function printHelp() {
  console.log(`
JSONPath (RFC 9535) Compliance & Performance Benchmark

Usage:
  node benchmark/jsonpath.js [filter] [options]

Arguments:
  filter                 Only run tests whose name contains this string

Options:
  --profile              Profile query performance instead of checking compliance
  --verbose, -v          Show every compliance failure in detail
  --iterations, -i N     Iterations per profiled query (default: ${DEFAULT_ITERATIONS})
  --top N                Show top N slowest queries in profile mode (default: 15)
  --scale                Add synthetic 1000-item document scenarios to the profile
                         (full nodelist, plus first-match/exists early exit)
  --engines a,b          Engines to run (default: ${Object.keys(ENGINE_LOADERS).join(',')})
  --output, -o FORMAT    Output format: console, csv, json (default: console)
  --filepath, -f PATH    Output file path for csv/json
  --help, -h             Show this help
`);
}

async function main() {
  const options = parseArgs(process.argv);
  if (options.help) {
    printHelp();
    return;
  }

  if (!fs.existsSync(CTS_PATH)) {
    console.error(`Compliance suite not found at ${CTS_PATH}.`);
    console.error('The suite is a git submodule; initialize it with:');
    console.error('  git submodule update --init benchmark/jsonpath-suite');
    process.exit(2);
  }

  const cts = JSON.parse(fs.readFileSync(CTS_PATH, 'utf8'));
  let tests = cts.tests;
  if (options.filter !== null)
    tests = tests.filter((t) => t.name.includes(options.filter));
  if (tests.length === 0) {
    console.error(`No tests match filter '${options.filter}'.`);
    process.exit(2);
  }

  const engines = await loadEngines(options.engines);

  if (options.profile) {
    const profile = runProfile(engines, tests, options);
    printProfile(engines, profile, options);
    writeResults('profile', engines, profile, options);
    return;
  }

  const { groups, failures } = runCompliance(engines, tests);
  printCompliance(engines, tests, groups, failures, options);
  // entry.pass is a Map (fine for csv, which reads it in-process); JSON
  // serialization needs plain objects.
  writeResults('compliance', engines, {
    total: tests.length,
    groups: [...groups.entries()].map(([group, entry]) => [
      group,
      { total: entry.total, pass: Object.fromEntries(entry.pass) },
    ]),
    failures,
  }, options);

  if (failures.some((f) => f.engine === 'jaren'))
    process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

//#endregion
