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
import { cloneJson, setObjectMember, isPlainOptions, isJsonObject } from '@jarenjs/core/object';
import { withoutModelRenameHints } from '@jarenjs/core/model';
import { schemaPosition } from './schema-positions.js';
import { compileJsonQuery } from '@jarenjs/json/query';
import { compileJsltStylesheet } from '@jarenjs/json/jslt';

import { DbCompileError, isJarenCoded, wrapDriverError } from './errors.js';
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
import { planCollection, verifyShape, legacyColumnTypes, termlessIndexesHeld, planEntity, planJoinTable, joinIndexName, clipToBytes, plannedExpression, acceptsColumn, columnExpression, creationOrder, kindIndexSql, kindIndexTerms, kindIndexDropSql } from './ddl.js';
import { normalizeEntities, explainMapping, asHistory } from './model.js';
import { derivedValue, memberAt, registerDeriveFunctions } from './derive.js';
import { mergeEntityRow } from './graph.js';
import { entityCore } from './entity.js';
import { sqlTokens, readIntervalGuards, readsConforming } from './dialects/check-read.js';
import { isKeyword } from './sql.js';
import { MEMBER_WHEN } from './dialect.js';
import { comparableDeclaredSql } from './schema-sql.js';
import { applyTableMigration } from './table-migration.js';
import { withForeignKeySettings } from './foreign-key-scope.js';
import { withMigrationConnection, checkMigrationTarget, physicalTargetOf, comparePhysicalTarget, verifyShadowOwnership, physicalObjectKey, migrationOwnerOf, lockMigration, migrationWriterSettings, preservationSchemaOf, verifyPreservation, checkPhysicalPreservation } from './migration-target.js';
import { readSchema } from './introspect.js';
import { nonCodePointEncoding, verifyPhysical } from './physical.js';
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
  if (!isJsonObject(from) || !isJsonObject(to)) return false;
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
      if (!isJsonObject(fromProperties) || !isJsonObject(toProperties)) return false;
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
 * Whether an index planned under one model must be rebuilt for its
 * declaration under the other: its uniqueness, its column list (with the
 * boolean keys a unique index adds after it) or its condition changed. The collection and entity diffs share this one
 * comparison. Columns compare element by element, so a column name containing
 * a comma never equals a split of it (`['a,b']` is not `['a', 'b']`); a
 * condition compares as the plan renders it, the text every open verifies,
 * and neither engine alters one in place. An expression index's expression is
 * its generated column's, compared with the column.
 * @param {{ unique: boolean, columns: readonly string[], terms?: readonly string[], where?: string }} from
 * @param {{ unique: boolean, columns: readonly string[], terms?: readonly string[], where?: string }} to
 * @returns {boolean}
 */
export function indexChanged(from, to) {
  const differ = (/** @type {readonly string[]} */ a, /** @type {readonly string[]} */ b) =>
    a.length !== b.length || a.some((key, at) => key !== b[at]);
  return from.unique !== to.unique || differ(from.columns, to.columns) || differ(from.terms ?? [], to.terms ?? [])
    || (from.where ?? null) !== (to.where ?? null);
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

/**
 * An admission refusal, answered through the boundary its target promises: a
 * borrowed `{ connection }` caller gets the throw, an owned `{ driver, path? }`
 * caller, documented to receive a promise, a rejected one.
 * @param {any} target @param {unknown} error @returns {Promise<never>}
 */
function admissionRefused(target, error) {
  if (target.connection !== undefined) throw error;
  return Promise.reject(error);
}

/** The hook options of the migration entry points: host code, never data. */
const MIGRATION_HOOKS = ['registerFunctions', 'compileSchema', 'onProgress', 'onAssertionPlan', 'shadowFixture'];

/**
 * Refuse a malformed control of a migration entry point (`JD0013`) before a
 * connection is acquired, so a refused owned call creates no file and runs no
 * hook. Its closed set has already refused unknown names; this reads values:
 * the cancellation controls, every hook a function, `expressions` a plain
 * object of declarations, `shadowDriver` a driver with `open()`, `dryRun` and
 * `shadow` booleans (a string `'true'` must not run a migration for real) and
 * `shadowPath` a path. A `physicalTarget` is the physical-target owner's to
 * admit (`JD0021`), `null` included: it is a wrong value, not an absent target.
 * @param {any} options @param {string} owner @returns {void}
 */
function readMigrationControls(options, owner) {
  readControls(options, owner);
  if (options === undefined) return;
  const malformed = (/** @type {string} */ name, /** @type {string} */ rule) =>
    refuse('JD0013', `${owner} option '${name}' ${rule}`);
  for (const name of MIGRATION_HOOKS) {
    if (options[name] !== undefined && typeof options[name] !== 'function') throw malformed(name, 'must be a function');
  }
  if (options.expressions !== undefined && !isPlainOptions(options.expressions))
    throw malformed('expressions', 'must be a plain object of declarations');
  if (options.shadowDriver !== undefined && typeof options.shadowDriver?.open !== 'function')
    throw malformed('shadowDriver', 'must be a driver with open()');
  for (const name of ['dryRun', 'shadow']) {
    if (options[name] !== undefined && typeof options[name] !== 'boolean') throw malformed(name, 'must be true or false');
  }
  if (options.shadowPath !== undefined && typeof options.shadowPath !== 'string')
    throw malformed('shadowPath', 'must be a database path');
}

/**
 * Refuse a migration list that repeats an id (`JD0013`) before anything runs.
 * A history row is keyed by its id, so a repeated link could never be
 * recorded: it would run its steps after the earlier links committed and then
 * fail on the key, and status would report it pending forever. Ids compare
 * exactly; a document without a string id is the structural check's to refuse.
 * @param {any[]} migrations @param {string} owner @returns {void}
 */
function refuseRepeatedIds(migrations, owner) {
  /** @type {Map<string, number>} */
  const positions = new Map();
  for (const [at, migration] of migrations.entries()) {
    const id = migration?.id;
    if (typeof id !== 'string') continue;
    const first = positions.get(id);
    if (first !== undefined) {
      throw refuse('JD0013', `${owner} migration list repeats the id '${id}' at positions ${first} and ${at}; `
        + 'each migration in a list needs its own id');
    }
    positions.set(id, at);
  }
}

/** A receipt stamp's magnitude bound: SQLite keeps `applied_at` in a 64-bit
 * INTEGER column, where a number of 2^63 or more can only be a REAL. */
const RECEIPT_STAMP_BOUND = 2 ** 63;

/**
 * Read a receipt stamp from the run's clock: `applied_at` holds integer epoch
 * milliseconds, and SQLite's 64-bit INTEGER column holds every integer below
 * 2^63 in magnitude. A clock answering anything else (a fraction, a
 * non-finite value, one beyond that range) is refused (`JD0013`) on both
 * dialects, instead of failing as the database's own error on SQLite or
 * storing the fraction on PostgreSQL. A run reads it before its first link,
 * so a clock that cannot stamp refuses before any step runs, and again for
 * every receipt, before its insert, so one that stops being an integer
 * mid-run refuses that link: rolled back whole, with the links before it
 * standing, or the whole chain in an atomic run. The shadow's replay is a
 * run of its own and reads the clock first, so a refusal there comes before
 * the database runs any step. Below 2^53 both dialects
 * store the integer exactly; beyond it SQLite keeps the number's own integer
 * and PostgreSQL's numeric the shortest decimal that reads back as the same
 * number (2^60 is stored as 1152921504606847000).
 * @param {{ now: () => number }} runtime @param {string} owner
 * @param {string} undone - what the refusal leaves unapplied
 * @returns {number}
 */
function receiptStamp(runtime, owner, undone) {
  const stamp = runtime.now();
  if (!Number.isInteger(stamp) || Math.abs(stamp) >= RECEIPT_STAMP_BOUND) {
    const answered = typeof stamp === 'number' || stamp === null || stamp === undefined ? String(stamp)
      : `${typeof stamp === 'object' ? 'an' : 'a'} ${typeof stamp}`;
    throw refuse('JD0013', `${owner} option 'runtime': runtime.now() answered ${answered}, `
      + `and a migration receipt stamps applied_at in integer epoch milliseconds; ${undone}`);
  }
  return stamp;
}

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
  if (isJarenCoded(error)) {
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
  if (isJarenCoded(error)) {
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
 * a transform wrote into the document would be shadowed on read).
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
      + `WHERE ${entityRowIdentity(dialect, stepEntity.mapping)} = ${dialect.parameterRef(columns.length + 2, 'rid')}`, (update) =>
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
  if (!isJsonObject(hosts))
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
    const mapping = model === fromModel ? asHistory(() => explainMapping(model)) : explainMapping(model);
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
  if (!isJsonObject(scope) || Object.keys(scope).some((key) => key !== 'tables')
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
 * The declared intervals a collection gains, loses or changes between two
 * physical plans. A CHECK is compared by its constraint name and the text
 * it installs — which names its bound columns — and counts as changed where
 * a column it reads is disturbed, since dropping a column drops a CHECK
 * over it.
 * @param {any} fromPlan @param {any} toPlan @param {Set<string>} disturbedColumns
 * @returns {{ changed: boolean, dropped: any[], added: any[] }}
 */
function intervalDifference(fromPlan, toPlan, disturbedColumns) {
  const from = new Map((fromPlan.intervals ?? []).map((interval) => [interval.constraint, interval]));
  const to = new Map((toPlan.intervals ?? []).map((interval) => [interval.constraint, interval]));
  // a CHECK whose table is known to hold the other spelling (`holds`) is that text
  const differs = (/** @type {any} */ a, /** @type {any} */ b) => (a.holds !== undefined ? a.holds !== b.sql
    : a.sql !== b.sql && a.sql !== b.alternate)
    || [a.start, a.end, b.start, b.end].some((column) => disturbedColumns.has(column));
  const dropped = [...from.values()].filter((interval) => !to.has(interval.constraint) || differs(interval, to.get(interval.constraint)));
  const added = [...to.values()].filter((interval) => !from.has(interval.constraint) || differs(from.get(interval.constraint), interval));
  return { changed: dropped.length > 0 || added.length > 0, dropped, added };
}

/**
 * A collection's rebuild: the ONE step an engine without `ADD CONSTRAINT`
 * (SQLite) takes where a declared interval's CHECK is added, changed or
 * dropped — the documented procedure (§10) over the whole target shape, so
 * every other column and index step of the collection is this step's. The
 * copy names the row identity, the key and the document — the collection's
 * order survives the dropped table, and so do the ids of an R*Tree, which
 * are rowids — and every stored derived column both shapes hold unchanged;
 * a generated column is computed, never inserted, and a stored one the
 * target adds or changes is backfilled by the step after. An R*Tree the
 * target keeps is not recreated (DROP TABLE takes the table's triggers, not
 * the virtual table, whose rows stay with it); one the target adds is
 * created whole and filled from the copied rows.
 * @param {string} name @param {any} fromPlan @param {any} toPlan @param {any} toCollection
 * @param {any} dialect @param {any} mapping - what `planCollection` takes
 * @param {(a: any, b: any) => boolean} columnChanged
 * @returns {{ steps: any[], backfilled: string[] }}
 */
function renderCollectionRebuild(name, fromPlan, toPlan, toCollection, dialect, mapping, columnChanged) {
  const q = dialect.quoteIdentifier;
  const temporary = `${name}__rebuild`;
  const fromColumns = new Map(fromPlan.generated.map((/** @type {any} */ g) => [g.name, g]));
  const stored = toPlan.generated.filter((/** @type {any} */ g) => g.stored === true);
  const carried = stored.filter((/** @type {any} */ g) => fromColumns.has(g.name) && !columnChanged(fromColumns.get(g.name), g))
    .map((/** @type {any} */ g) => g.name);
  const backfilled = stored.map((/** @type {any} */ g) => g.name).filter((column) => !carried.includes(column));
  const columns = [dialect.rowIdentity(), q(toPlan.keyColumn), q(toPlan.docColumn), ...carried.map(q)].join(', ');
  const kept = new Set(fromPlan.virtualTables.map((/** @type {any} */ virtual) => virtual.name));
  const virtualSql = new Set(toPlan.virtualTables.flatMap((/** @type {any} */ virtual) =>
    [virtual.createSql, ...virtual.triggers.map((/** @type {any} */ trigger) => trigger.sql)]));
  const indexes = [
    ...toPlan.createSql.slice(1).filter((/** @type {string} */ sql) => !virtualSql.has(sql)),
    ...toPlan.virtualTables.flatMap((/** @type {any} */ virtual) => (kept.has(virtual.name)
      ? virtual.triggers.map((/** @type {any} */ trigger) => trigger.sql)
      : [virtual.createSql, ...virtual.triggers.map((/** @type {any} */ trigger) => trigger.sql), virtual.fillSql])),
  ];
  const steps = [{
    kind: 'rebuild',
    table: name,
    create: [planCollection(temporary, toCollection, dialect, mapping).createSql[0]],
    copy: `INSERT INTO ${q(temporary)} (${columns}) SELECT ${columns} FROM ${q(name)}`,
    indexes,
    note: `rebuild '${name}' (its declared intervals changed, and this engine adds or drops a CHECK by rebuilding the table)`,
  }];
  if (backfilled.length > 0) {
    steps.push(deriveStep(name, toPlan, backfilled,
      `backfill derived column(s) ${backfilled.join(', ')} on '${name}' after the rebuild`));
  }
  return { steps, backfilled };
}

/**
 * The interval preconditions of one link: for every declaration its target
 * model carries that its from-model does not, or carries differently, the
 * one statement that counts the stored rows the target CHECK refuses and
 * answers the first ten of their keys in row order. Read from the link's
 * exact identity, which a legacy document does not carry (then there are
 * none); a collection the link renames is counted under its from-side
 * table, since nothing has run. The CHECK renders over the bound columns'
 * generating expressions, never the columns, because the same link may be
 * adding them.
 * @param {any} migration @param {any} dialect @param {any} mapping - what `planCollection` takes
 * @returns {{ collection: string, interval: string, table: string, sql: string }[]}
 */
function intervalPreconditionsOf(migration, dialect, mapping) {
  const identity = migration.identity;
  if (identity === undefined || identity === null || typeof identity !== 'object') return [];
  // only a target that declares an interval is normalized: a link whose
  // models declare none has no precondition, whatever else they hold
  const toModel = JSON.parse(identity.to);
  const declares = Object.values(toModel.collections ?? {})
    .some((/** @type {any} */ collection) => Array.isArray(collection?.intervals) && collection.intervals.length > 0);
  if (!declares) return [];
  const fromModel = JSON.parse(identity.from);
  const fromCollections = Object.keys(fromModel.collections ?? {}).length === 0
    ? new Map() : normalizeModel(fromModel, mapping.expressions);
  const toCollections = normalizeModel(toModel, mapping.expressions);
  const renamed = renamesOf(migration.steps);
  /** @type {Map<string, string>} the from-side table under which each target collection's rows are */
  const tableOf = new Map();
  for (const name of fromCollections.keys()) tableOf.set(renamed(name), name);
  const q = dialect.quoteIdentifier;
  const checks = [];
  for (const [name, toCollection] of toCollections) {
    const table = tableOf.get(name);
    const fromCollection = table === undefined ? undefined : fromCollections.get(table);
    if (fromCollection === undefined || toCollection.intervals.length === 0) continue;
    const plan = planCollection(name, toCollection, dialect, mapping);
    for (const interval of plan.intervals) {
      const before = fromCollection.intervals.find((/** @type {any} */ declared) => declared.name === interval.name);
      if (before !== undefined && before.canonical === interval.span.canonical && before.maxDuration === interval.maxDuration) continue;
      const refused = dialect.ddl.intervalCheck({ docColumn: plan.docColumn, span: interval.span.pathText, bounds: interval.span.bounds,
        start: plannedExpression(dialect, plan, interval.start), end: plannedExpression(dialect, plan, interval.end),
        maxDuration: interval.maxDuration, unpinned: interval.span.unpinned });
      checks.push({ collection: name, interval: interval.name, table,
        sql: `SELECT ${q(plan.keyColumn)} AS ${q('k')}, count(*) OVER () AS ${q('n')} FROM ${q(table)} `
          + `WHERE NOT COALESCE(${refused}, ${dialect.booleanLiteral(true)}) ORDER BY ${dialect.rowIdentity()} ${dialect.limitClause(10)}` });
    }
  }
  return checks;
}

/**
 * Count, before any step of a link runs, the stored rows each interval
 * declaration the link adds or changes would refuse: a non-zero count
 * refuses the link `JD0021`, naming the collection, the interval, the count
 * and the first keys, with nothing changed. Nothing is dropped, rewritten or
 * skipped on the operator's behalf; a writer that lands between this count
 * and the DDL makes the DDL fail instead, still a refusal.
 * @param {any} connection @param {any} migration @param {{ expressions?: any }} options
 * @returns {any} value-or-promise
 */
function intervalPreconditions(connection, migration, options) {
  const checks = intervalPreconditionsOf(migration, connection.dialect, mappingFor(connection, options.expressions));
  return sequentially(checks, (check) => chain(useStatementOnce(connection, check.sql, (statement) => statement.all([])), (rows) => {
    if (rows.length === 0) return;
    const keys = rows.map((/** @type {any} */ row) => `'${String(row.k)}'`).join(', ');
    throw refuse('JD0021', `collection '${check.collection}': ${Number(rows[0].n)} stored document(s) violate interval `
      + `'${check.interval}' (first keys: ${keys}) — repair them before declaring it`);
  }));
}

/**
 * The physical mapping a plan takes where the caller names none: the one
 * the open takes on this engine, as far as a dialect can say. A dialect
 * that spells no generated expression for a derived column — PostgreSQL,
 * whose drivers register no deterministic function, so the store writes
 * the value — stores derived columns, and one that spells it generates
 * them; an R*Tree is realized only where the dialect has virtual tables.
 * The dialect is asked for the spelling exactly as `planCollection` asks
 * it. What differs per DRIVER on one engine — a SQLite host without
 * deterministic functions (Bun), a build without the R*Tree module — is
 * the caller's to name through `derived` and `rtree`.
 * @param {any} dialect
 * @returns {{ derived: 'virtual' | 'stored', rtree: boolean }}
 */
function dialectMapping(dialect) {
  let spelled = false;
  try {
    spelled = typeof dialect.derivedColumn(dialect.quoteIdentifier('doc'), dialect.jsonPathText([{ name: 'at' }]),
      { derive: 'geohash', precision: 1 }) === 'string';
  }
  catch { spelled = false; }
  return { derived: spelled ? 'virtual' : 'stored', rtree: dialect.capabilities?.virtualTables === true };
}

/**
 * The structural steps one collection takes between two physical plans of its
 * table: generated columns, indexes, R*Trees and declared intervals, in
 * dependency order, or the one rebuild an engine without `ADD CONSTRAINT`
 * takes where an interval changes. A from-plan column or interval that carries
 * `holds` is compared by that text exactly (see {@link planColumnUpgrade}).
 * @param {string} name @param {any} fromPlan @param {any} toPlan @param {any} toCollection
 * @param {any} dialect @param {any} mapping - what `planCollection` takes
 * @returns {{ steps: any[], backfilled: string[] }} `backfilled`: the stored derived
 *   columns the steps add and fill
 */
function collectionSteps(name, fromPlan, toPlan, toCollection, dialect, mapping) {
  const steps = [];
  const fromColumns = new Map(fromPlan.generated.map((g) => [g.name, g]));
  const toColumns = new Map(toPlan.generated.map((g) => [g.name, g]));
  const fromIndexes = new Map(fromPlan.expected.indexes.map((i) => [i.name, i]));
  const toIndexes = new Map(toPlan.expected.indexes.map((i) => [i.name, i]));

  // a column's EXPRESSION is part of its identity: the same path at a
  // different precision, or under the other physical mapping, is a
  // different column even where name and type agree. Compared as the
  // table holds it, the declared expression or the read of the member: the
  // untyped column of a member of several types reads it as its first type
  // makes it (a number-first union casts its numbers), so a change of the
  // types that keeps that read is no change — unless a table an earlier
  // release created holds the column in the first type's word
  // (`earlierType`), which the other column does not take. The same index expression read
  // with the guard of a path that leaves a container open and without it is one
  // column (`alternate`): a table holds either, and neither is a change — but
  // the guard names the kind of each digit step (`[0]` off an array, `['0']`
  // off an object), so a column guarded for one kind is a change to the other.
  // A column whose table is known to hold the other spelling (`holds`, its text)
  // is that text, which is a change to any other
  const columnChanged = (a, b) => a.type !== b.type || a.pathText !== b.pathText
    || (a.holds !== undefined ? a.holds !== columnExpression(dialect, b)
      : a.alternate === undefined && b.alternate === undefined
        ? columnExpression(dialect, a) !== columnExpression(dialect, b)
        : !acceptsColumn(dialect, a, b))
    || (a.earlierType !== undefined && a.earlierType !== b.type && !(b.legacyTypes ?? []).includes(a.earlierType))
    || (a.stored === true) !== (b.stored === true);

  // columns first decide their fate; an index rebuilds when it
  // changes OR when any column it covers or its condition reads is
  // dropped or changed (the database refuses to drop a column under a
  // live index, or drops the index with it) — then
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
  // a declared interval's CHECK: an engine that alters a table in place
  // drops it before any index or column work and adds it after all of it
  // (the CHECK reads the bound columns); one that cannot (SQLite) takes
  // ONE rebuild step of the whole target shape, which makes every other
  // column and index step of this collection the rebuild's own
  const intervals = intervalDifference(fromPlan, toPlan, disturbedColumns);
  const rebuilding = intervals.changed && dialect.capabilities.alterTableFull !== true;
  /** @type {string[]} */
  let backfilled = [];
  if (rebuilding) {
    const rebuilt = renderCollectionRebuild(name, fromPlan, toPlan, toCollection, dialect, mapping, columnChanged);
    steps.push(...rebuilt.steps);
    backfilled = rebuilt.backfilled;
  }
  else {
    for (const interval of intervals.dropped) {
      steps.push({ kind: 'ddl', sql: dialect.ddl.dropCheck({ table: name, name: interval.constraint }),
        note: `drop the CHECK '${interval.constraint}' of interval '${interval.name}' on '${name}'` });
    }
    const indexNeedsRebuild = (indexName, fromIndex) => {
      const target = toIndexes.get(indexName);
      return target === undefined || indexChanged(fromIndex, target)
        || [...fromIndex.columns, ...(fromIndex.reads ?? [])].some((column) => disturbedColumns.has(column));
    };
    for (const [indexName, fromIndex] of fromIndexes) {
      if (indexNeedsRebuild(indexName, fromIndex)) {
        steps.push({ kind: 'ddl', sql: dialect.ddl.dropIndex(indexName),
          note: `drop index '${indexName}' on '${name}'` });
      }
    }
    // an index beside a declared one that seeks another kind of its member leaves with
    // it, and when the member no longer holds that kind; a table may not hold it (one an
    // earlier release created, or one a link gave the kind without rebuilding the index)
    const toKindIndexes = new Set((toPlan.kindIndexes ?? []).map((/** @type {any} */ index) => index.name));
    for (const index of fromPlan.kindIndexes ?? []) {
      if (!toKindIndexes.has(index.name) || indexNeedsRebuild(index.of, fromIndexes.get(index.of))) {
        steps.push({ kind: 'ddl', sql: kindIndexDropSql(dialect, index.name),
          note: `drop the ${index.kind} index '${index.name}' beside '${index.of}' on '${name}'` });
      }
    }
    for (const columnName of disturbedColumns) {
      steps.push({ kind: 'ddl', sql: dialect.ddl.dropColumn(name, columnName),
        note: `drop generated column '${columnName}' on '${name}'` });
    }
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
    /** The declared indexes this link creates. @type {Set<string>} */
    const createdIndexes = new Set();
    for (const [indexName, toIndex] of toIndexes) {
      const source = fromIndexes.get(indexName);
      const rebuilt = source !== undefined && indexNeedsRebuild(indexName, source);
      if (source === undefined || rebuilt) {
        createdIndexes.add(indexName);
        steps.push({
          kind: 'ddl',
          sql: dialect.ddl.createIndex({ name: indexName, table: name, columns: toIndex.columns,
            unique: toIndex.unique, where: toIndex.where, terms: toIndex.terms }),
          note: `create index '${indexName}' on '${name}'`,
        });
      }
    }
    // an index beside a declared one arrives with it, and a unique one also where the
    // link gives a kept index's member the kind (it refuses that kind's duplicates); one
    // a table lacks beside an index it keeps is otherwise `planColumnUpgrade`'s to add
    const fromKindIndexes = new Set((fromPlan.kindIndexes ?? []).map((/** @type {any} */ index) => index.name));
    for (const index of toPlan.kindIndexes ?? []) {
      if (createdIndexes.has(index.of) || (index.unique && !fromKindIndexes.has(index.name))) {
        steps.push({ kind: 'ddl', sql: kindIndexSql(dialect, name, index),
          note: `create the ${index.kind} index '${index.name}' beside '${index.of}' on '${name}'` });
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
    for (const interval of intervals.added) {
      steps.push({ kind: 'ddl', sql: dialect.ddl.addCheck({ table: name, name: interval.constraint, sql: interval.sql }),
        note: `add the CHECK '${interval.constraint}' of interval '${interval.name}' on '${name}'` });
    }
  }
  return { steps, backfilled };
}

/**
 * Plan a migration between two model documents. The planner diffs the
 * PHYSICAL plans (columns, indexes, declared intervals) and renders DDL through the
 * dialect; a changed schema gets a DRAFT identity transform that
 * refuses to run until the author fills it in — the planner cannot
 * infer a data transform and does not pretend to. Renames are declared
 * (`x-rename` on the target collection), never guessed.
 * The physical mapping of a DERIVED index column depends on the driver
 * that will run the migration (`derived`), because the two mappings
 * really are different columns; a migration document planned for one is
 * not the document the other needs. Where the caller names none, the
 * mapping is the engine's own (`dialectMapping`): stored derived columns
 * and no R*Tree on PostgreSQL, generated columns and the R*Tree on SQLite.
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
  // the name the history records: a document with any other is one no runner accepts
  if (options?.id !== undefined && options.id !== null && (typeof options.id !== 'string' || options.id === ''))
    throw refuse('JD0013', `planModelMigration() option 'id' is a non-empty string, the migration's name in the history, got ${JSON.stringify(options.id)}`);
  const dialect = options?.dialect ?? null;
  if (dialect === null || typeof dialect !== 'object')
    throw new TypeError('planMigration needs { dialect } (the store dialect renders the DDL)');
  const identity = migrationIdentity(fromModel, toModel);
  const from = hashContent(identity.from), to = hashContent(identity.to);
  if ([fromModel, toModel].some((m) => Object.values(m?.entities ?? {}).some((e) => e?.physical !== undefined))) {
    asHistory(() => normalizeEntities(fromModel));
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
  const engine = dialectMapping(dialect);
  const derived = options?.derived ?? engine.derived;
  const mapping = { derived, rtree: options?.rtree ?? engine.rtree,
    // a model that declares an index EXPRESSION resolves its functions
    // here too: a plan is DDL, and DDL over a function this planner was
    // not told about is DDL nobody can apply
    expressions: options?.expressions, registered: derived !== 'stored' };
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

    const physical = collectionSteps(name, fromPlan, toPlan, toCollection, dialect, mapping);
    steps.push(...physical.steps);
    const backfilled = physical.backfilled;

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
          .filter((column) => toPlan.generated.some((g) => g.name === column.name && g.stored === true))
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

  const programs = planEntityChanges(fromModel, toModel, dialect, steps, report, transform);
  // a list's repair runs last: after every structural step it may read
  steps.push(...(transform?.finish() ?? []));
  // the rule programs a table gains come after the repair: a program judges
  // the writes after it, so a transform carries stored rows into conformance
  // before the rule arrives (§9)
  steps.push(...programs);

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
    if (!isJsonObject(step)
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

/**
 * Plan the link that brings the tables of a database up to the definitions
 * this release creates for the model they hold. A table an earlier release
 * created opens and answers as it did, and a plan between two models compares
 * the models alone, so it plans nothing for such a table; this plan reads the
 * catalog instead and compares, per collection table, each generated column,
 * index expression and interval CHECK the table holds with what a fresh store
 * of the same model creates. Where the table holds the definition an earlier
 * release created — on SQLite a generated column of an indexed member of
 * several types in one of those types, on PostgreSQL a generated column, an
 * index expression or an interval CHECK over a path the schema leaves a
 * container open on without the guard a query reads it under — the link drops
 * that definition (and the indexes over its column) and creates it again as
 * this release creates it, through the same steps a model change plans; and a
 * many-to-many join table without the index over its second key column, which
 * no earlier release created, gets that index; and so does a collection
 * table without an index a fresh store creates beside a declared index over a
 * member of several kinds. Where such an index is unique and the table holds
 * documents that duplicate one another at its kind (an earlier release's
 * unique index keyed the member's first kind alone), the plan refuses
 * `JD0023` (`class: 'constraint'`) naming them, before any step. Every
 * stored document stays; the columns are computed again by the database. A
 * database already current plans no step, which is how a host learns that a
 * store is behind: the plan is the probe. The link goes from the model to
 * itself and is applied by {@link migrate} as the next link of the chain;
 * nothing else of the model is planned (entity tables, document schema).
 * @param {any} connection - an open connection to the database, as `migrate` opens one
 * @param {any} model - the model the database holds (its tables open under it)
 * @param {{ id?: string, expressions?: Record<string, any> }} [options] - `id` the
 *   link's name (`upgrade-<hash>` by default); `expressions` the host's declared
 *   index-expression functions
 * @returns {any} value-or-promise of `{ migration, report: { upgraded: string[] } }`:
 *   `upgraded` names each definition the link rebuilds or creates, `<table>.<column>`,
 *   `<table>.<constraint>` or `<table>.<index>`
 */
export function planColumnUpgrade(connection, model, options = undefined) {
  readOptions(options, ['id', 'expressions'], 'planColumnUpgrade()');
  if (options?.id !== undefined && options.id !== null && (typeof options.id !== 'string' || options.id === ''))
    throw refuse('JD0013', `planColumnUpgrade() option 'id' is a non-empty string, the migration's name in the history, got ${JSON.stringify(options.id)}`);
  const dialect = connection.dialect;
  const mapping = mappingFor(connection, options?.expressions);
  const identity = migrationIdentity(model, model);
  const to = hashContent(identity.to);
  const collections = [...normalizeModel(model, options?.expressions).values()]
    .map((collection) => ({ collection, plan: planCollection(collection.name, collection, dialect, mapping) }));
  return chain(heldDefinitionsOf(connection, collections.map(({ plan }) => plan)), (held) =>
    chain(missingJoinIndexes(connection, joinPlansOf(model, dialect)), (missing) =>
    chain(missingKindIndexes(connection, collections.map(({ plan }) => plan)), (besides) => {
      const steps = [];
      /** @type {string[]} */
      const upgraded = [];
      for (const { collection, plan } of collections) {
        const holding = held.get(plan.table);
        if (holding === undefined) continue;
        upgraded.push(...[...holding.types.keys(), ...holding.columns, ...holding.checks, ...holding.indexes].map((name) => `${plan.table}.${name}`));
        steps.push(...collectionSteps(collection.name, heldPlanOf(plan, holding), plan, collection, dialect, mapping).steps);
      }
      for (const { table, index, sql } of missing) {
        upgraded.push(`${table}.${index}`);
        steps.push({ kind: 'ddl', sql, note: `index the join table '${table}' over its second key column, as a fresh store creates it` });
      }
      const planned = new Set(steps.map((step) => step.sql));
      for (const { table, index, sql, kind, of } of besides) {
        if (planned.has(sql)) continue;
        upgraded.push(`${table}.${index}`);
        steps.push({ kind: 'ddl', sql, note: `create the ${kind} index '${index}' beside '${of}' on '${table}', as a fresh store creates it` });
      }
      const migration = { $migration: MIGRATION_VERSION, id: options?.id ?? `upgrade-${to.slice(0, 8)}`,
        from: to, to, identity, steps };
      const created = new Set(steps.map((step) => step.sql));
      const unique = collections.flatMap(({ plan }) => (plan.kindIndexes ?? [])
        .filter((/** @type {any} */ index) => index.unique && created.has(kindIndexSql(dialect, plan.table, index)))
        .map((/** @type {any} */ index) => ({ plan, index })));
      return chain(refuseDuplicates(connection, unique), () => ({ migration, report: { upgraded } }));
    })));
}

/**
 * Refuse, before any step runs, a link that creates a unique index beside a
 * declared one (`ddl.js` `kindIndexesOf`) over a table that already holds two
 * documents with one value of a kind the declared index's column did not
 * key: an earlier release's table, whose unique index refused the first
 * kind's duplicates alone, stored them. `JD0023` (`class: 'constraint'`)
 * names each set of such documents, so the host can change them first.
 * @param {any} connection
 * @param {{ plan: any, index: any }[]} indexes
 * @returns {any} value-or-promise
 */
function refuseDuplicates(connection, indexes) {
  const dialect = connection.dialect;
  const q = dialect.quoteIdentifier;
  const next = (/** @type {number} */ i) => {
    if (i >= indexes.length) return null;
    const { plan, index } = indexes[i];
    const keys = kindIndexTerms(dialect, index);
    const holds = [...keys.map((key) => `${key} IS NOT NULL`), ...(index.where === undefined ? [] : [`(${index.where})`])].join(' AND ');
    const sql = `SELECT ${q('k')}, ${q('g')} FROM (SELECT ${q(plan.keyColumn)} AS ${q('k')}, `
      + `count(*) OVER (PARTITION BY ${keys.join(', ')}) AS ${q('n')}, dense_rank() OVER (ORDER BY ${keys.join(', ')}) AS ${q('g')} `
      + `FROM ${q(plan.table)} WHERE ${holds}) AS ${q('d')} WHERE ${q('n')} > 1 ORDER BY ${q('g')}, ${q('k')} LIMIT ${DUPLICATES_NAMED + 1}`;
    return chain(connection.prepare(sql), (statement) => chain(statement.all([]), (rows) => {
      if (rows.length === 0) return next(i + 1);
      /** @type {Map<string, string[]>} */
      const groups = new Map();
      for (const row of rows.slice(0, DUPLICATES_NAMED)) {
        const group = String(row.g);
        groups.set(group, [...(groups.get(group) ?? []), String(row.k)]);
      }
      const duplicates = [...groups.values()];
      const declared = index.declared.name;
      throw Object.assign(refuse('JD0023', `the unique index '${declared}' of collection '${plan.table}' refuses a duplicate `
        + `of any kind its members hold, but the table holds documents that duplicate one another at a kind the index's `
        + `column did not key, which an earlier release stored: ${duplicates.map((keys) => keys.map((key) => JSON.stringify(key)).join(' and ')).join('; ')}`
        + `${rows.length > DUPLICATES_NAMED ? ', and more' : ''} — change or remove all but one of each, then plan the upgrade again`),
      { class: 'constraint', retryable: false, collection: plan.table, index: declared, duplicates });
    }));
  };
  return next(0);
}

/** How many duplicate documents a refused upgrade names. */
const DUPLICATES_NAMED = 20;

/**
 * The join tables of the model that exist without the index over their
 * second key column, which a table an earlier release created lacks: each
 * with the statement a fresh store creates the index by. A join table the
 * database does not hold has nothing to upgrade.
 * @param {any} connection
 * @param {any[]} plans - from `planJoinTable`, one per join table
 * @returns {any} value-or-promise of `{ table: string, index: string, sql: string }[]`
 */
function missingJoinIndexes(connection, plans) {
  const dialect = connection.dialect;
  return missingIndexes(connection, plans, (plan) => plan.expected.indexes
    .filter((/** @type {any} */ index) => index.legacyAbsent === true)
    .map((/** @type {any} */ index) => ({ table: plan.table, index: index.name, sql: dialect.ddl.createIndex({ ...index, table: plan.table }) })));
}

/**
 * The indexes a fresh store creates beside a declared index over a member of
 * several kinds (`kindIndexes`) that a collection table lacks — one an
 * earlier release created, or one a link gave the kind without rebuilding
 * the index — each with the statement that creates it. A collection the
 * database does not hold has nothing to upgrade.
 * @param {any} connection
 * @param {any[]} plans - from `planCollection`, one per collection
 * @returns {any} value-or-promise of `{ table: string, index: string, sql: string, kind: string, of: string }[]`
 */
function missingKindIndexes(connection, plans) {
  const dialect = connection.dialect;
  return missingIndexes(connection, plans, (plan) => (plan.kindIndexes ?? []).map((/** @type {any} */ index) =>
    ({ table: plan.table, index: index.name, sql: kindIndexSql(dialect, plan.table, index), kind: index.kind, of: index.of })));
}

/**
 * Of the indexes `wanted` names for each table, those a table the database
 * holds does not: one catalog read per table that wants any.
 * @template {{ index: string }} T
 * @param {any} connection
 * @param {any[]} plans - each with its `table`
 * @param {(plan: any) => T[]} wanted
 * @returns {any} value-or-promise of `T[]`
 */
function missingIndexes(connection, plans, wanted) {
  const dialect = connection.dialect;
  /** @type {T[]} */
  const missing = [];
  const next = (/** @type {number} */ i) => {
    if (i >= plans.length) return missing;
    const plan = plans[i];
    const indexes = wanted(plan);
    if (indexes.length === 0) return next(i + 1);
    return chain(connection.prepare(dialect.introspect.tableExists()), (exists) =>
      chain(exists.get([plan.table]), (row) => (row === undefined ? next(i + 1)
        : chain(connection.prepare(dialect.introspect.indexes(plan.table)), (statement) =>
          chain(statement.all([]), (rows) => {
            const held = new Set(rows.map((/** @type {any} */ candidate) => String(candidate.name)));
            missing.push(...indexes.filter((index) => !held.has(index.index)));
            return next(i + 1);
          })))));
  };
  return next(0);
}

/**
 * What each collection table holds where it is not what this release creates
 * for the model: a generated column in one of its member's types (`types`, by
 * the type word the table declares it in), and a generated column or an
 * interval CHECK in the other spelling of a path the dialect guards
 * (`columns`, `checks`) — read back through the dialect's exact read-back, so
 * a definition that is neither spelling is left to the open path, which
 * refuses it — and a unique index without the boolean keys a fresh store
 * creates after its columns (`indexes`, read from its CREATE text). A table
 * that holds every definition as planned has no entry.
 * @param {any} connection
 * @param {any[]} plans - from `planCollection`, one per collection
 * @returns {any} value-or-promise of `Map<string, { types: Map<string, string>, columns: Set<string>, checks: Set<string>, indexes: Set<string> }>`
 */
function heldDefinitionsOf(connection, plans) {
  const dialect = connection.dialect;
  const readBack = dialect.capabilities.declaredSqlText === true ? undefined : dialect.readBack;
  /** @type {Map<string, { types: Map<string, string>, columns: Set<string>, checks: Set<string>, indexes: Set<string> }>} */
  const held = new Map();
  const next = (/** @type {number} */ i) => {
    if (i >= plans.length) return held;
    const plan = plans[i];
    const spelled = readBack === undefined ? [] : plan.generated.filter((column) => column.alternate !== undefined);
    const checked = readBack === undefined ? [] : (plan.intervals ?? []).filter((interval) => interval.alternate !== undefined);
    const keyed = plan.expected.indexes.some((/** @type {any} */ index) => index.terms !== undefined);
    if (!plan.generated.some((column) => column.legacyTypes !== undefined) && spelled.length === 0 && checked.length === 0 && !keyed)
      return next(i + 1);
    const holding = { types: new Map(), columns: new Set(), checks: new Set(), indexes: new Set() };
    const record = () => (!keyed ? recorded()
      : chain(connection.prepare(dialect.introspect.declaredSql(plan.table)), (statement) => chain(statement.all([]), (objects) => {
        // as the plan of the table's own column types keys them (a column held in a type
        // keys no boolean, and is rebuilt with its indexes)
        holding.indexes = termlessIndexesHeld(dialect, holding.types.size > 0 ? plan.replan(holding.types) : plan, objects);
        return recorded();
      })));
    const recorded = () => {
      if (holding.types.size + holding.columns.size + holding.checks.size + holding.indexes.size > 0) held.set(plan.table, holding);
      return next(i + 1);
    };
    return chain(connection.prepare(dialect.introspect.columns(plan.table)), (statement) =>
      chain(statement.all([]), (rows) => {
        holding.types = legacyColumnTypes(dialect, plan, rows);
        for (const column of spelled) {
          const row = rows.find((candidate) => String(candidate.name) === column.name);
          if (row === undefined || row.default_value === null || row.default_value === undefined) continue;
          const computes = String(row.default_value);
          if (readBack.expression(computes, columnExpression(dialect, column), readsConforming(row)) !== null
            && readBack.expression(computes, column.alternate, readsConforming(row)) === null) holding.columns.add(column.name);
        }
        if (checked.length === 0) return record();
        return chain(connection.prepare(dialect.introspect.checks(plan.table)), (checks) =>
          chain(checks.all([]), (checkRows) => {
            for (const interval of checked) {
              const row = checkRows.find((candidate) => String(candidate.name) === interval.constraint);
              if (row === undefined) continue;
              const guards = readIntervalGuards(String(row.expression ?? ''), dialect.intervalSpelling(readsConforming(row)));
              const guarded = interval.span.unpinned !== undefined;
              if (guards !== null && !(guards.size === 1 && guards.has(guarded))) holding.checks.add(interval.constraint);
            }
            return record();
          }));
      }));
  };
  return next(0);
}

/**
 * The plan of a collection as its table holds it: the generated columns
 * {@link heldDefinitionsOf} read in one of their member's types keep that type,
 * a column or CHECK held in the other spelling carries that text (`holds`),
 * which {@link collectionSteps} compares exactly, and an index held without
 * its boolean keys has none, which {@link indexChanged} reads as a change.
 * @param {any} plan @param {{ types: Map<string, string>, columns: Set<string>, checks: Set<string>, indexes: Set<string> }} holding
 * @returns {any}
 */
function heldPlanOf(plan, holding) {
  const base = holding.types.size > 0 ? plan.replan(holding.types) : plan;
  return { ...base,
    expected: { ...base.expected, indexes: base.expected.indexes.map((/** @type {any} */ index) => {
      if (!holding.indexes.has(index.name)) return index;
      const { terms: _keys, ...termless } = index;
      return termless;
    }) },
    generated: base.generated.map((/** @type {any} */ column) => (holding.columns.has(column.name) ? { ...column, holds: column.alternate } : column)),
    intervals: (base.intervals ?? []).map((/** @type {any} */ interval) => (holding.checks.has(interval.constraint) ? { ...interval, holds: interval.alternate } : interval)) };
}

/** Copy schema positions with the mapping vocabulary stripped: a pure
 * mapping change (an index, a column toggle) is not a DOCUMENT change
 * and demands no transform. Named maps and literal data keep their keys. */
function stripEntityVocabulary(node) {
  if (Array.isArray(node)) return node.map(stripEntityVocabulary);
  if (node === null || typeof node !== 'object') return node;
  /** @type {any} */
  const out = {};
  for (const key of Object.keys(node)) {
    if (key === 'x-entity' || key === 'x-rename') continue;
    const value = node[key];
    const position = schemaPosition(key);
    if (position === 2 && isJsonObject(value)) {
      const map = {};
      for (const name of Object.keys(value)) setObjectMember(map, name, stripEntityVocabulary(value[name]));
      setObjectMember(out, key, map);
    }
    else setObjectMember(out, key, position === 1 ? stripEntityVocabulary(value) : value);
  }
  return out;
}

/**
 * The rule programs a store-owned table keeps through a change: by name, each
 * whose every item (SQLite's trigger; PostgreSQL's function and trigger) is
 * planned with the same text on both sides.
 * @param {{ name: string, sql: string }[]} from @param {{ name: string, sql: string }[]} to
 * @returns {Set<string>}
 */
function keptPrograms(from, to) {
  /** @param {{ name: string, sql: string }[]} items */
  const texts = (items) => {
    /** @type {Map<string, string[]>} */
    const byName = new Map();
    for (const item of items) byName.set(item.name, [...(byName.get(item.name) ?? []), item.sql]);
    return byName;
  };
  const after = texts(to);
  return new Set([...texts(from)].filter(([name, sql]) => after.get(name)?.join('\u0000') === sql.join('\u0000')).map(([name]) => name));
}

/**
 * The steps that drop a table's rule programs but the kept ones, the last
 * installed first (a trigger before the function it calls).
 * @param {{ name: string, type: string, drop: string }[]} programs @param {Set<string>} kept @param {string} table
 */
const dropPrograms = (programs, kept, table) => [...programs].reverse().filter((item) => !kept.has(item.name))
  .map((item) => ({ kind: 'ddl', sql: item.drop, note: `drop the ${item.type} '${item.name}' of a rule on '${table}'` }));

/**
 * The kind a member is extracted from the document as when a column takes
 * it: the JSON string, boolean or number the column's type holds.
 * @param {string} storage - the column's schema type
 * @returns {'text' | 'number' | 'boolean'}
 */
const extractKind = (storage) => (storage === 'string' ? 'text' : storage === 'boolean' ? 'boolean' : 'number');

/**
 * A statement that fails, with `message`, when `source` yields a row and does
 * nothing when it yields none: the message cast to a number on PostgreSQL, and a
 * path SQLite cannot read as one, so each engine's own error carries the
 * sentence.
 * @param {any} dialect @param {string} name - the common table expression's name
 * @param {string} source - its query, selecting the offending rows (at most one)
 * @param {string} message - an SQL text expression
 * @returns {string}
 */
function failingStatement(dialect, name, source, message) {
  const q = dialect.quoteIdentifier;
  return `WITH ${q(name)} AS (${source}) SELECT ${dialect.typedExtract === true
    ? `(${message})::bigint` : `json_extract('{}', ${message})`} FROM ${q(name)}`;
}

/**
 * The step that refuses a lift over a document member of another JSON type
 * than the column that takes it, before any row changes, on an engine that
 * types its extraction: such an engine reads the member as NULL, and a lift
 * that went on would leave the member in the document beside a column that
 * cannot hold it, where the store then fails every write of the row. The
 * refusal is the failing cast of a message that names the member and the type
 * found, as a STRICT column's own refusal is on SQLite (`JD0023`).
 * @param {any} dialect @param {string} table @param {string} member
 * @param {'text' | 'number' | 'boolean'} kind - what the column holds
 * @returns {any}
 */
function mistypedMemberStep(dialect, table, member, kind) {
  const q = dialect.quoteIdentifier, literal = dialect.stringLiteral;
  const found = dialect.jsonTypeName(q('doc'), dialect.jsonPathText([{ name: member }]));
  const held = kind === 'text' ? 'string' : kind;
  return { kind: 'sql', note: `check that no document of '${table}' holds '${member}' as another JSON type than its column`,
    sql: failingStatement(dialect, '_jaren_member',
      `SELECT ${found} AS ${q('found')} FROM ${q(table)} WHERE ${found} NOT IN ('null', ${literal(held)}) LIMIT 1`,
      `${literal(`the member '${member}' of '${table}' holds a JSON `)} || ${q('found')} || `
      + literal(`, where its column holds a JSON ${held}: correct the documents first`)) };
}

/**
 * The relational half of the diff (§9): entity add/drop/rename, the
 * additive and droppable column strategies with their data steps, the
 * rebuild for everything structural, the rules' programs, join tables, and
 * the stripped document-change rule.
 * @param {any} fromModel
 * @param {any} toModel
 * @param {any} dialect
 * @param {any[]} steps
 * @param {any} report
 * @returns {any[]} the steps that create the rule programs an existing table
 *   gains, for the caller to run after every other step (a program judges
 *   the writes after it, a transform's included)
 */
function planEntityChanges(fromModel, toModel, dialect, steps, report, transform = null) {
  /** @type {any[]} */
  const programs = [];
  const fromEntities = normalizeEntities(fromModel);
  const toEntities = normalizeEntities(toModel);
  if (fromEntities.size === 0 && toEntities.size === 0) return programs;
  const fromMapping = fromEntities.size > 0
    ? explainMapping(fromModel) : { entities: {}, joinTables: {} };
  const toMapping = toEntities.size > 0
    ? explainMapping(toModel) : { entities: {}, joinTables: {} };
  const q = dialect.quoteIdentifier;
  const pathText = (name) => dialect.jsonPathText([{ name }]);
  /** @param {string} docSql @param {string} name @param {string} [kind] */
  const docExtract = (docSql, name, kind = undefined) => dialect.jsonExtract(docSql, pathText(name), kind);
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
    // a rule program is named after its table: the old ones go before the rename
    steps.push(...dropPrograms(planEntity(hint, fromMapping.entities[hint], fromMapping, dialect).programs ?? [], new Set(), hint));
    steps.push({ kind: 'ddl', sql: dialect.ddl.renameTable(hint, name),
      note: `rename entity '${hint}' to '${name}'` });
  }
  const consumedOldEntities = new Set(renamedFrom.values());
  // the steps that give a key the allocation the target declares, or take it
  // away, go in after the entity renames and ahead of every other step: a
  // table this migration creates or rebuilds (a join table that follows a
  // renamed endpoint included) meets the converted key, whichever order the
  // model declares the entities in
  const allocation = [];
  const loopStart = steps.length;
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
  // the join table a relation continues in the target: the name it ends up
  // under, joining the same two entities (one name given to another edge is a
  // table that goes and one that is created)
  const endpoints = (join, entityName) => [entityName(join.left.entity), entityName(join.right.entity)].sort().join('\0');
  const continued = (joinName) => {
    const target = toMapping.joinTables[renamedJoinName(joinName)];
    return target !== undefined
      && endpoints(target, (name) => name) === endpoints(fromMapping.joinTables[joinName], renamedEntity) ? target : undefined;
  };
  // a relation that goes takes its join table first: the table references its
  // endpoints, and PostgreSQL will not drop or rebuild an entity under a table
  // that still references it. The table was never renamed with its endpoint:
  // it has the name it was created under
  for (const joinName of Object.keys(fromMapping.joinTables)) {
    if (continued(joinName) !== undefined) continue;
    report.destructive = true;
    steps.push({ kind: 'ddl', sql: dialect.ddl.dropTable(joinName),
      note: `DESTRUCTIVE: drop join table '${joinName}' and its memberships` });
  }
  /**
   * Replace a join table by one built from the target mapping: the target is
   * created (beside the old table when both keep one name), the memberships
   * copied, the old table dropped and the new one given its final name.
   * @param {string} oldName @param {string} finalName @param {any} target
   * @param {(toColumn: string) => string} sourceOf - the old table's column a target column copies from
   * @param {string} why
   */
  const rebuildJoin = (oldName, finalName, target, sourceOf, why) => {
    const q = dialect.quoteIdentifier;
    const targetOrder = [target.left.column, target.right.column];
    // a `through` name stays through the rename, so the rebuilt table is
    // built beside the old one and takes the name once the old one is gone
    const staged = finalName === oldName ? `${oldName}__rebuild` : finalName;
    // the table alone: its index is created last, under the final table's name
    steps.push({ kind: 'ddl', sql: planJoinTable(staged, target, toMapping, dialect).createSql[0],
      note: `rebuild join table '${oldName}' as '${finalName}' ${why}` });
    const indexes = () => {
      for (const sql of planJoinTable(finalName, target, toMapping, dialect).createSql.slice(1))
        steps.push({ kind: 'ddl', sql, note: `index the rebuilt join table '${finalName}'` });
    };
    steps.push({ kind: 'sql',
      sql: `INSERT INTO ${q(staged)} (${targetOrder.map(q).join(', ')}) `
        + `SELECT ${targetOrder.map((column) => q(sourceOf(column))).join(', ')} FROM ${q(oldName)}`,
      note: `copy the memberships of '${oldName}' into '${staged}'` });
    steps.push({ kind: 'ddl', sql: dialect.ddl.dropTable(oldName),
      note: `drop '${oldName}' — its memberships now live in '${staged}'` });
    if (staged === finalName) {
      indexes();
      return;
    }
    steps.push({ kind: 'ddl', sql: dialect.ddl.renameTable(staged, finalName), note: `rename '${staged}' to '${finalName}'` });
    // PostgreSQL named the key after the staged table; a create gives it `<table>_pkey`
    if (dialect.name === 'postgres') {
      steps.push({ kind: 'ddl',
        sql: `ALTER TABLE ${q(finalName)} RENAME CONSTRAINT ${q(postgresKeyName(staged, dialect.maxIdentifierBytes))} `
          + `TO ${q(postgresKeyName(finalName, dialect.maxIdentifierBytes))}`,
        note: `the primary key of '${finalName}' takes the name a create gives it` });
    }
    indexes();
  };
  /** The join tables renamed in place, which a rebuilding link must still rebuild, each with the
   * name its index over the second column was created under. @type {{ name: string, target: any, index: string }[]} */
  const renamedInPlace = [];
  for (const [joinName, join] of Object.entries(fromMapping.joinTables)) {
    if (![join.left, join.right].some((side) => renamedEntity(side.entity) !== side.entity)) continue;
    const newJoin = renamedJoinName(joinName);
    const target = continued(joinName);
    if (target === undefined) continue; // the relation is gone: the drop above names it
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
      renamedInPlace.push({ name: newJoin, target, index: joinIndexName(dialect, joinName, join.right.column) });
      continue;
    }
    rebuildJoin(joinName, newJoin, target, (toColumn) => renamedColumns.find((column) => column.to === toColumn).from,
      'in its endpoint order');
  }

  // the columns of the database that reference an entity's key as it stands
  // when the allocation steps run (the from-model's foreign keys under the
  // names the entity renames gave their tables, its join tables under the
  // names they still have): whatever a key's allocation changes the type of
  // must change with it, a table the migration drops later included
  const referencesTo = (fromName) => {
    const found = [];
    for (const [other, holder] of Object.entries(fromMapping.entities)) {
      for (const fk of holder.foreignKeys) {
        if (fk.references === fromName) found.push({ table: renamedEntity(other), column: fk.column });
      }
    }
    for (const [joinName, join] of Object.entries(fromMapping.joinTables)) {
      for (const side of [join.left, join.right]) {
        if (side.entity === fromName) found.push({ table: joinName, column: side.column });
      }
    }
    return found;
  };
  // the rule functions of tables whose columns change type, replaced as they
  // are: a session that ran one keeps it compiled against the old type, and
  // PostgreSQL refuses its next run ("type of parameter … does not match")
  // until the function is replaced. A renamed table has no program to
  // replace: its programs were dropped before the rename, and are created
  // again at the end under the new name
  const recompiled = (tables) => [...new Set(tables)].flatMap((table) => {
    if (fromMapping.entities[table] === undefined) return [];
    return (planEntity(table, fromMapping.entities[table], fromMapping, dialect).programs ?? [])
      .filter((item) => item.type === 'function')
      .map((item) => ({ kind: 'ddl', sql: item.sql.replace(/^CREATE FUNCTION /, 'CREATE OR REPLACE FUNCTION '),
        note: `compile the rule function '${item.name}' of '${table}' again against the converted columns` }));
  });

  // ————— per-entity strategies —————
  // an entity added after the entities it references: PostgreSQL has no forward references
  const targetOrder = creationOrder([...toEntities.keys()], (name) => toMapping.entities[name].foreignKeys.map((fk) => fk.references));
  /** The foreign keys that close a cycle, added once every table of the migration exists. */
  const keysAfter = [];
  for (const name of targetOrder) {
    const toEntity = toEntities.get(name);
    const fromName = renamedFrom.get(name) ?? name;
    const fromEntity = fromEntities.get(fromName);
    const tm = toMapping.entities[name];

    if (fromEntity === undefined) {
      report.added.push(name);
      const added = planEntity(name, tm, toMapping, dialect, { deferCycles: true });
      for (const sql of added.createSql)
        steps.push({ kind: 'ddl', sql, note: `create entity '${name}'` });
      for (const sql of added.deferredForeignKeys ?? [])
        keysAfter.push({ kind: 'ddl', sql, note: `add the foreign key of entity '${name}' that closes a cycle` });
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
    // a foreign key's column is the table's whether its property is declared
    // or inferred from the relation: declaring (or no longer declaring) the
    // `via` property adds and drops no column
    const heldBy = (/** @type {any} */ mapping) => new Set([...mapping.columns.map((/** @type {any} */ column) => column.name),
      ...mapping.foreignKeys.map((/** @type {any} */ fk) => fk.column)]);
    const fromHeld = heldBy(fm);
    const toHeld = heldBy(tm);
    const addedColumns = [...toColumns.keys()]
      .filter((columnName) => !fromHeld.has(columnName));
    const droppedColumns = [...fromColumns.keys()]
      .filter((columnName) => !toHeld.has(columnName));
    const keysEqual = JSON.stringify(fm.keys) === JSON.stringify(tm.keys);

    const needsRebuild = !keysEqual || !fksEqual || changedColumns.length > 0
      || addedColumns.some((columnName) => toColumns.get(columnName).check !== undefined);

    // a single key that gains or drops the database's allocation (an integer
    // declared `default: "auto"`, or retyped into one): where the engine's
    // allocation is a column property, the column changes with it
    const keyBefore = fm.columns.find((column) => column.key);
    const keyAfter = tm.columns.find((column) => column.key);
    const allocated = (column) => column.storage === 'integer' && column.auto === true;
    if (dialect.autoKeyType !== undefined && keysEqual && fm.keys.length === 1
      && keyBefore !== undefined && keyAfter !== undefined && allocated(keyBefore) !== allocated(keyAfter)) {
      const referencing = needsRebuild ? [] : referencesTo(fromName);
      allocation.push(...allocationSteps(dialect, name, keyAfter.name, allocated(keyAfter), referencing, needsRebuild,
        needsRebuild ? [] : recompiled([name, ...referencing.map((reference) => reference.table)])));
    }

    const fromPlan = planEntity(fromName, fm, fromMapping, dialect);
    const toPlan = planEntity(name, tm, toMapping, dialect);
    // the rules' programs: one that changes, and all of a rebuilt table (whose
    // triggers its DROP takes, but not a PostgreSQL function), are dropped
    // before the table's own work and created again last of all, after the
    // migration's transform steps (`programs`); a renamed table's were
    // dropped before its rename. No stored row is judged
    const kept = fromName !== name || needsRebuild ? new Set()
      : keptPrograms(fromPlan.programs ?? [], toPlan.programs ?? []);
    if (fromName === name) steps.push(...dropPrograms(fromPlan.programs ?? [], kept, name));
    for (const item of toPlan.programs ?? []) {
      if (!kept.has(item.name))
        programs.push({ kind: 'ddl', sql: item.sql, note: `create the ${item.type} '${item.name}' of a rule on '${name}'` });
    }

    if (needsRebuild) {
      steps.push(...renderRebuild(name, fromName, fm, tm, toMapping, dialect, report));
    }
    else {
      // index diff first (a column cannot drop under a live index);
      // from-side index NAMES survive a rename with the OLD prefix
      const fromPlanIndexes = fromPlan.expected.indexes;
      const toPlanIndexes = toPlan.expected.indexes;
      const disturbed = new Set(droppedColumns);
      const toIndexByName = new Map(toPlanIndexes.map((index) => [index.name, index]));
      const fromIndexByName = new Map(fromPlanIndexes.map((index) => [index.name, index]));
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
          const fold = dialect.columnJson(q(columnName), column.storage);
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
        // the member is read as the JSON type its column holds, so an engine
        // that types its extraction hands the column a value of its own type
        // (and refuses first a member that is another: `mistypedMemberStep`)
        if (wasDocStored && column.source === 'epoch(document)') {
          steps.push({ kind: 'sql',
            sql: `UPDATE ${q(name)} SET ${q(columnName)} = `
              + `${dialect.epochFromRfc3339(docExtract(q('doc'), columnName, 'text'))} `
              + `WHERE ${docExtract(q('doc'), columnName, 'text')} IS NOT NULL`,
            note: `derive the epoch column from the document's '${columnName}' strings` });
        }
        else if (wasDocStored) {
          const kind = extractKind(column.storage);
          if (dialect.typedExtract === true) steps.push(mistypedMemberStep(dialect, name, columnName, kind));
          steps.push({ kind: 'sql',
            sql: `UPDATE ${q(name)} SET ${q(columnName)} = ${docExtract(q('doc'), columnName, kind)}, `
              + `${q('doc')} = ${dialect.jsonRemove(q('doc'), pathText(columnName))} `
              + `WHERE ${docExtract(q('doc'), columnName, kind)} IS NOT NULL`,
            note: `move '${columnName}' out of the document into its column` });
        }
      }
      for (const index of toPlanIndexes) {
        const source = fromIndexByName.get(index.name);
        if (source === undefined || indexDies(source)) {
          steps.push({ kind: 'ddl',
            sql: dialect.ddl.createIndex({ name: index.name, table: name,
              columns: index.columns, unique: index.unique, where: index.where }),
            note: `create index '${index.name}' on '${name}'` });
        }
      }
    }

    // the stripped document-change rule (§9)
    const fromDocument = stripEntityVocabulary(fromEntity.schema);
    const toDocument = stripEntityVocabulary(toEntity.schema);
    if (canonicalizeJson(fromDocument) !== canonicalizeJson(toDocument)) {
      report.schemaChanged.push(name);
      // an additive, optional-only change leaves every stored document
      // valid, so the plan applies unattended (the ADD COLUMN above is
      // the whole of it)
      if (isWidening(fromDocument, toDocument)) {
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

  steps.splice(loopStart, 0, ...allocation);
  steps.push(...keysAfter);

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
    // a table's triggers go with it; a PostgreSQL function does not
    steps.push(...dropPrograms(planEntity(name, fromMapping.entities[name], fromMapping, dialect).programs ?? [], new Set(), name));
    steps.push({ kind: 'ddl', sql: dialect.ddl.dropTable(name),
      note: `DESTRUCTIVE: drop entity '${name}' and every row in it` });
  }

  // a link that rebuilds a table runs under SQLite's `legacy_alter_table`,
  // where renaming a table leaves every other table's REFERENCES spelling the
  // old name: a join table renamed in place is rebuilt too, to name the
  // entity it references now
  if (dialect.capabilities.pragmas === true && steps.some((step) => step.kind === 'rebuild')) {
    for (const { name, target } of renamedInPlace)
      rebuildJoin(name, name, target, (toColumn) => toColumn, 'to reference its renamed endpoint');
  }
  else {
    // a join table renamed in place keeps its index over the second column
    // under the name it was created with, which names the table or the
    // column it had: the index is created again under the name a fresh
    // build gives it, and one an earlier release never created is created
    for (const { name, target, index } of renamedInPlace) {
      const plan = planJoinTable(name, target, toMapping, dialect);
      if (plan.expected.indexes.every((/** @type {any} */ planned) => planned.name === index)) continue;
      steps.push({ kind: 'ddl', sql: `DROP INDEX IF EXISTS ${q(index)}`,
        note: `drop the index '${index}' of the renamed join table '${name}', where it has one` });
      for (const sql of plan.createSql.slice(1))
        steps.push({ kind: 'ddl', sql, note: `index the renamed join table '${name}'` });
    }
  }

  // ————— join tables —————
  const fromJoins = new Set(Object.keys(fromMapping.joinTables).filter((joinName) => continued(joinName) !== undefined).map(renamedJoinName));
  for (const joinName of Object.keys(toMapping.joinTables)) {
    if (fromJoins.has(joinName)) continue;
    for (const sql of planJoinTable(joinName, toMapping.joinTables[joinName],
      toMapping, dialect).createSql) {
      steps.push({ kind: 'ddl', sql, note: `create join table '${joinName}'` });
    }
  }
  return programs;
}

/**
 * The name PostgreSQL gives a primary key a CREATE leaves unnamed:
 * `<table>_pkey`, the table's name clipped at a character boundary so the
 * whole fits the dialect's identifier bound (`maxIdentifierBytes`), as
 * PostgreSQL's own naming clips it.
 * @param {string} table @param {number} limit - the identifier bound, in bytes
 * @returns {string}
 */
function postgresKeyName(table, limit) {
  return `${clipToBytes(table, limit - '_pkey'.length)}_pkey`;
}

/**
 * The first statement of a PostgreSQL rebuild: the old table locked against
 * writes for the rest of the link's transaction (reads go on until the old
 * table is dropped). Without it a write another session commits after the
 * copy read the table is dropped with the old table, and a key drawn from
 * the old sequence after the carry read it could be handed out again. A
 * waiting writer continues once the link commits, against the rebuilt
 * table: PostgreSQL resolves the name again when the lock it waited for
 * belongs to a table that is gone. The statement check admits exactly this
 * statement, as a rebuild step's first (`isRebuildLock`).
 * @param {any} dialect @param {string} table @returns {string}
 */
function rebuildLockSql(dialect, table) {
  return `LOCK TABLE ${dialect.quoteIdentifier(table)} IN SHARE ROW EXCLUSIVE MODE`;
}

/**
 * Whether `sql` is the lock a PostgreSQL rebuild step opens with
 * (`rebuildLockSql` of the step's own table), the one LOCK a migration
 * statement may be. @param {any} dialect @param {any} step @param {unknown} sql
 * @returns {boolean}
 */
function isRebuildLock(dialect, step, sql) {
  if (!dialect?.migration || typeof step?.table !== 'string') return false;
  try { return sql === rebuildLockSql(dialect, step.table); }
  catch { return false; }
}

/**
 * The expression that finds the sequence a column owns, at run time and
 * whatever the sequence is called (a renamed table keeps its sequence's old
 * name, a rebuilt table's is named after its temporary table): NULL where the
 * column owns none. The one spelling of the lookup every statement that
 * reads or moves a serial column's sequence uses.
 * @param {any} dialect @param {string} table @param {string} column @returns {string}
 */
function serialSequenceSql(dialect, table, column) {
  return `pg_catalog.pg_get_serial_sequence(${dialect.stringLiteral(dialect.quoteIdentifier(table))}, ${dialect.stringLiteral(column)})`;
}

/**
 * The statement, in a PostgreSQL rebuild's `create`, that carries a serial
 * column's allocation from the old table's sequence to the temporary
 * table's, while both exist. PostgreSQL reads a sequence's position only
 * from the sequence itself, by a name the plan cannot know (a renamed table
 * keeps its sequence's old name, an earlier rebuild left a temporary one),
 * and `pg_sequence_last_value` answers nothing for a sequence whose next
 * value was set rather than handed out. So the old sequence is asked:
 * `nextval` answers the value it would hand out next, and `setval(…, false)`
 * makes that value its next again, so it still hands out the same value
 * next, also when the step rolls back (a sequence change is never rolled
 * back). A column without a sequence answers NULL, and nothing is set.
 * @param {any} dialect @param {string} from - the old table @param {string} to - the temporary table
 * @param {string} column @returns {string}
 */
function carriedSequenceSql(dialect, from, to, column) {
  const q = dialect.quoteIdentifier;
  return `WITH ${q('_jaren_sequence')} AS (SELECT ${serialSequenceSql(dialect, from, column)} AS ${q('old')}) `
    + `SELECT pg_catalog.setval(${serialSequenceSql(dialect, to, column)}, pg_catalog.setval(${q('old')}, `
    + `pg_catalog.nextval(${q('old')}), false), false) FROM ${q('_jaren_sequence')}`;
}

/**
 * The statement, in a PostgreSQL rebuild's `indexes`, that leaves the
 * rebuilt table's serial column allocating the greatest of the value the
 * old table's sequence would have handed out next (carried into this one),
 * the highest copied value plus one, and 1: never a value the table already
 * handed out, never one it holds, and never below the sequence's minimum
 * (a table holding only keys at or below zero allocates 1 next).
 * @param {any} dialect @param {string} table @param {string} column @returns {string}
 */
function advancedSequenceSql(dialect, table, column) {
  const q = dialect.quoteIdentifier;
  const sequence = serialSequenceSql(dialect, table, column);
  return `WITH ${q('_jaren_sequence')} AS (SELECT GREATEST(pg_catalog.nextval(${sequence}), `
    + `COALESCE(MAX(${q(column)}) + 1, 1), 1) AS ${q('next')} FROM ${q(table)}) `
    + `SELECT pg_catalog.setval(${sequence}, ${q('next')}, false) FROM ${q('_jaren_sequence')}`;
}

/**
 * A statement that fails, naming the key and the value, when a stored key of
 * `table` is not a whole number a bigint holds: the cast of its message to
 * `bigint` is the failure, so nothing a conversion would round is converted,
 * and the migration rolls back whole. No row, no failure.
 * @param {any} dialect @param {string} table @param {string} column @returns {string}
 */
function wholeKeySql(dialect, table, column) {
  const q = dialect.quoteIdentifier, literal = dialect.stringLiteral, key = q(column);
  // the key as the number it spells, whatever it is stored as (a key retyped into an integer may be text)
  const number = `${key}::numeric`;
  return failingStatement(dialect, '_jaren_key',
    `SELECT ${key} FROM ${q(table)} WHERE ${number} <> pg_catalog.trunc(${number}) `
    + `OR ${number} NOT BETWEEN -9223372036854775808 AND 9223372036854775807 ORDER BY ${number} LIMIT 1`,
    `${literal(`the key '${column}' of '${table}' holds `)} || ${key}::text || `
    + literal(', which is not a whole number a bigint holds'));
}

/**
 * The PL/pgSQL block of one allocation step, as one statement. Its first
 * line after `DO` names what it does and to which key (`["ensure", table,
 * column]`), so the statement check can admit exactly this text and no other
 * (`isAllocationBlock`): `lock` locks the key's table against every other
 * session, readers included; `ensure` gives the key a sequence it owns, unless
 * it owns one, and makes it the key's default, unless it is an identity;
 * `release` drops the sequence the key owns, unless it owns none. The last two
 * find the sequence at run time, whatever it is called.
 * @param {any} dialect @param {'lock' | 'ensure' | 'release'} action @param {string} table @param {string} column
 * @returns {string}
 */
function allocationBlock(dialect, action, table, column) {
  const q = dialect.quoteIdentifier, literal = dialect.stringLiteral;
  const owned = serialSequenceSql(dialect, table, column);
  const qualified = `${q(table)}.${q(column)}`;
  const body = {
    lock: ['BEGIN', `  LOCK TABLE ${q(table)} IN ACCESS EXCLUSIVE MODE;`, 'END;'],
    release: ['DECLARE', `  seq text := ${owned};`, 'BEGIN', '  IF seq IS NOT NULL THEN',
      `    EXECUTE ${literal('DROP SEQUENCE ')} || seq;`, '  END IF;', 'END;'],
    ensure: ['DECLARE', `  seq text := ${owned};`, `  base text := ${literal(`${table}_${column}_seq`)};`,
      '  name text := base;', '  n integer := 0;',
      // an identity column allocates by itself, and takes no default over it
      `  ident text := coalesce((SELECT attidentity::text FROM pg_catalog.pg_attribute WHERE attrelid = pg_catalog.to_regclass(${literal(q(table))}) AND attname = ${literal(column)}), '');`,
      'BEGIN', '  IF seq IS NULL THEN',
      // the name a serial column would have taken, the next free one where it is held
      // (bounded: a name the server clips is held at every number, and the create then says so)
      '    WHILE n < 1000 AND pg_catalog.to_regclass(pg_catalog.quote_ident(name)) IS NOT NULL LOOP',
      '      n := n + 1;', '      name := base || n;', '    END LOOP;',
      `    EXECUTE ${literal('CREATE SEQUENCE ')} || pg_catalog.quote_ident(name) || ${literal(` AS bigint OWNED BY ${qualified}`)};`,
      `    seq := ${owned};`, '  END IF;', "  IF ident = '' THEN",
      `    EXECUTE ${literal(`ALTER TABLE ${q(table)} ALTER COLUMN ${q(column)} SET DEFAULT nextval(`)} || pg_catalog.quote_literal(seq) || ${literal('::regclass)')};`,
      '  END IF;', 'END;'],
  }[action];
  let tag = '$jaren_allocation$';
  for (let i = 1; body.some((line) => line.includes(tag)); i++) tag = `$jaren_allocation_${i}$`;
  return `DO ${tag}\n-- ${JSON.stringify([action, table, column])}\n${body.join('\n')}\n${tag}`;
}

/**
 * What an allocation block's first line names: its action, table and key, or
 * `null` for any other statement.
 * @param {unknown} sql @returns {['lock' | 'ensure' | 'release', string, string] | null}
 */
function allocationBlockOf(sql) {
  const header = typeof sql === 'string' ? /^DO \$[A-Za-z_0-9]*\$\n-- (\[[^\n]*\])\n/.exec(sql) : null;
  if (header === null) return null;
  try {
    const [action, table, column] = JSON.parse(header[1]);
    return (action === 'lock' || action === 'ensure' || action === 'release') && typeof table === 'string' && typeof column === 'string'
      ? [action, table, column] : null;
  }
  catch { return null; }
}

/**
 * Whether `sql` is exactly an allocation block the planner renders
 * (`allocationBlock`): the one `DO` a PostgreSQL migration statement may be,
 * admitted only by being byte for byte what the planner writes for the key
 * it names, as a rebuild's lock is (`isRebuildLock`).
 * @param {any} dialect @param {unknown} sql @returns {boolean}
 */
function isAllocationBlock(dialect, sql) {
  const named = allocationBlockOf(sql);
  return named !== null && sql === allocationBlock(dialect, ...named);
}

/**
 * The steps that give an entity's single integer key the allocation its model
 * now declares, or take it away, where the engine's allocation is a column
 * property (`autoKeyType`: PostgreSQL's `bigserial`, a `bigint` that its own
 * sequence feeds, against the `numeric` of a key the caller supplies).
 * PostgreSQL implements a reference to a key from a column of the same type or
 * a `bigint` column against a `numeric` key, never a `numeric` column against
 * a `bigint` key, so the type changes run in the one order that never meets
 * the second: gaining, the key's table is locked first, a check that no stored
 * key is a number the conversion would round runs under that lock, then every
 * referencing column and then the key become `bigint`; dropping, the key
 * (its identity and default removed) and then every referencing column become
 * `numeric`. A column that already has what the step gives it, an identity
 * that allocates already, or an edit that finds no sequence to drop, is left
 * as it is. A table the same edit rebuilds takes its sequence from the
 * rebuild, and is only locked and checked.
 * @param {any} dialect @param {string} table @param {string} column - the key
 * @param {boolean} gain - whether the key gains allocation (else it drops it)
 * @param {{ table: string, column: string }[]} referencing - the columns that reference the key
 * @param {boolean} rebuilt - whether the same edit rebuilds the key's table
 * @param {any[]} recompile - the steps that replace the rule functions of the tables whose columns change type
 * @returns {any[]}
 */
function allocationSteps(dialect, table, column, gain, referencing, rebuilt, recompile) {
  const q = dialect.quoteIdentifier;
  const allocated = dialect.comparableColumnType(dialect.autoKeyType).toLowerCase();
  const stored = dialect.typeFor('integer', 'generated');
  const alter = (/** @type {string} */ holder, /** @type {string} */ name, /** @type {string} */ type, /** @type {string} */ note) =>
    ({ kind: 'ddl', sql: `ALTER TABLE ${q(holder)} ALTER COLUMN ${q(name)} TYPE ${type}`, note });
  const key = `the key '${column}' of '${table}'`;
  const references = (/** @type {string} */ type) => referencing.map((reference) => alter(reference.table, reference.column, type,
    `convert '${reference.table}'.'${reference.column}', which references ${key}, to ${type}`));
  if (gain) {
    // the key's table is locked first, readers included: the check and the conversions then see the same keys
    // (a session cannot commit a fractional one between them), and a session that wrote the key's table before
    // the migration began finishes its work on the tables that reference it before any of them is touched
    return [{ kind: 'ddl', sql: allocationBlock(dialect, 'lock', table, column), note: `lock '${table}' against every other session while its keys are checked and converted` },
      { kind: 'sql', sql: wholeKeySql(dialect, table, column), note: `check that every stored value of ${key} is a whole number a bigint holds` },
      ...(rebuilt ? [] : [...references(allocated), alter(table, column, allocated, `convert ${key} to ${allocated}`),
        { kind: 'ddl', sql: allocationBlock(dialect, 'ensure', table, column), note: `give ${key} a sequence it owns and make it the default` },
        { kind: 'sql', sql: advancedSequenceSql(dialect, table, column), note: `continue the sequence of ${key} past the highest stored key` },
        ...recompile])];
  }
  return rebuilt ? [] : [
    { kind: 'ddl', sql: `ALTER TABLE ${q(table)} ALTER COLUMN ${q(column)} DROP IDENTITY IF EXISTS`, note: `remove the identity of ${key}, if it is one` },
    { kind: 'ddl', sql: `ALTER TABLE ${q(table)} ALTER COLUMN ${q(column)} DROP DEFAULT`, note: `remove the default of ${key}` },
    alter(table, column, stored, `convert ${key} to ${stored}`), ...references(stored),
    { kind: 'ddl', sql: allocationBlock(dialect, 'release', table, column), note: `drop the sequence ${key} owned` },
    ...recompile];
}

/** A rebuilt table's primary key, with its schema, when it is not yet under
 * the name `$2` and no relation of its schema, nor a constraint of its own
 * table, holds that name. */
const REBUILT_KEY_SQL = 'SELECT n.nspname AS "schema", i.relname AS "key" FROM pg_catalog.pg_index x '
  + 'JOIN pg_catalog.pg_class t ON t.oid = x.indrelid JOIN pg_catalog.pg_class i ON i.oid = x.indexrelid '
  + 'JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace '
  + 'WHERE x.indrelid = pg_catalog.to_regclass($1) AND x.indisprimary AND i.relname <> $2 '
  + 'AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c WHERE c.relnamespace = t.relnamespace AND c.relname = $2) '
  + 'AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint k WHERE k.conrelid = t.oid AND k.conname = $2)';

/**
 * The last part of a PostgreSQL rebuild, the runner's: the primary key takes
 * the name a create gives it, `<table>_pkey`, where no other relation holds
 * that name. PostgreSQL named it after the temporary table
 * (`<table>__rebuild_pkey`, with a number appended where that name was
 * taken), and no statement renames only to a free name, so the runner looks
 * the names up. Where `<table>_pkey` is held — by the key of a table renamed
 * away from this name, say — the key keeps its name, which the duplicate-key
 * classification also reads as this table's.
 * @param {any} connection @param {string} table @returns {any} value-or-promise
 */
function nameRebuiltKey(connection, table) {
  const q = connection.dialect.quoteIdentifier;
  const natural = postgresKeyName(table, connection.dialect.maxIdentifierBytes);
  return chain(useStatementOnce(connection, REBUILT_KEY_SQL, (statement) => statement.all([q(table), natural])),
    (/** @type {any[]} */ rows) => (rows.length === 0 ? null
      : connection.exec(`ALTER INDEX ${q(String(rows[0].schema))}.${q(String(rows[0].key))} RENAME TO ${q(natural)}`)));
}

/** Precisions 1 to 17 with each engine's format for that many significant
 * digits, in exponent notation: the shortest that reads back as the stored
 * double is the digits JavaScript's `String()` writes. */
const PRECISIONS = Object.freeze({
  sqlite: `(VALUES ${Array.from({ length: 17 }, (_, at) => `(${at + 1}, '%!.${at}e')`).join(', ')})`,
  postgres: `(VALUES ${Array.from({ length: 17 }, (_, at) => `(${at + 1}, '9${at === 0 ? '' : `.${'9'.repeat(at)}`}EEEE')`).join(', ')})`,
});

/**
 * The text a stored number reads as when the engine's `String()` spells the
 * double it reads: the shortest digits that read back as that double, written
 * out in full from 1e-6 up to below 1e21 and with an exponent outside it
 * (`5`, `0.1`, `1e+21`, `1e-7`, `5e-324`); zero, negative zero included, is
 * `0`. The digits are the fewest, of 1 to 17, that cast back to the same
 * double, rounded by the engine's own formatter or the next number of as many
 * digits on either side: SQLite rounds the double itself, and its last of 16 or
 * 17 digits can differ from `String()`'s (the text still reads back as the
 * double); PostgreSQL rounds the decimal its numeric column holds, which is the
 * shortest spelling wherever the store wrote the number. PostgreSQL's numeric
 * also holds what a double does not: `NaN` and the infinities spell as
 * themselves, a value beyond the double range as `Infinity`, and one so small
 * that it reads as zero as `0`. SQLite's infinities spell as JavaScript's.
 * @param {any} dialect @param {string} ref - the quoted column
 * @returns {string}
 */
function numberTextSql(dialect, ref) {
  const postgres = dialect.name === 'postgres';
  const q = dialect.quoteIdentifier;
  const [abs, substr, at, length, rtrim, replace] = postgres
    ? ['pg_catalog.abs', 'pg_catalog.substr', 'pg_catalog.strpos', 'pg_catalog.length', 'pg_catalog.rtrim', 'pg_catalog.replace']
    : ['abs', 'substr', 'instr', 'length', 'rtrim', 'replace'];
  const [a, p, s, m, e, d, n, k, c, o] = ['a', 'p', 's', 'm', 'e', 'd', 'n', 'k', 'c', 'o'].map((name) => q(`_jaren_${name}`));
  const zeros = `'${'0'.repeat(20)}'`;
  /** @param {string} format - the engine's format, a literal or a column */
  const formattedBy = (format) => (postgres ? `pg_catalog.btrim(pg_catalog.to_char(${a}, ${format}))` : `printf(${format}, ${a})`);
  // the column is read once, in a select of its own, so that no name of the
  // derived tables below can stand for it
  const target = `(SELECT ${abs}(${ref}) AS ${a}) AS ${q('_jaren_target')}`;
  /** A text that spells a number in full, `s`, reads back as the double the store reads. @param {string} text */
  const readsBack = (text) => (postgres
    // a rounding can leave the double range, which PostgreSQL's cast refuses rather than reads
    ? `CASE WHEN pg_catalog.pg_input_is_valid(${text}, 'double precision') `
      + `THEN CAST(${text} AS double precision) = CAST(${a} AS double precision) ELSE false END`
    : `CAST(${text} AS REAL) = ${a}`);
  /** The engine's rounding `s` taken apart: the value is 0.<d> times ten to the n; a formatter that
   * carries a rounding into a new digit writes it before the point (`10.0e+00`). @param {string} formatted */
  const rounded = (formatted) => `SELECT ${s}, ${p}, ${a}, ${rtrim}(${replace}(${m}, '.', ''), '0') AS ${d}, `
    + `${e} + CASE ${at}(${m}, '.') WHEN 0 THEN ${length}(${m}) ELSE ${at}(${m}, '.') - 1 END AS ${n} `
    + `FROM (SELECT ${s}, ${p}, ${a}, ${substr}(${s}, 1, ${at}(${s}, 'e') - 1) AS ${m}, `
    + `CAST(${substr}(${s}, ${at}(${s}, 'e') + 1) AS INTEGER) AS ${e} FROM (${formatted}) AS ${q('_jaren_formatted')}) AS ${q('_jaren_parts')}`;
  // a normal double whose rounding to 15 digits reads back has no other spelling
  // of 15 digits or fewer, so those digits are its shortest: most numbers stop here
  const fifteen = `SELECT ${d}, ${n} FROM (${rounded(`SELECT ${formattedBy(postgres ? `'9.${'9'.repeat(14)}EEEE'` : "'%!.14e'")} AS ${s}, 15 AS ${p}, ${a} FROM ${target}`)}) `
    + `AS ${q('_jaren_rounded')} WHERE ${a} >= 2.2250738585072014e-308 AND ${readsBack(s)}`;
  // otherwise the first precision of 1 to 17 one of three candidates reads back
  // at: the engine's rounding and its two neighbours, each an integer of p
  // digits times ten to the e. Next to a power of two the double reads back
  // from a wider interval above it than below, so the nearest rounding can
  // miss where the one on the other side reads back
  const candidates = `SELECT ${p}, ${a}, column1 AS ${o}, CAST(CAST(${substr}(${d} || ${zeros}, 1, ${p}) AS BIGINT) + column1 AS TEXT) AS ${c}, `
    + `${n} - ${p} AS ${e} FROM (${rounded(`SELECT ${formattedBy('column2')} AS ${s}, column1 AS ${p}, ${a} FROM ${target}, `
      + `${postgres ? PRECISIONS.postgres : PRECISIONS.sqlite} AS ${q('_jaren_precision')}`)}) AS ${q('_jaren_rounded')}, `
    + `(VALUES (0), (1), (-1)) AS ${q('_jaren_offset')}`;
  const searched = `SELECT ${rtrim}(${c}, '0') AS ${d}, ${e} + ${length}(${c}) AS ${n} FROM (${candidates}) AS ${q('_jaren_candidate')} `
    + `WHERE ${readsBack(`${c} || 'e' || CAST(${e} AS TEXT)`)} ORDER BY ${p}, ${o} * ${o}, ${o} LIMIT 1`;
  const shortest = `SELECT ${d}, ${n} FROM (${fifteen}) AS ${q('_jaren_fifteen')} UNION ALL `
    + `SELECT ${d}, ${n} FROM (${searched}) AS ${q('_jaren_searched')} LIMIT 1`;
  const spelled = `SELECT CASE WHEN ${n} >= ${k} AND ${n} <= 21 THEN ${d} || ${substr}(${zeros}, 1, ${n} - ${k}) `
    + `WHEN ${n} > 0 AND ${n} <= 21 THEN ${substr}(${d}, 1, ${n}) || '.' || ${substr}(${d}, ${n} + 1) `
    + `WHEN ${n} > -6 AND ${n} <= 0 THEN '0.' || ${substr}(${zeros}, 1, -${n}) || ${d} `
    + `ELSE ${substr}(${d}, 1, 1) || CASE WHEN ${k} = 1 THEN '' ELSE '.' || ${substr}(${d}, 2) END `
    + `|| 'e' || CASE WHEN ${n} > 0 THEN '+' ELSE '-' END || CAST(${abs}(${n} - 1) AS TEXT) END `
    + `FROM (SELECT ${d}, ${length}(${d}) AS ${k}, ${n} FROM (${shortest}) AS ${q('_jaren_shortest')}) AS ${q('_jaren_digits')}`;
  const outside = postgres
    ? `WHEN ${ref} IN ('NaN', 'Infinity', '-Infinity') THEN CAST(${ref} AS TEXT) `
      + `WHEN NOT pg_catalog.pg_input_is_valid(CAST(${ref} AS TEXT), 'double precision') `
      + `THEN CASE WHEN ${abs}(${ref}) < 1 THEN '0' WHEN ${ref} < 0 THEN '-Infinity' ELSE 'Infinity' END `
    : `WHEN ${ref} = 9e999 THEN 'Infinity' WHEN ${ref} = -9e999 THEN '-Infinity' `;
  return `CASE WHEN ${ref} IS NULL THEN NULL ${outside}WHEN ${ref} = 0 THEN '0' `
    + `ELSE CASE WHEN ${ref} < 0 THEN '-' ELSE '' END || (${spelled}) END`;
}

/** The characters JavaScript's `Number()` trims around the number a text
 * spells, by code point: the ASCII blanks both engines' casts skip too, and the
 * others (a no-break space, U+FEFF, U+3000, ...), which neither cast skips. */
const NUMBER_BLANKS = Object.freeze([0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x1680,
  0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a,
  0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff]);

/** The storages a text is read into as the number it spells. */
const NUMBER_STORAGES = new Set(['number', 'integer', 'boolean']);

/**
 * A text column read as the text `Number()` reads a number from: without the
 * blanks it trims at either end ({@link NUMBER_BLANKS}). A text that is blank
 * once they are gone is the empty text, which the retype check refuses though
 * `Number()` reads it as `0` (and SQLite's cast as `0.0`): no writer meant a
 * number by it.
 * @param {any} dialect @param {string} ref - the quoted column
 * @returns {string}
 */
function numberTextOf(dialect, ref) {
  return dialect.name === 'postgres'
    ? `pg_catalog.btrim(${ref}, ${NUMBER_BLANKS.map((code) => `pg_catalog.chr(${code})`).join(' || ')})`
    : `trim(${ref}, char(${NUMBER_BLANKS.join(', ')}))`;
}

/**
 * The copy of a column whose type a rebuild changes: its cast, except into
 * text, where a value is spelled as the engine's `String()` spells what the
 * store reads — a number as {@link numberTextSql} does, a boolean as `true` or
 * `false`. An integer keeps its digits (SQLite's 64-bit integer, PostgreSQL's
 * numeric below 1e21, which also drops a scale a retype from text left, `12.0`),
 * so one past 2^53 that no double holds is not rounded by the retype. A text
 * cast to a number, an integer or a boolean is cast without the blanks
 * `Number()` trims ({@link numberTextOf}).
 * @param {any} dialect @param {string} ref - the quoted column
 * @param {string} from - the column's storage now
 * @param {string} to - the storage it is retyped to
 * @param {string} type - the target column's type, its name alone
 * @returns {string}
 */
function retypedSql(dialect, ref, from, to, type) {
  if (to !== 'string') return `CAST(${from === 'string' && NUMBER_STORAGES.has(to) ? numberTextOf(dialect, ref) : ref} AS ${type})`;
  if (from === 'boolean') return `CASE ${ref} WHEN 1 THEN 'true' WHEN 0 THEN 'false' ELSE CAST(${ref} AS ${type}) END`;
  if (from === 'number') return numberTextSql(dialect, ref);
  if (from === 'integer' && dialect.name === 'postgres')
    return `CASE WHEN pg_catalog.abs(${ref}) < 1e21 THEN CAST(pg_catalog.trim_scale(${ref}) AS ${type}) ELSE ${numberTextSql(dialect, ref)} END`;
  return `CAST(${ref} AS ${type})`;
}

/**
 * The check ahead of a rebuild's copy that no stored value of a column is one
 * the cast to its new type would change, or `null` where the cast loses
 * nothing. A value is changed when the cast truncates it, reads it as a number
 * it does not name, or cannot hold it: a text that names no number reads as `0`
 * on SQLite, `12.5` becomes the integer `12`, a number outside 64 bits
 * saturates, an integer past 2^53 rounds into a double, and `0.5` or `81` is no
 * boolean. A spelling the cast reads right (`007`, `+5`, ` 12`, `12.0`, `.5`)
 * is no change. A text is judged as the copy casts it, without the blanks
 * `Number()` trims around a number (a no-break space, U+FEFF), except in a
 * column a foreign key joins, which the copy casts as it is; a text blank once
 * they are gone names no number and is refused, though `Number()` reads it as
 * `0`. The statement fails, naming the member and the first value in
 * order that would change, as `wholeKeySql` does; no such value, no failure,
 * and a missing member (SQL NULL) is no value. Both engines refuse a value
 * whose number the cast would not keep, with three exceptions of the engines'
 * own casts: SQLite reads only the digits before a fraction or an exponent of
 * a text (`1e3` is `1` there, and refused) and reads `0x10` as `0` (refused),
 * where PostgreSQL reads an unsigned hexadecimal, octal or binary integer as
 * `Number()` does (`0x10` is 16, and held); and PostgreSQL's numeric column
 * keeps an integer past 2^53 as it is (a double read back rounds it). A text
 * below the double range (`1e-400`) is no change: `Number()` reads it as 0 too.
 * @param {any} dialect @param {string} table @param {string} column
 * @param {string} from - the column's storage now
 * @param {string} to - the storage it is retyped to
 * @param {boolean} instant - the column is an epoch column, which stays within a double's exact range
 * @param {boolean} joined - a foreign key joins the column, which the copy casts as it is
 * @returns {string | null}
 */
function retypeCheckSql(dialect, table, column, from, to, instant, joined) {
  const q = dialect.quoteIdentifier, literal = dialect.stringLiteral, ref = q(column);
  const postgres = dialect.name === 'postgres';
  const text = from === 'string';
  // a text is judged as the copy casts it: without the blanks Number() trims, but where a foreign key joins it
  const read = text && !joined ? numberTextOf(dialect, ref) : ref;
  const int64 = '-9223372036854775808 AND 9223372036854775807';
  // the spellings PostgreSQL's numeric cast reads as JavaScript's Number() does: blanks around a sign,
  // digits with an optional point and an exponent (bounded, so that no digit string reaches an overflow
  // the server answers in its own words), or an unsigned hexadecimal, octal or binary integer (`0x10`);
  // the cast also reads a signed one and digits grouped by `_`, which Number() reads as NaN
  const radix = '0([xX][0-9a-fA-F]+|[oO][0-7]+|[bB][01]+)';
  const decimalText = `^[[:space:]]*([+-]?([0-9]+[.]?[0-9]*|[.][0-9]+)([eE][+-]?[0-9]{1,4})?|${radix})[[:space:]]*$`;
  const digitsText = `^[[:space:]]*([+-]?[0-9]+|${radix})[[:space:]]*$`;
  /** @type {string} */
  let lost, held;
  if (to === 'boolean' && text) {
    lost = postgres
      ? `NOT CASE WHEN ${read} ~ ${literal(digitsText)} THEN CAST(${read} AS numeric) IN (0, 1) ELSE false END`
      : `NOT (${read} NOT GLOB '*[.eE]*' AND CAST(${read} AS INTEGER) = ${read} AND CAST(${read} AS INTEGER) IN (0, 1))`;
    held = 'the 0 or 1 a boolean is stored as';
  }
  else if (to === 'boolean') {
    lost = `${ref} NOT IN (0, 1)`;
    held = 'the 0 or 1 a boolean is stored as';
  }
  else if (to === 'integer' && text) {
    // SQLite compares the cast with the text read as a number: a text just below -2^63 reads as the double
    // -2^63, which the saturated cast equals, so that one boundary is held to its own spelling; a nonzero
    // fraction is refused outright, for a double past 2^53 would hide it
    lost = postgres
      ? `NOT CASE WHEN ${read} ~ ${literal(decimalText)} THEN CAST(${read} AS numeric) = pg_catalog.trunc(CAST(${read} AS numeric)) `
        + `AND CAST(${read} AS numeric) BETWEEN ${int64} ELSE false END`
      : `NOT (CAST(${read} AS INTEGER) = ${read} AND ${read} NOT GLOB '*.*[1-9]*' `
        + `AND (CAST(${read} AS INTEGER) <> -9223372036854775808 OR ${read} = '-9223372036854775808'))`;
    held = 'a whole number a 64-bit integer holds';
  }
  else if (to === 'integer' && from === 'number') {
    // the double -2^63 is an integer: PostgreSQL's numeric column holds its decimal spelling, which is read as the double
    lost = postgres
      ? `${ref} <> pg_catalog.trunc(${ref}) OR NOT (CAST(${ref} AS double precision) >= -9223372036854775808 `
        + `AND CAST(${ref} AS double precision) < 9223372036854775808)`
      : `CAST(${ref} AS INTEGER) <> ${ref}`;
    held = 'a whole number a 64-bit integer holds';
  }
  else if (to === 'number' && text) {
    lost = postgres
      ? `NOT CASE WHEN ${read} ~ ${literal(decimalText)} THEN pg_catalog.abs(CAST(${read} AS numeric)) <= 1.7976931348623157E+308 ELSE false END`
      : `NOT (CAST(${read} AS REAL) = ${read} AND CAST(${read} AS REAL) NOT IN (9e999, -9e999))`;
    held = 'a finite number';
  }
  else if (to === 'number' && from === 'integer' && !instant && !postgres) {
    lost = `CAST(${ref} AS REAL) <> ${ref}`;
    held = 'an integer a double holds exactly';
  }
  else return null;
  // SQLite spells a bad path's text back with its quotes doubled, so its names are quoted the other way
  const mark = postgres ? "'" : '"';
  const message = `${literal(`the member ${mark}${column}${mark} of ${mark}${table}${mark} holds `)} || CAST(${ref} AS TEXT) || `
    + literal(`, which is not ${held}, so the retype would change it: correct the values first`);
  return failingStatement(dialect, '_jaren_cast',
    `SELECT ${ref} FROM ${q(table)} WHERE ${ref} IS NOT NULL AND (${lost}) ORDER BY ${ref} LIMIT 1`, message);
}

/**
 * Render one rebuild step (§10): self-contained SQL — the temporary
 * table, the column-mapped copy, the final-name indexes. The table's rule
 * programs are not the step's: the old ones were dropped before it, the new
 * ones are created in steps of their own after the migration's transform
 * steps (`planEntityChanges`). On PostgreSQL
 * the step opens by locking the old table against writes (`rebuildLockSql`),
 * the copy also carries each row's `rid` (the order an entity reads in),
 * and every serial column — an allocated key, the `rid` — continues from
 * the old table's sequence: `create` carries its position across before the
 * old table is dropped, and `indexes` advances it past the copied values.
 */
function renderRebuild(name, fromName, fm, tm, toMapping, dialect, report) {
  const q = dialect.quoteIdentifier;
  const pathText = (memberName) => dialect.jsonPathText([{ name: memberName }]);
  const temporary = `${name}__rebuild`;
  const create = [planEntity(temporary, tm, toMapping, dialect).createSql[0]];
  const finalPlan = planEntity(name, tm, toMapping, dialect);
  // the rule programs end `createSql`, and are not this step's
  const indexes = finalPlan.createSql.slice(1, finalPlan.createSql.length - (finalPlan.programs?.length ?? 0));

  const fromColumns = new Map(fm.columns.map((column) => [column.name, column]));
  const fromFkOnly = fm.foreignKeys
    .filter((fk) => !fromColumns.has(fk.column)).map((fk) => fk.column);
  const fromHas = (columnName) =>
    fromColumns.has(columnName) || fromFkOnly.includes(columnName);
  const storageType = (storage) => dialect.typeFor(storage, 'generated');
  /** Whether a foreign key joins the column: one of this table's, or another
   * table's (a join table's included) that references it. @param {string} columnName */
  const joined = (columnName) => tm.foreignKeys.some((/** @type {any} */ fk) => fk.column === columnName)
    || Object.values(toMapping.entities).some((/** @type {any} */ mapping) => mapping.foreignKeys
      .some((/** @type {any} */ fk) => fk.references === name && fk.referencesKey === columnName))
    || Object.values(toMapping.joinTables ?? {}).some((/** @type {any} */ join) => [join.left, join.right]
      .some((side) => side.entity === name && side.referencesKey === columnName));
  /** The storage an inferred foreign-key column holds: the key it references. */
  const referencedStorage = (/** @type {any} */ mapping, /** @type {string} */ columnName) =>
    mapping.foreignKeys.find((/** @type {any} */ fk) => fk.column === columnName)?.referencesType;

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
  // schema refused. A built-in dialect names the document once, however many
  // columns fold, so the copy grows with the columns it folds; one that
  // spells no conditional write repeats it in both branches of a CASE
  const foldColumn = (expression, columnName, fold) => (dialect[MEMBER_WHEN] === undefined
    ? `CASE WHEN ${q(columnName)} IS NULL THEN ${expression} `
      + `ELSE ${dialect.jsonSet(expression, pathText(columnName), fold)} END`
    : dialect[MEMBER_WHEN](expression, columnName, fold, `${q(columnName)} IS NOT NULL`));
  // the checks of the members the copy reads from the document into a typed
  // column, which run ahead of the rebuild
  const guards = [];
  // the checks of the columns the copy casts to another type, which run in the
  // rebuild itself, after the new table and (on PostgreSQL) under the table lock
  /** @type {string[]} */
  const retypeChecks = [];
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
        docExpr = foldColumn(docExpr, columnName, dialect.columnJson(q(columnName), 'string'));
      }
      else if (column !== null && column.source !== 'epoch(document)' && column.storage === 'string'
        && fromColumn !== undefined && fromColumn.source === 'epoch(document)') {
        // a derived instant becomes a plain string column: it holds the string
        // the document holds (the epoch is the derivation of it), which then
        // leaves the document, as a member that moved into a column does. A
        // column of another type takes the epoch itself, cast
        sources.push(dialect.jsonExtract(q('doc'), pathText(columnName), 'text'));
        if (dialect.typedExtract === true) guards.push(mistypedMemberStep(dialect, name, columnName, 'text'));
        docExpr = dialect.jsonRemove(docExpr, pathText(columnName));
      }
      else if (sameStorage) {
        sources.push(q(columnName));
      }
      else {
        // the type's name alone: a collation belongs to the column, and
        // `CAST(x AS text COLLATE "C")` is not a cast. A column a foreign key
        // joins keeps the engine's cast, into text and out of it, so the
        // reference matches the key it names while one side is rebuilt and the
        // other not yet
        const type = dialect.comparableColumnType(storageType(column.storage));
        sources.push(joined(columnName) ? `CAST(${q(columnName)} AS ${type})`
          : retypedSql(dialect, q(columnName), fromColumn.storage, column.storage, type));
        const check = retypeCheckSql(dialect, name, columnName, fromColumn.storage, column.storage,
          fromColumn.source === 'epoch(document)', joined(columnName));
        if (check !== null) retypeChecks.push(check);
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
    // a new column: from the document when the property existed there, read
    // as the JSON type the column holds (an instant, as the string it is)
    const epoch = column !== null && column.source === 'epoch(document)';
    const kind = epoch ? 'text' : extractKind(column === null ? referencedStorage(tm, columnName) : column.storage);
    const member = dialect.jsonExtract(q('doc'), pathText(columnName), kind);
    if (!epoch && dialect.typedExtract === true) guards.push(mistypedMemberStep(dialect, name, columnName, kind));
    sources.push(epoch ? dialect.epochFromRfc3339(member) : member);
  }
  // columns that vanish: fold survivors into the document, name losses
  for (const [columnName, fromColumn] of fromColumns) {
    if (ordered.some((entry) => entry.name === columnName)) continue;
    const survives = fromColumn.source !== 'epoch(document)'
      && toMapping.entities[name] !== undefined
      && tm.document.includes(columnName);
    if (survives) {
      docExpr = foldColumn(docExpr, columnName, dialect.columnJson(q(columnName), fromColumn.storage));
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
      docExpr = foldColumn(docExpr, columnName, dialect.columnJson(q(columnName), referencedStorage(fm, columnName)));
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
  create.splice(1, 0, ...retypeChecks);
  if (dialect.name === 'postgres') {
    // writers wait from the first statement on: nothing committed after the
    // copy read the table is dropped with it, and no key is drawn from the
    // old sequence after the carry read it
    create.unshift(rebuildLockSql(dialect, name));
    // PostgreSQL's serial columns: an allocated key, and the `rid` every
    // table carries, by which an entity's rows read in the order they were
    // written. The copy keeps each row's `rid`, and every serial column's
    // sequence continues from the old table's: `create` carries the old
    // position across while both tables exist (a key column the old table
    // lacked had none to carry), `indexes` advances it past the copied values
    const identity = dialect.identityColumn?.name;
    const serials = tm.columns.filter((/** @type {any} */ c) => c.key && c.auto === true)
      .map((/** @type {any} */ c) => c.name);
    if (identity !== undefined && !ordered.some((entry) => entry.name === identity)) {
      targets.push(q(identity));
      sources.push(q(identity));
      serials.push(identity);
    }
    for (const column of serials) {
      if (column === identity || fromColumns.has(column)) create.push(carriedSequenceSql(dialect, name, temporary, column));
      indexes.push(advancedSequenceSql(dialect, name, column));
    }
  }

  if (lost.length > 0) report.destructive = true;
  const copy = `INSERT INTO ${q(temporary)} (${targets.join(', ')}) `
    + `SELECT ${sources.join(', ')} FROM ${q(name)}`;
  return [...guards, {
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
  return createShapeHolding(connection, model, expressions, { columns: new Map(), bareJoins: new Set() });
}

/**
 * {@link createModelShape}, with some generated columns in the type a table
 * holds them in, some join tables without the index over their second
 * key column, (`bareKinds`) every collection without the indexes beside
 * its declared ones over a member of several kinds, and (`termless`) some
 * unique indexes without the boolean keys after their columns, as an earlier
 * release created them.
 * @param {any} connection
 * @param {any} model
 * @param {any} expressions
 * @param {{ columns: Map<string, Map<string, string>>, bareJoins: Set<string> | 'all', bareKinds?: boolean,
 *   termless?: Map<string, Set<string>> }} legacy -
 *   `columns` by table, then by column; `bareJoins` the join tables created without
 *   that index, or `'all'` of them; `termless` by table, the indexes' names
 * @returns {any}
 */
function createShapeHolding(connection, model, expressions, legacy) {
  const dialect = connection.dialect;
  /** @type {string[]} */
  const statements = [];
  for (const collection of normalizeModel(model, expressions).values()) {
    const plan = planCollection(collection.name, collection, dialect,
      { ...mappingFor(connection, expressions), legacyColumns: legacy.columns.get(collection.name) });
    const beside = new Set(legacy.bareKinds === true ? plan.kindIndexes.map((/** @type {any} */ index) => kindIndexSql(dialect, plan.table, index)) : []);
    const termless = legacy.termless?.get(plan.table);
    /** @type {Map<string, string>} */
    const spelled = new Map(plan.expected.indexes.filter((/** @type {any} */ index) => termless?.has(index.name))
      .map((/** @type {any} */ index) => [dialect.ddl.createIndex({ ...index, table: plan.table }),
        dialect.ddl.createIndex({ ...index, table: plan.table, terms: undefined })]));
    statements.push(...plan.createSql.filter((/** @type {string} */ sql) => !beside.has(sql)).map((/** @type {string} */ sql) => spelled.get(sql) ?? sql));
  }
  // a shape is built for a baseline too, which is history
  const entities = asHistory(() => normalizeEntities(model));
  if (entities.size > 0) {
    const mapping = asHistory(() => explainMapping(model));
    const plans = Object.keys(mapping.entities).map((name) => planEntity(name, mapping.entities[name], mapping, dialect, { deferCycles: true }));
    for (const plan of plans) statements.push(...plan.createSql);
    for (const name of Object.keys(mapping.joinTables)) {
      const created = planJoinTable(name, mapping.joinTables[name], mapping, dialect).createSql;
      statements.push(...(legacy.bareJoins === 'all' || legacy.bareJoins.has(name) ? created.slice(0, 1) : created));
    }
    for (const plan of plans) statements.push(...plan.deferredForeignKeys ?? []);
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
      return chain(legacyShapeOf(connection, model, expressions), (legacy) =>
        chain(createShapeHolding(reference, model, expressions, legacy), () =>
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
            }))));
    }));
}

/**
 * What a database holds as an earlier release created it, for a reference
 * shape to hold too: the generated columns of its collection tables declared
 * in another of their member's types than the model's plan declares, by table
 * and column, the join tables without the index over their second key column,
 * and the unique indexes without the boolean keys after their columns, by table.
 * @param {any} connection - the database
 * @param {any} model
 * @param {any} expressions
 * @returns {any} value-or-promise of `{ columns: Map<string, Map<string, string>>, bareJoins: Set<string>, termless: Map<string, Set<string>> }`
 */
function legacyShapeOf(connection, model, expressions) {
  const plans = [...normalizeModel(model, expressions).values()]
    .map((collection) => planCollection(collection.name, collection, connection.dialect, mappingFor(connection, expressions)));
  return chain(heldDefinitionsOf(connection, plans), (held) => chain(missingJoinIndexes(connection, joinPlansOf(model, connection.dialect)), (missing) => ({
    columns: new Map([...held].filter(([, holding]) => holding.types.size > 0).map(([table, holding]) => [table, holding.types])),
    bareJoins: new Set(missing.map((entry) => entry.table)),
    termless: new Map([...held].filter(([, holding]) => holding.indexes.size > 0).map(([table, holding]) => [table, holding.indexes])),
  })));
}

/**
 * The plan of each many-to-many join table of a model (none for a model
 * without entities); a model read as history is planned as history.
 * @param {any} model @param {any} dialect @returns {any[]}
 */
function joinPlansOf(model, dialect) {
  if (asHistory(() => normalizeEntities(model)).size === 0) return [];
  const mapping = asHistory(() => explainMapping(model));
  return Object.entries(mapping.joinTables).map(([name, join]) => planJoinTable(name, join, mapping, dialect));
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
  const rid = entityMapping === null ? dialect.rowIdentity() : entityRowIdentity(dialect, entityMapping);
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

/**
 * How a row of an entity's table is named: the dialect's row identity, spelled
 * around the columns the entity maps (a member named `rowid` takes that name
 * in SQLite, so the walk and the write must agree on another of its aliases).
 * @param {any} dialect @param {any} entityMapping
 */
function entityRowIdentity(dialect, entityMapping) {
  return dialect.rowIdentity([...entityColumnsOf(entityMapping), 'doc']) ?? dialect.rowIdentity();
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
  // a step's own model is history; the options' model is the declaration
  const read = step?.model === undefined ? (/** @type {() => any} */ fn) => fn() : asHistory;
  const entities = read(() => normalizeEntities(model));
  const entity = entities.get(table);
  if (entity === undefined) {
    if (step?.model !== undefined && !normalizeModel(model, options.expressions).has(table))
      throw refuse('JD0021', `the step model declares no collection or entity '${table}'`);
    return null;
  }
  const all = read(() => explainMapping(model)), mapping = all.entities[table];
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
    const keyword = (/** @type {number} */ at, /** @type {string} */ value) => isKeyword(tokens[at], value);
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
        // REFERENCES clause names by its new name. PostgreSQL has no such
        // check and names the primary key afterwards (nameRebuiltKey)
        const temporary = `${current.table}__rebuild`;
        const renamedSoFar = renamesOf(migration.steps.slice(0, i));
        const statements = [
          ...current.create,
          current.copy,
          dialect.ddl.dropTable(current.table),
          dialect.ddl.renameTable(temporary, current.table),
          ...current.indexes,
        ];
        const dropAt = current.create.length + 1;
        // PostgreSQL refuses to drop a table another object depends on, and a
        // rebuild re-points nothing: a foreign key (another entity's, or the
        // temporary table's copy of a self-reference), a view, a rule — the
        // server's own detail names it, whatever its kind
        const referenced = (/** @type {any} */ cause) => (cause?.code !== '2BP01' ? cause : Object.assign(refuse('JD0023',
          `migration '${migration.id}' step ${i} (rebuild) failed: a PostgreSQL rebuild of an entity that another object `
          + `depends on is not supported: the old '${current.table}' cannot be dropped while `
          + `${typeof cause.detail === 'string' && cause.detail !== '' ? cause.detail.split('\n').join('; ') : 'other objects depend on it'}`,
          cause), verdictOf(cause)));
        /** @type {any[] | null} */
        let before = null;
        const runNext = (j) => {
          if (j >= statements.length) {
            if (before === null) return dialect.name === 'postgres' ? nameRebuiltKey(connection, current.table) : null;
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
          // a statement that throws is named the step's failure here, once: the
          // statements after it run outside this catch, so a failure of theirs
          // is not named again
          let ran;
          try {
            ran = attempt(() => connection.exec(statements[j]), (cause) => (j === dropAt ? referenced(cause) : cause));
          }
          catch (cause) {
            return fail(/** @type {Error} */ (cause).message, /** @type {Error} */ (cause));
          }
          return chain(ran, () => runNext(j + 1));
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

      const counted = assertionMapping === null ? assertionProvider(current.assert, current.collection, operation.shape) : null;
      // the native count compares text by the file's BINARY order, which is
      // code point order only over UTF-8: over a UTF-16 file the step reads
      // its documents through the engine instead
      return chain(counted === null ? null : nonCodePointEncoding(connection), (encoding) => {
        const provider = encoding === null ? counted : null;
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
      });
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
    if (connection.dialect.capabilities.declaredSqlText !== true) return acceptJoinTables(connection, model);
    return chain(compareShapeToModel(driver, connection, model, options.registerFunctions, options.expressions), (difference) => {
      if (difference !== null) throw refuse('JD0023', `the migrated shape does not equal the target model's: ${difference}`);
    });
  });
}

/**
 * On an engine that keeps no CREATE text to compare (PostgreSQL), the
 * model's join tables as a migration leaves them, verified as the next
 * open verifies them ({@link verifyShape}): a link that leaves one the
 * open would refuse (`JD0002`) — a rename an earlier release planned,
 * which leaves the index over the second key column under the table's
 * old name — is refused `JD0023` before it commits, as SQLite's shape
 * comparison refuses it. A join table the database does not hold is
 * created by the open.
 * @param {any} connection @param {any} model
 * @returns {any} value-or-promise
 */
function acceptJoinTables(connection, model) {
  const dialect = connection.dialect;
  const plans = joinPlansOf(model, dialect);
  const refusal = (/** @type {string} */ difference) => {
    throw refuse('JD0023', `the migrated shape does not equal the target model's: ${difference}; the next open `
      + 'would refuse the table (JD0002), so nothing was changed: plan the link again with this release, which '
      + 'renames a join table\'s index with it, or bring the table to the model in a sql step before the link ends');
  };
  const next = (/** @type {number} */ i) => {
    if (i >= plans.length) return null;
    const plan = plans[i];
    return chain(connection.prepare(dialect.introspect.tableExists()), (exists) =>
      chain(exists.get([plan.table]), (row) => (row === undefined ? next(i + 1)
        : chain(verifyShape(connection, plan, plan.table, '', 'entity', refusal), () => next(i + 1)))));
  };
  return next(0);
}

/** Read every normal receipt field and raw side payload without changing either.
 * Numeric fields are database-produced decimal text, including rowid/rid.
 * @param {{driver?: any, path?: string, connection?: any}} target
 * @param {{signal?: AbortSignal, deadline?: number, runtime?: any}} [options]
 * @returns {any} Synchronous for borrowed synchronous connections; promised when owned,
 *   every admission refusal included. */
export function migrationHistory(target, options = {}) {
  checkMigrationTarget(target);
  let check;
  try {
    readOptions(options, ['runtime', 'signal', 'deadline'], 'migrationHistory()');
    readMigrationControls(options, 'migrationHistory()');
    const runtime = resolveRuntime(options.runtime);
    check = () => refuseCancelled({ signal: options.signal, deadline: options.deadline }, runtime.now,
      { abortCode: 'JD2080', aborted: 'it ran', passed: 'the history read ran', ran: 'no receipt changed' });
    check();
  }
  catch (error) { return admissionRefused(target, error); }
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
 * @returns {any} `{adopted, unchanged}` receipt counts, value-or-promise; promised when
 *   owned, every admission refusal included. */
export function adoptMigrationHistory(target, migrations, options) {
  checkMigrationTarget(target);
  let check, header, expected, selectedTarget, batchSize;
  try {
    readOptions(options, ['observed', 'model', 'physicalTarget', 'shadowDriver', 'registerFunctions',
      'compileSchema', 'expressions', 'batchSize', 'runtime', 'signal', 'deadline'], 'adoptMigrationHistory()');
    readMigrationControls(options, 'adoptMigrationHistory()');
    if (!Array.isArray(migrations) || migrations.length === 0)
      throw new TypeError('adoptMigrationHistory needs the complete nonempty applied legacy migration list');
    if (options?.model === undefined || options?.observed === undefined)
      throw new TypeError('adoptMigrationHistory needs { observed, model }: a reviewed history observation and its current model');
    batchSize = options.batchSize ?? 500;
    if (!Number.isSafeInteger(batchSize) || batchSize < 1) throw new TypeError('batchSize must be a positive safe integer');
    [migrations, options] = snapshotMigrationInputs(migrations, options);
    refuseRepeatedIds(migrations, 'adoptMigrationHistory()');
    // an explicit target is admitted as given: `null` is refused, never read as absent
    if (options.physicalTarget !== undefined) physicalTargetOf(options.physicalTarget);
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
  catch (error) { return admissionRefused(target, error); }
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
      // the baseline as the earliest release created it: a join table
      // without the index over its second key column, and a collection without
      // the indexes beside its declared ones over a member of several kinds,
      // which a link an earlier release planned does not create, rename or drop
      // (a link this release plans creates them, and acceptance takes the table
      // either way)
      chain(options.shadowFixture === undefined ? createShapeHolding(shadow, baseline, options.expressions, { columns: new Map(), bareJoins: 'all', bareKinds: true })
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
      }, replay, true))))))));
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
 * history table is probed, never created, so an existing file stays byte
 * for byte what it was: what is applied, what is pending, whether an
 * applied migration was edited, and — once the chain is fully applied —
 * whether the physical shape DRIFTED from the model (someone changed
 * the database by hand, §12). An owned SQLite target opens its `path`
 * through its driver, which creates a file that does not exist; a
 * PostgreSQL target is the schema its driver names.
 * @param {{ driver?: any, path?: string, connection?: any }} target
 * @param {any[]} migrations - the full ordered list
 * @param {{ model?: any, physicalTarget?: any, shadowDriver?: any,
 *   registerFunctions?: (connection: any) => any,
 *   signal?: AbortSignal, deadline?: number,
 *   runtime?: Partial<import('@jarenjs/core/runtime').Runtime> }} options
 *   - `signal`/`deadline` refuse a call already cancelled (`JD2080`) or
 *   past its deadline (`JD2075`) on the runtime record's clock
 * @returns {any} value-or-promise of applied/pending/drift/upToDate;
 *   a borrowed synchronous connection stays synchronous with a physical target;
 *   promised when owned, every admission refusal included
 */
export function migrationStatus(target, migrations, options = {}) {
  checkMigrationTarget(target);
  try {
    readOptions(options, ['model', 'physicalTarget', 'shadowDriver', 'registerFunctions', 'runtime', 'signal', 'deadline'], 'migrationStatus()');
    readMigrationControls(options, 'migrationStatus()');
    if (!Array.isArray(migrations)) throw new TypeError('migrationStatus needs the full ordered migration list');
    [migrations, options] = snapshotMigrationInputs(migrations, options);
    refuseRepeatedIds(migrations, 'migrationStatus()');
    // an explicit target is admitted as given, pending work or not: `null` is
    // refused, never read as absent
    if (options.physicalTarget !== undefined) physicalTargetOf(options.physicalTarget);
    refuseCancelled({ signal: options.signal, deadline: options.deadline }, resolveRuntime(options.runtime).now,
      { abortCode: 'JD2080', aborted: 'it ran', passed: 'the status read ran', ran: 'no step ran' });
  }
  catch (error) { return admissionRefused(target, error); }
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
        const sameModel = first?.$migration === '0.2'
          ? first.identity.from === first.identity.to : first?.from === first?.to;
        const baseline = rows.length > 0 && sameModel && Array.isArray(first?.steps) && first.steps.length === 0
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
 *   migration is stamped with (integer epoch milliseconds; a clock that
 *   answers anything else is refused `JD0013` before the first link runs,
 *   or before the receipt of a link it can no longer stamp, which rolls
 *   back whole — the whole chain in an atomic run; the shadow's replay
 *   reads it first, and a refusal there leaves the database without a
 *   step run), and the clock and identifiers an entity step's `default: 'now'` /
 *   `default: 'uuid'` fill; the platform's own when absent
 * @returns {any} Owned targets return a promise, every refusal included. Borrowed
 *   synchronous targets with shadow:false and synchronous hooks settle in their
 *   caller's transaction, and throw their refusals.
 */
export function migrate(target, migrations, options) {
  return runMigration(target, migrations, options);
}

/** The replay authority is created only after primary exact receipt verification.
 * `shadowReplay` marks the shadow's own run, so its refusals say the database ran nothing. */
function runMigration(target, migrations, options, replay = undefined, shadowReplay = false) {
  checkMigrationTarget(target);
  // admission: every refusal before acquisition answers through the target's boundary
  let batchSize, runtime, check, hosts, atomic, runOptions;
  try {
    readOptions(options, ['baseline', 'model', 'compileSchema', 'dryRun', 'batchSize', 'onProgress',
      'shadow', 'shadowPath', 'shadowDriver', 'shadowFixture', 'physicalTarget', 'registerFunctions',
      'expressions', 'assertionBounds', 'onAssertionPlan', 'signal', 'deadline', 'runtime', 'hosts', 'atomic'], 'migrate()');
    readMigrationControls(options, 'migrate()');
    if (!Array.isArray(migrations)) throw new TypeError('migrate needs the full ordered migration list');
    if (!options || typeof options !== 'object' || options.baseline === undefined)
      throw new TypeError('migrate needs { baseline }: the model the store was first created with');
    batchSize = options.batchSize ?? 500;
    if (!Number.isSafeInteger(batchSize) || batchSize < 1) throw new TypeError('batchSize must be a positive safe integer');
    [migrations, options] = snapshotMigrationInputs(migrations, options);
    refuseRepeatedIds(migrations, 'migrate()');
    runtime = resolveRuntime(options.runtime);
    check = () => refuseCancelled({ signal: options.signal, deadline: options.deadline }, runtime.now, {
      abortCode: 'JD2080', aborted: 'its next step', passed: 'its next step',
      ran: 'no further step ran; a migration in flight rolled back whole and a rerun resumes from the recorded position',
    });
    hosts = readHosts(options.hosts);
    if (options.atomic !== undefined && typeof options.atomic !== 'boolean') throw new TypeError('atomic must be a boolean');
    atomic = options.atomic === true;
    // what the steps and the shadow's replay read; the shadow replays link by
    // link — its last link makes the same final check an atomic run makes at
    // its end — so `atomic` stays the primary's
    runOptions = { batchSize, assertionBounds: normalizeAssertionBounds(options.assertionBounds),
      onProgress: options.onProgress, onAssertionPlan: options.onAssertionPlan,
      registerFunctions: options.registerFunctions, expressions: options.expressions,
      compileSchema: options.compileSchema, physicalTarget: options.physicalTarget,
      shadowFixture: options.shadowFixture, model: options.model, hosts,
      signal: options.signal, deadline: options.deadline, runtime, check };
    check();
    if (options.physicalTarget !== undefined) physicalTargetOf(options.physicalTarget);
  }
  catch (error) { return admissionRefused(target, error); }
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
            /** @type {string | null} */
            let textEncoding = null;
            const collect = (i) => {
              if (i >= pending.length) return null;
              const migration = pending[i];
              // the preconditions are listed, never counted: a dry run reads
              // no table's rows against a CHECK
              for (const check of intervalPreconditionsOf(migration, dialect, mappingFor(connection, runOptions.expressions)))
                rendered.push(`-- precondition: interval '${check.interval}' on '${check.collection}'`);
              for (const migrationStep of migration.steps) {
                if (migrationStep.kind === 'ddl') rendered.push(migrationStep.sql);
                else if (migrationStep.kind === 'sql') rendered.push(`-- data step (sql): ${migrationStep.note ?? ''}`, migrationStep.sql);
                else if (migrationStep.kind === 'table') rendered.push(`-- guarded table '${migrationStep.plan.table}'`, ...migrationStep.plan.statements, ...migrationStep.plan.finish);
                else if (migrationStep.kind === 'rebuild') {
                  rendered.push(`-- rebuild '${migrationStep.table}' (§10 procedure)`, ...migrationStep.create,
                    migrationStep.copy, dialect.ddl.dropTable(migrationStep.table),
                    dialect.ddl.renameTable(`${migrationStep.table}__rebuild`, migrationStep.table), ...migrationStep.indexes);
                  if (dialect.capabilities.foreignKeysAlwaysOn !== true) rendered.push(dialect.pragma.foreignKeyCheck());
                  if (dialect.name === 'postgres') {
                    rendered.push(`-- the primary key is renamed to ${dialect.quoteIdentifier(postgresKeyName(migrationStep.table,
                      dialect.maxIdentifierBytes))} where no other relation holds that name`);
                  }
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
                  const strategy = textEncoding !== null
                    || assertionProvider(migrationStep.assert, migrationStep.collection, operation.shape) === null ? operation.strategy : 'provider';
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
            // the run counts natively only where text order is code point order
            const asserts = pending.some((migration) => migration.steps.some((step) => step.kind === 'query'));
            return chain(asserts ? nonCodePointEncoding(connection) : null, (encoding) => {
              textEncoding = encoding;
              return chain(collect(0), () => ({ dryRun: true, pending: pending.map((m) => m.id),
                statements: rendered, counts, shadowValidated: options.shadow !== false }));
            });
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
          // foreign-key baseline, the interval preconditions over the rows
          // its steps will put under a CHECK, its steps, its physical
          // checks, the foreign-key check, its history row — and, for the
          // chain's last link, the final checks
          const linkWork = (scope, migration, final) => {
            let allocations;
            /** @type {any[] | null} */
            let violationsBefore = null;
            let work = chain(foreignKeyViolations(scope), (rows) => { violationsBefore = rows; });
            work = chain(work, () => (migration.physical
              ? chain(verifyPreservation(scope, migration.physical, false), (state) => { allocations = state; }) : null));
            work = chain(work, () => historyExists ? null : chain(scope.exec(statements.create), () => { historyExists = true; }));
            work = chain(work, () => intervalPreconditions(scope, migration, runOptions));
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
            return chain(work, () => {
              // the receipt's own stamp, admitted before its insert: a clock
              // that stopped answering an integer refuses this link whole —
              // the whole chain in an atomic run, and in the shadow's replay
              // before the database runs any step
              const stamp = receiptStamp(runtime, 'migrate()', shadowReplay
                ? `the shadow's replay refused migration '${migration.id}', and no step ran on the database`
                : atomic ? `the atomic run rolled back whole, migration '${migration.id}' and every link before it`
                  : `migration '${migration.id}' rolled back whole, and the links before it stand`);
              return chain(useStatementOnce(scope, statements.insert, (insert) =>
                insert.run([migration.id, stamp, migration.from, migration.to, migrationChecksum(migration), migration.steps.length])),
              () => record(scope, migration));
            });
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
          // every link this run applies is stamped by this clock: one it
          // cannot store refuses here, before the first link's steps
          receiptStamp(runtime, 'migrate()', 'no step ran');
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
  asHistory(() => normalizeEntities(fromModel)); normalizeEntities(toModel);
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
 * and trailing statements cannot escape its savepoint or publish partial work.
 * A PostgreSQL rebuild step's first statement may be its own table's lock
 * (`rebuildLockSql`), exactly; no other LOCK passes. */
function checkMigrationStatements(migration, dialect) {
  const fragments = migration.steps.flatMap((step) => step.kind === 'rebuild'
    ? [...(step.create ?? []).filter((sql, at) => at !== 0 || !isRebuildLock(dialect, step, sql)),
      step.copy, ...(step.indexes ?? [])] : step.kind === 'table'
      ? [...step.plan.statements, ...step.plan.finish] : ['ddl', 'sql'].includes(step.kind) ? [step.sql] : []);
  for (const sql of fragments) {
    if (dialect?.migration) {
      if (isAllocationBlock(dialect, sql)) continue;
      // a block that names a key but is not what this release renders for it: say so, where
      // the statement check would only say that a `DO` is not one transactional statement
      if (allocationBlockOf(sql) !== null) {
        throw refuse('JD0021', `an allocation block of migration '${migration.id}' is not the one this release renders for its key: `
          + 'plan the migration again');
      }
      dialect.migration.checkSql(sql);
      continue;
    }
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
    const begin = tokens.findIndex((token) => isKeyword(token, 'BEGIN'));
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
