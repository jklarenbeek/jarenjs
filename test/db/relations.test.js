//@ts-check
/**
 * @file The relations differential oracle: every corpus
 * group's cases run through the in-memory engine over the multi-entity
 * root AND through the store's entity translator — native, native over
 * a model with every declared index removed, and forced-residual — and
 * must agree, values and error codes alike.
 * Alongside the corpus: strict mode, `explain` with its join and scan
 * narrative, the EQP proof that an instant comparison narrows through
 * the derived column's index while the document string decides, and
 * the Z-normalization write contract that keeps that narrowing sound.
 */

import { describe, it, after } from 'node:test';
import * as fs from 'node:fs';
import * as assert from 'node:assert';

import { openStore } from '@jarenjs/db';
import { from } from '@jarenjs/linq';
import { compileJsonQuery } from '@jarenjs/json/query';
import { nodeDriver } from '@jarenjs/db/node';
import {
  loadRelationGroups, storeForEntityGroup, runEntityCase,
} from './oracle/harness.js';
import { renderLinqRootsGroup, renderLinqHopsGroup } from '../../scripts/lib/linq-roots-cases.js';

const groups = loadRelationGroups();

/** The multi-entity root the ENGINE side reads: the group's entity
 * documents plus its join rows, which are roots of their own (§10.7). */
const rootOf = (group) => ({ ...group.documents, ...(group.memberships ?? {}) });

for (const [mode, side] of /** @type {const} */ ([
  ['native', 'indexed'], ['native', 'unindexed'], ['residual', 'indexed'],
])) {
  const label = mode === 'native' ? `native mode, ${side}` : `${mode} mode`;
  describe(`relations oracle — ${label}`, () => {
    for (const group of groups) {
      describe(group.group, () => {
        /** @type {any} */
        let opened = null;
        const openOnce = async () => {
          if (opened === null) opened = await storeForEntityGroup(group, side);
          return opened;
        };
        for (const kase of group.cases) {
          it(kase.name, async () => {
            const { store } = await openOnce();
            const divergence = await runEntityCase(store, rootOf(group), kase, mode);
            assert.strictEqual(divergence, null,
              divergence === null ? '' : `${group.group}/${kase.name} [${label}] diverged\n`
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
    assert.deepStrictEqual(join.joins, [
      { binding: 'u', on: [] },
      { binding: 'p', on: [{ op: 'eq', left: { binding: 'p', column: 'authorId' },
        right: { binding: 'u', column: 'id' } }] },
    ], 'the FROM order, and the equality that attached each binding');
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

describe('the linq-roots groups are what the chains emit', () => {
  it('14-linq-roots.json regenerates byte-identically — never a hand-typed chain document', () => {
    const committed = fs.readFileSync('test/db/oracle/relations/14-linq-roots.json', 'utf8');
    assert.strictEqual(committed, renderLinqRootsGroup(),
      'run node scripts/generate-linq-roots-cases.js');
  });

  it('15-linq-hops.json regenerates byte-identically, and no case document names a relation member', () => {
    const committed = fs.readFileSync('test/db/oracle/relations/15-linq-hops.json', 'utf8');
    assert.strictEqual(committed, renderLinqHopsGroup(),
      'run node scripts/generate-linq-roots-cases.js');
    const group = JSON.parse(committed);
    assert.ok(group.cases.length >= 10);
    for (const kase of group.cases) {
      const text = JSON.stringify(kase.query);
      assert.strictEqual(/\b(author|posts)\b/.test(text), false, `${kase.name}: no relation name in the document`);
      assert.match(text, /"r1"/, `${kase.name}: lowered to a hop binding`);
    }
  });

  it('every lowered hop shape is a named residual today (nothing promoted), and strict refuses it', async () => {
    const group = JSON.parse(fs.readFileSync('test/db/oracle/relations/15-linq-hops.json', 'utf8'));
    const { store } = await storeForEntityGroup(group);
    const REASONS = new Set([
      'entity queries return one bare binding natively; projections run in the engine',
      'existence tests translate only over a singular member path on the binding',
      'comparisons translate only between a singular member path and a literal or external',
      'ordering translates only over typed entity paths (never a boolean, never a document path that admits null)',
      'no equivalence proof exists yet; residual by default',
    ]);
    for (const kase of group.cases) {
      const explained = await store.explain(kase.query);
      assert.strictEqual(explained.mode, 'set', kase.name);
      assert.ok(explained.reasons.length > 0 && explained.reasons.every((r) => REASONS.has(r.reason)),
        `${kase.name}: ${JSON.stringify(explained.reasons)}`);
      assert.deepStrictEqual([...explained.referenced].sort(), ['Post', 'User'], kase.name);
      // the entity engine refuses before it returns a promise (value-or-
      // promise, D2), so the refusal is awaited through an async wrapper
      await assert.rejects(async () => store.execute(kase.query, { strict: true }),
        (error) => /** @type {any} */ (error).code === 'JD0010', kase.name);
    }
    await store.close();
  });
});

// ————— More than two bindings —————

describe('the relation graph: every binding past the first is attached, or nothing lowers', () => {
  const MULTI = JSON.parse(fs.readFileSync('test/db/oracle/relations/16-multi-binding.json', 'utf8'));
  const openMulti = async () => (await storeForEntityGroup(MULTI)).store;
  const chained = {
    $for: { a: '$.Author[*]', t: '$.Talk[*]', v: '$.Venue[*]' },
    $where: { $and: [{ $eq: ['$t.authorId', '$a.id'] }, { $eq: ['$t.venueId', '$v.vid'] }] },
    $orderby: ['$t.tid'],
    $return: '$t',
  };

  it('three and four bindings are ONE statement, joined in attachment order', async () => {
    const store = await openMulti();
    const three = await store.explain(chained);
    assert.strictEqual(three.mode, 'native');
    assert.deepStrictEqual(three.joins.map((join) => join.binding), ['a', 't', 'v']);
    assert.deepStrictEqual(three.joins[0].on, [], 'the first binding attaches to nothing');
    assert.deepStrictEqual(three.joins[1].on,
      [{ op: 'eq', left: { binding: 't', column: 'authorId' }, right: { binding: 'a', column: 'id' } }]);
    assert.strictEqual(three.sql.match(/ JOIN /g).length, 2, 'two joins for three bindings');

    const four = await store.explain({
      $for: { a: '$.Author[*]', t: '$.Talk[*]', v: '$.Venue[*]', s: '$.Slot[*]' },
      $where: { $and: [{ $eq: ['$t.authorId', '$a.id'] }, { $eq: ['$t.venueId', '$v.vid'] },
        { $eq: ['$s.venueId', '$v.vid'] }] },
      $return: '$t',
    });
    assert.strictEqual(four.mode, 'native');
    assert.deepStrictEqual(four.joins.map((join) => join.binding), ['a', 't', 'v', 's']);
    assert.strictEqual(four.sql.match(/ JOIN /g).length, 3);
    await store.close();
  });

  it('a binding nothing attaches is a cartesian product, refused by name and JD0010 under strict', async () => {
    const store = await openMulti();
    const loose = {
      $for: { a: '$.Author[*]', t: '$.Talk[*]', v: '$.Venue[*]' },
      $where: { $eq: ['$t.authorId', '$a.id'] },
      $return: '$t',
    };
    const explained = await store.explain(loose);
    assert.strictEqual(explained.mode, 'set');
    assert.match(explained.reasons[0].reason, /cartesian product/);
    await assert.rejects(async () => store.execute(loose, { strict: true }),
      (error) => /** @type {any} */ (error).code === 'JD0010');
    await store.close();
  });

  it('a repeated equality between two attached bindings is one more condition, not a second join', async () => {
    const store = await openMulti();
    const cyclic = await store.explain({
      $for: { a: '$.Author[*]', t: '$.Talk[*]', v: '$.Venue[*]' },
      $where: { $and: [{ $eq: ['$t.authorId', '$a.id'] }, { $eq: ['$t.venueId', '$v.vid'] },
        { $eq: ['$v.vid', '$t.venueId'] }] },
      $return: '$t',
    });
    assert.strictEqual(cyclic.mode, 'native');
    assert.strictEqual(cyclic.sql.match(/ JOIN /g).length, 2);
    assert.strictEqual(cyclic.joins.at(-1).on.length, 2, 'both equalities ride the last ON');
    await store.close();
  });

  it('the per-binding filters and the count still push over three bindings', async () => {
    const store = await openMulti();
    const filtered = await store.explain({
      $for: { a: '$.Author[*]', t: '$.Talk[*]', v: '$.Venue[*]' },
      $where: { $and: [{ $eq: ['$t.authorId', '$a.id'] }, { $eq: ['$t.venueId', '$v.vid'] },
        { $eq: ['$a.city', 'delft'] }, { $gt: ['$v.seats', 100] }] },
      $return: '$t',
    });
    assert.strictEqual(filtered.mode, 'native');
    assert.match(filtered.sql, /WHERE .* AND /);
    const counted = await store.explain({ $count: chained });
    assert.strictEqual(counted.mode, 'native');
    assert.match(counted.sql, /COUNT\(\*\)/);
    await store.close();
  });
});

// ————— The join table as a read-only query root (§10.7) —————

describe('a declared join table is a query root, and only a query root', () => {
  const JOINS = JSON.parse(fs.readFileSync('test/db/oracle/relations/17-join-roots.json', 'utf8'));
  const openJoins = async () => (await storeForEntityGroup(JOINS)).store;

  it('$.<JoinTable>[*] answers exactly its two declared keys, from one statement', async () => {
    const store = await openJoins();
    const document = { $for: { m: '$.Person_Tag[*]' },
      $orderby: ['$m.Person_key', '$m.Tag_key'], $return: '$m' };
    const explained = await store.explain(document);
    assert.strictEqual(explained.mode, 'native');
    assert.match(explained.sql, /FROM "Person_Tag" AS "t0"/);
    assert.doesNotMatch(explained.sql, /json\("t0"\."doc"\)/,
      'a join row has no document column of its own');
    const rows = await store.execute(document);
    assert.deepStrictEqual(rows, [
      { Person_key: 'p1', Tag_key: 'blue' },
      { Person_key: 'p1', Tag_key: 'red' },
      { Person_key: 'p2', Tag_key: 'red' },
    ]);
    for (const row of rows) assert.deepStrictEqual(Object.keys(row).sort(), ['Person_key', 'Tag_key']);
    await store.close();
  });

  it('it is not a write collection: the entity surface refuses it by name', async () => {
    const store = await openJoins();
    assert.throws(() => store.entity('Person_Tag'),
      (error) => /** @type {any} */ (error).code === 'JD2004'
        && /no entity 'Person_Tag'/.test(/** @type {any} */ (error).message));
    assert.throws(() => store.sync.entity('Person_Tag'),
      (error) => /** @type {any} */ (error).code === 'JD2004');
    await store.close();
  });

  it('a join table whose name is a declared entity is refused at open, both being roots', async () => {
    await assert.rejects(() => openStore({
      $model: '0.1',
      entities: {
        A_B: { schema: { type: 'object', required: ['id'],
          properties: { id: { type: 'string', 'x-entity': { key: true } } } } },
        A: { schema: { type: 'object', required: ['id'], properties: {
          id: { type: 'string', 'x-entity': { key: true } },
          bs: { 'x-entity': { relation: { to: 'B', many: true } } } } } },
        B: { schema: { type: 'object', required: ['id'],
          properties: { id: { type: 'string', 'x-entity': { key: true } } } } },
      },
    }, { driver: nodeDriver() }),
    (error) => /** @type {any} */ (error).code === 'JD0005'
      && /has the name of a declared entity/.test(/** @type {any} */ (error).message));
  });

  it('a many-to-many hop lowers through it, and answers what the engine answers', async () => {
    const store = await openJoins();
    const people = store.sync.entity('Person');
    const tagged = from(people).where((p) => p.tags.all().exists()).select((p) => p.id);
    assert.match(JSON.stringify(tagged.toDocument()), /Person_Tag/);
    const root = { ...JOINS.documents, ...JOINS.memberships };
    assert.deepStrictEqual(tagged.toArray(),
      compileJsonQuery([tagged.toDocument()])(root));
    assert.deepStrictEqual(tagged.toArray(), ['p1', 'p2']);
    await store.close();
  });
});
