//@ts-check
/** Child process intentionally exits with a committed, uncheckpointed WAL. */
import { DatabaseSync } from 'node:sqlite';
import { readAdoption } from './evidence.js';

const fixture = readAdoption('fixtures/relational.json');
const db = new DatabaseSync(process.argv[2]);
db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA foreign_keys=ON');
for (const sql of [...fixture.ddl, ...fixture.seed]) db.exec(sql);
db.exec("BEGIN IMMEDIATE; INSERT INTO receipt(body) VALUES (X'0001ff'); COMMIT");
process.exit(0);
