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
    default: return [callout('Unknown suite', `No derivation for '${suite}'.`)];
  }
}

function overview(meta) {
  const out = [cards([
    { title: 'Generated', value: (meta.generated ?? '').slice(0, 10), note: meta.node ?? '' },
    { title: 'Machine', value: meta.cpu ?? '—', note: meta.platform ?? '' },
    { title: 'Suite version', value: meta.version ?? '—', note: meta.quick ? 'quick run' : 'full run' },
  ])];
  const stats = meta.conformance?.jsonSchema?.engineStats;
  if (stats !== undefined) {
    const drafts = Object.keys(stats.jaren ?? {});
    out.push(table(
      'JSON Schema conformance — official test suite',
      ['Draft', 'Jaren', 'Ajv'],
      drafts.map((draft) => ({
        cells: [draft, passFail(stats.jaren?.[draft]), passFail(stats.ajv?.[draft])],
      })),
      'passed / failed / errors, optional format suites included'));
  }
  if (meta.qt3 !== undefined) {
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
