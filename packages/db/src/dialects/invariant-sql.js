//@ts-check
/** SQLite trigger lowering for bounded query predicates over old/new columns. */
import { DbCompileError } from '../errors.js';

/** @param {any} mapping @param {any} all @param {any} dialect @returns {any[]} */
export function sqliteInvariantTriggers(mapping, all, dialect) {
  const q = dialect.quoteIdentifier;
  const sl = dialect.stringLiteral;
  const fail = (why) => { throw new DbCompileError('JD0005', `database invariant: ${why}`); };
  const rules = mapping.invariants ?? [];
  const columns = mapping.columns;
  let domains = new Set();
  const scalar = (value, op) => {
    if (typeof value === 'string' && value.startsWith('$.')) {
      if (value === '$.op') return sl(op);
      const match = /^\$\.(old|new)\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(value);
      if (!match) return fail(`unsupported record path '${value}'`);
      const column = columns.find((c) => c.name === match[2]);
      if (!column || column.null === 'absent' || !['text', 'integer', 'number', 'boolean', 'date', 'datetime'].includes(column.codec)) return fail(`'${match[2]}' needs a scalar column codec`);
      if ((op === 'insert' && match[1] === 'old') || (op === 'delete' && match[1] === 'new')) return fail('a property of an unavailable record is absent, not SQL NULL');
      const ref = `${match[1].toUpperCase()}.${q(column.physical)}`;
      const type = `typeof(${ref})`;
      let valid = ['integer', 'number', 'boolean'].includes(column.codec)
        ? column.codec === 'number' ? `${type} IN ('integer', 'real') AND ${ref} BETWEEN -9007199254740991 AND 9007199254740991`
          : `${type} = 'integer' AND ${column.codec === 'boolean' ? `${ref} IN (0, 1)` : `${ref} BETWEEN -9007199254740991 AND 9007199254740991`}`
        : `${type} = 'text'`;
      if (column.null === 'null') valid = `${ref} IS NULL OR (${valid})`;
      domains.add(`(${valid})`);
      return `(${ref} COLLATE BINARY)`;
    }
    if (value === null) return 'NULL';
    if (typeof value === 'string') return sl(value);
    if (typeof value === 'boolean') return value ? '1' : '0';
    if (typeof value === 'number' && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value))) return String(value);
    if (value && typeof value === 'object' && Object.keys(value).length === 1 && Object.hasOwn(value, '$const')) {
      const literal = value.$const;
      return typeof literal === 'string' ? sl(literal) : scalar(literal, op);
    }
    return fail('only scalar literals and old/new property paths can be lowered');
  };
  const typeOf = (value) => {
    if (typeof value === 'string' && value.startsWith('$.')) {
      if (value === '$.op') return 'string';
      const name = value.slice(value.indexOf('.', 2) + 1);
      const column = columns.find((c) => c.name === name);
      return column?.codec === 'boolean' ? 'boolean'
        : ['integer', 'number'].includes(column?.codec) ? 'number' : 'string';
    }
    if (value && typeof value === 'object' && Object.hasOwn(value, '$const')) return value.$const === null ? 'null' : typeof value.$const;
    return value === null ? 'null' : typeof value;
  };
  const predicate = (node, op) => {
    if (typeof node === 'boolean') return node ? '1' : '0';
    if (!node || typeof node !== 'object' || Array.isArray(node) || Object.keys(node).length !== 1) return fail('predicate must be a bounded query expression');
    const [key, args] = Object.entries(node)[0];
    if (key === '$and' || key === '$or') {
      if (!Array.isArray(args) || !args.length) return fail('logical predicates require operands');
      return `(${args.map((a) => predicate(a, op)).join(key === '$and' ? ' AND ' : ' OR ')})`;
    }
    if (key === '$not') return `(NOT (${predicate(args, op)}))`;
    const operators = { $eq: 'IS', $ne: 'IS NOT', $lt: '<', $le: '<=', $gt: '>', $ge: '>=' };
    if (!operators[key] || !Array.isArray(args) || args.length !== 2) return fail(`unsupported predicate '${key}'`);
    const left = scalar(args[0], op), right = scalar(args[1], op);
    const lt = typeOf(args[0]), rt = typeOf(args[1]);
    if (lt !== rt && lt !== 'null' && rt !== 'null') return key === '$ne' ? '1' : '0';
    const compare = `(${left} ${operators[key]} ${right})`;
    return key === '$eq' || key === '$ne' ? compare : `COALESCE(${compare}, 0)`;
  };
  const changed = columns.filter((c) => c.name !== mapping.version && !c.generated)
    .map((c) => `OLD.${q(c.physical)} IS NOT NEW.${q(c.physical)}`).join(' OR ') || '0';
  const out = [];
  const groups = new Map();
  const add = (op, stage, rule, when, body) => {
    const key = `${op}_${stage}`;
    if (!groups.has(key)) groups.set(key, { op, stage, rules: [], bodies: [] });
    const group = groups.get(key);
    group.rules.push(rule); group.bodies.push(`${body}${when ? ` WHERE ${when}` : ''};`);
  };
  for (const rule of rules) {
    if (rule.enforcement !== 'database') continue;
    if (mapping.document !== false || mapping.kind === 'view') fail('database rules require a writable explicit column layout');
    for (const op of rule.on) {
      domains = new Set();
      const assertion = predicate(rule.assert, op);
      if (rule.audit !== undefined) {
        const target = all.entities[rule.audit.entity];
        if (!target || target.document !== false || target.kind === 'view') fail('audit target must be a mapped application table');
        if (target === mapping || (target.invariants ?? []).some((r) => r.audit)) fail('recursive or chained audit effects are refused');
        const names = [], values = [];
        for (const [member, expression] of Object.entries(rule.audit.values)) {
          const column = target.columns.find((c) => c.name === member);
          if (!column || column.generated || !['text', 'integer', 'number', 'boolean'].includes(column.codec)) fail(`audit member '${member}' needs a writable scalar codec`);
          const expected = column.codec === 'text' ? 'string' : column.codec === 'boolean' ? 'boolean' : 'number';
          const actual = typeOf(expression);
          if (actual !== expected && actual !== 'null') fail(`audit member '${member}' needs a matching scalar type`);
          const value = scalar(expression, op);
          if (column.null === 'reject') domains.add(`(${value} IS NOT NULL)`);
          names.push(q(column.physical)); values.push(value);
        }
        if (!names.length) fail('audit values cannot be empty');
        add(op, 'AFTER', rule.name, op === 'update' ? `(${changed})` : '',
          `INSERT INTO ${q(target.table)} (${names.join(', ')}) SELECT ${values.join(', ')}`);
      }
      const when = `${op === 'update' ? `(${changed}) AND ` : ''}(${[...domains, assertion].join(' AND ')}) IS NOT TRUE`;
      add(op, 'BEFORE', rule.name, when, `SELECT RAISE(ABORT, ${sl(`jaren invariant:${rule.name}`)})`);
    }
  }
  for (const op of ['insert', 'update', 'delete']) {
    const checks = groups.get(`${op}_BEFORE`);
    if (!checks) continue;
    const bodies = [...checks.bodies, ...(groups.get(`${op}_AFTER`)?.bodies ?? [])];
    const name = `_jaren_rule_${mapping.table.length}_${mapping.table}_${op}`;
    out.push({ type: 'trigger', name, owner: mapping.table, rule: checks.rules.join(','),
      sql: `CREATE TRIGGER ${q(name)} AFTER ${op.toUpperCase()} ON ${q(mapping.table)} BEGIN ${bodies.join(' ')} END` });
  }
  return out;
}
