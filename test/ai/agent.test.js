//@ts-check
import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { createAgent, createToolbox } from '@jarenjs/ai';

/** A scripted client: each complete() call shifts the next reply. */
function scriptedClient(replies) {
  /** @type {any[]} */
  const requests = [];
  return {
    requests,
    complete: async (request) => {
      requests.push(request);
      const next = replies.shift();
      if (next === undefined) throw new Error('script exhausted');
      return next;
    },
  };
}

const final = (content) => ({
  message: { role: 'assistant', content, toolCalls: null }, finishReason: 'stop',
});
const toolTurn = (calls) => ({
  message: { role: 'assistant', content: '', toolCalls: calls }, finishReason: 'tool_calls',
});

function mathToolbox() {
  const toolbox = createToolbox();
  toolbox.add({
    name: 'add',
    description: 'Add two integers.',
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'integer' }, b: { type: 'integer' } },
      required: ['a', 'b'],
    },
    execute: ({ a, b }) => ({ sum: a + b }),
  });
  return toolbox;
}

describe('ai — the agent loop', function () {
  it('runs a tool round-trip and returns the full transcript', async function () {
    const client = scriptedClient([
      toolTurn([{ id: 'c1', name: 'add', arguments: '{"a":2,"b":3}' }]),
      final('The sum is 5.'),
    ]);
    const events = [];
    const agent = createAgent({ client, toolbox: mathToolbox(), system: 'Be brief.' });
    const history = [{ role: 'user', content: 'what is 2+3?' }];
    const result = await agent.send(history, {
      onToolCall: (call) => events.push(`call:${call.name}`),
      onToolResult: (step) => events.push(`result:${JSON.stringify(step.result)}`),
    });

    assert.strictEqual(result.message.content, 'The sum is 5.');
    assert.strictEqual(result.stopReason, 'stop');
    assert.deepStrictEqual(events, ['call:add', 'result:{"sum":5}']);
    assert.deepStrictEqual(result.steps,
      [{ name: 'add', arguments: '{"a":2,"b":3}', result: { sum: 5 } }]);

    // wire transcript: system, user, assistant(tool_calls), tool, assistant
    assert.deepStrictEqual(result.messages.map((m) => m.role),
      ['system', 'user', 'assistant', 'tool', 'assistant']);
    assert.strictEqual(result.messages[2].tool_calls[0].function.name, 'add');
    assert.strictEqual(result.messages[3].tool_call_id, 'c1');
    assert.deepStrictEqual(JSON.parse(result.messages[3].content), { sum: 5 });
    assert.deepStrictEqual(history, [{ role: 'user', content: 'what is 2+3?' }],
      'the given history is never mutated');

    // the second round sends the tool result back with the tools attached
    assert.strictEqual(client.requests.length, 2);
    assert.strictEqual(client.requests[1].tools[0].function.name, 'add');
    assert.strictEqual(client.requests[1].messages, result.messages,
      'the loop extends one transcript in place');
  });

  it('does not duplicate an existing system message, omits tools without a toolbox', async function () {
    const client = scriptedClient([final('hi')]);
    const agent = createAgent({ client, system: 'ignored' });
    const result = await agent.send([
      { role: 'system', content: 'already here' },
      { role: 'user', content: 'hello' },
    ]);
    assert.strictEqual(result.messages[0].content, 'already here');
    assert.strictEqual(client.requests[0].tools, undefined);
    assert.strictEqual(result.messages.filter((m) => m.role === 'system').length, 1);
  });

  it('malformed tool arguments become a readable { error } result', async function () {
    const client = scriptedClient([
      toolTurn([{ id: 'c1', name: 'add', arguments: '{oops' }]),
      final('recovered'),
    ]);
    const agent = createAgent({ client, toolbox: mathToolbox() });
    const result = await agent.send([{ role: 'user', content: 'go' }]);
    assert.match(result.steps[0].result.error, /not valid JSON/);
    assert.strictEqual(result.message.content, 'recovered');
  });

  it('empty arguments mean an empty object; a missing toolbox answers with an error result', async function () {
    const client = scriptedClient([
      toolTurn([{ id: 'c1', name: 'anything', arguments: '' }]),
      final('done'),
    ]);
    const agent = createAgent({ client });
    const result = await agent.send([{ role: 'user', content: 'go' }]);
    assert.deepStrictEqual(result.steps[0].result, { error: 'no tools are available' });
  });

  it('stops at maxToolRounds with a readable message instead of spinning', async function () {
    const spin = () => toolTurn([{ id: 'x', name: 'add', arguments: '{"a":1,"b":1}' }]);
    const client = scriptedClient([spin(), spin(), spin()]);
    const agent = createAgent({ client, toolbox: mathToolbox(), maxToolRounds: 2 });
    const result = await agent.send([{ role: 'user', content: 'loop forever' }]);
    assert.strictEqual(result.stopReason, 'tool-limit');
    assert.match(result.message.content, /Stopped after 2 tool rounds/);
    assert.strictEqual(client.requests.length, 3, 'maxToolRounds + the final refusal turn');
    assert.strictEqual(result.steps.length, 2, 'the over-limit round executed nothing');
  });

  it('truncates oversized tool results to respect small contexts', async function () {
    const toolbox = createToolbox();
    toolbox.add({
      name: 'blob', description: 'returns a huge string',
      inputSchema: { type: 'object' },
      execute: () => ({ text: 'x'.repeat(500) }),
    });
    const client = scriptedClient([
      toolTurn([{ id: 'c1', name: 'blob', arguments: '{}' }]),
      final('ok'),
    ]);
    const agent = createAgent({ client, toolbox, maxToolResultChars: 64 });
    const result = await agent.send([{ role: 'user', content: 'go' }]);
    const toolMessage = result.messages.find((m) => m.role === 'tool');
    assert.strictEqual(toolMessage.content.length, 64 + '… [truncated]'.length);
    assert.match(toolMessage.content, /… \[truncated\]$/);
  });

  it('streams the final reply through onDelta (passthrough to the client)', async function () {
    const client = {
      complete: async ({ onDelta }) => {
        onDelta?.('par');
        onDelta?.('tial');
        return final('partial');
      },
    };
    const agent = createAgent({ client: /** @type {any} */ (client) });
    const chunks = [];
    const result = await agent.send([{ role: 'user', content: 'x' }],
      { onDelta: (t) => chunks.push(t) });
    assert.deepStrictEqual(chunks, ['par', 'tial']);
    assert.strictEqual(result.message.content, 'partial');
  });

  it('forwards onReasoning and exposes reasoning on the result, never the transcript', async function () {
    const client = {
      complete: async ({ onReasoning }) => {
        onReasoning?.('hmm');
        return {
          message: { role: 'assistant', content: 'done', toolCalls: null, reasoning: 'hmm' },
          finishReason: 'stop',
        };
      },
    };
    const agent = createAgent({ client: /** @type {any} */ (client) });
    const thinking = [];
    const result = await agent.send([{ role: 'user', content: 'x' }],
      { onReasoning: (t) => thinking.push(t) });
    assert.deepStrictEqual(thinking, ['hmm']);
    assert.strictEqual(result.message.reasoning, 'hmm');
    assert.strictEqual(result.message.content, 'done');
    const last = result.messages[result.messages.length - 1];
    assert.strictEqual('reasoning' in last, false,
      'the wire transcript stays clean for the next request');
  });
});

describe('ai — history compaction', function () {
  /** A long adversarial history: tool rounds, plain turns, big results. */
  function longHistory(rounds) {
    const messages = [{ role: 'user', content: 'build me a questionnaire' }];
    for (let i = 0; i < rounds; i++) {
      messages.push({
        role: 'assistant', content: '',
        tool_calls: [
          { id: `a${i}`, type: 'function', function: { name: 'jaren_studio_patch', arguments: `{"patch":[{"op":"add","path":"/q${i}"}]}` } },
          { id: `b${i}`, type: 'function', function: { name: 'jaren_studio_read', arguments: '{}' } },
        ],
      });
      messages.push({ role: 'tool', tool_call_id: `a${i}`, name: 'jaren_studio_patch', content: `{"ok":true,"revision":${i}}` });
      messages.push({ role: 'tool', tool_call_id: `b${i}`, name: 'jaren_studio_read', content: 'x'.repeat(400) });
      messages.push({ role: 'assistant', content: `round ${i} done, on to the next step` });
    }
    messages.push({ role: 'user', content: 'now add a sleep question' });
    return messages;
  }

  /** A client capturing what actually went on the wire. */
  function capturingClient() {
    /** @type {any[][]} */
    const wires = [];
    return {
      wires,
      client: {
        complete: async ({ messages }) => {
          wires.push(messages);
          return final('ok');
        },
      },
    };
  }

  it('under budget the history passes through by reference', async function () {
    const { wires, client } = capturingClient();
    const agent = createAgent({ client: /** @type {any} */ (client), historyBudget: 1_000_000 });
    const history = longHistory(2);
    await agent.send(history);
    assert.strictEqual(wires[0].length, history.length + 1, 'system + untouched history');
  });

  it('over budget: pairing survives, pins survive, budget is respected', async function () {
    const { wires, client } = capturingClient();
    const agent = createAgent({
      client: /** @type {any} */ (client),
      system: 'You are the assistant.',
      historyBudget: 4_000,
    });
    const history = longHistory(12);
    const result = await agent.send(history);
    const wire = wires[0];

    // pins: system first, then the first user message
    assert.strictEqual(wire[0].role, 'system');
    assert.strictEqual(wire[1].content, 'build me a questionnaire');

    // budget respected (the synopsis reserve keeps a small margin)
    const size = wire.reduce((n, m) => n + JSON.stringify(m).length, 0);
    assert.ok(size <= 4_000, `wire size ${size} within the budget`);

    // wire-format integrity: every tool reply has its assistant call
    // in the same request, and every call has its reply
    const callIds = new Set(wire.flatMap((m) =>
      Array.isArray(m.tool_calls) ? m.tool_calls.map((c) => c.id) : []));
    for (const m of wire) {
      if (m.role === 'tool') assert.ok(callIds.has(m.tool_call_id), `orphan tool reply ${m.tool_call_id}`);
    }
    for (const id of callIds) {
      assert.ok(wire.some((m) => m.role === 'tool' && m.tool_call_id === id), `unanswered call ${id}`);
    }

    // the synopsis names the dropped tool activity
    const synopsis = wire.find((m) => typeof m.content === 'string' && m.content.startsWith('[Earlier context'));
    assert.ok(synopsis, 'a synopsis message replaced the dropped middle');
    assert.match(synopsis.content, /jaren_studio_patch/);
    assert.match(synopsis.content, /→/);

    // the latest user turn survived in the tail
    assert.ok(wire.some((m) => m.content === 'now add a sleep question'));

    // the RETURNED transcript is the full, uncompacted history
    assert.strictEqual(result.messages.length, history.length + 2,
      'system + full history + the final reply');
  });

  it('a custom compaction hook receives exactly the dropped rounds', async function () {
    const { wires, client } = capturingClient();
    /** @type {any[][] | null} */
    let seen = null;
    const agent = createAgent({
      client: /** @type {any} */ (client),
      historyBudget: 4_000,
      compaction: (dropped) => {
        seen = dropped;
        return 'CUSTOM SUMMARY';
      },
    });
    await agent.send(longHistory(12));
    const wire = wires[0];
    assert.ok(wire.some((m) => m.content === 'CUSTOM SUMMARY'));
    assert.ok(Array.isArray(seen) && seen.length > 0);
    for (const unit of /** @type {any[][]} */ (seen)) {
      assert.ok(Array.isArray(unit) && unit.length > 0, 'each dropped round is a message unit');
      if (unit[0].role === 'assistant' && Array.isArray(unit[0].tool_calls)) {
        assert.ok(unit.slice(1).every((m) => m.role === 'tool'),
          'tool rounds travel whole into the hook');
      }
    }
  });
});
