//@ts-check
/**
 * @file Canonical Mermaid printer: AST → text (MERMAID-FORMAT §5).
 * The reverse arrow of `parseMermaid`, mirroring
 * `@jarenjs/md`'s `to-md.js`: one specialized closure per diagram type,
 * a **round-trip fixed point** — `parseMermaid(toMermaid(doc))`
 * deep-equals `doc.ast` for the fully-modeled types (but for a label no
 * quoting can hold, which reads back spelled with an entity code: see
 * `labelSource`).
 *
 * The printer is *canonical*, not verbatim: it does not preserve source
 * whitespace or comments (the stored Markdown fence `value` gives
 * verbatim round-trip while a node is untransformed). Its job is
 * to re-emit an edited AST as editable Mermaid text.
 */

import { parseState } from './parser/state.js';
import { printClick, printNodeClick } from './parser/click.js';
import { RE_LINK_INSIDE } from './parser/flowchart.js';
import { isMarkdownString } from './label-text.js';

//#region public ----------------------------------------------------

/** @type {Record<string, (ast: any) => string>} */
const PRINTERS = {
  flowchart: printFlowchart,
  sequence: printSequence,
  class: printClass,
  state: printState,
  er: printEr,
  gantt: printGantt,
  pie: printPie,
};

/**
 * Print a `DiagramDocument` (or a bare AST with a `diagram` field) to
 * canonical Mermaid text. Config re-emits as a `%%{init}%%` header when
 * present.
 * @param {any} docOrAst
 * @returns {string}
 */
export function toMermaid(docOrAst) {
  const doc = docOrAst && typeof docOrAst === 'object' && docOrAst.$mermaid !== undefined
    ? docOrAst
    : null;
  const diagram = doc ? doc.diagram : docOrAst?.diagram;
  const ast = doc ? doc.ast : docOrAst;
  const config = doc ? doc.config : undefined;
  const title = doc ? doc.meta?.title : undefined;

  let head = '';
  if (title != null && title !== '') {
    head += '---\ntitle: ' + title + '\n---\n';
  }
  if (config && typeof config === 'object' && Object.keys(config).length > 0) {
    head += '%%{init: ' + JSON.stringify(config) + '}%%\n';
  }

  const printer = PRINTERS[diagram];
  if (printer !== undefined) return head + printer(ast);
  // Secondary/raw diagram: keyword + preserved body lines.
  if (ast && Array.isArray(ast.lines)) {
    return head + ast.diagram + '\n' + ast.lines.join('\n') + '\n';
  }
  return head + String(diagram ?? '') + '\n';
}

//#endregion
//#region flowchart -------------------------------------------------

/**
 * What a node label needs its quotes for: delimiters and literal quotes. A
 * slash or backslash at either end would join the shape's own brackets
 * (`[/x` opens a parallelogram), and outer whitespace is trimmed on the way
 * back in.
 */
const RE_NEEDS_QUOTE = /[[\](){}<>|"';]|^[\s/\\]|[\s/\\]$/;

/**
 * What a pipe-form edge label needs its quotes for: a `|` (which ends it), a
 * `;` (which ends the statement), and a quote or a space at either end
 * (stripped or trimmed on the way back in).
 */
const RE_EDGE_NEEDS_QUOTE = /[|;]|^[\s"']|[\s"']$/;

/**
 * What a subgraph title, which runs to its line's last `]`, needs its quotes
 * for: a quote or a space at either end.
 */
const RE_TITLE_NEEDS_QUOTE = /^[\s"']|[\s"']$/;

/**
 * A label as source text that reads back as the same label. A line break
 * prints as `<br/>` (printed raw it would end the statement). A label that
 * `needsQuote` matches, and a markdown string (unquoted, its backticks are
 * plain text), print quoted, in the quote kind the label does not hold; a
 * quoted label is one unit, so its delimiters are text.
 *
 * Mermaid has no escape inside a quoted label, so two labels no quoting can
 * hold print one character as its entity code, which renders as that
 * character and reads back as the code: a label holding both quote kinds
 * beside a `;` or its own `closer` prints `"` as `#34;`, and a label holding
 * its `closer` beside a link operator (which ends a quoted unit) prints the
 * closer as its code (`|` as `#124;`).
 * @param {string} label
 * @param {string | null} closer the last character of the delimiter that ends
 *   the label in its statement (`]`, `)`, `}`, `|`), or `null` where the
 *   label runs to the end of its line
 * @param {RegExp} needsQuote what the label needs its quotes for where it stands
 * @returns {string}
 */
function labelSource(label, closer, needsQuote) {
  let text = label.replace(/\n/g, '<br/>');
  if (closer !== null) {
    const closes = text.includes(closer);
    if (closes || text.includes(';')) {
      if (text.includes('"') && text.includes("'")) text = text.replaceAll('"', '#34;');
      if (closes && RE_LINK_INSIDE.test(text)) text = text.replaceAll(closer, `#${closer.charCodeAt(0)};`);
    }
  }
  if (!needsQuote.test(text) && !isMarkdownString(text)) return text;
  const quote = text.includes('"') && !text.includes("'") ? "'" : '"';
  return quote + text + quote;
}

/**
 * @param {any} ast
 * @returns {string}
 */
function printFlowchart(ast) {
  const out = ['flowchart ' + (ast.direction || 'TB')];

  // 1. Every node declared once, in AST order — this fixes node order
  //    on the round trip. Default nodes emit a bare id line.
  for (const node of ast.nodes) {
    out.push(nodeDecl(node));
  }

  // 2. Subgraphs: reference members by bare id (membership only).
  for (const sg of ast.subgraphs) {
    out.push(sg.label && sg.label !== ''
      ? `subgraph ${sg.id} [${labelSource(sg.label, null, RE_TITLE_NEEDS_QUOTE)}]`
      : `subgraph ${sg.id}`);
    if (sg.direction) out.push('  direction ' + sg.direction);
    for (const id of sg.nodes) out.push('  ' + id);
    out.push('end');
  }

  // 3. Edges in AST order.
  for (const e of ast.edges) {
    const op = edgeOp(e);
    const label = e.label != null ? `|${labelSource(e.label, '|', RE_EDGE_NEEDS_QUOTE)}|` : '';
    out.push(`${e.from} ${op}${label} ${e.to}`);
  }

  // 4. classDef / class / style, each in AST order.
  for (const cd of ast.classDefs) out.push(`classDef ${cd.name} ${cd.styles}`);
  for (const c of ast.classes) out.push(`class ${c.node} ${c.name}`);
  for (const s of ast.styles) out.push(`style ${s.node} ${s.styles}`);

  // 5. click statements in AST order; a tree written before they were read
  //    has no `clicks`
  for (const click of ast.clicks ?? []) out.push(printNodeClick(click));

  return out.join('\n') + '\n';
}

/**
 * @param {any} node
 * @returns {string}
 */
function nodeDecl(node) {
  if (node.shape === 'rect' && node.label === node.id) return node.id;
  return node.id + wrapShape(node.shape, node.label);
}

/** Each shape's opening and closing delimiters; any other shape is a rectangle. */
const SHAPE_DELIMITERS = /** @type {Record<string, [string, string]>} */ ({
  round: ['(', ')'],
  stadium: ['([', '])'],
  subroutine: ['[[', ']]'],
  cylinder: ['[(', ')]'],
  circle: ['((', '))'],
  doublecircle: ['(((', ')))'],
  diamond: ['{', '}'],
  hexagon: ['{{', '}}'],
  parallelogram: ['[/', '/]'],
  parallelogram_alt: ['[\\', '\\]'],
  trapezoid: ['[/', '\\]'],
  trapezoid_alt: ['[\\', '/]'],
  asymmetric: ['>', ']'],
});

/**
 * @param {string} shape
 * @param {string} label
 * @returns {string}
 */
function wrapShape(shape, label) {
  const [open, close] = Object.hasOwn(SHAPE_DELIMITERS, shape) ? SHAPE_DELIMITERS[shape] : ['[', ']'];
  return open + labelSource(label, close[close.length - 1], RE_NEEDS_QUOTE) + close;
}

/**
 * Reconstruct the canonical link operator (the exact inverse of
 * `classifyLink` in the parser).
 * @param {any} e
 * @returns {string}
 */
function edgeOp(e) {
  const tail = e.tail === 'arrow' ? '<' : e.tail === 'circle' ? 'o' : e.tail === 'cross' ? 'x' : '';
  const head = e.head === 'arrow' ? '>' : e.head === 'circle' ? 'o' : e.head === 'cross' ? 'x' : '';
  const n = Math.max(1, e.length | 0);
  let mid;
  if (e.stroke === 'thick') mid = '='.repeat(n);
  else if (e.stroke === 'dotted') mid = '-' + '.'.repeat(n) + '-';
  else mid = '-'.repeat(Math.max(2, n));
  return tail + mid + head;
}

//#endregion
//#region sequence --------------------------------------------------

/**
 * @param {any} ast
 * @returns {string}
 */
function printSequence(ast) {
  const out = ['sequenceDiagram'];
  if (ast.autonumber) out.push('autonumber');
  for (const p of ast.participants) {
    const decl = p.kind === 'actor' ? 'actor' : 'participant';
    out.push(p.label === p.id ? `${decl} ${p.id}` : `${decl} ${p.id} as ${p.label}`);
  }
  printSeqStatements(ast.statements, out, 0);
  return out.join('\n') + '\n';
}

/**
 * @param {any[]} statements
 * @param {string[]} out
 * @param {number} depth
 */
function printSeqStatements(statements, out, depth) {
  const pad = '  '.repeat(depth);
  for (const stmt of statements) {
    if (stmt.kind === 'message') {
      const arrow = arrowToken(stmt.line, stmt.head);
      const act = stmt.activation === 'activate' ? '+' : stmt.activation === 'deactivate' ? '-' : '';
      out.push(`${pad}${stmt.from}${arrow}${act}${stmt.to}: ${stmt.text}`);
    }
    else if (stmt.kind === 'note') {
      out.push(`${pad}note ${stmt.placement} ${stmt.actors.join(',')}: ${stmt.text}`);
    }
    else if (stmt.kind === 'activate' || stmt.kind === 'deactivate') {
      out.push(`${pad}${stmt.kind} ${stmt.actor}`);
    }
    else if (stmt.kind === 'block') {
      const branchWord = stmt.blockType === 'par' ? 'and'
        : stmt.blockType === 'critical' ? 'option' : 'else';
      const b0 = stmt.branches[0];
      out.push(`${pad}${stmt.blockType}${b0.label ? ' ' + b0.label : ''}`);
      printSeqStatements(b0.statements, out, depth + 1);
      for (let i = 1; i < stmt.branches.length; i++) {
        const b = stmt.branches[i];
        out.push(`${pad}${branchWord}${b.label ? ' ' + b.label : ''}`);
        printSeqStatements(b.statements, out, depth + 1);
      }
      out.push(`${pad}end`);
    }
  }
}

/**
 * The exact inverse of `classifyArrow`.
 * @param {'solid'|'dotted'} line
 * @param {'arrow'|'open'|'cross'|'point'} head
 * @returns {string}
 */
function arrowToken(line, head) {
  const dash = line === 'dotted' ? '--' : '-';
  const tip = head === 'arrow' ? '>>' : head === 'cross' ? 'x' : head === 'point' ? ')' : '>';
  return dash + tip;
}

//#endregion
//#region class / state / er / gantt / pie (best effort) ------------

/**
 * Can this class member not stand on a line of a `{ … }` body?
 * @param {{ visibility: string|null, text: string }} member
 * @returns {boolean}
 */
function isUnbracedMember(member) {
  return member.text.includes('}') || (member.visibility === null && member.text.startsWith('%%'));
}

/**
 * @param {any} ast
 * @returns {string}
 */
function printClass(ast) {
  const out = ['classDiagram'];
  for (const cls of ast.classes) {
    if (cls.members.length === 0) {
      out.push(`class ${cls.name}`);
    }
    else if (cls.members.some(isUnbracedMember)) {
      // a body ends at its first `}` and drops comment-looking lines, so
      // such a member can only be written as a `Name : member` line
      out.push(`class ${cls.name}`);
      for (const m of cls.members) out.push(`${cls.name} : ${m.visibility ?? ''}${m.text}`);
    }
    else {
      out.push(`class ${cls.name} {`);
      for (const m of cls.members) out.push(`  ${m.visibility ?? ''}${m.text}`);
      out.push('}');
    }
  }
  for (const r of ast.relations) {
    out.push(`${r.from} ${r.type} ${r.to}${r.label ? ' : ' + r.label : ''}`);
  }
  for (const click of ast.clicks ?? []) out.push(printNodeClick(click));
  return out.join('\n') + '\n';
}

/**
 * Print a state diagram. The states keep the order the AST lists them in
 * (layout reads it); when the plain spelling would introduce them in
 * another order — a labelled state used before its label line, a child
 * listed before its parent — every state is declared up front instead.
 * @param {any} ast
 * @returns {string}
 */
function printState(ast) {
  const text = printStateLines(ast, false);
  if (sameStates(text, ast)) return text;
  const declared = printStateLines(ast, true);
  return sameStates(declared, ast) ? declared : text;
}

/**
 * Does this printed diagram introduce the AST's states in the AST's order?
 * @param {string} text
 * @param {any} ast
 * @returns {boolean}
 */
function sameStates(text, ast) {
  const read = /** @type {any} */ (parseState(text.split('\n').slice(1)));
  return read.states.length === ast.states.length
    && read.states.every((/** @type {any} */ s, /** @type {number} */ i) => s.id === ast.states[i].id);
}

/**
 * @param {any} ast
 * @param {boolean} declareAll declare every state at the top level first
 * @returns {string}
 */
function printStateLines(ast, declareAll) {
  const out = ['stateDiagram-v2'];
  const nested = ast.states.some((s) => s.parent != null) || ast.transitions.some((t) => t.parent != null);
  if (declareAll) {
    for (const s of ast.states) out.push(s.label !== s.id ? `${s.id} : ${s.label}` : `state ${s.id}`);
  }
  if (nested) {
    const states = new Map(ast.states.map((s) => [s.id, s]));
    let opened = [];
    const scope = (parent) => {
      const target = [];
      for (let id = parent; id != null; id = states.get(id)?.parent) {
        if (target.includes(id)) throw new TypeError('cyclic state-diagram parent');
        target.unshift(id);
      }
      let shared = 0;
      while (shared < opened.length && opened[shared] === target[shared]) shared++;
      for (let i = opened.length; i > shared; i--) out.push('  '.repeat(i - 1) + '}');
      for (let i = shared; i < target.length; i++) out.push('  '.repeat(i) + `state ${target[i]} {`);
      opened = target;
    };
    // Declare every id first, then retain transition document order even
    // when that requires reopening a compound scope. Priority survives print.
    for (const s of ast.states) {
      // a state declared up front is moved under its parent by naming it there
      if (declareAll && s.parent == null) continue;
      scope(s.parent);
      out.push('  '.repeat(opened.length)
        + (declareAll || s.label === s.id ? `state ${s.id}` : `${s.id} : ${s.label}`));
    }
    for (const t of ast.transitions) {
      scope(t.parent);
      out.push('  '.repeat(opened.length) + `${t.from} --> ${t.to}${t.label ? ' : ' + t.label : ''}`);
    }
    scope(null);
    return out.join('\n') + '\n';
  }
  if (!declareAll) {
    // an id-only state no transition mentions must still be DECLARED, or
    // the canonical round trip silently drops it (`state x` is the
    // parser's own spelling for exactly that)
    const mentioned = new Set();
    for (const t of ast.transitions) {
      mentioned.add(t.from);
      mentioned.add(t.to);
    }
    for (const s of ast.states) {
      if (s.label !== s.id) out.push(`${s.id} : ${s.label}`);
      else if (!mentioned.has(s.id)) out.push(`state ${s.id}`);
    }
  }
  for (const t of ast.transitions) {
    out.push(`${t.from} --> ${t.to}${t.label ? ' : ' + t.label : ''}`);
  }
  return out.join('\n') + '\n';
}

/**
 * @param {any} ast
 * @returns {string}
 */
function printEr(ast) {
  const out = ['erDiagram'];
  // a name with a space must be quoted to read back as one name
  const name = (/** @type {string} */ n) => (/\s/.test(n) ? `"${n}"` : n);
  for (const e of ast.entities) {
    if (e.attributes.length === 0) { out.push(name(e.name)); continue; }
    out.push(`${name(e.name)} {`);
    for (const a of e.attributes) {
      out.push(`  ${a.type} ${a.name}${a.keys.length ? ' ' + a.keys.join(', ') : ''}${a.comment === undefined ? '' : ` "${a.comment}"`}`);
    }
    out.push('}');
  }
  for (const r of ast.relationships) {
    out.push(`${name(r.left)} ${r.leftCard}${r.identifying ? '--' : '..'}${r.rightCard} ${name(r.right)} : ${r.label}`);
  }
  return out.join('\n') + '\n';
}

/**
 * @param {any} ast
 * @returns {string}
 */
function printGantt(ast) {
  const out = ['gantt'];
  for (const key of Object.keys(ast.meta)) out.push(`${key} ${ast.meta[key]}`.trim());
  for (const section of ast.sections) {
    if (section.name) out.push(`section ${section.name}`);
    for (const t of section.tasks) out.push(`${t.name} : ${t.info}`);
  }
  // a tree written before `click` existed has no `clicks`
  for (const click of ast.clicks ?? []) out.push(printClick(click));
  return out.join('\n') + '\n';
}

/**
 * @param {any} ast
 * @returns {string}
 */
function printPie(ast) {
  const out = ['pie' + (ast.showData ? ' showData' : '')];
  if (ast.title) out.push('title ' + ast.title);
  for (const s of ast.slices) out.push(`"${s.label.replace(/\n/g, '<br/>')}" : ${plainDecimal(s.value)}`);
  return out.join('\n') + '\n';
}

/**
 * A number as the plain decimal a pie row reads (`1e-7` is not one).
 * @param {number} value
 * @returns {string}
 */
function plainDecimal(value) {
  if (value < 0) return '-' + plainDecimal(-value);
  const text = String(value);
  const at = text.indexOf('e');
  if (at === -1) return text;
  const [whole, fraction = ''] = text.slice(0, at).split('.');
  const digits = whole + fraction;
  const point = whole.length + Number(text.slice(at + 1));
  if (point <= 0) return '0.' + '0'.repeat(-point) + digits;
  return point >= digits.length
    ? digits + '0'.repeat(point - digits.length)
    : digits.slice(0, point) + '.' + digits.slice(point);
}

//#endregion
