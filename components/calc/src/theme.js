//@ts-check
/**
 * @file Plot theme tokens (mirrors `@jarenjs/mermaid`'s theme). Resolves a
 * name (or overrides) into concrete colors (written as SVG presentation
 * attributes so `toSvgString()` is a valid standalone image) plus a
 * matching `--calc-*` CSS variable set (so `styles/calc.css` can re-theme
 * light/dark purely in CSS, without a re-render).
 */

/** @type {Record<string, Record<string, string>>} */
const THEMES = {
  default: {
    background: 'transparent',
    axis: '#64748b',
    grid: '#e2e8f0',
    text: '#334155',
    series1: '#4f46e5',
    series2: '#0891b2',
    series3: '#db2777',
    surfaceLo: '#312e81',
    surfaceHi: '#a5b4fc',
    wire: '#1e1b4b',
    errorText: '#b91c1c',
    fontFamily: '"trebuchet ms", verdana, arial, sans-serif',
  },
  dark: {
    background: 'transparent',
    axis: '#94a3b8',
    grid: '#334155',
    text: '#cbd5e1',
    series1: '#818cf8',
    series2: '#22d3ee',
    series3: '#f472b6',
    surfaceLo: '#3730a3',
    surfaceHi: '#c7d2fe',
    wire: '#0f172a',
    errorText: '#f87171',
    fontFamily: '"trebuchet ms", verdana, arial, sans-serif',
  },
};

/**
 * Resolve a theme name or override object.
 * @param {string | Record<string, string>} [nameOrOverrides]
 * @returns {{ name: string, tokens: Record<string, string>, cssVars: Record<string, string> }}
 */
export function createTheme(nameOrOverrides = 'default') {
  let name = 'default';
  let base = THEMES.default;
  let overrides = {};
  if (typeof nameOrOverrides === 'string') {
    name = THEMES[nameOrOverrides] ? nameOrOverrides : 'default';
    base = THEMES[name];
  }
  else if (nameOrOverrides && typeof nameOrOverrides === 'object') {
    if (typeof nameOrOverrides.theme === 'string' && THEMES[nameOrOverrides.theme]) {
      name = nameOrOverrides.theme;
      base = THEMES[name];
    }
    overrides = nameOrOverrides;
  }
  const tokens = { ...base, ...overrides };
  const cssVars = {};
  for (const key of Object.keys(tokens)) cssVars['--calc-' + kebab(key)] = tokens[key];
  return { name, tokens, cssVars };
}

/** @param {string} s */
function kebab(s) {
  return s.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
}

export { THEMES };
