//@ts-check
/**
 * The playground engine framework: every engine is a descriptor —
 * input fields plus a `run(inputs)` boundary that returns kind-tagged
 * render nodes. The generic playground rules render any engine from
 * this table; adding an engine is adding an entry.
 *
 * All inputs are TEXT (JSON where applicable), which keeps the generic
 * input handling, the saved-experiment store and the WebMCP tools
 * trivially serializable.
 */

import {
  compileJSONPath,
  compileJSONPointer,
  compileRelativeJSONPointer,
  JSONPOINTER_NOTHING,
  compileJSONPatch,
  applyMergePatch,
  createJSONPatch,
  createMergePatch,
  compileJSONPointerSetter,
  compileJSONPointerInserter,
  compileJSONPointerRemover,
  compileJSONPathSetter,
  compileJSONPathInserter,
  compileJSONPathRemover,
  JsonWriteError,
  compileJsonQuery,
} from '@jarenjs/json';
import { compileJsltStylesheet, transformJson } from '@jarenjs/json/jslt';
import { compileJtltStylesheet } from '@jarenjs/json/jtlt';
import { parseXQuery } from '@jarenjs/json/xquery';
import { parseJosl, stringifyJosl, stringifyJsonx } from '@jarenjs/josl';
import { parseCsvDocument, stringifyCsv, sniffCsvDialect } from '@jarenjs/josl/csv';
import { toMarkdown } from '@jarenjs/md';
import { md as MD } from './markdown.js';
import { mermaid as MERMAID } from './mermaid.js';
import { runCharts, chartsSync } from './charts.js';
import { binanceSync } from './binance.js';
import stateToWorkflow from '@jarenjs/mermaid/stylesheets/state-to-workflow.jslt.json' with { type: 'json' };
import { createTypeTestCompiler } from '@jarenjs/validate/query';

import { cards, table, code, error, callout, details, markdown } from '../lib/nodes.js';
import { now, formatJson, formatMsUnscaled } from '../lib/format.js';
import {
  pathExamples, pointerExamples, patchExamples, queryExamples,
  jsltExamples, jtltExamples, xqueryExamples, joslExamples, csvExamples,
  markdownExamples, mermaidExamples, chartsExamples,
} from '../content/engineExamples.js';

const compileTypeTest = createTypeTestCompiler();

/** Parse a JSON input; returns `{ value }` or `{ node }` (an error node). */
function parseJson(text, label) {
  try {
    return { value: JSON.parse(text) };
  }
  catch (err) {
    return { node: error({ message: `${label}: ${/** @type {Error} */ (err).message}` }, 'Invalid JSON') };
  }
}

function timed(fn) {
  const start = now();
  const value = fn();
  return { value, ms: now() - start };
}

//#region runners

function runPath(inputs) {
  const data = parseJson(inputs.data, 'data');
  if (data.node) return [data.node];
  try {
    const compiled = timed(() => compileJSONPath(inputs.selector));
    const run = timed(() => compiled.value.nodes(data.value));
    const nodes = run.value;
    return [
      cards([
        { title: 'Matches', value: String(nodes.length) },
        { title: 'Compile', value: formatMsUnscaled(compiled.ms) },
        { title: 'Run', value: formatMsUnscaled(run.ms) },
      ]),
      code('Values', formatJson(nodes.map((n) => n.value))),
      code('Normalized paths', formatJson(nodes.map((n) => n.path))),
    ];
  }
  catch (err) {
    return [error(err, 'JSONPath error')];
  }
}

function runPointer(inputs) {
  const data = parseJson(inputs.data, 'data');
  if (data.node) return [data.node];
  try {
    const relative = inputs.mode === 'relative';
    const getter = relative
      ? compileRelativeJSONPointer(inputs.pointer)
      : compileJSONPointer(inputs.pointer);
    const value = relative
      ? getter(data.value, inputs.location)
      : getter(data.value);
    if (value === JSONPOINTER_NOTHING) {
      return [callout('Nothing', 'The pointer addresses no value in this document (the NOTHING sentinel — a miss, not an error).')];
    }
    return [code('Value', formatJson(value), relative ? `relative to ${inputs.location}` : null)];
  }
  catch (err) {
    return [error(err, 'Pointer error')];
  }
}

const POINTER_WRITERS = { set: compileJSONPointerSetter, insert: compileJSONPointerInserter, remove: compileJSONPointerRemover };
const PATH_WRITERS = { set: compileJSONPathSetter, insert: compileJSONPathInserter, remove: compileJSONPathRemover };

function runPatch(inputs) {
  const data = parseJson(inputs.data, 'document');
  if (data.node) return [data.node];
  const doc = data.value;
  try {
    switch (inputs.mode) {
      case 'merge': {
        const patch = parseJson(inputs.patch, 'merge patch');
        if (patch.node) return [patch.node];
        const run = timed(() => applyMergePatch(doc, patch.value));
        return [
          code('Result', formatJson(run.value), run.value === doc ? '=== input (shared)' : formatMsUnscaled(run.ms)),
        ];
      }
      case 'write': {
        let writer, multi = false;
        try {
          writer = POINTER_WRITERS[inputs.writeOp](inputs.writeTarget);
        }
        catch (err) {
          if (err instanceof JsonWriteError && err.code === 'JW0001' && inputs.writeTarget.startsWith('$')) {
            writer = PATH_WRITERS[inputs.writeOp](inputs.writeTarget);
            multi = true;
          }
          else throw err;
        }
        let value;
        if (inputs.writeOp === 'remove') {
          value = writer(doc);
        }
        else {
          const writeValue = parseJson(inputs.writeValue, 'value');
          if (writeValue.node) return [writeValue.node];
          value = writer(doc, writeValue.value);
        }
        return [
          code('Result', formatJson(value),
            value === doc ? '=== input (shared)' : (multi ? 'every match' : 'singular target')),
        ];
      }
      case 'diff': {
        const target = parseJson(inputs.target, 'target');
        if (target.node) return [target.node];
        const jsonPatch = createJSONPatch(doc, target.value);
        const mergePatch = createMergePatch(doc, target.value);
        return [
          code('JSON Patch (RFC 6902)', formatJson(jsonPatch), `${jsonPatch.length} ops`),
          code('Merge Patch (RFC 7396)', formatJson(mergePatch)),
        ];
      }
      default: {
        const patch = parseJson(inputs.patch, 'patch');
        if (patch.node) return [patch.node];
        const apply = compileJSONPatch(patch.value, { changes: true });
        const run = timed(() => apply(doc));
        return [
          cards([
            { title: 'Applied', value: formatMsUnscaled(run.ms), note: 'copy-on-write, atomic' },
            { title: 'Changed paths', value: String(run.value.changes.length), note: 'the change feed' },
          ]),
          code('Result', formatJson(run.value.doc)),
          code('Changes', formatJson(run.value.changes), 'invalidation-sound pointers'),
        ];
      }
    }
  }
  catch (err) {
    return [error(err, 'Patch error')];
  }
}

function runQuery(inputs) {
  const query = parseJson(inputs.query, 'query');
  if (query.node) return [query.node];
  const data = parseJson(inputs.data, 'data');
  if (data.node) return [data.node];
  let externals = {};
  if (inputs.externals !== '') {
    const parsed = parseJson(inputs.externals, 'externals');
    if (parsed.node) return [parsed.node];
    externals = parsed.value;
  }
  try {
    const compiled = timed(() => compileJsonQuery(query.value, { compileTypeTest }));
    const fn = compiled.value;
    const unbound = fn.externals.filter((name) => !(name in externals));
    if (unbound.length > 0) {
      return [callout('Unbound externals',
        `This query needs externals not provided: ${unbound.join(', ')}. Add them to the externals input as JSON.`)];
    }
    const run = timed(() => fn(data.value, externals));
    const value = run.value;
    const count = value === undefined ? 0 : Array.isArray(value) ? value.length : 1;
    return [
      cards([
        { title: 'Items', value: String(count) },
        { title: 'Compile', value: formatMsUnscaled(compiled.ms) },
        { title: 'Run', value: formatMsUnscaled(run.ms) },
      ]),
      code('Result', value === undefined ? '(empty sequence)' : formatJson(value)),
    ];
  }
  catch (err) {
    return [error(err, 'Query error')];
  }
}

function runJslt(inputs) {
  const stylesheet = parseJson(inputs.stylesheet, 'stylesheet');
  if (stylesheet.node) return [stylesheet.node];
  const data = parseJson(inputs.data, 'data');
  if (data.node) return [data.node];
  try {
    const compiled = timed(() => compileJsltStylesheet(stylesheet.value, { compileTypeTest }));
    const run = timed(() => compiled.value(data.value));
    return [
      cards([
        { title: 'Compile', value: formatMsUnscaled(compiled.ms) },
        { title: 'Transform', value: formatMsUnscaled(run.ms), note: run.value === data.value ? '=== input (shared)' : null },
      ]),
      code('Output', formatJson(run.value), run.value === data.value ? 'proof of no change' : null),
    ];
  }
  catch (err) {
    return [error(err, 'JSLT error')];
  }
}

function runJtlt(inputs) {
  const template = parseJson(inputs.template, 'template');
  if (template.node) return [template.node];
  const data = parseJson(inputs.data, 'data');
  if (data.node) return [data.node];
  try {
    const render = compileJtltStylesheet(template.value, { compileTypeTest });
    const run = timed(() => render(data.value));
    const nodes = [
      code('Output', run.value === '' ? '(empty)' : run.value, `output "${render.output}" · ${formatMsUnscaled(run.ms)}`),
    ];
    // make the xml method's escaping contract VISIBLE: re-render the
    // same template as "text" and show what changed — or say honestly
    // that this document's data gave the escaper nothing to do
    if (render.output === 'xml') {
      try {
        const asText = compileJtltStylesheet(
          { ...template.value, output: 'text' }, { compileTypeTest })(data.value);
        nodes.push(asText === run.value
          ? callout('XML escaping', 'The interpolated data contains none of & < > " \' — the xml and text methods render this document identically. Escaping applies to data, never to your literal markup.')
          : details('What the xml method escaped (same template as output "text")', [code(null, asText)]));
      }
      catch {
        // the comparison is best-effort illustration, never a failure
      }
    }
    nodes.push(details('The compiled JSLT stylesheet', [code(null, formatJson(render.stylesheet))]));
    return nodes;
  }
  catch (err) {
    return [error(err, 'JTLT error')];
  }
}

function runXQuery(inputs) {
  const data = parseJson(inputs.data, 'data');
  if (data.node) return [data.node];
  try {
    const doc = parseXQuery(inputs.text);
    const fn = compileJsonQuery(doc);
    const externals = {};
    for (const name of fn.externals) {
      if (name === 'doc') externals.doc = data.value;
    }
    const unbound = fn.externals.filter((name) => name !== 'doc');
    const run = timed(() => fn(data.value, externals));
    const value = run.value;
    const out = [
      code('Result', value === undefined ? '(empty sequence)' : formatJson(value), formatMsUnscaled(run.ms)),
      details('The generated query document', [code(null, formatJson(doc))]),
    ];
    if (unbound.length > 0) {
      out.unshift(callout('Unbound externals', `Free variables besides $doc: ${unbound.join(', ')}.`));
    }
    return out;
  }
  catch (err) {
    return [error(err, 'XQuery error')];
  }
}

// A cell is shown as-is when it is text; only the typed values (numbers,
// bigints, booleans, dates) are rendered through the JSONX writer, so a
// plain CSV table does not come back wrapped in quotes.
function csvCell(value) {
  if (value === undefined) return '—';
  return typeof value === 'string' ? value : stringifyJsonx(value);
}

function runCsv(inputs) {
  const options = {
    repair: inputs.repair === 'repair',
    headers: inputs.headers === 'auto' ? 'auto' : inputs.headers !== 'false',
    typed: inputs.typed === 'on',
    delimiter: !inputs.delimiter || inputs.delimiter === 'auto'
      ? 'auto'
      : (inputs.delimiter === 'tab' ? '\t' : inputs.delimiter),
  };
  const shown = (d) => (d === '\t' ? 'tab' : d);
  try {
    const doc = parseCsvDocument(inputs.text, options);
    const sniff = sniffCsvDialect(inputs.text);
    const fields = doc.fields;
    const rows = doc.rows;
    const out = [];

    out.push(table('Dialect', ['Property', 'Value'], [
      { cells: ['delimiter', shown(doc.dialect.delimiter)] },
      { cells: ['header row', String(doc.dialect.headers)] },
      { cells: ['sniffed', `${shown(sniff.delimiter)} · ${sniff.width} columns · confidence ${sniff.confidence.toFixed(2)} · header ${sniff.headers}`] },
      { cells: ['records', String(rows.length)] },
    ], 'The sniffer scores each candidate delimiter by how consistently it divides records, and calls a header only when the first row looks unlike the rest.'));

    const columns = fields ?? Array.from(
      { length: rows.reduce((n, r) => Math.max(n, r.length), 0) },
      (unusedValue, i) => `#${i + 1}`);
    out.push(table(`Records (${rows.length})`, columns,
      rows.slice(0, 50).map((row) => ({
        cells: columns.map((name, i) => csvCell(fields === null ? row[i] : row[name])),
      })),
      fields === null
        ? 'Headers off: records are arrays, which allocate less than objects.'
        : 'An em dash marks a column this record did not carry — absent, not empty.'));

    if (doc.repairs.length !== 0) {
      out.push(table(`Repairs (${doc.repairs.length})`, ['Code', 'Line', 'Col', 'What was read'],
        doc.repairs.map((r) => ({ cells: [r.code, String(r.line), String(r.column), r.message] })),
        'Strict mode throws on the first of these, carrying the same code.'));
    }
    else if (options.repair) {
      out.push(callout('Nothing to repair',
        'The document is already RFC 4180 — repair mode changed nothing about it.'));
    }

    out.push(details('Round trip (stringifyCsv)', [
      code(null, stringifyCsv(rows, { fields: fields ?? undefined, newline: '\n' })),
    ]));
    return out;
  }
  catch (e) {
    return [
      error(e, 'CSV'),
      callout('Switch to repair mode',
        'Strict mode rejects anything RFC 4180 forbids. Repair mode reads the document '
        + 'anyway and reports every fix it had to make, with a code, a line and a column.'),
    ];
  }
}

function runJosl(inputs) {
  try {
    const events = [];
    const parsed = parseJosl(inputs.text, {
      mode: inputs.mode,
      onEvent: (e) => { if (events.length < 200) events.push(e); },
    });
    return [
      code('Parsed value (JSONX)', stringifyJsonx(parsed, { indent: 2 }),
        inputs.mode === 'toml' ? 'strict TOML mode' : 'JOSL mode'),
      table(`Document-order events (${events.length}${events.length === 200 ? ', capped' : ''})`,
        ['Type', 'Path', 'Value'],
        events.map((e) => ({
          cells: [
            e.type,
            `/${(e.path ?? []).join('/')}`,
            e.type === 'pair' ? stringifyJsonx(e.value) : '',
          ],
        }))),
      details('Round trip (stringifyJosl)', [code(null, stringifyJosl(parsed, { mode: inputs.mode }))]),
    ];
  }
  catch (err) {
    return [error(err, 'JOSL error')];
  }
}

function runMarkdown(inputs) {
  try {
    const source = inputs.source ?? '';
    const compiledRun = timed(() => MD.compile(source));
    const compiled = compiledRun.value;
    const doc = compiled.doc;
    let blockCount = 0;
    let nodeCount = 0;
    compiled.walk(() => { nodeCount++; });
    blockCount = doc.ast.length;
    return [
      cards([
        { title: 'Blocks', value: String(blockCount) },
        { title: 'AST nodes', value: String(nodeCount) },
        { title: 'Compile', value: formatMsUnscaled(compiledRun.ms), note: 'memoized by source' },
        { title: 'Frontmatter', value: doc.frontmatter === null ? 'none' : (doc.meta.frontmatterLang ?? 'yes') },
      ]),
      markdown('Rendered through @jarenjs/view', MD.view(source)),
      details('AST (the JSON document)', [code(null, formatJson(doc.ast))]),
      details('Canonical Markdown (toMarkdown)', [code(null, toMarkdown(doc))]),
      ...(doc.frontmatter !== null
        ? [details('Frontmatter (plain JSON)', [code(null, formatJson(doc.frontmatter))])]
        : []),
    ];
  }
  catch (err) {
    return [error(/** @type {any} */ (err), 'Markdown error')];
  }
}

function runMermaid(inputs) {
  try {
    const source = inputs.source ?? '';
    const compiledRun = timed(() => MERMAID.compile(source));
    const compiled = compiledRun.value;
    const doc = compiled.doc;
    const out = [
      cards([
        { title: 'Diagram', value: doc ? doc.diagram : 'error' },
        { title: 'Compile', value: formatMsUnscaled(compiledRun.ms), note: 'memoized by source' },
        { title: 'Hash', value: doc ? doc.meta.hash : '—' },
      ]),
      // The rendered SVG is a ready-made vnode; reuse the markdown
      // preview kind that splices a vnode in verbatim.
      markdown('Rendered to pure-vnode SVG (headless, SSR-able)', MERMAID.view(source)),
      details('AST (geometry-free JSON document)', [code(null, formatJson(doc ? doc.ast : String(compiled.parseError?.message ?? 'parse error')))]),
      details('Canonical Mermaid (toMermaid round-trip)', [code(null, compiled.toText())]),
    ];
    if (doc && doc.diagram === 'state') {
      const workflow = transformJson(stateToWorkflow, doc);
      out.push(details('Derived workflow / FSM (JSLT projection → @jarenjs/app)', [code(null, formatJson(workflow))]));
    }
    return out;
  }
  catch (err) {
    return [error(/** @type {any} */ (err), 'Mermaid error')];
  }
}

//#endregion

//#region descriptors & examples

const DATA_FIELD = { key: 'data', title: 'Document', control: 'json', rows: 10 };

/**
 * The engine table. `inputs` describe the fields (control: 'json' |
 * 'text' | 'select'); `when` limits a field to specific values of a
 * sibling select. `run(inputs) -> nodes`.
 */
export const ENGINE_DEFS = {
  path: {
    label: 'JSONPath',
    lead: 'RFC 9535 selectors, compiled. All 703 compliance tests pass.',
    inputs: [
      { key: 'selector', title: 'Selector', control: 'text' },
      DATA_FIELD,
    ],
    run: runPath,
  },
  pointer: {
    label: 'JSON Pointer',
    lead: 'RFC 6901 absolute and relative pointers with zero-allocation compiled getters.',
    inputs: [
      { key: 'mode', title: 'Mode', control: 'select', options: ['absolute', 'relative'] },
      { key: 'pointer', title: 'Pointer', control: 'text' },
      { key: 'location', title: 'Current location', control: 'text', when: { key: 'mode', value: 'relative' } },
      DATA_FIELD,
    ],
    run: runPointer,
  },
  patch: {
    label: 'JSON Patch',
    lead: 'RFC 6902 and RFC 7396, copy-on-write and atomic — plus compiled write operations and structural diff.',
    inputs: [
      { key: 'mode', title: 'Mode', control: 'select', options: ['patch', 'merge', 'write', 'diff'] },
      DATA_FIELD,
      { key: 'patch', title: 'Patch', control: 'json', rows: 8, when: { key: 'mode', value: ['patch', 'merge'] } },
      { key: 'target', title: 'Target document', control: 'json', rows: 8, when: { key: 'mode', value: 'diff' } },
      { key: 'writeOp', title: 'Write op', control: 'select', options: ['set', 'insert', 'remove'], when: { key: 'mode', value: 'write' } },
      { key: 'writeTarget', title: 'Target (pointer or path)', control: 'text', when: { key: 'mode', value: 'write' } },
      { key: 'writeValue', title: 'Value', control: 'json', rows: 4, when: { key: 'mode', value: 'write' } },
    ],
    run: runPatch,
  },
  query: {
    label: 'JSON Query',
    lead: 'XQuery 3.1 semantics — FLWOR, joins, grouping — as JSON documents with JSONPath leaves.',
    inputs: [
      { key: 'query', title: 'Query document', control: 'json', rows: 12 },
      DATA_FIELD,
      { key: 'externals', title: 'Externals (optional)', control: 'json', rows: 3 },
    ],
    run: runQuery,
  },
  jslt: {
    label: 'JSLT',
    lead: 'Template rules: JSONPath matches position, JSON Schema matches shape, query documents produce output.',
    inputs: [
      { key: 'stylesheet', title: 'Stylesheet', control: 'json', rows: 12 },
      DATA_FIELD,
    ],
    run: runJslt,
  },
  jtlt: {
    label: 'JTLT',
    lead: 'The text front-end to JSLT: render JSON as Markdown, XML or source code — SQLite and PostgreSQL DDL included.',
    inputs: [
      { key: 'template', title: 'Template', control: 'json', rows: 12 },
      DATA_FIELD,
    ],
    run: runJtlt,
  },
  xquery: {
    label: 'XQuery',
    lead: 'The XQuery 3.1 text subset, parsed into a query document and executed.',
    inputs: [
      { key: 'text', title: 'XQuery text', control: 'code', rows: 8 },
      DATA_FIELD,
    ],
    run: runXQuery,
  },
  markdown: {
    label: 'Markdown',
    lead: 'The inverse of JTLT: Markdown + frontmatter parsed into a JSON AST and rendered live through @jarenjs/view, syntax highlighting included.',
    inputs: [
      { key: 'source', title: 'Markdown source', control: 'code', rows: 16 },
    ],
    run: runMarkdown,
  },
  mermaid: {
    label: 'Mermaid',
    lead: 'Diagrams-as-code: a native, headless Mermaid clone parsed to a geometry-free JSON AST and rendered as pure-vnode SVG through @jarenjs/view — SSR-able with no browser, bidirectional (parseMermaid ⇄ toMermaid). A state diagram also projects to an @jarenjs/app workflow via JSLT.',
    inputs: [
      { key: 'source', title: 'Mermaid source', control: 'code', rows: 16 },
    ],
    run: runMermaid,
  },
  josl: {
    label: 'JOSL',
    lead: 'The streaming TOML superset: JavaScript-obvious values, document-order events, round trips.',
    inputs: [
      { key: 'mode', title: 'Mode', control: 'select', options: ['josl', 'toml'] },
      { key: 'text', title: 'Document', control: 'code', rows: 14 },
    ],
    run: runJosl,
  },
  csv: {
    label: 'CSV',
    lead: 'RFC 4180 strict by default; repair mode reads damaged CSV anyway and reports every fix with a code, a line and a column. The delimiter and the header row can be sniffed from the text.',
    inputs: [
      { key: 'repair', title: 'Mode', control: 'select', options: ['strict', 'repair'] },
      { key: 'headers', title: 'Header row', control: 'select', options: ['true', 'false', 'auto'] },
      { key: 'delimiter', title: 'Delimiter', control: 'select', options: ['auto', ',', ';', 'tab', '|'] },
      { key: 'typed', title: 'Typed values', control: 'select', options: ['off', 'on'] },
      { key: 'text', title: 'CSV', control: 'code', rows: 12 },
    ],
    run: runCsv,
  },
  charts: {
    label: 'Charts',
    lead: 'Headless SVG charts from a JSON / JSONX / JOSL definition: validated by JSON Schema, parsed through the incremental streaming readers, rendered as pure vnodes — flip stream to replay and watch the chart build as chunks arrive.',
    inputs: [
      { key: 'format', title: 'Format', control: 'select', options: ['json', 'jsonx', 'josl'] },
      { key: 'stream', title: 'Stream', control: 'select', options: ['off', 'replay', 'live'] },
      { key: 'source', title: 'Chart definition', control: 'code', rows: 16, when: { key: 'stream', value: ['off', 'replay'] } },
    ],
    run: runCharts,
    // wireBoundaries calls `sync` after each run and on route changes;
    // the hooks own the side channels (replay timer, Binance socket)
    // outside the pure runner and stop them when the engine is left
    sync: (inputs, dispatch, active) => {
      chartsSync(inputs, dispatch, active);
      binanceSync(inputs, dispatch, active);
    },
  },
};

/** Run one engine's boundary; never throws. */
export function runEngine(engine, inputs) {
  const def = ENGINE_DEFS[engine];
  if (def === undefined) return [callout('Unknown engine', `No engine '${engine}' is registered.`)];
  try {
    return def.run(inputs);
  }
  catch (err) {
    return [error(/** @type {any} */ (err), 'Engine error')];
  }
}

/** Per-engine example chips, converted to the text-input shape. */
export const ENGINE_EXAMPLES = {
  path: pathExamples.map((e) => ({
    label: e.name,
    inputs: { selector: e.selector, data: formatJson(e.document) },
  })),
  pointer: pointerExamples.map((e) => ({
    label: e.name,
    inputs: { mode: e.mode, pointer: e.pointer, location: e.location ?? '/store/book/0/title', data: formatJson(e.document) },
  })),
  patch: patchExamples.map((e) => ({
    label: e.name,
    inputs: {
      mode: e.mode,
      data: formatJson(e.document),
      patch: e.patch !== undefined ? formatJson(e.patch) : '',
      target: e.mode === 'diff' && e.target !== undefined ? formatJson(e.target) : '',
      writeOp: e.writeOp ?? 'set',
      writeTarget: e.mode === 'write' && typeof e.target === 'string' ? e.target : '',
      writeValue: e.value !== undefined ? formatJson(e.value) : '',
    },
  })),
  query: queryExamples.map((e) => ({
    label: e.name,
    inputs: { query: formatJson(e.query), data: formatJson(e.document), externals: e.externals !== undefined ? formatJson(e.externals) : '' },
  })),
  jslt: jsltExamples.map((e) => ({
    label: e.name,
    inputs: { stylesheet: formatJson(e.stylesheet), data: formatJson(e.document) },
  })),
  jtlt: jtltExamples.map((e) => ({
    label: e.name,
    inputs: { template: formatJson(e.template), data: formatJson(e.document) },
  })),
  xquery: xqueryExamples.map((e) => ({
    label: e.name,
    inputs: { text: e.text, data: formatJson(e.document) },
  })),
  josl: joslExamples.map((e) => ({
    label: e.name,
    inputs: { text: e.text, mode: e.mode ?? 'josl' },
  })),
  csv: csvExamples.map((e) => ({
    label: e.name,
    inputs: {
      text: e.text, repair: e.repair, headers: e.headers,
      delimiter: e.delimiter, typed: e.typed,
    },
  })),
  markdown: markdownExamples.map((e) => ({
    label: e.name,
    inputs: { source: e.source },
  })),
  mermaid: mermaidExamples.map((e) => ({
    label: e.name,
    inputs: { source: e.source },
  })),
  charts: chartsExamples.map((e) => ({
    label: e.name,
    inputs: { format: e.format, stream: e.stream, source: e.source },
  })),
};

/** The initial inputs for every engine: its first example. */
export function initialEngineInputs() {
  /** @type {Record<string, any>} */
  const out = {};
  for (const engine of Object.keys(ENGINE_DEFS)) {
    const example = ENGINE_EXAMPLES[engine]?.[0];
    const inputs = { ...(example?.inputs ?? {}) };
    for (const field of ENGINE_DEFS[engine].inputs) {
      if (inputs[field.key] === undefined) inputs[field.key] = '';
    }
    out[engine] = inputs;
  }
  return out;
}

//#endregion
