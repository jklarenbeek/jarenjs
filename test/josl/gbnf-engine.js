// A GBNF reader and recognizer, written for the tests only.
//
// The roadmap deferred shipping a raw-text grammar because nothing in this
// repository could tell whether one was right. This is that missing piece:
// it parses the emitted grammar, desugars it to plain BNF and recognizes
// text with an Earley parser, so both directions can be checked — that the
// grammar accepts every document the parser accepts, and that everything
// the grammar generates the parser accepts.
//
// Earley is the right algorithm here precisely because it does not care
// about ambiguity or left recursion, so the grammar under test can stay
// written the way a human would read it next to the TOML ABNF.

import { mulberry32 } from '@jarenjs/core/random';

//#region grammar reader

class Reader {
  constructor(text) {
    this.text = text;
    this.pos = 0;
  }

  ws() {
    for (;;) {
      const c = this.text[this.pos];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
        this.pos++;
        continue;
      }
      if (c === '#') {
        while (this.pos < this.text.length && this.text[this.pos] !== '\n')
          this.pos++;
        continue;
      }
      return;
    }
  }

  // whitespace that does not cross a line: a rule ends at its newline
  inlineWs() {
    for (;;) {
      const c = this.text[this.pos];
      if (c === ' ' || c === '\t') {
        this.pos++;
        continue;
      }
      if (c === '#') {
        while (this.pos < this.text.length && this.text[this.pos] !== '\n')
          this.pos++;
        continue;
      }
      return;
    }
  }

  eof() {
    this.ws();
    return this.pos >= this.text.length;
  }
}

const NAME_RE = /[A-Za-z][A-Za-z0-9-]*/y;

function parseEscape(reader) {
  const { text } = reader;
  const c = text[reader.pos++];
  switch (c) {
    case 'n': return 0x0A;
    case 'r': return 0x0D;
    case 't': return 0x09;
    case '\\': return 0x5C;
    case '"': return 0x22;
    case "'": return 0x27;
    case '[': return 0x5B;
    case ']': return 0x5D;
    case 'x': case 'u': case 'U': {
      const len = c === 'x' ? 2 : (c === 'u' ? 4 : 8);
      const hex = text.slice(reader.pos, reader.pos + len);
      if (hex.length !== len || !/^[0-9a-fA-F]+$/.test(hex))
        throw new Error(`bad \\${c} escape at ${reader.pos}`);
      reader.pos += len;
      return parseInt(hex, 16);
    }
    default:
      if (c === undefined)
        throw new Error('grammar ended inside an escape');
      return c.codePointAt(0);
  }
}

function parseClass(reader) {
  reader.pos++; // '['
  const negated = reader.text[reader.pos] === '^';
  if (negated)
    reader.pos++;
  const ranges = [];
  while (reader.text[reader.pos] !== ']') {
    if (reader.pos >= reader.text.length)
      throw new Error('unterminated character class');
    let lo;
    if (reader.text[reader.pos] === '\\') {
      reader.pos++;
      lo = parseEscape(reader);
    }
    else {
      lo = reader.text.codePointAt(reader.pos);
      reader.pos += String.fromCodePoint(lo).length;
    }
    let hi = lo;
    if (reader.text[reader.pos] === '-' && reader.text[reader.pos + 1] !== ']') {
      reader.pos++;
      if (reader.text[reader.pos] === '\\') {
        reader.pos++;
        hi = parseEscape(reader);
      }
      else {
        hi = reader.text.codePointAt(reader.pos);
        reader.pos += String.fromCodePoint(hi).length;
      }
    }
    ranges.push([lo, hi]);
  }
  reader.pos++; // ']'
  return { t: 'class', ranges, negated };
}

function parseLiteral(reader) {
  reader.pos++; // '"'
  const chars = [];
  while (reader.text[reader.pos] !== '"') {
    if (reader.pos >= reader.text.length)
      throw new Error('unterminated literal');
    if (reader.text[reader.pos] === '\\') {
      reader.pos++;
      chars.push(parseEscape(reader));
      continue;
    }
    const cp = reader.text.codePointAt(reader.pos);
    reader.pos += String.fromCodePoint(cp).length;
    chars.push(cp);
  }
  reader.pos++; // '"'
  return { t: 'seq', items: chars.map((cp) => ({ t: 'class', ranges: [[cp, cp]], negated: false })) };
}

function parseAtom(reader) {
  reader.inlineWs();
  const c = reader.text[reader.pos];
  if (c === '(') {
    reader.pos++;
    const inner = parseAlt(reader);
    reader.inlineWs();
    if (reader.text[reader.pos] !== ')')
      throw new Error(`expected ')' at ${reader.pos}`);
    reader.pos++;
    return inner;
  }
  if (c === '"')
    return parseLiteral(reader);
  if (c === '[')
    return parseClass(reader);
  NAME_RE.lastIndex = reader.pos;
  const m = NAME_RE.exec(reader.text);
  if (m === null)
    throw new Error(`expected a rule reference at ${reader.pos}: ${JSON.stringify(reader.text.slice(reader.pos, reader.pos + 20))}`);
  reader.pos = NAME_RE.lastIndex;
  return { t: 'ref', name: m[0] };
}

function parsePostfix(reader) {
  let node = parseAtom(reader);
  for (;;) {
    const c = reader.text[reader.pos];
    if (c === '*' || c === '+' || c === '?') {
      reader.pos++;
      node = { t: 'rep', node, kind: c };
      continue;
    }
    return node;
  }
}

// A sequence ends at '|', ')', the end of the line, or the end of input.
function parseSeq(reader) {
  const items = [];
  for (;;) {
    reader.inlineWs();
    const c = reader.text[reader.pos];
    if (c === undefined || c === '|' || c === ')' || c === '\n' || c === '\r')
      break;
    items.push(parsePostfix(reader));
  }
  return { t: 'seq', items };
}

function parseAlt(reader) {
  const options = [parseSeq(reader)];
  for (;;) {
    // an alternation may continue on the next line
    const save = reader.pos;
    reader.ws();
    if (reader.text[reader.pos] === '|') {
      reader.pos++;
      options.push(parseSeq(reader));
      continue;
    }
    reader.pos = save;
    return options.length === 1 ? options[0] : { t: 'alt', options };
  }
}

/**
 * Parse GBNF text into a map of rule name to expression AST.
 * @param {string} text - GBNF grammar source
 * @returns {Map<string, object>} Rule definitions in source order
 */
export function parseGbnf(text) {
  const reader = new Reader(text);
  const rules = new Map();
  while (!reader.eof()) {
    NAME_RE.lastIndex = reader.pos;
    const m = NAME_RE.exec(text);
    if (m === null || m.index !== reader.pos)
      throw new Error(`expected a rule name at ${reader.pos}`);
    reader.pos = NAME_RE.lastIndex;
    reader.inlineWs();
    if (text.slice(reader.pos, reader.pos + 3) !== '::=')
      throw new Error(`expected '::=' after '${m[0]}'`);
    reader.pos += 3;
    if (rules.has(m[0]))
      throw new Error(`rule '${m[0]}' is defined twice`);
    rules.set(m[0], parseAlt(reader));
  }
  return rules;
}

//#endregion

//#region desugaring to BNF

// Earley works on plain alternatives of symbol sequences, so groups and
// repetitions become synthetic nonterminals. Repetition is emitted
// left-recursively, which Earley handles and which keeps the item sets
// from growing with the repetition count.
class Bnf {
  constructor() {
    this.names = new Map(); // name -> rule index
    this.alts = []; // rule index -> array of symbol arrays
    this.labels = [];
    this.synth = 0;
  }

  rule(name) {
    let idx = this.names.get(name);
    if (idx === undefined) {
      idx = this.alts.length;
      this.names.set(name, idx);
      this.alts.push([]);
      this.labels.push(name);
    }
    return idx;
  }

  fresh(hint) {
    return this.rule(`${hint}~${this.synth++}`);
  }
}

function lower(bnf, node, out) {
  switch (node.t) {
    case 'seq':
      for (const item of node.items)
        lower(bnf, item, out);
      return;
    case 'class':
      out.push({ cls: node });
      return;
    case 'ref':
      out.push({ ref: node.name });
      return;
    case 'alt': {
      const idx = bnf.fresh('alt');
      for (const option of node.options) {
        const seq = [];
        lower(bnf, option, seq);
        bnf.alts[idx].push(seq);
      }
      out.push({ rule: idx });
      return;
    }
    case 'rep': {
      const inner = [];
      lower(bnf, node.node, inner);
      const idx = bnf.fresh('rep');
      if (node.kind === '?') {
        bnf.alts[idx].push([], inner);
      }
      else if (node.kind === '*') {
        bnf.alts[idx].push([], [{ rule: idx }, ...inner]);
      }
      else {
        bnf.alts[idx].push(inner, [{ rule: idx }, ...inner]);
      }
      out.push({ rule: idx });
      return;
    }
    default:
      throw new Error(`unknown node ${node.t}`);
  }
}

/**
 * Desugar a parsed GBNF grammar into plain BNF for the recognizer.
 * @param {Map<string, object>} rules - Output of `parseGbnf`
 * @returns {object} The BNF grammar
 */
export function toBnf(rules) {
  const bnf = new Bnf();
  for (const name of rules.keys())
    bnf.rule(name);
  for (const [name, node] of rules) {
    const idx = bnf.rule(name);
    const options = node.t === 'alt' ? node.options : [node];
    for (const option of options) {
      const seq = [];
      lower(bnf, option, seq);
      bnf.alts[idx].push(seq);
    }
  }
  // resolve name references now that every rule exists
  for (const alts of bnf.alts)
    for (const seq of alts)
      for (const sym of seq)
        if (sym.ref !== undefined) {
          const idx = bnf.names.get(sym.ref);
          if (idx === undefined)
            throw new Error(`rule '${sym.ref}' is referenced but never defined`);
          sym.rule = idx;
          delete sym.ref;
        }
  return bnf;
}

//#endregion

//#region recognizer

function matches(cls, cp) {
  let hit = false;
  for (const [lo, hi] of cls.ranges)
    if (cp >= lo && cp <= hi) {
      hit = true;
      break;
    }
  return cls.negated ? !hit : hit;
}

function nullableSet(bnf) {
  const nullable = new Set();
  for (;;) {
    let grew = false;
    for (let r = 0; r < bnf.alts.length; ++r) {
      if (nullable.has(r))
        continue;
      for (const seq of bnf.alts[r]) {
        if (seq.every((s) => s.rule !== undefined && nullable.has(s.rule))) {
          nullable.add(r);
          grew = true;
          break;
        }
      }
    }
    if (!grew)
      return nullable;
  }
}

/**
 * Whether the grammar derives `text` in full from `start`.
 * @param {object} bnf - Grammar from `toBnf`
 * @param {string} text - Input text
 * @param {string} [start] - Entry rule name
 * @returns {boolean} True when the whole input is derivable
 */
export function recognizes(bnf, text, start = 'root') {
  const startRule = bnf.names.get(start);
  if (startRule === undefined)
    throw new Error(`no rule '${start}'`);
  const nullable = nullableSet(bnf);
  const input = Array.from(text).map((ch) => ch.codePointAt(0));
  const n = input.length;
  const sets = new Array(n + 1);
  const seen = new Array(n + 1);
  for (let i = 0; i <= n; ++i) {
    sets[i] = [];
    seen[i] = new Set();
  }

  const add = (i, rule, alt, dot, origin) => {
    const key = `${rule},${alt},${dot},${origin}`;
    if (seen[i].has(key))
      return;
    seen[i].add(key);
    sets[i].push({ rule, alt, dot, origin });
  };

  for (let a = 0; a < bnf.alts[startRule].length; ++a)
    add(0, startRule, a, 0, 0);

  for (let i = 0; i <= n; ++i) {
    const set = sets[i];
    for (let k = 0; k < set.length; ++k) {
      const item = set[k];
      const seq = bnf.alts[item.rule][item.alt];
      if (item.dot === seq.length) {
        // complete: advance every item waiting on this rule
        const waiting = sets[item.origin];
        for (let w = 0; w < waiting.length; ++w) {
          const other = waiting[w];
          const otherSeq = bnf.alts[other.rule][other.alt];
          const sym = otherSeq[other.dot];
          if (sym !== undefined && sym.rule === item.rule)
            add(i, other.rule, other.alt, other.dot + 1, other.origin);
        }
        continue;
      }
      const sym = seq[item.dot];
      if (sym.rule !== undefined) {
        for (let a = 0; a < bnf.alts[sym.rule].length; ++a)
          add(i, sym.rule, a, 0, i);
        // a nullable nonterminal may be skipped outright
        if (nullable.has(sym.rule))
          add(i, item.rule, item.alt, item.dot + 1, item.origin);
        continue;
      }
      // scan
      if (i < n && matches(sym.cls, input[i]))
        add(i + 1, item.rule, item.alt, item.dot + 1, item.origin);
    }
  }

  return sets[n].some((item) =>
    item.rule === startRule
    && item.origin === 0
    && item.dot === bnf.alts[item.rule][item.alt].length);
}

//#endregion

//#region generation

// Random text derived from the grammar. `budget` shrinks with depth so a
// left-recursive repetition rule terminates instead of running away.
function derive(bnf, rule, rnd, budget, out) {
  const alts = bnf.alts[rule];
  const seq = budget <= 0
    ? alts.reduce((best, a) => (a.length < best.length ? a : best), alts[0])
    : alts[Math.floor(rnd() * alts.length)];
  for (const sym of seq) {
    if (sym.rule !== undefined) {
      derive(bnf, sym.rule, rnd, budget - 1, out);
      continue;
    }
    const { ranges, negated } = sym.cls;
    if (!negated) {
      const [lo, hi] = ranges[Math.floor(rnd() * ranges.length)];
      // keep generated text inside the BMP printable range so failures are
      // about grammar shape, not about exotic code points
      const capped = Math.min(hi, lo + 64);
      out.push(lo + Math.floor(rnd() * (capped - lo + 1)));
      continue;
    }
    for (let tries = 0; ; ++tries) {
      const cp = 0x20 + Math.floor(rnd() * 0x5E);
      if (matches(sym.cls, cp) || tries > 200) {
        out.push(cp);
        break;
      }
    }
  }
}

/**
 * Generate a text sample derived from the grammar.
 * @param {object} bnf - Grammar from `toBnf`
 * @param {number} seed - PRNG seed, so failures reproduce
 * @param {string} [start] - Entry rule name
 * @param {number} [budget] - Derivation depth budget
 * @returns {string} The generated text
 */
export function generate(bnf, seed, start = 'root', budget = 14) {
  const rule = bnf.names.get(start);
  if (rule === undefined)
    throw new Error(`no rule '${start}'`);
  const out = [];
  derive(bnf, rule, mulberry32(seed), budget, out);
  return out.map((cp) => String.fromCodePoint(cp)).join('');
}

//#endregion
