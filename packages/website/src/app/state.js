//@ts-check
/**
 * The initial application state — one JSON document. Everything the
 * site knows at runtime lives here (or is derived from here in the
 * viewModel boundary); compiled artifacts never do.
 */

export const DEFAULT_SCHEMA_TEXT = JSON.stringify({
  type: 'object',
  title: 'User',
  properties: {
    name: { type: 'string', minLength: 2 },
    email: { type: 'string', format: 'email' },
    age: { type: 'integer', minimum: 13 },
    newsletter: { type: 'boolean' },
    plan: { enum: ['free', 'pro'] },
    tags: { type: 'array', default: [], items: { type: 'string' } },
  },
  required: ['name', 'email'],
}, null, 2);

export const DEFAULT_DATA = {
  name: 'Ada',
  email: 'ada@example.com',
  age: 36,
  newsletter: true,
  plan: 'pro',
  tags: ['compiler'],
};

import { initialEngineInputs } from '../boundaries/engines.js';
import { calcInitialState } from '@jarenjs/calc/component';

export const DEFAULT_AI_SETTINGS = {
  provider: 'openrouter',  // 'openrouter' | 'ollama' | 'lmstudio' | 'custom'
  baseUrl: '',             // required for 'custom'; overrides the preset otherwise
  model: '',               // e.g. 'qwen/qwen3-4b' or a local model name
  apiKey: '',              // bring your own; local runtimes need none
};

/**
 * @param {string} [theme]
 * @param {string[]} [ideNames] - saved experiment names from storage
 * @param {any} [aiSettings] - persisted assistant settings, if any
 * @returns {any} a fresh initial state
 */
export function createInitialState(theme = 'light', ideNames = [], aiSettings = null) {
  return {
    route: { page: 'home', params: {} },
    theme,
    menu: false,      // the mobile navigation drawer
    bench: {},        // file name -> parsed benchmark JSON
    benchStatus: {},  // file name -> 'loading' | 'ready' | 'error'
    benchUi: { search: '', limit: 40 },
    pg: {
      schemaText: DEFAULT_SCHEMA_TEXT,
      data: DEFAULT_DATA,
      dataTab: 'form',       // 'form' | 'json'
      dataError: null,       // parse error of the JSON pane, if any
      locale: 'en',          // error-message locale: 'en' | 'nl'
      result: null,          // validation result JSON from the boundary
    },
    eng: initialEngineInputs(),  // engine key -> text inputs
    engResults: {},              // engine key -> render nodes
    chartsLive: null,            // /charts page live-feed render nodes
    ide: { name: '', names: ideNames, shared: null },

    // the browser-side AI assistant (@jarenjs/ai): a bring-your-own-key
    // chat panel that drives the playground through schema-guarded tools
    ai: {
      open: false,
      settingsOpen: false,
      settings: { ...DEFAULT_AI_SETTINGS, ...(aiSettings ?? {}) },
      messages: [],          // visible transcript: { role, content }
      draft: '',             // composer text
      pending: '',           // the assistant reply currently streaming
      status: 'idle',        // 'idle' | 'streaming' | 'error'
      activity: null,        // the tool the model is currently calling
      error: null,
    },

    calc: calcInitialState(),    // the @jarenjs/calc sub-app slice

    // the package-README dialog: a fetched Markdown source rendered by
    // the @jarenjs/md visual component in a near-fullscreen overlay
    readme: { open: false, title: '', url: null, status: 'idle', source: null, message: null },
  };
}
