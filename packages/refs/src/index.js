//@ts-check
import { isStringType } from '@jarenjs/core';

import {
  _draft6,
  _draft7
} from './index.import.no-lint.js';

import _draft2019 from './json-schema-2019-09/index.js';
import _draft2020 from './json-schema-2020-12/index.js';

const schemaDrafts = {
  6: { draft: 'http://json-schema.org/draft-06/schema', schema: [_draft6] },
  7: { draft: 'http://json-schema.org/draft-07/schema', schema: [_draft7] },
  2019: { draft: 'https://json-schema.org/draft/2019-09/schema', schema: _draft2019 },
  2020: { draft: 'https://json-schema.org/draft/2020-12/schema', schema: _draft2020 },
};

/**
 * A JSON Schema draft specification bundle: the draft's canonical URI and
 * the meta-schema document(s) that define it. For draft 2019-09 and
 * 2020-12 the `schema` array holds the main meta-schema followed by its
 * vocabulary meta-schemas; for draft-06/07 it holds the single meta-schema.
 * @typedef {Object} SchemaDraftInfo
 * @property {string} draft - The draft's canonical URI (e.g. 'http://json-schema.org/draft-07/schema')
 * @property {object[]} schema - The meta-schema document(s) of the draft
 */

/**
 * Gets a schema draft bundle by version number.
 * @param {6 | 7 | 2019 | 2020} version - The draft version
 * @returns {SchemaDraftInfo} The draft URI and its meta-schema document(s)
 * @throws {Error} When the version is unknown
 */
export function getSchemaDraftByVersion(version) {
  if (version in schemaDrafts)
    return schemaDrafts[version];
  else
    throw new Error('Unknown reference schema version');
}

/**
 * Gets a schema draft bundle by name. Accepts the common spellings of
 * each draft name (e.g. 'draft-07', '2019-09', 'draft2020-12').
 * @param {'6'|'draft6'|'draft-6'|'draft06'|'draft-06'
 *   |'7'|'draft7'|'draft-7'|'draft07'|'draft-07'
 *   |'draft2019'|'draft-2019'|'draft2019-09'|'2019'|'2019-09'
 *   |'draft2020'|'draft-2020'|'draft2020-12'|'2020'|'2020-12'} name - The draft name variant
 * @returns {SchemaDraftInfo} The draft URI and its meta-schema document(s)
 * @throws {Error} When the name is unknown
 */
export function getSchemaDraftByName(name) {
  switch (name) {
    case '6': case 'draft6': case 'draft-6': case 'draft06': case 'draft-06':
      return getSchemaDraftByVersion(6);
    case '7': case 'draft7': case 'draft-7': case 'draft07': case 'draft-07':
      return getSchemaDraftByVersion(7);
    case 'draft2019': case 'draft-2019': case 'draft2019-09': case '2019': case '2019-09':
      return getSchemaDraftByVersion(2019);
    case 'draft2020': case 'draft-2020': case 'draft2020-12': case '2020': case '2020-12':
      return getSchemaDraftByVersion(2020);
    default:
      throw new Error(`Unknown reference schema name: '${name}'`);
  }
}

/**
 * Gets a schema draft bundle by its canonical $id URI (case-insensitive).
 * @param {string} schemaId - The schema $id URI
 * @returns {SchemaDraftInfo} The draft URI and its meta-schema document(s)
 * @throws {Error} When the schema id is not a string or not found
 */
export function getSchemaDraftById(schemaId) {
  if (!isStringType(schemaId))
    throw new Error('The schema id must be of type string');

  const $id = schemaId.toLowerCase();
  // eslint-disable-next-line no-unused-vars
  for (const [_, item] of Object.entries(schemaDrafts)) {
    const draft = item.draft;
    if (draft.toLowerCase() === $id)
      return item;
  }

  throw new Error(`Schema draft with id '${schemaId}' does not exists`);
}
