//@ts-check
/**
 * @file SQLite application triggers read back as declared database rules.
 * The claim is exactness: a trigger the reader maps and the rule it is read
 * back as refuse the same writes and leave the same rows over a seeded
 * stream, on SQLite here (PostgreSQL in postgres-trigger-rules.test.js),
 * and every other trigger keeps an `unmapped-object` row naming the first
 * construct the reader does not map.
 */
import { describe, it } from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { introspectModel, openStore, planInvariants, planMigration, planPhysicalMigration, migrate, readSchema,
  physicalObjectKey, sqliteDialect, INTROSPECT_CODES, explainMapping } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { sqliteTriggers } from '@jarenjs/db/trigger-rules';
import { sqliteEngine } from './invariant-oracle.js';
import { TRIGGER_FIXTURES, KEPT_TRIGGER_FIXTURE, writeStream, differential, original } from './trigger-rules-oracle.js';
import { NEGATIVE_TABLES, NEGATIVE_TRIGGERS } from './trigger-rules-corpus.js';

const SEEDS = [1, 2, 3];
const WRITES = 300;
/** @param {readonly any[]} report @param {string} code */
const rows = (report, code) => report.filter((row) => row.code === code);
/** @param {any} model @param {string} entity @param {string} name */
const ruleOf = (model, entity, name) => model.entities[entity].invariants.find((/** @type {any} */ rule) => rule.name === name);
const draft = (/** @type {string} */ path) => ({ $or: [{ $not: { '$exists-row': { entity: 'orders', match: { id: path } } } },
  { '$exists-row': { entity: 'orders', match: { id: path, status: 'draft' } } }] });

describe('SQLite triggers read back as database rules', () => {
  it('reads no trigger back without the reader: the model, the plans and the rows are what they were', async () => {
    for (const fixture of TRIGGER_FIXTURES) {
      const connection = await nodeDriver().open(':memory:');
      const bare = await nodeDriver().open(':memory:');
      try {
        connection.exec(fixture.sqlite);
        for (const sql of fixture.triggers) connection.exec(sql);
        bare.exec(fixture.sqlite);
        const read = await introspectModel(connection), without = await introspectModel(bare);
        // the triggers change nothing the read derives: the database without them derives the same model
        assert.equal(JSON.stringify(read.model), JSON.stringify(without.model), fixture.name);
        assert.deepEqual(read.report.filter((row) => row.code !== 'unmapped-object'), without.report, fixture.name);
        const triggers = rows(read.report, 'unmapped-object');
        assert.equal(triggers.length, fixture.triggers.length);
        for (const row of triggers) {
          assert.equal(row.detail, 'an application-owned trigger program must be explicitly preserved; inspection grants no drop permission');
          assert.equal(row.reason, 'it is read back as a database rule only with the triggers option of @jarenjs/db/trigger-rules');
        }
        assert.deepEqual(rows(read.report, 'trigger-rule'), []);
        assert.deepEqual(planMigration(read.model, without.model, { dialect: sqliteDialect }).migration.steps, []);
      }
      finally { connection.close(); bare.close(); }
    }
    await assert.rejects(async () => introspectModel(await nodeDriver().open(':memory:'), { triggers: /** @type {any} */ ({}) }), { code: 'JD0013' });
  });

  it('keeps the reader out of every other module: only its subpath imports it', () => {
    const root = new URL('../../packages/db/src/', import.meta.url);
    /** @param {URL} dir @returns {string[]} */
    const files = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory()
      ? files(new URL(`${entry.name}/`, dir)).map((name) => `${entry.name}/${name}`) : entry.name.endsWith('.js') ? [entry.name] : []));
    const importers = files(root).filter((name) => /from '[./]+(dialects\/)?(sqlite-trigger-rules|trigger-rules)\.js'/.test(readFileSync(new URL(name, root), 'utf8')));
    assert.deepEqual(importers, ['trigger-rules.js']);
  });

  it('reads each family back as the rule it equals, on the column layout of its table', async () => {
    const [same, cross, probes, bumps] = await Promise.all(TRIGGER_FIXTURES.map(original));
    try {
      // an unconditional guard, on delete and on an UPDATE OF
      assert.deepEqual(ruleOf(cross.model, 'orders', 'orders_append_only'), { name: 'orders_append_only', on: ['delete'], enforcement: 'database', assert: false });
      assert.deepEqual(ruleOf(probes.model, 'rooms', 'rooms_kind_fixed'),
        { name: 'rooms_kind_fixed', on: ['update'], columns: ['kind'], enforcement: 'database', assert: false });
      // same-row guards: an update guard judges every assignment, a nullable column's comparison is exact
      assert.deepEqual(ruleOf(same.model, 'documents', 'documents_final'), { name: 'documents_final', on: ['update'], when: 'assigned',
        enforcement: 'database', assert: { $or: [{ $eq: ['$.old.status', 'draft'] }, { $and: [{ $eq: ['$.old.active', 1] }, { $eq: ['$.new.active', 0] }] }] } });
      assert.deepEqual(ruleOf(same.model, 'documents', 'documents_owner').assert,
        { $and: [{ $not: { $le: ['$.new.owner_id', 0] } }, { $ne: ['$.new.title', ''] }, { $or: [{ $eq: ['$.new.sealed_at', null] }, { $eq: ['$.new.sealed_at', '2026-01-01'] }] }] });
      assert.deepEqual(ruleOf(same.model, 'documents', 'documents_seal_once'), { name: 'documents_seal_once', on: ['update'], columns: ['sealed_at'],
        enforcement: 'database', assert: { $and: [{ $eq: ['$.old.sealed_at', null] }, { $ne: ['$.new.sealed_at', null] }] } });
      assert.deepEqual(ruleOf(probes.model, 'bookings', 'bookings_nights').assert, { $and: [{ $eq: ['$.new.nights', { $seq: [1, 2, 3, 7] }] },
        { $not: { $lt: ['$.new.nights', '$.old.nights'] } }, { $not: { $eq: ['$.new.note', { $seq: ['x', 'y'] }] } }] });
      // cross-table guards: a missing parent passes, as the subquery's NULL does
      assert.deepEqual(ruleOf(cross.model, 'lines', 'lines_draft_insert').assert, draft('$.new.order_id'));
      assert.deepEqual(ruleOf(cross.model, 'lines', 'lines_draft_delete').assert, draft('$.old.order_id'));
      assert.deepEqual(ruleOf(cross.model, 'lines', 'lines_draft_update').assert, { $and: [draft('$.old.order_id'), draft('$.new.order_id')] });
      assert.deepEqual(ruleOf(cross.model, 'lines', 'lines_unsealed').assert, { $or: [{ $not: { '$exists-row': { entity: 'orders', match: { id: '$.new.order_id' } } } },
        { '$exists-row': { entity: 'orders', match: { id: '$.new.order_id', sealed_at: null } } }] });
      assert.deepEqual(ruleOf(probes.model, 'bookings', 'bookings_open_kind').assert, { '$exists-row': { entity: 'rooms', match: { kind: '$.new.room_kind', open: 1 } } });
      // revision bumps, by a one-column and a two-column key
      for (const [entity, name] of [['counters', 'counters_bump'], ['stock', 'stock_bump']])
        assert.deepEqual(ruleOf(bumps.model, entity, name), { name, on: ['update'], when: 'assigned', enforcement: 'database', assert: true, effects: [{ increment: 'revision' }] });
      // the layouts: a nullable column is a JSON null, a default the database's, a probed index declared
      assert.deepEqual(cross.model.entities.orders.physical, { table: 'orders', columns: {
        id: { name: 'id', codec: 'integer', null: 'reject' }, status: { name: 'status', codec: 'text', null: 'reject' },
        sealed_at: { name: 'sealed_at', codec: 'text', null: 'null' }, code: { name: 'code', codec: 'text', null: 'reject' } },
      indexes: [{ name: 'orders_code', unique: true, terms: [{ by: { $sql: 'column', name: 'code' } }] }] });
      assert.deepEqual(cross.model.entities.orders.schema.properties.sealed_at, { type: ['string', 'null'] });
      assert.deepEqual(bumps.model.entities.stock.physical.keys, ['site', 'sku']);
      assert.deepEqual(bumps.model.entities.counters.physical.columns.revision, { name: 'revision', codec: 'integer', null: 'reject', default: 'database' });
      assert.deepEqual(rows(cross.report, 'unmapped-constraint'), []);
      assert.deepEqual(rows(cross.report, 'document-members'), []);
    }
    finally { for (const source of [same, cross, probes, bumps]) source.connection.close(); }
  });

  it('reports each trigger it reads back with the message the rule does not carry, and a BEFORE trigger\'s conflict clauses', async () => {
    const [cross, bumps] = await Promise.all([original(TRIGGER_FIXTURES[1]), original(TRIGGER_FIXTURES[3])]);
    try {
      assert.ok(Object.hasOwn(INTROSPECT_CODES, 'trigger-rule'));
      const insert = cross.report.find((row) => row.object === 'lines_draft_insert');
      assert.equal(insert.code, 'trigger-rule');
      assert.deepEqual([insert.entity, insert.rule, insert.message, insert.timing, insert.owner],
        ['lines', 'lines_draft_insert', 'a line is added to a draft order', 'before', 'lines']);
      assert.match(insert.sql, /^CREATE TRIGGER lines_draft_insert BEFORE INSERT/);
      assert.match(insert.detail, /its refusal is 'jaren invariant:lines_draft_insert' \(JD2096\) where the trigger raised 'a line is added to a draft order'/);
      assert.match(insert.detail, /OR IGNORE, ON CONFLICT DO NOTHING/);
      assert.match(insert.detail, /a reviewed migration installs the program and drops the trigger, which inspection never does/);
      // a BEFORE DELETE meets no conflict clause, and an AFTER trigger judges what the rule's program judges
      assert.doesNotMatch(cross.report.find((row) => row.object === 'orders_append_only').detail, /conflict/);
      assert.doesNotMatch(cross.report.find((row) => row.object === 'lines_code').detail, /conflict/);
      const bump = bumps.report.find((row) => row.object === 'counters_bump');
      assert.deepEqual([bump.code, bump.message, bump.timing], ['trigger-rule', null, 'after']);
      assert.match(bump.detail, /its effect is the rule's increment/);
      // a trigger read back is still the application's: preserved, and a row strict refuses
      const { inventory } = await introspectModel(cross.connection, { triggers: sqliteTriggers });
      assert.ok(inventory.filter((object) => object.type === 'trigger').every((object) => object.disposition === 'preserve'));
      await assert.rejects(async () => introspectModel(cross.connection, { strict: true, triggers: sqliteTriggers }), { code: 'JD0002' });
    }
    finally { cross.connection.close(); bumps.connection.close(); }
  });

  for (const fixture of [...TRIGGER_FIXTURES, KEPT_TRIGGER_FIXTURE]) {
    it(`refuses on SQLite exactly the writes the original refuses, over a seeded stream (${fixture.name})`, async () => {
      /** @type {Set<string>} */
      const met = new Set();
      for (const seed of SEEDS) {
        const result = await differential(fixture, sqliteEngine(), writeStream(fixture, seed, WRITES));
        assert.equal(result.divergence, null, JSON.stringify(result.divergence));
        assert.equal(result.writes, WRITES);
        for (const name of Object.keys(result.byTrigger)) met.add(name);
      }
      // every guard refused some write of the stream
      const guards = fixture.triggers.filter((sql) => sql.includes('RAISE')).map((sql) => /** @type {string} */ (/^CREATE TRIGGER (\w+)/.exec(sql)?.[1]));
      assert.deepEqual([...met].sort(), guards.sort());
    });
  }

  it('bumps a revision as the original does: an assignment to the same value bumps, a writer\'s own revision stands', async () => {
    const fixture = TRIGGER_FIXTURES[3];
    const writes = ["UPDATE counters SET label = label WHERE id = 1", "UPDATE counters SET label = 'b' WHERE id = 1", 'UPDATE counters SET revision = 9 WHERE id = 2',
      "UPDATE stock SET qty = 3 WHERE site = 'n' AND sku = 'p'", "UPDATE stock SET qty = 3, revision = revision WHERE site = 'n'"];
    const seeded = { ...fixture, sqlite: `${fixture.sqlite}; INSERT INTO counters VALUES (1, 'a', 0), (2, 'a', 4); `
      + "INSERT INTO stock VALUES ('n', 'p', 1, 0), ('n', 'q', 1, 5)" };
    const result = await differential(seeded, sqliteEngine(), writes);
    assert.equal(result.divergence, null, JSON.stringify(result.divergence));
    const source = await original(seeded);
    try {
      for (const sql of writes) source.connection.exec(sql);
      assert.deepEqual(source.connection.prepare('SELECT id, revision FROM counters ORDER BY id').all([]).map((row) => [row.id, row.revision]), [[1, 2], [2, 9]]);
      assert.deepEqual(source.connection.prepare('SELECT sku, revision FROM stock ORDER BY sku').all([]).map((row) => [row.sku, row.revision]), [['p', 2], ['q', 6]]);
    }
    finally { source.connection.close(); }
  });

  it('reads a column of any name back through the bracket spelling of its path', async () => {
    const fixture = { name: 'quoted', sqlite: 'CREATE TABLE tasks(id INTEGER PRIMARY KEY, "due date" TEXT, [owner\'s] INTEGER NOT NULL)',
      triggers: ['CREATE TRIGGER tasks_due BEFORE UPDATE ON tasks WHEN NEW."due date" IS NULL OR NEW.[owner\'s] < OLD."owner\'s" BEGIN SELECT RAISE(ABORT, \'kept\'); END'],
      tables: { tasks: { key: ['id'], values: { id: [1, 2], 'due date': [null, 'a'], "owner's": [0, 1] } } } };
    const source = await original(fixture);
    try {
      assert.deepEqual(source.model.entities.tasks.invariants[0].assert, { $and: [{ $ne: ['$.new["due date"]', null] },
        { $not: { $lt: ['$.new["owner\'s"]', '$.old["owner\'s"]'] } }] });
    }
    finally { source.connection.close(); }
    const writes = ['INSERT INTO tasks VALUES (1, NULL, 1)', 'UPDATE tasks SET "due date" = NULL WHERE id = 1', 'UPDATE tasks SET "due date" = \'a\' WHERE id = 1',
      'UPDATE tasks SET "owner\'s" = 0 WHERE id = 1', 'UPDATE tasks SET "owner\'s" = 2 WHERE id = 1'];
    const result = await differential(fixture, sqliteEngine(), writes);
    assert.equal(result.divergence, null, JSON.stringify(result.divergence));
    assert.deepEqual(result.byTrigger, { tasks_due: 2 });
  });

  it('keeps a bump whose own UPDATE fires another trigger, and reads the other trigger back', async () => {
    const source = await original(KEPT_TRIGGER_FIXTURE);
    try {
      const kept = source.report.find((row) => row.object === 'notes_bump');
      assert.equal(kept.code, 'unmapped-object');
      assert.equal(kept.reason, 'a bump whose own UPDATE fires the table\'s trigger \'notes_locked\' again, which the rule\'s program does not');
      assert.match(kept.detail, /^an application-owned trigger program must be explicitly preserved; inspection grants no drop permission; it is not read back as a database rule: a bump/);
      assert.equal(source.report.find((row) => row.object === 'notes_locked').code, 'trigger-rule');
      assert.deepEqual(source.model.entities.notes.invariants.map((/** @type {any} */ rule) => rule.name), ['notes_locked']);
    }
    finally { source.connection.close(); }
    // a trigger the reader does not map still fires the bump's own UPDATE, and a blob literal is read whole
    const unread = await original({ ...KEPT_TRIGGER_FIXTURE, triggers: [KEPT_TRIGGER_FIXTURE.triggers[0],
      "CREATE TRIGGER notes_blob BEFORE UPDATE ON notes WHEN NEW.body = x'00' BEGIN SELECT RAISE(ABORT, 'no blob'); END"] });
    try {
      assert.deepEqual(unread.report.filter((row) => row.code === 'unmapped-object').map((row) => [row.object, row.reason]), [
        ['notes_blob', 'a blob literal'],
        ['notes_bump', 'a bump whose own UPDATE fires the table\'s trigger \'notes_blob\' again, which the rule\'s program does not']]);
    }
    finally { unread.connection.close(); }
  });

  it(`leaves ${NEGATIVE_TRIGGERS.length} other shapes unmapped, each with the first construct it does not map`, async () => {
    assert.ok(NEGATIVE_TRIGGERS.length >= 15);
    for (const [label, sql, reason] of NEGATIVE_TRIGGERS) {
      const connection = await nodeDriver().open(':memory:');
      try {
        connection.exec(NEGATIVE_TABLES);
        connection.exec(sql);
        const { model, report } = await introspectModel(connection, { triggers: sqliteTriggers });
        const triggers = report.filter((row) => row.code === 'unmapped-object' || row.code === 'trigger-rule');
        assert.equal(triggers.length, 1, label);
        assert.equal(triggers[0].code, 'unmapped-object', label);
        if (reason.endsWith(': ')) assert.ok(triggers[0].reason.startsWith(reason), `${label}: ${triggers[0].reason}`);
        else assert.equal(triggers[0].reason, reason, label);
        // nothing is laid out for a trigger that is not read back
        assert.ok(Object.values(model.entities ?? {}).every((/** @type {any} */ entity) => entity.physical === undefined), label);
      }
      finally { connection.close(); }
    }
  });

  it('plans nothing against the database it read: no drop and no re-create, and opening waits for a reviewed migration', async () => {
    const fixture = TRIGGER_FIXTURES[1];
    const engine = await sqliteEngine().fixture({ sqlite: [fixture.sqlite, ...fixture.triggers].join(';\n') });
    try {
      const connection = await engine.connection();
      const { model, report } = await introspectModel(connection, { triggers: sqliteTriggers });
      assert.deepEqual((await introspectModel(connection, { triggers: sqliteTriggers })).model, model);
      assert.deepEqual(planMigration(model, model, { dialect: sqliteDialect }).migration.steps, []);
      const source = (await readSchema(connection)).objects;
      const preserve = Object.fromEntries(source.map((object) => [physicalObjectKey(object), 'preserve']));
      assert.deepEqual((await planPhysicalMigration(connection, model, model, { id: 'same', steps: [], dispositions: preserve })).steps, []);
      // a disposition is the host's to give: inspection grants none
      await assert.rejects(async () => planPhysicalMigration(connection, model, model, { id: 'same', steps: [] }), { code: 'JD0021' });
      // the database holds the triggers, not the rules' programs
      await assert.rejects(openStore(model, { driver: engine.target.driver }), (/** @type {any} */ error) => error.code === 'JD0002'
        && /invariant trigger '_jaren_rule_\d+_\w+' is missing or changed/.test(error.message));
      // the reviewed migration that adopts them: install each program, drop each trigger read back
      const read = rows(report, 'trigger-rule').map((row) => row.object);
      assert.equal(read.length, fixture.triggers.length);
      const steps = [...read.map((name) => ({ kind: 'ddl', sql: `DROP TRIGGER "${name}"` })),
        ...planInvariants(model, { dialect: sqliteDialect }).map((statement) => ({ kind: 'ddl', sql: statement.sql }))];
      const migration = await planPhysicalMigration(connection, model, model, { id: 'adopt-trigger-rules', steps, assertions: [],
        dispositions: Object.fromEntries(source.map((object) => [physicalObjectKey(object), read.includes(object.name) ? 'drop' : 'preserve'])) });
      await migrate(engine.target, [migration], { baseline: model, shadow: false, model });
      const store = await openStore(model, { driver: engine.driver });
      try {
        await store.entity('orders').create({ id: 1, status: 'final', sealed_at: null, code: 'a' });
        await assert.rejects(store.entity('lines').create({ id: 1, order_id: 1, qty: 1, order_code: null }),
          (/** @type {any} */ error) => error.code === 'JD2096' && /jaren invariant:lines_draft_insert/.test(error.message));
        await store.entity('lines').create({ id: 2, order_id: 7, qty: 1, order_code: null });
        // the option threads through the store's own read: the programs it now holds are the store's
        const again = await store.introspect({ triggers: sqliteTriggers });
        assert.deepEqual([...new Set(rows(again.report, 'unmapped-object').map((row) => row.reason))],
          ['the store names a declared rule\'s program so; the model that declares the rule opens the table']);
      }
      finally { await store.close(); }
    }
    finally { await engine.dispose(); }
  });

  it('derives a column layout only for the tables a rule read back reads, its other facts reported', async () => {
    const connection = await nodeDriver().open(':memory:');
    try {
      connection.exec('CREATE TABLE orders(id INTEGER PRIMARY KEY, status TEXT NOT NULL CHECK (status IN (\'draft\', \'final\')), code TEXT NOT NULL); '
        + 'CREATE INDEX orders_draft ON orders(code) WHERE status = \'draft\'; '
        + 'CREATE TABLE lines(id INTEGER PRIMARY KEY, order_id INTEGER REFERENCES orders(id), qty INTEGER NOT NULL); '
        + 'CREATE TABLE misc(id INTEGER PRIMARY KEY, order_id INTEGER REFERENCES orders(id), label TEXT)');
      connection.exec(TRIGGER_FIXTURES[1].triggers[0]);
      const { model, report } = await introspectModel(connection, { triggers: sqliteTriggers });
      assert.deepEqual(Object.keys(model.entities).filter((name) => model.entities[name].physical !== undefined).sort(), ['lines', 'orders']);
      assert.equal(model.entities.misc.physical, undefined);
      assert.deepEqual(rows(report, 'document-members').map((row) => row.object), ['misc']);
      // a layout declares no relation, and neither its CHECK nor its partial index
      assert.deepEqual(rows(report, 'unmapped-constraint').map((row) => [row.object, row.detail]), [
        ['lines.order_id', 'the foreign key to \'orders\' is not declared: a column layout declares no relation'],
        ['misc.order_id', 'the foreign key to \'orders\' is not declared: it references a column layout, which declares no relation'],
        ['orders.check_1', 'a CHECK of a table read back as a column layout stays a physical fact the layout does not declare']]);
      assert.deepEqual(rows(report, 'unmapped-index').map((row) => row.object), ['orders.orders_draft']);
      assert.equal(model.entities.orders.physical.indexes, undefined);
      assert.equal(Object.values(model.entities.misc.schema.properties).some((/** @type {any} */ property) => property['x-entity']?.relation), false);
      // the model read back is one model: both kinds of entity in it map
      assert.deepEqual(Object.keys(explainMapping(model).entities).sort(), ['lines', 'misc', 'orders']);
      // and a join table beside a layout declares no relation on it
      connection.exec('CREATE TABLE tags(id INTEGER PRIMARY KEY, label TEXT); CREATE TABLE order_tags(order_id INTEGER NOT NULL REFERENCES orders(id), '
        + 'tag_id INTEGER NOT NULL REFERENCES tags(id), PRIMARY KEY (order_id, tag_id))');
      const joined = await introspectModel(connection, { triggers: sqliteTriggers });
      assert.deepEqual(rows(joined.report, 'unmapped-table').map((row) => [row.object, row.detail]),
        [['order_tags', 'the join table joins the column layout \'orders\', which declares no relation']]);
      assert.deepEqual(rows(joined.report, 'ambiguous-relation').map((row) => row.object), []);
      assert.deepEqual(Object.keys(explainMapping(joined.model).entities).sort(), ['lines', 'misc', 'orders', 'tags']);
    }
    finally { connection.close(); }
  });

  it('documents where a BEFORE trigger and the rule part: a row a conflict clause skips, and a value the column\'s codec does not read', async () => {
    const tables = 'CREATE TABLE items(id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, qty INTEGER NOT NULL)';
    const guard = (/** @type {string} */ timing) => `CREATE TRIGGER items_qty ${timing} INSERT ON items WHEN NEW.qty < 0 BEGIN SELECT RAISE(ABORT, 'no negative stock'); END`;
    const writes = ["INSERT INTO items VALUES (1, 'a', 1)", "INSERT OR IGNORE INTO items VALUES (2, 'a', -1)", "INSERT INTO items VALUES (3, 'b', -1) ON CONFLICT DO NOTHING"];
    const after = await differential({ name: 'after', sqlite: tables, triggers: [guard('AFTER')], tables: { items: { key: ['id'] } } }, sqliteEngine(), writes);
    assert.equal(after.divergence, null);
    // the BEFORE trigger refuses the row the conflict clause would skip; the rule's program never meets it
    const before = await differential({ name: 'before', sqlite: tables, triggers: [guard('BEFORE')], tables: { items: { key: ['id'] } } }, sqliteEngine(), writes);
    assert.deepEqual([before.divergence?.at, before.divergence?.original.split('\n')[0], before.divergence?.subject.split('\n')[0]], [1, 'no negative stock', '']);
    // a text in an INTEGER column, which the trigger compares and the rule's codec does not read
    const domain = await differential({ name: 'domain', sqlite: tables, triggers: [guard('AFTER')], tables: { items: { key: ['id'] } } }, sqliteEngine(),
      ["INSERT INTO items VALUES (1, 'a', 'many')"]);
    assert.deepEqual([domain.divergence?.original.split('\n')[0], /jaren invariant:items_qty/.test(String(domain.divergence?.subject))], ['', true]);
  });
});
