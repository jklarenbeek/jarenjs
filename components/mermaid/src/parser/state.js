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

/** `A --> B` / `A --> B : label`. */
const RE_TRANSITION = /^(\S+)\s*-->\s*(\S+)(?:\s*:\s*(.*))?$/;

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
/** `id : description`. */
const RE_STATE_DESC = /^(\S+)\s*:\s*(.*)$/;

/** A `;` that ends an entity code (`#59;`, `#quot;`) is part of the text. */
const RE_SEPARATOR = /#[A-Za-z0-9]+;|;/g;

/**
 * One line's statements: Mermaid ends a statement at `;` (`A --> B; B --> C`
 * is two transitions), so a line splits at every `;` outside an entity code
 * where each piece reads as a statement; otherwise it is one statement, and
 * a label keeps its `;`.
 * @param {string} line - trimmed
 * @returns {string[]}
 */
export function stateStatements(line) {
  if (line.indexOf(';') === -1) return [line];
  const pieces = [];
  let start = 0;
  for (const m of line.matchAll(RE_SEPARATOR)) {
    if (m[0] !== ';') continue;
    pieces.push(line.slice(start, m.index).trim());
    start = /** @type {number} */ (m.index) + 1;
  }
  pieces.push(line.slice(start).trim());
  const statements = pieces.filter((piece) => piece !== '');
  return statements.length > 1 && statements.every((piece) => piece === 'end' || piece === '}'
    || piece.startsWith('state ') || RE_TRANSITION.test(piece) || RE_STATE_DESC.test(piece)) ? statements : [line];
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

    const tr = RE_TRANSITION.exec(line);
    if (tr !== null) {
      if (tr[1] !== '[*]') ensure(tr[1], null);
      if (tr[2] !== '[*]') ensure(tr[2], null);
      const label = tr[3] ? tr[3].trim() : null;
      const parts = parseTransitionLabel(label === '' ? null : label);
      transitions.push({
        from: tr[1],
        to: tr[2],
        label: label === '' ? null : label,
        event: parts.event,
        guard: parts.guard,
        effect: parts.effect,
        parent: parentStack.length ? parentStack[parentStack.length - 1] : null,
      });
      return;
    }

    if (line.startsWith('state ')) { ensure(line.slice('state '.length).trim(), null, true); return; }

    const sd = RE_STATE_DESC.exec(line);
    if (sd !== null && sd[1] !== '[*]') { ensure(sd[1], sd[2].trim()); return; }

    // a transition no form reads is refused, as Mermaid refuses it, where
    // it was dropped without a word
    if (line.includes('-->')) {
      fail(`'${line}' is no transition: From --> To, with an optional ': label'`, lineNo);
    }
  };

  let inNote = false;
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li].trim();
    if (line === '' || line.startsWith('%%')) continue;
    // a note's text is its own: a one-line note ends at its line, a block
    // note at `end note`
    if (inNote) { inNote = line !== 'end note'; continue; }
    if (/^note\s/.test(line)) { inNote = !line.includes(':'); continue; }
    for (const statement of stateStatements(line)) read(statement, lineOffset + li + 1);
  }

  return { states: order.map((id) => stateMap.get(id)), transitions };
}
