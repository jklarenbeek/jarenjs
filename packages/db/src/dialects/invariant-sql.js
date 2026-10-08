//@ts-check
/** Trigger programs for a table's database rules. One compiler reads the rules
 * into per-operation programs, each assertion lowered by the row-predicate
 * module over the old/new columns; each dialect spells a column read, a
 * comparison and a truth value its own way and renders the programs as its
 * triggers. */
import { hashContent } from '@jarenjs/core/string';
import { DbCompileError, INVARIANT_MARKER } from '../errors.js';
import { existsRowSql, probeKeys, probeTarget, sameTable } from '../invariants.js';
import { rowPredicate, rulePaths, safeRange } from './row-predicate.js';

/** SQLite's flavor of the row-predicate lowering. SQLite spells types by
 * storage class, so a rule's operand carries its own storage check: a value
 * the codec could not read refuses the write. */
export const SQLITE = {
  true: '1',
  false: '0',
  equal: 'IS',
  different: 'IS NOT',
  /** @param {any} column @param {string} ref */
  column(column, ref) {
    const type = `typeof(${ref})`;
    let valid = ['integer', 'number', 'boolean'].includes(column.codec)
      ? column.codec === 'number' ? `${type} IN ('integer', 'real') AND ${safeRange(ref)}`
        : `${type} = 'integer' AND ${column.codec === 'boolean' ? `${ref} IN (0, 1)` : safeRange(ref)}`
      : `${type} = 'text'`;
    // SQL NULL is a JSON null or an absent member, where the column admits it
    if (column.null !== 'reject') valid = `${ref} IS NULL OR (${valid})`;
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
  /** @param {string} why @returns {never} */
  const fail = (why) => { throw new DbCompileError('JD0005', `database invariant: ${why}`); };
  const rules = mapping.invariants ?? [];
  const columns = mapping.columns;
  /** A probe of another table, keyed as the model check keyed it (the target's
   * key, or a declared unique index covering the match), its match values read
   * as the rule reads them. @param {any} args @param {(expression: any) => string} value */
  const probe = (args, value) => {
    const target = probeTarget(all.entities[args.entity]);
    const keys = probeKeys(target.keys, target.uniques, Object.keys(args.match), args.entity, fail);
    return existsRowSql({ match: args.match, target, keys }, dialect, value);
  };
  // an incremented member is the database's, like a version: never a change;
  // a store-owned table's document column holds the rest of the row
  const incremented = new Set(rules.flatMap((rule) => rule.enforcement === 'database' ? (rule.effects ?? []).map((e) => e.increment) : []));
  const changed = [...columns.filter((c) => c.name !== mapping.version && !c.generated && !incremented.has(c.name)),
    ...(mapping.documentColumn === undefined ? [] : [mapping.documentColumn])]
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
      const resolve = rulePaths(columns, op, q);
      // one lowering per operation: the domains its reads collect guard this check alone
      const lowering = rowPredicate({ flavor, dialect, resolve, fail, probe, releasedText: true });
      const of = op === 'update' && rule.columns !== undefined ? rule.columns.map(physicalOf).sort() : [];
      // a rule fires on assignment when it says so or names its columns
      const guarded = op === 'update' && rule.when !== 'assigned' && of.length === 0;
      const assertion = lowering.predicate(rule.assert);
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
          const actual = lowering.typeOf(expression);
          if (actual !== expected && actual !== 'null') fail(`audit member '${member}' needs a matching scalar type`);
          flavor.auditValue?.(column, expression, (/** @type {string} */ path) => resolve(path).column, fail);
          const value = lowering.scalar(expression);
          if (column.null === 'reject') lowering.domains.add(`(${value} IS NOT NULL)`);
          names.push(q(column.physical)); values.push(value);
        }
        if (!names.length) fail('audit values cannot be empty');
        programOf(op, of).audits.push({ rule: rule.name, table: flavor.table(target.table, q, dialect), names, values,
          when: guarded ? `(${changed})` : '' });
      }
      const program = programOf(op, of);
      program.rules.push(rule.name);
      program.checks.push({ rule: rule.name,
        when: `${guarded ? `(${changed}) AND ` : ''}(${[...lowering.domains, assertion].join(' AND ')}) IS NOT TRUE` });
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
 * the store asserts at open. Each program carries the statement that drops it.
 * @param {any} mapping @param {any} all @param {any} dialect @returns {any[]} */
export function sqliteInvariantTriggers(mapping, all, dialect) {
  const q = dialect.quoteIdentifier;
  const sl = dialect.stringLiteral;
  // the row an increment updates, by its key columns
  const row = () => mapping.keys.map((key) => {
    const column = q(/** @type {any} */ (mapping.columns.find((c) => c.name === key)).physical);
    return `${column} = NEW.${column}`;
  }).join(' AND ');
  return compileInvariants(mapping, all, dialect, SQLITE).map((program) => {
    const bodies = [
      ...program.checks.map((check) => `SELECT RAISE(ABORT, ${sl(`${INVARIANT_MARKER}${check.rule}`)}) WHERE ${check.when};`),
      ...program.audits.map((audit) => `INSERT INTO ${audit.table} (${audit.names.join(', ')}) SELECT ${audit.values.join(', ')}${audit.when ? ` WHERE ${audit.when}` : ''};`),
      ...program.increments.map((increment) => `UPDATE ${q(mapping.table)} SET ${q(increment.column)} = OLD.${q(increment.column)} + 1 `
        + `WHERE ${row()} AND NEW.${q(increment.column)} IS OLD.${q(increment.column)}${increment.when ? ` AND ${increment.when}` : ''};`)];
    const name = `_jaren_rule_${mapping.table.length}_${mapping.table}_${program.name}`;
    const event = `${program.op.toUpperCase()}${program.columns.length ? ` OF ${program.columns.map(q).join(', ')}` : ''}`;
    return { type: 'trigger', name, owner: mapping.table, rule: program.rules.join(','),
      ...(program.increments.length ? { selfUpdate: true } : {}),
      sql: `CREATE TRIGGER ${q(name)} AFTER ${event} ON ${q(mapping.table)} BEGIN ${bodies.join(' ')} END`,
      drop: `DROP TRIGGER ${q(name)}` };
  });
}
