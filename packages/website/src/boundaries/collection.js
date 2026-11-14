//@ts-check
/** Neutral array and SQLite examples, composed from installed public collection APIs. */
import { createArrayRangeProvider, createCollectionCoordinator } from '@jarenjs/app';
import { createDomRenderer } from '@jarenjs/view';
import { mountProviderCollection } from '@jarenjs/collection/component';
import { mountLexicalDemo } from './lexical.js';
import { mountRulesDemo } from './rules.js';
import { mountAdoptionDemo } from './adoption.js';
import { siteText } from '../messages.js';

/** The site's words in English: what a caller that passes none reads. */
const ENGLISH = siteText();

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

/**
 * Website integration; lifecycle and interaction remain in the reusable package.
 * `options.messages` answers the reader's compiled catalog at mount (the
 * language of the collections' and the rule editor's chrome); a language
 * change remounts the widget. `options.siteWords` answers the site's own
 * words in the reader's language (`siteText(pack)`) at mount: the examples'
 * nav, status lines and buttons; English when absent.
 * @param {{ messages?: () => (Readonly<Record<string, unknown>> | null | undefined),
 *   siteWords?: () => (id: any, params?: Record<string, unknown>) => string }} [options]
 */
export function createCollectionDemoWidget(options = {}) {
  return {
    mount(host, props) {
      const messages = options.messages?.();
      const say = options.siteWords?.() ?? ENGLISH;
      if (props.mode === 'lexical') return mountLexicalDemo(host, { messages, say });
      if (props.mode === 'rules') return mountRulesDemo(host, { messages, say });
      if (props.mode === 'adoption') return mountAdoptionDemo(host, { messages, say });
      const document = host.ownerDocument;
      let disposed = false, collection = null, close = null;
      const render = createDomRenderer(host, {document});
      render(['section', {}, ['nav', {class:'btn-row', 'aria-label':say('site/collection/examples')},
        ['a',{class:'btn',href:'#/collection?mode=array'},say('site/collection/array')],
        ['a',{class:'btn',href:'#/collection?mode=measured'},say('site/collection/measured')],
        ['a',{class:'btn',href:'#/collection?mode=database'},say('site/collection/database')],
        ['a',{class:'btn',href:'#/collection?mode=lexical'},say('site/collection/lexical')],
        ['a',{class:'btn',href:'#/collection?mode=rules'},say('site/collection/rules')],
        ['a',{class:'btn',href:'#/collection?mode=adoption'},say('site/collection/adoption')]],
      ['p', { lang: 'en', dir: 'ltr' }, props.mode === 'database' ? 'Complete bounded SQLite snapshot. Pages and mounted rows have separate limits.' :
        'The array source is resident. Only requested pages and visible cells are mounted.'],
      ['div',{'data-collection-host':'true'}], ['p',{role:'status','data-collection-status':'true'},say('site/collection/loading')]]);
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
          label:say('site/collection/grid'), messages, renderCell: (row,column) => column === 0 ? row.label : `Field ${column}: ${row.rank}`,
          onChange: (state) => { status.textContent = say('site/collection/mounted', { rows: state.rows, cells: state.cells, state: state.state }); },
        });
        const button = document.createElement('button');button.className='btn';button.textContent=say('site/collection/export');
        button.addEventListener('click', async () => {
          const chunks=[];let bytes=0;
          const result=await collection.output({write:(rows)=>{const chunk=JSON.stringify(rows);bytes+=new TextEncoder().encode(chunk).byteLength+1;if(bytes>262144)throw new RangeError('Output exceeds the browser download budget');chunks.push(chunk);},commit:()=>{
            const url=URL.createObjectURL(new Blob(chunks.map((chunk)=>chunk+'\n'),{type:'application/x-ndjson'}));
            const anchor=document.createElement('a');anchor.href=url;anchor.download='selection.jsonl';anchor.click();URL.revokeObjectURL(url);
          },abort:()=>{chunks.length=0;}});
          status.textContent=result.state==='complete' ? say('site/collection/exported', { count: result.rows }) : say('site/collection/export-failed', { reason: result.reason });
        });
        host.appendChild(button);
      }).catch((error) => { if (!disposed) status.textContent=say('site/collection/unavailable', { reason: error.message }); });
      return { ready, async dispose() { disposed=true; render.destroy(); if(collection) await collection.dispose(); await ready; await close?.(); } };
    },
    // The route's mode is the widget key. Other app renders keep this owned source.
    update() {},
    unmount(handle) { void handle.dispose(); },
  };
}
