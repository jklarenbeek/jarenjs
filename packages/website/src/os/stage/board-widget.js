//@ts-check
/**
 * The board's wall: cards drawn as cut-out paper in the OS's line —
 * a thick ink outline over a hard offset shadow — and the lines between
 * them drawn as hand-thrown squiggles (a `blocks` dependency solid with
 * an arrow, a plain relation dashed). A card is dragged by its body and
 * connected by dragging from the dot on its edge onto another card; a
 * tap selects it, a tap on a todo's box ticks it.
 *
 * The widget only reports what the hand did — a move, a link, a tick —
 * as bindings the view gave it; the contract decides, and the board that
 * comes back (cards pushed clear of each other, a cycle refused) is what
 * it draws next. The same cards are listed with buttons beside the wall,
 * so nothing here is the only way to do anything.
 */

import { createDomRenderer } from '@jarenjs/view';

/**
 * @typedef {{ id: string, kind: 'note' | 'todo', text: string, done: boolean, x: number, y: number, fill: string, blocked: boolean, todo: boolean, label: string }} WallCard
 * @typedef {{ id: string, from: string, to: string, kind: 'relates' | 'blocks', x1: number, y1: number, x2: number, y2: number }} WallLink
 * @typedef {{ cards: WallCard[], links: WallLink[], width: number, height: number, selected: string | null, theme: string, label?: string }} BoardProps
 */

/** A card's size on the wall, and where its link dot sits. */
export const CARD = Object.freeze({ w: 200, h: 116, port: 14 });

/** Pixels a press may travel and still be a tap. */
const SLOP = 5;

/** The smallest stretch of wall the frame shows, and the room it leaves around the cards. */
const FRAME = Object.freeze({ w: 720, h: 450, margin: 120 });

/**
 * The part of the wall the widget shows: the cards with room around them,
 * never less than `FRAME` (one card is not drawn poster-sized) and never
 * past the wall's edges. It follows the cards the contract placed, not a
 * card in a hand, so the wall holds still while one is dragged.
 * @param {BoardProps} props @returns {{ x: number, y: number, w: number, h: number }}
 */
export function wallFrame(props) {
  if (props.cards.length === 0) return { x: 0, y: 0, w: Math.min(props.width, FRAME.w), h: Math.min(props.height, FRAME.h) };
  const x0 = Math.min(...props.cards.map((c) => c.x)) - FRAME.margin;
  const y0 = Math.min(...props.cards.map((c) => c.y)) - FRAME.margin;
  const x1 = Math.max(...props.cards.map((c) => c.x + CARD.w)) + FRAME.margin;
  const y1 = Math.max(...props.cards.map((c) => c.y + CARD.h)) + FRAME.margin;
  const w = Math.min(props.width, Math.max(FRAME.w, x1 - x0));
  const h = Math.min(props.height, Math.max(FRAME.h, y1 - y0));
  // centred on the cards, slid back inside the wall where it would run off it
  const x = Math.max(0, Math.min(props.width - w, (x0 + x1) / 2 - w / 2));
  const y = Math.max(0, Math.min(props.height - h, (y0 + y1) / 2 - h / 2));
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

/**
 * Wrap words into at most `lines` lines of about `width` characters.
 * @param {string} text @param {number} width @param {number} lines @returns {string[]}
 */
export function wrapText(text, width, lines) {
  /** @type {string[]} */
  const out = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if ((line + ' ' + word).trim().length > width && line.length > 0) {
      out.push(line);
      line = word;
      if (out.length === lines) break;
    }
    else line = (line + ' ' + word).trim();
  }
  if (out.length < lines && line.length > 0) out.push(line);
  if (out.length === lines && text.length > out.join(' ').length) out[lines - 1] = `${out[lines - 1].slice(0, Math.max(0, width - 1))}…`;
  return out;
}

/**
 * A hand-thrown line between two points: a quadratic curve whose bend
 * depends on the link's id, so each line keeps its own wobble.
 * @param {WallLink} l @returns {string}
 */
export function squiggle(l) {
  const mx = (l.x1 + l.x2) / 2;
  const my = (l.y1 + l.y2) / 2;
  const dx = l.x2 - l.x1;
  const dy = l.y2 - l.y1;
  let seed = 0;
  for (const ch of l.id) seed = (seed * 31 + ch.charCodeAt(0)) % 997;
  const bend = ((seed % 7) - 3) * 0.06;
  return `M${l.x1} ${l.y1}Q${Math.round(mx - dy * bend)} ${Math.round(my + dx * bend)} ${l.x2} ${l.y2}`;
}

/**
 * The wall as one SVG vnode tree.
 * @param {BoardProps} props @param {{ drag: { id: string, x: number, y: number } | null, rubber: { x1: number, y1: number, x2: number, y2: number } | null }} local
 */
export function wallVnode(props, local) {
  const at = (/** @type {WallCard} */ c) => (local.drag && local.drag.id === c.id ? { x: local.drag.x, y: local.drag.y } : { x: c.x, y: c.y });
  const centre = new Map(props.cards.map((c) => [c.id, at(c)]));
  const frame = wallFrame(props);
  return ['svg', {
    class: 'os-wall', viewBox: `${frame.x} ${frame.y} ${frame.w} ${frame.h}`, role: 'img', 'aria-label': props.label ?? 'Board',
    preserveAspectRatio: 'xMidYMid meet',
  },
  ['defs', {}, ['marker', { id: 'os-wall-arrow', viewBox: '0 0 10 10', refX: '8', refY: '5', markerWidth: '6', markerHeight: '6', orient: 'auto-start-reverse' },
    ['path', { d: 'M0 0L10 5L0 10z', class: 'os-wall-arrowhead' }]]],
  ...props.links.map((l) => {
    // a card being dragged pulls its lines along with it
    const a = centre.get(l.from);
    const b = centre.get(l.to);
    const moved = { ...l, ...(a ? { x1: a.x + CARD.w / 2, y1: a.y + CARD.h / 2 } : {}), ...(b ? { x2: b.x + CARD.w / 2, y2: b.y + CARD.h / 2 } : {}) };
    return ['path', {
      key: l.id, class: `os-wall-link is-${l.kind}`, d: squiggle(moved),
      ...(l.kind === 'blocks' ? { 'marker-end': 'url(#os-wall-arrow)' } : {}),
    }];
  }),
  ...props.cards.map((c) => {
    const { x, y } = at(c);
    const lines = wrapText(c.text, 21, c.label ? 3 : 4);
    return ['g', {
      key: c.id, class: `os-wall-card${c.id === props.selected ? ' is-selected' : ''}${c.done ? ' is-done' : ''}${c.blocked ? ' is-blocked' : ''}`,
      transform: `translate(${Math.round(x)} ${Math.round(y)})`, 'data-card': c.id,
    },
    ['rect', { class: 'os-wall-shadow', x: 7, y: 7, width: CARD.w, height: CARD.h, rx: 10 }],
    // paper, a wash of the card's ink, and a band of it across the top: words stay readable on any ink
    ['rect', { class: 'os-wall-paper', x: 0, y: 0, width: CARD.w, height: CARD.h, rx: 10 }],
    ['rect', { class: 'os-wall-tint', x: 0, y: 0, width: CARD.w, height: CARD.h, rx: 10, fill: c.fill }],
    ['rect', { class: 'os-wall-band', x: 0, y: 0, width: CARD.w, height: 9, rx: 4, fill: c.fill }],
    ['rect', { class: 'os-wall-edge', x: 0, y: 0, width: CARD.w, height: CARD.h, rx: 10 }],
    ...(c.todo ? [['rect', { class: 'os-wall-box', x: 12, y: 12, width: 22, height: 22, rx: 4 }],
      ...(c.done ? [['path', { class: 'os-wall-tick', d: 'M16 23l5 5 9-11' }]] : [])] : []),
    ...lines.map((line, i) => ['text', { class: 'os-wall-text', x: c.todo ? 44 : 14, y: 30 + i * 22 }, line]),
    ...(c.label ? [['text', { class: 'os-wall-ref', x: 14, y: CARD.h - 14 }, `↗ ${c.label.slice(0, 22)}`]] : []),
    // under the words, where no title runs into it
    ...(c.blocked ? [['text', { class: 'os-wall-wait', x: CARD.w - 14, y: CARD.h - 12, 'text-anchor': 'end' }, 'waits']] : []),
    ['circle', { class: 'os-wall-port', cx: CARD.w, cy: CARD.h / 2, r: CARD.port / 2 + 2 }]];
  }),
  ...(local.rubber ? [['path', { class: 'os-wall-link is-rubber', d: `M${local.rubber.x1} ${local.rubber.y1}L${local.rubber.x2} ${local.rubber.y2}` }]] : [])];
}

/**
 * What lies under a wall point: a card's link dot, a todo's box, a card, or nothing.
 * @param {readonly WallCard[]} cards @param {number} x @param {number} y
 * @returns {{ card: WallCard, part: 'port' | 'box' | 'body' } | null}
 */
export function hitWall(cards, x, y) {
  for (let i = cards.length - 1; i >= 0; i--) {
    const c = cards[i];
    if (Math.hypot(x - (c.x + CARD.w), y - (c.y + CARD.h / 2)) <= CARD.port) return { card: c, part: 'port' };
    if (x >= c.x && x <= c.x + CARD.w && y >= c.y && y <= c.y + CARD.h) {
      return { card: c, part: c.todo && x <= c.x + 40 && y <= c.y + 40 ? 'box' : 'body' };
    }
  }
  return null;
}

/** The widget definition. */
export const boardWidget = {
  /**
   * @param {HTMLElement} host @param {BoardProps} props
   * @param {(binding: any, event?: any) => void} emit @param {{ document?: Document }} [context]
   */
  mount(host, props, emit, context) {
    const doc = context?.document ?? host.ownerDocument;
    const render = createDomRenderer(host, { document: doc });
    /** @type {any} */
    const handle = { host, props, emit, render, local: { drag: null, rubber: null }, press: null };
    /** Pointer position in wall units, through the frame the wall shows. @param {{ clientX: number, clientY: number }} e */
    const toWall = (e) => {
      const frame = wallFrame(handle.props);
      const r = host.getBoundingClientRect?.() ?? { left: 0, top: 0, width: frame.w, height: frame.h };
      const scale = Math.max(frame.w / Math.max(1, r.width), frame.h / Math.max(1, r.height));
      const offX = (r.width * scale - frame.w) / 2;
      const offY = (r.height * scale - frame.h) / 2;
      return { x: frame.x + (e.clientX - r.left) * scale - offX, y: frame.y + (e.clientY - r.top) * scale - offY };
    };
    const down = (/** @type {any} */ e) => {
      const p = toWall(e);
      const hit = hitWall(handle.props.cards, p.x, p.y);
      if (!hit) { emit({ action: 'board/select', with: null }, e); return; }
      handle.press = { ...hit, start: p, dx: p.x - hit.card.x, dy: p.y - hit.card.y, moved: false };
      host.setPointerCapture?.(e.pointerId);
    };
    const move = (/** @type {any} */ e) => {
      const press = handle.press;
      if (!press) return;
      const p = toWall(e);
      if (Math.hypot(p.x - press.start.x, p.y - press.start.y) > SLOP) press.moved = true;
      if (!press.moved) return;
      if (press.part === 'port') handle.local.rubber = { x1: press.card.x + CARD.w, y1: press.card.y + CARD.h / 2, x2: p.x, y2: p.y };
      else handle.local.drag = { id: press.card.id, x: p.x - press.dx, y: p.y - press.dy };
      draw(handle);
    };
    const up = (/** @type {any} */ e) => {
      const press = handle.press;
      handle.press = null;
      if (!press) return;
      const p = toWall(e);
      if (press.part === 'port' && press.moved) {
        const target = hitWall(handle.props.cards, p.x, p.y);
        if (target && target.card.id !== press.card.id) {
          emit({ action: 'board/link-start', with: press.card.id }, e);
          emit({ action: 'board/link-to', with: { id: target.card.id, todo: press.card.todo && target.card.todo } }, e);
        }
      }
      else if (press.moved) {
        emit({ action: 'board/move', with: { id: press.card.id, x: Math.round(p.x - press.dx), y: Math.round(p.y - press.dy) } }, e);
      }
      else if (press.part === 'box') emit({ action: 'board/tick', with: { id: press.card.id, done: press.card.done } }, e);
      else emit({ action: 'board/select', with: press.card.id }, e);
      handle.local = { drag: null, rubber: null };
      draw(handle);
    };
    host.addEventListener('pointerdown', down);
    host.addEventListener('pointermove', move);
    host.addEventListener('pointerup', up);
    handle.off = () => {
      host.removeEventListener('pointerdown', down);
      host.removeEventListener('pointermove', move);
      host.removeEventListener('pointerup', up);
    };
    draw(handle);
    return handle;
  },
  /** @param {any} handle @param {BoardProps} props */
  update(handle, props) {
    handle.props = props;
    draw(handle);
  },
  /** @param {any} handle */
  unmount(handle) {
    handle.off();
    handle.render.destroy();
  },
  /** @param {BoardProps} props */
  ssr(props) {
    return wallVnode(props, { drag: null, rubber: null });
  },
};

/** @param {any} handle */
function draw(handle) {
  handle.render(wallVnode(handle.props, handle.local));
}
