//@ts-check
/**
 * @file Database rules over a layout the store owns: the programs the store
 * installs with its table, what they refuse from every writer, what a
 * store-owned rule cannot lower, how an open verifies the installed programs,
 * the migration planner's program diff, a store rule judging the record
 * the store reads back, and the rows a foreign-key action removes or nulls. The live PostgreSQL half is
 * `postgres-store-owned-rules.test.js`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrate, normalizeEntities, openStore, planInvariants, planModelMigration, sqliteDialect } from '@jarenjs/db';
import { adaptNodeDatabase, nodeDriver } from '@jarenjs/db/node';
import { postgresDialect } from '@jarenjs/db/postgres';
import { actionChainModel, BOOKING_TRANSFORM, bookingModel, childRuleMeetsParentAction, narrowedBookingModel, storeRulesMeetForeignKeyActions }
  from './invariant-oracle.js';
import { tempDbPath } from './helpers.js';

const TENANT = postgresDialect({ searchPath: 'tenant' });
const DIALECTS = /** @type {const} */ ([['sqlite', sqliteDialect], ['postgres', TENANT]]);

/** A store-owned `E` whose one database rule takes `rule`'s members, beside further members. */
const ruled = (/** @type {Record<string, unknown>} */ rule, /** @type {Record<string, unknown>} */ properties = {}) => ({ $model: '0.1', entities: {
  E: { schema: { type: 'object', properties: { id: { type: 'string', 'x-entity': { key: true } }, a: { type: 'integer' }, ...properties } },
    invariants: [{ name: 'r', on: ['insert', 'update'], enforcement: 'database', assert: { $ge: ['$.new.a', 0] }, ...rule }] } } });
/** A physical table another entity's rule could write or read. */
const LOG = { schema: { type: 'object', properties: { id: { type: 'integer', 'x-entity': { key: true } }, a: { type: 'integer' } } },
  physical: { table: 'log', columns: { id: { name: 'id', codec: 'integer', null: 'reject' }, a: { name: 'a', codec: 'integer', null: 'null' } } } };

/** `bookingModel` with its `ordered` rule asserting `assert`. @param {any} assert */
const reordered = (assert) => {
  const model = /** @type {any} */ (bookingModel());
  model.entities.Booking.invariants[0].assert = assert;
  return model;
};

/** The statements that drop `bookingModel`'s programs, the last installed first. @param {string} dialect */
const bookingDrops = (dialect) => (dialect === 'sqlite'
  ? ['delete', 'update', 'insert'].map((op) => `DROP TRIGGER "_jaren_rule_7_Booking_${op}"`)
  : ['truncate', 'delete', 'update', 'insert'].flatMap((op) => [`DROP TRIGGER "_jaren_rule_7_Booking_${op}" ON "tenant"."Booking"`,
    `DROP FUNCTION "tenant"."_jaren_rule_7_Booking_${op}"()`]));

/** The statements a migration plan carries, in order. @param {any} migration */
const statements = (migration) => migration.steps.flatMap((/** @type {any} */ step) => (step.kind === 'rebuild'
  ? [...step.create, step.copy, '<drop and rename>', ...step.indexes] : typeof step.sql === 'string' ? [step.sql] : []));

describe('a database rule on a store-owned layout, on SQLite', () => {
  it('refuses an inverted span from the store and from an outside writer, and accepts an ordered one', async () => {
    const { dbPath, cleanup } = tempDbPath();
    try {
      const store = await openStore(bookingModel(), { driver: nodeDriver(), path: dbPath });
      try {
        const bookings = store.entity('Booking');
        await assert.rejects(bookings.create({ id: 'a', startsAt: 5, endsAt: 1 }), { code: 'JD2096', class: 'constraint' });
        const outside = new DatabaseSync(dbPath);
        try {
          assert.throws(() => outside.exec('INSERT INTO "Booking" (id, "startsAt", "endsAt", doc) VALUES (\'x\', 5, 1, jsonb(\'{}\'))'),
            /jaren invariant:ordered/);
          outside.exec('INSERT INTO "Booking" (id, "startsAt", "endsAt", doc) VALUES (\'y\', 1, 5, jsonb(\'{}\'))');
        }
        finally { outside.close(); }
        assert.deepEqual(await bookings.create({ id: 'b', startsAt: 1, endsAt: 5 }), { id: 'b', startsAt: 1, endsAt: 5 });
        assert.deepEqual(await bookings.get('y'), { id: 'y', startsAt: 1, endsAt: 5 });
        assert.equal(await bookings.get('a'), undefined);
      }
      finally { await store.close(); }
    }
    finally { cleanup(); }
  });

  it('installs one trigger per operation with its table, the change test counting every column and the document', async () => {
    const planned = planInvariants(bookingModel(), { dialect: sqliteDialect });
    assert.deepEqual(planned.map((item) => [item.type, item.name, item.rule]), [
      ['trigger', '_jaren_rule_7_Booking_insert', 'ordered'], ['trigger', '_jaren_rule_7_Booking_update', 'ordered'],
      ['trigger', '_jaren_rule_7_Booking_delete', 'kept']]);
    // an update judges a change of any column, or of the document's bytes
    assert.match(planned[1].sql, /WHERE \(OLD\."id" IS NOT NEW\."id" OR OLD\."startsAt" IS NOT NEW\."startsAt" OR OLD\."endsAt" IS NOT NEW\."endsAt" OR OLD\."room" IS NOT NEW\."room" OR OLD\."doc" IS NOT NEW\."doc"\) AND /);
    const { dbPath, cleanup } = tempDbPath();
    try {
      await (await openStore(bookingModel(), { driver: nodeDriver(), path: dbPath })).close();
      const db = new DatabaseSync(dbPath);
      try {
        assert.deepEqual(db.prepare('SELECT name, sql FROM sqlite_schema WHERE type = \'trigger\' ORDER BY rowid').all().map((row) => ({ ...row })),
          planned.map((item) => ({ name: item.name, sql: item.sql })));
      }
      finally { db.close(); }
    }
    finally { cleanup(); }
  });

  it('refuses at the member what a store-owned layout does not lower: an epoch, document or relation member, an audit, an effect, columns, a probe', () => {
    const at = { type: 'string', format: 'date-time', 'x-entity': { column: 'integer' } };
    const parented = /** @type {any} */ (ruled({ assert: { $eq: ['$.new.parent', 1] } }));
    parented.entities.P = { schema: { type: 'object', properties: { id: { type: 'integer', 'x-entity': { key: true } } } } };
    parented.entities.E.schema.properties.parentId = { type: 'integer' };
    parented.entities.E.schema.properties.parent = { 'x-entity': { relation: { to: 'P', via: 'parentId', onDelete: 'cascade' } } };
    const logged = /** @type {any} */ (ruled({ audit: { entity: 'Log', values: { a: '$.new.a' } } }));
    logged.entities.Log = LOG;
    const probing = /** @type {any} */ (ruled({ assert: { '$exists-row': { entity: 'Log', match: { id: 1 } } } }));
    probing.entities.Log = LOG;
    const CASES = [
      ['an epoch member', ruled({ assert: { $le: ['$.new.at', '$.new.at'] } }, { at }), 'assert', /'at' holds an epoch \(milliseconds\) in its column/],
      ['an array member', ruled({ assert: { $eq: ['$.new.tags', 1] } }, { tags: { type: 'array' } }), 'assert', /'tags' lives in the entity's document/],
      ['a member of two types', ruled({ assert: { $eq: ['$.new.u', 1] } }, { u: { type: ['string', 'integer'] } }), 'assert', /'u' lives in the entity's document/],
      ['a json column', ruled({ assert: { $eq: ['$.old.j', 'x'] } }, { j: { type: 'string', 'x-entity': { column: 'json' } } }), 'assert', /'j' lives in the entity's document/],
      ['a relation member', parented, 'assert', /'parent' is a relation, which has no column of its own/],
      ['an audit', logged, 'audit', /a database rule on a store-owned layout writes no audit row/],
      ['an effect', ruled({ on: ['update'], assert: true, effects: [{ increment: 'a' }] }), 'effects', /a database rule on a store-owned layout increments no member/],
      ['columns', ruled({ on: ['update'], columns: ['a'] }), 'columns', /invariant columns name the columns of a physical layout; a document is written whole/],
      ['a probe', probing, 'assert', /a database rule on a store-owned layout reads no other row/],
    ];
    for (const [label, model, member, message] of CASES) {
      const refused = { code: 'JD0005', docPath: `/entities/E/invariants/0/${member}`, message };
      assert.throws(() => normalizeEntities(model), refused, /** @type {string} */ (label));
      for (const [, dialect] of DIALECTS) assert.throws(() => planInvariants(model, { dialect }), refused, /** @type {string} */ (label));
    }
    // a foreign key's own column is a column, and the rule reads it
    const via = /** @type {any} */ (structuredClone(parented));
    via.entities.E.invariants[0].assert = { $gt: ['$.new.parentId', 0] };
    for (const [, dialect] of DIALECTS) assert.match(planInvariants(via, { dialect })[0].sql, /"parentId"/);
  });

  it('reopens over its own programs, and refuses a dropped one or a table that gained a rule, naming the entity', async () => {
    const { dbPath, cleanup } = tempDbPath();
    try {
      const open = (/** @type {any} */ model) => openStore(model, { driver: nodeDriver(), path: dbPath });
      await (await open(bookingModel())).close();
      await (await open(bookingModel())).close();
      const db = new DatabaseSync(dbPath);
      db.exec('DROP TRIGGER "_jaren_rule_7_Booking_insert"');
      db.close();
      await assert.rejects(open(bookingModel()), { code: 'JD0002',
        message: /^JD0002: entity 'Booking': the existing table does not match the declared model \(the model declares '_jaren_rule_7_Booking_insert', which the database does not have\)/ });
      // a table an earlier model created without the rule needs a migration to gain it
      const { dbPath: plain, cleanup: clean } = tempDbPath();
      try {
        await (await openStore(bookingModel(false), { driver: nodeDriver(), path: plain })).close();
        await assert.rejects(openStore(bookingModel(), { driver: nodeDriver(), path: plain }), { code: 'JD0002', message: /entity 'Booking': .*_jaren_rule_7_Booking_/ });
      }
      finally { clean(); }
    }
    finally { cleanup(); }
  });

  it('refuses to install its rules in a UTF-16 database, whose text order is not code point order', async () => {
    const connection = await nodeDriver().open(':memory:');
    connection.exec('PRAGMA encoding = \'UTF-16le\'');
    await assert.rejects(openStore(bookingModel(), { driver: { ...nodeDriver(), open: async () => connection } }),
      { code: 'JD0002', message: /UTF-16le database/ });
  });
});

describe('a PostgreSQL open retries a racing creation of a rule program', () => {
  it('accepts the two measured shapes of a racing function and trigger, beside the table races, and nothing else', () => {
    const dialect = postgresDialect();
    for (const [error, race] of /** @type {[any, boolean][]} */ ([
      [{ code: '23505', constraint: 'pg_proc_proname_args_nsp_index', table: 'pg_proc' }, true],
      [{ code: '42710', routine: 'CreateTriggerFiringOn' }, true],
      [{ code: '42P07' }, true],
      [{ code: '42710', routine: 'TypeCreate' }, true],
      [{ code: '23505', constraint: 'pg_type_typname_nsp_index', table: 'pg_type' }, true],
      [{ code: '23505', constraint: 'pg_class_relname_nsp_index', table: 'pg_class' }, true],
      // a function committed before the create, and look-alikes of the racing shapes
      [{ code: '42723', routine: 'ProcedureCreate' }, false],
      [{ code: '23505', constraint: 'pg_proc_proname_args_nsp_index', table: 'notes' }, false],
      [{ code: '23505', constraint: 'pg_proc_oid_index', table: 'pg_proc' }, false],
      [{ code: '42710', routine: 'CreateRole' }, false],
      [{ code: '23505', constraint: 'notes_pkey', table: 'notes' }, false],
      [{ code: '23J01' }, false],
    ])) assert.equal(dialect.isCreateRace(error), race, JSON.stringify(error));
  });
});

describe('the migration planner installs, replaces and drops a store-owned layout\'s programs', () => {
  for (const [name, dialect] of DIALECTS) {
    it(`${name}: a rule added plans its programs alone, in install order; the same model plans nothing`, () => {
      const programs = planInvariants(bookingModel(), { dialect }).map((item) => item.sql);
      const { migration, report } = planModelMigration(bookingModel(false), bookingModel(), { dialect, id: 'rules' });
      assert.deepEqual(statements(migration), programs);
      assert.deepEqual(report.schemaChanged, []);
      assert.deepEqual(planModelMigration(bookingModel(), bookingModel(), { dialect, id: 'same' }).migration.steps, []);
      // removed again: each program dropped, the last installed first, a trigger before its function
      assert.deepEqual(statements(planModelMigration(bookingModel(), bookingModel(false), { dialect, id: 'unrule' }).migration), bookingDrops(name));
    });

    it(`${name}: a changed rule replaces the programs it changes and keeps the others`, () => {
      const changed = reordered({ $lt: ['$.new.startsAt', '$.new.endsAt'] });
      const planned = new Map(planInvariants(changed, { dialect }).map((item) => [`${item.type} ${item.name}`, item.sql]));
      const steps = statements(planModelMigration(bookingModel(), changed, { dialect, id: 'reorder' }).migration);
      const replaced = name === 'sqlite' ? ['insert', 'update'].map((op) => `trigger _jaren_rule_7_Booking_${op}`)
        : ['insert', 'update'].flatMap((op) => [`function _jaren_rule_7_Booking_${op}`, `trigger _jaren_rule_7_Booking_${op}`]);
      assert.deepEqual(steps.slice(-replaced.length), replaced.map((key) => planned.get(key)));
      assert.equal(steps.length, replaced.length * 2);
      assert.ok(steps.slice(0, replaced.length).every((sql) => sql.startsWith('DROP ')), steps.join('\n'));
      assert.ok(!steps.some((sql) => sql.includes('_delete')), 'the delete program is unchanged');
    });

    it(`${name}: a rebuild creates the programs again after the copy, and after the transform its document change asks for`, () => {
      const retyped = /** @type {any} */ (bookingModel());
      retyped.entities.Booking.schema.properties.room = { type: 'integer' };
      const { migration } = planModelMigration(bookingModel(), retyped, { dialect, id: 'retype' });
      const steps = statements(migration);
      const programs = planInvariants(retyped, { dialect }).map((item) => item.sql);
      const copied = steps.indexOf('<drop and rename>');
      assert.ok(copied > 0, steps.join('\n'));
      const after = steps.slice(copied + 1);
      assert.deepEqual(after.filter((sql) => /^CREATE (TRIGGER|FUNCTION) /.test(sql)), programs);
      // the old table's triggers go with it; on PostgreSQL its functions stay, so they are dropped first
      const before = steps.slice(0, copied);
      assert.deepEqual(before.filter((sql) => sql.startsWith('DROP ')), bookingDrops(name));
      // the draft transform sits between the rebuild and the programs
      const kinds = migration.steps.map((/** @type {any} */ step) => step.kind);
      assert.deepEqual(kinds.slice(kinds.indexOf('rebuild')), ['rebuild', 'jslt', ...programs.map(() => 'ddl')]);
    });

    it(`${name}: a rule added beside a document transform creates its programs after the transform, however the transform is given`, () => {
      const programs = planInvariants(narrowedBookingModel(), { dialect }).map((item) => item.sql);
      for (const transform of [BOOKING_TRANSFORM, [BOOKING_TRANSFORM], { Booking: BOOKING_TRANSFORM }]) {
        const { migration, report } = planModelMigration(bookingModel(false), narrowedBookingModel(), { dialect, id: 'carry', transform });
        assert.deepEqual(report.transformed, ['Booking']);
        assert.deepEqual(migration.steps.map((/** @type {any} */ step) => step.kind), ['jslt', ...programs.map(() => 'ddl')]);
        assert.deepEqual(statements(migration), programs);
      }
    });

    it(`${name}: a renamed entity's programs are dropped before the rename and created under the new name after it`, () => {
      const renamed = /** @type {any} */ ({ $model: '0.1', entities: { Stay: { ...bookingModel().entities.Booking, 'x-rename': 'Booking' } } });
      const steps = statements(planModelMigration(bookingModel(), renamed, { dialect, id: 'rename' }).migration);
      const rename = steps.indexOf('ALTER TABLE "Booking" RENAME TO "Stay"');
      // a program is named after its table: dropped while the table has its old name
      assert.deepEqual(steps.slice(0, rename), bookingDrops(name));
      assert.deepEqual(steps.slice(rename + 1), planInvariants(renamed, { dialect }).map((item) => item.sql));
    });
  }
});

describe('a planned migration of a store-owned layout\'s rules, on SQLite', () => {
  it('adds, replaces and drops the rules in place, judges no stored row, and every result reopens', async () => {
    const { dbPath, cleanup } = tempDbPath();
    try {
      const target = { driver: nodeDriver(), path: dbPath };
      const open = (/** @type {any} */ model) => openStore(model, target);
      const store = await open(bookingModel(false));
      await store.entity('Booking').create({ id: 'old', startsAt: 5, endsAt: 1 });
      await store.close();
      const models = [bookingModel(false), bookingModel(), reordered({ $lt: ['$.new.startsAt', '$.new.endsAt'] }), bookingModel(false)];
      const migrations = models.slice(1).map((to, i) => planModelMigration(models[i], to, { dialect: sqliteDialect, id: `m${i}` }).migration);
      /** Run the chain up to `to`, twice: the second run applies nothing. @param {number} to */
      const run = async (to) => {
        const options = { baseline: models[0], model: models[to] };
        assert.deepEqual((await migrate(target, migrations.slice(0, to), options)).applied, [`m${to - 1}`]);
        assert.deepEqual((await migrate(target, migrations.slice(0, to), options)).applied, []);
        return open(models[to]);
      };
      /** What two spans come to. @param {any} rules */
      const verdicts = async (rules) => {
        const out = [];
        for (const span of [{ id: 'eq', startsAt: 2, endsAt: 2 }, { id: 'inv', startsAt: 3, endsAt: 2 }]) {
          out.push(await rules.entity('Booking').create(span).then(() => 'ok', (/** @type {any} */ error) => error.code));
          await rules.entity('Booking').delete(span.id);
        }
        return out;
      };
      let ruledStore = await run(1);
      // the row the new rule would refuse stays
      assert.deepEqual(await ruledStore.entity('Booking').get('old'), { id: 'old', startsAt: 5, endsAt: 1 });
      assert.deepEqual(await verdicts(ruledStore), ['ok', 'JD2096']);
      await ruledStore.close();
      ruledStore = await run(2);
      assert.deepEqual(await verdicts(ruledStore), ['JD2096', 'JD2096']);
      await ruledStore.close();
      ruledStore = await run(3);
      assert.deepEqual(await verdicts(ruledStore), ['ok', 'ok']);
      await ruledStore.close();
      const db = new DatabaseSync(dbPath);
      try { assert.deepEqual(db.prepare('SELECT name FROM sqlite_schema WHERE type = \'trigger\'').all(), []); }
      finally { db.close(); }
    }
    finally { cleanup(); }
  });
});

describe('a migration that adds a rule beside a document transform, on SQLite', () => {
  it('runs the transform before the programs: a row it carries into conformance is kept, one it leaves violating stays', async () => {
    const { dbPath, cleanup } = tempDbPath();
    try {
      const target = { driver: nodeDriver(), path: dbPath };
      const store = await openStore(bookingModel(false), target);
      await store.entity('Booking').create({ id: 'fix', startsAt: 5, endsAt: 1 });
      await store.entity('Booking').create({ id: 'stay', startsAt: 5, endsAt: 0 });
      await store.close();
      const to = narrowedBookingModel();
      const { migration } = planModelMigration(bookingModel(false), to, { dialect: sqliteDialect, id: 'carry', transform: BOOKING_TRANSFORM });
      const options = { baseline: bookingModel(false), model: to };
      assert.deepEqual((await migrate(target, [migration], options)).applied, ['carry']);
      assert.deepEqual((await migrate(target, [migration], options)).applied, []);
      const ruled = await openStore(to, target);
      try {
        const bookings = ruled.entity('Booking');
        assert.deepEqual(await bookings.get('fix'), { id: 'fix', startsAt: 1, endsAt: 1 });
        assert.deepEqual(await bookings.get('stay'), { id: 'stay', startsAt: 1, endsAt: 0 });
        // the row the transform left violating meets the rule when it is next written
        await assert.rejects(bookings.update('stay', { room: 'x' }), { code: 'JD2096' });
        assert.deepEqual(await bookings.update('fix', { room: 'x' }), { id: 'fix', startsAt: 1, endsAt: 1, room: 'x' });
      }
      finally { await ruled.close(); }
    }
    finally { cleanup(); }
  });
});

describe('a child\'s rule meets its parent\'s foreign-key action, on SQLite', () => {
  for (const [onDelete, rule] of /** @type {const} */ ([['cascade', 'kept'], ['setNull', 'linked']]))
    it(`${onDelete}: the parent's delete is refused in the child's rule's name, a database rule's reported for the parent, a store rule's with its own message`,
      () => childRuleMeetsParentAction('sqlite', onDelete, rule));
});

describe('store rules judge the rows a foreign-key action removes or nulls, on SQLite', () => {
  it('a rule two levels down refuses, a probe sees the parent gone, and passing rules, no rules and restrict answer as before',
    () => storeRulesMeetForeignKeyActions('sqlite'));
});

/**
 * A driver over one in-memory database that records the text of every
 * statement it prepares.
 * @param {string[]} prepared
 */
const preparing = (prepared) => {
  const db = new DatabaseSync(':memory:');
  return {
    /** @param {{ queueTimeout?: number }} [options] */
    open: (options) => adaptNodeDatabase({
      exec: (/** @type {string} */ sql) => db.exec(sql),
      prepare: (/** @type {string} */ sql) => {
        prepared.push(sql);
        return db.prepare(sql);
      },
      function: (/** @type {any[]} */ ...args) => /** @type {any} */ (db.function)(...args),
      aggregate: (/** @type {any[]} */ ...args) => /** @type {any} */ (db.aggregate)(...args),
      createSession: (/** @type {any} */ sessionOptions) => db.createSession(sessionOptions),
      close: () => db.close(),
    }, { queueTimeout: options?.queueTimeout }),
  };
};

describe('a delete reads the rows its foreign-key actions reach only for a store rule that judges one', () => {
  it('no rule in reach: no statement reads a child, at 1000 children as at 8000; a rule two levels down: one per level and chunk of 500 keys', async () => {
    const kept = { name: 'kept', on: ['delete'], enforcement: 'store', assert: { $ne: ['$.old.status', 'held'] } };
    // a rule on the root's own delete judges the root alone
    const rootRuled = /** @type {any} */ (actionChainModel('cascade', {}));
    rootRuled.entities.A.invariants = [{ ...kept, assert: { $ne: ['$.old.id', 'z'] } }];
    const readsOf = (/** @type {string[]} */ prepared) => prepared.filter((sql) => /FROM "[BC]" WHERE "[ab]Ref" IN \(/.test(sql)).length;
    for (const [label, model, reads] of /** @type {const} */ ([['no rule', actionChainModel('cascade', {}), 0],
      ['a rule on the root alone', rootRuled, 0], ['a rule two levels down', actionChainModel('cascade', { C: [kept] }), 2]])) {
      for (const children of [1000, 8000]) {
        /** @type {string[]} */
        const prepared = [];
        const store = await openStore(model, { driver: preparing(prepared) });
        try {
          await store.entity('A').create({ id: 'a' });
          await store.transaction(async (/** @type {any} */ tx) => {
            for (let i = 0; i < children; i += 1) await tx.entity('B').create({ id: `b${i}`, aRef: 'a', status: 'free' });
          });
          prepared.length = 0;
          assert.equal(await store.entity('A').delete('a'), true, label);
          assert.equal(readsOf(prepared), reads === 0 ? 0 : 1 + Math.ceil(children / 500), `${label}, ${children} children`);
          assert.equal(await store.entity('B').get('b0'), undefined, label);
        }
        finally { await store.close(); }
      }
    }
  });
});

describe('a store rule on a store-owned layout judges the record the store reads back', () => {
  const nullable = (/** @type {any} */ assert) => ({ $model: '0.1', entities: { R: { schema: { type: 'object', properties: {
    id: { type: 'string', 'x-entity': { key: true } }, n: { type: ['integer', 'null'] }, m: { type: 'integer' } } },
  invariants: [{ name: 'rule', on: ['insert', 'update'], enforcement: 'store', assert }] } } });

  it('a member written null is missing, on an insert as on the update after it, directly and tracked', async () => {
    const isNull = await openStore(nullable({ $eq: ['$.new.n', null] }), { driver: nodeDriver() });
    try {
      const rows = isNull.entity('R');
      for (const write of [() => rows.create({ id: 'a', n: null }), () => rows.create({ id: 'b' })])
        await assert.rejects(write(), { code: 'JD2096' });
      rows.add({ id: 'c', n: null });
      await assert.rejects(isNull.saveChanges(), { code: 'JD2096' });
    }
    finally { await isNull.close(); }
    const missing = await openStore(nullable({ $not: { $exists: '$.new.n' } }), { driver: nodeDriver() });
    try {
      const rows = missing.entity('R');
      assert.deepEqual(await rows.create({ id: 'a', n: null }), { id: 'a' });
      assert.deepEqual(await rows.update('a', { m: 1 }), { id: 'a', m: 1 });
      rows.add({ id: 'c', n: null });
      await missing.saveChanges();
      assert.deepEqual(await rows.get('c'), { id: 'c' });
    }
    finally { await missing.close(); }
  });
});
