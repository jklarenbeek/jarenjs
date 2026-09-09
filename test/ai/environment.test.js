//@ts-check
/**
 * @file The environment's operations, and the rule that binds all of
 * them: **no operation returns bulk content** (D2).
 *
 * That rule is the whole design. A corpus that cannot be read into the
 * root request is a corpus that can be arbitrarily large, and every
 * operation here is capped by construction so the claim does not depend
 * on anyone remembering to pass a limit. The scale sweep in
 * `environment-scale.test.js` proves the consequence; this file proves
 * the mechanism, operation by operation.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import {
  createEnvironment, createLedger, createMemoryStorage, createToolbox, chunkSlotName,
  environmentTools,
} from '@jarenjs/ai';
import { compileJsonQuery } from '@jarenjs/json/query';

/** A corpus with a needle in the middle and nothing distinctive around it. */
function corpus(lines = 200) {
  const rows = [];
  for (let i = 0; i < lines; i++) {
    rows.push(`row ${String(i).padStart(4, '0')} ${'filler '.repeat(6)}`
      + (i === Math.floor(lines / 2) ? 'NEEDLE-7788 the fact everything is about' : ''));
  }
  return rows.join('\n');
}

const AT = '2026-08-13T09:00:00Z';
const env = (options = {}) => createEnvironment({ now: () => AT, ...options });

describe('environment replacement and bounds', () => {
  it('keeps each cached selection at its own address', async () => {
    const environment = env({ compileQuery: compileJsonQuery });
    await environment.put('data', '[1,2]');
    const sum = await environment.select('data', { $sum: '$[*]' });
    const count = await environment.select('data', { $count: '$[*]' });
    assert.strictEqual((await environment.select('data', { $sum: '$[*]' })).name, sum.name);
    assert.strictEqual(await environment.ledger.readSlot(count.name), '2');
  });
  it('removes only stale indexed pieces after a shorter or empty ingestion', async () => {
    const environment = env();
    await environment.ingest('corpus', ['current', 'stale']);
    await environment.put('corpus#given:0/note', 'keep');
    await environment.ingest('corpus', ['replacement']);
    assert.strictEqual((await environment.grep('stale')).total, 0);
    await environment.ingest('corpus', []);
    assert.deepStrictEqual((await environment.ledger.listSlots()).map((slot) => slot.name), ['corpus#given:0/note']);
  });
  it('refuses invalid caps before negative slice indices can expose bulk data', async () => {
    const environment = env();
    await environment.put('data', 'x'.repeat(10000));
    for (const bad of [-1, NaN, Infinity, 1.5, '2']) {
      assert.throws(() => env({ digestSlots: bad }), TypeError);
      await assert.rejects(environment.peek('data', { chars: bad }), TypeError);
      await assert.rejects(environment.digest({ limit: bad }), TypeError);
      await assert.rejects(environment.chunk('data', { preview: bad }), TypeError);
      await assert.rejects(environment.grep('x', { limit: bad }), TypeError);
    }
    assert.strictEqual((await environment.digest({ limit: 0 })).listed, 0);
    assert.strictEqual((await environment.chunk('data', { preview: 0 })).chunks.length, 0);
  });
  it('counts prototype-like slot kinds as own members', async () => {
    const environment = env();
    for (const kind of ['__proto__', 'constructor', 'toString']) await environment.put(kind, 'x', { kind });
    const stats = await environment.stat();
    assert.strictEqual(stats.slots, 3);
    assert.deepStrictEqual(Object.keys(stats.kinds).sort(), ['__proto__', 'constructor', 'toString']);
    for (const count of Object.values(stats.kinds)) assert.strictEqual(count, 1);
  });
});

describe('ai — the environment', function () {
  it('answers with metadata, never with content', async function () {
    const environment = env();
    const text = corpus(400);
    const stored = await environment.put('corpus', text);

    assert.strictEqual(stored.size, text.length);
    assert.ok(!JSON.stringify(stored).includes('NEEDLE-7788'),
      'putting a corpus in does not hand it back');
    const digest = await environment.digest();
    assert.strictEqual(digest.total, 1);
    assert.ok(JSON.stringify(digest).length < 1000,
      'the whole root view of a 30 kB corpus is under a kilobyte');
    assert.match(digest.hint, /Nothing here carries content/);
  });

  it('peeks a head excerpt, capped however much is asked for', async function () {
    const environment = env({ excerptChars: 100 });
    await environment.put('corpus', corpus(400));
    const peeked = await environment.peek('corpus', { chars: 1_000_000 });
    assert.ok(peeked.head.length <= 401, `the cap holds: ${peeked.head.length}`);
    assert.match(peeked.head, /^row 0000/, 'a head excerpt starts at the head');
    assert.strictEqual(peeked.size, corpus(400).length, 'the size is reported in full');
  });

  it('chunks deterministically, and re-chunking writes no second copy', async function () {
    const environment = env();
    await environment.put('corpus', corpus(300));
    const first = await environment.chunk('corpus', { size: 2000 });
    const before = (await environment.digest()).total;

    assert.ok(first.count > 3, `a 300-line corpus splits into pieces: ${first.count}`);
    assert.strictEqual(first.chunks[0].name, chunkSlotName('corpus', 'size', 2000, 0));
    assert.strictEqual(first.family, 'corpus#size:2000/');

    const second = await environment.chunk('corpus', { size: 2000 });
    assert.deepStrictEqual(second.chunks, first.chunks, 'same slot, same strategy, same addresses');
    assert.strictEqual((await environment.digest()).total, before,
      're-chunking overwrote its own slots rather than adding a second set');
  });

  it('caps what a chunk result lists, however many pieces there are', async function () {
    const environment = env();
    await environment.put('corpus', corpus(4000));
    const chunked = await environment.chunk('corpus', { size: 500 });
    assert.ok(chunked.count > 50, `many pieces: ${chunked.count}`);
    assert.ok(chunked.chunks.length <= 8);
    assert.strictEqual(chunked.omitted, chunked.count - chunked.chunks.length,
      'a capped list says how many it did not list — a silent cap is a lie about the corpus');
    assert.ok(JSON.stringify(chunked).length < 2000);
  });

  it('greps to ADDRESSES: which slot, one line, never the slot', async function () {
    const environment = env();
    await environment.put('corpus', corpus(600));
    const chunked = await environment.chunk('corpus', { strategy: 'line', size: 1500 });

    const hits = await environment.grep('NEEDLE-\\d+', { in: chunked.family });
    assert.strictEqual(hits.total, 1);
    assert.strictEqual(hits.matches.length, 1);
    assert.match(hits.matches[0].slot, /^corpus#line:1500\//);
    assert.match(hits.matches[0].line, /NEEDLE-7788/);
    assert.ok(JSON.stringify(hits).length < 1000, 'a hit list is not a corpus');
    assert.strictEqual(hits.scanned, chunked.count, 'every piece was scanned, one at a time');

    // and the address answers: read exactly that piece, with a budget
    const piece = await environment.read(hits.matches[0].slot, { chars: 2000 });
    assert.match(piece.text, /NEEDLE-7788/);
  });

  it('caps a grep that matches everything, and says how many it dropped', async function () {
    const environment = env();
    await environment.put('corpus', corpus(500));
    const hits = await environment.grep('row', {});
    assert.ok(hits.total >= 500);
    assert.ok(hits.matches.length <= 20);
    assert.strictEqual(hits.omitted, hits.total - hits.matches.length);
    assert.ok(JSON.stringify(hits).length < 4000);
  });

  it('answers a bad pattern rather than throwing', async function () {
    const environment = env();
    await environment.put('corpus', 'x');
    const hits = await environment.grep('([unclosed', {});
    assert.match(hits.error, /not a usable pattern/);
  });

  it('stats one slot and a whole family without reading either', async function () {
    const environment = env();
    await environment.put('corpus', corpus(100));
    const chunked = await environment.chunk('corpus', { size: 1000 });

    const one = await environment.stat(chunkSlotName('corpus', 'size', 1000, 0));
    assert.strictEqual(one.size, 1000);
    assert.ok(one.lines > 0);
    assert.strictEqual(one.json, false);

    const family = await environment.stat(chunked.family);
    assert.strictEqual(family.slots, chunked.count);
    assert.strictEqual(family.size, corpus(100).length,
      'the pieces account for exactly the corpus');
    assert.deepStrictEqual(family.kinds, { chunk: chunked.count });
  });

  it('read is the one call that returns text, and it demands a budget', async function () {
    const environment = env();
    await environment.put('corpus', corpus(200));
    const refused = await environment.read('corpus', {});
    assert.match(refused.error, /explicit character budget/);

    const page = await environment.read('corpus', { chars: 120 });
    assert.strictEqual(page.text.length, 120);
    assert.strictEqual(page.more, true, 'a partial read says there is more');
    assert.strictEqual(page.offset, 0);

    const next = await environment.read('corpus', { chars: 120, offset: 120 });
    assert.notStrictEqual(next.text, page.text);
  });

  it('every operation answers an unknown slot with an error and a way forward', async function () {
    // `select` is here WITH its seam wired: an unknown slot and a missing
    // compiler are two different refusals, and a test that let the seam
    // refusal stand in for the unknown-slot one would prove neither
    const environment = env({ compileQuery: compileJsonQuery });
    for (const call of [
      () => environment.peek('nope'),
      () => environment.chunk('nope'),
      () => environment.stat('nope'),
      () => environment.read('nope', { chars: 10 }),
      () => environment.select('nope', [{ $for: { it: '$[*]' }, $return: '$it' }]),
    ]) {
      const outcome = await call();
      assert.match(outcome.error, /no slot 'nope'/);
      assert.match(outcome.hint ?? '', /digest/);
    }
  });
});

describe('ai — the environment\'s query seam (D3)', function () {
  const DATA = JSON.stringify(Array.from({ length: 50 },
    (unused, i) => ({ id: `REC${String(i).padStart(4, '0')}`, value: i * 7, tag: i % 2 ? 'odd' : 'even' })));

  it('selects through the injected compiler and stores the result as a slot', async function () {
    const environment = env({ compileQuery: compileJsonQuery });
    await environment.put('records', DATA, { kind: 'json', count: 50 });

    const selected = await environment.select('records', [
      { $for: { it: '$[*]' }, $where: { $eq: ['$it.tag', 'even'] }, $return: '$it.id' },
    ], { as: 'evens' });

    assert.strictEqual(selected.name, 'evens');
    assert.strictEqual(selected.count, 25);
    assert.ok(!JSON.stringify(selected).includes('REC0048'),
      'a selection answers with its ADDRESS and size, not with its rows');
    const rows = JSON.parse((await environment.read('evens', { chars: 8000 })).text);
    assert.strictEqual(rows.length, 25);
    assert.strictEqual(rows[0], 'REC0000');
  });

  it('declines with a stated reason when the seam is empty, and nothing else changes', async function () {
    const environment = env();
    await environment.put('records', DATA, { kind: 'json' });
    const outcome = await environment.select('records', [{ $for: { it: '$[*]' }, $return: '$it' }]);
    assert.match(outcome.error, /compileQuery seam/);
    assert.match(outcome.error, /@jarenjs\/json/);
    assert.match(outcome.error, /grep/, 'a refusal that names the way around it');

    // the rest of the environment is unaffected — that is what "degrades"
    // has to mean, or the seam is a dependency in disguise
    assert.strictEqual((await environment.stat('records')).size, DATA.length);
    assert.strictEqual((await environment.grep('REC0007', {})).total, 1);
  });

  it('reports a query that does not compile as content, with its code', async function () {
    const environment = env({ compileQuery: compileJsonQuery });
    await environment.put('records', DATA, { kind: 'json' });
    const outcome = await environment.select('records', [{ $for: { it: '$[*]' }, $nonsense: 1 }]);
    assert.match(outcome.error, /does not compile/);
  });

  it('refuses to select over a slot that is not JSON', async function () {
    const environment = env({ compileQuery: compileJsonQuery });
    await environment.put('prose', 'not json at all');
    const outcome = await environment.select('prose', [{ $for: { it: '$[*]' }, $return: '$it' }]);
    assert.match(outcome.error, /is not JSON/);
  });
});

describe('ai — the environment as tools', function () {
  it('every operation is reachable through its tool, with the arguments it declares', async function () {
    const environment = env();
    const box = createToolbox();
    for (const tool of environmentTools(environment)) box.add(tool);
    await environment.put('corpus', corpus(120));

    // the tool argument names and the operation signatures are two
    // different vocabularies (`slot` and `in` here, `name` and `scope`
    // there); a tool that passed the wrong one would answer "no slot"
    // forever, so each is driven end to end through the registry
    const digest = await box.execute('env_digest', {});
    assert.strictEqual(digest.total, 1);

    const chunked = await box.execute('env_chunk', { slot: 'corpus', strategy: 'line', size: 900 });
    assert.ok(chunked.count > 1);

    const peeked = await box.execute('env_peek', { slot: chunked.chunks[0].name, chars: 50 });
    assert.strictEqual(peeked.head.length, 50);

    const stat = await box.execute('env_stat', { slot: chunked.family });
    assert.strictEqual(stat.slots, chunked.count);

    const hits = await box.execute('env_grep', { pattern: 'NEEDLE-\\d+', in: chunked.family });
    assert.strictEqual(hits.total, 1);

    const text = await box.execute('env_read',
      { slot: hits.matches[0].slot, chars: 200, offset: hits.matches[0].offset });
    assert.match(text.text, /NEEDLE-7788/, 'the address one tool returns is usable by the next');

    // and the registry guards them like any other tool
    const rejected = await box.execute('env_read', { slot: 'corpus' });
    assert.match(rejected.error, /invalid input/);
    assert.ok(rejected.errors.some((e) => e.message.includes('chars')));
  });
});

describe('ai — the environment shares one store with the ledger', function () {
  it('is the ledger\'s slot kind with operations over it, not a second store', async function () {
    const storage = createMemoryStorage();
    const ledger = createLedger({ storage, now: () => AT });
    const environment = createEnvironment({ ledger });

    await environment.put('corpus', corpus(20));
    // the agent's own recall reads what the environment wrote, because
    // there is one slot store and one addressing scheme
    assert.match(String(await ledger.readSlot('corpus')), /row 0000/);
    assert.strictEqual((await ledger.listSlots()).length, 1);

    // and a ledger memory is not a corpus slot: the kinds stay separate
    await ledger.addMemory({ text: 'a fact', evidence: 'a source' });
    assert.strictEqual((await environment.digest()).total, 1);
  });

  it('ingests a corpus piece by piece, holding none of it', async function () {
    const environment = env();
    let yielded = 0;
    function* pieces() {
      for (let i = 0; i < 25; i++) {
        yielded += 1;
        yield `piece ${i} ${'x'.repeat(500)}`;
      }
    }
    const written = await environment.ingest('stream', pieces(), { strategy: 'given' });
    assert.strictEqual(yielded, 25, 'the source was consumed');
    assert.strictEqual(written.count, 25);
    assert.strictEqual((await environment.stat(written.family)).slots, 25);
    // the whole was never one string: the family's size is the sum of
    // pieces that were each written and dropped
    assert.strictEqual(written.size, 25 * (`piece 0 ${'x'.repeat(500)}`).length + 15);
  });

  it('forgets a family in one call', async function () {
    const environment = env();
    await environment.put('corpus', corpus(50));
    const chunked = await environment.chunk('corpus', { size: 400 });
    const removed = await environment.forget(chunked.family);
    assert.strictEqual(removed.removed, chunked.count);
    assert.strictEqual((await environment.digest()).total, 1, 'the source slot stays');
  });
});
