//@ts-check
/**
 * @file A read command never creates the database it reads: `history`,
 * `status`, `check` and `apply --dry-run` refuse a `--store` that does not
 * exist (exit 1, naming the path) and leave no file behind, where the
 * driver's open used to create an empty one and report it as an empty,
 * reviewable history. Neither do `plan --store`, `adopt-history`, an
 * `apply` that is only printed, or one without `--yes` that finds nothing
 * pending. A store named another way is read as it is: `:memory:` is the
 * empty database, and a `file:` URI reaches SQLite as written. A real
 * `apply` may still create a new store.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { migrate, openStore, shapeHash, migrationChecksum } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { removeTempDirectory } from './helpers.js';
import { EMPTY, document } from './migration-identity-helpers.js';

const CLI = resolve('packages/db/src/cli.js');
const MODEL = { $model: '0.1', collections: { items: { schema: { type: 'object' }, key: '/id' } } };

/** A temporary directory and a CLI runner with no interactive terminal.
 * @returns {{ file: (name: string) => string, run: (args: string[]) => any, cleanup: () => void }} */
function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'jaren-db-store-forms-'));
  return {
    file: (name) => join(dir, name),
    run: (args) => spawnSync(process.execPath, ['--no-warnings=ExperimentalWarning', CLI, ...args],
      { encoding: 'utf8', input: '' }),
    cleanup: () => removeTempDirectory(dir),
  };
}

describe('jaren-db read commands on a store that does not exist', () => {
  it('refuse, exit 1 and create no file; a real apply still creates its store', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jaren-db-missing-store-'));
    try {
      const file = (/** @type {string} */ name) => join(dir, name);
      writeFileSync(file('model.json'), JSON.stringify(MODEL));
      mkdirSync(file('migrations'));
      const typo = file('typo.db');
      const run = (/** @type {string[]} */ args) => spawnSync(process.execPath,
        ['--no-warnings=ExperimentalWarning', CLI, ...args], { encoding: 'utf8' });
      const answers = [];
      for (const args of [
        ['history', '--store', typo],
        ['history', '--store', typo, '--out', file('observed.json')],
        ['status', '--store', typo, '--migrations', file('migrations'), '--model', file('model.json')],
        ['status', '--store', typo],
        ['check', '--store', typo, '--migrations', file('migrations'), '--model', file('model.json')],
        ['apply', '--store', typo, '--baseline', file('model.json'), '--migrations', file('migrations'), '--dry-run'],
      ]) {
        const result = run(args);
        answers.push([args.join(' '), result.status, result.stdout, result.stderr, existsSync(typo)]);
      }
      assert.deepEqual(answers, answers.map(([args]) =>
        [args, 1, '', `jaren-db: the database file does not exist: ${typo}\n`, false]));
      assert.equal(existsSync(file('observed.json')), false, 'no observation of a missing database is written');
      const created = run(['apply', '--store', file('new.db'), '--baseline', file('model.json'),
        '--migrations', file('migrations'), '--yes']);
      assert.equal(created.status, 0, created.stderr);
      assert.match(created.stdout, /nothing to apply — up to date/);
      assert.equal(existsSync(file('new.db')), true, 'apply may create a new store');
    }
    finally { removeTempDirectory(dir); }
  });

  it('read a store named another way as it is: :memory: is the empty database, a file: URI reaches SQLite', async () => {
    const work = workspace();
    try {
      writeFileSync(work.file('model.json'), JSON.stringify(MODEL));
      mkdirSync(work.file('migrations'));
      const empty = { version: 1, dialect: 'sqlite', order: 'rowid',
        history: { present: false, rows: [] }, identity: { present: false, rows: [] } };
      const memory = work.run(['history', '--store', ':memory:']);
      assert.deepEqual([memory.status, memory.stderr, JSON.parse(memory.stdout || 'null')], [0, '', empty]);
      const status = work.run(['status', '--store', ':memory:', '--migrations', work.file('migrations')]);
      assert.deepEqual([status.status, status.stdout, status.stderr], [0, 'applied:  (none)\npending:  (none)\n', '']);
      const preview = work.run(['apply', '--store', ':memory:', '--baseline', work.file('model.json'),
        '--migrations', work.file('migrations'), '--dry-run']);
      assert.deepEqual([preview.status, preview.stdout, preview.stderr], [0, 'nothing to apply — dry run\n', '']);
      // an existing store through a read-only URI: read, and left byte for byte
      const link = document('0001', [{ kind: 'sql', sql: 'CREATE TABLE t(x INTEGER)' }]);
      writeFileSync(work.file('migrations/0001.json'), JSON.stringify(link));
      await migrate({ driver: nodeDriver(), path: work.file('app.db') }, [link], { baseline: EMPTY, shadow: false });
      const before = readFileSync(work.file('app.db'));
      const uri = `${pathToFileURL(work.file('app.db')).href}?mode=ro`;
      const history = work.run(['history', '--store', uri]);
      assert.equal(history.status, 0, history.stderr);
      assert.deepEqual(JSON.parse(history.stdout).history.rows.map((/** @type {any} */ row) => row.id), ['0001']);
      const applied = work.run(['status', '--store', uri, '--migrations', work.file('migrations')]);
      assert.deepEqual([applied.status, applied.stdout, applied.stderr], [0, 'applied:  0001\npending:  (none)\n', '']);
      assert.deepEqual(readFileSync(work.file('app.db')), before);
    }
    finally { work.cleanup(); }
  });

  it('a command that only prints, plans against or attests a store does not create it', async () => {
    const work = workspace();
    try {
      writeFileSync(work.file('model.json'), JSON.stringify(MODEL));
      mkdirSync(work.file('migrations'));
      writeFileSync(work.file('migrations/0001.json'), JSON.stringify(
        document('0001', [{ kind: 'sql', sql: 'CREATE TABLE t(x INTEGER)' }], MODEL)));
      // a reviewed legacy history and its observation, which adopt-history admits
      const legacy = { $migration: '0.1', id: '0001-reviewed', from: shapeHash(MODEL), to: shapeHash(MODEL), steps: [] };
      mkdirSync(work.file('legacy'));
      writeFileSync(work.file('legacy/0001.json'), JSON.stringify(legacy));
      await (await openStore(MODEL, { driver: nodeDriver(), path: work.file('app.db') })).close();
      const raw = new DatabaseSync(work.file('app.db'));
      try {
        raw.exec('CREATE TABLE "_jaren_migrations" ("id" TEXT PRIMARY KEY, "applied_at" INTEGER, "from_hash" TEXT, '
          + '"to_hash" TEXT, "checksum" TEXT, "steps" INTEGER) STRICT');
        raw.prepare('INSERT INTO "_jaren_migrations" VALUES (?, 1234, ?, ?, ?, 0)')
          .run(legacy.id, legacy.from, legacy.to, migrationChecksum(legacy));
      }
      finally { raw.close(); }
      const observed = work.run(['history', '--store', work.file('app.db'), '--out', work.file('observed.json')]);
      assert.equal(observed.status, 0, observed.stderr);

      const typo = work.file('typo.db');
      const missing = `jaren-db: the database file does not exist: ${typo}\n`;
      const printed = work.run(['apply', '--store', typo, '--baseline', work.file('model.json'),
        '--migrations', work.file('migrations')]);
      assert.deepEqual([printed.status, printed.stderr, existsSync(typo)],
        [1, 'jaren-db: apply needs --yes (no interactive terminal to ask) — nothing was applied\n', false]);
      assert.match(printed.stdout, /^pending: 0001\n/);
      // nothing pending: an apply without --yes has nothing to confirm, and only reports
      mkdirSync(work.file('none'));
      const idle = work.run(['apply', '--store', typo, '--baseline', work.file('model.json'), '--migrations', work.file('none')]);
      assert.deepEqual([idle.status, idle.stdout, idle.stderr, existsSync(typo)], [0, 'nothing to apply — up to date\n', '', false]);
      const planned = work.run(['plan', '--from', work.file('model.json'), '--to', work.file('model.json'), '--store', typo]);
      assert.deepEqual([planned.status, planned.stdout, planned.stderr, existsSync(typo)], [1, '', missing, false]);
      const attested = work.run(['adopt-history', '--store', typo, '--migrations', work.file('legacy'),
        '--observed', work.file('observed.json'), '--model', work.file('model.json'), '--yes']);
      assert.deepEqual([attested.status, attested.stdout, attested.stderr, existsSync(typo)], [1, '', missing, false]);
    }
    finally { work.cleanup(); }
  });
});
