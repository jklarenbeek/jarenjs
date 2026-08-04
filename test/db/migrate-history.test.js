//@ts-check
/**
 * @file The history discipline: the migration list must agree with the
 * applied records (same ids, same order, same signature-grade
 * checksums — `JD0022` otherwise), the chain must anchor on the
 * database's recorded shape (`JD0020`), and the baseline is an
 * explicit requirement, never a guess.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import {
  openStore, planMigration, migrate, shapeHash, migrationChecksum, sqliteDialect,
} from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { tempDbPath } from './helpers.js';

const M0 = {
  $model: '0.1',
  collections: {
    users: { schema: { type: 'object', properties: { id: { type: 'string' } } }, key: '/id' },
  },
};
const M1 = {
  $model: '0.1',
  collections: {
    users: M0.collections.users,
    logs: { schema: { type: 'object' }, key: null, identity: 'integer' },
  },
};

const driver = () => nodeDriver();

async function freshAt(model) {
  const { dbPath, cleanup } = tempDbPath();
  const store = await openStore(model, { driver: driver(), path: dbPath });
  await store.close();
  return { dbPath, cleanup };
}

describe('shape anchoring (JD0020)', () => {
  it('a from-hash that does not match the database refuses', async () => {
    const { dbPath, cleanup } = await freshAt(M0);
    try {
      const { migration } = planMigration(M0, M1, { dialect: sqliteDialect, id: '0001' });
      const foreign = { ...migration, from: 'somebody-elses-shape' };
      await assert.rejects(
        () => migrate({ driver: driver(), path: dbPath }, [foreign], { baseline: M0 }),
        (error) => {
          assert.strictEqual(error.code, 'JD0020');
          assert.match(error.message, /somebody-elses-shape/);
          return true;
        });
      // the RIGHT baseline hash accepts (same store, correct chain)
      const out = await migrate({ driver: driver(), path: dbPath }, [migration],
        { baseline: M0, model: M1 });
      assert.deepStrictEqual(out.applied, ['0001']);
    }
    finally {
      cleanup();
    }
  });

  it('a broken chain between two pending migrations refuses', async () => {
    const { dbPath, cleanup } = await freshAt(M0);
    try {
      const first = planMigration(M0, M1, { dialect: sqliteDialect, id: '0001' }).migration;
      const second = { ...first, id: '0002', from: 'not-the-previous-to', to: 'x' };
      await assert.rejects(
        () => migrate({ driver: driver(), path: dbPath }, [first, second], { baseline: M0 }),
        (error) => error.code === 'JD0020');
    }
    finally {
      cleanup();
    }
  });

  it("a target model disagreeing with the chain's end refuses", async () => {
    const { dbPath, cleanup } = await freshAt(M0);
    try {
      const { migration } = planMigration(M0, M1, { dialect: sqliteDialect, id: '0001' });
      await assert.rejects(
        () => migrate({ driver: driver(), path: dbPath }, [migration],
          { baseline: M0, model: M0 }),
        (error) => {
          assert.strictEqual(error.code, 'JD0020');
          assert.match(error.message, /target model/);
          return true;
        });
    }
    finally {
      cleanup();
    }
  });

  it('the baseline is required, and hashes are stable identities', () => {
    assert.throws(
      () => migrate({ driver: driver() }, [], /** @type {any} */ ({})),
      /baseline/);
    assert.strictEqual(shapeHash(M0), shapeHash(structuredClone(M0)),
      'canonicalization makes the hash member-order-proof');
    assert.notStrictEqual(shapeHash(M0), shapeHash(M1));
  });
});

describe('history integrity (JD0022)', () => {
  it('an edited applied migration refuses with the checksum fact', async () => {
    const { dbPath, cleanup } = await freshAt(M0);
    try {
      const { migration } = planMigration(M0, M1, { dialect: sqliteDialect, id: '0001' });
      await migrate({ driver: driver(), path: dbPath }, [migration], { baseline: M0 });

      const edited = structuredClone(migration);
      edited.steps.push({
        kind: 'query', collection: 'users',
        assert: { $for: { it: '$[*]' }, $where: { $eq: ['$it.id', 'x'] }, $return: '$it' },
      });
      assert.notStrictEqual(migrationChecksum(edited), migrationChecksum(migration));
      await assert.rejects(
        () => migrate({ driver: driver(), path: dbPath }, [edited], { baseline: M0 }),
        (error) => {
          assert.strictEqual(error.code, 'JD0022');
          assert.match(error.message, /never be edited/);
          return true;
        });
    }
    finally {
      cleanup();
    }
  });

  it('a list missing an applied migration, or reordered, refuses', async () => {
    const { dbPath, cleanup } = await freshAt(M0);
    try {
      const { migration } = planMigration(M0, M1, { dialect: sqliteDialect, id: '0001' });
      await migrate({ driver: driver(), path: dbPath }, [migration], { baseline: M0 });

      await assert.rejects(
        () => migrate({ driver: driver(), path: dbPath }, [], { baseline: M0 }),
        (error) => error.code === 'JD0022');
      const stranger = { ...migration, id: '9999-stranger' };
      await assert.rejects(
        () => migrate({ driver: driver(), path: dbPath }, [stranger], { baseline: M0 }),
        (error) => error.code === 'JD0022');
    }
    finally {
      cleanup();
    }
  });

  it('an intact list over an applied history is simply up to date', async () => {
    const { dbPath, cleanup } = await freshAt(M0);
    try {
      const { migration } = planMigration(M0, M1, { dialect: sqliteDialect, id: '0001' });
      await migrate({ driver: driver(), path: dbPath }, [migration], { baseline: M0 });
      const out = await migrate({ driver: driver(), path: dbPath }, [migration],
        { baseline: M0, model: M1 });
      assert.deepStrictEqual(out, { applied: [], skipped: ['0001'], upToDate: true });
    }
    finally {
      cleanup();
    }
  });
});
