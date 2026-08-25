//@ts-check
/**
 * @file The ledger: durable, schema-validated state over an injected
 * storage adapter.
 *
 * Two properties are load-bearing and get the most attention here. The
 * package must work with **nothing wired** — no store, no query compiler
 * — because it has to load in a static page; "degrades gracefully" is a
 * contract, not an aspiration, so the empty seam is tested as hard as the
 * wired one. And every write must be **reversible**, because the point of
 * a snapshot is to make an automatic write safe to accept.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { readFileSync } from 'node:fs';

import { createLedger, createMemoryStorage } from '@jarenjs/ai';
import { createLedger as createLedgerDirect } from '@jarenjs/ai/ledger';
import { MEMORY_SCHEMA } from '@jarenjs/ai/schemas/ledger';
import { compileJsonQuery } from '@jarenjs/json/query';

/** A deterministic clock: every record's `at` is decided by the test. */
function clock(start = 0) {
  let tick = start;
  return () => new Date(Date.UTC(2026, 7, 12, 0, 0, tick++)).toISOString();
}

/** A ledger with the query seam wired, and one without. */
const wired = (extra = {}) => createLedger({ compileQuery: compileJsonQuery, now: clock(), ...extra });
const bare = (extra = {}) => createLedger({ now: clock(), ...extra });

/** Three memories with overlapping tags, written oldest-first. */
async function seedMemories(ledger) {
  await ledger.addMemory({ id: 'm1', text: 'the deploy needs a WAL checkpoint',
    evidence: 'observed in run 41', tags: ['deploy', 'sqlite'] });
  await ledger.addMemory({ id: 'm2', text: 'the CSV reader hangs on short records',
    evidence: 'benchmark/csv.js timed out', tags: ['csv'] });
  await ledger.addMemory({ id: 'm3', text: 'WAL mode is on by default',
    evidence: 'packages/db/src/store.js', tags: ['sqlite'] });
  return ledger;
}

describe('ai ledger — it works with nothing wired', function () {
  it('createLedger() with no arguments at all stores and reads back', async function () {
    // the static-page case: no store, no query compiler, no clock
    const ledger = createLedger();
    const stored = await ledger.addMemory({
      text: 'a fact', evidence: 'a source', tags: ['t'],
    });
    assert.strictEqual(stored.text, 'a fact');
    assert.match(stored.id, /^memory-/, 'an unnamed record is given an id');
    assert.match(stored.at, /^\d{4}-\d{2}-\d{2}T/, 'and a timestamp');
    assert.deepStrictEqual(await ledger.recall({ tags: ['t'] }), [stored]);
  });

  it('the ./ledger subpath is the same implementation as the index export', function () {
    assert.strictEqual(createLedgerDirect, createLedger);
  });

  it('a host-supplied storage adapter is the only thing that persists', async function () {
    // what durability looks like from here: the ledger holds no state of
    // its own, so a second ledger over the same adapter sees everything
    const backing = new Map();
    const first = createLedger({ storage: createMemoryStorage(backing), now: clock() });
    await first.addMemory({ id: 'kept', text: 'survives', evidence: 'the adapter', tags: [] });
    const second = createLedger({ storage: createMemoryStorage(backing) });
    assert.strictEqual((await second.getMemory('kept')).text, 'survives');
    // and a ledger over a FRESH adapter starts empty — nothing is hidden
    // in module state
    assert.strictEqual(await createLedger().getMemory('kept'), null);
  });

  it('the in-memory adapter copies values in and out', async function () {
    const storage = createMemoryStorage();
    const value = { list: [1, 2] };
    await storage.set('k', value);
    value.list.push(3);
    assert.deepStrictEqual((await storage.get('k')).list, [1, 2],
      'a caller mutating what it stored must not reach inside the ledger');
    const read = await storage.get('k');
    read.list.push(9);
    assert.deepStrictEqual((await storage.get('k')).list, [1, 2],
      'nor by mutating what it read');
  });

  it('the in-memory adapter has JSON-value semantics, and keys() answers sorted', async function () {
    // what survives a set/get is what JSON.stringify preserves — real
    // storage serializes, so the default must not promise more than it
    // does: a typed array comes back as a plain object, a non-finite
    // number as null. An embedding is stored as a plain number[] or not
    // at all.
    const storage = createMemoryStorage();
    await storage.set('v', { vector: new Float32Array([0.5, 1]), gap: NaN });
    assert.deepStrictEqual(await storage.get('v'), { vector: { 0: 0.5, 1: 1 }, gap: null });
    // the ledger reads listings, archives and snapshots in key order;
    // an adapter that answered keys() unsorted would reorder all three
    await storage.set('a/2', 1);
    await storage.set('a/1', 2);
    await storage.set('b/0', 3);
    assert.deepStrictEqual(await storage.keys('a/'), ['a/1', 'a/2']);
  });
});

describe('ai ledger — writes are validated at the boundary', function () {
  it('rejects a memory with no evidence, in the shape the toolbox uses', async function () {
    const ledger = bare();
    const rejected = await ledger.addMemory({ text: 'a guess', tags: [] });
    assert.match(rejected.error, /invalid input for memory/);
    assert.ok(Array.isArray(rejected.errors) && rejected.errors.length > 0);
    assert.strictEqual(rejected.inputSchema, MEMORY_SCHEMA,
      'the rejection carries the schema to re-read');
    for (const error of rejected.errors) {
      assert.strictEqual(typeof error.instancePath, 'string');
      assert.strictEqual(typeof error.keyword, 'string');
      assert.strictEqual(typeof error.message, 'string');
    }
    assert.deepStrictEqual(await ledger.listMemories(), [], 'and nothing was written');
  });

  it('rejects every kind the same way, and never throws', async function () {
    const ledger = bare();
    const cases = [
      ['goal', () => ledger.setGoal({ objective: '' })],
      ['memory', () => ledger.addMemory({ text: 'x', evidence: 'y', tags: [1] })],
      ['skill', () => ledger.addSkill({ name: 'n', when: 'w' })],
      ['slot', () => ledger.putSlot('', 'content')],
    ];
    for (const [kind, run] of cases) {
      const rejected = await run();
      assert.match(rejected.error, new RegExp(`invalid input for ${kind}`), `${kind} rejects`);
      assert.ok(Array.isArray(rejected.errors), `${kind} reports why`);
      assert.ok(rejected.inputSchema !== undefined, `${kind} carries its schema`);
    }
  });

  it('rejects a timestamp that would sort wrong', async function () {
    // `format` alone is annotation-only, so it would enforce nothing
    // here; recency ordering compares these strings, and a junk `at`
    // does not fail loudly, it silently reorders retrieval
    const ledger = bare();
    const rejected = await ledger.addMemory({
      id: 'x', text: 't', evidence: 'e', tags: [], at: 'not-a-date',
    });
    assert.match(rejected.error, /invalid input for memory/);
    assert.ok(rejected.errors.some((e) => e.keyword === 'pattern'),
      'the pattern is what does the work without @jarenjs/formats');
    const ok = await ledger.addMemory({
      id: 'y', text: 't', evidence: 'e', tags: [], at: '2026-08-12T00:00:00+02:00',
    });
    assert.strictEqual(ok.id, 'y', 'a real offset is still a real timestamp');
  });

  it('refuses an unknown member with the answer validate() gives, never by dropping it', async function () {
    // the write and the gate must be one question: a member the schema
    // does not know is rejected by both, or a caller that checked first
    // stores something other than what it checked
    const ledger = bare();
    const input = {
      id: 'm-embed', text: 'a fact', evidence: 'a source', tags: [],
      at: '2026-08-12T00:00:00.000Z', embedding: [0.1, 0.2],
    };
    const rejected = await ledger.addMemory(input);
    assert.match(rejected.error, /invalid input for memory/);
    assert.ok(rejected.errors.some((e) => e.keyword === 'additionalProperties' && e.instancePath === '/embedding'),
      `the rejection names the member: ${JSON.stringify(rejected.errors)}`);
    assert.deepStrictEqual(rejected, ledger.validate('memory', input),
      'the write answers exactly what the gate answers');
    assert.strictEqual(await ledger.getMemory('m-embed'), null, 'and nothing was stored');

    const skill = await ledger.addSkill({
      id: 's-embed', name: 'n', when: 'w', instructions: 'i', embedding: [0.1],
    });
    assert.match(skill.error, /invalid input for skill/);
    assert.ok(skill.errors.some((e) => e.keyword === 'additionalProperties'));
    assert.strictEqual(await ledger.getSkill('s-embed'), null);
  });

  it('there is exactly one rejection-shape implementation', function () {
    // the shape is the contract a model recovers from; two copies would
    // drift and only one of them would be the one being read
    const sources = ['toolbox.js', 'ledger.js', 'check.js'].map((file) => [file,
      readFileSync(new URL(`../../packages/ai/src/${file}`, import.meta.url), 'utf8')]);
    for (const [file, source] of sources) {
      const builds = /error:\s*`invalid input for/.test(source);
      assert.strictEqual(builds, file === 'check.js',
        `${file} ${builds ? 'builds its own' : 'does not build a'} rejection — only check.js may`);
    }
  });
});

describe('ai ledger — the goal is singular', function () {
  it('a second setGoal supersedes and archives the first', async function () {
    const ledger = bare();
    await ledger.setGoal({ objective: 'ship the benchmark' });
    await ledger.setGoal({ objective: 'ship the ledger' });

    const active = await ledger.getGoal();
    assert.strictEqual(active.objective, 'ship the ledger');
    assert.strictEqual(active.status, 'active');
    const archived = await ledger.listArchivedGoals();
    assert.strictEqual(archived.length, 1);
    assert.strictEqual(archived[0].objective, 'ship the benchmark');
    assert.strictEqual(archived[0].status, 'superseded',
      'the previous objective is kept, marked, and not overwritten');
  });

  it('records evidenced progress, and refuses it with no goal', async function () {
    const ledger = bare();
    assert.match((await ledger.recordProgress({ note: 'n', evidence: 'e' })).error,
      /no active goal/);
    await ledger.setGoal({ objective: 'measure the thing' });
    const updated = await ledger.recordProgress({ note: 'first table', evidence: 'run 3' });
    assert.strictEqual(updated.progress.length, 1);
    assert.strictEqual(updated.progress[0].note, 'first table');
    // unevidenced progress is a claim, not a record
    assert.match((await ledger.recordProgress({ note: 'trust me' })).error,
      /invalid input for goal/);
    assert.strictEqual((await ledger.getGoal()).progress.length, 1);
  });

  it('sets a terminal status without superseding', async function () {
    const ledger = bare();
    await ledger.setGoal({ objective: 'finish' });
    assert.strictEqual((await ledger.setGoalStatus('done')).status, 'done');
    assert.strictEqual((await ledger.getGoal()).status, 'done');
    assert.deepStrictEqual(await ledger.listArchivedGoals(), []);
    assert.match((await ledger.setGoalStatus('nonsense')).error, /invalid input for goal/);
  });
});

describe('ai ledger — writes serialize and a minted id never collides', function () {
  /** A clock that never moves: every minted id shares one timestamp, so
   * only the sequence can keep two ids apart. */
  const frozen = () => '2026-08-12T00:00:00.000Z';
  const kinds = [
    ['memory',
      (ledger, n) => ledger.addMemory({ text: `fact ${n}`, evidence: `source ${n}` }),
      (ledger) => ledger.listMemories(),
      (ledger, id) => ledger.deleteMemory(id),
      (ledger, id) => ledger.getMemory(id)],
    ['skill',
      (ledger, n) => ledger.addSkill({ name: `skill ${n}`, when: 'w', instructions: 'i' }),
      (ledger) => ledger.listSkills(),
      (ledger, id) => ledger.deleteSkill(id),
      (ledger, id) => ledger.getSkill(id)],
  ];

  it('five concurrent adds store five records under five distinct ids', async function () {
    // the batch shape every bulk loader has: Promise.all over adds
    for (const [kind, add, list] of kinds) {
      const ledger = createLedger({ now: frozen });
      const stored = await Promise.all([1, 2, 3, 4, 5].map((n) => add(ledger, n)));
      const ids = stored.map((record) => record.id);
      assert.strictEqual(new Set(ids).size, 5, `${kind}: five distinct ids, got ${JSON.stringify(ids)}`);
      assert.strictEqual((await list(ledger)).length, 5, `${kind}: all five are stored`);
    }
  });

  it('delete-then-add never hands a new record a live id', async function () {
    // a sequence derived from a COUNT shrinks on delete and re-mints the
    // address of a survivor; one derived from the highest that exists
    // cannot
    for (const [kind, add, list, remove, get] of kinds) {
      const ledger = createLedger({ now: frozen });
      const first = await add(ledger, 1);
      await add(ledger, 2);
      const third = await add(ledger, 3);
      assert.strictEqual(await remove(ledger, first.id), true);
      const fourth = await add(ledger, 4);
      assert.notStrictEqual(fourth.id, third.id, `${kind}: the survivor keeps its address`);
      assert.deepStrictEqual(await get(ledger, third.id), third, `${kind}: and its content`);
      assert.strictEqual((await list(ledger)).length, 3);
    }
  });

  it('concurrent setGoal calls archive every superseded objective', async function () {
    const ledger = createLedger({ now: frozen });
    await Promise.all(['first', 'second', 'third'].map((objective) => ledger.setGoal({ objective })));
    assert.strictEqual((await ledger.getGoal()).objective, 'third');
    assert.deepStrictEqual((await ledger.listArchivedGoals()).map((goal) => goal.objective),
      ['first', 'second'], 'archived oldest first, none lost to a colliding key');
  });
});

describe('ai ledger — retrieval, wired and unwired', function () {
  it('returns the same results with the seam wired and unwired', async function () {
    // the acceptance that keeps the two paths from drifting: tag
    // retrieval means one thing, whichever engine evaluates it
    for (const tags of [['sqlite'], ['csv'], ['sqlite', 'csv'], ['absent']]) {
      const withSeam = await (await seedMemories(wired())).recall({ tags });
      const without = await (await seedMemories(bare())).recall({ tags });
      assert.deepStrictEqual(without.map((m) => m.id), withSeam.map((m) => m.id),
        `tags ${JSON.stringify(tags)} must retrieve the same records either way`);
    }
  });

  it('orders by recency and honours a limit, on both paths', async function () {
    for (const make of [wired, bare]) {
      const ledger = await seedMemories(make());
      assert.deepStrictEqual((await ledger.recall()).map((m) => m.id), ['m3', 'm2', 'm1'],
        'newest first');
      assert.deepStrictEqual((await ledger.recall({ limit: 2 })).map((m) => m.id), ['m3', 'm2']);
      assert.deepStrictEqual((await ledger.recall({ tags: ['sqlite'] })).map((m) => m.id),
        ['m3', 'm1']);
    }
  });

  it('the wired seam evaluates a predicate the fallback cannot', async function () {
    const ledger = await seedMemories(wired());
    // a substring predicate over the memory text: nothing in the
    // tag-and-recency fallback can express this
    const hits = await ledger.recall({
      where: { $contains: ['$it.text', 'WAL'] },
    });
    assert.deepStrictEqual(hits.map((m) => m.id), ['m3', 'm1']);
    // and it composes with a tag filter rather than replacing it
    const narrowed = await ledger.recall({
      tags: ['sqlite'], where: { $contains: ['$it.text', 'checkpoint'] },
    });
    assert.deepStrictEqual(narrowed.map((m) => m.id), ['m1']);
  });

  it('refuses a predicate with the seam empty rather than ignoring it', async function () {
    // returning every memory here would answer a different question with
    // a straight face — the failure mode this refusal exists to prevent
    const ledger = await seedMemories(bare());
    const refused = await ledger.recall({ where: { $contains: ['$it.text', 'WAL'] } });
    assert.match(refused.error, /needs the compileQuery seam/);
    assert.match(refused.error, /@jarenjs\/json\/query/, 'and says what to inject');
  });

  it('answers a predicate that does not compile as content, not a crash', async function () {
    const ledger = await seedMemories(wired());
    const broken = await ledger.recall({ where: { $nope: ['$it.text'] } });
    assert.match(broken.error, /^recall: /);
  });

  it('retrieves skills the same way', async function () {
    const ledger = wired();
    await ledger.addSkill({ id: 's1', name: 'checkpoint', when: 'before a deploy',
      instructions: 'run a WAL checkpoint', tools: ['db'] });
    await ledger.addSkill({ id: 's2', name: 'measure', when: 'before a claim',
      instructions: 'run the benchmark', tools: [] });
    assert.deepStrictEqual((await ledger.recallSkills()).map((s) => s.id), ['s2', 's1']);
    assert.deepStrictEqual(
      (await ledger.recallSkills({ where: { $contains: ['$it.when', 'deploy'] } }))
        .map((s) => s.id), ['s1']);
  });
});

describe('ai ledger — slots address content without carrying it', function () {
  it('stores metadata and content separately', async function () {
    const ledger = bare();
    const content = `${'x'.repeat(500)} the tail`;
    const slot = await ledger.putSlot('transcript', content, { kind: 'transcript' });
    assert.strictEqual(slot.size, content.length);
    assert.strictEqual(slot.kind, 'transcript');
    assert.ok(slot.excerpt.length < 130 && slot.excerpt.endsWith('…'),
      'the metadata carries a short excerpt, not the content');
    // the listing a root request could carry: no content anywhere in it
    const listed = await ledger.listSlots();
    assert.deepStrictEqual(listed, [slot]);
    assert.ok(!JSON.stringify(listed).includes('the tail'),
      'a slot listing must never contain slot content');
    // and the content is one explicit call away
    assert.strictEqual(await ledger.readSlot('transcript'), content);
  });

  it('serializes a non-string value, and removes both keys on delete', async function () {
    const ledger = bare();
    await ledger.putSlot('rows', [{ a: 1 }]);
    assert.strictEqual(await ledger.readSlot('rows'), '[{"a":1}]');
    assert.strictEqual(await ledger.deleteSlot('rows'), true);
    assert.strictEqual(await ledger.getSlot('rows'), null);
    assert.strictEqual(await ledger.readSlot('rows'), undefined,
      'the content key goes with the metadata key');
    assert.strictEqual(await ledger.deleteSlot('rows'), false);
  });
});

describe('ai ledger — every mutation is reversible', function () {
  it('snapshot → mutate → rollback restores byte-identical state', async function () {
    const backing = new Map();
    const ledger = createLedger({ storage: createMemoryStorage(backing), now: clock() });
    await seedMemories(ledger);
    await ledger.setGoal({ objective: 'the original objective' });
    await ledger.putSlot('s', 'content');

    const before = JSON.stringify([...backing.entries()].sort());
    const token = await ledger.snapshot();

    await ledger.addMemory({ id: 'm4', text: 'added after', evidence: 'e', tags: [] });
    await ledger.deleteMemory('m1');
    await ledger.setGoal({ objective: 'a different objective' });
    await ledger.putSlot('s', 'overwritten');
    assert.notStrictEqual(JSON.stringify([...backing.entries()].sort()), before);

    assert.strictEqual(await ledger.rollback(token), true);
    const after = new Map([...backing.entries()].filter(([k]) => k.startsWith('ai/state/')));
    assert.strictEqual(JSON.stringify([...after.entries()].sort()), before,
      'the restored state is byte-identical to the snapshotted state');
    // a rollback is a restore, not a merge
    assert.strictEqual(await ledger.getMemory('m4'), null);
    assert.strictEqual((await ledger.getMemory('m1')).id, 'm1');
    assert.strictEqual((await ledger.getGoal()).objective, 'the original objective');
    assert.strictEqual(await ledger.readSlot('s'), 'content');
  });

  it('keeps other snapshots alive across a rollback', async function () {
    const ledger = bare();
    await ledger.addMemory({ id: 'a', text: 'a', evidence: 'e', tags: [] });
    const first = await ledger.snapshot();
    await ledger.addMemory({ id: 'b', text: 'b', evidence: 'e', tags: [] });
    const second = await ledger.snapshot();
    await ledger.rollback(first);
    assert.strictEqual(await ledger.getMemory('b'), null);
    // the later snapshot survived the wipe and still restores forward
    assert.strictEqual(await ledger.rollback(second), true);
    assert.strictEqual((await ledger.getMemory('b')).id, 'b');
  });

  it('two ledgers over one storage mint distinct tokens, each restoring its own state', async function () {
    // the durable case: the adapter outlives the process, and the next
    // ledger over it must continue the token sequence, not restart it
    // over the first one's undo point
    const backing = new Map();
    const a = createLedger({ storage: createMemoryStorage(backing), now: clock() });
    const b = createLedger({ storage: createMemoryStorage(backing), now: clock(10) });
    await a.addMemory({ id: 'base', text: 'shared', evidence: 'e', tags: [] });
    const tokenA = await a.snapshot();
    await b.addMemory({ id: 'b1', text: 'from b', evidence: 'e', tags: [] });
    const tokenB = await b.snapshot();
    assert.notStrictEqual(tokenA, tokenB, 'the second ledger continues the sequence');
    await a.addMemory({ id: 'a2', text: 'from a', evidence: 'e', tags: [] });

    assert.strictEqual(await b.rollback(tokenB), true);
    assert.deepStrictEqual((await a.listMemories()).map((m) => m.id).sort(), ['b1', 'base'],
      "b's snapshot restores b's state");
    assert.strictEqual(await a.rollback(tokenA), true);
    assert.deepStrictEqual((await b.listMemories()).map((m) => m.id), ['base'],
      "a's snapshot was not overwritten by b's");
  });

  it('answers an unknown token rather than throwing', async function () {
    assert.match((await bare().rollback('snap-999999')).error, /unknown snapshot/);
  });
});

describe('ai ledger — records and skills round-trip', function () {
  it('gets, lists and deletes memories and skills', async function () {
    const ledger = await seedMemories(bare());
    assert.strictEqual((await ledger.getMemory('m2')).text,
      'the CSV reader hangs on short records');
    assert.strictEqual(await ledger.getMemory('absent'), null);
    assert.strictEqual(await ledger.deleteMemory('m2'), true);
    assert.strictEqual(await ledger.deleteMemory('m2'), false);
    assert.deepStrictEqual((await ledger.listMemories()).map((m) => m.id), ['m3', 'm1']);

    const skill = await ledger.addSkill({ name: 'n', when: 'w', instructions: 'i' });
    assert.match(skill.id, /^skill-/);
    assert.deepStrictEqual(skill.tools, []);
    assert.strictEqual((await ledger.getSkill(skill.id)).name, 'n');
    assert.strictEqual(await ledger.getSkill('absent'), null);
    assert.strictEqual((await ledger.listSkills()).length, 1);
    assert.strictEqual(await ledger.deleteSkill(skill.id), true);
    assert.strictEqual(await ledger.deleteSkill(skill.id), false);
  });
});
