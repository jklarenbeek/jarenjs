//@ts-check
/**
 * @file Document migrations: two model documents diff into a
 * migration document whose steps are rendered DDL, JSLT data
 * transforms and query assertions; the migration replays on a shadow
 * database first. Unchanged history columns keep their original fingerprints;
 * versioned side receipts bind complete canonical documents and stored rows.
 * New 0.2 documents carry exact canonical model endpoints. Applied legacy
 * histories need explicit reviewed attestation before they grant authority.
 *
 * The persisted 32-bit FNV-1a `from`/`to` and checksum fields can collide;
 * they remain compatibility fingerprints, never proof of exact content.
 * Canonical endpoint identity omits model rename hints. Execution snapshots
 * retain declaration order, including an adopted shadow boundary's model.
 *
 * Like the query emitter, this module is part of the emitter layer:
 * the structural SQL it composes (the history table's statements, the
 * batched row walk) is built from dialect primitives, and every
 * planner-produced statement is rendered by the dialect into the
 * migration DOCUMENT — shown before it is ever executed.
 */

import { canonicalizeJson } from '@jarenjs/json/canonical';
import { hashContent } from '@jarenjs/core/string';
import { resolveRuntime } from '@jarenjs/core/runtime';
import { refuseCancelled } from './cancellation.js';
import { cloneJson, setObjectMember } from '@jarenjs/core/object';
import { withoutModelRenameHints } from '@jarenjs/core/model';
import { compileJsonQuery } from '@jarenjs/json/query';
import { compileJsltStylesheet } from '@jarenjs/json/jslt';

import { DbCompileError, wrapDriverError } from './errors.js';
import { readOptions, readControls } from './options.js';
import { storedKeyMatches } from './key-text.js';
import { chain, attempt, useStatementOnce } from './driver.js';
import { isThenable } from '@jarenjs/core/function';
import { relationalEngine } from './relational.js';
import { createCursor, createSyncCursor } from './cursor.js';
import { normalizeModel } from './store.js';
import { planQuery } from './plan.js';
import { createQueryEngine, createQueryState } from './query.js';
import { HISTORY_TABLE, ENGINE_TABLES } from './engine-metadata.js';
import { modelIdentity, migrationIdentity } from './migration-identity.js';
import { migrationChecksum, historyStatements, readMigrationHistory, checkHistoryObservation, checkAppliedRows,
  historyHeader, identityRows, checkHistoryIdentity, checkHistoryChain, writeIdentityRows } from './migration-history.js';
export { HISTORY_TABLE, ENGINE_TABLES };
import { planCollection, verifyShape, planEntity, planJoinTable } from './ddl.js';
import { normalizeEntities, explainMapping } from './model.js';
import { derivedValue, memberAt, registerDeriveFunctions } from './derive.js';
import { mergeEntityRow } from './graph.js';
import { entityCore } from './entity.js';
import { sqlTokens } from './dialects/check-read.js';
import { comparableDeclaredSql } from './schema-sql.js';
import { applyTableMigration } from './table-migration.js';
import { withForeignKeySettings } from './foreign-key-scope.js';
import { withMigrationConnection, physicalTargetOf, comparePhysicalTarget, verifyShadowOwnership, physicalObjectKey, migrationOwnerOf, lockMigration, migrationWriterSettings, preservationSchemaOf, verifyPreservation, checkPhysicalPreservation } from './migration-target.js';
import { readSchema } from './introspect.js';
import { verifyPhysical } from './physical.js';
import { walkPhysicalRows, transformPhysicalRows } from './physical-transform.js';
import {
  MIGRATION_VERSION, isPerDocumentAssertion, compileDocumentStep, checkMigrationDocument, checkReplacement,
  stepFailure, normalizeAssertionBounds, ASSERTION_BOUNDS_DEFAULT, createAssertionBoundGuard,
} from './document-steps.js';

export { MIGRATION_VERSION, isPerDocumentAssertion, ASSERTION_BOUNDS_DEFAULT };

/**
 * Whether every document valid under `from` is still valid under `to` —
 * a WIDENING, so the stored documents need no transform and the planner
 * owes the operator no draft step.
 *
 * The rule is deliberately narrow, because the consequence of a wrong
 * `true` is an unattended migration leaving invalid documents behind:
 * the two object schemas must be identical except that `to` may ADD
 * properties none of which it requires, and may REQUIRE FEWER of them.
 * Every keyword they share — including every property they share — must
 * be canonically equal; a changed subschema, a removed property
 * declaration (which a closed object would then refuse as an
 * additional one) and a widened `additionalProperties` are all left to
 * the operator. Anything not understood answers `false`.
 * @param {any} from
 * @param {any} to
 * @returns {boolean}
 */
function isWidening(from, to) {
  const plain = (node) => node !== null && typeof node === 'object' && !Array.isArray(node);
  if (!plain(from) || !plain(to)) return false;
  const fromRequired = from.required ?? [];
  const toRequired = to.required ?? [];
  if (!Array.isArray(fromRequired) || !Array.isArray(toRequired)) return false;
  // a member `to` requires and `from` did not is a NARROWING
  if (toRequired.some((name) => !fromRequired.includes(name))) return false;

  for (const keyword of new Set([...Object.keys(from), ...Object.keys(to)])) {
    if (keyword === 'required') continue;
    if (keyword === 'properties') {
      const fromProperties = from.properties ?? {};
      const toProperties = to.properties ?? {};
      if (!plain(fromProperties) || !plain(toProperties)) return false;
      for (const name of Object.keys(fromProperties)) {
        // a declaration that disappeared, or one whose shape changed
        if (!Object.hasOwn(toProperties, name)) return false;
        if (canonicalizeJson(fromProperties[name]) !== canonicalizeJson(toProperties[name])) return false;
      }
      // A NEW property is admitted only while nothing requires it AND
      // the old schema was CLOSED. Under an open schema a stored
      // document may already carry that member with any shape at all —
      // `age: "seven"` was valid before and the new `age: { type:
      // 'integer' }` refuses it — so naming the member for the first
      // time NARROWS what is already stored.
      for (const name of Object.keys(toProperties)) {
        if (Object.hasOwn(fromProperties, name)) continue;
        if (toRequired.includes(name) || from.additionalProperties !== false) return false;
      }
      continue;
    }
    if (canonicalizeJson(from[keyword]) !== canonicalizeJson(to[keyword])) return false;
  }
  return true;
}

/**
 * The physical mapping a connection's driver imposes on derived index
 * columns. A driver that can index a registered deterministic function
 * generates them; one that cannot has them written, which is why the
 * planner emits a backfill for the second and not the first.
 * @param {any} connection
 * @returns {{ derived: 'virtual' | 'stored', rtree: boolean }}
 */
function mappingFor(connection, expressions = undefined) {
  const registered = connection.capabilities?.deterministicIndexableFunctions === true;
  return {
    derived: registered ? 'virtual' : 'stored',
    // the same reasoning for the R*Tree mapping: a build without the
    // module plans (and verifies) the B-tree shape
    rtree: connection.capabilities?.rtree === true,
    // and the same for a declared index expression: this connection
    // either computes it or calls the engine's own immutable function
    expressions,
    registered,
  };
}

/**
 * The persisted 32-bit fingerprint of a model shape; collisions are possible.
 * @param {any} model - A jaren-model document
 * @returns {string}
 */
export function shapeHash(model) {
  return hashContent(canonicalizeJson(withoutModelRenameHints(model)));
}

export { migrationChecksum };

/**
 * Admit JSON before callbacks or connection acquisition can change the caller's
 * documents. Execution, shadow replay and receipts share these private values;
 * declaration order stays intact. Functions, drivers and cancellation controls
 * remain host capabilities.
 * @param {any[]} migrations @param {any} options @returns {[any[], any]}
 */
function snapshotMigrationInputs(migrations, options) {
  const snapshot = (value) => { canonicalizeJson(value); return cloneJson(value); };
  const copy = { ...options };
  for (const name of ['baseline', 'model', 'physicalTarget', 'observed']) {
    if (copy[name] !== undefined) copy[name] = snapshot(copy[name]);
  }
  return [snapshot(migrations), copy];
}

/**
 * @param {string} code
 * @param {string} reason
 * @param {Error} [cause]
 * @returns {DbCompileError}
 */
function refuse(code, reason, cause) {
  return new DbCompileError(code, reason, undefined, cause);
}

/** A Jaren coded error: it already names its failure. @param {any} error */
const isCoded = (error) => typeof error?.code === 'string' && /^J[A-Z]\d{4}$/.test(error.code);

/**
 * The class and retry verdict a failure carries: a classified error's own,
 * a driver error's classification (a busy database, a constraint), and
 * otherwise an `error` no rerun fixes.
 * @param {any} cause @returns {{ class: string, retryable: boolean }}
 */
function verdictOf(cause) {
  if (cause !== null && typeof cause === 'object' && typeof cause.class === 'string')
    return { class: cause.class, retryable: cause.retryable === true };
  if (cause === undefined || cause === null) return { class: 'error', retryable: false };
  const wrapped = wrapDriverError(cause, { always: true });
  return { class: typeof wrapped?.class === 'string' ? wrapped.class : 'error', retryable: wrapped?.retryable === true };
}

/**
 * A step's failure, classified the way maintenance keeps `JD2078`
 * (MODEL-FORMAT §7): the lifecycle code `JD0023` names the migration and the
 * step, carries the driver's `class` and `retryable` verdict, and keeps the
 * error it met as `cause` — a UNIQUE violation a transform ran into is a
 * `constraint`, never a raw driver error. A coded refusal keeps its code.
 * @param {any} migration @param {number} index @param {string} kind @param {any} error
 */
function stepFailed(migration, index, kind, error) {
  if (isCoded(error)) {
    if (error.code === 'JD0023' && typeof error.class !== 'string') Object.assign(error, { class: 'error', retryable: false });
    return error;
  }
  return Object.assign(refuse('JD0023',
    `migration '${migration.id}' step ${index} (${kind}) failed: ${error?.message ?? String(error)}`, error), verdictOf(error));
}

/**
 * A failure met around the steps — the write transaction's begin behind a
 * held writer, a history read, a connection that could not open: a driver
 * error is `JD0023`, classified (a busy database is `busy`, retryable); a
 * coded refusal keeps its code; a host's programming error (a `TypeError`
 * in an option) passes as it is.
 * @param {any} error @param {string} reason
 */
function runFailure(error, reason) {
  if (isCoded(error)) {
    if (error.code === 'JD0023' && typeof error.class !== 'string') Object.assign(error, { class: 'error', retryable: false });
    return error;
  }
  return wrapDriverError(error, { code: 'JD0023', reason });
}

/** Run `fn` over `items` in order, waiting for each answer that is a promise.
 * @param {any[]} items @param {(item: any) => any} fn @param {number} [from] @returns {any} */
function sequentially(items, fn, from = 0) {
  for (let j = from; j < items.length; j++) {
    const out = fn(items[j]);
    if (isThenable(out)) return out.then(() => sequentially(items, fn, j + 1));
  }
  return null;
}

/**
 * The values of derived columns — entries as a `derive` step carries them,
 * `{ name, derive, segments, precision?, component?, dims? }` — for one
 * document in the form the database holds it: the one computation a
 * migration's backfill and its document writes share.
 * @param {readonly any[]} columns
 * @param {any} stored - the document as stored (parsed from its JSON text)
 * @returns {any[]}
 */
function derivedValuesOf(columns, stored) {
  return columns.map((column) => derivedValue(column, memberAt(stored, column.segments)));
}

/**
 * A collection's STORED derived columns as its table holds them now: the
 * columns the model in force at the step (the step's `model`, else the
 * run's) derives that the table carries as ordinary columns. A generated
 * column is the engine's to compute, and one a later step of the link
 * adds is not there yet — the backfill that follows it computes it. With
 * no model declaring the collection, none is known.
 * @param {any} connection @param {string} table @param {any} step @param {any} options
 * @returns {any} value-or-promise of the column entries
 */
function storedDerivedColumns(connection, table, step, options) {
  const model = step?.model ?? options.model;
  const collection = model === undefined ? undefined : normalizeModel(model, options.expressions).get(table);
  if (collection === undefined) return [];
  const { derived } = planCollection(table, collection, connection.dialect, mappingFor(connection, options.expressions));
  if (derived.length === 0) return [];
  return useStatementOnce(connection, connection.dialect.introspect.columns(table), (statement) => chain(statement.all([]),
    (/** @type {any[]} */ columns) => {
      const ordinary = new Set(columns.filter((column) => Number(column.hidden) === 0).map((column) => column.name));
      return derived.filter((/** @type {any} */ column) => ordinary.has(column.name));
    }));
}

/**
 * How a data step writes one document back: a collection's `doc` by row
 * identity, with the values of its stored derived columns — every write
 * carries them, as a store's does, so a host or jslt step leaves none
 * stale — or a mapped entity row WHOLE: its columns split out through the
 * entity's own split and the rest into its document (a column-mapped member
 * a transform wrote used to land in the document and be shadowed on read).
 * @param {any} connection @param {string} table @param {any} step
 * @param {{ entity: any, mapping: any } | null} stepEntity @param {any} options
 * @param {(write: (doc: any, rid: any) => any) => any} use
 * @returns {any} value-or-promise of the complete writer operation
 */
function documentWriter(connection, table, step, stepEntity, options, use) {
  const dialect = connection.dialect;
  const q = dialect.quoteIdentifier;
  if (stepEntity !== null) {
    const core = entityCore(connection, stepEntity.entity, stepEntity.mapping, null, options.runtime);
    const columns = entityColumnsOf(stepEntity.mapping);
    const assignments = [
      ...columns.map((column, i) => `${q(column)} = ${dialect.parameterRef(i + 1, 'v')}`),
      `${q('doc')} = ${dialect.jsonEncode(dialect.parameterRef(columns.length + 1, 'doc'))}`,
    ];
    return useStatementOnce(connection, `UPDATE ${q(table)} SET ${assignments.join(', ')} `
      + `WHERE ${dialect.rowIdentity()} = ${dialect.parameterRef(columns.length + 2, 'rid')}`, (update) =>
      use((/** @type {any} */ next, /** @type {any} */ rid) => {
        const { values, rest } = core.plan.split(next);
        const byName = new Map(values.map((value) => [value.name, value.value]));
        return update.run([...columns.map((column) => byName.get(column) ?? null), JSON.stringify(rest), rid]);
      }));
  }
  return chain(storedDerivedColumns(connection, table, step, options), (/** @type {any[]} */ derived) => {
    const assignments = [`${q('doc')} = ${dialect.jsonEncode(dialect.parameterRef(1, 'doc'))}`,
      ...derived.map((column, at) => `${q(column.name)} = ${dialect.parameterRef(at + 2, column.name)}`)];
    return useStatementOnce(connection, `UPDATE ${q(table)} SET ${assignments.join(', ')} `
      + `WHERE ${dialect.rowIdentity()} = ${dialect.parameterRef(derived.length + 2, 'rid')}`, (update) =>
      use((/** @type {any} */ next, /** @type {any} */ rid) => {
        const text = JSON.stringify(next);
        return update.run([text, ...(derived.length === 0 ? [] : derivedValuesOf(derived, JSON.parse(text))), rid]);
      }));
  });
}

/**
 * The `hosts` option: a plain object of `{ version, run }` by host name.
 * @param {any} hosts @returns {Readonly<Record<string, { version: string, run: Function }>>}
 */
function readHosts(hosts) {
  if (hosts === undefined) return Object.freeze(Object.create(null));
  if (hosts === null || typeof hosts !== 'object' || Array.isArray(hosts))
    throw new TypeError('hosts must be an object of { version, run } by host name');
  const out = Object.create(null);
  for (const [name, host] of Object.entries(hosts)) {
    if (!host || typeof host !== 'object' || typeof host.run !== 'function' || typeof host.version !== 'string'
      || host.version === '' || Object.keys(host).some((key) => key !== 'run' && key !== 'version'))
      throw new TypeError(`host '${name}' must be { version: string, run(scope, ctx) }`);
    out[name] = host;
  }
  return Object.freeze(out);
}

/**
 * The refusal of a host step that cannot run as reviewed: no host of its
 * name, or one of another version.
 * @param {any} migration @param {number} index @param {any} step @param {any} host
 */
function hostRefusal(migration, index, step, host) {
  return refuse('JD0025', host === undefined
    ? `migration '${migration.id}' step ${index} runs host '${step.run}', which this run was not given — pass it in options.hosts`
    : `migration '${migration.id}' step ${index} runs host '${step.run}' version ${JSON.stringify(step.version)}, and the host `
      + `given is version ${JSON.stringify(host.version)} — a step runs the code its document names`);
}

/**
 * A host step's document collection, inside the migration's transaction:
 * `all()` — every document as the table holds it now (a mapped entity row
 * WHOLE, as a jslt step reads it) — and `update(fn)`, the transform a jslt
 * stylesheet is, spelled in code: `fn(doc)` answers the replacement, or
 * `undefined` to keep the document; it answers how many it replaced. A
 * replacement is checked as a stylesheet's is (`checkReplacement`): a
 * non-document, or a moved key member, refuses the step.
 * @param {any} connection @param {string} name @param {any} step @param {any} options
 * @param {() => void} closed - throws once the step has returned
 * @param {(reason: string) => never} fail - the step's own refusal
 */
function hostCollection(connection, name, step, options, closed, fail) {
  const stepEntity = entityStepMapping(options, name, step, connection.dialect);
  if (stepEntity?.mapping.document === false) {
    throw refuse('JD0025', `'${name}' is a column-mapped table without a document: a host step `
      + 'reads and writes it through scope.relational');
  }
  const mapping = stepEntity?.mapping ?? null;
  const keys = mapping?.keys ?? [];
  const read = (/** @type {any} */ row) => (mapping === null ? JSON.parse(row.doc) : mergeEntityRow(mapping, row, 'doc'));
  return Object.freeze({
    all() {
      closed();
      /** @type {any[]} */
      const docs = [];
      return chain(walkRows(connection, name, options.batchSize, (rows) => { for (const row of rows) docs.push(read(row)); },
        false, mapping, options.check), () => docs);
    },
    update(/** @type {any} */ fn) {
      closed();
      if (typeof fn !== 'function') throw new TypeError('update() takes a function from a document to its replacement');
      let replaced = 0;
      return documentWriter(connection, name, step, stepEntity, options, (write) =>
        chain(walkRows(connection, name, options.batchSize, (rows) => sequentially(rows, (row) => {
          const document = read(row);
          return chain(fn(document), (next) => {
            if (next === undefined) return null;
            closed();
            replaced++;
            return write(checkReplacement(next, document, keys, row.rid, fail), row.rid);
          });
        }), false, mapping, options.check), () => replaced));
    },
  });
}

/** Finite statement methods for a temporary engine; its cursor path keeps its
 * separate ephemeral owner. Preparation and use share the one-shot lifecycle. */
function temporaryStatement(connection, sql, metadata) {
  const use = (method) => (params) => useStatementOnce(connection, sql,
    (statement) => statement[method](params), metadata);
  return { run: use('run'), get: use('get'), all: use('all') };
}

/**
 * Run one host step: the named host's `run(scope, ctx)` inside the step's
 * savepoint of its link's transaction. `scope` offers the transaction's
 * document collections and a relational engine bound to it; nothing it
 * holds outlives the step. On a synchronous connection the work is
 * synchronous — a promise there would settle after the savepoint closed —
 * and on an asynchronous one `run` may be async. A failure is `JD0023`
 * naming the step, the host's error as `cause`, its verdict kept.
 * @param {any} connection @param {any} migration @param {number} index
 * @param {any} step @param {any} options
 */
function runHostStep(connection, migration, index, step, options) {
  const host = options.hosts?.[step.run];
  // checked before the run began; a borrowed caller could still pass another list
  if (host === undefined || host.version !== step.version) throw hostRefusal(migration, index, step, host);
  const kind = `host '${step.run}' ${step.version}`;
  let open = true;
  const closed = () => {
    if (!open) {
      throw refuse('JD0025', `migration '${migration.id}' step ${index}: host '${step.run}' used its scope after `
        + 'the step ended — a host step runs inside its savepoint, and only there');
    }
  };
  // every cursor the scope opened: returned when the step ends, so none
  // keeps a statement open past its savepoint, and a pull after refuses
  /** @type {Set<any>} */
  const cursors = new Set();
  const relational = relationalEngine({
    dialect: connection.dialect,
    connection,
    prepare: temporaryStatement,
    available: closed,
    read: (run) => run(connection),
    cursor: (spec) => stepCursor((connection.synchronous ? createSyncCursor : createCursor)({
      ...spec, open: () => { closed(); return spec.open(connection); } }), connection.synchronous, closed, cursors),
    // a write is a savepoint of the migration's transaction
    write: (run) => connection.transaction(run),
  });
  const fail = (/** @type {string} */ reason) => { throw stepFailure(migration.id, index, kind, reason); };
  const scope = Object.freeze({
    collection: (/** @type {string} */ name) => { closed(); return hostCollection(connection, name, step, options, closed, fail); },
    relational,
  });
  const ctx = Object.freeze({ migration: migration.id, step: index, version: step.version, shadow: false });
  // the scope's own refusals keep their codes — a cancellation its walk met
  // (JD2080, JD2075), a scope used out of its step (JD0025), a replacement
  // refused as a stylesheet's is (JD0023); anything else the host raised is
  // JD0023 naming the step, the host's error as cause, its verdict kept
  const failed = (/** @type {any} */ error) => (HOST_SCOPE_REFUSALS.has(error?.code) ? error
    : Object.assign(refuse('JD0023', `migration '${migration.id}' step ${index} (${kind}) failed: `
      + `${error?.message ?? String(error)}`, error), verdictOf(error)));
  // the step's end: nothing the scope holds outlives it
  const end = () => {
    open = false;
    const pending = [];
    for (const cursor of cursors) {
      try { pending.push(cursor.return()); }
      catch { /* a cursor that cannot close has nothing left to release */ }
    }
    cursors.clear();
    const settling = pending.filter(isThenable);
    return settling.length === 0 ? null : Promise.allSettled(settling).then(() => null);
  };
  let out;
  try { out = host.run(scope, ctx); }
  catch (error) { end(); throw failed(error); }
  if (!isThenable(out)) return end();
  if (connection.synchronous) {
    end();
    out.then(undefined, () => undefined);
    throw refuse('JD0025', `migration '${migration.id}' step ${index}: host '${step.run}' answered a promise on a `
      + 'synchronous connection — a host step runs synchronously there; an asynchronous host needs an asynchronous driver');
  }
  return out.then(() => end(), (error) => chain(end(), () => { throw failed(error); }));
}

/** The codes a host step's scope raises itself, which its step passes on
 * as they are. */
const HOST_SCOPE_REFUSALS = new Set(['JD2080', 'JD2075', 'JD0025', 'JD0023']);

/**
 * A relational cursor of a host step's scope: every pull checks the step
 * is still running (`JD0025` after it), and the step's end returns it.
 * @param {any} cursor @param {boolean} synchronous @param {() => void} closed
 * @param {Set<any>} cursors - the step's open cursors
 */
function stepCursor(cursor, synchronous, closed, cursors) {
  cursors.add(cursor);
  const next = synchronous ? () => { closed(); return cursor.next(); } : () => {
    try { closed(); }
    catch (error) { return Promise.reject(error); }
    return cursor.next();
  };
  const stepped = {
    streaming: cursor.streaming,
    barrier: cursor.barrier,
    get settled() { return cursor.settled; },
    next,
    return: () => cursor.return(),
    ...(synchronous
      ? { [Symbol.iterator]: () => stepped, [Symbol.dispose]: () => cursor.return() }
      : { [Symbol.asyncIterator]: () => stepped, [Symbol.asyncDispose]: async () => { await cursor.return(); } }),
  };
  return Object.freeze(stepped);
}

/**
 * The tables a physical plan owns: every table its two models map — an
 * entity's (physical or managed), a join table, a collection — and every
 * table its guarded table steps name.
 * @param {any} fromModel @param {any} toModel @param {any[]} steps @returns {Set<string>}
 */
function ownedTables(fromModel, toModel, steps) {
  const owned = new Set();
  for (const model of [fromModel, toModel]) {
    const mapping = explainMapping(model);
    for (const entity of Object.values(mapping.entities ?? {})) owned.add(/** @type {any} */ (entity).table);
    for (const table of Object.keys(mapping.joinTables ?? {})) owned.add(table);
    for (const name of normalizeModel(model).keys()) owned.add(name);
  }
  for (const step of steps) if (step?.kind === 'table' && typeof step.plan?.table === 'string') owned.add(step.plan.table);
  return owned;
}

/**
 * A physical plan's `scope`, validated: `{ tables }`, a non-empty list of
 * distinct tables the plan owns. The source snapshot, the dispositions and
 * the source check then cover those tables and their programs alone, so an
 * installation that also keeps an unrelated table takes the same plan.
 * @param {any} scope @param {any} dialect @param {Set<string>} owned
 * @returns {{ tables: string[] }}
 */
function physicalScopeOf(scope, dialect, owned) {
  if (dialect?.migration) {
    throw refuse('JD0021', 'a physical scope is qualified on SQLite; a PostgreSQL plan inventories its schema whole');
  }
  if (!scope || typeof scope !== 'object' || Array.isArray(scope) || Object.keys(scope).some((key) => key !== 'tables')
    || !Array.isArray(scope.tables) || scope.tables.length === 0 || new Set(scope.tables).size !== scope.tables.length
    || scope.tables.some((/** @type {any} */ table) => typeof table !== 'string' || table === '' || ENGINE_TABLES.has(table)))
    throw refuse('JD0027', 'a physical scope is { tables: [...] }, a non-empty list of distinct table names');
  const foreign = scope.tables.find((/** @type {string} */ table) => !owned.has(table));
  if (foreign !== undefined) {
    throw refuse('JD0027', `the scope names '${foreign}', which the plan does not own — it owns the tables its `
      + `models map and its table steps name (${[...owned].sort().join(', ') || 'none'})`);
  }
  return { tables: [...scope.tables] };
}

/**
 * A backfill step: recompute named STORED derived columns from the
 * documents already in a collection. Idempotent by construction — the
 * value is a pure function of the document — so a second run writes
 * what the first did.
 * @param {string} collection
 * @param {any} plan - the target collection's physical plan
 * @param {string[]} columnNames
 * @param {string} note
 * @returns {any} the migration step
 */
function deriveStep(collection, plan, columnNames, note) {
  const columns = plan.derived
    .filter((column) => columnNames.includes(column.name))
    .map((column) => {
      /** @type {any} */
      const entry = { name: column.name, derive: column.derive, segments: column.segments };
      if (column.precision !== undefined) entry.precision = column.precision;
      if (column.component !== undefined) entry.component = column.component;
      if (column.dims !== undefined) entry.dims = column.dims;
      return entry;
    });
  return { kind: 'derive', collection, columns, note };
}

/**
 * Plan a migration between two model documents. The planner diffs the
 * PHYSICAL plans (columns, indexes) and renders DDL through the
 * dialect; a changed schema gets a DRAFT identity transform that
 * refuses to run until the author fills it in — the planner cannot
 * infer a data transform and does not pretend to. Renames are declared
 * (`x-rename` on the target collection), never guessed.
 * The physical mapping of a DERIVED index column depends on the driver
 * that will run the migration (`derived`), because the two mappings
 * really are different columns; a migration document planned for one is
 * not the document the other needs.
 * @param {any} fromModel
 * @param {any} toModel
 * @param {{ id?: string, dialect?: any,
 *   derived?: 'virtual' | 'stored', rtree?: boolean,
 *   expressions?: Record<string, any> }} [options]
 * @returns {{ migration: any, report: {
 *   renamed: { from: string, to: string }[],
 *   added: string[], removed: string[],
 *   schemaChanged: string[], drafts: string[], widened: string[],
 *   destructive: boolean } }}
 *   `widened` names the collections and entities whose document schema
 *   changed by a WIDENING alone — new optional members, or fewer
 *   required ones — so every stored document still validates and the
 *   plan carries no draft transform for them. They are in
 *   `schemaChanged` too; they are simply not in `drafts`.
 */
export function planMigration(fromModel, toModel, options = undefined) {
  readOptions(options, ['id', 'dialect', 'derived', 'rtree', 'expressions', 'transform'], 'planModelMigration()');
  const dialect = options?.dialect ?? null;
  if (dialect === null || typeof dialect !== 'object')
    throw new TypeError('planMigration needs { dialect } (the store dialect renders the DDL)');
  const identity = migrationIdentity(fromModel, toModel);
  const from = hashContent(identity.from), to = hashContent(identity.to);
  if ([fromModel, toModel].some((m) => Object.values(m.entities ?? {}).some((e) => e.physical !== undefined))) {
    normalizeEntities(fromModel);
    normalizeEntities(toModel);
    if (canonicalizeJson(fromModel) !== canonicalizeJson(toModel))
      throw refuse('JD0021', 'changed column layouts require planTableMigration on the open connection or planPhysicalMigration with explicit preservation dispositions');
    // an unchanged pair narrows nothing, so a transform given is one no
    // draft asks for — refused as it is for any such pair, never dropped
    transformOf(options?.transform)?.finish();
    return { migration: { $migration: MIGRATION_VERSION,
      id: options?.id ?? `to-${to.slice(0, 8)}`,
      from, to, identity, steps: [] },
    report: { renamed: [], added: [], removed: [], schemaChanged: [], drafts: [], widened: [], transformed: [], destructive: false } };
  }
  const mapping = { derived: options?.derived ?? 'virtual', rtree: options?.rtree !== false,
    // a model that declares an index EXPRESSION resolves its functions
    // here too: a plan is DDL, and DDL over a function this planner was
    // not told about is DDL nobody can apply
    expressions: options?.expressions, registered: options?.derived !== 'stored' };
  const fromCollections = normalizeModel(fromModel, options?.expressions);
  const toCollections = normalizeModel(toModel, options?.expressions);

  const steps = [];
  const report = {
    renamed: [], added: [], removed: [], schemaChanged: [], drafts: [], widened: [], transformed: [],
    destructive: false,
  };
  const transform = transformOf(options?.transform);

  // declared renames first: the physical table moves, its old-prefixed
  // indexes stay behind (probed) and are rebuilt by the index diff
  const renamedFrom = new Map();
  for (const name of toCollections.keys()) {
    const hint = toModel.collections[name]?.['x-rename'];
    if (hint === undefined) continue;
    if (!fromCollections.has(hint)) {
      // the hint's work is done once the from-model already declares the
      // target and no longer the source: planning a model against itself
      // must yield nothing, not refuse the hint it still carries
      if (fromCollections.has(name)) continue;
      throw new TypeError(
        `x-rename on '${name}' names '${hint}', which the from-model does not declare`);
    }
    if (fromCollections.has(name)) {
      throw new TypeError(
        `x-rename on '${name}' collides: the from-model already declares '${name}'`);
    }
    if (toCollections.has(hint)) {
      throw new TypeError(
        `x-rename on '${name}' collides: '${hint}' is also declared in the target model — `
        + 'a rename consumes its source');
    }
    renamedFrom.set(name, hint);
    report.renamed.push({ from: hint, to: name });
    steps.push({
      kind: 'ddl',
      sql: dialect.ddl.renameTable(hint, name),
      note: `rename collection '${hint}' to '${name}'`,
    });
  }
  const consumedOldNames = new Set(renamedFrom.values());

  for (const [name, toCollection] of toCollections) {
    const oldName = renamedFrom.get(name) ?? name;
    const fromCollection = renamedFrom.has(name)
      ? fromCollections.get(renamedFrom.get(name))
      : fromCollections.get(name);

    if (fromCollection === undefined) {
      report.added.push(name);
      for (const sql of planCollection(name, toCollection, dialect, mapping).createSql)
        steps.push({ kind: 'ddl', sql, note: `create collection '${name}'` });
      continue;
    }

    // the from-side physical facts live under the RENAMED table: same
    // columns, but index names still carry the old collection prefix
    const fromPlan = planCollection(oldName, fromCollection, dialect, mapping);
    const toPlan = planCollection(name, toCollection, dialect, mapping);
    if (fromPlan.keyType !== toPlan.keyType
      || fromCollection.identity !== toCollection.identity
      || canonicalizeJson(fromCollection.key) !== canonicalizeJson(toCollection.key)) {
      throw new TypeError(
        `collection '${name}': changing the key declaration requires a table rebuild, `
        + 'which this planner does not produce (a named non-goal — branch the shape instead)');
    }

    const fromColumns = new Map(fromPlan.generated.map((g) => [g.name, g]));
    const toColumns = new Map(toPlan.generated.map((g) => [g.name, g]));
    const fromIndexes = new Map(fromPlan.expected.indexes.map((i) => [i.name, i]));
    const toIndexes = new Map(toPlan.expected.indexes.map((i) => [i.name, i]));

    // a derived column's EXPRESSION is part of its identity: the same
    // path at a different precision, or under the other physical
    // mapping, is a different column even where name and type agree
    const columnChanged = (a, b) => a.type !== b.type || a.pathText !== b.pathText
      || (a.expression ?? null) !== (b.expression ?? null)
      || (a.stored === true) !== (b.stored === true);
    const indexChanged = (a, b) => a.unique !== b.unique
      || a.columns.join(',') !== b.columns.join(',');

    // columns first decide their fate; an index rebuilds when it
    // changes OR when any column it covers is dropped or changed (the
    // database refuses to drop a column under a live index) — then
    // everything runs in dependency order: drop indexes, drop columns,
    // add columns, create indexes
    // the R*Tree half of the physical shape (MODEL-FORMAT §2.1,
    // `physical`). Changing it in either direction is a physical change
    // and needs a migration, not an open-time alteration: the virtual
    // table and its three triggers leave BEFORE the columns they read
    // are disturbed, and arrive AFTER them with a backfill — a
    // generated column arrives populated, an R*Tree does not.
    //
    // A virtual table is compared by NAME and not by declared text,
    // which is where a column and an index are different: the name is
    // built from the column stem, the module and its column list are
    // fixed, and the three triggers are built from that same stem — so
    // under this dialect a table present on both sides cannot differ,
    // and one whose stem moved has a different name. `verifyShape`
    // compares the declared text at open, which is the backstop if that
    // ever stops being true.
    const fromVirtual = new Map(fromPlan.virtualTables.map((v) => [v.name, v]));
    const toVirtual = new Map(toPlan.virtualTables.map((v) => [v.name, v]));
    for (const [virtualName, from] of fromVirtual) {
      if (toVirtual.has(virtualName)) continue;
      for (const trigger of from.triggers) {
        steps.push({ kind: 'ddl', sql: dialect.ddl.dropTrigger(trigger.name),
          note: `drop sync trigger '${trigger.name}' on '${name}'` });
      }
      steps.push({ kind: 'ddl', sql: dialect.ddl.dropVirtualTable(virtualName),
        note: `drop the R*Tree '${virtualName}' (and its shadow tables) on '${name}'` });
    }

    const disturbedColumns = new Set();
    for (const [columnName, fromColumn] of fromColumns) {
      const target = toColumns.get(columnName);
      if (target === undefined || columnChanged(fromColumn, target))
        disturbedColumns.add(columnName);
    }
    const indexNeedsRebuild = (indexName, fromIndex) => {
      const target = toIndexes.get(indexName);
      return target === undefined || indexChanged(fromIndex, target)
        || fromIndex.columns.some((column) => disturbedColumns.has(column));
    };
    for (const [indexName, fromIndex] of fromIndexes) {
      if (indexNeedsRebuild(indexName, fromIndex)) {
        steps.push({ kind: 'ddl', sql: dialect.ddl.dropIndex(indexName),
          note: `drop index '${indexName}' on '${name}'` });
      }
    }
    for (const columnName of disturbedColumns) {
      steps.push({ kind: 'ddl', sql: dialect.ddl.dropColumn(name, columnName),
        note: `drop generated column '${columnName}' on '${name}'` });
    }
    const backfilled = [];
    for (const [columnName, toColumn] of toColumns) {
      const source = fromColumns.get(columnName);
      if (source === undefined || columnChanged(source, toColumn)) {
        steps.push({
          kind: 'ddl',
          sql: dialect.ddl.addGeneratedColumn(
            { table: name, docColumn: toPlan.docColumn, column: toColumn }),
          note: toColumn.stored === true
            ? `add stored derived column '${columnName}' on '${name}'`
            : `add generated column '${columnName}' on '${name}'`,
        });
        if (toColumn.stored === true) backfilled.push(columnName);
      }
    }
    // a GENERATED column arrives populated; a STORED one arrives NULL,
    // and a pushdown over a NULL column silently returns fewer rows.
    // The backfill is an explicit step rather than an assumption that
    // the table is empty
    if (backfilled.length > 0) {
      steps.push(deriveStep(name, toPlan, backfilled,
        `backfill derived column(s) ${backfilled.join(', ')} on '${name}'`));
    }
    for (const [indexName, toIndex] of toIndexes) {
      const source = fromIndexes.get(indexName);
      const rebuilt = source !== undefined && indexNeedsRebuild(indexName, source);
      if (source === undefined || rebuilt) {
        steps.push({
          kind: 'ddl',
          sql: dialect.ddl.createIndex(
            { name: indexName, table: name, columns: toIndex.columns, unique: toIndex.unique }),
          note: `create index '${indexName}' on '${name}'`,
        });
      }
    }
    for (const [virtualName, target] of toVirtual) {
      if (fromVirtual.has(virtualName)) continue;
      steps.push({ kind: 'ddl', sql: target.createSql,
        note: `create the R*Tree '${virtualName}' on '${name}'` });
      for (const trigger of target.triggers) {
        steps.push({ kind: 'ddl', sql: trigger.sql,
          note: `create sync trigger '${trigger.name}' on '${name}'` });
      }
      // the triggers fire on WRITES; the rows already stored need the
      // backfill, and without it a probe silently returns nothing
      steps.push({ kind: 'sql', sql: target.fillSql,
        note: `backfill the R*Tree '${virtualName}' from the stored documents` });
    }

    if (canonicalizeJson(fromCollection.schema) !== canonicalizeJson(toCollection.schema)) {
      report.schemaChanged.push(name);
      // a widening needs no transform: every stored document already
      // validates against the new schema, so the plan stays applicable
      // unattended rather than waiting on a person to delete a step
      if (isWidening(fromCollection.schema, toCollection.schema)) {
        report.widened.push(name);
      }
      else {
        // a transform rewrites the document — the planner's draft, or the
        // one the caller supplied — and a stored derived column is computed
        // FROM the document: without this it keeps the old document's value
        const stale = toPlan.derived
          .filter((column) => toColumns.get(column.name)?.stored === true)
          .map((column) => column.name)
          .filter((columnName) => !backfilled.includes(columnName));
        const backfills = stale.length === 0 ? [] : [deriveStep(name, toPlan, stale,
          `recompute derived column(s) ${stale.join(', ')} on '${name}' after the transform`)];
        if (transform !== null && transform.covers(name)) {
          report.transformed.push(name);
          steps.push(...transform.place(name, backfills));
        }
        else {
          report.drafts.push(name);
          steps.push({
            kind: 'jslt',
            collection: name,
            stylesheet: [],
            draft: true,
            note: `the schema of '${name}' changed; the planner cannot infer the data `
              + 'transform. Fill in the stylesheet (or delete this step if every stored '
              + 'document already validates against the new schema) and remove "draft".',
          }, ...backfills);
        }
      }
    }
  }

  for (const [name, fromCollection] of fromCollections) {
    if (toCollections.has(name) || consumedOldNames.has(name)) continue;
    report.removed.push(name);
    report.destructive = true;
    steps.push({
      kind: 'ddl',
      sql: dialect.ddl.dropTable(name),
      note: `DESTRUCTIVE: drop collection '${name}' and every document in it. `
        + 'A rename is declared with x-rename on the target collection; without '
        + 'one, this is a drop plus a create.',
    });
    // DROP TABLE takes the collection's own triggers with it and leaves
    // the R*Tree — and its three shadow tables — standing. A leftover
    // virtual table is a stale index a recreated collection would probe
    for (const virtual of planCollection(name, fromCollection, dialect, mapping).virtualTables) {
      steps.push({ kind: 'ddl', sql: dialect.ddl.dropVirtualTable(virtual.name),
        note: `drop the R*Tree '${virtual.name}' that belonged to '${name}'` });
    }
  }

  planEntityChanges(fromModel, toModel, dialect, steps, report, transform);
  // a list's repair runs last: after every structural step it may read
  steps.push(...(transform?.finish() ?? []));

  const migration = {
    $migration: MIGRATION_VERSION,
    id: options?.id ?? `to-${to.slice(0, 8)}`,
    from, to, identity,
    steps,
  };
  return { migration, report };
}

/**
 * The `transform` a plan puts in place of the drafts a narrowing needs — so
 * a host that plans each link from model snapshots plans one that carries
 * its own repair, and pins its checksum. Steps (one, or a list) are the
 * link's repair and take the place of every draft: they run once, after
 * every structural step of the link — an ADD COLUMN a later entity plans
 * included — followed by the derived-column backfills the drafts they
 * replace would have run after them. A map by collection or entity name
 * replaces that name's draft only, in its place. A step is a `jslt`
 * transform or a `host` step; a transform no draft asks for is a
 * programming error.
 * @param {any} transform
 * @returns {{ covers(name: string): boolean, place(name: string, after: any[]): any[], finish(): any[] } | null}
 */
function transformOf(transform) {
  if (transform === undefined) return null;
  const checked = (step, where) => {
    if (step === null || typeof step !== 'object' || Array.isArray(step)
      || !(step.kind === 'jslt' && typeof step.collection === 'string' && Array.isArray(step.stylesheet) && step.draft !== true
        || step.kind === 'host' && typeof step.run === 'string' && step.run !== '' && typeof step.version === 'string' && step.version !== ''))
      throw new TypeError(`${where} is a jslt step (collection, stylesheet) or a host step (run, version)`);
    return structuredClone(step);
  };
  const list = (value, where) => (Array.isArray(value) ? value : [value]).map((step) => checked(step, where));
  if (Array.isArray(transform) || typeof transform?.kind === 'string') {
    const steps = list(transform, 'a transform step');
    if (steps.length === 0) throw new TypeError('a transform names at least one step');
    let used = false;
    /** the backfills that follow the repair: they read what it wrote */
    const tail = [];
    return {
      covers: () => true,
      place: (_name, after) => { used = true; tail.push(...after); return []; },
      finish: () => {
        if (!used) throw new TypeError('the pair plans no draft transform — it widens, or no document schema changed; put the steps in the migration document directly');
        return [...steps, ...tail];
      },
    };
  }
  if (transform === null || typeof transform !== 'object')
    throw new TypeError('transform is a step, a list of steps, or a map of them by collection or entity name');
  const byName = new Map(Object.entries(transform).map(([name, value]) => [name, list(value, `the transform for '${name}'`)]));
  const taken = new Set();
  return {
    covers: (name) => byName.has(name),
    place: (name, after) => { taken.add(name); return [...(byName.get(name) ?? []), ...after]; },
    finish: () => {
      const unused = [...byName.keys()].find((name) => !taken.has(name));
      if (unused !== undefined) throw new TypeError(`the transform names '${unused}', whose schema this pair does not narrow`);
      return [];
    },
  };
}

/** `planMigration` handles the whole model — collections AND entities
 * — since the relational order; this name says so. */
export const planModelMigration = planMigration;

/** Deep-copy a schema with the mapping vocabulary stripped: a pure
 * mapping change (an index, a column toggle) is not a DOCUMENT change
 * and demands no transform. */
function stripEntityVocabulary(node) {
  if (Array.isArray(node)) return node.map(stripEntityVocabulary);
  if (node === null || typeof node !== 'object') return node;
  /** @type {any} */
  const out = {};
  for (const key of Object.keys(node)) {
    if (key === 'x-entity' || key === 'x-rename') continue;
    out[key] = stripEntityVocabulary(node[key]);
  }
  return out;
}

/**
 * The relational half of the diff (§9): entity add/drop/rename, the
 * additive and droppable column strategies with their data steps, the
 * rebuild for everything structural, join tables, and the stripped
 * document-change rule.
 * @param {any} fromModel
 * @param {any} toModel
 * @param {any} dialect
 * @param {any[]} steps
 * @param {any} report
 */
function planEntityChanges(fromModel, toModel, dialect, steps, report, transform = null) {
  const fromEntities = normalizeEntities(fromModel);
  const toEntities = normalizeEntities(toModel);
  if (fromEntities.size === 0 && toEntities.size === 0) return;
  const fromMapping = fromEntities.size > 0
    ? explainMapping(fromModel) : { entities: {}, joinTables: {} };
  const toMapping = toEntities.size > 0
    ? explainMapping(toModel) : { entities: {}, joinTables: {} };
  const q = dialect.quoteIdentifier;
  const pathText = (name) => dialect.jsonPathText([{ name }]);
  const docExtract = (docSql, name) => dialect.jsonExtract(docSql, pathText(name));
  const storageType = (storage) => dialect.typeFor(storage, 'generated');

  // ————— declared entity renames (join tables move with them) —————
  const renamedFrom = new Map();
  for (const name of toEntities.keys()) {
    const hint = toModel.entities[name]?.['x-rename'];
    if (hint === undefined) continue;
    if (!fromEntities.has(hint)) {
      if (fromEntities.has(name)) continue; // a satisfied hint (see the collections)
      throw new TypeError(
        `x-rename on entity '${name}' names '${hint}', which the from-model does not declare`);
    }
    if (fromEntities.has(name) || toEntities.has(hint)) {
      throw new TypeError(
        `x-rename on entity '${name}' collides — a rename consumes its source`);
    }
    renamedFrom.set(name, hint);
    report.renamed.push({ from: hint, to: name });
    steps.push({ kind: 'ddl', sql: dialect.ddl.renameTable(hint, name),
      note: `rename entity '${hint}' to '${name}'` });
  }
  const consumedOldEntities = new Set(renamedFrom.values());
  // a join table's endpoints come from the MAPPING, never from splitting
  // its name: an entity named with an underscore, or a `through` name,
  // does not split into its endpoints — and a split that guessed wrong
  // renamed the table to a name nothing declares, created the declared
  // one empty, and dropped the memberships as "destructive"
  const implicitJoinName = (join) => [join.left.entity, join.right.entity].sort().join('_');
  const renamedEntity = (entityName) => {
    for (const [to, from] of renamedFrom) if (from === entityName) return to;
    return entityName;
  };
  const renamedJoinName = (joinName) => {
    const join = fromMapping.joinTables[joinName];
    if (joinName !== implicitJoinName(join)) return joinName; // a `through` name stays
    return [renamedEntity(join.left.entity), renamedEntity(join.right.entity)].sort().join('_');
  };
  for (const [joinName, join] of Object.entries(fromMapping.joinTables)) {
    if (![join.left, join.right].some((side) => renamedEntity(side.entity) !== side.entity)) continue;
    const newJoin = renamedJoinName(joinName);
    const target = toMapping.joinTables[newJoin];
    if (target === undefined) continue; // the relation is gone: the drop below names it
    // the fresh build orders the endpoint columns by the SORTED entity
    // names, and a rename can flip that order — then the primary key's
    // column order would differ from a fresh build's and the shape
    // check would refuse the migrated database, so the table is rebuilt
    // in the target order with its rows copied; when the order holds,
    // renaming the table and the column is enough
    const renamedColumns = [join.left, join.right]
      .map((side) => ({ from: side.column, to: `${renamedEntity(side.entity)}_key` }));
    const targetOrder = [target.left.column, target.right.column];
    const sameOrder = renamedColumns.every((column, i) => column.to === targetOrder[i]);
    if (sameOrder) {
      if (newJoin !== joinName) {
        steps.push({ kind: 'ddl', sql: dialect.ddl.renameTable(joinName, newJoin),
          note: `rename join table '${joinName}' with its endpoint` });
      }
      for (const column of renamedColumns) {
        if (column.from === column.to) continue;
        steps.push({ kind: 'ddl', sql: dialect.ddl.renameColumn(newJoin, column.from, column.to),
          note: `rename the endpoint column '${column.from}' with its entity` });
      }
      continue;
    }
    const q = dialect.quoteIdentifier;
    const sourceOf = (toColumn) => renamedColumns.find((column) => column.to === toColumn).from;
    for (const sql of planJoinTable(newJoin, target, toMapping, dialect).createSql) {
      steps.push({ kind: 'ddl', sql, note: `rebuild join table '${joinName}' as '${newJoin}' in its endpoint order` });
    }
    steps.push({ kind: 'sql',
      sql: `INSERT INTO ${q(newJoin)} (${targetOrder.map(q).join(', ')}) `
        + `SELECT ${targetOrder.map((column) => q(sourceOf(column))).join(', ')} FROM ${q(joinName)}`,
      note: `copy the memberships of '${joinName}' into '${newJoin}'` });
    steps.push({ kind: 'ddl', sql: dialect.ddl.dropTable(joinName),
      note: `drop '${joinName}' — its memberships now live in '${newJoin}'` });
  }

  // ————— per-entity strategies —————
  for (const [name, toEntity] of toEntities) {
    const fromName = renamedFrom.get(name) ?? name;
    const fromEntity = fromEntities.get(fromName);
    const tm = toMapping.entities[name];

    if (fromEntity === undefined) {
      report.added.push(name);
      for (const sql of planEntity(name, tm, toMapping, dialect).createSql)
        steps.push({ kind: 'ddl', sql, note: `create entity '${name}'` });
      continue;
    }
    const fm = fromMapping.entities[fromName];

    const fkKey = (fk) => `${fk.column}|${fk.references}|${fk.referencesKey}|${fk.onDelete}`;
    const fromFks = new Set(fm.foreignKeys.map(fkKey));
    const toFks = new Set(tm.foreignKeys.map(fkKey));
    const fksEqual = fromFks.size === toFks.size
      && [...fromFks].every((key) => toFks.has(key));
    const columnFacts = (column) =>
      `${column.storage}|${column.source}|${JSON.stringify(column.check ?? null)}`;
    const fromColumns = new Map(fm.columns.map((column) => [column.name, column]));
    const toColumns = new Map(tm.columns.map((column) => [column.name, column]));
    const changedColumns = [...toColumns.keys()].filter((columnName) =>
      fromColumns.has(columnName)
      && columnFacts(fromColumns.get(columnName)) !== columnFacts(toColumns.get(columnName)));
    const addedColumns = [...toColumns.keys()]
      .filter((columnName) => !fromColumns.has(columnName));
    const droppedColumns = [...fromColumns.keys()]
      .filter((columnName) => !toColumns.has(columnName));
    const keysEqual = JSON.stringify(fm.keys) === JSON.stringify(tm.keys);

    const needsRebuild = !keysEqual || !fksEqual || changedColumns.length > 0
      || addedColumns.some((columnName) => toColumns.get(columnName).check !== undefined);

    if (needsRebuild) {
      steps.push(...renderRebuild(name, fromName, fm, tm,
        fromMapping, toMapping, dialect, report));
    }
    else {
      // index diff first (a column cannot drop under a live index);
      // from-side index NAMES survive a rename with the OLD prefix
      const fromPlanIndexes = planEntity(fromName, fm, fromMapping, dialect)
        .expected.indexes;
      const toPlanIndexes = planEntity(name, tm, toMapping, dialect)
        .expected.indexes;
      const disturbed = new Set(droppedColumns);
      const toIndexByName = new Map(toPlanIndexes.map((index) => [index.name, index]));
      const fromIndexByName = new Map(fromPlanIndexes.map((index) => [index.name, index]));
      const indexChanged = (a, b) => a.unique !== b.unique
        || a.columns.join(',') !== b.columns.join(',');
      const indexDies = (index) => !toIndexByName.has(index.name)
        || indexChanged(index, toIndexByName.get(index.name))
        || index.columns.some((column) => disturbed.has(column));
      for (const index of fromPlanIndexes) {
        if (indexDies(index)) {
          steps.push({ kind: 'ddl', sql: dialect.ddl.dropIndex(index.name),
            note: `drop index '${index.name}' on '${name}'` });
        }
      }
      // dropped columns: fold survivors back into the document first
      for (const columnName of droppedColumns) {
        const column = fromColumns.get(columnName);
        const property = toEntity.properties.get(columnName);
        const survives = property !== undefined && column.source !== 'epoch(document)';
        if (survives) {
          const fold = column.storage === 'boolean'
            ? dialect.jsonEncode(`CASE WHEN ${q(columnName)} = 1 THEN 'true' ELSE 'false' END`)
            : q(columnName);
          steps.push({ kind: 'sql',
            sql: `UPDATE ${q(name)} SET ${q('doc')} = `
              + `${dialect.jsonSet(q('doc'), pathText(columnName), fold)} `
              + `WHERE ${q(columnName)} IS NOT NULL`,
            note: `fold '${columnName}' back into the document before dropping its column` });
        }
        else if (property === undefined) {
          report.destructive = true;
        }
        steps.push({ kind: 'ddl', sql: dialect.ddl.dropColumn(name, columnName),
          note: property === undefined
            ? `DESTRUCTIVE: drop column '${columnName}' on '${name}' — the property is gone`
            : `drop column '${columnName}' on '${name}' (the value lives in the document now)` });
      }
      // added columns (plain, check-free by the rebuild rule)
      for (const columnName of addedColumns) {
        const column = toColumns.get(columnName);
        steps.push({ kind: 'ddl',
          sql: dialect.ddl.addColumn({ table: name,
            column: { name: columnName, type: storageType(column.storage) } }),
          note: `add column '${columnName}' on '${name}'` });
        // the VERSION token is engine-owned: a row whose token is NULL
        // never matches the token a save carries, so every update of an
        // already-stored row would refuse `JD2040` forever — re-reading
        // cannot help, because the re-read carries the NULL back. The
        // rows that existed before the token did start where an
        // insert starts it, at 0 (§9.6)
        if (columnName === tm.version) {
          steps.push({ kind: 'sql',
            sql: `UPDATE ${q(name)} SET ${q(columnName)} = 0 WHERE ${q(columnName)} IS NULL`,
            note: `start the version token '${columnName}' on '${name}' for the rows that predate it` });
        }
        const wasDocStored = fromEntity.properties.has(columnName);
        if (wasDocStored && column.source === 'epoch(document)') {
          steps.push({ kind: 'sql',
            sql: `UPDATE ${q(name)} SET ${q(columnName)} = `
              + `${dialect.epochFromRfc3339(docExtract(q('doc'), columnName))} `
              + `WHERE ${docExtract(q('doc'), columnName)} IS NOT NULL`,
            note: `derive the epoch column from the document's '${columnName}' strings` });
        }
        else if (wasDocStored) {
          steps.push({ kind: 'sql',
            sql: `UPDATE ${q(name)} SET ${q(columnName)} = ${docExtract(q('doc'), columnName)}, `
              + `${q('doc')} = ${dialect.jsonRemove(q('doc'), pathText(columnName))} `
              + `WHERE ${docExtract(q('doc'), columnName)} IS NOT NULL`,
            note: `move '${columnName}' out of the document into its column` });
        }
      }
      for (const index of toPlanIndexes) {
        const source = fromIndexByName.get(index.name);
        if (source === undefined || indexDies(source)) {
          steps.push({ kind: 'ddl',
            sql: dialect.ddl.createIndex({ name: index.name, table: name,
              columns: index.columns, unique: index.unique }),
            note: `create index '${index.name}' on '${name}'` });
        }
      }
    }

    // the stripped document-change rule (§9)
    if (canonicalizeJson(stripEntityVocabulary(fromEntity.schema))
      !== canonicalizeJson(stripEntityVocabulary(toEntity.schema))) {
      report.schemaChanged.push(name);
      // an additive, optional-only change leaves every stored document
      // valid, so the plan applies unattended (the ADD COLUMN above is
      // the whole of it)
      if (isWidening(stripEntityVocabulary(fromEntity.schema), stripEntityVocabulary(toEntity.schema))) {
        report.widened.push(name);
      }
      else if (transform !== null && transform.covers(name)) {
        report.transformed.push(name);
        steps.push(...transform.place(name, []));
      }
      else {
        report.drafts.push(name);
        steps.push({
          kind: 'jslt', collection: name, stylesheet: [], draft: true,
          note: `the document schema of entity '${name}' changed; fill in the transform `
            + '(or delete this step if every stored document already validates) and remove "draft"',
        });
      }
    }
  }

  // ————— dropped entities, children before parents —————
  // foreign keys are enforced while a migration runs (node:sqlite has
  // them on by default), so a parent with RESTRICT children cannot go
  // first: the dropped set is ordered so that every entity referencing
  // another dropped entity is dropped before it
  const dropped = [...fromEntities.keys()]
    .filter((name) => !toEntities.has(name) && !consumedOldEntities.has(name));
  const droppedSet = new Set(dropped);
  const references = (name) => new Set(fromMapping.entities[name].foreignKeys
    .map((fk) => fk.references).filter((target) => droppedSet.has(target) && target !== name));
  const dropOrder = [];
  const placed = new Set();
  while (dropOrder.length < dropped.length) {
    // ready: every dropped entity that no other UNPLACED dropped entity references
    const ready = dropped.filter((name) => !placed.has(name)
      && !dropped.some((other) => !placed.has(other) && other !== name && references(other).has(name)));
    if (ready.length === 0) { dropOrder.push(...dropped.filter((name) => !placed.has(name))); break; }
    for (const name of ready) { placed.add(name); dropOrder.push(name); }
  }
  for (const name of dropOrder) {
    report.removed.push(name);
    report.destructive = true;
    steps.push({ kind: 'ddl', sql: dialect.ddl.dropTable(name),
      note: `DESTRUCTIVE: drop entity '${name}' and every row in it` });
  }

  // ————— join tables —————
  const fromJoins = new Set(Object.keys(fromMapping.joinTables).map(renamedJoinName));
  for (const joinName of Object.keys(toMapping.joinTables)) {
    if (fromJoins.has(joinName)) continue;
    for (const sql of planJoinTable(joinName, toMapping.joinTables[joinName],
      toMapping, dialect).createSql) {
      steps.push({ kind: 'ddl', sql, note: `create join table '${joinName}'` });
    }
  }
  const toJoins = new Set(Object.keys(toMapping.joinTables));
  for (const joinName of Object.keys(fromMapping.joinTables)) {
    const finalName = renamedJoinName(joinName);
    if (toJoins.has(finalName)) continue;
    report.destructive = true;
    steps.push({ kind: 'ddl', sql: dialect.ddl.dropTable(finalName),
      note: `DESTRUCTIVE: drop join table '${finalName}' and its memberships` });
  }
}

/**
 * Render one rebuild step (§10): self-contained SQL — the temporary
 * table, the column-mapped copy, the final-name indexes.
 */
function renderRebuild(name, fromName, fm, tm, fromMapping, toMapping, dialect, report) {
  const q = dialect.quoteIdentifier;
  const pathText = (memberName) => dialect.jsonPathText([{ name: memberName }]);
  const temporary = `${name}__rebuild`;
  const create = [planEntity(temporary, tm, toMapping, dialect).createSql[0]];
  const indexes = planEntity(name, tm, toMapping, dialect).createSql.slice(1);

  const fromColumns = new Map(fm.columns.map((column) => [column.name, column]));
  const fromFkOnly = fm.foreignKeys
    .filter((fk) => !fromColumns.has(fk.column)).map((fk) => fk.column);
  const fromHas = (columnName) =>
    fromColumns.has(columnName) || fromFkOnly.includes(columnName);
  const storageType = (storage) => dialect.typeFor(storage, 'generated');

  // the to-table's column order: scalars (non-fk-claimed), then
  // foreign keys, then the document — exactly planEntity's assembly
  const fkNames = new Set(tm.foreignKeys.map((fk) => fk.column));
  const ordered = [
    ...tm.columns.filter((column) => !fkNames.has(column.name))
      .map((column) => ({ name: column.name, column })),
    ...tm.foreignKeys.map((fk) => ({ name: fk.column, column: null })),
  ];

  /** @type {string[]} */
  const targets = [];
  /** @type {string[]} */
  const sources = [];
  let docExpr = q('doc');
  const lost = [];
  // a SQL NULL is an ABSENT member (§9.3): folding it in as JSON null
  // turned every row without the value into a narrowing the target
  // schema refused
  const foldColumn = (expression, columnName, fold) =>
    `CASE WHEN ${q(columnName)} IS NULL THEN ${expression} `
    + `ELSE ${dialect.jsonSet(expression, pathText(columnName), fold)} END`;
  for (const { name: columnName, column } of ordered) {
    targets.push(q(columnName));
    if (fromHas(columnName)) {
      const fromColumn = fromColumns.get(columnName);
      const sameStorage = column === null || fromColumn === undefined
        || fromColumn.storage === column.storage;
      if (column !== null && column.source === 'epoch(document)'
        && fromColumn !== undefined && fromColumn.source !== 'epoch(document)') {
        // plain text column becomes a derived instant: derive from the
        // old column and keep the string in the document — an absent
        // string stays absent (§9.3), never a JSON null
        sources.push(dialect.epochFromRfc3339(q(columnName)));
        docExpr = foldColumn(docExpr, columnName, q(columnName));
      }
      else if (sameStorage) {
        sources.push(q(columnName));
      }
      else {
        sources.push(`CAST(${q(columnName)} AS ${storageType(column.storage)})`);
      }
      continue;
    }
    // a VERSION token the from-table did not carry: the copied rows
    // start where an insert starts it, at 0 (§9.6) — never SQL NULL,
    // which no save's token would match (`JD2040` on every update of a
    // row that predates the token, re-reading included)
    if (columnName === tm.version) {
      sources.push('0');
      continue;
    }
    // a new column: from the document when the property existed there
    sources.push(column !== null && column.source === 'epoch(document)'
      ? dialect.epochFromRfc3339(dialect.jsonExtract(q('doc'), pathText(columnName)))
      : dialect.jsonExtract(q('doc'), pathText(columnName)));
  }
  // columns that vanish: fold survivors into the document, name losses
  for (const [columnName, fromColumn] of fromColumns) {
    if (ordered.some((entry) => entry.name === columnName)) continue;
    const survives = fromColumn.source !== 'epoch(document)'
      && toMapping.entities[name] !== undefined
      && tm.document.includes(columnName);
    if (survives) {
      const fold = fromColumn.storage === 'boolean'
        ? dialect.jsonEncode(`CASE WHEN ${q(columnName)} = 1 THEN 'true' ELSE 'false' END`)
        : q(columnName);
      docExpr = foldColumn(docExpr, columnName, fold);
    }
    else if (fromColumn.source !== 'epoch(document)') {
      lost.push(columnName);
    }
  }
  // an INFERRED foreign-key column (no property of its own) that the
  // target no longer carries: its values are lost unless the target
  // declares the property, in which case they fold into the document —
  // walking the mapped columns alone dropped it without a word
  for (const columnName of fromFkOnly) {
    if (ordered.some((entry) => entry.name === columnName)) continue;
    if (toMapping.entities[name] !== undefined && tm.document.includes(columnName)) {
      docExpr = foldColumn(docExpr, columnName, q(columnName));
    }
    else {
      lost.push(columnName);
    }
  }
  // properties that moved INTO columns leave the document
  for (const { name: columnName, column } of ordered) {
    if (!fromHas(columnName) && (column === null || column.source !== 'epoch(document)'))
      docExpr = dialect.jsonRemove(docExpr, pathText(columnName));
  }
  targets.push(q('doc'));
  sources.push(docExpr);

  if (lost.length > 0) report.destructive = true;
  const copy = `INSERT INTO ${q(temporary)} (${targets.join(', ')}) `
    + `SELECT ${sources.join(', ')} FROM ${q(name)}`;
  return [{
    kind: 'rebuild', table: name, create, copy, indexes,
    note: `rebuild '${name}' (${fromName === name ? '' : `renamed from '${fromName}'; `}`
      + `structural change)${lost.length > 0
        ? ` — DESTRUCTIVE: column(s) ${lost.join(', ')} are dropped with their data` : ''}`,
  }];
}

/**
 * Create a model's WHOLE physical shape on a connection: collections,
 * entity tables and join tables, exactly as `openStore` would. Used
 * by the shadow baseline, the fresh reference database that shape
 * equality compares against, and the tests.
 * @param {any} connection
 * @param {any} model
 * @param {Record<string, any>} [expressions] - the host's declared
 *   index-expression functions, resolved into the DDL the same way the
 *   open path resolves them
 * @returns {any} value-or-promise
 */
export function createModelShape(connection, model, expressions = undefined) {
  const dialect = connection.dialect;
  /** @type {string[]} */
  const statements = [];
  for (const collection of normalizeModel(model, expressions).values()) {
    statements.push(
      ...planCollection(collection.name, collection, dialect,
        mappingFor(connection, expressions)).createSql);
  }
  const entities = normalizeEntities(model);
  if (entities.size > 0) {
    const mapping = explainMapping(model);
    for (const name of Object.keys(mapping.entities)) {
      statements.push(
        ...planEntity(name, mapping.entities[name], mapping, dialect).createSql);
    }
    for (const name of Object.keys(mapping.joinTables)) {
      statements.push(
        ...planJoinTable(name, mapping.joinTables[name], mapping, dialect).createSql);
    }
  }
  const run = (i) => (i >= statements.length
    ? null
    : chain(connection.exec(statements[i]), () => run(i + 1)));
  return run(0);
}

/**
 * The declared schema of a database, normalized through the SQL comparison
 * owner. Physical column order is preserved by default; managed named-column
 * parity may explicitly request `columnOrder: 'ignore'`. Engine-owned objects
 * are excluded, and catalog object order is stable.
 * @param {any} connection
 * @param {import('./schema-sql.js').DeclaredSqlOptions} [options]
 * @returns {any} value-or-promise of `{ type, name, owner, sql }[]`
 */
export function schemaShapeOf(connection, options = undefined) {
  const dialect = connection.dialect;
  return useStatementOnce(connection, dialect.introspect.schemaDump(), (statement) =>
    chain(statement.all([]), (rows) => rows
      // History, change logs, jobs and replication metadata are engine-owned.
      .filter((row) => !ENGINE_TABLES.has(String(row.name)) && !ENGINE_TABLES.has(String(row.owner)))
      .map((row) => ({
        type: String(row.type),
        name: String(row.name),
        owner: String(row.owner),
        sql: comparableDeclaredSql(String(row.sql), options),
      }))));
}

/**
 * Compare a migrated database's schema against the shape a fresh
 * `createModelShape(model)` produces, via a throwaway reference
 * database. Returns `null` when equal, or a one-line difference.
 * @param {any} driver
 * @param {any} connection - the migrated database
 * @param {any} model - the target model
 * @param {((connection: any) => any) | undefined} registerFunctions
 * @returns {any} value-or-promise of `string | null`
 */
export function compareShapeToModel(driver, connection, model, registerFunctions, expressions) {
  // The comparison IS a text comparison: it builds the model's shape in
  // a reference database and compares the two engines' stored CREATE
  // statements. An engine that keeps none has nothing to compare, and
  // says so here rather than reading an undefined statement — the
  // structural drift check (columns, indexes, foreign-key tuples) runs
  // per collection and per entity either way, and `declaredSqlText` is
  // what tells a reader which half they got.
  if (connection.dialect.capabilities.declaredSqlText !== true) return null;
  return withMigrationConnection({ driver, path: ':memory:' }, (reference) =>
    chain(chain(registerDeriveFunctions(reference),
      () => (registerFunctions !== undefined ? registerFunctions(reference) : null)), () => {
      return chain(createModelShape(reference, model, expressions), () =>
          chain(schemaShapeOf(reference, { columnOrder: 'ignore' }), (wanted) =>
            chain(schemaShapeOf(connection, { columnOrder: 'ignore' }), (actual) => {
              const wantedText = JSON.stringify(wanted);
              const actualText = JSON.stringify(actual);
              if (wantedText === actualText) return null;
              const byKey = (rows) => new Map(rows.map(
                (row) => [`${row.type}:${row.name}`, row.sql]));
              const wantedMap = byKey(wanted);
              const actualMap = byKey(actual);
              for (const [key, sql] of wantedMap) {
                if (!actualMap.has(key)) return `missing ${key}`;
                if (actualMap.get(key) !== sql)
                  return `${key} differs: have [${actualMap.get(key)}], want [${sql}]`;
              }
              for (const key of actualMap.keys()) {
                if (!wantedMap.has(key)) return `unexpected ${key}`;
              }
              return 'schemas differ in ordering only';
            })));
    }));
}

/**
 * Count can use the existing provider planner without assuming an intermediate
 * schema. A native plan proves both row selection and item cardinality. Typed
 * aggregates keep ordered engine folds until their current shape is declared.
 */
function assertionProvider(query, collection, shape) {
  if (shape !== '$count') return null;
  const operand = query.$count;
  const document = { $count: typeof operand === 'string' && operand.startsWith('$[*]')
    ? { $for: { row: '$[*]' }, $return: `$row${operand.slice(4)}` } : operand };
  const source = { collection, schema: { type: 'object' }, columnByCanonical: new Map(), indexes: [] };
  const planned = planQuery(document, source);
  return planned.mode === 'native' && planned.plan?.aggregate?.fn === 'count' ? document : null;
}

/**
 * The batched row walk shared by transforms and post-validation:
 * `SELECT rowid, json(doc) ... WHERE rowid > ? ORDER BY rowid LIMIT ?`
 * — bounded memory over a collection of any size.
 * @param {any} connection
 * @param {string} table
 * @param {number} batchSize
 * @param {(rows: { rid: any, doc: string, key: any }[]) => any} handle
 *   value-or-promise per batch
 * @param {boolean} [keyed]
 * @param {any} [entityMapping]
 * @param {() => void} [check] - run before every batch: the
 *   cancellation boundary a data step has between its batches
 * @returns {any}
 */
function walkRows(connection, table, batchSize, handle, keyed = true, entityMapping = null,
  check = undefined) {
  // entity tables carry no 'key' column — the transform walk goes by
  // row identity alone; only the collection walks select the key. An
  // entity's mapped columns ride beside the document so the row can be
  // read WHOLE (`mergeEntityRow`): a transform or an assertion that saw
  // the rest-document alone could not see `id` or `name` at all
  const dialect = connection.dialect;
  const q = dialect.quoteIdentifier;
  if (entityMapping?.document === false)
    return walkPhysicalRows(connection, entityMapping, batchSize, handle, check);
  const rid = dialect.rowIdentity();
  const keySelect = keyed ? `, ${q('key')} AS ${q('k')}` : '';
  const columnSelect = entityMapping === null ? '' : entityColumnsOf(entityMapping)
    .map((column) => `, ${q(column)}`).join('');
  const select = `SELECT ${rid} AS ${q('rid')}, ${dialect.jsonText(q('doc'))} AS ${q('doc')}`
    + `${keySelect}${columnSelect} FROM ${q(table)}`;
  const ordered = ` ORDER BY ${rid} ${dialect.limitClause(batchSize, undefined)}`;
  // An INTEGER PRIMARY KEY can be negative. The first batch has no
  // lower bound; subsequent batches seek from a row actually read.
  return useStatementOnce(connection, select + ordered, (first) => useStatementOnce(connection,
    `${select} WHERE ${rid} > ${dialect.parameterRef(1, 'after')}${ordered}`, (statement) => {
    const nextBatch = (after) => {
      if (check !== undefined) check();
      return chain(after === undefined ? first.all([]) : statement.all([after]), (rows) => {
        if (rows.length === 0) return null;
        return chain(handle(rows), () =>
          nextBatch(rows[rows.length - 1].rid));
      });
    };
    return nextBatch(undefined);
  }));
}

/** The physical columns an entity row carries beside its document. */
function entityColumnsOf(entityMapping) {
  const names = new Set(entityMapping.columns.map((column) => column.name));
  for (const fk of entityMapping.foreignKeys) names.add(fk.column);
  return [...names];
}

/**
 * Resolve the explicitly declared current layout, or the final model when the
 * step carries none. Historical column names belong to their step's model.
 * @param {any} options @param {string} table @param {any} step @param {any} dialect
 * @returns {{ entity: any, mapping: any } | null}
 */
function entityStepMapping(options, table, step, dialect) {
  const model = step?.model ?? options.model;
  if (model === undefined) return null;
  const entities = normalizeEntities(model);
  const entity = entities.get(table);
  if (entity === undefined) {
    if (step?.model !== undefined && !normalizeModel(model, options.expressions).has(table))
      throw refuse('JD0021', `the step model declares no collection or entity '${table}'`);
    return null;
  }
  const all = explainMapping(model), mapping = all.entities[table];
  return { entity, mapping: mapping.document === false
    ? planEntity(table, mapping, all, dialect).physical : mapping };
}

/**
 * The database's foreign-key violations now, as plain rows — `null` where
 * the dialect has no check to run (the engine enforces every reference,
 * or offers no check).
 * @param {any} connection @returns {any} value-or-promise of `any[] | null`
 */
function foreignKeyViolations(connection) {
  const dialect = connection.dialect;
  if (dialect.capabilities.foreignKeysAlwaysOn === true || typeof dialect.pragma?.foreignKeyCheck !== 'function') return null;
  return useStatementOnce(connection, dialect.pragma.foreignKeyCheck(), (statement) => chain(statement.all([]),
    (rows) => rows.map((/** @type {any} */ row) => ({ table: row.table,
      rowid: row.rowid === null || row.rowid === undefined ? null : String(row.rowid),
      parent: row.parent, fkid: row.fkid }))));
}

/** A name as SQLite matches a table name: without regard to ASCII case. @param {string} name */
const tableNameKey = (name) => name.replace(/[A-Z]+/g, (letters) => letters.toLowerCase());

/**
 * The table renames `steps` perform, as one function from a table name to
 * the name the steps leave it under: every `ddl` or `sql` step that is
 * exactly `ALTER TABLE <name> RENAME TO <name>` (quoted, bare or
 * schema-qualified), applied in step order, so a chain of renames ends
 * where its last one does. A `rebuild` or `table` step renames only its own
 * temporary table, which no violation read before it names.
 * @param {readonly any[]} steps
 * @returns {(name: any) => any}
 */
function renamesOf(steps) {
  /** @type {[string, string][]} */
  const renames = [];
  for (const step of steps) {
    if ((step?.kind !== 'ddl' && step?.kind !== 'sql') || typeof step.sql !== 'string') continue;
    const tokens = sqlTokens(step.sql);
    if (tokens.at(-1)?.kind === 'symbol' && tokens.at(-1)?.value === ';') tokens.pop();
    const keyword = (/** @type {number} */ at, /** @type {string} */ value) =>
      tokens[at]?.kind === 'word' && tokens[at].value.toUpperCase() === value;
    const name = (/** @type {number} */ at) =>
      (tokens[at]?.kind === 'word' || tokens[at]?.kind === 'identifier' ? tokens[at].value : undefined);
    const at = tokens[3]?.kind === 'symbol' && tokens[3].value === '.' ? 4 : 2;
    const from = name(at), to = name(at + 3);
    if (keyword(0, 'ALTER') && keyword(1, 'TABLE') && keyword(at + 1, 'RENAME') && keyword(at + 2, 'TO')
      && from !== undefined && to !== undefined && tokens.length === at + 4) renames.push([tableNameKey(from), to]);
  }
  return (name) => {
    let current = name;
    for (const [from, to] of renames) if (typeof current === 'string' && tableNameKey(current) === from) current = to;
    return current;
  };
}

/**
 * The violations `after` holds beyond `before`, compared as whole rows and
 * counted: a WITHOUT ROWID table's violations carry no rowid, so two of
 * them read alike, and one fixed while another appears is still one new.
 *
 * A rename between the two reads changes no reference, so rows compare
 * under the names the renames leave: a `before` row's table through
 * `names.table` (the renames since it was read), and the parent of both
 * through `names.parent` (every rename so far) — a parent is the table
 * its child's `REFERENCES` clause spells, and a rename made with
 * `legacy_alter_table` on (the setting a link that rebuilds runs under)
 * leaves that clause spelling the old name until the child is rebuilt.
 * The rows answered are `after`'s own.
 * @param {any[] | null} before @param {any[]} after
 * @param {{ table?: (name: any) => any, parent: (name: any) => any }} names
 * @returns {any[]}
 */
function introducedViolations(before, after, names) {
  const { table = (/** @type {any} */ name) => name, parent } = names;
  const keyOf = (/** @type {any} */ row, /** @type {boolean} */ earlier) =>
    JSON.stringify({ ...row, table: earlier ? table(row.table) : row.table, parent: parent(row.parent) });
  const seen = new Map();
  for (const row of before ?? []) {
    const key = keyOf(row, true);
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  const introduced = [];
  for (const row of after) {
    const key = keyOf(row, false);
    const left = seen.get(key) ?? 0;
    if (left > 0) seen.set(key, left - 1);
    else introduced.push(row);
  }
  return introduced;
}

/**
 * Run one migration's steps against a connection.
 * @param {any} connection
 * @param {any} migration
 * @param {{ batchSize: number, onProgress?: Function }} options
 * @returns {any} value-or-promise
 */
function runSteps(connection, migration, options) {
  const dialect = connection.dialect;
  const q = dialect.quoteIdentifier;
  const step = (i) => {
    if (i >= migration.steps.length) return null;
    // the cancellation boundary between steps: a refusal here rolls the
    // migration in flight back whole, as any step failure does
    if (options.check !== undefined) options.check();
    const current = migration.steps[i];
    const fail = (reason, cause, verdict = verdictOf(cause)) => {
      throw Object.assign(refuse('JD0023',
        `migration '${migration.id}' step ${i} (${current.kind}) failed: ${reason}`,
        cause), verdict);
    };
    // every step is its own savepoint inside the migration transaction, and
    // whatever it meets leaves it classified (stepFailed)
    return chain(attempt(() => connection.transaction(() => {
      if (current.kind === 'table') return applyTableMigration(connection, current.plan);
      if (current.kind === 'host') return runHostStep(connection, migration, i, current, options);
      if (current.kind === 'ddl' || current.kind === 'sql') {
        // 'sql' is a DATA step spelled directly (§9.4): same execution
        // as ddl, distinct on purpose — dry-run always shows it, and a
        // reviewer reads intent from the kind
        try {
          return connection.exec(current.sql);
        }
        catch (cause) {
          return fail(/** @type {Error} */ (cause).message, /** @type {Error} */ (cause));
        }
      }
      if (current.kind === 'rebuild') {
        // the documented ALTER TABLE procedure (§10): create the new
        // shape under the temporary name, copy, drop, rename, recreate
        // indexes, then PRAGMA foreign_key_check INSIDE the
        // transaction — a reference the rebuild broke fails the migration,
        // one broken before it began is not the rebuild's doing, and
        // neither is a parent an earlier step renamed, which the rebuilt
        // REFERENCES clause names by its new name
        const temporary = `${current.table}__rebuild`;
        const renamedSoFar = renamesOf(migration.steps.slice(0, i));
        const statements = [
          ...current.create,
          current.copy,
          dialect.ddl.dropTable(current.table),
          dialect.ddl.renameTable(temporary, current.table),
          ...current.indexes,
        ];
        /** @type {any[] | null} */
        let before = null;
        const runNext = (j) => {
          if (j >= statements.length) {
            if (before === null) return null;
            return chain(foreignKeyViolations(connection), (after) => {
              const violations = introducedViolations(before, /** @type {any[]} */ (after), { parent: renamedSoFar });
              if (violations.length > 0) {
                fail(`foreign_key_check found ${violations.length} broken reference(s) `
                  + `after rebuilding '${current.table}' `
                  + `(first: ${JSON.stringify(violations[0])})`, undefined, { class: 'constraint', retryable: false });
              }
              return null;
            });
          }
          try {
            return chain(connection.exec(statements[j]), () => runNext(j + 1));
          }
          catch (cause) {
            return fail(/** @type {Error} */ (cause).message, /** @type {Error} */ (cause));
          }
        };
        return chain(foreignKeyViolations(connection), (rows) => { before = rows; return runNext(0); });
      }
      if (current.kind === 'derive') {
        // recompute stored derived columns from the documents already
        // present — the branch where a derived column is an ordinary
        // one the store writes, so an ALTER that adds it leaves every
        // existing row NULL until this runs
        const columns = current.columns;
        const assignments = columns.map((column, at) =>
          `${q(column.name)} = ${dialect.parameterRef(at + 1, column.name)}`);
        const updateSql = `UPDATE ${q(current.collection)} SET ${assignments.join(', ')} `
          + `WHERE ${dialect.rowIdentity()} = ${dialect.parameterRef(columns.length + 1, 'rid')}`;
        let derivedRows = 0;
        return useStatementOnce(connection, updateSql, (update) =>
          chain(walkRows(connection, current.collection, options.batchSize, (rows) =>
            chain(sequentially(rows, (row) =>
              chain(update.run([...derivedValuesOf(columns, JSON.parse(row.doc)), row.rid]), () => { derivedRows++; })),
            () => { options.onProgress?.({
              migration: migration.id,
              collection: current.collection,
              derived: derivedRows,
            }); }), false, null, options.check), () => derivedRows));
      }
      if (current.kind === 'jslt') {
        const stepEntity = entityStepMapping(options, current.collection, current, dialect);
        const operation = compileDocumentStep(current, i, {
          migrationId: migration.id,
          compileJslt: compileJsltStylesheet,
          compileQuery: compileJsonQuery,
          keys: stepEntity === null ? [] : stepEntity.mapping.keys,
        });
        if (stepEntity?.mapping.document === false) {
          return transformPhysicalRows(connection, stepEntity, operation, {
            batchSize: options.batchSize, runtime: options.runtime, check: options.check,
            onProgress: options.onProgress, migration: migration.id, collection: current.collection,
          });
        }
        // an entity row is transformed WHOLE: the mapped columns fold in
        // before the stylesheet and split out after it (documentWriter)
        const mapping = stepEntity?.mapping ?? null;
        let transformed = 0;
        return documentWriter(connection, current.collection, current, stepEntity, options, (write) =>
          chain(walkRows(connection, current.collection, options.batchSize, (rows) =>
            chain(sequentially(rows, (row) => {
              const doc = mapping === null ? JSON.parse(row.doc) : mergeEntityRow(mapping, row, 'doc');
              return chain(write(operation.apply(doc, row.rid), row.rid), () => { transformed++; });
            }), () => { options.onProgress?.({
              migration: migration.id,
              collection: current.collection,
              transformed,
            }); }), false, mapping, options.check), () => transformed));
      }
      // kind === 'query': the assertion step
      const assertionMapping = entityStepMapping(options, current.collection, current, dialect)?.mapping ?? null;
      const operation = compileDocumentStep(current, i, {
        migrationId: migration.id,
        compileJslt: compileJsltStylesheet,
        compileQuery: compileJsonQuery,
        assertionBounds: options.assertionBounds,
      });
      const assertOver = operation.assert;
      const readDoc = (row) => (assertionMapping === null
        ? JSON.parse(row.doc)
        : mergeEntityRow(assertionMapping, row, 'doc'));

      const provider = assertionMapping === null ? assertionProvider(current.assert, current.collection, operation.shape) : null;
      options.onAssertionPlan?.({ ...operation.plan, ...(provider === null ? {} : {
        strategy: 'provider', reason: 'the existing query planner proves a native count without assuming an intermediate schema',
      }) });
      if (provider !== null) {
        const engine = createQueryEngine({
          connection: { ...connection, prepare: (sql, metadata) => temporaryStatement(connection, sql, metadata) },
          state: createQueryState(),
          collection: { name: current.collection, schema: { type: 'object' }, docPath: '' },
          physicalPlan: { table: current.collection, keyColumn: 'key', docColumn: 'doc', columnByCanonical: new Map() },
        });
        return chain(engine.execute(provider, { strict: true }), operation.accept);
      }

      if (operation.fold !== null) {
        // Consume operand items in row order through the query engine's
        // shared state: regrouping floating-point batch totals is unsound.
        let accumulated = operation.fold.start();
        let folded = 0;
        return chain(walkRows(connection, current.collection, options.batchSize, (rows) => {
          accumulated = operation.fold.combine(accumulated, rows.map(readDoc));
          folded += rows.length;
          options.onProgress?.({
            migration: migration.id,
            collection: current.collection,
            asserted: folded,
          });
        }, false, assertionMapping, options.check), () => operation.fold.finish(accumulated));
      }

      if (!operation.perDocument) {
        // materializing: the answer needs every document at once. That is
        // a cost, so it is bounded and the bound is crossed BEFORE the
        // excess is held — the walk stops at the row that would break it
        const guard = createAssertionBoundGuard(options.assertionBounds, current.collection,
          `the assertion of migration '${migration.id}' step ${i}`);
        const gathered = [];
        return chain(walkRows(connection, current.collection, options.batchSize, (rows) => {
          for (const row of rows) {
            const doc = readDoc(row);
            guard.admit(doc, typeof row.doc === 'string' ? row.doc : undefined);
            gathered.push(doc);
          }
        }, false, assertionMapping, options.check), () => assertOver(gathered));
      }
      // per-document: walk in keyset batches like every other step,
      // failing fast at the first batch that violates
      let asserted = 0;
      return walkRows(connection, current.collection, options.batchSize, (rows) => {
        const docs = rows.map(readDoc);
        assertOver(docs);
        asserted += docs.length;
        options.onProgress?.({
          migration: migration.id,
          collection: current.collection,
          asserted,
        });
      }, false, assertionMapping, options.check);
    }), (error) => stepFailed(migration, i, current.kind, error)), () => step(i + 1));
  };
  return step(0);
}

/**
 * Validate the final state against the target model on this
 * connection: physical shape, schema conformance of every stored
 * document (when a `compileSchema` hook is provided — the real-data
 * widening/narrowing FACT), and key-column consistency for
 * caller-keyed collections.
 * @param {any} connection
 * @param {any} model
 * @param {{ compileSchema?: Function, batchSize: number }} options
 * @returns {any} value-or-promise
 */
function validateTargetState(connection, model, options) {
  const collections = [...normalizeModel(model, options.expressions).values()];
  const entities = [...normalizeEntities(model).values()];
  const dialect = connection.dialect;
  // entity tables carry no 'key' column; the batched walk goes by row
  // identity and validates every stored document against the target
  const verifyEntity = (i) => {
    if (i >= entities.length) return null;
    const entity = entities[i];
    const validate = options.compileSchema !== undefined
      ? options.compileSchema(entity.schema)
      : null;
    if (validate === null && entity.physical === null) return verifyEntity(i + 1);
    // the WHOLE document — mapped columns folded in — is what the target
    // schema judges; the rest-document alone failed every entity whose
    // required members are columns, so a pure widening could not land
    const entityMapping = explainMapping(model).entities[entity.name];
    return chain(entity.physical === null ? null : chain(readSchema(connection), (schema) =>
      verifyPhysical(connection, planEntity(entity.name, entityMapping, explainMapping(model), dialect).physical, schema)), () =>
      chain(walkRows(connection, entityMapping.table, options.batchSize, (rows) => {
      for (const row of rows) {
        const outcome = validate === null ? true : validate(mergeEntityRow(entityMapping, row, 'doc'));
        const valid = outcome === true || outcome?.valid === true;
        if (!valid) {
          throw refuse('JD0021',
            `entity '${entity.name}': a stored document (row ${row.rid}) does not `
            + 'validate against the target schema — a narrowing needs a data transform');
        }
      }
    }, false, entityMapping), () => verifyEntity(i + 1)));
  };
  const verifyNext = (i) => {
    if (i >= collections.length) return null;
    const collection = collections[i];
    const plan = planCollection(collection.name, collection, dialect,
      mappingFor(connection, options.expressions));
    const validate = options.compileSchema !== undefined
      ? options.compileSchema(collection.schema)
      : null;
    return chain(verifyShape({ ...connection, prepare: (sql, metadata) => temporaryStatement(connection, sql, metadata) },
      plan, collection.name, collection.docPath), () =>
      chain(walkRows(connection, collection.name, options.batchSize, (rows) => {
        for (const row of rows) {
          const doc = JSON.parse(row.doc);
          if (validate !== null) {
            const outcome = validate(doc);
            const valid = outcome === true || outcome?.valid === true;
            if (!valid) {
              throw refuse('JD0021',
                `collection '${collection.name}': the stored document under key `
                + `'${String(row.k)}' does not validate against the target schema — `
                + 'a narrowing needs a data transform');
            }
          }
          if (collection.keySegments !== null) {
            let node = doc;
            for (const segment of collection.keySegments) node = node?.[segment.name];
            // the stored key text names the document's key: equal, its
            // canonical text, or the spelling an earlier node write stored
            // for a number ('1.0') — never "a transform changed the key"
            if (!storedKeyMatches(node, row.k)) {
              throw refuse('JD0023',
                `collection '${collection.name}': a transform changed the key member `
                + `of '${String(row.k)}' — key changes are not supported in ${MIGRATION_VERSION}`);
            }
          }
        }
      }), () => verifyNext(i + 1)));
  };
  return chain(verifyNext(0), () => verifyEntity(0));
}

/** One target-model acceptance owner for apply, adoption and the replay boundary. */
function acceptMigrationModel(connection, model, options, driver, physical, target) {
  if (model === undefined) return null;
  return chain(validateTargetState(connection, model, options), () => {
    const entities = normalizeEntities(model);
    if (entities.size === 0 || physical || target !== undefined || [...entities.values()].some((entity) => entity.physical)) return null;
    if (typeof driver?.open !== 'function') throw refuse('JD0021', 'borrowed model comparison requires shadowDriver or a complete physicalTarget');
    return chain(compareShapeToModel(driver, connection, model, options.registerFunctions, options.expressions), (difference) => {
      if (difference !== null) throw refuse('JD0023', `the migrated shape does not equal the target model's: ${difference}`);
    });
  });
}

/** Read every normal receipt field and raw side payload without changing either.
 * Numeric fields are database-produced decimal text, including rowid/rid.
 * @param {{driver?: any, path?: string, connection?: any}} target
 * @param {{signal?: AbortSignal, deadline?: number, runtime?: any}} [options]
 * @returns {any} Synchronous for borrowed synchronous connections; promised when owned. */
export function migrationHistory(target, options = {}) {
  let check;
  try {
    readOptions(options, ['runtime', 'signal', 'deadline'], 'migrationHistory()');
    readControls({ signal: options?.signal }, 'migrationHistory()');
    const runtime = resolveRuntime(options.runtime);
    check = () => refuseCancelled({ signal: options.signal, deadline: options.deadline }, runtime.now,
      { abortCode: 'JD2080', aborted: 'it ran', passed: 'the history read ran', ran: 'no receipt changed' });
    check();
  }
  catch (error) { if (target?.connection !== undefined) throw error; return Promise.reject(error); }
  return attempt(() => withMigrationConnection(target, (connection) => {
    if (connection.mustQueue) throw refuse('JD0021', 'history needs an exclusively available connection or its owning transaction scope');
    return chain(readMigrationHistory(connection), (observed) => { check(); return observed; });
  }), (error) => runFailure(error, 'the migration history could not be read'));
}

/** Attest exactly the complete applied legacy prefix and its current model.
 * Only side metadata is written; original history values and artifacts remain
 * unchanged. An identical attestation, including its original observation, is a no-op.
 * @param {{driver?: any, path?: string, connection?: any}} target
 * @param {any[]} migrations
 * @param {{observed: any, model: any, physicalTarget?: any, shadowDriver?: any,
 * registerFunctions?: Function, compileSchema?: Function, expressions?: any,
 * batchSize?: number, runtime?: any, signal?: AbortSignal, deadline?: number}} options
 * @returns {any} `{adopted, unchanged}` receipt counts, value-or-promise. */
export function adoptMigrationHistory(target, migrations, options) {
  readOptions(options, ['observed', 'model', 'physicalTarget', 'shadowDriver', 'registerFunctions',
    'compileSchema', 'expressions', 'batchSize', 'runtime', 'signal', 'deadline'], 'adoptMigrationHistory()');
  readControls({ signal: options?.signal }, 'adoptMigrationHistory()');
  if (!Array.isArray(migrations) || migrations.length === 0)
    throw new TypeError('adoptMigrationHistory needs the complete nonempty applied legacy migration list');
  if (options?.model === undefined || options?.observed === undefined)
    throw new TypeError('adoptMigrationHistory needs { observed, model }: a reviewed history observation and its current model');
  const batchSize = options.batchSize ?? 500;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) throw new TypeError('batchSize must be a positive safe integer');
  let check, header, expected, selectedTarget;
  try {
    [migrations, options] = snapshotMigrationInputs(migrations, options);
    checkHistoryObservation(options.observed);
    if (migrations.length !== options.observed.history.rows.length || migrations.some((migration) => migration?.$migration !== '0.1'))
      throw refuse('JD0022', 'adoption requires exactly the complete applied legacy 0.1 prefix, with no pending tail');
    checkAppliedRows(options.observed, migrations);
    normalizeModel(options.model, options.expressions);
    normalizeEntities(options.model);
    selectedTarget = options.physicalTarget ?? migrations.at(-1)?.physical?.target;
    if (selectedTarget !== undefined) physicalTargetOf(selectedTarget);
    if (migrations.some((migration) => migration.physical) && selectedTarget === undefined)
      throw refuse('JD0021', 'adopting physical migration history requires its complete current physicalTarget');
    header = historyHeader(migrations.length, modelIdentity(options.model),
      selectedTarget === undefined ? null : canonicalizeJson(selectedTarget), JSON.stringify(options.model));
    if (migrations.at(-1).to !== hashContent(header.legacyModel))
      throw refuse('JD0020', 'the attested model does not match the legacy history boundary');
    checkHistoryChain(migrations, migrations.length, header, { model: options.model });
    expected = identityRows(migrations, options.observed.history.rows, header);
    const runtime = resolveRuntime(options.runtime);
    check = () => refuseCancelled({ signal: options.signal, deadline: options.deadline }, runtime.now,
      { abortCode: 'JD2080', aborted: 'its next receipt', passed: 'its next receipt', ran: 'no partial adoption committed' });
    check();
  }
  catch (error) { if (target?.connection !== undefined) throw error; return Promise.reject(error); }
  return attempt(() => withMigrationConnection(target, (connection) => {
    if (connection.mustQueue) throw refuse('JD0021', 'adoption needs an exclusively available connection or its owning transaction scope');
    return chain(migrationWriterSettings(connection, check), () => chain(registerDeriveFunctions(connection), () =>
      chain(options.registerFunctions?.(connection), () => connection.transaction((scope) => {
        check();
        return chain(lockMigration(scope, check), () => chain(readMigrationHistory(scope, true), (current) => {
          check();
          if (current.dialect !== options.observed.dialect || current.order !== options.observed.order
            || canonicalizeJson(current.history) !== canonicalizeJson(options.observed.history))
            throw refuse('JD0022', 'migration history changed since the supplied observation; observe and review it again');
          checkAppliedRows(current, migrations);
          if (current.identity.present) {
            checkHistoryIdentity(current, migrations);
            if (canonicalizeJson(current.identity.rows) !== canonicalizeJson(expected)
              || options.observed.identity.present && canonicalizeJson(options.observed.identity) !== canonicalizeJson(current.identity))
              throw refuse('JD0022', 'migration identity differs from this exact legacy attestation');
          }
          else if (options.observed.identity.present)
            throw refuse('JD0022', 'migration identity changed since the supplied observation');
          const accepted = chain(acceptMigrationModel(scope, options.model, { ...options, batchSize },
            options.shadowDriver ?? target.driver, migrations.at(-1).physical, selectedTarget), () => selectedTarget === undefined ? null
            : chain(comparePhysicalTarget(scope, selectedTarget), (difference) => {
              if (difference !== null) throw refuse('JD0023', `the adopted physical target differs: ${difference}`);
            }));
          return chain(accepted, () => {
            check();
            if (current.identity.present) return { adopted: 0, unchanged: migrations.length };
            return chain(scope.exec(historyStatements(scope.dialect).createIdentity), () =>
              chain(writeIdentityRows(scope, expected, check), () => chain(readMigrationHistory(scope, true), (recorded) => {
                check();
                checkHistoryIdentity(recorded, migrations);
                if (canonicalizeJson(recorded.history) !== canonicalizeJson(current.history)
                  || canonicalizeJson(recorded.identity.rows) !== canonicalizeJson(expected))
                  throw refuse('JD0022', 'adoption did not preserve its complete observed history and exact receipt set');
                return { adopted: migrations.length, unchanged: 0 };
              })));
          });
        }));
      }, options.signal, 'immediate'))));
  }), (error) => runFailure(error, 'migration history could not be adopted'));
}

/**
 * Replay through the same history and transaction owner on a disposable
 * connection. The default initializer creates an empty model shape; an explicit
 * fixture can instead supply populated historical tables and programs. The
 * primary remains untouched until replay and target acceptance pass.
 * @param {any} primary
 * @param {any} driver
 * @param {string} shadowPath
 * @param {any} baseline
 * @param {any[]} migrations
 * @param {any} model - target model or undefined
 * @param {any} options
 * @returns {any} value-or-promise
 */
function replayOnShadow(primary, driver, shadowPath, baseline, migrations, model, options, replay) {
  const independent = { ...driver, open: (...args) => chain(driver.open(...args), (shadow) => {
    // An injected opener returning the borrowed primary never transfers its
    // ownership: reject before the cleanup bracket could close that handle.
    if (shadow === migrationOwnerOf(primary) || shadow.mustQueue)
      throw refuse('JD0021', 'shadow replay needs a different, exclusively available connection from the primary');
    return shadow;
  }) };
  return withMigrationConnection({ driver: independent, path: shadowPath }, (shadow) =>
    chain(verifyShadowOwnership(primary, shadow, driver, migrations.some((migration) => migration.physical?.dialect === 'postgres')), () => chain(emptyShadowHistory(shadow), () => chain(registerDeriveFunctions(shadow), () => chain(options.registerFunctions?.(shadow), () =>
      chain(options.shadowFixture === undefined ? createModelShape(shadow, baseline, options.expressions)
        : options.shadowFixture(shadow), () => chain(emptyShadowHistory(shadow), () => runMigration({ connection: shadow }, migrations, {
        batchSize: options.batchSize, assertionBounds: options.assertionBounds,
        onProgress: options.onProgress, onAssertionPlan: options.onAssertionPlan,
        expressions: options.expressions, compileSchema: options.compileSchema,
        physicalTarget: options.physicalTarget, signal: options.signal,
        deadline: options.deadline, runtime: options.runtime,
        baseline, model, shadow: false, shadowDriver: driver,
        shadowFixture: undefined, hosts: shadowHosts(options.hosts),
        registerFunctions: options.registerFunctions === undefined ? undefined
          : (reference) => reference === shadow ? null : options.registerFunctions(reference),
      }, replay))))))));
}

/** A fixture can seed application data, never receipts that skip replay. */
function emptyShadowHistory(connection) {
  return chain(readMigrationHistory(connection, true), (observed) => {
    if (observed.history.rows.length || observed.identity.present)
      throw refuse('JD0022', 'shadow replay requires empty migration history and no identity metadata before and after its fixture');
  });
}

/** The hosts a shadow replay runs: the same code, told it is the shadow.
 * @param {any} hosts @returns {any} */
function shadowHosts(hosts) {
  if (hosts === undefined) return undefined;
  return Object.fromEntries(Object.entries(hosts).map(([name, host]) => [name, {
    version: host.version, run: (/** @type {any} */ scope, /** @type {any} */ ctx) => host.run(scope, { ...ctx, shadow: true }) }]));
}

/**
 * Report a database's migration state without touching it — the
 * history table is probed, never created, so a fresh file stays byte
 * for byte what it was: what is applied, what is pending, whether an
 * applied migration was edited, and — once the chain is fully applied —
 * whether the physical shape DRIFTED from the model (someone changed
 * the database by hand, §12).
 * @param {{ driver?: any, path?: string, connection?: any }} target
 * @param {any[]} migrations - the full ordered list
 * @param {{ model?: any, physicalTarget?: any, shadowDriver?: any,
 *   registerFunctions?: (connection: any) => any,
 *   signal?: AbortSignal, deadline?: number,
 *   runtime?: Partial<import('@jarenjs/core/runtime').Runtime> }} options
 *   - `signal`/`deadline` refuse a call already cancelled (`JD2080`) or
 *   past its deadline (`JD2075`) on the runtime record's clock
 * @returns {any} value-or-promise of applied/pending/drift/upToDate;
 *   a borrowed synchronous connection stays synchronous with a physical target
 */
export function migrationStatus(target, migrations, options = {}) {
  try {
    readOptions(options, ['model', 'physicalTarget', 'shadowDriver', 'registerFunctions', 'runtime', 'signal', 'deadline'], 'migrationStatus()');
    readControls({ signal: options?.signal }, 'migrationStatus()');
    if (Array.isArray(migrations)) [migrations, options] = snapshotMigrationInputs(migrations, options);
    refuseCancelled({ signal: options.signal, deadline: options.deadline }, resolveRuntime(options.runtime).now,
      { abortCode: 'JD2080', aborted: 'it ran', passed: 'the status read ran', ran: 'no step ran' });
  }
  catch (error) { if (target?.connection !== undefined) throw error; return Promise.reject(error); }
  if (!Array.isArray(migrations)) throw new TypeError('migrationStatus needs the full ordered migration list');
  // a driver failure — a file that will not open, one that is not a
  // database — is classified as a run's is (JD0023), never the binding's own
  return attempt(() => withMigrationConnection(target, (connection) => {
    if (connection.mustQueue) throw refuse('JD0021', 'status needs an exclusively available connection or its owning transaction scope');
    return chain(registerDeriveFunctions(connection), () => chain(readMigrationHistory(connection, true), (observed) => {
        const rows = observed.history.rows;
        const header = checkHistoryIdentity(observed, migrations);
        checkHistoryChain(migrations, rows.length, header, options, undefined, true);
        const applied = rows.map((row) => String(row.id));
        const pending = migrations.slice(rows.length).map((migration) => String(migration.id));
        // a receipt that anchors an adopted history: the first applied
        // document, which moves no shape and runs nothing
        const first = migrations[0];
        const baseline = rows.length > 0 && first?.from === first?.to && Array.isArray(first?.steps) && first.steps.length === 0
          ? String(first.id) : null;
        if (pending.length > 0) return { applied, pending, drift: null, upToDate: false, baseline };
        const physicalTarget = options.physicalTarget ?? migrations.at(-1)?.physical?.target
          ?? (migrations.length === header.legacyCount && header.legacyTarget !== null ? JSON.parse(header.legacyTarget) : undefined);
        if (physicalTarget === undefined && options.model === undefined)
          return { applied, pending, drift: null, upToDate: true, baseline };
        const driver = options.shadowDriver ?? target.driver;
        if (physicalTarget === undefined && typeof driver?.open !== 'function')
          throw refuse('JD0021', 'borrowed model comparison requires shadowDriver or a complete physicalTarget');
        return chain(physicalTarget !== undefined ? comparePhysicalTarget(connection, physicalTarget)
          : compareShapeToModel(driver, connection, options.model, options.registerFunctions),
        (difference) => ({ applied, pending, drift: difference, upToDate: difference === null, baseline }));
      }));
  }), (error) => runFailure(error, 'the migration status could not be read'));
}

/**
 * Apply pending migrations to a database.
 *
 * The contract: `migrations` is the FULL ordered list (applied and
 * pending — the migrations directory); `baseline` is the model the
 * store was first created with (the chain's anchor and the shadow's
 * starting shape); `model` is the target model the code now carries.
 * Each pending migration runs in ONE exclusive transaction with a
 * savepoint per step; a failing step rolls the whole migration back.
 * The whole chain replays on a `:memory:` shadow before the real
 * store is touched.
 *
 * @param {{ driver?: any, path?: string, busyTimeout?: number, connection?: any }} target
 * @param {any[]} migrations
 * @param {{ baseline: any, model?: any, compileSchema?: Function,
 *   dryRun?: boolean, batchSize?: number, onProgress?: Function,
 *   shadow?: boolean, shadowPath?: string, shadowDriver?: any,
 *   shadowFixture?: Function, physicalTarget?: any,
 *   registerFunctions?: Function, expressions?: any,
 *   assertionBounds?: any, onAssertionPlan?: Function,
 *   signal?: AbortSignal, deadline?: number,
 *   runtime?: Partial<import('@jarenjs/core/runtime').Runtime> }} options
 *   `signal` and `deadline` cancel between migrations, steps and
 *   batches (`JD2080` / `JD2075`, the deadline read against `runtime`'s
 *   clock); a cancelled migration rolls back whole and the completed
 *   ones stand.
 *   `runtime` is the host's runtime record: the clock every applied
 *   migration is stamped with, and the clock and identifiers an entity
 *   step's `default: 'now'` / `default: 'uuid'` fill; the platform's own
 *   when absent
 * @returns {any} Owned targets return a promise. Borrowed synchronous targets
 *   with shadow:false and synchronous hooks settle in their caller's transaction.
 */
export function migrate(target, migrations, options) {
  return runMigration(target, migrations, options);
}

/** The replay authority is created only after primary exact receipt verification. */
function runMigration(target, migrations, options, replay = undefined) {
  readOptions(options, ['baseline', 'model', 'compileSchema', 'dryRun', 'batchSize', 'onProgress',
    'shadow', 'shadowPath', 'shadowDriver', 'shadowFixture', 'physicalTarget', 'registerFunctions',
    'expressions', 'assertionBounds', 'onAssertionPlan', 'signal', 'deadline', 'runtime', 'hosts', 'atomic'], 'migrate()');
  readControls({ signal: options?.signal }, 'migrate()');
  if (!target || typeof target !== 'object' || (target.connection === undefined && typeof target.driver?.open !== 'function'))
    throw new TypeError('migrate needs { driver, path? } or { connection }');
  if (!Array.isArray(migrations)) throw new TypeError('migrate needs the full ordered migration list');
  if (!options || typeof options !== 'object' || options.baseline === undefined)
    throw new TypeError('migrate needs { baseline }: the model the store was first created with');
  const batchSize = options.batchSize ?? 500;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) throw new TypeError('batchSize must be a positive safe integer');
  if (options.shadowFixture !== undefined && typeof options.shadowFixture !== 'function') throw new TypeError('shadowFixture must initialize a disposable connection');
  try { [migrations, options] = snapshotMigrationInputs(migrations, options); }
  catch (error) { if (target.connection !== undefined) throw error; return Promise.reject(error); }
  const runtime = resolveRuntime(options.runtime);
  const check = () => refuseCancelled({ signal: options.signal, deadline: options.deadline }, runtime.now, {
    abortCode: 'JD2080', aborted: 'its next step', passed: 'its next step',
    ran: 'no further step ran; a migration in flight rolled back whole and a rerun resumes from the recorded position',
  });
  const hosts = readHosts(options.hosts);
  if (options.atomic !== undefined && typeof options.atomic !== 'boolean') throw new TypeError('atomic must be a boolean');
  const atomic = options.atomic === true;
  // what the steps and the shadow's replay read; the shadow replays link by
  // link — its last link makes the same final check an atomic run makes at
  // its end — so `atomic` stays the primary's
  const runOptions = { batchSize, assertionBounds: normalizeAssertionBounds(options.assertionBounds),
    onProgress: options.onProgress, onAssertionPlan: options.onAssertionPlan,
    registerFunctions: options.registerFunctions, expressions: options.expressions,
    compileSchema: options.compileSchema, physicalTarget: options.physicalTarget,
    shadowFixture: options.shadowFixture, model: options.model, hosts,
    signal: options.signal, deadline: options.deadline, runtime, check };
  try { check(); }
  catch (error) { if (target.connection !== undefined) throw error; return Promise.reject(error); }
  if (options.physicalTarget !== undefined) physicalTargetOf(options.physicalTarget);
  const referenceDriver = options.shadowDriver ?? target.driver;
  // whatever a run meets leaves migrate() classified: a driver error is
  // JD0023 with its class, never the binding's own error
  return attempt(() => withMigrationConnection(target, (connection) => {
    if (connection.mustQueue) throw refuse('JD0021', 'migration needs an exclusively available connection or its owning transaction scope');
    return chain(migrationWriterSettings(connection, check), () => chain(registerDeriveFunctions(connection), () => chain(options.registerFunctions?.(connection), () => {
      check();
      const dialect = connection.dialect, statements = historyStatements(dialect);
      let historyExists = false;
      return chain(readMigrationHistory(connection, true), (observed) => {
        const appliedRows = observed.history.rows;
        const header = checkHistoryIdentity(observed, migrations, replay);
        const endpoint = checkHistoryChain(migrations, appliedRows.length, header, options, replay);
        const expectedFrom = endpoint.shape;
        let expectedRows = appliedRows, expectedSide = observed.identity;
        historyExists = observed.history.present;
        const verifyHistory = (scope, count) => chain(readMigrationHistory(scope, true), (current) => {
          if (current.history.rows.length !== count
            || canonicalizeJson(current.history.rows) !== canonicalizeJson(expectedRows)
            || canonicalizeJson(current.identity) !== canonicalizeJson(expectedSide))
            throw refuse('JD0022', 'migration history changed while acquiring its writer; no step ran');
          checkHistoryIdentity(current, migrations, replay);
        });
        const pending = migrations.slice(appliedRows.length);
        for (const migration of pending) checkPreservationPlan(migration, dialect);
        const finalTarget = options.physicalTarget ?? migrations.at(-1)?.physical?.target
          ?? (migrations.length === header.legacyCount && header.legacyTarget !== null ? JSON.parse(header.legacyTarget) : undefined);
        const acceptTarget = (scope, targetShape) => targetShape === undefined ? null
          : chain(comparePhysicalTarget(scope, targetShape), (difference) => {
            if (difference !== null) throw refuse('JD0023', `the migrated physical target differs: ${difference}`);
          });
        if (pending.length === 0) {
          const result = { applied: [], skipped: appliedRows.map((row) => row.id), upToDate: true };
          return finalTarget === undefined ? result : connection.transaction((scope) =>
            chain(lockMigration(scope, check), () => chain(verifyHistory(scope, appliedRows.length), () => chain(acceptTarget(scope, finalTarget), () => result))), options.signal, 'immediate');
        }
        // every host step the run will execute has its host at the version
        // its document names: the pending ones here, and — since the shadow
        // replays the whole chain from the baseline — every one there
        for (const migration of options.shadow === false ? pending : migrations) {
          migration.steps.forEach((step, index) => {
            if (step?.kind !== 'host') return;
            const host = hosts[step.run];
            if (host === undefined || host.version !== step.version) throw hostRefusal(migration, index, step, host);
          });
        }
        // a rebuild changes the connection's foreign-key setting outside any
        // transaction, so a link that rebuilds cannot share one with another
        const bracketed = (migration) => migration.steps.some((s) => s.kind === 'rebuild' || s.kind === 'table' && s.plan.rebuild)
          && dialect.capabilities.foreignKeysAlwaysOn !== true;
        const rebuilding = atomic ? pending.find(bracketed) : undefined;
        if (rebuilding !== undefined) {
          throw refuse('JD0026', `migration '${rebuilding.id}' rebuilds a table, which changes the connection's `
            + 'foreign-key setting outside any transaction — an atomic run cannot hold it; run the chain without atomic');
        }
        if (pending.some((m) => m.physical) && options.shadow !== false && options.shadowFixture === undefined)
          throw refuse('JD0021', 'physical preservation plans require shadow:false or an explicit shadowFixture initializer');
        if (options.shadow !== false && (typeof referenceDriver?.open !== 'function'
          || options.shadowPath !== undefined && options.shadowPath !== ':memory:'
            && target.path !== undefined && options.shadowPath === target.path))
          throw refuse('JD0021', 'shadow replay needs an independent driver and disposable path');
        const shadowRun = options.shadow === false ? null : replayOnShadow(connection, referenceDriver,
          options.shadowPath ?? ':memory:', options.baseline, migrations, options.model, runOptions,
          header.legacyCount === 0 ? undefined : { header, documents: migrations.slice(0, header.legacyCount).map(canonicalizeJson) });
        return chain(shadowRun, () => {
          if (options.dryRun === true) {
            const rendered = [], counts = {};
            const collect = (i) => {
              if (i >= pending.length) return null;
              const migration = pending[i];
              for (const migrationStep of migration.steps) {
                if (migrationStep.kind === 'ddl') rendered.push(migrationStep.sql);
                else if (migrationStep.kind === 'sql') rendered.push(`-- data step (sql): ${migrationStep.note ?? ''}`, migrationStep.sql);
                else if (migrationStep.kind === 'table') rendered.push(`-- guarded table '${migrationStep.plan.table}'`, ...migrationStep.plan.statements, ...migrationStep.plan.finish);
                else if (migrationStep.kind === 'rebuild') {
                  rendered.push(`-- rebuild '${migrationStep.table}' (§10 procedure)`, ...migrationStep.create,
                    migrationStep.copy, dialect.ddl.dropTable(migrationStep.table),
                    dialect.ddl.renameTable(`${migrationStep.table}__rebuild`, migrationStep.table), ...migrationStep.indexes);
                  if (dialect.capabilities.foreignKeysAlwaysOn !== true) rendered.push(dialect.pragma.foreignKeyCheck());
                }
                else if (migrationStep.kind === 'jslt') rendered.push(`-- jslt transform over '${migrationStep.collection}'`);
                else if (migrationStep.kind === 'host') {
                  rendered.push(`-- host step '${migrationStep.run}' (version ${migrationStep.version})`
                    + `${migrationStep.note === undefined ? '' : `: ${migrationStep.note}`}`);
                }
                else {
                  const operation = compileDocumentStep(migrationStep, migration.steps.indexOf(migrationStep), {
                    migrationId: migration.id, compileJslt: compileJsltStylesheet, compileQuery: compileJsonQuery,
                    assertionBounds: runOptions.assertionBounds,
                  });
                  const strategy = assertionProvider(migrationStep.assert, migrationStep.collection, operation.shape) === null ? operation.strategy : 'provider';
                  rendered.push(`-- assert over '${migrationStep.collection}' (${strategy}; ${operation.reason})`);
                }
              }
              const transforms = migration.steps.filter((s) => s.kind === 'jslt');
              const count = (j) => {
                if (j >= transforms.length) return null;
                const current = transforms[j], mapping = entityStepMapping(runOptions, current.collection, current, dialect);
                const table = mapping?.mapping.table ?? current.collection;
                // Preview reads current relations; earlier planned SQL may create
                // this table/view or change its rows, but is not executed here.
                return chain(useStatementOnce(connection, dialect.introspect.tables(), (catalog) => catalog.all([])), (relations) => {
                  if (!relations.some((relation) => String(relation.name) === table)) {
                    setObjectMember(counts, current.collection, null);
                    return count(j + 1);
                  }
                  return chain(useStatementOnce(connection,
                    `SELECT COUNT(*) AS ${dialect.quoteIdentifier('n')} FROM ${dialect.quoteIdentifier(table)}`,
                    (statement) => statement.get([])), (row) => { setObjectMember(counts, current.collection, row.n); return count(j + 1); });
                });
              };
              return chain(count(0), () => collect(i + 1));
            };
            return chain(collect(0), () => ({ dryRun: true, pending: pending.map((m) => m.id),
              statements: rendered, counts, shadowValidated: options.shadow !== false }));
          }
          const applied = [];
          // the checks the chain's end makes: the model's real-data
          // validation and its shape, against the last link
          const finalChecks = (scope, migration) => acceptMigrationModel(scope, options.model,
            { compileSchema: options.compileSchema, batchSize, expressions: options.expressions,
              registerFunctions: options.registerFunctions }, referenceDriver, migration.physical, finalTarget);
          const record = (scope, migration) => chain(readMigrationHistory(scope, true), (current) => {
            const rows = current.history.rows, at = expectedRows.length;
            if (rows.length !== at + 1 || rows[at].id !== migration.id
              || canonicalizeJson(rows.slice(0, at)) !== canonicalizeJson(expectedRows)
              || canonicalizeJson(current.identity) !== canonicalizeJson(expectedSide))
              throw refuse('JD0022', 'a migration changed its existing history or identity metadata');
            checkAppliedRows(current, migrations);
            const entries = [{ key: `receipt:${at}`, value: canonicalizeJson({
              document: canonicalizeJson(migration), row: canonicalizeJson(rows[at]),
            }) }];
            const publish = replay === undefined ? !current.identity.present : at + 1 === header.legacyCount;
            if (publish) entries.push({ key: 'header', value: canonicalizeJson(header) });
            return chain(current.identity.present ? null : scope.exec(statements.createIdentity), () =>
              chain(writeIdentityRows(scope, entries, check), () => chain(readMigrationHistory(scope, true), (recorded) => {
                checkHistoryIdentity(recorded, migrations, replay);
                expectedRows = recorded.history.rows;
                expectedSide = recorded.identity;
              })));
          });
          // a link ends with the database's own foreign-key check, before its
          // history row: a reference a step broke refuses the link, listed.
          // The check reads the whole database, so it is taken before the
          // steps too, in the same transaction: a violation already there (an
          // orphan written while enforcement was off) is not the link's doing,
          // under the name the link's renames leave its table and parent
          const foreignKeyCheck = (scope, migration, before) => (before === null ? null
            : chain(foreignKeyViolations(scope), (after) => {
              const renamed = renamesOf(migration.steps);
              const violations = introducedViolations(before, /** @type {any[]} */ (after), { table: renamed, parent: renamed });
              if (violations.length === 0) return null;
              const listed = violations.slice(0, 10);
              throw Object.assign(refuse('JD0023', `migration '${migration.id}' leaves ${violations.length} foreign-key `
                + `violation(s): ${JSON.stringify(listed)}${violations.length > listed.length ? ' …' : ''}`),
              { class: 'constraint', retryable: false });
            }));
          // one link's work in the transaction or savepoint it is given: the
          // foreign-key baseline, its steps, its physical checks, the
          // foreign-key check, its history row — and, for the chain's last
          // link, the final checks
          const linkWork = (scope, migration, final) => {
            let allocations;
            /** @type {any[] | null} */
            let violationsBefore = null;
            let work = chain(foreignKeyViolations(scope), (rows) => { violationsBefore = rows; });
            work = chain(work, () => (migration.physical
              ? chain(verifyPreservation(scope, migration.physical, false), (state) => { allocations = state; }) : null));
            work = chain(work, () => historyExists ? null : chain(scope.exec(statements.create), () => { historyExists = true; }));
            work = chain(work, () => runSteps(scope, migration, runOptions));
            work = chain(work, () => migration.physical ? verifyPreservation(scope, migration.physical, true, allocations) : null);
            work = chain(work, () => acceptTarget(scope, final ? finalTarget : migration.physical?.target));
            work = chain(work, () => final ? finalChecks(scope, migration) : null);
            work = chain(work, () => foreignKeyCheck(scope, migration, violationsBefore));
            if (replay !== undefined && expectedRows.length + 1 === header.legacyCount) {
              const legacyTarget = header.legacyTarget === null ? undefined : JSON.parse(header.legacyTarget);
              work = chain(work, () => chain(acceptTarget(scope, legacyTarget), () =>
                acceptMigrationModel(scope, JSON.parse(header.legacyModelSource), runOptions, referenceDriver, migration.physical, legacyTarget)));
            }
            return chain(work, () => chain(useStatementOnce(scope, statements.insert, (insert) =>
              insert.run([migration.id, runtime.now(), migration.from, migration.to, migrationChecksum(migration), migration.steps.length])),
            () => record(scope, migration)));
          };
          // link by link: each commits on its own, and the last makes the final checks
          const applyNext = (i) => {
            if (i >= pending.length) return null;
            check();
            const migration = pending[i], last = i === pending.length - 1;
            const body = (scope) => {
              check();
              // Admission may have waited behind a different process. Never rerun
              // a body using receipts read before that process committed.
              return chain(lockMigration(scope, check), () => chain(verifyHistory(scope, appliedRows.length + applied.length), () =>
                linkWork(scope, migration, last)));
            };
            const transaction = () => connection.transaction(body, options.signal, 'immediate');
            return chain(attempt(() => bracketed(migration) ? withForeignKeySettings(connection, transaction) : transaction(),
              (error) => runFailure(error, `migration '${migration.id}' failed`)), () => {
              historyExists = true; applied.push(migration.id); return applyNext(i + 1);
            });
          };
          // atomic: ONE immediate transaction, a savepoint per link, and the
          // final checks once every link ran — the chain commits whole or not
          // at all, so a repair link after a narrowing lands before the check
          const applyAtomically = () => {
            check();
            const body = (scope) => {
              check();
              return chain(lockMigration(scope, check), () => chain(verifyHistory(scope, appliedRows.length), () => {
                const next = (i) => {
                  if (i >= pending.length) return null;
                  check();
                  const migration = pending[i];
                  return chain(attempt(() => scope.transaction((link) => linkWork(link, migration, false)),
                    (error) => runFailure(error, `migration '${migration.id}' failed`)), () => {
                    applied.push(migration.id); return next(i + 1);
                  });
                };
                return chain(next(0), () => chain(acceptTarget(scope, finalTarget), () => finalChecks(scope, pending.at(-1))));
              }));
            };
            return attempt(() => connection.transaction(body, options.signal, 'immediate'),
              (error) => runFailure(error, 'the atomic migration run failed'));
          };
          return chain(atomic ? applyAtomically() : applyNext(0),
            () => ({ applied, skipped: appliedRows.map((row) => row.id), shape: expectedFrom }));
        });
      });
    })));
  }), (error) => runFailure(error, 'the migration failed'));
}

/** Plan an existing file's explicit preservation migration. Every source object
 * needs a disposition; source/target assertions preserve application-owned facts.
 * @param {any} connection @param {any} fromModel @param {any} toModel
 * @param {{ id: string, steps: any[], dispositions: Record<string, 'preserve'|'replace'|'drop'>,
 *   assertions?: { sql: string, params?: any[], expected: any[] }[],
 *   physicalTarget?: any }} options @returns {any} */
export function planPhysicalMigration(connection, fromModel, toModel, options) {
  readOptions(options, ['id', 'steps', 'scope', 'dispositions', 'assertions', 'physicalTarget'], 'planPhysicalMigration()');
  normalizeEntities(fromModel); normalizeEntities(toModel);
  if (!options || typeof options.id !== 'string' || !options.id || !Array.isArray(options.steps))
    throw refuse('JD0021', 'a physical plan requires id and explicit steps');
  const scope = options.scope === undefined ? undefined
    : physicalScopeOf(options.scope, connection.dialect, ownedTables(fromModel, toModel, options.steps));
  return chain(preservationSchemaOf(connection), (whole) => {
    // a scoped plan inventories its own tables and their programs alone
    const source = scope === undefined ? whole : whole.filter((object) => scope.tables.includes(object.owner));
    const dispositions = options.dispositions ?? {};
    const keys = source.map(physicalObjectKey);
    if (Object.keys(dispositions).some((key) => !keys.includes(key)) || keys.some((key) => !['preserve', 'replace', 'drop'].includes(dispositions[key])))
      throw refuse('JD0021', 'every physical source object must have an explicit preserve, replace or drop disposition');
    const assertions = options.assertions ?? [];
    for (const assertion of assertions) {
      if (!assertion || typeof assertion.sql !== 'string' || !/^SELECT\b/i.test(assertion.sql.trim()) || !Array.isArray(assertion.expected))
        throw refuse('JD0021', 'preservation assertions require a SELECT and expected rows');
    }
    const identity = migrationIdentity(fromModel, toModel);
    const migration = { $migration: MIGRATION_VERSION, id: options.id,
      from: hashContent(identity.from), to: hashContent(identity.to), identity,
      steps: options.steps, physical: { source, ...(scope === undefined ? {} : { scope }), dispositions, assertions,
        ...(connection.dialect.migration ? { dialect: connection.dialect.name, schema: connection.dialect.schema } : {}),
        ...(options.physicalTarget === undefined ? {} : { target: structuredClone(options.physicalTarget) }) } };
    checkMigrationDocument(migration);
    checkPreservationPlan(migration, connection.dialect);
    return migration;
  });
}

/** Validate saved plans again at execution, including SQL ownership boundaries. */
function checkPreservationPlan(migration, dialect) {
  checkMigrationStatements(migration, dialect);
  checkPhysicalPreservation(migration.physical, dialect);
  if (migration.physical !== undefined && migration.steps.some((step) => !['ddl', 'sql', 'rebuild', 'table', 'jslt', 'query', 'host'].includes(step.kind)))
    throw refuse('JD0021', 'invalid physical preservation step');
}

/** A saved step is one statement or one trigger program. Transaction aliases
 * and trailing statements cannot escape its savepoint or publish partial work. */
function checkMigrationStatements(migration, dialect) {
  const fragments = migration.steps.flatMap((step) => step.kind === 'rebuild'
    ? [...(step.create ?? []), step.copy, ...(step.indexes ?? [])] : step.kind === 'table'
      ? [...step.plan.statements, ...step.plan.finish] : ['ddl', 'sql'].includes(step.kind) ? [step.sql] : []);
  for (const sql of fragments) {
    if (dialect?.migration) { dialect.migration.checkSql(sql); continue; }
    const tokens = typeof sql === 'string' ? sqlTokens(sql) : [];
    const words = tokens.filter((t) => t.kind === 'word').map((t) => t.value.toUpperCase());
    const fail = () => { throw refuse('JD0021', 'migration steps cannot change transaction or connection ownership; use one statement per step'); };
    if (!['CREATE', 'ALTER', 'DROP', 'INSERT', 'UPDATE', 'DELETE', 'WITH', 'REPLACE'].includes(words[0])
      || words.some((w) => /^(?:COMMIT|ROLLBACK|SAVEPOINT|RELEASE|ATTACH|DETACH|PRAGMA|VACUUM)$/.test(w)))
      fail();
    const trigger = words[0] === 'CREATE' && (words[1] === 'TRIGGER'
      || ['TEMP', 'TEMPORARY'].includes(words[1]) && words[2] === 'TRIGGER');
    if (!trigger) {
      if (words.includes('BEGIN') || tokens.some((token, i) => token.kind === 'symbol'
        && token.value === ';' && i !== tokens.length - 1)) fail();
      continue;
    }
    const begin = tokens.findIndex((token) => token.kind === 'word' && token.value.toUpperCase() === 'BEGIN');
    if (begin < 0) fail();
    let depth = 1, end = -1;
    for (let i = begin + 1; i < tokens.length; i++) {
      const token = tokens[i];
      if (token.kind !== 'word') continue;
      const word = token.value.toUpperCase();
      if (word === 'CASE' || word === 'BEGIN') depth++;
      else if (word === 'END' && --depth === 0) { end = i; break; }
    }
    if (end < 0 || tokens.slice(end + 1).some((token, i) => i !== 0 || token.kind !== 'symbol' || token.value !== ';')) fail();
  }
}
