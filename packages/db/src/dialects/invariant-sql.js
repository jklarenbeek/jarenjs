//@ts-check
/** Trigger lowering for bounded query predicates over old/new columns. One
 * compiler reads a table's database rules into per-operation programs; each
 * dialect spells a column read, a comparison and a truth value its own way and
 * renders the programs as its triggers. */
import { hashContent } from '@jarenjs/core/string';
import { DbCompileError, INVARIANT_MARKER } from '../errors.js';
import { existsRowSql, RULE_CODECS, ruleLiteral, sameTable } from '../invariants.js';

const SAFE_RANGE = 'BETWEEN -9007199254740991 AND 9007199254740991';

/** SQLite spells types by storage class, so a rule's operand carries its own
 * storage check: a value the codec could not read refuses the write. */
const SQLITE = {
  true: '1',
  false: '0',
  equal: 'IS',
  different: 'IS NOT',
  /** @param {any} column @param {string} ref */
  column(column, ref) {
    const type = `typeof(${ref})`;
    let valid = ['integer', 'number', 'boolean'].includes(column.codec)
      ? column.codec === 'number' ? `${type} IN ('integer', 'real') AND ${ref} ${SAFE_RANGE}`
        : `${type} = 'integer' AND ${column.codec === 'boolean' ? `${ref} IN (0, 1)` : `${ref} ${SAFE_RANGE}`}`
      : `${type} = 'text'`;
    if (column.null === 'null') valid = `${ref} IS NULL OR (${valid})`;
    return { value: `(${ref} COLLATE BINARY)`, domain: `(${valid})` };
  },
  /** @param {any} column @param {(name: string) => string} q */
  changed: (column, q) => `OLD.${q(column.physical)} IS NOT NEW.${q(column.physical)}`,
  /** @param {string} table @param {(name: string) => string} q */
  table: (table, q) => q(table),
};

/**
 * Compile one table's database rules into programs, one per operation and
 * `UPDATE OF` column set, in insert, update, delete order: the checks (each a
 * condition that is true when the write must be refused), the audit inserts
 * and the increments, in declaration order. A program's `name` is its suffix
 * after the table: the operation, or `update_of_<hash of its columns>`.
 * @param {any} mapping @param {any} all @param {any} dialect @param {any} flavor
 * @returns {{ op: string, name: string, columns: string[], rules: string[], checks: { rule: string, when: string }[],
 *   audits: { rule: string, table: string, names: string[], values: string[], when: string }[],
 *   increments: { rule: string, column: string, when: string }[] }[]}
 */
export function compileInvariants(mapping, all, dialect, flavor) {
  const q = dialect.quoteIdentifier;
  const sl = dialect.stringLiteral;
  const fail = (why) => { throw new DbCompileError('JD0005', `database invariant: ${why}`); };
  const rules = mapping.invariants ?? [];
  const columns = mapping.columns;
  let domains = new Set();
  const columnOf = (value) => {
    const match = /^\$\.(old|new)\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(value);
    return match ? { record: match[1], column: columns.find((c) => c.name === match[2]), name: match[2] } : null;
  };
  // `raw` reads a column as its stored value, for a probe's own comparison.
  // The query language reads a string that starts with `$` as an expression
  // (`$$` escapes a literal `$`), so a lowered rule reads `$.op` and old/new
  // members and refuses every other expression rather than compare its text
  const scalar = (value, op, raw = false) => {
    if (typeof value === 'string' && value.startsWith('$') && !value.startsWith('$$')) {
      if (value === '$.op') return sl(op);
      const path = columnOf(value);
      if (!path) return fail(`unsupported record path '${value}'; a text that starts with $ is written $$`);
      const { record, column, name } = path;
      if (!column || column.null === 'absent' || !RULE_CODECS.includes(column.codec)) return fail(`'${name}' needs a scalar column codec`);
      if ((op === 'insert' && record === 'old') || (op === 'delete' && record === 'new')) return fail('a property of an unavailable record is absent, not SQL NULL');
      const ref = `${record.toUpperCase()}.${q(column.physical)}`;
      const read = flavor.column(column, ref);
      if (read.domain !== null) domains.add(read.domain);
      return raw ? ref : read.value;
    }
    if (value === null) return 'NULL';
    if (typeof value === 'string') return sl(ruleLiteral(value));
    if (typeof value === 'boolean') return value ? flavor.true : flavor.false;
    if (typeof value === 'number' && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value))) return String(value);
    if (value && typeof value === 'object' && Object.keys(value).length === 1 && Object.hasOwn(value, '$const')) {
      const literal = value.$const;
      return typeof literal === 'string' ? sl(literal) : scalar(literal, op, raw);
    }
    return fail('only scalar literals and old/new property paths can be lowered');
  };
  const typeOf = (value) => {
    if (typeof value === 'string' && value.startsWith('$') && !value.startsWith('$$')) {
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
    if (typeof node === 'boolean') return node ? flavor.true : flavor.false;
    if (!node || typeof node !== 'object' || Array.isArray(node) || Object.keys(node).length !== 1) return fail('predicate must be a bounded query expression');
    const [key, args] = Object.entries(node)[0];
    if (key === '$and' || key === '$or') {
      if (!Array.isArray(args) || !args.length) return fail('logical predicates require operands');
      return `(${args.map((a) => predicate(a, op)).join(key === '$and' ? ' AND ' : ' OR ')})`;
    }
    if (key === '$not') return `(NOT (${predicate(args, op)}))`;
    if (key === '$exists-row') {
      const target = all.entities[args.entity];
      return existsRowSql({ match: args.match, target, keys: target.keys }, dialect, (expression) => scalar(expression, op, true));
    }
    const operators = { $eq: flavor.equal, $ne: flavor.different, $lt: '<', $le: '<=', $gt: '>', $ge: '>=' };
    if (!operators[key] || !Array.isArray(args) || args.length !== 2) return fail(`unsupported predicate '${key}'`);
    const left = scalar(args[0], op), right = scalar(args[1], op);
    const lt = typeOf(args[0]), rt = typeOf(args[1]);
    if (lt !== rt && lt !== 'null' && rt !== 'null') return key === '$ne' ? flavor.true : flavor.false;
    // an ordered comparison holds between two numbers or two texts, never
    // over a boolean (QUERY-FORMAT §8.4); SQL would order false before true
    if (key !== '$eq' && key !== '$ne' && (lt === 'boolean' || rt === 'boolean')) return flavor.false;
    const compare = `(${left} ${operators[key]} ${right})`;
    return key === '$eq' || key === '$ne' ? compare : `COALESCE(${compare}, ${flavor.false})`;
  };
  // an incremented member is the database's, like a version: never a change
  const incremented = new Set(rules.flatMap((rule) => rule.enforcement === 'database' ? (rule.effects ?? []).map((e) => e.increment) : []));
  const changed = columns.filter((c) => c.name !== mapping.version && !c.generated && !incremented.has(c.name))
    .map((c) => flavor.changed(c, q, dialect)).join(' OR ') || flavor.false;
  const physicalOf = (member) => /** @type {any} */ (columns.find((c) => c.name === member)).physical;
  /** @type {Map<string, any>} */
  const programs = new Map();
  const programOf = (op, of = []) => {
    const name = of.length === 0 ? op : `${op}_of_${hashContent(of.join('\0'))}`;
    const known = programs.get(name);
    // a short hash names the column set: two sets that meet in it would
    // merge into one program that one of them never fires
    if (known !== undefined && known.columns.join('\0') !== of.join('\0'))
      fail(`the column sets ${JSON.stringify(known.columns)} and ${JSON.stringify(of)} name one program '${name}'; give one rule another set`);
    if (known === undefined) programs.set(name, { op, name, columns: of, rules: [], checks: [], audits: [], increments: [] });
    return programs.get(name);
  };
  for (const rule of rules) {
    if (rule.enforcement !== 'database') continue;
    if (mapping.document !== false || mapping.kind === 'view') fail('database rules require a writable explicit column layout');
    for (const op of rule.on) {
      domains = new Set();
      const of = op === 'update' && rule.columns !== undefined ? rule.columns.map(physicalOf).sort() : [];
      // a rule fires on assignment when it says so or names its columns
      const guarded = op === 'update' && rule.when !== 'assigned' && of.length === 0;
      const assertion = predicate(rule.assert, op);
      if (rule.audit !== undefined) {
        const target = all.entities[rule.audit.entity];
        if (!target || target.document !== false || target.kind === 'view') fail('audit target must be a mapped application table');
        // two entities can map one table: the table decides, not the entity
        if (sameTable(target, mapping) || Object.values(all.entities).some((other) => sameTable(other, target)
          && (other.invariants ?? []).some((r) => r.audit !== undefined))) fail('recursive or chained audit effects are refused');
        const names = [], values = [];
        for (const [member, expression] of Object.entries(rule.audit.values)) {
          const column = target.columns.find((c) => c.name === member);
          if (!column || column.generated || !['text', 'integer', 'number', 'boolean'].includes(column.codec)) fail(`audit member '${member}' needs a writable scalar codec`);
          const expected = column.codec === 'text' ? 'string' : column.codec === 'boolean' ? 'boolean' : 'number';
          const actual = typeOf(expression);
          if (actual !== expected && actual !== 'null') fail(`audit member '${member}' needs a matching scalar type`);
          flavor.auditValue?.(column, expression, (path) => columnOf(path)?.column, fail);
          const value = scalar(expression, op);
          if (column.null === 'reject') domains.add(`(${value} IS NOT NULL)`);
          names.push(q(column.physical)); values.push(value);
        }
        if (!names.length) fail('audit values cannot be empty');
        programOf(op, of).audits.push({ rule: rule.name, table: flavor.table(target.table, q, dialect), names, values,
          when: guarded ? `(${changed})` : '' });
      }
      const program = programOf(op, of);
      program.rules.push(rule.name);
      program.checks.push({ rule: rule.name,
        when: `${guarded ? `(${changed}) AND ` : ''}(${[...domains, assertion].join(' AND ')}) IS NOT TRUE` });
      if (op === 'update') for (const effect of rule.effects ?? [])
        program.increments.push({ rule: rule.name, column: physicalOf(effect.increment), when: guarded ? `(${changed})` : '' });
    }
  }
  const order = ['insert', 'update', 'delete'];
  return [...programs.values()].sort((a, b) => order.indexOf(a.op) - order.indexOf(b.op)
    || a.columns.length - b.columns.length || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** An increment is the trigger's last statement, a guarded update of its own
 * row: a trigger never fires itself while `recursive_triggers` is off, which
 * the store asserts at open.
 * @param {any} mapping @param {any} all @param {any} dialect @returns {any[]} */
export function sqliteInvariantTriggers(mapping, all, dialect) {
  const q = dialect.quoteIdentifier;
  const sl = dialect.stringLiteral;
  const row = mapping.keys.map((key) => {
    const column = q(/** @type {any} */ (mapping.columns.find((c) => c.name === key)).physical);
    return `${column} = NEW.${column}`;
  }).join(' AND ');
  return compileInvariants(mapping, all, dialect, SQLITE).map((program) => {
    const bodies = [
      ...program.checks.map((check) => `SELECT RAISE(ABORT, ${sl(`${INVARIANT_MARKER}${check.rule}`)}) WHERE ${check.when};`),
      ...program.audits.map((audit) => `INSERT INTO ${audit.table} (${audit.names.join(', ')}) SELECT ${audit.values.join(', ')}${audit.when ? ` WHERE ${audit.when}` : ''};`),
      ...program.increments.map((increment) => `UPDATE ${q(mapping.table)} SET ${q(increment.column)} = OLD.${q(increment.column)} + 1 `
        + `WHERE ${row} AND NEW.${q(increment.column)} IS OLD.${q(increment.column)}${increment.when ? ` AND ${increment.when}` : ''};`)];
    const name = `_jaren_rule_${mapping.table.length}_${mapping.table}_${program.name}`;
    const event = `${program.op.toUpperCase()}${program.columns.length ? ` OF ${program.columns.map(q).join(', ')}` : ''}`;
    return { type: 'trigger', name, owner: mapping.table, rule: program.rules.join(','),
      ...(program.increments.length ? { selfUpdate: true } : {}),
      sql: `CREATE TRIGGER ${q(name)} AFTER ${event} ON ${q(mapping.table)} BEGIN ${bodies.join(' ')} END` };
  });
}
