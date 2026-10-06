//@ts-check
/**
 * @file Real CLI no-pending acceptance: a completed directory is not proof
 * that the requested endpoint or current physical database is correct.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { openStore, planModelMigration, planPhysicalMigration, migrate, readSchema, sqliteDialect } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { removeTempDirectory } from './helpers.js';

const CLI = resolve('packages/db/src/cli.js');
const BASELINE = { $model: '0.1', entities: { User: { schema: {
  type: 'object', required: ['id', 'name', 'revision'], additionalProperties: false,
  properties: { id: { type: 'string', 'x-entity': { key: true } },
    name: { type: 'string' }, revision: { type: 'integer' } },
} } } };
const TARGET = structuredClone(BASELINE);
TARGET.entities.User.schema.properties.age = { type: 'integer' };

/** @param {boolean} applied @param {boolean} [physical] */
async function fixture(applied, physical = false) {
  const dir = mkdtempSync(join(tmpdir(), 'jaren-db-cli-accept-'));
  const file = (/** @type {string} */ name) => join(dir, name);
  const write = (/** @type {string} */ name, /** @type {any} */ value) => {
    writeFileSync(file(name), JSON.stringify(value));
    return file(name);
  };
  mkdirSync(file('migrations'));
  write('baseline.json', BASELINE);
  const targetModel = applied && !physical ? TARGET : BASELINE;
  write('model.json', targetModel);
  const store = await openStore(BASELINE, { driver: nodeDriver(), path: file('app.db') });
  await store.entity('User').create({ id: 'u1', name: 'Ada', revision: 7 });
  await store.close();
  if (applied) {
    let migration;
    if (physical) {
      const connection = await nodeDriver().open(file('app.db'), {});
      try {
        const objects = readSchema(connection, { tables: ['User'] }).objects;
        migration = planPhysicalMigration(connection, BASELINE, BASELINE, {
          id: '0000-physical', steps: [], scope: { tables: ['User'] },
          dispositions: Object.fromEntries(objects.map((/** @type {any} */ object) => [`${object.type}:${object.name}`, 'preserve'])),
          physicalTarget: { objects, tables: ['User'] },
        });
      }
      finally { connection.close(); }
    }
    else migration = planModelMigration(BASELINE, TARGET, { dialect: sqliteDialect, id: '0001-age' }).migration;
    write('migrations/0001.json', migration);
    await migrate({ driver: nodeDriver(), path: file('app.db') }, [migration], {
      baseline: BASELINE, model: targetModel, ...(physical ? { shadow: false } : {}),
    });
  }
  const inspect = () => {
    const raw = new DatabaseSync(file('app.db'));
    try {
      const schema = raw.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY name').all();
      const rows = raw.prepare('SELECT * FROM "User" ORDER BY id').all();
      const history = schema.some((row) => row.name === '_jaren_migrations')
        ? raw.prepare('SELECT rowid, * FROM "_jaren_migrations" ORDER BY rowid').all() : [];
      return { schema, rows, history, bytes: createHash('sha256').update(readFileSync(file('app.db'))).digest('hex') };
    }
    finally { raw.close(); }
  };
  const run = (/** @type {string[]} */ extra = [], includeModel = true) => spawnSync(process.execPath,
    ['--no-warnings=ExperimentalWarning', CLI, 'apply', '--store', file('app.db'), '--baseline', file('baseline.json'),
      '--migrations', file('migrations'), ...(includeModel ? ['--model', file('model.json')] : []), ...extra],
    { encoding: 'utf8' });
  const drift = () => {
    const raw = new DatabaseSync(file('app.db'));
    try { raw.exec('CREATE INDEX unexpected ON "User" (name)'); }
    finally { raw.close(); }
  };
  return { write, inspect, run, drift, targetModel,
    cleanup: () => removeTempDirectory(dir) };
}

describe('CLI no-pending migration acceptance', () => {
  for (const applied of [false, true]) {
    const state = applied ? 'applied history' : 'empty chain';
    it(`${state}: a different model endpoint with the same physical shape refuses`, async () => {
      const work = await fixture(applied);
      try {
        const different = structuredClone(work.targetModel);
        different.entities.User.schema.properties.name.maxLength = 12;
        work.write('model.json', different);
        const before = work.inspect();
        const result = work.run(['--yes']);
        assert.equal(result.status, 1, result.stdout);
        assert.match(result.stderr, /target model/);
        assert.doesNotMatch(result.stdout, /up to date|applied:/);
        assert.deepEqual(work.inspect(), before, 'refusal changes no schema, rows, revisions, history or database bytes');
      }
      finally { work.cleanup(); }
    });

    it(`${state}: physical drift refuses a matching model endpoint`, async () => {
      const work = await fixture(applied);
      try {
        work.drift();
        const before = work.inspect();
        const result = work.run(['--yes']);
        assert.equal(result.status, 1, result.stdout);
        assert.match(result.stderr, /drift.*unexpected/);
        assert.doesNotMatch(result.stdout, /up to date|applied:/);
        assert.deepEqual(work.inspect(), before);
      }
      finally { work.cleanup(); }
    });

    it(`${state}: a valid repeat preserves rows, revisions, exact history and database bytes`, async () => {
      const work = await fixture(applied);
      try {
        const before = work.inspect();
        assert.equal(before.rows[0].revision, 7);
        assert.equal(before.history.length, applied ? 1 : 0);
        for (let repeat = 0; repeat < 2; repeat++) {
          // A no-op does not acquire consent for an absent pending write.
          const result = work.run();
          assert.equal(result.status, 0, result.stderr);
          assert.match(result.stdout, /nothing to apply — up to date/);
          assert.deepEqual(work.inspect(), before);
        }
      }
      finally { work.cleanup(); }
    });

    it(`${state}: dry-run remains a printout without target acceptance or writes`, async () => {
      const work = await fixture(applied);
      try {
        const different = structuredClone(work.targetModel);
        different.entities.User.schema.properties.name.maxLength = 12;
        work.write('model.json', different);
        work.drift();
        const before = work.inspect();
        const result = work.run(['--dry-run']);
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /nothing to apply/);
        assert.doesNotMatch(result.stdout, /up to date|applied:/, 'a printout is not a target-acceptance verdict');
        assert.deepEqual(work.inspect(), before);
      }
      finally { work.cleanup(); }
    });
  }

  it('a saved physical target refuses drift even when --model is omitted', async () => {
    const work = await fixture(true, true);
    try {
      const before = work.inspect();
      const current = work.run(['--yes'], false);
      assert.equal(current.status, 0, current.stderr);
      assert.match(current.stdout, /nothing to apply — up to date/);
      assert.deepEqual(work.inspect(), before);
      work.drift();
      const drifted = work.inspect();
      const result = work.run(['--yes'], false);
      assert.equal(result.status, 1, result.stdout);
      assert.match(result.stderr, /drift.*unexpected/);
      assert.doesNotMatch(result.stdout, /up to date|applied:/);
      assert.deepEqual(work.inspect(), drifted);
    }
    finally { work.cleanup(); }
  });

  it('a pending draft still prints without replay, target acceptance or writes', async () => {
    const work = await fixture(false);
    try {
      const target = structuredClone(TARGET);
      target.entities.User.schema.required.push('age');
      const migration = planModelMigration(BASELINE, target, { dialect: sqliteDialect, id: '0001-draft' }).migration;
      assert.ok(migration.steps.some((step) => step.draft === true));
      work.write('model.json', target);
      work.write('migrations/0001.json', migration);
      const before = work.inspect();
      const result = work.run(['--dry-run']);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /pending: 0001-draft/);
      assert.match(result.stdout, /DRAFT/);
      assert.doesNotMatch(result.stdout, /up to date|applied:/);
      assert.deepEqual(work.inspect(), before);
    }
    finally { work.cleanup(); }
  });
});
