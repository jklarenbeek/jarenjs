//@ts-check
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { compileChart, buildPieAST, renderPieAST, CATEGORICAL, createTheme } from '@jarenjs/charts';
import { mermaidPieToChartAST } from '@jarenjs/charts/transforms/mermaid-adapter';
import { renderMermaid, parseMermaid, hashContent, createTheme as createMermaidTheme } from '@jarenjs/mermaid';
import { renderToString, isElementNode } from '@jarenjs/view';

describe('pie AST', function () {
  it('builds fractions and accumulated angles from 12 o\'clock', function () {
    const ast = buildPieAST({ slices: [{ label: 'a', value: 1 }, { label: 'b', value: 3 }] }, { title: 'T' });
    assert.equal(ast.type, 'pie');
    assert.equal(ast.title, 'T');
    assert.equal(ast.total, 4);
    assert.equal(ast.slices[0].frac, 0.25);
    assert.equal(ast.slices[0].start, -Math.PI / 2);
    assert.equal(ast.slices[0].end, ast.slices[1].start);
    assert.ok(Math.abs(ast.slices[1].end - (3 * Math.PI / 2)) < 1e-9);
  });

  it('guards an all-zero total (no NaN fractions)', function () {
    const ast = buildPieAST({ slices: [{ label: 'z', value: 0 }] });
    assert.equal(ast.total, 1);
    assert.equal(ast.slices[0].frac, 0);
  });

  it('is geometry-free (no pixel coordinates in the AST)', function () {
    const ast = buildPieAST({ slices: [{ label: 'a', value: 2 }] });
    assert.deepEqual(Object.keys(ast.slices[0]), ['label', 'value', 'frac', 'start', 'end']);
  });
});

describe('donut variant', function () {
  it('config.donut true uses the default hole fraction; a number sets it', function () {
    assert.equal(buildPieAST({ slices: [] }, {}).inner, null);
    assert.equal(buildPieAST({ slices: [] }, { donut: true }).inner, 0.55);
    assert.equal(buildPieAST({ slices: [] }, { donut: 0.4 }).inner, 0.4);
  });

  it('rejects out-of-range hole fractions (solid pie fallback)', function () {
    assert.equal(buildPieAST({ slices: [] }, { donut: 0 }).inner, null);
    assert.equal(buildPieAST({ slices: [] }, { donut: 1 }).inner, null);
    assert.equal(buildPieAST({ slices: [] }, { donut: -2 }).inner, null);
  });

  it('renders annular slices: two arcs, no line to the center', function () {
    const svg = compileChart({
      type: 'pie', donut: true,
      slices: [{ label: 'a', value: 3 }, { label: 'b', value: 1 }],
    }).toSvgString();
    const d = /d="([^"]+)"/.exec(svg)?.[1] ?? '';
    assert.match(d, /A130,130 /);
    assert.match(d, /A71.5,71.5 /); // the inner arc at 0.55 × R
    assert.doesNotMatch(d, /M150,170 /); // never starts at the center point
  });

  it('a solid pie stays byte-identical when donut is absent', function () {
    const config = { type: 'pie', slices: [{ label: 'x', value: 1 }] };
    const svg = compileChart(config).toSvgString();
    assert.match(svg, /M150,170 L/); // slice paths still start at the center
    assert.doesNotMatch(svg, /A71.5/);
  });
});

describe('pie render', function () {
  it('compileChart produces a cached svg vnode and string', function () {
    const compiled = compileChart({ type: 'pie', title: 'Pets', slices: [{ label: 'Dogs', value: 3 }, { label: 'Cats', value: 1 }] });
    const v = compiled.toVnode();
    assert.ok(isElementNode(v));
    assert.equal(v[0], 'svg');
    assert.equal(compiled.toVnode(), v); // structural sharing
    const svg = compiled.toSvgString();
    assert.equal(svg.startsWith('<svg'), true);
    assert.match(svg, /chart-pie-slice/);
    assert.match(svg, /Dogs \(75\.0%\)/);
  });

  it('golden svg for a fixed input stays stable', function () {
    const compiled = compileChart({ type: 'pie', slices: [{ label: 'x', value: 1 }] });
    const svg = compiled.toSvgString();
    // one full-circle slice, the categorical anchor color, themed legend text
    assert.match(svg, /A130,130 0 1 1/);
    assert.match(svg, new RegExp(`fill="${CATEGORICAL[0]}"`));
    assert.match(svg, /x \(100\.0%\)/);
    assert.match(svg, /--chart-text:#1f2020/);
  });

  it('unknown chart types throw', function () {
    assert.throws(() => compileChart({ type: 'nope' }), /unknown chart type/);
  });

  it("theme 'host' stamps host-linked cssVars, keeps attributes concrete", function () {
    const compiled = compileChart(
      { type: 'pie', slices: [{ label: 'a', value: 1 }] }, undefined, { theme: 'host' });
    const v = compiled.toVnode();
    assert.equal(v[1].style['--chart-text'], 'var(--fg, #1f2020)');
    assert.equal(v[1].style['--chart-slice-stroke'], 'var(--bg, #ffffff)');
    assert.match(compiled.toSvgString(), /stroke="#ffffff"/);
  });
});

describe('mermaid delegation', function () {
  it('mermaid pie output equals charts render with mermaid options', function () {
    const source = 'pie showData\n  title Pets\n  "Dogs" : 40\n  "Cats" : 25\n  "Birds" : 10';
    const doc = parseMermaid(source);
    const { config, data } = mermaidPieToChartAST(doc.ast);
    // the same theme+hash the mermaid dispatcher would use
    const mermaidSvg = renderToString(renderMermaid(source));
    const chartsVnode = renderPieAST(buildPieAST(data, config), mermaidTheme(), doc.meta?.hash ?? '0', {
      rootClass: 'mermaid mm-svg',
      keyPrefix: 'mmpie-',
      sliceClass: 'mm-pie-slice',
      legendClass: 'mm-pie-legend',
      palette: CATEGORICAL,
      textColor: mermaidTheme().tokens.nodeText,
      sliceStroke: '#fff',
    });
    assert.equal(renderToString(chartsVnode), mermaidSvg);
  });
});

/** The mermaid default theme (what its dispatcher passes to renderPie). */
function mermaidTheme() {
  return createMermaidTheme('default');
}

describe('config hashing', function () {
  it('key derives from the stable config string, not object identity', function () {
    const a = compileChart({ type: 'pie', title: 'T', slices: [] });
    const b = compileChart({ title: 'T', slices: [], type: 'pie' });
    assert.equal(a.toVnode()[1].key, b.toVnode()[1].key);
    assert.match(String(a.toVnode()[1].key), /^pie-/);
  });

  it('hashContent stays a string-input primitive (never fed an object)', function () {
    assert.notEqual(hashContent('a'), hashContent('b'));
  });
});

describe('charts theme', function () {
  it('falls back to default for unknown names', function () {
    assert.equal(createTheme('nope').name, 'default');
  });
  it('dark theme flips the token table', function () {
    assert.equal(createTheme('dark').tokens.text, '#f4f4f4');
  });
});
