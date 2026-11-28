//@ts-check
/**
 * @file `jaren-db introspect --store <db>` prints the model
 * `introspectModel` derives from the database as JSON on standard output (or
 * writes it with `--out`, unchanged on a second run), read with the CLI's
 * temporal seam, and names each row of its report on standard error, one
 * line each; `--triggers` passes the SQLite trigger reader, so an
 * application trigger comes back as the database rule it equals. It reads
 * only: the database's bytes are unchanged, and a `--store` that does not
 * exist is refused and not created. A misuse of its flags exits 2, as the
 * history commands do.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { introspectModel, openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { storeTemporals } from '@jarenjs/db/temporals';
import { sqliteTriggers } from '@jarenjs/db/trigger-rules';
import { removeTempDirectory } from './helpers.js';

const CLI = resolve('packages/db/src/cli.js');
const MODEL = { $model: '0.1',
  collections: { items: { key: '/id', schema: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } } },
    indexes: [{ name: 'by_name', path: '$.name' }] } },
  entities: { Parent: { schema: { type: 'object', properties: { id: { type: 'integer', 'x-entity': { key: true } } } } } } };
/** An application's own tables beside the store's: a trigger the reader reads back, one it does not
 * (it probes a table the store owns), and a view. */
const APPLICATION = `CREATE TABLE owner(id INTEGER PRIMARY KEY); CREATE TABLE child(id INTEGER PRIMARY KEY, ref INTEGER NOT NULL);
  CREATE TRIGGER child_ref BEFORE INSERT ON child WHEN NOT EXISTS (SELECT 1 FROM owner WHERE id = NEW.ref)
  BEGIN SELECT RAISE(ABORT, 'no parent'); END;
  CREATE TRIGGER child_store BEFORE INSERT ON child WHEN NOT EXISTS (SELECT 1 FROM "Parent" WHERE id = NEW.ref)
  BEGIN SELECT RAISE(ABORT, 'no store parent'); END;
  CREATE VIEW v AS SELECT 1`;

/** A store with the application's tables, and a CLI runner in its directory. @param {(work: any) => Promise<void>} fn */
async function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'jaren-db-cli-introspect-'));
  const file = (/** @type {string} */ name) => join(dir, name);
  try {
    await (await openStore(MODEL, { driver: nodeDriver(), path: file('app.db') })).close();
    const raw = new DatabaseSync(file('app.db'));
    try { raw.exec(APPLICATION); }
    finally { raw.close(); }
    const run = (/** @type {string[]} */ args) => spawnSync(process.execPath, ['--no-warnings=ExperimentalWarning', CLI, ...args],
      { encoding: 'utf8', cwd: dir, input: '', env: { ...process.env, FORCE_COLOR: '0' } });
    /** What the API derives, with the options the command passes. @param {any} [options] */
    const derived = async (options = {}) => {
      const connection = await nodeDriver().open(file('app.db'), {});
      try { return await introspectModel(connection, { temporals: storeTemporals(), ...options }); }
      finally { await connection.close(); }
    };
    const bytes = () => createHash('sha256').update(readFileSync(file('app.db'))).digest('hex');
    await fn({ file, run, derived, bytes });
  }
  finally { removeTempDirectory(dir); }
}

/** The report as the command prints it. @param {any[]} report */
const lines = (report) => report.map((row) => `${row.code} ${row.object}: ${row.detail}`
  + `${row.reason === undefined || row.detail.includes(row.reason) ? '' : ` (${row.reason})`}\n`).join('');

describe('jaren-db introspect', () => {
  it('prints the derived model as JSON and each report row on standard error, reading only', () => withStore(async ({ run, derived, bytes }) => {
    const before = bytes();
    const result = run(['introspect', '--store', 'app.db']);
    assert.equal(result.status, 0, result.stderr);
    const { model, report } = await derived();
    assert.equal(result.stdout, `${JSON.stringify(model, null, 2)}\n`);
    assert.equal(result.stderr, lines(report));
    assert.deepEqual(Object.keys(JSON.parse(result.stdout).entities).sort(), ['Parent', 'child', 'owner']);
    assert.equal(JSON.parse(result.stdout).entities.child.invariants, undefined);
    const stderr = result.stderr.split('\n');
    assert.ok(stderr.includes('unmapped-object child_ref: an application-owned trigger program must be explicitly preserved; '
      + 'inspection grants no drop permission (it is read back as a database rule only with the triggers option of @jarenjs/db/trigger-rules)'));
    assert.ok(stderr.includes('unmapped-view v: a view is not a shape a model document can declare'));
    assert.equal(bytes(), before);
  }));

  it('reads an application trigger back as the database rule it equals with --triggers', () => withStore(async ({ run, derived }) => {
    const result = run(['introspect', '--store', 'app.db', '--triggers']);
    assert.equal(result.status, 0, result.stderr);
    const { model, report } = await derived({ triggers: sqliteTriggers });
    assert.equal(result.stdout, `${JSON.stringify(model, null, 2)}\n`);
    assert.equal(result.stderr, lines(report));
    assert.deepEqual(JSON.parse(result.stdout).entities.child.invariants.map((/** @type {any} */ rule) => rule.name), ['child_ref']);
    assert.match(result.stderr, /^trigger-rule child_ref: read back as the database rule 'child_ref' of the entity 'child'; /m);
    // the reason the reader gives is said once
    assert.ok(result.stderr.split('\n').includes('unmapped-object child_store: an application-owned trigger program must be explicitly '
      + 'preserved; inspection grants no drop permission; it is not read back as a database rule: the table \'Parent\' is not read back '
      + 'as a column layout: it holds a document, laid out as the store owns it, whose rules the store creates with the table'));
  }));

  it('writes the model with --out, and changes nothing the second time', () => withStore(async ({ file, run, derived }) => {
    const first = run(['introspect', '--store', 'app.db', '--out', 'model.json']);
    assert.deepEqual([first.status, first.stdout], [0, 'wrote model.json\n']);
    assert.equal(readFileSync(file('model.json'), 'utf8'), `${JSON.stringify((await derived()).model, null, 2)}\n`);
    const second = run(['introspect', '--store', 'app.db', '--out', 'model.json']);
    assert.deepEqual([second.status, second.stdout], [0, 'unchanged model.json\n']);
  }));

  it('refuses a misuse with exit 2 and a store that does not exist with exit 1, creating nothing', () => withStore(async ({ file, run }) => {
    /** @type {[string[], number, string][]} */
    const cases = [
      [['introspect'], 2, 'introspect needs --store'],
      [['introspect', '--store'], 2, '--store needs a value'],
      [['introspect', '--store', 'app.db', '--model', 'model.json'], 2, 'introspect does not take \'--model\''],
      [['introspect', '--store', 'app.db', '--yes'], 2, 'introspect does not take \'--yes\''],
      [['history', '--store', 'app.db', '--triggers'], 2, 'history does not take \'--triggers\''],
      [['status', '--store', 'app.db', '--triggers'], 1, 'status does not take \'--triggers\''],
      [['introspect', '--store', 'typo.db'], 1, `the database file does not exist: typo.db`],
    ];
    for (const [args, status, message] of cases) {
      const result = run(args);
      assert.deepEqual([result.status, result.stdout, result.stderr], [status, '', `jaren-db: ${message}\n`], args.join(' '));
    }
    assert.equal(existsSync(file('typo.db')), false);
    const help = run(['introspect', '--help']);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /^ {2}jaren-db introspect --store <db> \[--triggers\] \[--out <model\.json>\]$/m);
  }));
});
