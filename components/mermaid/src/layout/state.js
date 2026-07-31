//@ts-check
/**
 * @file State-diagram layout: an ADAPTER, not a second algorithm. The
 * state AST (states + labeled transitions + `[*]` pseudo-states) maps
 * onto the flowchart layout's input vocabulary — states as rounded
 * nodes, transition labels as edge labels, the start/end pseudo-states
 * as synthetic `statedot`/`doublecircle` nodes — and `layoutFlowchart`
 * does the ranking, ordering and routing. Same AST → identical
 * geometry, like every layout in this component.
 *
 * Composite states arrive flattened from the parser (the `parent`
 * field is recorded but not drawn as a cluster in v1 — the honest
 * limitation lives in MERMAID-FORMAT §6).
 */

import { layoutFlowchart } from './flowchart.js';

/** Synthetic ids for the `[*]` pseudo-states (never valid state ids
 * in source, since `[*]` is the only spelling the parser reserves). */
const START_ID = '__start';
const END_ID = '__end';

/**
 * Lay out a state AST through the flowchart engine.
 * @param {any} ast state AST ({ states, transitions })
 * @returns {any} PositionedDiagram
 */
export function layoutState(ast) {
  const nodes = [];
  const edges = [];
  let hasStart = false;
  let hasEnd = false;

  for (const t of ast.transitions) {
    if (t.from === '[*]') hasStart = true;
    if (t.to === '[*]') hasEnd = true;
  }
  if (hasStart) nodes.push({ id: START_ID, label: '', shape: 'statedot' });
  for (const s of ast.states) {
    nodes.push({ id: s.id, label: s.label ?? s.id, shape: 'round' });
  }
  if (hasEnd) nodes.push({ id: END_ID, label: '', shape: 'doublecircle' });

  for (const t of ast.transitions) {
    edges.push({
      from: t.from === '[*]' ? START_ID : t.from,
      to: t.to === '[*]' ? END_ID : t.to,
      label: t.label ?? null,
      stroke: 'solid',
      head: 'arrow',
      tail: 'none',
      length: 2,
    });
  }

  return layoutFlowchart({
    direction: 'TB',
    nodes,
    edges,
    subgraphs: [],
    classDefs: [],
    classes: [],
    styles: [],
  });
}
