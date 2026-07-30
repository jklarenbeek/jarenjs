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
 *   jsonpath.json     jsonpath.js       — CTS compliance + per-query profile vs json-p3
 *   jsonquery.json    jsonquery.js      — scenario matrix vs fontoxpath/jsonata (+ sources)
 *   jslt.json         jslt.js           — scenario matrix vs native JS/JSONata (+ sources)
 *   formats.json      formats.js        — string `format` validation vs ajv-formats
 *   jsonpointer.json  jsonpointer.js    — compiled vs legacy vs jsonpointer npm
 *   jsonpatch.json    jsonpatch.js      — compiled COW patch/merge vs naive clone-and-interpret
 *   toml.json         toml.js           — JOSL strict-TOML vs smol-toml/@iarna/toml/toml (toml-test)
 *   markdown.json     markdown.js       — @jarenjs/md vs marked/markdown-it/micromark (CommonMark spec)
 *   mermaid.json      mermaid.js        — @jarenjs/mermaid coverage + parse-speed vs @mermaid-js/parser
 *   geo.json          geo.js            — spatial kernel vs turf/geolib/flatbush (equivalence-gated)
 *   meta.json                           — run metadata, conformance summary, QT3 scorecard
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'packages', 'website', 'public', 'benchmarks');

//#region helpers

function parseArgs(argv) {
  const options = { iterations: 1000, quick: false, skip: new Set() };
  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case '--iterations': case '-i': options.iterations = parseInt(argv[++i], 10); break;
      case '--quick': options.quick = true; break;
      case '--skip': argv[++i].split(',').forEach((s) => options.skip.add(s.trim())); break;
      case '--help': case '-h':
        console.log('Usage: node benchmark/website-data.js [--quick] [--iterations N] [--skip suite,suite]');
        console.log('Suites: validate, jsonpath, jsonquery, jslt, formats, jsonpointer, jsonpatch, toml, csv, markdown, mermaid, view, charts, geo, qt3');
        process.exit(0);
        break;
      default:
        console.error(`Unknown option: ${argv[i]}`);
        process.exit(2);
    }
  }
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

function writeJson(name, data) {
  const filepath = path.join(OUT_DIR, name);
  fs.writeFileSync(filepath, JSON.stringify(data));
  const kb = (fs.statSync(filepath).size / 1024).toFixed(1);
  console.log(`  -> ${path.relative(ROOT, filepath)} (${kb} kB)`);
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
  'validate', 'contracts', 'jsonpath', 'jsonquery', 'jslt', 'formats', 'jsonpointer', 'jsonpatch',
  'toml', 'csv', 'markdown', 'mermaid', 'view', 'charts', 'geo',
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
  if (generated.jsonpath !== undefined) {
    const rows = generated.jsonpath.profile?.rows ?? [];
    add('jsonpath', 'JSONPath', {
      ratio: geoMean(rows.map((r) => r.engines['json-p3'] / r.engines.jaren)),
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
  return out;
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
  if (!options.skip.has('formats'))
    generated.formats = generateFormats(tmp, options);
  if (!options.skip.has('contracts'))
    generated.contracts = generateContracts(tmp, options);
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
      generated.toml = stream === null ? toml : { ...toml, stream };
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
    writeJson(`${name}.json`, data);

  // meta.json: everything the overview needs without loading the big files.
  const rootPkg = readJson(path.join(ROOT, 'package.json'));
  const meta = {
    generated: new Date().toISOString(),
    node: process.version,
    cpu: os.cpus()[0]?.model ?? 'unknown',
    platform: `${os.type()} ${os.arch()}`,
    version: rootPkg.version,
    quick: options.quick,
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
  // Derived headline rows for the overview. Suites skipped this run
  // keep their previous rows, so a partial regeneration never empties
  // the summary — and each row records the run that produced it.
  const freshHeadlines = buildHeadlines(generated, meta);
  const carried = (previousMeta?.headlines ?? [])
    .filter((h) => !freshHeadlines.some((f) => f.key === h.key));
  meta.headlines = [...freshHeadlines.map((h) => ({ ...h, generated: meta.generated })), ...carried]
    .sort((a, b) => SUITE_ORDER.indexOf(a.key) - SUITE_ORDER.indexOf(b.key));
  writeJson('meta.json', meta);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\nDone in ${((Date.now() - started) / 1000).toFixed(1)}s.`);
  if (options.quick)
    console.log('NOTE: --quick numbers are for wiring only; use a full run before publishing.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
