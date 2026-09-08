//@ts-check
import { it } from 'node:test';
import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { replicationModel } from './oracle/replication.js';
import { tempDbPath } from './helpers.js';

for (const phase of ['before', 'after']) it(`a process killed ${phase} commit never separates data from acknowledgement`, async () => {
  const temp = tempDbPath();
  const source = await openStore(replicationModel, { driver: nodeDriver(), replication: { replica: 'source' } });
  let target;
  try {
    await source.collection('notes').put({ id: 'durable', n: 7 });
    const envelope = (await source.replication.page()).items[0];
    const child = spawnSync(process.execPath, ['--no-warnings=ExperimentalWarning',
      new URL('./replication-crash-child.js', import.meta.url).pathname, temp.dbPath, phase, JSON.stringify(envelope)], { encoding: 'utf8' });
    assert.equal(child.signal, 'SIGKILL', child.stderr);
    target = await openStore(replicationModel, { path: temp.dbPath, driver: nodeDriver(), replication: { replica: 'target' } });
    assert.deepEqual(await target.replication.frontier(), phase === 'before' ? {} : { source: 1 });
    assert.equal((await target.collection('notes').get('durable'))?.n, phase === 'before' ? undefined : 7);
    assert.equal((await target.replication.apply(envelope)).status, phase === 'before' ? 'applied' : 'duplicate');
    assert.equal((await target.collection('notes').get('durable')).n, 7);
  }
  finally { await source.close(); await target?.close(); temp.cleanup(); }
});
