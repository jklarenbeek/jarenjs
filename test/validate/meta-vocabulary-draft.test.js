//@ts-check
/**
 * @file A meta-schema's `$vocabulary` is read only where the meta-schema
 * itself reads that keyword: from draft 2019-09 on, or under no `$schema`
 * of its own, where every keyword is read. Under draft-07, draft-06,
 * draft-04 and a dialect read as draft-07 the member is an unknown keyword
 * and switches no vocabulary off: a schema of such a dialect validates,
 * for the validator and for a reader handed the dialect alike.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JarenValidator } from '@jarenjs/validate';
import { withoutUnreadVocabularies } from '@jarenjs/validate/normalize';

const META = 'https://v.test/meta';
const VOCAB = 'https://json-schema.org/draft/2020-12/vocab/';
/** Only the core vocabulary: where it is read, `type` asserts nothing. */
const CORE = { [`${VOCAB}core`]: true };

/**
 * How a schema of the dialect `meta` defines reads `type: 'string'`: the
 * validator's answers for `1` and `'x'`, and whether a reader handed the
 * dialect keeps `type`.
 * @param {Record<string, any>} meta
 */
function reading(meta) {
  const validate = new JarenValidator().addMetaSchema({ $id: META, ...meta }).compile({ $schema: META, type: 'string' });
  const kept = withoutUnreadVocabularies({ $schema: META, type: 'string' }, { dialects: new JarenValidator().addMetaSchema({ $id: META, ...meta }) });
  return [validate(1), validate('x'), 'type' in /** @type {object} */ (kept)];
}

describe('a meta-schema\'s $vocabulary is read where the meta-schema reads the keyword', () => {
  it('a meta-schema of a draft before 2019-09 switches no vocabulary off (a core-only $vocabulary turned validation off)', () => {
    for (const draft of ['http://json-schema.org/draft-07/schema#', 'http://json-schema.org/draft-06/schema#', 'http://json-schema.org/draft-04/schema#'])
      assert.deepEqual(reading({ $schema: draft, $vocabulary: CORE }), [false, true, true], draft);
    // a dialect this package does not know is read as draft-07
    assert.deepEqual(reading({ $schema: 'https://v.test/other', $vocabulary: CORE }), [false, true, true]);
  });

  it('a 2019-09 or 2020-12 meta-schema, and one without a $schema of its own, still switch it off', () => {
    for (const draft of ['https://json-schema.org/draft/2019-09/schema', 'https://json-schema.org/draft/2020-12/schema'])
      assert.deepEqual(reading({ $schema: draft, $vocabulary: CORE }), [true, true, false], draft);
    assert.deepEqual(reading({ $vocabulary: CORE }), [true, true, false]);
  });

  it('a meta-schema without a $schema of its own that requires an unknown vocabulary still answers', () => {
    const validate = new JarenValidator()
      .addMetaSchema({ $id: META, $vocabulary: { ...CORE, [`${VOCAB}validation`]: true, 'https://v.test/vocab/unknown': true } })
      .compile({ $schema: META, type: 'string' });
    assert.deepEqual([validate(1), validate('x')], [false, true]);
  });
});
