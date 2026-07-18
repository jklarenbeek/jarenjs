//@ts-check
/**
 * The benchmark derivation boundary: raw generated JSON (from
 * `benchmark/website-data.js`, synced out of the website package) in,
 * **kind-tagged render nodes** out. The `ui` view mode has one generic
 * rule per kind (`cards`, `table`, `callout`) — so a whole benchmark
 * suite renders through three rules, and adding a suite is a pure data
 * transformation here.
 *
 * The suite-wide ratio convention holds everywhere: ratio > 1 means
 * "Jaren is N× faster".
 */

import { formatNs, formatMs, formatRatio } from '../lib/format.js';

const OLD_SITE = 'https://jklarenbeek.github.io/jarenjs/';

export const SUITES = [
  { key: 'overview', label: 'Overview' },
  { key: 'validate', label: 'JSON Schema' },
  { key: 'jsonpointer', label: 'JSON Pointer' },
  { key: 'jsonpatch', label: 'JSON Patch' },
  { key: 'toml', label: 'JOSL / TOML' },
  { key: 'jsonpath', label: 'JSONPath' },
  { key: 'jsonquery', label: 'JSON Query' },
  { key: 'jslt', label: 'JSLT' },
];

// every render node carries a `kind`; the `ui` view mode has one
// generic rule per kind
const cards = (items) => ({ kind: 'cards', items: items.map((i) => ({ kind: 'card', ...i, note: i.note ?? null })) });
const table = (title, head, rows, note) => ({
  kind: 'table', title, head, note: note ?? null,
  rows: rows.map((r) => ({ kind: 'row', ...r })),
});
const callout = (title, text, href, link) =>
  ({ kind: 'callout', title, text, href: href ?? null, link: link ?? null });

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
    case 'validate': return validate(data);
    case 'jsonpointer': return genericTables(data, formatNs, 'All timings are per-operation nanoseconds; lower is better. Column one is Jaren compiled.');
    case 'jsonpatch': return patch(data);
    case 'toml': return toml(data);
    default:
      return [callout(
        'Not yet ported to webnext',
        'This suite\'s deep-dive (histograms, per-test drill-down, program sources) still lives on the current site.',
        `${OLD_SITE}#/benchmarks?suite=${suite}`,
        'Open in the current website')];
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
        cells: [
          draft,
          summary(stats.jaren?.[draft]),
          summary(stats.ajv?.[draft]),
        ],
        strong: false,
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

function summary(s) {
  if (s === undefined || s === null) return '—';
  return `${s.passed} / ${s.failed} / ${s.errors}`;
}

function validate(data) {
  const overall = data.summary?.overall;
  const out = [];
  if (overall !== undefined) {
    out.push(cards([
      { title: 'Success-only totals', value: `${Math.round(overall.jarenSuccessTime)} ms vs ${Math.round(overall.ajvSuccessTime)} ms`, note: 'Jaren vs Ajv, tests both can run' },
      { title: 'Jaren wins', value: `${overall.successOnly?.jarenWins ?? '—'} tests`, note: `Ajv wins ${overall.successOnly?.ajvWins ?? '—'}` },
      { title: 'Ajv failures', value: `${overall.ajvFailures} tests, ${overall.ajvErrors} errors`, note: 'Jaren: 0 and 0' },
    ]));
  }
  const results = Array.isArray(data.results) ? data.results : [];
  const ranked = results
    .filter((r) => r.ratio !== null && r.isSuccessTest)
    .sort((a, b) => b.ratio - a.ratio);
  const row = (r) => ({
    cells: [r.draft, r.description, formatRatio(r.ratio), formatNs(r.jarenTime * 1e6), formatNs(r.ajvTime * 1e6)],
    strong: false,
  });
  out.push(table('Biggest Jaren wins', ['Draft', 'Test', 'Ratio', 'Jaren', 'Ajv'],
    ranked.slice(0, 10).map(row)));
  out.push(table('Biggest Ajv wins', ['Draft', 'Test', 'Ratio', 'Jaren', 'Ajv'],
    ranked.slice(-10).reverse().map(row),
    'The full searchable per-test table is still on the current site.'));
  return out;
}

/** pointer-style payloads: `{ tables: [{ title, columns, rows: [{ name, results[] }] }] }` */
function genericTables(data, fmt, note) {
  return (data.tables ?? []).map((t) => table(
    t.title,
    ['Scenario', ...t.columns],
    t.rows.map((r) => ({ cells: [r.name, ...r.results.map(fmt)], strong: false })),
    note));
}

function patch(data) {
  const out = [];
  if (data.conformance !== undefined) {
    out.push(cards([{
      title: 'Conformance',
      value: `${data.conformance.pass} / ${data.conformance.total}`,
      note: 'official json-patch-tests suite',
    }]));
  }
  out.push(...genericTables(data, formatNs, 'Per-application nanoseconds; lower is better.'));
  return out;
}

function toml(data) {
  const out = [];
  if (data.compliance !== undefined) {
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
    out.push(table(
      `Parse profile (${profile.iterations} iterations)`,
      ['Document', ...(data.engines ?? [])],
      (profile.parse ?? []).map((p) => ({
        cells: [p.name, ...(data.engines ?? []).map((e) => formatMs(p.results[e]))],
        strong: false,
      })),
      'smol-toml keeps a raw-throughput edge; Jaren is the only engine passing the complete suite while streaming.'));
  }
  return out;
}
