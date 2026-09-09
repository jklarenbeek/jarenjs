//@ts-check
import { it } from 'node:test';
import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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
      fileURLToPath(new URL('./replication-crash-child.js', import.meta.url)), temp.dbPath, phase, JSON.stringify(envelope)],
    { encoding: 'utf8', timeout: 30_000 });
    assert.equal(child.error, undefined);
    assert.equal(child.stderr, '');
    assert.equal(child.stdout, `crash:${phase}\n`, 'the child reached the requested commit boundary');
    // A self-kill uses TerminateProcess(..., 1) on Windows; its parent
    // observes that exit status, without a POSIX termination signal.
    assert.equal(child.signal, process.platform === 'win32' ? null : 'SIGKILL');
    assert.equal(child.status, process.platform === 'win32' ? 1 : null);
    target = await openStore(replicationModel, { path: temp.dbPath, driver: nodeDriver(), replication: { replica: 'target' } });
    assert.deepEqual(await target.replication.frontier(), phase === 'before' ? {} : { source: 1 });
    assert.equal((await target.collection('notes').get('durable'))?.n, phase === 'before' ? undefined : 7);
    assert.equal((await target.replication.apply(envelope)).status, phase === 'before' ? 'applied' : 'duplicate');
    assert.equal((await target.collection('notes').get('durable')).n, 7);
  }
  finally { await source.close(); await target?.close(); temp.cleanup(); }
});
