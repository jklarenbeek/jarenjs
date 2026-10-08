//@ts-check
/** Persistence rules compile through the existing query evaluator. SQL lowering
 * accepts a bounded scalar subset and reports its writer population explicitly.
 * A `$exists-row` probe reads one row of another table by its key: the store
 * answers it with the same SQL the database's trigger runs. */
import { compileJsonQuery } from '@jarenjs/json/query';
import { chain } from './driver.js';
import { DbCompileError, DbRuntimeError } from './errors.js';
import { refuseUnknownModelMembers } from './options.js';

const MEMBERS = ['name', 'on', 'assert', 'enforcement', 'audit', 'when', 'columns', 'effects'];
/** The codecs a rule compares, as SQL and as JSON alike. */
export const RULE_CODECS = ['text', 'integer', 'number', 'boolean', 'date', 'datetime'];
/** A rule value that reads the record: `$.old.<member>` or `$.new.<member>`. */
export const RECORD_PATH = /^\$\.(old|new)\.([A-Za-z_][A-Za-z0-9_]*)$/;

/**
 * The literal a rule value that is not a record path stands for. The query
 * language reads a string that starts with `$` as an expression and `$$` as
 * the escape for a literal `$`, so `$$x` is the text `$x`; a `$const` holds
 * its value as written.
 * @param {any} value @returns {any}
 */
export function ruleLiteral(value) {
  if (typeof value === 'string') return value.startsWith('$$') ? value.slice(1) : value;
  let literal = value;
  while (literal && typeof literal === 'object' && Object.hasOwn(literal, '$const')) literal = literal.$const;
  return literal;
}

/** ASCII letters lowered, as SQLite folds an identifier: the one comparison
 * of two schema names a model can meet in. @param {string} name @returns {string} */
export const foldIdentifier = (name) => name.replace(/[A-Z]/g, (letter) => letter.toLowerCase());

/**
 * Whether two layouts can name one table: the same name as SQLite compares
 * identifiers (ASCII case aside), in one schema or where either leaves its
 * schema to the connection.
 * @param {{ table: string, schema?: string }} a @param {{ table: string, schema?: string }} b
 */
export function sameTable(a, b) {
  return foldIdentifier(a.table) === foldIdentifier(b.table)
    && (a.schema === undefined || b.schema === undefined || foldIdentifier(a.schema) === foldIdentifier(b.schema));
}

/** Replace each `$exists-row` with a read of its answer, collecting the probes.
 * @param {any} node @param {any[]} probes @param {(why: string) => never} fail @returns {any} */
function withProbes(node, probes, fail) {
  if (Array.isArray(node)) return node.map((item) => withProbes(item, probes, fail));
  if (!node || typeof node !== 'object' || Object.hasOwn(node, '$const')) return node;
  if (Object.hasOwn(node, '$exists-row')) {
    const probe = node['$exists-row'];
    if (Object.keys(node).length !== 1 || !probe || typeof probe !== 'object' || Array.isArray(probe)
      || Object.keys(probe).some((key) => !['entity', 'match'].includes(key)) || typeof probe.entity !== 'string'
      || !probe.match || typeof probe.match !== 'object' || Array.isArray(probe.match) || Object.keys(probe.match).length === 0)
      fail('$exists-row is { entity, match: { <member>: <value>, … } }');
    probes.push({ entity: probe.entity, match: probe.match });
    return { $eq: [`$.probes[${probes.length - 1}]`, true] };
  }
  return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, withProbes(value, probes, fail)]));
}

/** @param {any} rules @param {string} path @returns {any[]} */
export function normalizeInvariants(rules, path) {
  if (rules === undefined) return [];
  if (!Array.isArray(rules)) throw new DbCompileError('JD0005', 'invariants must be an array', path);
  const names = new Set();
  return rules.map((rule, index) => {
    const at = `${path}/${index}`;
    /** A refusal at this rule, or at one of its members. @param {string} reason @param {string} [member] @returns {never} */
    const fail = (reason, member = undefined) => {
      throw new DbCompileError('JD0005', reason, member === undefined ? at : `${at}/${member}`);
    };
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) fail('an invariant must be an object');
    refuseUnknownModelMembers(rule, MEMBERS, at, 'invariant');
    if (typeof rule.name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(rule.name) || names.has(rule.name)) fail('invariant names must be distinct identifiers', 'name');
    names.add(rule.name);
    if (!['database', 'store'].includes(rule.enforcement)) fail('invariant enforcement must be database or store', 'enforcement');
    if (!Array.isArray(rule.on) || !rule.on.length || new Set(rule.on).size !== rule.on.length
      || rule.on.some((op) => !['insert', 'update', 'delete'].includes(op))) fail('invariant on must name distinct insert/update/delete operations', 'on');
    if (rule.assert === undefined) fail('invariant assert is required', 'assert');
    if (rule.audit !== undefined && (rule.enforcement !== 'database' || !rule.audit
      || typeof rule.audit.entity !== 'string' || !rule.audit.values || typeof rule.audit.values !== 'object'
      || Array.isArray(rule.audit.values) || Object.keys(rule.audit).some((k) => !['entity', 'values'].includes(k)))) fail('audit is a database effect with an entity and values', 'audit');
    if (rule.when !== undefined && (!['changed', 'assigned'].includes(rule.when) || !rule.on.includes('update')))
      fail("invariant when is 'changed' or 'assigned', on a rule that includes update", 'when');
    if (rule.columns !== undefined && (!rule.on.includes('update') || !Array.isArray(rule.columns) || rule.columns.length === 0
      || new Set(rule.columns).size !== rule.columns.length || rule.columns.some((c) => typeof c !== 'string' || c === '')))
      fail('invariant columns name distinct members, on a rule that includes update', 'columns');
    if (rule.columns !== undefined && rule.when === 'changed') fail("invariant columns fire on assignment, which when: 'changed' contradicts", 'columns');
    if (rule.effects !== undefined && (rule.enforcement !== 'database' || !rule.on.includes('update') || !Array.isArray(rule.effects)
      || rule.effects.length === 0 || rule.effects.some((e) => !e || typeof e !== 'object' || Array.isArray(e)
        || Object.keys(e).length !== 1 || typeof e.increment !== 'string' || e.increment === '')))
      fail('effects are database effects of a rule that includes update: [{ increment: <member> }]', 'effects');
    if (rule.effects !== undefined && rule.columns !== undefined) fail('an increment runs on every update of the row, never on columns alone', 'columns');
    const probes = [];
    const expression = withProbes(rule.assert, probes, (reason) => fail(reason, 'assert'));
    let evaluate;
    try {
      evaluate = compileJsonQuery(expression);
    }
    catch (cause) {
      // compiled where the model is checked, as a `{ query }` default is: the
      // engine's reason travels with the rule's position
      throw new DbCompileError('JD0005', `invariant assert does not compile: ${/** @type {Error} */ (cause).message}`,
        `${at}/assert`, /** @type {Error} */ (cause));
    }
    return { ...rule, probes, evaluate };
  });
}

/** The record paths a value reads, outside `$const`.
 * @param {any} node @param {string[]} [out] @returns {string[]} */
function pathsOf(node, out = []) {
  if (typeof node === 'string' && node.startsWith('$.')) out.push(node);
  else if (Array.isArray(node)) for (const item of node) pathsOf(item, out);
  else if (node && typeof node === 'object' && !Object.hasOwn(node, '$const'))
    for (const value of Object.values(node)) pathsOf(value, out);
  return out;
}

/**
 * Resolve what a rule names in other members and entities, once the whole
 * model is known: `columns` and increments name physical columns of their own
 * entity, a probe's target is another table's physical layout, its match
 * covers the target's key, and each match value is a member the rule's own
 * entity has, of the target column's codec, or a literal that codec holds.
 * Both enforcements read the result.
 * @param {Map<string, any>} entities
 * @param {(column: any) => { encode: (value: any) => any }} codecOf the column codec
 */
export function resolveInvariants(entities, codecOf) {
  for (const entity of entities.values()) {
    const layout = entity.physical;
    const columnOf = (member) => layout?.columns.find((c) => c.name === member);
    const increments = new Set();
    for (const [index, rule] of entity.invariants.entries()) {
      /** A refusal at one member of this rule. @param {string} reason @param {string} member @returns {never} */
      const fail = (reason, member) => {
        throw new DbCompileError('JD0005', reason, `${entity.docPath}/invariants/${index}/${member}`);
      };
      // a store-owned layout gets no trigger, so a database rule on one was
      // enforced by nothing at all, and a view takes no writes: refused at the
      // member, as `planInvariants` refuses them; so is an audit into a table
      // no entity maps for writing
      if ((layout === null || layout.kind === 'view') && rule.enforcement === 'database')
        fail('database invariant: database rules require a writable explicit column layout', 'enforcement');
      const audited = rule.audit === undefined ? undefined : entities.get(rule.audit.entity)?.physical;
      if (rule.audit !== undefined && (audited === undefined || audited === null || audited.kind === 'view'))
        fail('database invariant: audit target must be a mapped application table', 'audit');
      if (rule.columns !== undefined) {
        if (layout === null) fail('invariant columns name the columns of a physical layout; a document is written whole', 'columns');
        for (const member of rule.columns)
          if (!columnOf(member) || columnOf(member).generated) fail(`invariant column '${member}' must name a writable mapped column`, 'columns');
      }
      for (const effect of rule.effects ?? []) {
        const column = columnOf(effect.increment);
        if (layout === null || !column || column.codec !== 'integer' || column.null !== 'reject' || column.generated || entity.keys.includes(effect.increment))
          fail(`increment '${effect.increment}' must name a non-key, non-null integer column`, 'effects');
        if (increments.has(effect.increment)) fail(`'${effect.increment}' is incremented by one rule only`, 'effects');
        increments.add(effect.increment);
      }
      for (const probe of rule.probes) {
        const refuse = (/** @type {string} */ reason) => fail(reason, 'assert');
        const target = entities.get(probe.entity);
        if (!target || target.physical === null) refuse(`$exists-row reads a physical layout; '${probe.entity}' has none`);
        if (target.physical.kind === 'view') refuse(`$exists-row reads a table by its primary key; '${probe.entity}' is a view, which has none`);
        // two entities can map one table: the table decides, not the entity
        if (sameTable(target.physical, layout ?? { table: entity.name }))
          refuse("$exists-row reads another table: PostgreSQL's row triggers run at statement end, SQLite's per row");
        for (const key of target.keys)
          if (!Object.hasOwn(probe.match, key)) refuse(`$exists-row on '${probe.entity}' must match its key member '${key}'`);
        for (const [member, value] of Object.entries(probe.match)) {
          const column = target.physical.columns.find((c) => c.name === member);
          if (!column || column.null === 'absent' || !RULE_CODECS.includes(column.codec)) refuse(`$exists-row member '${member}' needs a scalar column codec`);
          const escaped = typeof value === 'string' && value.startsWith('$') && !value.startsWith('$$');
          const path = escaped ? RECORD_PATH.exec(value) : null;
          if (escaped && path === null) refuse(`$exists-row value '${value}' must read $.old.<member> or $.new.<member>; a text that starts with $ is written $$`);
          if (path !== null) {
            const name = path[2];
            if (layout === null) {
              if (entity.properties.get(name)?.relation !== undefined || !entity.properties.has(name))
                refuse(`$exists-row value '${value}': '${entity.name}' has no stored property '${name}'`);
              continue;
            }
            const source = columnOf(name);
            if (source === undefined) refuse(`$exists-row value '${value}': '${entity.name}' has no column '${name}'`);
            // the two engines compare a match as the target's type: one codec
            // on both sides (an integer into a number column is exact) or the
            // database and the store would round or reparse it differently
            if (source.codec !== column.codec && !(source.codec === 'integer' && column.codec === 'number'))
              refuse(`$exists-row matches ${column.codec} column '${member}' with ${source.codec} column '${name}'; a match compares one codec`);
            continue;
          }
          const literal = ruleLiteral(value);
          if (literal === null) continue;
          if (!['string', 'number', 'boolean'].includes(typeof literal)) refuse(`$exists-row value for '${member}' must be a scalar`);
          try { codecOf(column).encode(literal); }
          catch { refuse(`$exists-row value ${JSON.stringify(literal)} is not one the ${column.codec} column '${member}' holds`); }
        }
        probe.target = target.physical;
        probe.keys = target.keys;
      }
    }
    if (increments.size > 0) for (const [index, rule] of entity.invariants.entries()) {
      if (!rule.on.includes('update')) continue;
      const at = `${entity.docPath}/invariants/${index}`;
      for (const member of increments) {
        const readIn = pathsOf(rule.assert).includes(`$.new.${member}`) ? 'assert'
          : pathsOf(rule.audit?.values ?? {}).includes(`$.new.${member}`) ? 'audit' : null;
        if (readIn !== null)
          throw new DbCompileError('JD0005', `'${member}' is incremented by the database: an update rule cannot read $.new.${member}`, `${at}/${readIn}`);
        if (rule.columns?.includes(member))
          throw new DbCompileError('JD0005', `'${member}' is incremented by the database and cannot be a rule column`, `${at}/columns`);
      }
    }
  }
}

/** @param {string} name @returns {DbRuntimeError} */
export function invariantFailure(name) {
  const error = new DbRuntimeError('JD2096', `persistence invariant '${name}' rejected the mutation`);
  error.class = 'constraint';
  error.retryable = false;
  return error;
}

/**
 * Store enforcement. An update rule with `columns` is checked when the write
 * assigns one of them (`assigned` names the members a statement sets; absent,
 * it sets them all); a rule that judges changes (neither `when: "assigned"`
 * nor `columns`) is skipped when `unchanged` says the write changed no member
 * a database rule counts. A probe is answered by `probe(probe, record)`, a
 * value-or-promise of a boolean, so a synchronous driver stays synchronous; a
 * caller that checks before its transaction opens passes `defer`, and a rule
 * that reads another row is handed to it to run inside that transaction.
 * @param {any[]} rules @param {string} op @param {any} before @param {any} after
 * @param {{ assigned?: Iterable<string>, unchanged?: boolean, probe?: (probe: any, record: any) => any,
 *   defer?: (run: () => any) => void }} [context]
 * @returns {any} value-or-promise
 */
export function checkInvariants(rules, op, before, after, context = {}) {
  const assigned = context.assigned === undefined ? null : new Set(context.assigned);
  const record = { old: before ?? null, new: after ?? null, op };
  const check = (i) => {
    for (; i < rules.length; i++) {
      const rule = rules[i];
      if (rule.enforcement !== 'store' || !rule.on.includes(op)) continue;
      if (op === 'update' && rule.columns !== undefined && assigned !== null && !rule.columns.some((member) => assigned.has(member))) continue;
      if (op === 'update' && context.unchanged === true && rule.columns === undefined && rule.when !== 'assigned') continue;
      if (rule.probes.length === 0) {
        if (rule.evaluate(record) !== true) throw invariantFailure(rule.name);
        continue;
      }
      if (typeof context.probe !== 'function') throw new DbRuntimeError('JD2096', `persistence invariant '${rule.name}' needs a probe of '${rule.probes[0].entity}'`);
      const probe = context.probe;
      const run = () => {
        const answers = [];
        const answer = (j) => j >= rule.probes.length ? null
          : chain(probe(rule.probes[j], record), (found) => { answers.push(found === true); return answer(j + 1); });
        return chain(answer(0), () => {
          if (rule.evaluate({ ...record, probes: answers }) !== true) throw invariantFailure(rule.name);
        });
      };
      if (context.defer !== undefined) { context.defer(run); continue; }
      const at = i;
      return chain(run(), () => check(at + 1));
    }
    return null;
  };
  return check(0);
}

/**
 * The one existence probe: a row of the target whose key members equal their
 * values (`=`, an indexed read) and whose other members match null-safely, so a
 * `null` literal means IS NULL. `value` renders one match value.
 * @param {any} probe a resolved probe @param {any} dialect
 * @param {(expression: any, column: any) => string} value @returns {string}
 */
export function existsRowSql(probe, dialect, value) {
  const q = dialect.quoteIdentifier;
  const alias = q('_jaren_row');
  const conditions = Object.entries(probe.match).map(([member, expression]) => {
    const column = probe.target.columns.find((c) => c.name === member);
    const left = `${alias}.${q(column.physical)}`;
    const right = value(expression, column);
    if (probe.keys.includes(member)) return `${left} = ${right}`;
    // SQLite compares text by code point, whatever the column's collation
    const different = dialect.physicalDifferent?.(column.codec, left, right) ?? `${left} IS NOT ${right} COLLATE BINARY`;
    return `NOT (${different})`;
  });
  return `EXISTS (SELECT 1 FROM ${dialect.tableName(probe.target.table, probe.target.schema ?? dialect.schema)} AS ${alias} WHERE ${conditions.join(' AND ')})`;
}
