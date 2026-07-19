//@ts-check
/**
 * @file State-diagram grammar (`stateDiagram-v2`) → state AST. Models
 * the finite state machine faithfully (D11): states, transitions
 * (`A --> B : event`), the `[*]` start/end pseudo-states, `state "x" as
 * s` descriptions and `s : desc` labels. This is the AST the flagship
 * `state ⇄ workflow` JSLT projection consumes (WI 11).
 *
 * Composite states (`state Foo { … }`) are flattened one level: the
 * inner transitions are captured with their parent recorded, keeping the
 * AST geometry-free.
 */

/** `A --> B` / `A --> B : event`. */
const RE_TRANSITION = /^(\S+)\s*-->\s*(\S+)(?:\s*:\s*(.*))?$/;
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

  const ensure = (id, label) => {
    if (id === '[*]') return;
    let st = stateMap.get(id);
    if (st === undefined) {
      st = { id, label: label ?? id };
      stateMap.set(id, st);
      order.push(id);
    }
    else if (label != null) {
      st.label = label;
    }
  };

  for (let li = 0; li < lines.length; li++) {
    let line = lines[li].trim();
    if (line === '' || line.startsWith('%%')) continue;
    if (line === 'end' || line === '}') { parentStack.pop(); continue; }

    // Composite state opener: `state Foo {`
    if (line.startsWith('state ') && line.endsWith('{')) {
      const inner = line.slice('state '.length, -1).trim();
      const id = inner.split(/\s+/)[0];
      ensure(id, id);
      parentStack.push(id);
      continue;
    }

    const sa = RE_STATE_AS.exec(line);
    if (sa !== null) { ensure(sa[2], sa[1]); continue; }

    const tr = RE_TRANSITION.exec(line);
    if (tr !== null) {
      if (tr[1] !== '[*]') ensure(tr[1], null);
      if (tr[2] !== '[*]') ensure(tr[2], null);
      transitions.push({
        from: tr[1],
        to: tr[2],
        event: tr[3] ? tr[3].trim() : null,
        parent: parentStack.length ? parentStack[parentStack.length - 1] : null,
      });
      continue;
    }

    if (line.startsWith('state ')) { ensure(line.slice('state '.length).trim(), null); continue; }

    const sd = RE_STATE_DESC.exec(line);
    if (sd !== null && sd[1] !== '[*]') { ensure(sd[1], sd[2].trim()); continue; }
  }

  return { states: order.map((id) => stateMap.get(id)), transitions };
}
