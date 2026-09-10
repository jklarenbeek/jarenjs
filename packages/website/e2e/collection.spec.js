import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../../../',import.meta.url));
const bundle=await build({stdin:{contents:"export * from '@jarenjs/collection/component'; export * from '@jarenjs/collection'; export * from '@jarenjs/app';",resolveDir:root},bundle:true,write:false,platform:'browser',format:'iife',globalName:'CollectionTest'});
async function setup(page,options={}) {
  await page.setContent('<button id="return">Return</button><main id="host" style="width:640px"></main>');
  await page.addScriptTag({content:bundle.outputFiles[0].text});
  await page.evaluate((options)=>{
    window.keys=Array.from({length:10000},(_,i)=>`row-${i}`);
    window.c=window.CollectionTest.mountCollection(document.getElementById('host'),{
      count:window.keys.length,keyAt:i=>window.keys[i],indexOf:key=>window.keys.indexOf(key),
      getItem:i=>({id:window.keys[i],label:`Item ${window.keys[i]}`}),renderCell:(row,col)=>col===1?['input',{'aria-label':row.id,value:row.label}]:row.label,
      columnCount:24,columnSize:160,overscan:2,height:440,returnFocus:document.getElementById('return'),...options});
  },options);
}

test('fixed list and grid work stays bounded through scroll, focus, resize, hidden and teardown',async({page})=>{
  await setup(page);
  const viewport=page.locator('.jc-viewport');await viewport.focus();
  await page.keyboard.press('Control+End');
  await expect(viewport).toHaveAttribute('aria-rowcount','10000');
  expect(await page.evaluate(()=>document.getElementById(window.c.element.getAttribute('aria-activedescendant'))!==null)).toBe(true);
  const counts=await page.evaluate(()=>window.c.stats());expect(counts.rows).toBeLessThanOrEqual(17);expect(counts.cells).toBeLessThanOrEqual(119);
  await page.keyboard.press('Control+Home');await page.keyboard.press('ArrowDown');await page.keyboard.press('Shift+ArrowDown');
  expect(await page.evaluate(()=>window.c.interaction.selected('row-1'))).toBe(true);
  await page.keyboard.press('PageDown');await page.keyboard.press('PageUp');await page.keyboard.press(' ');await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');await expect(page.locator('#return')).toBeFocused();
  await page.evaluate(()=>{window.c.element.style.display='none';window.c.refresh();});expect(await page.locator('.jc-row').count()).toBe(0);
  await page.evaluate(()=>{window.c.element.style.display='';document.getElementById('host').style.width='320px';window.c.refresh();});
  expect((await page.evaluate(()=>window.c.stats())).columns).toBeLessThanOrEqual(5);
  const disposed=await page.evaluate(()=>{window.c.dispose();window.c.dispose();return window.c.stats();});
  expect(disposed.listeners+disposed.observers+disposed.frames).toBe(0);
});

test('measured anchors survive insert delete reorder and size changes within a CSS pixel',async({page})=>{
  await setup(page);
  const result=await page.evaluate(()=>{
    window.c.scrollToOffset(445);const before=window.c.controller.snapshot();
    const relative=()=>document.querySelector('[data-key="row-10"]').getBoundingClientRect().top-window.c.element.getBoundingClientRect().top;
    const initial=relative();const offsets=[];
    window.c.controller.measure(0,'row-0',88);window.c.element.scrollTop=window.c.controller.position().top;window.c.refresh();offsets.push(relative());
    window.keys.unshift('inserted');window.c.update({count:window.keys.length});offsets.push(relative());
    window.keys=window.keys.filter(key=>key!=='row-0');window.c.update({count:window.keys.length});offsets.push(relative());
    window.keys=[...window.keys.slice(5),...window.keys.slice(0,5)];window.c.update({});offsets.push(relative());
    return {initial,offsets,key:before.key};
  });
  expect(result.key).toBe('row-10');for(const offset of result.offsets)expect(Math.abs(offset-result.initial)).toBeLessThanOrEqual(1);
});

test('editing preserves node identity caret and composition while focus pins stay mounted',async({page})=>{
  await setup(page);const input=page.locator('input[aria-label="row-2"]');await input.focus();
  await input.evaluate(el=>{el.setSelectionRange(3,3);window.editNode=el;el.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:'a'}));});
  await page.keyboard.press('ArrowDown');
  const focus=await page.evaluate(()=>window.c.interaction.state().focus.key);expect(focus).toBe('row-2');
  await input.evaluate(el=>el.setSelectionRange(3,3));
  await page.evaluate(()=>{window.c.scrollToIndex(80);window.c.refresh();});
  expect(await input.evaluate(el=>el===window.editNode)).toBe(true);expect(await input.evaluate(el=>el.selectionStart)).toBe(3);
  await input.evaluate(el=>el.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'a'})));
  await page.evaluate(()=>{window.keys=window.keys.filter(key=>key!=='row-2');window.c.update({count:window.keys.length,removedKeys:['row-2']});});
  const valid=await page.evaluate(()=>{const id=window.c.element.getAttribute('aria-activedescendant');return id===null||document.getElementById(id)!==null;});expect(valid).toBe(true);
});

test('RTL columns pinned headers zoom touch and CSS ceiling refusals remain explicit',async({page})=>{
  await setup(page,{direction:'rtl',rowPins:[0],columnPins:[0],rowPinBudget:2,columnPinBudget:2});
  await page.evaluate(()=>window.c.scrollToIndex(40,10));
  const alignment=await page.evaluate(()=>{
    const rows=[...document.querySelectorAll('.jc-row')];const xs=rows.slice(0,3).map(row=>row.querySelector('[data-column="10"]').getBoundingClientRect().left);
    return {delta:Math.max(...xs)-Math.min(...xs),left:window.c.element.scrollLeft,cells:window.c.stats().cells};
  });expect(alignment.delta).toBeLessThanOrEqual(1);expect(alignment.left).toBeLessThan(0);expect(alignment.cells).toBeLessThanOrEqual(840);
  await page.evaluate(()=>{document.getElementById('host').style.zoom='1.25';window.c.refresh();window.c.element.dispatchEvent(new Event('touchstart',{bubbles:true}));window.c.element.dispatchEvent(new Event('touchend',{bubbles:true}));});
  expect((await page.evaluate(()=>window.c.stats())).cells).toBeLessThanOrEqual(840);
  await page.evaluate(()=>window.c.update({count:1000000}));await expect(page.locator('.jc-viewport')).toHaveAttribute('data-reason','scroll-extent');
});

test('async realization retains a valid descendant until target rows arrive',async({page})=>{
  await setup(page);
  await page.locator('.jc-viewport').focus();
  await page.evaluate(()=>{window.c.update({keyAt:i=>i<1?window.keys[i]:null});});
  await page.keyboard.press('ArrowDown');await expect(page.locator('.jc-viewport')).toHaveAttribute('aria-busy','true');
  expect(await page.evaluate(()=>document.getElementById(window.c.element.getAttribute('aria-activedescendant'))!==null)).toBe(true);
  await page.evaluate(()=>window.c.update({keyAt:i=>window.keys[i]}));
  await expect(page.locator('.jc-viewport')).toHaveAttribute('aria-busy','false');
  expect(await page.evaluate(()=>window.c.interaction.state().focus.key)).toBe('row-1');
});

for(const mode of ['array','measured','database']) test(`published ${mode} example uses the reusable component`,async({page},testInfo)=>{
  await page.goto(`/jarenjs/#/collection?mode=${mode}`);
  await expect(page.getByRole('grid',{name:'Catalog grid'})).toBeVisible({timeout:30000});
  await expect(page.locator('.jc-row').first()).toHaveAttribute('data-key','row-0',{timeout:30000});
  await expect(page.locator('[data-collection-status]')).toContainText('ready');
  await page.getByRole('grid',{name:'Catalog grid'}).focus();await page.keyboard.press('ArrowDown');
  expect(await page.evaluate(()=>{const grid=document.querySelector('.jc-viewport');return !!document.getElementById(grid.getAttribute('aria-activedescendant'));})).toBe(true);
  if (mode === 'array') {
    const colors = await page.evaluate(() => {document.documentElement.classList.add('dark');return {grid:getComputedStyle(document.querySelector('.jc-viewport')).color,body:getComputedStyle(document.body).color};});
    expect(colors.grid).toBe(colors.body);
    await page.evaluate(() => document.documentElement.classList.remove('dark'));
  }
  if (mode === 'array' && process.env.COLLECTION_MEASURE === '1') await page.screenshot({path:`/tmp/collection-${testInfo.project.name}.png`,fullPage:true});
  await page.goto('/jarenjs/#/docs');await expect(page.locator('.jc-viewport')).toHaveCount(0);
});

test('near-ceiling scrolling and sampled viewport traversal retain finite resources',async({page},testInfo)=>{
  await setup(page);
  // Supply a lazy source so the logical extent is independent of a materialized browser array.
  await page.evaluate(()=>window.c.update({count:180000,keyAt:i=>`row-${i}`,indexOf:key=>Number(key.slice(4)),getItem:i=>({id:`row-${i}`,label:`Item ${i}`}),renderCell:row=>row.label}));
  const result=await page.evaluate(()=>{
    window.c.scrollToIndex(179999);const end=window.c.element.scrollTop,extent=window.c.element.scrollHeight;
    window.c.update({count:10000,rowSize:44,overscan:12,maxMeasurements:256});
    const samples=[];let cells=0;
    for(let i=0;i<40;i++){const start=performance.now();window.c.scrollToIndex((i*251)%10000);samples.push(performance.now()-start);cells=Math.max(cells,window.c.stats().cells);}
    samples.sort((a,b)=>a-b);const metrics={interactionMs:samples[Math.floor(samples.length*.95)],mountedCells:cells,extent,end};
    window.c.dispose();return {...metrics,remaining:window.c.stats().listeners+window.c.stats().observers+window.c.stats().frames};
  });
  expect(result.extent).toBe(7920000);expect(result.end).toBe(7919560);expect(result.remaining).toBe(0);expect(result.mountedCells).toBeLessThanOrEqual(504);
  if(process.env.COLLECTION_MEASURE==='1'){
    const {writeFileSync}=await import('node:fs');
    writeFileSync(`${root}/benchmark/collection-browser-${testInfo.project.name}.json`,JSON.stringify({engine:testInfo.project.name,browser:page.context().browser().version(),node:process.version,platform:process.platform,workers:testInfo.config.workers,samples:40,...result},null,2)+'\n');
  }
});
