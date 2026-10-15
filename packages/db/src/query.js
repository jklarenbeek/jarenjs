//@ts-check
/**
 * @file The query surface over one collection: the provider
 * (`execute(document, options)` — how a linq chain runs here with no
 * import edge), the streaming cursor (`query`), and `explain()`.
 *
 * The statement cache is a CALLER of the core primitives:
 * `createSemanticCache` keyed by the whole discriminating tuple —
 * document plus collection, dialect, strictness, pushdown and profile.
 * The identity is the tuple's COMPLETE serialization, never a
 * fingerprint of it: a 32-bit content hash collides after tens of
 * thousands of documents, and a collision here answers one query with
 * another query's plan and rows. It is the ORDERED serialization, member
 * order included: `$for` bindings nest and `$let` binds in key order and
 * a `$return` object's members are the output's in that order, so two
 * documents differing only in member order are two queries — sharing a
 * plan would answer the second in the first one's row and member order,
 * or answer where it must refuse an unbound name. `store.stats()`
 * exposes hits, misses and evictions so the cache is proven rather than
 * assumed.
 *
 * Bind-time diversion: if any referenced external is missing or not a
 * string or finite number, or is a string the database would not receive
 * as written (a lone surrogate bound as text arrives as U+FFFD, and
 * PostgreSQL holds no U+0000), the call runs the always-compilable set
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

import { escapePointerToken, utf8ByteLength } from '@jarenjs/core/string';
import { physicalSelection, columnCodec, textKeyPlan, textKeyDecoding, checkTextKeys, physicalOrderable } from './physical.js';

import { createSemanticCache } from '@jarenjs/core/cache';
import { analyzeQuery, compileJsonQuery, JsonQueryRuntimeError, renderQueryMessage } from '@jarenjs/json/query';
import { compileJSONPath, parseJSONPath } from '@jarenjs/json/path';

import { DbCompileError, DbRuntimeError, wrapDriverError, refuseRoundedInteger } from './errors.js';
import { chain, attempt, createStatementOwner, useStatementOnce } from './driver.js';
import { readOptions, readControls, isPlainOptions, refuseUnknownMembers } from './options.js';
import {
  planQuery, planEntityQuery, entityShape, planEntityPredicate, entityPathRef, bindsLoneSurrogate, LONE_SURROGATE_REFUSAL,
  isRootScanSource, isEntityRootSource, BIND_REASONS, PLANNER_REASONS, admitsMixedTypes,
  predicateTerms, boundPredicateTerms, mapHops, hopsOf, scalarFamilies, entityRoot,
} from './plan.js';
import { emitPlan, emitEntityPlan, createEntityPredicateEmitters, UnrepresentablePath, UnrepresentableIdentity,
  entityTableColumns, physicalComparable, bindsAsWritten, bindsUnheldText, UNHELD_TEXT_REFUSAL,
  documentMemberOf, bucketGuards, bucketAbsentGuard } from './emit.js';
import { modelPath } from './model-path.js';
import { selectPlan, conjoin, effectiveOrder, planOrder, ordersByColumn } from './algebra.js';
import {
  compileSetResidual, compileRowResidual, compilePackedResidual, sequenceResult,
} from './residual.js';
import { createCursor, createSyncCursor, drainPage, PAGE_LIMIT_DEFAULT, rowClassOf } from './cursor.js';
import { deepFreeze, equalsJson, setObjectMember } from '@jarenjs/core/object';
import { derivedSlotValue, probeVector, columnScore } from './derive.js';
import { cutCandidates, identityBatches } from './knn.js';
import {
  deterministicFragment, registerFragment, registerAggregateOperator,
} from './udf.js';
import { refuseCancelled } from './cancellation.js';
import {
  floorProfile, translateProfilePredicate, assertProfileRoots, memberDenial,
  applyMandatoryPredicate, applyRowBound, SAFE_PROFILE, predicateQuery,
  predicateLeaves, admitPredicateExternals, boundedJoinSides, rootEntry,
} from './profile.js';

/**
 * The store-wide query state shared by every collection's engine: one
 * bounded statement cache, its counters, the UDF registration set, and
 * the store's resolved registered operators (Ring 2 — `{ functions,
 * extensions }` or `null`), threaded to every engine that builds a
 * residual.
 * @param {number} [bound]
 * @param {{ functions?: any, extensions?: any } | null} [operators]
 * @param {any} [zoneProvider] - the injected zone provider, or absent
 * @param {(() => number) | undefined} [now] - the store's clock, the one a
 *   `deadline` is compared against before a call and at every row
 *   boundary; the platform's own when the store threads none
 * @returns {any}
 */
export function createQueryState(bound = undefined, operators = null,
  zoneProvider = undefined, now = undefined) {
  return {
    // every entry is compiled from a query or load document, whose member
    // order is part of its meaning: the key keeps it
    cache: createSemanticCache(bound ?? 128, (_key, entry) => {
      entry.retired = true;
      for (const statement of entry.statements ?? []) statement.retire();
      entry.statements = null;
    }, { ordered: true }),
    counters: { hits: 0, misses: 0, evictions: 0 },
    /** Fragment identity → the SQL function name registered for it. */
    registered: new Map(),
    /** Registry operator name → the SQL AGGREGATE registered for it. */
    registeredAggregates: new Map(),
    operators: operators ?? null,
    // The injected clock: a named zone is host code a database does
    // not have, so a calendar ladder over one walks in the residual —
    // and the residual is the caller's OWN document, so the frozen spec
    // reaches the kernel unchanged rather than being rebuilt in UTC
    zoneProvider: zoneProvider ?? null,
    // the clock every deadline is read against: the store's runtime
    // record's, so an injected clock and a caller's deadline agree on
    // what time it is — a compiled query never captures the instant
    now: now ?? Date.now,
  };
}

/** Retain a plan by semantic identity; an unkeyable plan has only temporary
 * statements. Cache counts describe plans, not their prepared children.
 * @param {any} state @param {any} key @param {any} entry
 */
function retainEntry(state, key, entry) {
  const before = state.cache.size();
  if (!state.cache.set(key, entry)) entry.retired = true;
  else if (state.cache.size() === before) state.counters.evictions++;
  return entry;
}

/**
 * What of a load's `after` is part of its plan's identity. A structural
 * continuation resumes by values, which every call binds; the SQL text
 * depends only on which of its order keys are NULL, so the specification
 * keyed is the load without its `after` and the shape is one flag for each
 * order key. A scalar `after` (a single unique column's keyset) changes no
 * text at all. `null` for a load with no continuation to share, or one
 * that is no continuation (the compile names that).
 * @param {any} spec
 * @returns {{ spec: any, shape: string } | null}
 */
function afterIdentity(spec) {
  const after = spec?.after;
  if (after === undefined || after === null) return null;
  /** @type {string} */
  let shape;
  if (typeof after !== 'object') shape = 'scalar';
  else {
    const keys = after.keys;
    if (!Array.isArray(keys)) return null;
    shape = `keys:${Array.from(keys, (/** @type {any} */ key) => ((key ?? null) === null ? '1' : '0')).join('')}`;
  }
  const { after: _after, ...rest } = spec;
  return { spec: rest, shape };
}

/** Borrow one prepared child through the complete operation, including any
 * awaited binds. An evicted plan can still belong to a lazy cursor: its new
 * children are temporary and its already borrowed children finish normally.
 * @param {any} connection @param {any} entry
 * @param {(statement: any) => any} use
 * @param {any} [owner] - the semantic plan, or this separate bounded entry
 */
function useRead(connection, entry, use, owner = entry) {
  if (owner.retired) return useStatementOnce(connection, entry.sql, use, { readOnly: true });
  if (entry.statement === null) {
    entry.statement = createStatementOwner(connection, entry.sql, { readOnly: true });
    (owner.statements ??= []).push(entry.statement);
  }
  return entry.statement.use(use);
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

/**
 * What the one row of a count statement answers: the count, or — for a
 * root quantifier, whose statement is an existence test — its boolean
 * (SQLite answers `1` and `0`, PostgreSQL `true` and `false`).
 * @param {any} plan
 * @param {any} row
 * @returns {number | boolean}
 */
function countedValue(plan, row) {
  return plan.quantifier === undefined ? row?.value ?? 0 : Boolean(row?.value);
}

/**
 * The refusal of an aggregate whose pushed-down column met a null: the
 * query catalog's sentence, so `renderQueryMessage` shows it in the
 * operator's language as it does the engine's own aggregate refusals.
 * @returns {JsonQueryRuntimeError}
 */
function aggregateNullError() {
  const message = { messageId: 'query/aggregate-null', params: {} };
  // no location: the statement answered for the whole aggregate (absence is
  // `undefined`, never the root pointer)
  return new JsonQueryRuntimeError('JQ2001', renderQueryMessage(message), undefined, message);
}

/**
 * Does an external bind as a native parameter the database compares as the
 * engine does? A string the database receives as written (on `dialect`,
 * bound as text or, `asJson`, inside a JSON value: {@link bindsAsWritten}),
 * and a finite number — but not, where the database reads a JSON integer
 * by its digits (`exact`), an integer past 2^53, which the engine compares
 * as the double it is. Without a dialect a string is taken as it is (the
 * statement `explain()` describes).
 * @param {any} value @param {boolean} [exact] @param {any} [dialect] @param {boolean} [asJson]
 */
function bindable(value, exact = false, dialect = null, asJson = false) {
  return (typeof value === 'string' && (dialect === null || bindsAsWritten(dialect, value, asJson)))
    || (typeof value === 'number' && Number.isFinite(value)
      && !(exact && Number.isInteger(value) && !Number.isSafeInteger(value)));
}

/**
 * Does a membership list (`$x[*]`) bind? The list compares its strings
 * with strings and its numbers with numbers, so it binds when every item
 * the wildcard reaches — an array's elements, an object's member values;
 * a scalar reaches none — is one of those. A null or a boolean item is
 * one `$eq` matches against a present null or boolean, and an object or
 * array item one it compares structurally, so either sends the call to
 * the engine; so does a missing external, which the engine refuses by
 * its own error. A scalar still crosses as one JSON value, so only a
 * JSON scalar binds: a bigint, a function or a symbol is the engine's to
 * answer. An item past 2^53 binds where {@link bindable} binds it, and a
 * string where the database reads it inside the list's JSON as written.
 * @param {any} value @param {boolean} exact @param {any} dialect
 */
function listBindable(value, exact, dialect) {
  if (value === undefined) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'string') return bindsAsWritten(dialect, value, true);
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object') return false;
  return (Array.isArray(value) ? value : Object.values(value)).every((item) => bindable(item, exact, dialect, true));
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
function slotValue(slot, externals, anchors = null) {
  if ('literal' in slot) return slot.literal;
  // a JSON-encoded external: the dialect asked for the value's JSON
  // text because one placeholder has to hold whatever type the member
  // turns out to be, and a statically typed parameter cannot. An
  // ABSENT external stays absent — encoding it as `null` would answer
  // a query the caller never bound instead of raising the engine's own
  // missing-external error
  if ('external' in slot && slot.json === true) {
    const value = externals[slot.external];
    return value === undefined ? undefined : JSON.stringify(value);
  }
  if ('derived' in slot)
    return derivedSlotValue(slot.derived, slot.derived.kind === 'bboxAxis'
      ? externals[slot.derived.external] : externals);
  if ('typed' in slot) {
    // a typed slot is only ever emitted beside the seek that fills it,
    // so a bind that never resolved the seeks is a defect in the
    // engine, not a value the caller could have got wrong
    if (anchors === null || !(slot.typed.seek in anchors))
      throw new Error(`the seek '${slot.typed.seek}' was not resolved before the bind`);
    return anchors[slot.typed.seek];
  }
  const value = externals[slot.external];
  // the digits a document spells the number by, which the member it is
  // compared with is read as (`digits`): a double past 2^63 is spelled
  // past the 64-bit integers, and the database reads both as doubles
  if (slot.digits === true && typeof value === 'number' && Number.isInteger(value)
    && !Number.isSafeInteger(value) && Math.abs(value) < 2 ** 63) return BigInt(String(value));
  // a slot that binds the value itself reaches the statement only with a
  // value the admission let through: a boolean, an object or an array of
  // a family the member cannot hold (a store predicate's, which cannot
  // divert). No driver binds one as the engine reads it — SQLite refuses
  // a boolean and reads an object as named parameters — so it binds as an
  // empty byte string, a kind no JSON member holds: every guarded comparison
  // reads it as the foreign value it is, as the engine does
  return value !== null && (typeof value === 'boolean' || typeof value === 'object') ? FOREIGN_VALUE : value;
}

/**
 * Why a cursor over a collection entry reads its statement whole first
 * where it would otherwise pull one row per item, or `null`: the engine
 * evaluates the filter and the return of every row before it yields an
 * item, so a statement whose filter holds a registered function that can
 * raise on a row, or whose row residual's return can raise on one
 * (`rowRaises`), raises before its first item, as the engine's does.
 * @param {any} entry
 * @returns {{ construct: string, reason: string } | null}
 */
function raisingBarrier(entry) {
  if (holdsRaisingFunction(entry.plan.filter)) return { construct: '$where', reason: BIND_REASONS.raisingFunction };
  if (entry.planned.mode === 'row' && entry.planned.rowRaises === true) {
    return { construct: '$return', reason: BIND_REASONS.raisingProjection };
  }
  return null;
}

/**
 * Whether a statement's filter holds a registered function that can raise
 * on a row (`raises`).
 * @param {any} pred
 * @returns {boolean}
 */
function holdsRaisingFunction(pred) {
  switch (pred?.p) {
    case 'and': case 'or': return pred.items.some(holdsRaisingFunction);
    case 'not': return holdsRaisingFunction(pred.item);
    case 'udf': return pred.raises === true;
    default: return false;
  }
}

/** The parameter a value of no SQL kind binds as ({@link slotValue}). */
const FOREIGN_VALUE = new Uint8Array(0);

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
 * @returns {Map<string, 'plain' | 'derived' | 'probe' | 'list'>}
 */
function externalSlotKinds(slots, rank) {
  /** @type {Map<string, 'plain' | 'derived' | 'probe' | 'list'>} */
  const kinds = new Map();
  for (const slot of slots) {
    // a membership list binds the external's JSON whatever it holds; the
    // same external compared as a scalar elsewhere keeps the scalar rule
    if ('external' in slot && slot.list === true) {
      if (!kinds.has(slot.external)) kinds.set(slot.external, 'list');
    }
    else if ('external' in slot) kinds.set(slot.external, 'plain');
    else if ('derived' in slot) {
      const inputs = slot.derived.kind === 'bboxAxis'
        ? [slot.derived] : [slot.derived.centre, slot.derived.radius];
      for (const input of inputs) {
        if ('external' in input && !kinds.has(input.external))
          kinds.set(input.external, 'derived');
      }
    }
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
 * because the shipped drivers expose no interrupt — against the clock
 * the store was opened with, never the platform's directly.
 * @param {any} options
 * @param {() => number} now - the store's clock
 */
function requireCallable(options, now) {
  refuseCancelled(options, now, { abortCode: 'JD2072', aborted: 'it ran', passed: 'the call ran' });
}

/** The boundary every engine member answers through: a driver failure
 * arrives classified, anything else as it is.
 * @param {(...args: any[]) => any} fn
 * @param {(error: any) => Error} wrap */
const bounded = (fn, wrap) => (...args) => attempt(() => fn(...args), wrap);

/** What a collection's `execute` and `query` read from their options: a
 * closed set, refused member by member (`JD0013`) as `all()` refuses its own.
 * `strictStreaming` precedes `strict`, so a misspelling of the longer name
 * is not answered with its prefix. */
const DOCUMENT_CALL_OPTIONS = Object.freeze(['externals', 'strictStreaming', 'strict', 'profile', 'pushdown',
  'signal', 'deadline']);
/** An entity cursor's options: a collection cursor's, and the `tracking`
 * its set reads off the same bag. An entity `explain` takes either call's. */
const ENTITY_CURSOR_OPTIONS = Object.freeze([...DOCUMENT_CALL_OPTIONS, 'tracking']);
/** A graph load's options. */
const LOAD_CALL_OPTIONS = Object.freeze(['signal', 'deadline', 'profile']);
/** What the explanation of a graph load reads: the profile it explains under. */
const EXPLAIN_LOAD_OPTIONS = Object.freeze(['profile']);
/** A graph cursor's options: a load's, and its set's `tracking`. */
const LOAD_CURSOR_OPTIONS = Object.freeze([...LOAD_CALL_OPTIONS, 'tracking']);

/**
 * One read call's options, before anything runs: a closed member set,
 * then the value of each control it carries — `JD0013` either way, as
 * `all()` and `page()` refuse their own.
 * @param {any} options @param {readonly string[]} members @param {string} spelling
 */
function readCallOptions(options, members, spelling) {
  readOptions(options, members, spelling);
  readControls(options, spelling);
}

/** `strictStreaming: true` on a call that answers whole: there is no
 * stream to hold it to (`JD0013`).
 * @param {any} options @param {string} spelling @param {string} cursor */
function refuseWholeStreaming(options, spelling, cursor) {
  if (options?.strictStreaming === true) {
    throw new DbCompileError('JD0013', `${spelling} option 'strictStreaming' applies to a cursor `
      + `(${cursor}); execute() answers the whole result by contract, so there is no stream to hold it to`);
  }
}

/** The members a graph-load specification reads, per node: the root's,
 * which also bound the whole graph and seek by keyset, and an include's,
 * which bound or count the related rows of each parent (§10.4). */
const ROOT_LOAD_MEMBERS = Object.freeze(['where', 'orderBy', 'take', 'skip', 'include', 'after', 'maxDepth']);
const INCLUDE_LOAD_MEMBERS = Object.freeze(['where', 'orderBy', 'take', 'skip', 'include', 'after', 'count',
  'maxRows', 'maxBytes']);

/**
 * The budget provenance `explain()` carries: which profile applied
 * and from where, every bound it imposed — each one the engine COUNTS
 * and enforces — and, by name, the two the driver cannot measure:
 * elapsed statement time is an empty capability slot on SQLite and the
 * row estimate is one wherever the database gives none, so they are
 * reported `unavailable`, never approximated. The estimate is the
 * database's own, handed over with the label that says whose it is.
 * @param {any} profile - the normalized profile, or null
 * @param {'call' | 'store' | null} source
 * @param {any} capabilities - the connection's capability table
 * @param {{ rows: number, source: string } | null} [estimate] - the planner's answer for the statement
 */
function budgetOf(profile, source, capabilities, estimate = null) {
  return {
    profile: profile === null ? null : { source, name: profile === SAFE_PROFILE ? 'safe' : 'custom' },
    rows: profile === null ? null : profile.maxRows,
    includedRows: profile === null ? null : profile.maxIncludedRows,
    depth: profile === null ? null : profile.maxDepth,
    bytes: profile === null ? null : profile.maxBytes,
    limits: profile === null ? null : { ...profile.limits },
    scan: profile !== null && profile.refuseFullScan === true ? 'refused-by-shape' : 'unbounded',
    time: capabilities?.statementTimeout === true ? 'enforced' : 'unavailable',
    estimatedRows: estimate ?? 'unavailable',
  };
}

/**
 * The database planner's row estimate for one native statement, asked
 * for as a statement of its own with the values a run would bind: the
 * single place an estimate is requested. `null` where the connection
 * reports none (SQLite's plan is prose, not numbers), and where the
 * dialect cannot read the answer, so the slot reads `unavailable`.
 * Callers ask only for a statement whose every slot holds its real
 * value: the planner prices exactly what it is given, and a NULL in
 * place of an unbound external is a different statement.
 * @param {any} connection
 * @param {any} dialect
 * @param {string} sql - the native statement
 * @param {any[]} params - the values it binds
 * @returns {any} value-or-promise of `{ rows, source }` or `null`
 */
function estimateOf(connection, dialect, sql, params) {
  if (connection.capabilities?.rowEstimates !== true || typeof dialect.explainEstimate !== 'function') return null;
  return useStatementOnce(connection, dialect.explainEstimate(sql), (statement) =>
    chain(statement.all(params), (rows) => dialect.readEstimate(rows)), { readOnly: true });
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
  return leafItems(row, '');
}

/**
 * A plan ref's path as the explanation publishes it: member names and
 * array indexes, in order.
 * @param {any} ref
 * @returns {(string | number)[]}
 */
function segmentsOf(ref) {
  return ref.segments.map((segment) => ('name' in segment ? segment.name : segment.index));
}

/**
 * The row identity an entity's rows are fetched in order of: the dialect's
 * spelling that no column of the table shadows. A table that takes every
 * spelling has none that reproduces the insertion order, and its rows come
 * in the order of the spelling it shadows.
 * @param {any} dialect
 * @param {any} entityMapping
 * @returns {string}
 */
function rowIdentityOf(dialect, entityMapping) {
  return dialect.rowIdentity(entityTableColumns(entityMapping)) ?? dialect.rowIdentity();
}

/**
 * One projected LEAF of a row, by the suffix its value/type pair was
 * named under: the empty suffix for the single-path plan, `0`, `1`, …
 * for a projection tree's leaves.
 * @param {any} row
 * @param {string} suffix
 * @param {any} [column] - the column whose codec decodes the leaf
 * @param {boolean} [integer] - the leaf is an `integer` column's
 * @returns {any[]} the item, or nothing where the member is absent
 */
function leafItems(row, suffix, column = undefined, integer = false) {
  // an `integer` column's stored value the driver rounded is refused, as
  // the row read whole refuses it
  if (integer) refuseRoundedInteger(row, `v${suffix}`);
  if (column !== undefined) {
    const value = columnCodec(column).decode(row[`v${suffix}`]);
    return value === undefined ? [] : [value];
  }
  const type = row[`t${suffix}`];
  if (type === null || type === undefined) return [];
  const value = row[`v${suffix}`];
  if (type === 'true') return [true];
  if (type === 'false') return [false];
  if (type === 'null') return [null];
  if (type === 'object' || type === 'array') return [JSON.parse(value)];
  if (type === 'text') return [String(value)];
  return [Number(value)];
}

/**
 * The one item a projection TREE answers for one row, rebuilt from the
 * leaves the statement fetched. The engine's own rules decide what an
 * absent leaf does: a member whose value is the empty sequence is
 * OMITTED from its object and SKIPPED in its array — which is why a
 * literal `null` (present in every row) and a path that finds nothing
 * (present in none) cannot share a representation here.
 * @param {any} project - the plan's `{ tree, leaves }`
 * @param {any} row
 * @param {string} [prefix] - what the statement named its value/type
 *   pairs: empty on a collection, `'p'` on an entity plan, whose own
 *   binding aliases are `t0`, `t1`, … and would collide with a bare one
 * @returns {any[]} exactly one item; a tree always constructs something
 */
function projectedTreeItems(project, row, prefix = '') {
  const build = (node) => {
    if (node.p === 'lit') return [node.value];
    if (node.p === 'leaf') {
      const leaf = project.leaves[node.index];
      const at = `${prefix}${node.index}`;
      // a hop that reaches no row sends no type at all, and its member is
      // absent whatever the column's policy says of a NULL it does read
      if (leaf.hop !== undefined && (row[`t${at}`] ?? null) === null) return [];
      return leafItems(row, at, leaf.ref?.codecColumn, leaf.ref?.flavor === 'entity-column' && leaf.ref.storage === 'integer');
    }
    if (node.p === 'object') {
      /** @type {any} */
      const out = {};
      for (const member of node.members) {
        const items = build(member.node);
        if (items.length > 0) setObjectMember(out, member.name, items[0]);
      }
      return [out];
    }
    const items = [];
    for (const item of node.items) items.push(...build(item));
    return [items];
  };
  return build(project.tree);
}

  /**
   * The items a GENERAL grouping answers: one per group row, built from
   * the group's keys and aggregates through the plan's own tree. A key
   * comes back with its JSON type beside it, so an absent key leaves
   * its member out exactly as the object constructor does; an aggregate
   * over no values follows the mapping the plan recorded — `0` for a
   * count or a sum, the empty sequence for the other three, which is
   * the ENGINE's answer, not SQL's `NULL`.
   * @param {any} entry
   * @param {any[]} rows
   * @returns {any[]}
   */
  function groupItems(group, rows) {
    const aggregateItems = (row, index) => {
      const value = row[`a${index}`] ?? null;
      const empty = group.aggregates[index].empty;
      if (value === null) return empty === 'omit' ? [] : [empty === 'zero' ? 0 : null];
      const aggregate = group.aggregates[index];
      return [aggregate.ref?.codecColumn && ['min', 'max'].includes(aggregate.fn)
        ? columnCodec(aggregate.ref.codecColumn).decode(value) : value];
    };
    const build = (node, row) => {
      if (node.p === 'lit') return [node.value];
      if (node.p === 'key') return leafItems(row, `k${node.index}`, group.keys[node.index].ref.codecColumn);
      if (node.p === 'agg') return aggregateItems(row, node.index);
      if (node.p === 'object') {
        /** @type {any} */
        const out = {};
        for (const member of node.members) {
          const items = build(member.node, row);
          if (items.length > 0) setObjectMember(out, member.name, items[0]);
        }
        return [out];
      }
      const items = [];
      for (const item of node.items) items.push(...build(item, row));
      return [items];
    };
    return rows.flatMap((row) => build(group.tree, row));
  }

/** How a refusal names a non-plain object. @param {object} value */
const instanceOf = (value) => `a ${value.constructor?.name || 'non-plain'} instance`;

/**
 * Refuse what a store member that takes a query document cannot read as
 * one at its root. A `@jarenjs/linq` chain (`JD0039`) keeps its clauses
 * behind methods, so read as a document it was one with no clauses:
 * `execute` answered `{}` and `query` `[{}]`. It is recognised by its
 * `toDocument()` method (this package does not import linq), which no
 * document can carry: a query document is JSON, and JSON holds no
 * function. An object the compiler cannot read is refused by the rule
 * {@link refuseOpaqueValues} keeps inside a document (`JD0041`): its
 * prototype is neither `Object.prototype` nor `null` and it has no own
 * enumerable member, so `execute(new Date())` answered `{}`. A class
 * instance read by its own fields is read as those fields, as before.
 * @param {any} document
 * @param {string} spelling - the member, as the reason names it
 */
export function refuseNonDocument(document, spelling) {
  if (document === null || typeof document !== 'object') return;
  if (typeof document.toDocument === 'function') {
    throw new DbCompileError('JD0039',
      `${spelling} takes a query document and was handed a chain — pass the chain's document, `
      + 'toDocument() with { externals: chain.explain().bindings }, or hand the chain to the '
      + 'handle it was built from, which runs it');
  }
  if (isOpaque(document)) {
    throw new DbCompileError('JD0041',
      `${spelling} takes a query document, which is JSON, and was handed ${instanceOf(document)} — `
      + 'a document is read by its own members alone, and a Date or a Map has none; pass the '
      + 'document as a plain object');
  }
}

/**
 * Refuse a value inside a query document that the compiler reads as `{}`
 * though it is not one (`JD0041`): an object whose prototype is neither
 * `Object.prototype` nor `null` and which has no own enumerable member —
 * a `Date`, a `Map`, a `Set`, a `RegExp` — so its state never reached the
 * query (a `$where` comparing with a `Date` compared with `{}`, and one
 * in a `$return` answered `{}`). An object read by its own members, a
 * class instance's fields among them, is read as those members and is
 * taken. A document holding such a value cannot be a cache identity, so
 * a compiled entry never stands for one: this runs where an entry is
 * compiled (never on a hit) and where a live query is registered.
 * @param {any} document
 */
export function refuseOpaqueValues(document) {
  const found = opaqueWithin(document);
  if (found !== null) {
    throw new DbCompileError('JD0041',
      `a query document holds ${instanceOf(found.value)}, which it reads as {} — `
      + 'write the JSON value it stands for (a Date as its toISOString())', found.at);
  }
}

/**
 * Whether the engine reads a value as `{}` though it is not one: an object
 * whose prototype is neither `Object.prototype` nor `null` and which has no
 * own enumerable member — a `Date`, a `Map`, a `Set`, a `RegExp`. An array,
 * a plain or null-prototype object and a class instance with fields are
 * read by their own members.
 * @param {any} value @returns {boolean}
 */
function isOpaque(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto !== Object.prototype && proto !== null && Object.keys(value).length === 0;
}

/**
 * The first value at or inside `root` that {@link isOpaque} names — or,
 * with `bigints`, that is a `bigint` — in document order, with the JSON
 * Pointer of where it stands; `null` when there is none.
 * @param {any} root @param {boolean} [bigints]
 * @returns {{ value: any, at: string } | null}
 */
function opaqueWithin(root, bigints = false) {
  // iterative: a document nested thousands deep compiles, so its walk
  // must not take a frame per level; a container met twice (a shared
  // subtree or a cycle) is read once
  const seen = new Set();
  /** @type {[any, string][]} each value and where it stands, next on top */
  const pending = [[root, '']];
  while (pending.length > 0) {
    const [value, at] = /** @type {[any, string]} */ (pending.pop());
    if (bigints && typeof value === 'bigint') return { value, at };
    if (value === null || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    if (isOpaque(value)) return { value, at };
    const keys = Object.keys(value);
    // pushed last first, so the first member is read first
    for (let k = keys.length - 1; k >= 0; k--) pending.push([value[keys[k]], `${at}/${escapePointerToken(keys[k])}`]);
  }
  return null;
}

/** The comparisons (QUERY-FORMAT §8.4): each reads its operands' items as JSON. */
const COMPARISONS = new Set(['$eq', '$ne', '$lt', '$le', '$gt', '$ge']);
/** The operators that equate their operands' items by the engine's JSON
 * equality as a comparison does: `$distinct` keeps one of equal items,
 * `$index-of` names the positions of the item equal to its second. */
const EQUATING = new Set(['$distinct', '$index-of']);
/** Node members that hold a host value, never a node (QUERY-FORMAT C.3). */
const HOST_MEMBERS = new Set(['fn', 'entry', 'collation']);

/**
 * The variables a node binds — a `$for` or `$let` binding, a quantifier's,
 * a grouping key's, a `$fold` accumulator's (its initial value) — each
 * `{ slot, expr }`: the slot a reference to the variable names, and the
 * expression its value is.
 * @param {any} node @returns {{ slot: number, expr: any }[]}
 */
function bindingsOf(node) {
  if (node.kind === 'flwor') {
    return [...node.forBindings, ...node.letBindings, ...(node.groupby?.keys ?? []), ...(node.fold === null ? [] : [node.fold])];
  }
  if (node.kind === 'quant') return node.bindings;
  return [];
}

/**
 * The externals a query reads where the engine compares or equates items
 * — a direct operand of `$eq $ne $lt $le $gt $ge`, `$distinct` or
 * `$index-of`, or a grouping key: `$since`, `$xs[*]`, `$o.d` — found
 * anywhere in its analysed tree (QUERY-FORMAT Appendix C), and followed
 * through what hands their items to the operand ({@link reachedExternals}),
 * each named by the external and the steps that reach the compared items.
 * A comparison of one external reference with the same reference answers
 * alike whatever it holds, and is left out. A value the query returns or
 * hands to a host function is passed by reference, and one an operator
 * computes from the external (its count, its text) is not followed.
 * @param {any} root - the analysed tree
 * @param {string | null} [predicate] - the profile root whose predicate the
 *   tree is, or null for the caller's document
 * @returns {{ name: string, segments: readonly any[], docPath: string, predicate: string | null }[]}
 */
function comparedExternals(root, predicate = null) {
  /** @type {Map<number, any>} each bound variable's expression, by slot */
  const bound = new Map();
  /** @type {any[][]} the operands one comparison or equating operator reads, together */
  const operands = [];
  const pending = [root];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === null || typeof node !== 'object') continue;
    if (Array.isArray(node)) {
      for (let k = node.length - 1; k >= 0; k--) pending.push(node[k]);
      continue;
    }
    // a literal's and a raw argument's value is JSON, a path's segments
    // are its own grammar: neither holds a node
    if (node.kind === 'literal' || node.kind === 'raw' || node.kind === 'path') continue;
    for (const binding of bindingsOf(node)) bound.set(binding.slot, binding.expr);
    if (node.kind === 'op' && (COMPARISONS.has(node.name) || EQUATING.has(node.name))) operands.push(node.args);
    if (node.kind === 'flwor') for (const key of node.groupby?.keys ?? []) operands.push([key.expr]);
    const keys = Object.keys(node);
    for (let k = keys.length - 1; k >= 0; k--) {
      if (!HOST_MEMBERS.has(keys[k])) pending.push(node[keys[k]]);
    }
  }
  /** @type {{ name: string, segments: readonly any[], docPath: string, predicate: string | null }[]} */
  const found = [];
  for (const args of operands) {
    const refs = args.map((arg) => reachedExternals(arg, bound).map((ref) => ({ arg, ref }))).flat();
    const same = refs.length === 2 && args.length === 2 && refs[0].arg !== refs[1].arg
      && refs[0].ref.name === refs[1].ref.name
      && JSON.stringify(refs[0].ref.segments) === JSON.stringify(refs[1].ref.segments);
    if (same) continue;
    for (const { arg, ref } of refs) found.push({ name: ref.name, segments: ref.segments, docPath: arg.docPath, predicate });
  }
  return found;
}

/**
 * The operators whose items are items of an operand, handed through as
 * they are: each names the step it applies to the operand's items, or
 * `null` where its other operands are not literals this can read. A
 * registered function or another operator computes a new value, and is
 * not followed.
 * @type {ReadonlyMap<string, (args: readonly any[]) => any>}
 */
const HANDED_THROUGH = new Map([
  ['$head', () => ({ through: '$head' })],
  ['$tail', () => ({ through: '$tail' })],
  ['$reverse', () => ({ through: '$reverse' })],
  ['$subsequence', (args) => (args.slice(1).every((arg) => arg.kind === 'literal')
    ? subsequenceStep(args.slice(1).map((arg) => arg.value)) : null)],
  ['$get', (args) => (args[1]?.kind === 'literal' ? { through: '$get', key: args[1].value } : null)],
]);

/**
 * The externals an operand's items are read from, each with the steps
 * that reach its items from the external's value: a reference to one
 * (`$since`, `$xs[*]`, `$o.d`), through the variables bound to one (`$s`
 * after `$let: { s: '$since' }`, `$q.d` after `$for: { q: '$xs[*]' }`, a
 * quantifier or a `$fold` accumulator over it), through an operator that
 * hands an operand's items through ({@link HANDED_THROUGH}), through each
 * operand of a `$seq`, and through each member of an array or object
 * constructor that is the operand itself, whose value holds them. A slot
 * is bound once in a tree, and a binding refers only to slots bound before
 * it, so the walk ends; it is iterative, as an operand may nest deep.
 * @param {any} operand @param {Map<number, any>} bound - each bound variable's expression, by slot
 * @returns {{ name: string, segments: any[] }[]}
 */
function reachedExternals(operand, bound) {
  const found = [];
  /** @type {[any, any[]][]} each node and the steps read from its items after it */
  const pending = [[operand, []]];
  while (pending.length > 0) {
    const [node, after] = /** @type {[any, any[]]} */ (pending.pop());
    if (node?.kind === 'var' || node?.kind === 'path') {
      const steps = [...(node.segments ?? []), ...after];
      if (node.external === true) found.push({ name: node.name, segments: steps });
      else {
        const expr = bound.get(node.kind === 'var' ? node.slot : node.rootSlot);
        if (expr !== undefined) pending.push([expr, steps]);
      }
    }
    else if (node?.kind === 'op' && node.name === '$seq') {
      for (let k = node.args.length - 1; k >= 0; k--) pending.push([node.args[k], after]);
    }
    else if (node?.kind === 'op' && HANDED_THROUGH.has(node.name)) {
      const step = /** @type {Function} */ (HANDED_THROUGH.get(node.name))(node.args);
      if (step !== null) pending.push([node.args[0], [step, ...after]]);
    }
    // a constructor read whole holds each member's items; one a step reads
    // into is not followed
    else if (node?.kind === 'array' && after.length === 0) {
      for (let k = node.elements.length - 1; k >= 0; k--) pending.push([node.elements[k], []]);
    }
    else if (node?.kind === 'object' && after.length === 0) {
      for (let k = node.entries.length - 1; k >= 0; k--) pending.push([node.entries[k].expr, []]);
    }
  }
  return found;
}

/**
 * The compared externals of the profile's mandatory predicates over the
 * named roots: each predicate binds from the call's externals as the
 * document does.
 * @param {any} profile - a normalized profile, or null
 * @param {Iterable<string>} roots - the collections or entities read
 * @param {any} operators - the store's registered operators, or undefined
 */
export function profileComparedExternals(profile, roots, operators) {
  if (profile === null) return [];
  const found = [];
  for (const root of roots) {
    const expression = rootEntry(profile.predicates, root);
    if (expression === undefined) continue;
    const wrapper = predicateQuery(expression);
    found.push(...comparedExternals(analyzeQuery(wrapper, operators).root, root));
  }
  return found;
}

/**
 * The values a compared reference reads from its external: the whole
 * value for `$name`, what name, index, slice, wildcard, filter and
 * descendant selectors reach for a path, and what an operator that hands
 * items through keeps of them ({@link HANDED_THROUGH}) — an object
 * {@link isOpaque} names met on the way standing for all it would reach.
 * A filter selects as the engine does, and what it compares or hands to a
 * function on the way is read too: each such value goes into `read`.
 * `null` for a filter this does not evaluate ({@link filterSelection}).
 * @param {any} value @param {readonly any[]} segments
 * @param {any[]} read - collects the values a filter reads on the way
 * @returns {any[] | null}
 */
function referencedValues(value, segments, read) {
  let current = [value];
  for (const segment of segments) {
    if ('through' in segment) {
      current = handedThrough(current, segment);
      if (current === null) return null;
      continue;
    }
    const next = [];
    for (const item of segment.descendant ? descendantsOf(current) : current) {
      if (item === null || typeof item !== 'object') continue;
      // a Set, a Map or a Date on the way is read as {}, so the path
      // reaches nothing through it: it is the value the comparison reads
      if (isOpaque(item)) {
        next.push(item);
        continue;
      }
      for (const selector of segment.selectors) {
        if (selector.kind === 'name') {
          if (!Array.isArray(item) && Object.hasOwn(item, selector.name)) next.push(item[selector.name]);
        }
        else if (selector.kind === 'index') {
          if (Array.isArray(item)) next.push(...elementAt(item, selector.index));
        }
        else if (selector.kind === 'wildcard') {
          for (const member of Array.isArray(item) ? item : Object.values(item)) next.push(member);
        }
        else if (selector.kind === 'slice') {
          if (Array.isArray(item)) next.push(...sliced(item, selector));
        }
        else {
          const filter = filterSelection(selector);
          if (filter === null) return null;
          for (const candidate of Array.isArray(item) ? item : Object.values(item)) {
            for (const query of filter.queries) {
              const reached = referencedValues(candidate, query.segments, read);
              if (reached === null) return null;
              if (query.reads) read.push(...reached);
            }
          }
          next.push(...filter.select(item));
        }
      }
    }
    current = next;
  }
  return current;
}

/**
 * What an operator that hands items through ({@link HANDED_THROUGH}) keeps
 * of its operand's items: `$head` the first, `$tail` all but the first,
 * `$reverse` all, `$subsequence` those at the positions the engine selects
 * for the literal bounds, `$get` the member or element its literal key
 * names of a single target (an object {@link isOpaque} names standing for
 * it); `null` where the engine refuses the bounds.
 * @param {any[]} items @param {any} step @returns {any[] | null}
 */
function handedThrough(items, step) {
  switch (step.through) {
    case '$head': return items.slice(0, 1);
    case '$tail': return items.slice(1);
    case '$reverse': return items;
    case '$subsequence': {
      let positions;
      try { positions = step.positions(null, { last: items.length - 1 }); }
      catch { return null; }
      return (positions === undefined ? [] : Array.isArray(positions) ? positions : [positions]).map((p) => items[p]);
    }
    default: {
      // `$get` reads one target: an empty or several-item operand is empty
      if (items.length !== 1) return [];
      const [target] = items;
      const key = step.key;
      if (target === null || typeof target !== 'object') return [];
      if (isOpaque(target)) return [target];
      if (typeof key === 'string') return !Array.isArray(target) && Object.hasOwn(target, key) ? [target[key]] : [];
      return Array.isArray(target) && Number.isInteger(key) ? elementAt(target, key) : [];
    }
  }
}

/**
 * The element an index names, a negative one counting from the end, as the
 * index selector and `$get` read it; nothing past either end.
 * @param {readonly any[]} array @param {number} index @returns {any[]}
 */
function elementAt(array, index) {
  const at = index < 0 ? array.length + index : index;
  return at >= 0 && at < array.length ? [array[at]] : [];
}

/**
 * The `$subsequence` step for literal bounds: the engine's own `$subsequence`
 * over the positions of `$last + 1` items keeps the positions it selects.
 * `null` where the engine refuses the bounds as written.
 * @param {readonly any[]} bounds
 */
function subsequenceStep(bounds) {
  try {
    return { through: '$subsequence', bounds,
      positions: compileJsonQuery({ $subsequence: [{ $range: [0, '$last'] }, ...bounds.map((bound) => ({ $const: bound }))] }) };
  }
  catch { return null; }
}

/** Each filter selector's selection, compiled once. @type {WeakMap<object, any>} */
const FILTERS = new WeakMap();

/**
 * A filter selector as the engine evaluates it over one container: `select`
 * hands back the members it selects, by reference, and `queries` are the
 * relative queries it evaluates on each candidate member — `reads` where
 * the filter compares their values or hands them to a function, rather
 * than testing only that they exist or counting them. The selection is
 * `@jarenjs/json/path` compiling the filter's own text, which must parse
 * back to the selector the query holds. `null` for a filter that reads the
 * input document (`$`), which no external holds, or one whose text does not
 * parse back to it (a function the store registered).
 * @param {any} selector
 * @returns {{ select: (item: any) => any[], queries: { segments: readonly any[], reads: boolean }[] } | null}
 */
function filterSelection(selector) {
  if (FILTERS.has(selector)) return FILTERS.get(selector);
  /** @type {{ segments: readonly any[], reads: boolean }[]} */
  const queries = [];
  let absolute = false;
  /** @param {any} node @param {boolean} reads */
  const visit = (node, reads) => {
    switch (node.kind) {
      case 'or': case 'and': for (const operand of node.operands) visit(operand, false); return;
      case 'not': visit(node.operand, false); return;
      case 'logical': visit(node.expr, false); return;
      case 'exists': visit({ kind: 'query', query: node.query }, false); return;
      case 'ftest': visit(node.func, false); return;
      case 'cmp': visit(node.left, true); visit(node.right, true); return;
      case 'func': for (const arg of node.args) visit(arg, node.name !== 'count'); return;
      case 'query':
        if (!node.query.relative) absolute = true;
        queries.push({ segments: node.query.segments, reads });
        return;
      default:
    }
  };
  visit(selector.expr, false);
  let selection = null;
  if (!absolute) {
    const text = `$[?${filterText(selector.expr)}]`;
    try {
      if (equalsJson(parseJSONPath(text).segments[0].selectors[0], selector)) {
        const compiled = compileJSONPath(text);
        selection = { select: (/** @type {any} */ item) => compiled(item), queries };
      }
    }
    catch { /* a filter whose text does not parse back is not followed */ }
  }
  FILTERS.set(selector, selection);
  return selection;
}

/**
 * The RFC 9535 text of a filter expression, as `parseJSONPath` reads it
 * back: each logical group parenthesized, a string as its JSON spelling.
 * @param {any} node @returns {string}
 */
function filterText(node) {
  switch (node.kind) {
    case 'or': return `(${node.operands.map(filterText).join(' || ')})`;
    case 'and': return `(${node.operands.map(filterText).join(' && ')})`;
    case 'not': return `!(${filterText(node.operand)})`;
    case 'logical': return filterText(node.expr);
    case 'exists': return queryText(node.query);
    case 'ftest': return filterText(node.func);
    case 'cmp': return `${filterText(node.left)} ${node.op} ${filterText(node.right)}`;
    case 'func': return `${node.name}(${node.args.map(filterText).join(', ')})`;
    case 'query': return queryText(node.query);
    default: return JSON.stringify(node.value);
  }
}

/** @param {{ relative: boolean, segments: readonly any[] }} query @returns {string} */
function queryText(query) {
  return (query.relative ? '@' : '$') + query.segments.map((segment) => `${segment.descendant ? '..' : ''}[${
    segment.selectors.map((/** @type {any} */ selector) => {
      switch (selector.kind) {
        case 'name': return JSON.stringify(selector.name);
        case 'wildcard': return '*';
        case 'index': return String(selector.index);
        case 'slice': return `${selector.start ?? ''}:${selector.end ?? ''}${selector.step === null ? '' : `:${selector.step}`}`;
        default: return `?${filterText(selector.expr)}`;
      }
    }).join(',')}]`).join('');
}

/**
 * Each value with every value inside it, in document order — what a
 * descendant segment selects from: a container met twice is read once, and
 * an object {@link isOpaque} names is not entered.
 * @param {readonly any[]} values @returns {any[]}
 */
function descendantsOf(values) {
  const out = [];
  const seen = new Set();
  const pending = [...values].reverse();
  while (pending.length > 0) {
    const value = pending.pop();
    out.push(value);
    if (value === null || typeof value !== 'object' || seen.has(value) || isOpaque(value)) continue;
    seen.add(value);
    const members = Array.isArray(value) ? value : Object.values(value);
    for (let k = members.length - 1; k >= 0; k--) pending.push(members[k]);
  }
  return out;
}

/**
 * The elements an array slice selects (RFC 9535 §2.3.4): `start`, `end`
 * and `step` as JSONPath reads them, negative bounds from the end, a zero
 * step selecting nothing.
 * @param {readonly any[]} array @param {{ start: number | null, end: number | null, step: number | null }} slice
 * @returns {any[]}
 */
function sliced(array, slice) {
  const step = slice.step ?? 1;
  if (step === 0) return [];
  const length = array.length;
  const bound = (/** @type {number} */ index) => (index >= 0 ? index : length + index);
  const out = [];
  if (step > 0) {
    const lower = Math.min(Math.max(bound(slice.start ?? 0), 0), length);
    const upper = Math.min(Math.max(bound(slice.end ?? length), 0), length);
    for (let i = lower; i < upper; i += step) out.push(array[i]);
  }
  else {
    const upper = Math.min(Math.max(bound(slice.start ?? length - 1), -1), length - 1);
    const lower = Math.min(Math.max(bound(slice.end ?? -length - 1), -1), length - 1);
    for (let i = upper; lower < i; i += step) out.push(array[i]);
  }
  return out;
}

/**
 * Refuse an external a comparison would read otherwise than it stands for
 * (`JD0041`): one {@link comparedExternals} names whose value holds, at its
 * root or inside it, what {@link isOpaque} names, so `$gt ['$e.at', '$since']`
 * with `since` a `Date` compared with `{}` and matched no row — or a
 * `bigint`, which the engine compares with no number, so `$gt ['$e.n', '$min']`
 * with `min` `2n` matched none either; so is one a filter on the way
 * compares or hands to a function. Run per call, after the compiled entry
 * is found: the externals are the call's own.
 * @param {readonly { name: string, segments: readonly any[], docPath: string, predicate: string | null }[]} compared
 * @param {any} externals - the call's externals
 * @param {string} spelling - the member, as the reason names it
 */
export function refuseOpaqueExternals(compared, externals, spelling) {
  if (compared.length === 0 || externals === null || typeof externals !== 'object') return;
  for (const ref of compared) {
    if (!Object.hasOwn(externals, ref.name)) continue;
    /** @type {any[]} */
    const read = [];
    const values = referencedValues(externals[ref.name], ref.segments, read);
    // what a filter on the way read is checked beside what is compared
    for (const value of values === null ? [] : read.length === 0 ? values : [...values, ...read]) {
      // a list of ids is mostly primitives: no walk for those
      const found = typeof value === 'bigint' ? { value, at: '' }
        : value === null || typeof value !== 'object' ? null : opaqueWithin(value, true);
      if (found === null) continue;
      // the document's comparison is named by its docPath, which the
      // error carries; a profile predicate is the store's, not the caller's
      const where = ref.predicate === null ? 'a comparison'
        : `the store profile's predicate for '${ref.predicate}'`;
      // a bigint is no JSON number: the engine compares it with none
      const bigint = typeof found.value === 'bigint';
      throw new DbCompileError('JD0041',
        `${spelling} external '$${ref.name}' holds ${bigint ? 'a bigint' : instanceOf(found.value)}`
        + `${found.at === '' ? '' : ` at ${found.at}`}, which ${where} reads as `
        + (bigint ? 'no number — pass the number it stands for, Number(value)'
          : '{} — pass the JSON value it stands for, a Date as its toISOString()'),
        ref.predicate === null ? ref.docPath : undefined);
    }
  }
}

/**
 * The compared externals of a document a live query registers, and of the
 * profile's predicates over the roots it reads. A document the engine
 * cannot analyse names none here: its own compile refuses it as before.
 * @param {any} document @param {any} operators @param {any} profile
 * @param {Iterable<string>} roots
 */
export function liveComparedExternals(document, operators, profile, roots) {
  let root;
  try { root = analyzeQuery(document, operators ?? undefined).root; }
  catch { return []; }
  return [...comparedExternals(root), ...profileComparedExternals(profile, roots, operators ?? undefined)];
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
  // every root a profile's member allow-list may name: the model's
  // collections and entities, so a typo in the policy is refused rather
  // than applied to nothing
  const roots = context.roots ?? [collection.name];
  // the store's registered operators (Ring 2): recognised by the planner
  // as vocabulary, evaluated in the residual, threaded into every
  // residual compilation here. `null` when the store opened with no
  // registry — the whole engine is then byte-identical to before.
  const operators = state.operators ?? null;
  const zoneProvider = state.zoneProvider ?? null;
  const dialect = connection.dialect;
  // SQLite reads a JSON integer by its digits, where the engine (and
  // PostgreSQL's `numeric`, over the shortest digits the store writes)
  // compares the double: an external past 2^53 is not compared alike
  const exactIntegers = dialect.name === 'sqlite';
  const shape = {
    collection: collection.name,
    schema: collection.schema,
    columnByCanonical: physicalPlan.columnByCanonical,
    anyKindColumns: physicalPlan.anyKindColumns,
    // the DECLARED indexes, in their declared column order: a temporal
    // plan is recognized by the index a model already has, so the
    // planner needs to see the list rather than guess a column's role
    indexes: physicalPlan.expected?.indexes ?? [],
    // the DECLARED intervals, each by its two bound columns: over one of
    // them `$overlaps` is exact, since no stored span is empty, reversed
    // or malformed
    intervals: physicalPlan.intervals ?? [],
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
    doubleColumns: physicalPlan.doubleColumns,
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

  /** Every driver failure this engine meets, classified under the
   * collection it belongs to. */
  const driverWrap = (/** @type {any} */ error) =>
    wrapDriverError(error, { docPath: collection.docPath, collection: collection.name });

  /** Whether a pushed sum or average left its exactness bound: the guard
   * the emitter writes beside each one (`_safe`, `_safe<i>`, a bucket's
   * own names) did not hold.
   * @param {any} entry @param {any[]} rows */
  const inexact = (entry, rows) => {
    if (entry.plan.aggregate !== null)
      return ['sum', 'avg'].includes(entry.plan.aggregate.fn) && rows.some((row) => row?._safe !== 1);
    if (entry.plan.bucket !== null) {
      const guards = bucketGuards(entry.plan.bucket);
      return rows.some((row) => guards.some((name) => name !== null && row[name] !== 1));
    }
    return rows.some((row) => entry.plan.group.aggregates.some((aggregate, i) =>
      ['sum', 'avg'].includes(aggregate.fn) && row[`_safe${i}`] !== 1));
  };

  /**
   * The engine's answer for a pushed sum or average whose terms left the
   * range in which every partial sum is exact, as its guard reported: the
   * residual over the rows the plan selects — what the set residual of the
   * same document reads, so a profile bounds the selected rows, not the
   * collection — remembered for `explain()` and refused by strict mode.
   * `packed` answers a cursor's items rather than the result shape.
   * @param {any} entry @param {any} externals @param {any} document
   * @param {boolean} strict @param {boolean} packed
   */
  const accumulationResidual = (entry, externals, document, strict, packed) => {
    if (strict) {
      throw new DbCompileError('JD0010',
        `strict mode refused a residual: 'accumulation' — ${BIND_REASONS.accumulation}`, collection.docPath);
    }
    entry.accumulationRuns = (entry.accumulationRuns ?? 0) + 1;
    return chain(selectedDocs(entry, externals), (docs) => {
      const answer = packed ? packedResidualOf(entry, document)(docs, externals)
        : setResidualOf(entry, document)(docs, externals);
      countSeries(entry, 2 * statementCost(entry), docs.length, itemCount(answer));
      return answer;
    });
  };

  /**
   * Ring 3 for AGGREGATES: a registry `agg` operator the pack marked
   * `pushable: 'aggregate'` becomes a SQL aggregate over the member's
   * column, folded by the same pure function the residual would call.
   * Two independent gates, never one inferred from the other: the
   * DRIVER must have an aggregate API (bun:sqlite does not), and the
   * pack must have declared the operator poolable that way.
   */
  const aggregateHook = connection.capabilities.aggregateFunctions === true
    && operators !== null && operators.pushableAggregate?.size > 0
    ? (/** @type {string} */ name) => {
      const spec = operators.pushableAggregate.get(name);
      if (spec === undefined) return null;
      return { sql: registerAggregateOperator(connection, state.registeredAggregates, name, spec) };
    }
    : undefined;

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
  /** The store predicate's comparisons of an external, each with what its
   * member can hold under the collection's schema. @param {any} mandatory */
  const leavesOf = (mandatory) =>
    predicateLeaves(mandatory, (ref) => scalarFamilies(collection.schema, ref.segments), false, dialect);
  /** The store profile's leaves for this collection, as a point read
   * admits its externals by them: translated on first use. @type {any[] | null} */
  let storeLeaves = null;
  const profileLeaves = () => (storeLeaves ??= storeProfile === null
    || rootEntry(storeProfile.predicates, collection.name) === undefined ? []
    : leavesOf(translateProfilePredicate(rootEntry(storeProfile.predicates, collection.name), shape)));

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
    refuseOpaqueValues(document);

    if (profile !== null && profile.collections !== null
      && !profile.collections.includes(collection.name)) {
      throw profileRefusal(
        `the profile does not allow querying collection '${collection.name}'`);
    }

    // no host-side registration under a profile: a foreign document must
    // not cause one, for a predicate fragment or an aggregate alike
    const registering = profile === null && pushdown;
    let planned = planQuery(document, shape,
      { udf: registering ? udfHook : undefined,
        aggregate: registering ? aggregateHook : undefined });
    if (!pushdown) {
      planned = {
        ...planned,
        plan: null,
        mode: 'set',
        reasons: [{ construct: 'pushdown', reason: BIND_REASONS.pushdown }],
        rowReturn: null,
        udfs: [],
        prefilters: [],
        // the whole collection is fetched and the engine answers: the
        // temporal record says so, whatever index the plan would have used
        series: planned.series === null ? null
          : { ...planned.series, mode: 'engine', index: null, prefix: [] },
      };
    }
    // the profile's mandatory predicate rides the same statement, so its
    // leaves count with the plan's against the dialect's term bound; past
    // it the whole document is the set residual's, named, before the
    // profile and strict mode read the mode
    const mandatory = profile !== null
      && rootEntry(profile.predicates, collection.name) !== undefined
      ? translateProfilePredicate(rootEntry(profile.predicates, collection.name), shape)
      : null;
    planned = boundPredicateTerms(planned, dialect.maxPredicateTerms, predicateTerms(mandatory));
    if (profile !== null) {
      // the member allow-list: what the caller may OBTAIN, checked
      // against every member path the document references, before a
      // statement exists
      const denied = memberDenial(profile, collection.name,
        planned.analysis.root, isRootScanSource);
      if (denied !== null) throw profileRefusal(denied);
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
      // the set residual's fetch is the mandatory predicate alone: what it
      // cannot spell has nowhere else to run
      try { emitted = emitPlan(plan, dialect, physical); }
      catch (cause) {
        if (!(cause instanceof UnrepresentablePath)) throw cause;
        throw profileRefusal(uncarriedPredicate(collection.name));
      }
    }
    const externalNames = planned.analysis.externals.map((e) => e.name);
    // what each call's externals must hold as JSON: checked per call, as
    // the externals are the call's own
    const compared = [...comparedExternals(planned.analysis.root),
      ...profileComparedExternals(profile, [collection.name], operators ?? undefined)];
    const limits = profile === null ? undefined : profile.limits;
    const entry = {
      planned,
      plan,
      sql: emitted.sql,
      slots: emitted.slots,
      columns: emitted.columns,
      // the plan's own anchor reads, prepared on first use and kept
      // with it: each one binds a TYPED slot in the statement above
      seeks: (emitted.seeks ?? []).map((seek) => ({ ...seek, statement: null })),
      externalNames,
      // the externals the profile's mandatory predicate binds in every
      // statement of this entry, diverted or not
      predicateExternals: mandatory === null ? [] : [...new Set(analyzeQuery(
        predicateQuery(rootEntry(profile.predicates, collection.name)),
        operators ?? undefined).externals.map((/** @type {any} */ ref) => ref.name))],
      // the predicate's comparisons and memberships of an external, with
      // what each one's member can hold
      predicateLeaves: mandatory === null ? [] : leavesOf(mandatory),
      compared,
      externalSlotKinds: externalSlotKinds(emitted.slots, plan.rank),
      // a literal probe is normalized once, here; an external one per
      // call, from the bound value
      probe: plan.rank !== null && 'lit' in plan.rank.probe
        ? probeVector(plan.rank.probe.lit, plan.rank.alternatives[0].dims) : null,
      // one emitted statement per declared width, prepared on first use
      // and cached with the plan: the bind picks the alternative the
      // probe's own width names, and prepares nothing per call
      rankAlternatives: plan.rank === null ? null
        : plan.rank.alternatives.map((alternative) => {
          const one = emitPlan({ ...plan, rank: { ...plan.rank, alternatives: [alternative] } },
            dialect, physical);
          return { ...alternative, sql: one.sql, slots: one.slots, statement: null };
        }),
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
      // the fetch a pushed sum's fallback reads, emitted on first use
      selectionSql: null,
      // the LAST actual execution's numbers, never an estimate: `null`
      // until this document has run once
      seriesCounts: null,
    };

    return retainEntry(state, key, entry);
  };

  const statementOf = (entry, use) => useRead(connection, entry, use);
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
      entry.fullScanSql = { sql: emitted.sql, slots: emitted.slots, columns: emitted.columns, statement: null };
    }
    return entry.fullScanSql;
  };
  const fullScanOf = (entry, use) => useRead(connection, fullScanEmitted(entry), use, entry);
  /** The full scan's parameters: its literals, and the externals the
   * profile's mandatory predicate binds from the call — the only
   * externals its statement holds, admitted before any statement runs. */
  const fullScanParams = (entry, externals) =>
    fullScanEmitted(entry).slots.map((slot) => slotValue(slot, externals));
  /**
   * The rows a pushed sum or average selects, as whole documents: the
   * plan's own filter — the profile's mandatory predicate already in it —
   * under the profile's row bound, in collection order. It is the fetch
   * the set residual of the same document reads, so a fallback reads what
   * the document selects and no more.
   */
  const selectionEmitted = (entry) => {
    if (entry.selectionSql === null) {
      const plan = { ...entry.plan, aggregate: null, group: null, bucket: null, order: null, window: null,
        project: /** @type {const} */ ('document') };
      const emitted = emitPlan(entry.rowBound === null ? plan : applyRowBound(plan, entry.rowBound), dialect, physical);
      entry.selectionSql = { sql: emitted.sql, slots: emitted.slots, statement: null, scanChecked: false };
    }
    return entry.selectionSql;
  };
  /** The selected documents of one call, bound as the native statement
   * was — the call's externals, the plan's own seeks — and, under a
   * profile that refuses full scans, refused by their own plan. */
  const selectedDocs = (entry, externals) => {
    const selection = selectionEmitted(entry);
    return chain(guardScan(entry, selection), () => chain(bindSlots(entry, selection.slots, externals), (params) =>
      useRead(connection, selection, (statement) =>
        chain(statement.all(params), (rows) => rowsToDocs(checkRowBound(entry, rows))), entry)));
  };

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
    const bytes = utf8ByteLength(row.doc);
    if (bytes > entry.byteBound) {
      throw new DbRuntimeError('JD2076',
        `an item of ${bytes} serialised bytes exceeds the profile's maxBytes bound of ${entry.byteBound}`,
        { docPath: collection.docPath, collection: collection.name });
    }
  };

  /** The optional plan-shape refusal: a full-table SCAN of a profiled
   * collection is refused when the profile says so, verified against
   * the database's own plan output — of the entry's statement, or of
   * another statement the entry runs (`emitted`, checked once as well). */
  const guardScan = (entry, emitted = entry) => {
    if (!entry.needsScanCheck || emitted.scanChecked) return null;
    const eqpParams = emitted.slots.map((slot) => ('literal' in slot ? slot.literal : null));
    return useStatementOnce(connection, dialect.explainQuery(emitted.sql), (statement) =>
      chain(statement.all(eqpParams), (rows) => {
        const lines = dialect.explainLines(rows);
        if (lines.some((line) => dialect.isFullScan(line, [physical.table]))) {
          throw profileRefusal(
            `the profile refuses a full-table scan of '${collection.name}' `
            + `(${lines.join('; ')})`);
        }
        emitted.scanChecked = true;
        return null;
      }), { readOnly: true });
  };

  /**
   * The declared width a probe names, as the emitted alternative that
   * reads it — or `null` when no declared width takes this value, which
   * is the diversion a wrong-width probe has always been. A `null`
   * probe, a probe of the wrong shape and a probe of an undeclared
   * width are one answer here: the database has no column for it.
   * @param {any} entry
   * @param {any} value - the bound probe
   */
  const rankAlternativeFor = (entry, value) =>
    entry.rankAlternatives.find((alternative) =>
      probeVector(value, alternative.dims) !== null) ?? null;

  /**
   * The anchors this entry's seeks answer, read before the statement
   * that binds them. Each seek is one aggregate read through the same
   * declared index, prepared once and kept with the plan; a seek that
   * finds nothing binds its own probe, which excludes exactly the rows
   * it proved are not there.
   * @param {any} entry
   * @returns {any} value-or-promise of the name → anchor map
   */
  const seekAnchors = (entry) => {
    /** @type {Record<string, any>} */
    const anchors = Object.create(null);
    const next = (i) => {
      if (i >= entry.seeks.length) return anchors;
      const seek = entry.seeks[i];
      return useRead(connection, seek, (prepared) =>
        chain(prepared.get(seek.slots.map((slot) => slotValue(slot, {}))), (row) => {
          anchors[seek.name] = anchorValue(seek, row);
          return next(i + 1);
        }), entry);
    };
    return next(0);
  };

  /**
   * One seek's answer, type-checked before it can reach a statement.
   * The column is of declared type, so the only way a value of another
   * type arrives is a defect below the store (a driver handing back a
   * BigInt, a column written past the declaration) — and a bind that
   * silently compared a number against text would answer WRONG rather
   * than fail, so it is refused here, before the SQL it would bind.
   * @param {any} seek
   * @param {any} row
   */
  const anchorValue = (seek, row) => {
    const value = row === undefined || row === null ? null : row.anchor;
    if (value === null || value === undefined) return seek.fallback;
    const kind = typeof value === 'number' && Number.isFinite(value) ? 'number'
      : typeof value === 'string' ? 'text' : null;
    if (kind !== seek.kind) {
      throw new DbRuntimeError('JD2086',
        `the seek '${seek.name}' declared ${seek.kind} and the database answered `
        + `${typeof value}`, collection.name);
    }
    return value;
  };

  /** Bind slots against the call's externals, and the seeks' anchors:
   * the entry's own, or another statement's of the same plan (`slots`),
   * whose typed slots name the same seeks. */
  const bindSlots = (entry, slots, externals) =>
    (entry.seeks.length === 0
      ? slots.map((slot) => slotValue(slot, externals))
      : chain(seekAnchors(entry), (anchors) =>
        slots.map((slot) => slotValue(slot, externals, anchors))));
  const bindParams = (entry, externals) => bindSlots(entry, entry.slots, externals);

  /** Run a bound statement: the bind itself may have to READ first. */
  const runAll = (entry, externals, statement) =>
    chain(bindParams(entry, externals), (params) => statement.all(params));
  const runGet = (entry, externals, statement) =>
    chain(bindParams(entry, externals), (params) => statement.get(params));
  /** How many statements one execution of this entry costs. */
  const statementCost = (entry) => 1 + entry.seeks.length;

  /** The external whose bound value sends this call to the residual —
   * a value the database cannot take, a region with no box, a probe of
   * the wrong width — or `null` when every external binds. */
  const divertingExternal = (entry, externals) =>
    entry.externalNames.find((name) => {
      const kind = entry.externalSlotKinds.get(name);
      const invalidDerived = entry.slots.some((slot) => {
        if (!('derived' in slot)) return false;
        const inputs = slot.derived.kind === 'bboxAxis'
          ? [slot.derived] : [slot.derived.centre, slot.derived.radius];
        return inputs.some((input) => 'external' in input && input.external === name)
          && !bindable(slotValue(slot, externals));
      });
      if (invalidDerived) return true;
      if (kind === 'derived') return false;
      if (kind === 'list') return !listBindable(externals[name], exactIntegers, dialect);
      // a probe binds when SOME declared width takes it; a width the
      // model does not declare is the diversion it always was
      if (kind === 'probe') return rankAlternativeFor(entry, externals[name]) === null;
      return !bindable(externals[name], exactIntegers, dialect);
    }) ?? null;
  /** Must this call divert to the residual? */
  const mustDivert = (entry, externals) => divertingExternal(entry, externals) !== null;
  /** Admit the externals the profile's mandatory predicate binds in every
   * statement of this entry, diverted or not ({@link admitPredicateExternals}):
   * a missing one, and one the statement would compare otherwise than the
   * engine where the member can hold it, are refused (`JD0011`), as the
   * engine refuses a missing one (`JQ2006`) and as a point read does.
   * `repair` names the way out a surface that takes no externals has. */
  const refuseUnboundPredicate = (entry, externals, repair = '') => {
    admitPredicateExternals(collection.name, entry.predicateExternals, entry.predicateLeaves, externals,
      { read: 'call', repair, refusal: profileRefusal });
  };

  const rowsToDocs = (rows) => rows.map((row) => JSON.parse(row.doc));

  /**
   * The bucket records a native temporal group answers: the ladder's
   * start under the name the document asked for it by, then one member
   * per aggregate with the caller's own word for "no numbers".
   *
   * `null` when a group has no instant at all — a row whose instant
   * member is missing or is not a number groups under SQL `NULL`, and
   * the kernel REFUSES such a row (`JQ2001`). So it does a row that
   * carries no reading when the plan counts those (`reading`): SQL skips
   * the `NULL` it reads there. SQL cannot refuse, so the call diverts and
   * the engine answers, exactly as it does everywhere.
   * @param {any} entry
   * @param {any[]} rows
   * @returns {any[] | null}
   */
  const bucketItems = (entry, rows) => {
    const bucket = entry.plan.bucket;
    const absent = bucketAbsentGuard(bucket);
    const items = [];
    for (const row of rows) {
      const start = row[bucket.as] ?? null;
      if (start === null) return null;
      if (absent !== null && Number(row[absent]) > 0) return null;
      /** @type {any} */
      const item = { [bucket.as]: start };
      for (const aggregate of bucket.aggregates) {
        const value = row[aggregate.as] ?? null;
        if (value === null && aggregate.empty === 'omit') continue;
        setObjectMember(item, aggregate.as, value === null && aggregate.empty === 'zero' ? 0 : value);
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
    return fullScanOf(entry, (statement) =>
      chain(statement.all(fullScanParams(entry, externals)), (rows) => {
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
    const live = { statements: statementCost(entry), candidates: 0, results: 0, partial: true };
    entry.seriesCounts = live;
    return {
      row: (items) => {
        live.candidates++;
        live.results += items;
      },
      settle: (opened) => {
        if (entry.seriesCounts === live) entry.seriesCounts = { ...live, partial: false };
        if (opened) countSeries(entry, statementCost(entry), live.candidates, live.results);
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
      let entry = identityFetch.get(batch.size);
      if (entry === undefined) {
        entry = { sql: dialect.dml.selectByIdentities(physical, batch.size), statement: null };
        identityFetch.set(batch.size, entry);
      }
      return useRead(connection, entry, (prepared) => chain(prepared.all(batch.params), (rows) => {
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
    const chosen = 'lit' in rank.probe
      ? entry.rankAlternatives[0]
      : rankAlternativeFor(entry, externals[rank.probe.ext]);
    const probe = entry.probe ?? probeVector(externals[rank.probe.ext], chosen.dims);
    return useRead(connection, chosen, (statement) =>
      chain(statement.all(chosen.slots.map((slot) => slotValue(slot, externals))), (rows) => {
        checkRowBound(entry, rows);
        const scored = rows.map((row) =>
          ({ identity: row.rid, score: columnScore(row.vec, chosen.dims, probe) }));
        const cut = cutCandidates(scored, rank.offset + rank.limit, rank.margin);
        knnStats.queries++;
        knnStats.rows += rows.length;
        knnStats.candidates += cut.identities.length;
        if (cut.full) knnStats.fullFetches++;
        return fetchByIdentities(cut.identities);
      }), entry);
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
      return fullScanOf(entry, (statement) =>
        chain(statement.all(fullScanParams(entry, externals)), (rows) =>
          rowsToDocs(checkRowBound(entry, rows))));
    }
    if (entry.planned.mode === 'knn') return knnCandidates(entry, externals);
    return statementOf(entry, (statement) =>
      chain(runAll(entry, externals, statement), (rows) =>
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
   * The profile one call runs under, with its member allow-list checked
   * against the model's declared roots — a policy naming a root the
   * model does not have applies to nothing, which is a policy failing
   * open, so it is refused here rather than at the first query that
   * happens to name that root.
   * @param {any} options
   */
  const resolveProfile = (options) => {
    const resolved = floorProfile(storeProfile, options?.profile, collection.docPath);
    assertProfileRoots(resolved, roots, collection.docPath);
    return resolved;
  };

  /**
   * Resolve the profile and pushdown switches for one call.
   * @param {any} options
   */
  const callState = (options) => ({
    externals: options?.externals ?? {},
    strict: options?.strict === true,
    profile: resolveProfile(options),
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
    const spelling = `collection('${collection.name}').execute`;
    readCallOptions(options, DOCUMENT_CALL_OPTIONS, spelling);
    refuseNonDocument(document, spelling);
    refuseWholeStreaming(options, spelling, 'query()');
    requireCallable(options, state.now);
    const { externals, strict, profile, pushdown } = callState(options);
    const entry = entryFor(document, strict, profile, pushdown);
    refuseOpaqueExternals(entry.compared, externals, spelling);
    refuseUnboundPredicate(entry, externals);

    return chain(guardScan(entry), () => {
      const diverted = mustDivert(entry, externals);
      if (diverted || entry.planned.mode === 'set' || entry.planned.mode === 'knn') {
        // the candidates — the whole collection, the narrowed fetch, or
        // the k-nearest cut — and the full document over them, which
        // re-applies its own predicates and ordering (idempotent
        // narrowing: the fetch decided nothing)
        return chain(candidatesOf(entry, externals, diverted), (docs) => {
          const answer = setResidualOf(entry, document)(docs, externals);
          countSeries(entry, diverted ? 1 : statementCost(entry), docs.length, itemCount(answer));
          return answer;
        });
      }
      if (entry.planned.mode === 'row') {
        return statementOf(entry, (statement) =>
          chain(runAll(entry, externals, statement), (rows) => {
            const items = [];
            for (const row of checkRowBound(entry, rows))
              items.push(...entry.rowResidual(JSON.parse(row.doc), externals));
            countSeries(entry, statementCost(entry), rows.length, items.length);
            return answerOf(entry, items);
          }));
      }
      return statementOf(entry, (statement) => {
        if (entry.plan.aggregate !== null) {
          return chain(runGet(entry, externals, statement), (row) => {
            if (inexact(entry, [row])) return accumulationResidual(entry, externals, document, strict, false);
            const value = aggregateResult(entry, row);
            countSeries(entry, statementCost(entry), null, value === undefined ? 0 : 1);
            return wrapValue(entry, value);
          });
        }
        if (entry.plan.group !== null) {
          return chain(runAll(entry, externals, statement), (rows) => {
            checkRowBound(entry, rows);
            return inexact(entry, rows) ? accumulationResidual(entry, externals, document, strict, false)
              : answerOf(entry, groupItems(entry.plan.group, rows));
          });
        }
        if (entry.plan.bucket !== null) {
          return chain(runAll(entry, externals, statement), (rows) => {
            const items = bucketItems(entry, checkRowBound(entry, rows));
            if (items === null) return divertBucket(entry, document, externals);
            if (inexact(entry, rows)) return accumulationResidual(entry, externals, document, strict, false);
            countSeries(entry, statementCost(entry), rows.length, items.length);
            return answerOf(entry, items);
          });
        }
        return chain(runAll(entry, externals, statement), (rows) => {
          checkRowBound(entry, rows);
          const items = entry.plan.project === 'document'
            ? rowsToDocs(rows)
            : 'path' in entry.plan.project
              ? rows.flatMap(projectedItems)
              : rows.flatMap((row) => projectedTreeItems(entry.plan.project, row));
          countSeries(entry, statementCost(entry), rows.length, items.length);
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
      return buffered('window', BIND_REASONS.wrappedWindow);
    }
    // a plan that is a residual already buffers for its own reason,
    // whatever its externals bind to; that reason stays first
    if (entry.planned.mode === 'set' || entry.planned.mode === 'knn') {
      const forcing = entry.planned.reasons[0]
        ?? { construct: 'residual', reason: BIND_REASONS.untranslated };
      return buffered(forcing.construct, forcing.reason);
    }
    // `null` externals is the ABSTRACT question — the plan as planned,
    // every external assumed bindable — which `explain()` answers when it
    // is given no externals at all; a call always binds real ones
    const unbindable = externals === null ? null : divertingExternal(entry, externals);
    if (unbindable !== null) {
      return buffered('external', BIND_REASONS.external(unbindable, 'collection'));
    }
    if (entry.plan.bucket !== null || entry.plan.group !== null) {
      return buffered('$groupby', BIND_REASONS.bucketWhole);
    }
    // past its exactness bound a sum or an average is answered by the
    // engine over the rows it selects, which the cursor then holds whole
    if (entry.plan.aggregate !== null && ['sum', 'avg'].includes(entry.plan.aggregate.fn)) {
      return buffered(`$${entry.plan.aggregate.fn}`, BIND_REASONS.accumulationWhole);
    }
    const raising = raisingBarrier(entry);
    if (raising !== null) return buffered(raising.construct, raising.reason);
    return rowClassOf(connection);
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
   * @param {typeof createCursor} [cursorFactory] - the synchronous cursor
   *   for a caller that drains it on a synchronous driver (`all()` on the
   *   synchronous twin); the asynchronous one otherwise
   * @param {string} [repair] - what a refusal of an unbound predicate
   *   external adds for a caller that takes no externals (`all()`)
   */
  const query = (document, options = undefined, cursorFactory = createCursor, repair = '') => {
    const spelling = `collection('${collection.name}').query`;
    readCallOptions(options, DOCUMENT_CALL_OPTIONS, spelling);
    refuseNonDocument(document, spelling);
    requireCallable(options, state.now);
    const { externals, strict, profile, pushdown } = callState(options);
    const entry = entryFor(document, strict, profile, pushdown);
    refuseOpaqueExternals(entry.compared, externals, spelling);
    refuseUnboundPredicate(entry, externals, repair);
    const classified = cursorClass(entry, externals);
    refuseBuffered(options, classified, collection.docPath);
    const signal = options?.signal;
    const deadline = options?.deadline;

    if (entry.planned.wrapped === true) {
      // a chain's element window is ONE item — the array — whatever
      // the plan mode; the cursor hands it over as `execute` answers it
      return cursorFactory({ ...classified, signal, deadline, now: state.now, wrap: driverWrap,
        materialize: () => chain(execute(document, options), (value) => [value]) });
    }
    const diverted = mustDivert(entry, externals);
    if (diverted || entry.planned.mode === 'set' || entry.planned.mode === 'knn') {
      // the barrier: materialize candidates, pack the result items
      return cursorFactory({ ...classified, signal, deadline, now: state.now, wrap: driverWrap,
        materialize: () => chain(guardScan(entry), () =>
          chain(candidatesOf(entry, externals, diverted), (docs) => {
            const items = packedResidualOf(entry, document)(docs, externals);
            countSeries(entry, diverted ? 1 : statementCost(entry), docs.length, items.length);
            return items;
          })) });
    }
    if (entry.plan.group !== null && entry.plan.aggregate === null) {
      // a native grouping is a barrier: the groups are the answer
      return cursorFactory({ ...classified, signal, deadline, now: state.now, wrap: driverWrap,
        materialize: () => chain(guardScan(entry), () => statementOf(entry, (statement) =>
          chain(runAll(entry, externals, statement), (rows) => {
            checkRowBound(entry, rows);
            return inexact(entry, rows) ? accumulationResidual(entry, externals, document, strict, true)
              : groupItems(entry.plan.group, rows);
          }))) });
    }
    if (entry.plan.bucket !== null) {
      // a native bucket is a barrier: the groups are the answer
      return cursorFactory({ ...classified, signal, deadline, now: state.now, wrap: driverWrap,
        materialize: () => chain(guardScan(entry), () => statementOf(entry, (statement) =>
          chain(runAll(entry, externals, statement), (rows) => {
            const items = bucketItems(entry, checkRowBound(entry, rows));
            if (items === null) {
              return chain(divertBucket(entry, document, externals), (value) =>
                (value === undefined ? [] : Array.isArray(value) ? value : [value]));
            }
            if (inexact(entry, rows)) return accumulationResidual(entry, externals, document, strict, true);
            countSeries(entry, statementCost(entry), rows.length, items.length);
            return items;
          }))) });
    }
    if (entry.plan.aggregate !== null) {
      // a native aggregate yields exactly one item; a sum past its
      // exactness bound answers the engine's items instead
      return cursorFactory({ ...classified, signal, deadline, now: state.now, wrap: driverWrap,
        materialize: () => chain(guardScan(entry), () => statementOf(entry, (statement) =>
          chain(runGet(entry, externals, statement), (row) => {
            if (inexact(entry, [row])) return accumulationResidual(entry, externals, document, strict, true);
            const value = aggregateResult(entry, row);
            countSeries(entry, statementCost(entry), null, value === undefined ? 0 : 1);
            return value === undefined ? [] : [value];
          }))) });
    }
    let pulledRows = 0;
    const tally = seriesTally(entry);
    /** One database row's items. @param {any} row */
    const items = (row) => {
      pulledRows++;
      if (entry.rowBound !== null && pulledRows > entry.rowBound) {
        throw new DbRuntimeError('JD2007',
          `the fetch crossed the profile's maxRows bound of ${entry.rowBound}`,
          { docPath: collection.docPath, collection: collection.name });
      }
      checkByteBound(entry, row);
      const items = entry.plan.project === 'document'
        ? (entry.rowResidual === null ? [JSON.parse(row.doc)]
          : entry.rowResidual(JSON.parse(row.doc), externals))
        : 'path' in entry.plan.project
          ? projectedItems(row)
          : projectedTreeItems(entry.plan.project, row);
      tally?.row(items.length);
      return items;
    };
    const onSettle = tally === null ? undefined : tally.settle;
    if (raisingBarrier(entry) !== null) {
      // a filter or a return that can raise on a row raises before the
      // first item, as the engine's does: the statement is read whole first
      return cursorFactory({ ...classified, signal, deadline, now: state.now, wrap: driverWrap, onSettle,
        materialize: () => chain(guardScan(entry), () => statementOf(entry, (statement) =>
          chain(runAll(entry, externals, statement), (rows) => rows.flatMap(items)))) });
    }
    // a cursor iterates a statement of its OWN: two cursors over one
    // cached statement invalidate each other's iterator at the driver
    return cursorFactory({ ...classified, signal, deadline, now: state.now, wrap: driverWrap, onSettle,
      // the bind may have to READ first (a seek's anchor), so it settles
      // before the statement it binds is prepared
      open: () => chain(guardScan(entry), () => chain(bindParams(entry, externals),
        (params) => chain(connection.prepare(entry.sql, { readOnly: true, ephemeral: true }),
          (statement) => statement.iterate(params)))),
      items });
  };

  /**
   * The explanation record: the engine explain shape plus the pushdown
   * facts. `budget.estimatedRows` is the database planner's own
   * estimate for a native plan whose every slot is bound, labelled with
   * its source, and `unavailable` everywhere else — SQLite, a plan the
   * engine answers, a slot the call leaves unbound — so no number is
   * fabricated; the database's own plan prose rides in `scanNarrative`.
   * Every count in `series` is the LAST ACTUAL execution's, and
   * `null` until this document has run once.
   * @param {any} document
   * @param {{ externals?: any, strict?: boolean }} [options]
   */
  const explain = (document, options = undefined) => {
    // the options of the call it explains, an execute's or a cursor's
    const spelling = `collection('${collection.name}').explain`;
    readCallOptions(options, DOCUMENT_CALL_OPTIONS, spelling);
    refuseNonDocument(document, spelling);
    const { externals, strict, profile, profileSource, pushdown } = callState(options);
    const entry = entryFor(document, strict, profile, pushdown);
    refuseOpaqueExternals(entry.compared, externals, spelling);
    // the run this call would make: bound against the externals it was
    // given, a diversion reads the whole collection through the
    // diversion statement and answers in the set residual — so that is
    // the mode, the SQL and the barrier reported, not the native plan's
    // no externals at all is the abstract plan, as it always was; given
    // externals — even a partial set — are bound as execute would bind
    // them, and refused as execute refuses them
    const bound = options?.externals !== undefined;
    if (bound) refuseUnboundPredicate(entry, externals);
    const classified = cursorClass(entry, bound ? externals : null);
    const diverted = bound && mustDivert(entry, externals);
    const chosen = diverted ? fullScanEmitted(entry) : entry;
    const mode = diverted ? 'set' : entry.planned.mode;

    // the columns the statement spells are the ones an index serves: a
    // comparison the column cannot answer reads the document, and its
    // index is not named
    const touchedColumns = new Set(chosen.columns);
    // an R*Tree probe touches no generated column at all — the index it
    // reads IS a table — so the virtual tables are collected beside the
    // declared indexes and named in the same `indexes` list
    const touchedVirtual = new Set();
    const collectVirtual = (pred) => {
      if (pred === null) return;
      if (pred.p === 'and' || pred.p === 'or') pred.items.forEach(collectVirtual);
      else if (pred.p === 'not') collectVirtual(pred.item);
      else if (pred.p === 'bboxRtree') touchedVirtual.add(pred.table);
    };
    collectVirtual(diverted ? entry.fullScanShape().filter : entry.plan.filter);
    const indexes = [
      ...physicalPlan.expected.indexes
        .filter((index) => index.columns.some((column) => touchedColumns.has(column)))
        .map((index) => index.name),
      ...[...touchedVirtual].sort(),
    ];

    const params = chosen.slots.map((slot) => {
      if ('external' in slot) return { external: slot.external };
      if ('derived' in slot) return { derived: { ...slot.derived } };
      if ('typed' in slot) return { typed: { ...slot.typed } };
      return { literal: slot.literal };
    });
    // EXPLAIN reads the statement's SHAPE: a seek's anchor is a value
    // the database would answer for a run, and explaining a plan runs
    // nothing, so the slot it fills is described and left unbound. Such a
    // slot, like an external the call left unbound, binds NULL, and the
    // statement then differs from the one a run would send
    let substituted = false;
    const eqpParams = chosen.slots.map((slot) => {
      const value = 'typed' in slot ? undefined : slotValue(slot, externals);
      if (bindable(value) || typeof value === 'bigint') return value;
      substituted = true;
      return null;
    });
    // a diversion is one more reason the engine answers, appended after
    // the plan's own: a residual stays a residual for its own reason,
    // and a native plan's only reason is the value that would not bind
    const reasons = diverted
      ? [...entry.planned.reasons, { construct: 'external',
        reason: BIND_REASONS.external(divertingExternal(entry, externals), 'collection') }]
      : entry.planned.reasons;

    const rank = entry.plan.rank;
    const explained = (estimate) => useStatementOnce(connection, dialect.explainQuery(chosen.sql), (statement) =>
      chain(statement.all(eqpParams), (rows) => ({
        mode,
        // what a cursor over this call does — one row per pull, or a
        // buffer — and the construct that forces the buffer: the same
        // classification the cursor itself carries, so the two agree
        streaming: classified.streaming,
        barrier: classified.barrier,
        // the profile that applied and every bound it imposed
        budget: budgetOf(profile, profileSource, connection.capabilities, estimate),
        // the order the STATEMENT executes under — the plan's declared
        // terms and the tie-breaker the emitter appends, in the same
        // normalized form the emitter renders (read from the plan, never
        // parsed back out of SQL). `null` is the honest answer for
        // a statement that orders nothing at all
        order: planOrder(diverted ? entry.fullScanShape() : entry.plan),
        // what the statement projects: `null` when it reads the whole
        // document, one `path` when it projects a single member, and
        // `paths` — one per DISTINCT leaf, in fetch order — when it
        // projects a nested shape the decoder rebuilds
        projection: entry.plan.project === 'document' ? null
          : 'path' in entry.plan.project
            ? { path: segmentsOf(entry.plan.project.path) }
            : { paths: entry.plan.project.leaves.map(segmentsOf) },
        // the projection that stayed behind, when one did: the one-row
        // document the row residual runs per fetched row
        residualProjection: entry.planned.rowReturn?.$return?.[0] ?? null,
        // the GROUPING the statement performs, when it performs one:
        // the key names with the member each reads, the aggregates with
        // the function and the member each folds, and how the groups
        // come out. `null` when nothing is grouped natively
        group: entry.plan.group === null ? null : {
          keys: entry.plan.group.keys.map((key) => ({ as: key.as, path: segmentsOf(key.ref) })),
          aggregates: entry.plan.group.aggregates.map((entry2) => ({
            fn: entry2.fn, path: entry2.ref === null ? null : segmentsOf(entry2.ref) })),
          order: entry.plan.group.order === 'first-seen' ? 'first-seen'
            : entry.plan.group.order.map((term) => ({
              ...(term.aggregate === undefined ? { key: entry.plan.group.keys[term.index].as }
                : { aggregate: entry.plan.group.aggregates[term.aggregate].fn,
                  path: entry.plan.group.aggregates[term.aggregate].ref?.segments ?? null }),
              desc: term.desc })),
        },
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
          // every declared width the plan can bind, and — when the call
          // was given its externals — the one it selected. The probe is
          // named, never printed
          alternatives: entry.rankAlternatives.map((alternative) =>
            ({ column: alternative.column, dims: alternative.dims })),
          selected: !bound || 'lit' in rank.probe
            ? (('lit' in rank.probe) ? rank.alternatives[0].dims : null)
            : rankAlternativeFor(entry, externals[rank.probe.ext])?.dims ?? null,
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
        // a pushed sum or average whose run the engine answered instead,
        // past its exactness bound, and how many runs it took
        fallback: entry.accumulationRuns === undefined ? null
          : { construct: 'accumulation', runs: entry.accumulationRuns, reason: BIND_REASONS.accumulation },
        // the temporal record: what the document asked, which declared
        // index the fetch seeks through, and which kernel finished it.
        // The counts are the LAST ACTUAL execution's — `null` before
        // this document has run — because an estimate mislabelled as a
        // count is exactly the thing an honest explain may not print
        series: entry.planned.series === null ? null : {
          ...entry.planned.series,
          counts: entry.seriesCounts === null ? null : { ...entry.seriesCounts },
        },
        scanNarrative: dialect.explainLines(rows).join('; '),
      })), { readOnly: true });
    // a native plan with every slot bound is priced first, by a statement of its own
    return chain(mode === 'native' && !substituted ? estimateOf(connection, dialect, chosen.sql, eqpParams) : null,
      explained);
  };

  return { execute: bounded(execute, driverWrap), query, explain: bounded(explain, driverWrap), shape,
    predicateLeaves: profileLeaves,
    stats: () => ({ knn: { ...knnStats }, series: { ...seriesStats }, bind: { ...bindStats } }) };
}

/**
 * `strictStreaming` (refusing rather than degrading, applied to memory): a plan that would buffer is
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
import { relationTables, joinTableRoots } from './model.js';

/** The default include depth bound (printed, never silent). */
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
 * The first external a plan predicate names, or null.
 * @param {any} pred
 * @returns {string | null}
 */
function externalOf(pred) {
  if (pred === null || typeof pred !== 'object') return null;
  if (pred.p === 'and' || pred.p === 'or') {
    for (const item of pred.items) {
      const found = externalOf(item);
      if (found !== null) return found;
    }
    return null;
  }
  if (pred.p === 'not') return externalOf(pred.item);
  return pred.operand !== undefined && 'ext' in pred.operand ? pred.operand.ext : null;
}

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
  const wrapper = predicateQuery(expression);
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
  const expression = profile === null ? undefined : rootEntry(profile.predicates, entity.name);
  if (expression === undefined) return null;
  const planned = planEntityWhere(expression, entity, entityMapping, analyzeOpts);
  // a literal the database would read as another string keeps other rows
  // than the predicate names, and a mandatory predicate has no engine path
  const lone = 'filter' in planned && planned.filter !== null && bindsLoneSurrogate(planned.filter);
  if ('filter' in planned && planned.filter !== null && !lone) return planned.filter;
  throw new TypeError(`a profile predicate must translate natively (it binds the database-side fetch of '${
    entity.name}'); this one refused: ${'refusal' in planned ? planned.refusal.reason
    : 'error' in planned ? planned.error.message : lone ? LONE_SURROGATE_REFUSAL : 'it selects nothing'}`);
}

/**
 * The profile's compile-time refusal for an entity document (`JD0011`).
 * @param {string} reason
 * @param {string | undefined} docPath
 */
const profileEntityRefusal = (reason, docPath) => new DbCompileError('JD0011', reason, docPath);

/**
 * Why a profile's mandatory predicate has no statement on a database: it
 * compares a string literal the server cannot hold, or reads a member name
 * the dialect's JSON path grammar cannot carry, and such a predicate has no
 * residual to run in.
 * @param {string} root
 */
const uncarriedPredicate = (root) => `the profile's predicate for '${root}' compares a string this server `
  + 'cannot hold (U+0000, or a list item holding U+0000 or a lone surrogate) or reads a member name its JSON '
  + 'path grammar cannot carry, and a mandatory predicate runs in the database or not at all';

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
  const { connection, state } = context;
  // the query roots: the model's entities, plus the read-only
  // pseudo-entity each declared join table contributes (§10.7). They
  // are visible to the PLANNER and to `$.<Name>[*]`, and to nothing
  // that writes — `store.entity(name)` reads the model's own map
  const joinRoots = joinTableRoots(context.entities, context.mapping);
  const entities = joinRoots.entities.size === 0
    ? context.entities
    : new Map([...context.entities, ...joinRoots.entities]);
  const mapping = joinRoots.entities.size === 0
    ? context.mapping
    : { ...context.mapping,
      entities: { ...context.mapping.entities, ...joinRoots.mappings } };
  const storeProfile = context.profile ?? null;
  const roots = context.roots ?? [...entities.keys()];
  const operators = state.operators ?? null;
  const analyzeOpts = operators ?? undefined;
  const zoneProvider = state.zoneProvider ?? null;
  /** Every driver failure this engine meets, classified under the
   * entity root. */
  const driverWrap = (/** @type {any} */ error) => wrapDriverError(error, { docPath: '/entities' });
  const dialect = connection.dialect;
  const q = dialect.quoteIdentifier;
  const physicalOf = (name) => ({ table: mapping.entities[name].table, schema: mapping.entities[name].schema,
    // a join-table root has no document column of its own (§10.7)
    document: mapping.entities[name].document !== false,
    // the names a row identity must not share
    columns: entityTableColumns(mapping.entities[name]),
    ...(entities.get(name)?.physical == null ? {} : {
      mapping: mapping.entities[name],
      keys: mapping.entities[name].keys.map((key) => mapping.entities[name].columns.find((c) => c.name === key).physical),
    }) });
  // the relation tables of every root this engine serves (§10.1): the
  // engine is the scope every entity set of the store shares, so a
  // producer holding one set can follow a hop into another root
  const relations = relationTables(entities);

  /** The switches one call resolves: the profile per call narrows the
   * store's ({@link floorProfile}), as on a collection. */
  const callState = (options) => {
    const profile = floorProfile(storeProfile, options?.profile, '/entities');
    assertProfileRoots(profile, roots, '/entities');
    return {
      externals: options?.externals ?? {},
      strict: options?.strict === true,
      pushdown: options?.pushdown !== false,
      profile,
      profileSource: options?.profile !== undefined ? 'call'
        : (storeProfile === null ? null : 'store'),
    };
  };

  // as on a collection: SQLite reads a JSON integer by its digits
  const exactIntegers = dialect.name === 'sqlite';
  /** A mandatory predicate's comparisons of an external, by what each
   * column can hold: its storage kind, and a present `null` only where its
   * policy reads a NULL as one. A bound `null` compares as the engine does
   * on every column, as it always has. @param {any} predicate */
  const entityLeaves = (predicate) => predicateLeaves(predicate, (ref) => {
    const kind = ref.storage === 'string' ? 'text' : ref.storage === 'boolean' ? 'boolean' : 'number';
    return ref.nullPolicy === 'null' ? [kind, 'null'] : [kind];
  }, true, dialect);
  /** The externals a profile's predicate of entity `name` names.
   * @param {any} profile @param {string} name @returns {string[]} */
  const predicateNamesOf = (profile, name) => [...new Set(analyzeQuery(predicateQuery(rootEntry(profile.predicates, name)), analyzeOpts)
    .externals.map((/** @type {any} */ ref) => ref.name))];
  /** The store predicate's leaves for entity `name`, as its point read admits
   * by them, translated on first use. @type {Map<string, any[]>} */
  const storeLeaves = new Map();
  const profileLeaves = (/** @type {string} */ name) => {
    if (!storeLeaves.has(name)) {
      const predicate = mandatoryEntityPredicate(storeProfile, entities.get(name), mapping.entities[name], analyzeOpts);
      storeLeaves.set(name, predicate === null ? [] : entityLeaves(predicate));
    }
    return /** @type {any[]} */ (storeLeaves.get(name));
  };

  /** The correlation of a join-table root's rows with one side's rows —
   * `<side>.<key> = <join>.<side>_key`, planned as the hop of an existence
   * test is, with the join row's end of each edge left unbound (`null`): it
   * is the row the bound is judged on, under whatever binding reads it.
   * `null` when the planner keeps the correlation out of SQL.
   * @type {Map<string, any>} */
  const correlations = new Map();
  const correlationOf = (/** @type {string} */ name, /** @type {any} */ side) => {
    const key = `${name}\u0000${side.column}`;
    if (!correlations.has(key)) {
      const planned = planEntityQuery({ $for: { j: entityRoot(name) },
        $where: { $exists: { $for: { s: entityRoot(side.entity) },
          $where: { $eq: [`$s[${JSON.stringify(side.referencesKey)}]`, `$j[${JSON.stringify(side.column)}]`] },
          $return: '$s' } },
        $return: '$j' }, entities, mapping, operators);
      const test = planned.mode === 'native' ? planned.plan.filters[0].filter : null;
      const unbound = (/** @type {any} */ end) => (end.binding === 'j' ? { ...end, binding: null } : end);
      correlations.set(key, test?.p !== 'hop' ? null : { ...test.hop,
        edges: test.hop.edges.map((/** @type {any} */ edge) => ({ left: unbound(edge.left), right: unbound(edge.right) })) });
    }
    return correlations.get(key);
  };
  /** The profile's mandatory predicate for root `name`, translated. A join
   * row names one row on each side, so under a profile that bounds a side
   * it is readable only where the row it names is: its bound is the
   * existence of that row under the side's own predicate, beside any
   * predicate the profile keys by the join table itself — natively, or
   * refused (`JD0011`), never answered unbounded.
   * @param {any} profile @param {string} name @returns {any} */
  const rootPredicate = (profile, name) => {
    let predicate = mandatoryEntityPredicate(profile, entities.get(name), mapping.entities[name], analyzeOpts);
    for (const side of boundedSides(profile, name)) {
      const hop = correlationOf(name, side);
      if (hop === null) {
        throw profileEntityRefusal(`the profile bounds the rows of '${side.entity}', and the rows of the join `
          + `table '${name}' that name them are readable only where those rows are; the correlation of its `
          + `'${side.column}' column with '${side.entity}' cannot be carried natively, so its rows are not read`,
        entities.get(name)?.docPath);
      }
      predicate = conjoin(predicate, { p: 'hop', hop: { ...hop,
        filter: mandatoryEntityPredicate(profile, entities.get(side.entity), mapping.entities[side.entity], analyzeOpts) } });
    }
    return predicate;
  };
  /** The sides of join-table root `name` the profile bounds; none for an
   * entity, and none for a root its allow-list refuses, which is refused
   * by that name. @param {any} profile @param {string} name */
  const boundedSides = (profile, name) => (profile.collections !== null && !profile.collections.includes(name) ? []
    : boundedJoinSides(profile, mapping.joinTables, name));
  /** The roots whose profile predicates a read of `names` binds: each
   * root, and the bounded sides of a join-table root.
   * @param {any} profile @param {readonly string[]} names @returns {string[]} */
  const predicatedRoots = (profile, names) => [...new Set(names.flatMap((name) => [
    ...(rootEntry(profile.predicates, name) === undefined ? [] : [name]),
    ...boundedSides(profile, name).map((side) => side.entity)]))];

  const entryFor = (document, pushdown, profile = null) => {
    const key = ['E', document, dialect.name, pushdown, profile];
    const cached = state.cache.get(key);
    if (cached !== undefined) {
      state.counters.hits++;
      return cached;
    }
    state.counters.misses++;
    refuseOpaqueValues(document);
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
        reasons: [{ construct: 'pushdown', reason: BIND_REASONS.pushdown }] };
    }
    // the runtime guards of a grouping are qualified on PostgreSQL for one
    // adopted table with no document column, and for no join
    if ((planned.plan?.group || planned.plan?.scalarAggregate) && dialect.name !== 'sqlite'
      && !(planned.plan.bindings.length === 1 && dialect.physicalValueType
        && mapping.entities[planned.plan.bindings[0].entity]?.document === false)) {
      planned = { ...planned, mode: 'set', plan: null,
        reasons: [{ construct: '$groupby', reason: BIND_REASONS.entityGrouping }] };
    }
    const docPath = entities.get(planned.referenced[0])?.docPath;
    // the profile's mandatory predicates ride the statement — once per
    // binding over their entity, and in every subselect that reads its
    // rows (a hop's test, count, value or order key) — so their leaves
    // count with the plan's against the dialect's term
    // bound; past it the whole document is the set residual's, named,
    // before the profile reads the mode
    const mandatory = new Map();
    if (profile !== null) {
      for (const name of planned.referenced) {
        const predicate = rootPredicate(profile, name);
        if (predicate !== null) mandatory.set(name, predicate);
      }
    }
    // the roots whose own predicates those carry: a join-table root's
    // bounded sides bind their predicates' externals as the sides do
    const predicated = profile === null ? [] : predicatedRoots(profile, planned.referenced);
    // a literal the server cannot hold has no statement to ride, and a
    // mandatory predicate no residual to run in: refused before any plan
    for (const name of predicated) {
      if (bindsUnheldText(dialect, mandatoryEntityPredicate(profile, entities.get(name), mapping.entities[name], analyzeOpts)))
        throw profileEntityRefusal(uncarriedPredicate(name), entities.get(name)?.docPath);
    }
    const mandatoryTerms = planned.plan === null || mandatory.size === 0 ? 0
      : planned.plan.bindings.reduce((sum, binding) => sum + predicateTerms(mandatory.get(binding.entity) ?? null), 0)
        + hopsOf(planned.plan).reduce((sum, hop) => sum + predicateTerms(mandatory.get(hop.entity) ?? null), 0);
    planned = boundPredicateTerms(planned, dialect.maxPredicateTerms, mandatoryTerms);
    // the profile, applied exactly as on a collection (MODEL-FORMAT §8):
    // the roots a document may read, the references it may make, the
    // predicate every fetch of a root must wear, the row bound every
    // fetch carries, and the shape refusal of a whole-root residual
    if (profile !== null) {
      for (const name of planned.referenced) {
        if (profile.collections !== null && !profile.collections.includes(name))
          throw profileEntityRefusal(`the profile does not allow querying entity '${name}'`, docPath);
        // the member allow-list, per referenced root: every member path
        // the document reads on a binding over that entity's array
        const denied = memberDenial(profile, name,
          planned.analysis.root, isEntityRootSource(name));
        if (denied !== null) throw profileEntityRefusal(denied, entities.get(name)?.docPath);
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
        // preflight rather than estimated
        throw profileEntityRefusal('the profile refuses a full-table scan, and the residual this '
          + `document needs fetches every row of ${planned.referenced.join(', ')} `
          + `('${planned.reasons[0]?.construct}' — ${planned.reasons[0]?.reason})`, docPath);
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
      // each mandatory predicate's comparisons of an external, the
      // externals it names, and those the document itself never names
      predicateLeaves: new Map(predicated.map((name) => [name, entityLeaves(
        mandatoryEntityPredicate(profile, entities.get(name), mapping.entities[name], analyzeOpts))])),
      predicateNames: new Map(predicated.map((name) => [name, predicateNamesOf(profile, name)])),
      predicateOnly: new Set(predicated.flatMap((name) => predicateNamesOf(profile, name))
        .filter((name) => !planned.analysis.externals.some((/** @type {any} */ ref) => ref.name === name))),
      // what each call's externals must hold as JSON, checked per call
      compared: [...comparedExternals(planned.analysis.root),
        ...profileComparedExternals(profile, predicated, analyzeOpts)],
      rowBound: profile === null ? null : profile.maxRows,
      byteBound: profile === null ? null : profile.maxBytes,
      residualLimits: profile === null ? undefined : profile.limits,
      needsScanCheck: profile !== null && profile.refuseFullScan === true,
      scanChecked: false,
      admitted: null,
      runtimeReason: null,
    };
    if (planned.mode === 'native') {
      let plan = planned.plan;
      if (mandatory.size > 0) {
        // the document's own hops first: a join-table root's bound is a
        // hop of its own, which already wears its side's predicate
        plan = mapHops(plan, (hop) => (mandatory.has(hop.entity)
          ? { ...hop, filter: conjoin(hop.filter, mandatory.get(hop.entity)) } : hop));
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
      try {
        const emitted = emitEntityPlan(plan, dialect, physicalOf);
        entry.sql = emitted.sql;
        entry.slots = emitted.slots;
      }
      catch (error) {
        if (!(error instanceof UnrepresentablePath || error instanceof UnrepresentableIdentity)) throw error;
        // a member name the dialect cannot spell, or a table with no row
        // identity to order by: the whole document runs in the set
        // residual, named, as on a collection — and strict mode and a
        // profile refusing full scans refuse it by name
        const construct = error instanceof UnrepresentablePath ? 'path' : 'identity';
        entry.planned = { ...planned, mode: 'set', plan: null,
          reasons: [{ construct, reason: error.message }, ...planned.reasons] };
        if (profile !== null && profile.refuseFullScan === true) {
          throw profileEntityRefusal('the profile refuses a full-table scan, and the residual this '
            + `document needs fetches every row of ${planned.referenced.join(', ')} ('${construct}' — ${error.message})`, docPath);
        }
      }
    }
    return retainEntry(state, key, entry);
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
  const admittedRows = (entry, rows) => {
    entry.admitted ??= { statements: 0, rows: 0, bytes: 0 };
    entry.admitted.statements++;
    entry.admitted.rows += rows.length;
    entry.admitted.bytes += utf8ByteLength(JSON.stringify(rows));
    return rows;
  };
  /** One merged entity document against the profile's byte bound
   * (JD2076): measured after the merge, because the mapped scalars live
   * in columns and the row's own JSON text holds only the rest. */
  const checkBytes = (entry, doc, name) => {
    if (entry.byteBound === null) return doc;
    const bytes = utf8ByteLength(JSON.stringify(doc));
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
    return useStatementOnce(connection, dialect.explainQuery(entry.sql), (statement) =>
      chain(statement.all(eqpParams), (rows) => {
        // the entity statement aliases its tables `t0`, `t1`, … and the
        // database's narrative names the alias; a bare table name is
        // the residual fetcher's spelling
        const tables = entry.planned.referenced.map((name) => mapping.entities[name].table);
        const lines = dialect.explainLines(rows);
        if (lines.some((line) => dialect.isFullScan(line, tables))) {
          throw profileEntityRefusal('the profile refuses a full-table scan of '
            + `${entry.planned.referenced.join(', ')} (${lines.join('; ')})`,
          entities.get(entry.planned.referenced[0])?.docPath);
        }
        entry.scanChecked = true;
        return null;
      }), { readOnly: true });
  };

  /** The statements a residual fetches every referenced entity's rows
   * by, built on first use — each wearing the profile's mandatory
   * predicate for its entity and its row bound (`LIMIT maxRows + 1`,
   * refused when crossed), so a residual's input is as bounded as a
   * native answer. */
  const fetchersOf = (entry) => {
    if (entry.fetchers === null) {
      entry.fetchers = [...(entry.planned.referenced.length === 0
        ? entities.keys() : entry.planned.referenced)].map((name) => {
        /** @type {any[]} */
        const slots = [];
        // a join-table root's bound reads the rows of its sides
        const emitters = createEntityPredicateEmitters(dialect, (slot) => {
          slots.push(slot);
          return dialect.parameterRef(slots.length, 'v');
        }, { tableOf: (entity) => dialect.tableName(mapping.entities[entity].table, mapping.entities[entity].schema) });
        const predicate = entry.mandatory.get(name);
        let where = '';
        if (predicate !== undefined) {
          try {
            where = ` WHERE ${emitters.emitPred(q('t'), `${q('t')}.${q('doc')}`, predicate)}`;
          }
          catch (error) {
            if (!(error instanceof UnrepresentablePath)) throw error;
            throw profileEntityRefusal(uncarriedPredicate(name), entities.get(name)?.docPath);
          }
        }
        const limit = entry.rowBound === null ? '' : ` ${dialect.limitClause(entry.rowBound + 1, undefined)}`;
        return {
          name,
          sql: `SELECT ${entities.get(name)?.physical != null ? physicalSelection(mapping.entities[name], dialect, `${q('t')}.`)
            : `${q('t')}.*, ${mapping.entities[name].document === false ? dialect.stringLiteral('{}')
              : dialect.jsonText(`${q('t')}.${q('doc')}`)} AS ${q('__doc')}`} `
            + `FROM ${dialect.tableName(mapping.entities[name].table, mapping.entities[name].schema)} AS ${q('t')}${where} `
            + `ORDER BY ${entities.get(name)?.physical != null ? mapping.entities[name].keys.map((k) => {
              const column = mapping.entities[name].columns.find((c) => c.name === k);
              // the key's codec comparison, as the native plan orders it: a
              // text key in code-point order on every dialect
              return physicalComparable(column, `${q('t')}.${q(column.physical)}`, dialect);
            }).join(', ') : `${q('t')}.${rowIdentityOf(dialect, mapping.entities[name])}`}${limit}`,
          slots,
          statement: null,
        };
      });
    }
    return entry.fetchers;
  };

  /** Admit the externals the profile's mandatory predicate of every entity
   * the call reads binds, by the rule a collection and a point read follow
   * ({@link admitPredicateExternals}): a missing one, and one its column can
   * hold that the statement compares otherwise than the engine, are refused
   * (`JD0011`) — never dropped: a mandatory predicate runs in the database
   * or not at all. Every statement of the call then binds them as they are.
   * @param {any} entry @param {any} externals */
  const admitPredicates = (entry, externals) => {
    for (const [name, leaves] of entry.predicateLeaves) {
      admitPredicateExternals(name, entry.predicateNames.get(name), leaves, externals, { read: 'call',
        refusal: (reason) => profileEntityRefusal(reason, entities.get(name)?.docPath) });
    }
  };

  /** Fetch every referenced entity's rows through {@link fetchersOf} and
   * build the in-memory root; the call admitted its predicates' externals. */
  const fetchRoot = (entry, externals) => {
    const fetchers = fetchersOf(entry);
    /** @type {any} */
    const root = {};
    const next = (i) => {
      if (i >= fetchers.length) return root;
      const fetcher = fetchers[i];
      return useRead(connection, fetcher, (statement) =>
        chain(statement.all(fetcher.slots.map((slot) => slotValue(slot, externals))), (rows) => {
          admittedRows(entry, rows);
          root[fetcher.name] = checkRows(entry, rows, fetcher.name).map((row) =>
            checkBytes(entry, mergeEntityRow(mapping.entities[fetcher.name], row, '__doc'), fetcher.name));
          return next(i + 1);
        }), entry);
    };
    return next(0);
  };

  const runResidual = (entry, document, externals) => {
    if (entry.setResidual === null)
      entry.setResidual = compileSetResidual(document, entry.residualLimits, operators, zoneProvider);
    return chain(fetchRoot(entry, externals), (root) => entry.setResidual(root, externals));
  };

  /**
   * Run the document and answer in the engine's result shape. Its options
   * are a collection's `execute` set, read before anything runs (`JD0013`).
   * @param {any} document @param {any} [options]
   */
  const execute = (document, options = undefined) => {
    readCallOptions(options, DOCUMENT_CALL_OPTIONS, 'entity execute()');
    refuseWholeStreaming(options, 'entity execute()', 'cursor()');
    refuseNonDocument(document, 'entity execute()');
    return run(document, options);
  };

  /** {@link execute} past its option check — and a cursor's own whole
   * answer, run under the cursor's options. */
  const run = (document, options = undefined) => {
    requireCallable(options, state.now);
    const { externals, strict, pushdown, profile } = callState(options);
    const entry = entryFor(document, pushdown, profile);
    refuseOpaqueExternals(entry.compared, externals, 'entity execute()');
    admitPredicates(entry, externals);
    entry.admitted = { statements: 0, rows: 0, bytes: 0 };
    entry.runtimeReason = null;
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
    const diverted = divertReason(entry, externals);
    if (diverted !== null) {
      entry.runtimeReason = diverted;
      if (strict) throw new DbCompileError('JD0010',
        `strict mode refused a residual: '${diverted.construct}' — ${diverted.reason}`);
      if (profile?.refuseFullScan) throw profileEntityRefusal(
        'the profile refuses the decoded scan required by the external binding', '/entities');
      return runResidual(entry, document, externals);
    }
    const params = entry.slots.map((slot) => slotValue(slot, externals));
    return useRead(connection, entry, (statement) => chain(guardEntityScan(entry), () => {
      if (entry.planned.plan.scalarAggregate) return chain(statement.get(params), (row) => {
        admittedRows(entry, row ? [row] : []);
        if (row?._valid === 0) throw new DbRuntimeError('JD2003', 'an aggregate column refuses a lossy or invalid value');
        if (row?._nulls > 0) throw aggregateNullError();
        if (row?._safe === 0) {
          entry.runtimeReason = { construct: 'aggregate', reason: BIND_REASONS.accumulation };
          if (strict) throw new DbCompileError('JD0010', entry.runtimeReason.reason);
          if (profile?.refuseFullScan) throw profileEntityRefusal('the profile refuses the decoded scan required by integer accumulation', '/entities');
          return runResidual(entry, document, externals);
        }
        return wrapValue(entry, row?.value ?? (entry.planned.plan.aggregate === 'sum' ? 0 : undefined));
      });
      if (entry.planned.plan.aggregate === 'count')
        return chain(statement.get(params), (row) => {
          admittedRows(entry, row ? [row] : []);
          return wrapValue(entry, countedValue(entry.planned.plan, row));
        });
      return chain(statement.all(params), (rows) => {
        admittedRows(entry, rows);
        checkRows(entry, rows, entry.planned.referenced[0]);
        if (entry.planned.plan.group) {
          const group = entry.planned.plan.group;
          if (rows.some((row) => row._valid === 0))
            throw new DbRuntimeError('JD2003', 'a grouped physical column refuses a lossy or invalid value');
          if (rows.some((row) => group.aggregates.some((aggregate, i) => aggregate.countsNulls && row[`_nulls${i}`] > 0)))
            throw aggregateNullError();
          if (rows.some((row) => group.aggregates.some((aggregate, i) =>
            ['sum', 'avg'].includes(aggregate.fn) && row[`_safe${i}`] !== 1))) {
            entry.runtimeReason = { construct: '$groupby', reason: BIND_REASONS.accumulation };
            if (strict) throw new DbCompileError('JD0010', entry.runtimeReason.reason);
            if (profile?.refuseFullScan) throw profileEntityRefusal(
              'the profile refuses the decoded scan required by the integer accumulation bound', '/entities');
            return runResidual(entry, document, externals);
          }
          return answerOf(entry, groupItems(group, rows)
            .map((row) => checkBytes(entry, row, entry.planned.referenced[0])));
        }
        const project = entry.planned.plan.project;
        if (project != null) {
          return answerOf(entry,
            rows.flatMap((row) => projectedTreeItems(project, row, 'p'))
              .map((row) => checkBytes(entry, row, entry.planned.referenced[0])));
        }
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
      if ('external' in slot && slot.list === true) {
        if (entry.predicateOnly.has(slot.external) || listBindable(externals[slot.external], exactIntegers, dialect)) continue;
        return { construct: 'external', reason: BIND_REASONS.external(slot.external, 'root') };
      }
      // the profile predicate's own externals were admitted before any
      // statement ({@link admitPredicates}): each binds as it is
      if ('external' in slot && entry.predicateOnly.has(slot.external)) continue;
      // a JSON-encoded external crosses as text whatever it holds, so what
      // decides is the value the caller gave; a null compares as the
      // column's own null on either engine
      const json = 'external' in slot && slot.json === true;
      const value = json ? externals[slot.external] : slotValue(slot, externals);
      if (bindable(value, exactIntegers && 'external' in slot, dialect, json)
        || ((slot.nullable === true || json) && value === null)) continue;
      const name = 'external' in slot ? slot.external
        : 'derived' in slot ? (slot.derived.kind === 'bboxAxis' ? slot.derived.external
          : [slot.derived.centre, slot.derived.radius].find((input) => 'external' in input)?.external) : null;
      return { construct: 'external', reason: BIND_REASONS.external(name, 'root') };
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
    if (entry.planned.mode === 'native' && externals !== null) {
      const diverted = divertReason(entry, externals);
      if (diverted !== null) return buffered(diverted);
    }
    if (entry.planned.wrapped === true) {
      return buffered({ construct: 'window', reason: BIND_REASONS.wrappedWindow });
    }
    if (entry.planned.plan?.group)
      return buffered({ construct: '$groupby', reason: BIND_REASONS.entityGroupWhole });
    if (entry.planned.mode !== 'native') {
      const forcing = entry.planned.reasons[0]
        ?? { construct: 'residual', reason: BIND_REASONS.untranslated };
      return buffered({ construct: forcing.construct, reason: forcing.reason });
    }
    // `null` externals is the abstract question: the plan as planned
    const diverted = externals === null ? null : divertReason(entry, externals);
    if (diverted !== null) return buffered(diverted);
    // past its exactness bound a whole sum or average is answered by the
    // engine over the fetched root, which the cursor then holds whole — as
    // a collection's is
    const scalar = entry.planned.plan?.scalarAggregate;
    if (scalar && ['sum', 'avg'].includes(scalar.fn))
      return buffered({ construct: `$${scalar.fn}`, reason: BIND_REASONS.accumulationWhole });
    return rowClassOf(connection);
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
  const query = (document, options = undefined, register = undefined, cursorFactory = createCursor) => {
    readCallOptions(options, ENTITY_CURSOR_OPTIONS, 'entity cursor()');
    refuseNonDocument(document, 'entity cursor()');
    requireCallable(options, state.now);
    const { externals, strict, pushdown, profile } = callState(options);
    const entry = entryFor(document, pushdown, profile);
    refuseOpaqueExternals(entry.compared, externals, 'entity cursor()');
    admitPredicates(entry, externals);
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
    entry.runtimeReason = null;
    const classified = cursorClass(entry, externals);
    if (classified.barrier?.construct === 'external') {
      entry.admitted = { statements: 0, rows: 0, bytes: 0 };
      entry.runtimeReason = classified.barrier;
      if (strict) throw new DbCompileError('JD0010',
        `strict mode refused a residual: 'external' — ${classified.barrier.reason}`);
      if (profile?.refuseFullScan) throw profileEntityRefusal(
        'the profile refuses the decoded scan required by the external binding', '/entities');
    }
    refuseBuffered(options, classified, entities.get(entry.planned.retEntity ?? '')?.docPath);
    const signal = options?.signal;
    const deadline = options?.deadline;
    if (entry.planned.wrapped === true || entry.planned.plan?.group || entry.planned.plan?.scalarAggregate) {
      return cursorFactory({ ...classified, signal, deadline, now: state.now, wrap: driverWrap,
        materialize: () => chain(run(document, options), (value) => entry.planned.wrapped === true
          ? [value] : value === undefined ? [] : Array.isArray(value) ? value : [value]) });
    }
    if (classified.barrier !== null) {
      return cursorFactory({ ...classified, signal, deadline, now: state.now, wrap: driverWrap,
        materialize: () => {
          entry.admitted = { statements: 0, rows: 0, bytes: 0 };
          return chain(fetchRoot(entry, externals), (root) => packedResidualOf(entry, document)(root, externals).map(each));
        } });
    }
    const params = entry.slots.map((slot) => slotValue(slot, externals));
    // the statement is prepared by the first PULL, not here: a root
    // cursor's construction touches no connection, so it can be handed
    // back before the pull is admitted (MODEL-FORMAT §5.1)
    if (entry.planned.plan.aggregate === 'count') {
      return cursorFactory({ ...classified, signal, deadline, now: state.now, wrap: driverWrap,
        materialize: () => chain(guardEntityScan(entry), () => useRead(connection, entry, (statement) =>
          chain(statement.get(params), (row) => {
            entry.admitted = { statements: 0, rows: 0, bytes: 0 };
            admittedRows(entry, row ? [row] : []);
            return [countedValue(entry.planned.plan, row)];
          }))) });
    }
    const rowEntity = entry.planned.plan.ret === null ? null
      : entry.planned.plan.bindings
        .find((binding) => binding.name === entry.planned.plan.ret).entity;
    let pulledRows = 0;
    // a statement of its own per cursor: two live iterators over one
    // cached statement invalidate each other at the driver
    return cursorFactory({ ...classified, signal, deadline, now: state.now, wrap: driverWrap,
      open: () => {
        entry.admitted = { statements: 1, rows: 0, bytes: 2 };
        return chain(guardEntityScan(entry), () => chain(connection.prepare(entry.sql, { readOnly: true, ephemeral: true }),
          (statement) => statement.iterate(params)));
      },
      items: (row) => {
        pulledRows++;
        entry.admitted.bytes += utf8ByteLength(JSON.stringify(row)) + (entry.admitted.rows ? 1 : 0);
        entry.admitted.rows++;
        if (entry.rowBound !== null && pulledRows > entry.rowBound) {
          throw new DbRuntimeError('JD2007',
            `the fetch crossed the profile's maxRows bound of ${entry.rowBound}`,
            { docPath: entities.get(rowEntity)?.docPath, collection: rowEntity });
        }
        const project = entry.planned.plan.project;
        if (project != null) return projectedTreeItems(project, row, 'p')
          .map((item) => checkBytes(entry, item, entry.planned.referenced[0]));
        return [each(checkBytes(entry, mergeEntityRow(mapping.entities[rowEntity], row, '__doc'), rowEntity))];
      } });
  };

  const explain = (document, options = undefined) => {
    // the options of the call it explains, an execute's or a cursor's
    readCallOptions(options, ENTITY_CURSOR_OPTIONS, 'entity explain()');
    refuseNonDocument(document, 'entity explain()');
    const { externals, pushdown, profile, profileSource } = callState(options);
    const entry = entryFor(document, pushdown, profile);
    refuseOpaqueExternals(entry.compared, externals, 'entity explain()');
    // bound against the externals it was given: a value the database
    // cannot take sends the run to the residual over the fetched root,
    // and that is the mode reported, with the diversion named first; no
    // externals at all is the abstract plan, as it always was
    const classified = cursorClass(entry, options?.externals ?? null);
    const diverted = entry.planned.mode === 'native' && classified.barrier !== null
      && classified.barrier.construct === 'external';
    // the last run's own finding — an aggregate that outgrew its exact
    // range — stands until a run clears it; whether an external diverts
    // is a question of the externals THIS call binds, so an earlier
    // call's diversion is not carried into it
    const runtime = entry.runtimeReason?.construct === 'external' ? null : entry.runtimeReason;
    const mode = diverted || runtime ? 'set' : entry.planned.mode;
    // a residual run fetches every root it reads, so explaining one given
    // externals refuses what that fetch refuses
    if (options?.externals !== undefined) admitPredicates(entry, externals);
    const reasons = runtime ? [runtime, ...entry.planned.reasons] : diverted && classified.barrier !== null
      ? [classified.barrier, ...entry.planned.reasons] : entry.planned.reasons;
    const base = {
      mode,
      streaming: classified.streaming,
      barrier: runtime ?? classified.barrier,
      budget: budgetOf(profile, profileSource, connection.capabilities),
      wrapped: entry.planned.wrapped === true,
      referenced: [...entry.planned.referenced],
      admitted: entry.admitted === null ? null : { ...entry.admitted },
      reasons,
      // the same effective-order vocabulary the collection engine and
      // the graph loader report; `null` when no statement answers
      order: mode === 'native' ? planOrder(entry.planned.plan) : null,
      sql: mode === 'native' ? entry.sql : null,
      residual: mode === 'native'
        ? null
        : { mode: 'set', reasons },
    };
    if (mode !== 'native') return base;
    const params = entry.slots.map((slot) => ('literal' in slot ? slot.literal : null));
    // an external binds NULL here whatever the call gave, so only a plan
    // of literals is priced: the planner would price a different statement
    const priced = entry.slots.every((slot) => 'literal' in slot);
    return chain(priced ? estimateOf(connection, dialect, entry.sql, params) : null, (estimate) =>
      useStatementOnce(connection, dialect.explainQuery(entry.sql), (statement) =>
        chain(statement.all(params), (rows) => ({
          ...base,
          budget: budgetOf(profile, profileSource, connection.capabilities, estimate),
          // the join graph, in the order the FROM clause builds it: the
          // first binding, then each one and the equalities that attached
          // it. Empty for a single-binding plan
          joins: entry.planned.plan.joins,
          scanNarrative: dialect.explainLines(rows).join('; '),
        })), { readOnly: true }));
  };

  return { execute: bounded(execute, driverWrap), query,
    syncQuery: (document, options, register) => query(document, options, register, createSyncCursor),
    explain: bounded(explain, driverWrap), relations, predicateLeaves: profileLeaves };
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
  const roots = context.roots ?? [...entities.keys()];
  /** Every driver failure this loader meets, classified under its entity. */
  const driverWrap = (/** @type {any} */ error) =>
    wrapDriverError(error, { docPath: '/entities', collection: entityName });
  // the entity core's column encoding (booleans to integers, an epoch
  // column's string to its epoch): what a continuation's DOCUMENT values
  // bind as when the keyset compares them with the stored columns
  const encodeColumn = context.coreFor === undefined
    ? (/** @type {string} */ column, /** @type {any} */ value) => value
    : (column, value) => context.coreFor(entityName).plan.columnValue(column, value);
  // a registered operator (Ring 2) is recognised as vocabulary so a
  // where/orderBy that uses one refuses cleanly (JD0032 — the load path
  // is all-SQL, with no residual), never as an unknown operator
  const analyzeOpts = state.operators ?? undefined;
  const dialect = connection.dialect;
  const q = dialect.quoteIdentifier;

  const refuse = (reason, path) => new DbCompileError('JD0032',
    `${reason} (include path: ${path.join('.') || '<root>'})`,
    entities.get(entityName)?.docPath);
  /** One node of a load specification: a plain object of the members
   * that node reads, so a misspelt filter refuses instead of loading
   * every row. @param {any} spec @param {readonly string[]} members
   * @param {string[]} path */
  const readSpec = (spec, members, path) => {
    if (!isPlainOptions(spec)) {
      throw refuse(`a load specification is a plain object${path.length === 0 ? ''
        : ' (or true, for an include taken whole)'}`, path);
    }
    refuseUnknownMembers(spec, members, (key, hint) =>
      refuse(`the load specification has no member '${key}'${hint}`, path));
  };
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
    // a load has no engine path to answer a literal the database would
    // read as another string
    if (bindsLoneSurrogate(planned.filter))
      throw refuse(`the where expression is not translatable: ${LONE_SURROGATE_REFUSAL}`, path);
    if (bindsUnheldText(dialect, planned.filter))
      throw refuse(`the where expression is not translatable: ${UNHELD_TEXT_REFUSAL}`, path);
    // a load binds no externals: a where that names one would reach the
    // driver as an unbound parameter
    const external = externalOf(planned.filter);
    if (external !== null) {
      throw refuse(`the where expression names the external '$${external}', and a load binds none — `
        + 'spell the value into the where, or query it through execute() with externals', path);
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
    if (bindsUnheldText(dialect, predicate))
      throw profileEntityRefusal(uncarriedPredicate(name), entities.get(name)?.docPath);
    // the profile's predicate binds as the load's own where does: an
    // external it names has no value here, and would reach the driver as
    // an unbound parameter
    const external = externalOf(predicate);
    if (external !== null) {
      throw refuse(`the profile's predicate for '${name}' names the external '$${external}', and a load `
        + 'binds none — run the read through execute() with externals, or spell the value into the predicate', path);
    }
    return { ...node, where: conjoin(node.where, predicate) };
  };

  /**
   * The planner's shape of an entity, with the mapped columns a load may
   * order by admitted: a column the planner keeps out of native predicates
   * (`unsafe` — a native uuid compared against a literal of another case
   * would match where the engine does not) still orders a load where SQL
   * orders the column as the engine orders its decoded value, which
   * {@link physicalOrderable} answers per codec and engine. Predicates
   * keep the planner's own shape.
   * @param {any} shape
   */
  const orderableShape = (shape) => {
    const entityFlavors = new Map();
    for (const [canonical, flavor] of shape.entityFlavors) {
      entityFlavors.set(canonical, flavor.unsafe === true && flavor.codecColumn !== undefined
        && physicalOrderable(flavor.codecColumn, dialect).explicit ? { ...flavor, unsafe: false } : flavor);
    }
    return { ...shape, entityFlavors };
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
    const shape = orderableShape(entityShape(entity, mapping.entities[entity.name]));
    const terms = [];
    for (const spec of flwor.orderby.specs) {
      const ref = entityPathRef(spec.key, slot, shape);
      if (ref === null || (ref.flavor === 'entity-doc' && ref.type === 'unknown'))
        throw refuse('orderBy must address typed entity paths', path);
      // the engine compares no number with a string, and a load has no
      // residual to leave such an ordering to
      if (admitsMixedTypes(shape.schema, ref.segments)) {
        throw refuse(`orderBy must address typed entity paths of one type — '${modelPath(ref.segments)}' `
          + 'declares several, and the engine does not order one against another', path);
      }
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
    if (!isPlainOptions(includeSpec))
      throw refuse('include is a plain object from relation names to their specifications', path);
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
      readSpec(childSpec, INCLUDE_LOAD_MEMBERS, [...path, relationName]);
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
        // the include's own declaration cannot exceed (refused, not
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
        // a count counts the related rows the caller may see: the child
        // entity's allow-list and mandatory predicate bind it as they bind
        // the rows
        countWhere: childSpec.count === true
          ? applyProfileToNode({ where: null }, childName, profile, [...path, relationName]).where
          : null,
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
      // EMBEDDED, not rendered: the enclosing object carries the
      // document as a nested JSON value, which on an engine with one
      // JSON type is the column itself and on SQLite is `json()`
      parts.push(`${slText('__doc')}, ${dialect.jsonEmbed(docSql)}`);
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
      const childKey = mapping.entities[relation.to].keys[0];
      // the profile's predicate over the child entity, when it has one
      const profiled = include.countWhere === null ? ''
        : ` AND ${emitters.emitPred(q(childAlias), `${q(childAlias)}.${q('doc')}`, include.countWhere)}`;
      if (relation.kind === 'manyToMany') {
        const join = mapping.joinTables[relation.joinTable];
        const own = join.left.entity === parentNode.entity.name ? join.left : join.right;
        // the links alone say how many there are; the child's rows are
        // read only to hold them to the predicate
        if (include.countWhere === null) {
          return `(SELECT COUNT(*) FROM ${q(relation.joinTable)} AS ${q(childAlias)} `
            + `WHERE ${q(childAlias)}.${q(own.column)} = ${q(parentAlias)}.${q(parentKey)})`;
        }
        return `(SELECT COUNT(*) FROM ${q(childTable)} AS ${q(childAlias)} `
          + `JOIN ${q(relation.joinTable)} AS ${q(`${childAlias}_j`)} `
          + `ON ${q(`${childAlias}_j`)}.${q(`${relation.to}_key`)} = ${q(childAlias)}.${q(childKey)} `
          + `WHERE ${q(`${childAlias}_j`)}.${q(`${parentNode.entity.name}_key`)} = ${q(parentAlias)}.${q(parentKey)}${profiled})`;
      }
      if (relation.kind === 'oneToOne') {
        return `(SELECT COUNT(*) FROM ${q(childTable)} AS ${q(childAlias)} `
          + `WHERE ${q(childAlias)}.${q(childKey)} = ${q(parentAlias)}.${q(relation.via)}${profiled})`;
      }
      return `(SELECT COUNT(*) FROM ${q(childTable)} AS ${q(childAlias)} `
        + `WHERE ${q(childAlias)}.${q(relation.via)} = ${q(parentAlias)}.${q(parentKey)}${profiled})`;
    }
    const child = include.child;
    const childTable = child.entityMapping.table;
    const childKey = child.entityMapping.keys[0];
    const rendered = render(child, childAlias, param, emitters);
    // the nested relations sit in the subquery's select list, before its
    // own filter in the text, so they take their values first
    const projection = rendered.projection();
    // the filter is emitted once: each emission takes its own values
    const filter = child.where === null ? null
      : emitters.emitPred(rendered.aliasSql, rendered.docSql, child.where);
    const conditions = [];
    if (relation.kind === 'oneToMany') {
      conditions.push(`${q(childAlias)}.${q(relation.via)} = ${q(parentAlias)}.${q(parentKey)}`);
    }
    else if (relation.kind === 'oneToOne') {
      conditions.push(`${q(childAlias)}.${q(childKey)} = ${q(parentAlias)}.${q(relation.via)}`);
    }
    if (filter !== null) conditions.push(filter);
    const orderSql = (child.order ?? []).map((term) => {
      // epoch paths order by the document string (codepoint = the
      // engine's order); only plain mapped columns order natively, and
      // any other document member orders as its declared type
      const value = term.ref.flavor === 'entity-column'
        ? `${rendered.aliasSql}.${q(term.ref.column)}`
        : documentMemberOf(dialect, rendered.docSql, term.ref);
      const nullsFirst = term.emptyGreatest === term.desc;
      return `${value} ${term.desc ? 'DESC' : 'ASC'}${dialect.orderNulls(nullsFirst)}`;
    });
    orderSql.push(`${rendered.aliasSql}.${rowIdentityOf(dialect, child.entityMapping)}`);
    const inner = relation.kind === 'manyToMany'
      ? `SELECT ${rendered.aliasSql}.* FROM ${q(childTable)} AS ${q(childAlias)} `
        + `JOIN ${q(relation.joinTable)} AS ${q(`${childAlias}_j`)} `
        + `ON ${q(`${childAlias}_j`)}.${q(`${relation.to}_key`)} = ${q(childAlias)}.${q(childKey)} `
        + `WHERE ${q(`${childAlias}_j`)}.${q(`${parentNode.entity.name}_key`)} = ${q(parentAlias)}.${q(parentKey)}`
        + (filter !== null ? ` AND ${filter}` : '')
        + ` ORDER BY ${orderSql.join(', ')}`
        + windowClause(child)
      : `SELECT ${rendered.aliasSql}.* FROM ${q(childTable)} AS ${q(childAlias)} `
        + `WHERE ${conditions.join(' AND ')} ORDER BY ${orderSql.join(', ')}`
        + windowClause(child);
    if (relation.kind === 'oneToOne') {
      return `(SELECT ${dialect.jsonObject(projection)} FROM `
        + `(${inner} ${dialect.limitClause(1, undefined)}) AS ${q(childAlias)})`;
    }
    return `(SELECT ${dialect.jsonAgg(dialect.jsonObject(projection))} `
      + `FROM (${inner}) AS ${q(childAlias)})`;
  };

  /**
   * The ordering's IDENTITY in keyset mode: the declared column terms
   * with their direction and null placement, then the primary-key
   * column(s) not already named, ascending — the tie-breaker the plan
   * appends whether or not the caller named it, since the key is the
   * one column guaranteed unique. A document-path term cannot carry a
   * keyset (`JD0032`).
   *
   * One identity model: a term's `column` is the PROPERTY — what a
   * document, a continuation and the column encoding name — and the SQL
   * reaches its physical column through {@link columnOfProperty}. On a
   * managed entity the two are one name, so its continuations are
   * unchanged. A term that resumes from the text its table stores (a
   * SQLite uuid, which an entity decodes to lowercase whatever case the
   * table holds) carries `stored: true`, so a continuation emitted for
   * the decoded reading of the column belongs to no such ordering.
   * @param {any[]} order - the compiled order terms
   * @param {readonly string[]} keyColumns - the key properties
   * @param {(physical: string) => any} columnOfPhysical
   * @param {(property: string) => boolean} stored - whether a property resumes from its stored text
   * @returns {{ column: string, desc: boolean, nullsFirst: boolean, stored?: true }[]}
   */
  const orderIdentity = (order, keyColumns, columnOfPhysical, stored) => {
    const termOf = (/** @type {string} */ column, /** @type {boolean} */ desc, /** @type {boolean} */ nullsFirst) =>
      (stored(column) ? { column, desc, nullsFirst, stored: true } : { column, desc, nullsFirst });
    const terms = order.map((term) => {
      if (term.ref.flavor !== 'entity-column') {
        throw refuse('a keyset orders by mapped columns — '
          + `'${modelPath(term.ref.segments)}' is a document path`, []);
      }
      return termOf(columnOfPhysical(term.ref.column)?.name ?? term.ref.column, term.desc,
        term.emptyGreatest === term.desc);
    });
    for (const column of keyColumns) {
      // a key column is NOT NULL: `nullsFirst` is SQLite's own ASC
      // default, spelled so the identity is explicit, never a branch
      if (!terms.some((term) => term.column === column))
        terms.push(termOf(column, false, true));
    }
    return terms;
  };

  /**
   * A structural continuation, checked against THIS ordering: the
   * `{ order, keys, key }` a page emitted, whose `order` must be this
   * graph's identity exactly — a continuation replayed against another
   * ordering is `JD0035`, never a wrong page — and whose values are
   * returned aligned with the identity, encoded as the columns store them
   * (a `stored` term's text, as it stands: encoding it would lowercase a
   * uuid the table holds in another case).
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
    const spell = (terms) => terms.map((term) => `${term?.column} ${term?.desc ? 'desc' : 'asc'}`
      + `${term?.nullsFirst ? ' nulls first' : ''}${term?.stored === true ? ' stored' : ''}`).join(', ');
    if (after === null || typeof after !== 'object' || !Array.isArray(after.order)
      || !Array.isArray(after.keys) || !('key' in after)) {
      throw mismatch('a continuation is the { order, keys, key } value a page emitted');
    }
    // the same terms, whatever order a serializer kept their members in
    // (PostgreSQL's jsonb sorts them by length): a continuation a host stored
    // and read back is the one it was handed
    const sameTerms = after.order.length === identity.length && identity.every((term, i) => {
      const other = after.order[i];
      const members = other !== null && typeof other === 'object' ? Object.keys(other) : [];
      return members.length === Object.keys(term).length
        && members.every((member) => Object.hasOwn(term, member) && other[member] === term[member]);
    });
    if (!sameTerms) {
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
    return identity.map((term, i) => {
      const value = i < declared ? (after.keys[i] ?? null) : keyOf(term.column);
      if (term.stored !== true) return encodeColumn(term.column, value);
      if (typeof value !== 'string') throw mismatch(`'${term.column}' resumes from its stored text`);
      return value;
    });
  };

  /**
   * Build the load: one statement, cached by spec, a continuation's values
   * aside (the call binds those: {@link afterIdentity}). `keyset` forces
   * keyset mode — the primary key as the ORDER BY tie-breaker in place of
   * the row identity, so a continuation can resume exactly — which a
   * structural `after` implies; a scalar `after` keeps the single
   * unique-column keyset it always was.
   * @param {any} spec
   * @param {boolean} [keyset]
   */
  const compileLoad = (spec, keyset = false, profile = null) => {
    // a cyclic specification cannot be keyed, so the cache reports a
    // permanent miss and buildTree gets to NAME the cycle. A continuation's
    // values are not part of the key: every page of a walk resumes from
    // different ones and shares the statement their shape selects
    const resumed = afterIdentity(spec);
    const key = resumed === null ? ['L', entityName, spec ?? {}, dialect.name, keyset, profile]
      : ['L', entityName, resumed.spec, dialect.name, keyset, profile, resumed.shape];
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
    const physicalEntity = entities.get(entityName)?.physical != null;
    const tree = buildTree(entityName, spec ?? {}, 0, maxDepth, [], new Set(), profile);
    // one load is one statement: every node's filter, the profile's
    // predicate conjoined, counts against the dialect's term bound, and
    // past it the load — which has no engine path — refuses by name
    if (dialect.maxPredicateTerms !== null) {
      const treeTerms = (/** @type {any} */ node) => predicateTerms(node.where)
        + node.includes.reduce((/** @type {number} */ sum, /** @type {any} */ include) =>
          sum + predicateTerms(include.countWhere) + (include.child === null ? 0 : treeTerms(include.child)), 0);
      if (treeTerms(tree) > dialect.maxPredicateTerms) {
        throw refuse(`the where expression is not translatable: ${PLANNER_REASONS['predicate.termBound'].text}; `
          + 'execute() answers it in the engine', []);
      }
    }
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
    // a structural one — or a page — is the composite keyset over the
    // declared terms with the primary key appended: one row value where
    // every term cannot hold NULL and shares one direction, which the
    // key's index seeks, else the lexicographic expansion with null
    // placement agreeing with the ORDER BY (§10.5)
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
    // one identity model (orderIdentity): a property's mapped column, and
    // the property a physical column name belongs to
    const mappedColumns = tree.entityMapping.columns;
    const columnOfProperty = (/** @type {string} */ property) => mappedColumns.find((c) => c.name === property);
    const columnOfPhysical = (/** @type {string} */ physical) => mappedColumns.find((c) => (c.physical ?? c.name) === physical);
    const propertyOfPhysical = (/** @type {string} */ physical) => columnOfPhysical(physical)?.name ?? physical;
    /**
     * Whether a property resumes a keyset from the text its table stores,
     * not from its decoded value (physicalOrderable answers per codec and
     * engine): a SQLite uuid.
     * @param {string} property
     */
    const storedSpelling = (property) => {
      const column = physicalEntity ? columnOfProperty(property) : undefined;
      return column !== undefined && physicalOrderable(column, dialect).stored;
    };
    /**
     * What a term compares and orders by: its physical column, compared as
     * its codec compares — a mapped text column in codepoint order whatever
     * collation the table declared, the order `execute()` gives it. The
     * column itself goes with the comparison: a dialect may spell the bare
     * column for a term a load orders or seeks by (a native uuid, a text
     * column collated by code point), which no predicate, join edge or
     * grouping asks for.
     * @param {string} property
     */
    const termSql = (property) => {
      const column = columnOfProperty(property);
      const sql = `${rendered.aliasSql}.${q(column?.physical ?? column?.name ?? property)}`;
      return physicalEntity && column !== undefined ? physicalComparable(column, sql, dialect, column) : sql;
    };
    // the per-row proof that a text key survives its text encoding is
    // SQLite's (textKeyPlan reads the raw bytes beside the key): a typed
    // engine returns UTF8 text exactly, and its encoding is checked at open
    const provesTextBytes = physicalEntity && dialect.name === 'sqlite';
    /**
     * A keyset over a physical table is qualified where a continuation
     * resumes exactly (physicalOrderable): over integer, bigint, text and
     * uuid columns, a uuid the SQLite table stores in another case than
     * the entity decodes carrying its stored text. A text key proves it
     * round-trips per row on SQLite; where no such proof runs, the
     * database's encoding must be UTF8, from which every stored text
     * decodes exactly. Anything else is refused by name.
     * @param {string[]} properties
     */
    const requirePhysicalKeyset = (properties) => {
      if (!physicalEntity) return;
      // a view enforces no key: two rows can carry the declared one, and a
      // continuation past that value would skip the second
      if (tree.entityMapping.kind === 'view') {
        throw refuse('a keyset continuation over a view is not qualified: a view enforces no '
          + 'primary key, so two rows can share the declared key and a page past one would skip '
          + 'the other — load the view whole, or page the table it reads', []);
      }
      for (const property of properties) {
        const column = columnOfProperty(property);
        if (column === undefined || !physicalOrderable(column, dialect).keyset) {
          throw refuse(`a keyset continuation over a physical table orders by integer, bigint, text and uuid `
            + `columns; '${property}' is a ${column?.codec} column, whose decoded value need not compare `
            + 'as its stored one does', []);
        }
        if (column.codec === 'text' && !provesTextBytes && column.databaseEncoding !== 'UTF8') {
          throw refuse(`a keyset continuation over the text column '${property}' requires the UTF8 database `
            + 'encoding, from which every stored text decodes exactly; this database\'s encoding is '
            + `${column.databaseEncoding ?? 'not recorded'}`, []);
        }
      }
    };
    /** @type {ReturnType<typeof orderIdentity> | null} */
    let identity = null;
    /** The values a call's `after` binds, checked against this ordering; `null` without one.
     * @type {((given: any) => any[]) | null} */
    let afterValues = null;
    /** @type {ReturnType<typeof textKeyPlan>} */
    let textKeys = null;
    if (keysetMode) {
      identity = orderIdentity(order, keyColumns, columnOfPhysical, storedSpelling);
      requirePhysicalKeyset(identity.map((term) => term.column));
      if (provesTextBytes) {
        textKeys = textKeyPlan(tree.entityMapping, identity.map((term) => columnOfProperty(term.column)),
          dialect, `${rendered.aliasSql}.`);
      }
      if (after !== undefined) {
        if (!structural) {
          throw new DbCompileError('JD0035',
            'the continuation does not belong to this ordering: a page resumes from the '
            + '{ order, keys, key } value a page emitted, not a bare key',
            entities.get(entityName)?.docPath);
        }
        pagination = 'keyset';
        afterValues = (given) => continuationValues(given, identity, order.length, keyColumns);
        const values = afterValues(after);
        const column = (/** @type {any} */ term) => termSql(term.column);
        // a term that cannot hold NULL: a key column, or a mapped column the
        // catalog declares NOT NULL (recorded at open, whatever policy the
        // model declares); a managed entity's declared columns can
        const notNull = (/** @type {any} */ term) => keyColumns.includes(term.column)
          || (physicalEntity && columnOfProperty(term.column)?.notNull === true);
        if (identity.length > 1 && identity.every((term, i) => notNull(term) && values[i] !== null
          && term.desc === identity[0].desc)) {
          // one direction over terms that cannot hold NULL: the row value
          // `(t1, ..., tn) > (?, ..., ?)` is exactly the expansion below,
          // and the key's index seeks it. A NULL element would make the
          // comparison neither true nor false, so a term that can hold one
          // keeps the expansion, where its null branch is spelled out
          const columns = identity.map((term) => column(term));
          const bound = identity.map((_, i) => param({ continuation: i }));
          conditions.push(`(${columns.join(', ')}) ${identity[0].desc ? '<' : '>'} (${bound.join(', ')})`);
        }
        else {
          const equal = (i) => (values[i] === null
            ? `${column(identity[i])} IS NULL`
            : `${column(identity[i])} = ${param({ continuation: i })}`);
          // "comes after the value in this term's order": a null value is
          // followed by the non-nulls when nulls sort first and by nothing
          // when they sort last; a non-null value is followed by the greater
          // (or lesser, descending) values, and by the nulls when they sort
          // last — the comparison alone would drop them, since SQL's
          // `col > ?` is neither true nor false for NULL
          const beyond = (i) => {
            const term = identity[i];
            if (values[i] === null) return `${column(term)} IS NOT NULL`;
            const base = `${column(term)} ${term.desc ? '<' : '>'} ${param({ continuation: i })}`;
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
    }
    else if (after !== undefined) {
      const term = order.length === 1 ? order[0] : null;
      const property = term === null ? '' : propertyOfPhysical(term.ref.column);
      if (term === null || term.ref.flavor === 'entity-doc' || !uniqueColumns.has(property)) {
        throw refuse("'after' (keyset pagination) needs a single orderBy over a unique column", []);
      }
      requirePhysicalKeyset([property]);
      // a unique column that may hold NULL (a member the model declares
      // nullable or does not require; a key never does) holds many of them,
      // and a value positions no row among them: ordered with its NULLs
      // after its values, the cursor's comparison would never visit them, so
      // it is refused where page() carries the placement
      const member = entities.get(entityName);
      if (!keyColumns.includes(property) && term.emptyGreatest !== term.desc
        && (member?.properties?.get(property)?.nullable === true || !(member?.schema?.required ?? []).includes(property))) {
        throw refuse(`'after' (keyset pagination) cannot resume past '${property}': the column may hold NULL and `
          + 'this ordering sorts its NULLs after its values, which a single value cannot reach — page() '
          + 'carries the null placement in its continuation', []);
      }
      // the caller seeks past the last row's value: a text key proves it
      // round-trips exactly as a continuation's does
      if (provesTextBytes) textKeys = textKeyPlan(tree.entityMapping, [columnOfProperty(property)], dialect, `${rendered.aliasSql}.`);
      pagination = 'keyset';
      afterValues = (given) => [physicalEntity ? encodeColumn(property, given) : given];
      afterValues(after);
      conditions.push(`${termSql(property)} ${term.desc ? '<' : '>'} ${param({ continuation: 0 })}`);
    }
    else if (spec?.skip !== undefined && spec.skip > 0) {
      pagination = 'offset';
    }

    let sql = `SELECT ${tree.entity.physical != null ? physicalSelection(tree.entityMapping, dialect, `${rendered.aliasSql}.`)
      : `${rendered.aliasSql}.*, ${tree.entityMapping.document === false ? dialect.stringLiteral('{}') : dialect.jsonText(rendered.docSql)} AS ${q('__doc')}`}`
      // a text identity's raw bytes, which every row read proves its key against
      + (textKeys === null ? '' : `, ${textKeys.projection}`)
      + includeSql
      + ` FROM ${dialect.tableName(tree.entityMapping.table, tree.entityMapping.schema)} AS ${rendered.aliasSql}`;
    if (conditions.length > 0) sql += ` WHERE ${conditions.join(' AND ')}`;
    const orderSql = identity !== null
      ? identity.map((term) => `${termSql(term.column)} `
        + `${term.desc ? 'DESC' : 'ASC'}${dialect.orderNulls(term.nullsFirst)}`)
      : order.map((term) => {
        // a document member orders as its declared type, as an include's
        // and a query's do: a string by code point, a JSON null and a
        // missing member as one empty key
        const value = term.ref.flavor === 'entity-column'
          ? termSql(propertyOfPhysical(term.ref.column))
          : documentMemberOf(dialect, rendered.docSql, term.ref);
        const nullsFirst = term.emptyGreatest === term.desc;
        return `${value} ${term.desc ? 'DESC' : 'ASC'}${dialect.orderNulls(nullsFirst)}`;
      });
    if (identity === null) orderSql.push(...(physicalEntity ? keyColumns.map((key) => termSql(key)) : [`${rendered.aliasSql}.${rowIdentityOf(dialect, tree.entityMapping)}`]));
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

    // the column holding each stored term's text, which a page reads off
    // every row before the entity decodes it
    const storedTerms = (identity ?? []).filter((term) => term.stored === true).map((term) => {
      const column = columnOfProperty(term.column);
      return { property: term.column, physical: column.physical ?? column.name };
    });

    const entry = {
      sql, slots, tree, pagination, statement: null,
      afterValues,
      rowBound,
      byteBound: profile === null ? null : profile.maxBytes,
      profile,
      identity: identity === null ? null : deepFreeze(identity),
      // the order the statement executes under, in the vocabulary both
      // query engines report: the declared terms by PROPERTY and the
      // tie-breaker the ORDER BY above appends — the primary key in keyset
      // mode and over a physical table, the row identity otherwise. Built
      // from the same normalized terms, so the explanation cannot drift
      // from the clause
      effective: deepFreeze(effectiveOrder(order.map((term) => (ordersByColumn(term.ref)
        ? { ...term, ref: { ...term.ref, column: propertyOfPhysical(term.ref.column) } } : term)),
        identity === null && !physicalEntity ? undefined : { keyColumns })),
      // the declared terms' PROPERTIES: what a continuation reads off a document
      declared: order.map((term) => propertyOfPhysical(term.ref.column)),
      keyColumns,
      textKeys,
      stored: storedTerms.length === 0 ? null : storedTerms,
      // a page over this ordering is a snapshot only when every order key
      // is immutable, and the primary key is the one column the engine
      // itself guarantees never moves (`update()` refuses to rewrite it)
      snapshot: identity === null ? null : identity.every((term) => keyColumns.includes(term.column)),
    };
    return retainEntry(state, key, entry);
  };
  /**
   * {@link compileLoad}, for every load surface. A graph load runs in the
   * database alone, so a member name the dialect's path grammar cannot
   * spell is refused by code instead of reaching a statement.
   * @param {any} spec
   * @param {boolean} [keyset]
   */
  const buildLoad = (spec, keyset = false, profile = null) => {
    if (spec !== undefined) readSpec(spec, ROOT_LOAD_MEMBERS, []);
    try {
      return compileLoad(spec, keyset, profile);
    }
    catch (error) {
      if (!(error instanceof UnrepresentablePath)) throw error;
      throw new DbCompileError('JD0032', 'a member name the dialect\'s JSON path grammar cannot carry '
        + '(a double quote or a control character) has no spelling in a graph load, which has no residual',
      entities.get(entityName)?.docPath, error);
    }
  };

  /**
   * {@link buildLoad}, and the values this call binds into the statement's
   * slots. A continuation's are checked against the ordering on a plan hit
   * exactly as on a miss: the plan is shared by every continuation of its
   * shape, the values never are.
   * @param {any} spec
   * @param {boolean} [keyset]
   * @param {any} [profile]
   */
  const bindLoad = (spec, keyset = false, profile = null) => {
    const entry = buildLoad(spec, keyset, profile);
    const values = entry.afterValues === null ? [] : entry.afterValues(spec.after);
    return { entry, params: entry.slots.map((/** @type {any} */ slot) =>
      ('continuation' in slot ? values[slot.continuation] : slot.literal)) };
  };

  /**
   * A graph load answers whole entity documents, and a member
   * allow-list cannot cover a whole document — so a policed root is
   * refused here rather than answered past its policy. The refusal
   * names the members that ARE allowed, because the document query
   * engine can project exactly those.
   * @param {any} profile
   */
  const refuseMemberPolicy = (profile) => {
    const policy = profile === null ? undefined : rootEntry(profile.members, entityName);
    if (policy === undefined) return;
    throw new DbCompileError('JD0011',
      `the profile allows only the members (${policy.declared.join(', ')}) of `
      + `'${entityName}', and a graph load answers whole documents — query the members `
      + 'the policy allows instead', entities.get(entityName)?.docPath);
  };

  /** One loaded root against the profile's row and byte bounds. */
  const checkRoot = (entry, doc, pulled) => {
    if (entry.rowBound !== null && pulled > entry.rowBound) {
      throw new DbRuntimeError('JD2007',
        `the load crossed the profile's maxRows bound of ${entry.rowBound}`,
        { docPath: entities.get(entityName)?.docPath, collection: entityName });
    }
    if (entry.byteBound !== null) {
      const bytes = utf8ByteLength(JSON.stringify(doc));
      if (bytes > entry.byteBound) {
        throw new DbRuntimeError('JD2076',
          `an item of ${bytes} serialised bytes exceeds the profile's maxBytes bound of ${entry.byteBound}`,
          { docPath: entities.get(entityName)?.docPath, collection: entityName });
      }
    }
    return doc;
  };
  /** The profile one call resolves, as on the query engines. */
  const profileOf = (options) => {
    const docPath = entities.get(entityName)?.docPath;
    const resolved = floorProfile(storeProfile, options?.profile, docPath ?? '/entities');
    assertProfileRoots(resolved, roots, docPath);
    refuseMemberPolicy(resolved);
    return resolved;
  };
  const profileSourceOf = (options) => (options?.profile !== undefined ? 'call'
    : (storeProfile === null ? null : 'store'));

  /** The connection's text decoding (physical.js), once it has been read:
   * the same answer for the connection's life. @type {any} */
  let textDecoding = null;
  const decodingOfText = () => textDecoding ?? chain(textKeyDecoding(connection), (decoding) => (textDecoding = decoding));
  /** A text key that does not survive its SQLite text encoding cannot be
   * sought past: refused before any continuation is built on it. @param {any} column */
  const refuseTextKey = (column) => refuse(`the text column '${column.name}' a continuation seeks by cannot `
    + 'round-trip through its SQLite text encoding, so the continuation would seek past the wrong rows', []);
  /** A row of a keyset read, its text identities proven and their byte
   * columns dropped. @param {any} entry @param {any} row */
  const provenRow = (entry, row) => (entry.textKeys === null ? row
    : checkTextKeys(row, entry.textKeys, textDecoding, refuseTextKey));
  /** The text each stored term held in the row an item was read from, by
   * item: the entity decodes it away, and a continuation resumes from it.
   * @type {WeakMap<object, Map<string, any>>} */
  const storedText = new WeakMap();

  /** The graph cursor over one built load: one root row per pull. */
  const openCursor = (entry, params, signal, register, deadline = undefined, cursorFactory = createCursor) => {
    const each = register === undefined ? (doc) => doc : (doc) => register(entry.tree, doc);
    let pulled = 0;
    // prepared by the first pull, never at construction (MODEL-FORMAT
    // §5.1), and a statement of this cursor's own: two live iterators
    // over one cached statement invalidate each other at the driver
    return cursorFactory({ ...rowClassOf(connection), signal, deadline, now: state.now, wrap: driverWrap,
      open: () => chain(entry.textKeys === null ? null : decodingOfText(), () =>
        chain(connection.prepare(entry.sql, { readOnly: true, ephemeral: true }), (statement) => statement.iterate(params))),
      items: (row) => {
        const item = each(checkRoot(entry, parseGraphRow(entry.tree, provenRow(entry, row), '__doc'), ++pulled));
        if (entry.stored !== null) {
          storedText.set(item, new Map(entry.stored.map(({ property, physical }) => [property, row[physical]])));
        }
        return [item];
      } });
  };

  /**
   * The continuation one root emits: unsigned, structural, opaque —
   * the ordering's identity (so it cannot be replayed against another
   * ordering), the declared order-key values as the DOCUMENT carries
   * them (a `stored` term's, as its row held it), and the row's primary
   * key, the tie-breaker. Signing, tenant scoping, expiry and wire
   * encoding are the host's: the store has no principal and no key, and
   * a signature it invented would be theatre.
   */
  const continuationOf = (entry, doc) => {
    const held = storedText.get(doc);
    const valueOf = (/** @type {string} */ column) => (held?.has(column) ? held.get(column) : doc[column]);
    return deepFreeze({
      order: entry.identity,
      keys: entry.declared.map((column) => valueOf(column) ?? null),
      key: entry.keyColumns.length === 1
        ? valueOf(entry.keyColumns[0])
        : Object.fromEntries(entry.keyColumns.map((column) => [column, valueOf(column)])),
    });
  };

  const surface = {
    treeFor(spec) {
      return buildLoad(spec).tree;
    },
    load(spec, options = undefined) {
      readCallOptions(options, LOAD_CALL_OPTIONS, `entity('${entityName}').load`);
      requireCallable(options, state.now);
      const { entry, params } = bindLoad(spec, false, profileOf(options));
      return useRead(connection, entry, (statement) => chain(entry.textKeys === null ? null : decodingOfText(), () =>
        chain(statement.all(params), (rows) =>
          rows.map((row, i) => checkRoot(entry, parseGraphRow(entry.tree, provenRow(entry, row), '__doc'), i + 1)))));
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
    loadCursor(spec, options = undefined, register = undefined, cursorFactory = createCursor) {
      readCallOptions(options, LOAD_CURSOR_OPTIONS, `entity('${entityName}').loadCursor`);
      requireCallable(options, state.now);
      const { entry, params } = bindLoad(spec, false, profileOf(options));
      return openCursor(entry, params, options?.signal, register, options?.deadline, cursorFactory);
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
     *   consistency?: 'live' | 'snapshot', signal?: AbortSignal, lookahead?: boolean }} [options]
     * @param {((tree: any, doc: any) => any) | undefined} [register]
     */
    page(spec, options = undefined, register = undefined, cursorFactory = createCursor) {
      // a page is a graph load: one native statement that binds no
      // externals and has no residual, so `externals`, `strict`,
      // `pushdown` and `strictStreaming` are not among what it reads
      readOptions(options, ['limit', 'after', 'maxBytes', 'consistency', 'signal', 'deadline', 'lookahead', 'profile'],
        'page()');
      readControls(options, 'page()');
      requireCallable(options, state.now);
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
      if (spec !== undefined) readSpec(spec, ROOT_LOAD_MEMBERS, []);
      if (spec?.take !== undefined || spec?.skip !== undefined)
        throw refuse('page() windows by its limit and continuation — a take or skip in the spec is refused', []);
      const after = options?.after ?? spec?.after ?? undefined;
      if (options?.lookahead !== undefined && typeof options.lookahead !== 'boolean')
        throw refuse('page() lookahead must be boolean', []);
      const paged = { ...(spec ?? {}), take: limit + (options?.lookahead === false ? 0 : 1) };
      if (after === undefined) delete paged.after;
      else paged.after = after;
      const { entry, params } = bindLoad(paged, true, profileOf(options));
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
      const cursor = openCursor(entry, params, options?.signal, undefined, options?.deadline, cursorFactory);
      return chain(drainPage(cursor, {
        limit, maxBytes, after: after ?? null, lookahead: options?.lookahead,
        sizeOf: (doc) => utf8ByteLength(JSON.stringify(doc)),
        continuationOf: (doc) => continuationOf(entry, doc),
      }), (page) => ({
        ...page,
        items: register === undefined ? page.items : page.items.map((doc) => register(entry.tree, doc)),
        snapshot: entry.snapshot === true,
      }));
    },
    explainLoad(spec, options = undefined) {
      readCallOptions(options, EXPLAIN_LOAD_OPTIONS, `entity('${entityName}').explainLoad`);
      const { entry, params } = bindLoad(spec, spec?.after !== undefined && typeof spec.after === 'object', profileOf(options));
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
      // priced first where the connection gives estimates: that is a
      // statement of its own over the values a load binds, so the answer
      // is a promise there and stays a plain value everywhere else
      return chain(estimateOf(connection, dialect, entry.sql, params), (estimate) => ({
        sql: entry.sql,
        pagination: entry.pagination,
        includes: describe(entry.tree, []),
        bounds: bounds(entry.tree, []),
        // the effective deterministic order the statement executes
        // under, in every load mode — a load outside keyset mode orders
        // by its declared terms and the row identity, and saying so is
        // not the same as having no order at all
        order: entry.effective,
        // the keyset ordering's IDENTITY, the value a continuation
        // carries and is checked against (`JD0035`) — `null` for a load
        // that is not in keyset mode, which has no continuation to emit
        identity: entry.identity,
        snapshot: entry.snapshot,
        // a graph load pulls one root row per statement row — where the
        // binding can hand rows over one at a time
        ...rowClassOf(connection),
        // the profile that applied and every bound it imposed
        budget: budgetOf(entry.profile, profileSourceOf(options), connection.capabilities, estimate),
      }));
    },
  };
  // the loader's members answer through the boundary: a driver failure
  // arrives classified, a coded refusal as it is; the cursors carry the
  // same wrap
  return { ...surface,
    load: bounded(surface.load, driverWrap),
    syncLoadCursor: (spec, options, register) => surface.loadCursor(spec, options, register, createSyncCursor),
    syncPage: bounded((spec, options, register) => surface.page(spec, options, register, createSyncCursor), driverWrap),
    page: bounded(surface.page, driverWrap),
    explainLoad: bounded(surface.explainLoad, driverWrap) };
}

/**
 * @typedef {{ literal?: any, external?: string, continuation?: number }[]} ParamCollector
 */
