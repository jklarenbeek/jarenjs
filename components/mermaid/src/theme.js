//@ts-check
/**
 * @file Theme tokens (design decision D4/WI 4). `createTheme` resolves a
 * theme name (or overrides) into a flat token object of concrete colors
 * *and* a matching set of `--mm-*` CSS custom properties.
 *
 * Both are used at once, deliberately: the render pass writes the
 * concrete colors as SVG presentation attributes (so `toSvgString()` is
 * a valid, self-colored standalone SVG with no CSS), and also stamps the
 * `--mm-*` variables on the root `<svg>` and a `class` on every shape,
 * so `styles/mermaid.css` can re-theme (light/dark) purely in CSS —
 * cascade beats presentation attributes — **without a re-render**.
 *
 * Only the token tables live here; the resolution mechanics are shared
 * (`@jarenjs/view/helpers` `resolveTheme`).
 */

import { resolveTheme } from '@jarenjs/view/helpers';

/** @type {Record<string, Record<string, string>>} */
const THEMES = {
  default: {
    background: 'transparent',
    nodeFill: '#ECECFF',
    nodeStroke: '#9370DB',
    nodeText: '#1f2020',
    lineColor: '#333333',
    edgeLabelText: '#333333',
    edgeLabelBg: '#ffffff',
    clusterFill: '#ffffde',
    clusterStroke: '#aaaa33',
    actorFill: '#ECECFF',
    actorStroke: '#9370DB',
    actorText: '#1f2020',
    lifeline: '#999999',
    activationFill: '#f4f4f4',
    activationStroke: '#666666',
    noteFill: '#fff5ad',
    noteStroke: '#aaaa33',
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
 * Resolve a theme.
 * @param {string | Record<string, string>} [nameOrOverrides]
 * @returns {{ name: string, tokens: Record<string, string>, cssVars: Record<string, string> }}
 */
export function createTheme(nameOrOverrides = 'default') {
  return resolveTheme(THEMES, 'mm', nameOrOverrides);
}

export { THEMES };
