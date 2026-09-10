//@ts-check
/** Portable installed consumer: no retained virtualizer or source-relative library import. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createVirtualAxis, fixedRange } from '@jarenjs/core/virtual';
import { createCollection, createCollectionInteraction } from '@jarenjs/collection';
import { createArrayRangeProvider, createCollectionCoordinator } from '@jarenjs/app';
const fixture=JSON.parse(readFileSync(new URL('./collection-grid.json',import.meta.url),'utf8'));
for(const mode of ['fixed','measured']) {
  const profile=fixture[mode],axis=createVirtualAxis(profile);
  for(const [index,size] of profile.sizes??[])axis.measure(index,`row-${index}`,size);
  for(const [i,expected] of fixture.expected[mode].entries()) {
    // These are the retained host's effective offsets after synchronous size compensation.
    const offset=mode==='measured'?[0,216,3690][i]:expected.offset;
    const range=axis.range({offset,viewport:profile.viewport,overscan:profile.overscan});
    assert.deepEqual(Array.from({length:range.end-range.start},(_,n)=>{
      const index=n+range.start,start=axis.position(index),size=axis.size(index);
      return {index,key:`row-${index}`,start,end:start+size,size};
    }),expected.items);
    assert.equal(axis.extent(),expected.totalSize);
  }
  const rows=Array.from({length:profile.count},(_,i)=>({id:`row-${i}`,label:`Item ${i}`}));
  const provider=createArrayRangeProvider(rows),coordinator=createCollectionCoordinator(provider);
  const collection=createCollection({count:profile.count,keyAt:i=>coordinator.keyAt(i),getItem:i=>coordinator.rowAt(i),renderCell:row=>row.label,
    rowSize:profile.estimateSize,columnCount:profile.columns,maxCells:840});
  const interaction=createCollectionInteraction({count:profile.count,keyAt:i=>coordinator.keyAt(i),indexOf:key=>coordinator.indexOf(key)});
  await coordinator.requestRange({start:0,end:64});interaction.focusIndex(1);interaction.key({key:' '});
  for(let pass=0;pass<2;pass++)for(let start=0;start<profile.count;start+=1024) {
    await coordinator.requestRange({start,end:start+64});
    collection.viewport({top:start*profile.estimateSize,width:640,height:profile.viewport});
    assert.ok(collection.stats().cells<=840);assert.ok(coordinator.stats().rows<=256);assert.ok(coordinator.stats().bytes<=262144);
  }
  const exported=[];
  const result=await coordinator.output({write:page=>exported.push(...page),commit(){}},{selection:interaction.state().selection});
  assert.equal(result.state,'complete');assert.deepEqual(exported.map(row=>row.id),['row-1']);
  collection.dispose();axis.dispose();await coordinator.dispose();assert.equal(coordinator.stats().rows,0);
}
assert.equal(fixedRange({count:1000000,size:44,viewport:440,overscan:12}).end,22);
