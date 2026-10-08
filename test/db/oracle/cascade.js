//@ts-check
/**
 * The foreign-key action corpus: a model whose deletes reach every edge a
 * store declares — one-to-many `cascade` two levels deep, `setNull`, a
 * composite-key child, a row reachable through a `setNull` and a `cascade`
 * edge at once, a self reference and memberships on both endpoints — its
 * seed, a workload over the store's delete paths, and the records session
 * capture writes for it.
 */

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
 */
export async function cascadeWorkload(store) {
  const child = await store.entity('Child').get('c3');
  store.entity('Child').put({ ...child, n: 99 });
  store.entity('Parent').remove('q');
  await store.saveChanges();
  await store.transaction(async (/** @type {any} */ tx) => {
    await tx.entity('Parent').delete('p');
    await tx.entity('Parent').create({ id: 'r' });
    await tx.entity('Child').create({ id: 'c1', parentId: 'r', n: 7 });
  });
  await store.entity('Node').delete('a');
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
