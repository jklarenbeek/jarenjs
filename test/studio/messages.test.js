//@ts-check
/**
 * @file The studio speaks the reader's language. A pseudo-locale (every
 * studio message id rendered as `⟦id⟧`, and the forms' and validator's
 * words beside them) renders the Project IDE shell, the Flow studio and
 * the Data studio in the states a reader meets, and drives the stage's
 * runs, the status lines, a document's boot refusal and render widgets,
 * and the refusals the runtimes write: no English catalog text may show,
 * every word of chrome must carry the mark, and every id must be reached
 * (or, for the few only a live store reaches, used in the source). With
 * no catalog every word is the English it was.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { MessageChannel } from 'node:worker_threads';

import { compileMessageCatalog, compileMessageTemplate } from '@jarenjs/core/message';
import { formsMessagesEn } from '@jarenjs/forms';
import { messagesEn as validateMessagesEn } from '@jarenjs/validate';
import { compileJsltStylesheet } from '@jarenjs/json/jslt';
import { servePort } from '@jarenjs/contract/port';
import { nodeDriver } from '@jarenjs/db/node';
import { studioMessagesEn, studioText } from '@jarenjs/studio';
import {
  createStudioComponent, projectRules, projectModes, createProjectHost, createProjectController,
  createStudioDocumentHost, mountStudioEditor,
} from '@jarenjs/studio/component';
import { FLOW_RULES, FLOW_FORM_RULES, flowPageViewModel, createFlowRuntime, createFlowState, textLossReason } from '@jarenjs/studio/flow';
import {
  DATA_RULES, dataViewModel, createDataState, createDataRuntime, createTransport, oracleSummary, createProjectDataRuntime,
} from '@jarenjs/studio/data';
import { createDataHandlers, dataContract } from '@jarenjs/studio/data/host';
import { tempDbPath } from '../db/helpers.js';
import { createStubHost } from '../view/dom.stub.js';
import { runQuery, runJslt } from '../../packages/website/src/boundaries/engines.js';

const IDS = Object.keys(studioMessagesEn);
const MARK = '⟦';
/** Every studio id the pseudo-locale rendered. */
const reached = new Set();
const mark = (/** @type {string} */ id) => () => { reached.add(id); return `⟦${id}⟧`; };
/** The pseudo-locale: the studio's ids, and the words of the libraries it
 * renders through (the forms' chrome, the validator's errors). */
const PSEUDO = compileMessageCatalog({
  ...Object.fromEntries(Object.keys(formsMessagesEn).map((id) => [id, () => `⟦${id}⟧`])),
  ...Object.fromEntries(Object.keys(validateMessagesEn).map((id) => [id, () => `⟦${id}⟧`])),
  ...Object.fromEntries(IDS.map((id) => [id, mark(id)])),
});
/** The ids no rendering here reaches, each checked in the source instead:
 * what only a live store says (a committed write, a subscription that
 * ends; the website's store tests drive them), a dag run that answers
 * nothing at all, the refusal of a dag the text projection cannot
 * produce, and a forms failure the form widget catches. */
const SOURCE_ONLY = new Set(['studio/store/ready', 'studio/store/committed', 'studio/store/live-failed',
  'studio/store/live-ended', 'studio/data/live-ended', 'studio/run/empty-sequence', 'studio/flow/dag-schema',
  // a disagreement line names the empty sequence when the corpus runs on a
  // live store (run-words.test.js)
  'studio/data/oracle-empty',
  // the forms build every JSON schema a document can hold: the widget's
  // catch is for a forms refusal none can provoke
  'studio/document/form-failed']);

/** Names no language translates: the kinds of file, formats, the stores'
 * own spellings, and the content the fixtures below write. */
const NAMES = new Set([
  'app', 'jslt', 'query', 'state', 'data', 'schema', 'fsm', 'dag', 'model', 'contract',
  'vfs:', 'sqlite', '×', '●', '✓', '—', '·',
]);
/** Classes whose text is content: code, a file's name and kind, the
 * compilers' and engines' own messages, the store's own values, the
 * diagram and the run log. Content may not BE an English message. */
const CONTENT = ['code-block', 'js-file-name', 'js-badge', 'js-editor-kind', 'js-errorline', 'error-line', 'js-penname',
  'flow-canvas', 'flow-log', 'flow-run-current', 'flow-run-buttons', 'data-topology', 'data-vfs', 'data-operators', 'data-boot-stage',
  'data-boot-message', 'data-refusal', 'data-trip-summary', 'js-stage-error', 'flow-run-mount', 'project-data-result', 'project-data-live',
  'project-data-plan'];

/** The English a rendering must not show: each literal entry rendered, and
 * a pattern per parameterized entry or closure. */
const escape = (/** @type {string} */ s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const LITERAL = new Map();
/** @type {[string, RegExp][]} */
const PATTERNS = [];
for (const id of IDS) {
  const entry = studioMessagesEn[id];
  if (typeof entry === 'function') {
    const shapes = [1, 2].map((count) => escape(entry({ count })).replace(/\d+/g, '\\d+'));
    PATTERNS.push([id, new RegExp(`^(?:${shapes.join('|')})$`)]);
    continue;
  }
  const render = compileMessageTemplate(entry);
  if (render.parameters.length === 0) { LITERAL.set(render({}), id); continue; }
  const parts = entry.split(/(\{\{|\{[^{}]*\})/);
  if (!parts.some((part) => !part.startsWith('{') && /\p{L}/u.test(part))) continue;
  const source = parts.map((part) => (part === '{{' ? '\\{' : part.startsWith('{') && part.endsWith('}') ? '[\\s\\S]*?' : escape(part))).join('');
  PATTERNS.push([id, new RegExp(`^${source}$`)]);
}

/** Every string a vnode shows (text, aria-label, title, placeholder), each
 * marked chrome or content; prose islands (`lang="en"`) are not checked.
 * @returns {{ text: string, chrome: boolean }[]} */
function strings(/** @type {any} */ node, chrome = true, /** @type {{ text: string, chrome: boolean }[]} */ out = []) {
  if (typeof node === 'string') { out.push({ text: node, chrome }); return out; }
  if (!Array.isArray(node)) return out;
  if (typeof node[0] !== 'string') { for (const child of node) strings(child, chrome, out); return out; }
  const [tag, maybe, ...rest] = node;
  const attrs = maybe !== null && typeof maybe === 'object' && !Array.isArray(maybe) ? maybe : {};
  const children = attrs === maybe ? rest : [maybe, ...rest];
  if (attrs.lang === 'en') return out;
  const classes = typeof attrs.class === 'string' ? attrs.class.split(' ') : [];
  for (const name of ['aria-label', 'title', 'placeholder']) if (typeof attrs[name] === 'string') out.push({ text: attrs[name], chrome: true });
  // a choice that names a file of the project is the reader's own word
  const named = tag === 'option' && typeof attrs.value === 'string' && attrs.value !== '';
  const inner = chrome && !named && tag !== 'code' && tag !== 'pre' && tag !== 'textarea' && !classes.some((c) => CONTENT.includes(c));
  for (const child of children) strings(child, inner, out);
  return out;
}

/** The same strings, read off a (stub) DOM. */
function domStrings(/** @type {any} */ node, chrome = true, /** @type {{ text: string, chrome: boolean }[]} */ out = []) {
  if (node.nodeType === 3) { out.push({ text: node.nodeValue, chrome }); return out; }
  const attr = (/** @type {string} */ name) => node.getAttribute?.(name) ?? null;
  if (attr('lang') === 'en') return out;
  for (const name of ['aria-label', 'title', 'placeholder']) if (typeof attr(name) === 'string') out.push({ text: attr(name), chrome: true });
  const tag = String(node.tagName ?? '').toLowerCase();
  const classes = String(attr('class') ?? '').split(' ');
  const named = tag === 'option' && typeof attr('value') === 'string' && attr('value') !== '';
  const inner = chrome && !named && tag !== 'code' && tag !== 'pre' && tag !== 'textarea' && !classes.some((c) => CONTENT.includes(c));
  for (const child of node.childNodes ?? []) domStrings(child, inner, out);
  return out;
}

/** What a rendering shows that it must not. @returns {string[]} */
function violations(/** @type {{ text: string, chrome: boolean }[]} */ found, /** @type {string} */ where) {
  const bad = [];
  for (const { text, chrome } of found) {
    for (const segment of String(text).split(/\n| · /).map((s) => s.trim()).filter((s) => s !== '')) {
      if (NAMES.has(segment)) continue;
      if (LITERAL.has(segment)) bad.push(`${where}: English "${segment}" (${LITERAL.get(segment)})`);
      else if (chrome) {
        const pattern = PATTERNS.find(([, re]) => re.test(segment));
        if (pattern) bad.push(`${where}: English "${segment}" (${pattern[0]})`);
        else if (/\p{L}/u.test(segment) && !segment.includes(MARK)) bad.push(`${where}: unmarked chrome "${segment}"`);
      }
    }
  }
  return bad;
}
/** A value the studio wrote must carry the mark and no English. */
function marked(/** @type {unknown} */ text, /** @type {string} */ where) {
  assert.equal(typeof text, 'string', where);
  assert.ok(String(text).includes(MARK), `${where}: "${text}" is not in the reader's language`);
  assert.deepEqual(violations([{ text: String(text), chrome: false }], where), []);
}

// ——— the Project IDE ———

const APP = JSON.stringify({ state: { n: 1 }, view: [{ match: '$', body: ['p', {}, 'n=', '$.n'] }] });
const FILES = [
  { name: 'app.json', kind: 'app', text: APP },
  { name: 'stats.query', kind: 'query', text: '{"m":{"$mean":"$.r[*]"}}' },
  { name: 'bad.query', kind: 'query', text: '{"x":{"$flter":"$"}}' },
  { name: 'seed.data', kind: 'data', text: '{"r":[1,2,3]}' },
  { name: 'notes.model', kind: 'model', text: JSON.stringify({ $model: '0.1', collections: { notes: { schema: { type: 'object' }, key: '/id' } } }) },
  { name: 'by.query', kind: 'query', text: '{"value":"$"}', model: 'notes.model' },
  { name: 'broken.fsm', kind: 'fsm', text: '{}' },
  { name: 'view.jslt', kind: 'jslt', text: '{"$jslt":"0.1","rules":[]}' },
  { name: 'start.state', kind: 'state', text: '{}' },
  { name: 'shape.schema', kind: 'schema', text: '{}' },
  { name: 'pipe.dag', kind: 'dag', text: '{}' },
  { name: 'api.contract', kind: 'contract', text: '{}' },
];
const component = createStudioComponent();
const shell = compileJsltStylesheet({
  $jslt: '0.1', modes: projectModes,
  rules: [{ match: '$', body: { $apply: ['$.ui.project', 'project'] } }, ...projectRules],
});
/** The shell over one project slice, in the pseudo-locale. */
const renderShell = (/** @type {any} */ project) =>
  shell({ ui: { project: { ...component.viewModel({ project }, { messages: PSEUDO }),
    // a template card is its library's words: an English island the check skips
    templates: [{ id: 't', title: 'A template', lead: 'What it shows' }] } } });
const slice = (/** @type {any} */ over = {}) => ({ project: '0.1', files: FILES, active: 'app.json',
  layout: { mode: 'classic', ratio: 0.5, autorun: true }, results: {}, revision: 1, ...over });

const report = (/** @type {any[]} */ errors) => ({ schemaError: null, draft: 'draft-07', compileMs: 0.1, validateMs: 0.1, valid: errors.length === 0, errors });
let validation = report([]);
const host = createProjectHost({
  loadDocument: () => ({ ok: true, app: null }), runQuery: () => [], runJslt: () => [],
  runValidation: () => validation,
});

describe('the Project IDE speaks the reader\'s language', () => {
  it('the shell shows no English in any state a reader meets', () => {
    const shown = [
      slice(),
      slice({ active: 'stats.query', dirty: true }),
      slice({ active: 'by.query' }),
      slice({ active: 'seed.data', buffer: { file: 'seed.data', text: '{}', dirty: true } }),
      slice({ active: 'notes.model' }),
      slice({ active: 'broken.fsm' }),
      slice({ files: [], active: null }),
    ];
    const bad = shown.flatMap((s, i) => violations(strings(renderShell(s)), `shell ${i}`));
    assert.deepEqual(bad, []);
  });

  it('the stage\'s runs title their results, cards and errors in the reader\'s language', async () => {
    const t = { messages: PSEUDO };
    const project = (/** @type {any[]} */ files) => ({ project: '0.1', files, active: files[0].name });
    const titles = (/** @type {any} */ out) => out.nodes.flatMap((/** @type {any} */ n) => (n.kind === 'cards'
      ? n.items.map((/** @type {any} */ c) => c.title) : [n.title]));
    const runs = [
      host.runProjectFile(project([{ name: 'm.model', kind: 'model', text: '{}' }]), 'm.model', { ...t, model: async () => ({ result: [], plan: {} }) }),
      host.runProjectFile(project([{ name: 'm.model', kind: 'model', text: '{}' }]), 'm.model', { ...t, model: async () => { throw new Error('refused'); } }),
      host.runProjectFile(project([{ name: 'q.query', kind: 'query', text: '{}', input: 'missing.data' }]), 'q.query', t),
      host.runProjectFile(project([{ name: 'd.dag', kind: 'dag', text: JSON.stringify({ $dag: '0.1', nodes: { input: { kind: 'input' }, output: { kind: 'output' } }, edges: [{ from: 'input', to: 'output' }], output: 'output' }) }]), 'd.dag', t),
      host.runProjectFile(project([{ name: 'd.dag', kind: 'dag', text: '{"$dag":"0.1"}' }]), 'd.dag', t),
      host.runProjectFile(project([{ name: 'd.dag', kind: 'dag', text: JSON.stringify({ $dag: '0.1', nodes: { input: { kind: 'input' }, q: { kind: 'query', query: { $div: [1, '$'] } }, output: { kind: 'output' } }, edges: [{ from: 'input', to: 'q' }, { from: 'q', to: 'output' }], output: 'output' }) },
        { name: 'x.data', kind: 'data', text: '"x"' }]), 'd.dag', t),
      host.runProjectFile(project([{ name: 'f.fsm', kind: 'fsm', text: JSON.stringify({ $fsm: '0.1', states: ['a'], initial: 'a', transitions: [] }) }]), 'f.fsm', t),
      host.runProjectFile(project([{ name: 'f.fsm', kind: 'fsm', text: '{' }]), 'f.fsm', t),
      host.runProjectFile(project([{ name: 'c.contract', kind: 'contract', text: '{' }]), 'c.contract', t),
      host.runProjectFile(project([{ name: 'c.contract', kind: 'contract', text: '{"$contract":"0.1"}' }]), 'c.contract', t),
      host.runProjectFile(project([{ name: 'c.contract', kind: 'contract', text: JSON.stringify({ $contract: '0.1', operations: { 'echo.say': { kind: 'command', input: { type: 'object', nullable: false }, output: true } } }) }]), 'c.contract', t),
      host.runProjectFile(project([{ name: 's.schema', kind: 'schema', text: '{}' }, { name: 'x.data', kind: 'data', text: '{' }]), 's.schema', t),
    ];
    // the site's query and JSLT runners title their cards and results in the studio's words
    const site = createProjectHost({ loadDocument: () => ({ ok: true, app: null }), runQuery, runJslt, runValidation: () => validation });
    const data = { name: 'x.data', kind: 'data', text: '{"a":[1]}' };
    runs.push(site.runProjectFile(project([{ name: 'q.query', kind: 'query', text: '"$.a[*]"' }, data]), 'q.query', t));
    runs.push(site.runProjectFile(project([{ name: 'q.query', kind: 'query', text: '"$.none[*]"' }, data]), 'q.query', t));
    runs.push(site.runProjectFile(project([{ name: 'q.query', kind: 'query', text: '{' }, data]), 'q.query', t));
    runs.push(site.runProjectFile(project([{ name: 'j.jslt', kind: 'jslt', text: '[]' }, data]), 'j.jslt', t));
    validation = { ...report([]), schemaError: 'the schema is not JSON' };
    runs.push(host.runProjectFile(project([{ name: 's.schema', kind: 'schema', text: '{}' }]), 's.schema', t));
    validation = report([]);
    runs.push(host.runProjectFile(project([{ name: 's.schema', kind: 'schema', text: '{}' }]), 's.schema', t));
    validation = report([{ instancePath: '/a', keyword: 'type', msgid: 'type', params: { type: 'string' }, message: 'must be string' }]);
    runs.push(host.runProjectFile(project([{ name: 's.schema', kind: 'schema', text: '{}' }]), 's.schema', t));
    const outs = await Promise.all(runs);
    for (const [i, out] of outs.entries()) {
      // a coded error titles itself by its code (or a schema error by its
      // keyword); the two projections are named by what they are
      for (const title of titles(out)) if (!/^J[A-Z]\d{4}$|^[a-z]+$|^describe\(\)$|^OpenAPI 3\.1$/.test(title)) marked(title, `run ${i}`);
    }
    const last = /** @type {any} */ (outs.at(-1)).nodes;
    marked(last[0].items[0].value, 'the error count');
    // the validator's own words, through validate's localizer
    assert.equal(last[1].message, '⟦type⟧');
    const refusal = outs.find((/** @type {any} */ out) => String(out.nodes[0]?.message).includes('data-invalid-json'));
    marked(/** @type {any} */ (refusal)?.nodes[0].message, 'data JSON refusal');
  });

  it('the project\'s download status lines speak the reader\'s language', async () => {
    let state = { project: { ...slice(), name: 'p' } };
    const app = { getState: () => state, dispatch() {}, subscribe: () => () => {} };
    const lines = [];
    const dispatch = (/** @type {string} */ action, /** @type {any} */ payload) => { if (action === 'ide/shared') lines.push(payload); };
    for (const download of [() => true, () => false]) {
      const controller = createProjectController({ getApp: () => app, host, download, exportProject: async () => download(), messages: () => PSEUDO });
      controller.effects['project-download']({}, dispatch);
      controller.effects['project-export']({}, dispatch);
      await controller.effects['project-eject']({}, dispatch);
    }
    const controller = createProjectController({ getApp: () => app, host, messages: PSEUDO });
    state = { project: { ...slice({ files: [FILES[1]], active: 'stats.query' }), name: 'p' } };
    controller.effects['project-download']({}, dispatch);
    state = { project: { ...slice({ files: [{ name: 'a.json', kind: 'app', text: '{' }], active: 'a.json' }), name: 'p' } };
    controller.effects['project-download']({}, dispatch);
    assert.equal(lines.length, 10);
    for (const line of lines) marked(line, 'status line');
  });

  it('a document\'s boot refusal and its form and chart widgets speak the reader\'s language', () => {
    const documents = createStudioDocumentHost({ markdown: () => ['p', {}, 'md'], diagram: () => ['p', {}, 'mm'] });
    for (const doc of [{}, { view: 1 }]) {
      const refused = documents.loadStudioDocument(doc, { messages: PSEUDO });
      assert.equal(refused.ok, false);
      marked(/** @type {any} */ (refused).message, 'the meta-schema refusal');
    }
    const { container, document } = createStubHost();
    const doc = { state: {}, view: [{ match: '$', body: ['div', {},
      ['jaren-widget', { name: 'form', props: { schema: null } }],
      ['jaren-widget', { name: 'form', props: { schema: { type: 'object', properties: { n: { type: 'integer', title: '⟦field⟧' }, l: { type: 'array', title: '⟦list⟧', items: { type: 'string', title: '⟦item⟧' } }, j: { title: '⟦json⟧' } } }, data: { n: 'x', l: ['a'] } } }],
      ['jaren-widget', { name: 'chart', props: { config: { type: 'nope' } } }]] }] };
    const loaded = documents.loadStudioDocument(doc, { node: container, document, schedule: (f) => f(), messages: PSEUDO });
    assert.equal(loaded.ok, true);
    const bad = violations(domStrings(container), 'document widgets');
    assert.deepEqual(bad, []);
    for (const id of ['studio/document/form-no-schema', 'studio/document/chart-failed']) assert.ok(reached.has(id), id);
    // the same widgets, English when no catalog is given
    assert.equal(documents.loadStudioDocument({}, {}).message,
      'the document does not validate against the jaren-app meta-schema (1 error)');
  });

  it('the whole editor mounts in the reader\'s language', () => {
    const { container } = createStubHost();
    const editor = mountStudioEditor(container, { project: { project: '0.1', files: FILES.slice(0, 4), active: 'stats.query' }, host,
      schedule: (f) => f(), messages: () => PSEUDO });
    try { assert.deepEqual(violations(domStrings(container), 'mounted editor'), []); }
    finally { editor.dispose(); }
  });
});

// ——— the Flow studio ———

const flowSheet = compileJsltStylesheet({
  $jslt: '0.1', modes: { flow: { unmatched: 'error' } },
  rules: [{ match: '$', body: { $apply: ['$.ui.flow', 'flow'] } }, ...FLOW_RULES, ...FLOW_FORM_RULES],
});
const FSM = { $fsm: '0.1', states: ['a', 'b'], initial: 'a', transitions: [{ from: 'a', event: 'go', to: 'b' }] };
const DAG = { $dag: '0.1', nodes: { input: { kind: 'input' }, t: { kind: 'task', run: 't' }, output: { kind: 'output' } },
  edges: [{ from: 'input', to: 't' }, { from: 't', to: 'output' }], output: 'output' };
const flow = (/** @type {any} */ over) => ({ ...createFlowState(), ...over });
const renderFlow = (/** @type {any} */ state, /** @type {any[]} */ templates = []) =>
  flowSheet({ ui: { flow: flowPageViewModel(state, templates, { messages: PSEUDO }) } });

describe('the Flow studio speaks the reader\'s language', () => {
  it('the picker, the canvas, the inspector and the run pane show no English', () => {
    const shown = [
      flow({}),
      flow({ kind: 'fsm', doc: FSM, selection: { type: 'transition', index: 0, path: '/transitions/0' }, connect: null,
        history: { past: [1], future: [1] } }),
      flow({ kind: 'fsm', doc: FSM, selection: { type: 'state', id: 'a', path: '/states/0' }, connect: { from: 'a' } }),
      flow({ kind: 'fsm', doc: { ...FSM, states: [{ id: 'a', final: true }, 'b'] }, tab: 'text', parseError: 'bad' }),
      flow({ kind: 'fsm', doc: FSM, tab: 'text', run: { current: 'a', prev: null, log: [] } }),
      flow({ kind: 'dag', doc: DAG, selection: { type: 'edge', index: 0, path: '/edges/0' } }),
      flow({ kind: 'dag', doc: DAG, selection: { type: 'node', id: 't', path: '/nodes/t' },
        run: { running: true, nodes: {}, log: [{ node: 't' }], output: [1], error: 'failed' } }),
    ];
    const bad = shown.flatMap((s, i) => violations(strings(renderFlow(s, [{ name: 'x', title: 'Seed', lead: 'A seed', doc: FSM }])), `flow ${i}`));
    assert.deepEqual(bad, []);
    for (const [kind, doc] of [['fsm', { ...FSM, transitions: [{ from: 'a', to: 'b', guard: { $eq: [1, 1] } }] }],
      ['fsm', { ...FSM, transitions: [{ from: 'a', to: 'b', effects: [{ run: 'x', with: {} }] }] }],
      ['dag', { ...DAG, nodes: { ...DAG.nodes, t: { kind: 'query', query: {} } } }],
      ['dag', { ...DAG, edges: [{ from: 'input', to: 't', select: {} }, DAG.edges[1]] }]]) {
      marked(textLossReason(/** @type {any} */ (kind), doc, PSEUDO), `text loss ${kind}`);
    }
  });

  it('the runtime\'s refusals and the running machine speak the reader\'s language', async () => {
    const runtime = createFlowRuntime({ messages: () => PSEUDO, schedule: (f) => f(),
      tasks: { t: async () => { throw new Error('task failed'); } } });
    const seen = [];
    const dispatch = (/** @type {string} */ action, /** @type {any} */ payload) => seen.push([action, payload]);
    runtime.effects['flow-parse']({ kind: 'fsm', text: 'flowchart LR\n  a --> b' }, dispatch);
    await runtime.effects['flow-dag-run']({ doc: DAG, inputText: '{' }, dispatch);
    await runtime.effects['flow-dag-run']({ doc: DAG, inputText: '[]' }, dispatch);
    const messages = seen.filter(([action]) => action === 'flow/parse-error' || action === 'flow/dag-fail').map(([, p]) => p.message);
    assert.equal(messages.length, 3, JSON.stringify(seen));
    for (const text of messages) marked(text, 'flow refusal');
    const { container, document } = createStubHost();
    const handle = runtime.widget.mount(container, { doc: FSM, revision: 1, context: null }, () => {});
    try { assert.deepEqual(violations(domStrings(container), 'running machine'), []); }
    finally { runtime.widget.unmount(handle); runtime.dispose(); }
    void document;
  });
});

// ——— the Data studio ———

const dataSheet = compileJsltStylesheet({
  $jslt: '0.1', modes: { data: { unmatched: 'error' } },
  rules: [{ match: '$', body: { $apply: ['$.ui.data', 'data'] } }, ...DATA_RULES],
});
const TRIP = { texts: { stylesheet: '{}', model: '{}', query: '{}', region: '{}' }, chainText: 'q', summary: () => 'tripped', map: () => null };
const data = (/** @type {any} */ over) => ({ data: { ...createDataState(), collection: 'notes', ...over } });
const renderData = (/** @type {any} */ state, /** @type {any} */ options = {}) =>
  dataSheet({ ui: { data: dataViewModel(state, { trip: TRIP, features: { oracle: true }, migration: () => null, ...options, messages: PSEUDO }) } });
const ORACLE = { status: 'done', executor: 'sqlite', agreed: 2, ran: 3, entries: 3, mappings: ['plain'], skipped: [], disagreements: ['x'], results: [] };

describe('the Data studio speaks the reader\'s language', () => {
  it('every pane shows no English, booting, failed or ready', () => {
    const explain = { sql: 'SELECT 1', params: [], indexes: [], residual: null };
    const shown = [
      [data({}), {}],
      [data({ status: 'error', boot: { stage: 'sqlite-init', message: 'no wasm' } }), {}],
      [data({ status: 'ready', topology: 'owner', vfs: 'opfs-sab', rows: [{ id: 'a' }, {}], explain,
        migration: { planned: ['add index'], applied: [1], note: 'ok' }, oracle: ORACLE,
        trip: { csv: 'a', report: { status: 'done', results: [], explain: { sql: 's', prefilters: [], scanNarrative: 'n', indexes: [], residual: null } } } }), { createRow: () => ({}) }],
      [data({ status: 'ready', topology: 'client', vfs: 'indexeddb-snapshot', capture: '—', oracle: { status: 'running' } }), {}],
      [data({ status: 'ready', topology: 'owner', vfs: 'opfs-sahpool', operators: ['$sqrt'], pushableOperators: ['$sqrt'],
        oracle: { ...ORACLE, agreed: 3, disagreements: [] } }), {}],
      [data({ status: 'ready', topology: 'memory', vfs: 'memory', oracle: { status: 'error', message: 'no' } }), {}],
    ];
    const bad = shown.flatMap(([s, o], i) => violations(strings(renderData(s, o)), `data ${i}`));
    assert.deepEqual(bad, []);
  });

  it('the refusals the runtime writes speak the reader\'s language', async (t) => {
    const { dbPath, cleanup } = tempDbPath();
    const releases = [];
    const transport = () => createTransport({
      spawnWorker() {
        const { port1, port2 } = new MessageChannel();
        const table = createDataHandlers({
          init: async () => ({ topology: 'owner', vfs: 'node', version: '3' }),
          makeDriver: () => nodeDriver(), makeScratchDriver: () => nodeDriver(), path: () => dbPath,
          vfs: () => 'node', durable: () => true, unlink: () => { rmSync(dbPath, { force: true }); },
          announce: (notice) => port1.postMessage(notice), operators: undefined,
        });
        const server = servePort(dataContract, table.handlers, { channel: port1 });
        /** @type {any} */ (port2).terminate = () => { server.close(); port1.close(); port2.close(); releases.push(table.dispose()); };
        queueMicrotask(() => port1.postMessage({ ready: true }));
        return port2;
      },
      openChannel() { throw new Error('a private test store joins no channel'); },
    });
    const model = { $model: '0.1', collections: { notes: { schema: { type: 'object' }, key: '/id' } } };
    let pipeline = () => ({ valid: false, errors: [], rows: [] });
    const runtime = createDataRuntime({ model, query: [], transport, lifecycleTarget: {}, messages: () => PSEUDO,
      trip: { csv: '', pipeline: () => pipeline() } });
    t.after(async () => { runtime.dispose(); await Promise.all(releases); cleanup(); });
    const seen = [];
    const dispatch = (/** @type {string} */ action, /** @type {any} */ payload) => seen.push([action, payload]);
    await runtime.effects['data-insert']({ title: 'x' }, dispatch);
    await runtime.effects['data-trip']({ csv: '' }, dispatch);
    await runtime.effects['data-oracle']({}, dispatch);
    await runtime.effects['data-boot']({}, dispatch);
    await runtime.effects['data-open']({ text: '{' }, dispatch);
    await runtime.effects['data-insert']({ title: '{' }, dispatch);
    await runtime.effects['data-trip']({ csv: '' }, dispatch);
    pipeline = () => ({ valid: false, errors: [{ instancePath: '', message: 'm' }], rows: [] });
    await runtime.effects['data-trip']({ csv: '' }, dispatch);
    const messages = seen.filter(([action, p]) => ['data/error', 'data/oracle', 'data/trip'].includes(action) && p?.status !== 'running')
      .map(([, p]) => p.message);
    assert.equal(messages.length, 7, JSON.stringify(seen));
    for (const text of messages) marked(text, 'data refusal');
  });

  it('the project\'s private store widget speaks the reader\'s language', () => {
    const runtime = createProjectDataRuntime({ createWorker: () => ({ postMessage() {}, addEventListener() {}, removeEventListener() {},
      terminate() {}, start() {} }), messages: PSEUDO });
    const { container } = createStubHost();
    const files = [{ name: 'n.model', kind: 'model', text: JSON.stringify({ $model: '0.1', collections: { notes: { schema: { type: 'object' }, key: '/id' } } }) }];
    const handle = runtime.widget.mount(container, { files, name: 'n.model', revision: 1 });
    try { assert.deepEqual(violations(domStrings(container), 'store widget'), []); }
    finally { runtime.widget.unmount(handle); runtime.dispose(); }
  });
});

// ——— the catalog itself ———

/** Every source file of the studio package. @returns {string[]} */
function sources(/** @type {string} */ dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sources(path) : name.endsWith('.js') && name !== 'messages.js' ? [path] : [];
  });
}

describe('the studio catalog', () => {
  it('every id is reached by a rendering above, or used in the source when only a live store reaches it', () => {
    // the site's runners (packages/website/src/boundaries/engines.js) speak the
    // studio's words for the runs its project host renders
    const text = [...sources(join(import.meta.dirname, '../../components/studio/src')),
      join(import.meta.dirname, '../../packages/website/src/boundaries/engines.js')].map((p) => readFileSync(p, 'utf8')).join('\n');
    const unused = IDS.filter((id) => !text.includes(`'${id}'`)
      && !(id.startsWith('studio/role/') && text.includes('`studio/role/${kind}`'))
      && !(/^studio\/flow\/(?:selected|target)-/.test(id) && text.includes('`studio/flow/${as}-${selection.type}`')));
    assert.deepEqual(unused, [], 'every id is used in the source');
    const unreached = IDS.filter((id) => !reached.has(id) && !SOURCE_ONLY.has(id));
    assert.deepEqual(unreached, []);
  });

  it('without a catalog every id renders its English, closures included', () => {
    const t = studioText();
    assert.equal(t('studio/run/error-count', { count: 1 }), '1 error');
    assert.equal(t('studio/run/error-count', { count: 2 }), '2 errors');
    assert.equal(t('studio/document/invalid', { count: 2 }),
      'the document does not validate against the jaren-app meta-schema (2 errors)');
    assert.equal(t('studio/project/file-count', { count: 1 }), '1 files');
    assert.equal(t('no/such/id'), 'no/such/id');
    // a translation that throws, or answers no string, renders the English
    const broken = studioText(compileMessageCatalog({ 'studio/project/run': () => { throw new Error('x'); } }));
    assert.equal(broken('studio/project/run'), 'Run');
    assert.equal(studioText({ 'studio/project/run': () => 7 })('studio/project/run'), 'Run');
    assert.equal(oracleSummary(null), '');
    assert.equal(textLossReason('fsm', FSM), null);
  });
});
