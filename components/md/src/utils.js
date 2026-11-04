//@ts-check
/**
 * @file Small shared helpers for the md package.
 *
 * The content hash is the package's identity primitive — block vnode
 * keys, the document `meta.hash`, and the mermaid SVG cache are all keyed
 * by it — so md re-exports the suite's single `hashContent` from
 * `@jarenjs/core` rather than carrying its own copy; equal content hits
 * O(1) fast paths everywhere downstream. `fnv1a` is that same mixing
 * step, exposed for the two callers that fold a hash incrementally (the
 * streaming parser's chunks, the structural block-key walk) and so must
 * seed it themselves from `FNV1A_OFFSET_BASIS`. Heading slugs come from
 * the same place for the same reason: `slugify` is a pure text→fragment
 * transform with no Markdown knowledge, so the suite keeps exactly one
 * of it. The remaining helpers are md's own allocation-light scanner
 * utilities.
 */

import { slugify } from '@jarenjs/core/string';
import { isPlainOptions, nearestName, refuseUnknownMembers } from '@jarenjs/core/object';
import { compileMessageTemplate } from '@jarenjs/core/message';

export { hashContent, fnv1a, FNV1A_OFFSET_BASIS, slugify } from '@jarenjs/core/string';

/**
 * How deep any construct nests. Block containers (block quotes, lists,
 * list items, footnote definitions), inline containers (emphasis, strong
 * emphasis, strikethrough, links), the raw-HTML elements `html: 'vnode'`
 * keeps, frontmatter flow collections, YAML block collections and TOML
 * tables each nest at most this deep (JSON frontmatter, twice as deep):
 * a marker past the bound is read as text, and a frontmatter collection
 * past it is refused. The bound is what keeps the deepest tree the
 * parser can build one that every emitter, and the view renderers after
 * them, can walk recursively — whatever the input.
 */
export const MAX_NESTING = 256;

/**
 * The `id` for one heading, unique within one emission.
 *
 * Both emitters mint ids, so the rule lives here once: slug the text,
 * substitute `section` when nothing slug-worthy survives, number
 * repeats the way GitHub numbers them (`setup`, `setup-1`, `setup-2`),
 * reserving every emitted slug so a literal `setup-1` cannot collide
 * with a numbered `setup`, and prefix the result. The COUNTER belongs
 * to the caller — one map per
 * emission, never shared with another numbering (a block key's hash and
 * a slug share a namespace only by accident, and a collision there would
 * shift an unrelated heading's number).
 *
 * @param {string} text the heading's plain text (`textOf`)
 * @param {Map<string, number>} seen the emission's slug counter
 * @param {string} prefix prepended to the result
 * @returns {string}
 */
export function headingId(text, seen, prefix) {
  const base = slugify(text) || 'section';
  let count = seen.get(base) ?? 0;
  let slug = count === 0 ? base : base + '-' + count;
  while (seen.has(slug)) slug = base + '-' + ++count;
  seen.set(base, count + 1);
  if (slug !== base) seen.set(slug, 1);
  return prefix + slug;
}

/**
 * The accessible names the emitters write, in English. A `labels` option
 * replaces any of them for readers who do not hear English. Each is a
 * template in the suite's one message grammar (`{name}` substitutes a
 * parameter, `{{` is a literal brace) or a closure over the same
 * parameters: `permalink` gets the heading's `{text}`, `backref` its
 * footnote's `{number}`, and `backrefOccurrence` that `{number}` and the
 * `{occurrence}` (2 and up) of a footnote cited more than once. The
 * footnotes section's own name is the `footnotesLabel` option.
 */
export const DEFAULT_LABELS = Object.freeze({
  pageBreak: 'Page break',
  permalink: 'Permalink to {text}',
  permalinkSection: 'Permalink to this section',
  backref: 'Back to reference {number}',
  backrefOccurrence: 'Back to reference {number}, occurrence {occurrence}',
});

/**
 * One accessible name: a message template, or a closure that renders it.
 * @typedef {string | ((params: Record<string, unknown>) => string)} MdLabel
 */
/**
 * Accessible names that replace the English {@link DEFAULT_LABELS}; a
 * member left out keeps its default.
 * @typedef {object} MdLabels
 * @property {MdLabel} [pageBreak] a page break's name
 * @property {MdLabel} [permalink] a heading anchor's name, given the
 *   heading's `{text}`
 * @property {MdLabel} [permalinkSection] a heading anchor's name when the
 *   heading has no text
 * @property {MdLabel} [backref] a footnote back-reference's name, given
 *   the footnote's `{number}`
 * @property {MdLabel} [backrefOccurrence] the name of a footnote's second
 *   and later back-references, given `{number}` and `{occurrence}`
 */
/**
 * The labels one emission renders with, every member a closure.
 * @typedef {Readonly<Record<keyof typeof DEFAULT_LABELS, (params: Record<string, unknown>) => string>>} RenderLabels
 */

const LABEL_NAMES = Object.freeze(Object.keys(DEFAULT_LABELS));

/** @type {RenderLabels} the English labels, compiled once */
const ENGLISH_LABELS = Object.freeze({
  pageBreak: compileMessageTemplate(DEFAULT_LABELS.pageBreak),
  permalink: compileMessageTemplate(DEFAULT_LABELS.permalink),
  permalinkSection: compileMessageTemplate(DEFAULT_LABELS.permalinkSection),
  backref: compileMessageTemplate(DEFAULT_LABELS.backref),
  backrefOccurrence: compileMessageTemplate(DEFAULT_LABELS.backrefOccurrence),
});

const NO_PARAMS = Object.freeze({});

/**
 * The labels an emission renders with: the caller's over the English
 * ones. A template compiles once per emission and then renders once per
 * heading or back-reference; a closure's answer is read as a string.
 * @param {MdLabels|undefined} labels an option already checked
 * @returns {RenderLabels}
 */
export function renderLabels(labels) {
  if (labels === undefined) return ENGLISH_LABELS;
  /** @type {Record<string, (params: Record<string, unknown>) => string>} */
  const compiled = { ...ENGLISH_LABELS };
  for (const name of LABEL_NAMES) {
    const label = /** @type {any} */ (labels)[name];
    if (typeof label === 'function') compiled[name] = (params) => String(label(params));
    else if (typeof label === 'string') compiled[name] = compileMessageTemplate(label);
  }
  return /** @type {RenderLabels} */ (compiled);
}

/** @type {WeakMap<Function, number>} */
const labelReferences = new WeakMap();
let nextLabelReference = 0;

/**
 * A `labels` option as a cache key: members in name order, a template by
 * its text and a closure by its identity (equal source says nothing about
 * what a closure renders); `''` when it sets nothing, so it keys like an
 * absent option.
 * @param {MdLabels|undefined} labels
 * @returns {string}
 */
export function labelsKey(labels) {
  if (labels === undefined || labels === null) return '';
  let key = '';
  for (const name of Object.keys(labels).sort()) {
    const label = /** @type {any} */ (labels)[name];
    if (typeof label === 'function') {
      let reference = labelReferences.get(label);
      if (reference === undefined) {
        reference = ++nextLabelReference;
        labelReferences.set(label, reference);
      }
      key += name + '#' + reference + ';';
    } else if (label !== undefined) {
      key += name + '=' + JSON.stringify(label) + ';';
    }
  }
  return key;
}

/**
 * The accessible name for a heading's permalink affordance — `#` alone
 * names nothing, so the link says which section it points at.
 * @param {RenderLabels} labels
 * @param {string} text the heading's plain text (`textOf`)
 * @returns {string}
 */
export function permalinkLabel(labels, text) {
  const trimmed = text.trim();
  return trimmed === '' ? labels.permalinkSection(NO_PARAMS) : labels.permalink({ text: trimmed });
}

/**
 * The accessible name of a page break.
 * @param {RenderLabels} labels
 * @returns {string}
 */
export function pageBreakLabel(labels) {
  return labels.pageBreak(NO_PARAMS);
}

/**
 * Count leading space characters (U+0020 only; the scanner expands no
 * tabs here — callers pass detabbed text).
 * @param {string} line
 * @returns {number}
 */
export function countIndent(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  return i;
}

/**
 * Is the line blank (empty or whitespace-only)?
 * @param {string} line
 * @returns {boolean}
 */
export function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/**
 * Replace tabs with spaces to the next 4-column tab stop, counting
 * columns from `startColumn`. Lines without tabs return the same
 * string reference (the common case allocates nothing).
 * @param {string} line
 * @param {number} [startColumn]
 * @returns {string}
 */
export function expandTabs(line, startColumn = 0) {
  if (line.indexOf('\t') === -1) return line;
  let out = '';
  let column = startColumn;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\t') {
      const width = 4 - (column % 4);
      out += '    '.slice(0, width);
      column += width;
    }
    else {
      out += ch;
      column++;
    }
  }
  return out;
}

/**
 * The part of a line that starts at column `column` of its tab-expanded
 * form, with the tabs it was written with kept. A tab that straddles the
 * column is spent in part: the columns past it come back as spaces. A
 * line without tabs is just sliced.
 * @param {string} line the line as written
 * @param {number} column a column of `expandTabs(line)`
 * @returns {string}
 */
export function tabsFrom(line, column) {
  if (line.indexOf('\t') === -1) return line.slice(column);
  let at = 0;
  for (let i = 0; i < line.length; i++) {
    if (at >= column) return line.slice(i);
    if (line.charCodeAt(i) === 9) {
      const next = at + 4 - (at % 4);
      if (next > column) return ' '.repeat(next - column) + line.slice(i + 1);
      at = next;
    }
    else {
      at++;
    }
  }
  return '';
}

/**
 * The rule one member of a closed option set must satisfy: what it
 * `expects`, as a refusal names it, the `test` a present value passes,
 * — for a closed list of values — the `values` a refusal names the
 * nearest of, and — for an object of labels — the `members` it may name,
 * each a template string or a closure.
 * @typedef {{ expects: string, test: (value: any) => boolean, values?: readonly string[],
 *   members?: readonly string[] }} OptionRule
 */

/** The option kinds the emitters take. */
export const OPTION_RULES = Object.freeze({
  /** @type {OptionRule} */
  boolean: { expects: 'a boolean', test: (value) => typeof value === 'boolean' },
  /** @type {OptionRule} */
  string: { expects: 'a string', test: (value) => typeof value === 'string' },
  /** @type {OptionRule} */
  function: { expects: 'a function', test: (value) => typeof value === 'function' },
  /** @type {OptionRule} */
  array: { expects: 'an array', test: (value) => Array.isArray(value) },
  /** @type {OptionRule} */
  object: { expects: 'an object', test: (value) => value !== null && typeof value === 'object' },
  /** @type {OptionRule} {@link MdLabels}, closed */
  labels: { expects: 'a plain object of labels', test: isPlainOptions, members: LABEL_NAMES },
  /**
   * @param {...string} values
   * @returns {OptionRule}
   */
  oneOf: (...values) => ({
    expects: values.slice(0, -1).map((v) => `'${v}'`).join(', ') + ` or '${values[values.length - 1]}'`,
    test: (value) => values.includes(value),
    values: Object.freeze(values),
  }),
});

/**
 * A value as a refusal names it, without calling anything on it.
 * @param {unknown} value
 * @returns {string}
 */
function describeValue(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  switch (typeof value) {
    case 'string': return JSON.stringify(value.length > 40 ? value.slice(0, 40) + '…' : value);
    case 'number':
    case 'boolean':
    case 'bigint':
    case 'undefined': return String(value);
    case 'function': return 'a function';
    case 'symbol': return 'a symbol';
    default: return 'an object';
  }
}

/**
 * Compile the check for one function's closed option set. The returned
 * check refuses — with a `TypeError` naming the function — options that
 * are not a plain object, a member outside `rules` (naming the nearest
 * one), and a present member that breaks its rule (naming the nearest
 * value of a closed list, when one is close); it returns nothing and
 * changes nothing. A member passed as `undefined` is absent: that is the
 * shape a caller forwarding its own optional options builds.
 * @param {string} surface the function the options belong to
 * @param {Record<string, OptionRule>} rules
 * @returns {(options: unknown) => void}
 */
export function compileOptionCheck(surface, rules) {
  const names = Object.freeze(Object.keys(rules));
  return (options) => {
    if (!isPlainOptions(options)) {
      throw new TypeError(`md ${surface}: options must be a plain object, got ${describeValue(options)}`);
    }
    refuseUnknownMembers(options, names,
      (key, hint) => new TypeError(`md ${surface}: unknown option '${key}'${hint}`));
    for (const key of Object.keys(options)) {
      const value = options[key];
      const rule = rules[key];
      if (value !== undefined && !rule.test(value)) {
        const near = typeof value === 'string' && rule.values !== undefined ? nearestName(value, rule.values) : undefined;
        throw new TypeError(`md ${surface}: option '${key}' must be ${rule.expects}, got ${describeValue(value)}`
          + (near === undefined ? '' : ` — did you mean '${near}'?`));
      }
      if (value !== undefined && rule.members !== undefined) checkLabels(surface, key, value, rule.members);
    }
  };
}

/**
 * Refuse a labels object's unknown member (naming the nearest one) and a
 * present member that is neither a template string nor a closure.
 * @param {string} surface @param {string} key the option's name
 * @param {any} labels @param {readonly string[]} names
 */
function checkLabels(surface, key, labels, names) {
  refuseUnknownMembers(labels, names,
    (member, hint) => new TypeError(`md ${surface}: unknown ${key} member '${member}'${hint}`));
  for (const member of Object.keys(labels)) {
    const label = labels[member];
    if (label !== undefined && typeof label !== 'string' && typeof label !== 'function') {
      throw new TypeError(`md ${surface}: ${key} member '${member}' must be a string or a function, `
        + `got ${describeValue(label)}`);
    }
  }
}
