#!/usr/bin/env node

/**
 * Jaren JSON Query Performance Benchmark
 *
 * Runs the QUERY-FORMAT.md scenario matrix against the Jaren JSON Query
 * engine and contender engines (fontoxpath — real XQuery 3.1 in JS — and
 * jsonata), asserting result equivalence before any timing. Each engine
 * expresses the same scenario idiomatically in its own language; see the
 * adaptor files in benchmark/adaptors/jsonquery/ for the exact queries
 * and the per-engine fairness notes (document pre-conversion, async
 * evaluation, ordering normalization).
 *
 * This is a separate tool from jsonpath.js on purpose: jsonpath.js is
 * wired to the JSONPath compliance suite; the query engine's compliance
 * story is the QT3 harness (qt3-runner.js). This tool measures the
 * engine against alternatives on one scalable document family.
 *
 * Usage:
 *   node benchmark/jsonquery.js                      # equivalence check, all engines
 *   node benchmark/jsonquery.js join                 # only scenarios whose key contains 'join'
 *   node benchmark/jsonquery.js --profile            # performance comparison + compile times
 *   node benchmark/jsonquery.js --profile --scale    # add 1000- and 10000-book documents
 *   node benchmark/jsonquery.js --profile --iterations 5000
 *   node benchmark/jsonquery.js --engines jaren,jsonata
 *   node benchmark/jsonquery.js --profile --output json --filepath results.json
 *
 * Exit code is non-zero when any engine disagrees with Jaren on a
 * scenario result (semantic mismatch — fail loud); n/a scenarios (a
 * contender lacking the construct) are reported, not failed.
 */

import * as fs from 'fs';
import { makeBookstoreDocuments } from './fixtures/bookstore.js';

const DEFAULT_ITERATIONS = 1000;
const WARMUP_ITERATIONS = 100;
const CELL_TIME_BUDGET_NS = 500e6; // ~0.5 s per (scenario, engine, document) cell
const CELL_TIME_FLOOR_NS = 50e6; // fast cells run extra iterations up to ~50 ms
const SCALE_SIZES = [1000, 10000];

//#region scenarios & documents

// Scenario keys must exist in every adaptor's `scenarios` map (value null
// marks an engine-side n/a). `maxBooks` caps the document size a scenario
// runs at. The join is capped at 1000 books, not 10000, because the
// *competitors* run it as a naive O(books x ratings) nested loop; Jaren
// hash-joins this shape, so raising the cap would grow their cost
// quadratically and Jaren's linearly, which measures the cap rather than
// the engines. The cap is printed alongside the row.
const SCENARIOS = [
  { key: 'singular', title: 'singular access' },
  { key: 'filter', title: 'filter + project (A.2)' },
  { key: 'join', title: 'join (A.3)', maxBooks: 1000 },
  { key: 'group', title: 'group + aggregate (A.4)' },
  { key: 'reshape', title: 'deep reshape' },
];

//#endregion

//#region engines

const ENGINE_KEYS = ['jaren', 'fontoxpath', 'jsonata'];

async function loadEngines(keys) {
  const engines = [];
  for (const key of keys) {
    if (!ENGINE_KEYS.includes(key)) {
      console.error(`Unknown engine '${key}'. Available: ${ENGINE_KEYS.join(', ')}`);
      process.exit(2);
    }
    try {
      const { load } = await import(`./adaptors/jsonquery/${key}.js`);
      engines.push(await load());
    }
    catch (e) {
      console.warn(`warning: engine '${key}' could not be loaded (${e.message}); skipping`);
    }
  }
  if (engines.length === 0 || engines[0].key !== 'jaren') {
    console.error('The jaren engine must be first in --engines; it is the equivalence reference.');
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
  if (ns >= 1e9) return `${(ns / 1e9).toFixed(2)} s`;
  if (ns >= 1e6) return `${(ns / 1e6).toFixed(2)} ms`;
  if (ns >= 1e3) return `${(ns / 1e3).toFixed(2)} µs`;
  return `${ns.toFixed(0)} ns`;
}

function formatRate(ns) {
  const ops = 1e9 / ns;
  if (ops >= 1e6) return `${(ops / 1e6).toFixed(1)}M/s`;
  if (ops >= 1e3) return `${(ops / 1e3).toFixed(1)}k/s`;
  return `${ops.toFixed(1)}/s`;
}

function pad(str, width) {
  return String(str).padEnd(width);
}

function padLeft(str, width) {
  return String(str).padStart(width);
}

//#endregion

//#region equivalence

/**
 * Run every scenario on every engine for one document and compare against
 * the jaren result. Returns rows and pushes mismatches into `failures`.
 */
async function runEquivalence(engines, scenarios, document, failures) {
  const jaren = engines[0];
  const contexts = new Map(engines.map((e) => [e.key, e.prepare(document.data)]));
  const rows = [];

  for (const scenario of scenarios) {
    if (scenario.maxBooks !== undefined && document.books > scenario.maxBooks)
      continue; // capped scenarios are handled (and reported) by the caller
    const reference = await Promise.resolve(
      jaren.scenarios[scenario.key].run(jaren.scenarios[scenario.key].compile(), contexts.get('jaren')));
    const row = { scenario: scenario.key, document: document.label, engines: {} };

    for (const engine of engines) {
      const impl = engine.scenarios[scenario.key];
      if (impl == null) {
        row.engines[engine.key] = 'n/a';
        continue;
      }
      let result;
      try {
        result = await Promise.resolve(impl.run(impl.compile(), contexts.get(engine.key)));
      }
      catch (e) {
        row.engines[engine.key] = 'ERROR';
        failures.push({ engine: engine.key, scenario: scenario.key, document: document.label, reason: `query threw: ${e.message}` });
        continue;
      }
      if (deepEquals(result, reference)) {
        row.engines[engine.key] = 'ok';
      }
      else {
        row.engines[engine.key] = 'MISMATCH';
        failures.push({
          engine: engine.key, scenario: scenario.key, document: document.label,
          reason: `got ${JSON.stringify(result).slice(0, 200)}, expected ${JSON.stringify(reference).slice(0, 200)}`,
        });
      }
    }
    rows.push(row);
  }
  return rows;
}

function printEquivalence(engines, allRows, failures, options) {
  const nameWidth = Math.max(26, ...allRows.map((r) => r.scenario.length + 2));
  const colWidth = Math.max(14, ...engines.map((e) => e.name.length + 2));

  let currentDoc = null;
  for (const row of allRows) {
    if (row.document !== currentDoc) {
      currentDoc = row.document;
      console.log(`\nResult equivalence — ${currentDoc}\n`);
      console.log(pad('scenario', nameWidth) + engines.map((e) => padLeft(e.name, colWidth)).join(''));
      console.log('-'.repeat(nameWidth + colWidth * engines.length));
    }
    console.log(pad(row.scenario, nameWidth) + engines.map((e) => padLeft(row.engines[e.key], colWidth)).join(''));
  }

  for (const engine of engines) {
    if (engine.notes === undefined)
      continue;
    for (const [scenario, note] of Object.entries(engine.notes))
      console.log(`\nnote [${engine.key}/${scenario}]: ${note}`);
  }

  if (failures.length > 0) {
    console.log(`\n${failures.length} mismatch(es)${options.verbose ? ':' : ' (use --verbose for details)'}`);
    if (options.verbose) {
      for (const f of failures) {
        console.log(`\n  [${f.engine}] ${f.scenario} on ${f.document}`);
        console.log(`    ${f.reason}`);
      }
    }
  }
  console.log();
}

//#endregion

//#region profile

const hrnow = () => process.hrtime.bigint();

/**
 * Time one (engine, scenario, document) cell. A single pilot run sizes the
 * iteration count: slow cells (10k-book documents) are cut down to the
 * cell budget, sub-microsecond cells are scaled up until the measurement
 * window is long enough to be stable.
 */
async function measureCell(engine, fn, requestedIterations) {
  let start = hrnow();
  await Promise.resolve(fn());
  const pilotNs = Math.max(1, Number(hrnow() - start));

  let iterations = requestedIterations;
  if (pilotNs * iterations > CELL_TIME_BUDGET_NS)
    iterations = Math.max(1, Math.floor(CELL_TIME_BUDGET_NS / pilotNs));
  else if (pilotNs * iterations < CELL_TIME_FLOOR_NS)
    iterations = Math.ceil(CELL_TIME_FLOOR_NS / pilotNs);

  const warmup = Math.min(WARMUP_ITERATIONS, iterations);
  if (engine.isAsync) {
    for (let i = 0; i < warmup; i++)
      await fn();
    start = hrnow();
    for (let i = 0; i < iterations; i++)
      await fn();
  }
  else {
    for (let i = 0; i < warmup; i++)
      fn();
    start = hrnow();
    for (let i = 0; i < iterations; i++)
      fn();
  }
  return { ns: Number(hrnow() - start) / iterations, iterations };
}

async function runProfile(engines, scenarios, documents, options) {
  const rows = [];
  for (const document of documents) {
    const contexts = new Map(engines.map((e) => [e.key, e.prepare(document.data)]));
    for (const scenario of scenarios) {
      const row = { scenario: scenario.key, document: document.label, engines: {}, iterations: {} };
      if (scenario.maxBooks !== undefined && document.books > scenario.maxBooks) {
        row.capped = scenario.maxBooks;
        rows.push(row);
        continue;
      }
      for (const engine of engines) {
        const impl = engine.scenarios[scenario.key];
        if (impl == null) {
          row.engines[engine.key] = null;
          continue;
        }
        const compiled = impl.compile();
        const ctx = contexts.get(engine.key);
        const { ns, iterations } = await measureCell(engine, () => impl.run(compiled, ctx), options.iterations);
        row.engines[engine.key] = ns;
        row.iterations[engine.key] = iterations;
      }
      rows.push(row);
    }
  }
  return rows;
}

/**
 * Compile-time comparison over the scenarios every engine supports.
 * Adaptors expose `{ fn, baseline?, perCall }`; a baseline pass (same
 * calls, warm cache) is subtracted for engines without a compile-only API.
 */
function runCompileProfile(engines, options) {
  const sources = ['singular', 'filter', 'join', 'reshape'];
  const iterations = Math.max(50, Math.floor(options.iterations / 10));
  const results = {};
  for (const engine of engines) {
    const { fn, baseline, perCall } = engine.compileBench(sources);
    let start = hrnow();
    for (let i = 0; i < iterations; i++)
      fn(i);
    const freshNs = Number(hrnow() - start);
    let baseNs = 0;
    if (baseline !== undefined) {
      start = hrnow();
      for (let i = 0; i < iterations; i++)
        baseline(i);
      baseNs = Number(hrnow() - start);
    }
    results[engine.key] = Math.max(0, (freshNs - baseNs) / iterations / perCall);
  }
  return { sources, iterations, results };
}

function printProfile(engines, rows, compile, options) {
  const nameWidth = 26;
  const jarenWidth = 22;
  const rivalWidth = Math.max(26, ...engines.slice(1).map((e) => e.name.length + 12));

  console.log(`\nJaren JSON Query profile: ${options.iterations} iterations per cell (auto-reduced on big documents)\n`);

  let currentDoc = null;
  for (const row of rows) {
    if (row.document !== currentDoc) {
      currentDoc = row.document;
      console.log(`\n${currentDoc} — ns/op + ops/s, lower ns is better\n`);
      console.log(pad('scenario', nameWidth)
        + padLeft(engines[0].name, jarenWidth)
        + engines.slice(1).map((e) => padLeft(e.name, rivalWidth)).join(''));
      console.log('-'.repeat(nameWidth + jarenWidth + rivalWidth * (engines.length - 1)));
    }
    if (row.capped !== undefined) {
      console.log(pad(row.scenario, nameWidth) + `  skipped: naive O(n·m) join in the competitors; measured at ${row.capped} books`);
      continue;
    }
    const jarenNs = row.engines.jaren;
    const jarenCell = jarenNs == null ? 'n/a' : `${formatNs(jarenNs)}  ${formatRate(jarenNs)}`;
    const rivalCells = engines.slice(1).map((e) => {
      const ns = row.engines[e.key];
      if (ns == null)
        return padLeft('n/a', rivalWidth);
      const ratio = jarenNs != null ? `  ${(ns / jarenNs).toFixed(1)}x` : '';
      return padLeft(`${formatNs(ns)}  ${formatRate(ns)}${ratio}`, rivalWidth);
    });
    console.log(pad(row.scenario, nameWidth) + padLeft(jarenCell, jarenWidth) + rivalCells.join(''));
  }

  console.log(`\nCompile time per query (mean over ${compile.sources.join('/')}, ${compile.iterations} rounds)\n`);
  for (const engine of engines) {
    const ns = compile.results[engine.key];
    const ratio = engine.key === 'jaren' ? '' : `   ${(ns / compile.results.jaren).toFixed(1)}x vs jaren`;
    console.log(`  ${pad(engine.name, 22)} ${padLeft(formatNs(ns), 12)}${ratio}`);
  }
  console.log('\n  (jaren compiles from JSON text — JSON.parse included; fontoxpath has no');
  console.log('   compile-only API, so its number is fresh-source evaluation minus a cached');
  console.log('   re-evaluation on a tiny document; jsonata\'s is jsonata(source).)');
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
      node: process.version,
      engines: engines.map((e) => e.name),
      ...data,
    }, null, 2);
  }
  else { // csv
    const lines = [['document', 'scenario', ...engines.map((e) => `${e.name} ns/op`)].join(',')];
    for (const row of data.rows ?? []) {
      lines.push([JSON.stringify(row.document), JSON.stringify(row.scenario),
        ...engines.map((e) => row.engines[e.key] ?? '')].join(','));
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
    engines: ENGINE_KEYS,
    output: 'console',
    filepath: null,
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
Jaren JSON Query Performance Benchmark

Usage:
  node benchmark/jsonquery.js [scenario-filter] [options]

Arguments:
  scenario-filter        Only run scenarios whose key contains this string
                         (${SCENARIOS.map((s) => s.key).join(', ')})

Options:
  --profile              Profile query performance (equivalence is asserted first)
  --scale                Add ${SCALE_SIZES.join('- and ')}-book documents
  --iterations, -i N     Requested iterations per cell (default: ${DEFAULT_ITERATIONS};
                         auto-reduced per cell to a ~0.5 s budget)
  --engines a,b          Engines to run, jaren first (default: ${ENGINE_KEYS.join(',')})
  --verbose, -v          Show every mismatch in detail
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

  let scenarios = SCENARIOS;
  if (options.filter !== null) {
    scenarios = scenarios.filter((s) => s.key.includes(options.filter));
    if (scenarios.length === 0) {
      console.error(`No scenarios match filter '${options.filter}'.`);
      process.exit(2);
    }
  }

  const engines = await loadEngines(options.engines);
  const documents = makeBookstoreDocuments(options.scale, SCALE_SIZES);

  // equivalence is always asserted, before any timing (fail loud)
  const failures = [];
  const equivalenceRows = [];
  for (const document of documents)
    equivalenceRows.push(...await runEquivalence(engines, scenarios, document, failures));
  printEquivalence(engines, equivalenceRows, failures, options);
  if (failures.length > 0) {
    console.error('Result equivalence failed; not timing semantically different queries.');
    process.exit(1);
  }

  if (options.profile) {
    const rows = await runProfile(engines, scenarios, documents, options);
    const compile = runCompileProfile(engines, options);
    printProfile(engines, rows, compile, options);
    writeResults('profile', engines, { rows, compile }, options);
    return;
  }

  writeResults('equivalence', engines, { rows: equivalenceRows }, options);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

//#endregion
