//@ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createCollectionCoordinator } from '@jarenjs/app';
import { open, createDbRangeProvider } from '@jarenjs/linq/db';
import { createCollection, createCollectionInteraction } from '@jarenjs/collection';
import { nodeDriver } from '@jarenjs/db/node';

describe('one collection engine over database ranges', () => {
  it('selects across evicted pages and streams a complete resident database snapshot', async () => {
    const client=await open({$model:'0.1',entities:{Row:{schema:{type:'object',properties:{id:{type:'string','x-entity':{key:true}},rank:{type:'integer'}}}}}}, {driver:nodeDriver(),capture:true});
    const store=client.store;
    try {
      for(let i=0;i<80;i++) await client.entities.Row.create({id:`row-${i}`,rank:i});
      const provider=await createDbRangeProvider(store,'Row',{orderBy:'$it.rank'},{keys:['id'],resident:true,maxRows:100});
      const coordinator=createCollectionCoordinator(provider,{pageRows:8,maxPages:1,maxRows:8});
      const config={count:80,keyAt:(i)=>coordinator.keyAt(i),getItem:(i)=>coordinator.rowAt(i),renderCell:(row)=>row.rank,
        indexOf:(key)=>coordinator.indexOf(key),query:provider.query,snapshot:provider.snapshot};
      const collection=createCollection(config), interaction=createCollectionInteraction(config);
      await coordinator.requestRange({start:0,end:8}); collection.viewport({width:160,height:176});
      interaction.focusIndex(1); interaction.key({key:' '});
      await coordinator.requestRange({start:64,end:72}); collection.scrollToIndex(64);
      interaction.focusIndex(65);interaction.key({key:' '});
      assert.equal(coordinator.keyAt(1),null); assert.equal(interaction.selected('row-1'),true);
      assert.equal(collection.layout().rows[0].key,null);
      const exported=[];let committed=false;
      const result=await coordinator.output({write:(rows)=>exported.push(...rows),commit:()=>{committed=true;}},{selection:interaction.state().selection});
      assert.equal(result.state,'complete');assert.equal(committed,true);assert.deepEqual(exported.map(row=>row.id),['row-1','row-65']);
      const full=[];await coordinator.output({write:rows=>full.push(...rows),commit(){}});assert.equal(full.length,80);
      const bytes=provider.export({query:provider.query,snapshot:provider.snapshot,pageRows:8,pageBytes:2});
      await assert.rejects(bytes.next(),/byte credits/);
      collection.dispose(); await coordinator.dispose();assert.equal(provider.stats().exports,0);
    } finally {await client.close();}
  });
});
