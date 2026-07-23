//@ts-check
import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { createSiteApp } from '../../packages/website/src/app/createSiteApp.js';
import { parseHash } from '../../packages/website/src/lib/route.js';
import { createStubHost, fire, serialize } from '../view/dom.stub.js';

/** Build an SSE completion body from chat chunks + the [DONE] marker. */
function sseBody(chunks) {
  return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
}
const textTurn = (content) => sseBody([
  { choices: [{ delta: { role: 'assistant', content } }] },
  { choices: [{ delta: {}, finish_reason: 'stop' }] },
]);
const toolTurn = (name, args) => sseBody([
  { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name, arguments: args } }] } }] },
  { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
]);

/** A headless site with a scripted AI transport and in-memory settings. */
function mountSite({ hash = '#/', aiSettings = null, responses = [], onFetch } = {}) {
  const { document, container } = createStubHost();
  /** @type {any} */
  let routeCb = null;
  let aiData = aiSettings;
  const requests = [];
  const app = createSiteApp({
    node: container,
    document,
    schedule: (f) => f(),
    debounceMs: 0,
    fetchJson: () => Promise.reject(new Error('404')),
    listenHash: (cb) => { routeCb = cb; cb(parseHash(hash)); },
    navigate: (h) => routeCb(parseHash(h)),
    storage: { read: () => null, write: () => {} },
    aiStorage: { read: () => aiData, write: (data) => { aiData = JSON.parse(JSON.stringify(data)); } },
    aiFetch: (url, init) => {
      requests.push({ url, init });
      if (onFetch) return onFetch({ url, init, requests });
      const body = responses.shift();
      if (body === undefined) return Promise.reject(new Error('no scripted response'));
      return Promise.resolve(new Response(body, { status: 200 }));
    },
    onError: (err) => { throw err; },
  });
  return { app, container, go: (h) => routeCb(parseHash(h)), requests, settings: () => aiData };
}

function find(node, pred) {
  if (pred(node)) return node;
  for (const c of node.childNodes ?? []) {
    const hit = find(c, pred);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

const CONFIGURED = { provider: 'ollama', baseUrl: '', model: 'qwen3:4b', apiKey: '' };

/** Await until the assistant leaves the streaming state. */
async function settle(app, max = 50) {
  for (let i = 0; i < max; i++) {
    if (app.getState().ai.status !== 'streaming') return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`assistant stayed streaming (status=${app.getState().ai.status})`);
}

describe('website — the AI assistant panel', function () {
  it('is closed by default with a launcher, opens on toggle', function () {
    const { app, container } = mountSite();
    assert.strictEqual(app.getState().ai.open, false);
    let html = serialize(container);
    assert.match(html, /ai-launch/, 'the launcher renders on every page');
    assert.doesNotMatch(html, /ai-panel/, 'the panel is closed');

    fire(find(container, (n) => n.attributes?.get('class') === 'ai-launch'), 'click');
    assert.strictEqual(app.getState().ai.open, true);
    html = serialize(container);
    assert.match(html, /ai-panel/);
    assert.match(html, /Jaren assistant/);
  });

  it('shows the settings form until configured, then hides it', function () {
    const unconfigured = mountSite();
    fire(find(unconfigured.container, (n) => n.attributes?.get('class') === 'ai-launch'), 'click');
    assert.match(serialize(unconfigured.container), /ai-settings/, 'unconfigured: settings shown');
    assert.match(serialize(unconfigured.container), /Bring your own key/);

    const configured = mountSite({ aiSettings: CONFIGURED });
    fire(find(configured.container, (n) => n.attributes?.get('class') === 'ai-launch'), 'click');
    assert.doesNotMatch(serialize(configured.container), /ai-settings/, 'configured: settings hidden');
    assert.match(serialize(configured.container), /Ask me to validate/, 'the intro shows instead');
  });

  it('persists settings through the injected storage', function () {
    const { app, settings } = mountSite();
    app.dispatch('ai/setting', { key: 'provider' }, { target: { value: 'ollama' } });
    app.dispatch('ai/setting', { key: 'model' }, { target: { value: 'llama3.2' } });
    app.dispatch('ai/save-settings');
    assert.deepStrictEqual(settings(), { provider: 'ollama', baseUrl: '', model: 'llama3.2', apiKey: '' });
    assert.strictEqual(app.getState().ai.settingsOpen, false, 'saving closes the settings form');
  });

  it('refuses to send when not configured, with a readable error', async function () {
    const { app } = mountSite();
    app.dispatch('ai/draft', null, { target: { value: 'hello' } });
    app.dispatch('ai/send');
    await settle(app);
    assert.strictEqual(app.getState().ai.status, 'error');
    assert.match(app.getState().ai.error, /settings first/);
    assert.deepStrictEqual(app.getState().ai.messages, [], 'nothing was sent');
  });

  it('drives the playground: a tool call navigates, loads inputs and the reply renders', async function () {
    const { app, container, requests } = mountSite({
      hash: '#/',
      aiSettings: CONFIGURED,
      responses: [
        toolTurn('jaren_run_engine', JSON.stringify({
          engine: 'path', inputs: { selector: '$.store.book[*].price', data: '{"store":{"book":[{"price":5},{"price":9}]}}' },
        })),
        textTurn('I ran the JSONPath selector; it matched two prices.'),
      ],
    });
    fire(find(container, (n) => n.attributes?.get('class') === 'ai-launch'), 'click');
    app.dispatch('ai/draft', null, { target: { value: 'get every price' } });
    app.dispatch('ai/send');
    await settle(app);

    // the tool navigated the site and loaded the engine inputs — the
    // human watches the playground fill in
    assert.strictEqual(app.getState().route.page, 'playground');
    assert.strictEqual(app.getState().route.params.engine, 'path');
    assert.strictEqual(app.getState().eng.path.selector, '$.store.book[*].price');

    // the transcript holds the user turn and the final assistant reply
    const messages = app.getState().ai.messages;
    assert.deepStrictEqual(messages.map((m) => m.role), ['user', 'assistant']);
    assert.match(messages[1].content, /matched two prices/);
    assert.strictEqual(app.getState().ai.status, 'idle');

    // two provider calls: the tool round, then the final answer
    assert.strictEqual(requests.length, 2);
    assert.strictEqual(requests[0].url, 'http://localhost:11434/v1/chat/completions');
    const secondBody = JSON.parse(requests[1].init.body);
    assert.strictEqual(secondBody.messages.some((m) => m.role === 'tool'), true,
      'the tool result was fed back to the model');
    assert.strictEqual(secondBody.tools[0].function.name, 'jaren_validate',
      'the schema-guarded tools are advertised to the model');
  });

  it('surfaces a provider HTTP error without crashing', async function () {
    const { app } = mountSite({
      aiSettings: CONFIGURED,
      onFetch: () => Promise.resolve(new Response('{"error":"model not found"}', { status: 404 })),
    });
    app.dispatch('ai/draft', null, { target: { value: 'hi' } });
    app.dispatch('ai/send');
    await settle(app);
    assert.strictEqual(app.getState().ai.status, 'error');
    assert.match(app.getState().ai.error, /404/);
    // the user's message stays in the transcript; the panel recovers
    assert.deepStrictEqual(app.getState().ai.messages.map((m) => m.role), ['user']);
  });

  it('clears the conversation', function () {
    const { app } = mountSite({ aiSettings: CONFIGURED });
    app.dispatch('ai/user', 'hello');
    app.dispatch('ai/reply', 'hi there');
    assert.strictEqual(app.getState().ai.messages.length, 2);
    app.dispatch('ai/clear');
    assert.deepStrictEqual(app.getState().ai.messages, []);
    assert.strictEqual(app.getState().ai.status, 'idle');
  });
});

describe('website — WebMCP over @jarenjs/ai', function () {
  it('registers the generalized toolbox and its tools drive the site', function () {
    /** @type {any[]} */
    let registered = [];
    const shared = [];
    const { document, container } = createStubHost();
    /** @type {any} */
    let routeCb = null;
    const app = createSiteApp({
      node: container,
      document,
      schedule: (f) => f(),
      debounceMs: 0,
      fetchJson: () => Promise.reject(new Error('404')),
      listenHash: (cb) => { routeCb = cb; cb(parseHash('#/playground')); },
      navigate: (h) => routeCb(parseHash(h)),
      share: (h) => { shared.push(h); return `https://x/${h}`; },
      storage: {
        read: () => ({ experiments: { demo: { engine: 'path', inputs: { selector: '$..price', data: '{}' }, savedAt: 'x' } } }),
        write: () => {},
      },
      modelContext: { provideContext: ({ tools }) => { registered = tools; } },
      onError: (err) => { throw err; },
    });
    const tool = (name) => registered.find((t) => t.name === name);
    const names = registered.map((t) => t.name);
    for (const expected of ['jaren_validate', 'jaren_run_engine', 'jaren_list_engines',
      'jaren_get_state', 'jaren_navigate', 'jaren_list_experiments',
      'jaren_load_experiment', 'jaren_share_link']) {
      assert.ok(names.includes(expected), `${expected} registered`);
    }

    const validate = tool('jaren_validate');
    assert.strictEqual(validate.execute({ schema: { type: 'integer' }, data: 5 }).valid, true);
    assert.strictEqual(validate.execute({ schema: { type: 'integer' }, data: 'no' }).valid, false);

    const run = tool('jaren_run_engine');
    const nodes = run.execute({ engine: 'path', inputs: { selector: '$.a', data: '{"a":42}' } });
    assert.strictEqual(nodes.some((n) => n.kind === 'error'), false);
    assert.match(JSON.stringify(nodes), /42/);
    assert.strictEqual(app.getState().eng.path.selector, '$.a', 'the WebMCP tool drove the playground too');

    // Jaren validates the model's own tool calls
    assert.match(run.execute({ engine: 'no-such', inputs: {} }).error, /invalid input/);

    // the catalogue lists validate + every engine, with input fields
    const engines = tool('jaren_list_engines').execute({});
    assert.ok('validate' in engines && 'jslt' in engines);
    assert.ok(Array.isArray(engines.path.inputs));

    // get_state reflects what is on screen
    const state = tool('jaren_get_state').execute({});
    assert.strictEqual(state.page, 'playground');
    assert.strictEqual(state.engine, 'path');
    assert.strictEqual(state.inputs.selector, '$.a');

    // the experiment store tools
    assert.deepStrictEqual(tool('jaren_list_experiments').execute({}).map((e) => e.name), ['demo']);
    assert.deepStrictEqual(tool('jaren_load_experiment').execute({ name: 'demo' }), { ok: true });
    assert.strictEqual(app.getState().eng.path.selector, '$..price', 'the experiment loaded');
    assert.match(tool('jaren_load_experiment').execute({ name: 'nope' }).error, /no experiment/);

    // the share tool builds and copies a link
    assert.strictEqual(tool('jaren_share_link').execute({}).ok, true);
    assert.strictEqual(shared.length, 1);
    assert.match(shared[0], /engine=path&s=/);

    const nav = tool('jaren_navigate');
    nav.execute({ page: 'playground', params: { engine: 'jslt' } });
    assert.strictEqual(app.getState().route.params.engine, 'jslt');
  });

  it('the built-in storage/settings defaults boot and persist without env wiring', function () {
    const { document, container } = createStubHost();
    /** @type {any} */
    let routeCb = null;
    // no `storage`, no `aiStorage` → exercises the built-in fallbacks
    const app = createSiteApp({
      node: container,
      document,
      schedule: (f) => f(),
      fetchJson: () => Promise.reject(new Error('404')),
      listenHash: (cb) => { routeCb = cb; cb(parseHash('#/')); },
      navigate: (h) => routeCb(parseHash(h)),
    });
    // saving settings runs the ai-save-settings effect through the no-op
    // default storage without throwing
    app.dispatch('ai/setting', { key: 'model' }, { target: { value: 'm' } });
    app.dispatch('ai/save-settings');
    assert.strictEqual(app.getState().ai.settings.model, 'm');
  });
});
