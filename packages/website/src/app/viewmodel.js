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
import { md } from '../boundaries/markdown.js';
import { chartsPageDemos, chartsPageStreamingCallout } from '../boundaries/chartspage.js';
import { binanceInvitation } from '../boundaries/binance.js';
import { contributeCalcViewModel } from '@jarenjs/calc/component';
import { PROVIDER_OPTIONS, isConfigured } from '../boundaries/assistant.js';
import { callout } from '../lib/nodes.js';
import { formatMs, memo1 } from '../lib/format.js';
import { DEFAULT_SCHEMA_TEXT, DEFAULT_DATA } from './state.js';

const NAV = [
  { page: 'home', label: 'Home', href: '#/' },
  { page: 'playground', label: 'Playground', href: '#/playground' },
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
    schemaText: JSON.stringify(exampleSchemas.conditional.schema, null, 2),
    data: exampleSchemas.conditional.data,
  },
  {
    label: 'Cross-field ($query)',
    schemaText: JSON.stringify(exampleSchemas.queryKeyword.schema, null, 2),
    data: exampleSchemas.queryKeyword.data,
  },
  {
    label: 'Invalid data',
    schemaText: DEFAULT_SCHEMA_TEXT,
    data: { name: 'A', email: 'not-an-email', age: 7 },
  },
];

/**
 * @param {any} state
 * @returns {any} the view input document
 */
export function viewModel(state) {
  const page = state.route.page;
  /** @type {any} */
  const ui = { nav: deriveNav(page) };

  if (page === 'home') ui.home = HOME_CONTENT;
  if (page === 'benchmarks') ui.bench = benchPage(state);
  if (page === 'charts') ui.chartsPage = chartsPage(state);
  if (page === 'playground') ui.pg = playgroundPage(state);
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
    },
    providers: PROVIDER_OPTIONS.map((p) => ({ ...p, selected: p.value === s.provider })),
    empty: ai.messages.length === 0,
    messages: ai.messages.map((m) => (m.role === 'user'
      ? { role: 'user', text: m.content }
      : { role: 'assistant', article: md.view(m.content) })),
    // the reply currently streaming in (plain text: it changes per token)
    streaming: ai.status === 'streaming',
    pending: ai.pending,
  };
});

const readmeOverlay = memo1((readme) => ({
  title: readme.title,
  status: readme.status,
  message: readme.message,
  article: readme.source !== null ? md.view(readme.source) : null,
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
  dataJson: JSON.stringify(data, null, 2),
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

const J = (value) => JSON.stringify(value, null, 2);

/** The primary input previewed on each example card, per engine. */
const PREVIEW_FIELD = {
  path: 'selector', pointer: 'pointer', patch: 'patch', query: 'query',
  jslt: 'stylesheet', jtlt: 'template', xquery: 'text', josl: 'text',
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
      preview: J(example.schema),
      payload: { validate: true, schemaText: J(example.schema), data: example.data },
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
