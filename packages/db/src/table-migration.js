//@ts-check
/** Reviewable schema changes guarded by the observed physical schema. */
import { hashContent } from '@jarenjs/core/string';
import { canonicalizeJson } from '@jarenjs/json/canonical';
import { DbCompileError } from './errors.js';
import { defineTable, planTable, schemaChangeSql } from './dialects/sqlite-schema.js';
import { relationalEmitter, relationalIdentifier as q, sql } from './relational.js';
import { sqliteDialect as dialect, sqliteTableMigration } from './dialects/sqlite.js';
import { sqlTokens } from './dialects/check-read.js';
import { ENGINE_TABLES } from './engine-metadata.js';
import { withForeignKeySettings } from './foreign-key-scope.js';
import { chain } from './driver.js';
import { withMigrationConnection, physicalTargetOf, preservationSchemaOf, checkPhysicalPreservation,
  verifyPreservation, lockMigration } from './migration-target.js';

const refuse = (message) => { throw new DbCompileError('JD0021', message); };
const fingerprint = (v) => canonicalizeJson(v);
const schema = (connection) => connection.prepare(sqliteTableMigration.schema()).all([])
  .filter((v) => !ENGINE_TABLES.has(v.name) && !ENGINE_TABLES.has(v.tbl_name)).map((v) => ({ ...v }));
const createdSql = (text) => text.replace(/^CREATE (TABLE|(?:UNIQUE )?INDEX|TRIGGER) IF NOT EXISTS /i, 'CREATE $1 ');
const owned = (objects, table) => objects.filter((o) => o.tbl_name === table).map((o) => [o.type, o.name, o.sql]).sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
const sync = (connection) => {
  if (connection.dialect.name !== 'sqlite' || !connection.synchronous || connection.mustQueue) refuse('table migration requires an available synchronous SQLite connection');
};

/** Connection settings that govern the meaning of an additive/drop/rename plan. */
function schemaSettings(connection) {
  return ['foreign_keys', 'legacy_alter_table', 'schema_version'].map((name) =>
    connection.prepare(dialect.introspect.pragma(name)).get([])[name]);
}

/** Review one native main-schema change without changing the database.
 * Plans describe one source snapshot; callers own durable migration receipts.
 * @param {any} connection @param {any} operation */
export function planSchemaChange(connection, operation) {
  if (connection.dialect.migration) {
    if (!operation || operation.op !== 'native' || typeof operation.sql !== 'string' || !operation.sql
      || Object.keys(operation).some((key) => !['op', 'table', 'sql', 'target', 'dispositions', 'assertions'].includes(key)))
      refuse('native schema changes require reviewed SQL, target and dispositions');
    return chain(planTableMigration(connection, operation.target, {
      id: `schema_${hashContent(operation.sql)}`, table: operation.table, statements: [operation.sql],
      dispositions: operation.dispositions, assertions: operation.assertions,
    }), (plan) => {
      const { checksum: _checksum, ...body } = plan;
      const result = { ...body, operation: structuredClone(operation), sql: operation.sql };
      return { ...result, checksum: fingerprint(result) };
    });
  }
  sync(connection);
  const text = schemaChangeSql(operation);
  const body = { version: 1, operation: structuredClone(operation), sql: text,
    source: schema(connection), settings: schemaSettings(connection) };
  return { ...body, checksum: fingerprint({ ...body, operation: text }) };
}

/** Apply a reviewed native change atomically, refusing schema/settings drift.
 * Replan after any schema change; only explicit drop ifExists handles absence.
 * @param {any} connection @param {ReturnType<typeof planSchemaChange>} plan */
export function applySchemaChange(connection, plan) {
  if (connection.dialect.migration) {
    if (plan.operation?.op !== 'native' || plan.operation.table !== plan.table
      || plan.sql !== plan.operation.sql || fingerprint(plan.statements) !== fingerprint([plan.sql])
      || fingerprint(plan.physical?.target) !== fingerprint(plan.operation.target)
      || fingerprint(plan.physical?.dispositions) !== fingerprint(plan.operation.dispositions)
      || fingerprint(plan.physical?.assertions) !== fingerprint(plan.operation.assertions ?? []))
      refuse('native schema change differs from its reviewed table plan');
    return applyTableMigration(connection, plan);
  }
  sync(connection);
  const { checksum, ...body } = plan;
  if (body.version !== 1 || checksum !== fingerprint({ ...body, operation: plan.sql }) || plan.sql !== schemaChangeSql(plan.operation)) refuse('schema change checksum or statement differs');
  return connection.transaction(() => {
    const before = schema(connection);
    if (fingerprint(before) !== fingerprint(plan.source) || fingerprint(schemaSettings(connection)) !== fingerprint(plan.settings))
      refuse('source schema or connection settings changed after planning');
    connection.exec(plan.sql);
    return { changed: fingerprint(before) === fingerprint(schema(connection)) ? 0 : 1 };
  }, undefined, 'immediate');
}

/** Inspect a live schema and generate a table plan without changing it.
 * Rebuilds require explicit opt-in. Unlisted indexes and triggers are preserved.
 * @param {any} connection @param {any} definition
 * @param {any} options */
export function planTableMigration(connection, definition, options) {
  if (connection.dialect.migration) return withMigrationConnection({ connection }, (scope) => {
    const target = physicalTargetOf(definition);
    if (!options || typeof options.id !== 'string' || !options.id || typeof options.table !== 'string'
      || target.dialect !== scope.dialect.name || target.schema !== scope.dialect.schema
      || !Array.isArray(options.statements)
      || Object.keys(options).some((key) => !['id', 'table', 'statements', 'dispositions', 'assertions'].includes(key)))
      refuse('native table planning requires id, table, statements, dispositions and a complete native target');
    for (const text of options.statements) scope.dialect.migration.checkSql(text);
    return chain(preservationSchemaOf(scope), (source) => {
      if (![...source, ...target.catalog].some((object) => object.type === 'table' && object.name === options.table))
        refuse('native table planning requires an inventoried source or target table');
      if (options.statements.length && fingerprint(source) === fingerprint(target.catalog))
        refuse('a table plan needs a catalog change; use a receipt-bearing migration for data-only steps');
      const physical = { dialect: target.dialect, schema: target.schema, source,
        target, dispositions: options.dispositions, assertions: options.assertions ?? [] };
      checkPhysicalPreservation(physical, scope.dialect);
      const body = { version: 1, id: options.id, table: options.table, source, after: target.catalog,
        backend: target.dialect, physical, rebuild: false, temporary: `_jaren_native_${hashContent(options.id)}`,
        unchanged: [], statements: [...options.statements], finish: [] };
      return { ...body, checksum: fingerprint(body) };
    });
  });
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
  // INTEGER PRIMARY KEY DESC has a separate primary-key index and a hidden
  // rowid. The declared type alone cannot establish rowid ownership.
  const sourceAlias = rebuild && !tableInfo.wr && oldKey.length === 1
    && oldColumns.find((c) => c.name === oldKey[0]).type.toUpperCase() === 'INTEGER'
    && !connection.prepare(dialect.introspect.indexes(target.name)).all([]).some((index) => index.origin === 'pk');
  const targetAlias = !target.withoutRowid && target.primaryKey?.length === 1
    && target.columns.find((c) => c.name.toLowerCase() === target.primaryKey[0].toLowerCase()).type === 'INTEGER';
  if (rebuild && sourceAlias !== !!targetAlias) refuse('rebuild cannot change rowid ownership');
  if (rebuild && !tableInfo.wr && !sourceAlias) {
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
  const native = !!connection.dialect.migration;
  if (native && typeof connection.exclusively === 'function')
    return withMigrationConnection({ connection }, (scope) => applyTableMigration(scope, plan));
  if (!native) sync(connection);
  const { checksum, ...body } = plan;
  if (body.version !== 1 || checksum !== fingerprint(body)) refuse('table migration checksum differs');
  if (native) {
    if (!Array.isArray(plan.statements) || !Array.isArray(plan.finish) || !Array.isArray(plan.unchanged)
      || plan.backend !== connection.dialect.name || plan.physical?.dialect !== plan.backend || plan.rebuild
      || plan.finish.length || plan.unchanged.length || fingerprint(plan.source) !== fingerprint(plan.physical.source)
      || fingerprint(plan.after) !== fingerprint(plan.physical.target?.catalog)) refuse('native table plan ownership differs');
    checkPhysicalPreservation(plan.physical, connection.dialect);
    for (const text of plan.statements) connection.dialect.migration.checkSql(text);
  }
  else if (plan.backend !== undefined) refuse('table plan belongs to another backend');
  const read = (scope) => native ? preservationSchemaOf(scope) : schema(scope);
  const same = (objects) => fingerprint(native ? objects : owned(objects, plan.table))
    === fingerprint(native ? plan.after : owned(plan.after, plan.table));
  const execute = (scope, statements) => statements.reduce((work, text) => chain(work, () => scope.exec(text)), null);
  const run = () => connection.transaction((transaction) => {
    // Synchronous SQLite retains the caller's instrumented connection. Native
    // async work must use the admitted scope rather than queue behind itself.
    const scope = native ? transaction : connection;
    return chain(lockMigration(scope), () => chain(read(scope), (actual) => {
    if (same(actual)) return { changed: 0 };
    if (fingerprint(actual) !== fingerprint(plan.source)) refuse('source schema changed after planning');
    const sequenceExists = native ? false : scope.prepare(sqliteTableMigration.sequenceExists()).get([]);
    const sequence = sequenceExists ? scope.prepare(sqliteTableMigration.sequence()).get([plan.table]) : null;
    let allocations;
    let work = native ? chain(verifyPreservation(scope, plan.physical, false), (state) => { allocations = state; }) : null;
    work = chain(work, () => execute(scope, plan.statements));
    work = chain(work, () => {
      if (!plan.rebuild) return;
      const from = q(plan.table), to = q(plan.temporary);
      const counts = scope.prepare(`SELECT (SELECT count(*) FROM ${from}) AS a,(SELECT count(*) FROM ${to}) AS b`).get([]);
      if (counts.a !== counts.b) refuse('rebuild changed the row count');
      if (plan.unchanged.length) {
        // Both values and storage classes survive, independent of inherited collation.
        const values = plan.unchanged.flatMap((name) => [`${q(name)} COLLATE BINARY`, `typeof(${q(name)})`]).join(', ');
        const difference = scope.prepare(`SELECT 1 FROM (SELECT ${values} FROM ${from} EXCEPT SELECT ${values} FROM ${to}) LIMIT 1`).get([]);
        if (difference) refuse('rebuild changed a preserved value or storage class');
      }
    });
    work = chain(work, () => execute(scope, plan.finish));
    work = chain(work, () => {
      if (sequence && plan.rebuild) {
        scope.prepare(sqliteTableMigration.raiseSequence()).run([sequence.seq, plan.table]);
        scope.prepare(sqliteTableMigration.seedSequence()).run([plan.table, sequence.seq, plan.table]);
      }
      if (!native && scope.prepare(dialect.pragma.foreignKeyCheck()).get([])) refuse('migration violates foreign-key references');
      return native ? verifyPreservation(scope, plan.physical, true, allocations) : null;
    });
    return chain(work, () => chain(read(scope), (after) => {
      if (!same(after)) refuse('migrated schema differs from the reviewed target');
      return { changed: plan.statements.length + plan.finish.length };
    }));
    }));
  }, undefined, 'immediate');
  if (native) return run();
  if (same(read(connection))) return { changed: 0 };
  return plan.rebuild ? withForeignKeysSuspended(connection, run) : run();
}

/** Explicit outer migration scope for SQLite's foreign-key transition.
 * Always restore the connection settings, including failure and nested scopes.
 * @param {any} connection @param {() => any} fn @returns {any} */
export function withForeignKeysSuspended(connection, fn) {
  sync(connection);
  if (typeof fn !== 'function' || Object.prototype.toString.call(fn) === '[object AsyncFunction]')
    refuse('a physical migration scope requires a synchronous callback');
  return withForeignKeySettings(connection, () => connection.transaction(() => {
      const result = fn();
      if (result != null && typeof result.then === 'function') {
        Promise.resolve(result).catch(() => {});
        refuse('a physical migration scope must settle synchronously');
      }
      if (connection.prepare(dialect.pragma.foreignKeyCheck()).get([])) refuse('migration violates foreign-key references');
      return result;
  }, undefined, 'immediate'));
}
