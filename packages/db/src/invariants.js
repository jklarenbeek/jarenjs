//@ts-check
/** Persistence rules compile through the existing query evaluator. SQL lowering
 * accepts a bounded scalar subset and reports its writer population explicitly.
 * A `$exists-row` probe reads one row of another table by its key: the store
 * answers it with the same SQL the database's trigger runs. */
import { compileJsonQuery } from '@jarenjs/json/query';
import { chain } from './driver.js';
import { DbCompileError, DbRuntimeError } from './errors.js';

const MEMBERS = ['name', 'on', 'assert', 'enforcement', 'audit', 'when', 'columns', 'effects'];
/** The codecs a rule compares, as SQL and as JSON alike. */
export const RULE_CODECS = ['text', 'integer', 'number', 'boolean', 'date', 'datetime'];

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
  return rules.map((rule) => {
    const fail = (reason) => { throw new DbCompileError('JD0005', reason, path); };
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) fail('an invariant must be an object');
    for (const key of Object.keys(rule))
      if (!MEMBERS.includes(key)) fail(`unknown invariant member '${key}'`);
    if (typeof rule.name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(rule.name) || names.has(rule.name)) fail('invariant names must be distinct identifiers');
    names.add(rule.name);
    if (!['database', 'store'].includes(rule.enforcement)) fail('invariant enforcement must be database or store');
    if (!Array.isArray(rule.on) || !rule.on.length || new Set(rule.on).size !== rule.on.length
      || rule.on.some((op) => !['insert', 'update', 'delete'].includes(op))) fail('invariant on must name distinct insert/update/delete operations');
    if (rule.assert === undefined) fail('invariant assert is required');
    if (rule.audit !== undefined && (rule.enforcement !== 'database' || !rule.audit
      || typeof rule.audit.entity !== 'string' || !rule.audit.values || typeof rule.audit.values !== 'object'
      || Array.isArray(rule.audit.values) || Object.keys(rule.audit).some((k) => !['entity', 'values'].includes(k)))) fail('audit is a database effect with an entity and values');
    if (rule.when !== undefined && (!['changed', 'assigned'].includes(rule.when) || !rule.on.includes('update')))
      fail("invariant when is 'changed' or 'assigned', on a rule that includes update");
    if (rule.columns !== undefined && (!rule.on.includes('update') || !Array.isArray(rule.columns) || rule.columns.length === 0
      || new Set(rule.columns).size !== rule.columns.length || rule.columns.some((c) => typeof c !== 'string' || c === '')))
      fail('invariant columns name distinct members, on a rule that includes update');
    if (rule.columns !== undefined && rule.when === 'changed') fail("invariant columns fire on assignment, which when: 'changed' contradicts");
    if (rule.effects !== undefined && (rule.enforcement !== 'database' || !rule.on.includes('update') || !Array.isArray(rule.effects)
      || rule.effects.length === 0 || rule.effects.some((e) => !e || typeof e !== 'object' || Array.isArray(e)
        || Object.keys(e).length !== 1 || typeof e.increment !== 'string' || e.increment === '')))
      fail('effects are database effects of a rule that includes update: [{ increment: <member> }]');
    if (rule.effects !== undefined && rule.columns !== undefined) fail('an increment runs on every update of the row, never on columns alone');
    const probes = [];
    const expression = withProbes(rule.assert, probes, fail);
    return { ...rule, probes, evaluate: compileJsonQuery(expression) };
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

/** The scalar type a match value or a column compares as.
 * @param {string} codec */
const typeOfCodec = (codec) => codec === 'boolean' ? 'boolean' : ['integer', 'number'].includes(codec) ? 'number' : 'string';

/**
 * Resolve what a rule names in other members and entities, once the whole
 * model is known: `columns` and increments name physical columns of their own
 * entity, a probe's target is another entity's physical layout and its match
 * covers the target's key. Both enforcements read the result.
 * @param {Map<string, any>} entities
 */
export function resolveInvariants(entities) {
  for (const entity of entities.values()) {
    const fail = (reason) => { throw new DbCompileError('JD0005', reason, `${entity.docPath}/invariants`); };
    const layout = entity.physical;
    const columnOf = (member) => layout?.columns.find((c) => c.name === member);
    const increments = new Set();
    for (const rule of entity.invariants) {
      if (rule.columns !== undefined) {
        if (layout === null) fail('invariant columns name the columns of a physical layout; a document is written whole');
        for (const member of rule.columns)
          if (!columnOf(member) || columnOf(member).generated) fail(`invariant column '${member}' must name a writable mapped column`);
      }
      for (const effect of rule.effects ?? []) {
        const column = columnOf(effect.increment);
        if (layout === null || !column || column.codec !== 'integer' || column.null !== 'reject' || column.generated || entity.keys.includes(effect.increment))
          fail(`increment '${effect.increment}' must name a non-key, non-null integer column`);
        if (increments.has(effect.increment)) fail(`'${effect.increment}' is incremented by one rule only`);
        increments.add(effect.increment);
      }
      for (const probe of rule.probes) {
        const target = entities.get(probe.entity);
        if (!target || target.physical === null) fail(`$exists-row reads a physical layout; '${probe.entity}' has none`);
        if (target === entity) fail("$exists-row reads another entity's table: PostgreSQL's row triggers run at statement end, SQLite's per row");
        for (const key of target.keys)
          if (!Object.hasOwn(probe.match, key)) fail(`$exists-row on '${probe.entity}' must match its key member '${key}'`);
        for (const [member, value] of Object.entries(probe.match)) {
          const column = target.physical.columns.find((c) => c.name === member);
          if (!column || column.null === 'absent' || !RULE_CODECS.includes(column.codec)) fail(`$exists-row member '${member}' needs a scalar column codec`);
          let literal = value;
          while (literal && typeof literal === 'object' && Object.hasOwn(literal, '$const')) literal = literal.$const;
          const path = typeof value === 'string' && value.startsWith('$.') ? /^\$\.(old|new)\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(value) : null;
          if (typeof value === 'string' && value.startsWith('$.') && path === null) fail(`$exists-row value '${value}' must read $.old or $.new`);
          const source = path === null ? undefined : columnOf(path[2]);
          const type = path !== null ? source === undefined ? null : typeOfCodec(source.codec)
            : literal === null ? null : typeof literal;
          if (path === null && !['string', 'number', 'boolean'].includes(type ?? 'string')) fail(`$exists-row value for '${member}' must be a scalar`);
          if (type !== null && type !== typeOfCodec(column.codec)) fail(`$exists-row member '${member}' compares a ${type} with a ${typeOfCodec(column.codec)} column`);
        }
        probe.target = target.physical;
        probe.keys = target.keys;
      }
    }
    if (increments.size > 0) for (const rule of entity.invariants) {
      if (!rule.on.includes('update')) continue;
      const read = [...pathsOf(rule.assert), ...pathsOf(rule.audit?.values ?? {})];
      for (const member of increments) {
        if (read.includes(`$.new.${member}`)) fail(`'${member}' is incremented by the database: an update rule cannot read $.new.${member}`);
        if (rule.columns?.includes(member)) fail(`'${member}' is incremented by the database and cannot be a rule column`);
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
 * it sets them all). A probe is answered by `probe(probe, record)`, a
 * value-or-promise of a boolean, so a synchronous driver stays synchronous; a
 * caller that checks before its transaction opens passes `defer`, and a rule
 * that reads another row is handed to it to run inside that transaction.
 * @param {any[]} rules @param {string} op @param {any} before @param {any} after
 * @param {{ assigned?: Iterable<string>, probe?: (probe: any, record: any) => any,
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
    const different = dialect.physicalDifferent?.(column.codec, left, right) ?? `${left} IS NOT ${right}`;
    return `NOT (${different})`;
  });
  return `EXISTS (SELECT 1 FROM ${dialect.tableName(probe.target.table, probe.target.schema ?? dialect.schema)} AS ${alias} WHERE ${conditions.join(' AND ')})`;
}
