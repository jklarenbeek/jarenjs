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
 * The accessible name for a heading's permalink affordance — `#` alone
 * names nothing, so the link says which section it points at.
 * @param {string} text the heading's plain text (`textOf`)
 * @returns {string}
 */
export function permalinkLabel(text) {
  const trimmed = text.trim();
  return trimmed === '' ? 'Permalink to this section' : 'Permalink to ' + trimmed;
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
 * The rule one member of a closed option set must satisfy: what it
 * `expects`, as a refusal names it, the `test` a present value passes,
 * and — for a closed list of values — the `values` a refusal names the
 * nearest of.
 * @typedef {{ expects: string, test: (value: any) => boolean, values?: readonly string[] }} OptionRule
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
    }
  };
}
