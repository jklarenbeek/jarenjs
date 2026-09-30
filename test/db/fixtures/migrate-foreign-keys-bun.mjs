// Run under Bun by test/db/migrate-foreign-keys.test.js: open a store on a
// file, write a parent and its child, migrate with a step that deletes the
// parent, and report what the child table and the foreign-key check hold.
// bun:sqlite leaves foreign keys off by default; a migration's own
// connection must switch them on, so the cascade the schema declares runs.
import { openStore, migrate, shapeHash } from '@jarenjs/db';
import { bunDriver } from '@jarenjs/db/bun';
import { Database } from 'bun:sqlite';

const [file, model] = process.argv.slice(2);
const MODEL = JSON.parse(model);
const store = await openStore(MODEL, { driver: bunDriver(), path: file });
await store.entity('Parent').create({ id: 'p1' });
await store.entity('Child').create({ id: 'c1', parentId: 'p1' });
await store.close();
const deletion = { $migration: '0.1', id: 'delete-parent', from: shapeHash(MODEL), to: shapeHash(MODEL),
  steps: [{ kind: 'sql', sql: `DELETE FROM "Parent" WHERE "id" = 'p1'` }] };
const outcome = await migrate({ driver: bunDriver(), path: file }, [deletion], { baseline: MODEL, model: MODEL });
let orphanRefused = null;
const orphan = { $migration: '0.1', id: 'orphan', from: shapeHash(MODEL), to: shapeHash(MODEL),
  steps: [{ kind: 'sql', sql: `INSERT INTO "Child" ("id", "parentId", "doc") VALUES ('c2', 'nobody', '{}')` }] };
try { await migrate({ driver: bunDriver(), path: file }, [deletion, orphan], { baseline: MODEL, model: MODEL }); }
catch (error) { orphanRefused = { code: error.code, class: error.class }; }
const db = new Database(file);
const children = db.prepare('SELECT count(*) AS n FROM "Child"').get().n;
const violations = db.prepare('PRAGMA foreign_key_check').all();
db.close();
process.stdout.write(`${JSON.stringify({ runtime: `bun ${process.versions.bun}`, applied: outcome.applied, children,
  violations, orphanRefused })}\n`);
