//@ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mountCollection, createCollectionWidget, mountProviderCollection } from '@jarenjs/collection/component';
import { createArrayRangeProvider, createCollectionCoordinator } from '@jarenjs/app';
import { createDomRenderer } from '@jarenjs/view';
import { collectionHost } from './dom-host.js';
const options={count:100,keyAt:i=>`row-${i}`,indexOf:key=>Number(key.slice(4)),getItem:i=>({id:`row-${i}`}),renderCell:row=>row.id};
describe('collection element and widget ownership',()=>{
  it('mounts, removes and reinserts through WidgetDef without retained resources',()=>{
    const env=collectionHost(), widgets={collection:createCollectionWidget({...options,...env})};
    const render=createDomRenderer(env.host,{document:env.document,widgets});
    for(let i=0;i<3;i++){
      render(['jaren-widget',{name:'collection'}]);assert.equal(env.observers.size,1);
      render(['jaren-widget',{name:'collection',props:{count:101}}]);render(null);
      assert.equal(env.frames.size,0);assert.equal(env.observers.size,0);
    }
    render.destroy();
  });
  it('realizes keyboard focus, selection, composition and controlled lifetimes',()=>{
    const env=collectionHost();let activated=0,intents=0,returned=0;
    const c=mountCollection(env.host,{...options,onActivate:()=>activated++,onIntent:()=>intents++,returnFocus:{focus:()=>returned++}});
    c.element.fire('focusin',{target:c.element});
    assert.ok(env.document.getElementById(c.element.getAttribute('aria-activedescendant')));
    const key=(key,extra={})=>c.element.fire('keydown',{key,target:c.element,preventDefault(){},...extra});
    key('ArrowDown');key(' ');key('Enter');key('Escape');assert.equal(activated,1);assert.equal(returned,1);
    c.element.fire('compositionstart',{});key('ArrowDown');c.element.fire('compositionend',{});
    key('unhandled');assert.ok(intents>=4);
    const row=c.element.querySelectorAll('.jc-row')[0],cell=row.querySelectorAll('.jc-cell')[0];
    c.element.fire('click',{target:cell});c.element.fire('focusin',{target:cell});
    c.scrollToKey('row-90');c.scrollToIndex(30);c.scrollToOffset(100);
    const saved=c.snapshot();c.restore(saved);assert.equal(c.stats().listeners,6);
    c.element.fire('scroll',{});assert.equal(c.stats().frames,1);
    c.dispose();c.dispose();env.flush();assert.equal(c.stats().listeners,0);assert.equal(env.observers.size,0);
  });
  it('measures within work/cache credits and cleans failure paths',()=>{
    const env=collectionHost({contentHeight:40});
    const c=mountCollection(env.host,{...options,measured:true,maxMeasurementWork:2,maxMeasurements:2});
    c.measureVisible();for(const fn of [...env.observers.values()])fn();env.flush();assert.ok(c.stats().rowMeasurements.measurements<=2);
    c.update({count:20});c.scrollToIndex(19);c.measureVisible();c.dispose();assert.equal(env.observers.size,0);
    assert.throws(()=>mountCollection(env.host,{...options,observe(){throw Error('observer failed');}}),/observer failed/);
    const widget=createCollectionWidget((props)=>({...options,...props}));const h=widget.mount(env.host,{},()=>{});
    widget.update(h,{count:2});widget.unmount(h);
  });
  it('mounts the same controller over bounded provider pages and disposes both',async()=>{
    const env=collectionHost({height:176});
    const provider=createArrayRangeProvider(Array.from({length:100},(_,i)=>({id:`row-${i}`})));
    const coordinator=createCollectionCoordinator(provider,{pageRows:8});
    const c=mountProviderCollection(env.host,coordinator,{...options,overscan:0});
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(coordinator.observation().state,'ready');assert.equal(c.mounted.controller.layout().rows[0].key,'row-0');
    await c.next();assert.equal(coordinator.keyAt(8),'row-8');
    c.mounted.interaction.focusIndex(7);
    c.mounted.element.fire('keydown',{key:'PageDown',target:c.mounted.element,preventDefault(){}});
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(c.mounted.interaction.state().pending,null);
    await c.print({write(){},commit(){}},{selection:undefined});
    c.snapshot();const result=await c.output({write(){},commit(){}},{selection:undefined});assert.equal(result.rows,100);
    await c.dispose();assert.equal(env.observers.size,0);assert.equal(coordinator.stats().rows,0);
  });
});

it('attempts every cleanup when one observer fails and remains idempotent',()=>{
  const env=collectionHost();let stopped=0;
  const c=mountCollection(env.host,{...options,measured:true,observe:()=>()=>{stopped++;throw new Error('cleanup failure');}});
  const before=c.stats().observers;
  assert.throws(()=>c.dispose(),/cleanup failure/);assert.equal(stopped,before);assert.equal(env.host.childNodes.length,0);
  c.dispose();assert.equal(stopped,before);assert.equal(c.stats().listeners,0);
});

it('measures every mounted row across finite frame work credits without overriding a newer scroll',()=>{
  const env=collectionHost();
  const c=mountCollection(env.host,{...options,measured:true,maxMeasurementWork:2,measureRow:()=>45});
  for(const fn of [...env.observers.values()])fn();
  for(let i=0;i<20&&env.frames.size;i++)env.flush();
  assert.ok(c.controller.rowAxis.stats().measurements>=c.controller.layout().rows.length);
  for(const fn of [...env.observers.values()])fn();c.element.scrollTop=1000;c.element.fire('scroll',{});env.flush();
  assert.ok(c.element.scrollTop>=1000);c.dispose();assert.equal(env.frames.size,0);
});

it('transient retention shares finite pin credits and lifecycle observers release on every exit',()=>{
  const env=collectionHost(), events=[];
  const c=mountCollection(env.host,{...options,rowPinBudget:1});
  const unsubscribe=c.subscribe(event=>events.push(event.kind));
  const release=c.retain(()=>({rows:[90],columns:[0]}));
  c.refresh();assert.ok(c.controller.layout().rows.some(row=>row.key==='row-90'));
  assert.equal(c.stats().retainers,1);
  c.update({snapshot:'changed'});assert.ok(events.includes('reset'));
  release();release();env.flush();
  assert.ok(!c.controller.layout().rows.some(row=>row.key==='row-90'));
  const retainers=Array.from({length:8},()=>c.retain(()=>({rows:[],columns:[]})));
  assert.throws(()=>c.retain(()=>({rows:[],columns:[]})),RangeError);
  for(const stop of retainers)stop();
  const subscribers=Array.from({length:15},()=>c.subscribe(()=>{}));
  assert.throws(()=>c.subscribe(()=>{}),RangeError);
  for(const stop of subscribers)stop();
  unsubscribe();unsubscribe();
  let disposed=0;
  c.subscribe(()=>{throw new Error('observer cleanup');});c.subscribe(()=>{disposed++;});
  assert.throws(()=>c.dispose(),/observer cleanup/);c.dispose();
  assert.equal(disposed,1);assert.equal(c.stats().retainers+c.stats().subscribers,0);
  assert.equal(env.host.childNodes.length,0);assert.equal(env.frames.size,0);
});
