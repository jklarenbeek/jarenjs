//@ts-check
/**
 * @file The scratchpad's engine descriptors — each wraps a real shipped
 * `@jarenjs` compiler into a pure `run(source, data, options) → ScratchResult`.
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
import { createTypeTestCompiler } from '@jarenjs/validate/query';

const compileTypeTest = createTypeTestCompiler();

const now = () => performance.now();
const fmt = (v) => (v === undefined ? '(no result)' : JSON.stringify(v, null, 2));
const msg = (err) => String(/** @type {any} */ (err)?.message ?? err);
const code = (err) => /** @type {any} */ (err)?.code;

/** Parse a pane's JSON text; `{ value }` or `{ error }`. */
function parseJson(text, label) {
  try { return { value: JSON.parse((text ?? 'null') === '' ? 'null' : text) }; }
  catch (err) { return { error: `${label}: ${msg(err)}` }; }
}

/** @returns {import('./index.js').ScratchResult} */
const ok = (output, compileMs, runMs) => ({ ok: true, output, timing: { compileMs, runMs }, error: null });
/** @returns {import('./index.js').ScratchResult} */
const fail = (message, c, path) => ({ ok: false, output: '', timing: null, error: { message, code: c, path } });

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
];
