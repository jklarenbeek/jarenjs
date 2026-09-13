//@ts-check
import { readFileSync } from 'node:fs';
import { nodeDriver } from '@jarenjs/db/node';
import { bunDriver } from '@jarenjs/db/bun';
import { migrate, openStore } from '@jarenjs/db';
import { crashAt } from './fixtures/abrupt-exit.js';
const [file, input, point] = process.argv.slice(2);
const driver = process.versions.bun ? bunDriver() : nodeDriver();
const spec = JSON.parse(readFileSync(input, 'utf8'));
if (point === 'seed') {
  const db = await driver.open(file);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0');
  for (const sql of spec.seed) db.exec(sql);
  process.exit(0);
}
// Migration statements and the driver's own COMMIT share the native seam.
const intercept = (db, execute) => new Proxy(db, {
  get(target, key) {
    if (key === execute) return (sql) => {
      const result = target[execute](sql);
      if ((point === 'rebuild' && /^INSERT INTO "receipt__rebuild"/.test(sql))
        || (point === 'drop' && /^DROP TABLE "receipt"/.test(sql))
        || (point === 'commit' && sql === 'COMMIT')) crashAt(point);
      return result;
    };
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});
const wrapped = { ...driver, open: async (...args) => {
  if (['rebuild', 'drop', 'commit'].includes(point)) {
    if (process.versions.bun) {
      const [{ Database }, { adaptBunDatabase }] = await Promise.all([import('bun:sqlite'), import('@jarenjs/db/bun')]);
      return adaptBunDatabase(intercept(new Database(args[0]), 'run'));
    }
    const [{ DatabaseSync }, { adaptNodeDatabase }] = await Promise.all([import('node:sqlite'), import('@jarenjs/db/node')]);
    return adaptNodeDatabase(intercept(new DatabaseSync(args[0]), 'exec'));
  }
  const db = await driver.open(...args);
  return { ...db,
    ...(db.backup ? { backup: { ...db.backup,
      copy: async (...args) => { const result = await db.backup.copy(...args); if (point === 'copy') crashAt(point); return result; },
      rename: async (...args) => { if (point === 'publish-before') crashAt(point); const result = await db.backup.rename(...args); if (point === 'publish-after') crashAt(point); return result; },
    } } : {}),
  };
} };
if (point.startsWith('publish') || point === 'copy') {
  const store = await openStore(spec.model, { driver: wrapped, path: file, adopt: true });
  await store.backupTo(`${file}.backup`, { checkpoint: false });
  await store.close();
}
else await migrate({ driver: wrapped, path: file }, spec.migrations, { baseline: spec.baseline, model: spec.model, shadow: false });
