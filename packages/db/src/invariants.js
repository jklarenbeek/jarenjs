//@ts-check
/** Persistence rules compile through the existing query evaluator. SQL lowering
 * accepts a bounded scalar subset and reports its writer population explicitly.
 * A `$exists-row` probe reads one row of another table by its key: the store
 * answers it with the same SQL the database's trigger runs. */
import { compileJsonQuery } from '@jarenjs/json/query';
import { isJsonObject } from '@jarenjs/core/object';
import { chain } from './driver.js';
import { DbCompileError, DbRuntimeError } from './errors.js';
import { refuseUnknownModelMembers } from './options.js';
import { IDENTIFIER } from './engine-metadata.js';
import { memberNames } from './model-path.js';

const MEMBERS = ['name', 'on', 'assert', 'enforcement', 'audit', 'when', 'columns', 'effects'];
/** The codecs a rule compares, as SQL and as JSON alike. */
export const RULE_CODECS = ['text', 'integer', 'number', 'boolean', 'date', 'datetime'];
/**
 * The record and member a rule value reads: `$.old.<member>` or
 * `$.new.<member>`, a member of any name also written `$.new['<member>']`;
 * `null` for any other value.
 * @param {unknown} value
 * @returns {{ record: 'old' | 'new', name: string } | null}
 */
export function recordPath(value) {
  const names = memberNames(value);
  return names?.length === 2 && (names[0] === 'old' || names[0] === 'new') ? { record: names[0], name: names[1] } : null;
}
/** The bound of the safe-integer range an integer a rule reads, and every sum,
 * difference or negation it computes, must hold to: ±(2^53 − 1), the range
 * the engine's doubles count exactly, held by the trigger and the store alike. */
export const SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
/** The arithmetic a rule lowers, each with its operand count: a sum, a difference, a negation. */
export const ARITHMETIC = Object.freeze({ $add: 2, $sub: 2, $neg: 1 });
/** The codec of a store-owned layout's column-mapped scalar, by the member's JSON type. */
const STORE_OWNED_CODECS = Object.freeze({ string: 'text', integer: 'integer', number: 'number', boolean: 'boolean' });

/** Whether a node is one of the arithmetic a rule lowers. @param {any} node */
export const isArithmetic = (node) => isJsonObject(node)
  && Object.keys(node).length === 1 && Object.hasOwn(ARITHMETIC, Object.keys(node)[0]);

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

/**
 * A probe's target as the planner reads it from the mapping, for the probe's
 * SQL and `probeKeys` (the model check resolved the same from the normalized
 * entities, so a plan recomputes rather than remembers): a physical layout's
 * table, columns and declared unique indexes, or a store-owned layout's
 * table, its column-mapped scalars and foreign-key columns — each by the
 * member's name, with the codec its storage holds — and its unique members
 * and entity indexes.
 * @param {any} entity - `explainMapping(model).entities[E]`
 * @returns {{ table: string, schema?: string, columns: any[], keys: string[],
 *   uniques: { name: string, members: (string | null)[], partial: boolean }[] }}
 */
export function probeTarget(entity) {
  if (entity.document === false) {
    return { table: entity.table, ...(entity.schema === undefined ? {} : { schema: entity.schema }), columns: entity.columns, keys: entity.keys,
      uniques: (entity.declaredIndexes ?? []).filter((/** @type {any} */ index) => index.unique) };
  }
  const codec = (/** @type {string} */ storage) => STORE_OWNED_CODECS[/** @type {keyof typeof STORE_OWNED_CODECS} */ (storage)];
  return { table: entity.table, keys: entity.keys,
    columns: [...entity.columns.filter((/** @type {any} */ column) => column.source === 'document')
      .map((/** @type {any} */ column) => ({ name: column.name, physical: column.name, codec: codec(column.storage) })),
    ...entity.foreignKeys.map((/** @type {any} */ fk) => ({ name: fk.column, physical: fk.column, codec: codec(fk.referencesType) }))],
    uniques: [...entity.indexes.filter((/** @type {any} */ index) => index.unique)
      .map((/** @type {any} */ index) => ({ name: index.property, members: [index.property], partial: false })),
    ...(entity.entityIndexes ?? []).filter((/** @type {any} */ index) => index.unique)
      // an expression key is no member's value: `null`, as a physical layout's expression term
      .map((/** @type {any} */ index) => ({ name: index.name, members: index.expression === undefined ? index.columns : [null],
        partial: index.where !== undefined }))] };
}

/** Replace each `$exists-row` with a read of its answer, collecting the probes.
 * @param {any} node @param {any[]} probes @param {(why: string) => never} fail @returns {any} */
function withProbes(node, probes, fail) {
  if (Array.isArray(node)) return node.map((item) => withProbes(item, probes, fail));
  if (!node || typeof node !== 'object' || Object.hasOwn(node, '$const')) return node;
  if (Object.hasOwn(node, '$exists-row')) {
    const probe = node['$exists-row'];
    if (Object.keys(node).length !== 1 || !isJsonObject(probe)
      || Object.keys(probe).some((key) => !['entity', 'match'].includes(key)) || typeof probe.entity !== 'string'
      || !isJsonObject(probe.match) || Object.keys(probe.match).length === 0)
      fail('$exists-row is { entity, match: { <member>: <value>, … } }');
    probes.push({ entity: probe.entity, match: probe.match });
    return { $eq: [`$.probes[${probes.length - 1}]`, true] };
  }
  return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, withProbes(value, probes, fail)]));
}

/** Whether every leaf of an arithmetic node is a record path or an integer
 * literal, through nested arithmetic. @param {any[]} operands @returns {boolean} */
function plainArithmetic(operands) {
  return operands.every((operand) => (typeof operand === 'string' ? recordPath(operand) !== null
    : typeof operand === 'number' ? Number.isInteger(operand)
      : isArithmetic(operand) ? plainArithmetic([Object.values(operand)[0]].flat())
        : isJsonObject(operand) && Object.keys(operand).length === 1
          && typeof operand.$const === 'number' && Number.isInteger(operand.$const)));
}

/**
 * The arithmetic an assertion computes, outside `$const`, each node with its
 * evaluator, its operands' readers over the record, the members its record
 * paths read and whether every leaf is a record path or an integer literal:
 * the model check keeps the nodes over integer members alone for the domain
 * store enforcement holds (`withinDomain`).
 * @param {any} node @param {{ evaluate: Function, operands: Function[], reads: (string | undefined)[], plain: boolean }[]} [out]
 */
function arithmeticOf(node, out = []) {
  if (Array.isArray(node)) for (const item of node) arithmeticOf(item, out);
  else if (node && typeof node === 'object' && !Object.hasOwn(node, '$const')) {
    if (isArithmetic(node)) {
      const [key, args] = Object.entries(node)[0];
      const operands = key === '$neg' ? [args] : args;
      out.push({ evaluate: compileJsonQuery(node), operands: operands.map((operand) => compileJsonQuery(operand)),
        reads: pathsOf(node).map((path) => recordPath(path)?.name), plain: plainArithmetic(operands) });
    }
    for (const value of Object.values(node)) arithmeticOf(value, out);
  }
  return out;
}

/** @param {number} value */
const inSafeRange = (value) => value >= -SAFE_INTEGER && value <= SAFE_INTEGER;

/**
 * The safe-integer domain of a rule's arithmetic, as the trigger holds it: a
 * sum, difference or negation whose operands are integers refuses the write
 * when one of them, or its result, is outside ±(2^53 − 1), where the engine's
 * doubles would round; an operand that is missing or no integer leaves the
 * node to the engine's own answer, and so does one the node cannot read on
 * its own — a variable the assertion's own `$let` or `$for` binds, a nested
 * arithmetic over no number — which only the whole assertion evaluates.
 * @param {any} rule - normalized @param {any} record `{ old, new, op }` @returns {boolean}
 */
function withinDomain(rule, record) {
  /** @param {Function} evaluate */
  const read = (evaluate) => { try { return evaluate(record); } catch { return undefined; } };
  for (const node of rule.arithmetic) {
    const operands = node.operands.map(read);
    if (!operands.every((value) => typeof value === 'number' && Number.isInteger(value))) continue;
    const result = read(node.evaluate);
    if (!operands.every(inSafeRange) || typeof result !== 'number' || !inSafeRange(result)) return false;
  }
  return true;
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
    if (!isJsonObject(rule)) fail('an invariant must be an object');
    refuseUnknownModelMembers(rule, MEMBERS, at, 'invariant');
    if (typeof rule.name !== 'string' || !IDENTIFIER.test(rule.name) || names.has(rule.name)) fail('invariant names must be distinct identifiers', 'name');
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
      || rule.effects.length === 0 || rule.effects.some((e) => !isJsonObject(e)
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
    return { ...rule, probes, evaluate, arithmetic: arithmeticOf(expression) };
  });
}

/** The record paths a value reads, outside `$const`.
 * @param {any} node @param {string[]} [out] @returns {string[]} */
function pathsOf(node, out = []) {
  if (typeof node === 'string' && (node.startsWith('$.') || node.startsWith('$['))) out.push(node);
  else if (Array.isArray(node)) for (const item of node) pathsOf(item, out);
  else if (node && typeof node === 'object' && !Object.hasOwn(node, '$const'))
    for (const value of Object.values(node)) pathsOf(value, out);
  return out;
}

/**
 * What a database rule on a store-owned layout cannot lower, refused at the
 * member: an audit row or an increment (a trigger's writes are invisible to
 * journal capture, which such an entity may run), a probe of another row, and
 * a read of a member that has no column to compare — an epoch member, whose
 * column holds milliseconds while the rule compares the member's text, a
 * member the document holds, a relation. Its `columns` keep their own refusal.
 * @param {any} entity - normalized @param {any} rule - normalized
 * @param {(property: any) => string} storageOf @param {(reason: string, member: string) => never} fail
 */
function refuseStoreOwnedRule(entity, rule, storageOf, fail) {
  const capture = 'a trigger\'s writes are invisible to journal capture';
  if (rule.audit !== undefined) fail(`database invariant: a database rule on a store-owned layout writes no audit row: ${capture}`, 'audit');
  if (rule.effects !== undefined) fail(`database invariant: a database rule on a store-owned layout increments no member: ${capture}`, 'effects');
  if (rule.probes.length > 0)
    fail('database invariant: a database rule on a store-owned layout reads no other row: $exists-row lowers from an explicit column layout', 'assert');
  for (const path of pathsOf(rule.assert)) {
    const name = recordPath(path)?.name;
    const property = name === undefined ? undefined : entity.properties.get(name);
    const storage = property === undefined ? 'column' : storageOf(property);
    if (storage === 'epoch') fail(`database invariant: '${name}' holds an epoch (milliseconds) in its column, while a rule compares the member's text — `
      + 'a database rule on a store-owned layout reads no epoch member', 'assert');
    if (storage === 'document') fail(`database invariant: '${name}' lives in the entity's document: a database rule on a store-owned layout reads `
      + 'column-mapped members — map it as a column (a top-level scalar property)', 'assert');
    if (storage === 'relation') fail(`database invariant: '${name}' is a relation, which has no column of its own — a database rule on a store-owned `
      + 'layout reads column-mapped members and foreign-key columns', 'assert');
  }
}

/**
 * The members a probe compares with `=`, which is what proves it reads at most
 * one row: the target's key when the match covers it, else every column of a
 * unique index of the target that its open verifies — one over plain column
 * terms, without a condition. A partial unique index, or one with an
 * expression term, proves nothing by the matched members alone and never keys
 * a probe; the refusal names it.
 * @param {string[]} keys - the target's key members
 * @param {{ name: string, members: (string | null)[], partial: boolean }[]} uniques - the target's unique indexes,
 *   each plain column term as the member it maps and any other term `null`
 * @param {string[]} matched - the members the probe matches @param {string} entity - the target's name
 * @param {(reason: string) => never} refuse
 * @returns {string[]}
 */
export function probeKeys(keys, uniques, matched, entity, refuse) {
  const missing = keys.find((key) => !matched.includes(key));
  if (missing === undefined) return keys;
  const covered = uniques.filter((index) => index.members.every((member) => member === null || matched.includes(member)));
  const keyed = covered.find((index) => !index.partial && !index.members.includes(null));
  if (keyed !== undefined) return /** @type {string[]} */ (keyed.members);
  if (covered.length > 0) {
    const index = covered[0];
    refuse(`$exists-row on '${entity}' is keyed by the unique index '${index.name}', which ${index.partial
      ? 'declares a condition: a partial unique index never keys a probe'
      : 'has an expression term (or a column the layout does not map): a probe is keyed by plain column terms'}`);
  }
  return refuse(`$exists-row on '${entity}' must match its key member '${missing}', or every column of a unique index its open verifies `
    + '(one over plain column terms, without a condition)');
}

/**
 * The unique indexes of a probe's target, for `probeKeys`: a physical
 * layout's declared ones, or a store-owned layout's unique members and
 * entity indexes, each verified by the open as the key is.
 * @param {any} entity - normalized @returns {{ name: string, members: (string | null)[], partial: boolean }[]}
 */
function uniqueIndexesOf(entity) {
  if (entity.physical !== null) return entity.physical.declaredIndexes.filter((/** @type {any} */ index) => index.unique);
  return [...[...entity.properties.values()].filter((property) => property.unique && !property.key)
    .map((property) => ({ name: property.name, members: [property.name], partial: false })),
  ...entity.indexes.filter((/** @type {any} */ index) => index.unique)
    .map((/** @type {any} */ index) => ({ name: index.name, members: index.expression === undefined ? index.paths : [null],
      partial: index.where !== undefined }))];
}

/**
 * The columns a store-owned layout gives a probe to match: each column-mapped
 * scalar member as the table holds it (a key never SQL NULL, any other column's
 * SQL NULL a missing member), by the member's own name; what the document
 * holds, an epoch column and a relation are no columns to match.
 * @param {any} entity - normalized @param {(property: any) => string} storageOf
 */
function storeOwnedColumns(entity, storageOf) {
  return [...entity.properties.values()].filter((property) => storageOf(property) === 'column')
    .map((property) => ({ name: property.name, physical: property.name, codec: STORE_OWNED_CODECS[/** @type {keyof typeof STORE_OWNED_CODECS} */ (property.type)],
      null: property.key ? 'reject' : 'absent' }));
}

/**
 * Resolve what a rule names in other members and entities, once the whole
 * model is known: `columns` and increments name physical columns of their own
 * entity, a probe's target is another table — a physical layout, or the
 * layout the store owns — its match keyed by the target's key or a verified
 * unique index, and each match value is a member the rule's own entity has,
 * of the target column's codec, or a literal that codec holds; a database
 * rule on a store-owned layout reads members its table has a column for.
 * Both enforcements read the result.
 * @param {Map<string, any>} entities
 * @param {(column: any) => { encode: (value: any) => any }} codecOf the column codec
 * @param {(property: any) => string} storageOf where a store-owned layout keeps a property:
 *   `column`, `epoch`, `document` or `relation`
 */
export function resolveInvariants(entities, codecOf, storageOf) {
  for (const entity of entities.values()) {
    const layout = entity.physical;
    const columnOf = (member) => layout?.columns.find((c) => c.name === member);
    const increments = new Set();
    for (const [index, rule] of entity.invariants.entries()) {
      /** A refusal at one member of this rule. @param {string} reason @param {string} member @returns {never} */
      const fail = (reason, member) => {
        throw new DbCompileError('JD0005', reason, `${entity.docPath}/invariants/${index}/${member}`);
      };
      // a view takes no writes: refused at the member, as `planInvariants`
      // refuses it; so is an audit into a table no entity maps for writing
      if (layout?.kind === 'view' && rule.enforcement === 'database')
        fail('database invariant: database rules require a writable explicit column layout', 'enforcement');
      if (layout === null && rule.enforcement === 'database') refuseStoreOwnedRule(entity, rule, storageOf, fail);
      // the safe-integer domain store enforcement holds (`withinDomain`): the
      // arithmetic over integer members alone, as the trigger lowers it — a
      // number member keeps the engine's own answer
      const integer = (/** @type {string} */ name) => (layout !== null ? columnOf(name)?.codec === 'integer'
        : entity.properties.get(name)?.type === 'integer' && storageOf(entity.properties.get(name)) === 'column');
      rule.arithmetic = rule.arithmetic.filter((/** @type {any} */ node) => node.plain
        && node.reads.every((/** @type {string | undefined} */ name) => name !== undefined && integer(name)));
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
        if (!target) refuse(`$exists-row reads an entity of the model; '${probe.entity}' is none`);
        if (target.physical?.kind === 'view') refuse(`$exists-row reads a table by its primary key; '${probe.entity}' is a view, which has none`);
        const table = target.physical ?? { table: target.name };
        // two entities can map one table: the table decides, not the entity
        if (sameTable(table, layout ?? { table: entity.name }))
          refuse("$exists-row reads another table: PostgreSQL's row triggers run at statement end, SQLite's per row");
        const columns = target.physical !== null ? target.physical.columns : storeOwnedColumns(target, storageOf);
        // what each matched member is, before what keys the probe
        for (const member of Object.keys(probe.match)) {
          const column = columns.find((c) => c.name === member);
          if (target.physical === null) {
            const property = target.properties.get(member);
            const storage = property === undefined ? 'column' : storageOf(property);
            if (storage === 'epoch') refuse(`$exists-row member '${member}' holds an epoch (milliseconds) in its column, while a probe compares the member's text: a probe matches column-mapped members`);
            if (storage === 'document') refuse(`$exists-row member '${member}' lives in the entity's document: a probe matches column-mapped members — map it as a column (a top-level scalar property)`);
            if (column?.codec === 'boolean') refuse(`$exists-row member '${member}' is a boolean, which a layout the store owns keeps as 0 or 1: a probe matches no boolean member of one`);
          }
          if (!column || !RULE_CODECS.includes(column.codec)) refuse(`$exists-row member '${member}' needs a scalar column codec`);
        }
        const keys = probeKeys(target.keys, uniqueIndexesOf(target), Object.keys(probe.match), probe.entity, refuse);
        for (const [member, value] of Object.entries(probe.match)) {
          const column = /** @type {any} */ (columns.find((c) => c.name === member));
          // a member the probe is keyed by compares with `=`, which SQL NULL never meets, so a column
          // whose SQL NULL is a missing member serves there; any other member compares null-safely
          if (column.null === 'absent' && !keys.includes(member)) refuse(`$exists-row member '${member}' needs a scalar column codec`);
          if (column.null === 'absent' && ruleLiteral(value) === null)
            refuse(`'${member}' reads SQL NULL as an absent member, so it never holds null: a probe matches it with a value`);
          // a keyed member compares with `=`, which no null meets: a key holds none, a unique index admits any number
          if (keys.includes(member) && ruleLiteral(value) === null)
            refuse(`$exists-row member '${member}' is one the probe is keyed by, which matches a value, never null: a key holds no null and a unique index admits any number of them`);
          const escaped = typeof value === 'string' && value.startsWith('$') && !value.startsWith('$$');
          const path = escaped ? recordPath(value) : null;
          if (escaped && path === null) refuse(`$exists-row value '${value}' must read $.old.<member> or $.new.<member> (any name also $.new['<member>']); a text that starts with $ is written $$`);
          if (path !== null) {
            const name = path.name;
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
        probe.target = target.physical ?? { table: target.name, columns };
        probe.keys = keys;
      }
    }
    if (increments.size > 0) for (const [index, rule] of entity.invariants.entries()) {
      if (!rule.on.includes('update')) continue;
      const at = `${entity.docPath}/invariants/${index}`;
      for (const member of increments) {
        /** @param {any} node */
        const readsNew = (node) => pathsOf(node).some((path) => recordPath(path)?.record === 'new' && recordPath(path)?.name === member);
        const readIn = readsNew(rule.assert) ? 'assert' : readsNew(rule.audit?.values ?? {}) ? 'audit' : null;
        if (readIn !== null)
          throw new DbCompileError('JD0005', `'${member}' is incremented by the database: an update rule cannot read $.new.${member}`, `${at}/${readIn}`);
        if (rule.columns?.includes(member))
          throw new DbCompileError('JD0005', `'${member}' is incremented by the database and cannot be a rule column`, `${at}/columns`);
      }
    }
  }
}

/** @param {string} name @returns {DbRuntimeError} */
function invariantFailure(name) {
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
        if (!withinDomain(rule, record) || rule.evaluate(record) !== true) throw invariantFailure(rule.name);
        continue;
      }
      if (typeof context.probe !== 'function') throw new DbRuntimeError('JD2096', `persistence invariant '${rule.name}' needs a probe of '${rule.probes[0].entity}'`);
      const probe = context.probe;
      const run = () => {
        const answers = [];
        const answer = (j) => j >= rule.probes.length ? null
          : chain(probe(rule.probes[j], record), (found) => { answers.push(found === true); return answer(j + 1); });
        return chain(answer(0), () => {
          if (!withinDomain(rule, record) || rule.evaluate({ ...record, probes: answers }) !== true) throw invariantFailure(rule.name);
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
 * The one existence probe: a row of the target whose keyed members — its key,
 * or the columns of the unique index that keys the probe — equal their values
 * (`=`, an indexed read) and whose other members match null-safely, so a
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
