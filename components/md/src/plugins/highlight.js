//@ts-check
/**
 * @file Syntax highlighting for fenced code blocks (PLUGINS.md §6.2).
 *
 * Built-in mode is a zero-dependency single-pass tokenizer driven by
 * compact grammar tables — a keyword set, comment/string delimiters
 * and punctuation classes — compiled to closures once at module load.
 * No regex runs in the token loop. Adapter mode puts shiki/prism/
 * highlight.js behind the same `{ kind, value }` token contract.
 *
 * Token kinds: kw str num com pun id op lit — rendered as
 * `span.tok-{kind}` (plain `id` runs render as bare text).
 */

import { definePlugin } from './index.js';

/**
 * @typedef {{ kind: 'kw'|'str'|'num'|'com'|'pun'|'id'|'op'|'lit', value: string }} Token
 */
/**
 * A compact grammar table.
 * @typedef {object} MdGrammar
 * @property {string[]} [keywords]
 * @property {string[]} [literals]
 * @property {string[]} [lineComments] comment-to-end-of-line prefixes
 * @property {[string, string]} [blockComment] open/close pair
 * @property {string} [strings] string delimiter characters
 * @property {boolean} [numbers] recognize number literals
 * @property {string} [extraId] extra identifier characters (e.g. `-` for CSS)
 */

const JS_KEYWORDS = [
  'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue',
  'debugger', 'default', 'delete', 'do', 'else', 'export', 'extends',
  'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'let',
  'new', 'of', 'return', 'static', 'super', 'switch', 'this', 'throw',
  'try', 'typeof', 'var', 'void', 'while', 'with', 'yield', 'get', 'set',
  // the TS layer — harmless for plain JS
  'abstract', 'any', 'as', 'asserts', 'declare', 'enum', 'implements',
  'infer', 'interface', 'is', 'keyof', 'namespace', 'never', 'private',
  'protected', 'public', 'readonly', 'satisfies', 'type', 'unknown',
];

const BASH_KEYWORDS = [
  'if', 'then', 'elif', 'else', 'fi', 'for', 'while', 'until', 'do',
  'done', 'case', 'esac', 'in', 'function', 'select', 'time', 'return',
  'break', 'continue', 'local', 'export', 'readonly', 'declare', 'unset',
  'shift', 'source', 'alias', 'echo', 'exit', 'set', 'cd', 'test',
];

/** @type {Record<string, MdGrammar>} */
const GRAMMARS = {
  js: {
    keywords: JS_KEYWORDS,
    literals: ['true', 'false', 'null', 'undefined', 'NaN', 'Infinity'],
    lineComments: ['//'],
    blockComment: ['/*', '*/'],
    strings: '\'"`',
    numbers: true,
    extraId: '$',
  },
  json: {
    literals: ['true', 'false', 'null'],
    strings: '"',
    numbers: true,
  },
  toml: {
    literals: ['true', 'false', 'null', 'inf', 'nan'],
    lineComments: ['#'],
    strings: '\'"',
    numbers: true,
    extraId: '-',
  },
  html: {
    keywords: ['html', 'head', 'body', 'div', 'span', 'script', 'style',
      'a', 'p', 'ul', 'ol', 'li', 'table', 'tr', 'td', 'th', 'input',
      'button', 'form', 'img', 'pre', 'code', 'h1', 'h2', 'h3', 'main',
      'section', 'article', 'header', 'footer', 'nav', 'template'],
    blockComment: ['<!--', '-->'],
    strings: '\'"',
    extraId: '-',
  },
  css: {
    keywords: ['import', 'media', 'supports', 'keyframes', 'font-face',
      'root', 'hover', 'focus', 'active', 'before', 'after', 'not',
      'important'],
    lineComments: [],
    blockComment: ['/*', '*/'],
    strings: '\'"',
    numbers: true,
    extraId: '-#',
  },
  md: {
    lineComments: [],
    strings: '`',
    extraId: '',
  },
  bash: {
    keywords: BASH_KEYWORDS,
    literals: ['true', 'false'],
    lineComments: ['#'],
    strings: '\'"`',
    numbers: true,
    extraId: '-$',
  },
};
GRAMMARS.ts = GRAMMARS.js;
GRAMMARS.jsx = GRAMMARS.js;
GRAMMARS.tsx = GRAMMARS.js;
GRAMMARS.mjs = GRAMMARS.js;
GRAMMARS.cjs = GRAMMARS.js;
GRAMMARS.javascript = GRAMMARS.js;
GRAMMARS.typescript = GRAMMARS.js;
GRAMMARS.josl = GRAMMARS.toml;
GRAMMARS.ini = GRAMMARS.toml;
GRAMMARS.yaml = GRAMMARS.toml;
GRAMMARS.yml = GRAMMARS.toml;
GRAMMARS.xml = GRAMMARS.html;
GRAMMARS.markdown = GRAMMARS.md;
GRAMMARS.sh = GRAMMARS.bash;
GRAMMARS.shell = GRAMMARS.bash;
GRAMMARS.console = GRAMMARS.bash;

/** The canonical names of the shipped grammars (aliases resolve too). */
export const GRAMMAR_NAMES = Object.freeze(Object.keys(GRAMMARS));

const OP_CHARS = '+-*/%=<>!&|^~?:@';
const PUN_CHARS = '()[]{},;.';

/**
 * Compile a grammar table into a single-pass tokenizer closure.
 * @param {MdGrammar} grammar
 * @returns {(code: string) => Token[]}
 */
function compileGrammar(grammar) {
  const keywords = new Set(grammar.keywords ?? []);
  const literals = new Set(grammar.literals ?? []);
  const lineComments = grammar.lineComments ?? [];
  const blockOpen = grammar.blockComment !== undefined ? grammar.blockComment[0] : null;
  const blockClose = grammar.blockComment !== undefined ? grammar.blockComment[1] : '';
  const strings = grammar.strings ?? '';
  const numbers = grammar.numbers === true;
  // Per-char class lookup for the ASCII range, built once.
  const CLASS = new Uint8Array(128); // 1 id, 2 op, 3 pun, 4 string, 5 digit
  for (let c = 48; c <= 57; c++) CLASS[c] = 5;
  for (let c = 65; c <= 90; c++) CLASS[c] = 1;
  for (let c = 97; c <= 122; c++) CLASS[c] = 1;
  CLASS[95] = 1; // _
  for (const ch of OP_CHARS) CLASS[ch.charCodeAt(0)] = 2;
  for (const ch of PUN_CHARS) CLASS[ch.charCodeAt(0)] = 3;
  for (const ch of strings) CLASS[ch.charCodeAt(0)] = 4;
  for (const ch of grammar.extraId ?? '') CLASS[ch.charCodeAt(0)] = 1;

  return function tokenize(code) {
    /** @type {Token[]} */
    const tokens = [];
    let i = 0;
    let plain = 0; // start of the pending plain run

    /** @param {number} end @param {Token['kind']} kind @param {number} to */
    const push = (end, kind, to) => {
      if (end > plain) tokens.push({ kind: 'id', value: code.slice(plain, end) });
      if (to > end) tokens.push({ kind, value: code.slice(end, to) });
      plain = to;
      i = to;
    };

    outer:
    while (i < code.length) {
      const c = code.charCodeAt(i);

      // Comments (prefix comparison, no regex).
      for (let k = 0; k < lineComments.length; k++) {
        if (c === lineComments[k].charCodeAt(0) && code.startsWith(lineComments[k], i)) {
          let end = code.indexOf('\n', i);
          if (end === -1) end = code.length;
          push(i, 'com', end);
          continue outer;
        }
      }
      if (blockOpen !== null && c === blockOpen.charCodeAt(0) && code.startsWith(blockOpen, i)) {
        let end = code.indexOf(blockClose, i + blockOpen.length);
        end = end === -1 ? code.length : end + blockClose.length;
        push(i, 'com', end);
        continue;
      }

      const cls = c < 128 ? CLASS[c] : 1;

      if (cls === 4) {
        // String literal with backslash escapes, to line end at most
        // (unterminated strings stay honest).
        let j = i + 1;
        while (j < code.length) {
          const s = code.charCodeAt(j);
          if (s === 0x5C) { j += 2; continue; }
          if (s === c) { j++; break; }
          if (s === 0x0A && c !== 0x60) break;
          j++;
        }
        push(i, 'str', j);
        continue;
      }

      if (numbers && (cls === 5
        || (c === 0x2E && CLASS[code.charCodeAt(i + 1)] === 5))) {
        let j = i;
        while (j < code.length) {
          const s = code.charCodeAt(j);
          const sc = s < 128 ? CLASS[s] : 0;
          if (sc === 5 || sc === 1 || s === 0x2E || s === 0x5F
            || ((s === 0x2B || s === 0x2D) && (code.charCodeAt(j - 1) | 32) === 0x65)) {
            j++;
            continue;
          }
          break;
        }
        push(i, 'num', j);
        continue;
      }

      if (cls === 1) {
        let j = i + 1;
        while (j < code.length) {
          const s = code.charCodeAt(j);
          const sc = s < 128 ? CLASS[s] : 1;
          if (sc === 1 || sc === 5) { j++; continue; }
          break;
        }
        const word = code.slice(i, j);
        if (keywords.has(word)) push(i, 'kw', j);
        else if (literals.has(word)) push(i, 'lit', j);
        else i = j; // stays in the plain run
        continue;
      }

      if (cls === 2) { push(i, 'op', i + 1); continue; }
      if (cls === 3) { push(i, 'pun', i + 1); continue; }
      i++;
    }
    if (code.length > plain) tokens.push({ kind: 'id', value: code.slice(plain) });
    return tokens;
  };
}

/** Compiled tokenizers, one per distinct grammar table. */
const COMPILED = new Map();
for (const name of Object.keys(GRAMMARS)) {
  const grammar = GRAMMARS[name];
  if (!COMPILED.has(grammar)) COMPILED.set(grammar, compileGrammar(grammar));
}

/**
 * Tokenize `code` with the built-in grammar for `lang`. Returns null
 * when no grammar covers the language.
 * @param {string} code
 * @param {string|null} lang
 * @returns {Token[] | null}
 */
export function tokenizeCode(code, lang) {
  if (lang === null) return null;
  const grammar = GRAMMARS[lang];
  if (grammar === undefined) return null;
  return COMPILED.get(grammar)(code);
}

/**
 * The syntax-highlighting plugin: takes over rendering of `code`
 * nodes. `adapter(code, lang)` may return tokens (shiki/prism/hljs
 * behind the shared contract) or null to fall back to the built-in
 * grammars, then to plain text.
 *
 * @param {{ grammars?: Record<string, MdGrammar>,
 *           adapter?: (code: string, lang: string|null) => (Token[] | null) }} [config]
 * @returns {import('./index.js').MdPlugin}
 */
export function highlightPlugin(config = {}) {
  const adapter = config.adapter;
  /** @type {Map<string, (code: string) => Token[]>} */
  const extra = new Map();
  if (config.grammars !== undefined) {
    for (const name of Object.keys(config.grammars)) {
      extra.set(name, compileGrammar(config.grammars[name]));
    }
  }

  /**
   * @param {string} code
   * @param {string|null} lang
   * @returns {Token[] | null}
   */
  const tokensFor = (code, lang) => {
    if (adapter !== undefined) {
      const tokens = adapter(code, lang);
      if (tokens !== null && tokens !== undefined) return tokens;
    }
    if (lang !== null) {
      const custom = extra.get(lang);
      if (custom !== undefined) return custom(code);
    }
    return tokenizeCode(code, lang);
  };

  return definePlugin({
    name: 'highlight',
    node: 'code',
    render: (node, h) => {
      const lang = node.lang ?? null;
      const props = lang === null ? {} : { class: 'language-' + lang };
      const tokens = tokensFor(node.value, lang);
      if (tokens === null) {
        return h('pre', {}, h('code', props, node.value));
      }
      /** @type {any[]} */
      const children = [];
      for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        children.push(token.kind === 'id'
          ? token.value
          : h('span', { class: 'tok-' + token.kind }, token.value));
      }
      return h('pre', {}, h('code', props, ...children));
    },
  });
}
