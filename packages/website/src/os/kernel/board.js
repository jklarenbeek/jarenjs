//@ts-check
/**
 * The board: notes and todos pinned to one wall and connected by lines —
 * to each other, to a mail thread, to a section of the documentation, to
 * an idea the crew is building. A `blocks` connection between two todos
 * is a dependency, and the dependencies form a DAG: a link that would
 * close a cycle is refused, so "what can I do next" always has an answer.
 *
 * Cards never pile up on each other: a card dropped onto another is
 * pushed clear by the separating-axis test (`collide.js`), the same
 * collision detection the games use, run in the board's plane.
 */

import { satPolygons } from '../engine/collide.js';

/**
 * @typedef {{ kind: 'mail' | 'doc' | 'idea' | 'game', id: string, label: string }} Ref
 * @typedef {{ id: string, kind: 'note' | 'todo', text: string, done: boolean, color: number, x: number, y: number, ref: Ref | null, by: string }} Card
 * @typedef {{ id: string, from: string, to: string, kind: 'relates' | 'blocks' }} Link
 * @typedef {{ cards: Card[], links: Link[], seq: number }} Board
 */

/** The wall's size, a card's size, and how much the board holds. */
export const BOARD_LIMITS = Object.freeze({ width: 1600, height: 1000, cardW: 200, cardH: 116, cards: 80, links: 160, text: 280 });

/** An empty wall. @returns {Board} */
export function emptyBoard() {
  return { cards: [], links: [], seq: 0 };
}

/** @param {number} v @param {number} lo @param {number} hi */
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * Pin a card. Without a place it goes in the next free slot of a loose grid.
 * @param {Board} board
 * @param {{ kind: 'note' | 'todo', text: string, color?: number, x?: number, y?: number, ref?: Ref | null, by: string }} input
 * @returns {{ board: Board, id: string } | { error: 'full' }}
 */
export function addCard(board, input) {
  if (board.cards.length >= BOARD_LIMITS.cards) return { error: 'full' };
  const seq = board.seq + 1;
  const n = board.cards.length;
  /** @type {Card} */
  const card = {
    id: `c${seq}`,
    kind: input.kind,
    text: input.text.trim().slice(0, BOARD_LIMITS.text),
    done: false,
    color: Number.isInteger(input.color) ? clamp(/** @type {number} */ (input.color), 0, 5) : n % 5 + 1,
    x: clamp(input.x ?? 40 + (n % 6) * 250, 0, BOARD_LIMITS.width - BOARD_LIMITS.cardW),
    y: clamp(input.y ?? 40 + Math.floor(n / 6) * 160, 0, BOARD_LIMITS.height - BOARD_LIMITS.cardH),
    ref: input.ref ?? null,
    by: input.by,
  };
  const next = { ...board, cards: [...board.cards, card], seq };
  return { board: settleCard(next, card.id), id: card.id };
}

/**
 * Change a card: its words, its tick, its colour or its place.
 * @param {Board} board
 * @param {{ id: string, text?: string, done?: boolean, color?: number, x?: number, y?: number }} input
 * @returns {{ board: Board } | { error: 'not-found' }}
 */
export function editCard(board, input) {
  const card = board.cards.find((c) => c.id === input.id);
  if (!card) return { error: 'not-found' };
  /** @type {Card} */
  const next = {
    ...card,
    text: typeof input.text === 'string' && input.text.trim().length > 0 ? input.text.trim().slice(0, BOARD_LIMITS.text) : card.text,
    done: typeof input.done === 'boolean' ? input.done : card.done,
    color: Number.isInteger(input.color) ? clamp(/** @type {number} */ (input.color), 0, 5) : card.color,
    x: Number.isFinite(input.x) ? clamp(/** @type {number} */ (input.x), 0, BOARD_LIMITS.width - BOARD_LIMITS.cardW) : card.x,
    y: Number.isFinite(input.y) ? clamp(/** @type {number} */ (input.y), 0, BOARD_LIMITS.height - BOARD_LIMITS.cardH) : card.y,
  };
  const moved = next.x !== card.x || next.y !== card.y;
  const board2 = { ...board, cards: board.cards.map((c) => (c.id === card.id ? next : c)) };
  return { board: moved ? settleCard(board2, card.id) : board2 };
}

/**
 * Connect two cards. A `blocks` link from A to B means A must be done
 * before B; one that would close a cycle of blocks is refused.
 * @param {Board} board @param {{ from: string, to: string, kind?: 'relates' | 'blocks' }} input
 * @returns {{ board: Board, id: string } | { error: 'not-found' | 'self' | 'duplicate' | 'cycle' | 'full' }}
 */
export function linkCards(board, input) {
  const kind = input.kind ?? 'relates';
  if (input.from === input.to) return { error: 'self' };
  if (!board.cards.some((c) => c.id === input.from) || !board.cards.some((c) => c.id === input.to)) return { error: 'not-found' };
  if (board.links.some((l) => (l.from === input.from && l.to === input.to) || (l.from === input.to && l.to === input.from))) return { error: 'duplicate' };
  if (board.links.length >= BOARD_LIMITS.links) return { error: 'full' };
  if (kind === 'blocks' && reaches(board, input.to, input.from)) return { error: 'cycle' };
  const seq = board.seq + 1;
  const link = { id: `l${seq}`, from: input.from, to: input.to, kind };
  return { board: { ...board, links: [...board.links, link], seq }, id: link.id };
}

/** Whether `goal` is reachable from `start` along blocks links. @param {Board} board @param {string} start @param {string} goal */
function reaches(board, start, goal) {
  const seen = new Set();
  const stack = [start];
  while (stack.length > 0) {
    const at = /** @type {string} */ (stack.pop());
    if (at === goal) return true;
    if (seen.has(at)) continue;
    seen.add(at);
    for (const l of board.links) if (l.kind === 'blocks' && l.from === at) stack.push(l.to);
  }
  return false;
}

/**
 * Take a card (and its links) or a single link off the wall.
 * @param {Board} board @param {string} id @returns {{ board: Board } | { error: 'not-found' }}
 */
export function removeItem(board, id) {
  if (board.cards.some((c) => c.id === id)) {
    return { board: { ...board, cards: board.cards.filter((c) => c.id !== id), links: board.links.filter((l) => l.from !== id && l.to !== id) } };
  }
  if (board.links.some((l) => l.id === id)) return { board: { ...board, links: board.links.filter((l) => l.id !== id) } };
  return { error: 'not-found' };
}

/**
 * The todos that wait on an unfinished blocker.
 * @param {Board} board @returns {Set<string>}
 */
export function blockedCards(board) {
  const done = new Map(board.cards.map((c) => [c.id, c.done]));
  const out = new Set();
  for (const l of board.links) if (l.kind === 'blocks' && done.get(l.from) === false) out.add(l.to);
  return out;
}

/** A card's outline on the wall, as a polygon. @param {{ x: number, y: number }} c */
const outline = (c) => [c.x, c.y, c.x + BOARD_LIMITS.cardW, c.y, c.x + BOARD_LIMITS.cardW, c.y + BOARD_LIMITS.cardH, c.x, c.y + BOARD_LIMITS.cardH];

/**
 * Push card `id` clear of every card it overlaps, along the separating
 * axis of least overlap, a few rounds at most, staying on the wall.
 * @param {Board} board @param {string} id @returns {Board}
 */
export function settleCard(board, id) {
  const card = board.cards.find((c) => c.id === id);
  if (!card) return board;
  let { x, y } = card;
  for (let round = 0; round < 8; round++) {
    let moved = false;
    for (const other of board.cards) {
      if (other.id === id) continue;
      const hit = satPolygons(outline({ x, y }), outline(other));
      if (!hit.overlap) continue;
      x = clamp(x + hit.axis[0] * (hit.depth + 8), 0, BOARD_LIMITS.width - BOARD_LIMITS.cardW);
      y = clamp(y + hit.axis[1] * (hit.depth + 8), 0, BOARD_LIMITS.height - BOARD_LIMITS.cardH);
      moved = true;
    }
    if (!moved) break;
  }
  if (x === card.x && y === card.y) return board;
  return { ...board, cards: board.cards.map((c) => (c.id === id ? { ...c, x, y } : c)) };
}

/**
 * Whether a value is a wall this OS can restore.
 * @param {any} value @returns {value is Board}
 */
export function isBoard(value) {
  return Boolean(value) && Number.isInteger(value.seq) && Array.isArray(value.cards) && Array.isArray(value.links)
    && value.cards.length <= BOARD_LIMITS.cards && value.links.length <= BOARD_LIMITS.links
    && value.cards.every((/** @type {any} */ c) => c && typeof c.id === 'string' && (c.kind === 'note' || c.kind === 'todo')
      && typeof c.text === 'string' && typeof c.done === 'boolean' && Number.isInteger(c.color) && Number.isFinite(c.x) && Number.isFinite(c.y))
    && value.links.every((/** @type {any} */ l) => l && typeof l.id === 'string' && typeof l.from === 'string' && typeof l.to === 'string'
      && (l.kind === 'relates' || l.kind === 'blocks'));
}
