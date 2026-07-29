//@ts-check
/**
 * @file Flowchart grammar → flowchart AST. Flowchart and sequence are
 * the two fully-modeled diagram types; this is the first.
 *
 * Char-code recursive descent over one statement at a time. Every
 * pattern regex is a module constant used with the sticky (`y`) flag so
 * there is no per-call `RegExp` allocation; the vertex/edge chain is a
 * hand-written scan. Produces the geometry-free flowchart AST from
 * `ast.js` — nodes, edges, subgraphs, classDef/class/style — preserving
 * shape, label and declaration order so `to-mermaid.js` is a fixed
 * point.
 */

import {
  flowNode, flowEdge, flowSubgraph, flowClassDef, flowClass, flowStyle, flowchartAst,
} from '../ast.js';
import { fail } from '../errors.js';
import { countCharCode } from '@jarenjs/core/string';

/**
 * Shape opener sequences, longest first, each with the closer sequences
 * that terminate it and the resulting shape name.
 * @type {[string, [string, string][]][]}
 */
const SHAPE_OPENERS = [
  ['(((', [[')))', 'doublecircle']]],
  ['[[', [[']]', 'subroutine']]],
  ['[(', [[')]', 'cylinder']]],
  ['[/', [['/]', 'parallelogram'], ['\\]', 'trapezoid']]],
  ['[\\', [['\\]', 'parallelogram_alt'], ['/]', 'trapezoid_alt']]],
  ['([', [['])', 'stadium']]],
  ['((', [['))', 'circle']]],
  ['{{', [['}}', 'hexagon']]],
  ['[', [[']', 'rect']]],
  ['(', [[')', 'round']]],
  ['{', [['}', 'diamond']]],
  ['>', [[']', 'asymmetric']]],
];

/** Sticky: an edge with an inline ` text ` label between two link runs. */
const RE_EDGE_LABELED = /(<?)([-.=]{2,})\s+(.+?)\s+([-.=]{2,})([>ox]?)/y;
/** Sticky: a plain link operator. */
const RE_EDGE_PLAIN = /(<?)([-.=]{2,})([>ox]?)/y;
/** Sticky: an identifier (vertex id, class name, …). Ids are
 * alphanumeric/underscore (plus Unicode letters); `-`/`.` are excluded
 * so they cannot swallow a following link operator. */
const RE_ID = /[A-Za-z0-9_À-￿][\wÀ-￿]*/y;

/**
 * Parse a flowchart body (config already stripped) into the flowchart
 * AST. `keyword`/`firstLine` give the header; `direction` overrides.
 * @param {string[]} lines body lines
 * @param {number} lineOffset absolute line number of `lines[0]`
 * @param {string} direction detected direction
 * @returns {object}
 */
export function parseFlowchart(lines, lineOffset, direction) {
  /** @type {Map<string, object>} */
  const nodeMap = new Map();
  const nodeOrder = [];
  const edges = [];
  const subgraphs = [];
  const classDefs = [];
  const classes = [];
  const styles = [];
  /** @type {{ id: string, label: string, direction: string|null, nodes: string[] }[]} */
  const subgraphStack = [];

  const ensureNode = (id, label, shape) => {
    let node = nodeMap.get(id);
    if (node === undefined) {
      node = flowNode(id, label ?? id, shape ?? 'rect');
      nodeMap.set(id, node);
      nodeOrder.push(id);
    }
    else if (label !== null && label !== undefined) {
      node.label = label;
      node.shape = shape ?? node.shape;
    }
    if (subgraphStack.length > 0) {
      const group = subgraphStack[subgraphStack.length - 1];
      if (!group.nodes.includes(id)) group.nodes.push(id);
    }
    return node;
  };

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li].trim();
    if (line === '') continue;
    const lineNo = lineOffset + li + 1;

    // subgraph … end
    if (line === 'end') {
      const group = subgraphStack.pop();
      if (group === undefined) fail("unexpected 'end' with no open subgraph", lineNo);
      // A finished subgraph goes to the list only when it is top-level;
      // nested subgraphs still record membership via their id.
      subgraphs.push(flowSubgraph(group.id, group.label, group.direction, group.nodes));
      continue;
    }
    if (line.startsWith('subgraph')) {
      const rest = line.slice('subgraph'.length).trim();
      const sg = parseSubgraphHeader(rest);
      subgraphStack.push({ id: sg.id, label: sg.label, direction: null, nodes: [] });
      continue;
    }
    if (line.startsWith('direction ')) {
      const dir = line.slice('direction '.length).trim();
      if (subgraphStack.length > 0) subgraphStack[subgraphStack.length - 1].direction = dir;
      continue;
    }
    if (line.startsWith('classDef ')) {
      const rest = line.slice('classDef '.length).trim();
      const sp = rest.indexOf(' ');
      if (sp === -1) { classDefs.push(flowClassDef(rest, '')); continue; }
      classDefs.push(flowClassDef(rest.slice(0, sp).trim(), rest.slice(sp + 1).trim()));
      continue;
    }
    if (line.startsWith('class ')) {
      const rest = line.slice('class '.length).trim();
      const sp = rest.lastIndexOf(' ');
      if (sp === -1) continue;
      const nodeList = rest.slice(0, sp).split(',').map((s) => s.trim()).filter(Boolean);
      const name = rest.slice(sp + 1).trim();
      for (const n of nodeList) classes.push(flowClass(n, name));
      continue;
    }
    if (line.startsWith('style ')) {
      const rest = line.slice('style '.length).trim();
      const sp = rest.indexOf(' ');
      if (sp === -1) continue;
      styles.push(flowStyle(rest.slice(0, sp).trim(), rest.slice(sp + 1).trim()));
      continue;
    }
    if (line.startsWith('click ') || line.startsWith('linkStyle ')) {
      continue; // parse-accept, not modeled in v1
    }

    // A node/edge chain: split on ';' first (multiple statements per line).
    for (const stmt of splitStatements(line)) {
      parseChain(stmt, lineNo, ensureNode, edges, classes);
    }
  }

  // Close any dangling subgraphs (lenient).
  while (subgraphStack.length > 0) {
    const group = subgraphStack.pop();
    subgraphs.push(flowSubgraph(group.id, group.label, group.direction, group.nodes));
  }

  const nodes = nodeOrder.map((id) => nodeMap.get(id));
  return flowchartAst(direction, nodes, edges, subgraphs, classDefs, classes, styles);
}

/**
 * Split a line on top-level `;` (rarely used, but valid).
 *
 * Only a `;` OUTSIDE a quoted label separates statements. A label is text —
 * `"fetch is injected; streaming via SSE"` is one node, not two statements —
 * and splitting inside it produced an unterminated-shape error on a document
 * that is perfectly good Mermaid.
 * @param {string} line
 * @returns {string[]}
 */
function splitStatements(line) {
  if (line.indexOf(';') === -1) return [line];
  const out = [];
  let start = 0;
  let quote = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote !== '') {
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === '\'') { quote = ch; continue; }
    if (ch !== ';') continue;
    const part = line.slice(start, i).trim();
    if (part !== '') out.push(part);
    start = i + 1;
  }
  const tail = line.slice(start).trim();
  if (tail !== '') out.push(tail);
  return out;
}

/**
 * Parse `subgraph` header: `id`, `id[title]`, `"title"`, or `id [title]`.
 * @param {string} rest
 * @returns {{ id: string, label: string }}
 */
function parseSubgraphHeader(rest) {
  if (rest === '') return { id: 'sub', label: '' };
  // id[title] form
  const br = rest.indexOf('[');
  if (br !== -1 && rest.endsWith(']')) {
    const id = rest.slice(0, br).trim();
    const label = stripQuotes(rest.slice(br + 1, -1).trim());
    return { id: id || label, label };
  }
  if (rest.startsWith('"') && rest.endsWith('"')) {
    const label = stripQuotes(rest.slice(1, -1));
    return { id: label, label };
  }
  return { id: rest, label: rest };
}

/**
 * Parse one vertex/edge chain: `A[x] --> B & C -->|l| D`.
 * @param {string} stmt
 * @param {number} lineNo
 * @param {(id: string, label: string|null, shape: string|null) => object} ensureNode
 * @param {object[]} edges
 * @param {object[]} classes
 */
function parseChain(stmt, lineNo, ensureNode, edges, classes) {
  const s = stmt;
  let pos = skipSpace(s, 0);
  let prevGroup = readVertexGroup(s, pos, lineNo, ensureNode, classes);
  if (prevGroup === null) return; // empty
  pos = prevGroup.pos;

  // Standalone vertex (no edge): already ensured; done.
  for (;;) {
    pos = skipSpace(s, pos);
    if (pos >= s.length) break;
    const edge = readEdge(s, pos);
    if (edge === null) {
      // Unrecognized trailing content — be lenient, stop.
      break;
    }
    pos = edge.pos;
    pos = skipSpace(s, pos);
    const nextGroup = readVertexGroup(s, pos, lineNo, ensureNode, classes);
    if (nextGroup === null) fail('expected a node after a link', lineNo);
    pos = nextGroup.pos;
    for (const from of prevGroup.ids) {
      for (const to of nextGroup.ids) {
        edges.push(flowEdge(from, to, edge.stroke, edge.head, edge.tail, edge.length, edge.label));
      }
    }
    prevGroup = nextGroup;
  }
}

/**
 * Read a `&`-separated vertex group, ensuring each node.
 * @returns {{ ids: string[], pos: number } | null}
 */
function readVertexGroup(s, pos, lineNo, ensureNode, classes) {
  const ids = [];
  for (;;) {
    pos = skipSpace(s, pos);
    const v = readVertex(s, pos, lineNo);
    if (v === null) return ids.length === 0 ? null : { ids, pos };
    ensureNode(v.id, v.label, v.shape);
    if (v.className !== null) classes.push(flowClass(v.id, v.className));
    ids.push(v.id);
    pos = skipSpace(s, v.pos);
    if (s.charCodeAt(pos) === 0x26 /* & */) { pos++; continue; }
    return { ids, pos };
  }
}

/**
 * Read one vertex: id + optional shape/label + optional `:::class`.
 * @returns {{ id: string, label: string|null, shape: string|null, className: string|null, pos: number } | null}
 */
function readVertex(s, pos, lineNo) {
  RE_ID.lastIndex = pos;
  const m = RE_ID.exec(s);
  if (m === null || m.index !== pos) return null;
  const id = m[0];
  let p = RE_ID.lastIndex;

  let label = null;
  let shape = null;
  // Shape wrapper directly after the id (no space).
  const opened = matchOpener(s, p);
  if (opened !== null) {
    const closed = scanToCloser(s, opened.contentStart, opened.closers);
    if (closed === null) fail(`unterminated '${opened.opener}' shape for node '${id}'`, lineNo);
    label = stripQuotes(s.slice(opened.contentStart, closed.at).trim());
    shape = closed.shape;
    p = closed.end;
  }

  // Inline class: A:::name
  let className = null;
  if (s.charCodeAt(p) === 0x3a && s.charCodeAt(p + 1) === 0x3a && s.charCodeAt(p + 2) === 0x3a) {
    RE_ID.lastIndex = p + 3;
    const cm = RE_ID.exec(s);
    if (cm !== null && cm.index === p + 3) {
      className = cm[0];
      p = RE_ID.lastIndex;
    }
  }
  return { id, label, shape, className, pos: p };
}

/**
 * Match a shape opener at `pos` (longest first).
 * @returns {{ opener: string, contentStart: number, closers: [string, string][] } | null}
 */
function matchOpener(s, pos) {
  for (let i = 0; i < SHAPE_OPENERS.length; i++) {
    const [opener, closers] = SHAPE_OPENERS[i];
    if (s.startsWith(opener, pos)) {
      return { opener, contentStart: pos + opener.length, closers };
    }
  }
  return null;
}

/**
 * Scan for the earliest closer sequence from `from`.
 * @param {string} s
 * @param {number} from
 * @param {[string, string][]} closers
 * @returns {{ at: number, end: number, shape: string } | null}
 */
function scanToCloser(s, from, closers) {
  for (let i = from; i < s.length; i++) {
    for (let c = 0; c < closers.length; c++) {
      const [seq, shape] = closers[c];
      if (s.startsWith(seq, i)) return { at: i, end: i + seq.length, shape };
    }
  }
  return null;
}

/**
 * Read a link operator, plain or labeled.
 * @returns {{ stroke: string, head: string, tail: string, length: number, label: string|null, pos: number } | null}
 */
function readEdge(s, pos) {
  RE_EDGE_LABELED.lastIndex = pos;
  let m = RE_EDGE_LABELED.exec(s);
  let label = null;
  if (m !== null && m.index === pos) {
    label = m[3].trim();
    const info = classifyLink(m[1], m[4], m[5]);
    return { ...info, label, pos: RE_EDGE_LABELED.lastIndex };
  }
  RE_EDGE_PLAIN.lastIndex = pos;
  m = RE_EDGE_PLAIN.exec(s);
  if (m === null || m.index !== pos) return null;
  const info = classifyLink(m[1], m[2], m[3]);
  let p = RE_EDGE_PLAIN.lastIndex;
  // Optional |label|
  if (s.charCodeAt(p) === 0x7c /* | */) {
    const close = s.indexOf('|', p + 1);
    if (close !== -1) {
      label = stripQuotes(s.slice(p + 1, close).trim());
      p = close + 1;
    }
  }
  return { ...info, label, pos: p };
}

/**
 * Classify a link body into stroke/head/tail/length.
 * @param {string} tailMark leading `<` or ''
 * @param {string} body run of `-`/`.`/`=`
 * @param {string} headMark trailing `>`/`o`/`x` or ''
 */
function classifyLink(tailMark, body, headMark) {
  const stroke = body.indexOf('=') !== -1 ? 'thick'
    : body.indexOf('.') !== -1 ? 'dotted' : 'solid';
  const head = headMark === '>' ? 'arrow' : headMark === 'o' ? 'circle'
    : headMark === 'x' ? 'cross' : 'none';
  const tail = tailMark === '<' ? 'arrow' : 'none';
  let length;
  if (stroke === 'thick') length = countCharCode(body, 0x3d);
  else if (stroke === 'dotted') length = countCharCode(body, 0x2e);
  else length = countCharCode(body, 0x2d);
  if (length < 1) length = 1;
  return { stroke, head, tail, length };
}

/**
 * @param {string} s @param {number} pos @returns {number}
 */
function skipSpace(s, pos) {
  while (pos < s.length) {
    const c = s.charCodeAt(pos);
    if (c !== 0x20 && c !== 0x09) break;
    pos++;
  }
  return pos;
}

/**
 * Strip surrounding matching quotes from a label.
 * @param {string} s @returns {string}
 */
export function stripQuotes(s) {
  let out = s;
  if (out.length >= 2) {
    const a = out.charCodeAt(0);
    const b = out.charCodeAt(out.length - 1);
    if ((a === 0x22 && b === 0x22) || (a === 0x27 && b === 0x27)) out = out.slice(1, -1);
  }
  // `<br/>` is Mermaid's line break inside a label. Normalizing it to a real
  // newline here — the one place every label passes through — is what lets
  // both the text measurement and the renderer treat it as one, instead of
  // printing the tag and sizing the box for a single long line.
  return RE_BR.test(out) ? out.replace(RE_BR, '\n') : out;
}

/** `<br>`, `<br/>`, `<br />` — the spellings Mermaid accepts. */
const RE_BR = /<br\s*\/?>/gi;
