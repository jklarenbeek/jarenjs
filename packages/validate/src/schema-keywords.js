//@ts-check

import { SCHEMA_VALUE_KEYWORDS, SCHEMA_MAP_KEYWORDS, SCHEMA_LIST_KEYWORDS } from '@jarenjs/core/schema';

/** Reference walks accept legacy additionalItems, but do not register contentSchema. */
const REFERENCE_VALUES = /* @__PURE__ */ SCHEMA_VALUE_KEYWORDS.filter((key) => key !== 'contentSchema');
export const TRAVERSE_SCHEMA_OBJECTS = /* @__PURE__ */ REFERENCE_VALUES.concat(SCHEMA_LIST_KEYWORDS, ['additionalItems']);

/** Reference registration also visits definitions and its compatibility containers. */
export const TRAVERSE_SCHEMA_MAPS = /* @__PURE__ */ SCHEMA_MAP_KEYWORDS
  .concat(['dependencies', 'dependentRequired', 'definitions', '$defs', 'components']);
