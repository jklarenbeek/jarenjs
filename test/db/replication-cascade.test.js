//@ts-check
/**
 * Replication of the rows foreign-key actions change, in journal and session
 * capture alike: replay order around a parent the same envelope removes, by
 * `apply` and by `reset`; convergence over every store delete path and over
 * seeded workloads under unreliable delivery; the refusals that keep an
 * incomplete envelope, a concurrent structural conflict and an oversized
 * delete out; and envelopes and snapshots that depend on neither the capture
 * mode nor the host.
 */
import { it, before } from 'node:test';
import * as assert from 'node:assert/strict';
import init from '@sqlite.org/sqlite-wasm';
import { openStore, encodeReplication } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { wasmDriver, sqlite3Handle } from '@jarenjs/db/wasm';
import { nodeWorkerDriver } from '@jarenjs/db/node-worker';
import { deliverySchedule, liveOracle } from './oracle/replication.js';
import { cascadeModel, seedCascade, cascadeWorkload, canonicalPatch, trialModel, storeState,
  randomWorkload } from './oracle/cascade.js';

/** @type {any} */
let sqlite3;
before(async () => { sqlite3 = await init({ print: () => {}, printErr: () => {} }); });

/** The models complete states are read with; stores open their own copies. */
const CASCADE = cascadeModel();
const TRIAL = trialModel();
/** Operations of each seeded workload. */
const OPERATIONS = 20;
// every Child row, maintained incrementally
const CHILDREN = [{ $for: { c: '$.Child[*]' }, $return: '$c' }];

const key = { type: 'string', 'x-entity': { key: true } };
/** Authors and their books, whose author key acts `onDelete`. @param {string} onDelete */
const authors = (onDelete) => ({ $model: '0.1', entities: {
  Author: { schema: { type: 'object', required: ['id'], properties: { id: key,
    books: { 'x-entity': { relation: { to: 'Book', many: true, via: 'authorId', onDelete } } } } } },
  Book: { schema: { type: 'object', required: ['id'], properties: { id: key,
    authorId: { type: ['string', 'null'] }, title: { type: 'string' } } } } } });
/** Parents whose kids cascade. */
const kids = () => ({ $model: '0.1', entities: {
  Parent: { schema: { type: 'object', required: ['id'], properties: { id: key,
    kids: { 'x-entity': { relation: { to: 'Kid', many: true, via: 'parentId', onDelete: 'cascade' } } } } } },
  Kid: { schema: { type: 'object', required: ['id', 'parentId'], properties: { id: key,
    parentId: { type: 'string' } } } } } });
const KIDS = kids();

/**
 * A replicated store over `driver` (`node:sqlite` unless given).
 * @param {any} model @param {string} mode @param {string} replica
 * @param {{ driver?: any, log?: boolean, maxOperations?: number }} [options]
 * @returns {Promise<any>}
 */
const open = (model, mode, replica, { driver = nodeDriver(), log = false, ...config } = {}) =>
  openStore(model, { driver, capture: log ? { mode, log } : { mode }, replication: { replica, ...config } });

/** Every envelope `store` exported, in sequence order. @param {any} store @returns {Promise<any[]>} */
const exported = async (store) => {
  const envelopes = [];
  for (let after = 0; ;) {
    const page = await store.replication.page({ after });
    envelopes.push(...page.items);
    if (!page.hasMore) return envelopes;
    after = page.next;
  }
};

it('replay writes a row moved off a parent before removing that parent', async () => {
  const outcomes = [];
  const expected = [];
  for (const mode of ['session', 'journal']) for (const onDelete of ['cascade', 'setNull']) for (const how of ['apply', 'reset']) {
    const model = authors(onDelete);
    const a = await open(model, mode, 'a');
    const b = await open(model, mode, 'b');
    const label = `${mode} ${onDelete} ${how}`;
    try {
      await a.entity('Author').create({ id: 'a' });
      await a.entity('Book').create({ id: 'b', authorId: 'a', title: 't' });
      for (const envelope of await exported(a)) await b.replication.apply(envelope);
      await a.transaction(async (/** @type {any} */ tx) => {
        await tx.entity('Author').create({ id: 'a2' });
        await tx.entity('Book').update('b', { authorId: 'a2' });
        await tx.entity('Author').delete('a');
      });
      const envelope = (await a.replication.page({ after: 2 })).items[0];
      // canonical order names the old parent's removal before the row moved off it
      assert.deepEqual(envelope.operations.map((/** @type {any} */ op) => `${op.table}/${op.key}`),
        ['Author/a', 'Author/a2', 'Book/b']);
      try {
        const result = how === 'apply' ? await b.replication.apply(envelope)
          : await b.replication.reset(await a.replication.snapshot());
        const same = JSON.stringify(await storeState(b, model)) === JSON.stringify(await storeState(a, model));
        outcomes.push(`${label}: ${result.status} ${JSON.stringify(await b.entity('Book').get('b'))}${same ? '' : ' (state differs)'}`);
      }
      catch (error) { outcomes.push(`${label}: ${/** @type {any} */ (error).message}`); }
      expected.push(`${label}: ${how === 'apply' ? 'applied' : 'reset'} {"id":"b","authorId":"a2","title":"t"}`);
    }
    finally { await a.close(); await b.close(); }
  }
  assert.deepEqual(outcomes, expected);
});

/** @param {string} to @param {string} via @param {string} onDelete */
const one = (to, via, onDelete) => ({ 'x-entity': { relation: { to, via, onDelete } } });
/** @param {string} to @param {string} via @param {string} onDelete */
const many = (to, via, onDelete) => ({ 'x-entity': { relation: { to, many: true, via, onDelete } } });
/** An entity keyed by `id`. @param {any} properties @param {string[]} [required] @param {any} [rest] */
const entity = (properties, required = ['id'], rest = {}) =>
  ({ schema: { type: 'object', required, properties: { id: key, ...properties } }, ...rest });
/** A user whose email is unique. */
const users = { $model: '0.1', entities: { User: entity({ email: { type: 'string', 'x-entity': { unique: true } } }) } };
/** Nodes under nodes, cascading, each with a unique value. */
const nodes = { $model: '0.1', entities: { N: entity({ parentId: { type: ['string', 'null'] },
  u: { type: 'string', 'x-entity': { unique: true } }, kids: many('N', 'parentId', 'cascade') }, ['id', 'u']) } };

/**
 * Transactions that pass a unique value from one row to another: each
 * shape's model, its seed (one transaction), its change (another) and, where
 * no order can replay it, the refusal.
 * @type {Record<string, [any, [string, any][], (tx: any) => Promise<void>, string?]>}
 */
const HANDOFFS = {
  // a passport moves to the person whose passport goes; its old person goes
  'one-to-one cascade key': [{ $model: '0.1', entities: { Person: entity({}),
    Passport: entity({ personId: { type: 'string' }, owner: one('Person', 'personId', 'cascade') }, ['id', 'personId']) } },
  [['Person', { id: 'A' }], ['Person', { id: 'B' }], ['Passport', { id: 'p1', personId: 'B' }],
    ['Passport', { id: 'p2', personId: 'A' }]],
  async (tx) => {
    await tx.entity('Passport').delete('p1');
    await tx.entity('Passport').update('p2', { personId: 'B' });
    await tx.entity('Person').delete('A');
  }],
  // the same, with the passport giving the person up sorting after the one taking it
  'one-to-one cascade key released after it is taken': [{ $model: '0.1', entities: { Person: entity({}),
    Passport: entity({ personId: { type: 'string' }, owner: one('Person', 'personId', 'cascade') }, ['id', 'personId']) } },
  [['Person', { id: 'A' }], ['Person', { id: 'B' }], ['Passport', { id: 'p1', personId: 'A' }],
    ['Passport', { id: 'p9', personId: 'B' }]],
  async (tx) => {
    await tx.entity('Passport').delete('p9');
    await tx.entity('Passport').update('p1', { personId: 'B' });
    await tx.entity('Person').delete('A');
  }],
  // an employee takes the desk of one who leaves; its old desk goes
  'one-to-one set-null key': [{ $model: '0.1', entities: { Desk: entity({}),
    Employee: entity({ deskId: { type: ['string', 'null'] }, desk: one('Desk', 'deskId', 'setNull') }) } },
  [['Desk', { id: 'north' }], ['Desk', { id: 'south' }], ['Employee', { id: 'e1', deskId: 'north' }],
    ['Employee', { id: 'e2', deskId: 'south' }]],
  async (tx) => {
    await tx.entity('Employee').delete('e1');
    await tx.entity('Employee').update('e2', { deskId: 'north' });
    await tx.entity('Desk').delete('south');
  }],
  // a book moves to a new library and takes the isbn another book gives up
  'unique member': [{ $model: '0.1', entities: { Library: entity({ books: many('Book', 'libraryId', 'cascade') }),
    Book: entity({ libraryId: { type: 'string' }, isbn: { type: 'string', 'x-entity': { unique: true } } }, ['id', 'libraryId']) } },
  [['Library', { id: 'L1' }], ['Library', { id: 'L9' }], ['Book', { id: 'X', libraryId: 'L9', isbn: '1' }],
    ['Book', { id: 'Y', libraryId: 'L1', isbn: '2' }]],
  async (tx) => {
    await tx.entity('Library').create({ id: 'L2' });
    await tx.entity('Book').update('X', { isbn: '3' });
    await tx.entity('Book').update('Y', { libraryId: 'L2', isbn: '1' });
    await tx.entity('Library').delete('L1');
  }],
  // a seat moves to a new row and takes the place of a seat that goes
  'composite unique index': [{ $model: '0.1', entities: { Row: entity({ seats: many('Seat', 'rowId', 'cascade') }),
    Seat: entity({ rowId: { type: 'string' }, hall: { type: 'string' }, number: { type: 'integer' } },
      ['id', 'rowId', 'hall', 'number'], { indexes: [{ name: 'place', path: ['$.hall', '$.number'], unique: true }] }) } },
  [['Row', { id: 'r1' }], ['Row', { id: 'r2' }], ['Seat', { id: 's1', rowId: 'r1', hall: 'h', number: 1 }],
    ['Seat', { id: 's2', rowId: 'r2', hall: 'h', number: 2 }]],
  async (tx) => {
    await tx.entity('Row').create({ id: 'r3' });
    await tx.entity('Seat').delete('s1');
    await tx.entity('Seat').update('s2', { rowId: 'r3', number: 1 });
    await tx.entity('Row').delete('r2');
  }],
  // a member moves to a new club and takes the email an active member frees by leaving the index
  'partial unique index': [{ $model: '0.1', entities: { Club: entity({ members: many('Member', 'clubId', 'cascade') }),
    Member: entity({ clubId: { type: 'string' }, email: { type: 'string' }, active: { type: 'boolean' } },
      ['id', 'clubId', 'email', 'active'],
      { indexes: [{ name: 'active_email', path: '$.email', unique: true, where: { $eq: ['$.active', true] } }] }) } },
  [['Club', { id: 'c1' }], ['Club', { id: 'c9' }], ['Member', { id: 'x', clubId: 'c9', email: 'a', active: true }],
    ['Member', { id: 'y', clubId: 'c1', email: 'b', active: true }]],
  async (tx) => {
    await tx.entity('Club').create({ id: 'c2' });
    await tx.entity('Member').update('x', { active: false });
    await tx.entity('Member').update('y', { clubId: 'c2', email: 'a' });
    await tx.entity('Club').delete('c1');
  }],
  // a row outside a partial index (it lacks the member the condition reads)
  // trades values with a row inside it: the row inside goes first
  'partial unique index, a row outside it': [{ $model: '0.1', entities: {
    M: entity({ p: { type: 'string' }, st: { type: 'string' } }, ['id', 'p'],
      { indexes: [{ name: 'on_p', path: '$.p', unique: true, where: { $eq: ['$.st', 'on'] } }] }) } },
  [['M', { id: 'X', p: 'a' }], ['M', { id: 'Y', p: 'b', st: 'on' }]],
  async (tx) => {
    await tx.entity('M').update('Y', { p: 'tmp' });
    await tx.entity('M').update('X', { p: 'b', st: 'on' });
    await tx.entity('M').update('Y', { p: 'a' });
  }],
  // a row moves off a parent the transaction removes and takes the parent's
  // value, which the partial index never held: the parent lacks its member
  'partial unique index, a moved row taking its removed parent value': [{ $model: '0.1', entities: {
    N: entity({ parentId: { type: ['string', 'null'] }, p: { type: 'string' }, st: { type: 'string' },
      kids: many('N', 'parentId', 'cascade') }, ['id'],
    { indexes: [{ name: 'on_p', path: '$.p', unique: true, where: { $eq: ['$.st', 'on'] } }] }) } },
  [['N', { id: 'a', parentId: null, p: 'x' }], ['N', { id: 'b', parentId: 'a', st: 'on' }], ['N', { id: 'q', parentId: null }]],
  async (tx) => {
    await tx.entity('N').update('b', { parentId: 'q', p: 'x' });
    await tx.entity('N').delete('a');
  }],
  // a row moves off a parent whose own parent the envelope removes first
  'two cascading levels': [{ $model: '0.1', entities: { Alpha: entity({ gammas: many('Gamma', 'alphaId', 'cascade') }),
    Gamma: entity({ alphaId: { type: 'string' }, betas: many('Beta', 'gammaId', 'cascade') }, ['id', 'alphaId']),
    Beta: entity({ gammaId: { type: 'string' }, n: { type: 'integer' } }, ['id', 'gammaId']) } },
  [['Alpha', { id: 'a1' }], ['Gamma', { id: 'g1', alphaId: 'a1' }], ['Beta', { id: 'b', gammaId: 'g1', n: 1 }]],
  async (tx) => {
    await tx.entity('Alpha').create({ id: 'a2' });
    await tx.entity('Gamma').create({ id: 'g2', alphaId: 'a2' });
    await tx.entity('Beta').update('b', { gammaId: 'g2', n: 2 });
    await tx.entity('Alpha').delete('a1');
  }],
  // the rows giving emails up sort after the rows taking them
  'released after it is taken': [users,
    [['User', { id: 'a1', email: 'p' }], ['User', { id: 'z8', email: 'y' }], ['User', { id: 'z9', email: 'x' }]],
    async (tx) => {
      await tx.entity('User').update('z9', { email: 'w' });
      await tx.entity('User').update('a1', { email: 'x' });
      await tx.entity('User').delete('z8');
      await tx.entity('User').create({ id: 'a0', email: 'y' });
    }],
  // a row must be written before its parent's removal, which cascades to it,
  // and after it, which releases the value it takes: no order replays it, and
  // the earliest pending write refuses — the moved row (`k` < `r`) ...
  'a moved row taking the value its removed parent releases, the row first': [nodes,
    [['N', { id: 'm', u: 'm' }], ['N', { id: 'r', u: 'x' }], ['N', { id: 'k', parentId: 'r', u: 'k' }]],
    async (tx) => {
      await tx.entity('N').update('k', { parentId: 'm' });
      await tx.entity('N').delete('r');
      await tx.entity('N').update('k', { u: 'x' });
    }, 'JD2005'],
  // ... or the removal (`p` < `q`), whose cascade then removes the moved row
  'a moved row taking the value its removed parent releases, the parent first': [nodes,
    [['N', { id: 'm', u: 'm' }], ['N', { id: 'p', u: 'x' }], ['N', { id: 'q', parentId: 'p', u: 'q' }]],
    async (tx) => {
      await tx.entity('N').update('q', { parentId: 'm' });
      await tx.entity('N').delete('p');
      await tx.entity('N').update('q', { u: 'x' });
    }, 'JD2104'],
  // two rows swap their emails: no order replays a rotation
  'rotated between rows': [users, [['User', { id: 'u1', email: 'x' }], ['User', { id: 'u2', email: 'y' }]],
    async (tx) => {
      await tx.entity('User').update('u1', { email: 't' });
      await tx.entity('User').update('u2', { email: 'x' });
      await tx.entity('User').update('u1', { email: 'y' });
    }, 'JD2005'],
};

it('replay releases a unique value before the write that takes it, a moved row included', async () => {
  const outcomes = [];
  const expected = [];
  for (const [shape, [model, seed, change, refusal]] of Object.entries(HANDOFFS))
    for (const mode of ['session', 'journal']) for (const how of ['apply', 'reset']) {
      const a = await open(model, mode, 'a');
      const b = await open(model, mode, 'b');
      const label = `${shape} ${mode} ${how}`;
      try {
        await a.transaction(async (/** @type {any} */ tx) => { for (const [name, doc] of seed) await tx.entity(name).create(doc); });
        for (const envelope of await exported(a)) await b.replication.apply(envelope);
        await a.transaction(change);
        try {
          const result = how === 'apply' ? await b.replication.apply((await a.replication.page({ after: 1 })).items[0])
            : await b.replication.reset(await a.replication.snapshot());
          const same = JSON.stringify(await storeState(b, model)) === JSON.stringify(await storeState(a, model));
          outcomes.push(`${label}: ${result.status}${same ? '' : ' (state differs)'}`);
        }
        catch (error) { outcomes.push(`${label}: ${/** @type {any} */ (error).code}`); }
        expected.push(`${label}: ${refusal ?? (how === 'apply' ? 'applied' : 'reset')}`);
      }
      finally { await a.close(); await b.close(); }
    }
  assert.deepEqual(outcomes, expected);
});

it('a reset writes rows in canonical order, whatever order the replica stored them in', async () => {
  const model = { $model: '0.1', collections: { users: { key: '/id', schema: { type: 'object', required: ['id', 'email'],
    properties: { id: { type: 'string' }, email: { type: 'string' } } }, indexes: [{ name: 'email', path: '$.email', unique: true }] } } };
  const everyone = [{ $for: { u: '$[*]' }, $orderby: '$u.id', $return: '$u' }];
  for (const mode of ['session', 'journal']) {
    const a = await open(model, mode, 'a');
    const b = await open(model, mode, 'b');
    try {
      // the replica stores t before r
      await a.collection('users').put({ id: 't', email: 'b' });
      await a.collection('users').put({ id: 'r', email: 'a' });
      for (const envelope of await exported(a)) await b.replication.apply(envelope);
      // r gives its email to t; canonical order writes r first
      await a.transaction(async (/** @type {any} */ tx) => {
        await tx.collection('users').put({ id: 'r', email: 'z' });
        await tx.collection('users').put({ id: 't', email: 'a' });
      });
      assert.equal((await b.replication.reset(await a.replication.snapshot())).status, 'reset', mode);
      assert.deepEqual(await b.collection('users').execute(everyone), await a.collection('users').execute(everyone), mode);
    }
    finally { await a.close(); await b.close(); }
  }
});

it('journal and session replicas converge on every delete path, and replays are inert', async () => {
  for (const [from, to] of [['journal', 'journal'], ['journal', 'session'], ['session', 'journal']]) {
    const origin = await open(cascadeModel(), from, 'origin');
    const replica = await open(cascadeModel(), to, 'replica');
    const pair = `${from} to ${to}`;
    try {
      /** @type {string[][]} */
      const published = [];
      /** @type {string[][]} */
      const received = [];
      origin.observe((/** @type {any} */ record) => { published.push(canonicalPatch(record.patch)); });
      replica.observe((/** @type {any} */ record) => { received.push(canonicalPatch(record.patch)); });
      let next = 0;
      const deliver = async () => {
        const page = await origin.replication.page({ after: next });
        for (const envelope of page.items) {
          assert.equal((await replica.replication.apply(envelope)).status, 'applied', pair);
          const emitted = received.length;
          const state = await storeState(replica, CASCADE);
          assert.equal((await replica.replication.apply(envelope)).status, 'duplicate', pair);
          assert.equal(received.length, emitted, `${pair}: a duplicate emits nothing`);
          assert.deepEqual(await storeState(replica, CASCADE), state, `${pair}: a duplicate changes nothing`);
        }
        next = page.next;
        assert.deepEqual(await storeState(replica, CASCADE), await storeState(origin, CASCADE), pair);
      };
      await seedCascade(origin);
      await deliver();
      // a tracked save, a transaction view and the store itself delete
      await cascadeWorkload(origin, deliver);
      // and the synchronous facade, which stays synchronous
      assert.equal(origin.sync.entity('Parent').delete('r'), true);
      await deliver();
      assert.equal(published.length, 21, pair);
      assert.deepEqual(received, published, `${pair}: the replica records what the origin recorded`);
    }
    finally { await origin.close(); await replica.close(); }
  }
});

it('seeded workloads converge under duplicated, reordered and dropped delivery', async () => {
  let refused = 0;
  for (let seed = 1; seed <= 15; seed += 1) {
    const origin = await open(trialModel(), 'journal', 'origin');
    const replicas = [await open(trialModel(), 'journal', 'journal'), await open(trialModel(), 'session', 'session')];
    try {
      refused += (await randomWorkload(origin, seed, OPERATIONS)).refused;
      const envelopes = await exported(origin);
      const expected = await storeState(origin, TRIAL);
      for (const replica of replicas) {
        for (const envelope of deliverySchedule(envelopes, { seed, drop: [seed % envelopes.length] })) {
          const before = await storeState(replica, TRIAL);
          try { await replica.replication.apply(envelope); }
          catch (error) {
            assert.equal(/** @type {any} */ (error).code, 'JD2100', `seed ${seed}`);
            assert.deepEqual(await storeState(replica, TRIAL), before, `seed ${seed}: a refused delivery changes nothing`);
          }
        }
        for (const envelope of envelopes)
          assert.match((await replica.replication.apply(envelope)).status, /^(applied|duplicate)$/, `seed ${seed}`);
        assert.deepEqual(await storeState(replica, TRIAL), expected, `seed ${seed}`);
      }
    }
    finally {
      await origin.close();
      for (const replica of replicas) await replica.close();
    }
  }
  // transactions that caught a refused delete and committed replicate too
  assert.ok(refused > 0);
});

it('a journal replica refuses an envelope missing a cascaded row', async () => {
  // a session origin's envelope is complete whatever the journal records, so
  // only the replica's own capture can find the row missing
  for (const from of ['session', 'journal']) {
    const origin = await open(cascadeModel(), from, 'origin');
    const replica = await open(cascadeModel(), 'journal', 'replica', { log: true });
    try {
      await seedCascade(origin);
      for (const envelope of await exported(origin)) await replica.replication.apply(envelope);
      const live = await replica.live(CHILDREN, { mode: 'incremental' });
      const oracle = liveOracle(live, () => replica.execute(CHILDREN));
      /** @type {any[]} */
      const events = [];
      replica.observe((/** @type {any} */ record) => { events.push(record); });
      const state = await storeState(replica, CASCADE);
      const frontier = await replica.replication.frontier();
      const changes = await replica.changes.page({ after: 0 });
      await origin.entity('Parent').delete('p');
      const [envelope] = (await origin.replication.page({ after: 17 })).items;
      const incomplete = { ...envelope, operations: envelope.operations.filter((/** @type {any} */ op) =>
        !(op.table === 'Child' && op.key === 'c2')) };
      assert.equal(incomplete.operations.length, envelope.operations.length - 1);
      await assert.rejects(replica.replication.apply(incomplete),
        { code: 'JD2104', reason: 'replication caused an undeclared row side effect' }, `from a ${from} origin`);
      assert.deepEqual(await storeState(replica, CASCADE), state);
      assert.deepEqual(await replica.replication.frontier(), frontier);
      assert.deepEqual(await replica.changes.page({ after: 0 }), changes);
      assert.equal(events.length, 0);
      assert.equal(oracle.emissions, 0);
      await oracle.check();
      assert.equal((await replica.replication.apply(envelope)).status, 'applied');
      assert.deepEqual(await storeState(replica, CASCADE), await storeState(origin, CASCADE));
      await oracle.check();
      oracle.close();
    }
    finally { await origin.close(); await replica.close(); }
  }
});

it('a child added under a parent another replica deletes refuses on both sides', async () => {
  for (const mode of ['session', 'journal']) {
    const a = await open(kids(), mode, 'a');
    const b = await open(kids(), mode, 'b');
    // stores for the resets: two empty ones, one holding only what a and b share
    const empty = [await open(kids(), mode, 'c'), await open(kids(), mode, 'e')];
    const shared = await open(kids(), mode, 'd');
    try {
      await a.entity('Parent').create({ id: 'p' });
      await a.entity('Kid').create({ id: 'k1', parentId: 'p' });
      for (const envelope of await exported(a)) {
        await b.replication.apply(envelope);
        await shared.replication.apply(envelope);
      }
      await b.entity('Kid').create({ id: 'k2', parentId: 'p' });
      await a.entity('Parent').delete('p');
      const [fromA] = (await a.replication.page({ after: 2 })).items;
      const [fromB] = (await b.replication.page()).items;
      const [stateA, stateB] = [await storeState(a, KIDS), await storeState(b, KIDS)];
      await assert.rejects(b.replication.apply(fromA),
        { code: 'JD2104', reason: 'replication caused an undeclared row side effect' }, mode);
      await assert.rejects(a.replication.apply(fromB), (/** @type {any} */ error) =>
        error.code === 'JD2005' && /FOREIGN KEY constraint failed/.test(error.message), mode);
      assert.deepEqual(await storeState(a, KIDS), stateA, mode);
      assert.deepEqual(await storeState(b, KIDS), stateB, mode);
      // neither then takes the other's later envelopes, nor resets from its snapshot
      await a.entity('Parent').create({ id: 'q' });
      await b.entity('Parent').create({ id: 'r' });
      const [laterA] = (await a.replication.page({ after: 3 })).items;
      const [laterB] = (await b.replication.page({ after: 1 })).items;
      await assert.rejects(b.replication.apply(laterA), { code: 'JD2100' }, mode);
      await assert.rejects(a.replication.apply(laterB), { code: 'JD2100' }, mode);
      const [snapshotA, snapshotB] = [await a.replication.snapshot(), await b.replication.snapshot()];
      await assert.rejects(b.replication.reset(snapshotA), { code: 'JD2105' }, mode);
      await assert.rejects(a.replication.reset(snapshotB), { code: 'JD2105' }, mode);
      // a store whose whole history a snapshot covers resets from it
      assert.equal((await empty[0].replication.reset(snapshotA)).status, 'reset', mode);
      assert.equal((await empty[1].replication.reset(snapshotB)).status, 'reset', mode);
      assert.equal((await shared.replication.reset(snapshotB)).status, 'reset', mode);
      assert.deepEqual(await storeState(empty[0], KIDS), await storeState(a, KIDS), mode);
      assert.deepEqual(await storeState(shared, KIDS), await storeState(b, KIDS), mode);
    }
    finally { for (const store of [a, b, ...empty, shared]) await store.close(); }
  }
});

it('a cascading delete beyond replication capacity refuses: before it runs under journal capture, at commit under session capture', async () => {
  const store = await open(cascadeModel(), 'journal', 'a', { maxOperations: 12 });
  try {
    // the root and its eleven rows are the twelve operations the bound admits
    await store.transaction(async (/** @type {any} */ tx) => {
      await tx.entity('Parent').create({ id: 'fits' });
      for (let i = 0; i < 7; i++) await tx.entity('Child').create({ id: `fits${i}`, parentId: 'fits', n: i });
    });
    await store.transaction(async (/** @type {any} */ tx) => {
      for (let i = 0; i < 4; i++) await tx.entity('Note').create({ id: `fits${i}`, parentId: 'fits' });
    });
    assert.equal(await store.entity('Parent').delete('fits'), true);
    const [fits] = (await store.replication.page({ after: 2 })).items;
    assert.equal(fits.operations.length, 12);
  }
  finally { await store.close(); }
  const reached = { code: 'JD2106', reason: 'a cascading delete exceeds replication capacity' };
  for (const [mode, config, refusal] of /** @type {[string, any, any][]} */ ([
    ['journal', { maxOperations: 12 }, reached],
    // the documents of the rows it reaches exceed the credit: before the delete
    ['journal', { maxBytes: 300 }, reached],
    // only its complete envelope does: at commit
    ['journal', { maxBytes: 900 }, { code: 'JD2074' }],
    // session capture finds the rows in the changeset, at commit
    ['session', { maxOperations: 12 }, { code: 'JD2106', reason: 'replication operation bound exceeded' }],
    ['session', { maxBytes: 300 }, { code: 'JD2074' }],
  ])) {
    const label = `${mode} ${JSON.stringify(config)}`;
    const family = await open(cascadeModel(), mode, 'a', config);
    try {
      // a parent, eight cascading children and six set-null notes, one row per transaction
      await family.entity('Parent').create({ id: 'p' });
      for (let i = 0; i < 8; i++) await family.entity('Child').create({ id: `c${i}`, parentId: 'p', n: i });
      for (let i = 0; i < 6; i++) await family.entity('Note').create({ id: `n${i}`, parentId: 'p' });
      const state = await storeState(family, CASCADE);
      const frontier = await family.replication.frontier();
      assert.deepEqual(frontier, { a: 15 }, label);
      await assert.rejects(family.entity('Parent').delete('p'), refusal, label);
      assert.deepEqual(await storeState(family, CASCADE), state, label);
      assert.deepEqual(await family.replication.frontier(), frontier, label);
    }
    finally { await family.close(); }
  }
});

it('a snapshot reset installs the cascaded state', async () => {
  const origin = await open(cascadeModel(), 'journal', 'origin');
  try {
    await seedCascade(origin);
    const seeded = await exported(origin);
    await cascadeWorkload(origin);
    await origin.entity('Parent').delete('r');
    const snapshot = await origin.replication.snapshot();
    const envelopes = await exported(origin);
    const expected = await storeState(origin, CASCADE);
    for (const mode of ['journal', 'session']) for (const stale of [false, true]) {
      const replica = await open(cascadeModel(), mode, 'replica');
      const label = `${mode}${stale ? ', holding the seed' : ''}`;
      try {
        // a stale replica's own foreign-key actions run during the reset
        if (stale) for (const envelope of seeded) await replica.replication.apply(envelope);
        assert.equal((await replica.replication.reset(snapshot)).status, 'reset', label);
        assert.deepEqual(await storeState(replica, CASCADE), expected, label);
        for (const envelope of envelopes)
          assert.equal((await replica.replication.apply(envelope)).status, 'duplicate', label);
      }
      finally { await replica.close(); }
    }
  }
  finally { await origin.close(); }
});

it('an async worker replica applies a cascade envelope', async () => {
  const origin = await open(cascadeModel(), 'journal', 'origin');
  const replica = await open(cascadeModel(), 'journal', 'replica', { driver: nodeWorkerDriver() });
  try {
    let next = 0;
    const deliver = async () => {
      const page = await origin.replication.page({ after: next });
      for (const envelope of page.items) {
        assert.equal((await replica.replication.apply(envelope)).status, 'applied');
        assert.equal((await replica.replication.apply(envelope)).status, 'duplicate');
      }
      next = page.next;
      assert.deepEqual(await storeState(replica, CASCADE), await storeState(origin, CASCADE));
    };
    await seedCascade(origin);
    await deliver();
    await cascadeWorkload(origin, deliver);
    await origin.entity('Parent').delete('r');
    await deliver();
  }
  finally { await origin.close(); await replica.close(); }
});

it('journal and session origins publish byte-identical cascade envelopes and snapshots', async () => {
  /** The corpus workload, then seeds 1-5, each on a fresh origin over `driver`.
   * @param {() => any} driver @param {string} mode */
  const publish = async (driver, mode) => {
    const runs = [];
    /** @param {any} store */
    const outputs = async (store) => ({ envelopes: (await exported(store)).map(encodeReplication),
      snapshot: JSON.stringify(await store.replication.snapshot()) });
    const corpus = await open(cascadeModel(), mode, 'origin', { driver: driver() });
    try {
      await seedCascade(corpus);
      await cascadeWorkload(corpus);
      await corpus.entity('Parent').delete('r');
      runs.push(await outputs(corpus));
    }
    finally { await corpus.close(); }
    for (let seed = 1; seed <= 5; seed += 1) {
      const store = await open(trialModel(), mode, 'origin', { driver: driver() });
      try {
        await randomWorkload(store, seed, OPERATIONS);
        runs.push(await outputs(store));
      }
      finally { await store.close(); }
    }
    return runs;
  };
  const expected = await publish(() => nodeDriver(), 'session');
  assert.equal(expected[0].envelopes.length, 21);
  for (const [host, driver] of /** @type {[string, () => any][]} */ ([['node:sqlite', () => nodeDriver()],
    ['sqlite-wasm', () => wasmDriver(sqlite3Handle(sqlite3))], ['the Node worker host', () => nodeWorkerDriver()]])) {
    const runs = await publish(driver, 'journal');
    for (const [at, run] of runs.entries()) {
      const label = `${host}, ${at === 0 ? 'the corpus workload' : `seed ${at}`}`;
      assert.deepEqual(run.envelopes, expected[at].envelopes, label);
      assert.equal(run.snapshot, expected[at].snapshot, label);
    }
  }
});
