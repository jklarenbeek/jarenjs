//@ts-check
/**
 * @file `jaren-db plan --model <m> --store <db> --upgrade-columns` prints, or
 * writes with `--out`, the link `planColumnUpgrade` plans from the catalog: a
 * table an earlier release created holds the generated column of an indexed
 * member of several types in the member's first type, and the link rebuilds
 * it as this release creates it. Applied as the next link, the store is
 * current, and the same command plans nothing and writes nothing. The store is
 * verified against the model first, the snapshot is neither read nor advanced,
 * and a command line that names no store, or names two models, is refused, as
 * is a model that declares an index expression, whose functions a command line
 * cannot pass.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { removeTempDirectory } from './helpers.js';

const CLI = resolve('packages/db/src/cli.js');
/** @param {any} type */
const modelOf = (type) => ({ $model: '0.1', collections: { c: { schema: { type: 'object', required: ['id'],
  properties: { id: { type: 'string' }, q: { type } } }, key: '/id', indexes: [{ name: 'by_q', path: '$.q' }] } } });
const MODEL = modelOf(['number', 'string']);

/**
 * A directory holding the model and a store an earlier release wrote for it:
 * the column of `q` in its first type, `REAL`, which refuses a string.
 * @param {(dir: string) => Promise<void>} fn
 */
async function withLegacyStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'jaren-db-upgrade-columns-'));
  try {
    writeFileSync(join(dir, 'model.json'), JSON.stringify(MODEL));
    const file = join(dir, 'store.db');
    const store = await openStore(MODEL, { driver: nodeDriver(), path: file });
    await store.close();
    const raw = new DatabaseSync(file);
    raw.exec('DROP INDEX "c_by_q"');
    raw.exec('ALTER TABLE "c" DROP COLUMN "gx_q"');
    raw.exec('ALTER TABLE "c" ADD COLUMN "gx_q" REAL GENERATED ALWAYS AS (jsonb_extract("doc", \'$."q"\')) VIRTUAL');
    raw.exec('CREATE INDEX "c_by_q" ON "c" ("gx_q")');
    raw.prepare('INSERT INTO "c" ("key", "doc") VALUES (?, jsonb(?))').run('a', JSON.stringify({ id: 'a', q: 2 }));
    raw.close();
    await fn(dir);
  }
  finally {
    removeTempDirectory(dir);
  }
}

/** @param {string} dir @param {string[]} args */
const run = (dir, ...args) => spawnSync(process.execPath, ['--no-warnings=ExperimentalWarning', CLI, ...args],
  { encoding: 'utf8', cwd: dir, input: '' });
/** The type the store's table declares `gx_q` in. @param {string} dir */
const columnType = (dir) => {
  const raw = new DatabaseSync(join(dir, 'store.db'));
  try { return String(/** @type {any} */ (raw.prepare('SELECT "type" FROM pragma_table_xinfo(\'c\') WHERE "name" = \'gx_q\'').get()).type); }
  finally { raw.close(); }
};

describe('jaren-db plan --upgrade-columns', () => {
  it('prints the link that rebuilds the column, writes the same link twice with --out, and plans nothing once it applies', async () => {
    await withLegacyStore(async (dir) => {
      const printed = run(dir, 'plan', '--model', 'model.json', '--store', 'store.db', '--upgrade-columns', '--id', 'upgrade');
      assert.equal(printed.status, 0, printed.stderr);
      const migration = JSON.parse(printed.stdout);
      assert.equal(migration.id, 'upgrade');
      assert.equal(migration.from, migration.to);
      assert.deepEqual(migration.steps.map((/** @type {any} */ step) => step.kind), ['ddl', 'ddl', 'ddl', 'ddl']);
      assert.equal(printed.stderr, 'NOTE: the link rebuilds or creates c.gx_q — apply it as the next link of the chain\n');
      // the plan reads the database and changes nothing
      assert.equal(columnType(dir), 'REAL');

      mkdirSync(join(dir, 'migrations'));
      const out = join('migrations', '001-upgrade.json');
      for (let twice = 0; twice < 2; twice++) {
        const written = run(dir, 'plan', '--model', 'model.json', '--store', 'store.db', '--upgrade-columns', '--id', 'upgrade', '--out', out);
        assert.equal(written.status, 0, written.stderr);
        assert.equal(written.stdout, `wrote ${out} (4 step(s))\n`);
        assert.equal(readFileSync(join(dir, out), 'utf8'), `${printed.stdout.trimEnd()}\n`);
      }
      assert.ok(!existsSync(join(dir, 'model.snapshot.json')), 'no snapshot is written');

      const applied = run(dir, 'apply', '--store', 'store.db', '--baseline', 'model.json', '--migrations', 'migrations', '--yes');
      assert.equal(applied.status, 0, applied.stderr);
      assert.equal(columnType(dir), 'ANY');
      const store = await openStore(MODEL, { driver: nodeDriver(), path: join(dir, 'store.db') });
      try {
        await store.collection('c').put({ id: 'b', q: 'two' });
        assert.deepEqual(await store.collection('c').execute({ $for: { it: '$[*]' }, $where: { $eq: ['$it.q', 2] }, $return: '$it.id' }), 'a');
      }
      finally { await store.close(); }

      // current, the store plans no step and nothing is written, twice
      for (let again = 0; again < 2; again++) {
        const none = run(dir, 'plan', '--model', 'model.json', '--store', 'store.db', '--upgrade-columns', '--out', 'none.json');
        assert.equal(none.status, 0, none.stderr);
        assert.equal(none.stdout, 'no upgrade — the tables of store.db hold what this release creates for the model; nothing to plan\n');
        assert.ok(!existsSync(join(dir, 'none.json')));
      }
      const check = run(dir, 'check', '--model', 'model.json', '--store', 'store.db', '--migrations', 'migrations', '--baseline', 'model.json');
      assert.equal(check.status, 0, check.stdout + check.stderr);
    });
  });

  it('refuses a store that does not hold the model, a missing store, and a command line without a store or with two models', async () => {
    await withLegacyStore(async (dir) => {
      writeFileSync(join(dir, 'other.json'), JSON.stringify(modelOf('string')));
      const other = run(dir, 'plan', '--model', 'other.json', '--store', 'store.db', '--upgrade-columns');
      assert.equal(other.status, 1);
      assert.match(other.stderr, /^jaren-db: the store does not match the model \(.+\) — is this the model the database holds\?\n$/s);
      const missing = run(dir, 'plan', '--model', 'model.json', '--store', 'absent.db', '--upgrade-columns');
      assert.equal(missing.status, 1);
      assert.equal(missing.stderr, 'jaren-db: the database file does not exist: absent.db\n');
      assert.ok(!existsSync(join(dir, 'absent.db')));
      for (const [args, message] of /** @type {[string[], string][]} */ ([
        [['--model', 'model.json'], 'plan --upgrade-columns needs --model and --store'],
        [['--store', 'store.db'], 'plan --upgrade-columns needs --model and --store'],
        [['--from', 'model.json', '--to', 'model.json', '--store', 'store.db'], 'plan --upgrade-columns takes --model, the model the database holds, not --from and --to'],
        [['--model', 'model.json', '--snapshot', 'model.json', '--store', 'store.db'], 'plan --upgrade-columns plans from the database, not from a --snapshot'],
      ])) {
        const refused = run(dir, 'plan', ...args, '--upgrade-columns');
        assert.equal(refused.status, 1, args.join(' '));
        assert.equal(refused.stderr, `jaren-db: ${message}\n`);
      }
      // the command line takes no functions: a model that declares an index expression is refused as `plan --store` refuses it
      const lower = { lower: { arity: 1, deterministic: true, apply: (/** @type {any} */ value) => String(value).toLowerCase(), sql: 'lower' } };
      const declared = { $model: '0.1', collections: { u: { schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, n: { type: 'string' } } },
        key: '/id', indexes: [{ name: 'by', expression: { call: 'lower', args: [{ member: '$.n' }] } }] } } };
      writeFileSync(join(dir, 'declared.json'), JSON.stringify(declared));
      await (await openStore(declared, { driver: nodeDriver(), path: join(dir, 'declared.db'), expressions: lower })).close();
      const functions = run(dir, 'plan', '--model', 'declared.json', '--store', 'declared.db', '--upgrade-columns');
      assert.equal(functions.status, 1);
      assert.match(functions.stderr, /^jaren-db: JD0004: the index expression names the function 'lower', which this store was not given/);
      const status = run(dir, 'status', '--model', 'model.json', '--store', 'store.db', '--upgrade-columns');
      assert.equal(status.status, 1);
      assert.equal(status.stderr, "jaren-db: status does not take '--upgrade-columns'\n");
    });
  });
});
