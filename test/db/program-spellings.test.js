//@ts-check
/**
 * @file The text of a database rule's installed programs, as each release
 * planned it. This release's PostgreSQL programs lock the row an
 * `$exists-row` probe finds where no odd number of `$not`s encloses it —
 * `FOR KEY SHARE` when every matched member is a key column, `FOR SHARE`
 * otherwise, the store probe's own choice — where an earlier release's took
 * no lock; a negated probe reads unlocked in both; SQLite's writer lock serializes writes, so
 * its programs spell none and read alike at every spelling. A store an
 * earlier release created opens, reports each program it holds at that
 * release's spelling and keeps answering as that release did; a program no
 * spelling plans is refused as before. On a live server (`JAREN_PG_URL`;
 * skipped without it, three connections at most): the programs as installed,
 * the open over each spelling, and a delete or a change of the found row raced
 * against the probing write — both commit under the earlier spelling, never
 * under this release's, in a fresh store or one the reviewed link
 * (`planProgramUpgrade`) brought to it.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { explainMapping, migrate, normalizeEntities, openStore, planInvariants, planProgramUpgrade, sqliteDialect } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { postgresDialect } from '@jarenjs/db/postgres';
import { planEntity } from '../../packages/db/src/ddl.js';
import { CURRENT_SPELLING, PROGRAM_SPELLINGS } from '../../packages/db/src/dialects/program-spellings.js';
import { column } from './invariant-oracle.js';
import { PG_URL, withPostgres } from './store-core-engines.js';

const skip = !PG_URL && 'JAREN_PG_URL is not set';
const TENANT = postgresDialect({ searchPath: 'tenant' });
/** @param {string} name */
const col = (name) => ({ $sql: 'column', name });
const CHILD = { type: 'object', properties: { id: { type: 'integer', 'x-entity': { key: true } }, ref: { type: 'integer' } } };
/** A rule of `enforcement` on `on` that requires a parent matching `match`. @param {any} match @param {string} [enforcement] @param {string[]} [on] */
const requires = (match, enforcement = 'database', on = ['insert']) =>
  [{ name: 'r', on, enforcement, assert: { '$exists-row': { entity: 'Parent', match } } }];

/**
 * Parents on a layout the store owns — a unique code, an indexed group, a
 * status, `a` and `b` under one unique entity index, a member unique only
 * among open parents — and children whose rule of `enforcement` probes them
 * by `match`.
 * @param {any} match @param {string} [enforcement]
 */
const ownedModel = (match, enforcement = 'database') => ({ $model: '0.1', entities: {
  Parent: { schema: { type: 'object', properties: { id: { type: 'integer', 'x-entity': { key: true } },
    code: { type: 'integer', 'x-entity': { unique: true } }, grp: { type: 'integer', 'x-entity': { index: true } }, status: { type: 'string' },
    a: { type: 'integer' }, b: { type: 'integer' }, part: { type: 'integer' } } },
  indexes: [{ name: 'parent_ab', path: ['$.a', '$.b'], unique: true }, { name: 'parent_part', path: '$.part', unique: true, where: { $eq: ['$.status', 'open'] } }] },
  Child: { schema: CHILD, invariants: requires(match, enforcement) },
} });

/** Parents and children over existing tables, the parents with a unique code and a group index. @param {any} match @param {string} [enforcement] */
const physicalModel = (match, enforcement = 'database') => ({ $model: '0.1', entities: {
  Parent: { schema: { type: 'object', properties: { id: { type: 'integer', 'x-entity': { key: true } }, code: { type: 'integer' }, grp: { type: 'integer' },
    status: { type: 'string' } } },
  physical: { table: 'parent', columns: { id: column('id'), code: column('code'), grp: column('grp'), status: column('status', 'text') },
    indexes: [{ name: 'parent_code', unique: true, terms: [{ by: col('code') }] }, { name: 'parent_grp', terms: [{ by: col('grp') }] }] } },
  Child: { schema: CHILD, physical: { table: 'child', columns: { id: column('id'), ref: column('ref') } }, invariants: requires(match, enforcement) },
} });

/** Every program item of `model`'s entities, as spelling `spelling` plans it on `dialect`. @param {any} model @param {any} dialect @param {number} spelling */
const spelledItems = (model, dialect, spelling) => {
  const mapping = explainMapping(model);
  return Object.entries(mapping.entities).flatMap(([name, entity]) => {
    const plan = /** @type {any} */ (planEntity(name, entity, mapping, dialect));
    return plan.physical ? plan.physical.triggersAt(spelling) : plan.programsAt(spelling);
  });
};

/** A probe of every kind a program holds: the key, a unique member, an indexed member, the key and a plain member — on insert, update and delete. */
const SHAPES = [{ id: '$.new.ref' }, { code: '$.new.ref' }, { grp: '$.new.ref' }, { id: '$.new.ref', status: 'open' }];
const shapeModels = () => SHAPES.flatMap((match) => [ownedModel(match), physicalModel(match)]).concat([
  { $model: '0.1', entities: { ...ownedModel({}).entities, Child: { schema: CHILD, invariants: [
    ...requires({ id: '$.new.ref' }, 'database', ['update']), { name: 'gone', on: ['delete'], enforcement: 'database',
      assert: { $not: { '$exists-row': { entity: 'Parent', match: { id: '$.old.ref' } } } } }] } } }]);

describe('the spellings of an installed program', () => {
  it('are the earlier releases\' and this release\'s, which this release plans', () => {
    assert.deepEqual(PROGRAM_SPELLINGS, [{ lockedProbe: false }, { lockedProbe: true }]);
    assert.equal(CURRENT_SPELLING, 1);
    assert.ok(Object.isFrozen(PROGRAM_SPELLINGS) && PROGRAM_SPELLINGS.every((spelling) => Object.isFrozen(spelling)));
    for (const model of shapeModels()) for (const dialect of [sqliteDialect, TENANT])
      assert.deepEqual(spelledItems(model, dialect, CURRENT_SPELLING), planInvariants(model, { dialect }));
  });

  it('read alike on SQLite, which spells no lock', () => {
    for (const model of shapeModels()) assert.deepEqual(spelledItems(model, sqliteDialect, 0), spelledItems(model, sqliteDialect, CURRENT_SPELLING));
  });

  it('differ on PostgreSQL only by the lock in a probing function\'s source', () => {
    let locked = 0;
    for (const model of shapeModels()) {
      const earlier = spelledItems(model, TENANT, 0), current = spelledItems(model, TENANT, CURRENT_SPELLING);
      assert.deepEqual(current.map((item) => [item.type, item.name, item.drop]), earlier.map((item) => [item.type, item.name, item.drop]));
      current.forEach((item, i) => {
        const unlocked = (/** @type {string} */ text) => text.replace(/ FOR (KEY )?SHARE\)/g, ')');
        assert.equal(unlocked(item.sql), earlier[i].sql);
        if (item.program !== undefined)
          assert.deepEqual({ ...item.program, function: { ...item.program.function, source: unlocked(item.program.function.source) } }, earlier[i].program);
        if (item.sql !== earlier[i].sql) locked++;
      });
    }
    // every probing function but the negated delete probe's, whose found row refuses the write and so reads unlocked
    assert.equal(locked, 9);
    const negated = shapeModels().at(-1);
    assert.deepEqual(spelledItems(negated, TENANT, CURRENT_SPELLING).filter((item) => item.name.endsWith('_delete')),
      spelledItems(negated, TENANT, 0).filter((item) => item.name.endsWith('_delete')));
  });

  it('lock the row a probe finds as the store probe does, by whether every matched member is a key column', () => {
    const keyShare = (/** @type {any} */ model) => /** @type {any} */ (normalizeEntities(model)).get('Child').invariants[0].probes[0].keyShare;
    const cases = [{ id: '$.new.ref' }, { code: '$.new.ref' }, { a: '$.new.ref', b: '$.new.ref' }, { id: '$.new.ref', code: 7 }, { id: '$.new.ref', a: 7 },
      { grp: '$.new.ref' }, { id: '$.new.ref', status: 'open' }, { id: '$.new.ref', part: 7 }];
    const lockOf = (/** @type {any} */ model) => / FOR KEY SHARE\)/.test(planInvariants(model, { dialect: TENANT })[0].sql) ? 'FOR KEY SHARE'
      : / FOR SHARE\)/.test(planInvariants(model, { dialect: TENANT })[0].sql) ? 'FOR SHARE' : 'none';
    const owned = cases.map((match) => [lockOf(ownedModel(match)), keyShare(ownedModel(match, 'store')) ? 'FOR KEY SHARE' : 'FOR SHARE']);
    assert.deepEqual(owned.map(([program]) => program), ['FOR KEY SHARE', 'FOR KEY SHARE', 'FOR KEY SHARE', 'FOR KEY SHARE', 'FOR KEY SHARE',
      'FOR SHARE', 'FOR SHARE', 'FOR SHARE']);
    assert.deepEqual(owned.map(([, store]) => store), owned.map(([program]) => program));
    const physical = [{ code: '$.new.ref' }, { grp: '$.new.ref' }, { id: '$.new.ref', status: 'x' }, { id: '$.new.ref', code: 7 }]
      .map((match) => [lockOf(physicalModel(match)), keyShare(physicalModel(match, 'store')) ? 'FOR KEY SHARE' : 'FOR SHARE']);
    assert.deepEqual(physical, [['FOR KEY SHARE', 'FOR KEY SHARE'], ['FOR SHARE', 'FOR SHARE'], ['FOR SHARE', 'FOR SHARE'], ['FOR KEY SHARE', 'FOR KEY SHARE']]);
  });

  it('lock only a probe an even number of $not encloses, through $and and $or alone, as the store probe does', () => {
    const P = (/** @type {any} */ match) => ({ '$exists-row': { entity: 'Parent', match } });
    const key = P({ id: '$.new.ref' }), status = P({ id: '$.new.ref', status: 'open' }), code = P({ code: '$.new.ref' }), group = P({ grp: '$.new.ref' });
    const withAssert = (/** @type {any} */ assert, /** @type {string} */ enforcement) => ({ $model: '0.1', entities: { ...ownedModel({}).entities,
      Child: { schema: CHILD, invariants: [{ name: 'r', on: ['insert'], enforcement, assert }] } } });
    /** Each probe's lock, in the program's order. @param {string} sql */
    const programLocks = (sql) => [...sql.matchAll(/EXISTS \(/g)].map((match) => {
      let depth = 0, i = /** @type {number} */ (match.index) + 'EXISTS '.length;
      for (; i < sql.length; i++) { depth += sql[i] === '(' ? 1 : sql[i] === ')' ? -1 : 0; if (depth === 0) break; }
      return / FOR KEY SHARE\)$/.test(sql.slice(match.index, i + 1)) ? 'FOR KEY SHARE' : / FOR SHARE\)$/.test(sql.slice(match.index, i + 1)) ? 'FOR SHARE' : 'none';
    });
    /** Each probe's lock, as the store's resolved probes choose it. @param {any} model */
    const storeLocks = (model) => /** @type {any} */ (normalizeEntities(model)).get('Child').invariants[0].probes
      .map((/** @type {any} */ probe) => (!probe.positive ? 'none' : probe.keyShare ? 'FOR KEY SHARE' : 'FOR SHARE'));
    const cases = /** @type {[any, string[]][]} */ ([
      [key, ['FOR KEY SHARE']],
      [{ $not: key }, ['none']],
      [{ $not: { $not: key } }, ['FOR KEY SHARE']],
      [{ $or: [{ $not: key }, status] }, ['none', 'FOR SHARE']],
      [{ $and: [group, { $not: { $or: [key, { $not: code }] } }] }, ['FOR SHARE', 'none', 'FOR KEY SHARE']],
    ]);
    for (const [assert_, locks] of cases) {
      assert.deepEqual(programLocks(planInvariants(withAssert(assert_, 'database'), { dialect: TENANT })[0].sql), locks, JSON.stringify(assert_));
      assert.deepEqual(storeLocks(withAssert(assert_, 'database')), locks, JSON.stringify(assert_));
      assert.deepEqual(storeLocks(withAssert(assert_, 'store')), locks, JSON.stringify(assert_));
    }
    // a store rule may compare a probe's answer, or use it as a value: no monotone verdict, so no lock
    for (const assert_ of [{ $eq: [key, false] }, { $ne: [key, true] }, { $not: { $eq: [key, false] } }, { $or: [{ $eq: [true, key] }] }, { $boolean: key }])
      assert.deepEqual(storeLocks(withAssert(assert_, 'store')), ['none'], JSON.stringify(assert_));
  });

  it('leave a SQLite store with nothing earlier to report', async () => {
    const store = await openStore(ownedModel({ id: '$.new.ref' }), { driver: nodeDriver() });
    try { assert.deepEqual(store.earlierPrograms, []); assert.ok(Object.isFrozen(store.earlierPrograms)); }
    finally { await store.close(); }
  });
});

/**
 * Parents with a status on a layout the store owns, and two children whose
 * database rule requires one: by the key, which locks `FOR KEY SHARE`, and by
 * the key and the status, which locks `FOR SHARE`.
 */
const raceModel = { $model: '0.1', entities: {
  Parent: { schema: { type: 'object', properties: { id: { type: 'integer', 'x-entity': { key: true } }, status: { type: 'string' } } } },
  ByKey: { schema: CHILD, invariants: requires({ id: '$.new.ref' }) },
  ByKeyStatus: { schema: CHILD, invariants: requires({ id: '$.new.ref', status: 'open' }) },
} };
const RACED = /** @type {Record<string, { change: string, requires: string }>} */ ({
  ByKey: { change: 'UPDATE "Parent" SET id = 2 WHERE id = 1', requires: 'p.id = c.ref' },
  ByKeyStatus: { change: `UPDATE "Parent" SET status = 'closed' WHERE id = 1`, requires: `p.id = c.ref AND p.status = 'open'` },
});

/** Each program function of `model`, as spelling `spelling` plans it in `schema`, installed over what the table holds. @param {any} pool @param {any} model @param {string} schema @param {number} spelling */
const install = async (pool, model, schema, spelling) => {
  for (const item of spelledItems(model, postgresDialect({ searchPath: schema }), spelling))
    if (item.type === 'function') await pool.query(item.sql.replace(/^CREATE FUNCTION /, 'CREATE OR REPLACE FUNCTION '));
};

describe('installed programs on PostgreSQL', () => {
  it('lock in a fresh store; a store holding an earlier spelling opens, reports it and answers as before; another text is refused as before', { skip }, () =>
    withPostgres(async ({ pool, schema, driver }) => {
      const sources = async () => (await pool.query(`SELECT p.proname AS name, p.prosrc AS source FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = $1 ORDER BY 1`, [schema])).rows.map((/** @type {any} */ row) => [row.name, / FOR (KEY )?SHARE\)/.exec(row.source)?.[0] ?? null]);
      const opened = async () => {
        const store = await openStore(raceModel, { driver: driver() });
        try { return store.earlierPrograms; } finally { await store.close(); }
      };
      assert.deepEqual(await opened(), []);
      assert.deepEqual(await sources(), [['_jaren_rule_11_ByKeyStatus_insert', ' FOR SHARE)'], ['_jaren_rule_5_ByKey_insert', ' FOR KEY SHARE)']]);
      await install(pool, raceModel, schema, 0);
      assert.deepEqual(await sources(), [['_jaren_rule_11_ByKeyStatus_insert', null], ['_jaren_rule_5_ByKey_insert', null]]);
      const earlier = await opened();
      assert.deepEqual(earlier, [{ table: 'ByKey', program: '_jaren_rule_5_ByKey_insert', spelling: 0 },
        { table: 'ByKeyStatus', program: '_jaren_rule_11_ByKeyStatus_insert', spelling: 0 }]);
      assert.ok(Object.isFrozen(earlier) && earlier.every((entry) => Object.isFrozen(entry)));
      // it reads and writes as before, its rules judging writes as that release's did
      const store = await openStore(raceModel, { driver: driver() });
      try {
        await store.entity('Parent').create({ id: 1, status: 'open' });
        await store.entity('ByKey').create({ id: 1, ref: 1 });
        await assert.rejects(store.entity('ByKey').create({ id: 2, ref: 9 }), { code: 'JD2096', message: /jaren invariant:r/ });
        assert.deepEqual(await store.entity('ByKey').get(1), { id: 1, ref: 1 });
      }
      finally { await store.close(); }
      // one program brought to this release's spelling: the other alone is reported
      const mapping = explainMapping(raceModel);
      const current = planEntity('ByKey', mapping.entities.ByKey, mapping, postgresDialect({ searchPath: schema })).programs;
      const fn = current.find((/** @type {any} */ item) => item.type === 'function');
      await pool.query(fn.sql.replace(/^CREATE FUNCTION /, 'CREATE OR REPLACE FUNCTION '));
      assert.deepEqual(await opened(), [{ table: 'ByKeyStatus', program: '_jaren_rule_11_ByKeyStatus_insert', spelling: 0 }]);
      // a text no release planned — a blank line in the source — is refused as before
      await pool.query(fn.sql.replace(/^CREATE FUNCTION /, 'CREATE OR REPLACE FUNCTION ').replace('BEGIN', 'BEGIN\n'));
      await assert.rejects(opened(), { code: 'JD0002', docPath: '/entities/ByKey', message: "JD0002: entity 'ByKey': the existing table does not match the declared "
        + "model (invariant trigger '_jaren_rule_5_ByKey_insert' is missing or changed (function.source); apply an explicit migration); reshaping a live "
        + 'database is the migration story, and nothing was altered at /entities/ByKey' });
    }));

  it('report a physical layout\'s earlier programs by its table, and refuse another text as before', { skip }, () =>
    withPostgres(async ({ pool, schema, driver }) => {
      const model = physicalModel({ code: '$.new.ref' });
      await pool.query(`SET search_path TO "${schema}"; CREATE TABLE parent(id integer PRIMARY KEY, code integer, grp integer, status text);
        CREATE UNIQUE INDEX parent_code ON parent(code); CREATE INDEX parent_grp ON parent(grp); CREATE TABLE child(id integer PRIMARY KEY, ref integer); RESET search_path`);
      const items = spelledItems(model, postgresDialect({ searchPath: schema }), 0);
      for (const item of items) await pool.query(item.sql);
      const store = await openStore(model, { driver: driver(), adopt: true });
      try { assert.deepEqual(store.earlierPrograms, [{ table: 'child', program: '_jaren_rule_5_child_insert', spelling: 0 }]); }
      finally { await store.close(); }
      await pool.query(items[0].sql.replace(/^CREATE FUNCTION /, 'CREATE OR REPLACE FUNCTION ').replace('BEGIN', 'BEGIN\n'));
      await assert.rejects(openStore(model, { driver: driver(), adopt: true }), { code: 'JD0002',
        message: "JD0002: physical 'child': invariant trigger '_jaren_rule_5_child_insert' is missing or changed (function.source); apply an explicit migration" });
    }));
});

// one row of the race: the outcome of each step, then what the two left
const HELD = { writeFirst: ['ok', '55P03', 'ok', 'ok', { orphans: 0, children: 1 }], otherFirst: ['ok', 'blocked', 'ok', 'refused', { orphans: 0, children: 0 }] };
const BOTH = { writeFirst: ['ok', 'ok', 'ok', 'ok', { orphans: 1, children: 1 }], otherFirst: ['ok', 'settled', 'ok', 'ok', { orphans: 1, children: 1 }] };
const PASSES = { writeFirst: ['ok', 'ok', 'ok', 'ok', { orphans: 0, children: 1 }], otherFirst: ['ok', 'settled', 'ok', 'ok', { orphans: 0, children: 1 }] };

describe('a delete or a change of the row a database rule\'s probe found, raced against the probing write on PostgreSQL', () => {
  it('both commit under the earlier spelling, never under this release\'s, in a fresh store or one brought to it', { skip }, () =>
    withPostgres(async ({ pool, schema, driver }) => {
      const { default: pg } = await import('pg');
      await (await openStore(raceModel, { driver: driver() })).close();
      // the probing writer on the pool's connection, the other writer on its own, the observer on the pool
      const writer = await pool.connect();
      const other = new pg.Client({ connectionString: PG_URL });
      await other.connect();
      try {
        for (const client of [writer, other]) await client.query(`SET search_path TO "${schema}"; SET lock_timeout = '300ms'`);
        const otherPid = (await other.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        /** @param {Promise<unknown>} run */
        const outcome = (run) => run.then(() => 'ok', (/** @type {any} */ error) => (error.code === '23J01' ? 'refused' : error.code));
        /** Whether `write` settled, or waits for a lock the other writer holds. @param {Promise<unknown>} write */
        const settledOrBlocked = async (write) => {
          let settled = false;
          write.then(() => { settled = true; });
          for (let i = 0; i < 500; i++) {
            if (settled) return 'settled';
            const { rows } = await pool.query('SELECT EXISTS (SELECT 1 FROM pg_locks l WHERE NOT l.granted AND $1 = ANY (pg_blocking_pids(l.pid))) AS blocked', [otherPid]);
            if (rows[0].blocked) return 'blocked';
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          return 'neither';
        };
        const left = async (/** @type {string} */ table) => (await pool.query(`SELECT (SELECT count(*) FROM "${schema}"."${table}" c WHERE NOT EXISTS (
          SELECT 1 FROM "${schema}"."Parent" p WHERE ${RACED[table].requires}))::int AS orphans, (SELECT count(*) FROM "${schema}"."${table}")::int AS children`)).rows[0];
        const reset = (/** @type {string} */ table) => pool.query(`TRUNCATE "${schema}"."${table}", "${schema}"."Parent"; `
          + `INSERT INTO "${schema}"."Parent"(id, status, doc) VALUES (1, 'open', '{}')`);
        const runs = async () => {
          /** @type {Record<string, Record<string, any>>} */
          const result = {};
          for (const table of Object.keys(RACED)) {
            result[table] = {};
            const insert = `INSERT INTO "${table}"(id, ref, doc) VALUES (1, 1, '{}')`;
            const writes = [['delete', 'DELETE FROM "Parent" WHERE id = 1'], ['change', RACED[table].change]];
            // a change of a member the key probe does not compare
            if (table === 'ByKey') writes.push(['other', `UPDATE "Parent" SET status = 'x' WHERE id = 1`]);
            for (const [label, sql] of writes) {
              // the probing write first, its transaction open while the other writer runs
              await reset(table);
              await writer.query('BEGIN');
              const writeFirst = [await outcome(writer.query(insert))];
              await other.query('BEGIN');
              writeFirst.push(await outcome(other.query(sql)), await outcome(other.query('COMMIT')), await outcome(writer.query('COMMIT')), await left(table));
              // the other writer first, its transaction open while the probing write runs
              await reset(table);
              await other.query('BEGIN');
              const otherFirst = [await outcome(other.query(sql))];
              const write = outcome(writer.query(insert));
              otherFirst.push(await settledOrBlocked(write), await outcome(other.query('COMMIT')), await write, await left(table));
              result[table][label] = { writeFirst, otherFirst };
            }
          }
          return result;
        };
        const held = { ByKey: { delete: HELD, change: HELD, other: PASSES }, ByKeyStatus: { delete: HELD, change: HELD } };
        assert.deepEqual(await runs(), held, 'a fresh store');
        await install(pool, raceModel, schema, 0);
        assert.deepEqual(await runs(), { ByKey: { delete: BOTH, change: BOTH, other: PASSES }, ByKeyStatus: { delete: BOTH, change: BOTH } }, 'the earlier spelling');
        // the reviewed link brings it to this release's spelling
        const connection = await driver().open();
        const link = await Promise.resolve(planProgramUpgrade(connection, raceModel)).finally(() => connection.close());
        assert.deepEqual(link.report.upgraded, ['ByKey._jaren_rule_5_ByKey_insert', 'ByKeyStatus._jaren_rule_11_ByKeyStatus_insert']);
        await migrate({ driver: driver() }, [link.migration], { baseline: raceModel, model: raceModel, shadow: false });
        assert.deepEqual(await runs(), held, 'brought to this release\'s spelling');
      }
      finally {
        writer.release();
        await other.end();
      }
    }));
});
