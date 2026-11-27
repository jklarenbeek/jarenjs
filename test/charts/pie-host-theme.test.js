//@ts-check
/**
 * @file A pie's text follows a host's theme flip. Under a theme whose text
 * token links a host property, every `<text>` a pie draws carries a class
 * its stylesheet paints with that token: charts' own pie its title's
 * `chart-title` (its legend through `chart-pie-legend`), the mermaid pie
 * `mm-text` on its title and legend. Under a concrete theme the mermaid
 * pie's SVG carries no such class (its bytes are pinned by
 * test/mermaid/fixtures/pie-golden.json). The slice separators follow the
 * host's ground the same way: charts' pie through `--chart-slice-stroke`,
 * the mermaid pie through the `mm-separator` class it carries only under a
 * theme whose `edgeLabelBg` links a host property. Slice and swatch fills
 * stay the concrete categorical palette under every theme.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { compileChart, buildPieAST, renderPieAST, CATEGORICAL, createTheme } from '@jarenjs/charts';
import { mermaidPieRenderer } from '@jarenjs/charts/transforms/mermaid-adapter';
import { diagramToVnode, createTheme as createMermaidTheme } from '@jarenjs/mermaid';
import { renderToString } from '@jarenjs/view';

const CHARTS_CSS = readFileSync(new URL('../../components/charts/styles/charts.css', import.meta.url), 'utf8');
const MERMAID_CSS = readFileSync(new URL('../../components/mermaid/styles/mermaid.css', import.meta.url), 'utf8');
const SOURCE = 'pie\n  title Pets\n  "Dogs" : 386\n  "Cats" : 85';
const SLICES = { slices: [{ label: 'Dogs', value: 386 }, { label: 'Cats', value: 85 }] };

/** Each `<text>`: its content, class and fill. @param {string} svg */
const texts = (svg) => [...svg.matchAll(/<text\b([^>]*)>([^<]*)/g)]
  .map((m) => [m[2], /class="([^"]*)"/.exec(m[1])?.[1] ?? null, / fill="([^"]*)"/.exec(m[1])?.[1]]);
/** Each slice and swatch fill. @param {string} svg */
const fills = (svg) => [...svg.matchAll(/<(path|rect)\b[^>]* fill="([^"]*)"/g)].map((m) => `${m[1]} ${m[2]}`);
/** Each slice's stroke attribute and class. @param {string} svg */
const separators = (svg) => [...svg.matchAll(/<path\b[^>]* stroke="([^"]*)"[^>]* class="([^"]*)"/g)].map((m) => `${m[1]} ${m[2]}`);
/** A custom property the root's inline style stamps. @param {string} svg @param {string} name */
const stamp = (svg, name) => new RegExp(`${name}:([^;"]*)`).exec(svg)?.[1].replace(/&quot;/g, '"');
/** @param {any} theme */
const mermaidPie = (theme) => renderToString(diagramToVnode(SOURCE, { theme, renderers: { pie: mermaidPieRenderer } }));

describe('a mermaid pie under a host-linked theme', () => {
  it("marks its title and legend text with the class the mermaid stylesheet paints with the host's text token", () => {
    const svg = mermaidPie('host');
    assert.deepEqual(texts(svg), [
      ['Pets', 'mm-text', '#1f2020'],
      ['Dogs (82.0%)', 'mm-text', '#1f2020'],
      ['Cats (18.0%)', 'mm-text', '#1f2020'],
    ]);
    assert.equal(stamp(svg, '--mm-node-text'), 'var(--fg, #1f2020)');
    assert.match(MERMAID_CSS, /\.mermaid \.mm-text,?[^{]*\{ fill: var\(--mm-node-text\); \}/);
  });

  it('marks them under overrides that link the text token, and keeps the link the overrides name', () => {
    const svg = mermaidPie({ theme: 'dark', vars: { nodeText: '--ink' } });
    assert.deepEqual(texts(svg).map((t) => t[1]), ['mm-text', 'mm-text', 'mm-text']);
    assert.equal(stamp(svg, '--mm-node-text'), 'var(--ink, #f4f4f4)');
  });

  it('carries no such class under a concrete theme, and fills the slices and swatches from the palette under every theme', () => {
    const palette = ['path #2563eb', 'path #f59e0b', 'rect #2563eb', 'rect #f59e0b'];
    for (const theme of ['default', 'dark', { nodeText: '#000000' }, { theme: 'host', vars: { nodeFill: '--surface' } }]) {
      const svg = mermaidPie(theme);
      assert.deepEqual(texts(svg).map((t) => t[1]), [null, null, null], JSON.stringify(theme));
      assert.deepEqual(fills(svg), palette, JSON.stringify(theme));
    }
    assert.deepEqual(fills(mermaidPie('host')), palette);
    // a hand-built theme with no stamp table draws as a concrete one
    const bare = renderToString(mermaidPieRenderer({ title: 'Pets', slices: SLICES.slices }, { tokens: createMermaidTheme('default').tokens }, 'h'));
    assert.deepEqual(texts(bare).map((t) => t[1]), [null, null, null]);
    assert.deepEqual(separators(bare), ['#fff mm-pie-slice', '#fff mm-pie-slice']);
    assert.deepEqual(CATEGORICAL.slice(0, 2), ['#2563eb', '#f59e0b']);
  });
});

describe("a mermaid pie's slice separators", () => {
  it("follow the host's ground under the host theme, as a charts pie's do", () => {
    const svg = mermaidPie('host');
    assert.deepEqual(separators(svg), ['#fff mm-pie-slice mm-separator', '#fff mm-pie-slice mm-separator']);
    assert.equal(stamp(svg, '--mm-edge-label-bg'), 'var(--bg, #ffffff)');
    assert.match(MERMAID_CSS, /\n\.mermaid \.mm-separator \{ stroke: var\(--mm-edge-label-bg\); \}/);
    const charts = compileChart({ type: 'pie', title: 'Pets' }, SLICES, { theme: 'host' }).toSvgString();
    assert.equal(stamp(charts, '--chart-slice-stroke'), 'var(--bg, #ffffff)');
    assert.match(CHARTS_CSS, /\n\.chart-pie-slice \{ stroke: var\(--chart-slice-stroke\); \}/);
  });

  it('follow the link overrides give edgeLabelBg, and stay #fff with no class under a concrete theme', () => {
    const linked = mermaidPie({ theme: 'dark', vars: { edgeLabelBg: '--paper' } });
    assert.deepEqual(separators(linked), ['#fff mm-pie-slice mm-separator', '#fff mm-pie-slice mm-separator']);
    assert.equal(stamp(linked, '--mm-edge-label-bg'), 'var(--paper, #1f2020)');
    for (const theme of ['default', 'dark', { edgeLabelBg: '#000000' }, { theme: 'host', vars: { nodeFill: '--surface' } }]) {
      assert.deepEqual(separators(mermaidPie(theme)), ['#fff mm-pie-slice', '#fff mm-pie-slice'], JSON.stringify(theme));
    }
    // no rule paints a slice that does not carry the class
    assert.doesNotMatch(MERMAID_CSS, /mm-pie-slice/);
  });
});

describe("charts' own pie", () => {
  it('marks its title with the class every chart title carries, under every theme', () => {
    for (const theme of ['host', 'default', 'dark']) {
      const svg = compileChart({ type: 'pie', title: 'Pets' }, SLICES, { theme }).toSvgString();
      assert.deepEqual(texts(svg)[0], ['Pets', 'chart-title', theme === 'dark' ? '#f4f4f4' : '#1f2020'], theme);
      assert.match(svg, /<g class="chart-pie-legend"><rect [^>]*><\/rect><text [^>]*fill="#[0-9a-f]{6}">Dogs/);
    }
    const host = compileChart({ type: 'pie', title: 'Pets' }, SLICES, { theme: 'host' }).toSvgString();
    assert.equal(stamp(host, '--chart-text'), 'var(--fg, #1f2020)');
    assert.match(CHARTS_CSS, /\n\.chart-title \{ fill: var\(--chart-text\); \}/);
    assert.match(CHARTS_CSS, /\n\.chart-pie-legend text \{ fill: var\(--chart-text\); \}/);
  });

  it('renderPieAST takes the title and legend text classes as options', () => {
    const ast = buildPieAST(SLICES, { title: 'Pets' });
    const theme = createTheme('default');
    assert.deepEqual(texts(renderToString(renderPieAST(ast, theme, 'h', { titleClass: null }))).map((t) => t[1]), [null, null, null]);
    assert.deepEqual(texts(renderToString(renderPieAST(ast, theme, 'h', { titleClass: 'a', textClass: 'b' }))).map((t) => t[1]), ['a', 'b', 'b']);
  });
});
