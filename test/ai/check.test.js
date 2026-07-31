//@ts-check
/**
 * The check-composition seam: `composeChecks` runs checks in order and
 * the first invalid outcome wins, so "validates against the schema AND
 * compiles" is one injected validator. Deliberately engine-agnostic —
 * a compile gate over ANY Jaren engine composes the same way, and the
 * structured-output error normalizer keeps each engine's `code` and
 * `docPath` through the repair loop.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { createChatClient, createStructuredOutput, composeChecks, checkOutcome } from '@jarenjs/ai';
import { JarenValidator } from '@jarenjs/validate';
import { compileJsonQuery, JsonQueryCompileError } from '@jarenjs/json/query';
import { compileJsltStylesheet } from '@jarenjs/json/jslt';

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

/**
 * The two-line compile-gate adapter the docs recommend, over any Jaren
 * engine: compile succeeds → true; a compile error → an outcome
 * carrying the engine's code + docPath.
 */
function compileGate(compile) {
  return (doc) => {
    try {
      compile(doc);
      return true;
    }
    catch (err) {
      const e = /** @type {any} */ (err);
      return { valid: false, errors: [{ code: e.code, docPath: e.docPath, message: e.message }] };
    }
  };
}

describe('ai — composeChecks', function () {
  it('passes a value through every check; the first invalid wins', function () {
    const positive = (n) => n > 0;
    const even = (n) => (n % 2 === 0 ? true : { valid: false, errors: [{ message: 'odd' }] });
    const check = composeChecks(positive, even);
    assert.deepStrictEqual(check(4), { valid: true, errors: [] });
    assert.deepStrictEqual(check(3), { valid: false, errors: [{ message: 'odd' }] });
    assert.deepStrictEqual(check(-2), { valid: false, errors: [] },
      'the bare-boolean check reports invalid with no errors, and short-circuits before "even"');
  });

  it('order matters: the earlier failing check is the one reported', function () {
    const a = () => ({ valid: false, errors: [{ message: 'A' }] });
    const b = () => ({ valid: false, errors: [{ message: 'B' }] });
    assert.deepStrictEqual(composeChecks(a, b)(0).errors, [{ message: 'A' }]);
    assert.deepStrictEqual(composeChecks(b, a)(0).errors, [{ message: 'B' }]);
  });

  it('mixes boolean and {valid,errors} checks freely', function () {
    const check = composeChecks((v) => typeof v === 'object', (v) => v.ok === true);
    assert.strictEqual(check({ ok: true }).valid, true);
    assert.strictEqual(check(42).valid, false);
  });

  it('a JarenValidator schema check composes with an engine compile gate', function () {
    // schema: a jaren-query is any JSON; the compile gate is the real
    // semantic check. A structurally-fine value that names an unknown
    // operator passes the schema and fails the gate.
    const schemaCheck = () => true;
    const check = composeChecks(schemaCheck, compileGate(compileJsonQuery));
    assert.strictEqual(check({ $for: { b: '$.x[*]' }, $return: '$b' }).valid, true);
    const bad = check({ $bogus: [1] });
    assert.strictEqual(bad.valid, false);
    assert.strictEqual(bad.errors[0].code, 'JQ0002', 'the query engine\'s own code survives');
    assert.strictEqual(typeof bad.errors[0].docPath, 'string');
  });
});

describe('ai — the compile-error repair loop is engine-agnostic', function () {
  /** Drive a broken-then-fixed transcript through composeChecks + repair. */
  async function repairRun({ schema, compile, broken, fixed }) {
    const { client, sent } = scriptedClient([JSON.stringify(broken), JSON.stringify(fixed)]);
    const out = createStructuredOutput({
      client, schema, name: 'doc',
      validator: composeChecks(
        new JarenValidator({ collectErrors: true }).compile(schema),
        compileGate(compile)),
    });
    const result = await out.generate([{ role: 'user', content: 'author it' }]);
    return { result: /** @type {any} */ (result), repairPrompt: sent[1].messages.at(-1).content };
  }

  it('query: a compile-broken document repairs, and the JQ code + docPath reach the prompt', async function () {
    // `$get` needs two operands; one is a compile-time arity error
    const { result, repairPrompt } = await repairRun({
      schema: { type: 'object' },
      compile: compileJsonQuery,
      broken: { $get: ['$.x'] },
      fixed: { $get: ['$.x', 0] },
    });
    assert.deepStrictEqual(result.value, { $get: ['$.x', 0] });
    assert.strictEqual(result.attempts, 2);
    assert.match(repairPrompt, /"code":"JQ/, 'the query engine code reached the model');
    assert.match(repairPrompt, /"docPath":/, 'the docPath reached the model');
  });

  it('jslt: a compile-broken stylesheet repairs, and the JT code reaches the prompt', async function () {
    const { result, repairPrompt } = await repairRun({
      schema: { type: 'array' },
      compile: compileJsltStylesheet,
      broken: [{ match: 5, body: '$' }],   // a numeric match is a JT compile error
      fixed: [{ match: '$', body: '$' }],
    });
    assert.deepStrictEqual(result.value, [{ match: '$', body: '$' }]);
    assert.match(repairPrompt, /"code":"JT/, 'a DIFFERENT engine\'s code flows identically');
  });

  it('normalizeErrors keeps code+docPath for a compile error and stays flat for a schema error', async function () {
    // a pure schema failure (no code/docPath) still normalizes cleanly
    const { client, sent } = scriptedClient(['{"age":-1}', '{"age":5}']);
    const schema = { type: 'object', properties: { age: { type: 'integer', minimum: 0 } }, required: ['age'] };
    const out = createStructuredOutput({ client, schema });
    await out.generate([{ role: 'user', content: 'x' }]);
    const prompt = sent[1].messages.at(-1).content;
    assert.match(prompt, /"instancePath":"\/age"/);
    assert.doesNotMatch(prompt, /"code":/, 'a schema error carries no engine code');
  });
});

// a JsonQueryCompileError really does carry the shape the gate reads
describe('ai — the compile-gate adapter reads the real error shape', function () {
  it('a JQ compile error exposes code and docPath', function () {
    let caught;
    try { compileJsonQuery({ $bogus: [1] }); }
    catch (err) { caught = err; }
    assert.ok(caught instanceof JsonQueryCompileError);
    assert.strictEqual(typeof /** @type {any} */ (caught).code, 'string');
    assert.strictEqual(typeof /** @type {any} */ (caught).docPath, 'string');
    assert.strictEqual(checkOutcome(compileGate(compileJsonQuery)({ $bogus: [1] })).valid, false);
  });
});
