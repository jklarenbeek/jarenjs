//@ts-check
/** Reviewable SQLite table rebuilds, guarded by the observed physical schema. */
import { hashContent } from '@jarenjs/core/string';
import { canonicalizeJson } from '@jarenjs/json/canonical';
import { DbCompileError } from './errors.js';
import { defineTable, planTable } from './dialects/sqlite-schema.js';
import { relationalEmitter, relationalIdentifier as q, sql } from './dialects/sqlite-relational.js';
import { sqliteDialect as dialect, sqliteTableMigration } from './dialects/sqlite.js';
import { sqlTokens } from './dialects/check-read.js';

const refuse = (message) => { throw new DbCompileError('JD0021', message); };
const fingerprint = (v) => canonicalizeJson(v);
const schema = (connection) => connection.prepare(sqliteTableMigration.schema()).all([]).map((v) => ({ ...v }));
const createdSql = (text) => text.replace(/^CREATE (TABLE|(?:UNIQUE )?INDEX|TRIGGER) IF NOT EXISTS /i, 'CREATE $1 ');
const owned = (objects, table) => objects.filter((o) => o.tbl_name === table).map((o) => [o.type, o.name, o.sql]).sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
const sync = (connection) => {
  if (connection.dialect.name !== 'sqlite' || !connection.synchronous || connection.mustQueue) refuse('table migration requires an available synchronous SQLite connection');
};

/** Inspect a live schema and generate a table plan without changing it.
 * Rebuilds require explicit opt-in. Unlisted indexes and triggers are preserved.
 * @param {any} connection @param {any} definition
 * @param {{id:string,allowRebuild?:boolean,copy?:Record<string,any>,dropColumns?:string[],dropObjects?:string[]}} options */
export function planTableMigration(connection, definition, options) {
  sync(connection);
  if (!options || typeof options.id !== 'string' || !options.id) refuse('table migration requires an id');
  for (const key of Object.keys(options)) if (!['id', 'allowRebuild', 'copy', 'dropColumns', 'dropObjects'].includes(key)) refuse(`unknown table migration option '${key}'`);
  if (options.allowRebuild !== undefined && typeof options.allowRebuild !== 'boolean') refuse('allowRebuild must be boolean');
  if (options.dropColumns !== undefined && (!Array.isArray(options.dropColumns)
    || options.dropColumns.some((name) => typeof name !== 'string')
    || new Set(options.dropColumns).size !== options.dropColumns.length)) refuse('dropColumns must be a distinct list of names');
  const target = defineTable(definition);
  const source = schema(connection);
  const before = source.filter((o) => o.tbl_name === target.name);
  const existing = before.find((o) => o.type === 'table');
  if (!existing && source.some((o) => o.name === target.name)) refuse('the target name belongs to a non-table schema object');
  const plan = planTable(target);
  const after = plan.createSql.map((text, index) => ({
    type: index === 0 ? 'table' : /^CREATE (?:UNIQUE )?INDEX/.test(text) ? 'index' : 'trigger',
    name: index === 0 ? target.name : (index <= (target.indexes?.length ?? 0)
      ? target.indexes[index - 1].name : target.triggers[index - 1 - (target.indexes?.length ?? 0)].name),
    tbl_name: target.name, sql: createdSql(text),
  }));
  const dropObjects = options.dropObjects ?? [];
  if (!Array.isArray(dropObjects) || new Set(dropObjects).size !== dropObjects.length
    || dropObjects.some((name) => !before.some((o) => o.name === name && o.type !== 'table') || after.some((o) => o.name === name))) refuse('dropObjects must name distinct existing indexes/triggers absent from the target');
  const preserved = before.filter((o) => o.type !== 'table' && !dropObjects.includes(o.name) && !after.some((a) => a.name === o.name));
  after.push(...preserved);
  const equal = fingerprint(owned(before, target.name)) === fingerprint(owned(after, target.name));
  const rebuild = !!existing && !equal;
  if (rebuild && options.allowRebuild !== true) refuse('the table differs; review a plan with allowRebuild:true');
  const temporary = `_jaren_rebuild_${hashContent(fingerprint([options.id, target.name]))}`;
  if (source.some((o) => o.name === temporary)) refuse('the rebuild temporary name already exists');
  const oldColumns = existing ? connection.prepare(dialect.introspect.columns(target.name)).all([]) : [];
  const oldKey = oldColumns.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
  if (rebuild && sqlTokens(existing.sql).some((t) => t.kind === 'word' && t.value.toUpperCase() === 'AUTOINCREMENT')
    && !target.columns.some((c) => c.identity === 'autoincrement')) refuse('rebuild must preserve AUTOINCREMENT allocation');
  if (rebuild && (oldKey.length !== (target.primaryKey?.length ?? 0)
    || oldKey.some((name) => !target.primaryKey.includes(name)))) refuse('rebuild must preserve every primary-key column');
  const dropped = oldColumns.filter((c) => !target.columns.some((t) => t.name === c.name)).map((c) => c.name);
  if (fingerprint([...dropped].sort()) !== fingerprint([...(options.dropColumns ?? [])].sort())) refuse('every removed source column needs an explicit dropColumns disposition');
  const copy = options.copy ?? {};
  if (!copy || typeof copy !== 'object' || Array.isArray(copy)) refuse('copy must be an assignment object');
  for (const key of Object.keys(copy)) if (!target.columns.some((c) => c.name === key && c.generated === undefined) || oldKey.includes(key)) refuse('copy targets a writable non-key column');
  const writable = target.columns.filter((c) => c.generated === undefined
    && (Object.hasOwn(copy, c.name) || oldColumns.some((old) => old.name === c.name)));
  if (rebuild && !writable.length) refuse('rebuild needs columns to copy');
  const names = writable.map((c) => c.name);
  const expressions = writable.map((c) => Object.hasOwn(copy, c.name) ? copy[c.name] : sql.column(c.name));
  const unchanged = writable.filter((c) => !Object.hasOwn(copy, c.name)).map((c) => c.name);
  // Preserve hidden rowids too, including text/composite-key rowid tables.
  const tableInfo = existing ? connection.prepare(sqliteTableMigration.tableList()).all([]).find((t) => t.schema === 'main' && t.name === target.name) : null;
  if (rebuild && !!tableInfo.wr !== !!target.withoutRowid) refuse('rebuild cannot change rowid ownership');
  if (rebuild && !tableInfo.wr && !(oldKey.length === 1 && oldColumns.find((c) => c.name === oldKey[0]).type.toUpperCase() === 'INTEGER')) {
    const rowid = ['rowid', '_rowid_', 'oid'].find((name) => !oldColumns.some((c) => c.name.toLowerCase() === name)
      && !target.columns.some((c) => c.name.toLowerCase() === name));
    if (!rowid) refuse('the source shadows every rowid alias');
    names.unshift(rowid); expressions.unshift(sql.column(rowid)); unchanged.unshift(rowid);
  }
  const emitter = relationalEmitter({ inline: true });
  const statements = equal ? [] : !existing ? [...plan.createSql] : [
    planTable({ ...target, name: temporary, indexes: [], triggers: [] }).createSql[0],
    `INSERT INTO ${q(temporary)} (${names.map(q).join(', ')}) SELECT ${expressions.map((v) => emitter.expr(v)).join(', ')} FROM ${q(target.name)}`,
  ];
  const finish = rebuild ? [`DROP TABLE ${q(target.name)}`, `ALTER TABLE ${q(temporary)} RENAME TO ${q(target.name)}`,
    ...plan.createSql.slice(1), ...preserved.map((o) => o.sql)] : [];
  const body = { version: 1, id: options.id, table: target.name, source, after, rebuild, temporary, unchanged, statements, finish };
  return { ...body, checksum: fingerprint(body) };
}

/** Run a generated plan atomically. A repeated completed plan changes nothing.
 * A rebuild with enabled foreign keys must start outside a transaction; call
 * withForeignKeysSuspended for an outer scope containing nested rebuilds.
 * @param {any} connection @param {ReturnType<typeof planTableMigration>} plan */
export function applyTableMigration(connection, plan) {
  sync(connection);
  const { checksum, ...body } = plan;
  if (body.version !== 1 || checksum !== fingerprint(body)) refuse('table migration checksum differs');
  if (fingerprint(owned(schema(connection), plan.table)) === fingerprint(owned(plan.after, plan.table))) return { changed: 0 };
  const run = () => connection.transaction(() => {
    const actual = schema(connection);
    if (fingerprint(owned(actual, plan.table)) === fingerprint(owned(plan.after, plan.table))) return { changed: 0 };
    if (fingerprint(actual) !== fingerprint(plan.source)) refuse('source schema changed after planning');
    const sequenceExists = connection.prepare(sqliteTableMigration.sequenceExists()).get([]);
    const sequence = sequenceExists ? connection.prepare(sqliteTableMigration.sequence()).get([plan.table]) : null;
    for (const statement of plan.statements) connection.exec(statement);
    if (plan.rebuild) {
      const from = q(plan.table), to = q(plan.temporary);
      const counts = connection.prepare(`SELECT (SELECT count(*) FROM ${from}) AS a,(SELECT count(*) FROM ${to}) AS b`).get([]);
      if (counts.a !== counts.b) refuse('rebuild changed the row count');
      if (plan.unchanged.length) {
        // Both values and storage classes must survive; BINARY prevents
        // inherited NOCASE from hiding a changed byte sequence.
        const values = plan.unchanged.flatMap((name) => [`${q(name)} COLLATE BINARY`, `typeof(${q(name)})`]).join(', ');
        const difference = connection.prepare(`SELECT 1 FROM (SELECT ${values} FROM ${from} EXCEPT SELECT ${values} FROM ${to}) LIMIT 1`).get([]);
        if (difference) refuse('rebuild changed a preserved value or storage class');
      }
    }
    for (const statement of plan.finish) connection.exec(statement);
    if (sequence && plan.rebuild) {
      connection.prepare(sqliteTableMigration.raiseSequence()).run([sequence.seq, plan.table]);
      connection.prepare(sqliteTableMigration.seedSequence()).run([plan.table, sequence.seq, plan.table]);
    }
    if (connection.prepare(dialect.pragma.foreignKeyCheck()).get([])) refuse('migration violates foreign-key references');
    if (fingerprint(owned(schema(connection), plan.table)) !== fingerprint(owned(plan.after, plan.table))) refuse('migrated schema differs from the reviewed target');
    return { changed: plan.statements.length + plan.finish.length };
  }, { mode: 'immediate' });
  return plan.rebuild ? withForeignKeysSuspended(connection, run) : run();
}

/** Explicit outer migration scope for SQLite's foreign-key transition.
 * Always restore the connection settings, including failure and nested scopes.
 * @param {any} connection @param {() => any} fn @returns {any} */
export function withForeignKeysSuspended(connection, fn) {
  sync(connection);
  if (typeof fn !== 'function' || Object.prototype.toString.call(fn) === '[object AsyncFunction]')
    refuse('a physical migration scope requires a synchronous callback');
  const foreignKeys = connection.prepare(dialect.introspect.pragma('foreign_keys')).get([]).foreign_keys;
  const legacy = connection.prepare(dialect.introspect.pragma('legacy_alter_table')).get([]).legacy_alter_table;
  try {
    connection.exec(dialect.pragma.foreignKeys(false));
    if (connection.prepare(dialect.introspect.pragma('foreign_keys')).get([]).foreign_keys !== 0) refuse('foreign_keys cannot change inside a transaction; establish the outer migration scope first');
    connection.exec(dialect.pragma.set('legacy_alter_table', 'ON'));
    return connection.transaction(() => {
      const result = fn();
      if (result != null && typeof result.then === 'function') {
        Promise.resolve(result).catch(() => {});
        refuse('a physical migration scope must settle synchronously');
      }
      if (connection.prepare(dialect.pragma.foreignKeyCheck()).get([])) refuse('migration violates foreign-key references');
      return result;
    }, { mode: 'immediate' });
  }
  finally {
    connection.exec(dialect.pragma.set('legacy_alter_table', legacy ? 'ON' : 'OFF'));
    connection.exec(dialect.pragma.foreignKeys(!!foreignKeys));
  }
}
