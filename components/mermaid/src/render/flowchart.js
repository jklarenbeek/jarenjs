//@ts-check
/**
 * @file Flowchart renderer: `PositionedDiagram` → pure-vnode SVG. One
 * specialized closure over the scene graph; arrowheads are inline
 * polygons (no `<marker>` id collisions across diagrams on one page),
 * every shape carries a `mm-*` class for CSS re-theming and concrete
 * theme colors for standalone SSR. A scene laid out for HTML labels
 * (`scene.htmlLabels`) draws each label as HTML inside a `foreignObject`
 * instead of SVG `<text>`, one block per line the layout measured. Every
 * label is read once, by `label-text.js` (line breaks, markdown strings,
 * entity codes), exactly as the layout measured it; a plain single-line
 * label draws as it always has.
 */

import {
  svgRoot, group, rect, path, circle, polygon, textAt, textLines, num,
} from '@jarenjs/view/helpers';

import { shapeAttributes, shapeStyle, textColor } from '../styles.js';
import { readLabel, appendRun } from '../label-text.js';
import { nodeMark, edgeMark, withTooltip } from './marks.js';

/**
 * @param {any} scene PositionedDiagram (flowchart or state, via its adapter)
 * @param {{ tokens: Record<string,string>, cssVars: Record<string,string> }} theme
 * @param {string} hash content hash for the root key
 * @param {string} [rootClass] root `class` — the state renderer adds `mm-state`
 * @param {Map<string, string>} [tooltips] the tooltip text a `click` gave each node id
 * @returns {any}
 */
export function renderFlowchart(scene, theme, hash, rootClass = 'mermaid mm-svg', tooltips = new Map()) {
  const t = theme.tokens;
  const children = [];

  const html = scene.htmlLabels === true;

  // Subgraph frames first (behind nodes). The title band holds one line: a
  // title's line breaks draw as the spaces SVG text and an unwrapped HTML
  // label make of them.
  for (const sg of scene.subgraphs) {
    if (sg.w === 0) continue;
    const title = sg.label ? titleLine(readLabel(sg.label)) : null;
    children.push(group({ class: 'mm-cluster', key: 'sg-' + sg.id }, [
      rect(sg.x, sg.y, sg.w, sg.h, {
        rx: 6, class: 'mm-cluster-rect',
        fill: t.clusterFill, stroke: t.clusterStroke, 'stroke-width': 1,
      }),
      title === null ? null
        : html
          ? htmlLabel(sg.x, sg.y, sg.w, CLUSTER_LABEL_BAND, [title], scene.fontSize,
            'mm-cluster-label', NODE_TEXT)
          : withRuns(textAt(sg.x + sg.w / 2, sg.y + 15, typeof title === 'string' ? title : '', scene.fontSize, {
            'text-anchor': 'middle', class: 'mm-cluster-label', fill: t.nodeText,
          }), title),
    ]));
  }

  // Edges (behind nodes so the node fill covers endpoints).
  for (let i = 0; i < scene.edges.length; i++) {
    const e = scene.edges[i];
    if (e.points.length < 2) continue;
    children.push(renderEdge(e, t, scene.fontSize, i, html));
  }

  // Nodes.
  for (const node of scene.nodes) {
    children.push(renderNode(node, t, scene.fontSize, tooltips.get(node.id), html));
  }

  return svgRoot(rootClass, scene.width, scene.height, theme, children,
    'mmfc-' + hash, { fit: false });
}

/** The XHTML namespace an HTML label's root declares, so a standalone SVG
 * file reads it as HTML too. */
const XHTML_NS = 'http://www.w3.org/1999/xhtml';

/** The theme's label colors as the custom properties every root declares:
 * what the stylesheet's `fill` rules give SVG text, given to HTML as `color`. */
const NODE_TEXT = 'var(--mm-node-text)';
const EDGE_LABEL_TEXT = 'var(--mm-edge-label-text)';

/** The band at the top of a subgraph frame its HTML title is centered in:
 * its middle is where the SVG title's glyphs sit (baseline 15). */
const CLUSTER_LABEL_BAND = 20;

/**
 * A subgraph title's lines as the one line its band holds: plain lines
 * joined by the newline they were written with, markdown runs by a space.
 * @param {import('../label-text.js').LabelLine[]} lines
 * @returns {import('../label-text.js').LabelLine}
 */
function titleLine(lines) {
  if (lines.every((line) => typeof line === 'string')) return lines.join('\n');
  /** @type {import('../label-text.js').LabelRun[]} */
  const runs = [];
  lines.forEach((line, i) => {
    if (i > 0) appendRun(runs, { text: ' ', type: 'normal' });
    for (const run of /** @type {import('../label-text.js').LabelRun[]} */ (line)) appendRun(runs, run);
  });
  return runs;
}

/** The SVG presentation of a markdown run's style. */
const RUN_STYLE = {
  normal: {},
  strong: { 'font-weight': 'bold' },
  em: { 'font-style': 'italic' },
};

/**
 * A markdown line's runs as SVG: one `tspan` per run, styled bold or italic.
 * @param {import('../label-text.js').LabelRun[]} runs
 * @returns {any[]}
 */
function svgRuns(runs) {
  return runs.map((run) => ['tspan', RUN_STYLE[run.type], run.text]);
}

/**
 * Put a markdown line's runs into a text element built for plain text: in
 * one line `tspan` of their own when `line` is the element's only line, or
 * into its `index`-th line `tspan`. A plain line leaves the element as it was
 * built. Either way a label's `text` holds only line `tspan`s, which is how
 * the tooltips read its lines.
 * @param {any} el a `text` vnode
 * @param {import('../label-text.js').LabelLine} line
 * @param {number} [index] the line `tspan`'s position, when the element has them
 * @returns {any}
 */
function withRuns(el, line, index) {
  if (typeof line === 'string') return el;
  if (index === undefined) return [el[0], el[1], ['tspan', {}, ...svgRuns(line)]];
  const tspan = el[2 + index];
  el[2 + index] = [tspan[0], tspan[1], ...svgRuns(line)];
  return el;
}

/**
 * SVG text for a label's lines: one `tspan` line each, centered on (`cx`,
 * `cy`) as `textLines` centers them, a markdown line's runs inside its line.
 * @param {number} cx @param {number} cy
 * @param {import('../label-text.js').LabelLine[]} lines
 * @param {number} fontSize
 * @param {Record<string, any>} props
 * @returns {any}
 */
function svgLabel(cx, cy, lines, fontSize, props) {
  const el = textLines(cx, cy, lines.map((line) => (typeof line === 'string' ? line : '')), fontSize, props);
  lines.forEach((line, i) => withRuns(el, line, i));
  return el;
}

/**
 * An HTML label: a `foreignObject` over the box the layout sized, holding
 * one block per measured line, centered, never wrapped again by the browser
 * (the layout already wrapped it) and free to overflow rather than clip
 * when the host's font runs wider than the advance table.
 * @param {number} x @param {number} y @param {number} w @param {number} h
 * @param {import('../label-text.js').LabelLine[]} lines @param {number} fontSize
 * @param {string} className the label's marker class (`mm-label`, …)
 * @param {string} color a CSS color
 * @returns {any}
 */
function htmlLabel(x, y, w, h, lines, fontSize, className, color) {
  return ['foreignObject', { x: num(x), y: num(y), width: num(w), height: num(h), overflow: 'visible' },
    ['div', {
      xmlns: XHTML_NS, class: className,
      style: {
        display: 'flex', 'flex-direction': 'column', 'justify-content': 'center',
        'align-items': 'center', width: '100%', height: '100%',
        'font-size': fontSize + 'px', 'line-height': '1.2', 'white-space': 'nowrap',
        'text-align': 'center', color,
      },
    }, ...lines.map((line) => ['div', {}, ...htmlRuns(line)])]];
}

/** The HTML element a markdown run's style is drawn with. */
const RUN_TAG = { strong: 'strong', em: 'em' };

/**
 * A line's content as HTML: its text, or a markdown line's runs, the styled
 * ones in `strong`/`em` as Mermaid draws them.
 * @param {import('../label-text.js').LabelLine} line
 * @returns {any[]}
 */
function htmlRuns(line) {
  if (typeof line === 'string') return [line];
  return line.map((run) => (run.type === 'normal' ? run.text : [RUN_TAG[run.type], {}, run.text]));
}

/**
 * @param {any} node @param {Record<string,string>} t @param {number} fontSize
 * @param {string | undefined} tooltip
 * @param {boolean} html the label is HTML, in the lines the layout measured
 * @returns {any}
 */
function renderNode(node, t, fontSize, tooltip, html) {
  const shapeEl = shapeVnode(node, t);
  const color = textColor(node.styles, t);
  if (html) {
    // a pseudo-state draws no label at all
    const label = node.lines.length === 0 || node.label === '' ? null
      : htmlLabel(node.x, node.y, node.w, node.h, node.lines, fontSize, 'mm-label', color ?? NODE_TEXT);
    return group(nodeMark(node.id, 'n-' + node.id),
      withTooltip(label === null ? [shapeEl] : [shapeEl, label], tooltip));
  }
  const cx = node.x + node.w / 2;
  const cy = node.y + node.h / 2;
  const label = svgLabel(cx, cy, readLabel(node.label), fontSize,
    color === null
      ? { class: 'mm-label', fill: t.nodeText }
      : { class: 'mm-label', fill: color, style: `fill:${color}` });
  // `data-id` is the stable identity an editor's event delegation and
  // hit-testing key on (MERMAID-FORMAT §7): the AST node id, verbatim.
  return group(nodeMark(node.id, 'n-' + node.id), withTooltip([shapeEl, label], tooltip));
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
    case 'statedot':
      // the state diagram's start marker: a small filled dot (the state
      // layout is the only producer; flowchart source cannot spell it)
      return circle(x + w / 2, y + h / 2, Math.min(w, h) / 2,
        { ...common, fill: stroke });
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
 * @param {boolean} html the label is HTML, in the lines the layout measured
 * @returns {any}
 */
function renderEdge(e, t, fontSize, i, html) {
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
    // The layout measured the label and resolved its position; re-estimating
    // the width here is what let a long label overflow its own background.
    const lw = e.labelW ?? (e.label.length * fontSize * 0.55 + 8);
    const lh = e.labelH ?? fontSize * 1.4;
    parts.push(rect(e.labelPos.x - lw / 2, e.labelPos.y - lh / 2, lw, lh, {
      class: 'mm-edge-label-bg', fill: t.edgeLabelBg, stroke: 'none',
    }));
    if (html) {
      parts.push(htmlLabel(e.labelPos.x - lw / 2, e.labelPos.y - lh / 2, lw, lh, e.lines, fontSize,
        'mm-edge-label', EDGE_LABEL_TEXT));
    }
    else {
      // the lines the layout measured the background for, centered on it
      const lines = readLabel(e.label);
      parts.push(lines.length === 1 && typeof lines[0] === 'string'
        ? textAt(e.labelPos.x, e.labelPos.y, lines[0], fontSize, {
          'text-anchor': 'middle', 'dominant-baseline': 'central',
          class: 'mm-edge-label', fill: t.edgeLabelText,
        })
        : svgLabel(e.labelPos.x, e.labelPos.y, lines, fontSize, {
          class: 'mm-edge-label', fill: t.edgeLabelText,
        }));
    }
  }

  // Edge identity for editors: endpoints plus `data-edge`, the edge's
  // AST position — which is also its docPath tail (MERMAID-FORMAT §7).
  return group(edgeMark(i, e.from, e.to, 'e-' + i), parts);
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
