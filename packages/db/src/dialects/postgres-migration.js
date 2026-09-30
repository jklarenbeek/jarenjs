//@ts-check
/** Native migration vocabulary and session facts; execution belongs to migrate. */
import { DbCompileError } from '../errors.js';
import { sqlTokens, quotedSqlToken } from './check-read.js';
import { POSTGRES_LOCK_CLASSES, transactionLock } from './postgres-locks.js';

/** Native opaque tokens plug into the shared lexer without entering SQLite builds.
 * @param {string} sql @param {number} at @returns {any} */
export function postgresSqlToken(sql, at) {
  if (sql.startsWith('/*', at)) {
    let depth = 1, end = at + 2;
    while (end < sql.length && depth) {
      if (sql.startsWith('/*', end)) { depth++; end += 2; }
      else if (sql.startsWith('*/', end)) { depth--; end += 2; }
      else end++;
    }
    return depth ? null : { kind: 'comment', end };
  }
  if ((sql[at] === 'e' || sql[at] === 'E') && sql[at + 1] === "'") return quotedSqlToken(sql, at + 1, true);
  if (sql[at] !== '$') return;
  const delimiter = /^\$(?:[A-Za-z_\u0080-\uffff][A-Za-z_0-9\u0080-\uffff]*)?\$/.exec(sql.slice(at))?.[0];
  if (!delimiter) return;
  const start = at + delimiter.length, end = sql.indexOf(delimiter, start);
  return end < 0 ? null : { kind: 'string', value: sql.slice(start, end), end: end + delimiter.length };
}

/** A reviewed step cannot escape its transaction or request an operational phase.
 * Dollar bodies and escaped strings are indivisible tokens, never reformatted.
 * @param {string} sql */
function checkSql(sql) {
  const tokens = typeof sql === 'string' ? sqlTokens(sql, postgresSqlToken) : [];
  const words = tokens.filter((t) => t.kind === 'word').map((t) => t.value.toUpperCase());
  if (!['CREATE', 'ALTER', 'DROP', 'INSERT', 'UPDATE', 'DELETE', 'WITH', 'MERGE', 'GRANT', 'REVOKE', 'COMMENT', 'TRUNCATE'].includes(words[0])
    || words.some((word) => ['COMMIT', 'ROLLBACK', 'SAVEPOINT', 'RELEASE', 'BEGIN', 'CONCURRENTLY'].includes(word))
    || ['CREATE', 'ALTER', 'DROP'].includes(words[0]) && ['DATABASE', 'TABLESPACE', 'SUBSCRIPTION', 'SYSTEM', 'EXTENSION', 'ROLE', 'USER'].includes(words[1])
    || tokens.some((token, i) => token.kind === 'symbol' && token.value === ';' && i !== tokens.length - 1))
    throw new DbCompileError('JD0021', 'PostgreSQL migration steps require one transactional statement; concurrent or operational phases are separate');
}

/** SQL is schema-scoped through the driver's selected session, without a
 * persistent advisory lock surviving client release. lock_timeout bounds waits.
 * The lock is keyed by the session's current schema, as every other class
 * is: the driver's search path puts the store's schema first, and a session
 * the host left on its own path still has one (a list of schemas is no key). */
export function postgresMigration() {
  const quote = (name) => `"${name.replaceAll('"', '""')}"`;
  return Object.freeze({
    checkSql,
    lock: transactionLock(POSTGRES_LOCK_CLASSES.migration),
    settings: "SELECT current_setting('standard_conforming_strings') AS strings, current_setting('lock_timeout') AS lock_timeout",
    identity: "SELECT current_database() AS database, inet_server_addr()::text AS address, inet_server_port() AS port, current_schema() AS schema",
    sequence: (object) => `SELECT last_value::text AS value, is_called::text AS called FROM ${quote(object.schema)}.${quote(object.name)}`,
  });
}
