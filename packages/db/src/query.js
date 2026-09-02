//@ts-check
/**
 * @file The query surface over one collection: the D2 provider
 * (`execute(document, options)` — how a linq chain runs here with no
 * import edge), the streaming cursor (`query`), and `explain()`.
 *
 * The statement cache is a CALLER of the core primitives:
 * `createSemanticCache` keyed by the whole discriminating tuple —
 * document plus collection, dialect, strictness, pushdown and profile.
 * The identity is the tuple's COMPLETE serialization, never a
 * fingerprint of it: a 32-bit content hash collides after tens of
 * thousands of documents, and a collision here answers one query with
 * another query's plan and rows. `store.stats()` exposes hits, misses
 * and evictions so the cache is proven rather than assumed.
 *
 * Bind-time diversion: if any referenced external is missing or not a
 * string or finite number, the call runs the always-compilable set
 * residual over the full collection instead of the native statement —
 * SQLite cannot bind a boolean, a `null` needs Jaren's semantics, and
 * a missing external must raise the ENGINE's error, not a driver's.
 * Two externals never bind at all and divert by their own rule: a
 * region reaching the statement through derived slots diverts when it
 * has no box, and a k-nearest probe — which the plan scores in the
 * engine, never in SQL — diverts when it is not a vector of the
 * column's width, so the engine answers what it answers everywhere.
 *
 * The k-nearest mode (`plan.rank`) is a set residual whose candidates
 * an ordering chose: the statement fetches (identity, column) under
 * the pushed WHERE, the engine scores and cuts (`knn.js`), the
 * winners' documents are fetched by identity through the dialect, and
 * the whole document runs over them.
 */

import { createSemanticCache } from '@jarenjs/core/cache';
import { analyzeQuery } from '@jarenjs/json/query';

import { DbCompileError, DbRuntimeError } from './errors.js';
import { chain } from './driver.js';
import {
  planQuery, planEntityQuery, entityShape, planEntityPredicate, entityPathRef,
} from './plan.js';
import { emitPlan, emitEntityPlan, createEntityPredicateEmitters, UnrepresentablePath } from './emit.js';
import { selectPlan, conjoin } from './algebra.js';
import {
  compileSetResidual, compileRowResidual, compilePackedResidual, sequenceResult,
} from './residual.js';
import { createCursor, drainPage, utf8Length, PAGE_LIMIT_DEFAULT } from './cursor.js';
import { deepFreeze } from '@jarenjs/core/object';
import { derivedSlotValue, probeBox, probeVector, columnScore } from './derive.js';
import { cutCandidates, identityBatches } from './knn.js';
import { deterministicFragment, registerFragment } from './udf.js';
import {
  normalizeProfile, translateProfilePredicate,
  applyMandatoryPredicate, applyRowBound, SAFE_PROFILE,
} from './profile.js';

/**
 * The store-wide query state shared by every collection's engine: one
 * bounded statement cache, its counters, the UDF registration set, and
 * the store's resolved registered operators (Ring 2 — `{ functions,
 * extensions }` or `null`), threaded to every engine that builds a
 * residual.
 * @param {number} [bound]
 * @param {{ functions?: any, extensions?: any } | null} [operators]
 * @param {any} [zoneProvider] - D7's injected clock, or absent
 * @returns {any}
 */
export function createQueryState(bound = undefined, operators = null,
  zoneProvider = undefined) {
  return {
    cache: createSemanticCache(bound ?? 128),
    counters: { hits: 0, misses: 0, evictions: 0 },
    /** Fragment identity → the SQL function name registered for it. */
    registered: new Map(),
    operators: operators ?? null,
    // D7's injected clock: a named zone is host code a database does
    // not have, so a calendar ladder over one walks in the residual —
    // and the residual is the caller's OWN document, so the frozen spec
    // reaches the kernel unchanged rather than being rebuilt in UTC
    zoneProvider: zoneProvider ?? null,
  };
}

/**
 * The answer for a native selection's items: the engine's result shape
 * (`undefined | item | items`), or — when the document is a chain's
 * element WINDOW, `[<phrase>]` (plan.js, `wrapped`) — the items as the
 * ONE array that constructor yields, never singleton-unwrapped: an empty
 * selection is `[]`, one row is `[row]`. Exactly the engine's answer for
 * the same document, which is what lets a chain's `toArray()` push.
 * @param {any} entry
 * @param {any[]} items
 * @returns {any}
 */
function answerOf(entry, items) {
  return entry.planned.wrapped === true ? items : sequenceResult(items);
}

/**
 * The same for one aggregate value: `[value]` under the window, and `[]`
 * for an aggregate that answers nothing.
 * @param {any} entry
 * @param {any} value
 * @returns {any}
 */
function wrapValue(entry, value) {
  if (entry.planned.wrapped !== true) return value;
  return value === undefined ? [] : [value];
}

/** @param {any} value - a bindable native parameter? */
function bindable(value) {
  return typeof value === 'string'
    || (typeof value === 'number' && Number.isFinite(value));
}

/**
 * The value one parameter slot binds for a call. A DERIVED slot holds
 * no value of its own: it names one edge of a bound external's
 * bounding box, computed here because a GeoJSON object is not
 * something any database binds.
 * @param {import('./emit.js').ParamSlot} slot
 * @param {any} externals
 * @returns {any}
 */
function slotValue(slot, externals) {
  if ('literal' in slot) return slot.literal;
  if ('derived' in slot)
    return derivedSlotValue(slot.derived, externals[slot.derived.external]);
  return externals[slot.external];
}

/**
 * How one external reaches the statement. An external reached ONLY
 * through derived slots is bindable when its bound value HAS a box —
 * the object itself never had to be bindable. One reached directly
 * must be a string or a finite number, as before; a k-nearest PROBE
 * reaches no slot (it is scored in the engine) and is bindable when
 * its value is a vector of the column's width; and an external in the
 * document that reaches nothing at all still forces the diversion,
 * because the residual needs the engine's own semantics for it.
 * @param {import('./emit.js').ParamSlot[]} slots
 * @param {import('./algebra.js').PlanRank | null} rank
 * @returns {Map<string, 'plain' | 'derived' | 'probe'>}
 */
function externalSlotKinds(slots, rank) {
  /** @type {Map<string, 'plain' | 'derived' | 'probe'>} */
  const kinds = new Map();
  for (const slot of slots) {
    if ('external' in slot) kinds.set(slot.external, 'plain');
    else if ('derived' in slot && !kinds.has(slot.derived.external))
      kinds.set(slot.derived.external, 'derived');
  }
  if (rank !== null && 'ext' in rank.probe && !kinds.has(rank.probe.ext))
    kinds.set(rank.probe.ext, 'probe');
  return kinds;
}

/**
 * The per-call preflight every engine runs: a call already aborted
 * issues no statement (`JD2072`); a deadline already passed issues none
 * either (`JD2075`). A deadline is an epoch-millisecond number, checked
 * here and at every row boundary of a cursor — never inside a statement,
 * because the shipped drivers expose no interrupt.
 * @param {any} options
 */
function requireCallable(options) {
  const signal = options?.signal;
  if (signal?.aborted) {
    throw new DbRuntimeError('JD2072',
      'the call was aborted before it ran: no statement was issued', { cause: signal.reason });
  }
  const deadline = options?.deadline;
  if (deadline === undefined) return;
  if (typeof deadline !== 'number' || !Number.isFinite(deadline))
    throw new TypeError('deadline is an epoch-millisecond number');
  if (Date.now() > deadline) {
    throw new DbRuntimeError('JD2075',
      `the deadline passed before the call ran (${new Date(deadline).toISOString()}); no statement was issued`);
  }
}

/**
 * The budget provenance `explain()` carries (D7): which profile applied
 * and from where, every bound it imposed — each one the engine COUNTS
 * and enforces — and, by name, the two the driver cannot measure:
 * elapsed statement time and visited rows are empty capability slots on
 * SQLite, so they are reported `unavailable`, never approximated.
 * @param {any} profile - the normalized profile, or null
 * @param {'call' | 'store' | null} source
 * @param {any} capabilities - the connection's capability table
 */
function budgetOf(profile, source, capabilities) {
  return {
    profile: profile === null ? null : { source, name: profile === SAFE_PROFILE ? 'safe' : 'custom' },
    rows: profile === null ? null : profile.maxRows,
    includedRows: profile === null ? null : profile.maxIncludedRows,
    depth: profile === null ? null : profile.maxDepth,
    bytes: profile === null ? null : profile.maxBytes,
    limits: profile === null ? null : { ...profile.limits },
    scan: profile !== null && profile.refuseFullScan === true ? 'refused-by-shape' : 'unbounded',
    time: capabilities?.statementTimeout === true ? 'enforced' : 'unavailable',
    estimatedRows: capabilities?.rowEstimates === true ? 'available' : 'unavailable',
  };
}

/**
 * The items one projected row answers (a plan whose `project` is a
 * member path): the JSON type decides — an absent member yields no
 * item, a present `null` a null, `true`/`false` the boolean the integer
 * rendering would have lost, anything else the parsed JSON text.
 * @param {any} row
 * @returns {any[]}
 */
function projectedItems(row) {
  const type = row.t;
  if (type === null || type === undefined) return [];
  if (type === 'true') return [true];
  if (type === 'false') return [false];
  if (type === 'null') return [null];
  if (type === 'object' || type === 'array') return [JSON.parse(row.v)];
  if (type === 'text') return [String(row.v)];
  return [Number(row.v)];
}

/**
 * The query engine for one collection.
 * @param {{ connection: any, state: any, collection: any,
 *   physicalPlan: any, profile?: any }} context - `collection` is the
 *   normalized collection; `physicalPlan` is the DDL plan
 *   (columns, indexes); `profile` is the store-level normalized
 *   profile, if one was opened with
 * @returns {{ execute: Function, query: Function, explain: Function }}
 */
export function createQueryEngine(context) {
  const { connection, state, collection, physicalPlan } = context;
  const storeProfile = context.profile ?? null;
  // the store's registered operators (Ring 2): recognised by the planner
  // as vocabulary, evaluated in the residual, threaded into every
  // residual compilation here. `null` when the store opened with no
  // registry — the whole engine is then byte-identical to before.
  const operators = state.operators ?? null;
  const zoneProvider = state.zoneProvider ?? null;
  const dialect = connection.dialect;
  const shape = {
    collection: collection.name,
    schema: collection.schema,
    columnByCanonical: physicalPlan.columnByCanonical,
    // the DECLARED indexes, in their declared column order: a temporal
    // plan is recognized by the index a model already has, so the
    // planner needs to see the list rather than guess a column's role
    indexes: physicalPlan.expected?.indexes ?? [],
    // the R*Tree virtual tables this collection's `bbox` column sets are
    // realized as, by stem — empty under `physical: 'columns'`, and
    // empty on a driver whose build carries no R*Tree module, because
    // the physical plan already fell back there
    virtualByStem: new Map((physicalPlan.virtualTables ?? [])
      .map((virtual) => [virtual.stem, { name: virtual.name, columns: virtual.columns }])),
    operators,
  };
  const physical = {
    table: physicalPlan.table,
    keyColumn: physicalPlan.keyColumn,
    docColumn: physicalPlan.docColumn,
  };
  /** The k-nearest counters `stats()` reports: how many rows the
   * fetch scored and how many candidates the cut kept, so a
   * duplicate-heavy collection is visible rather than merely slow —
   * plus `diverted`, the calls whose plan WAS the cut and whose bound
   * probe was not a vector of the column's width, so the whole
   * collection was read instead. A plan is recognized once and bound
   * many times; without that counter a probe of the wrong width turns
   * a k-nearest query into a full scan that `explain()` still calls
   * `knn`, which is the one thing this mode may not do quietly. */
  const knnStats = { queries: 0, rows: 0, candidates: 0, fullFetches: 0, diverted: 0 };
  /** The temporal counters `stats()` reports, and the ONLY place a
   * candidate or a result count comes from: `explain()` reads the LAST
   * ACTUAL run's numbers off the cache entry rather than estimating
   * any of them. `statements` is what makes the as-of bound checkable —
   * one narrowing fetch per call, whatever the probes number — and
   * `diverted` counts the calls whose native bucket met a group with no
   * instant and handed the whole question back to the engine. */
  const seriesStats = { queries: 0, statements: 0, candidates: 0, results: 0, diverted: 0 };
  /** The PLAIN bind-time diversion counter: calls whose plan was native
   * or row-mode and whose bound external the database could not take (a
   * boolean, a null, a missing name, a region with no box), so the whole
   * collection was read and the engine answered. The k-nearest and the
   * temporal diversions have their own counters; this is the one the
   * ordinary predicate takes, and it is what proves the diversion in
   * production where nobody calls `explain()`. */
  const bindStats = { diverted: 0 };
  /** The by-identities fetch statements, one per batch size. */
  const identityFetch = new Map();

  const udfHook = connection.capabilities.userFunctions
    ? (/** @type {any} */ fragment, /** @type {string} */ binding) => {
      // Ring 3: admit the registry's pushable:'scalar' operators too
      const qualified = deterministicFragment(fragment, operators, binding);
      if (qualified === null) return null;
      // the store owns the final name: a fingerprint clash between two
      // distinct fragments is disambiguated at registration
      return { ...qualified, name: registerFragment(connection, state.registered, qualified) };
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
    // one TUPLE, not a `|`-joined string: a document may itself contain
    // the separator, so concatenation is not injective and the tuple is
    const key = ['C', document, collection.name, dialect.name, strict, pushdown, profile];
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
        prefilters: [],
        // the whole collection is fetched and the engine answers: the
        // temporal record says so, whatever index the plan would have used
        series: planned.series === null ? null
          : { ...planned.series, mode: 'engine', index: null, prefix: [] },
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

    let plan = shapePlan(planned.plan ?? selectPlan(collection.name));
    let emitted;
    try {
      emitted = emitPlan(plan, dialect, physical);
    }
    catch (error) {
      if (!(error instanceof UnrepresentablePath)) throw error;
      // a member name the dialect cannot spell: the whole document runs
      // in the set residual, named — and strict mode refuses it by name
      if (strict) {
        throw new DbCompileError('JD0010',
          `strict mode refused a residual: 'path' — ${error.message}`, collection.docPath);
      }
      planned = {
        ...planned, plan: null, mode: 'set', rowReturn: null, udfs: [], prefilters: [],
        series: null, reasons: [{ construct: 'path', reason: error.message }, ...planned.reasons],
      };
      plan = shapePlan(selectPlan(collection.name));
      emitted = emitPlan(plan, dialect, physical);
    }
    const externalNames = planned.analysis.externals.map((e) => e.name);
    const limits = profile === null ? undefined : profile.limits;
    const entry = {
      planned,
      plan,
      sql: emitted.sql,
      slots: emitted.slots,
      externalNames,
      externalSlotKinds: externalSlotKinds(emitted.slots, plan.rank),
      // a literal probe is normalized once, here; an external one per
      // call, from the bound value
      probe: plan.rank !== null && 'lit' in plan.rank.probe
        ? probeVector(plan.rank.probe.lit, plan.rank.dims) : null,
      dependencies: planned.analysis.dependencies,
      limits: planned.analysis.limits,
      residualLimits: limits,
      rowBound: maxRows,
      byteBound: profile === null ? null : profile.maxBytes,
      needsScanCheck: profile !== null && profile.refuseFullScan === true,
      scanChecked: false,
      statement: null,
      setResidual: null,
      packedResidual: null,
      rowResidual: planned.mode === 'row'
        ? compileRowResidual(planned.rowReturn, limits, operators, zoneProvider)
        : null,
      fullScanSql: null,
      fullScanShape: () => shapePlan(selectPlan(collection.name)),
      // the LAST actual execution's numbers, never an estimate: `null`
      // until this document has run once
      seriesCounts: null,
    };

    const sizeBefore = state.cache.size();
    if (state.cache.set(key, entry) && state.cache.size() === sizeBefore)
      state.counters.evictions++;
    return entry;
  };

  const statementOf = (entry) => {
    if (entry.statement === null) entry.statement = connection.prepare(entry.sql);
    return entry.statement;
  };
  const setResidualOf = (entry, document) => {
    if (entry.setResidual === null)
      entry.setResidual = compileSetResidual(document, entry.residualLimits, operators,
        zoneProvider);
    return entry.setResidual;
  };
  /** The item-packing variant for cursors: `[document]` packs the
   * whole result sequence into one unambiguous array. */
  const packedResidualOf = (entry, document) => {
    if (entry.packedResidual === null) {
      entry.packedResidual = compilePackedResidual(document, entry.residualLimits, operators,
        zoneProvider);
    }
    return entry.packedResidual;
  };
  /**
   * The diversion fetch: the whole collection, still wearing the
   * profile's mandatory predicate and row bound — a diverted call must
   * not escape either.
   */
  const fullScanEmitted = (entry) => {
    if (entry.fullScanSql === null) {
      const emitted = emitPlan(entry.fullScanShape(), dialect, physical);
      entry.fullScanSql = { sql: emitted.sql, slots: emitted.slots, statement: null };
    }
    return entry.fullScanSql;
  };
  const fullScanOf = (entry) => {
    const emitted = fullScanEmitted(entry);
    if (emitted.statement === null) emitted.statement = connection.prepare(emitted.sql);
    return emitted.statement;
  };
  const fullScanParams = (entry) =>
    fullScanEmitted(entry).slots.map((slot) => ('literal' in slot ? slot.literal : null));

  /** Refuse a fetch that crossed the profile's row bound (JD2007), or
   * a row whose document is larger than its byte bound (JD2076). */
  const checkRowBound = (entry, rows) => {
    if (entry.rowBound !== null && rows.length > entry.rowBound) {
      throw new DbRuntimeError('JD2007',
        `the fetch crossed the profile's maxRows bound of ${entry.rowBound}`,
        { docPath: collection.docPath, collection: collection.name });
    }
    if (entry.byteBound !== null) for (const row of rows) checkByteBound(entry, row);
    return rows;
  };
  /** One row's document against the profile's byte bound. */
  const checkByteBound = (entry, row) => {
    if (entry.byteBound === null || typeof row.doc !== 'string') return;
    const bytes = utf8Length(row.doc);
    if (bytes > entry.byteBound) {
      throw new DbRuntimeError('JD2076',
        `an item of ${bytes} serialised bytes exceeds the profile's maxBytes bound of ${entry.byteBound}`,
        { docPath: collection.docPath, collection: collection.name });
    }
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
    entry.slots.map((slot) => slotValue(slot, externals));

  /** The external whose bound value sends this call to the residual —
   * a value the database cannot take, a region with no box, a probe of
   * the wrong width — or `null` when every external binds. */
  const divertingExternal = (entry, externals) =>
    entry.externalNames.find((name) => {
      const kind = entry.externalSlotKinds.get(name);
      if (kind === 'derived') return probeBox(externals[name]) === null;
      if (kind === 'probe') return probeVector(externals[name], entry.plan.rank.dims) === null;
      return !bindable(externals[name]);
    }) ?? null;
  /** Must this call divert to the residual? */
  const mustDivert = (entry, externals) => divertingExternal(entry, externals) !== null;

  const rowsToDocs = (rows) => rows.map((row) => JSON.parse(row.doc));

  /**
   * The bucket records a native temporal group answers: the ladder's
   * start under the name the document asked for it by, then one member
   * per aggregate with the caller's own word for "no numbers".
   *
   * `null` when a group has no instant at all — a row whose instant
   * member is missing or is not a number groups under SQL `NULL`, and
   * the kernel REFUSES such a row (`JQ2001`). SQL cannot refuse, so the
   * call diverts and the engine answers, exactly as it does everywhere.
   * @param {any} entry
   * @param {any[]} rows
   * @returns {any[] | null}
   */
  const bucketItems = (entry, rows) => {
    const bucket = entry.plan.bucket;
    const items = [];
    for (const row of rows) {
      const start = row[bucket.as] ?? null;
      if (start === null) return null;
      /** @type {any} */
      const item = { [bucket.as]: start };
      for (const aggregate of bucket.aggregates) {
        const value = row[aggregate.as] ?? null;
        if (value === null && aggregate.empty === 'omit') continue;
        item[aggregate.as] = value === null && aggregate.empty === 'zero' ? 0 : value;
      }
      items.push(item);
    }
    return items;
  };

  /** How many ITEMS an engine result carries (its own shape rule). */
  const itemCount = (answer) => (answer === undefined ? 0
    : Array.isArray(answer) ? answer.length : 1);

  /**
   * A native bucket met a group with no instant. The kernel refuses
   * such a row, and SQL cannot, so the whole question goes back to the
   * engine over the whole collection — the same diversion a k-nearest
   * probe of the wrong width takes, and counted the same way.
   */
  const divertBucket = (entry, document, externals) => {
    seriesStats.diverted++;
    return chain(fullScanOf(entry), (statement) =>
      chain(statement.all(fullScanParams(entry)), (rows) => {
        const docs = rowsToDocs(checkRowBound(entry, rows));
        const answer = setResidualOf(entry, document)(docs, externals);
        countSeries(entry, 2, docs.length, itemCount(answer));
        return answer;
      }));
  };

  /** Record one actual execution against the entry and the store. A
   * `null` candidate count is a run the database finished on its own —
   * an aggregate — where no row reached the engine and SQLite reports no
   * visited-row count: the slot stays empty rather than estimated. */
  const countSeries = (entry, statements, candidates, results) => {
    if (entry.planned.series === null) return;
    seriesStats.queries++;
    seriesStats.statements += statements;
    if (candidates !== null) seriesStats.candidates += candidates;
    seriesStats.results += results;
    entry.seriesCounts = { statements, candidates, results, partial: false };
  };
  /** A cursor's run accounting: counted as it is drained, final when it
   * settles; a mid-iteration `explain()` reads the numbers so far and
   * says so (`partial: true`). */
  const seriesTally = (entry) => {
    if (entry.planned.series === null) return null;
    const live = { statements: 1, candidates: 0, results: 0, partial: true };
    entry.seriesCounts = live;
    return {
      row: (items) => {
        live.candidates++;
        live.results += items;
      },
      settle: (opened) => {
        if (entry.seriesCounts === live) entry.seriesCounts = { ...live, partial: false };
        if (opened) countSeries(entry, 1, live.candidates, live.results);
      },
    };
  };

  /**
   * The documents of the given row identities, in identity order,
   * through the dialect's by-identities statement — batched, and each
   * batch padded to a prepared size (`identityBatches`).
   * @param {any[]} identities
   * @returns {any} value-or-promise of the documents
   */
  const fetchByIdentities = (identities) => {
    const batches = identityBatches(identities);
    /** @type {any[]} */
    const docs = [];
    const next = (i) => {
      if (i >= batches.length) return docs;
      const batch = batches[i];
      let statement = identityFetch.get(batch.size);
      if (statement === undefined) {
        statement = connection.prepare(dialect.dml.selectByIdentities(physical, batch.size));
        identityFetch.set(batch.size, statement);
      }
      return chain(statement, (prepared) => chain(prepared.all(batch.params), (rows) => {
        for (const row of rows) docs.push(JSON.parse(row.doc));
        return next(i + 1);
      }));
    };
    return next(0);
  };

  /**
   * The k-nearest candidates: every fetched row's column scored
   * against the probe, the cut applied at `offset + limit` with the
   * plan's margin, and the winners' documents fetched by identity.
   * The engine then decides over them (the set residual).
   * @param {any} entry
   * @param {any} externals
   * @returns {any} value-or-promise of the candidate documents
   */
  const knnCandidates = (entry, externals) => {
    const rank = entry.plan.rank;
    const probe = entry.probe ?? probeVector(externals[rank.probe.ext], rank.dims);
    return chain(statementOf(entry), (statement) =>
      chain(statement.all(bindParams(entry, externals)), (rows) => {
        checkRowBound(entry, rows);
        const scored = rows.map((row) =>
          ({ identity: row.rid, score: columnScore(row.vec, rank.dims, probe) }));
        const cut = cutCandidates(scored, rank.offset + rank.limit, rank.margin);
        knnStats.queries++;
        knnStats.rows += rows.length;
        knnStats.candidates += cut.identities.length;
        if (cut.full) knnStats.fullFetches++;
        return fetchByIdentities(cut.identities);
      }));
  };

  /**
   * The documents a residual runs over: the whole collection when the
   * call diverts (still wearing the profile's mandatory predicate and
   * row bound), the narrowed fetch in set mode, the cut in knn mode.
   * @param {any} entry
   * @param {any} externals
   * @param {boolean} diverted
   * @returns {any} value-or-promise of the documents
   */
  const candidatesOf = (entry, externals, diverted) => {
    if (diverted) {
      // a diversion IS a full-table scan; the plan-shape check above
      // only ever saw the native statement
      if (entry.needsScanCheck) {
        throw profileRefusal(`the profile refuses a full-table scan of '${collection.name}' `
          + '(a bound external the database cannot take diverted the call to the whole collection)');
      }
      if (entry.planned.mode === 'knn') knnStats.diverted++;
      else bindStats.diverted++;
      return chain(fullScanOf(entry), (statement) =>
        chain(statement.all(fullScanParams(entry)), (rows) =>
          rowsToDocs(checkRowBound(entry, rows))));
    }
    if (entry.planned.mode === 'knn') return knnCandidates(entry, externals);
    return chain(statementOf(entry), (statement) =>
      chain(statement.all(bindParams(entry, externals)), (rows) =>
        rowsToDocs(checkRowBound(entry, rows))));
  };

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
    profileSource: options?.profile !== undefined ? 'call' : (storeProfile === null ? null : 'store'),
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
    if (options?.strictStreaming === true) {
      throw new TypeError('strictStreaming applies to a cursor (query()); execute() answers '
        + 'the whole result by contract, so there is no stream to hold it to');
    }
    requireCallable(options);
    const { externals, strict, profile, pushdown } = callState(options);
    const entry = entryFor(document, strict, profile, pushdown);

    return chain(guardScan(entry), () => {
      const diverted = mustDivert(entry, externals);
      if (diverted || entry.planned.mode === 'set' || entry.planned.mode === 'knn') {
        // the candidates — the whole collection, the narrowed fetch, or
        // the k-nearest cut — and the full document over them, which
        // re-applies its own predicates and ordering (idempotent
        // narrowing: the fetch decided nothing)
        return chain(candidatesOf(entry, externals, diverted), (docs) => {
          const answer = setResidualOf(entry, document)(docs, externals);
          countSeries(entry, 1, docs.length, itemCount(answer));
          return answer;
        });
      }
      if (entry.planned.mode === 'row') {
        return chain(statementOf(entry), (statement) =>
          chain(statement.all(bindParams(entry, externals)), (rows) => {
            const items = [];
            for (const row of checkRowBound(entry, rows))
              items.push(...entry.rowResidual(JSON.parse(row.doc), externals));
            countSeries(entry, 1, rows.length, items.length);
            return answerOf(entry, items);
          }));
      }
      return chain(statementOf(entry), (statement) => {
        if (entry.plan.aggregate !== null) {
          return chain(statement.get(bindParams(entry, externals)), (row) => {
            const value = aggregateResult(entry, row);
            countSeries(entry, 1, null, value === undefined ? 0 : 1);
            return wrapValue(entry, value);
          });
        }
        if (entry.plan.bucket !== null) {
          return chain(statement.all(bindParams(entry, externals)), (rows) => {
            const items = bucketItems(entry, checkRowBound(entry, rows));
            if (items === null) return divertBucket(entry, document, externals);
            countSeries(entry, 1, rows.length, items.length);
            return answerOf(entry, items);
          });
        }
        return chain(statement.all(bindParams(entry, externals)), (rows) => {
          checkRowBound(entry, rows);
          const items = entry.plan.project === 'document'
            ? rowsToDocs(rows) : rows.flatMap(projectedItems);
          countSeries(entry, 1, rows.length, items.length);
          return answerOf(entry, items);
        });
      });
    });
  };

  /**
   * What a cursor over this call will do — one database row per pull,
   * or a buffer the first pull fills — and the construct that forces
   * the buffer. `explain()` repeats this classification for the same
   * externals, so the two can never disagree about one run.
   * @param {any} entry
   * @param {any} externals
   * @returns {{ streaming: 'row' | 'buffered',
   *   barrier: import('./cursor.js').CursorBarrier | null }}
   */
  const cursorClass = (entry, externals) => {
    const buffered = (construct, reason) => ({ streaming: 'buffered', barrier: { construct, reason } });
    if (entry.planned.wrapped === true) {
      return buffered('window',
        "a chain's element window is one item — the whole array — whatever the plan mode");
    }
    // a plan that is a residual already buffers for its own reason,
    // whatever its externals bind to; that reason stays first
    if (entry.planned.mode === 'set' || entry.planned.mode === 'knn') {
      const forcing = entry.planned.reasons[0]
        ?? { construct: 'residual', reason: 'the document did not translate' };
      return buffered(forcing.construct, forcing.reason);
    }
    // `null` externals is the ABSTRACT question — the plan as planned,
    // every external assumed bindable — which `explain()` answers when it
    // is given no externals at all; a call always binds real ones
    const unbindable = externals === null ? null : divertingExternal(entry, externals);
    if (unbindable !== null) {
      return buffered('external',
        `the external '${unbindable}' is not a value the database binds; the call runs in the `
        + 'residual over the whole collection');
    }
    if (entry.plan.bucket !== null) {
      return buffered('$groupby', 'a native bucket answers its groups whole: the groups are the result');
    }
    return { streaming: 'row', barrier: null };
  };

  /**
   * A streaming cursor over the document's result ITEMS (`next()` /
   * `return()` plus `Symbol.asyncIterator`), built on the one cursor
   * mechanism (cursor.js). Native and row modes pull one row per
   * `next()` from an open statement; a set residual, a k-nearest cut, a
   * diverting external, a native bucket and a chain's window
   * materialise first and say so (`streaming: 'buffered'`, with the
   * `barrier`); `signal` cancels at a row boundary.
   * @param {any} document
   * @param {{ externals?: any, strict?: boolean, profile?: any,
   *   pushdown?: boolean, signal?: AbortSignal }} [options]
   */
  const query = (document, options = undefined) => {
    requireCallable(options);
    const { externals, strict, profile, pushdown } = callState(options);
    const entry = entryFor(document, strict, profile, pushdown);
    const classified = cursorClass(entry, externals);
    refuseBuffered(options, classified, collection.docPath);
    const signal = options?.signal;
    const deadline = options?.deadline;

    if (entry.planned.wrapped === true) {
      // a chain's element window is ONE item — the array — whatever
      // the plan mode; the cursor hands it over as `execute` answers it
      return createCursor({ ...classified, signal, deadline,
        materialize: () => chain(execute(document, options), (value) => [value]) });
    }
    const diverted = mustDivert(entry, externals);
    if (diverted || entry.planned.mode === 'set' || entry.planned.mode === 'knn') {
      // the barrier: materialize candidates, pack the result items
      return createCursor({ ...classified, signal, deadline,
        materialize: () => chain(guardScan(entry), () =>
          chain(candidatesOf(entry, externals, diverted), (docs) => {
            const items = packedResidualOf(entry, document)(docs, externals);
            countSeries(entry, 1, docs.length, items.length);
            return items;
          })) });
    }
    if (entry.plan.bucket !== null) {
      // a native bucket is a barrier: the groups are the answer
      return createCursor({ ...classified, signal, deadline,
        materialize: () => chain(guardScan(entry), () => chain(statementOf(entry), (statement) =>
          chain(statement.all(bindParams(entry, externals)), (rows) => {
            const items = bucketItems(entry, checkRowBound(entry, rows));
            if (items === null) {
              return chain(divertBucket(entry, document, externals), (value) =>
                (value === undefined ? [] : Array.isArray(value) ? value : [value]));
            }
            countSeries(entry, 1, rows.length, items.length);
            return items;
          }))) });
    }
    if (entry.plan.aggregate !== null) {
      // a native aggregate yields exactly one item
      return createCursor({ ...classified, signal, deadline,
        materialize: () => chain(guardScan(entry), () => chain(statementOf(entry), (statement) =>
          chain(statement.get(bindParams(entry, externals)), (row) => {
            const value = aggregateResult(entry, row);
            countSeries(entry, 1, null, value === undefined ? 0 : 1);
            return value === undefined ? [] : [value];
          }))) });
    }
    let pulledRows = 0;
    const tally = seriesTally(entry);
    return createCursor({ ...classified, signal, deadline,
      open: () => chain(guardScan(entry), () => chain(statementOf(entry),
        (statement) => statement.iterate(bindParams(entry, externals)))),
      items: (row) => {
        pulledRows++;
        if (entry.rowBound !== null && pulledRows > entry.rowBound) {
          throw new DbRuntimeError('JD2007',
            `the fetch crossed the profile's maxRows bound of ${entry.rowBound}`,
            { docPath: collection.docPath, collection: collection.name });
        }
        checkByteBound(entry, row);
        const items = entry.plan.project !== 'document' ? projectedItems(row)
          : entry.rowResidual === null ? [JSON.parse(row.doc)]
            : entry.rowResidual(JSON.parse(row.doc), externals);
        tally?.row(items.length);
        return items;
      },
      onSettle: tally === null ? undefined : tally.settle });
  };

  /**
   * The explanation record: the engine explain shape plus the pushdown
   * facts. `estimatedRows` is deliberately ABSENT — the capability
   * slot is empty on SQLite and no number is fabricated; the
   * database's own plan prose rides in `scanNarrative` instead. So is
   * every count in `series`: they are the LAST ACTUAL execution's, and
   * `null` until this document has run once.
   * @param {any} document
   * @param {{ externals?: any, strict?: boolean }} [options]
   */
  const explain = (document, options = undefined) => {
    const { externals, strict, profile, profileSource, pushdown } = callState(options);
    const entry = entryFor(document, strict, profile, pushdown);
    // the run this call would make: bound against the externals it was
    // given, a diversion reads the whole collection through the
    // diversion statement and answers in the set residual — so that is
    // the mode, the SQL and the barrier reported, not the native plan's
    // no externals at all is the abstract plan, as it always was; given
    // externals — even a partial set — are bound as execute would bind them
    const bound = options?.externals !== undefined;
    const classified = cursorClass(entry, bound ? externals : null);
    const diverted = bound && mustDivert(entry, externals);
    const chosen = diverted ? fullScanEmitted(entry) : entry;
    const mode = diverted ? 'set' : entry.planned.mode;

    const touchedColumns = new Set();
    // an R*Tree probe touches no generated column at all — the index it
    // reads IS a table — so the virtual tables are collected beside the
    // declared indexes and named in the same `indexes` list
    const touchedVirtual = new Set();
    const collectColumns = (pred) => {
      if (pred === null) return;
      if (pred.p === 'and' || pred.p === 'or') pred.items.forEach(collectColumns);
      else if (pred.p === 'not') collectColumns(pred.item);
      else if (pred.p === 'bboxOverlap')
        for (const column of Object.values(pred.columns)) touchedColumns.add(column);
      else if (pred.p === 'bboxRtree') touchedVirtual.add(pred.table);
      else if (pred.p === 'cellIn' || pred.p === 'cellPrefix')
        touchedColumns.add(pred.column);
      else if ('ref' in pred && pred.ref?.column) touchedColumns.add(pred.ref.column);
    };
    collectColumns(entry.plan.filter);
    for (const term of entry.plan.order ?? []) {
      if (term.ref.column !== null) touchedColumns.add(term.ref.column);
    }
    if (entry.plan.aggregate?.ref?.column) touchedColumns.add(entry.plan.aggregate.ref.column);
    if (entry.plan.bucket !== null) {
      if (entry.plan.bucket.ref.column) touchedColumns.add(entry.plan.bucket.ref.column);
      for (const aggregate of entry.plan.bucket.aggregates) {
        if (aggregate.ref?.column) touchedColumns.add(aggregate.ref.column);
      }
    }
    const indexes = [
      ...physicalPlan.expected.indexes
        .filter((index) => index.columns.some((column) => touchedColumns.has(column)))
        .map((index) => index.name),
      ...[...touchedVirtual].sort(),
    ];

    const params = chosen.slots.map((slot) => {
      if ('external' in slot) return { external: slot.external };
      if ('derived' in slot) return { derived: { ...slot.derived } };
      return { literal: slot.literal };
    });
    const eqpParams = chosen.slots.map((slot) => {
      const value = slotValue(slot, externals);
      return bindable(value) ? value : null;
    });
    // a diversion is one more reason the engine answers, appended after
    // the plan's own: a residual stays a residual for its own reason,
    // and a native plan's only reason is the value that would not bind
    const reasons = diverted
      ? [...entry.planned.reasons, {
        construct: 'external',
        reason: `the external '${divertingExternal(entry, externals)}' is not a value the database `
          + 'binds; the call runs in the residual over the whole collection',
      }]
      : entry.planned.reasons;

    const rank = entry.plan.rank;
    return chain(connection.prepare(dialect.explainQuery(chosen.sql)), (statement) =>
      chain(statement.all(eqpParams), (rows) => ({
        mode,
        // what a cursor over this call does — one row per pull, or a
        // buffer — and the construct that forces the buffer: the same
        // classification the cursor itself carries, so the two agree
        streaming: classified.streaming,
        barrier: classified.barrier,
        // the profile that applied and every bound it imposed (D7)
        budget: budgetOf(profile, profileSource, connection.capabilities),
        // the one member path the statement projects, when it does: the
        // whole document is read otherwise
        projection: entry.plan.project === 'document' ? null
          : { path: entry.plan.project.path.segments.map((segment) =>
            ('name' in segment ? segment.name : segment.index)) },
        // a chain's element window (`[<phrase>]`): the phrase planned as
        // if bare, its rows answered as the one array item
        wrapped: entry.planned.wrapped === true,
        externals: [...entry.externalNames],
        operators: [...entry.dependencies.operators],
        functions: [...entry.dependencies.functions],
        collations: [...entry.dependencies.collations],
        limits: entry.residualLimits ?? entry.limits,
        sql: chosen.sql,
        params,
        indexes,
        prefilters: entry.planned.prefilters.map((prefilter) => ({ ...prefilter,
          columns: [...prefilter.columns] })),
        // the k-nearest stage, when the plan has one: what the fetch
        // reads, the window the cut serves, the margin it keeps, and
        // who decides the order — always the engine
        rank: rank === null ? null : {
          column: rank.column,
          dims: rank.dims,
          probe: 'lit' in rank.probe ? { literal: [...rank.probe.lit] } : { external: rank.probe.ext },
          limit: rank.limit,
          offset: rank.offset,
          margin: rank.margin,
          decides: 'engine',
        },
        residual: mode === 'native'
          ? null
          : { mode, reasons },
        barriers: mode === 'set' || mode === 'knn'
          ? reasons.map((r) => ({ operator: r.construct, reason: r.reason }))
          : [],
        udfs: [...entry.planned.udfs],
        // the temporal record: what the document asked, which declared
        // index the fetch seeks through, and which kernel finished it.
        // The counts are the LAST ACTUAL execution's — `null` before
        // this document has run — because an estimate mislabelled as a
        // count is exactly the thing an honest explain may not print
        series: entry.planned.series === null ? null : {
          ...entry.planned.series,
          counts: entry.seriesCounts === null ? null : { ...entry.seriesCounts },
        },
        scanNarrative: rows.map((row) => String(row.detail)).join('; '),
      })));
  };

  return { execute, query, explain, shape,
    stats: () => ({ knn: { ...knnStats }, series: { ...seriesStats }, bind: { ...bindStats } }) };
}

/**
 * `strictStreaming` (D6 applied to memory): a plan that would buffer is
 * declined by name before any statement runs, never run with its memory
 * behaviour quietly changed.
 * @param {any} options
 * @param {{ streaming: string, barrier: import('./cursor.js').CursorBarrier | null }} classified
 * @param {string | undefined} docPath
 */
function refuseBuffered(options, classified, docPath) {
  if (options?.strictStreaming !== true || classified.streaming !== 'buffered') return;
  const barrier = classified.barrier;
  throw new DbCompileError('JD0037',
    `strictStreaming refused a plan that buffers: '${barrier?.construct}' — ${barrier?.reason}`,
    docPath);
}

// ————— The entity query surface (the second document kind) —————

import { mergeEntityRow, parseGraphRow } from './graph.js';
import { relationTables } from './model.js';

/** The default include depth bound (D14: printed, never silent). */
export const INCLUDE_DEPTH_DEFAULT = 3;
/** The default per-root bounds of an included to-many relation
 * (MODEL-FORMAT §10.4): rows per parent, and serialised bytes per
 * parent. A bound always exists — one root that aggregates an unbounded
 * relation is not a bounded item — and the unbounded case is spelled
 * (`maxRows: Infinity`), never inherited. An explicit `take` is the row
 * bound of the include it windows. */
export const INCLUDE_ROWS_DEFAULT = 1000;
export const INCLUDE_BYTES_DEFAULT = 1_048_576;

/**
 * Plan one `where` EXPRESSION over `$it` against one entity: the plan
 * predicate when every conjunct translates, else the first refusal —
 * the one translation the include tree, the profile's mandatory
 * predicates and the entity residual's narrowing all share.
 * @param {any} expression
 * @param {any} entity - the normalized entity
 * @param {any} entityMapping - `explainMapping(...).entities[name]`
 * @param {any} analyzeOpts
 * @returns {{ filter: any } | { refusal: { construct: string, reason: string } } | { error: Error }}
 */
function planEntityWhere(expression, entity, entityMapping, analyzeOpts) {
  const wrapper = { $for: { it: '$[*]' }, $where: expression, $return: '$it' };
  let analysis;
  try {
    analysis = analyzeQuery(wrapper, analyzeOpts);
  }
  catch (cause) {
    return { error: /** @type {Error} */ (cause) };
  }
  const flwor = analysis.root;
  const slot = flwor.forBindings[0].slot;
  const shape = entityShape(entity, entityMapping);
  const conjuncts = flwor.where.kind === 'op' && flwor.where.name === '$and'
    ? flwor.where.args : [flwor.where];
  let filter = null;
  for (const conjunct of conjuncts) {
    const outcome = planEntityPredicate(conjunct, slot, shape);
    if ('refusal' in outcome) return { refusal: outcome.refusal };
    filter = conjoin(filter, outcome.pred);
  }
  return { filter };
}

/**
 * The profile's mandatory predicate for one entity, translated — a
 * host-configured predicate that cannot translate is a host programming
 * error (`TypeError`), exactly as on a collection: there is no residual
 * to hide it in, because the point is that it binds the fetch.
 * @param {any} profile
 * @param {any} entity
 * @param {any} entityMapping
 * @param {any} analyzeOpts
 * @returns {any} a plan predicate, or null
 */
function mandatoryEntityPredicate(profile, entity, entityMapping, analyzeOpts) {
  const expression = profile?.predicates?.[entity.name];
  if (expression === undefined) return null;
  const planned = planEntityWhere(expression, entity, entityMapping, analyzeOpts);
  if ('filter' in planned && planned.filter !== null) return planned.filter;
  throw new TypeError(`a profile predicate must translate natively (it binds the database-side fetch of '${
    entity.name}'); this one refused: ${'refusal' in planned ? planned.refusal.reason
    : 'error' in planned ? planned.error.message : 'it selects nothing'}`);
}

/**
 * The profile's compile-time refusal for an entity document (`JD0011`).
 * @param {string} reason
 * @param {string | undefined} docPath
 */
const profileEntityRefusal = (reason, docPath) => new DbCompileError('JD0011', reason, docPath);

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
  const storeProfile = context.profile ?? null;
  const operators = state.operators ?? null;
  const analyzeOpts = operators ?? undefined;
  const zoneProvider = state.zoneProvider ?? null;
  const dialect = connection.dialect;
  const q = dialect.quoteIdentifier;
  const physicalOf = (name) => ({ table: mapping.entities[name].table });
  // the relation tables of every root this engine serves (§10.1): the
  // engine is the scope every entity set of the store shares, so a
  // producer holding one set can follow a hop into another root
  const relations = relationTables(entities);

  /** The switches one call resolves: the profile per call replaces the
   * store's, normalized over the safe defaults, as on a collection. */
  const callState = (options) => ({
    externals: options?.externals ?? {},
    strict: options?.strict === true,
    pushdown: options?.pushdown !== false,
    profile: options?.profile !== undefined ? normalizeProfile(options.profile) : storeProfile,
    profileSource: options?.profile !== undefined ? 'call' : (storeProfile === null ? null : 'store'),
  });

  const entryFor = (document, pushdown, profile = null) => {
    const key = ['E', document, dialect.name, pushdown, profile];
    const cached = state.cache.get(key);
    if (cached !== undefined) {
      state.counters.hits++;
      return cached;
    }
    state.counters.misses++;
    let planned = planEntityQuery(document, entities, mapping, operators);
    if (planned.referenced.length === 0) {
      // `$[*]` over the entity MAP answered the rows of every entity,
      // mixed, and explain() named no table read; the root is the map
      // of entity arrays, and a query ranges over one of them by name
      throw new DbCompileError('JD0033',
        'an entity query ranges over a declared entity array ($.<Entity>[*]); this '
        + 'document names none, so it has no rows to answer', '/entities');
    }
    if (!pushdown) {
      planned = { ...planned, mode: 'set', plan: null,
        reasons: [{ construct: 'pushdown', reason: 'disabled by the harness switch' }] };
    }
    const docPath = entities.get(planned.referenced[0])?.docPath;
    // the profile, applied exactly as on a collection (MODEL-FORMAT §8):
    // the roots a document may read, the references it may make, the
    // predicate every fetch of a root must wear, the row bound every
    // fetch carries, and the shape refusal of a whole-root residual
    if (profile !== null) {
      for (const name of planned.referenced) {
        if (profile.collections !== null && !profile.collections.includes(name))
          throw profileEntityRefusal(`the profile does not allow querying entity '${name}'`, docPath);
      }
      const deps = planned.analysis.dependencies;
      for (const name of deps.functions) {
        if (!profile.functions.includes(name))
          throw profileEntityRefusal(`the profile does not allow the host function '${name}'`, docPath);
      }
      for (const name of deps.collations) {
        if (!profile.collations.includes(name))
          throw profileEntityRefusal(`the profile does not allow the collation '${name}'`, docPath);
      }
      for (const external of planned.analysis.externals) {
        if (!profile.externals.includes(external.name))
          throw profileEntityRefusal(`the profile does not declare the external '${external.name}'`, docPath);
      }
      if (planned.mode !== 'native' && profile.refuseFullScan === true) {
        // the residual reads every row of every referenced root before
        // the engine decides — a full-table scan by shape, refused at
        // preflight rather than estimated (D6)
        throw profileEntityRefusal('the profile refuses a full-table scan, and the residual this '
          + `document needs fetches every row of ${planned.referenced.join(', ')} `
          + `('${planned.reasons[0]?.construct}' — ${planned.reasons[0]?.reason})`, docPath);
      }
    }
    const mandatory = new Map();
    if (profile !== null) {
      for (const name of planned.referenced) {
        const predicate = mandatoryEntityPredicate(profile, entities.get(name), mapping.entities[name], analyzeOpts);
        if (predicate !== null) mandatory.set(name, predicate);
      }
    }
    const entry = {
      planned,
      sql: null,
      slots: null,
      statement: null,
      setResidual: null,
      packedResidual: null,
      fetchers: null,
      mandatory,
      rowBound: profile === null ? null : profile.maxRows,
      byteBound: profile === null ? null : profile.maxBytes,
      residualLimits: profile === null ? undefined : profile.limits,
      needsScanCheck: profile !== null && profile.refuseFullScan === true,
      scanChecked: false,
    };
    if (planned.mode === 'native') {
      let plan = planned.plan;
      if (mandatory.size > 0) {
        plan = { ...plan, filters: plan.filters.map((entry) => {
          const binding = plan.bindings.find((candidate) => candidate.name === entry.binding);
          const predicate = mandatory.get(binding.entity);
          return predicate === undefined ? entry : { ...entry, filter: conjoin(entry.filter, predicate) };
        }) };
      }
      if (entry.rowBound !== null && plan.aggregate === null) {
        const cap = entry.rowBound + 1;
        plan = { ...plan, window: plan.window === null ? { offset: 0, limit: cap }
          : { offset: plan.window.offset, limit: plan.window.limit === null ? cap : Math.min(plan.window.limit, cap) } };
      }
      const emitted = emitEntityPlan(plan, dialect, physicalOf);
      entry.sql = emitted.sql;
      entry.slots = emitted.slots;
    }
    const sizeBefore = state.cache.size();
    if (state.cache.set(key, entry) && state.cache.size() === sizeBefore)
      state.counters.evictions++;
    return entry;
  };

  /** Refuse a native fetch that crossed the profile's row bound (JD2007). */
  const checkRows = (entry, rows, name) => {
    if (entry.rowBound !== null && rows.length > entry.rowBound) {
      throw new DbRuntimeError('JD2007',
        `the fetch crossed the profile's maxRows bound of ${entry.rowBound}`,
        { docPath: entities.get(name)?.docPath, collection: name });
    }
    return rows;
  };
  /** One merged entity document against the profile's byte bound
   * (JD2076): measured after the merge, because the mapped scalars live
   * in columns and the row's own JSON text holds only the rest. */
  const checkBytes = (entry, doc, name) => {
    if (entry.byteBound === null) return doc;
    const bytes = utf8Length(JSON.stringify(doc));
    if (bytes > entry.byteBound) {
      throw new DbRuntimeError('JD2076',
        `an item of ${bytes} serialised bytes exceeds the profile's maxBytes bound of ${entry.byteBound}`,
        { docPath: entities.get(name)?.docPath, collection: name });
    }
    return doc;
  };
  /** The plan-shape refusal on a native plan: a full-table SCAN of any
   * referenced root, verified against the database's own plan output. */
  const guardEntityScan = (entry) => {
    if (!entry.needsScanCheck || entry.scanChecked) return null;
    const eqpParams = entry.slots.map((slot) => ('literal' in slot ? slot.literal : null));
    return chain(connection.prepare(dialect.explainQuery(entry.sql)), (statement) =>
      chain(statement.all(eqpParams), (rows) => {
        // the entity statement aliases its tables `t0`, `t1`, … and the
        // database's narrative names the alias; a bare table name is
        // the residual fetcher's spelling
        const tables = entry.planned.referenced.map((name) => mapping.entities[name].table);
        const scanned = rows.find((row) => {
          const detail = String(row.detail);
          return (/^SCAN t\d+\b/.test(detail) || tables.some((table) => detail.startsWith(`SCAN ${table}`)))
            && !detail.includes('USING INDEX');
        });
        if (scanned !== undefined) {
          throw profileEntityRefusal('the profile refuses a full-table scan of '
            + `${entry.planned.referenced.join(', ')} (${rows.map((row) => String(row.detail)).join('; ')})`,
          entities.get(entry.planned.referenced[0])?.docPath);
        }
        entry.scanChecked = true;
        return null;
      }));
  };

  /** Fetch every referenced entity's rows and build the in-memory
   * root — each fetch wearing the profile's mandatory predicate for its
   * entity and its row bound (`LIMIT maxRows + 1`, refused when crossed),
   * so a residual's input is as bounded as a native answer. */
  const fetchRoot = (entry) => {
    if (entry.fetchers === null) {
      entry.fetchers = [...(entry.planned.referenced.length === 0
        ? entities.keys() : entry.planned.referenced)].map((name) => {
        /** @type {any[]} */
        const slots = [];
        const emitters = createEntityPredicateEmitters(dialect, (slot) => {
          slots.push(slot);
          return dialect.parameterRef(slots.length, 'v');
        });
        const predicate = entry.mandatory.get(name);
        const where = predicate === undefined ? ''
          : ` WHERE ${emitters.emitPred(q('t'), `${q('t')}.${q('doc')}`, predicate)}`;
        const limit = entry.rowBound === null ? '' : ` ${dialect.limitClause(entry.rowBound + 1, undefined)}`;
        return {
          name,
          sql: `SELECT ${q('t')}.*, ${dialect.jsonText(`${q('t')}.${q('doc')}`)} AS ${q('__doc')} `
            + `FROM ${q(mapping.entities[name].table)} AS ${q('t')}${where} `
            + `ORDER BY ${q('t')}.${dialect.rowIdentity()}${limit}`,
          params: slots.map((slot) => slot.literal),
          statement: null,
        };
      });
    }
    /** @type {any} */
    const root = {};
    const next = (i) => {
      if (i >= entry.fetchers.length) return root;
      const fetcher = entry.fetchers[i];
      if (fetcher.statement === null) fetcher.statement = connection.prepare(fetcher.sql);
      return chain(fetcher.statement, (statement) =>
        chain(statement.all(fetcher.params), (rows) => {
          root[fetcher.name] = checkRows(entry, rows, fetcher.name).map((row) =>
            checkBytes(entry, mergeEntityRow(mapping.entities[fetcher.name], row, '__doc'), fetcher.name));
          return next(i + 1);
        }));
    };
    return next(0);
  };

  const runResidual = (entry, document, externals) => {
    if (entry.setResidual === null)
      entry.setResidual = compileSetResidual(document, entry.residualLimits, operators, zoneProvider);
    return chain(fetchRoot(entry), (root) => entry.setResidual(root, externals));
  };

  const execute = (document, options = undefined) => {
    requireCallable(options);
    const { externals, strict, pushdown, profile } = callState(options);
    const entry = entryFor(document, pushdown, profile);
    if (entry.planned.mode !== 'native') {
      if (strict) {
        const forcing = entry.planned.reasons[0];
        throw new DbCompileError('JD0010',
          `strict mode refused a residual: '${forcing.construct}' — ${forcing.reason}`);
      }
      return runResidual(entry, document, externals);
    }
    // bind-time diversion, exactly the collection engine's: every slot
    // binds through `slotValue` — a derived slot included — and a value
    // the database cannot take (a missing external, a boolean, a null,
    // a region with no box) sends the call to the residual, where the
    // ENGINE raises its own error or answers with its own semantics
    const params = entry.slots.map((slot) => slotValue(slot, externals));
    if (params.some((value) => !bindable(value)))
      return runResidual(entry, document, externals);
    if (entry.statement === null) entry.statement = connection.prepare(entry.sql);
    return chain(guardEntityScan(entry), () => chain(entry.statement, (statement) => {
      if (entry.planned.plan.aggregate === 'count')
        return chain(statement.get(params), (row) => wrapValue(entry, row?.value ?? 0));
      return chain(statement.all(params), (rows) => {
        const retEntity = entry.planned.plan.bindings
          .find((binding) => binding.name === entry.planned.plan.ret).entity;
        return answerOf(entry, checkRows(entry, rows, retEntity).map((row) =>
          checkBytes(entry, mergeEntityRow(mapping.entities[retEntity], row, '__doc'), retEntity)));
      });
    }));
  };

  /** The item-packing residual for a cursor over the fetched root. */
  const packedResidualOf = (entry, document) => {
    if (entry.packedResidual === null)
      entry.packedResidual = compilePackedResidual(document, entry.residualLimits, operators, zoneProvider);
    return entry.packedResidual;
  };

  /**
   * The bind-time diversion, named: the first parameter slot whose
   * value the database cannot take — a missing external, a boolean, a
   * null, a region with no box — or `null` when the statement binds.
   * @param {any} entry
   * @param {any} externals
   * @returns {{ construct: string, reason: string } | null}
   */
  const divertReason = (entry, externals) => {
    for (const slot of entry.slots) {
      if (bindable(slotValue(slot, externals))) continue;
      const name = 'external' in slot ? slot.external
        : 'derived' in slot ? slot.derived.external : null;
      return {
        construct: 'external',
        reason: `${name === null ? 'a literal' : `the external '${name}'`} is not a value the `
          + 'database binds; the call runs in the residual over the fetched root',
      };
    }
    return null;
  };

  /**
   * What a cursor over this call will do, and why — the collection
   * engine's classification over the entity plan shapes: a chain's
   * window, a set residual (its first reason names the construct), a
   * diverting external, else one row per pull.
   * @param {any} entry
   * @param {any} externals
   * @returns {{ streaming: 'row' | 'buffered',
   *   barrier: import('./cursor.js').CursorBarrier | null }}
   */
  const cursorClass = (entry, externals) => {
    const buffered = (barrier) => ({ streaming: 'buffered', barrier });
    if (entry.planned.wrapped === true) {
      return buffered({ construct: 'window',
        reason: "a chain's element window is one item — the whole array — whatever the plan mode" });
    }
    if (entry.planned.mode !== 'native') {
      const forcing = entry.planned.reasons[0]
        ?? { construct: 'residual', reason: 'the document did not translate' };
      return buffered({ construct: forcing.construct, reason: forcing.reason });
    }
    // `null` externals is the abstract question: the plan as planned
    const diverted = externals === null ? null : divertReason(entry, externals);
    return diverted === null ? { streaming: 'row', barrier: null } : buffered(diverted);
  };

  /**
   * The item cursor over an entity document — the collection engine's
   * `query()` over the second document kind, on the one cursor
   * mechanism (cursor.js): a native selection or join pulls one row
   * per `next()` from an open statement and merges it into its entity
   * document; a count yields its one item; a set residual and a
   * diverting external materialise the fetched root first and say so.
   * `register`, when given, is the unit of work's registration: every
   * yielded entity document passes through it, which is why the
   * document must return a bare entity binding (`JD0034` otherwise) —
   * a projection is not a snapshot anything could save.
   * @param {any} document
   * @param {{ externals?: any, strict?: boolean, pushdown?: boolean,
   *   signal?: AbortSignal }} [options]
   * @param {((entity: string, doc: any) => any) | undefined} [register]
   */
  const query = (document, options = undefined, register = undefined) => {
    requireCallable(options);
    const { externals, strict, pushdown, profile } = callState(options);
    const entry = entryFor(document, pushdown, profile);
    if (strict && entry.planned.mode !== 'native') {
      const forcing = entry.planned.reasons[0];
      throw new DbCompileError('JD0010',
        `strict mode refused a residual: '${forcing.construct}' — ${forcing.reason}`);
    }
    const retEntity = entry.planned.retEntity;
    if (register !== undefined && retEntity === null) {
      throw new DbCompileError('JD0034',
        'a tracked cursor registers the entity documents it yields, and this document '
        + 'yields none: it returns a projection, a count or a window rather than one bare '
        + 'entity binding — read it untracked, or return the binding itself');
    }
    const each = register === undefined ? (item) => item : (item) => register(retEntity, item);
    const classified = cursorClass(entry, externals);
    refuseBuffered(options, classified, entities.get(entry.planned.retEntity ?? '')?.docPath);
    const signal = options?.signal;
    const deadline = options?.deadline;
    if (entry.planned.wrapped === true) {
      return createCursor({ ...classified, signal, deadline,
        materialize: () => chain(execute(document, options), (value) => [value]) });
    }
    if (classified.barrier !== null) {
      return createCursor({ ...classified, signal, deadline,
        materialize: () => chain(fetchRoot(entry), (root) =>
          packedResidualOf(entry, document)(root, externals).map(each)) });
    }
    const params = entry.slots.map((slot) => slotValue(slot, externals));
    if (entry.statement === null) entry.statement = connection.prepare(entry.sql);
    if (entry.planned.plan.aggregate === 'count') {
      return createCursor({ ...classified, signal, deadline,
        materialize: () => chain(guardEntityScan(entry), () => chain(entry.statement, (statement) =>
          chain(statement.get(params), (row) => [row?.value ?? 0]))) });
    }
    const rowEntity = entry.planned.plan.bindings
      .find((binding) => binding.name === entry.planned.plan.ret).entity;
    let pulledRows = 0;
    return createCursor({ ...classified, signal, deadline,
      open: () => chain(guardEntityScan(entry), () => chain(entry.statement,
        (statement) => statement.iterate(params))),
      items: (row) => {
        pulledRows++;
        if (entry.rowBound !== null && pulledRows > entry.rowBound) {
          throw new DbRuntimeError('JD2007',
            `the fetch crossed the profile's maxRows bound of ${entry.rowBound}`,
            { docPath: entities.get(rowEntity)?.docPath, collection: rowEntity });
        }
        return [each(checkBytes(entry, mergeEntityRow(mapping.entities[rowEntity], row, '__doc'), rowEntity))];
      } });
  };

  const explain = (document, options = undefined) => {
    const { pushdown, profile, profileSource } = callState(options);
    const entry = entryFor(document, pushdown, profile);
    // bound against the externals it was given: a value the database
    // cannot take sends the run to the residual over the fetched root,
    // and that is the mode reported, with the diversion named first; no
    // externals at all is the abstract plan, as it always was
    const classified = cursorClass(entry, options?.externals ?? null);
    const diverted = entry.planned.mode === 'native' && classified.barrier !== null
      && classified.barrier.construct === 'external';
    const mode = diverted ? 'set' : entry.planned.mode;
    const reasons = diverted && classified.barrier !== null
      ? [classified.barrier, ...entry.planned.reasons] : entry.planned.reasons;
    const base = {
      mode,
      streaming: classified.streaming,
      barrier: classified.barrier,
      budget: budgetOf(profile, profileSource, connection.capabilities),
      wrapped: entry.planned.wrapped === true,
      referenced: [...entry.planned.referenced],
      reasons,
      sql: diverted ? null : entry.sql,
      residual: mode === 'native'
        ? null
        : { mode: 'set', reasons },
    };
    if (mode !== 'native') return base;
    return chain(connection.prepare(dialect.explainQuery(entry.sql)), (statement) =>
      chain(statement.all(entry.slots.map((slot) =>
        ('literal' in slot ? slot.literal : null))), (rows) => ({
        ...base,
        join: entry.planned.plan.joinOn,
        scanNarrative: rows.map((row) => String(row.detail)).join('; '),
      })));
  };

  return { execute, query, explain, relations };
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
  const storeProfile = context.profile ?? null;
  // the entity core's column encoding (booleans to integers, an epoch
  // column's string to its epoch): what a continuation's DOCUMENT values
  // bind as when the keyset compares them with the stored columns
  const encodeColumn = context.coreFor === undefined
    ? (/** @type {string} */ column, /** @type {any} */ value) => value
    : (column, value) => context.coreFor(entityName).plan.encodeColumn(column, value);
  // a registered operator (Ring 2) is recognised as vocabulary so a
  // where/orderBy that uses one refuses cleanly (JD0032 — the load path
  // is all-SQL, with no residual), never as an unknown operator
  const analyzeOpts = state.operators ?? undefined;
  const dialect = connection.dialect;
  const q = dialect.quoteIdentifier;

  const refuse = (reason, path) => new DbCompileError('JD0032',
    `${reason} (include path: ${path.join('.') || '<root>'})`,
    entities.get(entityName)?.docPath);
  const isWindowBound = (value) => Number.isSafeInteger(value) && value >= 0;
  /** A per-root bound as declared: a positive integer, or `Infinity` /
   * `null` for the unbounded case a caller spelled on purpose. */
  const isBound = (value) => value === null || value === Infinity
    || (Number.isSafeInteger(value) && value >= 1);
  /** An include's window inside its subquery: LIMIT, and OFFSET for a
   * `skip` — per parent row, since the subquery is correlated (§10.4).
   * A to-many include with no `take` still carries `LIMIT maxRows + 1`,
   * so a relation past its bound is DETECTED at the bound instead of
   * aggregated whole and then refused — the profile's row-bound rule,
   * applied per root. */
  const windowClause = (child) => {
    const limit = child.take ?? (child.rowLimit === null ? null : child.rowLimit + 1);
    return limit !== null || (child.skip !== undefined && child.skip > 0)
      ? ` ${dialect.limitClause(limit, child.skip)}` : '';
  };

  /** Compile a where EXPRESSION over `$it` against one entity. */
  const compileWhere = (expression, entity, path) => {
    const planned = planEntityWhere(expression, entity, mapping.entities[entity.name], analyzeOpts);
    if ('error' in planned) {
      throw new DbCompileError('JD0032',
        `the where expression does not compile (include path: ${path.join('.')})`,
        entity.docPath, planned.error);
    }
    if ('refusal' in planned) {
      throw refuse(`the where expression is not translatable: ${planned.refusal.reason}`, path);
    }
    return planned.filter;
  };
  /** The profile applied to one node of the include tree (§8): the
   * entity must be allowed, and its mandatory predicate — when the
   * profile carries one — is conjoined into the node's own filter, at
   * the root and inside every include subquery alike. */
  const applyProfileToNode = (node, name, profile, path) => {
    if (profile === null) return node;
    if (profile.collections !== null && !profile.collections.includes(name)) {
      throw profileEntityRefusal(`the profile does not allow loading entity '${name}'`
        + ` (include path: ${path.join('.') || '<root>'})`, entities.get(name)?.docPath);
    }
    const predicate = mandatoryEntityPredicate(profile, entities.get(name), mapping.entities[name], analyzeOpts);
    if (predicate === null) return node;
    return { ...node, where: conjoin(node.where, predicate) };
  };

  const compileOrder = (orderBy, entity, path) => {
    const specs = Array.isArray(orderBy) ? orderBy : [orderBy];
    const wrapper = { $for: { it: '$[*]' }, $orderby: specs, $return: '$it' };
    let analysis;
    try {
      analysis = analyzeQuery(wrapper, analyzeOpts);
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
  const buildTree = (name, spec, depth, maxDepth, path, seen, profile = null) => {
    const entity = entities.get(name);
    if (depth > maxDepth) {
      throw refuse(`the include graph exceeds its depth bound of ${maxDepth} `
        + '(raise it explicitly with maxDepth)', path);
    }
    /** @type {any} */
    const node = {
      entity,
      entityMapping: mapping.entities[name],
      where: spec?.where !== undefined ? compileWhere(spec.where, entity, path) : null,
      order: spec?.orderBy !== undefined ? compileOrder(spec.orderBy, entity, path) : null,
      take: spec?.take,
      skip: spec?.skip,
      /** the per-root row bound a to-many include's subquery detects at;
       * set by the parent, `null` at the root and for a to-one */
      rowLimit: null,
      includes: [],
    };
    const shaped = applyProfileToNode(node, name, profile, path);
    const includeSpec = spec?.include;
    if (includeSpec === undefined) return shaped;
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
      if (childSpec.count === true) {
        // a count counts EVERY related row; a where/take beside it was
        // dropped without a word, and the number answered was the total
        const dropped = ['where', 'orderBy', 'take', 'skip', 'include', 'after', 'maxRows', 'maxBytes']
          .filter((member) => childSpec[member] !== undefined);
        if (dropped.length > 0) {
          throw refuse(`count: true counts every related row and takes no ${dropped.join('/')} — `
            + 'load the rows to count a subset', [...path, relationName]);
        }
      }
      for (const member of ['take', 'skip']) {
        if (childSpec[member] !== undefined && !isWindowBound(childSpec[member]))
          throw refuse(`${member} must be a non-negative integer`, [...path, relationName]);
      }
      for (const member of ['maxRows', 'maxBytes']) {
        if (childSpec[member] !== undefined && !isBound(childSpec[member]))
          throw refuse(`${member} must be a positive integer, or Infinity (null in JSON) to load the relation unbounded by decision`,
            [...path, relationName]);
      }
      // a keyset cursor is one position in ONE ordered set; an include is
      // a set per parent, so it windows with skip/take and never seeks
      if (childSpec.after !== undefined) {
        throw refuse("'after' (keyset pagination) paginates the root — an include windows with skip and take",
          [...path, relationName]);
      }
      const childName = relation.to;
      const many = relation.kind !== 'oneToOne';
      // the per-root bounds (§10.4): declared, else the include's own
      // `take` (a window IS a row bound), else the store default; `null`
      // is the unbounded case, spelled
      const boundOf = (member, fallback) => {
        const declared = childSpec[member];
        if (declared === undefined) return fallback;
        return declared === Infinity ? null : declared;
      };
      const maxRows = many ? boundOf('maxRows', childSpec.take ?? INCLUDE_ROWS_DEFAULT) : null;
      if (profile !== null && profile.maxIncludedRows !== null && many && childSpec.count !== true
        && (maxRows === null || maxRows > profile.maxIncludedRows)) {
        // the profile's cap on included rows per root is a hard maximum
        // the include's own declaration cannot exceed (D6: refused, not
        // narrowed quietly)
        throw profileEntityRefusal(`the profile caps included rows per root at ${profile.maxIncludedRows}; `
          + `the include '${relationName}' declares ${maxRows === null ? 'no bound (Infinity)' : maxRows}`
          + ` (include path: ${[...path, relationName].join('.')})`, entity.docPath);
      }
      const include = {
        name: relationName,
        field: `__${relationName}`,
        relation,
        many,
        maxRows,
        maxBytes: childSpec.count === true ? null : boundOf('maxBytes', INCLUDE_BYTES_DEFAULT),
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
            [...path, relationName], seen, profile),
      };
      // the subquery's own LIMIT detects the bound (windowClause)
      if (include.child !== null) include.child.rowLimit = many ? include.maxRows : null;
      shaped.includes.push(include);
    }
    return shaped;
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
      if (relation.kind === 'manyToMany') {
        const join = mapping.joinTables[relation.joinTable];
        const own = join.left.entity === parentNode.entity.name ? join.left : join.right;
        return `(SELECT COUNT(*) FROM ${q(relation.joinTable)} AS ${q(childAlias)} `
          + `WHERE ${q(childAlias)}.${q(own.column)} = ${q(parentAlias)}.${q(parentKey)})`;
      }
      if (relation.kind === 'oneToOne') {
        const childKey = mapping.entities[relation.to].keys[0];
        return `(SELECT COUNT(*) FROM ${q(childTable)} AS ${q(childAlias)} `
          + `WHERE ${q(childAlias)}.${q(childKey)} = ${q(parentAlias)}.${q(relation.via)})`;
      }
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
        + windowClause(child)
      : `SELECT ${rendered.aliasSql}.* FROM ${q(childTable)} AS ${q(childAlias)} `
        + `WHERE ${conditions.join(' AND ')} ORDER BY ${orderSql.join(', ')}`
        + windowClause(child);
    if (relation.kind === 'oneToOne') {
      return `(SELECT json_object(${rendered.projection()}) FROM `
        + `(${inner} ${dialect.limitClause(1, undefined)}) AS ${q(childAlias)})`;
    }
    return `(SELECT ${dialect.jsonAgg(`json_object(${rendered.projection()})`)} `
      + `FROM (${inner}) AS ${q(childAlias)})`;
  };

  /**
   * The ordering's IDENTITY in keyset mode: the declared column terms
   * with their direction and null placement, then the primary-key
   * column(s) not already named, ascending — the tie-breaker the plan
   * appends whether or not the caller named it, since the key is the
   * one column guaranteed unique. A document-path term cannot carry a
   * keyset (`JD0032`).
   * @param {any[]} order - the compiled order terms
   * @param {readonly string[]} keyColumns
   * @returns {{ column: string, desc: boolean, nullsFirst: boolean }[]}
   */
  const orderIdentity = (order, keyColumns) => {
    const terms = order.map((term) => {
      if (term.ref.flavor !== 'entity-column') {
        throw refuse('a keyset orders by mapped columns — '
          + `'${term.ref.segments.join('.')}' is a document path`, []);
      }
      return { column: term.ref.column, desc: term.desc, nullsFirst: term.emptyGreatest === term.desc };
    });
    for (const column of keyColumns) {
      // a key column is NOT NULL: `nullsFirst` is SQLite's own ASC
      // default, spelled so the identity is explicit, never a branch
      if (!terms.some((term) => term.column === column))
        terms.push({ column, desc: false, nullsFirst: true });
    }
    return terms;
  };

  /**
   * A structural continuation, checked against THIS ordering: the
   * `{ order, keys, key }` a page emitted, whose `order` must be this
   * graph's identity exactly — a continuation replayed against another
   * ordering is `JD0035`, never a wrong page — and whose values are
   * returned aligned with the identity, encoded as the columns store them.
   * @param {any} after
   * @param {ReturnType<typeof orderIdentity>} identity
   * @param {number} declared - how many terms the caller declared
   * @param {readonly string[]} keyColumns
   * @returns {any[]} one value per identity term
   */
  const continuationValues = (after, identity, declared, keyColumns) => {
    const mismatch = (reason) => new DbCompileError('JD0035',
      `the continuation does not belong to this ordering: ${reason}`,
      entities.get(entityName)?.docPath);
    const spell = (terms) => terms.map((term) => `${term.column} ${term.desc ? 'desc' : 'asc'}`
      + `${term.nullsFirst ? ' nulls first' : ''}`).join(', ');
    if (after === null || typeof after !== 'object' || !Array.isArray(after.order)
      || !Array.isArray(after.keys) || !('key' in after)) {
      throw mismatch('a continuation is the { order, keys, key } value a page emitted');
    }
    if (JSON.stringify(after.order) !== JSON.stringify(identity)) {
      throw mismatch(`it was emitted for the ordering (${spell(after.order)}); this graph orders `
        + `by (${spell(identity)})`);
    }
    if (after.keys.length !== declared) {
      throw mismatch(`it carries ${after.keys.length} order-key value(s); the ordering declares ${declared}`);
    }
    const keyOf = (column) => {
      if (keyColumns.length === 1) {
        if (typeof after.key !== 'string' && typeof after.key !== 'number')
          throw mismatch("'key' must be the row's primary key, a scalar");
        return after.key;
      }
      const value = after.key?.[column];
      if (typeof value !== 'string' && typeof value !== 'number')
        throw mismatch(`'key' must carry every key column { ${keyColumns.join(', ')} }`);
      return value;
    };
    return identity.map((term, i) => encodeColumn(term.column,
      i < declared ? (after.keys[i] ?? null) : keyOf(term.column)));
  };

  /**
   * Build the load: one statement, cached by spec. `keyset` forces
   * keyset mode — the primary key as the ORDER BY tie-breaker in place of
   * the row identity, so a continuation can resume exactly — which a
   * structural `after` implies; a scalar `after` keeps the single
   * unique-column keyset it always was.
   * @param {any} spec
   * @param {boolean} [keyset]
   */
  const buildLoad = (spec, keyset = false, profile = null) => {
    // a cyclic specification cannot be keyed, so the cache reports a
    // permanent miss and buildTree gets to NAME the cycle
    const key = ['L', entityName, spec ?? {}, dialect.name, keyset, profile];
    const cached = state.cache.get(key);
    if (cached !== undefined) {
      state.counters.hits++;
      return cached;
    }
    state.counters.misses++;
    /** @type {ParamCollector} */
    const slots = [];
    const param = (slot) => {
      slots.push(slot);
      return dialect.parameterRef(slots.length, 'v');
    };
    const emitters = createEntityPredicateEmitters(dialect, param);
    const maxDepth = spec?.maxDepth ?? INCLUDE_DEPTH_DEFAULT;
    if (profile !== null && profile.maxDepth !== null && maxDepth > profile.maxDepth) {
      throw profileEntityRefusal(`the profile caps the include depth at ${profile.maxDepth}; `
        + `this load asks for ${maxDepth}`, entities.get(entityName)?.docPath);
    }
    for (const member of ['take', 'skip']) {
      // interpolated into LIMIT/OFFSET as written: a string ran as SQL
      if (spec?.[member] !== undefined && !isWindowBound(spec[member]))
        throw refuse(`${member} must be a non-negative integer`, []);
    }
    const tree = buildTree(entityName, spec ?? {}, 0, maxDepth, [], new Set(), profile);
    const rendered = render(tree, 'r', param, emitters);

    // anonymous placeholders bind by position, so slots must be
    // collected in SQL text order: the SELECT-list include subqueries
    // come before the root WHERE
    const includeSql = tree.includes.map((include) =>
      `, ${renderInclude(tree, include, 'r', param, emitters)} AS ${q(include.field)}`).join('');

    const conditions = [];
    if (tree.where !== null)
      conditions.push(emitters.emitPred(rendered.aliasSql, rendered.docSql, tree.where));

    // pagination: keyset beats a growing OFFSET; the choice is reported,
    // never silent. A scalar `after` is the single unique-column keyset;
    // a structural one — or a page — is the composite keyset: the
    // lexicographic expansion over the declared terms with the primary
    // key appended, null placement agreeing with the ORDER BY (§10.5)
    let pagination = 'none';
    const order = tree.order ?? [];
    const after = spec?.after === null ? undefined : spec?.after;
    const structural = after !== undefined && typeof after === 'object';
    const keysetMode = keyset || structural;
    const keyColumns = tree.entityMapping.keys;
    const uniqueColumns = new Set([
      keyColumns.length === 1 ? keyColumns[0] : null,
      ...tree.entityMapping.indexes.filter((index) => index.unique)
        .map((index) => index.property),
    ]);
    /** @type {ReturnType<typeof orderIdentity> | null} */
    let identity = null;
    if (keysetMode) {
      identity = orderIdentity(order, keyColumns);
      if (after !== undefined) {
        if (!structural) {
          throw new DbCompileError('JD0035',
            'the continuation does not belong to this ordering: a page resumes from the '
            + '{ order, keys, key } value a page emitted, not a bare key',
            entities.get(entityName)?.docPath);
        }
        pagination = 'keyset';
        const values = continuationValues(after, identity, order.length, keyColumns);
        const column = (term) => `${rendered.aliasSql}.${q(term.column)}`;
        const equal = (i) => (values[i] === null
          ? `${column(identity[i])} IS NULL`
          : `${column(identity[i])} = ${param({ literal: values[i] })}`);
        // "comes after the value in this term's order": a null value is
        // followed by the non-nulls when nulls sort first and by nothing
        // when they sort last; a non-null value is followed by the greater
        // (or lesser, descending) values, and by the nulls when they sort
        // last — the comparison alone would drop them, since SQL's
        // `col > ?` is neither true nor false for NULL
        const beyond = (i) => {
          const term = identity[i];
          if (values[i] === null) return `${column(term)} IS NOT NULL`;
          const base = `${column(term)} ${term.desc ? '<' : '>'} ${param({ literal: values[i] })}`;
          // a key column is NOT NULL and needs no null branch
          return term.nullsFirst || keyColumns.includes(term.column)
            ? base : `(${base} OR ${column(term)} IS NULL)`;
        };
        const branches = [];
        for (let i = 0; i < identity.length; i++) {
          // after a null that sorts last comes nothing in this term: the
          // branch is empty, and only the tie-break branches remain
          if (values[i] === null && !identity[i].nullsFirst) continue;
          // parameters bind by position, so the parts are built in SQL
          // text order: the equalities first, then the strict comparison
          const parts = [];
          for (let j = 0; j < i; j++) parts.push(equal(j));
          parts.push(beyond(i));
          branches.push(parts.length === 1 ? parts[0] : `(${parts.join(' AND ')})`);
        }
        conditions.push(branches.length === 0 ? '0' : `(${branches.join(' OR ')})`);
      }
    }
    else if (after !== undefined) {
      const term = order.length === 1 ? order[0] : null;
      if (term === null || term.ref.flavor === 'entity-doc'
        || !uniqueColumns.has(term.ref.column)) {
        throw refuse("'after' (keyset pagination) needs a single orderBy over a unique column", []);
      }
      pagination = 'keyset';
      conditions.push(`${rendered.aliasSql}.${q(term.ref.column)} `
        + `${term.desc ? '<' : '>'} ${param({ literal: after })}`);
    }
    else if (spec?.skip !== undefined && spec.skip > 0) {
      pagination = 'offset';
    }

    let sql = `SELECT ${rendered.aliasSql}.*, ${dialect.jsonText(rendered.docSql)} AS ${q('__doc')}`
      + includeSql
      + ` FROM ${q(tree.entityMapping.table)} AS ${rendered.aliasSql}`;
    if (conditions.length > 0) sql += ` WHERE ${conditions.join(' AND ')}`;
    const orderSql = identity !== null
      ? identity.map((term) => `${rendered.aliasSql}.${q(term.column)} `
        + `${term.desc ? 'DESC' : 'ASC'}${dialect.orderNulls(term.nullsFirst)}`)
      : order.map((term) => {
        const value = term.ref.flavor === 'entity-column'
          ? `${rendered.aliasSql}.${q(term.ref.column)}`
          : dialect.jsonExtract(rendered.docSql, dialect.jsonPathText(term.ref.segments));
        const nullsFirst = term.emptyGreatest === term.desc;
        return `${value} ${term.desc ? 'DESC' : 'ASC'}${dialect.orderNulls(nullsFirst)}`;
      });
    if (identity === null) orderSql.push(`${rendered.aliasSql}.${dialect.rowIdentity()}`);
    sql += ` ORDER BY ${orderSql.join(', ')}`;
    // the profile's row bound rides the root as LIMIT maxRows + 1, so
    // a load past it is detected at the bound and refused (JD2007)
    const rowBound = profile === null ? null : profile.maxRows;
    const take = rowBound === null ? spec?.take
      : Math.min(spec?.take ?? Infinity, rowBound + 1);
    if (take !== undefined || pagination === 'offset') {
      sql += ` ${dialect.limitClause(take === undefined ? null : take,
        pagination === 'offset' ? spec.skip : undefined)}`;
    }

    const entry = {
      sql, slots, tree, pagination, statement: null,
      rowBound,
      byteBound: profile === null ? null : profile.maxBytes,
      profile,
      identity: identity === null ? null : deepFreeze(identity),
      declared: order.map((term) => term.ref.column),
      keyColumns,
      // a page over this ordering is a snapshot only when every order key
      // is immutable, and the primary key is the one column the engine
      // itself guarantees never moves (`update()` refuses to rewrite it)
      snapshot: identity === null ? null : identity.every((term) => keyColumns.includes(term.column)),
    };
    const sizeBefore = state.cache.size();
    if (state.cache.set(key, entry) && state.cache.size() === sizeBefore)
      state.counters.evictions++;
    return entry;
  };

  /** One loaded root against the profile's row and byte bounds. */
  const checkRoot = (entry, doc, pulled) => {
    if (entry.rowBound !== null && pulled > entry.rowBound) {
      throw new DbRuntimeError('JD2007',
        `the load crossed the profile's maxRows bound of ${entry.rowBound}`,
        { docPath: entities.get(entityName)?.docPath, collection: entityName });
    }
    if (entry.byteBound !== null) {
      const bytes = utf8Length(JSON.stringify(doc));
      if (bytes > entry.byteBound) {
        throw new DbRuntimeError('JD2076',
          `an item of ${bytes} serialised bytes exceeds the profile's maxBytes bound of ${entry.byteBound}`,
          { docPath: entities.get(entityName)?.docPath, collection: entityName });
      }
    }
    return doc;
  };
  /** The profile one call resolves, as on the query engines. */
  const profileOf = (options) => (options?.profile !== undefined
    ? normalizeProfile(options.profile) : storeProfile);
  const profileSourceOf = (options) => (options?.profile !== undefined ? 'call'
    : (storeProfile === null ? null : 'store'));

  /** The graph cursor over one built load: one root row per pull. */
  const openCursor = (entry, signal, register, deadline = undefined) => {
    if (entry.statement === null) entry.statement = connection.prepare(entry.sql);
    const params = entry.slots.map((slot) => slot.literal);
    const each = register === undefined ? (doc) => doc : (doc) => register(entry.tree, doc);
    let pulled = 0;
    return createCursor({ streaming: 'row', barrier: null, signal, deadline,
      open: () => chain(entry.statement, (statement) => statement.iterate(params)),
      items: (row) => [each(checkRoot(entry, parseGraphRow(entry.tree, row, '__doc'), ++pulled))] });
  };

  /**
   * The continuation one root emits: unsigned, structural, opaque —
   * the ordering's identity (so it cannot be replayed against another
   * ordering), the declared order-key values as the DOCUMENT carries
   * them, and the row's primary key, the tie-breaker. Signing, tenant
   * scoping, expiry and wire encoding are the host's: the store has no
   * principal and no key, and a signature it invented would be theatre.
   */
  const continuationOf = (entry, doc) => deepFreeze({
    order: entry.identity,
    keys: entry.declared.map((column) => doc[column] ?? null),
    key: entry.keyColumns.length === 1
      ? doc[entry.keyColumns[0]]
      : Object.fromEntries(entry.keyColumns.map((column) => [column, doc[column]])),
  });

  return {
    treeFor(spec) {
      return buildLoad(spec).tree;
    },
    load(spec, options = undefined) {
      requireCallable(options);
      const entry = buildLoad(spec, false, profileOf(options));
      if (entry.statement === null) entry.statement = connection.prepare(entry.sql);
      const params = entry.slots.map((slot) => slot.literal);
      return chain(entry.statement, (statement) =>
        chain(statement.all(params), (rows) =>
          rows.map((row, i) => checkRoot(entry, parseGraphRow(entry.tree, row, '__doc'), i + 1))));
    },
    /**
     * The graph cursor: ONE root graph per pull, its includes attached
     * and bounded, from the same one statement `load` runs — the include
     * rows ride inside each root row as the JSON the database projected,
     * so the window is the row itself and no second statement per level
     * exists to hold or release. `register`, when given, is the unit of
     * work's graph registration, applied per root as it is yielded.
     * @param {any} spec
     * @param {{ signal?: AbortSignal }} [options]
     * @param {((tree: any, doc: any) => any) | undefined} [register]
     */
    loadCursor(spec, options = undefined, register = undefined) {
      requireCallable(options);
      return openCursor(buildLoad(spec, false, profileOf(options)), options?.signal, register,
        options?.deadline);
    },
    /**
     * One page: a bounded drain of the graph cursor in keyset mode —
     * `limit` roots at most, `maxBytes` serialised bytes at most, the
     * continuation of the last delivered root, `hasMore` by one peek —
     * plus `snapshot`, true only over an immutable ordering (§10.5).
     * `consistency: 'snapshot'` over a mutable ordering is refused
     * (`JD0036`) rather than mislabelled; the default `'live'` reports
     * the truth either way.
     * @param {any} spec
     * @param {{ limit?: number, after?: any, maxBytes?: number | null,
     *   consistency?: 'live' | 'snapshot', signal?: AbortSignal }} [options]
     * @param {((tree: any, doc: any) => any) | undefined} [register]
     */
    page(spec, options = undefined, register = undefined) {
      requireCallable(options);
      const limit = options?.limit ?? PAGE_LIMIT_DEFAULT;
      if (!Number.isSafeInteger(limit) || limit < 1)
        throw refuse('page() limit must be a positive integer', []);
      const declaredBytes = options?.maxBytes;
      const maxBytes = declaredBytes === undefined || declaredBytes === null || declaredBytes === Infinity
        ? null : declaredBytes;
      if (maxBytes !== null && !(Number.isSafeInteger(maxBytes) && maxBytes >= 1))
        throw refuse('page() maxBytes must be a positive integer, or Infinity for no byte bound', []);
      const consistency = options?.consistency ?? 'live';
      if (consistency !== 'live' && consistency !== 'snapshot')
        throw refuse("page() consistency is 'live' or 'snapshot'", []);
      if (spec?.take !== undefined || spec?.skip !== undefined)
        throw refuse('page() windows by its limit and continuation — a take or skip in the spec is refused', []);
      const after = options?.after ?? spec?.after ?? undefined;
      const paged = { ...(spec ?? {}), take: limit + 1 };
      if (after === undefined) delete paged.after;
      else paged.after = after;
      const entry = buildLoad(paged, true, profileOf(options));
      if (consistency === 'snapshot' && entry.snapshot !== true) {
        throw new DbCompileError('JD0036',
          `a snapshot page needs an ordering over immutable keys; this graph orders by (${
            entry.declared.join(', ')}), which a write may change, so it is LIVE pagination — a `
          + 'row whose order key changes can move across the cursor. Order by the primary key, '
          + "or ask for consistency: 'live' and read snapshot: false",
          entities.get(entityName)?.docPath);
      }
      // the drain peeks one root past the page to decide `hasMore`, so
      // registration happens on the DELIVERED roots after the drain — a
      // peeked root the caller never received must not enter the unit
      // of work
      const cursor = openCursor(entry, options?.signal, undefined, options?.deadline);
      return drainPage(cursor, {
        limit, maxBytes, after: after ?? null,
        sizeOf: (doc) => utf8Length(JSON.stringify(doc)),
        continuationOf: (doc) => continuationOf(entry, doc),
      }).then((page) => ({
        ...page,
        items: register === undefined ? page.items : page.items.map((doc) => register(entry.tree, doc)),
        snapshot: entry.snapshot === true,
      }));
    },
    explainLoad(spec, options = undefined) {
      const entry = buildLoad(spec, spec?.after !== undefined && typeof spec.after === 'object', profileOf(options));
      const describe = (node, path) => node.includes.flatMap((include) => [
        { path: [...path, include.name].join('.'), kind: include.kind,
          count: include.count === true },
        ...(include.child === null ? [] : describe(include.child, [...path, include.name])),
      ]);
      // the per-root bounds every include runs under (§10.4): `null` is
      // the unbounded case a caller spelled; a count carries none
      const bounds = (node, path) => node.includes.flatMap((include) => [
        ...(include.count === true ? [] : [{ path: [...path, include.name].join('.'),
          maxRows: include.maxRows, maxBytes: include.maxBytes }]),
        ...(include.child === null ? [] : bounds(include.child, [...path, include.name])),
      ]);
      return {
        sql: entry.sql,
        pagination: entry.pagination,
        includes: describe(entry.tree, []),
        bounds: bounds(entry.tree, []),
        // the keyset's ordering identity and whether a page over it is a
        // snapshot — `null` for a load that is not in keyset mode, whose
        // tie-breaker is the row identity
        order: entry.identity,
        snapshot: entry.snapshot,
        // a graph load pulls one root row per statement row, always
        streaming: 'row',
        barrier: null,
        // the profile that applied and every bound it imposed (D7)
        budget: budgetOf(entry.profile, profileSourceOf(options), connection.capabilities),
      };
    },
  };
}

/**
 * @typedef {{ literal?: any, external?: string }[]} ParamCollector
 */
