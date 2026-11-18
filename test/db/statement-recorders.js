//@ts-check
/**
 * @file Statement recorders for the job schedule tests: a SQLite driver
 * and a PostgreSQL pool that record the text of every statement they run,
 * below the store, so nothing it prepares or caches is missed.
 */
import { DatabaseSync } from 'node:sqlite';
import { sqliteDialect } from '@jarenjs/db';
import { adaptNodeDatabase } from '@jarenjs/db/node';

/** Record a statement's text each time it runs. @param {any} statement @param {string} sql @param {string[]} ran */
const watch = (statement, sql, ran) => new Proxy(statement, { get(target, member) {
  const value = Reflect.get(target, member);
  if (typeof value !== 'function') return value;
  return ['run', 'get', 'all', 'iterate'].includes(String(member))
    ? (/** @type {any[]} */ ...args) => { ran.push(sql); return value.apply(target, args); } : value.bind(target);
} });

/**
 * A SQLite driver that records every statement the database runs, at the
 * binding: below the store, so nothing it prepares or caches is missed.
 * @param {string[]} ran
 */
export const recordingSqlite = (ran) => ({
  name: 'node-sqlite', dialect: sqliteDialect,
  open: (/** @type {string} */ dbPath, /** @type {any} */ options) => {
    const db = new DatabaseSync(dbPath, options?.timeout === undefined ? {} : { timeout: options.timeout });
    return adaptNodeDatabase({
      exec: (/** @type {string} */ sql) => { ran.push(sql); return db.exec(sql); },
      prepare: (/** @type {string} */ sql) => watch(db.prepare(sql), sql, ran),
      function: (/** @type {string} */ name, /** @type {any} */ o, /** @type {any} */ fn) => db.function(name, o, fn),
      aggregate: (/** @type {string} */ name, /** @type {any} */ spec) => db.aggregate(name, spec),
      createSession: (/** @type {any} */ o) => (o === undefined ? db.createSession() : db.createSession(o)),
      close: () => db.close(),
    });
  },
});

/**
 * A PostgreSQL pool that records every statement its clients send.
 * @param {any} target @param {string[]} ran
 */
export const recordingPool = (target, ran) => {
  /** @param {any} query */
  const record = (query) => { ran.push(typeof query === 'string' ? query : query?.text); };
  /** @param {any} client */
  const wrapClient = (client) => new Proxy(client, { get(object, member) {
    const value = Reflect.get(object, member);
    if (member === 'query') return (/** @type {any[]} */ ...args) => { record(args[0]); return value.apply(object, args); };
    return typeof value === 'function' ? value.bind(object) : value;
  } });
  return new Proxy(target, { get(object, member) {
    const value = Reflect.get(object, member);
    if (member === 'connect') return async () => wrapClient(await value.call(object));
    if (member === 'query') return (/** @type {any[]} */ ...args) => { record(args[0]); return value.apply(object, args); };
    return typeof value === 'function' ? value.bind(object) : value;
  } });
};

