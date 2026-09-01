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
 * paths, join-table synchronisation for many-to-many members — by the
 * key-set difference a `put` implies, or by an explicit `link`/`unlink`
 * delta resolved against the join table at save time — and a counted
 * whole-row fallback for anything untranslatable.
 *
 * Ordering never violates a foreign key mid-transaction: inserts run
 * parent-first, deletes child-first, updates in between, join rows
 * after both endpoints exist. A foreign-key cycle among the entities
 * being inserted or deleted is `JD0040`, reported, never a deadlock.
 * The whole save is one transaction, and the tracker is mutated only
 * after its statements have run — so a save that FAILS leaves the
 * tracker exactly as it was and a retry is possible. A save that
 * SUCCEEDS inside a larger transaction advances at once (inside it, the
 * database does hold those rows, and every later plan and optimistic
 * guard has to agree), and registers the withdrawal of that advance
 * against the scope that owns the connection: an enclosing rollback
 * takes it back, so the retry plans the same statements again rather
 * than reporting a success it never had.
 */

import { createJSONPatch } from '@jarenjs/json/patch';
import { parseJSONPointer } from '@jarenjs/json/pointer';

import { DbCompileError, DbRuntimeError } from './errors.js';
import { chain, attempt } from './driver.js';
import { translatePatch } from './patch-sql.js';

/** Rows per batched INSERT: bounded by the portable parameter budget. */
export const BATCH_PARAM_BUDGET = 900;
export const BATCH_ROW_BOUND = 100;

/**
 * The target keys a many-to-many membership array names: a key, or a
 * document carrying the target's key. One reading for the unit of work
 * and for `create()`, so the two attach the same rows.
 * @param {any} value - the member's value
 * @param {string} targetKey - the target entity's key property
 * @param {string} member
 * @param {(reason: string) => Error} refuse
 * @returns {(string | number)[]}
 */
export function membershipKeys(value, targetKey, member, refuse) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw refuse(`'${member}' must be an array to synchronise its join table`);
  return value.map((element) => {
    const key = typeof element === 'string' || typeof element === 'number'
      ? element
      : element !== null && typeof element === 'object'
        ? element[targetKey] : undefined;
    if (typeof key !== 'string' && typeof key !== 'number')
      throw refuse(`an element of '${member}' carries no usable '${targetKey}' key`);
    return key;
  });
}

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
  /** Pending membership deltas (§11.7), one per entity, own key and
   * many-to-many member: the targets to link and the targets to unlink.
   * @type {Map<string, { entity: string, member: string, ownKey: string | number,
   *   links: Set<string | number>, unlinks: Set<string | number> }>} */
  const memberships = new Map();
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

  /** A membership write needs the entity's own key: an `auto` key is
   * allocated by the save, so a pending insert has none to attach to. */
  const needsOwnKey = (entityName, member, verb) => contractError(entityName,
    `'${member}' membership needs the entity's own key at ${verb} time — `
    + 'save the entity first, then attach');

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

  /** The pending insert a caller is holding, found by the identity of
   * the document `add()` handed back: a record whose key the save has
   * yet to allocate has nothing else to be found by. */
  const pendingInsertHolding = (entityName, doc) => {
    for (const record of records.values()) {
      if (record.pendingInsert === true && record.entity === entityName
        && record.current === doc) return record;
    }
    return undefined;
  };

  /** What a join op and its membership delta are filed under: the own
   * key once there is one, and the pending record's own identity while
   * the save has yet to allocate it. */
  const ownToken = (entityName, ownKey, ownRecord) => (ownRecord === undefined
    ? keyOf(entityName, [ownKey])
    : ownRecord.pendingKey);

  /**
   * The pending membership delta a `link`/`unlink` addresses (§11.7):
   * the member must be a many-to-many relation of the entity; the own
   * key is read from a key or a document; the target is a key or a
   * document carrying the target's key — the reading a membership array
   * gets, so the two attach the same rows.
   *
   * A document whose key the save allocates carries none to attach to,
   * so the delta is filed against the pending INSERT it belongs to and
   * the join row takes the key that insert returns.
   */
  const membershipOf = (entityName, own, member, target, verb) => {
    const plan = coreFor(entityName).plan;
    const relation = entities.get(entityName).properties.get(member)?.relation;
    if (relation === undefined || relation.kind !== 'manyToMany') {
      throw contractError(entityName, relation === undefined
        ? `'${member}' is not a relation member of '${entityName}' — ${verb}() attaches a `
          + 'many-to-many membership through its join table'
        : `'${member}' is a ${relation.kind} relation — ${verb}() attaches many-to-many `
          + "memberships only; write the related entity's foreign key instead");
    }
    let ownKey;
    let ownRecord;
    if (own !== null && typeof own === 'object' && !Array.isArray(own)) {
      ownKey = own[plan.keys[0]];
      if (typeof ownKey !== 'string' && typeof ownKey !== 'number') {
        ownRecord = pendingInsertHolding(entityName, own);
        if (ownRecord === undefined) throw needsOwnKey(entityName, member, `${verb}()`);
        ownKey = undefined;
      }
    }
    else {
      ownKey = coreFor(entityName).normalizeKey(own)[0];
    }
    const targetKey = mapping.entities[relation.to].keys[0];
    const [key] = membershipKeys([target], targetKey, member,
      (reason) => contractError(entityName, reason));
    const id = `${ownToken(entityName, ownKey, ownRecord)}${UNIT_SEPARATOR}${member}`;
    let pending = memberships.get(id);
    if (pending === undefined) {
      pending = { entity: entityName, member, ownKey, ownRecord,
        links: new Set(), unlinks: new Set() };
      memberships.set(id, pending);
    }
    return { pending, key };
  };

  /** Attach one membership (local, synchronous); the last word on one
   * target wins, so `unlink` after `link` means unlink. */
  const link = (entityName, own, member, target) => {
    const { pending, key } = membershipOf(entityName, own, member, target, 'link');
    pending.unlinks.delete(key);
    pending.links.add(key);
  };

  /** Detach one membership (local, synchronous). */
  const unlink = (entityName, own, member, target) => {
    const { pending, key } = membershipOf(entityName, own, member, target, 'unlink');
    pending.links.delete(key);
    pending.unlinks.add(key);
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
      pendingMemberships: memberships.size,
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

  /** The join-table endpoints a many-to-many member writes through. The
   * endpoint columns come from the mapping, never from the join table's
   * NAME: an entity name with an underscore, or a `through` name, does
   * not split into its endpoints. */
  const joinEndpoints = (entityName, member) => {
    const relation = entities.get(entityName).properties.get(member).relation;
    const join = mapping.joinTables[relation.joinTable];
    const own = join.left.entity === entityName ? join.left : join.right;
    const target = own === join.left ? join.right : join.left;
    return {
      entity: entityName,
      member,
      joinTable: relation.joinTable,
      ownColumn: own.column,
      targetColumn: target.column,
      tableColumns: [join.left.column, join.right.column],
      targetKey: mapping.entities[relation.to].keys[0],
    };
  };

  /** Compute a many-to-many member's join-row difference by key sets. */
  const joinDiff = (entityName, before, after, ownKey, member) => {
    const endpoints = joinEndpoints(entityName, member);
    const extract = (value) => membershipKeys(value, endpoints.targetKey, member,
      (reason) => contractError(entityName, reason));
    // a snapshot that never LOADED the member knows nothing about the
    // current membership — treating unknown as empty would re-insert
    // existing rows (a UNIQUE violation the seeded corpus found); the
    // save resolves unknowns by reading the join table first
    const memberValue = before === null ? [] : before[member];
    const beforeKeys = before !== null && memberValue === undefined
      ? null
      : [...new Set(extract(memberValue))];
    return {
      ...endpoints,
      ownKey,
      beforeKeys,
      afterKeys: [...new Set(extract(after[member]))],
    };
  };

  /** A pending `link`/`unlink` delta as a join op. Its baseline is the
   * join table as read at save time, so linking a member that exists
   * and unlinking one that does not are no-ops — the two-run property. */
  const membershipDelta = (pending) => ({
    ...joinEndpoints(pending.entity, pending.member),
    ownKey: pending.ownKey,
    ownRecord: pending.ownRecord,
    // a row the save is about to INSERT has no memberships to read: the
    // key does not exist yet, so its baseline is empty rather than unknown
    beforeKeys: pending.ownRecord === undefined ? null : [],
    links: [...pending.links],
    unlinks: [...pending.unlinks],
  });

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
      const known = typeof ownKey === 'string' || typeof ownKey === 'number';
      if (!known && plan.autoKey === null)
        throw needsOwnKey(record.entity, property.name, 'add()');
      // the key this row will have is the one its INSERT returns, so the
      // join row is planned against the record and takes the key at run time
      ops.push({
        ...joinDiff(record.entity, null, record.current,
          known ? ownKey : undefined, property.name),
        ownRecord: known ? undefined : record,
      });
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
    /** Records this save advances through their join table alone: they
     * carry no statement of their own, and the commit still settles
     * them, so the undo delta has to know about them. @type {any[]} */
    const joinOnly = [];
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
      // a record with a pending removal is deleted, not updated: planning
      // both bumped the version on the UPDATE and left the DELETE's
      // snapshot guard matching nothing (JD2040), so the row survived
      if (removals.has(recordKeyFor(record.entity, record.snapshot) ?? '')) continue;
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
        if (parts.m2mMembers.size > 0) {
          record.joinOnly = true;
          joinOnly.push(record);
        }
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

    // a link/unlink beside a put-based synchronisation of the SAME member
    // folds into that op's key set: one intent per entity, own key and
    // member, never two statements racing for one row
    const synced = new Map(joinOps.map((op) =>
      [`${ownToken(op.entity, op.ownKey, op.ownRecord)}${UNIT_SEPARATOR}${op.member}`, op]));
    for (const [id, pending] of memberships) {
      const diff = synced.get(id);
      if (diff === undefined) {
        joinOps.push(membershipDelta(pending));
        continue;
      }
      const after = new Set(diff.afterKeys);
      for (const key of pending.unlinks) after.delete(key);
      for (const key of pending.links) after.add(key);
      diff.afterKeys = [...after];
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
        if (op.links !== undefined) {
          op.added = op.links.filter((key) => !before.has(key));
          op.removed = op.unlinks.filter((key) => before.has(key));
          continue;
        }
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
            kind: 'join-insert', entity: op.joinTable, sql, tableColumns: op.tableColumns,
            // an own key the save has yet to allocate is filled in from the
            // insert's RETURNING, which the ordering above guarantees has run
            ownFrom: op.ownRecord,
            params: op.added.flatMap((key) => [op.ownKey, key]),
            joinRows: op.added.map((key) => ({
              own: op.ownKey, target: key,
              ownColumn: op.ownColumn, targetColumn: op.targetColumn,
            })),
          });
        }
        for (const key of op.removed) {
          statements.push({
            kind: 'join-delete', entity: op.joinTable, tableColumns: op.tableColumns,
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

      return { statements, fallbacks, joinOnly, unversioned: [...unversioned].sort() };
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
      // a join row whose own key the save allocates: the INSERT that
      // allocates it has already run (inserts precede join rows), so the
      // key is on the record by now
      if (statement.ownFrom !== undefined) {
        const ownKey = statement.ownFrom.allocatedKey;
        statement.params = statement.joinRows.flatMap(
          (/** @type {any} */ row) => [ownKey, row.target]);
        for (const row of statement.joinRows) row.own = ownKey;
      }
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
            // a join row planned against one of these records reads its
            // key from here, before the commit phase re-keys anything
            statement.records.forEach((record, at) => { record.allocatedKey = keys[at]; });
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
        return chain(attempt(() => prepared.run(statement.params),
          (error) => wrapDb(error, statement)), (outcome) => {
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

  /**
   * The tracker state a save's commit will advance, exactly as it stands
   * before the save runs: the map slot behind every record the commit
   * may re-key or drop, the fields it may overwrite on a record it
   * keeps, and the pending removals and membership deltas, which it
   * clears whole. Bounded by the save, never by the tracker's size.
   *
   * `planSave` names the join-only records because they carry no
   * statement of their own and the commit still advances them.
   * @param {any[]} statements
   * @param {any[]} joinOnly
   */
  const undoFor = (statements, joinOnly) => {
    /** @type {Map<string, any>} */
    const slots = new Map();
    /** @type {Map<any, any>} */
    const fields = new Map();
    const takeSlot = (key) => {
      if (!slots.has(key)) slots.set(key, records.get(key));
    };
    const takeFields = (record) => {
      if (record === undefined || fields.has(record)) return;
      fields.set(record, {
        snapshot: record.snapshot, current: record.current,
        stamped: record.stamped, joinOnly: record.joinOnly,
        pendingInsert: record.pendingInsert, saved: record.saved,
      });
    };
    for (const statement of statements) {
      if (statement.kind === 'insert') {
        for (const record of statement.records) {
          takeSlot(record.pendingKey);
          takeFields(record);
        }
      }
      else if (statement.kind === 'update') takeFields(statement.record);
      else if (statement.kind === 'delete') {
        const key = keyOf(statement.removal.entity, statement.removal.parts);
        takeSlot(key);
        takeFields(records.get(key));
      }
    }
    for (const record of joinOnly) takeFields(record);
    return {
      slots, fields,
      removals: [...removals],
      // the delta sets are mutated in place by a later link()/unlink(),
      // so the undo needs copies rather than the live ones
      memberships: [...memberships].map(([id, pending]) => [id, {
        ...pending, links: new Set(pending.links), unlinks: new Set(pending.unlinks),
      }]),
    };
  };

  /** Put back what {@link undoFor} took a copy of: the save's statements
   * were rolled back, so every claim they made about the database is
   * withdrawn and a retry plans them again. */
  const restore = (undo) => {
    for (const [key, entry] of undo.slots) {
      if (entry === undefined) records.delete(key);
      else records.set(key, entry);
    }
    for (const [record, was] of undo.fields) {
      record.snapshot = was.snapshot;
      record.current = was.current;
      record.stamped = was.stamped;
      record.joinOnly = was.joinOnly;
      record.pendingInsert = was.pendingInsert;
      record.saved = was.saved;
    }
    removals.clear();
    for (const [key, removal] of undo.removals) removals.set(key, removal);
    memberships.clear();
    for (const [id, pending] of undo.memberships) memberships.set(id, pending);
  };

  /**
   * Commit phase: only reached once the transaction that ran the
   * statements has committed, which is why it is registered as a
   * settlement effect rather than run on the save's own savepoint.
   *
   * `undo` is the state the save started from. It is read for one
   * decision: an edit made to a tracked record AFTER this save was
   * planned is still pending work, and only a record left exactly as
   * the save found it becomes clean.
   * @param {any[]} statements
   * @param {any} undo
   */
  const commit = (statements, undo) => {
    const untouched = (record) => !undo.fields.has(record)
      || undo.fields.get(record).current === record.current;
    for (const statement of statements) {
      if (statement.kind === 'insert') {
        statement.records.forEach((record, i) => {
          const plan = coreFor(statement.entity).plan;
          // the row this statement wrote is the one the save PLANNED; an
          // edit made to the same record afterwards is not in the database
          const planned = undo.fields.get(record)?.current ?? record.current;
          const doc = statement.returning === true
            ? deepFreeze({ ...planned, [plan.autoKey]: statement.generatedKeys[i] })
            : planned;
          // re-key under the real identity
          records.delete(record.pendingKey);
          const key = recordKeyFor(statement.entity, doc);
          records.set(/** @type {string} */ (key), {
            entity: statement.entity, snapshot: doc,
            current: untouched(record) ? doc : record.current, pendingInsert: false,
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
        const pending = untouched(record) ? null : record.current;
        record.snapshot = deepFreeze(saved);
        record.current = pending ?? record.snapshot;
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
          // (the mapping's left, right) so both capture modes agree exactly
          const value = { [row.ownColumn]: row.own, [row.targetColumn]: row.target };
          const ordered = {};
          for (const column of statement.tableColumns) ordered[column] = value[column];
          const keyParts = statement.tableColumns.map((column) => ordered[column]);
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
        const pending = untouched(record) ? null : record.current;
        record.snapshot = record.stamped ?? undo.fields.get(record)?.current ?? record.current;
        record.current = pending ?? record.snapshot;
        record.joinOnly = undefined;
        record.stamped = undefined;
      }
    }
    removals.clear();
    memberships.clear();
  };

  const saveChanges = () => {
    const startedAt = performance.now();
    return chain(planSave(), ({ statements, fallbacks, joinOnly, unversioned }) => {
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
    // what the tracker looked like before the save, taken while it still
    // does: the statements below run in a savepoint whose release is not
    // a commit, so the right to KEEP what they justify waits for one
    const undo = undoFor(statements, joinOnly);
    return chain(
      connection.transaction(() => runStatements(statements, report)),
      (finished) => {
        // The advance itself lands now, because inside the transaction the
        // database DOES hold these rows: every later read, plan and
        // optimistic guard in this unit of work has to agree with that, and
        // a tracker still calling them pending would write them twice.
        // What waits for the commit is the right to keep the advance — the
        // enclosing scope withdraws it if it rolls back, which is what
        // makes a caller's retry plan the same statements again.
        commit(statements, undo);
        connection.onSettle({ rollback: () => restore(undo) });
        finished.elapsedMs = performance.now() - startedAt;
        return finished;
      });
    });
  };

  /** Drop tracking for a key without scheduling anything. */
  const discard = (entityName, keyOrDoc) => {
    const parts = coreFor(entityName).normalizeKey(keyOrDoc);
    const key = keyOf(entityName, parts);
    records.delete(key);
    // a pending membership change belongs to the key it attaches to
    for (const id of memberships.keys()) {
      if (id.startsWith(`${key}${UNIT_SEPARATOR}`)) memberships.delete(id);
    }
  };

  return {
    register, registerGraph, add, put, remove, discard, link, unlink, counts, saveChanges,
  };
}
