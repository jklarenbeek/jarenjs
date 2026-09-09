#!/usr/bin/env node

/**
 * Jaren JSLT Performance Benchmark
 *
 * Runs a scalable transformation matrix against Jaren JSLT, hand-written
 * recursive JavaScript, and JSONata's transform operator. Result
 * equivalence is asserted before any timing.
 *
 * fontoxpath is excluded because it implements XPath/XQuery, not XSLT or
 * another template dispatcher. Saxon-JS is excluded because its SEF/XSLT
 * toolchain is heavyweight for this zero-build benchmark workspace. Both
 * exclusions are methodology choices, not performance claims.
 *
 * Usage:
 *   node benchmark/jslt.js
 *   node benchmark/jslt.js surgical
 *   node benchmark/jslt.js --profile
 *   node benchmark/jslt.js --profile --scale
 *   node benchmark/jslt.js --profile --iterations 5000
 *   node benchmark/jslt.js --filter surgical
 *   node benchmark/jslt.js --engines jaren,native
 *   node benchmark/jslt.js --profile --output json --filepath results.json
 *
 * Exit code is non-zero when an expressible contender result differs
 * from Jaren. Unsupported cells are printed as n/a, never hidden.
 */

import { makeBookstoreDocuments } from './fixtures/bookstore.js';
import { deepEquals } from './lib/equals.js';
import { pad, padLeft, formatNs, formatRate } from './lib/fmt.js';
import { measureCell as measureCellLib } from './lib/measure.js';
import { parseSuiteArgs } from './lib/args.js';
import { writeEngineResults } from './lib/results.js';

const DEFAULT_ITERATIONS = 1000;
const WARMUP_ITERATIONS = 100;
const CELL_TIME_BUDGET_NS = 500e6;
const CELL_TIME_FLOOR_NS = 50e6;
const SCALE_SIZES = [1000, 10000];

const SCENARIOS = [
  {
    key: 'identity',
    title: 'identity (share vs deep copy)',
  },
  {
    key: 'surgical',
    title: 'surgical ($..price × 1.21)',
  },
  {
    key: 'reshape',
    title: 'reshape + two modes',
  },
  {
    key: 'annotate',
    title: 'fresh schema annotation',
  },
];

const ENGINE_KEYS = ['jaren', 'native', 'jsonata'];

function makeDocuments(scale) {
  const documents = makeBookstoreDocuments(scale, SCALE_SIZES);
  // The query benchmark's tiny per-index epsilon makes sort keys unique.
  // JSLT does not sort, and JSONata's transform deep-copy normalizes those
  // long binary decimal tails. Round generated prices to ordinary cents so
  // exact result comparison measures transforms, not numeric re-encoding.
  for (let i = 0; i < documents.length; i++) {
    const books = documents[i].data.store.book;
    for (let j = 0; j < books.length; j++)
      books[j].price = Math.round(books[j].price * 100) / 100;
  }
  return documents;
}

//#region engines

async function loadEngines(keys) {
  const engines = [];
  for (const key of keys) {
    if (!ENGINE_KEYS.includes(key)) {
      console.error(`Unknown engine '${key}'. Available: ${ENGINE_KEYS.join(', ')}`);
      process.exit(2);
    }
    try {
      const { load } = await import(`./adaptors/jslt/${key}.js`);
      engines.push(await load());
    }
    catch (error) {
      console.warn(
        `warning: engine '${key}' could not be loaded (${error.message}); skipping`);
    }
  }
  if (engines.length === 0 || engines[0].key !== 'jaren') {
    console.error(
      'The jaren engine must be first in --engines; it is the equivalence reference.');
    process.exit(2);
  }
  return engines;
}

//#endregion

//#region helpers

function formatRatio(ratio) {
  if (ratio < 0.1)
    return `${ratio.toFixed(3)}x`;
  if (ratio < 1)
    return `${ratio.toFixed(2)}x`;
  return `${ratio.toFixed(1)}x`;
}

//#endregion

//#region equivalence

async function runEquivalence(engines, scenarios, document, failures) {
  const contexts = new Map(
    engines.map((engine) => [engine.key, engine.prepare(document.data)]));
  const rows = [];

  for (const scenario of scenarios) {
    const referenceImpl = engines[0].scenarios[scenario.key];
    const referenceContext = contexts.get('jaren');
    const reference = await Promise.resolve(
      referenceImpl.run(referenceImpl.compile(), referenceContext));
    const row = {
      scenario: scenario.key,
      title: scenario.title,
      document: document.label,
      engines: {},
    };

    for (const engine of engines) {
      const impl = engine.scenarios[scenario.key];
      if (impl == null) {
        row.engines[engine.key] = 'n/a';
        continue;
      }
      const context = contexts.get(engine.key);
      let result;
      try {
        result = await Promise.resolve(impl.run(impl.compile(), context));
      }
      catch (error) {
        row.engines[engine.key] = 'ERROR';
        failures.push({
          engine: engine.key,
          scenario: scenario.key,
          document: document.label,
          reason: `transform threw: ${error.message}`,
        });
        continue;
      }

      let semanticFailure = null;
      if (!deepEquals(result, reference)) {
        semanticFailure =
          `got ${JSON.stringify(result).slice(0, 200)}, `
          + `expected ${JSON.stringify(reference).slice(0, 200)}`;
      }
      else if (scenario.key === 'identity'
        && engine.key === 'jaren' && result !== context) {
        semanticFailure = 'empty JSLT stylesheet did not return the input by reference';
      }
      else if (scenario.key === 'identity'
        && engine.key === 'native' && result === context) {
        semanticFailure = 'native identity baseline did not perform its required deep clone';
      }
      else if (scenario.key === 'identity'
        && engine.key === 'jsonata' && result === context) {
        semanticFailure = 'JSONata identity transform did not perform its transform-operator copy';
      }

      if (semanticFailure === null) {
        row.engines[engine.key] = 'ok';
      }
      else {
        row.engines[engine.key] = 'MISMATCH';
        failures.push({
          engine: engine.key,
          scenario: scenario.key,
          document: document.label,
          reason: semanticFailure,
        });
      }
    }
    rows.push(row);
  }
  return rows;
}

function printEquivalence(engines, rows, failures, options) {
  const nameWidth = Math.max(34, ...rows.map((row) => row.title.length + 2));
  const colWidth = Math.max(16, ...engines.map((engine) => engine.name.length + 2));
  let currentDocument = null;

  for (const row of rows) {
    if (row.document !== currentDocument) {
      currentDocument = row.document;
      console.log(`\nResult equivalence — ${currentDocument}\n`);
      console.log(
        pad('scenario', nameWidth)
        + engines.map((engine) => padLeft(engine.name, colWidth)).join(''));
      console.log('-'.repeat(nameWidth + colWidth * engines.length));
    }
    console.log(
      pad(row.title, nameWidth)
      + engines.map((engine) => padLeft(row.engines[engine.key], colWidth)).join(''));
  }

  for (const engine of engines) {
    if (engine.notes === undefined)
      continue;
    for (const [scenario, note] of Object.entries(engine.notes))
      console.log(`\nnote [${engine.key}/${scenario}]: ${note}`);
  }

  if (failures.length > 0) {
    console.log(
      `\n${failures.length} mismatch(es)`
      + (options.verbose ? ':' : ' (use --verbose for details)'));
    if (options.verbose) {
      for (const failure of failures) {
        console.log(
          `\n  [${failure.engine}] ${failure.scenario} on ${failure.document}`);
        console.log(`    ${failure.reason}`);
      }
    }
  }
  console.log();
}

//#endregion

//#region profile

const hrnow = () => process.hrtime.bigint();

const measureCell = (engine, fn, requestedIterations) => measureCellLib(
  engine, fn, requestedIterations,
  CELL_TIME_BUDGET_NS, CELL_TIME_FLOOR_NS, WARMUP_ITERATIONS);

async function runProfile(engines, scenarios, documents, options) {
  const rows = [];
  for (const document of documents) {
    const contexts = new Map(
      engines.map((engine) => [engine.key, engine.prepare(document.data)]));
    for (const scenario of scenarios) {
      const row = {
        scenario: scenario.key,
        title: scenario.title,
        document: document.label,
        engines: {},
        iterations: {},
      };
      for (const engine of engines) {
        const impl = engine.scenarios[scenario.key];
        if (impl == null) {
          row.engines[engine.key] = null;
          continue;
        }
        const compiled = impl.compile();
        const context = contexts.get(engine.key);
        const measured = await measureCell(
          engine,
          () => impl.run(compiled, context),
          options.iterations);
        row.engines[engine.key] = measured.ns;
        row.iterations[engine.key] = measured.iterations;
      }
      rows.push(row);
    }
  }
  return rows;
}

function runCompileProfile(engines, scenarios, options) {
  const sources = scenarios.map((scenario) => scenario.key);
  if (sources.length === 0)
    return null;

  const iterations = Math.max(50, Math.floor(options.iterations / 10));
  const results = {};
  for (const engine of engines) {
    if (typeof engine.compileBench !== 'function' || sources.some((key) => !engine.scenarios[key])) {
      results[engine.key] = null;
      continue;
    }
    const probe = engine.compileBench(sources);
    let start = hrnow();
    for (let i = 0; i < iterations; i++)
      probe.fn(i);
    const freshNs = Number(hrnow() - start);
    let baseNs = 0;
    if (probe.baseline !== undefined) {
      start = hrnow();
      for (let i = 0; i < iterations; i++)
        probe.baseline(i);
      baseNs = Number(hrnow() - start);
    }
    results[engine.key] =
      Math.max(0, (freshNs - baseNs) / iterations / probe.perCall);
  }
  return { sources, iterations, results };
}

function printProfile(engines, rows, compile, options) {
  const nameWidth = 34;
  const jarenWidth = 24;
  const rivalWidth = Math.max(
    32, ...engines.slice(1).map((engine) => engine.name.length + 18));

  console.log(
    `\nJaren JSLT profile: ${options.iterations} requested iterations per cell`
    + ' (adaptive on slow/fast cells)\n');

  let currentDocument = null;
  for (const row of rows) {
    if (row.document !== currentDocument) {
      currentDocument = row.document;
      console.log(`\n${currentDocument} — ns/op + ops/s, lower ns is better\n`);
      console.log(
        pad('scenario', nameWidth)
        + padLeft(engines[0].name, jarenWidth)
        + engines.slice(1)
          .map((engine) => padLeft(engine.name, rivalWidth)).join(''));
      console.log(
        '-'.repeat(
          nameWidth + jarenWidth + rivalWidth * (engines.length - 1)));
    }

    const jarenNs = row.engines.jaren;
    const jarenCell = jarenNs === null
      ? 'n/a'
      : `${formatNs(jarenNs)}  ${formatRate(jarenNs)}`;
    const rivalCells = engines.slice(1).map((engine) => {
      const ns = row.engines[engine.key];
      if (ns === null)
        return padLeft('n/a', rivalWidth);
      const ratio = jarenNs === null ? '' : `  ${formatRatio(ns / jarenNs)}`;
      return padLeft(
        `${formatNs(ns)}  ${formatRate(ns)}${ratio}`,
        rivalWidth);
    });
    console.log(
      pad(row.title, nameWidth)
      + padLeft(jarenCell, jarenWidth)
      + rivalCells.join(''));
  }

  if (compile !== null) {
    console.log(
      `\nCompile time per stylesheet (mean over ${compile.sources.join('/')}, `
      + `${compile.iterations} rounds)\n`);
    for (const engine of engines) {
      const ns = compile.results[engine.key];
      if (ns === null) {
        console.log(`  ${pad(engine.name, 22)} ${padLeft('n/a', 12)}`);
        continue;
      }
      const ratio = engine.key === 'jaren'
        ? ''
        : `   ${(ns / compile.results.jaren).toFixed(1)}x vs jaren`;
      console.log(
        `  ${pad(engine.name, 22)} ${padLeft(formatNs(ns), 12)}${ratio}`);
    }
  }

  console.log('\nMethodology:');
  console.log('  - Every expressible result is compared with Jaren before timing.');
  console.log('  - Stylesheets/expressions compile once outside runtime cells; input');
  console.log('    preparation is also outside the timed loop.');
  console.log('  - Identity is deliberately asymmetric: Jaren returns the input by');
  console.log('    reference in O(1); native JS and JSONata perform deep copies.');
  console.log('  - Native JS is a hand-written function per scenario, not a generic');
  console.log('    dispatcher. It therefore has no stylesheet compile-time number.');
  console.log('  - JSONata 2.x evaluation is async, so timed cells include its required');
  console.log('    promise overhead. Transform-operator cells deep-copy before updates;');
  console.log('    reshape+modes is n/a because that operator has no template modes.');
  console.log('  - Jaren compile timing starts from JSON text (JSON.parse included);');
  console.log('    JSONata timing starts from its expression text.');
  console.log('  - Iterations target a 50 ms floor and 0.5 s cap per cell. No scenario');
  console.log('    has a document-size cap in the current matrix.');
  console.log('  - Scaled generated prices are rounded to cents: JSONata deep-copy');
  console.log('    normalizes long binary decimal tails, and JSLT scenarios do not sort.');
  console.log('  - fontoxpath is XPath/XQuery-only; Saxon-JS is excluded as a heavyweight');
  console.log('    SEF/XSLT toolchain for this benchmark workspace.');
  console.log();
}

//#endregion

//#region output

const writeResults = writeEngineResults;

//#endregion

//#region cli

function parseArgs(argv) {
  const options = parseSuiteArgs(argv, {
    defaultIterations: DEFAULT_ITERATIONS,
    engines: ENGINE_KEYS,
    extra: (arg, next, opts) => {
      if (arg === '--filter') {
        opts.filter = next();
        return true;
      }
      return false;
    },
  });

  if (!['console', 'csv', 'json'].includes(options.output)) {
    console.error('--output must be console, csv, or json');
    process.exit(2);
  }
  return options;
}

function printHelp() {
  console.log(`
Jaren JSLT Performance Benchmark

Usage:
  node benchmark/jslt.js [scenario-filter] [options]

Arguments:
  scenario-filter        Only run scenarios whose key contains this string
                         (${SCENARIOS.map((scenario) => scenario.key).join(', ')})

Options:
  --profile              Profile transformations after equivalence checks
  --scale                Add ${SCALE_SIZES.join('- and ')}-book documents
  --iterations, -i N     Requested iterations per cell (default: ${DEFAULT_ITERATIONS};
                         adaptively sized to a 50 ms–0.5 s window)
  --filter TEXT          Scenario-filter option form
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
    scenarios = scenarios.filter(
      (scenario) => scenario.key.includes(options.filter));
    if (scenarios.length === 0) {
      console.error(`No scenarios match filter '${options.filter}'.`);
      process.exit(2);
    }
  }

  const engines = await loadEngines(options.engines);
  const documents = makeDocuments(options.scale);

  const failures = [];
  const equivalenceRows = [];
  for (const document of documents) {
    equivalenceRows.push(
      ...await runEquivalence(engines, scenarios, document, failures));
  }
  printEquivalence(engines, equivalenceRows, failures, options);
  if (failures.length > 0) {
    console.error(
      'Result equivalence failed; not timing semantically different transforms.');
    process.exit(1);
  }

  if (options.profile) {
    const rows = await runProfile(engines, scenarios, documents, options);
    const compile = runCompileProfile(engines, scenarios, options);
    printProfile(engines, rows, compile, options);
    writeResults('profile', engines, { rows, compile }, options);
    return;
  }

  writeResults(
    'equivalence',
    engines,
    { rows: equivalenceRows },
    options);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

//#endregion
