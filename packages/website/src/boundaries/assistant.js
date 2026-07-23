//@ts-check
/**
 * The site assistant boundary — browser-side AI, dogfooded.
 *
 * One @jarenjs/ai toolbox exposes the playground engines as
 * schema-guarded tools (Jaren validates the model's own tool calls
 * before they run); two surfaces consume it:
 *
 *  - the embedded chat panel drives it through a bounded agent loop
 *    against a bring-your-own-key OpenAI-compatible endpoint
 *    (OpenRouter / Ollama / LM Studio), and
 *  - a browser-hosted agent drives the identical tools over WebMCP
 *    (`navigator.modelContext`) — see `registerSiteWebMcp`.
 *
 * Tools don't just answer: they navigate the site and load inputs, so
 * the human watches the playground fill in as the model works. The key
 * never leaves the page — no server, no proxy.
 */

import {
  createChatClient, createAgent, createToolbox, registerModelContext, PROVIDERS,
} from '@jarenjs/ai';

import { runValidation } from './validator.js';
import { runEngine, ENGINE_DEFS } from './engines.js';

/** Provider options for the settings select (BYOK: three shapes). */
export const PROVIDER_OPTIONS = Object.entries(PROVIDERS)
  .map(([value, preset]) => ({ value, label: preset.label, local: preset.local }));

/**
 * A settings slice is "configured" when the client can actually be
 * built: a model, plus whatever the provider needs to reach it.
 * @param {{ provider: string, baseUrl: string, apiKey: string, model: string }} s
 */
export function isConfigured(s) {
  if (s.model.trim() === '') return false;
  if (s.provider === 'custom') return s.baseUrl.trim() !== '';
  if (s.provider === 'openrouter') return s.apiKey.trim() !== '';
  return true; // local runtimes (Ollama, LM Studio) need no key
}

/** Fill an engine's absent fields so `eng/load` replaces cleanly. */
function withDefaults(engine, inputs) {
  const out = { ...inputs };
  for (const field of ENGINE_DEFS[engine].inputs) {
    if (out[field.key] === undefined) {
      out[field.key] = field.control === 'select' ? (field.options?.[0] ?? '') : '';
    }
  }
  return out;
}

/** The engine catalogue the model sees (validate + every descriptor). */
function engineCatalogue() {
  /** @type {any} */
  const out = {
    validate: {
      label: 'JSON Schema',
      lead: 'Validate a JSON document against a JSON Schema.',
      inputs: [{ key: 'schema', control: 'json' }, { key: 'data', control: 'json' }],
    },
  };
  for (const [key, def] of Object.entries(ENGINE_DEFS)) {
    out[key] = {
      label: def.label,
      lead: def.lead,
      inputs: def.inputs.map((f) => ({ key: f.key, control: f.control, options: f.options ?? null })),
    };
  }
  return out;
}

/**
 * Build the site toolbox: engine tools that both drive the visible
 * playground and return the results the model needs. Shared by the
 * chat panel and the WebMCP bridge.
 * @param {{ getApp: () => any, navigate?: (hash: string) => void,
 *   share?: (hash: string) => string | undefined, store: any }} env
 */
export function createSiteToolbox(env) {
  const toolbox = createToolbox();
  const engineKeys = Object.keys(ENGINE_DEFS);
  const go = (hash) => env.navigate?.(hash);

  toolbox.add({
    name: 'jaren_validate',
    description: 'Validate a JSON document against a JSON Schema with the Jaren validating compiler, loading both into the playground so the user sees the result. Returns { valid, errors, draft, compileMs, validateMs }.',
    inputSchema: {
      type: 'object',
      properties: { schema: {}, data: {} },
      required: ['schema'],
    },
    execute: (input) => {
      const app = env.getApp();
      const schemaText = JSON.stringify(input.schema, null, 2);
      const data = input.data ?? null;
      if (app !== null) {
        go('#/playground?engine=validate');
        app.dispatch('pg/example', { schemaText, data });
      }
      return runValidation(schemaText, data);
    },
  });

  toolbox.add({
    name: 'jaren_run_engine',
    description: `Run one of the Jaren playground engines (${engineKeys.join(', ')}) with text inputs (JSON values as JSON text), loading them into the playground so the user watches it run. Returns the render nodes the site itself shows, including errors with stable codes and docPaths.`,
    inputSchema: {
      type: 'object',
      properties: {
        engine: { enum: engineKeys },
        inputs: { type: 'object', additionalProperties: { type: 'string' } },
      },
      required: ['engine', 'inputs'],
    },
    execute: (input) => {
      const app = env.getApp();
      const inputs = withDefaults(input.engine, input.inputs);
      if (app !== null) {
        go(`#/playground?engine=${input.engine}`);
        app.dispatch('eng/load', { engine: input.engine, inputs });
      }
      return runEngine(input.engine, inputs);
    },
  });

  toolbox.add({
    name: 'jaren_list_engines',
    description: 'List the available playground engines with their input fields.',
    inputSchema: { type: 'object', properties: {} },
    execute: () => engineCatalogue(),
  });

  toolbox.add({
    name: 'jaren_get_state',
    description: 'Read what is currently on screen: the active page, the selected playground engine and its current text inputs. Call this before editing so you build on what the user already has.',
    inputSchema: { type: 'object', properties: {} },
    execute: () => {
      const app = env.getApp();
      if (app === null) return { page: 'unknown' };
      const state = app.getState();
      const engine = state.route.page === 'playground'
        ? (state.route.params.engine ?? 'validate')
        : null;
      const inputs = engine === 'validate'
        ? { schema: state.pg.schemaText, data: JSON.stringify(state.pg.data) }
        : engine !== null ? (state.eng[engine] ?? {}) : null;
      return { page: state.route.page, engine, inputs };
    },
  });

  toolbox.add({
    name: 'jaren_navigate',
    description: 'Navigate the site to a page, optionally with params (e.g. { page: "playground", params: { engine: "jslt" } }).',
    inputSchema: {
      type: 'object',
      properties: {
        page: { enum: ['home', 'playground', 'benchmarks', 'charts', 'docs', 'examples', 'calculator'] },
        params: { type: 'object', additionalProperties: { type: 'string' } },
      },
      required: ['page'],
    },
    execute: (input) => {
      const query = new URLSearchParams(input.params ?? {}).toString();
      go(`#/${input.page === 'home' ? '' : input.page}${query === '' ? '' : `?${query}`}`);
      return { ok: true };
    },
  });

  toolbox.add({
    name: 'jaren_list_experiments',
    description: 'List the saved playground experiments (the localStorage IDE store).',
    inputSchema: { type: 'object', properties: {} },
    execute: () => Object.entries(env.store.experiments).map(([name, e]) => ({
      name, engine: /** @type {any} */ (e).engine, savedAt: /** @type {any} */ (e).savedAt,
    })),
  });

  toolbox.add({
    name: 'jaren_load_experiment',
    description: 'Load a saved experiment into the playground by name.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
    execute: (input) => {
      const app = env.getApp();
      if (env.store.experiments[input.name] === undefined) {
        return { error: `no experiment named '${input.name}'` };
      }
      app?.dispatch('ide/load', input.name);
      return { ok: true };
    },
  });

  toolbox.add({
    name: 'jaren_share_link',
    description: 'Build a share link that restores the current playground engine and inputs, and copy it to the clipboard. Returns { url }.',
    inputSchema: { type: 'object', properties: {} },
    execute: () => {
      const app = env.getApp();
      if (app === null || env.share === undefined) return { error: 'sharing is unavailable here' };
      app.dispatch('ide/share');
      return { ok: true, note: 'A share link was copied to the clipboard.' };
    },
  });

  return toolbox;
}

/** The system prompt: what the assistant is and how it drives the site. */
export const SYSTEM_PROMPT = [
  'You are the Jaren playground assistant, embedded in the jarenjs website.',
  'Jaren is a JSON toolkit: a JSON Schema validating compiler plus engines for JSONPath,',
  'JSON Pointer, JSON Patch, the JSON Query language (XQuery 3.1 semantics as JSON), JSLT and',
  'JTLT stylesheets, XQuery text, JOSL/JSONX (a streaming TOML superset), Markdown, Mermaid and charts.',
  '',
  'You help the user explore these by DRIVING the playground with your tools, not by pasting long',
  'answers. To validate something, call jaren_validate. To run any other engine, call jaren_run_engine',
  'with that engine and its text inputs (JSON values are passed as JSON text). These tools load the',
  'inputs into the live playground, so the user watches it happen. Call jaren_get_state first when the',
  'user refers to what is already on screen. Use jaren_list_engines if you are unsure of an engine\'s',
  'inputs.',
  '',
  'Keep replies short. After running a tool, explain the result in a sentence or two — the full output',
  'is already visible on the page. Every engine runs entirely in the browser with the real shipped',
  'compilers; there is no server.',
].join('\n');

/**
 * The assistant's impure effects: the streaming agent turn and the
 * settings persistence. Injected `aiFetch` keeps the whole thing
 * testable against a scripted transport.
 * @param {{ toolbox: any, getApp: () => any,
 *   aiFetch?: typeof fetch,
 *   aiStorage: { read: () => any, write: (data: any) => void } }} deps
 */
export function createAssistantEffects(deps) {
  return {
    'ai-send': (props, dispatch) => {
      const app = deps.getApp();
      const state = app.getState();
      const draft = state.ai.draft.trim();
      if (draft === '' || state.ai.status === 'streaming') return;
      if (!isConfigured(state.ai.settings)) {
        dispatch('ai/failed', 'Add a provider, model and (for OpenRouter) an API key in settings first.');
        return;
      }
      dispatch('ai/user', draft);

      const s = state.ai.settings;
      /** @type {any} */
      let client;
      try {
        client = createChatClient({
          provider: s.provider,
          baseUrl: s.baseUrl,
          apiKey: s.apiKey,
          model: s.model,
          fetch: deps.aiFetch,
          headers: { 'HTTP-Referer': 'https://jklarenbeek.github.io/jarenjs/', 'X-Title': 'Jaren playground' },
        });
      }
      catch (err) {
        dispatch('ai/failed', /** @type {Error} */ (err).message);
        return;
      }

      const agent = createAgent({
        client, toolbox: deps.toolbox, system: SYSTEM_PROMPT, maxToolRounds: 5,
      });
      const history = app.getState().ai.messages.map((m) => ({ role: m.role, content: m.content }));
      agent.send(history, {
        onDelta: (text) => dispatch('ai/delta', text),
        onToolCall: (call) => dispatch('ai/activity', call.name),
      }).then(
        (result) => dispatch('ai/reply', result.message.content),
        (err) => dispatch('ai/failed', err?.message ?? String(err)),
      );
    },

    'ai-save-settings': () => {
      deps.aiStorage.write(deps.getApp().getState().ai.settings);
    },
  };
}

/**
 * The generalized WebMCP bridge, reintegrated: register the site
 * toolbox on a `navigator.modelContext` surface through @jarenjs/ai.
 * Progressive enhancement — no context means no-op.
 * @param {any} toolbox - a site toolbox from createSiteToolbox
 * @param {{ modelContext?: any, onError?: (err: Error) => void }} env
 * @returns {boolean} whether tools were registered
 */
export function registerSiteWebMcp(toolbox, env) {
  return registerModelContext(toolbox, env.modelContext, env.onError);
}
