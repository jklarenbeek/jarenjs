//@ts-check

//#region Static bounding-box index
// A packed Hilbert R-tree over bounding boxes: build once, query many.
// Scanning n boxes to find the ones overlapping a query box is O(n); this
// is O(log n + k) for k hits, which is the difference between a spatial
// join being usable and not.
//
// **Static** is the deliberate part. A dynamic R-tree must keep its nodes
// splittable, which costs both memory and insert time; a compiled query's
// geometry never changes after the index is built, so the tree can be
// packed into flat typed arrays with no per-node objects at all. The
// tree is therefore built bottom-up: leaves are sorted along a Hilbert
// curve — which keeps boxes that are near each other in space near each
// other in the array — and then every `nodeSize` consecutive entries
// become a parent.
//
// The query returns **candidates**, not answers. Box overlap is a
// necessary condition for containment and for real intersection, never a
// sufficient one, so a caller confirms each candidate with the exact
// predicate. That is what makes indexing safe to apply automatically:
// the index can only ever remove work, never change a result.

/** Children per node. 16 is the usual sweet spot for cache behaviour. */
const DEFAULT_NODE_SIZE = 16;

/**
 * Interleave the low 16 bits of x and y into a Hilbert distance.
 * Boxes ordered by this stay spatially clustered, which is what makes
 * the packed parents tight.
 *
 * Bit-parallel: all sixteen levels of the per-bit quadrant rotation run
 * at once as mask arithmetic (the public-domain transform from
 * rawrunprotected/hilbert_curves), which is what makes computing 100k of
 * these a millisecond instead of the build's dominant cost. The values
 * are identical to the classical per-bit walk of the curve.
 *
 * @param {number} x - 0..65535
 * @param {number} y - 0..65535
 * @returns {number}
 */
export function hilbertDistance(x, y) {
  let a = x ^ y;
  let b = 0xFFFF ^ a;
  let c = 0xFFFF ^ (x | y);
  let d = x & (y ^ 0xFFFF);
  let A = a | (b >> 1);
  let B = (a >> 1) ^ a;
  let C = ((c >> 1) ^ (b & (d >> 1))) ^ c;
  let D = ((a & (c >> 1)) ^ (d >> 1)) ^ d;

  a = A; b = B; c = C; d = D;
  A = (a & (a >> 2)) ^ (b & (b >> 2));
  B = (a & (b >> 2)) ^ (b & ((a ^ b) >> 2));
  C ^= (a & (c >> 2)) ^ (b & (d >> 2));
  D ^= (b & (c >> 2)) ^ ((a ^ b) & (d >> 2));

  a = A; b = B; c = C; d = D;
  A = (a & (a >> 4)) ^ (b & (b >> 4));
  B = (a & (b >> 4)) ^ (b & ((a ^ b) >> 4));
  C ^= (a & (c >> 4)) ^ (b & (d >> 4));
  D ^= (b & (c >> 4)) ^ ((a ^ b) & (d >> 4));

  a = A; b = B; c = C; d = D;
  C ^= (a & (c >> 8)) ^ (b & (d >> 8));
  D ^= (b & (c >> 8)) ^ ((a ^ b) & (d >> 8));

  a = C ^ (C >> 1);
  b = D ^ (D >> 1);

  let i0 = x ^ y;
  let i1 = b | (0xFFFF ^ (i0 | a));

  i0 = (i0 | (i0 << 8)) & 0x00FF00FF;
  i0 = (i0 | (i0 << 4)) & 0x0F0F0F0F;
  i0 = (i0 | (i0 << 2)) & 0x33333333;
  i0 = (i0 | (i0 << 1)) & 0x55555555;

  i1 = (i1 | (i1 << 8)) & 0x00FF00FF;
  i1 = (i1 | (i1 << 4)) & 0x0F0F0F0F;
  i1 = (i1 | (i1 << 2)) & 0x33333333;
  i1 = (i1 | (i1 << 1)) & 0x55555555;

  return ((i1 << 1) | i0) >>> 0;
}

/**
 * A queryable static index over bounding boxes.
 * @typedef {Object} BboxIndex
 * @property {number} size - how many boxes were indexed
 * @property {(minX: number, minY: number, maxX: number, maxY: number) => number[]} search
 *   the indexes of every box whose bounds overlap the query box
 */

/**
 * Build a static index over `[west, south, east, north]` boxes.
 *
 * The returned `search` yields **candidate** indexes into the original
 * array: every box that truly overlaps is included, and boxes that merely
 * share a tree node may be too. Confirm each with the exact test.
 *
 * A null entry (a value with no positions, so no box) is indexed as a
 * degenerate box that overlaps nothing, so it can never be a candidate
 * while the array indexes stay aligned with the caller's data.
 *
 * @param {Array<number[] | null>} boxes
 * @param {number} [nodeSize] - children per node
 * @returns {BboxIndex}
 * @example
 * const index = createBboxIndex(regions.map(bboxOf));
 * for (const i of index.search(...bboxOf(point))) confirm(regions[i]);
 */
export function createBboxIndex(boxes, nodeSize = DEFAULT_NODE_SIZE) {
  const count = boxes.length;
  if (count === 0)
    return { size: 0, search: () => [] };

  const size = Math.max(2, Math.min(nodeSize | 0, 65535));

  // level 0 is the leaves; each level packs the previous one
  const levelBounds = [];
  let n = count;
  let total = n;
  levelBounds.push(n * 4);
  do {
    n = Math.ceil(n / size);
    total += n;
    levelBounds.push(total * 4);
  } while (n !== 1);

  const bounds = new Float64Array(total * 4);
  const indices = new Uint32Array(total);

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < count; i++) {
    const box = boxes[i];
    if (box === null || box === undefined)
      continue;
    if (box[0] < minX) minX = box[0];
    if (box[1] < minY) minY = box[1];
    if (box[2] > maxX) maxX = box[2];
    if (box[3] > maxY) maxY = box[3];
  }

  // Sort a permutation along the Hilbert curve of the box centres, then
  // write the bounds once, already in leaf order. The sort itself moves
  // only a key and an index per swap — permuting the four-wide bounds
  // rows through every partition swap is what made the build memory-bound.
  const order = new Uint32Array(count);
  for (let i = 0; i < count; i++)
    order[i] = i;
  if (count > 1 && Number.isFinite(minX)) {
    const width = maxX - minX || 1;
    const height = maxY - minY || 1;
    const hilbert = new Uint32Array(count);
    for (let i = 0; i < count; i++) {
      const box = boxes[i];
      if (box === null || box === undefined) {
        // empties sort to the end (a real box may share this key, which
        // is harmless: an empty's bounds can never match a query)
        hilbert[i] = 0xFFFFFFFF;
        continue;
      }
      const cx = Math.floor(65535 * ((box[0] + box[2]) / 2 - minX) / width);
      const cy = Math.floor(65535 * ((box[1] + box[3]) / 2 - minY) / height);
      hilbert[i] = hilbertDistance(cx, cy);
    }
    sortOrder(hilbert, order, 0, count - 1);
  }

  for (let i = 0; i < count; i++) {
    const at = order[i];
    const box = boxes[at];
    const p = i * 4;
    if (box === null || box === undefined) {
      // a box that overlaps nothing: min above max on both axes
      bounds[p] = Infinity;
      bounds[p + 1] = Infinity;
      bounds[p + 2] = -Infinity;
      bounds[p + 3] = -Infinity;
    }
    else {
      bounds[p] = box[0];
      bounds[p + 1] = box[1];
      bounds[p + 2] = box[2];
      bounds[p + 3] = box[3];
    }
    indices[i] = at;
  }

  // pack each level into the next
  let readAt = 0;
  for (let level = 0; level < levelBounds.length - 1; level++) {
    const levelEnd = levelBounds[level] / 4;
    let writeAt = levelEnd;
    while (readAt < levelEnd) {
      const nodeStart = readAt;
      let nodeMinX = Infinity;
      let nodeMinY = Infinity;
      let nodeMaxX = -Infinity;
      let nodeMaxY = -Infinity;
      for (let i = 0; i < size && readAt < levelEnd; i++, readAt++) {
        const p = readAt * 4;
        if (bounds[p] < nodeMinX) nodeMinX = bounds[p];
        if (bounds[p + 1] < nodeMinY) nodeMinY = bounds[p + 1];
        if (bounds[p + 2] > nodeMaxX) nodeMaxX = bounds[p + 2];
        if (bounds[p + 3] > nodeMaxY) nodeMaxY = bounds[p + 3];
      }
      // a parent records where its children start, not a data index
      indices[writeAt] = nodeStart;
      const q = writeAt * 4;
      bounds[q] = nodeMinX;
      bounds[q + 1] = nodeMinY;
      bounds[q + 2] = nodeMaxX;
      bounds[q + 3] = nodeMaxY;
      writeAt++;
    }
  }

  const rootStart = total - 1;

  return {
    size: count,
    search(qMinX, qMinY, qMaxX, qMaxY) {
      const out = [];
      // an explicit stack of [nodeIndex, levelEnd] rather than recursion
      const stack = [rootStart, levelBounds.length - 1];
      while (stack.length > 0) {
        const level = stack.pop();
        const nodeIndex = stack.pop();
        const isLeafLevel = level === 0;
        const end = Math.min(
          nodeIndex + size,
          levelBounds[level] / 4);
        for (let pos = nodeIndex; pos < end; pos++) {
          const p = pos * 4;
          if (qMaxX < bounds[p] || qMaxY < bounds[p + 1]
            || qMinX > bounds[p + 2] || qMinY > bounds[p + 3])
            continue;
          if (isLeafLevel)
            out.push(indices[pos]);
          else {
            stack.push(indices[pos]);
            stack.push(level - 1);
          }
        }
      }
      return out;
    },
  };
}

// In-place quicksort of the permutation by Hilbert distance: each swap
// moves one key and one index, nothing wider. Small partitions finish
// by insertion sort, which beats partitioning once a run fits in cache.
function sortOrder(hilbert, order, left, right) {
  if (right - left < 20) {
    for (let i = left + 1; i <= right; i++) {
      const h = hilbert[i];
      const n = order[i];
      let j = i - 1;
      while (j >= left && hilbert[j] > h) {
        hilbert[j + 1] = hilbert[j];
        order[j + 1] = order[j];
        j--;
      }
      hilbert[j + 1] = h;
      order[j + 1] = n;
    }
    return;
  }
  const pivot = hilbert[(left + right) >> 1];
  let i = left - 1;
  let j = right + 1;
  for (;;) {
    do i++; while (hilbert[i] < pivot);
    do j--; while (hilbert[j] > pivot);
    if (i >= j)
      break;
    const h = hilbert[i];
    hilbert[i] = hilbert[j];
    hilbert[j] = h;
    const n = order[i];
    order[i] = order[j];
    order[j] = n;
  }
  sortOrder(hilbert, order, left, j);
  sortOrder(hilbert, order, j + 1, right);
}

//#endregion
