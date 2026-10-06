//@ts-check
/** Real CLI observation and explicit legacy attestation, including refusal exits. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openStore, migrate, shapeHash, migrationChecksum, planModelMigration, sqliteDialect } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { removeTempDirectory } from './helpers.js';

const CLI = resolve('packages/db/src/cli.js');
const MODEL = { $model: '0.1', entities: { Item: { schema: {
  type: 'object', additionalProperties: false, required: ['id', 'name'],
  properties: { id: { type: 'string', 'x-entity': { key: true } }, name: { type: 'string' } },
} } } };

async function fixture(legacy = true) {
  const dir = mkdtempSync(join(tmpdir(), 'jaren-cli-history-'));
  const file = (name) => join(dir, name);
  const write = (name, value) => { writeFileSync(file(name), JSON.stringify(value)); return file(name); };
  mkdirSync(file('migrations'));
  write('model.json', MODEL);
  const store = await openStore(MODEL, { driver: nodeDriver(), path: file('app.db') });
  await store.entity('Item').create({ id: 'one', name: 'Ada' });
  await store.close();
  const document = { $migration: '0.1', id: '0001-reviewed', from: shapeHash(MODEL), to: shapeHash(MODEL),
    steps: [{ kind: 'sql', sql: `INSERT INTO "Item" ("id", "name", "doc") VALUES ('one', 'Ada', jsonb('{}'))` }] };
  write('migrations/0001.json', document);
  const raw = new DatabaseSync(file('app.db'));
  try {
    if (legacy) {
      raw.exec(`CREATE TABLE IF NOT EXISTS "_jaren_migrations" ("id" TEXT PRIMARY KEY, "applied_at" INTEGER, "from_hash" TEXT, "to_hash" TEXT, "checksum" TEXT, "steps" INTEGER) STRICT`);
      raw.prepare(`INSERT INTO "_jaren_migrations" (rowid,id,applied_at,from_hash,to_hash,checksum,steps)
        VALUES (-7, ?, 9007199254740993, ?, ?, ?, 1)`)
        .run(document.id, document.from, document.to, migrationChecksum(document));
    }
  }
  finally { raw.close(); }
  const run = (command, extra = []) => spawnSync(process.execPath,
    ['--no-warnings=ExperimentalWarning', CLI, command, '--store', file('app.db'), ...extra], { encoding: 'utf8' });
  const inspect = () => {
    const connection = new DatabaseSync(file('app.db'));
    try {
      const schema = connection.prepare('SELECT type,name,sql FROM sqlite_schema ORDER BY name').all();
      const history = schema.some((row) => row.name === '_jaren_migrations')
        ? connection.prepare(`SELECT CAST(rowid AS TEXT) AS rowid, id, CAST(applied_at AS TEXT) AS applied_at,
          from_hash,to_hash,checksum,CAST(steps AS TEXT) AS steps FROM "_jaren_migrations" ORDER BY rowid`).all() : [];
      return { schema, history, rows: connection.prepare('SELECT id,name FROM "Item" ORDER BY id').all() };
    }
    finally { connection.close(); }
  };
  const observe = () => {
    const result = run('history', ['--out', file('observed.json')]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    return JSON.parse(readFileSync(file('observed.json'), 'utf8'));
  };
  const adopt = (extra = ['--yes']) => run('adopt-history', ['--migrations', file('migrations'),
    '--observed', file('observed.json'), '--model', file('model.json'), ...extra]);
  return { file, write, document, run, inspect, observe, adopt, cleanup: () => removeTempDirectory(dir) };
}

describe('CLI explicit migration history authority', () => {
  it('history emits one lossless JSON observation without writing either table', async () => {
    const work = await fixture();
    try {
      const before = work.inspect();
      const result = work.run('history');
      assert.equal(result.status, 0, result.stderr);
      const observed = JSON.parse(result.stdout);
      assert.deepEqual(observed, { version: 1, dialect: 'sqlite', order: 'rowid',
        history: { present: true, rows: before.history.map((row) => ({ ...row })) }, identity: { present: false, rows: [] } });
      assert.equal(observed.history.rows[0].applied_at, '9007199254740993');
      assert.equal(observed.history.rows[0].rowid, '-7');
      assert.deepEqual(work.observe(), observed);
      assert.deepEqual(work.inspect(), before);
    }
    finally { work.cleanup(); }
  });
  it('an empty history stays empty after observation', async () => {
    const work = await fixture(false);
    try {
      const before = work.inspect();
      const observed = work.observe();
      assert.deepEqual(observed.history, { present: false, rows: [] });
      assert.deepEqual(observed.identity, { present: false, rows: [] });
      assert.deepEqual(work.inspect(), before);
    }
    finally { work.cleanup(); }
  });
  it('adopts once, repeats with the original observation, and never reruns legacy SQL', async () => {
    const work = await fixture();
    try {
      work.observe();
      const before = work.inspect();
      const bytes = readFileSync(work.file('migrations/0001.json'));
      const first = work.adopt();
      assert.equal(first.status, 0, first.stderr);
      assert.deepEqual(JSON.parse(first.stdout), { adopted: 1, unchanged: 0 });
      const after = work.inspect();
      assert.deepEqual(after.history, before.history);
      assert.deepEqual(after.rows, before.rows);
      const repeat = work.adopt();
      assert.equal(repeat.status, 0, repeat.stderr);
      assert.deepEqual(JSON.parse(repeat.stdout), { adopted: 0, unchanged: 1 });
      assert.deepEqual(work.inspect(), after);
      assert.deepEqual(readFileSync(work.file('migrations/0001.json')), bytes);
      const status = work.run('status', ['--migrations', work.file('migrations'), '--model', work.file('model.json')]);
      assert.equal(status.status, 0, status.stderr);
      assert.match(status.stdout, /pending:\s+\(none\)/);
      const apply = work.run('apply', ['--migrations', work.file('migrations'), '--baseline', work.file('model.json'), '--model', work.file('model.json')]);
      assert.equal(apply.status, 0, apply.stderr);
      assert.match(apply.stdout, /up to date/);
      assert.deepEqual(work.inspect(), after);
    }
    finally { work.cleanup(); }
  });
  it('confirmation is required in a noninteractive invocation', async () => {
    const work = await fixture();
    try {
      work.observe();
      const before = work.inspect();
      const result = work.adopt([]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /needs --yes/);
      assert.deepEqual(work.inspect(), before);
    }
    finally { work.cleanup(); }
  });
  for (const command of ['status', 'apply', 'dry-run']) {
    it(`${command} refuses unadopted history instead of printing success`, async () => {
      const work = await fixture();
      try {
        const before = work.inspect();
        const args = ['--migrations', work.file('migrations'), '--model', work.file('model.json')];
        if (command !== 'status') args.push('--baseline', work.file('model.json'), command === 'dry-run' ? '--dry-run' : '--yes');
        const result = work.run(command === 'dry-run' ? 'apply' : command, args);
        assert.equal(result.status, 1);
        assert.match(result.stderr, /JD0028/);
        assert.doesNotMatch(result.stdout, /up to date|in sync|applied:/);
        assert.deepEqual(work.inspect(), before);
      }
      finally { work.cleanup(); }
    });
  }
  for (const mutation of ['stale observation', 'different current model', 'pending legacy tail', 'physical target']) {
    it(`refuses ${mutation} without partial metadata`, async () => {
      const work = await fixture();
      try {
        work.observe();
        let extra = ['--yes'];
        if (mutation === 'stale observation') {
          const raw = new DatabaseSync(work.file('app.db'));
          try { raw.exec('UPDATE "_jaren_migrations" SET applied_at = 2'); }
          finally { raw.close(); }
        }
        if (mutation === 'different current model') {
          const other = structuredClone(MODEL);
          other.entities.Item.schema.properties.name.maxLength = 2;
          work.write('model.json', other);
        }
        if (mutation === 'pending legacy tail') work.write('migrations/0002.json', { ...work.document, id: '0002-pending' });
        if (mutation === 'physical target') extra.push('--physical-target', work.write('target.json', { objects: [], tables: ['Item'] }));
        const before = work.inspect();
        const result = work.adopt(extra);
        assert.equal(result.status, 1);
        const expectedCode = { 'stale observation': 'JD0022', 'different current model': 'JD0020',
          'pending legacy tail': 'JD0022', 'physical target': 'JD0023' }[mutation];
        assert.match(result.stderr, new RegExp(expectedCode));
        assert.doesNotMatch(result.stdout, /adopted|up to date/);
        assert.deepEqual(work.inspect(), before);
      }
      finally { work.cleanup(); }
    });
  }
  for (const adopted of [false, true]) {
    it(`snapshot-aware status still verifies ${adopted ? 'exact' : 'unadopted legacy'} authority`, async () => {
      const work = await fixture();
      try {
        if (adopted) {
          work.observe();
          assert.equal(work.adopt().status, 0);
        }
        work.write('snapshot.json', MODEL);
        const changed = structuredClone(MODEL);
        changed.entities.Item.schema.properties.name.maxLength = 20;
        work.write('model.json', changed);
        const args = ['--migrations', work.file('migrations'), '--model', work.file('model.json'),
          '--snapshot', work.file('snapshot.json')];
        const before = work.inspect();
        const status = work.run('status', args);
        assert.deepEqual(work.inspect(), before);
        if (!adopted) {
          assert.equal(status.status, 1);
          assert.match(status.stderr, /JD0028/);
          assert.doesNotMatch(status.stdout, /in sync|up to date/);
          return;
        }
        assert.equal(status.status, 0, status.stderr);
        assert.match(status.stdout, /model:\s+UNPLANNED change/);
        assert.match(status.stdout, /drift:\s+not checked — the model differs from its snapshot/);
        assert.doesNotMatch(status.stdout, /in sync/);
        const check = work.run('check', args);
        assert.equal(check.status, 1);
        assert.match(check.stderr, /unplanned model change/);
        const raw = new DatabaseSync(work.file('app.db'));
        try { raw.exec(`UPDATE "_jaren_migrations" SET checksum = 'edited'`); }
        finally { raw.close(); }
        const mismatch = work.run('status', args);
        assert.equal(mismatch.status, 1);
        assert.match(mismatch.stderr, /JD0022/);
        assert.doesNotMatch(mismatch.stdout, /in sync|up to date/);
      }
      finally { work.cleanup(); }
    });
  }
  it('an exact pending draft previews after adoption and still refuses real execution', async () => {
    const work = await fixture();
    try {
      work.observe();
      assert.equal(work.adopt().status, 0);
      const changed = structuredClone(MODEL);
      changed.entities.Item.schema.properties.handle = { type: 'string' };
      changed.entities.Item.schema.required.push('handle');
      work.write('target.json', changed);
      const exact = planModelMigration(MODEL, changed, { dialect: sqliteDialect, id: '0002-draft' }).migration;
      work.write('migrations/0002.json', exact);
      assert.ok(exact.steps.some((step) => step.draft === true));
      const args = ['--migrations', work.file('migrations'), '--baseline', work.file('model.json'),
        '--model', work.file('target.json')];
      const before = work.inspect();
      const preview = work.run('apply', [...args, '--dry-run']);
      assert.equal(preview.status, 0, preview.stderr);
      assert.match(preview.stdout, /pending: 0002-draft/);
      assert.match(preview.stdout, /DRAFT/);
      assert.deepEqual(work.inspect(), before);
      const apply = work.run('apply', [...args, '--yes']);
      assert.equal(apply.status, 1);
      assert.match(apply.stderr, /JD0021/);
      assert.deepEqual(work.inspect(), before);
    }
    finally { work.cleanup(); }
  });
  it('authoring an exact tail extends adopted history and makes the old observation stale', async () => {
    const work = await fixture();
    try {
      work.observe();
      assert.equal(work.adopt().status, 0);
      const exact = planModelMigration(MODEL, MODEL, { dialect: sqliteDialect, id: '0002-exact' }).migration;
      exact.steps.push({ kind: 'sql', sql: `UPDATE "Item" SET name = 'ADA' WHERE id = 'one'` });
      work.write('migrations/0002.json', exact);
      const result = work.run('apply', ['--migrations', work.file('migrations'), '--baseline', work.file('model.json'), '--model', work.file('model.json'), '--yes']);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /applied: 0002-exact/);
      assert.deepEqual(work.inspect().rows.map((row) => ({ ...row })), [{ id: 'one', name: 'ADA' }]);
      const stale = work.adopt();
      assert.equal(stale.status, 1);
      assert.doesNotMatch(stale.stdout, /adopted/);
    }
    finally { work.cleanup(); }
  });
});

describe('CLI history command misuse is distinct from runtime refusal', () => {
  for (const [command, args] of [
    ['history', []], ['history', ['--store']], ['history', ['--store', '--out', 'observation.json']],
    ['history', ['--store', 'file.db', '--model', 'model.json']], ['history', ['--store', 'file.db', '--yes']],
    ['history', ['--store', 'file.db', '--out']], ['history', ['--unknown']],
    ['adopt-history', []], ['adopt-history', ['--observed']], ['adopt-history', ['--physical-target']],
    ['adopt-history', ['--dry-run']], ['adopt-history', ['--baseline', 'baseline.json']],
    ['apply', ['--observed', 'observed.json']], ['status', ['--physical-target', 'target.json']],
  ]) {
    it(`${command} ${args.join(' ')} exits 2`, () => {
      const result = spawnSync(process.execPath, ['--no-warnings=ExperimentalWarning', CLI, command, ...args], { encoding: 'utf8' });
      assert.equal(result.status, 2, result.stderr);
      assert.equal(result.stdout, '');
    });
  }
});

const collisionModel = (value) => ({ $model: '0.1', collections: { items: { key: '/id', schema: {
  type: 'object', properties: { id: { type: 'string' }, n: { const: value } },
} } } });

describe('CLI model decisions use exact endpoints', () => {
  it('equal short fingerprints still produce a new reviewed plan', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jaren-cli-model-collision-'));
    try {
      const left = collisionModel('159koso'), right = collisionModel('gnt19f');
      assert.equal(shapeHash(left), '15ta7pe');
      assert.equal(shapeHash(right), shapeHash(left));
      const model = join(dir, 'model.json'), snapshot = join(dir, 'snapshot.json'), out = join(dir, 'migration.json');
      writeFileSync(model, JSON.stringify(right));
      writeFileSync(snapshot, JSON.stringify(left));
      const args = ['--no-warnings=ExperimentalWarning', CLI, 'plan', '--model', model, '--snapshot', snapshot, '--out', out];
      const result = spawnSync(process.execPath, args, { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      assert.doesNotMatch(result.stdout, /nothing to plan/);
      const document = JSON.parse(readFileSync(out, 'utf8'));
      assert.equal(document.$migration, '0.2');
      assert.equal(document.from, document.to);
      assert.notEqual(document.identity.from, document.identity.to);
      assert.deepEqual(JSON.parse(document.identity.from), left);
      assert.deepEqual(JSON.parse(document.identity.to), right);
      const artifact = readFileSync(out);
      const repeat = spawnSync(process.execPath, args, { encoding: 'utf8' });
      assert.equal(repeat.status, 0, repeat.stderr);
      assert.match(repeat.stdout, /nothing to plan/);
      assert.deepEqual(readFileSync(out), artifact);
    }
    finally { removeTempDirectory(dir); }
  });
  it('snapshot status names colliding unplanned models while preserving exact history', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jaren-cli-status-collision-'));
    try {
      const left = collisionModel('159koso'), right = collisionModel('gnt19f');
      const file = (name) => join(dir, name);
      const store = await openStore(left, { driver: nodeDriver(), path: file('app.db') });
      await store.close();
      const exact = planModelMigration(left, left, { dialect: sqliteDialect, id: '0001-exact' }).migration;
      await migrate({ driver: nodeDriver(), path: file('app.db') }, [exact], { baseline: left, model: left, shadow: false });
      mkdirSync(file('migrations'));
      writeFileSync(file('migrations/0001.json'), JSON.stringify(exact));
      writeFileSync(file('model.json'), JSON.stringify(right));
      writeFileSync(file('snapshot.json'), JSON.stringify(left));
      const args = ['--store', file('app.db'), '--model', file('model.json'), '--snapshot', file('snapshot.json'), '--migrations', file('migrations')];
      const run = (command) => spawnSync(process.execPath, ['--no-warnings=ExperimentalWarning', CLI, command, ...args], { encoding: 'utf8' });
      const status = run('status');
      assert.equal(status.status, 0, status.stderr);
      assert.match(status.stdout, /model:\s+UNPLANNED change/);
      assert.match(status.stdout, /different exact shapes.*15ta7pe \/ 15ta7pe/);
      assert.match(status.stdout, /drift:\s+not checked/);
      assert.doesNotMatch(status.stdout, /in sync/);
      const check = run('check');
      assert.equal(check.status, 1);
      assert.match(check.stderr, /unplanned model change/);
      assert.deepEqual((await migrate({ driver: nodeDriver(), path: file('app.db') }, [exact], {
        baseline: left, model: left, shadow: false,
      })).applied, []);
    }
    finally { removeTempDirectory(dir); }
  });
});
