//@ts-check
/**
 * The Studio boundary — a second, untrusted app document hosted next to
 * the site's own.
 *
 * An `@jarenjs/app` document IS a website (this site is one), so the
 * generative tier needs no new runtime — only a safe host. The threat
 * model is the meta-schema: `@jarenjs/app/schemas/jaren-app.schema.json`
 * compiled by `@jarenjs/validate` gates every boot, and the nested
 * `createApp` is granted **no effects and no subs** — a studio document
 * is inert JSON whose worst case is failing validation or rendering
 * junk inside its error-contained mount. Boot is atomic by the app
 * runtime's own contract: a document that fails mid-boot throws
 * `JA0007` and leaves no half-mounted DOM.
 *
 * Hosting mechanism (decided by reading the code, recorded here): a
 * `jaren-widget` whose mount/destroy owns the nested app — the nested
 * `createApp` needs a DOM host element the renderer owns, which a
 * charts-style `sync(inputs, dispatch, active)` hook never sees; and
 * the renderer's destroy walk guarantees `unmount` exactly once when
 * the vnode leaves the tree (the 0.17.x recycle-ownership rules), so
 * leaving the route destroys the nested app for free.
 *
 * The document gets a small render-capability vocabulary as widgets —
 * `form`, `chart`, `markdown`, `mermaid` — each a pure props→vnode
 * projection through the suite's own compilers (no host effects; a
 * form widget's bindings `emit` back into the document's own actions).
 */

import { JarenValidator } from '@jarenjs/validate';
import { createTypeTestCompiler } from '@jarenjs/validate/query';
import { createApp, createFormView } from '@jarenjs/app';
import { createDomRenderer } from '@jarenjs/view';
import { compileJsltStylesheet } from '@jarenjs/json/jslt';
import { buildFormModel, buildFormViewModel } from '@jarenjs/forms';
import { compileChart } from '@jarenjs/charts';
import appSchema from '@jarenjs/app/schemas/jaren-app.schema.json' with { type: 'json' };
import querySchema from '@jarenjs/json/schemas/jaren-query.schema.json' with { type: 'json' };
import jsltSchema from '@jarenjs/json/schemas/jaren-jslt.schema.json' with { type: 'json' };

import { md } from './markdown.js';
import { mermaid } from './mermaid.js';

/** Schema errors kept per report: enough to repair, bounded for state. */
const MAX_ERRORS = 20;

// the meta-schema composes the published query and JSLT grammars by
// reference — register those artifacts alongside it (APP-FORMAT §2)
const validateApp = new JarenValidator({ skipErrors: false, collectErrors: true })
  .addSchema(querySchema)
  .addSchema(jsltSchema)
  .compile(appSchema);

const message = (err) => /** @type {Error} */ (err)?.message ?? String(err);

/**
 * Validate a candidate document against the jaren-app meta-schema.
 * @param {any} doc
 * @returns {{ valid: boolean, errors: Array<{ instancePath: string, keyword: string, message: string }>, total: number }}
 */
export function validateAppDocument(doc) {
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
    // static path); theme 'host' keeps light/dark live (DESIGN.md §7)
    return ['div', { class: 'studio-chart' },
      compileChart(props.config, props.config, { theme: 'host' }).toVnode()];
  }
  catch (err) {
    return ['p', { class: 'error-line' }, `chart: ${message(err)}`];
  }
}

const markdownVnode = (props) => md.view(String(props?.source ?? ''));
const mermaidVnode = (props) => mermaid.view(String(props?.source ?? ''));

/** The render capabilities a studio document may name (and nothing else). */
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

/**
 * Validate a document against the meta-schema and boot it as an
 * isolated app: no effects, no subs, its own `onError` sink, the
 * render-capability widgets, and the runtime's atomic-boot guarantee.
 * @param {any} doc
 * @param {{ node?: any, document?: any, schedule?: (flush: () => void) => void,
 *   onError?: (err: Error) => void }} env
 * @returns {{ ok: true, app: any } | { ok: false, errors: any[], total: number, message: string }}
 */
export function loadStudioDocument(doc, env = {}) {
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

/**
 * The site-side host widget: `['jaren-widget', { name: 'studio-doc',
 * props: { doc, revision } }]` in the studio view. Mount boots the
 * nested app into the host; a revision change destroys and reboots;
 * unmount (the destroy walk — route leave included) destroys it. Boot
 * and runtime failures surface as `studio/error` dispatches through
 * `emit`, never as throws into the site's render.
 * @param {{ schedule?: (flush: () => void) => void }} [env]
 */
export function createStudioHostWidget(env = {}) {
  const boot = (handle, props) => {
    const result = loadStudioDocument(props.doc, {
      node: handle.host,
      document: handle.host.ownerDocument,
      schedule: env.schedule,
      onError: (err) => handle.emit({ action: 'studio/error', with: message(err) }),
    });
    if (result.ok) {
      handle.app = result.app;
    }
    else {
      handle.app = null;
      handle.emit({ action: 'studio/error', with: result.message });
    }
  };
  const destroy = (handle) => {
    try {
      handle.app?.destroy();
    }
    catch (err) {
      handle.emit({ action: 'studio/error', with: message(err) });
    }
    handle.app = null;
  };
  return {
    mount(host, props, emit) {
      const handle = { host, emit, app: null };
      boot(handle, props);
      return handle;
    },
    update(handle, props, prevProps) {
      if (props.doc === prevProps.doc && props.revision === prevProps.revision) return;
      destroy(handle);
      boot(handle, props);
    },
    unmount(handle) {
      destroy(handle);
    },
  };
}
