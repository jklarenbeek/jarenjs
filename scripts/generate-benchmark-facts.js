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
 * of them had drifted, in both directions — the root README understated
 * its own JSONPath result as 18.7x when the committed data said 23.1x,
 * and understated three per-draft win counts. A figure nobody can
 * recompute is a figure nobody can trust.
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
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { bake } from '@jarenjs/md';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const DATA = join(ROOT, 'packages/website/public/benchmarks');

/** @type {Record<string, any>} */
const cache = {};
const data = (name) => (cache[name] ??= JSON.parse(readFileSync(join(DATA, `${name}.json`), 'utf8')));

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
/** The min and max of a list, as a `lo–hi` band. */
const band = (xs, fmt) => `${fmt(Math.min(...xs))}–${fmt(Math.max(...xs))}`;

//#endregion

/** Mean of one engine's column across profile rows. */
const meanOf = (rows, engine) => rows.reduce((a, r) => a + r.engines[engine], 0) / rows.length;

/** A row from a labelled `[{label, ns}]` list. */
const byLabel = (rows, label) => rows.find((r) => r.label === label);

/** One conformance row as `pass of total (pct%)`. */
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
 * Every fact, keyed by its marker name. A fact returns the exact text
 * that replaces the marker's body — including any markdown emphasis, so
 * a table cell keeps its bolding.
 * @type {Record<string, () => string>}
 */
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
    const nodes = [...new Set(suites.map((s) => data(s).node).filter(Boolean))];
    const when = dates.length === 1 ? dates[0] : `${dates[0]}–${dates[dates.length - 1]}`;
    return `${when} with Node ${nodes.length === 1 ? nodes[0] : nodes.join('/')}`;
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

  // ——— @jarenjs/json: JSONPath compliance-suite profile ———
  'jsonpath.ctsRatio': () => {
    const rows = data('jsonpath').profile.rows;
    return ratio(meanOf(rows, 'json-p3') / meanOf(rows, 'jaren'));
  },
  'jsonpath.ctsTimes': () => {
    const rows = data('jsonpath').profile.rows;
    return `${ns(meanOf(rows, 'jaren'))} ns vs ${us(meanOf(rows, 'json-p3'))} µs`;
  },

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
};

//#region rewriting

const DOCS = [
  'README.md',
  'docs/ROADMAP.md',
  'components/md/README.md',
  'components/mermaid/README.md',
  'packages/flow/README.md',
  'packages/view/README.md',
  'packages/josl/README.md',
  'packages/ai/README.md',
];

const check = process.argv.includes('--check');
/** @type {string[]} */
const drift = [];
const seen = new Set();
let rewritten = 0;

for (const rel of DOCS) {
  const path = join(ROOT, rel);
  const before = readFileSync(path, 'utf8');
  // The marker grammar, the pairing and the byte-local splice belong to
  // @jarenjs/md — this script owns the DERIVATIONS and nothing else. It
  // used to carry its own regex, which meant the repository had two
  // ideas of what a directive is and only one of them was tested.
  const result = bake(before, {
    ns: 'bm',
    resolve: (key, directive) => {
      if (FACTS[key] === undefined) {
        drift.push(`${rel}: unknown fact '${key}' — no derivation exists for this marker`);
        return undefined;
      }
      seen.add(key);
      const value = FACTS[key]();
      if (value !== directive.body) {
        drift.push(`${rel}: ${key}\n    doc:  ${directive.body.trim()}\n    data: ${value.trim()}`);
      }
      return value;
    },
  });
  for (const message of result.diagnostics) drift.push(`${rel}: ${message}`);
  if (result.changed && !check) {
    writeFileSync(path, result.text);
    rewritten += 1;
  }
}

const unused = Object.keys(FACTS).filter((key) => !seen.has(key));
if (unused.length > 0) drift.push(`facts with no marker in any document: ${unused.join(', ')}`);

if (check) {
  if (drift.length > 0) {
    console.error(`benchmark figures are stale (${drift.length}):\n\n${drift.join('\n')}\n`);
    console.error('run `npm run docs:benchmarks` to refresh them from the committed measurements.');
    process.exit(1);
  }
  console.log(`benchmark figures current (${seen.size} facts across ${DOCS.length} documents).`);
}
else {
  console.log(`benchmark figures: ${seen.size} facts, ${rewritten} document(s) rewritten.`);
  if (unused.length > 0) console.warn(`WARNING: ${unused.join(', ')}`);
}

//#endregion
