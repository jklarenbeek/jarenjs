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
 *  - `fsm` / `dag` / `model` → their published grammar (structural);
 *  - `schema` → compiled as a JSON Schema (is it well-formed?);
 *  - `state` / `data` → any JSON (structural only).
 *
 * Every result is `{ valid, kind, total, errors: [{ code, message,
 * docPath }] }` — the shape the IDE's docked error strip reads.
 */

import { createWeakCache } from '@jarenjs/core/cache';
import { JarenValidator } from '@jarenjs/validate';
import { createTypeTestCompiler } from '@jarenjs/validate/query';
import { compileJsonQuery } from '@jarenjs/json';
import {
  compileJsltStylesheet, createJsltRegistry, mathPack, financePack, statsPack,
} from '@jarenjs/json/jslt';

import appSchema from '@jarenjs/app/schemas/jaren-app.schema.json' with { type: 'json' };
import querySchema from '@jarenjs/json/schemas/jaren-query.schema.json' with { type: 'json' };
import jsltSchema from '@jarenjs/json/schemas/jaren-jslt.schema.json' with { type: 'json' };
import fsmSchema from '@jarenjs/flow/schemas/jaren-fsm.schema.json' with { type: 'json' };
import dagSchema from '@jarenjs/flow/schemas/jaren-dag.schema.json' with { type: 'json' };
import modelSchema from '@jarenjs/db/schemas/jaren-model.schema.json' with { type: 'json' };

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

/** Normalize a JarenValidator failure into the studio error shape. */
function schemaResult(kind, outcome) {
  const valid = typeof outcome === 'object' && outcome !== null ? outcome.valid : outcome === true;
  if (valid) return ok(kind);
  const raw = (typeof outcome === 'object' && outcome !== null ? outcome.errors : null) ?? [];
  return {
    valid: false, kind, total: raw.length,
    errors: raw.slice(0, MAX_ERRORS).map((e) => ({
      code: null, message: e.message ?? 'invalid', docPath: e.instancePath ?? '',
    })),
  };
}

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
 * broken document even when the meta-schema passed it.
 * @param {any} doc
 */
function auditAppView(doc) {
  try {
    compileJsltStylesheet(doc.view, { compileTypeTest, memo: false, ...defaultRegistryOptions })(doc.state ?? {});
    return null;
  }
  catch (err) {
    return `the view failed to render its first frame: ${String(/** @type {any} */ (err)?.message ?? err)}`;
  }
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
 *   errors: Array<{ code: string | null, message: string, docPath?: string }> }}
 */
export function validateFile(file, options = {}) {
  if (file === null || typeof file !== 'object') return validateFileUncached(file, options);
  const byRegistry = verdicts.getOrCreate(file, () => new Map());
  const registryKey = options.operators ?? null;
  let verdict = byRegistry.get(registryKey);
  if (verdict === undefined) {
    verdict = validateFileUncached(file, options);
    byRegistry.set(registryKey, verdict);
  }
  return verdict;
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
      const structural = schemaResult(kind, validateApp(doc));
      if (!structural.valid) return structural;
      const problem = auditAppView(doc);
      return problem === null
        ? structural
        : { valid: false, kind, total: 1, errors: [{ code: null, message: problem, docPath: '/view' }] };
    }
    case 'jslt':
      return compileResult(kind, () => compileJsltStylesheet(doc, { compileTypeTest, ...registryOptions }));
    case 'query':
      return compileResult(kind, () => compileJsonQuery(doc, { compileTypeTest, ...registryOptions }));
    case 'fsm':
      return schemaResult(kind, validateFsm(doc));
    case 'dag':
      return schemaResult(kind, validateDag(doc));
    case 'model':
      return schemaResult(kind, validateModel(doc));
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
