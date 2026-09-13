//@ts-check
/** A disposable shadow cannot alias the live database through a native filename. */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync, linkSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { migrate, readSchema, shapeHash } from '@jarenjs/db';

const driver = process.versions.bun ? (await import('@jarenjs/db/bun')).bunDriver()
  : (await import('@jarenjs/db/node')).nodeDriver();
const baseline = { $model: '0.1', collections: {} };
const migration = { $migration: '0.1', id: 'set', from: shapeHash(baseline), to: shapeHash(baseline),
  steps: [{ kind: 'sql', sql: 'UPDATE item SET n=n+1' }] };
const seed = (db) => db.exec('CREATE TABLE item(n INTEGER);INSERT INTO item VALUES(0)');
const unchanged = (db) => {
  assert.equal(db.prepare('SELECT n FROM item').get([]).n, 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='_jaren_migrations'").get([]).n, 0);
};

for (const borrowed of [false, true]) for (const alias of ['exact', 'dot', 'relative', 'symlink', 'hardlink']) {
  it(`${borrowed ? 'borrowed' : 'owned'} primary refuses a ${alias} shadow before its callbacks`,
    { skip: alias === 'symlink' && process.platform === 'win32' }, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'jaren-shadow-identity-'));
      const path = join(dir, 'live.sqlite');
      const db = await driver.open(path);
      let shadowOpens = 0, shadowCloses = 0, registrations = 0, fixtures = 0;
      try {
        seed(db);
        const physicalTarget = { objects: readSchema(db).objects };
        const before = readFileSync(path);
        let shadowPath = path;
        if (alias === 'dot') shadowPath = `${dir}/./live.sqlite`;
        if (alias === 'relative') shadowPath = relative(process.cwd(), path);
        if (alias === 'symlink' || alias === 'hardlink') {
          shadowPath = join(dir, 'alias.sqlite');
          (alias === 'symlink' ? symlinkSync : linkSync)(path, shadowPath);
        }
        const shadowDriver = { ...driver, open: async (...args) => {
          shadowOpens++;
          const shadow = await driver.open(...args);
          return { ...shadow, close() { shadowCloses++; return shadow.close(); } };
        } };
        for (let run = 0; run < 2; run++) {
          await assert.rejects(async () => migrate(borrowed ? { connection: db } : { driver, path }, [migration], {
            baseline, physicalTarget, dryRun: true, shadowPath, shadowDriver,
            registerFunctions: () => { registrations++; }, shadowFixture: () => { fixtures++; },
          }), { code: 'JD0021' });
          unchanged(db);
          assert.deepEqual(readFileSync(path), before, 'dry-run refusal leaves primary file bytes unchanged');
        }
        assert.equal(registrations, 2, 'only primary registration runs');
        assert.equal(fixtures, 0);
        assert.equal(shadowCloses, shadowOpens, 'every separately acquired alias handle closes once');
      }
      finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
    });
}

it('an injected opener returning the primary handle never closes the borrowed connection', async () => {
  const db = await driver.open(':memory:');
  let closes = 0, fixtures = 0;
  const connection = { ...db, close() { closes++; return db.close(); } };
  try {
    seed(db);
    for (let run = 0; run < 2; run++) {
      await assert.rejects(async () => migrate({ connection }, [migration], { baseline, dryRun: true,
        shadowDriver: { ...driver, open: () => connection }, shadowFixture: () => { fixtures++; } }), { code: 'JD0021' });
      unchanged(db);
    }
    assert.equal(closes, 0); assert.equal(fixtures, 0);
  }
  finally { db.close(); }
});

it('an injected SQLite driver without the identity hook still rejects canonical path aliases', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jaren-shadow-fallback-'));
  const path = join(dir, 'live.sqlite'), db = await driver.open(path);
  try {
    seed(db);
    await assert.rejects(async () => migrate({ connection: db }, [migration], { baseline, dryRun: true,
      shadowPath: `${dir}/./live.sqlite`, shadowDriver: { name: driver.name, dialect: driver.dialect, open: driver.open },
      shadowFixture: () => { throw new Error('fixture must not run'); } }), { code: 'JD0021' });
    unchanged(db);
  }
  finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

for (const memory of [false, true]) it(`independent ${memory ? 'memory' : 'explicit file'} shadows validate without primary writes`, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jaren-shadow-independent-'));
  const path = memory ? ':memory:' : join(dir, 'live.sqlite'), db = await driver.open(path);
  let fixtures = 0;
  try {
    seed(db);
    const physicalTarget = { objects: readSchema(db).objects };
    for (let run = 0; run < 2; run++) {
      const result = await migrate({ connection: db }, [migration], { baseline, physicalTarget, dryRun: true,
        shadowDriver: driver, shadowPath: memory ? ':memory:' : join(dir, `shadow-${run}.sqlite`),
        shadowFixture: (shadow) => { fixtures++; seed(shadow); } });
      assert.equal(result.shadowValidated, true);
      assert.deepEqual(result.pending, ['set']);
      unchanged(db);
    }
    assert.equal(fixtures, 2);
    if (memory) {
      const result = await migrate({ driver, path }, [migration], { baseline, dryRun: true,
        shadowPath: ':memory:', shadowFixture: seed });
      assert.equal(result.shadowValidated, true, 'two explicit :memory: names are distinct databases');
    }
  }
  finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

it('both native driver identity hooks agree on the same neutral connection', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jaren-shadow-hooks-'));
  const db = await driver.open(join(dir, 'live.sqlite'));
  try {
    const { nodeDriver } = await import('@jarenjs/db/node');
    const { bunDriver } = await import('@jarenjs/db/bun');
    assert.equal(await nodeDriver().databaseIdentity(db), await bunDriver().databaseIdentity(db));
    assert.match(await driver.databaseIdentity(db), /^\d+:\d+$/);
  }
  finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
