//@ts-check
/**
 * @file `parseMermaid`: detect the diagram type + config on the first
 * non-config line, dispatch to the type parser, and assemble the shared
 * `DiagramDocument` envelope.
 *
 * Flowchart and sequence are fully modeled. The remaining
 * first-class types (class, ER, state, gantt, pie) plug in through
 * `TYPE_PARSERS`; secondary types (mindmap, gitGraph, journey, timeline,
 * quadrantChart) parse-accept into a geometry-free `rawAst` and are
 * counted honestly in the coverage scorecard.
 */

import { diagramDocument, rawAst } from '../ast.js';
import { hashContent, toLines, firstToken } from '../utils.js';
import { parseMermaidConfig } from './config.js';
import { parseFlowchart } from './flowchart.js';
import { parseSequence } from './sequence.js';
import { parseClass } from './class.js';
import { parseState } from './state.js';
import { parseEr } from './er.js';
import { parseGantt } from './gantt.js';
import { parsePie } from './pie.js';
import { fail } from '../errors.js';

/** Keyword → canonical diagram type. */
const KEYWORDS = {
  flowchart: 'flowchart',
  graph: 'flowchart',
  sequenceDiagram: 'sequence',
  classDiagram: 'class',
  'classDiagram-v2': 'class',
  stateDiagram: 'state',
  'stateDiagram-v2': 'state',
  erDiagram: 'er',
  gantt: 'gantt',
  pie: 'pie',
  mindmap: 'mindmap',
  gitGraph: 'gitGraph',
  journey: 'journey',
  timeline: 'timeline',
  quadrantChart: 'quadrantChart',
  requirementDiagram: 'requirement',
};

/** Fully/partly modeled type parsers. */
const TYPE_PARSERS = {
  class: parseClass,
  state: parseState,
  er: parseEr,
  gantt: parseGantt,
  pie: parsePie,
};

/** Types that parse-accept into a placeholder in the coverage scorecard. */
export const SECONDARY_TYPES = new Set([
  'mindmap', 'gitGraph', 'journey', 'timeline', 'quadrantChart', 'requirement',
]);

/**
 * Parse Mermaid source into a `DiagramDocument`.
 * @param {string} source
 * @param {{ parseFrontmatter?: (text: string) => any }} [options]
 * @returns {import('../ast.js').DiagramDocument}
 */
export function parseMermaid(source, options = {}) {
  const { config, title, body } = parseMermaidConfig(source, options);
  const lines = toLines(body);

  // First non-blank line carries the diagram keyword.
  let start = 0;
  while (start < lines.length && lines[start].trim() === '') start++;
  if (start >= lines.length) fail('empty diagram', 1);

  const header = lines[start].trim();
  const keyword = firstToken(header);
  const type = KEYWORDS[keyword];
  if (type === undefined) {
    fail(`unknown diagram type '${keyword}'`, start + 1);
  }

  let direction = null;
  let ast;
  const bodyLines = lines.slice(start + 1);
  const bodyOffset = start + 1;

  if (type === 'flowchart') {
    direction = detectDirection(header, keyword);
    ast = parseFlowchart(bodyLines, bodyOffset, direction);
  }
  else if (type === 'sequence') {
    ast = parseSequence(bodyLines, bodyOffset);
  }
  else if (TYPE_PARSERS[type] !== undefined) {
    ast = TYPE_PARSERS[type](bodyLines, bodyOffset, header);
  }
  else {
    // Secondary: preserve the raw body so `toMermaid` round-trips and
    // the scorecard is honest.
    ast = rawAst(type, bodyLines.filter((l) => l.trim() !== ''));
  }

  return diagramDocument(type, config, ast, {
    hash: hashContent(source),
    direction,
    title,
  });
}

/**
 * Detect a flowchart direction from the header (`flowchart TD`).
 * @param {string} header
 * @param {string} keyword
 * @returns {string}
 */
function detectDirection(header, keyword) {
  const rest = header.slice(keyword.length).trim();
  // `graph LR` or `flowchart TD`; a trailing `:` occasionally appears.
  const dir = rest.replace(/:$/, '').trim().toUpperCase();
  const known = new Set(['TB', 'TD', 'BT', 'LR', 'RL']);
  return known.has(dir) ? (dir === 'TD' ? 'TD' : dir) : 'TB';
}
