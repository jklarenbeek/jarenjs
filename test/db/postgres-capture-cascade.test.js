//@ts-check
/**
 * @file PostgreSQL journal capture of the database's foreign-key actions: a
 * delete's records equal session capture's on SQLite; every row the delete's
 * closure reads stays locked until the commit, as strongly as the delete's
 * own action locks it, so a writer outside capture cannot add, move or remove
 * a row of it in between while one that only references a row the delete
 * nulls is not waited for; a tracked save records the stored row when a
 * foreign-key action of its transaction changed it; and every record a seeded
 * random workload commits, folded over the complete logical state before its
 * transaction, gives the state after it.
 */
import { before, describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { openStore } from '@jarenjs/db';
import { postgresDriver } from '@jarenjs/db/postgres';
import { cascadeModel, seedCascade, cascadeWorkload, canonicalPatch, CASCADE_RECORDS, trialModel, randomWorkload }
  from './oracle/cascade.js';

const url = process.env.JAREN_PG_URL;
const key = { type: 'string', 'x-entity': { key: true } };
/** @param {string} to @param {string} via @param {string} onDelete @param {boolean} [many] */
const relation = (to, via, onDelete, many = true) =>
  ({ 'x-entity': { relation: { to, ...(many ? { many } : {}), via, onDelete } } });
// a delete of a Hub removes a child, nulls a note (one-to-many) and a badge's
// unique member (one-to-one); a comment references the note
const lockModel = { $model: '0.1', entities: {
  Hub: { schema: { type: 'object', required: ['id'], properties: { id: key,
    kids: relation('Child', 'hubId', 'cascade'), notes: relation('Note', 'hubId', 'setNull') } } },
  Child: { schema: { type: 'object', required: ['id', 'hubId'], properties: { id: key, hubId: { type: 'string' } } } },
  Note: { schema: { type: 'object', required: ['id'], properties: { id: key, hubId: { type: ['string', 'null'] },
    comments: relation('Comment', 'noteId', 'cascade') } } },
  Comment: { schema: { type: 'object', required: ['id', 'noteId'], properties: { id: key, noteId: { type: 'string' } } } },
  Badge: { schema: { type: 'object', required: ['id'], properties: { id: key, hubId: { type: ['string', 'null'] },
    hub: relation('Hub', 'hubId', 'setNull', false) } } },
} };
/** @param {any} store */
const seedLocks = async (store) => {
  await store.entity('Hub').create({ id: 'h' });
  await store.entity('Child').create({ id: 'c1', hubId: 'h' });
  await store.entity('Note').create({ id: 'n1', hubId: 'h' });
  await store.entity('Badge').create({ id: 'b1', hubId: 'h' });
};

/** Which of `names` a statement names as tables. @param {string} text @param {string[]} names */
const tablesOf = (text, names) => names.filter((name) => text.includes(`"${name}"`));
/** A read is a SELECT, run directly or behind the server-side cursor the
 * driver declares for it. @param {string} text */
const isRead = (text) => /^\s*(?:DECLARE\s.+?\sCURSOR\s+FOR\s+)?SELECT\s/is.test(text);
/** The reads of `names` from the first such read up to the DELETE of `root`.
 * @param {string[]} texts @param {string[]} names @param {string} root */
const closureReads = (texts, names, root) => {
  const reads = (/** @type {string} */ text) => isRead(text) && tablesOf(text, names).length > 0;
  const first = texts.findIndex(reads);
  const deleting = texts.findIndex((text) => /^\s*DELETE\b/i.test(text) && tablesOf(text, [root]).length > 0);
  assert.ok(first >= 0 && deleting > first, 'the closure is read before the delete runs');
  return texts.slice(first, deleting).filter(reads);
};
/** The row lock a read ends with. @param {string} text */
const lockOf = (text) => /\s(FOR (?:NO KEY )?UPDATE)$/.exec(text)?.[1];

describe('PostgreSQL journal capture of foreign-key actions', { skip: !url && 'JAREN_PG_URL is not set' }, () => {
  /** @type {any} */
  let pg;
  let serial = 0;
  before(async () => { pg = (await import('pg')).default; });
  /**
   * A seeded journal store on its own schema and pool (at most three
   * connections), with every SQL text the pool's clients run; both are
   * dropped after `fn`.
   * @param {(context: { store: any, texts: string[], pool: any, schema: string }) => Promise<void>} fn
   * @param {{ model?: any, seed?: (store: any) => Promise<void> }} [corpus]
   */
  async function fixture(fn, { model = cascadeModel(), seed = seedCascade } = {}) {
    const schema = `jaren_cascade_${process.pid}_${serial++}`;
    const pool = new pg.Pool({ connectionString: url, max: 3 });
    /** @type {string[]} */
    const texts = [];
    pool.on('connect', (/** @type {any} */ client) => {
      const query = client.query;
      client.query = function (/** @type {any[]} */ ...args) {
        texts.push(typeof args[0] === 'string' ? args[0] : args[0]?.text ?? '');
        return query.apply(this, args);
      };
    });
    let store;
    try {
      await pool.query(`CREATE SCHEMA "${schema}"`);
      store = await openStore(model, { driver: postgresDriver(pool, { schema }),
        capture: { mode: 'journal', log: true } });
      await seed(store);
      await fn({ store, texts, pool, schema });
    }
    finally {
      try { await store?.close(); }
      finally {
        try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
        finally { await pool.end(); }
      }
    }
  }

  it('PostgreSQL journal capture records the rows foreign keys remove or null', async () => {
    await fixture(async ({ store }) => {
      const after = (await store.changes.bounds()).highWatermark;
      await cascadeWorkload(store);
      await store.entity('Parent').delete('r');
      const page = await store.changes.page({ after });
      assert.deepEqual(page.items.map((/** @type {any} */ record) => canonicalPatch(record.patch)), CASCADE_RECORDS);
    });
  });

  it('closure reads lock what they read', async () => {
    await fixture(async ({ store, texts }) => {
      texts.length = 0;
      assert.equal(await store.entity('Parent').delete('p'), true);
      const reads = closureReads(texts,
        ['Parent', 'Child', 'Note', 'Pair', 'Mixed', 'Grand', 'Parent_Tag', 'Child_Label'], 'Parent');
      // a row a one-to-many set-null key names is nulled: an update of a
      // non-key column; every other row of the closure is removed
      const nulled = (/** @type {string} */ text) => (text.includes('"Note"') && text.includes('WHERE "parentId" IN'))
        || text.includes('WHERE "parentRef" IN');
      for (const text of reads) assert.equal(lockOf(text), nulled(text) ? 'FOR NO KEY UPDATE' : 'FOR UPDATE', text);
      for (const table of ['Child', 'Note', 'Mixed', 'Parent_Tag'])
        assert.ok(reads.some((text) => tablesOf(text, [table]).length > 0), `${table} is read`);
      assert.equal(reads.filter(nulled).length, 2, 'both set-null keys are read');
    });
  });

  it('a delete waits for no writer that only references a row it nulls', async () => {
    await fixture(async ({ store, texts, pool, schema }) => {
      const mark = (await store.changes.bounds()).highWatermark;
      const other = await pool.connect();
      /** @type {Promise<any> | undefined} */
      let deleting;
      try {
        await other.query(`SET search_path TO "${schema}"`);
        await other.query(`SET lock_timeout = '10s'`);
        await other.query('BEGIN');
        // referencing the note takes a key-share lock on it, held open
        await other.query(`INSERT INTO "Comment" ("id", "noteId", "doc") VALUES ('m1', 'n1', '{}')`);
        texts.length = 0;
        deleting = store.entity('Hub').delete('h');
        const outcome = await Promise.race([deleting.then(() => 'deleted'), sleep(3000).then(() => 'waiting')]);
        assert.equal(outcome, 'deleted', 'the delete does not wait for the open referencing transaction');
        await other.query('COMMIT');
      }
      finally {
        await other.query('ROLLBACK').catch(() => undefined);
        other.release();
        await deleting?.catch(() => undefined);
      }
      assert.equal(await deleting, true);
      const reads = closureReads(texts, ['Child', 'Note', 'Badge'], 'Hub');
      const locks = (/** @type {string} */ table) => reads.filter((text) => tablesOf(text, [table]).length > 0).map(lockOf);
      // the badge's member is unique, a key: nulling it locks as a delete does
      assert.deepEqual([locks('Child'), locks('Note'), locks('Badge')],
        [['FOR UPDATE'], ['FOR NO KEY UPDATE'], ['FOR UPDATE']]);
      const page = await store.changes.page({ after: mark });
      assert.deepEqual(page.items.map((/** @type {any} */ record) => canonicalPatch(record.patch)),
        [['remove /Badge/b1/hubId', 'remove /Child/c1', 'remove /Hub/h', 'remove /Note/n1/hubId']]);
      assert.deepEqual(await store.entity('Comment').get('m1'), { id: 'm1', noteId: 'n1' });
      assert.deepEqual(await store.entity('Note').get('n1'), { id: 'n1' });
    }, { model: lockModel, seed: seedLocks });
  });

  it('a tracked save records the stored row a foreign-key action of its transaction changed', async () => {
    await fixture(async ({ store }) => {
      const after = (await store.changes.bounds()).highWatermark;
      await store.transaction(async (/** @type {any} */ tx) => {
        const note = await tx.entity('Note').get('n2');
        tx.entity('Parent').remove('q');
        await tx.saveChanges();
        tx.entity('Note').put({ ...note, body: 'edited' });
        await tx.saveChanges();
      });
      const page = await store.changes.page({ after });
      assert.deepEqual(page.items.map((/** @type {any} */ record) => canonicalPatch(record.patch)
        .filter((line) => line.includes('/Note/'))), [['add /Note/n2/body "edited"', 'remove /Note/n2/parentId']]);
      assert.deepEqual(await store.entity('Note').get('n2'), { id: 'n2', body: 'edited' });
    });
  });

  it('a create whose membership the database refuses records nothing', async () => {
    await fixture(async ({ store }) => {
      const after = (await store.changes.bounds()).highWatermark;
      let refused;
      await store.transaction(async (/** @type {any} */ tx) => {
        // the join row naming no tag is refused in the create's own savepoint,
        // which takes the row and its first join row with it
        try { await tx.entity('Parent').create({ id: 's', tags: ['t1', 'missing'] }); }
        catch (error) { refused = /** @type {any} */ (error).code; }
        await tx.entity('Tag').create({ id: 'u' });
      });
      assert.equal(refused, 'JD2005');
      const page = await store.changes.page({ after });
      assert.deepEqual(page.items.map((/** @type {any} */ record) => canonicalPatch(record.patch)), [['add /Tag/u {"id":"u"}']]);
      assert.equal(await store.entity('Parent').get('s'), undefined);
    });
  });

  for (let seed = 1; seed <= 6; seed += 1) {
    it(`seed ${seed}: every record of a random workload yields the next state`, async () => {
      await fixture(async ({ store }) => {
        // a refused statement aborts a PostgreSQL transaction, so a refusal
        // inside one is taken in a savepoint of its own
        const { records } = await randomWorkload(store, seed, 20, { savepointRefusals: true });
        assert.ok(records.length > 0);
      }, { model: trialModel(), seed: async () => undefined });
    });
  }
});
