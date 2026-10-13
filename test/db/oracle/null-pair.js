//@ts-check
/**
 * @file Two columns of one binding whose NULL reads as a present `null`,
 * shared by the host differential: the table, the model and the checks.
 */
import assert from 'node:assert/strict';

export const DDL = (/** @type {string} */ prefix) => `CREATE TABLE ${prefix}t (id integer PRIMARY KEY, a text, c text, k text NOT NULL, m text NOT NULL);
  INSERT INTO ${prefix}t VALUES (1, NULL, NULL, 'p', 'p'), (2, 'x', 'x', 'p', 'q'), (3, NULL, NULL, 'q', 'q'),
    (4, 'y', 'y', 'q', 'p'), (5, 'p', 'q', 'r', 'r'), (6, NULL, 'z', 'r', 's'), (7, 'w', NULL, 's', 's')`;

/** @param {any} type the schema type of the two nullable-policy columns */
export const modelFor = (type) => (/** @type {string | null} */ schema) => ({
  $model: '0.1',
  entities: { T: {
    schema: { type: 'object', required: ['id', 'k', 'm'], properties: {
      id: { type: 'integer', 'x-entity': { key: true } }, a: { type }, c: { type }, k: { type: 'string' }, m: { type: 'string' } } },
    physical: { ...(schema === null ? {} : { schema }), table: 't', columns: {
      id: { name: 'id', codec: 'integer', null: 'reject' },
      a: { name: 'a', codec: 'text', null: 'null' }, c: { name: 'c', codec: 'text', null: 'null' },
      k: { name: 'k', codec: 'text', null: 'reject' }, m: { name: 'm', codec: 'text', null: 'reject' } } },
  } },
});

export const where = (/** @type {string} */ op, /** @type {string} */ left, /** @type {string} */ right) =>
  [{ $for: { i: '$.T[*]' }, $where: { [op]: [`$i.${left}`, `$i.${right}`] }, $return: '$i.id' }];

/** The pair the engine and the database answer differently: the engine's rows. */
export const PAIR_ROWS = /** @type {[string, number[]][]} */ ([['$eq', [1, 2, 3, 4]], ['$ne', [5, 6, 7]]]);
/** Two columns that admit no null: native, and the rows both agree on. */
export const PLAIN_ROWS = /** @type {[string, number[]][]} */ ([['$eq', [1, 3, 5, 7]], ['$ne', [2, 4, 6]]]);

/**
 * Assert the engine's answer for every comparison of the pair, and the
 * native answer for the plain pair.
 * @param {any} store @param {string} host
 */
export async function checkNullPair(store, host) {
  for (const [op, rows] of PAIR_ROWS) {
    const query = where(op, 'a', 'c');
    assert.equal((await store.explain(query)).mode, 'set', `${host} ${op}`);
    assert.deepEqual(await store.execute(query), rows, `${host} ${op}`);
    assert.deepEqual(await store.execute(query, { pushdown: false }), rows, `${host} ${op} (engine)`);
  }
  // one side alone reading a NULL as a null is enough, whichever side it is
  await assert.rejects(async () => store.execute(where('$eq', 'a', 'c'), { strict: true }), { code: 'JD0010' }, `${host} strict`);
  for (const [left, right] of [['k', 'c'], ['c', 'k']]) {
    const query = where('$ne', left, right);
    assert.equal((await store.explain(query)).mode, 'set', `${host} $ne ${left} ${right}`);
    assert.deepEqual(await store.execute(query), [1, 2, 3, 4, 5, 6, 7], `${host} $ne ${left} ${right}`);
    assert.deepEqual(await store.execute(where('$eq', left, right)), [], `${host} $eq ${left} ${right}`);
  }
  for (const [op, rows] of PLAIN_ROWS) {
    const query = where(op, 'k', 'm');
    assert.equal((await store.explain(query)).mode, 'native', `${host} ${op} k m`);
    assert.deepEqual(await store.execute(query, { strict: true }), rows, `${host} ${op} k m`);
  }
  for (const op of ['$lt', '$le', '$gt', '$ge']) {
    const query = where(op, 'a', 'c');
    assert.deepEqual(await store.execute(query), await store.execute(query, { pushdown: false }), `${host} ${op}`);
  }
}
