//@ts-check
/**
 * @file Sequence layout: actor lifeline x-positions, message y-advance,
 * activation bars, note boxes and nested block frames
 * (loop/alt/opt/par). Pure and deterministic; emits a host-free
 * `PositionedDiagram`. Geometry is an approximation over the headless
 * text metrics (no DOM) — pixel parity is a non-goal.
 */

import { textWidth } from '@jarenjs/view/helpers';
import { coord as round } from '../utils.js';

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

/**
 * @param {any} ast sequence AST
 * @returns {any} PositionedDiagram
 */
export function layoutSequence(ast) {
  const actors = ast.participants.map((p) => ({
    id: p.id,
    label: p.label,
    kind: p.kind,
    w: Math.max(ACTOR_MIN_W, textWidth(p.label, FONT_SIZE, 700) + 2 * ACTOR_PAD),
  }));
  /** @type {Map<string, any>} */
  const byId = new Map();

  // Actor centers, left to right.
  let cursor = MARGIN;
  for (let i = 0; i < actors.length; i++) {
    const a = actors[i];
    a.x = cursor + a.w / 2;
    a.boxX = cursor;
    a.boxY = TOP;
    a.h = ACTOR_H;
    byId.set(a.id, a);
    cursor += a.w + ACTOR_GAP;
  }
  const width = Math.max(cursor - ACTOR_GAP + MARGIN, ACTOR_MIN_W + 2 * MARGIN);

  const centerOf = (id) => (byId.get(id)?.x ?? MARGIN);

  const messages = [];
  const notes = [];
  const activations = [];
  const blocks = [];
  /** @type {Map<string, number[]>} activation start-y stack per actor */
  const actStacks = new Map();

  const state = { y: TOP + ACTOR_H + MSG_GAP };

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
        if (stmt.activation === 'activate') activate(stmt.to);
        if (stmt.from === stmt.to) {
          messages.push({ x1, y: state.y, x2, label: stmt.text, line: stmt.line, head: stmt.head, self: true });
          state.y += SELF_GAP;
        }
        else {
          messages.push({ x1, y: state.y, x2, label: stmt.text, line: stmt.line, head: stmt.head, self: false });
          state.y += MSG_GAP;
        }
        if (stmt.activation === 'deactivate') deactivate(stmt.from);
      }
      else if (stmt.kind === 'note') {
        const xs = stmt.actors.map(centerOf);
        const minX = Math.min(...xs);
        const maxX = Math.max(...xs);
        const textW = textWidth(stmt.text, FONT_SIZE) + 2 * NOTE_PAD;
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
        notes.push({ x, y: state.y, w, h: NOTE_H, text: stmt.text });
        state.y += NOTE_H + 10;
      }
      else if (stmt.kind === 'activate') activate(stmt.actor);
      else if (stmt.kind === 'deactivate') deactivate(stmt.actor);
      else if (stmt.kind === 'block') {
        const startY = state.y;
        state.y += BLOCK_LABEL_H + BLOCK_PAD;
        const dividers = [];
        for (let bi = 0; bi < stmt.branches.length; bi++) {
          if (bi > 0) {
            dividers.push({ y: state.y, label: stmt.branches[bi].label });
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
          label: stmt.branches[0].label,
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
  const height = lineBottom + ACTOR_H + MARGIN;

  return {
    type: 'sequence',
    width: round(width),
    height: round(height),
    fontSize: FONT_SIZE,
    lineTop: TOP + ACTOR_H,
    lineBottom: round(lineBottom),
    actors: actors.map((a) => ({
      id: a.id, label: a.label, kind: a.kind,
      x: round(a.x), boxX: round(a.boxX), boxY: a.boxY, w: round(a.w), h: a.h,
      bottomY: round(lineBottom),
    })),
    messages: messages.map((m) => ({ ...m, x1: round(m.x1), x2: round(m.x2), y: round(m.y) })),
    notes: notes.map((n) => ({ ...n, x: round(n.x), y: round(n.y), w: round(n.w) })),
    activations: activations.map((a) => ({ x: round(a.x), y: round(a.y), w: a.w, h: round(a.h) })),
    blocks: blocks.map((b) => ({ ...b, x: round(b.x), y: round(b.y), w: round(b.w), h: round(b.h), dividers: b.dividers.map((d) => ({ y: round(d.y), label: d.label })) })),
  };
}
