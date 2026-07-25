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
  { key: 'jsonpath', label: 'JSONPath' },
  { key: 'jsonquery', label: 'JSON Query' },
  { key: 'jslt', label: 'JSLT' },
  { key: 'jsonpointer', label: 'JSON Pointer' },
  { key: 'jsonpatch', label: 'JSON Patch' },
  { key: 'toml', label: 'JOSL / TOML' },
  { key: 'markdown', label: 'Markdown' },
  { key: 'mermaid', label: 'Mermaid' },
  { key: 'view', label: 'View' },
  { key: 'charts', label: 'Charts' },
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
    case 'jsonpointer': return genericTables(data, 'All timings are per-operation nanoseconds; lower is better. Column one is Jaren compiled.');
    case 'jsonpatch': return patch(data);
    case 'toml': return toml(data);
    case 'markdown': return markdown(data);
    case 'mermaid': return mermaid(data);
    case 'view': return view(data);
    case 'charts': return chartsSuite(data);
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

/**
 * The overview: what every suite measured, in one screen. Each row is
 * DERIVED from that suite's generated data (benchmark/website-data.js
 * `buildHeadlines`), so the summary cannot drift from the detail pages
 * behind it — and a suite skipped in a partial regeneration carries its
 * own older run date rather than borrowing this one.
 */
function overview(meta) {
  const headlines = meta.headlines ?? [];
  const runDate = (meta.generated ?? '').slice(0, 10);
  const out = [cards([
    { title: 'Generated', value: runDate || '—', note: `${meta.node ?? ''} · ${meta.quick ? 'quick run' : 'full run'}` },
    { title: 'Machine', value: meta.cpu ?? '—', note: meta.platform ?? '' },
    { title: 'Suite version', value: meta.version ?? '—', note: `${headlines.length} suites measured` },
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
  if (stats !== undefined && stats !== null) {
    const drafts = Object.keys(stats.jaren ?? {});
    out.push(table(
      'JSON Schema conformance — official test suite',
      ['Draft', 'Jaren', 'Ajv'],
      drafts.map((draft) => ({
        cells: [draft, passFail(stats.jaren?.[draft]), passFail(stats.ajv?.[draft])],
      })),
      'passed / failed / errors, optional format suites included'));
  }
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
      { title: 'Ajv failures', value: `${overall.ajvFailures} tests, ${overall.ajvErrors} errors`, note: 'Jaren: 0 and 0' },
    ]));
  }
  const results = Array.isArray(data.results) ? data.results : [];
  const success = results.filter((r) => r.ratio !== null && r.isSuccessTest);

  out.push(...validateCharts(data));

  // the searchable per-test table
  const needle = benchUi.search.trim().toLowerCase();
  const filtered = needle === ''
    ? success
    : success.filter((r) =>
      r.description.toLowerCase().includes(needle)
      || r.suite.toLowerCase().includes(needle)
      || r.draft.toLowerCase().includes(needle));
  const sorted = [...filtered].sort((a, b) => b.ratio - a.ratio);
  const shown = sorted.slice(0, benchUi.limit);
  out.push(search('bench/search', benchUi.search, 'Search tests… (description, suite, draft)'));
  out.push(table(
    `Per-test results — ${shown.length} of ${sorted.length} shown, fastest ratios first`,
    ['Draft', 'Suite', 'Test', 'Ratio', 'Jaren', 'Ajv'],
    shown.map((r) => ({
      cells: [r.draft, r.suite, r.description, formatRatio(r.ratio),
        formatNs(r.jarenTime * 1e6), formatNs(r.ajvTime * 1e6)],
      strong: r.ratio > 10,
    }))));
  if (sorted.length > shown.length) out.push(more('bench/more', `Show more (${sorted.length - shown.length} remaining)`));
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

function jsonpath(data, benchUi) {
  const out = [];
  const groups = data.compliance?.groups ?? [];
  out.push(cards([
    { title: 'Compliance', value: `${data.compliance?.total ?? '—'} / ${data.compliance?.total ?? '—'}`, note: 'official RFC 9535 CTS, both engines' },
    { title: 'Compile all selectors', value: formatNs(data.profile?.compileRow?.engines?.jaren), note: `json-p3: ${formatNs(data.profile?.compileRow?.engines?.['json-p3'])}` },
  ]));
  out.push(table('Compliance by group', ['Group', 'Tests', 'Jaren', 'json-p3'],
    groups.map(([name, g]) => ({
      cells: [name, String(g.total), String(g.pass?.jaren ?? '—'), String(g.pass?.['json-p3'] ?? '—')],
    }))));
  out.push(...jsonpathCharts(data));

  const rows = data.profile?.rows ?? [];
  const needle = benchUi.search.trim().toLowerCase();
  const filtered = needle === ''
    ? rows
    : rows.filter((r) => r.name.toLowerCase().includes(needle) || r.selector.toLowerCase().includes(needle));
  const shown = filtered.slice(0, benchUi.limit);
  out.push(search('bench/search', benchUi.search, 'Search queries… (name, selector)'));
  out.push(table(
    `Per-query profile — ${shown.length} of ${filtered.length} shown (${data.profile?.iterations} iterations)`,
    ['Query', 'Selector', 'Jaren', 'json-p3', 'Ratio'],
    shown.map((r) => ({
      cells: [r.name, r.selector, formatNs(r.engines.jaren), formatNs(r.engines['json-p3']),
        formatRatio(r.engines.jaren > 0 ? r.engines['json-p3'] / r.engines.jaren : null)],
    }))));
  if (filtered.length > shown.length) out.push(more('bench/more', `Show more (${filtered.length - shown.length} remaining)`));

  const scale = data.profile?.scaleRows ?? [];
  if (scale.length > 0) {
    out.push(table('Synthetic scale scenarios (1000 items)', ['Scenario', 'Selector', 'Jaren', 'json-p3', 'Ratio'],
      scale.map((r) => ({
        cells: [r.name, r.selector, formatNs(r.engines.jaren), formatNs(r.engines['json-p3']),
          formatRatio(r.engines.jaren > 0 ? r.engines['json-p3'] / r.engines.jaren : null)],
      }))));
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
}));

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
      'Jaren renders Markdown to JSON vnodes with no unescaped HTML by design, so raw-HTML pass-through examples cannot pass — its score is honest dialect coverage, not a compliance claim.'));
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
      'marked and markdown-it are the mainstream one-shot parsers; Jaren stays within ~1.1–1.5× while producing a JSON AST and keyed vnodes, not just an HTML string.'));
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
  const preactBuild = row(build, 'preact');
  const frame = t.frame ?? [];
  const memoFrame = row(frame, '(memo)');
  const plainFrame = row(frame, '(no memo)');
  const memoPair = t.memo ?? [];

  out.push(cards([
    {
      // formatRatio names the direction itself, so this reads
      // "8.7× slower" — the honest label for the build path
      title: 'Vnode production vs preact',
      value: jarenBuild !== undefined && preactBuild !== undefined
        ? formatRatio(preactBuild.ns / jarenBuild.ns)
        : '—',
      note: 'by design: a generic dispatcher, not a hand-written h()',
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
  out.push(callout('What this suite measures — including where we lose',
    'Jaren builds views by running a JSLT stylesheet over state, so producing a vnode tree from scratch costs several times a hand-written preact or hyperapp h() call. That is the honest price of views-as-data, and it is on this page. The trade is the re-render path: unchanged state returns the previous output by reference, so the patcher skips it instead of diffing it — the rows below measure both directions on the same 1000-row table, with SSR output asserted byte-identical to preact before timing.'));

  out.push(c.build);
  out.push(table('View production — full build (fresh state, memo cold)',
    ['Engine', 'ns per view'],
    build.map((r) => ({ cells: [r.label, formatNs(r.ns)], strong: r.label.startsWith('jaren') })),
    `${data.rows ?? '?'} rows, ${data.iterations ?? '?'} iterations; lower is better.`));

  out.push(c.update);
  out.push(table('View production — one copy-on-write row updated',
    ['Engine', 'ns per view'],
    (t.update ?? []).map((r) => ({ cells: [r.label, formatNs(r.ns)], strong: r.label.startsWith('jaren') })),
    'hyperapp and preact re-run the whole view function per change (their idiomatic default; both offer opt-in per-call-site memo wrappers). Jaren\'s memo is a compile option that needs no view changes.'));

  out.push(c.ssr);
  out.push(table('SSR — vnodes to an HTML string',
    ['Engine', 'ns per render'],
    (t.ssr ?? []).map((r) => ({ cells: [r.label, formatNs(r.ns)], strong: r.label.startsWith('jaren') })),
    `Output equality is asserted before timing: every engine emits the same ${data.ssrChars ?? '?'}-character document.`));

  out.push(table('Frame cost — view + DOM patch (Jaren only)',
    ['Path', 'ns per frame'],
    frame.map((r) => ({ cells: [r.label, formatNs(r.ns)] })),
    'Measured against the repository\'s DOM stub, so no cross-framework claim is made here — hyperapp and preact need a real DOM. The number shows what the reference-equality skip is worth end to end.'));

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
  out.push(c.types);
  out.push(table('Compile + project, per chart type',
    ['Scenario', 'ns per chart'],
    (data.types ?? []).map((r) => ({ cells: [r.label, formatNs(r.ns)] })),
    `${data.iterations ?? '?'} iterations; definition plus data to a geometry-free AST to pure vnodes.`));
  return out;
}

//#endregion
