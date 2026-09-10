//@ts-check
/** Structural lexical ranges reuse the shared resident range implementation. */
import { createArrayRangeProvider, rangeBytes, rangeIdentity } from '@jarenjs/core/range';
import { canonicalizeJson } from '@jarenjs/json/canonical';

/**
 * Materialize only a credited, complete lexical membership. The source retains
 * authoritative rows; this adapter owns one bounded range copy and its cursors.
 * @param {any} source @param {string} text @param {any} [spec] @param {any} [options]
 * @returns {Promise<any>}
 */
export async function createLexicalRangeProvider(source, text, spec = {}, options = {}) {
  const maxMatches = options.maxMatches ?? 1000, maxSourceBytes = options.maxSourceBytes ?? 1024 * 1024;
  if (!Number.isSafeInteger(maxMatches) || maxMatches < 1 || !Number.isSafeInteger(maxSourceBytes) || maxSourceBytes < 2)
    throw new TypeError('Invalid lexical range credits');
  if (spec.after !== undefined || spec.limit !== undefined) throw new TypeError('Lexical ranges own continuation and result limits');
  spec = structuredClone(spec);
  const query = options.query ?? canonicalizeJson({ text, spec, source: options.source ?? null });
  let disposed = false, dirty = false, epoch = 0, provider = null, refreshing = null;
  const observers = new Set();
  const unsubscribe = source.subscribe((event) => {
    dirty = true; epoch++;
    for (const observer of observers) { try { observer({ ...event, query, type: 'reset', revision: epoch, snapshot: source.sourceRevision }); }
      catch { /* Subscribers cannot suppress a sibling's reset. */ } }
  });
  const refresh = async () => {
    if (disposed) throw new Error('Lexical range disposed');
    if (refreshing) return refreshing;
    refreshing = (async () => {
      const result = await source.search(text, { ...spec, limit: maxMatches });
      if (disposed) throw new Error('Lexical range disposed');
      if (result.state !== 'complete' || result.hasMore || result.hits.length !== result.total)
        throw new RangeError(`Lexical range requires complete membership: ${result.reason ?? 'match-credits'}`);
      const rows = [], snapshot = result.sourceRevision;
      let bytes = 2;
      for (const hit of result.hits) {
        const row = source.row(hit.id, snapshot); bytes += rangeBytes(row) + (rows.length ? 1 : 0);
        if (bytes > maxSourceBytes) throw new RangeError('Lexical range source byte credits');
        rows.push(row);
      }
      if (provider === null) provider = createArrayRangeProvider(rows, { ...options, query, snapshot });
      else if (provider.snapshot !== snapshot) provider.replace(rows, snapshot);
      dirty = false; return { state: 'complete', sourceRevision: snapshot, rows: rows.length, bytes };
    })().finally(() => { refreshing = null; });
    return refreshing;
  };
  try { await refresh(); }
  catch (error) { unsubscribe(); throw error; }
  return {
    query, get snapshot() { return provider.snapshot; }, capabilities: provider.capabilities, refresh,
    indexOf: (key) => provider.indexOf(key),
    subscribe(fn) {
      if (disposed || typeof fn !== 'function') throw new TypeError('Invalid lexical range subscriber');
      if (observers.size >= 8) throw new RangeError('Lexical range subscription credits');
      observers.add(fn); return () => observers.delete(fn);
    },
    async request(request, signal) {
      const refusal = (state, reason) => ({ ...rangeIdentity(request), state, reason, used: { pages: 0, rows: 0, bytes: 0, work: 0 } });
      if (disposed) return refusal('error', 'disposed');
      if (signal?.aborted) return refusal('error', 'cancelled');
      const current = epoch;
      const ready = await source.refresh();
      if (disposed) return refusal('error', 'disposed');
      if (signal?.aborted) return refusal('error', 'cancelled');
      if (ready.state !== 'complete') return refusal(ready.state === 'budget-exhausted' ? ready.state : 'error', ready.reason);
      if (dirty || current !== epoch || source.sourceRevision !== provider.snapshot) return refusal('invalidated', 'source-changed');
      return provider.request(request, signal);
    },
    async *export(request, signal) {
      const ready = await source.refresh();
      if (ready.state !== 'complete' || dirty || disposed || source.sourceRevision !== provider.snapshot) throw new Error('Incomplete lexical snapshot export');
      for await (const page of provider.export(request, signal)) {
        const current = await source.refresh();
        if (current.state !== 'complete' || dirty || disposed || source.sourceRevision !== provider.snapshot)
          throw new Error('Incomplete lexical snapshot export');
        yield page;
      }
    },
    stats: () => ({ ...provider.stats(), refreshing: refreshing ? 1 : 0, subscriptions: observers.size, dirty }),
    async dispose() {
      disposed = true; unsubscribe(); observers.clear();
      await Promise.allSettled([refreshing]); await provider.dispose();
      if (options.disposeSource) await source.dispose();
    },
  };
}
