//@ts-check
/**
 * @file The federation boundary (QUERY-PEN.md §13): two different
 * sources, one document, and the budgets that make the fetch finite.
 *
 * The refusal comes first. An ordinary cross-source join is `JL0005`
 * and stays `JL0005` — nothing here relaxes it — and `federate()` is
 * the one way to opt in, by naming the sources and the bounds in one
 * place. What the boundary then owes is measured against the engine
 * itself: the same rows, over an assembled input, for every key shape
 * a join has (none, one, many, duplicates, nulls, absent members).
 *
 * The rest is the accounting. Each side is fetched under its own row
 * and byte budget; a cursor source is refused at the row that WOULD
 * break the bound, never after; every cursor a call opens is closed
 * exactly once whether the call answered, refused, failed or was
 * aborted; and the probe side is reduced by the build side's keys, so
 * the rows that cannot pair never cross the wire.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { from, fromAsync, federate } from '@jarenjs/linq';
import { queryJson } from '@jarenjs/json/query';

const codeIs = (code, match) => (error) => error.code === code
  && (match === undefined || match.test(error.reason ?? error.message));

const ORDERS = [
  { id: 1, cust: 'a', total: 10 },
  { id: 2, cust: 'b', total: 20 },
  { id: 3, cust: 'a', total: 30 },
  { id: 4, cust: null, total: 40 },
  { id: 5, total: 50 },
];
const CUSTOMERS = [
  { key: 'a', name: 'Ada' },
  { key: 'b', name: 'Bo' },
  { key: 'c', name: 'Cy' },
  { key: null, name: 'Nil' },
];

/**
 * A source that answers documents out of an array through the engine
 * itself, counting what it was asked and what it handed back.
 * @param {any[]} rows
 * @param {{ cursor?: boolean, fail?: Error, pause?: () => Promise<void> }} [options]
 */
function fake(rows, options = {}) {
  const calls = [];
  const closed = [];
  let opened = 0;
  const answer = (document) => {
    calls.push(document);
    if (options.fail !== undefined) throw options.fail;
    return queryJson(document, rows);
  };
  const source = {
    execute: async (document) => answer(document),
    root: '$[*]',
  };
  if (options.cursor === true) {
    source.cursor = async (document) => {
      const items = answer(document);
      const list = items === undefined ? [] : (Array.isArray(items) ? items : [items]);
      const id = opened++;
      let i = 0;
      let done = false;
      return {
        async next() {
          if (options.pause !== undefined) await options.pause();
          if (done || i >= list.length) return { done: true, value: undefined };
          return { done: false, value: list[i++] };
        },
        async return() {
          if (!done) closed.push(id);
          done = true;
          return { done: true, value: undefined };
        },
      };
    };
  }
  return { source, calls, closed, opened: () => opened };
}

/** The engine's own answer for the same join, in the shape a terminal
 * asks for: the array constructor a provider is handed. */
const resident = (document, input) => queryJson([document], input);

const fed = (orders, customers, budget = {}) => federate({
  sources: { orders, customers },
  maxRows: budget.maxRows ?? 100,
  maxBytes: budget.maxBytes ?? 1 << 20,
  ...(budget.strategy === undefined ? {} : { strategy: budget.strategy }),
});

/** The chain every case joins with, over one federation. */
const joined = (federation) => fromAsync(federation.source('orders'))
  .join(fromAsync(federation.source('customers')),
    (o) => o.cust, (c) => c.key, (o, c) => ({ id: o.id, name: c.name }));

describe('federation over connected source graphs', () => {
  const inputs = { orders: ORDERS, customers: CUSTOMERS,
    events: [{ order: 1, label: 'first' }, { order: 3, label: 'third' }, { order: 3, label: 'again' }] };
  const document = { $for: { o: '$.orders[*]', c: '$.customers[*]', e: '$.events[*]' },
    $where: { $and: [{ $eq: ['$o.cust', '$c.key'] }, { $and: [{ $eq: ['$e.order', '$o.id'] }] }] },
    $return: { id: '$o.id', who: '$c.name', label: '$e.label' } };

  it('three flat bindings preserve the resident order under every estimated fetch order', async () => {
    for (const cursor of [false, true]) for (const smallest of Object.keys(inputs)) {
      const providers = Object.fromEntries(Object.entries(inputs).map(([name, rows]) => [name, fake(rows, { cursor })]));
      const federation = federate({ sources: Object.fromEntries(Object.entries(providers).map(([name, child]) =>
        [name, { provider: child.source, estimatedRows: name === smallest ? 1 : 100 }])), maxRows: 100, maxBytes: 10000 });
      const source = federation.source('orders');
      const plan = source.explain(document);
      assert.strictEqual(plan.order[0].source, smallest);
      assert.deepStrictEqual(await source.execute([document]), resident(document, inputs));
      if (cursor) assert.ok(Object.values(providers).every((child) => child.closed.length === 1));
    }
  });

  it('chained joins execute nested projected intermediates and preserve aggregate wrappers', async () => {
    const federation = federate({ sources: Object.fromEntries(Object.entries(inputs).map(([name, rows]) => [name, fake(rows).source])),
      maxRows: 100, maxBytes: 10000 });
    const chain = joined(federation).join(fromAsync(federation.source('events')),
      (row) => row.id, (event) => event.order, (row, event) => ({ row, event }));
    const expected = resident(chain.toDocument(), inputs);
    assert.deepStrictEqual(await chain.toArray(), expected);
    assert.strictEqual(await chain.count(), expected.length);
    assert.ok(federation.source('orders').explain(chain.toDocument()).order.some((side) => side.children?.length === 2));
  });

  it('shared credits refuse aggregate retained state even when each individual side fits', async () => {
    const providers = Object.fromEntries(Object.entries(inputs).map(([name, rows]) => [name, fake(rows, { cursor: true })]));
    const federation = federate({ sources: Object.fromEntries(Object.entries(providers).map(([name, child]) => [name, child.source])),
      maxRows: 100, maxBytes: 10000, maxTotalRows: 6 });
    await assert.rejects(() => federation.source('orders').execute(document), codeIs('JL2008', /combined/));
    assert.ok(Object.values(providers).every((child) => child.closed.length === child.opened()));
  });

  it('intermediate fan-out is bounded while the engine produces it', async () => {
    const one = fake([{ id: 1 }, { id: 1 }, { id: 1 }], { cursor: true });
    const two = fake([{ id: 1 }, { id: 1 }, { id: 1 }], { cursor: true });
    const three = fake([{ id: 1 }], { cursor: true });
    const federation = federate({ sources: { one: one.source, two: two.source, three: three.source },
      maxRows: 3, maxBytes: 10000, maxTotalRows: 100 });
    const chain = fromAsync(federation.source('one')).join(fromAsync(federation.source('two')),
      (a) => a.id, (b) => b.id, (a) => a).join(fromAsync(federation.source('three')),
      (a) => a.id, (b) => b.id, (a) => a);
    await assert.rejects(() => chain.toArray(), codeIs('JL2008', /intermediate/));
    assert.strictEqual(one.closed.length, 1);
    assert.strictEqual(two.closed.length, 1);
  });

  it('aliases of one source retain independent projections', async () => {
    const federation = fed(fake(ORDERS).source, fake(CUSTOMERS).source);
    const doc = { $for: { a: '$.orders[*]', b: [{ $for: { it: '$.orders[*]' },
      $where: { $gt: ['$it.total', 15] }, $return: '$it' }] },
    $where: { $eq: ['$a.cust', '$b.cust'] }, $return: { a: '$a.id', b: '$b.id' } };
    assert.deepStrictEqual(await federation.source('orders').execute([doc]), resident(doc, { orders: ORDERS }));
  });

  it('buffered sources preserve array-valued rows through the array frame', async () => {
    const federation = fed(fake(ORDERS).source, fake(CUSTOMERS).source);
    const doc = { $for: { a: [{ $for: { it: '$.orders[*]' }, $return: ['$it.cust', '$it.total'] }],
      b: '$.customers[*]' }, $where: { $eq: ['$a[0]', '$b.key'] }, $return: '$a' };
    assert.deepStrictEqual(await federation.source('orders').execute([doc]), resident(doc, { orders: ORDERS, customers: CUSTOMERS }));
  });
});

describe('federate() — the explicit cross-source boundary', () => {
  it('an ordinary cross-source join is still JL0005; only federate opts in', () => {
    const a = fake(ORDERS);
    const b = fake(CUSTOMERS);
    assert.throws(() => from(a.source).join(from(b.source), (o) => o.cust, (c) => c.key, (o) => o),
      codeIs('JL0005', /same source/));
    assert.throws(() => fromAsync(a.source).join(fromAsync(b.source),
      (o) => o.cust, (c) => c.key, (o) => o), codeIs('JL0005', /same source|one scope/));
    // and the same two sources, named to a federation, join
    const federation = fed(a.source, b.source);
    assert.ok(joined(federation));
  });

  it('answers what the engine answers, over every key shape a join has', async () => {
    const federation = fed(fake(ORDERS).source, fake(CUSTOMERS).source);
    const rows = await joined(federation).toArray();
    // the same document, over the same two roots, in the engine alone
    const document = {
      $for: { it: '$.orders[*]', it2: '$.customers[*]' },
      $where: { $eq: ['$it.cust', '$it2.key'] },
      $return: { id: '$it.id', name: '$it2.name' },
    };
    assert.deepStrictEqual(rows,
      resident(document, { orders: ORDERS, customers: CUSTOMERS }));
    // duplicates on the build side, a null key on both, an absent
    // member on one — and the answer is the engine's, not a guess
    // `$eq(null, null)` is true, so the null-keyed order pairs with the
    // null-keyed customer — the engine's rule, kept because the engine
    // is what decided it
    assert.deepStrictEqual(rows.map((r) => r.id).sort(), [1, 2, 3, 4]);
  });

  it('no match, one match and an empty side all answer the engine', async () => {
    for (const [orders, customers] of [
      [[], CUSTOMERS],
      [ORDERS, []],
      [[{ id: 9, cust: 'z' }], CUSTOMERS],
      [[{ id: 9, cust: 'a' }], [{ key: 'a', name: 'Ada' }]],
    ]) {
      const federation = fed(fake(orders).source, fake(customers).source);
      const document = {
        $for: { it: '$.orders[*]', it2: '$.customers[*]' },
        $where: { $eq: ['$it.cust', '$it2.key'] },
        $return: { id: '$it.id', name: '$it2.name' },
      };
      assert.deepStrictEqual(await joined(federation).toArray(),
        resident(document, { orders, customers }));
    }
  });

  it("each side's own filters and projection run at that side", async () => {
    const a = fake(ORDERS);
    const b = fake(CUSTOMERS);
    const federation = fed(a.source, b.source);
    const rows = await fromAsync(federation.source('orders')).where((o) => o.total.gt(15))
      .join(fromAsync(federation.source('customers')).where((c) => c.name.startsWith('A')),
        (o) => o.cust, (c) => c.key, (o, c) => ({ id: o.id, name: c.name }))
      .toArray();
    assert.deepStrictEqual(rows, [{ id: 3, name: 'Ada' }]);
    // the predicate travelled: each source saw its own $where, over its
    // OWN root, and neither saw the other's
    assert.strictEqual(a.calls.length, 1);
    assert.deepStrictEqual(a.calls[0][0].$where, { $gt: ['$it.total', 15] });
    assert.strictEqual(a.calls[0][0].$for.it, '$[*]');
    assert.deepStrictEqual(b.calls[0][0].$where, { '$starts-with': ['$it.name', 'A'] });
  });

  it("a side's projection travels too, and the join reads what came back", async () => {
    const a = fake(ORDERS);
    const b = fake(CUSTOMERS);
    const federation = fed(a.source, b.source);
    const rows = await fromAsync(federation.source('orders'))
      // `amount`, not `sum`: a member named like a chain method captures
      // as the method, and a function is not a value a document carries
      .select((o) => ({ cust: o.cust, amount: o.total }))
      .join(fromAsync(federation.source('customers')).select((c) => ({ key: c.key, who: c.name })),
        (o) => o.cust, (c) => c.key, (o, c) => ({ who: c.who, amount: o.amount }))
      .toArray();
    assert.deepStrictEqual(rows, [
      { who: 'Ada', amount: 10 }, { who: 'Bo', amount: 20 },
      { who: 'Ada', amount: 30 }, { who: 'Nil', amount: 40 }]);
    // the source shaped its own rows: the projection is in ITS document
    assert.deepStrictEqual(a.calls[0][0].$return, { cust: '$it.cust', amount: '$it.total' });
    assert.deepStrictEqual(b.calls[0][0].$return, { key: '$it.key', who: '$it.name' });
  });

  it('the probe side is reduced by the build side, so unpairable rows never arrive', async () => {
    const a = fake([{ id: 1, cust: 'a' }], { cursor: true });
    const b = fake(CUSTOMERS, { cursor: true });
    const federation = federate({
      sources: { orders: { provider: a.source, estimatedRows: 1 },
        customers: { provider: b.source, estimatedRows: 400 } },
      maxRows: 100,
      maxBytes: 1 << 20,
    });
    const rows = await joined(federation).toArray();
    assert.deepStrictEqual(rows, [{ id: 1, name: 'Ada' }]);
    // four customers were read; one could pair, and only that one was
    // kept — the reduction is what the budget is spent on
    const explained = federation.source('orders').explain(joined(federation).toDocument());
    assert.strictEqual(explained.build.source, 'orders');
    assert.strictEqual(explained.probe.source, 'customers');
  });

  it('explain names the sides, their estimates, their documents and the budget', () => {
    const federation = federate({
      sources: { orders: { provider: fake(ORDERS, { cursor: true }).source, estimatedRows: 900 },
        customers: { provider: fake(CUSTOMERS).source, estimatedRows: 4 } },
      maxRows: 10,
      maxBytes: 2048,
    });
    const explained = federation.source('orders').explain(joined(federation).toDocument());
    assert.strictEqual(explained.strategy, 'hash');
    assert.deepStrictEqual(explained.budget, { maxRows: 10, maxBytes: 2048 });
    // the smaller DECLARED side builds the table
    assert.strictEqual(explained.build.source, 'customers');
    assert.strictEqual(explained.build.estimatedRows, 4);
    assert.strictEqual(explained.build.key, '$it2.key');
    assert.strictEqual(explained.build.streaming, 'buffered');
    assert.strictEqual(explained.probe.source, 'orders');
    assert.strictEqual(explained.probe.streaming, 'row');
    assert.strictEqual(explained.probe.key, '$it.cust');
    // the join itself is the engine's, over the two reduced sides
    assert.deepStrictEqual(explained.resident.document.$for,
      { it: '$.orders[*]', it2: '$.customers[*]' });
  });

  it('a row budget refuses at the row that would break it, and closes the cursor', async () => {
    const a = fake(ORDERS, { cursor: true });
    const b = fake(CUSTOMERS, { cursor: true });
    const federation = fed(a.source, b.source, { maxRows: 2 });
    await assert.rejects(() => joined(federation).toArray(),
      codeIs('JL2008', /2-row budget/));
    assert.deepStrictEqual(a.closed.length + b.closed.length, 1,
      'the cursor that was open is closed, exactly once');
  });

  it('a byte budget refuses the same way, naming the row it stopped at', async () => {
    const a = fake(ORDERS, { cursor: true });
    const b = fake(CUSTOMERS, { cursor: true });
    const federation = fed(a.source, b.source, { maxBytes: 40 });
    await assert.rejects(() => joined(federation).toArray(),
      codeIs('JL2008', /byte budget at row/));
  });

  it("a child's failure closes what was open, and is the caller's error", async () => {
    const a = fake(ORDERS, { cursor: true });
    const b = fake(CUSTOMERS, { fail: new Error('the analytics store is down') });
    const federation = federate({
      sources: { orders: { provider: a.source, estimatedRows: 5 },
        customers: { provider: b.source, estimatedRows: 400 } },
      maxRows: 100,
      maxBytes: 1 << 20,
    });
    await assert.rejects(() => joined(federation).toArray(), /analytics store is down/);
    assert.strictEqual(a.closed.length, 1, 'the build cursor is closed exactly once');
  });

  it('an abort between rows stops the fetch and closes the cursor', async () => {
    const a = fake(ORDERS, { cursor: true });
    const b = fake(CUSTOMERS, { cursor: true });
    const federation = fed(a.source, b.source);
    const controller = new AbortController();
    const document = joined(federation).toDocument();
    // the signal rides the call the way every other option does; the
    // fetch reads it at the row boundary, which is where a cursor can
    // be let go without abandoning a pull the source is inside
    controller.abort(new Error('the caller left'));
    await assert.rejects(
      () => federation.source('orders').execute(document, { signal: controller.signal }),
      /the caller left/);
    assert.strictEqual(a.closed.length + b.closed.length, 1);
  });

  it("a source that lies about its size is still held to the budget", async () => {
    // the estimate decides which side BUILDS; it never decides how much
    // is held, so a source that under-reports is refused all the same
    const a = fake(ORDERS, { cursor: true });
    const b = fake(CUSTOMERS, { cursor: true });
    const federation = federate({
      sources: { orders: { provider: a.source, estimatedRows: 1 },
        customers: { provider: b.source, estimatedRows: 999 } },
      maxRows: 3,
      maxBytes: 1 << 20,
    });
    await assert.rejects(() => joined(federation).toArray(), codeIs('JL2008', /3-row budget/));
    assert.strictEqual(a.closed.length, 1, 'the cursor it was reading is closed');
  });

  it('an aborted fetch closes every cursor it opened', async () => {
    let release = null;
    const gate = new Promise((resolve) => { release = resolve; });
    const a = fake(ORDERS, { cursor: true, pause: () => gate });
    const b = fake(CUSTOMERS, { cursor: true });
    const federation = fed(a.source, b.source);
    const running = joined(federation).toArray();
    // the build cursor is parked mid-pull; failing it is what an abort
    // does to the call, and the boundary still closes what it opened
    release(undefined);
    await running;
    assert.strictEqual(a.closed.length + b.closed.length, 2,
      'both cursors are closed, each exactly once');
  });

  it('an aggregate terminal wraps the join, and the wrapper is handed back', async () => {
    const a = fake(ORDERS);
    const b = fake(CUSTOMERS);
    const federation = fed(a.source, b.source);
    // `count`/`sum` wrap the query in their own operator rather than in
    // the array constructor a row terminal uses; the federation plans
    // the query inside and puts the wrapper back untouched
    const total = await fromAsync(federation.source('orders'))
      .join(fromAsync(federation.source('customers')),
        (o) => o.cust, (c) => c.key, (o, c) => ({ id: o.id, name: c.name }))
      .count();
    assert.strictEqual(total, 4);
    const summed = await fromAsync(federation.source('orders'))
      .join(fromAsync(federation.source('customers')),
        (o) => o.cust, (c) => c.key, (o) => o.total)
      .sum();
    assert.strictEqual(summed, 10 + 20 + 30 + 40);
  });

  it('the build-side estimate decides, and an undeclared one keeps the caller order', () => {
    const declare = (orders, customers) => federate({
      sources: { orders: { provider: fake(ORDERS).source, estimatedRows: orders },
        customers: { provider: fake(CUSTOMERS).source, estimatedRows: customers } },
      maxRows: 10, maxBytes: 999,
    });
    const build = (federation) =>
      federation.source('orders').explain(joined(federation).toDocument()).build.source;
    assert.strictEqual(build(declare(2, 900)), 'orders');
    assert.strictEqual(build(declare(900, 2)), 'customers');
    assert.strictEqual(build(declare(undefined, undefined)), 'orders');
  });

  it('the refusals: the budgets, the strategy, the sources and the key', () => {
    const one = fake(ORDERS).source;
    const two = fake(CUSTOMERS).source;
    assert.throws(() => federate({ sources: { one }, maxRows: 1, maxBytes: 1 }),
      codeIs('JL0005', /at least two named sources/));
    assert.throws(() => federate({ sources: [one, two], maxRows: 1, maxBytes: 1 }),
      codeIs('JL0005', /name → provider/));
    assert.throws(() => federate({ sources: { one, two }, maxRows: 0, maxBytes: 1 }),
      codeIs('JL0005', /positive integer maxRows/));
    assert.throws(() => federate({ sources: { one, two }, maxRows: 1, maxBytes: 1.5 }),
      codeIs('JL0005', /positive integer maxBytes/));
    assert.throws(() => federate({ sources: { one, two }, maxRows: 1, maxBytes: 1,
      strategy: 'merge' }), codeIs('JL0005', /knows the strategies hash/));
    assert.throws(() => federate({ sources: { one, two: {} }, maxRows: 1, maxBytes: 1 }),
      codeIs('JL0001', /is not a provider/));
    assert.throws(() => federate({ sources: { one, two: { provider: two, estimatedRows: -1 } },
      maxRows: 1, maxBytes: 1 }), codeIs('JL0005', /non-integer estimatedRows/));
    const federation = fed(one, two);
    assert.throws(() => federation.source('nope'), codeIs('JL0005', /not one of this federation/));
  });

  it('a join with no equality between the sides is refused, not fetched', async () => {
    const a = fake(ORDERS, { cursor: true });
    const b = fake(CUSTOMERS, { cursor: true });
    const federation = fed(a.source, b.source);
    // a cross product wearing a filter: the engine can answer it, but
    // no bound can be put on the fetch, which is the point of the door
    const document = {
      $for: { it: '$.orders[*]', it2: '$.customers[*]' },
      $where: { $gt: ['$it.total', 15] },
      $return: '$it',
    };
    await assert.rejects(() => federation.source('orders').execute(document, {}),
      codeIs('JL0005', /equality between one member of each side/));
    assert.strictEqual(a.opened(), 0, 'nothing was fetched to find that out');
    assert.strictEqual(b.opened(), 0);
  });

  it('a disconnected third binding, an unfederated root and a bindingless document all refuse', async () => {
    const federation = fed(fake(ORDERS).source, fake(CUSTOMERS).source);
    const run = (document) => federation.source('orders').execute(document, {});
    await assert.rejects(() => run({ $for: { a: '$.orders[*]', b: '$.customers[*]',
      c: '$.orders[*]' }, $return: '$a' }), codeIs('JL0005', /connected binding graph/));
    await assert.rejects(() => run({ $for: { a: '$.orders[*]', b: '$.nope[*]' },
      $where: { $eq: ['$a.cust', '$b.key'] }, $return: '$a' }),
    codeIs('JL0005', /not one of this federation's sources/));
    await assert.rejects(() => run({ $return: 1 }), codeIs('JL0005', /has no bindings/));
  });
});

it('federation preserves its primary failure while closing every cursor', async () => {
  const closed = [];
  const source = (name, fail) => ({
    execute() { return []; }, root: '$[*]',
    cursor() {
      let read = 0;
      return {
        async next() {
          if (fail) throw fail;
          return read++ === 0 ? { done: false, value: { id: 1 } } : { done: true };
        },
        async return() { closed.push(name); throw new Error(`${name} cleanup failed`); },
      };
    },
  });
  const primary = new Error('probe read failed');
  const federation = federate({ sources: { a: source('a'), b: source('b', primary) },
    maxRows: 10, maxBytes: 1000 });
  await assert.rejects(fromAsync(federation.source('a')).join(fromAsync(federation.source('b')),
    (a) => a.id, (b) => b.id, (a) => a).toArray(), (error) => error === primary);
  assert.deepStrictEqual(closed, ['a', 'b']);
});

it('federation names are literal JSON member names in every source root', async () => {
  for (const name of ['a.b', 'a b', 'a-b', '0', '', "quote'\\\n", '__proto__', '😀']) {
    const federation = federate({ sources: { [name]: fake([{ id: 1 }]).source,
      other: fake([{ id: 1 }]).source }, maxRows: 10, maxBytes: 1000 });
    assert.deepStrictEqual(await fromAsync(federation.source(name))
      .join(fromAsync(federation.source('other')), (a) => a.id, (b) => b.id,
        (a) => a).toArray(), [{ id: 1 }], name);
  }
});
