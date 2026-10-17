//@ts-check
/**
 * @file ER-diagram grammar → ER AST. Entity blocks
 * (`CUSTOMER { string name PK }`, an alias as `p[Person]`) and
 * relationships (`CUSTOMER ||--o{ ORDER : places`, or with Mermaid's word
 * aliases: `CAR 1 to zero or more DRIVER : allows`). Cardinality tokens are
 * preserved verbatim for a faithful, geometry-free model.
 */

import { collectBraceBody } from '../utils.js';
import { fail } from '../errors.js';

/** An entity name: a run of non-space characters, or a quoted name that may hold spaces. */
const NAME = '("[^"]*"|\\S+)';
/** `LEFT <cardl>--<cardr> RIGHT : label` (relationship); the label may be absent. */
const RE_REL = new RegExp(`^${NAME}\\s+([|}{o]{1,2})(--|\\.\\.)([|}{o]{1,2})\\s+${NAME}(?:\\s*:\\s*(.*))?$`);

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

  for (let li = 0; li < lines.length; li++) {
    let line = lines[li].trim();
    if (line === '' || line.startsWith('%%')) continue;

    // Relationships are matched BEFORE the '{' entity-block check: a
    // cardinality token can itself contain a brace (`CUSTOMER ||--o{ ORDER`),
    // so `indexOf('{')` alone would misread the relationship as an entity
    // block. An entity opener (`CUSTOMER {`) has no `--`/`..` connector, so
    // it can never match RE_REL.
    const spaced = RE_REL.exec(line);
    const rel = spaced ?? RE_REL_ANY.exec(line);
    if (rel !== null) {
      const left = entityName(rel[1]).name;
      const right = entityName(rel[5]).name;
      if (left === '' || right === '') continue; // an empty name names nothing
      ensure(rel[1]);
      ensure(rel[5]);
      const connector = rel[3].trim();
      relationships.push({
        left,
        right,
        leftCard: rel[2],
        rightCard: rel[4],
        identifying: connector === '--' || connector === 'to',
        label: unquote((rel[6] ?? '').trim()),
      });
      continue;
    }

    // a line holding a connector outside quotes is a relationship or
    // nothing: read as an entity block, its brace in `o{` would swallow the
    // lines after it; a connector in a quoted name or comment is text
    const masked = line.replace(/"[^"]*"/g, (quoted) => '"' + ' '.repeat(quoted.length - 2) + '"');
    const brace = masked.indexOf('{');
    const head = brace === -1 ? line : line.slice(0, brace);
    if (RE_CONNECTOR.test(masked)) {
      fail(`'${line}' is no relationship: LEFT <cardinality>--<cardinality> RIGHT : label`, lineOffset + li + 1);
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
