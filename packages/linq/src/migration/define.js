//@ts-check
/**
 * @file `defineMigration()` and `fromPlanned()` — a `$migration` 0.2
 * document by code (MIGRATION-FORMAT §2). Exact identity carries the
 * canonical models with collection/entity rename hints stripped;
 * `from`/`to` retain the store's compatible shape fingerprints. Steps are
 * appended in the order they are called; a `transform` over a planned
 * document REPLACES the draft the planner left for that name, in place,
 * and nothing here ever clears a `draft` flag: a draft left in place
 * still refuses to run (`JD0021`, the runner's rule). The pen refuses
 * what it cannot spell and what the runner would refuse later and the
 * pen can see now — a step over a table the selected model does not
 * declare (`JL0106`).
 */

import { canonicalizeJson } from '@jarenjs/json/canonical';
import { hashContent } from '@jarenjs/core/string';
import { deepFreeze, isJsonObject } from '@jarenjs/core/object';
import { withoutModelRenameHints } from '@jarenjs/core/model';

import { LinqBuildError } from '../errors.js';
import { describeValue, requireJson } from '../json-boundary.js';
import {
  ddlStep, sqlStep, hostStep, transformStep, assertStep, deriveStep, rawStep,
} from './steps.js';

const MIGRATION_VERSION = '0.2';
const HEAD_MEMBERS = ['$migration', 'id', 'from', 'to', 'identity', 'note', 'steps', 'physical'];

/** A JSON value, copied: the document is a value of its own. @param {any} v */
const copy = (v) => JSON.parse(JSON.stringify(v));

/**
 * The exact model shape shared by the pen and database endpoint rule.
 * @param {any} model
 * @returns {string}
 */
function modelIdentityOf(model) {
  return canonicalizeJson(withoutModelRenameHints(model));
}

/** Inspect data descriptors before any JSON traversal can evaluate a getter.
 * @param {any} doc */
function requireIdentity(doc) {
  const invalid = (reason, path = '/identity') => new LinqBuildError('JL0101', `fromPlanned() ${reason}`, path);
  const member = Object.getOwnPropertyDescriptor(doc, 'identity');
  const input = member && Object.hasOwn(member, 'value') ? member.value : undefined;
  if (!member?.enumerable || !isJsonObject(input))
    throw invalid('needs identity { version: 1, from, to }');
  const fields = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(fields).length !== 3
    || ['version', 'from', 'to'].some((key) => !Object.hasOwn(fields, key)
      || !fields[key].enumerable || !Object.hasOwn(fields[key], 'value'))
    || fields.version.value !== 1 || typeof fields.from.value !== 'string' || typeof fields.to.value !== 'string')
    throw invalid('needs only identity version 1 and canonical from/to model texts');
  return input;
}

/** The copied document must carry canonical exact endpoint texts.
 * @param {any} doc */
function checkIdentity(doc) {
  const invalid = (reason, path = '/identity') => new LinqBuildError('JL0101', `fromPlanned() ${reason}`, path);
  const identity = requireIdentity(doc);
  for (const side of ['from', 'to']) {
    const text = identity[side];
    let model;
    try {
      model = JSON.parse(text);
      if (!isJsonObject(model) || !Object.hasOwn(model, '$model') || model.$model !== '0.1'
        || modelIdentityOf(model) !== text) throw invalid('invalid endpoint');
    }
    catch {
      throw invalid(`identity.${side} must be canonical $model 0.1 text without rename hints`, `/identity/${side}`);
    }
    if (hashContent(text) !== doc[side])
      throw invalid(`${side} fingerprint does not match identity.${side}`, `/${side}`);
  }
}

/**
 * A `$model` 0.1 document — the model pen's, or its JSON — or `JL0101`.
 * @param {any} model
 * @param {string} what
 * @returns {any}
 */
function requireModel(model, what) {
  const doc = requireJson(model, what);
  if (!isJsonObject(doc) || doc.$model !== '0.1') {
    throw new LinqBuildError('JL0101',
      `${what} is a $model 0.1 document (defineModel(…), or its JSON), got `
      + `${isJsonObject(doc) ? 'an object without $model: \'0.1\'' : describeValue(model)}`);
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
    if (isJsonObject(model[member])) names.push(...Object.keys(model[member]));
  }
  return names;
}

/**
 * The migration under construction. Immutable: every step method answers
 * a new builder; `.document` (memoized) and `toJSON()` are the deep-frozen
 * `$migration` 0.2 document.
 */
export class Migration {
  #head;
  #steps;
  #names;
  #document;

  /**
   * @param {any} head - `$migration`, `id`, `from`, `to`, `identity`, `note?`
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

  /** A step's table must be one its explicit current model or the known
   * target model declares; the pen catches a missing name before execution. */
  #requireDeclared(name, what, model = undefined) {
    const names = model === undefined ? this.#names : declaredNames(model);
    if (names !== null && !names.includes(name)) {
      throw new LinqBuildError('JL0106',
        `${what} names '${name}', which the ${model === undefined ? 'target' : 'step'} model does not declare — it declares `
        + (names.length === 0 ? 'nothing' : names.map((n) => `'${n}'`).join(', ')));
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

  /** Application code in the migration's transaction: the host registered
   * under `run`, at `version`. @param {string} run @param {string} version @param {string} [note] */
  host(run, version, note = undefined) {
    return this.#append(hostStep(run, version, note));
  }

  /**
   * The transform of one table's rows (a `jslt` step). Over a planned
   * document it REPLACES the draft the planner left for that table, in
   * place; otherwise it is appended, for a table the explicit current or
   * target model declares. Two drafts for one name, a draft-less planned
   * document with neither model, or an undeclared name are `JL0106`.
   * @param {string} name
   * @param {any} spelling - a callback `(row, x) => …`, a `stylesheet(…)`
   *   document, or a rules array
   * @param {{ model?: any }} [options] - The layout at this step, before later DDL
   */
  transform(name, spelling, options = undefined) {
    const step = transformStep(name, spelling, options);
    if (step.model !== undefined) this.#requireDeclared(name, 'transform()', step.model);
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
    if (this.#names === null && step.model === undefined) {
      throw new LinqBuildError('JL0106',
        `transform() over '${name}': the planned migration drafts no transform for it and no `
        + 'target model or explicit step model was given — pass { model } to transform(), { to } to fromPlanned(), or spell the step with step()');
    }
    this.#requireDeclared(name, 'transform()', step.model);
    return this.#append(step);
  }

  /**
   * An assertion over one table's rows (a `query` step).
   * @param {string} name
   * @param {any} spelling - a predicate `(row) => …`, or a query document
   * @param {{ expect?: 'empty' | 'ebv', model?: any }} [options]
   */
  assert(name, spelling, options = undefined) {
    const step = assertStep(name, spelling, options);
    this.#requireDeclared(name, 'assert()', step.model);
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

  /** The `$migration` 0.2 document, deep-frozen. */
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
 * A migration between exact model shapes, with compatible `from`/`to`
 * fingerprints and the steps the methods append.
 * @param {{ id: string, from: any, to: any, note?: string }} spec
 * @returns {Migration}
 */
export function defineMigration(spec) {
  if (!isJsonObject(spec)) {
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
  const identity = { version: 1, from: modelIdentityOf(from), to: modelIdentityOf(to) };
  const head = { $migration: MIGRATION_VERSION, id: spec.id,
    from: hashContent(identity.from), to: hashContent(identity.to), identity };
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
 * are checked against the document's exact endpoints — a model that is not the
 * one the planner planned from is refused (`JL0102`).
 * @param {any} document - a `$migration` 0.2 document, as `jaren-db plan` writes it
 * @param {{ from?: any, to?: any }} [options]
 * @returns {Migration}
 */
export function fromPlanned(document, options = undefined) {
  if (isJsonObject(document) && Object.hasOwn(document, 'identity')) requireIdentity(document);
  const doc = copy(requireJson(document, 'fromPlanned() document'));
  if (!isJsonObject(doc) || !['0.1', MIGRATION_VERSION].includes(doc.$migration)
    || typeof doc.id !== 'string' || doc.id === ''
    || typeof doc.from !== 'string' || typeof doc.to !== 'string' || !Array.isArray(doc.steps)) {
    throw new LinqBuildError('JL0101',
      'fromPlanned() takes a $migration 0.2 document — { $migration, id, from, to, identity, steps } — '
      + 'as jaren-db plan writes it');
  }
  for (const key of Object.keys(doc)) {
    if (!HEAD_MEMBERS.includes(key)) {
      throw new LinqBuildError('JL0101',
        `fromPlanned() document carries '${key}', which the migration format does not declare`,
        `/${key}`);
    }
  }
  if (doc.$migration === '0.1') {
    throw new LinqBuildError('JL0102',
      'fromPlanned() cannot edit a legacy $migration 0.1 document; keep applied artifacts unchanged '
      + 'and deliberately plan or author a new 0.2 migration', '/$migration');
  }
  checkIdentity(doc);
  let names = null;
  if (options !== undefined) {
    if (!isJsonObject(options)) {
      throw new LinqBuildError('JL0101', `fromPlanned() options are { from?, to? }, got ${describeValue(options)}`);
    }
    for (const key of Object.keys(options)) {
      if (key !== 'from' && key !== 'to') throw new LinqBuildError('JL0101', `fromPlanned() does not take '${key}'`);
    }
    for (const side of ['from', 'to']) {
      if (options[side] === undefined) continue;
      const model = requireModel(options[side], `fromPlanned() ${side}`);
      const identity = modelIdentityOf(model);
      if (identity !== doc.identity[side]) {
        throw new LinqBuildError('JL0102',
          `fromPlanned() ${side} model does not match the planned migration's exact ${side} identity — `
          + `the model given is not the one the planner planned ${side === 'from' ? 'from' : 'to'}`,
          `/${side}`);
      }
      if (side === 'to') names = declaredNames(model);
    }
  }
  const head = { $migration: MIGRATION_VERSION, id: doc.id, from: doc.from, to: doc.to, identity: doc.identity };
  if (doc.note !== undefined) {
    if (typeof doc.note !== 'string') {
      throw new LinqBuildError('JL0101', `fromPlanned() document note is a string, got ${describeValue(doc.note)}`, '/note');
    }
    head.note = doc.note;
  }
  if (doc.physical !== undefined) {
    if (!isJsonObject(doc.physical) || !Array.isArray(doc.physical.source)
      || !isJsonObject(doc.physical.dispositions) || !Array.isArray(doc.physical.assertions)) {
      throw new LinqBuildError('JL0101',
        'fromPlanned() physical header needs source, dispositions and assertions', '/physical');
    }
    head.physical = doc.physical;
  }
  return new Migration(head, doc.steps.map((step) => rawStep(step)), names);
}
