//@ts-check
/**
 * @file The citation gate for `packages/linq/docs/`. Eleven documents
 * cite each other and are cited from JSDoc, declarations, READMEs, the
 * ROADMAP and other packages' format specs — 119 references at the time
 * this gate landed, and nothing held any of them true. A moved section or
 * a renamed file left a reader on a 404 and no test noticed.
 *
 * Four questions over every committed Markdown, JavaScript, TypeScript
 * and JSON file:
 *
 *  1. every reference to a file in `packages/linq/docs/` — a relative
 *     Markdown link, or a repo-relative path written out — names a file
 *     that exists;
 *  2. every `#anchor` on such a link names a heading that document
 *     carries, by GitHub's slug rule;
 *  3. every `§N` / `§N.M` citation whose sentence names one of those
 *     documents names a section number that document carries;
 *  4. the binder's index names every other document in the directory —
 *     the site reaches these files only through it, so a document the
 *     index omits is a document no reader of the site can open, and that
 *     failure is invisible in every other gate.
 *
 * Scope is citations INTO `packages/linq/docs/`. The repository's other
 * format documents are cited the same way and are not checked here;
 * widening the walk is its own piece of work and belongs on the ROADMAP
 * rather than in a silent extension of this file.
 *
 * The floors below are the defence the walk shares with the document gate
 * (`test/scripts/release-tooling.test.js`) and the section slicer
 * (`test/format-sections.js`): a matcher that has stopped matching finds
 * nothing and passes everything, so what was checked is asserted too.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DOCS = 'packages/linq/docs';
const BINDER = 'LINQ-FORMAT.md';

/** The documents themselves, read from the directory — never a list. */
const documents = fs.readdirSync(path.join(ROOT, DOCS)).filter((f) => f.endsWith('.md')).sort();

/**
 * Enumerated by `git ls-files`, so a gitignored scratch file is never
 * read and a new document that was never staged is caught by the walk
 * rather than silently satisfying a link to it.
 */
const FILES = execFileSync('git', ['ls-files', '*.md', '*.js', '*.ts', '*.json'],
  { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  .split('\n').filter(Boolean);

/** GitHub's heading slug, as the anchors in this repository spell it. */
function slugOf(heading) {
  return heading.toLowerCase().replace(/[^\w\- ]/g, '').trim().replace(/ /g, '-');
}

/** Every anchor and every section number one document publishes. */
function headingsOf(rel) {
  const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const anchors = new Set();
  const sections = new Set();
  for (const match of text.matchAll(/^#{1,6} +(.+?)\s*$/gm)) {
    anchors.add(slugOf(match[1]));
    const numbered = /^(\d+(?:\.\d+)*)[.  ]/.exec(match[1]);
    if (numbered) sections.add(numbered[1]);
  }
  return { anchors, sections };
}

const HEADINGS = new Map(documents.map((doc) => [doc, headingsOf(`${DOCS}/${doc}`)]));

/** The 1-based line an offset sits on. */
const lineAt = (text, index) => text.slice(0, index).split('\n').length;

/** A document stem cited in prose (`QUERY-PEN`, `QUERY-PEN.md`). */
const STEMS = documents.map((doc) => doc.slice(0, -3));
/** Another document's name between a stem and a `§` means the `§` is not
 * this document's — `QUERY-PEN.md §4, QUERY-FORMAT.md §§8.13` cites two. */
const OTHER_DOC = /[A-Z][A-Z0-9]+-[A-Z0-9]+/;

const failures = [];
let links = 0;
let anchors = 0;
let sections = 0;
const citing = new Set();

for (const file of FILES) {
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
  if (!text.includes('linq/docs') && !STEMS.some((stem) => text.includes(stem))) continue;
  const dir = path.dirname(file);
  const fail = (index, citation, reason) =>
    failures.push(`${file}:${lineAt(text, index)}  ${citation} — ${reason}`);

  // 1 + 2. every reference to a file of the directory, and its anchor
  const refs = [
    // a Markdown link, resolved against the linking file's own directory
    ...[...text.matchAll(/\]\(([^)\s#]+\.md)(#[^)\s]*)?\)/g)]
      .map((m) => ({ index: m.index, cited: m[0], target: path.posix.normalize(
        path.posix.join(dir === '.' ? '' : dir, m[1])), anchor: m[2] })),
    // a repo-relative path written out, in a comment or in backticks
    ...[...text.matchAll(/(packages\/linq\/docs\/[A-Za-z0-9._-]+\.md)/g)]
      .map((m) => ({ index: m.index, cited: m[1], target: m[1], anchor: undefined })),
  ].filter((ref) => ref.target.startsWith(`${DOCS}/`));

  for (const ref of refs) {
    links += 1;
    citing.add(file);
    const doc = ref.target.slice(DOCS.length + 1);
    if (!HEADINGS.has(doc)) {
      fail(ref.index, ref.cited, `no such document — ${DOCS}/ holds ${documents.join(', ')}`);
      continue;
    }
    if (ref.anchor === undefined) continue;
    anchors += 1;
    const id = ref.anchor.slice(1);
    if (!HEADINGS.get(doc).anchors.has(id))
      fail(ref.index, ref.cited, `${doc} carries no heading with the id '${id}'`);
  }

  // 3. every `§N` citation whose sentence names one of the documents
  for (const stem of STEMS) {
    const carried = HEADINGS.get(`${stem}.md`).sections;
    for (const named of text.matchAll(new RegExp(`${stem}(?:\\.md)?([^)\\n]{0,40}?)§+ ?(\\d+(?:\\.\\d+)*)((?:,? (?:and )?§+ ?\\d+(?:\\.\\d+)*)*)`, 'g'))) {
      if (OTHER_DOC.test(named[1])) continue;
      citing.add(file);
      for (const cited of [named[2], ...[...named[3].matchAll(/(\d+(?:\.\d+)*)/g)].map((m) => m[1])]) {
        sections += 1;
        if (!carried.has(cited))
          fail(named.index, `${stem} §${cited}`,
            `${stem}.md carries no §${cited} (it has §${[...carried].join(', §')})`);
      }
    }
  }
}

describe('every citation into packages/linq/docs resolves', () => {
  it('names a document that exists, an anchor it carries and a section it publishes', () => {
    assert.deepStrictEqual(failures, []);
  });

  it('checked enough to have failed', () => {
    // a matcher that stopped matching reports nothing and passes
    assert.ok(links + sections >= 290,
      `only ${links + sections} citations (${links} links, ${anchors} of them anchored, ${sections} sections)`);
    assert.ok(citing.size >= 50, `only ${citing.size} files cite these documents`);
    assert.strictEqual(documents.length, 11, `${DOCS} holds ${documents.length} documents`);
  });
});

describe('the binder indexes every document beside it', () => {
  // The site reaches these files through one path: the docs page opens
  // the linq README, the README links the binder, the binder links the
  // rest. A document the binder does not name is unreachable there.
  it('links each one, so a reader on the site can open it', () => {
    const binder = fs.readFileSync(path.join(ROOT, DOCS, BINDER), 'utf8');
    // §1's opening, where the index sits — not the whole file: the
    // disposition table below it links nine of the same documents, and
    // a check that counted those would pass over an emptied index.
    const index = binder.slice(0, binder.indexOf('\n### '));
    assert.notStrictEqual(index, '', `${BINDER} has no §1 opening to index in`);
    const linked = new Set([...index.matchAll(/\]\(([A-Za-z0-9._-]+\.md)\)/g)].map((m) => m[1]));
    assert.deepStrictEqual(documents.filter((doc) => doc !== BINDER && !linked.has(doc)), [],
      `${BINDER}'s index does not link these`);
  });

  // The index states each document's length, which is what tells a
  // reader whether they are opening a ten-minute read or an afternoon.
  // A stated length is a figure like any other: derived, never typed
  // (CONVENTIONS.md §4.6), so it is compared with the file here rather
  // than trusted. Every document in the directory must have a row,
  // including the binder's own.
  it('states each document\'s length, and the length is the file\'s', () => {
    const binder = fs.readFileSync(path.join(ROOT, DOCS, BINDER), 'utf8');
    const index = binder.slice(0, binder.indexOf('\n### '));
    const stated = new Map([...index.matchAll(/^\| \[([A-Za-z0-9._-]+\.md)\][^|]*\| ([\d,]+) \|/gm)]
      .map((m) => [m[1], Number(m[2].replace(/,/g, ''))]));
    const wrong = documents.map((doc) => {
      const lines = fs.readFileSync(path.join(ROOT, DOCS, doc), 'utf8').split('\n').length - 1;
      const said = stated.get(doc);
      return said === lines ? null
        : `${doc}: the index says ${said ?? '(no row)'}, the file is ${lines} lines`;
    }).filter((problem) => problem !== null);
    assert.deepStrictEqual(wrong, [], `${BINDER}'s index is stale`);
  });
});
