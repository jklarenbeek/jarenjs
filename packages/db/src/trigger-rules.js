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
import { DOC_COLUMN, SCALAR_CODECS, planInvariants } from './ddl.js';
import { sqlTokens } from './dialects/check-read.js';
import { sqliteTriggerRule, triggerTableFacts, triggerEventOf } from './dialects/sqlite-trigger-rules.js';
import { foldIdentifier } from './invariants.js';
import { MODEL_VERSION, IDENTIFIER } from './engine-metadata.js';
import { loss, reportLossyType } from './introspect.js';
import { setObjectMember } from '@jarenjs/core/object';

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
    /** @param {string} table @param {string} left @param {string} right @param {(row: any) => void} add */
    keepsJoin(table, left, right, add) {
      if (!layouts.has(left) && !layouts.has(right)) return true;
      add(loss('unmapped-table', table, `the join table joins the column layout '${layouts.has(left) ? left : right}', which declares no relation`));
      return false;
    },
  };
}

/**
 * The SQLite trigger reader. Pass it as introspection's `triggers` option:
 * each application trigger whose CREATE text is one of the families the rule
 * lowering expresses exactly is read back as that rule, a `trigger-rule` row
 * naming what the rule does not carry, and every other one keeps its
 * `unmapped-object` row with the `reason` it is not read back.
 * @type {Readonly<{ read: (dialect: any, schema: any, joinTables: Set<string>) => ReturnType<typeof answer> }>}
 */
export const sqliteTriggers = Object.freeze({ read: readTriggerRules });
