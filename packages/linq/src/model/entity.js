//@ts-check
/**
 * @file The `x-entity` vocabulary as builder methods: one mixin,
 * `withEntity(Base)`, applied to every schema-pen class at module
 * scope, so `./model` is a set of NEW classes (never a patched
 * prototype) whose every builder can be a key, an index, a column
 * override, a store-written default or a version token. The methods
 * write into the one `x-entity` annotation; what the store does with
 * it is MODEL-FORMAT §9's business, and the pen refuses only what the
 * store's own model walk would refuse and the builder can already see
 * — `identity('auto')` off an integer, `identity('uuid')` off a string,
 * `column('integer')` off a date — with `JL0102` naming the rule.
 */

import { LinqBuildError } from '../errors.js';
import { requireJson, requireName } from '../schema/builders.js';
import { captureQuery } from '../schema/check.js';

/** The keyword every entity method writes. */
const KEYWORD = 'x-entity';

/** The two storage overrides MODEL-FORMAT §9.2 names. */
const COLUMNS = new Set(['integer', 'json']);

/** Whether a builder is a string with a date or date-time format. */
function isDateString(builder) {
  const st = builder.state;
  return st.kind === 'string'
    && (st.keywords.format === 'date-time' || st.keywords.format === 'date');
}

/**
 * The mixin: a subclass of `Base` carrying the entity methods.
 * @template {new (state: any) => any} B
 * @param {B} Base - a schema-pen builder class
 * @returns {B} a new class, `Base` plus the vocabulary
 */
export function withEntity(Base) {
  return class extends Base {
    /**
     * Merge into the `x-entity` block, keeping the order members were
     * first set in.
     * @param {Record<string, any>} patch
     * @returns {this}
     */
    entity(patch) {
      const current = this.annotation(KEYWORD) ?? {};
      return this.annotate(KEYWORD, Object.freeze({ ...current, ...patch }));
    }

    /** `key: true` — (part of) the primary key. */
    key() { return this.entity({ key: true }); }
    /** `unique: true` — a unique index over the column. */
    unique() { return this.entity({ unique: true }); }
    /** `index: true` — a non-unique index over the column. */
    index() { return this.entity({ index: true }); }
    /** `version: true` — the optimistic-concurrency token. */
    version() { return this.entity({ version: true }); }

    /**
     * `column`: `'integer'` stores a date-formatted string as epoch
     * milliseconds; `'json'` keeps a scalar in the document.
     * @param {'integer' | 'json'} storage
     */
    column(storage) {
      if (!COLUMNS.has(storage)) {
        throw new LinqBuildError('JL0101',
          `column() takes 'integer' (an epoch column for a date) or 'json' (stay in the `
          + `document), got ${JSON.stringify(storage)}`);
      }
      if (storage === 'integer' && !isDateString(this)) {
        throw new LinqBuildError('JL0102',
          "column('integer') applies to a date-time or date formatted string — the epoch "
          + 'column is derived from the RFC 3339 text; spell the member datetime() or date()');
      }
      return this.entity({ column: storage });
    }

    /**
     * A store-allocated key (MODEL-FORMAT §9.5): `key: true` with
     * `default: 'uuid'` (`crypto.randomUUID()` on a single string key)
     * or `default: 'auto'` (the database allocates a single integer key).
     * @param {'uuid' | 'auto'} kind
     */
    identity(kind) {
      if (kind === 'uuid') {
        if (this.state.kind !== 'string') {
          throw new LinqBuildError('JL0102',
            `identity('uuid') allocates a single string key — the member is a ${this.state.kind}`);
        }
      }
      else if (kind === 'auto') {
        if (this.state.kind !== 'integer') {
          throw new LinqBuildError('JL0102',
            "identity('auto') is allocated by the database for a single integer key only — the "
            + `member is ${this.state.kind === 'number' ? 'a number; spell it integer()' : `a ${this.state.kind}`}`);
        }
      }
      else {
        throw new LinqBuildError('JL0101',
          `identity() takes 'uuid' or 'auto', got ${JSON.stringify(kind)}`);
      }
      return this.entity({ key: true, default: kind });
    }

    /** `default: 'now'` — an RFC 3339 stamp on insert, when absent. */
    now() { return this.entity({ default: 'now' }); }
    /** `default: 'updated'` — a stamp on insert and on every update. */
    updated() { return this.entity({ default: 'updated' }); }

    /** `default: { value }` — a literal, filled when absent. @param {any} value */
    fill(value) { return this.entity({ default: { value: requireJson(value, 'fill()') } }); }

    /**
     * `default: { query }` — evaluated over the document being written
     * (`$` is that document; no externals): a captured callback, or a
     * query document verbatim.
     * @param {((doc: any, externals: any) => any) | object} rule
     */
    compute(rule) {
      const query = typeof rule === 'function'
        ? captureQuery('compute()', [], rule)
        : requireJson(rule, 'compute()');
      return this.entity({ default: { query } });
    }

    /**
     * `x-rename`: this entity was previously named `name` (a migration
     * hint the planner reads; lifted onto the entity declaration by
     * `defineModel`). @param {string} name
     */
    renamedFrom(name) { return this.with({ renamedFrom: requireName(name, 'renamedFrom()') }); }

    /** As in the schema pen, but `x-entity` is owned here. @param {Record<string, any>} annotations */
    meta(annotations) {
      if (annotations !== null && typeof annotations === 'object' && KEYWORD in annotations) {
        throw new LinqBuildError('JL0104',
          `meta() cannot write '${KEYWORD}' — the model pen owns that keyword; spell it `
          + 'through key(), identity(), unique(), index(), column(), now(), updated(), '
          + 'fill(), compute() or rel.*');
      }
      return super.meta(annotations);
    }
  };
}
