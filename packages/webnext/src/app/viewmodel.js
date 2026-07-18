//@ts-check
/**
 * The derivation boundary (APP-FORMAT §5.2): state in, the view
 * stylesheet's input document out, once per render. Everything the
 * rules address under `$.ui` is computed here; the raw state rides
 * along untouched for the rules that read it directly.
 */

import { deriveSuite, SUITES } from '../boundaries/bench.js';
import { formViewFor, localizeErrors } from '../boundaries/validator.js';
import { HOME_CONTENT } from '../content/home.js';
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
  { key: 'path', label: 'JSONPath' },
  { key: 'pointer', label: 'JSON Pointer' },
  { key: 'patch', label: 'JSON Patch' },
  { key: 'query', label: 'JSON Query' },
  { key: 'jslt', label: 'JSLT' },
  { key: 'jtlt', label: 'JTLT' },
  { key: 'xquery', label: 'XQuery' },
  { key: 'josl', label: 'JOSL' },
];

const PG_EXAMPLES = [
  {
    label: 'User',
    schemaText: DEFAULT_SCHEMA_TEXT,
    data: DEFAULT_DATA,
  },
  {
    label: 'Conditional',
    schemaText: JSON.stringify({
      type: 'object',
      title: 'Shipping',
      properties: {
        country: { enum: ['NL', 'BE', 'DE'] },
        postalCode: { type: 'string' },
      },
      if: { properties: { country: { const: 'NL' } }, required: ['country'] },
      then: { properties: { postalCode: { type: 'string', pattern: '^[0-9]{4}?[A-Z]{2}$' } } },
    }, null, 2),
    data: { country: 'NL', postalCode: '1234 AB' },
  },
  {
    label: 'Invalid data',
    schemaText: DEFAULT_SCHEMA_TEXT,
    data: { name: 'A', email: 'not-an-email', age: 7 },
  },
];

/**
 * State in, the view input document out. Only the ACTIVE page's node
 * exists under `$.ui` — the shell `$apply`s every page member, and an
 * absent member selects nothing, so page switching needs no
 * conditionals in the stylesheet at all.
 * @param {any} state
 * @returns {any} the view input document
 */
export function viewModel(state) {
  const page = state.route.page;
  /** @type {any} */
  const ui = {
    nav: NAV.map((item) => ({ ...item, active: item.page === page })),
  };

  if (page === 'home') {
    ui.home = HOME_CONTENT;
  }

  if (page === 'benchmarks') {
    const suite = state.route.params.suite ?? 'overview';
    ui.bench = {
      suites: SUITES.map((s) => ({
        ...s,
        active: s.key === suite,
        href: `#/benchmarks?suite=${s.key}`,
      })),
      nodes: deriveSuite(state, suite),
    };
  }

  if (page === 'playground') {
    const engine = state.route.params.engine ?? 'validate';
    ui.pg = {
      engine,
      engines: PG_ENGINES.map((e) => ({
        ...e,
        active: e.key === engine,
        href: `#/playground?engine=${e.key}`,
      })),
      validate: engine !== 'validate' ? null : {
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
      },
    };
  }

  if (page === 'docs') ui.docs = {};
  if (page === 'examples') ui.examples = {};

  return { ...state, ui };
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
