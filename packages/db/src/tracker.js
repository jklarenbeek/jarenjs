//@ts-check
/**
 * @file The unit of work (§11): copy-on-write change tracking and
 * minimal writes. Materialised entities are plain, DEEP-FROZEN JSON —
 * no proxies anywhere — and the tracker retains exactly ONE reference
 * per tracked entity: the frozen document itself is the snapshot.
 * Mutation is replacement (`put(next)`); `saveChanges()` diffs
 * snapshot against current with the suite's own diff engine and plans
 * the MINIMAL set of parameterised statements: scalar/epoch/foreign-
 * key column writes, `jsonb_set`/`jsonb_remove` chains for document
 * paths, join-table synchronisation for many-to-many members, and a
 * counted whole-row fallback for anything untranslatable.
 *
 * Ordering never violates a foreign key mid-transaction: inserts run
 * parent-first, deletes child-first, updates in between, join rows
 * after both endpoints exist. A foreign-key cycle among the entities
 * being inserted or deleted is `JD0040`, reported, never a deadlock.
 * The whole save is one transaction; the tracker is mutated ONLY
 * after commit, so a failed save leaves it exactly as it was and a
 * retry is possible.
 */

import { createJSONPatch } from '@jarenjs/json/patch';
import { parseJSONPointer } from '@jarenjs/json/pointer';

import { DbCompileError, DbRuntimeError } from './errors.js';
import { chain } from './driver.js';
import { translatePatch } from './patch-sql.js';

/** Rows per batched INSERT: bounded by the portable parameter budget. */
export const BATCH_PARAM_BUDGET = 900;
export const BATCH_ROW_BOUND = 100;

const UNIT_SEPARATOR = '';

/**
 * Deep-freeze a JSON value in place and return it. Idempotent; shared
 * substructure (a graph load's children) freezes once.
 * @template T
 * @param {T} value
 * @returns {T}
 */
export function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value))
    return value;
  Object.freeze(value);
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
    return value;
  }
  for (const key of Object.keys(value)) deepFreeze(/** @type {any} */ (value)[key]);
  return value;
}

/**
 * The store-level unit of work.
 * @param {{ connection: any, entities: Map<string, any>, mapping: any,
 *   coreFor: (name: string) => any }} context
 * @returns {any}
 */
export function createTracker(context) {
  const { connection, entities, mapping, coreFor } = context;
  const captureRecord = context.captureRecord ?? null;
  const captureJoinDelete = context.captureJoinDelete ?? null;
  const dialect = connection.dialect;
  const q = dialect.quoteIdentifier;
  const parameterAt = (i) => dialect.parameterRef(i, 'v');

  /** @type {Map<string, any>} */
  const records = new Map();
  /** @type {Map<string, any>} */
  const removals = new Map();
  let pendingSequence = 0;

  const keyOf = (entityName, parts) =>
    `${entityName}${UNIT_SEPARATOR}${parts.join(UNIT_SEPARATOR)}`;

  const recordKeyFor = (entityName, doc) => {
    const plan = coreFor(entityName).plan;
    const parts = plan.keys.map((k) => doc[k]);
    if (parts.some((part) => typeof part !== 'string' && typeof part !== 'number'))
      return null;
    return keyOf(entityName, parts);
  };

  const contractError = (entityName, reason) => new DbRuntimeError('JD2003',
    reason, {
      docPath: entities.get(entityName)?.docPath ?? '/entities',
      collection: entityName,
    });

  const register = (entityName, doc) => {
    deepFreeze(doc);
    const key = recordKeyFor(entityName, doc);
    if (key === null) return doc; // no usable key — plain data
    const existing = records.get(key);
    // a re-read refreshes a CLEAN record; a dirty record stays
    // authoritative for the save in flight (§11.1)
    if (existing === undefined
      || (existing.current === existing.snapshot && existing.pendingInsert !== true)) {
      records.set(key, {
        entity: entityName, snapshot: doc, current: doc, pendingInsert: false,
      });
    }
    return doc;
  };

  /** Register a graph load: the root and every included child. */
  const registerGraph = (tree, docs) => {
    const walk = (node, doc) => {
      register(node.entity.name, doc);
      for (const include of node.includes) {
        if (include.count === true) continue;
        const value = doc[include.name];
        if (include.many) {
          for (const child of value ?? []) walk(include.child, child);
        }
        else if (value !== null && value !== undefined) {
          walk(include.child, value);
        }
      }
    };
    for (const doc of docs) walk(tree, doc);
    return docs;
  };

  const add = (entityName, doc) => {
    const core = coreFor(entityName);
    const completed = deepFreeze(core.complete(doc, { updating: false }));
    const key = recordKeyFor(entityName, completed)
      ?? `${entityName}${UNIT_SEPARATOR}#pending${pendingSequence++}`;
    records.set(key, {
      entity: entityName, snapshot: null, current: completed,
      pendingInsert: true, pendingKey: key,
    });
    return completed;
  };

  const put = (entityName, next) => {
    const core = coreFor(entityName);
    if (next === null || typeof next !== 'object' || Array.isArray(next))
      throw contractError(entityName, 'put() takes an entity document');
    const key = recordKeyFor(entityName, next);
    const record = key === null ? undefined : records.get(key);
    if (record === undefined) {
      throw new DbRuntimeError('JD2006',
        `'${entityName}' is not tracked under that key — read it first, `
        + 'add() it, or use the explicit update()',
        { docPath: entities.get(entityName)?.docPath, collection: entityName });
    }
    core.validateOnly(next);
    record.current = deepFreeze(next);
    return record.current;
  };

  const remove = (entityName, keyOrDoc) => {
    const core = coreFor(entityName);
    const parts = core.normalizeKey(keyOrDoc);
    const key = keyOf(entityName, parts);
    const record = records.get(key);
    if (record !== undefined && record.pendingInsert === true) {
      records.delete(key); // added then removed: a no-op
      return;
    }
    removals.set(key, {
      entity: entityName,
      parts,
      snapshot: record?.snapshot ?? null,
    });
  };

  const counts = () => {
    let pendingInserts = 0;
    for (const record of records.values()) {
      if (record.pendingInsert === true) pendingInserts++;
    }
    return {
      tracked: records.size - pendingInserts,
      pendingInserts,
      pendingDeletes: removals.size,
    };
  };

  // ————— planning —————

  /**
   * Order entity names so referenced entities come first. Only edges
   * between the given names constrain; a cycle (self-loops included)
   * is `JD0040`.
   */
  const orderEntities = (names, verb) => {
    const present = new Set(names);
    const waiting = new Map(names.map((name) => [name,
      new Set(mapping.entities[name].foreignKeys
        .map((fk) => fk.references)
        .filter((reference) => present.has(reference))),
    ]));
    /** @type {string[]} */
    const out = [];
    const placed = new Set();
    while (out.length < names.length) {
      const ready = [...waiting.entries()]
        .filter(([name, deps]) => !placed.has(name)
          && [...deps].every((dep) => placed.has(dep) && dep !== name))
        .map(([name]) => name)
        .sort();
      if (ready.length === 0) {
        const cycle = names.filter((name) => !placed.has(name)).sort();
        throw new DbCompileError('JD0040',
          `cannot order the ${verb} — these entities form a foreign-key `
          + `cycle: ${cycle.join(' → ')} (break the save in two)`,
          entities.get(cycle[0])?.docPath);
      }
      for (const name of ready) {
        placed.add(name);
        out.push(name);
      }
    }
    return out;
  };

  /** Partition one update's diff into the statement ingredients. */
  const partitionDiff = (entityName, record) => {
    const core = coreFor(entityName);
    const plan = core.plan;
    const entity = entities.get(entityName);
    const ops = createJSONPatch(record.snapshot, record.stamped);
    const columnSets = new Map();
    const docOps = [];
    const m2mMembers = new Set();
    let fallback = false;
    for (const op of ops) {
      if (op.from !== undefined) {
        fallback = true;
        continue;
      }
      const names = parseJSONPointer(op.path);
      if (names.length === 0) {
        fallback = true;
        continue;
      }
      const first = names[0];
      const property = entity.properties.get(first);
      if (property?.relation !== undefined) {
        if (property.relation.kind === 'manyToMany') {
          m2mMembers.add(first);
          continue;
        }
        throw contractError(entityName,
          `'${first}' is a relation member — a materialised projection, `
          + 'not stored state; change the related entities themselves');
      }
      if (first === plan.version) continue; // engine-owned (§11.5)
      if (plan.columnSet.has(first)) {
        const isEpoch = plan.scalarColumns.some(
          (column) => column.name === first && column.epoch);
        if (names.length !== 1) {
          fallback = true;
          continue;
        }
        const value = op.op === 'remove' ? undefined : op.value;
        columnSets.set(first, plan.encodeColumn(first, value));
        // the epoch string ALSO lives in the document
        if (isEpoch) docOps.push(op);
        continue;
      }
      docOps.push(op);
    }
    let docBuild = null;
    if (!fallback && docOps.length > 0) {
      const translated = translatePatch(docOps, record.snapshot, dialect);
      if (translated === null) fallback = true;
      else docBuild = translated;
    }
    return { columnSets, docBuild, m2mMembers, fallback };
  };

  /** Compute a many-to-many member's join-row difference by key sets. */
  const joinDiff = (entityName, before, after, ownKey, member) => {
    const entity = entities.get(entityName);
    const relation = entity.properties.get(member).relation;
    const targetKey = mapping.entities[relation.to].keys[0];
    const extract = (value) => {
      if (value === undefined || value === null) return [];
      if (!Array.isArray(value)) {
        throw contractError(entityName,
          `'${member}' must be an array to synchronise its join table`);
      }
      return value.map((element) => {
        const key = typeof element === 'string' || typeof element === 'number'
          ? element
          : element !== null && typeof element === 'object'
            ? element[targetKey] : undefined;
        if (typeof key !== 'string' && typeof key !== 'number') {
          throw contractError(entityName,
            `an element of '${member}' carries no usable '${targetKey}' key`);
        }
        return key;
      });
    };
    // a snapshot that never LOADED the member knows nothing about the
    // current membership — treating unknown as empty would re-insert
    // existing rows (a UNIQUE violation the seeded corpus found); the
    // save resolves unknowns by reading the join table first
    const memberValue = before === null ? [] : before[member];
    const beforeKeys = before !== null && memberValue === undefined
      ? null
      : [...new Set(extract(memberValue))];
    return {
      joinTable: relation.joinTable,
      ownColumn: `${entityName}_key`,
      targetColumn: `${relation.to}_key`,
      ownKey,
      beforeKeys,
      afterKeys: [...new Set(extract(after[member]))],
    };
  };

  /** Relation members riding a pending INSERT: many-to-many becomes
   * join rows; anything else refuses — projections are not state. */
  const insertRelationOps = (record) => {
    const entity = entities.get(record.entity);
    const plan = coreFor(record.entity).plan;
    /** @type {any[]} */
    const ops = [];
    for (const property of entity.properties.values()) {
      if (property.relation === undefined) continue;
      const value = record.current[property.name];
      if (value === undefined || (Array.isArray(value) && value.length === 0))
        continue;
      if (property.relation.kind !== 'manyToMany') {
        throw contractError(record.entity,
          `'${property.name}' is a relation member — a materialised `
          + 'projection, not stored state; add the related entities themselves');
      }
      const ownKey = record.current[plan.keys[0]];
      if (typeof ownKey !== 'string' && typeof ownKey !== 'number') {
        throw contractError(record.entity,
          `'${property.name}' membership needs the entity's own key at `
          + 'add() time — save the entity first, then attach');
      }
      ops.push(joinDiff(record.entity, null, record.current, ownKey, property.name));
    }
    return ops;
  };

  /** Build the ordered statement list for the current tracked state. */
  const planSave = () => {
    /** @type {Map<string, any[]>} */
    const inserts = new Map();
    /** @type {any[]} */
    const updates = [];
    /** @type {any[]} */
    const joinOps = [];
    let fallbacks = 0;
    const unversioned = new Set();

    for (const record of records.values()) {
      const core = coreFor(record.entity);
      if (record.pendingInsert === true) {
        let list = inserts.get(record.entity);
        if (list === undefined) {
          list = [];
          inserts.set(record.entity, list);
        }
        list.push(record);
        joinOps.push(...insertRelationOps(record));
        continue;
      }
      if (record.current === record.snapshot) continue;
      // probe before stamping: an update stamp must never turn a
      // deep-equal replacement into a phantom write
      if (createJSONPatch(record.snapshot, record.current).length === 0) continue;
      record.stamped = core.stampUpdated(record.current);
      const parts = partitionDiff(record.entity, record);
      for (const member of parts.m2mMembers) {
        joinOps.push(joinDiff(record.entity, record.snapshot, record.stamped,
          record.stamped[core.plan.keys[0]], member));
      }
      if (parts.columnSets.size === 0 && parts.docBuild === null
        && !parts.fallback) {
        // nothing but join-table changes (or a no-op put)
        if (parts.m2mMembers.size > 0) record.joinOnly = true;
        else record.stamped = undefined;
        continue;
      }
      if (parts.fallback) fallbacks++;
      if (core.plan.version === null) unversioned.add(record.entity);
      updates.push({ record, parts });
    }

    /** @type {any[]} */
    const deletes = [];
    for (const removal of removals.values()) {
      deletes.push(removal);
      if (coreFor(removal.entity).plan.version === null)
        unversioned.add(removal.entity);
    }

    // resolve unknown membership baselines, then finalize each op
    const resolveJoins = (i) => {
      if (i >= joinOps.length) return null;
      const op = joinOps[i];
      if (op.beforeKeys !== null) return resolveJoins(i + 1);
      const sql = `SELECT ${q(op.targetColumn)} AS ${q('t')} FROM ${q(op.joinTable)} `
        + `WHERE ${q(op.ownColumn)} = ${parameterAt(1)}`;
      return chain(connection.prepare(sql), (statement) =>
        chain(statement.all([op.ownKey]), (rows) => {
          op.beforeKeys = rows.map((row) => row.t);
          return resolveJoins(i + 1);
        }));
    };
    const finalizeJoins = () => {
      for (const op of joinOps) {
        const before = new Set(op.beforeKeys);
        const after = new Set(op.afterKeys);
        op.added = op.afterKeys.filter((key) => !before.has(key));
        op.removed = op.beforeKeys.filter((key) => !after.has(key));
      }
    };

    const assemble = () => {
      finalizeJoins();
      const insertOrder = orderEntities([...inserts.keys()], 'inserts');
      const deleteOrder = orderEntities(
        [...new Set(deletes.map((removal) => removal.entity))], 'deletes').reverse();

      /** @type {any[]} */
      const statements = [];

      // 1. inserts, parent-first, batched per column-name signature
      for (const entityName of insertOrder) {
        const plan = coreFor(entityName).plan;
        /** @type {Map<string, any[]>} */
        const shapes = new Map();
        for (const record of inserts.get(entityName)) {
          const split = plan.split(record.current);
          const signature = split.values.map((value) => value.name).join(',');
          let group = shapes.get(signature);
          if (group === undefined) {
            shapes.set(signature, group = []);
          }
          group.push({ record, split });
        }
        for (const group of shapes.values()) {
          const names = group[0].split.values.map((value) => value.name);
          const paramsPerRow = names.length + 1;
          const rowsPerBatch = Math.max(1, Math.min(BATCH_ROW_BOUND,
            Math.floor(BATCH_PARAM_BUDGET / paramsPerRow)));
          for (let at = 0; at < group.length; at += rowsPerBatch) {
            const batch = group.slice(at, at + rowsPerBatch);
            const returning = plan.autoKey !== null && !names.includes(plan.autoKey);
            const rowSql = (base) => `(${[...names.map((_, i) => parameterAt(base + i + 1)),
              dialect.jsonEncode(parameterAt(base + names.length + 1))].join(', ')})`;
            const sql = `INSERT INTO ${q(plan.table)} `
              + `(${[...names.map(q), q('doc')].join(', ')}) VALUES `
              + batch.map((_, i) => rowSql(i * paramsPerRow)).join(', ')
              + (returning ? ` RETURNING ${q(plan.autoKey)} AS ${q('key')}` : '');
            const params = batch.flatMap(({ split }) => [
              ...split.values.map((value) => value.value),
              JSON.stringify(split.rest),
            ]);
            statements.push({
              kind: 'insert', entity: entityName, sql, params, returning,
              records: batch.map(({ record }) => record),
            });
          }
        }
      }

      // 2. updates (inserts already exist; deletes still ahead)
      for (const { record, parts } of updates) {
        const plan = coreFor(record.entity).plan;
        const params = [];
        const assignments = [];
        if (parts.fallback) {
          const split = plan.split(record.stamped);
          for (const value of split.values) {
            if (value.name === plan.version) continue;
            assignments.push(`${q(value.name)} = ${parameterAt(params.length + 1)}`);
            params.push(value.value);
          }
          assignments.push(`${q('doc')} = ${dialect.jsonEncode(parameterAt(params.length + 1))}`);
          params.push(JSON.stringify(split.rest));
        }
        else {
          for (const [name, value] of parts.columnSets) {
            assignments.push(`${q(name)} = ${parameterAt(params.length + 1)}`);
            params.push(value);
          }
          if (parts.docBuild !== null) {
            const built = parts.docBuild.build(q('doc'), params.length);
            assignments.push(`${q('doc')} = ${built.expression}`);
            params.push(...built.params);
          }
        }
        const snapshotVersion = plan.version === null
          ? null : Number(record.snapshot[plan.version]) || 0;
        if (plan.version !== null) {
          assignments.push(`${q(plan.version)} = ${parameterAt(params.length + 1)}`);
          params.push(snapshotVersion + 1);
        }
        const wheres = plan.keys.map((key) => {
          params.push(record.snapshot[key]);
          return `${q(key)} = ${parameterAt(params.length)}`;
        });
        if (plan.version !== null) {
          params.push(snapshotVersion);
          wheres.push(`${q(plan.version)} = ${parameterAt(params.length)}`);
        }
        statements.push({
          kind: 'update', entity: record.entity, record,
          sql: `UPDATE ${q(plan.table)} SET ${assignments.join(', ')} `
            + `WHERE ${wheres.join(' AND ')}`,
          params,
          guarded: plan.version !== null,
          newVersion: plan.version === null ? null : snapshotVersion + 1,
        });
      }

      // 3. join-table rows: after both endpoints exist, before deletes
      for (const op of joinOps) {
        if (op.added.length > 0) {
          const sql = `INSERT INTO ${q(op.joinTable)} `
            + `(${q(op.ownColumn)}, ${q(op.targetColumn)}) VALUES `
            + op.added.map((_, i) => `(${parameterAt(i * 2 + 1)}, ${parameterAt(i * 2 + 2)})`).join(', ');
          statements.push({
            kind: 'join-insert', entity: op.joinTable, sql,
            params: op.added.flatMap((key) => [op.ownKey, key]),
            joinRows: op.added.map((key) => ({
              own: op.ownKey, target: key,
              ownColumn: op.ownColumn, targetColumn: op.targetColumn,
            })),
          });
        }
        for (const key of op.removed) {
          statements.push({
            kind: 'join-delete', entity: op.joinTable,
            sql: `DELETE FROM ${q(op.joinTable)} WHERE ${q(op.ownColumn)} = ${parameterAt(1)} `
              + `AND ${q(op.targetColumn)} = ${parameterAt(2)}`,
            params: [op.ownKey, key],
            joinRows: [{ own: op.ownKey, target: key,
              ownColumn: op.ownColumn, targetColumn: op.targetColumn }],
          });
        }
      }

      // 4. deletes, child-first
      for (const entityName of deleteOrder) {
        const plan = coreFor(entityName).plan;
        for (const removal of deletes) {
          if (removal.entity !== entityName) continue;
          const params = [...removal.parts];
          const wheres = plan.keys.map((key, i) => `${q(key)} = ${parameterAt(i + 1)}`);
          const snapshotVersion = plan.version !== null && removal.snapshot !== null
            ? Number(removal.snapshot[plan.version]) || 0 : null;
          if (snapshotVersion !== null) {
            params.push(snapshotVersion);
            wheres.push(`${q(plan.version)} = ${parameterAt(params.length)}`);
          }
          statements.push({
            kind: 'delete', entity: entityName, removal,
            sql: `DELETE FROM ${q(plan.table)} WHERE ${wheres.join(' AND ')}`,
            params,
            guarded: snapshotVersion !== null,
          });
        }
      }

      return { statements, fallbacks, unversioned: [...unversioned].sort() };
    };
    return chain(resolveJoins(0), assemble);
  };

  // ————— execution —————

  const conflict = (statement) => {
    const keyParts = statement.kind === 'delete'
      ? statement.removal.parts
      : coreFor(statement.entity).plan.keys
        .map((key) => statement.record.snapshot[key]);
    const key = keyParts.length === 1 ? keyParts[0] : keyParts;
    return new DbRuntimeError('JD2040',
      statement.guarded
        ? `'${statement.entity}' ${JSON.stringify(key)} changed under the save `
        + '(version mismatch) — re-read and retry'
        : `'${statement.entity}' ${JSON.stringify(key)} no longer exists`,
      {
        docPath: entities.get(statement.entity)?.docPath,
        collection: statement.entity,
        key,
      });
  };

  const wrapDb = (error, statement) => {
    if (typeof (/** @type {any} */ (error))?.code === 'string'
      && String((/** @type {any} */ (error)).code).startsWith('JD')) return error;
    return new DbRuntimeError('JD2005',
      `the database rejected the operation: ${/** @type {any} */ (error)?.message ?? String(error)}`,
      {
        docPath: entities.get(statement.entity)?.docPath,
        collection: statement.entity,
        cause: error,
      });
  };

  const runStatements = (statements, report) => {
    const next = (i) => {
      if (i >= statements.length) return report;
      const statement = statements[i];
      return chain(connection.prepare(statement.sql), (prepared) => {
        if (statement.kind === 'insert' && statement.returning === true) {
          let fetched;
          try {
            fetched = prepared.all(statement.params);
          }
          catch (error) {
            throw wrapDb(error, statement);
          }
          return chain(fetched, (rows) => {
            // auto keys allocate monotonically in insertion order —
            // sort ascending to pair rows with records (asserted by
            // test, not assumed silently)
            const keys = rows.map((row) => row.key).sort((a, b) => a - b);
            statement.generatedKeys = keys;
            report.inserted += statement.records.length;
            report.statements.push({ sql: statement.sql, rows: statement.records.length });
            return next(i + 1);
          });
        }
        return chain(
          statement.kind === 'delete' && captureJoinDelete !== null
            ? captureJoinDelete(statement.entity, statement.removal.parts)
            : null,
          () => {
        let ran;
        try {
          ran = prepared.run(statement.params);
        }
        catch (error) {
          throw wrapDb(error, statement);
        }
        return chain(ran, (outcome) => {
          const changed = Number(outcome?.changes ?? 0);
          report.statements.push({ sql: statement.sql, rows: changed });
          if (statement.kind === 'insert') report.inserted += statement.records.length;
          else if (statement.kind === 'update') {
            if (changed === 0) throw conflict(statement);
            report.updated += 1;
          }
          else if (statement.kind === 'delete') {
            if (changed === 0 && statement.guarded) throw conflict(statement);
            statement.deletedRows = changed;
            report.deleted += changed;
          }
          else if (statement.kind === 'join-insert') report.joinInserted += changed;
          else if (statement.kind === 'join-delete') report.joinDeleted += changed;
          return next(i + 1);
        });
          });
      });
    };
    return next(0);
  };

  /** Commit phase: only reached after the transaction succeeded. */
  const commit = (statements) => {
    for (const statement of statements) {
      if (statement.kind === 'insert') {
        statement.records.forEach((record, i) => {
          const plan = coreFor(statement.entity).plan;
          let doc = record.current;
          if (statement.returning === true) {
            doc = deepFreeze({ ...doc, [plan.autoKey]: statement.generatedKeys[i] });
          }
          // re-key under the real identity
          records.delete(record.pendingKey);
          const key = recordKeyFor(statement.entity, doc);
          records.set(/** @type {string} */ (key), {
            entity: statement.entity, snapshot: doc, current: doc, pendingInsert: false,
          });
          record.saved = doc;
          captureRecord?.(statement.entity,
            plan.keys.map((k) => doc[k]), null, doc);
        });
      }
      else if (statement.kind === 'update') {
        const record = statement.record;
        const plan = coreFor(statement.entity).plan;
        const before = record.snapshot;
        const saved = statement.newVersion === null
          ? record.stamped
          : deepFreeze({ ...record.stamped, [plan.version]: statement.newVersion });
        record.snapshot = deepFreeze(saved);
        record.current = record.snapshot;
        record.stamped = undefined;
        captureRecord?.(statement.entity,
          plan.keys.map((k) => record.snapshot[k]), before, record.snapshot);
      }
      else if (statement.kind === 'delete') {
        const removal = statement.removal;
        records.delete(keyOf(removal.entity, removal.parts));
        removals.delete(keyOf(removal.entity, removal.parts));
        if ((statement.deletedRows ?? 0) > 0) {
          captureRecord?.(removal.entity, removal.parts,
            removal.snapshot ?? undefined, null);
        }
      }
      else if (statement.kind === 'join-insert' || statement.kind === 'join-delete') {
        for (const row of statement.joinRows ?? []) {
          // the join-row "document" lists its columns in table order
          // (the sorted pair) so both capture modes agree exactly
          const pair = statement.entity.split('_');
          const value = { [row.ownColumn]: row.own, [row.targetColumn]: row.target };
          const ordered = {};
          for (const part of pair) ordered[part + '_key'] = value[part + '_key'];
          const keyParts = pair.map((part) => ordered[part + '_key']);
          if (statement.kind === 'join-insert') {
            captureRecord?.(statement.entity, keyParts, null, ordered);
          }
          else {
            captureRecord?.(statement.entity, keyParts, undefined, null);
          }
        }
      }
    }
    // join-only records: their member state is now persisted
    for (const record of records.values()) {
      if (record.joinOnly === true) {
        record.snapshot = record.stamped ?? record.current;
        record.current = record.snapshot;
        record.joinOnly = undefined;
        record.stamped = undefined;
      }
    }
    removals.clear();
  };

  const saveChanges = () => {
    const startedAt = performance.now();
    return chain(planSave(), ({ statements, fallbacks, unversioned }) => {
    const report = {
      inserted: 0, updated: 0, deleted: 0,
      joinInserted: 0, joinDeleted: 0,
      fallbacks,
      statements: /** @type {{ sql: string, rows: number }[]} */ ([]),
      concurrency: {
        checked: statements.filter((statement) => statement.guarded === true).length,
        unversioned,
      },
      elapsedMs: 0,
    };
    if (statements.length === 0) {
      report.elapsedMs = performance.now() - startedAt;
      return report;
    }
    return chain(
      connection.transaction(() => runStatements(statements, report)),
      (finished) => {
        commit(statements);
        finished.elapsedMs = performance.now() - startedAt;
        return finished;
      });
    });
  };

  /** Drop tracking for a key without scheduling anything. */
  const discard = (entityName, keyOrDoc) => {
    const parts = coreFor(entityName).normalizeKey(keyOrDoc);
    records.delete(keyOf(entityName, parts));
  };

  return {
    register, registerGraph, add, put, remove, discard, counts, saveChanges,
  };
}
