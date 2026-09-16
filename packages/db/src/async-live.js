//@ts-check
/** Optional asynchronous live maintenance over the shared durable journal. */
import { DbCompileError, DbRuntimeError } from './errors.js';
import { createLiveExecutor } from './live-executor.js';
import { readRevisionSnapshot } from './snapshot.js';
import { isCursorBudgetError } from './cursor.js';
import { createLatestDelivery } from '@jarenjs/core/async';

/** Select bounded resnapshot maintenance for asynchronous hosts. Pass the
 * returned configuration as openStore's live option. Synchronous hosts retain
 * incremental maintenance unless a query explicitly requests resnapshot mode.
 * @param {import('../types/async-live.js').AsyncLiveOptions} [options]
 * @returns {import('../types/index.js').LiveBounds} */
export function asyncLive(options = {}) {
  const defaults = { maxQueries: 64, maxMaintained: 10000, maxBytes: 4194304,
    maxInputRows: 10000, maxInputBytes: 4194304, maxObservers: 8,
    pollMs: 1000, pageRows: 32, maxAttempts: 3 };
  const bounds = { ...defaults, ...options };
  for (const key of Object.keys(defaults))
    if (!Number.isSafeInteger(bounds[key]) || bounds[key] < 1 || bounds[key] >= Number.MAX_SAFE_INTEGER)
      throw new TypeError(`asyncLive.${key} must be a positive safe integer`);
  if (bounds.pollMs > 2147483647) throw new TypeError('asyncLive.pollMs exceeds the timer range');
  return Object.freeze({ ...bounds, resnapshot: (context) => strategy(context, bounds) });
}

function strategy(context, bounds) {
  const controller = new AbortController(), observers = new Map();
  let executor = createLiveExecutor(context.snapshotContext, bounds, controller.signal);
  let closed = false, dirty = true, epoch = 0, checkpoint = 0, busy = null, initializing = null, timer;
  let publish, fail, latestRows = [], lag = false;
  const counters = { reruns: 0, resets: 0, coalesced: 0, reads: 0 };
  const arm = (delay = bounds.pollMs) => {
    clearTimeout(timer);
    if (!closed && publish) {
      timer = setTimeout(() => { refresh(); }, delay);
      timer.unref?.();
    }
  };
  const take = () => readRevisionSnapshot(
    async () => (await context.feed.bounds()).highWatermark,
    async () => { counters.reruns++; return executor.execute(); });
  const initialize = async () => {
    for (let attempt = 0; attempt < bounds.maxAttempts; attempt++) {
      const loaded = await context.run(take, controller.signal, true);
      if (closed) throw new DbRuntimeError('JD2072', 'resnapshot registration was closed');
      if (loaded.consistent) {
        checkpoint = loaded.revision; dirty = false; latestRows = loaded.value;
        return loaded.value;
      }
    }
    throw new DbRuntimeError('JD2060', 'resnapshot could not establish a stable revision within its attempt credits');
  };
  const cycle = async () => {
    const mine = epoch;
    dirty = false;
    let reset = false;
    const outcome = await context.run(async () => {
      let page;
      try {
        page = await context.feed.page({ after: checkpoint, limit: bounds.pageRows,
          maxBytes: bounds.maxBytes, signal: controller.signal });
        counters.reads++;
      }
      catch (error) {
        if (!isCursorBudgetError(error) && error?.code !== 'JD2092') throw error;
        // An indivisible log record may exceed this reader's page credits.
        // Resnapshot authoritatively rather than silently skipping that record.
        page = { resetRequired: true, items: [] };
      }
      reset = page.resetRequired === true;
      if (reset || page.hasMore || page.items.some((record) =>
        record.collections.some((name) => context.tables.has(name))))
        return take();
      return { revision: page.next ?? checkpoint, consistent: true, value: null };
    }, controller.signal, false);
    if (closed) return;
    if (!outcome.consistent || mine !== epoch) {
      dirty = true; lag = true; return;
    }
    checkpoint = outcome.revision;
    lag = false;
    if (reset) counters.resets++;
    if (outcome.value !== null) {
      latestRows = context.share(latestRows, outcome.value);
      publish({ rows: latestRows, seq: checkpoint, resetRequired: reset, lag: false });
    }
  };
  const refresh = () => {
    if (closed) return Promise.resolve();
    if (busy) { dirty = true; counters.coalesced++; return busy; }
    clearTimeout(timer);
    // Reserve before calling any injected capability, including synchronous
    // transaction adapters. Reentrant refresh never creates another evaluation.
    const pending = Promise.withResolvers();
    busy = pending.promise.finally(() => { busy = null; arm(); });
    pending.resolve((async () => {
      try {
        for (let attempt = 0; attempt < bounds.maxAttempts; attempt++) {
          await cycle();
          if (closed || !dirty) return;
        }
        lag = true;
        publish({ rows: latestRows, seq: checkpoint, resetRequired: false, lag: true });
      }
      catch (error) { if (!closed) fail(error); }
    })());
    return busy;
  };
  return {
    init() {
      initializing = initialize().finally(() => { initializing = null; });
      return initializing;
    },
    entries: (rows) => rows.length,
    stats: () => ({ ...counters, ...executor?.stats(), checkpoint, lag,
      pending: busy || initializing ? 1 : 0, subscriptions: observers.size,
      observerPending: [...observers.values()].reduce((sum, entry) => sum + entry.pending(), 0) }),
    start(onChange, onError) { publish = onChange; fail = onError; arm(0); },
    invalidate(record) {
      if (record.seq > checkpoint) { dirty = true; epoch++; arm(0); }
    },
    refresh,
    subscribe(fn) {
      if (typeof fn !== 'function') throw new TypeError('live observer must be a function');
      if (!observers.has(fn) && observers.size >= bounds.maxObservers)
        throw new DbCompileError('JD0052', 'resnapshot observer credits exhausted');
      const entry = observers.get(fn) ?? createLatestDelivery(fn, (event) => ({ ...event,
        patch: [{ op: 'replace', path: '/rows', value: latestRows }], coalesced: true }));
      observers.set(fn, entry);
      return () => { entry.close(); if (observers.get(fn) === entry) observers.delete(fn); };
    },
    emit(event) { for (const entry of [...observers.values()]) entry.notify(event); },
    close() {
      if (!closed) {
        closed = true; clearTimeout(timer); controller.abort();
        for (const entry of observers.values()) entry.close();
        observers.clear(); publish = null; fail = null; latestRows = [];
      }
      return Promise.allSettled([busy, initializing]).then(() => { executor = null; });
    },
  };
}
