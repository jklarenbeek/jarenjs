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
 * `column('integer')` off a date, `key()`/`unique()`/`index()` off a
 * kind that can never hold a column, `version()` off an integer, and a
 * member outside the closed vocabulary — with `JL0102` naming the rule.
 */

import { LinqBuildError } from '../errors.js';
import { requireJson, requireName } from '../schema/builders.js';
import { captureQuery } from '../schema/check.js';

/** The keyword every entity method writes. */
const KEYWORD = 'x-entity';

/** The two storage overrides MODEL-FORMAT §9.2 names. */
const COLUMNS = new Set(['integer', 'json']);

/** The closed set MODEL-FORMAT §9.2 defines. An unknown member is the
 * store's `JD0030` — a silently ignored mapping directive loses data —
 * so `entity()` refuses it here rather than emitting it. */
const BLOCK = ['key', 'unique', 'index', 'default', 'column', 'relation', 'version'];

/**
 * Kinds that can NEVER be a column of their own: the store maps a
 * top-level scalar to a typed column and keeps everything else in the
 * JSONB document (MODEL-FORMAT §9.3), so `key`/`unique`/`index` on one
 * of these is `JD0005` at `openStore`. `raw`, `named`, `ref`, `lazy` and
 * `intersection` are NOT here: the store resolves `$ref` and merges
 * `allOf` before it reads the type, so any of them may still be a
 * scalar and the pen cannot tell.
 */
const NEVER_COLUMN = new Set([
  'object', 'record', 'array', 'tuple', 'enum', 'literal',
  'any', 'never', 'union', 'discriminated', 'when',
]);

/** Whether a builder is a string with a date or date-time format. */
function isDateString(builder) {
  const st = builder.state;
  return st.kind === 'string'
    && (st.keywords.format === 'date-time' || st.keywords.format === 'date');
}

/**
 * The mapping directives that need a column: refused on a kind the
 * store could never give one. The position is still the store's
 * question — a scalar nested inside an object takes no column either,
 * and the builder cannot see where it is placed.
 * @param {any} builder
 * @param {string} what - the method's name
 */
function requireColumnable(builder, what) {
  const kind = builder.state.kind;
  if (NEVER_COLUMN.has(kind)) {
    throw new LinqBuildError('JL0102',
      `${what}() applies to a member with a column of its own — this one's kind is `
      + `'${kind}', and only a top-level scalar (string, number, integer, boolean, null) `
      + 'is column-mapped; everything else lives in the JSON document');
  }
  return builder;
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
     * first set in. The primitive every method below writes through, and
     * the one door to a member of the vocabulary that has no method of
     * its own — held to the same closed set the store reads.
     * @param {Record<string, any>} patch
     * @returns {this}
     */
    entity(patch) {
      if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
        throw new LinqBuildError('JL0101',
          'entity() takes a plain object of x-entity members');
      }
      for (const member of Object.keys(patch)) {
        if (!BLOCK.includes(member)) {
          throw new LinqBuildError('JL0102',
            `entity() writes the closed x-entity vocabulary (${BLOCK.join(', ')}); `
            + `'${member}' is not a member of it, and the store refuses one it cannot read `
            + 'rather than ignoring it (a mapping directive that is silently dropped loses data)');
        }
      }
      const current = this.annotation(KEYWORD) ?? {};
      return this.annotate(KEYWORD, Object.freeze({ ...current, ...patch }));
    }

    /** `key: true` — (part of) the primary key. */
    key() { return requireColumnable(this, 'key').entity({ key: true }); }

    /**
     * `unique: true` — a unique index over the column. The ARRAY builder
     * already owns this name (`uniqueItems`, a validation keyword), and a
     * mixin must not change what a document asserts: where the base
     * defines it, the base wins, and an array member takes no column of
     * its own anyway.
     */
    unique() {
      return typeof super.unique === 'function'
        ? super.unique()
        : requireColumnable(this, 'unique').entity({ unique: true });
    }

    /** `index: true` — a non-unique index over the column. */
    index() { return requireColumnable(this, 'index').entity({ index: true }); }

    /**
     * `version: true` — the optimistic-concurrency token (§11.5): one
     * plain integer column per entity, engine-owned. Whether it is also
     * a key, a relation or column-mapped is a COMBINATION the store
     * judges (`JD0005`); its kind is visible here.
     */
    version() {
      if (this.state.kind !== 'integer') {
        throw new LinqBuildError('JL0102',
          'version() is the optimistic-concurrency token and lives in a plain integer '
          + `column — this member's kind is '${this.state.kind}'; spell it integer()`);
      }
      return this.entity({ version: true });
    }

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

/**
 * The builders one builder holds, as `[segment, child]` pairs. A
 * `lazy()` thunk is NOT invoked: it exists to break a cycle, and calling
 * it here would rebuild the recursion this walk is trying to finish.
 * @param {any} state
 * @returns {[string, any][]}
 */
function childrenOf(state) {
  switch (state.kind) {
    case 'object': return [
      ...state.props.map(([name, child]) => [name, child]),
      ...state.patterns.map(([pattern, child]) => [`[${pattern}]`, child]),
      ...(state.names === null ? [] : [['propertyNames', state.names]]),
    ];
    case 'array': return [
      ['items', state.items],
      ...(state.contains === null ? [] : [['contains', state.contains]]),
    ];
    case 'tuple': return [
      ...state.items.map((child, i) => [`[${i}]`, child]),
      ...(state.rest === null ? [] : [['rest', state.rest]]),
    ];
    case 'record': return [['values', state.values]];
    case 'union': case 'discriminated': case 'intersection':
      return state.options.map((child, i) => [`[${i}]`, child]);
    case 'when': return [
      ['if', state.cond],
      ...(state.then === null ? [] : [['then', state.then]]),
      ...(state.else === null ? [] : [['else', state.else]]),
    ];
    case 'named': return [[state.name, state.target]];
    default: return [];
  }
}

/**
 * The path of the first DESCENDANT carrying a `renamedFrom` hint, or
 * `null`. `$model` 0.1 puts `x-rename` on an entity or a collection
 * declaration and nowhere else (MIGRATION-FORMAT §3), so a hint anywhere
 * but the declaration's own builder is written by nobody — and a rename
 * the planner never sees is a drop plus a create.
 * @param {any} root - the declaration's builder; its OWN hint is lifted
 * @returns {string | null}
 */
export function strandedRename(root) {
  const seen = new Set();
  /** @type {[string, any][]} */
  const queue = childrenOf(root.state).map(([segment, child]) => [segment, child]);
  while (queue.length > 0) {
    const [path, builder] = /** @type {any} */ (queue.shift());
    if (builder === null || typeof builder !== 'object' || seen.has(builder)) continue;
    seen.add(builder);
    if (builder.state?.renamedFrom !== undefined) return path;
    for (const [segment, child] of childrenOf(builder.state)) {
      queue.push([segment.startsWith('[') ? `${path}${segment}` : `${path}.${segment}`, child]);
    }
  }
  return null;
}

/**
 * The refusal `defineModel()` and `collection()` share for a stranded
 * hint (see `strandedRename`).
 * @param {any} builder @param {string} what @param {string} [docPath]
 */
export function refuseStrandedRename(builder, what, docPath = undefined) {
  const path = strandedRename(builder);
  if (path === null) return;
  throw new LinqBuildError('JL0102',
    `renamedFrom() on ${what}.${path} is not written — $model 0.1 carries x-rename on an `
    + 'entity or a collection declaration, never on a member, so the hint would be lost and '
    + "a rename the planner cannot see is a drop plus a create; put it on the declaration's "
    + 'own builder, or rename the member with a migration transform', docPath);
}
