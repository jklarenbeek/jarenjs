//@ts-check
/** Shared structural range protocol and resident-array provider. */
import { isJsonValue } from '../object.js';
import { resolveRuntime } from '../runtime.js';

/** JSON wire byte cost. @param {any} value */
export const rangeBytes = (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
/** Echo request identity. @param {any} request */
export const rangeIdentity = (request) => Object.fromEntries(['generation', 'requestId', 'query', 'snapshot'].map((key) => [key, request[key]]));
/** Validate finite request credits. @param {any} credits */
export const validRangeCredits = (credits) => ['pages', 'rows', 'bytes', 'work'].every((key) => Number.isSafeInteger(credits?.[key]) && credits[key] >= 0);
/** Validate a half-open logical range. @param {any} range */
export const validLogicalRange = (range) => range && Number.isSafeInteger(range.start) && Number.isSafeInteger(range.end) && range.start >= 0 && range.end >= range.start;

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
    rows = copy; indices = index; sizes = rows.map(rangeBytes); sourceBytes = sizes.reduce((n, size) => n + size, 2 + Math.max(0, rows.length - 1));
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
      const request = structuredClone(input), identity = rangeIdentity(request), used = { pages: 0, rows: 0, bytes: 0, work: 0 };
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
        if (!validRangeCredits(request.credits)) return refuse('error', 'invalid-credits');
        let range = request.range;
        if (request.continuation != null) {
          range = cursors.get(request.continuation);
          if (!range) return refuse('invalidated', 'continuation-changed');
        }
        if (!validLogicalRange(range)) return refuse('error', 'invalid-range');
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
