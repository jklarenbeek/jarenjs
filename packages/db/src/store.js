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

import { applyJSONPatch } from '@jarenjs/json/patch';
import { parseJSONPointer } from '@jarenjs/json/pointer';

import { DbCompileError, DbRuntimeError } from './errors.js';
import { chain, toPromise, isThenable } from './driver.js';
import { planCollection, planEntity, planJoinTable, verifyShape } from './ddl.js';
import { translatePatch } from './patch-sql.js';
import { createQueryEngine, createQueryState, createEntityQueryEngine, createLoadEngine } from './query.js';
import { normalizeProfile } from './profile.js';
import { normalizeEntities, explainMapping } from './model.js';
import { entityCore } from './entity.js';
import { createTracker } from './tracker.js';
import { createCaptureEngine, DEFAULT_RETENTION } from './capture.js';
import { createLiveRegistry, classifyLiveQuery, LIVE_DEFAULTS } from './live.js';
import { normalizeEventTime } from './live-time.js';
import { createJobEngine } from './jobs.js';
import { collectEntityRoots } from './plan.js';
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
function isDuplicateKey(error, table, keyColumn) {
  if (error?.errcode === 1555) return true;
  return typeof error?.message === 'string'
    && error.message.includes('UNIQUE constraint failed')
    && error.message.includes(`${table}.${keyColumn}`);
}

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
  if (isDuplicateKey(error, plan.table, plan.keyColumn)) {
    return new DbRuntimeError('JD2001',
      `a document already exists under key '${String(key)}'`,
      { docPath, collection, key, cause: error });
  }
  return new DbRuntimeError('JD2005',
    `the database rejected the operation: ${error?.message ?? String(error)}`,
    key === undefined
      ? { docPath, collection, cause: error }
      : { docPath, collection, key, cause: error });
}

/**
 * Create or verify every collection's physical shape, inside one
 * transaction.
 * @param {any} connection
 * @param {Map<string, any>} collections
 * @param {Map<string, any>} plans
 * @returns {any} value-or-promise
 */
function ensureShape(connection, collections, plans, readOnly) {
  const dialect = connection.dialect;
  const names = [...collections.keys()];
  return connection.transaction(() => {
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
              : chain(connection.exec(plan.createSql[j]), () => run(j + 1)));
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
  return connection.transaction(() => {
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
              : chain(connection.exec(plan.createSql[j]), () => run(j + 1)));
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
function collectionCore(connection, collection, plan, validate, queryState, storeProfileRef) {
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
    if (collection.identity === 'uuid') return crypto.randomUUID();
    return null; // integer: the database allocates
  };

  const runWrite = (statementName, sql, params, key, reads) => {
    return chain(prepared(statementName, sql), (statement) => {
      let out;
      try {
        out = reads ? statement.get(params) : statement.run(params);
      }
      catch (error) {
        throw wrapWriteError(error, plan, collection.name, collection.docPath, key);
      }
      return out;
    });
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
      return chain(prepared('get', dialect.dml.get(shape)), (statement) =>
        chain(statement.get([key]),
          (row) => (row === undefined ? undefined : JSON.parse(row.doc))));
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
        return chain(prepared(`patch:${sql}`, sql), (statement) => {
          try {
            statement.run([...params, ...derivedFor(next), key]);
          }
          catch (error) {
            throw wrapWriteError(error, plan, collection.name, collection.docPath, key);
          }
          return next;
        });
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
 *   statementCacheBound?: number, profile?: any, operators?: any,
 *   functions?: any, extensions?: any, zoneProvider?: any,
 *   readOnly?: boolean }} options
 *   `zoneProvider` is D7's injected clock: a named zone in a temporal
 *   spec (`{ "every": "P1M", "zone": "Europe/Amsterdam" }`) is host code
 *   the database cannot have, so a store that never received one refuses
 *   such a document (`JQ0003`) rather than answering it in UTC. It
 *   reaches every residual compilation, which is where the calendar
 *   ladder actually walks.
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
  const busyTimeout = options.busyTimeout ?? 5000;
  const journalMode = options.journalMode ?? 'wal';
  const memory = path === ':memory:' || path === '';
  const readOnly = options.readOnly === true;
  const storeProfile = options.profile === undefined
    ? null
    : normalizeProfile(options.profile);

  return toPromise(chain(
    options.driver.open(path,
      { timeout: busyTimeout, readOnly, queueTimeout: options.queueTimeout }),
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
       * What the cores talk to: the owning transaction's scope while one
       * is open, the driver connection otherwise. One indirection here
       * instead of a parallel set of handles per transaction — and it is
       * why a write inside a transaction callback runs immediately as the
       * owner rather than waiting for a commit it is part of.
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
        registerFunction: opened.registerFunction === null ? null
          : (/** @type {string} */ name, /** @type {any} */ o, /** @type {Function} */ fn) =>
            opened.registerFunction(name, o, fn),
        session: opened.session === null ? null
          : (/** @type {any} */ table) => opened.session(table),
        close: () => opened.close(),
      });

      /**
       * Run `fn` as a transaction opened by `open`, with `scope` bound to
       * it for the callback's whole lifetime and restored afterwards.
       * @param {(inner: (s: any) => any) => any} open - the driver's
       *   `transaction`, gated (top level) or nesting (inner)
       * @param {(store: any) => any} fn
       */
      function withScope(open, fn) {
        return open((inner) => {
          const outer = scope;
          scope = inner;
          const restore = () => { scope = outer; };
          let out;
          try {
            out = fn(scopedStore());
          }
          catch (error) {
            restore();
            throw error;
          }
          if (!isThenable(out)) {
            restore();
            return out;
          }
          return out.then(
            (value) => { restore(); return value; },
            (error) => { restore(); throw error; });
        });
      }

      /** Set once the store object exists; the transaction callback's
       * argument, whose `transaction` NESTS instead of queueing. */
      let scopedStore = () => undefined;

      /**
       * A TOP-LEVEL store transaction. It takes the connection's gate
       * first, so two of them never share a savepoint stack no matter how
       * their callbacks interleave, and the capture scope opens INSIDE it
       * — a rollback then undoes the translated patch together with the
       * rows it describes.
       * @param {(store: any) => any} fn
       */
      let topLevelTransaction = (fn) => withScope(opened.transaction, fn);

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
      const failClosed = (error) => {
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

      const pragmas = chain(
        memory
          ? null
          : chain(connection.exec(dialect.pragma.busyTimeout(busyTimeout)),
            // a journal-mode change writes; a read-only store keeps
            // whatever mode the file already has
            () => (readOnly ? null : connection.exec(dialect.pragma.journalMode(journalMode)))),
        // referential integrity is real only when the pragma is ON —
        // it defaults off, so set it AND verify it per connection
        () => chain(connection.exec(dialect.pragma.foreignKeys(true)), () =>
          chain(connection.prepare(dialect.introspect.foreignKeysOn()), (statement) =>
            chain(statement.get([]), (row) => {
              if (Number(row?.enabled) !== 1) {
                throw new DbCompileError('JD0003',
                  'this connection cannot enforce foreign keys (PRAGMA foreign_keys stayed off)');
              }
              return null;
            }))));

      const opening = () => chain(pragmas, () =>
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
                { profile: storeProfile }));
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
              const pair = joinName.split('_');
              const columns = pair.map((part) => ({ name: `${part}_key`, role: 'key' }));
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
          });
          const guard = capture === null ? (fn) => fn() : capture.wrap;
          if (capture !== null) {
            topLevelTransaction = (fn) => withScope(opened.transaction,
              (tx) => capture.nest(() => fn(tx)));
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
            now: typeof options.jobs === 'object' ? options.jobs.now : undefined,
            random: typeof options.jobs === 'object' ? options.jobs.random : undefined,
            defaults: typeof options.jobs === 'object' ? options.jobs : undefined,
          });
          /** Register a collection live query (LIVE-FORMAT §7). */
          const registerCollectionLive = (core, document, liveOptions) => {
            const externals = liveOptions?.externals ?? {};
            const keyed = core.model.keySegments !== null;
            const eventTime = normalizeEventTime(liveOptions, core.model.name);
            const classification = liveOptions?.mode === 'rerun'
              ? { strategy: 'rerun', reason: 'rerun was requested' }
              : classifyLiveQuery(document, core.queryShape, keyed, eventTime);
            return /** @type {any} */ (liveRegistry).register({
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
            });
          };
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
              const joins = Object.keys(mapping?.joinTables ?? {})
                .filter((joinName) => joinName.split('_').includes(entityName));
              const nextJoin = (i) => {
                if (i >= joins.length) return null;
                const joinName = joins[i];
                const pair = joinName.split('_');
                const sql = `SELECT ${pair.map((part) => dialect.quoteIdentifier(`${part}_key`)).join(', ')} `
                  + `FROM ${dialect.quoteIdentifier(joinName)} `
                  + `WHERE ${dialect.quoteIdentifier(`${entityName}_key`)} = ${dialect.parameterRef(1, 'v')}`;
                return chain(connection.prepare(sql), (statement) =>
                  chain(statement.all([keyParts[0]]), (rows) => {
                    for (const row of rows) {
                      capture.record(joinName,
                        pair.map((part) => row[`${part}_key`]), undefined, null);
                    }
                    return nextJoin(i + 1);
                  }));
              };
              return nextJoin(0);
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
                ? chain(key === undefined ? undefined : core.get(key), (before) =>
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

          const capabilities = Object.freeze({
            ...connection.capabilities,
            validated: options.compileSchema !== undefined,
            busyTimeoutMs: memory ? null : busyTimeout,
            journalMode: memory || readOnly ? null : journalMode,
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
            zoneProvider: options.zoneProvider !== undefined && options.zoneProvider !== null,
            capture: captureMode,
            captureLog: captureMode !== 'none'
              && (captureRequested.log === true
                || (captureRequested.log !== undefined && captureRequested.log !== false)),
            live: captureMode !== 'none',
            jobs: options.jobs === true
              || (options.jobs !== undefined && options.jobs !== false),
          });

          const queryState = createQueryState(options.statementCacheBound, operators,
            options.zoneProvider);
          const entityEngine = entities.size > 0
            ? createEntityQueryEngine({ connection, entities, mapping, state: queryState })
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
                { connection, entities, mapping, state: queryState }, name);
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
                ? options.compileSchema(entity.schema)
                : null;
              core = captureEntity(name, entityCore(connection, entity,
                mapping.entities[name], validate));
              entityCores.set(name, core);
            }
            return core;
          };

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
          // the unit-of-work surface (§11): reads register frozen
          // snapshots; add/put/remove are LOCAL bookkeeping (no
          // database round trip, deliberately synchronous on both
          // surfaces); asNoTracking() reads retain nothing
          const trackedOpsFor = (name) => {
            let ops = trackedOps.get(name);
            if (ops !== undefined) return ops;
            const core = entityCoreFor(name);
            const loads = loadEngineFor(name);
            ops = {
              create: (doc) => chain(core.create(doc),
                (made) => tracker.register(name, made)),
              get: (key) => chain(core.get(key), (doc) =>
                (doc === undefined ? undefined : tracker.register(name, doc))),
              update: (key, changes) => chain(core.update(key, changes),
                (next) => tracker.register(name, next)),
              delete: (key) => chain(core.delete(key), (done) => {
                tracker.discard(name, key);
                return done;
              }),
              load: (spec) => chain(loads.load(spec),
                (docs) => tracker.registerGraph(loads.treeFor(spec), docs)),
              explainLoad: (spec) => loads.explainLoad(spec),
              add: (doc) => tracker.add(name, doc),
              put: (next) => tracker.put(name, next),
              remove: (keyOrDoc) => tracker.remove(name, keyOrDoc),
              discard: (keyOrDoc) => tracker.discard(name, keyOrDoc),
              noTracking: {
                get: (key) => core.get(key),
                load: (spec) => loads.load(spec),
              },
            };
            trackedOps.set(name, ops);
            return ops;
          };

          /** @type {Map<string, any>} */
          const asyncHandles = new Map();
          /** @type {Map<string, any>} */
          const asyncEntityHandles = new Map();
          const store = {
            capabilities,
            stats: () => ({
              statementCache: { ...queryState.counters },
              udfRegistrations: queryState.registered.size,
              tracker: tracker === null ? null : tracker.counts(),
              liveQueries: liveRegistry === null ? 0 : liveRegistry.count(),
            }),
            dialect,
            collection(name) {
              let handle = asyncHandles.get(name);
              if (handle === undefined) {
                handle = asyncCollection(coreFor(name),
                  liveRegistry === null ? null : registerCollectionLive);
                asyncHandles.set(name, handle);
              }
              return handle;
            },
            entity(name) {
              let handle = asyncEntityHandles.get(name);
              if (handle === undefined) {
                const ops = trackedOpsFor(name);
                const untracked = Object.freeze({
                  get: lift((key) => ops.noTracking.get(key)),
                  load: lift((spec) => ops.noTracking.load(spec)),
                });
                handle = Object.freeze({
                  create: lift((doc) => ops.create(doc)),
                  get: lift((key) => ops.get(key)),
                  update: lift((key, changes) => ops.update(key, changes)),
                  delete: lift((key) => ops.delete(key)),
                  load: lift((spec) => ops.load(spec)),
                  explainLoad: ops.explainLoad,
                  add: ops.add,
                  put: ops.put,
                  remove: ops.remove,
                  discard: ops.discard,
                  asNoTracking: () => untracked,
                });
                asyncEntityHandles.set(name, handle);
              }
              return handle;
            },
            saveChanges: entities.size === 0 ? undefined
              : lift(() => guard(() => tracker.saveChanges())),
            // entity DOCUMENTS query the multi-entity root at the store
            execute: entityEngine === null ? undefined
              : (document, queryOptions) => entityEngine.execute(document, queryOptions),
            explain: entityEngine === null ? undefined
              : lift((document, queryOptions) => entityEngine.explain(document, queryOptions)),
            // entity live queries re-run on invalidation — declared,
            // not attempted (LIVE-FORMAT §7)
            live: entityEngine === null ? undefined
              : lift((document, liveOptions) => {
                if (liveRegistry === null) {
                  throw new DbCompileError('JD0050',
                    'live queries require change capture — open the store with { capture: true }');
                }
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
                return liveRegistry.register({
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
                });
              }),
            // A TOP-LEVEL transaction: it takes the connection's gate, so
            // it never shares a savepoint stack with another one. To nest,
            // use the store the callback RECEIVES — the outer store cannot
            // tell an inner transaction from an unrelated caller, and an
            // unrelated caller must wait for the commit.
            transaction: lift((fn) => topLevelTransaction(fn)),
            observe: (fn) => {
              if (capture === null) {
                throw new TypeError(
                  'observe needs capture — open the store with { capture: true }');
              }
              return capture.observe(fn);
            },
            changesSince: capture === null ? undefined
              : lift((after) => capture.changesSince(after)),
            dataVersion: lift(() => chain(
              connection.prepare(dialect.introspect.dataVersion()),
              (statement) => chain(statement.get([]), (row) => Number(row.v)))),
            jobs: jobsEngine === null ? undefined : Object.freeze({
              enqueue: lift(jobsEngine.enqueue),
              get: lift(jobsEngine.get),
              counts: lift(jobsEngine.counts),
              claim: lift(jobsEngine.claim),
              complete: lift(jobsEngine.complete),
              fail: lift(jobsEngine.fail),
              checkpointsFor: jobsEngine.checkpointsFor,
              createWorker: jobsEngine.createWorker,
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

          // The transaction callback's argument. It is the store, with one
          // difference that matters: its `transaction` NESTS through the
          // owning savepoint instead of queueing behind it. Everything
          // else already reaches the open transaction, because the cores
          // read the active scope.
          /** @type {any} */
          let txStore = null;
          /** Nest through the savepoint that owns the connection now. The
           * capture scope goes INSIDE the savepoint, so a rollback undoes
           * the translated patch with the rows it describes. */
          const nested = (/** @type {any} */ fn) => withScope(scope.transaction,
            (tx) => (capture === null ? fn(tx) : capture.nest(() => fn(tx))));
          /** The overriding member on a view of the FROZEN store: plain
           * assignment cannot shadow a non-writable inherited property. */
          const override = (/** @type {any} */ value) =>
            ({ value, writable: false, enumerable: true, configurable: false });
          scopedStore = () => {
            if (txStore === null) {
              const members = { transaction: override(nested) };
              if (store.sync !== undefined) {
                members.sync = override(Object.create(store.sync,
                  { transaction: override(nested) }));
              }
              txStore = Object.freeze(Object.create(store, members));
            }
            return txStore;
          };

          if (connection.synchronous) {
            /** @type {Map<string, any>} */
            const syncHandles = new Map();
            store.sync = Object.freeze({
              collection(name) {
                let handle = syncHandles.get(name);
                if (handle === undefined) {
                  const core = coreFor(name);
                  handle = Object.freeze({
                    stats: () => core.stats(),
                    get: (key) => core.get(key),
                    insert: (doc) => core.insert(doc),
                    put: (doc, key) => core.put(doc, key),
                    patch: (key, ops) => core.patch(key, ops),
                    delete: (key) => core.delete(key),
                    execute: (document, options) => core.execute(document, options),
                    explain: (document, options) => core.explain(document, options),
                  });
                  syncHandles.set(name, handle);
                }
                return handle;
              },
              transaction: (fn) => topLevelTransaction(fn),
              entity(name) {
                const ops = trackedOpsFor(name);
                const untracked = Object.freeze({
                  get: (key) => ops.noTracking.get(key),
                  load: (spec) => ops.noTracking.load(spec),
                });
                return Object.freeze({
                  create: (doc) => ops.create(doc),
                  get: (key) => ops.get(key),
                  update: (key, changes) => ops.update(key, changes),
                  delete: (key) => ops.delete(key),
                  load: (spec) => ops.load(spec),
                  explainLoad: ops.explainLoad,
                  add: ops.add,
                  put: ops.put,
                  remove: ops.remove,
                  discard: ops.discard,
                  asNoTracking: () => untracked,
                });
              },
              saveChanges: entities.size === 0 ? undefined
                : () => guard(() => tracker.saveChanges()),
              execute: entityEngine === null ? undefined
                : (document, queryOptions) => entityEngine.execute(document, queryOptions),
            });
          }
          return chain(capture === null ? null : capture.ready,
            () => chain(jobsEngine === null ? null : jobsEngine.ready,
              () => Object.freeze(store)));
        }))));

      let opened_;
      try {
        opened_ = opening();
      }
      catch (error) {
        return failClosed(error);
      }
      return isThenable(opened_) ? opened_.then((value) => value, failClosed) : opened_;
    }));
}
