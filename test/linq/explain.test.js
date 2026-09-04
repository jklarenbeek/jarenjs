//@ts-check
/**
 * @file The chain's `explain()` says what THIS surface does with the item
 * stream — `streaming: 'row'` or `'buffered'` with the first local
 * barrier — and, over a provider, hands the pushed document's own class
 * to the provider's `explain(document, { externals: bindings })`, which
 * agrees with the cursor a `for await` pulls from.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { fromAsync } from '@jarenjs/linq';
import { open } from '@jarenjs/linq/db';
import * as m from '@jarenjs/linq/model';
import { nodeDriver } from '@jarenjs/db/node';

const Row = m.object({ id: m.integer().key(), n: m.integer(), tag: m.string() });
const model = m.defineModel({ entities: { Row } });

const ROWS = [{ id: 1, n: 1, tag: 'a' }, { id: 2, n: 2, tag: 'b' }, { id: 3, n: 3, tag: 'a' }];

describe('the chain reports its own streaming class', () => {
  it('in memory: row until the first local barrier, which is named by operator', () => {
    const streaming = fromAsync(ROWS).where((r) => r.n.gt(1)).select((r) => r.tag).explain();
    assert.deepStrictEqual([streaming.streaming, streaming.barrier], ['row', null]);
    const buffered = fromAsync(ROWS).where((r) => r.n.gt(1)).orderBy((r) => r.tag).explain();
    assert.strictEqual(buffered.streaming, 'buffered');
    assert.strictEqual(buffered.barrier?.construct, 'orderBy');
    assert.match(buffered.barrier?.reason ?? '', /\$orderby/);
    const grouped = fromAsync(ROWS).groupBy((r) => r.tag).explain();
    assert.strictEqual(grouped.barrier?.construct, 'groupBy');
  });

  it('over a provider: the local residual after a split is classified here, the pushed document there', async () => {
    const client = await open(model, { driver: nodeDriver(), validator: null });
    for (const row of ROWS) await client.entities.Row.create(row);
    const set = client.entities.Row;

    const pushed = set.where((r) => r.n.gt(1)).params({ flag: true });
    const local = pushed.explain();
    assert.deepStrictEqual([local.streaming, local.barrier], ['row', null], 'this surface adds no buffer');
    // the pushed document's class is the provider's, for the same bindings
    const provider = await set.explain(local.document, { externals: local.bindings });
    assert.strictEqual(provider.streaming, 'row');
    assert.strictEqual(set.cursor(local.document, { externals: local.bindings }).streaming, provider.streaming);

    // a projection of member paths is pushed on BOTH surfaces and
    // streams; one an operator touches is the provider's barrier
    const projected = set.select((r) => r.n);
    const projectedLocal = projected.explain();
    assert.strictEqual(projectedLocal.streaming, 'row', 'the projection is pushed, not run here');
    const projectedProvider = await set.explain(projectedLocal.document, { externals: projectedLocal.bindings });
    assert.deepStrictEqual([projectedProvider.streaming, projectedProvider.barrier], ['row', null]);
    const computed = set.select((r) => ({ c: r.n.add(1) })).explain();
    const computedProvider = await set.explain(computed.document, { externals: computed.bindings });
    assert.deepStrictEqual([computedProvider.streaming, computedProvider.barrier?.construct],
      ['buffered', '$return']);
    assert.deepStrictEqual(set.cursor(computed.document).barrier, computedProvider.barrier);

    const split = set.where((r) => r.n.gt(0)).mapAsync(async (r) => r, { concurrency: 1 }).orderBy((r) => r.n);
    const splitLocal = split.explain();
    assert.strictEqual(splitLocal.streaming, 'buffered');
    assert.strictEqual(splitLocal.barrier?.construct, 'orderBy');
    assert.deepStrictEqual(splitLocal.split?.residual, ['mapAsync', 'orderBy']);
    await client.close();
  });
});
