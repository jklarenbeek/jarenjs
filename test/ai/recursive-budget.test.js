//@ts-check
/**
 * @file The budget a recursive run cannot outspend.
 *
 * Depth times fan-out is multiplicative — depth 3 fanning twenty ways at
 * each level is eight thousand leaf calls — so a per-call budget cannot
 * bound a tree. One account is shared by every depth, checked BEFORE
 * each call and charged by it.
 *
 * Everything here runs against a scripted client that counts calls, on
 * purpose: discovering that a shared budget works by watching a metered
 * key drain is not an acceptable way to find out. No key, no network, no
 * flake — and the assertion is the count itself.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import {
  createEnvironment, createLedger, createLongHorizonAgent, createProgramAuthor,
  createProgramRunner, createStructuredOutput, createBudgetAccount,
} from '@jarenjs/ai';
import { compileJsonQuery } from '@jarenjs/json/query';

const PROGRAM = {
  steps: [
    { op: 'chunk', from: 'corpus', as: 'pieces', strategy: 'line', size: 200 },
    { op: 'map', from: 'pieces', as: 'found', prompt: 'Return the highest value as {"value":N}.' },
    { op: 'reduce', from: 'found', as: 'best', query: { $for: { r: '$[*].value' }, $return: '$r.value' } },
    { op: 'answer', from: 'best' },
  ],
};

function corpusText(docs = 6) {
  return Array.from({ length: docs }, (_, d) =>
    Array.from({ length: 4 }, (_, i) =>
      `{"id":"D${d}R${i}","value":${100 + d * 10 + i}}`).join(' ; ')).join('\n');
}

function counting(tokensPerCall = 10) {
  const state = { calls: 0 };
  return {
    state,
    endpoint: { provider: 'openrouter' },
    complete: async ({ messages, responseFormat }) => {
      state.calls += 1;
      if (responseFormat !== undefined) {
        return { message: { content: JSON.stringify(PROGRAM) }, usage: { total_tokens: tokensPerCall } };
      }
      const last = String(messages[messages.length - 1].content);
      const hits = [...last.matchAll(/"value":(\d+)/g)].map((m) => Number(m[1]));
      return {
        message: { content: JSON.stringify({ value: Math.max(...hits, 0) }) },
        usage: { total_tokens: tokensPerCall },
      };
    },
  };
}

async function agentOver(client, extra = {}) {
  const ledger = createLedger();
  const environment = createEnvironment({ ledger, compileQuery: compileJsonQuery });
  await environment.put('corpus', corpusText(), { kind: 'text' });
  return {
    ledger,
    agent: createLongHorizonAgent({
      client,
      environment,
      compileQuery: compileJsonQuery,
      createStructuredOutput,
      createProgramAuthor,
      createProgramRunner,
      createEnvironment,
      maxSubcalls: 500,
      ...extra,
    }),
  };
}

describe('ai — one account, charged at every depth', function () {
  it('counts a call wherever in the tree it happened', async function () {
    const client = counting();
    const { agent } = await agentOver(client, { depth: 2 });
    const result = await agent.run('highest?');

    // the account's turns and the client's calls are the same number:
    // nothing in the tree spends without being charged
    assert.strictEqual(result.spent.turns, client.state.calls,
      `${client.state.calls} calls made, ${result.spent.turns} charged`);
    assert.strictEqual(result.spent.tokens, client.state.calls * 10);
  });

  it('stops the whole tree when the turn budget runs out, at exactly the bound', async function () {
    const client = counting();
    const { agent, ledger } = await agentOver(client, { depth: 2, budget: { turns: 5 } });
    const result = await agent.run('highest?');

    assert.strictEqual(result.stopReason, 'budget-turns');
    assert.strictEqual(client.state.calls, 5, `the tree made ${client.state.calls} calls, not 5`);
    assert.strictEqual(result.spent.turns, 5);
    assert.deepStrictEqual(result.remaining.turns, 0);

    // and the work it DID finish is durable: partial results are in
    // slots, which is what makes a stopped run resumable rather than
    // merely failed
    const partial = (await ledger.listSlots()).filter((s) => /program\/found\/\d+$/.test(s.name));
    assert.ok(partial.length > 0, 'a stopped run left nothing behind to resume from');
  });

  it('stops on tokens, overshooting only by what was already in flight', async function () {
    // one at a time: nobody can be mid-call when the budget crosses
    // except the one that crossed it
    const serial = counting(40);
    const one = await agentOver(serial, {
      depth: 1, budget: { tokens: 100 }, maxConcurrentSubcalls: 1,
    });
    const result = await one.agent.run('highest?');
    assert.strictEqual(result.stopReason, 'budget-tokens');
    assert.strictEqual(serial.state.calls, 3, `serial made ${serial.state.calls} calls`);

    // four at a time: a token cost cannot be known before the reply, so
    // a whole wave can be in flight when the budget crosses. The
    // overshoot is BOUNDED by the fan-out, and that bound is the
    // contract a caller sizes a budget against — it is documented on
    // createBudgetAccount and asserted here.
    const parallel = counting(40);
    const four = await agentOver(parallel, {
      depth: 1, budget: { tokens: 100 }, maxConcurrentSubcalls: 4,
    });
    const wide = await four.agent.run('highest?');
    assert.strictEqual(wide.stopReason, 'budget-tokens');
    assert.ok(parallel.state.calls <= serial.state.calls + 3,
      `fan-out overshot by more than its own width: ${parallel.state.calls} vs ${serial.state.calls}`);
  });

  it('stops on wall-clock, on an injected clock', async function () {
    let now = 1000;
    const client = {
      endpoint: { provider: 'openrouter' },
      complete: async ({ responseFormat }) => {
        now += 500;
        return {
          message: { content: responseFormat === undefined ? '{"value":1}' : JSON.stringify(PROGRAM) },
        };
      },
    };
    const { agent } = await agentOver(client, {
      depth: 1, budget: { ms: 900 }, clock: () => now,
    });
    const result = await agent.run('highest?');
    assert.strictEqual(result.stopReason, 'budget-ms');
  });

  it('a budget that is already spent refuses before the first call', async function () {
    const client = counting();
    const { agent } = await agentOver(client, {
      depth: 1, budget: { turns: 3, spent: { turns: 3 } },
    });
    const result = await agent.run('highest?');

    assert.strictEqual(client.state.calls, 0, 'a spent budget still made a call');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.stopReason, 'budget-turns');
  });

  it('is unbounded only when nobody bounded it', async function () {
    const client = counting();
    const { agent } = await agentOver(client, { depth: 1 });
    const result = await agent.run('highest?');
    assert.strictEqual(result.stopReason, null);
    assert.ok(client.state.calls > 5);
    assert.deepStrictEqual(result.remaining, { turns: null, tokens: null, ms: null });
  });
});

describe('ai — the account itself', function () {
  it('prefers the provider\'s usage and falls back to characters only when asked', function () {
    const reported = createBudgetAccount({ tokens: 1000 }, () => 0);
    reported.settle({ total_tokens: 42 }, 'x'.repeat(4000));
    assert.strictEqual(reported.spent().tokens, 42, 'the estimate overrode a real number');

    const estimated = createBudgetAccount({ tokens: 1000 }, () => 0);
    estimated.settle(null, 'x'.repeat(40));
    assert.strictEqual(estimated.spent().tokens, 10);

    // no token budget means the estimate is never computed: paying for
    // an accounting nobody asked for is how a hot path gets slow
    const untracked = createBudgetAccount({}, () => 0);
    untracked.settle(null, 'x'.repeat(4000));
    assert.strictEqual(untracked.spent().tokens, 0);
  });

  it('adds prompt and completion when no total is reported', function () {
    const account = createBudgetAccount({ tokens: 100 }, () => 0);
    account.settle({ prompt_tokens: 7, completion_tokens: 5 });
    assert.strictEqual(account.spent().tokens, 12);
  });

  it('seeds from a previous run, so a budget survives a reload', function () {
    const account = createBudgetAccount({ turns: 10, spent: { turns: 8 } }, () => 0);
    assert.strictEqual(account.stop(), null);
    // a turn is taken by RESERVING it — settling only accounts tokens,
    // which is what makes the turn bound exact under concurrency
    account.reserve();
    account.reserve();
    assert.strictEqual(account.stop(), 'budget-turns');
  });
});
