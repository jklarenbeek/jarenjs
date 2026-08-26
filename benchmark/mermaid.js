#!/usr/bin/env node
//@ts-check
/**
 * @file Mermaid benchmark: @jarenjs/mermaid, measured honestly.
 *
 * Three measurements, each labeled for what it fairly compares:
 *
 * 1. Coverage scorecard — over a curated corpus, the fraction of each
 *    diagram type that jaren-mermaid parses AND renders to SVG without
 *    error. Secondary types (mindmap, gitGraph, …) parse-accept into a
 *    placeholder, counted honestly as "parsed, not laid out".
 *
 * 2. Parse-speed head-to-head — jaren-mermaid vs `@mermaid-js/parser`
 *    (standalone Langium, no DOM). Reality divergence from the TODO: the
 *    standalone parser only covers newer grammars (pie, gitGraph, …) and
 *    cannot parse flowchart/sequence, so the apples-to-apples row is
 *    **pie**. Everything else is jaren-only by necessity.
 *
 * 3. Jaren-only capability — parse→AST and parse→layout→SVG string
 *    (headless, no browser), the pipeline mermaid.js cannot run without a
 *    DOM (mirrors @jarenjs/md's jaren-only rows).
 *
 * 4. Gantt scale — four stages, reported separately at 100 / 1,000 /
 *    10,000 tasks, because they do not scale alike:
 *      `parseMs`  parse AND schedule resolution (dates, dependencies,
 *                 the working calendar);
 *      `layoutMs` the time domain, the tick ladder and every bar;
 *      `vnodeMs`  layout plus the renderer, so render is
 *                 `vnodeMs - layoutMs`;
 *      `svgMs`    the whole pipeline INCLUDING serialization to a
 *                 string, which is what dominates at ten thousand rows.
 *    Every size is checked against its geometry invariants BEFORE it is
 *    timed, and the check is a hard exit: a fast wrong answer is not a
 *    result.
 *
 * Usage:
 *   node ./benchmark/mermaid.js                       # scorecard + perf
 *   node ./benchmark/mermaid.js --profile --iterations 500
 *   node ./benchmark/mermaid.js --output json --filepath out.json
 */

import { writeFileSync } from 'node:fs';

import { parseMermaid, compileMermaid, layoutDiagram, diagramToVnode } from '@jarenjs/mermaid';
import { CORPUS, PIE_CORPUS, buildScaled, buildGantt } from './fixtures/mermaid.js';
import { timeIt } from './lib/measure.js';

const args = process.argv.slice(2);
const flags = {
  profile: args.includes('--profile'),
  iterations: Number(args[args.indexOf('--iterations') + 1]) || 200,
  output: args.includes('--output') ? args[args.indexOf('--output') + 1] : null,
  filepath: args.includes('--filepath') ? args[args.indexOf('--filepath') + 1] : null,
};

// Two optional competitors, both loaded dynamically so the benchmark
// runs jaren-only when neither is installed.
//
// 1. `@mermaid-js/parser` — the standalone Langium parser. It only
//    covers the newer grammars that have been migrated off Jison (pie,
//    gitGraph, packet, radar, …) and CANNOT parse flowchart or sequence.
//    So its head-to-head runs on the overlapping type: pie.
//
// 2. `mermaid` (the full package) — flowchart and sequence are still
//    parsed by the original in-tree **Jison** grammars
//    (src/diagrams/{flowchart,sequence}/parser/*.jison), not by
//    @mermaid-js/parser. `mermaid.parse()` runs that path; it is
//    DOM-coupled, so we give it a jsdom global. This is the fair
//    flowchart/sequence parse head-to-head @mermaid-js/parser can't
//    provide. Note it is async and also does type-detection + config
//    resolution + validation, so it measures mermaid's whole parse
//    front-end, not a bare Jison microbenchmark — labeled accordingly.

let mmParse = null;
try {
  const mod = await import('@mermaid-js/parser');
  mmParse = mod.parse;
}
catch {
  console.warn('note: @mermaid-js/parser not installed; the pie head-to-head row is skipped.');
  console.warn('  (add it with: npm install --save-dev --workspace=jarenjs-benchmark @mermaid-js/parser)');
}

let jisonParse = null;
try {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!DOCTYPE html><body></body>', { pretendToBeVisual: true });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  if (!globalThis.getComputedStyle) globalThis.getComputedStyle = dom.window.getComputedStyle;
  const mermaid = (await import('mermaid')).default;
  mermaid.initialize({ startOnLoad: false });
  // Prime + smoke-test both grammars before trusting the path.
  await mermaid.parse('flowchart TD\n A-->B');
  await mermaid.parse('sequenceDiagram\n A->>B: x');
  jisonParse = (text) => mermaid.parse(text);
}
catch (e) {
  console.warn(`note: mermaid (Jison, via jsdom) unavailable; the flowchart/sequence head-to-head is skipped (${String(e.message).split('\n')[0]}).`);
  console.warn('  (add it with: npm install --save-dev --workspace=jarenjs-benchmark mermaid jsdom)');
}

// ------------------------------------------------------------------
// Coverage scorecard
// ------------------------------------------------------------------

/**
 * @returns {{ examples: number, scorecard: Record<string, { rendered: number, total: number }> }}
 */
function computeScorecard() {
  /** @type {Record<string, any>} */
  const scorecard = {};
  let examples = 0;
  for (const [type, docs] of Object.entries(CORPUS)) {
    let rendered = 0;
    for (const src of docs) {
      examples++;
      try {
        const svg = compileMermaid(src).toSvgString();
        if (svg.startsWith('<svg') && !svg.includes('mm-error')) rendered++;
      }
      catch { /* counted as not rendered */ }
    }
    scorecard[type] = { rendered, total: docs.length };
  }
  return { examples, scorecard };
}

// ------------------------------------------------------------------
// Perf
// ------------------------------------------------------------------

/**
 * @param {() => any} fn @param {number} iterations
 * @returns {number} ms/op
 */
/**
 * @param {() => Promise<any>} fn @param {number} iterations
 * @returns {Promise<number>} ms/op
 */
async function timeItAsync(fn, iterations) {
  for (let w = 0; w < 5; w++) await fn(); // warm JIT + grammar init + settle GC
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iterations; ++i) await fn();
  return Number(process.hrtime.bigint() - t0) / 1e6 / iterations;
}

const SCALES = [
  ['~5 nodes', 5],
  ['~25 nodes', 25],
  ['~100 nodes', 100],
];

/** The flowchart/sequence head-to-head sizes (fewer, since Jison is slow). */
const JISON_SCALES = [
  ['~5 nodes', 5],
  ['~25 nodes', 25],
];

/** Gantt scale: the sizes the schedule resolver and the timeline are reported at. */
const GANTT_SCALES = [100, 1000, 10000];

/**
 * The invariants a scaled Gantt must satisfy before it is timed. They
 * are the answer, not the shape of it: ids are unique, every span is
 * ordered and inside the shared domain, every bar is inside the plot,
 * and the ticks ascend. Anything red here exits non-zero — publishing a
 * median for a wrong timeline is worse than publishing nothing.
 *
 * @param {string} src
 * @param {number} expected
 * @returns {void}
 */
function checkGantt(src, expected) {
  const problems = [];
  const doc = parseMermaid(src);
  const tasks = doc.ast.sections.flatMap((s) => s.tasks);
  const ids = new Set(tasks.map((t) => t.id));
  if (tasks.length !== expected)
    problems.push(`parsed ${tasks.length} tasks, expected ${expected}`);
  if (ids.size !== tasks.length)
    problems.push(`${tasks.length - ids.size} duplicate task ids`);
  for (const task of tasks) {
    if (!(task.end >= task.start)) problems.push(`${task.id} ends before it starts`);
    if (task.duration !== task.end - task.start) problems.push(`${task.id} duration disagrees`);
    if (task.start < doc.ast.domain.start || task.end > doc.ast.domain.end)
      problems.push(`${task.id} falls outside the domain`);
  }
  const scene = layoutDiagram(doc);
  if (scene.rows.length !== expected)
    problems.push(`laid out ${scene.rows.length} rows, expected ${expected}`);
  for (const row of scene.rows) {
    if (row.x < scene.plot.x - 0.01 || row.x + row.w > scene.plot.x + scene.plot.w + 0.01)
      problems.push(`row ${row.id} is outside the plot`);
  }
  for (let i = 1; i < scene.ticks.length; i++) {
    if (scene.ticks[i].at <= scene.ticks[i - 1].at)
      problems.push('the ticks are not ascending');
  }
  const svg = compileMermaid(src).toSvgString();
  if (!svg.startsWith('<svg') || svg.includes('mm-error'))
    problems.push('the document did not render');
  if (problems.length > 0) {
    console.error(`\ngantt ${expected}: equivalence failed before timing`);
    for (const problem of problems.slice(0, 5)) console.error(`  - ${problem}`);
    process.exit(1);
  }
}

/**
 * @param {number} iterations
 */
async function measure(iterations) {
  // Head-to-head 1: pie parse, vs @mermaid-js/parser (Langium).
  const parse = [];
  if (mmParse !== null) {
    for (let i = 0; i < PIE_CORPUS.length; i++) {
      const src = PIE_CORPUS[i];
      const results = {
        'jaren-mermaid': timeIt(() => parseMermaid(src), iterations),
        '@mermaid-js/parser': timeIt(() => mmParse('pie', src), Math.max(20, iterations >> 2)),
      };
      parse.push({ name: `pie ${i + 1}`, results });
    }
  }

  // Head-to-head 2: flowchart/sequence parse, vs mermaid.parse (Jison).
  const parseJison = [];
  if (jisonParse !== null) {
    for (const [label, n] of JISON_SCALES) {
      const { flowchart, sequence } = buildScaled(n);
      for (const [kind, src] of [['flowchart', flowchart], ['sequence', sequence]]) {
        const jarenMs = timeIt(() => parseMermaid(src), Math.max(20, iterations >> 1));
        // mermaid.parse is async, DOM-coupled and slower — fewer
        // iterations, but enough to average out a GC pause.
        const mermaidMs = await timeItAsync(() => jisonParse(src), Math.max(30, iterations >> 2));
        parseJison.push({ name: `${kind} ${label}`, results: { 'jaren-mermaid': jarenMs, 'mermaid (jison)': mermaidMs } });
      }
    }
  }

  // Jaren-only: parse→AST and parse→layout→SVG string, per size.
  const jaren = [];
  for (const [label, n] of SCALES) {
    const { flowchart, sequence } = buildScaled(n);
    for (const [kind, src] of [['flowchart', flowchart], ['sequence', sequence]]) {
      const parseMs = timeIt(() => parseMermaid(src), Math.max(20, iterations >> 1));
      const svgMs = timeIt(() => compileMermaid(src).toSvgString(), Math.max(20, iterations >> 2));
      jaren.push({ name: `${kind} ${label}`, chars: src.length, parseMs, svgMs });
    }
  }

  // Gantt scale: parse (resolution), layout (geometry) and render,
  // separately, each size gated on its invariants first.
  const gantt = [];
  for (const n of GANTT_SCALES) {
    const src = buildGantt(n);
    checkGantt(src, n);
    const rounds = n >= 10000 ? 5 : Math.max(10, iterations >> 3);
    const doc = parseMermaid(src);
    const parseMs = timeIt(() => parseMermaid(src), rounds);
    const layoutMs = timeIt(() => layoutDiagram(doc), rounds);
    const vnodeMs = timeIt(() => diagramToVnode(doc), Math.max(3, rounds >> 1));
    const svgMs = timeIt(() => compileMermaid(src).toSvgString(), Math.max(3, rounds >> 1));
    gantt.push({
      name: `gantt ${n} tasks`, tasks: n, chars: src.length,
      parseMs, layoutMs, vnodeMs, svgMs,
    });
  }
  return { iterations, parse, parseJison, jaren, gantt };
}

// ------------------------------------------------------------------
// Output
// ------------------------------------------------------------------

const engines = mmParse !== null ? ['jaren-mermaid', '@mermaid-js/parser'] : ['jaren-mermaid'];
const jisonEngines = ['jaren-mermaid', 'mermaid (jison)'];

if (flags.output === 'json') {
  const { examples, scorecard } = computeScorecard();
  const profile = await measure(flags.iterations);
  const data = {
    date: new Date().toISOString(),
    node: process.version,
    engines,
    jisonEngines: jisonParse !== null ? jisonEngines : undefined,
    examples,
    scorecard,
    profile,
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
  const { examples, scorecard } = computeScorecard();
  console.log(`\nCoverage scorecard — ${examples} corpus diagrams (rendered to SVG without error)`);
  for (const [type, s] of Object.entries(scorecard)) {
    console.log(`  ${type.padEnd(12)} ${s.rendered} / ${s.total}`);
  }
  const profile = await measure(flags.iterations);
  if (profile.parse.length > 0) {
    console.log(`\nParse-speed head-to-head — pie vs @mermaid-js/parser (Langium), ${profile.iterations} iterations (ms/op, lower is better)`);
    for (const row of profile.parse) {
      console.log(`  ${row.name}`);
      for (const e of engines) console.log(`    ${e.padEnd(20)} ${row.results[e].toFixed(5)} ms`);
    }
  }
  if (profile.parseJison.length > 0) {
    console.log('\nParse-speed head-to-head — flowchart/sequence vs mermaid.parse (Jison, via jsdom; async, full parse front-end)');
    for (const row of profile.parseJison) {
      console.log(`  ${row.name}`);
      for (const e of jisonEngines) console.log(`    ${e.padEnd(20)} ${row.results[e].toFixed(5)} ms`);
    }
  }
  console.log('\nJaren-only — parse→AST and parse→layout→SVG (headless, no browser)');
  for (const row of profile.jaren) {
    console.log(`  ${row.name.padEnd(22)} parse ${row.parseMs.toFixed(4)} ms   svg ${row.svgMs.toFixed(4)} ms`);
  }
  console.log('\nGantt scale — parse is also schedule resolution; every size checked before timing');
  for (const row of profile.gantt) {
    console.log(`  ${row.name.padEnd(20)} parse ${row.parseMs.toFixed(3)} ms`
      + `  layout ${row.layoutMs.toFixed(3)} ms`
      + `  render ${(row.vnodeMs - row.layoutMs).toFixed(3)} ms`
      + `  svg+string ${row.svgMs.toFixed(3)} ms`);
  }
}
