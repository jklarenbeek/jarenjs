//@ts-check
/**
 * @file Flowchart renderer: `PositionedDiagram` → pure-vnode SVG. One
 * specialized closure over the scene graph; arrowheads are inline
 * polygons (no `<marker>` id collisions across diagrams on one page),
 * every shape carries a `mm-*` class for CSS re-theming and concrete
 * theme colors for standalone SSR.
 */

import {
  svgRoot, group, rect, path, circle, polygon, textAt, textLines, num,
} from '@jarenjs/view/helpers';

import { shapeAttributes, shapeStyle, textColor } from '../styles.js';

/**
 * @param {any} scene PositionedDiagram (flowchart)
 * @param {{ tokens: Record<string,string>, cssVars: Record<string,string> }} theme
 * @param {string} hash content hash for the root key
 * @returns {any}
 */
export function renderFlowchart(scene, theme, hash) {
  const t = theme.tokens;
  const children = [];

  // Subgraph frames first (behind nodes).
  for (const sg of scene.subgraphs) {
    if (sg.w === 0) continue;
    children.push(group({ class: 'mm-cluster', key: 'sg-' + sg.id }, [
      rect(sg.x, sg.y, sg.w, sg.h, {
        rx: 6, class: 'mm-cluster-rect',
        fill: t.clusterFill, stroke: t.clusterStroke, 'stroke-width': 1,
      }),
      sg.label
        ? textAt(sg.x + sg.w / 2, sg.y + 15, sg.label, scene.fontSize, {
          'text-anchor': 'middle', class: 'mm-cluster-label', fill: t.nodeText,
        })
        : null,
    ]));
  }

  // Edges (behind nodes so the node fill covers endpoints).
  for (let i = 0; i < scene.edges.length; i++) {
    const e = scene.edges[i];
    if (e.points.length < 2) continue;
    children.push(renderEdge(e, t, scene.fontSize, i));
  }

  // Nodes.
  for (const node of scene.nodes) {
    children.push(renderNode(node, t, scene.fontSize));
  }

  return svgRoot('mermaid mm-svg', scene.width, scene.height, theme, children,
    'mmfc-' + hash, { fit: false });
}

/**
 * @param {any} node @param {Record<string,string>} t @param {number} fontSize
 * @returns {any}
 */
function renderNode(node, t, fontSize) {
  const shapeEl = shapeVnode(node, t);
  const cx = node.x + node.w / 2;
  const cy = node.y + node.h / 2;
  const color = textColor(node.styles, t);
  const label = textLines(cx, cy, node.label.split('\n'), fontSize,
    color === null
      ? { class: 'mm-label', fill: t.nodeText }
      : { class: 'mm-label', fill: color, style: `fill:${color}` });
  return group({ class: 'mm-node', key: 'n-' + node.id }, [shapeEl, label]);
}

/**
 * @param {any} node @param {Record<string,string>} t
 * @returns {any}
 */
function shapeVnode(node, t) {
  const { x, y, w, h } = node;
  const fill = t.nodeFill;
  const stroke = t.nodeStroke;
  // Author styles (classDef / class / style) win over the theme defaults;
  // spreading them last is what makes `class X note` repaint the box.
  // Presentation attributes carry the theme (so standalone SSR looks right
  // with no stylesheet); the author's own styles go inline, which is what
  // outranks the stylesheet's `.mm-node-shape` rule.
  const authored = shapeStyle(node.styles, t);
  const common = {
    class: 'mm-node-shape', fill, stroke, 'stroke-width': 1,
    ...shapeAttributes(node.styles, t),
    ...(authored === null ? {} : { style: authored }),
  };
  switch (node.shape) {
    case 'round':
      return rect(x, y, w, h, { rx: 8, ...common });
    case 'stadium':
      return rect(x, y, w, h, { rx: h / 2, ...common });
    case 'subroutine':
      return group({}, [
        rect(x, y, w, h, common),
        path(`M${x + 6},${y} L${x + 6},${y + h} M${x + w - 6},${y} L${x + w - 6},${y + h}`, { fill: 'none', stroke, 'stroke-width': 1 }),
      ]);
    case 'cylinder': {
      const ry = Math.min(8, h / 6);
      const d = `M${x},${y + ry} C${x},${y - ry / 2} ${x + w},${y - ry / 2} ${x + w},${y + ry}`
        + ` L${x + w},${y + h - ry} C${x + w},${y + h + ry / 2} ${x},${y + h + ry / 2} ${x},${y + h - ry} Z`;
      return path(d, common);
    }
    case 'circle':
      return circle(x + w / 2, y + h / 2, Math.min(w, h) / 2, common);
    case 'doublecircle': {
      const r = Math.min(w, h) / 2;
      return group({}, [
        circle(x + w / 2, y + h / 2, r, common),
        circle(x + w / 2, y + h / 2, r - 4, { ...common, fill: 'none' }),
      ]);
    }
    case 'diamond':
      return polygon([
        { x: x + w / 2, y }, { x: x + w, y: y + h / 2 },
        { x: x + w / 2, y: y + h }, { x, y: y + h / 2 },
      ], common);
    case 'hexagon': {
      const o = Math.min(14, w / 4);
      return polygon([
        { x: x + o, y }, { x: x + w - o, y }, { x: x + w, y: y + h / 2 },
        { x: x + w - o, y: y + h }, { x: x + o, y: y + h }, { x, y: y + h / 2 },
      ], common);
    }
    case 'parallelogram': {
      const o = Math.min(16, w / 4);
      return polygon([
        { x: x + o, y }, { x: x + w, y }, { x: x + w - o, y: y + h }, { x, y: y + h },
      ], common);
    }
    case 'parallelogram_alt': {
      const o = Math.min(16, w / 4);
      return polygon([
        { x, y }, { x: x + w - o, y }, { x: x + w, y: y + h }, { x: x + o, y: y + h },
      ], common);
    }
    case 'trapezoid': {
      const o = Math.min(16, w / 4);
      return polygon([
        { x: x + o, y }, { x: x + w - o, y }, { x: x + w, y: y + h }, { x, y: y + h },
      ], common);
    }
    case 'trapezoid_alt': {
      const o = Math.min(16, w / 4);
      return polygon([
        { x, y }, { x: x + w, y }, { x: x + w - o, y: y + h }, { x: x + o, y: y + h },
      ], common);
    }
    case 'asymmetric':
      return polygon([
        { x, y }, { x: x + w - 8, y }, { x: x + w, y: y + h / 2 }, { x: x + w - 8, y: y + h }, { x, y: y + h },
      ], common);
    default:
      return rect(x, y, w, h, common);
  }
}

/**
 * @param {any} e @param {Record<string,string>} t @param {number} fontSize @param {number} i
 * @returns {any}
 */
function renderEdge(e, t, fontSize, i) {
  const p1 = e.points[0];
  const p2 = e.points[e.points.length - 1];
  const stroke = t.lineColor;
  const strokeWidth = e.stroke === 'thick' ? 3 : 1.5;
  const dash = e.stroke === 'dotted' ? '3 3' : null;
  const lineProps = {
    class: 'mm-edge-line', fill: 'none', stroke, 'stroke-width': strokeWidth,
  };
  if (dash) lineProps['stroke-dasharray'] = dash;

  const parts = [path(`M${num(p1.x)},${num(p1.y)} L${num(p2.x)},${num(p2.y)}`, lineProps)];

  if (e.head !== 'none') parts.push(marker(p2, p1, e.head, stroke));
  if (e.tail !== 'none') parts.push(marker(p1, p2, e.tail, stroke));

  if (e.label != null && e.labelPos) {
    const lw = e.label.length * fontSize * 0.55 + 8;
    parts.push(rect(e.labelPos.x - lw / 2, e.labelPos.y - fontSize * 0.7, lw, fontSize * 1.4, {
      class: 'mm-edge-label-bg', fill: t.edgeLabelBg, stroke: 'none',
    }));
    parts.push(textAt(e.labelPos.x, e.labelPos.y, e.label, fontSize, {
      'text-anchor': 'middle', 'dominant-baseline': 'central',
      class: 'mm-edge-label', fill: t.edgeLabelText,
    }));
  }

  return group({ class: 'mm-edge', key: 'e-' + i }, parts);
}

/**
 * An endpoint marker (arrow/circle/cross) at `tip`, oriented away from
 * `from`.
 * @param {{x:number,y:number}} tip
 * @param {{x:number,y:number}} from
 * @param {string} kind
 * @param {string} color
 * @returns {any}
 */
function marker(tip, from, kind, color) {
  const dx = tip.x - from.x;
  const dy = tip.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  if (kind === 'circle') {
    return circle(tip.x - ux * 4, tip.y - uy * 4, 4, { fill: color, stroke: color });
  }
  if (kind === 'cross') {
    const s = 5;
    const px = -uy, py = ux;
    return path(
      `M${num(tip.x - ux * 8 + px * s)},${num(tip.y - uy * 8 + py * s)} L${num(tip.x - px * s)},${num(tip.y - py * s)}`
      + ` M${num(tip.x - ux * 8 - px * s)},${num(tip.y - uy * 8 - py * s)} L${num(tip.x + px * s)},${num(tip.y + py * s)}`,
      { stroke: color, 'stroke-width': 1.5, fill: 'none' });
  }
  // arrow (default)
  const size = 9;
  const px = -uy, py = ux;
  const baseX = tip.x - ux * size;
  const baseY = tip.y - uy * size;
  return polygon([
    { x: tip.x, y: tip.y },
    { x: baseX + px * (size / 2.4), y: baseY + py * (size / 2.4) },
    { x: baseX - px * (size / 2.4), y: baseY - py * (size / 2.4) },
  ], { class: 'mm-arrowhead', fill: color, stroke: color });
}
