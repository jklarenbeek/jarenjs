//@ts-check
/** Kill only this disposable client at a real server persistence boundary. */
import { writeSync } from 'node:fs';
import pg from 'pg';
import { openStore } from '@jarenjs/db';
import { postgresDriver } from '@jarenjs/db/postgres';
import { replicationModel } from './oracle/replication.js';

const [schema, phase, encoded] = process.argv.slice(2);
let armed = false;
function crash() {
  writeSync(1, `crash:${phase}\n`);
  process.kill(process.pid, 'SIGKILL');
}
const pool = new pg.Pool({ connectionString: process.env.JAREN_PG_URL, max: 1 });
const source = { connect: async () => {
  const client = await pool.connect();
  return { release: (error) => client.release(error), query: async (query, values) => {
    const text = typeof query === 'string' ? query : query.text;
    const result = await client.query(query, values);
    if (armed && ((phase === 'receipt' && text.startsWith('INSERT INTO _jaren_replica_receipts'))
      || (phase === 'checkpoint' && text.startsWith('UPDATE _jaren_replica SET'))
      || (phase === 'commit' && text === 'COMMIT'))) crash();
    return result;
  } };
} };
try {
  const store = await openStore(replicationModel, { driver: postgresDriver(source, { schema }),
    capture: { mode: 'journal', log: true }, replication: { replica: 'target' } });
  try {
    armed = true;
    await store.replication.apply(JSON.parse(encoded));
    if (phase === 'acknowledged') crash();
  }
  finally { await store.close(); }
}
finally { await pool.end(); }
