//@ts-check
/**
 * @file The playground's engine descriptors — each wraps a real shipped
 * `@jarenjs` compiler into a pure `run(source, data, options) → PlayResult`.
 * `sourcePanes` are the engine input(s); `dataPanes` are the JSON it runs
 * against (empty for a source-only engine).
 * Registered operators reach the `query`/`jslt` engines through
 * `options.operators` (a `.toOptions()` registry) — the host opt-in.
 */

import {
  compileJSONPath, compileJSONPointer, compileRelativeJSONPointer, JSONPOINTER_NOTHING,
  compileJSONPatch, applyMergePatch, createJSONPatch, createMergePatch, compileJsonQuery,
} from '@jarenjs/json';
import { renderQueryMessage } from '@jarenjs/json/query';
import { compileJsltStylesheet } from '@jarenjs/json/jslt';
import { compileJtltStylesheet } from '@jarenjs/json/jtlt';
import { parseXQuery } from '@jarenjs/json/xquery';
import { parseJosl, stringifyJosl, parseJsonx, stringifyJsonx, LocalDate, LocalTime, LocalDateTime } from '@jarenjs/josl';
import { parseCsvDocument, stringifyCsv, sniffCsvDialect } from '@jarenjs/josl/csv';
import { createTypeTestCompiler } from '@jarenjs/validate/query';
import { compileContract } from '@jarenjs/contract';
import { openLocalClient } from '@jarenjs/contract/local';
import { toOpenApi, toTypeScript } from '@jarenjs/contract/project';
import { compileEmitModel } from '@jarenjs/emit';
import { renderTypeScript } from '@jarenjs/emit/typescript';
import { renderMarkdown } from '@jarenjs/emit/markdown';
import { formatMs } from './format.js';
import { readChain } from './chain.js';
import { KERNELS } from './kernels.js';
import { escapePointerToken } from '@jarenjs/core/string';
import { LOCALE_NAMES } from '@jarenjs/locales/names';
import { playText, playEnglish } from './messages.js';

const compileTypeTest = createTypeTestCompiler();

const now = () => performance.now();
/** A value as the JSON an output panel shows; `undefined` as the words for no result. */
const fmt = (v, t) => (v === undefined ? t('play/result/none') : JSON.stringify(v, null, 2));
const msg = (err) => String(/** @type {any} */ (err)?.message ?? err);
const code = (err) => /** @type {any} */ (err)?.code;

/**
 * An engine error's message for the reader. A query error names its
 * sentence (`messageId` and `params`, rendered by `renderQueryMessage`);
 * when the host's catalog translates that sentence, the message is the
 * code, the translated reason and the location in the catalog's words.
 * Every other error, and every error when there is no catalog or the
 * catalog lacks the sentence, keeps its own message verbatim.
 * @param {unknown} err
 * @param {(id: string, params?: Record<string, unknown>) => string} t
 * @param {Readonly<Record<string, unknown>> | undefined} messages
 * @returns {string}
 */
function errorText(err, t, messages) {
  const e = /** @type {any} */ (err);
  if (messages == null || typeof e?.messageId !== 'string' || e.messageId === 'query/reason'
    || !Object.hasOwn(messages, e.messageId) || typeof e.code !== 'string') return msg(err);
  const reason = renderQueryMessage(e, messages);
  if (typeof e.docPath !== 'string') return `${e.code}: ${reason}`;
  return `${e.code}: ${reason} ${e.docPath === '' ? t('play/where/root') : t('play/where/path', { path: e.docPath })}`;
}

/**
 * The text half of a run's options: `t` renders a playground message
 * through the host's compiled catalog (`options.messages`, English when
 * absent) and `say` an engine error (see {@link errorText}).
 * @param {import('./index.js').RunOptions | undefined} options
 */
function speech(options) {
  const messages = options?.messages;
  const t = playText(messages);
  return { t, say: (/** @type {unknown} */ err) => errorText(err, t, messages) };
}

/** The word a JSON parse failure names its pane by, per pane (the patch
 * engine's `data` pane is its "target"). */
const SUBJECTS = Object.freeze({
  __proto__: null,
  data: 'play/subject/data', target: 'play/subject/target', patch: 'play/subject/patch',
  query: 'play/subject/query', externals: 'play/subject/externals', stylesheet: 'play/subject/stylesheet',
  template: 'play/subject/template', schema: 'play/subject/schema', schemas: 'play/subject/schemas',
  args: 'play/subject/args', document: 'play/subject/document', call: 'play/subject/call',
});

/**
 * Parse a pane's JSON text; `{ value }` or `{ error, pane }`. `pane` is the
 * pane KEY (what the result's error location names); `label` is the word
 * the message uses for it, which differs where the pane's label does (the
 * patch engine's `data` pane is its "target"). The host's `JSON.parse`
 * states the offending offset only inside its engine-specific message
 * text, never as a field — so a parse failure locates the PANE and
 * nothing finer.
 */
function parseJson(text, pane, t, label = pane) {
  try { return { value: JSON.parse((text ?? 'null') === '' ? 'null' : text) }; }
  catch (err) { return { error: t('play/error/json', { pane: t(SUBJECTS[label]), message: msg(err) }), pane }; }
}

/**
 * A patch pane's text as the same change in another mode: the document the
 * change makes from the target, written as an RFC 6902 patch, an RFC 7396
 * merge patch, or itself (the diff mode's pane holds the target), so the
 * switch shows one change three ways.
 * @param {Record<string, string>} source @param {Record<string, string>} data
 * @param {string} from @param {string} to
 */
function convertPatch(source, data, from, to) {
  const target = JSON.parse(data.data);
  const given = JSON.parse(source.patch);
  const result = from === 'merge' ? applyMergePatch(target, given)
    : from === 'diff' ? given
      : compileJSONPatch(given, { changes: true })(target).doc;
  const next = to === 'merge' ? createMergePatch(target, result)
    : to === 'diff' ? result
      : createJSONPatch(target, result);
  return { ...source, patch: fmt(next, playEnglish) };
}

/**
 * A chart definition in another notation, read and written by the codecs
 * the host's renderer reads each with.
 * @param {Record<string, string>} source @param {Record<string, string>} _data
 * @param {string} from @param {string} to
 */
function convertDefinition(source, _data, from, to) {
  const text = source.source ?? '';
  const value = from === 'josl' ? parseJosl(text) : parseJsonx(text, { mode: from === 'jsonx' ? 'jsonx' : 'json' });
  const written = to === 'josl' ? stringifyJosl(value)
    : stringifyJsonx(value, { mode: to === 'jsonx' ? 'jsonx' : 'json', indent: 2 });
  return { ...source, source: written };
}

/** The optional JSON bindings pane shared by every engine accepting externals. */
function parseExternals(source, t) {
  return source.externals === undefined || String(source.externals).trim() === ''
    ? { value: {} } : parseJson(source.externals, 'externals', t);
}

/**
 * The `validate` engine's referenced-schemas pane: a JSON array of schema
 * documents, each addressable by its own `$id`. `{ value }` (an empty or
 * absent pane is no schemas) or `{ error, pane }`. A member with no string
 * `$id` (or an empty one), or one repeating an earlier `$id`, is refused here: a document no
 * `$ref` can name is silently dead weight, and two documents under one
 * name leave it to the host which one a reference reaches.
 */
function parseReferencedSchemas(text, t) {
  if (text === undefined || String(text).trim() === '') return { value: [] };
  const parsed = parseJson(text, 'schemas', t);
  if (parsed.error) return parsed;
  if (!Array.isArray(parsed.value)) return { error: t('play/error/schemas-array'), pane: 'schemas' };
  const ids = new Set();
  for (let i = 0; i < parsed.value.length; i++) {
    const item = parsed.value[i];
    if (item === null || typeof item !== 'object' || Array.isArray(item) || typeof item.$id !== 'string' || item.$id === '') {
      return { error: t('play/error/schemas-item', { index: i }), pane: 'schemas' };
    }
    // `X` and `X#` name one document: a trailing empty fragment is no difference
    const name = item.$id.endsWith('#') ? item.$id.slice(0, -1) : item.$id;
    if (ids.has(name)) return { error: t('play/error/schemas-repeat', { index: i, id: JSON.stringify(item.$id) }), pane: 'schemas' };
    ids.add(name);
  }
  return { value: parsed.value };
}

/** A single-`code`-panel Result — the shape most engines return. */
/** @returns {import('./index.js').PlayResult} */
const ok = (t, text, compileMs, runMs, deep) => okPanels([{ id: 'out', label: t('play/panel/output'), kind: 'code', text }, ...(deep ?? [])], compileMs, runMs);

/**
 * A multi-panel Result — the engine hands over its own screen list.
 * Either half of the timing may be `null`, and that is load-bearing: an
 * engine with no compile step (patch merge/diff) and a phase the host
 * measured for us or not at all are all honestly "no number", never a
 * fabricated `0` the stage would print as "ran 0 ms".
 * @returns {import('./index.js').PlayResult}
 */
const okPanels = (panels, compileMs, runMs) => ({ ok: true, timing: { compileMs, runMs }, error: null, panels });

/** A `deep` cards panel — the "how it ran" stat row of a drill-down. */
/** @returns {import('./index.js').Panel} */
const deepCards = (id, label, items) => ({ id, label, kind: 'cards', depth: 'deep', items });

/** A `deep` code panel — a compiled artifact / round-trip drill-down. */
/** @returns {import('./index.js').Panel} */
const deepCode = (id, label, text) => ({ id, label, kind: 'code', depth: 'deep', text });

/** A table cell → a display string. Primitives (incl. BigInt, from typed CSV)
 * stringify directly; an object whose JSON is a string (a typed date) shows
 * that string; other objects/arrays become compact JSON. Never throws. */
const cell = (v) => {
  if (v == null) return '';
  if (typeof v === 'object') {
    // a typed date reads as its own text, the text the CSV round-trip writes:
    // JSON's quotes around it would show it as the untyped string it is not
    try { const json = JSON.stringify(v); return json.startsWith('"') ? JSON.parse(json) : json; } catch { return String(v); }
  }
  return String(v);
};

/** A parser event's path (an array of keys and indexes) as the JSON Pointer it
 * names (RFC 6901 — `~` and `/` escaped), the root shown as `(root)`. */
const pointerCell = (path, t) => (path ?? []).map((token) => `/${escapePointerToken(String(token))}`).join('') || t('play/cell/root');

/** How many document-order events a drill-down table keeps. */
const EVENT_CAP = 200;

/** A parsed JSONX scalar JSON writes differently, as the note's phrase — or
 * `null` for one JSON keeps. */
function jsonLoss(value, t) {
  if (typeof value === 'bigint') return t('play/loss/bigint');
  if (value instanceof RegExp) return t('play/loss/regexp');
  if (typeof value === 'number' && !Number.isFinite(value)) return t('play/loss/number', { value: stringifyJsonx(value) });
  const what = value instanceof Date ? 'play/loss/instant' : value instanceof LocalDateTime ? 'play/loss/local-date-time'
    : value instanceof LocalDate ? 'play/loss/local-date' : value instanceof LocalTime ? 'play/loss/local-time' : null;
  return what === null ? null : t(what, { json: JSON.stringify(value) });
}

/** The kernel table by option value (a Map, so an inherited name finds nothing). */
const KERNEL_BY_VALUE = new Map(KERNELS.map((k) => [k.value, k]));

/**
 * The kernels card's verdict on its two doors: `yes` or `no` only when
 * both answer the arguments. A door that refuses them, or answers nothing
 * (the kernel's `null`, the operator's empty sequence), answers another
 * question than the door that answers, so the card says which door did
 * what instead of comparing.
 * @param {unknown} answer - The kernel's answer
 * @param {unknown} queryAnswer - The operator document's answer
 * @param {unknown} refusal - What the operator document threw, if it threw
 * @param {(id: string, params?: Record<string, unknown>) => string} t - the run's text function
 * @returns {string}
 */
function sameAnswer(answer, queryAnswer, refusal, t) {
  const kernelAnswers = answer !== null && answer !== undefined;
  const kernelSays = answer === undefined ? t('play/kernel/answers-nothing') : t('play/kernel/answers', { answer: fmt(answer, t) });
  if (refusal !== undefined) {
    const refuses = code(refusal) === undefined ? t('play/kernel/refuses') : t('play/kernel/refuses-with', { code: code(refusal) });
    return kernelAnswers ? refuses : t('play/kernel/and', { first: refuses, second: kernelSays });
  }
  if (!kernelAnswers) {
    return t('play/kernel/not-compared', {
      reason: queryAnswer === undefined ? t('play/kernel/and', { first: kernelSays, second: t('play/kernel/query-nothing') }) : kernelSays,
    });
  }
  if (queryAnswer === undefined) return t('play/kernel/query-answers-nothing');
  return fmt(queryAnswer, t) === fmt(answer, t) ? t('play/kernel/same') : t('play/kernel/different');
}

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
    sourcePanes: [{ key: 'source', label: opts.sourceLabel, ...(opts.sourceMsgid ? { msgid: opts.sourceMsgid } : {}), control: 'code' }],
    dataPanes: [],
    ...(opts.optionPanes ? { optionPanes: opts.optionPanes } : {}),
    run(source, data, options) {
      const render = options?.renderers?.[id];
      if (typeof render !== 'function') {
        return fail(`the ${label} engine renders in the host — inject options.renderers.${id}`, 'PLAY_NO_RENDERER');
      }
      const { t, say } = speech(options);
      const t0 = now();
      let view;
      // the third argument hands the renderer the reader's language (md's
      // accessible names read it through `labelsFromCatalog`)
      try { view = render(source.source ?? '', options?.config, { messages: options?.messages }); }
      catch (err) { return fail(say(err), code(err), locate(err, 'source')); }
      const t1 = now();
      return okPanels(renderedPanels(view, t), ...renderTiming(view, t1 - t0));
    },
  };
}

/**
 * Split a host render's cost into `[compileMs, runMs]`. A renderer that
 * reports its own phases (it compiles the source, then builds the vnode)
 * is believed; one that does not leaves us holding a single wall-clock
 * number for both, which we attribute to the RUN and leave the compile
 * `null` — claiming a compile figure we never measured is the bug this
 * replaces.
 */
function renderTiming(view, totalMs) {
  const compileMs = typeof view?.compileMs === 'number' ? view.compileMs : null;
  const runMs = typeof view?.runMs === 'number' ? view.runMs : null;
  if (compileMs === null && runMs === null) return [null, totalMs];
  return [compileMs, runMs];
}

/** A host-rendered view (a bare vnode, or `{ vnode, deep }`) → the panel
 * list: the preview plus any host-derived deep panels (AST, canonical
 * round-trip), stamped `deep` so they ride behind the depth toggle. */
function renderedPanels(view, t) {
  const rich = view !== null && typeof view === 'object' && !Array.isArray(view) && 'vnode' in view;
  const vnode = rich ? view.vnode : view;
  const deep = rich && Array.isArray(view.deep)
    ? view.deep.map((p) => ({ ...p, depth: 'deep' }))
    : [];
  return [{ id: 'preview', label: t('play/panel/preview'), kind: 'view', vnode }, ...deep];
}
/**
 * An error Result. `where` is the location half of the format's error —
 * `pane` plus whichever of `path`/`dataPath`/`position`/`line`/`column`
 * the compiler stated (see {@link locate}); only stated fields land on
 * the error, so a field's presence means the compiler said it.
 * @returns {import('./index.js').PlayResult}
 */
const fail = (message, c, where) => ({
  ok: false, timing: null,
  error: { message, ...(c === undefined ? {} : { code: c }), ...where },
  panels: [],
});

/** The error Result of a pane whose JSON did not parse — locates the pane. */
const failParse = (d) => fail(d.error, undefined, { pane: d.pane });

/**
 * The location an engine error carries, in the format's own fields — one
 * adapter over the three shapes the compilers use. The coded family
 * (`@jarenjs/core` `CodedError`: patch, query, JSLT, JTLT) states a
 * `docPath`, a JSON Pointer into the document being compiled or run, and
 * a patch runtime error adds the `dataPath` its operation failed at in the
 * target; the syntax family (JSONPath, JSON Pointer, XQuery) states a
 * 0-based `position` into the source text; the line/column family (JOSL,
 * CSV) states 1-based `line`/`column`. Only what the error carries is
 * copied. `pane` names the editor the phase was working on — the source
 * pane for compile AND run (a runtime location points into the compiled
 * document, which is that pane's text) — and is omitted where the
 * location is into a document the learner never typed (XQuery compiles a
 * GENERATED query document, and a location in it has no pane).
 * @param {unknown} err
 * @param {string} [pane] the pane key the location points into
 */
function locate(err, pane) {
  const e = /** @type {any} */ (err);
  /** @type {{ pane?: string, path?: string, dataPath?: string, position?: number, line?: number, column?: number }} */
  const where = pane === undefined ? {} : { pane };
  if (typeof e?.docPath === 'string') where.path = e.docPath;
  if (typeof e?.dataPath === 'string') where.dataPath = e.dataPath;
  if (typeof e?.position === 'number') where.position = e.position;
  if (typeof e?.line === 'number') where.line = e.line;
  if (typeof e?.column === 'number') where.column = e.column;
  return where;
}

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
    sourcePanes: [{ key: 'selector', label: 'Selector', msgid: 'play/pane/selector', control: 'text' }],
    dataPanes: [{ key: 'data', label: 'Data', msgid: 'play/pane/data' }],
    run(source, data, options) {
      const { t, say } = speech(options);
      const d = parseJson(data.data, 'data', t); if (d.error) return failParse(d);
      let compiled; const t0 = now();
      try { compiled = compileJSONPath(source.selector ?? ''); }
      catch (err) { return fail(say(err), code(err), locate(err, 'selector')); }
      const t1 = now();
      let nodes;
      try { nodes = compiled.nodes(d.value); }
      catch (err) { return fail(say(err), code(err), locate(err, 'selector')); }
      const t2 = now();
      return ok(t, fmt(nodes.map((n) => n.value), t), t1 - t0, t2 - t1, [
        deepCards('how', t('play/panel/how-matched'), [
          { title: t('play/card/matches'), value: String(nodes.length) },
          { title: t('play/card/compile'), value: formatMs(t1 - t0) },
          { title: t('play/card/run'), value: formatMs(t2 - t1) },
        ]),
        deepCode('paths', t('play/panel/paths'), fmt(nodes.map((n) => n.path), t)),
      ]);
    },
  },
  {
    id: 'pointer', label: 'JSON Pointer', lead: 'RFC 6901 absolute and relative pointers — address exactly one value.',
    sourcePanes: [
      { key: 'pointer', label: 'Pointer', msgid: 'play/pane/pointer', control: 'text' },
      // a RELATIVE pointer (it starts with a digit: "1/price", "0#") walks
      // from this location; an absolute pointer ignores it
      { key: 'location', label: 'From location (relative pointers)', msgid: 'play/pane/location', control: 'text' },
    ],
    dataPanes: [{ key: 'data', label: 'Data', msgid: 'play/pane/data' }],
    run(source, data, options) {
      const { t, say } = speech(options);
      const d = parseJson(data.data, 'data', t); if (d.error) return failParse(d);
      const pointer = source.pointer ?? '';
      const relative = /^\d/.test(pointer);
      let getter; const t0 = now();
      try { getter = relative ? compileRelativeJSONPointer(pointer) : compileJSONPointer(pointer); }
      catch (err) { return fail(say(err), code(err), locate(err, 'pointer')); }
      const t1 = now();
      let value;
      try { value = relative ? getter(d.value, source.location ?? '') : getter(d.value); }
      catch (err) { return fail(say(err), code(err), locate(err, 'pointer')); }
      const t2 = now();
      if (value === JSONPOINTER_NOTHING) return ok(t, t('play/result/pointer-nothing'), t1 - t0, t2 - t1);
      return ok(t, fmt(value, t), t1 - t0, t2 - t1);
    },
  },
  {
    id: 'patch', label: 'JSON Patch', lead: 'RFC 6902 and RFC 7396, copy-on-write and atomic — plus structural diff.',
    sourcePanes: [{ key: 'patch', label: 'Patch', msgid: 'play/pane/patch', control: 'code' }],
    dataPanes: [{ key: 'data', label: 'Target document', msgid: 'play/pane/target' }],
    optionPanes: [{
      key: 'mode', label: 'Mode', msgid: 'play/option/mode', default: 'patch',
      choices: [
        { value: 'patch', label: 'RFC 6902 apply', msgid: 'play/choice/patch-apply' },
        { value: 'merge', label: 'RFC 7396 merge', msgid: 'play/choice/patch-merge' },
        { value: 'diff', label: 'diff (patch pane = the target)', msgid: 'play/choice/patch-diff' },
      ],
      convert: convertPatch,
    }],
    run(source, data, options) {
      const { t, say } = speech(options);
      const mode = options?.config?.mode ?? 'patch';
      const target = parseJson(data.data, 'data', t, 'target'); if (target.error) return failParse(target);
      const patch = parseJson(source.patch, 'patch', t); if (patch.error) return failParse(patch);
      if (mode === 'merge') {
        // RFC 7396: null members delete; an unchanged document is the INPUT
        let out; const t0 = now();
        try { out = applyMergePatch(target.value, patch.value); }
        catch (err) { return fail(say(err), code(err), locate(err, 'patch')); }
        const t1 = now();
        return ok(t, fmt(out, t), null, t1 - t0, [
          deepCards('how', t('play/panel/how-merged'), [
            { title: t('play/card/output'), value: out === target.value ? t('play/card/same-input') : t('play/card/new-document'), note: out === target.value ? t('play/card/shared') : undefined },
          ]),
        ]);
      }
      if (mode === 'diff') {
        // the patch pane holds the TARGET document; both patch flavours of
        // the structural diff are derived from data → target
        let jsonPatch, mergePatch; const t0 = now();
        try {
          jsonPatch = createJSONPatch(target.value, patch.value);
          mergePatch = createMergePatch(target.value, patch.value);
        }
        catch (err) { return fail(say(err), code(err), locate(err, 'patch')); }
        const t1 = now();
        return okPanels([
          { id: 'out', label: t('play/panel/patch-ops', { count: jsonPatch.length }), kind: 'code', text: fmt(jsonPatch, t) },
          deepCode('merge', t('play/panel/merge-flavour'), fmt(mergePatch, t)),
        ], null, t1 - t0);
      }
      let apply; const t0 = now();
      try { apply = compileJSONPatch(patch.value, { changes: true }); }
      catch (err) { return fail(say(err), code(err), locate(err, 'patch')); }
      const t1 = now();
      let run;
      try { run = apply(target.value); }
      catch (err) { return fail(say(err), code(err), locate(err, 'patch')); }
      const t2 = now();
      return ok(t, fmt(run.doc, t), t1 - t0, t2 - t1, [
        deepCode('changes', t('play/panel/changes'), fmt(run.changes, t)),
      ]);
    },
  },
  {
    id: 'query', label: '$query', lead: 'Jaren JSON Query — filter, project and fold (registered operators included).',
    sourcePanes: [{ key: 'query', label: 'Query', msgid: 'play/pane/query', control: 'code' }, { key: 'externals', label: 'Externals', msgid: 'play/pane/externals', control: 'code' }],
    dataPanes: [{ key: 'data', label: 'Data', msgid: 'play/pane/data' }],
    run(source, data, options) {
      const { t, say } = speech(options);
      const d = parseJson(data.data, 'data', t); if (d.error) return failParse(d);
      const q = parseJson(source.query, 'query', t); if (q.error) return failParse(q);
      const e = parseExternals(source, t); if (e.error) return failParse(e);
      let fn; const t0 = now();
      try { fn = compileJsonQuery(q.value, compileOptions(options)); }
      catch (err) { return fail(say(err), code(err), locate(err, 'query')); }
      const t1 = now();
      let out;
      try { out = fn(d.value, e.value); }
      catch (err) { return fail(say(err), code(err), locate(err, 'query')); }
      const t2 = now();
      const items = out === undefined ? 0 : Array.isArray(out) ? out.length : 1;
      return ok(t, fmt(out, t), t1 - t0, t2 - t1, [
        deepCards('how', t('play/panel/how-ran'), [
          { title: t('play/card/items'), value: String(items) },
          { title: t('play/card/compile'), value: formatMs(t1 - t0) },
          { title: t('play/card/run'), value: formatMs(t2 - t1) },
        ]),
      ]);
    },
  },
  {
    id: 'jslt', label: 'JSLT', lead: 'JSON stylesheet transform (registered operators included).',
    sourcePanes: [{ key: 'stylesheet', label: 'Stylesheet', msgid: 'play/pane/stylesheet', control: 'code' }, { key: 'externals', label: 'Externals', msgid: 'play/pane/externals', control: 'code' }],
    dataPanes: [{ key: 'data', label: 'Data', msgid: 'play/pane/data' }],
    run(source, data, options) {
      const { t, say } = speech(options);
      const d = parseJson(data.data, 'data', t); if (d.error) return failParse(d);
      const s = parseJson(source.stylesheet, 'stylesheet', t); if (s.error) return failParse(s);
      const e = parseExternals(source, t); if (e.error) return failParse(e);
      let compiled; const t0 = now();
      try { compiled = compileJsltStylesheet(s.value, compileOptions(options)); }
      catch (err) { return fail(say(err), code(err), locate(err, 'stylesheet')); }
      const t1 = now();
      let out;
      try { out = compiled(d.value, e.value); }
      catch (err) { return fail(say(err), code(err), locate(err, 'stylesheet')); }
      const t2 = now();
      // the identity lesson: a rule that changes nothing hands the INPUT back
      // (shared, copy-on-write) — worth teaching, so the deep card says which
      return ok(t, fmt(out, t), t1 - t0, t2 - t1, [
        deepCards('how', t('play/panel/how-transformed'), [
          { title: t('play/card/compile'), value: formatMs(t1 - t0) },
          { title: t('play/card/transform'), value: formatMs(t2 - t1) },
          { title: t('play/card/output'), value: out === d.value ? t('play/card/same-input') : t('play/card/new-document'), note: out === d.value ? t('play/card/shared') : undefined },
        ]),
      ]);
    },
  },
  {
    id: 'jtlt', label: 'JTLT', lead: 'JSLT\'s text front-end — render JSON as Markdown, XML or code.',
    sourcePanes: [{ key: 'template', label: 'Template', msgid: 'play/pane/template', control: 'code' }, { key: 'externals', label: 'Externals', msgid: 'play/pane/externals', control: 'code' }],
    dataPanes: [{ key: 'data', label: 'Data', msgid: 'play/pane/data' }],
    run(source, data, options) {
      const { t, say } = speech(options);
      const d = parseJson(data.data, 'data', t); if (d.error) return failParse(d);
      const tpl = parseJson(source.template, 'template', t); if (tpl.error) return failParse(tpl);
      const e = parseExternals(source, t); if (e.error) return failParse(e);
      let render; const t0 = now();
      try { render = compileJtltStylesheet(tpl.value, compileOptions(options)); }
      catch (err) { return fail(say(err), code(err), locate(err, 'template')); }
      const t1 = now();
      let out;
      try { out = render(d.value, e.value); }
      catch (err) { return fail(say(err), code(err), locate(err, 'template')); }
      const t2 = now();
      // JTLT emits TEXT (markdown / xml / source) — show it verbatim, not fmt'd
      return ok(t, out === '' ? t('play/result/empty') : out, t1 - t0, t2 - t1, [
        // the machinery: JTLT desugars to a JSLT stylesheet — show it
        deepCode('compiled', t('play/panel/compiled-program'), fmt(render.stylesheet, t)),
      ]);
    },
  },
  {
    id: 'xquery', label: 'XQuery', lead: 'The XQuery 3.1 text subset — parsed to a query document and run over $doc.',
    sourcePanes: [{ key: 'text', label: 'XQuery', control: 'code' }, { key: 'externals', label: 'Externals', msgid: 'play/pane/externals', control: 'code' }],
    dataPanes: [{ key: 'data', label: 'Data', msgid: 'play/pane/data' }],
    run(source, data, options) {
      const { t, say } = speech(options);
      const d = parseJson(data.data, 'data', t); if (d.error) return failParse(d);
      let doc, fn; const t0 = now();
      const e = parseExternals(source, t); if (e.error) return failParse(e);
      // two phases: the text parses (a syntax error locates a position in
      // the XQuery pane), then the GENERATED query document compiles and
      // runs — a location in that document has no pane the learner typed
      try { doc = parseXQuery(source.text ?? ''); }
      catch (err) { return fail(say(err), code(err), locate(err, 'text')); }
      try { fn = compileJsonQuery(doc, compileOptions(options)); }
      catch (err) { return fail(say(err), code(err), locate(err)); }
      const t1 = now();
      let out;
      try {
        const externals = fn.externals.includes('doc') ? { ...e.value, doc: d.value } : e.value;
        out = fn(d.value, externals);
      }
      catch (err) { return fail(say(err), code(err), locate(err)); }
      const t2 = now();
      return ok(t, out === undefined ? t('play/result/empty-sequence') : fmt(out, t), t1 - t0, t2 - t1, [
        // the machinery: the XQuery text parses to a runnable query DOCUMENT
        deepCode('doc', t('play/panel/generated-document'), fmt(doc, t)),
      ]);
    },
  },
  {
    // a fluent chain is the pen, the query document is the deliverable: the
    // chain is read as text (no eval — chain.js), replayed against the real
    // @jarenjs/linq surface, and both halves are shown — the document a model
    // learns to author, and what it answers over the data
    id: 'linq', label: 'LINQ', lead: 'A fluent @jarenjs/linq chain compiles to the query document a model learns to author — shown beside its answer.',
    sourcePanes: [{ key: 'chain', label: 'Chain', msgid: 'play/pane/chain', control: 'code' }],
    dataPanes: [{ key: 'data', label: 'Data', msgid: 'play/pane/data' }],
    run(source, data, options) {
      const { t, say } = speech(options);
      const d = parseJson(data.data, 'data', t); if (d.error) return failParse(d);
      let seq, document; const t0 = now();
      // the compile phase: the text is read and replayed, and the chain emits
      // its document — a refusal (the reader's, or linq's own JL code) is
      // positioned at the call in the Chain pane
      try { seq = readChain(source.chain ?? '', d.value, { compileTypeTest, messages: options?.messages }); document = seq.toDocument(); }
      catch (err) { return fail(say(err), code(err), locate(err, 'chain')); }
      const t1 = now();
      let items;
      // the run phase executes the GENERATED document: a location in it has
      // no pane the learner typed, as with XQuery
      try { items = seq.toArray(); }
      catch (err) { return fail(say(err), code(err), locate(err)); }
      const t2 = now();
      return okPanels([
        { id: 'out', label: t('play/panel/answer'), kind: 'code', text: fmt(items, t) },
        { id: 'document', label: t('play/panel/query-document'), kind: 'code', text: fmt(document, t) },
        deepCards('how', t('play/panel/how-ran'), [
          { title: t('play/card/items'), value: String(items.length) },
          { title: t('play/card/compile'), value: formatMs(t1 - t0) },
          { title: t('play/card/run'), value: formatMs(t2 - t1) },
        ]),
      ], t1 - t0, t2 - t1);
    },
  },
  {
    id: 'josl', label: 'JOSL', lead: 'The streaming TOML superset — JavaScript-obvious values, round-trips.',
    sourcePanes: [{ key: 'text', label: 'Document', msgid: 'play/pane/document', control: 'code' }],
    dataPanes: [],
    optionPanes: [{
      key: 'mode', label: 'Dialect', msgid: 'play/option/dialect', default: 'josl',
      choices: [{ value: 'josl', label: 'JOSL' }, { value: 'toml', label: 'TOML (strict 1.0)', msgid: 'play/choice/toml-strict' }],
    }],
    run(source, data, options) {
      const { t, say } = speech(options);
      const mode = options?.config?.mode ?? 'josl';
      /** @type {any[]} */
      const events = [];
      let parsed; const t0 = now();
      // parse (compile) and serialize (run) are the two visible phases; the
      // parser streams document-order events as it reads — capture (capped)
      // for the "how it streamed" drill-down
      try { parsed = parseJosl(source.text ?? '', { mode, onEvent: (e) => { if (events.length < EVENT_CAP) events.push(e); } }); }
      catch (err) { return fail(say(err), code(err), locate(err, 'text')); }
      const t1 = now();
      const out = stringifyJsonx(parsed, { indent: 2 });
      const t2 = now();
      return ok(t, out, t1 - t0, t2 - t1, [
        {
          id: 'events', label: t(events.length === EVENT_CAP ? 'play/panel/how-streamed-capped' : 'play/panel/how-streamed', { count: events.length }),
          kind: 'table', depth: 'deep', columns: [t('play/column/type'), t('play/column/path'), t('play/column/value')],
          rows: events.map((e) => [e.type, pointerCell(e.path, t), e.type === 'pair' ? stringifyJsonx(e.value) : '']),
        },
        deepCode('roundtrip', t('play/panel/roundtrip'), stringifyJosl(parsed, { mode })),
      ]);
    },
  },
  {
    // JSONX as an INPUT dialect: read it as the data every other engine's
    // data pane takes, and name each value JSON writes differently — a
    // regexp is `{}` and a bigint refuses the whole document under
    // JSON.stringify, so the parsed value never goes through `fmt`
    id: 'jsonx', label: 'JSONX', lead: 'JSON plus bigint, regexp, datetimes and inf/nan — read as the data the other engines take.',
    sourcePanes: [{ key: 'text', label: 'JSONX', control: 'code' }],
    dataPanes: [],
    optionPanes: [{
      key: 'mode', label: 'Dialect', msgid: 'play/option/dialect', default: 'jsonx',
      choices: [{ value: 'jsonx', label: 'JSONX' }, { value: 'json', label: 'JSON (strict)', msgid: 'play/choice/json-strict' }],
    }],
    run(source, data, options) {
      const { t, say } = speech(options);
      const mode = options?.config?.mode === 'json' ? 'json' : 'jsonx';
      /** @type {any[]} */
      const events = [];
      /** @type {string[]} */
      const losses = [];
      let bigint = false;
      let value; const t0 = now();
      try {
        value = parseJsonx(source.text ?? '', {
          mode,
          onEvent: (e) => {
            if (events.length < EVENT_CAP) events.push(e);
            if (e.type === 'value' && typeof e.value === 'bigint') bigint = true;
            const loss = e.type === 'value' ? jsonLoss(e.value, t) : null;
            if (loss !== null) losses.push(`${pointerCell(e.path, t)}: ${loss}`);
          },
        });
      }
      catch (err) { return fail(say(err), code(err), locate(err, 'text')); }
      const t1 = now();
      let json = null, roundtrip;
      // a document nested past the call stack parses and then cannot be
      // written: a phase failure at the source pane, never a throw
      try {
        if (!bigint) json = JSON.stringify(value, null, 2);
        roundtrip = stringifyJsonx(value, { indent: 2 });
      }
      catch (err) { return fail(say(err), code(err), { pane: 'text' }); }
      const t2 = now();
      const kept = losses.length === 0
        ? t('play/note/all-kept')
        : [t('play/note/losses', { count: losses.length }), ...losses].join('\n');
      return okPanels([
        ...(json === null ? [] : [{ id: 'out', label: t('play/panel/as-json'), kind: /** @type {'code'} */ ('code'), text: json }]),
        { id: 'kept', label: t('play/panel/kept'), kind: 'note', tone: losses.length === 0 ? 'ok' : 'warn', text: kept },
        {
          id: 'events', label: t(events.length === EVENT_CAP ? 'play/panel/how-read-capped' : 'play/panel/how-read', { count: events.length }),
          kind: 'table', depth: 'deep', columns: [t('play/column/type'), t('play/column/path'), t('play/column/value')],
          rows: events.map((e) => [e.type, pointerCell(e.path, t), e.type === 'value' ? stringifyJsonx(e.value) : (e.kind ?? '')]),
        },
        deepCode('roundtrip', t('play/panel/jsonx-roundtrip'), roundtrip),
      ], t1 - t0, t2 - t1);
    },
  },
  {
    id: 'csv', label: 'CSV', lead: 'RFC 4180 strict, or repair mode that reads damaged CSV and reports every fix.',
    sourcePanes: [{ key: 'text', label: 'CSV', control: 'code' }],
    dataPanes: [],
    optionPanes: [
      { key: 'repair', label: 'Mode', msgid: 'play/option/mode', default: 'strict', choices: [{ value: 'strict', label: 'strict', msgid: 'play/choice/strict' }, { value: 'repair', label: 'repair', msgid: 'play/choice/repair' }] },
      { key: 'headers', label: 'Header row', msgid: 'play/option/header-row', default: 'true', choices: [{ value: 'true', label: 'yes', msgid: 'play/choice/yes' }, { value: 'false', label: 'no', msgid: 'play/choice/no' }, { value: 'auto', label: 'auto', msgid: 'play/choice/auto' }] },
      { key: 'delimiter', label: 'Delimiter', msgid: 'play/option/delimiter', default: 'auto', choices: [{ value: 'auto', label: 'auto', msgid: 'play/choice/auto' }, { value: ',', label: ',' }, { value: ';', label: ';' }, { value: 'tab', label: 'tab', msgid: 'play/choice/tab' }, { value: '|', label: '|' }] },
      { key: 'typed', label: 'Typed values', msgid: 'play/option/typed', default: 'off', choices: [{ value: 'off', label: 'off', msgid: 'play/choice/off' }, { value: 'on', label: 'on', msgid: 'play/choice/on' }] },
    ],
    run(source, data, options) {
      const { t, say } = speech(options);
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
      catch (err) { return fail(say(err), code(err), locate(err, 'text')); }
      const t1 = now();
      // one calm SCREEN (the summary note) plus the drill-down: the parsed
      // records, the sniffed dialect, the repairs, and the CSV round-trip
      // are `deep` — revealed only when the student asks how it was read
      const fields = doc.fields; // string[] (headers) | null (positional)
      const total = doc.rows.length;
      const shown = doc.rows.slice(0, 50);
      const width = shown.reduce((w, r) => Math.max(w, Array.isArray(r) ? r.length : fields ? fields.length : 0), 0);
      const columns = fields ?? Array.from({ length: width }, (_, i) => String(i + 1));
      const rows = shown.map((r) => columns.map((c, i) => cell(fields ? r[c] : r[i])));
      // a tab delimiter is named, as its option choice names it
      const delimName = (d) => (d === '\t' ? t('play/choice/tab') : d);
      const delim = delimName(doc.dialect.delimiter);
      const summary = [
        [
          t('play/csv/delimited', { delimiter: delim }),
          t(doc.dialect.headers === false ? 'play/csv/no-header' : 'play/csv/header'),
          t('play/csv/records', { count: total }),
          doc.repairs.length ? t('play/csv/repairs', { count: doc.repairs.length }) : t('play/csv/clean'),
          ...(total > shown.length ? [t('play/csv/showing', { count: shown.length })] : []),
        ].join(' · '),
        ...doc.repairs.map((r) => t('play/csv/repair-line', { line: r.line, code: r.code, message: r.message })),
      ].join('\n');
      const roundtrip = stringifyCsv(doc.rows, { fields: fields ?? undefined, header: doc.dialect.headers !== false });
      const sniff = sniffCsvDialect(source.text ?? '');
      const t2 = now();
      return okPanels([
        { id: 'summary', label: t('play/panel/summary'), kind: 'note', tone: doc.repairs.length ? 'warn' : 'ok', text: summary },
        { id: 'rows', label: t('play/panel/rows', { count: total }), kind: 'table', depth: 'deep', columns, rows },
        {
          id: 'dialect', label: t('play/panel/dialect'), kind: 'table', depth: 'deep',
          columns: [t('play/column/property'), t('play/column/value')],
          rows: [
            [t('play/csv/delimiter'), delim],
            [t('play/csv/header'), String(doc.dialect.headers)],
            [t('play/csv/sniffed'), t('play/csv/sniff', {
              delimiter: delimName(sniff.delimiter), width: sniff.width, confidence: sniff.confidence.toFixed(2), headers: sniff.headers,
            })],
            [t('play/csv/record-count'), String(total)],
          ],
        },
        ...(doc.repairs.length ? [{
          id: 'repairs', label: t('play/panel/repairs', { count: doc.repairs.length }), kind: /** @type {'table'} */ ('table'), depth: /** @type {'deep'} */ ('deep'),
          columns: [t('play/column/code'), t('play/column/line'), t('play/column/col'), t('play/column/read')],
          rows: doc.repairs.map((r) => [r.code, String(r.line), String(r.column), r.message]),
        }] : []),
        { id: 'roundtrip', label: t('play/panel/csv-roundtrip'), kind: 'code', depth: 'deep', text: roundtrip },
      ], t1 - t0, t2 - t1);
    },
  },
  {
    // the @jarenjs/core kernels the $query operators run, called directly:
    // the Arguments pane is the call's JSON array, and the deep drill-down
    // is the operator document that runs the same kernel over the same
    // array (read as its data) — with its answer, and whether the two
    // doors answer the same when both answer (`sameAnswer`)
    id: 'kernels', label: 'Core kernels', msgid: 'play/engine/kernels', lead: 'The @jarenjs/core functions the $query operators run — geo, dates, math, text — called directly.',
    sourcePanes: [{ key: 'args', label: 'Arguments — a JSON array', msgid: 'play/pane/args', control: 'code' }],
    dataPanes: [],
    optionPanes: [{
      key: 'kernel', label: 'Kernel', msgid: 'play/option/kernel', default: KERNELS[0].value,
      choices: KERNELS.map((k) => ({ value: k.value, label: `${k.family} · ${k.value}` })),
      // each kernel takes its own arguments: a switch loads its example
      follow: 'example',
    }],
    run(source, data, options) {
      const { t, say } = speech(options);
      // a value the choice list does not offer is the default kernel
      const kernel = KERNEL_BY_VALUE.get(options?.config?.kernel ?? '') ?? KERNELS[0];
      const a = parseJson(source.args, 'args', t); if (a.error) return failParse(a);
      if (!Array.isArray(a.value)) return fail(t('play/error/args-array'), undefined, { pane: 'args' });
      let answer, deep; const t0 = now();
      try { answer = kernel.call(a.value, t); deep = kernel.deep?.(a.value, t) ?? []; }
      catch (err) { return fail(say(err), code(err), locate(err, 'args')); }
      const t1 = now();
      const query = kernel.query(a.value);
      let queryAnswer, refusal;
      try { queryAnswer = compileJsonQuery(query)(a.value); }
      catch (err) { refusal = err; }
      return okPanels([
        { id: 'out', label: t(kernel.msgid), kind: 'code', text: fmt(answer, t) },
        deepCode('query', t('play/panel/operator-query'), fmt(query, t)),
        deepCards('agree', t('play/panel/operator-agree'), [
          { title: t('play/card/query-answers'), value: refusal === undefined ? fmt(queryAnswer, t) : t('play/card/refused', { message: say(refusal) }) },
          { title: t('play/card/same-answer'), value: sameAnswer(answer, queryAnswer, refusal, t) },
        ]),
        ...deep,
      ], null, t1 - t0);
    },
  },
  {
    id: 'validate', label: 'JSON Schema', lead: 'Compile a schema and validate data — every error, localized.',
    sourcePanes: [
      { key: 'schema', label: 'Schema', msgid: 'play/pane/schema', control: 'code' },
      { key: 'schemas', label: 'Referenced schemas', msgid: 'play/pane/schemas', control: 'code' },
    ],
    dataPanes: [{ key: 'data', label: 'Data', msgid: 'play/pane/data' }],
    optionPanes: [{
      key: 'locale', label: 'Messages', msgid: 'play/option/messages', default: 'en',
      // English, then every @jarenjs/locales pack, each named in its own
      // language: derived from the packs' one list, so a pack added there
      // is a choice here (and an example, see LOCALE_EXAMPLES); an
      // unmounted code falls back to English in the host localizer
      choices: [{ value: 'en', label: 'English' }, ...LOCALE_NAMES.map(({ code: value, name }) => ({ value, label: name }))],
    }],
    run(source, data, options) {
      const { t, say } = speech(options);
      // the validator + locale packs are heavy and already cached in the
      // host — inject a `validate(schemaText, data, locale, schemas)` runner
      // (the hybrid seam, like the visual engines' renderers); `schemas` are
      // the referenced documents the host registers before it compiles. No
      // runner → an honest Result, never a throw.
      const validate = options?.validate;
      if (typeof validate !== 'function') {
        return fail('the JSON Schema engine validates in the host — inject options.validate', 'PLAY_NO_VALIDATOR');
      }
      const d = parseJson(data.data, 'data', t); if (d.error) return failParse(d);
      const referenced = parseReferencedSchemas(source.schemas, t); if (referenced.error) return failParse(referenced);
      const locale = options?.config?.locale ?? 'en';
      let report;
      try { report = validate(source.schema ?? '', d.value, locale, referenced.value); }
      catch (err) { return fail(say(err), code(err), locate(err)); }
      if (report.schemaError) return fail(report.schemaError, 'SCHEMA', { pane: typeof report.schemaPane === 'string' ? report.schemaPane : 'schema' });
      const errs = report.errors ?? [];
      const summary = [
        report.valid ? t('play/verdict/valid') : t('play/verdict/errors', { count: errs.length }), String(report.draft),
        t('play/timing/compiled', { ms: formatMs(report.compileMs) }), t('play/timing/validated', { ms: formatMs(report.validateMs) }),
      ].join(' · ');
      const verdict = { id: 'verdict', label: t('play/panel/verdict'), kind: 'note', tone: report.valid ? 'ok' : 'warn', text: summary };
      // the messages ARE the answer of a failing run, in the language the
      // Messages select names: they lead, on screen, and the verdict line is
      // the next tab — behind the drill-down, a language switch showed nothing
      const panels = errs.length === 0 ? [verdict] : [{
        id: 'errors', label: t('play/panel/errors', { count: errs.length }), kind: 'table',
        columns: [t('play/column/instance-path'), t('play/column/message')],
        rows: errs.map((e) => [e.instancePath === '' ? t('play/cell/root') : e.instancePath, e.message]),
      }, verdict];
      return okPanels(panels, report.compileMs ?? null, report.validateMs ?? null);
    },
  },
  {
    // markdown × data: the mdx pass resolves `{$…}` interpolation and the
    // `{#if}` / `{#each}` sections against the DATA pane, then renders —
    // still a pure (source, data) → document engine, delegated to the
    // host's mdx renderer (which owns @jarenjs/md/mdx + the query compiler)
    id: 'mdx', label: 'MDX', lead: 'Markdown × data — {$…} interpolation, {#if} and {#each} sections, rendered live.',
    sourcePanes: [{ key: 'source', label: 'Markdown', control: 'code' }],
    dataPanes: [{ key: 'data', label: 'Data', msgid: 'play/pane/data' }],
    run(source, data, options) {
      const { t, say } = speech(options);
      const render = options?.renderers?.mdx;
      if (typeof render !== 'function') {
        return fail('the MDX engine renders in the host — inject options.renderers.mdx', 'PLAY_NO_RENDERER');
      }
      const d = parseJson(data.data, 'data', t); if (d.error) return failParse(d);
      const t0 = now();
      let view;
      try { view = render(source.source ?? '', d.value, { messages: options?.messages }); }
      catch (err) { return fail(say(err), code(err), locate(err, 'source')); }
      const t1 = now();
      return okPanels(renderedPanels(view, t), ...renderTiming(view, t1 - t0));
    },
  },
  {
    // the one ASYNC engine: the dispatch panel resolves a real client
    // outcome, so run() returns a Promise — runExample and the hosts
    // pass a thenable Result through (PLAY-FORMAT §2)
    id: 'contract', label: 'Contract', lead: 'A $contract document — operations two ends may exchange, compiled, projected and dispatched in-process.',
    sourcePanes: [{ key: 'document', label: '$contract document', msgid: 'play/pane/contract', control: 'code' }],
    dataPanes: [{ key: 'call', label: 'Dispatch — { "op", "input" }', msgid: 'play/pane/call' }],
    async run(source, data, options) {
      const { t, say } = speech(options);
      const d = parseJson(source.document, 'document', t); if (d.error) return failParse(d);
      let contract; const t0 = now();
      // a compile refusal is the engine's lesson: a stable JC00xx code
      // with the JSON Pointer of the member at fault
      try { contract = compileContract(d.value); }
      catch (err) { return fail(say(err), code(err), locate(err, 'document')); }
      const t1 = now();
      let openapi, types;
      try {
        openapi = toOpenApi(contract, {
          info: {
            title: typeof d.value?.id === 'string' ? d.value.id : 'contract',
            version: typeof d.value?.version === 'string' ? d.value.version : '0',
          },
        });
        types = toTypeScript(contract);
      }
      catch (err) { return fail(say(err), code(err), locate(err, 'document')); }
      // the dispatch pane: an op + input run against trivial echo
      // handlers over the local binding — the whole pipeline with no
      // network. Output validation is DECLARED off (a capability the
      // binding states), so any echo crosses; input validation still
      // refuses a bad input with its outcome, which is the lesson.
      /** @type {import('./index.js').Panel} */
      let dispatch = {
        id: 'dispatch', label: t('play/panel/dispatch'), kind: 'note', tone: 'info',
        text: t('play/note/dispatch-hint'),
      };
      if (String(data.call ?? '').trim() !== '') {
        const call = parseJson(data.call, 'call', t); if (call.error) return failParse(call);
        const op = call.value !== null && typeof call.value === 'object' ? call.value.op : undefined;
        if (typeof op !== 'string') {
          dispatch = { id: 'dispatch', label: t('play/panel/dispatch'), kind: 'note', tone: 'warn', text: t('play/note/dispatch-call') };
        }
        else {
          /** @type {Record<string, (input: any) => any>} */
          const handlers = {};
          for (const id of Object.keys(contract.operations)) handlers[id] = (input) => input;
          // the host's catalog words the outcome messages the client writes
          const client = openLocalClient(contract, handlers, {
            validateOutput: 'never', ...(options?.messages == null ? {} : { catalog: options.messages }),
          });
          try {
            const outcome = await client.invoke(op, call.value.input ?? {});
            dispatch = { id: 'dispatch', label: t('play/panel/dispatch-echo'), kind: 'code', text: fmt(outcome, t) };
          }
          catch (err) {
            // a host mistake (JC1005: unknown, opaque or subscribe
            // operation) is the panel's answer, not an engine failure
            dispatch = { id: 'dispatch', label: t('play/panel/dispatch'), kind: 'note', tone: 'warn', text: say(err) };
          }
          finally { client.close(); }
        }
      }
      const t2 = now();
      return okPanels([
        { id: 'describe', label: 'describe()', kind: 'code', text: fmt(contract.describe(), t) },
        { id: 'openapi', label: 'OpenAPI', kind: 'code', text: fmt(openapi.document, t) },
        { id: 'types', label: 'TypeScript', kind: 'code', text: types },
        dispatch,
      ], t1 - t0, t2 - t1);
    },
  },
  {
    // two stages, like every engine here: the schema compiles to a TYPE MODEL
    // (the compile phase), and a stylesheet renders the model as the chosen
    // target (the run phase) — the model is the deep panel, so the learner
    // sees that the target language is the only thing the stylesheet owns
    id: 'emit', label: 'Emit', lead: 'A JSON Schema compiles to a type model and renders as TypeScript declarations or a Markdown reference.',
    sourcePanes: [{ key: 'schema', label: 'JSON Schema', control: 'code' }],
    dataPanes: [],
    optionPanes: [
      { key: 'target', label: 'Target', msgid: 'play/option/target', default: 'typescript', choices: [{ value: 'typescript', label: 'TypeScript' }, { value: 'markdown', label: 'Markdown' }] },
      { key: 'objects', label: 'Objects', msgid: 'play/option/objects', default: 'open', choices: [{ value: 'open', label: 'open', msgid: 'play/choice/open' }, { value: 'closed', label: 'closed', msgid: 'play/choice/closed' }] },
      {
        key: 'normalize', label: 'Normalizer', msgid: 'play/option/normalizer', default: 'none',
        choices: [
          { value: 'none', label: 'none', msgid: 'play/choice/none' }, { value: 'defaults', label: 'defaults', msgid: 'play/choice/defaults' },
          { value: 'coerce', label: 'coercion', msgid: 'play/choice/coercion' }, { value: 'both', label: 'both', msgid: 'play/choice/both' },
        ],
      },
    ],
    run(source, data, options) {
      const { t, say } = speech(options);
      const s = parseJson(source.schema, 'schema', t); if (s.error) return failParse(s);
      // a schema is an object or a boolean; the emitter answers any other
      // value with an empty file, which a learner would read as a result
      if (s.value === null || (typeof s.value !== 'object' && typeof s.value !== 'boolean') || Array.isArray(s.value)) {
        return fail(t('play/error/schema-kind'), undefined, { pane: 'schema' });
      }
      const cfg = options?.config ?? {};
      const normalize = cfg.normalize === 'defaults' ? { useDefaults: true }
        : cfg.normalize === 'coerce' ? { coerceTypes: true }
          : cfg.normalize === 'both' ? { useDefaults: true, coerceTypes: true } : null;
      let model; const t0 = now();
      try { model = compileEmitModel(s.value, { openObjects: cfg.objects === 'closed' ? 'closed' : 'open', normalize }); }
      catch (err) { return fail(say(err), code(err), locate(err, 'schema')); }
      const t1 = now();
      let text;
      try { text = cfg.target === 'markdown' ? renderMarkdown(model) : renderTypeScript(model, { banner: false }); }
      catch (err) { return fail(say(err), code(err), locate(err, 'schema')); }
      const t2 = now();
      return ok(t, text, t1 - t0, t2 - t1, [
        // the machinery: the language-neutral model both renderers read
        deepCode('model', t('play/panel/type-model'), fmt(model, t)),
      ]);
    },
  },
  // ——— the visual engines: descriptor + examples here, rendering delegated ———
  visual('markdown', 'Markdown', 'CommonMark + GFM + frontmatter → a JSON AST, rendered live.', { sourceLabel: 'Markdown' }),
  visual('mermaid', 'Mermaid', 'Diagrams-as-code → a geometry-free AST → pure-vnode SVG.', { sourceLabel: 'Mermaid' }),
  visual('charts', 'Charts', 'A JSON / JSONX / JOSL chart definition → schema-validated → pure-vnode SVG.', {
    sourceLabel: 'Chart definition', sourceMsgid: 'play/pane/chart',
    optionPanes: [{
      key: 'format', label: 'Format', msgid: 'play/option/format', default: 'json',
      choices: [{ value: 'json', label: 'JSON' }, { value: 'jsonx', label: 'JSONX' }, { value: 'josl', label: 'JOSL' }],
      convert: convertDefinition,
    }],
  }),
];
