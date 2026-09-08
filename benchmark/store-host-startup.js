//@ts-check
/** The measured worker startup includes loading and opening SQLite. */
import { parentPort } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(':memory:');
parentPort?.postMessage(db.prepare('SELECT sqlite_version() AS version').get());
db.close();
