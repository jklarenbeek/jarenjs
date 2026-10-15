//@ts-check
/**
 * @file A store profile predicate's boolean, object or array its member
 * cannot hold binds on every SQLite host as an empty BLOB — a kind no JSON
 * member holds, so the guarded comparison reads it as the engine reads a
 * foreign value — where `node:sqlite` refused a boolean and read an object
 * as named parameters: in process, on sqlite-wasm, on the Node worker and
 * worker-pool hosts and on the Node process host, each answer the engine's.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import init from '@sqlite.org/sqlite-wasm';

import { queryJson } from '@jarenjs/json/query';
import { openStore, sql } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { wasmDriver, sqlite3Handle } from '@jarenjs/db/wasm';
import { nodeWorkerDriver } from '@jarenjs/db/node-worker';
import { nodeWorkerPoolDriver } from '@jarenjs/db/node-pool';
import { nodeProcessDriver } from '@jarenjs/db/node-process';

const MODEL = {
  $model: '0.1',
  collections: { ev: { key: '/id', schema: { type: 'object', properties: { id: { type: 'string' }, tenant: { type: 'string' } } } } },
  entities: { Event: { schema: { type: 'object', required: ['id'], properties: {
    id: { type: 'integer', 'x-entity': { key: true } }, tenant: { type: ['string', 'null'] } } } } },
};
const DOCS = [{ id: 'a1', tenant: 'a' }, { id: 'b1', tenant: 'b' }];
const PROFILE = { externals: ['tenant'],
  predicates: { ev: { $ne: ['$it.tenant', '$tenant'] }, Event: { $eq: ['$it.tenant', '$tenant'] } } };
const IDS = { $for: { e: '$[*]' }, $orderby: ['$e.id'], $return: '$e.id' };
const ROW_IDS = { $for: { e: '$.Event[*]' }, $return: '$e.id' };

const sqlite3 = await init();
/** @type {[string, () => any][]} */
const HOSTS = [
  ['node:sqlite', () => nodeDriver()],
  ['sqlite-wasm', () => wasmDriver(sqlite3Handle(sqlite3))],
  ['the Node worker host', () => nodeWorkerDriver()],
  ['the Node worker-pool host', () => nodeWorkerPoolDriver()],
  ['the Node process host', () => nodeProcessDriver()],
];

describe('a foreign predicate value binds as an empty BLOB on every SQLite host', () => {
  for (const [name, driver] of HOSTS) {
    it(name, async () => {
      const store = await openStore(MODEL, { driver: driver(), profile: PROFILE });
      try {
        for (const doc of DOCS) await store.collection('ev').insert(doc);
        await store.entity('Event').create({ id: 1, tenant: 'a' });
        await store.saveChanges();
        for (const tenant of [true, { x: 1 }, ['a']]) {
          // twice: the statement and its bound value are reused
          for (let run = 0; run < 2; run++) {
            assert.deepStrictEqual(await store.collection('ev').execute(IDS, { externals: { tenant } }),
              queryJson({ $for: { it: '$[*]' }, $where: PROFILE.predicates.ev, $orderby: ['$it.id'], $return: '$it.id' }, DOCS, { tenant }));
            assert.strictEqual(await store.entity('Event').execute(ROW_IDS, { externals: { tenant } }), undefined);
          }
        }
        // the value the statement binds is a BLOB, never a NULL a present-null case would equate
        const rows = await store.relational.all({ from: 'Event', columns: { t: sql.call('typeof', [sql.param('b')]) } },
          { externals: { b: new Uint8Array(0) } });
        assert.deepStrictEqual(rows.map((/** @type {any} */ row) => row.t), ['blob']);
      }
      finally { await store.close(); }
    });
  }
});
