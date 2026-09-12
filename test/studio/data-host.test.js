import { it } from 'node:test';
import assert from 'node:assert/strict';
import { nodeDriver } from '@jarenjs/db/node';
import { isContractFailure } from '@jarenjs/contract';
import { createDataHandlers } from '@jarenjs/studio/data/host';

it('disposal refuses new operations and closes a real store whose open finishes late', async () => {
  const entered = Promise.withResolvers(), resume = Promise.withResolvers();
  const driver = nodeDriver();
  let closes = 0, announcements = 0;
  const table = createDataHandlers({
    init: async () => ({}), makeScratchDriver: () => driver,
    makeDriver: () => ({ ...driver, open: async (...args) => {
      const connection = await driver.open(...args);
      entered.resolve(); await resume.promise;
      return { ...connection, close: async () => { closes++; await connection.close(); } };
    } }),
    path: () => ':memory:', vfs: () => 'node', durable: () => false,
    unlink: () => {}, announce: () => { announcements++; }, operators: undefined,
  });
  const opening = table.handlers['data.open']({ model: { $model: '0.1', collections: { rows: { schema: { type: 'object' }, key: '/id' } } } });
  await entered.promise;
  await table.dispose(); await table.dispose();
  assert.ok(isContractFailure(await table.handlers['data.init']({})));
  resume.resolve();
  assert.ok(isContractFailure(await opening));
  assert.equal(table.state.store, null);
  assert.equal(table.state.lives.size, 0);
  assert.equal(closes, 1);
  assert.equal(announcements, 0);
});
