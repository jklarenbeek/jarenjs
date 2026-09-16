//@ts-check
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { postgresDriver } from '@jarenjs/db/postgres';
import { qualifyBackendApp } from '../consumer/backend-app.js';

const url = process.env.JAREN_PG_URL;
it('the same public application settles on PostgreSQL with a single injected client',
  { skip: !url && 'JAREN_PG_URL is not set' }, async () => {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString: url, max: 1 });
    const schemas = ['app', 'peer'].map(name => `jaren_app_${process.pid}_${name}`);
    const targets = schemas.map((schema, i) => ({ driver: postgresDriver(pool, { schema, maxConnections: 1 }),
      replication: { replica: ['app', 'peer'][i] } }));
    try {
      for (const schema of schemas) await pool.query(`CREATE SCHEMA "${schema}"`);
      await qualifyBackendApp(...targets);
      for (const target of targets) assert.equal(target.driver.metrics().active, 0);
      assert.equal(pool.waitingCount, 0);
      assert.equal(pool.idleCount, pool.totalCount);
    }
    finally {
      for (const schema of schemas) await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
    }
  });
