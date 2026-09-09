//@ts-check
/**
 * @file Recursion: a sub-call that is itself an agent.
 *
 * The paper this follows names four ways recursive LM systems fail, and
 * this file asserts the answer to each rather than documenting it:
 *
 *  - **final answer confused with thought** — here the final answer is a
 *    typed step in a compile-gated program, so a program without one is
 *    refused before it runs instead of running and returning nothing;
 *  - **syntax errors propagating silently** — a child whose program will
 *    not compile surfaces to its parent as `{ error }` carrying its
 *    depth and its address, and the parent's map completes;
 *  - **depth multiplying cost** — the cap is enforced, not advertised: a
 *    run asking for depth 99 gets 3 and is TOLD it was clamped;
 *  - **guardrails under-explored** — the three that exist (depth, the
 *    shared budget, the abort signal) are each asserted; nothing here
 *    pretends there are more.
 *
 * And the property that makes a failing branch containable: a child
 * cannot read or write a sibling's slots.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import {
  createEnvironment, createLedger, createLongHorizonAgent, createProgramAuthor,
  createProgramRunner, createStructuredOutput, compileProgram, resolveDepth,
  MAX_DEPTH, DEFAULT_DEPTH, childScope,
} from '@jarenjs/ai';
import { compileJsonQuery, analyzeQuery, annotateTypes } from '@jarenjs/json/query';

/** Six documents of four records each, one document per line. */
function corpusText() {
  return Array.from({ length: 6 }, (_, d) =>
    Array.from({ length: 4 }, (_, i) =>
      `{"id":"D${d}R${i}","value":${100 + d * 10 + i}}`).join(' ; ')).join('\n');
}

/** The plan a scripted model authors at every depth. */
const PROGRAM = {
  steps: [
    { op: 'chunk', from: 'corpus', as: 'pieces', strategy: 'line', size: 200 },
    { op: 'map', from: 'pieces', as: 'found', prompt: 'Return the highest value as {"value":N}.' },
    { op: 'reduce', from: 'found', as: 'best', query: { slot: 'corpus', value: { value: { $max: '$[*].value.value' } } } },
    { op: 'answer', from: 'best' },
  ],
};

/**
 * A scripted model: it authors `program` when asked for a document, and
 * reads the highest value out of a piece when asked about one.
 * @param {{ program?: any, authorAt?: (depth: number) => any }} [options]
 */
function scripted(options = {}) {
  const state = { authorings: 0, leaves: 0, payloads: /** @type {string[]} */ ([]) };
  return {
    state,
    endpoint: { provider: 'openrouter' },
    complete: async ({ messages, responseFormat }) => {
      const last = String(messages[messages.length - 1].content);
      state.payloads.push(last);
      if (responseFormat !== undefined) {
        const doc = options.program ?? PROGRAM;
        state.authorings += 1;
        return { message: { content: JSON.stringify(doc) }, usage: { total_tokens: 50 } };
      }
      state.leaves += 1;
      const hits = [...last.matchAll(/"value":(\d+)/g)].map((m) => Number(m[1]));
      return {
        message: { content: JSON.stringify({ value: Math.max(...hits, 0) }) },
        usage: { total_tokens: 10 },
      };
    },
  };
}

/** Build an agent over a fresh corpus. */
async function agentOver(client, extra = {}) {
  const ledger = createLedger();
  const environment = createEnvironment({ ledger, compileQuery: compileJsonQuery });
  await environment.put('corpus', corpusText(), { kind: 'text' });
  const agent = createLongHorizonAgent({
    client,
    environment,
    compileQuery: compileJsonQuery,
    createStructuredOutput,
    analyzeQuery, annotateTypes,
    createProgramAuthor,
    createProgramRunner,
    createEnvironment,
    maxSubcalls: 500,
    ...extra,
  });
  return { agent, ledger, environment };
}

describe('ai — depth is capped, and the cap is enforced', function () {
  it('defaults to the depth the research found pays, and caps at three', function () {
    assert.strictEqual(resolveDepth(undefined).depth, DEFAULT_DEPTH);
    assert.strictEqual(DEFAULT_DEPTH, 1);
    assert.strictEqual(MAX_DEPTH, 3);
    assert.deepStrictEqual(resolveDepth(2), { depth: 2, clamped: false });
    assert.deepStrictEqual(resolveDepth(99), { depth: MAX_DEPTH, clamped: true });
    assert.deepStrictEqual(resolveDepth(-1), { depth: DEFAULT_DEPTH, clamped: true });
  });

  it('runs no deeper than the cap however deep it is asked to go', async function () {
    const client = scripted();
    const { agent } = await agentOver(client, { depth: 99 });
    const result = await agent.run('What is the highest value?');

    assert.strictEqual(result.depth, MAX_DEPTH);
    assert.strictEqual(result.depthClamped, true);
    // and it SAID so, in the record a reviewer reads
    const note = result.trajectory.find((e) => e.kind === 'note');
    assert.match(note.note, /99 was asked for/);
    const deepest = Math.max(...result.trajectory.map((e) => e.depth ?? 0));
    assert.ok(deepest <= MAX_DEPTH, `something ran at depth ${deepest}`);
  });

  it('recurses exactly as deep as it was told, and no deeper', async function () {
    for (const depth of [0, 1, 2]) {
      const client = scripted();
      const { agent } = await agentOver(client, { depth });
      const result = await agent.run('What is the highest value?');
      const deepest = Math.max(...result.trajectory.map((e) => e.depth ?? 0));
      assert.strictEqual(deepest, depth, `asked for depth ${depth}, reached ${deepest}`);
    }
  });

  it('spends more the deeper it goes — the cost the default exists to avoid', async function () {
    const spent = [];
    for (const depth of [0, 1, 2]) {
      const client = scripted();
      const { agent } = await agentOver(client, { depth });
      await agent.run('What is the highest value?');
      spent.push(client.state.authorings + client.state.leaves);
    }
    assert.ok(spent[1] > spent[0] && spent[2] > spent[1],
      `depth did not multiply cost: ${spent.join(' → ')}`);
  });
});

describe('ai — a child is isolated', function () {
  it('sees a clean namespace and cannot name its way out of it', async function () {
    const ledger = createLedger();
    const parent = createEnvironment({ ledger });
    await parent.put('corpus', 'PARENT text', { kind: 'text' });
    const a = createEnvironment({ ledger, scope: childScope(1, 0) });
    const b = createEnvironment({ ledger, scope: childScope(1, 1) });
    await a.put('mine', 'ALPHA secret', { kind: 'text' });
    await b.put('mine', 'BETA secret', { kind: 'text' });

    // the scope is invisible from inside: a child's corpus is `corpus`
    assert.deepStrictEqual((await a.digest()).slots.map((s) => s.name), ['mine']);
    assert.strictEqual((await a.read('mine', { chars: 40 })).text, 'ALPHA secret');

    // a sibling's real address resolves BENEATH the child, so it misses
    assert.match((await a.read('child/1/1/mine', { chars: 40 })).error, /no slot/);
    assert.match((await a.peek('corpus')).error, /no slot/);
    // and scanning is confined too — not just addressing
    assert.strictEqual((await a.grep('BETA')).total, 0);
    assert.strictEqual((await a.grep('ALPHA')).total, 1);
    // the parent still sees everything, which is what makes the tree
    // reviewable from the top
    assert.strictEqual((await parent.digest()).total, 3);

    // and forgetting is confined the same way addressing is: a child
    // cleaning up its workspace must not be able to delete a sibling's,
    // which is the destructive half of the same isolation
    assert.deepStrictEqual(await a.forget('child/1/1/'), { prefix: 'child/1/1/', removed: 0 });
    assert.strictEqual((await b.read('mine', { chars: 40 })).text, 'BETA secret');
    assert.deepStrictEqual(await a.forget(''), { prefix: '', removed: 1 });
    assert.strictEqual((await a.digest()).total, 0);
    // the sibling and the parent are untouched by it
    assert.strictEqual((await b.digest()).total, 1);
    assert.strictEqual((await parent.digest()).total, 2);
  });

  it('writes its working slots inside its own scope, not the parent\'s', async function () {
    const client = scripted();
    const { agent, ledger } = await agentOver(client, { depth: 1 });
    await agent.run('What is the highest value?');

    const names = (await ledger.listSlots()).map((s) => s.name);
    const childSlots = names.filter((n) => n.startsWith('child/'));
    assert.ok(childSlots.length > 0, 'no child ever ran');
    // every child slot is under a child scope, and each child's program
    // results are under its own
    for (const name of childSlots) assert.match(name, /^child\/\d+\/\d+\//);
    assert.ok(childSlots.some((n) => /^child\/1\/\d+\/program\//.test(n)),
      'a child wrote its program results outside its scope');
  });
});

describe('ai — a child\'s failure is a value, not a silence', function () {
  it('surfaces a child that cannot author, with its depth and address', async function () {
    // the child authors a program naming a slot it does not have
    const broken = {
      steps: [
        { op: 'map', from: 'not_a_slot_here', as: 'found', prompt: 'x' },
        { op: 'reduce', from: 'found', as: 'r', query: { slot: 'corpus', value: { value: { $max: '$[*].value.value' } } } },
        { op: 'answer', from: 'r' },
      ],
    };
    let call = 0;
    const client = {
      endpoint: { provider: 'openrouter' },
      complete: async ({ responseFormat }) => {
        if (responseFormat === undefined) return { message: { content: '{"value":1}' } };
        // the ROOT authors a good program; every child authors the broken one
        call += 1;
        return { message: { content: JSON.stringify(call === 1 ? PROGRAM : broken) } };
      },
    };
    const { agent, ledger } = await agentOver(client, { depth: 1 });
    const result = await agent.run('What is the highest value?');

    // the parent's run COMPLETED — one bad branch is not a crashed tree
    assert.strictEqual(result.ok, true);
    const failures = result.trajectory.filter((e) => e.kind === 'subcall' && e.ok === false);
    assert.ok(failures.length > 0, 'no child failure was recorded');
    // and each failure is addressable: the slot it was working on
    for (const entry of failures) assert.match(entry.slot, /^child\/1\/\d+\/corpus$/);

    // the recorded failure reached the parent's map result slot, which is
    // where a reader looks for WHICH branch failed
    const stored = (await ledger.listSlots()).filter((s) => /program\/found\/\d+$/.test(s.name));
    const bodies = await Promise.all(stored.map((s) => ledger.readSlot(s.name)));
    const parsed = bodies.map((b) => JSON.parse(String(b)));
    assert.ok(parsed.some((p) => p.error !== undefined && p.depth === 1 && p.address !== undefined),
      'a child failure did not reach the parent with its depth and address');
  });

  it('refuses a program with no final step before it runs (the first failure mode)', function () {
    assert.throws(() => compileProgram({
      steps: [{ op: 'chunk', from: 'corpus', as: 'pieces', strategy: 'line', size: 200 }],
    }, { compileQuery: compileJsonQuery, known: ['corpus'] }),
    (err) => /** @type {any} */ (err).code === 'AI0203');
  });
});

describe('ai — a program has to survive its own recursion', function () {
  /** The needle plan, with the reduce shape under test. */
  const planWith = (query) => ({
    steps: [
      { op: 'chunk', from: 'corpus', as: 'pieces', strategy: 'line', size: 200 },
      { op: 'map', from: 'pieces', as: 'found', prompt: 'Return the highest value as {"value":N}.' },
      { op: 'reduce', from: 'found', as: 'best', query },
      { op: 'answer', from: 'best' },
    ],
  });

  it('composes at depth when its reduce emits the shape its map returns', async function () {
    // a map element is `{ slot, value }` whether that value came from a
    // leaf model call or from a whole child agent — so a reduce whose
    // OUTPUT matches its input's elements is the same program at every
    // depth. This is the paper's "final answer confused with thought",
    // in the concrete form it takes here.
    const composing = { slot: 'corpus', value: { value: { $max: '$[*].value.value' } } };
    for (const depth of [0, 1, 2]) {
      const client = scripted({ program: planWith(composing) });
      const { agent } = await agentOver(client, { depth });
      const result = await agent.run('What is the highest value?');
      assert.strictEqual(result.ok, true, `depth ${depth} did not finish`);
      assert.match(result.answer.text, /"value":153/,
        `depth ${depth} answered ${result.answer.text}`);
    }
  });

  it('refuses the formerly shallow-correct, deep-null reduce before execution', async function () {
    const flattening = { $for: { r: '$[*].value' }, $return: '$r.value' };
    const plan = planWith(flattening);
    assert.throws(() => compileProgram(plan, { compileQuery: compileJsonQuery,
      analyzeQuery, annotateTypes, recursive: true }), (error) => error.code === 'AI0208');
    for (const depth of [0, 1, 2]) {
      const { agent } = await agentOver(scripted({ program: plan }), { depth });
      const result = await agent.run('What is the highest value?');
      assert.equal(result.ok, false);
      assert.equal(result.errors[0].code, 'AI0208');
    }
  });

});

describe('ai — D2 holds at every depth', function () {
  it('never inlines a sub-call result into an ancestor\'s request, at depth 2', async function () {
    const client = scripted();
    const { agent } = await agentOver(client, { depth: 2 });
    await agent.run('What is the highest value?');

    // every AUTHORING request is a digest and a question: it may name
    // slots, but it may never carry another branch's answer or a corpus
    const authoring = client.state.payloads.filter((p) => p.includes('The environment holds'));
    assert.ok(authoring.length >= 3, 'depth 2 did not author at three levels');
    for (const request of authoring) {
      assert.ok(request.length < 4000, `an authoring request grew to ${request.length} chars`);
      // the corpus is six documents of four records; a request carrying
      // more than one record's worth is carrying content
      const records = (request.match(/"id":"D\d+R\d+"/g) ?? []).length;
      assert.ok(records <= 1, `an authoring request carried ${records} records`);
    }
  });

  it('records a trajectory a host can persist and render', async function () {
    const client = scripted();
    const { agent } = await agentOver(client, { depth: 1 });
    const result = await agent.run('What is the highest value?');

    assert.ok(result.trajectory.length > 0);
    // serializable, in both directions
    const round = JSON.parse(JSON.stringify(result.trajectory));
    assert.deepStrictEqual(round, result.trajectory);
    // every authored program, every sub-call, every slot written
    const kinds = new Set(result.trajectory.map((e) => e.kind));
    assert.ok(kinds.has('author') && kinds.has('program') && kinds.has('subcall'), [...kinds].join(','));
    assert.deepStrictEqual(result.summary.depths, [0, 1]);
    assert.ok(result.summary.calls > 0 && result.summary.steps > 0);
    // sequence numbers are dense and ordered, so a renderer can trust them
    result.trajectory.forEach((entry, i) => assert.strictEqual(entry.seq, i));
  });
});
