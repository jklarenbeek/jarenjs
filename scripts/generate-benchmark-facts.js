//@ts-check
/**
 * The measured-figure registry: every measured number quoted in committed
 * markdown is derived here from `packages/website/public/benchmarks/*.json`
 * — the same files the website's Benchmarks page reads — plus
 * `benchmark/bundle-sizes.json`, and written into the docs between
 * `<!--fact:key-->` … `<!--/fact-->` markers by `scripts/derive-docs.js`.
 *
 * Why this exists: those numbers used to be hand-copied out of a
 * benchmark run and never touched again. By the time this was written 19
 * of them had drifted, in both directions — the root README quoted a
 * JSONPath ratio the committed data no longer supported, and understated
 * three per-draft win counts. A figure nobody can recompute is a figure
 * nobody can trust.
 *
 * This NEVER runs a benchmark. It reads the committed measurements, so it
 * is deterministic, instant, and safe on any machine — re-measuring is a
 * separate, deliberate act (`npm run benchmark:generate`) that only ever
 * happens where the numbers are meant to be measured.
 *
 *   npm run docs:derive          # rewrite the docs
 *   npm run docs:check           # fail on drift
 *
 * Markers are HTML comments, so GitHub renders the documents unchanged.
 * The prose AROUND a marker stays human: when a band moves far enough
 * that the sentence reads wrong, the gate makes a person read it.
 *
 * The marker layer is `@jarenjs/md`'s (`bake`) and the baking is
 * `scripts/lib/derive.js`'s — this file is a registry of DERIVATIONS over
 * the committed measurements, and nothing else. That split is the point:
 * one namespace and one runner for every derived span in the repository,
 * one registry per source. The derivations stay in JavaScript on purpose:
 * bands, means and whole tables read worse as query one-liners, and
 * query templates are for document vocabularies, not build scripts.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ratioSummary } from '../benchmark/derive.js';
import { buildSiteContent } from './generate-site-data.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const DATA = join(ROOT, 'packages/website/public/benchmarks');

/** @type {Record<string, any>} */
const cache = {};
const data = (name) => (cache[name] ??= JSON.parse(readFileSync(join(DATA, `${name}.json`), 'utf8')));

/** One of the contracts suite's tables, by the start of its title. */
function contractsTable(prefix) {
  const t = data('contracts').tables.find((x) => x.title.startsWith(prefix));
  if (t === undefined) throw new Error(`contracts.json carries no '${prefix}' table — regenerate it before quoting one`);
  return t;
}

/** A contracts row's scenario name, before its description. */
const scenarioOf = (row) => row.name.split(' — ')[0];

/** `a`, `a and b`, `a, b and c`. */
const listOf = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/** Where Jaren stands against one rival column of a contracts table, scenario by scenario. */
function standing(t, rival) {
  const mine = t.columns.indexOf('@jarenjs/validate');
  const col = t.columns.indexOf(rival);
  if (mine === -1 || col === -1) throw new Error(`contracts.json '${t.title}' names no @jarenjs/validate or ${rival} column`);
  const timed = t.rows.filter((r) => Number.isFinite(r.results[mine]) && Number.isFinite(r.results[col]));
  const lost = timed.filter((r) => !(r.results[mine] < r.results[col]));
  if (lost.length === 0) return `faster than ${rival} in every scenario`;
  if (lost.length === timed.length) return `slower than ${rival} in every scenario`;
  return `faster than ${rival} in ${timed.length - lost.length} of ${timed.length}, while ${rival} is faster on the ${listOf(lost.map(scenarioOf))} scenario${lost.length === 1 ? '' : 's'}`;
}

/**
 * The `@jarenjs/linq` subpath bundle sizes, measured by
 * `scripts/check-tree-shaking.js` and committed as its baseline. It lives
 * outside `benchmarks/` because it is not a suite — nothing on the
 * Benchmarks page reads it, and the manifest gate holds that directory
 * equal to `benchmark/website-data.js`'s suite lists.
 * @type {any}
 */
let bundleCache;
const bundles = () => (bundleCache ??= JSON.parse(
  readFileSync(join(ROOT, 'benchmark/bundle-sizes.json'), 'utf8')));

/** One subpath's measured bundle, in bytes. */
function bundleBytes(name) {
  const bytes = bundles().bundles[name];
  if (typeof bytes !== 'number') {
    throw new Error(`benchmark/bundle-sizes.json has no '${name}' bundle `
      + '— re-measure with `npm run test:tree-shaking -- --write`');
  }
  return bytes;
}

/**
 * The package census, read through the ONE builder that enumerates the
 * workspaces — the same collection the site consumes. A second
 * enumeration here is how a README comes to name a package count the
 * repository outgrew, so there is not one.
 * @type {any}
 */
let censusCache;
const census = () => (censusCache ??= buildSiteContent());

/** One workspace's collected entry, by published name. */
function workspace(name) {
  const entry = census().packages.find((/** @type {any} */ p) => p.name === name);
  if (entry === undefined) throw new Error(`no workspace named ${name} — the census cannot answer a claim about it`);
  return entry;
}

//#region formatting — one rounding policy, applied everywhere

/** A ratio, one decimal: `23.1`. */
const ratio = (x) => x.toFixed(1);
/** Milliseconds at two significant figures below 10, whole above. */
const ms = (x) => (x >= 10 ? String(Math.round(x)) : Number(x.toPrecision(2)).toString());
/** Jaren's and Ajv's totals with the faster one in bold (a tie bolds neither). */
const faster = (jaren, ajv) => {
  const [j, a] = [Number(ms(jaren)), Number(ms(ajv))];
  return `${j < a ? `**${ms(jaren)} ms**` : `${ms(jaren)} ms`} vs ${a < j ? `**${ms(ajv)} ms**` : `${ms(ajv)} ms`}`;
};
/** Milliseconds at a fixed decimal — the CSV table's column style, where
 * a uniform width is what makes six engines comparable down the column. */
const ms1 = (x) => x.toFixed(1);
/** Nanoseconds, whole. */
const ns = (x) => String(Math.round(x));
/** Microseconds from nanoseconds, two significant figures. */
const us = (x) => Number((x / 1000).toPrecision(3)).toString();
/** A duration in nanoseconds, in the unit a reader would have used. */
const dur = (x) => (x >= 1e6 ? `${Number((x / 1e6).toPrecision(3))} ms`
  : x >= 1e3 ? `${Number((x / 1e3).toPrecision(3))} µs` : `${Math.round(x)} ns`);
/** The min and max of a list, as a `lo–hi` band. */
const band = (xs, fmt) => `${fmt(Math.min(...xs))}–${fmt(Math.max(...xs))}`;
/** A count with thousand separators, the one grouping the docs use. */
const thousands = (n) => n.toLocaleString('en-US');

//#endregion

/** A row from a labelled `[{label, ns}]` list. */
const byLabel = (rows, label) => rows.find((r) => r.label === label);

/** The JSONPath compliance-suite profile, summarized against json-p3. */
function cts() {
  const summary = ratioSummary(data('jsonpath').profile.rows, 'jaren', 'json-p3');
  if (summary.rows === 0) {
    throw new Error('jsonpath.json carries no comparable profile rows — regenerate it before quoting one');
  }
  return summary;
}

/**
 * One engine's score on the JSONPath compliance corpus, summed over the
 * per-group counts `jsonpath.json` carries — `all 703` for a clean
 * sweep, `698 of 703` for anything less.
 * @param {string} engine
 */
/** The committed QT3 baseline (benchmark/qt3-baseline.json). @returns {any} */
function qt3Baseline() {
  return JSON.parse(readFileSync(join(ROOT, 'benchmark/qt3-baseline.json'), 'utf8'));
}

function ctsCompliance(engine) {
  const { total, groups } = data('jsonpath').compliance;
  let passed = 0;
  for (const [name, group] of groups) {
    const score = group.pass[engine];
    if (typeof score !== 'number') {
      throw new Error(`jsonpath.json's '${name}' group has no '${engine}' score `
        + '— regenerate it before quoting the engine');
    }
    passed += score;
  }
  return passed === total ? `all ${total}` : `${passed} of ${total}`;
}

/**
 * The phase split of the largest markdown document measured.
 */
function phases() {
  const rows = data('markdown').profile.jaren;
  const row = rows[rows.length - 1];
  if (row === undefined || row.phases === undefined) {
    throw new Error('markdown.json carries no phase split — regenerate it before quoting one');
  }
  return row.phases;
}

function scorecardFigure(suite, engine) {
  const row = data(suite).scorecard[engine];
  if (row === undefined) {
    throw new Error(`${suite}.json has no '${engine}' scorecard row — regenerate it before quoting the number`);
  }
  return `${row.pass} of ${row.total} (${((100 * row.pass) / row.total).toFixed(1)}%)`;
}

/**
 * The GFM extension scorecard block of `markdown.json`. It is null when
 * the run had no `benchmark/gfm-spec` submodule, and a document that
 * quotes the number must not silently print one from a run that never
 * scored it.
 */
function gfmData() {
  const gfm = data('markdown').gfm;
  if (gfm === null || gfm === undefined) {
    throw new Error("markdown.json has no GFM scorecard — run 'git submodule update --init "
      + "benchmark/gfm-spec' and regenerate it before quoting the number");
  }
  return gfm;
}

/**
 * `pass of total (pct%)` for one engine on the GFM extension corpus.
 * @param {string} engine
 */
function gfmFigure(engine) {
  const row = gfmData().scorecard[engine];
  if (row === undefined) {
    throw new Error(`markdown.json has no GFM '${engine}' row — regenerate it before quoting the number`);
  }
  return `${row.pass} of ${row.total} (${((100 * row.pass) / row.total).toFixed(1)}%)`;
}

/**
 * The per-row ratio band of contract.json's in-process dispatch table
 * against one rival column: rival/jaren (`invert` flips it for a rival
 * that is FASTER, so the band reads as "N× faster than jaren").
 * @param {string} rivalColumn
 * @param {boolean} [invert]
 */
function contractDispatchBand(rivalColumn, invert = false) {
  const t = data('contract').tables.find((x) => x.title.startsWith('Dispatch, in-process'));
  const jaren = t?.columns.indexOf('@jarenjs/contract') ?? -1;
  const rival = t?.columns.indexOf(rivalColumn) ?? -1;
  const ratios = (t?.rows ?? [])
    .filter((r) => Number.isFinite(r.results[jaren]) && Number.isFinite(r.results[rival]) && r.results[rival] > 0)
    .map((r) => (invert ? r.results[jaren] / r.results[rival] : r.results[rival] / r.results[jaren]));
  if (jaren === -1 || rival === -1 || ratios.length === 0) {
    throw new Error(`contract.json has no dispatch rows against '${rivalColumn}' — regenerate it before quoting one`);
  }
  return band(ratios, ratio);
}

/**
 * Every fact, keyed by its marker name. A fact returns the exact text
 * that replaces the marker's body — including any markdown emphasis, so
 * a table cell keeps its bolding.
 * @type {Record<string, () => string>}
 */


/** A geo row by name, or a refusal naming it — never a fabricated figure. */
/** One figure of `orm.json`, by table title prefix and row name. */
function ormRow(title, name) {
  const table = data('orm').tables.find((t) => t.title.startsWith(title.slice(0, 40)));
  if (table === undefined) throw new Error(`orm.json has no table '${title}'`);
  const row = table.rows.find((r) => r.name === name);
  if (row === undefined) throw new Error(`orm.json's '${table.title}' has no row '${name}'`);
  return row.results[0];
}

/**
 * Every Node table of `orm.json` where the typed client can be compared
 * with a rival: which rivals it beats there, and its ratio against the
 * FASTEST rival in the table (above 1 is a loss). Each engine is taken
 * at its own best row, which is how each of them would quote itself.
 * @returns {{ label: string, rival: string, ratio: number,
 *   met: string[], beats: string[] }[]}
 */
function ormClientRows() {
  const RIVALS = ['Prisma', 'Drizzle', 'Kysely'];
  const fastest = (rows) => rows.reduce((a, b) => (b.results[0] < a.results[0] ? b : a));
  const rows = [];
  for (const table of data('orm').tables) {
    if (table.title.startsWith('[Bun]')) continue;
    const timed = (prefix) => table.rows.filter((row) => row.name.startsWith(prefix)
      && typeof row.results[0] === 'number');
    const mine = timed('jaren client');
    if (mine.length === 0) continue;
    const ours = fastest(mine).results[0];
    const met = RIVALS.filter((rival) => timed(rival).length > 0);
    if (met.length === 0) continue;
    const best = met.map((rival) => ({ rival, ns: fastest(timed(rival)).results[0] }));
    const winner = best.reduce((a, b) => (b.ns < a.ns ? b : a));
    rows.push({
      // the title up to its first ':' or '(' — the table's own words, cut
      // where its parenthetical apparatus begins
      label: table.title.split(/[:(]/u)[0].trim().toLowerCase(),
      rival: winner.rival,
      ratio: ours / winner.ns,
      met,
      beats: best.filter((entry) => ours <= entry.ns).map((entry) => entry.rival),
    });
  }
  return rows;
}

function geoRow(name) {
  const row = data('geo').rows.find((r) => r.name === name);
  if (row === undefined) throw new Error(`geo.json has no '${name}' row — regenerate it before quoting one`);
  return row;
}

/** The rival's time over the kernel's for a named row (above 1 = a win). */
const geoRatio = (name) => {
  const row = geoRow(name);
  return row.rival / row.ours;
};

/** A nanosecond figure as the geo benchmark prints it. */
function nanos(x) {
  if (x < 1000) return `${x.toFixed(1)} ns`;
  if (x < 1e6) return `${(x / 1000).toFixed(2)} µs`;
  return `${(x / 1e6).toFixed(2)} ms`;
}

/**
 * The geo table, as Markdown, for the rows a predicate keeps: a rival
 * row carries its ratio in bold above 1 and plain below; a row with no
 * rival carries dashes. Returns `\n…\n` so its marker owns a line.
 * @param {(row: any) => boolean} keep
 */
function geoTable(keep) {
  const rows = data('geo').rows.filter(keep).map((row) => {
    if (row.rival === null) return `| ${row.name} | ${nanos(row.ours)} | — | — |`;
    const r = row.rival / row.ours;
    const shown = `${ratio(r)}×`;
    return `| ${row.name} | ${nanos(row.ours)} | ${nanos(row.rival)} (${row.rivalName}) | ${r >= 1 ? `**${shown}**` : shown} |`;
  });
  return ['', '| scenario | Jaren | rival | ratio |', '|---|---|---|---|', ...rows, ''].join('\n');
}
/**
 * The replicated cascading delete of the change-flow result: one row per
 * capture mode, then what the rows say — the rows the delete's foreign keys
 * removed and nulled, whether both modes replicated the same envelope, and
 * journal capture's delete p50 as a multiple of session capture's, whichever
 * way it falls.
 * @param {any[]} rows - the result's `cascade` rows
 * @param {(value: number) => string} fixed
 * @returns {string[]}
 */
function cascadeRows(rows, fixed) {
  const journal = rows.find((row) => row.capture === 'journal');
  const session = rows.find((row) => row.capture === 'session');
  const same = journal.operations === session.operations && journal.bytes === session.bytes;
  return ['', '| Capture | Rows removed | Rows nulled | Operations | Bytes | Delete p50 ms | Delete p95 ms | Apply p50 ms |',
    '|---|---:|---:|---:|---:|---:|---:|---:|',
    ...rows.map((row) => `| ${row.capture} | ${row.removed} | ${row.nulled} | ${row.operations} | ${row.bytes} | ${fixed(row.deleteMs.p50)} | ${fixed(row.deleteMs.p95)} | ${fixed(row.applyMs.p50)} |`),
    '', `A parent's delete whose foreign keys remove ${journal.removed} rows and null ${journal.nulled} replicates `
      + (same ? `as the same ${journal.operations}-operation envelope from either capture mode. ` : 'as the envelopes above. ')
      + `Journal capture reads those rows before the delete runs: its delete p50 is `
      + `${ratio(journal.deleteMs.p50 / session.deleteMs.p50)}× session capture's.`];
}
/**
 * The change-flow benchmark's block, from its result: the live-maintenance
 * rows, the replication rows and, once a result has them, the cascading
 * delete rows.
 * @param {any} report - a `benchmark/changeflow-results.json` document
 * @returns {string}
 */
export function changeflowFigures(report) {
  const fixed = (/** @type {number} */ value) => value.toFixed(3);
  return '\n\n' + [
    `Measured ${report.measuredAt.slice(0, 10)}, ${report.runtime}, ${report.host.cpu}; ${report.samples} mutations per case.`,
    '', '| Shape | Strategy | Initialize ms | Mutation p50 ms | Mutation p95 ms | Initialization heap bytes |',
    '|---|---|---:|---:|---:|---:|',
    ...report.live.map((row) => `| ${row.shape} | ${row.strategy.strategy} | ${fixed(row.initializationMs)} | ${fixed(row.mutationMs.p50)} | ${fixed(row.mutationMs.p95)} | ${row.retainedHeapBytes} |`),
    '', '| Capture | Envelopes | Operations | Bytes | Apply p50 ms | Replay p50 ms | Conflict p50 ms |',
    '|---|---:|---:|---:|---:|---:|---:|',
    ...report.replication.map((row) => `| ${row.capture} | ${row.envelopes} | ${row.operations} | ${row.bytes} | ${fixed(row.applyMs.p50)} | ${fixed(row.replayMs.p50)} | ${fixed(row.conflictMs.p50)} |`),
    ...(report.cascade === undefined ? [] : cascadeRows(report.cascade, fixed)),
    '', 'Selective maintenance avoids repeated full SQL evaluation. Initialization and high-fan-out maintenance can cost more than rerunning; the table includes both. Offset groups remain rerun in both requested modes.',
  ].join('\n') + '\n\n';
}
//#region the suite rows the package documents quote

/** A ratio at the precision a reader uses: whole from a hundred up, one
 * decimal below that, two significant figures under one. */
const mag = (x) => (x >= 100 ? thousands(Math.round(x)) : x >= 1 ? ratio(x) : Number(x.toPrecision(2)).toString());
/** A duration that also has a seconds unit, for the rows a rival takes seconds over. */
const durS = (x) => (x >= 1e9 ? `${Number((x / 1e9).toPrecision(3))} s` : dur(x));
/** A ratio at two decimals, for the near-level rows where one decimal reads as a tie. */
const fix2 = (x) => x.toFixed(2);
/** A suite's engine label without its package version: `fontoxpath@3.34.0` → `3.34.0`. */
const versionOf = (label) => label.split('@').pop();

/**
 * A band of `rival / mine` ratios as the words it supports — a win band,
 * a loss band, or one that straddles level — so a sentence built on it
 * cannot say "faster" over a row that lost. The caller writes " than".
 * @param {number[]} xs @param {(x: number) => string} [fmt] @param {string} [unit]
 */
function lead(xs, fmt = ratio, unit = '×') {
  if (xs.length === 0) throw new Error('no comparable rows to state a lead over — regenerate the suite before quoting one');
  if (Math.min(...xs) >= 1) return `${band(xs, fmt)}${unit} faster`;
  if (Math.max(...xs) < 1) return `${band(xs.map((x) => 1 / x), fmt)}${unit} slower`;
  return `between ${fmt(1 / Math.min(...xs))}${unit} slower and ${fmt(Math.max(...xs))}${unit} faster`;
}

/** One geo row against its rival in words: level within 5 %, otherwise
 * faster or slower by the measured ratio. @param {string} name */
function geoVerdict(name) {
  const row = geoRow(name);
  const r = row.rival / row.ours;
  if (r >= 1 / 1.05 && r <= 1.05) return `level with ${row.rivalName}`;
  return r > 1 ? `${ratio(r)}× faster than ${row.rivalName}` : `${ratio(1 / r)}× slower than ${row.rivalName}`;
}

/** When a suite was measured and on what Node, and — under the settled
 * method — how many processes each figure is the median of.
 * @param {string} suite */
function measuredOn(suite) {
  const d = data(suite);
  const stamp = d.date ?? d.metadata?.timestamp;
  if (typeof stamp !== 'string' || typeof d.node !== 'string') {
    throw new Error(`${suite}.json carries no measurement date — regenerate it before quoting its numbers`);
  }
  const record = data('meta').measurement?.[suite];
  const median = record?.method === 'settled' && record.processes > 1
    ? `, each figure the median of ${record.processes} processes` : '';
  return `${stamp.slice(0, 10)}, Node ${d.node}${median}`;
}

/** The query shapes of the JSONPath scale document, in the README's words. */
const JSONPATH_SHAPES = {
  '$.items[42].name': 'singular',
  '$.items[*].id': 'wildcard',
  '$.items[100:200].id': 'slice',
  '$.items[?@.price < 10].name': 'filter',
  '$.items[?match(@.name, "item-1.*")].id': 'regexp filter',
  '$..value': 'descendant',
};

/** The JSONPath scale rows against json-p3: shape, both timings, json-p3 over Jaren. */
function jsonpathScale() {
  const rows = (data('jsonpath').profile.scaleRows ?? [])
    .filter((r) => Number.isFinite(r.engines.jaren) && Number.isFinite(r.engines['json-p3']));
  if (rows.length === 0) throw new Error('jsonpath.json carries no scale rows — regenerate it with --scale before quoting one');
  return rows.map((r) => ({
    selector: r.selector,
    shape: `${JSONPATH_SHAPES[r.selector] ?? 'query'} \`${r.selector}\``,
    mine: r.engines.jaren,
    rival: r.engines['json-p3'],
    ratio: r.engines['json-p3'] / r.engines.jaren,
  }));
}

/** One JSON Pointer table, by key. */
function pointerTable(key) {
  const t = data('jsonpointer').tables.find((x) => x.key === key);
  if (t === undefined) throw new Error(`jsonpointer.json carries no '${key}' table — regenerate it before quoting one`);
  return t;
}
/**
 * The compiled getter against a rival, row by row: the rival's time over
 * the getter's. With several rival columns each row takes the fastest of
 * them, the route the rival's own user would take.
 * @param {string} key @param {string[]} rivals
 */
function pointerRatios(key, rivals) {
  const t = pointerTable(key);
  const mine = t.columns.indexOf('jaren compiled');
  const cols = rivals.map((c) => t.columns.indexOf(c));
  if (mine === -1 || cols.includes(-1)) throw new Error(`jsonpointer.json '${t.title}' lacks a column it is quoted against`);
  return t.rows.flatMap((r) => {
    const theirs = cols.map((c) => r.results[c]).filter((v) => Number.isFinite(v) && v > 0);
    if (!Number.isFinite(r.results[mine]) || theirs.length === 0) return [];
    return [{ name: r.name, ratio: Math.min(...theirs) / r.results[mine] }];
  });
}

/** The books a bookstore document holds, from its label. */
function booksOf(document) {
  const books = /\((\d[\d,]*) books/u.exec(document)?.[1];
  if (books === undefined) throw new Error(`cannot read a book count from '${document}'`);
  return Number(books.replace(/,/gu, ''));
}

/**
 * The query or JSLT suite as a table: the smallest and the largest
 * document, every scenario as the suite lists it, Jaren's time and each
 * rival's time with its ratio over Jaren's. A scenario the largest
 * document did not run is shown at the largest that ran it, and says so.
 * @param {'jsonquery' | 'jslt'} suite @param {[string, string][]} rivals - [engine key, column label]
 * @param {string} compileLabel
 */
function bookstoreTable(suite, rivals, compileLabel) {
  const d = data(suite);
  const timed = (r) => Number.isFinite(r.engines.jaren);
  const documents = [...new Set(d.rows.map((r) => r.document))].sort((a, b) => booksOf(a) - booksOf(b));
  const cell = (value, mine) => (Number.isFinite(value) ? `${durS(value)} (${mag(value / mine)}x)` : 'n/a');
  const line = (name, mine, results) => `| ${name} | ${durS(mine)} | ${rivals.map(([key]) => cell(results[key], mine)).join(' | ')} |`;
  const blank = ` |${rivals.map(() => ' |').join('')}`;
  const lines = [`| Scenario | Jaren | ${rivals.map(([, label]) => label).join(' | ')} |`,
    `|---|---|${rivals.map(() => '---|').join('')}`];
  for (const document of [documents[0], documents[documents.length - 1]]) {
    lines.push(`| **${thousands(booksOf(document))}-book bookstore** |${blank}`);
    for (const scenario of d.scenarios) {
      let row = d.rows.find((r) => r.scenario === scenario.key && r.document === document);
      let note = '';
      if (row === undefined || !timed(row)) {
        row = d.rows.filter((r) => r.scenario === scenario.key && timed(r))
          .sort((a, b) => booksOf(b.document) - booksOf(a.document))[0];
        if (row === undefined) continue;
        note = ` — measured at ${thousands(booksOf(row.document))} books`;
      }
      lines.push(line(`${scenario.title}${note}`, row.engines.jaren, row.engines));
    }
  }
  const c = d.compile?.results;
  if (c === undefined || !Number.isFinite(c.jaren)) throw new Error(`${suite}.json carries no compile row — regenerate it before quoting one`);
  lines.push(`| **${compileLabel}** | ${durS(c.jaren)} | ${rivals.map(([key]) => cell(c[key], c.jaren)).join(' | ')} |`);
  return `\n${lines.join('\n')}\n`;
}

/** Every timed `rival / jaren` ratio of a bookstore suite a predicate keeps. */
function bookstoreRatios(suite, rival, keep) {
  return data(suite).rows
    .filter((r) => keep(r) && Number.isFinite(r.engines.jaren) && Number.isFinite(r.engines[rival]) && r.engines.jaren > 0)
    .map((r) => r.engines[rival] / r.engines.jaren);
}

/** One CSV profile table's rows by name. */
function csvRows(table) {
  const rows = data('csv').profile[table];
  if (!Array.isArray(rows) || rows.length === 0) throw new Error(`csv.json carries no '${table}' profile — regenerate it before quoting one`);
  return rows;
}
/** The CSV rows in the README's words. */
const CSV_SHAPES = { 'records 10k x 6 (plain)': 'the plain record stream', 'quoted 10k x 3': 'quoted', 'wide 1k x 50': 'the wide table' };

/** The TOML parse rows in the README's words. */
const TOML_SHAPES = { 'records-1k (~90KB)': 'the 1k-record document', 'spec-example-1 (small doc)': 'the small document', 'valid corpus (each file)': 'the suite corpus' };
const TOML_ENGINES = ['jaren', 'smol-toml', '@iarna/toml', 'toml'];

/**
 * "leads …: 2.2 ms against Y's 2.6 ms and Z's 6.8 ms" — the one-row
 * stringify comparisons of the CSV and TOML profiles, led by whoever is
 * fastest rather than by us.
 * @param {Record<string, number | null>} results @param {(name: string) => string} label
 */
function stringifyLeader(results, label) {
  const timed = Object.entries(results).filter(([, v]) => Number.isFinite(v)).sort((a, b) => a[1] - b[1]);
  if (!timed.some(([name]) => name === 'jaren')) throw new Error('no jaren stringify row — regenerate the suite before quoting one');
  const [[winner, best], ...rest] = timed;
  const head = winner === 'jaren' ? `leads everything that offers one: ${ms(best)} ms`
    : `trails ${label(winner)}: ${label(winner)}'s ${ms(best)} ms`;
  return `${head} against ${listOf(rest.map(([name, v]) => `${label(name)}'s ${ms(v)} ms`))}`;
}

/** A row of the view suite, by label. */
function viewRow(table, label) {
  const row = byLabel(data('view').tables[table] ?? [], label);
  if (row === undefined) throw new Error(`view.json's '${table}' table has no '${label}' row — regenerate it before quoting one`);
  return row.ns;
}

/** A row of the flow suite's compile table, rival over jaren, at every size. */
const flowCompileRatios = () => Object.values(data('flow').compile).map((rows) =>
  byLabel(rows, 'xstate createMachine+Actor').ns / byLabel(rows, 'jaren compileFsm').ns);

/** One contract.json table by the start of its title. */
function contractTable(prefix) {
  const t = data('contract').tables.find((x) => x.title.startsWith(prefix));
  if (t === undefined) throw new Error(`contract.json carries no '${prefix}' table — regenerate it before quoting one`);
  return t;
}

/** One of the contracts suite's first-calls tables, by the start of its title. */
function contractsFirstCalls() {
  const fc = data('contracts').firstCalls;
  if (fc === undefined || !Array.isArray(fc.tables) || fc.tables.length === 0) {
    throw new Error('contracts.json carries no firstCalls tables — regenerate it before quoting one');
  }
  return fc;
}

/**
 * Where Jaren stands against every rival column of one contracts table:
 * the rivals it beats in every scenario, those that beat it in every one,
 * and the split ones with the scenarios they take.
 * @param {any} t
 */
function standingAll(t) {
  const mine = t.columns.indexOf('@jarenjs/validate');
  if (mine === -1) throw new Error(`contracts.json '${t.title}' names no @jarenjs/validate column`);
  const ahead = [];
  const behind = [];
  const split = [];
  for (const rival of t.columns.filter((c, i) => i !== mine)) {
    const col = t.columns.indexOf(rival);
    const timed = t.rows.filter((r) => Number.isFinite(r.results[mine]) && Number.isFinite(r.results[col]));
    if (timed.length === 0) continue;
    const lost = timed.filter((r) => !(r.results[mine] < r.results[col]));
    if (lost.length === 0) ahead.push(rival);
    else if (lost.length === timed.length) behind.push(rival);
    else split.push({ rival, won: timed.length - lost.length, of: timed.length, lost: lost.map(scenarioOf) });
  }
  const parts = [];
  if (ahead.length > 0) parts.push(`faster than ${listOf(ahead)} in every scenario`);
  // split rivals that take the same scenarios read as one clause
  const groups = new Map();
  for (const s of split) {
    const key = `${s.won}/${s.of}/${s.lost.join(',')}`;
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  for (const group of groups.values()) {
    const [{ won, of, lost }] = group;
    const names = group.map((s) => s.rival);
    parts.push(`${parts.length === 0 ? 'faster ' : ''}than ${listOf(names)} in ${won} of ${of}, while `
      + `${names.length === 1 ? `${names[0]} is` : 'they are'} faster on the ${listOf(lost)} scenario${lost.length === 1 ? '' : 's'}`);
  }
  if (behind.length > 0) parts.push(`slower than ${listOf(behind)} in every scenario`);
  return parts.length < 2 ? parts.join('') : `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`;
}

//#endregion

const FACTS = {
  'db.changeflow': () => changeflowFigures(JSON.parse(readFileSync(join(ROOT, 'benchmark/changeflow-results.json'), 'utf8'))),
  'db.hosts': () => {
    const baseline = JSON.parse(readFileSync(join(ROOT, 'benchmark/store-hosts-baseline.json'), 'utf8'));
    const report = JSON.parse(readFileSync(join(ROOT, 'benchmark/store-hosts-results.json'), 'utf8'));
    const fixed = (n) => n.toFixed(2);
    const mib = (n) => fixed(n / 1048576);
    // the worker and pool hosts inside a Bun-compiled executable, from the
    // native executable harness (`check-adoption-journeys.js --native`)
    const compiledHosts = () => {
      const compiled = JSON.parse(readFileSync(join(ROOT, 'benchmark/adoption-hosts-result.json'), 'utf8')).workerHosts;
      const host = (name) => compiled.hosts.find((h) => h.host === name);
      const inThread = host('in-thread');
      const refused = compiled.withoutEndpoint.map((h) => `${h.host} ${h.refused.code} (retryable: ${h.refused.retryable})`).join(', ');
      return [
        `| Bun ${compiled.runtime} executable | Rows written | Rows streamed | Long read ms | Event-loop max ms |`,
        '|---|---:|---:|---:|---:|',
        ...compiled.hosts.map((h) => `| ${h.host} | ${h.written} | ${h.streamed} | ${fixed(h.longReadMs)} | ${fixed(h.eventLoopDelayMs.max)} |`),
        '',
        `Built with \`${compiled.recipe}\` and run with every source and module path removed; the long read is ${compiled.scans} whole-collection reads of ${compiled.rows + 1} rows. `
          + ['worker', 'pool'].map((name) => `The ${name} host held the event loop at most ${fixed(host(name).eventLoopDelayMs.max)} ms against the ${compiled.eventLoopBoundMs} ms bound and took ${fixed(host(name).longReadMs / inThread.longReadMs)}× as long as the in-thread binding, which held the loop ${fixed(inThread.eventLoopDelayMs.max)} ms.`).join(' ')
          + ` Built without the second entrypoint, the open refused: ${refused}.`
          + ` The side-effect import of \`@jarenjs/db/worker-endpoint\`, bundled alone, keeps the endpoint: ${compiled.sideEffectImportBytes.bun} bytes with Bun, ${compiled.sideEffectImportBytes.esbuild} with esbuild.`,
        '',
      ];
    };
    return '\n\n' + [
      `Measured ${report.measuredAt.slice(0, 10)}, ${report.runtime}, ${report.host.cpu}; ${report.samples} samples per latency/include case.`,
      '',
      '| Host | Open p50 ms | Slow SQL p50 ms | Event-loop max ms | Tiny reads/s | Mixed work ms | Wait p95 ms |',
      '|---|---:|---:|---:|---:|---:|---:|',
      ...report.hosts.map((h) => `| ${h.name} | ${fixed(h.startupMs.p50)} | ${fixed(h.statementMs.p50)} | ${fixed(h.eventLoopDelayMs.max)} | ${Math.round(h.tiny.operationsPerSecond)} | ${fixed(h.mixed.durationMs)} | ${fixed(h.mixed.metrics?.waitMs?.p95 ?? 0)} |`),
      '',
      '| Host | Cursor rows | Cursor ms | Sampled heap growth MiB | Sampled total RSS MiB |',
      '|---|---:|---:|---:|---:|',
      ...report.hosts.map((h) => `| ${h.name} | ${h.cursor.rows} | ${fixed(h.cursor.durationMs)} | ${mib(h.cursor.sampledHeapGrowthBytes)} | ${mib(h.cursor.sampledRssBytes)} |`),
      '',
      `| Store root admission (${report.storeRows} rows) | Reads | Mixed work p50 ms | Tiny root gets/s |`,
      '|---|---|---:|---:|',
      ...report.storeLevel.map((r) => `| ${r.host} | ${r.reads} | ${fixed(r.mixed.durationMs.p50)} | ${Math.round(r.tiny.operationsPerSecond)} |`),
      '',
      ...[...new Set(report.storeLevel.map((r) => r.host))].map((host) => {
        const of = (reads) => report.storeLevel.find((r) => r.host === host && r.reads === reads);
        const serialized = of('serialized');
        const parallel = of('parallel');
        const mixed = serialized.mixed.durationMs.p50 / parallel.mixed.durationMs.p50;
        const tiny = parallel.tiny.operationsPerSecond / serialized.tiny.operationsPerSecond;
        const times = (ratio) => (ratio >= 1 ? `${fixed(ratio)}× faster` : `${fixed(1 / ratio)}× slower`);
        const share = (ratio) => (ratio >= 1 ? `${fixed((ratio - 1) * 100)}% more` : `${fixed((1 - ratio) * 100)}% fewer`);
        return `On ${host}, \`reads: 'parallel'\` runs the Store-level mixed work ${times(mixed)} than the serialized default and answers ${share(tiny)} sequential tiny root gets per second.`;
      }),
      '',
      ...compiledHosts(),
      '| Include accounting | Encoded bytes | Time p50 ms | Uncollected heap growth p50 MiB |',
      '|---|---:|---:|---:|',
      ...report.includes.map((r) => `| ${r.method} | ${r.bytes} | ${fixed(r.durationMs.p50)} | ${mib(r.heapGrowthBytes.p50)} |`),
      '',
      `The worker event-loop acceptance bound is ${report.workerEventLoopMaxBoundMs} ms. The original in-process baseline measured p50/p95/max event-loop delay of ${fixed(baseline.eventLoopDelayMs.p50)}/${fixed(baseline.eventLoopDelayMs.p95)}/${fixed(baseline.eventLoopDelayMs.max)} ms, bare worker startup p50 ${fixed(baseline.workerStartupMs.p50)} ms, and duplicate include serialization ${fixed(baseline.include.durationMs)} ms with ${mib(baseline.include.heapDeltaBytes)} MiB uncollected heap growth. The current open measurement also includes driver probing; its startup cost is broader than that bare-worker baseline.`,
    ].join('\n') + '\n\n';
  },
  'db.browserHosts': () => {
    const report = JSON.parse(readFileSync(join(ROOT, 'benchmark/store-hosts-browser-results.json'), 'utf8'));
    return '\n\n' + [
      `${report.passed} storage scenarios passed without skips, measured ${report.measuredAt.slice(0, 10)}.`,
      '',
      '| Engine | Version | Isolated | Ordinary | OPFS denied | All storage denied / quota |',
      '|---|---|---|---|---|---|',
      ...['chromium', 'firefox', 'webkit'].map((engine) => {
        const rows = report.rows.filter((r) => r.engine === engine);
        const pick = (prefix) => rows.find((r) => r.scenario.startsWith(prefix));
        return `| ${engine} | ${rows[0].browserVersion} | ${pick('isolated').vfs} | ${pick('ordinary').vfs} | ${pick('IndexedDB').vfs} | ${pick('memory').vfs} (non-durable) |`;
      }),
      '',
      ...report.rows.filter((r) => r.isolated && r.fallback).map((r) => `${r.engine} isolated fallback: ${r.fallback}`),
    ].join('\n') + '\n\n';
  },

  // ——— when the quoted suites were actually measured. A README that
  // names a date is making a provenance claim; if the suites disagree
  // the range is printed rather than one flattering date.
  'benchmarks.measured': () => {
    const suites = ['validate', 'jsonpath', 'jsonquery', 'jslt'];
    const dates = [...new Set(suites.map((s) => {
      const d = data(s);
      const stamp = d.date ?? d.metadata?.timestamp;
      if (typeof stamp !== 'string') {
        throw new Error(`${s}.json carries no measurement date — regenerate it before quoting its numbers`);
      }
      return stamp.slice(0, 10);
    }))].sort();
    const nodes = [...new Set(suites
      .map((s) => data(s).node ?? data(s).metadata?.node)
      .filter(Boolean))];
    const when = dates.length === 1 ? dates[0] : `${dates[0]}–${dates[dates.length - 1]}`;
    return `${when} with Node ${nodes.length === 1 ? nodes[0] : nodes.join('/')}`;
  },

  // ——— @jarenjs/validate: the official suite, scored per engine over the
  // tests THAT engine ran. The rival's status is not consulted: a test Ajv
  // cannot compile is still a test Jaren passed or failed, and dropping
  // those from the count is how real `$dynamicRef` failures were published
  // as a clean sweep for months.
  'validate.conformance': () => {
    const stats = data('validate').summary.engineStats.jaren;
    const total = (pick) => Object.values(stats).reduce((n, draft) => n + pick(draft), 0);
    const passed = total((d) => d.passed);
    return `${passed} of ${passed + total((d) => d.failed) + total((d) => d.errors)}`;
  },
  // the success-only totals: the tests BOTH engines run and both pass, the
  // only rows where a timing comparison means anything
  'validate.vsAjv': () => {
    const o = data('validate').summary.overall;
    return ratio(o.ajvSuccessTime / o.jarenSuccessTime);
  },
  'validate.perTestWins': () => {
    const s = data('validate').summary.overall.successOnly;
    return `${s.jarenWins} of ${s.jarenWins + s.ajvWins + s.tied}`;
  },

  // ——— @jarenjs/validate: the per-draft table in the root README ———
  'validate.table': () => {
    const drafts = [['draft-07', 'draft7'], ['2019-09', 'draft2019-09'], ['2020-12', 'draft2020-12']];
    const rows = drafts.map(([label, key]) => {
      const b = data('validate').summary.byDraft[key];
      const jarenPassed = b.totalTests - b.jarenFailures - b.jarenErrors;
      const ajvPassed = b.totalTests - b.ajvFailures - b.ajvErrors;
      return `| ${label} | **${jarenPassed} passed, ${b.jarenFailures} failed, ${b.jarenErrors} errors** `
        + `| ${ajvPassed} passed, ${b.ajvFailures} failed, ${b.ajvErrors} error${b.ajvErrors === 1 ? '' : 's'} `
        + `| ${faster(b.jarenSuccessTime, b.ajvSuccessTime)} `
        + `| ${b.successOnly.jarenWins} of ${b.successTests} tests |`;
    });
    return ['', '| Draft | Jaren | Ajv | Success-only totals | Jaren faster on |',
      '|---|---|---|---|---|', ...rows, ''].join('\n');
  },

  // ——— the Zod migration guide: the contracts suite's adapter row
  // (normalize, validate and map issues on invalid input — the comparable
  // measurement) and the run that measured it. The fastest engine of each
  // scenario is bold, whoever it is: a guide that bolds its own column on
  // every row stops being true the release a rival gets faster.
  'contracts.adapter.table': () => {
    const t = data('contracts').tables.find((x) => x.title.startsWith('Normalize + validate'));
    if (t === undefined) throw new Error('contracts.json carries no adapter table — regenerate it before quoting one');
    const rows = t.rows.map((r) => {
      const best = Math.min(...r.results.filter(Number.isFinite));
      const cells = r.results.map((v) => (!Number.isFinite(v) ? '—' : v === best ? `**${us(v)} µs**` : `${us(v)} µs`));
      return `| ${r.name} | ${cells.join(' | ')} |`;
    });
    return ['', `| Scenario | ${t.columns.join(' | ')} |`, `|${' --- |'.repeat(t.columns.length + 1)}`, ...rows, ''].join('\n');
  },
  // where Jaren stands against each Zod flavor on that same row, scenario
  // by scenario: a guide that says "faster than every Zod flavor" stops
  // being true the release one of them wins a scenario, so the sentence is
  // derived with the table
  'contracts.adapter.vsZod': () => {
    const t = data('contracts').tables.find((x) => x.title.startsWith('Normalize + validate'));
    if (t === undefined) throw new Error('contracts.json carries no adapter table — regenerate it before quoting one');
    const mine = t.columns.indexOf('@jarenjs/validate');
    const flavors = t.columns.filter((c) => c.startsWith('zod'));
    if (mine === -1 || flavors.length === 0) throw new Error('contracts.json adapter table names no @jarenjs/validate or zod column');
    const scenario = (row) => row.name.split(' — ')[0];
    const list = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
    const ahead = [];
    const split = [];
    for (const flavor of flavors) {
      const col = t.columns.indexOf(flavor);
      const timed = t.rows.filter((r) => Number.isFinite(r.results[mine]) && Number.isFinite(r.results[col]));
      const lost = timed.filter((r) => !(r.results[mine] < r.results[col]));
      if (lost.length === 0) ahead.push(flavor);
      else split.push(`than ${flavor} in ${timed.length - lost.length} of ${timed.length}, while ${flavor} is faster on the ${list(lost.map(scenario))} scenario${lost.length === 1 ? '' : 's'}`);
    }
    const lead = ahead.length > 0 ? [`than ${list(ahead)} in every scenario`] : [];
    return `faster ${[...lead, ...split].join(', and ')}`;
  },
  // where Jaren stands against Ajv on the adapter row: the closures Jaren
  // compiles instead of generated source are the guide's stated price, so
  // where that price shows is read off the table, not written once
  'contracts.adapter.vsAjv': () => {
    const t = contractsTable('Normalize + validate');
    return standing(t, 'ajv');
  },
  // the compile table, rival by rival: which build a schema faster than
  // Jaren in every scenario, which slower, and where that splits
  'contracts.compile.versus': () => {
    const t = contractsTable('Compile');
    const mine = t.columns.indexOf('@jarenjs/validate');
    if (mine === -1) throw new Error('contracts.json compile table names no @jarenjs/validate column');
    const faster = [];
    const slower = [];
    const split = [];
    for (const rival of t.columns.filter((c, i) => i !== mine)) {
      const col = t.columns.indexOf(rival);
      const timed = t.rows.filter((r) => Number.isFinite(r.results[mine]) && Number.isFinite(r.results[col]));
      const wins = timed.filter((r) => r.results[col] < r.results[mine]);
      if (timed.length === 0) continue;
      if (wins.length === timed.length) faster.push(rival);
      else if (wins.length === 0) slower.push(rival);
      else split.push(`${rival} builds one faster on the ${listOf(wins.map(scenarioOf))} scenario${wins.length === 1 ? '' : 's'} and slower on the rest`);
    }
    const verb = (names) => (names.length === 1 ? 'builds' : 'build');
    const parts = [];
    if (faster.length > 0) parts.push(`${listOf(faster)} ${verb(faster)} a schema faster than Jaren in every scenario`);
    if (slower.length > 0) parts.push(`${listOf(slower)} ${verb(slower)} ${faster.length > 0 ? 'one' : 'a schema'} slower in every scenario`);
    return [...parts, ...split].join(', and ');
  },
  'contracts.measured': () => {
    const d = data('contracts');
    if (typeof d.date !== 'string') throw new Error('contracts.json carries no measurement date — regenerate it before quoting its numbers');
    const record = data('meta').measurement?.contracts;
    if (record?.method === 'settled')
      return `${d.date.slice(0, 10)} with Node ${d.node}, each engine in a process of its own and each figure the median of ${record.processes} processes`;
    return `${d.date.slice(0, 10)} with Node ${d.node}, ${thousands(d.iterations)} iterations`;
  },

  // ——— @jarenjs/contract: match and dispatch vs the routing stack.
  // Two rivals, named apart on purpose: `fastify inject` includes
  // Fastify's own request harness, and the harness-free column
  // (find-my-way + Ajv + fast-json-stringify, the pieces Fastify
  // composes) is FASTER than jaren's whole pipeline on every row —
  // that loss is a published fact, not a footnote.
  'contract.match.vs-fmw': () => {
    const t = data('contract').tables.find((x) => x.title.startsWith('Route match'));
    const row = t?.rows[0];
    const mine = row?.results[t.columns.indexOf('@jarenjs/contract')];
    const rival = row?.results[t.columns.indexOf('find-my-way')];
    if (!Number.isFinite(mine) || !Number.isFinite(rival)) {
      throw new Error('contract.json carries no match row — regenerate it before quoting one');
    }
    return `${ns(mine)} ns per lookup vs find-my-way's ${ns(rival)} ns`;
  },
  'contract.match.vs-hono': () => {
    const t = data('contract').tables.find((x) => x.title.startsWith('Route match'));
    const row = t?.rows[0];
    const mine = row?.results[t.columns.indexOf('@jarenjs/contract')];
    const rival = row?.results[t.columns.indexOf('hono TrieRouter')];
    if (!Number.isFinite(mine) || !Number.isFinite(rival)) {
      throw new Error('contract.json carries no hono match cell — regenerate it before quoting one');
    }
    return `${ratio(rival / mine)}x`;
  },
  'contract.dispatch.vs-fastify': () => `${contractDispatchBand('fastify inject')}x`,
  'contract.dispatch.losses': () => `${contractDispatchBand('find-my-way + Ajv + fjs', true)}x`,
  // what the always-on response validation costs, on the heaviest row —
  // the same pipeline with validateOutput:'never', differenced
  'contract.validateOutput.share': () => {
    const t = data('contract').tables.find((x) => x.title.startsWith('Dispatch, in-process'));
    const row = t?.rows[0];
    const mine = row?.results[t.columns.indexOf('@jarenjs/contract')];
    const off = row?.results[t.columns.indexOf("@jarenjs/contract (validateOutput: 'never')")];
    if (!Number.isFinite(mine) || !Number.isFinite(off)) {
      throw new Error('contract.json carries no validateOutput column — regenerate it before quoting the share');
    }
    return `${(((mine - off) / mine) * 100).toFixed(0)}%`;
  },
  'contract.revision.ms': () => {
    const t = data('contract').tables.find((x) => x.title.startsWith('Revision'));
    const value = t?.rows[0]?.results[0];
    if (!Number.isFinite(value)) throw new Error('contract.json carries no revision row — regenerate it before quoting one');
    return `${ms(value / 1e6)} ms`;
  },
  // the share of a jaren request that is JSON.stringify of the response —
  // the number that scheduled (or, measured under 25%, dropped) the
  // schema-driven serializer
  'contract.serialization.share': () => {
    const rows = data('contract').serialization;
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new Error('contract.json carries no serialization block — regenerate it before quoting the share');
    }
    const worst = rows.reduce((a, b) => (b.share > a.share ? b : a));
    return `${(worst.share * 100).toFixed(1)}%`;
  },

  // ——— @jarenjs/json: JSONPath compliance-suite profile. The ratio and
  // the two timings beside it come from ONE summary over one row set, and
  // that summary is the same builder the website's overview headline
  // reads — the alternative, a second formula here, is how these 456 rows
  // came to be published as 23.1x in this file and 8.8x on the site.
  'jsonpath.ctsRatio': () => ratio(cts().ratio),
  'jsonpath.ctsTimes': () => `${ns(cts().mine)} ns vs ${us(cts().rival)} µs`,
  // the compliance score itself, per engine over the same corpus. "all
  // 703" is a claim about a total AND about a failure count, so it is
  // derived from both: a single failing case turns the phrase into
  // `702 of 703` rather than leaving a sweep in the prose.
  'jsonpath.ctsPass': () => ctsCompliance('jaren'),
  'jsonpath.ctsRival': () => ctsCompliance('json-p3'),

  // ——— @jarenjs/json: the QT3 scorecard, read from the committed baseline
  // the runner ratchets (its summary is set from a fresh run; every
  // attributed failure is one `deviation` entry) ———
  'qt3.pass': () => thousands(qt3Baseline().summary.pass),
  'qt3.unsupported': () => thousands(qt3Baseline().summary['unsupported-syntax']),
  'qt3.attributed': () => thousands(Object.values(qt3Baseline().tests)
    .filter((/** @type {any} */ t) => t.status === 'deviation').length),

  // ——— the census: what the repository publishes, counted once ———
  'packages.count': () => String(census().packages.length),
  'json.engines': () => String(workspace('@jarenjs/json').engines.length),
  'json.suites': () => String(new Set(workspace('@jarenjs/json').engines
    .map((/** @type {any} */ e) => e.suite).filter((/** @type {any} */ s) => s !== null)).size),

  // ——— @jarenjs/json: query compile cost ———
  'jsonquery.compile': () => {
    const c = data('jsonquery').compile.results;
    return `${Math.round(c.jaren / 1000)} µs — ${ratio(c.fontoxpath / c.jaren)}x faster than fontoxpath, `
      + `${ratio(c.jsonata / c.jaren)}x faster than jsonata`;
  },

  // ——— @jarenjs/md: parse profile and the peer bands ———
  'md.parseTimes': () => {
    const [small, mid, big] = data('markdown').profile.jaren;
    return `~${ms(small.parseMs)} ms for a typical ~2 kB document, ~${ms(mid.parseMs)} ms for ~10 kB, `
      + `~${ms(big.parseMs)} ms for ~100 kB`;
  },
  'md.vsPeers': () => {
    const ratios = data('markdown').profile.render.flatMap((row) =>
      ['marked', 'markdown-it'].map((peer) => row.results['jaren-md'] / row.results[peer]));
    return band(ratios, ratio);
  },
  // The honesty rule in one derivation: a band like `0.6–1.1x` contains a
  // LOSS at its top end and reads like a win. This names every row where
  // a rival is ahead — or says there are none — so the sentence cannot
  // quietly stop being true when a number moves.
  'md.vsPeersDetail': () => {
    const rows = data('markdown').profile.render;
    const losses = [];
    for (const row of rows) {
      for (const peer of ['marked', 'markdown-it']) {
        const r = row.results['jaren-md'] / row.results[peer];
        if (r > 1) losses.push(`\`${peer}\` is ahead at ${row.name} (${ratio(r)}x)`);
      }
    }
    return losses.length === 0
      ? 'faster than both at every size measured'
      : `faster than both at every size measured except one — ${losses.join('; ')}`;
  },
  'md.vsMicromark': () => {
    const ratios = data('markdown').profile.render.map((row) => row.results.micromark / row.results['jaren-md']);
    return band(ratios, ratio);
  },
  'md.cachedNs': () => band(data('markdown').profile.jaren.map((r) => r.vnodeNs), ns),
  // The phase split at the largest size — where the time actually goes,
  // so nobody has to rediscover it from a profile.
  'md.phaseSplit': () => {
    const p = phases();
    const pct = (ms) => `${Math.round((100 * ms) / p.whole)}%`;
    return `parse ${pct(p.parse)}, AST→vnode ${pct(p.project)}, vnode→HTML ${pct(p.serialize)}`;
  },
  'md.keyCost': () => {
    const p = phases();
    return `${Math.round((100 * (p.project - p.projectUnkeyed)) / p.project)}%`;
  },
  'md.unkeyedMs': () => {
    const p = phases();
    return `${ms(p.projectUnkeyed)} ms against ${ms(p.project)} ms`;
  },
  // Both emitters are scored, and both numbers are published (the
  // difference between them is the safety boundary, not a rounding
  // error). Each fact prints `pass of total (pct%)`.
  'md.measured': () => {
    const d = data('markdown');
    return `${String(d.date).slice(0, 10)}, Node ${d.node}`;
  },
  'md.scorecard': () => scorecardFigure('markdown', 'jaren-md'),
  'md.scorecardVnode': () => scorecardFigure('markdown', 'jaren-md (vnode)'),
  'md.scorecardPeers': () => {
    const s = data('markdown').scorecard;
    return ['marked', 'markdown-it', 'micromark']
      .filter((peer) => s[peer] !== undefined)
      .map((peer) => `${peer} ${s[peer].pass}`)
      .join(', ');
  },
  // The GFM extension corpus, scored with every engine's extensions on.
  // The CommonMark spec says nothing about tables, task lists,
  // strikethrough, autolink literals or disallowed raw HTML — this is
  // the only place those five are measured against a reference.
  'md.gfmScorecard': () => gfmFigure('jaren-md'),
  'md.gfmScorecardVnode': () => gfmFigure('jaren-md (vnode)'),
  'md.gfmPeers': () => {
    const gfm = gfmData();
    return ['marked', 'markdown-it', 'micromark']
      .filter((peer) => gfm.scorecard[peer] !== undefined)
      .map((peer) => `${peer} ${gfm.scorecard[peer].pass}`)
      .join(', ');
  },
  'md.gfmAutolinks': () => {
    const gfm = gfmData();
    const section = 'Autolinks (extension)';
    return `${gfm.scorecard['jaren-md'].sections[section]} of ${gfm.totals[section]}`;
  },

  // ——— @jarenjs/mermaid: render cost at two sizes ———
  'mermaid.svgMs': () => {
    const rows = data('mermaid').profile.jaren;
    const at = (name) => rows.find((r) => r.name === name).svgMs;
    return `~${ms(at('flowchart ~25 nodes'))} ms for a 25-node flowchart, ~${ms(at('flowchart ~100 nodes'))} ms at 100 nodes`;
  },

  // ——— @jarenjs/mermaid: the gantt timeline at scale ———
  'mermaid.ganttScale': () => {
    const rows = data('mermaid').profile.gantt;
    const row = rows.find((r) => r.tasks === 10000) ?? rows[rows.length - 1];
    return `at ${row.tasks.toLocaleString('en-US')} tasks, ~${ms(row.parseMs)} ms to parse and`
      + ` resolve, ~${ms(row.layoutMs)} ms to lay out and ~${ms(row.vnodeMs - row.layoutMs)} ms`
      + ' to render';
  },

  // ——— @jarenjs/flow: the pure step against XState's actor ———
  'flow.fsmBand': () => {
    const t = data('flow').transition;
    const ratios = Object.keys(t).map((size) =>
      byLabel(t[size], 'xstate actor.send').ns / byLabel(t[size], 'jaren step (pure)').ns);
    return band(ratios, ratio);
  },

  // ——— @jarenjs/view: the tagged-array builder against the frameworks ———
  'view.vsReact': () => {
    const b = data('view').tables.build;
    return ratio(byLabel(b, 'react createElement()').ns / byLabel(b, 'jaren hand-written []').ns);
  },
  'view.vsPreact': () => {
    const b = data('view').tables.build;
    return ratio(byLabel(b, 'preact h()').ns / byLabel(b, 'jaren hand-written []').ns);
  },
  'view.engineCost': () => {
    const b = data('view').tables.build;
    return ratio(byLabel(b, 'jaren jslt (no memo)').ns / byLabel(b, 'jaren hand-written []').ns);
  },

  // ——— @jarenjs/josl: the CSV reader table. Jaren's name is bold as the
  // subject; the FASTEST cell in each timing column is bold as the
  // winner, which is often not us — the table has to keep saying so.
  'csv.table': () => {
    const csv = data('csv');
    const engines = ['jaren', 'udsv', 'papaparse', 'csv-parse', 'd3-dsv', '@vanillaes/csv'];
    const best = csv.profile.rows.map((r) =>
      Math.min(...engines.map((e) => r.results[e]).filter((v) => typeof v === 'number')));
    const rows = engines.map((e) => {
      const spectrum = csv.spectrum[e];
      const score = spectrum === undefined ? 'n/a' : `${spectrum.pass}/${spectrum.total}`;
      const cells = csv.profile.rows.map((r, i) => {
        const cell = `${ms1(r.results[e])} ms`;
        return r.results[e] === best[i] ? `**${cell}**` : cell;
      });
      const name = e === 'jaren' ? '**jaren**' : e;
      const scoreCell = e === 'jaren' && spectrum !== undefined ? `**${score}**` : score;
      return `| ${name} | ${scoreCell} | ${cells.join(' | ')} |`;
    });
    return ['', '| engine | csv-spectrum | 10k×6 plain | 10k×3 quoted | 1k×50 wide |',
      '| --- | --- | --- | --- | --- |', ...rows, ''].join('\n');
  },

  // -- geo: the kernel suite. Every row of the committed table, the
  // WKT rows beside it, and the LOSSES as a derived sentence — so the
  // prose that says which rows lose can never outlive the numbers.
  'geo.node': () => data('geo').node,
  'geo.table': () => geoTable((row) => !row.name.startsWith('wkt ')),
  'geo.wktTable': () => geoTable((row) => row.name.startsWith('wkt ')),
  // -- orm: the phase-B head-to-head, and the price of the front door.
  // Three facts, all derived from orm.json's own rows: what the typed
  // client beats, what beats it, and what the door itself costs over the
  // store it fronts. Quoting only the first would be the same dishonesty
  // a dropped row is (report the loss).
  'orm.clientVsRivals': () => {
    const rows = ormClientRows();
    const beaten = ['Prisma', 'Drizzle', 'Kysely']
      .map((rival) => `${rows.filter((row) => row.beats.includes(rival)).length} of `
        + `${rows.filter((row) => row.met.includes(rival)).length} against ${rival}`);
    return beaten.join(', ');
  },
  'orm.clientLosses': () => {
    const losses = ormClientRows().filter((row) => row.ratio > 1)
      .sort((a, b) => b.ratio - a.ratio);
    if (losses.length === 0) return 'no row loses to a rival';
    return losses.map((row) => `${row.label} ${ratio(row.ratio)}× (${row.rival})`).join(', ');
  },
  'orm.clientDoorPrice': () => {
    const point = ormRow('Point read by primary key', 'jaren client (@jarenjs/linq/db)')
      / ormRow('Point read by primary key', 'jaren (@jarenjs/db)');
    const predicate = ormRow('Indexed predicate over 500 users',
      'jaren client (@jarenjs/linq/db) — 10%')
      / ormRow('Indexed predicate over 500 users', 'jaren — 10% (age >= 81)');
    const graph = ormRow('Graph load', 'jaren client (@jarenjs/linq/db) — 1 statement(s)')
      / ormRow('Graph load', 'jaren (@jarenjs/db) — 1 statement (asserted by test)');
    return `${ratio(point)}× on a point read, ${ratio(predicate)}× on an indexed predicate at `
      + `10 % selectivity, ${ratio(graph)}× on the two-level graph load`;
  },
  // -- the pens: build cost per DEFINITION, never per request
  'linq.penBuildCost': () => {
    const table = data('db').tables.find((t) => t.title.startsWith('By code: what one DEFINITION'));
    const at = (name) => table.rows.find((row) => row.name === name).results[0];
    const hand = at('  the same document, hand-written');
    const each = [['schema', 'schema pen — one object, 3 members'], ['model', 'model pen — one entity'],
      ['JSLT', 'JSLT pen — one rule']]
      .map(([name, row]) => `${name} ${ratio(at(row) / hand)}×`);
    const migration = at('migration pen — two models, no step')
      / at('  the same document, hand-written (exact endpoints and fingerprints included)');
    return `${each.join(', ')} a hand-written literal, and the migration pen `
      + `${ratio(migration)}× a hand-written document carrying the same exact endpoints and compatibility fingerprints`;
  },
  'geo.losses': () => {
    const losses = data('geo').rows.filter((row) => row.rival !== null && row.rival / row.ours < 1);
    if (losses.length === 0) return 'no row loses to its rival';
    const word = ['no', 'one', 'two', 'three', 'four', 'five', 'six'][losses.length] ?? String(losses.length);
    const list = losses.map((row) => `${row.name} at ${ratio(row.rival / row.ours)}× (${row.rivalName})`);
    return `${word} row${losses.length === 1 ? ' loses' : 's lose'} to a rival: ${list.join(', ')}`;
  },
  // -- series: the temporal kernel against the ground published before
  // it existed. Two ratios per row on purpose — what the kernel costs
  // against a loop written for one question, and what it saves against
  // the vocabulary a consumer had instead — because quoting only the
  // second would be a win with its price left out.
  'series.kernelVsCeiling': () => {
    const { figures } = data('series').meta;
    return `${ratio(figures.kernelBucketVsOnePass)}× the one-pass bucket loop and `
      + `${ratio(figures.kernelRollingVsOnePass)}× the one-pass ring sum`;
  },
  'series.kernelVsQuery': () => {
    const { figures } = data('series').meta;
    return `${ratio(figures.kernelBucketVsQuery)}× faster than the generic query bucket and `
      + `${ratio(figures.kernelRollingVsQuery)}× faster than the labelled count window`;
  },
  'series.corpus': () => {
    const { meta } = data('series');
    const leg = seriesLargest();
    return `${leg.label} at ${meta.stepMs / 1000}-second spacing, Node ${meta.node}`;
  },
  'series.kernelTable': () => {
    const rows = [
      ['`resampleSeries`, 60 s buckets', 'kernelBucket', 'bucket', 'one-pass loop'],
      ['`resampleSeries`, + linear fill', 'kernelFill', 'kernelSparse', 'the same buckets, omitting'],
      ['`rollingSeries`, 60 s window', 'kernelRolling', 'rolling', 'one-pass ring sum'],
      ['`asOfJoin`, one left row per 100', 'kernelAsOfDense', 'sqlAsOfDense', 'one index read per row'],
      ['`downsampleSeries`, lttb, gap corpus', 'kernelRenderGaps', 'kernelRender', 'the same line with no holes in it'],
    ].map(([name, route, against, what]) => {
      const ours = seriesMs(route);
      const theirs = seriesMs(against);
      return `| ${name} | ${ms(ours)} ms | ${thousands(seriesRows(route))} | ${ms(theirs)} ms `
        + `| ${what} | ${ratio(ours / theirs)}× |`;
    });
    return ['', '| operation | median | rows | against | what that is | ratio |',
      '|---|---:|---:|---:|---|---:|', ...rows, ''].join('\n');
  },
  'series.asofShape': () => {
    const { figures } = data('series').meta;
    // the dense shape is published whichever way it fell: a win is
    // stated as one, and a loss as one, never a floor at parity
    const dense = figures.kernelAsOfDenseVsStored;
    const denseClause = dense < 1
      ? `and beats them by ${ratio(1 / dense)}× once there is one left row per hundred right ones`
      : `and narrows to ${ratio(dense)}× the same join once there is one left row per hundred `
        + 'right ones — still the statement\'s win, published as one';
    return `The as-of join costs ${ratio(figures.kernelAsOfVsStored)}× a handful of index reads, `
      + `${denseClause}. The reason is the shape rather than the engine: a b-tree pays `
      + 'per probe, and a sorted walk pays for the whole right side whether it was asked one '
      + 'question or a thousand.';
  },
  // -- series: the STORE's own rows, against the statement a hand would
  // have written, against the vocabulary the store replaces, and
  // against the array already in memory. Three ratios per shape,
  // because quoting only the flattering one is the thing honesty forbids.
  'series.storeShapes': () => {
    const { figures, plans } = data('series').meta;
    // the bucket is called pushed only when the planner reported it native,
    // and its comparison with the generic route is stated in the direction
    // it was measured
    const pushed = plans.find((entry) => entry.key === 'storeBucket').plan.startsWith('native:');
    const query = figures.storeBucketVsQuery;
    return `the planned range costs ${ratio(figures.storeRangeVsSql)}× the hand-written `
      + `statement and ${ratio(figures.storeRangeVsResident)}× the resident cut, and the `
      + `${pushed ? 'pushed bucket ladder' : 'index-bounded bucket (its mean added in the engine)'} `
      + `${ratio(figures.storeBucketVsSql)}× the hand-written GROUP BY, `
      + `${query >= 1 ? `${ratio(query)}× FASTER` : `${ratio(1 / query)}× SLOWER`} `
      + `than the generic query route, and ${ratio(figures.storeBucketVsResident)}× the one-pass loop`;
  },
  'series.storeRefinement': () => {
    const { figures } = data('series').meta;
    const statements = figures.storeAsOfStatements;
    return `A window measured in time is not pushed: the store answers it at `
      + `${ratio(figures.storeRollingVsResident)}× the kernel over an array already in memory, `
      + `over ${thousands(figures.storeRollingCandidates)} candidates the index bounded. The `
      + `batched as-of join reads ${thousands(figures.storeAsOfCandidates)} rows in `
      + `${statements} statement${statements === 1 ? '' : 's'} and costs `
      + `${ratio(figures.storeAsOfVsIndexReads)}× fifty-one separate index reads — a bound is `
      + 'what it buys, not a speed-up. Without a tolerance the open side has no bound the probes '
      + "imply, so the plan reads the data's own: the last instant each series carries at or "
      + 'before the earliest probe, folded to the least of them. That anchor is the extra '
      + 'statement, and what it saves depends on where the probes sit — evenly spread ones, as '
      + 'here, leave the least below them to skip.';
  },
  'series.zoneCost': () => {
    const { figures } = data('series').meta;
    return `Walking every boundary through the shipped Intl zone provider costs `
      + `${ratio(figures.providerCost)}× the integer ladder over an identical answer — a handful `
      + 'of ICU reads against the whole ladder, since the benchmark corpus spans 28 hours and '
      + 'holds two daily boundaries. What the suite gates is that the provider is consulted per '
      + 'boundary rather than per sample.';
  },
  // -- series: the engine's interval join, the nested loop against the
  // interval index that replaced it, at every side the suite measured -
  // the ratio as measured, whichever way it falls
  'series.intervalJoinTable': () => {
    const rows = seriesJoinSides().map((n) => {
      const loop = seriesJoinRow('joinNestedLoop', n);
      const probe = seriesJoinRow('joinIntervalProbe', n);
      return `| ${thousands(n)} × ${thousands(n)} | ${thousands(probe.results)} | ${ms(loop.ns / 1e6)} ms `
        + `| ${ms(probe.ns / 1e6)} ms | ${ratio(loop.ns / probe.ns)}× |`;
    });
    return ['', '| spans a side | pairs | nested loop | interval index | nested loop ÷ index |',
      '|---|---:|---:|---:|---:|', ...rows, ''].join('\n');
  },
  // -- series: the stored span, the mapped pre-filter against the declared
  // interval at three days of the year - the late-window loss published
  // beside the wins, as measured, and the bounded duration's cure beside it
  'series.spanTable': () => {
    const rows = seriesSpanDays().map((day) => {
      const prefilter = seriesSpanRow('spanPrefilter', day);
      const declared = seriesSpanRow('spanDeclared', day);
      const bounded = seriesSpanRow('spanBounded', day);
      return `| day ${day} | ${thousands(declared.results)} | ${ms(prefilter.ns / 1e6)} ms `
        + `| ${ms(declared.ns / 1e6)} ms | ${spanVerdict(prefilter.ns / declared.ns)} `
        + `| ${ms(bounded.ns / 1e6)} ms | ${spanVerdict(prefilter.ns / bounded.ns)} |`;
    });
    return ['', '| window | spans met | mapped pre-filter (scan) | declared interval (seek) | the declaration is '
      + '| with `maxDuration` (two-sided seek) | the bound is |',
    '|---|---:|---:|---:|---|---:|---|', ...rows, ''].join('\n');
  },
  'series.spanVerdict': () => {
    const windows = seriesSpanDays().map((day) =>
      `${spanVerdict(seriesSpanRow('spanPrefilter', day).ns / seriesSpanRow('spanDeclared', day).ns)} at day ${day}`);
    return `${windows.slice(0, -1).join(', ')} and ${windows[windows.length - 1]}`;
  },
  'series.spanBoundedVerdict': () => {
    const windows = seriesSpanDays().map((day) =>
      `${spanVerdict(seriesSpanRow('spanPrefilter', day).ns / seriesSpanRow('spanBounded', day).ns)} at day ${day}`);
    return `${windows.slice(0, -1).join(', ')} and ${windows[windows.length - 1]}`;
  },

  'geo.pip2000': () => `${ratio(geoRatio('point in polygon (2000-vertex)'))}×`,
  'geo.bbox2000': () => `${ratio(geoRatio('bounding box (2000-vertex)'))}×`,
  'geo.indexBuild': () => `${ratio(geoRatio('index build (100k boxes)'))}×`,
  'geo.wktParsePoint': () => `${ratio(geoRatio('wkt parse (POINT)'))}×`,
  'geo.wktValidatePoint': () => `${ratio(geoRatio('wkt validate (POINT)'))}×`,

  // -- spatial: the storage suite. Every figure is a named row of the
  // committed table or one of the ratios the tool itself derives, so a
  // verdict in prose ("the hatch does not pay") can never outlive the
  // number it was drawn from.
  'spatial.corpus': () => {
    const { meta } = data('spatial');
    return `${meta.docs.toLocaleString('en-US')} points`;
  },
  'spatial.rows': () => {
    const { meta } = data('spatial');
    const row = spatialRow('within-indexed');
    return `${row.rows} of ${meta.docs.toLocaleString('en-US')} (${(100 * row.rows / meta.docs).toFixed(1)} %)`;
  },
  'spatial.within': () => `${ms(spatialMs('within-indexed'))} ms`,
  'spatial.scan': () => `${ms(spatialMs('within-scan'))} ms`,
  'spatial.engine': () => `${ms(spatialMs('engine'))} ms`,
  'spatial.scanVsIndexed': () => ratio(data('spatial').meta.figures.scanVsIndexed),
  'spatial.engineVsIndexed': () => {
    const x = data('spatial').meta.figures.engineVsIndexed;
    return x >= 1 ? `${ratio(x)}× faster than` : `${ratio(1 / x)}× slower than`;
  },
  'spatial.bboxIntersects': () => `${ms(spatialMs('bbox-intersects'))} ms`,
  'spatial.distance': () => `${ms(spatialMs('distance'))} ms`,
  'spatial.cellOne': () => `${ms(spatialMs('cell-one'))} ms for ${spatialRow('cell-one').rows} row(s)`,
  'spatial.cellNine': () => `${ms(spatialMs('cell-nine'))} ms for ${spatialRow('cell-nine').rows} row(s)`,
  'spatial.udfTable': () => {
    // the three shapes MODEL-FORMAT's UDF profile publishes, for $within
    const line = (label, pushed, residual, figure) =>
      `| ${label} | ${ms(spatialMs(pushed))} | ${ms(spatialMs(residual))} | ${verdict(figure)} |`;
    const table = [
      '| shape | pushed (ms) | residual (ms) | verdict |',
      '|---|---|---|---|',
      line('solo `$within` over a full scan', 'within-udf', 'within-scan', 'udfSolo'),
      line('indexed `$eq` **and** `$within` (~5 % pass the index)', 'within-udf-selective', 'within-residual-selective', 'udfSelective'),
      line('`$within` with `LIMIT 10`', 'within-udf-limit', 'within-residual-limit', 'udfLimit'),
    ].join('\n');
    return `\n${table}\n`;
  },
  'spatial.udfVerdict': () => {
    const { udfSelective, udfLimit } = data('spatial').meta.figures;
    const wins = Math.max(udfSelective, udfLimit) >= 1.5;
    return wins
      ? `earns its row: ${ratio(udfSelective)}× beside the selective conjunct and ${ratio(udfLimit)}× under the LIMIT`
      : `does not earn a row: ${ratio(udfSelective)}× beside the selective conjunct and ${ratio(udfLimit)}× under the LIMIT, both under the 1.5× bar`;
  },
  // `R\*Tree` is escaped because these three facts are quoted INLINE and
  // more than one of them can share a paragraph: two bare asterisks in
  // one paragraph pair into emphasis, which moves the closing marker
  // into an emphasis node and breaks the directive the gate reads
  'spatial.rtree': () => {
    const { rtreeVsGenerated } = data('spatial').meta.figures;
    return `${ms(spatialMs('rtree-raw'))} ms against ${ms(spatialMs('generated-raw'))} ms — `
      + (rtreeVsGenerated >= 1 ? `${ratio(rtreeVsGenerated)}× in the R\\*Tree's favour` : `${ratio(1 / rtreeVsGenerated)}× in the B-tree's favour`);
  },
  // the same question through the STORE — what a consumer actually gets,
  // JSON parsing, refinement and statement overhead included
  'spatial.rtreeStore': () => {
    const { storeRtreeVsColumns } = data('spatial').meta.figures;
    return `${ms(spatialMs('within-rtree'))} ms against ${ms(spatialMs('within-indexed'))} ms — `
      + (storeRtreeVsColumns >= 1
        ? `${ratio(storeRtreeVsColumns)}× in the R\\*Tree's favour`
        : `${ratio(1 / storeRtreeVsColumns)}× in the columns' favour`);
  },
  // and the other half of it, which belongs beside the read
  'spatial.rtreeLoad': () => {
    const { rtreeLoadCost } = data('spatial').meta.figures;
    return `${ms(spatialMs('load-rtree'))} ms against ${ms(spatialMs('load-columns'))} ms for `
      + `${data('spatial').meta.docs.toLocaleString('en-US')} documents in one transaction — `
      + (rtreeLoadCost >= 1
        ? `${ratio(rtreeLoadCost)}× the write cost`
        : `${ratio(1 / rtreeLoadCost)}× cheaper`);
  },

  // -- vector: k-nearest over a stored column. Every figure names the
  // leg it was measured at, because the suite is a grid and a timing
  // without its (n x d) coordinates is whichever row sorted last.
  'vector.grid': () => {
    const { meta } = data('vector');
    const sizes = [...new Set(meta.legs.map((/** @type {any} */ leg) => leg.n))];
    const dims = [...new Set(meta.legs.map((/** @type {any} */ leg) => leg.dims))];
    return `${sizes.map(thousands).join(' and ')} vectors at ${dims.join(' and ')} dimensions,`
      + ` k = ${meta.k}, the median of ${meta.probes} probes`;
  },
  'vector.plan': () => `${ms(vectorMs('plan'))} ms at ${largestLeg()}`,
  'vector.resident': () => `${ms(vectorMs('resident'))} ms, which the plan is `
    + `${ratio(data('vector').meta.figures.planVsResident)}× slower than`,
  'vector.jsonDoc': () => {
    const { figures } = data('vector').meta;
    if (figures.jsonDocVsPlan === null) return 'not measured at any size in this run';
    return `${ratio(figures.jsonDocVsPlan)}× the plan at ${figures.jsonDocLeg}`;
  },
  'vector.udf': () => {
    const { figures } = data('vector').meta;
    const verdict = figures.udfVsFetchLow >= 1.1 ? 'a loss'
      : figures.udfVsFetchHigh <= 0.9 ? 'a win' : 'rough parity';
    return `${ms(vectorMs('udf'))} ms against ${ms(vectorMs('fetch'))} ms at ${largestLeg()}, and `
      + `${figures.udfVsFetchLow.toFixed(2)}–${figures.udfVsFetchHigh.toFixed(2)}× the fetch-and-rank`
      + ` across the grid — ${verdict} on speed`;
  },
  'vector.write': () => {
    const { figures } = data('vector').meta;
    const leg = data('vector').meta.legs[data('vector').meta.legs.length - 1];
    // a load is seconds where a query is milliseconds, and `10609 ms`
    // is a number a reader has to divide before it means anything
    const wall = (x) => (x >= 1000 ? `${(x / 1000).toFixed(1)} s` : `${ms(x)} ms`);
    return `${wall(vectorMs('load-indexed'))} against ${wall(vectorMs('load-plain'))} for `
      + `${thousands(leg.n)} documents in one transaction — ${ratio(figures.loadCost)}× the write cost`;
  },
  'vector.storage': () => {
    const { storage } = data('vector');
    const last = storage[storage.length - 1];
    return `${thousands(last.packedBytes)} B packed against ${thousands(last.jsonBytes)} B as a JSON`
      + ` number array inside the document — ${ratio(data('vector').meta.figures.packedVsJson)}× smaller`;
  },
  'vector.rival': () => {
    const { meta } = data('vector');
    if (meta.rival.unavailable !== undefined)
      return `not measured: sqlite-vec did not load on the measuring host (${meta.rival.unavailable})`;
    const { rivalVsPlan, rivalStorage } = meta.figures;
    return `${ms(vectorMs('rival'))} ms against ${ms(vectorMs('plan'))} ms at ${largestLeg()} — `
      + (rivalVsPlan >= 1 ? `${ratio(rivalVsPlan)}× in sqlite-vec's favour` : `${ratio(1 / rivalVsPlan)}× in the plan's favour`)
      + `, out of a database ${ratio(rivalStorage)}× smaller that holds no documents`;
  },
  'vector.agreement': () => {
    const { meta } = data('vector');
    const probes = meta.probes * meta.legs.length;
    const same = meta.classes.find((/** @type {any} */ c) => c.key === 'same')?.count ?? 0;
    const off = probes - same;
    return `${probes} probes, ${off === 0 ? 'no disagreements' : `${off} disagreement(s), each classed and pinned`}`;
  },
  'vector.ceiling': () => {
    const { figures } = data('vector').meta;
    if (figures.planNsPerComponent === null) return 'not derivable from a single-leg run';
    return `${figures.planNsPerComponent} ns per vector component — one query reaches 100 ms at about`
      + ` ${thousands(figures.ceiling100msAt768)} vectors of 768 dimensions and one second at about`
      + ` ${thousands(figures.ceiling1sAt768)}`;
  },
  'vector.table': () => {
    const { meta } = data('vector');
    const legs = meta.legs;
    const paths = [
      ['resident', 'engine resident sweep (no database)'],
      ['plan', "the k-nearest plan (the store's own)"],
      ['fetch', "raw fetch + engine sweep (the plan's statement)"],
      ['udf', '`ORDER BY` over a registered function'],
      ['jsonDoc', 'JSON-doc sweep (no vector column)'],
      ['rival', 'sqlite-vec'],
    ];
    const cell = (path, leg) => {
      const row = data('vector').rows.find((/** @type {any} */ r) =>
        r.path === path && r.n === leg.n && r.dims === leg.dims);
      return row === undefined ? '—' : `${ms(row.ns / 1e6)}`;
    };
    const lines = [
      `| path (ms) | ${legs.map((/** @type {any} */ l) => l.label).join(' | ')} |`,
      `|---|${legs.map(() => '---:').join('|')}|`,
      ...paths.map(([key, name]) =>
        `| ${key === 'plan' ? `**${name}**` : name} | ${legs.map((/** @type {any} */ l) => cell(key, l)).join(' | ')} |`),
    ];
    return `\n${lines.join('\n')}\n`;
  },

  // ————— charts: what a big static time line draws —————

  /** The static-line sampling table: source vs rendered, AST vs svg.
   * The AST column is a small LOSS and stays in the table for that
   * reason — sampling buys the render, not the mapping. */
  'charts.samplingTable': () => {
    const rows = data('charts').sampling ?? [];
    const lines = [
      '| source points | drawn | method | source → AST | source → svg |',
      '|---:|---:|---|---:|---:|',
      ...rows.map((/** @type {any} */ r) => `| ${r.sourceCount.toLocaleString('en-US')} `
        + `| ${r.renderedCount.toLocaleString('en-US')} | ${r.method} `
        + `| ${dur(r.wholeNs)} → ${dur(r.sampledNs)} `
        + `| ${dur(r.wholeSvgNs)} → ${dur(r.sampledSvgNs)} |`),
    ];
    return `\n${lines.join('\n')}\n`;
  },
  /** The session-vs-wholesale table: the three unsampled rows carry the
   * flatness claim, and the sampled row beside them carries its price. */
  'charts.sessionTable': () => {
    const rows = data('charts').scaling ?? [];
    const lines = [
      '| points × series | session tick | wholesale tick | frames incremental |',
      '|---|---:|---:|---:|',
      ...rows.map((/** @type {any} */ r) =>
        `| ${r.points.toLocaleString('en-US')} × ${r.series}`
        + `${r.sampled ? ' *(sampled)*' : ''} | ${dur(r.sessionNs)} `
        + `| ${dur(r.wholesaleNs)} | ${r.incremental} of ${r.incremental + r.rebuilt} |`),
    ];
    return `\n${lines.join('\n')}\n`;
  },
  /** How much the wholesale tick grows across the unsampled rows — the
   * other half of the flatness claim. */
  'charts.sessionFlatness': () => {
    const rows = (data('charts').scaling ?? []).filter((/** @type {any} */ r) => !r.sampled);
    const first = rows[0];
    const last = rows[rows.length - 1];
    if (first === undefined || last === undefined) return 'not measured';
    return `${ratio(last.sessionNs / first.sessionNs)}× while the wholesale tick grows `
      + `${ratio(last.wholesaleNs / first.wholesaleNs)}×`;
  },
  /** The one number the default is for: what sampling saves on the
   * whole render at the largest measured line. */
  'charts.samplingWin': () => {
    const rows = (data('charts').sampling ?? []).filter(
      (/** @type {any} */ r) => r.renderedCount < r.sourceCount);
    const last = rows[rows.length - 1];
    return last === undefined ? 'not measured'
      : `${last.sourceCount.toLocaleString('en-US')} points draw as `
        + `${last.renderedCount.toLocaleString('en-US')} and render `
        + `${ratio(last.wholeSvgNs / last.sampledSvgNs)}× faster`;
  },
  // ————— live: event-time views —————

  /** The maintained-vs-re-run table for the two event-time shapes. */
  'live.eventTimeTable': () => {
    const table = data('live').tables.find((/** @type {any} */ t) =>
      t.title.startsWith('Event-time views'));
    const lines = [
      '| view | maintained | re-run | ratio |',
      '|---|---:|---:|---:|',
    ];
    for (const row of table.rows) {
      if (!row.name.startsWith('maintained')) continue;
      const rerun = table.rows.find((/** @type {any} */ r) =>
        r.name === row.name.replace('maintained', 're-run'));
      lines.push(`| ${row.name.replace('maintained — ', '')} `
        + `| ${dur(row.results[0])} | ${dur(rerun.results[0])} `
        + `| ${ratio(rerun.results[0] / row.results[0])}× |`);
    }
    return `\n${lines.join('\n')}\n`;
  },
  /** The two headline event-time speedups at the larger corpus. */
  'live.eventTimeBand': () => {
    const ratios = (data('live').meta.eventTimeRatios ?? []);
    const size = Math.max(...ratios.map((/** @type {any} */ r) => r.size));
    const at = ratios.filter((/** @type {any} */ r) => r.size === size);
    const parts = at.map((/** @type {any} */ r) =>
      `${ratio(r.ratio)}× for the ${r.shape.split(' ')[0]}`);
    return `${parts.join(' and ')} at ${size.toLocaleString('en-US')} readings`;
  },

  // ——— @jarenjs/linq: what one subpath costs a consumer who imports it
  // and nothing else. Measured by `scripts/check-tree-shaking.js`, which
  // runs esbuild and is far too slow for this script; it commits its
  // measurement, and every figure below is spliced from that one number.
  // Ten sentences quoting another subpath's price used to be typed, and
  // one schema-pen change left every one of them 94 bytes stale.
  ...Object.fromEntries(['schema', 'chain', 'model', 'jslt', 'migration', 'db',
    'contract', 'flow', 'app', 'forms', 'charts', 'project', 'jtlt', 'messages', 'formula'].flatMap((name) => [
    [`bundle.${name}`, () => thousands(bundleBytes(name))],
    // the rounded kB docs/CONSUMING.md publishes: decimal, so a reader
    // comparing it with the exact figure beside it can do the division
    [`bundle.${name}.kb`, () => String(Math.round(bundleBytes(name) / 1000))],
  ])),
  // the chain's document publishes three more: what of its bundle is the
  // chain's own modules rather than the engine under them, what a
  // consumer taking the schema pen as well pays, and what the two share
  'bundle.chain.own': () => thousands(bundles().chain.own),
  'bundle.chain.withSchemaPen': () => thousands(bundles().chain.withSchemaPen),
  'bundle.chain.shared': () => thousands(bundles().chain.shared),
  // the two components the component rule cut apart: what md and mermaid
  // each cost a consumer who renders with them and imports nothing else
  ...Object.fromEntries(['md', 'mermaid'].map((name) => [`bundle.${name}`, () => {
    const bytes = bundles().components?.[name];
    if (typeof bytes !== 'number') {
      throw new Error(`benchmark/bundle-sizes.json has no '${name}' component bundle `
        + '— re-measure with `npm run test:tree-shaking -- --write`');
    }
    return thousands(bytes);
  }])),

  // ——— the provenance lines of the suite tables below ———
  ...Object.fromEntries(['jsonpath', 'jsonpointer', 'jsonquery', 'jslt', 'toml', 'mermaid'].map((suite) =>
    [`${suite}.measured`, () => measuredOn(suite)])),
  'jsonpath.rivalVersion': () => {
    const label = data('jsonpath').engines.find((e) => e.startsWith('json-p3'));
    if (label === undefined) throw new Error('jsonpath.json names no json-p3 engine — regenerate it before quoting one');
    return versionOf(label);
  },

  // ——— @jarenjs/json: the JSONPath scale document, against json-p3 ———
  // the narrowest and the widest row, named — a band whose ends are not
  // named reads as if the README's favourite shape were one of them
  'jsonpath.scaleBand': () => {
    const rows = jsonpathScale().sort((a, b) => a.ratio - b.ratio);
    const [lo, hi] = [rows[0], rows[rows.length - 1]];
    return `${ratio(lo.ratio)}x (${lo.shape}) to ${ratio(hi.ratio)}x (${hi.shape})`;
  },
  // the scale rows, the CTS summary the root README quotes, and the
  // compile row — which json-p3 wins, so the table says so in its ratio
  'jsonpath.scaleTable': () => {
    const summary = cts();
    const c = data('jsonpath').profile.compileRow;
    const selectors = Number(/(\d+)/u.exec(c?.name ?? '')?.[1]);
    if (!Number.isFinite(c?.engines?.jaren) || !Number.isFinite(c?.engines?.['json-p3']) || !Number.isFinite(selectors)) {
      throw new Error('jsonpath.json carries no compile row — regenerate it before quoting one');
    }
    return ['', '| Query shape | Jaren | json-p3 over Jaren |', '|---|---|---|',
      ...jsonpathScale().map((r) => `| ${r.shape} | ${dur(r.mine)} | ${mag(r.ratio)}x |`),
      `| geometric mean over all ${summary.rows} CTS queries | ${dur(summary.mine)} | ${ratio(summary.ratio)}x |`,
      `| compile, per query (all ${selectors} valid selectors) | ${dur(c.engines.jaren / selectors)} `
        + `| ${mag(c.engines['json-p3'] / c.engines.jaren)}x |`,
      ''].join('\n');
  },
  // early exit: the first match against the whole nodelist, same query,
  // same document
  'jsonpath.earlyExit': () => {
    const selector = '$.items[?@.price < 10].name';
    const first = data('jsonpath').profile.earlyExitRows?.find((r) => r.name === 'first' && r.selector === selector);
    const whole = jsonpathScale().find((r) => r.selector === selector);
    if (!Number.isFinite(first?.engines?.jaren) || whole === undefined) {
      throw new Error(`jsonpath.json carries no first-match and nodelist rows for ${selector} — regenerate it before quoting them`);
    }
    return `costs ${dur(first.engines.jaren)} where the whole nodelist costs ${dur(whole.mine)}`;
  },

  // ——— @jarenjs/json: compiled JSON Pointer against the interpretive
  // resolver it replaced and against the `jsonpointer` npm package ———
  'jsonpointer.absolute': () => band(pointerRatios('absolute', ['jaren legacy']).map((r) => r.ratio), ratio),
  'jsonpointer.relative': () => band(pointerRatios('relative', ['jaren legacy']).map((r) => r.ratio), ratio),
  'jsonpointer.dataRef': () => band(pointerRatios('dataRef', ['jaren legacy']).map((r) => r.ratio), ratio),
  'jsonpointer.vsLegacy': () => band(['absolute', 'relative', 'dataRef']
    .flatMap((key) => pointerRatios(key, ['jaren legacy']).map((r) => r.ratio)), ratio),
  // the npm package's faster route per row, compiled or interpreted
  'jsonpointer.vsNpm': () => {
    const rows = pointerRatios('absolute', ['npm compiled', 'npm interpret']);
    const lost = rows.filter((r) => !(r.ratio > 1));
    if (lost.length === 0) {
      const widest = rows.reduce((a, b) => (b.ratio > a.ratio ? b : a));
      return `on every scenario both run (${band(rows.map((r) => r.ratio), ratio)}x, the widest on ${widest.name})`;
    }
    return `on ${rows.length - lost.length} of ${rows.length} scenarios, while the package is faster on ${listOf(lost.map((r) => r.name))}`;
  },

  // ——— @jarenjs/json: JSON Patch against clone-and-interpret ———
  'jsonpatch.vsNaive': () => {
    const t = data('jsonpatch').tables.find((x) => x.title.startsWith('JSON Patch'));
    const mine = t?.columns.indexOf('jaren compiled') ?? -1;
    const naive = t?.columns.indexOf('naive') ?? -1;
    const ratios = (t?.rows ?? []).filter((r) => Number.isFinite(r.results[mine]) && Number.isFinite(r.results[naive]))
      .map((r) => r.results[naive] / r.results[mine]);
    if (mine === -1 || naive === -1 || ratios.length === 0) throw new Error('jsonpatch.json carries no JSON Patch apply rows — regenerate it before quoting one');
    return band(ratios, mag);
  },

  // ——— @jarenjs/json: the query matrix against fontoxpath and jsonata.
  // The join is held apart: there Jaren answers from a hash table while
  // both rivals run a nested loop, a different algorithm, and folding its
  // four-digit ratio into the band would make every other row look small
  'jsonquery.vsFontoxpath': () => lead(bookstoreRatios('jsonquery', 'fontoxpath', (r) => r.scenario !== 'join'), mag, 'x'),
  'jsonquery.vsJsonata': () => lead(bookstoreRatios('jsonquery', 'jsonata', (r) => r.scenario !== 'join'), mag, 'x'),
  'jsonquery.join': () => {
    const sizes = [...new Set(data('jsonquery').rows.filter((r) => r.scenario === 'join' && Number.isFinite(r.engines.jaren))
      .map((r) => booksOf(r.document)))].sort((a, b) => a - b);
    const at = (books) => ['fontoxpath', 'jsonata'].flatMap((rival) =>
      bookstoreRatios('jsonquery', rival, (r) => r.scenario === 'join' && booksOf(r.document) === books));
    if (sizes.length < 2) throw new Error('jsonquery.json carries fewer than two join rows — regenerate it before quoting them');
    const [small, large] = [sizes[0], sizes[sizes.length - 1]];
    return `${band(at(small), mag)}x at ${thousands(small)} books and ${band(at(large), mag)}x at ${thousands(large)} books`;
  },
  'jsonquery.joinSmall': () => {
    const small = Math.min(...data('jsonquery').rows.map((r) => booksOf(r.document)));
    const atSmall = (r) => booksOf(r.document) === small;
    const row = data('jsonquery').rows.find((r) => r.scenario === 'join' && atSmall(r));
    const rivals = ['fontoxpath', 'jsonata'].map((k) => row?.engines?.[k]).filter(Number.isFinite);
    if (!Number.isFinite(row?.engines?.jaren) || rivals.length === 0) throw new Error('jsonquery.json carries no small join row — regenerate it before quoting one');
    const join = rivals.map((v) => v / row.engines.jaren);
    const others = ['fontoxpath', 'jsonata'].flatMap((rival) =>
      bookstoreRatios('jsonquery', rival, (r) => r.scenario !== 'join' && atSmall(r)));
    const inside = Math.min(...join) >= Math.min(...others) && Math.max(...join) <= Math.max(...others);
    return `${dur(row.engines.jaren)} against ${rivals.map(dur).join(' and ')}, ${band(join, mag)}x, `
      + `${inside ? 'inside' : 'against'} the ${band(others, mag)}x of every other small-document row`;
  },
  'jsonquery.joinLarge': () => {
    const rows = data('jsonquery').rows.filter((r) => r.scenario === 'join' && Number.isFinite(r.engines.jaren));
    const large = rows.sort((a, b) => booksOf(b.document) - booksOf(a.document))[0];
    if (large === undefined) throw new Error('jsonquery.json carries no join row — regenerate it before quoting one');
    return band(['fontoxpath', 'jsonata'].map((k) => large.engines[k] / large.engines.jaren).filter(Number.isFinite), mag);
  },
  'jsonquery.table': () => bookstoreTable('jsonquery', [['fontoxpath', `fontoxpath ${versionOf(data('jsonquery').engines[1])}`],
    ['jsonata', `jsonata ${versionOf(data('jsonquery').engines[2])}`]], 'compile, per query'),

  // ——— @jarenjs/json: JSLT against hand-written JavaScript and JSONata's
  // transform operator. Identity is the sharing fast path, not a
  // transformation, so it is quoted alone and kept out of both bands ———
  'jslt.table': () => bookstoreTable('jslt', [['native', 'native JS'],
    ['jsonata', `jsonata ${versionOf(data('jslt').engines[2])}`]], 'compile, per stylesheet'),
  'jslt.identityNs': () => {
    const rows = data('jslt').rows.filter((r) => r.scenario === 'identity' && Number.isFinite(r.engines.jaren));
    if (rows.length === 0) throw new Error('jslt.json carries no identity rows — regenerate it before quoting one');
    return `${band(rows.map((r) => r.engines.jaren), ns)} ns`;
  },
  'jslt.vsJsonata': () => lead(bookstoreRatios('jslt', 'jsonata', (r) => r.scenario !== 'identity'), mag, 'x'),
  'jslt.vsNative': () => lead(bookstoreRatios('jslt', 'native', (r) => r.scenario !== 'identity'), mag, 'x'),

  // ——— @jarenjs/flow: compile against XState, and the dag's price ———
  'flow.compileVsXstate': () => lead(flowCompileRatios()),
  'flow.dagTax': () => {
    const { sync, async } = data('flow').dag ?? {};
    const ratios = [...(sync ?? []), ...(async ?? [])].map((r) => r.dagMs / r.handMs);
    if (ratios.length === 0) throw new Error('flow.json carries no dag rows — regenerate it before quoting one');
    return band(ratios, ratio);
  },

  // ——— @jarenjs/view: the memo marker, the frame, server rendering ———
  'view.memoSkip': () => ratio(viewRow('memo', '=== child scan (no memo)') / viewRow('memo', 'memo-equal marker skip')),
  'view.memoMarker': () => {
    const scan = viewRow('memo', '=== child scan (no memo)');
    const skip = viewRow('memo', 'memo-equal marker skip');
    return `about **${dur(scan)}** to walk the children looking for \`===\` skips versus about **${dur(skip)}** `
      + `with the marker — **${ratio(scan / skip)}×**`;
  },
  'view.memoFrame': () => ratio(viewRow('frame', 'jaren view+patch (no memo)') / viewRow('frame', 'jaren view+patch (memo)')),
  // which frame is fastest outright is read off the table, whichever it is
  'view.fastestFrame': () => {
    const memo = viewRow('frame', 'jaren view+patch (memo)');
    const hand = viewRow('frame', 'jaren view+patch (hand-written)');
    // a gap inside how far the suite's own processes disagreed is no order
    const worst = data('meta').measurement?.view?.processSpread?.worst;
    const gap = Math.max(memo, hand) / Math.min(memo, hand);
    if (worst !== undefined && gap <= worst)
      return `at this table size the hand-written view plus a full diff and the memoized stylesheet are level as the fastest frame: ${ratio(gap)}× apart, inside the ${ratio(worst)}× the suite's processes disagreed by`;
    return hand <= memo
      ? `at this table size the hand-written view plus a full diff is still the fastest frame outright, ${ratio(memo / hand)}× ahead of the memoized stylesheet`
      : `at this table size the memoized stylesheet is the fastest frame outright, ${ratio(hand / memo)}× ahead of the hand-written view plus a full diff`;
  },
  'view.ssrBand': () => {
    const preact = viewRow('ssr', 'preact-render-to-string');
    const ours = (data('view').tables.ssr ?? []).filter((r) => r.label.startsWith('jaren renderToString'));
    if (ours.length === 0) throw new Error("view.json's ssr table has no jaren rows — regenerate it before quoting one");
    return band(ours.map((r) => r.ns / preact), ratio);
  },

  // ——— @jarenjs/josl: the CSV reader against udsv, streaming, stringify ———
  'csv.udsvLoss': () => {
    const part = (r) => {
      const x = r.results.jaren / r.results.udsv;
      return x > 1 ? `${fix2(x)}× on ${CSV_SHAPES[r.name] ?? r.name}` : `none on ${CSV_SHAPES[r.name] ?? r.name} (jaren ${fix2(1 / x)}× ahead)`;
    };
    const objects = csvRows('objects').map((r) => r.results.jaren / r.results.udsv);
    return `${csvRows('rows').map(part).join(', ')}, and ${band(objects, fix2)}× when records become header-keyed objects`;
  },
  'csv.streaming': () => {
    const plain = (table) => csvRows(table).find((r) => r.name === 'records 10k x 6 (plain)');
    const [whole, stream] = [plain('rows'), plain('streaming')];
    if (whole === undefined || stream === undefined) throw new Error('csv.json carries no plain streaming row — regenerate it before quoting one');
    const vsUdsv = stream.results.jaren / stream.results.udsv;
    return `about ${fix2(stream.results.jaren / whole.results.jaren)}× the wholesale path `
      + `(${ms1(stream.results.jaren)} ms vs ${ms1(whole.results.jaren)} ms), `
      + (vsUdsv > 1 ? `and ${fix2(vsUdsv)}× the time udsv's chunked reader takes` : `${fix2(1 / vsUdsv)}× faster than udsv's chunked reader`);
  },
  'csv.stringify': () => stringifyLeader(data('csv').profile.stringify, (name) => name),

  // ——— @jarenjs/josl: TOML compliance and speed ———
  'toml.cases': () => String(data('toml').cases.valid + data('toml').cases.invalid),
  'toml.table': () => {
    const t = data('toml');
    const parse = t.profile.parse;
    const pct = (e) => (100 * t.compliance[e].pass) / t.compliance[e].total;
    const bestPct = Math.max(...TOML_ENGINES.map(pct));
    const best = parse.map((r) => Math.min(...TOML_ENGINES.map((e) => r.results[e]).filter(Number.isFinite)));
    const rows = TOML_ENGINES.map((e) => {
      const score = `${pct(e).toFixed(1)}%`;
      const cells = parse.map((r, i) => (r.results[e] === best[i] ? `**${ms(r.results[e])} ms**` : `${ms(r.results[e])} ms`));
      return `| ${e === 'jaren' ? '**jaren**' : e} | ${pct(e) === bestPct ? `**${score}**` : score} | ${cells.join(' | ')} |`;
    });
    return ['', `| engine | compliance | ${parse.map((r) => `parse, ${TOML_SHAPES[r.name]?.replace(/^the /u, '') ?? r.name}`).join(' | ')} |`,
      `| --- | --- |${parse.map(() => ' --- |').join('')}`, ...rows, ''].join('\n');
  },
  'toml.compliance': () => {
    const t = data('toml');
    const clean = TOML_ENGINES.filter((e) => t.compliance[e].pass === t.compliance[e].total);
    if (clean.length === 1 && clean[0] === 'jaren') return 'the only engine at 100%';
    if (clean.includes('jaren')) return `one of ${clean.length} engines at 100%`;
    return `at ${t.compliance.jaren.pass} of ${t.compliance.jaren.total}`;
  },
  'toml.vsSmol': () => {
    const rows = data('toml').profile.parse.map((r) => ({ name: TOML_SHAPES[r.name] ?? r.name, x: r.results.jaren / r.results['smol-toml'] }));
    const theirs = rows.filter((r) => r.x > 1);
    const ours = rows.filter((r) => r.x <= 1);
    const list = (xs, flip) => listOf(xs.map((r) => `${ratio(flip ? 1 / r.x : r.x)}× on ${r.name}`));
    if (ours.length === 0) return `smol-toml leads every parse row: ${list(theirs, false)}`;
    if (theirs.length === 0) return `jaren leads every parse row: ${list(ours, true)}`;
    return `smol-toml leads by ${list(theirs, false)}, and jaren by ${list(ours, true)}`;
  },
  'toml.stringify': () => stringifyLeader(data('toml').profile.stringify, (name) => (name === '@iarna/toml' ? '`@iarna/toml`' : name)),

  // ——— @jarenjs/charts: the bar session ———
  'charts.barTable': () => {
    const rows = data('charts').barScaling ?? [];
    if (rows.length === 0) throw new Error('charts.json carries no bar scaling rows — regenerate it before quoting one');
    return ['', '| categories | session tick | wholesale tick |', '|---|---|---|',
      ...rows.map((r) => `| ${thousands(r.categories)} | ${dur(r.sessionNs)} | ${dur(r.wholesaleNs)} |`), ''].join('\n');
  },
  'charts.barGrowth': () => {
    const rows = data('charts').barScaling ?? [];
    const [first, last] = [rows[0], rows[rows.length - 1]];
    if (first === undefined || first === last) throw new Error('charts.json carries fewer than two bar scaling rows — regenerate it before quoting one');
    return `${ratio(last.sessionNs / first.sessionNs)}× where the wholesale render grows ${ratio(last.wholesaleNs / first.wholesaleNs)}×`;
  },

  // ——— @jarenjs/mermaid: the two parsers it is measured against ———
  'mermaid.vsLangium': () => {
    const rows = data('mermaid').profile.parse ?? [];
    return lead(rows.map((r) => r.results['@mermaid-js/parser'] / r.results['jaren-mermaid']).filter(Number.isFinite));
  },
  'mermaid.vsJison': () => {
    const rows = data('mermaid').profile.parseJison ?? [];
    return lead(rows.map((r) => r.results['mermaid (jison)'] / r.results['jaren-mermaid']).filter(Number.isFinite), mag);
  },
  'mermaid.jisonTable': () => {
    const rows = data('mermaid').profile.parseJison ?? [];
    if (rows.length === 0) throw new Error('mermaid.json carries no Jison rows — regenerate it before quoting one');
    const two = (x) => Number(x.toPrecision(2)).toString();
    return ['', '| flowchart/sequence parse (ms/op) | jaren-mermaid | mermaid.parse (Jison) |', '|---|---|---|',
      ...rows.map((r) => `| ${r.name} | ${two(r.results['jaren-mermaid'])} | ${two(r.results['mermaid (jison)'])} |`), ''].join('\n');
  },

  // ——— @jarenjs/contract: the widest dispatch row, and the socket ———
  'contract.dispatch.widest': () => {
    const t = contractTable('Dispatch, in-process');
    const mine = t.columns.indexOf('@jarenjs/contract');
    const rival = t.columns.indexOf('find-my-way + Ajv + fjs');
    const rows = t.rows.filter((r) => Number.isFinite(r.results[mine]) && Number.isFinite(r.results[rival]));
    if (mine === -1 || rival === -1 || rows.length === 0) throw new Error('contract.json carries no dispatch rows — regenerate it before quoting one');
    const widest = rows.reduce((a, b) => (b.results[mine] / b.results[rival] > a.results[mine] / a.results[rival] ? b : a));
    const name = widest.name.includes('bare route') ? 'the bare `{ok:true}` route' : `the \`${widest.name.split(' — ')[0]}\` row`;
    return `${name}, where the rival's compiled serializer answers in ${ns(widest.results[rival])} ns`;
  },
  'contract.loopback': () => {
    const t = contractTable('Dispatch, over loopback');
    const mine = t.columns.indexOf('@jarenjs/contract over node:http');
    const rival = t.columns.indexOf('fastify');
    if (mine === -1 || rival === -1) throw new Error('contract.json loopback table names no @jarenjs/contract or fastify column');
    const ratios = t.rows.map((r) => r.results[rival] / r.results[mine]).filter(Number.isFinite);
    if (ratios.length === 0) throw new Error('contract.json carries no loopback rows — regenerate it before quoting one');
    if (Math.max(...ratios) <= 1.05 && Math.min(...ratios) >= 1 / 1.05) return 'the two stacks are level';
    if (Math.max(...ratios) < 1) return `Fastify is ${band(ratios.map((x) => 1 / x), fix2)}× faster`;
    if (Math.min(...ratios) > 1) return `the pipeline is ${band(ratios, fix2)}× faster than Fastify`;
    return `the two stacks trade rows within ${band(ratios, fix2)}×`;
  },

  // ——— @jarenjs/core/geo: what the index buys, and the centroid row ———
  'geo.probeVsScan': () => mag(geoRow('linear scan (100k boxes, no index)').ours / geoRow('index probe (100k boxes)').ours),
  'geo.centroidVerdict': () => geoVerdict('centroid (2000-vertex)'),
  'geo.flatbush': () => `the build is ${geoVerdict('index build (100k boxes)')} and the probe `
    + `${geoVerdict('index probe (100k boxes)')}`,

  // ——— @jarenjs/db: what the asynchronous store API costs a point read ———
  'db.asyncCost': () => {
    const t = data('db').tables.find((x) => x.title.startsWith('Point lookup by key'));
    const async = t?.rows.find((r) => r.name === 'jaren (async surface)')?.results[0];
    const sync = t?.rows.find((r) => r.name === 'jaren (store.sync)')?.results[0];
    if (!Number.isFinite(async) || !Number.isFinite(sync)) throw new Error('db.json carries no async and sync point lookups — regenerate it before quoting them');
    const cost = async - sync;
    return cost > 0 ? `~${us(cost)} µs per point read (~${Math.round((100 * cost) / sync)} %)`
      : `nothing measurable per point read (the async row is ${us(-cost)} µs faster)`;
  },

  // ——— the schema pen's model subclass: what it adds to the bundle ———
  'bundle.model.overSchema.kb': () => String(Math.round((bundleBytes('model') - bundleBytes('schema')) / 1000)),

  // ——— the Zod migration guide: the first calls in a fresh process. The
  // settled table is a long-run figure; a request handler in a cold
  // serverless process lives in these, so where Jaren stands there is
  // read off the same suite rather than assumed from the settled one ———
  'contracts.firstCalls.versus': () => {
    const fc = contractsFirstCalls();
    const calls = (t) => /First ([\d,]+) calls/u.exec(t.title)?.[1] ?? t.title;
    const stands = fc.tables.map((t) => ({ calls: calls(t), text: standingAll(t) }));
    if (stands.every((s) => s.text === stands[0].text)) {
      return `over the first ${listOf(stands.map((s) => s.calls))} calls alike, Jaren is ${stands[0].text}`;
    }
    return stands.map((s, i) => `over the first ${s.calls} calls ${i === 0 ? 'Jaren' : 'it'} is ${s.text}`).join('; ');
  },
};

/** One named row of the vector suite's flat rows at the largest leg. */
function vectorMs(path) {
  const legs = data('vector').meta.legs;
  const leg = legs[legs.length - 1];
  const row = data('vector').rows.find((/** @type {any} */ r) =>
    r.path === path && r.n === leg.n && r.dims === leg.dims);
  if (row === undefined) {
    // the JSON-doc row runs only up to the size it is honest at, so a
    // caller that asks for it at the largest leg gets the largest leg
    // that HAS it rather than a number from another path
    const fallback = [...data('vector').rows].reverse().find((/** @type {any} */ r) => r.path === path);
    if (fallback === undefined) throw new Error(`vector.json has no '${path}' row — regenerate it before quoting one`);
    return fallback.ns / 1e6;
  }
  return row.ns / 1e6;
}

/** The label of the leg every headline vector figure is quoted at. */
function largestLeg() {
  const legs = data('vector').meta.legs;
  return legs[legs.length - 1].label;
}

/** One named row of the spatial suite's tables, or a refusal. */
function spatialRow(key) {
  for (const table of data('spatial').tables) {
    const row = table.rows.find((r) => r.key === key);
    if (row !== undefined) return row;
  }
  throw new Error(`spatial.json has no '${key}' row — regenerate it before quoting one`);
}
/** That row's timing in milliseconds. */
const spatialMs = (key) => spatialRow(key).results[0] / 1e6;
/** A push-versus-residual ratio as the profile's verdict cell. */
function verdict(figure) {
  const x = data('spatial').meta.figures[figure];
  if (x >= 1.5) return `push **${ratio(x)}×**`;
  if (x <= 1 / 1.5) return `residual **${ratio(1 / x)}×**`;
  return '~even';
}

/** The series suite's largest leg, and one route's median there, in ms. */
function seriesLargest() {
  const { legs } = data('series').meta;
  return legs[legs.length - 1];
}
function seriesMs(route) {
  const leg = seriesLargest();
  const row = data('series').rows.find((r) => r.route === route && r.n === leg.n);
  if (row === undefined) {
    throw new Error(`series.json has no '${route}' row at ${leg.n} — regenerate it before quoting one`);
  }
  return row.ns / 1e6;
}
/** One route's answer size at the largest leg. */
function seriesRows(route) {
  const leg = seriesLargest();
  return /** @type {any} */ (data('series').rows.find((r) => r.route === route && r.n === leg.n)).results;
}
/** The spans a side the interval join was measured at, ascending. */
function seriesJoinSides() {
  const sides = data('series').rows.filter((r) => r.route === 'joinIntervalProbe').map((r) => r.n);
  if (sides.length === 0)
    throw new Error("series.json has no 'joinIntervalProbe' row — regenerate it before quoting one");
  return sides.sort((a, b) => a - b);
}
/** One interval-join route's row at one side. */
function seriesJoinRow(route, n) {
  const row = data('series').rows.find((r) => r.route === route && r.n === n);
  if (row === undefined)
    throw new Error(`series.json has no '${route}' row at ${n} — regenerate it before quoting one`);
  return row;
}
/** The days of the year the stored-span question was asked at, ascending. */
function seriesSpanDays() {
  const days = data('series').rows.filter((r) => r.route === 'spanDeclared').map((r) => r.n);
  if (days.length === 0)
    throw new Error("series.json has no 'spanDeclared' row — regenerate it before quoting one");
  return days.sort((a, b) => a - b);
}
/** One stored-span route's row at one day of the year. */
function seriesSpanRow(route, day) {
  const row = data('series').rows.find((r) => r.route === route && r.n === day);
  if (row === undefined)
    throw new Error(`series.json has no '${route}' row at day ${day} — regenerate it before quoting one`);
  return row;
}
/** A speed-up stated as one and a loss as one, never a floor at parity. @param {number} r */
const spanVerdict = (r) => (r >= 1 ? `${ratio(r)}× faster` : `${ratio(1 / r)}× slower`);

//#region the registry

/**
 * Every document that quotes a measured figure. A registry declares the
 * documents it reads and may write; `scripts/lib/derive.js` walks the
 * union of every registry's.
 */
const DOCS = [
  'README.md',
  'docs/CONSUMING.md',
  'docs/MIGRATING-FROM-ZOD.md',
  'packages/linq/docs/QUERY-PEN.md',
  'packages/linq/docs/SCHEMA-PEN.md',
  'packages/linq/docs/MODEL-PEN.md',
  'packages/linq/docs/JSLT-PEN.md',
  'packages/linq/docs/MIGRATION-PEN.md',
  'packages/linq/docs/CONTRACT-PEN.md',
  'packages/linq/docs/FLOW-PEN.md',
  'packages/linq/docs/APP-PEN.md',
  'packages/linq/docs/FORMS-PEN.md',
  'packages/linq/docs/DB-CLIENT.md',
  'docs/ROADMAP.md',
  'benchmark/README.md',
  'packages/contract/README.md',
  'components/charts/README.md',
  'components/md/README.md',
  'components/mermaid/README.md',
  'packages/flow/README.md',
  'packages/view/README.md',
  'packages/josl/README.md',
  'packages/db/README.md',
  'packages/db/docs/HOSTS.md',
  'packages/db/docs/REPLICATION-FORMAT.md',
  'packages/linq/README.md',
  'packages/db/docs/MODEL-FORMAT.md',
  'packages/core/README.md',
  'packages/core/ARCHITECTURE.md',
  'packages/core/docs/GEO.md',
  'packages/core/docs/SERIES.md',
  'packages/json/ARCHITECTURE.md',
  'packages/json/README.md',
  'packages/db/ARCHITECTURE.md',
  'packages/contract/docs/CONTRACT-FORMAT.md',
  'packages/website/README.md',
];

/** @type {import('./lib/derive.js').Registry} */
export const measuredFigures = {
  name: 'measured figures',
  docs: () => DOCS,
  facts: () => FACTS,
};

//#endregion
