//@ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createCollection } from '@jarenjs/collection';
import { renderToString } from '@jarenjs/view';

describe('fixed collections', () => {
  it('bounds accessor work independently of logical count and provides public seeks', () => {
    let reads = 0;
    const collection = createCollection({ count: 1000000, rowSize: 44, overscan: 12,
      keyAt: (i) => `row-${i}`, indexOf: (key) => Number(key.slice(4)),
      getItem: (i) => { reads++; return { label: `Row ${i}` }; }, renderCell: (row) => row.label });
    const layout = collection.viewport({ height: 440, width: 160 });
    assert.equal(layout.rows.length, 22);
    assert.match(renderToString(collection.view()), /Row 21/);
    assert.equal(reads, 22);
    assert.equal(collection.scrollToKey('row-90').offset, 3960);
    assert.equal(collection.scrollToIndex(-1).reason, 'invalid-index');
    collection.update({ indexOf: undefined });
    assert.equal(collection.scrollToKey('row-10').reason, 'unsupported-seek');
    collection.dispose(); collection.dispose();
    assert.equal(collection.layout().reason, 'disposed');
  });
  it('refuses DOM credit overflow and mounts nothing while hidden', () => {
    const collection = createCollection({ count: 100, keyAt: String, maxRows: 2 });
    assert.equal(collection.viewport({ width: 300, height: 440 }).state, 'budget-exhausted');
    assert.equal(collection.viewport({ height: 0 }).rows.length, 0);
    collection.dispose();
  });
});

it('separates placeholder identities from every legal JSON row key',()=>{
  const c=createCollection({count:3,keyAt:i=>i===0?null:i===1?'loading-0':'\ud800',getItem:()=>1,renderCell:String,overscan:0,columnOverscan:0});
  c.viewport({width:160,height:132});const vnode=c.view();
  assert.equal(new Set(vnode.slice(2).map(row=>row[1].key)).size,3);
  const html=renderToString(vnode),ids=[...html.matchAll(/ id="([^"]+)"/g)].map(match=>match[1]);
  assert.equal(new Set(ids).size,3);c.dispose();
});
