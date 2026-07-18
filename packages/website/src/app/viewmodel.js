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
import { exampleSchemas } from '../content/schemas.js';
import { callout } from '../lib/nodes.js';
import { formatMs } from '../lib/format.js';
import { DEFAULT_SCHEMA_TEXT, DEFAULT_DATA } from './state.js';

const NAV = [
  { page: 'home', label: 'Home', href: '#/' },
  { page: 'playground', label: 'Playground', href: '#/playground' },
  { page: 'benchmarks', label: 'Benchmarks', href: '#/benchmarks' },
  { page: 'docs', label: 'Docs', href: '#/docs' },
  { page: 'examples', label: 'Examples', href: '#/examples' },
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
  const ui = {
    nav: NAV.map((item) => ({ ...item, active: item.page === page })),
  };

  if (page === 'home') ui.home = HOME_CONTENT;
  if (page === 'benchmarks') ui.bench = benchPage(state);
  if (page === 'playground') ui.pg = playgroundPage(state);
  if (page === 'docs') ui.docs = docsPage(state);
  if (page === 'examples') ui.examples = examplesPage(state);

  return { ...state, ui };
}

function benchPage(state) {
  const suite = state.route.params.suite ?? 'overview';
  return {
    suites: SUITES.map((s) => ({
      ...s,
      active: s.key === suite,
      href: `#/benchmarks?suite=${s.key}`,
    })),
    nodes: deriveSuite(state, suite),
  };
}

function playgroundPage(state) {
  const engine = state.route.params.engine ?? 'validate';
  const page = {
    engine,
    engines: PG_ENGINES.map((e) => ({
      ...e,
      active: e.key === engine,
      href: `#/playground?engine=${e.key}`,
    })),
    ide: {
      name: state.ide.name,
      names: state.ide.names.map((name) => ({ name })),
    },
    // exactly one of `validate` / `generic` is set below; the other
    // stays ABSENT so its $apply selects nothing
  };
  if (engine === 'validate') {
    page.validate = {
      examples: PG_EXAMPLES,
      schemaText: state.pg.schemaText,
      dataTab: state.pg.dataTab,
      dataJson: JSON.stringify(state.pg.data, null, 2),
      dataError: state.pg.dataError,
      locale: state.pg.locale,
      form: state.pg.dataTab === 'form'
        ? formViewFor(state.pg.schemaText, state.pg.data)
        : null,
      result: deriveResult(state.pg),
    };
  }
  else if (ENGINE_DEFS[engine] !== undefined) {
    const def = ENGINE_DEFS[engine];
    const inputs = state.eng[engine] ?? {};
    page.generic = {
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
      results: state.engResults[engine]
        ?? [callout('Ready', 'Edit any input to run — results appear live.')],
    };
  }
  return page;
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

function deriveResult(pg) {
  const r = pg.result;
  if (r === null) return { status: 'idle' };
  if (r.schemaError !== null) {
    return { status: 'schema-error', schemaError: r.schemaError };
  }
  return {
    status: r.valid ? 'valid' : 'invalid',
    draft: r.draft,
    timing: `compile ${formatMs(r.compileMs)} · validate ${formatMs(r.validateMs)}`,
    errors: localizeErrors(r.errors, pg.locale).map((e) => ({
      path: e.instancePath === '' ? '(root)' : e.instancePath,
      message: e.message,
    })),
  };
}

function docsPage(state) {
  const current = state.route.params.s ?? DOCS_SECTIONS[0].id;
  const section = DOCS_SECTIONS.find((s) => s.id === current) ?? DOCS_SECTIONS[0];
  return {
    sections: DOCS_SECTIONS.map((s) => ({
      id: s.id,
      title: s.title,
      active: s.id === section.id,
      href: `#/docs?s=${s.id}`,
    })),
    section: { title: section.title, blocks: section.blocks },
  };
}

const J = (value) => JSON.stringify(value, null, 2);

/** The primary input previewed on each example card, per engine. */
const PREVIEW_FIELD = {
  path: 'selector', pointer: 'pointer', patch: 'patch', query: 'query',
  jslt: 'stylesheet', jtlt: 'template', xquery: 'text', josl: 'text',
};

function examplesPage(state) {
  const engine = state.route.params.engine ?? 'validate';
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
}
