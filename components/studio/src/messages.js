//@ts-check
/**
 * @file The studio's English message catalog: every word of chrome the
 * Project IDE, the Flow studio and the Data studio show a reader (pane,
 * button and field labels, titles and aria-labels, placeholders, status
 * lines, empty states, the stage's result titles and stat cards, and the
 * refusals the studio itself writes into its UI), keyed by a stable
 * `studio/...` id in the suite's one message grammar
 * (`@jarenjs/core/message`): `{name}` substitutes a parameter, `{{` is a
 * literal brace, and a closure stands where English needs logic (a real
 * plural). A locale pack translates these ids; {@link studioText} renders
 * through such a pack, compiled, falling back to this English per id.
 *
 * Deliberately English, and so not here: format and kind names (`app`,
 * `jslt`, JSON, SQLite, OpenAPI, …), the prose paragraphs that explain a
 * pane (they render with `lang="en"`), example and seed content, the
 * coded diagnostics of the compilers a file is checked with, the
 * worker's coded refusals, and the developer-facing receipts and throws
 * of the editor APIs.
 */

import { compileMessageCatalog } from '@jarenjs/core/message';

/** @param {number} n @returns {string} the English plural suffix */
const plural = (n) => (n === 1 ? '' : 's');

/**
 * The studio's English catalog: message id → template or render closure.
 * Frozen; a locale pack supplies the same ids.
 * @type {Readonly<Record<string, string | ((params: any) => string)>>}
 */
export const studioMessagesEn = Object.freeze({
  // ——— shared: the phone pane switcher of every studio ———
  'studio/panes': 'pane',

  // ——— the Project IDE: the pen bar ———
  'studio/project/pane-files': 'Files',
  'studio/project/pane-editor': 'Editor',
  'studio/project/pane-stage': 'Stage',
  'studio/project/untitled': 'Untitled project',
  'studio/project/saved': 'Saved',
  'studio/project/unsaved': 'Unsaved ●',
  'studio/project/new': 'New',
  'studio/project/file-count': '{count} files',
  'studio/project/layout': 'layout',
  'studio/project/layout-side': 'Side',
  'studio/project/layout-side-title': 'Editor beside the stage',
  'studio/project/layout-swap': 'Swap',
  'studio/project/layout-swap-title': 'Stage beside the editor',
  'studio/project/layout-stack': 'Stack',
  'studio/project/layout-stack-title': 'Editor over the stage',
  'studio/project/autorun': 'Autorun',
  'studio/project/run': 'Run',

  // ——— the Project IDE: the file rail and the editor ———
  'studio/project/files': 'files',
  'studio/project/add-file': 'add a file',
  'studio/project/add-file-option': '+ add file…',
  'studio/project/file-errors': 'this file has errors',
  'studio/project/file-delete': 'delete file',
  'studio/project/file-delete-title': 'delete this file',
  'studio/project/file-name': 'file name',
  'studio/project/line-count': '{count} lines',
  'studio/project/conflict': 'This file changed while you were editing — your text is kept.',
  'studio/project/conflict-take': 'Take theirs',
  'studio/project/conflict-take-title': 'Discard your edit and take the version that arrived',
  'studio/project/route-input': 'Input',
  'studio/project/route-input-file': 'Input file',
  'studio/project/route-input-default': 'Default data file',
  'studio/project/route-model': 'Model',
  'studio/project/route-model-file': 'Model file',
  'studio/project/route-model-memory': 'In-memory input',
  'studio/project/route-collection': 'Collection',
  'studio/project/route-collection-placeholder': 'Only collection',
  'studio/project/resize': 'Resize the editor and stage',

  // ——— the Project IDE: the stage ———
  'studio/stage/head': 'Stage',
  'studio/stage/hint': 'Edit — this file runs live against the data file here.',
  'studio/stage/empty': 'Add a file to begin.',
  'studio/stage/boot-failed': '{name} does not boot yet — fix the file (the last good render stays).',
  'studio/stage/input': 'An input — edit it as text; it feeds the app, a query or a validation.',
  'studio/stage/press-run': 'Press Run to open the {role}.',

  // ——— what each kind of file is, as the rail and the stage name it ———
  'studio/role/app': 'application',
  'studio/role/jslt': 'transform',
  'studio/role/query': 'query',
  'studio/role/state': 'state',
  'studio/role/data': 'data',
  'studio/role/schema': 'schema',
  'studio/role/fsm': 'state machine',
  'studio/role/dag': 'dataflow',
  'studio/role/model': 'data store',
  'studio/role/contract': 'contract',

  // ——— the stage's run results ———
  'studio/run/result': 'Result',
  'studio/run/plan': 'Query plan',
  'studio/run/model-failed': 'Model run',
  'studio/run/reference-failed': 'Project reference',
  'studio/run/dag-output': 'DAG output',
  'studio/run/empty-sequence': '(empty sequence)',
  'studio/run/dag-failed': 'DAG run',
  'studio/run/machine': 'Machine run',
  'studio/run/flow-failed': 'Flow run',
  'studio/run/invalid-json': 'Invalid JSON',
  'studio/run/data-invalid-json': 'data: {reason}',
  'studio/run/contract-refusal': 'Contract refusal',
  'studio/run/operations': 'Operations',
  'studio/run/openapi-dropped': 'OpenAPI dropped',
  'studio/run/schema-error': 'Schema error',
  'studio/run/valid': 'Valid',
  'studio/run/invalid': 'Invalid',
  'studio/run/error-count': (/** @type {{ count: number }} */ p) => `${p.count} error${plural(p.count)}`,
  'studio/run/draft': 'Draft',
  'studio/run/compile': 'Compile',
  'studio/run/validate': 'Validate',
  'studio/run/validation-error': 'Validation error',

  // ——— the status line the project's downloads write ———
  'studio/status/no-app': 'this project has no app document',
  'studio/status/app-invalid-json': 'the app document is not valid JSON',
  'studio/status/document-downloaded': 'document downloaded',
  'studio/status/download-unavailable': 'download unavailable here',
  'studio/status/offline-preparing': 'Preparing offline project…',
  'studio/status/offline-downloaded': 'offline project downloaded',
  'studio/status/offline-unavailable': 'offline export unavailable here',
  'studio/status/project-downloaded': 'project downloaded',

  // ——— a document's render widgets and its boot refusal ———
  'studio/document/form-no-schema': 'form: props.schema must be a JSON Schema object',
  'studio/document/form-failed': 'form: {message}',
  'studio/document/chart-failed': 'chart: {message}',
  'studio/document/invalid': (/** @type {{ count: number }} */ p) =>
    `the document does not validate against the jaren-app meta-schema (${p.count} error${plural(p.count)})`,

  // ——— the Flow studio: the canvas ———
  'studio/flow/machine': 'Machine',
  'studio/flow/dataflow': 'Dataflow',
  'studio/flow/add-state': 'Add state',
  'studio/flow/add-node': 'Add node',
  'studio/flow/connect': 'Connect',
  'studio/flow/connect-armed': 'Click a target…',
  'studio/flow/delete': 'Delete',
  'studio/flow/undo': 'Undo',
  'studio/flow/redo': 'Redo',
  'studio/flow/new': 'New',
  'studio/flow/tab-diagram': 'Diagram',
  'studio/flow/tab-text': 'Text',
  'studio/flow/read-only': 'Read-only: {reason} — edit through the diagram or the inspector instead.',
  'studio/flow/text-hint': 'Edits apply when the field loses focus — the text re-parses, projects back to the document, and a broken edit never replaces it.',
  'studio/flow/loss-states': 'states carry entry/exit/final members, which diagram text cannot express',
  'studio/flow/loss-guard': 'a structured guard would flatten to the […] placeholder',
  'studio/flow/loss-effect': 'an effect carries props, which the / label drops',
  'studio/flow/loss-documents': 'query, stylesheet and task documents do not fit in diagram text',
  'studio/flow/loss-selectors': 'edge selectors do not fit in diagram text',
  'studio/flow/expected-diagram': 'expected a {expected} diagram, got \'{got}\'',
  'studio/flow/dag-schema': 'the projected dag failed jaren-dag schema validation',

  // ——— the Flow studio: the inspector ———
  'studio/flow/inspector': 'Inspector',
  'studio/flow/inspector-hint': 'Select a state, node or edge in the diagram to edit it here — every field writes straight into the document.',
  'studio/flow/selected-state': 'state {id}',
  'studio/flow/selected-node': 'node {id}',
  'studio/flow/selected-transition': 'transition #{index}',
  'studio/flow/selected-edge': 'edge #{index}',
  'studio/flow/target-state': 'state {id}',
  'studio/flow/target-node': 'node {id}',
  'studio/flow/target-transition': 'transition {index}',
  'studio/flow/target-edge': 'edge {index}',
  'studio/flow/field-from-state': 'From state',
  'studio/flow/field-event': 'Event (empty = any)',
  'studio/flow/field-guard': 'Guard (query document)',
  'studio/flow/field-to-state': 'To state',
  'studio/flow/field-effects': 'Effects',
  'studio/flow/field-from-node': 'From node',
  'studio/flow/field-to-node': 'To node',
  'studio/flow/field-port': 'Port',
  'studio/flow/field-select': 'Select (query document)',
  'studio/flow/field-member': 'Member (JSON)',

  // ——— the Flow studio: the run pane ———
  'studio/flow/run': 'Run',
  'studio/flow/stop': 'Stop',
  'studio/flow/run-machine': 'Run machine',
  'studio/flow/run-machine-hint': 'Boot the machine as a real nested @jarenjs/app: the generated per-event actions drive it, and the diagram highlights the current state.',
  'studio/flow/current': 'current:',
  'studio/flow/run-input': 'Run input (JSON)',
  'studio/flow/run-graph': 'Run graph',
  'studio/flow/abort': 'Abort',
  'studio/flow/input-not-json': 'the input is not JSON: {reason}',
  'studio/flow/node-failed': '{message} (node \'{node}\')',
  'studio/flow/pane-diagram': 'Diagram',
  'studio/flow/pane-inspector': 'Inspector',
  'studio/flow/pane-run': 'Run',
  'studio/flow/picker-lead': 'Start from a seed — a complete, runnable document either way.',
  'studio/flow/load': 'Load',

  // ——— the Data studio: the store pane ———
  'studio/data/store': 'Store',
  'studio/data/topology': 'topology:',
  'studio/data/capture': 'capture:',
  'studio/data/operators': 'operators:',
  'studio/data/owner-only': 'Only the owning tab can recreate or migrate the store.',
  'studio/data/oracle-title': 'Spatial agreement — the same plans as Node',
  'studio/data/oracle-run': 'Run the spatial corpus',
  'studio/data/oracle-json': 'Every answer, as JSON',
  'studio/data/oracle-running': 'running the spatial corpus through this tab’s store…',
  'studio/data/oracle-failed': 'the spatial corpus could not run here: {message}',
  'studio/data/oracle-agreed': '{executor} agreed with the engine on every entry: {agreed} / {ran}',
  'studio/data/oracle-disagreed': '{executor} DISAGREED with the engine on {disagreed} of {ran}',
  'studio/data/oracle-verdict': '{verdict} ({entries} entries × {mappings}); {skipped} engine-only entries left out by their marker',
  'studio/data/operators-title': 'Registered operators (host opt-in)',
  'studio/data/operators-summary': '{count} registered · {pushed} pushed to SQLite as UDFs',
  'studio/data/operators-awaiting': 'the owner\'s (awaiting capabilities)',
  'studio/data/operators-none': 'none registered',
  'studio/data/model-title': 'Model (jaren-model JSON)',
  'studio/data/recreate': 'Recreate store from model',
  'studio/data/documents': 'Documents',
  'studio/data/rows-stored': '{count} stored in {collection}',
  'studio/data/delete-document': 'Delete this document',
  'studio/data/durable-sab': 'persistent (OPFS with SharedArrayBuffer and cross-origin isolation)',
  'studio/data/durable-snapshot': 'persistent (atomic IndexedDB snapshots; writes await storage)',
  'studio/data/durable-sahpool': 'persistent (OPFS access-handle pool, no special headers)',
  'studio/data/durable-memory': 'in-memory (non-durable — persistent storage is unavailable; data lives until reload)',
  'studio/data/durable-undecided': 'not decided yet — the store has not booted',

  // ——— the Data studio: the query pane ———
  'studio/data/query': 'Query',
  'studio/data/run-explain': 'Run + explain',
  'studio/data/insert-title': 'new {collection} title… (enter inserts)',
  'studio/data/insert-json': 'new document as JSON… (enter inserts)',
  'studio/data/explain-title': 'explain() — the pushdown, visible',
  'studio/data/params': 'params:',
  'studio/data/indexes': 'indexes:',
  'studio/data/residual': 'residual:',
  'studio/data/no-indexes': '(none)',
  'studio/data/no-residual': 'none — fully pushed to SQL',
  'studio/data/results': 'Results',
  'studio/data/try-operator': 'Try a registered operator',

  // ——— the Data studio: the live pane and the migration ———
  'studio/data/live': 'Live query',
  'studio/data/live-unavailable': 'Live queries are unavailable while writes await durable snapshots. The Store pane refreshes after each write.',
  'studio/data/live-summary': '{count} rows, seq {seq}',
  'studio/data/live-regs': 'live registrations on the store:',
  'studio/data/migration': 'Migration',
  'studio/data/migration-lead': 'Plan a model change, verify it on a SHADOW database, apply it — in the browser.',
  'studio/data/migrate': 'Add a title index (plan → shadow → apply)',
  'studio/data/planned': 'planned steps:',
  'studio/data/applied': 'applied: {count}',

  // ——— the Data studio: the round trip ———
  'studio/data/trip': 'Round trip',
  'studio/data/trip-run': 'Run the round trip',
  'studio/data/trip-explain': 'explain() — the two-stage spatial plan',
  'studio/data/prefilters': 'pre-filters:',
  'studio/data/narrative': 'scan narrative:',
  'studio/data/trip-result': 'The result — the features inside the region, as stored',
  'studio/data/trip-stylesheet': 'The stylesheet — CSV rows to a FeatureCollection, no code',
  'studio/data/trip-model': 'The model — derived spatial indexes over the geometry',
  'studio/data/trip-query': 'The query — written through @jarenjs/linq',
  'studio/data/trip-emits': 'emits this document, with the region bound as an external:',

  // ——— the Data studio: the panes, the boot, the refusals it writes ———
  'studio/data/pane-store': 'Store',
  'studio/data/pane-query': 'Query',
  'studio/data/pane-live': 'Live',
  'studio/data/pane-trip': 'Round trip',
  'studio/data/booting': 'Loading the SQLite wasm build…',
  'studio/data/boot-failed': 'The store did not boot.',
  'studio/data/boot-stage': 'Stage {stage} failed: {message}',
  'studio/data/boot-retry': 'Retry the boot',
  'studio/data/not-booted': 'the store is not booted — retry the boot first',
  'studio/data/invalid-json': '{what}: invalid JSON — {reason}',
  'studio/data/document-invalid-json': 'document: invalid JSON — {reason}',
  'studio/data/live-ended': 'live stream ended ({reason})',
  'studio/data/no-corpus': 'the spatial corpus is not available here',
  'studio/data/not-ready': 'the store is not ready yet',
  'studio/data/not-geojson': 'the stylesheet\'s output is not GeoJSON by the meta-schema',
  'studio/data/not-geojson-at': 'the stylesheet\'s output is not GeoJSON by the meta-schema — {path}: {message}',

  // ——— a project's private data store, on the Project IDE's stage ———
  'studio/store/lead': 'Private SQLite store · {model} · rows last until the model or seed changes, or the project closes.',
  'studio/store/opening': 'Opening SQLite…',
  'studio/store/ready': 'Ready',
  'studio/store/committed': 'Committed',
  'studio/store/live-failed': 'Live query: {message}',
  'studio/store/live-ended': 'Live query ended: {reason}',
  'studio/store/insert': 'Insert document (JSON)',
  'studio/store/insert-row': 'Insert row',
  'studio/store/delete': 'Delete key (JSON)',
  'studio/store/delete-row': 'Delete row',
  'studio/store/result': 'Result',
  'studio/store/live': 'Live result',
  'studio/store/plan': 'Query plan',
});

/** The English catalog, compiled once: the fallback of every id. */
const ENGLISH = compileMessageCatalog(studioMessagesEn);

/**
 * A text function over a compiled catalog: `t(id, params)` renders `id`
 * through `catalog` (the output of `compileMessageCatalog` over a locale
 * pack: a record of render functions) and falls back to the English of
 * {@link studioMessagesEn} per id — when the catalog lacks the id, or its
 * entry throws or answers something other than a string. With no catalog
 * every id renders its English.
 * @example
 * import { compileMessageCatalog } from '@jarenjs/core/message';
 * const t = studioText(compileMessageCatalog({ 'studio/project/run': 'Uitvoeren' }));
 * t('studio/project/run');                        // 'Uitvoeren'
 * t('studio/project/line-count', { count: 3 });   // '3 lines', English fallback
 * @param {Readonly<Record<string, unknown>> | null} [catalog] - a compiled catalog, or none for English
 * @returns {(id: string, params?: Record<string, unknown>) => string}
 */
export function studioText(catalog) {
  return function studioMessage(id, params = {}) {
    const render = catalog != null && Object.hasOwn(catalog, id) ? catalog[id] : undefined;
    if (typeof render === 'function') {
      try {
        const text = render(params);
        if (typeof text === 'string') return text;
      }
      catch { /* a throwing translation renders the English */ }
    }
    return Object.hasOwn(ENGLISH, id) ? ENGLISH[id](params) : id;
  };
}

/**
 * The catalog a `messages` option names right now. A host whose reader
 * can switch language while a runtime lives passes a function answering
 * the current compiled catalog; a host with one language passes the
 * catalog itself; absent, English.
 * @param {Readonly<Record<string, unknown>> | (() => Readonly<Record<string, unknown>> | null | undefined) | null | undefined} messages
 * @returns {Readonly<Record<string, unknown>> | null | undefined}
 */
export const catalogOf = (messages) => (typeof messages === 'function' ? messages() : messages);

/** A text function per catalog, so every render of one language shares one. */
const TEXTS = new WeakMap();
/** English, for the code paths that run before any catalog is known. */
export const studioEnglish = studioText();

/**
 * The text function of a `messages` option (see {@link catalogOf}),
 * memoized per catalog.
 * @param {Parameters<typeof catalogOf>[0]} messages
 * @returns {(id: string, params?: Record<string, unknown>) => string}
 */
export function studioTextOf(messages) {
  const catalog = catalogOf(messages);
  if (catalog == null || typeof catalog !== 'object') return studioEnglish;
  let t = TEXTS.get(catalog);
  if (t === undefined) {
    t = studioText(catalog);
    TEXTS.set(catalog, t);
  }
  return t;
}

/**
 * A view model's words, built once per catalog: `build(t)` names the
 * chrome a view shows, and the same object comes back for the same
 * catalog, so the JSLT memo keeps firing across renders.
 * @template T
 * @param {(t: (id: string, params?: Record<string, unknown>) => string) => T} build
 * @returns {(messages: Parameters<typeof catalogOf>[0]) => T}
 */
export function wordsBy(build) {
  const byText = new WeakMap();
  return (messages) => {
    const t = studioTextOf(messages);
    let words = byText.get(t);
    if (words === undefined) {
      words = build(t);
      byText.set(t, words);
    }
    return words;
  };
}
