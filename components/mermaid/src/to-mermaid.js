//@ts-check
/**
 * @file Canonical Mermaid printer: AST → text (MERMAID-FORMAT §5).
 * The reverse arrow of `parseMermaid`, mirroring
 * `@jarenjs/md`'s `to-md.js`: one specialized closure per diagram type,
 * a **round-trip fixed point** — `parseMermaid(toMermaid(doc))`
 * deep-equals `doc.ast` for the fully-modeled types.
 *
 * The printer is *canonical*, not verbatim: it does not preserve source
 * whitespace or comments (the stored Markdown fence `value` gives
 * verbatim round-trip while a node is untransformed). Its job is
 * to re-emit an edited AST as editable Mermaid text.
 */

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

/** Labels containing shape-closer characters must be quoted. */
const RE_NEEDS_QUOTE = /[[\](){}<>|"]/;

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
      ? `subgraph ${sg.id} [${sg.label.replace(/\n/g, '<br/>')}]`
      : `subgraph ${sg.id}`);
    if (sg.direction) out.push('  direction ' + sg.direction);
    for (const id of sg.nodes) out.push('  ' + id);
    out.push('end');
  }

  // 3. Edges in AST order.
  for (const e of ast.edges) {
    const op = edgeOp(e);
    const label = e.label != null ? `|${e.label.replace(/\n/g, '<br/>')}|` : '';
    out.push(`${e.from} ${op}${label} ${e.to}`);
  }

  // 4. classDef / class / style, each in AST order.
  for (const cd of ast.classDefs) out.push(`classDef ${cd.name} ${cd.styles}`);
  for (const c of ast.classes) out.push(`class ${c.node} ${c.name}`);
  for (const s of ast.styles) out.push(`style ${s.node} ${s.styles}`);

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

/**
 * @param {string} shape
 * @param {string} label
 * @returns {string}
 */
function wrapShape(shape, label) {
  // The parser turns `<br/>` into a newline; printing that newline raw would
  // end the statement. Emitting the tag back is what makes a transformed
  // diagram round-trip to source that still parses.
  const text = label.replace(/\n/g, '<br/>');
  const l = RE_NEEDS_QUOTE.test(text) ? '"' + text.replace(/"/g, '') + '"' : text;
  switch (shape) {
    case 'round': return `(${l})`;
    case 'stadium': return `([${l}])`;
    case 'subroutine': return `[[${l}]]`;
    case 'cylinder': return `[(${l})]`;
    case 'circle': return `((${l}))`;
    case 'doublecircle': return `(((${l})))`;
    case 'diamond': return `{${l}}`;
    case 'hexagon': return `{{${l}}}`;
    case 'parallelogram': return `[/${l}/]`;
    case 'parallelogram_alt': return `[\\${l}\\]`;
    case 'trapezoid': return `[/${l}\\]`;
    case 'trapezoid_alt': return `[\\${l}/]`;
    case 'asymmetric': return `>${l}]`;
    default: return `[${l}]`;
  }
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
 * @param {any} ast
 * @returns {string}
 */
function printClass(ast) {
  const out = ['classDiagram'];
  for (const cls of ast.classes) {
    if (cls.members.length === 0) {
      out.push(`class ${cls.name}`);
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
  return out.join('\n') + '\n';
}

/**
 * @param {any} ast
 * @returns {string}
 */
function printState(ast) {
  const out = ['stateDiagram-v2'];
  for (const s of ast.states) {
    if (s.label !== s.id) out.push(`${s.id} : ${s.label}`);
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
  for (const e of ast.entities) {
    if (e.attributes.length === 0) { out.push(e.name); continue; }
    out.push(`${e.name} {`);
    for (const a of e.attributes) out.push(`  ${a.type} ${a.name}${a.keys.length ? ' ' + a.keys.join(' ') : ''}`);
    out.push('}');
  }
  for (const r of ast.relationships) {
    out.push(`${r.left} ${r.leftCard}${r.identifying ? '--' : '..'}${r.rightCard} ${r.right} : ${r.label}`);
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
  return out.join('\n') + '\n';
}

/**
 * @param {any} ast
 * @returns {string}
 */
function printPie(ast) {
  const out = ['pie' + (ast.showData ? ' showData' : '')];
  if (ast.title) out.push('title ' + ast.title);
  for (const s of ast.slices) out.push(`"${s.label}" : ${s.value}`);
  return out.join('\n') + '\n';
}

//#endregion
