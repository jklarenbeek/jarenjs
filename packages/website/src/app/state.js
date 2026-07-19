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

/**
 * @param {string} [theme]
 * @param {string[]} [ideNames] - saved experiment names from storage
 * @returns {any} a fresh initial state
 */
export function createInitialState(theme = 'light', ideNames = []) {
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
    ide: { name: '', names: ideNames, shared: null },
    // the package-README dialog: a fetched Markdown source rendered by
    // the @jarenjs/md visual component in a near-fullscreen overlay
    readme: { open: false, title: '', url: null, status: 'idle', source: null, message: null },
  };
}
