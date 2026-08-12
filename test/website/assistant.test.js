//@ts-check
import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { createLedger } from '@jarenjs/ai';

import { createSiteApp } from '../../packages/website/src/app/createSiteApp.js';
import { createSlotLedgerStorage } from '../../packages/website/src/lib/ledgerStore.js';
import { parseHash } from '../../packages/website/src/lib/route.js';
import { flowGateTaskStub } from '../../packages/website/src/boundaries/assistant.js';
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

/** A headless site with a scripted AI transport and in-memory settings + transcript. */
function mountSite({
  hash = '#/', aiSettings = null, aiChat = null, aiLedger = null, responses = [], onFetch,
} = {}) {
  const { document, container } = createStubHost();
  /** @type {any} */
  let routeCb = null;
  let aiData = aiSettings;
  let chatData = aiChat;
  let ledgerData = aiLedger;
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
    aiChat: { read: () => chatData, write: (data) => { chatData = JSON.parse(JSON.stringify(data)); } },
    aiLedger: {
      read: () => ledgerData,
      write: (data) => { ledgerData = JSON.parse(JSON.stringify(data)); },
    },
    aiFetch: (url, init) => {
      requests.push({ url, init });
      if (onFetch) return onFetch({ url, init, requests });
      const body = responses.shift();
      if (body === undefined) return Promise.reject(new Error('no scripted response'));
      return Promise.resolve(new Response(body, { status: 200 }));
    },
    onError: (err) => { throw err; },
  });
  return {
    app, container, go: (h) => routeCb(parseHash(h)), requests,
    settings: () => aiData, chat: () => chatData, ledger: () => ledgerData,
  };
}

/** Open the panel (which is also what reads the ledger) and let it settle. */
async function openPanel(site) {
  fire(find(site.container, (n) => n.attributes?.get('class') === 'ai-launch'), 'click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  return serialize(site.container);
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

  it('gates the composer on configuration: a setup intro instead of a dead chat', function () {
    const unconfigured = mountSite();
    fire(find(unconfigured.container, (n) => n.attributes?.get('class') === 'ai-launch'), 'click');
    const html = serialize(unconfigured.container);
    assert.doesNotMatch(html, /ai-composer/, 'no composer until the assistant can actually send');
    assert.match(html, /Pick a provider above/, 'the intro points at the settings form');

    const configured = mountSite({ aiSettings: CONFIGURED });
    fire(find(configured.container, (n) => n.attributes?.get('class') === 'ai-launch'), 'click');
    const configuredHtml = serialize(configured.container);
    assert.match(configuredHtml, /ai-composer/, 'configured: the composer is live');
    assert.doesNotMatch(configuredHtml, /Pick a provider above/);
  });

  it('keeps the settings form up while typing makes the config valid, until saved', function () {
    const { app, container, settings } = mountSite();
    fire(find(container, (n) => n.attributes?.get('class') === 'ai-launch'), 'click');
    assert.strictEqual(app.getState().ai.settingsOpen, true,
      'opening unconfigured pins the settings form open');

    // typing a valid local config must not hide the form mid-edit
    app.dispatch('ai/setting', { key: 'provider' }, { target: { value: 'ollama' } });
    app.dispatch('ai/setting', { key: 'model' }, { target: { value: 'llama3.2' } });
    assert.match(serialize(container), /ai-settings/, 'the form stays up until saved');
    assert.strictEqual(settings(), null, 'nothing persisted before Save');

    app.dispatch('ai/save-settings');
    assert.doesNotMatch(serialize(container), /ai-settings/, 'Save closes the form');
    assert.strictEqual(settings().model, 'llama3.2', 'Save persists the settings');
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

  it('drives the play surface: a tool call navigates, loads inputs and the reply renders', async function () {
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
    // human watches the play surface fill in
    assert.strictEqual(app.getState().route.page, 'play');
    assert.strictEqual(app.getState().play.engine, 'path');
    assert.strictEqual(app.getState().play.source.selector, '$.store.book[*].price');

    // the transcript holds the user turn and the final assistant reply
    const messages = app.getState().ai.messages;
    assert.deepStrictEqual(messages.map((m) => m.role), ['user', 'assistant']);
    assert.match(messages[1].content, /matched two prices/);
    assert.strictEqual(app.getState().ai.status, 'idle');

    // two provider calls: the tool round, then the final answer
    assert.strictEqual(requests.length, 2);
    assert.strictEqual(requests[0].url, 'http://localhost:11434/v1/chat/completions');
    const firstBody = JSON.parse(requests[0].init.body);
    assert.strictEqual(firstBody.messages.at(-1).content, 'get every price',
      'the just-typed user turn reaches the model (not just the pre-send transcript)');
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

  it('persists the transcript and restores it on the next boot', async function () {
    const first = mountSite({
      aiSettings: CONFIGURED,
      responses: [textTurn('hello from the model')],
    });
    first.app.dispatch('ai/draft', null, { target: { value: 'hi' } });
    first.app.dispatch('ai/send');
    await settle(first.app);
    assert.deepStrictEqual(first.chat().messages.map((m) => m.role), ['user', 'assistant'],
      'both turns were mirrored to storage');

    // a fresh boot against the same store resumes the conversation
    const second = mountSite({ aiSettings: CONFIGURED, aiChat: first.chat() });
    assert.deepStrictEqual(second.app.getState().ai.messages.map((m) => m.role),
      ['user', 'assistant']);
    fire(find(second.container, (n) => n.attributes?.get('class') === 'ai-launch'), 'click');
    assert.match(serialize(second.container), /hello from the model/,
      'the restored transcript renders');

    // clearing wipes the persisted transcript too
    second.app.dispatch('ai/clear');
    assert.deepStrictEqual(second.chat().messages, []);
  });

  it('sends the engine-aware system prompt and only the last turns of a long transcript', async function () {
    const seeded = [];
    for (let i = 0; i < 24; i++) {
      seeded.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `turn ${i}` });
    }
    const { app, requests } = mountSite({
      aiSettings: CONFIGURED,
      aiChat: { messages: seeded },
      responses: [textTurn('ok')],
    });
    app.dispatch('ai/draft', null, { target: { value: 'latest' } });
    app.dispatch('ai/send');
    await settle(app);

    const body = JSON.parse(requests[0].init.body);
    assert.strictEqual(body.messages[0].role, 'system');
    assert.match(body.messages[0].content, /JSONPath/, 'the engine list is generated in');
    assert.match(body.messages[0].content, /jaren_get_examples/, 'the method mentions the example tool');
    assert.strictEqual(body.messages.length, 21, 'the system turn + the last 20 chat turns');
    assert.strictEqual(body.messages[body.messages.length - 1].content, 'latest');
  });
});

describe('website — the assistant ledger (a goal that outlives the tab)', function () {
  it('keeps an objective and its progress across a reload, and shows them', async function () {
    const first = mountSite({ aiSettings: CONFIGURED });
    await openPanel(first);
    assert.match(serialize(first.container), /Set an objective/,
      'with no goal the surface is one input');

    first.app.dispatch('ai/goal-draft', null, { target: { value: 'Port the CSV importer.' } });
    first.app.dispatch('ai/goal-set');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.strictEqual(first.app.getState().ai.goal.objective, 'Port the CSV importer.');
    assert.strictEqual(first.app.getState().ai.goalDraft, '',
      'the draft is cleared by what came back from the ledger');
    assert.notStrictEqual(first.ledger(), null, 'the objective went to storage, not just to state');

    // the tab closes and the page reloads: a brand-new app over the same slot
    const second = mountSite({ aiSettings: CONFIGURED, aiLedger: first.ledger() });
    const html = await openPanel(second);
    assert.match(html, /Port the CSV importer\./, 'the objective survived the reload');
    assert.match(html, /Objective/);
  });

  it('puts the objective in front of the model on every turn', async function () {
    const site = mountSite({
      aiSettings: CONFIGURED,
      responses: [textTurn('on it'), textTurn('still on it')],
    });
    site.app.dispatch('ai/goal-draft', null, { target: { value: 'Port the CSV importer.' } });
    site.app.dispatch('ai/goal-set');
    await new Promise((resolve) => setTimeout(resolve, 0));

    site.app.dispatch('ai/draft', null, { target: { value: 'start' } });
    site.app.dispatch('ai/send');
    await settle(site.app);
    site.app.dispatch('ai/draft', null, { target: { value: 'continue' } });
    site.app.dispatch('ai/send');
    await settle(site.app);

    for (const request of site.requests) {
      const body = JSON.parse(request.init.body);
      assert.match(body.messages[0].content, /Port the CSV importer\./,
        'the goal is composed into the system prompt of EVERY request');
    }
    // and never into the transcript the site persists
    assert.ok(site.chat().messages.every((m) => !String(m.content).includes('Port the CSV importer.')
      || m.role === 'user'));
  });

  it('clears an objective without forgetting that it existed', async function () {
    const site = mountSite({ aiSettings: CONFIGURED });
    site.app.dispatch('ai/goal-draft', null, { target: { value: 'A finished thing.' } });
    site.app.dispatch('ai/goal-set');
    await new Promise((resolve) => setTimeout(resolve, 0));

    site.app.dispatch('ai/goal-clear');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.strictEqual(site.app.getState().ai.goal, null);
    const stored = JSON.stringify(site.ledger());
    assert.match(stored, /A finished thing\./,
      'the ledger keeps what this agent was asked to do; the panel just stops showing it');
    assert.match(stored, /abandoned/);
  });

  it('says how many rounds a compacted session archived', async function () {
    // seeded through the ledger's own API over the site's slot adapter —
    // the panel's count must come from what a `recall` could actually
    // reach, not from a counter the panel keeps
    let slot = null;
    const ledger = createLedger({
      storage: createSlotLedgerStorage({
        read: () => slot, write: (data) => { slot = data; },
      }),
    });
    await ledger.putSlot('r-abc-120', '["one archived round"]', { kind: 'agent-round' });
    await ledger.putSlot('r-def-140', '["another"]', { kind: 'agent-round' });
    await ledger.putSlot('rx-1-40', 'the index', { kind: 'agent-round-index' });

    const site = mountSite({ aiSettings: CONFIGURED, aiLedger: slot });
    const html = await openPanel(site);
    assert.strictEqual(site.app.getState().ai.archived, 2, 'the index is not a round');
    assert.match(html, /2 earlier rounds archived/);
    assert.match(html, /recall/, 'a compacted session has to LOOK recoverable');

    // clearing the conversation clears what was archived FROM it: the
    // addresses lived in that transcript's synopsis and nothing else
    site.app.dispatch('ai/clear');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.strictEqual(site.app.getState().ai.archived, 0);
    assert.doesNotMatch(serialize(site.container), /earlier rounds archived/);
    assert.doesNotMatch(JSON.stringify(site.ledger()), /one archived round/,
      'and the bytes are gone from the store, not just from the count');
  });

  it('refines the ledger from a finished run: an evidenced memory, gated and stored', async function () {
    const site = mountSite({
      aiSettings: CONFIGURED,
      responses: [
        textTurn('the importer wants CRLF'),
        // the refinement is a structured (non-streamed) completion
        JSON.stringify({ choices: [{ message: { content: JSON.stringify([
          { op: 'add',
            path: '/memories/-',
            value: { text: 'The importer needs CRLF line endings.', evidence: 'the run above' } },
          { op: 'add',
            path: '/goal/progress/-',
            value: { note: 'Diagnosed the line endings', evidence: 'the run above' } },
        ]) } }] }),
      ],
    });
    await openPanel(site);
    site.app.dispatch('ai/goal-draft', null, { target: { value: 'Port the CSV importer.' } });
    site.app.dispatch('ai/goal-set');
    await new Promise((resolve) => setTimeout(resolve, 0));
    site.app.dispatch('ai/draft', null, { target: { value: 'why does it fail?' } });
    site.app.dispatch('ai/send');
    await settle(site.app);

    site.app.dispatch('ai/remember');
    for (let i = 0; i < 50 && site.app.getState().ai.remembering; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const state = site.app.getState().ai;
    assert.strictEqual(state.remembering, false);
    assert.match(state.remembered, /Remembered 2 evidenced items/);
    assert.strictEqual(state.memories, 1);
    assert.strictEqual(state.goal.progress.length, 1);
    assert.match(serialize(site.container), /Diagnosed the line endings/);
    assert.match(JSON.stringify(site.ledger()), /CRLF line endings/,
      'what was refined is durable, not a label on the screen');
  });

  it('refuses to remember what it has not seen, and says so', async function () {
    const site = mountSite({ aiSettings: CONFIGURED });
    site.app.dispatch('ai/remember');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.match(site.app.getState().ai.remembered, /Nothing to remember yet/);
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
      listenHash: (cb) => { routeCb = cb; cb(parseHash('#/play')); },
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
      'jaren_get_state', 'jaren_navigate', 'jaren_get_examples', 'jaren_save_experiment',
      'jaren_list_experiments', 'jaren_load_experiment', 'jaren_share_link']) {
      assert.ok(names.includes(expected), `${expected} registered`);
    }

    const validate = tool('jaren_validate');
    assert.strictEqual(validate.execute({ schema: { type: 'integer' }, data: 5 }).valid, true);
    assert.strictEqual(validate.execute({ schema: { type: 'integer' }, data: 'no' }).valid, false);

    const run = tool('jaren_run_engine');
    const result = run.execute({ engine: 'path', inputs: { selector: '$.a', data: '{"a":42}' } });
    assert.strictEqual(result.ok, true, 'the run is a green PlayResult');
    assert.match(JSON.stringify(result.panels), /42/);
    assert.strictEqual(app.getState().play.source.selector, '$.a', 'the WebMCP tool drove the play surface too');

    // Jaren validates the model's own tool calls
    assert.match(run.execute({ engine: 'no-such', inputs: {} }).error, /invalid input/);

    // the catalogue lists validate + every engine, with input fields
    const engines = tool('jaren_list_engines').execute({});
    assert.ok('validate' in engines && 'jslt' in engines);
    assert.ok(Array.isArray(engines.path.inputs));

    // get_state reflects what is on screen
    const state = tool('jaren_get_state').execute({});
    assert.strictEqual(state.page, 'play');
    assert.strictEqual(state.engine, 'path');
    assert.strictEqual(state.inputs.selector, '$.a');

    // the experiment store tools: the legacy experiment lists, and
    // loading it translates into a play session
    assert.deepStrictEqual(tool('jaren_list_experiments').execute({}).experiments.map((e) => e.name), ['demo']);
    assert.deepStrictEqual(tool('jaren_load_experiment').execute({ name: 'demo' }), { ok: true });
    assert.strictEqual(app.getState().play.source.selector, '$..price', 'the legacy experiment loaded into play');
    assert.match(tool('jaren_load_experiment').execute({ name: 'nope' }).error, /no experiment/);

    // the share tool builds and copies a play-session link
    assert.strictEqual(tool('jaren_share_link').execute({}).ok, true);
    assert.strictEqual(shared.length, 1);
    assert.match(shared[0], /^#\/play\?s=/);

    const nav = tool('jaren_navigate');
    nav.execute({ page: 'docs', params: { s: 'jslt' } });
    assert.strictEqual(app.getState().route.page, 'docs');
    assert.strictEqual(app.getState().route.params.s, 'jslt');

    // the example library: ready-to-run inputs per engine, by list or label
    const examples = tool('jaren_get_examples');
    const forPath = examples.execute({ engine: 'path' });
    assert.ok(Array.isArray(forPath) && forPath.length > 0);
    assert.strictEqual(typeof forPath[0].label, 'string');
    assert.strictEqual(typeof forPath[0].inputs.selector, 'string');
    assert.deepStrictEqual(examples.execute({ engine: 'path', label: forPath[0].label }), forPath[0]);
    const miss = examples.execute({ engine: 'path', label: 'nope' });
    assert.match(miss.error, /no example/);
    assert.deepStrictEqual(miss.labels, forPath.map((e) => e.label));
    assert.match(examples.execute({ engine: 'no-such' }).error, /invalid input/,
      'Jaren guards the engine enum');

    // saving what was built together, through the same IDE store
    const saved = tool('jaren_save_experiment').execute({ name: 'from-chat' });
    assert.strictEqual(saved.ok, true);
    assert.ok(saved.names.includes('from-chat'), 'the new experiment is listed');
    assert.match(tool('jaren_save_experiment').execute({ name: '' }).error, /invalid input/,
      'Jaren rejects an empty name before the tool runs');

    // ---- the Flow authoring tools ----
    for (const expected of ['jaren_flow_write', 'jaren_flow_patch', 'jaren_flow_check', 'jaren_flow_get_templates']) {
      assert.ok(names.includes(expected), `${expected} registered`);
    }

    // the seed library, then write one in and watch it land at #/flow
    const flowTemplates = tool('jaren_flow_get_templates').execute({});
    assert.ok(flowTemplates.some((t) => t.name === 'review' && t.kind === 'fsm'));
    const review = tool('jaren_flow_get_templates').execute({ name: 'review' });
    const wrote = tool('jaren_flow_write').execute({ kind: 'fsm', doc: review.doc });
    assert.strictEqual(wrote.ok, true);
    assert.strictEqual(app.getState().route.page, 'flow', 'the human is taken to watch it');
    assert.deepStrictEqual(app.getState().flow.doc, review.doc, 'the accepted document is live');

    // a schema-valid but COMPILE-broken machine is rejected with JF errors
    // AS the tool result — the agent loop is the repair loop
    const brokenFsm = {
      initial: 'a', states: ['a', 'b'],
      transitions: [{ from: 'a', event: 'go', to: 'zz' }],   // undeclared target
    };
    const rejected = tool('jaren_flow_write').execute({ kind: 'fsm', doc: brokenFsm });
    assert.strictEqual(rejected.ok, false);
    assert.strictEqual(rejected.errors[0].code, 'JF0006', 'the compiler code is the tool result');
    assert.strictEqual(rejected.errors[0].docPath, '/transitions/0/to');
    assert.deepStrictEqual(app.getState().flow.doc, review.doc, 'the live document is untouched by a rejected write');

    // check is the read-only verdict; patch re-gates
    assert.strictEqual(tool('jaren_flow_check').execute({ kind: 'fsm', doc: brokenFsm }).ok, false);
    assert.strictEqual(tool('jaren_flow_check').execute({ kind: 'fsm', doc: review.doc }).ok, true);
    const patched = tool('jaren_flow_patch').execute({
      patch: [{ op: 'add', path: '/states/-', value: 'archived' }],
    });
    assert.strictEqual(patched.ok, true);
    assert.ok(app.getState().flow.doc.states.includes('archived'), 'the patch applied and re-gated');

    // a dag template writes too, and navigate reaches #/flow
    const enrich = tool('jaren_flow_get_templates').execute({ name: 'enrich' });
    assert.strictEqual(tool('jaren_flow_write').execute({ kind: 'dag', doc: enrich.doc }).ok, true);
    assert.strictEqual(app.getState().flow.kind, 'dag');
    tool('jaren_navigate').execute({ page: 'flow' });
    assert.strictEqual(app.getState().route.page, 'flow');
  });

  it('the dag-gate task stub is a never-called no-op (compileDag resolves handlers, never invokes them)', function () {
    assert.strictEqual(flowGateTaskStub(), null);
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
    // appending a turn runs the ai-persist effect through the no-op
    // default transcript store without throwing
    app.dispatch('ai/user', 'hello');
    assert.strictEqual(app.getState().ai.messages.length, 1);
  });
});

describe('website — the settings connection probe', function () {
  it('a successful probe reports the model count and fills the datalist', async function () {
    const { app, container, requests } = mountSite({
      aiSettings: { provider: 'openrouter', baseUrl: '', model: '', apiKey: 'sk-t' },
      onFetch: ({ url }) => {
        assert.match(url, /\/models$/, 'the probe GETs the models listing');
        return Promise.resolve(new Response(JSON.stringify({
          data: [{ id: 'qwen/a' }, { id: 'qwen/b' }],
        }), { status: 200 }));
      },
    });
    app.dispatch('ai/probe');
    assert.strictEqual(app.getState().ai.probe.status, 'busy', 'busy while in flight');
    await new Promise((resolve) => setTimeout(resolve, 0));

    const probe = app.getState().ai.probe;
    assert.strictEqual(probe.status, 'ok');
    assert.match(probe.detail, /2 models available/);
    assert.deepStrictEqual(probe.models, ['qwen/a', 'qwen/b']);
    assert.strictEqual(requests.length, 1);

    // the panel renders the verdict and the datalist options
    app.dispatch('ai/toggle');
    app.dispatch('ai/settings-open', true);
    const html = serialize(container);
    assert.match(html, /2 models available/);
    assert.match(html, /datalist/);
    assert.match(html, /qwen\/b/);
  });

  it('a failed probe surfaces the error, and editing a setting resets the verdict', async function () {
    const { app, container } = mountSite({
      aiSettings: { provider: 'openrouter', baseUrl: '', model: 'm', apiKey: 'bad' },
      onFetch: () => Promise.resolve(new Response('denied', { status: 401 })),
    });
    app.dispatch('ai/probe');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.strictEqual(app.getState().ai.probe.status, 'fail');
    assert.match(app.getState().ai.probe.detail, /401/);

    app.dispatch('ai/toggle');
    app.dispatch('ai/settings-open', true);
    assert.match(serialize(container), /HTTP 401/);

    // touching any connection setting voids the stale verdict
    app.dispatch('ai/setting', { key: 'apiKey' }, { target: { value: 'sk-new' } });
    assert.strictEqual(app.getState().ai.probe.status, 'idle');
    assert.strictEqual(app.getState().ai.probe.detail, null);
  });
});

describe('website — reasoning-model streaming', function () {
  const reasoningTurn = (thinking, content) => sseBody([
    { choices: [{ delta: { role: 'assistant', reasoning: thinking } }] },
    ...(content === '' ? [] : [{ choices: [{ delta: { content } }] }]),
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
  ]);

  it('counts streamed reasoning and shows it in the thinking line', async function () {
    const { app } = mountSite({
      aiSettings: CONFIGURED,
      responses: [reasoningTurn('let me think this through', 'Done.')],
    });
    app.dispatch('ai/toggle');
    app.dispatch('ai/draft', null, { target: { value: 'question' } });
    app.dispatch('ai/send');
    await settle(app);

    const state = app.getState();
    assert.strictEqual(state.ai.reasoningChars, 'let me think this through'.length);
    assert.strictEqual(state.ai.messages.at(-1).content, 'Done.');
  });

  it('a reasoning-only turn gets the honest reasoning placeholder', async function () {
    const { app, container } = mountSite({
      aiSettings: CONFIGURED,
      responses: [reasoningTurn('thought hard, said nothing', '')],
    });
    app.dispatch('ai/toggle');
    app.dispatch('ai/draft', null, { target: { value: 'question' } });
    app.dispatch('ai/send');
    await settle(app);

    assert.match(app.getState().ai.messages.at(-1).content,
      /spent the whole turn reasoning/);
    assert.match(serialize(container), /reasoning/);
  });
});
