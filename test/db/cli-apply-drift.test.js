//@ts-check
/**
 * @file `jaren-db apply` gives one verdict for one database state: after it
 * applies pending work it runs the drift check its no-op path runs, so a
 * database that drifted from the target fails the pending apply (the links
 * stay committed and are reported) exactly as the identical rerun does.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createModelShape } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { removeTempDirectory } from './helpers.js';
import { document, legacy, seedLegacy } from './migration-identity-helpers.js';

const CLI = resolve('packages/db/src/cli.js');
const MODEL = { $model: '0.1', collections: { items: { schema: { type: 'object' }, key: '/id' } } };

describe('jaren-db apply on a drifted database', () => {
  it('fails after applying pending work, as the identical no-op rerun does', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jaren-db-apply-drift-'));
    try {
      const file = (/** @type {string} */ name) => join(dir, name);
      const write = (/** @type {string} */ name, /** @type {any} */ value) => writeFileSync(file(name), `${JSON.stringify(value, null, 2)}\n`);
      mkdirSync(file('applied'));
      mkdirSync(file('migrations'));
      // a legacy link created a table the model does not declare: the drift
      const first = legacy('0001-first', [{ kind: 'sql', sql: 'CREATE TABLE witness(value TEXT)' }], MODEL);
      write('model.json', MODEL);
      write('applied/0001-first.json', first);
      write('migrations/0001-first.json', first);
      const connection = await nodeDriver().open(file('app.db'));
      try {
        await createModelShape(connection, MODEL);
        await seedLegacy(connection, [first]);
      }
      finally { await connection.close(); }
      const run = (/** @type {string[]} */ args) => spawnSync(process.execPath,
        ['--no-warnings=ExperimentalWarning', CLI, ...args, '--store', file('app.db')], { encoding: 'utf8' });
      assert.equal(run(['history', '--out', file('observed.json')]).status, 0);
      const adopted = run(['adopt-history', '--migrations', file('applied'), '--observed', file('observed.json'),
        '--model', file('model.json'), '--yes']);
      assert.equal(adopted.status, 0, adopted.stderr);
      const status = run(['status', '--migrations', file('migrations'), '--model', file('model.json')]);
      assert.match(status.stdout, /drift: {4}unexpected table:witness/);
      write('migrations/0002-tail.json', document('0002-tail', [{ kind: 'sql', sql: "INSERT INTO witness VALUES ('tail')" }], MODEL));
      const apply = ['apply', '--baseline', file('model.json'), '--model', file('model.json'), '--migrations', file('migrations')];
      const pending = run([...apply, '--yes']);
      const rerun = run(apply);
      assert.deepEqual([pending.status, pending.stderr], [1, 'jaren-db: the database drifted from the target: unexpected table:witness\n']);
      assert.match(pending.stdout, /\napplied: 0002-tail\n$/, 'the committed link is reported before the verdict');
      assert.deepEqual([rerun.status, rerun.stdout, rerun.stderr], [1, '', pending.stderr], 'the no-op rerun agrees');
      const history = JSON.parse(run(['history']).stdout).history.rows.map((/** @type {any} */ row) => row.id);
      assert.deepEqual(history, ['0001-first', '0002-tail'], 'the link stands');
    }
    finally { removeTempDirectory(dir); }
  });
});
