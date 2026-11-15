// Runs under Bun: the Bun driver pins a database's file identity at open, and
// refuses one whose path was replaced after the open, as the Node driver does.
import { mkdtempSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate, shapeHash } from '@jarenjs/db';
import { migrationIdentity } from '../migration-fixture.js';
import { bunDriver } from '@jarenjs/db/bun';

const failures = [];
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jaren-replaced-path-bun-')));
const driver = bunDriver();
let db;
try {
  const path = join(dir, 'store.sqlite'), moved = join(dir, 'moved.sqlite'), other = join(dir, 'replacement.sqlite');
  db = await driver.open(path);
  db.exec('CREATE TABLE item(n INTEGER);INSERT INTO item VALUES(0)');
  const replacement = await driver.open(other);
  replacement.exec('CREATE TABLE item(n INTEGER);INSERT INTO item VALUES(41)');
  await replacement.close();
  renameSync(path, moved);
  renameSync(other, path);
  const code = async (run) => { try { await run(); return 'answered'; } catch (error) { return error?.code ?? String(error); } };
  const identity = await code(() => driver.databaseIdentity(db));
  if (identity !== 'JD0021') failures.push(`the identity of a replaced path: ${identity} (expected JD0021)`);
  const baseline = { $model: '0.1', collections: {} };
  const migration = { $migration: '0.2', identity: migrationIdentity(baseline), id: 'set', from: shapeHash(baseline),
    to: shapeHash(baseline), steps: [{ kind: 'sql', sql: 'UPDATE item SET n=n+1' }] };
  const shadow = await code(() => migrate({ connection: db }, [migration], { baseline, dryRun: true, shadowPath: moved,
    shadowDriver: driver, shadowFixture: () => failures.push('the shadow fixture ran over the primary\'s own file') }));
  if (shadow !== 'JD0021') failures.push(`a shadow over the moved original: ${shadow} (expected JD0021)`);
  const n = db.prepare('SELECT n FROM item').get([]).n;
  if (n !== 0) failures.push(`the primary reads ${n} (expected 0)`);
}
catch (error) { failures.push(String(error?.stack ?? error)); }
finally {
  try { db?.close(); }
  catch (error) { failures.push(`closing the database: ${String(error?.stack ?? error)}`); }
  try { rmSync(dir, { recursive: true, force: true }); }
  catch (error) { failures.push(`removing ${dir}: ${String(error?.stack ?? error)}`); }
}
process.stdout.write(`${JSON.stringify({ runtime: typeof Bun === 'undefined' ? 'node' : 'bun', failures })}\n`);
process.exit(failures.length === 0 ? 0 : 1);
