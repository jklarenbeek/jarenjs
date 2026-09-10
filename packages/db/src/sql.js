//@ts-check
/** Trusted prepared statements, restricted to a live transaction's authority. */
import { sqlTokens } from './dialects/check-read.js';
import { chain, attempt } from './driver.js';
import { DbRuntimeError, wrapDriverError } from './errors.js';

/** @param {any} context @returns {any} a scoped SQL capability */
export function trustedSql({ connection, requireScope, beforeWrite, afterWrite, readOnly }) {
  return Object.freeze({
    /** Compile one statement. Access is explicit; this is trusted application SQL,
     * not a sandbox for untrusted query text or side-effecting host functions.
     * @param {string} sql @param {{ access: 'read' | 'write', affects?: readonly string[] }} options */
    prepare(sql, options) {
      requireScope();
      const refuse = (why) => { throw new DbRuntimeError('JD2095', why); };
      if (typeof sql !== 'string' || !['read', 'write'].includes(options?.access)) refuse('SQL prepare requires text and explicit read/write access');
      const tokens = sqlTokens(sql);
      const words = tokens.filter((t) => t.kind === 'word').map((t) => t.value.toUpperCase());
      if (!tokens.length || tokens[0].kind !== 'word' || !['SELECT', 'WITH', 'INSERT', 'UPDATE', 'DELETE', 'REPLACE'].includes(words[0])) refuse('trusted SQL accepts a single SELECT or data mutation');
      if (tokens.some((t, i) => t.value === ';' && t.kind === 'symbol' && i !== tokens.length - 1)
        || words.some((w) => /^(?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|ATTACH|DETACH|PRAGMA|CREATE|ALTER|DROP|VACUUM)$/.test(w))) refuse('SQL cannot change transaction ownership, schema or connection configuration');
      const writing = options.access === 'write';
      if (!writing && words.some((w) => ['INSERT', 'UPDATE', 'DELETE', 'REPLACE'].includes(w))) refuse('a mutation requires write access');
      if (writing && readOnly) refuse('this store grants no SQL write authority');
      if (options.affects !== undefined && (!Array.isArray(options.affects) || options.affects.some((v) => typeof v !== 'string'))) refuse('affects is an array of entity names');
      let closed = false;
      const check = () => {
        requireScope();
        if (closed) refuse('the prepared SQL statement is closed');
      };
      const statement = connection.prepare(sql, { readOnly: !writing });
      const run = (method, params = []) => {
        check();
        if (!Array.isArray(params)) refuse('SQL parameters must be an array');
        return attempt(() => chain(statement, (s) => {
          check();
          if (writing) beforeWrite(options.affects);
          return chain(s[method](params), (result) => {
            if (writing) afterWrite(options.affects);
            return result;
          });
        }), (error) => wrapDriverError(error, { docPath: '/sql' }));
      };
      return Object.freeze({ run: (params) => run('run', params),
        get: (params) => run('get', params), all: (params) => run('all', params),
        close: () => { requireScope(); closed = true; } });
    },
  });
}

/** A synchronous transaction ends at callback return, including a thenable return.
 * @param {Function} fn @param {any} tx @returns {any} */
export function synchronousBody(fn, tx) {
  const value = fn(tx);
  if (value != null && typeof value.then === 'function') {
    Promise.resolve(value).catch(() => {});
    throw new DbRuntimeError('JD2095', 'a synchronous transaction callback must not return a thenable');
  }
  return value;
}
