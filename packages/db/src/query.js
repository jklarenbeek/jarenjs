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
import { compileJsonQuery, analyzeQuery } from '@jarenjs/json/query';

import { DbCompileError, DbRuntimeError } from './errors.js';
import { chain } from './driver.js';
import {
  planQuery, planEntityQuery, entityShape, planEntityPredicate, entityPathRef,
} from './plan.js';
import { emitPlan, emitEntityPlan, createEntityPredicateEmitters, UnrepresentablePath } from './emit.js';
import { selectPlan } from './algebra.js';
import { compileSetResidual, compileRowResidual, sequenceResult } from './residual.js';
import { derivedSlotValue, probeBox, probeVector, columnScore } from './derive.js';
import { cutCandidates, identityBatches } from './knn.js';
import { deterministicFragment, registerFragment } from './udf.js';
import {
  normalizeProfile, translateProfilePredicate,
  applyMandatoryPredicate, applyRowBound,
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
  /** The by-identities fetch statements, one per batch size. */
  const identityFetch = new Map();

  /** The `compileJsonQuery` options for an inline residual: the
   * profile's engine limits plus the store's registered operators. */
  const residualCompileOptions = (limits) => {
    const functions = operators?.functions;
    const extensions = operators?.extensions;
    if (limits === undefined && functions === undefined && extensions === undefined
      && zoneProvider === null)
      return undefined;
    /** @type {any} */
    const options = {};
    if (limits !== undefined) options.limits = limits;
    if (functions !== undefined) options.functions = functions;
    if (extensions !== undefined) options.extensions = extensions;
    if (zoneProvider !== null) options.zoneProvider = zoneProvider;
    return options;
  };

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
      const compiled = compileJsonQuery([document], residualCompileOptions(entry.residualLimits));
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
    entry.slots.map((slot) => slotValue(slot, externals));

  /** Must this call divert to the residual? */
  const mustDivert = (entry, externals) =>
    entry.externalNames.some((name) => {
      const kind = entry.externalSlotKinds.get(name);
      if (kind === 'derived') return probeBox(externals[name]) === null;
      if (kind === 'probe') return probeVector(externals[name], entry.plan.rank.dims) === null;
      return !bindable(externals[name]);
    });

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

  /** Record one actual execution against the entry and the store. */
  const countSeries = (entry, statements, candidates, results) => {
    if (entry.planned.series === null) return;
    seriesStats.queries++;
    seriesStats.statements += statements;
    seriesStats.candidates += candidates;
    seriesStats.results += results;
    entry.seriesCounts = { statements, candidates, results };
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
            return answerOf(entry, items);
          }));
      }
      return chain(statementOf(entry), (statement) => {
        if (entry.plan.aggregate !== null) {
          return chain(statement.get(bindParams(entry, externals)),
            (row) => wrapValue(entry, aggregateResult(entry, row)));
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
          const docs = rowsToDocs(checkRowBound(entry, rows));
          countSeries(entry, 1, docs.length, docs.length);
          return answerOf(entry, docs);
        });
      });
    });
  };

  /**
   * A streaming cursor over the document's result ITEMS (`next()` /
   * `return()` plus `Symbol.asyncIterator`).
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

      if (entry.planned.wrapped === true) {
        // a chain's element window is ONE item — the array — whatever
        // the plan mode; the cursor hands it over as `execute` answers it
        if (materialized === null) {
          materialized = Promise.resolve(chain(execute(document, options), (value) => {
            buffered = [value];
            bufferedAt = 0;
          }));
        }
        return materialized.then(() => {
          if (bufferedAt < buffered.length) return nextFromBuffer();
          done = true;
          return { done: true, value: undefined };
        });
      }
      if (entry.planned.mode === 'set' || entry.planned.mode === 'knn'
        || mustDivert(entry, externals)) {
        // the barrier: materialize candidates, pack the result items
        if (materialized === null) {
          const diverted = mustDivert(entry, externals);
          materialized = Promise.resolve(chain(guardScan(entry), () =>
            chain(candidatesOf(entry, externals, diverted), (docs) => {
              buffered = packedResidualOf(entry, document)(docs, externals);
              bufferedAt = 0;
              countSeries(entry, 1, docs.length, buffered.length);
            })));
        }
        return materialized.then(() => {
          if (bufferedAt < buffered.length) return nextFromBuffer();
          done = true;
          return { done: true, value: undefined };
        });
      }
      if (entry.plan.bucket !== null) {
        // a native bucket is a barrier: the groups are the answer
        if (materialized === null) {
          materialized = Promise.resolve(chain(guardScan(entry), () =>
            chain(statementOf(entry), (statement) =>
              chain(statement.all(bindParams(entry, externals)), (rows) => {
                const items = bucketItems(entry, checkRowBound(entry, rows));
                if (items === null) {
                  const answer = divertBucket(entry, document, externals);
                  return chain(answer, (value) => {
                    buffered = value === undefined ? []
                      : Array.isArray(value) ? value : [value];
                    bufferedAt = 0;
                  });
                }
                countSeries(entry, 1, rows.length, items.length);
                buffered = items;
                bufferedAt = 0;
                return null;
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
   * database's own plan prose rides in `scanNarrative` instead. So is
   * every count in `series`: they are the LAST ACTUAL execution's, and
   * `null` until this document has run once.
   * @param {any} document
   * @param {{ externals?: any, strict?: boolean }} [options]
   */
  const explain = (document, options = undefined) => {
    const { externals, strict, profile, pushdown } = callState(options);
    const entry = entryFor(document, strict, profile, pushdown);

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

    const params = entry.slots.map((slot) => {
      if ('external' in slot) return { external: slot.external };
      if ('derived' in slot) return { derived: { ...slot.derived } };
      return { literal: slot.literal };
    });
    const eqpParams = entry.slots.map((slot) => {
      const value = slotValue(slot, externals);
      return bindable(value) ? value : null;
    });

    const rank = entry.plan.rank;
    return chain(connection.prepare(dialect.explainQuery(entry.sql)), (statement) =>
      chain(statement.all(eqpParams), (rows) => ({
        mode: entry.planned.mode,
        // a chain's element window (`[<phrase>]`): the phrase planned as
        // if bare, its rows answered as the one array item
        wrapped: entry.planned.wrapped === true,
        externals: [...entry.externalNames],
        operators: [...entry.dependencies.operators],
        functions: [...entry.dependencies.functions],
        collations: [...entry.dependencies.collations],
        limits: entry.residualLimits ?? entry.limits,
        sql: entry.sql,
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
        residual: entry.planned.mode === 'native'
          ? null
          : { mode: entry.planned.mode, reasons: entry.planned.reasons },
        barriers: entry.planned.mode === 'set' || entry.planned.mode === 'knn'
          ? entry.planned.reasons.map((r) => ({ operator: r.construct, reason: r.reason }))
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
    stats: () => ({ knn: { ...knnStats }, series: { ...seriesStats } }) };
}

// ————— The entity query surface (the second document kind) —————

import { mergeEntityRow, parseGraphRow } from './graph.js';
import { relationTables } from './model.js';

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
  const operators = state.operators ?? null;
  const zoneProvider = state.zoneProvider ?? null;
  const dialect = connection.dialect;
  const q = dialect.quoteIdentifier;
  const physicalOf = (name) => ({ table: mapping.entities[name].table });
  // the relation tables of every root this engine serves (§10.1): the
  // engine is the scope every entity set of the store shares, so a
  // producer holding one set can follow a hop into another root
  const relations = relationTables(entities);

  const entryFor = (document, pushdown) => {
    const key = ['E', document, dialect.name, pushdown];
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
    if (state.cache.set(key, entry) && state.cache.size() === sizeBefore)
      state.counters.evictions++;
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
      entry.setResidual = compileSetResidual(document, undefined, operators, zoneProvider);
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
    // bind-time diversion, exactly the collection engine's: every slot
    // binds through `slotValue` — a derived slot included — and a value
    // the database cannot take (a missing external, a boolean, a null,
    // a region with no box) sends the call to the residual, where the
    // ENGINE raises its own error or answers with its own semantics
    const params = entry.slots.map((slot) => slotValue(slot, externals));
    if (params.some((value) => !bindable(value)))
      return runResidual(entry, document, externals);
    if (entry.statement === null) entry.statement = connection.prepare(entry.sql);
    return chain(entry.statement, (statement) => {
      if (entry.planned.plan.aggregate === 'count')
        return chain(statement.get(params), (row) => wrapValue(entry, row?.value ?? 0));
      return chain(statement.all(params), (rows) => {
        const retEntity = entry.planned.plan.bindings
          .find((binding) => binding.name === entry.planned.plan.ret).entity;
        return answerOf(entry, rows.map((row) =>
          mergeEntityRow(mapping.entities[retEntity], row, '__doc')));
      });
    });
  };

  const explain = (document, options = undefined) => {
    const pushdown = options?.pushdown !== false;
    const entry = entryFor(document, pushdown);
    const base = {
      mode: entry.planned.mode,
      wrapped: entry.planned.wrapped === true,
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

  return { execute, explain, relations };
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
  /** An include's window inside its subquery: LIMIT, and OFFSET for a
   * `skip` — per parent row, since the subquery is correlated (§10.4). */
  const windowClause = (child) => (child.take !== undefined || (child.skip !== undefined && child.skip > 0)
    ? ` ${dialect.limitClause(child.take ?? null, child.skip)}` : '');

  /** Compile a where EXPRESSION over `$it` against one entity. */
  const compileWhere = (expression, entity, path) => {
    const wrapper = { $for: { it: '$[*]' }, $where: expression, $return: '$it' };
    let analysis;
    try {
      analysis = analyzeQuery(wrapper, analyzeOpts);
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
      skip: spec?.skip,
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
      if (childSpec.count === true) {
        // a count counts EVERY related row; a where/take beside it was
        // dropped without a word, and the number answered was the total
        const dropped = ['where', 'orderBy', 'take', 'skip', 'include', 'after']
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
      // a keyset cursor is one position in ONE ordered set; an include is
      // a set per parent, so it windows with skip/take and never seeks
      if (childSpec.after !== undefined) {
        throw refuse("'after' (keyset pagination) paginates the root — an include windows with skip and take",
          [...path, relationName]);
      }
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

  const buildLoad = (spec) => {
    // a cyclic specification cannot be keyed, so the cache reports a
    // permanent miss and buildTree gets to NAME the cycle
    const key = ['L', entityName, spec ?? {}, dialect.name];
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
    for (const member of ['take', 'skip']) {
      // interpolated into LIMIT/OFFSET as written: a string ran as SQL
      if (spec?.[member] !== undefined && !isWindowBound(spec[member]))
        throw refuse(`${member} must be a non-negative integer`, []);
    }
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
    const sizeBefore = state.cache.size();
    if (state.cache.set(key, entry) && state.cache.size() === sizeBefore)
      state.counters.evictions++;
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
