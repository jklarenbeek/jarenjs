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
import { applyJSONPatch } from '@jarenjs/json/patch';
import { parseJSONPointer } from '@jarenjs/json/pointer';

import { DbCompileError, DbRuntimeError, wrapDriverError, isDriverError, classifyDriverError } from './errors.js';
import { chain, toPromise, isThenable, attempt } from './driver.js';
import { planCollection, planEntity, planJoinTable, verifyShape } from './ddl.js';
import { translatePatch } from './patch-sql.js';
import { createQueryEngine, createQueryState, createEntityQueryEngine, createLoadEngine } from './query.js';
import { admitCursor } from './cursor.js';
import { refuseUnsupportedPragmaKeys, resolvePragmaRequests, configurePragmas } from './pragmas.js';
import { createMaintenance } from './maintenance.js';
import { createBackup } from './backup.js';
import { normalizeProfile } from './profile.js';
import { normalizeEntities, explainMapping } from './model.js';
import { entityCore } from './entity.js';
import { createTracker, membershipKeys } from './tracker.js';
import { createCaptureEngine, DEFAULT_RETENTION } from './capture.js';
import { createLiveRegistry, classifyLiveQuery, LIVE_DEFAULTS } from './live.js';
import { normalizeEventTime } from './live-time.js';
import { createJobEngine } from './jobs.js';
import { collectEntityRoots, entityRoot } from './plan.js';
import {
  DERIVE_KINDS, PHYSICAL_KINDS, PRECISION_MIN, PRECISION_MAX, DIMS_MIN, DIMS_MAX,
  derivedValue, memberAt, storedMemberForm, registerDeriveFunctions,
} from './derive.js';

/** The model format version this store implements. */
export const MODEL_VERSION = '0.1';

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
 * @returns {Map<string, any>} collection name -> normalized collection
 */
export function normalizeModel(model) {
  if (model === null || typeof model !== 'object' || Array.isArray(model))
    throw modelError('JD0005', 'the model document must be an object', '');
  if (model.$model !== MODEL_VERSION) {
    throw modelError('JD0005',
      `the model must declare "$model": "${MODEL_VERSION}"`, '/$model');
  }
  const collections = model.collections;
  if (collections === undefined && model.entities !== undefined) {
    return new Map(); // an entities-only model (§9)
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
 * @returns {any} value-or-promise
 */
function immediately(connection, fn) {
  const dialect = connection.dialect;
  const commit = (value) => chain(connection.exec(dialect.tx.commit), () => value);
  const rollback = (error) => chain(connection.exec(dialect.tx.rollback), () => { throw error; });
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
 * @returns {any} value-or-promise
 */
function ensureShape(connection, collections, plans, readOnly) {
  const dialect = connection.dialect;
  const names = [...collections.keys()];
  // a read-only store creates nothing, and cannot take a write lock
  const bracket = readOnly ? (fn) => fn() : (fn) => immediately(connection, fn);
  return bracket(() => {
    const step = (i) => {
      if (i >= names.length) return null;
      const name = names[i];
      const collection = collections.get(name);
      const plan = plans.get(name);
      return chain(connection.prepare(dialect.introspect.tableExists()), (statement) =>
        chain(statement.get([name]), (row) => {
          if (row === undefined) {
            if (readOnly) {
              throw new DbCompileError('JD0002',
                `collection '${name}': the table does not exist and a read-only store creates nothing`,
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
 * @param {boolean} readOnly
 * @returns {any} value-or-promise
 */
function ensureEntityShape(connection, entityPlans, entities, readOnly) {
  if (entityPlans.size === 0) return null;
  const dialect = connection.dialect;
  const names = [...entityPlans.keys()];
  const bracket = readOnly ? (fn) => fn() : (fn) => immediately(connection, fn);
  return bracket(() => {
    const step = (i) => {
      if (i >= names.length) return null;
      const name = names[i];
      const plan = entityPlans.get(name);
      const docPath = entities.get(name)?.docPath ?? `/entities/${name}`;
      return chain(connection.prepare(dialect.introspect.tableExists()), (statement) =>
        chain(statement.get([name]), (row) => {
          if (row === undefined) {
            if (readOnly) {
              throw new DbCompileError('JD0002',
                `entity '${name}': the table does not exist and a read-only store creates nothing`,
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
                const describe = (fk) => `${fk.column} -> ${fk.references}`
                  + `${fk.targetColumn === null ? '' : `(${fk.targetColumn})`}`
                  + ` ON DELETE ${String(fk.onDelete ?? 'NO ACTION').toUpperCase()}`
                  + ` ON UPDATE ${String(fk.onUpdate ?? 'NO ACTION').toUpperCase()}`;
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
 * Build the per-collection operation core. Every function returns a
 * value or a promise depending on the driver; the async surface lifts
 * once, the sync surface passes through.
 * @param {any} connection
 * @param {any} collection - normalized collection
 * @param {any} plan
 * @param {((doc: any) => any) | null} validate
 * @param {any} queryState - the store-wide statement cache and UDF set
 * @param {{ profile: any }} storeProfileRef - the store-level profile
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
  const prepared = (name, sql) => {
    let statement = statements.get(name);
    if (statement === undefined) {
      statement = connection.prepare(sql);
      statements.set(name, statement);
    }
    return statement;
  };
  const stats = { patchTranslated: 0, patchFallback: 0 };
  const engine = createQueryEngine({
    connection, state: queryState, collection, physicalPlan: plan,
    profile: storeProfileRef.profile,
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
      return extractKey(doc, collection.keySegments, collection.key,
        collection.name, collection.docPath);
    }
    if (explicitKey !== undefined)
      return requireKey(explicitKey, collection.name, collection.docPath);
    if (collection.identity === 'uuid') return runtime.uuid();
    return null; // integer: the database allocates
  };

  const runWrite = (statementName, sql, params, key, reads) => {
    return chain(prepared(statementName, sql), (statement) =>
      attempt(() => (reads ? statement.get(params) : statement.run(params)),
        (error) => wrapWriteError(error, plan, collection.name, collection.docPath, key)));
  };

  const core = {
    stats: () => ({ ...stats, ...engine.stats() }),
    model: collection,
    queryShape: engine.shape,
    // the D2 provider: value-or-promise, deliberately NOT lifted — a
    // synchronous driver answers a linq chain synchronously
    execute: (document, options) => engine.execute(document, options),
    query: (document, options) => engine.query(document, options),
    explain: (document, options) => engine.explain(document, options),
    get(key) {
      requireKey(key, collection.name, collection.docPath);
      // a point read meets the same failures a statement of the query
      // engine does (a corrupt page, a locked file): classified, never raw
      return attempt(() => chain(prepared('get', dialect.dml.get(shape)), (statement) =>
        chain(statement.get([key]),
          (row) => (row === undefined ? undefined : JSON.parse(row.doc)))),
      (error) => wrapDriverError(error, { docPath: collection.docPath, collection: collection.name, key }));
    },
    insert(doc) {
      checkValid(doc);
      const key = resolveWriteKey(doc, undefined);
      if (key === null) {
        return chain(
          runWrite('insertAllocated', dialect.dml.insertAllocated(shape),
            [JSON.stringify(doc), ...derivedFor(doc)], undefined, true),
          (row) => row.key);
      }
      return chain(
        runWrite('insert', dialect.dml.insert(shape),
          [key, JSON.stringify(doc), ...derivedFor(doc)], key, false),
        () => key);
    },
    put(doc, explicitKey) {
      checkValid(doc);
      const key = resolveWriteKey(doc, explicitKey);
      if (key === null) {
        return chain(
          runWrite('insertAllocated', dialect.dml.insertAllocated(shape),
            [JSON.stringify(doc), ...derivedFor(doc)], undefined, true),
          (row) => row.key);
      }
      return chain(
        runWrite('upsert', dialect.dml.upsert(shape),
          [key, JSON.stringify(doc), ...derivedFor(doc)], key, false),
        () => key);
    },
    patch(key, ops) {
      requireKey(key, collection.name, collection.docPath);
      return chain(core.get(key), (current) => {
        if (current === undefined) {
          throw new DbRuntimeError('JD2006',
            `no document to patch under key '${String(key)}'`,
            { docPath: collection.docPath, collection: collection.name, key });
        }
        // the copy-on-write engine validates the RESULT before any SQL
        const next = applyJSONPatch(current, ops);
        checkValid(next);
        const translated = translatePatch(ops, current, dialect);
        if (translated === null) {
          stats.patchFallback++;
          return chain(
            runWrite('patchFallback',
              dialect.dml.updateDoc(shape, dialect.jsonEncode(dialect.parameterRef(1, 'doc')), 2),
              [JSON.stringify(next), ...derivedFor(next), key], key, false),
            () => next);
        }
        stats.patchTranslated++;
        const { expression, params } = translated.build(
          dialect.quoteIdentifier(plan.docColumn), 1);
        const sql = dialect.dml.updateDoc(shape, expression, params.length + 1);
        return chain(prepared(`patch:${sql}`, sql), (statement) =>
          chain(attempt(() => statement.run([...params, ...derivedFor(next), key]),
            (error) => wrapWriteError(error, plan, collection.name, collection.docPath, key)),
          () => next));
      });
    },
    delete(key) {
      requireKey(key, collection.name, collection.docPath);
      return chain(
        runWrite('delete', dialect.dml.del(shape), [key], key, false),
        (result) => Number(result?.changes ?? 0) > 0);
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
    // the provider contract (D2): execute stays value-or-promise so a
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
 * The schema a WRITE validates against. A store-allocated key (`default:
 * "auto"`) is absent from the document the injected hook sees — the
 * database allocates it after validation — so it cannot be required of a
 * write, and the generated input type already marks it optional; every
 * other member is the schema's own, defaults filled (§9.6). The read
 * shape is untouched: the document the store answers carries the key.
 * @param {any} entity - a normalized entity
 * @returns {any}
 */
function writeSchemaOf(entity) {
  const schema = entity.schema;
  const auto = entity.keys.find((key) => entity.properties.get(key).default === 'auto');
  if (auto === undefined || !Array.isArray(schema?.required) || !schema.required.includes(auto))
    return schema;
  const out = { ...schema, required: schema.required.filter((name) => name !== auto) };
  if (out.required.length === 0) delete out.required;
  return out;
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
      }
    }
  }
  if (options.functions !== undefined) functions = { ...functions, ...options.functions };
  if (options.extensions !== undefined) extensions = { ...extensions, ...options.extensions };
  return Object.freeze({ functions, extensions, pushableScalar });
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
 *   `zoneProvider` is D7's injected clock: a named zone in a temporal
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
  try {
    collections = normalizeModel(model);
    entities = normalizeEntities(model);
    mapping = entities.size > 0 ? explainMapping(model) : null;
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
    pragmaRequests = resolvePragmaRequests(options, { memory, readOnly });
  }
  catch (error) {
    return Promise.reject(error);
  }
  const busyTimeout = /** @type {number} */ (pragmaRequests.get('busyTimeout')?.value);
  const storeProfile = options.profile === undefined
    ? null
    : normalizeProfile(options.profile);

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

  return toPromise(chain(
    attempt(() => options.driver.open(path,
      { timeout: busyTimeout, readOnly, queueTimeout: options.queueTimeout }),
    (failure) => (isDriverError(failure) ? openFailure(failure) : failure)),
    (opened) => {
      /**
       * The transaction SCOPE that currently owns the driver connection,
       * or `null`. A top-level `store.transaction()` sets it for the
       * callback's whole lifetime so the collection/entity cores below
       * reach the open transaction instead of queueing behind it.
       * @type {any}
       */
      let scope = null;

      /**
       * The IDENTITY of the scope that is current right now, or `null`.
       * One fresh identity per `withScope` invocation: it is what every
       * transaction view is pinned to (§5.1's exact-scope rule), and the
       * comparison `currentScope === identity` is the whole lifetime
       * check — a view whose identity is not current has either settled
       * or been crossed by an inner scope, and refuses `JD2070` before
       * reading tracker state or issuing a statement. It must never fall
       * through to the root and never follow a newer scope.
       * @type {any}
       */
      let currentScope = null;

      /**
       * What the OPEN transaction owes its in-memory callers once the
       * database has agreed, in registration order, or `null` when no
       * transaction is open. One list, owned by the outermost scope: a
       * nested savepoint remembers only where it started, so rolling it
       * back takes back exactly what it registered and releasing it hands
       * those effects to the scope that outlives it.
       *
       * It exists because an in-memory claim about what the database
       * holds may not become true before the database does — the unit of
       * work's snapshots are such a claim, and a savepoint release is not
       * a commit.
       * @type {{ commit: () => void, rollback: () => void }[] | null}
       */
      let settlements = null;

      /**
       * The unit of work the OPEN scope writes through, and the store's
       * own. A nested savepoint inherits whatever is in force — it is the
       * same unit of work one level down — while a transaction asked for
       * `unitOfWork: 'own'` gets a fresh one for its callback's lifetime.
       * Both are set once the model's cores exist.
       * @type {any}
       */
      let work = null;
      /** @type {any} */
      let rootWork = null;

      /**
       * Run what the open transaction owes on its COMMIT, in registration
       * order, and empty the list. Idempotent, and safe to re-enter: each
       * effect is taken off the list before it runs.
       */
      const flushSettlements = () => {
        if (settlements === null) return;
        for (const effect of settlements.splice(0)) effect.commit?.();
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
       * handles take and a scope-bound handle does not.
       */
      const connection = Object.freeze({
        get synchronous() { return opened.synchronous; },
        get capabilities() { return opened.capabilities; },
        get dialect() { return opened.dialect; },
        /** @param {string} sql */
        exec: (sql) => (scope ?? opened).exec(sql),
        /** @param {string} sql */
        prepare: (sql) => (scope ?? opened).prepare(sql),
        /** Internal transaction users (jobs, checkpoints, migrations)
         * nest when a transaction is open and take the gate when not. */
        transaction: (fn) => withScope((scope ?? opened).transaction, fn),
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
          if (settlements === null) effects.commit?.();
          else settlements.push(effects);
        },
        registerFunction: opened.registerFunction === null ? null
          : (/** @type {string} */ name, /** @type {any} */ o, /** @type {Function} */ fn) =>
            opened.registerFunction(name, o, fn),
        session: opened.session === null ? null
          : (/** @type {any} */ table) => opened.session(table),
        // the online-backup primitives, when the binding has them
        backup: opened.backup ?? null,
        close: () => opened.close(),
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
       */
      function withScope(open, fn, ownWork) {
        return open((inner) => {
          const outer = scope;
          const outerWork = work;
          const outerIdentity = currentScope;
          const outermost = settlements === null;
          if (outermost) settlements = [];
          const list = /** @type {any[]} */ (settlements);
          // where this scope's own effects begin: a rollback takes back
          // from here, and everything before it belongs to a scope that
          // is still open
          const mark = list.length;
          const identity = {};
          scope = inner;
          currentScope = identity;
          if (ownWork !== undefined) work = ownWork;
          const kept = () => {
            if (outermost) flushSettlements();
          };
          const undone = () => {
            const mine = list.splice(mark);
            for (let i = mine.length - 1; i >= 0; i--) mine[i].rollback?.();
          };
          const restore = (settled) => {
            if (settled) kept();
            else undone();
            scope = outer;
            work = outerWork;
            currentScope = outerIdentity;
            if (outermost) settlements = null;
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
          return out.then(
            (value) => { restore(true); return value; },
            (error) => { restore(false); throw error; });
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
      let topLevelTransaction = (fn, signal, ownWork) =>
        withScope((inner) => opened.transaction(inner, signal),
          (inner, identity) => fn(scopedStore(inner, identity)), ownWork);

      /**
       * How a store-level call behaves when another caller's transaction
       * owns the connection: `'wait'` queues behind it under the
       * connection's `queueTimeout`, `'strict'` refuses at once. A host
       * that would rather see the contention than pay for it asks for
       * strict; the default keeps a contended call correct instead of
       * fast.
       */
      const strictTransactions = options.transactions === 'strict';
      if (options.transactions !== undefined && options.transactions !== 'wait'
        && options.transactions !== 'strict') {
        return Promise.reject(new TypeError(
          "openStore: transactions must be 'wait' or 'strict'"));
      }

      /** The refusal a contended store-level call gets when it cannot
       * wait. It names the scope-bound spelling, because a caller that
       * meant to be inside the transaction has one and a caller that did
       * not has to wait for the commit either way. */
      const contended = (why) => new DbCompileError('JD0012',
        `a transaction owns this store's connection and ${why}. Work that belongs `
        + 'INSIDE the transaction goes through the store the callback received '
        + '(tx.collection / tx.entity / tx.saveChanges); work that does not belongs '
        + 'after it commits.');

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
      const gated = (fn, what, signal) => {
        if (strictTransactions && opened.mustQueue)
          throw contended("{ transactions: 'strict' } refuses to queue behind it");
        return withScope((inner) => opened.exclusively(inner, what, signal), fn);
      };

      /** The synchronous surface's gate. It cannot wait — waiting hands
       * a Promise back under a value's type — so a contended call is a
       * refusal whatever the mode. */
      const gatedSync = (fn) => {
        if (opened.mustQueue) {
          throw contended('the synchronous surface answers values, so it cannot '
            + 'wait for the commit');
        }
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
          closing = opened.close();
        }
        catch (closeError) {
          return both(closeError);
        }
        return isThenable(closing)
          ? closing.then(() => Promise.reject(error), both)
          : Promise.reject(error);
      };
      const dialect = connection.dialect;
      // The PHYSICAL MAPPING BRANCH for derived index columns. A driver
      // that can index a registered deterministic function generates
      // them; one that cannot has the store write them. It is a
      // property of the driver that created the file, so a database
      // built under one and opened under the other legitimately reports
      // drift — that is a migration, not an open.
      const derivedMapping = connection.capabilities.deterministicIndexableFunctions === true
        ? 'virtual' : 'stored';
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
            { derived: derivedMapping, rtree: rtreeCapable }));
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

      const opening = () => chain(pragmas(), () =>
        chain(needsDeriveFunctions ? registerDeriveFunctions(connection) : null, () =>
        chain(ensureShape(connection, collections, plans, readOnly), () =>
        chain(ensureEntityShape(connection, entityPlans, entities, readOnly), () => {
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
                { profile: storeProfile }, runtime));
              cores.set(name, core);
            }
            return core;
          };

          // ————— change capture (LIVE-FORMAT §§1–6) —————
          const captureRequested = options.capture === true
            ? {}
            : (options.capture === undefined || options.capture === false
              ? null : options.capture);
          let captureMode = 'none';
          if (captureRequested !== null) {
            const wanted = captureRequested.mode ?? 'auto';
            const hasSessions = connection.capabilities.sessions === true
              && typeof connection.session === 'function';
            if (wanted === 'session' && !hasSessions) {
              throw new TypeError(
                "capture mode 'session' is unavailable on this driver "
                + '(bun:sqlite and some wasm builds ship no session extension) — '
                + "use mode 'journal' or 'auto'");
            }
            captureMode = wanted === 'auto'
              ? (hasSessions ? 'session' : 'journal')
              : wanted;
          }
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
          const capture = captureMode === 'none' ? null : createCaptureEngine({
            connection,
            shapes: captureShapes,
            mode: captureMode,
            log: captureRequested.log === true
              || (captureRequested.log !== undefined && captureRequested.log !== false),
            retention: captureRequested.log?.retention ?? DEFAULT_RETENTION,
            now: runtime.now,
          });
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
            topLevelTransaction = (fn, signal, ownWork) =>
              withScope((inner) => opened.transaction(inner, signal),
                () => capture.nest((innerScope, identity) =>
                  fn(scopedStore(innerScope, identity))),
                ownWork);
          }
          // the live registry rides the capture stream; its dispatcher
          // registers FIRST so maintenance sees every record before any
          // user observer can commit a further write (LIVE-FORMAT §8)
          const liveRegistry = capture === null ? null : createLiveRegistry({
            maxQueries: options.live?.maxQueries ?? LIVE_DEFAULTS.maxQueries,
            maxMaintained: options.live?.maxMaintained ?? LIVE_DEFAULTS.maxMaintained,
          });
          if (capture !== null) {
            capture.observe((record) => /** @type {any} */ (liveRegistry).deliver(record));
          }
          // the durable job queue (JOBS-FORMAT), opt-in per store
          const jobsRequested = options.jobs === true
            || (options.jobs !== undefined && options.jobs !== false);
          const jobsEngine = !jobsRequested ? null : createJobEngine({
            connection,
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
          const refuseAsyncLive = () => {
            if (connection.synchronous !== true) {
              throw new DbCompileError('JD0051',
                'live queries are not maintained over an asynchronous connection — a '
                + 'synchronous driver (node, bun, a synchronous wasm handle) keeps them');
            }
          };
          const registerCollectionLive = (core, document, liveOptions) => {
            refuseAsyncLive();
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
              keyOf: (doc) => String(extractKey(doc, core.model.keySegments,
                core.model.key, core.model.name, core.model.docPath)),
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
                return chain(connection.prepare(sql), (statement) =>
                  chain(statement.all([keyParts[0]]), (rows) => {
                    for (const row of rows) {
                      capture.record(joinName, columns.map((column) => row[column]), undefined, null);
                    }
                    return nextJoin(i + 1);
                  }));
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
            return {
              ...core,
              insert: (doc) => guard(() => chain(core.insert(doc), (key) => {
                if (journal) capture.record(collectionName, [key], null, doc);
                return key;
              })),
              put: (doc, key) => guard(() => (journal
                ? chain(readBefore(core, doc, key), (before) =>
                  chain(core.put(doc, key), (storedKey) => {
                    capture.record(collectionName, [storedKey], before ?? null, doc);
                    return storedKey;
                  }))
                : core.put(doc, key))),
              patch: (key, ops) => guard(() => (journal
                ? chain(core.get(key), (before) =>
                  chain(core.patch(key, ops), (after) => {
                    capture.record(collectionName, [key], before ?? null, after);
                    return after;
                  }))
                : core.patch(key, ops))),
              delete: (key) => guard(() => (journal
                ? chain(core.get(key), (before) =>
                  chain(core.delete(key), (deleted) => {
                    if (deleted && before !== undefined)
                      capture.record(collectionName, [key], before, null);
                    return deleted;
                  }))
                : core.delete(key))),
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
            // D7's injected clock: whether a temporal spec naming a
            // ZONE will compile at all here. Without one the document is
            // refused (`JQ0003`) rather than answered in UTC, and a
            // consumer that wants to know before it asks reads this
            zoneProvider: zoneProvider !== undefined && zoneProvider !== null,
            capture: captureMode,
            captureLog: captureMode !== 'none'
              && (captureRequested.log === true
                || (captureRequested.log !== undefined && captureRequested.log !== false)),
            // maintenance reads rows synchronously; an asynchronous
            // connection is never maintained (LIVE-FORMAT §12) and says so
            live: captureMode !== 'none' && connection.synchronous === true,
            jobs: options.jobs === true
              || (options.jobs !== undefined && options.jobs !== false),
          });

          const queryState = createQueryState(options.statementCacheBound, operators,
            zoneProvider, runtime.now);
          const entityEngine = entities.size > 0
            ? createEntityQueryEngine({ connection, entities, mapping, state: queryState,
              profile: storeProfile })
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
                  profile: storeProfile }, name);
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
                ? options.compileSchema(writeSchemaOf(entity))
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
                  // `execute` stays value-or-promise (D2), as a collection's
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
          work = rootWork;

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

          /** PRAGMA data_version, read wherever the caller is: the store
           * wraps it in the gate, a transaction view in its scope check. */
          const readDataVersion = () => chain(
            connection.prepare(dialect.introspect.dataVersion()),
            (statement) => chain(statement.get([]), (row) => Number(row.v)));

          /** Register an entity-root live query (LIVE-FORMAT §7) — the
           * store's `live` and a transaction view's share one body. */
          const registerEntityLive = (document, liveOptions) => {
            if (liveRegistry === null) {
              throw new DbCompileError('JD0050',
                'live queries require change capture — open the store with { capture: true }');
            }
            refuseAsyncLive();
            if (liveOptions?.eventTime !== undefined) {
              throw new DbCompileError('JD0053',
                'live eventTime maintains a collection view — an entity document re-runs, '
                + 'so a watermark would describe nothing (LIVE-FORMAT §13)');
            }
            const roots = collectEntityRoots(document, entities);
            if (roots.size === 0) {
              throw new TypeError(
                'store.live takes an entity-root document — for a collection, '
                + 'use store.collection(name).live');
            }
            return closeOnRollback(liveRegistry.register({
              name: [...roots].join('+'),
              tables: roots,
              document,
              externals: liveOptions?.externals ?? {},
              demanded: liveOptions?.mode,
              classification: {
                strategy: 'rerun',
                reason: 'entity queries re-run in this version',
              },
              execute: (doc, executeOptions) => entityEngine.execute(doc, executeOptions),
              readRow: null,
              keyOf: null,
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
           * not be lifted (D2). They still answer a promise while another
           * caller's transaction holds the connection — which is what
           * waiting for a commit means.
           * @param {any} handle
           * @param {string[]} names - members that answer a promise
           * @param {string[]} [valued] - members that answer value-or-promise
           */
          const gatedMembers = (handle, names, valued = []) => {
            const out = { ...handle };
            for (const member of names) {
              if (typeof handle[member] !== 'function') continue;
              out[member] = (/** @type {any[]} */ ...args) =>
                lift(() => gated(() => handle[member](...args)))();
            }
            for (const member of valued) {
              if (typeof handle[member] !== 'function') continue;
              out[member] = (/** @type {any[]} */ ...args) =>
                gated(() => handle[member](...args));
            }
            return Object.freeze(out);
          };

          /** @type {Map<string, any>} */
          const gatedCollections = new Map();
          /** @type {Map<string, any>} */
          const gatedEntities = new Map();

          const store = {
            capabilities,
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
                // (preflight, compilation) touches no connection.
                handle = Object.freeze({
                  ...gatedMembers(inner,
                    ['get', 'insert', 'put', 'patch', 'delete', 'explain', 'live'],
                    ['execute']),
                  query: (document, queryOptions) => admitCursor(inner.query(document, queryOptions),
                    gated, queryOptions?.signal, 'a root collection cursor pull'),
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
                // never held across the caller's loop
                handle = gatedMembers(inner,
                  ['create', 'get', 'update', 'delete', 'load', 'page', 'explain'],
                  ['execute']);
                const untracked = gatedMembers(inner.asNoTracking(), ['get', 'load']);
                handle = Object.freeze({
                  ...handle,
                  cursor: (document, queryOptions) => admitCursor(inner.cursor(document, queryOptions),
                    gated, queryOptions?.signal, 'a root entity cursor pull'),
                  loadCursor: (spec, cursorOptions) => admitCursor(inner.loadCursor(spec, cursorOptions),
                    gated, cursorOptions?.signal, 'a root graph cursor pull'),
                  asNoTracking: () => untracked,
                });
                gatedEntities.set(name, handle);
              }
              return handle;
            },
            saveChanges: entities.size === 0 ? undefined
              : lift(() => gated(() => guard(() => rootWork.tracker.saveChanges()))),
            // entity DOCUMENTS query the multi-entity root at the store;
            // `roots` names the entity arrays this provider serves, so a
            // chain asked to iterate the store itself can refuse by name
            execute: entityEngine === null ? undefined
              : (document, queryOptions) =>
                gated(() => entityEngine.execute(document, queryOptions)),
            explain: entityEngine === null ? undefined
              : lift((document, queryOptions) =>
                gated(() => entityEngine.explain(document, queryOptions))),
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
            transaction: lift((fn, transactionOptions) => {
              const wanted = transactionOptions?.unitOfWork;
              if (wanted !== undefined && wanted !== 'own' && wanted !== 'shared') {
                throw new TypeError(
                  "store.transaction: unitOfWork must be 'shared' or 'own'");
              }
              return topLevelTransaction(fn, transactionOptions?.signal,
                wanted === 'own' ? createUnitOfWork() : undefined);
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
              page: (pageOptions) => admitCursor(jobsEngine.page(pageOptions),
                gated, pageOptions?.signal, 'a root job page pull'),
              cancel: lift((id, cancelOptions) => chain(
                gated(() => jobsEngine.cancel(id, cancelOptions), 'a root job cancellation'),
                (outcome) => chain(jobsEngine.settledLocally(id), () => outcome))),
              requeue: lift((...args) => gated(() => jobsEngine.requeue(...args), 'a root job requeue')),
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
              if (liveRegistry !== null) liveRegistry.closeAll();
              return chain(
                jobsEngine === null ? null : jobsEngine.stopAll(closeOptions),
                (stopped) => chain(connection.close(), () => {
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
                }));
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
            if (currentScope === identity) return;
            throw new DbRuntimeError('JD2070',
              'this transaction handle is pinned to a scope that is not current: '
              + 'its transaction settled, or an inner transaction is open. Use the '
              + 'store the LIVE transaction callback received (tx.collection / '
              + 'tx.entity / tx.saveChanges / tx.jobs) — a handle never outlives '
              + 'or crosses its own scope.');
          };

          /**
           * Every stateful member of a scope-view handle, checked against
           * the exact scope before it runs. `lifted` members answer a
           * promise (the check rejects); `direct` members answer values
           * or value-or-promise (the check throws) — the unit-of-work
           * bookkeeping and the D2 provider members among them.
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
                lift(() => {
                  requireScope(identity);
                  return handle[member](...args);
                })();
            }
            for (const member of direct) {
              if (typeof handle[member] !== 'function') continue;
              out[member] = (/** @type {any[]} */ ...args) => {
                requireScope(identity);
                return handle[member](...args);
              };
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
            const step = (/** @type {string} */ member) => () => {
              try {
                requireScope(identity);
              }
              catch (error) {
                return Promise.reject(error);
              }
              return cursor[member]();
            };
            /** @type {any} */
            const wrapped = {
              streaming: cursor.streaming,
              barrier: cursor.barrier,
              next: step('next'),
              return: step('return'),
              [Symbol.asyncIterator]: () => wrapped,
            };
            return Object.freeze(wrapped);
          };

          /** A collection handle pinned to one exact scope, its lazy
           * cursor included. */
          const scopedCollection = (identity, name) => {
            const inner = boundCollection(name);
            const out = scopedMembers(identity, inner,
              ['get', 'insert', 'put', 'patch', 'delete', 'explain', 'live'],
              ['execute']);
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
                ['create', 'get', 'update', 'delete', 'load', 'page', 'explain'],
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
                ['create', 'get', 'update', 'delete', 'load', 'execute', 'explain',
                  'add', 'put', 'remove', 'discard', 'link', 'unlink']),
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
            const myWork = work;
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
             * translated patch with the rows it describes. */
            const nested = (/** @type {any} */ fn) => {
              requireScope(identity);
              return withScope(driverScope.transaction,
                (inner, innerIdentity) => (capture === null
                  ? fn(scopedStore(inner, innerIdentity))
                  : capture.nest(() => fn(scopedStore(inner, innerIdentity)))));
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
            const savepointCreate = (/** @type {string} */ label) => {
              requireScope(identity);
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
                  settleMark: settlements === null ? 0 : settlements.length,
                  captureMark: capture === null ? null : capture.mark(),
                });
                return undefined;
              });
            };
            const savepointRollbackTo = (/** @type {string} */ label) => {
              requireScope(identity);
              const entry = resolveLabel(label, 'rollbackTo');
              // ROLLBACK TO first; only after database success do the
              // in-memory effects follow. The target stays active with
              // the same now-current marks, so repeated rollback is
              // defined; entries created after it are gone from the
              // engine stack and invalidated here.
              return chain(driverScope.rollbackTo(entry.checkpoint), () => {
                if (settlements !== null) {
                  const withdrawn = settlements.splice(entry.settleMark);
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
            };
            const savepointRelease = (/** @type {string} */ label) => {
              requireScope(identity);
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
            };

            const members = {
              transaction: override((/** @type {any} */ fn) => lift(() => nested(fn))()),
              collection: override(collectionFor),
              entity: override(entityFor),
              // THIS scope's bookkeeping, whatever scope is current later
              stats: override(() => ({
                statementCache: { ...queryState.counters },
                udfRegistrations: queryState.registered.size,
                tracker: myWork.tracker === null ? null : myWork.tracker.counts(),
                liveQueries: liveRegistry === null ? 0 : liveRegistry.count(),
              })),
              dataVersion: override(lift(() => {
                requireScope(identity);
                return readDataVersion();
              })),
              savepoints: override(Object.freeze({
                create: lift(savepointCreate),
                rollbackTo: lift(savepointRollbackTo),
                release: lift(savepointRelease),
              })),
              // a transaction view does not own the store lifetime: the
              // member is ABSENT rather than a second way to close the
              // raw connection under its own savepoint
              close: override(undefined),
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
              members.saveChanges = override(lift(() => {
                requireScope(identity);
                return guard(() => myWork.tracker.saveChanges());
              }));
            }
            if (entityEngine !== null) {
              members.execute = override(
                (/** @type {any} */ document, /** @type {any} */ queryOptions) => {
                  requireScope(identity);
                  return entityEngine.execute(document, queryOptions);
                });
              members.explain = override(lift(
                (/** @type {any} */ document, /** @type {any} */ queryOptions) => {
                  requireScope(identity);
                  return entityEngine.explain(document, queryOptions);
                }));
              members.live = override(lift(
                (/** @type {any} */ document, /** @type {any} */ liveOptions) => {
                  requireScope(identity);
                  return registerEntityLive(document, liveOptions);
                }));
            }
            if (capture !== null) {
              members.changesSince = override(lift((/** @type {any} */ after) => {
                requireScope(identity);
                return capture.changesSince(after);
              }));
              if (capture.logged) members.changes = override(Object.freeze({
                bounds: lift(() => {
                  requireScope(identity);
                  return capture.bounds();
                }),
                page: lift((/** @type {any} */ pageOptions) => {
                  requireScope(identity);
                  return capture.page(pageOptions);
                }),
              }));
            }
            if (jobsEngine !== null) {
              // the transactional-outbox spelling: these run as the exact
              // scope, so an enqueue or settlement here co-commits with
              // the domain transaction — and a retained handle is JD2070
              members.jobs = override(Object.freeze({
                enqueue: lift((/** @type {any[]} */ ...args) => {
                  requireScope(identity);
                  return jobsEngine.enqueue(...args);
                }),
                get: lift((/** @type {any[]} */ ...args) => {
                  requireScope(identity);
                  return jobsEngine.get(...args);
                }),
                counts: lift(() => {
                  requireScope(identity);
                  return jobsEngine.counts();
                }),
                claim: lift((/** @type {any[]} */ ...args) => {
                  requireScope(identity);
                  return jobsEngine.claim(...args);
                }),
                renew: lift((/** @type {any[]} */ ...args) => {
                  requireScope(identity);
                  return jobsEngine.renew(...args);
                }),
                complete: lift((/** @type {any[]} */ ...args) => {
                  requireScope(identity);
                  return jobsEngine.complete(...args);
                }),
                fail: lift((/** @type {any[]} */ ...args) => {
                  requireScope(identity);
                  return jobsEngine.fail(...args);
                }),
                // a checkpoint store keeps its creator's SCOPE ownership:
                // its later calls cannot switch scopes, and outlive none
                checkpointsFor: (/** @type {any} */ job) => {
                  const inner = jobsEngine.checkpointsFor(job);
                  return Object.freeze({
                    load: lift((/** @type {any} */ runId) => {
                      requireScope(identity);
                      return inner.load(runId);
                    }),
                    save: lift((/** @type {any} */ runId, /** @type {any} */ nodeId,
                      /** @type {any} */ value) => {
                      requireScope(identity);
                      return inner.save(runId, nodeId, value);
                    }),
                    complete: lift((/** @type {any} */ runId, /** @type {any} */ result) => {
                      requireScope(identity);
                      return inner.complete(runId, result);
                    }),
                  });
                },
                // a worker is a ROOT-owned long-lived component wherever
                // it is created: its future loop takes the store gate and
                // never binds to the transaction that constructed it
                createWorker: jobsEngine.createWorker,
              }));
            }
            if (connection.synchronous && syncCollectionFor !== undefined) {
              /** @type {Map<string, any>} */
              const mySyncCollections = new Map();
              /** @type {Map<string, any>} */
              const mySyncEntities = new Map();
              const forSync = /** @type {(name: string) => any} */ (syncCollectionFor);
              members.sync = override(Object.freeze({
                collection: (/** @type {string} */ name) => {
                  let handle = mySyncCollections.get(name);
                  if (handle === undefined) {
                    handle = Object.freeze(scopedMembers(identity, forSync(name), [],
                      ['get', 'insert', 'put', 'patch', 'delete', 'execute', 'explain']));
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
                transaction: nested,
                savepoints: Object.freeze({
                  create: savepointCreate,
                  rollbackTo: savepointRollbackTo,
                  release: savepointRelease,
                }),
                saveChanges: entities.size === 0 ? undefined
                  : () => {
                    requireScope(identity);
                    return guard(() => myWork.tracker.saveChanges());
                  },
                execute: entityEngine === null ? undefined
                  : (/** @type {any} */ document, /** @type {any} */ queryOptions) => {
                    requireScope(identity);
                    return entityEngine.execute(document, queryOptions);
                  },
                explain: entityEngine === null ? undefined
                  : (/** @type {any} */ document, /** @type {any} */ queryOptions) => {
                    requireScope(identity);
                    return entityEngine.explain(document, queryOptions);
                  },
                roots: entityEngine === null ? undefined : Object.freeze([...entities.keys()]),
                relations: entityEngine === null ? undefined : entityEngine.relations,
              }));
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
                  insert: (/** @type {any} */ doc) => core.insert(doc),
                  put: (/** @type {any} */ doc, /** @type {any} */ key) => core.put(doc, key),
                  patch: (/** @type {any} */ key, /** @type {any} */ ops) => core.patch(key, ops),
                  delete: (/** @type {any} */ key) => core.delete(key),
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
            store.sync = Object.freeze({
              collection(name) {
                let handle = gatedSyncCollections.get(name);
                if (handle === undefined) {
                  handle = syncGatedMembers(forSync(name),
                    ['get', 'insert', 'put', 'patch', 'delete', 'execute', 'explain']);
                  gatedSyncCollections.set(name, handle);
                }
                return handle;
              },
              transaction: (fn) => {
                // the synchronous surface answers values: while a
                // transaction owns the connection it could only QUEUE,
                // which handed a Promise back under a value's type
                if (opened.mustQueue) {
                  throw new DbCompileError('JD0012',
                    'the synchronous transaction cannot wait for the open transaction to '
                    + 'settle — nest through the store the callback received, or use the '
                    + 'asynchronous store.transaction()');
                }
                return topLevelTransaction(fn);
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
                      ['create', 'get', 'update', 'delete', 'load', 'execute', 'explain']),
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
          return chain(capture === null ? null : capture.ready,
            () => chain(jobsEngine === null ? null : jobsEngine.ready,
              () => Object.freeze(store)));
        }))));

      /**
       * The open sequence, with ONE retry when it fails classed busy: the
       * race window is another process's shape transaction on a fresh
       * file, and one retry after it commits is the straggler case the
       * immediate transaction cannot cover (the journal-mode write itself).
       * Every step is idempotent, so a second pass re-applies nothing that
       * matters; a second busy failure propagates classed.
       * @param {boolean} retry
       */
      const attemptOpen = (retry) => {
        const again = (error) => (retry && isDriverError(error)
          && classifyDriverError(error).class === 'busy'
          ? attemptOpen(false)
          : failClosed(error));
        let opened_;
        try {
          opened_ = opening();
        }
        catch (error) {
          return again(error);
        }
        return isThenable(opened_) ? opened_.then((value) => value, again) : opened_;
      };
      return attemptOpen(true);
    }));
}
