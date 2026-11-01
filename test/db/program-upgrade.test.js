//@ts-check
/**
 * @file `planProgramUpgrade(connection, model, options)`: the reviewed link
 * that replaces the database rules' programs a store holds as an earlier
 * release planned them, read from the catalog, and `jaren-db plan
 * --upgrade-programs`. Each program is classified as the open classifies it;
 * an earlier one is replaced — on PostgreSQL its function `CREATE OR REPLACE`d
 * where its trigger stays, else (and on SQLite) dropped and created — a text
 * no release planned refuses the plan, naming it, and a program the model
 * plans on a table that holds none of it is reported, never planned. SQLite's
 * programs read alike at every spelling, so a SQLite store plans no step. On a
 * live server (`JAREN_PG_URL`; skipped without it, three connections at most):
 * the two-run check for a layout the store owns and a physical one, each link
 * applied as its shape is, the open after it, a link back and the id it
 * leaves for the next upgrade, an edited link refused before it commits, and
 * the replacement beside an open writer and reader.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { explainMapping, migrate, migrationStatus, openStore, planInvariants, planProgramUpgrade, sqliteDialect } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { postgresDialect } from '@jarenjs/db/postgres';
import { hashContent } from '@jarenjs/core/string';
import { planEntity } from '../../packages/db/src/ddl.js';
import { computedPhysicalTarget, programSteps } from '../../packages/db/src/migrate.js';
import { migrationIdentity } from '../../packages/db/src/migration-identity.js';
import { column } from './invariant-oracle.js';
import { removeTempDirectory } from './helpers.js';
import { PG_URL, withPostgres } from './store-core-engines.js';

const skip = !PG_URL && 'JAREN_PG_URL is not set';
const CLI = resolve('packages/db/src/cli.js');
const CHILD = { type: 'object', properties: { id: { type: 'integer', 'x-entity': { key: true } }, ref: { type: 'integer' } } };
/** @param {any} match @param {string[]} [on] */
const requires = (match, on = ['insert']) => ({ name: on.join('_'), on, enforcement: 'database', assert: { '$exists-row': { entity: 'Parent', match } } });

/** Parents with a status on a layout the store owns; children whose rules probe them by the key on insert and by the key and status on update. */
const ownedModel = { $model: '0.1', entities: {
  Parent: { schema: { type: 'object', properties: { id: { type: 'integer', 'x-entity': { key: true } }, status: { type: 'string' } } } },
  Child: { schema: CHILD, invariants: [requires({ id: '$.new.ref' }), requires({ id: '$.new.ref', status: 'open' }, ['update'])] },
} };
/** The same over existing tables. */
const physicalModel = { $model: '0.1', entities: {
  Parent: { schema: { type: 'object', properties: { id: { type: 'integer', 'x-entity': { key: true } }, status: { type: 'string' } } },
    physical: { table: 'parent', columns: { id: column('id'), status: column('status', 'text') } } },
  Child: { schema: CHILD, physical: { table: 'child', columns: { id: column('id'), ref: column('ref') } },
    invariants: [requires({ id: '$.new.ref' }), requires({ id: '$.new.ref', status: 'open' }, ['update'])] },
} };
const PHYSICAL_TABLES = 'CREATE TABLE parent(id integer PRIMARY KEY, status text); CREATE TABLE child(id integer PRIMARY KEY, ref integer)';
/** The model's hash, as a link from it to itself names both ends. @param {any} model */
const hashOf = (model) => hashContent(migrationIdentity(model, model).to);

/** One entity's program items as spelling `spelling` plans them on `dialect`. @param {any} model @param {string} name @param {any} dialect @param {number} spelling */
const itemsOf = (model, name, dialect, spelling) => {
  const mapping = explainMapping(model);
  const plan = /** @type {any} */ (planEntity(name, mapping.entities[name], mapping, dialect));
  return plan.physical ? plan.physical.triggersAt(spelling) : plan.programsAt(spelling);
};
/** `sql` as a statement that replaces the function it creates. @param {string} sql */
const orReplace = (sql) => sql.replace(/^CREATE FUNCTION /, 'CREATE OR REPLACE FUNCTION ');

describe('the steps that replace one program', () => {
  const [fn0, trigger0, fn1, trigger1] = [0, 1].flatMap((spelling) => itemsOf(ownedModel, 'Child', postgresDialect({ searchPath: 's' }), spelling).slice(0, 2));
  it('on PostgreSQL replace the function alone where its trigger stays', () => {
    assert.deepEqual(programSteps([fn0, trigger0], [fn1, trigger1], 'n'), [{ kind: 'ddl', sql: orReplace(fn1.sql), note: 'n' }]);
  });
  it('drop and create the trigger and its function where the trigger changes, naming the table lock that takes', () => {
    const moved = { ...trigger1, sql: trigger1.sql.replace('AFTER INSERT', 'AFTER INSERT OR UPDATE'),
      program: { ...trigger1.program, events: ['INSERT', 'UPDATE'] } };
    const note = "n; dropping its trigger takes the table's ACCESS EXCLUSIVE lock";
    assert.deepEqual(programSteps([fn0, trigger0], [fn1, moved], 'n'), [trigger0.drop, fn0.drop, fn1.sql, moved.sql].map((sql) => ({ kind: 'ddl', sql, note })));
  });
  it('on SQLite drop and create the trigger', () => {
    const [from] = itemsOf(ownedModel, 'Child', sqliteDialect, 0), [to] = itemsOf(ownedModel, 'Child', sqliteDialect, 1);
    assert.deepEqual(programSteps([from], [to], 'n'), [{ kind: 'ddl', sql: from.drop, note: 'n' }, { kind: 'ddl', sql: to.sql, note: 'n' }]);
  });
  it('leave a physical target that, on SQLite, holds the source objects with each replaced trigger\'s new text', () => {
    const source = [{ type: 'table', name: 'child', owner: 'child', sql: 'CREATE TABLE child(id INTEGER)' },
      { type: 'trigger', name: 't', owner: 'child', sql: 'CREATE TRIGGER "t" AFTER INSERT ON "child" BEGIN SELECT 1; END' },
      { type: 'trigger', name: 'u', owner: 'child', sql: 'CREATE TRIGGER "u" AFTER UPDATE ON "child" BEGIN SELECT 1; END' }];
    const next = 'CREATE TRIGGER "t" AFTER INSERT ON "child" BEGIN SELECT 2; END';
    assert.deepEqual(computedPhysicalTarget(source, new Map([['trigger:t', next]])), { objects: [source[0], { ...source[1], sql: next }, source[2]] });
  });
});

/**
 * A directory holding the model and a SQLite store of it: a layout the store
 * owns, created by opening it, or a physical one, its tables and programs
 * installed as planInvariants plans them.
 * @param {any} model @param {(dir: string, file: string) => Promise<void>} fn
 */
async function withSqliteStore(model, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'jaren-db-upgrade-programs-'));
  try {
    writeFileSync(join(dir, 'model.json'), JSON.stringify(model));
    const file = join(dir, 'store.db');
    if (model === physicalModel) {
      const raw = new DatabaseSync(file);
      raw.exec(PHYSICAL_TABLES);
      for (const item of planInvariants(model, { dialect: sqliteDialect })) raw.exec(item.sql);
      raw.close();
    }
    else await (await openStore(model, { driver: nodeDriver(), path: file })).close();
    await fn(dir, file);
  }
  finally {
    removeTempDirectory(dir);
  }
}
/** The plan of `model` over the store at `file`. @param {string} file @param {any} model @param {any} [options] */
const planned = async (file, model, options) => {
  const connection = await nodeDriver().open(file, {});
  try { return planProgramUpgrade(connection, model, options); }
  finally { connection.close(); }
};
/** Run one statement on the store at `file`. @param {string} file @param {string} sql */
const exec = (file, sql) => {
  const raw = new DatabaseSync(file);
  try { raw.exec(sql); } finally { raw.close(); }
};
const NONE = (/** @type {any} */ model) => ({ migration: { $migration: '0.2', id: `programs-1-${hashOf(model).slice(0, 8)}`, from: hashOf(model), to: hashOf(model),
  identity: migrationIdentity(model, model), steps: [] }, report: { upgraded: [], absent: [] } });

describe('planProgramUpgrade on SQLite', () => {
  it('plans no step, its programs reading alike at every spelling, and plans none again', async () => {
    for (const model of [ownedModel, physicalModel]) await withSqliteStore(model, async (_, file) => {
      assert.deepEqual(await planned(file, model), NONE(model));
      assert.deepEqual(await planned(file, model), NONE(model));
    });
  });

  it('compares each program as the open does: formatting aside where the store owns the table, exactly for a physical layout', async () => {
    const [insert] = planInvariants(ownedModel, { dialect: sqliteDialect });
    await withSqliteStore(ownedModel, async (_, file) => {
      exec(file, `${insert.drop}; ${insert.sql.replace(' BEGIN ', '\n  BEGIN\n    ')}`);
      // the open accepts it
      await (await openStore(ownedModel, { driver: nodeDriver(), path: file })).close();
      assert.deepEqual(await planned(file, ownedModel), NONE(ownedModel));
      exec(file, `${insert.drop}; ${insert.sql.replace('WHERE (', 'WHERE (1 AND ')}`);
      await assert.rejects(planned(file, ownedModel), { code: 'JD0002', message: "JD0002: planProgramUpgrade(): the program '_jaren_rule_5_Child_insert' on "
        + "'Child' holds a text no release planned for this model, which a link would overwrite; restore it, or install it from planInvariants' statements, and plan again" });
    });
    const [physicalInsert] = planInvariants(physicalModel, { dialect: sqliteDialect });
    await withSqliteStore(physicalModel, async (_, file) => {
      exec(file, `${physicalInsert.drop}; ${physicalInsert.sql.replace(' BEGIN ', '\n  BEGIN\n    ')}`);
      await assert.rejects(planned(file, physicalModel), { code: 'JD0002', message: /the program '_jaren_rule_5_child_insert' on 'child' holds a text no release planned/ });
    });
  });

  it('reports a program the model plans on a table that holds none of it, which it neither refuses nor plans', async () => {
    const [insert] = planInvariants(ownedModel, { dialect: sqliteDialect });
    await withSqliteStore(ownedModel, async (_, file) => {
      exec(file, insert.drop);
      const { migration, report } = await planned(file, ownedModel);
      assert.deepEqual([migration.steps, report], [[], { upgraded: [], absent: ['Child._jaren_rule_5_Child_insert'] }]);
    });
  });

  it('takes a closed set of options, an id the history does not repeat and a spelling a release planned', async () => {
    await withSqliteStore(ownedModel, async (_, file) => {
      assert.equal((await planned(file, ownedModel, { id: 'mine' })).migration.id, 'mine');
      assert.deepEqual((await planned(file, ownedModel, { spelling: 0 })).migration, { ...NONE(ownedModel).migration, id: `programs-0-${hashOf(ownedModel).slice(0, 8)}` });
      for (const [options, message] of /** @type {[any, RegExp][]} */ ([[{ ids: 'x' }, /planProgramUpgrade\(\)/], [{ id: '' }, /option 'id' is a non-empty string/],
        [{ spelling: 2 }, /option 'spelling' is a spelling a release planned, 0 to 1, got 2/], [{ spelling: -1 }, /got -1/], [{ spelling: 0.5 }, /got 0.5/],
        [{ spelling: '1' }, /got "1"/]])) await assert.rejects(planned(file, ownedModel, options), { code: 'JD0013', message }, JSON.stringify(options));
    });
  });
});

/** @param {string} dir @param {string[]} args */
const run = (dir, ...args) => spawnSync(process.execPath, ['--no-warnings=ExperimentalWarning', CLI, ...args],
  { encoding: 'utf8', cwd: dir, input: '', env: { ...process.env, FORCE_COLOR: '0' } });

describe('jaren-db plan --upgrade-programs', () => {
  it('plans nothing over a SQLite store, refuses a store that does not match the model and the flag beside --upgrade-columns; status adds no line', async () => {
    await withSqliteStore(ownedModel, async (dir, file) => {
      const current = run(dir, 'plan', '--model', 'model.json', '--store', 'store.db', '--upgrade-programs');
      assert.deepEqual([current.status, current.stdout, current.stderr],
        [0, 'no upgrade — the rule programs of store.db are what this release plans for the model; nothing to plan\n', '']);
      const both = run(dir, 'plan', '--model', 'model.json', '--store', 'store.db', '--upgrade-programs', '--upgrade-columns');
      assert.deepEqual([both.status, both.stderr.trim()], [1, 'jaren-db: plan takes --upgrade-columns or --upgrade-programs, not both']);
      const status = run(dir, 'status', '--model', 'model.json', '--store', 'store.db');
      assert.deepEqual([status.status, status.stdout], [0, 'applied:  (none)\npending:  (none)\ndrift:    none — in sync\n']);
      const [insert] = planInvariants(ownedModel, { dialect: sqliteDialect });
      exec(file, `${insert.drop}; ${insert.sql.replace('WHERE (', 'WHERE (1 AND ')}`);
      const drifted = run(dir, 'plan', '--model', 'model.json', '--store', 'store.db', '--upgrade-programs');
      assert.equal(drifted.status, 1);
      assert.match(drifted.stderr, /the store does not match the model \(trigger:_jaren_rule_5_Child_insert differs/);
    });
  });
});

/** Install each function of `model`'s `name` as spelling `spelling` plans it in `schema`. @param {any} pool @param {any} model @param {string} name @param {string} schema @param {number} spelling */
const install = async (pool, model, name, schema, spelling) => {
  for (const item of itemsOf(model, name, postgresDialect({ searchPath: schema }), spelling)) if (item.type === 'function') await pool.query(orReplace(item.sql));
};
/** The plan of `model` over the store `driver` opens. @param {any} driver @param {any} model @param {any} [options] */
const plannedOn = async (driver, model, options) => {
  const connection = await driver.open();
  try { return await planProgramUpgrade(connection, model, options); }
  finally { await connection.close(); }
};
/** The programs a store reports earlier, opened as its layout opens. @param {any} driver @param {any} model */
const earlierOf = async (driver, model) => {
  const store = await openStore(model, { driver, ...(model === physicalModel ? { adopt: true } : {}) });
  try { return store.earlierPrograms.map((/** @type {any} */ entry) => `${entry.table}.${entry.program}:${entry.spelling}`); }
  finally { await store.close(); }
};
const LOCK_NOTE = 'each probe no $not encloses locks the row it finds, FOR KEY SHARE when every member it matches is a key column and FOR SHARE '
  + "otherwise, which needs a writer's UPDATE privilege on the table it probes";

describe('planProgramUpgrade on PostgreSQL', () => {
  it('replaces a layout the store owns in place, applied with its model; the store opens current and plans nothing again', { skip }, () =>
    withPostgres(async ({ pool, schema, driver }) => {
      await (await openStore(ownedModel, { driver: driver() })).close();
      await install(pool, ownedModel, 'Child', schema, 0);
      assert.deepEqual(await earlierOf(driver(), ownedModel), ['Child._jaren_rule_5_Child_insert:0', 'Child._jaren_rule_5_Child_update:0']);
      const { migration, report } = await plannedOn(driver(), ownedModel);
      const current = itemsOf(ownedModel, 'Child', postgresDialect({ searchPath: schema }), 1).filter((/** @type {any} */ item) => item.type === 'function');
      const hash = hashOf(ownedModel);
      assert.deepEqual({ migration, report }, { migration: { $migration: '0.2', id: `programs-1-${hash.slice(0, 8)}`, from: hash, to: hash,
        identity: migrationIdentity(ownedModel, ownedModel), steps: current.map((/** @type {any} */ item) => ({ kind: 'ddl', sql: orReplace(item.sql),
          note: `replace the rule program '${item.name}' on 'Child' as this release plans it: ${LOCK_NOTE}` })) },
      report: { upgraded: ['Child._jaren_rule_5_Child_insert', 'Child._jaren_rule_5_Child_update'], absent: [] } });
      const target = { driver: driver() };
      const options = { baseline: ownedModel, model: ownedModel, shadow: false };
      assert.deepEqual((await migrate(target, [migration], options)).applied, [migration.id]);
      assert.deepEqual(await earlierOf(driver(), ownedModel), []);
      assert.deepEqual((await plannedOn(driver(), ownedModel)).migration.steps, []);
      assert.deepEqual((await migrate(target, [migration], options)).applied, []);
      assert.equal((await migrationStatus(target, [migration], { model: ownedModel })).drift, null);
      // a link back to the earlier spelling, after which the previous release opens the store, and the upgrade
      // planned again after it, under an id the history does not hold yet
      const back = (await plannedOn(driver(), ownedModel, { spelling: 0 })).migration;
      assert.deepEqual([back.id, back.steps.map((/** @type {any} */ step) => step.note)], [`programs-0-${hash.slice(0, 8)}`,
        ['_jaren_rule_5_Child_insert', '_jaren_rule_5_Child_update'].map((name) => `replace the rule program '${name}' on 'Child' as spelling 0 planned it: `
          + 'each probe locks no row, as releases before the lock planned it')]);
      assert.deepEqual((await migrate(target, [migration, back], options)).applied, [back.id]);
      assert.deepEqual(await earlierOf(driver(), ownedModel), ['Child._jaren_rule_5_Child_insert:0', 'Child._jaren_rule_5_Child_update:0']);
      const again = (await plannedOn(driver(), ownedModel)).migration;
      assert.equal(again.id, `programs-1-${hash.slice(0, 8)}-2`);
      // a link edited after its review, which leaves a program no release planned, is refused before it commits
      const edited = { ...again, steps: again.steps.map((/** @type {any} */ step, /** @type {number} */ i) => (i === 0 ? { ...step, sql: step.sql.replace('BEGIN', 'BEGIN\n') } : step)) };
      await assert.rejects(migrate(target, [migration, back, edited], options), { code: 'JD0023',
        message: /the migrated shape does not equal the target model's: entity 'Child': invariant trigger '_jaren_rule_5_Child_insert' is missing or changed \(function\.source\).*the next open would refuse the table \(JD0002\), so nothing was changed/ });
      assert.deepEqual(await earlierOf(driver(), ownedModel), ['Child._jaren_rule_5_Child_insert:0', 'Child._jaren_rule_5_Child_update:0']);
      assert.deepEqual((await migrate(target, [migration, back, again], options)).applied, [again.id]);
      assert.deepEqual(await earlierOf(driver(), ownedModel), []);
    }));

  it('plans a physical layout\'s link with its preservation plan and a target read in a rolled-back transaction, applied on that target', { skip }, () =>
    withPostgres(async ({ pool, schema, driver }) => {
      await pool.query(`SET search_path TO "${schema}"; ${PHYSICAL_TABLES}; RESET search_path`);
      for (const item of itemsOf(physicalModel, 'Child', postgresDialect({ searchPath: schema }), 0)) await pool.query(item.sql);
      assert.deepEqual(await earlierOf(driver(), physicalModel), ['child._jaren_rule_5_child_insert:0', 'child._jaren_rule_5_child_update:0']);
      const { migration, report } = await plannedOn(driver(), physicalModel);
      assert.deepEqual(report, { upgraded: ['child._jaren_rule_5_child_insert', 'child._jaren_rule_5_child_update'], absent: [] });
      assert.deepEqual(migration.steps.map((/** @type {any} */ step) => step.sql.slice(0, 26)), ['CREATE OR REPLACE FUNCTION', 'CREATE OR REPLACE FUNCTION']);
      assert.deepEqual(Object.entries(migration.physical.dispositions).filter(([, disposition]) => disposition === 'replace').map(([key]) => JSON.parse(key)[3]),
        ['_jaren_rule_5_child_insert()', '_jaren_rule_5_child_update()']);
      // planning changed nothing: the target is what the steps will leave
      assert.deepEqual(await earlierOf(driver(), physicalModel), ['child._jaren_rule_5_child_insert:0', 'child._jaren_rule_5_child_update:0']);
      assert.ok(migration.physical.target.catalog.some((/** @type {any} */ object) => object.name === '_jaren_rule_5_child_insert()' && / FOR KEY SHARE\)/.test(object.sql)));
      const target = { driver: driver() };
      assert.deepEqual((await migrate(target, [migration], { baseline: physicalModel, shadow: false })).applied, [migration.id]);
      assert.deepEqual(await earlierOf(driver(), physicalModel), []);
      assert.deepEqual((await plannedOn(driver(), physicalModel)).migration.steps, []);
      assert.deepEqual((await migrate(target, [migration], { baseline: physicalModel, shadow: false })).applied, []);
      assert.equal((await migrationStatus(target, [migration], {})).drift, null);
    }));

  it('refuses a program no release planned, naming it, and reports one a populated table does not hold', { skip }, () =>
    withPostgres(async ({ pool, schema, driver }) => {
      await (await openStore(ownedModel, { driver: driver() })).close();
      await install(pool, ownedModel, 'Child', schema, 0);
      // a rule added to the populated parents keeps its planned-migration route
      const added = structuredClone(ownedModel);
      /** @type {any} */ (added.entities.Parent).invariants = [{ name: 'known', on: ['insert'], enforcement: 'database', assert: { $gt: ['$.new.id', 0] } }];
      const { migration, report } = await plannedOn(driver(), added);
      assert.deepEqual([migration.steps.length, report], [2, { upgraded: ['Child._jaren_rule_5_Child_insert', 'Child._jaren_rule_5_Child_update'],
        absent: ['Parent._jaren_rule_6_Parent_insert'] }]);
      const [fn] = itemsOf(ownedModel, 'Child', postgresDialect({ searchPath: schema }), 1);
      await pool.query(orReplace(fn.sql).replace('BEGIN', 'BEGIN\n'));
      await assert.rejects(plannedOn(driver(), ownedModel), { code: 'JD0002', message: "JD0002: planProgramUpgrade(): the program '_jaren_rule_5_Child_insert' on "
        + "'Child' holds a text no release planned for this model, which a link would overwrite; restore it, or install it from planInvariants' statements, and plan again" });
    }));

  it('replaces a function beside an open writer and reader of its table without waiting for either', { skip }, () =>
    withPostgres(async ({ pool, schema }) => {
      const { default: pg } = await import('pg');
      const { postgresDriver } = await import('@jarenjs/db/postgres');
      // the link's own connection gives up on a lock it waits for past 1.5 s
      const impatient = new pg.Pool({ connectionString: PG_URL, max: 1, options: '-c lock_timeout=1500' });
      const writer = await pool.connect(), reader = await pool.connect();
      try {
        const linkDriver = postgresDriver(impatient, { schema });
        await (await openStore(ownedModel, { driver: linkDriver })).close();
        await install(impatient, ownedModel, 'Child', schema, 0);
        const { migration } = await plannedOn(linkDriver, ownedModel);
        await writer.query(`BEGIN; SET LOCAL search_path TO "${schema}"; INSERT INTO "Parent"(id, status, doc) VALUES (1, 'open', '{}'); `
          + `INSERT INTO "Child"(id, ref, doc) VALUES (1, 1, '{}')`);
        await reader.query(`BEGIN; SELECT count(*) FROM "${schema}"."Child"`);
        assert.deepEqual((await migrate({ driver: linkDriver }, [migration], { baseline: ownedModel, model: ownedModel, shadow: false })).applied, [migration.id]);
        await writer.query('COMMIT');
        await reader.query('COMMIT');
        assert.deepEqual(await earlierOf(linkDriver, ownedModel), []);
      }
      finally {
        writer.release();
        reader.release();
        await impatient.end();
      }
    }));
});
