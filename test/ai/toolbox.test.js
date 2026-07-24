//@ts-check
import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { createToolbox, registerModelContext } from '@jarenjs/ai';

function demoToolbox() {
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

describe('ai — the toolbox', function () {
  it('executes a registered tool with valid input', function () {
    assert.deepStrictEqual(demoToolbox().execute('add', { a: 2, b: 3 }), { sum: 5 });
  });

  it('Jaren validates every input before the tool runs', function () {
    const rejected = demoToolbox().execute('add', { a: 'two', b: 3 });
    assert.match(rejected.error, /invalid input for add/);
    assert.deepStrictEqual(rejected.inputSchema.required, ['a', 'b'],
      'the schema rides along so the model can self-correct');
    assert.ok(Array.isArray(rejected.errors) && rejected.errors.length > 0,
      'the validation errors ride along too');
    assert.ok(rejected.errors.every((e) => typeof e.message === 'string'
      && typeof e.instancePath === 'string'));
    // null/undefined args validate as an empty object
    assert.match(demoToolbox().execute('add', undefined).error, /invalid input/);
  });

  it('parses JSON-encoded strings where the schema wants structure', function () {
    const toolbox = createToolbox();
    toolbox.add({
      name: 'echo',
      description: 'Echo a document and a list.',
      inputSchema: {
        type: 'object',
        properties: {
          doc: { type: 'object' },
          list: { type: 'array', items: { type: 'object' } },
          note: { type: 'string' },
        },
        required: ['doc'],
      },
      execute: (input) => input,
    });
    // the classic weak-model mistake: nested JSON as a string argument
    const result = toolbox.execute('echo', {
      doc: '{"a": 1}',
      list: '[{"op": "add"}]',
      note: '{"not": "parsed"}',
    });
    assert.deepStrictEqual(result.doc, { a: 1 }, 'stringified object coerced');
    assert.deepStrictEqual(result.list, [{ op: 'add' }], 'stringified array coerced');
    assert.strictEqual(result.note, '{"not": "parsed"}',
      'a property that wants a string keeps its string');
    // a string that is not JSON still fails with the real errors and
    // a hint naming the property that arrived stringified
    const rejected = toolbox.execute('echo', { doc: 'not json' });
    assert.match(rejected.error, /invalid input for echo/);
    assert.ok(rejected.errors.length > 0);
    assert.match(rejected.hint, /'doc' arrived as a JSON-encoded string/);
  });

  it('unknown tools and throwing tools answer with { error }, never a throw', async function () {
    const toolbox = demoToolbox();
    assert.deepStrictEqual(toolbox.execute('nope', {}), { error: "unknown tool 'nope'" });

    toolbox.add({
      name: 'boom', description: 'always throws',
      inputSchema: { type: 'object' },
      execute: () => { throw new Error('kaput'); },
    });
    assert.deepStrictEqual(toolbox.execute('boom', {}), { error: 'kaput' });

    toolbox.add({
      name: 'later', description: 'async ok',
      inputSchema: { type: 'object' },
      execute: async () => ({ ok: true }),
    });
    assert.deepStrictEqual(await toolbox.execute('later', {}), { ok: true });

    toolbox.add({
      name: 'later-boom', description: 'async reject',
      inputSchema: { type: 'object' },
      execute: async () => { throw new Error('async kaput'); },
    });
    assert.deepStrictEqual(await toolbox.execute('later-boom', {}), { error: 'async kaput' });
  });

  it('lists tools and produces OpenAI function-calling definitions', function () {
    const toolbox = demoToolbox();
    assert.deepStrictEqual(toolbox.list().map((t) => t.name), ['add']);
    const [fn] = toolbox.toFunctionTools();
    assert.strictEqual(fn.type, 'function');
    assert.strictEqual(fn.function.name, 'add');
    assert.strictEqual(fn.function.description, 'Add two integers.');
    assert.deepStrictEqual(fn.function.parameters.required, ['a', 'b']);
  });
});

describe('ai — WebMCP registration', function () {
  it('publishes through provideContext when available', function () {
    /** @type {any[]} */
    let registered = [];
    const ok = registerModelContext(demoToolbox(), {
      provideContext: ({ tools }) => { registered = tools; },
    });
    assert.strictEqual(ok, true);
    assert.strictEqual(registered[0].name, 'add');
    assert.deepStrictEqual(registered[0].execute({ a: 1, b: 1 }), { sum: 2 });
    assert.match(registered[0].execute({ a: 'x' }).error, /invalid input/,
      'the WebMCP surface is schema-guarded too');
  });

  it('falls back to per-tool registerTool', function () {
    /** @type {any[]} */
    const registered = [];
    const ok = registerModelContext(demoToolbox(), {
      registerTool: (tool) => registered.push(tool),
    });
    assert.strictEqual(ok, true);
    assert.deepStrictEqual(registered.map((t) => t.name), ['add']);
  });

  it('reports false for an absent or unusable context', function () {
    assert.strictEqual(registerModelContext(demoToolbox(), undefined), false);
    assert.strictEqual(registerModelContext(demoToolbox(), {}), false);
  });

  it('reports false and surfaces the error when registration throws', function () {
    /** @type {any} */
    let seen = null;
    const ok = registerModelContext(demoToolbox(), {
      provideContext: () => { throw new Error('host refused'); },
    }, (err) => { seen = err; });
    assert.strictEqual(ok, false);
    assert.match(seen.message, /host refused/);
  });
});
