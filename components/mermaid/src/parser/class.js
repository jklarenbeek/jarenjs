//@ts-check
/**
 * @file Class-diagram grammar → class AST. Supports `class Foo { … }`
 * bodies, `Foo : +member` line form, and relations
 * (`<|--`, `*--`, `o--`, `-->`, `..>`, `..|>`) with optional `: label`.
 * Geometry-free: members and relations preserve declaration order.
 */

/** Relation operator between two class names, optional `: label`. */
const RE_RELATION = /^(\S+)\s+([<>|*o.]{0,2}(?:--|\.\.)[<>|*o.]{0,2})\s+(\S+)(?:\s*:\s*(.*))?$/;
/** `ClassName : member` line form. */
const RE_MEMBER_LINE = /^(\S+)\s*:\s*(.+)$/;

/**
 * @param {string[]} lines
 * @returns {object}
 */
export function parseClass(lines) {
  /** @type {Map<string, { name: string, label: string, members: object[] }>} */
  const classMap = new Map();
  const order = [];
  const relations = [];

  const ensure = (name) => {
    let cls = classMap.get(name);
    if (cls === undefined) {
      cls = { name, label: name, members: [] };
      classMap.set(name, cls);
      order.push(name);
    }
    return cls;
  };

  for (let li = 0; li < lines.length; li++) {
    let line = lines[li].trim();
    if (line === '' || line.startsWith('%%')) continue;

    // class Foo { ... } (single or multi-line body)
    if (line.startsWith('class ')) {
      const rest = line.slice('class '.length).trim();
      const brace = rest.indexOf('{');
      if (brace === -1) { ensure(rest.replace(/[~<].*$/, '').trim()); continue; }
      const name = rest.slice(0, brace).trim();
      const cls = ensure(name);
      let body = rest.slice(brace + 1);
      // Consume until closing brace across lines.
      while (body.indexOf('}') === -1 && li + 1 < lines.length) {
        li++;
        body += '\n' + lines[li];
      }
      body = body.slice(0, body.indexOf('}'));
      for (const raw of body.split('\n')) {
        const mem = raw.trim();
        if (mem !== '') cls.members.push(member(mem));
      }
      continue;
    }

    const rel = RE_RELATION.exec(line);
    if (rel !== null) {
      ensure(rel[1]);
      ensure(rel[3]);
      relations.push({ from: rel[1], to: rel[3], type: rel[2], label: rel[4] ? rel[4].trim() : null });
      continue;
    }

    const ml = RE_MEMBER_LINE.exec(line);
    if (ml !== null && !line.startsWith('class')) {
      ensure(ml[1]).members.push(member(ml[2].trim()));
      continue;
    }
  }

  return { classes: order.map((n) => classMap.get(n)), relations };
}

/**
 * Classify a member as a method (has `()`) or attribute, capturing a
 * leading visibility marker.
 * @param {string} text
 * @returns {object}
 */
function member(text) {
  let visibility = null;
  const first = text.charCodeAt(0);
  if (first === 0x2b || first === 0x2d || first === 0x23 || first === 0x7e) {
    visibility = text[0];
    text = text.slice(1);
  }
  const kind = text.indexOf('(') !== -1 ? 'method' : 'attribute';
  return { kind, visibility, text: text.trim() };
}
