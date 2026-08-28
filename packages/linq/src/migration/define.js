//@ts-check
/**
 * @file `defineMigration()` and `fromPlanned()` — a `$migration` 0.1
 * document by code (MIGRATION-FORMAT §2). Identity stays the shape hash:
 * `from`/`to` are `hashContent(canonicalizeJson(model))` with the
 * `x-rename` planning hints stripped — the store's own rule, pinned equal
 * to its `shapeHash` by a test over every corpus model. Steps are
 * appended in the order they are called; a `transform` over a planned
 * document REPLACES the draft the planner left for that name, in place,
 * and nothing here ever clears a `draft` flag: a draft left in place
 * still refuses to run (`JD0021`, the runner's rule). The pen refuses
 * what it cannot spell and what the runner would refuse later and the
 * pen can see now — a step over a table the target model does not
 * declare (`JL0106`).
 */

import { canonicalizeJson } from '@jarenjs/json/canonical';
import { hashContent } from '@jarenjs/core/string';
import { deepFreeze } from '@jarenjs/core/object';

import { LinqBuildError } from '../errors.js';
import { describeValue, requireJson } from '../json-boundary.js';
import {
  ddlStep, sqlStep, transformStep, assertStep, deriveStep, rawStep,
} from './steps.js';

const MIGRATION_VERSION = '0.1';
const HEAD_MEMBERS = ['$migration', 'id', 'from', 'to', 'note', 'steps'];

/** A JSON value, copied: the document is a value of its own. @param {any} v */
const copy = (v) => JSON.parse(JSON.stringify(v));

/** @param {any} value */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The model without its `x-rename` hints. A hint is a PLANNING
 * instruction, not shape (MIGRATION-FORMAT §3): two models that differ
 * only by it describe one database and hash the same.
 * @param {any} model
 * @returns {any}
 */
function withoutRenameHints(model) {
  const out = {};
  for (const key of Object.keys(model)) out[key] = model[key];
  for (const member of ['collections', 'entities']) {
    const declared = model[member];
    if (!isPlainObject(declared)) continue;
    const stripped = {};
    for (const name of Object.keys(declared)) {
      const spec = declared[name];
      if (isPlainObject(spec) && Object.hasOwn(spec, 'x-rename')) {
        const { 'x-rename': _hint, ...rest } = spec;
        stripped[name] = rest;
      }
      else {
        stripped[name] = spec;
      }
    }
    out[member] = stripped;
  }
  return out;
}

/**
 * The signature-grade identity of a model SHAPE — what a migration's
 * `from`/`to` name, and what a database records.
 * @param {any} model
 * @returns {string}
 */
function shapeHashOf(model) {
  return hashContent(canonicalizeJson(withoutRenameHints(model)));
}

/**
 * A `$model` 0.1 document — the model pen's, or its JSON — or `JL0101`.
 * @param {any} model
 * @param {string} what
 * @returns {any}
 */
function requireModel(model, what) {
  const doc = requireJson(model, what);
  if (!isPlainObject(doc) || doc.$model !== '0.1') {
    throw new LinqBuildError('JL0101',
      `${what} is a $model 0.1 document (defineModel(…), or its JSON), got `
      + `${isPlainObject(doc) ? 'an object without $model: \'0.1\'' : describeValue(model)}`);
  }
  return doc;
}

/**
 * The tables a model declares: its entities and its collections.
 * @param {any} model
 * @returns {string[]}
 */
function declaredNames(model) {
  const names = [];
  for (const member of ['entities', 'collections']) {
    if (isPlainObject(model[member])) names.push(...Object.keys(model[member]));
  }
  return names;
}

/**
 * The migration under construction. Immutable: every step method answers
 * a new builder; `.document` (memoized) and `toJSON()` are the deep-frozen
 * `$migration` 0.1 document.
 */
export class Migration {
  #head;
  #steps;
  #names;
  #document;

  /**
   * @param {any} head - `$migration`, `id`, `from`, `to`, `note?`
   * @param {readonly any[]} steps
   * @param {readonly string[] | null} names - the target model's tables,
   *   or `null` when no target model is known (a planned document alone)
   */
  constructor(head, steps, names) {
    this.#head = head;
    this.#steps = steps;
    this.#names = names;
    this.#document = null;
  }

  /** @param {readonly any[]} steps */
  #with(steps) {
    return new Migration(this.#head, steps, this.#names);
  }

  /** @param {any} step */
  #append(step) {
    return this.#with([...this.#steps, step]);
  }

  /** A step's table must be one the target model declares — when the
   * target is known; the runner would fail the statement on a table
   * that does not exist, and the pen can say so first. */
  #requireDeclared(name, what) {
    if (this.#names !== null && !this.#names.includes(name)) {
      throw new LinqBuildError('JL0106',
        `${what} names '${name}', which the target model does not declare — it declares `
        + (this.#names.length === 0 ? 'nothing' : this.#names.map((n) => `'${n}'`).join(', ')));
    }
  }

  /** One rendered DDL statement. @param {string} sql @param {string} [note] */
  ddl(sql, note = undefined) {
    return this.#append(ddlStep(sql, note));
  }

  /** One data statement spelled directly (§9.4). @param {string} sql @param {string} [note] */
  sql(sql, note = undefined) {
    return this.#append(sqlStep(sql, note));
  }

  /**
   * The transform of one table's rows (a `jslt` step). Over a planned
   * document it REPLACES the draft the planner left for that table, in
   * place; otherwise it is appended, for a table the target model
   * declares. Two drafts for one name, a draft-less planned document with
   * no target model, or an undeclared name are `JL0106`.
   * @param {string} name
   * @param {any} spelling - a callback `(row, x) => …`, a `stylesheet(…)`
   *   document, or a rules array
   */
  transform(name, spelling) {
    const step = transformStep(name, spelling);
    const drafts = [];
    this.#steps.forEach((s, i) => {
      if (s.kind === 'jslt' && s.draft === true && s.collection === name) drafts.push(i);
    });
    if (drafts.length > 1) {
      throw new LinqBuildError('JL0106',
        `transform() cannot tell which draft to replace: the planned migration carries `
        + `${drafts.length} draft transforms for '${name}'`);
    }
    if (drafts.length === 1) {
      const next = [...this.#steps];
      next[drafts[0]] = step;
      return this.#with(next);
    }
    if (this.#names === null) {
      throw new LinqBuildError('JL0106',
        `transform() over '${name}': the planned migration drafts no transform for it and no `
        + 'target model was given — pass { to } to fromPlanned(), or spell the step with step()');
    }
    this.#requireDeclared(name, 'transform()');
    return this.#append(step);
  }

  /**
   * An assertion over one table's rows (a `query` step).
   * @param {string} name
   * @param {any} spelling - a predicate `(row) => …`, or a query document
   * @param {{ expect?: 'empty' | 'ebv' }} [options]
   */
  assert(name, spelling, options = undefined) {
    const step = assertStep(name, spelling, options);
    this.#requireDeclared(name, 'assert()');
    return this.#append(step);
  }

  /**
   * A backfill of stored derived columns (§2.1).
   * @param {string} name
   * @param {readonly any[]} columns
   */
  derive(name, columns) {
    const step = deriveStep(name, columns);
    this.#requireDeclared(name, 'derive()');
    return this.#append(step);
  }

  /** Any planner-emitted step, verbatim. @param {any} raw */
  step(raw) {
    return this.#append(rawStep(raw));
  }

  /** The `$migration` 0.1 document, deep-frozen. */
  get document() {
    if (this.#document === null) {
      this.#document = deepFreeze({ ...this.#head, steps: this.#steps.map(copy) });
    }
    return this.#document;
  }

  toJSON() {
    return this.document;
  }
}

/**
 * A migration between two model documents: `from`/`to` are their shape
 * hashes, the steps what the methods append.
 * @param {{ id: string, from: any, to: any, note?: string }} spec
 * @returns {Migration}
 */
export function defineMigration(spec) {
  if (!isPlainObject(spec)) {
    throw new LinqBuildError('JL0101', 'defineMigration() takes { id, from, to, note? }');
  }
  for (const key of Object.keys(spec)) {
    if (!['id', 'from', 'to', 'note'].includes(key)) {
      throw new LinqBuildError('JL0101', `defineMigration() does not take '${key}'`);
    }
  }
  if (typeof spec.id !== 'string' || spec.id === '') {
    throw new LinqBuildError('JL0101',
      `defineMigration() id is a non-empty string, got ${describeValue(spec.id)}`, '/id');
  }
  const from = requireModel(spec.from, 'defineMigration() from');
  const to = requireModel(spec.to, 'defineMigration() to');
  const head = { $migration: MIGRATION_VERSION, id: spec.id, from: shapeHashOf(from), to: shapeHashOf(to) };
  if (spec.note !== undefined) {
    if (typeof spec.note !== 'string') {
      throw new LinqBuildError('JL0101',
        `defineMigration() note is a string, got ${describeValue(spec.note)}`, '/note');
    }
    head.note = spec.note;
  }
  return new Migration(head, [], declaredNames(to));
}

/**
 * A planner's document, taken up so its draft steps can be replaced by
 * typed transforms. `from`/`to` model documents type the transforms and
 * are checked against the document's hashes — a model that is not the
 * one the planner planned from is refused (`JL0102`).
 * @param {any} document - a `$migration` 0.1 document, as `jaren-db plan` writes it
 * @param {{ from?: any, to?: any }} [options]
 * @returns {Migration}
 */
export function fromPlanned(document, options = undefined) {
  const doc = copy(requireJson(document, 'fromPlanned() document'));
  if (!isPlainObject(doc) || doc.$migration !== MIGRATION_VERSION
    || typeof doc.id !== 'string' || doc.id === ''
    || typeof doc.from !== 'string' || typeof doc.to !== 'string' || !Array.isArray(doc.steps)) {
    throw new LinqBuildError('JL0101',
      'fromPlanned() takes a $migration 0.1 document — { $migration, id, from, to, steps } — '
      + 'as jaren-db plan writes it');
  }
  for (const key of Object.keys(doc)) {
    if (!HEAD_MEMBERS.includes(key)) {
      throw new LinqBuildError('JL0101',
        `fromPlanned() document carries '${key}', which the migration format does not declare`,
        `/${key}`);
    }
  }
  let names = null;
  if (options !== undefined) {
    if (!isPlainObject(options)) {
      throw new LinqBuildError('JL0101', `fromPlanned() options are { from?, to? }, got ${describeValue(options)}`);
    }
    for (const key of Object.keys(options)) {
      if (key !== 'from' && key !== 'to') throw new LinqBuildError('JL0101', `fromPlanned() does not take '${key}'`);
    }
    for (const side of ['from', 'to']) {
      if (options[side] === undefined) continue;
      const model = requireModel(options[side], `fromPlanned() ${side}`);
      const hash = shapeHashOf(model);
      if (hash !== doc[side]) {
        throw new LinqBuildError('JL0102',
          `fromPlanned() ${side} model has shape '${hash}', but the planned migration's ${side} is `
          + `'${doc[side]}' — the model given is not the one the planner planned ${side === 'from' ? 'from' : 'to'}`,
          `/${side}`);
      }
      if (side === 'to') names = declaredNames(model);
    }
  }
  const head = { $migration: MIGRATION_VERSION, id: doc.id, from: doc.from, to: doc.to };
  if (doc.note !== undefined) {
    if (typeof doc.note !== 'string') {
      throw new LinqBuildError('JL0101', `fromPlanned() document note is a string, got ${describeValue(doc.note)}`, '/note');
    }
    head.note = doc.note;
  }
  return new Migration(head, doc.steps.map((step) => rawStep(step)), names);
}
