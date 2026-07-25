//@ts-check
/**
 * @file The sankey chart type: named nodes in flow layers joined by
 * value-proportional ribbons. Data shape:
 *
 *   data   = { nodes?: (string | { name })[],
 *              links: [{ source, target, value }] }   // by name or node index
 *   config = { type:'sankey', title? }
 *
 * Names referenced only by links are added as nodes automatically. A
 * link that would close a cycle is dropped (a sankey is a DAG); so are
 * self-links and non-positive values. Layout: a node's layer is its
 * longest path from the sources; within a layer nodes stack in input
 * order, sized by throughput (max of in-flow and out-flow) on one
 * global scale, centered vertically. The AST is unit-square with `y`
 * growing downward (no axes — reading order wins, as in the treemap).
 */

import { svgRoot, textAt } from '@jarenjs/view/helpers';
import { FS_LABEL, annotateChart } from '../core/cartesian.js';
import { CATEGORICAL, seriesColor } from '../core/palette.js';

/**
 * @typedef {object} SankeyNodeAST
 * @property {string} name
 * @property {number} layer
 * @property {number} x0 @property {number} x1
 * @property {number} y0 @property {number} y1
 */
/**
 * @typedef {object} SankeyLinkAST
 * @property {number} source node index @property {number} target node index
 * @property {number} value
 * @property {number} sy0 @property {number} sy1 ribbon extent at the source
 * @property {number} ty0 @property {number} ty1 ribbon extent at the target
 */
/**
 * @typedef {object} SankeyAST
 * @property {'sankey'} type
 * @property {string|null} title
 * @property {SankeyNodeAST[]} nodes
 * @property {SankeyLinkAST[]} links
 */

/**
 * Build the geometry-free sankey AST.
 * @param {any} data
 * @param {any} [config]
 * @returns {SankeyAST}
 */
export function buildSankeyAST(data, config = {}) {
  const names = [];
  const indexOf = new Map();
  const intern = (name) => {
    let i = indexOf.get(name);
    if (i === undefined) {
      i = names.length;
      names.push(name);
      indexOf.set(name, i);
    }
    return i;
  };
  for (const node of data?.nodes ?? [])
    intern(String(typeof node === 'object' && node !== null ? node.name : node));

  /** Resolve a link endpoint: node index or name (names may be new). */
  const resolve = (ref) => {
    if (typeof ref === 'number')
      return Number.isInteger(ref) && ref >= 0 && ref < names.length ? ref : null;
    if (typeof ref === 'string') return intern(ref);
    return null;
  };

  // Accept links in order; drop malformed ones and cycle-closers.
  /** @type {number[][]} adjacency: out-neighbors per node */
  const out = [];
  const reaches = (from, to) => {
    if (from === to) return true;
    const stack = [from];
    const seen = new Set([from]);
    while (stack.length !== 0) {
      for (const next of out[stack.pop()] ?? []) {
        if (next === to) return true;
        if (!seen.has(next)) { seen.add(next); stack.push(next); }
      }
    }
    return false;
  };
  const links = [];
  for (const link of data?.links ?? []) {
    const source = resolve(link?.source);
    const target = resolve(link?.target);
    const value = link?.value;
    if (source === null || target === null || source === target) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) continue;
    if (reaches(target, source)) continue;
    (out[source] ??= []).push(target);
    links.push({ source, target, value });
  }

  // Longest path from the sources, computed to a fixed point (the
  // graph is acyclic by construction, so this terminates).
  const layer = new Array(names.length).fill(0);
  let changed = true;
  while (changed) {
    changed = false;
    for (const link of links) {
      if (layer[link.target] < layer[link.source] + 1) {
        layer[link.target] = layer[link.source] + 1;
        changed = true;
      }
    }
  }
  const maxLayer = Math.max(0, ...layer.filter((_, i) => hasFlow(i)));

  function hasFlow(i) {
    return links.some((l) => l.source === i || l.target === i);
  }

  // Throughput per node; one global value→height scale.
  const inFlow = new Array(names.length).fill(0);
  const outFlow = new Array(names.length).fill(0);
  for (const link of links) {
    outFlow[link.source] += link.value;
    inFlow[link.target] += link.value;
  }
  const size = names.map((_, i) => Math.max(inFlow[i], outFlow[i]));

  const gap = 0.04;
  const byLayer = new Map();
  for (let i = 0; i < names.length; i++) {
    if (!hasFlow(i)) continue;
    let list = byLayer.get(layer[i]);
    if (list === undefined) byLayer.set(layer[i], list = []);
    list.push(i);
  }
  let scale = Infinity;
  for (const list of byLayer.values()) {
    const total = list.reduce((s, i) => s + size[i], 0);
    const room = 1 - gap * (list.length - 1);
    if (total > 0 && room / total < scale) scale = room / total;
  }
  if (!Number.isFinite(scale)) scale = 0;

  const nodeW = 0.035;
  const nodes = [];
  const nodeAt = new Array(names.length).fill(-1);
  for (const [l, list] of byLayer) {
    const totalH = list.reduce((s, i) => s + size[i] * scale, 0) + gap * (list.length - 1);
    let y = (1 - totalH) / 2;
    for (const i of list) {
      const h = size[i] * scale;
      nodeAt[i] = nodes.length;
      nodes.push({
        name: names[i],
        layer: l,
        x0: maxLayer === 0 ? 0 : (l / maxLayer) * (1 - nodeW),
        x1: maxLayer === 0 ? nodeW : (l / maxLayer) * (1 - nodeW) + nodeW,
        y0: y,
        y1: y + h,
      });
      y += h + gap;
    }
  }

  // Ribbon slots: links stack down each node face in link order.
  const outAt = names.map((_, i) => nodeAt[i] === -1 ? 0 : nodes[nodeAt[i]].y0);
  const inAt = names.map((_, i) => nodeAt[i] === -1 ? 0 : nodes[nodeAt[i]].y0);
  const linkAsts = links.map((link) => {
    const h = link.value * scale;
    const sy0 = outAt[link.source];
    const ty0 = inAt[link.target];
    outAt[link.source] += h;
    inAt[link.target] += h;
    return {
      source: nodeAt[link.source],
      target: nodeAt[link.target],
      value: link.value,
      sy0, sy1: sy0 + h,
      ty0, ty1: ty0 + h,
    };
  });

  return {
    type: 'sankey',
    title: config.title ?? null,
    nodes,
    links: linkAsts,
  };
}

/**
 * Render a sankey AST to a pure-vnode SVG: categorical node bars,
 * translucent muted ribbons with flow `<title>`s, node labels beside
 * the bar on its open side.
 * @param {SankeyAST} ast
 * @param {{tokens: Record<string,string>, cssVars: Record<string,string>}} theme
 * @param {string} hash
 * @param {{rootClass?: string, keyPrefix?: string, palette?: readonly string[], width?: number}} [options]
 * @returns {any}
 */
export function renderSankeyAST(ast, theme, hash, options = {}) {
  const t = theme.tokens;
  const palette = options.palette ?? CATEGORICAL;
  const width = options.width ?? 560;
  const top = ast.title ? 34 : 8;
  const pad = 8;
  const plotW = width - 2 * pad;
  const plotH = 280;
  const children = [];

  if (ast.title) {
    children.push(textAt(width / 2, 22, ast.title, 15,
      { 'font-weight': 'bold', 'text-anchor': 'middle', fill: t.text, class: 'chart-title' }));
  }

  const X = (x) => round2(pad + x * plotW);
  const Y = (y) => round2(top + y * plotH);

  for (const link of ast.links) {
    const s = ast.nodes[link.source];
    const target = ast.nodes[link.target];
    const x0 = X(s.x1);
    const x1 = X(target.x0);
    const mx = round2((x0 + x1) / 2);
    children.push(['path', {
      d: `M${x0},${Y(link.sy0)} C${mx},${Y(link.sy0)} ${mx},${Y(link.ty0)} ${x1},${Y(link.ty0)} `
        + `L${x1},${Y(link.ty1)} C${mx},${Y(link.ty1)} ${mx},${Y(link.sy1)} ${x0},${Y(link.sy1)} Z`,
      fill: t.muted, 'fill-opacity': 0.3, class: 'chart-sankey-link',
    }, ['title', {}, `${s.name} → ${target.name}: ${link.value}`]]);
  }

  for (let i = 0; i < ast.nodes.length; i++) {
    const node = ast.nodes[i];
    children.push(['rect', {
      x: X(node.x0), y: Y(node.y0),
      width: round2((node.x1 - node.x0) * plotW),
      height: round2(Math.max(1, (node.y1 - node.y0) * plotH)),
      fill: seriesColor(i, palette), class: 'chart-sankey-node',
    }, ['title', {}, node.name]]);
    const onLeftHalf = (node.x0 + node.x1) / 2 < 0.5;
    children.push(textAt(
      onLeftHalf ? X(node.x1) + 5 : X(node.x0) - 5,
      Y((node.y0 + node.y1) / 2) + 4,
      node.name, FS_LABEL,
      { 'text-anchor': onLeftHalf ? 'start' : 'end', fill: t.text, class: 'chart-sankey-label' }));
  }

  const height = top + plotH + 8;
  const svg = svgRoot(options.rootClass ?? 'chart chart-svg chart-sankey-chart',
    width, height, theme, children, (options.keyPrefix ?? 'sankey-') + hash);
  return annotateChart(svg, ast.title);
}

function round2(v) {
  return Math.round(v * 100) / 100;
}
