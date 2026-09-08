//@ts-check
/** Browser-only test host: no application transport or discovery policy. */
import init from '@sqlite.org/sqlite-wasm';
import { openStore, encodeReplication } from '@jarenjs/db';
import { wasmDriver, sqlite3Handle } from '@jarenjs/db/wasm';
import { applyJSONPatch } from '@jarenjs/json/patch';

/** Execute the same transaction history through both real wasm capture modes. */
export async function runReplicationBrowser() {
  const sqlite3 = await init({ locateFile: () => '/replication-fixture/sqlite3.wasm', print: () => {}, printErr: () => {} });
  const model = { $model: '0.1', collections: { notes: { key: '/id', schema: { type: 'object', properties: {
    id: { type: 'string' }, n: { type: 'number' },
  } } } } };
  const histories = [];
  let checks = 0;
  const same = (left, right) => { if (JSON.stringify(left) !== JSON.stringify(right)) throw new Error('replication browser oracle diverged'); checks++; };
  for (const mode of ['session', 'journal']) {
    const source = await openStore(model, { driver: wasmDriver(sqlite3Handle(sqlite3)), capture: { mode }, replication: { replica: 'source', retention: 3 } });
    const target = await openStore(model, { driver: wasmDriver(sqlite3Handle(sqlite3)), capture: { mode }, replication: { replica: 'target' } });
    try {
      const query = [{ $for: { n: '$[*]' }, $orderby: '$n.id', $return: '$n' }];
      const live = await target.collection('notes').live(query);
      let reconstructed = structuredClone(live.result);
      live.subscribe((event) => { if (event.error) throw event.error; reconstructed = applyJSONPatch(reconstructed, event.patch); });
      const envelopes = [];
      for (let n = 0; n < 6; n++) {
        await source.collection('notes').put({ id: 'hostile/~😀', n });
        const envelope = (await source.replication.page({ after: n })).items[0];
        envelopes.push(encodeReplication(envelope));
        same((await target.replication.apply(envelope)).status, 'applied');
        same((await target.replication.apply(envelope)).status, 'duplicate');
        same(reconstructed, live.result);
        same(live.result.rows, await target.collection('notes').execute(query));
      }
      same((await source.replication.page()).resetRequired, true);
      same((await target.replication.page()).items, []);
      await target.replication.reset(await source.replication.snapshot());
      same(await target.collection('notes').execute(query), await source.collection('notes').execute(query));
      histories.push(envelopes);
    }
    finally { await source.close(); await target.close(); }
  }
  same(histories[0], histories[1]);
  return { checks, envelopes: histories[0].length, capture: ['session', 'journal'] };
}
