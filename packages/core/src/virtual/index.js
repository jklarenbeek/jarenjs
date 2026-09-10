//@ts-check
/** DOM-free virtual geometry. Work and retained state depend on the viewport and credits. */

/** @param {number} value @param {string} name @param {number} [min] */
function integer(value, name, min = 0) {
  if (!Number.isSafeInteger(value) || value < min) throw new RangeError(`Invalid ${name}`);
  return value;
}

/** @param {number} value */
function positive(value) {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError('Invalid size');
  return value;
}

/** @param {number} value */
function nonnegative(value) { return Number.isFinite(value) ? Math.max(0, value) : 0; }

/**
 * A half-open fixed-size window, with no source access. Hidden viewports are empty.
 * @param {{count:number, size:number, viewport:number, offset?:number, overscan?:number}} options
 */
export function fixedRange({ count, size, viewport, offset = 0, overscan = 0 }) {
  integer(count, 'count'); positive(size); integer(overscan, 'overscan');
  const extent = count * size;
  if (!Number.isFinite(extent) || extent > Number.MAX_SAFE_INTEGER) throw new RangeError('Invalid extent');
  viewport = nonnegative(viewport);
  offset = Math.min(nonnegative(offset), Math.max(0, extent - viewport));
  if (!count || !viewport) return { start: 0, end: 0, offset, extent };
  return { start: Math.max(0, Math.floor(offset / size) - overscan),
    end: Math.min(count, Math.ceil((offset + viewport) / size) + overscan), offset, extent };
}

/**
 * Sparse measured axis. Only credited measurements are retained; evicted sizes become estimates.
 * Prefix summaries rebuild on measurement, never by enumerating logical items.
 * @param {{count:number, estimateSize:number, maxMeasurements?:number, maxBytes?:number}} options
 */
export function createVirtualAxis({ count, estimateSize, maxMeasurements = 256, maxBytes = 32768 }) {
  integer(count, 'count'); positive(estimateSize);
  integer(maxMeasurements, 'maxMeasurements'); integer(maxBytes, 'maxBytes');
  const entries = new Map();
  let sorted = [], prefix = [], bytes = 0, disposed = false;
  function rebuild() {
    sorted = [...entries.values()].sort((a, b) => a.index - b.index);
    let sum = 0;
    prefix = sorted.map((item) => (sum += item.size - estimateSize));
  }
  function position(index) {
    let low = 0, high = sorted.length;
    while (low < high) { const mid = Math.floor((low + high) / 2);
      if (sorted[mid].index < index) low = mid + 1; else high = mid; }
    return index * estimateSize + (low ? prefix[low - 1] : 0);
  }
  function size(index) {
    let low = 0, high = sorted.length;
    while (low < high) { const mid = Math.floor((low + high) / 2);
      if (sorted[mid].index < index) low = mid + 1; else high = mid; }
    return sorted[low]?.index === index ? sorted[low].size : estimateSize;
  }
  function indexAt(offset) {
    let low = 0, high = count;
    while (low < high) { const mid = Math.floor((low + high) / 2);
      if (position(mid + 1) <= offset) low = mid + 1; else high = mid; }
    return Math.min(low, Math.max(0, count - 1));
  }
  function remove(key) { bytes -= entries.get(key).bytes; entries.delete(key); }
  return {
    position, size, indexAt,
    extent() { return position(count); },
    range({ offset = 0, viewport = 0, overscan = 0 } = {}) {
      if (!sorted.length) return fixedRange({ count: disposed ? 0 : count, size: estimateSize, offset, viewport, overscan });
      integer(overscan, 'overscan'); viewport = nonnegative(viewport);
      const extent = position(count);
      offset = Math.min(nonnegative(offset), Math.max(0, extent - viewport));
      if (disposed || !count || !viewport) return { start: 0, end: 0, offset, extent };
      const first = indexAt(offset);
      let end = indexAt(offset + viewport);
      if (position(end) < offset + viewport) end++;
      return { start: Math.max(0, first - overscan), end: Math.min(count, end + overscan), offset, extent };
    },
    measure(index, key, value) {
      if (disposed) return { state: 'error', reason: 'disposed' };
      integer(index, 'index'); positive(value);
      if (index >= count || typeof key !== 'string') return { state: 'error', reason: 'invalid-measurement' };
      if (key.length > maxBytes) return { state: 'budget-exhausted', reason: 'measurement-credits' };
      const cost = new TextEncoder().encode(key).byteLength + 24;
      if (!maxMeasurements || cost > maxBytes) return { state: 'budget-exhausted', reason: 'measurement-credits' };
      if (entries.has(key)) remove(key);
      for (const [other, entry] of entries) if (entry.index === index) remove(other);
      while (entries.size >= maxMeasurements || bytes + cost > maxBytes) remove(entries.keys().next().value);
      entries.set(key, { index, size: value, bytes: cost }); bytes += cost; rebuild();
      return { state: 'ready' };
    },
    anchor(offset, keyAt, query = '') {
      if (!count) return null;
      const index = indexAt(nonnegative(offset));
      return { key: String(keyAt(index)), index, offset: nonnegative(offset) - position(index), query };
    },
    restore(anchor, indexOf, query = '') {
      if (!anchor || anchor.query !== query || !count) return { state: 'ready', offset: 0, fallback: true };
      const found = indexOf?.(anchor.key);
      const valid = Number.isSafeInteger(found) && found >= 0 && found < count;
      const index = valid ? found : Math.min(count - 1, Math.max(0, anchor.index));
      return { state: 'ready', offset: position(index) + Math.min(nonnegative(anchor.offset), size(index)), fallback: !valid };
    },
    update(next) {
      if (disposed) return;
      if (next.count !== undefined) count = integer(next.count, 'count');
      if (next.estimateSize !== undefined && next.estimateSize !== estimateSize) {
        estimateSize = positive(next.estimateSize); entries.clear(); bytes = 0;
      }
      const occupied = new Set();
      for (const [key, entry] of entries) {
        const index = next.indexOf ? next.indexOf(key) : entry.index;
        if (!Number.isSafeInteger(index) || index < 0 || index >= count || occupied.has(index)) remove(key);
        else { entry.index = index; occupied.add(index); }
      }
      rebuild();
    },
    clear() { entries.clear(); sorted = []; prefix = []; bytes = 0; },
    stats() { return { measurements: entries.size, bytes, summaries: sorted.length }; },
    dispose() { disposed = true; entries.clear(); sorted = []; prefix = []; bytes = 0; },
  };
}

/** Add finite pinned indices to a window; pins count against the same mounted budget.
 * @param {{start:number,end:number}} range @param {number[]} pins @param {number} count @param {number} budget */
export function virtualIndices(range, pins, count, budget) {
  integer(budget, 'pinBudget');
  const extra = [...new Set(pins)].filter((i) => Number.isSafeInteger(i) && i >= 0 && i < count && (i < range.start || i >= range.end));
  if (extra.length > budget) return { state: 'budget-exhausted', reason: 'pin-credits', indices: [] };
  return { state: 'ready', indices: [...Array.from({ length: range.end - range.start }, (_, i) => range.start + i), ...extra].sort((a, b) => a - b) };
}

/** Normalize a browser RTL scroll offset at the DOM boundary. Modern engines use negative offsets.
 * @param {number} value @param {number} maximum @param {'ltr'|'negative'|'reverse'|'default'} [mode] */
export function logicalScrollOffset(value, maximum, mode = 'ltr') {
  return Math.min(Math.max(0, maximum), Math.max(0, mode === 'negative' ? -value : mode === 'reverse' ? maximum - value : value));
}
