//@ts-check
/** Column-first SQLite schema programs. No SQL strings are accepted as expressions. */
import { DbCompileError } from '../errors.js';
import { relationalEmitter, relationalIdentifier as q } from './sqlite-relational.js';

const fail = (message) => { throw new DbCompileError('JD0005', message); };
const check = (v, keys, label) => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) fail(`${label} must be an object`);
  for (const key of Object.keys(v)) if (!keys.includes(key)) fail(`unknown ${label} member '${key}'`);
};
const list = (values, label) => {
  if (!Array.isArray(values) || !values.length || new Set(values).size !== values.length) fail(`${label} must be a nonempty distinct list`);
  return values.map(q).join(', ');
};
const action = (value) => {
  if (!['cascade', 'restrict', 'no action', 'set null', 'set default'].includes(value)) fail('unsupported foreign-key action');
  return value.toUpperCase();
};

/** Validate a structural table definition and retain its explicit column order.
 * @param {any} definition @returns {any} */
export function defineTable(definition) {
  planTable(definition);
  return structuredClone(definition);
}

/** Render table, indexes and triggers as independently reviewable statements.
 * @param {any} definition @returns {{table:string,createSql:string[],expected:any}} */
export function planTable(definition) {
  check(definition, ['name', 'columns', 'primaryKey', 'constraints', 'indexes', 'triggers', 'strict', 'withoutRowid'], 'table');
  const table = q(definition.name);
  if (!Array.isArray(definition.columns) || !definition.columns.length) fail('table columns must be nonempty');
  for (const key of ['strict', 'withoutRowid']) if (definition[key] !== undefined && typeof definition[key] !== 'boolean') fail(`${key} must be boolean`);
  for (const key of ['constraints', 'indexes', 'triggers']) if (definition[key] !== undefined && !Array.isArray(definition[key])) fail(`${key} must be a list`);
  const emitter = relationalEmitter({ inline: true });
  const names = new Set();
  const columns = definition.columns.map((column) => {
    const text = columnSql(column, definition, emitter);
    if (names.has(column.name.toLowerCase())) fail('physical column names must be distinct');
    names.add(column.name.toLowerCase());
    return text;
  });
  const inlineKey = definition.columns.some((column) => column.identity !== undefined);
  const members = (values) => {
    const text = list(values, 'constraint columns');
    if (values.some((name) => !names.has(name.toLowerCase()))) fail('constraint names an undeclared column');
    return text;
  };
  if (definition.primaryKey !== undefined && !inlineKey) columns.push(`PRIMARY KEY (${members(definition.primaryKey)})`);
  if (definition.withoutRowid && !definition.primaryKey?.length) fail('WITHOUT ROWID requires a primary key');
  for (const constraint of definition.constraints ?? []) {
    check(constraint, ['kind', 'name', 'columns', 'expression', 'table', 'references', 'onDelete', 'onUpdate', 'deferred'], 'constraint');
    const prefix = constraint.name === undefined ? '' : `CONSTRAINT ${q(constraint.name)} `;
    if (constraint.kind === 'unique') columns.push(`${prefix}UNIQUE (${members(constraint.columns)})`);
    else if (constraint.kind === 'check') columns.push(`${prefix}CHECK (${emitter.expr(constraint.expression)})`);
    else if (constraint.kind === 'foreignKey') {
      if (constraint.columns?.length !== constraint.references?.length) fail('foreign-key columns must have equal arity');
      columns.push(`${prefix}FOREIGN KEY (${members(constraint.columns)}) ${referenceSql({
        table: constraint.table, columns: constraint.references,
        ...(constraint.onDelete === undefined ? {} : { onDelete: constraint.onDelete }),
        ...(constraint.onUpdate === undefined ? {} : { onUpdate: constraint.onUpdate }),
        ...(constraint.deferred === undefined ? {} : { deferred: constraint.deferred }),
      })}`);
    }
    else fail('constraint kind is unique, check or foreignKey');
    const keys = constraint.kind === 'unique' ? ['kind', 'name', 'columns']
      : constraint.kind === 'check' ? ['kind', 'name', 'expression']
        : ['kind', 'name', 'columns', 'table', 'references', 'onDelete', 'onUpdate', 'deferred'];
    check(constraint, keys, `${constraint.kind} constraint`);
  }
  const createSql = [`CREATE TABLE IF NOT EXISTS ${table} (${columns.join(', ')})`
    + (definition.withoutRowid ? ' WITHOUT ROWID' : '')
    + (definition.strict ? `${definition.withoutRowid ? ',' : ''} STRICT` : '')];
  const objects = new Set([definition.name.toLowerCase()]);
  const objectName = (name) => {
    const out = q(name);
    if (objects.has(name.toLowerCase())) fail('schema object names must be distinct');
    objects.add(name.toLowerCase()); return out;
  };
  for (const index of definition.indexes ?? []) {
    check(index, ['name', 'terms', 'unique', 'where'], 'index');
    if (!Array.isArray(index.terms) || !index.terms.length) fail('index terms must be nonempty');
    if (index.unique !== undefined && typeof index.unique !== 'boolean') fail('index unique must be boolean');
    if (index.terms.some((term) => term?.nulls !== undefined)) fail('SQLite index terms cannot declare NULLS FIRST/LAST');
    createSql.push(`CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS ${objectName(index.name)} ON ${table} `
      + `(${index.terms.map((term) => emitter.order(term, 0)).join(', ')})`
      + (index.where === undefined ? '' : ` WHERE ${emitter.expr(index.where)}`));
  }
  for (const trigger of definition.triggers ?? []) {
    check(trigger, ['name', 'timing', 'event', 'of', 'when', 'steps'], 'trigger');
    if (!['before', 'after'].includes(trigger.timing) || !['insert', 'update', 'delete'].includes(trigger.event)) fail('unsupported trigger timing or event');
    if (trigger.of !== undefined && trigger.event !== 'update') fail('UPDATE OF requires an update trigger');
    if (!Array.isArray(trigger.steps) || !trigger.steps.length) fail('trigger steps must be nonempty');
    const steps = trigger.steps.map((step) => {
      if (!step || typeof step !== 'object' || Array.isArray(step)) fail('a trigger step must be a mutation or raise object');
      if (Object.hasOwn(step, 'raise')) {
        check(step, ['raise'], 'raise step');
        check(step.raise, ['action', 'message'], 'raise');
        if (!['abort', 'fail', 'rollback', 'ignore'].includes(step.raise.action)) fail('unsupported trigger RAISE action');
        if (step.raise.action === 'ignore') {
          if (step.raise.message !== undefined) fail('RAISE IGNORE has no message');
          return 'SELECT RAISE(IGNORE)';
        }
        if (typeof step.raise.message !== 'string') fail('RAISE requires a string message');
        return `SELECT RAISE(${step.raise.action.toUpperCase()}, ${emitter.expr(step.raise.message)})`;
      }
      if (step.returning !== undefined) fail('triggers cannot use RETURNING');
      return emitter.mutation(step);
    });
    createSql.push(`CREATE TRIGGER IF NOT EXISTS ${objectName(trigger.name)} ${trigger.timing.toUpperCase()} ${trigger.event.toUpperCase()}`
      + (trigger.of === undefined ? '' : ` OF ${members(trigger.of)}`) + ` ON ${table}`
      + (trigger.when === undefined ? '' : ` WHEN ${emitter.expr(trigger.when)}`)
      + ` BEGIN ${steps.join('; ')}; END`);
  }
  return { table: definition.name, createSql, expected: {
    columns: definition.columns.map((c) => ({ name: c.name, type: c.type, generated: c.generated !== undefined })),
    indexes: (definition.indexes ?? []).map((i) => ({ name: i.name, unique: i.unique === true, terms: i.terms })),
  } };
}

/** One REFERENCES clause shared by table constraints and column declarations. */
function referenceSql(reference) {
  check(reference, ['table', 'columns', 'onDelete', 'onUpdate', 'deferred'], 'reference');
  if (reference.deferred !== undefined && typeof reference.deferred !== 'boolean') fail('deferred must be boolean');
  return `REFERENCES ${q(reference.table)} (${list(reference.columns, 'references')})`
    + (reference.onDelete === undefined ? '' : ` ON DELETE ${action(reference.onDelete)}`)
    + (reference.onUpdate === undefined ? '' : ` ON UPDATE ${action(reference.onUpdate)}`)
    + (reference.deferred ? ' DEFERRABLE INITIALLY DEFERRED' : '');
}

/** Render one typed column without reconstructing any surrounding schema. */
function columnSql(column, context, emitter) {
  check(column, ['name', 'type', 'nullable', 'default', 'collation', 'identity', 'check', 'generated', 'stored', 'references'], 'column definition');
  const name = q(column.name);
  if (!['INTEGER', 'REAL', 'TEXT', 'BLOB', 'NUMERIC', 'ANY'].includes(column.type)) fail('unsupported SQLite column type');
  if (context.strict && column.type === 'NUMERIC') fail('STRICT tables do not support NUMERIC');
  if (column.nullable !== undefined && typeof column.nullable !== 'boolean') fail('nullable must be boolean');
  if (column.stored !== undefined && (typeof column.stored !== 'boolean' || column.generated === undefined)) fail('stored requires a generated expression');
  const hasDefault = Object.hasOwn(column, 'default');
  if (context.additive) {
    if (column.identity !== undefined || column.stored === true) fail('ADD COLUMN cannot add an identity or STORED column');
    const value = column.default?.$sql === 'value' ? column.default.value : column.default;
    if (hasDefault && !(value === null || typeof value === 'string' || typeof value === 'bigint'
      || (typeof value === 'number' && Number.isFinite(value)))) fail('ADD COLUMN requires a literal default');
    if (column.generated === undefined && column.nullable === false && (!hasDefault || value === null)) fail('ADD COLUMN NOT NULL requires a non-null default');
    if (column.references !== undefined && hasDefault && value !== null) fail('ADD COLUMN REFERENCES requires a NULL default');
  }
  let out = `${name} ${column.type}`;
  if (column.identity !== undefined) {
    if (!['rowid', 'autoincrement'].includes(column.identity) || column.type !== 'INTEGER'
      || context.withoutRowid || context.primaryKey?.length !== 1
      || context.primaryKey[0] !== column.name || column.generated !== undefined) fail('identity requires a single INTEGER rowid primary key');
    out += ` PRIMARY KEY${column.identity === 'autoincrement' ? ' AUTOINCREMENT' : ''}`;
  }
  if (column.nullable === false) out += ' NOT NULL';
  if (column.collation !== undefined) {
    if (!['BINARY', 'NOCASE', 'RTRIM'].includes(column.collation)) fail('unsupported column collation');
    out += ` COLLATE ${column.collation}`;
  }
  if (hasDefault) out += context.additive ? ` DEFAULT ${emitter.expr(column.default)}` : ` DEFAULT (${emitter.expr(column.default)})`;
  if (column.check !== undefined) out += ` CHECK (${emitter.expr(column.check)})`;
  if (column.generated !== undefined) {
    if (hasDefault) fail('a generated column cannot have a default');
    out += ` GENERATED ALWAYS AS (${emitter.expr(column.generated)}) ${column.stored ? 'STORED' : 'VIRTUAL'}`;
  }
  if (column.references !== undefined) {
    if (column.references?.columns?.length !== 1) fail('a column reference requires one referenced column');
    out += ` ${referenceSql(column.references)}`;
  }
  return out;
}

/** Render one explicit main-schema operation; validation never executes SQL.
 * @param {any} operation @returns {string} */
export function schemaChangeSql(operation) {
  check(operation, ['op', 'table', 'column', 'name', 'to', 'ifExists'], 'schema change');
  switch (operation.op) {
    case 'addColumn':
      check(operation, ['op', 'table', 'column'], 'addColumn');
      return `ALTER TABLE "main".${q(operation.table)} ADD COLUMN ${columnSql(operation.column, { additive: true }, relationalEmitter({ inline: true }))}`;
    case 'renameTable':
      check(operation, ['op', 'table', 'to'], 'renameTable');
      return `ALTER TABLE "main".${q(operation.table)} RENAME TO ${q(operation.to)}`;
    case 'dropIndex': case 'dropTable': {
      const index = operation.op === 'dropIndex';
      check(operation, ['op', index ? 'name' : 'table', 'ifExists'], operation.op);
      if (operation.ifExists !== undefined && typeof operation.ifExists !== 'boolean') fail('ifExists must be boolean');
      return `DROP ${index ? 'INDEX' : 'TABLE'}${operation.ifExists ? ' IF EXISTS' : ''} "main".${q(index ? operation.name : operation.table)}`;
    }
    default: return fail('schema change is addColumn, dropIndex, renameTable or dropTable');
  }
}
