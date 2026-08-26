#!/usr/bin/env node
//@ts-check
/**
 * The benchmark-figure gate: every measured number quoted in committed
 * markdown is derived here from `packages/website/public/benchmarks/*.json`
 * — the same files the website's Benchmarks page reads — and written into
 * the docs between `<!--bm:key-->` … `<!--/bm-->` markers.
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
 *   node scripts/generate-benchmark-facts.js          # rewrite the docs
 *   node scripts/generate-benchmark-facts.js --check  # fail on drift
 *
 * Markers are HTML comments, so GitHub renders the documents unchanged.
 * The prose AROUND a marker stays human: when a band moves far enough
 * that the sentence reads wrong, the gate makes a person read it.
 *
 * The marker layer itself is `@jarenjs/md`'s (`bake`, and the directive
 * scanner behind it) — this file is a registry of DERIVATIONS over the
 * committed measurements, and nothing else. The derivations stay in
 * JavaScript on purpose: bands, means and whole tables read worse as
 * query one-liners, and D8 governs template vocabularies, not build
 * scripts.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { bake } from '@jarenjs/md';

import { ratioSummary } from '../benchmark/derive.js';
import { buildSiteContent } from './generate-site-data.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const DATA = join(ROOT, 'packages/website/public/benchmarks');

/** @type {Record<string, any>} */
const cache = {};
const data = (name) => (cache[name] ??= JSON.parse(readFileSync(join(DATA, `${name}.json`), 'utf8')));

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
 * One row of the long-horizon suite. The suite is a grid — task ×
 * compaction variant × payload shape × history budget — so every quoted
 * number has to name all four coordinates or it is quoting whichever row
 * happened to sort first.
 * @param {{ variant: string, shape: string, budget: number, task?: string }} at
 */
function horizonRow(at) {
  const row = data('long-horizon').rows.find((r) => r.variant === at.variant
    && r.shape === at.shape && r.budget === at.budget && r.task === (at.task ?? 'needle'));
  if (row === undefined) {
    throw new Error(`long-horizon.json has no ${at.variant}/${at.shape} row at budget ${at.budget}`
      + ' — regenerate it before quoting one');
  }
  return row;
}

/** Every row that actually compacted something, for one variant/task. */
const horizonCompacting = (variant, task = 'needle') => data('long-horizon').rows
  .filter((r) => r.variant === variant && r.task === task && r.compacted);

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
const FACTS = {
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
        + `| **${ms(b.jarenSuccessTime)} ms** vs ${ms(b.ajvSuccessTime)} ms `
        + `| ${b.successOnly.jarenWins} of ${b.successTests} tests |`;
    });
    return ['', '| Draft | Jaren | Ajv | Success-only totals | Jaren faster on |',
      '|---|---|---|---|---|', ...rows, ''].join('\n');
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

  // ——— @jarenjs/ai: what a compacted agent session keeps, loses and can
  // still reach. Every figure names its row; the budget quoted in the
  // package README is 6 000 characters on the realistic payload shape,
  // which is the row where the defect is most visible.
  'horizon.measured': () => {
    const meta = data('long-horizon').meta;
    return `${String(meta.date).slice(0, 10)}, Node ${meta.node}, ${meta.n} tool rounds`;
  },
  'horizon.synopsisGap': () => {
    const row = horizonRow({ variant: 'synopsis', shape: 'late', budget: 6000 });
    return `${row.idPresent} of ${row.n} record ids and ${row.valuePresent} of their ${row.n} values`;
  },
  'horizon.ledgerRecovered': () => {
    const row = horizonRow({ variant: 'ledger', shape: 'late', budget: 6000 });
    return `${row.valueRecoverable} of ${row.n}`;
  },
  // the same rows without a ledger, as a band: the realistic shape only,
  // because the flattering one is a different claim and averaging the two
  // would be a third that nobody measured
  'horizon.synopsisBand': () => {
    const kept = horizonCompacting('synopsis')
      .filter((r) => r.shape === 'late')
      .map((r) => r.valuePresent);
    return `${Math.min(...kept)} to ${Math.max(...kept)}`;
  },
  // the campaign's own headline: the number the ledger does NOT move.
  // Printed as a claim about every compacting row, with the exceptions
  // named — a row where the whole corpus still fits is the payload shape
  // being generous, not a relation being recovered.
  'horizon.pairwise': () => {
    const rows = data('long-horizon').rows.filter((r) => r.task === 'pairwise' && r.compacted);
    const determined = rows.filter((r) => r.ceiling > 0);
    return determined.length === 0
      ? '0% at every budget that compacts anything, with a ledger or without'
      : `0% at every budget that compacts anything except ${determined
        .map((r) => `${r.variant}/${r.shape} at ${r.budget}`).join(', ')}`;
  },
  // The same question asked of an environment: the number the compaction
  // rows above cannot move, and what it costs the root to move it. The
  // pairwise row is quoted rather than the needle because it is the one
  // the campaign is judged on.
  'horizon.program': () => {
    const row = data('long-horizon').rows
      .find((r) => r.variant === 'program' && r.task === 'pairwise' && r.shape === 'late');
    if (row === undefined) throw new Error('long-horizon.json has no program/pairwise/late row');
    return `${(row.ceiling * 100).toFixed(0)}%, with ${row.valuePresent} of ${row.n} records`
      + ` reaching the reduce over ${row.subcalls} sub-calls, while the root request carried`
      + ` ${row.charsSent} characters against a corpus of ${row.charsFull}`;
  },
  // what the concurrency bought, at a stated synthetic latency — the
  // paper's own "RLMs without asynchronous LM calls are slow" limitation
  'horizon.programFanout': () => {
    const s = data('long-horizon').meta.scheduling;
    if (s === undefined || s === null) throw new Error('long-horizon.json has no scheduling block');
    return `${(s.sequential.ms / s.parallel.ms).toFixed(1)}x (${s.sequential.ms}ms sequential vs`
      + ` ${s.parallel.ms}ms at concurrency ${s.parallel.concurrency}, ${s.parallel.subcalls}`
      + ` sub-calls of ${s.delayMs}ms each)`;
  },
  // D8: whether the cheap tier can author a plan that compiles, and do
  // the piece work. Published whichever way it falls — a tier that
  // cannot is a real result, and prose that quoted nothing would hide it.
  'horizon.programLive': () => {
    const a = data('long-horizon').meta.authoring;
    if (a === null || a === undefined) return 'no live model ran on the machine that generated this file';
    // a timed-out attempt is NOT a rejected program, and reporting the
    // two together would read as "the tier cannot author" when what the
    // run measured was the transport giving up. The distinction is the
    // whole point of publishing this number, so the count is split.
    const timedOut = a.errors.filter((e) => /timeout/i.test(e)).length;
    const returned = a.trials - timedOut;
    const authored = `${a.compiled} of ${a.trials} authored programs compiled`
      + (timedOut === 0
        ? ` (${a.generations} generation(s) including repairs)`
        : ` — but ${timedOut} of those attempts never came back at all (the 300 s deadline),`
          + ` so of the ${returned} that answered, ${a.compiled} compiled`);
    return a.valuesReached === null
      ? `${authored}; the piece work was not run within the spend guard`
      : `${authored}. Answering ${a.subcalls} sub-calls itself it reached ${a.valuesReached}`
        + ` of 40 records (${a.subcallsFailed} sub-call(s) failed) and named the`
        + ` ${a.scored ? 'CORRECT' : 'wrong'} pair`;
  },
  // The campaign in one table: what each half of the work moved, on the
  // realistic payload shape at the budget where the defect is most
  // visible. Derived from the published rows, so it cannot drift from
  // the measurement it summarises — and it carries the pairwise column,
  // which is the number the whole campaign is judged on.
  'horizon.campaign': () => {
    const rows = data('long-horizon').rows;
    const at = (variant, task, budget) => rows.find((r) => r.variant === variant
      && r.task === task && r.shape === 'late' && r.budget === budget);
    const pct = (x) => (x === null || x === undefined ? '—' : `${(x * 100).toFixed(1)}%`);
    const budget = 6000;

    const lossy = at('synopsis', 'needle', budget);
    const ledger = at('ledger', 'needle', budget);
    const program = at('program', 'pairwise', null);
    const programNeedle = at('program', 'needle', null);
    if (lossy === undefined || ledger === undefined || program === undefined) {
      throw new Error('long-horizon.json is missing a configuration the campaign table names');
    }

    return ['',
      '| configuration | needle | pairwise | what it cost the request |',
      '| --- | --- | --- | --- |',
      `| compaction alone (budget ${budget}) | ${pct(lossy.ceiling)} | ${pct(lossy.ceiling === null ? null : 0)}`
        + ` | ${lossy.charsSent} chars |`,
      `| + a ledger (same budget) | ${pct(ledger.ceilingRecall)} via recall | ${pct(0)}`
        + ` | ${ledger.charsSent} chars |`,
      `| + the environment and a program | ${pct(programNeedle?.ceiling)} | ${pct(program.ceiling)}`
        + ` | ${program.charsSent} chars, against a ${program.charsFull}-char corpus |`,
      ''].join('\n');
  },
  // The recursive path on the cheap tier. This one is published because
  // it FAILED: a measurement that says "we could not get this to run"
  // is a result, and rounding it to silence would be the exact dishonesty
  // the campaign's own rules forbid.
  'horizon.depthLive': () => {
    const depths = data('long-horizon').meta.authoring?.depths;
    if (depths === null || depths === undefined) {
      return 'no live model ran on the machine that generated this file';
    }
    const tasks = depths.reduce((n, row) => n + row.tasks, 0);
    const correct = depths.reduce((n, row) => n + row.correct, 0);
    const calls = depths.reduce((n, row) => n + row.calls, 0);
    const authored = depths.reduce((n, row) => n + row.authored.total, 0);
    const compiled = depths.reduce((n, row) => n + row.authored.compiled, 0);
    const timeouts = depths.reduce((n, row) =>
      n + row.errors.filter((e) => /timeout/i.test(e)).length, 0);
    const levels = depths.map((row) => row.depth).join(' and ');

    if (calls === 0 && timeouts > 0) {
      return `${correct} of ${tasks} tasks at depths ${levels} — every one of them died on the`
        + ' 300-second deadline during its first authoring call, so what this measured is that'
        + ' the recursive path does not currently RUN on this tier, not that it runs badly';
    }
    return `${correct} of ${tasks} tasks answered at depths ${levels}, ${compiled} of ${authored}`
      + ` authored programs compiled, over ${calls} model call(s)`
      + (timeouts === 0 ? '' : ` (${timeouts} attempt(s) lost to the 300-second deadline)`);
  },
  // The live half, as a table: what a real model scored on the realistic
  // payload shape with and without a ledger, and how many times it walked
  // through the door. The recall column is not decoration — a ledger row
  // that scored well with zero recalls scored on what was still in front
  // of it, so the mechanism is only evidenced where that number is not 0.
  'horizon.liveNeedle': () => {
    const rows = data('long-horizon').rows
      .filter((r) => r.task === 'needle' && r.shape === 'late' && r.compacted);
    const budgets = [...new Set(rows.map((r) => r.budget))].sort((a, b) => b - a);
    const cell = (row) => (row === undefined || row.actual === null
      ? '—'
      : `${(row.actual * 100).toFixed(1)}%`);
    const body = budgets.map((budget) => {
      const lossy = rows.find((r) => r.budget === budget && r.variant === 'synopsis');
      const ledger = rows.find((r) => r.budget === budget && r.variant === 'ledger');
      return `| ${budget} | ${cell(lossy)} | ${cell(ledger)} | ${ledger?.recalls ?? 0} |`;
    });
    return ['', '| history budget | without a ledger | with a ledger | recall calls |',
      '| --- | --- | --- | --- |', ...body, ''].join('\n');
  },
  // whether the published file carries a live model's score at all: a
  // keyless regeneration republishes empty actual columns, and prose that
  // said "measured against a model" would then be quoting nothing
  'horizon.live': () => {
    const meta = data('long-horizon').meta;
    return meta.model === null
      ? 'no live model ran on the machine that generated this file'
      : `${meta.model}, ${meta.trials} trial(s) per row, ${meta.calls} model calls`;
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

  // -- retrieval: the instrument's own shape, then the number a ranker
  // would have to beat. Every figure names its corpus size and policy —
  // the suite is a grid, and a number without both coordinates is
  // whichever row sorted first.
  'retrieval.corpus': () => {
    const meta = data('retrieval').meta;
    return `${meta.facts} facts over ${meta.topics} topic vocabularies, ${meta.questions} questions`;
  },
  'retrieval.incumbent': () => {
    const { meta, rows } = data('retrieval');
    const large = meta.sizes[meta.sizes.length - 1];
    const small = meta.sizes[0];
    const at = (size, policy) => {
      const row = rows.find((r) => r.size === size && r.policy === policy);
      if (row === undefined) throw new Error(`retrieval.json has no ${policy} row at ${size} memories — regenerate it before quoting one`);
      return row;
    };
    const pct = (x) => `${(100 * x).toFixed(1)}%`;
    const memories = (n) => n.toLocaleString('en-US');
    return `${memories(large)} memories today's recall puts a gold memory in the top 10 for`
      + ` ${pct(at(large, 'tag+recency').recallAt10)} of questions (recency alone`
      + ` ${pct(at(large, 'recency').recallAt10)}, a random draw ${pct(at(large, 'random').recallAt10)});`
      + ` at ${memories(small)} memories the same policy reaches ${pct(at(small, 'tag+recency').recallAt10)}`;
  },
  'retrieval.ranked': () => {
    // the ranked row beside the default, whichever way it fell — the
    // comparison word is derived, never typed
    const { meta, rows } = data('retrieval');
    const large = meta.sizes[meta.sizes.length - 1];
    const small = meta.sizes[0];
    const at = (size, policy) => {
      const row = rows.find((r) => r.size === size && r.policy === policy);
      if (row === undefined) throw new Error(`retrieval.json has no ${policy} row at ${size} memories — regenerate it before quoting one`);
      return row;
    };
    const pct = (x) => `${(100 * x).toFixed(1)}%`;
    const memories = (n) => n.toLocaleString('en-US');
    const near = at(large, 'near');
    const incumbent = at(large, 'tag+recency');
    const word = near.recallAt10 > incumbent.recallAt10 ? 'ahead of'
      : near.recallAt10 < incumbent.recallAt10 ? 'behind' : 'level with';
    return `${pct(near.recallAt10)} of questions at ${memories(large)} memories through the`
      + ` ${meta.ranked.model} reference embedder (${pct(at(small, 'near').recallAt10)} at ${memories(small)}),`
      + ` ${word} tag match and recency's ${pct(incumbent.recallAt10)}`;
  },

  // -- geo: the kernel suite. Every row of the committed table, the
  // WKT rows beside it, and the LOSSES as a derived sentence — so the
  // prose that says which rows lose can never outlive the numbers.
  'geo.node': () => data('geo').node,
  'geo.table': () => geoTable((row) => !row.name.startsWith('wkt ')),
  'geo.wktTable': () => geoTable((row) => row.name.startsWith('wkt ')),
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
    return `The as-of join costs ${ratio(figures.kernelAsOfVsStored)}× a handful of index reads, `
      + `and beats them by ${ratio(1 / figures.kernelAsOfDenseVsStored)}× once there is one left `
      + 'row per hundred right ones. The reason is the shape rather than the engine: a b-tree pays '
      + 'per probe, and a sorted walk pays for the whole right side whether it was asked one '
      + 'question or a thousand.';
  },
  // -- series: the STORE's own rows, against the statement a hand would
  // have written, against the vocabulary the store replaces, and
  // against the array already in memory. Three ratios per shape,
  // because quoting only the flattering one is the thing D15 forbids.
  'series.storeShapes': () => {
    const { figures } = data('series').meta;
    return `the planned range costs ${ratio(figures.storeRangeVsSql)}× the hand-written `
      + `statement and ${ratio(figures.storeRangeVsResident)}× the resident cut, and the pushed `
      + `bucket ladder ${ratio(figures.storeBucketVsSql)}× the hand-written GROUP BY, `
      + `${ratio(figures.storeBucketVsQuery)}× FASTER than the generic query route, and `
      + `${ratio(figures.storeBucketVsResident)}× the one-pass loop`;
  },
  'series.storeRefinement': () => {
    const { figures } = data('series').meta;
    return `A window measured in time is not pushed: the store answers it at `
      + `${ratio(figures.storeRollingVsResident)}× the kernel over an array already in memory, `
      + `over ${thousands(figures.storeRollingCandidates)} candidates the index bounded. The `
      + `batched as-of join reads ${thousands(figures.storeAsOfCandidates)} rows in `
      + `${figures.storeAsOfStatements} statement and costs `
      + `${ratio(figures.storeAsOfVsIndexReads)}× fifty-one separate index reads — a bound is `
      + 'what it buys, not a speed-up, and without a tolerance a backward join can only be '
      + 'bounded above.';
  },
  'series.zoneCost': () => {
    const { figures } = data('series').meta;
    return `Walking every boundary through an injected zone provider costs `
      + `${ratio(figures.providerCost)}× the integer ladder over an identical answer — near `
      + 'parity because it is near nothing, since the benchmark corpus spans 28 hours and holds '
      + 'two daily boundaries. What the suite gates instead is that the provider is consulted '
      + 'per boundary rather than per sample.';
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
  // and the other half of it, which D10 requires beside the read
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

//#region rewriting

const DOCS = [
  'README.md',
  'docs/ROADMAP.md',
  'benchmark/README.md',
  'packages/contract/README.md',
  'components/charts/README.md',
  'components/md/README.md',
  'components/mermaid/README.md',
  'packages/flow/README.md',
  'packages/view/README.md',
  'packages/josl/README.md',
  'packages/ai/README.md',
  'packages/db/README.md',
  'packages/db/docs/MODEL-FORMAT.md',
  'packages/core/README.md',
  'packages/core/ARCHITECTURE.md',
  'packages/core/docs/GEO.md',
  'packages/core/docs/SERIES.md',
];

/**
 * @typedef {object} GateReport
 * @property {number} code - 0 green, 1 failed
 * @property {string[]} unanswered - markers no derivation could answer
 * @property {string[]} drift - documents whose figure differs from the data
 * @property {string[]} unused - derivations no document quotes
 * @property {string[]} seen - the facts that resolved
 * @property {number} rewritten - documents written (write mode only)
 */

/**
 * Bake (or check) every marker in `docs` against `facts`.
 *
 * There are two ways a document and the data can disagree, and only one
 * of them is repairable by rewriting. A figure that has MOVED is the
 * gate's daily work: `--check` reports it, the write mode fixes it. A
 * marker the data cannot ANSWER — no derivation, or a derivation that
 * throws because the file it reads was never regenerated — is not
 * repairable, and a run that rewrote its way past one would leave last
 * month's number sitting in the document under a success line. So an
 * unanswered marker fails both modes, and fails BEFORE anything is
 * written.
 *
 * @param {{ docs?: string[], facts?: Record<string, () => string>, check?: boolean }} [options]
 * @returns {GateReport}
 */
export function runFactsGate(options = {}) {
  const docs = options.docs ?? DOCS;
  const facts = options.facts ?? FACTS;
  const check = options.check ?? false;
  /** @type {string[]} */
  const unanswered = [];
  /** @type {string[]} */
  const drift = [];
  const seen = new Set();
  /** @type {{ file: string, text: string }[]} */
  const pending = [];

  for (const rel of docs) {
    const file = resolve(ROOT, rel);
    const before = readFileSync(file, 'utf8');
    // The marker grammar, the pairing and the byte-local splice belong to
    // @jarenjs/md — this script owns the DERIVATIONS and nothing else. It
    // used to carry its own regex, which meant the repository had two
    // ideas of what a directive is and only one of them was tested.
    const result = bake(before, {
      ns: 'bm',
      resolve: (key, directive) => {
        if (facts[key] === undefined) {
          unanswered.push(`${rel}: unknown fact '${key}' — no derivation exists for this marker`);
          return undefined;
        }
        const value = facts[key]();
        // counted only once the derivation ANSWERED: a fact whose data is
        // missing throws, and counting it here would let the success line
        // report a coverage the run did not have
        seen.add(key);
        if (value !== directive.body) {
          drift.push(`${rel}: ${key}\n    doc:  ${directive.body.trim()}\n    data: ${value.trim()}`);
        }
        return value;
      },
    });
    // a diagnostic is a marker that did NOT bake — a resolver that threw,
    // or a marker the renderer will never see
    for (const message of result.diagnostics) unanswered.push(`${rel}: ${message}`);
    if (result.changed) pending.push({ file, text: result.text });
  }

  const unused = Object.keys(facts).filter((key) => !seen.has(key));
  let rewritten = 0;
  if (unanswered.length === 0 && !check) {
    for (const entry of pending) {
      writeFileSync(entry.file, entry.text);
      rewritten += 1;
    }
  }
  const failed = unanswered.length > 0 || (check && (drift.length > 0 || unused.length > 0));
  return { code: failed ? 1 : 0, unanswered, drift, unused, seen: [...seen], rewritten };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  const report = runFactsGate({ check });

  if (report.unanswered.length > 0) {
    console.error(`benchmark markers the committed measurements cannot answer `
      + `(${report.unanswered.length}):\n\n${report.unanswered.join('\n')}\n`);
    console.error('nothing was rewritten: regenerate the data these markers derive from, '
      + 'or remove the markers.');
  }
  else if (check) {
    const stale = [...report.drift, ...(report.unused.length > 0
      ? [`facts with no marker in any document: ${report.unused.join(', ')}`]
      : [])];
    if (stale.length > 0) {
      console.error(`benchmark figures are stale (${stale.length}):\n\n${stale.join('\n')}\n`);
      console.error('run `npm run docs:benchmarks` to refresh them from the committed measurements.');
    }
    else {
      console.log(`benchmark figures current (${report.seen.length} facts across ${DOCS.length} documents).`);
    }
  }
  else {
    console.log(`benchmark figures: ${report.seen.length} facts, ${report.rewritten} document(s) rewritten.`);
    if (report.unused.length > 0) console.warn(`WARNING: ${report.unused.join(', ')}`);
  }
  process.exit(report.code);
}

//#endregion
