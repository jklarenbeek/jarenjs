//@ts-check
/**
 * @file `bake` — write a derived value back into the source text.
 *
 * A directive carries a value a machine derives and a human reads
 * (directives.js). Baking materializes the current value INTO the
 * committed file, which is the whole point: the document needs no
 * runtime, GitHub renders it correctly, and the next re-derivation shows
 * up as a diff a reviewer can look at instead of a number that quietly
 * stopped being true.
 *
 * Two properties make it usable on documents people wrote by hand:
 *
 *  - **byte-local.** Only the spans between markers change. `toMarkdown`
 *    is a canonicalizing printer, so re-printing a README would reflow
 *    every list and re-wrap every table — correct markdown, and a diff
 *    nobody can review. So `bake` splices the SOURCE, and a document
 *    with no directives comes back the same bytes it went in as.
 *  - **idempotent.** Baking an already-baked document changes nothing,
 *    which is what lets a `--check` mode be "bake and compare".
 *
 * The trust level is different from mdx's, and the difference is the
 * point: an mdx interpolation lands in a TEXT node and is never re-read
 * as markdown, because it may carry untrusted data. A baked body is
 * spliced into the source and WILL be re-parsed as markdown — a fact
 * that is a whole table is exactly the use case. `bake` is therefore a
 * build-time tool for input you control, and it says so here rather than
 * leaving the two to be confused.
 */

import { parseMarkdown } from './parser.js';
import { scanDirectives, scanSourceDirectives } from './directives.js';

/**
 * @typedef {{ text: string, changed: boolean, diagnostics: string[],
 *   applied: { key: string, from: string, to: string }[] }} BakeResult
 */

/**
 * Replace every directive body in `source` with a freshly resolved
 * value.
 *
 * `resolve(key, directive)` returns the text to place between the
 * markers, or `undefined` to leave that directive untouched. Throwing is
 * allowed and is reported as a diagnostic — one bad derivation must not
 * cost the rest of the document.
 *
 * @param {string} source the document text
 * @param {{ ns: string, resolve: (key: string, directive: any) => (string|undefined),
 *   parseOptions?: any }} options
 * @returns {BakeResult}
 */
export function bake(source, options) {
  const ns = options.ns;
  const resolve = options.resolve;
  /** @type {string[]} */
  const diagnostics = [];
  /** @type {{ key: string, from: string, to: string }[]} */
  const applied = [];

  const found = scanSourceDirectives(source, { ns });
  diagnostics.push(...found.diagnostics);

  // The source says where a directive lives; the PARSED DOCUMENT says
  // whether the renderer will see one there. They disagree in exactly
  // one situation that matters, and it is a trap worth naming loudly:
  // a marker that BEGINS A LINE inside a paragraph opens a CommonMark
  // HTML block, which swallows the rest of that line. The bytes still
  // bake correctly and the file still looks right — and every renderer
  // then drops or escapes the whole line, so the sentence the marker
  // was carrying a number for disappears. Bake it, and say so.
  const parsed = scanDirectives(
    parseMarkdown(source, { ...options.parseOptions, frontmatter: false }), { ns });
  diagnostics.push(...parsed.diagnostics.filter((d) => !found.diagnostics.includes(d)));
  let seen = 0;
  for (const directive of found.directives) {
    if (seen < parsed.directives.length && parsed.directives[seen].key === directive.key) {
      seen++;
      continue;
    }
    diagnostics.push(`${directive.key}: the marker is not an inline directive in the parsed`
      + ' document — a marker that starts a line opens an HTML block and swallows the rest'
      + ' of that line. Put text before it, or give it a paragraph of its own.');
  }

  // right to left, so each splice leaves earlier offsets valid
  let text = source;
  for (let i = found.directives.length - 1; i >= 0; i--) {
    const directive = found.directives[i];
    let value;
    try {
      value = resolve(directive.key, directive);
    }
    catch (err) {
      diagnostics.push(`${directive.key}: resolver threw — ${String(/** @type {any} */ (err)?.message ?? err)}`);
      continue;
    }
    if (value === undefined) continue;
    if (value === directive.body) continue;
    applied.unshift({ key: directive.key, from: directive.body, to: value });
    text = text.slice(0, directive.bodyStart) + value + text.slice(directive.bodyEnd);
  }
  return { text, changed: text !== source, diagnostics, applied };
}
