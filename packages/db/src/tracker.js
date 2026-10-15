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
 * One delete keeps the order it was staged in instead: a removal a
 * rollback staged again under a key an `add()` staged after it holds
 * runs ahead of the inserts, so that key is deleted, then inserted —
 * child-first after the removals of the rows that reference it, and after
 * the updates that move rows off it (one that moves a row onto a row the
 * save inserts follows that insert, which then runs first).
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

import { deepFreeze, setObjectMember, isJsonObject } from '@jarenjs/core/object';
import { createJSONPatch } from '@jarenjs/json/patch';
import { parseJSONPointer } from '@jarenjs/json/pointer';

import { DbCompileError, DbRuntimeError, wrapDriverError } from './errors.js';
import { chain, attempt, isThenable, useStatementOnce } from './driver.js';
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
 * @param {(parts: (string | number)[], member: string) => (string | number)[]} [checkKey] -
 *   the target's own reading of a key (its entity core's `plan.memberKey`):
 *   the refusal of one no write could hold — text that names no number
 *   under a numeric key column (`JD2002`, naming the member), which
 *   PostgreSQL would read as another row's — and otherwise the value the
 *   key names, which is what each element becomes. Every caller that
 *   writes the keys passes it.
 * @returns {(string | number)[]}
 */
export function membershipKeys(value, targetKey, member, refuse, checkKey = undefined) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw refuse(`'${member}' must be an array to synchronise its join table`);
  return value.map((element) => {
    const key = typeof element === 'string' || typeof element === 'number'
      ? element
      : element !== null && typeof element === 'object'
        ? element[targetKey] : undefined;
    if (typeof key !== 'string' && typeof key !== 'number')
      throw refuse(`an element of '${member}' carries no usable '${targetKey}' key`);
    return checkKey === undefined ? key : checkKey([key], member)[0];
  });
}

const UNIT_SEPARATOR = '\x1f';

/**
 * Run `step(at)` for each `at` from `from` up to `count`, one after another,
 * without the stack growing with `count`: a step that answers a value lets
 * the loop go on at once, and one that answers a promise resumes the loop
 * when it settles. A save runs one statement per staged row — tens of
 * thousands — on a synchronous driver too, where chaining each step into
 * the next overflowed the stack. Answers `undefined`, or a promise of it
 * once a step was asynchronous.
 * @param {number} count @param {(at: number) => any} step @param {number} [from]
 * @returns {any}
 */
function inOrder(count, step, from = 0) {
  for (let at = from; at < count; at++) {
    const out = step(at);
    if (isThenable(out)) return out.then(() => inOrder(count, step, at + 1));
  }
  return undefined;
}

/**
 * The store-level unit of work.
 * @param {{ connection: any, entities: Map<string, any>, mapping: any,
 *   coreFor: (name: string) => any, captureRecord?: (table: string, keyParts: any[], before: any, after: any, moved?: any[]) => void,
 *   journal?: boolean, readCascade?: (table: string, keyParts: any[]) => any,
 *   judgeCascade?: (entries: any[]) => any }} context - `captureRecord` records a
 *   row write for capture; `journal` whether capture keeps a journal (its update
 *   records read before-images); `readCascade` and `judgeCascade` read and judge
 *   the rows a delete's foreign-key actions reach
 * @returns {any}
 */
export function createTracker(context) {
  const { connection, entities, mapping, coreFor } = context;
  const captureRecord = context.captureRecord ?? null;
  // whether capture keeps a journal: the before-images its update records
  // read, and the stored key of a row a removal never read
  const journal = captureRecord !== null && context.journal === true;
  // the rows a delete's foreign-key actions reach: read before each delete
  // statement runs when a journal records them or a store rule judges them,
  // judged right after the statement removed its row and recorded by
  // `commit`
  const readCascade = context.readCascade ?? null;
  const judgeCascade = context.judgeCascade ?? null;
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
  /** Records an add() replaced whose add a remove() then cancelled:
   * `add(); remove()` leaves nothing, so a rollback that would put one of
   * them back leaves its key empty instead (see `restore`).
   * @type {WeakSet<any>} */
  const withdrawn = new WeakSet();
  let pendingSequence = 0;

  // Keys may contain the membership separator themselves. Encode the
  // whole tuple so its component boundaries and entity remain distinct.
  // Each part is filed as the value it names: decimal text under a numeric
  // key column is its number (§6), so `'16'` and `16` file one row.
  /** @param {string} entityName @param {any} plan - the entity's @param {any[]} parts */
  const keyFor = (entityName, plan, parts) => JSON.stringify([entityName, ...plan.keyValues(parts)]);
  const keyOf = (entityName, parts) => keyFor(entityName, coreFor(entityName).plan, parts);

  const recordKeyFor = (entityName, doc) => {
    const plan = coreFor(entityName).plan;
    const parts = plan.keys.map((k) => doc[k]);
    if (parts.some((part) => typeof part !== 'string' && typeof part !== 'number'))
      return null;
    return keyFor(entityName, plan, parts);
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
        entity: entityName, snapshot: doc, current: doc, pendingInsert: false, key,
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
    if (removals.has(key))
      throw contractError(entityName, 'add() cannot replace a pending removal — use put()/update() for a replacement, or save the removal before adding');
    records.set(key, {
      entity: entityName, snapshot: null, current: completed,
      // the document handed back names the pending insert for as long as
      // it is one, a replacement of its content included
      pendingInsert: true, pendingKey: key, added: completed,
      replaced: records.get(key),
    });
    return completed;
  };

  /** A pending insert's replacement document, which keeps the version
   * `add()` started the row at when it carries none: a row is inserted at
   * `0`, never SQL `NULL` (§11.5). @param {string} entityName @param {any} next
   * @param {any} base - the document `add()` completed, or one replacing it */
  const keepVersion = (entityName, next, base) => {
    const version = coreFor(entityName).plan.version;
    return version === null || next[version] !== undefined || base?.[version] === undefined
      ? next : { ...next, [version]: base[version] };
  };

  /** A saved row's document without the key the save allocated it: the
   * key names no row once that save is rolled back. @param {string} entityName @param {any} doc */
  const withoutKey = (entityName, doc) => {
    const rest = { ...doc };
    delete rest[coreFor(entityName).plan.autoKey];
    return rest;
  };

  const put = (entityName, next) => {
    const core = coreFor(entityName);
    if (!isJsonObject(next))
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
    // the last staged word wins: a put of a tracked row is the replacement
    // the add() refusal names, so it cancels the row's pending removal; a
    // pending insert keeps the removal it follows (the save deletes, then
    // inserts — see `restore`)
    if (record.pendingInsert !== true) removals.delete(/** @type {string} */ (key));
    record.current = deepFreeze(record.pendingInsert === true ? keepVersion(entityName, next, record.current) : next);
    return record.current;
  };

  /** Drop the pending membership changes that belong to a row: those filed
   * under one of its `keys` (the own key a `link()`/`unlink()` named, or a
   * pending insert's own identity) and, given the pending insert `record`,
   * those filed against that record. @param {string[]} keys @param {any} [record] */
  const dropMemberships = (keys, record = undefined) => {
    for (const [id, pending] of memberships) {
      if ((record !== undefined && pending.ownRecord === record)
        || keys.some((key) => id.startsWith(`${key}${UNIT_SEPARATOR}`))) memberships.delete(id);
    }
  };

  const remove = (entityName, keyOrDoc) => {
    const core = coreFor(entityName);
    // a key no write could hold (text that names no number, under a numeric
    // key column) is refused as add() refuses it, never bound to a DELETE
    const parts = core.plan.refuseUnnumbered(core.normalizeKey(keyOrDoc));
    const key = keyOf(entityName, parts);
    const record = records.get(key);
    if (record !== undefined && record.pendingInsert === true) {
      // added then removed: a no-op — and so is every link()/unlink() staged
      // under the key, before the add or after it: the save wrote those join
      // rows for a row it never inserted, and failed on the foreign key
      records.delete(key);
      dropMemberships([key], record);
      for (let replaced = record.replaced; replaced !== undefined; replaced = replaced.replaced) withdrawn.add(replaced);
      return;
    }
    removals.set(key, {
      entity: entityName,
      parts,
      snapshot: record?.snapshot ?? null,
    });
  };

  /** The target's own reading of a membership key: refused where no write
   * could hold it, otherwise the value it names (see `membershipKeys`).
   * @param {any} relation */
  const targetKeyCheck = (relation) => coreFor(relation.to).plan.memberKey;

  /** The pending insert a caller is holding, found by the identity of
   * the document `add()` handed back: a record whose key the save has
   * yet to allocate has nothing else to be found by. */
  const pendingInsertHolding = (entityName, doc) => {
    for (const record of records.values()) {
      if (record.pendingInsert === true && record.entity === entityName
        && (record.current === doc || record.added === doc)) return record;
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
    if (isJsonObject(own)) {
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
    if (ownRecord === undefined) [ownKey] = plan.keyValues(plan.refuseUnnumbered([ownKey]));
    const targetKey = mapping.entities[relation.to].keys[0];
    const [key] = membershipKeys([target], targetKey, member,
      (reason) => contractError(entityName, reason), targetKeyCheck(relation));
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
      if (plan.document === false) {
        // a column-only row is assigned whole columns: a change anywhere
        // inside a member sets that member and nothing else, so an UPDATE OF
        // rule meets the columns the save actually changes (§13.1)
        const touched = [op.path, ...(op.from === undefined ? [] : [op.from])]
          .map((pointer) => parseJSONPointer(pointer)[0]);
        if (touched.includes(undefined)) {
          fallback = true;
          continue;
        }
        for (const name of touched) {
          if (name === plan.version) continue; // engine-owned (§11.5)
          if (!plan.columnSet.has(name)) throw contractError(entityName, `'${name}' is not a mapped column`);
          if (plan.scalarColumns.some((c) => c.name === name && c.generated))
            throw contractError(entityName, `'${name}' is generated by the database`);
          columnSets.set(name, plan.encodeColumn(name, record.stamped[name]));
        }
        continue;
      }
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
        if (plan.scalarColumns.some((c) => c.name === first && c.generated))
          throw contractError(entityName, `'${first}' is generated by the database`);
        const value = op.op === 'remove' ? undefined : op.value;
        columnSets.set(first, plan.encodeColumn(first, value));
        // the epoch string ALSO lives in the document
        if (isEpoch) docOps.push(op);
        continue;
      }
      if (plan.document === false) throw contractError(entityName, `'${first}' is not a mapped column`);
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
      // a target key as the value it names, whichever spelling holds it,
      // so a membership's key sets compare by value (§6)
      targetValue: (/** @type {any} */ key) => coreFor(relation.to).plan.keyValues([key])[0],
    };
  };

  /** Compute a many-to-many member's join-row difference by key sets. */
  const joinDiff = (entityName, before, after, ownKey, member) => {
    const endpoints = joinEndpoints(entityName, member);
    const extract = (value, checkKey = undefined) => membershipKeys(value, endpoints.targetKey, member,
      (reason) => contractError(entityName, reason), checkKey);
    // a snapshot that never LOADED the member knows nothing about the
    // current membership — treating unknown as empty would re-insert
    // existing rows (a UNIQUE violation the seeded corpus found); the
    // save resolves unknowns by reading the join table first
    const memberValue = before === null ? [] : before[member];
    const beforeKeys = before !== null && memberValue === undefined
      ? null
      : [...new Set(extract(memberValue).map(endpoints.targetValue))];
    return {
      ...endpoints,
      // the own key as its join column holds it, as a link() files it
      ownKey: ownKey === undefined ? undefined : coreFor(entityName).plan.keyValues([ownKey])[0],
      beforeKeys,
      // the keys the save writes, each one the target could hold
      afterKeys: [...new Set(extract(after[member],
        targetKeyCheck(entities.get(entityName).properties.get(member).relation)))],
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
    // key does not exist yet — or, where a removal of the key runs ahead of
    // that insert, the delete takes the old row's join rows along — so its
    // baseline is empty rather than unknown
    beforeKeys: pending.ownRecord !== undefined
      || records.get(keyOf(pending.entity, [pending.ownKey]))?.pendingInsert === true ? [] : null,
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
    /** A document's rules that read another row, by record: each runs inside
     * the save's transaction just before the record's own statement, so it
     * sees what the statements ahead of it wrote. @type {Map<any, (() => any)[]>} */
    const deferred = new Map();
    const deferFor = (/** @type {any} */ record) => ({ defer: (/** @type {() => any} */ run) => {
      let runs = deferred.get(record);
      if (runs === undefined) deferred.set(record, runs = []);
      runs.push(run);
    } });

    for (const record of records.values()) {
      const core = coreFor(record.entity);
      if (record.pendingInsert === true) {
        core.plan.writable?.();
        if (core.plan.document !== false) core.plan.checkMutation?.('insert', null, record.current, deferFor(record));
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
      if (removals.has(record.key ?? recordKeyFor(record.entity, record.snapshot) ?? '')) continue;
      // a column-only row compares as its codecs store it: a value that
      // stores as the one already there is no change and no write
      const current = core.plan.document === false ? core.plan.normalize(record.current) : record.current;
      // probe before stamping: an update stamp must never turn a
      // deep-equal replacement — or one that differs only in the version
      // member, which is the store's own — into a phantom write
      if (core.plan.unchanged(record.snapshot, current)) continue;
      core.plan.writable?.();
      record.stamped = core.stampUpdated(current);
      const parts = partitionDiff(record.entity, record);
      for (const member of parts.m2mMembers) {
        joinOps.push(joinDiff(record.entity, record.snapshot, record.stamped,
          record.stamped[core.plan.keys[0]], member));
      }
      const written = parts.columnSets.size > 0 || parts.docBuild !== null || parts.fallback;
      // a document is judged as the unit of work holds it, membership
      // arrays included, whenever the save changes it
      if (core.plan.document !== false && (written || parts.m2mMembers.size > 0))
        core.plan.checkMutation?.('update', record.snapshot, record.stamped, deferFor(record));
      if (!written) {
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
      coreFor(removal.entity).plan.writable?.();
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
    const resolveJoins = () => inOrder(joinOps.length, (i) => {
      const op = joinOps[i];
      if (op.beforeKeys !== null) return undefined;
      const sql = `SELECT ${q(op.targetColumn)} AS ${q('t')} FROM ${q(op.joinTable)} `
        + `WHERE ${q(op.ownColumn)} = ${parameterAt(1)}`;
      return chain(useStatementOnce(connection, sql, (statement) => statement.all([op.ownKey])), (rows) => {
        op.beforeKeys = rows.map((row) => op.targetValue(row.t));
      });
    });
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
      // a removal that a rolled-back save staged again, under a key an add()
      // staged after that save holds, runs ahead of every insert: the delete
      // and the insert keep the order they were staged in (see `restore`)
      const ahead = deletes.filter((removal) => removal.beforeInserts === true
        && records.get(keyOf(removal.entity, removal.parts))?.pendingInsert === true);
      // and so, child-first, does the removal of a row that references a row
      // deleted ahead — by its snapshot, or by its entity alone when it was
      // never read: a restricting reference would refuse that delete, and a
      // cascading one delete the row under its own guarded delete (JD2040).
      // A set-null reference keeps its place: the delete ahead only clears it
      /** The key of the row a reference names, as the tracker files it, or
       * null for none. @param {any} fk @param {any} value */
      const named = (fk, value) => (value === null || value === undefined ? null : keyOf(fk.references, [value]));
      /** Whether `removal` must be deleted before `parent`: it references
       * that row, by its snapshot's reference, or by its entity's when it
       * was never read; a set-null reference only clears.
       * @param {any} removal @param {any} parent */
      const under = (removal, parent) => mapping.entities[removal.entity].foreignKeys.some((/** @type {any} */ fk) =>
        fk.references === parent.entity && fk.onDelete !== 'setNull'
        && (removal.snapshot === null || named(fk, removal.snapshot[fk.column]) === keyOf(parent.entity, parent.parts)));
      const isAhead = new Set(ahead);
      for (let at = 0; at < ahead.length; at++) {
        const parent = ahead[at];
        for (const removal of deletes) {
          if (isAhead.has(removal) || records.get(keyOf(removal.entity, removal.parts))?.pendingInsert === true) continue;
          if (under(removal, parent)) {
            isAhead.add(removal);
            ahead.push(removal);
          }
        }
      }
      const behind = ahead.length === 0 ? deletes : deletes.filter((removal) => !isAhead.has(removal));
      const childFirst = (/** @type {any[]} */ list) => orderEntities(
        [...new Set(list.map((removal) => removal.entity))], 'deletes').reverse();
      const deleteOrder = childFirst(behind);
      // The updates around the deletes ahead: those whose row references a
      // row deleted ahead, by the reference it holds or the one it writes.
      // Where each runs follows from the references it CHANGES:
      //  - every changed reference names a row that exists before the deletes
      //    ahead — one that stays, or one deleted and not inserted again —
      //    (or it changes none): the update runs before those deletes, as the
      //    updates of any save run before its deletes. A child moved to a
      //    parent that stays leaves the deleted row first; one edited under it
      //    meets the delete as a straight save has it meet it.
      //  - a changed reference names a row this save inserts — a new one, or
      //    one deleted ahead and inserted again: the update must follow that
      //    insert and still precede the delete of the row it leaves. So that
      //    insert runs first — after the delete ahead of its own key and the
      //    removals that come along with that delete — then the update, then
      //    the other deletes ahead. Where no such order exists (an update
      //    leaves a row whose delete must come first: two children swapped
      //    between two re-added parents), these updates keep their usual
      //    place after every insert, and meet the deletes ahead first.
      /** @type {Map<string, any>} */
      const aheadAt = new Map(ahead.map((removal) => [keyOf(removal.entity, removal.parts), removal]));
      /** @type {Map<string, any>} the pending inserts that carry their key */
      const insertAt = new Map();
      if (ahead.length > 0) {
        for (const list of inserts.values()) {
          for (const record of list) {
            const key = recordKeyFor(record.entity, record.current);
            if (key !== null) insertAt.set(key, record);
          }
        }
      }
      /** @type {any[]} */
      const first = [];
      /** @type {{ update: any, needs: string[] }[]} */
      const around = [];
      for (const update of ahead.length === 0 ? [] : updates) {
        let touches = false;
        /** @type {string[]} */
        const needs = [];
        for (const fk of mapping.entities[update.record.entity].foreignKeys) {
          const was = named(fk, update.record.snapshot[fk.column]);
          const now = named(fk, update.record.stamped[fk.column]);
          if (aheadAt.has(/** @type {string} */ (was)) || aheadAt.has(/** @type {string} */ (now))) touches = true;
          if (now !== null && now !== was && insertAt.has(now)) needs.push(now);
        }
        if (!touches) continue;
        if (needs.length === 0) first.push(update);
        else around.push({ update, needs });
      }
      // what the `around` updates need first: the inserts they name, the
      // deletes ahead of those keys and the removals that come along
      const needed = new Set(around.flatMap(({ needs }) => needs));
      const earlyRemovals = new Set();
      for (const key of needed) {
        const removal = aheadAt.get(key);
        if (removal === undefined || earlyRemovals.has(removal)) continue;
        earlyRemovals.add(removal);
        for (let at = 0, pulled = [removal]; at < pulled.length; at++) {
          for (const child of ahead) {
            if (!earlyRemovals.has(child) && under(child, pulled[at])) { earlyRemovals.add(child); pulled.push(child); }
          }
        }
      }
      const earlyRecords = new Set([...needed].map((key) => insertAt.get(key)));
      // ... possible unless an update leaves a row deleted among them, or an
      // insert among them references a row inserted later, or one they
      // delete (a row deleted ahead later still exists when they run)
      const early = around.length > 0
        && around.every(({ update }) => mapping.entities[update.record.entity].foreignKeys.every((/** @type {any} */ fk) => {
          const was = named(fk, update.record.snapshot[fk.column]);
          return was === null || !earlyRemovals.has(aheadAt.get(was));
        }))
        && [...earlyRecords].every((record) => mapping.entities[record.entity].foreignKeys.every((/** @type {any} */ fk) => {
          const ref = named(fk, record.current[fk.column]);
          return ref === null || (insertAt.has(ref) ? needed.has(ref) : !earlyRemovals.has(aheadAt.get(ref)));
        }));
      const placed = new Set([...first, ...(early ? around.map(({ update }) => update) : [])]);
      const updatesAfter = placed.size === 0 ? updates : updates.filter((update) => !placed.has(update));

      /** @type {any[]} */
      const statements = [];

      /** One guarded (or plain) DELETE per removal, entity by entity.
       * @param {string[]} order @param {any[]} list */
      const pushDeletes = (order, list) => {
        for (const entityName of order) {
          const plan = coreFor(entityName).plan;
          for (const removal of list) {
            if (removal.entity !== entityName) continue;
            const params = plan.storedKey(removal.parts);
            const wheres = plan.keys.map((key, i) => `${q(plan.physicalName(key))} = ${parameterAt(i + 1)}`);
            const snapshotVersion = plan.version !== null && removal.snapshot !== null
              ? Number(removal.snapshot[plan.version]) || 0 : null;
            if (snapshotVersion !== null) {
              params.push(snapshotVersion);
              wheres.push(`${q(plan.physicalName(plan.version))} = ${parameterAt(params.length)}`);
            }
            statements.push({
              kind: 'delete', entity: entityName, removal,
              sql: `DELETE FROM ${plan.tableSql} WHERE ${wheres.join(' AND ')}`,
              params,
              guarded: snapshotVersion !== null,
            });
          }
        }
      };

      /** One UPDATE, guarded by the snapshot's version where there is one.
       * @param {{ record: any, parts: any }} update */
      const pushUpdate = ({ record, parts }) => {
        const plan = coreFor(record.entity).plan;
        const params = [];
        const assignments = [];
        // the members this statement sets, which an UPDATE OF rule reads
        const assigned = [];
        if (parts.fallback) {
          const split = plan.split(record.stamped);
          for (const value of split.values) {
            if (value.name === plan.version) continue;
            assignments.push(`${q(plan.physicalName(value.name))} = ${parameterAt(params.length + 1)}`);
            params.push(value.value);
            assigned.push(value.name);
          }
          if (plan.document !== false) {
            assignments.push(`${q('doc')} = ${dialect.jsonEncode(parameterAt(params.length + 1))}`);
            params.push(JSON.stringify(split.rest));
          }
        }
        else {
          for (const [name, value] of parts.columnSets) {
            assignments.push(`${q(plan.physicalName(name))} = ${parameterAt(params.length + 1)}`);
            params.push(value);
            assigned.push(name);
          }
          if (parts.docBuild !== null) {
            // numbered after the parameters ahead of it: a numbered engine's refs start at 1
            const built = parts.docBuild.build(q('doc'), params.length + 1);
            assignments.push(`${q('doc')} = ${built.expression}`);
            params.push(...built.params);
          }
        }
        const snapshotVersion = plan.version === null
          ? null : Number(record.snapshot[plan.version]) || 0;
        if (plan.version !== null) {
          assignments.push(`${q(plan.physicalName(plan.version))} = ${parameterAt(params.length + 1)}`);
          params.push(snapshotVersion + 1);
          assigned.push(plan.version);
        }
        const wheres = plan.storedKey(plan.keys.map((/** @type {string} */ key) => record.snapshot[key])).map((/** @type {any} */ part, /** @type {number} */ i) => {
          params.push(part);
          return `${q(plan.physicalName(plan.keys[i]))} = ${parameterAt(params.length)}`;
        });
        if (plan.version !== null) {
          params.push(snapshotVersion);
          wheres.push(`${q(plan.physicalName(plan.version))} = ${parameterAt(params.length)}`);
        }
        statements.push({
          kind: 'update', entity: record.entity, record, assigned,
          sql: `UPDATE ${plan.tableSql} SET ${assignments.join(', ')} `
            + `WHERE ${wheres.join(' AND ')}`,
          params,
          guarded: plan.version !== null,
          newVersion: plan.version === null ? null : snapshotVersion + 1,
        });
      };

      /** The INSERTs of the pending records `keep` admits, parent-first,
       * batched per column-name signature. @param {(record: any) => boolean} keep */
      const pushInserts = (keep) => {
        for (const entityName of insertOrder) {
          const plan = coreFor(entityName).plan;
          /** @type {Map<string, any[]>} */
          const shapes = new Map();
          for (const record of inserts.get(entityName)) {
            if (!keep(record)) continue;
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
            const paramsPerRow = names.length + (plan.document === false ? 0 : 1);
            const rowsPerBatch = names.length === 0 ? 1 : Math.max(1, Math.min(BATCH_ROW_BOUND,
              Math.floor(BATCH_PARAM_BUDGET / paramsPerRow)));
            for (let at = 0; at < group.length; at += rowsPerBatch) {
              const batch = group.slice(at, at + rowsPerBatch);
              const returning = plan.autoKey !== null && !names.includes(plan.autoKey);
              const rowSql = (base) => `(${[...names.map((_, i) => parameterAt(base + i + 1)),
                ...(plan.document === false ? [] : [dialect.jsonEncode(parameterAt(base + names.length + 1))])].join(', ')})`;
              const sql = (plan.document === false && names.length === 0 ? `INSERT INTO ${plan.tableSql} DEFAULT VALUES` : `INSERT INTO ${plan.tableSql} `
                + `(${[...names.map((n) => q(plan.physicalName(n))), ...(plan.document === false ? [] : [q('doc')])].join(', ')}) VALUES `
                + batch.map((_, i) => rowSql(i * paramsPerRow)).join(', '))
                + (returning ? ` RETURNING ${q(plan.physicalName(plan.autoKey))} AS ${q('key')}` : '');
              const params = batch.flatMap(({ split }) => [
                ...split.values.map((value) => value.value),
                ...(plan.document === false ? [] : [JSON.stringify(split.rest)]),
              ]);
              statements.push({
                kind: 'insert', entity: entityName, sql, params, returning,
                records: batch.map(({ record }) => record),
              });
            }
          }
        }
      };

      // 0. around the deletes an insert of the same key follows: the updates
      // that run before them; where an update needs an insert first, that
      // insert (its own delete ahead first) and the update; then the other
      // deletes ahead, child-first
      first.forEach(pushUpdate);
      if (early) {
        const removals = ahead.filter((removal) => earlyRemovals.has(removal));
        pushDeletes(childFirst(removals), removals);
        pushInserts((record) => earlyRecords.has(record));
        around.forEach(({ update }) => pushUpdate(update));
      }
      const later = early ? ahead.filter((removal) => !earlyRemovals.has(removal)) : ahead;
      pushDeletes(childFirst(later), later);

      // 1. inserts, parent-first, batched per column-name signature
      pushInserts(early ? (record) => !earlyRecords.has(record) : () => true);

      // 2. updates (inserts already exist; deletes still ahead)
      updatesAfter.forEach(pushUpdate);

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
      pushDeletes(deleteOrder, behind);

      return { statements, fallbacks, joinOnly, unversioned: [...unversioned].sort(), deferred };
    };
    return chain(resolveJoins(), assemble);
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

  const wrapDb = (error, statement) => wrapDriverError(error, {
    docPath: entities.get(statement.entity)?.docPath,
    collection: statement.entity,
  });

  /** The key argument `get` takes for a key's parts. @param {any} plan @param {any[]} parts */
  const keyArgument = (plan, parts) => (plan.keys.length === 1 ? parts[0]
    : Object.fromEntries(plan.keys.map((/** @type {string} */ key, /** @type {number} */ i) => [key, parts[i]])));

  /** The row a tracked record names, as `get` reads it. @param {any} record */
  const storedRowOf = (record) => {
    const core = coreFor(record.entity);
    return core.get(keyArgument(core.plan, core.plan.keys.map((/** @type {string} */ key) => record.snapshot[key])));
  };

  /** Whether a stored row still holds what a tracked snapshot says, relation
   * members (projections, never stored) aside.
   * @param {string} entityName @param {any} stored @param {any} snapshot */
  const holdsSnapshot = (entityName, stored, snapshot) => {
    const properties = entities.get(entityName).properties;
    /** @type {any} */
    const kept = {};
    for (const [name, value] of Object.entries(snapshot)) {
      if (properties.get(name)?.relation === undefined) setObjectMember(kept, name, value);
    }
    return createJSONPatch(kept, stored).length === 0;
  };

  /** Run checks one after another. @param {(() => any)[]} runs @returns {any} */
  const settleChecks = (runs) => inOrder(runs.length, (at) => runs[at]());

  /**
   * Run the save's statements in order. Each store rule is judged at its own
   * statement, inside the transaction: a document's rules that read another
   * row just before its statement; a column-only row's after its write,
   * against the row as it was (read first) and as it is stored; a delete
   * after the delete, against the row it removed, and then each row its
   * foreign-key actions removed or nulled, by that row's entity's rules. A
   * join-only document's rules run after every statement.
   * @param {any[]} statements @param {any} report
   * @param {Map<any, (() => any)[]>} deferred @param {any[]} joinOnly
   */
  const runStatements = (statements, report, deferred, joinOnly) => {
    const recordsOf = (statement) => (statement.kind === 'insert' ? statement.records
      : statement.kind === 'update' ? [statement.record] : []);
    // what a statement's rules need before it runs
    const ahead = (statement) => {
      const core = ['insert', 'update', 'delete'].includes(statement.kind) ? coreFor(statement.entity) : null;
      if (core === null) return null;
      const runs = recordsOf(statement).flatMap((record) => deferred.get(record) ?? []);
      // the row a rule judges, locked for the save's transaction (see `getLocked`)
      const read = statement.kind === 'update' && core.plan.document === false && core.plan.ruled('update')
        ? core.getLocked(statement.record.snapshot)
        : statement.kind === 'delete' && core.plan.ruled('delete')
          ? core.getLocked(keyArgument(core.plan, statement.removal.parts)) : undefined;
      return chain(read, (row) => {
        statement.before = row;
        return settleChecks(runs);
      });
    };
    /** Run statement `i`, its rules and its read-back. @param {number} i */
    const run = (i) => {
      const statement = statements[i];
      const advance = () => {
        if (statement.kind === 'delete') {
          if (!(statement.deletedRows > 0)) return undefined;
          return chain(statement.before === undefined ? undefined
            : coreFor(statement.entity).plan.checkMutation('delete', statement.before, null),
          () => (statement.cascade === undefined || statement.cascade.length === 0 ? undefined : judgeCascade(statement.cascade)));
        }
        if (!['insert', 'update'].includes(statement.kind) || coreFor(statement.entity).plan.document !== false) return undefined;
        const core = coreFor(statement.entity);
        const records = recordsOf(statement);
        statement.stored = [];
        return inOrder(records.length, (at) => {
          const record = records[at];
          const key = statement.returning ? { ...record.current, [core.plan.autoKey]: statement.generatedKeys[at] } : record.current;
          return chain(core.get(key), (stored) => {
            core.validateOnly(stored);
            return chain(statement.kind === 'insert' ? core.plan.checkStored('insert', null, stored)
              : core.plan.checkStored('update', statement.before, stored, statement.assigned), () => {
              statement.stored.push(deepFreeze(stored));
            });
          });
        });
      };
      // a join row whose own key the save allocates: the INSERT that
      // allocates it has already run (inserts precede join rows), so the
      // key is on the record by now
      if (statement.ownFrom !== undefined) {
        const ownKey = statement.ownFrom.allocatedKey;
        statement.params = statement.joinRows.flatMap(
          (/** @type {any} */ row) => [ownKey, row.target]);
        for (const row of statement.joinRows) row.own = ownKey;
      }
      const returning = statement.kind === 'insert' && statement.returning === true;
      // prepared for this statement alone and released as soon as it ran
      const execute = () => useStatementOnce(connection, statement.sql, (prepared) => {
        const call = () => (returning ? prepared.all(statement.params) : prepared.run(statement.params));
        // an insert is the entity core's own, so a duplicate key is JD2001
        // here exactly as it is on create()
        return statement.kind === 'insert'
          ? coreFor(statement.entity).plan.attemptInsert(call, statement.records.map((/** @type {any} */ record) => record.current))
          : attempt(call, (error) => wrapDb(error, statement));
      });
      // A tracked UPDATE assigns only the members the save changed, so its
      // journal images are the snapshot and the snapshot with those changes
      // only while the stored row still holds the snapshot. An earlier write
      // of the transaction (a foreign-key action nulling a member, a direct
      // write) leaves the snapshot stale; the row is then read again after the
      // statement, and the two stored rows are the images.
      const journalImage = statement.kind === 'update' && journal
        && coreFor(statement.entity).plan.document !== false;
      return chain(ahead(statement), () => chain(
        statement.kind === 'delete'
          ? chain(readCascade === null ? null : readCascade(statement.entity, statement.removal.parts), (closure) => {
            statement.cascade = closure?.entries ?? [];
            // a journal records a removal under the key its row is stored
            // under, so a removal no read loaded reads its row first ('16.0'
            // names the row 16): the closure's locked root, the row a rule
            // judges, or the row itself
            if (!journal || statement.removal.snapshot !== null) return undefined;
            const core = coreFor(statement.entity);
            return chain(closure?.root ?? statement.before
              ?? core.getLocked(keyArgument(core.plan, statement.removal.parts)), (row) => {
              statement.removedRow = row;
            });
          })
          : journalImage
            ? chain(storedRowOf(statement.record), (row) => { statement.journalBefore = row; })
            : null,
        () => chain(execute(), (outcome) => {
          if (returning) {
            // auto keys allocate monotonically in insertion order —
            // sort ascending to pair rows with records (asserted by
            // test, not assumed silently)
            const keys = outcome.map((row) => row.key).sort((a, b) => a - b);
            statement.generatedKeys = keys;
            // a join row planned against one of these records reads its
            // key from here, before the commit phase re-keys anything
            statement.records.forEach((record, at) => { record.allocatedKey = keys[at]; });
            report.inserted += statement.records.length;
            report.statements.push({ sql: statement.sql, rows: statement.records.length });
            return advance();
          }
          const changed = Number(outcome?.changes ?? 0);
          report.statements.push({ sql: statement.sql, rows: changed });
          if (statement.kind === 'insert') report.inserted += statement.records.length;
          else if (statement.kind === 'update') {
            if (changed === 0) throw conflict(statement);
            report.updated += 1;
            if (journalImage && !holdsSnapshot(statement.entity, statement.journalBefore, statement.record.snapshot)) {
              return chain(advance(), () => chain(storedRowOf(statement.record), (row) => {
                statement.journalAfter = row;
              }));
            }
          }
          else if (statement.kind === 'delete') {
            if (changed === 0 && statement.guarded) throw conflict(statement);
            statement.deletedRows = changed;
            report.deleted += changed;
          }
          else if (statement.kind === 'join-insert') report.joinInserted += changed;
          else if (statement.kind === 'join-delete') report.joinDeleted += changed;
          return advance();
        })));
    };
    return chain(inOrder(statements.length, run),
      () => chain(settleChecks(joinOnly.flatMap((record) => deferred.get(record) ?? [])), () => report));
  };

  /**
   * The tracker state a save's commit will advance, exactly as it stands
   * before the save runs: the map slot of every row the save writes — one
   * it inserts, updates, deletes, or advances through its join table
   * alone — with the fields of the record in it, and the pending removals
   * and membership deltas, which it clears whole. A slot is taken for an
   * update too: a re-read or a `discard()` after the save replaces or
   * drops the record the save advanced, and {@link restore} puts that
   * record back. Bounded by the save, never by the tracker's size.
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
    /** @param {any} record */
    const takeFields = (record) => {
      if (record === undefined || fields.has(record)) return;
      fields.set(record, {
        snapshot: record.snapshot, current: record.current,
        stamped: record.stamped, joinOnly: record.joinOnly,
        pendingInsert: record.pendingInsert, saved: record.saved,
        allocatedKey: record.allocatedKey,
      });
    };
    /** @param {string} key @param {any} record */
    const take = (key, record) => {
      if (!slots.has(key)) slots.set(key, records.get(key));
      takeFields(record);
    };
    for (const statement of statements) {
      if (statement.kind === 'insert') {
        for (const record of statement.records) take(record.pendingKey, record);
      }
      // a record the save updates is the one filed under its own key, so
      // `restore` puts it back there (`slotsOf`): no slot to take for it
      else if (statement.kind === 'update') takeFields(statement.record);
      else if (statement.kind === 'delete') {
        const key = keyOf(statement.removal.entity, statement.removal.parts);
        take(key, records.get(key));
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

  /** The slots a save's undo puts back: those it took (inserted and deleted
   * rows), and the slot of each record it advanced in place (updated, or
   * advanced through its join table alone), which held that record.
   * @param {any} undo @returns {[string, any][]} */
  const slotsOf = (undo) => {
    const out = [...undo.slots];
    for (const [record, was] of undo.fields) {
      if (was.pendingInsert === true) continue;
      const key = record.key ?? recordKeyFor(record.entity, was.snapshot);
      if (key !== null && !undo.slots.has(key)) out.push([key, record]);
    }
    return out;
  };

  /** Merge a later delta's words into an earlier one: the later word on
   * each target wins. @param {any} earlier @param {any} later */
  const mergeLater = (earlier, later) => {
    for (const key of later.links) { earlier.unlinks.delete(key); earlier.links.add(key); }
    for (const key of later.unlinks) { earlier.links.delete(key); earlier.unlinks.add(key); }
  };

  /**
   * Withdraw a save's advance once the transaction around it rolled back:
   * its statements are gone, so every claim they made about the database
   * is withdrawn and a retry plans them again.
   *
   * The invariant: after a rolled-back save the tracker holds exactly what
   * it held before the save plus whatever was staged after it, and every
   * word staged after it stays with the row it belongs to. A word names
   * its row by the key the save gave it — the key an INSERT allocated, or
   * the record a re-read filed in place of the one the save advanced — and
   * the rollback takes that key back, so each word moves onto the row as
   * it stood before the save:
   * - an edit (`put`) is the pre-save record's current document again — a
   *   pending insert's too, without the key the save allocated, which names
   *   no row any more, and with the version `add()` started it at;
   * - a `remove()` of a row the save inserted is a `remove()` of a pending
   *   insert, which cancels both and the memberships filed for the row; a
   *   removal of a row the save updated is guarded by the version the row
   *   had before the save, and a removal of a row it deleted is the save's
   *   own removal again;
   * - a `link()`/`unlink()` filed under an allocated key is filed against
   *   the pending insert again, after the save's own deltas, so a later word
   *   on one target is still the last word;
   * - a `discard()` or a re-read after the save drops only what was staged
   *   after it: what the save cleared is pending again;
   * - an `add()` staged after the save holds its key as staged — behind the
   *   removal of a key the save deleted (the next save deletes, then
   *   inserts), and with the deltas filed under that key.
   * The document `add()` returned still names its pending insert.
   * @param {any} undo
   */
  const restore = (undo) => {
    /** @type {{ key: string, record: any }[]} */
    const inserted = undo.inserted ?? [];
    /** Whether `key` holds an insert an add() staged after the save:
     * nothing the save took, so it stays exactly as it was staged. */
    const stagedAfter = (/** @type {string} */ key) => {
      const now = records.get(key);
      return now !== undefined && now.pendingInsert === true && !undo.fields.has(now);
    };
    /** The edit staged after the save, by the pre-save record it belongs to.
     * @type {Map<any, any>} */
    const later = new Map();
    /** The pre-save pending insert behind each key the save allocated.
     * @type {Map<string, any>} */
    const allocated = new Map();
    // a row the save inserted: its key holds the saved record, a re-read
    // of it, or nothing after a discard() — an allocated one names no row
    for (const { key, record } of inserted) {
      const now = records.get(key);
      const auto = key !== record.pendingKey;
      if (now !== undefined && now.pendingInsert !== true && now.current !== now.snapshot)
        later.set(record, auto ? withoutKey(record.entity, now.current) : now.current);
      if (!auto || stagedAfter(key)) continue;
      allocated.set(key, record);
      records.delete(key);
    }
    /** The keys of the rows an edit staged after the save names. @type {Set<string>} */
    const editedAfter = new Set();
    /** The record the save gave each row it inserted. @type {Map<any, any>} */
    const savedOf = new Map(inserted.map(({ record, saved }) => [record, saved]));
    /** Whether a later add() replaced the pre-save record at a key — or the
     * record the save gave its row — and a remove() then cancelled that add.
     * @param {any} entry */
    const isWithdrawn = (entry) => withdrawn.has(entry) || withdrawn.has(savedOf.get(entry));
    /** @type {{ key: string, record: any }[]} */
    const cancelled = [];
    // every slot the save took holds its pre-save record again, with the
    // edit made after the save on whatever record replaced it there; a slot
    // that held none keeps a record holding such an edit, and the next save
    // meets whether its row exists
    for (const [key, entry] of slotsOf(undo)) {
      if (stagedAfter(key)) continue;
      const now = records.get(key);
      const edited = now !== undefined && now.pendingInsert !== true && now.current !== now.snapshot;
      if (edited) editedAfter.add(key);
      if (entry !== undefined && edited && !later.has(entry)) later.set(entry, now.current);
      if (entry !== undefined && now === undefined && isWithdrawn(entry)) {
        // `add(); remove()` after the save, of a key the save wrote: the
        // add replaced what the save left there, and the remove() cancelled
        // both — as it would have cancelled the pre-save record's staging
        cancelled.push({ key, record: entry });
        continue;
      }
      if (entry !== undefined) records.set(key, entry);
      else if (!edited) records.delete(key);
    }
    for (const [record, was] of undo.fields) {
      const edit = later.get(record);
      record.snapshot = was.snapshot;
      record.current = edit === undefined ? was.current
        : was.pendingInsert === true ? deepFreeze(keepVersion(record.entity, edit, was.current)) : edit;
      record.stamped = was.stamped;
      record.joinOnly = was.joinOnly;
      record.pendingInsert = was.pendingInsert;
      record.saved = was.saved;
      record.allocatedKey = was.allocatedKey;
    }
    // a removal staged after the save, on its row
    const insertedAt = new Map(inserted.map(({ key, record }) => [key, record]));
    for (const [key, removal] of [...removals]) {
      const record = insertedAt.get(key);
      if (record !== undefined && record.pendingInsert === true) {
        removals.delete(key);
        if (records.get(record.pendingKey) === record) records.delete(record.pendingKey);
        cancelled.push({ key, record });
        continue;
      }
      const row = records.get(key);
      if (row !== undefined && row.pendingInsert !== true && undo.fields.has(row))
        removals.set(key, { ...removal, snapshot: row.snapshot });
    }
    for (const [key, removal] of undo.removals) {
      // an edit staged after the save, of the row it deleted, is a put() of
      // a row whose removal is pending: the replacement, which cancels the
      // removal — unless a removal staged later still is the last word
      const row = records.get(key);
      if (editedAfter.has(key) && row !== undefined && row.pendingInsert !== true && !removals.has(key)) continue;
      // the save deleted the key before an add() staged after it inserted
      // it again: the next save runs this delete ahead of its inserts
      if (stagedAfter(key) || removals.get(key)?.beforeInserts === true) removal.beforeInserts = true;
      removals.set(key, removal);
    }
    for (const [id, pending] of [...memberships]) {
      if (pending.ownRecord !== undefined) continue;
      const record = allocated.get(keyOf(pending.entity, [pending.ownKey]));
      if (record === undefined) continue;
      memberships.delete(id);
      const refiled = `${record.pendingKey}${UNIT_SEPARATOR}${pending.member}`;
      const there = memberships.get(refiled);
      if (there === undefined) memberships.set(refiled, { ...pending, ownKey: undefined, ownRecord: record });
      else mergeLater(there, pending);
    }
    for (const [id, planned] of undo.memberships) {
      const live = memberships.get(id);
      if (live !== undefined) mergeLater(planned, live);
      memberships.set(id, planned);
    }
    for (const { key, record } of cancelled) {
      dropMemberships([key, record.pendingKey].filter((one) => one !== undefined && !stagedAfter(one)), record);
    }
  };

  /**
   * Advance phase: runs as soon as every statement of the save has
   * succeeded — inside an enclosing transaction too, where the database
   * already holds these rows and every later read, plan and optimistic
   * guard must agree. What is registered as a settlement effect is only
   * the WITHDRAWAL of this advance ({@link restore} over `undo`), which
   * the owning scope runs if it rolls back.
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
          const doc = statement.stored?.[i] ?? (statement.returning === true
            ? deepFreeze({ ...planned, [plan.autoKey]: statement.generatedKeys[i] })
            : planned);
          // re-key under the real identity: the key it was staged under,
          // unless the database allocated it or a read-back stored the row
          records.delete(record.pendingKey);
          const key = statement.returning === true || statement.stored !== undefined
            ? recordKeyFor(statement.entity, doc) : record.pendingKey;
          const saved = {
            entity: statement.entity, snapshot: doc,
            current: untouched(record) ? doc : record.current, pendingInsert: false, key,
          };
          (undo.inserted ??= []).push({ key, record, saved });
          records.set(/** @type {string} */ (key), saved);
          record.saved = doc;
          const keyParts = plan.keys.map((/** @type {string} */ k) => doc[k]);
          captureRecord?.(statement.entity, keyParts, null, doc, plan.keyValues(keyParts));
        });
      }
      else if (statement.kind === 'update') {
        const record = statement.record;
        const plan = coreFor(statement.entity).plan;
        const before = record.snapshot;
        const saved = statement.stored?.[0] ?? (statement.newVersion === null
          ? record.stamped
          : deepFreeze({ ...record.stamped, [plan.version]: statement.newVersion }));
        const pending = untouched(record) ? null : record.current;
        record.snapshot = deepFreeze(saved);
        record.current = pending ?? record.snapshot;
        record.stamped = undefined;
        // a stale snapshot is no image of the row: the stored rows read
        // around the statement are (see `runStatements`)
        const stale = statement.journalAfter !== undefined;
        const keyParts = plan.keys.map((/** @type {string} */ k) => record.snapshot[k]);
        captureRecord?.(statement.entity, keyParts,
          stale ? statement.journalBefore : before, stale ? statement.journalAfter : record.snapshot,
          plan.keyValues(keyParts));
      }
      else if (statement.kind === 'delete') {
        const removal = statement.removal;
        const removedKey = keyOf(removal.entity, removal.parts);
        records.delete(removedKey);
        if (removals.get(removedKey) === removal) removals.delete(removedKey);
        if ((statement.deletedRows ?? 0) > 0) {
          // under the key the row holds, as its insert recorded it: the row
          // a read loaded, or the one a journal read before the statement
          const plan = coreFor(removal.entity).plan;
          const row = removal.snapshot ?? statement.removedRow ?? null;
          captureRecord?.(removal.entity, row === null ? removal.parts
            : plan.keys.map((/** @type {string} */ key) => row[key]),
          row ?? undefined, null, plan.keyValues(removal.parts));
          // the rows the database's foreign-key actions changed with it
          for (const entry of statement.cascade ?? []) {
            captureRecord?.(entry.table, entry.keyParts, entry.before, entry.after,
              entities.has(entry.table) ? coreFor(entry.table).plan.keyValues(entry.keyParts) : entry.keyParts);
          }
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
            captureRecord?.(statement.entity, keyParts, null, ordered, keyParts);
          }
          else {
            captureRecord?.(statement.entity, keyParts, undefined, null, keyParts);
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
    // what the save planned is persisted; anything staged while it ran
    // (an asynchronous driver lets the caller in between) stays pending
    for (const [key, removal] of undo.removals) {
      if (removals.get(key) === removal) removals.delete(key);
    }
    for (const [id, planned] of undo.memberships) {
      const live = memberships.get(id);
      if (live === undefined) continue;
      for (const key of planned.links) live.links.delete(key);
      for (const key of planned.unlinks) live.unlinks.delete(key);
      if (live.links.size === 0 && live.unlinks.size === 0) memberships.delete(id);
    }
  };

  const saveChanges = () => {
    const startedAt = performance.now();
    return chain(planSave(), ({ statements, fallbacks, joinOnly, unversioned, deferred }) => {
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
    // A save with nothing to write still settles what it resolved: a
    // membership delta that is a no-op against the join table (a link() of a
    // member there, an unlink() of one not there) and a join-only record
    // whose member already holds what it carries stay pending no longer,
    // and an enclosing rollback stages them again. With nothing to settle
    // either, the save is over.
    const writes = statements.length > 0;
    if (!writes && memberships.size === 0 && joinOnly.length === 0) {
      return chain(settleChecks(joinOnly.flatMap((record) => deferred.get(record) ?? [])), () => {
        report.elapsedMs = performance.now() - startedAt;
        return report;
      });
    }
    // what the tracker looked like before the save, taken while it still
    // does: the statements below run in a savepoint whose release is not
    // a commit, so the right to KEEP what they justify waits for one
    const undo = undoFor(statements, joinOnly);
    // the savepoint itself can refuse — a PostgreSQL transaction an earlier
    // failure spent — and answers as its statements would (`JD2088`)
    return chain(
      writes ? attempt(() => connection.transaction(() => runStatements(statements, report, deferred, joinOnly)), (error) => wrapDriverError(error))
        : chain(settleChecks(joinOnly.flatMap((record) => deferred.get(record) ?? [])), () => report),
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

  /** Drop tracking for a key without scheduling anything — its pending
   * removal included, so a `remove()` the caller changed their mind
   * about (or one that failed its optimistic guard) is not re-planned by
   * every later save. */
  const discard = (entityName, keyOrDoc) => {
    const parts = coreFor(entityName).normalizeKey(keyOrDoc);
    const key = keyOf(entityName, parts);
    records.delete(key);
    removals.delete(key);
    // a pending membership change belongs to the key it attaches to
    dropMemberships([key]);
  };

  /** What withdraws the tracking of a row an immediate write stored inside
   * a transaction, once that transaction rolls back: the row as written is
   * gone, so its clean record goes — and, for a row the write created, the
   * `link()`/`unlink()` changes staged on it since, which belonged to that
   * row. A record holding staged work stays, with its changes, and the save
   * meets the row's absence. Taken when the write lands.
   * @param {string} entityName @param {any} doc @param {boolean} created
   * @returns {() => void} */
  const unwritten = (entityName, doc, created) => {
    const key = recordKeyFor(entityName, doc);
    if (key === null) return () => {};
    const members = created ? [...entities.get(entityName).properties.values()]
      .filter((property) => property.relation?.kind === 'manyToMany').map((property) => property.name) : [];
    /** the changes staged on the row before the write, by member */
    const was = new Map(members.flatMap((member) => {
      const pending = memberships.get(`${key}${UNIT_SEPARATOR}${member}`);
      return pending === undefined ? [] : [[member, { ...pending, links: new Set(pending.links), unlinks: new Set(pending.unlinks) }]];
    }));
    return () => {
      const record = records.get(key);
      if (record !== undefined && (record.pendingInsert === true || record.current !== record.snapshot)) return;
      records.delete(key);
      for (const member of members) {
        const id = `${key}${UNIT_SEPARATOR}${member}`;
        const before = was.get(member);
        if (before === undefined) memberships.delete(id);
        else memberships.set(id, { ...before, links: new Set(before.links), unlinks: new Set(before.unlinks) });
      }
    };
  };

  const assertSqlWritable = () => {
    if (removals.size || memberships.size || [...records.values()].some((r) => r.pendingInsert || r.current !== r.snapshot))
      throw new DbRuntimeError('JD2041', 'SQL the store did not plan requires saving or discarding pending tracked changes first');
  };
  const invalidate = () => { assertSqlWritable(); records.clear(); };
  return {
    assertSqlWritable, invalidate,
    register, registerGraph, add, put, remove, discard, unwritten, link, unlink, counts, saveChanges,
  };
}
