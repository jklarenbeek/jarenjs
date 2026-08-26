//@ts-check
/**
 * The benchmark derivation boundary: raw generated JSON (from
 * `benchmark/website-data.js`, synced out of the website package) in,
 * kind-tagged render nodes out (lib/nodes.js). Every suite renders
 * through the generic 'ui' rules; adding or reshaping a suite is a
 * pure data transformation here.
 *
 * The suite-wide ratio convention holds everywhere: ratio > 1 means
 * "Jaren is N× faster".
 */

import { cards, table, callout, chart, search, more, details, code } from '../lib/nodes.js';
import { formatNs, formatMs, formatRatio, memo1 } from '../lib/format.js';
import { geoMean } from '@jarenjs/core/math';
import { createChartComponent } from '@jarenjs/charts/component';
import {
  ratioDistributionBars, ratioScatter, conformanceBars,
  profileBars, matrixBars, passCountBars, querySpreadBars, resultTableBars,
  timingBars, headlineRatioBars,
} from '@jarenjs/charts/transforms/benchmark-adapter';

/** Host-linked chart projections; view() memoizes per data object. */
const charts = createChartComponent({ theme: 'host' });

/** A chart node from an adapter `{config, data}` pair. */
const chartNode = (pair, note) => chart(null, charts.view(pair.config, pair.data), note);

export const SUITES = [
  { key: 'overview', label: 'Overview' },
  { key: 'validate', label: 'JSON Schema' },
  { key: 'contracts', label: 'Contracts vs Zod' },
  { key: 'contract', label: 'Contract dispatch' },
  { key: 'jsonpath', label: 'JSONPath' },
  { key: 'jsonquery', label: 'JSON Query' },
  { key: 'jslt', label: 'JSLT' },
  { key: 'formats', label: 'Formats' },
  { key: 'jsonpointer', label: 'JSON Pointer' },
  { key: 'jsonpatch', label: 'JSON Patch' },
  { key: 'toml', label: 'JOSL / TOML' },
  { key: 'csv', label: 'CSV' },
  { key: 'markdown', label: 'Markdown' },
  { key: 'mermaid', label: 'Mermaid' },
  { key: 'view', label: 'View' },
  { key: 'charts', label: 'Charts' },
  { key: 'geo', label: 'Geo' },
  { key: 'flow', label: 'Flow' },
  { key: 'db', label: 'Data' },
  { key: 'spatial', label: 'Spatial' },
  { key: 'orm', label: 'ORM' },
  { key: 'live', label: 'Live' },
  { key: 'long-horizon', label: 'Long horizon' },
  { key: 'retrieval', label: 'Retrieval' },
  { key: 'vector', label: 'Vector' },
  { key: 'series', label: 'Series' },
];

/** The render nodes for the current benchmarks suite. */
export function deriveSuite(state, suite) {
  const need = suite === 'overview' ? 'meta' : suite;
  const status = state.benchStatus[need];
  if (status === 'error') {
    return [callout('Data unavailable', `The benchmark file '${need}.json' could not be loaded. Generate it with: npm run benchmark:generate`)];
  }
  const data = state.bench[need];
  if (data === undefined) {
    return [callout('Loading…', 'Fetching benchmark data.')];
  }
  switch (suite) {
    case 'overview': return overview(data);
    case 'validate': return validate(data, state.benchUi);
    case 'jsonpath': return jsonpath(data, state.benchUi);
    case 'jsonquery': return scenarioMatrix(data, 'query documents');
    case 'jslt': return scenarioMatrix(data, 'stylesheets');
    case 'contracts': return contractsSuite(data);
    case 'contract': return contractSuite(data);
    case 'formats': return formatsSuite(data);
    case 'jsonpointer': return genericTables(data, 'All timings are per-operation nanoseconds; lower is better. Column one is Jaren compiled.');
    case 'jsonpatch': return patch(data);
    case 'toml': return toml(data);
    case 'csv': return csv(data);
    case 'markdown': return markdown(data);
    case 'mermaid': return mermaid(data);
    case 'view': return view(data);
    case 'charts': return chartsSuite(data);
    case 'geo': return geoSuite(data);
    case 'flow': return flowSuite(data);
    case 'db': return dbSuite(data);
    case 'spatial': return spatialSuite(data);
    case 'orm': return ormSuite(data);
    case 'live': return liveSuite(data);
    case 'long-horizon': return scoreTables(data);
    case 'retrieval': return scoreTables(data);
    case 'vector': return scoreTables(data);
    case 'series': return scoreTables(data);
    default: return [callout('Unknown suite', `No derivation for '${suite}'.`)];
  }
}

/** The cross-suite ratio chart, rebuilt only when meta reloads. */
const overviewCharts = memo1((meta) => {
  const headlines = meta.headlines ?? [];
  if (headlines.filter((h) => Number.isFinite(h.ratio)).length === 0) return [];
  return [chartNode(
    headlineRatioBars(headlines, { title: 'Speed vs the fastest rival, per suite (log)' }),
    'One bar per suite; the axis is logarithmic and 1× is parity. Bars below parity are suites where a rival is faster — they are on the chart for the same reason the wins are.')];
});

/** Numeric order for `0.9.0` vs `0.37.1`, which sort backwards as text. */
function compareVersion(a, b) {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * The span one provenance field covers across the headline rows, with
 * the rows that do not record it counted rather than folded in.
 *
 * The tiles used to print the LAST RUN's date and version as though
 * they described every row, over rows measured weeks and versions
 * earlier. A set of rows is honestly summarized by its range.
 */
function provenanceSpan(headlines, pick, compare) {
  const values = headlines.map(pick).filter((v) => typeof v === 'string' && v !== '');
  const known = [...new Set(values)].sort(compare);
  return {
    span: known.length === 0 ? '—'
      : known.length === 1 ? known[0]
        : `${known[0]} → ${known[known.length - 1]}`,
    unknown: headlines.length - values.length,
  };
}

/** `, 3 rows unrecorded` — appended wherever a span leaves rows out. */
const unrecorded = (n) => (n === 0 ? '' : `, ${n} row${n === 1 ? '' : 's'} unrecorded`);

/**
 * The suites this site publishes a page for — the collection the
 * overview's note NAMES. Counting the headline rows alone would let the
 * note say "20 suites measured" over a site that offers 21, which is
 * exactly how a measured suite once went missing without a trace.
 */
const PUBLISHED_SUITES = SUITES.filter((s) => s.key !== 'overview').length;

/** Official-suite draft keys as their specifications name them. */
const DRAFT_LABELS = { draft7: 'draft-07', 'draft2019-09': '2019-09', 'draft2020-12': '2020-12' };

/**
 * The official JSON-Schema-Test-Suite scorecard: one row per draft,
 * `passed / failed / errors` per engine. The benchmarks overview and
 * the docs draft-support section render THIS builder over the same
 * generated stats, so the two surfaces cannot publish two scores for
 * one run.
 * @param {any} engineStats - `{ jaren: {...}, ajv: {...} }`, keyed by draft.
 * @returns {any} a table render node
 */
export function draftConformanceTable(engineStats) {
  const drafts = Object.keys(engineStats?.jaren ?? {});
  return table(
    'JSON Schema conformance — official test suite',
    ['Draft', 'Jaren', 'Ajv'],
    drafts.map((draft) => ({
      cells: [
        DRAFT_LABELS[draft] ?? draft,
        passFail(engineStats.jaren?.[draft]),
        passFail(engineStats.ajv?.[draft]),
      ],
    })),
    'passed / failed / errors, optional format suites included — each engine counted over the tests it could run');
}

/**
 * The overview: what every suite measured, in one screen. Each row is
 * DERIVED from that suite's generated data (benchmark/website-data.js
 * `buildHeadlines`), so the summary cannot drift from the detail pages
 * behind it — and each row carries the run that measured IT, so a
 * partial regeneration is visible here as a range rather than hidden
 * behind one flattering date.
 */
function overview(meta) {
  const headlines = meta.headlines ?? [];
  const lastRun = meta.lastRun ?? {};
  const measured = provenanceSpan(headlines, (h) => (h.generated ?? '').slice(0, 10));
  const versions = provenanceSpan(headlines, (h) => h.version, compareVersion);
  const lastRunDate = (lastRun.generated ?? '').slice(0, 10);
  const out = [cards([
    { title: 'Measured', value: measured.span, note: `${headlines.length} of ${PUBLISHED_SUITES} suites measured${unrecorded(measured.unknown)}` },
    { title: 'Machine', value: lastRun.cpu ?? '—', note: lastRun.platform ?? '' },
    {
      title: 'Suite version',
      value: versions.span === '—' ? '—' : `v${versions.span.replace(' → ', ' → v')}`,
      note: `last run ${lastRunDate || '—'} · ${lastRun.node ?? ''} · ${lastRun.quick ? 'quick iterations' : 'full iterations'}${unrecorded(versions.unknown)}`,
    },
  ])];

  if (headlines.length !== 0) {
    out.push(callout('How to read this page',
      'Every number below is derived from the same generated run as the suite page behind it — nothing here is typed by hand. "Speed" is the geometric mean of the per-scenario ratios against the fastest rival library, so a 10× win and a 10× loss average to parity rather than to 5×. Hand-written JavaScript, where a suite measures it, is a floor reference rather than a rival, and is reported on the suite page instead.'));
    out.push(...overviewCharts(meta));
    out.push(table(
      'Every suite — correctness and speed',
      ['Suite', 'Conformance', 'Speed', 'vs', 'Measured'],
      headlines.map((h) => ({
        cells: [
          h.label,
          h.conformance ?? '—',
          h.ratio === null || h.ratio === undefined ? '—' : formatRatio(h.ratio),
          h.rival ?? '—',
          (h.generated ?? '').slice(0, 10) || '—',
        ],
        strong: Number.isFinite(h.ratio) && h.ratio >= 10,
      })),
      'Conformance is passed / total on that suite\'s official test corpus where one exists. The "Measured" column is the run each row came from: a partial regeneration updates only the suites it ran.'));
    out.push(details('What each headline means', headlines.map((h) => ({
      kind: 'p',
      text: `${h.label} — ${h.note ?? ''}`,
    }))));
  }

  const stats = meta.conformance?.jsonSchema?.engineStats;
  if (stats !== undefined && stats !== null) out.push(draftConformanceTable(stats));
  if (meta.qt3 !== undefined && meta.qt3 !== null) {
    const q = meta.qt3;
    out.push(cards([
      { title: 'QT3 cases', value: String(q.total ?? '—'), note: 'W3C XQuery/XPath 3.1 suite' },
      { title: 'Passing', value: String(q.pass ?? '—'), note: `${q.unsupportedSyntax ?? 0} outside the text subset` },
      { title: 'Regressions', value: String(q.regressions ?? 0), note: 'against the committed baseline' },
    ]));
  }
  return out;
}

function passFail(s) {
  if (s === undefined || s === null) return '—';
  return `${s.passed} / ${s.failed} / ${s.errors}`;
}

/**
 * The search/filter/limit/more skeleton the searchable suite tables
 * share: filter `rows` on the search needle, cap at the limit, and emit
 * the search box, the table and a "show more" node when rows were cut.
 * @param {{ search: string, limit: number }} benchUi
 * @param {object[]} rows - All rows, already in display order
 * @param {(row: object, needle: string) => boolean} matches
 * @param {string} placeholder - Search box placeholder text
 * @param {(shown: object[], total: number) => object} makeTable
 * @returns {object[]} The nodes to push
 */
function searchableTable(benchUi, rows, matches, placeholder, makeTable) {
  const needle = benchUi.search.trim().toLowerCase();
  const filtered = needle === '' ? rows : rows.filter((r) => matches(r, needle));
  const shown = filtered.slice(0, benchUi.limit);
  const out = [
    search('bench/search', benchUi.search, placeholder),
    makeTable(shown, filtered.length),
  ];
  if (filtered.length > shown.length)
    out.push(more('bench/more', `Show more (${filtered.length - shown.length} remaining)`));
  return out;
}

//#region validate

const RATIO_BUCKETS = [
  { label: '> 10× faster', test: (r) => r > 10, tone: 'win' },
  { label: '2–10× faster', test: (r) => r > 2, tone: 'win' },
  { label: '1–2× faster', test: (r) => r >= 1, tone: 'win' },
  { label: '1–2× slower', test: (r) => r >= 0.5, tone: 'loss' },
  { label: '> 2× slower', test: (r) => r < 0.5, tone: 'loss' },
];

/** The validate charts, rebuilt only when the suite data reloads. */
const validateCharts = memo1((data) => {
  const results = Array.isArray(data.results) ? data.results : [];
  const success = results.filter((r) => r.ratio !== null && r.isSuccessTest);
  const nodes = [
    chartNode(ratioDistributionBars(success, RATIO_BUCKETS,
      'Ratio distribution (success-only tests)')),
    chartNode(ratioScatter(success, 'Every success-only test — ratio vs Ajv'),
      'One point per test, fastest ratios first; log scale, dashed line = parity. Points above the line are tests where Jaren is faster.'),
  ];
  const stats = data.summary?.engineStats;
  if (stats !== undefined) {
    nodes.push(chartNode(conformanceBars(stats, 'Official-suite conformance by draft'),
      'Tests passed per draft, optional format suites included.'));
  }
  return nodes;
});

function validate(data, benchUi) {
  const out = [];
  const overall = data.summary?.overall;
  if (overall !== undefined) {
    out.push(cards([
      { title: 'Success-only totals', value: `${Math.round(overall.jarenSuccessTime)} ms vs ${Math.round(overall.ajvSuccessTime)} ms`, note: 'Jaren vs Ajv, tests both can run' },
      { title: 'Jaren wins', value: `${overall.successOnly?.jarenWins ?? '—'} tests`, note: `Ajv wins ${overall.successOnly?.ajvWins ?? '—'}` },
      // both columns are derived: the note used to spell Jaren's side as
      // a literal, which stops being true the moment a test regresses
      { title: 'Ajv failures', value: `${overall.ajvFailures} tests, ${overall.ajvErrors} errors`, note: `Jaren: ${overall.jarenFailures ?? '—'} and ${overall.jarenErrors ?? '—'}` },
    ]));
  }
  const results = Array.isArray(data.results) ? data.results : [];
  const success = results.filter((r) => r.ratio !== null && r.isSuccessTest);

  out.push(...validateCharts(data));

  // the searchable per-test table
  out.push(...searchableTable(benchUi,
    [...success].sort((a, b) => b.ratio - a.ratio),
    (r, needle) => r.description.toLowerCase().includes(needle)
      || r.suite.toLowerCase().includes(needle)
      || r.draft.toLowerCase().includes(needle),
    'Search tests… (description, suite, draft)',
    (shown, total) => table(
      `Per-test results — ${shown.length} of ${total} shown, fastest ratios first`,
      ['Draft', 'Suite', 'Test', 'Ratio', 'Jaren', 'Ajv'],
      shown.map((r) => ({
        cells: [r.draft, r.suite, r.description, formatRatio(r.ratio),
          formatNs(r.jarenTime * 1e6), formatNs(r.ajvTime * 1e6)],
        strong: r.ratio > 10,
      })))));
  return out;
}

//#endregion

//#region jsonpath

/** Top-spread chart, rebuilt only when the suite data reloads. */
const jsonpathCharts = memo1((data) => {
  const rows = data.profile?.rows ?? [];
  if (rows.length === 0) return [];
  return [chartNode(
    querySpreadBars(rows, 'json-p3', 12, 'Widest spreads — ns per query (log)'),
    'The 12 queries with the largest Jaren-vs-json-p3 spread; every query is in the table below.')];
});

/** One name/selector/Jaren/json-p3/ratio row; all three jsonpath tables share it. */
function jsonpathRow(r) {
  return {
    cells: [r.name, r.selector, formatNs(r.engines.jaren), formatNs(r.engines['json-p3']),
      formatRatio(r.engines.jaren > 0 ? r.engines['json-p3'] / r.engines.jaren : null)],
  };
}

function jsonpath(data, benchUi) {
  const out = [];
  const groups = data.compliance?.groups ?? [];
  // Summed from the same per-group rows the table below prints, per
  // engine: the card used to divide the corpus total by itself, so no
  // failure could ever move it. A regression now reads n-1 / n here.
  const total = groups.reduce((n, [, g]) => n + (g.total ?? 0), 0);
  const passed = (engine) => groups.reduce((n, [, g]) => n + (g.pass?.[engine] ?? 0), 0);
  const score = (engine) => (groups.length === 0 ? '—' : `${passed(engine)} / ${total}`);
  out.push(cards([
    { title: 'Compliance', value: score('jaren'), note: `official RFC 9535 CTS · json-p3: ${score('json-p3')}` },
    { title: 'Compile all selectors', value: formatNs(data.profile?.compileRow?.engines?.jaren), note: `json-p3: ${formatNs(data.profile?.compileRow?.engines?.['json-p3'])}` },
  ]));
  out.push(table('Compliance by group', ['Group', 'Tests', 'Jaren', 'json-p3'],
    groups.map(([name, g]) => ({
      cells: [name, String(g.total), String(g.pass?.jaren ?? '—'), String(g.pass?.['json-p3'] ?? '—')],
    }))));
  out.push(...jsonpathCharts(data));

  const rows = data.profile?.rows ?? [];
  out.push(...searchableTable(benchUi, rows,
    (r, needle) => r.name.toLowerCase().includes(needle) || r.selector.toLowerCase().includes(needle),
    'Search queries… (name, selector)',
    (shown, total) => table(
      `Per-query profile — ${shown.length} of ${total} shown (${data.profile?.iterations} iterations)`,
      ['Query', 'Selector', 'Jaren', 'json-p3', 'Ratio'],
      shown.map(jsonpathRow))));

  const scale = data.profile?.scaleRows ?? [];
  if (scale.length > 0) {
    out.push(table('Synthetic scale scenarios (1000 items)', ['Scenario', 'Selector', 'Jaren', 'json-p3', 'Ratio'],
      scale.map(jsonpathRow)));
  }

  // Same document as the scale table, asking only for the first answer.
  // Each engine is timed on the fastest of its own routes to it, so the
  // rival is never held to a route it would not use.
  const earlyExit = data.profile?.earlyExitRows ?? [];
  if (earlyExit.length > 0) {
    out.push(table('Early exit — first match / any match (1000 items)',
      ['Operation', 'Selector', 'Jaren', 'json-p3', 'Ratio'],
      earlyExit.map(jsonpathRow)));
  }
  return out;
}

//#endregion

//#region scenario matrices (jsonquery, jslt)

/** Scenario grouped bars (single-entry memo; suite tabs alternate the
 * data object, which just recomputes on switch). Grouped bars shipped
 * first per the charts program; a heatmap stays the backlogged
 * alternative if the matrix ever reads poorly this way. */
const matrixCharts = memo1((data) => [chartNode(
  matrixBars(data.rows ?? [], { title: 'Scenario matrix — ns per operation (log)' }),
  'Grouped per scenario, log scale — lower is better; the table below is the evidence.')]);

function scenarioMatrix(data, programsWord) {
  const engineKeys = collectEngineKeys(data.rows);
  const out = [];
  out.push(...matrixCharts(data));
  out.push(table(
    `Scenario matrix (per-operation time; ratio vs the fastest rival)`,
    ['Scenario', 'Document', ...engineKeys, 'Ratio'],
    (data.rows ?? []).map((row) => {
      const jaren = row.engines.jaren;
      const rivals = engineKeys.filter((k) => k !== 'jaren').map((k) => row.engines[k]).filter((v) => v > 0);
      const best = rivals.length > 0 ? Math.min(...rivals) : null;
      return {
        cells: [
          row.title ?? row.scenario,
          row.document ?? '',
          ...engineKeys.map((k) => formatNs(row.engines[k])),
          formatRatio(best !== null && jaren > 0 ? best / jaren : null),
        ],
      };
    })));
  if (data.compile !== undefined) {
    out.push(cards(Object.entries(data.compile.results ?? {}).map(([key, value]) => ({
      title: `Compile — ${key}`,
      value: formatNs(value),
      note: `${data.compile.sources?.length ?? '?'} programs, ${data.compile.iterations} iterations`,
    }))));
  }
  for (const scenario of data.scenarios ?? []) {
    out.push(details(`${scenario.title ?? scenario.key} — the ${programsWord}`, [
      { kind: 'p', text: scenario.description ?? '' },
      ...Object.entries(scenario.sources ?? {}).map(([engine, source]) =>
        code(engine, typeof source === 'string' ? prettyMaybeJson(source) : String(source))),
    ]));
  }
  return out;
}

function collectEngineKeys(rows) {
  const keys = [];
  for (const row of rows ?? []) {
    for (const key of Object.keys(row.engines ?? {})) {
      if (!keys.includes(key)) keys.push(key);
    }
  }
  return keys.sort((a, b) => (a === 'jaren' ? -1 : b === 'jaren' ? 1 : 0));
}

function prettyMaybeJson(source) {
  try {
    return JSON.stringify(JSON.parse(source), null, 2);
  }
  catch {
    return source;
  }
}

//#endregion

/** One grouped-bar chart per result table, memoized per data object. */
const genericTableCharts = memo1((data) => (data.tables ?? []).map((t) =>
  chartNode(resultTableBars(t, { log: true, valLabel: 'ns/op (log)' }))));

/** pointer-style payloads: `{ tables: [{ title, columns, rows: [{ name, results[] }] }] }` */
function genericTables(data, note) {
  const chartNodes = genericTableCharts(data);
  return (data.tables ?? []).flatMap((t, i) => [
    chartNodes[i],
    table(
      t.title,
      ['Scenario', ...t.columns],
      t.rows.map((r) => ({ cells: [r.name, ...r.results.map(formatNs)] })),
      note),
  ]);
}

/**
 * Score-style payloads: `{ headline?: { title, text },
 * tables: [{ title, head: [], rows: [{ cells: [], strong? }], note }] }`.
 *
 * A suite whose numbers are SCORES rather than timings carries its own
 * display strings, because `formatNs` would render a percentage as
 * nanoseconds. Nothing here is suite-specific — the generated file
 * decides the columns, so a new suite of this kind needs no derivation
 * of its own beyond naming this function.
 */
function scoreTables(data) {
  const out = [];
  if (data.headline != null)
    out.push(callout(data.headline.title, data.headline.text));
  for (const t of data.tables ?? []) {
    out.push(table(t.title, t.head,
      t.rows.map((r) => ({ cells: r.cells, strong: r.strong === true })),
      t.note ?? null));
  }
  return out;
}

/**
 * The data suite: the phase-A store and LINQ front door. The engines
 * and their storage adapters render above the tables, and the rows
 * where jaren loses stay in — a table that only shows wins is worth
 * nothing to a reader who has to make a decision.
 */
function dbSuite(data) {
  const meta = data.meta ?? {};
  const engineLines = (meta.engines ?? [])
    .map((engine) => `${engine.label}: ${engine.adapter}`).join(' · ');
  const out = [];
  out.push(callout(
    `Pushdown headline: ${meta.headlineRatio}× — the same query document pushed to SQL versus forced to the residual over ${meta.docs} documents (~${meta.docBytes} JSON bytes each)`,
    `${engineLines}. Every engine is verified to answer the same result set before it is timed; jaren pays SQLite and JSON materialisation where the in-process rivals pay neither — the rows it loses are the price of durability, transactions and a planner, and they are shown.`));
  out.push(...genericTables(data,
    'Per-operation timings; lower is better. A dash is an engine dropped for a row because it disagreed on the result set rather than being timed doing less work.'));
  return out;
}

/**
 * The spatial-storage suite. No head-to-head rival exists and the page
 * says so before any number; the row where the database has to beat
 * NOT using the database is a card whichever way it fell; and every
 * timing row carries the plan it ran as — the residual mode, the
 * pre-filters, the database's own narrative — so a reader can see why
 * a row costs what it costs rather than take the ratio on faith.
 */
function spatialSuite(data) {
  const meta = data.meta ?? {};
  const figures = meta.figures ?? {};
  const checks = data.checks ?? [];
  const agreed = checks.filter((c) => c.agrees).length;
  const ratioOr = (x) => (Number.isFinite(x) ? formatRatio(x) : '—');
  const out = [];
  out.push(cards([
    {
      title: 'Correctness gate',
      value: `${agreed} / ${checks.length}`,
      note: `${meta.corpus?.agreed ?? 0} / ${meta.corpus?.cases ?? 0} spatial-corpus plan cases plus every timed shape against the engine, before any timing`,
    },
    {
      title: 'Full scan → derived index',
      value: ratioOr(figures.scanVsIndexed),
      note: 'the $within a consumer writes, before and after derive: \'bbox\'',
    },
    {
      title: 'Against no database at all',
      value: ratioOr(figures.engineVsIndexed),
      note: figures.engineVsIndexed >= 1
        ? 'the indexed store beats the in-memory engine over the parsed array — the row it had to win'
        : 'the in-memory engine over the parsed array still wins — the loss, published',
    },
    {
      title: 'R*Tree vs generated box',
      value: ratioOr(figures.rtreeVsGenerated),
      note: '> 1 favours the R*Tree; below 1.5× a second table kept in sync is not worth its cost',
    },
  ]));
  out.push(callout('No head-to-head rival — and what the named rivals have instead',
    `${(meta.docs ?? 0).toLocaleString()} GeoJSON points stored in SQLite (${meta.engine ?? ''}), one probe box at ~0.5 % selectivity, ${meta.repetitions ?? 0} repetitions after a warm execute. Nothing else in JavaScript stores GeoJSON in SQLite from a JSON query document, so there is no rival to time and none is invented. MongoDB's 2dsphere and DuckDB-wasm's spatial extension have real spatial indexes and overlay operations this store does not have; neither runs one document through three executors proven to agree — the JavaScript engine, SQLite in Node and SQLite compiled to wasm in a browser tab, held to one committed corpus (the Data studio runs it; the browser suite drives it in Chromium, Firefox and WebKit) — neither validates ring closure in a schema, and DuckDB's query is SQL rather than a document. The in-memory engine row starts from parsed objects where the store starts from bytes on a page — that head start is why it is the row to beat.`));
  for (const t of data.tables ?? []) {
    out.push(table(t.title, ['Shape', 'ms/query', 'Rows', 'Plan', 'SQLite says'],
      t.rows.map((r) => ({
        cells: [
          r.name,
          formatNs(r.results[0]),
          String(r.rows),
          `${r.mode}${r.udf ? ' (udf)' : ''}${(r.prefilters ?? []).length > 0 ? ` · ${r.prefilters.join(', ')}` : ''}`,
          r.narrative,
        ],
        strong: r.key === 'engine' || r.key === 'within-indexed',
      })),
      'Per-query timings; lower is better. "set" is the engine refining a SQL-narrowed candidate set; "native" decided in SQL; "raw" is a hand-built statement outside the store.'));
  }
  out.push(table('The gate — every check the timings ran behind', ['Check', 'Agrees', 'Detail'],
    checks.map((c) => ({ cells: [c.name, c.agrees ? 'yes' : 'NO', c.detail], strong: !c.agrees })),
    'A disagreement withholds the whole table at generation time and the tool exits non-zero.'));
  return out;
}

/**
 * The phase-B ORM suite. The honest framing renders FIRST — a
 * skeptical reader should meet it before any number.
 */
function ormSuite(data) {
  const meta = data.meta ?? {};
  const out = [];
  out.push(callout('Read this before the numbers',
    'Prisma, Drizzle and Kysely are mature, support several databases, and are faster on some rows below — those losses are published with their reasons. What none of them has: a query that is one serializable JSON document, executable by two independent engines proven to agree by a differential oracle, running unchanged in Node, Bun and the browser, with schema-validated writes from the fastest validator in the ecosystem. The composition is the product; the individual numbers are what they are.'));
  out.push(callout(
    `Graph-load headline: one statement, ${meta.headlineRatio}× faster than ${meta.headlineRival ?? 'Prisma'} on ${meta.users} users / ${meta.posts} posts / ${meta.comments} comments`,
    `${(meta.engines ?? []).map((engine) => `${engine.label}: ${engine.adapter}`).join(' · ')}. Every engine answers the same normalized result before it is timed; statement counts are printed beside the graph rows because the structural claim (one statement versus round trips) is what timings alone would hide. Runtime: ${meta.runtime}${meta.bunRuntime ? `; the [Bun] tables ran on ${meta.bunRuntime}` : ''}.`));
  if ((meta.bunNotes ?? []).length > 0)
    out.push(callout('The Bun capability cliff', meta.bunNotes.join(' ')));
  out.push(...genericTables(data,
    'Per-operation timings; lower is better. A dash is an engine dropped for a row because it disagreed on the result set rather than being timed doing less work.'));
  return out;
}

/**
 * The phase-C live suite: incremental-vs-re-run, capture overhead, the
 * update-latency head-to-head against RxDB and TinyBase (where jaren
 * LOSES to the in-memory store, published with the reason), the
 * end-to-end path, and job throughput.
 */
function liveSuite(data) {
  const meta = data.meta ?? {};
  const out = [];
  out.push(callout('What incremental maintenance actually buys',
    `Maintaining a live query's result as writes arrive, in time proportional to what changed rather than the size of the result. ${(meta.incrementalRatios ?? []).map((entry) => `${entry.size} rows: ${entry.ratio.toFixed(1)}× faster than re-running the query`).join('; ')}. TinyBase, an in-memory store, beats jaren on raw update latency below — it is not a SQL database and does not persist the same way; that gap is the honest cost of durability. Runtime: ${meta.runtime}.`));
  if ((meta.omitted ?? []).length > 0) {
    out.push(callout('Omitted rivals', `${meta.omitted.join('; ')}.`));
  }
  out.push(...genericTables(data,
    'Per-single-write medians in nanoseconds (job throughput in jobs/second); lower is better except throughput. Every row states what it measures and, for the rivals, the trade it makes.'));
  return out;
}

/**
 * The Zod head-to-head. The caveat is rendered ABOVE the tables rather than
 * as a footnote, because the middle table's ratio flatters Jaren and a
 * reader who takes it at face value draws the wrong conclusion.
 */
function contractsSuite(data) {
  const out = [];
  if (data.caveat != null)
    out.push(callout('Read the third table, not the second', data.caveat));
  out.push(...genericTables(data,
    'Nanoseconds per operation; lower is better. A dash is an engine dropped for that scenario because it disagreed on the verdict or the normalized value, rather than being timed doing less work.'));
  return out;
}

/**
 * The @jarenjs/contract suite: route match vs find-my-way and hono, the
 * dispatch pipeline vs Fastify — through Fastify's own inject harness
 * AND the harness-free composition (find-my-way + Ajv +
 * fast-json-stringify), which is faster than jaren's whole pipeline on
 * every row and stays on the page for exactly that reason — plus the
 * loopback head-to-head and the once-per-process revision cost.
 */
function contractSuite(data) {
  const out = [];
  if (data.caveat != null)
    out.push(callout('Read the harnesses before the numbers', data.caveat));
  out.push(...genericTables(data,
    'Per-request/per-lookup nanoseconds; lower is better. A dash is an engine dropped for a row because it disagreed on the probes or the response, rather than being timed doing less work.'));
  const serialization = data.serialization ?? [];
  if (serialization.length > 0) {
    out.push(table(
      'Where the jaren request goes — the serialization share',
      ['Request', 'JSON.stringify alone', 'whole dispatch', 'share'],
      serialization.map((r) => ({
        cells: [r.name, formatNs(r.stringifyNs), formatNs(r.dispatchNs),
          r.share === null ? '—' : `${(r.share * 100).toFixed(1)}%`],
      })),
      'JSON.stringify of the response value beside the whole in-process dispatch. This is the number that decides whether a schema-driven serializer is worth building: below ~25% the pipeline\'s time is elsewhere.'));
  }
  return out;
}

function formatsSuite(data) {
  const out = [];
  if (data.conformance != null) {
    out.push(cards([{
      title: 'Conformance',
      value: `${data.conformance.pass} / ${data.conformance.total}`,
      note: `official optional/format suite, ${data.conformance.formats} formats`,
    }]));
  }
  out.push(...genericTables(data,
    'Nanoseconds for one accepted plus one rejected value; lower is better. A dash is a format that engine does not implement, or one it accepts the invalid value for.'));
  return out;
}

function patch(data) {
  const out = [];
  if (data.conformance !== undefined) {
    // 108/108 is one number — a chart of it would restate the card, so
    // the conformance stays a stat card and the charts cover timings.
    out.push(cards([{
      title: 'Conformance',
      value: `${data.conformance.pass} / ${data.conformance.total}`,
      note: 'official json-patch-tests suite',
    }]));
  }
  out.push(...genericTables(data, 'Per-application nanoseconds; lower is better.'));
  return out;
}

/** The toml charts, rebuilt only when the suite data reloads. */
const tomlCharts = memo1((data) => ({
  compliance: data.compliance !== undefined
    ? chartNode(passCountBars(data.compliance, {
      title: 'toml-test 1.0.0 — tests passed',
      highlight: 'jaren',
    }))
    : undefined,
  parse: Array.isArray(data.profile?.parse)
    ? chartNode(profileBars(data.profile.parse, data.engines ?? [], {
      title: 'Parse profile — ms per document',
      valLabel: 'ms/op',
    }))
    : undefined,
  streamDocument: Array.isArray(data.stream?.document)
    ? chartNode(timingBars(data.stream.document, {
      title: 'Incremental document — ns per parse (log)', log: true, valLabel: 'ns/op (log)',
    }))
    : undefined,
}));

/**
 * The JSONX / strict-JSON streaming reader rows. `JSON.parse` is the
 * baseline and it wins on raw text — it is a native full-text parser.
 * The point of the comparison is what it costs to gain what
 * `JSON.parse` cannot do at all: accept a document in arbitrary chunks
 * and emit document-order events while it arrives.
 */
function streamingRows(stream, charts) {
  if (stream === undefined || stream === null) return [];
  const out = [callout('Streaming JSON — what the delta buys',
    `JSON.parse is the baseline here and it is faster on complete text: it is a native full-text parser with no incremental input and no events. The reader's delta is the price of accepting a document in arbitrary chunks — split mid-escape, mid-number, mid-keyword — and emitting document-order pair events as it arrives, which is what the live Binance feed and the playground replay run on. Result equality with JSON.parse is asserted before timing.`)];
  out.push(table(
    `Message feed — one ${stream.messageBytes ?? '?'} B document per reader`,
    ['Path', 'ns per document'],
    (stream.message ?? []).map((r) => ({ cells: [r.label, formatNs(r.ns)] })),
    'The WebSocket shape: many small complete documents, a fresh reader each. Reader construction is a flat object allocation, which is why there is no reset()-for-reuse API.'));
  if (charts.streamDocument !== undefined) out.push(charts.streamDocument);
  out.push(table(
    `Incremental document — ${stream.documentBytes ?? '?'} B in ${stream.chunks ?? '?'} chunks of ${stream.chunkBytes ?? '?'} B`,
    ['Path', 'ns per parse'],
    (stream.document ?? []).map((r) => ({ cells: [r.label, formatNs(r.ns)] })),
    'The LLM token-output shape: one large document arriving in small pieces. The last row is the streaming path doing what no full-text parser can.'));
  return out;
}

function toml(data) {
  const out = [];
  const { compliance: complianceChart, parse: parseChart } = tomlCharts(data);
  if (data.compliance !== undefined) {
    out.push(complianceChart);
    out.push(table(
      `toml-test 1.0.0 compliance (${data.cases?.valid ?? '?'} valid + ${data.cases?.invalid ?? '?'} invalid cases)`,
      ['Engine', 'Passing'],
      (data.engines ?? Object.keys(data.compliance)).map((engine) => ({
        cells: [engine, `${data.compliance[engine]?.pass} / ${data.compliance[engine]?.total}`],
        strong: engine === 'jaren',
      }))));
  }
  const profile = data.profile;
  if (profile !== undefined) {
    if (parseChart !== undefined) out.push(parseChart);
    out.push(table(
      `Parse profile (${profile.iterations} iterations)`,
      ['Document', ...(data.engines ?? [])],
      (profile.parse ?? []).map((p) => ({
        cells: [p.name, ...(data.engines ?? []).map((e) => formatMs(p.results[e]))],
      })),
      'smol-toml keeps a raw-throughput edge; Jaren is the only engine passing the complete suite while streaming.'));
  }
  out.push(...streamingRows(data.stream, tomlCharts(data)));
  return out;
}


/** The CSV charts, rebuilt only when the suite data reloads. */
const csvCharts = memo1((data) => ({
  parse: Array.isArray(data.profile?.rows)
    ? chartNode(profileBars(data.profile.rows, data.engines ?? [], {
      title: 'Parse to string arrays — ms per document',
      valLabel: 'ms/op',
    }))
    : undefined,
}));

/**
 * CSV. The acceptance corpus is tiny and everyone passes it, so the
 * interesting tables are the other two: what each parser does to a
 * DAMAGED document, and where the speed actually goes.
 */
function csv(data) {
  const out = [];
  const engines = data.engines ?? [];

  if (data.spectrum !== undefined) {
    out.push(table(
      'csv-spectrum acceptance suite',
      ['Engine', 'Passing'],
      engines.filter((e) => data.spectrum[e] !== undefined).map((engine) => ({
        cells: [engine, `${data.spectrum[engine].pass} / ${data.spectrum[engine].total}`],
        strong: engine === 'jaren',
      })),
      'The de-facto corpus, and every parser here passes it — which is why it is the '
      + 'floor rather than the story. Its twelfth fixture is excluded: the expectation '
      + 'contradicts its own input, so no parser can satisfy it.'));
  }

  if (Array.isArray(data.healing)) {
    const cols = Object.keys(data.healing[0]?.results ?? {});
    out.push(table(
      'Damaged documents — does the record structure survive?',
      ['Damage', ...cols],
      data.healing.map((row) => ({
        cells: [row.damage, ...cols.map((c) => row.results[c])],
      })),
      '"kept" = every record still has the column count the header implies. "threw" = the '
      + 'document was rejected. "hung" = no answer within 5s. A ragged record stays ragged '
      + 'everywhere, because no parser can invent a cell that was never written — the '
      + 'difference is that repair mode SAYS so, with a code, a line and a column, where '
      + 'the others heal silently or reject the file.'));
  }

  const profile = data.profile;
  if (profile !== undefined && profile !== null) {
    const { parse: parseChart } = csvCharts(data);
    if (parseChart !== undefined) out.push(parseChart);
    const timing = (rows, title, note) => table(
      title,
      ['Document', ...engines],
      (rows ?? []).map((row) => ({
        cells: [row.name, ...engines.map((e) => formatMs(row.results[e]))],
      })),
      note);
    out.push(timing(profile.rows, `Parse to string arrays (${profile.iterations} iterations)`,
      'udsv is the honest loss and it is not close on plain data. It earns it: udsv compiles '
      + 'a parser per schema with new Function. Nothing in this suite does, anywhere, because '
      + 'everything here has to run under a strict Content-Security-Policy — the same trade '
      + 'the schema validator and the query engine record. Against every parser that also '
      + 'avoids codegen, jaren leads.'));
    out.push(timing(profile.objects, 'Parse to header-keyed objects',
      'Objects cost more than arrays everywhere: a key per cell instead of a slot.'));
    out.push(timing(profile.streaming, 'Incremental read, 64 KB chunks',
      'Only synchronous incremental readers appear here. fast-csv, csv-parser and csvtojson '
      + 'are stream-only, so timing them beside these would measure Node streams rather than '
      + 'a CSV grammar. Streaming costs about 1.6x the wholesale path for a structural '
      + 'reason: whole-document parsing walks the source once, while a chunk stream needs a '
      + 'side-effect-free cutter pass first because a chunk can stop mid-field.'));
    if (profile.stringify !== undefined) {
      out.push(table('Stringify', ['Engine', 'ms per pass'],
        engines.filter((e) => profile.stringify[e] != null).map((engine) => ({
          cells: [engine, formatMs(profile.stringify[engine])],
          strong: engine === 'jaren',
        })),
        'Writing quotes a field only when it has to: the delimiter, a quote, a newline, or '
        + 'edge whitespace a lenient reader might trim.'));
    }
  }
  return out;
}

/** The markdown charts, rebuilt only when the suite data reloads.
 * The render comparison stays on a linear axis: the engines sit within
 * one order of magnitude, where a log axis would only flatter the
 * slowest. */
const markdownCharts = memo1((data) => ({
  scorecard: data.scorecard !== undefined
    ? chartNode(passCountBars(data.scorecard, {
      title: 'CommonMark scorecard — examples passed',
      highlight: 'jaren-md',
    }))
    : undefined,
  render: Array.isArray(data.profile?.render)
    ? chartNode(profileBars(data.profile.render, data.engines ?? [], {
      title: 'Parse + render to HTML — ms per document',
      valLabel: 'ms/op',
    }))
    : undefined,
}));

function markdown(data) {
  const engines = data.engines ?? [];
  const out = [];
  const { scorecard: scorecardChart, render: renderChart } = markdownCharts(data);
  if (scorecardChart !== undefined) out.push(scorecardChart);
  if (data.scorecard !== undefined) {
    out.push(table(
      `CommonMark scorecard (${data.examples ?? '?'} official spec examples, whitespace-normalized)`,
      ['Engine', 'Passing'],
      engines.map((engine) => ({
        cells: [engine, `${data.scorecard[engine]?.pass} / ${data.scorecard[engine]?.total}`],
        strong: engine === 'jaren-md',
      })),
      'Two Jaren rows, because the difference between them is the safety boundary: the string emitter (toHtml) can pass raw HTML through, while the vnode path renders Markdown to JSON vnodes that structurally cannot hold unescaped markup — so its lower score is the price of being safe on documents it did not write, not a dialect gap.'));
  }
  if (data.gfm !== undefined && data.gfm !== null) {
    const sections = Object.keys(data.gfm.totals ?? {});
    out.push(table(
      `GFM extension scorecard (${data.gfm.examples} examples, every engine's extensions on)`,
      ['Engine', 'Passing', ...sections.map((name) => name.replace(' (extension)', ''))],
      engines.map((engine) => {
        const row = data.gfm.scorecard[engine];
        return {
          cells: [engine, `${row?.pass} / ${row?.total}`,
            ...sections.map((name) => `${row?.sections?.[name] ?? 0} / ${data.gfm.totals[name]}`)],
          strong: engine === 'jaren-md',
        };
      }),
      'The CommonMark corpus says nothing about tables, task lists, strikethrough, autolink literals or disallowed raw HTML, so without this the part of the dialect every engine advertises would be the only part nobody measured. Jaren does not pass two of them on purpose: table alignment is written as a style rather than the deprecated align attribute, and the disallowed-raw-HTML extension is not implemented because the modes a host points at untrusted Markdown already neutralize those tags and every other one. Both are stated in the package README.'));
  }
  const profile = data.profile;
  if (profile !== undefined && profile !== null) {
    if (renderChart !== undefined) out.push(renderChart);
    out.push(table(
      `Parse + render to HTML (${profile.iterations} iterations, ms/op; lower is better)`,
      ['Document', ...engines],
      (profile.render ?? []).map((p) => ({
        cells: [p.name, ...engines.map((e) => formatMs(p.results[e]))],
      })),
      'marked and markdown-it are the mainstream one-shot parsers. The jaren-md row is toHtml — source to HTML string, the same unit; the vnode row does the same work and then builds a keyed, patchable tree, which is what the extra time buys.'));
    const phased = (profile.jaren ?? []).filter((row) => row.phases !== undefined);
    if (phased.length > 0) {
      out.push(table(
        'Where the time goes (ms/op, differenced from whole-pipeline runs)',
        ['Document', 'parse', 'AST→vnode', '· without keys', 'vnode→HTML', 'AST→HTML'],
        phased.map((row) => ({
          cells: [row.name, formatMs(row.phases.parse), formatMs(row.phases.project),
            formatMs(row.phases.projectUnkeyed), formatMs(row.phases.serialize),
            formatMs(row.phases.toHtml)],
        })),
        'The projection, not the parse, is the expensive half — and most of the projection is computing the content-hash keys that let the patcher reorder blocks instead of rebuilding them. A caller that renders once and throws the tree away passes keyed: false and skips it; the default keeps them, because a renderer cannot know whether its output will be patched. The last column is the direct string emitter, which never computes one.'));
    }
    if (Array.isArray(profile.jaren)) {
      out.push(table(
        'Jaren-only: the compiled pipeline',
        ['Document', 'parse → AST', 'cached vnode'],
        profile.jaren.map((p) => ({
          cells: [p.name, formatMs(p.parseMs), `${p.vnodeNs} ns`],
        })),
        'Once compiled, the vnode projection is reference-stable: the view patcher skips an unchanged article in O(1) (~30 ns) — the re-render path the whole suite is built for.'));
    }
  }
  return out;
}

/** The mermaid charts, rebuilt only when the suite data reloads. The
 * Langium head-to-head is near-parity so it stays linear; the Jison
 * one spans two orders of magnitude, hence the log axis. */
const mermaidCharts = memo1((data) => ({
  parse: Array.isArray(data.profile?.parse) && data.profile.parse.length > 0
    ? chartNode(profileBars(data.profile.parse, data.engines ?? ['jaren-mermaid'], {
      title: 'Parse head-to-head — pie, ms per parse',
      valLabel: 'ms/op',
    }))
    : undefined,
  parseJison: Array.isArray(data.profile?.parseJison) && data.profile.parseJison.length > 0
    ? chartNode(profileBars(data.profile.parseJison, data.jisonEngines ?? ['jaren-mermaid', 'mermaid (jison)'], {
      title: 'Parse head-to-head — flowchart / sequence, ms per parse (log)',
      log: true,
      valLabel: 'ms/op (log)',
    }))
    : undefined,
}));

function mermaid(data) {
  const out = [];
  const { parse: parseChart, parseJison: jisonChart } = mermaidCharts(data);
  if (data.scorecard !== undefined) {
    const types = Object.keys(data.scorecard);
    out.push(table(
      `Coverage scorecard (${data.examples ?? '?'} corpus diagrams rendered to SVG without error)`,
      ['Diagram type', 'Rendered'],
      types.map((type) => ({
        cells: [type, `${data.scorecard[type]?.rendered} / ${data.scorecard[type]?.total}`],
        strong: type === 'flowchart' || type === 'sequence',
      })),
      'Flowchart and sequence are fully laid out; class/ER/state/gantt render as structured panels and pie as a chart. Secondary types (mindmap, gitGraph) parse-accept and render an honest "not yet laid out" placeholder — counted, not hidden.'));
  }
  const profile = data.profile;
  if (profile !== undefined && profile !== null) {
    const engines = data.engines ?? ['jaren-mermaid'];
    if (Array.isArray(profile.parse) && profile.parse.length > 0) {
      if (parseChart !== undefined) out.push(parseChart);
      out.push(table(
        `Parse-speed head-to-head — pie vs @mermaid-js/parser (${profile.iterations} iterations, ms/op; lower is better)`,
        ['Diagram', ...engines],
        profile.parse.map((p) => ({
          cells: [p.name, ...engines.map((e) => formatMs(p.results[e]))],
          strong: true,
        })),
        'The standalone @mermaid-js/parser is the Langium parser — it only covers the grammars migrated off Jison (pie among them) and cannot parse flowchart or sequence at all; those still run on Mermaid\'s in-tree Jison grammars (next table).'));
    }
    if (Array.isArray(profile.parseJison) && profile.parseJison.length > 0) {
      const jEngines = ['jaren-mermaid', 'mermaid (jison)'];
      if (jisonChart !== undefined) out.push(jisonChart);
      out.push(table(
        'Parse-speed head-to-head — flowchart / sequence vs mermaid.parse (Jison, ms/op; lower is better)',
        ['Diagram', ...jEngines],
        profile.parseJison.map((p) => ({
          cells: [p.name, ...jEngines.map((e) => formatMs(p.results[e]))],
          strong: true,
        })),
        'Mermaid parses flowchart and sequence with its original in-tree Jison grammars (mermaid.parse, DOM-coupled, run here under jsdom). @jarenjs/mermaid parses the same sources roughly two orders of magnitude faster — a synchronous, allocation-light char-code recursive descent vs a generated Jison parser plus type-detection and validation. mermaid.parse is heavy and noisy, so this is the full parse front-end, not a bare-grammar microbenchmark.'));
    }
    if (Array.isArray(profile.jaren)) {
      out.push(table(
        'Jaren-only: headless parse → layout → SVG (no browser)',
        ['Diagram', 'parse → AST', 'parse → SVG string'],
        profile.jaren.map((p) => ({
          cells: [p.name, formatMs(p.parseMs), formatMs(p.svgMs)],
        })),
        'mermaid.js needs a browser DOM (getBBox) to render, so there is no fair full-render head-to-head; @jarenjs/mermaid produces a complete standalone SVG string in pure Node — a capability mermaid.js lacks.'));
    }
  }
  return out;
}

//#region view + charts

/** The view charts, rebuilt only when the suite data reloads. */
const viewCharts = memo1((data) => {
  const t = data.tables ?? {};
  return {
    build: chartNode(timingBars(t.build ?? [], {
      title: 'View production — full build, ns per view (log)', log: true, valLabel: 'ns/op (log)',
    })),
    update: chartNode(timingBars(t.update ?? [], {
      title: 'View production — one changed row, ns per view (log)', log: true, valLabel: 'ns/op (log)',
    })),
    ssr: chartNode(timingBars(t.ssr ?? [], {
      title: 'SSR — vnodes to HTML string, ns per render', valLabel: 'ns/op',
    })),
    memo: chartNode(timingBars(t.memo ?? [], {
      title: 'The memo marker — reallocated parent over shared children', valLabel: 'ns/frame',
    })),
  };
});

/**
 * The view suite. This is the one page where Jaren does NOT lead, and
 * it says so in the lead paragraph rather than burying it: producing
 * vnodes through a generic JSLT dispatcher costs multiples of a
 * hand-written `h()` call. What the architecture buys is the
 * *re-render* path — proof-of-no-change instead of rebuild-and-diff —
 * so both halves ship on the same page.
 */
function view(data) {
  const t = data.tables ?? {};
  const c = viewCharts(data);
  const out = [];
  const row = (rows, label) => rows.find((r) => r.label.includes(label));
  const build = t.build ?? [];
  const jarenBuild = row(build, 'no memo');
  const handBuild = row(build, 'hand-written');
  // 'react createElement', never bare 'react': every 'preact' label
  // contains 'react' too, and the sorted order must not decide the match.
  const reactBuild = row(build, 'react createElement');
  const frame = t.frame ?? [];
  const memoFrame = row(frame, '(memo)');
  const plainFrame = row(frame, '(no memo)');
  const memoPair = t.memo ?? [];

  out.push(cards([
    {
      // The loss leads, as everywhere on this site. formatRatio names
      // the direction itself, so this reads "11× slower" — the honest
      // label for the views-as-DATA path, stated against the fastest
      // rival build on the page.
      title: 'Stylesheet vnode production vs React',
      value: jarenBuild !== undefined && reactBuild !== undefined
        ? formatRatio(reactBuild.ns / jarenBuild.ns)
        : '—',
      note: 'the price of views as data: a generic dispatcher, not code',
    },
    {
      // ...and this reads "1.8× faster" — the tagged-array FORMAT,
      // hand-written the same way a React view is, is the fastest
      // element builder on the page. The engine is the price; the
      // format never was.
      title: 'Hand-written vnodes vs React',
      value: handBuild !== undefined && reactBuild !== undefined
        ? formatRatio(reactBuild.ns / handBuild.ns)
        : '—',
      note: 'the format itself: an array literal and a plain object per node',
    },
    {
      title: 'Frame with memo',
      value: memoFrame !== undefined && plainFrame !== undefined
        ? formatRatio(plainFrame.ns / memoFrame.ns)
        : '—',
      note: 'view + patch, one changed row — against its own no-memo path',
    },
    {
      title: 'Memo-marker skip',
      value: memoPair.length === 2 ? formatRatio(memoPair[1].ns / memoPair[0].ns) : '—',
      note: `${data.memoChildren ?? '?'} shared children under a rebuilt parent`,
    },
  ]));
  out.push(callout('What this suite measures — the format, the engine, and where we lose',
    'Two different things get measured here, and conflating them is how this table gets misread. The FORMAT: a Jaren vnode is a tagged array — an array literal plus a plain object — and a hand-written view producing them directly (the same authoring model as a React or preact view) is the fastest element builder on this page; the renderer, patcher and SSR consume tagged arrays no matter who built them. The ENGINE: a JSLT stylesheet is a view as DATA — schema-validated, serializable, storable, safe to accept from a constrained decoder — and running that document through a generic dispatcher costs roughly 20× the hand-written build. None of the rivals has a data-driven mode to compare that against: a JSX view is code by construction. So the engine rows are the measured price of a capability the others do not offer, the hand-written rows are the like-for-like comparison, and both ship on the same page with SSR output asserted byte-identical to React and preact before timing.'));

  out.push(c.build);
  out.push(table('View production — full build (fresh state, memo cold)',
    ['Engine', 'ns per view'],
    build.map((r) => ({ cells: [r.label, formatNs(r.ns)], strong: r.label.startsWith('jaren') })),
    `${data.rows ?? '?'} rows, ${data.iterations ?? '?'} iterations; lower is better.`));

  out.push(c.update);
  out.push(table('View production — one copy-on-write row updated',
    ['Engine', 'ns per view'],
    (t.update ?? []).map((r) => ({ cells: [r.label, formatNs(r.ns)], strong: r.label.startsWith('jaren') })),
    'React, hyperapp and preact re-run the whole view function per change (their idiomatic default; each offers opt-in per-call-site memoization, and React runs its production build here). Jaren\'s memo is a compile option that needs no view changes.'));

  out.push(c.ssr);
  out.push(table('SSR — vnodes to an HTML string',
    ['Engine', 'ns per render'],
    (t.ssr ?? []).map((r) => ({ cells: [r.label, formatNs(r.ns)], strong: r.label.startsWith('jaren') })),
    `Output equality is asserted before timing: every engine emits the same ${data.ssrChars ?? '?'}-character document.`));

  out.push(table('Frame cost — view + DOM patch (Jaren only)',
    ['Path', 'ns per frame'],
    frame.map((r) => ({ cells: [r.label, formatNs(r.ns)] })),
    'Measured against the repository\'s DOM stub, so no cross-framework claim is made here — React, hyperapp and preact need a real DOM. At this size the hand-written view wins the frame outright: its build is so cheap that a full diff still beats the stylesheet\'s memoized walk, and that is on the page rather than hidden. What the memo buys is the case this table does not exercise: an UNCHANGED document returns the previous tree by reference and the whole frame is O(1), and the memo-marker rows below show the same skip working for hand-written producers too.'));

  out.push(c.memo);
  out.push(table('The memo marker (VIEW-FORMAT §5.5)',
    ['Path', 'ns per frame'],
    memoPair.map((r) => ({ cells: [r.label, formatNs(r.ns)] })),
    'When a producer rebuilds its tree but knows a region did not change, an equal `memo` prop skips that subtree outright — instead of walking every child to discover the reference-equality skips one at a time.'));
  return out;
}

/** The charts suite charts, rebuilt only when the suite data reloads. */
const chartsSuiteCharts = memo1((data) => ({
  types: chartNode(timingBars(data.types ?? [], {
    title: 'Compile + project, ns per chart (log)', log: true, valLabel: 'ns/op (log)',
  })),
  scaling: chartNode(profileBars(
    (data.scaling ?? []).map((s) => ({
      name: `${s.points} × ${s.series}`,
      results: { 'incremental session': s.sessionNs, 'wholesale re-render': s.wholesaleNs },
    })),
    ['incremental session', 'wholesale re-render'],
    { title: 'One appended point — session vs wholesale (log)', log: true, valLabel: 'ns/tick (log)' })),
  barScaling: chartNode(profileBars(
    (data.barScaling ?? []).map((s) => ({
      name: `${s.categories} categories`,
      results: { 'incremental session': s.sessionNs, 'wholesale re-render': s.wholesaleNs },
    })),
    ['incremental session', 'wholesale re-render'],
    { title: 'One live count — session vs wholesale (log)', log: true, valLabel: 'ns/tick (log)' })),
}));

/** The charts suite: per-type cost, and the O(change) scaling evidence. */
function chartsSuite(data) {
  const c = chartsSuiteCharts(data);
  const scaling = data.scaling ?? [];
  const first = scaling[0];
  const last = scaling[scaling.length - 1];
  const out = [];
  if (first !== undefined && last !== undefined) {
    out.push(cards([
      {
        title: 'Incremental tick',
        value: formatNs(last.sessionNs),
        note: `one appended point at ${last.points}×${last.series}`,
      },
      {
        title: 'Same tick, wholesale',
        value: formatNs(last.wholesaleNs),
        // not formatRatio: this is a cost multiple, not a "faster than"
        // comparison, and the direction word would invert its meaning
        note: `the same appended point re-rendered whole — ${Math.round(last.wholesaleNs / last.sessionNs)}× the session's cost`,
      },
      {
        title: 'Flatness',
        value: `${(last.sessionNs / first.sessionNs).toFixed(2)}×`,
        note: `session tick at ${last.points} points ÷ at ${first.points} points`,
      },
    ]));
  }
  out.push(callout('Why the session tick does not grow',
    'A chart AST stores positions as fractions of its domain, so a tick that moves the scales legitimately changes every mark — and re-rendering wholesale is then the correct output, not a failure. Declaring a domain policy (a quantized window, pinned or step-quantized bounds) keeps most ticks still, and the session then patches only the series that changed. Every tick is asserted byte-identical to a wholesale render of the same data.'));
  out.push(c.scaling);
  out.push(table('One appended point — incremental session vs wholesale re-render',
    ['Points × series', 'Session tick', 'Wholesale tick', 'Ratio', 'Frames incremental'],
    scaling.map((s) => ({
      cells: [
        `${s.points} × ${s.series}`,
        formatNs(s.sessionNs),
        formatNs(s.wholesaleNs),
        formatRatio(s.sessionNs > 0 ? s.wholesaleNs / s.sessionNs : null),
        `${s.incremental} of ${s.incremental + s.rebuilt}`,
      ],
      strong: true,
    })),
    'The session column is flat in the point count; the wholesale column is linear in it.'));
  const barScaling = data.barScaling ?? [];
  if (barScaling.length !== 0) {
    out.push(c.barScaling);
    out.push(table('One live count — bar session vs wholesale re-render',
      ['Categories', 'Session tick', 'Wholesale tick', 'Ratio', 'Frames incremental'],
      barScaling.map((s) => ({
        cells: [
          String(s.categories),
          formatNs(s.sessionNs),
          formatNs(s.wholesaleNs),
          formatRatio(s.sessionNs > 0 ? s.wholesaleNs / s.sessionNs : null),
          `${s.incremental} of ${s.incremental + s.rebuilt}`,
        ],
        strong: true,
      })),
      'Only the vnode work is O(1) here — one rect re-emitted. The stillness test rescans '
      + 'every category (a count that drops can retire the tallest bar), so the session column '
      + 'grows with the category count too, just far more slowly than the wholesale one.'));
  }
  out.push(c.types);
  out.push(table('Compile + project, per chart type',
    ['Scenario', 'ns per chart'],
    (data.types ?? []).map((r) => ({ cells: [r.label, formatNs(r.ns)] })),
    `${data.iterations ?? '?'} iterations; definition plus data to a geometry-free AST to pure vnodes.`));
  return out;
}

/** The geo suite chart, rebuilt only when the suite data reloads. */
const geoCharts = memo1((data) => [chartNode(
  profileBars(
    (data.rows ?? []).filter((r) => r.rival !== null).map((r) => ({
      name: r.name,
      results: { jaren: r.ours, [r.rivalName]: r.rival },
    })),
    ['jaren', 'turf', 'geolib', 'flatbush'],
    { title: 'Spatial kernel vs the field, ns per op (log)', log: true, valLabel: 'ns/op (log)' }),
  'Each scenario against the rival that owns it: Turf for GeoJSON measurement, geolib for distance, Flatbush for the static box index.')]);

/**
 * The geo suite: the spatial kernel against Turf, geolib and Flatbush,
 * with the result-equivalence checks that gate the timings shown as
 * their own table — a spatial library that is fast and wrong is worse
 * than one that is neither, so the agreement is the headline claim and
 * the speed the second one.
 */
function geoSuite(data) {
  const rows = data.rows ?? [];
  const checks = data.checks ?? [];
  const agreed = checks.filter((c) => c.agrees).length;
  const ratios = rows
    .filter((r) => r.rival !== null && r.ours > 0)
    .map((r) => r.rival / r.ours);
  const geomean = geoMean(ratios);
  const pip = rows.find((r) => r.name.includes('polygon (2000'));

  const out = [];
  out.push(cards([
    {
      title: 'Result equivalence',
      value: `${agreed} / ${checks.length}`,
      note: 'asserted against Turf, geolib and Flatbush before any timing',
    },
    {
      title: 'Speed vs the field',
      value: geomean === null ? '—' : formatRatio(geomean),
      note: 'geometric mean over every head-to-head row, losses included',
    },
    {
      title: 'Point in polygon, 2000 vertices',
      value: pip !== undefined && pip.rival !== null ? formatRatio(pip.rival / pip.ours) : '—',
      note: 'the deliberate loss: the exact orientation predicate, kept over the fast answer',
    },
  ]));
  out.push(callout('What this suite measures — including where we lose',
    'The kernel is screen-then-refine: a planar equirectangular distance screens candidates at a fraction of haversine\'s cost (both are rows below) and the spherical answer refines the survivors — the same build-then-probe shape as the query engine\'s hash join. The honest rows are all here: point-in-polygon on a large ring runs at roughly half Turf\'s speed because every crossing uses the exact orientation predicate — an answer that cannot flip on near-collinear edges — and that trade is kept on purpose. geolib\'s distance is Vincenty on the WGS 84 ellipsoid, a genuinely different model; the equivalence check states the tolerance instead of hiding the difference.'));
  out.push(callout('The same query, three executors',
    'The kernel timed here is the one the query engine\'s spatial operators call, and one committed corpus holds three executors of the same spatial query document to the same answers: the JavaScript engine, SQLite through the Node driver, and SQLite compiled to wasm in a browser tab — the Data studio runs it, and the browser suite drives it in Chromium, Firefox and WebKit. Agreement is the claim, not speed; the browser leg proves execution, not durability. MongoDB\'s 2dsphere has the query document and the index without a browser or a second engine to agree with; DuckDB-wasm\'s spatial extension has the browser and the index, and its query is SQL.'));
  out.push(...geoCharts(data));
  out.push(table('Head to head, ns per operation',
    ['Scenario', 'Jaren', 'Rival', 'Who', 'Ratio'],
    rows.map((r) => ({
      cells: [
        r.name,
        formatNs(r.ours),
        r.rival === null ? '—' : formatNs(r.rival),
        r.rivalName || '—',
        r.rival === null ? '—' : formatRatio(r.ours > 0 ? r.rival / r.ours : null),
      ],
      strong: r.rival !== null && r.ours > 0 && r.rival / r.ours >= 1,
    })),
    `${(data.iterations ?? 0).toLocaleString()} iterations; lower is better. Rows without a rival are Jaren-only reference points.`));
  out.push(table('Result equivalence — the gate the timings run behind',
    ['Scenario', 'Rival', 'Agrees', 'Detail'],
    checks.map((c) => ({
      cells: [c.name, c.rival, c.agrees ? 'yes' : 'NO', c.note !== '' ? `${c.detail} (${c.note})` : c.detail],
      strong: !c.agrees,
    })),
    'A disagreement beyond the stated tolerance withholds the timing table at generation time.'));
  return out;
}

/**
 * The flow suite: the FSM head-to-head against XState (compile,
 * transition, the serializability wedge, the memory loss) and the DAG
 * abstraction price against a hand-written baseline. The wedge is a
 * conformance row — yes/no, the toml-test register — not a timing.
 */
function flowSuite(data) {
  const sizes = data.sizes ?? [];
  const mid = sizes[1] ?? sizes[0];
  const row = (rows, needle) => (rows ?? []).find((r) => r.label.includes(needle));
  const transMid = data.transition?.[mid] ?? [];
  const step = row(transMid, 'step');
  const actor = row(transMid, 'xstate');
  const compileMid = data.compile?.[mid] ?? [];
  const jarenC = row(compileMid, 'jaren');
  const xstateC = row(compileMid, 'xstate');
  const wedge = data.wedge?.guardsSurviveJson ?? {};
  const mem = data.memory;

  const out = [];
  out.push(cards([
    {
      title: 'Transition vs XState',
      value: step !== undefined && actor !== undefined ? formatRatio(actor.ns / step.ns) : '—',
      note: `pure step vs actor.send, ${mid}-state machine`,
    },
    {
      title: 'Compile vs XState',
      value: jarenC !== undefined && xstateC !== undefined ? formatRatio(xstateC.ns / jarenC.ns) : '—',
      note: 'compileFsm vs createMachine + createActor',
    },
    {
      title: 'Machine survives JSON',
      value: wedge.jaren ? 'yes' : '—',
      note: 'guards included — XState\'s are functions JSON drops',
    },
    {
      title: 'Memory per machine',
      value: mem ? `${(mem.jarenBytesPer / 1024).toFixed(0)} KiB` : '—',
      // the honest loss, stated as a cost not a "faster than"
      note: mem ? `${mem.states}-state machine; XState's actor holds ${(mem.xstateBytesPer / 1024).toFixed(0)} KiB — we compile every guard as a query, so we hold more` : '',
    },
  ]));

  out.push(callout('What this suite measures — the wedge, and where we lose',
    'A jaren-fsm is one JSON document — states, transitions AND guards — so it survives a JSON round trip and still compiles and still fires its guard identically; the conformance row below is that fact. An XState machine\'s guards are functions in the second createMachine argument, which JSON.stringify drops, so the round-tripped machine throws "Guard not implemented" at the guarded transition. That is the whole reason to speak JSON all the way down: a machine you can serialize, store, diff, ship and replay. The pure step is several times faster than XState\'s actor.send, and compile is faster too — but the actor does scheduling and snapshot work the pure function does not, and a compiled Jaren machine holds MORE memory than the actor because every guard compiles to its own query closure. Both are on the page. The dag half pays the documented dataflow tax below.'));

  // the wedge, as a conformance table (toml-test register)
  out.push(table('Serializability — does the guarded machine survive a JSON round trip?',
    ['Engine', 'Guards are…', 'Survives JSON.stringify → parse'],
    [
      { cells: ['@jarenjs/flow', 'query documents (data)', wedge.jaren ? 'yes — compiles and the guard still fires' : 'no'], strong: true },
      { cells: ['XState v5', 'functions (code)', wedge.xstate ? 'yes' : 'no — the guard is dropped; the transition throws'] },
    ],
    'The conformance half of this suite: a machine is only "data all the way down" if its guards survive with it.'));

  for (const n of sizes) {
    const tr = data.transition?.[n] ?? [];
    if (tr.length > 0) {
      out.push(chartNode(timingBars(tr, { title: `Transition — ${n}-state machine`, valLabel: 'ns/op' })));
      out.push(table(`Transition — ${n}-state machine`,
        ['Route', 'ns per transition'],
        tr.map((r) => ({ cells: [r.label, formatNs(r.ns)], strong: r.label.startsWith('jaren') })),
        'Both Jaren routes are shown: the pure total-function step and the mutable session wrapper.'));
    }
  }

  const compileRows = sizes.map((n) => {
    const c = data.compile?.[n] ?? [];
    return { n, jaren: row(c, 'jaren'), xstate: row(c, 'xstate') };
  }).filter((r) => r.jaren !== undefined && r.xstate !== undefined);
  if (compileRows.length > 0) {
    out.push(table('Compile — jaren-fsm vs XState (createMachine + createActor)',
      ['States', 'compileFsm', 'XState', 'Ratio'],
      compileRows.map((r) => ({
        cells: [String(r.n), formatNs(r.jaren.ns), formatNs(r.xstate.ns), formatRatio(r.xstate.ns / r.jaren.ns)],
        strong: true,
      })),
      'XState builds an actor (scheduling, snapshots); the Jaren column is the pure compile. Not like-for-like — the description→drivable cost each charges.'));
  }

  const dag = data.dag;
  if (dag !== undefined) {
    out.push(callout('The dataflow tax',
      'No npm library executes schema-validated JSON dataflow, so the honest rival is the same pipeline (filter → join → project) written straight in JavaScript — the view suite\'s hand-written-vs-stylesheet honesty, applied to graphs. The ratio is the price of dataflow as one serializable, constrained-decodable JSON value, and it ships beside what it buys.'));
    const dagRow = (variant, r) => ({
      cells: [variant, `${r.rows}`, formatNs(r.dagMs * 1e6), formatNs(r.handMs * 1e6), `${(r.dagMs / r.handMs).toFixed(1)}× the baseline`],
      strong: true,
    });
    out.push(table('Dag vs a hand-written baseline (same pipeline, byte-identical output)',
      ['Variant', 'Rows', 'jaren-dag', 'hand-written JS', 'Abstraction price'],
      [
        ...(dag.sync ?? []).map((r) => dagRow('no-task', r)),
        ...(dag.async ?? []).map((r) => dagRow('mixed-async', r)),
      ],
      'The dag is compiled once, then run per iteration; the hand-written baseline is wrapped so both await once. The tax is the dispatcher and the wavefront; what it buys is validation, projection and constrained decoding.'));
  }

  out.push(callout('Reproduce it',
    'npm run benchmark:flow (the FSM head-to-head needs the xstate benchmark devDependency; the memory row needs node --expose-gc, which the script passes).'));
  return out;
}

//#endregion
