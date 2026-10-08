//@ts-check
/**
 * @file The benchmark-figure drift gate. Every measured number quoted in
 * committed markdown sits between `<!--fact:key-->` markers and is derived
 * from the committed `public/benchmarks/*.json` by
 * `scripts/generate-benchmark-facts.js`. This runs that script's
 * `--check` mode, so the suite fails when a document and the
 * measurements disagree — in either direction, whether the docs were
 * edited by hand or the suites were re-measured.
 *
 * Re-measuring is deliberately NOT part of this: the script only reads
 * the committed numbers, so the gate is instant and machine-independent.
 * `npm run docs:derive` refreshes the prose after a real
 * `benchmark:generate` run.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { NS } from '../../scripts/lib/derive.js';
import { changeflowFigures } from '../../scripts/generate-benchmark-facts.js';
import { scanSourceDirectives } from '@jarenjs/md';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** The `[start, end)` spans a derivation owns in one document. One
 * namespace, so one scan answers for every registry. @param {string} text */
const derived = (text) => scanSourceDirectives(text, { ns: NS }).directives
  .map((directive) => [directive.bodyStart, directive.bodyEnd]);

/** Every committed Markdown document. */
const documents = () => execFileSync('git', ['ls-files', '*.md'],
  { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\n').filter(Boolean).filter(file => existsSync(join(ROOT, file)));

/** A table row's cells; an escaped `\|` stays inside its cell. @param {string} line */
const cells = (line) => line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '').split(/(?<!\\)\|/).length;

/** Every table of `text` (a row of pipes over a delimiter row) as `[header, delimiter]`.
 * @param {string} text @returns {[string, string][]} */
const tablesOf = (text) => {
  const lines = text.split('\n');
  /** @type {[string, string][]} */
  const tables = [];
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i - 1].includes('|') && /^\|?(\s*:?-{3,}:?\s*\|)*\s*:?-{3,}:?\s*\|?$/.test(lines[i].trim()) && lines[i].includes('|'))
      tables.push([lines[i - 1], lines[i]]);
  }
  return tables;
};

describe('quoted benchmark figures match the committed measurements', () => {
  it('no document drifts from the benchmark data', () => {
    try {
      execFileSync(process.execPath, ['scripts/derive-docs.js', '--check'],
        { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    }
    catch (err) {
      assert.fail(`${err.stderr ?? ''}${err.stdout ?? ''}`);
    }
  });
});

describe('a measured bundle size is quoted through a marker, never typed', () => {
  // The failure this closes: `scripts/check-tree-shaking.js` measures ten
  // subpath bundles, and one change to a shared module moves all ten at
  // once. A sentence that TYPED one of those numbers is then wrong, in
  // any document, with nothing looking at it — which is how ten sentences
  // across seven documents came to be 94 bytes stale. Every published
  // copy is `<!--fact:bundle.*-->`, so one bake moves all of them.
  //
  // Only the exact byte figures are checked. The rounded kB are two-digit
  // numbers that occur legitimately everywhere, and they are all in one
  // gated table anyway.
  const baseline = JSON.parse(readFileSync(join(ROOT, 'benchmark/bundle-sizes.json'), 'utf8'));
  const measured = new Map([
    ...Object.entries(baseline.bundles),
    ...Object.entries(baseline.chain).map(([key, bytes]) => [`chain.${key}`, bytes]),
  ].map(([name, bytes]) => [Number(bytes).toLocaleString('en-US'), name]));
  /** The rounded kB `docs/CONSUMING.md` publishes, by subpath. A bare
   * two-digit number is far too common to search for, but `NN kB` is not:
   * the unit is what makes the claim findable. */
  const rounded = new Map(Object.entries(baseline.bundles)
    .map(([name, bytes]) => [String(Math.round(Number(bytes) / 1000)), name]));

  it('has figures distinctive enough to search for', () => {
    assert.strictEqual(measured.size, Object.keys(baseline.bundles).length + Object.keys(baseline.chain).length, `${measured.size} distinct measured figures`);
    for (const figure of measured.keys()) assert.match(figure, /^\d{1,3},\d{3}$/);
  });

  it('no committed markdown types one outside a derived block', () => {
    const files = documents();
    const typed = [];
    let checked = 0;
    for (const file of files) {
      const text = readFileSync(join(ROOT, file), 'utf8');
      const spans = derived(text);
      for (const found of text.matchAll(/\b\d{1,3},\d{3}\b/g)) {
        if (!measured.has(found[0])) continue;
        checked += 1;
        if (spans.some(([from, to]) => found.index >= from && found.index < to)) continue;
        typed.push(`${file}:${text.slice(0, found.index).split('\n').length} `
          + `${found[0]} is the measured '${measured.get(found[0])}' bundle, typed`);
      }
    }
    assert.deepStrictEqual(typed, [],
      'quote it as <!--fact:bundle.NAME-->FIGURE<!--/fact--> so one bake moves every copy');
    // a matcher that stopped matching finds nothing and passes everything
    assert.ok(checked >= 30, `only ${checked} occurrences of a measured figure were found`);
  });

  it('nor a rounded `NN kB` price outside one', () => {
    // The same drift, one decimal place coarser and therefore rarer —
    // which is what made a pen document sit at "(40 kB)" while the table
    // it pointed at published 41.
    const files = documents();
    const typed = [];
    let checked = 0;
    for (const file of files) {
      const text = readFileSync(join(ROOT, file), 'utf8');
      const spans = derived(text);
      for (const found of text.matchAll(/\b(\d{1,3}) kB\b/g)) {
        if (!rounded.has(found[1])) continue;
        checked += 1;
        if (spans.some(([from, to]) => found.index >= from && found.index < to)) continue;
        typed.push(`${file}:${text.slice(0, found.index).split('\n').length} `
          + `${found[1]} kB is the published '${rounded.get(found[1])}' price, typed`);
      }
    }
    assert.deepStrictEqual(typed, [],
      'quote it as <!--fact:bundle.NAME.kb-->FIGURE<!--/fact--> kB');
    // The floor cannot be the raw matches: a baked price reads
    // `32<!--/fact--> kB`, which this pattern deliberately does not match,
    // so a fully-baked tree finds almost none. What must not silently
    // reach zero is the BAKED set, so that is what is counted.
    const baked = files.reduce((n, file) => n
      + [...readFileSync(join(ROOT, file), 'utf8').matchAll(/<!--fact:bundle\.[a-z]+\.kb-->/g)].length, 0);
    assert.ok(baked >= 20, `only ${baked} rounded prices are baked (${checked} typed candidates seen)`);
  });
});

describe('a derived table renders', () => {
  // A Markdown table renders only when its delimiter row has as many cells
  // as its header row; one cell too many leaves the rows as plain text.
  it('every table a derivation wrote has as many delimiter cells as header cells', () => {
    const broken = [];
    let tables = 0;
    for (const file of documents()) {
      const text = readFileSync(join(ROOT, file), 'utf8');
      for (const [from, to] of derived(text)) {
        for (const [header, delimiter] of tablesOf(text.slice(from, to))) {
          tables += 1;
          if (cells(header) !== cells(delimiter))
            broken.push(`${file}: '${header.trim()}' has ${cells(header)} cells, its delimiter ${cells(delimiter)}`);
        }
      }
    }
    assert.deepStrictEqual(broken, []);
    // a matcher that stopped matching finds nothing and passes everything
    assert.ok(tables >= 100, `only ${tables} derived tables were found`);
  });

  it('the change-flow figures render the cascading delete rows a result holds', () => {
    const result = {
      measuredAt: '2026-01-02T03:04:05.000Z', runtime: 'v24.0.0', host: { cpu: 'a cpu' }, samples: 15,
      live: [{ shape: 'graph', strategy: { strategy: 'graph' }, initializationMs: 1, mutationMs: { p50: 0.25, p95: 0.5 }, retainedHeapBytes: 1024 }],
      replication: [{ capture: 'session', envelopes: 15, operations: 15, bytes: 3169, applyMs: { p50: 0.4 }, replayMs: { p50: 0.1 }, conflictMs: { p50: 0.2 } }],
      cascade: [
        { capture: 'session', operations: 121, bytes: 9876, removed: 100, nulled: 20, deleteMs: { p50: 0.7, p95: 0.9 }, applyMs: { p50: 1.5 } },
        { capture: 'journal', operations: 121, bytes: 9876, removed: 100, nulled: 20, deleteMs: { p50: 1.12, p95: 1.4 }, applyMs: { p50: 1.6 } },
      ],
    };
    const text = changeflowFigures(result);
    const lines = text.split('\n');
    const at = lines.indexOf('| Capture | Rows removed | Rows nulled | Operations | Bytes | Delete p50 ms | Delete p95 ms | Apply p50 ms |');
    assert.ok(at > 0, text);
    assert.deepStrictEqual(lines.slice(at + 1, at + 6), [
      '|---|---:|---:|---:|---:|---:|---:|---:|',
      '| session | 100 | 20 | 121 | 9876 | 0.700 | 0.900 | 1.500 |',
      '| journal | 100 | 20 | 121 | 9876 | 1.120 | 1.400 | 1.600 |',
      '',
      "A parent's delete whose foreign keys remove 100 rows and null 20 replicates as the same 121-operation envelope "
        + "from either capture mode. Journal capture reads those rows before the delete runs: its delete p50 is 1.6× session capture's.",
    ]);
    for (const [header, delimiter] of tablesOf(text)) assert.strictEqual(cells(delimiter), cells(header), header);
    // envelopes that differ are not called the same
    const differing = structuredClone(result);
    differing.cascade[1].bytes = 9875;
    assert.match(changeflowFigures(differing), /null 20 replicates as the envelopes above\. Journal capture/);
    // a result measured before the cascading rows existed renders none
    const { cascade: _cascade, ...earlier } = result;
    assert.doesNotMatch(changeflowFigures(earlier), /Rows removed|parent's delete/);
  });
});
