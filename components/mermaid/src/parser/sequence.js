//@ts-check
/**
 * @file Sequence grammar → sequence AST (design decision D10 type 2).
 *
 * Line-oriented, with a block stack for loop/alt/opt/par/critical/break.
 * Explicitly declared participants keep their declaration order; a
 * message to an undeclared actor is legal (the layout pass creates the
 * lifeline), so the AST records only what the source states — faithful
 * and geometry-free (D11). Module-const regexes only.
 */

import {
  seqParticipant, seqMessage, seqNote, seqActivation, seqBlock, sequenceAst,
} from '../ast.js';
import { fail } from '../errors.js';

/** A message: `A->>+B: text`. */
const RE_MSG = /^([^-<>:]+?)\s*((?:-{1,2})(?:>>|>|x|\)))\s*([+-]?)\s*([^:]+?)\s*:\s*(.*)$/;
/** `participant A as Alice` / `actor A`. */
const RE_PARTICIPANT = /^(participant|actor)\s+(.+)$/;
/** `note left of A: t` / `note right of A: t` / `note over A,B: t`. */
const RE_NOTE = /^[Nn]ote\s+(left of|right of|over)\s+([^:]+):\s*(.*)$/;

/** Block openers whose first word starts a frame. */
const OPEN_BLOCKS = new Set(['loop', 'opt', 'alt', 'par', 'critical', 'break', 'rect']);

/**
 * @param {string[]} lines body lines (config stripped)
 * @param {number} lineOffset absolute line number of `lines[0]`
 * @returns {object}
 */
export function parseSequence(lines, lineOffset) {
  const participants = [];
  const seen = new Set();
  const rootStatements = [];
  let current = rootStatements;
  /** @type {{ block: any, parent: any[], skip: boolean }[]} */
  const stack = [];
  let autonumber = false;

  const declare = (id, label, kind) => {
    if (seen.has(id)) return;
    seen.add(id);
    participants.push(seqParticipant(id, label ?? id, kind));
  };

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li].trim();
    if (line === '') continue;
    const lineNo = lineOffset + li + 1;
    const firstWord = wordOf(line);

    if (line === 'autonumber') { autonumber = true; continue; }

    if (firstWord === 'participant' || firstWord === 'actor') {
      const m = RE_PARTICIPANT.exec(line);
      if (m !== null) {
        const { id, label } = splitAlias(m[2].trim());
        declare(id, label, /** @type {any} */ (m[1]));
      }
      continue;
    }

    if (firstWord === 'activate' || firstWord === 'deactivate') {
      const actor = line.slice(firstWord.length).trim();
      current.push(seqActivation(/** @type {any} */ (firstWord), actor));
      continue;
    }

    if (/^[Nn]ote\s/.test(line)) {
      const m = RE_NOTE.exec(line);
      if (m !== null) {
        const actors = m[2].split(',').map((s) => s.trim()).filter(Boolean);
        current.push(seqNote(/** @type {any} */ (m[1]), actors, m[3].trim()));
      }
      continue;
    }

    // Block control.
    if (OPEN_BLOCKS.has(firstWord)) {
      const label = line.slice(firstWord.length).trim();
      if (firstWord === 'rect') {
        // Background rectangle: parse-accept, statements flow to parent.
        stack.push({ block: null, parent: current, skip: true });
        continue;
      }
      const block = seqBlock(/** @type {any} */ (firstWord), [{ label, statements: [] }]);
      current.push(block);
      stack.push({ block, parent: current, skip: false });
      current = block.branches[0].statements;
      continue;
    }
    if (firstWord === 'else' || firstWord === 'and' || firstWord === 'option') {
      const top = stack[stack.length - 1];
      if (top === undefined || top.block === null) {
        fail(`'${firstWord}' outside a block`, lineNo);
      }
      const branch = { label: line.slice(firstWord.length).trim(), statements: [] };
      top.block.branches.push(branch);
      current = branch.statements;
      continue;
    }
    if (line === 'end') {
      const entry = stack.pop();
      if (entry === undefined) fail("unexpected 'end'", lineNo);
      current = entry.parent;
      continue;
    }

    // A message.
    const mm = RE_MSG.exec(line);
    if (mm !== null) {
      const from = mm[1].trim();
      const arrow = mm[2];
      const activation = mm[3] === '+' ? 'activate' : mm[3] === '-' ? 'deactivate' : null;
      const to = mm[4].trim();
      const text = mm[5];
      declare(from, from, 'participant');
      declare(to, to, 'participant');
      const { line: lineStyle, head } = classifyArrow(arrow);
      current.push(seqMessage(from, to, text, lineStyle, head, /** @type {any} */ (activation)));
      continue;
    }

    // Unknown directive — lenient parse-accept (title:, links, etc.).
  }

  return sequenceAst(participants, rootStatements, autonumber);
}

/**
 * Classify a sequence arrow token into line style + head.
 * @param {string} arrow
 * @returns {{ line: 'solid'|'dotted', head: 'arrow'|'open'|'cross'|'point' }}
 */
function classifyArrow(arrow) {
  const line = arrow.startsWith('--') ? 'dotted' : 'solid';
  const head = arrow.endsWith('>>') ? 'arrow'
    : arrow.endsWith('x') ? 'cross'
      : arrow.endsWith(')') ? 'point'
        : 'open';
  return { line, head };
}

/**
 * `A as Alice` → { id, label }; `A` → { id, label: id }.
 * @param {string} text
 * @returns {{ id: string, label: string }}
 */
function splitAlias(text) {
  const idx = text.indexOf(' as ');
  if (idx === -1) return { id: text.trim(), label: text.trim() };
  return { id: text.slice(0, idx).trim(), label: text.slice(idx + 4).trim() };
}

/**
 * The first whitespace-delimited word of a line.
 * @param {string} line
 * @returns {string}
 */
function wordOf(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) !== 0x20 && line.charCodeAt(i) !== 0x09) i++;
  return line.slice(0, i);
}
