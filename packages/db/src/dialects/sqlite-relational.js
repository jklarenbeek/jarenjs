//@ts-check
/** Explicit SQLite expressions and statements on an existing connection.
 * Values retain SQLite's NULL, numeric, collation and byte semantics. */
import { DbCompileError } from '../errors.js';
import { sqliteDialect } from './sqlite.js';
import { chain } from '../driver.js';
import { createSyncCursor, rowClassOf } from '../cursor.js';

/** @typedef {{ sql: string, params: any[], access: 'read'|'write' }} RelationalPlan */
const fail = (message) => { throw new DbCompileError('JD0038', message); };
const own = (o, key) => Object.hasOwn(o, key);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const check = (value, members, label) => {
  if (!object(value)) fail(`${label} must be an object`);
  for (const key of Object.keys(value)) if (!members.includes(key)) fail(`unknown ${label} member '${key}'`);
};
/** Quote one identifier; a dot is part of the name, never SQL syntax.
 * @param {string} name @returns {string} */
export function relationalIdentifier(name) {
  if (typeof name !== 'string' || !name || name.includes('\0')) fail('a SQL identifier must be nonempty and contain no NUL');
  return sqliteDialect.quoteIdentifier(name);
}
const q = relationalIdentifier;
const binary = new Set(['=', '<>', '<', '<=', '>', '>=', 'IS', 'IS NOT', '+', '-', '*', '/', '%', '||', 'AND', 'OR', 'LIKE', 'NOT LIKE', 'GLOB']);
const functions = new Set(['coalesce', 'nullif', 'trim', 'ltrim', 'rtrim', 'lower', 'upper', 'length', 'abs', 'round', 'typeof', 'json_extract', 'json_valid', 'json_type', 'count', 'sum', 'total', 'avg', 'min', 'max', 'date', 'time', 'datetime', 'julianday', 'unixepoch', 'strftime']);
const types = new Set(['INTEGER', 'REAL', 'TEXT', 'BLOB', 'NUMERIC']);
const collations = new Set(['BINARY', 'NOCASE', 'RTRIM']);
const node = (kind, spec) => ({ $sql: kind, ...spec });

/** Typed structural authoring for SQLite's own expression semantics. */
export const sql = Object.freeze({
  /** @param {string} name @param {string} [table] */
  column: (name, table) => node('column', { name, ...(table === undefined ? {} : { table }) }),
  /** @param {string|number|bigint|Uint8Array|null} value */
  value: (value) => node('value', { value }),
  /** @param {string} name */
  param: (name) => node('param', { name }),
  /** @param {'='|'<>'|'<'|'<='|'>'|'>='|'IS'|'IS NOT'|'+'|'-'|'*'|'/'|'%'|'||'|'AND'|'OR'|'LIKE'|'NOT LIKE'|'GLOB'} op @param {any} left @param {any} right */
  binary: (op, left, right) => node('binary', { op, left, right }),
  /** @param {any} value */
  not: (value) => node('not', { value }),
  /** @param {any} value @param {any[]|object} values @param {boolean} [negate] */
  in: (value, values, negate = false) => node('in', { value, values, negate }),
  /** @param {string} name @param {any[]} args @param {{distinct?:boolean}} [options] */
  call: (name, args, options = {}) => node('call', { name, args, ...options }),
  /** @param {any} value @param {'INTEGER'|'REAL'|'TEXT'|'BLOB'|'NUMERIC'} type */
  cast: (value, type) => node('cast', { value, type }),
  /** @param {any} value @param {'BINARY'|'NOCASE'|'RTRIM'} collation */
  collate: (value, collation) => node('collate', { value, collation }),
  /** @param {{when:any,then:any}[]} branches @param {any} [otherwise] */
  case: (branches, otherwise = null) => node('case', { branches, otherwise }),
  /** @param {any} query */
  scalar: (query) => node('scalar', { query }),
  /** @param {any} query */
  exists: (query) => node('exists', { query }),
});

/** Compile expressions once, sharing parameter ordering with nested statements.
 * Inline mode is for schema expressions, where SQLite disallows placeholders.
 * @param {{externals?:Record<string,any>, inline?:boolean}} [options] */
export function relationalEmitter(options = {}) {
  const params = [];
  const literal = (value) => {
    if (!(value === null || typeof value === 'string' || typeof value === 'bigint'
      || (typeof value === 'number' && Number.isFinite(value)) || value instanceof Uint8Array))
      return fail('SQL values are null, strings, finite numbers, integers or bytes');
    if (!options.inline) { params.push(value); return '?'; }
    if (value === null) return 'NULL';
    if (typeof value === 'string') {
      if (value.includes('\0')) fail('NUL text defaults require a data operation');
      return sqliteDialect.stringLiteral(value);
    }
    if (value instanceof Uint8Array) return fail('binary schema defaults are not supported');
    return String(value);
  };
  const expr = (value, depth = 0) => {
    if (depth > 64) return fail('SQL expression nesting exceeds 64');
    if (!object(value) || value instanceof Uint8Array) return literal(value);
    const next = (child) => expr(child, depth + 1);
    switch (value.$sql) {
      case 'column':
        check(value, ['$sql', 'name', 'table'], 'column');
        return (value.table === undefined ? '' : `${q(value.table)}.`) + q(value.name);
      case 'value': check(value, ['$sql', 'value'], 'value'); return literal(value.value);
      case 'param':
        check(value, ['$sql', 'name'], 'parameter');
        if (options.inline || !own(options.externals ?? {}, value.name)) return fail(`missing or unavailable SQL parameter '${value.name}'`);
        return literal(options.externals[value.name]);
      case 'binary':
        check(value, ['$sql', 'op', 'left', 'right'], 'binary expression');
        if (!binary.has(value.op)) return fail('unsupported SQL operator');
        return `(${next(value.left)} ${value.op} ${next(value.right)})`;
      case 'not': check(value, ['$sql', 'value'], 'not'); return `(NOT ${next(value.value)})`;
      case 'in': {
        check(value, ['$sql', 'value', 'values', 'negate'], 'in');
        if (value.negate !== undefined && typeof value.negate !== 'boolean') fail('IN negate must be boolean');
        const left = next(value.value);
        const right = Array.isArray(value.values) ? value.values.map(next).join(', ') : select(value.values, depth + 1);
        return `(${left} ${value.negate ? 'NOT IN' : 'IN'} (${right}))`;
      }
      case 'call': {
        check(value, ['$sql', 'name', 'args', 'distinct'], 'function');
        if (!functions.has(value.name) || !Array.isArray(value.args)) return fail('unsupported SQL function');
        if (value.distinct !== undefined && typeof value.distinct !== 'boolean') fail('DISTINCT must be boolean');
        if (value.distinct && value.args.length !== 1) fail('DISTINCT functions require one argument');
        if (!value.args.length && value.name !== 'count') fail('SQL function requires arguments');
        if (value.name === 'json_type' && value.args.length > 2) fail('json_type requires one or two arguments');
        return `${value.name.toUpperCase()}(${value.distinct ? 'DISTINCT ' : ''}${value.args.length ? value.args.map(next).join(', ') : '*'})`;
      }
      case 'cast':
        check(value, ['$sql', 'value', 'type'], 'cast');
        if (!types.has(value.type)) return fail('unsupported SQLite cast type');
        return `CAST(${next(value.value)} AS ${value.type})`;
      case 'collate':
        check(value, ['$sql', 'value', 'collation'], 'collation');
        if (!collations.has(value.collation)) return fail('unsupported SQLite collation');
        return `(${next(value.value)} COLLATE ${value.collation})`;
      case 'case':
        check(value, ['$sql', 'branches', 'otherwise'], 'case');
        if (!Array.isArray(value.branches) || !value.branches.length) return fail('CASE requires branches');
        return `(CASE ${value.branches.map((b) => {
          check(b, ['when', 'then'], 'case branch');
          return `WHEN ${next(b.when)} THEN ${next(b.then)}`;
        }).join(' ')} ELSE ${next(value.otherwise ?? null)} END)`;
      case 'scalar': case 'exists':
        check(value, ['$sql', 'query'], 'subquery');
        return `${value.$sql === 'exists' ? 'EXISTS ' : ''}(${select(value.query, depth + 1)})`;
      default: return fail('SQL expressions require a supported $sql node');
    }
  };
  const order = (term, depth) => {
    check(term, ['by', 'direction', 'nulls'], 'order');
    if (term.direction !== undefined && !['asc', 'desc'].includes(term.direction)) fail('order direction is asc or desc');
    if (term.nulls !== undefined && !['first', 'last'].includes(term.nulls)) fail('null order is first or last');
    return expr(term.by, depth) + (term.direction ? ` ${term.direction.toUpperCase()}` : '')
      + (term.nulls ? ` NULLS ${term.nulls.toUpperCase()}` : '');
  };
  const source = (s, depth) => {
    if (typeof s === 'string') return q(s);
    check(s, ['table', 'query', 'as'], 'source');
    if (own(s, 'table') === own(s, 'query')) return fail('a source names one table or subquery');
    return (own(s, 'table') ? q(s.table) : `(${select(s.query, depth + 1)})`)
      + (s.as === undefined ? '' : ` AS ${q(s.as)}`);
  };
  const projection = (columns, depth) => {
    if (columns === undefined || columns === '*') return '*';
    if (!object(columns) || !Object.keys(columns).length) return fail('columns must be a nonempty projection or *');
    return Object.entries(columns).map(([name, value]) => `${expr(value, depth)} AS ${q(name)}`).join(', ');
  };
  const window = (value, name) => {
    if (!Number.isSafeInteger(value) || value < 0) fail(`${name} must be a nonnegative safe integer`);
    return value;
  };
  const select = (spec, depth = 0) => {
    if (depth > 64) return fail('SQL query nesting exceeds 64');
    check(spec, ['from', 'columns', 'where', 'joins', 'groupBy', 'having', 'orderBy', 'limit', 'offset', 'distinct', 'union', 'all'], 'select');
    let out;
    if (spec.union !== undefined) {
      if (!Array.isArray(spec.union) || spec.union.length < 2) return fail('UNION requires at least two queries');
      if (Object.keys(spec).some((key) => !['union', 'all', 'orderBy', 'limit', 'offset'].includes(key))) fail('UNION cannot also declare a selection');
      if (spec.all !== undefined && typeof spec.all !== 'boolean') fail('UNION all must be boolean');
      out = spec.union.map((part) => `SELECT * FROM (${select(part, depth + 1)})`).join(spec.all ? ' UNION ALL ' : ' UNION ');
    }
    else {
      if (spec.all !== undefined) fail('all requires UNION');
      if (spec.distinct !== undefined && typeof spec.distinct !== 'boolean') fail('distinct must be boolean');
      out = `SELECT ${spec.distinct ? 'DISTINCT ' : ''}${projection(spec.columns, depth)}`;
      if (spec.from !== undefined) out += ` FROM ${source(spec.from, depth)}`;
      if (spec.joins !== undefined) {
        if (spec.from === undefined || !Array.isArray(spec.joins)) fail('joins require a FROM source and a list');
        for (const join of spec.joins) {
          check(join, ['source', 'type', 'on'], 'join');
          const type = join.type ?? 'inner';
          if (!['inner', 'left', 'cross'].includes(type)) fail('unsupported join type');
          if (type === 'cross' ? own(join, 'on') : !own(join, 'on')) fail('inner/left joins require ON; cross joins have no ON');
          out += ` ${type.toUpperCase()} JOIN ${source(join.source, depth)}`;
          if (type !== 'cross') out += ` ON ${expr(join.on, depth)}`;
        }
      }
      if (own(spec, 'where')) out += ` WHERE ${expr(spec.where, depth)}`;
      if (spec.groupBy !== undefined) {
        if (!Array.isArray(spec.groupBy) || !spec.groupBy.length) fail('groupBy must be nonempty');
        out += ` GROUP BY ${spec.groupBy.map((v) => expr(v, depth)).join(', ')}`;
      }
      if (own(spec, 'having')) out += ` HAVING ${expr(spec.having, depth)}`;
    }
    if (spec.orderBy !== undefined) {
      if (!Array.isArray(spec.orderBy) || !spec.orderBy.length) fail('orderBy must be nonempty');
      out += ` ORDER BY ${spec.orderBy.map((term) => order(term, depth)).join(', ')}`;
    }
    if (spec.limit !== undefined) out += ` LIMIT ${window(spec.limit, 'limit')}`;
    if (spec.offset !== undefined) out += `${spec.limit === undefined ? ' LIMIT -1' : ''} OFFSET ${window(spec.offset, 'offset')}`;
    return out;
  };
  const mutation = (spec) => {
    check(spec, ['op', 'table', 'set', 'where', 'values', 'source', 'columns', 'conflict', 'ignore', 'returning', 'reporting'], 'mutation');
    const table = q(spec.table);
    let out;
    if (spec.op === 'update' || spec.op === 'delete') {
      if (!own(spec, 'where')) fail('update/delete require an explicit where (use 1 for all rows)');
      for (const key of ['values', 'source', 'columns', 'conflict', 'ignore']) if (own(spec, key)) fail(`${key} requires insert`);
      if (spec.op === 'delete' && (own(spec, 'set') || own(spec, 'reporting'))) fail('delete has no assignments or reporting policy');
      if (spec.reporting !== undefined && !['matched', 'changed'].includes(spec.reporting)) fail('reporting is matched or changed');
      if (spec.op === 'update') {
        if (!object(spec.set) || !Object.keys(spec.set).length) fail('update requires assignments');
        out = `UPDATE ${table} SET ${Object.entries(spec.set).map(([name, v]) => `${q(name)} = ${expr(v)}`).join(', ')}`;
      }
      else out = `DELETE FROM ${table}`;
      out += ` WHERE ${expr(spec.where)}`;
      if (spec.reporting === 'changed') out += ` AND (${Object.entries(spec.set).map(([name, v]) =>
        `${q(name)} COLLATE BINARY IS NOT ${expr(v)}`).join(' OR ')})`;
    }
    else if (spec.op === 'insert') {
      for (const key of ['set', 'where', 'reporting']) if (own(spec, key)) fail(`${key} is not an insert member`);
      if (spec.ignore !== undefined && typeof spec.ignore !== 'boolean') fail('ignore must be boolean');
      if (own(spec, 'values') === own(spec, 'source')) fail('insert requires values or a source query');
      let names;
      let input;
      if (own(spec, 'source')) {
        names = spec.columns;
        if (!Array.isArray(names) || !names.length || new Set(names).size !== names.length) fail('insert-select requires distinct target columns');
        input = `SELECT * FROM (${select(spec.source)}) WHERE 1`;
      }
      else {
        if (own(spec, 'columns')) fail('literal inserts take column names from values');
        if (!object(spec.values)) fail('insert values must be an object');
        names = Object.keys(spec.values);
        input = names.length ? `VALUES (${names.map((name) => expr(spec.values[name])).join(', ')})` : 'DEFAULT VALUES';
      }
      out = `INSERT${spec.ignore ? ' OR IGNORE' : ''} INTO ${table}`
        + (names.length ? ` (${names.map(q).join(', ')})` : '') + ` ${input}`;
      if (spec.conflict !== undefined) {
        if (!names.length) fail('DEFAULT VALUES cannot carry an upsert clause');
        const conflict = spec.conflict;
        check(conflict, ['target', 'where', 'action', 'set', 'updateWhere'], 'conflict');
        if (!['nothing', 'update'].includes(conflict.action)) fail('conflict action is nothing or update');
        out += ' ON CONFLICT';
        if (conflict.target !== undefined) {
          if (!Array.isArray(conflict.target) || !conflict.target.length) fail('conflict target must be nonempty');
          // Conflict predicates and index expressions must be literal
          // schema expressions, otherwise SQLite cannot match the index.
          const schema = relationalEmitter({ inline: true });
          out += ` (${conflict.target.map((term) => typeof term === 'string' ? q(term) : schema.expr(term)).join(', ')})`;
          if (own(conflict, 'where')) out += ` WHERE ${schema.expr(conflict.where)}`;
        }
        else if (own(conflict, 'where')) fail('a conflict predicate requires a target');
        if (conflict.action === 'nothing') {
          if (own(conflict, 'set') || own(conflict, 'updateWhere')) fail('DO NOTHING has no update assignments');
          out += ' DO NOTHING';
        }
        else {
          if (!object(conflict.set) || !Object.keys(conflict.set).length) fail('conflict update requires assignments');
          out += ` DO UPDATE SET ${Object.entries(conflict.set).map(([name, v]) => `${q(name)} = ${expr(v)}`).join(', ')}`;
          if (own(conflict, 'updateWhere')) out += ` WHERE ${expr(conflict.updateWhere)}`;
        }
      }
    }
    else return fail('mutation op is insert, update or delete');
    if (spec.returning !== undefined) out += ` RETURNING ${projection(spec.returning, 0)}`;
    return out;
  };
  return { expr, select, mutation, order, params };
}

/** Produce reviewable, bound SQLite SQL from structural data.
 * @param {any} document @param {{externals?:Record<string,any>}} [options]
 * @returns {RelationalPlan} */
export function planRelational(document, options) {
  const emitter = relationalEmitter(options);
  const writing = object(document) && own(document, 'op');
  return { sql: writing ? emitter.mutation(document) : emitter.select(document),
    params: emitter.params, access: writing ? 'write' : 'read' };
}

/** Native SQLite operations without a model store. Raw text and Uint8Array
 * values travel directly through the driver, including synchronous cursors.
 * @param {any} connection */
export function relational(connection) {
  if (connection.dialect.name !== 'sqlite' || !connection.synchronous) fail('relational operations require a synchronous SQLite connection');
  const read = (document, options) => {
    if (connection.mustQueue) fail('synchronous reads cannot enter another transaction');
    const plan = planRelational(document, options);
    if (plan.access !== 'read') fail('a read method requires a select document');
    return plan;
  };
  return Object.freeze({
    plan: planRelational,
    all(document, options = undefined) {
      const plan = read(document, options);
      return chain(connection.prepare(plan.sql, { readOnly: true }), (s) => s.all(plan.params));
    },
    get(document, options = undefined) {
      const plan = read(document, options);
      return chain(connection.prepare(plan.sql, { readOnly: true }), (s) => s.get(plan.params));
    },
    iterate(document, options = undefined) {
      const plan = read(document, options);
      return createSyncCursor({ ...rowClassOf(connection),
        open: () => {
          if (connection.mustQueue) fail('synchronous iteration cannot enter another transaction');
          return connection.prepare(plan.sql, { readOnly: true, ephemeral: true }).iterate(plan.params);
        },
        items: (row) => [row],
      });
    },
    execute(document, options = undefined) {
      if (connection.mustQueue) fail('synchronous mutation cannot wait for another transaction');
      const plan = planRelational(document, options);
      if (plan.access !== 'write') fail('execute requires a mutation document');
      return connection.transaction(() => chain(connection.prepare(plan.sql), (s) =>
        document.returning !== undefined ? chain(s.all(plan.params), (rows) => ({ affected: rows.length, rows }))
          : chain(s.run(plan.params), (result) => ({ affected: Number(result.changes), lastInsertRowid: result.lastInsertRowid }))));
    },
  });
}
