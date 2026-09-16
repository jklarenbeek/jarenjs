//@ts-check
/** Build defines select the host; every executable runs the same application oracle. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { qualifyBackendApp } from './backend-app.js';

async function main() {
  const directory = mkdtempSync(join(tmpdir(), 'jaren-backend-executable-'));
  let pool, searchPath;
  const schemas = [];
  try {
    let targets;
    const backend = process.env.JAREN_BACKEND ?? 'sqlite';
    const runtime = typeof Bun === 'undefined' ? 'node' : 'bun';
    if (process.env.JAREN_RUNTIME && process.env.JAREN_RUNTIME !== runtime)
      throw new TypeError('the selected runtime does not match the executable');
    if (process.env.JAREN_BACKEND === 'postgres') {
      if (!process.env.JAREN_PG_URL) throw new TypeError('the PostgreSQL host requires JAREN_PG_URL');
      const { default: pg } = await import('pg');
      const { postgresDriver } = await import('@jarenjs/db/postgres');
      pool = new pg.Pool({ connectionString: process.env.JAREN_PG_URL, max: 1, connectionTimeoutMillis: 5000 });
      searchPath = (await pool.query('SHOW search_path')).rows[0].search_path;
      const prefix = `jaren_executable_${randomUUID().replaceAll('-', '')}`;
      for (const name of ['app', 'peer']) {
        const schema = `${prefix}_${name}`;
        await pool.query(`CREATE SCHEMA "${schema}"`); schemas.push(schema);
      }
      targets = schemas.map((schema, i) => ({ driver: postgresDriver(pool, { schema, maxConnections: 1 }),
        replication: { replica: ['app', 'peer'][i] } }));
    }
    else {
      if (backend !== 'sqlite') throw new TypeError('JAREN_BACKEND must select sqlite or postgres');
      const factory = process.env.JAREN_RUNTIME === 'bun'
        || (!process.env.JAREN_RUNTIME && typeof Bun !== 'undefined')
        ? (await import('@jarenjs/db/bun')).bunDriver
        : (await import('@jarenjs/db/node')).nodeDriver;
      targets = ['app', 'peer'].map(name => ({ driver: factory(), path: join(directory, `${name}.sqlite`),
        replication: { replica: name } }));
    }
    const result = await qualifyBackendApp(...targets);
    if (pool) {
      assert.equal(pool.waitingCount, 0); assert.equal(pool.idleCount, pool.totalCount);
      assert.equal((await pool.query('SHOW search_path')).rows[0].search_path, searchPath);
    }
    process.stdout.write(JSON.stringify({ backend, runtime,
      version: runtime === 'bun' ? globalThis.Bun.version : process.versions.node, ...result }) + '\n');
  }
  finally {
    try {
      if (pool) {
        try { for (const schema of schemas) await pool.query(`DROP SCHEMA "${schema}" CASCADE`); }
        finally { await pool.end(); }
      }
    }
    finally { rmSync(directory, { recursive: true, force: true }); }
  }
}
main().catch(error => { process.stderr.write(String(error.stack ?? error) + '\n'); process.exitCode = 1; });
