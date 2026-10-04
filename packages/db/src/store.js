//@ts-check
/**
 * @file The store: `openStore(model, options)` normalizes the model
 * document, opens a database through the injected driver, applies (or
 * verifies) the physical shape, and gives transactional,
 * schema-validated reads and writes.
 *
 * The public surface is ASYNCHRONOUS — every method returns a promise
 * — because the browser's OPFS story forces it regardless of any other
 * backend. Where the driver is synchronous the same operations exist
 * without the promise under `store.sync`, present only there — never a
 * throwing stub — so portable code pays one declared microsecond and
 * code that wants it back opts in knowingly. Internally everything
 * composes through the sync-capable {@link chain}, so the async
 * surface allocates exactly one promise per call, not one per step.
 *
 * Writes validate through an injected `compileSchema` hook with the
 * `compileTypeTest` signature; absent, writes are unvalidated and
 * `store.capabilities.validated === false` — a declared downgrade,
 * never a silent one. `@jarenjs/validate` is never imported here.
 */

import { resolveRuntime } from '@jarenjs/core/runtime';
import { createBoundedCache } from '@jarenjs/core/cache';
import { backoffDelay, sleep } from '@jarenjs/core/retry';
import { applyJSONPatch } from '@jarenjs/json/patch';
import { parseJSONPointer, compileJSONPointer, JSONPOINTER_NOTHING } from '@jarenjs/json/pointer';
import { equalsJson } from '@jarenjs/core/object';

import { DbCompileError, DbRuntimeError, wrapDriverError, isDriverError, classifyDriverError } from './errors.js';
import { chain, toPromise, isThenable, attempt, abortReason } from './driver.js';
import { createSessionRouter } from './sessions.js';
import { isPlainOptions, refuseUnknownMembers } from './options.js';
import { canonicalKeyText, namesNoNumber } from './key-text.js';
import { planCollection, planEntity, planJoinTable, verifyShape } from './ddl.js';
import { translatePatch } from './patch-sql.js';
import { createQueryEngine, createQueryState, createEntityQueryEngine, createLoadEngine } from './query.js';
import { CLOSED_UNDER, admitCursor, admitSyncCursor, createCursor, createSyncCursor, drainPage, shareCursor, utf8Length } from './cursor.js';
import { refuseUnsupportedPragmaKeys, resolvePragmaRequests, configurePragmas, PRAGMA_NAMES } from './pragmas.js';
import { createMaintenance } from './maintenance.js';
import { createBackup } from './backup.js';
import { normalizeProfile, assertProfileRoots } from './profile.js';
import { compileEntityModel, joinTableRoots } from './model.js';
import { entityCore } from './entity.js';
import { verifyPhysical } from './physical.js';
import { trustedSql, synchronousBody } from './sql.js';
import { relationalEngine } from './relational.js';
import { createTracker, membershipKeys } from './tracker.js';
import { createCaptureEngine, DEFAULT_RETENTION } from './capture.js';
import { createReplicationEngine } from './replication.js';
import { REPLICATION_DEFAULTS } from './replication-format.js';
import { createLogicalRows } from './logical-rows.js';
import { shapeHash } from './migrate.js';
import { createLiveRegistry, classifyLiveQuery, LIVE_DEFAULTS } from './live.js';
import { classifyEntityLive } from './live-join.js';
import { normalizeEventTime } from './live-time.js';
import { createJobEngine } from './jobs.js';
import { createOwnerLease, OWNER_LEASE_DEFAULT_MS, OWNER_LEASE_MIN_MS } from './owner.js';
import { introspectModel, readSchema } from './introspect.js';
import { collectEntityRoots, entityRoot } from './plan.js';
import {
  DERIVE_KINDS, PHYSICAL_KINDS, PRECISION_MIN, PRECISION_MAX, DIMS_MIN, DIMS_MAX,
  derivedValue, memberAt, storedMemberForm, registerDeriveFunctions,
} from './derive.js';
import {
  normalizeExpression, canonicalExpression, expressionMembers, registerExpressionFunctions,
} from './expression.js';

/** The model format version this store implements. */
import { MODEL_VERSION } from './engine-metadata.js';
export { MODEL_VERSION };

const COLLECTION_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const IDENTITIES = new Set(['uuid', 'integer']);

/**
 * @param {string} code
 * @param {string} reason
 * @param {string} docPath
 * @returns {DbCompileError}
 */
function modelError(code, reason, docPath) {
  return new DbCompileError(code, reason, docPath);
}

/**
 * Normalize one index's `derive` declaration — the spatial and vector
 * storage vocabulary. `derive` says what is COMPUTED from the selected
 * member, never how the member is selected, so the singular-path rule
 * and its `JD0004` are untouched; these are the refusals a derived
 * index adds.
 *
 * Every one of them is a mistake worth catching at open rather than at
 * the first query that quietly returns nothing.
 * @param {any} index - the declared index member
 * @param {string[]} paths
 * @param {string} docPath
 * @returns {{ kind: string | null, precision: number | undefined,
 *   physical: string | undefined, dims: number | undefined }}
 */
function normalizeDerive(index, paths, docPath) {
  const declared = index.derive;
  const none = { precision: undefined, physical: undefined, dims: undefined };
  if (declared === undefined) {
    if (index.precision !== undefined) {
      throw modelError('JD0004',
        "precision belongs to a derived index — declare derive: 'geohash' beside it",
        `${docPath}/precision`);
    }
    if (index.physical !== undefined) {
      throw modelError('JD0004',
        "physical names the shape a derive: 'bbox' index takes on disk; an undecorated "
        + 'index has only one shape',
        `${docPath}/physical`);
    }
    if (index.dims !== undefined) {
      throw modelError('JD0004',
        `index '${index.name}': dims is the width of a derive: 'vector' column — declare `
        + 'derive beside it; an undecorated index has no width',
        `${docPath}/dims`);
    }
    return { ...none, kind: null };
  }
  if (typeof declared !== 'string' || !DERIVE_KINDS.has(declared)) {
    throw modelError('JD0004',
      `index '${index.name}': derive is a closed set ('geohash', 'bbox' or 'vector'), got `
      + `${JSON.stringify(declared)} — `
      + 'an open expression member would be a second query language inside the model',
      `${docPath}/derive`);
  }
  if (paths.length !== 1) {
    throw modelError('JD0004',
      `index '${index.name}': a ${declared} index derives its columns from ONE member; a composite `
      + 'path declares several',
      `${docPath}/path`);
  }
  if (index.unique === true) {
    throw modelError('JD0004',
      declared === 'vector'
        ? `index '${index.name}': a vector index is never unique — it is a column nothing seeks, `
          + 'and two documents may carry one embedding'
        : `index '${index.name}': a ${declared} index is never unique: distinct positions share a `
          + 'cell (and a box edge) by construction',
      `${docPath}/unique`);
  }
  if (declared === 'vector') {
    if (index.precision !== undefined) {
      throw modelError('JD0004',
        `index '${index.name}': precision applies to a geohash index; a vector column has a `
        + 'width (dims), not a cell size',
        `${docPath}/precision`);
    }
    if (index.physical !== undefined) {
      throw modelError('JD0004',
        `index '${index.name}': physical applies to a bbox index; a vector column has one `
        + 'shape on disk — a stored packed column, on every driver',
        `${docPath}/physical`);
    }
    const dims = index.dims;
    if (dims === undefined) {
      throw modelError('JD0004',
        `index '${index.name}': a vector index must declare dims (${DIMS_MIN}..${DIMS_MAX}) — `
        + 'the width is the identity of the column, and a column that accepted any width '
        + 'would rank vectors from different models against each other',
        `${docPath}/dims`);
    }
    if (typeof dims !== 'number' || !Number.isInteger(dims) || dims < DIMS_MIN || dims > DIMS_MAX) {
      throw modelError('JD0004',
        `index '${index.name}': dims must be an integer ${DIMS_MIN}..${DIMS_MAX}, got ${JSON.stringify(dims)}`,
        `${docPath}/dims`);
    }
    return { ...none, kind: 'vector', dims };
  }
  if (index.dims !== undefined) {
    throw modelError('JD0004',
      `index '${index.name}': dims is the width of a derive: 'vector' column; a ${declared} `
      + 'index has no width',
      `${docPath}/dims`);
  }
  if (declared === 'bbox') {
    if (index.precision !== undefined) {
      throw modelError('JD0004',
        'precision applies to a geohash index; a bbox index has no cell size',
        `${docPath}/precision`);
    }
    const physical = index.physical;
    if (physical !== undefined
      && (typeof physical !== 'string' || !PHYSICAL_KINDS.has(physical))) {
      throw modelError('JD0004',
        `physical is a closed set ('columns' or 'rtree'), got ${JSON.stringify(physical)}`,
        `${docPath}/physical`);
    }
    return { ...none, kind: 'bbox', physical };
  }
  if (index.physical !== undefined) {
    throw modelError('JD0004',
      "physical applies to a bbox index; an R*Tree carries numbers, and a geohash cell "
      + 'is text',
      `${docPath}/physical`);
  }
  const precision = index.precision;
  if (precision === undefined) {
    throw modelError('JD0004',
      `a geohash index must declare precision (${PRECISION_MIN}..${PRECISION_MAX} characters) — `
      + 'there is no safe default: the right cell size depends on the query radius, '
      + 'which the model cannot know',
      `${docPath}/precision`);
  }
  if (typeof precision !== 'number' || !Number.isInteger(precision)
    || precision < PRECISION_MIN || precision > PRECISION_MAX) {
    throw modelError('JD0004',
      `precision must be an integer ${PRECISION_MIN}..${PRECISION_MAX}, got ${JSON.stringify(precision)}`,
      `${docPath}/precision`);
  }
  return { ...none, kind: 'geohash', precision };
}

/**
 * Normalize and check a model document. Every failure is `JD0005` with
 * a `docPath` into the model.
 * @param {any} model
 * @param {Record<string, any>} [expressions] - the host's declared
 *   index-expression functions, by name: a model that names one is
 *   resolved against them here, so an unknown, wrong-arity or
 *   non-deterministic function is `JD0004` before any DDL
 * @returns {Map<string, any>} collection name -> normalized collection
 */
export function normalizeModel(model, expressions = undefined) {
  if (model === null || typeof model !== 'object' || Array.isArray(model))
    throw modelError('JD0005', 'the model document must be an object', '');
  if (model.$model !== MODEL_VERSION) {
    throw modelError('JD0005',
      `the model must declare "$model": "${MODEL_VERSION}"`, '/$model');
  }
  const collections = model.collections;
  const noCollections = collections === undefined || (collections !== null && typeof collections === 'object'
    && !Array.isArray(collections) && Object.keys(collections).length === 0);
  if (noCollections && model.entities !== undefined) {
    return new Map(); // an entities-only model (§9), whether it omits `collections` or leaves it empty
  }
  if (collections === null || typeof collections !== 'object'
    || Array.isArray(collections) || Object.keys(collections).length === 0) {
    throw modelError('JD0005',
      'the model must declare at least one collection or entity', '/collections');
  }
  /** @type {Map<string, any>} */
  const normalized = new Map();
  for (const name of Object.keys(collections)) {
    const docPath = `/collections/${name}`;
    if (!COLLECTION_NAME.test(name)) {
      throw modelError('JD0005',
        `collection names are identifiers ([A-Za-z_][A-Za-z0-9_]*), got '${name}'`,
        '/collections');
    }
    const spec = collections[name];
    if (spec === null || typeof spec !== 'object' || Array.isArray(spec))
      throw modelError('JD0005', 'a collection must be an object', docPath);
    if (spec.schema === null || typeof spec.schema !== 'object'
      || Array.isArray(spec.schema))
      throw modelError('JD0005', 'a collection needs an object schema', `${docPath}/schema`);

    let keySegments = null;
    let identity = 'caller';
    if (spec.key === null || spec.key === undefined) {
      identity = spec.identity;
      if (!IDENTITIES.has(identity)) {
        throw modelError('JD0005',
          "a collection without a key pointer must declare identity 'uuid' or 'integer' — allocation is declared, never guessed",
          `${docPath}/identity`);
      }
    }
    else {
      if (spec.identity !== undefined && spec.identity !== 'caller') {
        throw modelError('JD0005',
          'a collection with a key pointer is caller-keyed; identity does not apply',
          `${docPath}/identity`);
      }
      if (typeof spec.key !== 'string') {
        throw modelError('JD0005',
          'the key must be an RFC 6901 pointer string or null', `${docPath}/key`);
      }
      let names;
      try {
        names = parseJSONPointer(spec.key);
      }
      catch {
        throw modelError('JD0005',
          `the key '${spec.key}' is not a valid RFC 6901 pointer`, `${docPath}/key`);
      }
      if (names.length === 0) {
        throw modelError('JD0005',
          'the key pointer must select a member, not the whole document',
          `${docPath}/key`);
      }
      keySegments = names.map((n) => ({ name: n }));
    }

    const indexes = [];
    const indexNames = new Set();
    const declaredIndexes = spec.indexes ?? [];
    if (!Array.isArray(declaredIndexes)) {
      throw modelError('JD0005', 'indexes must be an array',
        `${docPath}/indexes`);
    }
    for (let i = 0; i < declaredIndexes.length; i++) {
      const index = declaredIndexes[i];
      const indexDocPath = `${docPath}/indexes/${i}`;
      if (index === null || typeof index !== 'object' || Array.isArray(index))
        throw modelError('JD0005', 'an index must be an object', indexDocPath);
      if (typeof index.name !== 'string' || !COLLECTION_NAME.test(index.name)) {
        throw modelError('JD0005',
          'an index needs an identifier name', `${indexDocPath}/name`);
      }
      if (indexNames.has(index.name)) {
        throw modelError('JD0005',
          `duplicate index name '${index.name}'`, `${indexDocPath}/name`);
      }
      indexNames.add(index.name);
      // an EXPRESSION index names what it computes, not which member it
      // reads, so it is mutually exclusive with both of the other two
      // ways an index is declared: an index cannot be over a member AND
      // over a function of one, and a derived spatial column is already
      // an expression this format spells for you
      if (index.expression !== undefined) {
        if (index.path !== undefined) {
          throw modelError('JD0004',
            'an index declares a path OR an expression: an expression names the members it '
            + 'reads itself', `${indexDocPath}/path`);
        }
        if (index.derive !== undefined) {
          throw modelError('JD0004',
            'a derived index IS an expression this format spells; declare one or the other',
            `${indexDocPath}/derive`);
        }
        const expression = normalizeExpression(index.expression,
          `${indexDocPath}/expression`, expressions);
        indexes.push({
          name: index.name,
          paths: expressionMembers(expression),
          expression,
          canonical: canonicalExpression(expression),
          unique: index.unique === true,
          derive: null,
          precision: undefined,
          physical: undefined,
          dims: undefined,
          docPath: indexDocPath,
        });
        continue;
      }
      const paths = Array.isArray(index.path) ? index.path : [index.path];
      if (paths.length === 0
        || paths.some((p) => typeof p !== 'string' || p === '')) {
        throw modelError('JD0005',
          'an index path must be a JSONPath string (a composite index takes a non-empty array of them)',
          `${indexDocPath}/path`);
      }
      const derive = normalizeDerive(index, paths, indexDocPath);
      indexes.push({
        name: index.name,
        paths,
        unique: index.unique === true,
        derive: derive.kind,
        precision: derive.precision,
        physical: derive.physical,
        dims: derive.dims,
        docPath: indexDocPath,
      });
    }

    normalized.set(name, {
      name,
      docPath,
      schema: spec.schema,
      key: spec.key ?? null,
      keySegments,
      identity,
      indexes,
    });
  }
  return normalized;
}

/**
 * The value at a collection's key pointer, or `undefined` — a read that
 * never refuses, for asking a stored document which key it holds.
 * @param {any} doc
 * @param {{ name: string }[]} keySegments
 * @returns {unknown}
 */
function keyMemberOf(doc, keySegments) {
  let node = doc;
  for (const segment of keySegments) {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return undefined;
    node = node[segment.name];
  }
  return node;
}

/**
 * Read a caller-supplied key out of a document along the declared
 * pointer.
 * @param {any} doc
 * @param {{ name: string }[]} keySegments
 * @param {string} pointer
 * @param {string} collection
 * @param {string} docPath
 * @returns {string | number}
 */
function extractKey(doc, keySegments, pointer, collection, docPath) {
  let node = doc;
  for (const segment of keySegments) {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) {
      node = undefined;
      break;
    }
    node = node[segment.name];
  }
  if (typeof node !== 'string' && typeof node !== 'number') {
    throw new DbRuntimeError('JD2002',
      `the document carries no scalar key at the declared pointer '${pointer}'`,
      { docPath, collection });
  }
  if (typeof node === 'number' && !Number.isFinite(node)) {
    throw new DbRuntimeError('JD2002',
      `the document's key at '${pointer}' is ${node} — a numeric key must be finite: `
      + 'NaN and ±Infinity have no key spelling', { docPath, collection });
  }
  return node;
}

/**
 * @param {any} key
 * @param {string} collection
 * @param {string} docPath
 * @returns {string | number}
 */
function requireKey(key, collection, docPath) {
  if (typeof key !== 'string' && typeof key !== 'number') {
    throw new DbRuntimeError('JD2002',
      'a key must be a string or a number', { docPath, collection });
  }
  if (typeof key === 'number' && !Number.isFinite(key)) {
    throw new DbRuntimeError('JD2002',
      `a numeric key must be finite, not ${key} — NaN and ±Infinity have no key spelling`,
      { docPath, collection });
  }
  return key;
}

/**
 * Is this database error a duplicate on the collection's key column?
 * SQLite reports a rowid-alias conflict as SQLITE_CONSTRAINT_PRIMARYKEY
 * (1555) and a declared-PRIMARY-KEY conflict as
 * SQLITE_CONSTRAINT_UNIQUE naming `table.column` in the message.
 * @param {any} error
 * @param {string} table
 * @param {string} keyColumn
 * @returns {boolean}
 */
/**
 * Wrap a database failure for one collection operation.
 * @param {any} error
 * @param {any} plan
 * @param {string} collection
 * @param {string} docPath
 * @param {string | number} [key]
 * @returns {DbRuntimeError}
 */
function wrapWriteError(error, plan, collection, docPath, key) {
  // one classifier for every path: a coded error (a closed store, a
  // refused document) passes through it untouched
  return wrapDriverError(error, {
    docPath, collection, ...(key === undefined ? undefined : { key }),
    unique: { table: plan.table, column: plan.keyColumn },
    duplicateReason: `a document already exists under key '${String(key)}'`,
  });
}

/**
 * Run `fn` inside an IMMEDIATE transaction on an otherwise idle
 * connection — the open path's shape work. A deferred transaction (a
 * bare savepoint) takes its write lock only when the first write
 * arrives, and a concurrent commit between the probe and the CREATE
 * turns that upgrade into the one SQLITE_BUSY the busy handler cannot
 * retry; taking the write lock first makes the wait an ordinary busy
 * wait the timeout covers. Exactly the bracket the migration runner
 * uses; the driver's savepoint machinery is not involved, because at
 * open nothing else holds the connection.
 * @param {any} connection
 * @param {() => any} fn - value-or-promise
 * @param {boolean} [retry] - one retry for a concurrent catalog creation
 * @returns {any} value-or-promise
 */
function immediately(connection, fn, retry = true) {
  const dialect = connection.dialect;
  const commit = (value) => chain(connection.exec(dialect.tx.commit), () => value);
  const rollback = (error) => chain(connection.exec(dialect.tx.rollback), () => {
    // The winner's CREATE has committed before a catalog collision returns.
    // Re-read and verify that shape in a fresh transaction, once per bracket;
    // collection and entity creation can race independently during one open.
    if (retry && dialect.isCreateRace?.(error) === true) return immediately(connection, fn, false);
    throw error;
  });
  return chain(connection.exec(dialect.tx.beginImmediate), () => {
    let out;
    try {
      out = fn();
    }
    catch (error) {
      return rollback(error);
    }
    return isThenable(out) ? out.then(commit, rollback) : commit(out);
  });
}

/**
 * Create or verify every collection's physical shape, inside one
 * immediate transaction.
 * @param {any} connection
 * @param {Map<string, any>} collections
 * @param {Map<string, any>} plans
 * @param {string | null} createsNothing - what the store is when it may
 *   create no table ('a read-only store', 'an adopted store …'), for the
 *   refusal; `null` when it creates what is missing
 * @returns {any} value-or-promise
 */
function ensureShape(connection, collections, plans, createsNothing) {
  const dialect = connection.dialect;
  const names = [...collections.keys()];
  if (names.length === 0) return null;
  // a store that creates nothing (read-only, or adopted) verifies without
  // taking a write lock
  const bracket = createsNothing !== null ? (fn) => fn() : (fn) => immediately(connection, fn);
  return bracket(() => {
    const step = (i) => {
      if (i >= names.length) return null;
      const name = names[i];
      const collection = collections.get(name);
      const plan = plans.get(name);
      return chain(connection.prepare(dialect.introspect.tableExists()), (statement) =>
        chain(statement.get([name]), (row) => {
          if (row === undefined) {
            if (createsNothing !== null) {
              throw new DbCompileError('JD0002',
                `collection '${name}': the table does not exist and ${createsNothing} creates nothing`,
                collection.docPath);
            }
            const run = (j) => (j >= plan.createSql.length
              ? null
              : chain(connection.exec(dialect.ddl.idempotent(plan.createSql[j])), () => run(j + 1)));
            return chain(run(0), () => step(i + 1));
          }
          return chain(verifyShape(connection, plan, name, collection.docPath),
            () => step(i + 1));
        }));
    };
    return step(0);
  });
}

/**
 * Create or verify entity and join tables (the same
 * create-or-verify discipline as collections), including the
 * foreign-key list: source column, target table and the declared
 * on-delete behaviour must match.
 * @param {any} connection
 * @param {Map<string, any>} entityPlans
 * @param {Map<string, any>} entities
 * @param {string | null} createsNothing - as {@link ensureShape}'s
 * @returns {any} value-or-promise
 */
function ensureEntityShape(connection, entityPlans, entities, createsNothing) {
  if (entityPlans.size === 0) return null;
  const dialect = connection.dialect;
  const names = [...entityPlans.keys()];
  const bracket = createsNothing !== null ? (fn) => fn() : (fn) => immediately(connection, fn);
  return bracket(() => {
    const step = (i) => {
      if (i >= names.length) return null;
      const name = names[i];
      const plan = entityPlans.get(name);
      const docPath = entities.get(name)?.docPath ?? `/entities/${name}`;
      if (plan.physical) return chain(readSchema(connection), (schema) =>
        chain(verifyPhysical(connection, plan.physical, schema), () => step(i + 1)));
      return chain(connection.prepare(dialect.introspect.tableExists()), (statement) =>
        chain(statement.get([name]), (row) => {
          if (row === undefined) {
            if (createsNothing !== null) {
              throw new DbCompileError('JD0002',
                `entity '${name}': the table does not exist and ${createsNothing} creates nothing`,
                docPath);
            }
            const run = (j) => (j >= plan.createSql.length
              ? null
              : chain(connection.exec(dialect.ddl.idempotent(plan.createSql[j])), () => run(j + 1)));
            return chain(run(0), () => step(i + 1));
          }
          return chain(verifyShape(connection, plan, name, docPath), () =>
            chain(connection.prepare(dialect.introspect.foreignKeyList(name)), (fkStatement) =>
              chain(fkStatement.all([]), (fkRows) => {
                // the whole TUPLE, not the count: a key that changed
                // `ON DELETE SET NULL` to `ON DELETE CASCADE`, or that now
                // points at a different table or column, keeps the count
                // identical and deletes different rows
                const expectedFks = (plan.expectedForeignKeys ?? []);
                /** @param {any} fk */
                // the model spells its actions in camelCase (`setNull`),
                // the catalog in SQL (`SET NULL`): upper-casing alone
                // read every set-null key as a changed model on reopen
                /** @param {any} action */
                const sqlAction = (action) => dialect.comparableForeignKeyAction(
                  dialect.foreignKeyActionSql(action ?? 'NO ACTION'));
                const describe = (fk) => `${fk.column} -> ${fk.references}`
                  + `${fk.targetColumn === null ? '' : `(${fk.targetColumn})`}`
                  + ` ON DELETE ${sqlAction(fk.onDelete)}`
                  + ` ON UPDATE ${sqlAction(fk.onUpdate)}`;
                const actual = fkRows.map((row) => describe({
                  column: String(row.source_column),
                  references: String(row.target),
                  targetColumn: row.target_column === null ? null : String(row.target_column),
                  onDelete: row.on_delete,
                  onUpdate: row.on_update,
                })).sort();
                const wanted = expectedFks.map(describe).sort();
                if (actual.join(' | ') !== wanted.join(' | ')) {
                  throw new DbCompileError('JD0002',
                    `entity '${name}': the foreign keys are [${actual.join(', ')}], `
                    + `the model declares [${wanted.join(', ')}]`,
                    docPath);
                }
                return step(i + 1);
              })));
        }));
    };
    return step(0);
  });
}

/**
 * A collection write's options — a closed set, its last argument
 * (MODEL-FORMAT §5): `expect`, one precondition `{ path, value }` or a
 * non-empty list of them, on `put`, `patch` and `delete`; nothing on
 * `insert`, which has no stored document to hold one to. Anything else, or
 * options that are not a plain object, is `JD0013` before any statement —
 * the capture wrap reads them too, before its transaction begins. An
 * expected value is compared as the JSON it is written as (a Date as its
 * ISO text, an undefined member as no member, `NaN` as `null`), because
 * the stored document is that JSON; one JSON cannot carry (a bigint, a
 * function) is `JD0013`.
 * @param {string} collectionName
 * @param {unknown} options
 * @param {string} verb
 * @param {boolean} expects - whether this write reads `expect`
 * @returns {{ get: (doc: any) => any, path: string, value: any }[] | null}
 */
function readWriteOptions(collectionName, options, verb, expects) {
  if (options === undefined) return null;
  const spelling = `collection('${collectionName}').${verb}`;
  const refuse = (/** @type {string} */ reason) => new DbCompileError('JD0013', `${spelling}: ${reason}`);
  if (!isPlainOptions(options))
    throw refuse(`its options are ${expects ? '{ expect }' : 'an empty object'}, not ${describeValue(options)}`);
  refuseUnknownMembers(options, expects ? ['expect'] : [], (key, hint) =>
    refuse(`option '${key}' is not one ${verb} reads${hint}`));
  const { expect } = /** @type {any} */ (options);
  if (expect === undefined) return null;
  const list = Array.isArray(expect) ? expect : [expect];
  if (list.length === 0) throw refuse('expect is one { path, value } or a non-empty list of them');
  return list.map((one) => {
    if (!isPlainOptions(one)) throw refuse(`an expect is { path, value }, not ${describeValue(one)}`);
    refuseUnknownMembers(one, ['path', 'value'], (key, hint) =>
      refuse(`expect member '${key}' is not one it reads${hint}`));
    const { path, value } = /** @type {any} */ (one);
    let get;
    try {
      get = compileJSONPointer(path);
    }
    catch {
      throw refuse(`an expect's path is a JSON Pointer (RFC 6901), not ${describeValue(path)}`);
    }
    if (value === undefined) throw refuse(`the expect at '${path}' needs a value: the JSON value the stored document holds there`);
    let text;
    try {
      text = JSON.stringify(value);
    }
    catch {
      text = undefined;
    }
    if (text === undefined) {
      const kind = typeof value === 'bigint' ? `the bigint ${value}n`
        : typeof value === 'object' ? 'an object JSON cannot write (a cycle, or a throwing toJSON)' : `a ${typeof value}`;
      throw refuse(`the expect at '${path}' holds ${kind}, which no JSON document holds`);
    }
    return { get, path, value: JSON.parse(text) };
  });
}

/**
 * A patch's operations with each `value` as the JSON it is written as,
 * read back — an undefined member is no member, a Date its ISO text — so
 * the patch tests, compares and writes the document it stores. An
 * operation whose value JSON cannot carry stays as it is, for the patch
 * engine to meet.
 * @param {unknown} ops
 * @returns {unknown}
 */
function patchAsJson(ops) {
  if (!Array.isArray(ops)) return ops;
  return ops.map((op) => {
    if (op === null || typeof op !== 'object' || !Object.hasOwn(op, 'value')) return op;
    let text;
    try {
      text = JSON.stringify(op.value);
    }
    catch {
      return op;
    }
    return text === undefined ? op : { ...op, value: JSON.parse(text) };
  });
}

/**
 * Build the per-collection operation core. Every function returns a
 * value or a promise depending on the driver; the async surface lifts
 * once, the sync surface passes through.
 * @param {any} connection
 * @param {any} collection - normalized collection
 * @param {any} plan
 * @param {((doc: any) => any) | null} validate
 * @param {any} queryState - the store-wide statement cache and UDF set
 * @param {{ profile: any, roots: readonly string[] }} storeProfileRef - the
 *   store-level profile and every root a member allow-list may name
 * @returns {any}
 */
function collectionCore(connection, collection, plan, validate, queryState, storeProfileRef, runtime) {
  const dialect = connection.dialect;
  // the STORED branch (a driver that cannot index a registered
  // function): the derived columns are ordinary ones, so every write
  // carries their values. Empty everywhere else, and the statements are
  // then byte-identical to what they were before derived indexes existed
  const storedNames = new Set(plan.generated
    .filter((column) => column.stored === true).map((column) => column.name));
  const storedDerived = plan.derived.filter((column) => storedNames.has(column.name));
  const shape = {
    table: plan.table,
    keyColumn: plan.keyColumn,
    docColumn: plan.docColumn,
    stored: storedDerived.length > 0
      ? storedDerived.map((column) => column.name) : undefined,
  };
  /**
   * The stored derived values for one document, in column order. The
   * four columns of one bbox index share a segments array by identity,
   * so the member is read and normalized once per index, not once per
   * column.
   * @param {any} doc
   * @returns {any[]}
   */
  const derivedFor = (doc) => {
    /** @type {Map<any, any>} */
    const members = new Map();
    return storedDerived.map((column) => {
      let member = members.get(column.segments);
      if (member === undefined) {
        member = { value: storedMemberForm(memberAt(doc, column.segments)) };
        members.set(column.segments, member);
      }
      return derivedValue(column, member.value);
    });
  };
  /** @type {Map<string, any>} */
  const statements = new Map();
  const prepared = (name, sql, metadata = undefined) => {
    let statement = statements.get(name);
    if (statement === undefined) {
      statement = connection.prepare(sql, metadata);
      statements.set(name, statement);
    }
    return statement;
  };
  const stats = { patchTranslated: 0, patchFallback: 0 };
  const engine = createQueryEngine({
    connection, state: queryState, collection, physicalPlan: plan,
    profile: storeProfileRef.profile, roots: storeProfileRef.roots,
  });

  const checkValid = (doc) => {
    if (validate === null) return;
    const result = validate(doc);
    const valid = result === true || result?.valid === true;
    if (!valid) {
      throw new DbRuntimeError('JD2003',
        `collection '${collection.name}' rejected the document`,
        Array.isArray(result?.errors)
          ? { docPath: collection.docPath, collection: collection.name, errors: result.errors }
          : { docPath: collection.docPath, collection: collection.name });
    }
  };

  const resolveWriteKey = (doc, explicitKey) => {
    if (collection.keySegments !== null) {
      const own = extractKey(doc, collection.keySegments, collection.key,
        collection.name, collection.docPath);
      // a keyed collection writes under the document's OWN key: an
      // explicit one that disagrees used to be ignored in silence (the
      // write landed under the document's key, while journal capture read
      // its before-image under the explicit one)
      if (explicitKey !== undefined && canonicalKeyText(
        requireKey(explicitKey, collection.name, collection.docPath)) !== canonicalKeyText(own)) {
        throw new DbRuntimeError('JD2002',
          `put: the key ${JSON.stringify(explicitKey)} disagrees with the document's key `
          + `${JSON.stringify(own)} at '${collection.key}' — a keyed collection writes under the `
          + "document's own key; pass none, or the same one",
          { docPath: collection.docPath, collection: collection.name, key: explicitKey });
      }
      return own;
    }
    if (explicitKey !== undefined)
      return requireKey(explicitKey, collection.name, collection.docPath);
    if (collection.identity === 'uuid') return runtime.uuid();
    return null; // integer: the database allocates
  };

  // ONE spelling per numeric key over a TEXT key column (MODEL-FORMAT
  // §5): bound as its canonical JSON text on every driver. On a dialect
  // whose files may hold the spelling an earlier write stored for a
  // number (SQLite: node:sqlite bound it as a REAL and stored '7.0'), a
  // read finds either spelling and a write first moves a legacy row onto
  // the canonical text, so the file converges as it is written.
  const textKey = plan.keyType === dialect.typeFor('string', 'key');
  const bindKey = (/** @type {string | number} */ key) => (textKey ? canonicalKeyText(key) : key);
  // a lookup of a string that is no number on a numeric key column names no
  // row on either engine (see `namesNoNumber`); a WRITE keeps its key, which
  // both engines refuse alike
  const whereKey = (/** @type {string | number} */ key) => (!textKey && namesNoNumber(key) ? null : bindKey(key));
  // A collection without a key member has no document that could confirm
  // a legacy spelling, so a number names its canonical row only and a
  // string key spelled `'7.0'` stays a key of its own.
  const spelledTwice = (/** @type {unknown} */ key) => textKey && typeof key === 'number'
    && dialect.legacyNumericKeyText !== null && collection.keySegments !== null;
  /**
   * Every stored row of a numeric key: its canonical spelling, and a legacy
   * one only when the row's own document holds this number at the key
   * member. The spelling alone cannot tell — the string key `'7.0'` is
   * spelled like 7 written as a float, and a spelling an older SQLite
   * rounded can name another number.
   */
  const spellingsOf = (/** @type {number} */ key) =>
    chain(prepared('keySpellings', dialect.dml.keySpellings(shape), { readOnly: true }), (statement) =>
      chain(statement.all([canonicalKeyText(key), key]), (/** @type {any[]} */ rows) =>
        rows.filter((row) => row.key === canonicalKeyText(key)
          || keyMemberOf(JSON.parse(row.doc), collection.keySegments) === key)));

  const runWrite = (statementName, sql, params, key, reads) => {
    return chain(prepared(statementName, sql), (statement) =>
      attempt(() => (reads ? statement.get(params) : statement.run(params)),
        (error) => wrapWriteError(error, plan, collection.name, collection.docPath, key)));
  };

  /**
   * Before a write of a numeric key that may be spelled twice: refuse a
   * key the collection already holds under BOTH spellings (`JD2001`,
   * naming them — a duplicate an earlier cross-runtime write left is
   * never merged in silence), and move a legacy-spelled row onto the
   * canonical text, so the canonical statement that follows addresses it.
   * @param {number} key
   */
  const converge = (key) => {
    const canonical = canonicalKeyText(key);
    return chain(spellingsOf(key), (rows) => {
      const spellings = [...new Set(rows.map((/** @type {any} */ row) => row.key))];
      if (spellings.length > 1) {
        throw new DbRuntimeError('JD2001',
          `collection '${collection.name}' holds key ${canonical} under two spellings `
          + `(${spellings.map((spelling) => `'${spelling}'`).join(' and ')}) — a duplicate an `
          + 'earlier write left; keep one row, delete the other (MODEL-FORMAT §5), and write again',
          { docPath: collection.docPath, collection: collection.name, key });
      }
      if (spellings.length === 0 || spellings[0] === canonical) return null;
      return runWrite('rekey', dialect.dml.rekey(shape), [canonical, spellings[0]], key, false);
    });
  };
  /** A write addressed by `key`: converged first, atomically with it,
   * when the key may be spelled twice; as it is otherwise. Its first
   * statement is a read, so a transaction of its own takes the writer lock
   * up front (`immediate`): a deferred one met the read→write upgrade busy
   * the busy handler cannot wait out whenever another connection wrote. */
  const keyedWrite = (/** @type {string | number} */ key, /** @type {() => any} */ write) =>
    (spelledTwice(key)
      ? connection.transaction(() => chain(converge(/** @type {number} */ (key)), write), 'immediate')
      : write());

  /**
   * Refuse a write whose preconditions the stored document does not meet
   * (`JD2040`) — judged inside the write's own transaction, against the
   * very document the write replaces. Nothing stored meets none.
   * @param {string} verb @param {string | number} key
   * @param {{ get: (doc: any) => any, path: string, value: any }[]} expected
   * @param {any} current - the stored document, or `undefined`
   */
  const requireExpected = (verb, key, expected, current) => {
    if (current === undefined) {
      throw new DbRuntimeError('JD2040',
        `${verb}: nothing is stored under key '${String(key)}', so its expect does not hold`,
        { docPath: collection.docPath, collection: collection.name, key });
    }
    const failed = expected.find((one) => {
      const actual = one.get(current);
      return actual === JSONPOINTER_NOTHING || !equalsJson(actual, one.value);
    });
    if (failed !== undefined) {
      throw new DbRuntimeError('JD2040',
        `${verb}: the document stored under key '${String(key)}' does not hold ${JSON.stringify(failed.value)} `
        + `at '${failed.path}' — it changed since it was read; nothing was written`,
        { docPath: collection.docPath, collection: collection.name, key });
    }
  };
  /**
   * A read-modify-write, atomically: the read and the write in ONE write
   * transaction — its own at the root (SQLite's `BEGIN IMMEDIATE`, where
   * writers serialize; on PostgreSQL a plain one whose read locks the ROW,
   * never the store's writer lock), a savepoint inside a caller's. So a
   * precondition, a leading `test` and the validator all judge the very
   * document the write replaces: another writer can no longer slip a
   * commit between the read and the write.
   * @param {string | number} key
   * @param {(current: any) => any} fn - receives the stored document or `undefined`
   */
  const atomically = (key, fn) => connection.transaction(() =>
    chain(spelledTwice(key) ? converge(/** @type {number} */ (key)) : null, () =>
      chain(attempt(() => chain(
        // buffered: a point read under the write, never a server cursor
        prepared('getForUpdate', dialect.dml.getForUpdate(shape), { buffered: true }), (statement) =>
          chain(statement.get([whereKey(key)]), (row) => (row === undefined ? undefined : JSON.parse(row.doc)))),
      (error) => wrapDriverError(error, { docPath: collection.docPath, collection: collection.name, key })), fn)),
  'immediate');
  /**
   * `all()`'s options: the cursor's own — `signal`, `deadline`, `profile`,
   * `strictStreaming` — and nothing a fixed document cannot use
   * (`JD0013`).
   * @param {unknown} options
   */
  const readAllOptions = (options) => {
    if (options === undefined) return;
    const spelling = `collection('${collection.name}').all`;
    if (!isPlainOptions(options))
      throw new DbCompileError('JD0013', `${spelling}: its options are an object, not ${describeValue(options)}`);
    refuseUnknownMembers(options, ['signal', 'deadline', 'profile', 'strictStreaming'], (key, hint) =>
      new DbCompileError('JD0013', `${spelling} option '${key}' is not one it reads${hint}`));
  };

  // RETURNING is decoded after the server has inserted the row. Keep
  // decoding in the same transaction so an unrepresentable allocated
  // key refuses without committing a document the caller cannot address.
  const insertAllocated = (doc) => connection.transaction(() => chain(
    runWrite('insertAllocated', dialect.dml.insertAllocated(shape),
      [JSON.stringify(doc), ...derivedFor(doc)], undefined, true),
    (row) => row.key));

  const core = {
    stats: () => ({ ...stats, ...engine.stats() }),
    model: collection,
    queryShape: engine.shape,
    // the provider: value-or-promise, deliberately NOT lifted — a
    // synchronous driver answers a linq chain synchronously
    execute: (document, options) => engine.execute(document, options),
    query: (document, options) => engine.query(document, options),
    explain: (document, options) => engine.explain(document, options),
    get(key) {
      requireKey(key, collection.name, collection.docPath);
      // a point read meets the same failures a statement of the query
      // engine does (a corrupt page, a locked file): classified, never raw
      return attempt(() => (spelledTwice(key)
        // either spelling; a key held under both (a duplicate a write
        // refuses) reads its canonical row
        ? chain(spellingsOf(/** @type {number} */ (key)), (rows) => {
          const row = rows.find((/** @type {any} */ r) => r.key === canonicalKeyText(key)) ?? rows[0];
          return row === undefined ? undefined : JSON.parse(row.doc);
        })
        : chain(prepared('get', dialect.dml.get(shape), { readOnly: true }), (statement) =>
          chain(statement.get([whereKey(key)]),
            (row) => (row === undefined ? undefined : JSON.parse(row.doc))))),
      (error) => wrapDriverError(error, { docPath: collection.docPath, collection: collection.name, key }));
    },
    insert(doc, options) {
      readWriteOptions(collection.name, options, 'insert', false);
      checkValid(doc);
      const key = resolveWriteKey(doc, undefined);
      if (key === null) return insertAllocated(doc);
      return keyedWrite(key, () => chain(
        runWrite('insert', dialect.dml.insert(shape),
          [bindKey(key), JSON.stringify(doc), ...derivedFor(doc)], key, false),
        () => key));
    },
    put(doc, explicitKey, options) {
      const expected = readWriteOptions(collection.name, options, 'put', true);
      checkValid(doc);
      const key = resolveWriteKey(doc, explicitKey);
      if (key === null) {
        // a key the database allocates names no stored document yet
        if (expected !== null) requireExpected('put', '(allocated)', expected, undefined);
        return insertAllocated(doc);
      }
      const upsert = () => chain(
        runWrite('upsert', dialect.dml.upsert(shape),
          [bindKey(key), JSON.stringify(doc), ...derivedFor(doc)], key, false),
        () => key);
      // a plain put is one statement; one with a precondition reads what
      // it replaces in the same transaction
      return expected === null ? keyedWrite(key, upsert)
        : atomically(key, (current) => {
          requireExpected('put', key, expected, current);
          return upsert();
        });
    },
    patch(key, given, options) {
      requireKey(key, collection.name, collection.docPath);
      const expected = readWriteOptions(collection.name, options, 'patch', true);
      const ops = patchAsJson(given);
      return atomically(key, (current) => {
        if (current === undefined) {
          throw new DbRuntimeError('JD2006',
            `no document to patch under key '${String(key)}'`,
            { docPath: collection.docPath, collection: collection.name, key });
        }
        if (expected !== null) requireExpected('patch', key, expected, current);
        // the copy-on-write engine applies the patch to the stored
        // document read under this transaction's lock, and the RESULT is
        // validated before the write — so the document validated is the
        // document written
        const next = applyJSONPatch(current, ops);
        // a patch that changes nothing writes nothing: no statement, no
        // change for capture, no commit another connection can see
        if (equalsJson(next, current)) return next;
        checkValid(next);
        // the document's key IS its key: a patch that rewrites it is the
        // same disagreement `put(doc, key)` refuses
        if (collection.keySegments !== null) {
          const own = extractKey(next, collection.keySegments, collection.key, collection.name, collection.docPath);
          if (canonicalKeyText(own) !== canonicalKeyText(/** @type {string | number} */ (key))) {
            throw new DbRuntimeError('JD2002',
              `patch: the patched document's key ${JSON.stringify(own)} at '${collection.key}' disagrees with `
              + `the key ${JSON.stringify(key)} it is stored under — a document's key is not patched; `
              + 'write it under its new key and delete the old one',
              { docPath: collection.docPath, collection: collection.name, key });
          }
        }
        const translated = translatePatch(ops, current, dialect);
        if (translated === null) {
          stats.patchFallback++;
          return chain(
            runWrite('patchFallback',
              dialect.dml.updateDoc(shape, dialect.jsonEncode(dialect.parameterRef(1, 'doc')), 2),
              [JSON.stringify(next), ...derivedFor(next), whereKey(key)], key, false),
            () => next);
        }
        stats.patchTranslated++;
        const { expression, params } = translated.build(
          dialect.quoteIdentifier(plan.docColumn), 1);
        const sql = dialect.dml.updateDoc(shape, expression, params.length + 1);
        return chain(prepared(`patch:${sql}`, sql), (statement) =>
          chain(attempt(() => statement.run([...params, ...derivedFor(next), whereKey(key)]),
            (error) => wrapWriteError(error, plan, collection.name, collection.docPath, key)),
          () => next));
      });
    },
    delete(key, options) {
      requireKey(key, collection.name, collection.docPath);
      const expected = readWriteOptions(collection.name, options, 'delete', true);
      const remove = () => chain(
        runWrite('delete', dialect.dml.del(shape), [whereKey(key)], key, false),
        (result) => Number(result?.changes ?? 0) > 0);
      return expected === null ? keyedWrite(key, remove)
        : atomically(key, (current) => {
          requireExpected('delete', key, expected, current);
          return remove();
        });
    },
    /**
     * Every stored document, ALWAYS as an array with one entry per
     * document, in the order `execute('$[*]')` visits them. It drains the
     * item cursor of `$[*]` rather than reading `execute`'s answer, which
     * is a sequence — `undefined` for none, the bare document for one, and
     * for one array-valued document exactly what two documents would give.
     * @param {{ signal?: AbortSignal, deadline?: number, profile?: any,
     *   strictStreaming?: boolean }} [options]
     * @returns {any} value-or-promise of the documents
     */
    all(options) {
      readAllOptions(options);
      const cursor = engine.query('$[*]', options, connection.synchronous ? createSyncCursor : createCursor);
      /** @type {any[]} */
      const documents = [];
      const pump = () => {
        for (;;) {
          const step = cursor.next();
          if (isThenable(step)) {
            return step.then((/** @type {any} */ result) => {
              if (result.done) return documents;
              documents.push(result.value);
              return pump();
            });
          }
          if (step.done) return documents;
          documents.push(step.value);
        }
      };
      let out;
      try {
        out = pump();
      }
      catch (error) {
        return chain(attempt(() => cursor.return(), () => error), () => { throw error; });
      }
      if (!isThenable(out)) return out;
      return out.catch((error) => chain(attempt(() => cursor.return(), () => error), () => { throw error; }));
    },
  };
  return core;
}

/**
 * Lift a core operation into the asynchronous contract: the returned
 * function ALWAYS rejects, never throws synchronously — a caller-side
 * `catch` must be enough.
 * @param {Function} fn
 * @returns {(...args: any[]) => Promise<any>}
 */
function lift(fn) {
  return (...args) => {
    try {
      return toPromise(fn(...args));
    }
    catch (error) {
      return Promise.reject(error);
    }
  };
}

/**
 * The asynchronous collection surface over a core.
 * @param {any} core
 * @param {Function | null} live - the store-level live registration
 *   for this collection (null when the store has no capture)
 * @returns {any}
 */
function asyncCollection(core, live) {
  return Object.freeze({
    stats: () => core.stats(),
    get: lift(core.get),
    insert: lift(core.insert),
    put: lift(core.put),
    patch: lift(core.patch),
    delete: lift(core.delete),
    all: lift(core.all),
    // the provider contract: execute stays value-or-promise so a
    // linq chain over a synchronous driver stays synchronous
    execute: (document, options) => core.execute(document, options),
    query: (document, options) => core.query(document, options),
    explain: lift(core.explain),
    live: lift((document, liveOptions) => {
      if (live === null) {
        throw new DbCompileError('JD0050',
          'live queries require change capture — open the store with { capture: true }');
      }
      return live(core, document, liveOptions);
    }),
  });
}

/**
 * Every member `openStore` reads, besides the connection pragmas. It is
 * a CLOSED set, checked before the driver opens, because a misspelt
 * option is otherwise dropped in silence: `captur: true` opened a store
 * with no capture at all, and the host found out in production. The
 * pragma table has refused a misspelt pragma name since it existed
 * (`JD0006`); this is the same promise for the store's own options.
 */
const OPEN_OPTIONS = new Set([
  'driver', 'path', 'readOnly', 'queueTimeout', 'compileSchema',
  'capture', 'replication', 'jobs', 'live', 'adopt', 'transactions',
  'expressions', 'operators', 'functions', 'extensions',
  'profile', 'statementCacheBound', 'zoneProvider', 'runtime', 'holdTimeoutMs',
  'isolation', 'owner', 'reads', 'sessions',
]);

/**
 * Refuse an open option outside the closed set (`JD0009`), naming the
 * nearest member when the spelling is close enough to be a typo. Run
 * after the pragma check, so a misspelt PRAGMA keeps its own more
 * specific refusal.
 * @param {Record<string, any>} options
 */
function refuseUnknownOpenOptions(options) {
  refuseUnknownMembers(options, [...OPEN_OPTIONS, ...PRAGMA_NAMES], (key, hint) =>
    new DbCompileError('JD0009', `openStore option '${key}' is not one this store reads${hint}`));
}

/**
 * Refuse an open option whose VALUE is malformed (`JD0009`), before the
 * driver opens — the closed set above settles the names, this settles
 * what each switch may hold. Each rule exists because a malformed value
 * used to mean something else in silence: `queueTimeout: Infinity`
 * became a 1 ms wait (the timer's own overflow rule), `capture: 'false'`
 * and `jobs: 0` switched the feature ON (any value but `undefined` and
 * `false` did), `jobs: null` threw a raw `TypeError`, and a misspelt
 * `transactions` was refused only after the file was created and its
 * handle opened.
 * @param {Record<string, any>} options
 */
function refuseMalformedOpenOptions(options) {
  const refuse = (/** @type {string} */ name, /** @type {string} */ rule) => new DbCompileError('JD0009',
    `openStore option '${name}' ${rule}, not ${describeValue(options[name])}`);
  const { queueTimeout } = options;
  if (queueTimeout !== undefined
    && (!Number.isInteger(queueTimeout) || queueTimeout < 0 || queueTimeout > 0x7fffffff))
    throw refuse('queueTimeout', 'is a whole number of milliseconds from 0 to 2147483647');
  for (const name of ['readOnly', 'adopt']) {
    if (options[name] !== undefined && typeof options[name] !== 'boolean')
      throw refuse(name, 'is true or false');
  }
  for (const name of ['capture', 'jobs']) {
    const value = options[name];
    if (value !== undefined && typeof value !== 'boolean' && !isPlainOptions(value))
      throw refuse(name, 'is true, false or its options object');
  }
  for (const name of ['live', 'replication']) {
    if (options[name] !== undefined && !isPlainOptions(options[name]))
      throw refuse(name, 'is its options object');
  }
  if (options.transactions !== undefined && options.transactions !== 'wait' && options.transactions !== 'strict')
    throw refuse('transactions', "is 'wait' or 'strict'");
  if (options.reads !== undefined && options.reads !== 'serialized' && options.reads !== 'parallel')
    throw refuse('reads', "is 'serialized' or 'parallel'");
  if (options.sessions !== undefined && (!Number.isInteger(options.sessions) || options.sessions < 1))
    throw refuse('sessions', 'is a whole number of sessions from 1');
  const { holdTimeoutMs } = options;
  if (holdTimeoutMs !== undefined
    && (!Number.isInteger(holdTimeoutMs) || holdTimeoutMs < 1 || holdTimeoutMs > TIMER_MAX))
    throw refuse('holdTimeoutMs', 'is a whole number of milliseconds from 1 to 2147483647');
  if (options.isolation !== undefined && !ISOLATION_LEVELS.includes(options.isolation))
    throw refuse('isolation', "is 'read committed', 'repeatable read' or 'serializable'");
  readOwnerOption(options);
}

/**
 * `sessions` is how many PostgreSQL sessions a Store runs its root calls and
 * transactions on: a driver that hands out several, up to what it admits.
 * Every refusal here is `JD0009`, before anything opens.
 * @param {Record<string, any>} options
 */
function refuseSessionsHere(options) {
  if (options.sessions === undefined) return;
  const driver = options.driver;
  if (typeof driver.contextStorage !== 'function')
    throw new DbCompileError('JD0009', "openStore option 'sessions' needs a driver that runs several sessions "
      + `(@jarenjs/db/postgres); this store's driver '${driver.name}' runs one connection`);
  if (options.sessions > driver.maxConnections)
    throw new DbCompileError('JD0009', "openStore option 'sessions' is at most the driver's maxConnections "
      + `(${driver.maxConnections}), not ${options.sessions}`);
  if (options.sessions > 1 && options.replication !== undefined)
    throw new DbCompileError('JD0009', "openStore option 'sessions' above 1 runs no replication: its pages, "
      + 'snapshots and applies are qualified on one session');
}

/**
 * Read `owner` — `{ id, leaseMs? }`, a closed set: `id` a non-empty string
 * naming the owner in every refusal, `leaseMs` a whole number of
 * milliseconds from 1,000 (a renewal runs every third of it) to 2^31 − 1,
 * 30,000 by default. A read-only store never takes the lease, so asking
 * one to is refused rather than ignored. Everything here is `JD0009`,
 * before the driver opens.
 * @param {Record<string, any>} options
 * @returns {{ id: string, leaseMs: number } | undefined}
 */
function readOwnerOption(options) {
  const value = options.owner;
  if (value === undefined) return undefined;
  const refuse = (/** @type {string} */ rule) => new DbCompileError('JD0009', `openStore option 'owner' ${rule}`);
  if (!isPlainOptions(value)) throw refuse(`is { id, leaseMs? }, not ${describeValue(value)}`);
  refuseUnknownMembers(value, ['id', 'leaseMs'], (key, hint) =>
    refuse(`member '${key}' is not one it reads${hint}`));
  const { id, leaseMs = OWNER_LEASE_DEFAULT_MS } = value;
  if (typeof id !== 'string' || id === '') throw refuse(`id is a non-empty string, not ${describeValue(id)}`);
  if (!Number.isInteger(leaseMs) || leaseMs < OWNER_LEASE_MIN_MS || leaseMs > TIMER_MAX) {
    throw refuse(`leaseMs is a whole number of milliseconds from ${OWNER_LEASE_MIN_MS} to ${TIMER_MAX}, `
      + `not ${describeValue(leaseMs)}`);
  }
  if (options.readOnly === true) {
    throw refuse('needs a writable store: a read-only open never takes or checks the lease — '
      + 'open read-only without owner');
  }
  return { id, leaseMs };
}

/**
 * How a refused value reads in a message: strings quoted, the rest as
 * JavaScript spells them (`Infinity`, `null`, `[object]`).
 * @param {unknown} value
 */
function describeValue(value) {
  if (typeof value === 'string') return `'${value}'`;
  if (value === null || typeof value !== 'object') return String(value);
  return Array.isArray(value) ? 'an array' : 'an object that is not a plain options object';
}

/**
 * The members a transaction reads (MODEL-FORMAT §5.1) — ONE closed set
 * for every surface: the asynchronous root, the synchronous twin and a
 * nested transaction. A member a surface cannot honour is not unknown
 * there; it is a guarantee requested where it cannot act (`JD0014`).
 */
const TRANSACTION_OPTIONS = Object.freeze(['mode', 'signal', 'unitOfWork', 'retry', 'holdTimeoutMs', 'isolation']);

/** The isolation levels a transaction may ask for, weakest first — a
 * FLOOR: the backend runs the level asked for or a stronger one. */
const ISOLATION_LEVELS = Object.freeze(['read committed', 'repeatable read', 'serializable']);

/** The members `retry` reads. */
const RETRY_MEMBERS = Object.freeze(['attempts', 'baseMs', 'maxMs']);

/** The longest wait a timer can take — `2^31 − 1` ms. */
const TIMER_MAX = 0x7fffffff;

/**
 * Read one transaction's options, refusing before the transaction
 * begins: anything but a plain object, an unknown member (named, with
 * the nearest one) or a malformed value is `JD0013`; on a nested
 * transaction, `unitOfWork`, `isolation` and a `mode: 'immediate'` the
 * enclosing transaction did not take are `JD0014` — a savepoint writes
 * through the unit of work around it, runs at its root's level and cannot
 * take the writer lock.
 * `retry` and `holdTimeoutMs` act on the asynchronous root only: the
 * synchronous twin cannot wait (between attempts, or for a hold clock),
 * and a savepoint inherits its root's — both are `JD0014` there, as is
 * `retry` with `unitOfWork: 'shared'` (a shared unit's restored pending
 * records would be saved twice).
 * @param {unknown} options
 * @param {'async' | 'sync' | 'nested'} surface
 * @param {string} spelling - how the call reads, for the messages
 * @param {'deferred' | 'immediate'} [enclosing] - the enclosing
 *   transaction's mode, for a nested one
 * @returns {{ mode?: 'deferred' | 'immediate', signal?: AbortSignal,
 *   unitOfWork?: 'shared' | 'own', retry?: { attempts: number, baseMs: number, maxMs: number },
 *   holdTimeoutMs?: number, isolation?: string }}
 */
function readTransactionOptions(options, surface, spelling, enclosing) {
  if (options === undefined) return {};
  if (!isPlainOptions(options)) {
    throw new DbCompileError('JD0013',
      `${spelling}: its options are an object — { ${TRANSACTION_OPTIONS.join(', ')} } — `
      + `not ${describeValue(options)}`);
  }
  refuseUnknownMembers(options, TRANSACTION_OPTIONS, (key, hint) =>
    new DbCompileError('JD0013', `${spelling} option '${key}' is not one a transaction reads${hint}`));
  const { mode, signal, unitOfWork, holdTimeoutMs, isolation } = options;
  if (mode !== undefined && mode !== 'deferred' && mode !== 'immediate')
    throw new DbCompileError('JD0013', `${spelling}: mode must be 'deferred' or 'immediate'`);
  if (isolation !== undefined && !ISOLATION_LEVELS.includes(isolation)) {
    throw new DbCompileError('JD0013',
      `${spelling}: isolation must be 'read committed', 'repeatable read' or 'serializable', not ${describeValue(isolation)}`);
  }
  if (unitOfWork !== undefined && unitOfWork !== 'shared' && unitOfWork !== 'own')
    throw new DbCompileError('JD0013', `${spelling}: unitOfWork must be 'shared' or 'own'`);
  if (signal !== undefined && (signal === null || typeof signal !== 'object'
    || typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function'))
    throw new DbCompileError('JD0013', `${spelling}: signal must be an AbortSignal`);
  const retry = options.retry === undefined ? undefined : readRetry(options.retry, spelling);
  if (holdTimeoutMs !== undefined
    && (!Number.isInteger(holdTimeoutMs) || holdTimeoutMs < 1 || holdTimeoutMs > TIMER_MAX)) {
    throw new DbCompileError('JD0013',
      `${spelling}: holdTimeoutMs is a whole number of milliseconds from 1 to ${TIMER_MAX}, not ${describeValue(holdTimeoutMs)}`);
  }
  if (surface !== 'async') {
    const where = surface === 'sync'
      ? 'the synchronous twin — it answers values, so it cannot wait'
      : 'a nested transaction — a savepoint lives inside its root, which owns them';
    if (retry !== undefined)
      throw new DbCompileError('JD0014', `${spelling}: retry cannot act on ${where}; retry the root transaction`);
    if (holdTimeoutMs !== undefined)
      throw new DbCompileError('JD0014', `${spelling}: holdTimeoutMs cannot act on ${where}; limit the root transaction`);
  }
  if (retry !== undefined && unitOfWork === 'shared') {
    throw new DbCompileError('JD0014',
      `${spelling}: retry cannot act with unitOfWork 'shared' — each attempt must start from a fresh `
      + "unit of work, or the restored pending records of a failed attempt are saved twice; omit unitOfWork");
  }
  if (surface === 'nested') {
    if (unitOfWork !== undefined) {
      throw new DbCompileError('JD0014',
        `${spelling}: unitOfWork cannot act on a nested transaction — a savepoint writes `
        + 'through the unit of work of the transaction around it; choose it on the root transaction');
    }
    if (isolation !== undefined) {
      throw new DbCompileError('JD0014',
        `${spelling}: isolation cannot act on a nested transaction — a savepoint runs at its root `
        + "transaction's level; choose it on the root transaction");
    }
    if (mode === 'immediate' && enclosing !== 'immediate') {
      throw new DbCompileError('JD0014',
        `${spelling}: mode 'immediate' cannot act inside a transaction that did not take the `
        + "writer lock — a savepoint cannot take it; begin the ROOT transaction with { mode: 'immediate' }");
    }
  }
  return { mode, signal, unitOfWork, retry, holdTimeoutMs, isolation };
}

/**
 * Read `retry` — `{ attempts, baseMs?, maxMs? }`: `attempts` a whole
 * number from 1 to 32 (1 is no retry), `baseMs` (default 5) and `maxMs`
 * (default 250, or `baseMs` when that is larger, and never below it) the
 * full-jitter backoff's bounds — the policy the store's open retry
 * measured and uses.
 * @param {unknown} value
 * @param {string} spelling
 * @returns {{ attempts: number, baseMs: number, maxMs: number }}
 */
function readRetry(value, spelling) {
  if (!isPlainOptions(value)) {
    throw new DbCompileError('JD0013', `${spelling}: retry is { attempts, baseMs?, maxMs? }, not ${describeValue(value)}`);
  }
  refuseUnknownMembers(value, RETRY_MEMBERS, (key, hint) =>
    new DbCompileError('JD0013', `${spelling}: retry member '${key}' is not one it reads${hint}`));
  const { attempts, baseMs = 5 } = value;
  const maxMs = value.maxMs === undefined ? (Number.isInteger(baseMs) ? Math.max(250, baseMs) : 250) : value.maxMs;
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 32)
    throw new DbCompileError('JD0013', `${spelling}: retry.attempts is a whole number from 1 to 32, not ${describeValue(attempts)}`);
  if (!Number.isInteger(baseMs) || baseMs < 0 || baseMs > TIMER_MAX)
    throw new DbCompileError('JD0013', `${spelling}: retry.baseMs is a whole number of milliseconds, not ${describeValue(baseMs)}`);
  if (!Number.isInteger(maxMs) || maxMs < baseMs || maxMs > TIMER_MAX)
    throw new DbCompileError('JD0013', `${spelling}: retry.maxMs is a whole number of milliseconds no less than baseMs, not ${describeValue(maxMs)}`);
  return { attempts, baseMs, maxMs };
}

/**
 * The schema a WRITE validates against. A store-allocated key (`default:
 * "auto"`) is absent from the document the injected hook sees — the
 * database allocates it after validation — so it cannot be required of a
 * write, and the generated input type already marks it optional; every
 * other member is the schema's own, defaults filled (§9.6). The read
 * shape is untouched: the document the store answers carries the key.
 *
 * A NULLABLE column-mapped scalar is carved out for the same reason.
 * §9.3 stores JSON `null` and absence alike as SQL `NULL` and reads
 * both back ABSENT, so the storage keeps no distinction a write could
 * be held to — and requiring it would refuse the store's own
 * read-modify-write: the document `get` answers omits the member, and
 * putting it straight back would fail validation on a member the store
 * itself dropped. A nullable member that stays in the DOCUMENT keeps
 * its `required` entry, because there `null` round-trips as `null`.
 * @param {any} entity - a normalized entity
 * @param {any} entityMapping - the entity's mapping (its `columns` say
 *   which members have a column of their own)
 * @returns {any}
 */
function writeSchemaOf(entity, entityMapping) {
  const schema = entity.schema;
  const generated = new Set(entity.keys.filter((key) => entity.properties.get(key).default === 'auto'));
  for (const column of entity.physical?.columns ?? [])
    if (column.databaseDefault || column.generated) generated.add(column.name);
  for (const column of entityMapping?.columns ?? []) {
    const property = entity.properties.get(column.name);
    if (property?.nullable === true && property.key !== true) generated.add(column.name);
  }
  if (!Array.isArray(schema?.required) || !schema.required.some((name) => generated.has(name))) return schema;
  const out = { ...schema, required: schema.required.filter((name) => !generated.has(name)) };
  if (out.required.length === 0) delete out.required;
  return out;
}

/**
 * Resolve the store's operator seam (Ring 2) to a single
 * `{ functions, extensions }` or `null`. Accepts `options.operators` (a
 * registry from `@jarenjs/json/jslt`'s `createJsltRegistry()`) and/or
 * raw `options.functions` / `options.extensions`. A registered operator
 * becomes engine vocabulary the query planner recognises and the
 * residual evaluates — it runs correctly in JavaScript over the fetched
 * rows, and is never pushed to SQL in this ring (that is Ring 3). Bad
 * input is API misuse (a synchronous `TypeError`), consistent with the
 * driver check. When no registry is threaded the return is `null`, and
 * the whole query engine is byte-identical to before.
 * @param {any} options
 * @returns {{ functions: any, extensions: any } | null}
 */
/**
 * The declaration rules a registry aggregate must satisfy to be lowered
 * to a SQL aggregate, checked once at open: `kind: 'agg'`, ONE leading
 * sequence operand (the fold's input) and nothing else, and a scalar
 * result. The arity rule is not fussiness — a SQL aggregate's `result`
 * step sees only what the row steps accumulated, so a second operand
 * simply does not reach a fold over zero rows, and an aggregate that
 * answered a different value for an empty input than the engine does
 * would be worse than one that stays where it is. A pack that marks
 * something else `pushable: 'aggregate'` is a host configuration
 * error, loud here rather than a silent non-promotion.
 * @param {string} name
 * @param {any} meta - the registry's `forSql()` entry
 * @returns {{ fn: Function }}
 */
function aggregateSpec(name, meta) {
  const kinds = (Array.isArray(meta.signature) ? meta.signature : [])
    .map((token) => (typeof token === 'string' && token.startsWith('seq') ? 'seq' : 'scalar'));
  const wellFormed = meta.kind === 'agg'
    && kinds.length === 1 && kinds[0] === 'seq'
    && meta.signature[0] === 'seq<number>'
    && meta.result === 'number'
    && typeof meta.fn === 'function';
  if (!wellFormed) {
    throw new TypeError(`openStore: operator '${name}' declares pushable: 'aggregate', which `
      + "needs kind: 'agg' with exactly one operand, 'seq<number>', and result: 'number'");
  }
  return { fn: meta.fn };
}

function resolveOperators(options) {
  const registry = options.operators;
  const hasRegistry = registry !== undefined && registry !== null;
  const hasRaw = options.functions !== undefined || options.extensions !== undefined;
  if (!hasRegistry && !hasRaw) return null;
  let functions = {};
  let extensions = {};
  // the SQL-pushable scalar subset (Ring 3): the registered operators a
  // pack marked `pushable: 'scalar'`, eligible to become deterministic
  // UDFs where the driver supports them. Raw (registry-free) extensions
  // are never pushed — only a registry declares pushability.
  const pushableScalar = new Set();
  // the SQL-pushable AGGREGATE subset (Ring 3): a registry `agg` entry
  // marked `pushable: 'aggregate'`, which promises a fold over the
  // multiset alone — a SQL aggregate visits rows in an order nothing
  // specifies — and a finite-or-empty scalar result
  const pushableAggregate = new Map();
  if (hasRegistry) {
    if (typeof registry.toOptions !== 'function') {
      throw new TypeError('openStore: operators must be a registry '
        + '(createJsltRegistry()) exposing toOptions()');
    }
    const resolved = registry.toOptions();
    // reuse the registry's stable frozen maps by reference when there
    // are no raw overrides, so the engine's identity-keyed caches hit
    functions = resolved.functions ?? {};
    extensions = resolved.extensions ?? {};
    if (typeof registry.forSql === 'function') {
      for (const [name, meta] of Object.entries(registry.forSql())) {
        if (meta.pushable === 'scalar') pushableScalar.add(name);
        else if (meta.pushable === 'aggregate') pushableAggregate.set(name, aggregateSpec(name, meta));
      }
    }
  }
  if (options.functions !== undefined) functions = { ...functions, ...options.functions };
  if (options.extensions !== undefined) extensions = { ...extensions, ...options.extensions };
  return Object.freeze({ functions, extensions, pushableScalar, pushableAggregate });
}

/**
 * Open (or create) a store described by a model document.
 * @param {any} model - A `jaren-model` document (the 0.1 subset)
 * @param {{ driver: any, path?: string, compileSchema?: Function,
 *   busyTimeout?: number, queueTimeout?: number, journalMode?: string,
 *   synchronous?: string, walAutocheckpoint?: number,
 *   journalSizeLimit?: number, cacheSize?: number, mmapSize?: number,
 *   tempStore?: string,
 *   statementCacheBound?: number, profile?: any, operators?: any,
 *   functions?: any, extensions?: any, zoneProvider?: any,
 *   runtime?: Partial<import('@jarenjs/core/runtime').Runtime>,
 *   readOnly?: boolean }} options
 *   `zoneProvider` is the injected clock: a named zone in a temporal
 *   spec (`{ "every": "P1M", "zone": "Europe/Amsterdam" }`) is host code
 *   the database cannot have, so a store that never received one refuses
 *   such a document (`JQ0003`) rather than answering it in UTC. It
 *   reaches every residual compilation, which is where the calendar
 *   ladder actually walks.
 *   The connection pragmas — `busyTimeout`, `journalMode`, `synchronous`,
 *   `walAutocheckpoint`, `journalSizeLimit`, `cacheSize`, `mmapSize`,
 *   `tempStore` — are a closed, validated set (`pragmas.js`): an option
 *   naming any other pragma is refused `JD0006`, one the driver or the
 *   store kind cannot apply `JD0007`, and every value is read back after
 *   the open sequence and reported on `capabilities.pragmas` — a value
 *   the engine did not take is `JD0008`, never a silent divergence.
 *   `runtime` is the host's runtime record (`@jarenjs/core/runtime`):
 *   the clock the capture log and the job queue stamp, the identifier
 *   a `uuid` identity and a `default: 'uuid'` allocate, the job queue's
 *   backoff jitter, and the zone provider — each read only where the
 *   store has no explicit option for it (`zoneProvider`, `jobs.now`,
 *   `jobs.random` win), and handed on to the job engine so a consumer
 *   configures it once.
 * @returns {Promise<any>}
 */
export function openStore(model, options) {
  if (options === null || typeof options !== 'object'
    || options.driver === null || typeof options.driver !== 'object'
    || typeof options.driver.open !== 'function')
    throw new TypeError('openStore needs { driver } from @jarenjs/db/node, /bun or /wasm');
  if (options.compileSchema !== undefined && typeof options.compileSchema !== 'function')
    throw new TypeError('openStore: compileSchema must be a function when present');
  const operators = resolveOperators(options);
  const runtime = resolveRuntime(options.runtime);
  // the explicit option wins over the record's member, and an explicit
  // `null` is a deliberate "none" rather than a fall-through
  const zoneProvider = options.zoneProvider !== undefined ? options.zoneProvider : runtime.zoneProvider;

  // API misuse (above) throws; a defective MODEL rejects, per the
  // asynchronous contract
  let collections;
  let entities;
  let mapping;
  /** @type {{ id: string, leaseMs: number } | undefined} */
  let ownerOption;
  try {
    // first: the model checks below read these switches
    refuseMalformedOpenOptions(options);
    refuseSessionsHere(options);
    ownerOption = readOwnerOption(options);
    collections = normalizeModel(model, options.expressions);
    const compiled = compileEntityModel(model);
    entities = compiled.entities;
    mapping = entities.size > 0 ? compiled.mapping : null;
    if ([...entities.values()].some((e) => e.physical !== null) && (options.capture || options.replication))
      throw new DbCompileError('JD0051', 'column adoption preserves application triggers; complete capture is not qualified');
    if (options.adopt === true && (options.capture || options.replication))
      throw new DbCompileError('JD0005', 'adoption creates no infrastructure; configure it through an explicit migration');
    if (options.replication !== undefined && [...collections.keys(), ...entities.keys()]
      .some((name) => name.toLowerCase().startsWith('_jaren_replica')))
      throw new DbCompileError('JD0060', 'replication reserves table names beginning with _jaren_replica');
    if (collections.size === 0 && entities.size === 0) {
      throw modelError('JD0005',
        'the model must declare at least one collection or entity', '');
    }
  }
  catch (error) {
    return Promise.reject(error);
  }
  const path = options.path ?? ':memory:';
  const memory = path === ':memory:' || path === '';
  const readOnly = options.readOnly === true;
  // the connection pragmas are a closed, validated set: a pragma outside
  // it is JD0006, one this store kind cannot take is JD0007, and a bad
  // value is API misuse — all settled before the driver opens, so a
  // refused configuration never acquires a handle
  let pragmaRequests;
  try {
    refuseUnsupportedPragmaKeys(options);
    refuseUnknownOpenOptions(options);
    pragmaRequests = resolvePragmaRequests(options, { memory, readOnly });
  }
  catch (error) {
    return Promise.reject(error);
  }
  const busyTimeout = /** @type {number} */ (pragmaRequests.get('busyTimeout')?.value);
  const storeProfile = options.profile === undefined
    ? null
    : normalizeProfile(options.profile);
  // every root a profile's member allow-list may name — the model's own
  // collections and entities — so a policy that names something the
  // model does not declare is refused rather than applied to nothing
  const declaredRoots = Object.freeze([...collections.keys(), ...entities.keys()]);
  try {
    assertProfileRoots(storeProfile, declaredRoots);
  }
  catch (error) {
    return Promise.reject(error);
  }

  /** A driver failure at or after `driver.open` as the open's own
   * refusal: `JD0002`, with the classifier's `class`/`retryable` and the
   * driver's error as `cause`.
   * @param {any} failure */
  const openFailure = (failure) => {
    const classified = classifyDriverError(failure);
    const wrapped = new DbCompileError('JD0002',
      `the store could not be opened (${classified.reason}): ${failure?.message ?? String(failure)}`,
      undefined, failure);
    wrapped.class = classified.class;
    wrapped.retryable = classified.retryable;
    return wrapped;
  };

  const openOne = () => attempt(() => options.driver.open(path,
    { timeout: busyTimeout, readOnly, queueTimeout: options.queueTimeout }),
  (failure) => (isDriverError(failure) ? openFailure(failure) : failure));
  /**
   * A store on several sessions: the driver's own connections, opened one
   * after another, behind one router (sessions.js). A refused open closes
   * what it had opened.
   * @returns {Promise<any>}
   */
  /** What a fresh root context starts with on several sessions, set once the
   * store has its own unit of work: no call checks out a session before.
   * @type {() => Record<string, any>} */
  let freshContext;
  const openSessions = () => Promise.resolve(options.driver.contextStorage()).then((storage) => {
    /** @type {any[]} */
    const sessions = [];
    const next = () => (sessions.length === options.sessions
      ? createSessionRouter({ sessions, storage, newContext: () => freshContext() })
      : chain(openOne(), (connection) => { sessions.push(connection); return next(); }));
    return toPromise(next()).catch((error) =>
      Promise.allSettled(sessions.map((connection) => connection.close())).then(() => { throw error; }));
  });

  return toPromise(chain(
    (options.sessions ?? 1) > 1 ? openSessions() : openOne(),
    (opened) => {
      /**
       * The owner lease (MODEL-FORMAT §5.1) once the open sequence took it,
       * or `null` for a store opened without `owner`. Every admission — a
       * store-level call, a transaction's begin — asks it first, so a store
       * that is not, or no longer, its database's owner runs nothing.
       * @type {any}
       */
      let ownerLease = null;
      /** @param {boolean} synchronous - whether the caller cannot wait for a renewal */
      const ownerGuard = (synchronous) => (ownerLease === null ? undefined : ownerLease.guard(synchronous));
      /** The lease checked again once the gate admitted the call: it may
       * have waited past the lease's expiry. */
      const ownerAdmitted = () => (ownerLease === null ? undefined : ownerLease.admitted());
      /**
       * Set by `close()` once its job workers have stopped: every later
       * admission refuses `JD2063` by name, rather than queue behind the
       * lease's release and run after the store gave its lease back.
       */
      let admissionClosed = false;
      const refuseClosed = () => {
        if (admissionClosed) {
          throw new DbRuntimeError('JD2063',
            'the store is closed — a call after close() has no connection to run on');
        }
      };

      /**
       * The transaction state of the CALLING context, as one object: the
       * slots `scope`, `currentScope`, `currentRoot`, `settlements` and
       * `work` described below. A store on one session has one owner at a
       * time, so the slots are the store's own; a store on several sessions
       * (`sessions`) gives each root call a context of its own, so two
       * transactions on two sessions never share one (see `openSessions`).
       * @type {{ scope: any, currentScope: any, currentRoot: any, settlements: any[] | null, work: any }}
       */
      const rootContext = { scope: null, currentScope: null, currentRoot: null, settlements: null, work: null };
      /** @type {() => typeof rootContext} */
      let ctx = () => rootContext;

      /**
       * `scope`: the transaction SCOPE that currently owns the driver
       * connection, or `null`. A top-level `store.transaction()` sets it for
       * the callback's whole lifetime so the collection/entity cores below
       * reach the open transaction instead of queueing behind it.
       */

      /**
       * Whether the calling async context is inside a PARALLEL read (`reads:
       * 'parallel'`). The pool routes such a read's statements to its reader
       * by that context, whatever object prepared them; the read still goes
       * to the driver connection rather than through the scope of a
       * transaction that happens to be open, so nothing it does depends on
       * that transaction's lifetime checks, and a transaction asked for
       * inside it is refused by name below.
       */
      const inParallelRead = options.reads === 'parallel' ? () => opened.inShared() : () => false;
      /** A transaction asked for inside a parallel read: the read already
       * runs in a read transaction of its own, on a reader, where a write
       * or a savepoint has nowhere to go. No classified read opens one, so
       * reaching this is a defect in that classification, refused by name. */
      const refuseInParallelRead = () => {
        throw new DbCompileError('JD0014', 'a parallel read runs in a read transaction of its own on a '
          + 'reader and opens no transaction; this call belongs on the exclusive path');
      };

      /**
       * `currentScope`: the IDENTITY of the scope that is current right now, or `null`.
       * One fresh identity per `withScope` invocation: it is what every
       * transaction view is pinned to (§5.1's exact-scope rule), and the
       * comparison `currentScope === identity` is the whole lifetime
       * check — a view whose identity is not current has either settled
       * or been crossed by an inner scope, and refuses `JD2070` before
       * reading tracker state or issuing a statement. It must never fall
       * through to the root and never follow a newer scope.
       */

      /**
       * `currentRoot`: the ROOT record of the open top-level transaction, or `null` while
       * none is open: its `mode` (a nested transaction reads it to refuse
       * a `mode: 'immediate'` its savepoint could not honour, `JD0014`),
       * its `attempt` (`tx.attempt`), the isolation level it runs at
       * (`tx.isolation`; `undefined` for the store's own transactions, which
       * run at the session's), and its hold limit's state — `hold`
       * (ms, or `undefined`), `expired` (set when the limit passed: every
       * handle of the transaction then refuses `JD2098`), and the handle
       * operations in flight, which a hold waits for before it rolls back:
       * `{ mode, attempt, isolation, hold, expired, inFlight, onIdle }`.
       */
      /** A scope identity's root record (a nested scope shares its root's):
       * carried ON the identity, which lives exactly as long as the scope's
       * handles do — a map from short-lived keys cost every transaction a
       * garbage-collector ephemeron.
       * @param {any} identity */
      const rootOf = (identity) => identity.root;

      /** The root a handle operation belongs to has one fewer in flight. @param {any} root */
      const settleInFlight = (root) => {
        root.inFlight -= 1;
        if (root.inFlight === 0 && root.onIdle !== null) {
          const idle = root.onIdle;
          root.onIdle = null;
          idle();
        }
      };
      /** Resolves once no handle operation of the root is in flight. @param {any} root */
      const whenIdle = (root) => (root.inFlight === 0 ? Promise.resolve()
        : new Promise((resolve) => { root.onIdle = () => resolve(undefined); }));

      /**
       * The refusal of a transaction that held its connection past its
       * hold limit (`JD2098`): rolled back, and every handle it gave out
       * refuses. It carries `holdTimeoutMs` and `elapsedMs` (when the
       * rollback began).
       * @param {{ holdTimeoutMs: number, elapsedMs: number }} expired
       */
      const heldTooLong = (expired) => {
        const error = new DbRuntimeError('JD2098',
          `the transaction held its connection past its hold limit (${expired.holdTimeoutMs} ms) and was `
          + `rolled back after ${expired.elapsedMs} ms; nothing it wrote was committed, and its handles refuse`);
        Object.assign(error, { class: 'timeout', retryable: false,
          holdTimeoutMs: expired.holdTimeoutMs, elapsedMs: expired.elapsedMs });
        return error;
      };
      /**
       * Check the monotonic deadline even when synchronous work or a chain
       * of microtasks has not let the timer run. A settled body clears its
       * start time, so an ordinary escaped handle stays JD2070 afterwards.
       * @param {any} root
       */
      const checkHold = (root) => {
        if (root.holdStarted !== undefined && root.expired === null) {
          const elapsed = performance.now() - root.holdStarted;
          if (elapsed >= root.hold)
            root.expired = Object.freeze({ holdTimeoutMs: root.hold, elapsedMs: Math.round(elapsed) });
        }
        return root.expired;
      };
      /** The body a JD2098 is still waiting on, by the error the rollback raised.
       * @type {WeakMap<object, Promise<unknown>>} */
      const heldBodies = new WeakMap();

      /**
       * `settlements`: what the OPEN transaction owes its in-memory callers once the
       * database has agreed, in registration order, or `null` when no
       * transaction is open. One list, owned by the outermost scope: a
       * nested savepoint remembers only where it started, so rolling it
       * back takes back exactly what it registered and releasing it hands
       * those effects to the scope that outlives it.
       *
       * It exists because an in-memory claim about what the database
       * holds may not become true before the database does — the unit of
       * work's snapshots are such a claim, and a savepoint release is not
       * a commit. Each entry is `{ commit?, rollback? }`.
       */

      /**
       * `work`: the unit of work the OPEN scope writes through, and the store's
       * own. A nested savepoint inherits whatever is in force — it is the
       * same unit of work one level down — while a transaction asked for
       * `unitOfWork: 'own'` gets a fresh one for its callback's lifetime.
       * Both are set once the model's cores exist.
       */
      /** @type {any} */
      let rootWork = null;

      // a store on several sessions: each root call's context carries its
      // own state, starting as the store's own does outside any transaction
      const severalSessions = opened.primary !== undefined;
      if (severalSessions) {
        ctx = () => opened.context() ?? rootContext;
        freshContext = () => ({ scope: null, currentScope: null, currentRoot: null, settlements: null, work: rootWork });
      }

      /**
       * Run what the open transaction owes on its COMMIT, in registration
       * order, and empty the list. Idempotent, and safe to re-enter: each
       * effect is taken off the list before it runs.
       */
      const flushSettlements = () => {
        if (ctx().settlements === null) return;
        for (const effect of ctx().settlements.splice(0)) effect.commit?.();
      };

      /**
       * What the cores talk to: the owning transaction's scope while one
       * is open, the driver connection otherwise. One indirection, so a
       * core issues its statements wherever the caller that reached it is
       * — and it is why work inside a transaction callback runs
       * immediately as the owner rather than waiting for a commit it is
       * part of.
       *
       * It is NOT what separates a store-level caller from the
       * transaction: that is the gate below, which the store's own
       * handles take and a scope-bound handle does not. A parallel read
       * is the one caller that bypasses the scope: it runs on a reader of
       * its own, outside whatever transaction is open (see `share`).
       */
      /**
       * A statement of a store on several sessions: prepared again on the
       * calling context's session at each execution — a core keeps the
       * statements it prepares, and one bound to the session that prepared
       * it would run on another caller's. An iterator stays on the session
       * that opened it.
       * @param {string} sql @param {any} [metadata]
       */
      const sessionStatement = (sql, metadata) => {
        const here = () => (ctx().scope ?? opened).prepare(sql, metadata);
        return Object.freeze({
          run: (/** @type {any[]} */ params) => chain(here(), (statement) => statement.run(params)),
          get: (/** @type {any[]} */ params) => chain(here(), (statement) => statement.get(params)),
          all: (/** @type {any[]} */ params) => chain(here(), (statement) => statement.all(params)),
          iterate: (/** @type {any[]} */ params) => chain(here(), (statement) => statement.iterate(params)),
          finalize: () => undefined,
        });
      };
      const connection = Object.freeze({
        get synchronous() { return opened.synchronous; },
        get capabilities() { return opened.capabilities; },
        get dialect() { return opened.dialect; },
        /** @param {string} sql */
        exec: (sql) => (inParallelRead() ? opened : ctx().scope ?? opened).exec(sql),
        /** @param {string} sql */
        prepare: severalSessions ? sessionStatement
          : (sql, metadata) => (inParallelRead() ? opened : ctx().scope ?? opened).prepare(sql, metadata),
        /** Internal transaction users (jobs, checkpoints, migrations)
         * nest when a transaction is open and take the gate when not.
         * `'immediate'` takes the writer lock up front when nothing is open
         * yet; inside an open transaction the call is its savepoint.
         * @param {(scope: any) => any} fn @param {'immediate'} [mode] */
        transaction: (fn, mode) => (inParallelRead() ? refuseInParallelRead() : withScope(ctx().scope === null
          ? (/** @type {any} */ inner) => opened.transaction(inner, undefined, mode)
          : (/** @type {any} */ inner) => /** @type {any} */ (ctx().scope).transaction(inner, mode), fn, undefined, undefined,
          // a savepoint an operation opens inside a transaction's scope is
          // that scope's own work, which its other operations wait for
          ctx().currentScope === null ? undefined : ctx().currentScope.internalOf ?? ctx().currentScope)),
        /**
         * Register what settling the OPEN transaction owes an in-memory
         * caller: `commit` when it commits, `rollback` when it rolls back,
         * either half optional. With nothing open the statements are
         * already durable, so `commit` runs at once and the rollback is
         * discarded. The effects are bookkeeping — they run after the last
         * statement of their scope and must issue none.
         * @param {{ commit?: () => void, rollback?: () => void }} effects
         */
        onSettle: (effects) => {
          if (ctx().settlements === null) effects.commit?.();
          else ctx().settlements.push(effects);
        },
        registerFunction: opened.registerFunction === null ? null
          : (/** @type {string} */ name, /** @type {any} */ o, /** @type {Function} */ fn) =>
            opened.registerFunction(name, o, fn),
        registerAggregate: opened.registerAggregate === null ? null
          : (/** @type {string} */ name, /** @type {any} */ spec) =>
            opened.registerAggregate(name, spec),
        session: opened.session === null ? null
          : (/** @type {any} */ table) => opened.session(table),
        // the online-backup primitives, when the binding has them
        backup: opened.backup ?? null,
        close: (/** @type {any} */ closeOptions) => opened.close(closeOptions),
      });

      /**
       * Run `fn` as a transaction opened by `open`, with `scope` bound to
       * it for the callback's whole lifetime and restored afterwards. The
       * scope also settles what was registered against it: commits in
       * registration order when it keeps, rollbacks in reverse when it
       * does not, and only its own when it is an inner savepoint.
       *
       * `fn` receives the driver scope and this invocation's fresh
       * IDENTITY. A user-facing caller builds the transaction view from
       * the pair; internal nesting (a save's own transaction, a capture
       * scope, a membership attach) ignores both and runs through the
       * dynamic connection, which after the view's `JD2070` check is
       * exactly its own scope.
       * @param {(inner: (s: any) => any) => any} open - the driver's
       *   `transaction`, gated (top level) or nesting (inner)
       * @param {(inner: any, identity: any) => any} fn
       * @param {any} [ownWork] - a unit of work for this scope alone;
       *   without one the scope writes through whatever is already in
       *   force, which is what makes an inner savepoint part of the same
       *   unit of work as the transaction around it
       * @param {{ mode: 'deferred' | 'immediate', attempt?: number, holdTimeoutMs?: number,
       *   isolation?: string }} [root]
       *   - a ROOT transaction's record; an inner scope inherits the one in force
       */
      /**
       * Close the cursors a scope opened and has not seen settle — kept on
       * its identity (`identity.cursors`, their release functions). A scope
       * closes them when its body settles, before its COMMIT, RELEASE or
       * ROLLBACK, so a cursor a body peeked and walked away from never
       * outlives its transaction: on a worker it held one of `maxCursors`
       * slots forever, and on PostgreSQL a `CLOSE` sent after the
       * transaction ended would land in the next owner's. `null` when the
       * scope left nothing open.
       * @param {any} identity @returns {Promise<void> | null}
       */
      const closeCursorsOf = (identity) => {
        /** @type {Set<() => Promise<unknown>> | undefined} */
        const open = identity.cursors;
        if (open === undefined || open.size === 0) return null;
        identity.cursors = undefined;
        return Promise.allSettled([...open].map((release) => release())).then(() => undefined);
      };

      function withScope(open, fn, ownWork, root, internalOf) {
        return open((inner) => {
          const outer = ctx().scope;
          const outerWork = ctx().work;
          const outerIdentity = ctx().currentScope;
          const outerRoot = ctx().currentRoot;
          const outermost = ctx().settlements === null;
          if (outermost) ctx().settlements = [];
          const list = /** @type {any[]} */ (ctx().settlements);
          // where this scope's own effects begin: a rollback takes back
          // from here, and everything before it belongs to a scope that
          // is still open
          const mark = list.length;
          /** @type {{ root?: any, cursors?: Set<() => Promise<unknown>>, context?: any, internalOf?: any }} */
          const identity = { context: ctx() };
          if (internalOf !== undefined) identity.internalOf = internalOf;
          ctx().scope = inner;
          ctx().currentScope = identity;
          if (root !== undefined) {
            ctx().currentRoot = { mode: root.mode, attempt: root.attempt ?? 1, isolation: root.isolation,
              hold: root.holdTimeoutMs, expired: null, inFlight: 0, onIdle: null };
          }
          if (ctx().currentRoot !== null) identity.root = ctx().currentRoot;
          if (ownWork !== undefined) ctx().work = ownWork;
          const kept = () => {
            if (outermost) flushSettlements();
          };
          const undone = () => {
            const mine = list.splice(mark);
            for (let i = mine.length - 1; i >= 0; i--) mine[i].rollback?.();
          };
          const restore = (settled) => {
            // a scope nested in a transaction that already settled around
            // it — a hold limit rolled the root back while this body still
            // ran — restores nothing: the root put the store back when it
            // settled, and another owner may be current by now
            if (!outermost && ctx().currentScope !== identity) return;
            if (settled) kept();
            else undone();
            ctx().scope = outer;
            ctx().work = outerWork;
            ctx().currentScope = outerIdentity;
            ctx().currentRoot = outerRoot;
            if (outermost) ctx().settlements = null;
          };
          let out;
          try {
            out = fn(inner, identity);
          }
          catch (error) {
            restore(false);
            throw error;
          }
          if (!isThenable(out)) {
            restore(true);
            return out;
          }
          if (inner?.inline === true && !outermost) {
            // a call run inline on its owner's synchronous extent is part of
            // the owner's work: the owner's slots come back as soon as the
            // call returns, so the body's own handle stays current while the
            // call's promise is pending, and the call's later statements run
            // through the owner's scope; its effects stay on the owner's list
            ctx().scope = outer;
            ctx().work = outerWork;
            ctx().currentScope = outerIdentity;
            ctx().currentRoot = outerRoot;
            return out.then((value) => chain(closeCursorsOf(identity), () => value),
              (error) => chain(closeCursorsOf(identity), () => { throw error; }));
          }
          // the scope's cursors close inside it, before it settles
          return out.then(
            (value) => chain(closeCursorsOf(identity), () => { restore(true); return value; }),
            (error) => chain(closeCursorsOf(identity), () => { restore(false); throw error; }));
        });
      }

      /** Set once the store object exists: builds the transaction
       * callback's argument for ONE exact scope — a fresh view per
       * `withScope` invocation, pinned to its identity, whose
       * `transaction` NESTS instead of queueing. Assigned before any
       * user-facing transaction can run, so no placeholder is needed.
       * @type {(driverScope: any, identity: any) => any} */
      let scopedStore;

      /**
       * A TOP-LEVEL store transaction. It takes the connection's gate
       * first, so two of them never share a savepoint stack no matter how
       * their callbacks interleave, and the capture scope opens INSIDE it
       * — a rollback then undoes the translated patch together with the
       * rows it describes.
       * @param {(store: any) => any} fn
       * @param {AbortSignal} [signal]
       * @param {any} [ownWork]
       */
      // a driver failure of the transaction itself — a `BEGIN IMMEDIATE`
      // that outwaits the busy timeout, a writer lock past the lock
      // timeout — is classified like a statement's (`wrapDriverError`
      // passes a callback's own error through untouched). A store that is
      // not, or no longer, its database's owner begins nothing (`JD2061`).
      // `begin` carries the isolation level to spell and the writer lock.
      // `via` is where it begins: any session, or the first one for a write
      // on the store's own unit of work (`gatedWork`)
      const beginTransaction = (inner, signal, mode, begin, via = opened) =>
        attempt(() => {
          refuseClosed();
          return chain(ownerGuard(false), () => via.transaction((/** @type {any} */ scope) => {
            ownerAdmitted();
            return inner(scope);
          }, signal, mode, begin));
        }, (error) => wrapDriverError(error, { docPath: '/transaction' }));
      /** Gives the capture engine up for an expired transaction; set once
       * capture exists (a store without capture has nothing to give up). */
      let abandonCapture = () => {};

      /**
       * Run a top-level body under its hold limit (MODEL-FORMAT §5.1). The
       * clock starts when the body does — after queue admission and after
       * the transaction began — on the monotonic clock. At the limit the
       * transaction is marked expired, so every handle it gave out refuses
       * `JD2098`; the handle operations already in flight finish; then the
       * body's race is lost: the driver rolls the transaction back and
       * hands the connection on, while the body itself may still be
       * awaiting. Admission and settlement check the same deadline, so a
       * body cannot outrun it by keeping the timer off the event loop.
       * @param {any} root
       * @param {() => any} run
       * @returns {any}
       */
      const holdAround = (root, run) => {
        if (root === null || root.hold === undefined) return run();
        const started = performance.now();
        root.holdStarted = started;
        let out;
        try { out = run(); }
        catch (error) { out = Promise.reject(error); }
        if (!isThenable(out) && checkHold(root) === null) {
          root.holdStarted = undefined;
          return out;
        }
        const body = toPromise(out);
        return new Promise((resolve, reject) => {
          let expired = false;
          const expire = () => {
            if (expired) return;
            expired = true;
            clearTimeout(timer);
            // the handles refuse from this instant...
            root.expired = Object.freeze({ holdTimeoutMs: root.hold,
              elapsedMs: Math.round(performance.now() - started) });
            void whenIdle(root).then(() => {
              // ...and the rollback begins once the operations under way
              // finished: `elapsedMs` says when that was
              root.expired = Object.freeze({ holdTimeoutMs: root.hold,
                elapsedMs: Math.round(performance.now() - started) });
              root.holdStarted = undefined;
              const error = heldTooLong(root.expired);
              heldBodies.set(error, body);
              try {
                abandonCapture();
              }
              finally {
                // whatever giving the capture engine up met, the
                // transaction settles: the caller always hears JD2098
                reject(error);
              }
            });
          };
          const timer = setTimeout(expire, Math.max(1, Math.ceil(root.hold - (performance.now() - started))));
          /** @param {(value: any) => void} settle @param {any} value */
          const finish = (settle, value) => {
            if (expired) return;
            if (checkHold(root) !== null) { expire(); return; }
            clearTimeout(timer);
            root.holdStarted = undefined;
            settle(value);
          };
          body.then((value) => finish(resolve, value), (error) => finish(reject, error));
          if (checkHold(root) !== null) expire();
        });
      };

      /**
       * The caller's answer to a transaction a hold limit rolled back: it
       * waits for the body — which may still be awaiting — and then
       * rejects with `JD2098`, so a caller never runs beside its own body.
       * @param {any} out - value-or-promise of a top-level transaction
       * @returns {any}
       */
      const afterHeldBody = (out) => {
        if (!isThenable(out)) return out;
        return toPromise(out).catch((error) => {
          const body = heldBodies.get(error) ?? (error instanceof AggregateError ? heldBodies.get(error.errors[0]) : undefined);
          if (body === undefined) throw error;
          return body.then(() => { throw error; }, () => { throw error; });
        });
      };

      /**
       * @param {(store: any) => any} fn
       * @param {AbortSignal | undefined} signal
       * @param {any} ownWork
       * @param {'deferred' | 'immediate' | undefined} mode
       * @param {number | undefined} attempt
       * @param {number | undefined} holdTimeoutMs
       * @param {{ level: string, isolation: string | undefined, writerLock: boolean }} [begin]
       *   - what a `store.transaction` asks of its BEGIN (see `beginFor`);
       *   the store's own transactions pass none
       */
      let topLevelTransaction = (fn, signal, ownWork, mode, attempt, holdTimeoutMs, begin = undefined, via = opened) =>
        withScope((inner) => beginTransaction(inner, signal, mode, begin, via),
          (inner, identity) => holdAround(ctx().currentRoot, () => fn(scopedStore(inner, identity))), ownWork,
          { mode: mode ?? 'deferred', attempt, holdTimeoutMs, isolation: begin?.level });

      /**
       * Retry a transaction as a whole (MODEL-FORMAT §5.1): each attempt is
       * a complete top-level transaction through the gate — FIFO order, a
       * fresh queue wait, the same signal, a fresh unit of work — made only
       * after a failure whose commit outcome is known and that says it may
       * be retried (`class: 'busy'`, `retryable: true`): a lock or
       * serialization conflict. Never after a connection loss, a lost
       * generation, an ambiguous COMMIT (a `TransactionFailure`), a hold
       * expiry or the callback's own error. Between attempts the backoff is
       * the suite's (`@jarenjs/core/retry`, full jitter over the store's
       * random); an abort during it rejects with the signal's reason. The
       * error that ends it carries `attempts`.
       * @param {(attempt: number) => any} once
       * @param {{ attempts: number, baseMs: number, maxMs: number }} retry
       * @param {AbortSignal | undefined} signal
       * @returns {Promise<any>}
       */
      const retrying = async (once, retry, signal) => {
        for (let attempt = 1; ; attempt++) {
          try {
            return await once(attempt);
          }
          catch (error) {
            const safe = /** @type {any} */ (error)?.class === 'busy' && /** @type {any} */ (error)?.retryable === true
              && !(error instanceof AggregateError);
            if (!safe || attempt >= retry.attempts) {
              if (error !== null && typeof error === 'object' && Object.isExtensible(error))
                /** @type {any} */ (error).attempts = attempt;
              throw error;
            }
            await sleep(backoffDelay({ baseMs: retry.baseMs, maxMs: retry.maxMs, random: runtime.random }, attempt), signal);
          }
        }
      };

      /**
       * How a store-level call behaves when another caller holds the
       * connection — its transaction, or on an asynchronous host a
       * store-level call still in flight: `'wait'` queues behind it under
       * the connection's `queueTimeout`, `'strict'` refuses at once. A
       * host that would rather see the contention than pay for it asks
       * for strict; the default keeps a contended call correct instead of
       * fast.
       */
      // validated with the other options, before the driver opened
      const strictTransactions = options.transactions === 'strict';

      /** The refusal a contended store-level call gets when it cannot
       * wait. The gate cannot tell which kind of caller holds it, so the
       * message names both; it names the scope-bound spelling, because a
       * caller that meant to be inside a transaction has one and a caller
       * that did not has to wait for it either way. */
      const contended = (why) => new DbCompileError('JD0012',
        `another caller holds this store's connection — a transaction, or a store-level call still in flight — and ${why}. `
        + 'Work that belongs INSIDE a transaction goes through the store the callback received '
        + '(tx.collection / tx.entity / tx.saveChanges); work that does not belongs '
        + 'after it settles.');

      /**
       * Run one STORE-LEVEL call: a caller that is not inside whatever
       * transaction is open. It holds the connection for its own extent,
       * so its statements can never fall inside a stranger's transaction
       * and share a rollback it knows nothing about — the defect that
       * made "one store per concurrent writer" the only safe advice.
       *
       * Root jobs and worker control I/O take exactly this gate too:
       * an unrelated enqueue, claim, renewal or settlement waits for the
       * open transaction instead of joining its fate, and a `signal`
       * (a worker winding down) abandons a call still in the queue.
       * @param {() => any} fn
       * @param {string} [what] - what is waiting, for the timeout message
       * @param {AbortSignal} [signal]
       */
      const gatedOn = (/** @type {any} */ gate) => (/** @type {() => any} */ fn, /** @type {string | undefined} */ what,
        /** @type {AbortSignal | undefined} */ signal) => {
        refuseClosed();
        if (strictTransactions && (gate.wouldWait ?? gate.mustQueue))
          throw contended("{ transactions: 'strict' } refuses to queue behind it");
        return chain(ownerGuard(false), () => withScope((inner) => gate.exclusively((/** @type {any} */ admitted) => {
          ownerAdmitted();
          return inner(admitted);
        }, what, signal), fn));
      };
      const gated = gatedOn(opened);
      /**
       * A root call on the store's OWN unit of work — a root entity handle,
       * a tracked read, `saveChanges`, a root relational write: the gate
       * itself on a store with one session; on a store with several, the
       * first session, so the unit of work keeps one caller at a time.
       */
      const gatedWork = severalSessions ? ((pinned) => (/** @type {() => any} */ fn, /** @type {string | undefined} */ what,
        /** @type {AbortSignal | undefined} */ signal) => { refuseInsideTransaction(); return pinned(fn, what, signal); })(gatedOn(opened.pinned))
        : gated;

      /**
       * On a store with several sessions, a call on the store's own unit of
       * work made from inside a transaction would neither join it nor wait
       * for it, and which one happened would depend on the load: refused by
       * name instead.
       */
      function refuseInsideTransaction() {
        if (ctx().currentRoot === null) return;
        throw new DbCompileError('JD0012', "the store's own unit of work runs on its first session, apart from every "
          + 'transaction: a call on it from inside one would neither join that transaction nor wait for it. Inside the '
          + 'transaction use the store the callback received (tx.entity / tx.saveChanges); otherwise call it after it settles.');
      }

      const cursorOwnership = opened.capabilities.cursorTransaction === true
        ? { holdMs: opened.capabilities.cursorLifetimeMs, owners: new Set(), max: opened.capabilities.maxCursors } : undefined;
      /**
       * On several sessions, a cursor and the gate it is admitted through,
       * both re-entering the call that holds its session: the cursor's own
       * steps — its pulls, its lifetime timer, an abort's release — run
       * there, whoever makes them. @param {any} cursor @param {any} gate
       */
      const holdingSession = (cursor, gate) => {
        /** @type {any} */
        let holder;
        const recording = (/** @type {() => any} */ fn, /** @type {string | undefined} */ label,
          /** @type {AbortSignal | undefined} */ abort) => gate(() => { holder = opened.context(); return fn(); }, label, abort);
        const within = (/** @type {() => any} */ fn) => (holder === undefined ? fn() : opened.enter(holder, fn));
        /** @type {any} */
        const entered = {
          streaming: cursor.streaming,
          barrier: cursor.barrier,
          get settled() { return cursor.settled; },
          next: () => within(() => cursor.next()),
          return: (/** @type {any} */ value) => within(() => cursor.return(value)),
        };
        return { cursor: entered, gate: recording };
      };
      const admitCursorOn = (/** @type {any} */ gate) => (/** @type {any} */ cursor, /** @type {AbortSignal | undefined} */ signal,
        /** @type {string} */ what) => {
        const admitted = severalSessions ? holdingSession(cursor, gate) : { cursor, gate };
        return admitCursor(admitted.cursor, admitted.gate, signal, what, cursorOwnership);
      };
      const admitRootCursor = admitCursorOn(gated);
      /** A tracked root cursor: its pulls register in the store's own unit of work. */
      const admitWorkCursor = severalSessions ? admitCursorOn(gatedWork) : admitRootCursor;

      /**
       * Run `fn` inside one PARALLEL read (`reads: 'parallel'`): on a
       * reader of the pool's own, in one read transaction — a committed
       * snapshot — instead of the gate above. It never waits for an open
       * transaction and never joins one, so `transactions: 'strict'`,
       * which is about queueing behind a transaction, has nothing to
       * refuse here; the owner lease is asked first, as every admission
       * asks it, and its renewal (an exclusive write) runs before the read
       * begins, outside it.
       * @param {(enter: (next: () => any) => any) => any} fn
       * @param {string} [what]
       * @param {AbortSignal} [signal]
       * @param {boolean} [held] - a cursor's read, held across its pulls
       */
      const share = (fn, what, signal, held = false) => {
        refuseClosed();
        return chain(ownerGuard(false), () => opened.shared(fn, what, signal, held));
      };
      /**
       * A CLASSIFIED root read — one that reads committed state and
       * retains nothing: a collection's reads, an untracked entity read,
       * a document query, a relational read. Parallel on a store that
       * reads in parallel, the exclusive gate otherwise. A tracked read
       * registers what it read in the unit of work and keeps the gate.
       * @param {() => any} fn
       * @param {string} [what]
       * @param {AbortSignal} [signal]
       */
      const gatedRead = (fn, what, signal) => (options.reads === 'parallel'
        ? share(() => { ownerAdmitted(); return fn(); }, what, signal)
        : gated(fn, what, signal));
      /** The cursors holding a parallel read right now; close gives them back. */
      const sharedCursors = new Set();
      /** A classified root cursor: one parallel read across its pulls, or
       * the gate per pull. */
      const admitReadCursor = (cursor, signal, what) => (options.reads === 'parallel'
        ? shareCursor(cursor, share, signal, what, sharedCursors, () => ownerGuard(false), ownerAdmitted)
        : admitRootCursor(cursor, signal, what));

      /** The synchronous surface's gate. It cannot wait — waiting hands
       * a Promise back under a value's type — so a contended call is a
       * refusal whatever the mode. */
      const gatedSync = (fn) => {
        refuseClosed();
        if (opened.mustQueue) {
          throw contended('the synchronous surface answers values, so it cannot '
            + 'wait for the commit');
        }
        ownerGuard(true);
        return withScope(opened.exclusively, fn);
      };

      // ————— the rejection boundary around an ACQUIRED connection —————
      // Initialization continues for a long way past `driver.open`:
      // pragmas, shape verification, capture, jobs, readiness. Every one
      // of those can refuse, and a refusal that walks away from the open
      // handle leaks it — on Windows the database file simply stays
      // locked, which is how three of these showed up as `EPERM` while
      // a temporary directory was being removed. So: close exactly once
      // on any failure after acquisition, and keep the initialization
      // error primary — a close that also fails is retained beside it
      // rather than replacing the reason the open was refused.
      let closed = false;
      /**
       * Release the handle and re-reject with the original failure.
       * @param {any} error
       * @returns {Promise<never>}
       */
      const failClosed = (failure) => {
        // a driver failure inside the open sequence (a locked or corrupt
        // file, an unopenable path) is the open's refusal, classed; a
        // coded refusal or API misuse is itself
        const error = isDriverError(failure) ? openFailure(failure) : failure;
        if (closed) return Promise.reject(error);
        closed = true;
        /** @param {any} closeError */
        const both = (closeError) => Promise.reject(new AggregateError([error, closeError],
          'the store failed to open, and closing the acquired connection failed too'));
        let closing;
        try {
          // a lease the open took is given back first (best effort, never
          // throwing): on PostgreSQL before the session returns to its pool
          // — or destroyed with it, when the release could not run
          closing = chain(ownerLease === null ? null : ownerLease.release(), () =>
            opened.close(ownerLease?.holds() === true ? { discard: true } : undefined));
        }
        catch (closeError) {
          return both(closeError);
        }
        return isThenable(closing)
          ? closing.then(() => Promise.reject(error), both)
          : Promise.reject(error);
      };
      const dialect = connection.dialect;

      // ————— isolation (MODEL-FORMAT §5.1) —————
      // The levels this backend runs, weakest first, and the level a
      // transaction that asks for none runs: the session's own default,
      // read at open (SQLite's one level; PostgreSQL's
      // `default_transaction_isolation`, which an operator may have raised).
      const isolationLevels = Object.freeze([...(dialect.tx.isolationLevels ?? ['serializable'])]);
      const sessionIsolation = connection.capabilities.postgres?.defaultIsolation ?? isolationLevels[0];
      const rankOf = (/** @type {string} */ level) => ISOLATION_LEVELS.indexOf(level);
      /**
       * What a `store.transaction` asks of its BEGIN. The level asked for is
       * a FLOOR: the session's stronger default wins over it, and a backend
       * that cannot run a level runs the next stronger one it can. Nothing
       * asked keeps the plain `BEGIN` (and the session's default); a level
       * asked is spelled only where the dialect runs more than one.
       * `writerLock` takes the store's writer lock for `mode: 'immediate'`
       * where that is a statement of its own — the store's own transactions
       * never take it: they chose `'immediate'` for SQLite's read→write
       * upgrade, which PostgreSQL does not have.
       * @param {string | undefined} requested
       * @param {'deferred' | 'immediate' | undefined} mode
       */
      const beginFor = (requested, mode) => {
        const writerLock = mode === 'immediate';
        if (requested === undefined) return { level: sessionIsolation, isolation: undefined, writerLock };
        const floor = rankOf(requested) > rankOf(sessionIsolation) ? requested : sessionIsolation;
        const level = isolationLevels.find((candidate) => rankOf(candidate) >= rankOf(floor))
          ?? isolationLevels[isolationLevels.length - 1];
        return { level, isolation: dialect.tx.beginAt === undefined ? undefined : level, writerLock };
      };
      // The PHYSICAL MAPPING BRANCH for derived index columns. A driver
      // that can index a registered deterministic function generates
      // them; one that cannot has the store write them. It is a
      // property of the driver that created the file, so a database
      // built under one and opened under the other legitimately reports
      // drift — that is a migration, not an open.
      const registersFunctions =
        connection.capabilities.deterministicIndexableFunctions === true;
      const derivedMapping = registersFunctions ? 'virtual' : 'stored';
      // the SECOND physical branch, and the same posture: a build
      // without the R*Tree module maps `physical: 'rtree'` back onto
      // the B-tree over the four columns and SAYS so through
      // `explain().prefilters[].via` (MODEL-FORMAT §4). Refusing at open
      // would break the format's stated portability promise; a silent
      // fallback would break its stated honesty one
      const rtreeCapable = connection.capabilities.rtree === true;
      /** @type {Map<string, any>} */
      const plans = new Map();
      /** @type {Map<string, any>} */
      const entityPlans = new Map();
      // Planning can REFUSE — a derived index over a member the schema
      // does not type as geography is JD0004 here, not at normalization,
      // because the physical mapping it plans is a property of the
      // driver that opened the connection. It is inside the boundary
      // for that reason: the refusal is raised after acquisition.
      try {
        for (const [name, collection] of collections)
          plans.set(name, planCollection(name, collection, dialect,
            { derived: derivedMapping, rtree: rtreeCapable,
              expressions: options.expressions, registered: registersFunctions }));
        if (mapping !== null) {
          for (const name of Object.keys(mapping.entities))
            entityPlans.set(name, planEntity(name, mapping.entities[name], mapping, dialect));
          for (const joinName of Object.keys(mapping.joinTables)) {
            entityPlans.set(joinName,
              planJoinTable(joinName, mapping.joinTables[joinName], mapping, dialect));
          }
        }
      }
      catch (error) {
        return failClosed(error);
      }
      // a table whose column expression calls a function this connection
      // has not registered cannot even be SELECTed (probed), so the
      // registration precedes every statement over it. Only a VIRTUAL
      // derived column needs one: a vector column is stored on every
      // driver and a model with nothing else registers nothing
      const needsDeriveFunctions = derivedMapping === 'virtual'
        && [...plans.values()].some((plan) => plan.generated.some(
          (column) => column.derive !== undefined && column.stored !== true));
      // A table whose column expression calls a declared function cannot
      // be SELECTed from — let alone written to — by a connection that
      // has not registered it, so the registration precedes every
      // statement over it. Only where this connection COMPUTES the
      // expression: where the engine calls its own immutable function
      // there is nothing to register.
      const expressionNames = registersFunctions
        ? [...new Set([...plans.values()].flatMap((plan) =>
          plan.expressions.flatMap((entry) => entry.functions)))].sort()
        : [];

      /** The effective connection pragmas, read back after the open
       * sequence applied them — what the capability report carries.
       * @type {any} */
      let effectivePragmas = null;
      // the closed configuration set, applied in table order and then
      // read back in full (JD0007 for a pragma this binding cannot
      // apply, JD0008 for one the engine did not take); then referential
      // integrity, which is real only when the pragma is ON — it
      // defaults off, so it is set AND verified per connection. Built
      // inside `opening` so a synchronous refusal reaches `failClosed`
      const pragmas = () => chain(configurePragmas(connection, pragmaRequests), (effective) => {
        effectivePragmas = effective;
        // an engine that always enforces referential integrity has no
        // switch to set and nothing to read back; SQLite's defaults OFF,
        // so there it is set AND verified per connection
        if (dialect.capabilities.foreignKeysAlwaysOn === true) return null;
        return chain(connection.exec(dialect.pragma.foreignKeys(true)), () =>
          chain(connection.prepare(dialect.introspect.foreignKeysOn()), (statement) =>
            chain(statement.get([]), (row) => {
              if (Number(row?.enabled) !== 1) {
                throw new DbCompileError('JD0003',
                  'this connection cannot enforce foreign keys (PRAGMA foreign_keys stayed off)');
              }
              return null;
            })));
      });

      // what a store that creates no table is, for the JD0002 refusal
      const createsNothing = readOnly ? 'a read-only store'
        : options.adopt === true ? 'an adopted store ({ adopt: true })' : null;
      // ————— the owner lease (MODEL-FORMAT §5.1) —————
      // taken before any table of the model is created or verified, so a
      // refused owner changes nothing; read-only stores never ask (refused
      // before the driver opened)
      const acquireOwner = () => {
        if (ownerOption === undefined) return null;
        // a retried open (a busy journal-mode switch) takes it again as the
        // same holder, never as a second one
        ownerLease ??= createOwnerLease({
          dialect, connection, owner: ownerOption, adopt: options.adopt === true, now: runtime.now,
          bracket: (fn) => immediately(connection, fn),
          // the store gate, waiting whatever `transactions` says: a renewal
          // is the store's own write, never a caller's, and may take the
          // gate's next turn and wait for the holder however long it holds
          // on a store with several sessions, the first: the lock is its session's
          exclusively: severalSessions ? (fn, what, options) => opened.pinned.exclusively(fn, what, options?.signal)
            : (fn, what, options) => opened.exclusively(fn, what, options?.signal,
              options?.first === true, options?.unbounded === true),
          // never from inside a transaction's own synchronous body
          renewsInline: () => ctx().currentRoot === null || opened.mustQueue,
          // on a store with several sessions the lock lives on the first one,
          // and the others must not outlive it
          lost: severalSessions ? () => opened.primary.lost() : undefined,
        });
        return ownerLease.acquire();
      };
      // `reads: 'parallel'` needs readers to run on: the pool host's, and
      // only once it opened them (a writable pool on `:memory:` or with
      // `readers: 0` has none; every worker of a read-only pool reads)
      const refuseParallelReadsHere = () => {
        if (options.reads !== 'parallel' || (opened.shared !== null && opened.shared !== undefined
          && Number(opened.capabilities.poolReaders) > 0)) return;
        throw new DbCompileError('JD0009', "openStore option 'reads' is 'parallel' only on a pool host "
          + `with readers (@jarenjs/db/node-pool on a file); this store's driver '${options.driver.name}'`
          + `${opened.capabilities.pooling === true ? ' opened no reader' : ' has no readers'}`);
      };
      const opening = () => { refuseParallelReadsHere(); return openSequence(); };
      const openSequence = () => chain(pragmas(), () =>
        chain(acquireOwner(), () =>
        chain(registerExpressionFunctions(connection, expressionNames,
          options.expressions ?? {}), () =>
        chain(needsDeriveFunctions ? registerDeriveFunctions(connection) : null, () =>
        chain(ensureShape(connection, collections, plans, createsNothing), () =>
        chain(ensureEntityShape(connection, entityPlans, entities, createsNothing), () => {
          // ————— change capture (LIVE-FORMAT §§1–6) —————
          const captureOption = options.capture ?? (options.replication === undefined ? undefined : true);
          const captureRequested = captureOption === true
            ? {}
            : (captureOption === undefined || captureOption === false
              ? null : captureOption);
          if (options.replication !== undefined && (captureRequested === null || readOnly))
            throw new TypeError('replication requires a writable store with capture enabled');
          let captureMode = 'none';
          if (captureRequested !== null) {
            const wanted = captureRequested.mode ?? 'auto';
            // Capture requires a qualified backend, even where log SQL
            // can already be emitted through the dialect.
            if (connection.capabilities.changeCapture !== true
              || (options.replication !== undefined && connection.capabilities.replication === false)) {
              throw new DbCompileError('JD0051',
                `${options.replication === undefined ? 'change capture' : 'replication'} is unavailable on this driver`);
            }
            const hasSessions = connection.capabilities.sessions === true
              && typeof connection.session === 'function';
            if (wanted === 'session' && !hasSessions) {
              throw new TypeError(
                "capture mode 'session' is unavailable on this driver "
                + '(Node worker/pool/process hosts, bun:sqlite and some wasm builds do not expose sessions) — '
                + "use mode 'journal' or 'auto'");
            }
            captureMode = wanted === 'auto'
              ? (hasSessions ? 'session' : 'journal')
              : wanted;
          }
          if (options.replication !== undefined && captureMode === 'journal'
            && Object.values(mapping?.entities ?? {}).some((entity) => entity.foreignKeys.some((fk) => fk.onDelete !== 'restrict')))
            throw new DbCompileError('JD0051', 'journal replication cannot capture cascading or set-null child relations; use session capture');
          const captureShapes = new Map();
          if (captureMode !== 'none') {
            for (const [collectionName, plan] of plans) {
              captureShapes.set(plan.table ?? collectionName, {
                kind: 'collection',
                columns: [
                  { name: plan.keyColumn, role: 'key' },
                  { name: plan.docColumn, role: 'doc' },
                ],
                keyIndexes: [0],
                docIndex: 1,
              });
            }
            for (const [entityName, entity] of (mapping === null ? [] : entities)) {
              const em = mapping.entities[entityName];
              const fkNames = new Set(em.foreignKeys.map((fk) => fk.column));
              const columns = [];
              for (const column of em.columns) {
                if (fkNames.has(column.name)) continue;
                columns.push({
                  name: column.name,
                  role: column.key ? 'key'
                    : column.source === 'epoch(document)' ? 'epoch' : 'scalar',
                  storage: column.storage,
                });
              }
              for (const fk of em.foreignKeys)
                columns.push({ name: fk.column, role: 'fk' });
              columns.push({ name: 'doc', role: 'doc' });
              captureShapes.set(entityName, {
                kind: 'entity',
                columns,
                keyIndexes: em.keys.map((key) =>
                  columns.findIndex((column) => column.name === key)),
                docIndex: columns.length - 1,
                relationNames: [...entity.properties.values()]
                  .filter((property) => property.relation !== undefined)
                  .map((property) => property.name),
              });
            }
            for (const joinName of Object.keys(mapping?.joinTables ?? {})) {
              const join = mapping.joinTables[joinName];
              const columns = [join.left, join.right]
                .map((side) => ({ name: side.column, role: 'key' }));
              captureShapes.set(joinName, {
                kind: 'join', columns,
                keyIndexes: columns.map((_, i) => i), docIndex: -1,
              });
            }
          }
          // a session changeset carries values in the PHYSICAL column
          // order; a column added by `ALTER TABLE … ADD COLUMN` sits after
          // `doc`, so the planned order misread every later value. Align
          // each entity shape to the table as it stands (a shape the
          // table does not match by name keeps the planned order)
          const alignShapes = (names, i = 0) => (i >= names.length ? null
            : chain(connection.prepare(dialect.introspect.columns(names[i])), (statement) =>
              chain(statement.all([]), (rows) => {
                const shape = captureShapes.get(names[i]);
                const byName = new Map(shape.columns.map((column) => [column.name, column]));
                const physical = rows.filter((row) => Number(row.hidden) === 0)
                  .map((row) => String(row.name));
                if (physical.length === shape.columns.length
                  && physical.every((columnName) => byName.has(columnName))) {
                  const keyNames = shape.keyIndexes.map((index) => shape.columns[index].name);
                  shape.columns = physical.map((columnName) => byName.get(columnName));
                  shape.keyIndexes = keyNames.map((key) => physical.indexOf(key));
                  shape.docIndex = physical.indexOf('doc');
                }
                return alignShapes(names, i + 1);
              })));
          const aligned = captureMode === 'session'
            ? alignShapes([...captureShapes.keys()]
              .filter((table) => captureShapes.get(table).kind === 'entity'))
            : null;
          // every first-open object — the change log and its state row
          // here, the job tables below — is created or verified under
          // the same immediate bracket as the collections' shape, so two
          // processes opening one fresh file cannot race the seed row or
          // a column upgrade; a read-only store creates nothing and takes
          // no lock
          const firstOpen = readOnly ? (fn) => fn() : (fn) => immediately(connection, fn);
          let replicationEngine = null;
          // the engine is built only once the shapes are aligned: it
          // decodes by position from its first write
          /** @type {any} */
          let capture = null;
          const captureReady = chain(aligned, () => {
            capture = captureMode === 'none' ? null : createCaptureEngine({
              connection,
              bracket: firstOpen,
              shapes: captureShapes,
              mode: captureMode,
              log: captureRequested.log === true
                || (captureRequested.log !== undefined && captureRequested.log !== false),
              retention: captureRequested.log?.retention ?? DEFAULT_RETENTION,
              now: runtime.now,
              beforeCommit: (patch, context) => replicationEngine?.commit(patch, context),
              // on a store with several sessions, each transaction's capture scope is its context's
              ...(severalSessions ? { stateOf: () => (/** @type {any} */ (ctx()).capture
                ??= { depth: 0, generation: 0, context: null, session: null, journal: [] }) } : {}),
            });
            return capture === null ? null : capture.ready;
          });
          // Finish capture's first-open transaction before constructing the
          // jobs engine, whose constructor starts another first-open bracket.
          // Awaiting both at the end lets asynchronous hosts overlap BEGINs.
          return chain(captureReady, () => {
          /** @type {Map<string, any>} */
          const cores = new Map();
          const coreFor = (name) => {
            let core = cores.get(name);
            if (core === undefined) {
              const collection = collections.get(name);
              if (collection === undefined) {
                throw new DbRuntimeError('JD2004',
                  `the model declares no collection '${name}'`,
                  { docPath: '/collections', collection: name });
              }
              const validate = options.compileSchema !== undefined
                ? options.compileSchema(collection.schema)
                : null;
              if (validate !== null && typeof validate !== 'function')
                throw new TypeError('openStore: compileSchema must return a validation function');
              core = captureCollection(name, collectionCore(connection, collection,
                plans.get(name), validate, queryState,
                { profile: storeProfile, roots: declaredRoots }, runtime));
              cores.set(name, core);
            }
            return core;
          };

          // the capture scope around a write runs statements of its own
          // (a session's changeset read, the journal's old-row read, the
          // log's allocation); a driver failure there is classified as
          // the write's would be
          const guard = capture === null
            ? (fn) => fn()
            : (fn) => attempt(() => capture.wrap(fn),
              (error) => wrapDriverError(error, { docPath: '/capture' }));
          if (capture !== null) {
            // capture changes how records are TRANSLATED, never queue
            // cancellation or tracker ownership: the replacement has the
            // ordinary function's exact signature and forwards `signal`
            // and `ownWork`, with `capture.nest` inside the opened scope.
            // The view is built from the scope capture's wrap opens —
            // the INNERMOST one, the exact scope the callback runs in.
            // The hold clock starts inside capture's scope: what capture does
            // before the body (PostgreSQL's journal takes its advisory lock
            // there) is a wait, and a wait never counts against the limit.
            topLevelTransaction = (fn, signal, ownWork, mode, attempt, holdTimeoutMs, begin = undefined, via = opened) =>
              withScope((inner) => beginTransaction(inner, signal, mode, begin, via),
                () => capture.nest((innerScope, identity) =>
                  holdAround(ctx().currentRoot, () => fn(scopedStore(innerScope, identity)))),
                ownWork, { mode: mode ?? 'deferred', attempt, holdTimeoutMs, isolation: begin?.level });
            abandonCapture = () => capture.abandon();
          }
          // the live registry rides the capture stream; its dispatcher
          // registers FIRST so maintenance sees every record before any
          // user observer can commit a further write (LIVE-FORMAT §8)
          const resnapshotEnabled = capture?.logged && connection.capabilities.lazyIteration === true
            && typeof options.live?.resnapshot === 'function';
          const liveRegistry = capture === null ? null : createLiveRegistry({
            maxQueries: options.live?.maxQueries ?? LIVE_DEFAULTS.maxQueries,
            maxMaintained: options.live?.maxMaintained ?? LIVE_DEFAULTS.maxMaintained,
            maxBytes: options.live?.maxBytes ?? LIVE_DEFAULTS.maxBytes,
            resnapshot: options.live?.resnapshot,
          });
          if (capture !== null) {
            capture.observe((record) => /** @type {any} */ (liveRegistry).deliver(record));
          }
          // the durable job queue (JOBS-FORMAT), opt-in per store
          const jobsRequested = options.jobs === true
            || (options.jobs !== undefined && options.jobs !== false);
          if (jobsRequested && connection.capabilities.jobs !== true) {
            throw new DbCompileError('JD0003',
              'the durable job queue is unavailable on this driver: it declares no job '
              + 'queue strategy');
          }
          const jobsEngine = !jobsRequested ? null : createJobEngine({
            connection,
            adopt: options.adopt === true,
            bracket: firstOpen,
            // the WORKER's control-plane I/O (claims, renewals, its
            // checkpoint stores, its settlements) is root-owned and takes
            // the store gate, so it can never join an open application
            // transaction; `tx.jobs` bypasses this by running as the
            // exact scope, which is the transactional-outbox spelling
            gate: (fn, what, signal) => gated(fn, what, signal),
            now: typeof options.jobs === 'object' ? options.jobs.now : undefined,
            random: typeof options.jobs === 'object' ? options.jobs.random : undefined,
            defaults: typeof options.jobs === 'object' ? options.jobs : undefined,
            runtime,
          });
          /** Register a collection live query (LIVE-FORMAT §7). */
          const liveSnapshot = (document, liveOptions, name = undefined) => {
            if (connection.synchronous === true && liveOptions?.mode !== 'resnapshot') return {};
            if (!resnapshotEnabled) {
              throw new DbCompileError('JD0051',
                'resnapshot live queries require durable capture, lazy iteration and asyncLive() from @jarenjs/db/async-live');
            }
            if (liveOptions?.eventTime !== undefined)
              throw new DbCompileError('JD0053', 'resnapshot mode has no incremental event-time watermark');
            return { classification: { strategy: 'resnapshot', reason: 'durable-feed asynchronous resnapshot' },
              snapshot: {
                snapshotContext: { connection, document, externals: liveOptions?.externals ?? {},
                  ...(name === undefined ? { entities, mapping }
                    : { collection: collections.get(name), physicalPlan: plans.get(name) }),
                  profile: storeProfile, roots: declaredRoots, operators, zoneProvider, now: runtime.now },
                feed: { bounds: capture.bounds, page: capture.page },
                run: (read, signal, initial) => initial
                  ? connection.transaction(read)
                  // A snapshot takes the root transaction gate without opening
                  // a write journal or holding its writer serialization lock.
                  : withScope((inner) => beginTransaction(inner, signal), read),
              } };
          };
          const registerCollectionLive = (core, document, liveOptions) => {
            const externals = liveOptions?.externals ?? {};
            const keyed = core.model.keySegments !== null;
            const eventTime = normalizeEventTime(liveOptions, core.model.name);
            const classification = liveOptions?.mode === 'rerun'
              ? { strategy: 'rerun', reason: 'rerun was requested' }
              : classifyLiveQuery(document, core.queryShape, keyed, eventTime);
            return closeOnRollback(/** @type {any} */ (liveRegistry).register({
              name: core.model.name,
              tables: new Set([core.model.name]),
              document,
              externals,
              demanded: liveOptions?.mode,
              classification,
              execute: (doc, executeOptions) => core.execute(doc, executeOptions),
              readRow: (token) => core.get(token),
              rowPosition: (token) => createLogicalRows({ connection, shapes: captureShapes, capture,
                collectionCore: coreFor, entityCore: entityCoreFor }).position(core.model.name, token),
              keyOf: (doc) => String(extractKey(doc, core.model.keySegments,
                core.model.key, core.model.name, core.model.docPath)),
              ...liveSnapshot(document, liveOptions, core.model.name),
            }));
          };
          /** A live query registered INSIDE a transaction initialized from
           * that transaction's rows; if the transaction rolls back, those
           * rows never existed and the query is closed with them rather
           * than left maintaining a result nothing committed. Registered
           * at the root, the scope settles at once and nothing is owed. */
          const closeOnRollback = (registered) => chain(registered, (live) => {
            connection.onSettle({ rollback: () => live.close() });
            return live;
          });
          /** Strip relation members before journal diffs — sessions
           * never see them (they are not stored), so the two modes
           * stay identical. */
          const stripRelations = (entityName, doc) => {
            if (doc === null || doc === undefined) return doc;
            const names = captureShapes.get(entityName)?.relationNames;
            if (names === undefined || names.length === 0) return doc;
            const out = { ...doc };
            for (const name of names) delete out[name];
            return out;
          };
          /** Journal mode cannot see ON DELETE CASCADE side effects;
           * the ONE store-shaped case — join-table membership dying
           * with its entity — is read and recorded before the delete.
           * Deeper cascades (child rows) stay documented-invisible. */
          const captureJoinDelete = capture === null || capture.mode !== 'journal'
            ? null
            : (entityName, keyParts) => {
              const joins = Object.entries(mapping?.joinTables ?? {})
                .filter(([, join]) => join.left.entity === entityName
                  || join.right.entity === entityName);
              const nextJoin = (i) => {
                if (i >= joins.length) return null;
                const [joinName, join] = joins[i];
                const columns = [join.left.column, join.right.column];
                const own = join.left.entity === entityName ? join.left : join.right;
                const sql = `SELECT ${columns.map(dialect.quoteIdentifier).join(', ')} `
                  + `FROM ${dialect.quoteIdentifier(joinName)} `
                  + `WHERE ${dialect.quoteIdentifier(own.column)} = ${dialect.parameterRef(1, 'v')}`;
                const boundedRows = () => {
                  const { maxOperations = REPLICATION_DEFAULTS.maxOperations, maxBytes = REPLICATION_DEFAULTS.maxBytes } = options.replication;
                  const cursor = createCursor({ streaming: 'row', barrier: null,
                    open: () => chain(connection.prepare(`${sql} LIMIT ${dialect.parameterRef(2, 'v')}`), (statement) => statement.iterate([keyParts[0], maxOperations + 1])),
                    items: (row) => [row] });
                  return chain(drainPage(cursor, { limit: maxOperations, maxBytes,
                    sizeOf: (row) => utf8Length(JSON.stringify(row)), continuationOf: () => null }), (page) => {
                    if (page.hasMore) throw new DbRuntimeError('JD2106', 'membership cascade exceeds replication capacity');
                    return page.items;
                  });
                };
                return chain(options.replication === undefined
                  ? chain(connection.prepare(sql), (statement) => statement.all([keyParts[0]])) : boundedRows(), (rows) => {
                    for (const row of rows) {
                      capture.record(joinName, columns.map((column) => row[column]), undefined, null);
                    }
                    return nextJoin(i + 1);
                  });
              };
              return nextJoin(0);
            };
          /** The document a keyed `put` replaces, for the journal's
           * before-image: resolved through the collection's own key when
           * the caller passed none — a plain upsert recorded as an
           * `add` of the whole document, and a no-op put as a record. */
          const readBefore = (core, doc, key) => {
            const resolved = key !== undefined ? key
              : core.model.keySegments !== null
                ? extractKey(doc, core.model.keySegments, core.model.key,
                  core.model.name, core.model.docPath)
                : undefined;
            return resolved === undefined ? undefined : core.get(resolved);
          };
          /** Journal-mode write wrappers for a collection core. */
          const captureCollection = (collectionName, core) => {
            if (capture === null) return core;
            const journal = capture.mode === 'journal';
            // a write's options are refused (JD0013) before the capture
            // transaction begins — never as a busy wait for a write lock the
            // write would not have used — and then ride through to the core
            return {
              ...core,
              insert: (doc, options) => {
                readWriteOptions(collectionName, options, 'insert', false);
                return guard(() => chain(core.insert(doc, options), (key) => {
                  if (journal) capture.record(collectionName, [key], null, doc);
                  return key;
                }));
              },
              put: (doc, key, options) => {
                readWriteOptions(collectionName, options, 'put', true);
                return guard(() => (journal
                  ? chain(readBefore(core, doc, key), (before) =>
                    chain(core.put(doc, key, options), (storedKey) => {
                      capture.record(collectionName, [storedKey], before ?? null, doc);
                      return storedKey;
                    }))
                  : core.put(doc, key, options)));
              },
              patch: (key, ops, options) => {
                readWriteOptions(collectionName, options, 'patch', true);
                return guard(() => (journal
                  ? chain(core.get(key), (before) =>
                    chain(core.patch(key, ops, options), (after) => {
                      // a patch that changed nothing wrote nothing, and records nothing
                      if (!equalsJson(before, after)) capture.record(collectionName, [key], before ?? null, after);
                      return after;
                    }))
                  : core.patch(key, ops, options)));
              },
              delete: (key, options) => {
                readWriteOptions(collectionName, options, 'delete', true);
                return guard(() => (journal
                  ? chain(core.get(key), (before) =>
                    chain(core.delete(key, options), (deleted) => {
                      if (deleted && before !== undefined)
                        capture.record(collectionName, [key], before, null);
                      return deleted;
                    }))
                  : core.delete(key, options)));
              },
            };
          };
          /** Journal-mode write wrappers for an entity core. */
          const captureEntity = (entityName, core) => {
            if (capture === null) return core;
            const journal = capture.mode === 'journal';
            const keysOf = (doc) => core.plan.keys.map((key) => doc[key]);
            return {
              ...core,
              create: (doc) => guard(() => chain(core.create(doc), (made) => {
                if (journal) {
                  capture.record(entityName, keysOf(made), null,
                    stripRelations(entityName, made));
                }
                return made;
              })),
              update: (key, changes) => guard(() => (journal
                ? chain(core.get(key), (before) =>
                  chain(core.update(key, changes), (next) => {
                    capture.record(entityName, keysOf(next),
                      stripRelations(entityName, before ?? null),
                      stripRelations(entityName, next));
                    return next;
                  }))
                : core.update(key, changes))),
              delete: (key) => guard(() => (journal
                ? chain(captureJoinDelete(entityName, core.normalizeKey(key)), () =>
                  chain(core.get(key), (before) =>
                    chain(core.delete(key), (deleted) => {
                      if (deleted && before !== undefined) {
                        capture.record(entityName, core.normalizeKey(key),
                          stripRelations(entityName, before), null);
                      }
                      return deleted;
                    })))
                : core.delete(key))),
            };
          };

          // the maintenance operations over this connection; the store
          // gates each call below, exactly as a root write is gated
          const maintenance = createMaintenance({ connection, readOnly, now: runtime.now });
          // the online backup over the same connection: its checkpoint
          // boundary takes the gate, its copy runs off it
          const backup = createBackup({
            connection, readOnly, gated, checkpoint: maintenance.checkpoint, random: runtime.random,
            now: runtime.now,
          });

          const capabilities = Object.freeze({
            ...connection.capabilities,
            // `mode: 'immediate'` takes the store's writer lock before the
            // body runs (MODEL-FORMAT §5.1) — SQLite's `BEGIN IMMEDIATE`,
            // PostgreSQL's advisory lock after `BEGIN`
            immediateTransactions: dialect.capabilities.immediateTransactions === true,
            // the isolation levels a transaction can run here, weakest
            // first; a level asked for is a floor (`tx.isolation` reports
            // the one that ran)
            isolation: isolationLevels,
            // how this store owns its database: 'none', 'lease' (SQLite's
            // engine-table row) or 'session' (PostgreSQL's session lock)
            owner: ownerLease === null ? 'none' : ownerLease.mode,
            // how classified root reads are admitted: 'parallel' on a pool's
            // readers, each in a committed snapshot of its own, or
            // 'serialized' through the one gate every other call takes
            parallelReads: options.reads === 'parallel' ? 'parallel' : 'serialized',
            // the sessions root calls and transactions run on, each one call
            // at a time (`sessions`; 1 unless the open asked for more)
            connections: severalSessions ? opened.sessions.length : 1,
            // per-operation availability: the binding's declaration, and
            // for the two that write the store's read-only flag — `false`
            // exactly where a call is refused (`JD2077`)
            maintenance: Object.freeze({ ...maintenance.capabilities, backup: backup.capability }),
            // where a cancellation takes effect, per lifecycle — the
            // granularity the driver actually has. `midStatement` is a
            // filled slot, not an absent one: no shipped SQLite binding
            // exposes an interrupt, and a driver that grows one flips
            // exactly this member
            cancellation: Object.freeze({
              query: 'row', queue: true, migration: 'step', maintenance: 'statement',
              backup: 'page', midStatement: false,
            }),
            validated: options.compileSchema !== undefined,
            // the effective connection configuration, read back after the
            // open sequence applied it: every pragma of the closed set by
            // option name, `null` where the binding declares the pragma
            // absent or the engine answers nothing (a memory database's
            // `mmapSize`)
            pragmas: effectivePragmas,
            // the two long-published members, sourced from that same
            // read-back — never from the request
            busyTimeoutMs: effectivePragmas.busyTimeout,
            journalMode: effectivePragmas.journalMode,
            readOnly,
            profiled: storeProfile !== null,
            // the registered operator vocabulary (Ring 2): the names a
            // query may use; they run in the residual by default
            operators: operators === null
              ? Object.freeze([])
              : Object.freeze(Object.keys(operators.extensions)),
            // the subset this driver actually pushes into SQL as
            // deterministic UDFs (Ring 3): `pushable:'scalar'` operators
            // when the driver has user functions; `[]` on bun:sqlite
            // (no UDF API — always the residual) and without a registry
            pushableOperators: operators === null || connection.capabilities.userFunctions !== true
              ? Object.freeze([])
              : Object.freeze([...operators.pushableScalar]),
            // The injected clock: whether a temporal spec naming a
            // ZONE will compile at all here. Without one the document is
            // refused (`JQ0003`) rather than answered in UTC, and a
            // consumer that wants to know before it asks reads this
            zoneProvider: zoneProvider !== undefined && zoneProvider !== null,
            capture: captureMode,
            captureLog: captureMode !== 'none'
              && (captureRequested.log === true
                || (captureRequested.log !== undefined && captureRequested.log !== false)),
            live: captureMode !== 'none' && (connection.synchronous === true || resnapshotEnabled),
            liveModes: Object.freeze(captureMode === 'none' ? [] : [
              ...(connection.synchronous === true ? ['incremental', 'rerun'] : []),
              ...(resnapshotEnabled ? ['resnapshot'] : []),
            ]),
            dataVersion: typeof dialect.introspect.dataVersion === 'function',
            jobs: options.jobs === true
              || (options.jobs !== undefined && options.jobs !== false),
          });

          const queryState = createQueryState(options.statementCacheBound, operators,
            zoneProvider, runtime.now);
          const entityEngine = entities.size > 0
            ? createEntityQueryEngine({ connection, entities, mapping, state: queryState,
              profile: storeProfile, roots: declaredRoots })
            : null;
          /** @type {Map<string, any>} */
          const loadEngines = new Map();
          const loadEngineFor = (name) => {
            let engine = loadEngines.get(name);
            if (engine === undefined) {
              if (!entities.has(name)) {
                throw new DbRuntimeError('JD2004',
                  `the model declares no entity '${name}'`,
                  { docPath: '/entities', collection: name });
              }
              engine = createLoadEngine(
                { connection, entities, mapping, state: queryState, coreFor: entityCoreFor,
                  profile: storeProfile, roots: declaredRoots }, name);
              loadEngines.set(name, engine);
            }
            return engine;
          };
          /** @type {Map<string, any>} */
          const entityCores = new Map();
          const entityCoreFor = (name) => {
            let core = entityCores.get(name);
            if (core === undefined) {
              const entity = entities.get(name);
              if (entity === undefined) {
                throw new DbRuntimeError('JD2004',
                  `the model declares no entity '${name}'`,
                  { docPath: '/entities', collection: name });
              }
              const validate = options.compileSchema !== undefined
                ? options.compileSchema(writeSchemaOf(entity, mapping.entities[name]))
                : null;
              if (validate !== null && typeof validate !== 'function')
                throw new TypeError('openStore: compileSchema must return a validation function');
              core = captureEntity(name, entityCore(connection, entity,
                mapping.entities[name], validate, runtime));
              entityCores.set(name, core);
            }
            return core;
          };

          /**
           * ONE unit of work and the tracked operations that write through
           * it. The store has one; a transaction may be given its own, so
           * two concurrent handlers hold two records for the same entity
           * key and neither can see the other's pending state — which is
           * what makes one store safe for a handler per request.
           *
           * The cores, engines and plans below it are shared: what a
           * second unit of work costs is its own map of records, not a
           * second copy of the model.
           */
          const createUnitOfWork = () => {
            const tracker = entities.size > 0
              ? createTracker({
                connection, entities, mapping, coreFor: entityCoreFor,
                captureRecord: capture === null || capture.mode !== 'journal'
                  ? undefined
                  : (table, keyParts, before, after) => capture.record(table, keyParts,
                    before === undefined ? undefined : stripRelations(table, before),
                    stripRelations(table, after)),
                captureJoinDelete: captureJoinDelete ?? undefined,
              })
              : null;
            /** @type {Map<string, any>} */
            const trackedOps = new Map();
            /** @type {Map<string, any>} */
            const entityHandles = new Map();
            /** @type {Map<string, any>} */
            const syncEntityHandles = new Map();
            // the unit-of-work surface (§11): reads register frozen
            // snapshots; add/put/remove are LOCAL bookkeeping (no
            // database round trip, deliberately synchronous on both
            // surfaces); asNoTracking() reads retain nothing
            const trackedOpsFor = (name) => {
            let ops = trackedOps.get(name);
            if (ops !== undefined) return ops;
            const core = entityCoreFor(name);
            const loads = loadEngineFor(name);
            /**
             * The many-to-many memberships a document carries, as join
             * rows: `create()` attaches them after the insert, in the
             * same transaction — the `<Name>Input` type and `add()` say
             * a membership array is writable, and `create()` refusing it
             * made the generated type a lie.
             * @param {any} doc
             */
            const membershipsOf = (doc) => {
              const out = [];
              for (const property of entities.get(name).properties.values()) {
                const relation = property.relation;
                if (relation?.kind !== 'manyToMany') continue;
                const join = mapping.joinTables[relation.joinTable];
                const own = join.left.entity === name ? join.left : join.right;
                const target = own === join.left ? join.right : join.left;
                const keys = [...new Set(membershipKeys(doc?.[property.name],
                  target.referencesKey, property.name,
                  (reason) => new DbRuntimeError('JD2003', reason,
                    { docPath: entities.get(name).docPath, collection: name })))];
                if (keys.length > 0) out.push({ table: relation.joinTable, join, own, target, keys });
              }
              return out;
            };
            const attach = (made, memberships) => {
              const ownKey = made[mapping.entities[name].keys[0]];
              const next = (i) => {
                if (i >= memberships.length) return null;
                const { table, join, own, target, keys } = memberships[i];
                const sql = `INSERT INTO ${dialect.quoteIdentifier(table)} `
                  + `(${dialect.quoteIdentifier(own.column)}, ${dialect.quoteIdentifier(target.column)}) `
                  + `VALUES (${dialect.parameterRef(1, 'v')}, ${dialect.parameterRef(2, 'v')})`;
                return chain(connection.prepare(sql), (statement) => {
                  const row = (j) => {
                    if (j >= keys.length) return next(i + 1);
                    let ran;
                    try {
                      ran = statement.run([ownKey, keys[j]]);
                    }
                    catch (error) {
                      throw new DbRuntimeError('JD2005',
                        `the database rejected the operation: ${/** @type {any} */ (error)?.message ?? String(error)}`,
                        { docPath: entities.get(name).docPath, collection: name, key: ownKey, cause: error });
                    }
                    return chain(ran, () => {
                      if (capture !== null && capture.mode === 'journal') {
                        const value = { [own.column]: ownKey, [target.column]: keys[j] };
                        const ordered = {};
                        for (const column of [join.left.column, join.right.column])
                          ordered[column] = value[column];
                        capture.record(table, Object.values(ordered), null, ordered);
                      }
                      return row(j + 1);
                    });
                  };
                  return row(0);
                });
              };
              return next(0);
            };
            ops = {
              mutate: (document) => core.mutate(document),
              create: (doc) => {
                const memberships = membershipsOf(doc);
                if (memberships.length === 0)
                  return chain(core.create(doc), (made) => tracker.register(name, made));
                // one capture scope and one transaction around the row and
                // its join rows: a membership the database refuses rolls the
                // row back too, and journal capture records the join rows
                return chain(guard(() => connection.transaction(() =>
                  chain(core.create(doc), (made) => chain(attach(made, memberships), () => made)))),
                (made) => tracker.register(name, made));
              },
              get: (key) => chain(core.get(key), (doc) =>
                (doc === undefined ? undefined : tracker.register(name, doc))),
              update: (key, changes) => chain(core.update(key, changes),
                (next) => tracker.register(name, next)),
              delete: (key) => chain(core.delete(key), (done) => {
                tracker.discard(name, key);
                return done;
              }),
              load: (spec, loadOptions) => chain(loads.load(spec, loadOptions),
                (docs) => tracker.registerGraph(loads.treeFor(spec), docs)),
              // the graph cursor registers nothing unless asked: a
              // snapshot per yielded root is a tracker that grows with the
              // result, so it is the caller's decision (`tracking: true`)
              syncLoadCursor: (spec, cursorOptions) => loads.syncLoadCursor(spec, cursorOptions,
                cursorOptions?.tracking === true
                  ? (tree, doc) => tracker.registerGraph(tree, [doc])[0] : undefined),
              syncPage: (spec, pageOptions) => loads.syncPage(spec, pageOptions,
                pageOptions?.tracking === true
                  ? (tree, doc) => tracker.registerGraph(tree, [doc])[0] : undefined),
              loadCursor: (spec, cursorOptions) => loads.loadCursor(spec, cursorOptions,
                cursorOptions?.tracking === true
                  ? (tree, doc) => tracker.registerGraph(tree, [doc])[0] : undefined),
              page: (spec, pageOptions) => loads.page(spec, pageOptions,
                pageOptions?.tracking === true
                  ? (tree, doc) => tracker.registerGraph(tree, [doc])[0] : undefined),
              explainLoad: (spec, loadOptions) => loads.explainLoad(spec, loadOptions),
              add: (doc) => tracker.add(name, doc),
              put: (next) => tracker.put(name, next),
              remove: (keyOrDoc) => tracker.remove(name, keyOrDoc),
              discard: (keyOrDoc) => tracker.discard(name, keyOrDoc),
              // membership (§11.7): local bookkeeping like add/put/remove;
              // the join rows are written by saveChanges()
              link: (own, member, target) => tracker.link(name, own, member, target),
              unlink: (own, member, target) => tracker.unlink(name, own, member, target),
              noTracking: {
                get: (key) => core.get(key),
                load: (spec, loadOptions) => loads.load(spec, loadOptions),
              },
            };
            trackedOps.set(name, ops);
            return ops;
            };

            /**
             * An entity handle over THIS unit of work, bound to whatever
             * scope is open when it runs — the tracked surface, its
             * untracked twin, and the provider members.
             * @param {string} name
             */
            const entityFor = (name) => {
              let handle = entityHandles.get(name);
              if (handle === undefined) {
                const ops = trackedOpsFor(name);
                const untracked = Object.freeze({
                  get: lift((key) => ops.noTracking.get(key)),
                  load: lift((spec, loadOptions) => ops.noTracking.load(spec, loadOptions)),
                });
                handle = Object.freeze({
                  create: lift((doc) => ops.create(doc)),
                  get: lift((key) => ops.get(key)),
                  update: lift((key, changes) => ops.update(key, changes)),
                  mutate: lift((document) => ops.mutate(document)),
                  delete: lift((key) => ops.delete(key)),
                  load: lift((spec, loadOptions) => ops.load(spec, loadOptions)),
                  loadCursor: (spec, cursorOptions) => ops.loadCursor(spec, cursorOptions),
                  page: lift((spec, pageOptions) => ops.page(spec, pageOptions)),
                  explainLoad: ops.explainLoad,
                  add: ops.add,
                  put: ops.put,
                  remove: ops.remove,
                  discard: ops.discard,
                  link: ops.link,
                  unlink: ops.unlink,
                  asNoTracking: () => untracked,
                  // the provider contract over ONE entity root (MODEL-FORMAT
                  // §10.1): the document is over the multi-entity root and
                  // goes to the entity engine whole; `root` is the hint a
                  // chain binds its items through, `scope` the identity two
                  // sets of one store share so their documents may be joined
                  // (it carries every root's `relations`, so a hop may chain),
                  // `relations` this entity's own relation table (§10.1).
                  // `execute` stays value-or-promise, as a collection's
                  execute: (document, queryOptions) => entityEngine.execute(document, queryOptions),
                  // the item cursor over the same document: one row per
                  // pull, the statement released on break. It registers
                  // NO snapshot by default — a cursor that tracked every
                  // row it yielded would be an unbounded tracker — and
                  // `tracking: true` opts in per call, documented as
                  // unbounded in the result size
                  cursor: (document, queryOptions) => entityEngine.query(document, queryOptions,
                    queryOptions?.tracking === true
                      ? (entity, doc) => tracker.register(entity, doc) : undefined),
                  explain: lift((document, queryOptions) => entityEngine.explain(document, queryOptions)),
                  root: entityRoot(name),
                  scope: entityEngine,
                  relations: entityEngine.relations[name],
                });
                entityHandles.set(name, handle);
              }
              return handle;
            };

            /** The same set, answering values. */
            const syncEntityFor = (name) => {
              let handle = syncEntityHandles.get(name);
              if (handle === undefined) {
                const ops = trackedOpsFor(name);
                const untracked = Object.freeze({
                  get: (key) => ops.noTracking.get(key),
                  load: (spec, loadOptions) => ops.noTracking.load(spec, loadOptions),
                });
                handle = Object.freeze({
                  create: (doc) => ops.create(doc),
                  get: (key) => ops.get(key),
                  update: (key, changes) => ops.update(key, changes),
                  delete: (key) => ops.delete(key),
                  load: (spec, loadOptions) => ops.load(spec, loadOptions),
                  loadCursor: (spec, cursorOptions) => ops.syncLoadCursor(spec, cursorOptions),
                  page: (spec, pageOptions) => ops.syncPage(spec, pageOptions),
                  cursor: (document, queryOptions) => entityEngine.syncQuery(document, queryOptions,
                    queryOptions?.tracking === true
                      ? (entity, doc) => tracker.register(entity, doc) : undefined),
                  explainLoad: ops.explainLoad,
                  add: ops.add,
                  put: ops.put,
                  remove: ops.remove,
                  discard: ops.discard,
                  link: ops.link,
                  unlink: ops.unlink,
                  asNoTracking: () => untracked,
                  // the same provider members as the asynchronous handle,
                  // answering values; one handle per name, so two chains
                  // over one set share one source identity
                  execute: (document, queryOptions) => entityEngine.execute(document, queryOptions),
                  explain: (document, queryOptions) => entityEngine.explain(document, queryOptions),
                  root: entityRoot(name),
                  scope: entityEngine,
                  relations: entityEngine.relations[name],
                });
                syncEntityHandles.set(name, handle);
              }
              return handle;
            };

            return Object.freeze({ tracker, entityFor, syncEntityFor });
          };

          // the store's own unit of work: what a store-level handle and a
          // transaction that did not ask for its own both write through
          rootWork = createUnitOfWork();
          ctx().work = rootWork;

          /** @type {Map<string, any>} */
          const asyncHandles = new Map();

          /**
           * A collection handle BOUND to whatever scope is open when it
           * runs. It is what a transaction callback gets, and what the
           * store-level handle wraps in the gate. Collections carry no
           * unit of work, so one handle per name serves every scope.
           * @param {string} name
           */
          function boundCollection(name) {
            let handle = asyncHandles.get(name);
            if (handle === undefined) {
              handle = asyncCollection(coreFor(name),
                liveRegistry === null ? null : registerCollectionLive);
              asyncHandles.set(name, handle);
            }
            return handle;
          }

          /** The engine's own commit counter, read wherever the caller
           * is: the store wraps it in the gate, a transaction view in
           * its scope check. An engine that keeps no such counter — one
           * where "another connection has written since you last looked"
           * is not a question a single number answers — refuses by name
           * rather than by a TypeError on a statement it cannot spell. */
          const readDataVersion = () => {
            if (typeof dialect.introspect.dataVersion !== 'function') {
              throw new DbRuntimeError('JD2077',
                'this store has no data version: the dialect keeps no commit counter, so '
                + 'there is no single number that changes when another connection writes');
            }
            return chain(connection.prepare(dialect.introspect.dataVersion()),
              (statement) => chain(statement.get([]), (row) => Number(row.v)));
          };

          /** Register an entity-root live query (LIVE-FORMAT §7) — the
           * store's `live` and a transaction view's share one body. */
          const registerEntityLive = (document, liveOptions) => {
            if (liveRegistry === null) {
              throw new DbCompileError('JD0050',
                'live queries require change capture — open the store with { capture: true }');
            }
            if (liveOptions?.eventTime !== undefined) {
              throw new DbCompileError('JD0053',
                'live eventTime maintains a collection view — an entity document re-runs, '
                + 'so a watermark would describe nothing (LIVE-FORMAT §13)');
            }
            const roots = collectEntityRoots(document, new Map([...entities, ...joinTableRoots(entities, mapping).entities]));
            if (roots.size === 0) {
              throw new TypeError(
                'store.live takes an entity-root document — for a collection, '
                + 'use store.collection(name).live');
            }
            const logicalRows = createLogicalRows({ connection, shapes: captureShapes, capture,
              collectionCore: coreFor, entityCore: entityCoreFor });
            return closeOnRollback(liveRegistry.register({
              name: [...roots].join('+'),
              tables: roots,
              document,
              externals: liveOptions?.externals ?? {},
              demanded: liveOptions?.mode,
              classification: liveOptions?.mode === 'rerun' ? {
                strategy: 'rerun',
                reason: 're-run mode was explicitly requested',
              } : classifyEntityLive(document, entities, mapping, operators),
              execute: (doc, executeOptions) => entityEngine.execute(doc, executeOptions),
              readDependency: logicalRows.read,
              dependencyPosition: logicalRows.position,
              readRow: null,
              keyOf: null,
              ...liveSnapshot(document, liveOptions),
            }));
          };

          /**
           * Every member of a bound handle that issues a statement,
           * wrapped in the store-level gate. The rest — local unit-of-work
           * bookkeeping, cached stats, the provider's identity members —
           * touches no connection and is passed through as it is.
           *
           * `valued` names the members that answer value-or-promise
           * rather than always a promise: the provider contract keeps a
           * chain over a synchronous driver synchronous, so those must
           * not be lifted. They still answer a promise while another
           * caller's transaction holds the connection — which is what
           * waiting for a commit means.
           * @param {any} handle
           * @param {string[]} names - members that answer a promise
           * @param {string[]} [valued] - members that answer value-or-promise
           * @param {(fn: () => any, what?: string, signal?: AbortSignal) => any} [gate]
           *   - the admission: the exclusive gate, or `gatedRead` for classified reads
           */
          const gatedMembers = (handle, names, valued = [], gate = gated) => {
            const out = { ...handle };
            for (const member of names) {
              if (typeof handle[member] !== 'function') continue;
              out[member] = (/** @type {any[]} */ ...args) =>
                lift(() => gate(() => handle[member](...args), undefined, signalOf(member, args)))();
            }
            for (const member of valued) {
              if (typeof handle[member] !== 'function') continue;
              out[member] = (/** @type {any[]} */ ...args) =>
                gate(() => handle[member](...args), undefined, signalOf(member, args));
            }
            return Object.freeze(out);
          };
          /** The argument a gated member reads its options from, by member:
           * a call's `signal` rides into the gate, so one that aborts while
           * it waits in the queue leaves it (JD2064) instead of waiting for
           * its turn to refuse. One already aborted does not: the call then
           * refuses by its own check, before any statement (JD2072). */
          const OPTIONS_ARGUMENT = new Map([['all', 0], ['page', 1], ['load', 1], ['explain', 1], ['execute', 1]]);
          /** @param {string} member @param {any[]} args @returns {AbortSignal | undefined} */
          const signalOf = (member, args) => {
            const at = OPTIONS_ARGUMENT.get(member);
            const options = at === undefined ? undefined : args[at];
            const signal = options !== null && typeof options === 'object' ? options.signal : undefined;
            return signal?.aborted === true ? undefined : signal;
          };

          // ————— SQL the store did not plan: trusted SQL and relational writes —————
          /** The entity a physical table belongs to, by the dialect's own
           * identifier rules (SQLite folds ASCII case; PostgreSQL's quoted
           * names are exact). @param {string} table */
          /** Every entity mapped onto `table` — several entities may share one. */
          const entitiesOfTable = (table) => {
            const fold = (/** @type {string} */ name) => (dialect.name === 'sqlite'
              ? name.replace(/[A-Z]/g, (c) => c.toLowerCase()) : name);
            const wanted = fold(table);
            return Object.entries(mapping?.entities ?? {})
              .filter(([, entityMapping]) => typeof entityMapping?.table === 'string' && fold(entityMapping.table) === wanted)
              .map(([name]) => name);
          };
          /**
           * The write rules for SQL the store did not plan (ONE function
           * for `tx.sql` and the relational engine). A relational write
           * names its table, so a store-only invariant refuses it only when
           * the table is that invariant's entity's, and session capture
           * records it like any statement on a store table. Trusted SQL
           * names none, so it is judged conservatively: any store-only
           * invariant, any capture. Either refuses while tracked changes
           * are pending, which a later save would write over what the
           * statement wrote.
           * @param {string | undefined} table - the written table, when the statement is structural
           * @param {any[]} works - the units of work the writing scope writes through
           */
          const beforeSqlWrite = (table, works) => {
            if (table === undefined) {
              if ([...entities.values()].some((e) => e.invariants.some((r) => r.enforcement === 'store')))
                throw new DbRuntimeError('JD2095', 'trusted SQL cannot bypass store-only invariants');
              if (capture !== null) throw new DbRuntimeError('JD0051', 'trusted SQL writes cannot guarantee complete live/capture/replication coverage');
            }
            else {
              if (readOnly) throw new DbRuntimeError('JD2095', 'this store grants no SQL write authority');
              const owner = entitiesOfTable(table)
                .find((name) => entities.get(name)?.invariants.some((r) => r.enforcement === 'store'));
              if (owner !== undefined) {
                throw new DbRuntimeError('JD2095', `a relational write to '${table}' cannot bypass the store-only `
                  + `invariants of entity '${owner}': write it through the entity`);
              }
              if (capture !== null && capture.mode === 'journal') {
                throw new DbRuntimeError('JD0051', 'journal capture records only the store\'s own writers, which read '
                  + 'the before and after images a relational write does not have: use session capture');
              }
            }
            for (const unit of works) unit.tracker?.assertSqlWritable();
          };
          /** What such a write owes the trackers it may have changed.
           * @param {any[]} works */
          const afterSqlWrite = (works) => {
            for (const unit of works) unit.tracker?.invalidate();
          };

          /**
           * A store-level `transaction` call the driver nests: made from inside
           * an open transaction's own synchronous extent, it becomes a
           * savepoint of that transaction — so it takes the nested option set
           * (`JD0014` for `unitOfWork`, `retry`, `holdTimeoutMs`, or a mode the
           * root did not take) and opens no root of its own, exactly as
           * `tx.transaction` would.
           * @param {(tx: any) => any} fn
           * @param {unknown} transactionOptions
           * @param {string} spelling
           */
          const nestedAtRoot = (fn, transactionOptions, spelling) => {
            const root = /** @type {any} */ (ctx().currentRoot);
            const { signal } = readTransactionOptions(transactionOptions, 'nested', spelling, root.mode);
            if (signal?.aborted === true) throw abortReason(signal);
            const driverScope = /** @type {any} */ (ctx().scope);
            return withScope(driverScope.transaction, (inner, innerIdentity) => (capture === null
              ? fn(scopedStore(inner, innerIdentity))
              : capture.nest(() => fn(scopedStore(inner, innerIdentity)))));
          };

          // ————— the relational engine, bound to the store (MODEL-FORMAT §5.3) —————
          // One engine (relational.js) over the store's admission: here the
          // root's and the synchronous root's, and in each transaction view
          // the exact scope's. Their reusable statements share one bounded
          // cache, as the query cache is bounded: a document with externals
          // plans one text for every binding, and a worker host caps the
          // statements it keeps.
          /**
           * One cached statement: the prepared statement (value-or-promise),
           * the calls running on it, and whether the cache let it go. An
           * evicted statement is finalized once no call runs on it — a
           * worker keeps every statement it prepared until told otherwise,
           * so without this the bound bounded nothing on a worker host.
           * @typedef {{ made: any, uses: number, evicted: boolean }} CachedStatement
           */
          /** @param {CachedStatement} entry */
          const finalizeIdle = (entry) => {
            if (!entry.evicted || entry.uses > 0) return;
            try {
              void Promise.resolve(chain(entry.made, (/** @type {any} */ statement) => statement.finalize?.())).catch(() => {});
            }
            catch {
              // a statement its connection already discarded
            }
          };
          const relationalStatements = createBoundedCache(options.statementCacheBound ?? 128,
            (/** @type {string} */ _key, /** @type {CachedStatement} */ entry) => { entry.evicted = true; finalizeIdle(entry); });
          /** @param {any} where @param {string} sql @param {any} [metadata] */
          const prepareRelational = (where, sql, metadata) => {
            const key = `${metadata?.readOnly === true ? 'read' : 'write'}\u0000${sql}`;
            /** @type {CachedStatement | undefined} */
            let entry = relationalStatements.get(key);
            if (entry === undefined) {
              const made = { made: where.prepare(sql, metadata), uses: 0, evicted: false };
              relationalStatements.set(key, made);
              // a refused preparation is not a statement to keep
              if (isThenable(made.made)) {
                made.made.then(undefined, () => { if (relationalStatements.get(key) === made) relationalStatements.delete(key); });
              }
              entry = made;
            }
            const held = entry;
            /** @param {'run' | 'get' | 'all'} method */
            const use = (method) => (/** @type {any[]} */ params) => {
              held.uses += 1;
              const done = () => { held.uses -= 1; finalizeIdle(held); };
              let out;
              try {
                out = chain(held.made, (/** @type {any} */ statement) => statement[method](params));
              }
              catch (error) {
                done();
                throw error;
              }
              if (!isThenable(out)) {
                done();
                return out;
              }
              return toPromise(out).finally(done);
            };
            return { run: use('run'), get: use('get'), all: use('all') };
          };
          const relationalBase = { dialect, connection: opened, prepare: prepareRelational };
          // the root: reads under the gate, prepared read-only so a pool
          // reader can serve them; a cursor admitted per pull; a write in a
          // top-level transaction of its own that takes the writer lock
          const rootRelational = relationalEngine({
            ...relationalBase,
            // the gate refuses a closed store (JD2063)
            available: () => {},
            read: (run, signal) => gatedRead(() => run(connection), 'a root relational read', signal),
            cursor: (spec) => admitReadCursor(createCursor({ ...spec, open: () => spec.open(connection) }),
              spec.signal, 'a root relational cursor pull'),
            // a write the store's own unit of work hears of (`afterWrite`)
            write: (run, signal) => {
              const via = severalSessions ? opened.pinned : opened;
              if (severalSessions) refuseInsideTransaction();
              if (strictTransactions && (via.wouldWait ?? via.mustQueue))
                throw contended("{ transactions: 'strict' } refuses to queue behind it");
              return topLevelTransaction(() => run(connection), signal, undefined, 'immediate', undefined, undefined, undefined, via);
            },
            beforeWrite: (table) => beforeSqlWrite(table, [rootWork]),
            afterWrite: () => afterSqlWrite([rootWork]),
            lift: true,
          });

          /** @type {Map<string, any>} */
          const gatedCollections = new Map();
          /** @type {Map<string, any>} */
          const gatedEntities = new Map();

          const store = {
            capabilities,
            // native statements over any table (MODEL-FORMAT §5.3)
            relational: rootRelational,
            // the ROOT's bookkeeping, always: an open own-unit
            // transaction changes what its own view reports, never this
            stats: () => ({
              statementCache: { ...queryState.counters },
              udfRegistrations: queryState.registered.size,
              tracker: rootWork.tracker === null ? null : rootWork.tracker.counts(),
              liveQueries: liveRegistry === null ? 0 : liveRegistry.count(),
            }),
            dialect,
            // A STORE-LEVEL handle. It reaches the driver connection, never
            // a transaction it is not part of: a caller here is unrelated
            // to whatever is open, so its statements wait for the commit
            // instead of joining a rollback it knows nothing about. Inside
            // a transaction callback, use the store the callback received.
            collection(name) {
              let handle = gatedCollections.get(name);
              if (handle === undefined) {
                const inner = boundCollection(name);
                // `query` borrows the gate PER PULL rather than for the
                // cursor's life: holding it for the caller's whole loop
                // would block every transaction for as long as a consumer
                // reads slowly, while an ungated pull could read a row a
                // stranger's transaction has not committed. Construction
                // (preflight, compilation) touches no connection. On a
                // store that reads in parallel the reads take a reader
                // instead, and a cursor holds one read across its pulls
                handle = Object.freeze({
                  ...gatedMembers(gatedMembers(inner, ['insert', 'put', 'patch', 'delete', 'live']),
                    ['get', 'all', 'explain'], ['execute'], gatedRead),
                  query: (document, queryOptions) => admitReadCursor(inner.query(document, queryOptions),
                    queryOptions?.signal, 'a root collection cursor pull'),
                });
                gatedCollections.set(name, handle);
              }
              return handle;
            },
            entity(name) {
              let handle = gatedEntities.get(name);
              if (handle === undefined) {
                // ALWAYS the root unit of work: a store-level handle
                // constructed while an own-unit transaction happens to be
                // open must not capture that transaction's tracker
                const inner = rootWork.entityFor(name);
                // `cursor` and `loadCursor` borrow the gate per pull, as a
                // collection's `query` does: admitted one item at a time,
                // never held across the caller's loop. A TRACKED read
                // (`get`, `load`, and a page or cursor asked to track)
                // registers what it read in the unit of work and keeps the
                // gate on a store that reads in parallel; the untracked
                // reads and the document queries take a reader there
                handle = gatedMembers(gatedMembers(inner, ['create', 'get', 'update', 'mutate', 'delete', 'load'], [], gatedWork),
                  ['explain'], ['execute'], gatedRead);
                const untracked = gatedMembers(inner.asNoTracking(), ['get', 'load'], [], gatedRead);
                handle = Object.freeze({
                  ...handle,
                  page: (spec, pageOptions) => lift(() => (pageOptions?.tracking === true ? gatedWork : gatedRead)(
                    () => inner.page(spec, pageOptions), undefined, signalOf('page', [spec, pageOptions])))(),
                  cursor: (document, queryOptions) => (queryOptions?.tracking === true ? admitWorkCursor : admitReadCursor)(
                    inner.cursor(document, queryOptions), queryOptions?.signal, 'a root entity cursor pull'),
                  loadCursor: (spec, cursorOptions) => (cursorOptions?.tracking === true ? admitWorkCursor : admitReadCursor)(
                    inner.loadCursor(spec, cursorOptions), cursorOptions?.signal, 'a root graph cursor pull'),
                  asNoTracking: () => untracked,
                });
                gatedEntities.set(name, handle);
              }
              return handle;
            },
            saveChanges: entities.size === 0 ? undefined
              : lift(() => gatedWork(() => guard(() => rootWork.tracker.saveChanges()))),
            // entity DOCUMENTS query the multi-entity root at the store;
            // `roots` names the entity arrays this provider serves, so a
            // chain asked to iterate the store itself can refuse by name
            execute: entityEngine === null ? undefined
              : (document, queryOptions) =>
                gatedRead(() => entityEngine.execute(document, queryOptions), undefined, signalOf('execute', [document, queryOptions])),
            explain: entityEngine === null ? undefined
              : lift((document, queryOptions) =>
                gatedRead(() => entityEngine.explain(document, queryOptions), undefined, signalOf('explain', [document, queryOptions]))),
            roots: entityEngine === null ? undefined : Object.freeze([...entities.keys()]),
            relations: entityEngine === null ? undefined : entityEngine.relations,
            // entity live queries re-run on invalidation — declared,
            // not attempted (LIVE-FORMAT §7). Registration takes the
            // store gate through its INITIAL query, like a collection's
            // `live`: the registration is local, the first result is a
            // statement, and a statement here must not read a row a
            // stranger's transaction has not committed. The live handle
            // then runs on committed writes alone.
            live: entityEngine === null ? undefined
              : lift((document, liveOptions) =>
                gated(() => registerEntityLive(document, liveOptions), 'a root live registration')),
            // A TOP-LEVEL transaction: it takes the connection's gate, so
            // it never shares a savepoint stack with another one. To nest,
            // use the store the callback RECEIVES — the outer store cannot
            // tell an inner transaction from an unrelated caller, and an
            // unrelated caller must wait for the commit. A `signal` gives
            // up the QUEUE, never a transaction already running.
            //
            // `unitOfWork: 'own'` gives the callback a tracker of its own,
            // so two concurrent handlers hold two records for one entity
            // key and neither sees the other's pending state. It is opt-in
            // because the shared default is what lets a caller add() a
            // document outside the transaction and save it inside.
            // `mode: 'immediate'` takes the store's writer lock up front
            // (`BEGIN IMMEDIATE`; PostgreSQL's advisory lock after `BEGIN`):
            // a body that reads before it writes never meets the read→write
            // upgrade busy the handler cannot retry, and never loses an
            // update to another immediate transaction. The default stays
            // the deferred savepoint; nesting is a savepoint under either.
            // `isolation` is a floor: the level asked for, or the
            // session's stronger default, runs (`tx.isolation`).
            transaction: lift((fn, transactionOptions) => {
              // called from inside a transaction's own synchronous extent,
              // the driver nests the call as a savepoint of that transaction:
              // it IS a nested transaction, with the nested option set
              if (ctx().currentRoot !== null && !opened.mustQueue) return nestedAtRoot(fn, transactionOptions, 'store.transaction');
              // a closed set, read before anything begins (JD0013, JD0014)
              const { mode, signal, unitOfWork, retry, holdTimeoutMs, isolation } =
                readTransactionOptions(transactionOptions, 'async', 'store.transaction');
              if (severalSessions && unitOfWork === 'shared')
                throw new DbCompileError('JD0014', "store.transaction: unitOfWork 'shared' cannot act on a store with several "
                  + "sessions — each transaction has a unit of work of its own there, and the store's own is served on its first session");
              const hold = holdTimeoutMs ?? options.holdTimeoutMs;
              // the call's own level wins over the store's default
              const begin = beginFor(isolation ?? options.isolation, mode);
              /** @param {number} attempt */
              const once = (attempt) => afterHeldBody(topLevelTransaction(fn, signal,
                // a retried transaction runs every attempt on a fresh own
                // unit of work: a failed attempt's restored pending records
                // must never be saved by the next one. On a store with
                // several sessions every transaction has its own: the
                // store's is served on its first session, one call at a time
                unitOfWork === 'own' || retry !== undefined || severalSessions ? createUnitOfWork() : undefined,
                mode, attempt, hold, begin));
              return retry === undefined ? once(1) : retrying(once, retry, signal);
            }),
            observe: (fn) => {
              if (capture === null) {
                throw new TypeError(
                  'observe needs capture — open the store with { capture: true }');
              }
              return capture.observe(fn);
            },
            changesSince: capture === null ? undefined
              : lift((after) => gated(() => capture.changesSince(after))),
            // the bounded reader (LIVE-FORMAT §5): watermarks, and pages
            // that report a retention gap instead of a misleading suffix
            changes: capture === null || !capture.logged ? undefined : Object.freeze({
              bounds: lift(() => gated(() => capture.bounds())),
              page: lift((pageOptions) => gated(() => capture.page(pageOptions))),
            }),
            dataVersion: lift(() => gated(() => readDataVersion())),
            // Database → model, read-only: what this database's shape
            // says the model is, beside a report of everything it
            // cannot say. It holds the store gate for its extent, like
            // every other read, and it issues no DDL and no DML — the
            // derived model is an ANSWER, and applying it is the
            // migration planner's job and the operator's decision
            introspect: lift((introspectOptions) =>
              gated(() => introspectModel(connection, introspectOptions))),
            // the maintenance surface: each operation holds the store
            // gate for its own extent, so a checkpoint can never
            // interleave an in-flight write; none takes a transaction
            checkpoint: lift((maintenanceOptions) =>
              gated(() => maintenance.checkpoint(maintenanceOptions), 'a checkpoint')),
            integrityCheck: lift((maintenanceOptions) =>
              gated(() => maintenance.integrityCheck(maintenanceOptions), 'an integrity check')),
            foreignKeyCheck: lift((maintenanceOptions) =>
              gated(() => maintenance.foreignKeyCheck(maintenanceOptions), 'a foreign-key check')),
            optimize: lift((maintenanceOptions) =>
              gated(() => maintenance.optimize(maintenanceOptions), 'an optimize')),
            // the online backup: NOT held under the gate for its whole
            // extent — writers proceed while the copy runs — only its
            // checkpoint boundary is
            backupTo: lift((targetPath, backupOptions) => backup.backupTo(targetPath, backupOptions)),
            // The ROOT jobs surface: every finite call takes the store
            // gate, exactly as a root collection write does, so an
            // unrelated enqueue, claim, checkpoint or settlement can
            // never join an open application transaction's fate. The
            // transactional-outbox spelling is the explicit `tx.jobs` a
            // transaction callback receives.
            jobs: jobsEngine === null ? undefined : Object.freeze({
              enqueue: lift((...args) => gated(() => jobsEngine.enqueue(...args), 'a root job enqueue')),
              get: lift((...args) => gated(() => jobsEngine.get(...args), 'a root job read')),
              counts: lift(() => gated(() => jobsEngine.counts(), 'a root job read')),
              claim: lift((...args) => gated(() => jobsEngine.claim(...args), 'a root job claim')),
              assertLease: lift((...args) => gated(() => jobsEngine.assertLease(...args), 'a root lease check')),
              renew: lift((...args) => gated(() => jobsEngine.renew(...args), 'a root lease renewal')),
              complete: lift((...args) => gated(() => jobsEngine.complete(...args), 'a root job settlement')),
              fail: lift((...args) => gated(() => jobsEngine.fail(...args), 'a root job settlement')),
              // a checkpoint store keeps its creator's ROOT ownership:
              // its later calls take the gate too, never a scope. They
              // stay value-or-promise like the engine's own — the gate
              // answers a value when nothing is contended
              checkpointsFor: (job) => {
                const inner = jobsEngine.checkpointsFor(job);
                return Object.freeze({
                  inspect: (runId, nodeId) => gated(() => inner.inspect(runId, nodeId), 'a root checkpoint identity read'),
                  load: (runId) => gated(() => inner.load(runId), 'a root checkpoint read'),
                  save: (runId, nodeId, value) =>
                    gated(() => inner.save(runId, nodeId, value), 'a root checkpoint save'),
                  complete: (runId, result) =>
                    gated(() => inner.complete(runId, result), 'a root checkpoint settlement'),
                });
              },
              createWorker: jobsEngine.createWorker,
              // administration (JOBS-FORMAT §10): mechanism, never schedule.
              // `page` borrows the gate per pull like every root cursor;
              // `cancel` settles under the gate and then waits OUTSIDE it
              // for a local attempt to wind up — the handler's own
              // settlement calls take the gate, so waiting inside it
              // would wait for itself
              page: (pageOptions) => admitRootCursor(jobsEngine.page(pageOptions),
                pageOptions?.signal, 'a root job page pull'),
              cancel: lift((id, cancelOptions) => chain(
                gated(() => jobsEngine.cancel(id, cancelOptions), 'a root job cancellation'),
                (outcome) => chain(jobsEngine.settledLocally(id), () => outcome))),
              requeue: lift((...args) => gated(() => jobsEngine.requeue(...args), 'a root job requeue')),
              reset: lift((...args) => gated(() => jobsEngine.reset(...args), 'a root job reset')),
              sweep: lift((...args) => gated(() => jobsEngine.sweep(...args), 'a root job sweep')),
            }),
            /**
             * Close the store. Job workers are asked to stop and given a
             * bounded grace period; the connection is then closed WHETHER
             * OR NOT a handler wound up. That bound is the point: an
             * unbounded wait let one handler that never settles hold the
             * database file open for the life of the process, which is how
             * an abandoned worker in the suite left a locked file behind.
             * @param {{ graceMs?: number }} [closeOptions]
             */
            close: lift((closeOptions) => {
              const liveCleanup = liveRegistry?.closeAll();
              const cursorCleanup = cursorOwnership === undefined && sharedCursors.size === 0 ? null
                : Promise.allSettled([...cursorOwnership?.owners ?? [], ...sharedCursors]
                  .map((cursor) => cursor[CLOSED_UNDER](new DbRuntimeError('JD2063',
                    'the store closed while this cursor was open: the rows after the last one it read were never read'))));
              return chain(jobsEngine === null ? null : jobsEngine.stopAll(closeOptions), (stopped) => {
                // admission closes once the workers have stopped: a call
                // after close() refuses by name instead of queueing behind
                // the lease's release and running once the lease is given back
                admissionClosed = true;
                // the lease goes back first — on PostgreSQL before the driver
                // restores the session's path and returns it to its pool, or
                // with the session destroyed when its release could not run
                return chain(ownerLease === null ? null : ownerLease.release(), () =>
                  chain(connection.close(ownerLease?.holds() === true ? { discard: true } : undefined),
                    () => chain(liveCleanup, () => chain(cursorCleanup, () => {
                      const stuck = (stopped ?? []).filter(
                        (/** @type {any} */ outcome) => outcome.drained === false);
                      if (stuck.length === 0) return undefined;
                      // reported, not swallowed: the handle is released, but
                      // handlers are still running against a closed connection
                      throw new DbRuntimeError('JD2062',
                        `the store closed with ${stuck.reduce(
                          (/** @type {number} */ n, /** @type {any} */ o) => n + o.inFlight, 0)} `
                        + `job handler(s) still in flight across ${stuck.length} worker(s); `
                        + 'they were signalled to abort and did not settle within the grace period');
                    }))));
              });
            }),
          };

          /**
           * The `JD2070` lifetime check every stateful member of a
           * transaction view runs FIRST — before reading or mutating
           * tracker state, and before any statement. A view is pinned to
           * the exact scope that created it: an identity that is not
           * current has either settled (the handle escaped its callback)
           * or been crossed by an inner scope (an outer handle used while
           * an async inner savepoint is open). It never falls through to
           * the root and never follows a newer scope.
           * @param {any} identity
           */
          const requireScope = (identity) => {
            // a transaction its hold limit rolled back: every handle it gave
            // out refuses with the reason, not as a stale scope
            const root = rootOf(identity);
            if (root !== undefined && checkHold(root) !== null) throw heldTooLong(root.expired);
            if (ctx().currentScope === identity) return;
            throw new DbRuntimeError('JD2070',
              'this transaction handle is pinned to a scope that is not current: '
              + 'its transaction settled, an inner transaction is open, or — on a store with '
              + "several sessions — it is used from another transaction's flow. Use the "
              + 'store the LIVE transaction callback received (tx.collection / '
              + 'tx.entity / tx.saveChanges / tx.jobs) — a handle never outlives '
              + 'or crosses its own scope.');
          };

          /**
           * One handle operation of a transaction: the scope check, and —
           * when its root has a hold limit — a count of operations in
           * flight, so the limit lets an operation already under way finish
           * (its statements in the transaction it rolls back) and no
           * statement of a later one ever reaches the connection.
           * @param {any} identity
           * @param {() => any} fn
           * @returns {any}
           */
          const runScoped = (identity, fn, ordered = true) => {
            // a handle used from a flow in no transaction — a listener, a timer
            // made outside the body — runs in its own transaction's context, as
            // on one session; from another transaction's flow it stays JD2070
            if (severalSessions && ctx().currentRoot === null && identity.context !== ctx()
              && identity.context?.currentScope === identity)
              return opened.enter(identity.context, () => runScoped(identity, fn, ordered));
            // a savepoint one of this scope's own operations opened is current:
            // the call waits for that operation's turn rather than refusing
            const current = ctx().currentScope;
            if (ordered && current !== identity && current?.internalOf === identity && identity.turn !== undefined)
              return identity.turn.then(() => runScoped(identity, fn, ordered));
            requireScope(identity);
            return ordered ? inTurn(identity, () => counted(identity, fn)) : counted(identity, fn);
          };

          /**
           * One operation of a scope at a time, in call order. An operation
           * that opens a savepoint of its own — a patch, an `expect` write, a
           * nested transaction — wraps whatever else the transaction sends
           * while it is open, and its rollback took back another operation
           * that had already reported success. So an operation called while
           * another holds the scope's turn waits for it (a synchronous driver
           * never has one in flight), and checks the scope again once it has
           * the turn: one called after its transaction settled refuses
           * (`JD2070`) without a statement. The scope is checked BEFORE the
           * wait too, so an outer handle used from an inner transaction's body
           * refuses at once instead of waiting for the transaction it is in.
           * A call on the synchronous extent of the operation holding the turn
           * is part of it and runs at once.
           * @param {any} identity @param {() => any} start
           * @returns {any}
           */
          const inTurn = (identity, start) => {
            if (identity.turn !== undefined && identity.onStack !== true) {
              return identity.turn.then(() => {
                requireScope(identity);
                return inTurn(identity, start);
              });
            }
            const wasOnStack = identity.onStack === true;
            identity.onStack = true;
            let out;
            try {
              out = start();
            }
            finally { identity.onStack = wasOnStack; }
            if (wasOnStack || !isThenable(out)) return out;
            // the turn is given back the moment the operation settles, before
            // its caller resumes and before a waiter takes it
            const giveBack = () => { if (identity.turn === turn) identity.turn = undefined; };
            const turn = toPromise(out).then(giveBack, giveBack);
            identity.turn = turn;
            return out;
          };

          /** A handle operation, counted in flight while its root has a hold
           * limit (see `runScoped`). @param {any} identity @param {() => any} fn */
          const counted = (identity, fn) => {
            const root = rootOf(identity);
            if (root === undefined || root.hold === undefined) return fn();
            root.inFlight += 1;
            let out;
            try {
              out = fn();
            }
            catch (error) {
              settleInFlight(root);
              throw error;
            }
            if (!isThenable(out)) {
              settleInFlight(root);
              return out;
            }
            return toPromise(out).then(
              (value) => { settleInFlight(root); return value; },
              (error) => { settleInFlight(root); throw error; });
          };

          /**
           * Every stateful member of a scope-view handle, checked against
           * the exact scope before it runs. `lifted` members answer a
           * promise (the check rejects); `direct` members answer values
           * or value-or-promise (the check throws) — the unit-of-work
           * bookkeeping and the provider members among them.
           * @param {any} identity
           * @param {any} handle
           * @param {string[]} lifted
           * @param {string[]} [direct]
           */
          const scopedMembers = (identity, handle, lifted, direct = []) => {
            const out = { ...handle };
            for (const member of lifted) {
              if (typeof handle[member] !== 'function') continue;
              out[member] = (/** @type {any[]} */ ...args) =>
                lift(() => runScoped(identity, () => handle[member](...args)))();
            }
            // a direct member answers a value: the unit-of-work bookkeeping,
            // which touches no connection, and the synchronous twins — never
            // a promise of waiting for the turn
            for (const member of direct) {
              if (typeof handle[member] !== 'function') continue;
              out[member] = (/** @type {any[]} */ ...args) => runScoped(identity, () => handle[member](...args), false);
            }
            return out;
          };

          /** A cursor pinned to one exact scope: it opens under the
           * scope check, and `next()` re-checks the scope on every pull,
           * so iteration can neither begin nor continue once that exact
           * scope settled. The classification (`streaming`, `barrier`)
           * is the inner cursor's own. */
          const scopedCursor = (identity, open) => {
            requireScope(identity);
            const cursor = open();
            /** Release the source: a reset reads and writes nothing, so it
             * is safe whatever became of the scope. */
            const release = () => {
              identity.cursors?.delete(release);
              return Promise.resolve().then(() => cursor.return()).catch(() => undefined);
            };
            // the scope closes it when the body settles, if nobody did
            (identity.cursors ??= new Set()).add(release);
            /** @type {any} */
            const wrapped = {
              streaming: cursor.streaming,
              barrier: cursor.barrier,
              // a pull the scope refuses (settled, or past its hold limit)
              // releases the source too: nothing can pull it again, and a
              // `for await` whose next() rejected never calls return()
              next: () => {
                let pulled;
                try {
                  pulled = runScoped(identity, () => cursor.next());
                }
                catch (error) {
                  return release().then(() => { throw error; });
                }
                // an exhausted or failed cursor has released its source; a
                // pull the scope refused once it had the turn releases it too
                return Promise.resolve(pulled).then((step) => {
                  if (step.done) identity.cursors?.delete(release);
                  return step;
                }, (error) => release().then(() => { throw error; }));
              },
              // a refused release still releases, as a root cursor's does
              return: () => {
                const released = () => release().then(() => ({ done: true, value: undefined }));
                try {
                  return Promise.resolve(runScoped(identity, () => cursor.return())).catch(released);
                }
                catch {
                  return released();
                }
              },
              [Symbol.asyncIterator]: () => wrapped,
            };
            return Object.freeze(wrapped);
          };

          /** A collection handle pinned to one exact scope, its lazy
           * cursor included. */
          const scopedCollection = (identity, name) => {
            const inner = boundCollection(name);
            const out = scopedMembers(identity, inner,
              ['get', 'insert', 'put', 'patch', 'delete', 'all', 'explain', 'live'],
              ['execute', 'stats']);
            out.query = (/** @type {any} */ document, /** @type {any} */ queryOptions) =>
              scopedCursor(identity, () => inner.query(document, queryOptions));
            return Object.freeze(out);
          };

          /** An entity handle over `unit`, pinned to one exact scope —
           * the statement members and the local tracker bookkeeping both
           * carry the identity (`add()` on a settled handle is `JD2070`,
           * not a document smuggled into a later scope's unit of work). */
          const scopedEntity = (identity, unit, name) => {
            const inner = unit.entityFor(name);
            const untracked = Object.freeze(
              scopedMembers(identity, inner.asNoTracking(), ['get', 'load']));
            return Object.freeze({
              ...scopedMembers(identity, inner,
                ['create', 'get', 'update', 'mutate', 'delete', 'load', 'page', 'explain'],
                ['execute', 'add', 'put', 'remove', 'discard', 'link', 'unlink']),
              cursor: (/** @type {any} */ document, /** @type {any} */ queryOptions) =>
                scopedCursor(identity, () => inner.cursor(document, queryOptions)),
              loadCursor: (/** @type {any} */ spec, /** @type {any} */ cursorOptions) =>
                scopedCursor(identity, () => inner.loadCursor(spec, cursorOptions)),
              asNoTracking: () => untracked,
            });
          };

          /** The synchronous twin, answering values. */
          const scopedSyncEntity = (identity, unit, name) => {
            const inner = unit.syncEntityFor(name);
            const untracked = Object.freeze(
              scopedMembers(identity, inner.asNoTracking(), [], ['get', 'load']));
            return Object.freeze({
              ...scopedMembers(identity, inner, [],
                ['create', 'get', 'update', 'delete', 'load', 'page', 'execute', 'explain',
                  'add', 'put', 'remove', 'discard', 'link', 'unlink']),
              cursor: (document, options) => {
                requireScope(identity);
                return admitSyncCursor(inner.cursor(document, options), (fn) => { requireScope(identity); return fn(); });
              },
              loadCursor: (spec, options) => {
                requireScope(identity);
                return admitSyncCursor(inner.loadCursor(spec, options), (fn) => { requireScope(identity); return fn(); });
              },
              asNoTracking: () => untracked,
            });
          };

          /** Shared synchronous collection handles over the cores; set
           * with `store.sync` when the driver is synchronous. The gated
           * store-level surface and each scope view wrap the same ones.
           * @type {((name: string) => any) | undefined} */
          let syncCollectionFor;

          /** The overriding member on a view of the FROZEN store: plain
           * assignment cannot shadow a non-writable inherited property. */
          const override = (/** @type {any} */ value) =>
            ({ value, writable: false, enumerable: true, configurable: false });
          /** An overriding member built on its first read, and the same
           * value on every read after it.
           * @param {() => any} make */
          const onFirstUse = (make) => {
            let made = false;
            /** @type {any} */
            let value;
            return { get: () => { if (!made) { value = make(); made = true; } return value; }, enumerable: true, configurable: false };
          };

          // The transaction callback's argument, and the ONLY handle that
          // is inside the transaction: ONE view per exact scope, pinned to
          // its identity. Its `collection`, `entity`, `sync`, unit of work
          // and `jobs` run as the owner instead of waiting for a commit
          // they are part of; its `transaction` NESTS through the owning
          // savepoint; its `savepoints` move the manual checkpoint stack.
          // The store's own handles are, by construction, somebody else —
          // and a view used outside its exact live scope is `JD2070`.
          scopedStore = (driverScope, identity) => {
            /** The unit of work in force for THIS scope, captured once:
             * the view's tracker surface never follows a later scope. */
            const myWork = ctx().work;
            /** The root transaction around this scope: its mode (a nested
             * transaction may not exceed it) and its attempt number. */
            const myRoot = ctx().currentRoot;
            const myMode = myRoot?.mode ?? 'deferred';
            /** @type {Map<string, any>} */
            const myCollections = new Map();
            /** @type {Map<string, any>} */
            const myEntities = new Map();
            const collectionFor = (/** @type {string} */ name) => {
              let handle = myCollections.get(name);
              if (handle === undefined) {
                handle = scopedCollection(identity, name);
                myCollections.set(name, handle);
              }
              return handle;
            };
            const entityFor = (/** @type {string} */ name) => {
              let handle = myEntities.get(name);
              if (handle === undefined) {
                handle = scopedEntity(identity, myWork, name);
                myEntities.set(name, handle);
              }
              return handle;
            };

            /** Nest through THIS scope's savepoint. The capture scope
             * goes INSIDE the savepoint, so a rollback undoes the
             * translated patch with the rows it describes. Its options
             * are the root's closed set: `mode` may not exceed the
             * enclosing one and `unitOfWork` is the root's to choose
             * (`JD0014`); a nested transaction never queues, so a
             * `signal` can only refuse it before it begins, exactly as an
             * uncontended root's does.
             * @param {any} fn
             * @param {unknown} [transactionOptions]
             * @param {string} [spelling] */
            const nested = (fn, transactionOptions, spelling = 'tx.transaction') => {
              requireScope(identity);
              const { signal } = readTransactionOptions(transactionOptions, 'nested', spelling, myMode);
              if (signal?.aborted === true) throw abortReason(signal);
              // its savepoint takes the scope's turn: it never wraps an
              // operation of the scope still in flight
              return inTurn(identity, () => withScope(driverScope.transaction,
                (inner, innerIdentity) => (capture === null
                  ? fn(scopedStore(inner, innerIdentity))
                  : capture.nest(() => fn(scopedStore(inner, innerIdentity))))));
            };

            // ————— named savepoints (MODEL-FORMAT §5.2) —————
            // One per-exact-scope map from the caller's LABEL to an
            // opaque driver checkpoint plus the settlement-list mark and,
            // in journal capture mode, the capture mark. The label is a
            // map key and diagnostic only — the driver generates the
            // `jaren_sp_*` identifier structured nesting already uses, so
            // a label can never become SQL, and both savepoint kinds
            // share one engine stack. The scope's settlement (commit or
            // rollback) invalidates whatever names were left active,
            // because the view itself is then `JD2070`.
            /** @type {Map<string, any>} */
            const checkpoints = new Map();
            const requireLabel = (/** @type {any} */ label, /** @type {string} */ verb) => {
              if (typeof label === 'string' && label !== '') return;
              throw new DbRuntimeError('JD2071',
                `savepoints.${verb}: a savepoint label must be a non-empty string — `
                + 'it is a map key and diagnostic for this exact transaction, never SQL');
            };
            const resolveLabel = (/** @type {string} */ label, /** @type {string} */ verb) => {
              requireLabel(label, verb);
              const entry = checkpoints.get(label);
              if (entry !== undefined) return entry;
              throw new DbRuntimeError('JD2071',
                `savepoints.${verb}: no active savepoint '${label}' in this exact `
                + 'transaction — it was never created here, or a rollback past it or a '
                + 'release already invalidated it');
            };
            const savepointCreate = (/** @type {string} */ label) => runScoped(identity, () => {
              requireLabel(label, 'create');
              if (checkpoints.has(label)) {
                throw new DbRuntimeError('JD2071',
                  `savepoints.create: the label '${label}' is already active in this `
                  + 'transaction — release it, or roll back to it, before creating it again');
              }
              // SAVEPOINT first; the entry is recorded only after success,
              // so a refused statement leaves label map and marks untouched
              return chain(driverScope.savepoint(), (checkpoint) => {
                checkpoints.set(label, {
                  checkpoint,
                  settleMark: ctx().settlements === null ? 0 : ctx().settlements.length,
                  captureMark: capture === null ? null : capture.mark(),
                });
                return undefined;
              });
            });
            const savepointRollbackTo = (/** @type {string} */ label) => runScoped(identity, () => {
              const entry = resolveLabel(label, 'rollbackTo');
              // ROLLBACK TO first; only after database success do the
              // in-memory effects follow. The target stays active with
              // the same now-current marks, so repeated rollback is
              // defined; entries created after it are gone from the
              // engine stack and invalidated here.
              return chain(driverScope.rollbackTo(entry.checkpoint), () => {
                if (ctx().settlements !== null) {
                  const withdrawn = ctx().settlements.splice(entry.settleMark);
                  for (let i = withdrawn.length - 1; i >= 0; i--) withdrawn[i].rollback?.();
                }
                if (capture !== null) capture.truncate(entry.captureMark);
                let seen = false;
                for (const key of [...checkpoints.keys()]) {
                  if (seen) checkpoints.delete(key);
                  if (key === label) seen = true;
                }
                return undefined;
              });
            });
            const savepointRelease = (/** @type {string} */ label) => runScoped(identity, () => {
              const entry = resolveLabel(label, 'release');
              // RELEASE removes the target and every later entry WITHOUT
              // running rollback effects: those rows remain part of the
              // owning transaction, so their tracker withdrawals stay
              // registered until outer settlement — the engine semantics,
              // exactly (both SQLite and PostgreSQL discard the target
              // and the savepoints nested after it, keeping their rows)
              return chain(driverScope.release(entry.checkpoint), () => {
                let seen = false;
                for (const key of [...checkpoints.keys()]) {
                  if (key === label) seen = true;
                  if (seen) checkpoints.delete(key);
                }
                return undefined;
              });
            });

            // A view is built for every transaction and most bodies touch
            // two or three of its members: the rest are built on first use
            // (one getter each), which keeps a short transaction's cost to
            // what it reaches for.
            // the units of work this scope's SQL may change: its own, and
            // the root's when the transaction has one of its own — on one
            // session only: with several, the store's own unit of work is
            // another session's, which this write no more reaches than
            // another store's
            const sqlWorks = () => (rootWork === myWork || severalSessions ? [myWork] : [myWork, rootWork]);
            /** @type {any} */
            let scopeSql;
            const sqlOfScope = () => (scopeSql ??= trustedSql({ connection, readOnly, requireScope: () => requireScope(identity),
              track: (/** @type {() => any} */ fn) => runScoped(identity, fn),
              beforeWrite: () => beforeSqlWrite(undefined, sqlWorks()),
              afterWrite: () => afterSqlWrite(sqlWorks()),
            }));
            // the relational engine as THIS scope's owner: every call checks
            // the exact scope and counts in flight for a hold limit, a write
            // is a savepoint of the transaction, and a cursor is the scope's;
            // a scope never queues, so a signal can only refuse a call up
            // front — as it refuses a nested transaction (JD2064)
            /** The policy of the asynchronous engine (`ordered`: it takes the
             * scope's turn) or of the synchronous twin, which answers values.
             * @param {boolean} ordered */
            const relationalPolicy = (ordered) => ({
              ...relationalBase,
              available: () => requireScope(identity),
              read: (/** @type {any} */ run, /** @type {AbortSignal | undefined} */ signal) => runScoped(identity, () => {
                if (signal?.aborted === true) throw abortReason(signal);
                return run(connection);
              }, ordered),
              write: (/** @type {any} */ run, /** @type {AbortSignal | undefined} */ signal) => runScoped(identity, () => {
                if (signal?.aborted === true) throw abortReason(signal);
                return connection.transaction(() => run(connection));
              }, ordered),
              beforeWrite: (/** @type {string} */ table) => beforeSqlWrite(table, sqlWorks()),
              afterWrite: () => afterSqlWrite(sqlWorks()),
            });
            /** @type {any} */
            let scopeRelational;
            /** @type {any} */
            let scopeSyncRelational;
            const relationalOfScope = () => (scopeRelational ??= relationalEngine({ ...relationalPolicy(true), lift: true,
              cursor: (/** @type {any} */ spec) => scopedCursor(identity,
                () => createCursor({ ...spec, open: () => spec.open(connection) })) }));
            const syncRelationalOfScope = () => (scopeSyncRelational ??= relationalEngine({ ...relationalPolicy(false),
              cursor: (/** @type {any} */ spec) => admitSyncCursor(createSyncCursor({ ...spec, open: () => spec.open(connection) }),
                (/** @type {() => any} */ fn) => runScoped(identity, fn, false)) }));
            const members = {
              // 1-based: the attempt of a retried transaction this callback runs in
              attempt: override(myRoot?.attempt ?? 1),
              // the isolation level this transaction runs at
              isolation: override(myRoot?.isolation ?? sessionIsolation),
              sql: onFirstUse(sqlOfScope),
              relational: onFirstUse(relationalOfScope),
              transaction: override((/** @type {any} */ fn, /** @type {any} */ transactionOptions) =>
                lift(() => nested(fn, transactionOptions))()),
              collection: override(collectionFor),
              entity: override(entityFor),
              // THIS scope's bookkeeping, and only while this scope is
              // the live one: an escaped handle, or an outer one used
              // while an inner transaction is open, is JD2070 like every
              // other stateful member — never a report from a dead scope
              stats: override(() => {
                requireScope(identity);
                return {
                  statementCache: { ...queryState.counters },
                  udfRegistrations: queryState.registered.size,
                  tracker: myWork.tracker === null ? null : myWork.tracker.counts(),
                  liveQueries: liveRegistry === null ? 0 : liveRegistry.count(),
                };
              }),
              // the transaction's own connection: the root's introspect
              // takes the gate, which from inside the transaction is a
              // wait for itself (JD0012 at queueTimeout, then a rollback)
              introspect: override(lift((/** @type {any} */ introspectOptions) => runScoped(identity, () => introspectModel(connection, introspectOptions)))),
              dataVersion: override(lift(() => runScoped(identity, () => readDataVersion()))),
              savepoints: onFirstUse(() => Object.freeze({
                create: lift(savepointCreate),
                rollbackTo: lift(savepointRollbackTo),
                release: lift(savepointRelease),
              })),
              // a transaction view does not own the store lifetime: the
              // member is ABSENT rather than a second way to close the
              // raw connection under its own savepoint
              close: override(undefined),
              replication: override(undefined),
              // nor does it run maintenance: a checkpoint inside an open
              // transaction is a no-op the engine answers quietly, and
              // the other three are store-level operations — ABSENT here
              checkpoint: override(undefined),
              integrityCheck: override(undefined),
              foreignKeyCheck: override(undefined),
              optimize: override(undefined),
              backupTo: override(undefined),
            };
            if (entities.size > 0) {
              members.saveChanges = override(lift(() => runScoped(identity, () => guard(() => myWork.tracker.saveChanges()))));
            }
            if (entityEngine !== null) {
              members.execute = override(
                (/** @type {any} */ document, /** @type {any} */ queryOptions) => runScoped(identity, () => entityEngine.execute(document, queryOptions)));
              members.explain = override(lift(
                (/** @type {any} */ document, /** @type {any} */ queryOptions) => runScoped(identity, () => entityEngine.explain(document, queryOptions))));
              members.live = override(lift(
                (/** @type {any} */ document, /** @type {any} */ liveOptions) => runScoped(identity, () => registerEntityLive(document, liveOptions))));
            }
            if (capture !== null) {
              members.changesSince = override(lift((/** @type {any} */ after) => runScoped(identity, () => capture.changesSince(after))));
              if (capture.logged) members.changes = onFirstUse(() => Object.freeze({
                bounds: lift(() => runScoped(identity, () => capture.bounds())),
                page: lift((/** @type {any} */ pageOptions) => runScoped(identity, () => capture.page(pageOptions))),
              }));
            }
            if (jobsEngine !== null) {
              // the transactional-outbox spelling: these run as the exact
              // scope, so an enqueue or settlement here co-commits with
              // the domain transaction — and a retained handle is JD2070
              members.jobs = onFirstUse(() => Object.freeze({
                enqueue: lift((/** @type {any[]} */ ...args) => runScoped(identity, () => jobsEngine.enqueue(...args))),
                get: lift((/** @type {any[]} */ ...args) => runScoped(identity, () => jobsEngine.get(...args))),
                counts: lift(() => runScoped(identity, () => jobsEngine.counts())),
                claim: lift((/** @type {any[]} */ ...args) => runScoped(identity, () => jobsEngine.claim(...args))),
                assertLease: lift((/** @type {any[]} */ ...args) => runScoped(identity, () => jobsEngine.assertLease(...args))),
                renew: lift((/** @type {any[]} */ ...args) => runScoped(identity, () => jobsEngine.renew(...args))),
                complete: lift((/** @type {any[]} */ ...args) => runScoped(identity, () => jobsEngine.complete(...args))),
                fail: lift((/** @type {any[]} */ ...args) => runScoped(identity, () => jobsEngine.fail(...args))),
                // a checkpoint store keeps its creator's SCOPE ownership:
                // its later calls cannot switch scopes, and outlive none
                checkpointsFor: (/** @type {any} */ job) => {
                  const inner = jobsEngine.checkpointsFor(job);
                  return Object.freeze({
                    inspect: lift((/** @type {any} */ runId, /** @type {any} */ nodeId) => runScoped(identity, () => inner.inspect(runId, nodeId))),
                    load: lift((/** @type {any} */ runId) => runScoped(identity, () => inner.load(runId))),
                    save: lift((/** @type {any} */ runId, /** @type {any} */ nodeId,
                      /** @type {any} */ value) => runScoped(identity, () => inner.save(runId, nodeId, value))),
                    complete: lift((/** @type {any} */ runId, /** @type {any} */ result) => runScoped(identity, () => inner.complete(runId, result))),
                  });
                },
                // a worker is a ROOT-owned long-lived component wherever
                // it is created: its future loop takes the store gate and
                // never binds to the transaction that constructed it
                createWorker: jobsEngine.createWorker,
              }));
            }
            if (connection.synchronous && syncCollectionFor !== undefined) {
              const forSync = /** @type {(name: string) => any} */ (syncCollectionFor);
              members.sync = onFirstUse(() => {
                /** @type {Map<string, any>} */
                const mySyncCollections = new Map();
                /** @type {Map<string, any>} */
                const mySyncEntities = new Map();
                return Object.freeze({
                collection: (/** @type {string} */ name) => {
                  let handle = mySyncCollections.get(name);
                  if (handle === undefined) {
                    handle = Object.freeze(scopedMembers(identity, forSync(name), [],
                      ['stats', 'get', 'insert', 'put', 'patch', 'delete', 'all', 'execute', 'explain']));
                    mySyncCollections.set(name, handle);
                  }
                  return handle;
                },
                entity: (/** @type {string} */ name) => {
                  let handle = mySyncEntities.get(name);
                  if (handle === undefined) {
                    handle = scopedSyncEntity(identity, myWork, name);
                    mySyncEntities.set(name, handle);
                  }
                  return handle;
                },
                get sql() { return sqlOfScope(); },
                get relational() { return syncRelationalOfScope(); },
                attempt: myRoot?.attempt ?? 1,
                isolation: myRoot?.isolation ?? sessionIsolation,
                transaction: (fn, transactionOptions) => nested((tx) => synchronousBody(fn, tx),
                  transactionOptions, 'tx.sync.transaction'),
                savepoints: Object.freeze({
                  create: savepointCreate,
                  rollbackTo: savepointRollbackTo,
                  release: savepointRelease,
                }),
                saveChanges: entities.size === 0 ? undefined
                  : () => runScoped(identity, () => guard(() => myWork.tracker.saveChanges()), false),
                execute: entityEngine === null ? undefined
                  : (/** @type {any} */ document, /** @type {any} */ queryOptions) => runScoped(identity, () => entityEngine.execute(document, queryOptions), false),
                explain: entityEngine === null ? undefined
                  : (/** @type {any} */ document, /** @type {any} */ queryOptions) => runScoped(identity, () => entityEngine.explain(document, queryOptions), false),
                roots: entityEngine === null ? undefined : Object.freeze([...entities.keys()]),
                relations: entityEngine === null ? undefined : entityEngine.relations,
                });
              });
            }
            return Object.freeze(Object.create(store, members));
          };

          if (connection.synchronous) {
            /** @type {Map<string, any>} */
            const syncHandles = new Map();
            syncCollectionFor = (name) => {
              let handle = syncHandles.get(name);
              if (handle === undefined) {
                const core = coreFor(name);
                handle = Object.freeze({
                  stats: () => core.stats(),
                  get: (/** @type {any} */ key) => core.get(key),
                  insert: (/** @type {any} */ doc, /** @type {any} */ o) => core.insert(doc, o),
                  put: (/** @type {any} */ doc, /** @type {any} */ key, /** @type {any} */ o) => core.put(doc, key, o),
                  patch: (/** @type {any} */ key, /** @type {any} */ ops, /** @type {any} */ o) => core.patch(key, ops, o),
                  delete: (/** @type {any} */ key, /** @type {any} */ o) => core.delete(key, o),
                  all: (/** @type {any} */ o) => core.all(o),
                  execute: (/** @type {any} */ document, /** @type {any} */ o) =>
                    core.execute(document, o),
                  explain: (/** @type {any} */ document, /** @type {any} */ o) =>
                    core.explain(document, o),
                });
                syncHandles.set(name, handle);
              }
              return handle;
            };
            const forSync = syncCollectionFor;

            /** Store-level synchronous members, each holding the
             * connection for its own extent. A contended one refuses
             * rather than queueing: this surface answers values, and a
             * queue answers a Promise. */
            const syncGatedMembers = (handle, names) => {
              const out = { ...handle };
              for (const member of names) {
                if (typeof handle[member] !== 'function') continue;
                out[member] = (/** @type {any[]} */ ...args) =>
                  gatedSync(() => handle[member](...args));
              }
              return Object.freeze(out);
            };
            /** @type {Map<string, any>} */
            const gatedSyncCollections = new Map();
            /** @type {Map<string, any>} */
            const gatedSyncEntities = new Map();
            // the synchronous root: the gate refuses rather than queues, a
            // cursor takes it per pull, a write is a top-level immediate
            // transaction that cannot wait for another caller's commit
            const syncRootRelational = relationalEngine({
              ...relationalBase,
              available: () => {},
              // the synchronous surface never queues: a signal refuses up front
              read: (run, signal) => {
                if (signal?.aborted === true) throw abortReason(signal);
                return gatedSync(() => run(connection));
              },
              cursor: (spec) => admitSyncCursor(createSyncCursor({ ...spec, open: () => spec.open(connection) }), gatedSync),
              write: (run, signal) => {
                if (signal?.aborted === true) throw abortReason(signal);
                if (opened.mustQueue) {
                  throw contended('the synchronous surface answers values, so it cannot '
                    + 'wait for the commit');
                }
                return topLevelTransaction(() => run(connection), undefined, undefined, 'immediate');
              },
              beforeWrite: (table) => beforeSqlWrite(table, [rootWork]),
              afterWrite: () => afterSqlWrite([rootWork]),
            });
            store.sync = Object.freeze({
              relational: syncRootRelational,
              collection(name) {
                let handle = gatedSyncCollections.get(name);
                if (handle === undefined) {
                  handle = syncGatedMembers(forSync(name),
                    ['get', 'insert', 'put', 'patch', 'delete', 'all', 'execute', 'explain']);
                  gatedSyncCollections.set(name, handle);
                }
                return handle;
              },
              transaction: (fn, transactionOptions) => {
                // inside a transaction's own synchronous extent the call nests
                if (ctx().currentRoot !== null && !opened.mustQueue) {
                  return nestedAtRoot((tx) => synchronousBody(fn, tx), transactionOptions, 'store.sync.transaction');
                }
                // the root's closed set (JD0013), read first; `unitOfWork`
                // is honoured exactly as the asynchronous root honours it
                const { mode, signal, unitOfWork, isolation } = readTransactionOptions(
                  transactionOptions, 'sync', 'store.sync.transaction');
                // the synchronous surface answers values: while a
                // transaction owns the connection it could only QUEUE,
                // which handed a Promise back under a value's type
                if (opened.mustQueue) {
                  throw new DbCompileError('JD0012',
                    'the synchronous transaction cannot wait for the open transaction to '
                    + 'settle — nest through the store the callback received, or use the '
                    + 'asynchronous store.transaction()');
                }
                // it never queues, so a signal can only refuse it up front
                if (signal?.aborted === true) throw abortReason(signal);
                return topLevelTransaction((tx) => synchronousBody(fn, tx), undefined,
                  unitOfWork === 'own' ? createUnitOfWork() : undefined, mode, undefined, undefined,
                  beginFor(isolation ?? options.isolation, mode));
              },
              entity(name) {
                let handle = gatedSyncEntities.get(name);
                if (handle === undefined) {
                  // the ROOT unit of work, whatever transaction happens
                  // to be open when the handle is first constructed
                  const inner = rootWork.syncEntityFor(name);
                  const untracked = syncGatedMembers(inner.asNoTracking(), ['get', 'load']);
                  handle = Object.freeze({
                    ...syncGatedMembers(inner,
                      ['create', 'get', 'update', 'delete', 'load', 'page', 'execute', 'explain']),
                    cursor: (document, options) => gatedSync(() =>
                      admitSyncCursor(inner.cursor(document, options), gatedSync)),
                    loadCursor: (spec, options) => gatedSync(() =>
                      admitSyncCursor(inner.loadCursor(spec, options), gatedSync)),
                    asNoTracking: () => untracked,
                  });
                  gatedSyncEntities.set(name, handle);
                }
                return handle;
              },
              saveChanges: entities.size === 0 ? undefined
                : () => gatedSync(() => guard(() => rootWork.tracker.saveChanges())),
              execute: entityEngine === null ? undefined
                : (document, queryOptions) =>
                  gatedSync(() => entityEngine.execute(document, queryOptions)),
              explain: entityEngine === null ? undefined
                : (document, queryOptions) =>
                  gatedSync(() => entityEngine.explain(document, queryOptions)),
              roots: entityEngine === null ? undefined : Object.freeze([...entities.keys()]),
              relations: entityEngine === null ? undefined : entityEngine.relations,
            });
          }
          return chain(jobsEngine === null ? null : jobsEngine.ready, () => {
          if (options.replication !== undefined) {
            replicationEngine = createReplicationEngine({ connection, capture,
              managedTables: [...captureShapes.keys()],
              config: options.replication, model: shapeHash(model), now: runtime.now, bracket: firstOpen,
              rows: createLogicalRows({ connection, shapes: captureShapes, capture,
                collectionCore: coreFor, entityCore: entityCoreFor, captureJoinDelete }),
            });
            store.replication = Object.freeze({
              frontier: lift(() => gated(() => replicationEngine.frontier())),
              page: lift((request) => topLevelTransaction(() => replicationEngine.page(request), request?.signal, undefined, 'immediate')),
              conflicts: lift((request) => gated(() => replicationEngine.conflicts(request), 'replication conflict read', request?.signal)),
              snapshot: lift((request) => topLevelTransaction(() => replicationEngine.snapshot(request), request?.signal, undefined, 'immediate')),
              reset: lift((snapshot, request) => replicationEngine.reset(snapshot, request,
                (fn) => topLevelTransaction(fn, request?.signal, createUnitOfWork(), 'immediate'))),
              apply: lift((envelope, request) => replicationEngine.apply(envelope, request,
                (fn) => topLevelTransaction(fn, request?.signal, createUnitOfWork(), 'immediate'))),
            });
          }
          return chain(replicationEngine === null ? null : replicationEngine.ready, () => Object.freeze(store));
          });
          });
        }))))));

      // Journal-mode lock upgrades may report busy without invoking SQLite's
      // busy handler. Yield before retrying this idempotent startup sequence
      // so another opener can commit. Real elapsed time bounds admission,
      // independently of the injected logical clock; the attempt cap also
      // bounds a backwards clock adjustment. An admitted native call keeps
      // its own busy timeout and cannot be interrupted by this retry window.
      const retryUntil = Date.now() + busyTimeout;
      let openAttempts = 0;
      const attemptOpen = () => {
        openAttempts++;
        const again = (error) => {
          const remaining = retryUntil - Date.now();
          if (!isDriverError(error) || classifyDriverError(error).class !== 'busy'
            || remaining <= 0 || openAttempts >= 32) return failClosed(error);
          const delay = Math.min(remaining,
            backoffDelay({ baseMs: 5, maxMs: 250, random: () => 1 }, openAttempts));
          return sleep(delay).then(() => Date.now() < retryUntil ? attemptOpen() : failClosed(error));
        };
        let opened_;
        try {
          opened_ = opening();
        }
        catch (error) {
          return again(error);
        }
        return isThenable(opened_) ? opened_.then((value) => value, again) : opened_;
      };
      return attemptOpen();
    }));
}
