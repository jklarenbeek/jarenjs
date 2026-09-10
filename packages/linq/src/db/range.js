//@ts-check
/** Structural ranges over the store's cursors, keyset pages and committed capture. */
import { canonicalizeJson } from '@jarenjs/json/canonical';
import { resolveRuntime } from '@jarenjs/core/runtime';
import { deepFreeze } from '@jarenjs/core/object';

/** Open a bounded source. Resident mode obtains a complete, bounded source
 * snapshot before offering index seeks or an exact total. Sequential mode
 * admits only first pages and continuations through the store's keyset pager.
 * @param {any} store @param {string} entity @param {any} [spec]
 * @param {any} [options] @returns {Promise<any>} */
export async function createDbRangeProvider(store, entity, spec = {}, options = {}) {
  spec = structuredClone(spec);
  const keys = options.keys?.slice();
  if (!Array.isArray(keys) || !keys.length || keys.some((key) => typeof key !== 'string') || new Set(keys).size !== keys.length)
    throw new TypeError('range provider needs distinct logical key members');
  if (spec.take !== undefined || spec.skip !== undefined || spec.after !== undefined || spec.include !== undefined)
    throw new TypeError('range provider owns the window and serves root rows');
  const bounds = { rows: options.maxRows ?? 256, bytes: options.maxBytes ?? 262144,
    pages: options.maxPages ?? 4, inFlight: options.maxInFlight ?? 2, subscriptions: options.maxSubscriptions ?? 8 };
  if (!Object.values(bounds).every((n) => Number.isSafeInteger(n) && n > 0 && n < Number.MAX_SAFE_INTEGER))
    throw new TypeError('range provider bounds must be finite positive safe integers');
  const resident = options.resident === true;
  const profile = options.profile === undefined ? undefined : structuredClone(options.profile);
  const host = resolveRuntime(options.runtime);
  const source = options.source ?? host.uuid();
  const query = options.query ?? canonicalizeJson({ source, entity, spec, keys,
    schema: options.schemaVersion ?? null, profile: profile ?? null });
  if (typeof source !== 'string' || !source || typeof query !== 'string' || !query)
    throw new TypeError('range source and query identities must be nonempty strings');
  const encoder = new TextEncoder();
  const bytesOf = (value) => encoder.encode(JSON.stringify(value)).byteLength;
  const keyOf = (row) => {
    const values = keys.map((key) => row[key]);
    if (values.some((value) => typeof value !== 'string' && !(typeof value === 'number' && Number.isFinite(value))))
      throw new TypeError('a range row must carry every stable key member');
    return keys.length === 1 ? String(values[0]) : canonicalizeJson(values);
  };
  let revision = 1;
  let dataVersion;
  let disposed = false;
  let generation = -1;
  let ticket = 0;
  let rows = null;
  let residentBytes = 0;
  const continuations = new Map();
  const pending = new Map();
  const observers = new Set();
  const stats = { sourceReads: 0, sourceRows: 0, sourceBytes: 0 };
  const snapshot = () => `${source}-v${revision}`;
  const invalidate = (reason) => {
    revision++;
    rows = null; residentBytes = 0; continuations.clear();
    const event = Object.freeze({ type: 'reset', reason, query, snapshot: snapshot(), revision,
      capture: 'committed-store-records; external changes detected on request' });
    for (const observer of observers) {
      try { observer(event); }
      catch { /* A subscriber cannot suppress a sibling's source reset. */ }
    }
  };
  const unsubscribe = store.observe((record) => {
    if (!disposed && record.collections.includes(entity)) invalidate('source-changed');
  });
  const checkVersion = async (over) => {
    const current = await over.dataVersion();
    if (dataVersion !== undefined && current !== dataVersion) invalidate('external-source-changed');
    dataVersion = current;
  };
  const readPage = async (over, pageOptions, used) => {
    stats.sourceReads++;
    const record = (work) => {
      if (work === undefined) return;
      stats.sourceRows += work.rows; stats.sourceBytes += work.bytes;
      if (used !== undefined) used.work += work.rows;
    };
    try {
      const page = await over.entity(entity).page(spec, {
        ...pageOptions, lookahead: false, profile,
      });
      record(page.work);
      return page;
    }
    catch (error) { record(error?.work); throw error; }
  };
  const loadResident = async (over, signal, used) => {
    const page = await readPage(over, { limit: bounds.rows + 1, maxBytes: bounds.bytes, signal }, used);
    const loaded = page.items;
    const bytes = bytesOf(loaded);
    if (page.hasMore !== false || loaded.length > bounds.rows || bytes > bounds.bytes) {
      throw new RangeError('range source exceeds resident credits');
    }
    const identities = loaded.map(keyOf);
    if (new Set(identities).size !== identities.length) throw new TypeError('range keys must be unique');
    loaded.forEach(deepFreeze);
    rows = loaded; residentBytes = bytes;
  };
  try {
    await store.transaction(async (tx) => {
      await checkVersion(tx);
      if (resident) await loadResident(tx);
    });
  }
  catch (error) { unsubscribe(); throw error; }

  const capabilities = Object.freeze({ seekIndex: resident && options.seekIndex !== false, seekKey: false,
    continuation: true, live: true, exactTotal: resident && options.exactTotal !== false, completeExport: false });
  const provider = {
    capabilities,
    get query() { return query; },
    get snapshot() { return snapshot(); },
    stats: () => ({ ...stats, pending: pending.size, pages: continuations.size,
      rows: rows?.length ?? 0, bytes: residentBytes, subscriptions: observers.size, disposed }),
    subscribe(observer) {
      if (disposed) throw new Error('range provider is disposed');
      if (typeof observer !== 'function') throw new TypeError('range subscriber must be callable');
      if (observers.size >= bounds.subscriptions) throw new RangeError('range subscription bound reached');
      observers.add(observer);
      return () => observers.delete(observer);
    },
    request(request, signal) {
      request = structuredClone(request);
      const identity = Object.fromEntries(['generation', 'requestId', 'query', 'snapshot'].map((key) => [key, request?.[key]]));
      const used = { pages: 0, rows: 0, bytes: 0, work: 0 };
      const refuse = (state, reason) => ({ ...identity, state, reason, used: { ...used } });
      if (disposed) return Promise.resolve(refuse('error', 'disposed'));
      if (signal?.aborted) return Promise.resolve(refuse('error', 'cancelled'));
      if (!Number.isSafeInteger(request?.generation) || request.generation < 0 || typeof request.requestId !== 'string')
        return Promise.resolve(refuse('error', 'invalid-identity'));
      if (request.query !== query || request.generation < generation) return Promise.resolve(refuse('invalidated', 'query-changed'));
      if (pending.size >= bounds.inFlight) return Promise.resolve(refuse('budget-exhausted', 'in-flight'));
      generation = request.generation;
      const currentTicket = ++ticket;
      const controller = new AbortController();
      const abort = () => controller.abort(signal.reason);
      signal?.addEventListener('abort', abort, { once: true });
      const run = async () => {
        await Promise.resolve();
        if (disposed) return refuse('error', 'disposed');
        if (controller.signal.aborted) return refuse('error', 'cancelled');
        const credits = request.credits;
        if (!['pages', 'rows', 'bytes', 'work'].every((key) => Number.isSafeInteger(credits?.[key]) && credits[key] >= 0))
          return refuse('error', 'invalid-credits');
        let start;
        let limit;
        let after;
        if (request.continuation != null) {
          const cursor = continuations.get(request.continuation);
          if (!cursor || cursor.snapshot !== request.snapshot || cursor.query !== request.query)
            return refuse('invalidated', 'continuation-changed');
          start = cursor.end; limit = cursor.limit; after = cursor.after;
        }
        else {
          const range = request.range;
          if (!range || !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < 0 || range.end < range.start)
            return refuse('error', 'invalid-range');
          start = range.start; limit = range.end - range.start;
          if (start > 0 && !capabilities.seekIndex) return refuse('error', 'unsupported-seek');
        }
        if (credits.pages < 1 || credits.rows < limit || credits.work < limit || credits.bytes < 2
          || limit > bounds.rows || credits.bytes > Number.MAX_SAFE_INTEGER)
          return refuse('budget-exhausted', 'credits');
        try {
          let page;
          const wantedRevision = revision;
          const result = await store.transaction(async (tx) => {
            await checkVersion(tx);
            if (request.snapshot !== snapshot()) return null;
            if (resident && rows === null) {
              // A reset rebuilds the whole bounded source. Admission reserves
              // its maximum root pulls separately from the requested slice.
              if (credits.work - limit < bounds.rows + 1) throw new RangeError('resident refresh exceeds work credits');
              await loadResident(tx, controller.signal, used);
            }
            if (resident) {
              const result = rows.slice(start, start + limit);
              used.work += result.length;
              return result;
            }
            if (limit === 0) return [];
            // The store counts row payloads; a range also owes array brackets
            // and commas. Reserve their maximum before any row is pulled.
            const maxBytes = Math.min(credits.bytes, bounds.bytes) - limit - 1;
            if (maxBytes < 1) throw new RangeError('range array exceeds byte credits');
            page = await readPage(tx, { limit, after, maxBytes, signal: controller.signal }, used);
            return page.items;
          }, { signal: controller.signal });
          if (disposed) return refuse('error', 'disposed');
          if (controller.signal.aborted) return refuse('error', 'cancelled');
          if (currentTicket !== ticket || request.generation !== generation) return refuse('invalidated', 'superseded');
          if (result === null || wantedRevision !== revision || request.snapshot !== snapshot()) return refuse('invalidated', 'snapshot-changed');
          used.pages = 1;
          const bytes = bytesOf(result);
          if (bytes > Math.min(credits.bytes, bounds.bytes)) return refuse('budget-exhausted', 'bytes');
          result.forEach(deepFreeze);
          const resultKeys = result.map(keyOf);
          if (new Set(resultKeys).size !== resultKeys.length) return refuse('error', 'duplicate-key');
          used.rows = result.length; used.bytes = bytes;
          let continuation = null;
          const more = resident ? start + result.length < rows.length : page?.hasMore !== false && result.length > 0;
          if (more) {
            continuation = host.uuid();
            if (continuations.size >= bounds.pages) continuations.delete(continuations.keys().next().value);
            continuations.set(continuation, { query, snapshot: snapshot(), end: start + result.length, limit, after: page?.continuation });
          }
          return { ...identity, state: 'ready', rows: result, keys: resultKeys, used,
            continuation, total: capabilities.exactTotal ? { kind: 'known', value: rows.length } : { kind: 'unknown' } };
        }
        catch (error) {
          return refuse(disposed ? 'error' : controller.signal.aborted ? 'error'
            : error instanceof RangeError || ['JD2007', 'JD2073', 'JD2074', 'JD2076'].includes(error?.code) ? 'budget-exhausted' : 'error',
          disposed ? 'disposed' : controller.signal.aborted ? 'cancelled' : error?.code ?? error.message);
        }
      };
      const promise = run().finally(() => { pending.delete(controller); signal?.removeEventListener('abort', abort); });
      pending.set(controller, promise);
      return promise;
    },
    async dispose() {
      if (!disposed) {
        disposed = true; unsubscribe(); observers.clear();
        for (const controller of pending.keys()) controller.abort();
      }
      await Promise.allSettled([...pending.values()]);
      continuations.clear(); rows = null; residentBytes = 0;
    },
  };
  return Object.freeze(provider);
}
