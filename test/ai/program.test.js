//@ts-check
/**
 * @file The action language: the grammar, the compile gate, and the rule
 * that a program which does not compile never runs.
 *
 * Two claims are asserted here that cannot be asserted by reading the
 * code:
 *
 *  - **No step can inline slot content** (D2). Not "no step does" — the
 *    grammar is walked and every member of every step is checked to be
 *    an operation name, a binding, a bounded instruction or a query, so
 *    a step type added later cannot quietly grow a `content` member and
 *    put the corpus back in the request.
 *  - **A rejected program leaves nothing behind.** The environment is
 *    counted before and after a program that fails its gate, and the two
 *    counts are equal. A compiler that half-ran a bad program would make
 *    "compile-gated" a description of intent rather than of behaviour.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import {
  createEnvironment, createProgramRunner, createProgramAuthor, createStructuredOutput,
  compileProgram, programGate, PROGRAM_SCHEMA, PROGRAM_OPS, MAX_PROGRAM_CHARS, PROGRAM_EXAMPLE,
} from '@jarenjs/ai';
import { compileJsonQuery } from '@jarenjs/json/query';
import querySchema from '@jarenjs/json/schemas/jaren-query.llm-profile.schema.json' with { type: 'json' };

import {
  makeCorpus, pairwiseProgram, needleProgram, programProbe, corpusText,
  ceilingFor, scorePairwise, CLOSEST_PAIR_QUERY,
} from '../../benchmark/lib/horizon.js';

/** A corpus of `count` records, one per line, each its own piece. Ids
 * and values are fixed-width so every line is the same length and a
 * corpus a hundred times longer is exactly a hundred times bigger. */
function lines(count = 12) {
  return Array.from({ length: count }, (_, i) =>
    `{"id":"R${String(i).padStart(4, '0')}","value":${100000 + i * 7}} ${'pad '.repeat(60)}`).join('\n');
}

/** An environment holding one corpus slot. */
async function env(text = lines()) {
  const environment = createEnvironment();
  await environment.put('corpus', text, { kind: 'text' });
  return environment;
}

/** A sub-call that returns the record in the piece it was given. */
function extracting() {
  const seen = [];
  return {
    seen,
    complete: async ({ messages }) => {
      const piece = String(messages[messages.length - 1].content);
      seen.push(piece);
      const hit = /"id":"(R\d+)","value":(\d+)/.exec(piece);
      return {
        message: {
          content: hit === null ? 'null' : JSON.stringify({ id: hit[1], value: Number(hit[2]) }),
        },
      };
    },
  };
}

const runner = async (options = {}) => createProgramRunner({
  environment: options.environment ?? await env(),
  client: options.client ?? extracting(),
  compileQuery: compileJsonQuery,
  ...options,
});

describe('ai — the program grammar cannot carry content (D2)', function () {
  const branches = PROGRAM_SCHEMA.properties.steps.items.anyOf;

  it('names every operation the runner implements, and no others', function () {
    assert.deepStrictEqual(branches.map((b) => b.properties.op.const).sort(),
      [...PROGRAM_OPS].sort());
  });

  it('closes every step and bounds every string it accepts', function () {
    // the allow-list IS the D2 argument: an operation, a binding, a slot
    // reference, a bounded instruction, a bounded pattern, small option
    // scalars, and one query document — nothing a corpus fits in
    const allowed = new Set(['op', 'from', 'as', 'prompt', 'pattern', 'flags',
      'limit', 'strategy', 'size', 'query', 'chars', 'outputSchema']);
    for (const branch of branches) {
      const op = branch.properties.op.const;
      assert.strictEqual(branch.additionalProperties, false,
        `step ${op} accepts members nobody declared`);
      for (const [name, member] of Object.entries(branch.properties)) {
        assert.ok(allowed.has(name), `step ${op} declares an undeclared member ${name}`);
        if (/** @type {any} */ (member).type === 'string') {
          assert.ok(typeof (/** @type {any} */ (member).maxLength) === 'number',
            `${op}.${name} is an unbounded string — that is where a corpus gets in`);
        }
      }
    }
  });

  it('refuses a step that carries a payload, however it is spelled', async function () {
    const run = await runner();
    const result = await run.run({
      steps: [
        { op: 'map', from: 'corpus', as: 'found', prompt: 'x', content: lines() },
        { op: 'answer', from: 'found' },
      ],
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.ran, 0);
  });

  it('caps the whole document, so a query cannot become the payload', function () {
    const fat = {
      steps: [
        { op: 'select', from: 'corpus', as: 'x', query: { $const: 'y'.repeat(MAX_PROGRAM_CHARS) } },
        { op: 'answer', from: 'x' },
      ],
    };
    assert.throws(() => compileProgram(fat, { compileQuery: compileJsonQuery }),
      (err) => /** @type {any} */ (err).code === 'AI0205');
  });
});

describe('ai — the compile gate', function () {
  const compile = (steps, options = {}) =>
    compileProgram({ steps }, { compileQuery: compileJsonQuery, ...options });

  it('accepts a plan whose every input was produced or declared', function () {
    const plan = compile([
      { op: 'chunk', from: 'corpus', as: 'pieces', strategy: 'line', size: 200 },
      { op: 'map', from: 'pieces', as: 'found', prompt: 'read it' },
      { op: 'reduce', from: 'found', as: 'answer_', query: CLOSEST_PAIR_QUERY },
      { op: 'answer', from: 'answer_' },
    ], { known: ['corpus'] });
    assert.deepStrictEqual(plan.bindings, ['pieces', 'found', 'answer_']);
    assert.strictEqual(plan.answer.from, 'answer_');
  });

  it('rejects a step reading a name nothing produced — AI0201 with its pointer', function () {
    assert.throws(() => compile([
      { op: 'map', from: 'pieces', as: 'found', prompt: 'x' },
      { op: 'answer', from: 'found' },
    ], { known: ['corpus'] }), (err) => {
      const e = /** @type {any} */ (err);
      assert.strictEqual(e.code, 'AI0201');
      assert.strictEqual(e.docPath, '/steps/0/from');
      // the repair prompt has to say what WAS available or the model
      // guesses again
      assert.match(e.message, /corpus/);
      return true;
    });
  });

  it('rejects a name bound twice — AI0202', function () {
    assert.throws(() => compile([
      { op: 'chunk', from: 'corpus', as: 'pieces' },
      { op: 'chunk', from: 'pieces', as: 'pieces' },
      { op: 'answer', from: 'pieces' },
    ], { known: ['corpus'] }), (err) => /** @type {any} */ (err).code === 'AI0202');
  });

  it('requires exactly one answer, last — AI0203', function () {
    assert.throws(() => compile([
      { op: 'chunk', from: 'corpus', as: 'pieces' },
    ], { known: ['corpus'] }), (err) => /** @type {any} */ (err).code === 'AI0203');
    assert.throws(() => compile([
      { op: 'answer', from: 'corpus' },
      { op: 'chunk', from: 'corpus', as: 'pieces' },
    ], { known: ['corpus'] }), (err) => /** @type {any} */ (err).code === 'AI0203');
  });

  it('rejects a reduce that does not read a map — AI0204', function () {
    assert.throws(() => compile([
      { op: 'chunk', from: 'corpus', as: 'pieces', strategy: 'line', size: 200 },
      { op: 'reduce', from: 'pieces', as: 'r', query: CLOSEST_PAIR_QUERY },
      { op: 'answer', from: 'r' },
    ], { known: ['corpus'] }), (err) => {
      const e = /** @type {any} */ (err);
      assert.strictEqual(e.code, 'AI0204');
      assert.strictEqual(e.docPath, '/steps/1/from');
      return true;
    });
  });

  it('refuses select and reduce with the query seam empty — AI0206 (D3)', function () {
    assert.throws(() => compileProgram({
      steps: [
        { op: 'select', from: 'corpus', as: 'x', query: { $const: 1 } },
        { op: 'answer', from: 'x' },
      ],
    }, { known: ['corpus'] }), (err) => {
      const e = /** @type {any} */ (err);
      assert.strictEqual(e.code, 'AI0206');
      assert.match(e.message, /compileQuery/);
      return true;
    });
  });

  it('keeps the query engine\'s own code and rebases its pointer onto the step', function () {
    assert.throws(() => compile([
      { op: 'select', from: 'corpus', as: 'x', query: { $orderby: '$a' } },
      { op: 'answer', from: 'x' },
    ], { known: ['corpus'] }), (err) => {
      const e = /** @type {any} */ (err);
      // the ENGINE's code, not a renumbered one: the model is told what
      // is wrong with the query, and which step it is in
      assert.match(e.code, /^JQ\d{4}$/);
      assert.match(e.docPath, /^\/steps\/0\/query/);
      return true;
    });
  });

  it('cannot check an environment it was not given, and says nothing rather than guessing', function () {
    // no `known`: a bare name might be a slot this compiler never saw
    const plan = compile([
      { op: 'peek', from: 'some_slot_elsewhere', as: 'p' },
      { op: 'answer', from: 'p' },
    ]);
    assert.strictEqual(plan.steps.length, 2);
  });

  it('is the same check the gate runs, in the shape structured output wants', function () {
    const gate = programGate({ compileQuery: compileJsonQuery, known: ['corpus'] });
    assert.strictEqual(gate({ steps: [{ op: 'answer', from: 'corpus' }] }), true);
    const bad = gate({ steps: [{ op: 'answer', from: 'nope' }] });
    assert.strictEqual(/** @type {any} */ (bad).valid, false);
    assert.strictEqual(/** @type {any} */ (bad).errors[0].code, 'AI0201');
    assert.strictEqual(/** @type {any} */ (bad).errors[0].docPath, '/steps/0/from');
  });
});

describe('ai — a program that does not compile never runs', function () {
  it('writes nothing, reads nothing, and returns the errors', async function () {
    const environment = await env();
    const before = (await environment.ledger.listSlots()).length;
    const run = await runner({ environment });

    const result = await run.run({
      steps: [
        // a legal, effective first step: if anything ran at all, this one
        // did, and the environment would have grown by twelve pieces
        { op: 'chunk', from: 'corpus', as: 'pieces', strategy: 'line', size: 200 },
        { op: 'map', from: 'never_bound', as: 'found', prompt: 'x' },
        { op: 'answer', from: 'found' },
      ],
    });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.ran, 0);
    assert.strictEqual(result.errors[0].code, 'AI0201');
    assert.strictEqual((await environment.ledger.listSlots()).length, before,
      'a rejected program touched the environment');
  });

  it('spends no sub-call on a program it will not run', async function () {
    const client = extracting();
    const run = await runner({ client });
    await run.run({
      steps: [
        { op: 'map', from: 'corpus', as: 'a', prompt: 'x' },
        { op: 'map', from: 'corpus', as: 'a', prompt: 'y' },
        { op: 'answer', from: 'a' },
      ],
    });
    assert.strictEqual(client.seen.length, 0, 'a rejected program cost model calls');
  });
});

describe('ai — the runner answers with metadata and stores content in slots', function () {
  it('reports each step without carrying what it produced', async function () {
    const environment = await env();
    const run = await runner({ environment });
    const result = await run.run({
      steps: [
        { op: 'chunk', from: 'corpus', as: 'pieces', strategy: 'line', size: 200 },
        { op: 'stat', from: 'pieces', as: 'shape' },
        { op: 'grep', from: 'pieces', as: 'hits', pattern: 'R00[12]' },
        { op: 'answer', from: 'hits', chars: 400 },
      ],
    });
    assert.strictEqual(result.ok, true);
    const report = JSON.stringify(result.steps);
    assert.ok(!report.includes('pad pad'), 'the step report carried corpus text');
    assert.ok(report.length < 400, `the report is ${report.length} chars`);
    for (const entry of result.steps) {
      assert.ok(!('text' in entry) && !('content' in entry),
        `step ${entry.op} answered with content`);
    }
  });

  it('puts every step\'s result in a slot, under its own name', async function () {
    const environment = await env();
    const run = await runner({ environment });
    await run.run({
      steps: [
        { op: 'chunk', from: 'corpus', as: 'pieces', strategy: 'line', size: 200 },
        { op: 'map', from: 'pieces', as: 'found', prompt: 'read it' },
        { op: 'reduce', from: 'found', as: 'values', query: { $for: { r: '$[*].value' }, $return: '$r.value' } },
        { op: 'answer', from: 'values' },
      ],
    });
    const names = (await environment.ledger.listSlots()).map((s) => s.name);
    assert.ok(names.includes('program/values'), 'the reduce wrote no slot');
    assert.ok(names.filter((n) => n.startsWith('program/found/')).length === 12,
      'the map wrote one result slot per piece');
  });

  it('returns content once, from the slot the program named, capped', async function () {
    const run = await runner();
    const result = await run.run({
      steps: [
        { op: 'peek', from: 'corpus', as: 'p' },
        { op: 'answer', from: 'p', chars: 50 },
      ],
    });
    assert.strictEqual(result.answer.text.length, 50);
    assert.strictEqual(result.answer.slot, 'program/p');
  });

  it('runs twice with the same addresses and no duplicate storage', async function () {
    const environment = await env();
    const run = await runner({ environment });
    const program = {
      steps: [
        { op: 'chunk', from: 'corpus', as: 'pieces', strategy: 'line', size: 200 },
        { op: 'map', from: 'pieces', as: 'found', prompt: 'read it' },
        { op: 'reduce', from: 'found', as: 'values', query: { $for: { r: '$[*].value' }, $return: '$r.value' } },
        { op: 'answer', from: 'values' },
      ],
    };
    await run.run(program);
    const after = (await environment.ledger.listSlots()).map((s) => s.name).sort();
    await run.run(program);
    assert.deepStrictEqual((await environment.ledger.listSlots()).map((s) => s.name).sort(), after,
      're-running a program duplicated its storage');
  });

  it('maps over what a grep MATCHED, not over the match list', async function () {
    const environment = await env();
    const client = extracting();
    const run = await runner({ environment, client });
    const result = await run.run({
      steps: [
        { op: 'chunk', from: 'corpus', as: 'pieces', strategy: 'line', size: 200 },
        { op: 'grep', from: 'pieces', as: 'hits', pattern: '"id":"R0007"' },
        { op: 'map', from: 'hits', as: 'found', prompt: 'read it' },
        { op: 'reduce', from: 'found', as: 'value', query: { $for: { r: '$[*].value' }, $return: '$r.value' } },
        { op: 'answer', from: 'value' },
      ],
    });
    assert.strictEqual(result.ok, true);
    // one matching line, so ONE sub-call — the narrowing is the point
    assert.strictEqual(result.subcalls, 1);
    assert.match(client.seen[0], /"id":"R0007"/);
    assert.match(result.answer.text, /100049/);
  });

  it('tells a program to reduce a map before reading it — AI0207', async function () {
    const run = await runner();
    const result = await run.run({
      steps: [
        { op: 'chunk', from: 'corpus', as: 'pieces', strategy: 'line', size: 200 },
        { op: 'map', from: 'pieces', as: 'found', prompt: 'read it' },
        { op: 'answer', from: 'found' },
      ],
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.ran, 0);
    assert.strictEqual(result.errors[0].code, 'AI0207');
    assert.match(result.errors[0].message, /reduce/);
  });

  it('refuses a map with no client, and says so rather than throwing', async function () {
    const run = createProgramRunner({ environment: await env(), compileQuery: compileJsonQuery });
    const result = await run.run({
      steps: [
        { op: 'map', from: 'corpus', as: 'found', prompt: 'x' },
        { op: 'reduce', from: 'found', as: 'values', query: { $for: { r: '$[*].value' }, $return: '$r.value' } },
        { op: 'answer', from: 'values' },
      ],
    });
    assert.strictEqual(result.ok, false);
    assert.match(result.error, /client/);
  });

  it('answers a query that fails at runtime as a result, not a crash', async function () {
    const environment = await env();
    const run = await runner({ environment });
    const result = await run.run({
      steps: [
        { op: 'select', from: 'corpus', as: 'x', query: { $const: 1 } },
        { op: 'answer', from: 'x' },
      ],
    });
    // the corpus slot is text, not JSON — a content-level problem
    assert.strictEqual(result.ok, false);
    assert.match(result.error, /not JSON/);
  });
});

describe('ai — the root pays the same for any corpus', function () {
  it('holds its size while the corpus sweeps three orders of magnitude', async function () {
    const rows = [];
    // three orders of magnitude, 3 kB → 3 MB, which is HORIZON_06's claim
    // re-asserted with a program actually running over it
    for (const count of [12, 120, 1200, 12000]) {
      const environment = createEnvironment();
      await environment.put('corpus', lines(count), { kind: 'text' });
      const run = createProgramRunner({
        environment, client: extracting(), compileQuery: compileJsonQuery, maxSubcalls: 4,
      });
      const program = {
        steps: [
          { op: 'chunk', from: 'corpus', as: 'pieces', strategy: 'line', size: 200 },
          { op: 'grep', from: 'pieces', as: 'hits', pattern: '"id":"R00[1-3]"' },
          { op: 'map', from: 'hits', as: 'found', prompt: 'read it' },
          { op: 'reduce', from: 'found', as: 'values', query: { $for: { r: '$[*].value' }, $return: '$r.value' } },
          { op: 'answer', from: 'values' },
        ],
      };
      const result = await run.run(program);
      assert.strictEqual(result.ok, true);
      rows.push({
        corpus: (await environment.ledger.getSlot('corpus')).size,
        root: JSON.stringify(program).length + JSON.stringify(result.steps).length
          + result.answer.text.length,
      });
    }

    const last = rows[rows.length - 1];
    // a thousandfold, to within the line separators a thousand times more
    // lines need — the claim is the decade span, not the arithmetic
    assert.ok(Math.abs(last.corpus / rows[0].corpus - 1000) < 10,
      `the sweep spanned ${last.corpus / rows[0].corpus}×, not three decades`);
    for (const row of rows) {
      assert.ok(row.root <= 1200, `the root carried ${row.root} chars at ${row.corpus}`);
    }
    // the whole claim in one line: the corpus grew a thousandfold and the
    // root's share moved by less than the digits it takes to say so
    assert.ok(Math.abs(last.root - rows[0].root) <= 64,
      `the root grew from ${rows[0].root} to ${last.root}`);
  });
});

describe('ai — authoring a program', function () {
  /** A model that replies with whatever it was scripted to, in order. */
  function scripted(replies) {
    const requests = [];
    return {
      requests,
      endpoint: { provider: 'openrouter' },
      complete: async (request) => {
        requests.push(request);
        return {
          message: { role: 'assistant', content: JSON.stringify(replies[requests.length - 1]) },
          finishReason: 'stop',
        };
      },
    };
  }

  const author = async (client, environment) => createProgramAuthor({
    client,
    environment: environment ?? await env(),
    compileQuery: compileJsonQuery,
    createStructuredOutput,
    querySchema,
  }).author('Which two records have the closest values?');

  it('asks over the digest, so the request does not grow with the corpus (D2)', async function () {
    const sizes = [];
    for (const count of [12, 1200]) {
      const client = scripted([pairwiseProgram()]);
      const environment = createEnvironment();
      await environment.put('corpus', lines(count), { kind: 'text' });
      const result = await author(client, environment);

      assert.ok(result.value !== undefined, `authoring failed: ${JSON.stringify(result.errors)}`);
      const sent = JSON.stringify(client.requests[0].messages);
      assert.ok(sent.includes('corpus'), 'the model was not told what the environment holds');
      assert.strictEqual(client.requests[0].responseFormat.name, 'jaren_program');
      sizes.push(sent.length);
    }

    // the digest carries a CAPPED excerpt per slot by design (HORIZON_06's
    // metadata view), so the honest claim is not "no corpus text" but "no
    // corpus text that grows": a hundredfold corpus moves the authoring
    // request by the digits it takes to say how big it got
    assert.ok(Math.abs(sizes[1] - sizes[0]) <= 32,
      `the authoring request grew from ${sizes[0]} to ${sizes[1]} chars with the corpus`);
    assert.ok(sizes[1] < 4000, `the authoring request is ${sizes[1]} chars`);
  });

  it('rejects a program that will not compile and repairs it with the code and the pointer', async function () {
    const client = scripted([
      // names a binding no step produced — the failure a schema cannot see
      { steps: [{ op: 'map', from: 'chunks', as: 'found', prompt: 'read it' },
        { op: 'reduce', from: 'found', as: 'v', query: { $for: { r: '$[*].value' }, $return: '$r.value' } },
        { op: 'answer', from: 'v' }] },
      pairwiseProgram(),
    ]);
    const result = await author(client);

    assert.strictEqual(result.attempts, 2, 'the gate did not send it back');
    assert.ok(result.value !== undefined);
    // the repair turn carries the compiler's own diagnosis
    const repair = JSON.stringify(client.requests[1].messages);
    assert.ok(repair.includes('AI0201'), 'the repair prompt lost the code');
    assert.ok(repair.includes('/steps/0/from'), 'the repair prompt lost the pointer');
  });

  it('teaches the model an example that itself compiles', function () {
    // the few-shot example goes into every authoring prompt, so a query
    // in it that the engine rejects is a broken pattern the model copies
    // before the gate ever sees it
    const plan = compileProgram(PROGRAM_EXAMPLE, {
      compileQuery: compileJsonQuery, known: ['corpus'],
    });
    assert.strictEqual(plan.answer.from, 'summary');
  });

  it('gives up with the errors rather than returning a program that does not compile', async function () {
    const broken = { steps: [{ op: 'answer', from: 'no_such_slot' }] };
    const client = scripted([broken, broken, broken]);
    const result = await author(client);

    assert.strictEqual(result.value, undefined);
    assert.strictEqual(result.errors[0].code, 'AI0201');
  });
});

describe('ai — the question compaction cannot answer', function () {
  it('answers the pairwise relation over a corpus no budget would hold', async function () {
    const corpus = makeCorpus({});
    const result = await programProbe({ corpus, shape: 'late', program: pairwiseProgram() });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.valuesReached, corpus.n,
      'the reduce did not see every value, so the answer was not determined');
    assert.strictEqual(ceilingFor('pairwise', { valuePresent: result.valuesReached, n: corpus.n }), 1,
      'the pairwise ceiling is still 0 — this order has not done its job');
    assert.ok(scorePairwise(result.answerText, corpus),
      `the answer named the wrong pair: ${result.answerText}`);
    // and it cost the root a plan and a report, against a corpus of
    // eighteen thousand characters
    assert.ok(result.rootChars < 1200, `the root carried ${result.rootChars}`);
    assert.ok(result.corpusChars > 15000);
  });

  it('answers a needle with one sub-call, over the same environment', async function () {
    const corpus = makeCorpus({});
    const result = await programProbe({
      corpus, shape: 'late', program: needleProgram(corpus, 7),
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.subcalls, 1, 'the grep did not narrow');
    assert.match(result.answerText, new RegExp(String(corpus.values[7])));
  });

  it('computes over what the map DID return when some sub-calls failed', function () {
    // §3's promise seen from the other end: a failed sub-call stores
    // `{ slot, error }` with no `value`, and the reduce's path simply
    // finds nothing there — so a map with holes answers from the records
    // it got, and a map with no records at all answers null rather than
    // inventing a pair. This is a property of the published query, so it
    // is asserted rather than assumed.
    const run = compileJsonQuery(CLOSEST_PAIR_QUERY);
    const record = (id, value) => ({ slot: id, value: { id, value } });
    assert.deepStrictEqual(run([record('A', 10), record('B', 12), record('C', 50)]),
      { gap: 2, a: 'A', b: 'B' });
    assert.deepStrictEqual(run([record('A', 10), { slot: 'b', error: 'boom' }, record('C', 12)]),
      { gap: 2, a: 'A', b: 'C' });
    assert.strictEqual(run([{ slot: 'a', error: 'x' }, { slot: 'b', error: 'y' }]), null);
    // a pair needs two of them
    assert.strictEqual(run([record('A', 10)]), null);
  });

  it('holds the corpus as text identical to what the tool returned', function () {
    const corpus = makeCorpus({ n: 3 });
    const text = corpusText(corpus, 8, 'late');
    // the program tier and the compaction tiers must measure ONE corpus,
    // or a difference between them is a difference in the fixture
    assert.strictEqual(text.split('\n').length, 3);
    for (let i = 0; i < 3; i++) {
      assert.ok(text.includes(`"id":"${corpus.ids[i]}"`));
      assert.ok(text.includes(`"value":${corpus.values[i]}`));
    }
  });
});
