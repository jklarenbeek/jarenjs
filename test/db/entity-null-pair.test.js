//@ts-check
/**
 * @file An equality or inequality of two columns of one binding takes a NULL
 * the column's policy reads as a present `null` for a value, whatever the
 * schema omits: the engine pairs two nulls and differs a null from every
 * present value, SQL does neither. Such a pair is the engine's; an ordering
 * of the same pair agrees with the engine, and a pair of columns that admit
 * no null stays native. Checked on node:sqlite, the wasm build and, when
 * `JAREN_PG_URL` names an endpoint, PostgreSQL.
 */
import { describe, it, before } from 'node:test';

import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { openStore } from '@jarenjs/db';
import { wasmDriver, sqlite3Handle } from '@jarenjs/db/wasm';

import { onBothEnginesPhysical } from './query-core-engines.js';
import { DDL, modelFor, checkNullPair } from './oracle/null-pair.js';

const TYPES = /** @type {[string, any][]} */ ([['a schema that omits null', 'string'], ['a schema that admits it', ['string', 'null']]]);

describe('two columns of one binding whose NULL reads as a present null', () => {
  /** @type {any} */
  let sqlite3 = null;
  before(async () => { sqlite3 = await sqlite3InitModule({ print: () => {}, printErr: () => {} }); });

  for (const [label, type] of TYPES) {
    it(`node:sqlite and PostgreSQL: an equality and an inequality are the engine's, under ${label}`, async () => {
      await onBothEnginesPhysical(modelFor(type), DDL, checkNullPair);
    });

    it(`wasm: an equality and an inequality are the engine's, under ${label}`, async () => {
      const driver = wasmDriver(sqlite3Handle(sqlite3));
      const db = await driver.open(':memory:');
      db.exec(DDL(''));
      const store = await openStore(modelFor(type)(null), { driver: { ...driver, open: async () => db }, adopt: true });
      try { await checkNullPair(store, 'wasm'); }
      finally { await store.close(); }
    });
  }
});
