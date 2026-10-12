//@ts-check
/**
 * @file ER-diagram grammar → ER AST. Entity blocks
 * (`CUSTOMER { string name PK }`) and relationships
 * (`CUSTOMER ||--o{ ORDER : places`). Cardinality tokens are preserved
 * verbatim for a faithful, geometry-free model.
 */

import { collectBraceBody } from '../utils.js';

/** An entity name: a run of non-space characters, or a quoted name that may hold spaces. */
const NAME = '("[^"]*"|\\S+)';
/** `LEFT <cardl>--<cardr> RIGHT : label` (relationship). */
const RE_REL = new RegExp(`^${NAME}\\s+([|}{o]{1,2})(--|\\.\\.)([|}{o]{1,2})\\s+${NAME}\\s*:\\s*(.*)$`);

/** The quoted comment that ends an attribute line. */
const RE_COMMENT = /\s+"([^"]*)"\s*$/;

/** A line that is just one entity name. */
const RE_BARE = new RegExp(`^${NAME}$`);

/**
 * An entity name as written, without the quotes that spell it.
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
export function parseEr(lines) {
  /** @type {Map<string, { name: string, attributes: object[] }>} */
  const entityMap = new Map();
  const order = [];
  const relationships = [];

  const ensure = (name) => {
    let ent = entityMap.get(name);
    if (ent === undefined) {
      ent = { name, attributes: [] };
      entityMap.set(name, ent);
      order.push(name);
    }
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
    const rel = RE_REL.exec(line);
    if (rel !== null) {
      const left = unquote(rel[1]);
      const right = unquote(rel[5]);
      if (left === '' || right === '') continue; // an empty name names nothing
      ensure(left);
      ensure(right);
      relationships.push({
        left,
        right,
        leftCard: rel[2],
        rightCard: rel[4],
        identifying: rel[3] === '--',
        label: rel[6].trim(),
      });
      continue;
    }

    const brace = line.indexOf('{');
    if (brace !== -1) {
      const name = unquote(line.slice(0, brace).trim());
      const ent = ensure(name);
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
    if (bare !== null && unquote(bare[1]) !== '') ensure(unquote(bare[1]));
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
