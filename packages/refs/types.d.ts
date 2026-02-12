/**
 * JarenJS Refs - TypeScript Type Definitions
 * JSON Schema Draft Specifications
 */

import { JSONSchema } from '@jarenjs/validate';

/**
 * Schema draft information
 */
export interface SchemaDraftInfo {
  /** The draft URI (e.g., 'http://json-schema.org/draft-07/schema') */
  draft: string;
  /** Array of schema definitions */
  schema: JSONSchema[];
}

/**
 * Gets schema draft info by version number
 * @param version - 6, 7, 2019, or 2020
 * @returns Schema draft information
 * @throws Error if version is unknown
 */
export function getSchemaDraftByVersion(version: 6 | 7 | 2019 | 2020): SchemaDraftInfo;

/**
 * Gets schema draft info by name
 * @param name - Draft name variant (e.g., 'draft-07', '2019-09', 'draft2020-12')
 * @returns Schema draft information
 * @throws Error if name is unknown
 */
export function getSchemaDraftByName(
  name: '6' | 'draft6' | 'draft-6' | 'draft06' | 'draft-07' |
        '7' | 'draft7' | 'draft-7' | 'draft07' | 'draft-07' |
        'draft2019' | 'draft-2019' | 'draft2019-09' | '2019' | '2019-09' |
        'draft2020' | 'draft-2020' | 'draft2020-12' | '2020' | '2020-12'
): SchemaDraftInfo;

/**
 * Gets schema draft info by schema $id
 * @param schemaId - The schema $id URI
 * @returns Schema draft information
 * @throws Error if schema id is not found
 */
export function getSchemaDraftById(schemaId: string): SchemaDraftInfo;
