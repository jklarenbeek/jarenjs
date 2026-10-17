//@ts-check
/**
 * @file Sequence layout: actor lifeline x-positions, message y-advance,
 * activation bars, note boxes and nested block frames
 * (loop/alt/opt/par). Pure and deterministic; emits a host-free
 * `PositionedDiagram`. Geometry is an approximation over the headless
 * text metrics (no DOM) — pixel parity is a non-goal.
 *
 * An actor's, a message's and a note's text is read once here, as every
 * type's text is read (`label-text.js`: broken at `<br>`, its entity codes
 * decoded), and the positioned item carries its `lines`: the renderer draws
 * exactly the lines this pass measured.
 */

import { textWidth } from '@jarenjs/view/helpers';
import { coord as round } from '../utils.js';
import { readTextLines, decodeEntityCodes } from '../label-text.js';

const FONT_SIZE = 14;
const ACTOR_H = 34;
const ACTOR_MIN_W = 80;
const ACTOR_PAD = 20;
const ACTOR_GAP = 60;
const TOP = 12;
const MARGIN = 12;
const MSG_GAP = 40;
const SELF_GAP = 52;
const NOTE_H = 34;
const NOTE_PAD = 10;
const ACT_W = 10;
const BLOCK_LABEL_H = 24;
const BLOCK_PAD = 12;
/** The advance from one line of text to the next (`textLines`' own). */
const LINE_H = FONT_SIZE * 1.2;
/** A self-message's loop width; its text starts `SELF_TEXT_GAP` past it. */
export const SELF_LOOP_W = 40;
const SELF_TEXT_GAP = 6;
/** The room a message's or a note's text keeps from a lifeline. */
const TEXT_ROOM = 10;
/** A note beside a lifeline sits this far from it. */
const NOTE_GAP = 10;

/**
 * The distance each pair of actors' lifelines needs, so that no message's
 * text runs past the lifelines it spans and no self-message's or side
 * note's text runs into the next lifeline, as Mermaid widens an actor gap to
 * its messages. Keyed `left,right` by actor index; the leftmost actor's
 * left-of notes are keyed `-1,0`.
 * @param {any[]} statements
 * @param {Map<string, number>} index - actor id -> position
 * @param {Map<string, number>} [needs]
 * @returns {Map<string, number>}
 */
function lifelineNeeds(statements, index, needs = new Map()) {
  const need = (/** @type {number} */ left, /** @type {number} */ right, /** @type {number} */ distance) => {
    const key = `${left},${right}`;
    needs.set(key, Math.max(needs.get(key) ?? 0, distance));
  };
  for (const stmt of statements) {
    if (stmt.kind === 'message') {
      const from = index.get(stmt.from) ?? 0;
      const to = index.get(stmt.to) ?? 0;
      const textW = widest(readTextLines(stmt.text));
      if (from === to) need(from, from + 1, SELF_LOOP_W + SELF_TEXT_GAP + textW + TEXT_ROOM);
      else need(Math.min(from, to), Math.max(from, to), textW + 2 * TEXT_ROOM);
    }
    else if (stmt.kind === 'note' && stmt.placement !== 'over') {
      const at = stmt.actors.map((/** @type {string} */ id) => index.get(id) ?? 0);
      const textW = widest(readTextLines(stmt.text)) + 2 * NOTE_PAD;
      if (stmt.placement === 'right of') need(Math.max(...at), Math.max(...at) + 1, NOTE_GAP + textW + TEXT_ROOM);
      else need(Math.min(...at) - 1, Math.min(...at), NOTE_GAP + textW + TEXT_ROOM);
    }
    else if (stmt.kind === 'block') {
      for (const branch of stmt.branches) lifelineNeeds(branch.statements, index, needs);
    }
  }
  return needs;
}

/**
 * The widest of some lines of text.
 * @param {string[]} lines @param {number} [weight]
 * @returns {number}
 */
function widest(lines, weight) {
  let w = 0;
  for (const line of lines) w = Math.max(w, textWidth(line, FONT_SIZE, weight));
  return w;
}

/**
 * @param {any} ast sequence AST
 * @returns {any} PositionedDiagram
 */
export function layoutSequence(ast) {
  const actors = ast.participants.map((p) => {
    const lines = readTextLines(p.label);
    return {
      id: p.id,
      label: p.label,
      lines,
      kind: p.kind,
      w: Math.max(ACTOR_MIN_W, widest(lines, 700) + 2 * ACTOR_PAD),
    };
  });
  // every actor box is as tall as the one with the most lines
  const actorH = ACTOR_H + (Math.max(1, ...actors.map((a) => a.lines.length)) - 1) * LINE_H;
  /** @type {Map<string, any>} */
  const byId = new Map();

  // Actor centers, left to right: each one gap past the box before it, or
  // further where a message or a note between it and an earlier actor needs
  // the room (the leftmost actor's left-of notes push it right of the margin)
  const needs = lifelineNeeds(ast.statements, new Map(actors.map((a, i) => [a.id, i])));
  let right = 0;
  for (let i = 0; i < actors.length; i++) {
    const a = actors[i];
    let x = i === 0
      ? Math.max(MARGIN + a.w / 2, MARGIN + (needs.get('-1,0') ?? 0))
      : actors[i - 1].x + actors[i - 1].w / 2 + ACTOR_GAP + a.w / 2;
    for (let k = 0; k < i; k++) x = Math.max(x, actors[k].x + (needs.get(`${k},${i}`) ?? 0));
    a.x = x;
    a.boxX = x - a.w / 2;
    a.boxY = TOP;
    a.h = actorH;
    byId.set(a.id, a);
    right = Math.max(right, x + a.w / 2);
  }
  // the last actor's self-messages and right-of notes reach past its box
  const last = actors.length - 1;
  if (last >= 0) right = Math.max(right, actors[last].x + (needs.get(`${last},${last + 1}`) ?? 0));
  const width = Math.max(right + MARGIN, ACTOR_MIN_W + 2 * MARGIN);

  const centerOf = (id) => (byId.get(id)?.x ?? MARGIN);

  const messages = [];
  const notes = [];
  const activations = [];
  const blocks = [];
  /** @type {Map<string, number[]>} activation start-y stack per actor */
  const actStacks = new Map();

  const state = { y: TOP + actorH + MSG_GAP };

  const activate = (id) => {
    if (!actStacks.has(id)) actStacks.set(id, []);
    actStacks.get(id).push(state.y);
  };
  const deactivate = (id) => {
    const stack = actStacks.get(id);
    if (stack && stack.length) {
      const startY = stack.pop();
      const a = byId.get(id);
      if (a) activations.push({ x: a.x - ACT_W / 2, y: startY, w: ACT_W, h: Math.max(state.y - startY, MSG_GAP / 2) });
    }
  };

  /**
   * @param {any[]} statements
   */
  const walk = (statements) => {
    for (const stmt of statements) {
      if (stmt.kind === 'message') {
        const x1 = centerOf(stmt.from);
        const x2 = centerOf(stmt.to);
        const lines = readTextLines(stmt.text);
        // the lines past the first stack above a message's line, and half
        // above, half below a self-message's loop, which they sit beside
        const extra = (lines.length - 1) * LINE_H;
        const self = stmt.from === stmt.to;
        state.y += self ? extra / 2 : extra;
        if (stmt.activation === 'activate') activate(stmt.to);
        messages.push({ x1, y: state.y, x2, label: stmt.text, lines, line: stmt.line, head: stmt.head, self, from: stmt.from, to: stmt.to });
        state.y += self ? SELF_GAP + extra / 2 : MSG_GAP;
        if (stmt.activation === 'deactivate') deactivate(stmt.from);
      }
      else if (stmt.kind === 'note') {
        const xs = stmt.actors.map(centerOf);
        const minX = Math.min(...xs);
        const maxX = Math.max(...xs);
        const lines = readTextLines(stmt.text);
        const textW = widest(lines) + 2 * NOTE_PAD;
        const h = NOTE_H + (lines.length - 1) * LINE_H;
        let x, w;
        if (stmt.placement === 'over') {
          const span = maxX - minX;
          w = Math.max(textW, span + ACTOR_MIN_W);
          x = (minX + maxX) / 2 - w / 2;
        }
        else if (stmt.placement === 'left of') {
          w = textW; x = minX - w - 10;
        }
        else {
          w = textW; x = maxX + 10;
        }
        notes.push({ x, y: state.y, w, h, text: stmt.text, lines });
        state.y += h + 10;
      }
      else if (stmt.kind === 'activate') activate(stmt.actor);
      else if (stmt.kind === 'deactivate') deactivate(stmt.actor);
      else if (stmt.kind === 'block') {
        const startY = state.y;
        state.y += BLOCK_LABEL_H + BLOCK_PAD;
        const dividers = [];
        for (let bi = 0; bi < stmt.branches.length; bi++) {
          if (bi > 0) {
            dividers.push({ y: state.y, label: decodeEntityCodes(stmt.branches[bi].label) });
            state.y += BLOCK_LABEL_H;
          }
          walk(stmt.branches[bi].statements);
        }
        state.y += BLOCK_PAD;
        const bx = MARGIN + 4;
        blocks.push({
          x: bx,
          y: startY,
          w: width - 2 * bx,
          h: state.y - startY,
          label: decodeEntityCodes(stmt.branches[0].label),
          blockType: stmt.blockType,
          dividers,
        });
        state.y += MSG_GAP / 2;
      }
    }
  };

  walk(ast.statements);

  // Close any dangling activations at the bottom.
  for (const [id, stack] of actStacks) {
    while (stack.length) {
      const startY = stack.pop();
      const a = byId.get(id);
      if (a) activations.push({ x: a.x - ACT_W / 2, y: startY, w: ACT_W, h: Math.max(state.y - startY, MSG_GAP / 2) });
    }
  }

  const lineBottom = state.y + 6;
  const height = lineBottom + actorH + MARGIN;

  return {
    type: 'sequence',
    width: round(width),
    height: round(height),
    fontSize: FONT_SIZE,
    lineTop: TOP + actorH,
    lineBottom: round(lineBottom),
    actors: actors.map((a) => ({
      id: a.id, label: a.label, lines: a.lines, kind: a.kind,
      x: round(a.x), boxX: round(a.boxX), boxY: a.boxY, w: round(a.w), h: a.h,
      bottomY: round(lineBottom),
    })),
    messages: messages.map((m) => ({ ...m, x1: round(m.x1), x2: round(m.x2), y: round(m.y) })),
    notes: notes.map((n) => ({ ...n, x: round(n.x), y: round(n.y), w: round(n.w) })),
    activations: activations.map((a) => ({ x: round(a.x), y: round(a.y), w: a.w, h: round(a.h) })),
    blocks: blocks.map((b) => ({ ...b, x: round(b.x), y: round(b.y), w: round(b.w), h: round(b.h), dividers: b.dividers.map((d) => ({ y: round(d.y), label: d.label })) })),
  };
}
