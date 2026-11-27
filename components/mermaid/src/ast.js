//@ts-check
/**
 * @file The Mermaid AST vocabulary: node constructors and walkers.
 *
 * Every node is a plain JSON object born from a constructor so that all
 * nodes of a type share one hidden class — property access stays
 * monomorphic and the structural hash is deterministic (MERMAID-FORMAT
 * §4). The AST is deliberately **geometry-free**:
 * layout is a separate pass, so the AST is a faithful, lossless
 * semantic model of the diagram's *meaning* — a directed graph
 * (flowchart), an ordered interaction (sequence), a finite state machine
 * (state) — that other engines project via JSLT without ever seeing a
 * coordinate.
 *
 * Member order is fixed per constructor; keep it stable so the FNV-1a
 * hash of `JSON.stringify` is reproducible and the round-trip printer
 * (`to-mermaid.js`) is a fixed point.
 */

/** The diagram-document format version this package produces. */
export const MERMAID_VERSION = '0.1';

//#region envelope --------------------------------------------------

/**
 * @typedef {object} DiagramDocument
 * @property {string} $mermaid format version
 * @property {string} diagram diagram type (`flowchart`, `sequence`, …)
 * @property {any} config plain-JSON config (theme, per-type options)
 * @property {any} ast the type-specific, geometry-free AST
 * @property {{ hash: string, direction: string|null, title: string|null }} meta
 */

/**
 * Assemble the shared DiagramDocument envelope. Fresh per parse,
 * never mutated after return — share-friendly for JSLT/patch.
 * @param {string} diagram
 * @param {any} config
 * @param {any} ast
 * @param {{ hash: string, direction: string|null, title: string|null }} meta
 * @returns {DiagramDocument}
 */
export function diagramDocument(diagram, config, ast, meta) {
  return { $mermaid: MERMAID_VERSION, diagram, config, ast, meta };
}

//#endregion
//#region flowchart -------------------------------------------------

/**
 * A node's shape: one with a bracket form by that form's name (`rect` …
 * `asymmetric`), and each of Mermaid's other shapes, which only a node's
 * `@{ shape: … }` names, by Mermaid's short name for it (`doc`, `flip-tri`, …).
 * @typedef {'rect'|'round'|'stadium'|'subroutine'|'cylinder'|'circle'
 *   |'doublecircle'|'diamond'|'hexagon'|'parallelogram'|'parallelogram_alt'
 *   |'trapezoid'|'trapezoid_alt'|'asymmetric'
 *   |'datastore'|'bang'|'cloud'|'text'|'notch-rect'|'lin-rect'|'sm-circ'|'fr-circ'|'fork'
 *   |'hourglass'|'brace'|'brace-r'|'braces'|'bolt'|'doc'|'delay'|'h-cyl'|'lin-cyl'|'curv-trap'
 *   |'div-rect'|'tri'|'win-pane'|'f-circ'|'notch-pent'|'flip-tri'|'sl-rect'|'docs'|'st-rect'
 *   |'bow-rect'|'cross-circ'|'tag-doc'|'tag-rect'|'flag'|'lin-doc'} FlowShape
 */

/**
 * The shapes only a node's `@{ shape: … }` names: Mermaid's shapes with no
 * bracket form, by Mermaid's short name.
 * @type {ReadonlySet<string>}
 */
export const FLOW_NAMED_SHAPES = new Set([
  'datastore', 'bang', 'cloud', 'text', 'notch-rect', 'lin-rect', 'sm-circ', 'fr-circ', 'fork',
  'hourglass', 'brace', 'brace-r', 'braces', 'bolt', 'doc', 'delay', 'h-cyl', 'lin-cyl', 'curv-trap',
  'div-rect', 'tri', 'win-pane', 'f-circ', 'notch-pent', 'flip-tri', 'sl-rect', 'docs', 'st-rect',
  'bow-rect', 'cross-circ', 'tag-doc', 'tag-rect', 'flag', 'lin-doc',
]);

/**
 * A flowchart vertex.
 * @param {string} id
 * @param {string} label
 * @param {FlowShape} shape
 * @returns {{ id: string, label: string, shape: FlowShape }}
 */
export function flowNode(id, label, shape) {
  return { id, label, shape };
}

/**
 * A flowchart edge (link). `stroke` is the line style (`invisible` for
 * `~~~`, a link that places its ends and draws nothing), `head`/`tail`
 * the endpoint markers, `length` the dash count (preserved so the
 * canonical printer is a fixed point), `label` the optional edge text.
 * @param {string} from
 * @param {string} to
 * @param {'solid'|'thick'|'dotted'|'invisible'} stroke
 * @param {'none'|'arrow'|'circle'|'cross'} head
 * @param {'none'|'arrow'|'circle'|'cross'} tail
 * @param {number} length
 * @param {string|null} label
 * @returns {object}
 */
export function flowEdge(from, to, stroke, head, tail, length, label) {
  return { from, to, stroke, head, tail, length, label };
}

/**
 * A subgraph grouping.
 * @param {string} id
 * @param {string} label
 * @param {string|null} direction
 * @param {string[]} nodes ids of its member nodes and of the subgraphs nested in it
 * @returns {object}
 */
export function flowSubgraph(id, label, direction, nodes) {
  return { id, label, direction, nodes };
}

/**
 * A `classDef` style class.
 * @param {string} name
 * @param {string} styles semicolon-separated CSS declarations
 * @returns {object}
 */
export function flowClassDef(name, styles) {
  return { name, styles };
}

/**
 * A `class`/`:::` assignment of a style class to a node.
 * @param {string} node
 * @param {string} name
 * @returns {object}
 */
export function flowClass(node, name) {
  return { node, name };
}

/**
 * A `style` inline-style assignment to a node.
 * @param {string} node
 * @param {string} styles
 * @returns {object}
 */
export function flowStyle(node, styles) {
  return { node, styles };
}

/**
 * The flowchart AST root.
 * @param {string} direction
 * @param {object[]} nodes
 * @param {object[]} edges
 * @param {object[]} subgraphs
 * @param {object[]} classDefs
 * @param {object[]} classes
 * @param {object[]} styles
 * @param {import('./parser/click.js').NodeClick[]} [clicks] the `click`
 *   statements in source order; a tree written before they were read lacks
 *   the member, and reads as none
 * @returns {object}
 */
export function flowchartAst(direction, nodes, edges, subgraphs, classDefs, classes, styles, clicks = []) {
  return { direction, nodes, edges, subgraphs, classDefs, classes, styles, clicks };
}

//#endregion
//#region sequence --------------------------------------------------

/**
 * A declared participant/actor. A participant whose `@{ "type": … }` names
 * one of Mermaid's other boxes (`boundary`, `control`, `entity`, `database`,
 * `collections`, `queue`) also carries it as `type`, which the renderer
 * draws as Mermaid's glyph for it.
 * @param {string} id
 * @param {string} label
 * @param {'participant'|'actor'} kind
 * @returns {{ id: string, label: string, kind: 'participant'|'actor', type?: string }}
 */
export function seqParticipant(id, label, kind) {
  return { id, label, kind };
}

/**
 * A message's head: `arrow` (`->>`), `open` (`->`), `cross` (`-x`), `point`
 * (`-)`), `both` (the two-way `<<->>`), and the half arrows: `half-top`
 * (`-|\`), `half-bottom` (`-|/`), `stick-top` (`-\\`), `stick-bottom`
 * (`-//`), and each written before the line (`/|-`, `\|-`, `//-`, `\\-`) as
 * its `-reverse`, which stands at the sender's end and points at it.
 * @typedef {'arrow'|'open'|'cross'|'point'|'both'|'half-top'|'half-bottom'|'stick-top'|'stick-bottom'
 *   |'half-top-reverse'|'half-bottom-reverse'|'stick-top-reverse'|'stick-bottom-reverse'} SeqHead
 */

/**
 * A message statement. A message written with Mermaid's central-connection
 * marks (`A()->>()B`) also carries `central`: `from`, `to` or `both`, the
 * ends the marks stand at, which the renderer draws as a dot on the lifeline.
 * @param {string} from
 * @param {string} to
 * @param {string} text
 * @param {'solid'|'dotted'} line
 * @param {SeqHead} head
 * @param {'activate'|'deactivate'|null} activation `+`/`-` shorthand
 * @returns {{ kind: 'message', from: string, to: string, text: string, line: 'solid'|'dotted',
 *   head: SeqHead, activation: 'activate'|'deactivate'|null, central?: 'from'|'to'|'both' }}
 */
export function seqMessage(from, to, text, line, head, activation) {
  return { kind: 'message', from, to, text, line, head, activation };
}

/**
 * A note statement.
 * @param {'left of'|'right of'|'over'} placement
 * @param {string[]} actors
 * @param {string} text
 * @returns {object}
 */
export function seqNote(placement, actors, text) {
  return { kind: 'note', placement, actors, text };
}

/**
 * An explicit activate/deactivate statement.
 * @param {'activate'|'deactivate'} kind
 * @param {string} actor
 * @returns {object}
 */
export function seqActivation(kind, actor) {
  return { kind, actor };
}

/**
 * A block statement (loop/opt/alt/par/critical/break). Single-branch
 * blocks (loop/opt/critical/break) carry one branch; alt/par carry one
 * per `else`/`and` section. `branches` is always present so the shape
 * is monomorphic.
 * @param {'loop'|'opt'|'alt'|'par'|'critical'|'break'} blockType
 * @param {{ label: string, statements: object[] }[]} branches
 * @returns {object}
 */
export function seqBlock(blockType, branches) {
  return { kind: 'block', blockType, branches };
}

/**
 * The sequence AST root.
 * @param {object[]} participants explicitly declared participants
 * @param {object[]} statements ordered interaction statements
 * @param {boolean} autonumber
 * @returns {object}
 */
export function sequenceAst(participants, statements, autonumber) {
  return { participants, statements, autonumber };
}

//#endregion
//#region generic AST for secondary/placeholder diagrams ------------

/**
 * A geometry-free "lines" AST for diagram types that parse-accept but
 * are not yet laid out (the secondary types). Preserves the raw body
 * lines so `toMermaid` round-trips and the coverage scorecard can be
 * honest.
 * @param {string} diagram
 * @param {string[]} lines
 * @returns {object}
 */
export function rawAst(diagram, lines) {
  return { diagram, lines };
}

//#endregion
//#region walkers ---------------------------------------------------

/**
 * Walk the ordered statements of a sequence AST (descending into block
 * branches), calling `visitor(stmt)` pre-order.
 * @param {object[]} statements
 * @param {(stmt: any) => void} visitor
 */
export function walkSequence(statements, visitor) {
  for (let i = 0; i < statements.length; i++) {
    const stmt = statements[i];
    visitor(stmt);
    if (/** @type {any} */ (stmt).kind === 'block') {
      const branches = /** @type {any} */ (stmt).branches;
      for (let b = 0; b < branches.length; b++) {
        walkSequence(branches[b].statements, visitor);
      }
    }
  }
}

//#endregion
