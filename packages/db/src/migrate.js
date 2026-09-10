//@ts-check
/**
 * @file Document migrations (D12): two model documents diff into a
 * migration document whose steps are rendered DDL, JSLT data
 * transforms and query assertions; the migration replays on a shadow
 * database first; a history table records what ran with a
 * signature-grade checksum. This is the phase-A payoff for storing
 * documents rather than rows: a shape change is a transformation of
 * VALUES, not a table rebuild.
 *
 * Identity is a hash, not a version number: `from`/`to` are
 * `hashContent(canonicalizeJson(model))` — the identity of a SHAPE,
 * which nobody has to remember to bump. The checksum discipline is
 * D12's: `canonicalizeJson` + `hashContent` (signature-grade — throws
 * on the unserializable), never the memo-grade `contentKey`.
 *
 * Like the query emitter, this module is part of the emitter layer:
 * the structural SQL it composes (the history table's statements, the
 * batched row walk) is built from dialect primitives, and every
 * planner-produced statement is rendered by the dialect into the
 * migration DOCUMENT — shown before it is ever executed.
 */

import { canonicalizeJson } from '@jarenjs/json/canonical';
import { hashContent } from '@jarenjs/core/string';
import { resolveRuntime } from '@jarenjs/core/runtime';
import { refuseCancelled } from './cancellation.js';
import { setObjectMember } from '@jarenjs/core/object';
import { compileJsonQuery } from '@jarenjs/json/query';
import { compileJsltStylesheet } from '@jarenjs/json/jslt';

import { DbCompileError } from './errors.js';
import { chain, toPromise } from './driver.js';
import { normalizeModel } from './store.js';
import { planQuery } from './plan.js';
import { createQueryEngine, createQueryState } from './query.js';
import { CHANGES_TABLE, CHANGES_STATE_TABLE } from './capture.js';
import { JOBS_TABLE, JOB_CHECKPOINTS_TABLE } from './jobs.js';
import { REPLICATION_TABLES } from './replication-tables.js';
import { planCollection, verifyShape, planEntity, planJoinTable } from './ddl.js';
import { normalizeEntities, explainMapping } from './model.js';
import { derivedValue, memberAt, registerDeriveFunctions } from './derive.js';
import { mergeEntityRow } from './graph.js';
import { entityCore } from './entity.js';
import { sqlTokens } from './dialects/check-read.js';
import { readSchema } from './introspect.js';
import { verifyPhysical, physicalSelection } from './physical.js';
import {
  MIGRATION_VERSION, isPerDocumentAssertion, compileDocumentStep, checkMigrationDocument,
  normalizeAssertionBounds, ASSERTION_BOUNDS_DEFAULT, createAssertionBoundGuard,
} from './document-steps.js';

export { MIGRATION_VERSION, isPerDocumentAssertion, ASSERTION_BOUNDS_DEFAULT };

/**
 * The physical mapping a connection's driver imposes on derived index
 * columns. A driver that can index a registered deterministic function
 * generates them; one that cannot has them written, which is why the
 * planner emits a backfill for the second and not the first.
 * @param {any} connection
 * @returns {{ derived: 'virtual' | 'stored', rtree: boolean }}
 */
function mappingFor(connection, expressions = undefined) {
  const registered = connection.capabilities?.deterministicIndexableFunctions === true;
  return {
    derived: registered ? 'virtual' : 'stored',
    // the same reasoning for the R*Tree mapping: a build without the
    // module plans (and verifies) the B-tree shape
    rtree: connection.capabilities?.rtree === true,
    // and the same for a declared index expression: this connection
    // either computes it or calls the engine's own immutable function
    expressions,
    registered,
  };
}

/** The history table name (outside the model's identifier namespace
 * conventions on purpose — a collection cannot collide with it). */
export const HISTORY_TABLE = '_jaren_migrations';
/** The tables the engine owns beside a model's: never a shape-drift finding. */
/** The tables this package owns. A model never declared one, so one
 * found in a database is the engine's own bookkeeping rather than
 * anybody's drift — the drift check skips them and the introspector
 * does not derive them. */
export const ENGINE_TABLES = new Set([HISTORY_TABLE, CHANGES_TABLE, CHANGES_STATE_TABLE,
  JOBS_TABLE, JOB_CHECKPOINTS_TABLE, ...Object.values(REPLICATION_TABLES)]);

/**
 * The signature-grade identity of a model SHAPE.
 * @param {any} model - A jaren-model document
 * @returns {string}
 */
export function shapeHash(model) {
  return hashContent(canonicalizeJson(withoutRenameHints(model)));
}

/**
 * The model without its `x-rename` hints. A hint is a PLANNING
 * instruction, not shape: two models that differ only by the hint
 * describe the same database, and hashing the hint made an empty
 * migration necessary just to move the recorded shape once the hint
 * was removed.
 * @param {any} model
 * @returns {any}
 */
function withoutRenameHints(model) {
  if (model === null || typeof model !== 'object') return model;
  const out = {};
  for (const key of Object.keys(model)) setObjectMember(out, key, model[key]);
  for (const member of ['collections', 'entities']) {
    const declared = model[member];
    if (declared === null || typeof declared !== 'object' || Array.isArray(declared)) continue;
    const stripped = {};
    for (const name of Object.keys(declared)) {
      const spec = declared[name];
      if (spec !== null && typeof spec === 'object' && !Array.isArray(spec)
        && Object.hasOwn(spec, 'x-rename')) {
        const copy = { ...spec };
        delete copy['x-rename'];
        setObjectMember(stripped, name, copy);
      }
      else {
        setObjectMember(stripped, name, spec);
      }
    }
    out[member] = stripped;
  }
  return out;
}

/**
 * The signature-grade checksum of a migration document.
 * @param {any} migration
 * @returns {string}
 */
export function migrationChecksum(migration) {
  return hashContent(canonicalizeJson(migration));
}

/**
 * @param {string} code
 * @param {string} reason
 * @param {Error} [cause]
 * @returns {DbCompileError}
 */
function refuse(code, reason, cause) {
  return new DbCompileError(code, reason, undefined, cause);
}

/**
 * A backfill step: recompute named STORED derived columns from the
 * documents already in a collection. Idempotent by construction — the
 * value is a pure function of the document — so a second run writes
 * what the first did.
 * @param {string} collection
 * @param {any} plan - the target collection's physical plan
 * @param {string[]} columnNames
 * @param {string} note
 * @returns {any} the migration step
 */
function deriveStep(collection, plan, columnNames, note) {
  const columns = plan.derived
    .filter((column) => columnNames.includes(column.name))
    .map((column) => {
      /** @type {any} */
      const entry = { name: column.name, derive: column.derive, segments: column.segments };
      if (column.precision !== undefined) entry.precision = column.precision;
      if (column.component !== undefined) entry.component = column.component;
      if (column.dims !== undefined) entry.dims = column.dims;
      return entry;
    });
  return { kind: 'derive', collection, columns, note };
}

/**
 * Plan a migration between two model documents. The planner diffs the
 * PHYSICAL plans (columns, indexes) and renders DDL through the
 * dialect; a changed schema gets a DRAFT identity transform that
 * refuses to run until the author fills it in — the planner cannot
 * infer a data transform and does not pretend to. Renames are declared
 * (`x-rename` on the target collection), never guessed.
 * The physical mapping of a DERIVED index column depends on the driver
 * that will run the migration (`derived`), because the two mappings
 * really are different columns; a migration document planned for one is
 * not the document the other needs.
 * @param {any} fromModel
 * @param {any} toModel
 * @param {{ id?: string, dialect?: any,
 *   derived?: 'virtual' | 'stored', rtree?: boolean,
 *   expressions?: Record<string, any> }} [options]
 * @returns {{ migration: any, report: {
 *   renamed: { from: string, to: string }[],
 *   added: string[], removed: string[],
 *   schemaChanged: string[], drafts: string[],
 *   destructive: boolean } }}
 */
export function planMigration(fromModel, toModel, options = undefined) {
  const dialect = options?.dialect ?? null;
  if (dialect === null || typeof dialect !== 'object')
    throw new TypeError('planMigration needs { dialect } (the store dialect renders the DDL)');
  if ([fromModel, toModel].some((m) => Object.values(m.entities ?? {}).some((e) => e.physical !== undefined)))
    throw refuse('JD0021', 'column layouts require planPhysicalMigration with explicit preservation dispositions');
  const mapping = { derived: options?.derived ?? 'virtual', rtree: options?.rtree !== false,
    // a model that declares an index EXPRESSION resolves its functions
    // here too: a plan is DDL, and DDL over a function this planner was
    // not told about is DDL nobody can apply
    expressions: options?.expressions, registered: options?.derived !== 'stored' };
  const fromCollections = normalizeModel(fromModel, options?.expressions);
  const toCollections = normalizeModel(toModel, options?.expressions);

  const steps = [];
  const report = {
    renamed: [], added: [], removed: [], schemaChanged: [], drafts: [],
    destructive: false,
  };

  // declared renames first: the physical table moves, its old-prefixed
  // indexes stay behind (probed) and are rebuilt by the index diff
  const renamedFrom = new Map();
  for (const name of toCollections.keys()) {
    const hint = toModel.collections[name]?.['x-rename'];
    if (hint === undefined) continue;
    if (!fromCollections.has(hint)) {
      // the hint's work is done once the from-model already declares the
      // target and no longer the source: planning a model against itself
      // must yield nothing, not refuse the hint it still carries
      if (fromCollections.has(name)) continue;
      throw new TypeError(
        `x-rename on '${name}' names '${hint}', which the from-model does not declare`);
    }
    if (fromCollections.has(name)) {
      throw new TypeError(
        `x-rename on '${name}' collides: the from-model already declares '${name}'`);
    }
    if (toCollections.has(hint)) {
      throw new TypeError(
        `x-rename on '${name}' collides: '${hint}' is also declared in the target model — `
        + 'a rename consumes its source');
    }
    renamedFrom.set(name, hint);
    report.renamed.push({ from: hint, to: name });
    steps.push({
      kind: 'ddl',
      sql: dialect.ddl.renameTable(hint, name),
      note: `rename collection '${hint}' to '${name}'`,
    });
  }
  const consumedOldNames = new Set(renamedFrom.values());

  for (const [name, toCollection] of toCollections) {
    const oldName = renamedFrom.get(name) ?? name;
    const fromCollection = renamedFrom.has(name)
      ? fromCollections.get(renamedFrom.get(name))
      : fromCollections.get(name);

    if (fromCollection === undefined) {
      report.added.push(name);
      for (const sql of planCollection(name, toCollection, dialect, mapping).createSql)
        steps.push({ kind: 'ddl', sql, note: `create collection '${name}'` });
      continue;
    }

    // the from-side physical facts live under the RENAMED table: same
    // columns, but index names still carry the old collection prefix
    const fromPlan = planCollection(oldName, fromCollection, dialect, mapping);
    const toPlan = planCollection(name, toCollection, dialect, mapping);
    if (fromPlan.keyType !== toPlan.keyType
      || fromCollection.identity !== toCollection.identity
      || canonicalizeJson(fromCollection.key) !== canonicalizeJson(toCollection.key)) {
      throw new TypeError(
        `collection '${name}': changing the key declaration requires a table rebuild, `
        + 'which this planner does not produce (a named non-goal — branch the shape instead)');
    }

    const fromColumns = new Map(fromPlan.generated.map((g) => [g.name, g]));
    const toColumns = new Map(toPlan.generated.map((g) => [g.name, g]));
    const fromIndexes = new Map(fromPlan.expected.indexes.map((i) => [i.name, i]));
    const toIndexes = new Map(toPlan.expected.indexes.map((i) => [i.name, i]));

    // a derived column's EXPRESSION is part of its identity: the same
    // path at a different precision, or under the other physical
    // mapping, is a different column even where name and type agree
    const columnChanged = (a, b) => a.type !== b.type || a.pathText !== b.pathText
      || (a.expression ?? null) !== (b.expression ?? null)
      || (a.stored === true) !== (b.stored === true);
    const indexChanged = (a, b) => a.unique !== b.unique
      || a.columns.join(',') !== b.columns.join(',');

    // columns first decide their fate; an index rebuilds when it
    // changes OR when any column it covers is dropped or changed (the
    // database refuses to drop a column under a live index) — then
    // everything runs in dependency order: drop indexes, drop columns,
    // add columns, create indexes
    // the R*Tree half of the physical shape (MODEL-FORMAT §2.1,
    // `physical`). Changing it in either direction is a physical change
    // and needs a migration, not an open-time alteration: the virtual
    // table and its three triggers leave BEFORE the columns they read
    // are disturbed, and arrive AFTER them with a backfill — a
    // generated column arrives populated, an R*Tree does not.
    //
    // A virtual table is compared by NAME and not by declared text,
    // which is where a column and an index are different: the name is
    // built from the column stem, the module and its column list are
    // fixed, and the three triggers are built from that same stem — so
    // under this dialect a table present on both sides cannot differ,
    // and one whose stem moved has a different name. `verifyShape`
    // compares the declared text at open, which is the backstop if that
    // ever stops being true.
    const fromVirtual = new Map(fromPlan.virtualTables.map((v) => [v.name, v]));
    const toVirtual = new Map(toPlan.virtualTables.map((v) => [v.name, v]));
    for (const [virtualName, from] of fromVirtual) {
      if (toVirtual.has(virtualName)) continue;
      for (const trigger of from.triggers) {
        steps.push({ kind: 'ddl', sql: dialect.ddl.dropTrigger(trigger.name),
          note: `drop sync trigger '${trigger.name}' on '${name}'` });
      }
      steps.push({ kind: 'ddl', sql: dialect.ddl.dropVirtualTable(virtualName),
        note: `drop the R*Tree '${virtualName}' (and its shadow tables) on '${name}'` });
    }

    const disturbedColumns = new Set();
    for (const [columnName, fromColumn] of fromColumns) {
      const target = toColumns.get(columnName);
      if (target === undefined || columnChanged(fromColumn, target))
        disturbedColumns.add(columnName);
    }
    const indexNeedsRebuild = (indexName, fromIndex) => {
      const target = toIndexes.get(indexName);
      return target === undefined || indexChanged(fromIndex, target)
        || fromIndex.columns.some((column) => disturbedColumns.has(column));
    };
    for (const [indexName, fromIndex] of fromIndexes) {
      if (indexNeedsRebuild(indexName, fromIndex)) {
        steps.push({ kind: 'ddl', sql: dialect.ddl.dropIndex(indexName),
          note: `drop index '${indexName}' on '${name}'` });
      }
    }
    for (const columnName of disturbedColumns) {
      steps.push({ kind: 'ddl', sql: dialect.ddl.dropColumn(name, columnName),
        note: `drop generated column '${columnName}' on '${name}'` });
    }
    const backfilled = [];
    for (const [columnName, toColumn] of toColumns) {
      const source = fromColumns.get(columnName);
      if (source === undefined || columnChanged(source, toColumn)) {
        steps.push({
          kind: 'ddl',
          sql: dialect.ddl.addGeneratedColumn(
            { table: name, docColumn: toPlan.docColumn, column: toColumn }),
          note: toColumn.stored === true
            ? `add stored derived column '${columnName}' on '${name}'`
            : `add generated column '${columnName}' on '${name}'`,
        });
        if (toColumn.stored === true) backfilled.push(columnName);
      }
    }
    // a GENERATED column arrives populated; a STORED one arrives NULL,
    // and a pushdown over a NULL column silently returns fewer rows.
    // The backfill is an explicit step rather than an assumption that
    // the table is empty
    if (backfilled.length > 0) {
      steps.push(deriveStep(name, toPlan, backfilled,
        `backfill derived column(s) ${backfilled.join(', ')} on '${name}'`));
    }
    for (const [indexName, toIndex] of toIndexes) {
      const source = fromIndexes.get(indexName);
      const rebuilt = source !== undefined && indexNeedsRebuild(indexName, source);
      if (source === undefined || rebuilt) {
        steps.push({
          kind: 'ddl',
          sql: dialect.ddl.createIndex(
            { name: indexName, table: name, columns: toIndex.columns, unique: toIndex.unique }),
          note: `create index '${indexName}' on '${name}'`,
        });
      }
    }
    for (const [virtualName, target] of toVirtual) {
      if (fromVirtual.has(virtualName)) continue;
      steps.push({ kind: 'ddl', sql: target.createSql,
        note: `create the R*Tree '${virtualName}' on '${name}'` });
      for (const trigger of target.triggers) {
        steps.push({ kind: 'ddl', sql: trigger.sql,
          note: `create sync trigger '${trigger.name}' on '${name}'` });
      }
      // the triggers fire on WRITES; the rows already stored need the
      // backfill, and without it a probe silently returns nothing
      steps.push({ kind: 'sql', sql: target.fillSql,
        note: `backfill the R*Tree '${virtualName}' from the stored documents` });
    }

    if (canonicalizeJson(fromCollection.schema) !== canonicalizeJson(toCollection.schema)) {
      report.schemaChanged.push(name);
      report.drafts.push(name);
      steps.push({
        kind: 'jslt',
        collection: name,
        stylesheet: [],
        draft: true,
        note: `the schema of '${name}' changed; the planner cannot infer the data `
          + 'transform. Fill in the stylesheet (or delete this step if every stored '
          + 'document already validates against the new schema) and remove "draft".',
      });
      // a transform rewrites the document, and a stored derived column
      // is computed FROM the document: without this it keeps the value
      // the old document had
      const stale = toPlan.derived
        .filter((column) => toColumns.get(column.name)?.stored === true)
        .map((column) => column.name)
        .filter((columnName) => !backfilled.includes(columnName));
      if (stale.length > 0) {
        steps.push(deriveStep(name, toPlan, stale,
          `recompute derived column(s) ${stale.join(', ')} on '${name}' after the transform`));
      }
    }
  }

  for (const [name, fromCollection] of fromCollections) {
    if (toCollections.has(name) || consumedOldNames.has(name)) continue;
    report.removed.push(name);
    report.destructive = true;
    steps.push({
      kind: 'ddl',
      sql: dialect.ddl.dropTable(name),
      note: `DESTRUCTIVE: drop collection '${name}' and every document in it. `
        + 'A rename is declared with x-rename on the target collection; without '
        + 'one, this is a drop plus a create.',
    });
    // DROP TABLE takes the collection's own triggers with it and leaves
    // the R*Tree — and its three shadow tables — standing. A leftover
    // virtual table is a stale index a recreated collection would probe
    for (const virtual of planCollection(name, fromCollection, dialect, mapping).virtualTables) {
      steps.push({ kind: 'ddl', sql: dialect.ddl.dropVirtualTable(virtual.name),
        note: `drop the R*Tree '${virtual.name}' that belonged to '${name}'` });
    }
  }

  planEntityChanges(fromModel, toModel, dialect, steps, report);

  const migration = {
    $migration: MIGRATION_VERSION,
    id: options?.id ?? `to-${shapeHash(toModel).slice(0, 8)}`,
    from: shapeHash(fromModel),
    to: shapeHash(toModel),
    steps,
  };
  return { migration, report };
}

/** `planMigration` handles the whole model — collections AND entities
 * — since the relational order; this name says so. */
export const planModelMigration = planMigration;

/** Deep-copy a schema with the mapping vocabulary stripped: a pure
 * mapping change (an index, a column toggle) is not a DOCUMENT change
 * and demands no transform. */
function stripEntityVocabulary(node) {
  if (Array.isArray(node)) return node.map(stripEntityVocabulary);
  if (node === null || typeof node !== 'object') return node;
  /** @type {any} */
  const out = {};
  for (const key of Object.keys(node)) {
    if (key === 'x-entity' || key === 'x-rename') continue;
    out[key] = stripEntityVocabulary(node[key]);
  }
  return out;
}

/**
 * The relational half of the diff (§9): entity add/drop/rename, the
 * additive and droppable column strategies with their data steps, the
 * rebuild for everything structural, join tables, and the stripped
 * document-change rule.
 * @param {any} fromModel
 * @param {any} toModel
 * @param {any} dialect
 * @param {any[]} steps
 * @param {any} report
 */
function planEntityChanges(fromModel, toModel, dialect, steps, report) {
  const fromEntities = normalizeEntities(fromModel);
  const toEntities = normalizeEntities(toModel);
  if (fromEntities.size === 0 && toEntities.size === 0) return;
  const fromMapping = fromEntities.size > 0
    ? explainMapping(fromModel) : { entities: {}, joinTables: {} };
  const toMapping = toEntities.size > 0
    ? explainMapping(toModel) : { entities: {}, joinTables: {} };
  const q = dialect.quoteIdentifier;
  const pathText = (name) => dialect.jsonPathText([{ name }]);
  const docExtract = (docSql, name) => dialect.jsonExtract(docSql, pathText(name));
  const storageType = (storage) => dialect.typeFor(storage, 'generated');

  // ————— declared entity renames (join tables move with them) —————
  const renamedFrom = new Map();
  for (const name of toEntities.keys()) {
    const hint = toModel.entities[name]?.['x-rename'];
    if (hint === undefined) continue;
    if (!fromEntities.has(hint)) {
      if (fromEntities.has(name)) continue; // a satisfied hint (see the collections)
      throw new TypeError(
        `x-rename on entity '${name}' names '${hint}', which the from-model does not declare`);
    }
    if (fromEntities.has(name) || toEntities.has(hint)) {
      throw new TypeError(
        `x-rename on entity '${name}' collides — a rename consumes its source`);
    }
    renamedFrom.set(name, hint);
    report.renamed.push({ from: hint, to: name });
    steps.push({ kind: 'ddl', sql: dialect.ddl.renameTable(hint, name),
      note: `rename entity '${hint}' to '${name}'` });
  }
  const consumedOldEntities = new Set(renamedFrom.values());
  // a join table's endpoints come from the MAPPING, never from splitting
  // its name: an entity named with an underscore, or a `through` name,
  // does not split into its endpoints — and a split that guessed wrong
  // renamed the table to a name nothing declares, created the declared
  // one empty, and dropped the memberships as "destructive"
  const implicitJoinName = (join) => [join.left.entity, join.right.entity].sort().join('_');
  const renamedEntity = (entityName) => {
    for (const [to, from] of renamedFrom) if (from === entityName) return to;
    return entityName;
  };
  const renamedJoinName = (joinName) => {
    const join = fromMapping.joinTables[joinName];
    if (joinName !== implicitJoinName(join)) return joinName; // a `through` name stays
    return [renamedEntity(join.left.entity), renamedEntity(join.right.entity)].sort().join('_');
  };
  for (const [joinName, join] of Object.entries(fromMapping.joinTables)) {
    if (![join.left, join.right].some((side) => renamedEntity(side.entity) !== side.entity)) continue;
    const newJoin = renamedJoinName(joinName);
    const target = toMapping.joinTables[newJoin];
    if (target === undefined) continue; // the relation is gone: the drop below names it
    // the fresh build orders the endpoint columns by the SORTED entity
    // names, and a rename can flip that order — then the primary key's
    // column order would differ from a fresh build's and the shape
    // check would refuse the migrated database, so the table is rebuilt
    // in the target order with its rows copied; when the order holds,
    // renaming the table and the column is enough
    const renamedColumns = [join.left, join.right]
      .map((side) => ({ from: side.column, to: `${renamedEntity(side.entity)}_key` }));
    const targetOrder = [target.left.column, target.right.column];
    const sameOrder = renamedColumns.every((column, i) => column.to === targetOrder[i]);
    if (sameOrder) {
      if (newJoin !== joinName) {
        steps.push({ kind: 'ddl', sql: dialect.ddl.renameTable(joinName, newJoin),
          note: `rename join table '${joinName}' with its endpoint` });
      }
      for (const column of renamedColumns) {
        if (column.from === column.to) continue;
        steps.push({ kind: 'ddl', sql: dialect.ddl.renameColumn(newJoin, column.from, column.to),
          note: `rename the endpoint column '${column.from}' with its entity` });
      }
      continue;
    }
    const q = dialect.quoteIdentifier;
    const sourceOf = (toColumn) => renamedColumns.find((column) => column.to === toColumn).from;
    for (const sql of planJoinTable(newJoin, target, toMapping, dialect).createSql) {
      steps.push({ kind: 'ddl', sql, note: `rebuild join table '${joinName}' as '${newJoin}' in its endpoint order` });
    }
    steps.push({ kind: 'sql',
      sql: `INSERT INTO ${q(newJoin)} (${targetOrder.map(q).join(', ')}) `
        + `SELECT ${targetOrder.map((column) => q(sourceOf(column))).join(', ')} FROM ${q(joinName)}`,
      note: `copy the memberships of '${joinName}' into '${newJoin}'` });
    steps.push({ kind: 'ddl', sql: dialect.ddl.dropTable(joinName),
      note: `drop '${joinName}' — its memberships now live in '${newJoin}'` });
  }

  // ————— per-entity strategies —————
  for (const [name, toEntity] of toEntities) {
    const fromName = renamedFrom.get(name) ?? name;
    const fromEntity = fromEntities.get(fromName);
    const tm = toMapping.entities[name];

    if (fromEntity === undefined) {
      report.added.push(name);
      for (const sql of planEntity(name, tm, toMapping, dialect).createSql)
        steps.push({ kind: 'ddl', sql, note: `create entity '${name}'` });
      continue;
    }
    const fm = fromMapping.entities[fromName];

    const fkKey = (fk) => `${fk.column}|${fk.references}|${fk.referencesKey}|${fk.onDelete}`;
    const fromFks = new Set(fm.foreignKeys.map(fkKey));
    const toFks = new Set(tm.foreignKeys.map(fkKey));
    const fksEqual = fromFks.size === toFks.size
      && [...fromFks].every((key) => toFks.has(key));
    const columnFacts = (column) =>
      `${column.storage}|${column.source}|${JSON.stringify(column.check ?? null)}`;
    const fromColumns = new Map(fm.columns.map((column) => [column.name, column]));
    const toColumns = new Map(tm.columns.map((column) => [column.name, column]));
    const changedColumns = [...toColumns.keys()].filter((columnName) =>
      fromColumns.has(columnName)
      && columnFacts(fromColumns.get(columnName)) !== columnFacts(toColumns.get(columnName)));
    const addedColumns = [...toColumns.keys()]
      .filter((columnName) => !fromColumns.has(columnName));
    const droppedColumns = [...fromColumns.keys()]
      .filter((columnName) => !toColumns.has(columnName));
    const keysEqual = JSON.stringify(fm.keys) === JSON.stringify(tm.keys);

    const needsRebuild = !keysEqual || !fksEqual || changedColumns.length > 0
      || addedColumns.some((columnName) => toColumns.get(columnName).check !== undefined);

    if (needsRebuild) {
      steps.push(...renderRebuild(name, fromName, fm, tm,
        fromMapping, toMapping, dialect, report));
    }
    else {
      // index diff first (a column cannot drop under a live index);
      // from-side index NAMES survive a rename with the OLD prefix
      const fromPlanIndexes = planEntity(fromName, fm, fromMapping, dialect)
        .expected.indexes;
      const toPlanIndexes = planEntity(name, tm, toMapping, dialect)
        .expected.indexes;
      const disturbed = new Set(droppedColumns);
      const toIndexByName = new Map(toPlanIndexes.map((index) => [index.name, index]));
      const fromIndexByName = new Map(fromPlanIndexes.map((index) => [index.name, index]));
      const indexChanged = (a, b) => a.unique !== b.unique
        || a.columns.join(',') !== b.columns.join(',');
      const indexDies = (index) => !toIndexByName.has(index.name)
        || indexChanged(index, toIndexByName.get(index.name))
        || index.columns.some((column) => disturbed.has(column));
      for (const index of fromPlanIndexes) {
        if (indexDies(index)) {
          steps.push({ kind: 'ddl', sql: dialect.ddl.dropIndex(index.name),
            note: `drop index '${index.name}' on '${name}'` });
        }
      }
      // dropped columns: fold survivors back into the document first
      for (const columnName of droppedColumns) {
        const column = fromColumns.get(columnName);
        const property = toEntity.properties.get(columnName);
        const survives = property !== undefined && column.source !== 'epoch(document)';
        if (survives) {
          const fold = column.storage === 'boolean'
            ? dialect.jsonEncode(`CASE WHEN ${q(columnName)} = 1 THEN 'true' ELSE 'false' END`)
            : q(columnName);
          steps.push({ kind: 'sql',
            sql: `UPDATE ${q(name)} SET ${q('doc')} = `
              + `${dialect.jsonSet(q('doc'), pathText(columnName), fold)} `
              + `WHERE ${q(columnName)} IS NOT NULL`,
            note: `fold '${columnName}' back into the document before dropping its column` });
        }
        else if (property === undefined) {
          report.destructive = true;
        }
        steps.push({ kind: 'ddl', sql: dialect.ddl.dropColumn(name, columnName),
          note: property === undefined
            ? `DESTRUCTIVE: drop column '${columnName}' on '${name}' — the property is gone`
            : `drop column '${columnName}' on '${name}' (the value lives in the document now)` });
      }
      // added columns (plain, check-free by the rebuild rule)
      for (const columnName of addedColumns) {
        const column = toColumns.get(columnName);
        steps.push({ kind: 'ddl',
          sql: dialect.ddl.addColumn({ table: name,
            column: { name: columnName, type: storageType(column.storage) } }),
          note: `add column '${columnName}' on '${name}'` });
        const wasDocStored = fromEntity.properties.has(columnName);
        if (wasDocStored && column.source === 'epoch(document)') {
          steps.push({ kind: 'sql',
            sql: `UPDATE ${q(name)} SET ${q(columnName)} = `
              + `${dialect.epochFromRfc3339(docExtract(q('doc'), columnName))} `
              + `WHERE ${docExtract(q('doc'), columnName)} IS NOT NULL`,
            note: `derive the epoch column from the document's '${columnName}' strings` });
        }
        else if (wasDocStored) {
          steps.push({ kind: 'sql',
            sql: `UPDATE ${q(name)} SET ${q(columnName)} = ${docExtract(q('doc'), columnName)}, `
              + `${q('doc')} = ${dialect.jsonRemove(q('doc'), pathText(columnName))} `
              + `WHERE ${docExtract(q('doc'), columnName)} IS NOT NULL`,
            note: `move '${columnName}' out of the document into its column` });
        }
      }
      for (const index of toPlanIndexes) {
        const source = fromIndexByName.get(index.name);
        if (source === undefined || indexDies(source)) {
          steps.push({ kind: 'ddl',
            sql: dialect.ddl.createIndex({ name: index.name, table: name,
              columns: index.columns, unique: index.unique }),
            note: `create index '${index.name}' on '${name}'` });
        }
      }
    }

    // the stripped document-change rule (§9)
    if (canonicalizeJson(stripEntityVocabulary(fromEntity.schema))
      !== canonicalizeJson(stripEntityVocabulary(toEntity.schema))) {
      report.schemaChanged.push(name);
      report.drafts.push(name);
      steps.push({
        kind: 'jslt', collection: name, stylesheet: [], draft: true,
        note: `the document schema of entity '${name}' changed; fill in the transform `
          + '(or delete this step if every stored document already validates) and remove "draft"',
      });
    }
  }

  // ————— dropped entities, children before parents —————
  // foreign keys are enforced while a migration runs (node:sqlite has
  // them on by default), so a parent with RESTRICT children cannot go
  // first: the dropped set is ordered so that every entity referencing
  // another dropped entity is dropped before it
  const dropped = [...fromEntities.keys()]
    .filter((name) => !toEntities.has(name) && !consumedOldEntities.has(name));
  const droppedSet = new Set(dropped);
  const references = (name) => new Set(fromMapping.entities[name].foreignKeys
    .map((fk) => fk.references).filter((target) => droppedSet.has(target) && target !== name));
  const dropOrder = [];
  const placed = new Set();
  while (dropOrder.length < dropped.length) {
    // ready: every dropped entity that no other UNPLACED dropped entity references
    const ready = dropped.filter((name) => !placed.has(name)
      && !dropped.some((other) => !placed.has(other) && other !== name && references(other).has(name)));
    if (ready.length === 0) { dropOrder.push(...dropped.filter((name) => !placed.has(name))); break; }
    for (const name of ready) { placed.add(name); dropOrder.push(name); }
  }
  for (const name of dropOrder) {
    report.removed.push(name);
    report.destructive = true;
    steps.push({ kind: 'ddl', sql: dialect.ddl.dropTable(name),
      note: `DESTRUCTIVE: drop entity '${name}' and every row in it` });
  }

  // ————— join tables —————
  const fromJoins = new Set(Object.keys(fromMapping.joinTables).map(renamedJoinName));
  for (const joinName of Object.keys(toMapping.joinTables)) {
    if (fromJoins.has(joinName)) continue;
    for (const sql of planJoinTable(joinName, toMapping.joinTables[joinName],
      toMapping, dialect).createSql) {
      steps.push({ kind: 'ddl', sql, note: `create join table '${joinName}'` });
    }
  }
  const toJoins = new Set(Object.keys(toMapping.joinTables));
  for (const joinName of Object.keys(fromMapping.joinTables)) {
    const finalName = renamedJoinName(joinName);
    if (toJoins.has(finalName)) continue;
    report.destructive = true;
    steps.push({ kind: 'ddl', sql: dialect.ddl.dropTable(finalName),
      note: `DESTRUCTIVE: drop join table '${finalName}' and its memberships` });
  }
}

/**
 * Render one rebuild step (§10): self-contained SQL — the temporary
 * table, the column-mapped copy, the final-name indexes.
 */
function renderRebuild(name, fromName, fm, tm, fromMapping, toMapping, dialect, report) {
  const q = dialect.quoteIdentifier;
  const pathText = (memberName) => dialect.jsonPathText([{ name: memberName }]);
  const temporary = `${name}__rebuild`;
  const create = [planEntity(temporary, tm, toMapping, dialect).createSql[0]];
  const indexes = planEntity(name, tm, toMapping, dialect).createSql.slice(1);

  const fromColumns = new Map(fm.columns.map((column) => [column.name, column]));
  const fromFkOnly = fm.foreignKeys
    .filter((fk) => !fromColumns.has(fk.column)).map((fk) => fk.column);
  const fromHas = (columnName) =>
    fromColumns.has(columnName) || fromFkOnly.includes(columnName);
  const storageType = (storage) => dialect.typeFor(storage, 'generated');

  // the to-table's column order: scalars (non-fk-claimed), then
  // foreign keys, then the document — exactly planEntity's assembly
  const fkNames = new Set(tm.foreignKeys.map((fk) => fk.column));
  const ordered = [
    ...tm.columns.filter((column) => !fkNames.has(column.name))
      .map((column) => ({ name: column.name, column })),
    ...tm.foreignKeys.map((fk) => ({ name: fk.column, column: null })),
  ];

  /** @type {string[]} */
  const targets = [];
  /** @type {string[]} */
  const sources = [];
  let docExpr = q('doc');
  const lost = [];
  // a SQL NULL is an ABSENT member (§9.3): folding it in as JSON null
  // turned every row without the value into a narrowing the target
  // schema refused
  const foldColumn = (expression, columnName, fold) =>
    `CASE WHEN ${q(columnName)} IS NULL THEN ${expression} `
    + `ELSE ${dialect.jsonSet(expression, pathText(columnName), fold)} END`;
  for (const { name: columnName, column } of ordered) {
    targets.push(q(columnName));
    if (fromHas(columnName)) {
      const fromColumn = fromColumns.get(columnName);
      const sameStorage = column === null || fromColumn === undefined
        || fromColumn.storage === column.storage;
      if (column !== null && column.source === 'epoch(document)'
        && fromColumn !== undefined && fromColumn.source !== 'epoch(document)') {
        // plain text column becomes a derived instant: derive from the
        // old column and keep the string in the document — an absent
        // string stays absent (§9.3), never a JSON null
        sources.push(dialect.epochFromRfc3339(q(columnName)));
        docExpr = foldColumn(docExpr, columnName, q(columnName));
      }
      else if (sameStorage) {
        sources.push(q(columnName));
      }
      else {
        sources.push(`CAST(${q(columnName)} AS ${storageType(column.storage)})`);
      }
      continue;
    }
    // a new column: from the document when the property existed there
    sources.push(column !== null && column.source === 'epoch(document)'
      ? dialect.epochFromRfc3339(dialect.jsonExtract(q('doc'), pathText(columnName)))
      : dialect.jsonExtract(q('doc'), pathText(columnName)));
  }
  // columns that vanish: fold survivors into the document, name losses
  for (const [columnName, fromColumn] of fromColumns) {
    if (ordered.some((entry) => entry.name === columnName)) continue;
    const survives = fromColumn.source !== 'epoch(document)'
      && toMapping.entities[name] !== undefined
      && tm.document.includes(columnName);
    if (survives) {
      const fold = fromColumn.storage === 'boolean'
        ? dialect.jsonEncode(`CASE WHEN ${q(columnName)} = 1 THEN 'true' ELSE 'false' END`)
        : q(columnName);
      docExpr = foldColumn(docExpr, columnName, fold);
    }
    else if (fromColumn.source !== 'epoch(document)') {
      lost.push(columnName);
    }
  }
  // an INFERRED foreign-key column (no property of its own) that the
  // target no longer carries: its values are lost unless the target
  // declares the property, in which case they fold into the document —
  // walking the mapped columns alone dropped it without a word
  for (const columnName of fromFkOnly) {
    if (ordered.some((entry) => entry.name === columnName)) continue;
    if (toMapping.entities[name] !== undefined && tm.document.includes(columnName)) {
      docExpr = foldColumn(docExpr, columnName, q(columnName));
    }
    else {
      lost.push(columnName);
    }
  }
  // properties that moved INTO columns leave the document
  for (const { name: columnName, column } of ordered) {
    if (!fromHas(columnName) && (column === null || column.source !== 'epoch(document)'))
      docExpr = dialect.jsonRemove(docExpr, pathText(columnName));
  }
  targets.push(q('doc'));
  sources.push(docExpr);

  if (lost.length > 0) report.destructive = true;
  const copy = `INSERT INTO ${q(temporary)} (${targets.join(', ')}) `
    + `SELECT ${sources.join(', ')} FROM ${q(name)}`;
  return [{
    kind: 'rebuild', table: name, create, copy, indexes,
    note: `rebuild '${name}' (${fromName === name ? '' : `renamed from '${fromName}'; `}`
      + `structural change)${lost.length > 0
        ? ` — DESTRUCTIVE: column(s) ${lost.join(', ')} are dropped with their data` : ''}`,
  }];
}

/**
 * Create a model's WHOLE physical shape on a connection: collections,
 * entity tables and join tables, exactly as `openStore` would. Used
 * by the shadow baseline, the fresh reference database that shape
 * equality compares against, and the tests.
 * @param {any} connection
 * @param {any} model
 * @param {Record<string, any>} [expressions] - the host's declared
 *   index-expression functions, resolved into the DDL the same way the
 *   open path resolves them
 * @returns {any} value-or-promise
 */
export function createModelShape(connection, model, expressions = undefined) {
  const dialect = connection.dialect;
  /** @type {string[]} */
  const statements = [];
  for (const collection of normalizeModel(model, expressions).values()) {
    statements.push(
      ...planCollection(collection.name, collection, dialect,
        mappingFor(connection, expressions)).createSql);
  }
  const entities = normalizeEntities(model);
  if (entities.size > 0) {
    const mapping = explainMapping(model);
    for (const name of Object.keys(mapping.entities)) {
      statements.push(
        ...planEntity(name, mapping.entities[name], mapping, dialect).createSql);
    }
    for (const name of Object.keys(mapping.joinTables)) {
      statements.push(
        ...planJoinTable(name, mapping.joinTables[name], mapping, dialect).createSql);
    }
  }
  const run = (i) => (i >= statements.length
    ? null
    : chain(connection.exec(statements[i]), () => run(i + 1)));
  return run(0);
}

/**
 * The declared schema of a database, normalized for comparison: every
 * object carrying SQL text (tables, indexes), whitespace-collapsed,
 * engine-owned tables excluded, sorted. Shape equality after a migration —
 * this dump versus a fresh {@link createModelShape} — is the
 * acceptance criterion for every rebuild.
 * @param {any} connection
 * @returns {any} value-or-promise of `{ type, name, owner, sql }[]`
 */
export function schemaShapeOf(connection) {
  const dialect = connection.dialect;
  return chain(connection.prepare(dialect.introspect.schemaDump()), (statement) =>
    chain(statement.all([]), (rows) => rows
      // the engine's own tables — history, the change log and its state
      // row, the job queue and replication ledger — are never a model's drift
      .filter((row) => !ENGINE_TABLES.has(String(row.name)) && !ENGINE_TABLES.has(String(row.owner)))
      .map((row) => ({
        type: String(row.type),
        name: String(row.name),
        owner: String(row.owner),
        sql: normalizeSchemaSql(String(row.sql)),
      }))));
}

/**
 * Whitespace-collapse a schema statement and, for a CREATE TABLE,
 * SORT its top-level column/constraint list: `ALTER TABLE ADD COLUMN`
 * appends at the end, so a migrated table's declared order can differ
 * from a fresh build's without differing in meaning — every access in
 * this store is by name.
 * @param {string} sql
 * @returns {string}
 */
function normalizeSchemaSql(sql) {
  const collapsed = sql.replace(/\s+/g, ' ').trim();
  const open = collapsed.indexOf('(');
  if (!/^CREATE TABLE/i.test(collapsed) || open === -1) return collapsed;
  const close = collapsed.lastIndexOf(')');
  const head = collapsed.slice(0, open + 1);
  const tail = collapsed.slice(close);
  const body = collapsed.slice(open + 1, close);
  /** @type {string[]} */
  const parts = [];
  let depth = 0;
  let quote = null;
  let current = '';
  for (const character of body) {
    if (quote !== null) {
      current += character;
      if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      current += character;
      continue;
    }
    if (character === '(') depth++;
    if (character === ')') depth--;
    if (character === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += character;
  }
  if (current.trim() !== '') parts.push(current.trim());
  return head + parts.sort().join(', ') + tail;
}

/**
 * Compare a migrated database's schema against the shape a fresh
 * `createModelShape(model)` produces, via a throwaway reference
 * database. Returns `null` when equal, or a one-line difference.
 * @param {any} driver
 * @param {any} connection - the migrated database
 * @param {any} model - the target model
 * @param {((connection: any) => any) | undefined} registerFunctions
 * @returns {any} value-or-promise of `string | null`
 */
export function compareShapeToModel(driver, connection, model, registerFunctions, expressions) {
  // The comparison IS a text comparison: it builds the model's shape in
  // a reference database and compares the two engines' stored CREATE
  // statements. An engine that keeps none has nothing to compare, and
  // says so here rather than reading an undefined statement — the
  // structural drift check (columns, indexes, foreign-key tuples) runs
  // per collection and per entity either way, and `declaredSqlText` is
  // what tells a reader which half they got.
  if (connection.dialect.capabilities.declaredSqlText !== true) return null;
  return chain(driver.open(':memory:', {}), (reference) =>
    chain(chain(registerDeriveFunctions(reference),
      () => (registerFunctions !== undefined ? registerFunctions(reference) : null)), () => {
      const finish = (result) => chain(reference.close(), () => result);
      let outcome;
      try {
        outcome = chain(createModelShape(reference, model, expressions), () =>
          chain(schemaShapeOf(reference), (wanted) =>
            chain(schemaShapeOf(connection), (actual) => {
              const wantedText = JSON.stringify(wanted);
              const actualText = JSON.stringify(actual);
              if (wantedText === actualText) return null;
              const byKey = (rows) => new Map(rows.map(
                (row) => [`${row.type}:${row.name}`, row.sql]));
              const wantedMap = byKey(wanted);
              const actualMap = byKey(actual);
              for (const [key, sql] of wantedMap) {
                if (!actualMap.has(key)) return `missing ${key}`;
                if (actualMap.get(key) !== sql)
                  return `${key} differs: have [${actualMap.get(key)}], want [${sql}]`;
              }
              for (const key of actualMap.keys()) {
                if (!wantedMap.has(key)) return `unexpected ${key}`;
              }
              return 'schemas differ in ordering only';
            })));
      }
      catch (error) {
        return chain(reference.close(), () => { throw error; });
      }
      if (outcome instanceof Promise) {
        return outcome.then(
          (value) => chain(reference.close(), () => value),
          (error) => chain(reference.close(), () => { throw error; }));
      }
      return finish(outcome);
    }));
}

/**
 * Count can use the existing provider planner without assuming an intermediate
 * schema. A native plan proves both row selection and item cardinality. Typed
 * aggregates keep ordered engine folds until their current shape is declared.
 */
function assertionProvider(query, collection, shape) {
  if (shape !== '$count') return null;
  const operand = query.$count;
  const document = { $count: typeof operand === 'string' && operand.startsWith('$[*]')
    ? { $for: { row: '$[*]' }, $return: `$row${operand.slice(4)}` } : operand };
  const source = { collection, schema: { type: 'object' }, columnByCanonical: new Map(), indexes: [] };
  const planned = planQuery(document, source);
  return planned.mode === 'native' && planned.plan?.aggregate?.fn === 'count' ? document : null;
}

/**
 * The batched row walk shared by transforms and post-validation:
 * `SELECT rowid, json(doc) ... WHERE rowid > ? ORDER BY rowid LIMIT ?`
 * — bounded memory over a collection of any size.
 * @param {any} connection
 * @param {string} table
 * @param {number} batchSize
 * @param {(rows: { rid: any, doc: string, key: any }[]) => any} handle
 *   value-or-promise per batch
 * @param {boolean} [keyed]
 * @param {any} [entityMapping]
 * @param {() => void} [check] - run before every batch: the
 *   cancellation boundary a data step has between its batches
 * @returns {any}
 */
function walkRows(connection, table, batchSize, handle, keyed = true, entityMapping = null,
  check = undefined) {
  // entity tables carry no 'key' column — the transform walk goes by
  // row identity alone; only the collection walks select the key. An
  // entity's mapped columns ride beside the document so the row can be
  // read WHOLE (`mergeEntityRow`): a transform or an assertion that saw
  // the rest-document alone could not see `id` or `name` at all
  const dialect = connection.dialect;
  const q = dialect.quoteIdentifier;
  if (entityMapping?.document === false) {
    const order = entityMapping.keys.map((k) => q(entityMapping.columns.find((c) => c.name === k).physical)).join(', ');
    const next = (offset) => {
      check?.();
      const sql = `SELECT ${physicalSelection(entityMapping, dialect)} FROM ${q(entityMapping.table)} ORDER BY ${order} ${dialect.limitClause(batchSize, offset)}`;
      return chain(connection.prepare(sql), (statement) => chain(statement.all([]), (rows) => {
        if (!rows.length) return null;
        return chain(handle(rows.map((row, i) => ({ ...row, rid: offset + i }))), () => next(offset + rows.length));
      }));
    };
    return next(0);
  }
  const rid = dialect.rowIdentity();
  const keySelect = keyed ? `, ${q('key')} AS ${q('k')}` : '';
  const columnSelect = entityMapping === null ? '' : entityColumnsOf(entityMapping)
    .map((column) => `, ${q(column)}`).join('');
  const select = `SELECT ${rid} AS ${q('rid')}, ${dialect.jsonText(q('doc'))} AS ${q('doc')}`
    + `${keySelect}${columnSelect} FROM ${q(table)}`;
  const ordered = ` ORDER BY ${rid} ${dialect.limitClause(batchSize, undefined)}`;
  // An INTEGER PRIMARY KEY can be negative. The first batch has no
  // lower bound; subsequent batches seek from a row actually read.
  return chain(connection.prepare(select + ordered), (first) => chain(connection.prepare(
    `${select} WHERE ${rid} > ${dialect.parameterRef(1, 'after')}${ordered}`), (statement) => {
    const nextBatch = (after) => {
      if (check !== undefined) check();
      return chain(after === undefined ? first.all([]) : statement.all([after]), (rows) => {
        if (rows.length === 0) return null;
        return chain(handle(rows), () =>
          nextBatch(rows[rows.length - 1].rid));
      });
    };
    return nextBatch(undefined);
  }));
}

/** The physical columns an entity row carries beside its document. */
function entityColumnsOf(entityMapping) {
  const names = new Set(entityMapping.columns.map((column) => column.name));
  for (const fk of entityMapping.foreignKeys) names.add(fk.column);
  return [...names];
}

/**
 * The entity mapping a migration step over `table` runs under, or
 * `null` for a collection. The TARGET model maps the table: a chain's
 * intermediate shapes are hashes only, so an entity transform belongs
 * to the last migration of a chain (MIGRATION-FORMAT §9); without a
 * target model the step sees the rest-document, as it always did.
 * @param {any} options
 * @param {string} table
 * @returns {{ entity: any, mapping: any } | null}
 */
function entityStepMapping(options, table) {
  if (options.model === undefined) return null;
  const entities = normalizeEntities(options.model);
  const entity = entities.get(table);
  if (entity === undefined) return null;
  return { entity, mapping: explainMapping(options.model).entities[table] };
}

/**
 * Run one migration's steps against a connection.
 * @param {any} connection
 * @param {any} migration
 * @param {{ batchSize: number, onProgress?: Function }} options
 * @returns {any} value-or-promise
 */
function runSteps(connection, migration, options) {
  const dialect = connection.dialect;
  const q = dialect.quoteIdentifier;
  const step = (i) => {
    if (i >= migration.steps.length) return null;
    // the cancellation boundary between steps: a refusal here rolls the
    // migration in flight back whole, as any step failure does
    if (options.check !== undefined) options.check();
    const current = migration.steps[i];
    if (migration.physical && !['ddl', 'sql', 'rebuild'].includes(current.kind))
      throw refuse('JD0021', 'physical preservation plans use explicit SQL/rebuild steps and preservation assertions');
    const fail = (reason, cause) => {
      throw refuse('JD0023',
        `migration '${migration.id}' step ${i} (${current.kind}) failed: ${reason}`,
        cause);
    };
    // every step is its own savepoint inside the migration transaction
    return chain(connection.transaction(() => {
      if (current.kind === 'ddl' || current.kind === 'sql') {
        // 'sql' is a DATA step spelled directly (§9.4): same execution
        // as ddl, distinct on purpose — dry-run always shows it, and a
        // reviewer reads intent from the kind
        try {
          return connection.exec(current.sql);
        }
        catch (cause) {
          return fail(/** @type {Error} */ (cause).message, /** @type {Error} */ (cause));
        }
      }
      if (current.kind === 'rebuild') {
        // the documented ALTER TABLE procedure (§10): create the new
        // shape under the temporary name, copy, drop, rename, recreate
        // indexes, then PRAGMA foreign_key_check INSIDE the
        // transaction — a broken reference fails the migration
        const temporary = `${current.table}__rebuild`;
        const statements = [
          ...current.create,
          current.copy,
          dialect.ddl.dropTable(current.table),
          dialect.ddl.renameTable(temporary, current.table),
          ...current.indexes,
        ];
        const runNext = (j) => {
          if (j >= statements.length) {
            if (dialect.capabilities.foreignKeysAlwaysOn === true) return null;
            return chain(connection.prepare(dialect.pragma.foreignKeyCheck()),
              (checkStatement) => chain(checkStatement.all([]), (violations) => {
                if (violations.length > 0) {
                  fail(`foreign_key_check found ${violations.length} broken reference(s) `
                    + `after rebuilding '${current.table}' `
                    + `(first: ${JSON.stringify(violations[0])})`);
                }
                return null;
              }));
          }
          try {
            return chain(connection.exec(statements[j]), () => runNext(j + 1));
          }
          catch (cause) {
            return fail(/** @type {Error} */ (cause).message, /** @type {Error} */ (cause));
          }
        };
        return runNext(0);
      }
      if (current.kind === 'derive') {
        // recompute stored derived columns from the documents already
        // present — the branch where a derived column is an ordinary
        // one the store writes, so an ALTER that adds it leaves every
        // existing row NULL until this runs
        const columns = current.columns;
        const assignments = columns.map((column, at) =>
          `${q(column.name)} = ${dialect.parameterRef(at + 1, column.name)}`);
        const updateSql = `UPDATE ${q(current.collection)} SET ${assignments.join(', ')} `
          + `WHERE ${dialect.rowIdentity()} = ${dialect.parameterRef(columns.length + 1, 'rid')}`;
        let derivedRows = 0;
        return chain(connection.prepare(updateSql), (update) =>
          chain(walkRows(connection, current.collection, options.batchSize, (rows) => {
            for (const row of rows) {
              const doc = JSON.parse(row.doc);
              update.run([
                ...columns.map((column) => derivedValue(column, memberAt(doc, column.segments))),
                row.rid,
              ]);
              derivedRows++;
            }
            options.onProgress?.({
              migration: migration.id,
              collection: current.collection,
              derived: derivedRows,
            });
          }, false, null, options.check), () => derivedRows));
      }
      if (current.kind === 'jslt') {
        const stepEntity = entityStepMapping(options, current.collection);
        const operation = compileDocumentStep(current, i, {
          migrationId: migration.id,
          compileJslt: compileJsltStylesheet,
          compileQuery: compileJsonQuery,
          keys: stepEntity === null ? [] : stepEntity.mapping.keys,
        });
        if (stepEntity !== null) {
          // an entity row is transformed WHOLE: the mapped columns fold in
          // before the stylesheet and split out after it, through the
          // entity's own split — a column-mapped member the stylesheet
          // wrote used to land in the document and be shadowed on read
          const core = entityCore(connection, stepEntity.entity, stepEntity.mapping, null,
            options.runtime);
          const columns = entityColumnsOf(stepEntity.mapping);
          const assignments = [
            ...columns.map((column, i) => `${q(column)} = ${dialect.parameterRef(i + 1, 'v')}`),
            `${q('doc')} = ${dialect.jsonEncode(dialect.parameterRef(columns.length + 1, 'doc'))}`,
          ];
          const updateSql = `UPDATE ${q(current.collection)} SET ${assignments.join(', ')} `
            + `WHERE ${dialect.rowIdentity()} = ${dialect.parameterRef(columns.length + 2, 'rid')}`;
          let transformed = 0;
          return chain(connection.prepare(updateSql), (update) =>
            chain(walkRows(connection, current.collection, options.batchSize, (rows) => {
              for (const row of rows) {
                const whole = mergeEntityRow(stepEntity.mapping, row, 'doc');
                const next = operation.apply(whole, row.rid);
                const { values, rest } = core.plan.split(next);
                const byName = new Map(values.map((value) => [value.name, value.value]));
                update.run([...columns.map((column) => byName.get(column) ?? null),
                  JSON.stringify(rest), row.rid]);
                transformed++;
              }
              options.onProgress?.({
                migration: migration.id,
                collection: current.collection,
                transformed,
              });
            }, false, stepEntity.mapping, options.check), () => transformed));
        }
        const updateSql = `UPDATE ${q(current.collection)} SET ${q('doc')} = `
          + `${dialect.jsonEncode(dialect.parameterRef(1, 'doc'))} `
          + `WHERE ${dialect.rowIdentity()} = ${dialect.parameterRef(2, 'rid')}`;
        let transformed = 0;
        const keyed = false;
        return chain(connection.prepare(updateSql), (update) =>
          chain(walkRows(connection, current.collection, options.batchSize, (rows) => {
            for (const row of rows) {
              const next = operation.apply(JSON.parse(row.doc), row.rid);
              update.run([JSON.stringify(next), row.rid]);
              transformed++;
            }
            options.onProgress?.({
              migration: migration.id,
              collection: current.collection,
              transformed,
            });
          }, keyed, null, options.check), () => transformed));
      }
      // kind === 'query': the assertion step
      const assertionMapping = entityStepMapping(options, current.collection)?.mapping ?? null;
      const operation = compileDocumentStep(current, i, {
        migrationId: migration.id,
        compileJslt: compileJsltStylesheet,
        compileQuery: compileJsonQuery,
        assertionBounds: options.assertionBounds,
      });
      const assertOver = operation.assert;
      const readDoc = (row) => (assertionMapping === null
        ? JSON.parse(row.doc)
        : mergeEntityRow(assertionMapping, row, 'doc'));

      const provider = assertionMapping === null ? assertionProvider(current.assert, current.collection, operation.shape) : null;
      options.onAssertionPlan?.({ ...operation.plan, ...(provider === null ? {} : {
        strategy: 'provider', reason: 'the existing query planner proves a native count without assuming an intermediate schema',
      }) });
      if (provider !== null) {
        const engine = createQueryEngine({ connection, state: createQueryState(),
          collection: { name: current.collection, schema: { type: 'object' }, docPath: '' },
          physicalPlan: { table: current.collection, keyColumn: 'key', docColumn: 'doc', columnByCanonical: new Map() },
        });
        return chain(engine.execute(provider, { strict: true }), operation.accept);
      }

      if (operation.fold !== null) {
        // Consume operand items in row order through the query engine's
        // shared state: regrouping floating-point batch totals is unsound.
        let accumulated = operation.fold.start();
        let folded = 0;
        return chain(walkRows(connection, current.collection, options.batchSize, (rows) => {
          accumulated = operation.fold.combine(accumulated, rows.map(readDoc));
          folded += rows.length;
          options.onProgress?.({
            migration: migration.id,
            collection: current.collection,
            asserted: folded,
          });
        }, false, assertionMapping, options.check), () => operation.fold.finish(accumulated));
      }

      if (!operation.perDocument) {
        // materializing: the answer needs every document at once. That is
        // a cost, so it is bounded and the bound is crossed BEFORE the
        // excess is held — the walk stops at the row that would break it
        const guard = createAssertionBoundGuard(options.assertionBounds, current.collection,
          `the assertion of migration '${migration.id}' step ${i}`);
        const gathered = [];
        return chain(walkRows(connection, current.collection, options.batchSize, (rows) => {
          for (const row of rows) {
            const doc = readDoc(row);
            guard.admit(doc, typeof row.doc === 'string' ? row.doc : undefined);
            gathered.push(doc);
          }
        }, false, assertionMapping, options.check), () => assertOver(gathered));
      }
      // per-document: walk in keyset batches like every other step,
      // failing fast at the first batch that violates
      let asserted = 0;
      return walkRows(connection, current.collection, options.batchSize, (rows) => {
        const docs = rows.map(readDoc);
        assertOver(docs);
        asserted += docs.length;
        options.onProgress?.({
          migration: migration.id,
          collection: current.collection,
          asserted,
        });
      }, false, assertionMapping, options.check);
    }), () => step(i + 1));
  };
  return step(0);
}

/**
 * Validate the final state against the target model on this
 * connection: physical shape, schema conformance of every stored
 * document (when a `compileSchema` hook is provided — the real-data
 * widening/narrowing FACT), and key-column consistency for
 * caller-keyed collections.
 * @param {any} connection
 * @param {any} model
 * @param {{ compileSchema?: Function, batchSize: number }} options
 * @returns {any} value-or-promise
 */
function validateTargetState(connection, model, options) {
  const collections = [...normalizeModel(model, options.expressions).values()];
  const entities = [...normalizeEntities(model).values()];
  const dialect = connection.dialect;
  // entity tables carry no 'key' column; the batched walk goes by row
  // identity and validates every stored document against the target
  const verifyEntity = (i) => {
    if (i >= entities.length) return null;
    const entity = entities[i];
    const validate = options.compileSchema !== undefined
      ? options.compileSchema(entity.schema)
      : null;
    if (validate === null && entity.physical === null) return verifyEntity(i + 1);
    // the WHOLE document — mapped columns folded in — is what the target
    // schema judges; the rest-document alone failed every entity whose
    // required members are columns, so a pure widening could not land
    const entityMapping = explainMapping(model).entities[entity.name];
    return chain(entity.physical === null ? null : chain(readSchema(connection), (schema) =>
      verifyPhysical(connection, planEntity(entity.name, entityMapping, explainMapping(model), dialect).physical, schema)), () =>
      chain(walkRows(connection, entityMapping.table, options.batchSize, (rows) => {
      for (const row of rows) {
        const outcome = validate === null ? true : validate(mergeEntityRow(entityMapping, row, 'doc'));
        const valid = outcome === true || outcome?.valid === true;
        if (!valid) {
          throw refuse('JD0021',
            `entity '${entity.name}': a stored document (row ${row.rid}) does not `
            + 'validate against the target schema — a narrowing needs a data transform');
        }
      }
    }, false, entityMapping), () => verifyEntity(i + 1)));
  };
  const verifyNext = (i) => {
    if (i >= collections.length) return null;
    const collection = collections[i];
    const plan = planCollection(collection.name, collection, dialect,
      mappingFor(connection, options.expressions));
    const validate = options.compileSchema !== undefined
      ? options.compileSchema(collection.schema)
      : null;
    return chain(verifyShape(connection, plan, collection.name, collection.docPath), () =>
      chain(walkRows(connection, collection.name, options.batchSize, (rows) => {
        for (const row of rows) {
          const doc = JSON.parse(row.doc);
          if (validate !== null) {
            const outcome = validate(doc);
            const valid = outcome === true || outcome?.valid === true;
            if (!valid) {
              throw refuse('JD0021',
                `collection '${collection.name}': the stored document under key `
                + `'${String(row.k)}' does not validate against the target schema — `
                + 'a narrowing needs a data transform');
            }
          }
          if (collection.keySegments !== null) {
            let node = doc;
            for (const segment of collection.keySegments) node = node?.[segment.name];
            if (node !== row.k) {
              throw refuse('JD0023',
                `collection '${collection.name}': a transform changed the key member `
                + `of '${String(row.k)}' — key changes are not supported in ${MIGRATION_VERSION}`);
            }
          }
        }
      }), () => verifyNext(i + 1)));
  };
  return chain(verifyNext(0), () => verifyEntity(0));
}

/**
 * Replay the whole migration chain on a shadow database: the baseline
 * shape is created, every migration's steps run (over an empty data
 * set — the shadow proves STRUCTURE; the real-data facts are checked
 * on the real store inside its transaction), and the end shape is
 * verified against the target model. The real store is untouched
 * until the shadow passes.
 * @param {any} driver
 * @param {string} shadowPath
 * @param {any} baseline
 * @param {any[]} migrations
 * @param {any} model - target model or undefined
 * @param {{ batchSize: number }} options
 * @returns {any} value-or-promise
 */
function replayOnShadow(driver, shadowPath, baseline, migrations, model, options) {
  return chain(driver.open(shadowPath, {}), (shadow) => {
    const finish = (result) => chain(shadow.close(), () => result);
    // a UDF-expression index is invisible to a connection that has not
    // registered the function (probed, never assumed): the shadow
    // re-registers every declared function BEFORE any DDL runs
    const registered = chain(registerDeriveFunctions(shadow), () =>
      (options.registerFunctions !== undefined ? options.registerFunctions(shadow) : null));
    const apply = (i) => {
      if (i >= migrations.length) return null;
      // a rebuild moves rows between tables while their keys point at
      // the old one, so the switch comes off around it — on an engine
      // that HAS a switch. One that always enforces cannot rebuild that
      // way, and `alterTableFull` is why it never has to
      const bracket = migrations[i].steps.some(
        (candidate) => candidate.kind === 'rebuild')
        && shadow.dialect.capabilities.foreignKeysAlwaysOn !== true;
      return chain(
        bracket ? shadow.exec(shadow.dialect.pragma.foreignKeys(false)) : null,
        () => chain(runSteps(shadow, migrations[i], options), () =>
          chain(bracket ? shadow.exec(shadow.dialect.pragma.foreignKeys(true)) : null,
            () => apply(i + 1))));
    };
    const run = () => chain(registered, () =>
      chain(createModelShape(shadow, baseline, options.expressions), () => chain(apply(0), () => {
        if (model === undefined) return null;
        const target = [...normalizeModel(model, options.expressions).values()];
        const verifyNext = (i) => {
          if (i >= target.length) return null;
          const plan = planCollection(target[i].name, target[i], shadow.dialect,
            mappingFor(shadow, options.expressions));
          return chain(
            verifyShape(shadow, plan, target[i].name, target[i].docPath),
            () => verifyNext(i + 1));
        };
        return chain(verifyNext(0), () => {
          if (normalizeEntities(model).size === 0) return null;
          // relational models: SHAPE EQUALITY against a fresh build is
          // the acceptance criterion — stronger than per-plan checks
          return chain(
            compareShapeToModel(driver, shadow, model, options.registerFunctions),
            (difference) => {
              if (difference !== null) {
                throw refuse('JD0023',
                  `the shadow's migrated shape does not equal the target model's: ${difference}`);
              }
              return null;
            });
        });
      })));
    let outcome;
    try {
      outcome = run();
    }
    catch (error) {
      return chain(shadow.close(), () => { throw error; });
    }
    if (outcome instanceof Promise) {
      return outcome.then(
        (value) => chain(shadow.close(), () => value),
        (error) => chain(shadow.close(), () => { throw error; }));
    }
    return finish(outcome);
  });
}

/** History-table statement builders (dialect-spelled). */
function historyStatements(dialect) {
  const q = dialect.quoteIdentifier;
  const text = dialect.typeFor('string', 'key');
  const integer = dialect.typeFor('integer', 'key');
  return {
    create: dialect.ddl.createPlainTable({
      table: HISTORY_TABLE,
      columns: [
        { name: 'id', type: text, primaryKey: true },
        { name: 'applied_at', type: integer },
        { name: 'from_hash', type: text },
        { name: 'to_hash', type: text },
        { name: 'checksum', type: text },
        { name: 'steps', type: integer },
      ],
    }),
    select: `SELECT ${['id', 'from_hash', 'to_hash', 'checksum'].map(q).join(', ')} `
      + `FROM ${q(HISTORY_TABLE)} ORDER BY ${dialect.rowIdentity()}`,
    insert: `INSERT INTO ${q(HISTORY_TABLE)} `
      + `(${['id', 'applied_at', 'from_hash', 'to_hash', 'checksum', 'steps'].map(q).join(', ')}) `
      + `VALUES (${[1, 2, 3, 4, 5, 6].map((i) => dialect.parameterRef(i, 'v')).join(', ')})`,
  };
}

/**
 * Report a database's migration state without touching it — the
 * history table is probed, never created, so a fresh file stays byte
 * for byte what it was: what is applied, what is pending, whether an
 * applied migration was edited, and — once the chain is fully applied —
 * whether the physical shape DRIFTED from the model (someone changed
 * the database by hand, §12).
 * @param {{ driver: any, path?: string }} target
 * @param {any[]} migrations - the full ordered list
 * @param {{ model?: any, registerFunctions?: (connection: any) => any,
 *   signal?: AbortSignal, deadline?: number,
 *   runtime?: Partial<import('@jarenjs/core/runtime').Runtime> }} options
 *   - `signal`/`deadline` refuse a call already cancelled (`JD2080`) or
 *   past its deadline (`JD2075`) on the runtime record's clock
 * @returns {Promise<{ applied: string[], pending: string[],
 *   drift: string | null, upToDate: boolean }>}
 */
export function migrationStatus(target, migrations, options = {}) {
  // a call already cancelled, or past its deadline on the caller's
  // clock, opens nothing
  try {
    refuseCancelled({ signal: options.signal, deadline: options.deadline },
      resolveRuntime(options.runtime).now,
      { abortCode: 'JD2080', aborted: 'it ran', passed: 'the status read ran', ran: 'no step ran' });
  }
  catch (error) {
    return Promise.reject(error);
  }
  return toPromise(chain(
    target.driver.open(target.path ?? ':memory:', {}),
    (connection) => {
      const dialect = connection.dialect;
      const statements = historyStatements(dialect);
      const finish = (result) => chain(connection.close(), () => result);
      const failClosed = (error) => chain(connection.close(), () => { throw error; });
      let work;
      try {
        // §6's "writes NOTHING" holds for a status read too: the history
        // table is probed, never created, and an absent one reads as an
        // empty history — the same promise the dry run makes
        work = chain(registerDeriveFunctions(connection), () =>
          chain(chain(connection.prepare(dialect.introspect.tableExists()), (probe) =>
            chain(probe.get([HISTORY_TABLE]), (present) => (present === undefined
              ? []
              : chain(connection.prepare(statements.select), (select) => select.all([]))))),
          (rows) => chain(rows, () => {
              for (let i = 0; i < rows.length; i++) {
                const doc = migrations[i];
                if (doc === undefined || doc.id !== rows[i].id
                  || migrationChecksum(doc) !== rows[i].checksum) {
                  throw refuse('JD0022',
                    `history position ${i} records '${rows[i].id}' but the migration list `
                    + `has '${doc?.id ?? '<nothing>'}' (or an edited document)`);
                }
              }
              const applied = rows.map((row) => String(row.id));
              const pending = migrations.slice(rows.length)
                .map((migration) => String(migration.id));
              if (pending.length > 0 || options.model === undefined) {
                return { applied, pending, drift: null, upToDate: pending.length === 0 };
              }
              return chain(
                compareShapeToModel(target.driver, connection, options.model,
                  options.registerFunctions),
                (difference) => ({
                  applied, pending, drift: difference, upToDate: difference === null,
                }));
            })));
      }
      catch (error) {
        return failClosed(error);
      }
      return work instanceof Promise ? work.then(finish, failClosed) : finish(work);
    }));
}

/**
 * Apply pending migrations to a database.
 *
 * The contract: `migrations` is the FULL ordered list (applied and
 * pending — the migrations directory); `baseline` is the model the
 * store was first created with (the chain's anchor and the shadow's
 * starting shape); `model` is the target model the code now carries.
 * Each pending migration runs in ONE exclusive transaction with a
 * savepoint per step; a failing step rolls the whole migration back.
 * The whole chain replays on a `:memory:` shadow before the real
 * store is touched.
 *
 * @param {{ driver: any, path?: string, busyTimeout?: number }} target
 * @param {any[]} migrations
 * @param {{ baseline: any, model?: any, compileSchema?: Function,
 *   dryRun?: boolean, batchSize?: number, onProgress?: Function,
 *   shadow?: boolean, shadowPath?: string, shadowDriver?: any,
 *   signal?: AbortSignal, deadline?: number,
 *   runtime?: Partial<import('@jarenjs/core/runtime').Runtime> }} options
 *   `signal` and `deadline` cancel between migrations, steps and
 *   batches (`JD2080` / `JD2075`, the deadline read against `runtime`'s
 *   clock); a cancelled migration rolls back whole and the completed
 *   ones stand.
 *   `runtime` is the host's runtime record: the clock every applied
 *   migration is stamped with, and the clock and identifiers an entity
 *   step's `default: 'now'` / `default: 'uuid'` fill; the platform's own
 *   when absent
 * @returns {Promise<any>}
 */
export function migrate(target, migrations, options) {
  if (target === null || typeof target !== 'object'
    || target.driver === null || typeof target.driver !== 'object'
    || typeof target.driver.open !== 'function')
    throw new TypeError('migrate needs { driver } (and usually { path })');
  if (!Array.isArray(migrations))
    throw new TypeError('migrate needs the full ordered migration list');
  if (options === null || typeof options !== 'object' || options.baseline === undefined)
    throw new TypeError(
      'migrate needs { baseline }: the model the store was first created with '
      + '(the chain anchor and the shadow starting shape)');
  const batchSize = options.batchSize ?? 500;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1)
    throw new TypeError('batchSize must be a positive safe integer');
  const runtime = resolveRuntime(options.runtime);
  /**
   * The cancellation boundary: between migrations, between steps and
   * between the batches of a data step, on the runtime record's clock.
   * Nothing interrupts a statement that has started; a refusal inside a
   * migration rolls that migration back whole and the completed ones
   * stand, so a rerun resumes from the recorded position.
   */
  const check = () => refuseCancelled({ signal: options.signal, deadline: options.deadline }, runtime.now, {
    abortCode: 'JD2080', aborted: 'its next step', passed: 'its next step',
    ran: 'no further step ran; a migration in flight rolled back whole and a rerun resumes '
      + 'from the recorded position',
  });
  const runOptions = {
    batchSize,
    assertionBounds: normalizeAssertionBounds(options.assertionBounds),
    onProgress: options.onProgress,
    onAssertionPlan: options.onAssertionPlan,
    registerFunctions: options.registerFunctions,
    // the host's declared index-expression functions ride to every
    // planner and every connection this run opens — the shadow's
    // baseline, the reference database and the real store all resolve a
    // declared expression against the same declarations the open path
    // was given, or they would plan DDL nobody can apply
    expressions: options.expressions,
    model: options.model,
    runtime,
    check,
  };
  try {
    check();
  }
  catch (error) {
    return Promise.reject(error);
  }

  return toPromise(chain(
    target.driver.open(target.path ?? ':memory:', { timeout: target.busyTimeout ?? 5000 }),
    (connection) => chain(
      chain(registerDeriveFunctions(connection),
        () => (options.registerFunctions !== undefined
          ? options.registerFunctions(connection) : null)),
      () => {
      const dialect = connection.dialect;
      const statements = historyStatements(dialect);
      const finish = (result) => chain(connection.close(), () => result);
      const failClosed = (error) => chain(connection.close(), () => { throw error; });

      let work;
      try {
        // §6's "writes NOTHING": an apply creates the empty history
        // table before reading it, a DRY RUN probes for it instead and
        // reads an absent one as an empty history — the promise a dry
        // run makes is the reason it is safe to point at production
        let historyExists = false;
        const history = chain(connection.prepare(dialect.introspect.tableExists()), (probe) =>
          chain(probe.get([HISTORY_TABLE]), (row) => {
            historyExists = row !== undefined;
            return !historyExists ? [] : chain(connection.prepare(statements.select), (select) => select.all([]));
          }));
        work = chain(history, (appliedRows) => {
          // the list must agree with the history: same ids, same
          // order, same checksums — an edited applied migration is
          // always a bug worth failing on
          for (let i = 0; i < appliedRows.length; i++) {
            const row = appliedRows[i];
            const doc = migrations[i];
            if (doc === undefined || doc.id !== row.id) {
              throw refuse('JD0022',
                `history position ${i} records '${row.id}' but the migration list has `
                + `'${doc?.id ?? '<nothing>'}' — the list must contain every applied `
                + 'migration, in order');
            }
            if (migrationChecksum(doc) !== row.checksum) {
              throw refuse('JD0022',
                `migration '${row.id}' differs from the document recorded in the `
                + 'history — an applied migration must never be edited');
            }
          }
          const pending = migrations.slice(appliedRows.length);
          const currentShape = appliedRows.length > 0
            ? appliedRows[appliedRows.length - 1].to_hash
            : shapeHash(options.baseline);

          let expectedFrom = currentShape;
          for (const migration of pending) {
            checkMigrationDocument(migration);
            checkPreservationPlan(migration);
            if (migration.from !== expectedFrom) {
              throw refuse('JD0020',
                `migration '${migration.id}' expects shape '${migration.from}' but the `
                + `database is at '${expectedFrom}' — refusing to run against the wrong shape`);
            }
            expectedFrom = migration.to;
          }
          if (options.model !== undefined && pending.length > 0
            && expectedFrom !== shapeHash(options.model)) {
            throw refuse('JD0020',
              "the last migration's to-hash is not the target model's shape — the "
              + 'migration chain and the code disagree about where this ends');
          }

          if (pending.length === 0) {
            return { applied: [], skipped: appliedRows.map((row) => row.id), upToDate: true };
          }

          if (pending.some((m) => m.physical) && options.shadow !== false)
            throw refuse('JD0021', 'physical preservation plans require shadow:false; qualify against an explicit copy/fresh-target fixture');
          const shadowRun = options.shadow === false
            ? null
            : replayOnShadow(options.shadowDriver ?? target.driver,
              options.shadowPath ?? ':memory:',
              options.baseline, migrations, options.model, runOptions);

          return chain(shadowRun, () => {
            if (options.dryRun === true) {
              const rendered = [];
              const counts = {};
              const collect = (i) => {
                if (i >= pending.length) return null;
                const migration = pending[i];
                for (const migrationStep of migration.steps) {
                  if (migrationStep.kind === 'ddl') rendered.push(migrationStep.sql);
                  else if (migrationStep.kind === 'sql') {
                    rendered.push(`-- data step (sql): ${migrationStep.note ?? ''}`);
                    rendered.push(migrationStep.sql);
                  }
                  else if (migrationStep.kind === 'rebuild') {
                    rendered.push(`-- rebuild '${migrationStep.table}' (§10 procedure)`);
                    rendered.push(...migrationStep.create, migrationStep.copy,
                      dialect.ddl.dropTable(migrationStep.table),
                      dialect.ddl.renameTable(`${migrationStep.table}__rebuild`,
                        migrationStep.table),
                      ...migrationStep.indexes);
                    if (dialect.capabilities.foreignKeysAlwaysOn !== true)
                      rendered.push(dialect.pragma.foreignKeyCheck());
                  }
                  else if (migrationStep.kind === 'jslt')
                    rendered.push(`-- jslt transform over '${migrationStep.collection}'`);
                  else {
                    const operation = compileDocumentStep(migrationStep, migration.steps.indexOf(migrationStep), {
                      migrationId: migration.id, compileJslt: compileJsltStylesheet, compileQuery: compileJsonQuery,
                      assertionBounds: runOptions.assertionBounds,
                    });
                    const strategy = assertionProvider(migrationStep.assert, migrationStep.collection, operation.shape) === null
                      ? operation.strategy : 'provider';
                    rendered.push(`-- assert over '${migrationStep.collection}' (${strategy}; ${operation.reason})`);
                  }
                }
                const jsltCollections = [...new Set(migration.steps
                  .filter((s) => s.kind === 'jslt').map((s) => s.collection))];
                const count = (j) => {
                  if (j >= jsltCollections.length) return null;
                  const table = jsltCollections[j];
                  const countSql = `SELECT COUNT(*) AS ${dialect.quoteIdentifier('n')} `
                    + `FROM ${dialect.quoteIdentifier(table)}`;
                  return chain(connection.prepare(countSql), (statement) =>
                    chain(statement.get([]), (row) => {
                      counts[table] = row.n;
                      return count(j + 1);
                    }));
                };
                return chain(count(0), () => collect(i + 1));
              };
              return chain(collect(0), () => ({
                dryRun: true,
                pending: pending.map((migration) => migration.id),
                statements: rendered,
                counts,
                shadowValidated: options.shadow !== false,
              }));
            }

            // the real run: one exclusive transaction per migration
            const applied = [];
            const applyNext = (i) => {
              if (i >= pending.length) return null;
              // the boundary between migrations
              check();
              const migration = pending[i];
              const last = i === pending.length - 1;
              // the §10 procedure's pragma bracket, literally: the
              // foreign_keys pragma is a no-op inside a transaction,
              // and node:sqlite enables enforcement BY DEFAULT — a
              // parent-table rebuild could not even DROP without this
              const bracket = migration.steps.some(
                (candidate) => candidate.kind === 'rebuild');
              return chain(
                bracket && dialect.capabilities.foreignKeysAlwaysOn !== true
                  ? connection.exec(dialect.pragma.foreignKeys(false)) : null,
                () => chain(connection.exec(dialect.tx.beginImmediate), () => {
                const body = () => chain(migration.physical ? verifyPreservation(connection, migration.physical, false) : null, () =>
                  chain(historyExists ? null : connection.exec(statements.create), () =>
                  chain(runSteps(connection, migration, runOptions), () =>
                  chain(migration.physical ? verifyPreservation(connection, migration.physical, true) : null, () =>
                  chain(last && options.model !== undefined
                    ? chain(validateTargetState(connection, options.model,
                      { compileSchema: options.compileSchema, batchSize }),
                    () => (normalizeEntities(options.model).size === 0 || migration.physical ? null
                      : chain(compareShapeToModel(target.driver, connection,
                        options.model, options.registerFunctions), (difference) => {
                        if (difference !== null) {
                          throw refuse('JD0023',
                            `the migrated shape does not equal the target model's: ${difference}`);
                        }
                        return null;
                      })))
                    : null,
                  () => chain(connection.prepare(statements.insert), (insert) =>
                    insert.run([migration.id, runtime.now(), migration.from,
                      migration.to, migrationChecksum(migration),
                      migration.steps.length])))))));
                const restore = () => (bracket
                  && dialect.capabilities.foreignKeysAlwaysOn !== true
                  ? connection.exec(dialect.pragma.foreignKeys(true)) : null);
                const rollback = (error) =>
                  chain(connection.exec(dialect.tx.rollback), () =>
                    chain(restore(), () => { throw error; }));
                // only body() may route to this migration's rollback:
                // commit() chains the NEXT migration, whose failure
                // rolls ITSELF back — catching it here would roll
                // back a transaction that already committed
                let outcome;
                try {
                  outcome = body();
                }
                catch (error) {
                  return rollback(error);
                }
                const settle = () => {
                  let result;
                  try { result = connection.exec(dialect.tx.commit); }
                  catch (error) { return rollback(error); }
                  return result instanceof Promise ? result.then(published, rollback) : published();
                };
                const published = () => chain(restore(), () => {
                  historyExists = true; applied.push(migration.id); return applyNext(i + 1);
                });
                return outcome instanceof Promise ? outcome.then(settle, rollback) : settle();
              }));
            };
            return chain(applyNext(0), () => ({
              applied,
              skipped: appliedRows.map((row) => row.id),
              shape: expectedFrom,
            }));
          });
        });

      }
      catch (error) {
        return failClosed(error);
      }
      return work instanceof Promise
        ? work.then(finish, failClosed)
        : finish(work);
    })));
}

/** Plan an existing file's explicit preservation migration. Every source object
 * needs a disposition; source/target assertions preserve application-owned facts.
 * @param {any} connection @param {any} fromModel @param {any} toModel
 * @param {{ id: string, steps: any[], dispositions: Record<string, 'preserve'|'replace'|'drop'>,
 *   assertions?: { sql: string, params?: any[], expected: any[] }[] }} options @returns {any} */
export function planPhysicalMigration(connection, fromModel, toModel, options) {
  normalizeEntities(fromModel); normalizeEntities(toModel);
  if (!options || typeof options.id !== 'string' || !options.id || !Array.isArray(options.steps))
    throw refuse('JD0021', 'a physical plan requires id and explicit steps');
  return chain(preservationSchemaOf(connection), (source) => {
    const dispositions = options.dispositions ?? {};
    const keys = source.map((o) => `${o.type}:${o.name}`);
    if (Object.keys(dispositions).some((key) => !keys.includes(key)) || keys.some((key) => !['preserve', 'replace', 'drop'].includes(dispositions[key])))
      throw refuse('JD0021', 'every physical source object must have an explicit preserve, replace or drop disposition');
    const assertions = options.assertions ?? [];
    for (const assertion of assertions) {
      if (!assertion || typeof assertion.sql !== 'string' || !/^SELECT\b/i.test(assertion.sql.trim()) || !Array.isArray(assertion.expected))
        throw refuse('JD0021', 'preservation assertions require a SELECT and expected rows');
    }
    const migration = { $migration: MIGRATION_VERSION, id: options.id, from: shapeHash(fromModel), to: shapeHash(toModel),
      steps: options.steps, physical: { source, dispositions, assertions } };
    checkMigrationDocument(migration);
    checkPreservationPlan(migration);
    return migration;
  });
}

/** Validate saved plans again at execution, including SQL ownership boundaries. */
function checkPreservationPlan(migration) {
  const physical = migration.physical;
  if (physical === undefined) return;
  const fail = () => { throw refuse('JD0021', 'invalid physical source, dispositions, assertions or steps'); };
  if (!physical || !Array.isArray(physical.source) || !physical.dispositions || !Array.isArray(physical.assertions)) fail();
  const keys = physical.source.map((object) => {
    if (!object || typeof object.name !== 'string' || !['table', 'view', 'index', 'trigger'].includes(object.type)) fail();
    return `${object.type}:${object.name}`;
  });
  if (new Set(keys).size !== keys.length || Object.keys(physical.dispositions).some((key) => !keys.includes(key))
    || keys.some((key) => !['preserve', 'replace', 'drop'].includes(physical.dispositions[key]))) fail();
  for (const assertion of physical.assertions)
    if (!assertion || typeof assertion.sql !== 'string' || !/^SELECT\b/i.test(assertion.sql.trim())
      || !Array.isArray(assertion.expected) || (assertion.params !== undefined && !Array.isArray(assertion.params))) fail();
  if (migration.steps.some((step) => !['ddl', 'sql', 'rebuild'].includes(step.kind))) fail();
  const fragments = migration.steps.flatMap((step) => step.kind === 'rebuild'
    ? [...(step.create ?? []), step.copy, ...(step.indexes ?? [])] : [step.sql]);
  for (const sql of fragments) {
    const tokens = typeof sql === 'string' ? sqlTokens(sql) : [];
    const words = tokens.filter((t) => t.kind === 'word').map((t) => t.value.toUpperCase());
    if (!['CREATE', 'ALTER', 'DROP', 'INSERT', 'UPDATE', 'DELETE'].includes(words[0])
      || words.some((w) => /^(?:COMMIT|ROLLBACK|SAVEPOINT|RELEASE|ATTACH|DETACH|PRAGMA|VACUUM)$/.test(w)))
      throw refuse('JD0021', 'physical steps cannot change transaction or connection ownership');
  }
}

/** Preservation compares exact source programs, including whitespace in SQL literals. */
function preservationSchemaOf(connection) {
  return chain(readSchema(connection), (schema) => schema.objects
    .filter((object) => !ENGINE_TABLES.has(object.name) && !ENGINE_TABLES.has(object.owner)));
}

/** Verify source identity before destructive steps, and every preserved object
 * and fact before publication. The migration transaction owns all these reads. */
function verifyPreservation(connection, physical, after) {
  return chain(preservationSchemaOf(connection), (actual) => {
    if (!after && canonicalizeJson(actual) !== canonicalizeJson(physical.source))
      throw refuse('JD0020', 'the physical source schema changed after the plan was prepared');
    if (after) {
      for (const object of physical.source) {
        const key = `${object.type}:${object.name}`;
        const current = actual.find((o) => o.type === object.type && o.name === object.name);
        if (physical.dispositions[key] === 'preserve' && canonicalizeJson(current ?? null) !== canonicalizeJson(object))
          throw refuse('JD0023', `preserved object '${key}' was changed or lost`);
        if (physical.dispositions[key] === 'drop' && current) throw refuse('JD0023', `declared drop '${key}' remains`);
      }
    }
    const next = (i) => i >= physical.assertions.length ? null
      : chain(connection.prepare(physical.assertions[i].sql, { readOnly: true }), (s) =>
        chain(s.all(physical.assertions[i].params ?? []), (rows) => {
          if (canonicalizeJson(rows) !== canonicalizeJson(physical.assertions[i].expected))
            throw refuse('JD0023', `preservation assertion ${i} disagrees ${after ? 'after' : 'before'} migration`);
          return next(i + 1);
        }));
    return next(0);
  });
}
