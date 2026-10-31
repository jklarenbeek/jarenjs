//@ts-check
/**
 * @file A provider chain's document has the shape a store translates under
 * strict execution. A window over the provider's own root closes the root's
 * phrase as a FLWOR, so `take(n).select(f)` is `$subsequence` over
 * `{ $for: { it: '$.Run[*]' }, $return: f }` when `f` maps every row to
 * exactly one item and cannot raise (a constructor of singular paths and
 * literals), and an untouched chain hands the provider the FLWOR over its
 * root for each terminal and for its cursor, on both surfaces; a quantifier
 * still binds the root itself, and `toDocument()` of the untouched chain is
 * still the root. Those chains were refused `JD0010` under `strict` — the
 * window inside the projection's binding, or the bare root path — while the
 * engine residual answered them. A projection that can drop, add or raise
 * keeps its window inside, and a chain over rows in memory emits what it
 * did. Generated chains compare strict execution, the residual, the
 * in-memory chain and a plain JavaScript reading of the same operators:
 * every strict answer equals the other three or is a coded refusal. SQLite
 * always, PostgreSQL where JAREN_PG_URL names a server.
 */
import { after, before, describe, it } from 'node:test';
import * as assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { from, fromAsync, fromDocument } from '@jarenjs/linq';
import { queryJson } from '@jarenjs/json/query';
import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { postgresDriver } from '@jarenjs/db/postgres';

const url = process.env.JAREN_PG_URL;
const ROOT = '$.Run[*]';
/** The phrase a provider plans over its own root. */
const ALL = { $for: { it: ROOT }, $return: '$it' };

/** A provider recording every document it is handed, over `root` (none
 * when `root` is null: the whole input). @param {string | null} [root] */
function recording(root = ROOT) {
  /** @type {{ member: string, document: any }[]} */
  const calls = [];
  /** @type {any} */
  const provider = {
    execute(/** @type {any} */ document) {
      calls.push({ member: 'execute', document });
      return Array.isArray(document) ? [] : 0;
    },
    cursor(/** @type {any} */ document) {
      calls.push({ member: 'cursor', document });
      return (async function* () {})();
    },
    syncQuery(/** @type {any} */ document) {
      calls.push({ member: 'syncQuery', document });
      return [];
    },
  };
  if (root !== null) provider.root = root;
  return { provider, calls };
}

/** Both surfaces over one provider. @param {any} provider */
const surfaces = (provider) => /** @type {[string, any][]} */ ([['async', fromAsync(provider)], ['sync', from(provider)]]);

describe('a window over the provider root closes its phrase as a FLWOR', () => {
  /** @type {[string, (q: any) => any, any][]} */
  const FOLDED = [
    ['take(5).select', (q) => q.take(5).select((/** @type {any} */ r) => ({ id: r.id })),
      { $subsequence: [{ $for: { it: ROOT }, $return: { id: '$it.id' } }, 0, 5] }],
    ['orderBy.take(5).select', (q) => q.orderBy((/** @type {any} */ r) => r.id).take(5).select((/** @type {any} */ r) => ({ id: r.id, name: r.name })),
      { $subsequence: [{ $for: { it: ROOT }, $orderby: { $key: '$it.id' }, $return: { id: '$it.id', name: '$it.name' } }, 0, 5] }],
    ['orderBy.skip(6).select', (q) => q.orderBy((/** @type {any} */ r) => r.id).skip(6).select((/** @type {any} */ r) => ({ id: r.id })),
      { $subsequence: [{ $for: { it: ROOT }, $orderby: { $key: '$it.id' }, $return: { id: '$it.id' } }, 6] }],
    ['where.orderByDescending.take(50).select', (q) => q.where((/** @type {any} */ r) => r.n.gt(0))
      .orderByDescending((/** @type {any} */ r) => r.id).take(50).select((/** @type {any} */ r) => ({ id: r.id })),
    { $subsequence: [{ $for: { it: ROOT }, $where: { $gt: ['$it.n', 0] }, $orderby: { $key: '$it.id', $dir: 'desc' },
      $return: { id: '$it.id' } }, 0, 50] }],
    ['skip(2).take(3).select of an array', (q) => q.skip(2).take(3).select((/** @type {any} */ r) => [r.id, r.tags.all()]),
      { $subsequence: [{ $subsequence: [{ $for: { it: ROOT }, $return: ['$it.id', '$it.tags[*]'] }, 2] }, 0, 3] }],
    ['take(2).select of singular paths, literals and a parameter', (q) => q.params({ k: 3 }).take(2)
      .select((/** @type {any} */ r, /** @type {any} */ p) => ({ a: r.list.at(0), b: r.get('odd key'), c: 'x', d: { e: r.n }, f: p.k, g: { $x: 1 } })),
    { $subsequence: [{ $for: { it: ROOT },
      $return: { a: '$it.list[0]', b: "$it['odd key']", c: 'x', d: { e: '$it.n' }, f: '$k', g: { $const: { $x: 1 } } } }, 0, 2] }],
    ['take(3) alone', (q) => q.take(3), { $subsequence: [ALL, 0, 3] }],
  ];
  for (const [name, build, document] of FOLDED) {
    it(name, () => {
      for (const [surface, chain] of surfaces(recording().provider)) {
        assert.deepStrictEqual(build(chain).toDocument(), document, surface);
      }
    });
  }

  it('a projection that can drop, add or raise keeps its window inside', () => {
    /** @type {[(q: any) => any, any][]} */
    const table = [
      [(q) => q.take(5).select((/** @type {any} */ r) => r.name), '$it.name'],
      [(q) => q.take(5).select((/** @type {any} */ r) => ({ u: r.name.upper() })), { u: { $upper: '$it.name' } }],
      [(q) => q.take(5).select((/** @type {any} */ r) => ({ t: r.tags.all() })), { t: '$it.tags[*]' }],
      [(q) => q.take(5).selectMany((/** @type {any} */ r) => r.tags), { $for: { it: '$it.tags' }, $return: '$it' }],
    ];
    for (const [build, projection] of table) {
      for (const [surface, chain] of surfaces(recording().provider)) {
        assert.deepStrictEqual(build(chain).toDocument(),
          { $for: { it: [{ $subsequence: [ALL, 0, 5] }] }, $return: projection }, surface);
      }
    }
  });

  it('a provider that declares no root, and a stored document, emit what they did', async () => {
    const select = (/** @type {any} */ r) => ({ id: r.id });
    for (const [surface, chain] of surfaces(recording(null).provider)) {
      assert.deepStrictEqual(chain.take(5).select(select).toDocument(),
        { $for: { it: [{ $subsequence: ['$[*]', 0, 5] }] }, $return: { id: '$it.id' } }, surface);
      assert.deepStrictEqual(chain.take(3).toDocument(), { $subsequence: ['$[*]', 0, 3] }, surface);
    }
    for (const surface of ['async', 'sync']) {
      const { provider, calls } = recording(null);
      const chain = surface === 'async' ? fromAsync(provider) : from(provider);
      await chain.count();
      await chain.toArray();
      assert.deepStrictEqual(calls.map((call) => call.document), [{ $count: '$[*]' }, ['$[*]']], surface);
    }
    const { provider, calls } = recording();
    const stored = fromDocument(provider, '$.Other[*]');
    assert.deepStrictEqual(stored.take(2).select(select).toDocument(),
      { $for: { it: [{ $subsequence: ['$.Other[*]', 0, 2] }] }, $return: { id: '$it.id' } });
    stored.toArray();
    assert.deepStrictEqual(calls, [{ member: 'execute', document: ['$.Other[*]'] }]);
  });

  it('a chain over rows in memory emits the window inside, as it did', () => {
    assert.deepStrictEqual(from([{ id: 1 }]).take(5).select((r) => ({ id: r.id })).toDocument(),
      { $for: { it: [{ $subsequence: ['$[*]', 0, 5] }] }, $return: { id: '$it.id' } });
    assert.deepStrictEqual(from([{ id: 1 }]).take(5).toDocument(), { $subsequence: ['$[*]', 0, 5] });
  });

  it('a raising projection past the window still answers the window', async () => {
    const rows = [{ a: 6, b: 3 }, { a: 1, b: 0 }];
    const provider = { root: ROOT, execute: (/** @type {any} */ d, /** @type {any} */ o) => queryJson(d, { Run: rows }, o.externals) };
    const build = (/** @type {any} */ q) => q.take(1).select((/** @type {any} */ r) => ({ q: r.a.idiv(r.b) }));
    assert.deepStrictEqual(build(from(rows)).toArray(), [{ q: 2 }]);
    assert.deepStrictEqual(build(from(provider)).toArray(), [{ q: 2 }]);
    assert.deepStrictEqual(await build(fromAsync(provider)).toArray(), [{ q: 2 }]);
  });
});

describe('an untouched chain hands the provider the FLWOR over its root', () => {
  it('toDocument() is still the root', () => {
    for (const [surface, chain] of surfaces(recording().provider)) assert.strictEqual(chain.toDocument(), ROOT, surface);
  });

  it('every terminal wraps the phrase, a quantifier binds the root itself, on both surfaces', async () => {
    const pred = { $gt: ['$it.n', 3] };
    /** @type {[string, (q: any) => any, any][]} */
    const table = [
      ['toArray', (q) => q.toArray(), [ALL]],
      ['count', (q) => q.count(), { $count: ALL }],
      ['firstOrDefault', (q) => q.firstOrDefault(null), [{ $subsequence: [ALL, 0, 1] }]],
      ['singleOrDefault', (q) => q.singleOrDefault(null), [{ $subsequence: [ALL, 0, 2] }]],
      ['lastOrDefault', (q) => q.lastOrDefault(null), [{ $subsequence: [{ $reverse: ALL }, 0, 1] }]],
      ['elementAtOrDefault', (q) => q.elementAtOrDefault(2, null), [{ $subsequence: [ALL, 2, 1] }]],
      ['any', (q) => q.any(), { $exists: ALL }],
      ['any(pred)', (q) => q.any((/** @type {any} */ r) => r.n.gt(3)), { $some: { it: ROOT }, $satisfies: pred }],
      ['all(pred)', (q) => q.all((/** @type {any} */ r) => r.n.gt(3)), { $every: { it: ROOT }, $satisfies: pred }],
    ];
    for (const [name, run, document] of table) {
      for (const surface of ['async', 'sync']) {
        const { provider, calls } = recording();
        await run(surface === 'async' ? fromAsync(provider) : from(provider));
        assert.deepStrictEqual(calls, [{ member: 'execute', document }], `${surface} ${name}`);
      }
    }
  });

  it('iteration hands the cursor the phrase, a mapAsync split too', async () => {
    const asyncCalls = recording();
    for await (const row of fromAsync(asyncCalls.provider)) assert.fail(row);
    for await (const row of fromAsync(asyncCalls.provider).mapAsync((/** @type {any} */ x) => x, { concurrency: 1 })) assert.fail(row);
    assert.deepStrictEqual(asyncCalls.calls, [{ member: 'cursor', document: ALL }, { member: 'cursor', document: ALL }]);
    const syncCalls = recording();
    for (const row of from(syncCalls.provider)) assert.fail(row);
    assert.deepStrictEqual(syncCalls.calls, [{ member: 'syncQuery', document: ALL }]);
  });
});

const PROPS = { id: { type: 'integer', 'x-entity': { key: true } }, name: { type: 'string' }, n: { type: 'integer' } };
const DATA = Array.from({ length: 8 }, (_, i) => ({ id: i + 1, name: `r${i + 1}`, n: (i + 1) * 10 }));

/** The entity set as a provider whose every read is strict. @param {any} set */
const strictAsync = (set) => fromAsync({ root: set.root, scope: set.scope, relations: set.relations,
  execute: (/** @type {any} */ d, /** @type {any} */ o) => set.execute(d, { ...o, strict: true }),
  cursor: (/** @type {any} */ d, /** @type {any} */ o) => set.cursor(d, { ...o, strict: true }) });
/** The synchronous twin as a strict provider. @param {any} set */
const strictSync = (set) => from({ root: set.root, scope: set.scope, relations: set.relations,
  execute: (/** @type {any} */ d, /** @type {any} */ o) => set.execute(d, { ...o, strict: true }),
  syncQuery: (/** @type {any} */ d, /** @type {any} */ o) => set.cursor(d, { ...o, strict: true }) });

/** Every row a chain yields, iterating it. @param {any} chain */
async function iterated(chain) {
  const out = [];
  if (typeof chain[Symbol.asyncIterator] === 'function') { for await (const row of chain) out.push(row); }
  else { for (const row of chain) out.push(row); }
  return out;
}

/** What a run answers: its value, or its error's code. @param {() => any} run */
async function outcome(run) {
  try { return { value: await run() }; }
  catch (error) { return { code: /** @type {any} */ (error).code ?? String(error) }; }
}

describe('the chains strict execution refused now answer, over SQLite', () => {
  /** @type {[string, (q: any) => any][]} */
  const CHAINS = [
    ['toArray()', (q) => q.toArray()],
    ['count()', (q) => q.count()],
    ['iterated', (q) => iterated(q)],
    ['firstOrDefault()', (q) => q.firstOrDefault(null)],
    ['take(3).toArray()', (q) => q.take(3).toArray()],
    ['orderBy(id).take(5).select({id,name})', (q) => q.orderBy((/** @type {any} */ r) => r.id).take(5)
      .select((/** @type {any} */ r) => ({ id: r.id, name: r.name })).toArray()],
    ['take(5).select({id})', (q) => q.take(5).select((/** @type {any} */ r) => ({ id: r.id })).toArray()],
    ['orderBy(id).skip(6).select({id})', (q) => q.orderBy((/** @type {any} */ r) => r.id).skip(6)
      .select((/** @type {any} */ r) => ({ id: r.id })).toArray()],
    ['where.orderByDescending(id).take(3).select({id})', (q) => q.where((/** @type {any} */ r) => r.n.gt(0))
      .orderByDescending((/** @type {any} */ r) => r.id).take(3).select((/** @type {any} */ r) => ({ id: r.id })).toArray()],
    ['orderBy(id).take(5).select({id}).first()', (q) => q.orderBy((/** @type {any} */ r) => r.id).take(5)
      .select((/** @type {any} */ r) => ({ id: r.id })).first()],
    ['skip(6).select({id}).elementAt(1)', (q) => q.skip(6).select((/** @type {any} */ r) => ({ id: r.id })).elementAt(1)],
    ['take(5).select({id}) iterated', (q) => iterated(q.take(5).select((/** @type {any} */ r) => ({ id: r.id })))],
  ];
  /** @type {any} */
  let store;
  let dir = '';
  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'jaren-strict-windows-'));
    const path = join(dir, 'a.sqlite');
    const seed = await nodeDriver().open(path);
    seed.exec('CREATE TABLE runs(id INTEGER PRIMARY KEY, name TEXT NOT NULL, n INTEGER NOT NULL)');
    for (const row of DATA) seed.prepare('INSERT INTO runs VALUES (?, ?, ?)').run([row.id, row.name, row.n]);
    seed.close();
    const physical = { table: 'runs', columns: { id: { name: 'id', codec: 'integer', null: 'reject' },
      name: { name: 'name', codec: 'text', null: 'reject' }, n: { name: 'n', codec: 'integer', null: 'reject' } } };
    store = await openStore({ $model: '0.1', entities: {
      Run: { schema: { type: 'object', properties: PROPS }, physical },
      Doc: { schema: { type: 'object', properties: PROPS } } } }, { driver: nodeDriver(), path });
    for (const row of DATA) await store.entity('Doc').create(row);
  });
  after(async () => { await store?.close(); rmSync(dir, { recursive: true, force: true }); });

  for (const entity of ['Run', 'Doc']) {
    for (const [name, run] of CHAINS) {
      it(`${entity}: ${name}`, async () => {
        const expected = await outcome(() => run(from(DATA)));
        assert.ok('value' in expected, name);
        assert.deepStrictEqual(await outcome(() => run(fromAsync(store.entity(entity)))), expected, 'the residual');
        assert.deepStrictEqual(await outcome(() => run(strictAsync(store.entity(entity)))), expected, 'strict, async');
        assert.deepStrictEqual(await outcome(() => run(strictSync(store.sync.entity(entity)))), expected, 'strict, sync');
      });
    }
  }

  it('inside a transaction', async () => {
    await store.transaction(async (/** @type {any} */ tx) => {
      assert.deepStrictEqual(await strictAsync(tx.entity('Run')).take(5).select((/** @type {any} */ r) => ({ id: r.id })).toArray(),
        [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }]);
      assert.strictEqual(await strictAsync(tx.entity('Doc')).count(), 8);
    });
  });
});

/** A seeded generator (mulberry32). @param {number} seed */
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Twenty rows whose `n` values are distinct, so every ordering is total. */
const ROWS = Array.from({ length: 20 }, (_, i) => ({ id: i + 1, name: `r${i + 1}`, n: ((i + 1) * 7) % 23 }));

/**
 * One generated operator: its label, the chain call and the plain JavaScript
 * reading of it. Every projection keeps `id` and `n`, so any operator may follow.
 * @typedef {{ label: string, chain: (q: any) => any, js: (xs: any[]) => any[] }} Op
 */
/** @type {((rnd: () => number) => Op)[]} */
const OPS = [
  (rnd) => { const k = Math.floor(rnd() * 25); return { label: `where(n>${k})`, chain: (q) => q.where((/** @type {any} */ r) => r.n.gt(k)), js: (xs) => xs.filter((x) => x.n > k) }; },
  (rnd) => { const k = Math.floor(rnd() * 25); return { label: `where(n<${k})`, chain: (q) => q.where((/** @type {any} */ r) => r.n.lt(k)), js: (xs) => xs.filter((x) => x.n < k) }; },
  () => ({ label: 'orderBy(n)', chain: (q) => q.orderBy((/** @type {any} */ r) => r.n), js: (xs) => [...xs].sort((a, b) => a.n - b.n) }),
  () => ({ label: 'orderByDescending(n)', chain: (q) => q.orderByDescending((/** @type {any} */ r) => r.n), js: (xs) => [...xs].sort((a, b) => b.n - a.n) }),
  (rnd) => { const k = Math.floor(rnd() * 12); return { label: `take(${k})`, chain: (q) => q.take(k), js: (xs) => xs.slice(0, k) }; },
  (rnd) => { const k = Math.floor(rnd() * 12); return { label: `skip(${k})`, chain: (q) => q.skip(k), js: (xs) => xs.slice(k) }; },
  () => ({ label: 'select({id,n})', chain: (q) => q.select((/** @type {any} */ r) => ({ id: r.id, n: r.n })), js: (xs) => xs.map((x) => ({ id: x.id, n: x.n })) }),
  () => ({ label: 'select({id,n,tag})', chain: (q) => q.select((/** @type {any} */ r) => ({ id: r.id, n: r.n, tag: 'x' })), js: (xs) => xs.map((x) => ({ id: x.id, n: x.n, tag: 'x' })) }),
  () => ({ label: 'select([id,n])->{id,n}', chain: (q) => q.select((/** @type {any} */ r) => ({ id: r.id, n: r.n, pair: [r.id, r.n] })), js: (xs) => xs.map((x) => ({ id: x.id, n: x.n, pair: [x.id, x.n] })) }),
  () => ({ label: 'select({id,n:n+1})', chain: (q) => q.select((/** @type {any} */ r) => ({ id: r.id, n: r.n.add(1) })), js: (xs) => xs.map((x) => ({ id: x.id, n: x.n + 1 })) }),
  () => ({ label: 'selectMany', chain: (q) => q.selectMany((/** @type {any} */ r) => [{ id: r.id, n: r.n }, { id: r.id, n: r.n.add(1000) }]),
    js: (xs) => xs.flatMap((x) => [{ id: x.id, n: x.n }, { id: x.id, n: x.n + 1000 }]) }),
];
/** @type {[string, (q: any) => any, (xs: any[]) => any][]} */
const TERMINALS = [
  ['toArray()', (q) => q.toArray(), (xs) => ({ value: xs })],
  ['toArray()', (q) => q.toArray(), (xs) => ({ value: xs })],
  ['iterated', (q) => iterated(q), (xs) => ({ value: xs })],
  ['count()', (q) => q.count(), (xs) => ({ value: xs.length })],
  ['first()', (q) => q.first(), (xs) => (xs.length === 0 ? { code: 'JL2001' } : { value: xs[0] })],
];

/** `count` chains, each built from a seed. @param {number} count @param {number} seed */
function generate(count, seed) {
  const rnd = random(seed);
  return Array.from({ length: count }, () => {
    const ops = Array.from({ length: 1 + Math.floor(rnd() * 4) }, () => OPS[Math.floor(rnd() * OPS.length)](rnd));
    const [terminal, run, read] = TERMINALS[Math.floor(rnd() * TERMINALS.length)];
    return {
      label: `${ops.map((op) => op.label).join('.')}.${terminal}`,
      run: (/** @type {any} */ q) => run(ops.reduce((chain, op) => op.chain(chain), q)),
      expected: read(ops.reduce((xs, op) => op.js(xs), ROWS.map((row) => ({ ...row })))),
    };
  });
}

/**
 * Run every generated chain strict, as the residual and in memory.
 * @param {any} t @param {ReturnType<typeof generate>} chains
 * @param {(i: number) => [any, any]} views - the strict and the residual chain start for chain i
 */
async function differential(t, chains, views) {
  let answered = 0;
  let refused = 0;
  for (let i = 0; i < chains.length; i++) {
    const { label, run, expected } = chains[i];
    const [strict, residual] = views(i);
    assert.deepStrictEqual(await outcome(() => run(from(ROWS))), expected, `in memory: ${label}`);
    assert.deepStrictEqual(await outcome(() => run(residual)), expected, `the residual: ${label}`);
    const got = await outcome(() => run(strict));
    if ('code' in got && got.code === 'JD0010') { refused++; continue; }
    assert.deepStrictEqual(got, expected, `strict: ${label}`);
    answered++;
  }
  t.diagnostic(`strict answered ${answered}, refused JD0010 ${refused}, of ${chains.length}`);
  assert.ok(answered > 0 && refused > 0);
}

describe('generated chains: strict answers equal the residual, memory and plain JavaScript, or are refused', () => {
  it('SQLite, both surfaces', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'jaren-strict-differential-'));
    const store = await openStore({ $model: '0.1', entities: { Run: { schema: { type: 'object', properties: PROPS } } } },
      { driver: nodeDriver(), path: join(dir, 'a.sqlite') });
    try {
      for (const row of ROWS) await store.entity('Run').create(row);
      await differential(t, generate(300, 0x5eed), (i) => (i % 2 === 0
        ? [strictAsync(store.entity('Run')), fromAsync(store.entity('Run'))]
        : [strictSync(store.sync.entity('Run')), from(store.sync.entity('Run'))]));
    }
    finally { await store.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('PostgreSQL', async (t) => {
    if (!url) { t.skip('JAREN_PG_URL is not set'); return; }
    const pg = (await import('pg')).default;
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    const pool = new pg.Pool({ connectionString: url, max: 2 });
    const schema = `jaren_strictwindows_${process.pid}`;
    /** @type {any} */
    let store = null;
    try {
      await admin.query(`CREATE SCHEMA "${schema}"`);
      store = await openStore({ $model: '0.1', entities: { Run: { schema: { type: 'object', properties: PROPS } } } },
        { driver: postgresDriver(pool, { schema }) });
      for (const row of ROWS) await store.entity('Run').create(row);
      await differential(t, generate(60, 0x9e5), () => [strictAsync(store.entity('Run')), fromAsync(store.entity('Run'))]);
    }
    finally {
      await store?.close();
      await pool.end().catch(() => {});
      try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
      finally { await admin.end(); }
    }
  });
});
