//@ts-check
/**
 * @file Adopting versioned history on an existing populated schema
 * (MIGRATION-FORMAT §12): a zero-step physical receipt anchors the history —
 * `from === to`, one history row, a repeat that does nothing — and guarded
 * table plans follow it. A plan's source inventory used to be the WHOLE
 * schema, so the same reviewed baseline refused (`JD0020`) on a second
 * installation that differed only by one unrelated table. A plan scoped to
 * the tables it owns (`scope: { tables }`) inventories those tables and
 * their programs alone, so one reviewed plan applies to every installation;
 * `migrationStatus` names the receipt as the history's baseline; a
 * malformed scope, or one naming a table the plan does not own, is
 * `JD0027`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { migrationIdentity } from './migration-fixture.js';
import { DatabaseSync } from 'node:sqlite';

import { openStore, planPhysicalMigration, planTableMigration, migrate, migrationStatus, readSchema } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { tempDbPath } from './helpers.js';

const MODEL = { $model: '0.1', entities: { Item: { schema: { type: 'object', properties: {
  id: { type: 'integer', 'x-entity': { key: true } }, name: { type: 'string' } } },
physical: { table: 'item', columns: { id: { name: 'id', codec: 'integer', null: 'reject' }, name: { name: 'name', codec: 'text', null: 'null' } } } } } };
const coded = (/** @type {string} */ code, /** @type {RegExp} */ pattern = /./) =>
  (/** @type {any} */ error) => error.code === code && pattern.test(error.message);

/** An installation: the owned table, its index, and optionally one unrelated table. @param {boolean} unrelated */
function installation(unrelated) {
  const temp = tempDbPath();
  const db = new DatabaseSync(temp.dbPath);
  db.exec("CREATE TABLE item(id INTEGER PRIMARY KEY, name TEXT); CREATE INDEX item_name ON item(name); INSERT INTO item VALUES (1, 'a'), (2, 'b');");
  if (unrelated) db.exec('CREATE TABLE unrelated(x INTEGER); INSERT INTO unrelated VALUES (7);');
  db.close();
  return temp;
}
/** The reviewed baseline, planned once on a reference installation: scoped to the table the model maps. */
async function reviewedBaseline() {
  const reference = installation(false);
  const connection = await nodeDriver().open(reference.dbPath, {});
  try {
    const objects = readSchema(connection).objects.filter((/** @type {any} */ object) => object.owner === 'item');
    return /** @type {any} */ (planPhysicalMigration(connection, MODEL, MODEL, { id: '0000-baseline', steps: [],
      dispositions: Object.fromEntries(objects.map((/** @type {any} */ o) => [`${o.type}:${o.name}`, 'preserve'])),
      physicalTarget: { objects }, scope: { tables: ['item'] } }));
  }
  finally {
    connection.close();
    reference.cleanup();
  }
}

describe('a baseline receipt adopts history', () => {
  it('one reviewed, scoped plan applies to every installation, whatever unrelated tables it keeps', async () => {
    const baseline = await reviewedBaseline();
    assert.equal(baseline.from, baseline.to);
    assert.deepEqual(baseline.steps, []);
    assert.deepEqual(baseline.physical.scope, { tables: ['item'] });
    assert.deepEqual(baseline.physical.source.map((/** @type {any} */ o) => `${o.type}:${o.name}`).sort(), ['index:item_name', 'table:item']);
    for (const unrelated of [false, true]) {
      const { dbPath, cleanup } = installation(unrelated);
      const connection = await nodeDriver().open(dbPath, {});
      try {
        const first = /** @type {any} */ (migrate({ connection }, [baseline], { baseline: MODEL, model: MODEL, shadow: false }));
        assert.deepEqual(first.applied, ['0000-baseline'], `unrelated table: ${unrelated}`);
        const repeat = migrate({ connection }, [baseline], { baseline: MODEL, model: MODEL, shadow: false });
        assert.deepEqual(repeat, { applied: [], skipped: ['0000-baseline'], upToDate: true });
        assert.deepEqual(migrationStatus({ connection }, [baseline], {}),
          { applied: ['0000-baseline'], pending: [], drift: null, upToDate: true, baseline: '0000-baseline' });
        const rows = connection.prepare('SELECT "id", "from_hash", "to_hash", "steps" FROM "_jaren_migrations"').all([]);
        assert.deepEqual(rows.map((/** @type {any} */ row) => ({ ...row })),
          [{ id: '0000-baseline', from_hash: baseline.from, to_hash: baseline.to, steps: 0 }]);
        if (unrelated) {
          const kept = /** @type {any} */ (connection.prepare('SELECT x FROM unrelated').get([]));
          assert.equal(kept.x, 7, 'the unrelated table is untouched');
        }
      }
      finally {
        connection.close();
        cleanup();
      }
    }
  });

  it('a repeat opening does no work: the store adopts the table as it is', async () => {
    const baseline = await reviewedBaseline();
    const { dbPath, cleanup } = installation(true);
    try {
      await migrate({ driver: nodeDriver(), path: dbPath }, [baseline], { baseline: MODEL, model: MODEL, shadow: false });
      const schema = () => new DatabaseSync(dbPath).prepare('SELECT type, name, sql FROM sqlite_schema ORDER BY name').all();
      const before = schema();
      for (let run = 0; run < 2; run++) {
        const store = await openStore(MODEL, { driver: nodeDriver(), path: dbPath, adopt: true });
        assert.deepEqual((await store.entity('Item').load({ orderBy: '$it.id' })).map((/** @type {any} */ row) => row.name), ['a', 'b']);
        await store.close();
        const outcome = await migrate({ driver: nodeDriver(), path: dbPath }, [baseline], { baseline: MODEL, model: MODEL, shadow: false });
        assert.deepEqual(outcome, { applied: [], skipped: ['0000-baseline'], upToDate: true });
      }
      assert.deepEqual(schema(), before, 'no statement changed the schema');
    }
    finally { cleanup(); }
  });

  it('a guarded table plan follows the baseline', async () => {
    const baseline = await reviewedBaseline();
    const { dbPath, cleanup } = installation(true);
    const connection = await nodeDriver().open(dbPath, {});
    try {
      migrate({ connection }, [baseline], { baseline: MODEL, model: MODEL, shadow: false });
      const table = planTableMigration(connection, { name: 'item', primaryKey: ['id'], columns: [
        { name: 'id', type: 'INTEGER', nullable: false }, { name: 'name', type: 'TEXT' },
        { name: 'revision', type: 'INTEGER', nullable: false, default: 1 }] }, { id: 'revision', allowRebuild: true });
      const upgrade = /** @type {any} */ ({ $migration: '0.2', identity: migrationIdentity(MODEL), id: 'revision', from: baseline.to, to: baseline.to, steps: [{ kind: 'table', plan: table }] });
      const outcome = /** @type {any} */ (migrate({ connection }, [baseline, upgrade], { baseline: MODEL, model: MODEL, shadow: false }));
      assert.deepEqual(outcome.applied, ['revision']);
      assert.deepEqual(connection.prepare('SELECT "id", "revision" FROM item ORDER BY id').all([]).map((/** @type {any} */ r) => ({ ...r })),
        [{ id: 1, revision: 1 }, { id: 2, revision: 1 }]);
      assert.equal(migrationStatus({ connection }, [baseline, upgrade], {}).baseline, '0000-baseline');
    }
    finally {
      connection.close();
      cleanup();
    }
  });
});

describe('the status read', () => {
  it('reports the baseline receipt, and classifies a file it cannot read (JD0023) as a run would', async () => {
    const baseline = await reviewedBaseline();
    const { dbPath, cleanup } = installation(true);
    try {
      await migrate({ driver: nodeDriver(), path: dbPath }, [baseline], { baseline: MODEL, model: MODEL, shadow: false });
      const status = /** @type {any} */ (await migrationStatus({ driver: nodeDriver(), path: dbPath }, [baseline], {}));
      assert.equal(status.baseline, '0000-baseline');
      const garbage = `${dbPath}.not-a-database`;
      const { writeFileSync, rmSync } = await import('node:fs');
      writeFileSync(garbage, 'not a database '.repeat(400));
      try {
        await assert.rejects(migrationStatus({ driver: nodeDriver(), path: garbage }, [], {}), (/** @type {any} */ error) =>
          error.code === 'JD0023' && error.class === 'corrupt' && error.retryable === false && /status could not be read/.test(error.message));
      }
      finally { rmSync(garbage, { force: true }); }
      await assert.rejects(migrationStatus({ driver: nodeDriver(), path: `${dbPath}-missing/dir/x.db` }, [], {}),
        (/** @type {any} */ error) => error.code === 'JD0023' && error.class === 'cantopen');
    }
    finally { cleanup(); }
  });
});

describe('the scope is validated', () => {
  it('an unscoped plan still inventories the whole schema: the second installation refuses JD0020', async () => {
    const reference = installation(false);
    const connection = await nodeDriver().open(reference.dbPath, {});
    /** @type {any} */
    let whole;
    try {
      const objects = readSchema(connection).objects;
      whole = planPhysicalMigration(connection, MODEL, MODEL, { id: '0000-baseline', steps: [],
        dispositions: Object.fromEntries(objects.map((/** @type {any} */ o) => [`${o.type}:${o.name}`, 'preserve'])) });
    }
    finally {
      connection.close();
      reference.cleanup();
    }
    const { dbPath, cleanup } = installation(true);
    try {
      await assert.rejects(migrate({ driver: nodeDriver(), path: dbPath }, [whole], { baseline: MODEL, model: MODEL, shadow: false }),
        coded('JD0020', /physical source schema changed/));
    }
    finally { cleanup(); }
  });

  it('malformed, or naming a table the plan does not own: JD0027 — at plan time and in a saved document', async () => {
    const { dbPath, cleanup } = installation(true);
    const connection = await nodeDriver().open(dbPath, {});
    try {
      const plan = (/** @type {any} */ scope) => planPhysicalMigration(connection, MODEL, MODEL, { id: 'x', steps: [], dispositions: {}, scope });
      for (const scope of [null, [], {}, { tables: [] }, { tables: ['item', 'item'] }, { tables: [''] }, { tables: ['item'], extra: 1 }, { tables: ['_jaren_migrations'] }])
        assert.throws(() => plan(scope), coded('JD0027', /non-empty list of distinct table names/), JSON.stringify(scope));
      assert.throws(() => plan({ tables: ['unrelated'] }), coded('JD0027', /names 'unrelated', which the plan does not own .*\(item\)/));
      const baseline = await reviewedBaseline();
      const tampered = { ...baseline, physical: { ...baseline.physical, scope: { tables: [] } } };
      assert.throws(() => migrate({ connection }, [tampered], { baseline: MODEL, model: MODEL, shadow: false }), coded('JD0027'));
      const widened = { ...baseline, physical: { ...baseline.physical, source: [...baseline.physical.source,
        { type: 'table', name: 'unrelated', owner: 'unrelated', sql: 'CREATE TABLE unrelated(x INTEGER)' }] } };
      assert.throws(() => migrate({ connection }, [widened], { baseline: MODEL, model: MODEL, shadow: false }),
        coded('JD0027', /'table:unrelated', which belongs to no table of its scope/));
    }
    finally {
      connection.close();
      cleanup();
    }
  });
});
