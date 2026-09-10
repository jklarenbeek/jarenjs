//@ts-check
import { createVirtualAxis, virtualIndices } from '@jarenjs/core/virtual';

/** Stable DOM identity; JSON escaping also supports lone surrogate code units in JSON keys.
 * @param {string} id @param {string} key @param {number} [column] */
export function collectionItemId(id, key, column) {
  return `${id}-r-${encodeURIComponent(JSON.stringify(key))}${column === undefined ? '' : `-c-${column}`}`;
}

/**
 * Create a source-independent collection. Accessors run only for credited mounted rows.
 * Measurements and pins have their own finite credits. Oversized DOM extents refuse explicitly.
 * @param {any} options
 */
export function createCollection(options) {
  let config = { rowSize: 44, overscan: 2, columnCount: 1, columnSize: 160, columnOverscan: 1,
    maxRows: 128, maxColumns: 32, maxCells: 840, rowPinBudget: 2, columnPinBudget: 2,
    maxExtent: Number.MAX_SAFE_INTEGER, query: '', snapshot: '', ...options };
  for (const name of ['maxRows', 'maxColumns', 'maxCells', 'rowPinBudget', 'columnPinBudget'])
    if (!Number.isSafeInteger(config[name]) || config[name] < 0) throw new RangeError(`Invalid ${name}`);
  const rowAxis = createVirtualAxis({ count: config.count, estimateSize: config.rowSize,
    maxMeasurements: config.maxMeasurements, maxBytes: config.measurementBytes });
  const columnAxis = createVirtualAxis({ count: config.columnCount, estimateSize: config.columnSize,
    maxMeasurements: config.maxColumnMeasurements, maxBytes: config.columnMeasurementBytes });
  let viewport = { top: 0, left: 0, width: 0, height: 0 };
  let anchor = null, disposed = false;
  let focusPins = { rows: [], columns: [] };
  const keyAt = (index) => config.keyAt(index);
  const refusal = (state, reason) => ({ state, reason, rows: [], columns: [] });
  function layout() {
    if (disposed) return refusal('error', 'disposed');
    const visible = viewport.height > 0 && viewport.width > 0;
    const rows = rowAxis.range({ viewport: visible ? viewport.height : 0, offset: viewport.top, overscan: config.overscan });
    const columns = columnAxis.range({ viewport: visible ? viewport.width : 0, offset: viewport.left, overscan: config.columnOverscan });
    if (rows.extent > config.maxExtent || columns.extent > config.maxExtent) return refusal('error', 'scroll-extent');
    if (rows.end - rows.start > config.maxRows || columns.end - columns.start > config.maxColumns)
      return refusal('budget-exhausted', 'dom-credits');
    const rowIndices = virtualIndices(rows, visible ? [...(config.rowPins ?? []), ...focusPins.rows] : [], config.count, config.rowPinBudget);
    const columnIndices = virtualIndices(columns, visible ? [...(config.columnPins ?? []), ...focusPins.columns] : [], config.columnCount, config.columnPinBudget);
    if (rowIndices.state !== 'ready' || columnIndices.state !== 'ready') return refusal('budget-exhausted', 'pin-credits');
    if (rowIndices.indices.length * columnIndices.indices.length > config.maxCells) return refusal('budget-exhausted', 'dom-credits');
    const seen = new Set();
    const mounted = rowIndices.indices.map((index) => {
      const key = keyAt(index);
      if (key != null && (typeof key !== 'string' || seen.has(key))) throw new TypeError('Collection keys must be unique strings');
      if (key != null) seen.add(key);
      return { index, key, start: rowAxis.position(index), size: rowAxis.size(index), pinned: (config.rowPins ?? []).includes(index) };
    });
    return { state: 'ready', rowRange: rows, columnRange: columns, rows: mounted,
      columns: columnIndices.indices.map((index) => ({ index, start: columnAxis.position(index), size: columnAxis.size(index),
        pinned: (config.columnPins ?? []).includes(index) })) };
  }
  function saveAnchor() { anchor = rowAxis.anchor(viewport.top, keyAt, config.query); }
  function restoreAnchor() {
    const restored = rowAxis.restore(anchor, config.indexOf, config.query);
    viewport.top = Math.min(restored.offset, Math.max(0, rowAxis.extent() - viewport.height));
    return viewport.top;
  }
  function scrollToOffset(offset) {
    if (disposed) return { state: 'error', reason: 'disposed' };
    viewport.top = offset;
    const result = layout();
    if (result.state !== 'ready') return result;
    viewport.top = result.rowRange.offset; saveAnchor();
    return { state: 'ready', offset: viewport.top, left: viewport.left };
  }
  return {
    rowAxis, columnAxis, layout,
    options() { return config; },
    position() { return { ...viewport }; },
    viewport(next) { viewport = { ...viewport, ...next }; const result = layout();
      if (result.state === 'ready') { viewport.top = result.rowRange.offset; viewport.left = result.columnRange.offset; saveAnchor(); }
      return result; },
    update(next) {
      config = { ...config, ...next };
      rowAxis.update({ count: config.count, estimateSize: config.rowSize, indexOf: config.indexOf });
      columnAxis.update({ count: config.columnCount, estimateSize: config.columnSize });
      restoreAnchor(); saveAnchor(); return layout();
    },
    measure(index, key, size, axis = 'row') {
      const engine = axis === 'column' ? columnAxis : rowAxis;
      const result = engine.measure(index, key, size);
      if (result.state === 'ready') { restoreAnchor(); saveAnchor(); }
      return { ...result, offset: viewport.top };
    },
    pin(rows = [], columns = []) { focusPins = { rows, columns }; return layout(); },
    restore(value) { anchor = value; const offset = restoreAnchor(); saveAnchor(); return scrollToOffset(offset); },
    snapshot() { return anchor ? { ...anchor, snapshot: config.snapshot } : null; },
    scrollToOffset,
    /** @param {number} index @param {number} [column] */
    scrollToIndex(index, column) {
      if (!Number.isSafeInteger(index) || index < 0 || index >= config.count) return { state: 'error', reason: 'invalid-index' };
      if (column !== undefined) viewport.left = columnAxis.position(Math.max(0, Math.min(config.columnCount - 1, column)));
      return scrollToOffset(rowAxis.position(index));
    },
    scrollToKey(key) {
      if (!config.indexOf) return { state: 'error', reason: 'unsupported-seek' };
      return this.scrollToIndex(config.indexOf(key));
    },
    view(interaction = null, id = 'collection') {
      const result = layout();
      const grid = config.role !== 'listbox';
      const selection = (key) => interaction?.selected(key) ?? false;
      const active = interaction?.state().focus;
      const rows = result.rows.map((row) => {
        const rowKey = JSON.stringify(row.key == null ? [0, row.index] : [1, row.key]);
        const rowId = row.key == null ? `${id}-p-${row.index}` : collectionItemId(id, row.key);
        const rowTop = row.pinned ? Math.max(row.start, viewport.top) : row.start;
        return ['div', { key: rowKey, 'data-row': row.index, 'data-key': row.key,
          role: grid ? 'row' : 'option', id: grid ? undefined : rowId,
          'aria-rowindex': grid ? row.index + 1 : undefined,
          'aria-posinset': grid ? undefined : row.index + 1,
          'aria-setsize': grid ? undefined : config.totalKnown === false ? -1 : config.count,
          'aria-selected': grid ? undefined : selection(row.key), class: row.pinned ? 'jc-row jc-pin' : 'jc-row', style: {
            position: 'absolute', top: `${rowTop}px`, height: `${row.size}px`, width: '100%', zIndex: row.pinned ? 2 : 0 } },
        ...result.columns.map((column) => ['div', { key: column.index, class: column.pinned ? 'jc-cell jc-pin' : 'jc-cell',
          role: grid ? 'gridcell' : undefined,
          id: grid ? `${rowId}-c-${column.index}` : undefined,
          'data-column': column.index, 'aria-colindex': grid ? column.index + 1 : undefined,
          'aria-selected': grid ? selection(row.key) : undefined,
          'data-active': active?.key === row.key && active?.column === column.index,
          style: { position: 'absolute', [config.direction === 'rtl' ? 'right' : 'left']:
            `${column.pinned ? Math.max(column.start, viewport.left) : column.start}px`,
          width: `${column.size}px`, height: '100%', zIndex: column.pinned ? 1 : 0 } },
        ['div', { class: 'jc-content' }, row.key == null ? (config.loadingLabel ?? 'Loading…') : config.renderCell(config.getItem(row.index), column.index, row.index)]])];
      });
      return ['div', { class: 'jc-surface', style: { position: 'relative', height: `${result.rowRange?.extent ?? 0}px`,
        width: `${result.columnRange?.extent ?? 0}px` } }, ...rows];
    },
    stats() { const result = layout(); return { rows: result.rows.length, columns: result.columns.length,
      cells: result.rows.length * result.columns.length, rowMeasurements: rowAxis.stats(), columnMeasurements: columnAxis.stats() }; },
    dispose() { disposed = true; rowAxis.dispose(); columnAxis.dispose(); anchor = null; focusPins = { rows: [], columns: [] }; },
  };
}
