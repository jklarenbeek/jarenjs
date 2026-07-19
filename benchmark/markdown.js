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
 *    normalization. @jarenjs/md is a pragmatic dialect (see
 *    components/md/docs/MD-FORMAT.md §1.3), so its number is a coverage
 *    report, not a compliance claim — the competitors' numbers under
 *    the same normalizer give the scale.
 *
 * 2. Performance — parse+render to HTML (every engine's natural unit)
 *    over synthetic documents at three sizes, plus jaren-only rows for
 *    parse-to-AST and the compiled re-render fast path.
 *
 * Usage:
 *   node ./benchmark/markdown.js                 # scorecard + perf
 *   node ./benchmark/markdown.js --score-only
 *   node ./benchmark/markdown.js --profile --iterations 500
 *   node ./benchmark/markdown.js --engines jaren,marked
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parseMarkdown, compileMarkdown, mdToVnode } from '@jarenjs/md';
import { renderToString } from '@jarenjs/view';
import { marked } from 'marked';
import MarkdownIt from 'markdown-it';
import { micromark } from 'micromark';
import { gfm as micromarkGfm, gfmHtml as micromarkGfmHtml } from 'micromark-extension-gfm';

const SPEC = fileURLToPath(new URL('./commonmark-spec/spec.txt', import.meta.url));

const args = process.argv.slice(2);
const flags = {
  profile: args.includes('--profile'),
  scoreOnly: args.includes('--score-only'),
  perfOnly: args.includes('--perf-only'),
  verbose: args.includes('--verbose'),
  iterations: Number(args[args.indexOf('--iterations') + 1]) || 200,
  engines: args.includes('--engines') ? args[args.indexOf('--engines') + 1].split(',') : null,
};

// ------------------------------------------------------------------
// Engines: source → HTML string
// ------------------------------------------------------------------

const mdit = new MarkdownIt('commonmark');
const mditGfm = new MarkdownIt({ html: true }).enable(['table', 'strikethrough']);

const ENGINES = [
  {
    name: 'jaren-md',
    render: (src) => renderToString(mdToVnode(parseMarkdown(src, { gfm: false, frontmatter: false }), { html: 'text' }))
      .slice('<article class="md">'.length, -'</article>'.length),
    renderPerf: (src) => renderToString(mdToVnode(parseMarkdown(src))),
  },
  {
    name: 'marked',
    render: (src) => marked.parse(src, { async: false, gfm: false }),
    renderPerf: (src) => marked.parse(src, { async: false }),
  },
  {
    name: 'markdown-it',
    render: (src) => mdit.render(src),
    renderPerf: (src) => mditGfm.render(src),
  },
  {
    name: 'micromark',
    render: (src) => micromark(src, { allowDangerousHtml: true }),
    renderPerf: (src) => micromark(src, {
      allowDangerousHtml: true,
      extensions: [micromarkGfm()],
      htmlExtensions: [micromarkGfmHtml()],
    }),
  },
].filter((engine) => flags.engines === null || flags.engines.includes(engine.name)
  || (engine.name === 'jaren-md' && flags.engines.includes('jaren')));

// ------------------------------------------------------------------
// CommonMark scorecard
// ------------------------------------------------------------------

/**
 * Extract the spec's embedded examples (32-backtick example fences,
 * `.` separates markdown from expected html; → is a literal tab).
 * @param {string} spec
 */
function extractExamples(spec) {
  const out = [];
  const re = /^`{32} example\n([\s\S]*?)^\.\n([\s\S]*?)^`{32}$/gm;
  let match;
  while ((match = re.exec(spec)) !== null) {
    out.push({
      markdown: match[1].replace(/→/g, '\t'),
      html: match[2].replace(/→/g, '\t'),
      number: out.length + 1,
    });
  }
  return out;
}

/**
 * The spec's normalization, approximated: collapse whitespace runs,
 * drop whitespace between tags, normalize self-closing voids.
 * @param {string} html
 */
function normalizeHtml(html) {
  return html
    .replace(/\s+/g, ' ')
    .replace(/> </g, '><')
    .replace(/ \/>/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .trim();
}

function runScorecard() {
  if (!existsSync(SPEC)) {
    console.error('commonmark-spec submodule missing; run: git submodule update --init benchmark/commonmark-spec');
    process.exit(1);
  }
  const examples = extractExamples(readFileSync(SPEC, 'utf8'));
  console.log(`\nCommonMark scorecard — ${examples.length} spec examples, whitespace-normalized comparison`);
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
    const pct = ((100 * pass) / examples.length).toFixed(1);
    console.log(`  ${engine.name.padEnd(14)} ${String(pass).padStart(4)} / ${examples.length}  (${pct}%)`);
    if (flags.verbose && failures.length > 0) {
      console.log(`    failing examples: ${failures.slice(0, 40).join(', ')}${failures.length > 40 ? ', …' : ''}`);
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
function timeIt(fn, iterations) {
  fn();
  fn();
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iterations; ++i) fn();
  return Number(process.hrtime.bigint() - t0) / 1e6 / iterations;
}

function runPerformance() {
  const docs = [
    ['~2 kB', buildDocument(3)],
    ['~10 kB', buildDocument(16)],
    ['~100 kB', buildDocument(160)],
  ];
  const iterations = flags.iterations;
  console.log(`\nPerformance — parse + render to HTML, ${iterations} iterations (ms/op)`);
  for (const [label, src] of docs) {
    console.log(`  ${label} (${src.length} chars)`);
    let base = null;
    for (const engine of ENGINES) {
      const ms = timeIt(() => engine.renderPerf(src), iterations);
      if (base === null) base = ms;
      const ratio = engine.name === 'jaren-md' ? '' : ` (${(ms / base).toFixed(2)}x)`;
      console.log(`    ${engine.name.padEnd(14)} ${ms.toFixed(4).padStart(9)} ms${ratio}`);
    }
    if (flags.profile) {
      const parseMs = timeIt(() => parseMarkdown(src), iterations);
      const compiled = compileMarkdown(src);
      const rerenderMs = timeIt(() => compiled.toVnode(), iterations);
      console.log(`    ${'· parse→AST'.padEnd(14)} ${parseMs.toFixed(4).padStart(9)} ms`);
      console.log(`    ${'· cached vnode'.padEnd(14)} ${(rerenderMs * 1e6).toFixed(0).padStart(9)} ns (compiled fast path)`);
    }
  }
}

if (!flags.perfOnly) runScorecard();
if (!flags.scoreOnly) runPerformance();
