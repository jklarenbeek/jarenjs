//@ts-check
/**
 * @file A many-to-many join table's index over its second key column. The
 * primary key leads with the first column, so the store indexes the second:
 * a read by it (one user's labels in `Label_User`, the cascade from `User`)
 * seeks the index on SQLite and PostgreSQL. A join table an earlier release
 * created has no such index and opens, reads and writes as it is;
 * `planColumnUpgrade` plans the one statement that creates it, and plans
 * nothing once it is there. A migration that renames a join table creates
 * the index under the name a fresh store gives it, whether the table had
 * the index or not. A rename an earlier release planned, which leaves the
 * index under the table's old name where the table has one, is refused
 * before it commits on both engines, as the next open would refuse it.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';

import { openStore, planColumnUpgrade, planModelMigration, migrate, sqliteDialect } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { postgresDialect } from '@jarenjs/db/postgres';

import { joinIndexName } from '../../packages/db/src/ddl.js';
import { tempDbPath } from './helpers.js';
import { ENGINES, skipFor, withPostgres } from './store-core-engines.js';

/** @param {string} to @param {string} [through] */
const many = (to, through) => ({ 'x-entity': { relation: { to, many: true, ...(through === undefined ? {} : { through }) } } });
/** @param {string} key @param {Record<string, any>} [properties] */
const entity = (key, properties = {}) => ({ schema: { type: 'object', required: [key],
  properties: { [key]: { type: 'string', 'x-entity': { key: true } }, ...properties } } });
/** @param {string} [through] */
const modelOf = (through) => ({ $model: '0.1', entities: {
  User: entity('id', { labels: many('Label', through) }), Label: entity('name', { color: { type: 'string' } }) } });
const MODEL = modelOf();
const BY_USER = { $for: { j: '$.Label_User[*]' }, $where: { $eq: ['$j.User_key', 'u1'] }, $return: '$j.Label_key' };
const INDEX_SQL = 'CREATE INDEX "Label_User_User_key" ON "Label_User" ("User_key")';

/** u1 holds admin and dev, u2 dev. @param {any} store */
async function seed(store) {
  for (const id of ['u1', 'u2']) await store.entity('User').create({ id });
  for (const name of ['admin', 'dev']) await store.entity('Label').create({ name });
  await store.saveChanges();
  store.entity('User').link('u1', 'labels', 'admin');
  store.entity('User').link('u1', 'labels', 'dev');
  store.entity('User').link('u2', 'labels', 'dev');
  await store.saveChanges();
}

/** What the store answers over the join table: a read by each key, a hop count and a cascade. @param {any} store */
async function answers(store) {
  const byLabel = { $for: { j: '$.Label_User[*]' }, $where: { $eq: ['$j.Label_key', 'dev'] }, $return: '$j.User_key' };
  return {
    byUser: [await store.execute(BY_USER)].flat().sort(), byLabel: [await store.execute(byLabel)].flat().sort(),
    mode: (await store.explain(BY_USER)).mode,
    held: await store.execute({ $for: { u: '$.User[*]' }, $return: { id: '$u.id',
      n: { $count: { $for: { j: '$.Label_User[*]' }, $where: { $eq: ['$j.User_key', '$u.id'] }, $return: '$j' } } } }),
  };
}

const EXPECTED = { byUser: ['admin', 'dev'], byLabel: ['u1', 'u2'], mode: 'native', held: [{ id: 'u1', n: 2 }, { id: 'u2', n: 1 }] };

/** The index names of `Label_User`, from the catalog. @param {string} file */
const sqliteIndexes = (file) => {
  const raw = new DatabaseSync(file, { readOnly: true });
  try { return raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'Label_User' AND sql IS NOT NULL ORDER BY name").all().map((row) => row.name); }
  finally { raw.close(); }
};

/** The plan SQLite chooses for `sql` and its one parameter. @param {string} file @param {string} sql */
const sqlitePlan = (file, sql) => {
  const raw = new DatabaseSync(file, { readOnly: true });
  try { return raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all('u1').map((row) => row.detail).join('\n'); }
  finally { raw.close(); }
};

/** Drop the index, as a table an earlier release created never had it. @param {string} file */
const asEarlier = (file) => {
  const raw = new DatabaseSync(file);
  try { raw.exec('DROP INDEX "Label_User_User_key"'); }
  finally { raw.close(); }
};

/** @param {string} file @param {any} [model] */
const upgradeOf = async (file, model = MODEL) => {
  const connection = await nodeDriver().open(file, {});
  try { return await planColumnUpgrade(connection, model); }
  finally { await connection.close(); }
};

describe('the index over a join table\'s second key column on SQLite', () => {
  it('a fresh store creates it, and a read by the second column and the cascade from its entity seek it', async () => {
    const { dbPath, cleanup } = tempDbPath();
    try {
      const store = await openStore(MODEL, { driver: nodeDriver(), path: dbPath });
      try {
        await seed(store);
        assert.deepStrictEqual(await answers(store), EXPECTED);
        const { sql } = await store.explain(BY_USER);
        assert.match(sqlitePlan(dbPath, sql), /^SEARCH t0 USING INDEX Label_User_User_key \(User_key=\?\)$/);
      }
      finally { await store.close(); }
      assert.deepStrictEqual(sqliteIndexes(dbPath), ['Label_User_User_key']);
      assert.match(sqlitePlan(dbPath, 'DELETE FROM "Label_User" WHERE "User_key" = ?'), /SEARCH Label_User USING (COVERING )?INDEX Label_User_User_key \(User_key=\?\)/);
      // a table this release creates is current
      const { migration, report } = await upgradeOf(dbPath);
      assert.deepStrictEqual([migration.steps, report.upgraded], [[], []]);
    }
    finally { cleanup(); }
  });

  it('a join table without it opens and answers as before; the upgrade creates it and then plans nothing', async () => {
    const { dbPath, cleanup } = tempDbPath();
    try {
      let store = await openStore(MODEL, { driver: nodeDriver(), path: dbPath });
      try { await seed(store); }
      finally { await store.close(); }
      asEarlier(dbPath);
      store = await openStore(MODEL, { driver: nodeDriver(), path: dbPath });
      try {
        assert.deepStrictEqual(await answers(store), EXPECTED);
        assert.match(sqlitePlan(dbPath, (await store.explain(BY_USER)).sql), /^SCAN t0$/);
        // writes go on: an unlink and a cascade
        store.entity('User').unlink('u1', 'labels', 'admin');
        await store.saveChanges();
        assert.deepStrictEqual(await store.execute(BY_USER), 'dev');
        store.entity('User').link('u1', 'labels', 'admin');
        await store.saveChanges();
      }
      finally { await store.close(); }
      // the models alone plan nothing for it; the catalog plans the index
      assert.deepStrictEqual(planModelMigration(MODEL, MODEL, { dialect: sqliteDialect }).migration.steps, []);
      const { migration, report } = await upgradeOf(dbPath);
      assert.deepStrictEqual(report.upgraded, ['Label_User.Label_User_User_key']);
      assert.deepStrictEqual(migration.steps.map((/** @type {any} */ step) => [step.kind, step.sql]), [['ddl', INDEX_SQL]]);
      assert.deepStrictEqual((await migrate({ driver: nodeDriver(), path: dbPath }, [migration], { baseline: MODEL, model: MODEL })).applied, [migration.id]);
      assert.deepStrictEqual(sqliteIndexes(dbPath), ['Label_User_User_key']);
      store = await openStore(MODEL, { driver: nodeDriver(), path: dbPath });
      try {
        assert.deepStrictEqual(await answers(store), EXPECTED);
        assert.match(sqlitePlan(dbPath, (await store.explain(BY_USER)).sql), /^SEARCH t0 USING INDEX Label_User_User_key \(User_key=\?\)$/);
      }
      finally { await store.close(); }
      const again = await upgradeOf(dbPath);
      assert.deepStrictEqual([again.migration.steps, again.report.upgraded], [[], []]);
    }
    finally { cleanup(); }
  });

  it('a profile that refuses full scans admits a read by the second column, and refuses it where the table has no such index', async () => {
    const { dbPath, cleanup } = tempDbPath();
    try {
      let store = await openStore(MODEL, { driver: nodeDriver(), path: dbPath });
      try { await seed(store); }
      finally { await store.close(); }
      store = await openStore(MODEL, { driver: nodeDriver(), path: dbPath, profile: { refuseFullScan: true } });
      try { assert.deepStrictEqual([await store.execute(BY_USER)].flat().sort(), ['admin', 'dev']); }
      finally { await store.close(); }
      asEarlier(dbPath);
      store = await openStore(MODEL, { driver: nodeDriver(), path: dbPath, profile: { refuseFullScan: true } });
      try { await assert.rejects(async () => store.execute(BY_USER), { code: 'JD0011', message: /full-table scan of Label_User \(SCAN t0\)/ }); }
      finally { await store.close(); }
    }
    finally { cleanup(); }
  });

  it('a join table under another index of that name, or that column indexed otherwise, is refused as before', async () => {
    const { dbPath, cleanup } = tempDbPath();
    try {
      const store = await openStore(MODEL, { driver: nodeDriver(), path: dbPath });
      await store.close();
      const raw = new DatabaseSync(dbPath);
      try { raw.exec('DROP INDEX "Label_User_User_key"; CREATE INDEX "Label_User_User_key" ON "Label_User" ("Label_key")'); }
      finally { raw.close(); }
      await assert.rejects(async () => openStore(MODEL, { driver: nodeDriver(), path: dbPath }), { code: 'JD0002' });
    }
    finally { cleanup(); }
  });

  it('a link that changes another table applies to a join table without it, which keeps none', async () => {
    const next = structuredClone(MODEL);
    next.entities.Label.schema.properties.color = { type: 'string', 'x-entity': { index: true } };
    const { dbPath, cleanup } = tempDbPath();
    try {
      const store = await openStore(MODEL, { driver: nodeDriver(), path: dbPath });
      try { await seed(store); }
      finally { await store.close(); }
      asEarlier(dbPath);
      const { migration } = planModelMigration(MODEL, next, { dialect: sqliteDialect, id: 'next' });
      assert.deepStrictEqual(migration.steps.map((/** @type {any} */ step) => step.sql), ['CREATE INDEX "Label_color" ON "Label" ("color")']);
      assert.deepStrictEqual((await migrate({ driver: nodeDriver(), path: dbPath }, [migration], { baseline: MODEL, model: next })).applied, ['next']);
      assert.deepStrictEqual(sqliteIndexes(dbPath), []);
      const reopened = await openStore(next, { driver: nodeDriver(), path: dbPath });
      try { assert.deepStrictEqual(await answers(reopened), EXPECTED); }
      finally { await reopened.close(); }
    }
    finally { cleanup(); }
  });

  it('a rename link planned without the index applies, shadow included, to a join table that never had it, and is refused, with nothing changed, over one that has it', async () => {
    const renamed = { $model: '0.1', entities: { Person: { 'x-rename': 'User', ...entity('id', { labels: many('Label') }) }, Label: entity('name', { color: { type: 'string' } }) } };
    // the link as a release that created no such index planned it: the renames alone
    const planned = planModelMigration(MODEL, renamed, { dialect: sqliteDialect, id: 'rename' }).migration;
    const earlierLink = { ...planned, steps: planned.steps.filter((/** @type {any} */ step) => !/INDEX/.test(step.sql ?? '')) };
    assert.deepStrictEqual(earlierLink.steps.map((/** @type {any} */ step) => step.sql), ['ALTER TABLE "User" RENAME TO "Person"',
      'ALTER TABLE "Label_User" RENAME TO "Label_Person"', 'ALTER TABLE "Label_Person" RENAME COLUMN "User_key" TO "Person_key"']);
    for (const earlier of [true, false]) {
      const { dbPath, cleanup } = tempDbPath();
      try {
        const store = await openStore(MODEL, { driver: nodeDriver(), path: dbPath });
        try { await seed(store); }
        finally { await store.close(); }
        if (earlier) {
          asEarlier(dbPath);
          assert.deepStrictEqual((await migrate({ driver: nodeDriver(), path: dbPath }, [earlierLink], { baseline: MODEL, model: renamed })).applied, ['rename']);
          const reopened = await openStore(renamed, { driver: nodeDriver(), path: dbPath });
          await reopened.close();
          continue;
        }
        // the index keeps the name it was created under, which the renamed table does not declare
        await assert.rejects(async () => migrate({ driver: nodeDriver(), path: dbPath }, [earlierLink], { baseline: MODEL, model: renamed }),
          { code: 'JD0023', message: /unexpected index:Label_User_User_key/ });
        assert.deepStrictEqual(sqliteIndexes(dbPath), ['Label_User_User_key']);
      }
      finally { cleanup(); }
    }
  });

  for (const earlier of [false, true]) {
    it(`a renamed endpoint's join table takes the index under its new name${earlier ? ', one it never had included' : ''}`, async () => {
      const renamed = { $model: '0.1', entities: { Person: { 'x-rename': 'User', ...entity('id', { labels: many('Label') }) }, Label: entity('name', { color: { type: 'string' } }) } };
      const { dbPath, cleanup } = tempDbPath();
      try {
        const store = await openStore(MODEL, { driver: nodeDriver(), path: dbPath });
        try { await seed(store); }
        finally { await store.close(); }
        if (earlier) asEarlier(dbPath);
        const { migration } = planModelMigration(MODEL, renamed, { dialect: sqliteDialect, id: 'rename' });
        assert.deepStrictEqual(migration.steps.slice(-2).map((/** @type {any} */ step) => step.sql), [
          'DROP INDEX IF EXISTS "Label_User_User_key"', 'CREATE INDEX "Label_Person_Person_key" ON "Label_Person" ("Person_key")']);
        await migrate({ driver: nodeDriver(), path: dbPath }, [migration], { baseline: MODEL, model: renamed });
        const raw = new DatabaseSync(dbPath, { readOnly: true });
        try {
          assert.deepStrictEqual(raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'Label_Person' AND sql IS NOT NULL").all()
            .map((row) => row.name), ['Label_Person_Person_key']);
        }
        finally { raw.close(); }
        const reopened = await openStore(renamed, { driver: nodeDriver(), path: dbPath });
        try {
          assert.deepStrictEqual(await reopened.execute({ $for: { j: '$.Label_Person[*]' }, $where: { $eq: ['$j.Person_key', 'u1'] }, $return: '$j.Label_key' }),
            ['admin', 'dev']);
        }
        finally { await reopened.close(); }
      }
      finally { cleanup(); }
    });
  }
});

describe('the index name', () => {
  it('is <table>_<column>, or the table clipped beside a hash where PostgreSQL would truncate it', () => {
    const postgres = postgresDialect();
    assert.strictEqual(joinIndexName(postgres, 'Label_User', 'User_key'), 'Label_User_User_key');
    const long = 'memberships_of_users_and_the_labels_each_of_them_holds_now';
    assert.strictEqual(joinIndexName(sqliteDialect, long, 'User_key'), `${long}_User_key`);
    const clipped = joinIndexName(postgres, long, 'User_key');
    assert.ok(Buffer.byteLength(clipped) <= 63 && clipped !== joinIndexName(postgres, long, 'Label_key'), clipped);
    assert.strictEqual(clipped, 'memberships_of_users_and_the_labels_each_of_them_holds_n_yqoznj');
    // a clip at a character boundary: no split multi-byte character
    const wide = `${'é'.repeat(28)}_x`;
    assert.ok(Buffer.byteLength(joinIndexName(postgres, wide, 'User_key')) <= 63);
    assert.doesNotMatch(joinIndexName(postgres, wide, 'User_key'), /�/);
  });
});

for (const engine of ENGINES.filter((name) => name === 'postgres')) {
  describe('the index over a join table\'s second key column on PostgreSQL', { skip: skipFor(engine) }, () => {
    it('a fresh store creates it and a read by the second column seeks it; one without it opens, and the upgrade creates it', () => withPostgres(async ({ pool, schema, driver }) => {
      /** @param {any} store */
      const plan = async (store) => {
        const admin = await pool.connect();
        try {
          // costed with sequential scans off: the index is usable, not merely unchosen
          await admin.query('BEGIN');
          await admin.query(`SET LOCAL search_path TO "${schema}"`);
          await admin.query('SET LOCAL enable_seqscan = off');
          const rows = (await admin.query({ text: `EXPLAIN ${(await store.explain(BY_USER)).sql}`, values: ['u1'] })).rows;
          return rows.map((/** @type {any} */ row) => row['QUERY PLAN']).join('\n');
        }
        finally {
          await admin.query('ROLLBACK');
          admin.release();
        }
      };
      const indexes = async () => (await pool.query({ text: 'SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = $2 ORDER BY indexname',
        values: [schema, 'Label_User'] })).rows.map((/** @type {any} */ row) => row.indexname);
      let store = await openStore(MODEL, { driver: driver() });
      try {
        await seed(store);
        assert.deepStrictEqual(await answers(store), EXPECTED);
        assert.match(await plan(store), /(Index (Only )?Scan (using|on)|Bitmap Index Scan on) "Label_User_User_key"/);
      }
      finally { await store.close(); }
      assert.deepStrictEqual(await indexes(), ['Label_User_User_key', 'Label_User_pkey']);
      await pool.query(`DROP INDEX "${schema}"."Label_User_User_key"`);
      store = await openStore(MODEL, { driver: driver() });
      try {
        assert.deepStrictEqual(await answers(store), EXPECTED);
        assert.doesNotMatch(await plan(store), /Label_User_User_key/);
      }
      finally { await store.close(); }
      const upgradeOn = async () => {
        const connection = await driver().open();
        try { return await planColumnUpgrade(connection, MODEL); }
        finally { await connection.close(); }
      };
      const { migration, report } = await upgradeOn();
      assert.deepStrictEqual(report.upgraded, ['Label_User.Label_User_User_key']);
      assert.deepStrictEqual(migration.steps.map((/** @type {any} */ step) => step.sql), [INDEX_SQL]);
      assert.deepStrictEqual((await migrate({ driver: driver() }, [migration], { baseline: MODEL, model: MODEL, shadow: false })).applied, [migration.id]);
      assert.deepStrictEqual(await indexes(), ['Label_User_User_key', 'Label_User_pkey']);
      const again = await upgradeOn();
      assert.deepStrictEqual([again.migration.steps, again.report.upgraded], [[], []]);
    }));

    // an in-place rename (User to Person keeps the endpoint order), and a rebuild where the order flips
    // (Item to Thing beside Tag_Group), under an implicit join table name and under a `through` name
    const flipped = (/** @type {string} */ name, /** @type {string | undefined} */ through) => ({ $model: '0.1', entities: {
      [name]: { ...(name === 'Item' ? {} : { 'x-rename': 'Item' }), ...entity('id', { tags: many('Tag_Group', through) }) }, Tag_Group: entity('id') } });
    const renames = [
      { label: 'renamed in place', from: MODEL, to: { $model: '0.1', entities: { Person: { 'x-rename': 'User', ...entity('id', { labels: many('Label') }) }, Label: entity('name', { color: { type: 'string' } }) } },
        join: 'Label_Person', index: 'Label_Person_Person_key', seedOf: seed, read: { $for: { j: '$.Label_Person[*]' }, $where: { $eq: ['$j.Person_key', 'u1'] }, $return: '$j.Label_key' }, expected: ['admin', 'dev'] },
      { label: 'rebuilt in its endpoint order', from: flipped('Item'), to: flipped('Thing'), join: 'Tag_Group_Thing', index: 'Tag_Group_Thing_Thing_key',
        read: { $for: { j: '$.Tag_Group_Thing[*]' }, $where: { $eq: ['$j.Thing_key', 'i1'] }, $return: '$j.Tag_Group_key' }, expected: ['g1'] },
      { label: 'rebuilt beside itself under a through name', from: flipped('Item', 'Tags'), to: flipped('Thing', 'Tags'), join: 'Tags', index: 'Tags_Thing_key',
        read: { $for: { j: '$.Tags[*]' }, $where: { $eq: ['$j.Thing_key', 'i1'] }, $return: '$j.Tag_Group_key' }, expected: ['g1'] },
    ];
    for (const { label, from, to, join, index, read, expected } of renames) {
      for (const earlier of [false, true]) {
        it(`a join table ${label} takes its index under its final name${earlier ? ', one it never had included' : ''}`, () => withPostgres(async ({ pool, schema, driver }) => {
          const store = await openStore(from, { driver: driver() });
          try {
            if (from === MODEL) await seed(store);
            else {
              await store.entity('Tag_Group').create({ id: 'g1' });
              await store.entity('Item').create({ id: 'i1' });
              await store.saveChanges();
              store.entity('Item').link('i1', 'tags', 'g1');
              await store.saveChanges();
            }
          }
          finally { await store.close(); }
          if (earlier) {
            // the join table's index is the schema's one index beside the primary keys
            const held = (await pool.query({ text: "SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND indexname NOT LIKE '%\\_pkey'", values: [schema] })).rows
              .map((/** @type {any} */ row) => row.indexname);
            assert.strictEqual(held.length, 1);
            await pool.query(`DROP INDEX "${schema}"."${held[0]}"`);
          }
          const { migration } = planModelMigration(from, to, { dialect: postgresDialect(), id: 'rename' });
          assert.deepStrictEqual((await migrate({ driver: driver() }, [migration], { baseline: from, model: to, shadow: false })).applied, ['rename']);
          // the primary key's own index keeps the name of a table renamed in place, as it did before
          const names = (await pool.query({ text: "SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = $2 AND indexname NOT LIKE '%\\_pkey' ORDER BY indexname",
            values: [schema, join] })).rows.map((/** @type {any} */ row) => row.indexname);
          assert.deepStrictEqual(names, [index]);
          const reopened = await openStore(to, { driver: driver() });
          try { assert.deepStrictEqual([await reopened.execute(read)].flat().sort(), expected); }
          finally { await reopened.close(); }
        }));
      }
    }

    it('a join table whose index name PostgreSQL would truncate takes the clipped name, and opens again', () => withPostgres(async ({ pool, schema, driver }) => {
      const through = 'memberships_of_users_and_the_labels_each_of_them_holds_now';
      const model = modelOf(through);
      for (let i = 0; i < 2; i++) {
        const store = await openStore(model, { driver: driver() });
        try {
          if (i === 0) await seed(store);
          assert.deepStrictEqual(await store.execute({ $for: { j: `$.${through}[*]` }, $where: { $eq: ['$j.User_key', 'u1'] }, $return: '$j.Label_key' }),
            ['admin', 'dev']);
        }
        finally { await store.close(); }
      }
      const names = (await pool.query({ text: 'SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = $2 ORDER BY indexname',
        values: [schema, through] })).rows.map((/** @type {any} */ row) => row.indexname);
      assert.deepStrictEqual(names, [joinIndexName(postgresDialect(), through, 'User_key'), `${through}_pkey`].sort());
    }));

    // the link as a release that created no such index planned it: the renames alone
    const RENAMED = renames[0].to;
    const earlierLink = () => {
      const planned = planModelMigration(MODEL, RENAMED, { dialect: postgresDialect(), id: 'rename' }).migration;
      return { ...planned, steps: planned.steps.filter((/** @type {any} */ step) => !/INDEX/.test(step.sql ?? '')) };
    };
    /** The schema's tables and their indexes, from the catalog. @param {any} pool @param {string} schema */
    const catalog = async (pool, schema) => (await pool.query({ text: 'SELECT tablename, indexname FROM pg_indexes WHERE schemaname = $1 ORDER BY 1, 2',
      values: [schema] })).rows.map((/** @type {any} */ row) => `${row.tablename}.${row.indexname}`);

    it('a rename link planned without the index is refused before it commits over a join table that has it, and applies over one that never had it', () => withPostgres(async ({ pool, schema, driver }) => {
      const link = earlierLink();
      assert.deepStrictEqual(link.steps.map((/** @type {any} */ step) => step.sql), ['ALTER TABLE "User" RENAME TO "Person"',
        'ALTER TABLE "Label_User" RENAME TO "Label_Person"', 'ALTER TABLE "Label_Person" RENAME COLUMN "User_key" TO "Person_key"']);
      const store = await openStore(MODEL, { driver: driver() });
      try { await seed(store); }
      finally { await store.close(); }
      const before = await catalog(pool, schema);
      assert.deepStrictEqual(before, ['Label.Label_pkey', 'Label_User.Label_User_User_key', 'Label_User.Label_User_pkey', 'User.User_pkey']);
      await assert.rejects(async () => migrate({ driver: driver() }, [link], { baseline: MODEL, model: RENAMED, shadow: false }), {
        code: 'JD0023',
        message: /the migrated shape does not equal the target model's: entity 'Label_Person': 1 declared indexes exist, the model declares 0 — the database has Label_User_User_key, which the model does not declare; the next open would refuse the table \(JD0002\), so nothing was changed: plan the link again with this release/,
      });
      // nothing changed: no table renamed, no history written
      assert.deepStrictEqual(await catalog(pool, schema), before);
      const reopened = await openStore(MODEL, { driver: driver() });
      try { assert.deepStrictEqual(await answers(reopened), EXPECTED); }
      finally { await reopened.close(); }
      // the same link over a join table without the index applies, and the store opens under the renamed model
      await pool.query(`DROP INDEX "${schema}"."Label_User_User_key"`);
      assert.deepStrictEqual((await migrate({ driver: driver() }, [link], { baseline: MODEL, model: RENAMED, shadow: false })).applied, ['rename']);
      const renamed = await openStore(RENAMED, { driver: driver() });
      try { assert.deepStrictEqual([await renamed.execute(renames[0].read)].flat().sort(), ['admin', 'dev']); }
      finally { await renamed.close(); }
    }));

    // links that leave every join table as the open accepts it keep applying, over a join table with the index and one without
    const links = [
      { label: 'indexes another table', to: (() => { const next = structuredClone(MODEL); next.entities.Label.schema.properties.color = { type: 'string', 'x-entity': { index: true } }; return next; })(),
        tables: ['Label', 'Label_User', 'User'] },
      { label: 'adds a many-to-many edge', to: { $model: '0.1', entities: { User: entity('id', { labels: many('Label'), tags: many('Tag') }), Label: entity('name', { color: { type: 'string' } }), Tag: entity('id') } },
        tables: ['Label', 'Label_User', 'Tag', 'Tag_User', 'User'] },
      { label: 'drops a many-to-many edge', to: { $model: '0.1', entities: { User: entity('id'), Label: entity('name', { color: { type: 'string' } }) } },
        tables: ['Label', 'User'] },
    ];
    it('a link that leaves a join table the model declares to the open, which creates it, applies', () => withPostgres(async ({ pool, schema, driver }) => {
      const store = await openStore(MODEL, { driver: driver() });
      try { await seed(store); }
      finally { await store.close(); }
      const { to } = links[1];
      const planned = planModelMigration(MODEL, to, { dialect: postgresDialect(), id: 'next' }).migration;
      const migration = { ...planned, steps: planned.steps.filter((/** @type {any} */ step) => step.draft !== true && !/Tag_User/.test(step.sql ?? '')) };
      assert.deepStrictEqual((await migrate({ driver: driver() }, [migration], { baseline: MODEL, model: to, shadow: false })).applied, ['next']);
      assert.ok(!(await catalog(pool, schema)).some((name) => name.startsWith('Tag_User.')));
      const reopened = await openStore(to, { driver: driver() });
      try { assert.deepStrictEqual(await answers(reopened), EXPECTED); }
      finally { await reopened.close(); }
      assert.ok((await catalog(pool, schema)).includes('Tag_User.Tag_User_User_key'));
    }));

    for (const { label, to, tables } of links) {
      for (const earlier of [false, true]) {
        it(`a link that ${label} applies over a join table ${earlier ? 'without' : 'with'} the index`, () => withPostgres(async ({ pool, schema, driver }) => {
          const store = await openStore(MODEL, { driver: driver() });
          try { await seed(store); }
          finally { await store.close(); }
          if (earlier) await pool.query(`DROP INDEX "${schema}"."Label_User_User_key"`);
          const planned = planModelMigration(MODEL, to, { dialect: postgresDialect(), id: 'next' }).migration;
          // an edge member added or dropped changes no stored document: its draft transform is a pure widening
          const migration = { ...planned, steps: planned.steps.filter((/** @type {any} */ step) => step.draft !== true) };
          assert.deepStrictEqual((await migrate({ driver: driver() }, [migration], { baseline: MODEL, model: to, shadow: false })).applied, ['next']);
          const held = new Set((await catalog(pool, schema)).map((name) => name.split('.')[0]).filter((name) => !name.startsWith('_jaren')));
          assert.deepStrictEqual([...held].sort(), tables);
          const reopened = await openStore(to, { driver: driver() });
          await reopened.close();
        }));
      }
    }
  });
}
