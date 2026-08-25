//@ts-check
/**
 * @file The durable ledger over `@jarenjs/db`: the four-method storage
 * contract implemented against one collection, the ledger's whole suite
 * of shapes run over it, and the OPTIONAL fifth method — `rank` — that
 * lets the store answer `recall({ near })` from a packed vector column
 * instead of handing every record back to be swept.
 *
 * Three things are being proven at once, and only the first is about a
 * database. That the contracts COMPOSE: the adapter imports `@jarenjs/db`
 * and nothing from `@jarenjs/ai`, because the storage contract is the
 * product and this is a host's hundred lines. That an optional capability
 * is a capability and not a fork: the same ledger, the same corpus and the
 * same questions answer identically with `rank` and with it removed —
 * `via` is the only difference, and the ledger says which one ran rather
 * than leaving a caller to guess. And that `keys()` really must be sorted:
 * the contract sentence is asserted directly and its teeth are shown
 * against an adapter that shuffles.
 *
 * The adapter itself is `benchmark/lib/ledger-db.js`, because the
 * retrieval instrument scores the same one; the listing between its
 * documentation markers is the recipe in `packages/ai`'s README,
 * verbatim, and the last tests here are what keep the three one thing.
 */

import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createLedger, createHashEmbedder } from '@jarenjs/ai';

import { createDbStorage } from '../../benchmark/lib/ledger-db.js';

const MEMORY = 'ai/state/memory/';
const SKILL = 'ai/state/skill/';

/** A deterministic clock: every record's `at` is decided by the test. */
function clock(start = 0) {
  let tick = start;
  return () => new Date(Date.UTC(2026, 7, 25, 0, 0, tick++)).toISOString();
}

const hash16 = () => createHashEmbedder({ dims: 16 });
const memory = (id, text, extra = {}) =>
  ({ id, text, evidence: 'a source', tags: [], at: '2026-08-25T00:00:00.000Z', ...extra });

/**
 * The same adapter with only the contract's four methods — the ledger
 * then sweeps, which is what makes the optional fifth provable: two
 * paths over ONE store, not two stores.
 */
const fourMethods = (adapter) => ({
  get: adapter.get, set: adapter.set, delete: adapter.delete, keys: adapter.keys,
});

/** The corpus both paths answer over: five embeddable memories and one without. */
const CORPUS = [
  memory('exact', 'alpha beta gamma delta', { tags: ['greek'] }),
  memory('close', 'alpha beta gamma', { tags: ['greek'] }),
  memory('far', 'zeta eta theta', { tags: ['greek'] }),
  memory('other', 'kappa lambda mu', { tags: ['later'] }),
  memory('last', 'nu xi omicron', { tags: ['later'] }),
];
const UNEMBEDDABLE = memory('bare', 'pi rho sigma', { tags: ['greek'] });

const dir = mkdtempSync(join(tmpdir(), 'jaren-ledger-db-'));
after(() => rmSync(dir, { recursive: true, force: true }));

/** The adapters a test opened, closed for it whatever it asserted. */
const opened = [];
async function storage(options = {}) {
  const adapter = await createDbStorage({ dims: 16, ...options });
  opened.push(adapter);
  return adapter;
}
after(async () => {
  for (const adapter of opened) await adapter.close();
});

describe('the db-backed ledger adapter — the four methods', function () {
  it('round-trips every value shape the ledger stores, and an absent key is undefined', async function () {
    const adapter = await storage();
    await adapter.set('ai/state/goal/active', { objective: 'ship it', progress: [] });
    await adapter.set('ai/state/slot-content/notes', 'just a string');
    await adapter.set('ai/snap/snap-000000', [['a', 1], ['b', { deep: true }]]);
    assert.deepStrictEqual(await adapter.get('ai/state/goal/active'), { objective: 'ship it', progress: [] });
    assert.strictEqual(await adapter.get('ai/state/slot-content/notes'), 'just a string');
    assert.deepStrictEqual(await adapter.get('ai/snap/snap-000000'), [['a', 1], ['b', { deep: true }]]);
    assert.strictEqual(await adapter.get('ai/state/nothing'), undefined);
    // an absent key is not an error, and a delete is idempotent
    await adapter.delete('ai/state/nothing');
    await adapter.delete('ai/state/slot-content/notes');
    assert.strictEqual(await adapter.get('ai/state/slot-content/notes'), undefined);
  });

  it('keys() answers sorted, under the prefix — and an adapter that does not is caught by that assertion', async function () {
    const adapter = await storage();
    const written = ['m3', 'm1', 'm10', 'm2'].map((id) => `${MEMORY}${id}`);
    for (const key of written) await adapter.set(key, { id: key });
    await adapter.set(`${SKILL}s1`, { id: 's1' });

    const keys = await adapter.keys(MEMORY);
    assert.deepStrictEqual(keys, [...written].sort(), 'lexicographic, which is what the ledger reads in');
    assert.deepStrictEqual(await adapter.keys(SKILL), [`${SKILL}s1`]);
    assert.strictEqual((await adapter.keys()).length, 5, 'no prefix is every key');

    // the kill-check: the same assertion over a shuffling adapter fails,
    // so a suite that passed it proved something
    const shuffling = { ...adapter, keys: async (prefix) => (await adapter.keys(prefix)).reverse() };
    assert.notDeepStrictEqual(await shuffling.keys(MEMORY), [...written].sort());
  });

  it('the ledger reads the goal archive in key order, and loses it over an unsorted adapter', async function () {
    const objectives = ['first', 'second', 'third', 'fourth'];
    const adapter = await storage();
    const ledger = createLedger({ storage: adapter, now: clock() });
    for (const objective of objectives) await ledger.setGoal({ objective });
    assert.deepStrictEqual((await ledger.listArchivedGoals()).map((g) => g.objective),
      objectives.slice(0, -1), 'oldest first, which is the key order');

    const shuffling = { ...adapter, keys: async (prefix) => (await adapter.keys(prefix)).reverse() };
    const confused = createLedger({ storage: shuffling, now: clock() });
    assert.deepStrictEqual((await confused.listArchivedGoals()).map((g) => g.objective),
      objectives.slice(0, -1).reverse(),
      'the archive comes back backwards: the sorted-keys sentence is load-bearing');
  });
});

describe('the db-backed ledger adapter — the ledger\'s own shapes, durable', function () {
  it('goal, progress, memories, skills, slots and listings all behave as they do in memory', async function () {
    const adapter = await storage();
    const ledger = createLedger({ storage: adapter, now: clock() });

    const goal = await ledger.setGoal({ objective: 'ship the column' });
    assert.strictEqual(goal.status, 'active');
    const progressed = await ledger.recordProgress({ note: 'the plan is recognized', evidence: 'a test' });
    assert.strictEqual(progressed.progress.length, 1);

    for (const record of CORPUS) await ledger.addMemory(record);
    assert.deepStrictEqual((await ledger.recall({ tags: ['greek'] })).map((m) => m.id),
      ['close', 'exact', 'far'], 'tag match, then recency — one `at`, so the tie-break by id decides');
    assert.strictEqual((await ledger.getMemory('exact')).text, 'alpha beta gamma delta');

    const skill = await ledger.addSkill({ id: 'deploy', name: 'deploy', when: 'on green',
      instructions: 'run the gate' });
    assert.strictEqual(skill.id, 'deploy');
    assert.deepStrictEqual((await ledger.recallSkills()).map((s) => s.id), ['deploy']);

    await ledger.putSlot('notes', 'the slot content, in full');
    assert.strictEqual(await ledger.readSlot('notes'), 'the slot content, in full',
      'the content is a durable value of its own, beside the metadata');
    assert.strictEqual((await ledger.getSlot('notes')).name, 'notes');
    assert.deepStrictEqual((await ledger.listSlots()).map((slot) => slot.name), ['notes']);
  });

  it('five concurrent adds mint five ids and store five records', async function () {
    const adapter = await storage();
    const ledger = createLedger({ storage: adapter, now: clock() });
    const written = await Promise.all(Array.from({ length: 5 }, (_, i) =>
      ledger.addMemory({ text: `fact ${i}`, evidence: 'a source' })));
    const ids = written.map((/** @type {any} */ record) => record.id);
    assert.strictEqual(new Set(ids).size, 5, 'five distinct ids');
    assert.strictEqual((await ledger.recall({})).length, 5, 'and five records durably stored');
  });

  it('snapshot and rollback restore the state the snapshot was taken over', async function () {
    const adapter = await storage();
    const ledger = createLedger({ storage: adapter, now: clock() });
    await ledger.addMemory(memory('before', 'the state to return to'));
    const token = await ledger.snapshot();
    await ledger.addMemory(memory('after', 'a change to undo'));
    assert.strictEqual((await ledger.recall({})).length, 2);
    await ledger.rollback(token);
    assert.deepStrictEqual((await ledger.recall({})).map((m) => m.id), ['before']);
  });

  it('a second store on the same file reads what the first wrote — the process boundary', async function () {
    const path = join(dir, 'ledger.db');
    const first = await storage({ path });
    const wrote = createLedger({ storage: first, now: clock() });
    await wrote.addMemory(memory('durable', 'this survives the process'));
    await first.close();
    opened.pop();

    const second = await storage({ path });
    const reopened = createLedger({ storage: second, now: clock() });
    assert.strictEqual((await reopened.getMemory('durable')).text, 'this survives the process');
  });

  it('embedMissing sweeps once and the second run embeds zero', async function () {
    const adapter = await storage();
    const ledger = createLedger({ storage: adapter, embedder: hash16(), now: clock() });
    for (const record of CORPUS) await ledger.addMemory(record);
    assert.deepStrictEqual(await ledger.embedMissing(), { embedded: 5, remaining: 0 });
    assert.deepStrictEqual(await ledger.embedMissing(), { embedded: 0, remaining: 0 },
      'the two-run check, over the durable adapter');
    const stored = await ledger.getMemory('exact');
    assert.deepStrictEqual(stored.embeddedBy, { model: 'hash-trigram-16', dims: 16 });
    assert.strictEqual(stored.embedding.length, 16);
  });
});

describe('the db-backed ledger adapter — rank, and the same answer without it', function () {
  /** A ledger over the adapter, swept, plus the same one with `rank` hidden. */
  async function seeded(extra = []) {
    const adapter = await storage();
    const ledger = createLedger({ storage: adapter, embedder: hash16(), now: clock() });
    for (const record of [...CORPUS, ...extra]) await ledger.addMemory(record);
    await ledger.embedMissing();
    return { adapter, ledger,
      swept: createLedger({ storage: fourMethods(adapter), embedder: hash16(), now: clock() }) };
  }

  it('the column answers what the sweep answers, to the record and the score', async function () {
    const { ledger, swept } = await seeded();
    for (const limit of [1, 3, 5, 10]) {
      const viaColumn = await ledger.recall({ near: 'alpha beta gamma delta', limit });
      const viaSweep = await swept.recall({ near: 'alpha beta gamma delta', limit });
      assert.strictEqual(viaColumn.via, 'adapter');
      assert.strictEqual(viaSweep.via, 'sweep');
      assert.deepStrictEqual(viaColumn.memories, viaSweep.memories, `limit ${limit}: the same records`);
      assert.deepStrictEqual(viaColumn.scores, viaSweep.scores, `limit ${limit}: the same scores`);
      assert.strictEqual(viaColumn.skipped, viaSweep.skipped);
    }
    // and the ordering is the ranked one, not the stored one
    const top = await ledger.recall({ near: 'alpha beta gamma delta', limit: 2 });
    assert.deepStrictEqual(top.memories.map((/** @type {any} */ m) => m.id), ['exact', 'close']);
  });

  it('a record with no vector is reported, not scored, on both paths', async function () {
    const { ledger, swept } = await seeded([UNEMBEDDABLE]);
    // the sweep embedded everything; a record added after it has none
    await ledger.addMemory(memory('late', 'tau upsilon phi'));
    const viaColumn = await ledger.recall({ near: 'alpha beta gamma', limit: 10 });
    const viaSweep = await swept.recall({ near: 'alpha beta gamma', limit: 10 });
    assert.strictEqual(viaColumn.skipped, 1, 'the un-embedded record is counted');
    assert.strictEqual(viaSweep.skipped, 1);
    assert.deepStrictEqual(viaColumn.memories.map((/** @type {any} */ m) => m.id),
      viaSweep.memories.map((/** @type {any} */ m) => m.id));
    assert.ok(!viaColumn.memories.some((/** @type {any} */ m) => m.id === 'late'),
      'and never appears with a fabricated score');
  });

  it('minScore filters and limit caps identically on both paths', async function () {
    const { ledger, swept } = await seeded();
    const kept = await ledger.recall({ near: 'alpha beta gamma delta', minScore: 0.5 });
    const sweptKept = await swept.recall({ near: 'alpha beta gamma delta', minScore: 0.5 });
    assert.deepStrictEqual(kept.memories, sweptKept.memories);
    assert.ok(kept.scores.every((/** @type {number} */ s) => s >= 0.5));
    const none = await ledger.recall({ near: 'alpha beta gamma delta', minScore: 1.5 });
    assert.deepStrictEqual(none, { memories: [], scores: [], skipped: 0, via: 'adapter' });
  });

  it('a mixture of identities refuses in the ledger\'s own words, whichever path found it', async function () {
    const adapter = await storage();
    const ledger = createLedger({ storage: adapter, embedder: hash16(), now: clock() });
    for (const record of CORPUS) await ledger.addMemory(record);
    await ledger.embedMissing();
    // one record embedded by another identity, written straight through
    // the adapter so the ledger's own coherence check is not the thing
    // under test
    await adapter.set(`${MEMORY}foreign`, {
      id: 'foreign', text: 'a foreign vector', evidence: 'a source', tags: [],
      at: '2026-08-25T00:00:00.000Z',
      embedding: Array.from({ length: 32 }, () => 0.1),
      embeddedBy: { model: 'hash-trigram-32', dims: 32 },
    });
    const sweptLedger = createLedger({ storage: fourMethods(adapter), embedder: hash16(), now: clock() });

    const viaColumn = await ledger.recall({ near: 'alpha beta', limit: 3 });
    const viaSweep = await sweptLedger.recall({ near: 'alpha beta', limit: 3 });
    assert.match(viaColumn.error, /cannot rank across embedders/);
    assert.match(viaColumn.error, /hash-trigram-32/);
    assert.match(viaColumn.error, /hash-trigram-16/, 'the query embedder is named too');
    assert.strictEqual(viaColumn.error, viaSweep.error, 'the same refusal, word for word');
  });

  it('a tag or a where narrows candidates the adapter knows nothing about, so it sweeps', async function () {
    const { ledger } = await seeded();
    const tagged = await ledger.recall({ near: 'alpha beta gamma delta', tags: ['greek'], limit: 5 });
    assert.strictEqual(tagged.via, 'sweep', 'the filter is the ledger\'s, so the read is too');
    assert.deepStrictEqual(tagged.memories.map((/** @type {any} */ m) => m.id), ['exact', 'close', 'far']);
  });

  it('an adapter whose rank answers the wrong shape is refused, not trusted', async function () {
    const { adapter, ledger } = await seeded();
    const lying = { ...adapter, rank: async () => ({ hits: [] }) };
    const over = createLedger({ storage: lying, embedder: hash16(), now: clock() });
    const refused = await over.recall({ near: 'alpha beta', limit: 2 });
    assert.match(refused.error, /rank answered something other than/);
    // the honest one still works
    assert.strictEqual((await ledger.recall({ near: 'alpha beta', limit: 2 })).via, 'adapter');
  });

  it('rank runs the k-nearest plan, and a sweep runs none', async function () {
    const { adapter, ledger, swept } = await seeded();
    const slots = adapter.store.collection('slots');
    assert.deepStrictEqual(slots.stats().knn, { queries: 0, rows: 0, candidates: 0, fullFetches: 0 },
      'nothing has ranked yet');
    await ledger.recall({ near: 'alpha beta gamma delta', limit: 2 });
    const ranked = slots.stats().knn;
    assert.strictEqual(ranked.queries, 1, 'one cut, not a whole-collection read');
    assert.strictEqual(ranked.rows, 5, 'every embedded record was scored from the column');
    assert.ok(ranked.candidates >= 2 && ranked.candidates <= 5, 'and cut to the window');

    await swept.recall({ near: 'alpha beta gamma delta', limit: 2 });
    assert.strictEqual(slots.stats().knn.queries, 1, 'the swept ledger ran no plan at all');
  });
});

describe('the recipe and the documentation are one thing', function () {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  let listing;

  before(function () {
    const source = readFileSync(join(root, 'benchmark/lib/ledger-db.js'), 'utf8');
    const start = source.indexOf('// —— the recipe');
    const end = source.indexOf('// —— end of the recipe ——');
    assert.ok(start > 0 && end > start, 'the markers are what the README quotes');
    listing = source.slice(source.indexOf('\n', start) + 1, end).trimEnd();
  });

  it('the ai README carries the adapter verbatim', function () {
    const readme = readFileSync(join(root, 'packages/ai/README.md'), 'utf8');
    assert.ok(readme.includes(listing),
      'packages/ai/README.md must carry the listing between the markers, unedited');
  });

  it('the adapter imports @jarenjs/db and nothing from @jarenjs/ai', function () {
    assert.match(listing, /^import .* from '@jarenjs\/db';$/m);
    assert.doesNotMatch(listing, /^import .* from '@jarenjs\/ai/m,
      'the storage contract is the whole interface: an adapter that imported the ledger would be a fork of it');
  });
});
