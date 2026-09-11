//@ts-check
/**
 * @file The citation gate for every format document in the repository.
 * The normative documents — every committed `*-FORMAT.md` and the
 * `packages/linq/docs/` pens beside their binder — cite each other and
 * are cited from JSDoc, declarations, READMEs, schemas, the ROADMAP and
 * one another: hundreds of references, and a moved section or a renamed
 * file leaves a reader on a 404 that no other gate notices.
 *
 * Four questions over every committed Markdown, JavaScript, TypeScript
 * and JSON file:
 *
 *  1. every reference to one of these documents — a relative Markdown
 *     link, or a repo-relative path written out — names a file that
 *     exists;
 *  2. every `#anchor` on such a link names a heading that document
 *     carries, by GitHub's slug rule — including a same-file `](#…)`
 *     inside one of the documents themselves, which carries no path and
 *     so never enters the link matcher;
 *  3. every `§N` / `§N.M` citation whose sentence names one of the
 *     documents by its stem names a section number that document carries
 *     — whether it numbers its headings `## 7. Title` or `## §7 Title`;
 *  4. the linq binder's index names every other document in its
 *     directory — the site reaches those files only through it.
 *
 * The documents are DISCOVERED from `git ls-files`, never listed, and a
 * basename that two documents share would make a stem citation ambiguous,
 * so that is refused too. There is no grandfather list: a stale citation
 * is fixed at its source.
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
const LINQ_DOCS = 'packages/linq/docs';
const BINDER = 'LINQ-FORMAT.md';

/**
 * Enumerated by `git ls-files`, so a gitignored scratch file is never
 * read and a new document that was never staged is caught by the walk
 * rather than silently satisfying a link to it.
 */
const FILES = execFileSync('git', ['ls-files', '*.md', '*.js', '*.ts', '*.json'],
  { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  .split('\n').filter(Boolean)
  // a file deleted in the working tree is still listed until its commit
  .filter((file) => fs.existsSync(path.join(ROOT, file)));

/**
 * The format documents: every committed `<STEM>-FORMAT.md`, plus every
 * document of the linq pen directory (cited by stem the same way). A
 * bare `FORMAT.md` (the JOSL format) is a document but has no stem a
 * sentence can cite unambiguously, so it takes part in the link and
 * anchor checks only.
 */
const DOCUMENTS = FILES.filter((file) => /(^|\/)[A-Z][A-Z0-9-]*-FORMAT\.md$/.test(file)
  || /(^|\/)FORMAT\.md$/.test(file)
  || (file.startsWith(`${LINQ_DOCS}/`) && file.endsWith('.md'))).sort();

/** GitHub's heading slug, as the anchors in this repository spell it. */
function slugOf(heading) {
  return heading.toLowerCase().replace(/[^\w\- ]/g, '').trim().replace(/ /g, '-');
}

/**
 * Every anchor and every section number one document publishes. A
 * section number is `7`, `7.5` — written `## 7. Title`, `## 7 Title` or
 * `## §7 Title`, the three numbering styles the documents use.
 */
function headingsOf(rel) {
  const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const anchors = new Set();
  const sections = new Set();
  for (const match of text.matchAll(/^#{1,6} +(.+?)\s*$/gm)) {
    anchors.add(slugOf(match[1]));
    const numbered = /^§?(\d+(?:\.\d+)*)[.:  ]/.exec(match[1]);
    if (numbered) sections.add(numbered[1]);
  }
  return { anchors, sections };
}

const HEADINGS = new Map(DOCUMENTS.map((doc) => [doc, headingsOf(doc)]));

/** Documents by basename: the stem a sentence cites must be one file. */
const BY_BASENAME = new Map();
for (const doc of DOCUMENTS) {
  const base = path.basename(doc);
  if (!BY_BASENAME.has(base)) BY_BASENAME.set(base, []);
  BY_BASENAME.get(base).push(doc);
}
const AMBIGUOUS = [...BY_BASENAME].filter(([, docs]) => docs.length > 1).map(([base, docs]) => `${base}: ${docs.join(', ')}`);

/** The 1-based line an offset sits on. */
const lineAt = (text, index) => text.slice(0, index).split('\n').length;

/** A document stem cited in prose (`QUERY-PEN`, `MODEL-FORMAT.md`). */
const STEMS = [...BY_BASENAME.keys()].filter((base) => base !== 'FORMAT.md').map((base) => base.slice(0, -3));
/** Another document's name between a stem and a `§` means the `§` is not
 * this document's — `QUERY-PEN.md §4, QUERY-FORMAT.md §§8.13` cites two. */
const OTHER_DOC = /[A-Z][A-Z0-9]+-[A-Z0-9]+/;
/** The stems of the linq directory, for the binder question. */
const LINQ_DOCUMENTS = DOCUMENTS.filter((doc) => doc.startsWith(`${LINQ_DOCS}/`)).map((doc) => path.basename(doc));

const failures = [];
let links = 0;
let anchors = 0;
let selfAnchors = 0;
let sections = 0;
const citing = new Set();
const citedDocuments = new Set();

for (const file of FILES) {
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
  if (!text.includes('FORMAT') && !text.includes('linq/docs') && !STEMS.some((stem) => text.includes(stem))) continue;
  const dir = path.dirname(file);
  const fail = (index, citation, reason) =>
    failures.push(`${file}:${lineAt(text, index)}  ${citation} — ${reason}`);

  // 1 + 2. every reference to a document, and its anchor
  const refs = [
    // a Markdown link, resolved against the linking file's own directory
    ...[...text.matchAll(/\]\(([^)\s#]+\.md)(#[^)\s]*)?\)/g)]
      .filter((m) => !/^[a-z]+:/.test(m[1]))
      .map((m) => ({ index: m.index, cited: m[0], target: path.posix.normalize(
        path.posix.join(dir === '.' ? '' : dir, m[1])), anchor: m[2] })),
    // a repo-relative path written out, in a comment or in backticks
    ...[...text.matchAll(/((?:packages|components)\/[A-Za-z0-9._/-]+?(?:-FORMAT|\/FORMAT|-PEN|DB-CLIENT)\.md)/g)]
      .map((m) => ({ index: m.index, cited: m[1], target: m[1], anchor: undefined })),
  ].filter((ref) => HEADINGS.has(ref.target) || /(-FORMAT|\/FORMAT|-PEN|\/DB-CLIENT)\.md$/.test(ref.target));

  for (const ref of refs) {
    links += 1;
    citing.add(file);
    if (!HEADINGS.has(ref.target)) {
      fail(ref.index, ref.cited, 'no such document — the committed format documents are '
        + DOCUMENTS.map((doc) => path.basename(doc)).join(', '));
      continue;
    }
    citedDocuments.add(ref.target);
    if (ref.anchor === undefined) continue;
    anchors += 1;
    const id = ref.anchor.slice(1);
    if (!HEADINGS.get(ref.target).anchors.has(id))
      fail(ref.index, ref.cited, `${ref.target} carries no heading with the id '${id}'`);
  }

  // 2b. a same-file fragment inside one of the documents themselves
  if (HEADINGS.has(file)) {
    const own = HEADINGS.get(file);
    for (const m of text.matchAll(/\]\(#([^)\s]+)\)/g)) {
      selfAnchors += 1;
      citing.add(file);
      if (!own.anchors.has(m[1]))
        fail(m.index, `](#${m[1]})`, `${file} carries no heading with the id '${m[1]}'`);
    }
  }

  // 3. every `§N` citation whose sentence names one of the documents
  for (const stem of STEMS) {
    if (!text.includes(stem)) continue;
    const doc = BY_BASENAME.get(`${stem}.md`)[0];
    const carried = HEADINGS.get(doc).sections;
    for (const named of text.matchAll(new RegExp(`(?<![A-Z0-9-])${stem}(?:\\.md)?([^)\\n]{0,40}?)§+ ?(\\d+(?:\\.\\d+)*)((?:,? (?:and )?§+ ?\\d+(?:\\.\\d+)*)*)`, 'g'))) {
      if (OTHER_DOC.test(named[1])) continue;
      citing.add(file);
      citedDocuments.add(doc);
      for (const cited of [named[2], ...[...named[3].matchAll(/(\d+(?:\.\d+)*)/g)].map((m) => m[1])]) {
        sections += 1;
        if (!carried.has(cited))
          fail(named.index, `${stem} §${cited}`,
            `${doc} carries no §${cited} (it has §${[...carried].join(', §')})`);
      }
    }
  }
}

describe('every citation into every format document resolves', () => {
  it('discovers the documents from git, and no two share a basename', () => {
    assert.ok(DOCUMENTS.length >= 25, `only ${DOCUMENTS.length} format documents discovered`);
    assert.ok(DOCUMENTS.filter((doc) => doc.endsWith('-FORMAT.md')).length >= 15);
    assert.deepStrictEqual(AMBIGUOUS, [], 'a stem cited in prose must name one document');
  });

  it('names a document that exists, an anchor it carries and a section it publishes', () => {
    assert.deepStrictEqual(failures, []);
  });

  it('checked enough to have failed', () => {
    // a matcher that stopped matching reports nothing and passes
    assert.ok(links >= 400, `only ${links} links`);
    assert.ok(anchors >= 60, `only ${anchors} anchored links`);
    assert.ok(sections >= 800, `only ${sections} section citations`);
    assert.ok(selfAnchors >= 20, `only ${selfAnchors} same-file anchors — the documents carry dozens`);
    assert.ok(citing.size >= 250, `only ${citing.size} files cite these documents`);
    assert.ok(citedDocuments.size >= 20, `only ${citedDocuments.size} of ${DOCUMENTS.length} documents are cited anywhere`);
  });
});

describe('the linq binder indexes every document beside it', () => {
  // The site reaches these files through one path: the docs page opens
  // the linq README, the README links the binder, the binder links the
  // rest. A document the binder does not name is unreachable there.
  it('links each one, so a reader on the site can open it', () => {
    assert.strictEqual(LINQ_DOCUMENTS.length, 17, `${LINQ_DOCS} holds ${LINQ_DOCUMENTS.length} documents`);
    const binder = fs.readFileSync(path.join(ROOT, LINQ_DOCS, BINDER), 'utf8');
    // §1's opening, where the index sits — not the whole file: the
    // disposition table below it links nine of the same documents, and
    // a check that counted those would pass over an emptied index.
    const index = binder.slice(0, binder.indexOf('\n### '));
    assert.notStrictEqual(index, '', `${BINDER} has no §1 opening to index in`);
    const linked = new Set([...index.matchAll(/\]\(([A-Za-z0-9._-]+\.md)\)/g)].map((m) => m[1]));
    assert.deepStrictEqual(LINQ_DOCUMENTS.filter((doc) => doc !== BINDER && !linked.has(doc)), [],
      `${BINDER}'s index does not link these`);
  });

  // The index states each document's length, which is what tells a
  // reader whether they are opening a ten-minute read or an afternoon.
  // A stated length is a figure like any other: derived, never typed
  // (CONVENTIONS.md §4.6), so it is compared with the file here rather
  // than trusted. Every document in the directory must have a row,
  // including the binder's own.
  it('states each document\'s length, and the length is the file\'s', () => {
    const binder = fs.readFileSync(path.join(ROOT, LINQ_DOCS, BINDER), 'utf8');
    const index = binder.slice(0, binder.indexOf('\n### '));
    const stated = new Map([...index.matchAll(/^\| \[([A-Za-z0-9._-]+\.md)\][^|]*\| ([\d,]+) \|/gm)]
      .map((m) => [m[1], Number(m[2].replace(/,/g, ''))]));
    const wrong = LINQ_DOCUMENTS.map((doc) => {
      const lines = fs.readFileSync(path.join(ROOT, LINQ_DOCS, doc), 'utf8').split('\n').length - 1;
      const said = stated.get(doc);
      return said === lines ? null
        : `${doc}: the index says ${said ?? '(no row)'}, the file is ${lines} lines`;
    }).filter((problem) => problem !== null);
    assert.deepStrictEqual(wrong, [], `${BINDER}'s index is stale`);
  });
});
