//@ts-check
/**
 * A bar chart's baseline is zero. Bars rise from the bottom of the plot
 * only when nothing is negative; a domain that crosses zero puts the
 * baseline inside the plot, a negative value hangs below it, and a
 * stacked chart stacks each sign apart.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { compileChart, createChartSession, buildBarAST } from '@jarenjs/charts';
import { renderToString } from '@jarenjs/view';

const near = (/** @type {number} */ a, /** @type {number} */ b) => assert.ok(Math.abs(a - b) < 1e-12, `${a} vs ${b}`);
const geom = (/** @type {any} */ ast) => ast.bars.map((/** @type {any} */ b) => [b.series, b.label, b.value, b.v0, b.v1]);

describe('bar chart below zero', function () {
  const data = { categories: ['a', 'b'], series: [{ name: 's', values: [-3, 5] }, { name: 't', values: [2, -4] }] };

  it('grouped: the domain crosses zero and each bar runs from the zero line to its value', function () {
    const ast = buildBarAST(data, {});
    assert.deepEqual(ast.domain, [-4, 6]);
    assert.deepEqual(ast.val.ticks.map((t) => t.label), ['-4', '-2', '0', '2', '4', '6']);
    assert.deepEqual(geom(ast), [[0, 'a', -3, 0.4, 0.1], [0, 'b', 5, 0.4, 0.9], [1, 'a', 2, 0.4, 0.6], [1, 'b', -4, 0.4, 0]]);
  });

  it('stacked: positives stack up and negatives stack down, apart', function () {
    const stacked = { categories: ['a'], series: [
      { name: 'p', values: [4] }, { name: 'n', values: [-2] }, { name: 'q', values: [2] }, { name: 'm', values: [-1] }] };
    const ast = buildBarAST(stacked, { stacked: true });
    assert.deepEqual(ast.domain, [-4, 6]);
    const g = geom(ast);
    near(g[0][3], 0.4); near(g[0][4], 0.8);   // p: 0 → 4
    near(g[1][3], 0.4); near(g[1][4], 0.2);   // n: 0 → -2
    near(g[2][3], 0.8); near(g[2][4], 1);     // q: 4 → 6
    near(g[3][3], 0.2); near(g[3][4], 0.1);   // m: -2 → -3
  });

  it('an all-negative chart hangs from a baseline at the top of the plot', function () {
    const ast = buildBarAST({ categories: ['a'], series: [{ name: 's', values: [-3] }] }, {});
    assert.deepEqual(ast.domain, [-3, 0]);
    assert.deepEqual(geom(ast), [[0, 'a', -3, 1, 0]]);
  });

  it('a chart with nothing negative is unchanged: zero base, no extra range', function () {
    const ast = buildBarAST({ categories: ['a'], series: [{ name: 's', values: [3] }] }, {});
    assert.deepEqual(ast.domain, [0, 3]);
    assert.deepEqual(geom(ast), [[0, 'a', 3, 0, 1]]);
  });

  it('a log axis has no side below one: negative and zero values still draw nothing', function () {
    const ast = buildBarAST({ categories: ['a', 'b'], series: [{ name: 's', values: [-3, 100] }] }, { log: true });
    assert.deepEqual(ast.bars.map((b) => b.label), ['b']);
  });

  it('a negative bar hangs from the line a positive bar of the same size rises from', function () {
    const rects = (/** @type {any} */ config) => {
      const svg = renderToString(compileChart(config, { categories: ['up', 'down'], series: [{ name: 's', values: [3, -3] }] }).toVnode());
      return [...svg.matchAll(/<rect[^>]*class="chart-bar"[^>]*>/g)].map((m) => {
        const num = (/** @type {string} */ k) => Number(new RegExp(` ${k}="([^"]+)"`).exec(m[0])?.[1]);
        return { x: num('x'), y: num('y'), w: num('width'), h: num('height') };
      });
    };
    const [upV, downV] = rects({ type: 'bar' });
    assert.ok(upV.h > 1);
    assert.equal(downV.h, upV.h);
    assert.equal(downV.y, upV.y + upV.h);
    const [upH, downH] = rects({ type: 'bar', orient: 'h' });
    assert.ok(upH.w > 1);
    assert.equal(downH.w, upH.w);
    assert.equal(upH.x, downH.x + downH.w);
  });

  it('a session repaints a value that stays negative, and matches the wholesale render', function () {
    const truth = { categories: ['a', 'b'], series: [{ name: 's', values: [-3, 5] }] };
    const config = { type: 'bar' };
    const session = createChartSession(config, { getData: () => truth, takeChanges: () => pending.splice(0) });
    /** @type {any[]} */ const pending = [{ op: 'replace', path: '' }];
    assert.equal(session.tick().mode, 'rebuilt');
    truth.series[0].values[0] = -4;
    pending.push({ op: 'replace', path: '/series/0/values/0' });
    const next = session.tick();
    assert.equal(next.mode, 'incremental');
    assert.equal(renderToString(next.vnode), renderToString(compileChart(config, truth).toVnode()));
  });
});
