//@ts-check
/**
 * @file Renderers for the first-class types beyond flowchart and
 * sequence, and an honest placeholder for the deferred secondary
 * types. Pie is
 * a real chart; class/ER/state/gantt render as structured panels — a
 * readable, geometry-light view that renders without error and so counts
 * honestly in the coverage scorecard. Secondary types (mindmap,
 * gitGraph, journey, timeline) render a labeled "not yet laid out"
 * placeholder.
 */

import { svgRoot, rect, path, textAt, num, textWidth } from '@jarenjs/view/helpers';
import { buildPieAST, renderPieAST, CATEGORICAL } from '@jarenjs/charts';
import { mermaidPieToChartAST } from '@jarenjs/charts/transforms/mermaid-adapter';

/**
 * Pie rendering delegates to `@jarenjs/charts` (the pie engine's single
 * home); the options carry the mermaid class names, palette and theme
 * so the SVG is byte-identical to the pre-delegation renderer.
 * @param {any} ast pie AST
 * @param {any} theme
 * @param {string} hash
 * @returns {any}
 */
export function renderPie(ast, theme, hash) {
  const { config, data } = mermaidPieToChartAST(ast);
  return renderPieAST(buildPieAST(data, config), theme, hash, {
    rootClass: 'mermaid mm-svg',
    keyPrefix: 'mmpie-',
    sliceClass: 'mm-pie-slice',
    legendClass: 'mm-pie-legend',
    palette: CATEGORICAL,
    textColor: theme.tokens.nodeText,
    sliceStroke: '#fff',
    // A mermaid diagram's SVG is a byte-stable contract; the per-slice
    // hover text charts adds for its own pies would break it.
    titles: false,
  });
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
  children.push(textAt(16, 24, title, fs + 3, { 'font-weight': 'bold', fill: t.nodeText }));
  for (const section of sections) {
    const boxH = headH + section.rows.length * rowH + 8;
    children.push(rect(16, y, boxW, boxH, { rx: 4, fill: t.nodeFill, stroke: t.nodeStroke, 'stroke-width': 1, class: 'mm-panel' }));
    children.push(textAt(26, y + 17, section.heading, fs, { 'font-weight': 'bold', fill: t.nodeText }));
    children.push(path(`M16,${num(y + headH)} h${boxW}`, { stroke: t.nodeStroke, 'stroke-width': 1 }));
    for (let i = 0; i < section.rows.length; i++) {
      children.push(textAt(26, y + headH + 16 + i * rowH, section.rows[i], fs, { fill: t.nodeText }));
    }
    y += boxH + gap;
  }
  return svgRoot('mermaid mm-svg', boxW + 32, y, theme, children,
    'mmstruct-' + hash, { fit: false });
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
    textAt(width / 2, 36, `${type} diagram`, 15, { 'font-weight': 'bold', 'text-anchor': 'middle', fill: t.nodeText }),
    textAt(width / 2, 58, 'parsed — not yet laid out in v1', 12, { 'text-anchor': 'middle', fill: t.nodeText }),
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
