//@ts-check
// One scanner reads both catalog tokenizers' text: the lenient token stream the
// read-back walks (`sqlTokens`) and the strict one a declaration's identity is
// built from (`comparableDeclaredSql`). Each stream is pinned on its own
// grammar's inputs, so a change to the shared comment, quote or loop code shows
// in both.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { comparableDeclaredSql } from '@jarenjs/db';
import { QUOTE, SIMPLE, SPACE, WORD_PART, WORD_START, scannerFor, sqlTokens } from '../../packages/db/src/dialects/check-read.js';
import { postgresSqlToken } from '../../packages/db/src/dialects/postgres-migration.js';

/** @param {{ kind: string, value: string, at: number }[]} tokens */
const rows = (tokens) => tokens.map((t) => [t.kind, t.value, t.at]);

/** @type {[string, [string, string, number][]][]} */
const LENIENT = [
  ["a$b $c9 _x$ $", [["word", "a$b", 0], ["symbol", "$", 4], ["word", "c9", 5], ["word", "_x$", 8], ["symbol", "$", 12]]],
  ["CREATE TABLE t (a int, b text DEFAULT 'it''s')", [["word", "CREATE", 0], ["word", "TABLE", 7], ["word", "t", 13], ["symbol", "(", 15], ["word", "a", 16], ["word", "int", 18], ["symbol", ",", 21], ["word", "b", 23], ["word", "text", 25], ["word", "DEFAULT", 30], ["string", "it's", 38], ["symbol", ")", 45]]],
  ["SELECT \"a \"\"q\"\" b\", `c``d`, [e] -- tail\nFROM /* x */ t", [["word", "SELECT", 0], ["identifier", "a \"q\" b", 7], ["symbol", ",", 18], ["identifier", "c`d", 20], ["symbol", ",", 26], ["symbol", "[", 28], ["word", "e", 29], ["symbol", "]", 30], ["word", "FROM", 40], ["word", "t", 53]]],
  ["x::int, y :: text, 1.5e+3 + .25 - 7.", [["word", "x", 0], ["symbol", "::", 1], ["word", "int", 3], ["symbol", ",", 6], ["word", "y", 8], ["symbol", "::", 10], ["word", "text", 13], ["symbol", ",", 17], ["number", "1.5e+3", 19], ["symbol", "+", 26], ["number", ".25", 28], ["symbol", "-", 32], ["number", "7.", 34]]],
  ["a\u00a0b\u2028c\ufeffd\u000bf", [["word", "a", 0], ["word", "b", 2], ["word", "c", 4], ["word", "d", 6], ["word", "f", 8]]],
  ["\u00e9_1 $x $ 1_000 0x1F", [["symbol", "\u00e9", 0], ["word", "_1", 1], ["symbol", "$", 4], ["word", "x", 5], ["symbol", "$", 7], ["number", "1", 9], ["word", "_000", 10], ["number", "0", 15], ["word", "x1F", 16]]],
  ["'open", []],
  ["/* open", []],
  ["\"open", []],
  ["a\u0000b", []],
  ["'a\u0000b'", []],
  ["-- only a comment", []],
  ["", []],
];

/** @type {[string, [string, string, number][]][]} */
const NATIVE = [
  ["SELECT E'a\\'b', $$COMMIT;$$, $tag$ x ' $tag$ /* a /* nested */ b */ z", [["word", "SELECT", 0], ["string", "a\\'b", 7], ["symbol", ",", 14], ["string", "COMMIT;", 16], ["symbol", ",", 27], ["string", " x ' ", 29], ["word", "z", 68]]],
  ["SELECT $$open", []],
  ["SELECT /* open", []],
];

/** @type {[string, string | { throws: string }][]} */
const STRICT = [
  ["CREATE TABLE IF NOT EXISTS t (a int)", "CREATE TABLE t(a int)"],
  ["create table [a b] (\"c d\" int, `e` text, x'0AfF' )", "create table [a b](\"c d\" int,`e` text,x'0AfF')"],
  ["a->>b->c||d<<e>>f<=g>=h==i!=j<>k", "a ->> b -> c || d << e >> f <= g >= h == i != j <> k"],
  ["0x1_F 1_0.5_0e-1_0 .5", "0x1_F 1_0.5_0e-1_0 .5"],
  ["\u00e9_1 $x", {"throws": "SQL declaration cannot be compared: unsupported token at 4"}],
  ["-- c\n/* c */ ( 'a''b' )", "('a''b')"],
  ["", {"throws": "SQL declaration cannot be compared: empty declaration"}],
  [")", {"throws": "SQL declaration cannot be compared: unbalanced parentheses"}],
  [")(", {"throws": "SQL declaration cannot be compared: unbalanced parentheses"}],
  ["(", {"throws": "SQL declaration cannot be compared: unbalanced parentheses"}],
  ["/* x", {"throws": "SQL declaration cannot be compared: unterminated comment"}],
  ["'x", {"throws": "SQL declaration cannot be compared: unterminated quoted token"}],
  ["[x", {"throws": "SQL declaration cannot be compared: unterminated quoted token"}],
  ["x'zz'", {"throws": "SQL declaration cannot be compared: invalid blob literal"}],
  ["x'0'", {"throws": "SQL declaration cannot be compared: invalid blob literal"}],
  ["[a]]", {"throws": "SQL declaration cannot be compared: unsupported token at 3"}],
  ["[a'b] x", "[a'b] x"],
  ["\"a\"\"b\" `c``d`", "\"a\"\"b\" `c``d`"],
  ["1a", {"throws": "SQL declaration cannot be compared: invalid numeric token"}],
  ["1.2.3", {"throws": "SQL declaration cannot be compared: invalid numeric token"}],
  ["0x", {"throws": "SQL declaration cannot be compared: invalid numeric token"}],
  ["a\u000bb", {"throws": "SQL declaration cannot be compared: unsupported token at 1"}],
  ["a\u00a0b", "a\u00a0b"],
  ["a\u0000b", {"throws": "SQL declaration cannot be compared: unsupported token at 1"}],
  ["'a\u0000b'", {"throws": "SQL declaration cannot be compared: NUL in quoted text"}],
  ["a # b", {"throws": "SQL declaration cannot be compared: unsupported token at 2"}],
];

describe('the catalog token stream', () => {
  for (const [sql, tokens] of LENIENT) {
    it(`reads ${JSON.stringify(sql)} as ${tokens.length} tokens, or none for text it cannot read`, () => {
      assert.deepEqual(rows(sqlTokens(sql)), tokens);
    });
  }
  for (const [sql, tokens] of NATIVE) {
    it(`reads ${JSON.stringify(sql)} through PostgreSQL's native tokens`, () => {
      assert.deepEqual(rows(sqlTokens(sql, postgresSqlToken)), tokens);
    });
  }
});

describe('the declaration identity token stream', () => {
  for (const [sql, identity] of STRICT) {
    it(`${typeof identity === 'string' ? 'spells' : 'refuses'} ${JSON.stringify(sql)}`, () => {
      if (typeof identity === 'string') assert.equal(comparableDeclaredSql(sql), identity);
      else assert.throws(() => comparableDeclaredSql(sql), { name: 'TypeError', message: identity.throws });
    });
  }
});

describe('the shared scanner', () => {
  /** @type {(sql: string, grammar: any, native?: any) => any[]} */
  const scanSql = (sql, grammar, native) => scannerFor(grammar)(sql, native).map((t) => `${t.kind}:${t.text}`);
  /** @type {import('../../packages/db/src/dialects/check-read.js').SqlGrammar} */
  const grammar = {
    classOf: (code) => code === 32 ? SPACE : code >= 97 && code <= 122 ? WORD_START | WORD_PART
      : code === 39 || code === 91 ? QUOTE : code === 40 || code === 41 || code === 44 ? SIMPLE : 0,
    blob: true, number: /[0-9]+/y, closedNumbers: true,
    symbol: /[(),]/y, nulAnywhere: false, declaration: true,
    refuse: (reason) => { throw new RangeError(reason); },
  };

  it('reads each token of a declaration grammar with the text it covers', () => {
    assert.deepEqual(scanSql("f( 'a''b', [c d] , x'0a' 12 ) -- end", grammar),
      ['word:f', 'symbol:(', "string:'a''b'", 'symbol:,', 'identifier:[c d]', 'symbol:,', "blob:x'0a'", 'number:12', 'symbol:)']);
  });

  it('gives the grammar the reason a text cannot be read, and stops there', () => {
    for (const [sql, reason] of [
      ['a /* b', 'unterminated comment'], ["a 'b", 'unterminated quoted token'], ["a 'b\u0000'", 'NUL in quoted text'],
      ["a x'0'", 'invalid blob literal'], ['a 12b', 'invalid numeric token'], ['a ;', 'unsupported token at 2'],
      ['a )', 'unbalanced parentheses'], ['a (', 'unbalanced parentheses'], [' -- only', 'empty declaration']]) {
      assert.throws(() => scanSql(sql, grammar), { name: 'RangeError', message: reason }, sql);
    }
  });

  it('lets a native token reader claim, skip or refuse a stretch before the grammar sees it', () => {
    const native = (/** @type {string} */ sql, /** @type {number} */ at) => {
      if (sql[at] === '#') return { kind: 'tag', value: 'T', end: at + 1 };
      if (sql[at] === '%') return { kind: 'comment', end: at + 1 };
      if (sql[at] === '!') return null;
      return undefined;
    };
    assert.deepEqual(scanSql('a # b % c', grammar, native), ['word:a', 'tag:#', 'word:b', 'word:c']);
    assert.throws(() => scanSql('a !', grammar, native), { message: 'unreadable native token' });
  });
});

describe('scanning many quoted tokens', () => {
  /** @param {number} count */
  const list = (count) => `CREATE TABLE t (a TEXT CHECK (a IN (${Array.from({ length: count }, (_, i) => `'v${i}'`).join(', ')})))`;
  /** @param {(sql: string) => unknown} run @param {string} sql */
  const best = (run, sql) => {
    let fastest = Infinity;
    for (let attempt = 0; attempt < 7; attempt++) {
      const from = process.hrtime.bigint();
      for (let i = 0; i < 5; i++) run(sql);
      fastest = Math.min(fastest, Number(process.hrtime.bigint() - from));
    }
    return fastest;
  };

  for (const [name, run] of /** @type {[string, (sql: string) => unknown][]} */ ([
    ['the catalog reader', (sql) => sqlTokens(sql)],
    ['the declaration identity', (sql) => comparableDeclaredSql(sql)],
  ])) {
    it(`${name} grows in step with the text over an 8x step`, () => {
      for (const sql of [list(2000), list(16000)]) run(sql);
      const small = best(run, list(2000)), large = best(run, list(16000));
      // Linear is about 8x; a scan from every quoted token to the end of the text is over 25x.
      assert.ok(large / small < 16, `${name}: ${large / small} times the cost for 8 times the quoted tokens`);
    });
  }
});
