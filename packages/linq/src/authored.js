//@ts-check
/** Immutable JSON document storage shared by the authored-format pens. */
import { cloneJson, deepFreeze } from '@jarenjs/core/object';
import { requireJson, requireNameMap } from './json-boundary.js';
import { LinqBuildError } from './errors.js';

/** A snapshot, never a view of a caller-owned document. @param {any} value */
export function snapshot(value) {
  return deepFreeze(cloneJson(requireJson(value, 'document')));
}

/** The closed option boundary; extensions enter through the raw document factory. */
export function optionsOf(value, keys, what) {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new LinqBuildError('JL0101', `${what} takes a plain object`);
  requireNameMap(value, what);
  for (const key of Object.keys(value)) {
    if (!keys.includes(key))
      throw new LinqBuildError('JL0101', `${what} does not take '${key}' — use from() for a raw document`);
  }
  return snapshot(value);
}

/** A standard document with fluent, immutable replacement. */
export class DocumentBuilder {
  #schema;
  /** @param {any} document */
  constructor(document) { this.#schema = snapshot(document); }
  /** The public document, deeply frozen. */
  get schema() { return this.#schema; }
  /** JSON serialization is exactly the public document. */
  toJSON() { return this.#schema; }
  /** Replace members without changing the original builder. @param {object} patch */
  with(patch) {
    const Kind = /** @type {any} */ (this.constructor);
    return new Kind({ ...this.#schema, ...patch });
  }
}
