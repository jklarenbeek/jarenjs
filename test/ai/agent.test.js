//@ts-check
import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { hashContent } from '@jarenjs/core/string';

import {
  createAgent, createToolbox, createLedger, slotAddressesIn, roundSlotName,
} from '@jarenjs/ai';

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

  it('with no ledger the compacted request is byte-identical to what it always was', async function () {
    // D6, pinned rather than described. These fingerprints were taken
    // from the implementation as it stood BEFORE compaction learned to
    // archive: `git show <pre>:packages/ai/src/agent.js`, driven by this
    // same history. Four budgets, so the pin covers the ordinary cut
    // (4000), a cut deep enough to lose most of the tail (2500) and two
    // where the synopsis itself is truncated to fit (1200, 800).
    //
    // A change to any of them is not a test to update — it is a silent
    // change to every existing caller, which is the thing D6 forbids.
    const pinned = { 4000: 'jknb4v', 2500: '1aoqg55', 1200: '1jy929n', 800: 'nu5c1k' };
    for (const [budget, fingerprint] of Object.entries(pinned)) {
      const { wires, client } = capturingClient();
      const agent = createAgent({
        client: /** @type {any} */ (client),
        system: 'You are the assistant.',
        historyBudget: Number(budget),
      });
      await agent.send(longHistory(12));
      assert.strictEqual(hashContent(JSON.stringify(wires[0])), fingerprint,
        `the ledger-free request at budget ${budget} changed`);
    }
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

  //#region compaction that moves (D4)

  it('with a ledger every dropped round is archived and its address travels', async function () {
    const { wires, client } = capturingClient();
    const ledger = createLedger();
    const agent = createAgent({
      client: /** @type {any} */ (client),
      system: 'You are the assistant.',
      historyBudget: 4_000,
      ledger,
    });
    const history = longHistory(12);
    await agent.send(history);
    const wire = wires[0];
    const synopsis = wire.find((m) => typeof m.content === 'string'
      && m.content.startsWith('[Earlier context'));

    // the header announces the mechanism where the model needs it, and
    // names the index; the lines carry one address each
    assert.match(synopsis.content, /ARCHIVED, not lost/);
    const addresses = slotAddressesIn(synopsis.content);
    assert.ok(addresses.length > 1, 'the index address plus one per dropped round');

    // every address the request names answers, and the content is the
    // round itself — not a summary of it
    for (const name of addresses) {
      const content = await ledger.readSlot(name);
      assert.ok(typeof content === 'string' && content.length > 0, `slot ${name} is empty`);
    }
    const rounds = await ledger.listSlots();
    assert.ok(rounds.length > 0);
    for (const slot of rounds) {
      assert.ok(['agent-round', 'agent-round-index'].includes(slot.kind));
    }

    // the address is derived from the round's own bytes: the dropped
    // assistant turn is inside the slot it addresses
    const first = JSON.parse(await ledger.readSlot(addresses[1]));
    assert.ok(Array.isArray(first) && first[0].role === 'assistant');
    assert.strictEqual(roundSlotName(JSON.stringify(first)), addresses[1],
      'the name IS the hash of the content, so the same round cannot be stored twice');
  });

  it('recall is registered, appears in steps, and answers { error } for an unknown slot', async function () {
    /** @type {any[]} */
    const seenTools = [];
    let archived = '';
    const ledger = createLedger();
    const client = {
      complete: async ({ messages, tools }) => {
        seenTools.push(tools);
        const synopsis = messages.find((m) => typeof m.content === 'string'
          && m.content.startsWith('[Earlier context'));
        if (synopsis !== undefined && archived === '') {
          [, archived] = slotAddressesIn(synopsis.content);
          return toolTurn([
            { id: 'r1', name: 'recall', arguments: JSON.stringify({ slot: archived }) },
            { id: 'r2', name: 'recall', arguments: '{"slot":"r-nope-1"}' },
          ]);
        }
        return final('done');
      },
    };
    const agent = createAgent({
      client: /** @type {any} */ (client),
      system: 'You are the assistant.',
      historyBudget: 4_000,
      ledger,
    });
    const result = await agent.send(longHistory(12));

    assert.ok(seenTools[0].some((t) => t.function.name === 'recall'),
      'a ledger registers recall — and only a ledger does');
    assert.deepStrictEqual(result.steps.map((s) => s.name), ['recall', 'recall'],
      'a recall is an ordinary step, inspectable like any other call');
    assert.strictEqual(result.steps[0].result.slot, archived);
    assert.match(result.steps[0].result.content, /jaren_studio_patch/);
    // the miss never throws, and points at the listing rather than
    // leaving the model with a refusal it cannot act on
    assert.match(result.steps[1].result.error, /unknown slot 'r-nope-1'/);
    assert.match(result.steps[1].result.hint, /lists every address/);
  });

  it('no ledger means no recall tool, and a host that has its own keeps it', async function () {
    const bare = createToolbox();
    bare.add({
      name: 'recall',
      description: 'the host had this name first',
      inputSchema: { type: 'object' },
      execute: () => ({ mine: true }),
    });
    /** @type {any[]} */
    const seenTools = [];
    const client = {
      complete: async ({ tools }) => {
        seenTools.push(tools ?? []);
        return final('ok');
      },
    };

    await createAgent({ client: /** @type {any} */ (client), toolbox: mathToolbox() })
      .send([{ role: 'user', content: 'x' }]);
    assert.deepStrictEqual(seenTools[0].map((t) => t.function.name), ['add'],
      'without a ledger the tool list is exactly the host\'s');

    await createAgent({ client: /** @type {any} */ (client), toolbox: bare, ledger: createLedger() })
      .send([{ role: 'user', content: 'x' }]);
    assert.deepStrictEqual(seenTools[1].map((t) => t.function.name), ['recall'],
      'two definitions of one function name is not a wire-legal request');
    assert.strictEqual(seenTools[1][0].function.description, 'the host had this name first');
  });

  it('a custom compaction hook is given the addresses, and the header survives it', async function () {
    const { wires, client } = capturingClient();
    /** @type {any[] | null} */
    let addresses = null;
    const agent = createAgent({
      client: /** @type {any} */ (client),
      historyBudget: 4_000,
      ledger: createLedger(),
      compaction: (dropped, given) => {
        addresses = /** @type {any[]} */ (given);
        return `HOST WROTE ${dropped.length}`;
      },
    });
    await agent.send(longHistory(12));
    const synopsis = wires[0].find((m) => typeof m.content === 'string'
      && m.content.startsWith('[Earlier context'));
    assert.match(synopsis.content, /HOST WROTE \d+/);
    assert.strictEqual(slotAddressesIn(synopsis.content).length, 1,
      'a writer that ignores the addresses still cannot lose them: the header names the index');
    assert.ok(Array.isArray(addresses) && addresses.length > 0);
    for (const address of /** @type {any[]} */ (addresses)) {
      assert.strictEqual(typeof address.name, 'string');
      assert.strictEqual(typeof address.size, 'number');
    }
  });

  it('a ledger that cannot store fails loudly instead of dropping the round', async function () {
    const { client } = capturingClient();
    const refusing = {
      putSlot: async () => ({ error: 'quota exceeded' }),
      getSlot: async () => null,
      readSlot: async () => undefined,
    };
    const agent = createAgent({
      client: /** @type {any} */ (client), historyBudget: 4_000, ledger: refusing,
    });
    await assert.rejects(() => agent.send(longHistory(12)), (/** @type {any} */ err) => {
      assert.strictEqual(err.code, 'AI0001');
      assert.match(err.message, /could not archive a round/);
      return true;
    });

    assert.throws(() => createAgent({ client: /** @type {any} */ (client), ledger: {} }),
      /AI0001.*putSlot/s, 'a ledger-shaped thing that is not one is caught at construction');
  });

  //#endregion
});
