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
 * @param {Record<string, Record<string, string>>} themes the component's
 *   named token tables (must include a `default`)
 * @param {string} prefix the CSS-variable prefix (e.g. `mm`, `calc`),
 *   without the leading `--`
 * @param {string | Record<string, string>} [nameOrOverrides]
 * @returns {{ name: string, tokens: Record<string, string>, cssVars: Record<string, string> }}
 */
export function resolveTheme(themes, prefix, nameOrOverrides = 'default') {
  let name = 'default';
  let base = themes.default;
  let overrides = {};
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
  }
  const tokens = { ...base, ...overrides };
  const cssVars = {};
  for (const key of Object.keys(tokens)) {
    cssVars['--' + prefix + '-' + kebabCase(key)] = tokens[key];
  }
  return { name, tokens, cssVars };
}
