#!/usr/bin/env node

/**
 * Website benchmark data generator
 *
 * Runs every benchmark tool in this workspace with `--output json` and
 * assembles the data files the website's Benchmarks page loads from
 * `packages/website/public/benchmarks/`. Each suite keeps its own file so
 * the page can load them lazily per tab:
 *
 *   validate.json     profiler.js       — JSON Schema suite vs Ajv (per test)
 *   contracts.json    contracts.js      — contract validation vs Zod 4/3/mini and Ajv
 *   contract.json     contract.js       — @jarenjs/contract match + dispatch vs find-my-way/hono/Fastify
 *   jsonpath.json     jsonpath.js       — CTS compliance + per-query profile vs json-p3
 *   jsonquery.json    jsonquery.js      — scenario matrix vs fontoxpath/jsonata (+ sources)
 *   jslt.json         jslt.js           — scenario matrix vs native JS/JSONata (+ sources)
 *   formats.json      formats.js        — string `format` validation vs ajv-formats
 *   jsonpointer.json  jsonpointer.js    — compiled vs legacy vs jsonpointer npm
 *   jsonpatch.json    jsonpatch.js      — compiled COW patch/merge vs naive clone-and-interpret
 *   toml.json         toml.js           — JOSL strict-TOML vs smol-toml/@iarna/toml/toml (toml-test)
 *                     jsonx-stream.js   — the JSONX streaming reader, merged into toml.json as `stream`
 *   csv.json          csv.js            — CSV reader/writer vs udsv/csv-parse/d3-dsv
 *   markdown.json     markdown.js       — @jarenjs/md vs marked/markdown-it/micromark (CommonMark spec)
 *   mermaid.json      mermaid.js        — @jarenjs/mermaid coverage + parse-speed vs @mermaid-js/parser
 *   view.json         view.js           — vnode building vs React/hyperapp/preact + engine decomposition
 *   charts.json       charts.js         — chart compile + SVG render throughput
 *   geo.json          geo.js            — spatial kernel vs turf/geolib/flatbush (equivalence-gated)
 *   flow.json         flow-fsm.js/-dag.js — FSM step + DAG run throughput vs XState
 *   db.json           db.js             — document store + pushdown vs PouchDB/RxDB/lowdb
 *   spatial.json      spatial.js        — spatial storage: $within every way it runs, corpus-gated (no head-to-head rival)
 *   orm.json          orm.js            — entities + graph loads vs Prisma/Drizzle/Kysely (Node + Bun)
 *   live.json         live.js           — live queries/capture/jobs vs RxDB/TinyBase (incremental vs re-run)
 *   long-horizon.json long-horizon.js   — agent context retention: needle + pairwise, ceiling and live model
 *   retrieval.json    retrieval.js      — did the right memory reach the prompt: recall@k + MRR per policy, oracle-gated
 *   vector.json       vector.js         — k-nearest over a stored vector column every way it runs, vs sqlite-vec, equivalence-gated
 *   series.json       series.js         — one temporal question every route a consumer has today, corpus-gated (no kernel row yet)
 *   meta.json                          — run metadata, conformance summary, QT3 scorecard
 *
 * meta.json is the one file here whose shape the website declares: it is
 * written through `serializeMeta`, which proves the assembled record
 * against the output schema of the site contract's `bench.meta`
 * operation before anything reaches disk. The per-suite payloads are
 * genuinely heterogeneous and the contract types them open, so they are
 * written as they are assembled.
 *
 * Usage:
 *   node benchmark/website-data.js                # full run (validator: 1000 iterations)
 *   node benchmark/website-data.js --quick        # fast smoke run (low iterations)
 *   node benchmark/website-data.js --iterations N # validator suite iterations
 *   node benchmark/website-data.js --skip qt3,jslt
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

import { Float64, geoMean } from '@jarenjs/core/math';

import { geoMeanRatio } from './derive.js';
import { assertSiteOutput, assertSuiteOutput } from '../scripts/lib/site-contract.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'packages', 'website', 'public', 'benchmarks');

//#region helpers

/** Refuse the invocation, naming the reason in one line. */
function refuse(reason) {
  console.error(reason);
  process.exit(2);
}

/**
 * A flag's value, refused unless it is really there: an option that
 * swallowed the NEXT FLAG, or accepted `abc` as a count, used to reach
 * the profiler as `NaN` and the published metadata as `null`.
 */
function flagValue(argv, i, flag) {
  const value = argv[i];
  if (value === undefined || value.startsWith('--'))
    refuse(`${flag} needs a value.`);
  return value;
}

function parseArgs(argv) {
  const options = { iterations: 1000, quick: false, skip: new Set() };
  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case '--iterations': case '-i': {
        const flag = argv[i];
        const value = flagValue(argv, ++i, flag);
        const count = Number(value);
        if (!Number.isInteger(count) || count <= 0)
          refuse(`--iterations needs a positive integer, got '${value}'.`);
        options.iterations = count;
        break;
      }
      case '--quick': options.quick = true; break;
      case '--skip': {
        const value = flagValue(argv, ++i, '--skip');
        for (const name of value.split(',')) {
          const suite = name.trim();
          if (suite !== '') options.skip.add(suite);
        }
        if (options.skip.size === 0) refuse('--skip needs at least one suite name.');
        break;
      }
      case '--help': case '-h':
        console.log('Usage: node benchmark/website-data.js [--quick] [--iterations N] [--skip suite,suite]');
        console.log('Suites: validate, contracts, contract, jsonpath, jsonquery, jslt, formats, jsonpointer, jsonpatch, toml, jsonx-stream, csv, markdown, mermaid, view, charts, geo, flow, db, spatial, orm, live, long-horizon, retrieval, vector, series, qt3');
        process.exit(0);
        break;
      default:
        console.error(`Unknown option: ${argv[i]}`);
        process.exit(2);
    }
  }
  // A quick partial run cannot be attributed at all: its rows would be
  // published as measurements beside carried full-run rows, at a tenth
  // of the iterations, under the same summary.
  if (options.quick && options.skip.size > 0)
    refuse('--quick cannot be combined with --skip: a quick partial run would publish low-iteration rows beside carried full-run ones.');
  if (options.quick)
    options.iterations = Math.min(options.iterations, 100);
  return options;
}

function runTool(args, { capture = false } = {}) {
  console.log(`\n$ node ${args.join(' ')}`);
  const result = spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0)
    throw new Error(`'node ${args.join(' ')}' exited with status ${result.status}`);
  if (capture)
    process.stdout.write(result.stdout);
  return result.stdout;
}

function readJson(filepath) {
  return JSON.parse(fs.readFileSync(filepath, 'utf8'));
}

/** The published file for a suite, or null when this checkout has none. */
function previousSuite(name) {
  try {
    return readJson(path.join(OUT_DIR, `${name}.json`));
  }
  catch {
    return null;
  }
}

/**
 * One suite file, proven against the shape `bench.suite` declares for it
 * before it reaches disk. The browser reads every suite through that same
 * document, so a member this run added, renamed or retyped is caught at
 * the write instead of arriving on the page as a wrong render.
 * @param {string} suite - the suite key, which is also the file's name.
 * @param {any} data
 * @returns {string}
 * @throws {Error} naming the JC code, the shape and every failing path.
 */
function serializeSuite(suite, data) {
  assertSuiteOutput(suite, data,
    `packages/website/public/benchmarks/${suite}.json`);
  return JSON.stringify(data);
}

/** Write one already-serialized data file and report its size. */
function writeText(name, text) {
  const filepath = path.join(OUT_DIR, name);
  fs.writeFileSync(filepath, text);
  const kb = (fs.statSync(filepath).size / 1024).toFixed(1);
  console.log(`  -> ${path.relative(ROOT, filepath)} (${kb} kB)`);
}

/**
 * The assembled overview record, proven against the shape the website
 * reads it through, then serialized. The generator and the browser
 * declare that shape in ONE document, so a member added, renamed or
 * retyped here has to land with the contract change or it never gets
 * written.
 * @param {any} meta
 * @returns {string}
 * @throws {Error} naming the JC code and every failing path.
 */
function serializeMeta(meta) {
  assertSiteOutput('bench.meta', meta, 'packages/website/public/benchmarks/meta.json');
  return JSON.stringify(meta);
}

/** Round to 4 significant digits — enough for any display, half the bytes. */
function sig4(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n === 0)
    return n;
  return Float64.roundToPrecision(n, 4);
}

//#endregion

//#region suites

function generateValidate(tmp, options) {
  const file = path.join(tmp, 'validate.json');
  runTool([
    'benchmark/profiler.js', '--profile-all',
    '--draft', 'draft7,draft2019-09,draft2020-12',
    '--iterations', String(options.iterations),
    '--output', 'json', '--filepath', file,
  ]);
  const raw = readJson(file);
  // Slim the per-test rows: keep what the drill-down displays, round the
  // timings (17-digit doubles double the payload), drop derivable fields.
  // NOTE the ratio convention flip: profiler.js emits jarenTime/ajvTime
  // (>1 = Jaren slower); the website files use ajvTime/jarenTime so that
  // >1 always reads "Jaren is N x faster" across every suite file.
  const results = raw.results.map((r) => ({
    suite: r.suite,
    draft: r.draft,
    description: r.description,
    assertions: r.assertions,
    testCount: r.testCount,
    isSuccessTest: r.isSuccessTest,
    jarenTime: sig4(r.jarenTime),
    ajvTime: sig4(r.ajvTime),
    jarenTotal: sig4(r.jarenTotal),
    ajvTotal: sig4(r.ajvTotal),
    ratio: r.jarenTime > 0 ? sig4(r.ajvTime / r.jarenTime) : null,
    jarenFailures: r.jarenFailures,
    ajvFailures: r.ajvFailures,
  }));
  return { metadata: raw.metadata, summary: raw.summary, results, errors: raw.errors };
}

function generateJsonPath(tmp, options) {
  const complianceFile = path.join(tmp, 'jsonpath-compliance.json');
  runTool(['benchmark/jsonpath.js', '--output', 'json', '--filepath', complianceFile]);
  const compliance = readJson(complianceFile);

  const profileFile = path.join(tmp, 'jsonpath-profile.json');
  runTool([
    'benchmark/jsonpath.js', '--profile', '--scale',
    '--iterations', String(options.quick ? 200 : 2000),
    '--output', 'json', '--filepath', profileFile,
  ]);
  const profile = readJson(profileFile);

  const round = (row) => ({
    ...row,
    engines: Object.fromEntries(Object.entries(row.engines).map(([k, v]) => [k, sig4(v)])),
  });
  return {
    date: profile.date,
    node: process.version,
    engines: profile.engines,
    compliance: {
      total: compliance.total,
      groups: compliance.groups,
      failures: compliance.failures.length,
    },
    profile: {
      iterations: options.quick ? 200 : 2000,
      rows: profile.rows.map(round),
      compileRow: round(profile.compileRow),
      scaleRows: profile.scaleRows.map(round),
      earlyExitRows: (profile.earlyExitRows ?? []).map(round),
    },
  };
}

// Scenario prose for the website drill-down. Keys must match the SCENARIOS
// tables in jsonquery.js / jslt.js — the assembly step asserts they do.
const QUERY_SCENARIOS = {
  singular: {
    title: 'singular access',
    description: 'Bind one book, return its title — the degenerate FLWOR on-ramp and the pattern of a $data-style lookup.',
  },
  filter: {
    title: 'filter + project (spec A.2)',
    description: 'Select the books under $10, order them by price, and project title/price objects.',
  },
  join: {
    title: 'join (spec A.3)',
    description: 'Correlate books with a ratings array on isbn. Jaren recognizes the uncorrelated equijoin and answers it from a hash table, so it is O(n+m) where the competitors run a naive O(n·m) nested loop — read the ratio here as a different algorithm, not a faster engine. Capped at 1,000 books, because raising it would grow their cost quadratically and Jaren\'s linearly.',
  },
  group: {
    title: 'group + aggregate (spec A.4)',
    description: 'Group books by category and compute count and average price per genre. fontoxpath does not implement the XQuery group by clause.',
  },
  reshape: {
    title: 'deep reshape',
    description: 'Rebuild the store as a catalog: computed labels, nested pricing objects, and a bicycle summary in one constructor document.',
  },
};

const JSLT_SCENARIOS = {
  identity: {
    title: 'identity (share vs deep copy)',
    description: 'The empty stylesheet. Jaren proves nothing changed and returns the input reference in O(1); native JS and JSONata deep-copy the whole store.',
  },
  surgical: {
    title: 'surgical update ($..price × 1.21)',
    description: 'Add VAT to every price anywhere in the document; everything off the matched spine is shared, not copied.',
  },
  reshape: {
    title: 'reshape + two modes',
    description: 'One document rendered twice through ranked template modes (toc + render) — the XSLT-style recursive dispatch. JSONata\'s transform operator has no equivalent.',
  },
  annotate: {
    title: 'fresh schema annotation',
    description: 'Shape-based matching: every node that validates against a book schema is rewritten with a computed label — no paths, just JSON Schema.',
  },
};

async function loadScenarioSources(dir, keys) {
  const sources = {};
  for (const key of keys)
    sources[key] = {};
  for (const entry of fs.readdirSync(path.join(__dirname, 'adaptors', dir))) {
    const engineKey = path.basename(entry, '.js');
    try {
      const { load } = await import(`./adaptors/${dir}/${entry}`);
      const adaptor = await load();
      for (const key of keys) {
        const impl = adaptor.scenarios[key];
        if (impl?.source !== undefined)
          sources[key][engineKey] = impl.source;
      }
    }
    catch (e) {
      console.warn(`  warning: could not load adaptor ${dir}/${entry} for sources (${e.message})`);
    }
  }
  return sources;
}

async function generateJsonQuery(tmp, options) {
  const file = path.join(tmp, 'jsonquery.json');
  runTool([
    'benchmark/jsonquery.js', '--profile', '--scale',
    ...(options.quick ? ['--iterations', '100'] : []),
    '--output', 'json', '--filepath', file,
  ]);
  const raw = readJson(file);
  const sources = await loadScenarioSources('jsonquery', Object.keys(QUERY_SCENARIOS));

  for (const row of raw.rows) {
    if (QUERY_SCENARIOS[row.scenario] === undefined)
      throw new Error(`jsonquery scenario '${row.scenario}' has no website description — update website-data.js`);
  }
  return {
    date: raw.date,
    node: raw.node,
    engines: raw.engines,
    rows: raw.rows.map((row) => ({
      ...row,
      engines: Object.fromEntries(Object.entries(row.engines).map(([k, v]) => [k, sig4(v)])),
    })),
    compile: raw.compile === undefined ? null : {
      sources: raw.compile.sources,
      iterations: raw.compile.iterations,
      results: Object.fromEntries(Object.entries(raw.compile.results).map(([k, v]) => [k, sig4(v)])),
    },
    scenarios: Object.entries(QUERY_SCENARIOS).map(([key, meta]) => ({
      key,
      ...meta,
      sources: sources[key],
    })),
  };
}

async function generateJslt(tmp, options) {
  const file = path.join(tmp, 'jslt.json');
  runTool([
    'benchmark/jslt.js', '--profile', '--scale',
    ...(options.quick ? ['--iterations', '100'] : []),
    '--output', 'json', '--filepath', file,
  ]);
  const raw = readJson(file);
  const sources = await loadScenarioSources('jslt', Object.keys(JSLT_SCENARIOS));

  for (const row of raw.rows) {
    if (JSLT_SCENARIOS[row.scenario] === undefined)
      throw new Error(`jslt scenario '${row.scenario}' has no website description — update website-data.js`);
  }
  return {
    date: raw.date,
    node: raw.node,
    engines: raw.engines,
    rows: raw.rows.map((row) => ({
      ...row,
      engines: Object.fromEntries(Object.entries(row.engines).map(([k, v]) => [k, sig4(v)])),
    })),
    compile: raw.compile === undefined ? null : {
      sources: raw.compile.sources,
      iterations: raw.compile.iterations,
      results: Object.fromEntries(Object.entries(raw.compile.results).map(([k, v]) => [k, sig4(v)])),
    },
    scenarios: Object.entries(JSLT_SCENARIOS).map(([key, meta]) => ({
      key,
      ...meta,
      sources: sources[key],
    })),
  };
}

function generateFormats(tmp, options) {
  const file = path.join(tmp, 'formats.json');
  runTool([
    'benchmark/formats.js',
    '--iterations', String(options.quick ? 20_000 : 200_000),
    '--output', 'json', '--filepath', file,
  ]);
  const raw = readJson(file);
  if (raw === null) return null;
  return {
    ...raw,
    tables: raw.tables.map((table) => ({
      ...table,
      rows: table.rows.map((row) => ({
        ...row,
        results: row.results.map((ns) => (ns === null ? null : sig4(ns))),
      })),
    })),
  };
}

function generateContracts(tmp, options) {
  const file = path.join(tmp, 'contracts.json');
  runTool([
    'benchmark/contracts.js',
    '--iterations', String(options.quick ? 3_000 : 20_000),
    '--output', 'json', '--filepath', file,
  ]);
  const raw = readJson(file);
  if (raw === null) return null;
  return {
    ...raw,
    tables: raw.tables.map((table) => ({
      ...table,
      rows: table.rows.map((row) => ({
        ...row,
        results: row.results.map((ns) => (ns === null ? null : sig4(ns))),
      })),
    })),
  };
}

/**
 * The @jarenjs/contract suite: route match vs find-my-way/hono, the
 * dispatch pipeline vs Fastify (its own inject harness AND the
 * harness-free find-my-way + Ajv + fast-json-stringify composition,
 * where jaren LOSES — the rows stay in), loopback, and the revision
 * cost. Needs the find-my-way/hono/fastify benchmark devDependencies.
 */
function generateContract(tmp, options) {
  const file = path.join(tmp, 'contract.json');
  try {
    runTool([
      'benchmark/contract.js',
      '--iterations', String(options.quick ? 2_000 : 20_000),
      '--output', 'json', '--filepath', file,
    ]);
  }
  catch (e) {
    console.warn(`  warning: contract run failed (${e.message}); the suite will be omitted.`);
    console.warn('  (the head-to-head needs the find-my-way/hono/fastify benchmark devDependencies)');
    return null;
  }
  const raw = readJson(file);
  return {
    ...raw,
    tables: raw.tables.map((table) => ({
      ...table,
      rows: table.rows.map((row) => ({
        ...row,
        results: row.results.map((ns) => (ns === null ? null : sig4(ns))),
      })),
    })),
    serialization: (raw.serialization ?? []).map((row) => ({
      ...row,
      stringifyNs: sig4(row.stringifyNs),
      dispatchNs: row.dispatchNs === null ? null : sig4(row.dispatchNs),
      share: row.share === null ? null : sig4(row.share),
    })),
  };
}

function generateJsonPointer(tmp, options) {
  const file = path.join(tmp, 'jsonpointer.json');
  runTool([
    'benchmark/jsonpointer.js',
    '--iterations', String(options.quick ? 10_000 : 1_000_000),
    '--output', 'json', '--filepath', file,
  ]);
  const raw = readJson(file);
  return {
    ...raw,
    tables: raw.tables.map((table) => ({
      ...table,
      rows: table.rows.map((row) => ({ ...row, results: row.results.map(sig4) })),
    })),
    compile: {
      jaren: { ...raw.compile.jaren, ns: sig4(raw.compile.jaren.ns) },
      npm: { ...raw.compile.npm, ns: sig4(raw.compile.npm.ns) },
    },
  };
}

function generateJsonPatch(tmp, options) {
  const file = path.join(tmp, 'jsonpatch.json');
  runTool([
    'benchmark/jsonpatch.js',
    '--iterations', String(options.quick ? 5_000 : 200_000),
    '--output', 'json', '--filepath', file,
  ]);
  const raw = readJson(file);
  return {
    ...raw,
    tables: raw.tables.map((table) => ({
      ...table,
      rows: table.rows.map((row) => ({ ...row, results: row.results.map(sig4) })),
    })),
    compile: {
      jaren: { ...raw.compile.jaren, ns: sig4(raw.compile.jaren.ns) },
    },
  };
}

function generateToml(tmp, options) {
  const file = path.join(tmp, 'toml.json');
  try {
    runTool([
      'benchmark/toml.js', '--profile',
      '--iterations', String(options.quick ? 30 : 150),
      '--output', 'json', '--filepath', file,
    ]);
  }
  catch (e) {
    console.warn(`  warning: toml run failed (${e.message}); the suite will be omitted.`);
    console.warn('  (the suite needs: git submodule update --init benchmark/toml-test-suite)');
    return null;
  }
  const raw = readJson(file);
  return {
    ...raw,
    profile: raw.profile === null ? null : {
      iterations: raw.profile.iterations,
      parse: raw.profile.parse.map((row) => ({
        name: row.name,
        results: Object.fromEntries(Object.entries(row.results).map(([k, v]) => [k, sig4(v)])),
      })),
      stringify: Object.fromEntries(Object.entries(raw.profile.stringify).map(([k, v]) => [k, sig4(v)])),
    },
  };
}

function generateCsv(tmp, options) {
  const file = path.join(tmp, 'csv.json');
  try {
    runTool([
      'benchmark/csv.js', '--profile',
      '--iterations', String(options.quick ? 10 : 40),
      '--output', 'json', '--filepath', file,
    ]);
  }
  catch (e) {
    console.warn(`  warning: csv run failed (${e.message}); the suite will be omitted.`);
    return null;
  }
  const raw = readJson(file);
  const round = (rows) => (rows ?? []).map((row) => ({
    name: row.name,
    results: Object.fromEntries(Object.entries(row.results).map(([k, v]) => [k, sig4(v)])),
  }));
  return {
    date: raw.date,
    node: raw.node,
    engines: raw.engines,
    spectrum: raw.spectrum,
    healing: raw.healing,
    profile: raw.profile === null ? null : {
      iterations: raw.profile.iterations,
      rows: round(raw.profile.rows),
      objects: round(raw.profile.objects),
      streaming: round(raw.profile.streaming),
      stringify: Object.fromEntries(
        Object.entries(raw.profile.stringify).map(([k, v]) => [k, sig4(v)])),
    },
  };
}

/**
 * The JSONX/strict-JSON streaming reader, measured against native
 * `JSON.parse`. It rides the JOSL suite (same package, a second
 * capability) rather than adding a tab.
 */
function generateJsonxStream(tmp, options) {
  const file = path.join(tmp, 'jsonx-stream.json');
  try {
    runTool([
      'benchmark/jsonx-stream.js',
      '--iterations', String(options.quick ? 100 : 1000),
      '--output', 'json', '--filepath', file,
    ]);
  }
  catch (e) {
    console.warn(`  warning: jsonx-stream run failed (${e.message}); the streaming rows will be omitted.`);
    return null;
  }
  const raw = readJson(file);
  const slim = (rows) => (rows ?? []).map((r) => ({ label: r.label, ns: sig4(r.ns) }));
  return { ...raw, message: slim(raw.message), document: slim(raw.document) };
}

function generateMarkdown(tmp, options) {
  const file = path.join(tmp, 'markdown.json');
  try {
    runTool([
      'benchmark/markdown.js', '--profile',
      '--iterations', String(options.quick ? 20 : 100),
      '--output', 'json', '--filepath', file,
    ]);
  }
  catch (e) {
    console.warn(`  warning: markdown run failed (${e.message}); the suite will be omitted.`);
    console.warn('  (the suite needs: git submodule update --init benchmark/commonmark-spec');
    console.warn('   and the marked/markdown-it/micromark benchmark devDependencies)');
    return null;
  }
  const raw = readJson(file);
  return {
    ...raw,
    profile: raw.profile === null ? null : {
      iterations: raw.profile.iterations,
      render: raw.profile.render.map((row) => ({
        name: row.name,
        results: Object.fromEntries(Object.entries(row.results).map(([k, v]) => [k, sig4(v)])),
      })),
      jaren: raw.profile.jaren.map((row) => ({
        name: row.name,
        parseMs: sig4(row.parseMs),
        vnodeNs: Math.round(row.vnodeNs),
        phases: row.phases === undefined ? undefined : Object.fromEntries(
          Object.entries(row.phases).map(([k, v]) => [k, sig4(v)])),
      })),
    },
  };
}

/**
 * The view suite: the cross-framework comparison (react, preact,
 * hyperapp, react-dom/server, preact-render-to-string), the
 * hand-written tagged-array rows that separate the FORMAT's cost from
 * the stylesheet ENGINE's, and Jaren's own memo layers. The rows
 * arrive pre-sorted and pre-labeled; only the timings need slimming.
 */
function generateView(tmp, options) {
  const file = path.join(tmp, 'view.json');
  try {
    runTool([
      'benchmark/view.js',
      '--rows', String(options.quick ? 200 : 1000),
      '--iterations', String(options.quick ? 50 : 500),
      '--output', 'json', '--filepath', file,
    ]);
  }
  catch (e) {
    console.warn(`  warning: view run failed (${e.message}); the suite will be omitted.`);
    console.warn('  (the comparison needs the hyperapp/preact/preact-render-to-string benchmark devDependencies)');
    return null;
  }
  const raw = readJson(file);
  const slim = (rows) => (rows ?? []).map((r) => ({ label: r.label, ns: sig4(r.ns) }));
  return {
    ...raw,
    tables: Object.fromEntries(
      Object.entries(raw.tables).map(([key, rows]) => [key, slim(rows)])),
  };
}

/**
 * The charts suite: per-type compile costs plus the session-vs-wholesale
 * scaling rows (the O(change) evidence) for both session types — line
 * appends by point count, bar counts by category count.
 */
function generateCharts(tmp, options) {
  const file = path.join(tmp, 'charts.json');
  try {
    runTool([
      'benchmark/charts.js',
      '--iterations', String(options.quick ? 100 : 1000),
      '--output', 'json', '--filepath', file,
    ]);
  }
  catch (e) {
    console.warn(`  warning: charts run failed (${e.message}); the suite will be omitted.`);
    return null;
  }
  const raw = readJson(file);
  return {
    ...raw,
    types: raw.types.map((r) => ({ label: r.label, ns: sig4(r.ns) })),
    scaling: raw.scaling.map((r) => ({
      ...r,
      sessionNs: sig4(r.sessionNs),
      wholesaleNs: sig4(r.wholesaleNs),
    })),
    barScaling: (raw.barScaling ?? []).map((r) => ({
      ...r,
      sessionNs: sig4(r.sessionNs),
      wholesaleNs: sig4(r.wholesaleNs),
    })),
  };
}

function generateMermaid(tmp, options) {
  const file = path.join(tmp, 'mermaid.json');
  try {
    runTool([
      'benchmark/mermaid.js', '--profile',
      '--iterations', String(options.quick ? 20 : 100),
      '--output', 'json', '--filepath', file,
    ]);
  }
  catch (e) {
    console.warn(`  warning: mermaid run failed (${e.message}); the suite will be omitted.`);
    console.warn('  (the optional @mermaid-js/parser head-to-head needs that benchmark devDependency)');
    return null;
  }
  const raw = readJson(file);
  const slimRows = (rows) => (rows ?? []).map((row) => ({
    name: row.name,
    results: Object.fromEntries(Object.entries(row.results).map(([k, v]) => [k, sig4(v)])),
  }));
  return {
    ...raw,
    profile: raw.profile === null ? null : {
      iterations: raw.profile.iterations,
      parse: slimRows(raw.profile.parse),
      parseJison: slimRows(raw.profile.parseJison),
      jaren: raw.profile.jaren.map((row) => ({
        name: row.name,
        parseMs: sig4(row.parseMs),
        svgMs: sig4(row.svgMs),
      })),
    },
  };
}

/**
 * The geo suite: the spatial kernel against Turf, geolib and Flatbush.
 * The tool asserts result equivalence and exits non-zero on
 * disagreement, so a generated file always carries timings its checks
 * gate.
 */
function generateGeo(tmp, options) {
  const file = path.join(tmp, 'geo.json');
  try {
    runTool([
      'benchmark/geo.js',
      '--iterations', String(options.quick ? 5_000 : 100_000),
      '--filepath', file,
    ]);
  }
  catch (e) {
    console.warn(`  warning: geo run failed (${e.message}); the suite will be omitted.`);
    console.warn('  (the comparison needs the @turf/turf, geolib and flatbush benchmark devDependencies)');
    return null;
  }
  const raw = readJson(file);
  return {
    node: raw.node,
    iterations: raw.iterations,
    checks: raw.checks,
    rows: raw.rows.map((r) => ({
      name: r.name,
      ours: sig4(r.ours),
      rival: r.rival === null ? null : sig4(r.rival),
      rivalName: r.rivalName ?? '',
    })),
  };
}

/**
 * The flow suite: the FSM head-to-head against XState v5 (compile,
 * transition, the serializability wedge, the memory loss) and the DAG
 * abstraction price against a hand-written baseline. Two runners, one
 * combined file — `--expose-gc` is a node flag, so it leads the args.
 */
function generateFlow(tmp, options) {
  const fsmFile = path.join(tmp, 'flow-fsm.json');
  const dagFile = path.join(tmp, 'flow-dag.json');
  try {
    runTool([
      '--expose-gc', 'benchmark/flow-fsm.js',
      '--iterations', String(options.quick ? 2_000 : 20_000),
      '--output', 'json', '--filepath', fsmFile,
    ]);
    runTool([
      'benchmark/flow-dag.js',
      '--output', 'json', '--filepath', dagFile,
    ]);
  }
  catch (e) {
    console.warn(`  warning: flow run failed (${e.message}); the suite will be omitted.`);
    console.warn('  (the FSM head-to-head needs the xstate benchmark devDependency)');
    return null;
  }
  const fsm = readJson(fsmFile);
  const dag = readJson(dagFile);
  const slim = (rows) => rows.map((r) => ({ label: r.label, ns: sig4(r.ns) }));
  return {
    date: fsm.date,
    node: fsm.node,
    xstate: fsm.xstate,
    sizes: fsm.sizes,
    compile: Object.fromEntries(fsm.sizes.map((n) => [n, slim(fsm.compile[n])])),
    transition: Object.fromEntries(fsm.sizes.map((n) => [n, slim(fsm.transition[n])])),
    wedge: fsm.wedge,
    memory: fsm.memory,
    dag: { sizes: dag.sizes, sync: dag.sync, async: dag.async },
  };
}

function generateQt3() {
  let stdout;
  try {
    stdout = runTool(['benchmark/qt3-runner.js'], { capture: true });
  }
  catch (e) {
    console.warn(`  warning: QT3 run failed (${e.message}); the scorecard will be omitted.`);
    console.warn('  (the suite needs: git submodule update --init benchmark/qt3tests && npm run qt3:convert)');
    return null;
  }

  // The scorecard block is this tool's own stable print format.
  const grab = (re) => {
    const match = stdout.match(re);
    return match === null ? null : parseInt(match[1], 10);
  };
  const scorecard = {
    suite: stdout.match(/scorecard - suite ([0-9a-f]+)/)?.[1] ?? null,
    total: grab(/scorecard - suite [0-9a-f]+, (\d+) test cases/),
    tierC: grab(/tier C \(out of scope, not run\):\s+(\d+)/),
    tierA: grab(/tier A \(applicable\):\s+(\d+)/),
    reclassified: grab(/reclassified C at runtime:\s+(\d+)/),
    pass: grab(/pass:\s+(\d+)/),
    unsupportedSyntax: grab(/unsupported-syntax:\s+(\d+)/),
    failByDesign: grab(/fail-by-design \(baseline\):\s+(\d+)/),
    knownBugs: grab(/known bugs \(baseline\):\s+(\d+)/),
    regressions: grab(/FAIL \(not in baseline\):\s+(\d+)/),
  };
  if (scorecard.total === null || scorecard.pass === null) {
    console.warn('  warning: could not parse the QT3 scorecard output; the scorecard will be omitted.');
    return null;
  }
  return scorecard;
}

//#endregion

//#region overview headlines

/** Display order of the overview's headline rows (the site's suite order). */
const SUITE_ORDER = [
  'validate', 'contracts', 'contract', 'jsonpath', 'jsonquery', 'jslt', 'formats', 'jsonpointer', 'jsonpatch',
  'toml', 'csv', 'markdown', 'mermaid', 'view', 'charts', 'geo', 'flow', 'db',
  'spatial', 'orm', 'live', 'long-horizon', 'retrieval', 'vector', 'series',
];

/** The fastest rival timing in a `{engine: ns}` record, Jaren excluded. */
function bestRival(engines, jarenKey) {
  const rivals = Object.entries(engines ?? {})
    .filter(([k, v]) => k !== jarenKey && Number.isFinite(v) && v > 0)
    .map(([, v]) => v);
  return rivals.length === 0 ? null : Math.min(...rivals);
}

/**
 * One headline row per suite: the cross-suite summary the overview
 * renders. `ratio` is always "× faster than the fastest rival" (> 1 is
 * a win, the suite-wide convention); `conformance` is the correctness
 * half. Every value is DERIVED from the generated data — nothing here
 * is a hand-written number that can drift.
 */
function buildHeadlines(generated, meta) {
  const out = [];
  const add = (key, label, entry) => {
    if (entry !== null && entry !== undefined) out.push({ key, label, ...entry });
  };

  if (generated.validate !== undefined) {
    const o = generated.validate.summary.overall;
    const c = meta.conformance.jsonSchema?.engineStats?.jaren ?? {};
    const passed = Object.values(c).reduce((s, d) => s + (d.passed ?? 0), 0);
    const failed = Object.values(c).reduce((s, d) => s + (d.failed ?? 0) + (d.errors ?? 0), 0);
    add('validate', 'JSON Schema', {
      ratio: o.jarenSuccessTime > 0 ? o.ajvSuccessTime / o.jarenSuccessTime : null,
      rival: 'Ajv',
      conformance: `${passed} / ${passed + failed}`,
      note: 'official suite, every draft',
    });
  }
  if (generated.contracts !== undefined) {
    // The adapter table is the comparable measurement (normalize + validate +
    // map issues); the verdict table flatters Jaren and the compile table is
    // paid once, so neither belongs in a one-number headline. The rival is
    // whichever engine is fastest per scenario - which is Ajv on some of
    // them, so this ratio can legitimately read as a loss.
    const adapter = generated.contracts.tables?.find((t) => t.title.startsWith('Normalize'));
    const columns = adapter?.columns ?? [];
    const jarenCol = columns.indexOf('@jarenjs/validate');
    const ratios = [];
    if (adapter !== undefined && jarenCol !== -1) {
      for (const row of adapter.rows) {
        const mine = row.results[jarenCol];
        const rivals = row.results.filter((v, i) => i !== jarenCol && Number.isFinite(v) && v > 0);
        if (Number.isFinite(mine) && mine > 0 && rivals.length > 0)
          ratios.push(Math.min(...rivals) / mine);
      }
    }
    if (ratios.length > 0) {
      add('contracts', 'Contracts vs Zod', {
        ratio: geoMean(ratios),
        rival: 'fastest of Zod 4 / Zod 3 / zod-mini / Ajv',
        conformance: null,
        note: 'normalize + validate + map issues, the shape a request handler runs',
      });
    }
  }
  if (generated.contract !== undefined) {
    // Table 2's HARNESS-FREE column is the honest rival: find-my-way +
    // Ajv + fast-json-stringify called directly — the pieces Fastify
    // composes, with no inject harness in the number. It is faster than
    // jaren's whole pipeline on every row (jaren also validates the
    // response before it leaves), so this ratio reads as a loss and
    // stays on the overview for the same reason the wins do.
    const dispatch = generated.contract.tables?.find((t) => t.title.startsWith('Dispatch, in-process'));
    const columns = dispatch?.columns ?? [];
    const jarenCol = columns.indexOf('@jarenjs/contract');
    const rivalCol = columns.indexOf('find-my-way + Ajv + fjs');
    const ratios = [];
    if (dispatch !== undefined && jarenCol !== -1 && rivalCol !== -1) {
      for (const row of dispatch.rows) {
        const mine = row.results[jarenCol];
        const rival = row.results[rivalCol];
        if (Number.isFinite(mine) && mine > 0 && Number.isFinite(rival) && rival > 0)
          ratios.push(rival / mine);
      }
    }
    if (ratios.length > 0) {
      add('contract', 'Contract dispatch vs Fastify', {
        ratio: geoMean(ratios),
        rival: 'find-my-way + Ajv + fast-json-stringify (harness-free)',
        conformance: null,
        note: 'the in-process dispatch table\'s harness-free column: the pieces Fastify composes, called directly with no inject harness; jaren\'s pipeline also validates the response, which the rival does not do',
      });
    }
  }
  if (generated.jsonpath !== undefined) {
    const rows = generated.jsonpath.profile?.rows ?? [];
    add('jsonpath', 'JSONPath', {
      ratio: geoMeanRatio(rows, 'jaren', 'json-p3'),
      rival: 'json-p3',
      conformance: `${generated.jsonpath.compliance.total} / ${generated.jsonpath.compliance.total}`,
      note: `RFC 9535 CTS, ${rows.length} queries`,
    });
  }
  // `native` is hand-written JavaScript — a FLOOR reference, not a
  // competing library. Ranking a compiler against it would be a
  // category error, so the headline compares libraries and the native
  // floor is reported separately in the suite tab.
  for (const [key, label, rivalName] of [
    ['jsonquery', 'JSON Query', 'the fastest library rival'],
    ['jslt', 'JSLT', 'JSONata'],
  ]) {
    if (generated[key] === undefined) continue;
    const rows = generated[key].rows ?? [];
    const ratios = [];
    for (const r of rows) {
      const libraries = Object.fromEntries(
        Object.entries(r.engines ?? {}).filter(([k]) => k !== 'native'));
      const best = bestRival(libraries, 'jaren');
      if (best !== null && r.engines.jaren > 0) ratios.push(best / r.engines.jaren);
    }
    add(key, label, {
      ratio: geoMean(ratios),
      rival: rivalName,
      conformance: null,
      note: `${rows.length} scenario rows; hand-written JS is a separate floor`,
    });
  }
  // A rival column is one that is not Jaren's own: these suites carry
  // `jaren compiled` next to `jaren legacy`, and ranking Jaren against
  // itself would invent a win.
  for (const [key, label, rival, note] of [
    ['formats', 'Formats', 'ajv-formats', 'formats both engines implement'],
    ['jsonpointer', 'JSON Pointer', 'the npm implementation', 'compiled getters vs npm'],
    ['jsonpatch', 'JSON Patch', 'the npm implementation', 'official json-patch-tests'],
  ]) {
    if (generated[key] === undefined) continue;
    const ratios = [];
    for (const t of generated[key].tables ?? []) {
      const columns = t.columns ?? [];
      const jarenAt = columns.findIndex((c) => /^jaren\b/i.test(c));
      if (jarenAt < 0) continue;
      for (const r of t.rows ?? []) {
        const jaren = r.results[jarenAt];
        const rivals = r.results.filter((v, i) => !/^jaren\b/i.test(columns[i] ?? '')
          && Number.isFinite(v) && v > 0);
        if (rivals.length !== 0 && jaren > 0) ratios.push(Math.min(...rivals) / jaren);
      }
    }
    add(key, label, {
      ratio: geoMean(ratios),
      rival,
      conformance: generated[key].conformance != null
        ? `${generated[key].conformance.pass} / ${generated[key].conformance.total}`
        : null,
      note,
    });
  }
  if (generated.toml !== undefined) {
    const parse = generated.toml.profile?.parse ?? [];
    add('toml', 'JOSL / TOML', {
      ratio: geoMean(parse.map((p) => {
        const best = bestRival(p.results, 'jaren');
        return best === null || !(p.results.jaren > 0) ? null : best / p.results.jaren;
      })),
      rival: 'the fastest rival',
      conformance: `${generated.toml.compliance?.jaren?.pass ?? '?'} / ${generated.toml.compliance?.jaren?.total ?? '?'}`,
      note: 'toml-test 1.0.0, the only full pass',
    });
  }
  if (generated.csv !== undefined) {
    const rows = generated.csv.profile?.rows ?? [];
    const spectrum = generated.csv.spectrum?.jaren;
    add('csv', 'CSV', {
      ratio: geoMean(rows.map((p) => {
        const best = bestRival(p.results, 'jaren');
        return best === null || !(p.results.jaren > 0) ? null : best / p.results.jaren;
      })),
      rival: 'the fastest rival',
      conformance: spectrum === undefined ? null : `${spectrum.pass} / ${spectrum.total}`,
      note: 'csv-spectrum; udsv leads on raw parse (it uses new Function)',
    });
  }
  if (generated.markdown !== undefined) {
    const render = generated.markdown.profile?.render ?? [];
    add('markdown', 'Markdown', {
      ratio: geoMean(render.map((p) => {
        const best = bestRival(p.results, 'jaren-md');
        return best === null || !(p.results['jaren-md'] > 0) ? null : best / p.results['jaren-md'];
      })),
      rival: 'the fastest rival',
      conformance: `${generated.markdown.scorecard?.['jaren-md']?.pass ?? '?'} / ${generated.markdown.examples ?? '?'}`,
      note: 'CommonMark examples (no raw HTML by design)',
    });
  }
  if (generated.mermaid !== undefined) {
    const parse = generated.mermaid.profile?.parseJison ?? [];
    const rendered = Object.values(generated.mermaid.scorecard ?? {})
      .reduce((s, v) => s + (v.rendered ?? 0), 0);
    const total = Object.values(generated.mermaid.scorecard ?? {})
      .reduce((s, v) => s + (v.total ?? 0), 0);
    add('mermaid', 'Mermaid', {
      ratio: geoMean(parse.map((p) => {
        const best = bestRival(p.results, 'jaren-mermaid');
        return best === null || !(p.results['jaren-mermaid'] > 0) ? null : best / p.results['jaren-mermaid'];
      })),
      rival: 'mermaid (jison)',
      conformance: total > 0 ? `${rendered} / ${total}` : null,
      note: 'corpus diagrams rendered headless',
    });
  }
  if (generated.view !== undefined) {
    // The honest headline is NOT a win over preact — Jaren produces
    // vnodes through a generic dispatcher and pays for it. What the
    // architecture buys is the re-render path, so that is the number.
    const frame = generated.view.tables?.frame ?? [];
    const memo = frame.find((r) => r.label.includes('(memo)'));
    const plain = frame.find((r) => r.label.includes('(no memo)'));
    add('view', 'View', {
      ratio: memo !== undefined && plain !== undefined && memo.ns > 0 ? plain.ns / memo.ns : null,
      rival: 'its own no-memo frame',
      conformance: null,
      note: 'memo vs no-memo frame; hand-written vnodes outbuild react, the data-driven stylesheet pays ~20× — see the suite page',
    });
  }
  if (generated.charts !== undefined) {
    const big = generated.charts.scaling?.[generated.charts.scaling.length - 1];
    add('charts', 'Charts', {
      ratio: big !== undefined && big.sessionNs > 0 ? big.wholesaleNs / big.sessionNs : null,
      rival: 'a wholesale re-render',
      conformance: null,
      note: big !== undefined ? `incremental tick at ${big.points}×${big.series} points` : '',
    });
  }
  if (generated.geo !== undefined) {
    const rows = generated.geo.rows ?? [];
    const checks = generated.geo.checks ?? [];
    add('geo', 'Geo', {
      ratio: geoMean(rows
        .filter((r) => r.rival !== null && r.ours > 0)
        .map((r) => r.rival / r.ours)),
      rival: 'turf / geolib / flatbush',
      conformance: `${checks.filter((c) => c.agrees).length} / ${checks.length}`,
      note: 'result equivalence asserted before timing; the point-in-polygon loss is deliberate (exact predicate)',
    });
  }
  if (generated.flow !== undefined) {
    // the headline ratio is the transition speedup at the mid machine
    // size: our pure step vs XState's actor.send, both timed on the
    // same logical machine
    const mid = generated.flow.sizes?.[1] ?? generated.flow.sizes?.[0];
    const rows = generated.flow.transition?.[mid] ?? [];
    const step = rows.find((r) => r.label.includes('step'));
    const actor = rows.find((r) => r.label.includes('xstate'));
    const survives = generated.flow.wedge?.guardsSurviveJson ?? {};
    add('flow', 'Flow', {
      ratio: step !== undefined && actor !== undefined && step.ns > 0 ? actor.ns / step.ns : null,
      rival: 'XState v5',
      // the conformance half IS the wedge: the guarded machine survives
      // a JSON round trip (jaren) or does not (the rival)
      conformance: survives.jaren ? 'serializable' : '—',
      note: 'pure step vs actor.send; the machine survives JSON round-trip with its guards, XState\'s do not — the dag pays the documented dataflow tax on the suite page',
    });
  }
  if (generated.orm !== undefined) {
    add('orm', 'ORM', {
      ratio: generated.orm.meta.headlineRatio,
      rival: generated.orm.meta.headlineRival ?? 'Prisma',
      conformance: '1 statement',
      note: 'the two-level graph load in ONE statement versus the rivals\' round trips; statement counts published beside every timing; the rows jaren loses are on the suite page with their reasons',
    });
  }
  if (generated.db !== undefined) {
    add('db', 'Data', {
      ratio: generated.db.meta.headlineRatio,
      rival: 'the residual path',
      conformance: `${generated.db.meta.docs} docs`,
      note: 'the same query document pushed to SQL versus forced to the residual — the measured value of the planner; PouchDB/RxDB/lowdb rows (including the ones jaren loses) are on the suite page',
    });
  }
  if (generated.spatial !== undefined) {
    // The rival here is NOT using the database: the same $within in
    // the in-memory engine over the parsed array. It is the one row a
    // spatial store has to win to earn its place, and it is published
    // whichever way it falls.
    const { meta } = generated.spatial;
    const word = meta.figures.engineVsIndexed >= 1 ? 'faster' : 'slower';
    add('spatial', 'Spatial', {
      ratio: meta.figures.engineVsIndexed,
      rival: 'the in-memory engine (no database)',
      conformance: `corpus ${meta.corpus.agreed} / ${meta.corpus.cases}`,
      note: `$within over ${meta.docs.toLocaleString('en-US')} stored points through a derive: 'bbox' index,`
        + ` ${word} than the same predicate in the engine over the parsed array; ${meta.figures.scanVsIndexed}× the`
        + ' full scan a consumer started from. No head-to-head rival exists (nothing else stores GeoJSON in'
        + ' SQLite from a JSON query document); MongoDB and DuckDB-wasm are positioned on the suite page',
    });
  }
  if (generated.live !== undefined) {
    const topRatio = (generated.live.meta.incrementalRatios ?? [])
      .reduce((best, entry) => Math.max(best, entry.ratio), 0);
    add('live', 'Live', {
      ratio: Number(topRatio.toFixed(1)),
      rival: 're-run',
      conformance: 'RFC 6902',
      note: 'incremental live-query maintenance versus re-running the query; measured against RxDB and TinyBase (which wins raw update latency — the honest cost of durability, published on the suite page)',
    });
  }
  if (generated['long-horizon'] !== undefined) {
    // This suite measures RETENTION, not speed: what a compacted agent
    // history still carries. It has no ratio because there is no rival
    // engine to time — and it belongs on the overview anyway, because a
    // summary that counted 20 of the 21 published suites was itself a
    // number that could not be checked.
    const rows = generated['long-horizon'].rows ?? [];
    const at = (variant, budget) => rows.find((r) => r.variant === variant
      && r.task === 'needle' && r.shape === 'late' && r.budget === budget);
    // the budget where the defect is most visible on the realistic
    // payload shape — the same row the package docs quote
    const budget = 6000;
    const lossy = at('synopsis', budget);
    const ledger = at('ledger', budget);
    if (lossy !== undefined && ledger !== undefined && ledger.valueRecoverable !== null) {
      add('long-horizon', 'Long horizon', {
        ratio: null,
        rival: 'the same run without a ledger',
        conformance: `${ledger.valueRecoverable} / ${ledger.n} values`,
        note: `agent context retention, not speed: at a ${budget}-character history budget on the`
          + ` realistic payload shape, built-in compaction still carries ${lossy.valuePresent} of`
          + ` ${lossy.n} record values, and a ledger brings ${ledger.valueRecoverable} of`
          + ` ${ledger.n} back — verbatim or one recall away. The pairwise relation is 0% either`
          + ' way; only an environment moves it — see the suite page',
      });
    }
  }
  if (generated.retrieval !== undefined) {
    // This suite measures RETRIEVAL, not speed: whether the ledger's
    // recall put the right memory in the prompt. No rival engine is
    // timed, so no ratio — and it sits on the overview for the same
    // reason long-horizon does: a summary that skipped a published
    // suite would be a count that cannot be checked.
    const rows = generated.retrieval.rows ?? [];
    const sizes = generated.retrieval.meta?.sizes ?? [];
    const n = sizes[sizes.length - 1];
    const at = (policy) => rows.find((r) => r.size === n && r.policy === policy);
    const incumbent = at('tag+recency');
    const near = at('near');
    const recency = at('recency');
    const random = at('random');
    const oracle = at('oracle');
    if (n !== undefined && incumbent !== undefined && near !== undefined && recency !== undefined
      && random !== undefined && oracle !== undefined) {
      const pct = (x) => `${(x * 100).toFixed(1)}%`;
      const word = near.recallAt10 > incumbent.recallAt10 ? 'ahead of'
        : near.recallAt10 < incumbent.recallAt10 ? 'behind' : 'level with';
      add('retrieval', 'Retrieval', {
        ratio: null,
        rival: 'random and recency',
        conformance: `oracle ${pct(oracle.recallAt10)}`,
        note: `retrieval mechanics, not speed: over ${n.toLocaleString('en-US')} synthetic memories,`
          + ` the default recall (tag match, then recency) puts a gold memory in the top 10 for`
          + ` ${pct(incumbent.recallAt10)} of questions; the seam-gated ranked path (near, through the`
          + ` deterministic ${generated.retrieval.meta?.ranked?.model ?? 'reference'} embedder — lexical, a`
          + ` mechanism score) ${pct(near.recallAt10)}, ${word} it; recency alone ${pct(recency.recallAt10)},`
          + ` a random draw ${pct(random.recallAt10)}. Embedding quality belongs to a real model behind`
          + ' the same seam; see the suite page',
      });
    }
  }
  if (generated.vector !== undefined) {
    // The rival here IS an engine and IS timed, so this row does carry a
    // ratio — and it is the one row on the overview where a purpose-built
    // native extension is expected to win. It stays for that reason.
    const meta = generated.vector.meta ?? {};
    const figures = meta.figures ?? {};
    const classes = meta.classes ?? [];
    const disagreed = classes
      .filter((/** @type {any} */ c) => c.key !== 'same')
      .reduce((/** @type {number} */ sum, /** @type {any} */ c) => sum + c.count, 0);
    if (figures.largest !== undefined) {
      const times = (/** @type {number} */ r) => `${r.toFixed(2)}×`;
      add('vector', 'Vector', {
        ratio: figures.rivalVsPlan === null ? null : figures.rivalVsPlan,
        rival: meta.rival?.unavailable === undefined ? 'sqlite-vec' : 'sqlite-vec (did not load)',
        conformance: `${disagreed} disagreement${disagreed === 1 ? '' : 's'}`,
        note: `k-nearest over a derive: 'vector' column at ${figures.largest}: every path answers the`
          + ' identical top-k before a timing prints. The plan is'
          + ` ${figures.jsonDocVsPlan === null ? 'the only column path measured' : `${times(figures.jsonDocVsPlan)} the same query with no column`}`
          + ` and ${times(figures.planVsResident)} the resident sweep with no database at all;`
          + ` the column costs ${times(figures.loadCost)} the write.`
          + (figures.rivalVsPlan === null ? ' sqlite-vec did not load on the measuring host.'
            : ` sqlite-vec answers ${times(figures.rivalVsPlan)} faster out of a database`
              + ` ${times(figures.rivalStorage)} smaller that holds no documents`)
          + ' — see the suite page',
      });
    }
  }
  if (generated.series !== undefined) {
    // No rival library is measured here, so no ratio: the row's number
    // is what a declared epoch column buys over the document it was
    // derived from, which is a comparison inside one database rather
    // than a race against another one. Publishing it as a ratio on the
    // overview chart would put it on an axis it does not belong on.
    const meta = generated.series.meta ?? {};
    const figures = meta.figures ?? {};
    const failures = meta.equivalenceFailures ?? 0;
    if (figures.largest !== undefined) {
      const times = (/** @type {number} */ r) => `${r.toFixed(2)}×`;
      add('series', 'Series', {
        ratio: null,
        rival: 'no library rival — the routes a consumer already has',
        conformance: `${(generated.series.checks ?? []).length - failures} `
          + `/ ${(generated.series.checks ?? []).length} checks`,
        note: `The temporal ground at ${figures.largest}, measured before a kernel exists so a`
          + ' later fast path arrives with a number to beat. A sorted cut answers a one-hour range'
          + ` ${times(figures.cutVsFilter)} a full filter, and a declared epoch column under an`
          + ` index answers it ${times(figures.columnVsDocument)} the same range read back out of`
          + ' the stored JSON with date functions. The generic query route costs'
          + ` ${times(figures.queryBucketVsResident)} the one-pass bucket loop; the durable range`
          + ` costs ${times(figures.storedRangeVsResident)} the resident cut, which is the price of`
          + ' never having read the rest of the corpus — see the suite page',
      });
    }
  }
  return out;
}

/** The provenance a row measured by THIS invocation carries. */
function measuredBy(lastRun) {
  return {
    generated: lastRun.generated,
    node: lastRun.node,
    version: lastRun.version,
    quick: lastRun.quick,
  };
}

/**
 * A published suite file's OWN measurement stamp, for a row derived
 * from the committed data rather than from a run. The suites spell it
 * three ways; what none of them record is the suite version or the
 * iteration mode, so those stay unknown instead of borrowing this run's.
 */
function fileProvenance(payload) {
  const asString = (v) => (typeof v === 'string' && v !== '' ? v : null);
  return {
    generated: asString(payload?.date ?? payload?.meta?.date ?? payload?.metadata?.timestamp),
    node: asString(payload?.node ?? payload?.meta?.node),
    version: null,
    quick: null,
  };
}

/**
 * The overview's row list: rows measured by this run, then the rows it
 * did not measure, each keeping the run that DID measure it.
 *
 * The global run stamp used to be written over every row, so a partial
 * regeneration republished weeks-old numbers as freshly measured on
 * today's runtime and version. A row recorded before per-row provenance
 * existed knows only its date; the rest is published as unknown, which
 * is a smaller claim than a plausible lie.
 */
function carryHeadlines(fresh, previous, lastRun) {
  const rows = fresh.map((h) => ({ ...h, ...measuredBy(lastRun) }));
  const known = new Set(rows.map((h) => h.key));
  for (const h of previous ?? []) {
    if (known.has(h.key)) continue;
    known.add(h.key);
    rows.push({
      ...h,
      generated: h.generated ?? null,
      node: h.node ?? null,
      version: h.version ?? null,
      quick: h.quick ?? null,
    });
  }
  return rows;
}

/**
 * The JOSL suite file: the TOML measurements plus the JSONX streaming
 * rows that ride with them as `stream`. A skipped or failed streaming
 * sub-run has nothing fresh to write, and writing the file without the
 * member would DELETE rows the site still renders — so it carries
 * forward, the way a skipped suite carries its whole file.
 */
function mergeToml(toml, stream, previousToml) {
  if (toml === null || toml === undefined) return null;
  const carried = stream ?? previousToml?.stream ?? null;
  return carried === null ? toml : { ...toml, stream: carried };
}

/**
 * The phase-C live suite: incremental-vs-re-run maintenance, capture
 * overhead, update latency against RxDB and TinyBase (TinyBase wins —
 * published with the reason), the end-to-end path, and job throughput.
 * The rival devDependencies live in benchmark/package.json.
 */
function generateLive(tmp, options) {
  const file = path.join(tmp, 'live.json');
  try {
    runTool([
      'benchmark/live.js',
      ...(options.quick ? ['--quick'] : []),
      '--output', 'json', '--filepath', file,
    ]);
  }
  catch (e) {
    console.warn(`  warning: live run failed (${e.message}); the suite will be omitted.`);
    console.warn('  (the live head-to-head needs the rxdb/tinybase benchmark devDependencies)');
    return null;
  }
  const run = readJson(file);
  return {
    meta: {
      suite: 'live',
      title: 'Live queries, capture and jobs',
      description: 'Incremental live-query maintenance versus re-running the query, '
        + 'capture overhead, update latency against RxDB and TinyBase, the '
        + 'end-to-end write→patch→DOM path, and durable job throughput.',
      ...run.meta,
    },
    tables: run.tables,
  };
}

/**
 * The long-horizon suite: what survives `@jarenjs/ai`'s history
 * compaction, as a model-free ceiling and — when the generating machine
 * has a key — as a real model's score over the same contexts.
 *
 * `--live` is passed unconditionally and that is safe: with no key the
 * benchmark prints its ceilings, says the live tier was skipped and exits
 * 0, so the file regenerates on any machine. It also means a KEYLESS
 * regeneration republishes this file with empty `actual` columns rather
 * than keeping numbers it did not measure — the honest behaviour, and the
 * reason the skip reason travels in the file's own meta.
 */
function generateLongHorizon(tmp, options) {
  const file = path.join(tmp, 'long-horizon.json');
  try {
    runTool([
      '--env-file-if-exists=.env',
      'benchmark/long-horizon.js', '--live',
      ...(options.quick ? ['--quick'] : []),
      '--output', 'json', '--filepath', file,
    ]);
  }
  catch (e) {
    console.warn(`  warning: long-horizon run failed (${e.message}); the suite will be omitted.`);
    return null;
  }
  // the entry point already emits the published document — passing it
  // through keeps one definition of the file's shape
  return readJson(file);
}

/**
 * The retrieval suite: whether `@jarenjs/ai`'s recall puts the right
 * memory in the prompt, scored over the committed synthetic corpus.
 * Deterministic and model-free — the ranked row embeds through the
 * hashed-trigram reference embedder, and only the latency and sweep
 * columns depend on the machine — and it gates its own scorer (the
 * oracle row must be 1.000) before it writes anything. `--live` is not
 * passed: the tracked file never carries a model's row; a host runs the
 * live tier by hand and reads its own number.
 */
function generateRetrieval(tmp) {
  const file = path.join(tmp, 'retrieval.json');
  try {
    runTool(['benchmark/retrieval.js', '--output', 'json', '--filepath', file]);
  }
  catch (e) {
    console.warn(`  warning: retrieval run failed (${e.message}); the suite will be omitted.`);
    return null;
  }
  return readJson(file);
}

/**
 * The vector suite: one k-nearest query over a `derive: 'vector'`
 * column measured every physical way it can run, against sqlite-vec.
 * Every path must answer the identical top-k on every probe before a
 * timing prints, so the tool exits non-zero and writes nothing when one
 * disagrees — an omitted suite here is a withheld table, never a wrong
 * one. The rival is a benchmark devDependency and its loadability is
 * recorded either way: a host where the extension does not load still
 * publishes every other row, with the exact reason beside the one it
 * cannot.
 */
function generateVector(tmp, options) {
  const file = path.join(tmp, 'vector.json');
  try {
    runTool([
      'benchmark/vector.js',
      ...(options.quick ? ['--quick'] : []),
      '--output', 'json', '--filepath', file,
    ]);
  }
  catch (e) {
    console.warn(`  warning: vector run failed (${e.message}); the suite will be omitted.`);
    return null;
  }
  return readJson(file);
}

/**
 * The series suite: one range, one bucketing, one rolling window and one
 * as-of read answered by the plain references, by a generic query
 * document and by stock SQLite over a declared epoch column. Every route
 * is checked against the committed series corpus and against the others
 * before a timing is taken, so the tool exits non-zero and writes
 * nothing when one disagrees — an omitted suite here is a withheld
 * table, never a wrong one.
 */
function generateSeries(tmp, options) {
  const file = path.join(tmp, 'series.json');
  try {
    runTool([
      'benchmark/series.js',
      ...(options.quick ? ['--quick'] : []),
      '--output', 'json', '--filepath', file,
    ]);
  }
  catch (e) {
    console.warn(`  warning: series run failed (${e.message}); the suite will be omitted.`);
    return null;
  }
  return readJson(file);
}

/**
 * The spatial-storage suite: `$within` over 50 000 stored points every
 * way it can run, gated on the committed spatial corpus. The tool
 * exits non-zero and writes nothing when an executor disagrees, so an
 * omitted suite here is a withheld table, never a wrong one.
 */
function generateSpatial(tmp, options) {
  const file = path.join(tmp, 'spatial.json');
  try {
    runTool([
      'benchmark/spatial.js',
      ...(options.quick ? ['--quick'] : []),
      '--output', 'json', '--filepath', file,
    ]);
  }
  catch (e) {
    console.warn(`  warning: spatial run failed (${e.message}); the suite will be omitted.`);
    return null;
  }
  const raw = readJson(file);
  return {
    meta: raw.meta,
    checks: raw.checks,
    tables: raw.tables.map((table) => ({
      title: table.title,
      columns: table.columns,
      rows: table.rows.map((row) => ({
        ...row,
        results: row.results.map((ns) => (ns === null ? null : sig4(ns))),
      })),
    })),
  };
}

/**
 * The phase-B ORM suite: entities, the one-statement graph load, the
 * unit of work and the typed surface against Prisma, Drizzle and
 * Kysely — on Node, and on Bun where a first-party route exists. The
 * merged payload keeps the Bun tables beside the Node ones with the
 * capability cliff stated.
 */
function generateOrm(tmp, options) {
  const nodeFile = path.join(tmp, 'orm-node.json');
  try {
    runTool([
      'benchmark/orm.js',
      ...(options.quick ? ['--quick'] : []),
      '--output', 'json', '--filepath', nodeFile,
    ]);
  }
  catch (e) {
    console.warn(`  warning: orm run failed (${e.message}); the suite will be omitted.`);
    console.warn('  (the ORM head-to-head needs the prisma/drizzle/kysely benchmark devDependencies)');
    return null;
  }
  const nodeRun = readJson(nodeFile);
  let bunRun = null;
  const bunFile = path.join(tmp, 'orm-bun.json');
  try {
    const bunResult = spawnSync('bun', ['benchmark/orm.js',
      ...(options.quick ? ['--quick'] : []),
      '--output', 'json', '--filepath', bunFile],
    { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' });
    if (bunResult.status !== 0) throw new Error('bun run failed');
    bunRun = readJson(bunFile);
  }
  catch {
    console.warn('  note: bun unavailable — the ORM suite ships Node tables only.');
  }
  const headline = (nodeRun.meta.notes ?? [])
    .find((note) => note.startsWith('graph-load headline'));
  return {
    meta: {
      ...nodeRun.meta,
      bunRuntime: bunRun?.meta.runtime ?? null,
      bunNotes: bunRun?.meta.notes ?? [],
      headlineRival: headline?.includes('Prisma') ? 'Prisma (graph load)'
        : 'Drizzle (graph load)',
    },
    tables: [
      ...nodeRun.tables,
      ...(bunRun === null ? [] : bunRun.tables.map((table) => ({
        ...table, title: `[Bun] ${table.title}`,
      }))),
    ],
  };
}

/**
 * The data suite: the phase-A store and its LINQ front door against
 * PouchDB, RxDB and lowdb, with the pushed-versus-residual ratio as
 * the headline. The rows where jaren loses stay in the payload — the
 * suite page renders them with their reasons.
 */
function generateDb(tmp, options) {
  const file = path.join(tmp, 'db.json');
  try {
    runTool([
      'benchmark/db.js',
      ...(options.quick ? ['--quick'] : []),
      '--output', 'json', '--filepath', file,
    ]);
  }
  catch (e) {
    console.warn(`  warning: db run failed (${e.message}); the suite will be omitted.`);
    console.warn('  (the store head-to-head needs the pouchdb/rxdb/lowdb benchmark devDependencies)');
    return null;
  }
  const raw = readJson(file);
  return {
    meta: raw.meta,
    tables: raw.tables.map((table) => ({
      title: table.title,
      columns: table.columns,
      rows: table.rows.map((row) => ({
        name: row.name,
        results: row.results.map((ns) => (ns === null ? null : sig4(ns))),
      })),
    })),
  };
}

//#endregion

async function main() {
  const options = parseArgs(process.argv);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jaren-website-data-'));
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const started = Date.now();
  const generated = {};

  if (!options.skip.has('validate'))
    generated.validate = generateValidate(tmp, options);
  if (!options.skip.has('jsonpath'))
    generated.jsonpath = generateJsonPath(tmp, options);
  if (!options.skip.has('jsonquery'))
    generated.jsonquery = await generateJsonQuery(tmp, options);
  if (!options.skip.has('jslt'))
    generated.jslt = await generateJslt(tmp, options);
  if (!options.skip.has('formats')) {
    const formats = generateFormats(tmp, options);
    if (formats !== null)
      generated.formats = formats;
  }
  if (!options.skip.has('contracts')) {
    const contracts = generateContracts(tmp, options);
    if (contracts !== null)
      generated.contracts = contracts;
  }
  if (!options.skip.has('contract')) {
    const contract = generateContract(tmp, options);
    if (contract !== null)
      generated.contract = contract;
  }
  if (!options.skip.has('jsonpointer'))
    generated.jsonpointer = generateJsonPointer(tmp, options);
  if (!options.skip.has('jsonpatch'))
    generated.jsonpatch = generateJsonPatch(tmp, options);
  if (!options.skip.has('toml')) {
    const toml = generateToml(tmp, options);
    if (toml !== null) {
      const stream = options.skip.has('jsonx-stream')
        ? null
        : generateJsonxStream(tmp, options);
      generated.toml = mergeToml(toml, stream, previousSuite('toml'));
    }
  }
  if (!options.skip.has('csv')) {
    const csv = generateCsv(tmp, options);
    if (csv !== null)
      generated.csv = csv;
  }
  if (!options.skip.has('markdown')) {
    const markdown = generateMarkdown(tmp, options);
    if (markdown !== null)
      generated.markdown = markdown;
  }
  if (!options.skip.has('mermaid')) {
    const mermaid = generateMermaid(tmp, options);
    if (mermaid !== null)
      generated.mermaid = mermaid;
  }
  if (!options.skip.has('view')) {
    const view = generateView(tmp, options);
    if (view !== null)
      generated.view = view;
  }
  if (!options.skip.has('charts')) {
    const charts = generateCharts(tmp, options);
    if (charts !== null)
      generated.charts = charts;
  }
  if (!options.skip.has('geo')) {
    const geo = generateGeo(tmp, options);
    if (geo !== null)
      generated.geo = geo;
  }
  if (!options.skip.has('flow')) {
    const flow = generateFlow(tmp, options);
    if (flow !== null)
      generated.flow = flow;
  }
  if (!options.skip.has('db')) {
    const db = generateDb(tmp, options);
    if (db !== null)
      generated.db = db;
  }
  if (!options.skip.has('spatial')) {
    const spatial = generateSpatial(tmp, options);
    if (spatial !== null)
      generated.spatial = spatial;
  }
  if (!options.skip.has('orm')) {
    const orm = generateOrm(tmp, options);
    if (orm !== null)
      generated.orm = orm;
  }
  if (!options.skip.has('live')) {
    const live = generateLive(tmp, options);
    if (live !== null)
      generated.live = live;
  }
  if (!options.skip.has('long-horizon')) {
    const horizon = generateLongHorizon(tmp, options);
    if (horizon !== null)
      generated['long-horizon'] = horizon;
  }
  if (!options.skip.has('retrieval')) {
    const retrieval = generateRetrieval(tmp);
    if (retrieval !== null)
      generated.retrieval = retrieval;
  }
  if (!options.skip.has('vector')) {
    const vector = generateVector(tmp, options);
    if (vector !== null)
      generated.vector = vector;
  }
  if (!options.skip.has('series')) {
    const series = generateSeries(tmp, options);
    if (series !== null)
      generated.series = series;
  }

  // Skipped suites keep their previous meta entries (when a meta.json
  // exists), so partial regeneration never clobbers the overview.
  let previousMeta = null;
  try {
    previousMeta = readJson(path.join(OUT_DIR, 'meta.json'));
  }
  catch {
    previousMeta = null;
  }

  const qt3 = options.skip.has('qt3') ? (previousMeta?.qt3 ?? null) : generateQt3();

  console.log('\nAssembling website data files...');
  for (const [name, data] of Object.entries(generated))
    writeText(`${name}.json`, serializeSuite(name, data));

  // meta.json: everything the overview needs without loading the big files.
  const rootPkg = readJson(path.join(ROOT, 'package.json'));
  // What THIS invocation was — the machine, the runtime, the suite
  // version, the iteration mode. It describes the RUN and nothing else:
  // the measurement set is described row by row, because these five
  // fields written over carried rows is exactly how a partial
  // regeneration came to publish weeks-old numbers as freshly measured.
  const lastRun = {
    generated: new Date().toISOString(),
    node: process.version,
    cpu: os.cpus()[0]?.model ?? 'unknown',
    platform: `${os.type()} ${os.arch()}`,
    version: rootPkg.version,
    quick: options.quick,
  };
  const meta = {
    lastRun,
    iterations: {
      validate: generated.validate === undefined
        ? (previousMeta?.iterations?.validate ?? options.iterations)
        : options.iterations,
    },
    qt3,
    conformance: {
      jsonSchema: generated.validate === undefined
        ? (previousMeta?.conformance?.jsonSchema ?? null)
        : {
          engineStats: generated.validate.summary.engineStats,
          drafts: generated.validate.metadata.drafts,
        },
      jsonpath: generated.jsonpath === undefined
        ? (previousMeta?.conformance?.jsonpath ?? null)
        : {
          total: generated.jsonpath.compliance.total,
          pass: Object.fromEntries(
            ['jaren', 'json-p3'].map((engine) => [
              engine,
              generated.jsonpath.compliance.groups
                .reduce((sum, [, entry]) => sum + (entry.pass[engine] ?? 0), 0),
            ])),
        },
      jsonPatch: generated.jsonpatch === undefined
        ? (previousMeta?.conformance?.jsonPatch ?? null)
        : {
          total: generated.jsonpatch.conformance.total,
          pass: generated.jsonpatch.conformance.pass,
        },
      toml: generated.toml === undefined
        ? (previousMeta?.conformance?.toml ?? null)
        : generated.toml.compliance,
      csv: generated.csv === undefined
        ? (previousMeta?.conformance?.csv ?? null)
        : generated.csv.spectrum,
      markdown: generated.markdown === undefined
        ? (previousMeta?.conformance?.markdown ?? null)
        : { examples: generated.markdown.examples, scorecard: generated.markdown.scorecard },
      mermaid: generated.mermaid === undefined
        ? (previousMeta?.conformance?.mermaid ?? null)
        : { examples: generated.mermaid.examples, scorecard: generated.mermaid.scorecard },
    },
  };
  // Derived headline rows for the overview. Suites skipped this run keep
  // their previous rows, so a partial regeneration never empties the
  // summary — and each row records the run that produced it.
  const headlines = carryHeadlines(buildHeadlines(generated, meta), previousMeta?.headlines, lastRun);
  // A published suite with neither a fresh nor a carried row still has a
  // file the site serves: its row is derived from that file and stamped
  // with the file's own measurement date, because this run measured
  // nothing of it. Without this, a suite silently sits out the summary
  // that claims to count every one.
  for (const key of SUITE_ORDER) {
    if (headlines.some((h) => h.key === key)) continue;
    const payload = previousSuite(key);
    if (payload === null) continue;
    const [row] = buildHeadlines({ [key]: payload }, meta);
    if (row !== undefined) headlines.push({ ...row, ...fileProvenance(payload) });
  }
  meta.headlines = headlines
    .sort((a, b) => SUITE_ORDER.indexOf(a.key) - SUITE_ORDER.indexOf(b.key));
  writeText('meta.json', serializeMeta(meta));

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\nDone in ${((Date.now() - started) / 1000).toFixed(1)}s.`);
  if (options.quick)
    console.log('NOTE: --quick numbers are for wiring only; use a full run before publishing.');
}

// The pure assembly steps are exported for the drift tests; running the
// file runs the generator.
export {
  parseArgs, buildHeadlines, carryHeadlines, mergeToml, fileProvenance,
  serializeMeta, serializeSuite, SUITE_ORDER,
};

if (process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
