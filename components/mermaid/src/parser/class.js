//@ts-check
/**
 * @file Class-diagram grammar → class AST. Supports `class Foo { … }`
 * bodies (`class Foo["label"]` sets the label), `Foo : +member` line form,
 * relations (`<|--`, `*--`, `o--`, `-->`, `..>`, `..|>`, the lollipop
 * `()--`, …; blanks around the operator optional) with optional quoted
 * cardinalities on either side and an optional `: label`, a class's generic
 * (`Foo~T~`, named `Foo` wherever it is written, the first one written kept
 * as `generic`; one nested in a bare name is refused, as Mermaid refuses it,
 * and a backtick-quoted name keeps the first two parts its `~`s split it
 * into, as Mermaid does: `` `Grid~List~int~~` `` is `Grid` of `List`), and `click`
 * statements (a link or a call, with the tooltip text); a class's
 * `<<annotation>>`s (a body line `<<any text>>`, a head's `class A
 * <<interface>>`, a statement `<<interface>> A`) are kept as `annotations`,
 * in the order written, and are no members. Geometry-free: members and
 * relations preserve declaration order.
 */

import { collectBraceBody, commentStart } from '../utils.js';
import { readNodeClick } from './click.js';
import { failWith } from '../errors.js';

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
/** A class annotation on a body line of its own, any text in it: `<<interface>>`, `<<enumeration>>`. */
const RE_ANNOTATION = /^<<.*>>$/;
/**
 * An annotation outside a body, in a class statement's head (`class A
 * <<interface>>`) or a statement of its own (`<<interface>> A`): one word
 * of Mermaid's lexer between the marks, then the class it annotates.
 */
const RE_ANNOTATION_WORD = /^<<\s*(\w+|[\u0080-\uffff])\s*>>\s*(.*)$/;
/** Lines Mermaid reads as notes, styling, links or grouping, which this tree does not keep. */
const RE_DIRECTIVE = /^(?:note|classDef|cssClass|style|link|callback|direction|namespace|accTitle|accDescr)(?=[\s:{<]|$)|^\}$/;

/**
 * A name as the tree keeps it, as Mermaid reads it, its generic (if any)
 * written `Name~T~` after it: a backtick-quoted name without its backticks,
 * split at its `~`s with the first two parts kept (`` `Grid~List~int~~` `` is
 * `Grid` of `List`); words without the blanks between them, each empty `~~`
 * dropped (`A~~B~~` is `AB`).
 * @param {string} name
 * @param {number} lineNo the line it is written on
 * @returns {string}
 */
function className(name, lineNo) {
  if (name.startsWith('`')) {
    const close = name.indexOf('`', 1);
    // a backtick no other closes stays as written
    if (close === -1) return name;
    const text = backtickText(name.slice(1, close), name, lineNo) + name.slice(close + 1);
    if (text.indexOf('~') <= 0) return text;
    const [base, generic] = text.split('~');
    return `${base}~${generic}~`;
  }
  refuseNestedGeneric(name, lineNo);
  return bareName(name.replace(/\s+/g, ''), lineNo);
}

/**
 * What Mermaid's lexer reads as syntax, not as a name, where a backtick
 * name's text starts: a keyword of a class statement, `<<`/`>>` or a `"`.
 */
export const RE_BACKTICK_KEYWORD = /^(?:(?:cssClass|callback|link|click|note|href)\b|<<|>>|")/;

/**
 * A backtick name's text as Mermaid reads it. Where the text starts,
 * Mermaid's lexer reads its own tokens before a name: each leading `~~` is
 * an empty generic it drops (`` `~~A` `` is `A`); a `~` left over opens a
 * generic before any name, and a keyword (`` `note A` ``), `<<`, `>>` or a
 * `"` is syntax, so each such name, and one with nothing after its `~~`s, is
 * refused, as Mermaid refuses it. An entity code spells such a first
 * character (`` `#126;A` ``, `` `#110;ote A` ``, `` `#60;#60;A` ``).
 * @param {string} inner the text between the backticks
 * @param {string} written the name as written, for a refusal
 * @param {number} lineNo
 * @returns {string}
 */
function backtickText(inner, written, lineNo) {
  let at = 0;
  while (inner.startsWith('~~', at)) at += 2;
  const text = inner.slice(at);
  if (text === '' || text.startsWith('~')) failWith('mermaid/class/generic-tilde', { name: written }, lineNo);
  const lead = RE_BACKTICK_KEYWORD.exec(text);
  if (lead !== null) {
    // the spelling to write instead: `<<` and `>>` coded whole, a keyword's first character
    const coded = lead[0] === '<<' || lead[0] === '>>' ? lead[0].replace(/./g, (c) => `#${c.charCodeAt(0)};`)
      : `#${text.charCodeAt(0)};${lead[0].slice(1)}`;
    failWith('mermaid/class/backtick-lead', { name: written, lead: lead[0], coded }, lineNo);
  }
  return text;
}

/**
 * A bare class name as Mermaid reads it: each `~` opens a generic its next
 * `~` closes, an empty one dropped; a generic is the name's last part and
 * follows a name. A `~` never closed, or text or a generic after the generic,
 * is refused, as Mermaid refuses it.
 * @param {string} name the name without its blanks
 * @param {number} lineNo
 * @returns {string}
 */
function bareName(name, lineNo) {
  if (!name.includes('~')) return name;
  let base = '';
  /** @type {string|null} */
  let generic = null;
  for (let i = 0; i < name.length;) {
    const close = name[i] === '~' ? name.indexOf('~', i + 1) : i;
    if (close === -1 || (close === i && generic !== null) || (close > i + 1 && (generic !== null || base === ''))) {
      failWith('mermaid/class/generic-tilde', { name }, lineNo);
    }
    if (close === i) base += name[i++];
    else {
      if (close > i + 1) generic = name.slice(i + 1, close);
      i = close + 1;
    }
  }
  return generic === null ? base : `${base}~${generic}~`;
}

/**
 * A class name whose generic nests another: a name, then two or more
 * `~`-led words, then the `~`s that close them (`List~List~int~~`,
 * `A~B~C~`). Mermaid refuses each such name; it reads some other runs of
 * `~` (`A~~B~~` is a class `AB`, as `bareName` reads it).
 */
const RE_NESTED_GENERIC = /^[^~]+(?:~[^~]+){2,}~+$/;

/**
 * Refuse a bare class name whose generic nests another, as Mermaid refuses
 * it, where it was read; a member's type may nest.
 * @param {string} written the name as written
 * @param {number} lineNo
 */
function refuseNestedGeneric(written, lineNo) {
  if (RE_NESTED_GENERIC.test(written)) {
    failWith('mermaid/class/nested-generic', { name: written }, lineNo);
  }
}

/** A name's generic, as `className` writes it: `Square~Shape~` is `Square` of `Shape`. */
const RE_GENERIC = /^([^~]+)~(.*)~$/;

/**
 * A written class name without its generic, as Mermaid names the class, and
 * the generic it gives it (null without one).
 * @param {string} name a name as `className` keeps it
 * @returns {{ name: string, generic: string|null }}
 */
function genericOf(name) {
  const m = RE_GENERIC.exec(name);
  return m === null ? { name, generic: null } : { name: m[1], generic: m[2] };
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
 * @param {number} lineNo the line's number, for a refusal
 * @returns {{ from: string, to: string, type: string, label: string|null,
 *   fromCardinality?: string, toCardinality?: string } | null}
 */
function relationOf(line, lineNo) {
  const op = operatorIn(line);
  if (op === null) return null;
  const from = RE_FROM.exec(line.slice(0, op.at).trim());
  const to = RE_TO.exec(line.slice(op.end).trim());
  if (from === null || to === null) return null;
  return {
    from: className(from[1], lineNo),
    to: className(to[2], lineNo),
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
 * @param {number} lineNo the line's number, for a refusal
 * @returns {{ name: string, label: string|null }}
 */
function classHead(head, lineNo) {
  const m = /^(`[^`]+`|[^[`]+?)(?:\["([^"]*)"\])?(?::::[\w-]+)?$/.exec(head.trim());
  if (m === null) return { name: head.trim(), label: null };
  return { name: className(m[1].trim(), lineNo), label: m[2] ?? null };
}

/**
 * The text of a `class` statement up to its body, its `<<annotation>>` and
 * anything after one dropped, its generic kept; a `<` inside a quoted label
 * or a backtick-quoted name is text.
 * @param {string} rest the statement after `class`
 * @returns {string}
 */
function classStatementHead(rest) {
  const brace = rest.indexOf('{');
  const head = brace === -1 ? rest : rest.slice(0, brace);
  for (let i = 0; i < head.length; i++) {
    const c = head[i];
    if (c === '"' || c === '`') {
      const close = head.indexOf(c, i + 1);
      if (close === -1) return head;
      i = close;
    }
    else if (c === '<') return head.slice(0, i);
  }
  return head;
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

  // a class is named without its generic (`Square~Shape~` is `Square`),
  // wherever the generic is written, and keeps the generic it is first
  // written with as `generic`, as Mermaid keeps it
  const ensure = (written) => {
    const { name, generic } = genericOf(written);
    let cls = classMap.get(name);
    if (cls === undefined) {
      cls = { name, label: name, members: [] };
      if (generic !== null) cls.generic = generic;
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
      const written = classStatementHead(rest);
      refuseSemicolon(written, line, lineOffset + li + 1);
      const head = classHead(written, lineOffset + li + 1);
      const cls = ensure(head.name);
      if (head.label !== null) cls.label = head.label;
      // `class A <<interface>>`: the one annotation the head may end with
      const tail = (brace === -1 ? rest : rest.slice(0, brace)).slice(written.length).trim();
      if (tail !== '') {
        const annotation = RE_ANNOTATION_WORD.exec(tail);
        if (annotation === null || annotation[2] !== '') failWith('mermaid/class/annotation', { line }, lineOffset + li + 1);
        annotate(cls, annotation[1]);
      }
      if (brace === -1) continue;
      // Consume until closing brace across lines.
      let body;
      ({ body, li } = collectBraceBody(lines, li, rest.slice(brace + 1)));
      for (const raw of body.split('\n')) {
        const mem = raw.trim();
        // an `<<enumeration>>` line annotates the class, as in its header,
        // and is no member
        if (RE_ANNOTATION.test(mem)) annotate(cls, mem.slice(2, -2));
        else if (mem !== '') cls.members.push(member(mem));
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

    // `<<interface>> A` annotates a class written before it; one that names
    // no such class is refused, as Mermaid fails on it
    if (line.startsWith('<<')) {
      const annotation = RE_ANNOTATION_WORD.exec(line);
      if (annotation === null || annotation[2] === '') failWith('mermaid/class/annotation', { line }, lineOffset + li + 1);
      const { name } = genericOf(className(annotation[2], lineOffset + li + 1));
      const annotated = classMap.get(name);
      if (annotated === undefined) failWith('mermaid/class/annotation-unwritten', { line, name }, lineOffset + li + 1);
      annotate(annotated, annotation[1]);
      continue;
    }

    if (RE_DIRECTIVE.test(line)) continue;

    const rel = relationOf(line, lineOffset + li + 1);
    if (rel !== null) {
      refuseSemicolon(line, line, lineOffset + li + 1);
      // the end at a lollipop (`bar ()-- foo`) names an interface, not a class
      const lollipop = rel.type.startsWith('()') !== rel.type.endsWith('()');
      if (!lollipop || !rel.type.startsWith('()')) rel.from = ensure(rel.from).name;
      if (!lollipop || !rel.type.endsWith('()')) rel.to = ensure(rel.to).name;
      relations.push(rel);
      continue;
    }

    const ml = RE_MEMBER_LINE.exec(line);
    if (ml !== null && !line.startsWith('class')) {
      refuseSemicolon(line, line, lineOffset + li + 1);
      ensure(className(ml[1], lineOffset + li + 1)).members.push(member(ml[2].trim()));
      continue;
    }

    // a relation no form reads is refused, as Mermaid refuses it, where it
    // was dropped without a word
    if (operatorIn(line) !== null) {
      failWith('mermaid/class/relation', { line }, lineOffset + li + 1);
    }
  }

  return { classes: order.map((n) => classMap.get(n)), relations, clicks };
}

/** What may hold a `;` Mermaid reads: a quoted string, a backtick name, an entity code (`#59;`). */
const RE_NOT_SEPARATOR = /"[^"]*"|`[^`]*`|#\w+;/g;

/**
 * Refuse a `;` outside a quoted string, a backtick name or an entity code, which Mermaid's
 * class lexer reads nowhere outside a class body (`A --> B : a;b`,
 * `A : +x;y`, `class A;`), where it was read as text.
 * @param {string} text the statement's text to look in
 * @param {string} line the line, for the refusal
 * @param {number} lineNo
 */
function refuseSemicolon(text, line, lineNo) {
  if (text.indexOf(';') !== -1 && text.replace(RE_NOT_SEPARATOR, '').indexOf(';') !== -1) {
    failWith('mermaid/class/semicolon', { line }, lineNo);
  }
}

/**
 * Add an annotation to a class, after any it holds: a class holds
 * `annotations` only once it is annotated, in the order they are written
 * (Mermaid draws the first above the name).
 * @param {{ annotations?: string[] }} cls
 * @param {string} text
 */
function annotate(cls, text) {
  (cls.annotations ??= []).push(text);
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
