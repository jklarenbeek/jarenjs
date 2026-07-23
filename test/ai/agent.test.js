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
});
