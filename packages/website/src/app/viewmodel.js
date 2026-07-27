//@ts-check
/**
 * The derivation boundary (APP-FORMAT §5.2): state in, the view
 * stylesheet's input document out, once per render. Only the ACTIVE
 * page's node exists under `$.ui` — the shell `$apply`s every page
 * member and absent members select nothing, so page switching needs no
 * conditionals in the stylesheet.
 */

import { deriveSuite, SUITES } from '../boundaries/bench.js';
import { formViewFor, localizeErrors } from '../boundaries/validator.js';
import { ENGINE_DEFS, ENGINE_EXAMPLES } from '../boundaries/engines.js';
import { HOME_CONTENT } from '../content/home.js';
import { DOCS_SECTIONS } from '../content/docs.js';
import { PACKAGES } from '../content/packages.js';
import { exampleSchemas } from '../content/schemas.js';
import { md, rewriteReadmeLinks } from '../boundaries/markdown.js';
import { chartsPageDemos, chartsPageStreamingCallout } from '../boundaries/chartspage.js';
import { binanceInvitation } from '../boundaries/binance.js';
import { contributeCalcViewModel } from '@jarenjs/calc/component';
import { PROVIDER_OPTIONS, isConfigured } from '../boundaries/assistant.js';
import { STUDIO_TEMPLATES } from '../content/appTemplates.js';
import { callout, error } from '../lib/nodes.js';
import { formatJson, formatMs, formatRatio, memo1 } from '../lib/format.js';
import { DEFAULT_SCHEMA_TEXT, DEFAULT_DATA } from './state.js';

const NAV = [
  { page: 'home', label: 'Home', href: '#/' },
  { page: 'playground', label: 'Playground', href: '#/playground' },
  { page: 'studio', label: 'Studio', href: '#/studio' },
  { page: 'benchmarks', label: 'Benchmarks', href: '#/benchmarks' },
  { page: 'charts', label: 'Charts', href: '#/charts' },
  { page: 'docs', label: 'Docs', href: '#/docs' },
  { page: 'examples', label: 'Examples', href: '#/examples' },
  { page: 'calculator', label: 'Calculator', href: '#/calculator' },
];

const PG_ENGINES = [
  { key: 'validate', label: 'JSON Schema' },
  ...Object.entries(ENGINE_DEFS).map(([key, def]) => ({ key, label: def.label })),
];

const PG_EXAMPLES = [
  { label: 'User', schemaText: DEFAULT_SCHEMA_TEXT, data: DEFAULT_DATA },
  {
    label: 'Conditional',
    schemaText: formatJson(exampleSchemas.conditional.schema),
    data: exampleSchemas.conditional.data,
  },
  {
    label: 'Cross-field ($query)',
    schemaText: formatJson(exampleSchemas.queryKeyword.schema),
    data: exampleSchemas.queryKeyword.data,
  },
  {
    label: 'Invalid data',
    schemaText: DEFAULT_SCHEMA_TEXT,
    data: { name: 'A', email: 'not-an-email', age: 7 },
  },
];

/** Home engine card → the benchmark headline that measures it. */
const HOME_ENGINE_SUITE = {
  validate: 'validate', path: 'jsonpath', pointer: 'jsonpointer', patch: 'jsonpatch',
  query: 'jsonquery', jslt: 'jslt', josl: 'toml', csv: 'csv', charts: 'charts',
  markdown: 'markdown', mermaid: 'mermaid',
};

/**
 * The home content with its performance line taken from the generated
 * benchmark run rather than from prose. A card whose engine has a
 * headline shows that run's measured ratio; everything else — and the
 * whole page before `meta.json` arrives, or if it fails to — keeps the
 * static line, which is why those stay claims that cannot go stale.
 * @param {any} state
 * @returns {any}
 */
function homeContent(state) {
  const headlines = state.bench?.meta?.headlines;
  if (!Array.isArray(headlines) || headlines.length === 0) return HOME_CONTENT;
  const byKey = new Map(headlines.map((h) => [h.key, h]));
  return {
    ...HOME_CONTENT,
    engines: HOME_CONTENT.engines.map((engine) => {
      const headline = byKey.get(HOME_ENGINE_SUITE[engine.key]);
      if (headline === undefined || !Number.isFinite(headline.ratio)) return engine;
      // formatRatio names the direction, so a sub-parity suite reads
      // "2.3× slower than …" rather than the cryptic "0.4× vs …"
      const speed = `${formatRatio(headline.ratio)} than ${headline.rival}`;
      return {
        ...engine,
        perf: headline.conformance
          ? `${headline.conformance} conformance · ${speed}`
          : speed,
      };
    }),
  };
}

/**
 * @param {any} state
 * @returns {any} the view input document
 */
export function viewModel(state) {
  const page = state.route.page;
  /** @type {any} */
  const ui = { nav: deriveNav(page) };

  if (page === 'home') ui.home = homeContent(state);
  if (page === 'benchmarks') ui.bench = benchPage(state);
  if (page === 'charts') ui.chartsPage = chartsPage(state);
  if (page === 'playground') ui.pg = playgroundPage(state);
  if (page === 'studio') ui.studio = studioPage(state);
  if (page === 'docs') ui.docs = docsPage(state.route.params.s);
  if (page === 'examples') ui.examples = examplesPage(state.route.params.engine);
  if (page === 'calculator') ui.calculator = contributeCalcViewModel(state, { theme: 'host' });

  // The README dialog is a global overlay (any page can open it): it
  // only materializes when open, so the shell's $apply renders nothing
  // otherwise. `md.view` memoizes the article by source string, so a
  // re-render with the same README returns the same vnode reference.
  if (state.readme.open) ui.readme = readmeOverlay(state.readme);

  // The AI assistant is a global slide-out on every page.
  ui.assistant = assistantView(state.ai);

  return { ...state, ui };
}

const assistantView = memo1((ai) => {
  const s = ai.settings;
  const configured = isConfigured(s);
  return {
    open: ai.open,
    status: ai.status,
    activity: ai.activity,
    error: ai.error,
    draft: ai.draft,
    configured,
    // the settings form shows until the assistant can actually run, or
    // whenever the user opens it explicitly
    showSettings: ai.settingsOpen || !configured,
    settings: {
      provider: s.provider,
      baseUrl: s.baseUrl,
      model: s.model,
      apiKey: s.apiKey,
      needsKey: s.provider === 'openrouter' || s.provider === 'custom',
      probe: {
        status: ai.probe.status,
        detail: ai.probe.detail,
        busy: ai.probe.status === 'busy',
        ok: ai.probe.status === 'ok',
        fail: ai.probe.status === 'fail',
        models: ai.probe.models.map((id) => ({ id })),
      },
    },
    providers: PROVIDER_OPTIONS.map((p) => ({ ...p, selected: p.value === s.provider })),
    empty: ai.messages.length === 0,
    messages: ai.messages.map((m) => (m.role === 'user'
      ? { role: 'user', text: m.content }
      : { role: 'assistant', article: md.view(m.content) })),
    // the reply currently streaming in (plain text: it changes per token)
    streaming: ai.status === 'streaming',
    pending: ai.pending,
    // the quiet-phase label: reasoning models think before they speak,
    // and watching the thinking grow beats a blind spinner
    thinkingLabel: ai.reasoningChars > 0
      ? `Thinking… (${ai.reasoningChars} characters of reasoning)`
      : 'Thinking…',
  };
});

const readmeOverlay = memo1((readme) => ({
  title: readme.title,
  status: readme.status,
  message: readme.message,
  canBack: readme.at > 0,
  canForward: readme.at < readme.stack.length - 1,
  // repo-relative links inside the article navigate the dialog itself
  article: readme.source !== null
    ? rewriteReadmeLinks(md.view(readme.source), readme.url)
    : null,
}));

const deriveNav = memo1((page) =>
  NAV.map((item) => ({ ...item, active: item.page === page })));

const benchTabs = memo1((suite) => SUITES.map((s) => ({
  ...s,
  active: s.key === suite,
  href: `#/benchmarks?suite=${s.key}`,
})));

const benchNodes = memo1((suite, data, status, benchUi, state) =>
  deriveSuite(state, suite));

const composeBench = memo1((suites, nodes) => ({ suites, nodes }));

const chartsPage = (state) => composeChartsPage(state.chartsLive);
const composeChartsPage = memo1((live) => ({
  live: live ?? binanceInvitation('page'),
  demos: [...chartsPageDemos(), chartsPageStreamingCallout()],
}));

function benchPage(state) {
  const suite = state.route.params.suite ?? 'overview';
  const need = suite === 'overview' ? 'meta' : suite;
  return composeBench(
    benchTabs(suite),
    benchNodes(suite, state.bench[need], state.benchStatus[need], state.benchUi, state));
}

const pgTabs = memo1((engine) => PG_ENGINES.map((e) => ({
  ...e,
  active: e.key === engine,
  href: `#/playground?engine=${e.key}`,
})));

const pgIde = memo1((name, names, shared) => ({
  name,
  shared,
  names: names.map((n) => ({ name: n })),
}));

const validateNode = memo1((schemaText, data, dataTab, dataError, locale, result) => ({
  examples: PG_EXAMPLES,
  schemaText,
  dataTab,
  dataJson: formatJson(data),
  dataError,
  locale,
  form: dataTab === 'form' ? formViewFor(schemaText, data) : null,
  result: deriveResult(result, locale),
}));

const genericNode = memo1((engine, inputs, engineResults) => {
  const def = ENGINE_DEFS[engine];
  return {
    key: engine,
    label: def.label,
    lead: def.lead,
    fields: def.inputs
      .filter((field) => matchesWhen(field.when, inputs))
      .map((field) => ({
        engine,
        key: field.key,
        title: field.title,
        control: field.control,
        rows: field.rows ?? 4,
        value: inputs[field.key] ?? '',
        options: field.options?.map((option) => ({
          value: option,
          selected: option === inputs[field.key],
        })) ?? null,
      })),
    examples: (ENGINE_EXAMPLES[engine] ?? []).map((example) => ({
      label: example.label,
      engine,
      inputs: withAllFields(engine, example.inputs),
    })),
    results: engineResults
      ?? [callout('Ready', 'Edit any input to run — results appear live.')],
  };
});

const composePg = memo1((engine, engines, ide, validate, generic) => {
  /** @type {any} */
  const page = { engine, engines, ide };
  // exactly one of `validate` / `generic` is set; the other stays
  // ABSENT so its $apply selects nothing
  if (validate !== null) page.validate = validate;
  if (generic !== null) page.generic = generic;
  return page;
});

function playgroundPage(state) {
  const engine = state.route.params.engine ?? 'validate';
  const validate = engine === 'validate'
    ? validateNode(state.pg.schemaText, state.pg.data, state.pg.dataTab,
      state.pg.dataError, state.pg.locale, state.pg.result)
    : null;
  const generic = engine !== 'validate' && ENGINE_DEFS[engine] !== undefined
    ? genericNode(engine, state.eng[engine] ?? {}, state.engResults[engine] ?? null)
    : null;
  return composePg(engine, pgTabs(engine),
    pgIde(state.ide.name, state.ide.names, state.ide.shared),
    validate, generic);
}

// ---- the Studio ----

/** The picker cards: constant content, computed once. */
const STUDIO_PICKER = {
  templates: STUDIO_TEMPLATES.map((t) => ({
    name: t.name,
    title: t.title,
    lead: t.lead,
    preview: formatJson(t.doc).split('\n').slice(0, 14).join('\n') + '\n…',
  })),
};

/** The host-widget props: reference-stable per (doc, revision). */
const studioMount = memo1((doc, revision) => ({ doc, revision }));

const studioEditorText = memo1((doc) => formatJson(doc));

/** A failed validation report as the site's standard error nodes. */
const studioErrorNodes = memo1((errors) => {
  if (errors === null) return [];
  const nodes = errors.list.map((e) => error({
    message: e.message,
    dataPath: e.instancePath,
    code: e.keyword !== '' ? e.keyword : undefined,
  }, 'Schema error'));
  if (errors.total > errors.list.length) {
    nodes.push(callout('More errors', `${errors.total - errors.list.length} further meta-schema errors were truncated — fix the ones above first.`));
  }
  return nodes;
});

const composeStudioLive = memo1((editorText, revision, bootError, ide, mount) => ({
  editorText,
  revision,
  error: bootError,
  ide,
  mount,
}));

// the validation report renders at page level: a failed editor commit
// (or an invalid inbound share) reports whether or not a document is
// currently live — the old document stays mounted underneath
const composeStudioPage = memo1((live, errorNodes) => ({
  ...(live === null ? { picker: STUDIO_PICKER } : { live }),
  errors: errorNodes,
  hasErrors: errorNodes.length > 0,
}));

function studioPage(state) {
  const s = state.studio;
  const live = s.doc === null ? null : composeStudioLive(
    studioEditorText(s.doc), s.revision, s.error,
    pgIde(state.ide.name, state.ide.names, state.ide.shared),
    studioMount(s.doc, s.revision));
  return composeStudioPage(live, studioErrorNodes(s.errors));
}

function matchesWhen(when, inputs) {
  if (when === undefined) return true;
  const value = inputs[when.key];
  return Array.isArray(when.value) ? when.value.includes(value) : when.value === value;
}

/** Example inputs must cover every field, so `eng/load` replaces cleanly. */
function withAllFields(engine, inputs) {
  const out = { ...inputs };
  for (const field of ENGINE_DEFS[engine].inputs) {
    if (out[field.key] === undefined) out[field.key] = '';
  }
  return out;
}

function deriveResult(r, locale) {
  if (r === null) return { status: 'idle' };
  if (r.schemaError !== null) {
    return { status: 'schema-error', schemaError: r.schemaError };
  }
  return {
    status: r.valid ? 'valid' : 'invalid',
    draft: r.draft,
    timing: `compile ${formatMs(r.compileMs)} · validate ${formatMs(r.validateMs)}`,
    errors: localizeErrors(r.errors, locale).map((e) => ({
      path: e.instancePath === '' ? '(root)' : e.instancePath,
      message: e.message,
    })),
  };
}

const docsPage = memo1((param) => {
  const current = param ?? DOCS_SECTIONS[0].id;
  const section = DOCS_SECTIONS.find((s) => s.id === current) ?? DOCS_SECTIONS[0];
  return {
    sections: DOCS_SECTIONS.map((s) => ({
      id: s.id,
      title: s.title,
      active: s.id === section.id,
      href: `#/docs?s=${s.id}`,
    })),
    section: { title: section.title, blocks: section.blocks },
    packages: PACKAGES,
  };
});

/** The primary input previewed on each example card, per engine. */
const PREVIEW_FIELD = {
  path: 'selector', pointer: 'pointer', patch: 'patch', query: 'query',
  jslt: 'stylesheet', jtlt: 'template', xquery: 'text', josl: 'text', csv: 'text',
  markdown: 'source', mermaid: 'source', charts: 'source',
};

const examplesPage = memo1((param) => {
  const engine = param ?? 'validate';
  const tabs = PG_ENGINES.map((e) => ({
    ...e,
    active: e.key === engine,
    href: `#/examples?engine=${e.key}`,
  }));
  let items;
  if (engine === 'validate') {
    items = Object.values(exampleSchemas).map((example) => ({
      label: example.name,
      preview: formatJson(example.schema),
      payload: { validate: true, schemaText: formatJson(example.schema), data: example.data },
    }));
  }
  else {
    const field = PREVIEW_FIELD[engine];
    items = (ENGINE_EXAMPLES[engine] ?? []).map((example) => ({
      label: example.label,
      preview: example.inputs[field] !== '' && example.inputs[field] !== undefined
        ? example.inputs[field]
        : example.inputs.data ?? '',
      payload: { engine, inputs: withAllFields(engine, example.inputs) },
    }));
  }
  return { tabs, items };
});
