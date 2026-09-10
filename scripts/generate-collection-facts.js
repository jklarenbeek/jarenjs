//@ts-check
import {readFileSync} from 'node:fs';
/** Collection evidence is derived from committed measurements and the frozen consumer budgets. */
export const collectionFacts={name:'collection measurements',docs:()=>['benchmark/README.md','components/collection/docs/MEASUREMENTS.md'],facts:()=>({
  'collection.measurements':()=>{
    const result=JSON.parse(readFileSync(new URL('../benchmark/collection-result.json',import.meta.url),'utf8'));
    const manifest=JSON.parse(readFileSync(new URL('../test/adoption/manifest.json',import.meta.url),'utf8'));
    if(result.freezeHash!==manifest.freezeHash)throw new Error('Collection measurements use another fixture freeze');
    return `\n\nMeasured on ${result.runtime.node}, ${result.runtime.platform}/${result.runtime.arch}, ${result.runtime.cpu}.\n\n`
      +'| Consumer | Rows | Reference range ms | Native range/view/interaction p95 ms | Cells | Cached rows / bytes | Measurements / accounted bytes | Heap MiB | Teardown ms |\n'
      +'|---|---:|---:|---:|---:|---|---|---:|---:|\n'
      +result.consumers.map(r=>`| ${r.consumer} | ${r.rows} | ${r.freshReferenceRangeMs.toFixed(3)} | ${r.metrics.grid.interactionMs.toFixed(3)} | ${r.metrics.grid.mountedCells} | ${r.metrics.grid.loadedRows} / ${r.metrics.grid.loadedBytes} | ${r.measurement.peakMeasurements} / ${r.measurement.measurementBytes} | ${(r.metrics.resources.sampledHeapBytes/1048576).toFixed(2)} | ${r.metrics.resources.teardownMs.toFixed(3)} |`).join('\n')
      +`\n\nThe component and coordinator browser bundle is ${result.browserGzipBytes} gzip bytes. Reference range calls do less work than native vnode and interaction calls; the comparison deliberately publishes that cost rather than claiming equal workloads.\n\n`;
  },
  'collection.browser':()=>{
    const previous=JSON.parse(readFileSync(new URL('../benchmark/collection-browser-loaded-result.json',import.meta.url),'utf8'));
    const results=['chromium','firefox','webkit'].map(engine=>JSON.parse(readFileSync(new URL(`../benchmark/collection-browser-${engine}.json`,import.meta.url),'utf8')));
    return `\n\nLinux container, Node ${results[0].node}, ${results[0].workers} browser workers. Each sample set contains ${results[0].samples} synchronous viewport changes after the near-ceiling check.\n\n`
      +'| Engine / version | DOM interaction p95 ms | Earlier full-matrix p95 ms | Peak cells | CSS extent / final offset | Remaining resources |\n'
      +'|---|---:|---:|---:|---|---:|\n'
      +results.map(r=>`| ${r.engine} ${r.browser} | ${r.interactionMs.toFixed(2)} | ${previous.results[r.engine].toFixed(2)} | ${r.mountedCells} | ${r.extent} / ${r.end} | ${r.remaining} |`).join('\n')
      +`\n\nThe earlier loaded WebKit sample exceeded the fixed-profile ${previous.fixedBudgetMs} ms target. Browser latency varies with concurrent load; these measurements do not establish a universal frame-time guarantee.\n\n`;
  },
})};
