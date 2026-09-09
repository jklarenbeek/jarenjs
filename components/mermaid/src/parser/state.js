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

/**
 * @param {string[]} lines
 * @returns {object}
 */
export function parseState(lines) {
  /** @type {Map<string, { id: string, label: string }>} */
  const stateMap = new Map();
  const order = [];
  const transitions = [];
  /** @type {string[]} */
  const parentStack = [];

  const ensure = (id, label, declaration = false) => {
    if (id === '[*]') return;
    let st = stateMap.get(id);
    if (st === undefined) {
      st = { id, label: label ?? id,
        ...(parentStack.length ? { parent: parentStack.at(-1) } : {}) };
      stateMap.set(id, st);
      order.push(id);
    }
    else if (label != null) {
      st.label = label;
    }
    if (declaration && parentStack.length) st.parent = parentStack.at(-1);
  };

  for (let li = 0; li < lines.length; li++) {
    let line = lines[li].trim();
    if (line === '' || line.startsWith('%%')) continue;
    if (line === 'end' || line === '}') { parentStack.pop(); continue; }

    // Composite state opener: `state Foo {`
    if (line.startsWith('state ') && line.endsWith('{')) {
      const inner = line.slice('state '.length, -1).trim();
      const id = inner.split(/\s+/)[0];
      ensure(id, null, true);
      parentStack.push(id);
      continue;
    }

    const sa = RE_STATE_AS.exec(line);
    if (sa !== null) { ensure(sa[2], sa[1], true); continue; }

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
      continue;
    }

    if (line.startsWith('state ')) { ensure(line.slice('state '.length).trim(), null, true); continue; }

    const sd = RE_STATE_DESC.exec(line);
    if (sd !== null && sd[1] !== '[*]') { ensure(sd[1], sd[2].trim()); continue; }
  }

  return { states: order.map((id) => stateMap.get(id)), transitions };
}
