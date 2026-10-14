//@ts-check
/**
 * @file Database rules over a layout the store owns, on a live PostgreSQL
 * server (`JAREN_PG_URL`; skipped without it, two connections at most): the
 * function and trigger the store creates with its table, by plain statements
 * so a racing open retries into verification; what they refuse from the
 * store and from an outside writer; a transaction that outlives a refused
 * write; the open's field-by-field verification, undeclared triggers
 * included; and the planned migration of the programs.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { migrate, openStore, planInvariants, planModelMigration } from '@jarenjs/db';
import { postgresDialect } from '@jarenjs/db/postgres';
import { BOOKING_TRANSFORM, bookingModel, childRuleMeetsParentAction, narrowedBookingModel, storeRulesMeetForeignKeyActions }
  from './invariant-oracle.js';
import { PG_URL, withPostgres } from './store-core-engines.js';

const skip = !PG_URL && 'JAREN_PG_URL is not set';

/** A driver whose connections log every statement they execute and may answer the table probe late.
 * @param {any} base @param {string[]} log @param {(table: string) => Promise<void> | void} [afterProbe] - runs once a probe found no table */
const logging = (base, log, afterProbe = undefined) => ({ ...base, open: async (/** @type {any[]} */ ...args) => {
  const connection = await base.open(...args);
  const probe = connection.dialect.introspect.tableExists();
  return { ...connection,
    exec: (/** @type {string} */ sql) => { log.push(sql); return connection.exec(sql); },
    prepare: async (/** @type {string} */ sql, /** @type {any} */ metadata) => {
      const statement = await connection.prepare(sql, metadata);
      if (sql !== probe || afterProbe === undefined) return statement;
      return { ...statement, get: async (/** @type {any[]} */ params) => {
        const row = await statement.get(params);
        if (row === undefined) await afterProbe(String(params[0]));
        return row;
      } };
    } };
} });

/** A plain store-owned entity beside the ruled booking. */
const withPlain = () => {
  const model = /** @type {any} */ (bookingModel());
  model.entities.Plain = { schema: { type: 'object', properties: { id: { type: 'string', 'x-entity': { key: true } }, v: { type: 'integer' } } } };
  return model;
};

describe('a database rule on a store-owned layout, on PostgreSQL', { skip }, () => {
  it('refuses an inverted span from the store and from an outside writer (SQLSTATE 23J01), and accepts an ordered one', () =>
    withPostgres(async ({ pool, schema, driver }) => {
      const store = await openStore(bookingModel(), { driver: driver() });
      try {
        const bookings = store.entity('Booking');
        await assert.rejects(bookings.create({ id: 'a', startsAt: 5, endsAt: 1 }), { code: 'JD2096', class: 'constraint' });
        await assert.rejects(pool.query(`INSERT INTO "${schema}"."Booking" (id, "startsAt", "endsAt", doc) VALUES ('x', 5, 1, '{}'::jsonb)`),
          { code: '23J01', message: 'jaren invariant:ordered' });
        await pool.query(`INSERT INTO "${schema}"."Booking" (id, "startsAt", "endsAt", doc) VALUES ('y', 1, 5, '{}'::jsonb)`);
        assert.deepEqual(await bookings.create({ id: 'b', startsAt: 1, endsAt: 5 }), { id: 'b', startsAt: 1, endsAt: 5 });
        assert.deepEqual(await bookings.get('y'), { id: 'y', startsAt: 1, endsAt: 5 });
        // TRUNCATE runs no row trigger: a table whose deletes a rule judges refuses it whole
        await assert.rejects(pool.query(`TRUNCATE "${schema}"."Booking"`), { code: '23J01', message: 'jaren invariant:kept' });
      }
      finally { await store.close(); }
    }));

  it('a refused write inside a transaction leaves it usable: the next write and the commit go through', () =>
    withPostgres(async ({ driver }) => {
      const store = await openStore(bookingModel(), { driver: driver() });
      try {
        await store.transaction(async (/** @type {any} */ tx) => {
          await assert.rejects(tx.entity('Booking').create({ id: 'a', startsAt: 5, endsAt: 1 }), { code: 'JD2096', class: 'constraint' });
          await assert.rejects(tx.entity('Booking').update('nope', { startsAt: 1 }), { code: 'JD2006' });
          await tx.entity('Booking').create({ id: 'b', startsAt: 1, endsAt: 5 });
          const held = await tx.entity('Booking').create({ id: 'h', startsAt: 1, endsAt: 2, room: 'held' });
          await assert.rejects(tx.entity('Booking').delete(held.id), { code: 'JD2096', class: 'constraint' });
          await tx.entity('Booking').update('b', { endsAt: 6 });
        });
        assert.deepEqual(await Promise.all(['a', 'b', 'h'].map((id) => store.entity('Booking').get(id))),
          [undefined, { id: 'b', startsAt: 1, endsAt: 6 }, { id: 'h', startsAt: 1, endsAt: 2, room: 'held' }]);
      }
      finally { await store.close(); }
    }));

  it('after a statement that spent the transaction, every write a rule judges answers JD2088, as the commit does', () =>
    withPostgres(async ({ driver }) => {
      const store = await openStore(bookingModel(), { driver: driver() });
      try {
        await store.entity('Booking').create({ id: 'b', startsAt: 1, endsAt: 5 });
        const aborted = { code: 'JD2088', class: 'aborted' };
        await assert.rejects(store.transaction(async (/** @type {any} */ tx) => {
          // a trusted statement is no savepoint: its failure spends the transaction
          await assert.rejects(tx.sql.prepare('SELECT 1/0 AS x', { access: 'read' }).get([]), { code: 'JD2005' });
          const bookings = tx.entity('Booking');
          await assert.rejects(bookings.update('b', { endsAt: 6 }), aborted);
          await assert.rejects(bookings.create({ id: 'c', startsAt: 1, endsAt: 2 }), aborted);
          await assert.rejects(bookings.delete('b'), aborted);
          bookings.put({ id: 'b', startsAt: 1, endsAt: 7 });
          await assert.rejects(tx.saveChanges(), aborted);
        }), aborted);
        assert.deepEqual(await store.entity('Booking').get('b'), { id: 'b', startsAt: 1, endsAt: 5 });
      }
      finally { await store.close(); }
    }));

  it('creates the ruled table, its functions and its triggers by plain statements, and every other table as before', () =>
    withPostgres(async ({ schema, driver }) => {
      const log = /** @type {string[]} */ ([]);
      await (await openStore(withPlain(), { driver: logging(driver(), log) })).close();
      const created = log.filter((sql) => /^CREATE /.test(sql));
      const programs = planInvariants(bookingModel(), { dialect: postgresDialect({ searchPath: schema }) }).map((item) => item.sql);
      const booking = created.findIndex((sql) => sql.startsWith('CREATE TABLE "Booking" ('));
      assert.notEqual(booking, -1, created.join('\n'));
      assert.deepEqual(created.filter((sql) => /^CREATE (FUNCTION|TRIGGER) /.test(sql)), programs);
      assert.ok(created.indexOf(programs[0]) > booking, created.join('\n'));
      assert.ok(created.some((sql) => sql.startsWith('CREATE TABLE IF NOT EXISTS "Plain" (')), created.join('\n'));
      // and the next open verifies, creating nothing
      log.length = 0;
      await (await openStore(withPlain(), { driver: logging(driver(), log) })).close();
      assert.deepEqual(log.filter((sql) => /^CREATE /.test(sql)), []);
    }));

  it('an open that finds no table, while a rival commits it with its programs, retries into verification and opens', () =>
    withPostgres(async ({ pool, schema, driver }) => {
      const dialect = postgresDialect({ searchPath: schema });
      // the statements that create the booking table with its programs, planned beside another entity
      const other = { Z: { schema: { type: 'object', properties: { id: { type: 'string', 'x-entity': { key: true } } } } } };
      const rival = planModelMigration({ $model: '0.1', entities: other }, { $model: '0.1', entities: { ...other, ...bookingModel().entities } },
        { dialect, id: 'rival' }).migration.steps.map((/** @type {any} */ step) => step.sql);
      let raced = 0;
      const log = /** @type {string[]} */ ([]);
      const store = await openStore(bookingModel(), { driver: logging(driver(), log, async (table) => {
        if (table !== 'Booking' || raced++ > 0) return;
        // the rival commits on a connection of its own, between this open's probe and its create
        await pool.query(['BEGIN', `SET LOCAL search_path TO "${schema}"`, ...rival, 'COMMIT'].join(';\n'));
      }) });
      try {
        assert.equal(raced, 1);
        // the plain create met the rival's table, rolled back, and the second bracket verified it
        const failed = log.findIndex((sql) => sql.startsWith('CREATE TABLE "Booking"'));
        assert.notEqual(failed, -1);
        assert.deepEqual(log.slice(failed + 1, failed + 3), ['ROLLBACK', 'BEGIN']);
        assert.equal(log.slice(failed + 1).some((sql) => sql.startsWith('CREATE ')), false);
        await assert.rejects(store.entity('Booking').create({ id: 'a', startsAt: 5, endsAt: 1 }), { code: 'JD2096' });
      }
      finally { await store.close(); }
    }));

  it('verifies its programs field by field on every open, and refuses a dropped or changed function and an undeclared trigger', () =>
    withPostgres(async ({ pool, schema, driver }) => {
      const open = () => openStore(withPlain(), { driver: driver() });
      await (await open()).close();
      await (await open()).close();
      const reopen = async (/** @type {string} */ sql, /** @type {RegExp} */ message, /** @type {string} */ undo) => {
        await pool.query(sql);
        // a store that opens over the drift is closed, so the failed assertion does not hold a pool client
        await assert.rejects(open().then((store) => store.close()), (/** @type {any} */ error) => {
          assert.equal(error.code, 'JD0002');
          assert.match(error.message, message);
          return true;
        });
        await pool.query(undo);
        await (await open()).close();
      };
      const fn = `"${schema}"."_jaren_rule_7_Booking_insert"`;
      const [source] = (await pool.query(`SELECT prosrc FROM pg_proc WHERE oid = '${fn}()'::regprocedure`)).rows.map((row) => row.prosrc);
      const program = planInvariants(bookingModel(), { dialect: postgresDialect({ searchPath: schema }) });
      const [create, trigger] = program.slice(0, 2).map((item) => item.sql);
      await reopen(`DROP FUNCTION ${fn}() CASCADE`, /entity 'Booking': .*'_jaren_rule_7_Booking_insert' is missing or changed/,
        `${create}; ${trigger}`);
      await reopen(`CREATE OR REPLACE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $x$BEGIN RETURN NULL; END$x$`,
        /entity 'Booking': .*'_jaren_rule_7_Booking_insert' is missing or changed \(function\.source\)/,
        `CREATE OR REPLACE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $jaren$${source}$jaren$`);
      // a trigger the model does not declare, on a ruled table and on one without rules
      await pool.query(`CREATE FUNCTION "${schema}".app_guard() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NULL; END$$`);
      for (const table of ['Booking', 'Plain'])
        await reopen(`CREATE TRIGGER app_guard AFTER INSERT ON "${schema}"."${table}" FOR EACH ROW EXECUTE FUNCTION "${schema}".app_guard()`,
          new RegExp(`entity '${table}': .*the database has the trigger 'app_guard', which the model does not declare`),
          `DROP TRIGGER app_guard ON "${schema}"."${table}"`);
      // a rewrite rule changes what a write does as an undeclared trigger does: this one voids every update
      for (const table of ['Booking', 'Plain'])
        await reopen(`CREATE RULE guard AS ON UPDATE TO "${schema}"."${table}" DO INSTEAD NOTHING`,
          new RegExp(`entity '${table}': .*the database has the rewrite rule 'guard', which the model does not declare`),
          `DROP RULE guard ON "${schema}"."${table}"`);
    }));
});

describe('a child\'s rule meets its parent\'s foreign-key action, on PostgreSQL', { skip }, () => {
  for (const [onDelete, rule] of /** @type {const} */ ([['cascade', 'kept'], ['setNull', 'linked']]))
    it(`${onDelete}: the parent's delete is refused in the child's rule's name, a database rule's reported for the parent, a store rule's with its own message`,
      () => childRuleMeetsParentAction('postgres', onDelete, rule));
});

describe('store rules judge the rows a foreign-key action removes or nulls, on PostgreSQL', { skip }, () => {
  it('a rule two levels down refuses, a probe sees the parent gone, and passing rules, no rules and restrict answer as before',
    () => storeRulesMeetForeignKeyActions('postgres'));
});

describe('a planned migration of a store-owned layout\'s rules, on PostgreSQL', { skip }, () => {
  it('adds, replaces and drops the programs in place, rebuilds with them, judges no stored row, and every result reopens', () =>
    withPostgres(async ({ pool, schema, driver }) => {
      const dialect = postgresDialect({ searchPath: schema });
      const target = { driver: driver() };
      const store = await openStore(bookingModel(false), { driver: driver() });
      await store.entity('Booking').create({ id: 'old', startsAt: 5, endsAt: 1 });
      await store.close();
      const reordered = /** @type {any} */ (bookingModel());
      reordered.entities.Booking.invariants[0].assert = { $lt: ['$.new.startsAt', '$.new.endsAt'] };
      const retyped = /** @type {any} */ (structuredClone(reordered));
      retyped.entities.Booking.schema.properties.room = { type: 'integer' };
      const unruled = /** @type {any} */ (structuredClone(retyped));
      delete unruled.entities.Booking.invariants;
      const models = [bookingModel(false), bookingModel(), reordered, retyped, unruled];
      const migrations = models.slice(1).map((to, i) => {
        const { migration } = planModelMigration(models[i], to, { dialect, id: `m${i}` });
        migration.steps = migration.steps.filter((/** @type {any} */ step) => !(step.kind === 'jslt' && step.draft));
        return migration;
      });
      /** Run the chain up to `to`, twice. @param {number} to */
      const run = async (to) => {
        const options = { baseline: models[0], model: models[to], shadow: false };
        assert.deepEqual((await migrate(target, migrations.slice(0, to), options)).applied, [`m${to - 1}`]);
        assert.deepEqual((await migrate(target, migrations.slice(0, to), options)).applied, []);
        return openStore(models[to], { driver: driver() });
      };
      const verdicts = async (/** @type {any} */ rules) => {
        const out = [];
        for (const span of [{ id: 'eq', startsAt: 2, endsAt: 2 }, { id: 'inv', startsAt: 3, endsAt: 2 }]) {
          out.push(await rules.entity('Booking').create(span).then(() => 'ok', (/** @type {any} */ error) => error.code));
          await rules.entity('Booking').delete(span.id);
        }
        return out;
      };
      const functions = async () => (await pool.query('SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace '
        + 'WHERE n.nspname = $1 ORDER BY 1', [schema])).rows.map((row) => row.proname);
      for (const [to, expected] of /** @type {[number, string[]][]} */ ([[1, ['ok', 'JD2096']], [2, ['JD2096', 'JD2096']], [3, ['JD2096', 'JD2096']], [4, ['ok', 'ok']]])) {
        const ruled = await run(to);
        try {
          assert.deepEqual(await ruled.entity('Booking').get('old'), { id: 'old', startsAt: 5, endsAt: 1 });
          assert.deepEqual(await verdicts(ruled), expected, `m${to - 1}`);
        }
        finally { await ruled.close(); }
        assert.deepEqual(await functions(), to === 4 ? [] : ['insert', 'update', 'delete', 'truncate'].map((op) => `_jaren_rule_7_Booking_${op}`).sort());
      }
    }));

  it('runs a transform before the programs a rule adds: a row it carries into conformance is kept, one it leaves violating stays', () =>
    withPostgres(async ({ schema, driver }) => {
      const dialect = postgresDialect({ searchPath: schema });
      const store = await openStore(bookingModel(false), { driver: driver() });
      await store.entity('Booking').create({ id: 'fix', startsAt: 5, endsAt: 1 });
      await store.entity('Booking').create({ id: 'stay', startsAt: 5, endsAt: 0 });
      await store.close();
      const to = narrowedBookingModel();
      const { migration } = planModelMigration(bookingModel(false), to, { dialect, id: 'carry', transform: BOOKING_TRANSFORM });
      const programs = planInvariants(to, { dialect });
      assert.deepEqual(migration.steps.map((/** @type {any} */ step) => step.kind), ['jslt', ...programs.map(() => 'ddl')]);
      const options = { baseline: bookingModel(false), model: to, shadow: false };
      assert.deepEqual((await migrate({ driver: driver() }, [migration], options)).applied, ['carry']);
      assert.deepEqual((await migrate({ driver: driver() }, [migration], options)).applied, []);
      const ruled = await openStore(to, { driver: driver() });
      try {
        const bookings = ruled.entity('Booking');
        assert.deepEqual(await bookings.get('fix'), { id: 'fix', startsAt: 1, endsAt: 1 });
        assert.deepEqual(await bookings.get('stay'), { id: 'stay', startsAt: 1, endsAt: 0 });
        await assert.rejects(bookings.update('stay', { room: 'x' }), { code: 'JD2096' });
        assert.deepEqual(await bookings.update('fix', { room: 'x' }), { id: 'fix', startsAt: 1, endsAt: 1, room: 'x' });
      }
      finally { await ruled.close(); }
    }));
});
