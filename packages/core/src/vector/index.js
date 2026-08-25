//@ts-check

//#region @jarenjs/core/vector
// The suite's one home for n-dimensional vector arithmetic: the kernels
// an embedding is compared, normalized and stored with. There is no
// vector type. A vector is a plain array of finite numbers — `number[]`
// straight out of JSON, or a `Float32Array` straight out of a packed
// column — the convention the spatial kernel keeps for GeoJSON
// positions, and for the same reason: an embedding travels through a
// ledger record, a jsonb document and a wire reply, and a wrapper class
// survives none of those boundaries.
//
// Three rules every function here keeps, so that every caller — a
// ranked recall, a query operator, a store's fetch-and-rank plan — can
// rely on them without checking again:
//
//   higher is better    every similarity answers in the same direction:
//                       cosine in [-1, 1], the dot product unbounded,
//                       Euclidean as 1 / (1 + distance) in (0, 1] — so
//                       one descending sort ranks any of them
//   malformed scores 0  a comparison over mismatched lengths, an empty
//                       vector, a null, or a non-finite component answers
//                       0 and never throws: one bad vector among ten
//                       thousand loses the comparison, it does not kill
//                       the sweep, and it never poisons a ranking with NaN
//   refuse, never fix   the constructors — `packVector`, `l2Normalize` —
//                       answer null for anything `isVector` refuses, the
//                       way a bounding box refuses a position it cannot
//                       bound; nothing here truncates, pads or zero-fills
//                       a vector into the shape it was supposed to have
//
// `isVector` is the one definition of "a vector" the ledger, the query
// operators and the store share, so they refuse the same inputs. The
// comparison kernels do not re-check components (that is the gate's
// job, once, at the boundary); they guarantee a finite answer.
//
// The packed form is little-endian IEEE 754 binary32, 4·d bytes for d
// dimensions — the bytes a database column stores. Unpacking an aligned
// buffer on a little-endian host is a view, not a copy, which is what
// makes ranking over a fetched column fast; a misaligned buffer (a slice
// of a pooled allocation, an offset into a larger record) or a
// big-endian host takes the copy path. Alignment is an observation about
// one driver on one day, not a contract any driver signed.

/**
 * A vector as this module accepts it: plain numbers, in a plain array or
 * a float typed array. Never a class.
 * @typedef {number[] | Float32Array | Float64Array} Vector
 */

/** Whether this host stores a Float32 in the packed (little-endian) byte order. */
const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/**
 * Whether `v` is a vector: a non-empty `Array`, `Float32Array` or
 * `Float64Array` whose every component is a finite number — and, when
 * `dims` is given, exactly that many of them. The one shape guard the
 * suite shares, so a ledger, an operator and a store refuse the same
 * inputs.
 * @param {unknown} v
 * @param {number} [dims] - the exact length required
 * @returns {v is Vector}
 * @example
 * isVector([0.1, 0.2, 0.3]);        // true
 * isVector([0.1, 0.2, 0.3], 4);     // false — wrong width
 * isVector([0.1, NaN]);             // false — not finite
 * isVector(new Uint8Array(4));      // false — bytes are not a vector; unpack them first
 */
export function isVector(v, dims) {
  if (!(Array.isArray(v) || v instanceof Float32Array || v instanceof Float64Array))
    return false;
  const n = v.length;
  if (n === 0 || (dims !== undefined && n !== dims))
    return false;
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(v[i]))
      return false;
  }
  return true;
}

/**
 * The dot product. Unbounded; equal to the cosine for unit vectors, so
 * a sweep over l2-normalized vectors can take this cheaper form.
 * @param {Vector | null | undefined} a
 * @param {Vector | null | undefined} b
 * @returns {number} the product — or 0 for a malformed pair (mismatched
 *   lengths, empty, null, or a result that is not finite)
 */
export function dotProduct(a, b) {
  if (a == null || b == null)
    return 0;
  const n = a.length;
  if (n === 0 || n !== b.length)
    return 0;
  let sum = 0;
  for (let i = 0; i < n; i++)
    sum += a[i] * b[i];
  return Number.isFinite(sum) ? sum : 0;
}

/**
 * Cosine similarity, in [-1, 1]: 1 for the same direction, 0 for
 * orthogonal, -1 for opposite. The one metric the suite ranks by —
 * scale-free, so vectors from a model that does not normalize compare
 * the same as vectors from one that does.
 * @param {Vector | null | undefined} a
 * @param {Vector | null | undefined} b
 * @returns {number} the similarity — or 0 for a malformed pair, and 0
 *   when either vector has no direction (all zeros)
 * @example
 * cosineSimilarity([1, 0], [1, 0]);   // 1
 * cosineSimilarity([1, 0], [0, 1]);   // 0
 * cosineSimilarity([1, 0], [-2, 0]);  // -1
 * cosineSimilarity([1, 0], [1]);      // 0 — mismatched, never a throw
 */
export function cosineSimilarity(a, b) {
  if (a == null || b == null)
    return 0;
  const n = a.length;
  if (n === 0 || n !== b.length)
    return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i];
    const y = b[i];
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  // the two roots separately: their product can overflow where neither does
  const denominator = Math.sqrt(na) * Math.sqrt(nb);
  if (!(denominator > 0) || !Number.isFinite(denominator) || !Number.isFinite(dot))
    return 0;
  const r = dot / denominator;
  // rounding can land a hair outside the interval; the contract is [-1, 1]
  return r > 1 ? 1 : r < -1 ? -1 : r;
}

/**
 * Euclidean similarity, `1 / (1 + distance)`, in (0, 1]: 1 for equal
 * vectors, falling towards 0 as they move apart. The distance turned
 * into the same higher-is-better direction as the other kernels, so a
 * caller never has to remember which way a metric sorts.
 * @param {Vector | null | undefined} a
 * @param {Vector | null | undefined} b
 * @returns {number} the similarity — or 0 for a malformed pair
 */
export function euclideanSimilarity(a, b) {
  if (a == null || b == null)
    return 0;
  const n = a.length;
  if (n === 0 || n !== b.length)
    return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Number.isFinite(sum) ? 1 / (1 + Math.sqrt(sum)) : 0;
}

/**
 * The unit vector in `a`'s direction, as a new `Float32Array` — the
 * form the packed column stores, so that cosine, dot and Euclidean
 * then agree in rank. The input is never modified.
 * @param {Vector | null | undefined} a
 * @returns {Float32Array | null} the normalized copy; the zero vector
 *   stays zero (it has no direction, and scores 0 against everything);
 *   null for anything `isVector` refuses, or a norm that overflows
 */
export function l2Normalize(a) {
  if (!isVector(a))
    return null;
  const n = a.length;
  let sum = 0;
  for (let i = 0; i < n; i++)
    sum += a[i] * a[i];
  if (!Number.isFinite(sum))
    return null;
  const out = new Float32Array(n);
  if (sum === 0)
    return out;
  const norm = Math.sqrt(sum);
  for (let i = 0; i < n; i++)
    out[i] = a[i] / norm;
  return out;
}

/**
 * The packed form: `4·d` bytes of little-endian binary32, the value a
 * database column stores. Components round to their nearest binary32
 * (`Math.fround`); `unpackVector` returns exactly those.
 * @param {Vector | null | undefined} a
 * @returns {Uint8Array | null} the bytes — null for anything `isVector`
 *   refuses (empty, non-finite), never a partial or zero-filled record
 * @example
 * packVector([1]);                 // Uint8Array [0, 0, 128, 63]
 * packVector([1, NaN]);            // null
 */
export function packVector(a) {
  if (!isVector(a))
    return null;
  const n = a.length;
  const bytes = new Uint8Array(n * 4);
  if (LITTLE_ENDIAN) {
    // a fresh buffer is aligned, and the host's byte order is the packed one
    new Float32Array(bytes.buffer).set(a);
  }
  else {
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < n; i++)
      view.setFloat32(i * 4, a[i], true);
  }
  return bytes;
}

/**
 * The vector packed in `bytes`, read as `dims` little-endian binary32
 * components. The width is the caller's to state — a column declares
 * it — and bytes of any other length are refused rather than partially
 * read.
 *
 * On a little-endian host, 4-byte-aligned bytes come back as a VIEW over
 * the same buffer — no copy, which is what a sweep over ten thousand
 * fetched rows is paid for by; writing into the result writes into the
 * bytes. Misaligned bytes (a pooled `Buffer`, a slice at an odd offset)
 * and big-endian hosts take the copy path and answer the same values.
 * @param {Uint8Array | null | undefined} bytes
 * @param {number} dims - the width the bytes must hold
 * @returns {Float32Array | null} the vector — null when `bytes` is not a
 *   `Uint8Array` of exactly `4·dims` bytes
 */
export function unpackVector(bytes, dims) {
  if (!(bytes instanceof Uint8Array) || !Number.isInteger(dims) || dims < 1
    || bytes.byteLength !== dims * 4)
    return null;
  if (LITTLE_ENDIAN && bytes.byteOffset % 4 === 0)
    return new Float32Array(bytes.buffer, bytes.byteOffset, dims);
  const out = new Float32Array(dims);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < dims; i++)
    out[i] = view.getFloat32(i * 4, true);
  return out;
}

//#endregion
