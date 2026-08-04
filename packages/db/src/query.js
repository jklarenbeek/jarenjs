//@ts-check
/**
 * @file The query surface over one collection: the D2 provider
 * (`execute(document, options)` — how a linq chain runs here with no
 * import edge), the streaming cursor (`query`), and `explain()`.
 *
 * The statement cache is a CALLER of the core primitives:
 * `createBoundedCache` keyed by `contentKey(document)` (memo-grade —
 * dropped `undefined` members and no cycle guard are both acceptable
 * for a cache key) plus collection, dialect and strictness;
 * `store.stats()` exposes hits, misses and evictions so the cache is
 * proven rather than assumed.
 *
 * Bind-time diversion: if any referenced external is missing or not a
 * string or finite number, the call runs the always-compilable set
 * residual over the full collection instead of the native statement —
 * SQLite cannot bind a boolean, a `null` needs Jaren's semantics, and
 * a missing external must raise the ENGINE's error, not a driver's.
 */

import { createBoundedCache } from '@jarenjs/core/cache';
import { contentKey } from '@jarenjs/core/object';
import { compileJsonQuery } from '@jarenjs/json/query';

import { DbCompileError, DbRuntimeError } from './errors.js';
import { chain } from './driver.js';
import { planQuery } from './plan.js';
import { emitPlan } from './emit.js';
import { selectPlan } from './algebra.js';
import { compileSetResidual, compileRowResidual, sequenceResult } from './residual.js';
import { deterministicFragment, registerFragment } from './udf.js';
import {
  normalizeProfile, translateProfilePredicate,
  applyMandatoryPredicate, applyRowBound,
} from './profile.js';

/**
 * The store-wide query state shared by every collection's engine: one
 * bounded statement cache, its counters, and the UDF registration set.
 * @param {number} [bound]
 * @returns {any}
 */
export function createQueryState(bound = undefined) {
  return {
    cache: createBoundedCache(bound ?? 128),
    counters: { hits: 0, misses: 0, evictions: 0 },
    registered: new Set(),
  };
}

/** @param {any} value - a bindable native parameter? */
function bindable(value) {
  return typeof value === 'string'
    || (typeof value === 'number' && Number.isFinite(value));
}

/**
 * The query engine for one collection.
 * @param {{ connection: any, state: any, collection: any,
 *   physicalPlan: any, profile?: any }} context - `collection` is the
 *   normalized collection; `physicalPlan` is TODO_07's DDL plan
 *   (columns, indexes); `profile` is the store-level normalized
 *   profile, if one was opened with
 * @returns {{ execute: Function, query: Function, explain: Function }}
 */
export function createQueryEngine(context) {
  const { connection, state, collection, physicalPlan } = context;
  const storeProfile = context.profile ?? null;
  const dialect = connection.dialect;
  const shape = {
    collection: collection.name,
    schema: collection.schema,
    columnByCanonical: physicalPlan.columnByCanonical,
  };
  const physical = {
    table: physicalPlan.table,
    keyColumn: physicalPlan.keyColumn,
    docColumn: physicalPlan.docColumn,
  };

  const udfHook = connection.capabilities.userFunctions
    ? (fragment) => {
      const qualified = deterministicFragment(fragment);
      if (qualified === null) return null;
      registerFragment(connection, state.registered, qualified);
      return qualified;
    }
    : undefined;

  /**
   * The profile's compile-time refusal.
   * @param {string} reason
   * @returns {DbCompileError}
   */
  const profileRefusal = (reason) =>
    new DbCompileError('JD0011', reason, collection.docPath);

  /**
   * Build (or fetch) the cached entry for one document, under one
   * resolved profile and pushdown setting.
   * @param {any} document
   * @param {boolean} strict
   * @param {any} profile - normalized profile or null
   * @param {boolean} pushdown - false forces the whole document to the
   *   set residual (the oracle's forced-residual mode)
   */
  const entryFor = (document, strict, profile, pushdown) => {
    const key = `${contentKey(document)}|${collection.name}|${dialect.name}|${strict ? 1 : 0}`
      + `|${pushdown ? 1 : 0}|${profile === null ? '-' : contentKey(profile)}`;
    const cached = state.cache.get(key);
    if (cached !== undefined) {
      state.counters.hits++;
      return cached;
    }
    state.counters.misses++;

    if (profile !== null && profile.collections !== null
      && !profile.collections.includes(collection.name)) {
      throw profileRefusal(
        `the profile does not allow querying collection '${collection.name}'`);
    }

    // no UDF registration under a profile: a foreign document must not
    // cause host-side function registration
    let planned = planQuery(document, shape,
      { udf: profile === null && pushdown ? udfHook : undefined });
    if (!pushdown) {
      planned = {
        ...planned,
        plan: null,
        mode: 'set',
        reasons: [{ construct: 'pushdown', reason: 'disabled by the harness switch' }],
        rowReturn: null,
        udfs: [],
      };
    }

    if (profile !== null) {
      const deps = planned.analysis.dependencies;
      for (const name of deps.functions) {
        if (!profile.functions.includes(name))
          throw profileRefusal(`the profile does not allow the host function '${name}'`);
      }
      for (const name of deps.collations) {
        if (!profile.collations.includes(name))
          throw profileRefusal(`the profile does not allow the collation '${name}'`);
      }
      for (const external of planned.analysis.externals) {
        if (!profile.externals.includes(external.name))
          throw profileRefusal(`the profile does not declare the external '${external.name}'`);
      }
    }

    if (strict && planned.mode !== 'native') {
      const forcing = planned.reasons[0]
        ?? { construct: 'residual', reason: 'the document did not translate' };
      throw new DbCompileError('JD0010',
        `strict mode refused a residual: '${forcing.construct}' — ${forcing.reason}`,
        collection.docPath);
    }

    const mandatory = profile !== null
      && profile.predicates[collection.name] !== undefined
      ? translateProfilePredicate(profile.predicates[collection.name], shape)
      : null;
    const maxRows = profile === null ? null : profile.maxRows;
    const shapePlan = (base) => {
      let out = applyMandatoryPredicate(base, mandatory);
      if (maxRows !== null) out = applyRowBound(out, maxRows);
      return out;
    };

    const plan = shapePlan(planned.plan ?? selectPlan(collection.name));
    const emitted = emitPlan(plan, dialect, physical);
    const externalNames = planned.analysis.externals.map((e) => e.name);
    const limits = profile === null ? undefined : profile.limits;
    const entry = {
      planned,
      plan,
      sql: emitted.sql,
      slots: emitted.slots,
      externalNames,
      dependencies: planned.analysis.dependencies,
      limits: planned.analysis.limits,
      residualLimits: limits,
      rowBound: maxRows,
      needsScanCheck: profile !== null && profile.refuseFullScan === true,
      scanChecked: false,
      statement: null,
      setResidual: null,
      packedResidual: null,
      rowResidual: planned.mode === 'row'
        ? compileRowResidual(planned.rowReturn, limits)
        : null,
      fullScanSql: null,
      fullScanShape: () => shapePlan(selectPlan(collection.name)),
    };

    const sizeBefore = state.cache.size();
    state.cache.set(key, entry);
    if (state.cache.size() === sizeBefore) state.counters.evictions++;
    return entry;
  };

  const statementOf = (entry) => {
    if (entry.statement === null) entry.statement = connection.prepare(entry.sql);
    return entry.statement;
  };
  const setResidualOf = (entry, document) => {
    if (entry.setResidual === null)
      entry.setResidual = compileSetResidual(document, entry.residualLimits);
    return entry.setResidual;
  };
  /** The item-packing variant for cursors: `[document]` packs the
   * whole result sequence into one unambiguous array. */
  const packedResidualOf = (entry, document) => {
    if (entry.packedResidual === null) {
      const compiled = compileJsonQuery([document],
        entry.residualLimits === undefined ? undefined : { limits: entry.residualLimits });
      entry.packedResidual = (candidates, externals) => compiled(candidates, externals);
    }
    return entry.packedResidual;
  };
  /**
   * The diversion fetch: the whole collection, still wearing the
   * profile's mandatory predicate and row bound — a diverted call must
   * not escape either.
   */
  const fullScanOf = (entry) => {
    if (entry.fullScanSql === null) {
      const emitted = emitPlan(entry.fullScanShape(), dialect, physical);
      entry.fullScanSql = { sql: emitted.sql, slots: emitted.slots, statement: null };
    }
    if (entry.fullScanSql.statement === null)
      entry.fullScanSql.statement = connection.prepare(entry.fullScanSql.sql);
    return entry.fullScanSql.statement;
  };
  const fullScanParams = (entry) =>
    entry.fullScanSql.slots.map((slot) => ('literal' in slot ? slot.literal : null));

  /** Refuse a fetch that crossed the profile's row bound (JD2007). */
  const checkRowBound = (entry, rows) => {
    if (entry.rowBound !== null && rows.length > entry.rowBound) {
      throw new DbRuntimeError('JD2007',
        `the fetch crossed the profile's maxRows bound of ${entry.rowBound}`,
        { docPath: collection.docPath, collection: collection.name });
    }
    return rows;
  };

  /** The optional plan-shape refusal: a full-table SCAN of a profiled
   * collection is refused when the profile says so, verified against
   * the database's own plan output. */
  const guardScan = (entry) => {
    if (!entry.needsScanCheck || entry.scanChecked) return null;
    const eqpParams = entry.slots.map((slot) => ('literal' in slot ? slot.literal : null));
    return chain(connection.prepare(dialect.explainQuery(entry.sql)), (statement) =>
      chain(statement.all(eqpParams), (rows) => {
        const fullScan = rows.some((row) => {
          const detail = String(row.detail);
          return detail.startsWith(`SCAN ${physical.table}`)
            && !detail.includes('USING INDEX');
        });
        if (fullScan) {
          throw profileRefusal(
            `the profile refuses a full-table scan of '${collection.name}' `
            + `(${rows.map((row) => String(row.detail)).join('; ')})`);
        }
        entry.scanChecked = true;
        return null;
      }));
  };

  /** Bind slots against the call's externals. */
  const bindParams = (entry, externals) =>
    entry.slots.map((slot) => ('literal' in slot ? slot.literal : externals[slot.external]));

  /** Must this call divert to the residual? */
  const mustDivert = (entry, externals) =>
    entry.externalNames.some((name) => !bindable(externals[name]));

  const rowsToDocs = (rows) => rows.map((row) => JSON.parse(row.doc));

  const aggregateResult = (entry, row) => {
    const fn = entry.plan.aggregate.fn;
    const value = row?.value ?? null;
    if (fn === 'count') return value ?? 0;
    if (fn === 'sum') return value === null ? 0 : value;
    return value === null ? undefined : value;
  };

  /**
   * Resolve the profile and pushdown switches for one call.
   * @param {any} options
   */
  const callState = (options) => ({
    externals: options?.externals ?? {},
    strict: options?.strict === true,
    profile: options?.profile !== undefined
      ? normalizeProfile(options.profile)
      : storeProfile,
    pushdown: options?.pushdown !== false,
  });

  /**
   * Run the document and answer in the ENGINE's result shape.
   * @param {any} document
   * @param {{ externals?: any, strict?: boolean, profile?: any,
   *   pushdown?: boolean }} [options]
   * @returns {any} value-or-promise (the provider contract keeps a
   *   synchronous driver synchronous)
   */
  const execute = (document, options = undefined) => {
    const { externals, strict, profile, pushdown } = callState(options);
    const entry = entryFor(document, strict, profile, pushdown);

    return chain(guardScan(entry), () => {
      if (mustDivert(entry, externals)) {
        return chain(fullScanOf(entry), (statement) =>
          chain(statement.all(fullScanParams(entry)), (rows) =>
            setResidualOf(entry, document)(rowsToDocs(checkRowBound(entry, rows)), externals)));
      }
      if (entry.planned.mode === 'set') {
        // the narrowed statement fetches candidates; the full document
        // then re-applies its own predicates (idempotent narrowing)
        return chain(statementOf(entry), (statement) =>
          chain(statement.all(bindParams(entry, externals)), (rows) =>
            setResidualOf(entry, document)(rowsToDocs(checkRowBound(entry, rows)), externals)));
      }
      if (entry.planned.mode === 'row') {
        return chain(statementOf(entry), (statement) =>
          chain(statement.all(bindParams(entry, externals)), (rows) => {
            const items = [];
            for (const row of checkRowBound(entry, rows))
              items.push(...entry.rowResidual(JSON.parse(row.doc), externals));
            return sequenceResult(items);
          }));
      }
      return chain(statementOf(entry), (statement) => {
        if (entry.plan.aggregate !== null) {
          return chain(statement.get(bindParams(entry, externals)),
            (row) => aggregateResult(entry, row));
        }
        return chain(statement.all(bindParams(entry, externals)),
          (rows) => sequenceResult(rowsToDocs(checkRowBound(entry, rows))));
      });
    });
  };

  /**
   * A streaming cursor over the document's result ITEMS (the TODO_06
   * cursor shape: `next()`/`return()` plus `Symbol.asyncIterator`).
   * Native and row modes stream row by row; a set residual
   * materializes first (it is a barrier and `explain()` says so).
   * @param {any} document
   * @param {{ externals?: any, strict?: boolean }} [options]
   */
  const query = (document, options = undefined) => {
    const { externals, strict, profile, pushdown } = callState(options);
    const entry = entryFor(document, strict, profile, pushdown);
    let pulledRows = 0;

    /** @type {any} */
    let underlying = null;
    /** @type {any[]} */
    let buffered = [];
    let bufferedAt = 0;
    let materialized = null;
    let done = false;

    const nextFromBuffer = () => ({ done: false, value: buffered[bufferedAt++] });

    const pull = () => {
      if (done) return Promise.resolve({ done: true, value: undefined });
      if (bufferedAt < buffered.length) return Promise.resolve(nextFromBuffer());

      if (entry.planned.mode === 'set' || mustDivert(entry, externals)) {
        // the barrier: materialize candidates, pack the result items
        if (materialized === null) {
          const diverted = mustDivert(entry, externals);
          materialized = Promise.resolve(chain(guardScan(entry), () => chain(
            diverted ? fullScanOf(entry) : statementOf(entry),
            (statement) => chain(
              statement.all(diverted ? fullScanParams(entry) : bindParams(entry, externals)),
              (rows) => {
                buffered = packedResidualOf(entry, document)(
                  rowsToDocs(checkRowBound(entry, rows)), externals);
                bufferedAt = 0;
              }))));
        }
        return materialized.then(() => {
          if (bufferedAt < buffered.length) return nextFromBuffer();
          done = true;
          return { done: true, value: undefined };
        });
      }
      if (entry.plan.aggregate !== null) {
        // a native aggregate yields exactly one item
        if (materialized === null) {
          materialized = Promise.resolve(chain(guardScan(entry), () =>
            chain(statementOf(entry), (statement) =>
              chain(statement.get(bindParams(entry, externals)), (row) => {
                const value = aggregateResult(entry, row);
                buffered = value === undefined ? [] : [value];
                bufferedAt = 0;
              }))));
        }
        return materialized.then(() => {
          if (bufferedAt < buffered.length) return nextFromBuffer();
          done = true;
          return { done: true, value: undefined };
        });
      }

      return Promise.resolve(chain(underlying === null
        ? chain(guardScan(entry), () => chain(statementOf(entry),
          (statement) => { underlying = statement.iterate(bindParams(entry, externals)); return underlying; }))
        : underlying, (iterator) => chain(iterator.next(), (step) => {
        if (step.done === true) {
          done = true;
          return { done: true, value: undefined };
        }
        pulledRows++;
        if (entry.rowBound !== null && pulledRows > entry.rowBound) {
          done = true;
          if (typeof iterator.return === 'function') iterator.return(undefined);
          throw new DbRuntimeError('JD2007',
            `the fetch crossed the profile's maxRows bound of ${entry.rowBound}`,
            { docPath: collection.docPath, collection: collection.name });
        }
        const doc = JSON.parse(step.value.doc);
        if (entry.rowResidual === null) return { done: false, value: doc };
        buffered = entry.rowResidual(doc, externals);
        bufferedAt = 0;
        return bufferedAt < buffered.length ? nextFromBuffer() : pull();
      })));
    };

    const close = () => {
      done = true;
      if (underlying !== null && typeof underlying.return === 'function')
        underlying.return(undefined);
      return Promise.resolve({ done: true, value: undefined });
    };

    return {
      next: () => pull(),
      return: () => close(),
      [Symbol.asyncIterator]() { return this; },
    };
  };

  /**
   * The explanation record: the engine explain shape plus the pushdown
   * facts. `estimatedRows` is deliberately ABSENT — the capability
   * slot is empty on SQLite and no number is fabricated; the
   * database's own plan prose rides in `scanNarrative` instead.
   * @param {any} document
   * @param {{ externals?: any, strict?: boolean }} [options]
   */
  const explain = (document, options = undefined) => {
    const { externals, strict, profile, pushdown } = callState(options);
    const entry = entryFor(document, strict, profile, pushdown);

    const touchedColumns = new Set();
    const collectColumns = (pred) => {
      if (pred === null) return;
      if (pred.p === 'and' || pred.p === 'or') pred.items.forEach(collectColumns);
      else if (pred.p === 'not') collectColumns(pred.item);
      else if ('ref' in pred && pred.ref?.column) touchedColumns.add(pred.ref.column);
    };
    collectColumns(entry.plan.filter);
    for (const term of entry.plan.order ?? []) {
      if (term.ref.column !== null) touchedColumns.add(term.ref.column);
    }
    if (entry.plan.aggregate?.ref?.column) touchedColumns.add(entry.plan.aggregate.ref.column);
    const indexes = physicalPlan.expected.indexes
      .filter((index) => index.columns.some((column) => touchedColumns.has(column)))
      .map((index) => index.name);

    const params = entry.slots.map((slot) =>
      ('external' in slot ? { external: slot.external } : { literal: slot.literal }));
    const eqpParams = entry.slots.map((slot) => ('literal' in slot
      ? slot.literal
      : bindable(externals[slot.external]) ? externals[slot.external] : null));

    return chain(connection.prepare(dialect.explainQuery(entry.sql)), (statement) =>
      chain(statement.all(eqpParams), (rows) => ({
        externals: [...entry.externalNames],
        operators: [...entry.dependencies.operators],
        functions: [...entry.dependencies.functions],
        collations: [...entry.dependencies.collations],
        limits: entry.limits,
        sql: entry.sql,
        params,
        indexes,
        residual: entry.planned.mode === 'native'
          ? null
          : { mode: entry.planned.mode, reasons: entry.planned.reasons },
        barriers: entry.planned.mode === 'set'
          ? entry.planned.reasons.map((r) => ({ operator: r.construct, reason: r.reason }))
          : [],
        udfs: [...entry.planned.udfs],
        scanNarrative: rows.map((row) => String(row.detail)).join('; '),
      })));
  };

  return { execute, query, explain };
}
