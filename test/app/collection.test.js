//@ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createArrayRangeProvider, createCollectionCoordinator } from '@jarenjs/app';
import { rangeProviderContract, rangeRequest } from '../adoption/range-provider-contract.js';
const rows = Array.from({ length: 100 }, (_, i) => ({ id: `row-${i}`, value: i }));
rangeProviderContract('resident array', (options) => {
  const provider = createArrayRangeProvider(rows.slice(0, 10), { ...options, query: 'filter-sort-schema-v1', snapshot: 'source-v1' });
  return { provider, invalidate: (snapshot) => provider.replace(rows.slice(0, 10), snapshot), resources: () => provider.stats().pending };
});
const deferred = () => { let resolve; const promise = new Promise((fn) => { resolve = fn; }); return { promise, resolve }; };
const turn = () => new Promise(resolve => setImmediate(resolve));
function sink() {
  const pending = [], committed = [], events = [];
  return { pending, committed, events, begin: () => events.push('begin'), write: (rows) => pending.push(...rows),
    commit: () => { committed.push(...pending); events.push('commit'); }, abort: () => { pending.length = 0; events.push('abort'); } };
}
describe('bounded collection coordination', () => {
  it('evicts pages and keeps logical totals separate from resident pages', async () => {
    const provider = createArrayRangeProvider(rows), c = createCollectionCoordinator(provider, { pageRows: 8, maxPages: 2, maxRows: 16, maxBytes: 2000 });
    for (let pass = 0; pass < 2; pass++) for (let start = 0; start < rows.length; start += 8) {
      assert.equal((await c.requestRange({ start, end: start + 8 })).state, 'ready');
      assert.ok(c.stats().pages <= 2); assert.ok(c.stats().rows <= 16); assert.ok(c.stats().bytes <= 2000);
      assert.equal(c.logicalCount(), 100);
    }
    assert.equal(c.keyAt(0), null); assert.equal(c.rowAt(0), undefined); assert.equal(c.indexOf('row-2'), 2);
    assert.equal(c.indexOf('absent'), -1); assert.equal(c.observation().loadedRows, c.stats().rows);
    await c.dispose(); await c.dispose(); assert.deepEqual(c.stats(), {pages:0, rows:0, bytes:0, inFlight:0, outputs:0});
    assert.equal((await c.requestRange({ start:0,end:8 })).reason, 'disposed');
  });
  it('fences delayed old scroll and filter replies including ignored cancellation', async () => {
    const replies = [], provider = { query:'q', snapshot:'s', capabilities:{seekIndex:true},
      request(request) { const d = deferred(); replies.push({ ...d, request }); return d.promise; }, async dispose() {} };
    const c = createCollectionCoordinator(provider, {pageRows:2});
    const first = c.requestRange({start:0,end:2}); const second = c.requestRange({start:2,end:4});
    const answer = (n) => { const {request,resolve} = replies[n]; const items=rows.slice(n*2,n*2+2);
      resolve({...request,state:'ready',rows:items,keys:items.map(x=>x.id),total:{kind:'known',value:100},continuation:'next',
        used:{pages:1,rows:2,bytes:new TextEncoder().encode(JSON.stringify(items)).length,work:2}}); };
    await Promise.resolve();
    answer(1); assert.equal((await second).state,'ready'); answer(0); assert.equal((await first).reason,'superseded');
    assert.equal(c.keyAt(2),'row-2'); assert.equal(c.keyAt(0),null);
    const old = c.requestRange({start:0,end:2}); c.reset({query:'filtered',snapshot:'s2'}); await Promise.resolve(); answer(2);
    assert.equal((await old).reason,'superseded'); assert.equal(c.keyAt(2),null); await c.dispose();
  });
  it('uses a continuation sentinel and refuses sequential jumps without hidden reads', async () => {
    const p=createArrayRangeProvider(rows.slice(0,10),{seekIndex:false,exactTotal:false});
    const c=createCollectionCoordinator(p,{pageRows:3});
    assert.equal((await c.requestRange({start:7,end:10})).reason,'unsupported-seek');
    await c.requestRange({start:0,end:3}); assert.equal(c.logicalCount(),4); assert.deepEqual(c.observation().total,{kind:'unknown'});
    await c.next(); assert.equal(c.keyAt(3),'row-3'); await c.next(); await c.next();
    assert.equal(c.logicalCount(),10); assert.deepEqual(c.observation().total,{kind:'unknown'}); await c.dispose();
  });
  it('exports the complete selection after eviction and aborts incomplete snapshots', async () => {
    const p=createArrayRangeProvider(rows),c=createCollectionCoordinator(p,{pageRows:4,maxPages:1,maxRows:4});
    await c.requestRange({start:0,end:4}); await c.requestRange({start:80,end:84});
    const output=sink();
    assert.deepEqual(await c.output(output,{selection:{mode:'keys',keys:['row-1','row-90'],ranges:[],exclusions:[]}}),{state:'complete',rows:2});
    assert.deepEqual(output.committed.map(x=>x.id),['row-1','row-90']);
    const all=sink(); assert.equal((await c.output(all,{selection:{mode:'all',keys:[],ranges:[],exclusions:['row-2'],query:p.query,snapshot:p.snapshot}})).rows,99);
    const range=sink(); assert.equal((await c.output(range,{selection:{mode:'keys',keys:[],exclusions:[],ranges:[{fromKey:'row-7',toKey:'row-2'}],query:p.query,snapshot:p.snapshot}})).rows,6);
    const stale=sink(); assert.equal((await c.output(stale,{selection:{mode:'all',query:'old',snapshot:'old'}})).reason,'selection-snapshot');
    const missing=sink(); assert.equal((await c.output(missing,{selection:{mode:'keys',keys:['missing']}})).reason,'incomplete-export'); assert.equal(missing.committed.length,0);
    const cancelled=sink(),signal=new AbortController(); cancelled.write=()=>signal.abort();
    assert.equal((await c.output(cancelled,{signal:signal.signal})).reason,'incomplete-export'); assert.deepEqual(cancelled.events,['begin','abort']);
    const reset=sink(); reset.write=()=>p.replace(rows,'new-snapshot');
    assert.equal((await c.output(reset)).reason,'incomplete-export'); assert.equal(c.observation().state,'invalidated');
    await c.dispose();
  });
  it('drains output and outstanding requests on dispose and fences late publications', async () => {
    const p=createArrayRangeProvider(rows),events=[],c=createCollectionCoordinator(p,{pageRows:4,onChange:x=>events.push(x.state)});
    const pending=c.requestRange({start:0,end:4}); await c.dispose(); await pending;
    const count=events.length; await Promise.resolve(); assert.equal(events.length,count);
    assert.equal(p.stats().rows,0); assert.equal((await c.output(sink())).reason,'disposed');
    const p2=createArrayRangeProvider(rows),c2=createCollectionCoordinator(p2,{pageRows:4});
    const wait=deferred(), entered=deferred(),out=sink(); out.write=async()=>{entered.resolve();await wait.promise;};
    const job=c2.output(out); await entered.promise; const stop=c2.dispose(); wait.resolve(); await stop;
    assert.equal((await job).reason,'incomplete-export'); assert.equal(c2.stats().outputs,0);
  });
  it('refuses malformed inputs and resources without relaxing credits', async () => {
    const p=createArrayRangeProvider(rows),c=createCollectionCoordinator(p,{pageRows:4,maxPages:1,maxRows:4});
    assert.equal((await c.requestRange({start:-1,end:4})).reason,'invalid-range');
    assert.equal((await c.requestRange({start:0,end:8})).reason,'page-credits');
    const abort=new AbortController();abort.abort(); assert.equal((await c.requestRange({start:0,end:4},abort.signal)).reason,'cancelled');
    assert.equal((await p.request(rangeRequest({credits:{}}))).state,'invalidated');
    assert.throws(()=>createCollectionCoordinator(p,{maxPages:0}));
    assert.throws(()=>createCollectionCoordinator(p,{prefetchPages:10}));
    assert.throws(()=>createArrayRangeProvider([{id:'x'},{id:'x'}]));
    const stop=c.subscribe(()=>{});stop(); await c.dispose();
  });
});

it('protects editor pages within the same cache budgets and releases pins explicitly',async()=>{
  const p=createArrayRangeProvider(rows),c=createCollectionCoordinator(p,{pageRows:4,maxPages:1,maxRows:4});
  await c.requestRange({start:0,end:4});c.pinKeys(['row-1']);
  assert.equal((await c.requestRange({start:8,end:12})).reason,'pinned-page-credits');
  assert.equal(c.keyAt(1),'row-1');assert.equal(c.stats().pages,1);
  c.pinKeys();assert.equal((await c.requestRange({start:8,end:12})).state,'ready');
  assert.equal(c.pinKeys([1]).reason,'pin-credits');await c.dispose();
});
it('cancels an admitted request signal and reports malformed provider replies visibly',async()=>{
  const pending=deferred();let captured;
  const p={query:'q',snapshot:'s',capabilities:{seekIndex:true},request:async(request,signal)=>{captured=signal;await pending.promise;return {...request,state:'ready',rows:[],keys:[],total:{kind:'known',value:0},used:{pages:1,rows:0,bytes:2,work:0}};},async dispose(){}};
  const c=createCollectionCoordinator(p),abort=new AbortController(),job=c.requestRange({start:0,end:1},abort.signal);abort.abort();pending.resolve();
  assert.equal((await job).reason,'superseded');assert.equal(captured.aborted,true);await c.dispose();
  const bad={...p,request:async(request)=>({...request,query:'wrong'})};const b=createCollectionCoordinator(bad);
  await b.requestRange({start:0,end:1});assert.equal(b.observation().reason,'identity-mismatch');await b.dispose();
  const malformed={...p,request:async(request)=>({...request,state:'ready',rows:[{}],keys:[],used:{pages:1,rows:1,bytes:4,work:1}})};
  const m=createCollectionCoordinator(malformed);await m.requestRange({start:0,end:1});assert.equal(m.observation().reason,'invalid-response');await m.dispose();
});

it('publishes valid JSON observations and protects private cached rows from mutation',async()=>{
  const p=createArrayRangeProvider(rows),c=createCollectionCoordinator(p);
  await c.requestRange({start:0,end:4});
  const observation=c.observation();assert.deepEqual(JSON.parse(JSON.stringify(observation)),observation);
  assert.throws(()=>{c.rowAt(0).id='mutated';},TypeError);assert.equal(c.keyAt(0),'row-0');await c.dispose();
});

it('drains resources despite subscription cleanup failure and isolates observation failures',async()=>{
  const p=createArrayRangeProvider(rows),errors=[];
  const c=createCollectionCoordinator(p,{onChange(){throw new Error('observer failed');},onError:error=>errors.push(error)});
  await c.requestRange({start:0,end:4});assert.equal(c.observation().state,'ready');assert.ok(errors.length>=2);await c.dispose();
  let disposed=false;
  const bad={query:'q',snapshot:'s',capabilities:{},subscribe:()=>()=>{throw new Error('unsubscribe failed');},dispose:async()=>{disposed=true;}};
  const b=createCollectionCoordinator(bad);await assert.rejects(b.dispose(),/unsubscribe failed/);assert.equal(disposed,true);await b.dispose();
});

it('bounds concurrent complete outputs and subscriptions separately from page requests',async()=>{
  const p=createArrayRangeProvider(rows),c=createCollectionCoordinator(p,{maxSubscriptions:1});
  const stop=c.subscribe(()=>{});assert.throws(()=>c.subscribe(()=>{}),/Subscription credits/);stop();
  const wait=deferred(),entered=deferred();const output=c.output({async write(){entered.resolve();await wait.promise;},commit(){}});
  await entered.promise;assert.equal((await c.output(sink())).reason,'output-credits');wait.resolve();
  assert.equal((await output).state,'complete');await c.dispose();
});

it('reserves output admission before calling a reentrant sink',async()=>{
  const p=createArrayRangeProvider(rows.slice(0,2)),c=createCollectionCoordinator(p);
  let nested;
  const result=await c.output({begin(){nested=c.output(sink());},write(){},commit(){}});
  assert.equal(result.state,'complete');assert.equal((await nested).reason,'output-credits');await c.dispose();
});

it('charges resident byte-boundary work without cloning an oversized response',async()=>{
  const p=createArrayRangeProvider([{id:'a',body:'x'.repeat(1000)}],{query:'q',snapshot:'s'});
  const request={generation:1,requestId:'x',query:'q',snapshot:'s',range:{start:0,end:1},credits:{pages:1,rows:1,bytes:10,work:1}};
  const result=await p.request(request);assert.equal(result.state,'budget-exhausted');assert.equal(result.used.work,1);assert.equal(result.used.rows,0);
  await p.dispose();assert.throws(()=>createArrayRangeProvider([{id:'a',value:undefined}]),/must be JSON/);
});

it('keeps a known total for empty pages beyond the end of a resident source', async () => {
  for (const rows of [[], [{ id: 'a' }]]) {
    const provider = createArrayRangeProvider(rows), coordinator = createCollectionCoordinator(provider, { pageRows: 2 });
    try {
      const result = await coordinator.requestRange({ start: 4, end: 5 });
      assert.deepEqual(result, { state: 'ready', start: 4, end: 4, continuation: null, total: { kind: 'known', value: rows.length } });
      assert.equal(coordinator.logicalCount(), rows.length);
      assert.equal(coordinator.observation().state, 'ready');
    }
    finally { await coordinator.dispose(); }
  }
});

it('still rejects negative totals and nonempty pages beyond their known total', async () => {
  for (const [rows, total] of [[[], -1], [[{ id: 'a' }], 4]]) {
    const provider = { query: 'q', snapshot: 's', capabilities: { seekIndex: true }, dispose() {},
      request: async request => ({ ...request, state: 'ready', rows, keys: rows.map(row => row.id), total: { kind: 'known', value: total },
        used: { pages: 1, rows: rows.length, bytes: new TextEncoder().encode(JSON.stringify(rows)).length, work: rows.length } }) };
    const coordinator = createCollectionCoordinator(provider, { pageRows: 2 });
    try { assert.deepEqual(await coordinator.requestRange({ start: 4, end: 5 }), { state: 'error', reason: 'invalid-response' }); }
    finally { await coordinator.dispose(); }
  }
});

it('starts one owned-provider cleanup before draining dependent requests and output', async () => {
  const requestEntered = deferred(), exportEntered = deferred(), release = deferred(), disposed = deferred();
  let disposeCalls = 0, aborted = 0, nested;
  const provider = { query: 'q', snapshot: 's', capabilities: { seekIndex: true, completeExport: true },
    async request(request, signal) { signal.addEventListener('abort', () => { nested = coordinator.dispose(); }, { once: true }); requestEntered.resolve(); await release.promise; return { ...request, state: 'invalidated' }; },
    async *export() { exportEntered.resolve(); await release.promise; yield { state: 'complete', query: 'q', snapshot: 's', total: 0 }; },
    async dispose() { disposeCalls++; release.resolve(); await disposed.promise; } };
  const coordinator = createCollectionCoordinator(provider);
  const request = coordinator.requestRange({ start: 0, end: 1 });
  const output = coordinator.output({ write() {}, commit() { throw new Error('disposed output cannot commit'); }, abort() { aborted++; } });
  await Promise.all([requestEntered.promise, exportEntered.promise]);
  const stop = coordinator.dispose(), joined = coordinator.dispose();
  let settled = false; void stop.then(() => { settled = true; });
  try {
    await turn();
    assert.equal(disposeCalls, 1, 'owned cleanup must start before its pending source operations can finish');
    assert.equal(stop, joined); assert.equal(stop, nested);
    assert.equal(settled, false, 'all callers still await the provider disposal');
    assert.equal((await request).reason, 'superseded');
    assert.equal((await output).reason, 'incomplete-export');
    assert.equal(aborted, 1);
    disposed.resolve(); await Promise.all([stop, joined]);
    await coordinator.dispose(); assert.equal(disposeCalls, 1);
    assert.deepEqual(coordinator.stats(), { pages: 0, rows: 0, bytes: 0, inFlight: 0, outputs: 0 });
  }
  finally { release.resolve(); disposed.resolve(); await Promise.allSettled([request, output, stop, joined]); }
});

it('drains after synchronous provider cleanup failure and preserves the first unsubscribe error', async () => {
  const pending = deferred(), entered = deferred(); let calls = 0;
  const first = new Error('unsubscribe first'), second = new Error('provider second');
  const provider = { query: 'q', snapshot: 's', capabilities: { seekIndex: true },
    subscribe: () => () => { throw first; },
    async request(request) { entered.resolve(); await pending.promise; return { ...request, state: 'invalidated' }; },
    dispose() { calls++; pending.resolve(); throw second; } };
  const coordinator = createCollectionCoordinator(provider), request = coordinator.requestRange({ start: 0, end: 1 });
  await entered.promise;
  const stop = coordinator.dispose();
  const rejection = assert.rejects(stop, error => error === first);
  try { await turn(); assert.equal(calls, 1); await rejection; await request; assert.equal(coordinator.stats().inFlight, 0); await coordinator.dispose(); assert.equal(calls, 1); }
  finally { pending.resolve(); await Promise.allSettled([stop, request, rejection]); }
});

it('keeps borrowed providers owned by the host after coordinator teardown', async () => {
  const provider = createArrayRangeProvider([{ id: 'a' }]);
  const coordinator = createCollectionCoordinator(provider, { disposeProvider: false });
  await coordinator.requestRange({ start: 0, end: 1 });
  await coordinator.dispose(); await coordinator.dispose();
  assert.equal(provider.stats().rows, 1); assert.equal(provider.stats().subscriptions, 0);
  await provider.dispose(); assert.equal(provider.stats().rows, 0);
});

it('does not admit provider export after disposal while sink setup was awaiting', async () => {
  const begin = deferred(), entered = deferred(); let exports = 0, disposals = 0, aborts = 0;
  const provider = { query: 'q', snapshot: 's', capabilities: { completeExport: true },
    async *export() { exports++; yield { state: 'complete', query: 'q', snapshot: 's', total: 0 }; },
    dispose() { disposals++; } };
  const coordinator = createCollectionCoordinator(provider);
  const output = coordinator.output({ async begin() { entered.resolve(); await begin.promise; }, write() {}, commit() { throw new Error('cancelled output cannot commit'); }, abort() { aborts++; } });
  await entered.promise;
  const stop = coordinator.dispose();
  await turn(); begin.resolve();
  assert.equal((await output).reason, 'incomplete-export'); await stop;
  assert.equal(disposals, 1); assert.equal(exports, 0); assert.equal(aborts, 1);
});
