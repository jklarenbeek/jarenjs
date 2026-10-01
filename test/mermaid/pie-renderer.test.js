//@ts-check
/**
 * @file A pie is drawn by the renderer the host injects. Charts owns the pie
 * engine and hands mermaid `mermaidPieRenderer`; mermaid imports no other
 * component (CONVENTIONS §1). With the renderer injected the SVG is the one
 * mermaid drew before the edge was cut — byte for byte, against fixtures
 * rendered at 59ff8857 — and without one a pie renders the placeholder.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { mermaidPieRenderer } from '@jarenjs/charts/transforms/mermaid-adapter';
import { compileMermaid, diagramToVnode, renderMermaid } from '@jarenjs/mermaid';
import { createMermaidComponent } from '@jarenjs/mermaid/component';
import { mermaidPlugin } from '@jarenjs/mermaid/plugin';
import { mdToVnode, parseMarkdown } from '@jarenjs/md';
import { renderToString } from '@jarenjs/view';

const GOLDEN = JSON.parse(readFileSync(new URL('./fixtures/pie-golden.json', import.meta.url), 'utf8'));
const renderers = { pie: mermaidPieRenderer };

/**
 * The fixtures are V8's bytes, and under V8 they are compared byte for
 * byte. Another engine's `Math.sin`/`Math.cos` may round a coordinate's
 * last digit differently (JavaScriptCore draws 53.391172687938706 where V8
 * draws 53.39117268793872), so there every decimal is compared to 12
 * significant digits and everything else stays exact.
 * @param {string} svg
 */
const comparable = (svg) => (typeof process.versions.bun !== 'string' ? svg
  : svg.replace(/-?\d+\.\d+(?:e[+-]?\d+)?/g, (number) => String(Number(Number(number).toPrecision(12)))));

/** @param {any} entry @param {Record<string, any>} extra */
function render(entry, extra) {
  const options = { ...entry.options, ...extra };
  if (entry.via === 'diagramToVnode') return renderToString(diagramToVnode(entry.source, options));
  const plugins = [mermaidPlugin(options)];
  return renderToString(mdToVnode(parseMarkdown(entry.source, { plugins }), { plugins }));
}

describe('the pie renderer is injected', () => {
  it(`draws the fixtures' bytes with charts' renderer injected (${GOLDEN.cases.length} cases)`, () => {
    assert.ok(GOLDEN.cases.length >= 20);
    for (const entry of GOLDEN.cases) {
      assert.equal(comparable(render(entry, { renderers })), comparable(entry.svg), `${entry.via} ${JSON.stringify(entry.options)} ${entry.source.slice(0, 40)}`);
    }
  });

  it('without a renderer a pie renders the placeholder, never a chart and never an error', () => {
    const source = GOLDEN.cases[0].source;
    for (const svg of [
      renderToString(diagramToVnode(source)),
      renderToString(renderMermaid(source)),
      compileMermaid(source).toSvgString(),
      renderToString(createMermaidComponent().view(source)),
    ]) {
      assert.match(svg, /^<svg class="mermaid mm-svg"/);
      assert.match(svg, />pie diagram</);
      assert.match(svg, /parsed — no pie renderer was injected/);
      assert.doesNotMatch(svg, /mm-pie-slice|mm-error/);
    }
  });

  it('every entry point carries the option through to the dispatcher', () => {
    const source = GOLDEN.cases[0].source;
    const expected = renderToString(diagramToVnode(source, { renderers }));
    assert.match(expected, /mm-pie-slice/);
    assert.equal(renderToString(renderMermaid(source, { renderers })), expected);
    assert.equal(compileMermaid(source, { renderers }).toSvgString(), expected);
    assert.equal(renderToString(createMermaidComponent({ renderers }).view(source)), expected);
  });

  it('a renderer is called with the pie AST, the resolved theme and the hash', () => {
    /** @type {any[]} */
    const calls = [];
    const svg = diagramToVnode('pie title T\n "a" : 1', { theme: 'dark', renderers: {
      pie: (/** @type {any} */ ast, /** @type {any} */ theme, /** @type {string} */ hash) => { calls.push([ast, theme.name, hash]); return ['svg', {}]; },
    } });
    assert.deepEqual(svg, ['svg', {}]);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0][0].slices, [{ label: 'a', value: 1 }]);
    assert.equal(calls[0][1], 'dark');
    assert.match(calls[0][2], /^[0-9a-z]+$/);
  });
});
