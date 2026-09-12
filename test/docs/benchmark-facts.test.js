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
import { scanSourceDirectives } from '@jarenjs/md';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

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

  /** The `[start, end)` spans a derivation owns in one document. One
   * namespace, so one scan answers for every registry. */
  const derived = (text) => scanSourceDirectives(text, { ns: NS }).directives
    .map((directive) => [directive.bodyStart, directive.bodyEnd]);

  it('no committed markdown types one outside a derived block', () => {
    const files = execFileSync('git', ['ls-files', '*.md'],
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\n').filter(Boolean).filter(file => existsSync(join(ROOT, file)));
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
    const files = execFileSync('git', ['ls-files', '*.md'],
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\n').filter(Boolean).filter(file => existsSync(join(ROOT, file)));
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
