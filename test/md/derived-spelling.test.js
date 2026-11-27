//@ts-check
/**
 * `toMarkdown` spells emphasis, strong and strikethrough whose canonical
 * spelling reads back as other nodes from the delimiter rules (CommonMark
 * §6.2: which runs can open and close beside which characters, the rule of
 * three, the reader taking two characters from an opener and a closer that
 * both have two): each node's delimiter, which literal `*` and `_` beside
 * it print bare, and which characters beside a run print as references;
 * content the derived spelling does not reach is spelled by the search it
 * replaced. A node no Markdown reads back as, and content neither reads
 * back as, is named to `onLossy` with its path instead of printing as
 * something else unannounced. Timing compares eight times the input and
 * never a wall clock.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { parseMarkdown, toMarkdown } from '@jarenjs/md';
import { growthRatio } from '../lib/growth.js';

const t = (/** @type {string} */ value) => ({ type: 'text', value });
const em = (/** @type {any[]} */ ...children) => ({ type: 'emphasis', children });
const strong = (/** @type {any[]} */ ...children) => ({ type: 'strong', children });
const del = (/** @type {any[]} */ ...children) => ({ type: 'strikethrough', children });
const p = (/** @type {any[]} */ ...children) => ({ type: 'paragraph', children });

/**
 * Print a block list, collecting what `onLossy` is told.
 * @param {any} ast
 * @returns {{ text: string, reports: any[] }}
 */
function lossy(ast) {
  /** @type {any[]} */
  const reports = [];
  const text = toMarkdown(ast, { onLossy: (report) => reports.push(report) });
  return { text, reports };
}

/**
 * Print a block list that must read back unchanged, with nothing reported.
 * @param {any[]} ast
 * @returns {string}
 */
function roundTrip(ast) {
  const { text, reports } = lossy(ast);
  assert.deepEqual(parseMarkdown(text).ast, ast, `AST drift for ${JSON.stringify(text)}`);
  assert.deepEqual(reports, []);
  return text;
}

/**
 * Parse, print and read back a source, which must read back unchanged.
 * @param {string} source
 * @returns {string}
 */
function canonical(source) {
  return roundTrip(parseMarkdown(source).ast);
}

/**
 * A deterministic stream of numbers: the same seed, the same input.
 * @param {number} seed
 * @returns {{ int: (n: number) => number, pick: <T>(items: T[]) => T }}
 */
function random(seed) {
  let state = seed >>> 0;
  const int = (/** @type {number} */ n) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return Math.floor((state / 2 ** 32) * n);
  };
  return { int, pick: (items) => items[int(items.length)] };
}

describe('toMarkdown — a run the canonical spelling does not read back is spelled from the delimiter rules', function () {
  it('keeps the canonical spelling wherever it reads back', () => {
    assert.equal(canonical('*a*_b_'), '*a*_b_\n');
    assert.equal(canonical('**a *b* c**'), '**a *b* c**\n');
    assert.equal(canonical('***x***'), '***x***\n');
    assert.equal(canonical('**_x_**'), '**_x_**\n');
  });

  it('prints white space or a letter beside a run as a character reference where the run needs punctuation', () => {
    // a run before white space cannot open, and one after it cannot close;
    // between two letters a run of `*` opens and closes both, and `_` neither
    assert.equal(roundTrip([p(em(t(' x')), t(' y'))]), '*&#32;x* y\n');
    assert.equal(roundTrip([p(t('a'), em(t(' b ')), t('c'))]), '&#97;*&#32;b&#32;*&#99;\n');
  });

  it('merges the runs of nested nodes where the reader takes them apart innermost first', () => {
    assert.equal(roundTrip([p(em(strong(em(strong(t('x'))))))]), '***_**x**_***\n');
    assert.equal(canonical('***a**b*'), '***a**b*\n');
  });

  it('prints a literal delimiter bare beside a run where the rule of three needs the longer run', () => {
    // `_` then emphasis three deep: only a run of two before the outer one
    // keeps the innermost from pairing with it
    assert.equal(canonical('__*_._*_'), '__*_._*_\n');
  });

  it('keeps emphasis from standing between an opener and a closer that both have two characters left', () => {
    // the reader takes two characters from such a pair, which is strong
    assert.equal(canonical('__****_*__1*__b_ 1__*'), '__\\*\\**_\\__\\_\\_1*__b_ 1__\\*\n');
  });

  it('chooses for a letter alone between two runs whether it prints as a reference, for both runs at once', () => {
    assert.equal(canonical('***_*&#2;*'), '\\**_\\__&#2;*\n');
    assert.equal(canonical('***\\b*a*~*'), '__*\\\\b*a_\\~_\n');
  });

  it('spells the text of a link and the content of a strikethrough by the same rules', () => {
    assert.equal(roundTrip([p({ type: 'link', url: 'u', title: null, children: [em(t(' a'))] })]), '[*&#32;a*](u)\n');
    assert.equal(roundTrip([p(del(em(em(t('.')), t('b'))))]), '~~*_._&#98;*~~\n');
  });
});

describe('toMarkdown — onLossy names each node no Markdown reads back as', function () {
  it('names an empty emphasis or strong by its path, inside a table cell too', () => {
    assert.deepEqual(lossy([p(t('a '), strong(em()), t(' b'))]), {
      text: 'a **__** b\n',
      reports: [{ code: 'empty', path: [0, 1, 0], reason: 'an emphasis node with nothing in it, whose opener and closer would be one run' }],
    });
    const table = parseMarkdown('| a | b |\n| - | - |\n| c | d |').ast;
    table[0].children[1].children[1].children = [t('x '), strong(), t(' y')];
    assert.deepEqual(lossy(table).reports,
      [{ code: 'empty', path: [0, 1, 1, 1], reason: 'a strong node with nothing in it, whose opener and closer would be one run' }]);
  });

  it('names a node whose content starts with a soft line break or ends with a line break', () => {
    assert.deepEqual(lossy([p(t('x'), em({ type: 'softBreak' }, t('a')))]).reports,
      [{ code: 'line-edge', path: [0, 1], reason: 'an emphasis node whose content starts with a soft line break or ends with a line break' }]);
    assert.deepEqual(lossy([{ type: 'heading', depth: 3, children: [strong(t('a'), { type: 'break' })] }]).reports,
      [{ code: 'line-edge', path: [0, 0], reason: 'a strong node whose content starts with a soft line break or ends with a line break' }]);
  });

  it('names a strikethrough touching another', () => {
    assert.deepEqual(lossy([p(t('a '), del(t('b')), del(t('c')))]).reports,
      [{ code: 'touching', path: [0, 1], reason: 'a strikethrough touching another, whose two `~~` are one run of four' }]);
  });

  it('names the first node of content no spelling the printer derives or finds reads back as', () => {
    const ast = parseMarkdown('*\\**2;_"_\\*****\\*_').ast;
    assert.deepEqual(lossy(ast), {
      text: '*\\*_2;*"*\\*_*\\*\\*\\*\\_\n',
      reports: [{ code: 'unread', path: [0, 0, 0],
        reason: 'no spelling the printer derives or finds reads back as it: it reads back as the text "*_2;" where the document has the text "*"' }],
    });
  });

  it('prints content the derivation does not reach in the spelling the search finds', () => {
    assert.deepEqual(lossy(parseMarkdown('***a *****(******_*').ast), { text: '___a \\*****(****__\\__\n', reports: [] });
    canonical('***a *****(******_*');
  });

  it('is told nothing, and the text is the same, when every block reads back', () => {
    const doc = parseMarkdown('# t\n\n- *a* and __b__\n\n| *c* |\n| - |\n| d |\n');
    const { text, reports } = lossy(doc);
    assert.deepEqual(reports, []);
    assert.equal(text, toMarkdown(doc));
  });

  it('refuses an onLossy that is not a function', () => {
    assert.throws(() => toMarkdown([p(t('a'))], { onLossy: /** @type {any} */ ('log') }),
      { name: 'TypeError', message: "md toMarkdown: option 'onLossy' must be a function" });
  });
});

describe('toMarkdown — random runs and trees read back or are named, never read back as other nodes unannounced', function () {
  it('prints 6000 delimiter soups the reader made so that each reads back or is named', function () {
    const pieces = ['*', '**', '***', '_', '__', 'a', 'b', ' ', 'a ', ' b', '1', '.', '*', '_', '~~', '`c`', '[l](u)', '"', '(', '!', '\\*', '\\_', '&#42;'];
    let named = 0;
    for (let seed = 1; seed <= 6000; seed++) {
      const r = random(seed * 104729 + 7);
      let source = '';
      for (let i = 2 + r.int(60); i > 0; i--) source += r.pick(pieces);
      const ast = parseMarkdown(source).ast;
      const { text, reports } = lossy(ast);
      if (reports.length > 0) named++;
      else assert.deepEqual(parseMarkdown(text).ast, ast, `AST drift for ${JSON.stringify(source)} printed ${JSON.stringify(text)}`);
    }
    // the residue neither the derivation nor the search reaches: literal
    // delimiters inside nested runs (the source `*\\**2;_"_\\*****\\*_` is one)
    assert.equal(named, 7);
  });

  it('prints 1500 random trees of emphasis, strong, text and code so that each reads back or is named', function () {
    const CHARS = ['a', 'b', 'a', 'b', ' ', '.', '*', '_', '1', 'é', '(', ')', '!', ' '];
    let named = 0;
    for (let seed = 1; seed <= 1500; seed++) {
      const r = random(seed * 7919 + 3);
      let budget = 1 + r.int(200);
      const value = () => {
        let text = '';
        for (let i = 1 + r.int(4); i > 0; i--) text += r.pick(CHARS);
        return text;
      };
      /** @param {number} depth @returns {any[]} */
      const nodes = (depth) => {
        /** @type {any[]} */
        const out = [];
        for (let i = 1 + r.int(4); i > 0 && (budget > 0 || out.length === 0); i--) {
          budget--;
          const k = r.int(depth >= 6 ? 2 : 6);
          const node = k === 0 ? t(value())
            : k === 1 ? { type: 'inlineCode', value: r.pick(['c', 'x y', '*', '_']) }
              : k < 4 ? em(...nodes(depth + 1)) : strong(...nodes(depth + 1));
          const last = out[out.length - 1];
          if (node.type === 'text' && last !== undefined && last.type === 'text') last.value += node.value;
          else out.push(node);
        }
        return out;
      };
      const children = nodes(1);
      if (children[0].type === 'text') children[0].value = children[0].value.replace(/^\s+/, '') || 'p';
      const end = children[children.length - 1];
      if (end.type === 'text') end.value = end.value.replace(/\s+$/, '') || 'p';
      const ast = [p(...children)];
      const { text, reports } = lossy(ast);
      if (reports.length > 0) named++;
      else assert.deepEqual(parseMarkdown(text).ast, ast, `AST drift for seed ${seed} printed ${JSON.stringify(text)}`);
    }
    // most random trees hold a shape neither the derivation nor the search
    // reaches, whether or not Markdown reads back as it; none prints as other
    // nodes unannounced
    assert.equal(named, 1155);
  });
});

describe('toMarkdown — deriving a spelling costs time in proportion to the content', function () {
  // the content the search a stretch at a time spent most on: runs whose
  // literal `*` and `_` print bare, and an empty emphasis no spelling reads
  // back as, which made every search spend all it was given
  const UNIT = '.___a_b_1ba 1b_1**ab***__a _.1_b11****__1a **_ b***1*a1b.b b b __*__* * a a1__1*****____._. b**___********';
  /** @param {number} n @returns {any[]} */
  const unspellable = (n) => {
    /** @type {any[]} */
    const children = [];
    for (let i = 0; i < n; i++) {
      const [first, run, last] = parseMarkdown(UNIT).ast[0].children;
      const previous = children.pop();
      children.push(previous === undefined ? first : t(previous.value + ' plain ' + first.value),
        { ...run, children: [...run.children, em()] }, last);
    }
    return [p(...children)];
  };

  it('eight times the content at most multiplies the time by twenty-four, with a node no spelling reads back as', function () {
    const ratio = growthRatio((/** @type {any[]} */ ast) => toMarkdown(ast), unspellable(6), unspellable(48), { limit: 24 });
    assert.ok(ratio < 24, `eight times the content multiplied the time by ${ratio.toFixed(2)}`);
  });

  it('eight times the content at most multiplies the time by twenty-four, every run of it read back', function () {
    const small = parseMarkdown((UNIT + ' plain ').repeat(6)).ast;
    const large = parseMarkdown((UNIT + ' plain ').repeat(48)).ast;
    assert.deepEqual(lossy(large).reports, []);
    const ratio = growthRatio((/** @type {any[]} */ ast) => toMarkdown(ast), small, large, { limit: 24 });
    assert.ok(ratio < 24, `eight times the content multiplied the time by ${ratio.toFixed(2)}`);
  });
});
