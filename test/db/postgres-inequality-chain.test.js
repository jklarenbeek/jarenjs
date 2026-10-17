//@ts-check
/**
 * @file A conjunction of `$ne` literals over one member on PostgreSQL: the
 * statement spells them as the member's presence and ONE negated membership
 * list, bound as one value, instead of one comparison per literal — so a
 * statement at the term bound, or a profile's mandatory predicate past it
 * (which rides the residual's fetch whole), hands the server's JIT one leaf
 * rather than hundreds. The term count, the plan's mode and every answer are
 * unchanged: the oracle is the engine (`pushdown: false`) over members that
 * are absent, a JSON null, of another type, equal to a literal or past 2^53,
 * under a `$not` and beside other conjuncts, on a collection, an entity's
 * columns, an entity's document and an adopted table's columns under each
 * null policy that is queried natively. SQLite keeps one comparison per
 * literal. The PostgreSQL half needs `JAREN_PG_URL`.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { openStore, reasonId } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { postgresDriver } from '@jarenjs/db/postgres';
import { adoptedPostgres } from './helpers.js';

const url = process.env.JAREN_PG_URL;
const key = { 'x-entity': { key: true } };
const MODEL = {
  $model: '0.1',
  collections: {
    items: { schema: { type: 'object', properties: { id: { type: 'string' }, n: { type: 'integer' } } }, key: '/id',
      indexes: [{ name: 'n', path: '$.n' }] },
    mixed: { schema: { type: 'object', properties: { id: { type: 'string' } } }, key: '/id' },
  },
  entities: {
    Item: { schema: { type: 'object', properties: {
      id: { type: 'string', ...key }, n: { type: 'integer' }, sku: { type: 'string' }, w: { type: 'number' },
      at: { type: 'string', format: 'date-time', 'x-entity': { column: 'integer' } },
      meta: { type: 'object', properties: { n: {} } } } } },
  },
};
/** The documents of `mixed`: every kind a member can hold, and none. */
const MIXED = [
  { id: 'absent' }, { id: 'null', n: null }, { id: 'one', n: 1 }, { id: 'two', n: 2 }, { id: 'half', n: 1.5 },
  { id: 'text1', n: '1' }, { id: 'texta', n: 'a' }, { id: 'true', n: true }, { id: 'list', n: [1] },
  { id: 'wide', n: 2 ** 60 }, { id: 'neg', n: -3 },
];
/** The entity rows: a column that is absent on one row, and an untyped document member. */
const ITEMS = [
  { id: 'a', n: 1, sku: 'x', w: 0.30000000000000004, at: '2026-01-01T00:00:00Z', meta: { n: 1 } },
  { id: 'b', n: 2, sku: 'y', w: 0.3, at: '2026-01-01T00:00:00.000Z', meta: { n: 'a' } },
  { id: 'c', sku: 'z', w: 1.5, at: '2026-02-01T00:00:00Z', meta: { n: null } }, { id: 'd', n: 3, meta: { n: 0.30000000000000004 } },
  { id: 'e', n: -3, sku: 'a', w: -3, meta: { n: 2 ** 60 } },
];
/** @param {any[]} literals @param {string} member */
const chain = (literals, member = 'n') => ({ $and: literals.map((literal) => ({ $ne: [`$it.${member}`, literal] })) });
/** The literal sets each matrix case conjoins. */
const SETS = [[1, 2], [1, 1, 2], [1, '1'], ['a', 'b'], [2 ** 60, 3], [1.5, -3, 2], ['x', 'z', 'q'], [0.3, 0.1], [Infinity, 1]];
/** Each set as a plain chain, negated, beside another conjunct, and inside a disjunction. @param {any[]} set @param {string} member */
const shapes = (set, member) => [
  chain(set, member),
  { $not: chain(set, member) },
  { $and: [...chain(set, member).$and, { $ne: [`$it.${member}`, 0] }, { $ne: ['$it.id', 'zz'] }] },
  { $or: [chain(set, member), { $eq: ['$it.id', 'absent'] }] },
];
/** @param {any} v */
const sorted = (v) => [...(Array.isArray(v) ? v : v === undefined ? [] : [v])].sort();
/** @param {string} sql */
// a difference from a number literal is the negated interval of decimals that
// rounds to it on a column the store made (`NOT (c >= low AND c <= high)`, or
// `>` and `<` where its ties round away)
const inequalities = (sql) => (sql.match(/<>|NOT \([^()]*? >=? /g) ?? []).length;

describe('SQLite keeps one comparison per literal', () => {
  it('a 128-literal chain is 128 inequalities in the statement', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver() });
    try {
      const explained = await store.collection('items').explain({ $for: { it: '$[*]' }, $where: chain(Array.from({ length: 128 }, (_, i) => i)), $return: '$it.id' });
      assert.equal(explained.mode, 'native');
      assert.equal(inequalities(explained.sql), 128);
    }
    finally { await store.close(); }
  });
});

describe('PostgreSQL: a conjunction of $ne literals over one member is one negated list', { skip: !url && 'JAREN_PG_URL is not set' }, () => {
  /** @type {any} */
  let pg;
  /** @type {any} */
  let admin;
  /** @type {any} */
  let pool;
  /** @type {any} */
  let store;
  /** @type {string[]} */
  const sent = [];
  const schema = `jaren_ne_chain_${process.pid}`;

  before(async () => {
    pg = (await import('pg')).default;
    admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new pg.Pool({ connectionString: url, max: 1 });
    pool.on('connect', (/** @type {any} */ client) => {
      const query = client.query.bind(client);
      client.query = (/** @type {any[]} */ ...args) => {
        sent.push(typeof args[0] === 'string' ? args[0] : String(args[0]?.text ?? ''));
        return query(...args);
      };
    });
    store = await openStore(MODEL, { driver: postgresDriver(pool, { schema }) });
    await store.transaction(async (/** @type {any} */ tx) => {
      for (let i = 0; i < 300; i++) await tx.collection('items').put({ id: `i${i}`, n: i });
      await tx.collection('items').put({ id: 'none' });
      for (const doc of MIXED) await tx.collection('mixed').put(doc);
      for (const row of ITEMS) await tx.entity('Item').create(row);
    });
  });
  after(async () => {
    await store?.close().catch(() => {});
    await pool?.end().catch(() => {});
    if (admin) {
      try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
      finally { await admin.end(); }
    }
  });

  it('a 128-literal chain at the term bound stays native and carries no inequality', async () => {
    const where = chain(Array.from({ length: 128 }, (_, i) => i * 2));
    const expected = Array.from({ length: 300 }, (_, i) => `i${i}`).filter((_, i) => i % 2 === 1 || i >= 256).sort();
    const collection = await store.collection('items').explain({ $for: { it: '$[*]' }, $where: where, $return: '$it.id' });
    assert.equal(collection.mode, 'native');
    assert.equal(inequalities(collection.sql), 0);
    assert.equal((collection.sql.match(/jsonb_array_elements/g) ?? []).length, 1, 'one list');
    const overItems = { $for: { it: '$[*]' }, $where: where, $return: '$it.id' };
    // the member is read from its generated column; a document without it is in no answer
    assert.match(collection.sql, /"gx_n"/);
    assert.deepEqual(sorted(await store.collection('items').execute(overItems)), expected);
    assert.deepEqual(sorted(await store.collection('items').execute(overItems, { pushdown: false })), expected);
    const entity = await store.explain({ $for: { it: '$.Item[*]' }, $where: chain([1, 2, 'q'].concat(Array.from({ length: 125 }, (_, i) => 100 + i))), $return: '$it.id' });
    assert.equal(entity.mode, 'native');
    assert.equal(inequalities(entity.sql), 0);
    // past the bound the document is still the engine's: the count is the plan's, not the spelling's
    const above = await store.collection('items').explain({ $for: { it: '$[*]' }, $where: chain(Array.from({ length: 129 }, (_, i) => i)), $return: '$it.id' });
    assert.equal(reasonId(above.residual.reasons[0].reason), 'predicate.termBound');
  });

  it('each member kind regroups, but a number column, a lone `$ne` and a literal JSON cannot spell keep their comparisons', async () => {
    const counted = async (/** @type {string} */ root, /** @type {any} */ where) => inequalities(root === 'mixed'
      ? (await store.collection('mixed').explain({ $for: { it: '$[*]' }, $where: where, $return: '$it.id' })).sql
      : (await store.explain({ $for: { it: '$.Item[*]' }, $where: where, $return: '$it.id' })).sql);
    assert.equal(await counted('mixed', chain([1, 'a', 2, 'b'])), 0);
    assert.equal(await counted('Item', chain([1, 2, 3])), 0);
    assert.equal(await counted('Item', chain(['a', 'b', 'c'], 'sku')), 0);
    assert.equal(await counted('Item', chain([1, 'a', 0.5], 'meta.n')), 0);
    // a `number` column's list would compare a `numeric`, which is not the double it holds
    assert.equal(await counted('Item', chain([0.3, 0.1, 2], 'w')), 3);
    assert.equal(await counted('Item', { $and: [{ $ne: ['$it.n', 1] }, { $ne: ['$it.sku', 'a'] }] }), 2);
    assert.equal(await counted('Item', { $and: [{ $ne: ['$it.n', 1] }, { $ne: ['$it.sku', 'a'] }, { $ne: ['$it.n', 2] }] }), 1);
    // an infinity, which the list's JSON cannot spell, keeps its own comparison: outside the decimals that round to it
    const infinite = (await store.collection('mixed').explain({ $for: { it: '$[*]' }, $where: chain([Infinity, 1, 2]), $return: '$it.id' })).sql;
    assert.equal((infinite.match(/OR NOT \(\(CASE WHEN jsonb_typeof/g) ?? []).length, 1);
    // an instant kept as an epoch column: its `$ne` and its list both read the document's text, by code point
    const instants = chain(['2026-01-01T00:00:00Z', '2026-03-01T00:00:00Z'], 'at');
    assert.equal(await counted('Item', instants), 0);
    const overAt = { $for: { it: '$.Item[*]' }, $where: instants, $return: '$it.id' };
    assert.deepEqual(sorted(await store.execute(overAt)), sorted(await store.execute(overAt, { pushdown: false })));
    assert.deepEqual(sorted(await store.execute(overAt)), ['b', 'c']);
  });

  it("a profile's 800-literal mandatory predicate reaches the residual's fetch as one list, with the same answer", async () => {
    const literals = Array.from({ length: 800 }, (_, i) => i * 2);
    const profile = { maxRows: 5000, predicates: { items: chain(literals), Item: chain(literals) } };
    sent.length = 0;
    const kept = sorted(await store.collection('items').execute({ $for: { it: '$[*]' }, $return: '$it.id' }, { profile }));
    assert.deepEqual(kept, Array.from({ length: 300 }, (_, i) => `i${i}`).filter((_, i) => i % 2 === 1).sort());
    const fetched = sent.filter((text) => /"items"/.test(text) && /SELECT/.test(text));
    assert.ok(fetched.length > 0);
    assert.deepEqual(fetched.map(inequalities), fetched.map(() => 0));
    // the oracle: the same chain as the document's own filter, in the engine — a row whose `n` is absent is not kept
    const engine = sorted(await store.execute({ $for: { it: '$.Item[*]' }, $where: chain(literals), $return: '$it.id' }, { pushdown: false }));
    assert.deepEqual(engine, ['a', 'd', 'e']);
    sent.length = 0;
    assert.deepEqual(sorted(await store.execute({ $for: { it: '$.Item[*]' }, $return: '$it.id' }, { profile })), engine);
    const entityFetch = sent.filter((text) => /"Item"/.test(text) && /SELECT/.test(text));
    assert.ok(entityFetch.length > 0);
    assert.deepEqual(entityFetch.map(inequalities), entityFetch.map(() => 0));
  });

  it('every shape answers as the engine does over a collection, entity columns and an entity document', async () => {
    let compared = 0;
    for (const set of SETS) {
      for (const where of shapes(set, 'n')) {
        const overMixed = { $for: { it: '$[*]' }, $where: where, $return: '$it.id' };
        const mixed = store.collection('mixed');
        assert.equal((await mixed.explain(overMixed)).mode, 'native', JSON.stringify(where));
        assert.deepEqual(sorted(await mixed.execute(overMixed)), sorted(await mixed.execute(overMixed, { pushdown: false })), `mixed ${JSON.stringify(where)}`);
        compared++;
      }
      for (const member of ['n', 'sku', 'w', 'meta.n']) {
        for (const where of shapes(set, member)) {
          const overItem = { $for: { it: '$.Item[*]' }, $where: where, $return: '$it.id' };
          assert.equal((await store.explain(overItem)).mode, 'native', `${member} ${JSON.stringify(where)}`);
          assert.deepEqual(sorted(await store.execute(overItem)), sorted(await store.execute(overItem, { pushdown: false })), `${member} ${JSON.stringify(where)}`);
          assert.deepEqual(sorted((await store.entity('Item').load({ where })).map((/** @type {any} */ row) => row.id)),
            sorted(await store.execute(overItem, { pushdown: false })), `load ${member} ${JSON.stringify(where)}`);
          compared++;
        }
      }
    }
    assert.equal(compared, SETS.length * 4 * 5);
    // a double past fifteen digits is not the decimal it rounds to
    assert.deepEqual(sorted(await store.execute({ $for: { it: '$.Item[*]' }, $where: chain([0.3, 1.5], 'w'), $return: '$it.id' })), ['a', 'e']);
    assert.deepEqual(sorted(await store.execute({ $for: { it: '$.Item[*]' }, $where: chain([0.3, 1], 'meta.n'), $return: '$it.id' })), ['b', 'c', 'd', 'e']);
    // the answers themselves, for the plain chain over every kind a member holds
    assert.deepEqual(sorted(await store.collection('mixed').execute({ $for: { it: '$[*]' }, $where: chain([1, 'a', 2 ** 60]), $return: '$it.id' })),
      ['half', 'list', 'neg', 'null', 'text1', 'true', 'two']);
  });

  it('two bindings of one entity keep their own lists', async () => {
    const join = { $for: { a: '$.Item[*]', b: '$.Item[*]' }, $where: { $and: [{ $eq: ['$a.id', '$b.id'] },
      { $ne: ['$a.n', 1] }, { $ne: ['$b.n', 3] }, { $ne: ['$a.n', 2] }, { $ne: ['$b.n', 5] }] }, $return: '$a.id' };
    const explained = await store.explain(join);
    assert.equal(explained.mode, 'native');
    assert.equal(inequalities(explained.sql), 0);
    assert.deepEqual(sorted(await store.execute(join)), sorted(await store.execute(join, { pushdown: false })));
    assert.deepEqual(sorted(await store.execute(join)), ['e']);
  });

  it('a literal the server holds in no list leaves the chain refused as a lone $ne is', async () => {
    /** @param {any} where */
    const refusal = async (where) => {
      try { await store.execute({ $for: { it: '$.Item[*]' }, $where: where, $return: '$it.id' }); return null; }
      catch (/** @type {any} */ error) { return { code: error.code, message: error.message }; }
    };
    for (const member of ['sku', 'meta.n']) {
      const lone = await refusal({ $ne: [`$it.${member}`, 'a\u0000'] });
      assert.deepEqual(await refusal(chain(['a\u0000', 'b'], member)), lone, member);
    }
  });

  it('a collection literal the server cannot hold still sends the document to the residual, with the engine\'s answer', async () => {
    const overMixed = { $for: { it: '$[*]' }, $where: chain(['a\u0000', 'b']), $return: '$it.id' };
    assert.notEqual((await store.collection('mixed').explain(overMixed)).mode, 'native');
    assert.deepEqual(sorted(await store.collection('mixed').execute(overMixed)),
      sorted(await store.collection('mixed').execute(overMixed, { pushdown: false })));
  });

  it('an adopted table\'s columns answer as the engine does under each null policy queried natively', async () => {
    for (const policy of ['reject', 'absent']) {
      const rows = policy === 'reject' ? "(1, 1, 'a'), (2, 2, 'b'), (3, 40000, 'c'), (4, -3, 'x')"
        : "(1, 1, 'a'), (2, 2, 'b'), (3, 40000, 'c'), (4, -3, 'x'), (5, NULL, NULL)";
      const handle = await adoptedPostgres(`CREATE TABLE t (id integer PRIMARY KEY, qty integer, label text, tag text NOT NULL DEFAULT 'x');
        INSERT INTO t (id, qty, label) VALUES ${rows};`, {
        T: { schema: { type: 'object', properties: { id: { type: 'integer', ...key }, qty: { type: 'integer' }, label: { type: 'string' }, tag: { type: 'string' } } },
          physical: { table: 't', columns: { id: { name: 'id', codec: 'integer', null: 'reject' },
            qty: { name: 'qty', codec: 'integer', null: policy }, label: { name: 'label', codec: 'text', null: policy },
            tag: { name: 'tag', codec: 'text', null: 'reject' } } } } },
      { label: 'nechain' });
      try {
        for (const set of [...SETS, [3000000000, 1], [40000, 2, 2]]) {
          for (const member of ['qty', 'label']) {
            for (const where of shapes(set, member)) {
              const query = { $for: { it: '$.T[*]' }, $where: where, $return: '$it.id' };
              const name = `${policy} ${member} ${JSON.stringify(where)}`;
              assert.equal((await handle.store.explain(query)).mode, 'native', name);
              const expected = sorted(await handle.store.execute(query, { pushdown: false }));
              assert.deepEqual(sorted(await handle.store.execute(query)), expected, name);
              const mutated = await handle.store.entity('T').mutate({ op: 'update', where, set: { tag: 'x' }, reporting: 'matched' });
              assert.deepEqual(sorted(mutated.rows.map((/** @type {any} */ row) => row.id)), expected, `mutate ${name}`);
            }
          }
        }
        const overT = (/** @type {any} */ where) => ({ $for: { it: '$.T[*]' }, $where: where, $return: '$it.id' });
        assert.deepEqual(sorted(await handle.store.execute(overT(chain([1, 3000000000, 40000], 'qty')))), [2, 4]);
        assert.equal(inequalities((await handle.store.explain(overT(chain([1, 2, 3], 'qty')))).sql), 0);
        assert.equal(inequalities((await handle.store.explain(overT(chain(['a', 'b', 'c'], 'label')))).sql), 0);
      }
      finally { await handle.close(); }
    }
  });
});
