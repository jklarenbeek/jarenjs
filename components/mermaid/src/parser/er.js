//@ts-check
/**
 * @file ER-diagram grammar → ER AST. Entity blocks
 * (`CUSTOMER { string name PK }`, an alias as `p[Person]`) and
 * relationships (`CUSTOMER ||--o{ ORDER : places`, or with Mermaid's word
 * aliases: `CAR 1 to zero or more DRIVER : allows`), whose label is the one
 * word or quoted string after the `:`, the rest of the line read as the
 * statements after it, as Mermaid reads them. Cardinality tokens are
 * preserved verbatim for a faithful, geometry-free model.
 */

import { collectBraceBody } from '../utils.js';
import { failWith } from '../errors.js';

/** An entity name: a run of non-space characters, or a quoted name that may hold spaces. */
const NAME = '("[^"]*"|\\S+)';
/** One of Mermaid's cardinality symbols, which either end may write (`o{--||` reads). */
const CARD = '(\\|o|o\\||\\|\\||\\}o|o\\{|\\}\\||\\|\\{)';
/** `LEFT <cardl>--<cardr> RIGHT : label` (relationship); a missing label is caught after. */
const RE_REL = new RegExp(`^${NAME}\\s+${CARD}(--|\\.\\.)${CARD}\\s+${NAME}(?:\\s*:\\s*(.*))?$`);

/** A cardinality's word aliases, as Mermaid lists them (each is one of the four symbol pairs). */
const CARD_WORDS = 'one or zero|zero or one|one or more|one or many|many\\(1\\)|1\\+|zero or more|zero or many'
  + '|many\\(0\\)|0\\+|only one|1';
/**
 * The same relationship with every spelling Mermaid reads: the symbol pairs
 * with or without blanks around them (`A||--o{B`), the word aliases
 * (`zero or more`, `1+`, `only one`, …), and `to` / `optionally to` for
 * `--` / `..`. The names are the shortest that let the rest read, and hold
 * no cardinality character, so a long line of connectors reads in linear time.
 */
const RE_REL_ANY = new RegExp(`^${NAME.replace('\\S+', '[^\\s"|{}]+?')}\\s*(\\|o|\\|\\||\\}o|\\}\\||(?<=\\s)(?:${CARD_WORDS}))`
  + '(\\s*(?:--|\\.\\.)\\s*|\\s+(?:to|optionally\\s+to)\\s+)'
  + `(o\\||\\|\\||o\\{|\\|\\{|(?:${CARD_WORDS})(?=\\s))\\s*${NAME.replace('\\S+', '[^\\s":|{}]+')}(?:\\s*:\\s*(.*))?$`);

/** One of Mermaid's connectors, a cardinality pair around `--` or `..` (`A--` is a name). */
const RE_CONNECTOR = /(?:\|o|\|\||\}o|\}\|)(?:--|\.\.)(?:o\||\|\||o\{|\|\{)/;

/** A spaced connector of cardinality characters, Mermaid's or not (`A }}--{{ B : x`). */
const RE_LOOSE_REL = new RegExp(`^${NAME}\\s+[|}{o]{1,2}(?:--|\\.\\.)[|}{o]{1,2}\\s+${NAME}(?:\\s*:.*)?$`);

/**
 * A line of entity names Mermaid reads one by one (`A B C`, `A o--o B`):
 * each a run of word characters, `-`, `*` and `.`, or quoted, a quoted one
 * standing against the next with no blank or one (`"b"c`); a line opening
 * with a directive's word (`direction TB`) is that directive.
 */
const RE_NAMES = /^(?!(?:direction|classDef|class|style|accTitle|accDescr)\s)(?:[\w*.\u0080-\uffff-]+|"[^"]*")(?:(?:\s+|(?<=")|(?="))(?:[\w*.\u0080-\uffff-]+|"[^"]*"))+$/;

/** The quoted comment that ends an attribute line. */
const RE_COMMENT = /\s+"([^"]*)"\s*$/;

/** A line that is just one entity name, with an optional alias and `:::class`. */
const RE_BARE = /^((?:"[^"]*"|[^\s"[]+)(?:\[(?:"[^"]*"|[^\]"]*)\])?(?::::[\w-]+(?:,[\w-]+)*)?)$/;

/**
 * An entity as a line names it: `NAME`, `NAME[alias]` or `NAME["an alias"]`,
 * with an optional `:::class` this tree does not keep.
 * @param {string} written
 * @returns {{ name: string, alias: string|null }}
 */
function entityName(written) {
  const bare = written.replace(/:::[\w-]+(?:,[\w-]+)*$/, '');
  const m = /^([^[]+)\[(?:"([^"]*)"|([^\]"]*))\]$/.exec(bare);
  if (m === null) return { name: unquote(bare), alias: null };
  return { name: unquote(m[1]), alias: m[2] ?? m[3] };
}

/**
 * An entity name or a relationship label as written, without the quotes
 * that spell it.
 * @param {string} name
 * @returns {string}
 */
function unquote(name) {
  return name.length >= 2 && name.startsWith('"') && name.endsWith('"') ? name.slice(1, -1) : name;
}

/** Sticky: one word of Mermaid's ER lexer: letters, digits, `_`, `-`, `*`, `.`, any non-ASCII character, an entity code. */
const RE_ROLE_WORD = /(?:#\w+;|[\w*.-]|[\u0080-\uffff])+/y;

/** What opens a statement after a label on its line: a quoted name, or a word. */
const RE_STATEMENT_START = /^(?:"|#\w+;|[\w*.-]|[\u0080-\uffff])/;

/**
 * A relationship's label as Mermaid reads it: the one quoted string or word
 * after the `:` (`places`, `"places order"`), and the rest of the line,
 * which Mermaid reads as the statements after it (`A ||--o{ B : places
 * order` adds an entity `order`; `say"hi"` is `say` and an entity `hi`). A
 * label that opens with neither, or a rest that opens no statement
 * (`a(b)`, `a, b`, `a"b`), is refused, as Mermaid refuses it.
 * @param {string} written what follows the `:`
 * @param {string} line the line, for a refusal
 * @param {number} lineNo
 * @returns {{ label: string, rest: string }}
 */
function roleOf(written, line, lineNo) {
  const text = written.trim();
  if (text === '') return { label: '', rest: '' };
  let end;
  if (text.charCodeAt(0) === 0x22 /* " */) {
    end = text.indexOf('"', 1) + 1;
    if (end === 0) failWith('mermaid/er/relationship', { line }, lineNo);
  }
  else {
    RE_ROLE_WORD.lastIndex = 0;
    end = RE_ROLE_WORD.test(text) ? RE_ROLE_WORD.lastIndex : 0;
    if (end === 0) failWith('mermaid/er/relationship', { line }, lineNo);
  }
  const rest = text.slice(end).trim();
  if (rest !== '' && (!RE_STATEMENT_START.test(rest) || (rest.charCodeAt(0) === 0x22 && rest.indexOf('"', 1) === -1))) {
    failWith('mermaid/er/relationship', { line }, lineNo);
  }
  return { label: unquote(text.slice(0, end)), rest };
}

/**
 * @param {string[]} lines
 * @returns {object}
 */
export function parseEr(lines, lineOffset = 0) {
  /** @type {Map<string, { name: string, attributes: object[] }>} */
  const entityMap = new Map();
  const order = [];
  const relationships = [];

  const ensure = (/** @type {string} */ written) => {
    const { name, alias } = entityName(written);
    let ent = entityMap.get(name);
    if (ent === undefined) {
      ent = { name, attributes: [] };
      entityMap.set(name, ent);
      order.push(name);
    }
    if (alias !== null) ent.alias = alias;
    return ent;
  };

  // what follows a relationship's label on its line, read as the statements
  // after it, as Mermaid reads them
  /** @type {string | null} */
  let after = null;
  for (let li = 0; li < lines.length; li++) {
    let line = after ?? lines[li].trim();
    after = null;
    if (line === '' || line.startsWith('%%')) continue;

    // Relationships are matched BEFORE the '{' entity-block check: a
    // cardinality token can itself contain a brace (`CUSTOMER ||--o{ ORDER`),
    // so `indexOf('{')` alone would misread the relationship as an entity
    // block. An entity opener (`CUSTOMER {`) has no `--`/`..` connector, so
    // it can never match RE_REL.
    const spaced = RE_REL.exec(line);
    const rel = spaced ?? RE_REL_ANY.exec(line);
    // a relationship without `: label` is refused, as Mermaid refuses it
    if (rel !== null && rel[6] === undefined) failWith('mermaid/er/relationship', { line }, lineOffset + li + 1);
    if (rel !== null) {
      const left = entityName(rel[1]).name;
      const right = entityName(rel[5]).name;
      if (left === '' || right === '') continue; // an empty name names nothing
      ensure(rel[1]);
      ensure(rel[5]);
      const connector = rel[3].trim();
      const role = roleOf(rel[6], line, lineOffset + li + 1);
      relationships.push({
        left,
        right,
        leftCard: rel[2],
        rightCard: rel[4],
        identifying: connector === '--' || connector === 'to',
        label: role.label,
      });
      if (role.rest !== '') {
        after = role.rest;
        li--;
      }
      continue;
    }

    // a line holding a connector outside quotes is a relationship or
    // nothing: read as an entity block, its brace in `o{` would swallow the
    // lines after it; a connector in a quoted name or comment is text
    const masked = line.replace(/"[^"]*"/g, (quoted) => '"' + ' '.repeat(quoted.length - 2) + '"');
    const brace = masked.indexOf('{');
    const head = brace === -1 ? line : line.slice(0, brace);
    // so is one spaced like a relationship around a connector Mermaid has
    // not (`A |--| B : x`), unless it is names alone (`A o--o B`)
    if (RE_CONNECTOR.test(masked) || (RE_LOOSE_REL.test(line) && !RE_NAMES.test(line))) {
      failWith('mermaid/er/relationship', { line }, lineOffset + li + 1);
    }

    if (brace !== -1) {
      const ent = ensure(head.trim());
      let body;
      ({ body, li } = collectBraceBody(lines, li, line.slice(brace + 1)));
      for (const raw of body.split('\n')) {
        const attr = raw.trim();
        if (attr === '') continue;
        const comment = RE_COMMENT.exec(attr);
        const parts = (comment === null ? attr : attr.slice(0, comment.index)).split(/\s+/);
        entityAttr(ent, parts, comment === null ? null : comment[1]);
      }
      continue;
    }

    // a bare entity line: one name (quoted or not) and nothing else
    const bare = RE_BARE.exec(line);
    if (bare !== null && entityName(bare[1]).name !== '') ensure(bare[1]);
    // several names, each an entity, as Mermaid reads them
    else if (RE_NAMES.test(line)) {
      for (const written of line.match(/"[^"]*"|[^\s"]+/g) ?? []) if (entityName(written).name !== '') ensure(written);
    }
  }

  return { entities: order.map((n) => entityMap.get(n)), relationships };
}

/**
 * @param {{ attributes: object[] }} ent
 * @param {string[]} parts `[type, name, key…]`; keys may be comma-separated
 * @param {string | null} comment the quoted comment that ended the line, if any
 */
function entityAttr(ent, parts, comment) {
  const type = parts[0] ?? '';
  const name = parts[1] ?? '';
  const keys = parts.slice(2).flatMap((p) => p.split(',')).filter((p) => p === 'PK' || p === 'FK' || p === 'UK');
  ent.attributes.push(comment === null ? { type, name, keys } : { type, name, keys, comment });
}
