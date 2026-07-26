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

import { svgRoot, textAt, coord } from '@jarenjs/view/helpers';
import { FS_LABEL, annotateChart, chartTitle } from '../core/cartesian.js';
import { CATEGORICAL, seriesColor } from '../core/palette.js';
import { normalizeTooltip, valueMark } from '../core/marks.js';

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
  reduceCrossings(byLayer, links);
  /** @type {Map<number, number>} node → its position within its layer */
  const rank = new Map();
  for (const list of byLayer.values())
    list.forEach((node, at) => rank.set(node, at));
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

  // Ribbon slots: links stack down each node face ordered by where
  // their far end sits, not by input order — the local half of crossing
  // reduction. Two ribbons leaving one node cross each other whenever
  // their slots and their targets disagree, and that is decided here.
  const outAt = names.map((_, i) => nodeAt[i] === -1 ? 0 : nodes[nodeAt[i]].y0);
  const inAt = names.map((_, i) => nodeAt[i] === -1 ? 0 : nodes[nodeAt[i]].y0);
  const sy = new Array(links.length);
  const ty = new Array(links.length);
  for (const at of orderedFaces(links, (l) => l.source, (l) => rank.get(l.target) ?? 0)) {
    sy[at] = outAt[links[at].source];
    outAt[links[at].source] += links[at].value * scale;
  }
  for (const at of orderedFaces(links, (l) => l.target, (l) => rank.get(l.source) ?? 0)) {
    ty[at] = inAt[links[at].target];
    inAt[links[at].target] += links[at].value * scale;
  }
  const linkAsts = links.map((link, at) => ({
    source: nodeAt[link.source],
    target: nodeAt[link.target],
    value: link.value,
    sy0: sy[at], sy1: sy[at] + link.value * scale,
    ty0: ty[at], ty1: ty[at] + link.value * scale,
  }));

  return {
    type: 'sankey',
    title: config.title ?? null,
    nodes,
    links: linkAsts,
  };
}

/**
 * Link indexes grouped by one endpoint and ordered by where the other
 * endpoint sits, groups in first-appearance order. The result is a flat
 * index list: walking it assigns every face's slots top-down.
 * @param {{source:number,target:number,value:number}[]} links
 * @param {(l: any) => number} faceOf the node whose face the slot is on
 * @param {(l: any) => number} keyOf the far end's position
 * @returns {number[]} link indexes
 */
function orderedFaces(links, faceOf, keyOf) {
  /** @type {Map<number, number[]>} */
  const faces = new Map();
  for (let at = 0; at < links.length; at++) {
    const face = faceOf(links[at]);
    let list = faces.get(face);
    if (list === undefined) faces.set(face, list = []);
    list.push(at);
  }
  const out = [];
  for (const list of faces.values()) {
    // stable: equal far ends keep input order
    list.sort((a, b) => keyOf(links[a]) - keyOf(links[b]));
    out.push(...list);
  }
  return out;
}

/**
 * Order the nodes inside each layer to reduce ribbon crossings, in
 * place. The heuristic is the classic barycenter sweep: repeatedly
 * place each node at the average position of its neighbors — value-
 * weighted, because a thick ribbon crossing reads worse than a thin one
 * — alternating down the layers and back up, and keeping whichever
 * arrangement counted the fewest crossings. Input order is the starting
 * arrangement and wins every tie, so a graph the sweeps cannot improve
 * (and every graph with one node per layer) lays out exactly as it did
 * before crossing reduction existed.
 *
 * Positions are compared as fractions of a layer's height, so a link
 * that skips a layer is measured against the same scale as its
 * neighbors.
 * @param {Map<number, number[]>} byLayer layer number → node indexes
 * @param {{source:number,target:number,value:number}[]} links
 * @returns {void}
 */
function reduceCrossings(byLayer, links) {
  const layers = [...byLayer.keys()].sort((a, b) => a - b);
  if (layers.length < 2 || links.length < 2) return;

  /** @type {Map<number, {other:number, value:number}[]>} */
  const inbound = new Map();
  /** @type {Map<number, {other:number, value:number}[]>} */
  const outbound = new Map();
  for (const link of links) {
    (inbound.get(link.target) ?? setDefault(inbound, link.target)).push({ other: link.source, value: link.value });
    (outbound.get(link.source) ?? setDefault(outbound, link.source)).push({ other: link.target, value: link.value });
  }

  /** Normalized position of every node in the current arrangement. */
  const positions = () => {
    const pos = new Map();
    for (const l of layers) {
      const list = byLayer.get(l);
      for (let i = 0; i < list.length; i++)
        pos.set(list[i], list.length === 1 ? 0.5 : i / (list.length - 1));
    }
    return pos;
  };

  const crossings = () => {
    const pos = positions();
    let count = 0;
    for (let a = 0; a < links.length; a++) {
      for (let b = a + 1; b < links.length; b++) {
        const ds = pos.get(links[a].source) - pos.get(links[b].source);
        const dt = pos.get(links[a].target) - pos.get(links[b].target);
        if (ds * dt < 0) count++;
      }
    }
    return count;
  };

  const sweep = (side) => {
    const pos = positions();
    for (const l of layers) {
      const list = byLayer.get(l);
      const key = new Map();
      for (let i = 0; i < list.length; i++) {
        const edges = side.get(list[i]) ?? [];
        let weight = 0;
        let sum = 0;
        for (const e of edges) {
          weight += e.value;
          sum += e.value * pos.get(e.other);
        }
        // no neighbors on this side: stay where you are
        key.set(list[i], weight === 0 ? pos.get(list[i]) : sum / weight);
      }
      list.sort((a, b) => key.get(a) - key.get(b));
    }
  };

  let best = layers.map((l) => byLayer.get(l).slice());
  let bestCount = crossings();
  for (let pass = 0; pass < 4 && bestCount !== 0; pass++) {
    for (const side of [inbound, outbound]) {
      sweep(side);
      const count = crossings();
      if (count < bestCount) {
        bestCount = count;
        best = layers.map((l) => byLayer.get(l).slice());
      }
    }
  }
  layers.forEach((l, i) => byLayer.set(l, best[i]));
}

/** Seed and return an empty adjacency list. */
function setDefault(map, key) {
  const list = [];
  map.set(key, list);
  return list;
}

/**
 * Render a sankey AST to a pure-vnode SVG: categorical node bars,
 * translucent muted ribbons with flow `<title>`s, node labels beside
 * the bar on its open side.
 * @param {SankeyAST} ast
 * @param {{tokens: Record<string,string>, cssVars: Record<string,string>}} theme
 * @param {string} hash
 * @param {{rootClass?: string, keyPrefix?: string, palette?: readonly string[], width?: number,
 *   tooltip?: import('../core/marks.js').ChartTooltipSpec}} [options]
 * @returns {any}
 */
export function renderSankeyAST(ast, theme, hash, options = {}) {
  const t = theme.tokens;
  const palette = options.palette ?? CATEGORICAL;
  const tooltip = normalizeTooltip(options.tooltip);
  const width = options.width ?? 560;
  const top = ast.title ? 34 : 8;
  const pad = 8;
  const plotW = width - 2 * pad;
  const plotH = 280;
  const children = [];

  if (ast.title) {
    children.push(chartTitle(width / 2, 22, ast.title, 15, t));
  }

  const X = (x) => coord(pad + x * plotW);
  const Y = (y) => coord(top + y * plotH);

  for (const link of ast.links) {
    const s = ast.nodes[link.source];
    const target = ast.nodes[link.target];
    const x0 = X(s.x1);
    const x1 = X(target.x0);
    const mx = coord((x0 + x1) / 2);
    children.push(valueMark('path', {
      d: `M${x0},${Y(link.sy0)} C${mx},${Y(link.sy0)} ${mx},${Y(link.ty0)} ${x1},${Y(link.ty0)} `
        + `L${x1},${Y(link.ty1)} C${mx},${Y(link.ty1)} ${mx},${Y(link.sy1)} ${x0},${Y(link.sy1)} Z`,
      fill: t.muted, 'fill-opacity': 0.3, class: 'chart-sankey-link',
    }, tooltip, `${s.name} → ${target.name}: ${link.value}`,
    { type: 'sankey', source: s.name, target: target.name, value: link.value }));
  }

  for (let i = 0; i < ast.nodes.length; i++) {
    const node = ast.nodes[i];
    children.push(valueMark('rect', {
      x: X(node.x0), y: Y(node.y0),
      width: coord((node.x1 - node.x0) * plotW),
      height: coord(Math.max(1, (node.y1 - node.y0) * plotH)),
      fill: seriesColor(i, palette), class: 'chart-sankey-node',
    }, tooltip, node.name, { type: 'sankey', node: node.name }));
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
