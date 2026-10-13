//@ts-check
/**
 * @file The compression behind a share token: an LZW coder over bytes whose
 * output is written in the base64url alphabet, six bits to a character, so
 * the compressed text stays safe in a URL fragment and needs nothing outside
 * the language.
 *
 * Stream layout. Codes are written most significant bit first, each as wide
 * as the largest code the reader can know at that point, so the first codes
 * are a few bits wide and the width grows with the dictionary. Code 0 is an
 * escape that introduces a byte (8 bits) never seen before in the stream and
 * gives it a code of its own, which is how the dictionary starts empty and a
 * short input pays nothing for letters it does not contain; code 1 ends the
 * stream. Every later code names a phrase: a first-seen byte, or an earlier
 * phrase plus the byte that followed it. The last character is zero-padded
 * to six bits.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Character code → 6-bit value (-1 outside the alphabet). */
const VALUE_OF = new Int8Array(128).fill(-1);
for (let i = 0; i < 64; i++) VALUE_OF[ALPHABET.charCodeAt(i)] = i;

const ESCAPE = 0;
const END = 1;

/**
 * The most bytes a stream may expand to. LZW grows a phrase by one byte per
 * code, so a short hostile stream names a very long output (a link of a few
 * thousand characters can name megabytes); the bound is checked before each
 * phrase is written, so the output buffer and everything built from it stay
 * under it. A share snapshot is a few kilobytes of JSON, so a megabyte leaves
 * orders of magnitude of headroom while a hostile link costs little.
 */
export const MAX_EXPANDED_BYTES = 1 << 20;

/** Bits a reader needs to tell `size` codes apart. */
const widthFor = (size) => 32 - Math.clz32(size - 1);

/**
 * Compress bytes to base64url text.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function compressBytes(bytes) {
  let out = '';
  let acc = 0;
  let held = 0;
  /** @param {number} value @param {number} width */
  const put = (value, width) => {
    for (let bit = width - 1; bit >= 0; bit--) {
      acc = acc * 2 + ((value >>> bit) & 1);
      if (++held === 6) {
        out += ALPHABET[acc];
        acc = 0;
        held = 0;
      }
    }
  };
  /** Code of a byte already seen on its own, or -1. */
  const singles = new Int32Array(256).fill(-1);
  /** `phrase * 256 + byte` → the code of that phrase extended by that byte. */
  const extended = new Map();
  let next = 2;
  let i = 0;
  while (i < bytes.length) {
    const byte = bytes[i++];
    let phrase = singles[byte];
    if (phrase < 0) {
      put(ESCAPE, widthFor(next));
      put(byte, 8);
      phrase = singles[byte] = next++;
    }
    else {
      while (i < bytes.length) {
        const longer = extended.get(phrase * 256 + bytes[i]);
        if (longer === undefined) break;
        phrase = longer;
        i++;
      }
      put(phrase, widthFor(next));
    }
    if (i < bytes.length) extended.set(phrase * 256 + bytes[i], next++);
  }
  // The reader has reserved the slot of the phrase this stream did not extend.
  put(END, widthFor(next + (bytes.length === 0 ? 0 : 1)));
  if (held > 0) put(0, 6 - held);
  return out;
}

/**
 * Expand text written by `compressBytes`.
 * @param {string} text
 * @returns {Uint8Array | null} the bytes, or `null` when the text is not a
 *   complete stream or would expand past `MAX_EXPANDED_BYTES`
 */
export function decompressBytes(text) {
  const totalBits = text.length * 6;
  let position = 0;
  /** @param {number} width @returns {number} -1 when the text ends or leaves the alphabet first */
  const take = (width) => {
    let value = 0;
    for (let n = 0; n < width; n++, position++) {
      // past the end the code is NaN, outside ASCII it is out of range: both read as undefined
      const six = VALUE_OF[text.charCodeAt((position / 6) | 0)] ?? -1;
      if (six < 0) return -1;
      value = value * 2 + ((six >> (5 - (position % 6))) & 1);
    }
    return value;
  };
  // Per code (from 2): the phrase it extends (-1 for a lone byte), its last
  // byte, its first byte and its length.
  const parent = [-1, -1];
  const last = [0, 0];
  const first = [0, 0];
  const length = [0, 0];
  let bytes = new Uint8Array(256);
  let size = 0;
  let previous = -1;
  for (;;) {
    const code = take(widthFor(parent.length + (previous < 0 ? 0 : 1)));
    if (code < 0) return null;
    if (code === END) break;
    let phrase;
    if (code === ESCAPE) {
      const byte = take(8);
      if (byte < 0) return null;
      if (previous >= 0) {
        parent.push(previous); last.push(byte); first.push(first[previous]); length.push(length[previous] + 1);
      }
      phrase = parent.length;
      parent.push(-1); last.push(byte); first.push(byte); length.push(1);
    }
    else {
      // the slot this code names must exist, or be the one the previous phrase is about to take
      if (code > parent.length) return null;
      if (previous >= 0) {
        const byte = code === parent.length ? first[previous] : first[code];
        parent.push(previous); last.push(byte); first.push(first[previous]); length.push(length[previous] + 1);
      }
      phrase = code;
    }
    const run = length[phrase];
    if (size + run > MAX_EXPANDED_BYTES) return null;
    if (size + run > bytes.length) {
      const grown = new Uint8Array(Math.max(bytes.length * 2, size + run));
      grown.set(bytes);
      bytes = grown;
    }
    for (let at = size + run - 1, c = phrase; at >= size; at--, c = parent[c]) bytes[at] = last[c];
    size += run;
    previous = phrase;
  }
  // Only the zero padding of the last character may follow the end code, so a
  // snapshot has one token.
  const padding = totalBits - position;
  if (padding >= 6 || take(padding) !== 0) return null;
  return bytes.subarray(0, size);
}
