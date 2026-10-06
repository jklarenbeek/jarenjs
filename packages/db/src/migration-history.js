//@ts-check
/** Exact migration authority. Normal history remains immutable; side receipts
 * bind canonical documents to losslessly observed rows in their stored order. */
import { canonicalizeJson } from '@jarenjs/json/canonical';
import { hashContent } from '@jarenjs/core/string';
import { chain, useStatementOnce } from './driver.js';
import { DbCompileError } from './errors.js';
import { HISTORY_TABLE, MIGRATION_IDENTITY_TABLE } from './engine-metadata.js';
import { comparableDeclaredSql } from './schema-sql.js';
import { checkMigrationDocument, checkMigrationStructure } from './document-steps.js';
import { modelIdentity } from './migration-identity.js';
import { physicalTargetOf } from './migration-target.js';

const FIELDS = ['id', 'applied_at', 'from_hash', 'to_hash', 'checksum', 'steps'];
const SIGNED_INTEGER = /^(?:0|-?[1-9]\d*)$/;
const COUNT = /^(?:0|[1-9]\d*)$/;
const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/** @param {string} reason @returns {never} */
function invalid(reason) { throw new DbCompileError('JD0022', reason); }

/** Exact closed records, including records decoded from untrusted stored JSON. */
function keys(value, names) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === names.length && names.every((name) => Object.hasOwn(value, name));
}

/** @param {any} text @param {string} label @returns {any} */
function parseCanonical(text, label) {
  try {
    if (typeof text !== 'string') invalid(`${label} must contain canonical JSON text`);
    const value = JSON.parse(text);
    if (canonicalizeJson(value) !== text) invalid(`${label} is not canonical JSON text`);
    return value;
  }
  catch (error) {
    if (error?.code === 'JD0022') throw error;
    invalid(`${label} is not supported canonical JSON`);
  }
}

/** The unchanged persisted short checksum, never an exact identity. */
export function migrationChecksum(migration) { return hashContent(canonicalizeJson(migration)); }

/** Shared dialect builders for original rows and exact side receipts. */
export function historyStatements(dialect) {
  const q = dialect.quoteIdentifier, text = dialect.typeFor('string', 'key');
  const integer = dialect.typeFor('integer', 'key');
  const order = dialect.identityColumn?.name ?? 'rowid';
  const columns = FIELDS.map((name) => ({ name,
    type: name === 'applied_at' || name === 'steps' ? integer : text,
    ...(name === 'id' ? { primaryKey: true } : {}) }));
  const sideColumns = [{ name: 'key', type: text, primaryKey: true }, { name: 'value', type: text }];
  const insert = (table, names) => `INSERT INTO ${q(table)} (${names.map(q).join(', ')}) VALUES (`
    + names.map((_, at) => dialect.parameterRef(at + 1, 'v')).join(', ') + ')';
  return {
    order, columns, sideColumns,
    create: dialect.ddl.createPlainTable({ table: HISTORY_TABLE, columns }),
    createIdentity: dialect.ddl.createPlainTable({ table: MIGRATION_IDENTITY_TABLE, columns: sideColumns }),
    select: `SELECT CAST(${dialect.rowIdentity()} AS TEXT) AS ${q(order)}, `
      + FIELDS.map((name) => name === 'applied_at' || name === 'steps'
        ? `CAST(${q(name)} AS TEXT) AS ${q(name)}` : q(name)).join(', ')
      + ` FROM ${q(HISTORY_TABLE)} ORDER BY ${q(HISTORY_TABLE)}.${q(order)}`,
    selectIdentity: `SELECT ${q('key')}, ${q('value')} FROM ${q(MIGRATION_IDENTITY_TABLE)} ORDER BY ${q('key')}`,
    insert: insert(HISTORY_TABLE, FIELDS),
    insertIdentity: insert(MIGRATION_IDENTITY_TABLE, ['key', 'value']),
  };
}

/** Native catalog facts, never PostgreSQL pretty-printed CREATE equality. */
function verifyNativeTable(dialect, table, columns, catalog) {
  const owned = catalog.filter((object) => object.owner === table);
  const facts = owned.map((object) => ({ ...object,
    metadata: typeof object.metadata === 'string' ? JSON.parse(object.metadata) : object.metadata }));
  const relation = facts.find((object) => object.type === 'table' && object.name === table)?.metadata;
  const bad = () => invalid(`migration metadata table '${table}' has an unsupported schema`);
  if (!relation || relation.kind !== 'r' || relation.rls || relation.forceRls
    || relation.persistence !== 'p' || relation.partition !== null || relation.partitionKey !== null
    || relation.inherits !== null || relation.options !== null) bad();
  if (facts.some((object) => !['table', 'column', 'constraint', 'index', 'sequence', 'dependency'].includes(object.type))) bad();
  const expected = [...columns, { name: dialect.identityColumn.name, type: 'bigint', identity: true }];
  const actual = facts.filter((object) => object.type === 'column');
  if (actual.length !== expected.length) bad();
  const sequence = facts.filter((object) => object.type === 'sequence');
  if (sequence.length !== 1 || sequence[0].metadata.table !== table
    || sequence[0].metadata.column !== dialect.identityColumn.name || sequence[0].metadata.dependency !== 'a') bad();
  const regclass = (name) => /^[a-z_][a-z0-9_$]*$/.test(name) ? name : dialect.quoteIdentifier(name);
  const seq = sequence[0];
  const defaults = [regclass(seq.name), `${regclass(seq.schema)}.${regclass(seq.name)}`]
    .map((name) => `nextval('${name.replaceAll("'", "''")}'::regclass)`);
  for (const column of expected) {
    const found = actual.find((object) => object.name === column.name), metadata = found?.metadata;
    const type = dialect.comparableColumnType(column.type);
    if (!metadata || dialect.comparableColumnType(metadata.type) !== type
      || metadata.typeKind !== 'b' || metadata.typeSchema !== 'pg_catalog'
      || metadata.generated !== '' || metadata.identity !== ''
      || metadata.nullable !== !(column.primaryKey || column.identity)
      || (column.identity ? !defaults.includes(found.sql) : found.sql !== null)
      || type === 'TEXT' && (metadata.collation !== 'C' || metadata.collationDeterministic !== true)) bad();
  }
  const constraints = facts.filter((object) => object.type === 'constraint');
  if (constraints.filter((object) => object.metadata.kind === 'p').length !== 1) bad();
  // PostgreSQL 18+ also describes the required column nullability as constraints.
  const notNull = new Set([columns[0].name, dialect.identityColumn.name]);
  for (const { metadata } of constraints) {
    if (metadata.deferrable || metadata.initiallyDeferred || !metadata.validated) bad();
    if (metadata.kind === 'p') {
      if (canonicalizeJson(metadata.columns) !== canonicalizeJson([columns[0].name])) bad();
    }
    else if (metadata.kind !== 'n' || metadata.noInherit || metadata.columns?.length !== 1
      || !notNull.delete(metadata.columns[0])) bad();
  }
  const indexes = facts.filter((object) => object.type === 'index');
  if (indexes.length !== 1 || !indexes[0].metadata.primary || !indexes[0].metadata.unique
    || !indexes[0].metadata.valid || !indexes[0].metadata.ready
    || indexes[0].metadata.predicate !== null || indexes[0].metadata.expressions !== null) bad();
}

/** All reads release their temporary statement before taking the next one. */
export function readMigrationHistory(connection, authority = false) {
  const dialect = connection.dialect, sql = historyStatements(dialect);
  const all = (text, params = []) => useStatementOnce(connection, text, (statement) => statement.all(params));
  return chain(all(dialect.introspect.tables()), (tables) => {
    const present = (name) => {
      const matches = tables.filter((table) => table.name === name);
      if (matches.length > 1 || matches.some((table) => table.type !== 'table'))
        invalid(`migration metadata name '${name}' must identify one ordinary table`);
      return matches.length === 1;
    };
    const history = present(HISTORY_TABLE), identity = present(MIGRATION_IDENTITY_TABLE);
    const selected = [[HISTORY_TABLE, history, sql.columns, sql.create],
      [MIGRATION_IDENTITY_TABLE, identity, sql.sideColumns, sql.createIdentity]].filter((entry) => entry[1]);
    const verify = (at, catalog) => {
      if (at >= selected.length) return null;
      const [name, , columns, create] = selected[at];
      if (authority && dialect.migration) {
        verifyNativeTable(dialect, name, columns, catalog);
        return verify(at + 1, catalog);
      }
      return chain(all(dialect.introspect.columns(name)), (actual) => {
        if (columns.some((column) => !actual.some((found) => found.name === column.name
          && dialect.comparableColumnType(found.type) === dialect.comparableColumnType(column.type)))
          || dialect.identityColumn && !actual.some((found) => found.name === sql.order))
          invalid(`migration metadata table '${name}' cannot provide its observation fields`);
        if (!authority) return verify(at + 1, catalog);
        return chain(all(dialect.introspect.declaredSql(name)), (objects) => {
          if (objects.length !== 1 || objects[0].type !== 'table'
            || comparableDeclaredSql(objects[0].sql) !== comparableDeclaredSql(create))
            invalid(`migration metadata table '${name}' has an unsupported schema`);
          return verify(at + 1, catalog);
        });
      });
    };
    return chain(authority && selected.length && dialect.migration ? all(dialect.introspect.catalog()) : [], (catalog) =>
      chain(verify(0, catalog), () => chain(authority && selected.length && dialect.migration?.metadataRules
        ? all(dialect.migration.metadataRules, [HISTORY_TABLE, MIGRATION_IDENTITY_TABLE]) : [], (rules) => {
        if (rules.length) invalid('migration metadata tables cannot carry rewrite rules');
        return chain(history ? all(sql.select) : [], (rows) => chain(identity ? all(sql.selectIdentity) : [], (side) => ({
          version: 1, dialect: dialect.name, order: sql.order,
          history: { present: history, rows }, identity: { present: identity, rows: side },
        })));
      })));
  });
}

/** Validate an observation without normalizing a single driver-returned value. */
export function checkHistoryObservation(observed) {
  if (!keys(observed, ['version', 'dialect', 'order', 'history', 'identity']) || observed.version !== 1
    || !['sqlite', 'postgres'].includes(observed.dialect)
    || observed.order !== (observed.dialect === 'postgres' ? 'rid' : 'rowid')) invalid('unsupported migration history observation');
  for (const name of ['history', 'identity']) {
    const value = observed[name];
    if (!keys(value, ['present', 'rows']) || typeof value.present !== 'boolean'
      || !Array.isArray(value.rows) || !value.present && value.rows.length)
      invalid(`invalid migration history observation '${name}'`);
    const names = name === 'history' ? [observed.order, ...FIELDS] : ['key', 'value'];
    if (value.rows.some((row) => !keys(row, names) || names.some((field) => row[field] !== null && typeof row[field] !== 'string')))
      invalid(`invalid migration history observation '${name}' fields`);
  }
  return observed;
}

/** Full original receipt agreement; numeric text is compared without Number. */
export function checkAppliedRows(observed, migrations) {
  checkHistoryObservation(observed);
  const seen = new Set();
  for (const [at, row] of observed.history.rows.entries()) {
    const migration = migrations[at], order = row[observed.order];
    if (typeof order !== 'string' || !SIGNED_INTEGER.test(order) || seen.has(order)
      || typeof row.applied_at !== 'string' || !DECIMAL.test(row.applied_at)
      || typeof row.steps !== 'string' || !COUNT.test(row.steps)) invalid(`history position ${at} contains invalid ordering, timestamp or step fields`);
    seen.add(order);
    if (!Array.isArray(migration?.steps) || row.id !== migration.id
      || row.from_hash !== migration.from || row.to_hash !== migration.to
      || row.steps !== String(migration.steps.length) || row.checksum !== migrationChecksum(migration))
      invalid(`history position ${at} records '${row.id}' but the migration list differs — preserve every applied document, in order; an applied migration must never be edited`);
  }
}

/** Exact canonical authority for a reviewed legacy boundary or a fresh chain. */
export function historyHeader(legacyCount = 0, legacyModel = null, legacyTarget = null, legacyModelSource = null) {
  return { version: 1, legacyCount, legacyModel, legacyTarget, legacyModelSource };
}

/** Side rows have deterministic key order just like the observation projection. */
export function identityRows(migrations, rows, header) {
  return [{ key: 'header', value: canonicalizeJson(header) }, ...rows.map((row, at) => ({
    key: `receipt:${at}`, value: canonicalizeJson({ document: canonicalizeJson(migrations[at]), row: canonicalizeJson(row) }),
  }))].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

/** A complete attestation, or a private replay's strictly bounded headerless prefix. */
export function checkHistoryIdentity(observed, migrations, replay = undefined) {
  checkAppliedRows(observed, migrations);
  const rows = observed.history.rows, side = observed.identity;
  if (!side.present) {
    if (!rows.length) return replay?.header ?? historyHeader();
    if (migrations.slice(0, rows.length).some((migration) => migration?.$migration !== '0.1'))
      invalid('exact migration history is missing its identity metadata');
    throw new DbCompileError('JD0028', 'legacy migration history requires migrationHistory() and explicit adoptMigrationHistory() attestation before status or apply');
  }
  if (!rows.length) invalid('migration identity metadata has no normal history to bind');
  const map = new Map();
  for (const row of side.rows) {
    if (typeof row.key !== 'string' || map.has(row.key)) invalid('migration identity keys must be unique text');
    map.set(row.key, row.value);
  }
  const partial = replay !== undefined && rows.length < replay.header.legacyCount && !map.has('header');
  const header = partial ? replay.header : parseCanonical(map.get('header'), 'migration identity header');
  if (!keys(header, ['version', 'legacyCount', 'legacyModel', 'legacyTarget', 'legacyModelSource']) || header.version !== 1
    || !Number.isSafeInteger(header.legacyCount) || header.legacyCount < 0
    || !partial && header.legacyCount > rows.length
    || header.legacyCount === 0 && (header.legacyModel !== null || header.legacyTarget !== null || header.legacyModelSource !== null))
    invalid('unsupported migration identity header');
  if (header.legacyCount > 0) {
    const model = parseCanonical(header.legacyModel, 'adopted model');
    if (model === null || typeof model !== 'object' || Array.isArray(model) || model.$model !== '0.1'
      || modelIdentity(model) !== header.legacyModel) invalid('adopted model must be canonical $model 0.1 text without planning hints');
    try {
      const source = JSON.parse(header.legacyModelSource);
      if (typeof header.legacyModelSource !== 'string' || JSON.stringify(source) !== header.legacyModelSource
        || modelIdentity(source) !== header.legacyModel) invalid('adopted model source differs from its exact identity');
    }
    catch { invalid('adopted model source must preserve its JSON model declaration order'); }
    if (header.legacyTarget !== null) {
      const target = parseCanonical(header.legacyTarget, 'adopted physical target');
      try { physicalTargetOf(target); }
      catch { invalid('adopted physical target has an unsupported shape'); }
    }
    if (migrations[header.legacyCount - 1]?.to !== hashContent(header.legacyModel))
      invalid('adopted model does not match its legacy boundary');
  }
  if (replay !== undefined && canonicalizeJson(header) !== canonicalizeJson(replay.header))
    invalid('shadow legacy boundary changed during replay');
  if (map.size !== rows.length + (partial ? 0 : 1)) invalid('migration identity coverage is incomplete or contains extra rows');
  for (let at = 0; at < rows.length; at++) {
    const receipt = parseCanonical(map.get(`receipt:${at}`), `migration identity receipt ${at}`);
    const migration = migrations[at];
    if (!keys(receipt, ['document', 'row']) || receipt.document !== canonicalizeJson(migration)
      || receipt.row !== canonicalizeJson(rows[at])) invalid(`migration identity receipt ${at} differs from its exact document or stored row`);
    if (migration.$migration !== (at < header.legacyCount ? '0.1' : '0.2')) invalid(`migration identity receipt ${at} has the wrong format version`);
  }
  return header;
}

/** Applied and pending endpoints form one exact chain after the attested prefix. */
export function checkHistoryChain(migrations, applied, header, options = {}, replay = undefined, inspect = false) {
  let expected = options.baseline === undefined ? null : modelIdentity(options.baseline);
  let fingerprint = expected === null ? null : hashContent(expected);
  const legacy = header.legacyCount;
  for (const [at, migration] of migrations.entries()) {
    if (migration?.$migration === '0.1' && (at >= legacy || at >= applied && replay === undefined))
      throw new DbCompileError('JD0028', `migration '${migration.id}' is legacy 0.1 pending work; preserve applied artifacts and author new work as 0.2`);
    (inspect ? checkMigrationStructure : checkMigrationDocument)(migration);
    if (migration.$migration === '0.1') {
      if (replay !== undefined && replay.documents[at] !== canonicalizeJson(migration)) invalid('shadow legacy document differs from its verified receipt');
      if (fingerprint !== null && migration.from !== fingerprint)
        throw new DbCompileError('JD0020', `migration '${migration.id}' does not connect to the baseline or preceding migration`);
      fingerprint = migration.to;
      expected = at === legacy - 1 ? header.legacyModel : null;
    }
    else {
      if (at < legacy) invalid('an adopted prefix must contain only legacy 0.1 documents');
      if (expected !== null && migration.identity.from !== expected
        || fingerprint !== null && migration.from !== fingerprint)
        throw new DbCompileError('JD0020', `migration '${migration.id}' from '${migration.from}' does not match the exact baseline or preceding endpoint`);
      expected = migration.identity.to;
      fingerprint = migration.to;
    }
  }
  if (options.model !== undefined && expected !== null && modelIdentity(options.model) !== expected)
    throw new DbCompileError('JD0020', 'the target model does not equal the exact final migration endpoint');
  return { model: expected, shape: fingerprint };
}

/** Insert only missing NEW authority, always in the caller's link/adoption transaction. */
export function writeIdentityRows(connection, rows, check) {
  const sql = historyStatements(connection.dialect);
  const next = (at) => {
    if (at === rows.length) return null;
    check();
    return chain(useStatementOnce(connection, sql.insertIdentity, (statement) => statement.run([rows[at].key, rows[at].value])), () => next(at + 1));
  };
  return next(0);
}
