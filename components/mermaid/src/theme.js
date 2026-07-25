//@ts-check
/**
 * @file Theme tokens. `createTheme` resolves a
 * theme name (or overrides) into a flat token object of concrete colors
 * *and* a matching set of `--mm-*` CSS custom properties.
 *
 * Both are used at once, deliberately: the render pass writes the
 * concrete colors as SVG presentation attributes (so `toSvgString()` is
 * a valid, self-colored standalone SVG with no CSS), and also stamps the
 * `--mm-*` variables inline on the root `<svg>` plus a `class` on every
 * shape, which `styles/mermaid.css` maps back to `var(--mm-*)`. Because
 * the stamp is an inline style it beats every stylesheet rule — so the
 * stamp itself is the re-theming hook: the `'host'` theme stamps each
 * linked variable as `var(--<host-token>, <concrete>)` (see `HOST_VARS`),
 * making diagrams follow a host's light/dark tokens live, with no
 * re-render — memoized vnodes stay valid across a theme flip.
 *
 * Only the token tables live here; the resolution mechanics are shared
 * (`@jarenjs/view/helpers` `resolveTheme`).
 */

import { resolveTheme } from '@jarenjs/view/helpers';

/** @type {Record<string, Record<string, string>>} */
const THEMES = {
  default: {
    background: 'transparent',
    nodeFill: '#dbeafe',
    nodeStroke: '#2563eb',
    nodeText: '#1f2020',
    lineColor: '#333333',
    edgeLabelText: '#333333',
    edgeLabelBg: '#ffffff',
    clusterFill: '#f1f5f9',
    clusterStroke: '#94a3b8',
    actorFill: '#dbeafe',
    actorStroke: '#2563eb',
    actorText: '#1f2020',
    lifeline: '#999999',
    activationFill: '#f4f4f4',
    activationStroke: '#666666',
    noteFill: '#fef3c7',
    noteStroke: '#d97706',
    noteText: '#1f2020',
    fontFamily: '"trebuchet ms", verdana, arial, sans-serif',
  },
  dark: {
    background: 'transparent',
    nodeFill: '#1f2020',
    nodeStroke: '#81B1DB',
    nodeText: '#f4f4f4',
    lineColor: '#cccccc',
    edgeLabelText: '#e0e0e0',
    edgeLabelBg: '#1f2020',
    clusterFill: '#2b2b3a',
    clusterStroke: '#6f6f9e',
    actorFill: '#252526',
    actorStroke: '#81B1DB',
    actorText: '#f4f4f4',
    lifeline: '#8a8a8a',
    activationFill: '#31313a',
    activationStroke: '#8a8a8a',
    noteFill: '#3b3b26',
    noteStroke: '#aaaa33',
    noteText: '#f4f4f4',
    fontFamily: '"trebuchet ms", verdana, arial, sans-serif',
  },
  neutral: {
    background: 'transparent',
    nodeFill: '#eee',
    nodeStroke: '#999',
    nodeText: '#111',
    lineColor: '#666',
    edgeLabelText: '#333',
    edgeLabelBg: '#fff',
    clusterFill: '#f4f4f4',
    clusterStroke: '#bbb',
    actorFill: '#eee',
    actorStroke: '#999',
    actorText: '#111',
    lifeline: '#999',
    activationFill: '#f4f4f4',
    activationStroke: '#666',
    noteFill: '#f3f3d9',
    noteStroke: '#b7b76d',
    noteText: '#111',
    fontFamily: '"trebuchet ms", verdana, arial, sans-serif',
  },
  forest: {
    background: 'transparent',
    nodeFill: '#cde498',
    nodeStroke: '#13540c',
    nodeText: '#13540c',
    lineColor: '#13540c',
    edgeLabelText: '#13540c',
    edgeLabelBg: '#e8f5e0',
    clusterFill: '#cdffb2',
    clusterStroke: '#6eaa49',
    actorFill: '#cde498',
    actorStroke: '#13540c',
    actorText: '#13540c',
    lifeline: '#6eaa49',
    activationFill: '#e8f5e0',
    activationStroke: '#13540c',
    noteFill: '#fff5ad',
    noteStroke: '#aaaa33',
    noteText: '#13540c',
    fontFamily: '"trebuchet ms", verdana, arial, sans-serif',
  },
};

/**
 * Host custom-property links for the `'host'` theme: token key → the host
 * token it should follow (the site token vocabulary, DESIGN.md §2). The
 * default theme's concrete colors remain as `var()` fallbacks, so the
 * same SVG is standalone-valid outside any host.
 * @type {Record<string, string>}
 */
export const HOST_VARS = {
  nodeFill: '--accent-soft',
  nodeStroke: '--accent',
  nodeText: '--fg',
  lineColor: '--fg',
  edgeLabelText: '--fg',
  edgeLabelBg: '--bg',
  clusterFill: '--surface',
  clusterStroke: '--border',
  actorFill: '--accent-soft',
  actorStroke: '--accent',
  actorText: '--fg',
  lifeline: '--muted',
  activationFill: '--surface',
  activationStroke: '--muted',
  noteFill: '--warn-soft',
  noteStroke: '--warn',
  noteText: '--fg',
};

/**
 * Resolve a theme. The name `'host'` resolves the default tokens linked
 * to the host token vocabulary via {@link HOST_VARS}.
 * @param {string | Record<string, any>} [nameOrOverrides]
 * @returns {{ name: string, tokens: Record<string, string>, cssVars: Record<string, string> }}
 */
export function createTheme(nameOrOverrides = 'default') {
  return resolveTheme(THEMES, 'mm', nameOrOverrides, HOST_VARS);
}

export { THEMES };
