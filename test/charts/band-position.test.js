//@ts-check
/**
 * A bar sits in the band of its position in the category list, not of its
 * label. Placing it by label put two categories that share one (`['a', 'a',
 * 'b']`) in the same band — the later bar drawn over the earlier, both
 * axis ticks at one place, one band empty — while a boxplot, which placed
 * by position, was right.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { buildBarAST, buildBoxplotAST, scaleBand } from '@jarenjs/charts';

const near = (/** @type {number} */ a, /** @type {number} */ b) => assert.ok(Math.abs(a - b) < 1e-12, `${a} vs ${b}`);

describe('scaleBand — start(index) is the band of a position', function () {
  it('agrees with the label lookup when labels are unique', () => {
    const band = scaleBand(['x', 'y', 'z'], 0.2);
    for (const [i, label] of ['x', 'y', 'z'].entries()) assert.equal(band.start(i), band(label));
  });

  it('keeps the bands of repeated labels apart', () => {
    const band = scaleBand(['a', 'a', 'b'], 0.25);
    near(band.start(0), 1 / 24);
    near(band.start(1), 1 / 3 + 1 / 24);
    near(band.start(2), 2 / 3 + 1 / 24);
    assert.equal(band('a'), band.start(1)); // the label lookup is last-wins, which is why bars must not use it
  });
});

describe('bar — repeated category labels get their own bands', function () {
  const spec = { categories: ['a', 'a', 'b'], series: [{ name: 's', values: [1, 2, 3] }] };

  it('places each bar and tick by position', () => {
    const ast = buildBarAST(spec, {});
    assert.deepEqual(ast.bars.map((b) => b.value), [1, 2, 3]);
    near(ast.bars[0].u0, 1 / 24 + 0.015);
    near(ast.bars[1].u0, 1 / 3 + 1 / 24 + 0.015);
    near(ast.bars[2].u0, 2 / 3 + 1 / 24 + 0.015);
    assert.ok(ast.bars[0].u1 < ast.bars[1].u0 && ast.bars[1].u1 < ast.bars[2].u0);
    for (const [i, tick] of ast.cat.ticks.entries()) near(tick.pos, (i + 0.5) / 3);
  });

  it('stacked bars of repeated labels do not share a column', () => {
    const ast = buildBarAST(spec, { stacked: true });
    assert.equal(new Set(ast.bars.map((b) => b.u0)).size, 3);
  });
});

describe('boxplot — unchanged for repeated labels', function () {
  it('places boxes by position', () => {
    const ast = buildBoxplotAST({ boxes: [{ label: 'a', values: [1, 2, 3] }, { label: 'a', values: [2, 3, 4] }] }, {});
    assert.ok(ast.boxes[0].u1 < ast.boxes[1].u0);
  });
});
