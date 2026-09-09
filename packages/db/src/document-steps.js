//@ts-check
/**
 * @file The document-step kernel: what a migration's `jslt` transform
 * and `query` assertion steps MEAN, written once for every host that
 * owns documents — the Store's tables and an in-memory or streamed
 * collection alike.
 *
 * A host supplies the compilers and the key members a row carries; the
 * kernel owns the semantics: what a transform may produce, which key
 * members it may not move, whether an assertion answers per document
 * or needs the collection whole, and the exact refusal each violation
 * raises. Iteration stays the host's — a Store walks its table in
 * keyset batches under a savepoint per step, a storeless run makes one
 * pass over a source it can read only once. Sharing the meaning and
 * not the loop is what lets the two hosts differ in cost without ever
 * differing in answer.
 */

import { analyzeQuery, createQueryAccumulator } from '@jarenjs/json/query';
import { DbCompileError, DbRuntimeError } from './errors.js';
import { utf8Length } from './cursor.js';

/** The migration format version. */
export const MIGRATION_VERSION = '0.1';

/**
 * The step kinds that act on DOCUMENTS, and so run on any host.
 * @type {ReadonlySet<string>}
 */
export const DOCUMENT_STEP_KINDS = new Set(['jslt', 'query']);

/**
 * The step kinds that act on a PHYSICAL database — rendered DDL, a
 * data statement spelled as SQL, the table-rebuild procedure, and the
 * backfill that recomputes stored derived COLUMNS. A host without
 * tables cannot honour any of them, and silently skipping one would
 * leave a migration half-applied, so it refuses instead.
 * @type {ReadonlySet<string>}
 */
export const PHYSICAL_STEP_KINDS = new Set(['ddl', 'sql', 'rebuild', 'derive']);

/**
 * The refusal a failing step raises, spelled the one way — a reader
 * who has seen it from a Store recognises it from a file.
 * @param {string} migrationId
 * @param {number} index
 * @param {string} kind
 * @param {string} reason
 * @param {Error} [cause]
 * @returns {DbCompileError}
 */
export function stepFailure(migrationId, index, kind, reason, cause) {
  return new DbCompileError('JD0023',
    `migration '${migrationId}' step ${index} (${kind}) failed: ${reason}`,
    undefined, cause);
}

/** A path with no filter capable of reading the collection root. */
function localPath(path) {
  return path.segments.every((segment) => !segment.descendant
    && segment.selectors.every((selector) => ['name', 'index', 'wildcard'].includes(selector.kind)));
}

/** Every item of this root scan belongs to exactly one input document. */
function rootScan(node) {
  return node?.kind === 'path' && node.rootSlot === 0 && localPath(node)
    && node.segments[0]?.selectors.length === 1
    && node.segments[0].selectors[0].kind === 'wildcard';
}

/** Expressions local to one binding; global/root and positional reads refuse. */
function bindingLocal(node, slot) {
  if (node === null || typeof node !== 'object') return true;
  if (node.kind === 'literal' || node.kind === 'raw') return true;
  if (node.kind === 'var') return node.slot === slot && !node.external;
  if (node.kind === 'path') return node.rootSlot === slot && localPath(node);
  if (node.kind === 'flwor' || node.kind === 'call') return false;
  return Object.values(node).every((value) => Array.isArray(value)
    ? value.every((item) => bindingLocal(item, slot)) : bindingLocal(value, slot));
}

/** A single unwindowed root binding whose body cannot observe other rows. */
function independentPhrase(node) {
  if (node?.kind !== 'flwor' || node.forBindings.length !== 1
    || node.letBindings.length > 0 || node.groupby || node.orderby || node.count
    || node.fold || node.limits || node.asChecks) return false;
  const binding = node.forBindings[0];
  return rootScan(binding.expr) && binding.atSlot < 0 && !binding.allowingEmpty
    && !binding.window && bindingLocal(node.where, binding.slot) && bindingLocal(node.ret, binding.slot);
}

/** Invalid/unknown documents conservatively retain their materializing classification. */
function assertionAst(query) {
  try { return analyzeQuery(query).root; }
  catch { return null; }
}

/** Whether a query's result is a concatenation of independent per-row results. */
export function isPerDocumentAssertion(query) {
  return independentPhrase(assertionAst(query));
}

/**
 * Classify before execution. Folds consume operand ITEMS in their original
 * order; addition is never regrouped into partition totals. Distinct folds
 * require an explicit cardinality bound. EBV applies to the complete sequence.
 * @param {any} query
 * @param {{ expect?: string, maxDistinct?: number }} [options]
 * @returns {{ strategy: 'perDocument'|'fold'|'materialize', shape: string|null, reason: string }}
 */
export function classifyAssertion(query, options = {}) {
  const ast = assertionAst(query);
  if (independentPhrase(ast)) return options.expect === 'ebv'
    ? { strategy: 'fold', shape: '$ebv', reason: 'sequence EBV retains at most two items across all batches' }
    : { strategy: 'perDocument', shape: null, reason: 'an independent predicate over each document' };
  if (ast?.kind === 'op' && Object.keys(query).length === 1 && Object.hasOwn(query, ast.name) && ['$count', '$sum', '$avg', '$min', '$max', '$distinct'].includes(ast.name)
    && (rootScan(ast.args[0]) || independentPhrase(ast.args[0]))
    && (ast.name !== '$distinct' || Number.isSafeInteger(options.maxDistinct) && options.maxDistinct > 0)) {
    return { strategy: 'fold', shape: ast.name,
      reason: ast.name === '$distinct' ? 'distinct items are retained under an explicit cardinality bound'
        : 'the operand is partition-independent and items accumulate in original order' };
  }
  return { strategy: 'materialize', shape: null,
    reason: 'the assertion may observe the whole root or position, so every document must be held under declared bounds' };
}

/**
 * Compile one document step into the operation both hosts run.
 *
 * A `jslt` step answers `{ apply }`: one document in, its replacement
 * out, refusing a non-document and any move of a declared key member.
 * A `query` step answers `{ assert, perDocument }`: `assert` takes the
 * documents the host has in hand — every document of the collection
 * when `perDocument` is false, any batch of them when it is true.
 *
 * @param {any} step - the migration step
 * @param {number} index - its position, which its refusals name
 * @param {{
 *   migrationId: string,
 *   compileJslt: (stylesheet: any) => (document: any) => any,
 *   compileQuery: (query: any) => any,
 *   keys?: string[],
 *   assertionBounds?: { maxRows: number | null, maxBytes: number | null, maxDistinct?: number },
 * }} context - the host's compilers and the key members a document of
 *   this collection carries, which a transform may not move
 * @returns {any} the compiled operation
 */
export function compileDocumentStep(step, index, context) {
  const { migrationId, compileJslt, compileQuery } = context;
  const keys = context.keys ?? [];
  /** @type {(reason: string, cause?: Error) => never} */
  const fail = (reason, cause) => {
    throw stepFailure(migrationId, index, step.kind, reason, cause);
  };

  if (step.kind === 'jslt') {
    let transform;
    try {
      transform = compileJslt(step.stylesheet);
    }
    catch (cause) {
      fail(`the stylesheet does not compile: ${/** @type {Error} */ (cause).message}`,
        /** @type {Error} */ (cause));
    }
    return {
      kind: 'jslt',
      collection: step.collection,
      // a transform has no assertion strategy and nothing to fold; both
      // are spelled so every host can read an operation the same way
      strategy: null,
      shape: null,
      fold: null,
      fail,
      /**
       * @param {any} document - read whole, mapped columns folded in
       * @param {any} identity - the host's name for this row, which a
       *   refusal quotes so the operator can find it
       * @returns {any} the replacement document
       */
      apply: (document, identity) => {
        const next = transform(document);
        if (next === null || typeof next !== 'object' || Array.isArray(next))
          fail(`the transform produced a non-document for row ${identity}`);
        // the key is the row's identity, not the document's to change:
        // a body that leaves it out keeps it, a body that rewrites it
        // is refused, as a collection's key is
        for (const key of keys) {
          if (next[key] === undefined) next[key] = document[key];
          else if (next[key] !== document[key]) {
            fail(`the transform changed the key member '${key}' of row ${identity} — `
              + `key changes are not supported in ${MIGRATION_VERSION}`);
          }
        }
        return next;
      },
    };
  }

  let compiled;
  try {
    compiled = compileQuery(step.assert);
  }
  catch (cause) {
    fail(`the assertion does not compile: ${/** @type {Error} */ (cause).message}`,
      /** @type {Error} */ (cause));
  }
  const classification = classifyAssertion(step.assert, { expect: step.expect,
    maxDistinct: context.assertionBounds?.maxDistinct });
  const operand = classification.shape === '$ebv' ? step.assert
    : classification.shape === null ? null : step.assert[classification.shape];
  const items = classification.strategy === 'fold' ? compileQuery(operand) : null;
  const scalar = compileQuery('$');

  /** The verdict on a computed result, whichever way it was computed. */
  const check = (result, ebvOf) => {
    if (step.expect === 'ebv') {
      if (!ebvOf()) fail('the EBV assertion answered false');
      return null;
    }
    if (result !== undefined) {
      const count = Array.isArray(result) ? result.length : 1;
      fail(`the assertion expected an empty sequence, got ${count} item(s)`);
    }
    return null;
  };

  return {
    kind: 'query',
    collection: step.collection,
    plan: { migration: migrationId, step: index, collection: step.collection, ...classification,
      bounds: classification.strategy === 'materialize' || classification.shape === '$distinct'
        ? context.assertionBounds ?? ASSERTION_BOUNDS_DEFAULT : null },
    accept: (value) => check(value, () => scalar.ebv(value)),
    perDocument: classification.strategy === 'perDocument',
    strategy: classification.strategy,
    shape: classification.shape,
    reason: classification.reason,
    fail,
    /**
     * The whole-collection answer: every document at once, which is what
     * `perDocument` batches and `materialize` holds.
     * @param {any[]} documents
     * @returns {null}
     */
    assert: (documents) => check(compiled(documents), () => compiled.ebv(documents)),
    /**
     * The same answer, one batch at a time. `start` is the aggregate's
     * initial state, `combine` adds the operand's items in row order,
     * and `finish` applies the step's own
     * verdict to the total — the same verdict `assert` applies.
     * Null when this assertion does not fold.
     */
    fold: classification.strategy !== 'fold' ? null : {
      start: () => {
        const bounds = context.assertionBounds;
        const guard = classification.shape === '$distinct' ? createAssertionBoundGuard({
          maxRows: bounds.maxDistinct, maxBytes: bounds.maxBytes,
        }, step.collection, `distinct items of migration '${migrationId}' step ${index}`) : null;
        return createQueryAccumulator(classification.shape, {
          docPath: `/${classification.shape}`,
          ...(guard === null ? {} : { admit: (item) => guard.admit(item) }),
        });
      },
      combine: (state, documents) => {
        for (const item of items.items(documents)) state.add(item);
        return state;
      },
      value: (state) => state.value(),
      finish: (state) => check(state.value(), state.ebv),
    },
  };
}

const STEP_KINDS = new Set(['ddl', 'jslt', 'query', 'sql', 'rebuild', 'derive']);

/**
 * Structural validation of one migration document, including the
 * draft refusal (`JD0021`).
 * @param {any} migration
 */
export function checkMigrationDocument(migration) {
  if (migration === null || typeof migration !== 'object'
    || migration.$migration !== MIGRATION_VERSION
    || typeof migration.id !== 'string' || migration.id === ''
    || typeof migration.from !== 'string' || typeof migration.to !== 'string'
    || !Array.isArray(migration.steps)) {
    throw new DbCompileError('JD0023',
      `migration '${migration?.id ?? '<unknown>'}' is not a valid ${MIGRATION_VERSION} migration document`);
  }
  for (let i = 0; i < migration.steps.length; i++) {
    const step = migration.steps[i];
    if (step === null || typeof step !== 'object' || !STEP_KINDS.has(step.kind)) {
      throw new DbCompileError('JD0023',
        `migration '${migration.id}' step ${i} has no recognised kind`);
    }
    if (step.kind === 'rebuild'
      && (typeof step.table !== 'string' || !Array.isArray(step.create)
        || typeof step.copy !== 'string' || !Array.isArray(step.indexes))) {
      throw new DbCompileError('JD0023',
        `migration '${migration.id}' step ${i} is a rebuild without its rendered `
        + 'table/create/copy/indexes');
    }
    if (step.kind === 'sql' && typeof step.sql !== 'string') {
      throw new DbCompileError('JD0023',
        `migration '${migration.id}' step ${i} is a sql step without sql text`);
    }
    if (step.kind === 'derive'
      && (typeof step.collection !== 'string' || !Array.isArray(step.columns)
        || step.columns.length === 0)) {
      throw new DbCompileError('JD0023',
        `migration '${migration.id}' step ${i} is a derive backfill without its columns`);
    }
    if (step.kind === 'jslt' && step.draft === true) {
      throw new DbCompileError('JD0021',
        `migration '${migration.id}' step ${i} is a DRAFT transform for collection `
        + `'${step.collection}' — the planner cannot infer a data transform; fill in `
        + 'the stylesheet (or delete the step for a pure widening) and remove "draft"');
    }
  }
}

/**
 * What a MATERIALIZING assertion — one that is neither a per-document
 * predicate nor a supported ordered fold — is allowed to hold.
 *
 * The defaults are deliberately generous and deliberately finite: a
 * migration that used to read a large collection whole now refuses
 * instead, naming the bound and the two assertion shapes that are
 * answered in batches. An unbounded read that nobody declared is the
 * thing this campaign exists to remove, so `null` must be asked for.
 */
export const ASSERTION_BOUNDS_DEFAULT = Object.freeze({
  maxRows: 100_000,
  maxBytes: 64 * 1024 * 1024,
});

/** The declared bounds, or the defaults; `null` means no bound. */
export function normalizeAssertionBounds(declared) {
  if (declared === undefined) return ASSERTION_BOUNDS_DEFAULT;
  if (declared === null || typeof declared !== 'object')
    throw new TypeError('assertionBounds must be an object of { maxRows, maxBytes }');
  const read = (name) => {
    const value = declared[name];
    if (value === undefined) return ASSERTION_BOUNDS_DEFAULT[name];
    if (value === null || value === Infinity) return null;
    if (!(Number.isSafeInteger(value) && value >= 1))
      throw new TypeError(`assertionBounds.${name} must be a positive integer, or null for no bound`);
    return value;
  };
  if (declared.maxDistinct !== undefined
    && (!Number.isSafeInteger(declared.maxDistinct) || declared.maxDistinct < 1))
    throw new TypeError('assertionBounds.maxDistinct must be a positive integer');
  return Object.freeze({ maxRows: read('maxRows'), maxBytes: read('maxBytes'),
    ...(declared.maxDistinct === undefined ? {} : { maxDistinct: declared.maxDistinct }) });
}

/**
 * The guard a MATERIALIZING assertion admits its documents through.
 *
 * One rule, one wording, for every host: a Store admits row by row as it
 * walks, an array host admits the array it was handed. Either way the
 * bound is crossed at the document that would break it, and never after
 * the excess is already held.
 *
 * @param {{ maxRows: number | null, maxBytes: number | null }} bounds
 * @param {string} collection - named by the refusal
 * @param {string} where - what is asserting, as the refusal should say it
 * @returns {{ admit: (document: any, serialized?: string) => void }}
 */
export function createAssertionBoundGuard(bounds, collection, where) {
  let rows = 0;
  let bytes = 0;
  const advice = 'Raise the bound, or write the assertion as a per-document predicate or a '
    + 'single aggregate over the root, which are answered one batch at a time';
  return {
    admit: (document, serialized) => {
      if (bounds.maxRows !== null && rows + 1 > bounds.maxRows) {
        throw new DbRuntimeError('JD2007',
          `${where} must hold every document of '${collection}' at once, and the collection `
          + `crossed its maxRows bound of ${bounds.maxRows}. ${advice}`,
          { collection });
      }
      rows++;
      if (bounds.maxBytes === null) return;
      const size = utf8Length(serialized ?? JSON.stringify(document));
      if (bytes + size > bounds.maxBytes) {
        throw new DbRuntimeError('JD2076',
          `${where} must hold every document of '${collection}' at once; the document that `
          + `would make ${bytes + size} serialised bytes crosses its maxBytes bound of `
          + `${bounds.maxBytes}. ${advice}`,
          { collection });
      }
      bytes += size;
    },
  };
}
