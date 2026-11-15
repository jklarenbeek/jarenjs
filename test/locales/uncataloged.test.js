//@ts-check
/**
 * No human-language text reaches a reader without a catalog — a guard over
 * the rendering modules. Every string literal and template chunk that holds
 * words (two letter-words, or one word under a UI key: label, title,
 * aria-label, placeholder, alt, textContent) must be one of:
 * - a catalog's own English (it sits beside its message id as a fallback);
 * - out of scope by its place in the code: an object key, a module
 *   specifier, a class list, the message of a coded error a developer
 *   reads (`throw`, `new …Error(`), a log line (`console.*`);
 * - listed in uncataloged-allowlist.json with its reason class:
 *   not-prose (code, CSS, syntax words, ids), developer-facing (refusals and
 *   diagnostics a developer reads, coded or framing a coded error),
 *   English-by-design-paragraph (prose: paragraphs, the home page and the
 *   hero, generated sentences), data (example, demo and benchmark content,
 *   chart definitions, generated documents), proper-noun (names).
 * Anything else is a new string a reader would meet in English: give it a
 * key in the catalog that owns it (a published package's catalog, its
 * translations in @jarenjs/locales; a site-only word in siteMessagesEn and
 * the site packs) and the 11 packs, or allowlist it with its reason.
 *
 * The scan is dependency-free: a small lexer finds strings, template
 * chunks, comments and regular expressions (on the sources it reads it
 * finds exactly the string literals an ECMAScript parser does).
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { messagesEn } from '@jarenjs/validate';
import { formsMessagesEn } from '@jarenjs/forms';
import { contractMessagesEn } from '@jarenjs/contract';
import { queryMessagesEn } from '@jarenjs/json';
import { formulaMessagesEn } from '@jarenjs/json/formula';
import { mdMessagesEn, DEFAULT_LABELS } from '@jarenjs/md';
import { playMessagesEn } from '@jarenjs/play';
import { studioMessagesEn } from '@jarenjs/studio';
import { mermaidMessagesEn } from '@jarenjs/mermaid';
import { calcMessagesEn } from '@jarenjs/calc';
import { rulesMessagesEn } from '@jarenjs/rules';
import { collectionMessagesEn } from '@jarenjs/collection';
import { chartsMessagesEn } from '@jarenjs/charts';
import { viewMessagesEn } from '@jarenjs/view';
import { dateMessagesEn, numberMessagesEn } from '@jarenjs/locales';
import { siteMessagesEn } from '../../packages/website/src/messages.js';

const ROOT = new URL('../../', import.meta.url).pathname;

/** The rendering modules: every source a reader's screen is drawn from. */
const DIRS = ['packages/forms/src', 'packages/view/src', 'packages/app/src', 'packages/flow/src', 'packages/emit/src',
  'components/charts/src', 'components/md/src', 'components/mermaid/src', 'components/play/src', 'components/studio/src',
  'components/calc/src', 'components/collection/src', 'components/rules/src', 'packages/website/src',
  'packages/validate/src', 'packages/contract/src', 'packages/json/src'];

/** The catalogs themselves (their English is the point) and the site packs. */
const CATALOG_FILE = /(^|\/)messages\.js$|^packages\/website\/src\/lang\//;

/** The reason classes an allowlist entry may give. */
const REASONS = new Set(['not-prose', 'developer-facing', 'English-by-design-paragraph', 'data', 'proper-noun']);

const TWO_WORDS = /\p{L}{2,}[ \t\u00a0]+\p{L}{2,}/u;
const UI_KEYS = new Set(['aria-label', 'ariaLabel', 'title', 'placeholder', 'alt', 'textContent', 'aria-description', 'label']);

/** Every English text a catalog holds, trimmed. */
const ENGLISH = new Set([messagesEn, formsMessagesEn, contractMessagesEn, queryMessagesEn, formulaMessagesEn,
  { ...mdMessagesEn, ...DEFAULT_LABELS }, playMessagesEn, studioMessagesEn, mermaidMessagesEn, calcMessagesEn, rulesMessagesEn,
  collectionMessagesEn, chartsMessagesEn, viewMessagesEn, { ...dateMessagesEn, ...numberMessagesEn }, siteMessagesEn]
  .flatMap((catalog) => Object.values(catalog)).filter((v) => typeof v === 'string').map((v) => v.trim()));

const REGEX_BEFORE = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^', 'return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'yield', 'await', '=>', '&&', '||', '??', '']);
/**
 * Tokenize enough of JS to find string literals and template text, skipping comments and regex literals. */
function strings(src) {
  const out = []; let i = 0, line = 1; let prev = ''; const tokens = [];
  const push = (t) => { tokens.push(t); prev = t.v; };
  const tplStack = []; // brace depth at which a template resumes
  let depth = 0;
  const readTemplate = () => { // at char after '`' or '}'
    let text = ''; const ln = line;
    while (i < src.length) {
      const c = src[i];
      if (c === '\\') { text += src[i + 1] === '\n' ? '' : src.slice(i, i + 2); if (src[i + 1] === '\n') line++; i += 2; continue; }
      if (c === '`') { i++; push({ k: 'str', v: '`', text, line: ln, tpl: true }); return; }
      if (c === '$' && src[i + 1] === '{') { i += 2; push({ k: 'str', v: '`', text, line: ln, tpl: true, open: true }); tplStack.push(depth); depth++; return; }
      if (c === '\n') line++;
      text += c; i++;
    }
  };
  while (i < src.length) {
    const c = src[i];
    if (c === '\n') { line++; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); const seg = src.slice(i, e < 0 ? src.length : e + 2); line += (seg.match(/\n/g) ?? []).length; i = e < 0 ? src.length : e + 2; continue; }
    if (c === '"' || c === "'") {
      const q = c, ln = line; let j = i + 1, text = '';
      while (j < src.length && src[j] !== q) { if (src[j] === '\\') { text += src.slice(j, j + 2); j += 2; continue; } if (src[j] === '\n') break; text += src[j]; j++; }
      i = j + 1; push({ k: 'str', v: q, text, line: ln }); continue;
    }
    if (c === '`') { i++; readTemplate(); continue; }
    if (c === '/' && REGEX_BEFORE.has(prev)) {
      let j = i + 1, cls = false;
      while (j < src.length && src[j] !== '\n') { if (src[j] === '\\') { j += 2; continue; } if (src[j] === '[') cls = true; else if (src[j] === ']') cls = false; else if (src[j] === '/' && !cls) break; j++; }
      j++; while (/[a-z]/i.test(src[j] ?? '')) j++;
      i = j; push({ k: 'regex', v: 'regex' }); continue;
    }
    if (/[A-Za-z_$]/.test(c)) { let j = i; while (/[\w$]/.test(src[j] ?? '')) j++; push({ k: 'id', v: src.slice(i, j) }); i = j; continue; }
    if (/[0-9]/.test(c)) { let j = i; while (/[\w.]/.test(src[j] ?? '')) j++; push({ k: 'num', v: 'num' }); i = j; continue; }
    if (c === '{') { depth++; push({ k: 'p', v: '{' }); i++; continue; }
    if (c === '}') {
      if (tplStack.length && tplStack[tplStack.length - 1] === depth - 1) { tplStack.pop(); depth--; i++; readTemplate(); continue; }
      depth--; push({ k: 'p', v: '}' }); i++; continue;
    }
    const three = src.slice(i, i + 3), two = src.slice(i, i + 2);
    if (['===', '!==', '...', '>>>', '**=', '&&=', '||=', '??='].includes(three)) { push({ k: 'p', v: three }); i += 3; continue; }
    if (['=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '/=', '**', '<<', '>>'].includes(two)) { push({ k: 'p', v: two }); i += 2; continue; }
    push({ k: 'p', v: c }); i++;
  }
  // context: index into tokens
  tokens.forEach((t, n) => { if (t.k === 'str') out.push({ ...t, before: tokens.slice(Math.max(0, n - 12), n).map((x) => x.v), after: tokens.slice(n + 1, n + 3).map((x) => x.v) }); });
  return out;
}

/** @param {string} dir @returns {string[]} */
function files(dir) {
  /** @type {string[]} */
  const out = [];
  /** @param {string} p */
  const walk = (p) => { for (const e of readdirSync(p)) { const f = join(p, e); if (statSync(f).isDirectory()) walk(f); else if (/\.m?js$/.test(e)) out.push(f); } };
  walk(join(ROOT, dir));
  return out.map((f) => relative(ROOT, f)).sort();
}

/**
 * Is the string inside an open call whose callee the test accepts?
 * @param {string[]} before @param {(tokens: string[], at: number) => boolean} test
 */
function insideCall(before, test) {
  let depth = 0;
  for (let k = before.length - 1; k >= 0; k--) {
    const v = before[k];
    if (v === ')' || v === ']') depth++;
    else if (v === '(' || v === '[') { if (depth > 0) depth--; else if (k > 0 && test(before, k - 1)) return true; }
  }
  return false;
}

/**
 * The texts in the rendering modules a reader could meet uncataloged.
 * @param {(file: string) => string} [read] - reads a source (a test can change one)
 * @returns {{ file: string, line: number, text: string }[]}
 */
export function uncatalogedTexts(read = (file) => readFileSync(join(ROOT, file), 'utf8')) {
  /** @type {{ file: string, line: number, text: string }[]} */
  const out = [];
  for (const dir of DIRS) for (const file of files(dir)) {
    if (CATALOG_FILE.test(file)) continue;
    for (const s of strings(read(file))) {
      const b = s.before, last = b[b.length - 1];
      const ui = b.length >= 2 && last === ':' && UI_KEYS.has(String(b[b.length - 2]).replace(/^['"]|['"]$/g, '')) && /\p{L}{2,}/u.test(s.text);
      if (!TWO_WORDS.test(s.text) && !ui) continue;
      if (s.after[0] === ':' && (last === '{' || last === ',')) continue; // an object key
      if (last === ':' && /^['"]?class(Name)?['"]?$/.test(String(b[b.length - 2]))) continue; // a class list
      if (last === 'from' || last === 'import' || (last === '(' && b[b.length - 2] === 'import')) continue; // a module specifier
      if (last === 'throw' || insideCall(b, (t, k) => /Error$/.test(t[k]) && t[k - 1] === 'new')) continue; // a coded developer error
      if (insideCall(b, (t, k) => t[k - 2] === 'console')) continue; // a log line
      if (ENGLISH.has(s.text.trim())) continue; // a catalog's own English
      out.push({ file, line: s.line, text: s.text });
    }
  }
  return out;
}

/** The allowlist: file -> [text, reason] pairs. */
const ALLOWLIST = /** @type {Record<string, [string, string][]>} */ (JSON.parse(readFileSync(new URL('./uncataloged-allowlist.json', import.meta.url), 'utf8')));
const ALLOWED = new Map(Object.entries(ALLOWLIST).map(([file, entries]) => [file, new Map(entries)]));

/** The texts neither cataloged nor allowlisted. @param {{ file: string, line: number, text: string }[]} found */
const unlisted = (found) => found.filter((h) => !ALLOWED.get(h.file)?.has(h.text));

describe('@jarenjs/locales — no uncataloged human text in a rendering module', () => {
  it('every text a reader can meet is in a catalog, out of scope by its place, or allowlisted with a reason', () => {
    const started = Date.now();
    const found = uncatalogedTexts();
    const fail = unlisted(found).map((h) => `${h.file}:${h.line}: ${JSON.stringify(h.text)} — add a key to the catalog that owns it and the 11 packs, or allowlist it with a reason`);
    assert.deepStrictEqual(fail, []);
    assert.ok(Date.now() - started < 5000, 'the scan stays fast');
  });

  it('every allowlist entry still names a text that is there, with a known reason', () => {
    const found = new Set(uncatalogedTexts().map((h) => `${h.file}\u0000${h.text}`));
    const stale = [];
    const unreasoned = [];
    for (const [file, entries] of Object.entries(ALLOWLIST)) {
      for (const [text, reason] of entries) {
        if (!found.has(`${file}\u0000${text}`)) stale.push(`${file}: ${JSON.stringify(text)}`);
        if (!REASONS.has(reason)) unreasoned.push(`${file}: ${JSON.stringify(text)} (${reason})`);
      }
    }
    assert.deepStrictEqual(unreasoned, []);
    assert.deepStrictEqual(stale, [], 'drop an entry whose text is gone (or now cataloged)');
  });

  it('a new label in a rendering module fails, with its place and the fix; removing it passes', () => {
    const file = 'packages/website/src/views/shell.js';
    const source = readFileSync(join(ROOT, file), 'utf8');
    const added = source.replace("['span', { class: 'brand-name' }, 'Jaren'],", "['span', { class: 'brand-name' }, 'Jaren'], ['span', {}, 'Fresh words here'],");
    assert.notStrictEqual(added, source, 'the probe found its anchor');
    const read = (/** @type {string} */ f) => (f === file ? added : readFileSync(join(ROOT, f), 'utf8'));
    const fail = unlisted(uncatalogedTexts(read));
    assert.deepStrictEqual(fail.map((h) => [h.file, h.text]), [[file, 'Fresh words here']]);
    assert.match(String(fail[0].line), /^\d+$/);
    // the same literal under a UI key with one word, too
    const ui = source.replace("title: '$.ui.shell.theme',", "title: 'Theme',");
    assert.notStrictEqual(ui, source);
    assert.deepStrictEqual(unlisted(uncatalogedTexts((f) => (f === file ? ui : readFileSync(join(ROOT, f), 'utf8')))).map((h) => h.text), ['Theme']);
    // and the source as it is passes
    assert.deepStrictEqual(unlisted(uncatalogedTexts()), []);
  });

  it('the lexer reads strings, templates, comments and regular expressions the way a parser does', () => {
    const src = [
      "const a = 'two words'; // 'not in a comment'",
      "/* 'nor here' */ const r = /a b'c/g.test(x) ? `the ${'inner words'} template` : \"double quoted\";",
      "const d = 10 / 2 / 'divided words'.length;",
    ].join('\n');
    assert.deepStrictEqual(strings(src).map((s) => [s.text, s.line]),
      [['two words', 1], ['the ', 2], ['inner words', 2], [' template', 2], ['double quoted', 2], ['divided words', 3]]);
  });
});
