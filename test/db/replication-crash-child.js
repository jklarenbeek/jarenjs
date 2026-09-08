//@ts-check
/** A disposable process dies on either side of the actual SQLite commit. */
import { DatabaseSync } from 'node:sqlite';
import { openStore, finishConnection } from '@jarenjs/db';
import { adaptNodeDatabase } from '@jarenjs/db/node';
import { replicationModel } from './oracle/replication.js';

const [path, phase, encoded] = process.argv.slice(2);
const driver = {
  name: 'replication-crash',
  open() {
    const raw = adaptNodeDatabase(new DatabaseSync(path));
    const prepare = raw.prepare.bind(raw);
    const wrapped = { ...raw, prepare(sql) {
      const statement = prepare(sql);
      if (phase !== 'before' || !sql.startsWith('UPDATE _jaren_replica SET')) return statement;
      return { ...statement, run(params) {
        const result = statement.run(params);
        process.kill(process.pid, 'SIGKILL');
        return result;
      } };
    } };
    return finishConnection(wrapped, raw.dialect, true, raw.capabilities, 5000);
  },
};
const store = await openStore(replicationModel, { path, driver, capture: { mode: 'journal' }, replication: { replica: 'target' } });
await store.replication.apply(JSON.parse(encoded));
if (phase === 'after') process.kill(process.pid, 'SIGKILL');
await store.close();
