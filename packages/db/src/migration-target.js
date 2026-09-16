//@ts-check
/** Acquisition and complete physical acceptance for migration entry points. */
import { isThenable } from '@jarenjs/core/function';
import { chain, toPromise } from './driver.js';
import { DbCompileError } from './errors.js';
import { readSchema } from './introspect.js';
import { ENGINE_TABLES } from './engine-metadata.js';
import { comparableDeclaredSql } from './schema-sql.js';
import { canonicalizeJson } from '@jarenjs/json/canonical';

const migrationOwners = new WeakMap();
/** Preserve borrowed-handle identity through an exclusively owned facade.
 * @param {any} connection @returns {any} */
export const migrationOwnerOf = (connection) => migrationOwners.get(connection) ?? connection;

/** Catalog-local names include their owner; column/policy names can repeat.
 * @param {any} object @returns {string} */
export function physicalObjectKey(object) {
  return object.schema === undefined ? `${object.type}:${object.name}`
    : JSON.stringify([object.schema, object.type, object.owner, object.name]);
}

/** Keep synchronous borrowed work synchronous; close only acquired resources.
 * Cleanup failures retain the original failure as well as the close failure.
 * @param {any} target @param {(connection:any)=>any} run @returns {any} */
export function withMigrationConnection(target, run) {
  const borrowed = target?.connection !== undefined;
  if (!target || typeof target !== 'object' || (borrowed
    ? target.driver !== undefined || target.path !== undefined || target.busyTimeout !== undefined
      || typeof target.connection?.prepare !== 'function' || typeof target.connection?.transaction !== 'function'
    : typeof target.driver?.open !== 'function'))
    throw new TypeError('migration target needs { driver, path? } or { connection }');
  const ownedRun = (connection) => connection.dialect?.migration && typeof connection.exclusively === 'function'
    ? connection.exclusively((scope) => {
      const facade = { ...connection, ...scope, mustQueue: false, exclusively: undefined };
      migrationOwners.set(facade, migrationOwnerOf(connection));
      return run(facade);
    }, 'a migration')
    : run(connection);
  if (borrowed) return ownedRun(target.connection);
  return toPromise(chain(target.driver.open(target.path ?? ':memory:', { timeout: target.busyTimeout ?? 5000 }), (connection) => {
    const finish = (value) => chain(connection.close(), () => value);
    const fail = (error) => {
      const both = (closeError) => { throw new AggregateError([error, closeError], 'migration failed and its connection could not close', { cause: error }); };
      let closed;
      try { closed = connection.close(); }
      catch (closeError) { return both(closeError); }
      if (isThenable(closed)) return closed.then(() => { throw error; }, both);
      throw error;
    };
    let result;
    try { result = ownedRun(connection); }
    catch (error) { return fail(error); }
    return isThenable(result) ? result.then(finish, fail) : finish(result);
  }));
}

/** SQLite supplies the main database's canonical filename; private in-memory
 * databases have no filename and cannot be identified by an empty string.
 * @param {any} connection @returns {any} value-or-promise of string or null */
export function sqliteDatabasePath(connection) {
  return chain(connection.prepare(connection.dialect.introspect.pragma('database_list')), (statement) =>
    chain(statement.all([]), (rows) => rows.find((row) => row.name === 'main')?.file || null));
}

/** Reject an alias before any shadow callback or replay statement can write.
 * Native bindings identify files by device/inode; injected SQLite drivers may
 * supply the same hook, with the engine's canonical filename as the fallback.
 * @param {any} primary @param {any} shadow @param {any} driver
 * @param {boolean} [independentDatabase] @returns {any} */
export function verifyShadowOwnership(primary, shadow, driver, independentDatabase = false) {
  if (primary.dialect.migration?.identity) {
    if (primary.dialect.name !== shadow.dialect.name)
      throw new DbCompileError('JD0021', 'shadow replay requires the same database dialect');
    const identify = (connection) => chain(connection.prepare(connection.dialect.migration.identity), (s) => s.get([]));
    return chain(identify(primary), (source) => chain(identify(shadow), (target) => {
      const keys = independentDatabase ? ['database', 'address', 'port'] : ['database', 'address', 'port', 'schema'];
      if (keys.every((key) => source[key] === target[key]))
        throw new DbCompileError('JD0021', 'shadow replay requires independent database ownership');
    }));
  }
  if (primary.dialect.name !== 'sqlite' || shadow.dialect.name !== 'sqlite') return null;
  const identify = typeof driver.databaseIdentity === 'function'
    ? (connection) => driver.databaseIdentity(connection) : sqliteDatabasePath;
  return chain(identify(primary), (source) => chain(identify(shadow), (target) => {
    if (source !== null && source !== undefined && source === target)
      throw new DbCompileError('JD0021', 'shadow replay needs a different database from the primary');
  }));
}

/** Validate a complete owned-program inventory. Omitted tables are derived from
 * object owners; explicit absent table names express reviewed drops.
 * @param {any} target @returns {any} */
export function physicalTargetOf(target) {
  const fail = () => { throw new DbCompileError('JD0021', 'physicalTarget requires complete objects and optional owned tables'); };
  if (target?.dialect === 'postgres') {
    if (typeof target.schema !== 'string' || !target.schema || !Array.isArray(target.catalog)
      || Object.keys(target).some((key) => !['dialect', 'schema', 'catalog'].includes(key))) fail();
    const names = new Set();
    for (const object of target.catalog) {
      if (!object || object.schema !== target.schema
        || Object.keys(object).some((key) => !['schema', 'type', 'name', 'owner', 'sql', 'metadata'].includes(key))
        || ['type', 'name', 'owner'].some((key) => typeof object[key] !== 'string' || !object[key])
        || object.sql !== null && typeof object.sql !== 'string'
        || !object.metadata || typeof object.metadata !== 'object' || Array.isArray(object.metadata)
        || ENGINE_TABLES.has(object.owner) || ENGINE_TABLES.has(object.name)) fail();
      const key = physicalObjectKey(object);
      if (names.has(key)) fail();
      names.add(key);
    }
    canonicalizeJson(target);
    return structuredClone(target);
  }
  if (!target || typeof target !== 'object' || !Array.isArray(target.objects)
    || Object.keys(target).some((k) => !['objects', 'tables'].includes(k))) fail();
  const names = new Set();
  const objects = target.objects.map((object) => {
    if (!object || !['table', 'view', 'index', 'trigger'].includes(object.type)
      || typeof object.name !== 'string' || !object.name || typeof object.owner !== 'string' || !object.owner
      || typeof object.sql !== 'string' || ENGINE_TABLES.has(object.name) || ENGINE_TABLES.has(object.owner)
      || names.has(`${object.type}:${object.name}`)) fail();
    names.add(`${object.type}:${object.name}`);
    return { type: object.type, name: object.name, owner: object.owner,
      sql: comparableDeclaredSql(object.sql) };
  });
  const tables = target.tables ?? [...new Set(objects.map((o) => o.owner))];
  if (!Array.isArray(tables) || new Set(tables).size !== tables.length
    || tables.some((t) => typeof t !== 'string' || !t || ENGINE_TABLES.has(t))
    || objects.some((o) => !tables.includes(o.owner))) fail();
  if (objects.some((o) => ['index', 'trigger'].includes(o.type)
    && !objects.some((t) => ['table', 'view'].includes(t.type) && t.name === o.owner))) fail();
  return { objects, tables };
}

/** One acceptance owner for apply, repeated startup and status. Exact quoted
 * programs and physical column order remain significant; unrelated tables stay
 * outside the reviewed ownership set.
 * @param {any} connection @param {any} target @returns {any} */
export function comparePhysicalTarget(connection, target) {
  const wanted = physicalTargetOf(target);
  if (wanted.dialect !== undefined) {
    if (connection.dialect.name !== wanted.dialect || connection.dialect.schema !== wanted.schema)
      throw new DbCompileError('JD0021', 'native physical target must match the driver-owned dialect and schema');
    return chain(readSchema(connection), (schema) => {
      const actual = new Map(schema.catalog.map((object) => [physicalObjectKey(object), object]));
      for (const object of wanted.catalog) {
        const key = physicalObjectKey(object), have = actual.get(key);
        if (!have) return `missing ${key}`;
        if (canonicalizeJson(object) !== canonicalizeJson(have)) return `different ${key}`;
        actual.delete(key);
      }
      return actual.size ? `unexpected ${actual.keys().next().value}` : null;
    });
  }
  if (connection.dialect.name !== 'sqlite') throw new DbCompileError('JD0021', 'native physical targets require their complete catalog');
  const selection = [...new Set([...wanted.tables, ...wanted.objects.map((o) => o.name)])];
  return chain(readSchema(connection, { tables: selection }), (schema) => {
    const actual = new Map(schema.objects.map((o) => [`${o.type}:${o.name}`, o]));
    for (const object of wanted.objects) {
      const key = `${object.type}:${object.name}`, have = actual.get(key);
      if (!have) return `missing ${key}`;
      if (object.owner !== have.owner || object.sql !== comparableDeclaredSql(have.sql)) return `different ${key}`;
      actual.delete(key);
    }
    return actual.size ? `unexpected ${actual.keys().next().value}` : null;
  });
}

/** Acquire a transaction-scoped backend lock before accepting old receipts.
 * Native lock_timeout is finite and owned/restored by the driver.
 * @param {any} connection @returns {any} */
export function lockMigration(connection) {
  const strategy = connection.dialect.migration;
  if (!strategy) return null;
  return chain(connection.prepare(strategy.settings), (s) => chain(s.get([]), (settings) => {
    if (settings?.strings !== 'on' || !settings.lock_timeout || settings.lock_timeout === '0')
      throw new DbCompileError('JD0021', 'native migrations require standard_conforming_strings and a finite nonzero lock_timeout');
    return chain(connection.prepare(strategy.lock), (lock) => lock.get([]));
  }));
}

/** Preservation compares exact source programs, including whitespace in SQL literals.
 * @param {any} connection @returns {any} */
export function preservationSchemaOf(connection) {
  return chain(readSchema(connection), (schema) => (schema.catalog ?? schema.objects)
    .filter((object) => !ENGINE_TABLES.has(object.name) && !ENGINE_TABLES.has(object.owner)));
}

/** Verify source identity before destructive steps, and every preserved object
 * and fact before publication. The migration transaction owns all these reads.
 * @param {any} connection @param {any} physical @param {boolean} after
 * @param {any[]} [allocations] @returns {any} */
export function verifyPreservation(connection, physical, after, allocations = []) {
  return chain(preservationSchemaOf(connection), (actual) => {
    if (!after && canonicalizeJson(actual) !== canonicalizeJson(physical.source))
      throw new DbCompileError('JD0020', 'the physical source schema changed after the plan was prepared');
    if (after) {
      for (const object of physical.source) {
        const key = physicalObjectKey(object);
        const current = actual.find((o) => physicalObjectKey(o) === key);
        if (physical.dispositions[key] === 'preserve' && canonicalizeJson(current ?? null) !== canonicalizeJson(object))
          throw new DbCompileError('JD0023', `preserved object '${key}' was changed or lost`);
        if (physical.dispositions[key] === 'drop' && current) throw new DbCompileError('JD0023', `declared drop '${key}' remains`);
      }
    }
    const next = (i) => i >= physical.assertions.length ? null
      : chain(connection.prepare(physical.assertions[i].sql, { readOnly: true }), (s) =>
        chain(s.all(physical.assertions[i].params ?? []), (rows) => {
          if (canonicalizeJson(rows) !== canonicalizeJson(physical.assertions[i].expected))
            throw new DbCompileError('JD0023', `preservation assertion ${i} disagrees ${after ? 'after' : 'before'} migration`);
          return next(i + 1);
        }));
    return chain(next(0), () => {
      const sequences = connection.dialect.migration?.sequence
        ? physical.source.filter((object) => object.type === 'sequence' && physical.dispositions[physicalObjectKey(object)] === 'preserve') : [];
      const observed = [];
      const read = (i) => {
        if (i === sequences.length) return observed;
        const object = sequences[i];
        if (object.metadata.cycle) throw new DbCompileError('JD0021', 'cyclic sequence allocation requires an explicit replacement policy');
        return chain(connection.prepare(connection.dialect.migration.sequence(object)), (s) => chain(s.get([]), (state) => {
          if (after) {
            const before = allocations[i];
            const direction = BigInt(object.metadata.increment) > 0n ? 1n : -1n;
            if (!before || (BigInt(state.value) - BigInt(before.value)) * direction < 0n
              || state.value === before.value && before.called === 'true' && state.called !== 'true')
              throw new DbCompileError('JD0023', `preserved sequence '${physicalObjectKey(object)}' allocation moved backwards`);
          }
          observed.push(state);
          return read(i + 1);
        }));
      };
      return read(0);
    });
  });
}

/** Validate serialized preservation independently of the step runner.
 * @param {any} physical @param {any} dialect @returns {void} */
export function checkPhysicalPreservation(physical, dialect) {
  if (physical === undefined) return;
  const fail = () => { throw new DbCompileError('JD0021', 'invalid physical source, dispositions, assertions or steps'); };
  if (!physical || !Array.isArray(physical.source) || !physical.dispositions || !Array.isArray(physical.assertions)) fail();
  if (physical.target !== undefined) physicalTargetOf(physical.target);
  if (physical.dialect !== undefined) {
    if (physical.dialect !== dialect?.name || physical.schema !== dialect.schema
      || physical.target?.dialect !== physical.dialect || physical.target?.schema !== physical.schema) fail();
    physicalTargetOf({ dialect: physical.dialect, schema: physical.schema, catalog: physical.source });
    if ([...physical.source, ...physical.target.catalog].some((object) =>
      object.type === 'table' && object.metadata.kind === 'f'
      || object.type === 'function' && !['f', 'p'].includes(object.metadata.kind)))
      throw new DbCompileError('JD0021', 'native preservation does not qualify foreign tables, aggregates or window-function definitions');
  }
  const keys = physical.source.map((object) => {
    if (!object || typeof object.name !== 'string' || physical.dialect === undefined && !['table', 'view', 'index', 'trigger'].includes(object.type)) fail();
    return physicalObjectKey(object);
  });
  if (new Set(keys).size !== keys.length || Object.keys(physical.dispositions).some((key) => !keys.includes(key))
    || keys.some((key) => !['preserve', 'replace', 'drop'].includes(physical.dispositions[key]))) fail();
  for (const assertion of physical.assertions)
    if (!assertion || typeof assertion.sql !== 'string' || !/^SELECT\b/i.test(assertion.sql.trim())
      || !Array.isArray(assertion.expected) || (assertion.params !== undefined && !Array.isArray(assertion.params))) fail();
}
