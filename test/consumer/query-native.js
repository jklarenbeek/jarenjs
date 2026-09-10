//@ts-check
/** Installed-only proof; the pack gate copies both frozen inputs beside this file. */
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nodeDriver } from '@jarenjs/db/node';
import { bunDriver } from '@jarenjs/db/bun';
import { open, createDbRangeProvider } from '@jarenjs/linq/db';

const census = JSON.parse(readFileSync(new URL('./adoption-sql.json', import.meta.url), 'utf8'));
const fixture = JSON.parse(readFileSync(new URL('./adoption-relational.json', import.meta.url), 'utf8'));
const driver = process.versions.bun ? bunDriver() : nodeDriver();
const directory = mkdtempSync(join(tmpdir(), 'jaren-installed-native-'));
try {
  for (const side of ['indexed', 'unindexed']) {
    const path = join(directory, `${side}.sqlite`);
    const seed = await driver.open(path);
    for (const sql of [...fixture.ddl, ...fixture.seed]) seed.exec(sql);
    if (side === 'unindexed') seed.exec('DROP INDEX inventory_quantity');
    seed.close();
    const client = await open(census.model, { driver, path, adopt: true });
    try {
      for (const read of census.reads) {
        if (!read.query) { assert.match(read.reason, /primary key/); continue; }
        assert.deepEqual(await client.store.execute(read.query, { strict: true }), read.expected);
        assert.deepEqual(await client.store.execute(read.query, { pushdown: false }), read.expected);
        const explained = await client.store.explain(read.query);
        assert.equal(explained.mode, 'native');
        assert.equal(explained.admitted.statements, read.budget.statements);
        assert.ok(explained.admitted.rows <= read.budget.rows);
        assert.ok(explained.admitted.bytes <= read.budget.bytes);
      }
      const mutation = census.mutations[0];
      await assert.rejects(client.transaction(async (tx) => {
        await tx.entities[mutation.entity].mutate(mutation.document);
        await tx.entities.Receipt.create({ body: 'abcd' });
        throw new Error('withdraw output');
      }), /withdraw output/);
      assert.equal((await client.entities.Inventory.get(mutation.document.key)).revision, 1);
      assert.equal(await client.entities.Receipt.get(2), undefined);
      for (const family of census.mutations) {
        const target = client.entities[family.entity];
        assert.deepEqual((await target.mutate(family.document)).rows, family.first);
        const before = await client.transaction((tx) => tx.sql.prepare('SELECT total_changes() AS n', { access: 'read' }).get([]));
        assert.deepEqual((await target.mutate(family.document)).rows, []);
        const after = await client.transaction((tx) => tx.sql.prepare('SELECT total_changes() AS n', { access: 'read' }).get([]));
        assert.equal(after.n, before.n);
      }
    }
    finally { await client.close(); }
  }
  const model = { $model: '0.1', entities: { Row: { schema: { type: 'object', properties: {
    id: { type: 'string', 'x-entity': { key: true } }, rank: { type: 'integer' },
  } } } } };
  const client = await open(model, { driver, capture: true });
  try {
    for (const id of ['c', 'a', 'b']) await client.entities.Row.create({ id, rank: 1 });
    for (const resident of [false, true]) {
      const provider = await createDbRangeProvider(client.store, 'Row', { orderBy: '$it.rank' },
        { keys: ['id'], resident, maxRows: 16, maxBytes: 4096 });
      try {
        const first = { generation: 1, requestId: 'first', query: provider.query, snapshot: provider.snapshot,
          range: { start: 0, end: 2 }, credits: { pages: 1, rows: 2, bytes: 4096, work: 2 } };
        const response = await provider.request(first);
        assert.equal(response.state, 'ready'); assert.deepEqual(response.keys, ['a', 'b']);
        assert.equal(response.total.kind, resident ? 'known' : 'unknown');
        assert.ok(response.used.work <= 2);
        const next = await provider.request({ ...first, requestId: 'next', range: undefined, continuation: response.continuation });
        assert.deepEqual(next.keys, ['c']);
        const events = []; provider.subscribe((event) => events.push(event));
        await client.entities.Row.update('c', { rank: resident ? 3 : 2 });
        assert.equal(events[0].type, 'reset');
        assert.equal((await provider.request(first)).state, 'invalidated');
      }
      finally { await provider.dispose(); }
      assert.equal(provider.stats().pending + provider.stats().rows + provider.stats().pages, 0);
    }
  }
  finally { await client.close(); }
}
finally { rmSync(directory, { recursive: true, force: true }); }
