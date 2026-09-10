//@ts-check
import { readFileSync } from 'node:fs';
import { nodeDriver } from '@jarenjs/db/node';
import { bunDriver } from '@jarenjs/db/bun';
import { migrate, openStore } from '@jarenjs/db';
const [file, input, point] = process.argv.slice(2);
const driver = process.versions.bun ? bunDriver() : nodeDriver();
const spec = JSON.parse(readFileSync(input, 'utf8'));
if (point === 'seed') {
  const db = await driver.open(file);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0');
  for (const sql of spec.seed) db.exec(sql);
  process.exit(0);
}
const wrapped = { ...driver, open: async (...args) => {
  const db = await driver.open(...args);
  return { ...db,
    ...(db.backup ? { backup: { ...db.backup,
      copy: async (...args) => { const result = await db.backup.copy(...args); if (point === 'copy') process.kill(process.pid, 'SIGKILL'); return result; },
      rename: async (...args) => { if (point === 'publish-before') process.kill(process.pid, 'SIGKILL'); const result = await db.backup.rename(...args); if (point === 'publish-after') process.kill(process.pid, 'SIGKILL'); return result; },
    } } : {}),
    exec: (sql) => {
      const result = db.exec(sql);
      if ((point === 'rebuild' && /^INSERT INTO "receipt__rebuild"/.test(sql))
        || (point === 'drop' && /^DROP TABLE "receipt"/.test(sql))
        || (point === 'commit' && sql === 'COMMIT')) process.kill(process.pid, 'SIGKILL');
      return result;
    },
  };
} };
if (point.startsWith('publish') || point === 'copy') {
  const store = await openStore(spec.model, { driver: wrapped, path: file, adopt: true });
  await store.backupTo(`${file}.backup`, { checkpoint: false });
  await store.close();
}
else await migrate({ driver: wrapped, path: file }, spec.migrations, { baseline: spec.baseline, model: spec.model, shadow: false });
