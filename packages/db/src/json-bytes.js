//@ts-check
/** JSON byte accounting over decoded data, without allocating encoded text. */

/** UTF-8 bytes of a JSON string, including quotes and well-formed escapes.
 * @param {string} value @returns {number}
 */
export function jsonStringBytes(value) {
  let bytes = 2;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 34 || code === 92 || code === 8 || code === 9
      || code === 10 || code === 12 || code === 13) bytes += 2;
    else if (code < 32) bytes += 6;
    else if (code < 128) bytes++;
    else if (code < 2048) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdfff) {
      const next = value.charCodeAt(i + 1);
      if (code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) { bytes += 4; i++; }
      else bytes += 6;
    }
    else bytes += 3;
  }
  return bytes;
}

/** The JSON serialization size of decoded JSON data. Objects are memoized
 * during decoding, so a nested include reads its size without another walk.
 * @param {any} value @param {WeakMap<object, number>} [sizes]
 * @returns {number}
 */
export function jsonBytes(value, sizes = new WeakMap()) {
  if (value === null) return 4;
  if (typeof value === 'string') return jsonStringBytes(value);
  if (typeof value === 'boolean') return value ? 4 : 5;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value).length : 4;
  if (typeof value !== 'object') throw new TypeError('byte accounting requires decoded JSON data');
  const cached = sizes.get(value);
  if (cached !== undefined) return cached;
  const keys = Object.keys(value);
  let bytes = 2 + Math.max(0, keys.length - 1);
  const array = Array.isArray(value);
  for (const key of keys) bytes += (array ? 0 : jsonStringBytes(key) + 1) + jsonBytes(value[key], sizes);
  sizes.set(value, bytes);
  return bytes;
}

/** Decode and account bottom-up in the decoder's construction traversal.
 * The caller checks the incoming text bound before decoding and checks the
 * recorded nested bounds before attaching any reconstructed children.
 * @param {string} text @param {WeakMap<object, number>} sizes
 * @returns {any}
 */
export function decodeCountedJson(text, sizes) {
  return JSON.parse(text, (_key, value) => {
    if (value !== null && typeof value === 'object') jsonBytes(value, sizes);
    return value;
  });
}
