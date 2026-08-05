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
import { compileJsonQuery, analyzeQuery } from '@jarenjs/json/query';

import { DbCompileError, DbRuntimeError } from './errors.js';
import { chain } from './driver.js';
import {
  planQuery, planEntityQuery, entityShape, planEntityPredicate, entityPathRef,
} from './plan.js';
import { emitPlan, emitEntityPlan, createEntityPredicateEmitters } from './emit.js';
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

// ————— The entity query surface (the second document kind) —————

import { mergeEntityRow, parseGraphRow } from './graph.js';

/** The default include depth bound (D14: printed, never silent). */
export const INCLUDE_DEPTH_DEFAULT = 3;

/**
 * The store-level entity query engine: documents over the
 * multi-entity root (`$.<Entity>[*]` bindings), planned to guarded
 * selections and INNER equijoins, with the set residual running the
 * whole document over the fetched root — the same honesty contract as
 * phase A.
 * @param {{ connection: any, entities: Map<string, any>, mapping: any,
 *   state: any }} context
 * @returns {any}
 */
export function createEntityQueryEngine(context) {
  const { connection, entities, mapping, state } = context;
  const dialect = connection.dialect;
  const q = dialect.quoteIdentifier;
  const physicalOf = (name) => ({ table: mapping.entities[name].table });

  const entryFor = (document, pushdown) => {
    const key = `E|${contentKey(document)}|${dialect.name}|${pushdown ? 1 : 0}`;
    const cached = state.cache.get(key);
    if (cached !== undefined) {
      state.counters.hits++;
      return cached;
    }
    state.counters.misses++;
    let planned = planEntityQuery(document, entities, mapping);
    if (!pushdown) {
      planned = { ...planned, mode: 'set', plan: null,
        reasons: [{ construct: 'pushdown', reason: 'disabled by the harness switch' }] };
    }
    const entry = {
      planned,
      sql: null,
      slots: null,
      statement: null,
      setResidual: null,
      fetchers: null,
    };
    if (planned.mode === 'native') {
      const emitted = emitEntityPlan(planned.plan, dialect, physicalOf);
      entry.sql = emitted.sql;
      entry.slots = emitted.slots;
    }
    const sizeBefore = state.cache.size();
    state.cache.set(key, entry);
    if (state.cache.size() === sizeBefore) state.counters.evictions++;
    return entry;
  };

  /** Fetch every referenced entity's rows and build the in-memory root. */
  const fetchRoot = (entry) => {
    if (entry.fetchers === null) {
      entry.fetchers = [...(entry.planned.referenced.length === 0
        ? entities.keys() : entry.planned.referenced)].map((name) => ({
        name,
        sql: `SELECT ${q('t')}.*, ${dialect.jsonText(`${q('t')}.${q('doc')}`)} AS ${q('__doc')} `
          + `FROM ${q(mapping.entities[name].table)} AS ${q('t')} ORDER BY ${q('t')}.${dialect.rowIdentity()}`,
        statement: null,
      }));
    }
    /** @type {any} */
    const root = {};
    const next = (i) => {
      if (i >= entry.fetchers.length) return root;
      const fetcher = entry.fetchers[i];
      if (fetcher.statement === null) fetcher.statement = connection.prepare(fetcher.sql);
      return chain(fetcher.statement, (statement) =>
        chain(statement.all([]), (rows) => {
          root[fetcher.name] = rows.map((row) =>
            mergeEntityRow(mapping.entities[fetcher.name], row, '__doc'));
          return next(i + 1);
        }));
    };
    return next(0);
  };

  const runResidual = (entry, document, externals) => {
    if (entry.setResidual === null)
      entry.setResidual = compileSetResidual(document);
    return chain(fetchRoot(entry), (root) => entry.setResidual(root, externals));
  };

  const execute = (document, options = undefined) => {
    const externals = options?.externals ?? {};
    const pushdown = options?.pushdown !== false;
    const entry = entryFor(document, pushdown);
    if (entry.planned.mode !== 'native') {
      if (options?.strict === true) {
        const forcing = entry.planned.reasons[0];
        throw new DbCompileError('JD0010',
          `strict mode refused a residual: '${forcing.construct}' — ${forcing.reason}`);
      }
      return runResidual(entry, document, externals);
    }
    // bind-time diversion, exactly phase A's: a missing external must
    // raise the ENGINE's error, a boolean or null cannot bind natively
    for (const slot of entry.slots) {
      if ('external' in slot && !bindable(externals[slot.external]))
        return runResidual(entry, document, externals);
    }
    if (entry.statement === null) entry.statement = connection.prepare(entry.sql);
    const params = entry.slots.map((slot) =>
      ('literal' in slot ? slot.literal : externals[slot.external]));
    return chain(entry.statement, (statement) => {
      if (entry.planned.plan.aggregate === 'count')
        return chain(statement.get(params), (row) => row?.value ?? 0);
      return chain(statement.all(params), (rows) => {
        const retEntity = entry.planned.plan.bindings
          .find((binding) => binding.name === entry.planned.plan.ret).entity;
        return sequenceResult(rows.map((row) =>
          mergeEntityRow(mapping.entities[retEntity], row, '__doc')));
      });
    });
  };

  const explain = (document, options = undefined) => {
    const pushdown = options?.pushdown !== false;
    const entry = entryFor(document, pushdown);
    const base = {
      mode: entry.planned.mode,
      referenced: [...entry.planned.referenced],
      reasons: entry.planned.reasons,
      sql: entry.sql,
      residual: entry.planned.mode === 'native'
        ? null
        : { mode: 'set', reasons: entry.planned.reasons },
    };
    if (entry.planned.mode !== 'native') return base;
    return chain(connection.prepare(dialect.explainQuery(entry.sql)), (statement) =>
      chain(statement.all(entry.slots.map((slot) =>
        ('literal' in slot ? slot.literal : null))), (rows) => ({
        ...base,
        join: entry.planned.plan.joinOn,
        scanNarrative: rows.map((row) => String(row.detail)).join('; '),
      })));
  };

  return { execute, explain };
}

/**
 * The one-statement graph loader: `entity.load(spec)` compiles an
 * include tree to correlated subqueries projected as JSON — one
 * statement regardless of depth (asserted by a counting driver in the
 * tests, because N+1 is a test, not a promise). Per-relation `where`,
 * `orderBy` and `take` are applied INSIDE the subquery; depth is
 * bounded with the default printed in the refusal; cycles in the
 * specification are rejected; and keyset pagination is chosen over a
 * growing OFFSET whenever the top-level ordering is a single unique
 * column, with the choice reported by `explainLoad`.
 * @param {{ connection: any, entities: Map<string, any>, mapping: any,
 *   state: any }} context
 * @param {string} entityName
 * @returns {any}
 */
export function createLoadEngine(context, entityName) {
  const { connection, entities, mapping, state } = context;
  const dialect = connection.dialect;
  const q = dialect.quoteIdentifier;

  const refuse = (reason, path) => new DbCompileError('JD0032',
    `${reason} (include path: ${path.join('.') || '<root>'})`,
    entities.get(entityName)?.docPath);

  /** Compile a where EXPRESSION over `$it` against one entity. */
  const compileWhere = (expression, entity, path) => {
    const wrapper = { $for: { it: '$[*]' }, $where: expression, $return: '$it' };
    let analysis;
    try {
      analysis = analyzeQuery(wrapper);
    }
    catch (cause) {
      throw new DbCompileError('JD0032',
        `the where expression does not compile (include path: ${path.join('.')})`,
        entity.docPath, /** @type {Error} */ (cause));
    }
    const flwor = analysis.root;
    const slot = flwor.forBindings[0].slot;
    const shape = entityShape(entity, mapping.entities[entity.name]);
    const conjuncts = flwor.where.kind === 'op' && flwor.where.name === '$and'
      ? flwor.where.args : [flwor.where];
    let filter = null;
    for (const conjunct of conjuncts) {
      const outcome = planEntityPredicate(conjunct, slot, shape);
      if ('refusal' in outcome) {
        throw refuse(`the where expression is not translatable: ${outcome.refusal.reason}`, path);
      }
      filter = filter === null ? outcome.pred
        : filter.p === 'and'
          ? { p: 'and', items: [...filter.items, outcome.pred] }
          : { p: 'and', items: [filter, outcome.pred] };
    }
    return filter;
  };

  const compileOrder = (orderBy, entity, path) => {
    const specs = Array.isArray(orderBy) ? orderBy : [orderBy];
    const wrapper = { $for: { it: '$[*]' }, $orderby: specs, $return: '$it' };
    let analysis;
    try {
      analysis = analyzeQuery(wrapper);
    }
    catch (cause) {
      throw new DbCompileError('JD0032',
        `the orderBy does not compile (include path: ${path.join('.')})`,
        entity.docPath, /** @type {Error} */ (cause));
    }
    const flwor = analysis.root;
    const slot = flwor.forBindings[0].slot;
    const shape = entityShape(entity, mapping.entities[entity.name]);
    const terms = [];
    for (const spec of flwor.orderby.specs) {
      const ref = entityPathRef(spec.key, slot, shape);
      if (ref === null || (ref.flavor === 'entity-doc' && ref.type === 'unknown'))
        throw refuse('orderBy must address typed entity paths', path);
      terms.push({ ref, desc: spec.desc === true, emptyGreatest: spec.emptyGreatest === true });
    }
    return terms;
  };

  /** Build the include tree, validating names, depth and cycles. */
  const buildTree = (name, spec, depth, maxDepth, path, seen) => {
    const entity = entities.get(name);
    if (depth > maxDepth) {
      throw refuse(`the include graph exceeds its depth bound of ${maxDepth} `
        + '(raise it explicitly with maxDepth)', path);
    }
    const node = {
      entity,
      entityMapping: mapping.entities[name],
      where: spec?.where !== undefined ? compileWhere(spec.where, entity, path) : null,
      order: spec?.orderBy !== undefined ? compileOrder(spec.orderBy, entity, path) : null,
      take: spec?.take,
      includes: [],
    };
    const includeSpec = spec?.include;
    if (includeSpec === undefined) return node;
    if (seen.has(includeSpec))
      throw refuse('the include specification cycles', path);
    seen.add(includeSpec);
    for (const relationName of Object.keys(includeSpec)) {
      const property = entity.properties.get(relationName);
      const relation = property?.relation;
      if (relation === undefined) {
        throw refuse(`'${name}' declares no relation '${relationName}'`,
          [...path, relationName]);
      }
      const childSpec = includeSpec[relationName] === true ? {} : includeSpec[relationName];
      const childName = relation.to;
      const include = {
        name: relationName,
        field: `__${relationName}`,
        relation,
        many: relation.kind !== 'oneToOne',
        count: childSpec.count === true,
        // the join kind is derivable from the schema: a required
        // foreign key means the parent always exists
        kind: relation.kind === 'oneToOne'
          ? ((entity.schema.required ?? []).includes(relation.via)
            ? 'inner (fk required)' : 'left (fk optional)')
          : relation.kind,
        child: childSpec.count === true
          ? null
          : buildTree(childName, childSpec, depth + 1, maxDepth,
            [...path, relationName], seen),
      };
      node.includes.push(include);
    }
    return node;
  };

  /** Render one node's subquery-projection SQL. */
  const render = (node, alias, param, emitters) => {
    const aliasSql = q(alias);
    const docSql = `${aliasSql}.${q('doc')}`;
    const projection = () => {
      const parts = [];
      const named = new Set();
      for (const column of node.entityMapping.columns) {
        named.add(column.name);
        parts.push(`${slText(column.name)}, ${aliasSql}.${q(column.name)}`);
      }
      for (const fk of node.entityMapping.foreignKeys) {
        if (named.has(fk.column)) continue; // a declared via property
        parts.push(`${slText(fk.column)}, ${aliasSql}.${q(fk.column)}`);
      }
      parts.push(`${slText('__doc')}, ${dialect.jsonText(docSql)}`);
      for (const include of node.includes)
        parts.push(`${slText(include.field)}, ${renderInclude(node, include, alias, param, emitters)}`);
      return parts.join(', ');
    };
    return { aliasSql, docSql, projection };
  };
  const slText = (s) => dialect.stringLiteral(s);

  const renderInclude = (parentNode, include, parentAlias, param, emitters) => {
    const relation = include.relation;
    const childAlias = `${parentAlias}_${include.name}`;
    const parentKey = parentNode.entityMapping.keys[0];
    if (include.count === true) {
      const childTable = mapping.entities[relation.to].table;
      return `(SELECT COUNT(*) FROM ${q(childTable)} AS ${q(childAlias)} `
        + `WHERE ${q(childAlias)}.${q(relation.via)} = ${q(parentAlias)}.${q(parentKey)})`;
    }
    const child = include.child;
    const childTable = child.entityMapping.table;
    const childKey = child.entityMapping.keys[0];
    const rendered = render(child, childAlias, param, emitters);
    const conditions = [];
    if (relation.kind === 'oneToMany') {
      conditions.push(`${q(childAlias)}.${q(relation.via)} = ${q(parentAlias)}.${q(parentKey)}`);
    }
    else if (relation.kind === 'oneToOne') {
      conditions.push(`${q(childAlias)}.${q(childKey)} = ${q(parentAlias)}.${q(relation.via)}`);
    }
    if (child.where !== null)
      conditions.push(emitters.emitPred(rendered.aliasSql, rendered.docSql, child.where));
    const orderSql = (child.order ?? []).map((term) => {
      // epoch paths order by the document string (codepoint = the
      // engine's order); only plain mapped columns order natively
      const value = term.ref.flavor === 'entity-column'
        ? `${rendered.aliasSql}.${q(term.ref.column)}`
        : dialect.jsonExtract(rendered.docSql, dialect.jsonPathText(term.ref.segments));
      const nullsFirst = term.emptyGreatest === term.desc;
      return `${value} ${term.desc ? 'DESC' : 'ASC'}${dialect.orderNulls(nullsFirst)}`;
    });
    orderSql.push(`${rendered.aliasSql}.${dialect.rowIdentity()}`);
    const inner = relation.kind === 'manyToMany'
      ? `SELECT ${rendered.aliasSql}.* FROM ${q(childTable)} AS ${q(childAlias)} `
        + `JOIN ${q(relation.joinTable)} AS ${q(`${childAlias}_j`)} `
        + `ON ${q(`${childAlias}_j`)}.${q(`${relation.to}_key`)} = ${q(childAlias)}.${q(childKey)} `
        + `WHERE ${q(`${childAlias}_j`)}.${q(`${parentNode.entity.name}_key`)} = ${q(parentAlias)}.${q(parentKey)}`
        + (child.where !== null
          ? ` AND ${emitters.emitPred(rendered.aliasSql, rendered.docSql, child.where)}` : '')
        + ` ORDER BY ${orderSql.join(', ')}`
        + (child.take !== undefined ? ` ${dialect.limitClause(child.take, undefined)}` : '')
      : `SELECT ${rendered.aliasSql}.* FROM ${q(childTable)} AS ${q(childAlias)} `
        + `WHERE ${conditions.join(' AND ')} ORDER BY ${orderSql.join(', ')}`
        + (child.take !== undefined ? ` ${dialect.limitClause(child.take, undefined)}` : '');
    if (relation.kind === 'oneToOne') {
      return `(SELECT json_object(${rendered.projection()}) FROM `
        + `(${inner} ${dialect.limitClause(1, undefined)}) AS ${q(childAlias)})`;
    }
    return `(SELECT ${dialect.jsonAgg(`json_object(${rendered.projection()})`)} `
      + `FROM (${inner}) AS ${q(childAlias)})`;
  };

  const buildLoad = (spec) => {
    /** @type {string | null} */
    let key;
    try {
      key = `L|${entityName}|${contentKey(spec ?? {})}|${dialect.name}`;
    }
    catch {
      // contentKey is memo-grade and has no cycle guard; a cyclic
      // specification skips the cache so buildTree can NAME the cycle
      key = null;
    }
    if (key !== null) {
      const cached = state.cache.get(key);
      if (cached !== undefined) {
        state.counters.hits++;
        return cached;
      }
      state.counters.misses++;
    }
    /** @type {ParamCollector} */
    const slots = [];
    const param = (slot) => {
      slots.push(slot);
      return dialect.parameterRef(slots.length, 'v');
    };
    const emitters = createEntityPredicateEmitters(dialect, param);
    const maxDepth = spec?.maxDepth ?? INCLUDE_DEPTH_DEFAULT;
    const tree = buildTree(entityName, spec ?? {}, 0, maxDepth, [], new Set());
    const rendered = render(tree, 'r', param, emitters);

    // anonymous placeholders bind by position, so slots must be
    // collected in SQL text order: the SELECT-list include subqueries
    // come before the root WHERE
    const includeSql = tree.includes.map((include) =>
      `, ${renderInclude(tree, include, 'r', param, emitters)} AS ${q(include.field)}`).join('');

    const conditions = [];
    if (tree.where !== null)
      conditions.push(emitters.emitPred(rendered.aliasSql, rendered.docSql, tree.where));

    // pagination: keyset over a single unique ordering column beats a
    // growing OFFSET; the choice is reported, never silent
    let pagination = 'none';
    const order = tree.order ?? [];
    const uniqueColumns = new Set([
      tree.entityMapping.keys.length === 1 ? tree.entityMapping.keys[0] : null,
      ...tree.entityMapping.indexes.filter((index) => index.unique)
        .map((index) => index.property),
    ]);
    if (spec?.after !== undefined) {
      const term = order.length === 1 ? order[0] : null;
      if (term === null || term.ref.flavor === 'entity-doc'
        || !uniqueColumns.has(term.ref.column)) {
        throw refuse("'after' (keyset pagination) needs a single orderBy over a unique column", []);
      }
      pagination = 'keyset';
      conditions.push(`${rendered.aliasSql}.${q(term.ref.column)} `
        + `${term.desc ? '<' : '>'} ${param({ literal: spec.after })}`);
    }
    else if (spec?.skip !== undefined && spec.skip > 0) {
      pagination = 'offset';
    }

    let sql = `SELECT ${rendered.aliasSql}.*, ${dialect.jsonText(rendered.docSql)} AS ${q('__doc')}`
      + includeSql
      + ` FROM ${q(tree.entityMapping.table)} AS ${rendered.aliasSql}`;
    if (conditions.length > 0) sql += ` WHERE ${conditions.join(' AND ')}`;
    const orderSql = order.map((term) => {
      const value = term.ref.flavor === 'entity-column'
        ? `${rendered.aliasSql}.${q(term.ref.column)}`
        : dialect.jsonExtract(rendered.docSql, dialect.jsonPathText(term.ref.segments));
      const nullsFirst = term.emptyGreatest === term.desc;
      return `${value} ${term.desc ? 'DESC' : 'ASC'}${dialect.orderNulls(nullsFirst)}`;
    });
    orderSql.push(`${rendered.aliasSql}.${dialect.rowIdentity()}`);
    sql += ` ORDER BY ${orderSql.join(', ')}`;
    if (spec?.take !== undefined || pagination === 'offset') {
      sql += ` ${dialect.limitClause(spec?.take ?? null,
        pagination === 'offset' ? spec.skip : undefined)}`;
    }

    const entry = { sql, slots, tree, pagination, statement: null };
    if (key !== null) {
      const sizeBefore = state.cache.size();
      state.cache.set(key, entry);
      if (state.cache.size() === sizeBefore) state.counters.evictions++;
    }
    return entry;
  };

  return {
    treeFor(spec) {
      return buildLoad(spec).tree;
    },
    load(spec) {
      const entry = buildLoad(spec);
      if (entry.statement === null) entry.statement = connection.prepare(entry.sql);
      const params = entry.slots.map((slot) => slot.literal);
      return chain(entry.statement, (statement) =>
        chain(statement.all(params), (rows) =>
          rows.map((row) => parseGraphRow(entry.tree, row, '__doc'))));
    },
    explainLoad(spec) {
      const entry = buildLoad(spec);
      const describe = (node, path) => node.includes.flatMap((include) => [
        { path: [...path, include.name].join('.'), kind: include.kind,
          count: include.count === true },
        ...(include.child === null ? [] : describe(include.child, [...path, include.name])),
      ]);
      return {
        sql: entry.sql,
        pagination: entry.pagination,
        includes: describe(entry.tree, []),
      };
    },
  };
}

/**
 * @typedef {{ literal?: any, external?: string }[]} ParamCollector
 */
