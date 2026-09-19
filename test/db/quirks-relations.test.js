//@ts-check
/**
 * @file Regressions for the relation quirks a consumer (PlatformOps, on
 * 0.91.3) found: a foreign-key column that also declares `index` or
 * `unique` is ONE index — planned twice, `createModelShape` failed and a
 * reopen counted two declared indexes against one physical; `unique` on
 * the key of a one-to-many edge is refused; a `setNull` key reopens
 * (the model's camelCase spelling read as a changed model); and session
 * capture decodes a table that gained a column by `ADD COLUMN`, whose
 * physical order puts that column after the document; and `migrate()`
 * accepts its own `ADD COLUMN` plan on a table with a foreign key or an
 * enum CHECK (the end-shape check read the moved column as drift).
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import {
  openStore, planModelMigration, migrate, sqliteDialect, createModelShape,
} from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { tempDbPath } from './helpers.js';

/** @param {any} fkFlags @param {any} [orgExtra] @param {string} [onDelete] */
const workspaceModel = (fkFlags, orgExtra = {}, onDelete = 'restrict') => ({
  $model: '0.1',
  entities: {
    Organization: { schema: { type: 'object', required: ['id'], properties: {
      id: { type: 'string', 'x-entity': { key: true } }, ...orgExtra,
    } } },
    Workspace: { schema: { type: 'object', required: ['id'], properties: {
      id: { type: 'string', 'x-entity': { key: true } },
      organizationId: { type: 'string', ...(fkFlags === null ? {} : { 'x-entity': fkFlags }) },
      organization: { 'x-entity': { relation: { to: 'Organization', via: 'organizationId', onDelete } } },
    } } },
  },
});
const manySide = { workspaces: { 'x-entity': { relation: {
  to: 'Workspace', many: true, via: 'organizationId', onDelete: 'restrict' } } } };

/** @param {any} model */
const openTwice = async (model) => {
  const { dbPath, cleanup } = tempDbPath();
  try {
    for (let i = 0; i < 2; i++) await (await openStore(model, { driver: nodeDriver(), path: dbPath })).close();
  }
  finally {
    cleanup();
  }
};
/** @param {any} model */
const indexesOf = async (model) => {
  const connection = await nodeDriver().open(':memory:', {});
  try {
    await createModelShape(connection, model);
    const statement = await connection.prepare(
      "SELECT name, \"unique\" AS uniq FROM pragma_index_list('Workspace') WHERE origin = 'c'");
    return (await statement.all([])).map((row) => `${row.name}:${Number(row.uniq)}`);
  }
  finally {
    await connection.close();
  }
};

describe('a declared index on a foreign-key column is the key\'s own index', () => {
  it('index on a many-to-one key: one plain index, built, reopened and planned once', async () => {
    const model = workspaceModel({ index: true }, manySide);
    assert.deepStrictEqual(await indexesOf(model), ['Workspace_organizationId:0']);
    await openTwice(model);
    const base = workspaceModel(null, {});
    delete base.entities.Workspace.schema.properties.organization;
    delete base.entities.Workspace.schema.properties.organizationId;
    const { migration } = planModelMigration(base, model, { dialect: sqliteDialect, id: 'm' });
    const creates = JSON.stringify(migration.steps).match(/CREATE (UNIQUE )?INDEX \\"Workspace_organizationId/g);
    assert.strictEqual(creates?.length, 1);
  });

  it('index or unique on a one-to-one key: one UNIQUE index', async () => {
    assert.deepStrictEqual(await indexesOf(workspaceModel({ index: true })), ['Workspace_organizationId:1']);
    assert.deepStrictEqual(await indexesOf(workspaceModel({ unique: true })), ['Workspace_organizationId:1']);
    await openTwice(workspaceModel({ unique: true }));
  });

  it('unique on the key of a one-to-many edge is JD0031', async () => {
    await assert.rejects(() => openTwice(workspaceModel({ unique: true }, manySide)),
      (error) => /** @type {any} */ (error).code === 'JD0031');
  });
});

describe('a setNull foreign key reopens', () => {
  it('the catalog\'s SET NULL is the model\'s setNull', async () => {
    await openTwice(workspaceModel(null, {}, 'setNull'));
  });
});

describe('session capture after an ADD COLUMN migration', () => {
  it('decodes by the physical column order: the same patches as the journal', async () => {
    const from = { $model: '0.1', entities: { Item: { schema: { type: 'object', required: ['id'], properties: {
      id: { type: 'string', 'x-entity': { key: true } },
      name: { type: 'string' },
      flag: { type: 'boolean', 'x-entity': { index: true } },
    } } } } };
    const to = structuredClone(from);
    /** @type {any} */ (to.entities.Item.schema.properties).rank = { type: 'integer', 'x-entity': { index: true } };
    const { dbPath, cleanup } = tempDbPath();
    try {
      const seed = await openStore(from, { driver: nodeDriver(), path: dbPath });
      await seed.entity('Item').create({ id: 'a', name: 'x' });
      await seed.close();
      const { migration } = planModelMigration(from, to, { dialect: sqliteDialect, id: 'm' });
      migration.steps = migration.steps.filter((step) => step.draft !== true);
      assert.ok(migration.steps.some((step) => /ADD COLUMN/.test(step.sql ?? '')),
        'the column arrives by ADD COLUMN, after the document');
      await migrate({ driver: nodeDriver(), path: dbPath }, [migration], { baseline: from, model: to });

      const patchesFor = async (/** @type {string} */ mode) => {
        const store = await openStore(to, { driver: nodeDriver(), path: dbPath, capture: { mode, log: true } });
        try {
          const before = (await store.changesSince(0)).length;
          await store.entity('Item').create({ id: 'b', name: 'y', flag: true, rank: 3 });
          await store.entity('Item').update('b', { rank: 4 });
          await store.entity('Item').delete('b');
          return (await store.changesSince(0)).slice(before).map((record) => record.patch);
        }
        finally {
          await store.close();
        }
      };
      const session = await patchesFor('session');
      assert.deepStrictEqual(session[0], [{ op: 'add', path: '/Item/b',
        value: { id: 'b', name: 'y', flag: true, rank: 3 } }]);
      assert.deepStrictEqual(session, await patchesFor('journal'));
    }
    finally {
      cleanup();
    }
  });
});

describe('an additive migration on a table with order-sensitive columns', () => {
  /** @param {any} extra */
  const itemModel = (extra) => ({ $model: '0.1', entities: {
    Org: { schema: { type: 'object', required: ['id'], properties: {
      id: { type: 'string', 'x-entity': { key: true } },
      items: { 'x-entity': { relation: { to: 'Item', many: true, via: 'orgId', onDelete: 'restrict' } } },
    } } },
    Item: { schema: { type: 'object', required: ['id'], properties: {
      id: { type: 'string', 'x-entity': { key: true } },
      state: { type: 'string', enum: ['open', 'closed'], 'x-entity': { index: true } },
      ...extra,
    } } },
  } });

  it('ADD COLUMN beside a foreign key and a CHECK migrates, reopens and captures', async () => {
    const from = itemModel({});
    const to = itemModel({ rank: { type: 'integer', 'x-entity': { index: true } } });
    const { dbPath, cleanup } = tempDbPath();
    try {
      const seed = await openStore(from, { driver: nodeDriver(), path: dbPath });
      await seed.entity('Org').create({ id: 'o' });
      await seed.entity('Item').create({ id: 'a', state: 'open', orgId: 'o' });
      await seed.close();
      const { migration } = planModelMigration(from, to, { dialect: sqliteDialect, id: 'm' });
      migration.steps = migration.steps.filter((step) => step.draft !== true);
      assert.ok(migration.steps.some((step) => /ADD COLUMN/.test(step.sql ?? '')), 'no rebuild');
      await migrate({ driver: nodeDriver(), path: dbPath }, [migration], { baseline: from, model: to });

      const store = await openStore(to, { driver: nodeDriver(), path: dbPath, capture: { mode: 'session', log: true } });
      try {
        await store.entity('Item').create({ id: 'b', state: 'closed', rank: 2, orgId: 'o' });
        const [record] = await store.changesSince(0);
        assert.deepStrictEqual(record.patch, [{ op: 'add', path: '/Item/b',
          value: { id: 'b', state: 'closed', rank: 2, orgId: 'o' } }]);
      }
      finally {
        await store.close();
      }
    }
    finally {
      cleanup();
    }
  });
});
