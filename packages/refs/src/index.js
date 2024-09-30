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
 * 
 * @param {number} version 
 * @returns {{draft:string, schema: object[]}}
 */
export function getSchemaDraftByVersion(version) {
  if (version in schemaDrafts)
    return schemaDrafts[version];
  else
    throw new Error('Unknown reference schema version');
}

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
 * 
 * @param {string} schemaId
 * @returns {{draft:string, schema: object[]}}
 */
export function getSchemaDraftById(schemaId) {
  if (!isStringType())
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
