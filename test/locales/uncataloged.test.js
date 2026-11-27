//@ts-check
/**
 * No human-language text reaches a reader without a catalog — a guard over
 * the rendering modules. Every string literal and template chunk that holds
 * words (two letter-words, or one word under a UI key: label, title,
 * aria-label, placeholder, alt, textContent) must be one of:
 * - a catalog's own English beside one of its message ids, as a fallback
 *   where the catalog is read: in the expression the text belongs to (its
 *   item of an array, a call's arguments or an object, and the literal
 *   arguments or members beside it in a call or an object, within its
 *   statement: neither `if (…)`, `case …:` nor a block before it) a name that is
 *   the id (`pageBreak: 'Page break'`), or a string that is the id, the
 *   prefix the id is built from (`'calc/financial/nper'` for
 *   `calc/financial/nper#label`) or its last segment (`key: 'overview'` for
 *   `site/bench/suite/overview`). A copy of a catalog's English typed
 *   anywhere else is a reader meeting English: it is refused like new text,
 *   also beside a word equal to an id that is not part of its expression;
 * - out of scope by its place in the code: an object key, a module
 *   specifier, a class list, the message of a coded error a developer
 *   reads (`throw`, `new …Error(`), a log line (`console.*`);
 * - listed in uncataloged-allowlist.json with its reason class:
 *   not-prose (code, CSS, syntax words, ids), developer-facing (refusals and
 *   diagnostics a developer reads, coded or framing a coded error),
 *   English-by-design-paragraph (prose: paragraphs, the home page and the
 *   hero, generated sentences), data (example, demo and benchmark content,
 *   chart definitions, generated documents, a stored default value),
 *   proper-noun (names), catalog-copy (a catalog's English typed back
 *   into a module that does not read the catalog there: each a known
 *   defect, waiting to read its catalog).
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

/** The catalogs themselves (their English is the point), a module a catalog reads its entries from, and the site packs. */
const CATALOG_FILE = /(^|\/)messages\.js$|^packages\/json\/src\/query\/descent-message\.js$|^packages\/website\/src\/lang\//;

/** The reason classes an allowlist entry may give. */
const REASONS = new Set(['not-prose', 'developer-facing', 'English-by-design-paragraph', 'data', 'proper-noun', 'catalog-copy']);

const TWO_WORDS = /\p{L}{2,}[ \t\u00a0]+\p{L}{2,}/u;
const UI_KEYS = new Set(['aria-label', 'ariaLabel', 'title', 'placeholder', 'alt', 'textContent', 'aria-description', 'label']);

/** Every English text a catalog holds, trimmed, with the ids that hold it. */
const ENGLISH = new Map();
for (const catalog of [messagesEn, formsMessagesEn, contractMessagesEn, queryMessagesEn, formulaMessagesEn,
  { ...mdMessagesEn, ...DEFAULT_LABELS }, playMessagesEn, studioMessagesEn, mermaidMessagesEn, calcMessagesEn, rulesMessagesEn,
  collectionMessagesEn, chartsMessagesEn, viewMessagesEn, { ...dateMessagesEn, ...numberMessagesEn }, siteMessagesEn]) {
  for (const [id, english] of Object.entries(catalog)) {
    if (typeof english !== 'string') continue;
    const text = english.trim();
    if (!ENGLISH.has(text)) ENGLISH.set(text, []);
    ENGLISH.get(text).push(id);
  }
}

/**
 * Whether a string token names a message id: the id, the prefix it is
 * built from (cut at a `/` or `#`), or its last `/` segment.
 * @param {string} id @param {string} token
 */
const namesId = (id, token) => token === id || id.endsWith(`/${token}`)
  || (token.length >= 3 && id.startsWith(token) && (token.endsWith('/') || id[token.length] === '/' || id[token.length] === '#'));

/**
 * Whether a text is a catalog's English sitting beside one of its ids.
 * @param {{ text: string, near: string[], nearNames: string[] }} s
 */
const besideItsId = (s) => {
  const ids = ENGLISH.get(s.text.trim());
  return ids !== undefined
    && ids.some((id) => s.nearNames.includes(id) || s.near.some((token) => namesId(id, token)));
};

/** The statements whose head, a parenthesized expression, governs the statement after it. */
const CONTROL = new Set(['if', 'for', 'while', 'switch', 'with', 'catch']);

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
  // The expression a string belongs to. `pair` matches each bracket with its partner, `parent` names
  // the innermost bracket holding a token (-1: the top level). A bracket's content splits at its own
  // depth into statements (`;`) and items (`,`): a string belongs to its item, nested brackets
  // included, and, among a call's arguments or an object's members (`(`, `{`), it sits beside the
  // other items of its statement that are a literal or a member holding one (`t('id', 'English')`,
  // `{ key: 'overview', label: 'Overview' }`); a function among the arguments and an array's other
  // items are not its expression (`f('English', (v) => v === 'id')`, `['span', {}, 'English']`).
  const pair = tokens.map(() => -1), parent = tokens.map(() => -1), open = [];
  tokens.forEach((t, n) => {
    parent[n] = open.length ? open[open.length - 1] : -1;
    if (t.k !== 'p') return;
    if (t.v === '(' || t.v === '[' || t.v === '{') open.push(n);
    else if ((t.v === ')' || t.v === ']' || t.v === '}') && open.length) { const o = open.pop(); pair[o] = n; pair[n] = o; parent[n] = parent[o]; }
  });
  /** @param {number} k - a `case` @param {number} end @returns {number} the `:` that ends its label */
  const colonAfter = (k, end) => {
    for (let j = k + 1; j < end; j++) {
      if (tokens[j].v === ':' && tokens[j].k === 'p') return j;
      if (tokens[j].k === 'p' && '([{'.includes(tokens[j].v) && pair[j] > j) j = pair[j];
    }
    return -1;
  };
  /** @type {Map<number, { stmt: number, from: number, to: number, top: number[] }[]>} */
  const groups = new Map();
  const itemOf = tokens.map(() => -1);
  /** @param {number} p */
  const itemsOf = (p) => {
    let items = groups.get(p);
    if (items) return items;
    items = [];
    const end = p < 0 ? tokens.length : (pair[p] < 0 ? tokens.length : pair[p]);
    let stmt = 0, item = { stmt, from: p + 1, to: p, top: /** @type {number[]} */ ([]) };
    /** @param {number} k - the item's last token @param {number} next - 1 when a statement ends there */
    const cut = (k, next) => { items.push(item); stmt += next; item = { stmt, from: k + 1, to: k, top: [] }; };
    /** @param {number} k */
    const take = (k) => { itemOf[k] = items.length; item.top.push(k); item.to = k; };
    for (let k = p + 1; k < end; k++) {
      const t = tokens[k], v = t.k === 'p' ? t.v : '';
      if (v === ';' || v === ',') { cut(k, v === ';' ? 1 : 0); continue; }
      // a statement's head is a statement of its own: `if (…)`, `while (…)`, `case …:`
      const head = t.k === 'id' && CONTROL.has(t.v) && tokens[k + 1]?.v === '(' && pair[k + 1] > k + 1 ? pair[k + 1]
        : t.k === 'id' && t.v === 'case' && tokens[k + 1]?.v !== ':' ? colonAfter(k, end) : -1;
      if (head > k) {
        if (item.top.length) cut(k - 1, 1);
        for (let j = k; j <= head; j++) { take(j); if (tokens[j].k === 'p' && '([{'.includes(tokens[j].v) && pair[j] > j) item.to = j = pair[j]; }
        k = item.to;
        cut(k, 1);
        continue;
      }
      take(k);
      if ((v === '(' || v === '[' || v === '{') && pair[k] > k) item.to = k = pair[k];
      // a block ends its statement where another begins: `{ … } el.title = …`
      if (v === '{' && k + 1 < end && tokens[k + 1].k !== 'p') cut(k, 1);
    }
    items.push(item);
    groups.set(p, items);
    return items;
  };
  /**
   * The strings of an item that is a literal (a string, or a template and what it interpolates) or a
   * member holding one (`key: 'overview'`); none for any other item.
   * @param {number[]} top - the item's tokens at its bracket's depth
   */
  const literalOf = (top) => {
    const rest = top.length > 2 && tokens[top[1]].v === ':' && (tokens[top[0]].k === 'id' || tokens[top[0]].k === 'str') ? top.slice(2) : top;
    if (rest.length === 0 || tokens[rest[0]].k !== 'str') return [];
    const last = tokens[rest[rest.length - 1]];
    if (rest.length === 1) return last.tpl && last.open ? [] : rest;
    return tokens[rest[0]].tpl && tokens[rest[0]].open && last.tpl && !last.open ? rest.filter((k) => tokens[k].k === 'str') : [];
  };
  /** @param {number} n @returns {number[]} the tokens of the expression string n belongs to */
  const expression = (n) => {
    const p = parent[n], items = itemsOf(p), own = items[itemOf[n]];
    const at = [];
    for (let k = own.from; k <= own.to; k++) if (k !== n) at.push(k);
    if (p >= 0 && (tokens[p].v === '(' || tokens[p].v === '{')) {
      for (const item of items) if (item !== own && item.stmt === own.stmt) at.push(...literalOf(item.top));
    }
    return at;
  };
  tokens.forEach((t, n) => {
    if (t.k !== 'str') return;
    const at = expression(n).map((k) => tokens[k]);
    out.push({ ...t, before: tokens.slice(Math.max(0, n - 12), n).map((x) => x.v), after: tokens.slice(n + 1, n + 3).map((x) => x.v),
      near: at.filter((x) => x.k === 'str').map((x) => x.text), nearNames: at.filter((x) => x.k === 'id').map((x) => x.v) });
  });
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
      if (besideItsId(s)) continue; // a catalog's own English, beside its id
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

  it('a catalog\'s English typed back into a view fails like new words; beside its id it passes', () => {
    const file = 'packages/website/src/views/shell.js';
    const source = readFileSync(join(ROOT, file), 'utf8');
    const anchor = "['span', { class: 'brand-name' }, 'Jaren'],";
    /** @param {string} added */
    const scan = (added) => {
      const changed = source.replace(anchor, `${anchor} ${added}`);
      assert.notStrictEqual(changed, source, 'the probe found its anchor');
      return unlisted(uncatalogedTexts((f) => (f === file ? changed : readFileSync(join(ROOT, f), 'utf8')))).map((h) => [h.file, h.text]);
    };
    // a copy: the English of studio/project/untitled and of play/card/compile, read by no catalog here
    assert.deepStrictEqual(scan("['span', {}, 'Untitled project'],"), [[file, 'Untitled project']]);
    assert.deepStrictEqual(scan("['span', { title: 'Compile' }],"), [[file, 'Compile']]);
    // a fallback beside the id it falls back for: the id, its prefix, its last segment
    assert.deepStrictEqual(scan("['span', {}, t('studio/project/untitled') ?? 'Untitled project'],"), []);
    assert.deepStrictEqual(scan("['span', { title: t(`play/card/${'compile'}`, 'Compile') }],"), []);
    assert.deepStrictEqual(scan("['span', { key: 'compile', title: 'Compile' }],"), []);
    assert.deepStrictEqual(scan("['span', { title: t('studio/project/untitled', 'Untitled project') }],"), []);
    assert.deepStrictEqual(scan("['span', { title: t(`studio/project/${name}`) ?? 'Untitled project', key: 'untitled' }],"), []);
  });

  it('a copy beside a word equal to an id that is not part of its expression fails', () => {
    const file = 'packages/website/src/views/shell.js';
    const source = readFileSync(join(ROOT, file), 'utf8');
    const anchor = "['span', { class: 'brand-name' }, 'Jaren'],";
    /** @param {string} added */
    const scan = (added) => {
      const changed = source.replace(anchor, `${anchor} ${added}`);
      assert.notStrictEqual(changed, source, 'the probe found its anchor');
      return unlisted(uncatalogedTexts((f) => (f === file ? changed : readFileSync(join(ROOT, f), 'utf8')))).map((h) => [h.file, h.text]);
    };
    // 'untitled' and 'compile' are the last segments of studio/project/untitled and play/card/compile
    assert.deepStrictEqual(scan("['span', { key: 'untitled' }], ['span', {}, 'Untitled project'],"), [[file, 'Untitled project']]);
    assert.deepStrictEqual(scan("say('untitled'); ['span', {}, 'Untitled project'],"), [[file, 'Untitled project']]);
    assert.deepStrictEqual(scan("['span', { 'data-step': 'untitled' }, 'Untitled project'],"), [[file, 'Untitled project']]);
    assert.deepStrictEqual(scan("['span', { title: pick('Untitled project', (v) => v === 'untitled') }],"), [[file, 'Untitled project']]);
    assert.deepStrictEqual(scan("['span', { key: 'compile' }, ['b', { title: 'Compile' }]],"), [[file, 'Compile']]);
    assert.deepStrictEqual(scan("['span', { title: 'Compile' }, 'compile'],"), [[file, 'Compile']]);
    // a statement's head and a block before it are not the expression of the statement that follows
    assert.deepStrictEqual(scan("if (k === 'untitled') { go(); } el.title = 'Untitled project';"), [[file, 'Untitled project']]);
    assert.deepStrictEqual(scan("if (k === 'untitled') el.title = 'Untitled project';"), [[file, 'Untitled project']]);
    assert.deepStrictEqual(scan("switch (k) { case 'untitled': el.title = 'Untitled project'; }"), [[file, 'Untitled project']]);
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
