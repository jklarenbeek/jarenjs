//@ts-check
/**
 * The site assistant boundary — browser-side AI, dogfooded.
 *
 * One @jarenjs/ai toolbox exposes the play engines as schema-guarded
 * tools (Jaren validates the model's own tool calls before they run);
 * two surfaces consume it:
 *
 *  - the embedded chat panel drives it through a bounded agent loop
 *    against a bring-your-own-key OpenAI-compatible endpoint
 *    (OpenRouter / Ollama / LM Studio), and
 *  - a browser-hosted agent drives the identical tools over WebMCP
 *    (`navigator.modelContext`) — see `registerSiteWebMcp`.
 *
 * Tools don't just answer: they navigate the site and load inputs, so
 * the human watches the play surface fill in as the model works. The
 * key never leaves the page — no server, no proxy.
 */

import {
  createChatClient, createAgent, createToolbox, registerModelContext, PROVIDERS,
  probeProvider, composeChecks, checkOutcome, createRefiner,
} from '@jarenjs/ai';

import { applyJSONPatch, compileJSONPointer, JSONPOINTER_NOTHING } from '@jarenjs/json';
import { compileFsm, compileDag } from '@jarenjs/flow';
import { JarenValidator } from '@jarenjs/validate';
import { jsonFormats } from '@jarenjs/formats';
import { OUR_SCHEMA_OPTIONS } from '../lib/schema-options.js';

import fsmSchema from '@jarenjs/flow/schemas/jaren-fsm.schema.json' with { type: 'json' };
import dagSchema from '@jarenjs/flow/schemas/jaren-dag.schema.json' with { type: 'json' };
import querySchema from '@jarenjs/json/schemas/jaren-query.schema.json' with { type: 'json' };
import jsltSchema from '@jarenjs/json/schemas/jaren-jslt.schema.json' with { type: 'json' };

import { runValidation } from './validator.js';
import { operatorRegistry } from './engines.js';
import { playComponent, runPlay, legacyExperimentToSession } from './play.js';
import { validateAppDocument, auditDocumentRender } from './studio.js';
import { commitProject, projectAppFile, projectComponent, runProjectFile } from './project.js';
import { STUDIO_TEMPLATES, studioTemplate } from '../content/appTemplates.js';
import { FLOW_TEMPLATES, flowTemplate } from '../content/flowTemplates.js';

// The flow authoring gate: schema-validate, THEN compile — one injected
// check per kind, built from the shipped `composeChecks` and the
// two-line compile-gate adapter (the engine-agnostic recipe, applied to
// flow). A rejected document returns its JF errors AS the tool result,
// so the agent loop is the repair loop — no second mechanism.
const compileGate = (compile) => (doc) => {
  try {
    compile(doc);
    return true;
  }
  catch (err) {
    const e = /** @type {any} */ (err);
    return { valid: false, errors: [{ code: e.code, docPath: e.docPath, message: e.reason ?? e.message }] };
  }
};
/**
 * The registry stub the dag gate compiles against: `compileDag` only
 * needs each task name to resolve to a FUNCTION (it validates the wiring
 * and resolves handlers, but never calls them at compile time), so one
 * shared no-op stands in for every task while gating. The real handlers
 * are the caller's at run time. Exported so its trivial contract is
 * covered directly — the gate never invokes it.
 * @returns {null}
 */
export const flowGateTaskStub = () => null;

const FLOW_CHECKS = {
  fsm: composeChecks(
    new JarenValidator({ ...OUR_SCHEMA_OPTIONS, skipErrors: true })
      .addFormats(jsonFormats).addSchema(querySchema).compile(fsmSchema),
    compileGate(compileFsm)),
  // a dag needs its task registry to compile; the assistant checks
  // STRUCTURE (schema) + acyclicity/ports/output against a registry
  // stubbed from the document's own task names, so a document naming a
  // handler still passes the shape gate
  dag: composeChecks(
    new JarenValidator({ ...OUR_SCHEMA_OPTIONS, skipErrors: true })
      .addFormats(jsonFormats).addSchema(querySchema).addSchema(jsltSchema).compile(dagSchema),
    compileGate((doc) => {
      /** @type {Record<string, any>} */
      const tasks = {};
      for (const node of Object.values(doc?.nodes ?? {})) {
        if (node?.kind === 'task' && typeof node.run === 'string') tasks[node.run] = flowGateTaskStub;
      }
      return compileDag(doc, { tasks });
    })),
};

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

/** JSON text in, value out — non-JSON text stays the string it was. */
function parseJsonText(text) {
  try {
    return JSON.parse(text);
  }
  catch {
    return text;
  }
}

/** The engine catalogue the model sees (every play descriptor). */
function engineCatalogue() {
  /** @type {any} */
  const out = {};
  for (const [key, engine] of Object.entries(playComponent.engines)) {
    out[key] = {
      label: engine.label,
      lead: engine.lead ?? '',
      inputs: [
        ...engine.sourcePanes.map((p) => ({ key: p.key, kind: 'source', control: p.control ?? 'code' })),
        ...engine.dataPanes.map((p) => ({ key: p.key, kind: 'data', control: 'json' })),
        ...(engine.optionPanes ?? []).map((p) => ({
          key: p.key, kind: 'option', options: p.choices.map((c) => c.value), default: p.default,
        })),
      ],
    };
    // the jslt/query/jtlt engines mount the operator packs here, so the
    // model sees the exact registered vocabulary it may use (host opt-in)
    if (key === 'jslt' || key === 'query' || key === 'jtlt') {
      out[key].registeredOperators = operatorRegistry.names();
    }
  }
  return out;
}

/**
 * Build the site toolbox: engine tools that both drive the visible
 * play surface and return the results the model needs. Shared by the
 * chat panel and the WebMCP bridge.
 * @param {{ getApp: () => any, navigate?: (hash: string) => void,
 *   share?: (hash: string) => string | undefined, docStore: any,
 *   playStore?: any }} env
 */
export function createSiteToolbox(env) {
  const toolbox = createToolbox();
  const engineKeys = playComponent.engineIds().filter((k) => k !== 'validate');
  const go = (hash) => env.navigate?.(hash);

  /** Load a play session into the visible surface (the human watches). */
  const playLoad = (session) => {
    const app = env.getApp();
    if (app === null) return;
    go('#/play');
    app.dispatch('play/loaded-session', { ...session, name: '' });
  };

  toolbox.add({
    name: 'jaren_validate',
    description: 'Validate a JSON document against a JSON Schema with the Jaren validating compiler, loading both into #/play so the user sees the result. Pass `schema` as a real JSON object (not JSON text). Returns { valid, errors, draft, compileMs, validateMs }.',
    inputSchema: {
      type: 'object',
      properties: { schema: { type: ['object', 'boolean'] }, data: {} },
      required: ['schema'],
    },
    execute: (input) => {
      const schemaText = JSON.stringify(input.schema, null, 2);
      // models often hand the document over as JSON text — accept it
      const data = typeof input.data === 'string' ? parseJsonText(input.data) : (input.data ?? null);
      playLoad(legacyExperimentToSession('validate', { schemaText, data }));
      return runValidation(schemaText, data);
    },
  });

  toolbox.add({
    name: 'jaren_run_engine',
    description: `Run one of the Jaren play engines (${engineKeys.join(', ')}) with flat text inputs (JSON values as JSON text; each key is one of the engine's panes from jaren_list_engines), loading them into #/play so the user watches it run. JSON Schema validation is NOT an engine here — use jaren_validate for that. Returns the result panels the play stage itself shows ({ ok, panels, timing, error } — errors carry stable codes).`,
    inputSchema: {
      type: 'object',
      properties: {
        engine: { enum: engineKeys },
        inputs: { type: 'object', additionalProperties: { type: 'string' } },
      },
      required: ['engine', 'inputs'],
    },
    execute: (input) => {
      const session = legacyExperimentToSession(input.engine, input.inputs);
      if (session === null) return { error: `unknown engine: ${input.engine}` };
      playLoad(session);
      return runPlay(session);
    },
  });

  toolbox.add({
    name: 'jaren_list_engines',
    description: 'List the available play engines with their input panes (source / data / option).',
    inputSchema: { type: 'object', properties: {} },
    execute: () => engineCatalogue(),
  });

  toolbox.add({
    name: 'jaren_get_state',
    description: 'Read what is currently on screen: the active page, and the working surface it carries — on #/play the selected engine and its pane texts, on #/project the project\'s files (with which one is open and which have errors). Call this before editing so you build on what the user already has.',
    inputSchema: { type: 'object', properties: {} },
    execute: () => {
      const app = env.getApp();
      if (app === null) return { page: 'unknown' };
      const state = app.getState();
      if (state.route.page === 'play') {
        return {
          page: 'play',
          engine: state.play.engine,
          inputs: { ...state.play.source, ...state.play.data, ...state.play.config },
        };
      }
      // the project surface answers with its FILES: a project is a file
      // tree, so "what is on screen" that omitted them would invite the
      // model to describe a project it cannot see
      if (state.route.page === 'project') return { page: 'project', ...projectSummary(state.project) };
      return { page: state.route.page, engine: null, inputs: null };
    },
  });

  toolbox.add({
    name: 'jaren_navigate',
    description: 'Navigate the site to a page, optionally with params (e.g. { page: "docs", params: { s: "query" } }).',
    inputSchema: {
      type: 'object',
      properties: {
        page: { enum: ['home', 'studio', 'project', 'play', 'flow', 'benchmarks', 'charts', 'docs', 'calculator'] },
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
    name: 'jaren_get_examples',
    description: 'Get the site\'s working examples for one engine — play\'s canonical library. Each is { label, inputs } and runs as-is through jaren_run_engine (engine \'validate\': pass the schema/data to jaren_validate instead). Before writing a program for an engine you have not used this conversation, fetch its examples and adapt one instead of guessing syntax. Pass `label` to get a single example.',
    inputSchema: {
      type: 'object',
      properties: { engine: { enum: playComponent.engineIds() }, label: { type: 'string' } },
      required: ['engine'],
    },
    execute: (input) => {
      const all = playComponent.examples
        .filter((e) => e.engine === input.engine)
        .map((e) => ({
          label: e.label,
          // flatten to the jaren_run_engine input shape: source panes +
          // the first dataset's data pane(s) + the option config
          inputs: { ...e.source, ...(e.datasets[0]?.data ?? {}), ...(e.config ?? {}) },
        }));
      if (input.label === undefined) return all;
      const hit = all.find((e) => e.label === input.label);
      return hit ?? { error: `no example labelled '${input.label}'`, labels: all.map((e) => e.label) };
    },
  });

  // ---- the Studio (#/project): the project as a FILE TREE ----

  /**
   * A run's render nodes as text the model can act on. The stage speaks
   * in render nodes; a tool result has to say what the human is looking
   * at — above all the CODED errors, which are the repair instructions.
   * @param {any[]} nodes
   */
  const renderedText = (nodes) => (nodes ?? []).map((n) => {
    if (n === null || typeof n !== 'object') return String(n);
    if (n.kind === 'error') {
      return `ERROR ${n.title}: ${n.message}${n.detail === null ? '' : ` (${n.detail})`}`;
    }
    if (n.kind === 'code') return `${n.title ?? 'output'}: ${n.text}`;
    if (n.kind === 'cards') return n.items.map((i) => `${i.title}: ${i.value}`).join(' · ');
    if (n.kind === 'p' || n.kind === 'callout') return n.text;
    return null;
  }).filter((line) => line !== null).join('\n');

  /** Every file with its kind and validity — the project seen as a
   * codebase, which is what the surface actually is. */
  const projectSummary = (slice) => {
    const d = projectComponent.describe({
      project: slice.project ?? '0.1',
      files: slice.files ?? [],
      active: slice.active ?? null,
      layout: slice.layout,
    });
    return {
      name: slice.name ?? 'Untitled project',
      active: d.active,
      files: d.files.map((f) => ({
        name: f.name, kind: f.kind, role: f.role, size: f.size,
        valid: f.valid, errors: f.errors,
      })),
    };
  };

  /** The project slice, or null when the site is not running. */
  const projectSlice = () => env.getApp()?.getState().project ?? null;

  toolbox.add({
    name: 'jaren_project_files',
    description: 'The Studio project (#/project) is a TREE OF FILES — an app document beside the jslt/query/schema transforms and the state/data they run on. Without a name you get every file (kind, role, size, whether it validates, and its coded errors) plus which one is open. With a name you also get that file\'s full text. ALWAYS call this before answering anything about "the project", "my files" or "the studio" — the app document is only ONE of the files.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
    },
    execute: (input) => {
      const slice = projectSlice();
      if (slice === null) return { error: 'the site is not running here' };
      const summary = projectSummary(slice);
      if (input.name === undefined) return summary;
      const file = (slice.files ?? []).find((f) => f.name === input.name);
      if (file === undefined) {
        return { error: `no file named '${input.name}'`, names: summary.files.map((f) => f.name) };
      }
      const meta = summary.files.find((f) => f.name === input.name);
      return { ...meta, text: file.text };
    },
  });

  toolbox.add({
    name: 'jaren_project_write',
    description: 'Create or replace ONE file in the Studio project and open it, so the user watches it land. `kind` is required for a new file (app / jslt / query / schema / state / data) and optional when replacing. The file is validated against its OWN kind\'s grammar first — an invalid write is rejected and the current file is left alone, with the coded errors returned to repair. A runnable file (jslt / query / schema) is also RUN against the project\'s data file and its result comes back. Use this for every non-app file; use jaren_studio_write for a whole app document.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1 },
        kind: { enum: ['app', 'jslt', 'query', 'schema', 'state', 'data'] },
        text: { type: 'string' },
      },
      required: ['name', 'text'],
    },
    execute: (input) => {
      const app = env.getApp();
      const slice = projectSlice();
      if (app === null || slice === null) return { error: 'the site is not running here' };
      const existing = (slice.files ?? []).find((f) => f.name === input.name);
      const kind = input.kind ?? existing?.kind;
      if (kind === undefined) {
        return { error: `'${input.name}' is a new file, so it needs a kind (app / jslt / query / schema / state / data)` };
      }
      const candidate = { name: input.name, kind, text: input.text };
      const verdict = projectComponent.validateFile(candidate);
      if (!verdict.valid) {
        return {
          ok: false,
          errors: verdict.errors,
          total: verdict.total,
          hint: `The ${kind} file does not validate, so it was NOT written — the project is untouched. Each error carries a code and a docPath into your document; repair those and write again.`,
        };
      }
      go('#/project');
      const files = existing === undefined
        ? [...slice.files, candidate]
        : slice.files.map((f) => (f.name === input.name ? candidate : f));
      // a new file changes the tree (structural); a replacement is a text
      // edit — both land through the actions the human's own edits use
      app.dispatch(existing === undefined ? 'project/added' : 'project/files-set', { files, active: input.name });
      if (existing !== undefined) app.dispatch('project/active', input.name);
      app.dispatch('project/committed', commitProject(app.getState().project));
      const result = runProjectFile(app.getState().project, input.name);
      if (result !== null) app.dispatch('project/result', { name: input.name, result });
      return {
        ok: true,
        file: input.name,
        kind,
        ...(kind === 'app' ? { widgets: auditDocumentRender(JSON.parse(input.text)).widgets } : {}),
        ...(result === null ? {} : { ran: renderedText(result.nodes) }),
      };
    },
  });

  toolbox.add({
    name: 'jaren_project_run',
    description: 'Run one file of the Studio project against the project\'s data file and return what the stage shows (a query/jslt transform output, or a schema validation report). Without a name the OPEN file runs. Use it to check a file you did not just write, or to re-run after editing the data.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
    },
    execute: (input) => {
      const app = env.getApp();
      const slice = projectSlice();
      if (app === null || slice === null) return { error: 'the site is not running here' };
      const name = input.name ?? slice.active;
      const file = (slice.files ?? []).find((f) => f.name === name);
      if (file === undefined) {
        return { error: `no file named '${name}'`, names: (slice.files ?? []).map((f) => f.name) };
      }
      const result = runProjectFile(slice, name);
      if (result === null) {
        return { error: `'${name}' is a ${file.kind} file — it is an input, not something that runs. Run a jslt, query or schema file instead.` };
      }
      go('#/project');
      app.dispatch('project/active', name);
      app.dispatch('project/result', { name, result });
      return { ok: true, file: name, kind: file.kind, ran: renderedText(result.nodes) };
    },
  });

  // ---- the Studio: authoring the project's app document ----

  /** The project's designated app file's document, or null (no app file,
   * or its text does not parse — either way there is nothing to patch). */
  const studioDoc = () => {
    const project = env.getApp()?.getState().project;
    const file = project === undefined ? null : projectAppFile(project);
    if (file === null) return null;
    try { return JSON.parse(file.text); }
    catch { return null; }
  };

  /** Validate + write a document into the project's app file, navigating
   * so the human watches it boot on the stage. */
  const studioSwap = (doc) => {
    const report = validateAppDocument(doc);
    if (!report.valid) {
      return {
        ok: false,
        errors: report.errors,
        total: report.total,
        hint: 'The document must validate against the jaren-app meta-schema. Each error carries an instancePath into your document — fix those paths and try again.',
      };
    }
    const app = env.getApp();
    if (app === null) return { error: 'the studio is not running here' };
    go('#/project');
    // write the designated app file (or add one), activate it, and commit
    // synchronously so the stage boots now and the revision is real — the
    // debounced edit loop that follows is idempotent on this commit
    const text = JSON.stringify(doc, null, 2);
    const project = app.getState().project;
    const target = projectAppFile(project);
    if (target === null) {
      app.dispatch('project/added', {
        files: [...project.files, { name: 'app.json', kind: 'app', text }],
        active: 'app.json',
      });
    }
    else {
      app.dispatch('project/files-set', {
        files: project.files.map((f) => (f.name === target.name ? { ...f, text } : f)),
      });
      if (project.active !== target.name) app.dispatch('project/active', target.name);
    }
    app.dispatch('project/committed', commitProject(app.getState().project));
    // "it validates" is not "it renders": audit the first frame so a
    // model that mangled a vnode or a widget's props hears about it
    // now instead of reporting success over a broken mount
    const audit = auditDocumentRender(doc);
    return {
      ok: true,
      revision: app.getState().project.revision,
      widgets: audit.widgets,
      ...(audit.problems.length === 0 ? {} : {
        renderProblems: audit.problems,
        hint: 'The document is live, but its first frame renders broken pieces — the paths index into the vnode tree your view produced. Repair the view (or the state it reads) and patch again.',
      }),
      // soft observations (stale seed heading over a repurposed form):
      // worth a follow-up patch, never a failure
      ...(audit.notes.length === 0 ? {} : { renderNotes: audit.notes }),
    };
  };

  toolbox.add({
    name: 'jaren_studio_write',
    description: 'Load a COMPLETE @jarenjs/app document (state + JSLT view + actions as one JSON value) into the project IDE (#/project), where it becomes the project\'s app file and boots as a live app the user watches. The document is validated against the jaren-app meta-schema first; on failure you get the errors (with instancePaths) to repair. Start from jaren_get_templates and iterate with jaren_studio_patch instead of resending whole documents.',
    inputSchema: {
      type: 'object',
      properties: { doc: { type: 'object' } },
      required: ['doc'],
    },
    execute: (input) => studioSwap(input.doc),
  });

  toolbox.add({
    name: 'jaren_studio_patch',
    description: 'Modify the current Studio document with an RFC 6902 JSON Patch (applied by the suite\'s own patch engine). The patched result is re-validated against the meta-schema before it swaps in — an invalid result is rejected atomically and the current document stays live. Returns the new revision, or the errors to repair.',
    inputSchema: {
      type: 'object',
      properties: { patch: { type: 'array', items: { type: 'object' } } },
      required: ['patch'],
    },
    execute: (input) => {
      const doc = studioDoc();
      if (doc === null) {
        return { error: 'no studio document is loaded — load one with jaren_studio_write or a template first' };
      }
      let next;
      try {
        next = applyJSONPatch(doc, input.patch);
      }
      catch (err) {
        return { error: `the patch failed to apply: ${/** @type {Error} */ (err).message}` };
      }
      return studioSwap(next);
    },
  });

  toolbox.add({
    name: 'jaren_studio_read',
    description: 'Read the current Studio document, or one subtree of it via a JSON Pointer (e.g. { pointer: "/view/rules/0" }) — inspect narrowly instead of pulling the whole document into context.',
    inputSchema: {
      type: 'object',
      properties: { pointer: { type: 'string' } },
    },
    execute: (input) => {
      const doc = studioDoc();
      if (doc === null) return { error: 'no studio document is loaded' };
      if (input.pointer === undefined || input.pointer === '') {
        return { doc, revision: env.getApp().getState().project.revision };
      }
      let value;
      try {
        value = compileJSONPointer(input.pointer)(doc);
      }
      catch (err) {
        return { error: `invalid JSON Pointer: ${/** @type {Error} */ (err).message}` };
      }
      if (value === JSONPOINTER_NOTHING) {
        return { error: `nothing at '${input.pointer}' in the current document` };
      }
      return { value };
    },
  });

  toolbox.add({
    name: 'jaren_get_templates',
    description: 'The Studio seed library: complete, boot-tested @jarenjs/app documents (a validated form, a charts dashboard, a routed mini-site). Without a name you get the list; with a name, the full document — load it with jaren_studio_write and adapt it with jaren_studio_patch.',
    inputSchema: {
      type: 'object',
      properties: { name: { enum: STUDIO_TEMPLATES.map((t) => t.name) } },
    },
    execute: (input) => {
      if (input.name === undefined) {
        return STUDIO_TEMPLATES.map((t) => ({ name: t.name, title: t.title, lead: t.lead }));
      }
      const template = studioTemplate(input.name);
      return template === undefined
        ? { error: `no template named '${input.name}'`, names: STUDIO_TEMPLATES.map((t) => t.name) }
        : { name: template.name, title: template.title, lead: template.lead, doc: template.doc };
    },
  });

  // ---- the Flow studio: authoring an executable workflow document ----

  /** The current flow document + kind, or nulls. */
  const flowSlice = () => env.getApp()?.getState().flow ?? { kind: null, doc: null };

  /**
   * Gate a flow document (schema + compile), and on success load it into
   * the Flow studio, navigating so the human watches it render. A
   * rejected document returns its JF errors AS the tool result — the
   * agent loop reads them and repairs, no second mechanism.
   * @param {'fsm'|'dag'} kind @param {any} doc
   */
  const flowLoad = (kind, doc) => {
    const outcome = checkOutcome(FLOW_CHECKS[kind](doc));
    if (!outcome.valid) {
      return {
        ok: false,
        errors: outcome.errors,
        hint: 'The document must validate against the jaren-' + kind + ' schema AND compile. Each error carries a code (a JF/JQ/JT code) and a docPath JSON Pointer into your document — fix those and try again.',
      };
    }
    const app = env.getApp();
    if (app === null) return { error: 'the app is not running here' };
    const template = kind === 'fsm' ? flowTemplate('review') : flowTemplate('enrich');
    go('#/flow');
    app.dispatch('flow/load', {
      kind, doc,
      runContext: kind === 'fsm' ? (template?.runContext ?? {}) : null,
      dagInput: kind === 'dag' ? JSON.stringify(template?.runInput ?? [], null, 1) : '',
    });
    return { ok: true };
  };

  toolbox.add({
    name: 'jaren_flow_write',
    description: 'Load a COMPLETE executable workflow document into the Flow studio (#/flow), where it renders as a diagram and runs live. `kind` is "fsm" (a jaren-fsm state machine: initial, states, transitions with query-document guards) or "dag" (a jaren-dag dataflow: nodes of kind input/output/const/query/jslt/task, wired by edges). The document is validated against the schema AND compiled; on failure you get the errors (each with a JF/JQ/JT code and a docPath) to repair. Start from jaren_flow_get_templates.',
    inputSchema: {
      type: 'object',
      properties: { kind: { enum: ['fsm', 'dag'] }, doc: { type: 'object' } },
      required: ['kind', 'doc'],
    },
    execute: (input) => flowLoad(input.kind, input.doc),
  });

  toolbox.add({
    name: 'jaren_flow_patch',
    description: 'Modify the current Flow document with an RFC 6902 JSON Patch (applied by the suite\'s own patch engine). The patched result is re-validated and re-compiled before it swaps in — an invalid result is rejected and the current document stays live. Returns ok, or the errors to repair.',
    inputSchema: {
      type: 'object',
      properties: { patch: { type: 'array', items: { type: 'object' } } },
      required: ['patch'],
    },
    execute: (input) => {
      const { kind, doc } = flowSlice();
      if (doc === null) return { error: 'no flow document is loaded — load one with jaren_flow_write or a template first' };
      let next;
      try {
        next = applyJSONPatch(doc, input.patch);
      }
      catch (err) {
        return { error: `the patch failed to apply: ${/** @type {Error} */ (err).message}` };
      }
      return flowLoad(kind, next);
    },
  });

  toolbox.add({
    name: 'jaren_flow_check',
    description: 'Validate and compile a workflow document WITHOUT loading it — a read-only verdict. Returns { ok: true } or the errors (code + docPath each). Use it to iterate a document before committing it with jaren_flow_write.',
    inputSchema: {
      type: 'object',
      properties: { kind: { enum: ['fsm', 'dag'] }, doc: { type: 'object' } },
      required: ['kind', 'doc'],
    },
    execute: (input) => {
      const outcome = checkOutcome(FLOW_CHECKS[input.kind](input.doc));
      return outcome.valid ? { ok: true } : { ok: false, errors: outcome.errors };
    },
  });

  toolbox.add({
    name: 'jaren_flow_get_templates',
    description: 'The Flow seed library: complete, runnable jaren-fsm and jaren-dag documents. Without a name you get the list; with a name, the full document and its kind — load it with jaren_flow_write and adapt it with jaren_flow_patch.',
    inputSchema: {
      type: 'object',
      properties: { name: { enum: FLOW_TEMPLATES.map((t) => t.name) } },
    },
    execute: (input) => {
      if (input.name === undefined) {
        return FLOW_TEMPLATES.map((t) => ({ name: t.name, kind: t.kind, title: t.title, lead: t.lead }));
      }
      const template = flowTemplate(input.name);
      return template === null
        ? { error: `no template named '${input.name}'`, names: FLOW_TEMPLATES.map((t) => t.name) }
        : { name: template.name, kind: template.kind, title: template.title, lead: template.lead, doc: template.doc };
    },
  });

  toolbox.add({
    name: 'jaren_save_experiment',
    description: 'Save what is on screen under a name so the user keeps what you built together: on #/project the current project (the IDE store); anywhere else the current play session (the play store). Returns the updated saved names.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', minLength: 1 } },
      required: ['name'],
    },
    execute: (input) => {
      const app = env.getApp();
      if (app === null) return { error: 'the site is not running here' };
      if (app.getState().route.page === 'project') {
        app.dispatch('ide/name', null, { target: { value: input.name } });
        app.dispatch('ide/save');
        return { ok: true, names: app.getState().ide.names };
      }
      app.dispatch('play/name', null, { target: { value: input.name } });
      app.dispatch('play/save');
      return { ok: true, names: app.getState().play.names };
    },
  });

  toolbox.add({
    name: 'jaren_list_experiments',
    description: 'List the saved work: the IDE store\'s experiments (projects, plus any legacy studio or engine experiments) and the saved play sessions.',
    inputSchema: { type: 'object', properties: {} },
    execute: () => ({
      experiments: Object.entries(env.docStore.all()).map(([name, e]) => ({
        name, engine: /** @type {any} */ (e).engine, savedAt: /** @type {any} */ (e).savedAt,
      })),
      playSessions: env.playStore ? env.playStore.names() : [],
    }),
  });

  toolbox.add({
    name: 'jaren_load_experiment',
    description: 'Load a saved experiment by name: a project (or a legacy studio document) opens in #/project; a legacy engine experiment opens as the equivalent play session.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
    execute: (input) => {
      const app = env.getApp();
      if (env.docStore.load(input.name) === undefined) {
        return { error: `no experiment named '${input.name}'` };
      }
      app?.dispatch('ide/load', input.name);
      return { ok: true };
    },
  });

  toolbox.add({
    name: 'jaren_share_link',
    description: 'Build a share link that restores what is on screen (the project on #/project, the play session otherwise), and copy it to the clipboard.',
    inputSchema: { type: 'object', properties: {} },
    execute: () => {
      const app = env.getApp();
      if (app === null || env.share === undefined) return { error: 'sharing is unavailable here' };
      app.dispatch(app.getState().route.page === 'project' ? 'ide/share' : 'play/share');
      return { ok: true, note: 'A share link was copied to the clipboard.' };
    },
  });

  return toolbox;
}

/**
 * The system prompt: what the assistant is and how it drives the site.
 * The engine list is generated from the play engine registry, so the
 * prompt can never drift from the surface it steers.
 */
export const SYSTEM_PROMPT = [
  'You are the Jaren play assistant, embedded in the jarenjs website. Jaren is a',
  'browser-native JSON toolkit: every engine below runs right here with the real shipped',
  'compilers — no server, no proxy — and Jaren\'s own JSON Schema validator checks each of',
  'your tool calls before it runs.',
  '',
  'The engines (JSON values are passed as JSON text):',
  '- validate — JSON Schema: validate a document against a schema (use jaren_validate).',
  ...Object.values(playComponent.engines).filter((e) => e.id !== 'validate')
    .map((e) => `- ${e.id} — ${e.label}: ${e.lead ?? ''}`),
  '',
  'Vocabulary → engine (pick the DELIVERABLE the user named, then use the others inside it):',
  '- "stylesheet" or "template" → the jslt engine. This is a transform that COMPUTES —',
  '  filter, aggregate, pick, branch — not just reshape. JSONPath is used INSIDE its rule',
  '  bodies to address data; it is never the whole answer on its own.',
  '- "query" or "expression" → the query engine (a JSON query document).',
  '- "jsonpath"/"selector"/"filter" → the path engine, OR a `$.a.b` / `$.items[?(@.x>1)]`',
  '  expression used INSIDE a jslt or query document.',
  'So "use jsonpath to make a stylesheet" means: build a JSLT stylesheet whose bodies use',
  'JSONPath. The stylesheet is the deliverable; jsonpath is a means. A bare JSONPath filter',
  'is NOT a finished stylesheet.',
  '',
  'How to work:',
  '0. Tool arguments are JSON: pass objects and arrays as REAL JSON values, never as',
  '   JSON-encoded strings (write {"doc": {…}}, not {"doc": "{…}"}).',
  '1. You help by DRIVING the play surface (#/play) with your tools, not by pasting long',
  '   answers — every tool call loads its inputs into the live surface, so the user watches.',
  '2. Call jaren_get_state before editing, and build on what is already on screen. Use',
  '   jaren_list_engines when you are unsure of an engine\'s input fields.',
  '3. Writing a program for an engine you have not used in this conversation? Call',
  '   jaren_get_examples first and adapt a working example — never guess syntax.',
  '4. Engine errors come back as result nodes with stable codes and docPaths. Read them, fix',
  '   the input IN PLACE, and run again — do not give up, and do not switch to a different',
  '   engine to dodge an error. If the user asked for a JSLT stylesheet, deliver a JSLT',
  '   stylesheet; an "unknown operator" error names the operator to use instead (e.g.',
  '   `$head` for the first item, `$string-join`, `$fold`) — apply it and re-run.',
  '   A JSLT stylesheet is { "$jslt": "0.1", "rules": [ { "match": "$…", "body": <expr> } ] }',
  '   where <expr> is a jaren-query expression: JSONPath ($.a, $.items[?(@.x>1)]), operators',
  '   ($min $max $sum $count $head $sub $mul $if $default), and $for/$where/$return phrases.',
  '4a. This site also MOUNTS the math / finance / statistics operator packs, so these',
  '   REGISTERED operators run in the jslt, query and jtlt engines here: math ($sqrt $pow $abs',
  '   $hypot $log $exp and the trig family), finance ($npv $irr $sma $ema $fv $pv $pmt), and',
  '   statistics ($mean $median $variance $stddev $percentile). Use them directly, e.g.',
  '   { "$npv": ["$.rate", "$.flows[*]"] }, { "$mean": "$.readings[*]" }, or |a−b| as',
  '   { "$abs": { "$sub": ["$a", "$b"] } }. They are a host opt-in — not the closed spec',
  '   vocabulary — so they run HERE, but a document saved and compiled WITHOUT the packs',
  '   rejects them (JQ0002). Call jaren_get_examples("jslt") or ("query") for the',
  '   "Registered …" worked examples.',
  '5. When a run turns out well, offer to keep it: jaren_save_experiment stores it by name,',
  '   jaren_share_link copies a link that restores it.',
  '6. Keep replies to a sentence or two — the full output is already visible on the page.',
  '6a. FINISH the task before you reply. If it needs a computation JSONPath cannot do',
  '   (nearest, min/max, sum, pick-one), that is exactly what jslt and query are for —',
  '   switch to them and deliver it. Never stop at a partial result to ask "should I…" or',
  '   "want me to switch to…"; just do the obvious next step, then summarise what is on screen.',
  '',
  'The Studio (#/project) — a PROJECT of files, not a single document:',
  'The studio holds a small tree of typed files: an `app` document, plus the `jslt`/`query`',
  'transforms, `schema` validations and the `state`/`data` they run on. Each file is checked',
  'against its OWN grammar, so a query may use the registered operators above.',
  '7. NEVER describe the project from the app document alone — jaren_studio_read returns ONLY',
  '   the app file. Call jaren_project_files FIRST for anything about "my project", "my',
  '   files" or "the studio"; pass a name for one file\'s text. Saying a project has no other',
  '   files because you did not look is a wrong answer, not a shortcut.',
  '8. Write a non-app file with jaren_project_write (it validates, opens and RUNS it), and',
  '   run one you did not write with jaren_project_run. Both report the coded errors and the',
  '   stage output — read them and repair in place, exactly as with the engines.',
  '',
  'Authoring the app document itself:',
  'A studio document is a COMPLETE @jarenjs/app app — initial state, a JSLT view stylesheet',
  'and named actions as one JSON value — validated by the jaren-app meta-schema and booted',
  'live by the real app runtime, as the app file of the project. Its view may use the',
  'widgets form ({ schema, data }), chart ({ config }), markdown ({ source }) and',
  'mermaid ({ source }).',
  '9. Author via template + patch, never from scratch: jaren_get_templates for a seed,',
  '   jaren_studio_write to load it, jaren_studio_read to inspect (use a pointer for one',
  '   subtree), then small RFC 6902 patches with jaren_studio_patch.',
  '10. Validation errors are instructions, not failures: each carries an instancePath into',
  '   your document — repair exactly those paths and patch again.',
  '11. A schema-driven form lives in state: the form template already renders /state/schema',
  '   through its ONE form widget, so shape your form by replacing /state/schema and',
  '   /state/data — never add a second form widget for the same schema, and keep the',
  '   template\'s heading in step with your form\'s title.',
  '12. End every turn with a short, finished summary of what is now on screen — never with',
  '   an announcement of work you have not done.',
].join('\n');

/** Chat turns sent back to the model per request (persisted transcripts can be long). */
const HISTORY_WINDOW = 20;

/** Chat turns kept in the persisted transcript (a localStorage slot, not an archive). */
const SAVED_WINDOW = 100;

/**
 * How many memories the agent carries into a turn. Small on purpose:
 * they are paid for out of the same history budget the conversation is,
 * and a retrieval that crowded out the conversation would be a worse
 * assistant with a better memory.
 */
const MEMORY_WINDOW = 5;

/**
 * The ledger as the panel shows it: the active objective (a superseded
 * or abandoned one is not "what we are doing" and is not shown), what
 * has been recorded against it, and how many dropped rounds are sitting
 * in slots waiting for a `recall`. One read, so the panel can never
 * disagree with itself about which turn it is describing.
 * @param {any} ledger
 */
async function readLedger(ledger) {
  const goal = await ledger.getGoal();
  const slots = await ledger.listSlots();
  return {
    goal: goal !== null && goal.status === 'active'
      ? { objective: goal.objective, progress: goal.progress }
      : null,
    memories: (await ledger.listMemories()).length,
    archived: slots.filter((slot) => slot.kind === 'agent-round').length,
  };
}

/**
 * The assistant's impure effects: the streaming agent turn, the
 * settings persistence, the transcript persistence and the ledger. The
 * injected `aiFetch` keeps the whole thing testable against a scripted
 * transport, and the injected `ledger` keeps it testable without a
 * store.
 * @param {{ toolbox: any, getApp: () => any,
 *   aiFetch?: typeof fetch,
 *   aiStorage: { read: () => any, write: (data: any) => void },
 *   aiChat: { read: () => any, write: (data: any) => void },
 *   ledger: any }} deps
 */
export function createAssistantEffects(deps) {
  /**
   * The last completed turn, kept here rather than in the state: it is
   * the trajectory a refinement reads, it is large, and nothing renders
   * it. State holds what the panel draws; this holds what the next
   * action needs.
   * @type {{ messages: any[], steps: any[] } | null}
   */
  let lastRun = null;

  /** The client the current settings describe, or a dispatched failure. */
  const clientFor = (state, dispatch) => {
    const s = state.ai.settings;
    try {
      return createChatClient({
        provider: s.provider,
        baseUrl: s.baseUrl,
        apiKey: s.apiKey,
        model: s.model,
        fetch: deps.aiFetch,
        headers: { 'HTTP-Referer': 'https://jklarenbeek.github.io/jarenjs/', 'X-Title': 'Jaren play' },
      });
    }
    catch (err) {
      dispatch('ai/failed', /** @type {Error} */ (err).message);
      return null;
    }
  };

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

      const client = clientFor(state, dispatch);
      if (client === null) return;

      // weak local models are first-class: enough rounds to read an
      // engine's { error } result, fetch an example and try again —
      // and a studio flow (template → write → patch → repair → save)
      // legitimately runs past a dozen rounds on a small model. The
      // history budget keeps those long sessions inside a small local
      // context window (~6k tokens), which is what makes the higher
      // cap affordable.
      //
      // With the ledger under it, that budget stops destroying: every
      // round it drops is archived to a slot first and the model can
      // `recall` it back. The same ledger puts the objective and what
      // has been learned into the prompt of every turn.
      const agent = createAgent({
        client, toolbox: deps.toolbox, system: SYSTEM_PROMPT, maxToolRounds: 16,
        historyBudget: 24_000,
        ledger: deps.ledger,
        retrieval: { memories: { limit: MEMORY_WINDOW } },
      });
      // build the turn from this effect's own snapshot: the ai/user
      // dispatch above is queued FIFO behind the running transaction,
      // so a getState() here would still miss the draft
      const history = [...state.ai.messages, { role: 'user', content: draft }]
        .slice(-HISTORY_WINDOW)
        .map((m) => ({ role: m.role, content: m.content }));
      agent.send(history, {
        onDelta: (text) => dispatch('ai/delta', text),
        onReasoning: (text) => dispatch('ai/reasoning', text.length),
        onToolCall: (call) => dispatch('ai/activity', call.name),
        // back to 'Thinking…' between a tool's result and the next token
        onToolResult: () => dispatch('ai/activity', null),
      }).then(
        // an empty final message is a model quirk worth an honest line —
        // and a reasoning-only turn deserves to say what happened
        (result) => {
          lastRun = { messages: result.messages, steps: result.steps };
          dispatch('ai/reply', result.message.content !== ''
            ? result.message.content
            : result.message.reasoning !== undefined
              ? '*The model spent the whole turn reasoning without a final reply — send another message to continue.*'
              : '*The model ended its turn without a reply — whatever it loaded is on screen; send another message to continue.*');
          // the archive grows during a turn, so the panel's count is read
          // after it: what the model can still reach is a fact about the
          // finished turn, not the one that started it
          readLedger(deps.ledger).then((view) => dispatch('ai/ledger', view), () => {});
        },
        (err) => dispatch('ai/failed', err?.message ?? String(err)),
      );
    },

    // the ledger panel: one read, dispatched as one value. Run on open
    // (so a reloaded page shows the objective it was left with) and
    // after anything that writes.
    'ai-ledger-read': (props, dispatch) => {
      readLedger(deps.ledger).then((view) => dispatch('ai/ledger', view),
        (err) => dispatch('ai/failed', err?.message ?? String(err)));
    },

    // clearing the conversation clears what compaction archived FROM it:
    // an archived round is a piece of a transcript, and its address only
    // ever appeared in that transcript's synopsis. Keeping the rounds
    // would leave the panel counting recoverable context for a
    // conversation that no longer exists — and leave bytes in the store
    // that nothing can ever name again. Memories and the goal survive:
    // they are what was LEARNED, not what was said.
    'ai-clear-archive': (props, dispatch) => {
      deps.ledger.listSlots()
        .then((slots) => Promise.all(slots
          .filter((slot) => slot.kind === 'agent-round' || slot.kind === 'agent-round-index')
          .map((slot) => deps.ledger.deleteSlot(slot.name))))
        .then(() => readLedger(deps.ledger))
        .then((view) => dispatch('ai/ledger', view),
          (err) => dispatch('ai/failed', err?.message ?? String(err)));
    },

    'ai-goal-set': (props, dispatch) => {
      const objective = deps.getApp().getState().ai.goalDraft.trim();
      if (objective === '') return;
      deps.ledger.setGoal({ objective }).then((goal) => {
        if (goal?.error !== undefined) {
          dispatch('ai/failed', goal.error);
          return;
        }
        // the draft is cleared by what comes back from the ledger, not by
        // the action: the objective on screen is the stored one
        return readLedger(deps.ledger).then((view) => dispatch('ai/goal-committed', view));
      }, (err) => dispatch('ai/failed', err?.message ?? String(err)));
    },

    // "clear" abandons the objective rather than deleting it: the ledger
    // keeps what this agent was asked to do, and the panel stops showing
    // an objective nobody is working on
    'ai-goal-clear': (props, dispatch) => {
      deps.ledger.setGoalStatus('abandoned')
        .then(() => readLedger(deps.ledger))
        .then((view) => dispatch('ai/ledger', view),
          (err) => dispatch('ai/failed', err?.message ?? String(err)));
    },

    // the refinement button: the model proposes an RFC 6902 patch over
    // its own supplemental state, every stage of the gate runs, and what
    // survives is committed. The patch engine is INJECTED here, exactly
    // as @jarenjs/ai requires — the package never imports @jarenjs/json.
    'ai-remember': (props, dispatch) => {
      const state = deps.getApp().getState();
      if (lastRun === null) {
        dispatch('ai/remembered', { note: 'Nothing to remember yet — send a message first.' });
        return;
      }
      if (!isConfigured(state.ai.settings)) {
        dispatch('ai/remembered', { note: 'Add a provider, model and key in settings first.' });
        return;
      }
      const client = clientFor(state, dispatch);
      if (client === null) return;
      createRefiner({
        client,
        ledger: deps.ledger,
        applyPatch: (document, patch) => applyJSONPatch(document, patch),
      }).refine(lastRun).then((outcome) => {
        const written = outcome.ok === true
          ? outcome.memories.length + outcome.skills.length + outcome.progress.length
          : 0;
        dispatch('ai/remembered', {
          note: outcome.ok !== true
            ? `Nothing was stored — ${outcome.error}`
            : written === 0
              ? 'The assistant found nothing worth remembering from this session.'
              : `Remembered ${written} evidenced item${written === 1 ? '' : 's'}.`,
        });
        return readLedger(deps.ledger).then((view) => dispatch('ai/ledger', view));
      }, (err) => dispatch('ai/remembered', { note: err?.message ?? String(err) }));
    },

    'ai-save-settings': () => {
      deps.aiStorage.write(deps.getApp().getState().ai.settings);
    },

    // the settings "Test connection" button: one /models probe with the
    // exact auth a chat turn would use; the result object drives the
    // status line and the model-name datalist
    'ai-probe': (props, dispatch) => {
      const s = deps.getApp().getState().ai.settings;
      probeProvider({
        provider: s.provider,
        baseUrl: s.baseUrl,
        apiKey: s.apiKey,
        fetch: deps.aiFetch,
      }).then((result) => dispatch('ai/probe-result', result.ok
        ? {
          status: 'ok',
          detail: `Connected — ${result.models.length} model${result.models.length === 1 ? '' : 's'} available.`,
          models: result.models.slice(0, 100),
        }
        : { status: 'fail', detail: result.error, models: [] }));
    },

    // opening the panel unconfigured lands you in settings — pinned
    // open, so the form does not hide the moment typing a model name
    // makes the configuration valid (only Save closes and persists it)
    'ai-ensure-settings': (props, dispatch) => {
      const state = deps.getApp().getState();
      if (state.ai.open && !isConfigured(state.ai.settings)) {
        dispatch('ai/settings-open', true);
      }
    },

    // the transcript mirror: every appended turn (and a clear) writes
    // the visible messages through the injected store, so a reload
    // resumes the conversation
    'ai-persist': () => {
      const messages = deps.getApp().getState().ai.messages;
      deps.aiChat.write({ messages: messages.slice(-SAVED_WINDOW) });
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
