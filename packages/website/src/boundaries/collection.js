//@ts-check
/** Neutral array and SQLite examples, composed from installed public collection APIs. */
import { createArrayRangeProvider, createCollectionCoordinator } from '@jarenjs/app';
import { createDomRenderer } from '@jarenjs/view';
import { mountProviderCollection } from '@jarenjs/collection/component';
import { mountLexicalDemo } from './lexical.js';
import { mountRulesDemo } from './rules.js';
import { mountAdoptionDemo } from './adoption.js';

/** @param {string} mode */
async function source(mode) {
  if (mode !== 'database') {
    const count = mode === 'measured' ? 75000 : 10000;
    return { provider: createArrayRangeProvider(Array.from({length:count}, (_, i) => ({id:`row-${i}`,label:`Item ${i}`,rank:i}))),
      close: async () => {} };
  }
  const [{ default: init }, { wasmDriver, sqlite3Handle }, { open, createDbRangeProvider }] = await Promise.all([
    import('@sqlite.org/sqlite-wasm'), import('@jarenjs/db/wasm'), import('@jarenjs/linq/db'),
  ]);
  const sqlite = await init();
  const client = await open({$model:'0.1',entities:{Row:{schema:{type:'object',properties:{
    id:{type:'string','x-entity':{key:true}},label:{type:'string'},rank:{type:'integer'}}}}}},
  { driver:wasmDriver(sqlite3Handle(sqlite)), capture:true });
  try {
    for(let i=0;i<128;i++) await client.entities.Row.create({id:`row-${i}`,label:`Stored item ${i}`,rank:i});
    const provider = await createDbRangeProvider(client.store,'Row',{orderBy:'$it.rank'},{keys:['id'],resident:true,maxRows:256});
    return {provider,close:()=>client.close()};
  }
  catch(error) { await client.close(); throw error; }
}

/** Website integration; lifecycle and interaction remain in the reusable package. */
export function createCollectionDemoWidget() {
  return {
    mount(host, props) {
      if (props.mode === 'lexical') return mountLexicalDemo(host);
      if (props.mode === 'rules') return mountRulesDemo(host);
      if (props.mode === 'adoption') return mountAdoptionDemo(host);
      const document = host.ownerDocument;
      let disposed = false, collection = null, close = null;
      const render = createDomRenderer(host, {document});
      render(['section', {}, ['nav', {class:'btn-row', 'aria-label':'Collection examples'},
        ['a',{class:'btn',href:'#/collection?mode=array'},'Array catalog'],
        ['a',{class:'btn',href:'#/collection?mode=measured'},'Measured grid'],
        ['a',{class:'btn',href:'#/collection?mode=database'},'SQLite snapshot'],
        ['a',{class:'btn',href:'#/collection?mode=lexical'},'Lexical search'],
        ['a',{class:'btn',href:'#/collection?mode=rules'},'Reviewed rules'],
        ['a',{class:'btn',href:'#/collection?mode=adoption'},'Replacement journey']],
      ['p', {}, props.mode === 'database' ? 'Complete bounded SQLite snapshot. Pages and mounted rows have separate limits.' :
        'The array source is resident. Only requested pages and visible cells are mounted.'],
      ['div',{'data-collection-host':'true'}], ['p',{role:'status','data-collection-status':'true'},'Loading collection…']]);
      const target = host.querySelector('[data-collection-host]'), status = host.querySelector('[data-collection-status]');
      const ready = source(props.mode).then(async (opened) => {
        close = opened.close;
        if (disposed) { await opened.provider.dispose(); await close(); return; }
        const coordinator = createCollectionCoordinator(opened.provider);
        collection = mountProviderCollection(target, coordinator, {
          height: props.mode === 'measured' ? 576 : 440, columnCount: props.mode === 'measured' ? 24 : 12,
          rowSize: props.mode === 'measured' ? 36 : 44, overscan: props.mode === 'measured' ? 8 : 12,
          columnSize: 160, columnOverscan: 1, measured: props.mode === 'measured',
          measureRow: (_row,index) => index === 0 ? 72 : index === 1 ? 18 : index === 2 ? 54 : index === 100 ? 90 : 36,
          label:'Catalog grid', renderCell: (row,column) => column === 0 ? row.label : `Field ${column}: ${row.rank}`,
          onChange: (state) => { status.textContent = `${state.rows} mounted rows · ${state.cells} cells · ${state.state}`; },
        });
        const button = document.createElement('button');button.className='btn';button.textContent='Export selected rows';
        button.addEventListener('click', async () => {
          const chunks=[];let bytes=0;
          const result=await collection.output({write:(rows)=>{const chunk=JSON.stringify(rows);bytes+=new TextEncoder().encode(chunk).byteLength+1;if(bytes>262144)throw new RangeError('Output exceeds the browser download budget');chunks.push(chunk);},commit:()=>{
            const url=URL.createObjectURL(new Blob(chunks.map((chunk)=>chunk+'\n'),{type:'application/x-ndjson'}));
            const anchor=document.createElement('a');anchor.href=url;anchor.download='selection.jsonl';anchor.click();URL.revokeObjectURL(url);
          },abort:()=>{chunks.length=0;}});
          status.textContent=result.state==='complete' ? `Exported ${result.rows} rows` : `Export failed: ${result.reason}`;
        });
        host.appendChild(button);
      }).catch((error) => { if (!disposed) status.textContent=`Collection unavailable: ${error.message}`; });
      return { ready, async dispose() { disposed=true; render.destroy(); if(collection) await collection.dispose(); await ready; await close?.(); } };
    },
    // The route's mode is the widget key. Other app renders keep this owned source.
    update() {},
    unmount(handle) { void handle.dispose(); },
  };
}
