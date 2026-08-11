//@ts-check
/**
 * @file mdx = markdown × data. A markdown document renders DYNAMICALLY
 * against a data document: inline interpolation, conditional sections
 * and repeated sections, all driven by the data — still a pure
 * `(doc, data) → doc` transform over the parsed AST, so everything
 * downstream (`mdToVnode`, `toMarkdown`, the plugins) works unchanged.
 *
 * The template vocabulary reuses the suite's own query expressions —
 * no new mini-language:
 *
 *  - `{$.path}` inline in TEXT interpolates a query expression over the
 *    data (`$` is the data document; `$name` externals come from the
 *    frontmatter and the enclosing `each` bindings). Code spans, code
 *    blocks and raw HTML never interpolate.
 *  - a paragraph of exactly `{#if <expr>}` … `{/if}` keeps its section
 *    only when the expression is truthy (the query engine's boolean
 *    view: null/false/''/0/[] are false).
 *  - a paragraph of exactly `{#each <expr> as <name>}` … `{/each}`
 *    repeats its section once per item, binding each as the external
 *    `$<name>`. Sections nest.
 *
 * A directive must form its OWN paragraph — surround it with blank
 * lines, or markdown's lazy continuation folds the next line into it
 * and the directive reads as plain text.
 *
 * The expression COMPILER is injected (`compileJsonQuery` from
 * `@jarenjs/json`), so this package's engine layer keeps its
 * core+view-only dependency contract — the same seam philosophy the
 * play surface uses for its renderers.
 */

import { frontmatterExternals } from './compiler.js';
import { replaceDirectives } from './directives.js';

const OPEN_IF = /^\{#if\s+(.+)\}$/;
const OPEN_EACH = /^\{#each\s+(.+)\s+as\s+([A-Za-z_]\w*)\}$/;
const CLOSE = /^\{\/(if|each)\}$/;
const OPEN_ANY = /^\{#(if|each)\b/;
const INLINE = /\{(\$[^{}]*)\}/g;

/** The directive text of a paragraph that is EXACTLY one text node, or null. */
function directiveText(node) {
  if (node === null || typeof node !== 'object' || node.type !== 'paragraph') return null;
  const children = node.children;
  if (!Array.isArray(children) || children.length !== 1) return null;
  const only = children[0];
  if (only === null || typeof only !== 'object' || only.type !== 'text') return null;
  return typeof only.value === 'string' ? only.value.trim() : null;
}

/** The query engine's boolean view of a value (an `#if` verdict). */
function truthy(value) {
  if (value === undefined || value === null || value === false) return false;
  if (value === '' || value === 0) return false;
  if (typeof value === 'number' && Number.isNaN(value)) return false;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/** An interpolated value → the text that replaces its `{…}` span. */
function stringify(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    try { return JSON.stringify(value); } catch { return String(value); }
  }
  return String(value);
}

/** Node types whose `value` is literal — never interpolated. */
const LITERAL = new Set(['code', 'inlineCode', 'html', 'math', 'inlineMath']);

/**
 * Build the mdx transformer around an injected expression compiler.
 * @param {{ compileQuery: (expr: string) => (data: any, externals?: any) => any }} options
 *   `compileQuery` compiles one query expression (e.g. `compileJsonQuery`
 *   from `@jarenjs/json`); compiled expressions are cached per source text
 * @returns {{ transform: (doc: any, data: any) => any }}
 *   `transform(doc, data)` — a parsed markdown doc + a data document in,
 *   a NEW doc (directives resolved, text interpolated) out; never throws
 *   on a bad expression — the error message renders in place, honestly
 */
export function createMdx(options) {
  const compileQuery = options?.compileQuery;
  if (typeof compileQuery !== 'function') {
    throw new TypeError('createMdx needs options.compileQuery — inject a query compiler (compileJsonQuery from @jarenjs/json)');
  }
  /** @type {Map<string, any>} compiled-expression cache, keyed by source */
  const cache = new Map();
  const compile = (expr) => {
    let compiled = cache.get(expr);
    if (compiled === undefined) {
      compiled = compileQuery(expr);
      cache.set(expr, compiled);
    }
    return compiled;
  };

  /** Evaluate one expression; `{ value }` or `{ error }` — never a throw. */
  const evaluate = (expr, data, externals) => {
    try { return { value: compile(expr)(data, externals) }; }
    catch (err) { return { error: String(/** @type {any} */ (err)?.message ?? err) }; }
  };

  /** One text value with its `{$…}` spans interpolated. */
  const interpolateText = (text, data, externals) =>
    text.replace(INLINE, (span, expr) => {
      const out = evaluate(expr, data, externals);
      return out.error !== undefined ? `⟨mdx: ${out.error}⟩` : stringify(out.value);
    });

  /** One inline/leaf node, interpolated (containers recurse). */
  const interpolateNode = (node, data, externals) => {
    if (node === null || typeof node !== 'object') return node;
    if (LITERAL.has(node.type)) return node;
    if (node.type === 'text' && typeof node.value === 'string') {
      const value = interpolateText(node.value, data, externals);
      return value === node.value ? node : { ...node, value };
    }
    if (Array.isArray(node.children)) {
      return { ...node, children: transformBlocks(node.children, data, externals) };
    }
    return node;
  };

  /** Find the index of the section's matching close directive. */
  const findClose = (nodes, from, kind) => {
    let depth = 0;
    for (let i = from; i < nodes.length; i++) {
      const text = directiveText(nodes[i]);
      if (text === null) continue;
      if (OPEN_ANY.test(text)) { depth += 1; continue; }
      const close = CLOSE.exec(text);
      if (close === null) continue;
      if (depth === 0) return close[1] === kind ? i : -1;
      depth -= 1;
    }
    return -1;
  };

  /** A block list with its directives resolved and its text interpolated. */
  const transformBlocks = (nodes, data, externals) => {
    /** @type {any[]} */
    const out = [];
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      const text = directiveText(node);
      if (text !== null) {
        const eachOpen = OPEN_EACH.exec(text);
        if (eachOpen !== null) {
          const end = findClose(nodes, i + 1, 'each');
          if (end === -1) { out.push(errorBlock(`unclosed {#each} — missing {/each}`)); break; }
          const body = nodes.slice(i + 1, end);
          const result = evaluate(eachOpen[1], data, externals);
          if (result.error !== undefined) out.push(errorBlock(`mdx: ${result.error}`));
          else {
            const items = Array.isArray(result.value)
              ? result.value
              : result.value === undefined || result.value === null ? [] : [result.value];
            for (const item of items) {
              out.push(...transformBlocks(body, data, { ...externals, [eachOpen[2]]: item }));
            }
          }
          i = end;
          continue;
        }
        const ifOpen = OPEN_IF.exec(text);
        if (ifOpen !== null) {
          const end = findClose(nodes, i + 1, 'if');
          if (end === -1) { out.push(errorBlock(`unclosed {#if} — missing {/if}`)); break; }
          const result = evaluate(ifOpen[1], data, externals);
          if (result.error !== undefined) out.push(errorBlock(`mdx: ${result.error}`));
          else if (truthy(result.value)) {
            out.push(...transformBlocks(nodes.slice(i + 1, end), data, externals));
          }
          i = end;
          continue;
        }
        if (CLOSE.test(text)) {
          // a stray close directive: surface it rather than swallow it
          out.push(errorBlock(`stray ${text} — no matching opener`));
          continue;
        }
      }
      out.push(interpolateNode(node, data, externals));
    }
    return out;
  };

  return {
    /**
     * The pure mdx pass: a parsed markdown doc + a data document in, a
     * new doc out (the input doc is never mutated). The frontmatter's
     * members bind as externals, exactly as they do for JSLT.
     * @param {any} doc - a `parseMarkdown` / `compileMarkdown(...).doc` document
     * @param {any} data - the data document `$` addresses
     */
    transform(doc, data) {
      const externals = frontmatterExternals(doc?.frontmatter ?? null);
      // The comment spelling first: it resolves to TEXT nodes, which the
      // brace pass then leaves alone (an interpolated value is never
      // re-read as a template, in either spelling — that is the whole
      // safety property). One evaluator serves both; only the carrier
      // differs.
      const resolved = replaceDirectives(doc?.ast ?? [], { ns: 'mdx' }, (directive) => {
        const out = evaluate(directive.key, data, externals);
        const value = out.error !== undefined ? `⟨mdx: ${out.error}⟩` : stringify(out.value);
        return [{ type: 'text', value }];
      });
      return { ...doc, ast: transformBlocks(resolved, data, externals) };
    },
  };
}

/** A visible error paragraph — a bad template renders its diagnosis. */
function errorBlock(message) {
  return { type: 'paragraph', children: [{ type: 'text', value: `⟨${message}⟩` }] };
}
