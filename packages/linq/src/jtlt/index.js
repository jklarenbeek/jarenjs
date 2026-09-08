//@ts-check
/** JTLT's public rules and text segments, with query capture but no renderer. */
import { DocumentBuilder, optionsOf, snapshot } from '../authored.js';
import { captureQuery } from '../capture-root.js';
import { LinqBuildError } from '../errors.js';

const RULE_KEYS = ['match', 'mode', 'priority'];
const OUTPUTS = ['text', 'xml'];

function list(value, what) {
  if (!Array.isArray(value)) throw new LinqBuildError('JL0101', `${what} takes an array`);
  return value;
}

function rulesOf(values) {
  return list(values, 'rules()').map((value) => value instanceof RuleBuilder ? value.schema : snapshot(value));
}

function queryDocument(value, options) {
  const opts = optionsOf(options ?? {}, ['externals'], 'query options');
  const names = opts.externals ?? [];
  if (!Array.isArray(names) || names.some((n) => typeof n !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(n))
    || new Set(names).size !== names.length || names.includes('root') || names.includes('path'))
    throw new LinqBuildError('JL0101', 'externals must be unique parameter names; root and path are already bound');
  // An undeclared callback external is the shared capture's JL0104 refusal.
  return snapshot(typeof value === 'function'
    ? captureQuery('JTLT expression', ['root', 'path', ...names], value, { fold: false })
    : value);
}

/** A literal segment; escape a leading dollar so it cannot become a query. @param {string} value */
export function text(value) {
  if (typeof value !== 'string') throw new LinqBuildError('JL0101', 'text() takes a string');
  return value.startsWith('$') ? '$' + value : value;
}

/** An interpolated query string/object, optionally captured from a callback. */
export function query(value, options = {}) {
  const doc = queryDocument(value, options);
  if (typeof doc !== 'string' && (doc === null || Array.isArray(doc) || typeof doc !== 'object'
    || !Object.keys(doc).some((key) => key.startsWith('$'))))
    throw new LinqBuildError('JL0101', 'query() needs a string or query object segment; use json() for a literal JSON value');
  return doc;
}

/** Interpolate a query without output-method escaping. */
export function raw(value, options = {}) { return snapshot({ $raw: queryDocument(value, options) }); }
/** Serialize query results as JSON text, with output-method escaping. */
export function json(value, options = {}) { return snapshot({ $json: queryDocument(value, options) }); }
/** Splice template dispatch, optionally selecting a literal mode. */
export function apply(value, mode, options = {}) {
  if (mode !== undefined && typeof mode !== 'string') throw new LinqBuildError('JL0101', 'apply() mode must be a string');
  const doc = queryDocument(value, options);
  return snapshot({ $apply: mode === undefined ? doc : [doc, mode] });
}

/** One immutable template rule. */
export class RuleBuilder extends DocumentBuilder {
  /** Replace the segment list. @param {readonly any[]} value */
  body(value) { return this.with({ body: list(value, 'body()') }); }
  /** Replace the JSLT match specification. @param {any} value */
  match(value) { return this.with({ match: value }); }
  /** Replace the mode. @param {string} value */
  mode(value) { return this.with({ mode: value }); }
  /** Replace priority; the compiler owns the reserved priority band. @param {number} value */
  priority(value) { return this.with({ priority: value }); }
}

/** A public rule; omit match for a catch-all in its mode. */
export function rule(body = [], options = {}) {
  return new RuleBuilder({ ...optionsOf(options, RULE_KEYS, 'rule()'), body: list(body, 'rule() body') });
}

/** A bare rule list or versioned JTLT envelope. */
export class TemplateBuilder extends DocumentBuilder {
  /** Replace rules while preserving the bare/envelope distinction. @param {readonly any[]} values */
  rules(values) {
    const rules = rulesOf(values);
    return Array.isArray(this.schema) ? new TemplateBuilder(rules) : this.with({ rules });
  }
  /** Append a rule without changing existing rules. @param {any} value */
  rule(value) { return this.rules([...(Array.isArray(this.schema) ? this.schema : this.schema.rules), value]); }
  /** Set output; a bare list becomes an envelope when an output is declared. @param {'text' | 'xml'} value */
  output(value) {
    if (!OUTPUTS.includes(value)) throw new LinqBuildError('JL0101', 'output() takes text or xml');
    return Array.isArray(this.schema) ? stylesheet(this.schema, { output: value }) : this.with({ output: value });
  }
}

/** The versioned public template envelope. */
export function stylesheet(rules = [], options = {}) {
  return new TemplateBuilder({ $jtlt: '0.1', ...optionsOf(options, ['output'], 'stylesheet()'), rules: rulesOf(rules) });
}
/** The public bare-rule-array shorthand, preserved on serialization. @param {readonly any[]} rules */
export function bare(rules = []) { return new TemplateBuilder(rulesOf(rules)); }
/** Preserve a raw public template exactly, including envelope member order. @param {any} document */
export function from(document) { return new TemplateBuilder(document); }
