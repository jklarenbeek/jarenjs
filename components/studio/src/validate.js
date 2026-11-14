//@ts-check
/**
 * @file Per-file validation — the honest heart of the per-file design.
 * `validateFile(file)` dispatches on the file's kind and validates its
 * `text` against THAT kind's grammar (never one composed mega-schema):
 *
 *  - `app`    → the composed jaren-app meta-schema (which `$ref`s the
 *               query + JSLT grammars) PLUS a headless render audit (a
 *               document that validates but throws on its first frame is
 *               still broken);
 *  - `jslt` / `query` → COMPILED by the engine WITH the operator registry,
 *               so host-registered operators ($npv, $sqrt) validate and a
 *               real error comes back as its own coded `JQ`/`JT` code with
 *               a docPath — the closed grammar would reject the operators;
 *  - `fsm` / `dag` / `model` → their grammar plus compiler/planner checks;
 *  - `contract` → COMPILED by `compileContract`, so a refusal comes back
 *               as its stable `JC00xx` code with the docPath of the
 *               member at fault — richer than the grammar alone;
 *  - `schema` → compiled as a JSON Schema (is it well-formed?);
 *  - `state` / `data` → any JSON (structural only).
 *
 * Every result is `{ valid, kind, total, errors: [{ code, message,
 * docPath }], warnings }` — the shape the IDE's docked error strip reads.
 * `warnings` are findings that do not refuse (same item shape, `JS0005`
 * today: an app view's text that holds another template language's
 * expression); they are empty for every other kind.
 *
 * A grammar failure that a compiler can explain better yields to it: when
 * an `app`, `fsm` or `dag` document fails its meta-schema because an
 * operator is unknown, the report is the compiler's `JQ0002` at the
 * operator's own place (with its nearest known operator), in place of the
 * branch errors the unknown key caused there ("must have required property
 * '$await'" for an action).
 */

import { createWeakCache } from '@jarenjs/core/cache';
import { JarenValidator } from '@jarenjs/validate';
import { createTypeTestCompiler } from '@jarenjs/validate/query';
import { compileJsonQuery } from '@jarenjs/json';
import {
  compileJsltStylesheet, createJsltRegistry, mathPack, financePack, statsPack,
} from '@jarenjs/json/jslt';
import { compileContract } from '@jarenjs/contract';
import { compileFsm, compileDag } from '@jarenjs/flow';
import { normalizeModel, normalizeEntities, planCollection, planEntity, explainMapping, sqliteDialect } from '@jarenjs/db';

import appSchema from '@jarenjs/app/schemas/jaren-app.schema.json' with { type: 'json' };
import querySchema from '@jarenjs/json/schemas/jaren-query.schema.json' with { type: 'json' };
import jsltSchema from '@jarenjs/json/schemas/jaren-jslt.schema.json' with { type: 'json' };
import fsmSchema from '@jarenjs/flow/schemas/jaren-fsm.schema.json' with { type: 'json' };
import dagSchema from '@jarenjs/flow/schemas/jaren-dag.schema.json' with { type: 'json' };
import modelSchema from '@jarenjs/db/schemas/jaren-model.schema.json' with { type: 'json' };

import { auditRenderedView } from './render-audit.js';

/** Errors kept per report: enough to repair, bounded for the IDE. */
const MAX_ERRORS = 20;

const compileTypeTest = createTypeTestCompiler();

// the studio mounts the built-in operator packs so a query/jslt/data file
// may compute with $npv/$sqrt/$mean/… (host opt-in; a plain compile would
// reject them). A host embedding the studio can substitute its own via
// `validateFile(file, { operators })`.
const defaultRegistry = createJsltRegistry().use(mathPack).use(financePack).use(statsPack);
const defaultRegistryOptions = defaultRegistry.toOptions();

const validateApp = new JarenValidator({ skipErrors: false, collectErrors: true })
  .addSchema(querySchema).addSchema(jsltSchema).compile(appSchema);
const validateFsm = new JarenValidator({ skipErrors: false, collectErrors: true })
  .addSchema(querySchema).compile(fsmSchema);
const validateDag = new JarenValidator({ skipErrors: false, collectErrors: true })
  .addSchema(querySchema).addSchema(jsltSchema).compile(dagSchema);
const validateModel = new JarenValidator({ skipErrors: false, collectErrors: true })
  .compile(modelSchema);

/** @param {string} kind */
const ok = (kind) => ({ valid: true, kind, total: 0, errors: [] });

/**
 * Normalize a JarenValidator failure into the studio error shape. A
 * coded compiler error in `explained` replaces the schema errors at, under
 * and above (short of the root) its owner: the first two pointer tokens
 * of its place, an action or a transition, say.
 * @param {string} kind
 * @param {any} outcome
 * @param {Array<{ code: string, message: string, docPath: string }>} [explained]
 */
function schemaResult(kind, outcome, explained = []) {
  const valid = typeof outcome === 'object' && outcome !== null ? outcome.valid : outcome === true;
  if (valid) return ok(kind);
  let raw = (typeof outcome === 'object' && outcome !== null ? outcome.errors : null) ?? [];
  if (explained.length > 0) {
    const owners = explained.map((e) => e.docPath.split('/').slice(0, 3).join('/'));
    const caused = (/** @type {string} */ at) => owners.some((owner) => at === owner || at.startsWith(owner + '/')
      || (at !== '' && owner.startsWith(at + '/')));
    raw = raw.filter((e) => !caused(e.instancePath ?? ''));
  }
  const errors = [...explained, ...raw.map((e) => ({ code: null, message: e.message ?? 'invalid', docPath: e.instancePath ?? '' }))];
  return { valid: false, kind, total: errors.length, errors: errors.slice(0, MAX_ERRORS) };
}

/**
 * The unknown operator a compile refusal is about, with its place in the
 * document: the `JQ0002` in the refusal's cause chain, its `docPath`
 * composed from each wrapper's (a `JT0007` already composes its cause's).
 * @param {unknown} err
 * @param {string} base - the pointer of what was compiled
 * @returns {{ code: string, message: string, docPath: string } | null}
 */
function unknownOperatorOf(err, base) {
  let docPath = base;
  /** @type {any} */
  let link = err;
  /** @type {any} */
  let outer = null;
  for (let depth = 0; link !== null && typeof link === 'object' && depth < 8; depth++) {
    if (outer?.code !== 'JT0007' && typeof link.docPath === 'string') docPath += link.docPath;
    if (link.code === 'JQ0002') {
      return { code: 'JQ0002', message: typeof link.reason === 'string' ? link.reason : String(link.message), docPath };
    }
    outer = link;
    link = link.cause;
  }
  return null;
}

/**
 * Compile the query-bearing members of a document that failed its
 * grammar, and collect the unknown operators the compilers name.
 * @param {string} kind
 * @param {any} doc
 * @param {Record<string, any>} registryOptions
 */
function unknownOperators(kind, doc, registryOptions) {
  /** @type {Array<{ code: string, message: string, docPath: string }>} */
  const found = [];
  const probe = (/** @type {string} */ base, /** @type {() => unknown} */ run) => {
    try { run(); }
    catch (err) {
      const unknown = unknownOperatorOf(err, base);
      if (unknown !== null) found.push(unknown);
    }
  };
  const options = { compileTypeTest, ...registryOptions };
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return found;
  if (kind === 'app') {
    // the app's own query positions (APP-FORMAT §3), compiled as the app
    // compiles them; the studio root stays off the app runtime
    if (doc.view !== undefined) probe('/view', () => compileJsltStylesheet(doc.view, { ...options, memo: false }));
    if (isPlainNodes(doc.actions)) {
      for (const [name, action] of Object.entries(doc.actions)) {
        const at = `/actions/${escapeToken(name)}`;
        // an awaiting action is read as the app reads one (a member named
        // `$await`), never as a query: a malformed `$await` is the grammar's
        if (isPlainNodes(action) && Object.hasOwn(action, '$await')) {
          if (!isPlainNodes(action.$await)) continue;
          for (const member of ['start', 'with', 'then', 'catch']) {
            if (action.$await[member] !== undefined) probe(`${at}/$await/${member}`, () => compileJsonQuery(action.$await[member], options));
          }
        }
        else probe(at, () => compileJsonQuery(action, options));
      }
    }
    if (Array.isArray(doc.subs)) {
      doc.subs.forEach((sub, i) => {
        if (!isPlainNodes(sub)) return;
        for (const member of ['when', 'withQuery', 'key', 'for']) {
          if (sub[member] !== undefined) probe(`/subs/${i}/${member}`, () => compileJsonQuery(sub[member], options));
        }
      });
    }
  }
  else if (kind === 'fsm') probe('', () => compileFsm(doc));
  else if (kind === 'dag') {
    const tasks = Object.fromEntries(Object.values(isPlainNodes(doc.nodes) ? doc.nodes : {})
      .filter((node) => node?.kind === 'task' && typeof node.run === 'string').map((node) => [node.run, () => null]));
    probe('', () => compileDag(doc, { tasks }));
  }
  return found;
}

/**
 * @param {unknown} nodes
 * @returns {nodes is Record<string, any>}
 */
const isPlainNodes = (nodes) => nodes !== null && typeof nodes === 'object' && !Array.isArray(nodes);

/** @param {string} token - one JSON Pointer token, escaped */
const escapeToken = (token) => token.replaceAll('~', '~0').replaceAll('/', '~1');

/** Run a compile and surface its throw as one coded error, or pass. */
function compileResult(kind, run) {
  try {
    run();
    return ok(kind);
  }
  catch (err) {
    const e = /** @type {any} */ (err);
    return {
      valid: false, kind, total: 1,
      errors: [{ code: e?.code ?? null, message: String(e?.message ?? err), docPath: e?.docPath }],
    };
  }
}

/**
 * A headless render audit for an `app` document: compile the JSLT view
 * and render its first frame over the state. A view that throws is a
 * broken document even when the meta-schema passed it, and so is one that
 * renders an element written as an object (`JS0004`, see
 * `./render-audit.js`); text holding another template language's
 * expression is a warning (`JS0005`).
 * @param {any} doc
 * @returns {{ errors: Array<{ code: string | null, message: string, docPath: string }>,
 *   warnings: Array<{ code: string, message: string, docPath: string }> }}
 */
function auditAppView(doc) {
  let frame;
  try {
    frame = compileJsltStylesheet(doc.view, { compileTypeTest, memo: false, ...defaultRegistryOptions })(doc.state ?? {});
  }
  catch (err) {
    return { errors: [{ code: null, message: `the view failed to render its first frame: ${String(/** @type {any} */ (err)?.message ?? err)}`, docPath: '/view' }], warnings: [] };
  }
  const { refusals, warnings } = auditRenderedView(doc.view, frame);
  return { errors: refusals, warnings };
}

/**
 * Verdicts keyed by the FILE OBJECT: validating an `app` compiles its view
 * and renders a first frame, so re-deriving the IDE view model on every
 * render (a theme toggle, a keystroke elsewhere) would recompile the whole
 * project — measured at ~110ms for a charts app. Files are immutable here
 * (every edit lands as a fresh object through the patch engine, and an
 * untouched file keeps its identity), so reference identity is a sound —
 * and free — cache key. The inner map keys the registry, because the same
 * file validates differently under a different operator vocabulary.
 * @type {ReturnType<typeof createWeakCache<object, Map<any, any>>>}
 */
const verdicts = createWeakCache();

/**
 * Validate ONE file against its kind's grammar. Memoized on the file's
 * identity; pass a fresh object to force a re-check.
 * @param {{ name?: string, kind: string, text: string }} file
 * @param {{ operators?: { toOptions: () => any } }} [options] - a host
 *   operator registry for the `jslt`/`query` kinds (defaults to the
 *   built-in math/finance/stats packs)
 * @returns {{ valid: boolean, kind: string, total: number,
 *   errors: Array<{ code: string | null, message: string, docPath?: string }>,
 *   warnings: Array<{ code: string, message: string, docPath: string }> }}
 */
export function validateFile(file, options = {}) {
  if (file === null || typeof file !== 'object') return withWarnings(validateFileUncached(file, options));
  const byRegistry = verdicts.getOrCreate(file, () => new Map());
  const registryKey = options.operators ?? null;
  let verdict = byRegistry.get(registryKey);
  if (verdict === undefined) {
    verdict = withWarnings(validateFileUncached(file, options));
    byRegistry.set(registryKey, verdict);
  }
  return verdict;
}

/**
 * Every verdict carries `warnings`, empty unless a check found some.
 * @param {{ valid: boolean, kind: string, total: number, errors: any[], warnings?: any[] }} verdict
 */
function withWarnings(verdict) {
  return verdict.warnings === undefined ? { ...verdict, warnings: [] } : verdict;
}

/**
 * The validation itself — see `validateFile`, which memoizes it.
 * @param {{ name?: string, kind: string, text: string }} file
 * @param {{ operators?: { toOptions: () => any } }} [options]
 */
function validateFileUncached(file, options = {}) {
  const kind = file.kind;
  const registryOptions = options.operators ? options.operators.toOptions() : defaultRegistryOptions;

  let doc;
  try { doc = JSON.parse(file.text); }
  catch (err) {
    return {
      valid: false, kind, total: 1,
      errors: [{ code: null, message: `not valid JSON: ${String(/** @type {any} */ (err)?.message ?? err)}`, docPath: '' }],
    };
  }

  switch (kind) {
    case 'state':
    case 'data':
      return ok(kind); // any JSON value is a valid state/data file
    case 'app': {
      const outcome = validateApp(doc);
      const structural = schemaResult(kind, outcome);
      if (!structural.valid) return schemaResult(kind, outcome, unknownOperators(kind, doc, registryOptions));
      const audit = auditAppView(doc);
      return audit.errors.length === 0
        ? { ...structural, warnings: audit.warnings }
        : { valid: false, kind, total: audit.errors.length, errors: audit.errors, warnings: audit.warnings };
    }
    case 'jslt':
      return compileResult(kind, () => compileJsltStylesheet(doc, { compileTypeTest, ...registryOptions }));
    case 'query':
      return compileResult(kind, () => compileJsonQuery(doc, { compileTypeTest, ...registryOptions }));
    case 'fsm': {
      const outcome = validateFsm(doc);
      const structural = schemaResult(kind, outcome);
      return structural.valid ? compileResult(kind, () => compileFsm(doc))
        : schemaResult(kind, outcome, unknownOperators(kind, doc, registryOptions));
    }
    case 'dag': {
      const outcome = validateDag(doc);
      const structural = schemaResult(kind, outcome);
      if (!structural.valid) return schemaResult(kind, outcome, unknownOperators(kind, doc, registryOptions));
      // Validate named task nodes without acquiring or running host tasks.
      const tasks = Object.fromEntries(Object.values(doc.nodes ?? {})
        .filter((node) => node.kind === 'task').map((node) => [node.run, () => null]));
      return compileResult(kind, () => compileDag(doc, { tasks }));
    }
    case 'model': {
      const structural = schemaResult(kind, validateModel(doc));
      if (!structural.valid) return structural;
      return compileResult(kind, () => {
        for (const [name, collection] of normalizeModel(doc)) planCollection(name, collection, sqliteDialect);
        if (normalizeEntities(doc).size > 0) {
          const mapping = explainMapping(doc);
          for (const name of Object.keys(mapping.entities)) planEntity(name, mapping.entities[name], mapping, sqliteDialect);
        }
      });
    }
    case 'contract':
      return compileResult(kind, () => compileContract(doc));
    case 'schema':
      // a JSON Schema is a boolean or an object; anything else is not a
      // schema at all (the compiler is otherwise lenient about a schema's
      // internals — the studio is a project IDE, not a schema linter)
      if (typeof doc !== 'boolean' && (doc === null || typeof doc !== 'object' || Array.isArray(doc)))
        return { valid: false, kind, total: 1, errors: [{ code: null, message: 'a JSON Schema must be an object or a boolean', docPath: '' }] };
      return compileResult(kind, () => new JarenValidator().compile(doc));
    default:
      return { valid: false, kind, total: 1, errors: [{ code: null, message: `unknown file kind '${kind}'`, docPath: '' }] };
  }
}
