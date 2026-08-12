//@ts-check
/**
 * @file Refinement: the only way a model's own state improves, and every
 * way it is stopped from improving it wrongly.
 *
 * The four stages are tested one at a time, because each of them is the
 * only thing standing between a plausible sentence and a durable record:
 * the schema decides what is addressable, the patch engine decides what
 * applies, the ledger's schemas decide what is storable, and the
 * snapshot decides that a refinement is all-or-nothing.
 *
 * The two claims worth stating in prose, because they are the reason
 * this exists rather than a `setPrompt` call:
 *
 *   - the base system prompt is not a patch target. Not discouraged —
 *     unaddressable, twice over: it is not in the document a patch
 *     applies to, and no path that could reach it matches the schema.
 *   - a memory without evidence never lands, whoever proposed it.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import {
  createAgent, createLedger, createMemoryStorage, createRefiner, createChatClient,
  REFINEMENT_PATCH_SCHEMA,
} from '@jarenjs/ai';
import { applyJSONPatch } from '@jarenjs/json';

const AT = '2026-08-12T09:00:00Z';

/** The injected RFC 6902 seam — @jarenjs/json's engine, never imported by the package. */
const applyPatch = (document, patch) => applyJSONPatch(document, patch);

/** A ledger with a fixed clock over an inspectable backing map. */
function fixture() {
  /** @type {Map<string, string>} */
  const backing = new Map();
  const ledger = createLedger({ storage: createMemoryStorage(backing), now: () => AT });
  return { backing, ledger };
}

/** Everything the ledger holds, as comparable bytes (snapshots excluded). */
const dump = (backing) => [...backing.entries()]
  .filter(([key]) => key.startsWith('ai/state/'))
  .sort()
  .map(([key, value]) => `${key}=${value}`)
  .join('\n');

/** A client whose replies are scripted JSON documents. */
function scriptedClient(replies) {
  /** @type {any[]} */
  const sent = [];
  let call = 0;
  const client = createChatClient({
    provider: 'openrouter',
    model: 'm',
    apiKey: 'k',
    retry: { attempts: 1 },
    fetch: (url, init) => {
      sent.push(JSON.parse(/** @type {string} */ (init.body)));
      const content = replies[Math.min(call++, replies.length - 1)];
      return Promise.resolve(new Response(
        JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 }));
    },
  });
  return { client, sent };
}

const MEMORY = {
  text: 'The bank export uses CRLF line endings.',
  evidence: 'read_file → "amount,date\\r\\n"',
  tags: ['csv'],
};

describe('ai — refinement, the document', function () {
  it('exposes the supplemental subtree and nothing else — the base prompt is not in it', async function () {
    const { ledger } = fixture();
    await ledger.setGoal({ objective: 'Reconcile July.' });
    await ledger.addMemory(MEMORY);
    const refiner = createRefiner({ ledger, applyPatch });

    const state = await refiner.state();
    assert.deepStrictEqual(Object.keys(state).sort(), ['goal', 'memories', 'skills']);
    assert.strictEqual(state.memories[0].text, MEMORY.text);

    // the base prompt is an agent option and never leaves it: a model
    // cannot patch what it cannot address, and it cannot address what is
    // not in the document
    const base = 'You are a careful bookkeeper. Never invent a figure.';
    createAgent({ client: { complete: async () => ({}) }, system: base, ledger });
    assert.ok(!JSON.stringify(await refiner.state()).includes('careful bookkeeper'));
  });

  it('has no path that reaches outside the subtree (D5)', async function () {
    const { backing, ledger } = fixture();
    await ledger.setGoal({ objective: 'Reconcile July.' });
    const refiner = createRefiner({ ledger, applyPatch });
    const before = dump(backing);

    for (const path of ['/system', '/goal/objective', '/goal', '/memories', '/memories/0/text',
      '', '/', '/skills/0/instructions', '/goal/progress/0']) {
      const outcome = await refiner.commit([{ op: 'replace', path, value: { text: 'x', evidence: 'y' } }]);
      assert.strictEqual(outcome.ok, undefined, `'${path}' must not be a patch target`);
      assert.match(outcome.error, /rejected/);
      assert.ok(outcome.errors.length > 0);
    }
    assert.strictEqual(dump(backing), before, 'a rejected patch writes nothing');
  });

  it('caps the operations one refinement may propose', async function () {
    const { ledger } = fixture();
    const refiner = createRefiner({ ledger, applyPatch, maxOps: 2 });
    assert.strictEqual(refiner.patchSchema.maxItems, 2);
    const outcome = await refiner.commit(
      new Array(3).fill({ op: 'add', path: '/memories/-', value: MEMORY }));
    assert.match(outcome.error, /rejected/);
    assert.strictEqual((await ledger.listMemories()).length, 0);
  });
});

describe('ai — refinement, the gate', function () {
  it('stores an evidenced memory, and a progress entry, through the ledger', async function () {
    const { ledger } = fixture();
    await ledger.setGoal({ objective: 'Reconcile July.' });
    const refiner = createRefiner({ ledger, applyPatch, now: () => AT });

    const outcome = await refiner.commit([
      { op: 'add', path: '/memories/-', value: MEMORY },
      { op: 'add', path: '/goal/progress/-', value: { note: 'Matched 412 lines', evidence: 'batch 3' } },
    ]);

    assert.strictEqual(outcome.ok, true);
    assert.strictEqual(outcome.memories.length, 1);
    const stored = await ledger.listMemories();
    assert.strictEqual(stored.length, 1);
    assert.strictEqual(stored[0].text, MEMORY.text);
    assert.strictEqual(stored[0].evidence, MEMORY.evidence);
    assert.ok(stored[0].id.startsWith('memory-'), 'the ledger minted the id, not the model');
    assert.strictEqual((await ledger.getGoal()).progress[0].note, 'Matched 412 lines');
  });

  it('rejects a memory with no evidence, and writes nothing', async function () {
    const { backing, ledger } = fixture();
    await ledger.addMemory(MEMORY);
    const refiner = createRefiner({ ledger, applyPatch });
    const before = dump(backing);

    const outcome = await refiner.commit([
      { op: 'add', path: '/memories/-', value: { text: 'The totals always match.' } },
    ]);
    assert.strictEqual(outcome.ok, undefined);
    assert.ok(JSON.stringify(outcome.errors).includes('evidence'),
      `the rejection must name the missing member: ${JSON.stringify(outcome.errors)}`);
    assert.strictEqual(dump(backing), before);
  });

  it('rejects a patch that does not apply, with a code and a pointer', async function () {
    const { backing, ledger } = fixture();
    const refiner = createRefiner({ ledger, applyPatch });
    const before = dump(backing);

    const outcome = await refiner.commit([{ op: 'replace', path: '/memories/4', value: MEMORY }]);
    assert.strictEqual(outcome.ok, undefined);
    const [error] = outcome.errors;
    assert.match(error.code, /^JP/, 'the engine\'s own code travels to the model');
    assert.strictEqual(typeof error.docPath, 'string');
    assert.match(error.message, /does not apply/);
    assert.strictEqual(dump(backing), before);
  });

  it('will not let a proposal choose its own id', async function () {
    const { ledger } = fixture();
    await ledger.addMemory(MEMORY);
    const refiner = createRefiner({ ledger, applyPatch });
    const outcome = await refiner.commit([{
      op: 'add',
      path: '/memories/-',
      value: { id: 'memory-forged', text: 'x', evidence: 'y', tags: [], at: AT },
    }]);
    assert.strictEqual(outcome.ok, undefined, 'an id is how a record is overwritten');
  });

  it('refuses progress with no active goal', async function () {
    const { ledger } = fixture();
    const refiner = createRefiner({ ledger, applyPatch });
    const outcome = await refiner.commit([
      { op: 'add', path: '/goal/progress/-', value: { note: 'n', evidence: 'e' } },
    ]);
    assert.strictEqual(outcome.ok, undefined);
  });

  it('accepts the empty patch as the honest answer', async function () {
    const { backing, ledger } = fixture();
    await ledger.addMemory(MEMORY);
    const before = dump(backing);
    const outcome = await createRefiner({ ledger, applyPatch }).commit([]);
    assert.strictEqual(outcome.ok, true);
    assert.strictEqual(outcome.snapshot, null, 'nothing written, nothing to roll back');
    assert.strictEqual(dump(backing), before);
  });

  it('declines cleanly with the patch seam empty (D3)', async function () {
    const { ledger } = fixture();
    const refiner = createRefiner({ ledger });
    const outcome = await refiner.commit([{ op: 'add', path: '/memories/-', value: MEMORY }]);
    assert.match(outcome.error, /applyPatch seam/);
    assert.match(outcome.error, /@jarenjs\/json/);
    assert.strictEqual((await ledger.listMemories()).length, 0);
  });
});

describe('ai — refinement, reversibility', function () {
  it('rollback after a committed refinement restores byte-identical state', async function () {
    const { backing, ledger } = fixture();
    await ledger.setGoal({ objective: 'Reconcile July.' });
    await ledger.addMemory(MEMORY);
    const before = dump(backing);

    const refiner = createRefiner({ ledger, applyPatch, now: () => AT });
    const outcome = await refiner.commit([
      { op: 'add', path: '/memories/-', value: { text: 'Row 88 is a duplicate.', evidence: 'diff line 88' } },
      { op: 'add', path: '/goal/progress/-', value: { note: 'Found the duplicate', evidence: 'diff line 88' } },
    ]);
    assert.strictEqual(outcome.ok, true);
    assert.notStrictEqual(dump(backing), before);

    assert.strictEqual(await ledger.rollback(outcome.snapshot), true);
    assert.strictEqual(dump(backing), before, 'byte for byte, including the goal\'s progress');
  });

  it('replaces a memory as remove-then-store, and removes one outright', async function () {
    const { ledger } = fixture();
    await ledger.addMemory(MEMORY);
    const first = (await ledger.listMemories())[0];
    const refiner = createRefiner({ ledger, applyPatch, now: () => AT });

    const replaced = await refiner.commit([{
      op: 'replace',
      path: '/memories/0',
      value: { text: 'The export uses CRLF only in the header.', evidence: 'hexdump -C export.csv' },
    }]);
    assert.strictEqual(replaced.ok, true);
    assert.deepStrictEqual(replaced.removed.memories, [first.id]);
    const after = await ledger.listMemories();
    assert.strictEqual(after.length, 1);
    assert.notStrictEqual(after[0].id, first.id, 'a revised memory is a new claim with new evidence');

    const removed = await refiner.commit([{ op: 'remove', path: '/memories/0' }]);
    assert.strictEqual(removed.ok, true);
    assert.deepStrictEqual(await ledger.listMemories(), []);
  });
});

describe('ai — refinement, generated', function () {
  it('generates a patch, gates it and commits it', async function () {
    const { ledger } = fixture();
    await ledger.setGoal({ objective: 'Reconcile July.' });
    const { client, sent } = scriptedClient([JSON.stringify([
      { op: 'add', path: '/memories/-', value: MEMORY },
    ])]);
    const refiner = createRefiner({ client, ledger, applyPatch, now: () => AT });

    const outcome = await refiner.refine({
      steps: [{ name: 'read_file', arguments: '{"path":"export.csv"}', result: { head: 'amount,date\r\n' } }],
      messages: [{ role: 'user', content: 'reconcile the export' }],
    });

    assert.strictEqual(outcome.ok, true);
    assert.strictEqual(outcome.attempts, 1);
    assert.strictEqual((await ledger.listMemories())[0].text, MEMORY.text);

    // the proposal prompt carries the state, the run and the schema
    const prompt = sent[0].messages.at(-1).content;
    assert.match(prompt, /Reconcile July\./);
    assert.match(prompt, /read_file/);
    assert.match(prompt, /MUST carry `evidence`/);
    assert.strictEqual(sent[0].response_format.json_schema.schema.maxItems,
      REFINEMENT_PATCH_SCHEMA.maxItems);
    assert.strictEqual(sent[0].response_format.json_schema.strict, false,
      'a remove carries no value, so strict mode cannot be used');
  });

  it('repairs once on a gate failure, then commits', async function () {
    const { ledger } = fixture();
    const { client, sent } = scriptedClient([
      // unevidenced: the gate rejects it before anything is written
      JSON.stringify([{ op: 'add', path: '/memories/-', value: { text: 'A hunch.' } }]),
      JSON.stringify([{ op: 'add', path: '/memories/-', value: MEMORY }]),
    ]);
    const outcome = await createRefiner({ client, ledger, applyPatch, now: () => AT })
      .refine({ steps: [] });

    assert.strictEqual(outcome.ok, true);
    assert.strictEqual(outcome.attempts, 2);
    assert.strictEqual(sent.length, 2);
    assert.match(JSON.stringify(sent[1].messages.at(-1).content), /evidence/,
      'the repair round carries the reason back');
    assert.strictEqual((await ledger.listMemories()).length, 1);
  });

  it('repairs an UNAPPLICABLE patch once, then declines, leaving the state untouched', async function () {
    const { backing, ledger } = fixture();
    await ledger.addMemory(MEMORY);
    const before = dump(backing);
    // there is one memory; index 9 exists in no world. The engine says so
    // with a pointer, the model is told, and it repeats itself.
    const { client, sent } = scriptedClient([
      JSON.stringify([{ op: 'replace', path: '/memories/9', value: MEMORY }]),
    ]);

    const outcome = await createRefiner({ client, ledger, applyPatch }).refine({ steps: [] });

    assert.strictEqual(outcome.ok, undefined);
    assert.match(outcome.error, /did not produce an applicable refinement/);
    assert.strictEqual(outcome.attempts, 2, 'one proposal, one bounded repair, then it declines');
    assert.strictEqual(sent.length, 2);
    assert.match(outcome.errors[0].code, /^JP/);
    assert.match(sent[1].messages.at(-1).content, /JP\d+/,
      'the repair round carries the engine\'s code and pointer, not just "invalid"');
    assert.strictEqual(dump(backing), before, 'nothing was applied, not even partly');
  });

  it('rejects a patch aimed outside the subtree without spending a repair on the model', async function () {
    const { ledger } = fixture();
    const { client, sent } = scriptedClient([
      JSON.stringify([{ op: 'add', path: '/prompt', value: { text: 'be smarter', evidence: 'vibes' } }]),
    ]);
    const outcome = await createRefiner({ client, ledger, applyPatch }).refine({ steps: [] });
    assert.strictEqual(outcome.ok, undefined);
    assert.strictEqual(sent.length, 2, 'the schema failure repairs like any other');
    assert.strictEqual((await ledger.listMemories()).length, 0);
  });

  it('leaves the base system prompt exactly as it was, after a committed refinement', async function () {
    const { ledger } = fixture();
    await ledger.setGoal({ objective: 'Reconcile July.' });
    const base = 'You are a careful bookkeeper. Never invent a figure.';
    /** @type {any[]} */
    const requests = [];
    const agent = createAgent({
      client: {
        complete: async (request) => {
          requests.push(request);
          return { message: { role: 'assistant', content: 'ok', toolCalls: null }, finishReason: 'stop' };
        },
      },
      system: base,
      ledger,
      retrieval: { memories: {} },
    });

    const run = await agent.send([{ role: 'user', content: 'reconcile' }]);
    const { client } = scriptedClient([JSON.stringify([
      { op: 'add', path: '/memories/-', value: MEMORY },
    ])]);
    assert.strictEqual((await createRefiner({ client, ledger, applyPatch }).refine(run)).ok, true);

    await agent.send([{ role: 'user', content: 'again' }]);
    const composed = requests.at(-1).messages[0].content;
    assert.ok(composed.startsWith(base), 'the base is untouched and still first');
    assert.match(composed, /The bank export uses CRLF line endings\./,
      'what the refinement added is what changed, and it changed by being retrieved');
    assert.strictEqual(run.messages[0].content, base);
  });
});
