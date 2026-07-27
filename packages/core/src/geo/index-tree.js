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
 * @param {number} x - 0..65535
 * @param {number} y - 0..65535
 * @returns {number}
 */
export function hilbertDistance(x, y) {
  let rx;
  let ry;
  let d = 0;
  let a = x;
  let b = y;
  for (let s = 32768; s > 0; s = Math.floor(s / 2)) {
    rx = (a & s) > 0 ? 1 : 0;
    ry = (b & s) > 0 ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);
    // rotate the quadrant so the curve stays continuous
    if (ry === 0) {
      if (rx === 1) {
        a = s - 1 - a;
        b = s - 1 - b;
      }
      const t = a;
      a = b;
      b = t;
    }
  }
  return d;
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
      if (box[0] < minX) minX = box[0];
      if (box[1] < minY) minY = box[1];
      if (box[2] > maxX) maxX = box[2];
      if (box[3] > maxY) maxY = box[3];
    }
    indices[i] = i;
  }

  // sort the leaves along the Hilbert curve of their centres
  if (count > 1 && Number.isFinite(minX)) {
    const width = maxX - minX || 1;
    const height = maxY - minY || 1;
    const hilbert = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      const p = i * 4;
      if (!Number.isFinite(bounds[p])) {
        hilbert[i] = Number.MAX_SAFE_INTEGER; // empties sort to the end
        continue;
      }
      const cx = Math.floor(65535 * ((bounds[p] + bounds[p + 2]) / 2 - minX) / width);
      const cy = Math.floor(65535 * ((bounds[p + 1] + bounds[p + 3]) / 2 - minY) / height);
      hilbert[i] = hilbertDistance(cx, cy);
    }
    sortLeaves(hilbert, bounds, indices, 0, count - 1);
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

// In-place quicksort of the leaf arrays by Hilbert distance, moving the
// bounds and the original indexes with the keys.
function sortLeaves(hilbert, bounds, indices, left, right) {
  if (left >= right)
    return;
  const pivot = hilbert[(left + right) >> 1];
  let i = left - 1;
  let j = right + 1;
  for (;;) {
    do i++; while (hilbert[i] < pivot);
    do j--; while (hilbert[j] > pivot);
    if (i >= j)
      break;
    swapLeaf(hilbert, bounds, indices, i, j);
  }
  sortLeaves(hilbert, bounds, indices, left, j);
  sortLeaves(hilbert, bounds, indices, j + 1, right);
}

function swapLeaf(hilbert, bounds, indices, i, j) {
  const h = hilbert[i];
  hilbert[i] = hilbert[j];
  hilbert[j] = h;
  const n = indices[i];
  indices[i] = indices[j];
  indices[j] = n;
  const pi = i * 4;
  const pj = j * 4;
  for (let k = 0; k < 4; k++) {
    const t = bounds[pi + k];
    bounds[pi + k] = bounds[pj + k];
    bounds[pj + k] = t;
  }
}

//#endregion
