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
import { formatNs, formatMs, memo1 } from '../lib/format.js';
import { siteText } from '../messages.js';
import { Float64, geoMean } from '@jarenjs/core/math';
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

/** The site's words in English: what a caller that passes none reads. */
const ENGLISH = siteText();

/**
 * A speed ratio, named in the direction it fell, in the page's words
 * (`formatRatio`'s rounding: three significant figures).
 * @param {(id: any, params?: Record<string, unknown>) => string} say
 * @param {number | null | undefined} ratio
 */
function formatRatioIn(say, ratio) {
  if (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio <= 0) return '—';
  return ratio >= 1
    ? say('site/bench/ratio-faster', { ratio: Float64.roundToPrecision(ratio, 3) })
    : say('site/bench/ratio-slower', { ratio: Float64.roundToPrecision(1 / ratio, 3) });
}

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
  { key: 'vector', label: 'Vector' },
  { key: 'series', label: 'Series' },
];

/**
 * The render nodes for the current benchmarks suite.
 * @param {any} state - the bench slices: `bench`, `benchStatus`, `benchUi`
 * @param {string} suite - the suite key
 * @param {(id: any, params?: Record<string, unknown>) => string} [say] - the
 *   site's words in the reader's language (`siteText(pack)`); English by default
 * @returns {any[]}
 */
export function deriveSuite(state, suite, say = ENGLISH) {
  const need = suite === 'overview' ? 'meta' : suite;
  const status = state.benchStatus[need];
  if (status === 'error') {
    return [callout(say('site/bench/unavailable'), `The benchmark file '${need}.json' could not be loaded. Generate it with: npm run benchmark:generate`)];
  }
  const data = state.bench[need];
  if (data === undefined) {
    return [callout(say('site/bench/loading'), say('site/bench/loading-text'))];
  }
  const nodes = suiteNodes(suite, data, state, say);
  return data.firstCalls == null ? nodes : [...nodes, ...firstCallsNodes(data.firstCalls, say)];
}

/**
 * A suite's first-calls tables, after its own: the same operation's first
 * calls in a fresh process, where the tables above are the engines once
 * they have settled. Every timed suite publishes them the same way, so
 * one derivation renders them all.
 */
function firstCallsNodes(firstCalls, say) {
  const out = [callout(say('site/bench/first-calls'),
    `The tables above time each engine once it has settled. These time ${firstCalls.operation} over its first calls in a fresh process, each cell the median of ${firstCalls.processes ?? 3} processes: what a service's first requests after a start meet.`)];
  for (const t of firstCalls.tables ?? []) {
    out.push(table(t.title, [say('site/bench/col/case'), ...t.columns],
      t.rows.map((r) => ({ cells: [r.name, ...r.results.map(formatNs)] })),
      'Time per call, averaged over the first calls; lower is better. A dash is a cell the suite does not time.'));
  }
  return out;
}

/** The suite's own render nodes. */
function suiteNodes(suite, data, state, say) {
  switch (suite) {
    case 'overview': return overview(data, say);
    case 'validate': return validate(data, state.benchUi, say);
    case 'jsonpath': return jsonpath(data, state.benchUi, say);
    case 'jsonquery': return scenarioMatrix(data, 'query', say);
    case 'jslt': return scenarioMatrix(data, 'jslt', say);
    case 'contracts': return contractsSuite(data, say);
    case 'contract': return contractSuite(data, say);
    case 'formats': return formatsSuite(data, say);
    case 'jsonpointer': return genericTables(data, 'All timings are per operation; lower is better. Column one is Jaren compiled.', say);
    case 'jsonpatch': return patch(data, say);
    case 'toml': return toml(data, say);
    case 'csv': return csv(data, say);
    case 'markdown': return markdown(data, say);
    case 'mermaid': return mermaid(data, say);
    case 'view': return view(data, say);
    case 'charts': return chartsSuite(data, say);
    case 'geo': return geoSuite(data, say);
    case 'flow': return flowSuite(data, say);
    case 'db': return dbSuite(data, say);
    case 'spatial': return spatialSuite(data, say);
    case 'orm': return ormSuite(data, say);
    case 'live': return liveSuite(data, say);
    case 'vector': return scoreTables(data);
    case 'series': return scoreTables(data);
    default: return [callout(say('site/bench/unknown-suite'), `No derivation for '${suite}'.`)];
  }
}

/** The cross-suite ratio chart, rebuilt only when meta reloads. */
const overviewCharts = memo1((meta, say) => {
  const headlines = meta.headlines ?? [];
  if (headlines.filter((h) => Number.isFinite(h.ratio)).length === 0) return [];
  return [chartNode(
    headlineRatioBars(headlines, { title: say('site/bench/overview/chart') }),
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
 * Rows are measured at different times and versions, so one row's date
 * and version cannot stand for all of them: a set of rows is honestly
 * summarized by its range.
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
const unrecorded = (n, say) => (n === 0 ? ''
  : n === 1 ? say('site/bench/overview/unrecorded-one', { n }) : say('site/bench/overview/unrecorded', { n }));

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
 * @param {(id: any, params?: Record<string, unknown>) => string} [say] - the
 *   site's words (English by default: the docs article reads it in English)
 * @returns {any} a table render node
 */
export function draftConformanceTable(engineStats, say = ENGLISH) {
  const drafts = Object.keys(engineStats?.jaren ?? {});
  return table(
    say('site/bench/conformance/title'),
    [say('site/bench/col/draft'), 'Jaren', 'Ajv'],
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
function overview(meta, say) {
  const headlines = meta.headlines ?? [];
  const lastRun = meta.lastRun ?? {};
  const measured = provenanceSpan(headlines, (h) => (h.generated ?? '').slice(0, 10));
  const versions = provenanceSpan(headlines, (h) => h.version, compareVersion);
  const lastRunDate = (lastRun.generated ?? '').slice(0, 10);
  const out = [cards([
    { title: say('site/bench/overview/measured'), value: measured.span, note: say('site/bench/overview/measured-note', { count: headlines.length, total: PUBLISHED_SUITES, unrecorded: unrecorded(measured.unknown, say) }) },
    { title: say('site/bench/overview/machine'), value: lastRun.cpu ?? '—', note: lastRun.platform ?? '' },
    {
      title: say('site/bench/overview/version'),
      value: versions.span === '—' ? '—' : `v${versions.span.replace(' → ', ' → v')}`,
      note: say('site/bench/overview/last-run', { date: lastRunDate || '—', node: lastRun.node ?? '', iterations: lastRun.quick ? say('site/bench/overview/quick') : say('site/bench/overview/full'), unrecorded: unrecorded(versions.unknown, say) }),
    },
  ])];

  if (headlines.length !== 0) {
    out.push(callout(say('site/bench/overview/how-to-read'),
      'Every number below is derived from the same generated run as the suite page behind it — nothing here is typed by hand. "Speed" is the geometric mean of the per-scenario ratios against the fastest rival library, so a 10× win and a 10× loss average to parity rather than to 5×. Hand-written JavaScript, where a suite measures it, is a floor reference rather than a rival, and is reported on the suite page instead.'));
    out.push(...overviewCharts(meta, say));
    out.push(table(
      say('site/bench/overview/table'),
      [say('site/bench/col/suite'), say('site/bench/col/conformance'), say('site/bench/col/speed'), say('site/bench/col/vs'), say('site/bench/overview/measured')],
      headlines.map((h) => ({
        cells: [
          h.label,
          h.conformance ?? '—',
          h.ratio === null || h.ratio === undefined ? '—' : formatRatioIn(say, h.ratio),
          h.rival ?? '—',
          (h.generated ?? '').slice(0, 10) || '—',
        ],
        strong: Number.isFinite(h.ratio) && h.ratio >= 10,
      })),
      'Conformance is passed / total on that suite\'s official test corpus where one exists. The "Measured" column is the run each row came from: a partial regeneration updates only the suites it ran.'));
    out.push(details(say('site/bench/overview/headlines'), headlines.map((h) => ({
      kind: 'p',
      text: `${h.label} — ${h.note ?? ''}`,
    }))));
  }

  const stats = meta.conformance?.jsonSchema?.engineStats;
  if (stats !== undefined && stats !== null) out.push(draftConformanceTable(stats, say));
  if (meta.qt3 !== undefined && meta.qt3 !== null) {
    const q = meta.qt3;
    out.push(cards([
      { title: say('site/bench/overview/qt3'), value: String(q.total ?? '—'), note: say('site/bench/overview/qt3-note') },
      { title: say('site/bench/col/passing'), value: String(q.pass ?? '—'), note: say('site/bench/overview/qt3-outside', { count: q.unsupportedSyntax ?? 0 }) },
      { title: say('site/bench/overview/regressions'), value: String(q.regressions ?? 0), note: say('site/bench/overview/regressions-note') },
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
 * @param {(id: any, params?: Record<string, unknown>) => string} say - the page's words
 * @returns {object[]} The nodes to push
 */
function searchableTable(benchUi, rows, matches, placeholder, makeTable, say) {
  const needle = benchUi.search.trim().toLowerCase();
  const filtered = needle === '' ? rows : rows.filter((r) => matches(r, needle));
  const shown = filtered.slice(0, benchUi.limit);
  const out = [
    search('bench/search', benchUi.search, placeholder),
    makeTable(shown, filtered.length),
  ];
  if (filtered.length > shown.length)
    out.push(more('bench/more', say('site/bench/more', { count: filtered.length - shown.length })));
  return out;
}

//#region validate

/** The ratio buckets, labelled in the page's words. */
const ratioBuckets = (say) => [
  { label: say('site/bench/validate/bucket-10'), test: (r) => r > 10, tone: 'win' },
  { label: say('site/bench/validate/bucket-2-10'), test: (r) => r > 2, tone: 'win' },
  { label: say('site/bench/validate/bucket-1-2'), test: (r) => r >= 1, tone: 'win' },
  { label: say('site/bench/validate/bucket-slower-1-2'), test: (r) => r >= 0.5, tone: 'loss' },
  { label: say('site/bench/validate/bucket-slower-2'), test: (r) => r < 0.5, tone: 'loss' },
];

/** The validate charts, rebuilt only when the suite data reloads. */
const validateCharts = memo1((data, say) => {
  const results = Array.isArray(data.results) ? data.results : [];
  const success = results.filter((r) => r.ratio !== null && r.isSuccessTest);
  const nodes = [
    chartNode(ratioDistributionBars(success, ratioBuckets(say),
      say('site/bench/validate/distribution'))),
    chartNode(ratioScatter(success, say('site/bench/validate/scatter')),
      'One point per test, fastest ratios first; log scale, dashed line = parity. Points above the line are tests where Jaren is faster.'),
  ];
  const stats = data.summary?.engineStats;
  if (stats !== undefined) {
    nodes.push(chartNode(conformanceBars(stats, say('site/bench/validate/conformance-chart')),
      'Tests passed per draft, optional format suites included.'));
  }
  return nodes;
});

function validate(data, benchUi, say) {
  const out = [];
  const overall = data.summary?.overall;
  if (overall !== undefined) {
    out.push(cards([
      { title: say('site/bench/validate/totals'), value: `${Math.round(overall.jarenSuccessTime)} ms vs ${Math.round(overall.ajvSuccessTime)} ms`,
        note: `Jaren vs Ajv, tests both can run${data.metadata?.runs > 1 ? `; each test the median of ${data.metadata.runs} runs` : ''}` },
      { title: say('site/bench/validate/jaren-wins'), value: say('site/bench/validate/tests', { count: overall.successOnly?.jarenWins ?? '—' }), note: say('site/bench/validate/ajv-wins', { count: overall.successOnly?.ajvWins ?? '—' }) },
      // both columns are derived: a literal for Jaren's side stops being
      // true the moment a test regresses
      { title: say('site/bench/validate/ajv-failures'), value: say('site/bench/validate/failures-value', { failures: overall.ajvFailures, errors: overall.ajvErrors }), note: say('site/bench/validate/jaren-failures', { failures: overall.jarenFailures ?? '—', errors: overall.jarenErrors ?? '—' }) },
    ]));
  }
  const results = Array.isArray(data.results) ? data.results : [];
  const success = results.filter((r) => r.ratio !== null && r.isSuccessTest);

  out.push(...validateCharts(data, say));

  // the searchable per-test table
  out.push(...searchableTable(benchUi,
    [...success].sort((a, b) => b.ratio - a.ratio),
    (r, needle) => r.description.toLowerCase().includes(needle)
      || r.suite.toLowerCase().includes(needle)
      || r.draft.toLowerCase().includes(needle),
    say('site/bench/validate/search'),
    (shown, total) => table(
      say('site/bench/validate/table', { shown: shown.length, total }),
      [say('site/bench/col/draft'), say('site/bench/col/suite'), say('site/bench/col/test'), say('site/bench/col/ratio'), 'Jaren', 'Ajv'],
      shown.map((r) => ({
        cells: [r.draft, r.suite, r.description, formatRatioIn(say, r.ratio),
          formatNs(r.jarenTime * 1e6), formatNs(r.ajvTime * 1e6)],
        strong: r.ratio > 10,
      }))), say));
  return out;
}

//#endregion

//#region jsonpath

/** Top-spread chart, rebuilt only when the suite data reloads. */
const jsonpathCharts = memo1((data, say) => {
  const rows = data.profile?.rows ?? [];
  if (rows.length === 0) return [];
  return [chartNode(
    querySpreadBars(rows, 'json-p3', 12, say('site/bench/jsonpath/chart')),
    'The 12 queries with the largest Jaren-vs-json-p3 spread; every query is in the table below.')];
});

/** One name/selector/Jaren/json-p3/ratio row; all three jsonpath tables share it. */
function jsonpathRow(r, say) {
  return {
    cells: [r.name, r.selector, formatNs(r.engines.jaren), formatNs(r.engines['json-p3']),
      formatRatioIn(say, r.engines.jaren > 0 ? r.engines['json-p3'] / r.engines.jaren : null)],
  };
}

function jsonpath(data, benchUi, say) {
  const out = [];
  const groups = data.compliance?.groups ?? [];
  // Summed from the same per-group rows the table below prints, per
  // engine: dividing the corpus total by itself would leave the card
  // unable to move on a failure. A regression reads n-1 / n here.
  const total = groups.reduce((n, [, g]) => n + (g.total ?? 0), 0);
  const passed = (engine) => groups.reduce((n, [, g]) => n + (g.pass?.[engine] ?? 0), 0);
  const score = (engine) => (groups.length === 0 ? '—' : `${passed(engine)} / ${total}`);
  out.push(cards([
    { title: say('site/bench/jsonpath/compliance'), value: score('jaren'), note: say('site/bench/jsonpath/compliance-note', { score: score('json-p3') }) },
    { title: say('site/bench/jsonpath/compile'), value: formatNs(data.profile?.compileRow?.engines?.jaren), note: `json-p3: ${formatNs(data.profile?.compileRow?.engines?.['json-p3'])}` },
  ]));
  out.push(table(say('site/bench/jsonpath/groups'), [say('site/bench/col/group'), say('site/bench/col/tests'), 'Jaren', 'json-p3'],
    groups.map(([name, g]) => ({
      cells: [name, String(g.total), String(g.pass?.jaren ?? '—'), String(g.pass?.['json-p3'] ?? '—')],
    }))));
  out.push(...jsonpathCharts(data, say));

  const rows = data.profile?.rows ?? [];
  out.push(...searchableTable(benchUi, rows,
    (r, needle) => r.name.toLowerCase().includes(needle) || r.selector.toLowerCase().includes(needle),
    say('site/bench/jsonpath/search'),
    (shown, total) => table(
      say('site/bench/jsonpath/table', { shown: shown.length, total, iterations: data.profile?.iterations }),
      [say('site/bench/col/query'), say('site/bench/col/selector'), 'Jaren', 'json-p3', say('site/bench/col/ratio')],
      shown.map((r) => jsonpathRow(r, say))), say));

  const scale = data.profile?.scaleRows ?? [];
  if (scale.length > 0) {
    out.push(table(say('site/bench/jsonpath/scale'), [say('site/bench/col/scenario'), say('site/bench/col/selector'), 'Jaren', 'json-p3', say('site/bench/col/ratio')],
      scale.map((r) => jsonpathRow(r, say))));
  }

  // Same document as the scale table, asking only for the first answer.
  // Each engine is timed on the fastest of its own routes to it, so the
  // rival is never held to a route it would not use.
  const earlyExit = data.profile?.earlyExitRows ?? [];
  if (earlyExit.length > 0) {
    out.push(table(say('site/bench/jsonpath/early-exit'),
      [say('site/bench/col/operation'), say('site/bench/col/selector'), 'Jaren', 'json-p3', say('site/bench/col/ratio')],
      earlyExit.map((r) => jsonpathRow(r, say))));
  }
  return out;
}

//#endregion

//#region scenario matrices (jsonquery, jslt)

/** Scenario grouped bars (single-entry memo; suite tabs alternate the
 * data object, which just recomputes on switch). Grouped bars shipped
 * first per the charts program; a heatmap stays the backlogged
 * alternative if the matrix ever reads poorly this way. */
const matrixCharts = memo1((data, say) => [chartNode(
  matrixBars(data.rows ?? [], { title: say('site/bench/matrix/chart') }),
  'Grouped per scenario, log scale — lower is better; the table below is the evidence.')]);

function scenarioMatrix(data, programs, say) {
  const engineKeys = collectEngineKeys(data.rows);
  const out = [];
  out.push(...matrixCharts(data, say));
  out.push(table(
    say('site/bench/matrix/table'),
    [say('site/bench/col/scenario'), say('site/bench/col/document'), ...engineKeys, say('site/bench/col/ratio')],
    (data.rows ?? []).map((row) => {
      const jaren = row.engines.jaren;
      const rivals = engineKeys.filter((k) => k !== 'jaren').map((k) => row.engines[k]).filter((v) => v > 0);
      const best = rivals.length > 0 ? Math.min(...rivals) : null;
      return {
        cells: [
          row.title ?? row.scenario,
          row.document ?? '',
          ...engineKeys.map((k) => formatNs(row.engines[k])),
          formatRatioIn(say, best !== null && jaren > 0 ? best / jaren : null),
        ],
      };
    })));
  if (data.compile !== undefined) {
    out.push(cards(Object.entries(data.compile.results ?? {}).map(([key, value]) => ({
      title: say('site/bench/matrix/compile', { engine: key }),
      value: formatNs(value),
      note: say('site/bench/matrix/compile-note', { programs: data.compile.sources?.length ?? '?', iterations: data.compile.iterations }),
    }))));
  }
  for (const scenario of data.scenarios ?? []) {
    out.push(details(programs === 'query'
      ? say('site/bench/matrix/sources-query', { scenario: scenario.title ?? scenario.key })
      : say('site/bench/matrix/sources-jslt', { scenario: scenario.title ?? scenario.key }), [
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
const genericTableCharts = memo1((data, say) => (data.tables ?? []).map((t) =>
  chartNode(resultTableBars(t, { log: true, valLabel: say('site/bench/axis/ns-op-log') }))));

/** pointer-style payloads: `{ tables: [{ title, columns, rows: [{ name, results[] }] }] }` */
function genericTables(data, note, say) {
  const chartNodes = genericTableCharts(data, say);
  return (data.tables ?? []).flatMap((t, i) => [
    chartNodes[i],
    table(
      t.title,
      [say('site/bench/col/scenario'), ...t.columns],
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
function dbSuite(data, say) {
  const meta = data.meta ?? {};
  const engineLines = (meta.engines ?? [])
    .map((engine) => `${engine.label}: ${engine.adapter}`).join(' · ');
  const out = [];
  out.push(callout(
    say('site/bench/db/headline', { ratio: meta.headlineRatio, docs: meta.docs, bytes: meta.docBytes }),
    `${engineLines}. Every engine is verified to answer the same result set before it is timed; jaren pays SQLite and JSON materialisation where the in-process rivals pay neither — the rows it loses are the price of durability, transactions and a planner, and they are shown.`));
  out.push(...genericTables(data,
    'Per-operation timings; lower is better. A dash is an engine dropped for a row because it disagreed on the result set rather than being timed doing less work.', say));
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
function spatialSuite(data, say) {
  const meta = data.meta ?? {};
  const figures = meta.figures ?? {};
  const checks = data.checks ?? [];
  const agreed = checks.filter((c) => c.agrees).length;
  const ratioOr = (x) => (Number.isFinite(x) ? formatRatioIn(say, x) : '—');
  const out = [];
  out.push(cards([
    {
      title: say('site/bench/spatial/gate'),
      value: `${agreed} / ${checks.length}`,
      note: `${meta.corpus?.agreed ?? 0} / ${meta.corpus?.cases ?? 0} spatial-corpus plan cases plus every timed shape against the engine, before any timing`,
    },
    {
      title: say('site/bench/spatial/scan'),
      value: ratioOr(figures.scanVsIndexed),
      note: 'the $within a consumer writes, before and after derive: \'bbox\'',
    },
    {
      title: say('site/bench/spatial/no-database'),
      value: ratioOr(figures.engineVsIndexed),
      note: figures.engineVsIndexed >= 1
        ? 'the indexed store beats the in-memory engine over the parsed array — the row it had to win'
        : 'the in-memory engine over the parsed array still wins — the loss, published',
    },
    {
      title: say('site/bench/spatial/rtree'),
      value: ratioOr(figures.rtreeVsGenerated),
      note: '> 1 favours the R*Tree; below 1.5× a second table kept in sync is not worth its cost',
    },
  ]));
  out.push(callout(say('site/bench/spatial/no-rival'),
    `${(meta.docs ?? 0).toLocaleString()} GeoJSON points stored in SQLite (${meta.engine ?? ''}), one probe box at ~0.5 % selectivity, ${meta.repetitions ?? 0} repetitions after a warm execute. Nothing else in JavaScript stores GeoJSON in SQLite from a JSON query document, so there is no rival to time and none is invented. MongoDB's 2dsphere and DuckDB-wasm's spatial extension have real spatial indexes and overlay operations this store does not have; neither runs one document through three executors proven to agree — the JavaScript engine, SQLite in Node and SQLite compiled to wasm in a browser tab, held to one committed corpus (the Data studio runs it; the browser suite drives it in Chromium, Firefox and WebKit) — neither validates ring closure in a schema, and DuckDB's query is SQL rather than a document. The in-memory engine row starts from parsed objects where the store starts from bytes on a page — that head start is why it is the row to beat.`));
  for (const t of data.tables ?? []) {
    out.push(table(t.title, [say('site/bench/col/shape'), 'ms/query', say('site/bench/col/rows'), say('site/bench/col/plan'), say('site/bench/col/sqlite-says')],
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
  out.push(table(say('site/bench/spatial/checks'), [say('site/bench/col/check'), say('site/bench/col/agrees'), say('site/bench/col/detail')],
    checks.map((c) => ({ cells: [c.name, c.agrees ? say('site/bench/yes') : say('site/bench/no-caps'), c.detail], strong: !c.agrees })),
    'A disagreement withholds the whole table at generation time and the tool exits non-zero.'));
  return out;
}

/**
 * The phase-B ORM suite. The honest framing renders FIRST — a
 * skeptical reader should meet it before any number.
 */
function ormSuite(data, say) {
  const meta = data.meta ?? {};
  const out = [];
  out.push(callout(say('site/bench/orm/read-first'),
    'Prisma, Drizzle and Kysely are mature, support several databases, and are faster on some rows below — those losses are published with their reasons. What none of them has: a query that is one serializable JSON document, executable by two independent engines proven to agree by a differential oracle, running unchanged in Node, Bun and the browser, with schema-validated writes from the fastest validator in the ecosystem. The composition is the product; the individual numbers are what they are.'));
  out.push(callout(
    say('site/bench/orm/headline', { ratio: meta.headlineRatio, rival: meta.headlineRival ?? 'Prisma', users: meta.users, posts: meta.posts, comments: meta.comments }),
    `${(meta.engines ?? []).map((engine) => `${engine.label}: ${engine.adapter}`).join(' · ')}. Every engine answers the same normalized result before it is timed; statement counts are printed beside the graph rows because the structural claim (one statement versus round trips) is what timings alone would hide. Runtime: ${meta.runtime}${meta.bunRuntime ? `; the [Bun] tables ran on ${meta.bunRuntime}` : ''}.`));
  if ((meta.bunNotes ?? []).length > 0)
    out.push(callout(say('site/bench/orm/bun'), meta.bunNotes.join(' ')));
  out.push(...genericTables(data,
    'Per-operation timings; lower is better. A dash is an engine dropped for a row because it disagreed on the result set rather than being timed doing less work.', say));
  return out;
}

/**
 * The phase-C live suite: incremental-vs-re-run, capture overhead, the
 * update-latency head-to-head against RxDB and TinyBase (where jaren
 * LOSES to the in-memory store, published with the reason), the
 * end-to-end path, and job throughput.
 */
function liveSuite(data, say) {
  const meta = data.meta ?? {};
  const out = [];
  out.push(callout(say('site/bench/live/buys'),
    `Maintaining a live query's result as writes arrive, in time proportional to what changed rather than the size of the result. ${(meta.incrementalRatios ?? []).map((entry) => `${entry.size} rows: ${entry.ratio.toFixed(1)}× faster than re-running the query`).join('; ')}. TinyBase, an in-memory store, beats jaren on raw update latency below — it is not a SQL database and does not persist the same way; that gap is the honest cost of durability. Runtime: ${meta.runtime}.`));
  if ((meta.omitted ?? []).length > 0) {
    out.push(callout(say('site/bench/live/omitted'), `${meta.omitted.join('; ')}.`));
  }
  out.push(...genericTables(data,
    'Per-single-write medians (job throughput in jobs/second); lower is better except throughput. Every row states what it measures and, for the rivals, the trade it makes.', say));
  return out;
}

/**
 * The Zod head-to-head. The caveat is rendered ABOVE the tables rather than
 * as a footnote, because the middle table's ratio flatters Jaren and a
 * reader who takes it at face value draws the wrong conclusion.
 */
function contractsSuite(data, say) {
  const out = [];
  if (data.caveat != null)
    out.push(callout(say('site/bench/contracts/caveat'), data.caveat));
  out.push(...genericTables(data,
    'Time per operation; lower is better. A dash is an engine dropped for that scenario because it disagreed on the verdict or the normalized value, rather than being timed doing less work.', say));
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
function contractSuite(data, say) {
  const out = [];
  if (data.caveat != null)
    out.push(callout(say('site/bench/contract/caveat'), data.caveat));
  out.push(...genericTables(data,
    'Time per request or lookup; lower is better. A dash is an engine dropped for a row because it disagreed on the probes or the response, rather than being timed doing less work.', say));
  const serialization = data.serialization ?? [];
  if (serialization.length > 0) {
    out.push(table(
      say('site/bench/contract/serialization'),
      [say('site/bench/col/request'), say('site/bench/contract/stringify-alone'), say('site/bench/contract/whole-dispatch'), say('site/bench/contract/share')],
      serialization.map((r) => ({
        cells: [r.name, formatNs(r.stringifyNs), formatNs(r.dispatchNs),
          r.share === null ? '—' : `${(r.share * 100).toFixed(1)}%`],
      })),
      'JSON.stringify of the response value beside the whole in-process dispatch. This is the number that decides whether a schema-driven serializer is worth building: below ~25% the pipeline\'s time is elsewhere.'));
  }
  return out;
}

function formatsSuite(data, say) {
  const out = [];
  if (data.conformance != null) {
    out.push(cards([{
      title: say('site/bench/col/conformance'),
      value: `${data.conformance.pass} / ${data.conformance.total}`,
      note: say('site/bench/formats/note', { count: data.conformance.formats })
        + (data.conformance.unregistered?.length > 0
          ? say('site/bench/formats/unscored', { formats: data.conformance.unregistered.join(', ') })
          : ''),
    }]));
  }
  out.push(...genericTables(data,
    'Time for one accepted plus one rejected value; lower is better. A dash is a format that engine does not implement, or one it accepts the invalid value for.', say));
  return out;
}

function patch(data, say) {
  const out = [];
  if (data.conformance !== undefined) {
    // 108/108 is one number — a chart of it would restate the card, so
    // the conformance stays a stat card and the charts cover timings.
    out.push(cards([{
      title: say('site/bench/col/conformance'),
      value: `${data.conformance.pass} / ${data.conformance.total}`,
      note: say('site/bench/patch/note'),
    }]));
  }
  out.push(...genericTables(data, 'Time per application; lower is better.', say));
  return out;
}

/** The toml charts, rebuilt only when the suite data reloads. */
const tomlCharts = memo1((data, say) => ({
  compliance: data.compliance !== undefined
    ? chartNode(passCountBars(data.compliance, {
      title: say('site/bench/toml/compliance-chart'),
      highlight: 'jaren',
    }))
    : undefined,
  parse: Array.isArray(data.profile?.parse)
    ? chartNode(profileBars(data.profile.parse, data.engines ?? [], {
      title: say('site/bench/toml/parse-chart'),
      valLabel: 'ms/op',
    }))
    : undefined,
  streamDocument: Array.isArray(data.stream?.document)
    ? chartNode(timingBars(data.stream.document, {
      title: say('site/bench/toml/stream-chart'), log: true, valLabel: say('site/bench/axis/ns-op-log'),
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
function streamingRows(stream, charts, say) {
  if (stream === undefined || stream === null) return [];
  const out = [callout(say('site/bench/toml/streaming'),
    `JSON.parse is the baseline here and it is faster on complete text: it is a native full-text parser with no incremental input and no events. The reader's delta is the price of accepting a document in arbitrary chunks — split mid-escape, mid-number, mid-keyword — and emitting document-order pair events as it arrives, which is what the live Binance feed and the playground replay run on. Result equality with JSON.parse is asserted before timing.`)];
  out.push(table(
    say('site/bench/toml/message-feed', { bytes: stream.messageBytes ?? '?' }),
    [say('site/bench/col/path'), say('site/bench/col/ns-per-document')],
    (stream.message ?? []).map((r) => ({ cells: [r.label, formatNs(r.ns)] })),
    'The WebSocket shape: many small complete documents, a fresh reader each. Reader construction is a flat object allocation, which is why there is no reset()-for-reuse API.'));
  if (charts.streamDocument !== undefined) out.push(charts.streamDocument);
  out.push(table(
    say('site/bench/toml/incremental', { bytes: stream.documentBytes ?? '?', chunks: stream.chunks ?? '?', chunkBytes: stream.chunkBytes ?? '?' }),
    [say('site/bench/col/path'), say('site/bench/col/ns-per-parse')],
    (stream.document ?? []).map((r) => ({ cells: [r.label, formatNs(r.ns)] })),
    'The LLM token-output shape: one large document arriving in small pieces. The last row is the streaming path doing what no full-text parser can.'));
  return out;
}

function toml(data, say) {
  const out = [];
  const { compliance: complianceChart, parse: parseChart } = tomlCharts(data, say);
  if (data.compliance !== undefined) {
    out.push(complianceChart);
    out.push(table(
      say('site/bench/toml/compliance', { valid: data.cases?.valid ?? '?', invalid: data.cases?.invalid ?? '?' }),
      [say('site/bench/col/engine'), say('site/bench/col/passing')],
      (data.engines ?? Object.keys(data.compliance)).map((engine) => ({
        cells: [engine, `${data.compliance[engine]?.pass} / ${data.compliance[engine]?.total}`],
        strong: engine === 'jaren',
      }))));
  }
  const profile = data.profile;
  if (profile !== undefined) {
    if (parseChart !== undefined) out.push(parseChart);
    out.push(table(
      say('site/bench/toml/profile', { iterations: profile.iterations }),
      [say('site/bench/col/document'), ...(data.engines ?? [])],
      (profile.parse ?? []).map((p) => ({
        cells: [p.name, ...(data.engines ?? []).map((e) => formatMs(p.results[e]))],
      })),
      'smol-toml keeps a raw-throughput edge; Jaren is the only engine passing the complete suite while streaming.'));
  }
  out.push(...streamingRows(data.stream, tomlCharts(data, say), say));
  return out;
}


/** The CSV charts, rebuilt only when the suite data reloads. */
const csvCharts = memo1((data, say) => ({
  parse: Array.isArray(data.profile?.rows)
    ? chartNode(profileBars(data.profile.rows, data.engines ?? [], {
      title: say('site/bench/csv/parse-chart'),
      valLabel: 'ms/op',
    }))
    : undefined,
}));

/**
 * CSV. The acceptance corpus is tiny and everyone passes it, so the
 * interesting tables are the other two: what each parser does to a
 * DAMAGED document, and where the speed actually goes.
 */
function csv(data, say) {
  const out = [];
  const engines = data.engines ?? [];

  if (data.spectrum !== undefined) {
    out.push(table(
      say('site/bench/csv/spectrum'),
      [say('site/bench/col/engine'), say('site/bench/col/passing')],
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
      say('site/bench/csv/healing'),
      [say('site/bench/col/damage'), ...cols],
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
    const { parse: parseChart } = csvCharts(data, say);
    if (parseChart !== undefined) out.push(parseChart);
    const timing = (rows, title, note) => table(
      title,
      [say('site/bench/col/document'), ...engines],
      (rows ?? []).map((row) => ({
        cells: [row.name, ...engines.map((e) => formatMs(row.results[e]))],
      })),
      note);
    out.push(timing(profile.rows, say('site/bench/csv/arrays', { iterations: profile.iterations }),
      'udsv is the honest loss and it is not close on plain data. It earns it: udsv compiles '
      + 'a parser per schema with new Function. Nothing in this suite does, anywhere, because '
      + 'everything here has to run under a strict Content-Security-Policy — the same trade '
      + 'the schema validator and the query engine record. Against every parser that also '
      + 'avoids codegen, jaren leads.'));
    out.push(timing(profile.objects, say('site/bench/csv/objects'),
      'Objects cost more than arrays everywhere: a key per cell instead of a slot.'));
    out.push(timing(profile.streaming, say('site/bench/csv/streaming'),
      'Only synchronous incremental readers appear here. fast-csv, csv-parser and csvtojson '
      + 'are stream-only, so timing them beside these would measure Node streams rather than '
      + 'a CSV grammar. Streaming costs about 1.6x the wholesale path for a structural '
      + 'reason: whole-document parsing walks the source once, while a chunk stream needs a '
      + 'side-effect-free cutter pass first because a chunk can stop mid-field.'));
    if (profile.stringify !== undefined) {
      out.push(table(say('site/bench/csv/stringify'), [say('site/bench/col/engine'), say('site/bench/col/ms-per-pass')],
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
const markdownCharts = memo1((data, say) => ({
  scorecard: data.scorecard !== undefined
    ? chartNode(passCountBars(data.scorecard, {
      title: say('site/bench/markdown/scorecard-chart'),
      highlight: 'jaren-md',
    }))
    : undefined,
  render: Array.isArray(data.profile?.render)
    ? chartNode(profileBars(data.profile.render, data.engines ?? [], {
      title: say('site/bench/markdown/render-chart'),
      valLabel: 'ms/op',
    }))
    : undefined,
}));

function markdown(data, say) {
  const engines = data.engines ?? [];
  const out = [];
  const { scorecard: scorecardChart, render: renderChart } = markdownCharts(data, say);
  if (scorecardChart !== undefined) out.push(scorecardChart);
  if (data.scorecard !== undefined) {
    out.push(table(
      say('site/bench/markdown/scorecard', { count: data.examples ?? '?' }),
      [say('site/bench/col/engine'), say('site/bench/col/passing')],
      engines.map((engine) => ({
        cells: [engine, `${data.scorecard[engine]?.pass} / ${data.scorecard[engine]?.total}`],
        strong: engine === 'jaren-md',
      })),
      'Two Jaren rows, because the difference between them is the safety boundary: the string emitter (toHtml) can pass raw HTML through, while the vnode path renders Markdown to JSON vnodes that structurally cannot hold unescaped markup — so its lower score is the price of being safe on documents it did not write, not a dialect gap.'));
  }
  if (data.gfm !== undefined && data.gfm !== null) {
    const sections = Object.keys(data.gfm.totals ?? {});
    out.push(table(
      say('site/bench/markdown/gfm', { count: data.gfm.examples }),
      [say('site/bench/col/engine'), say('site/bench/col/passing'), ...sections.map((name) => name.replace(' (extension)', ''))],
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
      say('site/bench/markdown/render', { iterations: profile.iterations }),
      [say('site/bench/col/document'), ...engines],
      (profile.render ?? []).map((p) => ({
        cells: [p.name, ...engines.map((e) => formatMs(p.results[e]))],
      })),
      'marked and markdown-it are the mainstream one-shot parsers. The jaren-md row is toHtml — source to HTML string, the same unit; the vnode row does the same work and then builds a keyed, patchable tree, which is what the extra time buys.'));
    const phased = (profile.jaren ?? []).filter((row) => row.phases !== undefined);
    if (phased.length > 0) {
      out.push(table(
        say('site/bench/markdown/phases'),
        [say('site/bench/col/document'), say('site/bench/markdown/parse'), 'AST→vnode', say('site/bench/markdown/without-keys'), 'vnode→HTML', 'AST→HTML'],
        phased.map((row) => ({
          cells: [row.name, formatMs(row.phases.parse), formatMs(row.phases.project),
            formatMs(row.phases.projectUnkeyed), formatMs(row.phases.serialize),
            formatMs(row.phases.toHtml)],
        })),
        'The projection, not the parse, is the expensive half — and most of the projection is computing the content-hash keys that let the patcher reorder blocks instead of rebuilding them. A caller that renders once and throws the tree away passes keyed: false and skips it; the default keeps them, because a renderer cannot know whether its output will be patched. The last column is the direct string emitter, which never computes one.'));
    }
    if (Array.isArray(profile.jaren)) {
      out.push(table(
        say('site/bench/markdown/compiled'),
        [say('site/bench/col/document'), 'parse → AST', say('site/bench/markdown/cached-vnode')],
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
const mermaidCharts = memo1((data, say) => ({
  parse: Array.isArray(data.profile?.parse) && data.profile.parse.length > 0
    ? chartNode(profileBars(data.profile.parse, data.engines ?? ['jaren-mermaid'], {
      title: say('site/bench/mermaid/pie-chart'),
      valLabel: 'ms/op',
    }))
    : undefined,
  parseJison: Array.isArray(data.profile?.parseJison) && data.profile.parseJison.length > 0
    ? chartNode(profileBars(data.profile.parseJison, data.jisonEngines ?? ['jaren-mermaid', 'mermaid (jison)'], {
      title: say('site/bench/mermaid/jison-chart'),
      log: true,
      valLabel: say('site/bench/axis/ms-op-log'),
    }))
    : undefined,
}));

function mermaid(data, say) {
  const out = [];
  const { parse: parseChart, parseJison: jisonChart } = mermaidCharts(data, say);
  if (data.scorecard !== undefined) {
    const types = Object.keys(data.scorecard);
    out.push(table(
      say('site/bench/mermaid/coverage', { count: data.examples ?? '?' }),
      [say('site/bench/col/diagram-type'), say('site/bench/col/rendered')],
      types.map((type) => ({
        cells: [type, `${data.scorecard[type]?.rendered} / ${data.scorecard[type]?.total}`],
        strong: type === 'flowchart' || type === 'sequence',
      })),
      'Flowchart, sequence, state and gantt are fully laid out — gantt as a real time axis with bars, milestones and dependencies — and pie renders as a chart. Class and ER still render as structured panels. Secondary types (mindmap, gitGraph) parse-accept and render an honest "not yet laid out" placeholder — counted, not hidden.'));
  }
  const profile = data.profile;
  if (profile !== undefined && profile !== null) {
    const engines = data.engines ?? ['jaren-mermaid'];
    if (Array.isArray(profile.parse) && profile.parse.length > 0) {
      if (parseChart !== undefined) out.push(parseChart);
      out.push(table(
        say('site/bench/mermaid/pie', { iterations: profile.iterations }),
        [say('site/bench/col/diagram'), ...engines],
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
        say('site/bench/mermaid/jison'),
        [say('site/bench/col/diagram'), ...jEngines],
        profile.parseJison.map((p) => ({
          cells: [p.name, ...jEngines.map((e) => formatMs(p.results[e]))],
          strong: true,
        })),
        'Mermaid parses flowchart and sequence with its original in-tree Jison grammars (mermaid.parse, DOM-coupled, run here under jsdom). @jarenjs/mermaid parses the same sources roughly two orders of magnitude faster — a synchronous, allocation-light char-code recursive descent vs a generated Jison parser plus type-detection and validation. mermaid.parse is heavy and noisy, so this is the full parse front-end, not a bare-grammar microbenchmark.'));
    }
    if (Array.isArray(profile.jaren)) {
      out.push(table(
        say('site/bench/mermaid/headless'),
        [say('site/bench/col/diagram'), 'parse → AST', say('site/bench/mermaid/svg-string')],
        profile.jaren.map((p) => ({
          cells: [p.name, formatMs(p.parseMs), formatMs(p.svgMs)],
        })),
        'mermaid.js needs a browser DOM (getBBox) to render, so there is no fair full-render head-to-head; @jarenjs/mermaid produces a complete standalone SVG string in pure Node — a capability mermaid.js lacks.'));
    }
    if (Array.isArray(profile.gantt) && profile.gantt.length > 0) {
      out.push(table(
        say('site/bench/mermaid/gantt'),
        [say('site/bench/col/tasks'), say('site/bench/mermaid/parse-resolve'), say('site/bench/mermaid/layout'), say('site/bench/mermaid/render'), say('site/bench/mermaid/whole')],
        profile.gantt.map((p) => ({
          cells: [
            String(p.tasks),
            formatMs(p.parseMs),
            formatMs(p.layoutMs),
            formatMs(p.vnodeMs - p.layoutMs),
            formatMs(p.svgMs),
          ],
        })),
        'Parsing a Gantt document is also resolving its schedule — every date read through the document\'s own dateFormat, every dependency ordered, every duration walked past the excluded days. That, the layout and the renderer all stay roughly linear in the task count. The last column does not: at ten thousand rows most of it is serializing the vnode tree to a string, which is the view layer\'s cost rather than the timeline\'s. Every size is checked against its geometry invariants before it is timed.'));
    }
  }
  return out;
}

//#region view + charts

/** The view charts, rebuilt only when the suite data reloads. */
const viewCharts = memo1((data, say) => {
  const t = data.tables ?? {};
  return {
    build: chartNode(timingBars(t.build ?? [], {
      title: say('site/bench/view/build-chart'), log: true, valLabel: say('site/bench/axis/ns-op-log'),
    })),
    update: chartNode(timingBars(t.update ?? [], {
      title: say('site/bench/view/update-chart'), log: true, valLabel: say('site/bench/axis/ns-op-log'),
    })),
    ssr: chartNode(timingBars(t.ssr ?? [], {
      title: say('site/bench/view/ssr-chart'), valLabel: 'ns/op',
    })),
    memo: chartNode(timingBars(t.memo ?? [], {
      title: say('site/bench/view/memo-chart'), valLabel: 'ns/frame',
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
function view(data, say) {
  const t = data.tables ?? {};
  const c = viewCharts(data, say);
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
      title: say('site/bench/view/stylesheet'),
      value: jarenBuild !== undefined && reactBuild !== undefined
        ? formatRatioIn(say, reactBuild.ns / jarenBuild.ns)
        : '—',
      note: 'the price of views as data: a generic dispatcher, not code',
    },
    {
      // ...and this reads "1.8× faster" — the tagged-array FORMAT,
      // hand-written the same way a React view is, is the fastest
      // element builder on the page. The engine is the price; the
      // format never was.
      title: say('site/bench/view/hand-written'),
      value: handBuild !== undefined && reactBuild !== undefined
        ? formatRatioIn(say, reactBuild.ns / handBuild.ns)
        : '—',
      note: 'the format itself: an array literal and a plain object per node',
    },
    {
      title: say('site/bench/view/frame-memo'),
      value: memoFrame !== undefined && plainFrame !== undefined
        ? formatRatioIn(say, plainFrame.ns / memoFrame.ns)
        : '—',
      note: 'view + patch, one changed row — against its own no-memo path',
    },
    {
      title: say('site/bench/view/memo-skip'),
      value: memoPair.length === 2 ? formatRatioIn(say, memoPair[1].ns / memoPair[0].ns) : '—',
      note: say('site/bench/view/memo-skip-note', { count: data.memoChildren ?? '?' }),
    },
  ]));
  out.push(callout(say('site/bench/view/measures'),
    'Two different things get measured here, and conflating them is how this table gets misread. The FORMAT: a Jaren vnode is a tagged array — an array literal plus a plain object — and a hand-written view producing them directly (the same authoring model as a React or preact view) is the fastest element builder on this page; the renderer, patcher and SSR consume tagged arrays no matter who built them. The ENGINE: a JSLT stylesheet is a view as DATA — schema-validated, serializable, storable, safe to accept from a constrained decoder — and running that document through a generic dispatcher costs roughly 20× the hand-written build. None of the rivals has a data-driven mode to compare that against: a JSX view is code by construction. So the engine rows are the measured price of a capability the others do not offer, the hand-written rows are the like-for-like comparison, and both ship on the same page with SSR output asserted byte-identical to React and preact before timing.'));

  out.push(c.build);
  out.push(table(say('site/bench/view/build'),
    [say('site/bench/col/engine'), say('site/bench/col/ns-per-view')],
    build.map((r) => ({ cells: [r.label, formatNs(r.ns)], strong: r.label.startsWith('jaren') })),
    `${data.rows ?? '?'} rows, ${data.iterations ?? '?'} iterations; lower is better.`));

  out.push(c.update);
  out.push(table(say('site/bench/view/update'),
    [say('site/bench/col/engine'), say('site/bench/col/ns-per-view')],
    (t.update ?? []).map((r) => ({ cells: [r.label, formatNs(r.ns)], strong: r.label.startsWith('jaren') })),
    'React, hyperapp and preact re-run the whole view function per change (their idiomatic default; each offers opt-in per-call-site memoization, and React runs its production build here). Jaren\'s memo is a compile option that needs no view changes.'));

  out.push(c.ssr);
  out.push(table(say('site/bench/view/ssr'),
    [say('site/bench/col/engine'), say('site/bench/col/ns-per-render')],
    (t.ssr ?? []).map((r) => ({ cells: [r.label, formatNs(r.ns)], strong: r.label.startsWith('jaren') })),
    `Output equality is asserted before timing: every engine emits the same ${data.ssrChars ?? '?'}-character document.`));

  out.push(table(say('site/bench/view/frame'),
    [say('site/bench/col/path'), say('site/bench/col/ns-per-frame')],
    frame.map((r) => ({ cells: [r.label, formatNs(r.ns)] })),
    'Measured against the repository\'s DOM stub, so no cross-framework claim is made here — React, hyperapp and preact need a real DOM. At this size the hand-written view wins the frame outright: its build is so cheap that a full diff still beats the stylesheet\'s memoized walk, and that is on the page rather than hidden. What the memo buys is the case this table does not exercise: an UNCHANGED document returns the previous tree by reference and the whole frame is O(1), and the memo-marker rows below show the same skip working for hand-written producers too.'));

  out.push(c.memo);
  out.push(table(say('site/bench/view/memo'),
    [say('site/bench/col/path'), say('site/bench/col/ns-per-frame')],
    memoPair.map((r) => ({ cells: [r.label, formatNs(r.ns)] })),
    'When a producer rebuilds its tree but knows a region did not change, an equal `memo` prop skips that subtree outright — instead of walking every child to discover the reference-equality skips one at a time.'));
  return out;
}

/** The charts suite charts, rebuilt only when the suite data reloads. */
const chartsSuiteCharts = memo1((data, say) => ({
  types: chartNode(timingBars(data.types ?? [], {
    title: say('site/bench/charts/types-chart'), log: true, valLabel: say('site/bench/axis/ns-op-log'),
  })),
  scaling: chartNode(profileBars(
    (data.scaling ?? []).map((s) => ({
      name: s.sampled ? say('site/bench/charts/points-sampled', { points: s.points, series: s.series }) : `${s.points} × ${s.series}`,
      results: { [say('site/bench/charts/incremental-session')]: s.sessionNs, [say('site/bench/charts/wholesale')]: s.wholesaleNs },
    })),
    [say('site/bench/charts/incremental-session'), say('site/bench/charts/wholesale')],
    { title: say('site/bench/charts/scaling-chart'), log: true, valLabel: say('site/bench/axis/ns-tick-log') })),
  sampling: chartNode(profileBars(
    (data.sampling ?? []).map((s) => ({
      name: say('site/bench/charts/points', { count: s.points }),
      results: { [say('site/bench/charts/every-point')]: s.wholeSvgNs, [say('site/bench/charts/sampled')]: s.sampledSvgNs },
    })),
    [say('site/bench/charts/every-point'), say('site/bench/charts/sampled')],
    { title: say('site/bench/charts/sampling-chart'), log: true, valLabel: say('site/bench/axis/ns-render-log') })),
  barScaling: chartNode(profileBars(
    (data.barScaling ?? []).map((s) => ({
      name: say('site/bench/charts/categories', { count: s.categories }),
      results: { [say('site/bench/charts/incremental-session')]: s.sessionNs, [say('site/bench/charts/wholesale')]: s.wholesaleNs },
    })),
    [say('site/bench/charts/incremental-session'), say('site/bench/charts/wholesale')],
    { title: say('site/bench/charts/bar-chart'), log: true, valLabel: say('site/bench/axis/ns-tick-log') })),
}));

/** The charts suite: per-type cost, and the O(change) scaling evidence. */
function chartsSuite(data, say) {
  const c = chartsSuiteCharts(data, say);
  const scaling = data.scaling ?? [];
  // the incremental claim is about a line whose points the sampler is
  // NOT choosing; the sampled row rebuilds by design and reading the
  // flatness card off it would state the opposite of the claim
  const flat = scaling.filter((s) => s.sampled !== true);
  const first = flat[0];
  const last = flat[flat.length - 1];
  const out = [];
  if (first !== undefined && last !== undefined) {
    out.push(cards([
      {
        title: say('site/bench/charts/tick'),
        value: formatNs(last.sessionNs),
        note: say('site/bench/charts/tick-note', { points: last.points, series: last.series }),
      },
      {
        title: say('site/bench/charts/tick-wholesale'),
        value: formatNs(last.wholesaleNs),
        // not formatRatio: this is a cost multiple, not a "faster than"
        // comparison, and the direction word would invert its meaning
        note: say('site/bench/charts/tick-wholesale-note', { ratio: Math.round(last.wholesaleNs / last.sessionNs) }),
      },
      {
        title: say('site/bench/charts/flatness'),
        value: `${(last.sessionNs / first.sessionNs).toFixed(2)}×`,
        note: say('site/bench/charts/flatness-note', { last: last.points, first: first.points }),
      },
    ]));
  }
  out.push(callout(say('site/bench/charts/why-flat'),
    'A chart AST stores positions as fractions of its domain, so a tick that moves the scales legitimately changes every mark — and re-rendering wholesale is then the correct output, not a failure. Declaring a domain policy (a quantized window, pinned or step-quantized bounds) keeps most ticks still, and the session then patches only the series that changed. Every tick is asserted byte-identical to a wholesale render of the same data.'));
  out.push(c.scaling);
  out.push(table(say('site/bench/charts/scaling'),
    [say('site/bench/col/points-x-series'), say('site/bench/col/session-tick'), say('site/bench/col/wholesale-tick'), say('site/bench/col/ratio'), say('site/bench/col/frames-incremental')],
    scaling.map((s) => ({
      cells: [
        s.sampled ? say('site/bench/charts/points-sampled-row', { points: s.points, series: s.series }) : `${s.points} × ${s.series}`,
        formatNs(s.sessionNs),
        formatNs(s.wholesaleNs),
        formatRatioIn(say, s.sessionNs > 0 ? s.wholesaleNs / s.sessionNs : null),
        say('site/bench/n-of-m', { n: s.incremental, total: s.incremental + s.rebuilt }),
      ],
      strong: true,
    })),
    'The session column is flat in the point count; the wholesale column is linear in it. '
    + 'The last row is the same ten thousand points with sampling left at its default: above '
    + 'two thousand points the downsampler chooses which vertices are drawn, one append can '
    + 'change that choice anywhere on the line, and every frame therefore rebuilds — costing '
    + 'MORE than the wholesale render beside it, because the session rebuild scans the extremes '
    + 'a second time. A long live line declares `sampling: false`; that is what the rows above it are.'));
  const sampling = data.sampling ?? [];
  if (sampling.length !== 0) {
    out.push(c.sampling);
    out.push(table(say('site/bench/charts/sampling'),
      [say('site/bench/col/source-points'), say('site/bench/col/drawn'), say('site/bench/col/method'), 'AST', say('site/bench/col/ast-sampled'), 'Svg', say('site/bench/col/svg-sampled')],
      sampling.map((s) => ({
        cells: [
          String(s.sourceCount), String(s.renderedCount), s.method,
          formatNs(s.wholeNs), formatNs(s.sampledNs),
          formatNs(s.wholeSvgNs), formatNs(s.sampledSvgNs),
        ],
        strong: true,
      })),
      'Choosing the points costs about what mapping them costs — the sampler reads every '
      + 'reading either way — so the AST column shows sampling as a small loss. What it buys is '
      + 'the render: a path and a vnode tree over five hundred vertices instead of a hundred '
      + 'thousand. Endpoints, gap markers and the required extrema are checked before anything '
      + 'is timed, and the run fails if a sampled line drew a vertex no reading produced.'));
  }
  const barScaling = data.barScaling ?? [];
  if (barScaling.length !== 0) {
    out.push(c.barScaling);
    out.push(table(say('site/bench/charts/bar'),
      [say('site/bench/col/categories'), say('site/bench/col/session-tick'), say('site/bench/col/wholesale-tick'), say('site/bench/col/ratio'), say('site/bench/col/frames-incremental')],
      barScaling.map((s) => ({
        cells: [
          String(s.categories),
          formatNs(s.sessionNs),
          formatNs(s.wholesaleNs),
          formatRatioIn(say, s.sessionNs > 0 ? s.wholesaleNs / s.sessionNs : null),
          say('site/bench/n-of-m', { n: s.incremental, total: s.incremental + s.rebuilt }),
        ],
        strong: true,
      })),
      'Only the vnode work is O(1) here — one rect re-emitted. The stillness test rescans '
      + 'every category (a count that drops can retire the tallest bar), so the session column '
      + 'grows with the category count too, just far more slowly than the wholesale one.'));
  }
  out.push(c.types);
  out.push(table(say('site/bench/charts/types'),
    [say('site/bench/col/scenario'), say('site/bench/col/ns-per-chart')],
    (data.types ?? []).map((r) => ({ cells: [r.label, formatNs(r.ns)] })),
    `${data.iterations ?? '?'} iterations; definition plus data to a geometry-free AST to pure vnodes.`));
  return out;
}

/** The geo suite chart, rebuilt only when the suite data reloads. */
const geoCharts = memo1((data, say) => [chartNode(
  profileBars(
    (data.rows ?? []).filter((r) => r.rival !== null).map((r) => ({
      name: r.name,
      results: { jaren: r.ours, [r.rivalName]: r.rival },
    })),
    ['jaren', 'turf', 'geolib', 'flatbush'],
    { title: say('site/bench/geo/chart'), log: true, valLabel: say('site/bench/axis/ns-op-log') }),
  'Each scenario against the rival that owns it: Turf for GeoJSON measurement, geolib for distance, Flatbush for the static box index.')]);

/**
 * The geo suite: the spatial kernel against Turf, geolib and Flatbush,
 * with the result-equivalence checks that gate the timings shown as
 * their own table — a spatial library that is fast and wrong is worse
 * than one that is neither, so the agreement is the headline claim and
 * the speed the second one.
 */
function geoSuite(data, say) {
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
      title: say('site/bench/geo/equivalence'),
      value: `${agreed} / ${checks.length}`,
      note: 'asserted against Turf, geolib and Flatbush before any timing',
    },
    {
      title: say('site/bench/geo/speed'),
      value: geomean === null ? '—' : formatRatioIn(say, geomean),
      note: 'geometric mean over every head-to-head row, losses included',
    },
    {
      title: say('site/bench/geo/pip'),
      value: pip !== undefined && pip.rival !== null ? formatRatioIn(say, pip.rival / pip.ours) : '—',
      note: 'the deliberate loss: the exact orientation predicate, kept over the fast answer',
    },
  ]));
  out.push(callout(say('site/bench/geo/measures'),
    'The kernel is screen-then-refine: a planar equirectangular distance screens candidates at a fraction of haversine\'s cost (both are rows below) and the spherical answer refines the survivors — the same build-then-probe shape as the query engine\'s hash join. The honest rows are all here: point-in-polygon on a large ring runs at roughly half Turf\'s speed because every crossing uses the exact orientation predicate — an answer that cannot flip on near-collinear edges — and that trade is kept on purpose. geolib\'s distance is Vincenty on the WGS 84 ellipsoid, a genuinely different model; the equivalence check states the tolerance instead of hiding the difference.'));
  out.push(callout(say('site/bench/geo/executors'),
    'The kernel timed here is the one the query engine\'s spatial operators call, and one committed corpus holds three executors of the same spatial query document to the same answers: the JavaScript engine, SQLite through the Node driver, and SQLite compiled to wasm in a browser tab — the Data studio runs it, and the browser suite drives it in Chromium, Firefox and WebKit. Agreement is the claim, not speed; the browser leg proves execution, not durability. MongoDB\'s 2dsphere has the query document and the index without a browser or a second engine to agree with; DuckDB-wasm\'s spatial extension has the browser and the index, and its query is SQL.'));
  out.push(...geoCharts(data, say));
  out.push(table(say('site/bench/geo/head-to-head'),
    [say('site/bench/col/scenario'), 'Jaren', say('site/bench/col/rival'), say('site/bench/col/who'), say('site/bench/col/ratio')],
    rows.map((r) => ({
      cells: [
        r.name,
        formatNs(r.ours),
        r.rival === null ? '—' : formatNs(r.rival),
        r.rivalName || '—',
        r.rival === null ? '—' : formatRatioIn(say, r.ours > 0 ? r.rival / r.ours : null),
      ],
      strong: r.rival !== null && r.ours > 0 && r.rival / r.ours >= 1,
    })),
    `${(data.iterations ?? 0).toLocaleString()} iterations; lower is better. Rows without a rival are Jaren-only reference points.`));
  out.push(table(say('site/bench/geo/checks'),
    [say('site/bench/col/scenario'), say('site/bench/col/rival'), say('site/bench/col/agrees'), say('site/bench/col/detail')],
    checks.map((c) => ({
      cells: [c.name, c.rival, c.agrees ? say('site/bench/yes') : say('site/bench/no-caps'), c.note !== '' ? `${c.detail} (${c.note})` : c.detail],
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
function flowSuite(data, say) {
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
      title: say('site/bench/flow/transition'),
      value: step !== undefined && actor !== undefined ? formatRatioIn(say, actor.ns / step.ns) : '—',
      note: say('site/bench/flow/transition-note', { states: mid }),
    },
    {
      title: say('site/bench/flow/compile'),
      value: jarenC !== undefined && xstateC !== undefined ? formatRatioIn(say, xstateC.ns / jarenC.ns) : '—',
      note: 'compileFsm vs createMachine + createActor',
    },
    {
      title: say('site/bench/flow/survives'),
      value: wedge.jaren ? say('site/bench/yes') : '—',
      note: 'guards included — XState\'s are functions JSON drops',
    },
    {
      title: say('site/bench/flow/memory'),
      value: mem ? `${(mem.jarenBytesPer / 1024).toFixed(0)} KiB` : '—',
      // the honest loss, stated as a cost not a "faster than"
      note: mem ? `${mem.states}-state machine; XState's actor holds ${(mem.xstateBytesPer / 1024).toFixed(0)} KiB — we compile every guard as a query, so we hold more` : '',
    },
  ]));

  out.push(callout(say('site/bench/flow/measures'),
    'A jaren-fsm is one JSON document — states, transitions AND guards — so it survives a JSON round trip and still compiles and still fires its guard identically; the conformance row below is that fact. An XState machine\'s guards are functions in the second createMachine argument, which JSON.stringify drops, so the round-tripped machine throws "Guard not implemented" at the guarded transition. That is the whole reason to speak JSON all the way down: a machine you can serialize, store, diff, ship and replay. The pure step is several times faster than XState\'s actor.send, and compile is faster too — but the actor does scheduling and snapshot work the pure function does not, and a compiled Jaren machine holds MORE memory than the actor because every guard compiles to its own query closure. Both are on the page. The dag half pays the documented dataflow tax below.'));

  // the wedge, as a conformance table (toml-test register)
  out.push(table(say('site/bench/flow/serializability'),
    [say('site/bench/col/engine'), say('site/bench/flow/guards-are'), say('site/bench/flow/survives-col')],
    [
      { cells: ['@jarenjs/flow', say('site/bench/flow/guards-data'), wedge.jaren ? say('site/bench/flow/survives-yes') : say('site/bench/no')], strong: true },
      { cells: ['XState v5', say('site/bench/flow/guards-code'), wedge.xstate ? say('site/bench/yes') : say('site/bench/flow/survives-no')] },
    ],
    'The conformance half of this suite: a machine is only "data all the way down" if its guards survive with it.'));

  for (const n of sizes) {
    const tr = data.transition?.[n] ?? [];
    if (tr.length > 0) {
      out.push(chartNode(timingBars(tr, { title: say('site/bench/flow/transition-table', { states: n }), valLabel: 'ns/op' })));
      out.push(table(say('site/bench/flow/transition-table', { states: n }),
        [say('site/bench/col/route'), say('site/bench/col/ns-per-transition')],
        tr.map((r) => ({ cells: [r.label, formatNs(r.ns)], strong: r.label.startsWith('jaren') })),
        'Both Jaren routes are shown: the pure total-function step and the mutable session wrapper.'));
    }
  }

  const compileRows = sizes.map((n) => {
    const c = data.compile?.[n] ?? [];
    return { n, jaren: row(c, 'jaren'), xstate: row(c, 'xstate') };
  }).filter((r) => r.jaren !== undefined && r.xstate !== undefined);
  if (compileRows.length > 0) {
    out.push(table(say('site/bench/flow/compile-table'),
      [say('site/bench/col/states'), 'compileFsm', 'XState', say('site/bench/col/ratio')],
      compileRows.map((r) => ({
        cells: [String(r.n), formatNs(r.jaren.ns), formatNs(r.xstate.ns), formatRatioIn(say, r.xstate.ns / r.jaren.ns)],
        strong: true,
      })),
      'XState builds an actor (scheduling, snapshots); the Jaren column is the pure compile. Not like-for-like — the description→drivable cost each charges.'));
  }

  const dag = data.dag;
  if (dag !== undefined) {
    out.push(callout(say('site/bench/flow/tax'),
      'No npm library executes schema-validated JSON dataflow, so the honest rival is the same pipeline (filter → join → project) written straight in JavaScript — the view suite\'s hand-written-vs-stylesheet honesty, applied to graphs. The ratio is the price of dataflow as one serializable, constrained-decodable JSON value, and it ships beside what it buys.'));
    const dagRow = (variant, r) => ({
      cells: [variant, `${r.rows}`, formatNs(r.dagMs * 1e6), formatNs(r.handMs * 1e6), say('site/bench/flow/x-baseline', { ratio: (r.dagMs / r.handMs).toFixed(1) })],
      strong: true,
    });
    out.push(table(say('site/bench/flow/dag'),
      [say('site/bench/col/variant'), say('site/bench/col/rows'), 'jaren-dag', say('site/bench/flow/hand-written'), say('site/bench/col/abstraction-price')],
      [
        ...(dag.sync ?? []).map((r) => dagRow('no-task', r)),
        ...(dag.async ?? []).map((r) => dagRow('mixed-async', r)),
      ],
      'The dag is compiled once, then run per iteration; the hand-written baseline is wrapped so both await once. The tax is the dispatcher and the wavefront; what it buys is validation, projection and constrained decoding.'));
  }

  out.push(callout(say('site/bench/flow/reproduce'),
    'npm run benchmark:flow (the FSM head-to-head needs the xstate benchmark devDependency; the memory row needs node --expose-gc, which the script passes).'));
  return out;
}

//#endregion
