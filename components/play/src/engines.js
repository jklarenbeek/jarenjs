//@ts-check
/**
 * @file The playground's engine descriptors — each wraps a real shipped
 * `@jarenjs` compiler into a pure `run(source, data, options) → PlayResult`.
 * `sourcePanes` are the engine input(s); `dataPanes` are the JSON it runs
 * against (empty for source-only engines, which land in a later order).
 * Registered operators reach the `query`/`jslt` engines through
 * `options.operators` (a `.toOptions()` registry) — the host opt-in.
 */

import {
  compileJSONPath, compileJSONPointer, JSONPOINTER_NOTHING,
  compileJSONPatch, compileJsonQuery,
} from '@jarenjs/json';
import { compileJsltStylesheet } from '@jarenjs/json/jslt';
import { compileJtltStylesheet } from '@jarenjs/json/jtlt';
import { parseXQuery } from '@jarenjs/json/xquery';
import { parseJosl, stringifyJsonx } from '@jarenjs/josl';
import { parseCsvDocument, stringifyCsv } from '@jarenjs/josl/csv';
import { createTypeTestCompiler } from '@jarenjs/validate/query';

const compileTypeTest = createTypeTestCompiler();

const now = () => performance.now();
const fmt = (v) => (v === undefined ? '(no result)' : JSON.stringify(v, null, 2));
const fmtMs = (ms) => (typeof ms !== 'number' ? '—' : ms < 0.01 ? '<0.01 ms' : `${ms.toFixed(2)} ms`);
const msg = (err) => String(/** @type {any} */ (err)?.message ?? err);
const code = (err) => /** @type {any} */ (err)?.code;

/** Parse a pane's JSON text; `{ value }` or `{ error }`. */
function parseJson(text, label) {
  try { return { value: JSON.parse((text ?? 'null') === '' ? 'null' : text) }; }
  catch (err) { return { error: `${label}: ${msg(err)}` }; }
}

/** A single-`code`-panel Result — the shape most engines return. */
/** @returns {import('./index.js').PlayResult} */
const ok = (text, compileMs, runMs) => okPanels([{ id: 'out', label: 'Output', kind: 'code', text }], compileMs, runMs);

/** A multi-panel Result — the engine hands over its own screen list. */
/** @returns {import('./index.js').PlayResult} */
const okPanels = (panels, compileMs, runMs) => ({ ok: true, timing: { compileMs, runMs }, error: null, panels });

/** A table cell → a display string. Primitives (incl. BigInt, from typed CSV)
 * stringify directly; objects/arrays become compact JSON. Never throws. */
const cell = (v) => {
  if (v == null) return '';
  if (typeof v === 'object') { try { return JSON.stringify(v); } catch { return String(v); } }
  return String(v);
};

/**
 * A VISUAL engine (markdown/mermaid/charts): the descriptor + examples live
 * here (canonical), but the vnode rendering is delegated to a host-injected
 * `options.renderers[id]` — the hybrid seam that keeps this package free of the
 * @jarenjs/md, /mermaid and /charts dependencies. No renderer → an honest
 * Result, never a throw.
 * @returns {import('./index.js').EngineDescriptor}
 */
function visual(id, label, lead, opts = {}) {
  return {
    id, label, lead,
    sourcePanes: [{ key: 'source', label: opts.sourceLabel ?? 'Source', control: 'code' }],
    dataPanes: [],
    ...(opts.optionPanes ? { optionPanes: opts.optionPanes } : {}),
    run(source, data, options) {
      const render = options?.renderers?.[id];
      if (typeof render !== 'function') {
        return fail(`the ${label} engine renders in the host — inject options.renderers.${id}`, 'PLAY_NO_RENDERER');
      }
      const t0 = now();
      let view;
      try { view = render(source.source ?? '', options?.config); }
      catch (err) { return fail(msg(err), code(err)); }
      const t1 = now();
      return okPanels([{ id: 'preview', label: 'Preview', kind: 'view', vnode: view }], t1 - t0, 0);
    },
  };
}
/** @returns {import('./index.js').PlayResult} */
const fail = (message, c, path) => ({ ok: false, timing: null, error: { message, code: c, path }, panels: [] });

/** The compile options the query/jslt engines run with (registry-aware). */
function compileOptions(options) {
  const registry = options?.operators;
  const extra = registry && typeof registry.toOptions === 'function' ? registry.toOptions() : {};
  return { compileTypeTest, ...extra };
}

/** @type {import('./index.js').EngineDescriptor[]} */
export const ENGINE_LIST = [
  {
    id: 'path', label: 'JSONPath', lead: 'RFC 9535 — select nodes from a document.',
    sourcePanes: [{ key: 'selector', label: 'Selector', control: 'text' }],
    dataPanes: [{ key: 'data', label: 'Data' }],
    run(source, data) {
      const d = parseJson(data.data, 'data'); if (d.error) return fail(d.error);
      let compiled; const t0 = now();
      try { compiled = compileJSONPath(source.selector ?? ''); }
      catch (err) { return fail(msg(err), code(err)); }
      const t1 = now();
      let nodes;
      try { nodes = compiled.nodes(d.value); }
      catch (err) { return fail(msg(err), code(err)); }
      const t2 = now();
      return ok(fmt(nodes.map((n) => n.value)), t1 - t0, t2 - t1);
    },
  },
  {
    id: 'pointer', label: 'JSON Pointer', lead: 'RFC 6901 — address exactly one value.',
    sourcePanes: [{ key: 'pointer', label: 'Pointer', control: 'text' }],
    dataPanes: [{ key: 'data', label: 'Data' }],
    run(source, data) {
      const d = parseJson(data.data, 'data'); if (d.error) return fail(d.error);
      let getter; const t0 = now();
      try { getter = compileJSONPointer(source.pointer ?? ''); }
      catch (err) { return fail(msg(err), code(err)); }
      const t1 = now();
      const value = getter(d.value); const t2 = now();
      if (value === JSONPOINTER_NOTHING) return ok('(nothing — the pointer addresses no value)', t1 - t0, t2 - t1);
      return ok(fmt(value), t1 - t0, t2 - t1);
    },
  },
  {
    id: 'patch', label: 'JSON Patch', lead: 'RFC 6902 — apply a patch to a target, copy-on-write.',
    sourcePanes: [{ key: 'patch', label: 'Patch', control: 'code' }],
    dataPanes: [{ key: 'data', label: 'Target document' }],
    run(source, data) {
      const target = parseJson(data.data, 'target'); if (target.error) return fail(target.error);
      const patch = parseJson(source.patch, 'patch'); if (patch.error) return fail(patch.error);
      let apply; const t0 = now();
      try { apply = compileJSONPatch(patch.value, { changes: true }); }
      catch (err) { return fail(msg(err), code(err)); }
      const t1 = now();
      let run;
      try { run = apply(target.value); }
      catch (err) { return fail(msg(err), code(err)); }
      const t2 = now();
      return ok(fmt(run.doc), t1 - t0, t2 - t1);
    },
  },
  {
    id: 'query', label: '$query', lead: 'Jaren JSON Query — filter, project and fold (registered operators included).',
    sourcePanes: [{ key: 'query', label: 'Query', control: 'code' }, { key: 'externals', label: 'Externals', control: 'code' }],
    dataPanes: [{ key: 'data', label: 'Data' }],
    run(source, data, options) {
      const d = parseJson(data.data, 'data'); if (d.error) return fail(d.error);
      const q = parseJson(source.query, 'query'); if (q.error) return fail(q.error);
      let externals = {};
      if (source.externals !== undefined && String(source.externals).trim() !== '') {
        const e = parseJson(source.externals, 'externals'); if (e.error) return fail(e.error); externals = e.value;
      }
      let fn; const t0 = now();
      try { fn = compileJsonQuery(q.value, compileOptions(options)); }
      catch (err) { return fail(msg(err), code(err)); }
      const t1 = now();
      let out;
      try { out = fn(d.value, externals); }
      catch (err) { return fail(msg(err), code(err)); }
      const t2 = now();
      return ok(fmt(out), t1 - t0, t2 - t1);
    },
  },
  {
    id: 'jslt', label: 'JSLT', lead: 'JSON stylesheet transform (registered operators included).',
    sourcePanes: [{ key: 'stylesheet', label: 'Stylesheet', control: 'code' }],
    dataPanes: [{ key: 'data', label: 'Data' }],
    run(source, data, options) {
      const d = parseJson(data.data, 'data'); if (d.error) return fail(d.error);
      const s = parseJson(source.stylesheet, 'stylesheet'); if (s.error) return fail(s.error);
      let compiled; const t0 = now();
      try { compiled = compileJsltStylesheet(s.value, compileOptions(options)); }
      catch (err) { return fail(msg(err), code(err)); }
      const t1 = now();
      let out;
      try { out = compiled(d.value); }
      catch (err) { return fail(msg(err), code(err)); }
      const t2 = now();
      return ok(fmt(out), t1 - t0, t2 - t1);
    },
  },
  {
    id: 'jtlt', label: 'JTLT', lead: 'JSLT\'s text front-end — render JSON as Markdown, XML or code.',
    sourcePanes: [{ key: 'template', label: 'Template', control: 'code' }],
    dataPanes: [{ key: 'data', label: 'Data' }],
    run(source, data, options) {
      const d = parseJson(data.data, 'data'); if (d.error) return fail(d.error);
      const t = parseJson(source.template, 'template'); if (t.error) return fail(t.error);
      let render; const t0 = now();
      try { render = compileJtltStylesheet(t.value, compileOptions(options)); }
      catch (err) { return fail(msg(err), code(err)); }
      const t1 = now();
      let out;
      try { out = render(d.value); }
      catch (err) { return fail(msg(err), code(err)); }
      const t2 = now();
      // JTLT emits TEXT (markdown / xml / source) — show it verbatim, not fmt'd
      return ok(out === '' ? '(empty)' : out, t1 - t0, t2 - t1);
    },
  },
  {
    id: 'xquery', label: 'XQuery', lead: 'The XQuery 3.1 text subset — parsed to a query document and run over $doc.',
    sourcePanes: [{ key: 'text', label: 'XQuery', control: 'code' }],
    dataPanes: [{ key: 'data', label: 'Data' }],
    run(source, data, options) {
      const d = parseJson(data.data, 'data'); if (d.error) return fail(d.error);
      let fn; const t0 = now();
      try { fn = compileJsonQuery(parseXQuery(source.text ?? ''), compileOptions(options)); }
      catch (err) { return fail(msg(err), code(err)); }
      const t1 = now();
      let out;
      try {
        const externals = fn.externals.includes('doc') ? { doc: d.value } : {};
        out = fn(d.value, externals);
      }
      catch (err) { return fail(msg(err), code(err)); }
      const t2 = now();
      return ok(out === undefined ? '(empty sequence)' : fmt(out), t1 - t0, t2 - t1);
    },
  },
  {
    id: 'josl', label: 'JOSL', lead: 'The streaming TOML superset — JavaScript-obvious values, round-trips.',
    sourcePanes: [{ key: 'text', label: 'Document', control: 'code' }],
    dataPanes: [],
    optionPanes: [{
      key: 'mode', label: 'Dialect', default: 'josl',
      choices: [{ value: 'josl', label: 'JOSL' }, { value: 'toml', label: 'TOML (strict 1.0)' }],
    }],
    run(source, data, options) {
      const mode = options?.config?.mode ?? 'josl';
      let parsed; const t0 = now();
      // parse (compile) and serialize (run) are the two visible phases
      try { parsed = parseJosl(source.text ?? '', { mode }); }
      catch (err) { return fail(msg(err), code(err)); }
      const t1 = now();
      const out = stringifyJsonx(parsed, { indent: 2 });
      const t2 = now();
      return ok(out, t1 - t0, t2 - t1);
    },
  },
  {
    id: 'csv', label: 'CSV', lead: 'RFC 4180 strict, or repair mode that reads damaged CSV and reports every fix.',
    sourcePanes: [{ key: 'text', label: 'CSV', control: 'code' }],
    dataPanes: [],
    optionPanes: [
      { key: 'repair', label: 'Mode', default: 'strict', choices: [{ value: 'strict', label: 'strict' }, { value: 'repair', label: 'repair' }] },
      { key: 'headers', label: 'Header row', default: 'true', choices: [{ value: 'true', label: 'yes' }, { value: 'false', label: 'no' }, { value: 'auto', label: 'auto' }] },
      { key: 'delimiter', label: 'Delimiter', default: 'auto', choices: [{ value: 'auto', label: 'auto' }, { value: ',', label: ',' }, { value: ';', label: ';' }, { value: 'tab', label: 'tab' }, { value: '|', label: '|' }] },
      { key: 'typed', label: 'Typed values', default: 'off', choices: [{ value: 'off', label: 'off' }, { value: 'on', label: 'on' }] },
    ],
    run(source, data, options) {
      const cfg = options?.config ?? {};
      const opts = {
        repair: cfg.repair === 'repair',
        headers: cfg.headers === 'auto' ? 'auto' : cfg.headers !== 'false',
        typed: cfg.typed === 'on',
        delimiter: !cfg.delimiter || cfg.delimiter === 'auto' ? 'auto' : (cfg.delimiter === 'tab' ? '\t' : cfg.delimiter),
      };
      let doc; const t0 = now();
      // strict mode THROWS on the first RFC 4180 violation (with a code);
      // repair mode reads anyway and lists every fix — the lesson of the tab
      try { doc = parseCsvDocument(source.text ?? '', opts); }
      catch (err) { return fail(msg(err), code(err)); }
      const t1 = now();
      // three SCREENS (the multi-panel proof): a summary note, the parsed
      // records as a table, and the CSV round-trip. The table + round-trip
      // are naturally "deep" (PLAY_06 gates them behind the drill toggle).
      const fields = doc.fields; // string[] (headers) | null (positional)
      const total = doc.rows.length;
      const shown = doc.rows.slice(0, 50);
      const width = shown.reduce((w, r) => Math.max(w, Array.isArray(r) ? r.length : fields ? fields.length : 0), 0);
      const columns = fields ?? Array.from({ length: width }, (_, i) => String(i + 1));
      const rows = shown.map((r) => columns.map((c, i) => cell(fields ? r[c] : r[i])));
      const delim = doc.dialect.delimiter === '\t' ? 'tab' : doc.dialect.delimiter;
      const plural = (n) => (n === 1 ? '' : 's');
      const summary = [
        `${delim}-delimited · ${doc.dialect.headers === false ? 'no header row' : 'header row'} · ${total} record${plural(total)}`
          + (doc.repairs.length ? ` · ${doc.repairs.length} repair${plural(doc.repairs.length)}` : ' · clean')
          + (total > shown.length ? ` · showing the first ${shown.length}` : ''),
        ...doc.repairs.map((r) => `line ${r.line}: ${r.code} — ${r.message}`),
      ].join('\n');
      const roundtrip = stringifyCsv(doc.rows, { fields: fields ?? undefined, header: doc.dialect.headers !== false });
      const t2 = now();
      return okPanels([
        { id: 'summary', label: 'Summary', kind: 'note', tone: doc.repairs.length ? 'warn' : 'ok', text: summary },
        { id: 'rows', label: `Rows (${total})`, kind: 'table', depth: 'deep', columns, rows },
        { id: 'roundtrip', label: 'CSV round-trip', kind: 'code', depth: 'deep', text: roundtrip },
      ], t1 - t0, t2 - t1);
    },
  },
  {
    id: 'validate', label: 'JSON Schema', lead: 'Compile a schema and validate data — every error, localized.',
    sourcePanes: [{ key: 'schema', label: 'Schema', control: 'code' }],
    dataPanes: [{ key: 'data', label: 'Data' }],
    optionPanes: [{
      key: 'locale', label: 'Messages', default: 'en',
      // the @jarenjs/locales packs the host mounts; an unmounted code falls
      // back to English in the host localizer, so the list is safe to declare
      choices: [
        { value: 'en', label: 'English' }, { value: 'nl', label: 'Nederlands' },
        { value: 'fr', label: 'Français' }, { value: 'es', label: 'Español' },
        { value: 'de', label: 'Deutsch' }, { value: 'pt', label: 'Português' },
        { value: 'ja', label: '日本語' }, { value: 'ko', label: '한국어' },
        { value: 'zh-tw', label: '繁體中文' }, { value: 'ru', label: 'Русский' },
        { value: 'tr', label: 'Türkçe' }, { value: 'ar', label: 'العربية' },
      ],
    }],
    run(source, data, options) {
      // the validator + locale packs are heavy and already cached in the
      // host — inject a `validate(schemaText, data, locale)` runner (the
      // hybrid seam, like the visual engines' renderers). No runner → an
      // honest Result, never a throw.
      const validate = options?.validate;
      if (typeof validate !== 'function') {
        return fail('the JSON Schema engine validates in the host — inject options.validate', 'PLAY_NO_VALIDATOR');
      }
      const d = parseJson(data.data, 'data'); if (d.error) return fail(d.error);
      const locale = options?.config?.locale ?? 'en';
      let report;
      try { report = validate(source.schema ?? '', d.value, locale); }
      catch (err) { return fail(msg(err), code(err)); }
      if (report.schemaError) return fail(report.schemaError, 'SCHEMA');
      const errs = report.errors ?? [];
      const summary = (report.valid ? '✓ valid' : `✗ ${errs.length} error${errs.length === 1 ? '' : 's'}`)
        + ` · ${report.draft} · compiled ${fmtMs(report.compileMs)} · validated ${fmtMs(report.validateMs)}`;
      const panels = [{ id: 'verdict', label: 'Verdict', kind: 'note', tone: report.valid ? 'ok' : 'warn', text: summary }];
      if (errs.length) {
        panels.push({
          id: 'errors', label: `Errors (${errs.length})`, kind: 'table', depth: 'deep',
          columns: ['path', 'message'],
          rows: errs.map((e) => [e.instancePath === '' ? '(root)' : e.instancePath, e.message]),
        });
      }
      return okPanels(panels, report.compileMs ?? 0, report.validateMs ?? 0);
    },
  },
  // ——— the visual engines: descriptor + examples here, rendering delegated ———
  visual('markdown', 'Markdown', 'CommonMark + GFM + frontmatter → a JSON AST, rendered live.', { sourceLabel: 'Markdown' }),
  visual('mermaid', 'Mermaid', 'Diagrams-as-code → a geometry-free AST → pure-vnode SVG.', { sourceLabel: 'Mermaid' }),
  visual('charts', 'Charts', 'A JSON / JSONX / JOSL chart definition → schema-validated → pure-vnode SVG.', {
    sourceLabel: 'Chart definition',
    optionPanes: [{
      key: 'format', label: 'Format', default: 'json',
      choices: [{ value: 'json', label: 'JSON' }, { value: 'jsonx', label: 'JSONX' }, { value: 'josl', label: 'JOSL' }],
    }],
  }),
];
