//@ts-check
/**
 * @file Pure color helpers — dependency-free numeric math over color
 * strings, with no view or DOM knowledge. The one home for the suite's
 * color primitives (currently the hex `#rrggbb` interpolation used by the
 * calc surface shader).
 */

/**
 * Linear-interpolate two `#rrggbb` hex colors channel-by-channel and
 * return the result as `#rrggbb`. `t` is the blend factor (0 → `a`,
 * 1 → `b`); values outside `[0, 1]` extrapolate.
 *
 * @param {string} a a `#rrggbb` hex color
 * @param {string} b a `#rrggbb` hex color
 * @param {number} t blend factor
 * @returns {string} the interpolated `#rrggbb` color
 */
export function lerpColor(a, b, t) {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const ar = (pa >> 16) & 255, ag = (pa >> 8) & 255, ab = pa & 255;
  const br = (pb >> 16) & 255, bg = (pb >> 8) & 255, bb = pb & 255;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return '#' + ((1 << 24) | (r << 16) | (g << 8) | bl).toString(16).slice(1);
}

/**
 * WCAG relative luminance of a `#rrggbb` hex color: 0 for black, 1 for
 * white. The sRGB channels are linearized (the 2.4-exponent transfer
 * curve with its linear toe) and weighted per ITU-R BT.709. Use it to
 * pick a legible ink over an arbitrary fill (light ink below ~0.4,
 * dark ink above).
 *
 * @param {string} hex a `#rrggbb` hex color
 * @returns {number} relative luminance in [0, 1]
 */
export function relativeLuminance(hex) {
  const p = parseInt(hex.slice(1), 16);
  const r = channel(((p >> 16) & 255) / 255);
  const g = channel(((p >> 8) & 255) / 255);
  const b = channel((p & 255) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Linearize one sRGB channel value in [0, 1].
 * @param {number} c
 * @returns {number}
 */
function channel(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** The designed inks, and the WCAG AA threshold for body text. */
const INK_DARK = '#1f2020';
const INK_LIGHT = '#ffffff';
const AA_CONTRAST = 4.5;

/**
 * A legible ink for text set INSIDE a concrete fill: near-black on light
 * fills, white on dark ones.
 *
 * Keyed off the fill's luminance, **not** the theme. That distinction is the
 * whole point: a fill the author named is a constant, so it does not follow
 * light/dark — and if the ink does, a light fill under a dark theme ends up
 * with light text on it and the label disappears.
 *
 * The choice is made by comparing the two candidates' actual WCAG contrast
 * rather than by a luminance threshold. A threshold is subtly wrong in the
 * mid-tones: at 0.4 a fill like `#87b496` took dark ink and landed at 2.33:1,
 * well under AA, because the crossover between the two inks is near 0.179 and
 * not where a round number puts it. Picking the better of two is optimal by
 * construction, so the worst case over the whole RGB cube is ~4.6:1 — which
 * clears AA with nothing to tune.
 * @param {string} fillHex - The `#rgb` or `#rrggbb` fill under the text
 * @returns {string} `#1f2020` or `#ffffff`
 */
export function inkFor(fillHex) {
  const fill = relativeLuminance(expandHex(fillHex));
  const preferred = contrastOf(fill, relativeLuminance(INK_DARK))
    >= contrastOf(fill, relativeLuminance(INK_LIGHT))
    ? INK_DARK
    : INK_LIGHT;
  if (contrastOf(fill, relativeLuminance(preferred)) >= AA_CONTRAST)
    return preferred;
  // The designed near-black is softer than true black, and that softness
  // costs contrast: against a mid-tone it bottoms out near 4.06:1, just under
  // AA. Falling through to pure black or white for exactly those fills keeps
  // the guarantee without making every other diagram harsher than it needs.
  return fill > 0.1791 ? '#000000' : '#ffffff';
}

/**
 * The WCAG contrast ratio between two relative luminances, from 1 (identical)
 * to 21 (black on white).
 * @param {number} a
 * @param {number} b
 * @returns {number}
 */
export function contrastOf(a, b) {
  const hi = a > b ? a : b;
  const lo = a > b ? b : a;
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Whether a CSS color value is a concrete hex this module can reason about.
 * A `var(...)`, a named color or a function is not: it may resolve to
 * anything at paint time, so the caller must fall back to its theme.
 * @param {string} value
 * @returns {boolean}
 */
export function isHexColor(value) {
  return typeof value === 'string' && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value.trim());
}

/** Expand `#abc` to `#aabbcc`; pass a 6-digit hex through. */
function expandHex(hex) {
  const h = hex.trim();
  if (h.length !== 4) return h;
  return '#' + h[1] + h[1] + h[2] + h[2] + h[3] + h[3];
}
