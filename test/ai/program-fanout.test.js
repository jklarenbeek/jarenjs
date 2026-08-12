//@ts-check
/**
 * @file `map` — the one step that calls a model, and therefore the only
 * place this package has to bound anything.
 *
 * The RLM paper states its own limitation plainly: its sub-calls are
 * sequential, and "RLMs without asynchronous LM calls are slow". Doing
 * the fan-out in a harness instead of inside an evaluator is what makes
 * concurrency available at all, so this file asserts the three
 * properties that makes true rather than merely faster:
 *
 *  - the bound HOLDS — never more than `maxConcurrentSubcalls` in
 *    flight, measured by the sub-calls themselves;
 *  - an abort reaches the calls already running, and stops new ones from
 *    being launched;
 *  - a sub-call that fails is a RESULT. It lands in its own slot as
 *    `{ error }` and the map finishes, because forty pieces of which one
 *    was unreadable is a finished map with one recorded failure — not a
 *    crashed program.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { createEnvironment, createProgramRunner } from '@jarenjs/ai';
import { compileJsonQuery } from '@jarenjs/json/query';

/** A corpus of `count` records, one per line, each its own piece. */
function lines(count = 12) {
  return Array.from({ length: count }, (_, i) =>
    `{"id":"R${String(i).padStart(4, '0')}","value":${100000 + i * 7}} ${'pad '.repeat(60)}`).join('\n');
}

async function env(count = 12) {
  const environment = createEnvironment();
  await environment.put('corpus', lines(count), { kind: 'text' });
  return environment;
}

/** The pairwise-shaped program: every piece, then combine. */
const PROGRAM = {
  steps: [
    { op: 'chunk', from: 'corpus', as: 'pieces', strategy: 'line', size: 200 },
    { op: 'map', from: 'pieces', as: 'found', prompt: 'read it' },
    { op: 'reduce', from: 'found', as: 'values', query: { $for: { r: '$[*].value' }, $return: '$r.value' } },
    { op: 'answer', from: 'values' },
  ],
};

/**
 * A sub-call that takes `delayMs` and reports the high-water mark of how
 * many were running at once. The count is taken by the calls themselves,
 * so it measures the runner's scheduling and not the test's idea of it.
 * @param {{ delayMs?: number, fail?: (index: number) => any }} [options]
 */
function measuringClient(options = {}) {
  const delayMs = options.delayMs ?? 5;
  const state = { calls: 0, peak: 0, inFlight: 0, signals: /** @type {any[]} */ ([]) };
  return {
    state,
    complete: async ({ messages, signal }) => {
      const index = state.calls++;
      state.signals.push(signal);
      state.inFlight += 1;
      state.peak = Math.max(state.peak, state.inFlight);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      state.inFlight -= 1;
      const forced = options.fail?.(index);
      if (forced !== undefined) return forced;
      const piece = String(messages[messages.length - 1].content);
      const hit = /"id":"(R\d+)","value":(\d+)/.exec(piece);
      return {
        message: {
          content: hit === null ? 'null' : JSON.stringify({ id: hit[1], value: Number(hit[2]) }),
        },
      };
    },
  };
}

/** A sub-call that never answers until the run is aborted. */
function hangingClient() {
  const state = { started: /** @type {any[]} */ ([]) };
  return {
    state,
    complete: ({ signal }) => new Promise((resolve, reject) => {
      state.started.push(signal);
      if (signal?.aborted === true) { reject(new Error('aborted')); return; }
      signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }),
  };
}

const runnerOver = async (client, options = {}) => createProgramRunner({
  environment: options.environment ?? await env(),
  client,
  compileQuery: compileJsonQuery,
  ...options,
});

describe('ai — map is bounded', function () {
  it('never runs more sub-calls at once than it was allowed', async function () {
    const client = measuringClient();
    const run = await runnerOver(client, { maxConcurrentSubcalls: 3 });
    const result = await run.run(PROGRAM);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(client.state.calls, 12);
    assert.strictEqual(client.state.peak, 3,
      `peak concurrency was ${client.state.peak}, not the 3 asked for`);
    assert.strictEqual(result.concurrency, 3, 'the report did not state what it used');
  });

  it('runs one at a time when told to, through the same code path', async function () {
    const client = measuringClient();
    const run = await runnerOver(client, { sequential: true });
    const result = await run.run(PROGRAM);

    assert.strictEqual(client.state.peak, 1);
    assert.strictEqual(result.concurrency, 1);
    assert.strictEqual(result.subcalls, 12);
  });

  it('is faster in parallel than in sequence — the paper\'s limitation, measured', async function () {
    const slow = 20;
    const sequentialClient = measuringClient({ delayMs: slow });
    const sequential = await (await runnerOver(sequentialClient, { sequential: true })).run(PROGRAM);
    const parallelClient = measuringClient({ delayMs: slow });
    const parallel = await (await runnerOver(parallelClient, { maxConcurrentSubcalls: 4 })).run(PROGRAM);

    assert.strictEqual(sequentialClient.state.calls, parallelClient.state.calls,
      'the two runs did not do the same work');
    assert.ok(parallel.ms < sequential.ms,
      `parallel ${parallel.ms}ms was not faster than sequential ${sequential.ms}ms`);
    // twelve pieces at concurrency four is three waves against twelve —
    // asserted at half the theoretical gain so a loaded machine cannot
    // make a real property look flaky
    assert.ok(sequential.ms / parallel.ms >= 2,
      `parallel was only ${(sequential.ms / parallel.ms).toFixed(1)}× faster`);
  });

  it('stops at maxSubcalls and says how many pieces it did not visit', async function () {
    const client = measuringClient();
    const run = await runnerOver(client, { maxSubcalls: 5 });
    const result = await run.run(PROGRAM);

    assert.strictEqual(client.state.calls, 5);
    const map = result.steps.find((s) => s.op === 'map');
    assert.strictEqual(map.subcalls, 5);
    assert.strictEqual(map.skipped, 7);
    // a cap that said nothing would read as a map over everything
    assert.match(map.note, /maxSubcalls/);
  });

  it('shows a sub-call one piece, never the corpus (D2)', async function () {
    const seen = [];
    const client = {
      complete: async ({ messages }) => {
        seen.push(String(messages[messages.length - 1].content));
        return { message: { content: 'null' } };
      },
    };
    const run = await runnerOver(client);
    await run.run(PROGRAM);

    assert.strictEqual(seen.length, 12);
    for (const payload of seen) {
      const ids = payload.match(/"id":"R\d+"/g) ?? [];
      assert.strictEqual(ids.length, 1, 'a sub-call was shown more than its own piece');
    }
  });
});

describe('ai — an aborted run stops, and keeps what it had', function () {
  it('cancels the sub-calls already in flight and launches no more', async function () {
    const client = hangingClient();
    const run = await runnerOver(client, { maxConcurrentSubcalls: 4 });
    const controller = new AbortController();

    const running = run.run(PROGRAM, { signal: controller.signal });
    // let the first wave reach the client
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.strictEqual(client.state.started.length, 4,
      'more than the bound was launched before the abort');
    controller.abort();
    const result = await running;

    assert.strictEqual(result.stopped, 'aborted');
    assert.strictEqual(result.ok, false);
    // the signal each sub-call was handed is the run's own, and it is
    // aborted — cancellation asserted, not inferred from timing
    assert.strictEqual(client.state.started.length, 4, 'a sub-call started after the abort');
    for (const signal of client.state.started) {
      assert.strictEqual(signal, controller.signal);
      assert.strictEqual(signal.aborted, true);
    }
    // the chunk step ran and its work is still there
    assert.strictEqual(result.steps[0].op, 'chunk');
    assert.strictEqual(result.steps[0].count, 12);
  });

  it('refuses to start at all when handed an already-aborted signal', async function () {
    const client = measuringClient();
    const run = await runnerOver(client);
    const controller = new AbortController();
    controller.abort();

    const result = await run.run(PROGRAM, { signal: controller.signal });
    assert.strictEqual(result.stopped, 'aborted');
    assert.strictEqual(client.state.calls, 0);
    assert.deepStrictEqual(result.steps, []);
  });
});

describe('ai — a failed sub-call is a result', function () {
  it('records the failure in its own slot and finishes the map', async function () {
    const environment = await env();
    const client = measuringClient({
      fail: (index) => (index === 3 ? { message: { content: 'not json at all' } } : undefined),
    });
    const run = await runnerOver(client, { environment });
    const result = await run.run(PROGRAM);

    assert.strictEqual(result.ok, true, 'one bad reply failed the whole program');
    assert.strictEqual(result.subcalls, 12);
    assert.strictEqual(result.failed, 1);
    const map = result.steps.find((s) => s.op === 'map');
    assert.strictEqual(map.failed, 1);

    // the failure is stored where its piece's result would have been,
    // so a reader can see WHICH piece has no answer
    const slots = (await environment.ledger.listSlots()).map((s) => s.name);
    assert.ok(slots.includes('program/found/3'));
    const stored = JSON.parse(String(await environment.ledger.readSlot('program/found/3')));
    assert.match(stored.error, /not JSON/);
    assert.ok(stored.raw.length > 0, 'the failure kept none of the reply to diagnose from');
  });

  it('completes even when every sub-call fails, and says so', async function () {
    const client = measuringClient({ fail: () => { throw new Error('the provider said no'); } });
    const run = await runnerOver(client);
    const result = await run.run(PROGRAM);

    // a map whose sub-calls all failed is a finished map, and the reduce
    // over its (empty) findings is a real, if unhelpful, answer
    assert.strictEqual(result.subcalls, 12);
    assert.strictEqual(result.failed, 12);
    assert.strictEqual(result.ok, true);
  });

  it('does not let a sub-call\'s own error masquerade as a cancellation', async function () {
    const client = measuringClient({ fail: () => { throw new Error('boom'); } });
    const run = await runnerOver(client);
    const result = await run.run(PROGRAM, { signal: new AbortController().signal });
    assert.strictEqual(result.stopped, undefined);
    assert.strictEqual(result.failed, 12);
  });
});
