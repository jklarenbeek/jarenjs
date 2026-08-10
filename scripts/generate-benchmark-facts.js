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
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  'md.vsMicromark': () => {
    const ratios = data('markdown').profile.render.map((row) => row.results.micromark / row.results['jaren-md']);
    return band(ratios, ratio);
  },
  'md.cachedNs': () => band(data('markdown').profile.jaren.map((r) => r.vnodeNs), ns),

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
  'components/md/README.md',
  'components/mermaid/README.md',
  'packages/flow/README.md',
  'packages/view/README.md',
  'packages/josl/README.md',
];

const MARKER = /<!--bm:([\w.]+)-->([\s\S]*?)<!--\/bm-->/g;

const check = process.argv.includes('--check');
/** @type {string[]} */
const drift = [];
const seen = new Set();
let rewritten = 0;

for (const rel of DOCS) {
  const path = join(ROOT, rel);
  const before = readFileSync(path, 'utf8');
  const after = before.replace(MARKER, (whole, key, body) => {
    if (FACTS[key] === undefined) {
      drift.push(`${rel}: unknown fact '${key}' — no derivation exists for this marker`);
      return whole;
    }
    seen.add(key);
    const value = FACTS[key]();
    if (value !== body) drift.push(`${rel}: ${key}\n    doc:  ${body.trim()}\n    data: ${value.trim()}`);
    return `<!--bm:${key}-->${value}<!--/bm-->`;
  });
  if (after !== before && !check) {
    writeFileSync(path, after);
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
