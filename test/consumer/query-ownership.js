//@ts-check
/**
 * Public-import ownership proof shared by the DB and LINQ consumers.
 * This collection has ten open-time statements and one lazy INSERT.
 * Thirteen physical slots allow one retained query plus a temporary
 * EXPLAIN or cursor statement. The pool needs one more slot for its
 * connection-owned WAL setup statement when a transaction pins its writer;
 * the one-plan cache is deliberately a different resource bound. Each
 * 100-call series exceeds the entire host capacity. No GC or retry is used.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '@jarenjs/db';
import { nodeWorkerDriver } from '@jarenjs/db/node-worker';
import { nodeWorkerPoolDriver } from '@jarenjs/db/node-pool';
import { nodeProcessDriver } from '@jarenjs/db/node-process';
import { compileJsonQuery } from '@jarenjs/json/query';

const MODEL = { $model: '0.1', collections: { items: {
  key: '/id', schema: { type: 'object', properties: { id: { type: 'string' }, n: { type: 'integer' } } },
  indexes: [],
} } };
const ROWS = [{ id: 'a', n: 1 }, { id: 'b', n: 2 }, { id: 'c', n: 3 }];

/** @param {any} items @param {number} min */
function documentQuery(items, min) {
  const document = { $for: { it: '$[*]' }, $where: { $ge: ['$it.n', min] }, $orderby: '$it.id', $return: '$it' };
  return {
    document,
    execute: () => items.execute([document]),
    explain: () => items.explain([document]),
    cursor: () => items.query(document),
  };
}

/**
 * Qualify the actual public endpoints through either the Store or its
 * LINQ client. The injected adapter changes authoring only; every host
 * runs the same answers, pressure, retirement and cleanup assertions.
 * This module imports no optional LINQ dependency into the DB closure.
 * @param {(model: any, options: any) => Promise<any>} [open]
 * @param {(items: any, min: number) => any} [query]
 * @returns {Promise<{ hosts: string[], callsPerSeries: number, maxStatements: Record<string, number>, statementCacheBound: number, maxCursors: number }>}
 */
export async function qualifyQueryOwnership(open = openStore, query = documentQuery) {
  const limits = { maxStatements: 13, maxCursors: 1, windowRows: 1 };
  /** @type {[string, () => any][]} */
  const hosts = [
    ['worker', () => nodeWorkerDriver(limits)],
    ['pool', () => nodeWorkerPoolDriver({ readers: 1, worker: { ...limits, maxStatements: 14 } })],
  ];
  // The process endpoint's runtime contract is Node; both runtimes
  // exercise the worker and pool endpoints from the same public exports.
  if (!process.versions.bun) hosts.push(['process', () => nodeProcessDriver(limits)]);
  const completed = [];
  const maxStatements = {};
  for (const [name, driver] of hosts) {
    const directory = mkdtempSync(join(tmpdir(), 'jaren-query-owner-'));
    let client;
    try {
      client = await open(MODEL, { driver: driver(), path: join(directory, 'consumer.sqlite'), statementCacheBound: 1 });
      const store = client.store ?? client;
      const items = client.collections?.items ?? store.collection('items');
      for (const row of ROWS) await items.insert(row);

      for (let n = 0; n < 100; n++) {
        const plan = query(items, n - 47);
        assert.deepEqual(await plan.execute(), compileJsonQuery([plan.document])(ROWS), `${name}: execute ${n}`);
      }
      assert.equal(store.stats().statementCache.evictions, 99, `${name}: one retained plan`);

      const explained = query(items, 0);
      assert.deepEqual(await explained.execute(), ROWS);
      for (let n = 0; n < 100; n++) {
        const detail = await explained.explain();
        assert.equal(detail.mode, 'native', `${name}: explanation ${n}`);
        assert.match(detail.sql, /^SELECT\b/);
      }

      for (let n = 0; n < 100; n++) {
        await assert.rejects(() => items.execute('$[*]', { profile: { refuseFullScan: true } }),
          { code: 'JD0011' }, `${name}: refused scan ${n}`);
      }

      // One remote cursor slot makes an unacknowledged return observable
      // on the next iteration, even when the statement cache evicts it.
      for (let n = 0; n < 100; n++) {
        const early = query(items, n - 100).cursor();
        try { assert.deepEqual(await early.next(), { done: false, value: ROWS[0] }, `${name}: cursor ${n}`); }
        finally { await early.return(); }
        assert.deepEqual(await early.next(), { done: true, value: undefined });
      }

      const materializing = { $for: { it: '$[*]' }, $let: { n: '$it.n' }, $orderby: '$it.id', $return: '$n' };
      assert.deepEqual(await items.execute(materializing), [1, 2, 3]);
      const delayed = items.query(materializing);
      assert.equal(delayed.streaming, 'buffered');
      await query(items, 0).execute();
      const materialized = [];
      for await (const row of delayed) materialized.push(row);
      assert.deepEqual(materialized, [1, 2, 3], `${name}: lazy retired plan`);

      // A transaction pins the pool to one physical worker, so its
      // cursor ceiling is the same endpoint refusal as the other hosts.
      await client.transaction(async (scope) => {
        const scoped = scope.collections?.items ?? scope.collection('items');
        const active = query(scoped, 1).cursor();
        let next;
        try {
          assert.deepEqual(await active.next(), { done: false, value: ROWS[0] });
          for (let n = 0; n < 100; n++) {
            const refused = query(scoped, n - 100).cursor();
            try {
              await assert.rejects(() => refused.next(),
                { code: 'JD2092', reason: /cursor capacity 1 exceeded/ }, `${name}: refused cursor ${n}`);
            }
            finally { await refused.return(); }
          }
          const evictions = store.stats().statementCache.evictions;
          // Planning retires the active cursor's semantic entry without
          // opening a second native cursor: this host admits only one.
          next = scoped.query(query(scoped, 2).document);
          assert.equal(store.stats().statementCache.evictions, evictions + 1);
          const remainder = [];
          for await (const row of active) remainder.push(row);
          assert.deepEqual(remainder, ROWS.slice(1), `${name}: active cursor after eviction`);
          const later = [];
          for await (const row of next) later.push(row);
          assert.deepEqual(later, ROWS.slice(1), `${name}: next cursor after release`);
        }
        finally { await active.return(); await next?.return(); }
      });
      assert.deepEqual(await items.all(), ROWS, `${name}: reads preserve every stored row`);
      const authored = query(items, 0);
      if (authored.iterate) {
        const iterated = [];
        for await (const row of authored.iterate()) iterated.push(row);
        assert.deepEqual(iterated, ROWS, `${name}: fluent iteration answers`);
      }
      completed.push(name);
      maxStatements[name] = name === 'pool' ? 14 : 13;
    }
    finally {
      try { await client?.close(); }
      finally { rmSync(directory, { recursive: true, force: true }); }
    }
  }
  return { hosts: completed, callsPerSeries: 100, maxStatements, statementCacheBound: 1, maxCursors: limits.maxCursors };
}
