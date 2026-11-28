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
 * them (`marks.js`), a lollipop's interface end marked as no node; a
 * placeholder draws nothing a reader can point at.
 * A panel's heading and rows are read as every type's text is read
 * (`label-text.js`: broken at `<br>`, entity codes decoded), and measured and
 * drawn in those lines.
 */

import { svgRoot, group, rect, path, textAt, num, textWidth } from '@jarenjs/view/helpers';
import { readTextLines, textBlock, decodeEntityCodes, genericText } from '../label-text.js';
import { nodeMark, edgeMark, withTooltip, clickTooltips } from './marks.js';
import { mermaidText } from '../messages.js';

/**
 * @typedef {object} PanelSection
 * @property {string} heading
 * @property {string[]} rows
 * @property {string | null} id the class or entity a box draws, null for the relations box
 * @property {string} [annotation] the class's first `<<annotation>>`, drawn as `«text»` above its heading
 * @property {string} [tooltip] the tooltip text a `click` gave the class
 * @property {{ from: string, to: string, lollipop?: 'from' | 'to' }[]} [edges] the relations box's
 *   rows, as endpoints, and the end a lollipop (`foo --() bar`) names an interface at
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
  const read = sections.map((s) => ({
    annotation: s.annotation === undefined ? null : `«${decodeEntityCodes(s.annotation)}»`,
    heading: readTextLines(s.heading),
    rows: s.rows.map(readTextLines),
  }));
  const boxW = Math.max(180, ...read.flatMap((s) => [
    ...(s.annotation === null ? [] : [textWidth(s.annotation, fs) + 24]),
    ...s.heading.map((line) => textWidth(line, fs, 700) + 24),
    ...s.rows.flat().map((line) => textWidth(line, fs) + 24),
  ]));
  const gap = 16;
  const children = [];
  let y = 40;
  children.push(textAt(16, 24, title, fs + 3, { 'font-weight': 'bold', class: 'mm-text', fill: t.nodeText }));
  for (let si = 0; si < sections.length; si++) {
    const section = sections[si];
    const { annotation, heading, rows } = read[si];
    // a line of a heading or a row takes a row's height, and so does the
    // annotation Mermaid draws above the name
    const above = annotation === null ? 0 : rowH;
    const sectionHeadH = headH + above + (heading.length - 1) * rowH;
    const boxH = sectionHeadH + rows.reduce((n, lines) => n + lines.length, 0) * rowH + 8;
    const box = [
      rect(16, y, boxW, boxH, { rx: 4, fill: t.nodeFill, stroke: t.nodeStroke, 'stroke-width': 1, class: 'mm-panel' }),
      ...(annotation === null ? [] : [textAt(26, y + 17, annotation, fs, { class: 'mm-text', fill: t.nodeText })]),
      textBlock(26, y + 17 + above, heading, fs, rowH,
        section.id === null ? { 'font-weight': 'bold', class: 'mm-text', fill: t.nodeText } : { 'font-weight': 'bold', class: 'mm-label', fill: t.nodeText }),
      path(`M16,${num(y + sectionHeadH)} h${boxW}`, { class: 'mm-panel-rule', stroke: t.nodeStroke, 'stroke-width': 1 }),
    ];
    let rowY = y + sectionHeadH + 16;
    for (let i = 0; i < rows.length; i++) {
      const row = textBlock(26, rowY, rows[i], fs, rowH, { class: 'mm-text', fill: t.nodeText });
      rowY += rows[i].length * rowH;
      const edge = section.edges?.[i];
      if (edge === undefined) { box.push(row); continue; }
      const mark = edgeMark(i, edge.from, edge.to, 'rel-' + i);
      // a lollipop's end names an interface, never the class of that name
      if (edge.lollipop !== undefined) mark['data-lollipop'] = edge.lollipop;
      box.push(group(mark, [row]));
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
 * @param {string} [noteId] - the second line's message id; a secondary type's by default
 * @param {Readonly<Record<string, unknown>> | null} [messages] the reader's compiled catalog
 * @returns {any}
 */
export function renderPlaceholder(type, theme, hash, noteId = 'mermaid/placeholder/secondary', messages = null) {
  const say = mermaidText(messages);
  const t = theme.tokens;
  const width = 380;
  const height = 84;
  return svgRoot('mermaid mm-svg', width, height, theme, [
    rect(1, 1, width - 2, height - 2, { rx: 6, class: 'mm-placeholder', fill: t.clusterFill, stroke: t.clusterStroke, 'stroke-width': 1, 'stroke-dasharray': '5 4' }),
    textAt(width / 2, 36, say('mermaid/placeholder/type', { type }), 15, { 'font-weight': 'bold', 'text-anchor': 'middle', class: 'mm-text', fill: t.nodeText }),
    textAt(width / 2, 58, say(noteId), 12, { 'text-anchor': 'middle', class: 'mm-text', fill: t.nodeText }),
  ], 'mmph-' + hash);
}

/**
 * A class relation's two ends, and the end its lollipop stands at: the
 * interface a lollipop names (`foo --() bar` names `bar`) is no class, and
 * the relations box marks it so (`data-lollipop`) that a class of the same
 * name is not taken as that end.
 * @param {{ from: string, to: string, type: string }} r
 * @returns {{ from: string, to: string, lollipop?: 'from' | 'to' }}
 */
function relationEnds(r) {
  const atFrom = r.type.startsWith('()');
  if (atFrom === r.type.endsWith('()')) return { from: r.from, to: r.to };
  return { from: r.from, to: r.to, lollipop: atFrom ? 'from' : 'to' };
}

/**
 * Build the sections for the structured renderers.
 * @param {string} diagram
 * @param {any} ast
 * @param {Readonly<Record<string, unknown>> | null} [messages] the reader's compiled catalog, for the
 *   title and the relations box's heading
 * @returns {{ title: string, sections: PanelSection[] }}
 */
export function structuredSections(diagram, ast, messages = null) {
  const say = mermaidText(messages);
  if (diagram === 'class') {
    const tips = clickTooltips(ast.clicks, decodeEntityCodes);
    /** @type {PanelSection[]} */
    const sections = ast.classes.map((c) => ({
      heading: c.generic == null ? c.name : `${c.name}<${genericText(c.generic, '<', '>')}>`,
      // Mermaid draws a class's first annotation, and only that one
      ...(c.annotations?.length ? { annotation: c.annotations[0] } : {}),
      rows: c.members.map((m) => `${m.visibility ?? ''}${m.text}`),
      id: c.name,
      tooltip: tips.get(c.name),
    }));
    if (ast.relations.length) {
      sections.push({
        heading: say('mermaid/class/relations'),
        rows: ast.relations.map((r) => `${r.from} ${r.type} ${r.to}${r.label ? ' : ' + r.label : ''}`),
        id: null,
        edges: ast.relations.map(relationEnds),
      });
    }
    return { title: say('mermaid/class/title'), sections };
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
        heading: say('mermaid/er/relationships'),
        rows: ast.relationships.map((r) => `${r.left} ${r.leftCard}--${r.rightCard} ${r.right} : ${r.label}`),
        id: null,
        edges: ast.relationships.map((r) => ({ from: r.left, to: r.right })),
      });
    }
    return { title: say('mermaid/er/title'), sections };
  }
  // state diagrams left this path for the graph layout, and gantt left
  // it for the real timeline (`layout/gantt.js`); a stray call must fail
  // loudly rather than quietly resurrect the old panel
  throw new Error(`structuredSections: '${diagram}' is not a structured-panel type`);
}
