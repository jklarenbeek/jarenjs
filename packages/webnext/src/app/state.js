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

/** @returns {any} a fresh initial state */
export function createInitialState(theme = 'light') {
  return {
    route: { page: 'home', params: {} },
    theme,
    bench: {},        // file name -> parsed benchmark JSON
    benchStatus: {},  // file name -> 'loading' | 'ready' | 'error'
    pg: {
      schemaText: DEFAULT_SCHEMA_TEXT,
      data: DEFAULT_DATA,
      dataTab: 'form',       // 'form' | 'json'
      dataError: null,       // parse error of the JSON pane, if any
      locale: 'en',          // error-message locale: 'en' | 'nl'
      result: null,          // validation result JSON from the boundary
    },
  };
}
