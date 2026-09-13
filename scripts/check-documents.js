#!/usr/bin/env node
//@ts-check
/**
 * The document gate: every fenced block in the committed Markdown surface
 * that CLAIMS to be a parseable artifact is parsed.
 *
 *   node scripts/check-documents.js
 *
 * Two claims are checked, because two families of fence make one:
 *
 *  - ```` ```mermaid ```` — parsed through `@jarenjs/mermaid`. A diagram in
 *    a README is documentation that the suite's own parser can read; one
 *    that cannot be parsed is a picture of a promise. The site's embedded
 *    diagrams reach the same parser from the other side, through
 *    `test/website/documents.test.js` — the sources there live in
 *    JavaScript content modules, not in Markdown, so a file walk cannot
 *    see them. One parser, two entrances.
 *  - ```` ```json ```` — parsed with `JSON.parse`. A reader copies these.
 *    JSON-shaped **notation** — metavariables (`expr`, `v`), alternation
 *    (`"asc" | "desc"`), an elided tail (`…`), or comments — is fenced
 *    ```` ```jsonc ```` instead and is not parsed: it never claimed to be
 *    a value.
 *
 * The Markdown parser owns fence/container semantics. Source lines are
 * recovered lazily with prefix parses when a diagnostic needs an opener:
 * the fenced node first appears at EOF immediately after its opening line.
 */

import { readFileSync, globSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import { parseMermaid } from '@jarenjs/mermaid';
import { parseMarkdown, parseFrontmatter, walkAst } from '@jarenjs/md';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

/**
 * The committed Markdown surface. Workspace `site.md` documents are
 * included: they are rendered on the site, so a diagram in one is as
 * public as a diagram in a README.
 *
 * `test/**` is deliberately outside it. A fixture's job is sometimes to
 * be malformed — the collector's refusals are proven against documents
 * that cannot be parsed — so gating them would fail on the tests that
 * exist to prove the failure.
 */
const PATTERNS = [
  'README.md',
  'docs/**/*.md',
  'packages/*/*.md',
  'packages/*/docs/*.md',
  'components/*/*.md',
  'components/*/docs/*.md',
  'benchmark/*.md',
];

/** Language-tagged fences in source order, including container children. */
function codeFences(source) {
  const nodes = [];
  walkAst(parseMarkdown(source, { frontmatter: false }).ast, (node) => {
    if (node.type === 'code' && node.lang !== null) nodes.push(node);
  });
  return nodes;
}

/**
 * Every language-tagged fence, with a lazy 1-based opener line.
 * @param {string} source
 * @returns {{ lang: string, body: string, line: number }[]}
 */
export function fencesOf(source) {
  // Resolve frontmatter once: a later closing delimiter must not change what
  // an earlier prefix meant while locating a fence. No second fence grammar.
  const { body } = parseFrontmatter(source);
  const offset = source.slice(0, source.length - body.length).split(/\r\n|\n|\r/).length - 1;
  let lines;
  const counts = new Map();
  return codeFences(body).map((node, index) => {
    let line;
    return { lang: node.lang.toLowerCase(), body: node.value,
      get line() {
        if (line !== undefined) return line;
        lines ??= body.split(/\r\n|\n|\r/);
        let low = 1, high = lines.length;
        while (low < high) {
          const mid = Math.floor((low + high) / 2);
          if (!counts.has(mid)) counts.set(mid, codeFences(lines.slice(0, mid).join('\n')).length);
          if (counts.get(mid) > index) high = mid;
          else low = mid + 1;
        }
        line = offset + low;
        return line;
      },
    };
  });
}

/**
 * @typedef {object} DocumentReport
 * @property {number} code - 0 green, 1 failed
 * @property {number} files - documents walked
 * @property {number} mermaid - mermaid fences parsed
 * @property {number} json - json fences parsed
 * @property {string[]} failures - `file:line — message`, one per bad fence
 */

/**
 * Parse every checkable fence of every document.
 * @param {{ root?: string, patterns?: string[] }} [options]
 * @returns {DocumentReport}
 */
export function checkDocuments(options = {}) {
  const root = options.root ?? ROOT;
  const patterns = options.patterns ?? PATTERNS;
  const files = [...new Set(patterns.flatMap((p) => globSync(p, { cwd: root })))]
    .filter((f) => !f.includes('node_modules'))
    .sort();
  /** @type {string[]} */
  const failures = [];
  let mermaid = 0;
  let json = 0;
  for (const rel of files) {
    const source = readFileSync(resolve(root, rel), 'utf8');
    for (const fence of fencesOf(source)) {
      if (fence.lang === 'mermaid') {
        mermaid += 1;
        try {
          parseMermaid(fence.body);
        }
        catch (err) {
          failures.push(`${rel}:${fence.line} — mermaid: ${String(/** @type {any} */ (err)?.message ?? err)}`);
        }
      }
      else if (fence.lang === 'json') {
        json += 1;
        try {
          JSON.parse(fence.body);
        }
        catch (err) {
          failures.push(`${rel}:${fence.line} — json: ${String(/** @type {any} */ (err)?.message ?? err)}`
            + '\n    (JSON-shaped notation belongs in a ```jsonc fence, which this gate does not parse)');
        }
      }
    }
  }
  return { code: failures.length > 0 ? 1 : 0, files: files.length, mermaid, json, failures };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = checkDocuments();
  if (report.failures.length > 0) {
    console.error(`documents that do not parse (${report.failures.length}):\n\n`
      + `${report.failures.join('\n')}\n`);
    process.exit(1);
  }
  console.log(`documents parse: ${report.mermaid} mermaid + ${report.json} json fences `
    + `across ${report.files} committed markdown files.`);
}
