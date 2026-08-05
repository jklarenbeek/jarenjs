//@ts-check
/**
 * @file The JSLT operator/aggregator registry (TODO_OPS Ring 1): the
 * `@jarenjs/formats` + `JarenValidator.addFormats` experience for the
 * query/JSLT vocabulary. A caller composes packs of pure functions
 * (`@jarenjs/core` math, finance, statistics) into a registry and gets
 * a compiler bound to them — the operators then work in JSLT, in the
 * query engine, and in linq-over-memory (which compiles to query
 * documents).
 *
 * The mechanism is the engine's existing `options.extensions` seam (the
 * same one the JSLT layer uses internally for `$apply`) plus
 * `options.functions` (the `$call` registry). This file only TRANSLATES
 * plain-data pack entries into those two shapes and holds them in an
 * immutable-by-copy builder — so a pack never imports the operator ABI,
 * exactly the decoupling `@jarenjs/formats` has from `@jarenjs/validate`.
 *
 * Entry kinds (TODO_OPS): `op` (scalar `$`-operator over scalar
 * operands), `agg` (an operator whose declared `seq` operands are folded
 * to arrays before the call — the generalization of core `$sum`'s fold),
 * and `fn` (a bare `$call` function, the low-level escape). The published
 * closed vocabulary is unchanged: without a registry a document using a
 * pack operator fails `JQ0002` exactly as before.
 */

import { EMPTY, Seq, seqOf, firstItem } from '../query/runtime.js';
import { CARD_OPT, CARD_MANY, isReservedQueryName } from '../query/normalize.js';
import { JsonQueryRuntimeError } from '../query/errors.js';
import { compileJsonQuery } from '../query/index.js';
import { compileJsltStylesheet } from './index.js';

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const RESULT_OPT = () => CARD_OPT;
const RESULT_MANY = () => CARD_MANY;
const RT_NUMBER = () => 'number';

/** Normalize an operand-kind token to `'seq'` or `'scalar'`. */
function operandKind(token) {
  return typeof token === 'string' && token.startsWith('seq') ? 'seq' : 'scalar';
}

/**
 * Translate one pack entry into an `options.extensions` operator entry
 * (the shape `query/operators.js` uses). The compile gathers each `seq`
 * operand into a JS array (`EMPTY`→`[]`, a lone value→`[value]`, a
 * `Seq`→its items) and reads each scalar operand as a single value
 * (`EMPTY` propagates to an empty result), calls the pure function, and
 * wraps the result — a scalar as one item, an array under a `seq` result
 * as a `Seq`. A throwing function becomes the coded runtime error
 * `JQ2010`, never a crash.
 * @param {string} name
 * @param {{ signature: string[], result: string, fn: Function }} entry
 */
function toExtensionEntry(name, entry) {
  const sig = entry.signature.map(operandKind);
  const arity = sig.length;
  const seqResult = operandKind(entry.result) === 'seq';
  const fn = entry.fn;
  const params = arity === 1
    ? 'expr'
    : { kinds: new Array(arity).fill('expr'), min: arity };
  return {
    params,
    result: seqResult ? RESULT_MANY : RESULT_OPT,
    resultType: RT_NUMBER,
    compile: (gets, args, docPath) => (f) => {
      const call = new Array(arity);
      for (let i = 0; i < arity; i++) {
        const v = gets[i](f);
        if (sig[i] === 'seq') {
          call[i] = v === EMPTY ? [] : v instanceof Seq ? v.items.slice() : [v];
        }
        else {
          if (v === EMPTY) return EMPTY; // a missing scalar operand → empty result
          call[i] = v instanceof Seq ? firstItem(v) : v;
        }
      }
      let out;
      try {
        out = fn(...call);
      }
      catch (err) {
        throw new JsonQueryRuntimeError('JQ2010',
          `registered operator '${name}' failed: ${err?.message ?? String(err)}`,
          docPath);
      }
      if (seqResult) {
        if (!Array.isArray(out)) return out === undefined || out === null ? EMPTY : out;
        return out.length === 0 ? EMPTY : seqOf(out);
      }
      return out === undefined ? EMPTY : out;
    },
  };
}

/** Validate a pack's shape (host programming error → TypeError). */
function validatePack(pack) {
  if (pack === null || typeof pack !== 'object'
    || typeof pack.name !== 'string' || pack.name === ''
    || pack.entries === null || typeof pack.entries !== 'object') {
    throw new TypeError('a pack must be { name: string, entries: object }');
  }
  for (const [name, entry] of Object.entries(pack.entries)) {
    if (entry === null || typeof entry !== 'object' || typeof entry.fn !== 'function') {
      throw new TypeError(`pack '${pack.name}' entry '${name}' must carry a function 'fn'`);
    }
    const kind = entry.kind ?? (entry.signature?.some((s) => operandKind(s) === 'seq') ? 'agg' : 'op');
    if (kind !== 'fn') {
      if (name.charCodeAt(0) !== 0x24) {
        throw new TypeError(`pack '${pack.name}' operator '${name}' must start with '$'`);
      }
      if (!Array.isArray(entry.signature) || entry.signature.length === 0) {
        throw new TypeError(`pack '${pack.name}' operator '${name}' needs a non-empty signature`);
      }
    }
  }
}

/**
 * Build an immutable JSLT operator registry. `.use(pack)` returns a NEW
 * registry with the pack merged (a value, not a mutable singleton, so
 * the functional spirit of the compilers is preserved). A name that
 * collides with the core vocabulary, or with an already-registered name,
 * throws a `TypeError` at `.use()` time — a host programming error, never
 * a `JQ` document error.
 * @param {{ extensions: Record<string, any>, functions: Record<string, Function>,
 *   meta: Record<string, any>, packs: string[] }} [state]
 */
export function createJsltRegistry(state) {
  const base = state ?? { extensions: {}, functions: {}, meta: {}, packs: [] };

  const use = (pack) => {
    validatePack(pack);
    const extensions = { ...base.extensions };
    const functions = { ...base.functions };
    const meta = { ...base.meta };
    for (const [name, entry] of Object.entries(pack.entries)) {
      if (hasOwn(extensions, name) || hasOwn(functions, name)) {
        throw new TypeError(`operator '${name}' is already registered (pack '${pack.name}')`);
      }
      const kind = entry.kind
        ?? (entry.signature?.some((s) => operandKind(s) === 'seq') ? 'agg' : 'op');
      if (kind === 'fn') {
        functions[name] = entry.fn;
      }
      else {
        if (isReservedQueryName(name)) {
          throw new TypeError(`operator '${name}' collides with the core vocabulary`);
        }
        extensions[name] = toExtensionEntry(name, entry);
      }
      meta[name] = {
        pack: pack.name, kind,
        signature: entry.signature ?? null, result: entry.result ?? null,
        pushable: entry.pushable ?? false, fn: entry.fn,
      };
    }
    return createJsltRegistry({
      extensions, functions, meta, packs: [...base.packs, pack.name],
    });
  };

  // frozen once per registry instance, so identity-based compile caching
  // (jslt/index.js cachedTransform) hits across calls with the same
  // registry; only a caller's OWN extensions/functions force a fresh
  // merged object.
  const frozenExtensions = Object.freeze({ ...base.extensions });
  const frozenFunctions = Object.freeze({ ...base.functions });

  /** The `{ extensions, functions }` a compile call needs, merged over a
   * caller's own options — the stable frozen objects when the caller
   * added none (the common case). */
  const mergedOptions = (opts) => {
    const userExt = opts?.extensions && Object.keys(opts.extensions).length > 0;
    const userFns = opts?.functions && Object.keys(opts.functions).length > 0;
    return {
      ...opts,
      extensions: userExt ? { ...opts.extensions, ...base.extensions } : frozenExtensions,
      functions: userFns ? { ...opts.functions, ...base.functions } : frozenFunctions,
    };
  };

  return Object.freeze({
    use,
    /** Every registered operator/function name (for docs, AI, errors). */
    names: () => [...Object.keys(base.extensions), ...Object.keys(base.functions)],
    /** The raw `{ extensions, functions }` for a manual compile call. */
    toOptions: () => ({ extensions: { ...base.extensions }, functions: { ...base.functions } }),
    /** The SQL-pushable subset, as `{ name -> meta }` (consumed by the db
     * in Rings 2–3; here it is just the data). */
    forSql: () => Object.fromEntries(
      Object.entries(base.meta).filter(([, m]) => m.pushable !== false)),
    /** The full registration metadata (Rings 2–3, tooling). */
    describe: () => ({ ...base.meta }),
    /** Compile a JSLT stylesheet bound to this registry. */
    compile: (stylesheet, opts) => compileJsltStylesheet(stylesheet, mergedOptions(opts)),
    /** Compile a bare query document bound to this registry (linq-over-memory). */
    compileQuery: (document, opts) => compileJsonQuery(document, mergedOptions(opts)),
  });
}
