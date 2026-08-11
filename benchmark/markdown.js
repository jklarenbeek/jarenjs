#!/usr/bin/env node
//@ts-check
/**
 * @file Markdown benchmark: @jarenjs/md vs marked / markdown-it /
 * micromark.
 *
 * Two measurements, kept honest:
 *
 * 1. CommonMark scorecard — the examples embedded in the official
 *    spec (benchmark/commonmark-spec submodule, spec.txt) run through
 *    every engine; outputs compare after the spec's whitespace
 *    normalization. Two @jarenjs/md rows are scored, because the
 *    package has two emitters and the difference between them is its
 *    safety boundary: the string emitter can pass raw HTML through, and
 *    the vnode emitter structurally cannot (components/md/docs/MD-FORMAT.md
 *    §4.4a). The competitors' numbers under the same normalizer give the
 *    scale.
 *
 * 2. GFM extension scorecard — the same treatment for the five
 *    extension sections of the GFM spec (benchmark/gfm-spec submodule),
 *    with every engine's extensions switched on. The CommonMark corpus
 *    says nothing about tables, task lists, strikethrough, autolink
 *    literals or disallowed raw HTML, so without this the part of the
 *    dialect every engine here advertises would be the only part nobody
 *    measured. Optional: no submodule, no scorecard, and the CommonMark
 *    numbers stand on their own.
 *
 * 3. Performance — parse+render to HTML (every engine's natural unit)
 *    over synthetic documents at three sizes, plus jaren-only rows for
 *    parse-to-AST and the compiled re-render fast path.
 *
 * Usage:
 *   node ./benchmark/markdown.js                 # scorecard + perf
 *   node ./benchmark/markdown.js --score-only
 *   node ./benchmark/markdown.js --profile --iterations 500
 *   node ./benchmark/markdown.js --engines jaren,marked
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parseMarkdown, compileMarkdown, mdToVnode, toHtml } from '@jarenjs/md';
import { timeIt } from './lib/measure.js';
import { extractExamples, normalizeHtml } from './lib/commonmark.js';
import { renderToString } from '@jarenjs/view';
import { marked } from 'marked';
import MarkdownIt from 'markdown-it';
import { micromark } from 'micromark';
import { gfm as micromarkGfm, gfmHtml as micromarkGfmHtml } from 'micromark-extension-gfm';

const SPEC = fileURLToPath(new URL('./commonmark-spec/spec.txt', import.meta.url));
const GFM_SPEC = fileURLToPath(new URL('./gfm-spec/test/spec.txt', import.meta.url));

const args = process.argv.slice(2);
const flags = {
  profile: args.includes('--profile'),
  scoreOnly: args.includes('--score-only'),
  perfOnly: args.includes('--perf-only'),
  verbose: args.includes('--verbose'),
  iterations: Number(args[args.indexOf('--iterations') + 1]) || 200,
  engines: args.includes('--engines') ? args[args.indexOf('--engines') + 1].split(',') : null,
  output: args.includes('--output') ? args[args.indexOf('--output') + 1] : null,
  filepath: args.includes('--filepath') ? args[args.indexOf('--filepath') + 1] : null,
};

// ------------------------------------------------------------------
// Engines: source → HTML string
// ------------------------------------------------------------------

const mdit = new MarkdownIt('commonmark');
// Each rival is configured on its own fastest/fullest route to GFM:
// markdown-it needs `linkify` switched on for extended autolinks (task
// lists are a separate npm plugin it does not ship, and its 0/2 there
// says exactly that — not that it renders them wrongly).
const mditGfm = new MarkdownIt({ html: true, linkify: true })
  .enable(['table', 'strikethrough', 'linkify']);

const ENGINES = [
  {
    name: 'jaren-md',
    // The string emitter, `html: 'raw'` — the like-for-like row: every
    // rival here passes raw HTML through, and this is the path a
    // consumer takes to get an HTML string.
    render: (src) => toHtml(parseMarkdown(src, { gfm: false, frontmatter: false }), { html: 'raw' }),
    renderGfm: (src) => toHtml(parseMarkdown(src, { frontmatter: false }), { html: 'raw' }),
    renderPerf: (src) => toHtml(parseMarkdown(src)),
  },
  {
    // The vnode path, scored beside the string path on purpose: the
    // difference between the two rows IS the safety boundary (a vnode
    // tree cannot hold a lone `</div>`, so raw HTML goes through an
    // allow-list instead), and reporting only the better number would
    // flatter the package.
    name: 'jaren-md (vnode)',
    render: (src) => renderToString(mdToVnode(parseMarkdown(src, { gfm: false, frontmatter: false }), { html: 'vnode' }))
      .slice('<article class="md">'.length, -'</article>'.length),
    renderGfm: (src) => renderToString(mdToVnode(parseMarkdown(src, { frontmatter: false }), { html: 'vnode' }))
      .slice('<article class="md">'.length, -'</article>'.length),
    renderPerf: (src) => renderToString(mdToVnode(parseMarkdown(src))),
  },
  {
    name: 'marked',
    render: (src) => marked.parse(src, { async: false, gfm: false }),
    renderGfm: (src) => marked.parse(src, { async: false, gfm: true }),
    renderPerf: (src) => marked.parse(src, { async: false }),
  },
  {
    name: 'markdown-it',
    render: (src) => mdit.render(src),
    renderGfm: (src) => mditGfm.render(src),
    renderPerf: (src) => mditGfm.render(src),
  },
  {
    name: 'micromark',
    render: (src) => micromark(src, { allowDangerousHtml: true }),
    renderGfm: (src) => micromark(src, {
      allowDangerousHtml: true,
      extensions: [micromarkGfm()],
      htmlExtensions: [micromarkGfmHtml()],
    }),
    renderPerf: (src) => micromark(src, {
      allowDangerousHtml: true,
      extensions: [micromarkGfm()],
      htmlExtensions: [micromarkGfmHtml()],
    }),
  },
].filter((engine) => flags.engines === null || flags.engines.includes(engine.name)
  || (engine.name.startsWith('jaren-md') && flags.engines.includes('jaren')));

// ------------------------------------------------------------------
// CommonMark scorecard
// ------------------------------------------------------------------

/**
 * Score every engine against the CommonMark spec examples.
 * @returns {{ examples: number, scorecard: Record<string, { pass: number, total: number, failures: number[] }> }}
 */
function computeScorecard() {
  if (!existsSync(SPEC)) {
    console.error('commonmark-spec submodule missing; run: git submodule update --init benchmark/commonmark-spec');
    process.exit(1);
  }
  const examples = extractExamples(readFileSync(SPEC, 'utf8'));
  /** @type {Record<string, any>} */
  const scorecard = {};
  for (const engine of ENGINES) {
    let pass = 0;
    const failures = [];
    for (const example of examples) {
      let ok = false;
      try {
        ok = normalizeHtml(String(engine.render(example.markdown)))
          === normalizeHtml(example.html);
      }
      catch {
        ok = false;
      }
      if (ok) pass++;
      else failures.push(example.number);
    }
    scorecard[engine.name] = { pass, total: examples.length, failures };
  }
  return { examples: examples.length, scorecard };
}

function runScorecard() {
  const { examples, scorecard } = computeScorecard();
  console.log(`\nCommonMark scorecard — ${examples} spec examples, whitespace-normalized comparison`);
  for (const engine of ENGINES) {
    const s = scorecard[engine.name];
    const pct = ((100 * s.pass) / examples).toFixed(1);
    console.log(`  ${engine.name.padEnd(17)} ${String(s.pass).padStart(4)} / ${examples}  (${pct}%)`);
    if (flags.verbose && s.failures.length > 0) {
      console.log(`    failing examples: ${s.failures.slice(0, 40).join(', ')}${s.failures.length > 40 ? ', …' : ''}`);
    }
  }
}

// ------------------------------------------------------------------
// GFM extension scorecard
// ------------------------------------------------------------------

/**
 * The extension sections of the GFM specification, in spec order. The
 * CommonMark corpus says nothing about any of them, so without this the
 * five features every engine here advertises would be the only part of
 * the dialect nobody scored.
 */
const GFM_SECTIONS = [
  'Tables (extension)',
  'Task list items (extension)',
  'Strikethrough (extension)',
  'Autolinks (extension)',
  'Disallowed Raw HTML (extension)',
];

/**
 * Score every engine, with its extensions ON, against the GFM spec's
 * extension examples. Returns null when the submodule is absent — the
 * corpus is optional, and a missing one must not take the CommonMark
 * numbers down with it.
 * @returns {{ examples: number, totals: Record<string, number>,
 *   scorecard: Record<string, { pass: number, total: number,
 *     sections: Record<string, number>, failures: number[] }> } | null}
 */
function computeGfmScorecard() {
  if (!existsSync(GFM_SPEC)) return null;
  const examples = extractExamples(readFileSync(GFM_SPEC, 'utf8'))
    .filter((e) => GFM_SECTIONS.indexOf(e.section) !== -1);
  /** @type {Record<string, number>} */
  const totals = {};
  for (const example of examples) totals[example.section] = (totals[example.section] ?? 0) + 1;
  /** @type {Record<string, any>} */
  const scorecard = {};
  for (const engine of ENGINES) {
    let pass = 0;
    const failures = [];
    /** @type {Record<string, number>} */
    const sections = {};
    for (const section of GFM_SECTIONS) sections[section] = 0;
    for (const example of examples) {
      let ok = false;
      try {
        ok = normalizeHtml(String(engine.renderGfm(example.markdown)))
          === normalizeHtml(example.html);
      }
      catch {
        ok = false;
      }
      if (ok) {
        pass++;
        sections[example.section]++;
      }
      else failures.push(example.number);
    }
    scorecard[engine.name] = { pass, total: examples.length, sections, failures };
  }
  return { examples: examples.length, totals, scorecard };
}

function runGfmScorecard() {
  const result = computeGfmScorecard();
  if (result === null) {
    console.log('\nGFM extension scorecard — skipped'
      + ' (run: git submodule update --init benchmark/gfm-spec)');
    return;
  }
  console.log(`\nGFM extension scorecard — ${result.examples} examples from the spec's`
    + ' five extension sections, every engine\'s extensions on');
  for (const engine of ENGINES) {
    const s = result.scorecard[engine.name];
    const per = GFM_SECTIONS
      .map((section) => `${section.split(' ')[0]} ${s.sections[section]}/${result.totals[section]}`)
      .join('  ');
    console.log(`  ${engine.name.padEnd(17)} ${String(s.pass).padStart(3)} / ${s.total}   ${per}`);
    if (flags.verbose && s.failures.length > 0) {
      console.log(`    failing examples: ${s.failures.join(', ')}`);
    }
  }
}

// ------------------------------------------------------------------
// Performance
// ------------------------------------------------------------------

/**
 * A representative document: headings, paragraphs with inline
 * formatting, lists, a blockquote, code and a GFM table per section.
 * @param {number} sections
 */
function buildDocument(sections) {
  let out = '';
  for (let i = 0; i < sections; i++) {
    out += `## Section ${i}: *typical* content\n\n`
      + `A paragraph with **bold**, *emphasis*, \`inline code\`, a [link](https://example.com/${i} "t"), `
      + 'an ![image](/img.png), some ~~struck~~ text and an autolink <https://example.org/>.\n'
      + 'It wraps across lines\nwith soft breaks and a hard one.  \nDone.\n\n'
      + `- item one of section ${i}\n- item two with *emphasis*\n  - nested item\n- [x] a task\n\n`
      + '> A blockquote with `code` and **bold** content.\n\n'
      + '```js\nfunction demo(n) {\n  return n * 2; // doubled\n}\n```\n\n'
      + `| col a | col b | col c |\n| :---- | :---: | ----: |\n| a${i} | b${i} | c${i} |\n| x | y | z |\n\n`;
  }
  return out;
}

/**
 * Milliseconds per iteration (median-free hot mean, warmup included).
 * @param {() => any} fn
 * @param {number} iterations
 */
const PERF_DOCS = [
  ['~2 kB', buildDocument(3)],
  ['~10 kB', buildDocument(16)],
  ['~100 kB', buildDocument(160)],
];

/**
 * Measure parse+render across engines and Jaren's compiled pipeline.
 * @param {number} iterations
 * @returns {{ iterations: number, render: any[], jaren: any[] }}
 */
function measurePerformance(iterations) {
  const render = [];
  const jaren = [];
  for (const [label, src] of PERF_DOCS) {
    /** @type {Record<string, number>} */
    const results = {};
    for (const engine of ENGINES) {
      results[engine.name] = timeIt(() => engine.renderPerf(src), iterations);
    }
    render.push({ name: label, chars: src.length, results });
    const parseMs = timeIt(() => parseMarkdown(src), iterations);
    const compiled = compileMarkdown(src);
    const vnodeNs = timeIt(() => compiled.toVnode(), iterations) * 1e6;
    jaren.push({ name: label, parseMs, vnodeNs });
  }
  return { iterations, render, jaren };
}

function runPerformance() {
  const perf = measurePerformance(flags.iterations);
  console.log(`\nPerformance — parse + render to HTML, ${perf.iterations} iterations (ms/op)`);
  for (let i = 0; i < perf.render.length; i++) {
    const row = perf.render[i];
    console.log(`  ${row.name} (${row.chars} chars)`);
    const base = row.results['jaren-md'];
    for (const engine of ENGINES) {
      const ms = row.results[engine.name];
      const ratio = engine.name === 'jaren-md' ? '' : ` (${(ms / base).toFixed(2)}x)`;
      console.log(`    ${engine.name.padEnd(17)} ${ms.toFixed(4).padStart(9)} ms${ratio}`);
    }
    if (flags.profile) {
      const j = perf.jaren[i];
      console.log(`    ${'· parse→AST'.padEnd(17)} ${j.parseMs.toFixed(4).padStart(9)} ms`);
      console.log(`    ${'· cached vnode'.padEnd(17)} ${j.vnodeNs.toFixed(0).padStart(9)} ns (compiled fast path)`);
    }
  }
}

if (flags.output === 'json') {
  // The website-data shape (benchmark/website-data.js → markdown.json):
  // an engine list, the CommonMark scorecard, and the perf profile with
  // Jaren's compiled-pipeline rows.
  const { examples, scorecard } = computeScorecard();
  const gfm = computeGfmScorecard();
  const perf = measurePerformance(flags.iterations);
  const data = {
    date: new Date().toISOString(),
    node: process.version,
    engines: ENGINES.map((e) => e.name),
    examples,
    scorecard: Object.fromEntries(
      Object.entries(scorecard).map(([name, s]) => [name, { pass: s.pass, total: s.total }])),
    gfm: gfm === null ? null : {
      examples: gfm.examples,
      totals: gfm.totals,
      scorecard: Object.fromEntries(Object.entries(gfm.scorecard)
        .map(([name, s]) => [name, { pass: s.pass, total: s.total, sections: s.sections }])),
    },
    profile: {
      iterations: perf.iterations,
      render: perf.render.map((row) => ({ name: row.name, results: row.results })),
      jaren: perf.jaren,
    },
  };
  const json = JSON.stringify(data, null, 2);
  if (flags.filepath !== null) {
    writeFileSync(flags.filepath, json);
    console.log(`\nwrote ${flags.filepath}`);
  }
  else {
    console.log(json);
  }
}
else {
  if (!flags.perfOnly) runScorecard();
  if (!flags.perfOnly) runGfmScorecard();
  if (!flags.scoreOnly) runPerformance();
}
