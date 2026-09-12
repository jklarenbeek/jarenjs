//@ts-check
import { readFileSync } from 'node:fs';
import { applyTableMigration } from '@jarenjs/db/relational';
const runtime = process.versions.bun ? await import('@jarenjs/db/bun') : await import('@jarenjs/db/node');
const driver = process.versions.bun ? runtime.bunDriver() : runtime.nodeDriver();
const db = await driver.open(process.argv[2]);
db.exec('PRAGMA foreign_keys=ON');
const plan = JSON.parse(readFileSync(process.argv[3], 'utf8'));
const connection = { ...db, exec(statement) {
  const result = db.exec(statement);
  if (statement === plan.finish[0]) process.kill(process.pid, 'SIGKILL');
  return result;
} };
applyTableMigration(connection, plan);
throw new Error('the crash boundary was not reached');
