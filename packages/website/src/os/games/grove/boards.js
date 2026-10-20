//@ts-check
/**
 * The places Monkey Grove is played on, as tile maps: the hub island
 * with its four world portals, and one chamber board per verb — a field
 * of stones for FETCH, a soil bed for ARRAY, a vine number line for
 * LINE, a stump and baskets for SHARE. Every chamber board also keeps an
 * altar and stone spots, so a follow-up stone hunt fits on any of them.
 *
 * A board is plain JSON: its rows (one character per tile) and the
 * markers read off them. A chamber's board is dealt from a seed — a
 * template mirrored, sprinkled with rocks and trees, shaded, its coast
 * nibbled — and each change is kept only if every tile the monkey could
 * reach before is still reachable, so no stone, basket or altar is ever
 * walled off. The same seed deals the same board, which is what lets
 * both players of a duel play the same chamber.
 *
 * Tile legend: `#` water · `.` floor · `,` shaded floor · `P` spawn ·
 * `s` stone spot · `A` altar · `M` Mimi · `r` rock · `t` tree · `o` soil ·
 * `V` vine plank · `m` stump · `B` basket · `N` banana pile · `1`–`4`
 * the tide, garden, stump and vines portals.
 */

import { createRng } from './rng.js';

/**
 * @typedef {import('./rng.js').Rng} Rng
 * @typedef {import('./math.js').World} World
 * @typedef {'hub' | 'fetch' | 'array' | 'line' | 'share'} BoardKind
 * @typedef {[number, number]} Cell - a tile, by column `i` and row `j`
 * @typedef {{ id: string, kind: BoardKind, world: World | null, w: number, d: number, rows: string[],
 *   spawn: Cell, mimi: Cell, altar: Cell | null, pile: Cell | null, stump: Cell | null,
 *   spots: Cell[], baskets: Cell[], portals: Record<World, Cell> | null,
 *   soil: { i0: number, j0: number, cols: number, rows: number } | null,
 *   vine: { i0: number, i1: number, j: number } | null,
 *   pad: { i: number, j: number, w: number, d: number } | null }} Board
 */

/** The characters the monkey can stand on. */
const WALKABLE = new Set(['.', ',', 'P', 's', 'o', 'V', '1', '2', '3', '4']);

/** How far from a wall (water, a rock) a walk may end inside its tile: a body's radius and a little. */
const EDGE = 0.34;

/** The portal characters, world by world. */
const PORTAL_CHARS = Object.freeze(/** @type {Record<string, World>} */ ({ 1: 'tide', 2: 'garden', 3: 'stump', 4: 'vines' }));

/** The chamber templates, by board kind (16 × 10, a ring of sea). */
const TEMPLATES = Object.freeze(/** @type {Record<Exclude<BoardKind, 'hub'>, string[][]>} */ ({
  fetch: [[
    '################',
    '#,..s.....t..s.#',
    '#.r.....s......#',
    '#.....A.....r..#',
    '#.s.......M..s.#',
    '#...t..........#',
    '#......P...s...#',
    '#.s.......r....#',
    '#..,....s....,.#',
    '################',
  ], [
    '################',
    '#..t...s....,..#',
    '#.s.......r..s.#',
    '#....,.........#',
    '#.t..s..A....t.#',
    '#.......M......#',
    '#.s..r.....s...#',
    '#.....P.....s..#',
    '#..s.....t.....#',
    '################',
  ]],
  array: [[
    '################',
    '#oooooooooo.s..#',
    '#oooooooooo..s.#',
    '#oooooooooo.A..#',
    '#oooooooooo...M#',
    '#oooooooooo.s..#',
    '#oooooooooo..s.#',
    '#oooooooooo.P..#',
    '#oooooooooo.s.s#',
    '################',
  ]],
  line: [[
    '################',
    '#,..s.....t..s.#',
    '#.s.....M......#',
    '#..............#',
    '#.VVVVVVVVVVVV.#',
    '#..............#',
    '#.s...P...A..s.#',
    '#....r.....s...#',
    '#..t..s......,.#',
    '################',
  ]],
  share: [[
    '################',
    '#,.B....B....B.#',
    '#.s...........s#',
    '#..........M...#',
    '#.s....m.....s.#',
    '#..............#',
    '#..B....B....B.#',
    '#.....P...A....#',
    '#.s..t.....s..,#',
    '################',
  ]],
}));

/** The hub island (16 × 12): four portals in the corners, Mimi and the banana pile in the middle. */
const HUB_ROWS = Object.freeze([
  '################',
  '#,.1........2..#',
  '#..............#',
  '#.t....,,....r.#',
  '#.....N.M......#',
  '#..............#',
  '#..r...P....t..#',
  '#..............#',
  '#.t..........,.#',
  '#..3........4..#',
  '#..............#',
  '################',
]);

/** Whether a tile character can be stood on. @param {string} ch */
export function isWalkable(ch) {
  return WALKABLE.has(ch);
}

/**
 * The character of a tile; water outside the board.
 * @param {Board} board @param {number} i @param {number} j
 */
export function charAt(board, i, j) {
  return board.rows[j]?.[i] ?? '#';
}

/**
 * The tile under a world point.
 * @param {Board} board @param {number} x @param {number} z @returns {Cell}
 */
export function tileAt(board, x, z) {
  return [Math.floor(x + board.w / 2), Math.floor(z + board.d / 2)];
}

/**
 * The world point at a tile's centre.
 * @param {Board} board @param {number} i @param {number} j @returns {[number, number]}
 */
export function centerOf(board, i, j) {
  return [i - board.w / 2 + 0.5, j - board.d / 2 + 0.5];
}

/**
 * The tiles reachable from the spawn by stepping between walkable
 * neighbours, as `j * w + i` indices.
 * @param {string[][]} grid @returns {Set<number>}
 */
export function reachable(grid) {
  const w = grid[0].length;
  const start = grid.flat().indexOf('P');
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length > 0) {
    const at = /** @type {number} */ (queue.pop());
    const i = at % w;
    const j = (at - i) / w;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ni = i + di;
      const nj = j + dj;
      const next = nj * w + ni;
      if (!seen.has(next) && WALKABLE.has(grid[nj]?.[ni] ?? '#')) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

/**
 * A template varied by a seeded stream: mirrored, sprinkled with rocks
 * and trees in the open field, shaded, and with a few bites taken out
 * of its coast — each change kept only when it walls nothing off.
 * @param {readonly string[]} template @param {Rng} rng @returns {string[]}
 */
export function varyLayout(template, rng) {
  let grid = template.map((row) => [...row]);
  if (rng.chance(0.5)) grid = grid.map((row) => row.reverse());
  if (rng.chance(0.5)) grid = grid.reverse();
  const d = grid.length;
  const w = grid[0].length;
  /** @type {Cell[]} */
  const open = [];
  /** @type {Cell[]} */
  const coast = [];
  for (let j = 1; j < d - 1; j++) {
    for (let i = 1; i < w - 1; i++) {
      if (grid[j][i] !== '.') continue;
      let water = 0;
      let other = 0;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const ch = grid[j + dj][i + di];
          if (ch === '#') water++;
          else if (ch !== '.' && ch !== ',') other++;
        }
      }
      if (other === 0) (water > 0 ? coast : open).push([i, j]);
    }
  }
  /** @type {Cell[]} */
  const picks = [];
  let reach = reachable(grid);
  const spaced = (/** @type {Cell} */ [i, j]) => picks.every(([pi, pj]) => Math.abs(pi - i) + Math.abs(pj - j) >= 3);
  // a change that removes a tile must leave every other reachable tile reachable
  const place = (/** @type {Cell} */ [i, j], /** @type {string} */ ch) => {
    grid[j][i] = ch;
    const after = reachable(grid);
    if (after.size < reach.size - 1) {
      grid[j][i] = '.';
      return false;
    }
    reach = after;
    picks.push([i, j]);
    return true;
  };
  let obstacles = rng.int(1, 3);
  for (const cell of rng.shuffle(open)) {
    if (obstacles > 0 && spaced(cell) && place(cell, rng.chance(0.5) ? 'r' : 't')) obstacles--;
  }
  let shade = rng.int(2, 5);
  for (const [i, j] of rng.shuffle(open)) {
    if (shade > 0 && grid[j][i] === '.' && spaced([i, j])) {
      grid[j][i] = ',';
      picks.push([i, j]);
      shade--;
    }
  }
  let bites = rng.int(0, 3);
  for (const cell of rng.shuffle(coast)) {
    if (bites > 0 && spaced(cell) && place(cell, '#')) bites--;
  }
  return grid.map((row) => row.join(''));
}

/**
 * The model pad: the free stretch of floor nearest the middle of a board
 * where a hint's picture is drawn (no stone, no marker, no plank on it).
 * @param {string[]} rows @returns {Board['pad']}
 */
function findPad(rows) {
  const d = rows.length;
  const w = rows[0].length;
  const free = (/** @type {number} */ i, /** @type {number} */ j) => '.,o'.includes(rows[j][i]);
  for (const [pw, pd] of [[4, 2], [3, 2], [2, 2]]) {
    /** @type {Array<{ i: number, j: number, far: number }>} */
    const fits = [];
    for (let j = 1; j + pd < d; j++) {
      for (let i = 1; i + pw < w; i++) {
        let ok = true;
        for (let dj = 0; dj < pd && ok; dj++) for (let di = 0; di < pw && ok; di++) ok = free(i + di, j + dj);
        if (ok) fits.push({ i, j, far: Math.hypot(i + pw / 2 - w / 2, j + pd / 2 - d / 2) });
      }
    }
    fits.sort((a, b) => a.far - b.far || a.j - b.j || a.i - b.i);
    if (fits.length > 0) return { i: fits[0].i, j: fits[0].j, w: pw, d: pd };
  }
  return null;
}

/**
 * A board over finished rows: its markers read off the tiles.
 * @param {string} id @param {BoardKind} kind @param {World | null} world @param {string[]} rows
 * @returns {Board}
 */
function boardOf(id, kind, world, rows) {
  /** @type {Record<string, Cell[]>} */
  const found = {};
  rows.forEach((row, j) => [...row].forEach((ch, i) => (found[ch] ??= []).push([i, j])));
  const first = (/** @type {string} */ ch) => found[ch]?.[0] ?? null;
  const span = (/** @type {string} */ ch) => {
    const cells = found[ch];
    if (!cells) return null;
    const is = cells.map((c) => c[0]);
    const js = cells.map((c) => c[1]);
    return { i0: Math.min(...is), i1: Math.max(...is), j0: Math.min(...js), j1: Math.max(...js) };
  };
  const soil = span('o');
  const vine = span('V');
  return {
    id, kind, world,
    w: rows[0].length,
    d: rows.length,
    rows,
    spawn: /** @type {Cell} */ (first('P')),
    mimi: /** @type {Cell} */ (first('M')),
    altar: first('A'),
    pile: first('N'),
    stump: first('m'),
    spots: found.s ?? [],
    baskets: found.B ?? [],
    portals: kind === 'hub'
      ? /** @type {Record<World, Cell>} */ (Object.fromEntries(Object.entries(PORTAL_CHARS).map(([ch, w]) => [w, found[ch][0]])))
      : null,
    soil: soil && { i0: soil.i0, j0: soil.j0, cols: soil.i1 - soil.i0 + 1, rows: soil.j1 - soil.j0 + 1 },
    vine: vine && { i0: vine.i0, i1: vine.i1, j: vine.j0 },
    pad: kind === 'hub' ? null : findPad(rows),
  };
}

/**
 * A chamber board for a verb, dealt from a seed.
 * @param {Exclude<BoardKind, 'hub'>} kind @param {number} seed @param {World} world
 * @returns {Board}
 */
export function makeBoard(kind, seed, world) {
  const rng = createRng(seed);
  return boardOf(`${kind}:${world}:${seed}`, kind, world, varyLayout(rng.pick(TEMPLATES[kind]), rng));
}

/** The hub island. */
export const HUB = Object.freeze(boardOf('hub', 'hub', null, [...HUB_ROWS]));

/**
 * The board kind a problem kind is played on.
 * @param {import('./generators.js').Kind} kind @returns {Exclude<BoardKind, 'hub'>}
 */
export function boardKindFor(kind) {
  return kind === 'numberline' ? 'line' : kind;
}

/**
 * Whether a board has what a problem kind needs.
 * @param {Board} board @param {import('./generators.js').Kind} kind
 */
export function canHost(board, kind) {
  if (kind === 'array') return board.soil !== null;
  if (kind === 'numberline') return board.vine !== null;
  if (kind === 'share') return board.stump !== null && board.baskets.length >= 2;
  return board.altar !== null && board.spots.length >= 4;
}

/**
 * The shortest walk between two points over walkable tiles: the centres
 * of the tiles on the way, ending at the goal itself. A goal on a tile
 * that cannot be stood on (a basket, the altar) ends beside it instead,
 * on the free neighbour nearest the start. Null when nothing leads there.
 * @param {Board} board @param {[number, number]} from @param {[number, number]} to
 * @returns {Array<[number, number]> | null}
 */
export function findPath(board, from, to) {
  const [si, sj] = tileAt(board, from[0], from[1]);
  const [gi, gj] = tileAt(board, to[0], to[1]);
  if (charAt(board, gi, gj) === '#') return null;
  const key = (/** @type {number} */ i, /** @type {number} */ j) => j * board.w + i;
  /** @type {Map<number, number>} */
  const back = new Map([[key(si, sj), -1]]);
  const queue = [[si, sj]];
  for (let head = 0; head < queue.length; head++) {
    const [i, j] = queue[head];
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ni = i + di;
      const nj = j + dj;
      if (!back.has(key(ni, nj)) && isWalkable(charAt(board, ni, nj))) {
        back.set(key(ni, nj), key(i, j));
        queue.push([ni, nj]);
      }
    }
  }
  const standable = isWalkable(charAt(board, gi, gj));
  /** @type {number | null} */
  let goal = standable && back.has(key(gi, gj)) ? key(gi, gj) : null;
  if (!standable) {
    let best = Infinity;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const k = key(gi + di, gj + dj);
      const [cx, cz] = centerOf(board, gi + di, gj + dj);
      const far = Math.hypot(cx - from[0], cz - from[1]);
      if (back.has(k) && far < best) {
        best = far;
        goal = k;
      }
    }
  }
  if (goal === null) return null;
  /** @type {Array<[number, number]>} */
  const path = [];
  for (let k = goal; back.get(k) !== -1; k = /** @type {number} */ (back.get(k))) path.unshift(centerOf(board, k % board.w, Math.floor(k / board.w)));
  // the last leg goes to the very point asked for, kept clear of the walls of its tile
  if (standable) {
    const [cx, cz] = centerOf(board, gi, gj);
    const room = 0.5 - EDGE;
    let [x, z] = to;
    if (!isWalkable(charAt(board, gi - 1, gj))) x = Math.max(x, cx - room);
    if (!isWalkable(charAt(board, gi + 1, gj))) x = Math.min(x, cx + room);
    if (!isWalkable(charAt(board, gi, gj - 1))) z = Math.max(z, cz - room);
    if (!isWalkable(charAt(board, gi, gj + 1))) z = Math.min(z, cz + room);
    path.pop();
    path.push([x, z]);
  }
  return path;
}
