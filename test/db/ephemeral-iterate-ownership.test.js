//@ts-check
/** A refused cursor never owns its ephemeral preparation. */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { nodeWorkerDriver } from '@jarenjs/db/node-worker';
import { nodeWorkerPoolDriver } from '@jarenjs/db/node-pool';
import { nodeProcessDriver } from '@jarenjs/db/node-process';
import { serveSqliteEndpoint } from '../../packages/db/src/drivers/sqlite-endpoint.js';

/** @type {[string, (limits: any) => any][]} */
const HOSTS = [
  ['worker', (limits) => nodeWorkerDriver(limits)],
  ['pool', (limits) => nodeWorkerPoolDriver({ readers: 0, worker: limits })],
];
// The process host requires Node 24+; Bun exercises workers and their pool.
if (!process.versions.bun) HOSTS.push(['process', (limits) => nodeProcessDriver(limits)]);

/** Pin the pool's writer so a second cursor reaches the endpoint's limit.
 * @param {string} host @param {(limits: any) => any} driver
 * @param {number} maxStatements @param {(connection: any) => Promise<void>} run
 */
async function withConnection(host, driver, maxStatements, run) {
  const connection = await driver({ maxStatements, maxCursors: 1, windowRows: 1 }).open(':memory:');
  try {
    if (host === 'pool') await connection.transaction(run);
    else await run(connection);
  }
  finally { await connection.close(); }
}

const cursorCapacity = { code: 'JD2092', message: 'JD2092: worker cursor capacity 1 exceeded' };
const bindingFailure = { code: 'ERR_SQLITE_ERROR', message: 'column index out of range' };
const transient = { readOnly: true, ephemeral: true };

for (const [host, driver] of HOSTS) {
  it(`${host}: repeated cursor-capacity refusals release unowned ephemeral preparations`, async () => {
    await withConnection(host, driver, 2, async (connection) => {
      const first = await connection.prepare('SELECT 1 AS n UNION ALL SELECT 2', transient);
      const cursor = await first.iterate([]);
      try {
        assert.deepEqual(await cursor.next(), { done: false, value: { n: 1 } });
        for (let attempt = 0; attempt < 20; attempt++) {
          const refused = await connection.prepare('SELECT 3 AS n', transient);
          await assert.rejects(refused.iterate([]), cursorCapacity, `refusal ${attempt}`);
        }
        assert.deepEqual(await cursor.next(), { done: false, value: { n: 2 } });
      }
      finally { await cursor.return(); }
      const next = await connection.prepare('SELECT 4 AS n', transient);
      assert.deepEqual(await next.all([]), [{ n: 4 }]);
    });
  });

  it(`${host}: iterator binding failures preserve their error and release ephemeral capacity`, async () => {
    await withConnection(host, driver, 1, async (connection) => {
      for (let attempt = 0; attempt < 20; attempt++) {
        const refused = await connection.prepare('SELECT ? AS n', transient);
        await assert.rejects(refused.iterate([1, 2]), bindingFailure, `refusal ${attempt}`);
      }
      const next = await connection.prepare('SELECT 4 AS n', transient);
      assert.deepEqual(await next.all([]), [{ n: 4 }]);
    });
  });

  it(`${host}: retained statements remain reusable after cursor-capacity and binding refusals`, async () => {
    await withConnection(host, driver, 2, async (connection) => {
      const first = await connection.prepare('SELECT 1 AS n', transient);
      const retained = await connection.prepare('SELECT ? AS n');
      const cursor = await first.iterate([]);
      try {
        await assert.rejects(retained.iterate([2]), cursorCapacity);
      }
      finally { await cursor.return(); }
      await assert.rejects(retained.iterate([1, 2]), bindingFailure);
      assert.deepEqual(await retained.get([2]), { n: 2 });
      assert.deepEqual(await retained.all([3]), [{ n: 3 }]);
      assert.deepEqual(await retained.get([4]), { n: 4 });
      await retained.finalize();
    });
  });

  it(`${host}: refusal preserves an ephemeral statement already owned by an active cursor`, async () => {
    await withConnection(host, driver, 1, async (connection) => {
      const first = await connection.prepare('SELECT 1 AS n UNION ALL SELECT 2', transient);
      const cursor = await first.iterate([]);
      try {
        assert.deepEqual(await cursor.next(), { done: false, value: { n: 1 } });
        if (host === 'pool') {
          // A pool's ephemeral logical statement prepares a new physical
          // handle for every iteration, so the statement limit comes first.
          await assert.rejects(first.iterate([]), {
            code: 'JD2092', message: 'JD2092: worker statement capacity 1 exceeded',
          });
        }
        else await assert.rejects(first.iterate([]), cursorCapacity);
        await assert.rejects(async () => {
          const extra = await connection.prepare('SELECT 3 AS n', transient);
          await extra.get([]);
        }, { code: 'JD2092', message: 'JD2092: worker statement capacity 1 exceeded' });
        assert.deepEqual(await cursor.next(), { done: false, value: { n: 2 } });
      }
      finally { await cursor.return(); }
      const next = await connection.prepare('SELECT 4 AS n', transient);
      assert.deepEqual(await next.all([]), [{ n: 4 }]);
    });
  });
}

it('endpoint admission keeps cursor-capacity precedence over a missing statement identity', async () => {
  let receive;
  let response;
  let sequence = 0;
  await serveSqliteEndpoint({
    postMessage: (frame) => { response = frame; },
    on: (_event, callback) => { receive = callback; },
    close() {},
  }, { generation: 1, path: ':memory:', options: {},
    limits: { statements: 1, cursors: 1, rows: 1, bytes: 1024 } });
  const request = (op, data = {}) => {
    receive({ v: 1, generation: 1, kind: 'request', id: ++sequence, op, ...data });
    return response;
  };
  try {
    const statement = request('prepare', { sql: 'SELECT 1 AS n', ephemeral: true }).value;
    const cursor = request('iterate', { statement, params: [] }).value;
    assert.equal(request('iterate', { statement: 999, params: [] }).error.code, 'JD2092');
    assert.equal(response.error.message, cursorCapacity.message);
    request('return', { cursor });
    assert.equal(request('iterate', { statement: 999, params: [] }).error.code, 'JD2090');
  }
  finally { request('close'); }
});
