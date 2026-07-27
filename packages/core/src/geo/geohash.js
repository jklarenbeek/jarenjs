//@ts-check

//#region Geohash
// A geohash is a base-32 string over the bits of a recursive
// longitude/latitude bisection: each character adds five bits, so each
// character is a finer cell, and a shared prefix means a shared cell.
//
// That last property is why this belongs in the suite rather than in a
// spatial library. A geohash is a **string**, so it needs no new
// vocabulary anywhere: proximity is `$starts-with`, spatial bucketing is
// `$groupby` on a `$substring` prefix, and a sorted index over the hash
// is a spatial index. Nothing else in this module family integrates so
// cheaply.
//
// The trade is that cells are rectangles in degree space, so they are
// not equal-area — a cell at 60°N is about half the width of one at the
// equator — and neighbouring points can land either side of a cell
// boundary. Use it for bucketing and for a first pass, not as a distance.

const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';

// reverse lookup, built once
const DECODE = new Map();
for (let i = 0; i < BASE32.length; i++)
  DECODE.set(BASE32[i], i);

/**
 * Approximate cell size in degrees per precision, as
 * `[lonWidth, latHeight]`. Index 0 is unused so the array indexes by
 * precision directly.
 */
const CELL_SIZE = (() => {
  const out = [null];
  for (let p = 1; p <= 12; p++) {
    // five bits per character, alternating and starting on longitude, so
    // an odd precision gives longitude the extra bit
    const lonBits = Math.ceil((p * 5) / 2);
    const latBits = Math.floor((p * 5) / 2);
    out.push([360 / (2 ** lonBits), 180 / (2 ** latBits)]);
  }
  return out;
})();

/**
 * Encode a position as a geohash string.
 *
 * @param {number} lon - longitude, degrees
 * @param {number} lat - latitude, degrees
 * @param {number} [precision] - characters, 1-12 (default 9, about 5 m)
 * @returns {string}
 * @example
 * geohashEncode(4.9041, 52.3676, 5); // 'u173z' (Amsterdam)
 */
export function geohashEncode(lon, lat, precision = 9) {
  let lonMin = -180;
  let lonMax = 180;
  let latMin = -90;
  let latMax = 90;
  let hash = '';
  let bits = 0;
  let ch = 0;
  let evenBit = true; // longitude first
  while (hash.length < precision) {
    if (evenBit) {
      const mid = (lonMin + lonMax) / 2;
      if (lon >= mid) {
        ch = ch * 2 + 1;
        lonMin = mid;
      }
      else {
        ch *= 2;
        lonMax = mid;
      }
    }
    else {
      const mid = (latMin + latMax) / 2;
      if (lat >= mid) {
        ch = ch * 2 + 1;
        latMin = mid;
      }
      else {
        ch *= 2;
        latMax = mid;
      }
    }
    evenBit = !evenBit;
    if (++bits === 5) {
      hash += BASE32[ch];
      bits = 0;
      ch = 0;
    }
  }
  return hash;
}

/**
 * Whether a string is a well-formed geohash: non-empty and every
 * character in the base-32 alphabet (lowercase; `a`, `i`, `l` and `o`
 * are deliberately absent from it). Any length is valid — each
 * character only names a finer cell.
 * @param {string} hash
 * @returns {boolean}
 * @example
 * isValidGeohash('u173z'); // true (Amsterdam)
 * isValidGeohash('u17a');  // false ('a' is not in the alphabet)
 */
export function isValidGeohash(hash) {
  if (typeof hash !== 'string' || hash.length === 0)
    return false;
  for (let i = 0; i < hash.length; i++) {
    if (!DECODE.has(hash[i]))
      return false;
  }
  return true;
}

/**
 * The bounding box of a geohash cell, as `[west, south, east, north]`.
 * Returns null for a string containing a character outside the base-32
 * alphabet (`a`, `i`, `l` and `o` are deliberately absent).
 * @param {string} hash
 * @returns {number[] | null}
 */
export function geohashBounds(hash) {
  if (typeof hash !== 'string' || hash.length === 0)
    return null;
  let lonMin = -180;
  let lonMax = 180;
  let latMin = -90;
  let latMax = 90;
  let evenBit = true;
  for (let i = 0; i < hash.length; i++) {
    const value = DECODE.get(hash[i]);
    if (value === undefined)
      return null;
    for (let n = 4; n >= 0; n--) {
      const bit = (value >> n) & 1;
      if (evenBit) {
        const mid = (lonMin + lonMax) / 2;
        if (bit === 1) lonMin = mid;
        else lonMax = mid;
      }
      else {
        const mid = (latMin + latMax) / 2;
        if (bit === 1) latMin = mid;
        else latMax = mid;
      }
      evenBit = !evenBit;
    }
  }
  return [lonMin, latMin, lonMax, latMax];
}

/**
 * The centre of a geohash cell, as a GeoJSON position. Null for an
 * invalid hash.
 *
 * Decoding is lossy by construction — a hash names a cell, not a point —
 * so this is the cell's centre and the error is bounded by
 * {@link geohashCellSize}.
 *
 * @param {string} hash
 * @returns {[number, number] | null}
 */
export function geohashDecode(hash) {
  const box = geohashBounds(hash);
  if (box === null)
    return null;
  return [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];
}

/**
 * Approximate cell size at a precision, as `[lonWidth, latHeight]` in
 * degrees. Null outside 1-12.
 * @param {number} precision
 * @returns {number[] | null}
 */
export function geohashCellSize(precision) {
  return CELL_SIZE[precision] ?? null;
}

/**
 * The eight geohash cells surrounding one, plus the cell itself, as a
 * nine-element array. Cells that would fall off the poles are omitted,
 * so the result may be shorter.
 *
 * This is what makes a prefix search safe near a boundary: two points
 * metres apart can sit in different cells, so a proximity query tests
 * the neighbourhood rather than the single cell.
 *
 * @param {string} hash
 * @returns {string[]}
 */
export function geohashNeighbours(hash) {
  const box = geohashBounds(hash);
  if (box === null)
    return [];
  const precision = hash.length;
  const lonStep = box[2] - box[0];
  const latStep = box[3] - box[1];
  const lon = (box[0] + box[2]) / 2;
  const lat = (box[1] + box[3]) / 2;
  const out = [];
  const seen = new Set();
  for (let dy = 1; dy >= -1; dy--) {
    for (let dx = -1; dx <= 1; dx++) {
      const ny = lat + dy * latStep;
      if (ny > 90 || ny < -90)
        continue; // past a pole there is no neighbouring cell
      // longitude wraps at the antimeridian
      let nx = lon + dx * lonStep;
      if (nx > 180) nx -= 360;
      else if (nx < -180) nx += 360;
      const cell = geohashEncode(nx, ny, precision);
      if (!seen.has(cell)) {
        seen.add(cell);
        out.push(cell);
      }
    }
  }
  return out;
}

//#endregion
