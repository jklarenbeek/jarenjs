//@ts-check
/**
 * @file `@jarenjs/db/trigger-rules`: application triggers read back as the
 * declared database rules they are exactly equal to (MODEL-FORMAT §13.6),
 * opted into by passing the reader to introspection —
 * `store.introspect({ triggers: sqliteTriggers })` or
 * `introspectModel(connection, { triggers: sqliteTriggers })`. Without it,
 * introspection reports every application trigger as an `unmapped-object`
 * row and derives no layout for it, so a store that never reads triggers
 * back carries none of this module.
 */
import { DbCompileError } from './errors.js';
import { DOC_COLUMN, SCALAR_CODECS, MANAGED_SQL_OPTIONS, planInvariants } from './ddl.js';
import { sqlTokens } from './dialects/check-read.js';
import { sqliteTriggerRule, triggerTableFacts, triggerEventOf, storeRuleProgram } from './dialects/sqlite-trigger-rules.js';
import { foldIdentifier } from './invariants.js';
import { MODEL_VERSION, IDENTIFIER } from './engine-metadata.js';
import { loss, reportLossyType } from './introspect.js';
import { setObjectMember } from '@jarenjs/core/object';
import { canonicalizeJson } from '@jarenjs/json/canonical';
import { comparableDeclaredSql } from './schema-sql.js';

/**
 * The column layout an entity table is read back as when its triggers
 * declare rules (§12): every column mapped under its own name, a nullable one
 * as `null` (a JSON null) and the rest `reject`, a column with a default the
 * database's, the key in its declared order, and each unique or plain index
 * over plain columns without a condition, which keys a rule's probe (§13.2).
 * The table's other facts are report rows: its types that hold two schema
 * types, its CHECKs, its other indexes and its foreign keys, which a layout
 * declares no relation for. A reason where the table is no such table.
 * @param {any} dialect @param {any} table @param {Set<string>} joinTables
 * @returns {{ entity: any, rows: any[] } | string}
 */
function columnLayoutOf(dialect, table, joinTables) {
  if (joinTables.has(table.name)) return 'it is a join table';
  if (!IDENTIFIER.test(table.name)) return 'its name is not an identifier';
  const identity = dialect.identityColumn?.name;
  if (table.columns.some((/** @type {any} */ column) => column.name === DOC_COLUMN || column.name === identity))
    return 'it holds a document, laid out as the store owns it, whose rules the store creates with the table';
  const keys = table.primaryKey ?? [];
  if (keys.length === 0) return 'it has no primary key';
  const rows = [];
  /** @type {Record<string, any>} */
  const properties = {};
  /** @type {Record<string, any>} */
  const columns = {};
  const rowid = keys.length === 1 && String(table.columns.find((/** @type {any} */ c) => c.name === keys[0])?.type).toUpperCase() === 'INTEGER';
  for (const column of table.columns) {
    if (column.generated) return `its column '${column.name}' is generated`;
    const type = dialect.schemaTypeOf(column.type);
    const codec = SCALAR_CODECS.get(type);
    if (codec === undefined) return `its column '${column.name}' has the type '${column.type}', which no column codec reads back`;
    const key = keys.includes(column.name);
    if (key && column.nullable && !rowid) return `its key column '${column.name}' admits SQL NULL`;
    const nullable = column.nullable && !key;
    setObjectMember(properties, column.name, { type: nullable ? [type, 'null'] : type, ...(key ? { 'x-entity': { key: true } } : {}) });
    setObjectMember(columns, column.name, { name: column.name, codec, null: nullable ? 'null' : 'reject',
      ...(column.default === null ? {} : { default: 'database' }) });
    reportLossyType(dialect, table, column, (/** @type {any} */ row) => rows.push(row));
  }
  const indexes = [];
  for (const index of table.indexes) {
    if (index.partial || !index.plain || index.columns.some((/** @type {any} */ name) => name === null || !Object.hasOwn(columns, name))
      || sqlTokens(String(index.sql ?? '')).some((token) => token.kind === 'word' && token.value.toUpperCase() === 'COLLATE')) {
      rows.push(loss('unmapped-index', `${table.name}.${index.name}`, 'a column layout declares an index over plain columns '
        + 'without a condition or a collation of its own; this one stays a physical fact the layout does not declare'));
      continue;
    }
    indexes.push({ name: index.name, ...(index.unique ? { unique: true } : {}),
      terms: index.columns.map((/** @type {string} */ name) => ({ by: { $sql: 'column', name } })) });
  }
  for (const check of table.checks) {
    rows.push(loss('unmapped-constraint', `${table.name}.${check.name}`, 'a CHECK of a table read back as a column layout '
      + 'stays a physical fact the layout does not declare'));
  }
  for (const fk of table.foreignKeys) {
    if (fk.ordinal !== 0) continue;
    rows.push(loss('unmapped-constraint', `${table.name}.${fk.column}`, `the foreign key to '${fk.target}' is not declared: `
      + 'a column layout declares no relation'));
  }
  const physical = { table: table.name, columns, ...(keys.length > 1 ? { keys: [...keys] } : {}), ...(indexes.length > 0 ? { indexes } : {}) };
  return { entity: { schema: { type: 'object', properties, required: [...keys].sort() }, physical }, rows };
}

/**
 * The application triggers a dialect reads back as declared database rules
 * (§13.6), each on the column layout of its table, with the tables its
 * probes read laid out too. Another engine's triggers are not read back. Each
 * trigger the reader maps is lowered with the rules its table already took,
 * in the order of their names, and one the lowering refuses keeps that
 * reason; every other trigger keeps the reader's. A trigger named as the
 * store names a rule's program is the store's, and never a rule of that name.
 * @param {any} dialect @param {any} schema @param {Set<string>} joinTables
 * @returns {ReturnType<typeof answer>}
 */
function readTriggerRules(dialect, schema, joinTables) {
  const triggers = schema.objects.filter((/** @type {any} */ object) => object.type === 'trigger')
    .sort((/** @type {any} */ a, /** @type {any} */ b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  /** @type {Map<string, string>} */
  const reasons = new Map();
  /** @type {Map<string, any>} */
  const mapped = new Map();
  if (dialect.name !== 'sqlite') {
    for (const trigger of triggers) reasons.set(trigger.name, 'the reader reads SQLite trigger programs, and this engine\'s are not read back');
    return answer(mapped, reasons, new Map());
  }
  const byFold = new Map(schema.tables.map((/** @type {any} */ table) => [foldIdentifier(table.name), table]));
  /** @type {Map<string, any>} */
  const facts = new Map();
  const factsOf = (/** @type {string} */ name) => {
    const table = byFold.get(foldIdentifier(name));
    if (table === undefined) return undefined;
    if (!facts.has(table.name)) facts.set(table.name, triggerTableFacts(table));
    return facts.get(table.name);
  };
  /** @type {Map<string, any>} */
  const layouts = new Map();
  const layoutOf = (/** @type {string} */ name) => {
    if (!layouts.has(name)) layouts.set(name, columnLayoutOf(dialect, schema.tables.find((/** @type {any} */ t) => t.name === name), joinTables));
    return layouts.get(name);
  };
  // the event each trigger fires on, on the table the catalog names; one the reader cannot read fires on every UPDATE
  const siblings = triggers.map((/** @type {any} */ trigger) => ({ name: trigger.name, op: 'update', of: null,
    ...triggerEventOf(String(trigger.sql)), table: foldIdentifier(String(trigger.owner)) }));
  /** The rules each table took, in the order they were taken. @type {Map<string, { rule: any, targets: string[] }[]>} */
  const taken = new Map();
  for (const trigger of triggers) {
    if (trigger.name.startsWith('_jaren_')) {
      reasons.set(trigger.name, 'the store names a declared rule\'s program so; the model that declares the rule opens the table');
      continue;
    }
    if (!IDENTIFIER.test(trigger.name)) { reasons.set(trigger.name, 'its name is not an identifier, the only kind a rule takes'); continue; }
    const read = sqliteTriggerRule(trigger, factsOf, siblings);
    if ('reason' in read) { reasons.set(trigger.name, read.reason); continue; }
    const tables = [read.owner, ...read.targets];
    const refused = tables.map((name) => [name, layoutOf(name)]).find(([, layout]) => typeof layout === 'string');
    if (refused !== undefined) {
      reasons.set(trigger.name, `the table '${refused[0]}' is not read back as a column layout: ${refused[1]}`);
      continue;
    }
    const own = [...(taken.get(read.owner) ?? []), { rule: read.rule, targets: read.targets }];
    /** @type {Record<string, any>} */
    const entities = {};
    for (const name of new Set([read.owner, ...own.flatMap((entry) => entry.targets)])) setObjectMember(entities, name, layoutOf(name).entity);
    setObjectMember(entities, read.owner, { ...layoutOf(read.owner).entity, invariants: own.map((entry) => entry.rule) });
    try { planInvariants({ $model: MODEL_VERSION, entities }, { dialect }); }
    catch (error) {
      if (!(error instanceof DbCompileError)) throw error;
      reasons.set(trigger.name, `the rule lowering refuses it: ${/** @type {any} */ (error).reason ?? error.message}`);
      continue;
    }
    taken.set(read.owner, own);
    const name = read.rule.name;
    mapped.set(trigger.name, {
      ...loss('trigger-rule', trigger.name, `read back as the database rule '${name}' of the entity '${read.owner}'; `
        + (read.message === null ? 'its effect is the rule\'s increment' : `its refusal is 'jaren invariant:${name}' (JD2096) where the trigger raised '${read.message}'`)
        + (read.timing === 'before' && read.rule.on[0] !== 'delete'
          ? '; the trigger judges a row before conflict resolution and the rule\'s program after it, so a row a conflict clause '
            + 'skips (OR IGNORE, ON CONFLICT DO NOTHING) or turns into an update (ON CONFLICT DO UPDATE), which the trigger refused, '
            + 'meets no such rule' : '')
        + '; the database holds the trigger, not the rule\'s program: a reviewed migration installs the program and drops the '
        + 'trigger, which inspection never does'),
      entity: read.owner, rule: name, message: read.message, timing: read.timing,
    });
  }
  /** @type {Map<string, any>} */
  const used = new Map();
  for (const [table, entries] of taken) {
    for (const name of [table, ...entries.flatMap((entry) => entry.targets)]) if (!used.has(name)) used.set(name, layoutOf(name));
  }
  for (const [table, entries] of taken) used.set(table, { ...used.get(table), entity: { ...used.get(table).entity, invariants: entries.map((entry) => entry.rule) } });
  return answer(mapped, reasons, used);
}

/**
 * What introspection asks the reader as it derives the model: each
 * trigger's report row, the layout a table is read back as, and whether a
 * foreign key or a join table may declare a relation — none may touch a
 * column layout, which declares no relation (§12).
 * @param {Map<string, any>} mapped @param {Map<string, string>} reasons @param {Map<string, any>} layouts
 */
function answer(mapped, reasons, layouts) {
  return {
    layouts,
    /** The row of one trigger: read back, or unmapped with its reason. @param {any} row */
    rowOf(row) {
      const read = mapped.get(row.object);
      if (read !== undefined) return { ...read, sql: row.sql, owner: row.owner };
      const reason = reasons.get(row.object);
      return reason === undefined ? row : { ...row, detail: `${row.detail}; it is not read back as a database rule: ${reason}`, reason };
    },
    /** @param {{ child: string, column: string, fk: any }} edge @param {(row: any) => void} add */
    keepsEdge({ child, column, fk }, add) {
      if (!layouts.has(fk.target)) return true;
      add(loss('unmapped-constraint', `${child}.${column}`, `the foreign key to '${fk.target}' is not declared: `
        + 'it references a column layout, which declares no relation'));
      return false;
    },
    storeRules,
    /** @param {string} table @param {string} left @param {string} right @param {(row: any) => void} add */
    keepsJoin(table, left, right, add) {
      if (!layouts.has(left) && !layouts.has(right)) return true;
      add(loss('unmapped-table', table, `the join table joins the column layout '${layouts.has(left) ? left : right}', which declares no relation`));
      return false;
    },
  };
}

const OPS = ['insert', 'update', 'delete'];

/**
 * The database rules a table the store owns holds as its own programs
 * (`_jaren_rule_<length>_<table>_<op>`), read back on SQLite: each program's
 * checks read as candidate rules (`storeRuleProgram`), and the candidates kept
 * only where `planInvariants` over the derived model with them plans exactly
 * the programs the table holds — every one of them, compared formatting
 * aside as the open compares them. A table is read whole or not at all (one
 * rule spans a program per operation, and a program holds every rule of its
 * operation); one that is not keeps its programs `unmapped-object` rows, with
 * the reason. A program on any other table, and another engine's, is not
 * read back.
 * @param {any} dialect @param {any} schema
 * @param {Record<string, any>} entities - the entities derived so far, by table
 * @returns {Map<string, { invariants: any[], programs: string[] } | { reason: string, programs: string[] }>}
 */
function storeRules(dialect, schema, entities) {
  /** @type {Map<string, any[]>} */
  const byTable = new Map();
  for (const object of schema.objects) {
    if (object.type !== 'trigger' || !String(object.name).startsWith('_jaren_rule_')) continue;
    byTable.set(object.owner, [...(byTable.get(object.owner) ?? []), object]);
  }
  /** @type {Map<string, any>} */
  const out = new Map();
  if (dialect.name !== 'sqlite') return out;
  /** The codec of a derived entity's member, by its column. @param {string} table @param {string} physical */
  const codecOf = (table, physical) => {
    const node = Object.hasOwn(entities, table) ? entities[table].schema?.properties?.[physical] : undefined;
    const types = node === undefined ? [] : Array.isArray(node.type) ? node.type.filter((/** @type {string} */ type) => type !== 'null') : [node.type];
    return types.length === 1 && node['x-entity']?.relation === undefined ? SCALAR_CODECS.get(types[0]) ?? null : null;
  };
  for (const [table, programs] of byTable) {
    const names = programs.map((program) => program.name);
    const refuse = (/** @type {string} */ reason) => out.set(table, { reason, programs: names });
    const entity = Object.hasOwn(entities, table) ? entities[table] : undefined;
    // a program on a table not laid out as the store owns it (a document column beside the mapped
    // ones) keeps the reason the reader gave it: a physical layout's programs are its own
    const held = schema.tables.find((/** @type {any} */ candidate) => candidate.name === table);
    if (entity === undefined || entity.physical !== undefined
      || !held?.columns.some((/** @type {any} */ column) => column.name === DOC_COLUMN)) continue;
    /** Each rule's operations, assertion, and update guard, in the order the programs list them. @type {Map<string, any>} */
    const rules = new Map();
    /** @type {string[]} */
    let order = [];
    let reason = null;
    for (const program of [...programs].sort((a, b) => OPS.indexOf(storeOp(a.name, table)) - OPS.indexOf(storeOp(b.name, table)))) {
      const read = storeRuleProgram(String(program.sql),
        (record, physical) => { const codec = codecOf(table, physical); return codec === null || !IDENTIFIER.test(physical) ? null : { path: `$.${record}.${physical}`, codec }; },
        (target, physical) => (codecOf(target, physical) === null ? null : physical));
      if ('reason' in read) { reason = `'${program.name}': ${read.reason}`; break; }
      let previous = -1;
      const listed = read.checks.map((check) => check.rule);
      for (const check of read.checks) {
        const known = rules.get(check.rule);
        const rule = known ?? { on: new Set(), assert: check.assert, columns: [], guarded: undefined };
        if (canonicalizeJson(rule.assert) !== canonicalizeJson(check.assert) || rule.on.has(read.op)) { reason = `the rule '${check.rule}' reads two ways`; break; }
        rule.on.add(read.op);
        if (read.op === 'update') { rule.columns = read.columns; rule.guarded = check.guarded; }
        rules.set(check.rule, rule);
        // the declaration order, merged from each program's: an unseen rule after the last one this program
        // lists before it, else before the first one it lists after it, else last — the order of two rules no
        // program shares is not recorded, and plans the same programs either way
        if (!order.includes(check.rule)) {
          const next = previous >= 0 ? -1 : listed.slice(listed.indexOf(check.rule) + 1).map((rule) => order.indexOf(rule)).find((at) => at >= 0) ?? -1;
          const at = previous >= 0 ? previous + 1 : next >= 0 ? next : order.length;
          order = [...order.slice(0, at), check.rule, ...order.slice(at)];
        }
        previous = order.indexOf(check.rule);
      }
      if (reason !== null) break;
    }
    if (reason !== null) { refuse(reason); continue; }
    const invariants = order.map((name) => {
      const rule = rules.get(name);
      return { name, on: OPS.filter((op) => rule.on.has(op)),
        ...(rule.on.has('update') && rule.columns.length > 0 ? { columns: rule.columns } : rule.on.has('update') && !rule.guarded ? { when: 'assigned' } : {}),
        enforcement: 'database', assert: rule.assert };
    });
    /** @type {Record<string, any>} */
    const model = {};
    for (const [name, other] of Object.entries(entities)) {
      const { invariants: _ignored, ...rest } = other;
      setObjectMember(model, name, name === table ? { ...rest, invariants } : rest);
    }
    /** @type {any[]} */
    let planned;
    try { planned = planInvariants({ $model: MODEL_VERSION, entities: model }, { dialect }).filter((item) => item.owner === table); }
    catch (error) {
      if (!(error instanceof DbCompileError)) throw error;
      refuse(`the rules its programs read as are refused: ${/** @type {any} */ (error).reason ?? error.message}`);
      continue;
    }
    const comparable = (/** @type {string} */ sql) => comparableDeclaredSql(sql, MANAGED_SQL_OPTIONS);
    const same = planned.length === programs.length && planned.every((item) => {
      const held = programs.find((program) => program.name === item.name);
      try { return held !== undefined && comparable(String(held.sql)) === comparable(item.sql); }
      catch { return false; }
    });
    if (!same) { refuse('its programs are not the text the rules they read as plan (a hand edit, or a rule the reader reads otherwise)'); continue; }
    out.set(table, { invariants, programs: names });
  }
  return out;
}

/** The operation a store program's name ends in, after its table. @param {string} name @param {string} table */
const storeOp = (name, table) => name.slice(`_jaren_rule_${table.length}_${table}_`.length).replace(/_of_.*$/, '');

/**
 * The SQLite trigger reader. Pass it as introspection's `triggers` option:
 * each application trigger whose CREATE text is one of the families the rule
 * lowering expresses exactly is read back as that rule, a `trigger-rule` row
 * naming what the rule does not carry, and every other one keeps its
 * `unmapped-object` row with the `reason` it is not read back. A table laid
 * out as the store owns it reads its own rule programs back as the rules
 * that plan them (`storeRules`).
 * @type {Readonly<{ read: (dialect: any, schema: any, joinTables: Set<string>) => ReturnType<typeof answer> }>}
 */
export const sqliteTriggers = Object.freeze({ read: readTriggerRules });
