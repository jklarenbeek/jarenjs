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
import { compileJsonQuery } from '@jarenjs/json/query';
import { compileJsltStylesheet } from '@jarenjs/json/jslt';

import { DbCompileError } from './errors.js';
import { chain, toPromise } from './driver.js';
import { normalizeModel } from './store.js';
import { planCollection, verifyShape, planEntity, planJoinTable } from './ddl.js';
import { normalizeEntities, explainMapping } from './model.js';
import { derivedValue, memberAt, registerDeriveFunctions } from './derive.js';

/**
 * The physical mapping a connection's driver imposes on derived index
 * columns. A driver that can index a registered deterministic function
 * generates them; one that cannot has them written, which is why the
 * planner emits a backfill for the second and not the first.
 * @param {any} connection
 * @returns {{ derived: 'virtual' | 'stored' }}
 */
function mappingFor(connection) {
  return {
    derived: connection.capabilities?.deterministicIndexableFunctions === true
      ? 'virtual' : 'stored',
  };
}

/** The migration format version. */
export const MIGRATION_VERSION = '0.1';

/** The history table name (outside the model's identifier namespace
 * conventions on purpose — a collection cannot collide with it). */
export const HISTORY_TABLE = '_jaren_migrations';

/**
 * The signature-grade identity of a model SHAPE.
 * @param {any} model - A jaren-model document
 * @returns {string}
 */
export function shapeHash(model) {
  return hashContent(canonicalizeJson(model));
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
 *   derived?: 'virtual' | 'stored' }} [options]
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
  const mapping = { derived: options?.derived ?? 'virtual' };
  const fromCollections = normalizeModel(fromModel);
  const toCollections = normalizeModel(toModel);

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

  for (const [name] of fromCollections) {
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
    for (const joinName of Object.keys(fromMapping.joinTables)) {
      const pair = joinName.split('_');
      if (!pair.includes(hint)) continue;
      const renamedPair = pair.map((part) => (part === hint ? name : part)).sort();
      const newJoin = renamedPair.join('_');
      if (newJoin !== joinName) {
        steps.push({ kind: 'ddl', sql: dialect.ddl.renameTable(joinName, newJoin),
          note: `rename join table '${joinName}' with its endpoint` });
        steps.push({ kind: 'ddl',
          sql: dialect.ddl.renameColumn(newJoin, `${hint}_key`, `${name}_key`),
          note: `rename the endpoint column '${hint}_key' with its entity` });
      }
    }
  }
  const consumedOldEntities = new Set(renamedFrom.values());
  const renamedJoinName = (joinName) => {
    const pair = joinName.split('_');
    return pair
      .map((part) => {
        for (const [to, from] of renamedFrom) if (from === part) return to;
        return part;
      })
      .sort().join('_');
  };

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

  // ————— dropped entities —————
  for (const [name] of fromEntities) {
    if (toEntities.has(name) || consumedOldEntities.has(name)) continue;
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
  for (const { name: columnName, column } of ordered) {
    targets.push(q(columnName));
    if (fromHas(columnName)) {
      const fromColumn = fromColumns.get(columnName);
      const sameStorage = column === null || fromColumn === undefined
        || fromColumn.storage === column.storage;
      if (column !== null && column.source === 'epoch(document)'
        && fromColumn !== undefined && fromColumn.source !== 'epoch(document)') {
        // plain text column becomes a derived instant: derive from the
        // old column and keep the string in the document
        sources.push(dialect.epochFromRfc3339(q(columnName)));
        docExpr = dialect.jsonSet(docExpr, pathText(columnName), q(columnName));
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
      docExpr = dialect.jsonSet(docExpr, pathText(columnName), fold);
    }
    else if (fromColumn.source !== 'epoch(document)') {
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
 * @returns {any} value-or-promise
 */
export function createModelShape(connection, model) {
  const dialect = connection.dialect;
  /** @type {string[]} */
  const statements = [];
  for (const collection of normalizeModel(model).values()) {
    statements.push(
      ...planCollection(collection.name, collection, dialect, mappingFor(connection)).createSql);
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
 * history table excluded, sorted. Shape equality after a migration —
 * this dump versus a fresh {@link createModelShape} — is the
 * acceptance criterion for every rebuild.
 * @param {any} connection
 * @returns {any} value-or-promise of `{ type, name, owner, sql }[]`
 */
export function schemaShapeOf(connection) {
  const dialect = connection.dialect;
  return chain(connection.prepare(dialect.introspect.schemaDump()), (statement) =>
    chain(statement.all([]), (rows) => rows
      .filter((row) => row.name !== HISTORY_TABLE && row.owner !== HISTORY_TABLE)
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
export function compareShapeToModel(driver, connection, model, registerFunctions) {
  return chain(driver.open(':memory:', {}), (reference) =>
    chain(chain(registerDeriveFunctions(reference),
      () => (registerFunctions !== undefined ? registerFunctions(reference) : null)), () => {
      const finish = (result) => chain(reference.close(), () => result);
      let outcome;
      try {
        outcome = chain(createModelShape(reference, model), () =>
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

const STEP_KINDS = new Set(['ddl', 'jslt', 'query', 'sql', 'rebuild', 'derive']);

/**
 * Structural validation of one migration document, including the
 * draft refusal (`JD0021`).
 * @param {any} migration
 */
function checkMigrationDocument(migration) {
  if (migration === null || typeof migration !== 'object'
    || migration.$migration !== MIGRATION_VERSION
    || typeof migration.id !== 'string' || migration.id === ''
    || typeof migration.from !== 'string' || typeof migration.to !== 'string'
    || !Array.isArray(migration.steps)) {
    throw refuse('JD0023',
      `migration '${migration?.id ?? '<unknown>'}' is not a valid ${MIGRATION_VERSION} migration document`);
  }
  for (let i = 0; i < migration.steps.length; i++) {
    const step = migration.steps[i];
    if (step === null || typeof step !== 'object' || !STEP_KINDS.has(step.kind)) {
      throw refuse('JD0023',
        `migration '${migration.id}' step ${i} has no recognised kind`);
    }
    if (step.kind === 'rebuild'
      && (typeof step.table !== 'string' || !Array.isArray(step.create)
        || typeof step.copy !== 'string' || !Array.isArray(step.indexes))) {
      throw refuse('JD0023',
        `migration '${migration.id}' step ${i} is a rebuild without its rendered `
        + 'table/create/copy/indexes');
    }
    if (step.kind === 'sql' && typeof step.sql !== 'string') {
      throw refuse('JD0023',
        `migration '${migration.id}' step ${i} is a sql step without sql text`);
    }
    if (step.kind === 'derive'
      && (typeof step.collection !== 'string' || !Array.isArray(step.columns)
        || step.columns.length === 0)) {
      throw refuse('JD0023',
        `migration '${migration.id}' step ${i} is a derive backfill without its columns`);
    }
    if (step.kind === 'jslt' && step.draft === true) {
      throw refuse('JD0021',
        `migration '${migration.id}' step ${i} is a DRAFT transform for collection `
        + `'${step.collection}' — the planner cannot infer a data transform; fill in `
        + 'the stylesheet (or delete the step for a pure widening) and remove "draft"');
    }
  }
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
 * @returns {any}
 */
function walkRows(connection, table, batchSize, handle, keyed = true) {
  // entity tables carry no 'key' column — the transform walk goes by
  // row identity alone; only the collection walks select the key
  const dialect = connection.dialect;
  const q = dialect.quoteIdentifier;
  const rid = dialect.rowIdentity();
  const keySelect = keyed ? `, ${q('key')} AS ${q('k')}` : '';
  const sql = `SELECT ${rid} AS ${q('rid')}, ${dialect.jsonText(q('doc'))} AS ${q('doc')}`
    + `${keySelect} FROM ${q(table)} WHERE ${rid} > ${dialect.parameterRef(1, 'after')} `
    + `ORDER BY ${rid} ${dialect.limitClause(batchSize, undefined)}`;
  return chain(connection.prepare(sql), (statement) => {
    const nextBatch = (after) =>
      chain(statement.all([after]), (rows) => {
        if (rows.length === 0) return null;
        return chain(handle(rows), () =>
          nextBatch(rows[rows.length - 1].rid));
      });
    return nextBatch(-1);
  });
}

/** All documents of a collection (the assertion steps' working set —
 * a documented whole-collection read). */
function allDocs(connection, table) {
  const dialect = connection.dialect;
  const q = dialect.quoteIdentifier;
  const sql = `SELECT ${dialect.jsonText(q('doc'))} AS ${q('doc')} FROM ${q(table)} `
    + `ORDER BY ${dialect.rowIdentity()}`;
  return chain(connection.prepare(sql), (statement) =>
    chain(statement.all([]), (rows) => rows.map((row) => JSON.parse(row.doc))));
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
    const current = migration.steps[i];
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
          }, false), () => derivedRows));
      }
      if (current.kind === 'jslt') {
        let transform;
        try {
          transform = compileJsltStylesheet(current.stylesheet);
        }
        catch (cause) {
          return fail(`the stylesheet does not compile: ${/** @type {Error} */ (cause).message}`,
            /** @type {Error} */ (cause));
        }
        const updateSql = `UPDATE ${q(current.collection)} SET ${q('doc')} = `
          + `${dialect.jsonEncode(dialect.parameterRef(1, 'doc'))} `
          + `WHERE ${dialect.rowIdentity()} = ${dialect.parameterRef(2, 'rid')}`;
        let transformed = 0;
        const keyed = false;
        return chain(connection.prepare(updateSql), (update) =>
          chain(walkRows(connection, current.collection, options.batchSize, (rows) => {
            for (const row of rows) {
              const next = transform(JSON.parse(row.doc));
              if (next === null || typeof next !== 'object' || Array.isArray(next))
                fail(`the transform produced a non-document for row ${row.rid}`);
              update.run([JSON.stringify(next), row.rid]);
              transformed++;
            }
            options.onProgress?.({
              migration: migration.id,
              collection: current.collection,
              transformed,
            });
          }, keyed), () => transformed));
      }
      // kind === 'query': the assertion step
      let compiled;
      try {
        compiled = compileJsonQuery(current.assert);
      }
      catch (cause) {
        return fail(`the assertion does not compile: ${/** @type {Error} */ (cause).message}`,
          /** @type {Error} */ (cause));
      }
      return chain(allDocs(connection, current.collection), (docs) => {
        if (current.expect === 'ebv') {
          if (!compiled.ebv(docs)) fail('the EBV assertion answered false');
          return null;
        }
        const result = compiled(docs);
        if (result !== undefined) {
          const count = Array.isArray(result) ? result.length : 1;
          fail(`the assertion expected an empty sequence, got ${count} item(s)`);
        }
        return null;
      });
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
  const collections = [...normalizeModel(model).values()];
  const entities = [...normalizeEntities(model).values()];
  const dialect = connection.dialect;
  const q = dialect.quoteIdentifier;
  // entity tables carry no 'key' column; the batched walk goes by row
  // identity and validates every stored document against the target
  const verifyEntity = (i) => {
    if (i >= entities.length) return null;
    const entity = entities[i];
    const validate = options.compileSchema !== undefined
      ? options.compileSchema(entity.schema)
      : null;
    if (validate === null) return verifyEntity(i + 1);
    const rid = dialect.rowIdentity();
    const sql = `SELECT ${rid} AS ${q('rid')}, ${dialect.jsonText(q('doc'))} AS ${q('doc')} `
      + `FROM ${q(entity.name)} WHERE ${rid} > ${dialect.parameterRef(1, 'after')} `
      + `ORDER BY ${rid} ${dialect.limitClause(options.batchSize, undefined)}`;
    return chain(connection.prepare(sql), (statement) => {
      const nextBatch = (after) =>
        chain(statement.all([after]), (rows) => {
          if (rows.length === 0) return null;
          for (const row of rows) {
            const outcome = validate(JSON.parse(row.doc));
            const valid = outcome === true || outcome?.valid === true;
            if (!valid) {
              throw refuse('JD0021',
                `entity '${entity.name}': a stored document (row ${row.rid}) does not `
                + 'validate against the target schema — a narrowing needs a data transform');
            }
          }
          return nextBatch(rows[rows.length - 1].rid);
        });
      return nextBatch(-1);
    });
  };
  const verifyNext = (i) => {
    if (i >= collections.length) return null;
    const collection = collections[i];
    const plan = planCollection(collection.name, collection, dialect, mappingFor(connection));
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
      const bracket = migrations[i].steps.some(
        (candidate) => candidate.kind === 'rebuild');
      return chain(
        bracket ? shadow.exec(shadow.dialect.pragma.foreignKeys(false)) : null,
        () => chain(runSteps(shadow, migrations[i], options), () =>
          chain(bracket ? shadow.exec(shadow.dialect.pragma.foreignKeys(true)) : null,
            () => apply(i + 1))));
    };
    const run = () => chain(registered, () =>
      chain(createModelShape(shadow, baseline), () => chain(apply(0), () => {
        if (model === undefined) return null;
        const target = [...normalizeModel(model).values()];
        const verifyNext = (i) => {
          if (i >= target.length) return null;
          const plan = planCollection(target[i].name, target[i], shadow.dialect,
            mappingFor(shadow));
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
 * Report a database's migration state without touching it: what is
 * applied, what is pending, whether an applied migration was edited,
 * and — once the chain is fully applied — whether the physical shape
 * DRIFTED from the model (someone changed the database by hand, §12).
 * @param {{ driver: any, path?: string }} target
 * @param {any[]} migrations - the full ordered list
 * @param {{ baseline: any, model?: any,
 *   registerFunctions?: (connection: any) => any }} options
 * @returns {Promise<{ applied: string[], pending: string[],
 *   drift: string | null, upToDate: boolean }>}
 */
export function migrationStatus(target, migrations, options) {
  return toPromise(chain(
    target.driver.open(target.path ?? ':memory:', {}),
    (connection) => {
      const dialect = connection.dialect;
      const statements = historyStatements(dialect);
      const finish = (result) => chain(connection.close(), () => result);
      const failClosed = (error) => chain(connection.close(), () => { throw error; });
      let work;
      try {
        work = chain(registerDeriveFunctions(connection), () =>
          chain(connection.exec(statements.create), () =>
          chain(connection.prepare(statements.select), (select) =>
            chain(select.all([]), (rows) => {
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
            }))));
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
 *   shadow?: boolean, shadowPath?: string }} options
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
  const runOptions = {
    batchSize,
    onProgress: options.onProgress,
    registerFunctions: options.registerFunctions,
  };

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
        work = chain(connection.exec(statements.create), () =>
        chain(connection.prepare(statements.select), (select) =>
          chain(select.all([]), (appliedRows) => {
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

            const shadowRun = options.shadow === false
              ? null
              : replayOnShadow(target.driver, options.shadowPath ?? ':memory:',
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
                        ...migrationStep.indexes,
                        dialect.pragma.foreignKeyCheck());
                    }
                    else if (migrationStep.kind === 'jslt')
                      rendered.push(`-- jslt transform over '${migrationStep.collection}'`);
                    else rendered.push(`-- assert over '${migrationStep.collection}'`);
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
                const migration = pending[i];
                const last = i === pending.length - 1;
                // the §10 procedure's pragma bracket, literally: the
                // foreign_keys pragma is a no-op inside a transaction,
                // and node:sqlite enables enforcement BY DEFAULT — a
                // parent-table rebuild could not even DROP without this
                const bracket = migration.steps.some(
                  (candidate) => candidate.kind === 'rebuild');
                return chain(
                  bracket ? connection.exec(dialect.pragma.foreignKeys(false)) : null,
                  () => chain(connection.exec(dialect.tx.beginImmediate), () => {
                  const body = () => chain(runSteps(connection, migration, runOptions), () =>
                    chain(last && options.model !== undefined
                      ? chain(validateTargetState(connection, options.model,
                        { compileSchema: options.compileSchema, batchSize }),
                      () => (normalizeEntities(options.model).size === 0 ? null
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
                      insert.run([migration.id, Date.now(), migration.from,
                        migration.to, migrationChecksum(migration),
                        migration.steps.length]))));
                  const restore = () => (bracket
                    ? connection.exec(dialect.pragma.foreignKeys(true)) : null);
                  const commit = () => chain(connection.exec(dialect.tx.commit), () =>
                    chain(restore(), () => {
                      applied.push(migration.id);
                      return applyNext(i + 1);
                    }));
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
                  return outcome instanceof Promise
                    ? outcome.then(commit, rollback)
                    : commit();
                }));
              };
              return chain(applyNext(0), () => ({
                applied,
                skipped: appliedRows.map((row) => row.id),
                shape: expectedFrom,
              }));
            });
          })));

      }
      catch (error) {
        return failClosed(error);
      }
      return work instanceof Promise
        ? work.then(finish, failClosed)
        : finish(work);
    })));
}
