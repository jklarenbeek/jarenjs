//@ts-check
/**
 * @file The relations differential oracle: every corpus
 * group's cases run through the in-memory engine over the multi-entity
 * root AND through the store's entity translator — native and
 * forced-residual — and must agree, values and error codes alike.
 * Alongside the corpus: strict mode, `explain` with its join and scan
 * narrative, the EQP proof that an instant comparison narrows through
 * the derived column's index while the document string decides, and
 * the Z-normalization write contract that keeps that narrowing sound.
 */

import { describe, it, after } from 'node:test';
import * as assert from 'node:assert';

import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import {
  loadRelationGroups, storeForEntityGroup, runEntityCase,
} from './oracle/harness.js';

const groups = loadRelationGroups();

for (const mode of /** @type {const} */ (['native', 'residual'])) {
  describe(`relations oracle — ${mode} mode`, () => {
    for (const group of groups) {
      describe(group.group, () => {
        /** @type {any} */
        let opened = null;
        const openOnce = async () => {
          if (opened === null) opened = await storeForEntityGroup(group);
          return opened;
        };
        for (const kase of group.cases) {
          it(kase.name, async () => {
            const { store } = await openOnce();
            const divergence = await runEntityCase(store, group.documents, kase, mode);
            assert.strictEqual(divergence, null,
              divergence === null ? '' : `${group.group}/${kase.name} [${mode}] diverged\n`
                + `  sql:      ${divergence.sql ?? '<none>'}\n`
                + `  engine:   ${JSON.stringify(divergence.expected)}\n`
                + `  pushdown: ${JSON.stringify(divergence.actual)}`);
          });
        }
        after(async () => {
          if (opened !== null) await opened.store.close();
        });
      });
    }
  });
}

describe('the translated modes are the claimed ones', () => {
  /** @type {any} */
  let store = null;
  const open = async () => {
    if (store === null) store = (await storeForEntityGroup(groups[1])).store;
    return store;
  };
  after(async () => {
    if (store !== null) await store.close();
  });

  it('a single-binding column filter and an equijoin are native', async () => {
    const s = await open();
    const single = await s.explain({
      $for: { u: '$.User[*]' },
      $where: { $gt: ['$u.age', 21] },
      $orderby: ['$u.id'],
      $return: '$u',
    });
    assert.strictEqual(single.mode, 'native');
    assert.deepStrictEqual(single.referenced, ['User']);
    assert.match(single.sql, /^SELECT /);

    const join = await s.explain({
      $for: { u: '$.User[*]', p: '$.Post[*]' },
      $where: { $eq: ['$p.authorId', '$u.id'] },
      $return: '$p',
    });
    assert.strictEqual(join.mode, 'native');
    assert.deepStrictEqual(join.join, {
      left: { binding: 'p', column: 'authorId' },
      right: { binding: 'u', column: 'id' },
    });
    assert.match(join.scanNarrative, /SEARCH/,
      'the equijoin probes an index, not a second scan');
  });

  it('the residual reasons name the untranslatable construct', async () => {
    const s = await open();
    const explained = await s.explain({
      $for: { u: '$.User[*]', p: '$.Post[*]' },
      $where: { $gt: ['$p.stars', '$u.age'] },
      $return: '$p',
    });
    assert.strictEqual(explained.mode, 'set');
    assert.ok(explained.reasons.length > 0);
    const strict = () => s.execute({
      $for: { u: '$.User[*]', p: '$.Post[*]' },
      $where: { $gt: ['$p.stars', '$u.age'] },
      $return: '$p',
    }, { strict: true });
    await assert.rejects(async () => strict(),
      (error) => /** @type {any} */ (error).code === 'JD0010');
  });

  it('an instant range narrows through the epoch index and rechecks the text', async () => {
    // a dedicated store with enough rows for the optimizer to prefer
    // the index; the count form carries no ORDER BY, so the choice is
    // free of the sequence contract
    const seeded = await openStore(groups[1].model, { driver: nodeDriver() });
    const users = seeded.entity('User');
    for (let i = 0; i < 150; i++) {
      await users.create({
        id: `u${i}`, name: `n${i}`, age: i,
        joined: `2026-0${1 + (i % 9)}-01T00:00:00Z`,
      });
    }
    const range = {
      $for: { u: '$.User[*]' },
      $where: { $ge: ['$u.joined', '2026-08-01T00:00:00Z'] },
      $return: '$u',
    };
    const counted = await seeded.explain({ $count: range });
    assert.strictEqual(counted.mode, 'native');
    assert.match(counted.sql, /"joined" >= /,
      'the ±1s epoch range rides the derived column');
    assert.match(counted.sql, /jsonb_extract|json_extract/,
      'the document string performs the exact comparison');
    assert.match(counted.scanNarrative, /USING INDEX "?User_joined"?/,
      'EQP shows the derived index narrowing the aggregate');
    // the plain select keeps insertion order (ORDER BY row identity),
    // which SQLite satisfies with the natural scan — the sequence
    // contract, reported honestly, not an accidental regression
    const selected = await seeded.explain(range);
    assert.match(selected.scanNarrative, /SCAN/);
    await seeded.close();
  });

  it('ordering by an instant path sorts the document text, never the epoch', async () => {
    const s = await open();
    const explained = await s.explain({
      $for: { u: '$.User[*]' },
      $orderby: ['$u.joined'],
      $return: '$u',
    });
    assert.strictEqual(explained.mode, 'native');
    assert.doesNotMatch(explained.sql, /ORDER BY "t0"\."joined"/,
      'mixed stored precisions would let the integer column sort differently');
  });
});

describe('the Z-normalization write contract (§10.3)', () => {
  it('an offset or junk instant is refused with the property named', async () => {
    const store = await openStore(groups[0].model, { driver: nodeDriver() });
    const users = store.entity('User');
    await assert.rejects(
      () => users.create({ id: 'x1', joined: '2026-01-05T12:00:00+02:00' }),
      (error) => {
        assert.strictEqual(/** @type {any} */ (error).code, 'JD2003');
        assert.match(/** @type {any} */ (error).message, /Z-normalized/);
        return true;
      });
    await assert.rejects(() => users.create({ id: 'x2', joined: 'not a date' }),
      (error) => /** @type {any} */ (error).code === 'JD2003');
    // any Z-normalized precision is welcome — the slack range plus the
    // text recheck stay sound across mixtures
    const fine = await users.create({ id: 'x3', joined: '2026-01-05T12:00:00.123456Z' });
    assert.strictEqual(fine.joined, '2026-01-05T12:00:00.123456Z');
    await store.close();
  });
});
