//@ts-check
/**
 * @file The one reading of a flowchart or state label's text, shared by the
 * layout that measures a label and both renderers that draw it (SVG text and
 * HTML labels), so the box is always sized for the lines that are drawn.
 *
 * A label breaks into lines at a newline and at `<br>` (`<br/>`, `<br />`),
 * whichever form the label was written in. A label wrapped in backticks is a
 * markdown string (Mermaid's `` "`…`" ``): its lines are trimmed, blank ones
 * dropped, and `**bold**`/`__bold__` and `*italic*`/`_italic_` become styled
 * runs. Mermaid's entity codes (`#9829;`) are decoded last, inside the text
 * the line breaks and the emphasis left, so nothing a code decodes to is ever
 * read as a line break, as emphasis or as markup: decoded text is text, and
 * the renderers escape it like any other.
 */

/** A line break inside a label: a newline or Mermaid's `<br>` spellings. */
const RE_LINE_BREAK = /\n|<br\s*\/?>/i;

/** An entity code as Mermaid's source reads it: `#` + word characters + `;`. */
const RE_ENTITY_CODE = /#(\w+);/g;

/** A decimal entity code's body. */
const RE_DECIMAL = /^\d+$/;

/** A letter or digit: `_` beside one is part of a word, never emphasis. */
const RE_WORD_CHAR = /[\p{L}\p{N}]/u;

/**
 * What the HTML standard reads a decimal reference to U+0080–U+009F as: the
 * windows-1252 character at that byte (the C1 codes it leaves unmapped stay).
 * @type {Record<number, number>}
 */
const C1_REMAP = {
  0x80: 0x20AC, 0x82: 0x201A, 0x83: 0x0192, 0x84: 0x201E, 0x85: 0x2026,
  0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02C6, 0x89: 0x2030, 0x8A: 0x0160,
  0x8B: 0x2039, 0x8C: 0x0152, 0x8E: 0x017D, 0x91: 0x2018, 0x92: 0x2019,
  0x93: 0x201C, 0x94: 0x201D, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014,
  0x98: 0x02DC, 0x99: 0x2122, 0x9A: 0x0161, 0x9B: 0x203A, 0x9C: 0x0153,
  0x9E: 0x017E, 0x9F: 0x0178,
};

/**
 * A styled stretch of a markdown line.
 * @typedef {{ text: string, type: 'normal' | 'strong' | 'em' }} LabelRun
 */

/**
 * One drawn line of a label: its text when the label is plain, its runs when
 * the label is a markdown string.
 * @typedef {string | LabelRun[]} LabelLine
 */

/**
 * Decode Mermaid's decimal entity codes (`#35;` is `#`, `#9829;` is ♥) as an
 * HTML parser reads the reference Mermaid turns each into: zero, a surrogate
 * or a value past U+10FFFF is U+FFFD and U+0080–U+009F is windows-1252. Two
 * readings differ, both so the output stays well-formed text: a code for a
 * character XML cannot carry (a control other than tab, newline and carriage
 * return; U+FFFE; U+FFFF) is U+FFFD, and tab, newline and carriage return
 * are a space, which is how SVG and an unwrapped HTML label draw them (Mermaid
 * breaks the line at `#10;`). A named code (`#quot;`) stays as written: this
 * component carries no table of named references.
 * @param {string} text
 * @returns {string}
 */
export function decodeEntityCodes(text) {
  if (text.indexOf('#') === -1) return text;
  return text.replace(RE_ENTITY_CODE, (code, body) => {
    if (!RE_DECIMAL.test(body)) return code;
    return String.fromCodePoint(decimalCodePoint(Number(body)));
  });
}

/**
 * The code point a decimal reference reads as (see {@link decodeEntityCodes}).
 * @param {number} n
 * @returns {number}
 */
function decimalCodePoint(n) {
  if (n === 0 || n > 0x10FFFF || (n >= 0xD800 && n <= 0xDFFF)) return 0xFFFD;
  if (n === 0x09 || n === 0x0A || n === 0x0D) return 0x20;
  if (n < 0x20 || n === 0xFFFE || n === 0xFFFF) return 0xFFFD;
  return C1_REMAP[n] ?? n;
}

/**
 * Whether a label is a markdown string: its text wrapped in backticks, as
 * Mermaid's `` "`…`" `` leaves it once the quotes are read. (Mermaid reads
 * the unquoted `` [`…`] `` as plain text with its backticks; this engine,
 * whose tree keeps no quotes, reads both as markdown, and `toMermaid` prints
 * a markdown string quoted, so printed source reads the same in both.)
 * @param {string} label
 * @returns {boolean}
 */
export function isMarkdownString(label) {
  return label.length > 1 && label.charCodeAt(0) === 0x60 && label.charCodeAt(label.length - 1) === 0x60;
}

/**
 * Read a label into the lines it is drawn as.
 * @param {string} label the label as the AST holds it
 * @returns {LabelLine[]}
 */
export function readLabel(label) {
  if (isMarkdownString(label)) {
    const lines = label.slice(1, -1).split(RE_LINE_BREAK)
      .map((line) => line.trim()).filter((line) => line !== '');
    return lines.length === 0 ? [''] : lines.map(emphasisRuns);
  }
  return label.split(RE_LINE_BREAK).map(decodeEntityCodes);
}

/**
 * Append a run to a line's runs, joining it to the last run when they share
 * a style, so a line never holds two adjacent runs of one style.
 * @param {LabelRun[]} runs
 * @param {LabelRun} run
 */
export function appendRun(runs, run) {
  const prev = runs[runs.length - 1];
  if (prev !== undefined && prev.type === run.type) prev.text += run.text;
  else runs.push({ text: run.text, type: run.type });
}

/**
 * A line's text without its styling.
 * @param {LabelLine} line
 * @returns {string}
 */
export function lineText(line) {
  return typeof line === 'string' ? line : line.map((run) => run.text).join('');
}

/**
 * A markdown line's styled runs. Delimiter runs of `*` or `_` pair up as
 * CommonMark pairs them, simplified: a run can open when a non-space follows
 * it and close when a non-space precedes it (`_` also never beside a letter or
 * digit on its outer side); a closer takes the nearest opener of its
 * character, two characters each when both have two (bold), else one
 * (italic); an unpaired delimiter is literal text. Where emphasis nests, the
 * innermost wins, as Mermaid draws it. Linear in the line's length.
 * @param {string} line
 * @returns {LabelRun[]}
 */
function emphasisRuns(line) {
  /** @type {({ text: string } | { ch: string, avail: number, open: boolean, close: boolean, closes: number, opened: ('strong'|'em')[] })[]} */
  const tokens = [];
  let start = 0;
  for (let i = 0; i < line.length;) {
    const c = line[i];
    if (c !== '*' && c !== '_') { i++; continue; }
    let j = i;
    while (j < line.length && line[j] === c) j++;
    if (i > start) tokens.push({ text: line.slice(start, i) });
    const before = i === 0 ? ' ' : line[i - 1];
    const after = j === line.length ? ' ' : line[j];
    let open = after.trim() !== '';
    let close = before.trim() !== '';
    if (c === '_') {
      open = open && !RE_WORD_CHAR.test(before);
      close = close && !RE_WORD_CHAR.test(after);
    }
    tokens.push({ ch: c, avail: j - i, open, close, closes: 0, opened: [] });
    start = i = j;
  }
  if (start < line.length) tokens.push({ text: line.slice(start) });

  // Pair closers with openers. The stack only ever holds openers with
  // characters left; openers above a match can no longer pair across it.
  // `bottom` is, per character, the stack height below which no opener of
  // that character waits, so a failed search is never repeated.
  /** @type {number[]} */
  const stack = [];
  /** @type {Record<string, number>} */
  const bottom = { '*': 0, _: 0 };
  for (let t = 0; t < tokens.length; t++) {
    const d = tokens[t];
    if (!('ch' in d)) continue;
    if (d.close) {
      while (d.avail > 0) {
        let s = stack.length - 1;
        while (s >= bottom[d.ch] && /** @type {any} */ (tokens[stack[s]]).ch !== d.ch) s--;
        if (s < bottom[d.ch]) { bottom[d.ch] = stack.length; break; }
        const o = /** @type {any} */ (tokens[stack[s]]);
        const n = o.avail >= 2 && d.avail >= 2 ? 2 : 1;
        o.avail -= n;
        d.avail -= n;
        o.opened.push(n === 2 ? 'strong' : 'em');
        d.closes++;
        stack.length = o.avail > 0 ? s + 1 : s;
        bottom['*'] = Math.min(bottom['*'], stack.length);
        bottom._ = Math.min(bottom._, stack.length);
      }
    }
    if (d.open && d.avail > 0) stack.push(t);
  }

  // Emit: a closer ends its pairs on its inner (left) side, an opener starts
  // them on its inner (right) side, outermost first; what is left is text.
  /** @type {LabelRun[]} */
  const runs = [];
  /** @type {('strong'|'em')[]} */
  const active = [];
  const emit = (/** @type {string} */ text) => {
    if (text !== '') appendRun(runs, { text, type: active.length === 0 ? 'normal' : active[active.length - 1] });
  };
  for (const tok of tokens) {
    if (!('ch' in tok)) { emit(tok.text); continue; }
    active.length -= tok.closes;
    emit(tok.ch.repeat(tok.avail));
    for (let k = tok.opened.length - 1; k >= 0; k--) active.push(tok.opened[k]);
  }
  for (const run of runs) run.text = decodeEntityCodes(run.text);
  return runs;
}
