//@ts-check
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createCollectionDemoWidget } from '../../packages/website/src/boundaries/collection.js';
import { createDomRenderer } from '../../packages/view/src/index.js';
import { collectionHost } from '../collection/dom-host.js';
it('parent rerenders preserve the collection and keyed replacement cannot be cleared by old async teardown',async()=>{
  const env=collectionHost(),widget=createCollectionDemoWidget();
  const render=createDomRenderer(env.host,{document:env.document,widgets:{collection:widget}});
  const vnode=mode=>['jaren-widget',{name:'collection',key:mode,props:{mode}}];
  render(vnode('array'));await new Promise(resolve=>setImmediate(resolve));
  const viewport=env.host.querySelector('.jc-viewport');assert.ok(viewport);
  render(vnode('array'));await new Promise(resolve=>setImmediate(resolve));
  assert.equal(env.host.querySelector('.jc-viewport'),viewport);
  render(vnode('measured'));await new Promise(resolve=>setImmediate(resolve));
  assert.ok(env.host.querySelector('.jc-viewport'));
  assert.notEqual(env.host.querySelector('.jc-viewport'),viewport);
  render.destroy();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(env.observers.size,0);assert.equal(env.host.childNodes.length,0);
});
it('the collection page owns only source construction and drains its reusable controller',async()=>{
  const env=collectionHost(),widget=createCollectionDemoWidget();
  const handle=widget.mount(env.host,{mode:'array'});await handle.ready;
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(env.host.querySelector('.jc-viewport').getAttribute('role'),'grid');
  env.host.querySelectorAll('button')[0].click();await new Promise(resolve=>setImmediate(resolve));
  assert.match(env.host.querySelector('[data-collection-status]').childNodes.map(node=>node.nodeValue).join(''),/Exported/);
  await handle.dispose();assert.equal(env.observers.size,0);
  const late=widget.mount(env.host,{mode:'measured'});widget.unmount(late);await late.ready;
  assert.equal(env.observers.size,0);
});

it('the measured and SQLite examples use the same owned widget and release sources',async()=>{
  for(const mode of ['measured','database']){
    const env=collectionHost(),widget=createCollectionDemoWidget(),handle=widget.mount(env.host,{mode});
    await handle.ready;await new Promise(resolve=>setImmediate(resolve));
    for(const fn of [...env.observers.values()])fn();env.flush();
    const viewport=env.host.querySelector('.jc-viewport');assert.ok(viewport);
    viewport.fire('focusin',{target:viewport});viewport.fire('keydown',{key:' ',target:viewport,preventDefault(){}});
    env.host.querySelectorAll('button')[0].click();await new Promise(resolve=>setImmediate(resolve));
    assert.match(env.host.querySelector('[data-collection-status]').childNodes.map(node=>node.nodeValue).join(''),/Exported 1 rows/);
    await handle.dispose();assert.equal(env.observers.size,0);
  }
});
it('the browser download spool refuses a complete but oversized selected range',async()=>{
  const env=collectionHost(),widget=createCollectionDemoWidget(),handle=widget.mount(env.host,{mode:'array'});
  await handle.ready;await new Promise(resolve=>setImmediate(resolve));
  const viewport=env.host.querySelector('.jc-viewport');viewport.fire('focusin',{target:viewport});
  viewport.fire('keydown',{key:'End',ctrlKey:true,shiftKey:true,target:viewport,preventDefault(){}});
  await new Promise(resolve=>setImmediate(resolve));
  env.host.querySelectorAll('button')[0].click();await new Promise(resolve=>setImmediate(resolve));
  assert.match(env.host.querySelector('[data-collection-status]').childNodes.map(node=>node.nodeValue).join(''),/Export failed: incomplete-export/);
  await handle.dispose();assert.equal(env.observers.size,0);
});

it('lexical controls filter complete membership and route replacement drains the index and collection', async () => {
  const env = collectionHost(), widget = createCollectionDemoWidget();
  const render = createDomRenderer(env.host, { document: env.document, widgets: { collection: widget } });
  render(['jaren-widget', { name: 'collection', key: 'lexical', props: { mode: 'lexical' } }]);
  await new Promise(resolve => setImmediate(resolve));
  const input = env.host.querySelector('[data-search-input]'), sort = env.host.querySelector('[data-search-sort]');
  const organic = env.host.querySelector('[data-search-organic]'), status = env.host.querySelector('[data-search-status]');
  assert.match(status.childNodes.map(node => node.nodeValue).join(''), /250 matches/);
  organic.checked = true; organic.fire('change', {}); assert.match(status.childNodes.map(node => node.nodeValue).join(''), /84 matches/);
  sort.value = 'sku'; sort.fire('change', {}); assert.match(status.childNodes.map(node => node.nodeValue).join(''), /84 matches/);
  input.value = 'no-match'; input.fire('input', {}); assert.match(status.childNodes.map(node => node.nodeValue).join(''), /0 matches/);
  render(['jaren-widget', { name: 'collection', key: 'array', props: { mode: 'array' } }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(env.host.querySelector('.jc-viewport')); assert.equal(env.host.querySelector('[data-search-input]'), null);
  render.destroy(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(env.observers.size, 0); assert.equal(env.frames.size, 0);
});
