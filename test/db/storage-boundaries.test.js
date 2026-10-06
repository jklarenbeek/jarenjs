import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openStore, planInvariants, sqliteDialect, classifyDriverError } from '@jarenjs/db';
import { isDriverError, wrapDriverError } from '../../packages/db/src/errors.js';
import { nodeDriver } from '@jarenjs/db/node';
import { postgresDriver } from '@jarenjs/db/postgres';
import { FAMILY_TABLES, familyModel } from './invariant-oracle.js';

const model = {
  $model: '0.1',
  entities: {
    T: {
      schema: {
        type: 'object',
        properties: { id: { type: 'integer', 'x-entity': { key: true } }, big: { type: 'integer' } },
      },
      physical: {
        table: 't',
        columns: {
          id: { name: 'id', codec: 'integer', null: 'reject' },
          big: { name: 'big', codec: 'integer', null: 'null' },
        },
      },
    },
  },
};

describe('storage driver data and acquisition boundaries', () => {
  for (const synchronous of [false, true]) {
    it(`${synchronous ? 'sync' : 'async'} unsafe native integer rows are coded on each public read`, async () => {
      const connection = await nodeDriver().open(':memory:');
      connection.exec('CREATE TABLE t(id INTEGER PRIMARY KEY,big INTEGER);INSERT INTO t VALUES(1,9007199254740993)');
      const store = await openStore(model, { driver: { ...nodeDriver(), open: async () => connection }, adopt: true });
      try {
        const owner = synchronous ? store.sync : store;
        const set = owner.entity('T');
        for (const run of [() => set.get(1), () => set.load({}), () => set.page({}, { limit: 1 })]) {
          await assert.rejects(async () => run(), (error) => {
            assert.deepEqual({ code: error.code, class: error.class, retryable: error.retryable, cause: error.cause?.code },
              { code: 'JD2003', class: 'data', retryable: false, cause: 'ERR_OUT_OF_RANGE' });
            return true;
          });
        }
      }
      finally { await store.close(); }
    });
  }

  it('unrelated host range errors are not classified as database data', () => {
    const unrelated = Object.assign(new RangeError('a host value is out of range'), { code: 'ERR_OUT_OF_RANGE' });
    assert.equal(isDriverError(unrelated), false);
    assert.equal(wrapDriverError(unrelated), unrelated);
    assert.equal(classifyDriverError(unrelated).class, 'error');
    const actual = Object.assign(new RangeError('Value is too large to be represented as a JavaScript number: 9007199254740993'),
      { code: 'ERR_OUT_OF_RANGE' });
    assert.equal(isDriverError(actual), true);
    const wrapped = wrapDriverError(actual);
    assert.equal(wrapped.code, 'JD2003');
    assert.equal(wrapped.class, 'data');
    assert.equal(wrapped.retryable, false);
    assert.equal(wrapped.cause, actual);
  });

  it('caller mutation of a classification cannot change later driver classifications', () => {
    const result = classifyDriverError({ message: 'database is locked' });
    const original = [...result.primaries];
    try {
      result.primaries.splice(0, result.primaries.length, 99);
      for (const errcode of [5, 6]) {
        assert.deepEqual(classifyDriverError({ errcode }), {
          class: 'busy', code: 'JD2005', retryable: true,
          reason: 'the database is busy or locked',
        });
      }
      assert.equal(classifyDriverError({ errcode: 99 }).class, 'error');
      const following = classifyDriverError({ message: 'database table is locked' });
      assert.deepEqual(following.primaries, [5, 6]);
      assert.notEqual(following.primaries, result.primaries);
    }
    finally { result.primaries.splice(0, result.primaries.length, ...original); }
  });

  it('a pool source timeout releases admission and keeps its cause on repeated acquisition', async () => {
    const errors = [];
    const source = {
      connect() {
        const error = new Error('timeout exceeded when trying to connect');
        errors.push(error);
        return Promise.reject(error);
      },
    };
    const driver = postgresDriver(source, { maxConnections: 1 });
    for (let i = 0; i < 2; i++) {
      await assert.rejects(driver.open(), (error) => {
        assert.equal(error.code, 'JD2091');
        assert.equal(error.class, 'queue');
        assert.equal(error.retryable, true);
        assert.equal(error.cause, errors[i]);
        return true;
      });
      assert.equal(driver.metrics().active, 0);
      assert.equal(driver.metrics().queued, 0);
    }
    assert.equal(errors.length, 2);
  });
});

it('native SQLite RETURNING exposes the statement revision while ordinary update reads the AFTER result', async () => {
  const connection = await nodeDriver().open(':memory:');
  connection.exec(FAMILY_TABLES.sqlite);
  const model = familyModel('database');
  for (const statement of planInvariants(model, { dialect: sqliteDialect })) connection.exec(statement.sql);
  const store = await openStore(model, { driver: { ...nodeDriver(), open: async () => connection } });
  try {
    const docs = store.entity('Doc');
    const lines = store.entity('Line');
    await docs.create({ id: 1, status: 'draft', sealed: null });
    await lines.create({ id: 1, doc: 1, qty: 1, note: 'a', revision: 0 });
    const mutation = await lines.mutate({ op: 'update', key: 1, set: { qty: 2 }, returning: ['revision'] });
    assert.deepEqual(mutation.rows, [{ revision: 0 }]);
    assert.equal(mutation.admitted.statements, 1);
    assert.equal((await lines.get(1)).revision, 1);
    assert.equal((await lines.update(1, { qty: 3 })).revision, 2);
  }
  finally { await store.close(); }
});
