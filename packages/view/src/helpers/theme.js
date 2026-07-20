//@ts-check
/**
 * @file Shared theme-resolution mechanics for SVG-emitting components.
 *
 * `resolveTheme` is the prefix-driven kernel behind each component's
 * `createTheme`: it resolves a theme name (or an overrides object) into a
 * flat token table of concrete values *and* a matching set of
 * `--<prefix>-*` CSS custom properties. Components keep their own token
 * tables and pass their CSS-variable prefix; the resolution logic lives
 * here once. Theme tokens are a view concern, so this is view/helpers, not
 * core — but the pure `kebabCase` transform it uses is core's.
 */

import { kebabCase } from '@jarenjs/core/string';

/**
 * Resolve a theme against a component's token tables.
 *
 * `nameOrOverrides` is either a theme name (falling back to `default` when
 * unknown) or an overrides object; an overrides object may name a base via
 * its `theme` property. The returned `cssVars` stamp every token as
 * `--<prefix>-<kebab-case-key>`.
 *
 * An overrides object may also carry a reserved `vars` key: a map of token
 * key → **host** custom-property name (e.g. `{ nodeFill: '--accent-soft' }`).
 * Linked tokens keep their concrete value in `tokens` (so presentation
 * attributes stay standalone-valid) but stamp their cssVar as
 * `var(<host-property>, <concrete>)` — the stamped SVG then follows the
 * host's tokens (light/dark and all) live, with the concrete color as the
 * fallback outside any host. `vars` never leaks into `tokens`.
 *
 * @param {Record<string, Record<string, string>>} themes the component's
 *   named token tables (must include a `default`)
 * @param {string} prefix the CSS-variable prefix (e.g. `mm`, `calc`),
 *   without the leading `--`
 * @param {string | Record<string, any>} [nameOrOverrides]
 * @returns {{ name: string, tokens: Record<string, string>, cssVars: Record<string, string> }}
 */
export function resolveTheme(themes, prefix, nameOrOverrides = 'default') {
  let name = 'default';
  let base = themes.default;
  let overrides = {};
  let vars = null;
  if (typeof nameOrOverrides === 'string') {
    name = themes[nameOrOverrides] ? nameOrOverrides : 'default';
    base = themes[name];
  }
  else if (nameOrOverrides && typeof nameOrOverrides === 'object') {
    if (typeof nameOrOverrides.theme === 'string' && themes[nameOrOverrides.theme]) {
      name = nameOrOverrides.theme;
      base = themes[name];
    }
    overrides = nameOrOverrides;
    if (overrides.vars && typeof overrides.vars === 'object') vars = overrides.vars;
  }
  const tokens = { ...base, ...overrides };
  delete tokens.vars;
  const cssVars = {};
  for (const key of Object.keys(tokens)) {
    const linked = vars !== null && typeof vars[key] === 'string' ? vars[key] : null;
    cssVars['--' + prefix + '-' + kebabCase(key)] = linked !== null
      ? 'var(' + linked + ', ' + tokens[key] + ')'
      : tokens[key];
  }
  return { name, tokens, cssVars };
}
