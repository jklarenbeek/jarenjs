//@ts-check
/** Injected range coordination. Rows and handles remain private; observations contain JSON only. */

import { deepFreeze, isJsonValue } from '@jarenjs/core/object';
import { resolveRuntime } from '@jarenjs/core/runtime';

const bytesOf = (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const identityOf = (request) => Object.fromEntries(['generation', 'requestId', 'query', 'snapshot'].map((key) => [key, request[key]]));
const validCredits = (credits) => ['pages', 'rows', 'bytes', 'work'].every((key) => Number.isSafeInteger(credits?.[key]) && credits[key] >= 0);
const validRange = (range) => range && Number.isSafeInteger(range.start) && Number.isSafeInteger(range.end) && range.start >= 0 && range.end >= range.start;

/**
 * A resident-array provider. The immutable source copy and key index are reported separately
 * from requested pages; virtual DOM does not make this resident source bounded by page credits.
 * @param {any[]} initialRows @param {any} [options]
 */
export function createArrayRangeProvider(initialRows, options = {}) {
  const source = options.source ?? resolveRuntime(options.runtime).uuid();
  const query = options.query ?? source, keyOf = options.keyOf ?? ((row) => String(row.id));
  let snapshot = options.snapshot ?? `${source}-v1`, revision = 0, disposed = false, ticket = 0, generation = -1;
  let rows = [], sizes = [], indices = new Map(), sourceBytes = 0;
  const pending = new Set(), observers = new Set(), cursors = new Map();
  const maxPages = options.maxPages ?? 4, maxRows = options.maxRows ?? 256, maxBytes = options.maxBytes ?? 262144;
  const maxInFlight = options.maxInFlight ?? 2;
  for (const limit of [maxPages, maxRows, maxBytes, maxInFlight])
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new RangeError('Invalid provider credits');
  function load(input) {
    if (!Array.isArray(input) || !isJsonValue(input)) throw new TypeError('Array provider rows must be JSON');
    const copy = structuredClone(input), index = new Map();
    copy.forEach((row, i) => { const key = keyOf(row);
      if (typeof key !== 'string' || index.has(key)) throw new TypeError('Array keys must be unique strings');
      index.set(key, i); });
    // Returned rows are copies, so callers cannot mutate the complete source snapshot.
    rows = copy; indices = index; sizes = rows.map(bytesOf); sourceBytes = sizes.reduce((n, size) => n + size, 2 + Math.max(0, rows.length - 1));
  }
  load(initialRows);
  const capabilities = Object.freeze({ seekIndex: options.seekIndex !== false, seekKey: true, continuation: true,
    exactTotal: options.exactTotal !== false, live: true, completeExport: true });
  const provider = {
    query, get snapshot() { return snapshot; }, capabilities,
    indexOf(key) { return indices.get(key) ?? -1; },
    stats() { return { rows: rows.length, bytes: sourceBytes, pages: cursors.size, pending: pending.size, subscriptions: observers.size }; },
    replace(next, identity) {
      if (disposed) throw new Error('Provider disposed');
      if (typeof identity !== 'string' || identity === snapshot) throw new TypeError('Replacement needs a new source snapshot');
      load(next); snapshot = identity; cursors.clear(); ticket++;
      const event = { type: 'reset', revision: ++revision, query, snapshot };
      for (const fn of observers) { try { fn(event); } catch { /* Subscribers cannot suppress sibling invalidations. */ } }
    },
    subscribe(fn) {
      if (disposed) throw new Error('Provider disposed');
      if (observers.size >= 8) throw new RangeError('Subscription credits');
      observers.add(fn); return () => observers.delete(fn);
    },
    request(input, signal) {
      const request = structuredClone(input), identity = identityOf(request), used = { pages: 0, rows: 0, bytes: 0, work: 0 };
      const refuse = (state, reason) => ({ ...identity, state, reason, used });
      if (disposed) return Promise.resolve(refuse('error', 'disposed'));
      if (signal?.aborted) return Promise.resolve(refuse('error', 'cancelled'));
      if (pending.size >= maxInFlight) return Promise.resolve(refuse('budget-exhausted', 'in-flight'));
      if (!Number.isSafeInteger(request.generation) || request.generation < 0 || typeof request.requestId !== 'string')
        return Promise.resolve(refuse('error', 'invalid-identity'));
      if (request.generation < generation) return Promise.resolve(refuse('invalidated', 'query-changed'));
      generation = request.generation;
      const current = ++ticket;
      const run = async () => {
        await Promise.resolve();
        if (disposed) return refuse('error', 'disposed');
        if (signal?.aborted) return refuse('error', 'cancelled');
        if (current !== ticket || request.query !== query || request.snapshot !== snapshot) return refuse('invalidated', 'source-changed');
        if (!validCredits(request.credits)) return refuse('error', 'invalid-credits');
        let range = request.range;
        if (request.continuation != null) {
          range = cursors.get(request.continuation);
          if (!range) return refuse('invalidated', 'continuation-changed');
        }
        if (!validRange(range)) return refuse('error', 'invalid-range');
        const length = range.end - range.start;
        if (!request.continuation && range.start > 0 && !capabilities.seekIndex) return refuse('error', 'unsupported-seek');
        if (request.credits.pages < 1 || request.credits.rows < length || request.credits.work < length || request.credits.bytes < 2
          || length > maxRows) return refuse('budget-exhausted', 'credits');
        const end = Math.min(range.end, rows.length), count = Math.max(0, end - range.start);
        let bytes = 2 + Math.max(0, count - 1);
        for (let i = range.start; i < end; i++) bytes += sizes[i];
        used.work = count; used.pages = 1;
        if (bytes > request.credits.bytes || bytes > maxBytes) return refuse('budget-exhausted', 'credits');
        const items = structuredClone(rows.slice(range.start, end));
        let continuation = null;
        if (length && range.end < rows.length) {
          continuation = `${snapshot}:${current}`;
          while (cursors.size >= maxPages) cursors.delete(cursors.keys().next().value);
          cursors.set(continuation, { start: range.end, end: range.end + length });
        }
        return { ...identity, state: 'ready', rows: items, keys: items.map(keyOf), continuation,
          total: capabilities.exactTotal ? { kind: 'known', value: rows.length } : { kind: 'unknown' },
          used: { pages: 1, rows: items.length, bytes, work: items.length } };
      };
      const promise = run().finally(() => pending.delete(promise)); pending.add(promise); return promise;
    },
    async *export(request, signal) {
      const { pageRows = 64, pageBytes = maxBytes } = request;
      if (!Number.isSafeInteger(pageRows) || pageRows <= 0 || pageRows > maxRows || !Number.isSafeInteger(pageBytes) || pageBytes < 2)
        throw new RangeError('Invalid export credits');
      const total = rows.length;
      for (let start = 0; start < total; start += pageRows) {
        await Promise.resolve();
        if (disposed || signal?.aborted || request.query !== query || request.snapshot !== snapshot) throw new Error('Incomplete snapshot export');
        const end = Math.min(total, start + pageRows);
        let bytes = 2 + Math.max(0, end - start - 1);
        for (let i = start; i < end; i++) bytes += sizes[i];
        if (bytes > Math.min(maxBytes, pageBytes)) throw new RangeError('Export byte credits');
        const items = structuredClone(rows.slice(start, end));
        yield { state: 'ready', rows: items, keys: items.map(keyOf), query, snapshot };
      }
      if (disposed || signal?.aborted || request.query !== query || request.snapshot !== snapshot) throw new Error('Incomplete snapshot export');
      yield { state: 'complete', total, query, snapshot };
    },
    async dispose() { disposed = true; ticket++; observers.clear(); await Promise.allSettled([...pending]);
      cursors.clear(); rows = []; sizes = []; indices.clear(); sourceBytes = 0; },
  };
  return provider;
}

/**
 * Coordinate an injected provider with finite pages, bytes, requests and prefetch. The host owns
 * provider construction; by default coordinator disposal also drains the provider.
 * @param {any} provider @param {any} [options]
 */
export function createCollectionCoordinator(provider, options = {}) {
  const bounds = { pageRows: 64, maxPages: 4, maxRows: 256, maxBytes: 262144, maxInFlight: 2, maxOutputs: 1, maxSubscriptions: 8, prefetchPages: 0, work: 256, ...options };
  for (const name of ['pageRows', 'maxPages', 'maxRows', 'maxBytes', 'maxInFlight', 'maxOutputs', 'maxSubscriptions', 'work'])
    if (!Number.isSafeInteger(bounds[name]) || bounds[name] <= 0) throw new RangeError(`Invalid ${name}`);
  if (!Number.isSafeInteger(bounds.prefetchPages) || bounds.prefetchPages < 0 || bounds.prefetchPages >= bounds.maxPages
    || bounds.pageRows > bounds.maxRows) throw new RangeError('Invalid prefetch credits');
  let query = provider.query, snapshot = provider.snapshot, generation = 1, ticket = 0, disposed = false, revision = -1;
  let observation = { state: 'loading', query, snapshot, generation, total: { kind: 'unknown' }, loadedRows: 0, loadedBytes: 0 };
  let cursor = null, frontier = 0, exhausted = false;
  const pages = new Map(), pending = new Map(), subscribers = new Set(), outputs = new Set();
  let pinnedKeys = new Set();
  function stats() { return { pages: pages.size, rows: [...pages.values()].reduce((n, p) => n + p.rows.length, 0),
    bytes: [...pages.values()].reduce((n, p) => n + p.bytes, 0), inFlight: pending.size, outputs: outputs.size }; }
  function publish(change) {
    if (disposed) return;
    const cost = stats(); observation = { ...observation, ...change, query, snapshot, generation, loadedRows: cost.rows, loadedBytes: cost.bytes };
    for (const key of Object.keys(observation)) if (observation[key] === undefined) delete observation[key];
    for (const fn of subscribers) { try { fn(structuredClone(observation)); } catch (error) { options.onError?.(error); } }
    try { options.onChange?.(structuredClone(observation)); } catch (error) { options.onError?.(error); }
  }
  function cancel() { for (const controller of pending.keys()) controller.abort(); }
  function reset(identity = {}) {
    generation++; ticket++; cancel(); pages.clear(); cursor = null; frontier = 0; exhausted = false;
    query = identity.query ?? provider.query; snapshot = identity.snapshot ?? provider.snapshot;
    publish({ state: 'invalidated', total: { kind: 'unknown' } });
  }
  const unsubscribe = provider.subscribe?.((event) => {
    if (disposed || event.query !== query || !Number.isSafeInteger(event.revision) || event.revision <= revision) return;
    revision = event.revision;
    // A patch shape alone does not prove incremental maintenance; reset safely at the source epoch.
    reset(event);
  });
  async function load(start, continuation, current, signal) {
    const request = { generation, requestId: String(current), query, snapshot,
      ...(continuation ? { continuation } : { range: { start, end: start + bounds.pageRows } }),
      credits: { pages: 1, rows: bounds.pageRows, bytes: bounds.maxBytes, work: bounds.work } };
    const identity = identityOf(request);
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const run = async () => {
      try {
        const response = await provider.request(request, controller.signal);
        if (disposed || current !== ticket || request.generation !== generation || controller.signal.aborted)
          return { state: 'invalidated', reason: 'superseded' };
        if (Object.keys(identity).some((key) => response?.[key] !== identity[key])) {
          publish({ state: 'invalidated', reason: 'identity-mismatch' });
          return { state: 'invalidated', reason: 'identity-mismatch' };
        }
        if (response.state !== 'ready') { publish({ state: response.state, reason: response.reason }); return response; }
        const bytes = bytesOf(response.rows);
        if (!Array.isArray(response.rows) || !Array.isArray(response.keys) || response.rows.length !== response.keys.length
          || response.rows.length > bounds.pageRows || bytes > bounds.maxBytes || new Set(response.keys).size !== response.keys.length
          || !response.keys.every((key) => typeof key === 'string') || !validCredits(response.used)
          || Object.keys(request.credits).some((key) => response.used[key] > request.credits[key])
          || response.used.bytes !== bytes || response.used.rows !== response.rows.length
          || !['known', 'unknown'].includes(response.total?.kind)
          || (response.total.kind === 'known' && (!Number.isSafeInteger(response.total.value) || response.total.value < start + response.rows.length)))
          { publish({ state: 'error', reason: 'invalid-response' }); return { state: 'error', reason: 'invalid-response' }; }
        pages.delete(start);
        while (pages.size && (pages.size >= bounds.maxPages || stats().rows + response.rows.length > bounds.maxRows || stats().bytes + bytes > bounds.maxBytes)) {
          const evict = [...pages].find(([, page]) => !page.keys.some((key) => pinnedKeys.has(key)));
          if (!evict) { publish({state:'budget-exhausted',reason:'pinned-page-credits'}); return {state:'budget-exhausted',reason:'pinned-page-credits'}; }
          pages.delete(evict[0]);
        }
        pages.set(start, { rows: deepFreeze(structuredClone(response.rows)), keys: response.keys.slice(), bytes });
        if (start >= frontier) { frontier = start + response.rows.length; cursor = response.continuation; exhausted = !cursor; }
        publish({ state: 'ready', reason: undefined, total: response.total });
        return { state: 'ready', start, end: start + response.rows.length, continuation: response.continuation, total: response.total };
      }
      catch (error) {
        if (disposed || current !== ticket) return { state: 'invalidated', reason: 'superseded' };
        publish({ state: 'error', reason: 'source-failure' }); return { state: 'error', reason: 'source-failure', error };
      }
    };
    const promise = Promise.resolve().then(run).finally(() => { pending.delete(controller); signal?.removeEventListener('abort', abort); });
    pending.set(controller, promise); return promise;
  }
  async function requestRange(range, signal) {
    if (disposed) return { state: 'error', reason: 'disposed' };
    if (!validRange(range)) return { state: 'error', reason: 'invalid-range' };
    if (signal?.aborted) return { state: 'error', reason: 'cancelled' };
    const first = provider.capabilities.seekIndex ? Math.floor(range.start / bounds.pageRows) * bounds.pageRows : range.start;
    if (!provider.capabilities.seekIndex && first !== 0 && !(first === frontier && cursor))
      return { state: 'error', reason: 'unsupported-seek' };
    const count = Math.ceil((range.end - first) / bounds.pageRows);
    if (count > bounds.maxPages || count * bounds.pageRows > bounds.maxRows) return { state: 'budget-exhausted', reason: 'page-credits' };
    cancel(); const current = ++ticket;
    if (pending.size >= bounds.maxInFlight) return { state: 'budget-exhausted', reason: 'in-flight' };
    publish({ state: 'loading', reason: undefined });
    let result = { state: 'ready' };
    const admitted = Math.min(Math.floor(bounds.maxRows / bounds.pageRows), bounds.maxPages, count + (provider.capabilities.seekIndex ? bounds.prefetchPages : 0));
    for (let page = 0; page < admitted; page++) {
      const start = first + page * bounds.pageRows;
      result = await load(start, provider.capabilities.seekIndex ? null : start === 0 ? null : cursor, current, signal);
      if (result.state !== 'ready' || current !== ticket || disposed) return result;
      if (result.end - result.start < bounds.pageRows || !result.continuation) break;
    }
    if (count === 0) publish({ state: 'ready' });
    return result;
  }
  const coordinator = {
    provider, requestRange, reset, stats,
    pinKeys(keys = []) {
      if (!Array.isArray(keys) || keys.length > bounds.maxRows || !keys.every((key) => typeof key === 'string'))
        return {state:'budget-exhausted',reason:'pin-credits'};
      pinnedKeys = new Set(keys); return {state:'ready'};
    },
    observation() { return structuredClone(observation); },
    subscribe(fn) { if (disposed) throw new Error('Coordinator disposed');
      if (subscribers.size >= bounds.maxSubscriptions) throw new RangeError('Subscription credits');
      subscribers.add(fn); return () => subscribers.delete(fn); },
    rowAt(index) { for (const [start, page] of pages) if (index >= start && index < start + page.rows.length) return page.rows[index - start]; },
    keyAt(index) { for (const [start, page] of pages) if (index >= start && index < start + page.rows.length) return page.keys[index - start]; return null; },
    indexOf(key) {
      for (const [start, page] of pages) { const i = page.keys.indexOf(key); if (i >= 0) return start + i; }
      return provider.capabilities.seekKey ? provider.indexOf?.(key) ?? -1 : -1;
    },
    logicalCount() { return observation.total.kind === 'known' ? observation.total.value : frontier + (exhausted ? 0 : 1); },
    async next(signal) { if (exhausted) return {state:'ready',start:frontier,end:frontier,continuation:null,total:observation.total}; return requestRange({ start: frontier, end: frontier + bounds.pageRows }, signal); },
    /** @param {any} sink @param {any} [options] */
    async output(sink, { selection, signal, pageRows = bounds.pageRows } = {}) {
      if (disposed || !provider.capabilities.completeExport || typeof provider.export !== 'function')
        return { state: 'error', reason: disposed ? 'disposed' : 'unsupported-export' };
      if (outputs.size >= bounds.maxOutputs) return {state:'budget-exhausted',reason:'output-credits'};
      if (selection && (selection.mode === 'all' || selection.ranges?.length) && (selection.query !== query || selection.snapshot !== snapshot))
        return { state: 'invalidated', reason: 'selection-snapshot' };
      const controller = new AbortController(), abort = () => controller.abort();
      signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
      const identity = { query, snapshot }, wanted = new Set(selection?.keys ?? []), excluded = new Set(selection?.exclusions ?? []);
      const ranges = (selection?.ranges ?? []).map((range) => ({ ...range, open: false, found: 0 }));
      let read = 0, written = 0, completed = false;
      const operation = Promise.resolve().then(async () => {
        try {
          await sink.begin?.(identity);
          for await (const page of provider.export({ ...identity, pageRows, pageBytes: bounds.maxBytes }, controller.signal)) {
            if (disposed || controller.signal.aborted || query !== identity.query || snapshot !== identity.snapshot
              || page.query !== identity.query || page.snapshot !== identity.snapshot || completed) throw new Error('Incomplete snapshot export');
            if (page.state === 'complete') { if (page.total !== read) throw new Error('Incomplete snapshot total'); completed = true; continue; }
            if (page.state !== 'ready' || page.rows.length !== page.keys.length || page.rows.length > pageRows || bytesOf(page.rows) > bounds.maxBytes)
              throw new Error('Invalid export page');
            const output = [];
            for (let i = 0; i < page.rows.length; i++) {
              const key = page.keys[i]; let inRange = false;
              for (const range of ranges) {
                const endpoint = key === range.fromKey || key === range.toKey;
                inRange ||= range.open || endpoint;
                if (endpoint) { range.found++; range.open = !range.open; if (range.fromKey === range.toKey) { range.open = false; range.found++; } }
              }
              const selected = !selection || (selection.mode === 'all' && !excluded.has(key)) || wanted.has(key) || inRange;
              wanted.delete(key); read++;
              if (selected) { output.push(page.rows[i]); written++; }
            }
            if (output.length) await sink.write(output);
          }
          if (!completed || wanted.size || ranges.some((range) => range.found !== 2)) throw new Error('Incomplete selection export');
          if (disposed || controller.signal.aborted || query !== identity.query || snapshot !== identity.snapshot) throw new Error('Incomplete snapshot export');
          await sink.commit({ ...identity, rows: written }); return { state: 'complete', rows: written };
        }
        catch (error) { await sink.abort?.(error); return { state: 'error', reason: 'incomplete-export', error }; }
      });
      outputs.add({ controller, operation });
      try { return await operation; }
      finally { signal?.removeEventListener('abort', abort); for (const item of outputs) if (item.operation === operation) outputs.delete(item); }
    },
    async dispose() {
      let failure, failed = false;
      if (!disposed) {
        disposed = true; ticket++; cancel(); subscribers.clear();
        try { unsubscribe?.(); } catch (error) { failure = error; failed = true; }
        for (const item of outputs) item.controller.abort();
      }
      await Promise.allSettled([...pending.values(), ...[...outputs].map((item) => item.operation)]);
      pages.clear(); cursor = null; pinnedKeys.clear();
      if (options.disposeProvider !== false) { try { await provider.dispose(); } catch (error) { if (!failed) { failure = error; failed = true; } } }
      if (failed) throw failure;
    },
  };
  return coordinator;
}
