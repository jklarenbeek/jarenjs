//@ts-check
/** Scripted ten-row source for contract tests; no production cache or scheduler. */
import { adoptionKey } from '../../scripts/lib/adoption.js';

/** @param {{ seekIndex?: boolean, exactTotal?: boolean }} [options] */
export function fakeRangeProvider(options = {}) {
  let snapshot = 'source-v1';
  let disposed = false;
  const pending = new Set();
  const continuations = new Map();
  const capabilities = { seekIndex: options.seekIndex ?? true, seekKey: false,
    continuation: true, live: false, exactTotal: options.exactTotal ?? true, completeExport: false };
  const provider = {
    capabilities,
    request(request, signal) {
      const identity = Object.fromEntries(['generation', 'requestId', 'query', 'snapshot'].map((key) => [key, request[key]]));
      const used = { pages: 0, rows: 0, bytes: 0, work: 0 };
      const refuse = (state, reason) => ({ ...identity, state, reason, used });
      if (disposed) return Promise.resolve(refuse('error', 'disposed'));
      if (signal?.aborted) return Promise.resolve(refuse('error', 'cancelled'));
      return new Promise((resolve) => {
        const finish = (result) => { pending.delete(stop); signal?.removeEventListener('abort', abort); resolve(result); };
        const stop = () => finish(refuse('error', 'disposed'));
        const abort = () => finish(refuse('error', 'cancelled'));
        pending.add(stop); signal?.addEventListener('abort', abort, { once: true });
        queueMicrotask(() => {
          if (!pending.has(stop)) return;
          if (request.snapshot !== snapshot) return finish(refuse('invalidated', 'snapshot-changed'));
          let range = request.range;
          if (request.continuation != null) {
            const cursor = continuations.get(request.continuation);
            if (!cursor || cursor.query !== request.query || cursor.snapshot !== snapshot)
              return finish(refuse('invalidated', 'continuation-changed'));
            range = { start: cursor.end, end: Math.min(10, cursor.end + 3) };
          }
          if (!range || !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end)
            || range.start < 0 || range.end < range.start)
            return finish(refuse('error', 'invalid-range'));
          if (request.continuation == null && range.start > 0 && !capabilities.seekIndex)
            return finish(refuse('error', 'unsupported-seek'));
          const count = Math.max(0, Math.min(range.end, 10) - Math.min(range.start, 10));
          if (!['pages', 'rows', 'bytes', 'work'].every((key) => Number.isSafeInteger(request.credits?.[key]) && request.credits[key] >= 0))
            return finish(refuse('error', 'invalid-credits'));
          if (request.credits.pages < 1 || request.credits.rows < count || request.credits.work < count)
            return finish(refuse('budget-exhausted', 'credits'));
          const rows = Array.from({ length: count }, (_, index) => ({ id: adoptionKey(range.start + index) }));
          const bytes = new TextEncoder().encode(JSON.stringify(rows)).byteLength;
          if (bytes > request.credits.bytes) return finish(refuse('budget-exhausted', 'credits'));
          let continuation = null;
          if (range.end < 10) {
            continuation = `opaque-${continuations.size}`;
            continuations.set(continuation, { end: range.end, query: request.query, snapshot });
          }
          finish({ ...identity, state: 'ready', rows, keys: rows.map((row) => row.id), continuation,
            total: capabilities.exactTotal ? { kind: 'known', value: 10 } : { kind: 'unknown' },
            used: { pages: 1, rows: count, bytes, work: count } });
        });
      });
    },
    async dispose() { disposed = true; for (const stop of pending) stop(); continuations.clear(); },
  };
  return { provider, invalidate: (next) => { snapshot = next; }, resources: () => pending.size + continuations.size };
}
