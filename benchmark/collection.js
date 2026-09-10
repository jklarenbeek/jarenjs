//@ts-check
/** Repeatable geometry, source, cache and teardown costs over frozen public consumer profiles. */
import {readFileSync,writeFileSync} from 'node:fs';
import {cpus,release} from 'node:os';
import {gzipSync} from 'node:zlib';
import {build} from 'esbuild';
import {performance} from 'node:perf_hooks';
import {createVirtualAxis} from '@jarenjs/core/virtual';
import {createCollection,createCollectionInteraction} from '@jarenjs/collection';
import {createCollectionCoordinator,createArrayRangeProvider} from '@jarenjs/app';
import {readAdoption,verifyFreeze,assessBudget} from '../test/adoption/evidence.js';
import {referenceGrid} from '../test/adoption/oracles.js';
const manifest=readAdoption('manifest.json');verifyFreeze(manifest);
const fixture=readAdoption('fixtures/grid.json'),historical=JSON.parse(readFileSync(new URL('./adoption-result.json',import.meta.url)));
const bundled=await build({stdin:{contents:"export * from '@jarenjs/collection/component'; export {createCollectionCoordinator,createArrayRangeProvider} from '@jarenjs/app';",resolveDir:process.cwd()},bundle:true,write:false,minify:true,platform:'browser',format:'esm'});
const browserGzipBytes=gzipSync(bundled.outputFiles[0].contents).length;
const consumers=[];
for(const definition of manifest.consumers){
  const profile=fixture[definition.grid];globalThis.gc?.();
  const axis=createVirtualAxis({...profile,maxMeasurements:256,maxBytes:32768});
  const source=Array.from({length:definition.rows},(_,i)=>({id:`row-${i}`,label:`Item ${i}`}));
  const provider=createArrayRangeProvider(source),coordinator=createCollectionCoordinator(provider);
  const c=createCollection({count:profile.count,rowSize:profile.estimateSize,overscan:profile.overscan,columnCount:profile.columns,
    columnSize:160,keyAt:i=>coordinator.keyAt(i),getItem:i=>coordinator.rowAt(i),renderCell:row=>row.label,maxCells:definition.budgets.grid.mountedCells});
  const interaction=createCollectionInteraction({count:profile.count,keyAt:i=>coordinator.keyAt(i),indexOf:key=>coordinator.indexOf(key)});
  let mountedCells=0,loadedRows=0,loadedBytes=0,peakMeasurements=0,measurementBytes=0;
  const samples=[],referenceSamples=[];
  for(let pass=0;pass<2;pass++)for(let index=0;index<profile.count;index++){
    axis.measure(index,`row-${index}`,profile.estimateSize+(index%3)*4);
    const stats=axis.stats();peakMeasurements=Math.max(peakMeasurements,stats.measurements);measurementBytes=Math.max(measurementBytes,stats.bytes);
    if(index%1024===0){
      await coordinator.requestRange({start:index,end:index+64});
      const began=performance.now();c.viewport({top:index*profile.estimateSize,width:640,height:profile.viewport});c.view();
      interaction.focusIndex(index);interaction.key({key:'ArrowDown'});samples.push(performance.now()-began);
      const resources=coordinator.stats();loadedRows=Math.max(loadedRows,resources.rows);loadedBytes=Math.max(loadedBytes,resources.bytes);mountedCells=Math.max(mountedCells,c.stats().cells);
    }
  }
  for(const offset of profile.offsets){const r=referenceGrid(profile,offset),began=performance.now();r.virtualizer.getVirtualItems();referenceSamples.push(performance.now()-began);r.dispose();}
  samples.sort((a,b)=>a-b);const interactionMs=samples[Math.floor(samples.length*.95)];
  const before=process.memoryUsage(),start=performance.now();c.dispose();axis.dispose();await coordinator.dispose();
  const teardownMs=performance.now()-start;
  const metrics={grid:{interactionMs,mountedCells,loadedRows,loadedBytes,browserGzipBytes},resources:{sampledHeapBytes:before.heapUsed,peakRssBytes:process.resourceUsage().maxRSS*1024,teardownMs,remainingHandles:coordinator.stats().inFlight}};
  consumers.push({consumer:definition.id,rows:definition.rows,profile:definition.grid,baseline:historical.consumers.find(x=>x.consumer===definition.id)?.metrics,
    metrics,measurement:{passes:2,rowsMeasured:profile.count*2,peakMeasurements,measurementBytes},freshReferenceRangeMs:Math.max(...referenceSamples),
    budgets:{grid:assessBudget(definition.budgets.grid,metrics.grid),resources:assessBudget(definition.budgets.resources,metrics.resources)}});
}
const report={freezeHash:manifest.freezeHash,runtime:{node:process.version,platform:process.platform,arch:process.arch,cpu:cpus()[0].model,os:release()},
  scope:'Node geometry/vnode/interaction plus resident synthetic array and bounded page coordinator. Browser layout/paint and real AT/OS IME are separate measurements. Historical reference heap includes other adoption workloads and is not a like-for-like collection heap comparison.',
  browserGzipBytes,consumers};
writeFileSync(new URL('./collection-result.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
if(consumers.some(consumer=>Object.values(consumer.budgets).flat().some(metric=>metric.status==='fail'))) process.exitCode=1;
