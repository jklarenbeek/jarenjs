//@ts-check
/**
 * @file Small shared helpers for the mermaid engine.
 *
 * `hashContent` and `coord` are re-exported rather than re-implemented, so
 * this package agrees with the rest of the suite by construction:
 * `hashContent` is the one content fingerprint (the same source produces
 * the same vnode `key`, `meta.hash` and memo key whether it flows through
 * the Markdown engine or this one), and `coord` is the one SVG coordinate
 * quantization, so a layout pass emits geometry at exactly the precision
 * the renderer would round it to — which is what keeps the golden JSON and
 * the SVG it renders to byte-stable instead of carrying float noise.
 */

export { hashContent } from '@jarenjs/core/string';
export { coord } from '@jarenjs/view/helpers';

/**
 * The first whitespace-delimited token of a line: everything up to the
 * first space or tab (the whole line when there is neither). The
 * grammars are line-oriented and keyword-led, so this is how both the
 * type dispatcher and the sequence parser read a line's keyword —
 * no allocation beyond the returned slice.
 * @param {string} line
 * @returns {string}
 */
export function firstToken(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) !== 0x20 && line.charCodeAt(i) !== 0x09) i++;
  return line.slice(0, i);
}

/**
 * Accumulate a `{ ... }` body that may span multiple lines. `head` is
 * the text after the opening brace on the current line; lines are
 * consumed until one contains the closing brace. Returns the body text
 * before the `}` (the whole rest of the source when no brace ever
 * closes it) and the advanced line index so the caller's loop can
 * continue after the block (class and ER entity bodies share this).
 * Each line is searched once, so an unclosed body costs its length.
 * @param {string[]} lines
 * @param {number} li - index of the line the `{` sits on
 * @param {string} head - text after the opening brace
 * @returns {{ body: string, li: number }}
 */
export function collectBraceBody(lines, li, head) {
  const close = head.indexOf('}');
  if (close !== -1) return { body: head.slice(0, close), li };
  const parts = [head];
  while (li + 1 < lines.length) {
    li++;
    const at = lines[li].indexOf('}');
    if (at !== -1) {
      parts.push(lines[li].slice(0, at));
      break;
    }
    parts.push(lines[li]);
  }
  return { body: parts.join('\n'), li };
}

/** A lone `:`, which opens a label (`:::` names a style class). */
const RE_LONE_COLON = /(?<!:):(?!:)/;

/**
 * Where a `%%` comment starts, outside a label (the text after a lone `:`
 * keeps it, as Mermaid's does, and the colons of a `:::style` are no label);
 * -1 when the line holds none.
 * @param {string} line
 * @returns {number}
 */
export function commentStart(line) {
  const at = line.indexOf('%%');
  if (at === -1) return -1;
  const colon = RE_LONE_COLON.exec(line);
  return colon !== null && colon.index < at ? -1 : at;
}
