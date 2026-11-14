//@ts-check
/**
 * @file What strings a schema's `pattern` lets through, read for the
 * contract diff's empty-schema decision: a pattern parsed once into the
 * constructs it is made of, then read three ways — the set of match
 * signatures (whether the pattern matches no string at all), the length
 * of a match (whether length bounds beside it leave room for one) and a
 * search for a witness, a string the validator's own pattern tester and
 * the length bounds accept. A witness proves a string-only schema holds
 * a value; a signature set or a length reading that leaves none proves
 * it holds nothing; neither is an honest "cannot tell".
 */

import { createSchemaPatternTester } from '@jarenjs/validate/references';

/**
 * One construct of a pattern:
 * - `anchor`: `^` (`caret`) or `$`;
 * - `set`: one character from a class, an escape or a literal (`src` its
 *   spelling; `none` where the class admits no character);
 * - `never`: a negative lookaround of nothing (`(?!)`), which never holds;
 * - `zero`: a word boundary, which consumes nothing;
 * - `ref`: a back-reference, by `index` or by `name`;
 * - `look`: a lookaround (`body` the pattern it looks for);
 * - `modifier`: a modifier group (`(?i:…)`);
 * - `group`: a group (`index` and `name` where it captures);
 * - `seq`, `alt`, `repeat`.
 * @typedef {{ k: 'anchor', caret: boolean }
 *   | { k: 'set', src: string, none: boolean }
 *   | { k: 'never' } | { k: 'zero' }
 *   | { k: 'ref', index: number | null, name: string | null }
 *   | { k: 'look', body: Construct }
 *   | { k: 'modifier', body: Construct }
 *   | { k: 'group', body: Construct, index: number | null, name: string | null }
 *   | { k: 'seq', items: Construct[] }
 *   | { k: 'alt', options: Construct[] }
 *   | { k: 'repeat', body: Construct, min: number, max: number }} Construct
 */

/**
 * Parse a pattern source (read in Unicode mode, as the validator compiles
 * it). `read` is `false` where a construct ran past the source or a
 * quantifier did not parse.
 * @param {string} source
 * @returns {{ root: Construct, read: boolean }}
 */
function parsePattern(source) {
  const n = source.length;
  let i = 0;
  let unread = false;
  let groups = 0;
  const at = (/** @type {number} */ k) => (k < n ? source[k] : '');
  const skipPast = (/** @type {string} */ close) => {
    const end = source.indexOf(close, i);
    if (end < 0) unread = true;
    i = end < 0 ? n : end + 1;
  };
  const hexAt = (/** @type {number} */ k) => (/^[0-9a-fA-F]{4}$/.test(source.slice(k, k + 4)) ? Number.parseInt(source.slice(k, k + 4), 16) : -1);
  /** One escape after the `\` at `i`, in a class or out of one: the letter it names. */
  const escape = () => {
    const letter = at(i + 1);
    if (letter === 'p' || letter === 'P' || (letter === 'u' && at(i + 2) === '{')) skipPast('}');
    else if (letter === 'k') skipPast('>');
    else if (letter === 'u') {
      const lead = hexAt(i + 2);
      i += 6;
      // an escaped surrogate pair is one code point in Unicode mode
      if (lead >= 0xD800 && lead <= 0xDBFF && at(i) === '\\' && at(i + 1) === 'u' && hexAt(i + 2) >= 0xDC00 && hexAt(i + 2) <= 0xDFFF) i += 6;
    }
    else if (letter === 'x') i += 4;
    else if (letter === 'c') i += 3;
    else if (letter >= '1' && letter <= '9') {
      i += 2;
      while (at(i) >= '0' && at(i) <= '9') i++;
    }
    else i += 2;
    return letter;
  };
  /** @returns {Construct} */
  const characterClass = () => {
    const start = i;
    i++;
    const negated = at(i) === '^';
    if (negated) i++;
    const letters = new Set();
    let members = 0;
    while (i < n && at(i) !== ']') {
      members++;
      if (at(i) === '\\') letters.add(escape());
      else i += /** @type {number} */ (source.codePointAt(i)) > 0xFFFF ? 2 : 1;
    }
    i++;
    const everything = ['dD', 'sS', 'wW'].some((pair) => letters.has(pair[0]) && letters.has(pair[1]));
    return { k: 'set', src: source.slice(start, i), none: negated ? everything : members === 0 };
  };
  /** @returns {Construct} */
  const group = () => {
    /** @type {'group' | 'look' | 'modifier'} */
    let kind = 'group';
    /** @type {number | null} */
    let index = null;
    /** @type {string | null} */
    let name = null;
    if (at(i + 1) !== '?') {
      i++;
      index = ++groups;
    }
    else if (at(i + 2) === ':') i += 3;
    else if (at(i + 2) === '<' && at(i + 3) !== '=' && at(i + 3) !== '!') {
      const from = i + 3;
      skipPast('>');
      index = ++groups;
      name = source.slice(from, i - 1);
    }
    else {
      // a lookaround (`(?!)` never matches) or a modifier group
      const negative = at(i + 2) === '!' || (at(i + 2) === '<' && at(i + 3) === '!');
      kind = at(i + 2) === '=' || at(i + 2) === '!' || at(i + 2) === '<' ? 'look' : 'modifier';
      if (kind === 'look') i += at(i + 2) === '<' ? 4 : 3;
      else skipPast(':');
      if (negative && at(i) === ')') {
        i++;
        return { k: 'never' };
      }
    }
    const body = disjunction();
    if (at(i) !== ')') unread = true;
    i++;
    return kind === 'group' ? { k: 'group', body, index, name } : { k: kind, body };
  };
  /** @returns {Construct} */
  const atom = () => {
    const c = at(i);
    const start = i;
    if (c === '^' || c === '$') {
      i++;
      return { k: 'anchor', caret: c === '^' };
    }
    if (c === '[') return characterClass();
    if (c === '(') return group();
    if (c === '\\') {
      const letter = escape();
      if (letter === 'b' || letter === 'B' || letter === '') return { k: 'zero' };
      if (letter === 'k') return { k: 'ref', index: null, name: source.slice(start + 3, i - 1) };
      if (letter >= '1' && letter <= '9') return { k: 'ref', index: Number(source.slice(start + 1, i)), name: null };
      return { k: 'set', src: source.slice(start, i), none: false };
    }
    i += /** @type {number} */ (source.codePointAt(i)) > 0xFFFF ? 2 : 1;
    return { k: 'set', src: source.slice(start, i), none: false };
  };
  /** @param {Construct} x @returns {Construct} */
  const quantified = (x) => {
    const c = at(i);
    let min = 1;
    let max = 1;
    if (c === '*' || c === '+' || c === '?') {
      i++;
      min = c === '+' ? 1 : 0;
      max = c === '?' ? 1 : Infinity;
    }
    else if (c === '{') {
      const bounds = /^\{(\d+)(,(\d*))?\}/.exec(source.slice(i));
      if (bounds === null) {
        unread = true;
        return x;
      }
      i += bounds[0].length;
      min = Number(bounds[1]);
      max = bounds[2] === undefined ? min : bounds[3] === '' ? Infinity : Number(bounds[3]);
    }
    else return x;
    if (at(i) === '?') i++;
    return { k: 'repeat', body: x, min, max };
  };
  /** @returns {Construct} */
  const alternative = () => {
    /** @type {Construct[]} */
    const items = [];
    while (i < n && at(i) !== '|' && at(i) !== ')') items.push(quantified(atom()));
    return { k: 'seq', items };
  };
  /** @returns {Construct} */
  function disjunction() {
    const options = [alternative()];
    while (at(i) === '|') {
      i++;
      options.push(alternative());
    }
    return options.length === 1 ? options[0] : { k: 'alt', options };
  }
  const root = disjunction();
  return { root, read: !unread && i === n };
}

//#region whether a pattern matches no string

// A pattern is read as the set of signatures its matches may have, three
// bits each: the match passes a `^` before it consumes a character, it
// passes a `$` after its last one, it consumes one. Without the `m` flag
// `^` holds only where the text starts and `$` where it ends, so a
// sequence drops a pair whose `^` follows a consumed character or whose
// `$` precedes one; an alternative unites; a class that admits no
// character (`[]`, `[^\s\S]`) has no signature. A construct the reading
// does not model — a lookaround, a word boundary, a back-reference, a
// modifier group — reads as the empty match that constrains nothing, so
// the set only ever over-approximates: an empty set is a proof.
const CARET = 1;
const DOLLAR = 2;
const CONSUMES = 4;
/** The signature set of the empty match alone. */
const EMPTY_MATCH = 1;
/** The signature set of one character. */
const ONE_CHAR = 1 << CONSUMES;

/**
 * The signatures of a match of `x` followed by a match of `y`.
 * @param {number} x @param {number} y
 */
function followedBy(x, y) {
  let out = 0;
  for (let s = 0; s < 8; s++) {
    if ((x & (1 << s)) === 0) continue;
    for (let t = 0; t < 8; t++) {
      if ((y & (1 << t)) === 0 || ((s & CONSUMES) && (t & CARET)) || ((s & DOLLAR) && (t & CONSUMES))) continue;
      out |= 1 << (s | t);
    }
  }
  return out;
}

/**
 * The signatures of `x` repeated `min` to `max` times. The powers of a
 * set walk at most 256 sets, so they cycle: the range is read over one
 * turn of the cycle past `min`.
 * @param {number} x @param {number} min @param {number} max
 */
function repeated(x, min, max) {
  if (!Number.isSafeInteger(min)) return EMPTY_MATCH;
  const powers = [EMPTY_MATCH];
  const index = new Map([[EMPTY_MATCH, 0]]);
  let next = followedBy(EMPTY_MATCH, x);
  while (!index.has(next)) {
    index.set(next, powers.length);
    powers.push(next);
    next = followedBy(next, x);
  }
  const start = /** @type {number} */ (index.get(next));
  const period = powers.length - start;
  let out = 0;
  for (let k = min; k <= Math.min(max, min + powers.length); k++) {
    out |= powers[k < powers.length ? k : start + ((k - start) % period)];
  }
  return out;
}

/**
 * The signature set of a construct.
 * @param {Construct} x
 * @returns {number}
 */
function signatures(x) {
  switch (x.k) {
    case 'anchor': return 1 << (x.caret ? CARET : DOLLAR);
    case 'set': return x.none ? 0 : ONE_CHAR;
    case 'never': return 0;
    case 'group': return signatures(x.body);
    case 'seq': return x.items.reduce((out, item) => followedBy(out, signatures(item)), EMPTY_MATCH);
    case 'alt': return x.options.reduce((out, option) => out | signatures(option), 0);
    case 'repeat': return repeated(signatures(x.body), x.min, x.max);
    default: return EMPTY_MATCH;
  }
}

/**
 * Whether a `pattern` matches no string, as the validator compiles it: a
 * source that does not compile in Unicode mode (the validator then reads
 * a `/source/flags` literal, or refuses it) answers no, and so does any
 * other pattern the signature reading above cannot prove empty.
 * @param {string} source
 */
export function patternMatchesNothing(source) {
  const parsed = compiledParse(source);
  return parsed !== null && parsed.read && signatures(parsed.root) === 0;
}

/**
 * {@link parsePattern} of a source that compiles in Unicode mode, or `null`.
 * @param {string} source
 */
function compiledParse(source) {
  try {
    void new RegExp(source, 'u');
  }
  catch {
    return null;
  }
  return parsePattern(source);
}

//#endregion

//#region whether length bounds leave room for a match

/**
 * The fewest code points a match of a construct consumes (`min`) and,
 * of them, the fewest that are each a grapheme cluster of their own
 * however the string around them reads (`safe`: {@link clusterSafe}
 * characters outside a modifier group, whose `i` may fold one past
 * ASCII) — a lookaround or a back-reference read as consuming none, so
 * neither is ever more than a match holds — and the most UTF-16 units a
 * match consumes (`max`), `Infinity` where that is unbounded and `null`
 * where a back-reference makes it unknown.
 * @param {Construct} x
 * @returns {{ min: number, max: number | null, safe: number }}
 */
function matchLengths(x) {
  switch (x.k) {
    case 'set': return x.none ? NO_MATCH : { min: 1, max: unitWidth(x.src), safe: clusterSafe(x.src) ? 1 : 0 };
    case 'never': return NO_MATCH;
    case 'ref': return { min: 0, max: null, safe: 0 };
    case 'modifier': return { ...matchLengths(x.body), safe: 0 };
    case 'group': return matchLengths(x.body);
    case 'seq': {
      const items = x.items.map(matchLengths);
      if (items.some((item) => item.min === Infinity)) return NO_MATCH;
      return items.reduce((out, item) => ({
        min: out.min + item.min,
        max: out.max === null || item.max === null ? null : out.max + item.max,
        safe: out.safe + item.safe,
      }), { min: 0, max: /** @type {number | null} */ (0), safe: 0 });
    }
    case 'alt': return x.options.map(matchLengths).reduce((out, option) => ({
      min: Math.min(out.min, option.min),
      max: out.max === null || option.max === null ? null : Math.max(out.max, option.max),
      safe: Math.min(out.safe, option.safe),
    }), NO_MATCH);
    case 'repeat': {
      const body = matchLengths(x.body);
      if (body.min === Infinity) return x.min === 0 ? { min: 0, max: 0, safe: 0 } : NO_MATCH;
      const max = body.max === null ? null : x.max === 0 || body.max === 0 ? 0 : x.max * body.max;
      return { min: x.min * body.min, max, safe: x.min * body.safe };
    }
    default: return { min: 0, max: 0, safe: 0 };
  }
}

/** The lengths of a construct no string matches. */
const NO_MATCH = Object.freeze({ min: Infinity, max: /** @type {number | null} */ (-Infinity), safe: Infinity });

/**
 * The most UTF-16 units the one character a `set` construct spells
 * consumes: two where it may be an astral character.
 * @param {string} src
 */
function unitWidth(src) {
  if (src === '.') return 2;
  if (src[0] === '[') return src[1] === '^' || /\\[pPDSW]|\\u\{|\\u[dD][89abAB]|[\uD800-\uDBFF]/.test(src) ? 2 : 1;
  if (src[0] !== '\\') return src.length;
  if (/^\\[pPDSW]/.test(src) || src.length === 12) return 2;
  return src.startsWith('\\u{') && Number.parseInt(src.slice(3, -1), 16) > 0xFFFF ? 2 : 1;
}

/**
 * The code point of a character a class or escape spells, or `null`
 * where it spells a set of them or is not read here.
 * @param {string} src - one literal character or one escape
 * @returns {number | null}
 */
function spelledCodePoint(src) {
  if (src[0] !== '\\') return src.length === 0 ? null : /** @type {number} */ (src.codePointAt(0));
  const letter = src[1];
  if (letter === 'x' || (letter === 'u' && src[2] !== '{')) return Number.parseInt(src.slice(2, letter === 'x' ? 4 : 6), 16);
  if (letter === 'u') return Number.parseInt(src.slice(3, -1), 16);
  if (letter === 'c') return src.charCodeAt(2) % 32;
  const named = { t: 9, n: 10, v: 11, f: 12, r: 13, 0: 0 }[letter];
  if (named !== undefined) return named;
  return /[A-Za-z0-9]/.test(letter) ? null : letter.charCodeAt(0);
}

/**
 * Whether every character a `set` construct admits is ASCII and no line
 * feed — characters each of which starts a grapheme cluster of its own
 * (the only ASCII pair that joins is CR LF), so a string holding `k` of
 * them is at least `k` long however the validator counts its length.
 * @param {string} src
 */
function clusterSafe(src) {
  const safe = (/** @type {number | null} */ c) => c !== null && c < 0x80 && c !== 10;
  if (src[0] !== '[') return src === '\\d' || src === '\\w' || (src !== '.' && safe(spelledCodePoint(src)));
  if (src[1] === '^') return false;
  const listed = members(src.slice(1, -1));
  for (let k = 0; k < listed.length; k++) {
    const member = listed[k];
    if (member === '\\d' || member === '\\w') continue;
    const low = member === '\\b' ? 8 : spelledCodePoint(member);
    if (!safe(low)) return false;
    if (listed[k + 1] === '-' && k + 2 < listed.length) {
      const high = listed[k + 2] === '\\b' ? 8 : spelledCodePoint(listed[k + 2]);
      if (!safe(high) || /** @type {number} */ (low) > 10 !== /** @type {number} */ (high) > 10) return false;
      k += 2;
    }
  }
  return true;
}

/**
 * The members a class body (or one escape or character) spells, in
 * order: an escape, or one character — a `-` between two makes a range.
 * @param {string} body
 * @returns {string[]}
 */
const members = (body) => body.match(/\\u\{[0-9a-fA-F]+\}|\\u[0-9a-fA-F]{4}|\\x[0-9a-fA-F]{2}|\\c[A-Za-z]|\\[pPk]\{[^}]*\}|\\.|[\s\S]/gu) ?? [];

//#endregion

//#region a witness

/** The characters a witness is built from, in the order they are tried: each class of characters first, then the rest. */
const POOL = [...'abAB01xyzXYZ9_-.@ !#$%&*+/:;=?^~,()[]{}|\\\'"<>`\t\n\r', ...Array.from({ length: 95 }, (_, k) => String.fromCharCode(32 + k)),
  '\u00e9', '\u00df', '\u0436', '\u03a9', '\u4e2d', '\u20ac', '\u00a0', '\u2028', '\u0301', '\u{1F600}', '\u{10000}'];
const KINDS = [/[a-z]/, /[A-Z]/, /[0-9]/, /[!-/:-@[-`{-~]/, /[\s]/, /[^ -~\s]/u];

/** {@link admits}' answers, by the characters named and the spelling. @type {Map<string, string[]>} */
const admitted = new Map();

/**
 * Up to six characters a `set` construct admits, as its own spelling
 * matches them in Unicode mode — tried from the characters the pattern's
 * parts name (`named`), then {@link POOL}; one of each kind first, so a
 * run of them mixes letters, digits and signs, and a sign another part
 * looks for (`(?=.*[!@#])` beside `.{8,}`) is among them.
 * @param {string} src
 * @param {string[]} named
 */
function admits(src, named) {
  const key = named.join('') + '\u0000' + src;
  let chars = admitted.get(key);
  if (chars !== undefined) return chars;
  chars = [];
  try {
    const one = new RegExp(`^(?:${src})$`, 'u');
    const all = [...new Set([...named, ...POOL])].filter((c) => one.test(c));
    for (const kind of KINDS) {
      const c = all.find((x) => kind.test(x));
      if (c !== undefined) chars.push(c);
    }
    for (const c of all) if (chars.length < 6 && !chars.includes(c)) chars.push(c);
  }
  catch {
    // a spelling that compiles only inside its pattern contributes no character
  }
  if (admitted.size >= 4096) admitted.clear();
  admitted.set(key, chars);
  return chars;
}

/**
 * The characters the `set` constructs of a pattern spell by name (a
 * literal, an escape of one, a class member or a range's ends), in order.
 * @param {Construct} x
 * @returns {string[]}
 */
function namedIn(x) {
  switch (x.k) {
    case 'set': {
      if (x.src === '.') return [];
      const listed = members(x.src[0] === '[' ? x.src.slice(x.src[1] === '^' ? 2 : 1, -1) : x.src);
      // a `-` between two members joins a range and names no character
      return listed.filter((member, k) => member !== '-' || k === 0 || k === listed.length - 1).map(spelledCodePoint)
        .filter((c) => c !== null).map((c) => String.fromCodePoint(/** @type {number} */ (c)));
    }
    case 'look': case 'modifier': case 'group': case 'repeat': return namedIn(x.body);
    case 'seq': return x.items.flatMap(namedIn);
    case 'alt': return x.options.flatMap(namedIn);
    default: return [];
  }
}

/** A partial witness: the text so far, its length in code points and what each group captured. @typedef {{ s: string, n: number, caps: Record<string, string> }} Partial */

/** Partials kept per code-point length. */
const PER_LENGTH = 3;

/** The pairings one search may weigh before it gives up: the answer is then `'unsure'`, never a guess. */
const SEARCH_BUDGET = 5000000;

/** Thrown when a search spent its budget. */
const SPENT = Symbol('spent');

/** The partial nothing has been built into yet. @type {Partial} */
const START = Object.freeze({ s: '', n: 0, caps: Object.freeze({}) });

/**
 * The search a witness is built in: the longest partial kept, in code
 * points, the characters the pattern's own parts name, what each
 * construct matches on its own, and the pairings left to weigh.
 * @typedef {{ cap: number, named: string[], built: Map<Construct, Partial[]>, left: number }} Search
 */

/**
 * Strings a construct may match on its own, built from its parts — a
 * lookaround and a word boundary passed over, a back-reference copying
 * what its group captured earlier in the same sequence — at most
 * {@link PER_LENGTH} per length up to `cap` code points, each construct
 * built once per search. Candidates only: the pattern tester decides.
 * @param {Construct} x
 * @param {Search} search
 * @returns {Partial[]}
 */
function built(x, search) {
  let out = search.built.get(x);
  if (out === undefined) {
    out = build(x, search);
    search.built.set(x, out);
  }
  return out;
}

/** {@link built}, unmemoized. @param {Construct} x @param {Search} search @returns {Partial[]} */
function build(x, search) {
  switch (x.k) {
    case 'set': return x.none ? [] : admits(x.src, search.named).map((c) => ({ s: c, n: 1, caps: START.caps }));
    case 'never': return [];
    case 'modifier': return built(x.body, search);
    case 'group': {
      const inner = built(x.body, search);
      if (x.index === null) return inner;
      return inner.map((r) => ({ ...r, caps: { ...r.caps, [String(x.index)]: r.s, ...(x.name === null ? {} : { [x.name]: r.s }) } }));
    }
    case 'seq': {
      let out = [START];
      for (const item of x.items) {
        // a back-reference copies what this very partial captured
        out = item.k === 'ref' ? prune(out.map((p) => {
          const text = p.caps[item.name ?? String(item.index)] ?? '';
          return { s: p.s + text, n: p.n + [...text].length, caps: p.caps };
        }), search.cap) : joined(out, built(item, search), search);
      }
      return out;
    }
    case 'alt': return prune(x.options.flatMap((option) => built(option, search)), search.cap);
    case 'repeat': {
      const body = built(x.body, search);
      /** @type {Partial[]} */
      let out = x.min === 0 ? [START] : [];
      let current = [START];
      for (let k = 1; k <= x.max && current.length > 0; k++) {
        const next = joined(current, body, search);
        const longest = Math.max(...current.map((p) => p.n));
        const grew = next.some((p) => p.n > longest);
        if (k >= x.min) out = prune([...out, ...next], search.cap);
        // a body that consumes nothing more repeats into what it already built
        if (!grew) {
          if (k >= x.min) break;
          k = x.min - 1;
        }
        current = next;
      }
      return out;
    }
    default: return [START];
  }
}

/**
 * Each partial followed by a match of the next construct (`after`), at
 * most {@link PER_LENGTH} per length up to the search's cap, the
 * matches taken from one past the partial's length on, so a run mixes the
 * characters a class admits.
 * @param {Partial[]} partials
 * @param {Partial[]} after
 * @param {Search} search
 * @returns {Partial[]}
 */
function joined(partials, after, search) {
  /** @type {Map<number, Partial[]>} */
  const byLength = new Map();
  for (const r of after) byLength.set(r.n, [...(byLength.get(r.n) ?? []), r]);
  /** @type {Map<number, number>} */
  const kept = new Map();
  /** @type {Partial[]} */
  const out = [];
  for (const p of partials) {
    for (const [n, list] of byLength) {
      if (--search.left < 0) throw SPENT;
      const length = p.n + n;
      if (length > search.cap) continue;
      for (let j = 0; j < list.length && (kept.get(length) ?? 0) < PER_LENGTH; j++) {
        const r = list[(p.n + j) % list.length];
        kept.set(length, (kept.get(length) ?? 0) + 1);
        out.push({ s: p.s + r.s, n: length, caps: Object.keys(r.caps).length === 0 ? p.caps : { ...p.caps, ...r.caps } });
      }
    }
  }
  return out;
}

/**
 * At most {@link PER_LENGTH} partials per code-point length, none past `cap`.
 * @param {Partial[]} partials @param {number} cap
 */
function prune(partials, cap) {
  /** @type {Map<number, number>} */
  const kept = new Map();
  return partials.filter((p) => {
    const count = kept.get(p.n) ?? 0;
    if (p.n > cap || count >= PER_LENGTH) return false;
    kept.set(p.n, count + 1);
    return true;
  });
}

/**
 * The lengths of a string the validator may count: UTF-16 units, code
 * points and grapheme clusters.
 * @param {string} s
 */
function lengthsOf(s) {
  let clusters = 0;
  for (const _ of SEGMENTER.segment(s)) clusters++;
  return [s.length, [...s].length, clusters];
}

const SEGMENTER = new Intl.Segmenter();

//#endregion

/** {@link stringsHeld}'s answers, by pattern and bounds. @type {Map<string, 'none' | 'some' | 'unsure'>} */
const heldKnown = new Map();

/**
 * Whether any string matches the pattern `source` within the length
 * bounds beside it, however the validator counts a length: `'none'` where
 * none can — the pattern matches no string ({@link patternMatchesNothing}),
 * a match holds more characters, each its own grapheme cluster, than
 * `maxLength` lets through (none but the empty string under
 * `maxLength: 0`), or the pattern spans the whole string and
 * its longest match is shorter than `minLength` —, `'some'` where a
 * witness built from the pattern's own parts passes the validator's
 * pattern tester and the bounds, and `'unsure'` otherwise.
 * @param {string} source
 * @param {number} minLength - 0 where none is given
 * @param {number} maxLength - `Infinity` where none is given
 * @returns {'none' | 'some' | 'unsure'}
 */
export function stringsHeld(source, minLength, maxLength) {
  const key = `${minLength} ${maxLength} ${source}`;
  let answer = heldKnown.get(key);
  if (answer === undefined) {
    answer = readHeld(source, minLength, maxLength);
    if (heldKnown.size >= 4096) heldKnown.clear();
    heldKnown.set(key, answer);
  }
  return answer;
}

/** {@link stringsHeld}, uncached. @param {string} source @param {number} minLength @param {number} maxLength @returns {'none' | 'some' | 'unsure'} */
function readHeld(source, minLength, maxLength) {
  /** @type {(value: string) => boolean} */
  let tests;
  try {
    tests = createSchemaPatternTester(source);
  }
  catch {
    return 'unsure';
  }
  // the one string no longer than nothing
  if (maxLength === 0) return minLength === 0 && tests('') ? 'some' : 'none';
  const parsed = compiledParse(source);
  if (parsed === null || !parsed.read) return 'unsure';
  const { root } = parsed;
  if (signatures(root) === 0) return 'none';
  const lengths = matchLengths(root);
  if (lengths.safe > maxLength) return 'none';
  // a match that passes a `^` before it consumes anything and a `$`
  // after it is the whole string
  const whole = (signatures(root) & ~(1 << (CARET | DOLLAR | CONSUMES)) & ~(1 << (CARET | DOLLAR))) === 0;
  if (whole && lengths.max !== null && lengths.max < minLength) return 'none';
  // long enough for the shortest match and the shortest string allowed, and a little room past both
  const cap = Math.min(maxLength, Math.max(minLength, Number.isFinite(lengths.min) ? lengths.min : 0) + 16, 512);
  /** @type {Partial[]} */
  let found;
  try {
    found = built(root, { cap, named: [...new Set(namedIn(root))], built: new Map(), left: SEARCH_BUDGET });
  }
  catch (error) {
    if (error === SPENT) return 'unsure';
    throw error;
  }
  const fits = (/** @type {string} */ s) => lengthsOf(s).every((length) => length >= minLength && length <= maxLength);
  for (const p of found.filter((q) => q.n >= minLength).slice(0, 200)) if (fits(p.s) && tests(p.s)) return 'some';
  // a match inside a longer string: the longest ones padded to the shortest length allowed
  for (const p of found.filter((q) => q.n < minLength).sort((x, y) => y.n - x.n).slice(0, 12)) {
    for (const filler of ['a', ' ', '0']) {
      const pad = filler.repeat(minLength - p.n);
      for (const padded of [p.s + pad, pad + p.s]) if (fits(padded) && tests(padded)) return 'some';
    }
  }
  return 'unsure';
}
