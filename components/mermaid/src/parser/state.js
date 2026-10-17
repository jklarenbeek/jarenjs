//@ts-check
/**
 * @file State-diagram grammar (`stateDiagram-v2`) → state AST. Models
 * the finite state machine faithfully: states, transitions
 * (`A --> B : label`), the `[*]` start/end pseudo-states, `state "x" as
 * s` descriptions and `s : desc` labels. This is the AST the flagship
 * `state ⇄ workflow` JSLT projection consumes.
 *
 * A transition carries its verbatim `label` — what renderers draw and
 * `toMermaid` prints — plus the label's UML reading, parsed into
 * `event [guard] / effect` parts (each null when absent). A label that
 * fits no UML pattern reads whole as the event, so plain labels keep
 * their historical meaning byte for byte.
 *
 * Composite states (`state Foo { … }`) stay in a flat table with parent
 * ids on both states and transitions, at arbitrary nesting depth.
 */

import { fail } from '../errors.js';
import { commentStart } from '../utils.js';

/**
 * Read a transition label's UML parts: `event [guard] / effect`, every
 * part optional. The first `[` opens the guard (nesting counted), and
 * the effect starts at the first `/` after the guard (or the first `/`
 * at all when there is none). Anything that breaks the pattern — an
 * unmatched `[`, or text between `]` and `/` — reads whole as the
 * event, which is exactly the historical meaning of a plain label.
 * @param {string|null} label
 * @returns {{ event: string|null, guard: string|null, effect: string|null }}
 */
function parseTransitionLabel(label) {
  const part = (s) => {
    const t = s.trim();
    return t === '' ? null : t;
  };
  if (label === null) return { event: null, guard: null, effect: null };
  const open = label.indexOf('[');
  if (open === -1) {
    const slash = label.indexOf('/');
    if (slash === -1) return { event: part(label), guard: null, effect: null };
    return { event: part(label.slice(0, slash)), guard: null, effect: part(label.slice(slash + 1)) };
  }
  let depth = 0;
  let close = -1;
  for (let i = open; i < label.length; i++) {
    if (label[i] === '[') depth++;
    else if (label[i] === ']') {
      depth--;
      if (depth === 0) { close = i; break; }
    }
  }
  if (close === -1) return { event: part(label), guard: null, effect: null };
  const after = label.slice(close + 1);
  const slash = after.indexOf('/');
  const between = slash === -1 ? after : after.slice(0, slash);
  if (between.trim() !== '') return { event: part(label), guard: null, effect: null };
  return {
    event: part(label.slice(0, open)),
    guard: part(label.slice(open + 1, close)),
    effect: slash === -1 ? null : part(after.slice(slash + 1)),
  };
}
/** `state "long description" as id`. */
const RE_STATE_AS = /^state\s+"([^"]*)"\s+as\s+(\S+)\s*$/;
/** `id : description`, the id's `:::class` dropped. */
const RE_STATE_DESC = /^(\S+?)(?::::[\w-]+)?\s*:(?!::)\s*(.*)$/;

/** A `;` that ends an entity code (`#59;`, `#quot;`) is part of the text. */
const RE_SEPARATOR = /#[A-Za-z0-9]+;|;/g;

/**
 * One line's statements: Mermaid ends a statement at `;` (`A --> B; B --> C`
 * is two transitions), so a line splits at every `;` outside an entity code
 * where each piece reads as a statement other than state names alone;
 * otherwise it is one statement, and a label keeps its `;` (`A --> B : x; y`).
 * @param {string} line - trimmed
 * @returns {string[]}
 */
export function stateStatements(line) {
  if (line.indexOf(';') === -1) return [line];
  const statements = separated(line);
  return statements.length > 1 && statements.every((piece) => piece === 'end' || piece === '}'
    || piece.startsWith('state ') || RE_STATE_DESC.test(piece)
    || (transitionsOf(piece)?.some((item) => item.to !== undefined) ?? false)) ? statements : [line];
}

/**
 * A line's pieces between its `;`s outside an entity code, blank ones left out.
 * @param {string} line
 * @returns {string[]}
 */
function separated(line) {
  const pieces = [];
  let start = 0;
  for (const m of line.matchAll(RE_SEPARATOR)) {
    if (m[0] !== ';') continue;
    pieces.push(line.slice(start, m.index).trim());
    start = /** @type {number} */ (m.index) + 1;
  }
  pieces.push(line.slice(start).trim());
  return pieces.filter((piece) => piece !== '');
}

/**
 * A state name as a transition or a line of its own writes it: `[*]`, or a
 * run without quotes or `-->` that neither starts nor ends with `-` (so
 * `A-->B` reads `A`, `B`), with
 * an optional `:::class` Mermaid styles it by and this tree does not keep.
 */
const ID = '(\\[\\*\\]|[^\\s:;"-](?:(?:(?!-->)[^\\s:;"])*[^\\s:;"-])?)(?::::[\\w-]+)?';
/** Sticky: one transition, `From --> To`, its label (`: …` to the end of the line) optional. */
const RE_TRANSITION_AT = new RegExp(`${ID}\\s*-->\\s*${ID}(?:\\s*:(?!::)(.*))?`, 'y');
/** Sticky: one state named on its own, ended by a blank or the end of the line. */
const RE_STATE_AT = new RegExp(`${ID}(?=\\s|$)`, 'y');
/** `state X`, `state X <<choice>>` (the fork/join/choice kind is not kept), `state X:::class`. */
const RE_STATE_DECL = new RegExp(`^state\\s+${ID}(?:\\s+<<\\w+>>)?$`);
/** Lines Mermaid reads as styling or accessibility text, which this tree does not keep. */
const RE_DIRECTIVE = /^(?:classDef|class|style|click|accTitle|accDescr)(?=[\s:{]|$)/;
/** A note line: `note left of A : text`, a block up to `end note`, or `note "text" as N`. */
const RE_NOTE_LINE = /^note\s/i;
/** A note that opens a block: `note left of A` / `note right of A` with no `:`. */
const RE_NOTE_BLOCK = /^note\s+(?:left|right)\s+of\s+[^:]+$/i;
/** A one-line note: a `:` text, or a floating `note "text" as N`. */
const RE_NOTE_ONE_LINE = /^note\s+(?:(?:left|right)\s+of\s+[^:]+:|")/i;
/** What closes a block note; a statement may follow it on the same line. */
const RE_END_NOTE = /^end note(?=\s|$)/i;

/**
 * Read a statement holding `-->` as Mermaid does: transitions and lone
 * state names follow one another, separated by blanks (`A --> B C --> D` is
 * two transitions, `A B --> C` a state and a transition), and a label runs to
 * the end of the line.
 * @param {string} line
 * @returns {{ from?: string, to?: string, label?: string|null, state?: string }[] | null}
 *   null when a piece of the line reads as neither
 */
function transitionsOf(line) {
  const out = [];
  let at = 0;
  while (at < line.length) {
    while (line.charCodeAt(at) === 0x20 || line.charCodeAt(at) === 0x09) at++;
    if (at >= line.length) break;
    RE_TRANSITION_AT.lastIndex = at;
    const tr = RE_TRANSITION_AT.exec(line);
    if (tr !== null) {
      out.push({ from: tr[1], to: tr[2], label: tr[3] === undefined ? null : tr[3].trim() });
      at = RE_TRANSITION_AT.lastIndex;
      continue;
    }
    RE_STATE_AT.lastIndex = at;
    const st = RE_STATE_AT.exec(line);
    if (st === null) return null;
    out.push({ state: st[1] });
    at = RE_STATE_AT.lastIndex;
  }
  return out;
}

/** First words a line of its own does not read as a state name. */
const KEYWORDS = new Set(['end', 'state', 'note', 'direction', 'classDef', 'class', 'style', 'click',
  'accTitle', 'accDescr', 'hide', 'scale']);

/**
 * How a state with no transition and no label is declared: its name on a
 * line of its own, as Mermaid reads it (Mermaid reads `state X` with no `{`
 * after it as no state at all), or `state X` where the name alone would read
 * as a keyword or as something else.
 * @param {string} id
 * @returns {string}
 */
export function stateDeclaration(id) {
  const one = KEYWORDS.has(id) ? null : transitionsOf(id);
  return one !== null && one.length === 1 && one[0].state === id ? id : `state ${id}`;
}

/** The longest parent chain walked to decide whether a re-declared state is an ancestor. */
const MAX_ANCESTOR_WALK = 1000;

/**
 * @param {string[]} lines
 * @param {number} [lineOffset] absolute line number of `lines[0]`
 * @returns {object}
 */
export function parseState(lines, lineOffset = 0) {
  /** @type {Map<string, { id: string, label: string }>} */
  const stateMap = new Map();
  const order = [];
  const transitions = [];
  /** @type {string[]} */
  const parentStack = [];

  // A state cannot sit inside itself or inside one of its own descendants:
  // re-declaring an ancestor from within keeps it where it was. Only a state
  // that already exists can be an ancestor, and the walk up from the new
  // parent is bounded, so hostile nesting costs linear time; a chain longer
  // than any real diagram is refused as if it contained the state.
  const insideItself = (id, under) => {
    let at = under;
    for (let steps = 0; at !== undefined; at = stateMap.get(at)?.parent) {
      if (at === id || ++steps > MAX_ANCESTOR_WALK) return true;
    }
    return false;
  };
  const ensure = (id, label, declaration = false) => {
    if (id === '[*]') return;
    let st = stateMap.get(id);
    if (st === undefined) {
      // a new state cannot be an ancestor of anything yet
      st = { id, label: label ?? id,
        ...(parentStack.length ? { parent: parentStack.at(-1) } : {}) };
      stateMap.set(id, st);
      order.push(id);
      return;
    }
    if (label != null) st.label = label;
    if (declaration && parentStack.length && !insideItself(id, parentStack.at(-1))) {
      st.parent = parentStack.at(-1);
    }
  };

  /**
   * Read one statement.
   * @param {string} line
   * @param {number} lineNo
   */
  const read = (line, lineNo) => {
    if (line === 'end' || line === '}') { parentStack.pop(); return; }

    // Composite state opener: `state Foo {`
    if (line.startsWith('state ') && line.endsWith('{')) {
      const inner = line.slice('state '.length, -1).trim();
      const id = inner.split(/\s+/)[0];
      ensure(id, null, true);
      parentStack.push(id);
      return;
    }

    const sa = RE_STATE_AS.exec(line);
    if (sa !== null) { ensure(sa[2], sa[1], true); return; }

    const decl = RE_STATE_DECL.exec(line);
    if (decl !== null) { if (decl[1] !== '[*]') ensure(decl[1], null, true); return; }

    if (RE_DIRECTIVE.test(line)) return;

    if (line.includes('-->')) {
      // a `;` the line did not split at still ends a statement where the
      // pieces read as transitions and state names (`A --> B; C`)
      const pieces = transitionsOf(line) === null && line.includes(';') ? separated(line).map(transitionsOf) : [];
      const read = pieces.length > 0 && pieces.every((piece) => piece !== null)
        ? pieces.flatMap((piece) => /** @type {any[]} */ (piece)) : transitionsOf(line);
      // a transition no form reads is refused, as Mermaid refuses it, where
      // it was dropped without a word
      if (read === null) fail(`'${line}' is no transition: From --> To, with an optional ': label'`, lineNo);
      for (const item of read) {
        if (item.state !== undefined) { ensure(item.state, null); continue; }
        const { from, to } = /** @type {{ from: string, to: string }} */ (item);
        ensure(from, null);
        ensure(to, null);
        const label = item.label === '' ? null : item.label ?? null;
        const parts = parseTransitionLabel(label);
        transitions.push({
          from,
          to,
          label,
          event: parts.event,
          guard: parts.guard,
          effect: parts.effect,
          parent: parentStack.length ? parentStack[parentStack.length - 1] : null,
        });
      }
      return;
    }

    if (line.startsWith('state ')) { ensure(line.slice('state '.length).trim(), null, true); return; }

    // a state named on its own line declares it, as `state X` does
    const one = transitionsOf(line);
    if (one !== null && one.length === 1) { ensure(/** @type {string} */ (one[0].state), null, true); return; }

    const sd = RE_STATE_DESC.exec(line);
    if (sd !== null && sd[1] !== '[*]') ensure(sd[1], sd[2].trim());
  };

  /** @type {number|null} the line that opened a block note still open */
  let noteOpenedAt = null;
  let inDescription = false;
  for (let li = 0; li < lines.length; li++) {
    let line = lines[li].trim();
    const lineNo = lineOffset + li + 1;
    if (line === '' || line.startsWith('%%')) continue;
    // a note's text is its own: a one-line note ends at its line, a block
    // note at `end note`, and a statement may follow that on its line
    if (noteOpenedAt !== null) {
      if (!RE_END_NOTE.test(line)) continue;
      noteOpenedAt = null;
      line = line.slice('end note'.length).trim();
      if (line === '') continue;
    }
    if (inDescription) { inDescription = !line.includes('}'); continue; }
    const comment = commentStart(line);
    if (comment !== -1) line = line.slice(0, comment).trim();
    if (line === '') continue;
    if (RE_NOTE_LINE.test(line)) {
      if (RE_NOTE_BLOCK.test(line)) noteOpenedAt = lineNo;
      else if (!RE_NOTE_ONE_LINE.test(line)) {
        fail(`'${line}' is no note: note left of|right of <state> with ': text' or a block up to 'end note', or note "text" as <id>`, lineNo);
      }
      continue;
    }
    // a multi-line accessible description: `accDescr {` up to `}`
    if (/^accDescr\s*\{/.test(line)) { inDescription = !line.includes('}'); continue; }
    for (const statement of stateStatements(line)) read(statement, lineNo);
  }
  if (noteOpenedAt !== null) fail("a note opened here is never closed with 'end note'", noteOpenedAt);

  return { states: order.map((id) => stateMap.get(id)), transitions };
}
