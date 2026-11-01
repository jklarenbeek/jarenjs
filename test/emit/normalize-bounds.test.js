import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compileEmitModel } from '@jarenjs/emit';

/** A schema nested `levels` objects deep through `properties`, a default at the bottom. */
function nested(levels) {
  let schema = { type: 'object', properties: { leaf: { type: 'string', default: 'x' } } };
  for (let i = 1; i < levels; i++) schema = { type: 'object', properties: { a: schema } };
  return schema;
}

describe('compileEmitModel: the normalizer bounds in its normalize options', () => {
  it('refuses a schema deeper than the default bound when it reads defaults', () => {
    assert.throws(() => compileEmitModel(nested(200), { normalize: { useDefaults: true } }), { code: 'JK0017' });
  });

  it('reads defaults past the default bound where normalize raises maxSchemaDepth, as compileNormalizer does', () => {
    const model = compileEmitModel(nested(200), { normalize: { useDefaults: true, maxSchemaDepth: 256 } });
    assert.equal(typeof model, 'object');
    assert.throws(() => compileEmitModel(nested(300), { normalize: { useDefaults: true, maxSchemaDepth: 256 } }), { code: 'JK0017' });
  });

  it('refuses a bound compileNormalizer refuses', () => {
    assert.throws(() => compileEmitModel(nested(2), { normalize: { useDefaults: true, maxSchemaDepth: 0 } }), { code: 'JK0002' });
    assert.throws(() => compileEmitModel(nested(2), { normalize: { useDefaults: true, maxReferenceDepth: 1.5 } }), { code: 'JK0002' });
  });
});
