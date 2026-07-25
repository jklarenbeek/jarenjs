//@ts-check
/**
 * @file Plot theme tokens (mirrors `@jarenjs/mermaid`'s theme). Resolves a
 * name (or overrides) into concrete colors (written as SVG presentation
 * attributes so `toSvgString()` is a valid standalone image) plus a
 * matching `--calc-*` CSS variable set stamped inline on the root `<svg>`.
 * The inline stamp beats every stylesheet rule, so the stamp itself is the
 * re-theming hook: the `'host'` theme stamps linked variables as
 * `var(--<host-token>, <concrete>)` (see `HOST_VARS`), making plots follow
 * a host's light/dark tokens live without a re-render. Only the token
 * tables live here; the resolution mechanics are shared
 * (`@jarenjs/view/helpers` `resolveTheme`).
 */

import { resolveTheme } from '@jarenjs/view/helpers';

/** @type {Record<string, Record<string, string>>} */
const THEMES = {
  default: {
    background: 'transparent',
    axis: '#64748b',
    grid: '#e2e8f0',
    text: '#334155',
    series1: '#2563eb',
    series2: '#0891b2',
    series3: '#d97706',
    surfaceLo: '#1e3a8a',
    surfaceHi: '#93c5fd',
    wire: '#172554',
    errorText: '#b91c1c',
    fontFamily: '"trebuchet ms", verdana, arial, sans-serif',
  },
  dark: {
    background: 'transparent',
    axis: '#94a3b8',
    grid: '#334155',
    text: '#cbd5e1',
    series1: '#60a5fa',
    series2: '#22d3ee',
    series3: '#fbbf24',
    surfaceLo: '#1e40af',
    surfaceHi: '#bfdbfe',
    wire: '#0b1020',
    errorText: '#f87171',
    fontFamily: '"trebuchet ms", verdana, arial, sans-serif',
  },
};

/**
 * Host custom-property links for the `'host'` theme: token key → the host
 * token it should follow (the site token vocabulary, DESIGN.md §2). The
 * default theme's concrete colors remain as `var()` fallbacks, so the
 * same SVG is standalone-valid outside any host. Tokens with no host
 * equivalent (series2, the 3-D surface shades, wire) stay concrete.
 * @type {Record<string, string>}
 */
export const HOST_VARS = {
  axis: '--muted',
  grid: '--border',
  text: '--fg',
  series1: '--accent',
  series3: '--warn',
  errorText: '--fail',
};

/**
 * Resolve a theme name or override object. The name `'host'` resolves the
 * default tokens linked to the host token vocabulary via {@link HOST_VARS}.
 * @param {string | Record<string, any>} [nameOrOverrides]
 * @returns {{ name: string, tokens: Record<string, string>, cssVars: Record<string, string> }}
 */
export function createTheme(nameOrOverrides = 'default') {
  return resolveTheme(THEMES, 'calc', nameOrOverrides, HOST_VARS);
}

export { THEMES };
