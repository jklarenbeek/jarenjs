//@ts-check
/**
 * @file Colors: the categorical palette and the theme token tables.
 *
 * The categorical palette is a concrete constant, not a set of theme
 * tokens (DESIGN.md §8), in the suite's anchor order — blue first,
 * amber second, teal third, then green/red/navy/olive/slate — with no
 * pink and no purple anywhere. It is the same palette the mermaid pie
 * used before it delegated here, so a pie renders byte-identically
 * through either package.
 *
 * The semantic tokens (text/grid/axis, the win/loss pair) resolve
 * through the shared `resolveTheme` kernel with the `chart` prefix; the
 * `'host'` theme links them to the site token vocabulary (DESIGN.md §2,
 * §7) so charts follow the host's light/dark flip live with no
 * re-render. Sync invariant: the `default`/`dark` values below must
 * match the `--chart-*` fallbacks in `styles/charts.css`.
 */

import { resolveTheme } from '@jarenjs/view/helpers';

/**
 * The categorical series palette (DESIGN.md §8 anchor order).
 * @type {readonly string[]}
 */
export const CATEGORICAL = ['#2563eb', '#f59e0b', '#0d9488', '#dc2626', '#16a34a', '#0369a1', '#ca8a04', '#64748b', '#93c5fd', '#78350f'];

/**
 * Ordinal color assignment: series `i` gets the `i`-th palette entry,
 * wrapping.
 * @param {number} i - Series index
 * @param {readonly string[]} [palette] - Palette to draw from
 * @returns {string}
 */
export function seriesColor(i, palette = CATEGORICAL) {
  return palette[i % palette.length];
}

/** @type {Record<string, Record<string, string>>} */
const THEMES = {
  default: {
    background: 'transparent',
    text: '#1f2020',
    muted: '#64748b',
    grid: '#e2e8f0',
    axis: '#94a3b8',
    win: '#16a34a',
    loss: '#dc2626',
    sliceStroke: '#ffffff',
    fontFamily: 'Inter, "Helvetica Neue", Arial, sans-serif',
  },
  dark: {
    background: 'transparent',
    text: '#f4f4f4',
    muted: '#94a3b8',
    grid: '#334155',
    axis: '#64748b',
    win: '#4ade80',
    loss: '#f87171',
    sliceStroke: '#11141c',
    fontFamily: 'Inter, "Helvetica Neue", Arial, sans-serif',
  },
};

/**
 * Host custom-property links for the `'host'` theme: token key → the
 * site token it follows (DESIGN.md §2). Concrete defaults remain as
 * `var()` fallbacks, so the same SVG stays standalone-valid.
 * @type {Record<string, string>}
 */
export const HOST_VARS = {
  text: '--fg',
  muted: '--muted',
  grid: '--border',
  axis: '--muted',
  win: '--ok',
  loss: '--fail',
  sliceStroke: '--bg',
};

/**
 * Resolve a chart theme. The name `'host'` resolves the default tokens
 * linked to the host token vocabulary via {@link HOST_VARS}.
 * @param {string | Record<string, any>} [nameOrOverrides]
 * @returns {{ name: string, tokens: Record<string, string>, cssVars: Record<string, string> }}
 */
export function createTheme(nameOrOverrides = 'default') {
  if (nameOrOverrides === 'host') nameOrOverrides = { vars: HOST_VARS };
  return resolveTheme(THEMES, 'chart', nameOrOverrides);
}

export { THEMES };
