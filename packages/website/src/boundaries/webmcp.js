//@ts-check
/**
 * WebMCP: expose the site's engines to browser-hosted AI agents.
 *
 * When the page runs in a browser whose agent surface provides
 * `navigator.modelContext` (the emerging WebMCP proposal), the site
 * registers its compilers as tools: an agent can validate documents,
 * run queries and transforms, drive navigation and manage the saved
 * experiments — through the very same boundaries the UI uses. Every
 * tool's inputSchema is JSON Schema, and every input is validated with
 * Jaren itself before execution: the suite guarding its own tools.
 *
 * Progressive enhancement: with no modelContext present this module
 * does nothing.
 */

import { JarenValidator } from '@jarenjs/validate';

import { runValidation } from './validator.js';
import { runEngine, ENGINE_DEFS } from './engines.js';

const jaren = new JarenValidator();

/** One tool: JSON Schema in, validated execute out. */
function tool(name, description, inputSchema, execute) {
  const check = jaren.compile(inputSchema);
  return {
    name,
    description,
    inputSchema,
    execute: (args) => {
      const input = args ?? {};
      if (!check(input)) {
        return { error: `invalid input for ${name}`, inputSchema };
      }
      return execute(input);
    },
  };
}

/**
 * @param {any} app - The running site app.
 * @param {{ modelContext?: any, navigate?: (hash: string) => void,
 *   store: any, onError: (err: Error) => void }} env
 * @returns {boolean} whether tools were registered
 */
export function registerWebMcpTools(app, env) {
  const context = env.modelContext
    ?? (typeof navigator !== 'undefined' ? /** @type {any} */ (navigator).modelContext : undefined);
  if (context === undefined || context === null) return false;

  const engineKeys = Object.keys(ENGINE_DEFS);
  const tools = [
    tool('jaren_validate',
      'Validate a JSON document against a JSON Schema with the Jaren validating compiler. Returns { valid, errors, draft, compileMs, validateMs }.',
      {
        type: 'object',
        properties: { schema: {}, data: {} },
        required: ['schema'],
      },
      (input) => runValidation(JSON.stringify(input.schema), input.data ?? null)),

    tool('jaren_run_engine',
      `Run one of the Jaren playground engines (${engineKeys.join(', ')}) with text inputs (JSON values as JSON text). Returns the render nodes the site itself shows, including errors with stable codes and docPaths.`,
      {
        type: 'object',
        properties: {
          engine: { enum: engineKeys },
          inputs: { type: 'object', additionalProperties: { type: 'string' } },
        },
        required: ['engine', 'inputs'],
      },
      (input) => runEngine(input.engine, withDefaults(input.engine, input.inputs))),

    tool('jaren_list_engines',
      'List the available playground engines with their input fields.',
      { type: 'object', properties: {} },
      () => Object.fromEntries(Object.entries(ENGINE_DEFS).map(([key, def]) => [
        key,
        { label: def.label, lead: def.lead, inputs: def.inputs.map((f) => ({ key: f.key, control: f.control, options: f.options ?? null })) },
      ]))),

    tool('jaren_navigate',
      'Navigate the site to a page, optionally with params (e.g. { page: "playground", params: { engine: "jslt" } }).',
      {
        type: 'object',
        properties: {
          page: { enum: ['home', 'playground', 'benchmarks', 'docs', 'examples'] },
          params: { type: 'object', additionalProperties: { type: 'string' } },
        },
        required: ['page'],
      },
      (input) => {
        const query = new URLSearchParams(input.params ?? {}).toString();
        env.navigate?.(`#/${input.page === 'home' ? '' : input.page}${query === '' ? '' : `?${query}`}`);
        return { ok: true };
      }),

    tool('jaren_list_experiments',
      'List the saved playground experiments (the localStorage IDE store).',
      { type: 'object', properties: {} },
      () => Object.entries(env.store.experiments).map(([name, e]) => ({
        name, engine: e.engine, savedAt: e.savedAt,
      }))),

    tool('jaren_load_experiment',
      'Load a saved experiment into the playground by name.',
      {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
      (input) => {
        if (env.store.experiments[input.name] === undefined) {
          return { error: `no experiment named '${input.name}'` };
        }
        app.dispatch('ide/load', input.name);
        return { ok: true };
      }),
  ];

  try {
    if (typeof context.provideContext === 'function') {
      context.provideContext({ tools });
    }
    else if (typeof context.registerTool === 'function') {
      for (const t of tools) context.registerTool(t);
    }
    else {
      return false;
    }
    return true;
  }
  catch (err) {
    env.onError(/** @type {Error} */ (err));
    return false;
  }
}

function withDefaults(engine, inputs) {
  const out = { ...inputs };
  for (const field of ENGINE_DEFS[engine].inputs) {
    if (out[field.key] === undefined) {
      out[field.key] = field.control === 'select' ? (field.options?.[0] ?? '') : '';
    }
  }
  return out;
}
