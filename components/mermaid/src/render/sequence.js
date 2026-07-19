//@ts-check
/**
 * @file Sequence renderer: `PositionedDiagram` → pure-vnode SVG.
 * Actor boxes (top and bottom), dashed lifelines, activation bars,
 * messages with solid/dotted lines and arrow/open/cross/async heads,
 * note boxes and block frames.
 */

import { h } from '@jarenjs/view';
import { svgRoot, group, rect, path, line, textLines, num } from './svg.js';

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
    children.push(actorBox(a, a.boxY, t, fs));
    children.push(actorBox(a, a.bottomY, t, fs));
  }

  // Notes.
  for (let i = 0; i < scene.notes.length; i++) {
    const nnode = scene.notes[i];
    children.push(group({ class: 'mm-note', key: 'note-' + i }, [
      rect(nnode.x, nnode.y, nnode.w, nnode.h, { fill: t.noteFill, stroke: t.noteStroke, 'stroke-width': 1 }),
      textLines(nnode.x + nnode.w / 2, nnode.y + nnode.h / 2, nnode.text.split('\n'), fs, { fill: t.noteText }),
    ]));
  }

  // Messages.
  for (let i = 0; i < scene.messages.length; i++) {
    children.push(renderMessage(scene.messages[i], t, fs, i));
  }

  return svgRoot(scene.width, scene.height, theme, children, 'mmseq-' + hash);
}

/**
 * @param {any} a actor @param {number} y box top @param {Record<string,string>} t @param {number} fs
 * @returns {any}
 */
function actorBox(a, y, t, fs) {
  return group({ class: 'mm-actor' }, [
    rect(a.boxX, y, a.w, a.h, { rx: 3, fill: t.actorFill, stroke: t.actorStroke, 'stroke-width': 1 }),
    textLines(a.x, y + a.h / 2, [a.label], fs, { fill: t.actorText, 'font-weight': 'bold' }),
  ]);
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

  if (m.self) {
    const loopW = 40;
    const y0 = m.y;
    const y1 = m.y + 26;
    parts.push(path(`M${num(m.x1)},${num(y0)} h${loopW} v${y1 - y0} h${-loopW}`, lineProps));
    parts.push(arrowHead({ x: m.x1 + 6, y: y1 }, { x: m.x1 + loopW, y: y1 }, m.head, stroke));
    parts.push(h('text', { x: num(m.x1 + loopW + 6), y: num((y0 + y1) / 2), 'font-size': fs, class: 'mm-message-label', fill: t.edgeLabelText }, m.label));
  }
  else {
    parts.push(line(m.x1, m.y, m.x2, m.y, lineProps));
    parts.push(arrowHead({ x: m.x2, y: m.y }, { x: m.x1, y: m.y }, m.head, stroke));
    const midX = (m.x1 + m.x2) / 2;
    parts.push(h('text', {
      x: num(midX), y: num(m.y - 6), 'font-size': fs, 'text-anchor': 'middle',
      class: 'mm-message-label', fill: t.edgeLabelText,
    }, m.label));
  }
  return group({ class: 'mm-message', key: 'msg-' + i }, parts);
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
  return h('polygon', {
    points: `${num(tip.x)},${num(tip.y)} ${num(tip.x - dir * size)},${num(tip.y - 4)} ${num(tip.x - dir * size)},${num(tip.y + 4)}`,
    class: 'mm-arrowhead', fill: color, stroke: color,
  });
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
    h('text', { x: num(b.x + 6), y: num(b.y + 14), 'font-size': fs - 1, 'font-weight': 'bold', class: 'mm-block-label', fill: t.nodeText }, label),
  ];
  for (const d of b.dividers) {
    parts.push(line(b.x, d.y, b.x + b.w, d.y, { stroke: t.actorStroke, 'stroke-width': 1, 'stroke-dasharray': '2 2' }));
    if (d.label) parts.push(h('text', { x: num(b.x + b.w / 2), y: num(d.y - 4), 'font-size': fs - 1, 'text-anchor': 'middle', class: 'mm-block-divider-label', fill: t.nodeText }, '[' + d.label + ']'));
  }
  return group({ class: 'mm-block-group', key: 'blk-' + i }, parts);
}
