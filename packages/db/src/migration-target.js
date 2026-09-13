//@ts-check
/** Acquisition and complete physical acceptance for migration entry points. */
import { isThenable } from '@jarenjs/core/function';
import { chain, toPromise } from './driver.js';
import { DbCompileError } from './errors.js';
import { readSchema } from './introspect.js';
import { ENGINE_TABLES } from './engine-metadata.js';
import { comparableDeclaredSql } from './schema-sql.js';

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
  if (borrowed) return run(target.connection);
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
    try { result = run(connection); }
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
 * @param {any} primary @param {any} shadow @param {any} driver @returns {any} */
export function verifyShadowOwnership(primary, shadow, driver) {
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
 * @param {any} target @returns {{objects:any[],tables:string[]}} */
export function physicalTargetOf(target) {
  const fail = () => { throw new DbCompileError('JD0021', 'physicalTarget requires complete objects and optional owned tables'); };
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
  if (connection.dialect.name !== 'sqlite') throw new DbCompileError('JD0021', 'complete physical target verification is qualified for SQLite');
  const wanted = physicalTargetOf(target);
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
