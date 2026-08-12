//@ts-check
/**
 * Cutting text down to size: the four operations every consumer of a
 * too-large value needs, in one place.
 *
 * They live together because they are one decision made four ways —
 * *how much of this do I carry?* `sizeOf` answers what it costs,
 * `excerpt` shows a line of it, `truncate` cuts it at a boundary and
 * says so, and `chunkText` splits it into pieces that can each be
 * carried, addressed and fetched on their own.
 *
 * Two rules hold across all four:
 *
 *  - **Characters, not bytes and not tokens.** Tokens are
 *    provider-private and bytes depend on an encoding nobody has agreed
 *    on at this layer; characters are deterministic, and a budget stated
 *    in them holds exactly.
 *  - **A cut is always visible.** `excerpt` appends an ellipsis and
 *    `truncate` a named marker, so nothing downstream — a reader, a
 *    model, a diff — mistakes a cut tail for the end of the content.
 *
 * Nothing here allocates a copy it does not return: `chunkText` slices,
 * and a caller streaming a corpus can write each piece and drop it.
 */

/**
 * The size of a value as the characters it will occupy in a request: a
 * string is its own length, anything else is the length of its JSON
 * encoding. That is the one size rule the suite budgets against — an
 * agent's history budget, a slot's metadata, a digest's cap — and it is
 * exact rather than an estimate, which is what makes those budgets hold
 * to the character instead of approximately.
 * @param {any} value
 * @returns {number}
 */
export function sizeOf(value) {
  return typeof value === 'string' ? value.length : JSON.stringify(value ?? null).length;
}

/**
 * A one-line excerpt: whitespace collapsed to single spaces, trimmed,
 * hard-capped, with an ellipsis when anything was dropped. Total over
 * `null`/`undefined`/non-strings, because it is called on content a
 * provider or a store may have left absent.
 * @param {any} text
 * @param {number} max - characters kept, before the ellipsis
 * @returns {string}
 */
export function excerpt(text, max) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * A hard cut with a named suffix, preserving newlines — what an
 * oversized result or an over-long generated block is reduced to. The
 * suffix is part of the contract: a cut that looked like an ending would
 * be read as one.
 * @param {string} text
 * @param {number} max
 * @param {string} [marker] - the suffix appended when a cut happened
 * @returns {string}
 */
export function truncate(text, max, marker = '… [truncated]') {
  return text.length > max ? `${text.slice(0, max)}${marker}` : text;
}

/**
 * How a text is cut into pieces.
 *
 *  - `size` — fixed character windows. The only strategy that will split
 *    a word, and the only one whose piece count is exactly predictable.
 *  - `line` — whole lines, grouped up to `size`. A line longer than
 *    `size` becomes its own oversized piece rather than being split:
 *    breaking a line is the one thing a line strategy may not do.
 *  - `separator` — units delimited by `separator` (paragraphs, records),
 *    grouped up to `size`, separators preserved between units in a
 *    piece. Same rule for an oversized unit.
 *
 * @typedef {'size' | 'line' | 'separator'} ChunkStrategy
 */

/**
 * Split a text into addressable pieces.
 *
 * Deterministic and total: the same text and the same options always
 * produce the same pieces, with the same offsets, which is what lets a
 * caller name a piece by its index and re-derive that name later instead
 * of storing a mapping. Empty text produces no pieces at all — an empty
 * piece is not a thing anyone wants an address for.
 *
 * `overlap` (character strategy only) repeats the tail of each piece at
 * the head of the next, so a match spanning a cut is still found whole
 * in one piece. It costs storage proportional to `overlap / size` and is
 * off by default.
 *
 * @param {string} text
 * @param {{ strategy?: ChunkStrategy, size?: number, overlap?: number,
 *   separator?: string }} [options]
 * @returns {Array<{ index: number, start: number, end: number, text: string }>}
 *   `start`/`end` are offsets into the original text, so a piece can be
 *   located in the source it came from.
 */
export function chunkText(text, options = {}) {
  const source = String(text ?? '');
  const size = Math.max(1, Math.floor(options.size ?? 4000));
  const strategy = options.strategy ?? 'size';
  if (source.length === 0) return [];

  if (strategy === 'size') {
    const overlap = Math.max(0, Math.min(Math.floor(options.overlap ?? 0), size - 1));
    /** @type {Array<{ index: number, start: number, end: number, text: string }>} */
    const pieces = [];
    const step = size - overlap;
    for (let start = 0; start < source.length; start += step) {
      const end = Math.min(source.length, start + size);
      pieces.push({ index: pieces.length, start, end, text: source.slice(start, end) });
      if (end === source.length) break;
    }
    return pieces;
  }

  // line and separator differ only in what a unit is and what joins two
  // of them back together — one grouping loop, two vocabularies
  const separator = strategy === 'line' ? '\n' : (options.separator ?? '\n\n');
  return groupUnits(source, separator, size);
}

/**
 * Group separator-delimited units into pieces of at most `size`
 * characters, never splitting a unit. A unit longer than `size` is its
 * own piece and is reported oversized by its length rather than being
 * cut — the caller asked for units, and a cut unit is not one.
 * @param {string} source
 * @param {string} separator
 * @param {number} size
 */
function groupUnits(source, separator, size) {
  /** @type {Array<{ index: number, start: number, end: number, text: string }>} */
  const pieces = [];
  const step = separator.length;
  let start = 0;
  let cursor = 0;
  while (cursor < source.length) {
    const found = source.indexOf(separator, cursor);
    const unitEnd = found === -1 ? source.length : found + step;
    // close the current piece when this unit would overflow it, unless
    // the piece is still empty (which is the oversized-unit case)
    if (unitEnd - start > size && cursor > start) {
      pieces.push({ index: pieces.length, start, end: cursor, text: source.slice(start, cursor) });
      start = cursor;
    }
    cursor = unitEnd;
  }
  if (cursor > start) {
    pieces.push({ index: pieces.length, start, end: cursor, text: source.slice(start, cursor) });
  }
  return pieces;
}
