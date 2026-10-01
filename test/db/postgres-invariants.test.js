//@ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { explainMapping, openStore, planInvariants, readSchema, sqliteDialect } from '@jarenjs/db';
import { verifyPhysical } from '../../packages/db/src/physical.js';
import { postgresDialect, postgresDriver } from '@jarenjs/db/postgres';
import { ruleModel, truthModel, RULE_TABLES, ruleLifecycle, ruleTruthTable, ruleGrid, familyModel, familyLifecycle, FAMILY_REFUSALS,
  sqliteEngine, storeAgreement } from './invariant-oracle.js';

describe('PostgreSQL rule lowering', () => {
  it('plans a function and a row trigger per table and operation in the driver-owned schema, each program verified by its fields', () => {
    const items = planInvariants(ruleModel, { dialect: postgresDialect({ searchPath: 'tenant' }) });
    assert.deepEqual(items.map((item) => [item.type, item.name, item.rule]), [
      ['function', '_jaren_rule_5_entry_insert', 'ordered'], ['trigger', '_jaren_rule_5_entry_insert', 'ordered'],
      ['function', '_jaren_rule_5_entry_update', 'ordered,frozen'], ['trigger', '_jaren_rule_5_entry_update', 'ordered,frozen'],
      ['function', '_jaren_rule_5_entry_delete', 'frozen'], ['trigger', '_jaren_rule_5_entry_delete', 'frozen'],
      ['function', '_jaren_rule_5_entry_truncate', 'frozen'], ['trigger', '_jaren_rule_5_entry_truncate', 'frozen']]);
    const [fn, trigger] = items.slice(2, 4);
    assert.equal(trigger.sql, 'CREATE TRIGGER "_jaren_rule_5_entry_update" AFTER UPDATE ON "tenant"."entry" FOR EACH ROW EXECUTE FUNCTION "tenant"."_jaren_rule_5_entry_update"()');
    const { source, ...function_ } = trigger.program.function;
    assert.deepEqual({ ...trigger.program, function: function_ }, { timing: 'AFTER', events: ['UPDATE'], level: 'ROW', columns: [],
      condition: false, enabled: 'O', deferrable: false, deferred: false, function: { schema: 'tenant', name: '_jaren_rule_5_entry_update',
        language: 'plpgsql', returns: 'trigger', arguments: '', securityDefiner: false, config: ['search_path=pg_catalog, pg_temp'] } });
    // the function is installed from the very source its trigger is verified
    // against, under a search path no writer's schema can come ahead of
    assert.equal(fn.sql, `CREATE FUNCTION "tenant"."_jaren_rule_5_entry_update"() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $jaren$${source}$jaren$`);
    assert.match(source, /RAISE EXCEPTION USING MESSAGE = 'jaren invariant:frozen', ERRCODE = '23J01';/);
    // a program runs under its caller's search path, so it names its tables
    assert.match(source, /INSERT INTO "tenant"\."audit" \("entry_id", "operation"\) SELECT NEW\."id", 'update' WHERE/);
    assert.equal(source.indexOf('jaren invariant:ordered') < source.indexOf('jaren invariant:frozen'), true);
    assert.equal(source.lastIndexOf('IF ') < source.indexOf('INSERT INTO'), true, 'every check runs before the audit');
    // TRUNCATE runs no row trigger: a table whose deletes a rule judges refuses it whole
    const truncate = /** @type {any} */ (items[7]);
    assert.equal(truncate.sql, 'CREATE TRIGGER "_jaren_rule_5_entry_truncate" BEFORE TRUNCATE ON "tenant"."entry" FOR EACH STATEMENT EXECUTE FUNCTION "tenant"."_jaren_rule_5_entry_truncate"()');
    assert.deepEqual([truncate.program.timing, truncate.program.events, truncate.program.level], ['BEFORE', ['TRUNCATE'], 'STATEMENT']);
    assert.match(truncate.program.function.source, /^\nBEGIN\n {2}RAISE EXCEPTION USING MESSAGE = 'jaren invariant:frozen', ERRCODE = '23J01';\n/);
  });

  it('refuses what PostgreSQL could not mean the same way, before anything is installed', () => {
    const dialect = postgresDialect({ searchPath: 'tenant' });
    assert.throws(() => planInvariants(ruleModel, { dialect: postgresDialect() }), { code: 'JD0005', message: /searchPath/ });
    // the compiler is shared: what SQLite refuses at plan time, PostgreSQL refuses alike
    for (const edit of [(m) => { m.entities.Entry.invariants[0].audit.entity = 'Entry'; },
      (m) => { m.entities.Entry.invariants[0].audit.values.entry = '$.new.phase'; },
      (m) => { m.entities.Entry.invariants[0].assert = { $exists: '$.new' }; },
      (m) => { m.entities.Entry.invariants[0].assert = { $eq: ['$.old.start', 1] }; }]) {
      const spec = structuredClone(ruleModel); edit(spec);
      assert.throws(() => planInvariants(spec, { dialect }), { code: 'JD0005' });
      assert.throws(() => planInvariants(spec, { dialect: sqliteDialect }), { code: 'JD0005' });
    }
    const absent = structuredClone(truthModel);
    absent.entities.Row.physical.columns.a.null = 'absent';
    absent.entities.Row.invariants = [{ name: 'absence', on: ['insert'], enforcement: 'database', assert: { $eq: ['$.new.a', null] } }];
    assert.throws(() => planInvariants(absent, { dialect }), { code: 'JD0005' });
    const rounding = structuredClone(ruleModel);
    rounding.entities.Entry.schema.properties.ratio = { type: 'number' };
    rounding.entities.Entry.physical.columns.ratio = { name: 'ratio', codec: 'number', null: 'reject' };
    for (const value of ['$.new.ratio', 1.5, { $const: 2.5 }]) {
      rounding.entities.Entry.invariants[0].audit.values.entry = value;
      assert.throws(() => planInvariants(rounding, { dialect: postgresDialect({ searchPath: 'tenant' }) }), { code: 'JD0005', message: /would round/ });
      assert.doesNotThrow(() => planInvariants(rounding, { dialect: sqliteDialect }));
    }
    rounding.entities.Entry.invariants[0].audit.values.entry = { $const: 2 };
    assert.doesNotThrow(() => planInvariants(rounding, { dialect: postgresDialect({ searchPath: 'tenant' }) }));
    // two long table names a short hash cannot tell apart would install one function over the other
    const twins = /** @type {any} */ (structuredClone(ruleModel));
    twins.entities.Entry.physical.table = 'ledger_entries_archive_partition_for_region_00005vl8';
    twins.entities.Twin = { ...structuredClone(twins.entities.Entry), invariants: [twins.entities.Entry.invariants[1]] };
    twins.entities.Twin.physical.table = 'ledger_entries_archive_partition_for_region_0000mpd6';
    assert.throws(() => planInvariants(twins, { dialect }), { code: 'JD0005', message: /name one function '_jaren_rule_1vd5hfm_update'/ });
    assert.doesNotThrow(() => planInvariants(twins, { dialect: sqliteDialect }));
  });

  it('plans the trigger families as AFTER programs, an UPDATE OF program per column set and a BEFORE program for increments, refusing what SQLite refuses', () => {
    const items = planInvariants(familyModel('database'), { dialect: postgresDialect({ searchPath: 'tenant' }) });
    const programs = items.filter((item) => item.type === 'trigger').map((item) => /** @type {any} */ (item));
    assert.deepEqual(programs.map((item) => [item.name, item.program.timing, item.program.events, item.program.columns]), [
      ['_jaren_rule_5_lines_insert', 'AFTER', ['INSERT'], []],
      ['_jaren_rule_5_lines_update_before', 'BEFORE', ['UPDATE'], []],
      ['_jaren_rule_5_lines_update', 'AFTER', ['UPDATE'], []],
      [programs[3].name, 'AFTER', ['UPDATE'], ['doc_id']],
      ['_jaren_rule_5_lines_delete', 'AFTER', ['DELETE'], []],
      ['_jaren_rule_5_lines_truncate', 'BEFORE', ['TRUNCATE'], []]]);
    assert.match(programs[3].name, /^_jaren_rule_5_lines_update_of_[0-9a-z]+$/);
    assert.match(programs[1].program.function.source, /IF \(.*\) AND \(NEW\."revision" IS NOT DISTINCT FROM OLD\."revision"\) THEN\n {4}NEW\."revision" := OLD\."revision" \+ 1;/);
    assert.match(programs[0].program.function.source, /EXISTS \(SELECT 1 FROM "tenant"\."docs" AS "_jaren_row" WHERE "_jaren_row"\."id" = NEW\."doc_id" AND NOT/);
    for (const [label, edit] of FAMILY_REFUSALS) {
      const spec = familyModel('database'); edit(spec);
      assert.throws(() => planInvariants(spec, { dialect: postgresDialect({ searchPath: 'tenant' }) }), { code: 'JD0005' }, label);
    }
  });

  it('opens over a catalog whose programs match the plan field by field, and names each field that differs', async () => {
    const dialect = postgresDialect({ searchPath: 'tenant' });
    const items = planInvariants(ruleModel, { dialect });
    const mapping = { ...explainMapping(ruleModel).entities.Entry, triggers: items };
    // the catalog's answer, as the program query reads it back: one row per installed trigger
    const rows = items.filter((item) => item.type === 'trigger')
      .map((item) => ({ name: item.name, owner: 'entry', program: JSON.stringify(/** @type {any} */ (item).program) }));
    const column = (/** @type {string} */ name, /** @type {string} */ type, extra = {}) => ({ name, type, generated: false, ...extra });
    const schema = { objects: [{ type: 'table', name: 'entry' }], tables: [{ name: 'entry', primaryKey: ['id'], columns: [
      column('id', 'integer', { default: "nextval('entry_id_seq'::regclass)" }), column('starts', 'integer'), column('ends', 'integer'),
      column('phase', 'text')] }] };
    /** @type {string[]} */
    const read = [];
    const connection = { dialect, prepare: (/** @type {string} */ sql) => ({ all: async () => { read.push(sql); return rows; } }) };
    await verifyPhysical(connection, mapping, schema);
    assert.match(read[0], /FROM pg_catalog\.pg_trigger t JOIN pg_catalog\.pg_class c/);
    const at = rows.findIndex((row) => row.name === '_jaren_rule_5_entry_update');
    const tampered = JSON.parse(rows[at].program);
    tampered.level = 'STATEMENT';
    tampered.function.config = ['search_path=public'];
    rows[at] = { ...rows[at], program: JSON.stringify(tampered) };
    await assert.rejects(async () => verifyPhysical(connection, mapping, schema), { code: 'JD0002',
      message: /invariant trigger '_jaren_rule_5_entry_update' is missing or changed \(level, function\.config\)/ });
  });

  it('names a long table by a hash and quotes a body that contains its own dollar tag', () => {
    const long = structuredClone(ruleModel);
    long.entities.Entry.physical.table = 'e'.repeat(60);
    const names = planInvariants(long, { dialect: postgresDialect({ searchPath: 'tenant' }) }).map((item) => item.name);
    assert.ok(names.every((name) => Buffer.byteLength(name) <= 63 && /^_jaren_rule_[0-9a-z]+_(insert|update|delete|truncate)$/.test(name)), names.join());
    assert.equal(new Set(names).size, 4);
    const tagged = structuredClone(ruleModel);
    tagged.entities.Entry.invariants[1].assert = { $ne: ['$.old.phase', { $const: '$jaren$' }] };
    const fn = planInvariants(tagged, { dialect: postgresDialect({ searchPath: 'tenant' }) }).find((item) => item.type === 'function' && item.rule === 'frozen');
    assert.match(fn?.sql ?? '', /AS \$jaren_1\$\n[\s\S]*'\$jaren\$'[\s\S]*\$jaren_1\$$/);
  });
});

const url = process.env.JAREN_PG_URL;
let fixtures = 0;
/** @returns {import('./invariant-oracle.js').RuleEngine} */
function postgresEngine() {
  return { name: 'postgres', async fixture(tables) {
    const { default: pg } = await import('pg');
    const schema = `jaren_rules_${process.pid}_${++fixtures}`;
    const pool = new pg.Pool({ connectionString: url, max: 6 });
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try { await client.query(`CREATE SCHEMA "${schema}"; SET search_path TO "${schema}"; ${tables.postgres}`); }
    catch (error) { await client.end(); await pool.end(); throw error; }
    const driver = postgresDriver(pool, { schema });
    /** @type {any} */
    let connection;
    const open = async () => (connection ??= await driver.open());
    return {
      dialect: postgresDialect({ searchPath: schema }),
      driver, target: { driver },
      exec: async (sql) => { await client.query(sql); },
      all: async (sql) => (await client.query(sql)).rows,
      source: async () => (await readSchema(await open())).catalog,
      connection: open,
      // the reviewed target: what the steps leave behind, read inside a transaction that is rolled back
      review: async (steps) => {
        let target;
        await assert.rejects((await open()).transaction(async (/** @type {any} */ tx) => {
          for (const step of steps) await tx.exec(step.sql);
          target = { dialect: 'postgres', schema, catalog: (await readSchema(tx)).catalog };
          throw new Error('review only');
        }), /review only/);
        return target;
      },
      dispose: async () => {
        try { await connection?.close(); await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
        finally { await client.end(); await pool.end(); }
      },
    };
  } };
}

describe('PostgreSQL database invariants', { skip: !url && 'JAREN_PG_URL is not set' }, () => {
  it('fresh and upgraded rules refuse, audit and pass the same writes as SQLite, from every writer', async () => {
    const outcomes = [];
    for (const engine of [sqliteEngine(), postgresEngine()]) for (const upgraded of [false, true])
      outcomes.push(await ruleLifecycle(engine, upgraded));
    assert.equal(new Set(outcomes).size, 1, outcomes.join('\n'));
  });

  it('the trigger families refuse, revise and pass the same writes as SQLite under either enforcement, fresh and upgraded', async () => {
    for (const enforcement of /** @type {const} */ (['database', 'store'])) for (const upgraded of [false, true])
      assert.equal(await familyLifecycle(postgresEngine(), { enforcement, upgraded }), await familyLifecycle(sqliteEngine(), { enforcement, upgraded }),
        `${enforcement}${upgraded ? ', upgraded' : ''}`);
  });

  it('a store rule judges each write at its own statement as the database rule does, on PostgreSQL as on SQLite, on one session or several', async () => {
    for (const enforcement of /** @type {const} */ (['database', 'store'])) {
      const sqlite = await storeAgreement(sqliteEngine(), enforcement);
      assert.equal(await storeAgreement(postgresEngine(), enforcement), sqlite, enforcement);
      // a rule's own transaction and its probes nest on the session its write holds
      assert.equal(await storeAgreement(postgresEngine(), enforcement, { sessions: 3 }), sqlite, `${enforcement} on three sessions`);
    }
  });

  it('the null truth tables and every scalar codec give the query engine\'s verdict on both engines, and refuse what a codec cannot read', async () => {
    assert.equal(await ruleTruthTable(postgresEngine()), await ruleTruthTable(sqliteEngine()));
    assert.equal(await ruleGrid(postgresEngine()), await ruleGrid(sqliteEngine()));
  });

  it('opens only over the installed programs it planned, field by field', async () => {
    const fixture = await postgresEngine().fixture({ postgres: 'CREATE TABLE entry(id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, starts integer, ends integer, phase text); '
      + 'CREATE TABLE audit(id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, entry_id integer, operation text)' });
    try {
      const items = planInvariants(ruleModel, { dialect: fixture.dialect });
      const install = async () => { for (const item of items) await fixture.exec(item.sql); };
      const reopen = async (pattern) => {
        if (pattern === null) { await (await openStore(ruleModel, { driver: fixture.driver, adopt: true })).close(); return; }
        await assert.rejects(openStore(ruleModel, { driver: fixture.driver, adopt: true }), (error) => {
          assert.equal(/** @type {any} */ (error).code, 'JD0002');
          assert.match(String(/** @type {any} */ (error).message), pattern);
          return true;
        });
      };
      const name = '_jaren_rule_5_entry_update';
      await reopen(/invariant trigger '_jaren_rule_5_entry_insert' is missing/);
      await install();
      await reopen(null);
      const fn = /** @type {any} */ (items.find((item) => item.type === 'function' && item.name === name));
      await fixture.exec(fn.sql.replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION').replace("'jaren invariant:frozen'", "'jaren invariant:thawed'"));
      await reopen(/\(function\.source\)/);
      await fixture.exec(fn.sql.replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION'));
      await reopen(null);
      for (const [change, field] of [
        [`ALTER TABLE entry DISABLE TRIGGER "${name}"`, 'enabled'],
        [`ALTER FUNCTION "${name}"() SET search_path = public`, 'function.config'],
        [`ALTER FUNCTION "${name}"() SECURITY DEFINER`, 'function.securityDefiner'],
      ]) {
        await fixture.exec(change);
        await reopen(new RegExp(`\\(${field.replace('.', '\\.')}\\)`));
        await fixture.exec(`DROP FUNCTION "${name}"() CASCADE`);
        for (const item of items.filter((i) => i.name === name)) await fixture.exec(item.sql);
        await reopen(null);
      }
      for (const [trigger, field] of [
        [`CREATE TRIGGER "${name}" BEFORE UPDATE ON entry FOR EACH ROW EXECUTE FUNCTION "${name}"()`, 'timing'],
        [`CREATE TRIGGER "${name}" AFTER UPDATE OF starts ON entry FOR EACH ROW EXECUTE FUNCTION "${name}"()`, 'columns'],
        [`CREATE TRIGGER "${name}" AFTER UPDATE OR DELETE ON entry FOR EACH ROW EXECUTE FUNCTION "${name}"()`, 'events'],
        [`CREATE TRIGGER "${name}" AFTER UPDATE ON entry FOR EACH STATEMENT EXECUTE FUNCTION "${name}"()`, 'level'],
        [`CREATE TRIGGER "${name}" AFTER UPDATE ON entry FOR EACH ROW WHEN (NEW.starts > 0) EXECUTE FUNCTION "${name}"()`, 'condition'],
        [`CREATE CONSTRAINT TRIGGER "${name}" AFTER UPDATE ON entry DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "${name}"()`, 'deferrable, deferred'],
      ]) {
        await fixture.exec(`DROP TRIGGER "${name}" ON entry`);
        await fixture.exec(trigger);
        await reopen(new RegExp(`\\(${field}\\)`));
      }
      await fixture.exec(`DROP TRIGGER "${name}" ON entry`);
      await reopen(/invariant trigger '_jaren_rule_5_entry_update' is missing or changed; apply an explicit migration/);
    }
    finally { await fixture.dispose(); }
  });

  it('a refused store write leaves a transaction body usable on both engines; a refused trusted statement spends a PostgreSQL one', async () => {
    for (const engine of [sqliteEngine(), postgresEngine()]) {
      const fixture = await engine.fixture(RULE_TABLES);
      try {
        for (const item of planInvariants(ruleModel, { dialect: fixture.dialect })) await fixture.exec(item.sql);
        const store = await openStore(ruleModel, { driver: fixture.driver, adopt: true });
        try {
          await store.entity('Entry').create({ start: 1, end: 2, phase: 'draft' });
          const raw = (/** @type {any} */ scope) => scope.sql.prepare('UPDATE entry SET starts = 3 WHERE id = 1', { access: 'write', affects: ['entry'] }).run([]);
          // each store write is its own savepoint inside the caller's transaction
          for (const refused of [(/** @type {any} */ tx) => tx.entity('Entry').update(1, { start: 3 }),
            (/** @type {any} */ tx) => tx.entity('Entry').mutate({ op: 'update', key: 1, set: { start: 3 } }),
            (/** @type {any} */ tx) => tx.transaction(raw)]) {
            await store.transaction(async (tx) => {
              await assert.rejects(async () => refused(tx), { code: 'JD2096' });
              await tx.entity('Entry').update(1, { end: 5 });
            });
            assert.equal((await store.entity('Entry').get(1))?.end, 5, engine.name);
            await store.entity('Entry').update(1, { end: 2 });
          }
          // a trusted statement is not: on PostgreSQL its failure spends the transaction (SQLSTATE 25P02)
          const body = store.transaction(async (tx) => {
            await assert.rejects(async () => raw(tx), { code: 'JD2096' });
            await tx.entity('Entry').update(1, { end: 5 });
          });
          if (engine.name === 'postgres') await assert.rejects(body, { code: 'JD2088' });
          else await body;
        }
        finally { await store.close(); }
      }
      finally { await fixture.dispose(); }
    }
  });

  it('refuses TRUNCATE of a table a delete rule judges, and resolves no operator through the writer\'s search path', async () => {
    const fixture = await postgresEngine().fixture(RULE_TABLES);
    const other = `${fixture.dialect.schema}_ops`;
    try {
      for (const item of planInvariants(ruleModel, { dialect: fixture.dialect })) await fixture.exec(item.sql);
      await (await openStore(ruleModel, { driver: fixture.driver, adopt: true })).close();
      await fixture.exec("INSERT INTO entry (starts, ends, phase) VALUES (1, 2, 'draft')");
      await assert.rejects(fixture.exec('TRUNCATE entry'), (error) => {
        assert.equal(/** @type {any} */ (error).code, '23J01');
        assert.equal(/** @type {any} */ (error).message, 'jaren invariant:frozen');
        return true;
      });
      assert.equal((await fixture.all('SELECT count(*)::integer AS n FROM entry'))[0].n, 1);
      // an operator a writer's schema puts ahead of pg_catalog answers no rule
      await fixture.exec(`CREATE SCHEMA "${other}"; CREATE FUNCTION "${other}".yes(integer, integer) RETURNS boolean LANGUAGE sql IMMUTABLE AS 'SELECT true'; `
        + `CREATE OPERATOR "${other}".<= (LEFTARG = integer, RIGHTARG = integer, FUNCTION = "${other}".yes)`);
      await fixture.exec(`SET search_path = "${other}", pg_catalog, "${fixture.dialect.schema}"`);
      await assert.rejects(fixture.exec("INSERT INTO entry (starts, ends, phase) VALUES (5, 2, 'draft')"), /jaren invariant:ordered/);
    }
    finally {
      await fixture.exec(`SET search_path = "${fixture.dialect.schema}"; DROP SCHEMA IF EXISTS "${other}" CASCADE`);
      await fixture.dispose();
    }
  });

  it('installs and enforces programs under a hashed name and a substituted dollar tag', async () => {
    const table = 'e'.repeat(60);
    const model = structuredClone(ruleModel);
    model.entities.Entry.physical.table = table;
    model.entities.Entry.invariants[1].assert = { $ne: ['$.old.phase', { $const: '$jaren$' }] };
    const fixture = await postgresEngine().fixture({ postgres: `CREATE TABLE ${table}(id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, starts integer, ends integer, phase text); `
      + 'CREATE TABLE audit(id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, entry_id integer, operation text)' });
    try {
      for (const item of planInvariants(model, { dialect: fixture.dialect })) await fixture.exec(item.sql);
      const store = await openStore(model, { driver: fixture.driver, adopt: true });
      try {
        await store.entity('Entry').create({ start: 1, end: 2, phase: '$jaren$' });
        await assert.rejects(store.entity('Entry').update(1, { start: 3 }), { code: 'JD2096' });
        await assert.rejects(store.entity('Entry').delete(1), { code: 'JD2096' });
        assert.deepEqual(await fixture.all('SELECT entry_id, operation FROM audit ORDER BY id'), [{ entry_id: 1, operation: 'insert' }]);
      }
      finally { await store.close(); }
    }
    finally { await fixture.dispose(); }
  });
});
