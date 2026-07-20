//@ts-check
/**
 * @file Renderers for the remaining first-class types (D10 step 2) and
 * an honest placeholder for the deferred secondary types (WI 7). Pie is
 * a real chart; class/ER/state/gantt render as structured panels — a
 * readable, geometry-light view that renders without error and so counts
 * honestly in the coverage scorecard. Secondary types (mindmap,
 * gitGraph, journey, timeline) render a labeled "not yet laid out"
 * placeholder.
 */

import { h } from '@jarenjs/view';
import { svgRoot, rect, path, group, num } from '@jarenjs/view/helpers';
import { textWidth } from '../layout/metrics.js';

/** A categorical palette for pie slices. */
const PIE_COLORS = ['#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f', '#edc948', '#b07aa1', '#ff9da7', '#9c755f', '#bab0ac'];

/**
 * @param {any} ast pie AST
 * @param {any} theme
 * @param {string} hash
 * @returns {any}
 */
export function renderPie(ast, theme, hash) {
  const t = theme.tokens;
  const fs = 14;
  const R = 130;
  const cx = R + 20;
  const cy = R + 40;
  const total = ast.slices.reduce((s, x) => s + x.value, 0) || 1;
  const slices = [];
  let angle = -Math.PI / 2;
  for (let i = 0; i < ast.slices.length; i++) {
    const frac = ast.slices[i].value / total;
    const next = angle + frac * Math.PI * 2;
    const x1 = cx + R * Math.cos(angle);
    const y1 = cy + R * Math.sin(angle);
    const x2 = cx + R * Math.cos(next);
    const y2 = cy + R * Math.sin(next);
    const large = frac > 0.5 ? 1 : 0;
    const color = PIE_COLORS[i % PIE_COLORS.length];
    slices.push(path(
      `M${num(cx)},${num(cy)} L${num(x1)},${num(y1)} A${R},${R} 0 ${large} 1 ${num(x2)},${num(y2)} Z`,
      { fill: color, stroke: '#fff', 'stroke-width': 1, class: 'mm-pie-slice' }));
    angle = next;
  }

  // Legend.
  const legendX = 2 * R + 50;
  let legendW = 120;
  const legend = ast.slices.map((s, i) => {
    const y = 40 + i * 24;
    const label = `${s.label} (${((s.value / total) * 100).toFixed(1)}%)`;
    legendW = Math.max(legendW, textWidth(label, fs) + 30);
    return group({ class: 'mm-pie-legend' }, [
      rect(legendX, y, 14, 14, { fill: PIE_COLORS[i % PIE_COLORS.length] }),
      h('text', { x: num(legendX + 20), y: num(y + 12), 'font-size': fs, fill: t.nodeText }, label),
    ]);
  });

  const children = [];
  if (ast.title) {
    children.push(h('text', { x: num(cx), y: 24, 'font-size': fs + 2, 'font-weight': 'bold', 'text-anchor': 'middle', fill: t.nodeText }, ast.title));
  }
  children.push(...slices, ...legend);
  const width = legendX + legendW + 20;
  const height = 2 * R + 70;
  return svgRoot('mermaid mm-svg', width, height, theme, children, 'mmpie-' + hash);
}

/**
 * Render a structured panel: a title and a list of sections, each a
 * bordered box with a heading and text rows.
 * @param {string} title
 * @param {{ heading: string, rows: string[] }[]} sections
 * @param {any} theme
 * @param {string} hash
 * @returns {any}
 */
export function renderStructured(title, sections, theme, hash) {
  const t = theme.tokens;
  const fs = 13;
  const rowH = 22;
  const headH = 26;
  const boxW = Math.max(180, ...sections.flatMap((s) => [
    textWidth(s.heading, fs, 700) + 24,
    ...s.rows.map((r) => textWidth(r, fs) + 24),
  ]));
  const gap = 16;
  const children = [];
  let y = 40;
  children.push(h('text', { x: 16, y: 24, 'font-size': fs + 3, 'font-weight': 'bold', fill: t.nodeText }, title));
  for (const section of sections) {
    const boxH = headH + section.rows.length * rowH + 8;
    children.push(rect(16, y, boxW, boxH, { rx: 4, fill: t.nodeFill, stroke: t.nodeStroke, 'stroke-width': 1, class: 'mm-panel' }));
    children.push(h('text', { x: 26, y: num(y + 17), 'font-size': fs, 'font-weight': 'bold', fill: t.nodeText }, section.heading));
    children.push(path(`M16,${num(y + headH)} h${boxW}`, { stroke: t.nodeStroke, 'stroke-width': 1 }));
    for (let i = 0; i < section.rows.length; i++) {
      children.push(h('text', { x: 26, y: num(y + headH + 16 + i * rowH), 'font-size': fs, fill: t.nodeText }, section.rows[i]));
    }
    y += boxH + gap;
  }
  return svgRoot('mermaid mm-svg', boxW + 32, y, theme, children, 'mmstruct-' + hash);
}

/**
 * The honest placeholder for a parse-accepted secondary type.
 * @param {string} type
 * @param {any} theme
 * @param {string} hash
 * @returns {any}
 */
export function renderPlaceholder(type, theme, hash) {
  const t = theme.tokens;
  const width = 380;
  const height = 84;
  return svgRoot('mermaid mm-svg', width, height, theme, [
    rect(1, 1, width - 2, height - 2, { rx: 6, fill: t.clusterFill, stroke: t.clusterStroke, 'stroke-width': 1, 'stroke-dasharray': '5 4' }),
    h('text', { x: num(width / 2), y: 36, 'font-size': 15, 'font-weight': 'bold', 'text-anchor': 'middle', fill: t.nodeText }, `${type} diagram`),
    h('text', { x: num(width / 2), y: 58, 'font-size': 12, 'text-anchor': 'middle', fill: t.nodeText }, 'parsed — not yet laid out in v1'),
  ], 'mmph-' + hash);
}

/**
 * Build the sections for the structured renderers.
 * @param {string} diagram
 * @param {any} ast
 * @returns {{ title: string, sections: { heading: string, rows: string[] }[] }}
 */
export function structuredSections(diagram, ast) {
  if (diagram === 'class') {
    const sections = ast.classes.map((c) => ({
      heading: c.name,
      rows: c.members.map((m) => `${m.visibility ?? ''}${m.text}`),
    }));
    if (ast.relations.length) {
      sections.push({ heading: 'relations', rows: ast.relations.map((r) => `${r.from} ${r.type} ${r.to}${r.label ? ' : ' + r.label : ''}`) });
    }
    return { title: 'Class diagram', sections };
  }
  if (diagram === 'er') {
    const sections = ast.entities.map((e) => ({
      heading: e.name,
      rows: e.attributes.map((a) => `${a.type} ${a.name}${a.keys.length ? ' ' + a.keys.join(',') : ''}`),
    }));
    if (ast.relationships.length) {
      sections.push({ heading: 'relationships', rows: ast.relationships.map((r) => `${r.left} ${r.leftCard}--${r.rightCard} ${r.right} : ${r.label}`) });
    }
    return { title: 'Entity–relationship', sections };
  }
  if (diagram === 'state') {
    return {
      title: 'State machine',
      sections: [
        { heading: 'states', rows: ast.states.map((s) => (s.label !== s.id ? `${s.id}: ${s.label}` : s.id)) },
        { heading: 'transitions', rows: ast.transitions.map((tr) => `${tr.from} → ${tr.to}${tr.event ? ' : ' + tr.event : ''}`) },
      ],
    };
  }
  // gantt
  return {
    title: 'Gantt' + (ast.meta.title ? ': ' + ast.meta.title : ''),
    sections: ast.sections.map((s) => ({
      heading: s.name ?? 'tasks',
      rows: s.tasks.map((tk) => `${tk.name} — ${tk.info}`),
    })),
  };
}
