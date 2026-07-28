//@ts-check
/**
 * @file ER-diagram grammar → ER AST. Entity blocks
 * (`CUSTOMER { string name PK }`) and relationships
 * (`CUSTOMER ||--o{ ORDER : places`). Cardinality tokens are preserved
 * verbatim for a faithful, geometry-free model.
 */

import { collectBraceBody } from '../utils.js';

/** `LEFT <cardl>--<cardr> RIGHT : label` (relationship). */
const RE_REL = /^(\S+)\s+([|}{o]{1,2})(--|\.\.)([|}{o]{1,2})\s+(\S+)\s*:\s*(.*)$/;

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
      ensure(rel[1]);
      ensure(rel[5]);
      relationships.push({
        left: rel[1],
        right: rel[5],
        leftCard: rel[2],
        rightCard: rel[4],
        identifying: rel[3] === '--',
        label: rel[6].trim(),
      });
      continue;
    }

    const brace = line.indexOf('{');
    if (brace !== -1) {
      const name = line.slice(0, brace).trim();
      const ent = ensure(name);
      let body;
      ({ body, li } = collectBraceBody(lines, li, line.slice(brace + 1)));
      for (const raw of body.split('\n')) {
        const attr = raw.trim();
        if (attr === '') continue;
        const parts = attr.split(/\s+/);
        entityAttr(ent, parts);
      }
      continue;
    }
  }

  return { entities: order.map((n) => entityMap.get(n)), relationships };
}

/**
 * @param {{ attributes: object[] }} ent
 * @param {string[]} parts `[type, name, key?, "comment"?]`
 */
function entityAttr(ent, parts) {
  const type = parts[0] ?? '';
  const name = parts[1] ?? '';
  const keys = parts.slice(2).filter((p) => p === 'PK' || p === 'FK' || p === 'UK');
  ent.attributes.push({ type, name, keys });
}
