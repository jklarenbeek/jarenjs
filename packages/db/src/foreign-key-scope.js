//@ts-check
/** SQLite's connection settings belong outside the transaction they govern. */
import { isThenable } from '@jarenjs/core/function';
import { chain } from './driver.js';
import { DbCompileError } from './errors.js';

/** Suspend enforcement and legacy rewrites for a caller-owned transaction,
 * restoring the exact original settings after success or failure. The caller
 * still must run foreign_key_check before committing. Value-or-promise, so both
 * synchronous table helpers and asynchronous migration drivers share one bracket.
 * @param {any} connection @param {()=>any} fn @returns {any} */
export function withForeignKeySettings(connection, fn) {
  const dialect = connection.dialect;
  const read = (name) => chain(connection.prepare(dialect.introspect.pragma(name)), (s) => chain(s.get([]), (row) => row[name]));
  return chain(read('foreign_keys'), (foreignKeys) => chain(read('legacy_alter_table'), (legacy) => {
    const restore = () => {
      const errors = [];
      const attempt = (sql) => {
        try {
          const result = connection.exec(sql);
          return isThenable(result) ? result.then(() => undefined, (error) => { errors.push(error); }) : undefined;
        }
        catch (error) { errors.push(error); return undefined; }
      };
      // These settings are independent: a failed legacy restoration must
      // not prevent the attempt to re-enable foreign-key enforcement.
      return chain(attempt(dialect.pragma.set('legacy_alter_table', legacy ? 'ON' : 'OFF')),
        () => chain(attempt(dialect.pragma.foreignKeys(!!foreignKeys)), () => errors));
    };
    const finish = (value) => chain(restore(), (errors) => {
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, 'migration connection settings could not be restored');
      return value;
    });
    const fail = (error) => chain(restore(), (errors) => {
      if (errors.length > 0) throw new AggregateError([error, ...errors],
        'migration failed and its connection settings could not be restored', { cause: error });
      throw error;
    });
    let result;
    try {
      result = chain(connection.exec(dialect.pragma.foreignKeys(false)), () => chain(read('foreign_keys'), (actual) => {
        if (actual !== 0) throw new DbCompileError('JD0021', 'foreign_keys cannot change inside a transaction; establish the outer migration scope first');
        return chain(connection.exec(dialect.pragma.set('legacy_alter_table', 'ON')), fn);
      }));
    }
    catch (error) { return fail(error); }
    return isThenable(result) ? result.then(finish, fail) : finish(result);
  }));
}
