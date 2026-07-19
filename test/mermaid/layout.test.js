//@ts-check
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { parseMermaid, layoutDiagram } from '@jarenjs/mermaid';

describe('layout is pure and deterministic', function () {
  it('flowchart geometry is stable across runs', function () {
    const doc = parseMermaid('flowchart TD\n  A[Start] --> B[End]');
    const a = layoutDiagram(doc);
    const b = layoutDiagram(parseMermaid('flowchart TD\n  A[Start] --> B[End]'));
    assert.deepEqual(a, b);
    assert.equal(a.type, 'flowchart');
    assert.equal(a.nodes.length, 2);
    // ranks: B below A in TD.
    assert.ok(a.nodes[1].y > a.nodes[0].y);
    assert.ok(a.width > 0 && a.height > 0);
    // edge clipped to two border points.
    assert.equal(a.edges[0].points.length, 2);
  });

  it('LR direction lays out horizontally', function () {
    const scene = layoutDiagram(parseMermaid('flowchart LR\n  A --> B'));
    assert.ok(scene.nodes[1].x > scene.nodes[0].x);
  });

  it('sequence geometry has actors and message y-advance', function () {
    const scene = layoutDiagram(parseMermaid(`sequenceDiagram
      A->>B: one
      B->>A: two`));
    assert.equal(scene.type, 'sequence');
    assert.equal(scene.actors.length, 2);
    assert.ok(scene.messages[1].y > scene.messages[0].y);
    assert.ok(scene.actors[1].x > scene.actors[0].x);
  });
});
