//@ts-check
/** A disposable shadow cannot alias the live database through a native filename. */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { migrationIdentity } from './migration-fixture.js';
import { symlinkSync, linkSync, readFileSync, renameSync, unlinkSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { migrate, readSchema, shapeHash } from '@jarenjs/db';
import { tempDbPath } from './helpers.js';

const driver = process.versions.bun ? (await import('@jarenjs/db/bun')).bunDriver()
  : (await import('@jarenjs/db/node')).nodeDriver();
const baseline = { $model: '0.1', collections: {} };
const migration = { $migration: '0.2', identity: migrationIdentity(baseline), id: 'set', from: shapeHash(baseline), to: shapeHash(baseline),
  steps: [{ kind: 'sql', sql: 'UPDATE item SET n=n+1' }] };
const seed = (db) => db.exec('CREATE TABLE item(n INTEGER);INSERT INTO item VALUES(0)');
const unchanged = (db) => {
  assert.equal(db.prepare('SELECT n FROM item').get([]).n, 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='_jaren_migrations'").get([]).n, 0);
};

for (const borrowed of [false, true]) for (const alias of ['exact', 'dot', 'relative', 'symlink', 'hardlink']) {
  it(`${borrowed ? 'borrowed' : 'owned'} primary refuses a ${alias} shadow before its callbacks`,
    { skip: alias === 'symlink' && process.platform === 'win32' }, async () => {
      const { dbPath: path, cleanup } = tempDbPath();
      const dir = dirname(path);
      const db = await driver.open(path);
      let shadowOpens = 0, shadowCloses = 0, registrations = 0, fixtures = 0;
      try {
        seed(db);
        const physicalTarget = { objects: readSchema(db).objects };
        const before = readFileSync(path);
        let shadowPath = path;
        if (alias === 'dot') shadowPath = `${dir}/./${basename(path)}`;
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
      finally { db.close(); cleanup(); }
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
  const { dbPath: path, cleanup } = tempDbPath();
  const dir = dirname(path), db = await driver.open(path);
  try {
    seed(db);
    await assert.rejects(async () => migrate({ connection: db }, [migration], { baseline, dryRun: true,
      shadowPath: `${dir}/./${basename(path)}`, shadowDriver: { name: driver.name, dialect: driver.dialect, open: driver.open },
      shadowFixture: () => { throw new Error('fixture must not run'); } }), { code: 'JD0021' });
    unchanged(db);
  }
  finally { db.close(); cleanup(); }
});

for (const memory of [false, true]) it(`independent ${memory ? 'memory' : 'explicit file'} shadows validate without primary writes`, async () => {
  const { dbPath, cleanup } = tempDbPath();
  const dir = dirname(dbPath);
  const path = memory ? ':memory:' : dbPath, db = await driver.open(path);
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
  finally { db.close(); cleanup(); }
});

it('both native driver identity hooks agree on the same neutral connection', async () => {
  const { dbPath, cleanup } = tempDbPath();
  const db = await driver.open(dbPath);
  try {
    const { nodeDriver } = await import('@jarenjs/db/node');
    const { bunDriver } = await import('@jarenjs/db/bun');
    assert.equal(await nodeDriver().databaseIdentity(db), await bunDriver().databaseIdentity(db));
    assert.match(await driver.databaseIdentity(db), /^\d+:\d+$/);
  }
  finally { db.close(); cleanup(); }
});

// A path replaced after the open names another file than the connection
// reads. The identity was the path's current file, so a shadow over the
// moved original passed as independent and replay would have written into
// the live database. The identity pinned at open is kept, and a path that no
// longer names that file is refused. Windows refuses to rename or remove an
// open database file, so it cannot produce the case.
const renames = { skip: process.platform === 'win32' && 'Windows refuses to rename an open database file' };

/** The primary at `path`, then its file moved aside and a replacement put at `path`.
 * @param {boolean} [identified] - whether its identity is asked before the replacement */
async function replacedPrimary(identified = true) {
  const { dbPath: path, cleanup } = tempDbPath();
  const dir = dirname(path), moved = join(dir, 'moved.sqlite'), other = join(dir, 'replacement.sqlite');
  const db = await driver.open(path);
  seed(db);
  const pinned = identified ? await driver.databaseIdentity(db) : undefined;
  const replacement = await driver.open(other);
  replacement.exec('CREATE TABLE item(n INTEGER);INSERT INTO item VALUES(41)');
  const replacedBy = await driver.databaseIdentity(replacement);
  await replacement.close();
  renameSync(path, moved);
  renameSync(other, path);
  return { db, path, moved, pinned, replacedBy, cleanup };
}

it('the identity of an open database is the file it read at open, while its path still names that file', renames, async () => {
  const { dbPath: path, cleanup } = tempDbPath();
  const db = await driver.open(path);
  try {
    const first = await driver.databaseIdentity(db);
    assert.match(first, /^\d+:\d+$/);
    assert.equal(await driver.databaseIdentity(db), first);
    assert.equal(await driver.databaseIdentity(db), first, 'every call answers the pinned file');
  }
  finally { db.close(); cleanup(); }
});

it('a path replaced after the open is refused, never identified as the replacement', renames, async () => {
  const { db, pinned, replacedBy, cleanup } = await replacedPrimary();
  try {
    assert.notEqual(pinned, replacedBy);
    await assert.rejects(async () => driver.databaseIdentity(db), (error) => /** @type {any} */ (error).code === 'JD0021'
      && /replaced/.test(/** @type {any} */ (error).message));
    unchanged(db);
  }
  finally { db.close(); cleanup(); }
});

it('a path removed after the open is refused with the same code', renames, async () => {
  const { dbPath: path, cleanup } = tempDbPath();
  const db = await driver.open(path);
  try {
    seed(db);
    await driver.databaseIdentity(db);
    unlinkSync(path);
    await assert.rejects(async () => driver.databaseIdentity(db), { code: 'JD0021' });
  }
  finally { db.close(); cleanup(); }
});

it('a shadow over the moved original of a replaced primary is refused before replay writes it', renames, async () => {
  // nothing asks the primary's identity before its path is replaced: the pin is the open's
  const { db, moved, cleanup } = await replacedPrimary(false);
  let fixtures = 0;
  try {
    await assert.rejects(async () => migrate({ connection: db }, [migration], { baseline, dryRun: true,
      shadowPath: moved, shadowDriver: driver, shadowFixture: () => { fixtures++; } }), { code: 'JD0021', message: /replaced/ });
    unchanged(db);
    assert.equal(fixtures, 0);
  }
  finally { db.close(); cleanup(); }
});
