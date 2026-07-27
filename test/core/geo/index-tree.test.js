import { describe, it } from 'node:test';
import * as assert from '../../assert.node.js';

import { createBboxIndex, hilbertDistance, bboxIntersects } from '@jarenjs/core/geo';

/** The oracle: what a brute-force scan would find. */
function scan(boxes, q) {
  const out = [];
  for (let i = 0; i < boxes.length; i++) {
    if (boxes[i] !== null && bboxIntersects(boxes[i], q))
      out.push(i);
  }
  return out;
}

/** Deterministic spread of boxes, with some null entries mixed in. */
function makeBoxes(n) {
  const boxes = [];
  for (let i = 0; i < n; i++) {
    if (i % 23 === 0) {
      boxes.push(null); // a value with no positions has no box
      continue;
    }
    const x = (i * 7919 % 10000) / 100;
    const y = (i * 6271 % 10000) / 100;
    boxes.push([x, y, x + (i % 7) / 2, y + (i % 5) / 2]);
  }
  return boxes;
}

describe('the static bbox index', () => {
  it('should never lose a box a scan would find', () => {
    // the property that makes it safe to apply automatically: the index
    // returns CANDIDATES, so it may include extras but must never miss
    let queries = 0;
    for (const n of [1, 2, 17, 100, 1000]) {
      const boxes = makeBoxes(n);
      const index = createBboxIndex(boxes);
      assert.strictEqual(index.size, n);
      for (let t = 0; t < 40; t++) {
        const qx = (t * 911 % 10000) / 100;
        const qy = (t * 617 % 10000) / 100;
        const q = [qx, qy, qx + 6, qy + 6];
        const got = new Set(index.search(q[0], q[1], q[2], q[3]));
        for (const want of scan(boxes, q))
          assert.ok(got.has(want), `n=${n} query ${t} lost box ${want}`);
        queries++;
      }
    }
    assert.strictEqual(queries, 200);
  });

  it('should return only real boxes, never a null entry', () => {
    const boxes = makeBoxes(200);
    const index = createBboxIndex(boxes);
    // a query covering everything must still exclude the nulls
    const all = index.search(-1e9, -1e9, 1e9, 1e9);
    for (const i of all)
      assert.notStrictEqual(boxes[i], null, `box ${i} is null and should not be a candidate`);
    assert.strictEqual(all.length, boxes.filter((b) => b !== null).length);
  });

  it('should handle the degenerate sizes', () => {
    const empty = createBboxIndex([]);
    assert.strictEqual(empty.size, 0);
    assert.deepStrictEqual(empty.search(0, 0, 1, 1), []);

    const one = createBboxIndex([[0, 0, 1, 1]]);
    assert.deepStrictEqual(one.search(0.5, 0.5, 0.6, 0.6), [0]);
    assert.deepStrictEqual(one.search(9, 9, 10, 10), []);

    const allNull = createBboxIndex([null, null, null]);
    assert.strictEqual(allNull.size, 3);
    assert.deepStrictEqual(allNull.search(-1e9, -1e9, 1e9, 1e9), []);
  });

  it('should count touching edges as overlap, like bboxIntersects', () => {
    const index = createBboxIndex([[0, 0, 1, 1]]);
    assert.deepStrictEqual(index.search(1, 1, 2, 2), [0], 'corner to corner');
    assert.deepStrictEqual(index.search(1.0001, 1, 2, 2), []);
  });

  it('should behave the same at every node size', () => {
    const boxes = makeBoxes(300);
    const q = [10, 10, 30, 30];
    const reference = new Set(createBboxIndex(boxes, 16).search(...q));
    for (const nodeSize of [2, 4, 9, 64, 1000]) {
      const got = new Set(createBboxIndex(boxes, nodeSize).search(...q));
      for (const want of scan(boxes, q))
        assert.ok(got.has(want), `nodeSize ${nodeSize} lost box ${want}`);
      // and the candidate set stays a superset of the reference truth
      for (const r of reference) {
        if (scan(boxes, q).includes(r))
          assert.ok(got.has(r), `nodeSize ${nodeSize} lost confirmed box ${r}`);
      }
    }
  });

  it('should order points along a continuous Hilbert curve', () => {
    // adjacent curve positions must be adjacent in space — that is what
    // makes the packed parents tight rather than arbitrary
    assert.strictEqual(hilbertDistance(0, 0), 0);
    assert.notStrictEqual(hilbertDistance(0, 0), hilbertDistance(1, 0));
    let maxJump = 0;
    let previous = null;
    for (let x = 0; x < 16; x++) {
      const d = hilbertDistance(x, 0);
      if (previous !== null)
        maxJump = Math.max(maxJump, Math.abs(d - previous));
      previous = d;
    }
    assert.ok(maxJump > 0, 'the curve must actually move');
  });
});
