//@ts-check
/**
 * @file The persistent objective, and what it does to a request.
 *
 * The claim being tested is narrow and load-bearing: an objective set in
 * one agent instance is in the prompt of a DIFFERENT instance built over
 * the same storage, together with everything already recorded against it.
 * That is the closed-tab case, and it is the whole reason a goal lives in
 * a ledger rather than in a variable.
 *
 * The second claim is about where composition happens. The goal is
 * composed into the REQUEST and never into the transcript — because the
 * transcript is what a host persists and sends back, and a goal baked
 * into it would be composed again next turn, and again the turn after.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { createAgent, createLedger, createMemoryStorage, createHashEmbedder, AiError } from '@jarenjs/ai';

/** A client that records every request and answers with fixed text. */
function recordingClient(text = 'done') {
  /** @type {any[]} */
  const requests = [];
  return {
    requests,
    complete: async (request) => {
      requests.push(request);
      return {
        message: { role: 'assistant', content: text, toolCalls: null },
        finishReason: 'stop',
      };
    },
  };
}

const AT = '2026-08-12T09:00:00Z';

/** A ledger over one storage, with a fixed clock. */
const ledgerOver = (storage) => createLedger({ storage, now: () => AT });

describe('ai — the persistent goal', function () {
  it('reaches a NEW agent over the same storage, with its progress (the closed tab)', async function () {
    const storage = createMemoryStorage();
    const first = ledgerOver(storage);
    await first.setGoal({ objective: 'Reconcile the July ledger against the bank export.' });
    await first.recordProgress({
      note: 'Matched 412 of 480 lines',
      evidence: 'reconcile_run tool result, batch 3',
    });

    // a different ledger instance, a different agent — the tab was closed
    const client = recordingClient();
    const agent = createAgent({
      client, system: 'You are a careful bookkeeper.', ledger: ledgerOver(storage),
    });
    await agent.send([{ role: 'user', content: 'carry on' }]);

    const prompt = client.requests[0].messages[0].content;
    assert.strictEqual(client.requests[0].messages[0].role, 'system');
    assert.ok(prompt.startsWith('You are a careful bookkeeper.'),
      'the immutable base prompt comes first, unaltered');
    assert.match(prompt, /Reconcile the July ledger against the bank export\./);
    assert.match(prompt, /Matched 412 of 480 lines/);
    assert.match(prompt, /evidence: reconcile_run tool result, batch 3/);
    assert.match(prompt, /do not repeat it/i,
      'the progress log has to say what it is for, or it reads as background');
  });

  it('composes into the request and never into the transcript', async function () {
    const ledger = createLedger({ now: () => AT });
    await ledger.setGoal({ objective: 'Find the flaky test.' });
    const client = recordingClient();
    const agent = createAgent({ client, system: 'Base.', ledger });

    const result = await agent.send([{ role: 'user', content: 'go' }]);
    assert.strictEqual(result.messages[0].content, 'Base.',
      'the returned transcript keeps the base prompt — a host persists this');
    assert.match(client.requests[0].messages[0].content, /Find the flaky test\./);

    // the persisted transcript comes back next turn: the goal must appear
    // exactly once, not twice
    const second = await agent.send([...result.messages, { role: 'user', content: 'and now?' }]);
    const sent = client.requests[1].messages[0].content;
    assert.strictEqual(sent.match(/Find the flaky test\./g).length, 1);
    assert.strictEqual(second.messages[0].content, 'Base.');
  });

  it('composes a goal onto a system message the history already carries', async function () {
    const ledger = createLedger({ now: () => AT });
    await ledger.setGoal({ objective: 'Ship the release.' });
    const client = recordingClient();
    const agent = createAgent({ client, ledger });

    const result = await agent.send([
      { role: 'system', content: 'Host prompt.' },
      { role: 'user', content: 'go' },
    ]);
    const sent = client.requests[0].messages[0].content;
    assert.ok(sent.startsWith('Host prompt.'));
    assert.match(sent, /Ship the release\./);
    assert.strictEqual(result.messages[0].content, 'Host prompt.',
      'the host\'s own system message is not rewritten');
  });

  it('leaves the request untouched with no goal, no retrieval and no ledger (D6)', async function () {
    const bare = recordingClient();
    const withLedger = recordingClient();
    const history = [{ role: 'user', content: 'hello' }];

    const before = await createAgent({ client: bare, system: 'Base.' }).send(history);
    // a ledger present for compaction only: an empty ledger must change
    // nothing about the request an existing caller was already sending
    const after = await createAgent({
      client: withLedger, system: 'Base.', ledger: createLedger(),
    }).send(history);

    assert.deepStrictEqual(withLedger.requests[0].messages, bare.requests[0].messages);
    assert.strictEqual(withLedger.requests[0].messages, after.messages,
      'with nothing composed the request IS the transcript, by reference');
    assert.deepStrictEqual(after.messages, before.messages);
  });

  it('drops a goal that is no longer active', async function () {
    const ledger = createLedger({ now: () => AT });
    await ledger.setGoal({ objective: 'The finished thing.' });
    await ledger.setGoalStatus('done');
    const client = recordingClient();
    await createAgent({ client, system: 'Base.', ledger }).send([{ role: 'user', content: 'go' }]);
    assert.strictEqual(client.requests[0].messages[0].content, 'Base.');
  });

  it('retrieves memories and skills only when asked, and never on their own', async function () {
    const ledger = createLedger({ now: () => AT });
    await ledger.addMemory({
      text: 'The export uses CRLF line endings.',
      evidence: 'head -c 200 export.csv',
      tags: ['csv'],
    });
    await ledger.addSkill({
      name: 'reconcile',
      when: 'a bank export and a ledger disagree',
      instructions: 'Sort both by date, then diff on amount.',
      tools: ['reconcile_run'],
    });

    const quiet = recordingClient();
    await createAgent({ client: quiet, system: 'Base.', ledger })
      .send([{ role: 'user', content: 'go' }]);
    assert.strictEqual(quiet.requests[0].messages[0].content, 'Base.',
      'memories are RETRIEVED, not unconditional — without a retrieval option, nothing');

    const asked = recordingClient();
    await createAgent({
      client: asked,
      system: 'Base.',
      ledger,
      retrieval: { memories: { tags: ['csv'], limit: 3 }, skills: {} },
    }).send([{ role: 'user', content: 'go' }]);
    const prompt = asked.requests[0].messages[0].content;
    assert.match(prompt, /The export uses CRLF line endings\./);
    assert.match(prompt, /evidence: head -c 200 export\.csv/);
    assert.match(prompt, /reconcile — when a bank export and a ledger disagree/);
    assert.match(prompt, /tools: reconcile_run/);
  });

  it('composes a ranked retrieval exactly as it composes a listed one', async function () {
    // `retrieval.memories: { near }` answers `{ memories, scores, skipped }`
    // rather than an array; the prompt must carry the ranked records and
    // nothing else changes
    const embedder = createHashEmbedder({ dims: 16 });
    const ledger = createLedger({ now: () => AT, embedder, embedOnWrite: true });
    await ledger.addMemory({ text: 'The export uses CRLF line endings.', evidence: 'head -c 200 export.csv' });
    await ledger.addMemory({ text: 'Quarterly revenue is reported by region.', evidence: 'finance/README' });
    const client = recordingClient();
    await createAgent({
      client, system: 'Base.', ledger,
      retrieval: { memories: { near: 'CRLF line endings in the export', limit: 1 } },
    }).send([{ role: 'user', content: 'go' }]);
    const prompt = client.requests[0].messages[0].content;
    assert.match(prompt, /The export uses CRLF line endings\./, 'the nearest memory reached the prompt');
    assert.doesNotMatch(prompt, /Quarterly revenue/, 'and only the nearest, under the limit');
  });

  it('refuses loudly when a retrieval predicate needs a seam nobody wired', async function () {
    const ledger = createLedger({ now: () => AT });
    await ledger.addMemory({ text: 'a', evidence: 'b' });
    const agent = createAgent({
      client: recordingClient(),
      ledger,
      retrieval: { memories: { where: { $eq: ['$it.text', 'a'] } } },
    });
    await assert.rejects(() => agent.send([{ role: 'user', content: 'go' }]), (error) => {
      assert.ok(error instanceof AiError);
      assert.strictEqual(error.code, 'AI0001');
      assert.match(error.message, /compileQuery/);
      return true;
    });
  });

  it('resume() continues an objective with no new instruction, and refuses without one', async function () {
    const storage = createMemoryStorage();
    const ledger = ledgerOver(storage);
    const client = recordingClient('picked up where I left off');
    const agent = createAgent({ client, system: 'Base.', ledger });

    await assert.rejects(() => agent.resume(), (error) => {
      assert.strictEqual(/** @type {any} */ (error).code, 'AI0001');
      assert.match(/** @type {Error} */ (error).message, /active goal/);
      return true;
    });

    await ledger.setGoal({ objective: 'Index the corpus.' });
    await ledger.recordProgress({ note: 'Indexed shard 1', evidence: 'index_shard → ok' });
    const result = await agent.resume();

    const sent = client.requests[0].messages;
    assert.strictEqual(sent.at(-1).role, 'user');
    assert.match(sent.at(-1).content, /Continue working on the objective/);
    assert.match(sent[0].content, /Index the corpus\./);
    assert.match(sent[0].content, /Indexed shard 1/);
    assert.strictEqual(result.message.content, 'picked up where I left off');
  });
});
