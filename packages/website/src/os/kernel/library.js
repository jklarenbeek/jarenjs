//@ts-check
/**
 * The Library: the documentation as something to read, to listen to and
 * to talk with. At build time `markdownSections` cuts each Markdown
 * document into sections of plain text (headings, paragraphs, lists,
 * code kept apart), which ship as one library document; in the OS
 * `createLibraryIndex` puts a lexical index over them (`@jarenjs/core/search`,
 * BM25+ with prefix and fuzzy matching), `readSections` pages through a
 * document a few sections at a time — a page small enough for any model
 * to take in one tool call — and `answerFromDocs` is the offline voice of
 * "talk to the docs": the passages that answer a question, stitched
 * together with where they came from. With a language model seated, the
 * same passages ground its answer instead.
 */

import { compileLexical } from '@jarenjs/core/search';

/**
 * @typedef {{ id: string, heading: string, level: number, text: string, code: boolean }} Section
 * @typedef {{ id: string, title: string, source: string, sections: Section[] }} LibraryDoc
 * @typedef {{ $library: '0.1', docs: LibraryDoc[] }} Library
 * @typedef {{ doc: string, section: number, title: string, heading: string, excerpt: string, score: number }} Hit
 */

/** The longest text one section holds, characters; a longer one continues in the next. */
export const SECTION_MAX = 2400;

/**
 * Text longer than a section holds, in pieces that each fit: prose at
 * its paragraph breaks, a paragraph too long for one piece at its
 * sentences, code at its lines — and only what still does not fit is
 * cut at the limit. Nothing is dropped.
 * @param {string} text @param {boolean} code @returns {string[]}
 */
export function sectionPieces(text, code) {
  if (text.length <= SECTION_MAX) return [text];
  const joint = code ? '\n' : '\n\n';
  /** @type {string[]} */
  const out = [];
  let current = '';
  const add = (/** @type {string} */ part) => {
    if (current.length > 0 && current.length + joint.length + part.length > SECTION_MAX) {
      out.push(current);
      current = '';
    }
    if (part.length > SECTION_MAX) {
      for (let i = 0; i < part.length; i += SECTION_MAX) out.push(part.slice(i, i + SECTION_MAX));
      return;
    }
    current = current.length > 0 ? `${current}${joint}${part}` : part;
  };
  for (const block of code ? text.split('\n') : text.split(/\n{2,}/)) {
    if (code || block.length <= SECTION_MAX) add(block);
    else for (const sentence of block.split(/(?<=[.!?])\s+/)) add(sentence);
  }
  if (current.length > 0) out.push(current);
  return out;
}

/**
 * Cut Markdown into sections at its headings, as plain text: emphasis,
 * links and inline code lose their markup; a fenced code block becomes
 * a section of its own marked `code`; images, HTML comments and tables'
 * rule lines are dropped. A section longer than `SECTION_MAX` continues
 * in the next one, under its heading numbered on (`Usage (2)`).
 * @param {string} markdown @param {{ title?: string }} [options]
 * @returns {Section[]}
 */
export function markdownSections(markdown, options = {}) {
  const lines = markdown.replace(/\r\n?/g, '\n').replace(/^---\n[\s\S]*?\n---\n/, '').replace(/<!--[\s\S]*?-->/g, '').split('\n');
  /** @type {Section[]} */
  const out = [];
  let heading = options.title ?? '';
  let level = 1;
  /** @type {string[]} */
  let buffer = [];
  /** @type {string[] | null} */
  let fence = null;
  /** @param {string} text @param {boolean} code */
  const push = (text, code) => {
    sectionPieces(text, code).forEach((piece, i) => {
      out.push({ id: `s${out.length}`, heading: i === 0 ? heading : `${heading} (${i + 1})`, level, text: piece, code });
    });
  };
  const flush = () => {
    // a link whose text wraps a line is whole only once the lines are joined
    const text = buffer.join('\n').replace(/\[([^\]]+)\]\([^)\s]*\)/g, '$1').replace(/\n{3,}/g, '\n\n').trim();
    if (text.length > 0) push(text, false);
    buffer = [];
  };
  for (const raw of lines) {
    if (fence) {
      if (/^\s*(```|~~~)/.test(raw)) {
        const code = fence.join('\n').trim();
        if (code.length > 0) push(code, true);
        fence = null;
      }
      else fence.push(raw);
      continue;
    }
    if (/^\s*(```|~~~)/.test(raw)) { flush(); fence = []; continue; }
    const h = /^(#{1,6})\s+(.*)$/.exec(raw);
    if (h) {
      flush();
      level = h[1].length;
      heading = plain(h[2]);
      continue;
    }
    if (/^\s*\|?\s*:?-{3,}/.test(raw) || /^\s*!\[/.test(raw)) continue;
    buffer.push(plain(raw.replace(/^\s*[-*+]\s+/, '• ').replace(/^\s*>\s?/, '').replace(/\|/g, ' ')));
  }
  if (fence && fence.join('\n').trim().length > 0) push(fence.join('\n').trim(), true);
  flush();
  return out;
}

/** Markdown inline markup to plain words. Code spans keep what they
 * say — `__proto__` stays itself — and an underscore inside a word is
 * not emphasis. @param {string} s */
function plain(s) {
  return s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .split(/(`[^`]+`)/)
    .map((part, i) => (i % 2 === 1 ? part.slice(1, -1) : part
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/(^|\W)__(.+?)__(?!\w)/g, '$1$2')
      .replace(/\*(?!\s)([^*]+?)\*/g, '$1')
      .replace(/(^|\W)_(?!\s)([^_]+?)_(?!\w)/g, '$1$2')
      .replace(/<[^>]+>/g, '')))
    .join('')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/**
 * A library from Markdown sources.
 * @param {ReadonlyArray<{ id: string, title: string, source: string, markdown: string }>} sources
 * @returns {Library}
 */
export function libraryFrom(sources) {
  return {
    $library: '0.1',
    docs: sources.map((s) => ({ id: s.id, title: s.title, source: s.source, sections: markdownSections(s.markdown, { title: s.title }) })),
  };
}

/**
 * Whether a value is a library this OS can read.
 * @param {any} value @returns {value is Library}
 */
export function isLibrary(value) {
  return Boolean(value) && value.$library === '0.1' && Array.isArray(value.docs)
    && value.docs.every((/** @type {any} */ d) => d && typeof d.id === 'string' && typeof d.title === 'string' && Array.isArray(d.sections)
      && d.sections.every((/** @type {any} */ s) => s && typeof s.heading === 'string' && typeof s.text === 'string'));
}

/**
 * An index over a library: search, and the documents by id.
 * @param {Library} library
 */
export function createLibraryIndex(library) {
  const lexical = compileLexical({ version: 1, fields: ['title', 'heading', 'text'], prefix: true, fuzzy: 0.2, combineWith: 'OR', boost: { title: 2, heading: 3, text: 1 } });
  const index = lexical.create();
  /** @type {Map<string, { doc: LibraryDoc, section: number }>} */
  const rows = new Map();
  const docs = [];
  for (const doc of library.docs) {
    doc.sections.forEach((s, i) => {
      const id = `${doc.id}#${i}`;
      rows.set(id, { doc, section: i });
      docs.push({ id, title: doc.title, heading: s.heading, text: s.code ? '' : s.text });
    });
  }
  index.rebuild(docs, { generation: 1, sourceRevision: 'library' });
  const byId = new Map(library.docs.map((d) => [d.id, d]));
  return {
    size: docs.length,
    /**
     * The sections that best answer a question.
     * @param {string} query @param {number} [limit] @returns {Hit[]}
     */
    search(query, limit = 5) {
      const result = index.search(query, { limit });
      return (result.hits ?? []).map((/** @type {{ id: string, score: number }} */ h) => {
        const row = /** @type {{ doc: LibraryDoc, section: number }} */ (rows.get(h.id));
        const s = row.doc.sections[row.section];
        return { doc: row.doc.id, section: row.section, title: row.doc.title, heading: s.heading, excerpt: excerpt(s.text, query), score: Math.round(h.score * 1000) / 1000 };
      });
    },
    /** @param {string} id */
    doc: (id) => byId.get(id) ?? null,
    dispose: () => index.dispose(),
  };
}

/**
 * The sentence of `text` that shares most words with the query, trimmed.
 * @param {string} text @param {string} query
 */
function excerpt(text, query) {
  const words = new Set(query.toLowerCase().split(/\W+/).filter((w) => w.length > 2));
  let best = '';
  let score = -1;
  for (const s of sentences(text)) {
    const hits = s.toLowerCase().split(/\W+/).filter((w) => words.has(w)).length;
    if (hits > score) { score = hits; best = s; }
  }
  return best.length > 220 ? `${best.slice(0, 219)}…` : best;
}

/**
 * Split text into sentences (for reading aloud one at a time, and for
 * highlighting the one being spoken).
 * @param {string} text @returns {string[]}
 */
export function sentences(text) {
  return text.replace(/\s+/g, ' ').split(/(?<=[.!?…])\s+(?=[A-Z0-9“"(•])|\s(?=•\s)/).map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * What reading a page aloud says, sentence by sentence: each prose
 * section's heading, then its sentences; code is skipped. The view
 * numbers the same list, so the sentence it highlights is the one spoken.
 * @param {ReadonlyArray<{ heading: string, text: string, code: boolean }>} sections
 * @returns {string[]}
 */
export function speechOf(sections) {
  return sections.filter((s) => !s.code).flatMap((s) => [s.heading, ...sentences(s.text)]);
}

/**
 * A page of a document: `count` sections from `from`, and where the next
 * page starts (null at the end).
 * @param {Library} library @param {string} id @param {number} [from] @param {number} [count]
 * @returns {{ doc: string, title: string, sections: Array<{ index: number, heading: string, text: string, code: boolean }>, next: number | null } | null}
 */
export function readSections(library, id, from = 0, count = 2) {
  const doc = library.docs.find((d) => d.id === id);
  if (!doc) return null;
  const start = Math.max(0, Math.min(doc.sections.length, Math.floor(from)));
  const end = Math.min(doc.sections.length, start + Math.max(1, Math.floor(count)));
  return {
    doc: doc.id,
    title: doc.title,
    sections: doc.sections.slice(start, end).map((s, i) => ({ index: start + i, heading: s.heading, text: s.text, code: s.code })),
    next: end < doc.sections.length ? end : null,
  };
}

/** Where a passage is: its document, and its section when that has a name of its own. @param {Hit} h */
export const placeOf = (h) => (h.heading && h.heading !== h.title ? `${h.title} — ${h.heading}` : h.title);

/**
 * The offline answer to a question: the best passages in a few lines,
 * each with its source, or an honest "not in here".
 * @param {string} question @param {readonly Hit[]} hits
 * @returns {{ text: string, citations: Array<{ doc: string, section: number, label: string }> }}
 */
export function answerFromDocs(question, hits) {
  const top = hits.filter((h) => h.excerpt.length > 0).slice(0, 3);
  if (top.length === 0) {
    return { text: `I could not find “${question.trim()}” in the library. Try other words, or open a document and read along.`, citations: [] };
  }
  const lines = top.map((h, i) => `${i + 1}. ${h.excerpt} (${placeOf(h)})`);
  return {
    text: `Here is what the documentation says:\n${lines.join('\n')}`,
    citations: top.map((h) => ({ doc: h.doc, section: h.section, label: placeOf(h) })),
  };
}
