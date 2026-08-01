//@ts-check
/**
 * Structured output: the wire shape per provider tier, the local
 * validation gate, the bounded repair loop — and the marquee pipeline,
 * generating a Jaren query document constrained by the real published
 * schema twin and compiling it with the real engine.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { createChatClient, createStructuredOutput } from '@jarenjs/ai';
import { compileJsonQuery } from '@jarenjs/json/query';
import querySchema from '@jarenjs/json/schemas/jaren-query.schema.json' with { type: 'json' };

/** A client whose fetch replies with each scripted content in turn. */
function scriptedClient(provider, replies) {
  /** @type {any[]} */
  const sent = [];
  let call = 0;
  const client = createChatClient({
    provider, model: 'm', baseUrl: provider === 'custom' ? 'https://x.test/v1' : undefined,
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

const SCHEMA = {
  type: 'object',
  properties: { name: { type: 'string' }, age: { type: 'integer', minimum: 0 } },
  required: ['name', 'age'],
  additionalProperties: false,
};

describe('ai — structured output', function () {
  it('openrouter tier: json_schema response_format, no prompt embedding', async function () {
    const { client, sent } = scriptedClient('openrouter', ['{"name":"Ada","age":36}']);
    const out = createStructuredOutput({ client, schema: SCHEMA, name: 'person' });
    const result = await out.generate([{ role: 'user', content: 'Ada, 36' }]);
    assert.deepStrictEqual(/** @type {any} */ (result).value, { name: 'Ada', age: 36 });
    assert.strictEqual(/** @type {any} */ (result).attempts, 1);

    assert.deepStrictEqual(sent[0].response_format, {
      type: 'json_schema',
      json_schema: { name: 'person', schema: SCHEMA, strict: true },
    });
    assert.strictEqual(sent[0].stream, false);
    assert.strictEqual(sent[0].messages[0].role, 'user', 'no schema instruction injected');
  });

  it('ollama tier: json_object mode plus the schema in a system instruction', async function () {
    const { client, sent } = scriptedClient('ollama', ['{"name":"Bo","age":7}']);
    const out = createStructuredOutput({ client, schema: SCHEMA });
    const result = await out.generate([{ role: 'user', content: 'Bo, 7' }]);
    assert.deepStrictEqual(/** @type {any} */ (result).value, { name: 'Bo', age: 7 });

    assert.deepStrictEqual(sent[0].response_format, { type: 'json_object' });
    assert.strictEqual(sent[0].messages[0].role, 'system');
    assert.match(sent[0].messages[0].content, /JSON Schema/);
    assert.match(sent[0].messages[0].content, /"required":\["name","age"\]/);
  });

  it('custom tier: no response_format at all, schema in the prompt', async function () {
    const { client, sent } = scriptedClient('custom', ['{"name":"Cy","age":1}']);
    const out = createStructuredOutput({ client, schema: SCHEMA });
    await out.generate([{ role: 'user', content: 'Cy' }]);
    assert.strictEqual(sent[0].response_format, undefined);
    assert.strictEqual(sent[0].messages[0].role, 'system');
  });

  it('repairs an invalid reply with instancePath errors, then succeeds', async function () {
    const { client, sent } = scriptedClient('openrouter', [
      '{"name":"Dee","age":-1}',
      '{"name":"Dee","age":31}',
    ]);
    const out = createStructuredOutput({ client, schema: SCHEMA });
    const result = await out.generate([{ role: 'user', content: 'Dee' }]);
    assert.deepStrictEqual(/** @type {any} */ (result).value, { name: 'Dee', age: 31 });
    assert.strictEqual(/** @type {any} */ (result).attempts, 2);

    // the repair turn carried the assistant's bad reply + the errors
    const repair = sent[1].messages;
    assert.strictEqual(repair[repair.length - 2].role, 'assistant');
    assert.match(repair[repair.length - 1].content, /"instancePath":"\/age"/);
  });

  it('unfences a code-fenced reply before parsing', async function () {
    const { client } = scriptedClient('custom', ['```json\n{"name":"Ed","age":9}\n```']);
    const out = createStructuredOutput({ client, schema: SCHEMA });
    const result = await out.generate([{ role: 'user', content: 'Ed' }]);
    assert.deepStrictEqual(/** @type {any} */ (result).value, { name: 'Ed', age: 9 });
  });

  it('gives up after maxRepairs with the errors and the raw text', async function () {
    const { client, sent } = scriptedClient('openrouter', ['not json at all']);
    const out = createStructuredOutput({ client, schema: SCHEMA, maxRepairs: 2 });
    const result = await out.generate([{ role: 'user', content: 'x' }]);
    assert.strictEqual(/** @type {any} */ (result).value, undefined);
    assert.strictEqual(/** @type {any} */ (result).attempts, 3);
    assert.strictEqual(sent.length, 3);
    assert.match(/** @type {any} */ (result).errors[0].message, /not JSON/);
    assert.strictEqual(/** @type {any} */ (result).raw, 'not json at all');
  });

  it('end to end: a generated query document validates against the published twin and compiles', async function () {
    // the marquee pipeline from the json README, as one function call:
    // constrained generation → local validation → compile → run
    const queryDoc = {
      $for: { b: '$.books[*]' },
      $where: { $gt: ['$b.price', 10] },
      $return: '$b.price',
    };
    const { client } = scriptedClient('openrouter', [JSON.stringify(queryDoc)]);
    const out = createStructuredOutput({ client, schema: querySchema, name: 'jaren_query' });
    const result = await out.generate([
      { role: 'user', content: 'prices over 10' },
    ]);
    const value = /** @type {any} */ (result).value;
    assert.deepStrictEqual(value, queryDoc, 'validated against the real jaren-query schema');

    const fn = compileJsonQuery(value);
    const run = fn({ books: [{ price: 5 }, { price: 15 }, { price: 40 }] });
    assert.deepStrictEqual(run, [15, 40]);
  });

  it('the `gate` option adds a compile check after schema validation, and repairs it', async function () {
    // the reliable engine-document recipe: the schema keeps the SHAPE
    // (and drives constrained decoding), a compile gate keeps the
    // SEMANTICS. First reply is a structurally-fine object that does
    // NOT compile (unknown operator); second reply compiles.
    const { client, sent } = scriptedClient('openrouter', [
      '{"$bogus":[1]}',
      '{"$add":[1,2]}',
    ]);
    const compileGate = (doc) => {
      try { compileJsonQuery(doc); return true; }
      catch (e) { return { valid: false, errors: [{ code: e.code, docPath: e.docPath, message: e.message }] }; }
    };
    const out = createStructuredOutput({
      client, schema: { type: 'object' }, name: 'jaren_query',
      gate: compileGate, maxRepairs: 2,
    });
    const result = /** @type {any} */ (await out.generate([{ role: 'user', content: 'a query' }]));
    assert.deepStrictEqual(result.value, { $add: [1, 2] });
    assert.strictEqual(result.attempts, 2);
    // the compile error's code + docPath reached the model in the repair turn
    const repair = sent[1].messages.at(-1).content;
    assert.match(repair, /"code":"JQ/, 'the query engine\'s compile code drives the repair');

    // a schema-valid AND compilable document passes in one shot
    const clean = scriptedClient('openrouter', ['{"$add":[1,2]}']);
    const ok = createStructuredOutput({ client: clean.client, schema: { type: 'object' }, gate: compileGate });
    const r2 = /** @type {any} */ (await ok.generate([{ role: 'user', content: 'x' }]));
    assert.deepStrictEqual(r2.value, { $add: [1, 2] });
    assert.strictEqual(r2.attempts, 1);
  });

  it('`refs` lets the internal validator resolve a composed schema (the real jaren-fsm case)', async function () {
    // a schema that $refs another by $id — exactly the shape of every
    // jaren engine-document grammar. Without `refs` the internal compile
    // throws "Can not resolve schema".
    const inner = { $id: 'https://example.test/inner', type: 'object', required: ['k'], properties: { k: { type: 'string' } } };
    const outer = { type: 'object', required: ['item'], properties: { item: { $ref: 'https://example.test/inner' } } };
    const { client } = scriptedClient('openrouter', ['{"item":{"k":"ok"}}']);
    assert.throws(
      () => createStructuredOutput({ client, schema: outer }),
      /Can not resolve schema/, 'without refs it cannot compile the composed schema');
    const out = createStructuredOutput({ client, schema: outer, refs: [inner], maxRepairs: 1 });
    const r = /** @type {any} */ (await out.generate([{ role: 'user', content: 'x' }]));
    assert.deepStrictEqual(r.value, { item: { k: 'ok' } });
  });

  it('`gate` accepts an array of checks, run in order after the schema', async function () {
    const { client } = scriptedClient('openrouter', ['{"n":4}']);
    const positive = (v) => (v.n > 0 ? true : { valid: false, errors: [{ message: 'not positive' }] });
    const even = (v) => (v.n % 2 === 0 ? true : { valid: false, errors: [{ message: 'not even' }] });
    const out = createStructuredOutput({
      client, schema: { type: 'object', properties: { n: { type: 'integer' } } },
      gate: [positive, even],
    });
    const r = /** @type {any} */ (await out.generate([{ role: 'user', content: 'x' }]));
    assert.deepStrictEqual(r.value, { n: 4 });
  });
});
