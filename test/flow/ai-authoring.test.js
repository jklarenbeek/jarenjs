//@ts-check
/**
 * The @jarenjs/ai × @jarenjs/flow integration, proven with data only —
 * no import edge in either direction (D11). Recipe 2: a model authors a
 * jaren-fsm document under the published schema, and a schema-valid but
 * *semantically* broken document repairs with the JF code and docPath
 * reaching the model. Recipe 3: a model runs as an ordinary dag task
 * node, abort included. Both are recipes over the shipped surface —
 * `composeChecks` + a compile gate, and a three-line task handler — not
 * new API.
 */
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import * as assert from 'node:assert';

import { compileFsm, compileDag } from '@jarenjs/flow';
import { createChatClient, createStructuredOutput, composeChecks, checkOutcome } from '@jarenjs/ai';
import { JarenValidator } from '@jarenjs/validate';

const load = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const fsmSchema = load('../../packages/flow/schemas/jaren-fsm.schema.json');
const querySchema = load('../../packages/json/schemas/jaren-query.schema.json');

/** A client whose fetch replies with each scripted content in turn. */
function scriptedClient(replies) {
  /** @type {any[]} */
  const sent = [];
  let call = 0;
  const client = createChatClient({
    provider: 'openrouter', model: 'm',
    retry: { attempts: 1 },
    fetch: (url, init) => {
      sent.push(JSON.parse(init.body));
      const content = replies[Math.min(call++, replies.length - 1)];
      return Promise.resolve(new Response(
        JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 }));
    },
  });
  return { client, sent };
}

/** The two-line compile gate the docs recommend, for jaren-fsm. */
const fsmCompileGate = (doc) => {
  try {
    compileFsm(doc);
    return true;
  }
  catch (err) {
    const e = /** @type {any} */ (err);
    return { valid: false, errors: [{ code: e.code, docPath: e.docPath, message: e.message }] };
  }
};

describe('recipe 2 — authoring a machine with semantic repair', function () {
  it('a schema-valid but compile-broken machine repairs; the JF code + docPath reach the prompt', async function () {
    // both replies validate against the fsm schema (structure is fine);
    // the first transitions to an UNDECLARED state — a JF0006 the schema
    // cannot catch, only the compiler can
    const broken = {
      initial: 'draft',
      states: ['draft', 'published'],
      transitions: [{ from: 'draft', event: 'submit', to: 'in-review' }],
    };
    const fixed = {
      initial: 'draft',
      states: ['draft', 'published'],
      transitions: [{ from: 'draft', event: 'submit', to: 'published' }],
    };
    const { client, sent } = scriptedClient([JSON.stringify(broken), JSON.stringify(fixed)]);

    const schemaCheck = new JarenValidator({ collectErrors: true })
      .addSchema(querySchema)
      .compile(fsmSchema);
    assert.strictEqual(checkOutcome(schemaCheck(broken)).valid, true,
      'the broken doc is SCHEMA-valid — only the compiler objects');

    const out = createStructuredOutput({
      client, schema: fsmSchema, name: 'jaren_fsm',
      validator: composeChecks(schemaCheck, fsmCompileGate),
    });
    const result = /** @type {any} */ (await out.generate([{ role: 'user', content: 'a review machine' }]));

    assert.deepStrictEqual(result.value, fixed);
    assert.strictEqual(result.attempts, 2);
    assert.doesNotThrow(() => compileFsm(result.value), 'the repaired document compiles');

    const repairPrompt = sent[1].messages.at(-1).content;
    assert.match(repairPrompt, /"code":"JF0006"/, 'the JF code reached the model');
    assert.match(repairPrompt, /"docPath":"\/transitions\/0\/to"/, 'the docPath reached the model');
  });
});

describe('recipe 3 — a model as a dataflow node', function () {
  /** The three-line llm task handler from the README. */
  const llmTask = (client, pick) => ({ with: w, input }, signal) =>
    client.complete({ stream: false, messages: [{ role: 'user', content: JSON.stringify({ ...w, input }) }], signal })
      .then(pick);

  it('runs the model as an ordinary task node and threads its output downstream', async function () {
    const { client } = scriptedClient(['{"summary":"3 rows"}']);
    const dag = {
      $dag: '0.1',
      nodes: {
        rows: { kind: 'input' },
        summarize: { kind: 'task', run: 'llm', with: { prompt: 'summarize' } },
        pickField: { kind: 'query', query: '$.summary' },
        out: { kind: 'output' },
      },
      edges: [
        { from: 'rows', to: 'summarize' },
        { from: 'summarize', to: 'pickField' },
        { from: 'pickField', to: 'out' },
      ],
    };
    const compiled = compileDag(dag, {
      tasks: { llm: llmTask(client, (r) => JSON.parse(r.message.content)) },
    });
    const result = await compiled.run([1, 2, 3]);
    assert.strictEqual(result, '3 rows', 'the model\'s output flowed through the query node');
  });

  it('a run abort reaches the model client through the shared signal', async function () {
    let sawAbort = false;
    // a client that never resolves until aborted
    const client = {
      endpoint: { provider: 'openrouter' },
      complete: (req) => new Promise((_resolve, reject) => {
        req.signal?.addEventListener('abort', () => { sawAbort = true; reject(new Error('aborted')); });
      }),
    };
    const dag = {
      $dag: '0.1',
      nodes: {
        i: { kind: 'input' },
        ask: { kind: 'task', run: 'llm' },
        out: { kind: 'output' },
      },
      edges: [{ from: 'i', to: 'ask' }, { from: 'ask', to: 'out' }],
    };
    const compiled = compileDag(dag, {
      tasks: { llm: llmTask(/** @type {any} */ (client), (r) => r) },
    });
    const controller = new AbortController();
    const run = compiled.run(null, { signal: controller.signal });
    await new Promise((r) => setImmediate(r));
    controller.abort();
    await assert.rejects(run, (err) => /** @type {any} */ (err).code === 'JF2007');
    assert.strictEqual(sawAbort, true, 'the model client observed the run\'s abort signal');
  });
});

describe('the coupling rule (D11) is mechanical', function () {
  it('neither package appears in the other\'s dependencies', function () {
    const aiPkg = load('../../packages/ai/package.json');
    const flowPkg = load('../../packages/flow/package.json');
    assert.strictEqual(aiPkg.dependencies['@jarenjs/flow'], undefined,
      '@jarenjs/ai must not depend on @jarenjs/flow');
    assert.strictEqual(flowPkg.dependencies['@jarenjs/ai'], undefined,
      '@jarenjs/flow must not depend on @jarenjs/ai');
  });
});
