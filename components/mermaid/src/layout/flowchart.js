//@ts-check
/**
 * @file Flowchart layout: a compact "dagre-lite" — longest-path rank
 * assignment, stable within-rank ordering, banded coordinate
 * assignment, and straight border-clipped edge routing. Pure and
 * deterministic (same AST → identical geometry), so the golden-JSON
 * tests catch any drift. Output is a host-free `PositionedDiagram`.
 */

import { measureText } from '@jarenjs/view/helpers';
import { coord as round } from '../utils.js';

import { resolveNodeStyles } from '../styles.js';

const FONT_SIZE = 14;
const PAD_X = 14;
const PAD_Y = 9;
const MIN_W = 48;
const MIN_H = 34;
const RANK_SEP = 54;
const NODE_SEP = 40;
const MARGIN = 12;
const SUBGRAPH_PAD = 18;
const SUBGRAPH_LABEL_H = 22;

/**
 * @param {any} ast flowchart AST
 * @returns {any} PositionedDiagram
 */
export function layoutFlowchart(ast) {
  const nodeStyles = resolveNodeStyles(ast);
  const dir = ast.direction || 'TB';
  const horizontal = dir === 'LR' || dir === 'RL';

  // 1. Node boxes from label metrics.
  /** @type {Map<string, any>} */
  const boxes = new Map();
  for (const node of ast.nodes) {
    boxes.set(node.id, sizeNode(node));
  }

  // 2. Rank assignment (longest path over predecessors).
  const preds = new Map();
  for (const node of ast.nodes) preds.set(node.id, []);
  for (const e of ast.edges) {
    if (preds.has(e.to)) preds.get(e.to).push(e.from);
  }
  const rank = new Map();
  const computing = new Set();
  const rankOf = (id) => {
    if (rank.has(id)) return rank.get(id);
    if (computing.has(id)) return 0;
    computing.add(id);
    let r = 0;
    for (const p of preds.get(id) ?? []) {
      if (p !== id) r = Math.max(r, rankOf(p) + 1);
    }
    computing.delete(id);
    rank.set(id, r);
    return r;
  };
  for (const node of ast.nodes) rankOf(node.id);

  // 3. Group by rank, preserve AST order within a rank.
  /** @type {Map<number, string[]>} */
  const ranks = new Map();
  let maxRank = 0;
  for (const node of ast.nodes) {
    const r = rank.get(node.id);
    if (!ranks.has(r)) ranks.set(r, []);
    ranks.get(r).push(node.id);
    if (r > maxRank) maxRank = r;
  }

  // 4. Cross-axis extent per rank and the along-axis band offsets.
  const bandStart = []; // cumulative main-axis position per rank
  const bandSize = []; // main-axis size (height for TB, width for LR) per rank
  let mainCursor = MARGIN;
  let maxCross = 0;
  for (let r = 0; r <= maxRank; r++) {
    const ids = ranks.get(r) ?? [];
    let mainMax = 0;
    let crossTotal = 0;
    for (let i = 0; i < ids.length; i++) {
      const b = boxes.get(ids[i]);
      const main = horizontal ? b.w : b.h;
      const cross = horizontal ? b.h : b.w;
      if (main > mainMax) mainMax = main;
      crossTotal += cross + (i > 0 ? NODE_SEP : 0);
    }
    bandStart[r] = mainCursor;
    bandSize[r] = mainMax;
    mainCursor += mainMax + RANK_SEP;
    if (crossTotal > maxCross) maxCross = crossTotal;
  }
  const mainTotal = mainCursor - RANK_SEP + MARGIN;

  // 5. Place nodes: center each rank on the cross axis.
  for (let r = 0; r <= maxRank; r++) {
    const ids = ranks.get(r) ?? [];
    let crossTotal = 0;
    for (let i = 0; i < ids.length; i++) {
      const b = boxes.get(ids[i]);
      crossTotal += (horizontal ? b.h : b.w) + (i > 0 ? NODE_SEP : 0);
    }
    let cross = MARGIN + (maxCross - crossTotal) / 2;
    for (let i = 0; i < ids.length; i++) {
      const b = boxes.get(ids[i]);
      const main = horizontal ? b.w : b.h;
      const crossExtent = horizontal ? b.h : b.w;
      const mainPos = bandStart[r] + (bandSize[r] - main) / 2;
      if (horizontal) {
        b.x = mainPos;
        b.y = cross;
      }
      else {
        b.x = cross;
        b.y = mainPos;
      }
      cross += crossExtent + NODE_SEP;
    }
  }

  let width = horizontal ? mainTotal : maxCross + 2 * MARGIN;
  let height = horizontal ? maxCross + 2 * MARGIN : mainTotal;

  // 6. Flip for BT / RL.
  if (dir === 'BT') {
    for (const b of boxes.values()) b.y = height - b.y - b.h;
  }
  else if (dir === 'RL') {
    for (const b of boxes.values()) b.x = width - b.x - b.w;
  }

  // 7. Positioned nodes.
  const nodes = ast.nodes.map((node) => {
    const b = boxes.get(node.id);
    const styles = nodeStyles.get(node.id);
    const box = { id: node.id, x: b.x, y: b.y, w: b.w, h: b.h, shape: node.shape, label: node.label };
    // Carried on the positioned node so the scene stays self-describing: a
    // renderer never has to reach back into the AST to know how to paint.
    if (styles !== undefined) box.styles = styles;
    return box;
  });

  // 8. Edges: straight, clipped to node borders.
  const edges = ast.edges.map((e) => {
    const a = boxes.get(e.from);
    const b = boxes.get(e.to);
    if (a === undefined || b === undefined) {
      return { from: e.from, to: e.to, points: [], label: e.label, labelPos: null, stroke: e.stroke, head: e.head, tail: e.tail };
    }
    const ac = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
    const bc = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
    const p1 = clipToBox(bc, ac, a);
    const p2 = clipToBox(ac, bc, b);
    const edge = {
      from: e.from, to: e.to, points: [p1, p2], label: e.label,
      labelPos: null, stroke: e.stroke, head: e.head, tail: e.tail,
    };
    if (e.label != null) {
      // Measured, not estimated from the character count: the renderer used to
      // guess the background width and a wide label overflowed its own box.
      const m = measureText(e.label, FONT_SIZE);
      edge.labelW = m.width + LABEL_PAD;
      edge.labelH = m.height + LABEL_PAD / 2;
      edge.labelPos = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
    }
    return edge;
  });

  placeEdgeLabels(edges, nodes);

  // 9. Subgraph bounding boxes around their members.
  const subgraphs = ast.subgraphs.map((sg) => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const id of sg.nodes) {
      const b = boxes.get(id);
      if (b === undefined) continue;
      minX = Math.min(minX, b.x); minY = Math.min(minY, b.y);
      maxX = Math.max(maxX, b.x + b.w); maxY = Math.max(maxY, b.y + b.h);
    }
    if (!isFinite(minX)) return { id: sg.id, label: sg.label, x: 0, y: 0, w: 0, h: 0 };
    return {
      id: sg.id,
      label: sg.label,
      x: minX - SUBGRAPH_PAD,
      y: minY - SUBGRAPH_PAD - SUBGRAPH_LABEL_H,
      w: maxX - minX + 2 * SUBGRAPH_PAD,
      h: maxY - minY + 2 * SUBGRAPH_PAD + SUBGRAPH_LABEL_H,
    };
  });

  // Expand canvas for subgraph frames that spill past the content box.
  for (const s of subgraphs) {
    width = Math.max(width, s.x + s.w + MARGIN);
    height = Math.max(height, s.y + s.h + MARGIN);
  }

  return {
    type: 'flowchart',
    direction: dir,
    width: round(width),
    height: round(height),
    nodes: nodes.map(roundBox),
    edges: edges.map(roundEdge),
    subgraphs: subgraphs.map(roundBox),
    fontSize: FONT_SIZE,
  };
}

/**
 * @param {any} node
 * @returns {any}
 */
function sizeNode(node) {
  const m = measureText(node.label, FONT_SIZE);
  let w = m.width + 2 * PAD_X;
  let h = m.height + 2 * PAD_Y;
  const shape = node.shape;
  if (shape === 'circle' || shape === 'doublecircle') {
    const d = Math.max(w, h, MIN_H + 8);
    w = d; h = d;
  }
  else if (shape === 'diamond') {
    w = Math.max(w * 1.4, MIN_W + 20);
    h = Math.max(h * 1.4, MIN_H + 8);
  }
  else if (shape === 'hexagon') {
    w += 20;
  }
  else if (shape === 'stadium' || shape === 'round') {
    w += 10;
  }
  return {
    x: 0, y: 0,
    w: Math.max(w, MIN_W),
    h: Math.max(h, MIN_H),
    lines: m.lines,
  };
}

/**
 * Intersect the segment from an external point `from` to the box center
 * with the box border.
 * @param {{x:number,y:number}} from
 * @param {{x:number,y:number}} to box center
 * @param {any} box
 * @returns {{x:number,y:number}}
 */
function clipToBox(from, to, box) {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const dx = from.x - cx;
  const dy = from.y - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const hw = box.w / 2;
  const hh = box.h / 2;
  const scaleX = dx === 0 ? Infinity : hw / Math.abs(dx);
  const scaleY = dy === 0 ? Infinity : hh / Math.abs(dy);
  const scale = Math.min(scaleX, scaleY);
  return { x: cx + dx * scale, y: cy + dy * scale };
}

const roundBox = (b) => ({ ...b, x: round(b.x), y: round(b.y), w: round(b.w), h: round(b.h) });

/** Horizontal breathing room around an edge label's background. */
const LABEL_PAD = 10;

/** How far along an edge a label may sit, nearest the middle first. */
const LABEL_SLOTS = [0.5, 0.42, 0.58, 0.34, 0.66];

/** Sideways steps, in label-heights, tried when sliding alone cannot free a
 * label. Perpendicular to a near-vertical edge is horizontal, which is where
 * the space actually is when two edges leave one node. */
const LABEL_OFFSETS = [0, 1, -1, 2, -2];

/** Whether two label boxes overlap, with a small gap required between them. */
function labelsOverlap(a, b) {
  const gap = 2;
  return Math.abs(a.x - b.x) * 2 < a.w + b.w + gap * 2
    && Math.abs(a.y - b.y) * 2 < a.h + b.h + gap * 2;
}

/**
 * Place each edge label so it does not cover one already placed.
 *
 * Two edges leaving the same node land their midpoints at the same height, so
 * with any pair of long labels the second one's opaque background covered the
 * first — the reason the bundled diagrams had to keep edge labels short.
 *
 * Candidates are tried in order of how far they stray from the natural
 * midpoint: first slide ALONG the edge (which keeps the label on its line),
 * then step sideways. A label with nowhere free keeps the midpoint rather than
 * drifting somewhere arbitrary — an honest overlap beats a confusing one.
 *
 * Deterministic by construction: edges are visited in document order and the
 * candidate list is fixed, so a diagram always lays out the same way.
 * Node boxes are seeded as obstacles too: a label that lands on top of a box
 * it has nothing to do with reads as that box's text.
 * @param {any[]} edges positioned edges, mutated in place
 * @param {any[]} nodes positioned nodes, treated as obstacles
 */
function placeEdgeLabels(edges, nodes) {
  const placed = nodes.map((n) => ({
    x: n.x + n.w / 2, y: n.y + n.h / 2, w: n.w, h: n.h,
  }));
  for (const e of edges) {
    if (e.labelPos === null || e.points.length < 2) continue;
    const [p1, p2] = e.points;
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const len = Math.hypot(dx, dy) || 1;
    // The unit normal: sideways relative to this edge, whichever way it runs.
    const nx = -dy / len;
    const ny = dx / len;

    let chosen = null;
    for (const off of LABEL_OFFSETS) {
      for (const t of LABEL_SLOTS) {
        const step = off * (e.labelH + 4);
        const candidate = {
          x: p1.x + dx * t + nx * step,
          y: p1.y + dy * t + ny * step,
          w: e.labelW, h: e.labelH,
        };
        if (placed.some((other) => labelsOverlap(candidate, other))) continue;
        chosen = candidate;
        break;
      }
      if (chosen !== null) break;
    }
    if (chosen === null) continue;   // keep the midpoint; nothing is free
    e.labelPos = { x: chosen.x, y: chosen.y };
    placed.push(chosen);
  }
}
const roundEdge = (e) => ({
  ...e,
  points: e.points.map((p) => ({ x: round(p.x), y: round(p.y) })),
  labelPos: e.labelPos ? { x: round(e.labelPos.x), y: round(e.labelPos.y) } : null,
});
