import { SCHEMA_VALUE_KEYWORDS, SCHEMA_MAP_KEYWORDS, SCHEMA_LIST_KEYWORDS } from '@jarenjs/core/schema';

const schemaValues: readonly string[] = SCHEMA_VALUE_KEYWORDS;
const schemaMaps: readonly string[] = SCHEMA_MAP_KEYWORDS;
const schemaLists: readonly string[] = SCHEMA_LIST_KEYWORDS;
const referenceMaps: string[] = schemaMaps.concat(['$defs']);
void [schemaValues, schemaMaps, schemaLists, referenceMaps];
// @ts-expect-error shared ordered vocabulary is immutable
const mutableValues: string[] = SCHEMA_VALUE_KEYWORDS;
// @ts-expect-error callers compose a copy instead of mutating shared map vocabulary
SCHEMA_MAP_KEYWORDS.push('$defs');
// @ts-expect-error list keyword positions cannot be reordered in place
SCHEMA_LIST_KEYWORDS[0] = 'allOf';
void mutableValues;
