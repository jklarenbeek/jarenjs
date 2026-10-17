//@ts-check
/**
 * @file Class-diagram grammar → class AST. Supports `class Foo { … }`
 * bodies (`class Foo["label"]` sets the label), `Foo : +member` line form,
 * relations (`<|--`, `*--`, `o--`, `-->`, `..>`, `..|>`, the lollipop
 * `()--`, …; blanks around the operator optional) with optional quoted
 * cardinalities on either side and an optional `: label`, and `click`
 * statements (a link or a call, with the tooltip text). Geometry-free:
 * members and relations preserve declaration order.
 */

import { collectBraceBody, commentStart } from '../utils.js';
import { readNodeClick } from './click.js';
import { fail } from '../errors.js';

/**
 * Sticky: a relation operator — a `--` or `..` line with an optional end
 * mark on each side (`<|`, `*`, `o`, `<`, `()` before it; `|>`, `*`, `o`,
 * `>`, `()` after it). An `o` mark stands next to a blank (or a cardinality
 * after the line), so the `o` that ends a name (`Fooo--Bar`) stays the name's.
 */
const RE_OPERATOR_AT = /(?:<\||\(\)|\*|<|(?<=\s)o)?(?:--|\.\.)(?:\|>|\(\)|\*|>|o(?=[\s"]))?/y;
/** A class name: a backtick-quoted name, or words Mermaid joins without their blanks. */
const NAME = '(`[^`]+`|[^\\s"`:;<>*|()-]+(?:\\s+[^\\s"`:;<>*|()-]+)*)';
/** What stands before the operator: the name and an optional quoted cardinality. */
const RE_FROM = new RegExp(`^${NAME}(?:\\s*"([^"]*)")?$`);
/** What follows the operator: an optional quoted cardinality, the name, an optional `: label`. */
const RE_TO = new RegExp(`^(?:"([^"]*)"\\s*)?${NAME}(?:\\s*:\\s*(.*))?$`);
/** `ClassName : member` line form. */
const RE_MEMBER_LINE = /^(\S+)\s*:\s*(.+)$/;
/** Lines Mermaid reads as notes, styling, links or grouping, which this tree does not keep. */
const RE_DIRECTIVE = /^(?:note|classDef|cssClass|style|link|callback|direction|namespace|accTitle|accDescr|<<)(?=[\s:{<]|$)|^\}$/;

/**
 * A name as the tree keeps it: a backtick-quoted name without its
 * backticks, and words without the blanks between them, as Mermaid reads it.
 * @param {string} name
 * @returns {string}
 */
function className(name) {
  return name.startsWith('`') ? name.slice(1, -1) : name.replace(/\s+/g, '');
}

/**
 * Where the first relation operator outside a quoted cardinality or a
 * backtick-quoted name starts, and how long it is.
 * @param {string} line
 * @returns {{ at: number, end: number } | null}
 */
function operatorIn(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"' || c === '`') {
      const close = line.indexOf(c, i + 1);
      if (close === -1) return null;
      i = close;
      continue;
    }
    RE_OPERATOR_AT.lastIndex = i;
    if (RE_OPERATOR_AT.test(line)) return { at: i, end: RE_OPERATOR_AT.lastIndex };
  }
  return null;
}

/**
 * Read a relation line: `From ["card"] <operator> ["card"] To [: label]`,
 * blanks around the operator optional.
 * @param {string} line
 * @returns {{ from: string, to: string, type: string, label: string|null,
 *   fromCardinality?: string, toCardinality?: string } | null}
 */
function relationOf(line) {
  const op = operatorIn(line);
  if (op === null) return null;
  const from = RE_FROM.exec(line.slice(0, op.at).trim());
  const to = RE_TO.exec(line.slice(op.end).trim());
  if (from === null || to === null) return null;
  return {
    from: className(from[1]),
    to: className(to[2]),
    type: line.slice(op.at, op.end),
    label: to[3] ? to[3].trim() : null,
    ...(from[2] === undefined ? {} : { fromCardinality: from[2] }),
    ...(to[1] === undefined ? {} : { toCardinality: to[1] }),
  };
}

/**
 * A `class` statement's name and label: `Name`, `` `Name` ``,
 * `Name["label"]`, with an optional `:::style` this tree does not keep.
 * @param {string} head the statement after `class`, up to any `{`
 * @returns {{ name: string, label: string|null }}
 */
function classHead(head) {
  const m = /^(`[^`]+`|[^[`]+?)(?:\["([^"]*)"\])?(?::::[\w-]+)?$/.exec(head.trim());
  if (m === null) return { name: head.trim(), label: null };
  return { name: className(m[1].trim()), label: m[2] ?? null };
}

/**
 * @param {string[]} lines
 * @returns {object}
 */
export function parseClass(lines, lineOffset = 0) {
  /** @type {Map<string, { name: string, label: string, members: object[] }>} */
  const classMap = new Map();
  const order = [];
  const relations = [];
  /** @type {import('./click.js').NodeClick[]} */
  const clicks = [];

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
    // a `%%` outside a label or a `{ … }` body starts a comment, as in Mermaid
    const comment = commentStart(line);
    if (comment !== -1 && !line.slice(0, comment).includes('{')) line = line.slice(0, comment).trim();

    // class Foo { ... } (single or multi-line body)
    if (line.startsWith('class ')) {
      const rest = line.slice('class '.length).trim();
      const brace = rest.indexOf('{');
      const head = classHead(brace === -1 ? rest.replace(/[~<].*$/, '') : rest.slice(0, brace));
      const cls = ensure(head.name);
      if (head.label !== null) cls.label = head.label;
      if (brace === -1) continue;
      // Consume until closing brace across lines.
      let body;
      ({ body, li } = collectBraceBody(lines, li, rest.slice(brace + 1)));
      for (const raw of body.split('\n')) {
        const mem = raw.trim();
        if (mem !== '') cls.members.push(member(mem));
      }
      continue;
    }

    // a click names a class and declares none; a line that is not one of
    // Mermaid's class click forms reads on as it always did
    const click = line.startsWith('click ') ? readNodeClick(line, false) : null;
    if (click !== null) {
      clicks.push(click);
      continue;
    }

    if (RE_DIRECTIVE.test(line)) continue;

    const rel = relationOf(line);
    if (rel !== null) {
      // the end at a lollipop (`bar ()-- foo`) names an interface, not a class
      const lollipop = rel.type.startsWith('()') !== rel.type.endsWith('()');
      if (!lollipop || !rel.type.startsWith('()')) ensure(rel.from);
      if (!lollipop || !rel.type.endsWith('()')) ensure(rel.to);
      relations.push(rel);
      continue;
    }

    const ml = RE_MEMBER_LINE.exec(line);
    if (ml !== null && !line.startsWith('class')) {
      ensure(ml[1]).members.push(member(ml[2].trim()));
      continue;
    }

    // a relation no form reads is refused, as Mermaid refuses it, where it
    // was dropped without a word
    if (operatorIn(line) !== null) {
      fail(`'${line}' is no relation: From ["cardinality"] <operator> ["cardinality"] To, one per line, with an optional ': label'`, lineOffset + li + 1);
    }
  }

  return { classes: order.map((n) => classMap.get(n)), relations, clicks };
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
