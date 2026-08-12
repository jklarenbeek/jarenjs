//@ts-check
/**
 * @file The conversation as a slot, beside the conversation as a budget.
 *
 * `historyBudget` and the environment answer two different questions.
 * The budget asks *what do I cut to fit?* and the answer is always
 * something; with a ledger under it the cut is recoverable, which is
 * what Phase A bought. The environment asks *why is the history in the
 * request at all?* — and once the answer is "it is not", the request
 * stops growing with the conversation and the model reaches an earlier
 * round the same way it reaches any other corpus: grep for it, read the
 * piece.
 *
 * The test that matters is the one where they are driven side by side
 * over the same forty rounds and asked the same question. Neither run
 * involves a real model: what is measured is what the request CONTAINS
 * and what the loop can fetch back, which is a fact about the harness
 * and not an opinion about a model.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { createAgent, createEnvironment, createToolbox, transcriptText } from '@jarenjs/ai';

const ROUNDS = 40;
const PADDING = 400;

/** The corpus the agent gathers: a unique value per record, behind padding. */
const record = (i) => ({
  id: `REC${String(i).padStart(4, '0')}`,
  notes: 'x'.repeat(PADDING),
  value: 100000 + i * 7,
});

/** The tool the scripted model calls once per round. */
function fetchBox() {
  const toolbox = createToolbox();
  toolbox.add({
    name: 'fetch_record',
    description: 'Fetch one record.',
    inputSchema: {
      type: 'object',
      properties: { index: { type: 'integer', minimum: 0 } },
      required: ['index'],
      additionalProperties: false,
    },
    execute: ({ index }) => record(index),
  });
  return toolbox;
}

/**
 * A client that gathers `ROUNDS` records and then follows a script of
 * further tool calls before answering. Records every request it sees.
 * @param {any[]} afterGathering - tool calls to make once gathering ends
 */
function gatheringClient(afterGathering = []) {
  /** @type {any[]} */
  const requests = [];
  let round = 0;
  const script = [...afterGathering];
  return {
    requests,
    complete: async (request) => {
      requests.push(request);
      if (round < ROUNDS) {
        const index = round++;
        return {
          message: {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: `c${index}`, name: 'fetch_record', arguments: `{"index":${index}}` }],
          },
          finishReason: 'tool_calls',
        };
      }
      const next = script.shift();
      if (next === undefined) {
        return { message: { role: 'assistant', content: 'done', toolCalls: null }, finishReason: 'stop' };
      }
      // a script entry may be a FUNCTION of the request, which is how a
      // scripted model reads the previous tool result and acts on it —
      // the same information a real one has, and the only way to test
      // that an address returned by one call is usable by the next
      return {
        message: {
          role: 'assistant',
          content: '',
          toolCalls: [typeof next === 'function' ? next(request) : next],
        },
        finishReason: 'tool_calls',
      };
    },
  };
}

/** Whether a request carries a value verbatim. */
const carries = (request, text) => JSON.stringify(request.messages).includes(text);

describe('ai — the transcript as a slot', function () {
  it('keeps the request flat while the conversation grows', async function () {
    const environment = createEnvironment();
    const client = gatheringClient();
    const agent = createAgent({
      client, toolbox: fetchBox(), system: 'Be brief.',
      maxToolRounds: ROUNDS + 4,
      environment,
      transcript: { window: 2 },
    });
    await agent.send([{ role: 'user', content: 'gather the records' }]);

    const sizes = client.requests.map((request) => JSON.stringify(request.messages).length);
    const early = sizes[3];
    const late = sizes[sizes.length - 1];
    assert.ok(late < early * 1.5,
      `the request went from ${early} to ${late} characters over ${ROUNDS} rounds`);
    assert.ok(late < 3000, `and it stayed small in absolute terms: ${late}`);

    // the whole conversation is in the environment, in full
    const stat = await environment.stat('transcript');
    assert.strictEqual(stat.kind, 'transcript');
    assert.ok(stat.count > ROUNDS * 2, `every message is in the slot: ${stat.count}`);
    const hits = await environment.grep('REC0007', { in: 'transcript' });
    assert.strictEqual(hits.total, 1);

    // and the request says where it went, rather than pretending
    const pointer = client.requests.at(-1).messages
      .find((message) => String(message.content).includes('slot "transcript"'));
    assert.ok(pointer !== undefined, 'the request names the slot holding the rest');
    assert.match(pointer.content, /env_grep/);
  });

  it('answers a question about an early round that a compacted run cannot', async function () {
    // the same gathering, the same question, two configurations.
    const question = { id: 'q1', name: 'fetch_record', arguments: '{"index":0}' };
    void question;

    // (a) a history budget: the middle is cut, and at this budget the
    // early rounds are gone from the request entirely
    const budgeted = gatheringClient();
    const budgetedAgent = createAgent({
      client: budgeted, toolbox: fetchBox(), system: 'Be brief.',
      maxToolRounds: ROUNDS + 4,
      historyBudget: 6000,
    });
    await budgetedAgent.send([{ role: 'user', content: 'gather the records' }]);
    const lastBudgeted = budgeted.requests.at(-1);
    assert.ok(!carries(lastBudgeted, String(record(3).value)),
      'the early record is not in the compacted request — that is the premise');

    // (b) the transcript as a slot: the same early record is one grep
    // and one read away, and the loop performs both as ordinary tool calls
    const environment = createEnvironment();
    // the second call reads AT the offset the first one reported — the
    // whole point of an address: grep says where, read fetches that much
    // and no more. The offset is filled in from the grep result below.
    const scripted = gatheringClient([
      { id: 'g1', name: 'env_grep', arguments: '{"pattern":"REC0003","in":"transcript"}' },
      (request) => {
        const found = JSON.parse(request.messages.at(-1).content).matches[0];
        return {
          id: 'r1',
          name: 'env_read',
          arguments: JSON.stringify({ slot: found.slot, chars: 600, offset: found.offset }),
        };
      },
    ]);
    const envAgent = createAgent({
      client: scripted, toolbox: fetchBox(), system: 'Be brief.',
      maxToolRounds: ROUNDS + 4,
      environment,
      transcript: { window: 2 },
    });
    const result = await envAgent.send([{ role: 'user', content: 'gather the records' }]);

    const grepStep = result.steps.find((step) => step.name === 'env_grep');
    assert.strictEqual(grepStep.result.total, 1, 'the early round is found by pattern');
    assert.strictEqual(grepStep.result.matches[0].slot, 'transcript');
    assert.ok(grepStep.result.matches[0].offset > 0, 'and it says WHERE in the slot it is');
    assert.ok(JSON.stringify(grepStep.result).length < 600,
      'the hit costs a few hundred characters, not a round');

    // one read, at the address, and the value the compacted run lost is
    // back — from 600 characters rather than from the whole transcript
    const readStep = result.steps.find((step) => step.name === 'env_read');
    assert.strictEqual(readStep.result.name, 'transcript');
    assert.ok(readStep.result.text.includes(String(record(3).value)),
      'the value the compacted request no longer carried is recovered by address');
    assert.strictEqual(readStep.result.returned, 600, 'and only what was asked for came back');
    assert.strictEqual(result.stopReason, 'stop');
  });

  it('registers the environment tools without taking a host name', async function () {
    const environment = createEnvironment();
    const host = createToolbox();
    host.add({
      name: 'env_read',
      description: 'The HOST\'s own env_read.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      execute: () => ({ mine: true }),
    });
    const client = gatheringClient([{ id: 'x', name: 'env_read', arguments: '{}' }]);
    const agent = createAgent({
      client, toolbox: host, maxToolRounds: ROUNDS + 4, environment,
    });
    const result = await agent.send([{ role: 'user', content: 'go' }]);

    const names = client.requests.at(-1).tools.map((tool) => tool.function.name);
    assert.strictEqual(names.filter((name) => name === 'env_read').length, 1,
      'two definitions of one function name is not a wire-legal request');
    assert.deepStrictEqual(result.steps.at(-1).result, { mine: true },
      'the host keeps the name it registered, and its tool is what runs');
    assert.ok(names.includes('env_grep'), 'the rest of the environment is still there');
  });

  it('changes nothing without an environment (D6)', async function () {
    const bare = gatheringClient();
    const withEnv = gatheringClient();
    const history = [{ role: 'user', content: 'gather the records' }];

    const before = await createAgent({
      client: bare, toolbox: fetchBox(), system: 'Be brief.', maxToolRounds: ROUNDS + 4,
    }).send(history);
    // an environment present but no `transcript`: the tools appear, the
    // request assembly does not move
    const after = await createAgent({
      client: withEnv, toolbox: fetchBox(), system: 'Be brief.', maxToolRounds: ROUNDS + 4,
      environment: createEnvironment(),
    }).send(history);

    assert.deepStrictEqual(after.messages, before.messages,
      'the transcript is byte-identical; only the tool list differs');
    assert.strictEqual(JSON.stringify(withEnv.requests.at(-1).messages),
      JSON.stringify(bare.requests.at(-1).messages));
  });

  it('renders the transcript line by line, so a grep hit is one legible round', function () {
    const text = transcriptText([
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'gather' },
      { role: 'assistant', content: '', tool_calls: [{ function: { name: 'fetch_record', arguments: '{"index":7}' } }] },
      { role: 'tool', name: 'fetch_record', content: '{"id":"REC0007","value":100049}' },
    ]);
    const lines = text.split('\n');
    assert.strictEqual(lines.length, 4);
    assert.match(lines[0], /^\[0\] system: Be brief\./);
    assert.match(lines[2], /^\[2\] assistant → fetch_record\(\{"index":7\}\)/);
    assert.match(lines[3], /^\[3\] tool fetch_record: \{"id":"REC0007"/,
      'a tool result is one line, so grepping for a value returns the round that found it');
  });
});
