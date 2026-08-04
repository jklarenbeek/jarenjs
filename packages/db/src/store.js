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
import { chain, toPromise } from './driver.js';
import { planCollection } from './ddl.js';
import { translatePatch } from './patch-sql.js';

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
  if (collections === null || typeof collections !== 'object'
    || Array.isArray(collections) || Object.keys(collections).length === 0) {
    throw modelError('JD0005',
      'the model must declare at least one collection', '/collections');
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
      indexes.push({
        name: index.name,
        paths,
        unique: index.unique === true,
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
 * Verify an existing table against the planned shape; any difference
 * is `JD0002` and nothing is altered.
 * @param {any} connection
 * @param {any} plan
 * @param {string} collection
 * @param {string} docPath
 * @returns {any} value-or-promise
 */
function verifyShape(connection, plan, collection, docPath) {
  const dialect = connection.dialect;
  const disagree = (difference) => {
    throw new DbCompileError('JD0002',
      `collection '${collection}': the existing table does not match the declared model (${difference}); reshaping a live database is the migration story, and nothing was altered`,
      docPath);
  };
  return chain(connection.prepare(dialect.introspect.columns(plan.table)), (columnsStatement) =>
    chain(columnsStatement.all([]), (columnRows) => {
      const actual = columnRows
        .map((row) => ({
          name: String(row.name),
          type: String(row.type).toUpperCase(),
          generated: Number(row.hidden) !== 0,
        }))
        .sort((a, b) => (a.name < b.name ? -1 : 1));
      const expected = [...plan.expected.columns]
        .map((c) => ({ ...c, type: c.type.toUpperCase() }))
        .sort((a, b) => (a.name < b.name ? -1 : 1));
      if (actual.length !== expected.length)
        disagree(`${actual.length} columns exist, the model declares ${expected.length}`);
      for (let i = 0; i < expected.length; i++) {
        const want = expected[i];
        const have = actual[i];
        if (want.name !== have.name || want.type !== have.type
          || want.generated !== have.generated) {
          disagree(`column '${have.name}' is ${have.type}${have.generated ? ' generated' : ''}, `
            + `the model declares '${want.name}' ${want.type}${want.generated ? ' generated' : ''}`);
        }
      }
      return chain(connection.prepare(dialect.introspect.indexes(plan.table)), (indexesStatement) =>
        chain(indexesStatement.all([]), (indexRows) => {
          const created = indexRows
            .filter((row) => String(row.origin) === 'c')
            .map((row) => ({ name: String(row.name), unique: Number(row.uniq) !== 0 }))
            .sort((a, b) => (a.name < b.name ? -1 : 1));
          const wantedIndexes = plan.expected.indexes;
          if (created.length !== wantedIndexes.length)
            disagree(`${created.length} declared indexes exist, the model declares ${wantedIndexes.length}`);
          const collectColumns = (i) => {
            if (i >= created.length) return null;
            const have = created[i];
            const want = wantedIndexes[i];
            if (have.name !== want.name || have.unique !== want.unique)
              disagree(`index '${have.name}'${have.unique ? ' (unique)' : ''} does not match the declared '${want.name}'`);
            return chain(connection.prepare(dialect.introspect.indexColumns(have.name)), (statement) =>
              chain(statement.all([]), (rows) => {
                const haveColumns = rows.map((row) => String(row.name)).sort();
                if (haveColumns.join(',') !== want.columns.join(','))
                  disagree(`index '${have.name}' covers (${haveColumns.join(', ')}), the model declares (${want.columns.join(', ')})`);
                return collectColumns(i + 1);
              }));
          };
          return collectColumns(0);
        }));
    }));
}

/**
 * Create or verify every collection's physical shape, inside one
 * transaction.
 * @param {any} connection
 * @param {Map<string, any>} collections
 * @param {Map<string, any>} plans
 * @returns {any} value-or-promise
 */
function ensureShape(connection, collections, plans) {
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
 * Build the per-collection operation core. Every function returns a
 * value or a promise depending on the driver; the async surface lifts
 * once, the sync surface passes through.
 * @param {any} connection
 * @param {any} collection - normalized collection
 * @param {any} plan
 * @param {((doc: any) => any) | null} validate
 * @returns {any}
 */
function collectionCore(connection, collection, plan, validate) {
  const dialect = connection.dialect;
  const shape = {
    table: plan.table,
    keyColumn: plan.keyColumn,
    docColumn: plan.docColumn,
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
    stats: () => ({ ...stats }),
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
            [JSON.stringify(doc)], undefined, true),
          (row) => row.key);
      }
      return chain(
        runWrite('insert', dialect.dml.insert(shape),
          [key, JSON.stringify(doc)], key, false),
        () => key);
    },
    put(doc, explicitKey) {
      checkValid(doc);
      const key = resolveWriteKey(doc, explicitKey);
      if (key === null) {
        return chain(
          runWrite('insertAllocated', dialect.dml.insertAllocated(shape),
            [JSON.stringify(doc)], undefined, true),
          (row) => row.key);
      }
      return chain(
        runWrite('upsert', dialect.dml.upsert(shape),
          [key, JSON.stringify(doc)], key, false),
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
              [JSON.stringify(next), key], key, false),
            () => next);
        }
        stats.patchTranslated++;
        const { expression, params } = translated.build(
          dialect.quoteIdentifier(plan.docColumn), 1);
        const sql = dialect.dml.updateDoc(shape, expression, params.length + 1);
        return chain(prepared(`patch:${sql}`, sql), (statement) => {
          try {
            statement.run([...params, key]);
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
      return chain(prepared('delete', dialect.dml.del(shape)), (statement) =>
        chain(statement.run([key]), (result) => Number(result?.changes ?? 0) > 0));
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
 * @returns {any}
 */
function asyncCollection(core) {
  return Object.freeze({
    stats: () => core.stats(),
    get: lift(core.get),
    insert: lift(core.insert),
    put: lift(core.put),
    patch: lift(core.patch),
    delete: lift(core.delete),
  });
}

/**
 * Open (or create) a store described by a model document.
 * @param {any} model - A `jaren-model` document (the 0.1 subset)
 * @param {{ driver: any, path?: string, compileSchema?: Function,
 *   busyTimeout?: number, journalMode?: string }} options
 * @returns {Promise<any>}
 */
export function openStore(model, options) {
  if (options === null || typeof options !== 'object'
    || options.driver === null || typeof options.driver !== 'object'
    || typeof options.driver.open !== 'function')
    throw new TypeError('openStore needs { driver } from @jarenjs/db/node, /bun or /wasm');
  if (options.compileSchema !== undefined && typeof options.compileSchema !== 'function')
    throw new TypeError('openStore: compileSchema must be a function when present');

  // API misuse (above) throws; a defective MODEL rejects, per the
  // asynchronous contract
  let collections;
  try {
    collections = normalizeModel(model);
  }
  catch (error) {
    return Promise.reject(error);
  }
  const path = options.path ?? ':memory:';
  const busyTimeout = options.busyTimeout ?? 5000;
  const journalMode = options.journalMode ?? 'wal';
  const memory = path === ':memory:' || path === '';

  return toPromise(chain(
    options.driver.open(path, { timeout: busyTimeout }),
    (connection) => {
      const dialect = connection.dialect;
      /** @type {Map<string, any>} */
      const plans = new Map();
      for (const [name, collection] of collections)
        plans.set(name, planCollection(name, collection, dialect));

      const pragmas = memory
        ? null
        : chain(connection.exec(dialect.pragma.busyTimeout(busyTimeout)),
          () => connection.exec(dialect.pragma.journalMode(journalMode)));

      return chain(pragmas, () =>
        chain(ensureShape(connection, collections, plans), () => {
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
              core = collectionCore(connection, collection,
                plans.get(name), validate);
              cores.set(name, core);
            }
            return core;
          };

          const capabilities = Object.freeze({
            ...connection.capabilities,
            validated: options.compileSchema !== undefined,
            busyTimeoutMs: memory ? null : busyTimeout,
            journalMode: memory ? null : journalMode,
          });

          /** @type {Map<string, any>} */
          const asyncHandles = new Map();
          const store = {
            capabilities,
            dialect,
            collection(name) {
              let handle = asyncHandles.get(name);
              if (handle === undefined) {
                handle = asyncCollection(coreFor(name));
                asyncHandles.set(name, handle);
              }
              return handle;
            },
            transaction: lift((fn) => connection.transaction(() => fn(store))),
            close: lift(() => connection.close()),
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
                  });
                  syncHandles.set(name, handle);
                }
                return handle;
              },
              transaction: (fn) => connection.transaction(() => fn(store)),
            });
          }
          return Object.freeze(store);
        }));
    }));
}
