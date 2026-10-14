//@ts-check
/**
 * @file `createDbLedger` over PostgreSQL under the same kit the memory
 * ledger runs — the ledger contract and the rules of a ledger a host
 * operates, a bounded `sweep(now, { limit })` among them — one schema per
 * ledger, dropped afterwards. Runs where JAREN_PG_URL names a server.
 */

import { after, before, describe, it } from 'node:test';

import { idempotencyLedgerModel } from '@jarenjs/contract/ledger';
import { postgresDriver } from '@jarenjs/db/postgres';
import { open, createDbLedger } from '@jarenjs/linq/db';

import { ledgerContract, ledgerLifecycleContract } from '../contract/ledger-contract.js';

const url = process.env.JAREN_PG_URL;

/** @type {any} */
let admin = null;
/** @type {any} */
let pool = null;
const schemas = /** @type {string[]} */ ([]);

before(async () => {
  if (!url) return;
  const pg = (await import('pg')).default;
  admin = new pg.Client({ connectionString: url });
  await admin.connect();
  pool = new pg.Pool({ connectionString: url, max: 2 });
});
after(async () => {
  await pool?.end().catch(() => {});
  if (admin) {
    try { for (const schema of schemas) await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
    finally { await admin.end(); }
  }
});

/**
 * A ledger over a fresh schema; the client closes with the case, and when
 * the ledger refuses its options.
 * @param {any} options
 */
async function postgresLedger(options) {
  const schema = `jaren_ledger_${process.pid}_${schemas.length + 1}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  schemas.push(schema);
  const client = await open(idempotencyLedgerModel, { driver: postgresDriver(pool, { schema }), validator: null });
  try {
    return { ledger: createDbLedger(client, options), staleCode: 'JL2007', failCode: 'JL2010', close: () => client.close() };
  }
  catch (error) {
    await client.close();
    throw error;
  }
}

if (url) {
  ledgerContract('createDbLedger over a linq client (PostgreSQL)', postgresLedger);
  ledgerLifecycleContract('createDbLedger over a linq client (PostgreSQL)', postgresLedger);
}
else {
  describe('createDbLedger over a linq client (PostgreSQL)', () => {
    it('runs where JAREN_PG_URL names a server', (t) => { t.skip('JAREN_PG_URL is not set'); });
  });
}
