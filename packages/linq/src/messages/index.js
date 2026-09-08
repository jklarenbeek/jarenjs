//@ts-check
/** JSON catalogs and existing MessageSpec values, checked against English vocabulary. */
import { compileMessageTemplate } from '@jarenjs/core/message';
import { snapshot, optionsOf } from '../authored.js';
import { requireNameMap } from '../json-boundary.js';
import { LinqBuildError } from '../errors.js';
import { CATALOGS } from './vocabulary.js';
export { CATALOGS } from './vocabulary.js';

const ALL = Object.freeze(Object.assign({}, ...Object.values(CATALOGS)));
function sourceOf(source) {
  if (source === 'all') return ALL;
  if (!Object.hasOwn(CATALOGS, source)) throw new LinqBuildError('JL0101', `Unknown message catalog '${source}'`);
  return CATALOGS[source];
}
function mapOf(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new LinqBuildError('JL0101', 'A catalog takes a plain message-id map');
  return requireNameMap(value, 'catalog entries');
}
function checkTemplate(id, text, reference, locale, exact = true) {
  if (!Object.hasOwn(reference, id)) throw new LinqBuildError('JL0101', `${locale}/${id}: unknown message id`);
  if (typeof text !== 'string') throw new LinqBuildError('JL0101', `${locale}/${id}: JSON catalog entries are template strings`);
  const names = compileMessageTemplate(text).parameters;
  const missing = exact ? reference[id].filter((name) => !names.includes(name)) : [];
  const extra = names.filter((name) => !reference[id].includes(name));
  if (missing.length || extra.length)
    throw new LinqBuildError('JL0101', `${locale}/${id}: placeholder mismatch; missing [${missing.join(', ')}], extra [${extra.join(', ')}]`);
}

/** An immutable catalog draft. Serialize only after complete() or explicit partial(). */
export class CatalogBuilder {
  #document;
  #source;
  #locale;
  /** @param {object} document @param {string} source @param {string} locale */
  constructor(document, source, locale) {
    sourceOf(source);
    if (typeof locale !== 'string' || !locale) throw new LinqBuildError('JL0101', 'A catalog needs a nonempty locale name');
    this.#document = snapshot(mapOf(document));
    this.#source = source;
    this.#locale = locale;
  }
  /** Add or replace a template, checking its placeholders immediately. */
  entry(id, value) {
    checkTemplate(id, value, sourceOf(this.#source), this.#locale);
    return new CatalogBuilder({ ...this.#document, [id]: value }, this.#source, this.#locale);
  }
  /** Add several templates atomically; the prior draft is unchanged on refusal. @param {object} values */
  entries(values) {
    const reference = sourceOf(this.#source);
    for (const [id, value] of Object.entries(mapOf(values))) checkTemplate(id, value, reference, this.#locale);
    return new CatalogBuilder({ ...this.#document, ...values }, this.#source, this.#locale);
  }
  /** Emit an explicitly partial catalog; all present entries still need valid names/placeholders. */
  partial() {
    const reference = sourceOf(this.#source);
    for (const [id, value] of Object.entries(this.#document)) checkTemplate(id, value, reference, this.#locale);
    return this.#document;
  }
  /** Emit a complete catalog, refusing missing or extra ids before publication. */
  complete() {
    const document = this.partial();
    const missing = Object.keys(sourceOf(this.#source)).filter((id) => !Object.hasOwn(document, id));
    if (missing.length) throw new LinqBuildError('JL0101', `${this.#locale}: incomplete ${this.#source} catalog; missing [${missing.join(', ')}]`);
    return document;
  }
  /** Serializing an unfinished draft is a completeness check, never an implicit partial. */
  toJSON() { return this.complete(); }
}

/** Start a catalog for an English-owned key space and a diagnostic locale name. */
export function catalog(source = 'all', locale = 'en') { return new CatalogBuilder({}, source, locale); }
/** A raw JSON catalog draft; both exits validate its keys and placeholders. */
export function from(document, options = {}) {
  const opts = optionsOf(options, ['source', 'locale'], 'from()');
  return new CatalogBuilder(document, opts.source ?? 'all', opts.locale ?? 'en');
}
/** An inline MessageSpec string, parsed by the same compiler as a catalog entry. @param {string} value */
export function inline(value) {
  if (typeof value !== 'string') throw new LinqBuildError('JL0101', 'inline() takes a template string');
  compileMessageTemplate(value);
  return value;
}
/** The existing structured MessageSpec; it is a message reference, not a catalog entry. */
export function message(id, options = {}) {
  if (!Object.hasOwn(ALL, id)) throw new LinqBuildError('JL0101', `Unknown message id '${id}'`);
  const opts = optionsOf(options, ['params', 'message'], 'message()');
  if (Object.hasOwn(opts, 'params')) {
    for (const name of Object.keys(mapOf(opts.params))) {
      if (!ALL[id].includes(name)) throw new LinqBuildError('JL0101', `${id}: unknown parameter '${name}'`);
    }
  }
  if (Object.hasOwn(opts, 'message')) checkTemplate(id, opts.message, ALL, 'fallback', false);
  return snapshot({ $msgid: id, ...opts });
}
