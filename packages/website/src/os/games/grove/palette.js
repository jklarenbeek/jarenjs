//@ts-check
/**
 * Monkey Grove's colours, all in one place: the OS brights, the sea, the
 * sand and the woods, each world's floor and accent, the fur of the two
 * monkeys, and the warm gray a world wears before its numbers come home.
 * Bold flat fills under black outlines — and, by the house rule, no pink
 * and no purple anywhere (a test holds every colour here outside that
 * family of hues).
 */

/** The named colours. */
export const COLORS = Object.freeze({
  paper: '#fffdf6',
  sea: '#0ea5e9',
  seaNight: '#1e3a8a',
  sand: '#fde68a',
  gray: '#b8b2a8',
  stone: '#a8a29e',
  bark: '#a16207',
  wood: '#78350f',
  leaf: '#16a34a',
  lime: '#84cc16',
  gold: '#fbbf24',
  amber: '#f59e0b',
  orange: '#fb923c',
  red: '#ef4444',
  blue: '#2563eb',
  cyan: '#06b6d4',
  deep: '#0f766e',
  monkey: '#a16207',
  mimi: '#f59e0b',
});

/** Each world's floor and accent (its portal, its flash, its swatch). */
export const WORLD_COLORS = Object.freeze(/** @type {Record<import('./math.js').World, { floor: string, accent: string }>} */ ({
  tide: { floor: '#fde68a', accent: '#06b6d4' },
  garden: { floor: '#84cc16', accent: '#fbbf24' },
  stump: { floor: '#f59e0b', accent: '#78350f' },
  vines: { floor: '#16a34a', accent: '#0ea5e9' },
}));
