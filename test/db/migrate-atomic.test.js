//@ts-check
/**
 * @file Repair before a narrowing lands (MIGRATION-FORMAT §4): link by
 * link, each link commits on its own and the chain's last link validates —
 * so a narrowing link followed by a failing one used to stay committed and
 * recorded, and a store opened on it served a document the narrowed schema
 * refuses. `migrate(…, { atomic: true })` runs every pending link in ONE
 * immediate transaction, a savepoint per link, the final checks once at the
 * end: the chain commits whole or not at all, a repair link after a
 * narrowing link repairs before the check, and a repeat applies nothing. A
 * link that rebuilds a table cannot be held (`JD0026`). The planner takes a
 * narrowing's repair up front: `planModelMigration(from, to, { transform })`
 * writes the supplied jslt or host step where its draft would have been, so
 * a plan applies unattended.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { openStore, planModelMigration, migrate, migrationStatus, sqliteDialect, shapeHash } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { JarenValidator } from '@jarenjs/validate';
import { tempDbPath } from './helpers.js';

const compileSchema = (/** @type {any} */ schema) => {
  const validate = new JarenValidator({ collectErrors: true }).compile(schema);
  return (/** @type {any} */ doc) => validate(doc);
};
const V1 = { $model: '0.1', collections: { docs: { schema: { type: 'object', properties: { name: { type: 'string' } } }, key: '/id', indexes: [] } } };
const V2 = structuredClone(V1);
/** @type {any} */ (V2.collections.docs.schema.properties.name).maxLength = 3;
const applied = (/** @type {any} */ migration) => ({ ...migration, steps: migration.steps.filter((/** @type {any} */ s) => s.draft !== true) });
/** The narrowing, planned without its repair: its draft deleted. */
const NARROW = applied(planModelMigration(V1, V2, { dialect: sqliteDialect, id: 'narrow' }).migration);
const hosts = { truncate: { version: '1', run(/** @type {any} */ scope) {
  return scope.collection('docs').update((/** @type {any} */ doc) => (doc.name.length > 3 ? { ...doc, name: doc.name.slice(0, 3) } : undefined));
} }, fail: { version: '1', run() { throw new Error('the repair gave up'); } } };
const REPAIR = { $migration: '0.1', id: 'repair', from: shapeHash(V2), to: shapeHash(V2), steps: [{ kind: 'host', run: 'truncate', version: '1' }] };
const FAILING = { $migration: '0.1', id: 'failing', from: shapeHash(V2), to: shapeHash(V2), steps: [{ kind: 'host', run: 'fail', version: '1' }] };

async function seeded() {
  const temp = tempDbPath();
  const store = await openStore(V1, { driver: nodeDriver(), path: temp.dbPath });
  await store.collection('docs').put({ id: 'a', name: 'abcdef' });
  await store.collection('docs').put({ id: 'b', name: 'xy' });
  await store.close();
  return temp;
}
/** @param {string} file @param {any[]} list */
const status = (file, list) => migrationStatus({ driver: nodeDriver(), path: file }, list, {});

describe('link by link, each link commits on its own — the documented truth', () => {
  it('a narrowing link stays committed when the next link fails, and the store serves what it narrowed', async () => {
    const { dbPath, cleanup } = await seeded();
    try {
      await assert.rejects(migrate({ driver: nodeDriver(), path: dbPath }, [NARROW, FAILING],
        { baseline: V1, model: V2, compileSchema, shadow: false, hosts }), (/** @type {any} */ e) => e.code === 'JD0023');
      assert.deepEqual((await status(dbPath, [NARROW, FAILING])).applied, ['narrow']);
      const store = await openStore(V2, { driver: nodeDriver(), path: dbPath });
      assert.equal((await store.collection('docs').get('a'))?.name, 'abcdef', 'a document the narrowed schema refuses');
      await store.close();
    }
    finally { cleanup(); }
  });
});

describe('atomic: the chain commits whole or not at all', () => {
  it('a narrowing link followed by a repair link applies, and validates after the repair', async () => {
    const { dbPath, cleanup } = await seeded();
    try {
      const outcome = await migrate({ driver: nodeDriver(), path: dbPath }, [NARROW, REPAIR],
        { baseline: V1, model: V2, compileSchema, hosts, atomic: true });
      assert.deepEqual(/** @type {any} */ (outcome).applied, ['narrow', 'repair']);
      const store = await openStore(V2, { driver: nodeDriver(), path: dbPath });
      assert.deepEqual(await store.collection('docs').all(), [{ id: 'a', name: 'abc' }, { id: 'b', name: 'xy' }]);
      await store.close();
      // two-run: the repeat applies nothing and reports zero
      const again = await migrate({ driver: nodeDriver(), path: dbPath }, [NARROW, REPAIR],
        { baseline: V1, model: V2, compileSchema, hosts, atomic: true });
      assert.deepEqual(again, { applied: [], skipped: ['narrow', 'repair'], upToDate: true });
    }
    finally { cleanup(); }
  });

  it('a failure anywhere leaves no link applied: a step, or the final validation', async () => {
    const { dbPath, cleanup } = await seeded();
    try {
      await assert.rejects(migrate({ driver: nodeDriver(), path: dbPath }, [NARROW, FAILING],
        { baseline: V1, model: V2, compileSchema, shadow: false, hosts, atomic: true }),
      (/** @type {any} */ e) => e.code === 'JD0023' && /migration 'failing' step 0/.test(e.message));
      assert.deepEqual((await status(dbPath, [NARROW, FAILING])).applied, [], 'the narrowing rolled back with the chain');
      // without the repair, the final validation refuses — and nothing is recorded either
      await assert.rejects(migrate({ driver: nodeDriver(), path: dbPath }, [NARROW],
        { baseline: V1, model: V2, compileSchema, shadow: false, atomic: true }), (/** @type {any} */ e) => e.code === 'JD0021');
      assert.deepEqual((await status(dbPath, [NARROW])).applied, []);
      const store = await openStore(V1, { driver: nodeDriver(), path: dbPath });
      assert.equal((await store.collection('docs').get('a'))?.name, 'abcdef');
      await store.close();
    }
    finally { cleanup(); }
  });

  it('a cancellation inside an atomic run rolls the whole chain back', async () => {
    const { dbPath, cleanup } = await seeded();
    try {
      const controller = new AbortController();
      const cancelling = { truncate: { version: '1', run(/** @type {any} */ scope) {
        const count = scope.collection('docs').update(() => undefined);
        controller.abort();
        return count;
      } } };
      const NEXT = { $migration: '0.1', id: 'next', from: shapeHash(V2), to: shapeHash(V2), steps: [] };
      await assert.rejects(migrate({ driver: nodeDriver(), path: dbPath }, [NARROW, REPAIR, NEXT],
        { baseline: V1, model: V2, shadow: false, hosts: cancelling, atomic: true, signal: controller.signal }),
      (/** @type {any} */ e) => e.code === 'JD2080');
      assert.deepEqual((await status(dbPath, [NARROW, REPAIR, NEXT])).applied, []);
    }
    finally { cleanup(); }
  });

  it('a link that rebuilds a table is JD0026, before anything runs; atomic is a boolean', async () => {
    const E1 = { $model: '0.1', entities: { User: { schema: { type: 'object', properties: {
      id: { type: 'string', 'x-entity': { key: true } }, age: { type: 'integer' } } } } } };
    const E2 = structuredClone(E1);
    /** @type {any} */ (E2.entities.User.schema.properties.age).type = 'string';
    const rebuild = planModelMigration(E1, E2, { dialect: sqliteDialect, id: 'retype',
      transform: { kind: 'jslt', collection: 'User', stylesheet: [{ match: '$', body: { id: '$.id' } }] } }).migration;
    assert.ok(rebuild.steps.some((/** @type {any} */ s) => s.kind === 'rebuild'));
    const temp = tempDbPath();
    try {
      const store = await openStore(E1, { driver: nodeDriver(), path: temp.dbPath });
      await store.close();
      await assert.rejects(migrate({ driver: nodeDriver(), path: temp.dbPath }, [rebuild], { baseline: E1, model: E2, atomic: true }),
        (/** @type {any} */ e) => e.code === 'JD0026' && /migration 'retype' rebuilds a table/.test(e.message));
      assert.deepEqual((await migrationStatus({ driver: nodeDriver(), path: temp.dbPath }, [rebuild], {})).applied, []);
      assert.throws(() => migrate({ connection: /** @type {any} */ ({ prepare() {}, transaction() {} }) }, [rebuild],
        { baseline: E1, atomic: /** @type {any} */ ('yes') }), TypeError);
      // the same chain without atomic applies
      const done = await migrate({ driver: nodeDriver(), path: temp.dbPath }, [rebuild], { baseline: E1, model: E2 });
      assert.deepEqual(/** @type {any} */ (done).applied, ['retype']);
    }
    finally { temp.cleanup(); }
  });
});

describe("the planner takes a narrowing's repair: transform", () => {
  it('a host step in place of the draft: no draft step, and the plan applies unattended', async () => {
    const { dbPath, cleanup } = await seeded();
    try {
      const { migration, report } = planModelMigration(V1, V2, { dialect: sqliteDialect, id: 'repaired',
        transform: { kind: 'host', run: 'truncate', version: '1' } });
      assert.deepEqual(migration.steps, [{ kind: 'host', run: 'truncate', version: '1' }]);
      assert.deepEqual({ drafts: report.drafts, transformed: report.transformed }, { drafts: [], transformed: ['docs'] });
      await migrate({ driver: nodeDriver(), path: dbPath }, [migration], { baseline: V1, model: V2, compileSchema, hosts });
      const store = await openStore(V2, { driver: nodeDriver(), path: dbPath });
      assert.equal((await store.collection('docs').get('a'))?.name, 'abc');
      await store.close();
      // planning twice is one document, so a host that re-plans at load pins its checksum
      assert.deepEqual(planModelMigration(V1, V2, { dialect: sqliteDialect, id: 'repaired',
        transform: { kind: 'host', run: 'truncate', version: '1' } }).migration, migration);
    }
    finally { cleanup(); }
  });

  it('a jslt step, a map by name, and the refusals of a transform no draft asks for', () => {
    const jslt = { kind: 'jslt', collection: 'docs', stylesheet: [{ match: '$', body: { id: '$.id', name: 'x' } }] };
    assert.deepEqual(planModelMigration(V1, V2, { dialect: sqliteDialect, id: 'j', transform: [jslt] }).migration.steps, [jslt]);
    assert.deepEqual(planModelMigration(V1, V2, { dialect: sqliteDialect, id: 'm', transform: { docs: jslt } }).migration.steps, [jslt]);
    // requiring fewer members widens: every stored document still validates, so there is no draft
    const requiring = structuredClone(V1);
    /** @type {any} */ (requiring.collections.docs.schema).required = ['name'];
    assert.deepEqual(planModelMigration(requiring, V1, { dialect: sqliteDialect }).report.widened, ['docs']);
    assert.throws(() => planModelMigration(requiring, V1, { dialect: sqliteDialect, transform: jslt }), /plans no draft transform/);
    assert.throws(() => planModelMigration(V1, V2, { dialect: sqliteDialect, transform: { other: jslt } }), /names 'other'/);
    assert.throws(() => planModelMigration(V1, V2, { dialect: sqliteDialect, transform: /** @type {any} */ ({ kind: 'sql', sql: 'x' }) }),
      /a jslt step .* or a host step/);
    assert.throws(() => planModelMigration(V1, V2, { dialect: sqliteDialect, transform: [] }), /at least one step/);
  });
});
