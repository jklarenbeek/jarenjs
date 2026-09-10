//@ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createCollection } from '@jarenjs/collection';

const base = { count: 100, keyAt: (i) => `row-${i}`, indexOf: (key) => Number(key.slice(4)),
  getItem: (i) => i, renderCell: String, columnCount: 100, rowSize: 44, columnSize: 100,
  overscan: 0, columnOverscan: 0, maxRows: 11, maxColumns: 3, maxCells: 52 };
describe('measured grid budgets and anchors', () => {
  it('bounds both axes including focus and pinned rows/columns', () => {
    const c = createCollection({ ...base, rowPins: [0], columnPins: [0], rowPinBudget: 2, columnPinBudget: 1 });
    c.viewport({ top: 440, left: 200, width: 300, height: 440 });
    const layout = c.pin([90], [0]);
    assert.equal(layout.rows.length, 12); assert.equal(layout.columns.length, 4);
    assert.equal(c.stats().cells, 48);
    assert.equal(c.pin([90, 91], [0]).reason, 'pin-credits');
    assert.equal(c.viewport({ width: 0 }).rows.length, 0);
    c.dispose();
  });
  it('preserves stable anchors across insert, delete, reorder and measurement', () => {
    let keys = Array.from({ length: 100 }, (_, i) => `row-${i}`);
    const c = createCollection({ ...base, keyAt: (i) => keys[i], indexOf: (key) => keys.indexOf(key) });
    c.viewport({ top: 445, width: 300, height: 440 });
    assert.equal(c.measure(0, 'row-0', 88).offset, 489);
    keys = ['inserted', ...keys]; c.update({ count: keys.length });
    assert.equal(c.position().top, 533);
    keys = keys.filter((key) => key !== 'row-0'); c.update({ count: keys.length });
    assert.equal(c.position().top, 445);
    keys = [...keys.slice(10), ...keys.slice(0, 10)]; c.update({});
    assert.equal(c.snapshot().key, 'row-10'); assert.equal(c.position().top, 5);
    keys = keys.filter((key) => key !== 'row-10'); c.update({ count: keys.length });
    assert.equal(c.snapshot().key, 'row-11');
    c.measure(1, 'col-1', 140, 'column'); assert.equal(c.columnAxis.position(2), 240);
    assert.equal(c.restore({ key: 'row-20', index: 1, offset: 4, query: '' }).state, 'ready');
    c.dispose();
  });
  it('refuses unqualified CSS extents before rendering', () => {
    const c = createCollection({ ...base, count: 1000000, maxExtent: 8000000 });
    assert.equal(c.viewport({ height: 440, width: 300 }).reason, 'scroll-extent');
    assert.equal(c.scrollToIndex(900000).reason, 'scroll-extent'); c.dispose();
  });
});
