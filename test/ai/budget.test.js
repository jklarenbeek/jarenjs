//@ts-check
/**
 * @file Budgets are refusals, not warnings.
 *
 * Three quantities bound a run — model calls, tokens, wall-clock — and
 * each one stops it with a named reason and a message saying what is
 * left. The posture is the loop's existing `maxToolRounds`: stop and say
 * so, rather than spin.
 *
 * The test that matters most is the quiet one: a budget must never
 * silently fail to apply. A provider that reports no `usage` is the
 * common case on local runtimes, and a token budget that only worked
 * against providers that happen to report usage would be a feature that
 * is absent exactly where it is needed.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { createAgent, createToolbox } from '@jarenjs/ai';

/** A client that always wants one more tool call, and counts its calls. */
function loopingClient(usage = null) {
  /** @type {any[]} */
  const requests = [];
  return {
    requests,
    complete: async (request) => {
      requests.push(request);
      return {
        message: {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: `c${requests.length}`, name: 'tick', arguments: '{}' }],
        },
        finishReason: 'tool_calls',
        usage,
      };
    },
  };
}

function tickBox() {
  const toolbox = createToolbox();
  toolbox.add({
    name: 'tick',
    description: 'Tick.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    execute: () => ({ ok: true }),
  });
  return toolbox;
}

describe('ai — run budgets', function () {
  it('stops on the turn budget, names what remains, and makes no further call', async function () {
    const client = loopingClient();
    const agent = createAgent({
      client, toolbox: tickBox(), maxToolRounds: 50, budget: { turns: 3, tokens: 100000 },
    });
    const result = await agent.send([{ role: 'user', content: 'go' }]);

    assert.strictEqual(result.stopReason, 'budget-turns');
    assert.strictEqual(client.requests.length, 3, 'the fourth call is refused, not made');
    assert.match(result.message.content, /the turns budget is spent \(3 of 3\)/);
    assert.match(result.message.content, /turns: 0 of 3 left/);
    assert.match(result.message.content, /tokens: \d+ of 100000 left/);
    assert.match(result.message.content, /ms: no limit/);
    assert.strictEqual(result.messages.at(-1), result.message,
      'the stop is part of the transcript a host persists');
    assert.strictEqual(agent.spend().turns, 3);
  });

  it('counts the provider\'s reported usage', async function () {
    const client = loopingClient({ prompt_tokens: 400, completion_tokens: 100, total_tokens: 500 });
    const agent = createAgent({
      client, toolbox: tickBox(), maxToolRounds: 50, budget: { tokens: 1200 },
    });
    const result = await agent.send([{ role: 'user', content: 'go' }]);

    assert.strictEqual(result.stopReason, 'budget-tokens');
    assert.strictEqual(client.requests.length, 3, '500 + 500 + 500 crosses 1200 on the third');
    assert.strictEqual(agent.spend().tokens, 1500);
    assert.match(result.message.content, /the tokens budget is spent \(1500 of 1200\)/);
  });

  it('falls back to character accounting when a provider reports no usage', async function () {
    // the local-runtime case: nothing reports usage, and a budget that
    // quietly did not apply here would be worse than no budget at all
    const client = loopingClient(null);
    const agent = createAgent({
      client, toolbox: tickBox(), maxToolRounds: 50, budget: { tokens: 300 },
    });
    const result = await agent.send([{ role: 'user', content: 'go' }]);

    assert.strictEqual(result.stopReason, 'budget-tokens');
    assert.ok(client.requests.length >= 2 && client.requests.length < 50,
      `the estimate has to bite: ${client.requests.length} calls made`);
    assert.ok(agent.spend().tokens >= 300);
    // deterministic, not a guess: the same transcript estimates the same
    const twin = loopingClient(null);
    await createAgent({
      client: twin, toolbox: tickBox(), maxToolRounds: 50, budget: { tokens: 300 },
    }).send([{ role: 'user', content: 'go' }]);
    assert.strictEqual(twin.requests.length, client.requests.length);
  });

  it('stops on the time budget, on an injected clock', async function () {
    let ticks = 0;
    const client = loopingClient();
    const agent = createAgent({
      client,
      toolbox: tickBox(),
      maxToolRounds: 50,
      budget: { ms: 5000 },
      now: () => (ticks++) * 2000,
    });
    const result = await agent.send([{ role: 'user', content: 'go' }]);

    assert.strictEqual(result.stopReason, 'budget-ms');
    assert.match(result.message.content, /the ms budget is spent/);
    assert.ok(agent.spend().ms >= 5000);
  });

  it('refuses before the first call when the seeded budget is already spent', async function () {
    const client = loopingClient();
    const agent = createAgent({
      client, toolbox: tickBox(), budget: { turns: 4, spent: { turns: 4 } },
    });
    const result = await agent.send([{ role: 'user', content: 'go' }]);

    assert.strictEqual(result.stopReason, 'budget-turns');
    assert.strictEqual(client.requests.length, 0,
      'a budget that survived a reload refuses the first call of the new session');
    assert.strictEqual(result.messages.at(-1).role, 'assistant');
  });

  it('carries one budget across several sends', async function () {
    const client = loopingClient();
    const agent = createAgent({ client, toolbox: tickBox(), maxToolRounds: 0, budget: { turns: 2 } });
    // maxToolRounds 0: each send makes exactly one call and stops
    const first = await agent.send([{ role: 'user', content: 'a' }]);
    assert.strictEqual(first.stopReason, 'tool-limit');
    const second = await agent.send([{ role: 'user', content: 'b' }]);
    assert.strictEqual(second.stopReason, 'tool-limit');
    const third = await agent.send([{ role: 'user', content: 'c' }]);
    assert.strictEqual(third.stopReason, 'budget-turns',
      'the budget bounds the RUN, not the turn — that is what makes it long-horizon');
    assert.strictEqual(client.requests.length, 2);
  });

  it('changes nothing without a budget (D6)', async function () {
    const client = loopingClient();
    const agent = createAgent({ client, toolbox: tickBox(), maxToolRounds: 2 });
    const result = await agent.send([{ role: 'user', content: 'go' }]);
    assert.strictEqual(result.stopReason, 'tool-limit');
    assert.strictEqual(client.requests.length, 3);
    // the counters still run — they cost nothing and a host may want them
    assert.strictEqual(agent.spend().turns, 3);
    assert.strictEqual(agent.spend().tokens, 0, 'no usage reported and no budget: nothing estimated');
  });
});
