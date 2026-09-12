//@ts-check
/** Validate, audit and mount isolated app documents with explicit render services. */
import { JarenValidator } from '@jarenjs/validate';
import { jsonFormats } from '@jarenjs/formats';
import { OUR_SCHEMA_OPTIONS } from './shared/schema-options.js';
import { createTypeTestCompiler } from '@jarenjs/validate/query';
import { createApp, createFormView, formEventFields } from '@jarenjs/app';
import { createDomRenderer } from '@jarenjs/view';
import { compileJsltStylesheet } from '@jarenjs/json/jslt';
import { buildFormModel, buildFormViewModel } from '@jarenjs/forms';
import { compileChart } from '@jarenjs/charts';
import { errorMessage } from './shared/nodes.js';
import appSchema from '@jarenjs/app/schemas/jaren-app.schema.json' with { type: 'json' };
import querySchema from '@jarenjs/json/schemas/jaren-query.schema.json' with { type: 'json' };
import jsltSchema from '@jarenjs/json/schemas/jaren-jslt.schema.json' with { type: 'json' };



/** @param {{ markdown: (source: string) => any, diagram: (source: string) => any, templates?: any[] }} options */
export function createStudioDocumentHost(options) {
const { markdown, diagram, templates: STUDIO_TEMPLATES = [] } = options;
/** Schema errors kept per report: enough to repair, bounded for state. */
const MAX_ERRORS = 20;

// the meta-schema composes the published query and JSLT grammars by
// reference — register those artifacts alongside it (APP-FORMAT §2)
const validateApp = new JarenValidator(OUR_SCHEMA_OPTIONS)
  .addFormats(jsonFormats)
  .addSchema(querySchema)
  .addSchema(jsltSchema)
  .compile(appSchema);

const message = errorMessage;

/**
 * Validate a candidate document against the jaren-app meta-schema.
 * @param {any} doc
 * @returns {{ valid: boolean, errors: Array<{ instancePath: string, keyword: string, message: string }>, total: number }}
 */
function validateAppDocument(doc) {
  const outcome = validateApp(doc);
  const valid = typeof outcome === 'object' && outcome !== null ? outcome.valid : outcome === true;
  if (valid) return { valid: true, errors: [], total: 0 };
  const raw = (typeof outcome === 'object' && outcome !== null ? outcome.errors : null) ?? [];
  return {
    valid: false,
    total: raw.length,
    errors: raw.slice(0, MAX_ERRORS).map((e) => ({
      instancePath: e.instancePath ?? '',
      keyword: e.keyword ?? '',
      message: e.message ?? 'invalid',
    })),
  };
}

//#region the document's render-capability widgets

/**
 * A pure props→vnode widget: its own mini renderer into the host, and
 * every `on` binding inside the projection emits back into the hosting
 * app's dispatch (VIEW-FORMAT §7) — the widget renders, the document's
 * actions own the state transitions.
 * @param {(props: any) => any} view
 * @returns {{ mount: (host: HTMLElement, props: any, emit: (binding: any, event: Event) => void) => { render: ReturnType<typeof createDomRenderer> }, update: (handle: { render: ReturnType<typeof createDomRenderer> }, props: any) => void, unmount: (handle: { render: ReturnType<typeof createDomRenderer> }) => void }}
 */
function vnodeWidget(view) {
  return {
    mount(host, props, emit) {
      const render = createDomRenderer(host, {
        document: host.ownerDocument,
        onEvent: (binding, event) => emit(binding, event),
      });
      render(view(props));
      return { render };
    },
    update(handle, props) {
      handle.render(view(props));
    },
    unmount(handle) {
      handle.render.destroy?.();
    },
  };
}

// the standard forms stylesheet, compiled once: the form widget renders
// any `buildFormViewModel` tree; its bindings dispatch the standard
// form actions the document embeds (createFormActions output is JSON)
const formStylesheet = compileJsltStylesheet({
  $jslt: '0.1',
  rules: [
    { match: '$', body: { $apply: '$.form' } },
    ...createFormView(),
  ],
}, { memo: true });

/** Form models memoized per schema value identity (state is immutable). */
const formModels = new WeakMap();

function formVnode(props) {
  try {
    const schema = props?.schema;
    if (schema === null || typeof schema !== 'object') {
      return ['p', { class: 'error-line' }, 'form: props.schema must be a JSON Schema object'];
    }
    let model = formModels.get(schema);
    if (model === undefined) {
      model = buildFormModel(schema);
      formModels.set(schema, model);
    }
    return formStylesheet({
      form: buildFormViewModel(model, props.data ?? null, { validateFields: true }),
    });
  }
  catch (err) {
    return ['p', { class: 'error-line' }, `form: ${message(err)}`];
  }
}

function chartVnode(props) {
  try {
    // inline definitions carry their own data (the charts engine's
    // static path); theme 'host' keeps light/dark live (docs/DESIGN.md §7)
    return ['div', { class: 'studio-chart' },
      compileChart(props.config, props.config, { theme: 'host' }).toVnode()];
  }
  catch (err) {
    return ['p', { class: 'error-line' }, `chart: ${message(err)}`];
  }
}

const markdownVnode = (props) => markdown(String(props?.source ?? ''));
const mermaidVnode = (props) => diagram(String(props?.source ?? ''));

/**
 * The render capabilities a studio document may name (and nothing else).
 * A composed host can register the same chart/mermaid/markdown/form widgets
 * in its own view.
 */
const STUDIO_WIDGETS = {
  form: vnodeWidget(formVnode),
  chart: vnodeWidget(chartVnode),
  markdown: vnodeWidget(markdownVnode),
  mermaid: vnodeWidget(mermaidVnode),
};

//#endregion

// $valid/$assert/$as and schema matches are compile-time capabilities
// of the document grammars (pure, no side channel) — granted, unlike
// effects and subs
const compileTypeTest = createTypeTestCompiler();

//#region the headless render audit

/** Render problems reported per audit: enough to repair, bounded. */
const MAX_RENDER_PROBLEMS = 8;

/**
 * A tag `createElement` accepts: a letter, then letters, digits or
 * hyphens. One-element arrays like `["hr"]` are valid void elements —
 * the defect class is invalid tag NAMES, not array arity.
 */
const VALID_TAG = /^[a-zA-Z][a-zA-Z0-9-]*$/;

/**
 * Walk one rendered vnode with the renderer's own shape rules (text,
 * skipped, `[tag, props?, ...children]`, non-string-head arrays splice
 * as lists) and collect what a live mount would host: the widgets it
 * names, and the shapes that render as junk even though the meta-schema
 * accepted the document.
 * @param {any} node
 * @param {string} path - a JSON-pointer-ish trail into the rendered tree
 * @param {{ widgets: string[], problems: string[] }} out
 */
function walkRenderedVnode(node, path, out) {
  if (out.problems.length >= MAX_RENDER_PROBLEMS) return;
  if (node == null || node === true || node === false) return; // skipped
  if (typeof node === 'string' || typeof node === 'number') return; // text
  if (!Array.isArray(node)) {
    out.problems.push(`${path}: a bare object is not a vnode — it renders as nothing (expected ["tag", props, ...children] or text)`);
    return;
  }
  if (typeof node[0] !== 'string') {
    // a list: each item renders in place
    for (let i = 0; i < node.length; i++) walkRenderedVnode(node[i], `${path}/${i}`, out);
    return;
  }
  if (!VALID_TAG.test(node[0])) {
    // this is a boot-stopper, not a cosmetic problem: the nested app
    // dies on createElement and the whole stage ends empty
    out.problems.push(`${path}: '${node[0]}' is not a valid element tag name — the app fails to boot on it (text belongs directly in the children, not wrapped in an array)`);
    return;
  }
  if (node[0] === 'jaren-widget') {
    const props = (node[1] !== null && typeof node[1] === 'object' && !Array.isArray(node[1])) ? node[1] : {};
    const name = props.name;
    out.widgets.push(String(name));
    if (STUDIO_WIDGETS[name] === undefined) {
      out.problems.push(`${path}: unknown widget '${String(name)}' — available: ${Object.keys(STUDIO_WIDGETS).join(', ')}`);
    }
    else if (name === 'form' && (props.props?.schema === null || typeof props.props?.schema !== 'object')) {
      out.problems.push(`${path}: the form widget's props.schema did not resolve to a JSON Schema object — the form renders an error instead of fields`);
    }
    else if (name === 'chart' && (props.props?.config === null || typeof props.props?.config !== 'object')) {
      out.problems.push(`${path}: the chart widget's props.config did not resolve to a chart definition object`);
    }
    if (name === 'form' && typeof props.props?.schema?.title === 'string' && props.props.schema.title !== '') {
      out.formTitles.push(props.props.schema.title);
    }
    return;
  }
  if (node[0] === 'h1' || node[0] === 'h2' || node[0] === 'h3') {
    const start = (node.length > 1 && node[1] !== null && typeof node[1] === 'object' && !Array.isArray(node[1])) ? 2 : 1;
    let text = '';
    for (let i = start; i < node.length; i++) {
      if (typeof node[i] === 'string') text += node[i];
    }
    if (text.trim() !== '') out.headings.push(text.trim());
  }
  const start = (node.length > 1 && node[1] !== null && typeof node[1] === 'object' && !Array.isArray(node[1])) ? 2 : 1;
  for (let i = start; i < node.length; i++) walkRenderedVnode(node[i], `${path}/${i}`, out);
}

/**
 * The seed templates' rendered headings, each mapped to the form
 * titles that seed legitimately pairs them with — the reference for
 * the stale-heading note below. Built lazily from the templates
 * themselves so it can never drift from the seed library.
 * @type {Map<string, Set<string>> | null}
 */
let seedHeadings = null;

function getSeedHeadings() {
  if (seedHeadings === null) {
    seedHeadings = new Map();
    for (const template of STUDIO_TEMPLATES) {
      /** @type {{ widgets: string[], problems: string[], headings: string[], formTitles: string[] }} */
      const out = { widgets: [], problems: [], headings: [], formTitles: [] };
      try {
        walkRenderedVnode(
          compileJsltStylesheet(template.doc.view, { compileTypeTest, memo: false })(template.doc.state),
          '', out);
      }
      catch {
        continue; // a seed that fails to render simply contributes nothing
      }
      for (const heading of out.headings) {
        const titles = seedHeadings.get(heading) ?? new Set();
        for (const title of out.formTitles) titles.add(title);
        seedHeadings.set(heading, titles);
      }
    }
  }
  return seedHeadings;
}

/**
 * Render the document's first frame headlessly — the same stylesheet
 * compiler and state the live host boots with — and report the widgets
 * it hosts plus any render problems the meta-schema cannot see. "It
 * validates" is not "it renders": a valid document can still name an
 * unknown widget, hand the form widget a non-object schema, or place a
 * bare object where a vnode belongs.
 *
 * `notes` are soft semantic observations, not failures — today one
 * rule: a SEED template's heading still on screen while the form's
 * schema title has moved on (the repurposed-template leftover). The
 * rule deliberately keys on the seed headings so a pristine template,
 * or an authored heading of the user's own, never trips it.
 * @param {any} doc
 * @returns {{ widgets: string[], problems: string[], notes: string[] }}
 */
function auditDocumentRender(doc) {
  /** @type {{ widgets: string[], problems: string[], headings: string[], formTitles: string[] }} */
  const out = { widgets: [], problems: [], headings: [], formTitles: [] };
  let vnode;
  try {
    vnode = compileJsltStylesheet(doc.view, { compileTypeTest, memo: false })(doc.state);
  }
  catch (err) {
    out.problems.push(`the view failed to render its first frame: ${message(err)}`);
    return { widgets: out.widgets, problems: out.problems, notes: [] };
  }
  walkRenderedVnode(vnode, '', out);

  /** @type {string[]} */
  const notes = [];
  const markers = getSeedHeadings();
  for (const heading of out.headings) {
    const seedTitles = markers.get(heading);
    if (seedTitles === undefined) continue;
    const departed = out.formTitles.find((title) => !seedTitles.has(title)
      && !heading.toLowerCase().includes(title.toLowerCase()));
    if (departed !== undefined) {
      notes.push(`the heading "${heading}" is still the seed template's while the form is now titled "${departed}" — patch the heading to match the repurposed form`);
      break;
    }
  }
  return { widgets: out.widgets, problems: out.problems, notes };
}

//#endregion

/**
 * Validate a document against the meta-schema and boot it as an
 * isolated app: no effects, no subs, its own `onError` sink, the
 * render-capability widgets, and the runtime's atomic-boot guarantee.
 * @param {any} doc
 * @param {{ node?: any, document?: any, schedule?: (flush: () => void) => void,
 *   onError?: (err: Error) => void }} env
 * @returns {{ ok: true, app: any } | { ok: false, errors: any[], total: number, message: string }}
 */
function loadStudioDocument(doc, env = {}) {
  const report = validateAppDocument(doc);
  if (!report.valid) {
    return {
      ok: false,
      errors: report.errors,
      total: report.total,
      message: `the document does not validate against the jaren-app meta-schema (${report.total} error${report.total === 1 ? '' : 's'})`,
    };
  }
  try {
    const app = createApp(doc, {
      node: env.node,
      document: env.document,
      schedule: env.schedule,
      widgets: STUDIO_WIDGETS,
      compileTypeTest,
      // the form widget's typed selects and json editor decode here
      eventFields: { ...formEventFields() },
      onError: env.onError,
      // deliberately absent: effects, subs — the isolation boundary
    });
    return { ok: true, app };
  }
  catch (err) {
    // JA0007: boot rolled back atomically, the container ends empty
    return { ok: false, errors: [], total: 0, message: message(err) };
  }
}

return { validateAppDocument, STUDIO_WIDGETS, auditDocumentRender, loadStudioDocument };
}
