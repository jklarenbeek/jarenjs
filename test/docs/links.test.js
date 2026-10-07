//@ts-check
/**
 * @file Every relative link in the committed Markdown reaches something,
 * and the workflow documents name only files and scripts that exist.
 *
 * A link to a file that moved, or to a heading that was renamed, is a dead
 * end a reader discovers only by following it. Documents are parsed with
 * `@jarenjs/md`, so a code span or a fence is not a link; a relative
 * target must be a file or directory of this checkout, and a `#fragment`
 * into a Markdown document must be an id the md engine mints for one of
 * its headings — the GitHub-style slug both GitHub and the site use — or
 * an explicit `id`/`name` anchor. A site route (`#/play?engine=…`) belongs
 * to the site, not to a document, and is not checked here.
 *
 * The workflow documents are what a fresh session is handed, so every
 * repository path they spell in backticks and every `npm run` script they
 * name must exist — examples included.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseMarkdown, parseFrontmatter, walkAst, toHtml } from '@jarenjs/md';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (/** @type {string} */ rel) => readFileSync(ROOT + rel, 'utf8');

/** Every file of this checkout, tracked or newly authored, that exists. */
const FILES = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'],
  { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  .split('\n').filter((file) => file !== '' && existsSync(ROOT + file));
const files = new Set(FILES);
const directories = new Set();
for (const file of FILES) {
  for (let dir = posix.dirname(file); dir !== '.' && !directories.has(dir); dir = posix.dirname(dir)) directories.add(dir);
}
const exists = (/** @type {string} */ rel) => files.has(rel) || directories.has(rel);

/** A document's Markdown AST, frontmatter set aside. @param {string} rel */
const parse = (rel) => parseMarkdown(parseFrontmatter(read(rel)).body, { frontmatter: false });

/** @type {Map<string, Set<string>>} */
const anchors = new Map();
/** The ids a document's headings and explicit anchors offer. @param {string} rel @returns {Set<string>} */
function anchorsOf(rel) {
  let ids = anchors.get(rel);
  if (ids === undefined) {
    const html = toHtml(parse(rel), { headingIds: true, html: 'raw' });
    ids = new Set([...html.matchAll(/\s(?:id|name)="([^"]*)"/g)].map((match) => match[1]));
    anchors.set(rel, ids);
  }
  return ids;
}

describe('documentation links and names', () => {
  it('every relative link reaches a file of this checkout, and every fragment a heading or anchor of its document', () => {
    const documents = FILES.filter((file) => file.endsWith('.md') && !file.startsWith('test/'));
    /** @type {string[]} */
    const dead = [];
    let links = 0;
    for (const doc of documents) {
      walkAst(parse(doc).ast, (/** @type {any} */ node) => {
        if ((node.type !== 'link' && node.type !== 'image') || typeof node.url !== 'string') return;
        const url = node.url;
        // absolute URLs, the site's own routes and a bare `#` are not this checkout's to resolve
        if (url === '' || url === '#' || /^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('//') || url.startsWith('#/')) return;
        links++;
        const hash = url.indexOf('#');
        const pathPart = decodeURI(hash < 0 ? url : url.slice(0, hash)).replace(/\?.*$/, '');
        const fragment = hash < 0 ? '' : decodeURIComponent(url.slice(hash + 1));
        const target = (pathPart === '' ? doc
          : pathPart.startsWith('/') ? posix.normalize(pathPart.slice(1))
          : posix.normalize(posix.join(posix.dirname(doc), pathPart))).replace(/\/$/, '');
        if (!exists(target)) dead.push(`${doc}: ${url} — no such file or directory`);
        else if (fragment !== '' && target.endsWith('.md') && !anchorsOf(target).has(fragment) && !anchorsOf(target).has(fragment.toLowerCase()))
          dead.push(`${doc}: ${url} — no such heading or anchor in ${target}`);
      });
    }
    assert.ok(links > 500, `followed ${links} relative links`);
    assert.deepStrictEqual(dead, []);
  });

  it('the workflow documents name only repository paths and npm scripts that exist', () => {
    const root = JSON.parse(read('package.json'));
    const scripts = new Set(Object.keys(root.scripts));
    for (const workspace of root.workspaces) {
      for (const name of Object.keys(JSON.parse(read(`${workspace.replace(/^\.\//, '')}/package.json`)).scripts ?? {})) scripts.add(name);
    }
    /** @type {string[]} */
    const missing = [];
    let named = 0;
    for (const doc of FILES.filter((file) => file.startsWith('docs/workflow/') && file.endsWith('.md'))) {
      read(doc).split('\n').forEach((line, index) => {
        for (const match of line.matchAll(/`((?:packages|components|test|scripts|benchmark|docs|\.github|docker)\/[\w./@-]+)`/g)) {
          named++;
          const rel = match[1].replace(/[.,;:]+$/, '').replace(/\/$/, '');
          if (!exists(rel)) missing.push(`${doc}:${index + 1} ${rel}`);
        }
        for (const match of line.matchAll(/\bnpm run ([\w:.-]+)/g)) {
          named++;
          if (!scripts.has(match[1])) missing.push(`${doc}:${index + 1} npm run ${match[1]}`);
        }
      });
    }
    assert.ok(named > 50, `checked ${named} names`);
    assert.deepStrictEqual(missing, []);
  });
});
