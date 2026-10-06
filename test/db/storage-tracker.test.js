import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';

const model = {
  $model: '0.1',
  entities: {
    Item: {
      schema: {
        type: 'object', required: ['id'],
        properties: { id: { type: 'string', 'x-entity': { key: true } }, value: { type: 'integer' } },
      },
    },
  },
};

describe('tracker staged intent survives refusal and rollback', () => {
  for (const synchronous of [false, true]) {
    const name = synchronous ? 'sync' : 'async';
    for (const existing of [false, true]) {
      it(`${name}: add refuses a pending removal without changing either staged map (${existing ? 'existing' : 'absent'} key)`, async () => {
        const store = await openStore(model, { driver: nodeDriver() });
        try {
          const owner = synchronous ? store.sync : store;
          const items = owner.entity('Item');
          if (existing) await items.create({ id: 'x', value: 1 });
          items.remove('x');
          assert.throws(() => items.add({ id: 'x', value: 2 }), { code: 'JD2003', message: /pending remov|pending delet/ });
          const report = await owner.saveChanges();
          assert.equal(report.inserted, 0);
          assert.equal(report.deleted, existing ? 1 : 0);
          assert.equal(await items.asNoTracking().get('x'), undefined);
          assert.equal((await owner.saveChanges()).statements.length, 0);
        }
        finally { await store.close(); }
      });
    }

    it(`${name}: later put after an explicit-key insert survives outer rollback and saves exactly once`, async () => {
      const store = await openStore(model, { driver: nodeDriver() });
      try {
        const owner = synchronous ? store.sync : store;
        const items = owner.entity('Item');
        items.add({ id: 'x', value: 1 });
        await assert.rejects(store.transaction(async (tx) => {
          const scope = synchronous ? tx.sync : tx;
          assert.equal((await scope.saveChanges()).inserted, 1);
          scope.entity('Item').put({ id: 'x', value: 2 });
          throw new Error('rollback');
        }), /rollback/);
        assert.equal((await owner.saveChanges()).inserted, 1);
        assert.deepEqual(await items.asNoTracking().get('x'), { id: 'x', value: 2 });
        assert.equal((await owner.saveChanges()).statements.length, 0);
      }
      finally { await store.close(); }
    });

    it(`${name}: an inner rollback keeps later explicit-key put while the outer transaction can retry`, async () => {
      const store = await openStore(model, { driver: nodeDriver() });
      try {
        const owner = synchronous ? store.sync : store;
        owner.entity('Item').add({ id: 'x', value: 1 });
        await store.transaction(async (tx) => {
          await assert.rejects(tx.transaction(async (inner) => {
            const scope = synchronous ? inner.sync : inner;
            assert.equal((await scope.saveChanges()).inserted, 1);
            scope.entity('Item').put({ id: 'x', value: 2 });
            throw new Error('inner');
          }), /inner/);
          const scope = synchronous ? tx.sync : tx;
          assert.equal((await scope.saveChanges()).inserted, 1);
        });
        assert.deepEqual(await owner.entity('Item').asNoTracking().get('x'), { id: 'x', value: 2 });
        assert.equal((await owner.saveChanges()).statements.length, 0);
      }
      finally { await store.close(); }
    });
  }
});
