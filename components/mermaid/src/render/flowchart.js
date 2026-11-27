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
  svgRoot, group, rect, path, circle, polygon, textAt, textLines, num, coord,
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
  // Mermaid draws a marker shape (a junction, a fork, …) without its label
  if (MARKER_SHAPES.has(node.shape)) return group(nodeMark(node.id, 'n-' + node.id), withTooltip([shapeEl], tooltip));
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
  const attributes = shapeAttributes(node.styles, t);
  const common = {
    class: 'mm-node-shape', fill, stroke, 'stroke-width': 1,
    ...attributes,
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
        path(`M${x + 6},${y} L${x + 6},${y + h} M${x + w - 6},${y} L${x + w - 6},${y + h}`, detailProps(common, attributes.stroke ?? null)),
      ]);
    case 'cylinder': {
      // Mermaid's own outline (and the participant database's): the whole top
      // ellipse, its front lip included, then the sides and the bottom's front
      const ry = coord(Math.min(8, h / 6));
      const d = `M${x},${coord(y + ry)} a${coord(w / 2)},${ry} 0 0 0 ${w},0 a${coord(w / 2)},${ry} 0 0 0 ${-w},0`
        + ` l0,${coord(h - 2 * ry)} a${coord(w / 2)},${ry} 0 0 0 ${w},0 l0,${coord(-(h - 2 * ry))}`;
      return path(d, common);
    }
    case 'circle':
      return circle(x + w / 2, y + h / 2, Math.min(w, h) / 2, common);
    case 'statedot':
      // the state diagram's start marker: a small filled dot (the state
      // layout is the only producer; flowchart source cannot spell it)
      // (filled with the stroke: `mm-node-mark` comes after `mm-node-shape`
      // in the stylesheet, so a host theme paints it so too)
      return circle(x + w / 2, y + h / 2, Math.min(w, h) / 2,
        { ...common, class: 'mm-node-shape mm-node-mark', fill: stroke });
    case 'doublecircle': {
      const r = Math.min(w, h) / 2;
      return group({}, [
        circle(x + w / 2, y + h / 2, r, common),
        // the state diagram's end marker (no label) rings a filled dot, as
        // Mermaid draws it; a flowchart's `(((x)))` two rings
        circle(x + w / 2, y + h / 2, r - 4, node.label === ''
          ? { ...common, class: 'mm-node-shape mm-node-mark', fill: stroke }
          : { ...common, class: 'mm-node-shape mm-node-ring', fill: 'none' }),
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
      return namedShape(node.shape, x, y, w, h, common, attributes.stroke ?? null) ?? rect(x, y, w, h, common);
  }
}

/**
 * A line drawn inside a node's outline (a subroutine's sides, a lined
 * shape's rule): the `mm-node-detail` class, unfilled, in the outline's
 * stroke, and an author's stroke inline, where it outranks the stylesheet.
 * @param {Record<string, any>} common the outline's attributes
 * @param {string | null} authoredStroke the stroke an author's style gives the node
 * @returns {Record<string, any>}
 */
function detailProps(common, authoredStroke) {
  return {
    class: 'mm-node-detail', fill: 'none', stroke: common.stroke, 'stroke-width': common['stroke-width'],
    ...(authoredStroke === null ? {} : { style: `stroke:${authoredStroke}` }),
  };
}

/**
 * The shapes Mermaid draws without their label, as small marks.
 * @type {ReadonlySet<string>}
 */
const MARKER_SHAPES = new Set(['sm-circ', 'fr-circ', 'f-circ', 'fork', 'hourglass', 'bolt', 'cross-circ']);

/**
 * A shape only a node's `@{ shape: … }` names, drawn in its box as Mermaid
 * draws it, by shape class: the outline carries `common` (the theme's or the
 * author's fill and stroke, and the `mm-node-shape` class), a line inside it
 * the `mm-node-detail` class and the same stroke, unfilled, and a filled mark
 * the `mm-node-mark` class, filled with the stroke; an author's stroke goes
 * inline on both, where it outranks the stylesheet, and an author's fill on
 * neither. Null for any other shape.
 * @param {string} shape @param {number} x @param {number} y @param {number} w @param {number} h
 * @param {Record<string, any>} common
 * @param {string | null} authoredStroke the stroke an author's style gives the node
 * @returns {any}
 */
function namedShape(shape, x, y, w, h, common, authoredStroke) {
  const lineOf = { stroke: common.stroke, 'stroke-width': common['stroke-width'] };
  const detail = detailProps(common, authoredStroke);
  const mark = {
    class: 'mm-node-mark', fill: common.stroke, ...lineOf,
    ...(authoredStroke === null ? {} : { style: `fill:${authoredStroke};stroke:${authoredStroke}` }),
  };
  /** A box that draws nothing: what a brace's label stands in. */
  const bare = { class: 'mm-node-shape mm-node-bare', fill: 'none', stroke: 'none', 'stroke-width': common['stroke-width'] };
  const d = (/** @type {string} */ s) => path(s, common);
  const poly = (/** @type {{x:number,y:number}[]} */ points, /** @type {Record<string, any>} */ props) =>
    polygon(points.map((pt) => ({ x: coord(pt.x), y: coord(pt.y) })), props);
  const r = x + w;
  const b = y + h;
  const cx = x + w / 2;
  const cy = y + h / 2;
  // the depth of a document's wave, a fold, a cut corner
  const a = coord(Math.min(6, h / 6));
  const c = coord(Math.min(12, h / 3));
  /** A document's outline: a wave along its bottom. */
  const docPath = (/** @type {number} */ x0, /** @type {number} */ y0, /** @type {number} */ x1, /** @type {number} */ y1) =>
    `M${x0},${y0} H${x1} V${coord(y1 - a)} C${coord(x0 + (x1 - x0) * 0.75)},${coord(y1 - 3 * a)} ${coord(x0 + (x1 - x0) * 0.25)},${coord(y1 + a)} ${x0},${coord(y1 - a)} Z`;
  switch (shape) {
    case 'datastore':
      // a data store's two lines, above and below, and no sides
      return rect(x, y, w, h, { ...common, 'stroke-dasharray': `${coord(w)} ${coord(h)}` });
    case 'text':
      return rect(x, y, w, h, { ...common, class: 'mm-node-shape mm-node-bare', fill: 'none', stroke: 'none' });
    case 'notch-rect':
      return poly([{ x: x + c, y }, { x: r, y }, { x: r, y: b }, { x, y: b }, { x, y: y + c }], common);
    case 'lin-rect':
      return group({}, [rect(x, y, w, h, common), path(`M${coord(x + 8)},${y} V${b}`, detail)]);
    case 'div-rect':
      return group({}, [rect(x, y, w, h, common), path(`M${x},${coord(y + c)} H${r}`, detail)]);
    case 'win-pane':
      return group({}, [rect(x, y, w, h, common), path(`M${x},${coord(y + 8)} H${r} M${coord(x + 8)},${y} V${b}`, detail)]);
    case 'st-rect':
      return group({}, [
        rect(x + 6, y - 6, w, h, common), rect(x + 3, y - 3, w, h, common), rect(x, y, w, h, common),
      ]);
    case 'tag-rect':
      return group({}, [rect(x, y, w, h, common), poly([{ x: r - c, y: b }, { x: r, y: b }, { x: r, y: b - c }], mark)]);
    case 'sl-rect':
      return poly([{ x, y: y + c }, { x: r, y }, { x: r, y: b }, { x, y: b }], common);
    case 'tri':
      return poly([{ x: cx, y }, { x: r, y: b }, { x, y: b }], common);
    case 'flip-tri':
      return poly([{ x, y }, { x: r, y }, { x: cx, y: b }], common);
    case 'hourglass':
      return poly([{ x, y }, { x: r, y }, { x, y: b }, { x: r, y: b }], common);
    case 'notch-pent':
      return poly([{ x: x + c, y }, { x: r - c, y }, { x: r, y: y + c }, { x: r, y: b }, { x, y: b }, { x, y: y + c }], common);
    case 'delay':
      return d(`M${x},${y} H${coord(r - h / 2)} A${coord(h / 2)},${coord(h / 2)} 0 0 1 ${coord(r - h / 2)},${b} H${x} Z`);
    case 'curv-trap':
      return d(`M${x},${cy} L${coord(x + c)},${y} H${coord(r - h / 2)} A${coord(h / 2)},${coord(h / 2)} 0 0 1 ${coord(r - h / 2)},${b} H${coord(x + c)} Z`);
    case 'bow-rect': {
      const rx = coord(Math.min(10, w / 8));
      // stored data: the left side bulges out, the right side in
      return d(`M${coord(x + rx)},${y} H${r} A${rx},${coord(h / 2)} 0 0 0 ${r},${b} H${coord(x + rx)} A${rx},${coord(h / 2)} 0 0 1 ${coord(x + rx)},${y} Z`);
    }
    case 'h-cyl': {
      const rx = coord(Math.min(10, w / 8));
      return group({}, [
        d(`M${coord(x + rx)},${y} H${coord(r - rx)} A${rx},${coord(h / 2)} 0 0 1 ${coord(r - rx)},${b} H${coord(x + rx)} A${rx},${coord(h / 2)} 0 0 1 ${coord(x + rx)},${y} Z`),
        path(`M${coord(r - rx)},${y} A${rx},${coord(h / 2)} 0 0 0 ${coord(r - rx)},${b}`, detail),
      ]);
    }
    case 'lin-cyl': {
      const ry = coord(Math.min(8, h / 6));
      return group({}, [
        d(`M${x},${coord(y + ry)} A${coord(w / 2)},${ry} 0 0 1 ${r},${coord(y + ry)} V${coord(b - ry)} A${coord(w / 2)},${ry} 0 0 1 ${x},${coord(b - ry)} Z`),
        path(`M${x},${coord(y + ry)} A${coord(w / 2)},${ry} 0 0 0 ${r},${coord(y + ry)} M${x},${coord(y + 3 * ry)} A${coord(w / 2)},${ry} 0 0 0 ${r},${coord(y + 3 * ry)}`, detail),
      ]);
    }
    case 'doc':
      return d(docPath(x, y, r, b));
    case 'lin-doc':
      return group({}, [d(docPath(x, y, r, b)), path(`M${coord(x + 8)},${y} V${coord(b - a)}`, detail)]);
    case 'tag-doc':
      return group({}, [d(docPath(x, y, r, b)), poly([{ x: r - c, y: b - a }, { x: r, y: b - a }, { x: r, y: b - a - c }], mark)]);
    case 'docs':
      return group({}, [d(docPath(x + 6, y - 6, r + 6, b - 6)), d(docPath(x + 3, y - 3, r + 3, b - 3)), d(docPath(x, y, r, b))]);
    case 'flag':
      return d(`M${x},${coord(y + a)} C${coord(x + w * 0.25)},${coord(y - a)} ${coord(x + w * 0.75)},${coord(y + 3 * a)} ${r},${coord(y + a)}`
        + ` V${coord(b - a)} C${coord(x + w * 0.75)},${coord(b - 3 * a)} ${coord(x + w * 0.25)},${coord(b + a)} ${x},${coord(b - a)} Z`);
    case 'cloud': {
      // four bumps along the top and the bottom, one at each side
      const bx = coord(w / 8);
      const by = coord(Math.min(8, h / 4));
      let s = `M${coord(x + bx)},${coord(y + by)}`;
      for (let i = 1; i <= 3; i++) s += ` A${bx},${by} 0 0 1 ${coord(x + bx + 2 * i * bx)},${coord(y + by)}`;
      s += ` A${by},${coord(h / 2 - by)} 0 0 1 ${coord(r - bx)},${coord(b - by)}`;
      for (let i = 1; i <= 3; i++) s += ` A${bx},${by} 0 0 1 ${coord(r - bx - 2 * i * bx)},${coord(b - by)}`;
      s += ` A${by},${coord(h / 2 - by)} 0 0 1 ${coord(x + bx)},${coord(y + by)} Z`;
      return d(s);
    }
    case 'bang': {
      // a burst: the box's corners and a spike out of the middle of each side
      const sx = coord(Math.min(10, w / 6));
      const sy = coord(Math.min(8, h / 4));
      return poly([
        { x, y }, { x: cx, y: y + sy }, { x: r, y }, { x: r - sx, y: cy }, { x: r, y: b },
        { x: cx, y: b - sy }, { x, y: b }, { x: x + sx, y: cy },
      ], common);
    }
    case 'brace':
    case 'brace-r':
    case 'braces': {
      const k = coord(Math.min(8, w / 8));
      const left = `M${coord(x + k)},${y} Q${x},${y} ${x},${coord(y + k)} V${coord(cy - k)} Q${x},${cy} ${coord(x - k)},${cy}`
        + ` Q${x},${cy} ${x},${coord(cy + k)} V${coord(b - k)} Q${x},${b} ${coord(x + k)},${b}`;
      const right = `M${coord(r - k)},${y} Q${r},${y} ${r},${coord(y + k)} V${coord(cy - k)} Q${r},${cy} ${coord(r + k)},${cy}`
        + ` Q${r},${cy} ${r},${coord(cy + k)} V${coord(b - k)} Q${r},${b} ${coord(r - k)},${b}`;
      return group({}, [
        rect(x, y, w, h, bare),
        path(shape === 'brace' ? left : shape === 'brace-r' ? right : left + ' ' + right, detail),
      ]);
    }
    case 'sm-circ':
    case 'f-circ':
      return circle(cx, cy, Math.min(w, h) / 2, mark);
    case 'fr-circ':
      return group({}, [circle(cx, cy, Math.min(w, h) / 2, common), circle(cx, cy, Math.min(w, h) / 2 - 4, mark)]);
    case 'fork':
      return rect(x, y, w, h, mark);
    case 'cross-circ': {
      const rr = Math.min(w, h) / 2;
      const o = coord(rr * Math.SQRT1_2);
      return group({}, [
        circle(cx, cy, rr, common),
        path(`M${coord(cx - o)},${coord(cy - o)} L${coord(cx + o)},${coord(cy + o)} M${coord(cx + o)},${coord(cy - o)} L${coord(cx - o)},${coord(cy + o)}`, detail),
      ]);
    }
    case 'bolt':
      return poly([
        { x: x + w * 0.6, y }, { x, y: y + h * 0.55 }, { x: cx, y: y + h * 0.55 },
        { x: x + w * 0.4, y: b }, { x: r, y: y + h * 0.45 }, { x: cx, y: y + h * 0.45 },
      ], mark);
    default:
      return null;
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
  // an invisible link (`~~~`) places its ends and draws no line
  const stroke = e.stroke === 'invisible' ? 'none' : t.lineColor;
  const strokeWidth = e.stroke === 'thick' ? 3 : 1.5;
  const dash = e.stroke === 'dotted' ? '3 3' : null;
  const lineProps = {
    class: 'mm-edge-line', fill: 'none', stroke, 'stroke-width': strokeWidth,
    // `mm-edge-hidden` keeps the stylesheet's line rule off an invisible link
    ...(e.stroke === 'invisible' ? { class: 'mm-edge-line mm-edge-hidden' } : {}),
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
    return circle(tip.x - ux * 4, tip.y - uy * 4, 4, { class: 'mm-arrowhead', fill: color, stroke: color });
  }
  if (kind === 'cross') {
    const s = 5;
    const px = -uy, py = ux;
    return path(
      `M${num(tip.x - ux * 8 + px * s)},${num(tip.y - uy * 8 + py * s)} L${num(tip.x - px * s)},${num(tip.y - py * s)}`
      + ` M${num(tip.x - ux * 8 - px * s)},${num(tip.y - uy * 8 - py * s)} L${num(tip.x + px * s)},${num(tip.y + py * s)}`,
      { class: 'mm-arrowhead-line', stroke: color, 'stroke-width': 1.5, fill: 'none' });
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
