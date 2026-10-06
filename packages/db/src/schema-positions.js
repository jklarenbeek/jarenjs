//@ts-check
/** Schema containers used by the entity vocabulary checks and migration diff.
 * Literal values and arbitrary named members are not schema keywords. */
import { SCHEMA_VALUE_KEYWORDS, SCHEMA_MAP_KEYWORDS, SCHEMA_LIST_KEYWORDS } from '@jarenjs/core/schema';

const MAPS = new Set(SCHEMA_MAP_KEYWORDS.concat(['$defs', 'definitions', 'dependencies']));
const VALUES = new Set(SCHEMA_VALUE_KEYWORDS.concat(SCHEMA_LIST_KEYWORDS, ['additionalItems']));

/** A schema value/list (1), a named schema map (2), or ordinary data (0).
 * @param {string} keyword @returns {0 | 1 | 2} */
export function schemaPosition(keyword) {
  return MAPS.has(keyword) ? 2 : VALUES.has(keyword) ? 1 : 0;
}
