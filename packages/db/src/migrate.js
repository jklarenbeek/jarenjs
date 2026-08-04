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
import { planCollection, verifyShape } from './ddl.js';

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
 * Plan a migration between two model documents. The planner diffs the
 * PHYSICAL plans (columns, indexes) and renders DDL through the
 * dialect; a changed schema gets a DRAFT identity transform that
 * refuses to run until the author fills it in — the planner cannot
 * infer a data transform and does not pretend to. Renames are declared
 * (`x-rename` on the target collection), never guessed.
 * @param {any} fromModel
 * @param {any} toModel
 * @param {{ id?: string, dialect?: any }} [options]
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
      for (const sql of planCollection(name, toCollection, dialect).createSql)
        steps.push({ kind: 'ddl', sql, note: `create collection '${name}'` });
      continue;
    }

    // the from-side physical facts live under the RENAMED table: same
    // columns, but index names still carry the old collection prefix
    const fromPlan = planCollection(oldName, fromCollection, dialect);
    const toPlan = planCollection(name, toCollection, dialect);
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

    const columnChanged = (a, b) => a.type !== b.type || a.pathText !== b.pathText;
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
    for (const [columnName, toColumn] of toColumns) {
      const source = fromColumns.get(columnName);
      if (source === undefined || columnChanged(source, toColumn)) {
        steps.push({
          kind: 'ddl',
          sql: dialect.ddl.addGeneratedColumn(
            { table: name, docColumn: toPlan.docColumn, column: toColumn }),
          note: `add generated column '${columnName}' on '${name}'`,
        });
      }
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

  const migration = {
    $migration: MIGRATION_VERSION,
    id: options?.id ?? `to-${shapeHash(toModel).slice(0, 8)}`,
    from: shapeHash(fromModel),
    to: shapeHash(toModel),
    steps,
  };
  return { migration, report };
}

const STEP_KINDS = new Set(['ddl', 'jslt', 'query']);

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
function walkRows(connection, table, batchSize, handle) {
  const dialect = connection.dialect;
  const q = dialect.quoteIdentifier;
  const rid = dialect.rowIdentity();
  const sql = `SELECT ${rid} AS ${q('rid')}, ${dialect.jsonText(q('doc'))} AS ${q('doc')}, `
    + `${q('key')} AS ${q('k')} FROM ${q(table)} WHERE ${rid} > ${dialect.parameterRef(1, 'after')} `
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
      if (current.kind === 'ddl') {
        try {
          return connection.exec(current.sql);
        }
        catch (cause) {
          return fail(/** @type {Error} */ (cause).message, /** @type {Error} */ (cause));
        }
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
          }), () => transformed));
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
  const dialect = connection.dialect;
  const verifyNext = (i) => {
    if (i >= collections.length) return null;
    const collection = collections[i];
    const plan = planCollection(collection.name, collection, dialect);
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
  return verifyNext(0);
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
    const collections = [...normalizeModel(baseline).values()];
    const create = (i) => {
      if (i >= collections.length) return null;
      const sqls = planCollection(collections[i].name, collections[i], shadow.dialect).createSql;
      const run = (j) => (j >= sqls.length
        ? null
        : chain(shadow.exec(sqls[j]), () => run(j + 1)));
      return chain(run(0), () => create(i + 1));
    };
    const apply = (i) => {
      if (i >= migrations.length) return null;
      return chain(runSteps(shadow, migrations[i], options), () => apply(i + 1));
    };
    const run = () => chain(create(0), () => chain(apply(0), () => {
      if (model === undefined) return null;
      const target = [...normalizeModel(model).values()];
      const verifyNext = (i) => {
        if (i >= target.length) return null;
        const plan = planCollection(target[i].name, target[i], shadow.dialect);
        return chain(
          verifyShape(shadow, plan, target[i].name, target[i].docPath),
          () => verifyNext(i + 1));
      };
      return verifyNext(0);
    }));
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
  const runOptions = { batchSize, onProgress: options.onProgress };

  return toPromise(chain(
    target.driver.open(target.path ?? ':memory:', { timeout: target.busyTimeout ?? 5000 }),
    (connection) => {
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
                return chain(connection.exec(dialect.tx.beginImmediate), () => {
                  const body = () => chain(runSteps(connection, migration, runOptions), () =>
                    chain(last && options.model !== undefined
                      ? validateTargetState(connection, options.model,
                        { compileSchema: options.compileSchema, batchSize })
                      : null,
                    () => chain(connection.prepare(statements.insert), (insert) =>
                      insert.run([migration.id, Date.now(), migration.from,
                        migration.to, migrationChecksum(migration),
                        migration.steps.length]))));
                  const commit = () => chain(connection.exec(dialect.tx.commit), () => {
                    applied.push(migration.id);
                    return applyNext(i + 1);
                  });
                  const rollback = (error) =>
                    chain(connection.exec(dialect.tx.rollback), () => { throw error; });
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
                });
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
    }));
}
