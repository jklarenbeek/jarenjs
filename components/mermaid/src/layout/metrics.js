//@ts-check
/**
 * @file Headless text metrics (design decision: no `getBBox`, no DOM).
 *
 * `measureText` estimates a string's rendered box from a precomputed
 * per-codepoint advance-width table for a default sans-serif at unit em.
 * It is deliberately an **approximation** — pixel parity with a browser
 * font is a non-goal (see MERMAID-FORMAT §6). The table is a module
 * constant (`Float32Array`), the hot loop allocates nothing, and
 * unmapped codepoints fall back to an average advance.
 */

/** Average advance (em) for codepoints outside the ASCII table. */
const FALLBACK_ADVANCE = 0.55;
/** Line-height multiple of the font size. */
const LINE_HEIGHT = 1.2;

/**
 * ASCII printable advances (em) for a Helvetica-like sans-serif,
 * indexed by `code - 32`. Compact, good enough for box sizing.
 */
const ADVANCE = buildAdvanceTable();

/**
 * @returns {Float32Array}
 */
function buildAdvanceTable() {
  const t = new Float32Array(95);
  t.fill(0.556);
  const set = (chars, w) => {
    for (const ch of chars) t[ch.charCodeAt(0) - 32] = w;
  };
  set(' ', 0.278);
  set('!', 0.278);
  set('"', 0.355);
  set("'", 0.191);
  set('(', 0.333); set(')', 0.333);
  set('*', 0.389);
  set('+', 0.584);
  set(',', 0.278); set('.', 0.278);
  set('-', 0.333);
  set('/', 0.278);
  set('0123456789', 0.556);
  set(':', 0.278); set(';', 0.278);
  set('<', 0.584); set('=', 0.584); set('>', 0.584);
  set('?', 0.556);
  set('@', 1.015);
  set('ABDEHKNPRSUVXYZ', 0.667);
  set('C', 0.722); set('G', 0.722); set('O', 0.778); set('Q', 0.778);
  set('D', 0.722);
  set('M', 0.833); set('W', 0.944);
  set('I', 0.278); set('J', 0.5); set('L', 0.556); set('F', 0.611); set('T', 0.611);
  set('[', 0.278); set(']', 0.278);
  set('\\', 0.278);
  set('^', 0.469);
  set('_', 0.556);
  set('`', 0.333);
  set('abcdeghnopqu', 0.556);
  set('f', 0.278); set('i', 0.222); set('j', 0.222); set('l', 0.222); set('t', 0.278);
  set('k', 0.5); set('r', 0.333); set('s', 0.5);
  set('m', 0.833); set('w', 0.722);
  set('v', 0.5); set('x', 0.5); set('y', 0.5); set('z', 0.5);
  set('{', 0.334); set('}', 0.334); set('|', 0.26);
  set('~', 0.584);
  return t;
}

/**
 * Advance (em) of a single codepoint.
 * @param {number} code
 * @returns {number}
 */
function advanceOf(code) {
  if (code >= 32 && code < 127) return ADVANCE[code - 32];
  return FALLBACK_ADVANCE;
}

/**
 * Measure a (possibly multi-line) string's box.
 * @param {string} str
 * @param {number} fontSize px
 * @param {number} [weight] 400 normal, 700 bold (bold widens ~4%)
 * @returns {{ width: number, height: number, lines: string[] }}
 */
export function measureText(str, fontSize, weight = 400) {
  const boldFactor = weight >= 700 ? 1.04 : 1;
  const lines = str.length === 0 ? [''] : str.split('\n');
  let maxWidth = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let w = 0;
    for (let c = 0; c < line.length; c++) w += advanceOf(line.charCodeAt(c));
    w *= fontSize * boldFactor;
    if (w > maxWidth) maxWidth = w;
  }
  return {
    width: maxWidth,
    height: lines.length * fontSize * LINE_HEIGHT,
    lines,
  };
}

/**
 * The single-line advance width (em × fontSize).
 * @param {string} str
 * @param {number} fontSize
 * @param {number} [weight]
 * @returns {number}
 */
export function textWidth(str, fontSize, weight = 400) {
  const boldFactor = weight >= 700 ? 1.04 : 1;
  let w = 0;
  for (let c = 0; c < str.length; c++) w += advanceOf(str.charCodeAt(c));
  return w * fontSize * boldFactor;
}
