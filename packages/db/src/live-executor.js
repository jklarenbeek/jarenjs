//@ts-check
/** Bounded snapshot execution through the existing collection/entity engines. */
import { createQueryEngine, createEntityQueryEngine, createQueryState } from './query.js';
import { SAFE_PROFILE } from './profile.js';
import { createCursor, drainPage, utf8Length } from './cursor.js';
import { DbCompileError, DbRuntimeError } from './errors.js';

/** One serialized evaluator owns its counters and compiled plan. No per-call
 * budget is placed on another query's shared cache entry.
 * @param {any} context @param {any} bounds @param {AbortSignal} signal */
export function createLiveExecutor(context, bounds, signal) {
  const binding = { document: context.document, externals: context.externals };
  if (utf8Length(JSON.stringify(binding)) > bounds.maxInputBytes)
    throw new DbCompileError('JD0052', 'resnapshot query bindings exceed input byte credits');
  context = { ...context, ...structuredClone(binding) };
  const source = context.connection;
  if (source.capabilities.lazyIteration === false)
    throw new DbCompileError('JD0051', 'resnapshot input requires a lazy row iterator');
  const base = context.profile ?? { ...SAFE_PROFILE, maxRows: bounds.maxInputRows,
    externals: Object.keys(context.externals), functions: Object.keys(context.operators?.functions ?? {}) };
  const narrower = (current, credit) => Math.min(current ?? Infinity, credit);
  const profile = { ...base, maxRows: narrower(base.maxRows, bounds.maxInputRows),
    maxBytes: narrower(base.maxBytes, bounds.maxInputBytes),
    limits: Object.fromEntries(Object.entries(SAFE_PROFILE.limits).map(([key, value]) =>
      [key, narrower(base.limits[key], key === 'resultItems' ? bounds.maxMaintained : value)])) };
  let rows = 0, bytes = 0;
  const refused = () => new DbRuntimeError('JD2060', 'resnapshot input exceeded its row or byte credits');
  const sizeOf = (row) => utf8Length(JSON.stringify(row));
  const connection = { ...source, prepare(sql, metadata) {
    const read = async (params, one) => {
      if (rows >= bounds.maxInputRows || bytes >= bounds.maxInputBytes) throw refused();
      // The query owner caches this wrapper, not a native statement. Ephemeral
      // iterator statements leave with their cursor, including failed reads.
      const statement = await source.prepare(sql, { ...metadata, ephemeral: true });
      // EXPLAIN is a metadata command rather than a cursor-select on some hosts.
      // Its driver owns buffering bounds; its answer still spends input credit.
      const explain = /^\s*EXPLAIN\b/i.test(sql);
      const cursor = createCursor({ streaming: explain ? 'buffered' : 'row',
        ...(explain ? { materialize: () => statement.all(params) }
          : { open: () => statement.iterate(params), items: (row) => [row] }), signal });
      const page = await drainPage(cursor, { limit: one ? 1 : bounds.maxInputRows - rows + 1,
        maxBytes: bounds.maxInputBytes - bytes, lookahead: false,
        sizeOf, continuationOf: () => null });
      rows += page.work.rows; bytes += page.work.bytes;
      if (rows > bounds.maxInputRows || bytes > bounds.maxInputBytes || (!one && page.hasMore !== false))
        throw refused();
      return one ? page.items[0] : page.items;
    };
    return { all: (params) => read(params, false), get: (params) => read(params, true) };
  } };
  const state = createQueryState(1, context.operators, context.zoneProvider, context.now);
  const engine = (context.collection ? createQueryEngine : createEntityQueryEngine)(
    { ...context, connection, profile, state });
  return {
    async execute() {
      rows = 0; bytes = 0;
      const result = await engine.execute(context.document, { externals: context.externals, signal });
      const items = result === undefined ? [] : Array.isArray(result) ? result : [result];
      if (items.length > bounds.maxMaintained || utf8Length(JSON.stringify(items)) > bounds.maxBytes)
        throw new DbRuntimeError('JD2060', 'resnapshot result exceeded its maintained row or byte credits');
      return items;
    },
    stats: () => ({ inputRows: rows, inputBytes: bytes }),
  };
}
