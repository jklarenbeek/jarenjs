//@ts-check
/**
 * @file D4 as an assertion: nothing leaves a request without a
 * recoverable copy.
 *
 * The baseline this campaign measured had a specific, nasty failure
 * mode. At a small history budget the synopsis kept 15 of 40 record ids
 * and only 7 of their values — it remembered that `fetch_record` had
 * been called and returned a `REC0007`, and lost what the record said.
 * That is worse than forgetting cleanly: a model can see the label and
 * answer confidently from a record it no longer has.
 *
 * So the claim being tested here is not "usually recoverable" and not
 * "recoverable at the budget we tried". It is that the gap between the
 * id column and the value column is ZERO — every fact the full
 * transcript ever held is either still in the request verbatim or
 * reachable through an address the request names — at every budget the
 * benchmark sweeps, in both payload shapes. A failure at any one of them
 * is a failure of the order.
 *
 * The reachability walk is the benchmark's (`benchmark/lib/horizon.js`),
 * used here rather than reimplemented: the number this file asserts and
 * the number the benchmark publishes have to come from one piece of
 * code, or one of them will eventually be wrong in a way the other
 * cannot see.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { createAgent, createLedger, slotAddressesIn } from '@jarenjs/ai';

import {
  DEFAULTS, SHAPES, makeCorpus, probe, reachable, retentionIn,
} from '../../benchmark/lib/horizon.js';

const SHAPE_KEYS = /** @type {const} */ (['front', 'late']);

/** The size accounting compaction itself does: per message, summed. */
const wireSize = (messages) => messages.reduce((n, m) => n + JSON.stringify(m).length, 0);

describe('ai — compaction moves instead of destroying (D4)', function () {
  it('every fact is recoverable at every benchmark budget, in both payload shapes', async function () {
    const corpus = makeCorpus({});
    for (const shape of SHAPE_KEYS) {
      for (const budget of DEFAULTS.budgets) {
        const ledger = createLedger();
        const result = await probe({ corpus, budget, shape, ledger });
        const where = `${shape}@${budget}`;

        const reached = await reachable(result.messages, ledger);
        const counts = retentionIn(reached.text, corpus);
        assert.strictEqual(counts.valuePresent, corpus.n,
          `${where}: ${counts.valuePresent}/${corpus.n} record values recoverable — ${SHAPES[shape]}`);
        assert.strictEqual(counts.idPresent, corpus.n, `${where}: an id went missing`);

        // the id-vs-value gap, stated as the campaign states it
        assert.strictEqual(counts.idPresent - counts.valuePresent, 0,
          `${where}: the request names records whose values cannot be recovered`);

        // and every address it names answers — a synopsis that promised
        // an address nothing returns would pass the count above by luck
        // of some other line and still be a broken promise
        for (const name of slotAddressesIn(reached.text)) {
          const content = await ledger.readSlot(name);
          assert.ok(content !== undefined && content !== null,
            `${where}: the request names slot '${name}', which answers nothing`);
        }
      }
    }
  });

  it('the character budget still holds, addresses and all, at every benchmark budget', async function () {
    const corpus = makeCorpus({});
    for (const shape of SHAPE_KEYS) {
      for (const budget of DEFAULTS.budgets) {
        const result = await probe({ corpus, budget, shape, ledger: createLedger() });
        const size = wireSize(result.messages);
        assert.ok(size <= budget,
          `${shape}@${budget}: the request is ${size} characters, over its own budget`);
      }
    }
  });

  it('a synopsis truncated to fit still carries the way back to everything it cut', async function () {
    // budgets small enough that the addressed synopsis cannot be written
    // in full: the per-round addresses go, and what has to survive is the
    // header — which names the index that lists every one of them
    const corpus = makeCorpus({ n: 12 });
    for (const budget of [1600, 1200]) {
      const ledger = createLedger();
      const result = await probe({ corpus, budget, shape: 'late', ledger });
      const synopsis = result.messages.find((m) => typeof m.content === 'string'
        && m.content.startsWith('[Earlier context'));
      assert.ok(synopsis !== undefined, `${budget}: no synopsis`);
      assert.match(synopsis.content, /… \[truncated\]$/,
        `${budget}: this case is only meaningful while the synopsis IS truncated`);

      const addresses = slotAddressesIn(synopsis.content);
      assert.ok(addresses.length >= 1, `${budget}: the header's index address was cut away`);
      const counts = retentionIn((await reachable(result.messages, ledger)).text, corpus);
      assert.strictEqual(counts.valuePresent, corpus.n,
        `${budget}: a truncated synopsis lost ${corpus.n - counts.valuePresent} record(s)`);
      assert.ok(wireSize(result.messages) <= budget, `${budget}: over budget`);
    }
  });

  it('below the pinned minimum the request is the smallest legal one — and still recoverable', async function () {
    // A budget can be asked for that no legal request fits into: the
    // first user turn, the last tool round and a synopsis with something
    // in it have a floor, and a compaction that undercut it would answer
    // with a wire-illegal request instead of an oversized one. That floor
    // is not new — the ledger-free path has always had it, and at these
    // budgets it lands within a few characters of this one. What is new
    // is that the rounds it could not carry are still there.
    const corpus = makeCorpus({ n: 12 });
    for (const budget of [900, 700, 400]) {
      const ledger = createLedger();
      const result = await probe({ corpus, budget, shape: 'late', ledger });
      const bare = await probe({ corpus, budget, shape: 'late' });
      const size = wireSize(result.messages);
      assert.ok(size > budget, `${budget}: this case is about the floor, and nothing overflowed`);
      assert.ok(size <= wireSize(bare.messages) + 64,
        `${budget}: the addresses cost ${size - wireSize(bare.messages)} characters at the floor`);
      const counts = retentionIn((await reachable(result.messages, ledger)).text, corpus);
      assert.strictEqual(counts.valuePresent, corpus.n,
        `${budget}: the floor is where a fact would be lost, and one was`);
    }
  });

  it('compacting the same history twice writes the same slots and does not duplicate them', async function () {
    const corpus = makeCorpus({ n: 10 });
    const ledger = createLedger();
    const first = await probe({ corpus, budget: 3000, shape: 'late', ledger });
    const after = (await ledger.listSlots()).map((s) => s.name).sort();
    assert.ok(after.length > 0, 'nothing was archived, so nothing is being asserted');

    // the same run again, against the same ledger: content-addressed
    // names mean the second pass recognises every round it already holds
    const second = await probe({ corpus, budget: 3000, shape: 'late', ledger });
    const again = (await ledger.listSlots()).map((s) => s.name).sort();
    assert.deepStrictEqual(again, after, 'a re-compaction wrote a second copy of a round');
    assert.deepStrictEqual(
      first.messages.map((m) => m.content), second.messages.map((m) => m.content),
      'the same history compacts to the same request, addresses included');

    // and a store that is asked to write nothing new, writes nothing new
    /** @type {string[]} */
    const writes = [];
    const watched = {
      putSlot: (/** @type {string} */ name, /** @type {string} */ content, meta) => {
        writes.push(name);
        return ledger.putSlot(name, content, meta);
      },
      getSlot: (/** @type {string} */ name) => ledger.getSlot(name),
      readSlot: (/** @type {string} */ name) => ledger.readSlot(name),
    };
    await probe({ corpus, budget: 3000, shape: 'late', ledger: watched });
    assert.deepStrictEqual(writes, [], 'idempotence has to be free, not just correct');
  });

  it('a round the synopsis has nothing to say about still gets an address', async function () {
    // an assistant turn with an EMPTY tool_calls array: the agent loop
    // never writes one, but a host's persisted transcript can carry one
    // from a provider that did, and it is exactly the round a
    // line-per-tool-call writer says nothing about. Nothing leaves
    // unaddressed means nothing, including this.
    /** @type {any[][]} */
    const wires = [];
    const client = {
      complete: async ({ messages }) => {
        wires.push(messages);
        return { message: { role: 'assistant', content: 'ok', toolCalls: null }, finishReason: 'stop' };
      },
    };
    const history = [{ role: 'user', content: 'go' }];
    for (let i = 0; i < 6; i++) {
      history.push({ role: 'assistant', content: `turn ${i}`, tool_calls: [] });
      history.push({ role: 'user', content: `filler ${i} ${'y'.repeat(200)}` });
    }
    const ledger = createLedger();
    await createAgent({ client: /** @type {any} */ (client), historyBudget: 900, ledger })
      .send(history);
    const synopsis = wires[0].find((m) => typeof m.content === 'string'
      && m.content.startsWith('[Earlier context'));
    const addresses = slotAddressesIn(synopsis.content);
    const rounds = (await ledger.listSlots()).filter((s) => s.kind === 'agent-round');
    assert.ok(rounds.length > 0, 'nothing was archived, so nothing is being asserted');
    // every archived round is named — directly, or by the index that is
    assert.ok(addresses.length >= 1);
    const reached = await reachable(wires[0], ledger);
    for (const slot of rounds) {
      assert.ok(reached.slots.includes(slot.name),
        `round ${slot.name} was archived but nothing in the request leads to it`);
    }
  });

  it('the returned transcript stays full, and the ledger holds the parts the request lost', async function () {
    const corpus = makeCorpus({ n: 8 });
    const ledger = createLedger();
    /** @type {any[][]} */
    const wires = [];
    const client = {
      complete: async ({ messages }) => {
        wires.push(messages);
        return { message: { role: 'assistant', content: 'ok', toolCalls: null }, finishReason: 'stop' };
      },
    };
    const history = [{ role: 'user', content: 'go' }];
    for (let i = 0; i < corpus.n; i++) {
      history.push({ role: 'assistant', content: '', tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'fetch_record', arguments: JSON.stringify({ index: i }) } }] });
      history.push({ role: 'tool', tool_call_id: `c${i}`, name: 'fetch_record', content: JSON.stringify({ id: corpus.ids[i], notes: 'x'.repeat(300), value: corpus.values[i] }) });
    }
    const agent = createAgent({
      client: /** @type {any} */ (client), historyBudget: 1500, ledger,
    });
    const result = await agent.send(history);

    assert.strictEqual(result.messages.length, history.length + 1,
      'the transcript a host persists is never the compacted one');
    assert.ok(wires[0].length < result.messages.length, 'this case needs a real cut');
    const counts = retentionIn((await reachable(wires[0], ledger)).text, corpus);
    assert.strictEqual(counts.valuePresent, corpus.n);
  });
});
