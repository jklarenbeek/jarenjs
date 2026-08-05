//@ts-check
/**
 * @file The jaren-db CLI, driven as a real subprocess: `plan` writes a
 * reviewable document, `check` exits non-zero on pending AND on drift
 * and zero in sync, `apply` prints every statement, refuses
 * destructive work without `--yes` (naming what is lost), and applies
 * with it; `status` names a hand-modified database; `shape` prints
 * the physical mapping.
 */

import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';

const CLI = path.resolve('packages/db/src/cli.js');
const FROM = {
  $model: '0.1',
  entities: {
    User: { schema: { type: 'object', required: ['id'], properties: {
      id: { type: 'string', 'x-entity': { key: true } },
      name: { type: 'string' },
    } } },
  },
};
const TO = structuredClone(FROM);
TO.entities.User.schema.properties.age = { type: 'integer' };
const TO2 = structuredClone(TO);
delete TO2.entities.User.schema.properties.name; // destructive drop

/** @type {string} */
let dir = '';
const fileOf = (name, value) => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
  return file;
};
const run = (...args) => spawnSync(process.execPath,
  ['--no-warnings=ExperimentalWarning', CLI, ...args], { encoding: 'utf8' });

/** @type {Record<string, string>} */
const files = {};

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jaren-db-cli-'));
  files.from = fileOf('model-v1.json', FROM);
  files.to = fileOf('model-v2.json', TO);
  files.to2 = fileOf('model-v3.json', TO2);
  files.store = path.join(dir, 'app.db');
  files.migrations = path.join(dir, 'migrations');
  fs.mkdirSync(files.migrations);
  const store = await openStore(FROM, { driver: nodeDriver(), path: files.store });
  await store.entity('User').create({ id: 'u1', name: 'ada' });
  await store.close();
});
after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('jaren-db', () => {
  it('plan writes a reviewable migration document', () => {
    const out = path.join(files.migrations, '001-add-age.json');
    const result = run('plan', '--from', files.from, '--to', files.to,
      '--store', files.store, '--id', '001-add-age', '--out', out);
    assert.strictEqual(result.status, 0, result.stderr);
    const migration = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.strictEqual(migration.id, '001-add-age');
    assert.ok(migration.steps.some((s) => /ADD COLUMN "age"/.test(s.sql ?? '')));
    assert.ok(migration.steps.some((s) => s.draft === true),
      'the schema changed, so the plan carries a draft transform');
    // the review step a real user performs: a pure widening needs no
    // transform, so the draft is deleted before applying
    migration.steps = migration.steps.filter((s) => s.draft !== true);
    fs.writeFileSync(out, JSON.stringify(migration, null, 2));
  });

  it('plan refuses a from-model that does not match the store', () => {
    const result = run('plan', '--from', files.to2, '--to', files.to,
      '--store', files.store);
    assert.strictEqual(result.status, 1);
    assert.match(result.stderr, /does not match the from-model/);
  });

  it('check exits non-zero while a migration is pending', () => {
    const result = run('check', '--model', files.to, '--store', files.store,
      '--baseline', files.from, '--migrations', files.migrations);
    assert.strictEqual(result.status, 1);
    assert.match(result.stderr, /pending/);
  });

  it('apply --dry-run prints every statement and changes nothing', () => {
    const result = run('apply', '--store', files.store, '--baseline', files.from,
      '--migrations', files.migrations, '--model', files.to, '--dry-run');
    assert.strictEqual(result.status, 0, result.stderr);
    assert.match(result.stdout, /ADD COLUMN "age"/);
    const raw = new DatabaseSync(files.store);
    assert.strictEqual(
      raw.prepare('SELECT COUNT(*) AS n FROM _jaren_migrations').get().n, 0);
    raw.close();
  });

  it('apply --yes applies; check then exits zero, in sync', () => {
    const applied = run('apply', '--store', files.store, '--baseline', files.from,
      '--migrations', files.migrations, '--model', files.to, '--yes');
    assert.strictEqual(applied.status, 0, applied.stderr);
    assert.match(applied.stdout, /applied: 001-add-age/);
    const check = run('check', '--model', files.to, '--store', files.store,
      '--baseline', files.from, '--migrations', files.migrations);
    assert.strictEqual(check.status, 0, check.stderr);
    assert.match(check.stdout, /in sync/);
  });

  it('a destructive apply without --yes refuses, NAMING what is lost', () => {
    const out = path.join(files.migrations, '002-drop-name.json');
    const planned = run('plan', '--from', files.to, '--to', files.to2,
      '--id', '002-drop-name', '--out', out);
    assert.strictEqual(planned.status, 0, planned.stderr);
    assert.match(planned.stderr, /DESTRUCTIVE/);
    const reviewed = JSON.parse(fs.readFileSync(out, 'utf8'));
    reviewed.steps = reviewed.steps.filter((s) => s.draft !== true);
    fs.writeFileSync(out, JSON.stringify(reviewed, null, 2));
    const refused = run('apply', '--store', files.store, '--baseline', files.from,
      '--migrations', files.migrations, '--model', files.to2);
    assert.strictEqual(refused.status, 1);
    assert.match(refused.stdout, /drop column 'name'/,
      'the prompt names the loss');
    assert.match(refused.stderr, /--yes/);
    const raw = new DatabaseSync(files.store);
    assert.strictEqual(raw.prepare('SELECT name FROM "User"').get().name, 'ada',
      'nothing was applied');
    raw.close();
    const applied = run('apply', '--store', files.store, '--baseline', files.from,
      '--migrations', files.migrations, '--model', files.to2, '--yes');
    assert.strictEqual(applied.status, 0, applied.stderr);
  });

  it('status and check name a hand-modified database as drift', () => {
    const raw = new DatabaseSync(files.store);
    raw.exec('CREATE INDEX "sneaky" ON "User" (id)');
    raw.close();
    const status = run('status', '--model', files.to2, '--store', files.store,
      '--baseline', files.from, '--migrations', files.migrations);
    assert.strictEqual(status.status, 0, status.stderr);
    assert.match(status.stdout, /drift:.*unexpected index:sneaky/);
    const check = run('check', '--model', files.to2, '--store', files.store,
      '--baseline', files.from, '--migrations', files.migrations);
    assert.strictEqual(check.status, 1);
    assert.match(check.stderr, /drifted.*sneaky/);
    const cleanupDb = new DatabaseSync(files.store);
    cleanupDb.exec('DROP INDEX "sneaky"');
    cleanupDb.close();
  });

  it('shape prints the physical mapping; --help and bad input behave', () => {
    const shape = run('shape', '--model', files.to);
    assert.strictEqual(shape.status, 0);
    assert.match(shape.stdout, /CREATE TABLE "User"/);
    assert.match(shape.stdout, /shape hash: /);
    assert.strictEqual(run('--help').status, 0);
    assert.strictEqual(run('nonsense').status, 1);
    assert.strictEqual(run().status, 1);
  });
});
