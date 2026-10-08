//@ts-check
/**
 * The foreign-key action corpus: a model whose deletes reach every edge a
 * store declares — one-to-many `cascade` two levels deep, `setNull`, a
 * composite-key child, a row reachable through a `setNull` and a `cascade`
 * edge at once, a self reference and memberships on both endpoints — its
 * seed, a workload over the store's delete paths, and the records session
 * capture writes for it. Beside it, a trial model widened to every shape a
 * delete's closure meets, the complete logical state a store's records
 * address, and a seeded random workload that checks every record it commits
 * against that state. Last, the timed scenario of a replicated cascading
 * delete.
 */
import * as assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { mulberry32 } from '@jarenjs/core/random';
import { applyJSONPatch } from '@jarenjs/json/patch';
import { compileEntityModel, encodeReplication } from '@jarenjs/db';

/** @param {string} [type] */
const key = (type = 'string') => ({ type, 'x-entity': { key: true } });
/** @param {string} to @param {string} via @param {string} onDelete */
const many = (to, via, onDelete) => ({ 'x-entity': { relation: { to, many: true, via, onDelete } } });

/** A fresh copy of the corpus model. @returns {any} */
export const cascadeModel = () => ({ $model: '0.1', entities: {
  Parent: { schema: { type: 'object', required: ['id'], properties: {
    id: key(), name: { type: 'string' },
    children: many('Child', 'parentId', 'cascade'), notes: many('Note', 'parentId', 'setNull'),
    pairs: many('Pair', 'parentId', 'cascade'), weak: many('Mixed', 'parentRef', 'setNull'),
    tags: { 'x-entity': { relation: { to: 'Tag', many: true } } } } } },
  Child: { schema: { type: 'object', required: ['id', 'parentId'], properties: {
    id: key(), parentId: { type: 'string' }, n: { type: 'integer' },
    grands: many('Grand', 'childId', 'cascade'), mixed: many('Mixed', 'childRef', 'cascade'),
    labels: { 'x-entity': { relation: { to: 'Label', many: true } } } } } },
  Grand: { schema: { type: 'object', required: ['id', 'childId'], properties: { id: key(), childId: { type: 'string' } } } },
  Note: { schema: { type: 'object', required: ['id'], properties: {
    id: key(), parentId: { type: ['string', 'null'] }, body: { type: 'string' } } } },
  Pair: { schema: { type: 'object', required: ['a', 'b', 'parentId'], properties: {
    a: key(), b: key('integer'), parentId: { type: 'string' } } } },
  Mixed: { schema: { type: 'object', required: ['id', 'childRef'], properties: {
    id: key(), parentRef: { type: ['string', 'null'] }, childRef: { type: 'string' } } } },
  Node: { schema: { type: 'object', required: ['id'], properties: {
    id: key(), up: { type: ['string', 'null'] }, kids: many('Node', 'up', 'cascade') } } },
  Tag: { schema: { type: 'object', required: ['id'], properties: { id: key() } } },
  Label: { schema: { type: 'object', required: ['id'], properties: { id: key() } } },
} });

/** Store the corpus rows, one commit each. @param {any} store */
export async function seedCascade(store) {
  await store.entity('Tag').create({ id: 't1' });
  await store.entity('Label').create({ id: 'l1' });
  await store.entity('Parent').create({ id: 'p', name: 'P', tags: ['t1'] });
  await store.entity('Parent').create({ id: 'q', name: 'Q' });
  await store.entity('Child').create({ id: 'c1', parentId: 'p', n: 1, labels: ['l1'] });
  await store.entity('Child').create({ id: 'c2', parentId: 'p', n: 2 });
  await store.entity('Child').create({ id: 'c3', parentId: 'q', n: 3 });
  await store.entity('Grand').create({ id: 'g1', childId: 'c1' });
  await store.entity('Grand').create({ id: 'g3', childId: 'c3' });
  await store.entity('Note').create({ id: 'n1', parentId: 'p', body: 'x' });
  await store.entity('Note').create({ id: 'n2', parentId: 'q' });
  await store.entity('Pair').create({ a: 'x', b: 1, parentId: 'p' });
  await store.entity('Mixed').create({ id: 'm1', parentRef: 'p', childRef: 'c2' });
  await store.entity('Mixed').create({ id: 'm2', parentRef: 'p', childRef: 'c3' });
  await store.entity('Node').create({ id: 'a', up: null });
  await store.entity('Node').create({ id: 'b', up: 'a' });
  await store.entity('Node').create({ id: 'c', up: 'b' });
}

/**
 * Three commits over the store's delete paths: a tracked save that updates
 * `Child c3` and removes its parent `q`; a transaction that deletes `Parent p`
 * and creates `c1` again under a new `Parent r`; a self-referencing delete of
 * `Node a`. The caller commits the fourth, the delete of `Parent r`.
 * @param {any} store
 * @param {() => any} [after] - awaited after each commit
 */
export async function cascadeWorkload(store, after = () => undefined) {
  const child = await store.entity('Child').get('c3');
  store.entity('Child').put({ ...child, n: 99 });
  store.entity('Parent').remove('q');
  await store.saveChanges();
  await after();
  await store.transaction(async (/** @type {any} */ tx) => {
    await tx.entity('Parent').delete('p');
    await tx.entity('Parent').create({ id: 'r' });
    await tx.entity('Child').create({ id: 'c1', parentId: 'r', n: 7 });
  });
  await after();
  await store.entity('Node').delete('a');
  await after();
}

/** A JSON value with its object members sorted at every depth. @param {any} value @returns {any} */
const sorted = (value) => (value === null || typeof value !== 'object' ? value
  : Array.isArray(value) ? value.map(sorted)
    : Object.fromEntries(Object.keys(value).sort().map((name) => [name, sorted(value[name])])));

/**
 * One record's patch as sorted lines `<op> <path>[ <value>]`. Each value is
 * serialized with its object members sorted: session capture builds an `add`
 * value from the stored columns, journal capture from the written document,
 * so the same row can list its members in either order.
 * @param {any[]} patch
 * @returns {string[]}
 */
export const canonicalPatch = (patch) => patch.map((op) =>
  `${op.op} ${op.path}${op.value === undefined ? '' : ` ${JSON.stringify(sorted(op.value))}`}`).sort();

/** The records session capture writes for the workload and the delete of
 * `Parent r` that follows it, each through {@link canonicalPatch}. */
export const CASCADE_RECORDS = Object.freeze([
  ['remove /Child/c3', 'remove /Grand/g3', 'remove /Mixed/m2', 'remove /Note/n2/parentId', 'remove /Parent/q'],
  ['add /Parent/r {"id":"r"}', 'remove /Child/c2', 'remove /Child_Label/["c1","l1"]', 'remove /Grand/g1',
    'remove /Mixed/m1', 'remove /Note/n1/parentId', 'remove /Pair/["x",1]', 'remove /Parent/p',
    'remove /Parent_Tag/["p","t1"]', 'replace /Child/c1/n 7', 'replace /Child/c1/parentId "r"'],
  ['remove /Node/a', 'remove /Node/b', 'remove /Node/c'],
  ['remove /Child/c1', 'remove /Parent/r'],
]);

/**
 * A fresh copy of the trial model: the corpus model widened to every shape a
 * delete's closure meets — a one-to-one `cascade` key declared on the
 * referencing side (`Passport`), a row two `setNull` keys can name at once
 * (`Link`), a `restrict` key that refuses the delete (`Lock`), and a
 * composite-key child under a self reference whose rows can close a data
 * cycle (`Pair` under `Node`). `Node` precedes `Pair`: PostgreSQL creates the
 * tables in model order and refuses a reference to one not created yet.
 * @returns {any}
 */
export const trialModel = () => ({ $model: '0.1', entities: {
  Parent: { schema: { type: 'object', required: ['id'], properties: {
    id: key(), name: { type: 'string' },
    children: many('Child', 'parentId', 'cascade'), notes: many('Note', 'parentId', 'setNull'),
    weak: many('Mixed', 'parentRef', 'setNull'), outLinks: many('Link', 'fromId', 'setNull'),
    inLinks: many('Link', 'toId', 'setNull'), locks: many('Lock', 'parentId', 'restrict'),
    tags: { 'x-entity': { relation: { to: 'Tag', many: true } } } } } },
  Passport: { schema: { type: 'object', required: ['id', 'ownerId'], properties: {
    id: key(), ownerId: { type: 'string' },
    owner: { 'x-entity': { relation: { to: 'Parent', via: 'ownerId', onDelete: 'cascade' } } } } } },
  Child: { schema: { type: 'object', required: ['id', 'parentId'], properties: {
    id: key(), parentId: { type: 'string' }, n: { type: 'integer' },
    grands: many('Grand', 'childId', 'cascade'), mixed: many('Mixed', 'childRef', 'cascade'),
    labels: { 'x-entity': { relation: { to: 'Label', many: true } } } } } },
  Grand: { schema: { type: 'object', required: ['id', 'childId'], properties: { id: key(), childId: { type: 'string' } } } },
  Note: { schema: { type: 'object', required: ['id'], properties: {
    id: key(), parentId: { type: ['string', 'null'] }, body: { type: 'string' } } } },
  Mixed: { schema: { type: 'object', required: ['id', 'childRef'], properties: {
    id: key(), parentRef: { type: ['string', 'null'] }, childRef: { type: 'string' } } } },
  Link: { schema: { type: 'object', required: ['id'], properties: {
    id: key(), fromId: { type: ['string', 'null'] }, toId: { type: ['string', 'null'] } } } },
  Lock: { schema: { type: 'object', required: ['id', 'parentId'], properties: { id: key(), parentId: { type: 'string' } } } },
  Node: { schema: { type: 'object', required: ['id'], properties: {
    id: key(), up: { type: ['string', 'null'] },
    kids: many('Node', 'up', 'cascade'), pairs: many('Pair', 'nodeId', 'cascade') } } },
  Pair: { schema: { type: 'object', required: ['a', 'b', 'nodeId'], properties: {
    a: key(), b: key('integer'), nodeId: { type: 'string' } } } },
  Tag: { schema: { type: 'object', required: ['id'], properties: { id: key() } } },
  Label: { schema: { type: 'object', required: ['id'], properties: { id: key() } } },
} });

/**
 * @typedef {{ entities: { name: string, keys: string[], relations: string[] }[],
 *   joins: { table: string, columns: string[] }[] }} StateLayout - the tables
 *   of a model's complete logical state: each entity with its key members and
 *   its relation members, each join table with its two columns in table order
 */

/** @type {WeakMap<object, StateLayout>} */
const layouts = new WeakMap();

/** The tables a model's complete logical state holds. @param {any} model @returns {StateLayout} */
const layoutOf = (model) => {
  let layout = layouts.get(model);
  if (layout === undefined) {
    const { mapping } = compileEntityModel(model);
    layout = {
      entities: Object.entries(model.entities).map(([name, entity]) => ({ name, keys: mapping.entities[name].keys,
        relations: Object.entries(entity.schema.properties)
          .filter(([, member]) => member['x-entity']?.relation !== undefined).map(([member]) => member) })),
      joins: Object.entries(mapping.joinTables).map(([table, join]) =>
        ({ table, columns: [join.left.column, join.right.column] })),
    };
    layouts.set(model, layout);
  }
  return layout;
};

/** The capture key token of a row: one key part as a string, several as a JSON array. @param {any[]} parts */
const tokenOf = (parts) => (parts.length === 1 ? String(parts[0]) : JSON.stringify(parts));

/**
 * The complete logical state of a store opened with `model`, addressed as its
 * capture records address it: `{ [entity]: { [token]: document },
 * [joinTable]: { [token]: membership } }`, every entity read without tracking
 * and with its relation members deleted, every join table through its query
 * root. A record's paths (`/<table>/<token>/…`) point into this object, so
 * `applyJSONPatch(state, record.patch)` is a patch-only consumer of the store.
 * @param {any} store
 * @param {any} model - the model the store was opened with
 * @returns {Promise<Record<string, Record<string, any>>>}
 */
export async function storeState(store, model) {
  const layout = layoutOf(model);
  /** @type {Record<string, Record<string, any>>} */
  const state = {};
  for (const { name, keys, relations } of layout.entities) {
    /** @type {Record<string, any>} */
    const rows = {};
    for (const row of await store.entity(name).asNoTracking().load({})) {
      const document = { ...row };
      for (const member of relations) delete document[member];
      rows[tokenOf(keys.map((part) => row[part]))] = document;
    }
    state[name] = rows;
  }
  for (const { table, columns } of layout.joins) {
    /** @type {Record<string, any>} */
    const rows = {};
    for (const row of await store.execute([{ $for: { j: `$.${table}[*]` }, $return: '$j' }]))
      rows[tokenOf(columns.map((column) => row[column]))] = row;
    state[table] = rows;
  }
  return state;
}

/**
 * Fold `records` over `before` as a patch-only consumer does and require the
 * result to deep-equal `after` (object members compare in any order); a
 * record that does not apply is reported the same way, as an assertion.
 * @param {any} before - the complete logical state before the transaction
 * @param {{ patch: any[] }[]} records - what the transaction committed, in order
 * @param {any} after - the complete logical state after it
 */
export function checkRecords(before, records, after) {
  let state = before;
  for (const [at, record] of records.entries()) {
    try { state = applyJSONPatch(state, record.patch); }
    catch (error) { assert.fail(`record ${at} does not apply: ${/** @type {Error} */ (error).message}`); }
  }
  assert.deepStrictEqual(state, after);
}

/** The message of the error that rolls a savepoint back on purpose. */
const UNDONE = 'rolled back on purpose';

/**
 * A seeded random workload over a store opened with {@link trialModel}, run
 * on every delete path a journal records: a grow transaction (a parent with
 * memberships and a passport, three children with labels, a grandchild, a
 * note, a mixed row, a link between two parents, sometimes a lock, a node
 * mostly under an older one — sometimes re-pointing an older node at it,
 * which can close a data cycle — and a pair under it); a direct `delete` of
 * a row of `Parent`, `Child`, `Node`, `Tag` or `Label`; a tracked save that
 * `put`s up to three children and `remove`s a parent; a transaction that
 * deletes a child's parent and creates the child again under a new parent;
 * and a transaction whose nested savepoint deletes a parent and rolls back,
 * whose delete of a locked parent is refused, and which then creates a tag.
 *
 * Each operation commits at most one transaction and is followed by the
 * check ({@link checkRecords}): what it committed, folded over the complete
 * logical state before it, gives the state after it. A delete refused
 * `JD2005` — by a `restrict` key, or by an engine whose foreign-key actions
 * refuse it — commits nothing, and a refused save's staged changes are
 * discarded. Every choice comes from `mulberry32(seed)` over sorted keys, so
 * a seed is the same workload wherever the database answers its deletes
 * alike.
 * @param {any} store - empty, opened with {@link trialModel} and capture on
 * @param {number} seed
 * @param {number} operations
 * @param {{ sync?: boolean, savepointRefusals?: boolean, after?: () => any }} [options]
 *   - `sync`: half the direct deletes run through `store.sync`;
 *   `savepointRefusals`: the refused delete inside a transaction always runs in
 *   a savepoint of its own (a PostgreSQL transaction is aborted by a failed
 *   statement), where otherwise half of them are caught in the transaction
 *   itself; `after`: awaited after each operation's check
 * @returns {Promise<{ records: string[][], operations: Record<string, number>, refused: number }>}
 *   every committed record through {@link canonicalPatch}, how often each
 *   operation ran, and how many deletes were refused
 */
export async function randomWorkload(store, seed, operations,
  { sync = false, savepointRefusals = false, after = () => undefined } = {}) {
  if (sync && store.sync === undefined) throw new TypeError('a synchronous workload needs store.sync');
  const model = trialModel();
  const random = mulberry32(seed);
  /** @template T @param {T[]} items @returns {T} */
  const pick = (items) => items[Math.floor(random() * items.length)];
  let serial = 0;
  /** @param {string} prefix */
  const fresh = (prefix) => `${prefix}${seed}_${serial++}`;
  /** @type {any[]} */
  const records = [];
  /** @type {Record<string, number>} */
  const counts = { grow: 0, delete: 0, save: 0, reparent: 0, savepoint: 0 };
  let refused = 0;
  let state = await storeState(store, model);
  /** @param {string} name */
  const keysOf = (name) => Object.keys(state[name]).sort();
  /** Run `write`; a refused delete commits nothing. @param {() => any} write */
  const refusable = async (write) => {
    try { await write(); }
    catch (error) {
      if (/** @type {any} */ (error)?.code !== 'JD2005') throw error;
      refused += 1;
    }
  };

  const grow = () => store.transaction(async (/** @type {any} */ tx) => {
    const tags = keysOf('Tag');
    const labels = keysOf('Label');
    if (tags.length === 0 || random() < 0.3) {
      const tag = fresh('T');
      await tx.entity('Tag').create({ id: tag });
      tags.push(tag);
    }
    if (labels.length === 0 || random() < 0.3) {
      const label = fresh('B');
      await tx.entity('Label').create({ id: label });
      labels.push(label);
    }
    const parent = fresh('P');
    await tx.entity('Parent').create({ id: parent, name: parent, tags: tags.filter(() => random() < 0.5) });
    await tx.entity('Passport').create({ id: fresh('S'), ownerId: parent });
    const parents = [...keysOf('Parent'), parent];
    const children = keysOf('Child');
    for (let n = 0; n < 3; n += 1) {
      const child = fresh('C');
      await tx.entity('Child').create({ id: child, parentId: pick(parents), n,
        labels: labels.filter(() => random() < 0.4) });
      children.push(child);
    }
    await tx.entity('Grand').create({ id: fresh('G'), childId: pick(children) });
    await tx.entity('Note').create({ id: fresh('N'), parentId: random() < 0.8 ? pick(parents) : null, body: 'b' });
    await tx.entity('Mixed').create({ id: fresh('M'), parentRef: random() < 0.8 ? pick(parents) : null, childRef: pick(children) });
    await tx.entity('Link').create({ id: fresh('L'), fromId: pick(parents), toId: pick(parents) });
    if (random() < 0.2) await tx.entity('Lock').create({ id: fresh('K'), parentId: pick(parents) });
    const nodes = keysOf('Node');
    const node = fresh('D');
    await tx.entity('Node').create({ id: node, up: nodes.length > 0 && random() < 0.8 ? pick(nodes) : null });
    if (nodes.length > 0 && random() < 0.3) await tx.entity('Node').update(pick(nodes), { up: node });
    await tx.entity('Pair').create({ a: fresh('A'), b: Math.floor(random() * 3), nodeId: node });
  });

  const remove = async () => {
    const name = pick(['Parent', 'Child', 'Node', 'Tag', 'Label']);
    const keys = keysOf(name);
    const viaSync = random() < 0.5;
    if (keys.length === 0) return;
    const target = pick(keys);
    await refusable(() => (sync && viaSync ? store.sync.entity(name).delete(target) : store.entity(name).delete(target)));
  };

  const save = async () => {
    const children = keysOf('Child');
    /** @type {[string, string][]} */
    const staged = [];
    for (let i = 0; i < 3 && children.length > 0; i += 1) {
      const [id] = children.splice(Math.floor(random() * children.length), 1);
      const child = await store.entity('Child').get(id);
      store.entity('Child').put({ ...child, n: child.n + 100 });
      staged.push(['Child', id]);
    }
    const parents = keysOf('Parent');
    if (parents.length > 0) {
      const parent = pick(parents);
      store.entity('Parent').remove(parent);
      staged.push(['Parent', parent]);
    }
    try { await store.saveChanges(); }
    catch (error) {
      if (/** @type {any} */ (error)?.code !== 'JD2005') throw error;
      refused += 1;
      // a refused save leaves what it staged pending: drop all of it
      for (const [name, id] of staged) store.entity(name).discard(id);
    }
  };

  const reparent = async () => {
    const children = keysOf('Child');
    if (children.length === 0) return;
    const child = pick(children);
    const { parentId } = state.Child[child];
    const parent = fresh('P');
    await refusable(() => store.transaction(async (/** @type {any} */ tx) => {
      await tx.entity('Parent').delete(parentId);
      await tx.entity('Parent').create({ id: parent });
      await tx.entity('Child').create({ id: child, parentId: parent, n: 7 });
    }));
  };

  const savepoint = async () => {
    const parents = keysOf('Parent');
    if (parents.length === 0) return;
    const doomed = pick(parents);
    const locked = [...new Set(Object.values(state.Lock).map((lock) => lock.parentId))].sort();
    const guarded = locked.length > 0 ? pick(locked) : pick(parents);
    const direct = random() < 0.5 && !savepointRefusals;
    const lock = locked.length === 0 ? fresh('K') : undefined;
    const tag = fresh('T');
    await store.transaction(async (/** @type {any} */ tx) => {
      try {
        await tx.transaction(async (/** @type {any} */ inner) => {
          await inner.entity('Parent').delete(doomed);
          throw new Error(UNDONE);
        });
      }
      catch (error) {
        if (/** @type {any} */ (error)?.code === 'JD2005') refused += 1;
        else if (/** @type {any} */ (error)?.message !== UNDONE) throw error;
      }
      if (lock !== undefined) await tx.entity('Lock').create({ id: lock, parentId: guarded });
      /** @param {any} view */
      const deleting = (view) => view.entity('Parent').delete(guarded);
      await assert.rejects(direct ? deleting(tx) : tx.transaction(deleting), { code: 'JD2005' });
      refused += 1;
      await tx.entity('Tag').create({ id: tag });
    });
  };

  /** @type {[number, string, () => any][]} cumulative weight, name, operation */
  const steps = [[0.35, 'grow', grow], [0.55, 'delete', remove], [0.75, 'save', save],
    [0.9, 'reparent', reparent], [1, 'savepoint', savepoint]];
  const stop = store.observe((/** @type {any} */ record) => { records.push(record); });
  try {
    for (let step = 0; step < operations; step += 1) {
      const roll = random();
      const [, name, operation] = /** @type {[number, string, () => any]} */ (steps.find(([bound]) => roll < bound));
      counts[name] += 1;
      const from = records.length;
      await operation();
      const next = await storeState(store, model);
      try { checkRecords(state, records.slice(from), next); }
      catch (error) {
        throw new Error(`seed ${seed}, operation ${step} (${name}): its records do not give the state after it`,
          { cause: error });
      }
      state = next;
      await after();
    }
  }
  finally { stop(); }
  return { records: records.map((record) => canonicalPatch(record.patch)), operations: counts, refused };
}

/**
 * A replicated cascading delete, timed: each round creates a parent with
 * `children` cascading children and `notes` set-null notes in one
 * transaction and delivers it to `replica`, then times the parent's delete on
 * `store` and the apply of its envelope on `replica`, and requires equal
 * complete states. Every delete envelope must carry the parent and each row
 * its foreign keys changed. Both stores are empty, replicated and opened with
 * {@link cascadeModel}.
 * @param {{ store: any, replica: any, rounds: number, children: number, notes: number }} options
 * @returns {Promise<{ deleteMs: number[], applyMs: number[], operations: number, bytes: number,
 *   removed: number, nulled: number }>} the delete and apply times of each
 *   round; of the first round's delete envelope, the operation count, the
 *   canonical encoding's byte length, and the rows the parent's foreign keys
 *   removed and nulled
 */
export async function cascadeScenario({ store, replica, rounds, children, notes }) {
  const model = cascadeModel();
  /** @type {number[]} */
  const deleteMs = [];
  /** @type {number[]} */
  const applyMs = [];
  let operations = 0;
  let bytes = 0;
  let removed = 0;
  let nulled = 0;
  let next = (await store.replication.page({ after: 0, limit: 1 })).highWatermark;
  for (let round = 0; round < rounds; round += 1) {
    const parent = `p${round}`;
    await store.transaction(async (/** @type {any} */ tx) => {
      await tx.entity('Parent').create({ id: parent });
      for (let i = 0; i < children; i += 1) await tx.entity('Child').create({ id: `${parent}c${i}`, parentId: parent, n: i });
      for (let i = 0; i < notes; i += 1) await tx.entity('Note').create({ id: `${parent}n${i}`, parentId: parent });
    });
    const created = await store.replication.page({ after: next });
    for (const envelope of created.items) assert.equal((await replica.replication.apply(envelope)).status, 'applied');
    let at = performance.now();
    await store.entity('Parent').delete(parent);
    deleteMs.push(performance.now() - at);
    const deleted = await store.replication.page({ after: created.next });
    assert.equal(deleted.items.length, 1);
    const [envelope] = deleted.items;
    assert.equal(envelope.operations.length, 1 + children + notes);
    if (round === 0) {
      operations = envelope.operations.length;
      bytes = new TextEncoder().encode(encodeReplication(envelope)).length;
      // the parent's own removal aside
      removed = envelope.operations.filter((/** @type {any} */ op) => op.after === null).length - 1;
      nulled = envelope.operations.filter((/** @type {any} */ op) => op.after !== null).length;
    }
    at = performance.now();
    assert.equal((await replica.replication.apply(envelope)).status, 'applied');
    applyMs.push(performance.now() - at);
    next = deleted.next;
    assert.deepEqual(await storeState(replica, model), await storeState(store, model));
  }
  return { deleteMs, applyMs, operations, bytes, removed, nulled };
}
