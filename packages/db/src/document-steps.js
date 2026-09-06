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

/**
 * Whether an assertion is a PER-DOCUMENT predicate — a FLWOR over the
 * collection's documents whose `$where` and `$return` read only the
 * binding — so evaluating it over each batch of documents answers
 * exactly what evaluating it over the whole collection would. Anything
 * that reads the root (`$count: '$[*]'`, a `$let`, a `$distinct`, a
 * nested `$for`) is cross-document and keeps its whole-collection read.
 * @param {any} query
 * @returns {boolean}
 */
export function isPerDocumentAssertion(query) {
  if (query === null || typeof query !== 'object' || Array.isArray(query)) return false;
  const keys = Object.keys(query);
  if (!keys.includes('$for') || !keys.includes('$return')
    || keys.some((key) => !['$for', '$where', '$return'].includes(key))) return false;
  const bindings = query.$for;
  if (bindings === null || typeof bindings !== 'object' || Array.isArray(bindings)) return false;
  const names = Object.keys(bindings);
  if (names.length !== 1 || bindings[names[0]] !== '$[*]') return false;
  // a root reference anywhere in the body is a cross-document read
  const body = JSON.stringify({ $where: query.$where ?? null, $return: query.$return });
  return !/"\$(?:[[.]|")/.test(body.replace(/"\$[A-Za-z_][A-Za-z0-9_]*/g, '"'));
}

/**
 * The aggregate shapes whose answer over a whole collection is the
 * COMBINATION of its answers over any partition of that collection —
 * which is what lets a host compute them one batch at a time and never
 * hold the collection.
 *
 * Each entry says only how two partial answers combine. What the
 * operator MEANS over a batch — its null handling, its empty-sequence
 * answer, its type coercions — is the engine's, because every batch is
 * answered by the engine's own compiled query. Nothing here reimplements
 * an operator; a fold that disagreed with the engine on any input would
 * be caught by the parity suite, which runs every shape both ways.
 *
 * `$distinct` is here only under an explicit cardinality bound: its
 * partial answer grows with the data, so without one it is not a fold
 * at all.
 * @type {Record<string, { start: any, combine: (accumulated: any, partial: any) => any,
 *   growing?: boolean }>}
 */
const ASSOCIATIVE_AGGREGATES = {
  // fn:count of a partition sums; the empty collection answers 0
  $count: { start: 0, combine: (accumulated, partial) => accumulated + (partial ?? 0) },
  // fn:sum of the empty sequence is 0, so the identity is 0
  $sum: { start: 0, combine: (accumulated, partial) => accumulated + (partial ?? 0) },
  // fn:min/fn:max of the empty sequence is the empty sequence, so the
  // identity is `undefined` and a partial that is empty contributes
  // nothing
  $max: {
    start: undefined,
    combine: (accumulated, partial) => (partial === undefined ? accumulated
      : (accumulated === undefined || partial > accumulated ? partial : accumulated)),
  },
  $min: {
    start: undefined,
    combine: (accumulated, partial) => (partial === undefined ? accumulated
      : (accumulated === undefined || partial < accumulated ? partial : accumulated)),
  },
};

/** An assertion that is exactly one aggregate over the root. */
function aggregateShapeOf(query) {
  if (query === null || typeof query !== 'object' || Array.isArray(query)) return null;
  const keys = Object.keys(query);
  if (keys.length !== 1) return null;
  const operator = keys[0];
  return Object.hasOwn(ASSOCIATIVE_AGGREGATES, operator) ? operator : null;
}

/**
 * How a host must run an assertion, and why.
 *
 * - `perDocument` — its answer over each batch is its answer over the
 *   whole, so it walks in batches and fails at the first that violates.
 * - `fold` — it is one associative aggregate over the root, so each
 *   batch is answered by the engine and the partial answers combine.
 * - `materialize` — nothing above holds: it needs every document at
 *   once, which is a cost the host must be told about and bound.
 *
 * The one classifier every host shares, so the Store and a file cannot
 * disagree about what an assertion costs.
 * @param {any} query
 * @returns {{ strategy: 'perDocument' | 'fold' | 'materialize', shape: string | null, reason: string }}
 */
export function classifyAssertion(query) {
  if (isPerDocumentAssertion(query)) {
    return {
      strategy: 'perDocument',
      shape: null,
      reason: 'a predicate over each document, whose answer per batch is its answer over the whole',
    };
  }
  const aggregate = aggregateShapeOf(query);
  if (aggregate !== null) {
    return {
      strategy: 'fold',
      shape: aggregate,
      reason: `${aggregate} over the root is associative, so batch answers combine`,
    };
  }
  return {
    strategy: 'materialize',
    shape: null,
    reason: 'the assertion reads the whole root in a way that does not decompose '
      + 'into independent batches, so every document must be held at once',
  };
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
  const classification = classifyAssertion(step.assert);
  // the engine's own effective-boolean-value, reached through a query
  // that answers its input unchanged: a fold checks the value it
  // computed with exactly the rule the whole-collection path uses
  const identity = compileQuery('$');
  // and the engine's verdict on the EMPTY SEQUENCE, which `$max`/`$min`
  // answer over a collection that offered them nothing. It cannot be
  // asked of `identity` — a query's input may not be `undefined` — so it
  // is evaluated once, by the engine, over a wildcard that selects
  // nothing. The fold never decides this itself.
  const emptySequenceEbv = compileQuery('$[*]').ebv([]);

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
     * identity, `combine` folds the engine's answer for a batch into
     * what earlier batches answered, and `finish` applies the step's own
     * verdict to the total — the same verdict `assert` applies.
     * Null when this assertion does not fold.
     */
    fold: classification.strategy !== 'fold' ? null : {
      start: () => ASSOCIATIVE_AGGREGATES[/** @type {string} */ (classification.shape)].start,
      combine: (accumulated, documents) => ASSOCIATIVE_AGGREGATES[
        /** @type {string} */ (classification.shape)].combine(accumulated, compiled(documents)),
      finish: (accumulated) => check(accumulated,
        () => (accumulated === undefined ? emptySequenceEbv : identity.ebv(accumulated))),
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
 * predicate nor a single associative aggregate — is allowed to hold.
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
  return Object.freeze({ maxRows: read('maxRows'), maxBytes: read('maxBytes') });
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
