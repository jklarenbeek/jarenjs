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

describe('edge labels are measured and do not cover each other', function () {
  const boxesOf = (source) => layoutDiagram(parseMermaid(source)).edges
    .filter((e) => e.labelPos !== null)
    .map((e) => ({ label: e.label, x: e.labelPos.x, y: e.labelPos.y, w: e.labelW, h: e.labelH }));

  const overlap = (a, b) =>
    Math.abs(a.x - b.x) * 2 < a.w + b.w && Math.abs(a.y - b.y) * 2 < a.h + b.h;

  it('separates two long labels on edges leaving one node', function () {
    // The failure this fixes: both midpoints land at the same height, so the
    // second label's opaque background covered the first.
    const boxes = boxesOf('flowchart TD\n'
      + '  S["JSON Schema"]\n  T["TypeScript type"]\n  V["compiled validator"]\n'
      + '  S -->|"@jarenjs/emit"| T\n  S -->|"@jarenjs/validate"| V');
    assert.equal(boxes.length, 2);
    assert.ok(!overlap(boxes[0], boxes[1]),
      `labels still overlap: ${JSON.stringify(boxes)}`);
  });

  it('keeps a label off the node boxes as well', function () {
    // A label sitting on top of an unrelated box reads as that box's own text.
    const scene = layoutDiagram(parseMermaid('flowchart TD\n'
      + '  S["JSON Schema"]\n  T["TypeScript type"]\n  V["compiled validator"]\n'
      + '  S -->|"@jarenjs/emit"| T\n  S -->|"@jarenjs/validate"| V'));
    const nodes = scene.nodes.map((n) => ({
      id: n.id, x: n.x + n.w / 2, y: n.y + n.h / 2, w: n.w, h: n.h,
    }));
    for (const e of scene.edges) {
      const box = { x: e.labelPos.x, y: e.labelPos.y, w: e.labelW, h: e.labelH };
      for (const n of nodes) {
        assert.ok(!overlap(box, n),
          `label "${e.label}" sits on node ${n.id}`);
      }
    }
  });

  it('leaves a lone label on its edge midpoint', function () {
    // Nothing to avoid means nothing should move: the natural position is the
    // right one, and a collision pass that perturbs it anyway is a regression.
    const doc = parseMermaid('flowchart LR\n  A["a"] -->|"x"| B["b"]');
    const scene = layoutDiagram(doc);
    const [e] = scene.edges;
    const [p1, p2] = e.points;
    assert.ok(Math.abs(e.labelPos.x - (p1.x + p2.x) / 2) < 0.001);
    assert.ok(Math.abs(e.labelPos.y - (p1.y + p2.y) / 2) < 0.001);
  });

  it('measures the label rather than counting characters', function () {
    // `WWWW` and `iiii` are the same length and nowhere near the same width;
    // a character-count estimate gave both the same background and let the
    // wide one overflow its own box.
    const wide = boxesOf('flowchart LR\n  A -->|"WWWW"| B')[0];
    const narrow = boxesOf('flowchart LR\n  A -->|"iiii"| B')[0];
    assert.ok(wide.w > narrow.w,
      `expected a wider box for wide glyphs: ${wide.w} vs ${narrow.w}`);
  });

  it('places labels deterministically', function () {
    const source = 'flowchart TD\n  S["s"]\n  A["a"]\n  B["b"]\n'
      + '  S -->|"a long label here"| A\n  S -->|"another long label"| B';
    assert.deepEqual(boxesOf(source), boxesOf(source));
  });

  it('hands the renderer the measured box', async function () {
    const { renderMermaid } = await import('@jarenjs/mermaid');
    const { renderToString } = await import('@jarenjs/view');
    const doc = parseMermaid('flowchart LR\n  A -->|"WWWWWWWW"| B');
    const scene = layoutDiagram(doc);
    const svg = renderToString(renderMermaid(doc));
    // The background rect must be the width the layout measured, so the text
    // it sits behind actually fits inside it.
    assert.ok(svg.includes(`width="${Math.round(scene.edges[0].labelW * 100) / 100}"`)
      || svg.includes(`width="${scene.edges[0].labelW}"`),
    `expected the measured width ${scene.edges[0].labelW} in the output`);
  });
});
