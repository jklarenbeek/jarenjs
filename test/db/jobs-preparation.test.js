//@ts-check
/** Prepared statement failures share the queue's classified error contract. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { nodeDriver } from '@jarenjs/db/node';
import { createJobEngine } from '../../packages/db/src/jobs.js';

describe('shared jobs statement preparation', () => {
  for (const asynchronous of [false, true]) it(`classifies preparation errors and permits retry (${asynchronous ? 'promise' : 'sync'})`, async () => {
    const connection = await nodeDriver().open(':memory:');
    let failing = true;
    const engine = createJobEngine({ connection: {
      ...connection,
      prepare(sql) {
        if (sql.startsWith('INSERT INTO') && failing) {
          failing = false;
          const error = Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY', errcode: 5 });
          if (asynchronous) return Promise.reject(error);
          throw error;
        }
        const statement = connection.prepare(sql);
        return asynchronous ? Promise.resolve(statement) : statement;
      },
    } });
    try {
      await engine.ready;
      await assert.rejects(async () => engine.enqueue('probe', {}, { id: 'j' }),
        error => error.code === 'JD2005' && error.class === 'busy');
      const id = engine.enqueue('probe', {}, { id: 'j' });
      if (!asynchronous) assert.equal(id, 'j', 'direct SQLite retains its synchronous result');
      assert.equal(await id, 'j');
      assert.equal((await engine.counts()).pending, 1);
      assert.equal((await engine.get('j')).id, 'j');
    } finally { await engine.stopAll(); connection.close(); }
  });
});
