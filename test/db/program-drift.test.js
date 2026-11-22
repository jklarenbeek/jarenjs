//@ts-check
/**
 * @file A store-owned or physical layout's rule program that a hand edit left
 * as no release planned it ("drift"), read the way the open reads it by every
 * route that reads programs back: the open compares a physical layout's SQLite
 * trigger formatting aside, as a store-owned one's; acceptance and
 * `migrationStatus` name a drift an ordinary link (an index) leaves on
 * PostgreSQL, as on SQLite; `planProgramUpgrade`'s by-name `repair` plans the
 * link that reinstalls a named drift and nothing else, which the open's
 * refusal names; and `planModelMigration` replaces a changed rule's
 * PostgreSQL function in place where its trigger stays. Each plan is applied.
 * PostgreSQL runs on a live server (`JAREN_PG_URL`; skipped without it).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { compareShapeToModel, migrate, migrationStatus, openStore, planInvariants, planModelMigration, planProgramUpgrade, sqliteDialect } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { postgresDialect } from '@jarenjs/db/postgres';
import { column } from './invariant-oracle.js';
import { removeTempDirectory } from './helpers.js';
import { PG_URL, withPostgres } from './store-core-engines.js';

const skip = !PG_URL && 'JAREN_PG_URL is not set';
const CHILD = { type: 'object', properties: { id: { type: 'integer', 'x-entity': { key: true } }, ref: { type: 'integer' } } };
const PARENT = { type: 'object', properties: { id: { type: 'integer', 'x-entity': { key: true } }, status: { type: 'string' } } };
/** @param {any} match @param {string[]} [on] */
const requires = (match, on = ['insert']) => ({ name: on.join('_'), on, enforcement: 'database', assert: { '$exists-row': { entity: 'Parent', match } } });
const RULES = [requires({ id: '$.new.ref' }), requires({ id: '$.new.ref', status: 'open' }, ['update'])];
/** Children whose rules probe their parent, on a layout the store owns. @param {any[]} [rules] */
const ownedModel = (rules = RULES) => ({ $model: '0.1', entities: { Parent: { schema: PARENT }, Child: { schema: CHILD, invariants: rules } } });
/** The same over existing tables. */
const physicalModel = () => ({ $model: '0.1', entities: {
  Parent: { schema: PARENT, physical: { table: 'parent', columns: { id: column('id'), status: column('status', 'text') } } },
  Child: { schema: CHILD, physical: { table: 'child', columns: { id: column('id'), ref: column('ref') } }, invariants: RULES } } });
const PHYSICAL_TABLES = 'CREATE TABLE parent(id integer PRIMARY KEY, status text); CREATE TABLE child(id integer PRIMARY KEY, ref integer)';
/** The model with an index beside its rules: an ordinary link names no program. */
const indexedModel = () => {
  const model = /** @type {any} */ (ownedModel());
  model.entities.Child.indexes = [{ name: 'by_ref', path: '$.ref' }];
  return model;
};

/** A SQLite store file of `model` in a fresh directory. @param {any} model @param {boolean} physical @param {(file: string) => Promise<void>} fn */
async function withSqlite(model, physical, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'jaren-db-program-drift-'));
  const file = join(dir, 'store.db');
  try {
    if (physical) {
      const raw = new DatabaseSync(file);
      raw.exec(PHYSICAL_TABLES);
      for (const item of planInvariants(model, { dialect: sqliteDialect })) raw.exec(item.sql);
      raw.close();
    }
    else await (await openStore(model, { driver: nodeDriver(), path: file })).close();
    await fn(file);
  }
  finally { removeTempDirectory(dir); }
}
/** Run statements on the SQLite store at `file`. @param {string} file @param {string} sql */
const exec = (file, sql) => {
  const raw = new DatabaseSync(file);
  try { raw.exec(sql); }
  finally { raw.close(); }
};
/** The SQLite insert trigger of `model`, as planned. @param {any} model */
const insertTrigger = (model) => /** @type {any} */ (planInvariants(model, { dialect: sqliteDialect })[0]);
/** Drift the SQLite insert trigger: a statement no release planned in its body. @param {string} file @param {any} model */
const driftSqlite = (file, model) => {
  const insert = insertTrigger(model);
  exec(file, `${insert.drop}; ${insert.sql.replace('BEGIN', 'BEGIN SELECT 1;')}`);
};
/** Drift the PostgreSQL insert program: a statement no release planned in its function. @param {any} pool @param {string} schema */
const driftPostgres = async (pool, schema) => {
  const { rows } = await pool.query(`SELECT pg_get_functiondef(p.oid) AS def FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = $1 AND p.proname = '_jaren_rule_5_Child_insert'`, [schema]);
  await pool.query(rows[0].def.replace(/\nBEGIN\n/, '\nBEGIN\n  PERFORM 1;\n'));
};
/** A step's statement, a check of the rows a table holds named `check`. @param {any} step */
const stepSql = (step) => (step.kind === 'sql' && /breaks the rule/.test(step.note) ? 'check' : step.sql);
/** On PostgreSQL, the step that holds `Child`'s writers ahead of the check of its rows. */
const HOLD_CHILD = 'ALTER TABLE "Child" ENABLE TRIGGER "_jaren_rule_5_Child_insert"';
/** @param {any} target @param {any} model @param {any} [options] */
const plannedOn = async (target, model, options) => {
  const connection = await (target.path === undefined ? target.driver.open() : target.driver.open(target.path, {}));
  try { return await planProgramUpgrade(connection, model, options); }
  finally { await connection.close(); }
};
/** Opens `model` over `target` and refuses a child without its parent by the rule. @param {any} target @param {any} model */
const opensEnforcing = async (target, model) => {
  const store = await openStore(model, target);
  try {
    await store.entity('Parent').create({ id: 1, status: 'open' });
    await store.entity('Child').create({ id: 1, ref: 1 });
    await assert.rejects(store.entity('Child').create({ id: 2, ref: 9 }), { code: 'JD2096' });
  }
  finally { await store.close(); }
};
const REPAIR_ROUTE = (/** @type {string} */ table, /** @type {string} */ program) =>
  `apply an explicit migration (planProgramUpgrade's repair: ['${table}.${program}'] plans the link that reinstalls it)`;

describe('a physical layout\'s SQLite rule trigger at the open', () => {
  it('opens over a formatting-only edit, as a store-owned one does, and refuses another text naming the repair', async () => {
    const model = physicalModel();
    const insert = insertTrigger(model);
    await withSqlite(model, true, async (file) => {
      exec(file, `${insert.drop}; ${insert.sql.replace(/\s+BEGIN\s+/, '\n  BEGIN\n    ').replace(/;\s*END\s*$/, ';\n  END')}`);
      await (await openStore(model, { driver: nodeDriver(), path: file })).close();
      exec(file, `${insert.drop}; ${insert.sql.replace('WHERE (', 'WHERE (1 AND ')}`);
      await assert.rejects(openStore(model, { driver: nodeDriver(), path: file }), { code: 'JD0002',
        message: `JD0002: physical 'child': invariant trigger '_jaren_rule_5_child_insert' is missing or changed; ${REPAIR_ROUTE('child', '_jaren_rule_5_child_insert')}` });
    });
  });
});

describe('a drifted store-owned program under an ordinary link', () => {
  /** @param {any} target @param {() => Promise<void>} drift */
  const check = async (target, drift) => {
    const base = ownedModel(), indexed = indexedModel();
    const dialect = target.path === undefined ? target.driver.dialect : sqliteDialect;
    const link = planModelMigration(base, indexed, { dialect, id: 'idx-1' }).migration;
    const later = planModelMigration(indexed, base, { dialect, id: 'idx-2' }).migration;
    assert.deepEqual(link.steps.map((/** @type {any} */ step) => step.kind), ['ddl']);
    await drift();
    // refused before it commits, naming the program, as the next open would refuse the table
    await assert.rejects(migrate(target, [link], { baseline: base, model: indexed, shadow: false }), { code: 'JD0023',
      message: /the migrated shape does not equal the target model's: .*_jaren_rule_5_Child_insert/ });
    const store = await openStore(base, { ...target, adopt: false }).catch((/** @type {any} */ error) => error);
    assert.equal(store.code, 'JD0002');
    return { base, indexed, link, later };
  };

  it('on SQLite is refused by acceptance, and status over an applied chain names it', async () => {
    const base = ownedModel();
    await withSqlite(base, false, async (file) => {
      const target = { driver: nodeDriver(), path: file };
      const { indexed, link } = await check(target, async () => driftSqlite(file, base));
      // the chain applied before the drift: status reads the program back
      await withSqlite(base, false, async (other) => {
        const applied = { driver: nodeDriver(), path: other };
        assert.deepEqual((await migrate(applied, [link], { baseline: base, model: indexed, shadow: false })).applied, ['idx-1']);
        assert.equal((await migrationStatus(applied, [link], { model: indexed })).drift, null);
        driftSqlite(other, base);
        assert.match(String((await migrationStatus(applied, [link], { model: indexed })).drift), /trigger:_jaren_rule_5_Child_insert differs/);
      });
    });
  });

  it('on PostgreSQL is refused by acceptance, and status over an applied chain names it, as on SQLite', { skip }, () =>
    withPostgres(async ({ pool, schema, driver }) => {
      const base = ownedModel();
      await (await openStore(base, { driver: driver() })).close();
      const target = { driver: driver() };
      await check(target, () => driftPostgres(pool, schema));
    }).then(() => withPostgres(async ({ pool, schema, driver }) => {
      const base = ownedModel(), indexed = indexedModel();
      await (await openStore(base, { driver: driver() })).close();
      const target = { driver: driver() };
      const link = planModelMigration(base, indexed, { dialect: driver().dialect, id: 'idx-1' }).migration;
      assert.deepEqual((await migrate(target, [link], { baseline: base, model: indexed, shadow: false })).applied, ['idx-1']);
      assert.equal((await migrationStatus(target, [link], { model: indexed })).drift, null);
      await driftPostgres(pool, schema);
      const status = await migrationStatus(target, [link], { model: indexed });
      assert.deepEqual([status.upToDate, status.drift], [false, "entity 'Child': invariant trigger '_jaren_rule_5_Child_insert' is missing or changed "
        + `(function.source); ${REPAIR_ROUTE('Child', '_jaren_rule_5_Child_insert')}`]);
    })));

  it('on PostgreSQL reads a model as history, and a table whose plan calls the host\'s index functions with them', { skip }, () =>
    withPostgres(async ({ pool, schema, driver }) => {
      // a from-model whose physical layout a declaration would refuse (a string property over an integer codec) is still compared
      const history = /** @type {any} */ ({ ...ownedModel(), entities: { ...ownedModel().entities, Other: { schema: { type: 'object', properties: {
        id: { type: 'integer', 'x-entity': { key: true } }, v: { type: 'string' } } },
      physical: { table: 'other', columns: { id: column('id'), v: column('v') } } } } });
      await (await openStore(ownedModel(), { driver: driver() })).close();
      const connection = await driver().open();
      try {
        assert.equal(await compareShapeToModel(undefined, connection, history, undefined), null);
        await driftPostgres(pool, schema);
        assert.match(String(await compareShapeToModel(undefined, connection, history, undefined)), /^entity 'Child': invariant trigger '_jaren_rule_5_Child_insert'/);
      }
      finally { await connection.close(); }
    }).then(() => withPostgres(async ({ pool, schema, driver }) => {
      const expressed = /** @type {any} */ (structuredClone(ownedModel()));
      expressed.entities.Child.schema.properties.tag = { type: 'string' };
      expressed.entities.Child.indexes = [{ name: 'by_tag', expression: { call: 'lower', args: [{ member: '$.tag' }] } }];
      const expressions = { lower: { arity: 1, deterministic: true, apply: (/** @type {any} */ v) => (v === null ? null : String(v).toLowerCase()), sql: 'lower' } };
      await (await openStore(expressed, { driver: driver(), expressions })).close();
      await driftPostgres(pool, schema);
      // without the functions the table is not read, as before; with them its drift is named
      const target = { driver: driver() };
      assert.equal((await migrationStatus(target, [], { model: expressed })).drift, null);
      assert.match(String((await migrationStatus(target, [], { model: expressed, expressions })).drift), /_jaren_rule_5_Child_insert' is missing or changed/);
    })));
});

describe('planProgramUpgrade({ repair })', () => {
  /**
   * The option's refusals, a repair of one drift beside another one, and the
   * repair of the named one applied: the store opens and enforces its rule.
   * @param {any} target @param {any} model @param {string} table @param {() => Promise<void>} drift
   * @param {(steps: any[]) => void} expectSteps
   */
  const repairs = async (target, model, table, drift, expectSteps) => {
    const name = `${table}._jaren_rule_5_${table}_insert`;
    for (const [repair, message] of /** @type {[any, RegExp][]} */ ([['Child.x'], [[1]], [['nodot']], [[name, name]]]
      .map(([value]) => [value, /option 'repair' is a list of distinct '<table>\.<program>' names/])))
      await assert.rejects(plannedOn(target, model, { repair }), { code: 'JD0013', message }, JSON.stringify(repair));
    // nothing drifted: a name is no drift
    await assert.rejects(plannedOn(target, model, { repair: [name] }), { code: 'JD0013',
      message: new RegExp(`option 'repair' names '${name.replace('.', '\\.')}', which is no program of the model the database holds drifted or lacks`) });
    await drift();
    // the open names the route; where SQLite compares a layout the store owns by its whole text it names the two
    // texts first
    const ownedOnSqlite = target.path !== undefined && model.entities.Child.physical === undefined;
    const route = REPAIR_ROUTE(table, `_jaren_rule_5_${table}_insert`).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    await assert.rejects(openStore(model, target), { code: 'JD0002',
      message: new RegExp(ownedOnSqlite ? `is declared as[^]*; ${route}` : route) });
    // a name beside the drift that is not drifted is refused; the drift unnamed still is
    await assert.rejects(plannedOn(target, model, { repair: [name, `${table}._jaren_rule_5_${table}_update`] }), { code: 'JD0013' });
    await assert.rejects(plannedOn(target, model), { code: 'JD0002', message: /name it in the option repair to reinstall it/ });
    const { migration, report } = await plannedOn(target, model, { repair: [name] });
    assert.deepEqual(report, { upgraded: [], absent: [], repaired: [name] });
    expectSteps(migration.steps);
    assert.ok(migration.steps.every((/** @type {any} */ step) => step.note.endsWith('over a program no release planned (repair)')));
    assert.deepEqual((await migrate(target, [migration], { baseline: model, ...(model.entities.Child.physical ? {} : { model }), shadow: false })).applied, [migration.id]);
    await opensEnforcing(target, model);
    assert.deepEqual((await plannedOn(target, model)).migration.steps, []);
  };

  it('on SQLite reinstalls the named trigger of a layout the store owns and of a physical one, and one the table lacks', async () => {
    for (const physical of [false, true]) {
      const model = physical ? physicalModel() : ownedModel();
      const table = physical ? 'child' : 'Child';
      const insert = insertTrigger(model);
      await withSqlite(model, physical, (file) => repairs({ driver: nodeDriver(), path: file, ...(physical ? { adopt: true } : {}) }, model, table,
        async () => driftSqlite(file, model),
        (steps) => assert.deepEqual(steps.map((/** @type {any} */ step) => step.sql), [insert.drop, insert.sql])));
    }
    const model = ownedModel();
    const insert = insertTrigger(model);
    await withSqlite(model, false, async (file) => {
      exec(file, insert.drop);
      const target = { driver: nodeDriver(), path: file };
      assert.deepEqual((await plannedOn(target, model)).report.absent, ['Child._jaren_rule_5_Child_insert']);
      const { migration } = await plannedOn(target, model, { repair: ['Child._jaren_rule_5_Child_insert'] });
      // the program the table lacked, then the check of the rows it holds
      assert.deepEqual(migration.steps.map(stepSql), [insert.sql, 'check']);
      await migrate(target, [migration], { baseline: model, model, shadow: false });
      await opensEnforcing(target, model);
    });
  });

  it('reinstalls a physical layout\'s program its table lacks, on SQLite and PostgreSQL, and a drifted PostgreSQL one in place', async () => {
    const model = physicalModel();
    const insert = insertTrigger(model);
    await withSqlite(model, true, async (file) => {
      exec(file, insert.drop);
      const target = { driver: nodeDriver(), path: file, adopt: true };
      const { migration } = await plannedOn(target, model, { repair: ['child._jaren_rule_5_child_insert'] });
      assert.deepEqual(migration.steps.map((/** @type {any} */ step) => step.sql), [insert.sql]);
      assert.ok(migration.physical.target.objects.some((/** @type {any} */ object) => object.name === insert.name && object.sql === insert.sql));
      await migrate(target, [migration], { baseline: model, shadow: false });
      await opensEnforcing(target, model);
    });
    if (skip) return;
    await withPostgres(async ({ pool, schema, driver }) => {
      const layout = /** @type {any} */ (physicalModel());
      for (const entity of Object.values(layout.entities)) /** @type {any} */ (entity).physical.schema = schema;
      await pool.query(`SET search_path TO "${schema}"; ${PHYSICAL_TABLES}; RESET search_path`);
      const items = planInvariants(layout, { dialect: postgresDialect({ searchPath: schema }) });
      for (const item of items) await pool.query(item.sql);
      const [fn, trigger] = items;
      await pool.query(/** @type {any} */ (trigger).drop);
      const target = { driver: driver(), adopt: true };
      const missing = (await plannedOn(target, layout, { repair: ['child._jaren_rule_5_child_insert'] })).migration;
      assert.deepEqual(missing.steps.map((/** @type {any} */ step) => step.sql), [fn.sql.replace(/^CREATE FUNCTION /, 'CREATE OR REPLACE FUNCTION '), trigger.sql]);
      await migrate(target, [missing], { baseline: layout, shadow: false });
      await opensEnforcing(target, layout);
      await pool.query(fn.sql.replace(/^CREATE FUNCTION /, 'CREATE OR REPLACE FUNCTION ').replace('BEGIN', 'BEGIN\n  PERFORM 1;'));
      const drifted = (await plannedOn(target, layout, { repair: ['child._jaren_rule_5_child_insert'] })).migration;
      assert.deepEqual(drifted.steps.map((/** @type {any} */ step) => step.sql), [fn.sql.replace(/^CREATE FUNCTION /, 'CREATE OR REPLACE FUNCTION ')]);
      await migrate(target, [missing, drifted], { baseline: layout, shadow: false });
      const store = await openStore(layout, target);
      await store.close();
    });
  });

  it('on PostgreSQL replaces the named function in place, its trigger kept, and reinstalls a program the table lacks', { skip }, () =>
    withPostgres(async ({ pool, schema, driver }) => {
      const model = ownedModel();
      await (await openStore(model, { driver: driver() })).close();
      const [fn] = planInvariants(model, { dialect: postgresDialect({ searchPath: schema }) });
      await repairs({ driver: driver() }, model, 'Child', () => driftPostgres(pool, schema),
        (steps) => assert.deepEqual(steps.map((/** @type {any} */ step) => step.sql), [fn.sql.replace(/^CREATE FUNCTION /, 'CREATE OR REPLACE FUNCTION ')]));
    }).then(() => withPostgres(async ({ pool, schema, driver }) => {
      const model = ownedModel();
      await (await openStore(model, { driver: driver() })).close();
      const [fn, trigger] = planInvariants(model, { dialect: postgresDialect({ searchPath: schema }) });
      await pool.query(trigger.drop);
      const target = { driver: driver() };
      const { migration } = await plannedOn(target, model, { repair: ['Child._jaren_rule_5_Child_insert'] });
      assert.deepEqual(migration.steps.map(stepSql), [fn.sql.replace(/^CREATE FUNCTION /, 'CREATE OR REPLACE FUNCTION '), trigger.sql, HOLD_CHILD, 'check']);
      await migrate(target, [migration], { baseline: model, model, shadow: false });
      await opensEnforcing(target, model);
    })));
});

describe('planModelMigration over a rule whose function source alone changes', () => {
  const from = ownedModel([requires({ id: '$.new.ref' })]);
  const to = ownedModel([requires({ id: '$.new.ref', status: 'open' })]);
  /** Opens `to` over `target`: a child of a closed parent is refused, of an open one kept. @param {any} target */
  const enforcesChanged = async (target) => {
    const store = await openStore(to, target);
    try {
      await store.entity('Parent').create({ id: 1, status: 'open' });
      await store.entity('Parent').create({ id: 2, status: 'closed' });
      await store.entity('Child').create({ id: 1, ref: 1 });
      await assert.rejects(store.entity('Child').create({ id: 2, ref: 2 }), { code: 'JD2096' });
    }
    finally { await store.close(); }
  };

  it('on SQLite drops and creates the trigger, applied', async () => {
    const { migration } = planModelMigration(from, to, { dialect: sqliteDialect, id: 'rule-1' });
    const [before] = planInvariants(from, { dialect: sqliteDialect }), [after] = planInvariants(to, { dialect: sqliteDialect });
    // the changed insert rule judges the rows the table holds after its program
    assert.deepEqual(migration.steps.map(stepSql), [/** @type {any} */ (before).drop, /** @type {any} */ (after).sql, 'check']);
    await withSqlite(from, false, async (file) => {
      const target = { driver: nodeDriver(), path: file };
      assert.deepEqual((await migrate(target, [migration], { baseline: from, model: to, shadow: false })).applied, ['rule-1']);
      await enforcesChanged(target);
    });
  });

  it('on PostgreSQL replaces the function in place where the trigger stays, applied; beside a column change it drops and creates', { skip }, () =>
    withPostgres(async ({ schema, driver }) => {
      const dialect = postgresDialect({ searchPath: schema });
      const { migration } = planModelMigration(from, to, { dialect, id: 'rule-1' });
      const [fn] = planInvariants(to, { dialect });
      // in place, then the step that holds the writers and the check of the rows the table holds
      assert.deepEqual(migration.steps.map(stepSql), [fn.sql.replace(/^CREATE FUNCTION /, 'CREATE OR REPLACE FUNCTION '), HOLD_CHILD, 'check']);
      await (await openStore(from, { driver: driver() })).close();
      const target = { driver: driver() };
      assert.deepEqual((await migrate(target, [migration], { baseline: from, model: to, shadow: false })).applied, ['rule-1']);
      await enforcesChanged(target);
      // a column the table gains writes rows the program it held would judge: the program is dropped first, as before
      const widened = /** @type {any} */ (structuredClone(to));
      widened.entities.Child.schema.properties.note = { type: 'string' };
      const other = /** @type {any} */ (structuredClone(from));
      other.entities.Child.schema.properties.note = { type: 'string' };
      const beside = planModelMigration(from, widened, { dialect, id: 'rule-2' }).migration.steps.map((/** @type {any} */ step) => String(step.sql));
      assert.ok(beside.some((sql) => sql.startsWith('DROP TRIGGER')) && beside.some((sql) => sql.startsWith('CREATE TRIGGER')), beside.join('\n'));
      assert.deepEqual(planModelMigration(other, widened, { dialect, id: 'rule-3' }).migration.steps.map((/** @type {any} */ step) => String(stepSql(step)).slice(0, 26)),
        ['CREATE OR REPLACE FUNCTION', HOLD_CHILD.slice(0, 26), 'check']);
      // a member moved from its column into the document, the schema unchanged: the fold writes every row, so the program is dropped first
      const folded = /** @type {any} */ (structuredClone(widened));
      folded.entities.Child.schema.properties.note = { type: 'string', 'x-entity': { column: 'json' } };
      const moved = planModelMigration(other, folded, { dialect, id: 'rule-4' });
      assert.deepEqual(moved.report.schemaChanged, []);
      const movedSql = moved.migration.steps.map((/** @type {any} */ step) => String(step.sql));
      assert.ok(movedSql.some((sql) => sql.startsWith('UPDATE ')) && movedSql.some((sql) => sql.startsWith('DROP TRIGGER')), movedSql.join('\n'));
    }));
});
