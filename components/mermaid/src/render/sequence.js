//@ts-check
/**
 * @file Sequence renderer: `PositionedDiagram` → pure-vnode SVG.
 * Actor boxes (top and bottom), each participant type in Mermaid's glyph
 * for it, dashed lifelines, activation bars, messages with solid/dotted
 * lines and arrow/open/cross/async heads, Mermaid's half heads and two-way
 * heads and its central-connection dots, note boxes and block frames. Both boxes of an actor are nodes of that
 * participant's id and every message an edge between two of them, marked
 * as every type marks them (`marks.js`). Text is drawn in the `lines` the
 * layout read and measured it in.
 */

import { svgRoot, group, rect, path, line, polygon, circle, textAt, textLines, num, coord } from '@jarenjs/view/helpers';
import { textBlock } from '../label-text.js';
import { SELF_LOOP_W, GLYPH_TYPES, GLYPH_ROOM } from '../layout/sequence.js';
import { nodeMark, edgeMark } from './marks.js';

/** The advance from one line of a text to the next (`textLines`' own). */
const LINE_FACTOR = 1.2;

/**
 * @param {any} scene PositionedDiagram (sequence)
 * @param {{ tokens: Record<string,string>, cssVars: Record<string,string> }} theme
 * @param {string} hash
 * @returns {any}
 */
export function renderSequence(scene, theme, hash) {
  const t = theme.tokens;
  const fs = scene.fontSize;
  const children = [];

  // Block frames (behind).
  for (let i = 0; i < scene.blocks.length; i++) {
    const b = scene.blocks[i];
    children.push(renderBlock(b, t, fs, i));
  }

  // Lifelines.
  for (const a of scene.actors) {
    children.push(line(a.x, scene.lineTop, a.x, a.bottomY, {
      class: 'mm-lifeline', stroke: t.lifeline, 'stroke-width': 1, 'stroke-dasharray': '3 3',
    }));
  }

  // Activation bars.
  for (const act of scene.activations) {
    children.push(rect(act.x, act.y, act.w, act.h, {
      class: 'mm-activation', fill: t.activationFill, stroke: t.activationStroke, 'stroke-width': 1,
    }));
  }

  // Actor boxes, top and bottom.
  for (const a of scene.actors) {
    children.push(actorBox(a, a.boxY, t, fs, 'actor-head-' + a.id));
    children.push(actorBox(a, a.bottomY, t, fs, 'actor-foot-' + a.id));
  }

  // Notes.
  for (let i = 0; i < scene.notes.length; i++) {
    const nnode = scene.notes[i];
    children.push(group({ class: 'mm-note', key: 'note-' + i }, [
      rect(nnode.x, nnode.y, nnode.w, nnode.h, { fill: t.noteFill, stroke: t.noteStroke, 'stroke-width': 1 }),
      textLines(nnode.x + nnode.w / 2, nnode.y + nnode.h / 2, nnode.lines, fs, { fill: t.noteText }),
    ]));
  }

  // Messages.
  for (let i = 0; i < scene.messages.length; i++) {
    children.push(renderMessage(scene.messages[i], t, fs, i));
  }

  return svgRoot('mermaid mm-svg', scene.width, scene.height, theme, children,
    'mmseq-' + hash, { fit: false });
}

/**
 * @param {any} a actor @param {number} y box top @param {Record<string,string>} t @param {number} fs
 * @param {string} key
 * @returns {any}
 */
function actorBox(a, y, t, fs, key) {
  const label = { class: 'mm-label', fill: t.actorText, 'font-weight': 'bold' };
  if (GLYPH_TYPES.has(a.type)) {
    // the glyph above the name, the name below it
    return group(nodeMark(a.id, key, 'mm-actor'), [
      ...actorGlyph(a.type, a.x, y + 4 + GLYPH_R, t),
      textLines(a.x, y + GLYPH_ROOM + (a.h - GLYPH_ROOM) / 2, a.lines, fs, label),
    ]);
  }
  return group(nodeMark(a.id, key, 'mm-actor'), [
    ...actorShape(a, y, t),
    textLines(a.x, y + a.h / 2, a.lines, fs, label),
  ]);
}

/** The radius of a participant glyph's circle. */
const GLYPH_R = 13;

/**
 * The box around a participant's name: a database's cylinder, a queue's
 * cylinder on its side, a collection's two boxes, any other participant's
 * box. A shape carries the `mm-actor-shape` class (a box `rect` the
 * stylesheet's `.mm-actor rect` already themes).
 * @param {any} a actor @param {number} y box top @param {Record<string,string>} t
 * @returns {any[]}
 */
function actorShape(a, y, t) {
  const shape = { class: 'mm-actor-shape', fill: t.actorFill, stroke: t.actorStroke, 'stroke-width': 1 };
  const { boxX: x, w, h } = a;
  if (a.type === 'database') {
    const ry = coord(Math.min(7, h / 5));
    return [path(`M${x},${coord(y + ry)} a${coord(w / 2)},${ry} 0 0 0 ${w},0 a${coord(w / 2)},${ry} 0 0 0 ${-w},0`
      + ` l0,${coord(h - 2 * ry)} a${coord(w / 2)},${ry} 0 0 0 ${w},0 l0,${coord(-(h - 2 * ry))}`, shape)];
  }
  if (a.type === 'queue') {
    const rx = coord(Math.max(4, h / 6));
    return [
      path(`M${coord(x + rx)},${y} a${rx},${coord(h / 2)} 0 0 0 0,${h} h${coord(w - 2 * rx)} a${rx},${coord(h / 2)} 0 0 0 0,${-h} Z`, shape),
      path(`M${coord(x + w - rx)},${y} a${rx},${coord(h / 2)} 0 0 0 0,${h}`, shape),
    ];
  }
  const box = { rx: 3, fill: t.actorFill, stroke: t.actorStroke, 'stroke-width': 1 };
  if (a.type === 'collections') return [rect(x + 4, y - 4, w, h, box), rect(x, y, w, h, box)];
  return [rect(x, y, w, h, box)];
}

/**
 * A boundary's, a control's or an entity's glyph, as Mermaid draws it: a
 * circle (`mm-actor-shape`) with a bar on its left, an arrow on its top or a
 * line under it (`mm-actor-mark`, the stroke's color).
 * @param {string} type @param {number} cx @param {number} cy @param {Record<string,string>} t
 * @returns {any[]}
 */
function actorGlyph(type, cx, cy, t) {
  const R = GLYPH_R;
  const mark = { class: 'mm-actor-mark', fill: t.actorStroke, stroke: t.actorStroke, 'stroke-width': 1.5 };
  const ring = circle(cx, cy, R, { class: 'mm-actor-shape', fill: t.actorFill, stroke: t.actorStroke, 'stroke-width': 1.5 });
  if (type === 'boundary') {
    const bx = cx - R - 10;
    return [ring, path(`M${bx},${cy - R} V${cy + R} M${bx},${cy} H${cx - R}`, mark)];
  }
  if (type === 'control') {
    return [ring, polygon([
      { x: cx - 5, y: cy - R }, { x: cx + 3, y: cy - R - 4 }, { x: cx + 1, y: cy - R }, { x: cx + 3, y: cy - R + 4 },
    ], mark)];
  }
  return [ring, path(`M${cx - R},${cy + R} H${cx + R}`, mark)];
}

/**
 * @param {any} m @param {Record<string,string>} t @param {number} fs @param {number} i
 * @returns {any}
 */
function renderMessage(m, t, fs, i) {
  const stroke = t.lineColor;
  const dash = m.line === 'dotted' ? '4 3' : null;
  const parts = [];
  const lineProps = { class: 'mm-message-line', stroke, 'stroke-width': 1.2, fill: 'none' };
  if (dash) lineProps['stroke-dasharray'] = dash;
  const central = m.central ?? null;

  if (m.self) {
    const loopW = SELF_LOOP_W;
    const y0 = m.y;
    const y1 = m.y + 26;
    parts.push(path(`M${num(m.x1)},${num(y0)} h${loopW} v${y1 - y0} h${-loopW}`, lineProps));
    // the loop leaves rightwards and comes back leftwards
    parts.push(...heads(m.head, { x: m.x1 + 6, y: y0 }, 1, { x: m.x1 + 6, y: y1 }, -1, stroke));
    if (central === 'from' || central === 'both') parts.push(centralDot(m.x1, y0, stroke));
    if (central === 'to' || central === 'both') parts.push(centralDot(m.x1, y1, stroke));
    // centered on the loop's middle, line for line
    const top = (y0 + y1) / 2 - ((m.lines.length - 1) * fs * LINE_FACTOR) / 2;
    parts.push(textBlock(m.x1 + loopW + 6, top, m.lines, fs, fs * LINE_FACTOR, { class: 'mm-message-label mm-edge-label', fill: t.edgeLabelText }));
  }
  else {
    const dir = m.x2 >= m.x1 ? 1 : -1;
    // a central-connection dot sits on the lifeline, and the line stops at it
    const x1 = central === 'from' || central === 'both' ? m.x1 + dir * CENTRAL_R : m.x1;
    const x2 = central === 'to' || central === 'both' ? m.x2 - dir * CENTRAL_R : m.x2;
    parts.push(line(x1, m.y, x2, m.y, lineProps));
    parts.push(...heads(m.head, { x: x1, y: m.y }, dir, { x: x2, y: m.y }, dir, stroke));
    if (central === 'from' || central === 'both') parts.push(centralDot(m.x1, m.y, stroke));
    if (central === 'to' || central === 'both') parts.push(centralDot(m.x2, m.y, stroke));
    const midX = (m.x1 + m.x2) / 2;
    // the last line sits on the message's line, the others above it
    const top = m.y - 6 - (m.lines.length - 1) * fs * LINE_FACTOR;
    parts.push(textBlock(midX, top, m.lines, fs, fs * LINE_FACTOR, {
      'text-anchor': 'middle', class: 'mm-message-label mm-edge-label', fill: t.edgeLabelText,
    }));
  }
  return group(edgeMark(i, m.from, m.to, 'msg-' + i, 'mm-message'), parts);
}

/** The radius of a central-connection dot. */
const CENTRAL_R = 4;

/**
 * A central-connection mark (`A()->>()B`): a dot on the lifeline.
 * @param {number} x @param {number} y @param {string} color
 * @returns {any}
 */
function centralDot(x, y, color) {
  return circle(x, y, CENTRAL_R, { class: 'mm-arrowhead', fill: color, stroke: color });
}

/**
 * A message's heads: the one at the receiver's end (`to`, travelling
 * `toDir`), both ends' for a two-way message, and a half head written before
 * the line at the sender's end (`from`, where the line leaves travelling
 * `fromDir`), pointing back at the sender.
 * @param {string} head
 * @param {{x:number,y:number}} from @param {number} fromDir
 * @param {{x:number,y:number}} to @param {number} toDir
 * @param {string} color
 * @returns {any[]}
 */
function heads(head, from, fromDir, to, toDir, color) {
  if (head === 'both') {
    return [arrowHead(to, { x: to.x - toDir, y: to.y }, 'arrow', color), arrowHead(from, { x: from.x + fromDir, y: from.y }, 'arrow', color)];
  }
  if (head.startsWith('half-') || head.startsWith('stick-')) {
    return head.endsWith('-reverse')
      ? [halfHead(head, from, -fromDir, fromDir, color)]
      : [halfHead(head, to, toDir, toDir, color)];
  }
  return [arrowHead(to, { x: to.x - toDir, y: to.y }, head, color)];
}

/**
 * A half head, as Mermaid draws one: a filled half triangle (`half-*`) or a
 * single stroke (`stick-*`) on one side of the line. Its `top` or `bottom`
 * is the side to the left or the right of the way the line travels
 * (`travel`), so a message right to left draws `-|\` under its line, as
 * Mermaid does.
 * @param {string} head @param {{x:number,y:number}} tip @param {number} dir the way it points
 * @param {number} travel the way the line travels @param {string} color
 * @returns {any}
 */
function halfHead(head, tip, dir, travel, color) {
  const side = (head.includes('top') ? -1 : 1) * travel;
  if (head.startsWith('stick-')) {
    return path(`M${num(tip.x)},${num(tip.y)} L${num(tip.x - dir * 7)},${num(tip.y + side * 7)}`,
      { class: 'mm-arrowhead', stroke: color, 'stroke-width': 1.2, fill: 'none' });
  }
  return polygon([
    { x: tip.x, y: tip.y }, { x: tip.x - dir * 8, y: tip.y }, { x: tip.x - dir * 8, y: tip.y + side * 6 },
  ], { class: 'mm-arrowhead', fill: color, stroke: color });
}

/**
 * @param {{x:number,y:number}} tip @param {{x:number,y:number}} from
 * @param {string} head @param {string} color
 * @returns {any}
 */
function arrowHead(tip, from, head, color) {
  const dir = tip.x >= from.x ? 1 : -1;
  const size = 8;
  if (head === 'cross') {
    const s = 5;
    return path(
      `M${num(tip.x)},${num(tip.y - s)} L${num(tip.x - dir * s)},${num(tip.y + s)}`
      + ` M${num(tip.x)},${num(tip.y + s)} L${num(tip.x - dir * s)},${num(tip.y - s)}`,
      { stroke: color, 'stroke-width': 1.5, fill: 'none' });
  }
  if (head === 'open') {
    return path(
      `M${num(tip.x - dir * size)},${num(tip.y - 5)} L${num(tip.x)},${num(tip.y)} L${num(tip.x - dir * size)},${num(tip.y + 5)}`,
      { stroke: color, 'stroke-width': 1.2, fill: 'none' });
  }
  // filled arrow / async point → filled triangle
  return polygon([
    { x: tip.x, y: tip.y },
    { x: tip.x - dir * size, y: tip.y - 4 },
    { x: tip.x - dir * size, y: tip.y + 4 },
  ], { class: 'mm-arrowhead', fill: color, stroke: color });
}

/**
 * @param {any} b @param {Record<string,string>} t @param {number} fs @param {number} i
 * @returns {any}
 */
function renderBlock(b, t, fs, i) {
  const label = b.blockType + (b.label ? ' [' + b.label + ']' : '');
  const tabW = Math.max(48, label.length * fs * 0.5 + 16);
  const parts = [
    rect(b.x, b.y, b.w, b.h, { class: 'mm-block', fill: 'none', stroke: t.actorStroke, 'stroke-width': 1 }),
    path(`M${num(b.x)},${num(b.y + 18)} h${num(tabW)} l-8,6 h${num(-tabW + 8)} Z`, { fill: t.clusterFill, stroke: t.actorStroke, 'stroke-width': 1 }),
    textAt(b.x + 6, b.y + 14, label, fs - 1, { 'font-weight': 'bold', class: 'mm-block-label', fill: t.nodeText }),
  ];
  for (const d of b.dividers) {
    parts.push(line(b.x, d.y, b.x + b.w, d.y, { stroke: t.actorStroke, 'stroke-width': 1, 'stroke-dasharray': '2 2' }));
    if (d.label) parts.push(textAt(b.x + b.w / 2, d.y - 4, '[' + d.label + ']', fs - 1, { 'text-anchor': 'middle', class: 'mm-block-divider-label', fill: t.nodeText }));
  }
  return group({ class: 'mm-block-group', key: 'blk-' + i }, parts);
}
