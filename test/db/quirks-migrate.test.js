//@ts-check
/**
 * @file Regressions for the migration quirks a reading of the runner,
 * the planner and the CLI found: an entity migrates WHOLE (the
 * real-data check, a `jslt` transform and a `query` assertion all see
 * its mapped columns); planning a model against itself with its
 * `x-rename` hint still in place yields nothing and moves no hash; a
 * rebuild folds an absent column as absent and names an inferred
 * foreign key it loses; a parent with RESTRICT children is dropped
 * after them; a join table takes its endpoints from the mapping and
 * never from splitting its name; the artifact describes every step
 * kind the runner accepts; a dry run writes nothing at all; and the
 * CLI keeps §11's defaults. Every entity-path fix is pinned twice —
 * two plans are one document, two applies are one migration.
 */

import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

import {
  openStore, planModelMigration, migrate, migrationStatus, sqliteDialect, shapeHash,
} from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { JarenValidator } from '@jarenjs/validate';
import { compileArtifact } from '../json/schema-artifact-helpers.js';

const ent = (props, required = ['id']) => ({
  schema: { type: 'object', required, properties: { id: { type: 'string', 'x-entity': { key: true } }, ...props } },
});
const model = (entities) => ({ $model: '0.1', entities });
const compileSchema = (schema) => {
  const validate = new JarenValidator({ collectErrors: true }).compile(schema);
  return (doc) => validate(doc);
};
const applied = (migration) => ({ ...migration, steps: migration.steps.filter((step) => step.draft !== true) });

let dir;
const fresh = (name) => {
  const file = path.join(dir, `${name}.db`);
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(file + suffix, { force: true });
  return file;
};
before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jaren-db-quirks-')); });
after(() => { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

describe('an entity migrates whole', () => {
  const FROM = model({ User: ent({ name: { type: 'string' } }, ['id', 'name']) });

  it('a pure widening of an entity whose required members are columns lands under compileSchema', async () => {
    const to = model({ User: ent({ name: { type: 'string' }, age: { type: 'integer' } }, ['id', 'name']) });
    const file = fresh('widening');
    const store = await openStore(FROM, { driver: nodeDriver(), path: file });
    await store.entity('User').create({ id: 'u1', name: 'ada' });
    await store.close();
    const { migration } = planModelMigration(FROM, to, { dialect: sqliteDialect, id: 'm1' });
    const outcome = await migrate({ driver: nodeDriver(), path: file }, [applied(migration)],
      { baseline: FROM, model: to, compileSchema });
    assert.deepStrictEqual(outcome.applied, ['m1']);
    // and the narrowing the check is FOR is still refused
    const narrower = model({ User: ent({ name: { type: 'string', minLength: 10 } }, ['id', 'name']) });
    const { migration: m2 } = planModelMigration(to, narrower, { dialect: sqliteDialect, id: 'm2' });
    await assert.rejects(migrate({ driver: nodeDriver(), path: file }, [applied(migration), applied(m2)],
      { baseline: FROM, model: narrower, compileSchema }), (e) => e.code === 'JD0021');
  });

  it('a jslt transform reads and writes mapped columns; a query assertion sees them', async () => {
    const to = model({ User: ent({ name: { type: 'string' }, idSeen: { type: 'string' } }, ['id', 'name']) });
    const file = fresh('transform');
    const store = await openStore(FROM, { driver: nodeDriver(), path: file });
    await store.entity('User').create({ id: 'u1', name: 'ada' });
    await store.close();
    const transform = {
      $migration: '0.1', id: 't1', from: shapeHash(FROM), to: shapeHash(to),
      steps: [
        { kind: 'ddl', sql: 'ALTER TABLE "User" ADD COLUMN "idSeen" TEXT' },
        { kind: 'query', collection: 'User', assert: { $for: { it: '$[*]' }, $where: { $empty: '$it.id' }, $return: '$it' } },
        { kind: 'jslt', collection: 'User', stylesheet: [{ match: '$', body: { idSeen: '$.id', name: { $upper: '$.name' } } }] },
      ],
    };
    await migrate({ driver: nodeDriver(), path: file }, [transform], { baseline: FROM, model: to, compileSchema });
    const migrated = await openStore(to, { driver: nodeDriver(), path: file });
    assert.deepStrictEqual(await migrated.entity('User').get('u1'), { id: 'u1', name: 'ADA', idSeen: 'u1' });
    await migrated.close();
    // two-run: the recorded migration is skipped, so the transform does
    // not run over its own output (a second $upper is invisible, but a
    // second $concat or increment would not be)
    const again = await migrate({ driver: nodeDriver(), path: file }, [transform], { baseline: FROM, model: to, compileSchema });
    assert.deepStrictEqual({ applied: again.applied, skipped: again.skipped, upToDate: again.upToDate },
      { applied: [], skipped: ['t1'], upToDate: true });
    const raw = new DatabaseSync(file);
    assert.deepStrictEqual({ ...raw.prepare('SELECT "name", "idSeen", json("doc") AS d FROM "User"').get() },
      { name: 'ADA', idSeen: 'u1', d: '{}' }, 'the column is written, and the document keeps no shadow copy');
    raw.close();
  });
});

describe('planning is idempotent under a declared rename', () => {
  it('a model still carrying its x-rename hint plans nothing against itself, and hashes as the hint-free model', () => {
    const m1 = model({ Person: ent({ name: { type: 'string' } }) });
    const m2 = model({ Member: { 'x-rename': 'Person', ...ent({ name: { type: 'string' } }) } });
    const m3 = model({ Member: ent({ name: { type: 'string' } }) });
    assert.deepStrictEqual(planModelMigration(m1, m2, { dialect: sqliteDialect, id: 'r' }).migration.steps.map((s) => s.sql),
      ['ALTER TABLE "Person" RENAME TO "Member"']);
    assert.deepStrictEqual(planModelMigration(m2, m2, { dialect: sqliteDialect, id: 'r2' }).migration.steps, []);
    assert.deepStrictEqual(planModelMigration(m2, m3, { dialect: sqliteDialect, id: 'r3' }).migration.steps, []);
    assert.strictEqual(shapeHash(m2), shapeHash(m3));
    // a collection hint behaves the same way
    const c1 = { $model: '0.1', collections: { people: { schema: { type: 'object' }, identity: 'uuid' } } };
    const c2 = { $model: '0.1', collections: { members: { 'x-rename': 'people', schema: { type: 'object' }, identity: 'uuid' } } };
    assert.strictEqual(planModelMigration(c1, c2, { dialect: sqliteDialect, id: 'c' }).migration.steps.length, 1);
    assert.deepStrictEqual(planModelMigration(c2, c2, { dialect: sqliteDialect, id: 'c2' }).migration.steps, []);
  });
});

describe('the rebuild keeps the absent-vs-null rule and names what it loses', () => {
  it('an absent column folds back as absent, not as JSON null', async () => {
    const from = model({ User: ent({ name: { type: 'string' }, age: { type: 'integer' } }) });
    const to = model({ User: ent({ name: { type: 'string', 'x-entity': { column: 'json' } }, age: { type: 'string' } }) });
    const file = fresh('fold');
    const store = await openStore(from, { driver: nodeDriver(), path: file });
    await store.entity('User').create({ id: 'u1', age: 1 });
    await store.close();
    const { migration } = planModelMigration(from, to, { dialect: sqliteDialect, id: 'f' });
    assert.deepStrictEqual(migration.steps.map((s) => s.kind), ['rebuild', 'jslt']);
    await migrate({ driver: nodeDriver(), path: file }, [applied(migration)], { baseline: from, model: to, compileSchema });
    const migrated = await openStore(to, { driver: nodeDriver(), path: file });
    assert.deepStrictEqual(await migrated.entity('User').get('u1'), { id: 'u1', age: '1' });
    await migrated.close();
  });

  it('an inferred foreign-key column dropped by a rebuild is reported destructive, and folds in when the target declares it', async () => {
    const post = (extra) => ({ schema: { type: 'object', required: ['pid'], properties: { pid: { type: 'integer', 'x-entity': { key: true } }, title: { type: 'string' }, ...extra } } });
    const from = model({ User: ent({ posts: { 'x-entity': { relation: { to: 'Post', many: true, via: 'authorId', onDelete: 'cascade' } } } }), Post: post({}) });
    const dropped = model({ User: ent({}), Post: post({}) });
    const kept = model({ User: ent({}), Post: post({ authorId: { type: 'string', 'x-entity': { column: 'json' } } }) });
    const seed = async (file) => {
      const store = await openStore(from, { driver: nodeDriver(), path: file });
      await store.entity('User').create({ id: 'u1' });
      await store.entity('Post').create({ pid: 1, title: 't', authorId: 'u1' });
      await store.close();
    };
    const lost = fresh('fk-lost');
    await seed(lost);
    const plan1 = planModelMigration(from, dropped, { dialect: sqliteDialect, id: 'd' });
    assert.strictEqual(plan1.report.destructive, true);
    assert.ok(plan1.migration.steps.some((s) => /DESTRUCTIVE.*authorId/.test(s.note ?? '')), 'the lost column is named');
    const folded = fresh('fk-kept');
    await seed(folded);
    const plan2 = planModelMigration(from, kept, { dialect: sqliteDialect, id: 'k' });
    assert.strictEqual(plan2.report.destructive, false);
    await migrate({ driver: nodeDriver(), path: folded }, [applied(plan2.migration)], { baseline: from, model: kept });
    const migrated = await openStore(kept, { driver: nodeDriver(), path: folded });
    assert.deepStrictEqual(await migrated.entity('Post').get(1), { pid: 1, title: 't', authorId: 'u1' });
    await migrated.close();
  });

  it('a parent with RESTRICT children is dropped after them', async () => {
    const from = model({
      User: ent({}),
      Post: { schema: { type: 'object', required: ['pid'], properties: { pid: { type: 'integer', 'x-entity': { key: true } }, author: { 'x-entity': { relation: { to: 'User', via: 'authorId', onDelete: 'restrict' } } } } } },
    });
    const to = model({ Other: ent({}) });
    const file = fresh('drop-order');
    const store = await openStore(from, { driver: nodeDriver(), path: file });
    await store.entity('User').create({ id: 'u1' });
    await store.entity('Post').create({ pid: 1, authorId: 'u1' });
    await store.close();
    const { migration } = planModelMigration(from, to, { dialect: sqliteDialect, id: 'o' });
    assert.deepStrictEqual(migration.steps.map((s) => s.sql), [
      'CREATE TABLE "Other" ("id" TEXT PRIMARY KEY, "doc" BLOB NOT NULL) STRICT',
      'DROP TABLE "Post"',
      'DROP TABLE "User"',
    ]);
    assert.deepStrictEqual((await migrate({ driver: nodeDriver(), path: file }, [applied(migration)], { baseline: from, model: to })).applied, ['o']);
  });
});

describe('the artifact describes every step kind', () => {
  const validate = {
    latest: compileArtifact(JSON.parse(fs.readFileSync('packages/db/schemas/jaren-migration.schema.json', 'utf8'))),
    draft7: compileArtifact(JSON.parse(fs.readFileSync('packages/db/schemas/jaren-migration.draft-07.schema.json', 'utf8'))),
  };

  it("the planner's rebuild and sql steps validate against both artifacts", () => {
    const from = model({ User: ent({ bio: { type: 'string' }, age: { type: 'integer' } }) });
    const toggled = model({ User: ent({ bio: { type: 'string', 'x-entity': { column: 'json' } }, age: { type: 'integer' } }) });
    const retyped = model({ User: ent({ bio: { type: 'string' }, age: { type: 'string' } }) });
    const plans = [planModelMigration(from, toggled, { dialect: sqliteDialect, id: 'a' }), planModelMigration(from, retyped, { dialect: sqliteDialect, id: 'b' })];
    assert.deepStrictEqual(plans.map((p) => p.migration.steps.map((s) => s.kind)), [['sql', 'ddl'], ['rebuild', 'jslt']]);
    for (const { migration } of plans) {
      assert.strictEqual(validate.latest(migration), true, JSON.stringify(migration.steps.map((s) => s.kind)));
      assert.strictEqual(validate.draft7(migration), true);
    }
    assert.strictEqual(validate.latest({ ...plans[0].migration, steps: [{ kind: 'sql' }] }), false, 'a sql step needs its text');
    assert.strictEqual(validate.latest({ ...plans[1].migration, steps: [{ kind: 'rebuild', table: 'User' }] }), false, 'a rebuild needs its rendered parts');
  });
});

describe('the CLI keeps §11', () => {
  const CLI = path.resolve('packages/db/src/cli.js');
  const run = (...args) => spawnSync(process.execPath, ['--no-warnings=ExperimentalWarning', CLI, ...args], { encoding: 'utf8' });
  const FROM = model({ User: ent({ name: { type: 'string' } }) });
  const TO = model({ User: ent({ name: { type: 'string' }, age: { type: 'integer' } }) });
  const TO2 = model({ User: ent({ name: { type: 'string' }, age: { type: 'integer' }, bio: { type: 'string' } }) });

  it('plan --store works after an apply; a non-TTY apply needs --yes; check needs --model', async () => {
    const files = {};
    for (const [name, doc] of [['v1', FROM], ['v2', TO], ['v3', TO2]]) {
      files[name] = path.join(dir, `cli-${name}.json`);
      fs.writeFileSync(files[name], JSON.stringify(doc));
    }
    const store = path.join(dir, 'cli-app.db');
    const migrations = path.join(dir, 'cli-migrations');
    fs.mkdirSync(migrations, { recursive: true });
    const opened = await openStore(FROM, { driver: nodeDriver(), path: store });
    await opened.entity('User').create({ id: 'u1', name: 'ada' });
    await opened.close();
    const planned = run('plan', '--from', files.v1, '--to', files.v2, '--id', '001', '--out', path.join(migrations, '001.json'));
    assert.strictEqual(planned.status, 0, planned.stderr);
    // the draft the widening does not need
    const doc = JSON.parse(fs.readFileSync(path.join(migrations, '001.json'), 'utf8'));
    fs.writeFileSync(path.join(migrations, '001.json'), JSON.stringify(applied(doc)));
    const dry = run('apply', '--store', store, '--baseline', files.v1, '--migrations', migrations, '--model', files.v2);
    assert.strictEqual(dry.status, 1, 'a non-TTY apply without --yes applies nothing');
    assert.match(dry.stderr, /--yes/);
    assert.match(dry.stdout, /ALTER TABLE/, 'and prints the statements it did not run');
    assert.strictEqual(run('status', '--store', store, '--baseline', files.v1, '--migrations', migrations).stdout.includes('pending:  001'), true);
    const yes = run('apply', '--store', store, '--baseline', files.v1, '--migrations', migrations, '--model', files.v2, '--yes');
    assert.strictEqual(yes.status, 0, yes.stderr);
    // the from-model is verified against the SHAPE, applied history or not
    const next = run('plan', '--from', files.v2, '--to', files.v3, '--store', store, '--id', '002');
    assert.strictEqual(next.status, 0, next.stderr);
    const wrong = run('plan', '--from', files.v1, '--to', files.v3, '--store', store, '--id', '002');
    assert.strictEqual(wrong.status, 1);
    assert.match(wrong.stderr, /does not match the from-model/);
    const check = run('check', '--store', store, '--baseline', files.v1, '--migrations', migrations);
    assert.strictEqual(check.status, 1);
    assert.match(check.stderr, /--model/);
    assert.strictEqual(run('check', '--store', store, '--baseline', files.v1, '--migrations', migrations, '--model', files.v2).status, 0);
  });
});

describe('a join table takes its endpoints from the mapping, never from its name', () => {
  // splitting the table name on '_' guessed wrong for an entity whose
  // own name carries one, and for a `through` name that spells neither
  // endpoint: the rename moved the table to a name nothing declared,
  // built the declared one empty, and dropped the memberships as
  // "destructive" — the endpoints are read off `mapping.joinTables`
  const many = (to, through) => ({ 'x-entity': { relation: { to, many: true, ...(through === undefined ? {} : { through }) } } });
  const FROM = model({ Team_Member: ent({ items: many('Work_Item') }), Work_Item: ent({}) });
  const TO = model({ Crew_Member: { 'x-rename': 'Team_Member', ...ent({ items: many('Work_Item') }) }, Work_Item: ent({}) });

  it('an underscored entity name renames its implicit join table and its endpoint column', async () => {
    const { migration, report } = planModelMigration(FROM, TO, { dialect: sqliteDialect, id: 'u1' });
    assert.strictEqual(report.destructive, false);
    assert.deepStrictEqual(migration.steps.map((step) => step.sql), [
      'ALTER TABLE "Team_Member" RENAME TO "Crew_Member"',
      'ALTER TABLE "Team_Member_Work_Item" RENAME TO "Crew_Member_Work_Item"',
      'ALTER TABLE "Crew_Member_Work_Item" RENAME COLUMN "Team_Member_key" TO "Crew_Member_key"',
    ]);
    const file = fresh('join-underscore');
    const store = await openStore(FROM, { driver: nodeDriver(), path: file });
    await store.entity('Team_Member').create({ id: 'tm1' });
    await store.entity('Work_Item').create({ id: 'wi1' });
    await store.saveChanges();
    store.entity('Team_Member').link('tm1', 'items', 'wi1');
    await store.saveChanges();
    await store.close();
    await migrate({ driver: nodeDriver(), path: file }, [applied(migration)], { baseline: FROM, model: TO });
    const migrated = await openStore(TO, { driver: nodeDriver(), path: file });
    const [member] = await migrated.entity('Crew_Member').asNoTracking()
      .load({ where: { $eq: ['$it.id', 'tm1'] }, include: { items: true } });
    assert.deepStrictEqual(member.items.map((item) => item.id), ['wi1'], 'the memberships survive the rename');
    await migrated.close();
  });

  it('a `through` name keeps its own name and renames only the endpoint column', async () => {
    const from = model({ Team_Member: ent({ items: many('Work_Item', 'Team_Member_assignments') }), Work_Item: ent({ owners: many('Team_Member', 'Team_Member_assignments') }) });
    const to = model({
      Crew_Member: { 'x-rename': 'Team_Member', ...ent({ items: many('Work_Item', 'Team_Member_assignments') }) },
      Work_Item: ent({ owners: many('Crew_Member', 'Team_Member_assignments') }),
    });
    const { migration, report } = planModelMigration(from, to, { dialect: sqliteDialect, id: 't1' });
    assert.strictEqual(report.destructive, false, 'a rename loses no membership');
    assert.deepStrictEqual(migration.steps.map((step) => step.sql), [
      'ALTER TABLE "Team_Member" RENAME TO "Crew_Member"',
      'ALTER TABLE "Team_Member_assignments" RENAME COLUMN "Team_Member_key" TO "Crew_Member_key"',
    ]);
    const file = fresh('join-through');
    const store = await openStore(from, { driver: nodeDriver(), path: file });
    await store.entity('Team_Member').create({ id: 'tm1' });
    await store.entity('Work_Item').create({ id: 'wi1' });
    await store.saveChanges();
    store.entity('Team_Member').link('tm1', 'items', 'wi1');
    await store.saveChanges();
    await store.close();
    await migrate({ driver: nodeDriver(), path: file }, [applied(migration)], { baseline: from, model: to });
    const raw = new DatabaseSync(file);
    assert.deepStrictEqual(raw.prepare('SELECT * FROM "Team_Member_assignments"').all().map((row) => ({ ...row })),
      [{ Crew_Member_key: 'tm1', Work_Item_key: 'wi1' }]);
    raw.close();
    const migrated = await openStore(to, { driver: nodeDriver(), path: file });
    const [member] = await migrated.entity('Crew_Member').asNoTracking()
      .load({ where: { $eq: ['$it.id', 'tm1'] }, include: { items: true } });
    assert.deepStrictEqual(member.items.map((item) => item.id), ['wi1']);
    await migrated.close();
  });
});

describe('the entity path plans twice to one document and applies twice to one database', () => {
  // one pair per fixed strategy: the fold-back (an absent column stays
  // absent), the inferred foreign key that folds in, the drop order
  // with RESTRICT children, and a plain widening
  const PAIRS = [
    ['widening', model({ User: ent({ name: { type: 'string' } }) }), model({ User: ent({ name: { type: 'string' }, age: { type: 'integer' } }) })],
    ['fold-back', model({ User: ent({ name: { type: 'string' }, age: { type: 'integer' } }) }),
      model({ User: ent({ name: { type: 'string', 'x-entity': { column: 'json' } }, age: { type: 'string' } }) })],
    ['inferred foreign key', model({ User: ent({ posts: { 'x-entity': { relation: { to: 'Post', many: true, via: 'authorId', onDelete: 'cascade' } } } }), Post: { schema: { type: 'object', required: ['pid'], properties: { pid: { type: 'integer', 'x-entity': { key: true } }, title: { type: 'string' } } } } }),
      model({ User: ent({}), Post: { schema: { type: 'object', required: ['pid'], properties: { pid: { type: 'integer', 'x-entity': { key: true } }, title: { type: 'string' }, authorId: { type: 'string', 'x-entity': { column: 'json' } } } } } })],
    ['drop order', model({ User: ent({}), Post: { schema: { type: 'object', required: ['pid'], properties: { pid: { type: 'integer', 'x-entity': { key: true } }, author: { 'x-entity': { relation: { to: 'User', via: 'authorId', onDelete: 'restrict' } } } } } } }),
      model({ Other: ent({}) })],
  ];

  for (const [label, from, to] of PAIRS) {
    it(`${label}: two plans are one document, two applies are one migration`, async () => {
      const first = planModelMigration(from, to, { dialect: sqliteDialect, id: 'x' }).migration;
      const second = planModelMigration(from, to, { dialect: sqliteDialect, id: 'x' }).migration;
      assert.deepStrictEqual(second, first, 'planning is a function of the model pair');
      const file = fresh(`two-run-${label.replace(/\s+/gu, '-')}`);
      const store = await openStore(from, { driver: nodeDriver(), path: file });
      await store.entity('User' in from.entities ? 'User' : 'Other').create({ id: 'u1' });
      if ('Post' in from.entities) await store.entity('Post').create({ pid: 1, title: 't', authorId: 'u1' });
      await store.saveChanges();
      await store.close();
      const chain = [applied(first)];
      const target = { driver: nodeDriver(), path: file };
      assert.deepStrictEqual((await migrate(target, chain, { baseline: from, model: to, compileSchema })).applied, ['x']);
      const shapeAfter = (path) => {
        const raw = new DatabaseSync(path);
        const rows = raw.prepare("SELECT type, name, sql FROM sqlite_schema ORDER BY type, name").all().map((row) => ({ ...row }));
        raw.close();
        return rows;
      };
      const afterFirst = shapeAfter(file);
      const again = await migrate(target, chain, { baseline: from, model: to, compileSchema });
      assert.deepStrictEqual({ applied: again.applied, skipped: again.skipped, upToDate: again.upToDate },
        { applied: [], skipped: ['x'], upToDate: true }, 'the second run applies nothing');
      assert.deepStrictEqual(shapeAfter(file), afterFirst, 'and changes no schema object');
    });
  }
});

describe('a dry run writes nothing', () => {
  const V1 = model({ Thing: ent({}) });
  const V2 = model({ Thing: ent({ n: { type: 'integer' } }) });

  it('§6: the dry run leaves the file byte-identical, history table and all', async () => {
    const file = fresh('dry-run');
    const store = await openStore(V1, { driver: nodeDriver(), path: file });
    await store.entity('Thing').create({ id: 'a' });
    await store.saveChanges();
    await store.close();
    const tablesOf = () => {
      const raw = new DatabaseSync(file);
      const names = raw.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all().map((row) => String(row.name));
      raw.close();
      return names;
    };
    assert.deepStrictEqual(tablesOf(), ['Thing']);
    const { migration } = planModelMigration(V1, V2, { dialect: sqliteDialect, id: 'd1' });
    const before = fs.readFileSync(file);
    const report = await migrate({ driver: nodeDriver(), path: file }, [applied(migration)],
      { baseline: V1, model: V2, dryRun: true });
    assert.deepStrictEqual(report.pending, ['d1']);
    assert.ok(report.statements.some((sql) => /ADD COLUMN "n"/u.test(sql)), 'and still prints what it would run');
    assert.deepStrictEqual(tablesOf(), ['Thing'], 'no history table on a database that had none');
    assert.strictEqual(Buffer.compare(before, fs.readFileSync(file)), 0);

    // the ONE write a reading command makes is migrationStatus's, and it is the documented one
    const status = await migrationStatus({ driver: nodeDriver(), path: file }, [applied(migration)], { baseline: V1 });
    assert.deepStrictEqual(status.pending, ['d1']);
    assert.deepStrictEqual(tablesOf(), ['Thing', '_jaren_migrations']);

    // and a dry run over an APPLIED chain reads the history it finds
    await migrate({ driver: nodeDriver(), path: file }, [applied(migration)], { baseline: V1, model: V2 });
    const after = fs.readFileSync(file);
    const second = await migrate({ driver: nodeDriver(), path: file }, [applied(migration)],
      { baseline: V1, model: V2, dryRun: true });
    assert.deepStrictEqual({ applied: second.applied, skipped: second.skipped, upToDate: second.upToDate },
      { applied: [], skipped: ['d1'], upToDate: true });
    assert.strictEqual(Buffer.compare(after, fs.readFileSync(file)), 0);
  });
});

describe("the shape hash reads a model's OWN entity names", () => {
  // `withoutRenameHints` rebuilds `entities`/`collections` to strip the
  // planning hint. It did so with a plain `stripped[name] = spec`, so an
  // entity named `__proto__` — a legal identifier and a legal JSON member,
  // and what `JSON.parse` of a model FILE hands back as an own property —
  // reassigned the object's prototype instead of becoming a member: the
  // entity vanished from the hash input and the canonicalizer then refused
  // the model the walk had built ("a Object instance is not a JSON object
  // at /entities"), naming the wrong thing. `setObjectMember` is the
  // repository's answer to exactly this, and the two models below hash
  // apart only if the extra entity survives the walk.
  const entity = () => ({
    schema: {
      type: 'object',
      properties: { id: { type: 'string', 'x-entity': { key: true } } },
      required: ['id'],
      additionalProperties: false,
    },
  });
  /** A model as a FILE hands it back: `__proto__` is an own data property. */
  const parsed = (text) => JSON.parse(text);
  const ONE = parsed(JSON.stringify({ $model: '0.1', entities: { U: entity() } }));
  const TWO = parsed(JSON.stringify({
    $model: '0.1',
    entities: { U: entity(), ['__proto__']: entity() },
  }));

  it('hashes a model whose entity is named __proto__, and hashes it apart', () => {
    assert.deepStrictEqual(Object.keys(TWO.entities), ['U', '__proto__']);
    assert.match(shapeHash(TWO), /^[a-z0-9]+$/u);
    assert.notStrictEqual(shapeHash(TWO), shapeHash(ONE),
      'an entity the walk drops would make one MORE entity hash the same');
    assert.strictEqual(shapeHash(TWO), shapeHash(structuredClone(TWO)), 'and hashes stably');
  });

  it('plans that entity like any other, and plans nothing against itself', () => {
    const { migration } = planModelMigration(ONE, TWO, { dialect: sqliteDialect, id: 'p' });
    assert.ok(migration.steps.some((step) => /CREATE TABLE "__proto__"/u.test(step.sql ?? '')),
      `the plan creates the table: ${JSON.stringify(migration.steps.map((s) => s.sql ?? s.kind))}`);
    assert.deepStrictEqual(
      planModelMigration(TWO, TWO, { dialect: sqliteDialect, id: 'q' }).migration.steps, []);
  });

  it('strips an x-rename hint from that entity without losing it', () => {
    const hinted = structuredClone(TWO);
    hinted.entities['__proto__']['x-rename'] = 'Old';
    assert.strictEqual(shapeHash(hinted), shapeHash(TWO),
      'a hint is a planning instruction, not shape — even on this name');
  });
});
