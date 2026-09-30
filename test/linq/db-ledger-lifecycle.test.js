//@ts-check
/**
 * @file `createDbLedger` under the rules of a ledger a host operates —
 * the same kit the memory ledger runs (`ledgerLifecycleContract`): a
 * failure for good carries its response (`JL2010`, the twin of the memory
 * ledger's `JC1015`), a `started` claim blocks its key only for its lease
 * (`startedTtlMs`), and `inFlight` / `release` find and free the claims an
 * interrupted request left behind (DB-CLIENT.md §2.6).
 */
import { after } from 'node:test';

import { idempotencyLedgerModel } from '@jarenjs/contract/ledger';
import { nodeDriver } from '@jarenjs/db/node';
import { open, createDbLedger } from '@jarenjs/linq/db';

import { ledgerLifecycleContract } from '../contract/ledger-contract.js';

/** @type {(() => any)[]} */
const cleanups = [];
after(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

ledgerLifecycleContract('createDbLedger over a linq client (node driver, in memory)', async (options) => {
  const client = await open(idempotencyLedgerModel, { driver: nodeDriver(), validator: null });
  cleanups.push(() => client.close());
  return { ledger: createDbLedger(client, options), staleCode: 'JL2007', failCode: 'JL2010' };
});
