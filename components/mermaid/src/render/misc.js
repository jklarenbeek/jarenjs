//@ts-check
/**
 * @file Renderers for the first-class types beyond flowchart and
 * sequence, and an honest placeholder for the deferred secondary
 * types. Class and ER render as structured panels — a readable,
 * geometry-light view that renders without error and so counts
 * honestly in the coverage scorecard. Secondary types (mindmap,
 * gitGraph, journey, timeline) render a labeled "not yet laid out"
 * placeholder. Pie is drawn by the renderer the host injects (charts'
 * `mermaidPieRenderer`), or by the placeholder when none was.
 *
 * A class's or an entity's box is a node of its name, and each row of the
 * relations box an edge between the two it names, marked as every type marks
 * them (`marks.js`); a placeholder draws nothing a reader can point at.
 */

import { svgRoot, group, rect, path, textAt, num, textWidth } from '@jarenjs/view/helpers';
import { nodeMark, edgeMark, withTooltip, clickTooltips } from './marks.js';

/**
 * @typedef {object} PanelSection
 * @property {string} heading
 * @property {string[]} rows
 * @property {string | null} id the class or entity a box draws, null for the relations box
 * @property {string} [tooltip] the tooltip text a `click` gave the class
 * @property {{ from: string, to: string }[]} [edges] the relations box's rows, as endpoints
 */

/**
 * Render a structured panel: a title and a list of sections, each a
 * bordered box with a heading and text rows.
 * @param {string} title
 * @param {PanelSection[]} sections
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
    const box = [
      rect(16, y, boxW, boxH, { rx: 4, fill: t.nodeFill, stroke: t.nodeStroke, 'stroke-width': 1, class: 'mm-panel' }),
      textAt(26, y + 17, section.heading, fs,
        section.id === null ? { 'font-weight': 'bold', fill: t.nodeText } : { 'font-weight': 'bold', class: 'mm-label', fill: t.nodeText }),
      path(`M16,${num(y + headH)} h${boxW}`, { stroke: t.nodeStroke, 'stroke-width': 1 }),
    ];
    for (let i = 0; i < section.rows.length; i++) {
      const row = textAt(26, y + headH + 16 + i * rowH, section.rows[i], fs, { fill: t.nodeText });
      const edge = section.edges?.[i];
      box.push(edge === undefined ? row : group(edgeMark(i, edge.from, edge.to, 'rel-' + i), [row]));
    }
    if (section.id === null) children.push(...box);
    else children.push(group(nodeMark(section.id, 'panel-' + section.id), withTooltip(box, section.tooltip)));
    y += boxH + gap;
  }
  return svgRoot('mermaid mm-svg', boxW + 32, y, theme, children,
    'mmstruct-' + hash, { fit: false });
}

/**
 * The honest placeholder for a parse-accepted type this engine does not
 * draw: a secondary type, or a pie when no pie renderer was injected.
 * @param {string} type
 * @param {any} theme
 * @param {string} hash
 * @param {string} [note] - the second line; a secondary type's by default
 * @returns {any}
 */
export function renderPlaceholder(type, theme, hash, note = 'parsed — not yet laid out in v1') {
  const t = theme.tokens;
  const width = 380;
  const height = 84;
  return svgRoot('mermaid mm-svg', width, height, theme, [
    rect(1, 1, width - 2, height - 2, { rx: 6, fill: t.clusterFill, stroke: t.clusterStroke, 'stroke-width': 1, 'stroke-dasharray': '5 4' }),
    textAt(width / 2, 36, `${type} diagram`, 15, { 'font-weight': 'bold', 'text-anchor': 'middle', fill: t.nodeText }),
    textAt(width / 2, 58, note, 12, { 'text-anchor': 'middle', fill: t.nodeText }),
  ], 'mmph-' + hash);
}

/**
 * Build the sections for the structured renderers.
 * @param {string} diagram
 * @param {any} ast
 * @returns {{ title: string, sections: PanelSection[] }}
 */
export function structuredSections(diagram, ast) {
  if (diagram === 'class') {
    const tips = clickTooltips(ast.clicks);
    /** @type {PanelSection[]} */
    const sections = ast.classes.map((c) => ({
      heading: c.name,
      rows: c.members.map((m) => `${m.visibility ?? ''}${m.text}`),
      id: c.name,
      tooltip: tips.get(c.name),
    }));
    if (ast.relations.length) {
      sections.push({
        heading: 'relations',
        rows: ast.relations.map((r) => `${r.from} ${r.type} ${r.to}${r.label ? ' : ' + r.label : ''}`),
        id: null,
        edges: ast.relations,
      });
    }
    return { title: 'Class diagram', sections };
  }
  if (diagram === 'er') {
    /** @type {PanelSection[]} */
    const sections = ast.entities.map((e) => ({
      heading: e.name,
      rows: e.attributes.map((a) => `${a.type} ${a.name}${a.keys.length ? ' ' + a.keys.join(',') : ''}`),
      id: e.name,
    }));
    if (ast.relationships.length) {
      sections.push({
        heading: 'relationships',
        rows: ast.relationships.map((r) => `${r.left} ${r.leftCard}--${r.rightCard} ${r.right} : ${r.label}`),
        id: null,
        edges: ast.relationships.map((r) => ({ from: r.left, to: r.right })),
      });
    }
    return { title: 'Entity–relationship', sections };
  }
  // state diagrams left this path for the graph layout, and gantt left
  // it for the real timeline (`layout/gantt.js`); a stray call must fail
  // loudly rather than quietly resurrect the old panel
  throw new Error(`structuredSections: '${diagram}' is not a structured-panel type`);
}
