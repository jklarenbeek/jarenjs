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
