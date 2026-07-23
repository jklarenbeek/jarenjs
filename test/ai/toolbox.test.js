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
    // null/undefined args validate as an empty object
    assert.match(demoToolbox().execute('add', undefined).error, /invalid input/);
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
