//@ts-check
/**
 * @file Sequence grammar → sequence AST. Flowchart and sequence are
 * the two fully-modeled diagram types; this is the second.
 *
 * Line-oriented, with a block stack for loop/alt/opt/par/critical/break.
 * Participants keep the order they first appear in: a `participant` /
 * `actor` line, or a message or note naming an actor no line declared,
 * declares it there, as Mermaid does. Geometry-free; module-const regexes
 * only.
 */

import {
  seqParticipant, seqMessage, seqNote, seqActivation, seqBlock, sequenceAst,
} from '../ast.js';
import { failWith } from '../errors.js';
import { firstToken } from '../utils.js';

/**
 * A message's arrow, as Mermaid spells them: `->>`, `->`, `-x`, `-)`, the
 * two-way `<<->>`, the half arrows `-|\`, `-|/`, `-\\`, `-//` and their
 * reverse `/|-`, `\|-`, `//-`, `\\-`; each with `--` for a dotted line.
 */
const ARROW = '<<-{1,2}>>|-{1,2}(?:>>|>|x|\\)|\\|\\\\|\\|\\/|\\\\\\\\|\\/\\/)|(?:\\/\\||\\\\\\||\\/\\/|\\\\\\\\)-{1,2}';
/** A message: `A->>+B: text`, a `()` mark at either end of the arrow. */
const RE_MSG = new RegExp(`^([^-<>:]+?)\\s*(\\(\\))?\\s*(${ARROW})\\s*([+-]?)\\s*(\\(\\))?\\s*([^:]+?)\\s*:\\s*(.*)$`);
/** `participant A as Alice` / `actor A`. */
const RE_PARTICIPANT = /^(participant|actor)\s+(.+)$/;
/** A participant's `@{ … }` metadata: the name before it, the metadata, the rest. */
const RE_PARTICIPANT_META = /^([^@]*?)\s*@\{([^}]*)\}(.*)$/;
/** The `"alias"` member of a participant's metadata. */
const RE_META_ALIAS = /"alias"\s*:\s*"([^"]*)"/;
/** The `"type"` member of a participant's metadata, one of Mermaid's participant types. */
const RE_META_TYPE = /"type"\s*:\s*"(actor|participant|boundary|control|entity|database|collections|queue)"/;
/** `note left of A: t` / `note right of A: t` / `note over A,B: t`. */
const RE_NOTE = /^[Nn]ote\s+(left of|right of|over)\s+([^:]+):\s*(.*)$/;

/** Block openers whose first word starts a frame. */
const OPEN_BLOCKS = new Set(['loop', 'opt', 'alt', 'par', 'critical', 'break', 'rect']);

/** The words that start a statement this reader reads by its first word. */
const STATEMENT_WORDS = new Set([...OPEN_BLOCKS, 'participant', 'actor', 'create', 'destroy', 'activate',
  'deactivate', 'else', 'and', 'option', 'end', 'autonumber']);

/** A `;` that ends an entity code (`#59;`, `#quot;`) is part of the text. */
const RE_SEPARATOR = /#[A-Za-z0-9]+;|;/g;

/**
 * Statements Mermaid reads after a `;` that this reader passes over: a
 * title and the accessible title and description.
 */
const RE_IGNORED_STATEMENT = /^(?:title\s|accTitle\s*:|accDescr\s*[:{])/;

/**
 * One line's statements. Mermaid ends a statement at `;` (`A->>B: hi;
 * B->>A: yo` is two messages, and `A->>B: hi;` one message `hi`; a message
 * writes the character as `#59;`), so a line splits at every `;` outside an
 * entity code where each piece that is not blank reads as a statement. A
 * message, note, block or participant line whose pieces do not all read so
 * is refused, as Mermaid refuses it (`A->>B: a;b`), where its text kept the
 * `;`; any other line is one statement, as before.
 * @param {string} line - trimmed
 * @param {number} lineNo the line's number, for a refusal
 * @returns {string[]}
 */
export function sequenceStatements(line, lineNo) {
  if (line.indexOf(';') === -1) return [line];
  const pieces = [];
  let start = 0;
  for (const m of line.matchAll(RE_SEPARATOR)) {
    if (m[0] !== ';') continue;
    pieces.push(line.slice(start, m.index).trim());
    start = /** @type {number} */ (m.index) + 1;
  }
  pieces.push(line.slice(start).trim());
  const statements = pieces.filter((piece) => piece !== '');
  const unread = statements.findIndex((piece) => !readsAsStatement(piece) && !RE_IGNORED_STATEMENT.test(piece));
  if (unread === -1) return statements;
  if (unread > 0 && readsAsStatement(statements[0])) {
    failWith('mermaid/sequence/semicolon', { rest: statements[unread] }, lineNo);
  }
  return [line];
}

/**
 * Whether one piece of a line is a statement this reader reads.
 * @param {string} piece
 * @returns {boolean}
 */
function readsAsStatement(piece) {
  return STATEMENT_WORDS.has(firstToken(piece)) || RE_NOTE.test(piece) || RE_MSG.test(piece);
}

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

  const declare = (id, label, kind, type = null) => {
    if (seen.has(id)) return;
    seen.add(id);
    const participant = seqParticipant(id, label ?? id, kind);
    if (type !== null) participant.type = type;
    participants.push(participant);
  };

  /**
   * Read one statement into the open block.
   * @param {string} line
   * @param {number} lineNo
   */
  const read = (line, lineNo) => {
    const firstWord = firstToken(line);

    if (line === 'autonumber') { autonumber = true; return; }

    // `create participant A` declares A where the line stands
    const declaration = firstWord === 'create' ? line.slice('create'.length).trim() : line;
    const declares = firstToken(declaration);
    if (declares === 'participant' || declares === 'actor') {
      const m = RE_PARTICIPANT.exec(declaration);
      if (m !== null) {
        // `Alice@{ "type": "database", "alias": "Store" }`: the type names the
        // box (an `actor` type draws an actor), and the alias is the label
        // unless an `as` names one
        const meta = RE_PARTICIPANT_META.exec(m[2]);
        const written = meta === null ? m[2] : meta[1] + meta[3];
        const { id, label } = splitAlias(written.trim());
        const alias = meta === null ? null : RE_META_ALIAS.exec(meta[2]);
        const type = meta === null ? null : RE_META_TYPE.exec(meta[2])?.[1] ?? null;
        const kind = type === 'actor' || type === 'participant' ? type : type === null ? m[1] : 'participant';
        declare(id, label === id && alias !== null ? alias[1] : label, /** @type {any} */ (kind),
          type === null || type === 'actor' || type === 'participant' ? null : type);
      }
      return;
    }
    // `destroy A` ends A's lifeline, which this tree does not keep
    if (firstWord === 'destroy') return;

    if (firstWord === 'activate' || firstWord === 'deactivate') {
      const actor = line.slice(firstWord.length).trim();
      current.push(seqActivation(/** @type {any} */ (firstWord), actor));
      return;
    }

    if (/^[Nn]ote\s/.test(line)) {
      const m = RE_NOTE.exec(line);
      if (m !== null) {
        const actors = m[2].split(',').map((s) => s.trim()).filter(Boolean);
        // a note on an actor no line has named yet declares it, as a message does
        for (const actor of actors) declare(actor, actor, 'participant');
        current.push(seqNote(/** @type {any} */ (m[1]), actors, m[3].trim()));
      }
      return;
    }

    // Block control.
    if (OPEN_BLOCKS.has(firstWord)) {
      const label = line.slice(firstWord.length).trim();
      if (firstWord === 'rect') {
        // Background rectangle: parse-accept, statements flow to parent.
        stack.push({ block: null, parent: current, skip: true });
        return;
      }
      const block = seqBlock(/** @type {any} */ (firstWord), [{ label, statements: [] }]);
      current.push(block);
      stack.push({ block, parent: current, skip: false });
      current = block.branches[0].statements;
      return;
    }
    if (firstWord === 'else' || firstWord === 'and' || firstWord === 'option') {
      const top = stack[stack.length - 1];
      if (top === undefined || top.block === null) {
        failWith('mermaid/sequence/outside-block', { word: firstWord }, lineNo);
      }
      const branch = { label: line.slice(firstWord.length).trim(), statements: [] };
      top.block.branches.push(branch);
      current = branch.statements;
      return;
    }
    if (line === 'end') {
      const entry = stack.pop();
      if (entry === undefined) failWith('mermaid/sequence/stray-end', {}, lineNo);
      current = entry.parent;
      return;
    }

    // A message.
    const mm = RE_MSG.exec(line);
    if (mm !== null) {
      const from = mm[1].trim();
      const arrow = mm[3];
      const activation = mm[4] === '+' ? 'activate' : mm[4] === '-' ? 'deactivate' : null;
      const to = mm[6].trim();
      const text = mm[7];
      declare(from, from, 'participant');
      declare(to, to, 'participant');
      const { line: lineStyle, head } = classifyArrow(arrow);
      const message = seqMessage(from, to, text, lineStyle, head, /** @type {any} */ (activation));
      // `A()->>()B`: the central-connection marks at either end of the arrow
      if (mm[2] !== undefined || mm[5] !== undefined) {
        message.central = mm[2] === undefined ? 'to' : mm[5] === undefined ? 'from' : 'both';
      }
      current.push(message);
      return;
    }

    // Unknown directive — lenient parse-accept (title:, links, etc.).
  };

  for (let li = 0; li < lines.length; li++) {
    const whole = lines[li].trim();
    if (whole === '') continue;
    const lineNo = lineOffset + li + 1;
    for (const line of sequenceStatements(whole, lineNo)) read(line, lineNo);
  }

  return sequenceAst(participants, rootStatements, autonumber);
}

/**
 * The half-arrow heads by the marks that spell them after the line: a filled
 * (`|`) or a stick (doubled) half, on the top or the bottom of the line.
 * @type {Record<string, import('../ast.js').SeqHead>}
 */
const HALF_HEADS = {
  __proto__: null, '|\\': 'half-top', '|/': 'half-bottom', '\\\\': 'stick-top', '//': 'stick-bottom',
};
/**
 * The same heads written before the line, which point back at the sender.
 * @type {Record<string, import('../ast.js').SeqHead>}
 */
const REVERSE_HALF_HEADS = {
  __proto__: null, '/|': 'half-top-reverse', '\\|': 'half-bottom-reverse', '//': 'stick-top-reverse',
  '\\\\': 'stick-bottom-reverse',
};

/**
 * Classify a sequence arrow token into line style + head.
 * @param {string} arrow
 * @returns {{ line: 'solid'|'dotted', head: import('../ast.js').SeqHead }}
 */
function classifyArrow(arrow) {
  const run = /** @type {RegExpExecArray} */ (/-+/.exec(arrow));
  const line = run[0].length === 2 ? 'dotted' : 'solid';
  if (arrow.startsWith('<<')) return { line, head: 'both' };
  if (run.index > 0) return { line, head: REVERSE_HALF_HEADS[arrow.slice(0, run.index)] };
  const tip = arrow.slice(run[0].length);
  if (Object.hasOwn(HALF_HEADS, tip)) return { line, head: HALF_HEADS[tip] };
  const head = tip === '>>' ? 'arrow' : tip === 'x' ? 'cross' : tip === ')' ? 'point' : 'open';
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
