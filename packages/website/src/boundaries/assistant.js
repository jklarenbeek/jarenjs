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
  probeProvider, composeChecks, checkOutcome,
} from '@jarenjs/ai';

import { applyJSONPatch, compileJSONPointer, JSONPOINTER_NOTHING } from '@jarenjs/json';
import { compileFsm, compileDag } from '@jarenjs/flow';
import { JarenValidator } from '@jarenjs/validate';

import fsmSchema from '@jarenjs/flow/schemas/jaren-fsm.schema.json' with { type: 'json' };
import dagSchema from '@jarenjs/flow/schemas/jaren-dag.schema.json' with { type: 'json' };
import querySchema from '@jarenjs/json/schemas/jaren-query.schema.json' with { type: 'json' };
import jsltSchema from '@jarenjs/json/schemas/jaren-jslt.schema.json' with { type: 'json' };

import { runValidation } from './validator.js';
import { runEngine, ENGINE_DEFS, ENGINE_EXAMPLES, operatorRegistry } from './engines.js';
import { validateAppDocument, auditDocumentRender } from './studio.js';
import { STUDIO_TEMPLATES, studioTemplate } from '../content/appTemplates.js';
import { FLOW_TEMPLATES, flowTemplate } from '../content/flowTemplates.js';
import { exampleSchemas } from '../content/schemas.js';

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
    new JarenValidator({ collectErrors: true }).addSchema(querySchema).compile(fsmSchema),
    compileGate(compileFsm)),
  // a dag needs its task registry to compile; the assistant checks
  // STRUCTURE (schema) + acyclicity/ports/output against a registry
  // stubbed from the document's own task names, so a document naming a
  // handler still passes the shape gate
  dag: composeChecks(
    new JarenValidator({ collectErrors: true }).addSchema(querySchema).addSchema(jsltSchema).compile(dagSchema),
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
    description: 'Validate a JSON document against a JSON Schema with the Jaren validating compiler, loading both into the playground so the user sees the result. Pass `schema` as a real JSON object (not JSON text). Returns { valid, errors, draft, compileMs, validateMs }.',
    inputSchema: {
      type: 'object',
      properties: { schema: { type: ['object', 'boolean'] }, data: {} },
      required: ['schema'],
    },
    execute: (input) => {
      const app = env.getApp();
      const schemaText = JSON.stringify(input.schema, null, 2);
      // models often hand the document over as JSON text — accept it
      const data = typeof input.data === 'string' ? parseJsonText(input.data) : (input.data ?? null);
      if (app !== null) {
        go('#/playground?engine=validate');
        app.dispatch('pg/example', { schemaText, data });
      }
      return runValidation(schemaText, data);
    },
  });

  toolbox.add({
    name: 'jaren_run_engine',
    description: `Run one of the Jaren playground engines (${engineKeys.join(', ')}) with text inputs (JSON values as JSON text), loading them into the playground so the user watches it run. JSON Schema validation is NOT an engine here — use jaren_validate for that. Returns the render nodes the site itself shows, including errors with stable codes and docPaths.`,
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
        page: { enum: ['home', 'playground', 'studio', 'play', 'flow', 'benchmarks', 'charts', 'docs', 'calculator'] },
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
    description: 'Get the site\'s working examples for one engine — each is { label, inputs } and runs as-is through jaren_run_engine (for engine \'validate\': { label, schema, data } for jaren_validate). Before writing a program for an engine you have not used this conversation, fetch its examples and adapt one instead of guessing syntax. Pass `label` to get a single example.',
    inputSchema: {
      type: 'object',
      properties: { engine: { enum: [...engineKeys, 'validate'] }, label: { type: 'string' } },
      required: ['engine'],
    },
    execute: (input) => {
      const all = input.engine === 'validate'
        ? Object.values(exampleSchemas).map((e) => ({ label: e.name, schema: e.schema, data: e.data }))
        : (ENGINE_EXAMPLES[input.engine] ?? []);
      if (input.label === undefined) return all;
      const hit = all.find((e) => e.label === input.label);
      return hit ?? { error: `no example labelled '${input.label}'`, labels: all.map((e) => e.label) };
    },
  });

  // ---- the Studio: authoring a complete app document ----

  /** The current studio document, or null. */
  const studioDoc = () => env.getApp()?.getState().studio.doc ?? null;

  /** Validate + swap a document in, navigating so the human watches it boot. */
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
    go('#/studio');
    app.dispatch('studio/doc', { doc });
    // "it validates" is not "it renders": audit the first frame so a
    // model that mangled a vnode or a widget's props hears about it
    // now instead of reporting success over a broken mount
    const audit = auditDocumentRender(doc);
    return {
      ok: true,
      revision: app.getState().studio.revision,
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
    description: 'Load a COMPLETE @jarenjs/app document (state + JSLT view + actions as one JSON value) into the Studio (#/studio), where it boots as a live app the user watches. The document is validated against the jaren-app meta-schema first; on failure you get the errors (with instancePaths) to repair. Start from jaren_get_templates and iterate with jaren_studio_patch instead of resending whole documents.',
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
        return { doc, revision: env.getApp().getState().studio.revision };
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
    description: 'Save what is on screen as a named experiment (the localStorage IDE store) so the user keeps what you built together: the current playground engine and inputs, or — on #/studio — the current studio document. Returns the updated experiment names.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', minLength: 1 } },
      required: ['name'],
    },
    execute: (input) => {
      const app = env.getApp();
      if (app === null) return { error: 'the playground is not running here' };
      app.dispatch('ide/name', null, { target: { value: input.name } });
      app.dispatch('ide/save');
      return { ok: true, names: app.getState().ide.names };
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

/**
 * The system prompt: what the assistant is and how it drives the site.
 * The engine list is generated from ENGINE_DEFS, so the prompt can
 * never drift from the playground it steers.
 */
export const SYSTEM_PROMPT = [
  'You are the Jaren playground assistant, embedded in the jarenjs website. Jaren is a',
  'browser-native JSON toolkit: every engine below runs right here with the real shipped',
  'compilers — no server, no proxy — and Jaren\'s own JSON Schema validator checks each of',
  'your tool calls before it runs.',
  '',
  'The engines (JSON values are passed as JSON text):',
  '- validate — JSON Schema: validate a document against a schema (use jaren_validate).',
  ...Object.entries(ENGINE_DEFS).map(([key, def]) => `- ${key} — ${def.label}: ${def.lead}`),
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
  '1. You help by DRIVING the playground with your tools, not by pasting long answers — every',
  '   tool call loads its inputs into the live playground, so the user watches it happen.',
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
  '4a. This playground also MOUNTS the math / finance / statistics operator packs, so these',
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
  'The Studio (#/studio) — where you author a whole application:',
  'A studio document is a COMPLETE @jarenjs/app app — initial state, a JSLT view stylesheet',
  'and named actions as one JSON value — validated by the jaren-app meta-schema and booted',
  'live by the real app runtime. Its view may use the widgets form ({ schema, data }),',
  'chart ({ config }), markdown ({ source }) and mermaid ({ source }).',
  '7. Author via template + patch, never from scratch: jaren_get_templates for a seed,',
  '   jaren_studio_write to load it, jaren_studio_read to inspect (use a pointer for one',
  '   subtree), then small RFC 6902 patches with jaren_studio_patch.',
  '8. Validation errors are instructions, not failures: each carries an instancePath into',
  '   your document — repair exactly those paths and patch again.',
  '9. A schema-driven form lives in state: the form template already renders /state/schema',
  '   through its ONE form widget, so shape your form by replacing /state/schema and',
  '   /state/data — never add a second form widget for the same schema, and keep the',
  '   template\'s heading in step with your form\'s title.',
  '10. End every turn with a short, finished summary of what is now on screen — never with',
  '   an announcement of work you have not done.',
].join('\n');

/** Chat turns sent back to the model per request (persisted transcripts can be long). */
const HISTORY_WINDOW = 20;

/** Chat turns kept in the persisted transcript (a localStorage slot, not an archive). */
const SAVED_WINDOW = 100;

/**
 * The assistant's impure effects: the streaming agent turn, the
 * settings persistence and the transcript persistence. Injected
 * `aiFetch` keeps the whole thing testable against a scripted
 * transport.
 * @param {{ toolbox: any, getApp: () => any,
 *   aiFetch?: typeof fetch,
 *   aiStorage: { read: () => any, write: (data: any) => void },
 *   aiChat: { read: () => any, write: (data: any) => void } }} deps
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

      // weak local models are first-class: enough rounds to read an
      // engine's { error } result, fetch an example and try again —
      // and a studio flow (template → write → patch → repair → save)
      // legitimately runs past a dozen rounds on a small model. The
      // history budget keeps those long sessions inside a small local
      // context window (~6k tokens), which is what makes the higher
      // cap affordable.
      const agent = createAgent({
        client, toolbox: deps.toolbox, system: SYSTEM_PROMPT, maxToolRounds: 16,
        historyBudget: 24_000,
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
        (result) => dispatch('ai/reply', result.message.content !== ''
          ? result.message.content
          : result.message.reasoning !== undefined
            ? '*The model spent the whole turn reasoning without a final reply — send another message to continue.*'
            : '*The model ended its turn without a reply — whatever it loaded is on screen; send another message to continue.*'),
        (err) => dispatch('ai/failed', err?.message ?? String(err)),
      );
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
