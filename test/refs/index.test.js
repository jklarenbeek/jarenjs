import { describe, it } from 'node:test';
import * as assert from '../assert.node.js';

import {
  getSchemaDraftByVersion,
  getSchemaDraftByName,
  getSchemaDraftById,
} from '@jarenjs/refs';

describe('Schema draft registry', function () {
  it('should resolve drafts by version', function () {
    assert.isTrue(getSchemaDraftByVersion(7).draft === 'http://json-schema.org/draft-07/schema');
    assert.isTrue(Array.isArray(getSchemaDraftByVersion(2020).schema));
    assert.throws(() => getSchemaDraftByVersion(5));
  });

  it('should resolve drafts by name', function () {
    assert.isTrue(getSchemaDraftByName('draft7').draft === 'http://json-schema.org/draft-07/schema');
    assert.isTrue(getSchemaDraftByName('2019-09').draft === 'https://json-schema.org/draft/2019-09/schema');
    assert.throws(() => getSchemaDraftByName('draft5'));
  });

  it('should resolve drafts by id', function () {
    assert.isTrue(getSchemaDraftById('http://json-schema.org/draft-07/schema').draft
      === 'http://json-schema.org/draft-07/schema');
    assert.isTrue(getSchemaDraftById('HTTPS://JSON-SCHEMA.ORG/DRAFT/2020-12/SCHEMA').draft
      === 'https://json-schema.org/draft/2020-12/schema', 'id lookup is case-insensitive');
    assert.throws(() => getSchemaDraftById('https://example.com/no-such-draft'));
    assert.throws(() => getSchemaDraftById(42), 'non-string ids are rejected');
  });
});
