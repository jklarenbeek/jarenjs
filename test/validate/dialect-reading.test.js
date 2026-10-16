//@ts-check
/**
 * @file Which draft a schema is read under, and which vocabularies its
 * meta-schema switches on. A `$schema` names a draft by its exact URI (the
 * official dialect and vocabulary meta-schemas, and the Jaren dialect), or
 * through the meta-schema it identifies when the validator holds one: that
 * meta-schema's own `$schema` is read the same way. A URI that merely
 * contains a draft's spelling names nothing, and a `$schema` that names no
 * draft is read as draft-07. A `$vocabulary` entry switches a vocabulary on
 * only by its exact URI.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { JarenValidator, detectSchemaDraft } from '@jarenjs/validate';
import { compileAsync } from '@jarenjs/validate/load';
import { compileNormalizer } from '@jarenjs/validate/normalize';
import { getSchemaDraftByName } from '@jarenjs/refs';
import { stringFormats } from '@jarenjs/formats';

const D2020 = 'https://json-schema.org/draft/2020-12/schema';
const draft2020 = getSchemaDraftByName('draft2020-12');

/** A validator holding the 2020-12 meta-schemas, then `held`, in order. @param {object[]} held */
function holding(...held) {
  const validator = new JarenValidator().addMetaSchema(draft2020.schema, draft2020.draft);
  for (const schema of held) validator.addSchema(schema);
  return validator;
}

/** A dialect that extends 2020-12 under a URI of its own. @param {string} id @param {string} [base] */
function dialect(id, base = D2020) {
  return { $id: id, $schema: base, $dynamicAnchor: 'meta', allOf: [{ $ref: D2020 }] };
}

/** `prefixItems` asserts from 2020-12 on and is an unknown keyword under draft-07. */
const TUPLE = { prefixItems: [{ type: 'string' }] };

describe('a $schema names a draft by its exact URI', () => {
  it('reads every published dialect and vocabulary meta-schema URI as before', () => {
    const named = {
      6: ['http://json-schema.org/draft-06/schema#', 'http://json-schema.org/draft-06/schema', 'https://json-schema.org/draft-06/schema#'],
      7: ['http://json-schema.org/draft-07/schema#', 'http://json-schema.org/draft-07/schema', 'https://json-schema.org/draft-07/schema#'],
      2019: ['https://json-schema.org/draft/2019-09/schema', 'https://json-schema.org/draft/2019-09/schema#', 'http://json-schema.org/draft/2019-09/schema',
        ...['core', 'applicator', 'validation', 'meta-data', 'format', 'content'].map((name) => `https://json-schema.org/draft/2019-09/meta/${name}`)],
      2020: ['https://json-schema.org/draft/2020-12/schema', 'https://json-schema.org/draft/2020-12/schema#', 'http://json-schema.org/draft/2020-12/schema',
        ...['core', 'applicator', 'unevaluated', 'validation', 'meta-data', 'format-annotation', 'format-assertion', 'content']
          .flatMap((name) => [`https://json-schema.org/draft/2020-12/meta/${name}`, `https://json-schema.org/draft/next/meta/${name}`]),
        'https://json-schema.org/draft/next/schema', 'https://json-schema.org/draft/next/schema#',
        'https://jarenjs.dev/schemas/2020-12/schema', 'https://jarenjs.dev/schemas/2020-12/meta/query'],
    };
    for (const [draft, uris] of Object.entries(named))
      for (const uri of uris) assert.equal(detectSchemaDraft({ $schema: uri }), Number(draft), uri);
  });

  it('reads a URI that only contains a draft spelling as draft-07, the reading of every unknown dialect', () => {
    for (const uri of [
      'https://example.com/2020-12/my-dialect', 'https://example.com/2019-09-ext', 'https://example.com/draft/next/schema',
      'https://example.com/draft-06/schema', 'https://json-schema.org/draft/06/schema', 'https://json-schema.org/draft/2020-12/schema/extra',
      'https://json-schema.org/draft/2020-12/schema#/$defs/x', 'http://json-schema.org/draft-04/schema#', 'http://json-schema.org/schema#', '',
    ]) assert.equal(detectSchemaDraft({ $schema: uri }), 7, uri);
    assert.deepEqual(['https://example.com/2020-12/my-dialect', 'https://example.com/2019-09-ext']
      .map((uri) => holding().compile({ $schema: uri, ...TUPLE })([1])), [true, true]);
    // an unknown dialect reads both dynamic references; draft-07 by name reads neither
    const recursive = (uri, keyword) => new JarenValidator()
      .compile({ $schema: uri, type: 'object', properties: { a: { [keyword]: '#' } } })({ a: 1 });
    assert.deepEqual(['$recursiveRef', '$dynamicRef'].flatMap((keyword) => [
      recursive('https://json-schema.org/draft/07/schema', keyword),
      recursive('https://example.com/draft-07-x', keyword),
      recursive('http://json-schema.org/draft-07/schema#', keyword),
    ]), [false, false, true, false, false, true]);
  });

  it('reads the unregistered Jaren dialect as 2020-12: a $ref applies its siblings, prefixItems asserts', () => {
    const jaren = 'https://jarenjs.dev/schemas/2020-12/schema';
    const validate = new JarenValidator().compile({ $schema: jaren, $defs: { s: { type: 'string' } }, $ref: '#/$defs/s', minLength: 3 });
    assert.deepEqual([validate('x'), validate('xyz'), validate(1)], [false, true, false]);
    assert.equal(new JarenValidator().compile({ $schema: jaren, ...TUPLE })([1]), false);
  });
});

describe('a $schema naming a meta-schema the validator holds is read by that meta-schema\'s own $schema', () => {
  const MINE = 'https://example.com/my-dialect';

  it('reads a dialect that extends 2020-12 under a URI of its own as 2020-12', () => {
    const validator = holding(dialect(MINE));
    assert.equal(detectSchemaDraft({ $schema: MINE }, { get: (key) => validator.getSchema(key) }), 2020);
    assert.deepEqual([[1], ['a']].map(validator.compile({ $schema: MINE, ...TUPLE })), [false, true]);
    // a $ref applies its siblings (draft-07 would ignore minLength)
    assert.equal(validator.compile({ $schema: MINE, $defs: { s: { type: 'string' } }, $ref: '#/$defs/s', minLength: 3 })('x'), false);
    // the same through the published bundle form of addMetaSchema
    const bundled = new JarenValidator().addMetaSchema([dialect(MINE), ...draft2020.schema]);
    assert.equal(bundled.compile({ $schema: MINE, ...TUPLE })([1]), false);
  });

  it('reads a held dialect by its meta-schema even when its URI spells another draft', () => {
    const SPELLS_07 = 'https://example.com/draft-07/extended';
    assert.equal(holding(dialect(SPELLS_07)).compile({ $schema: SPELLS_07, ...TUPLE })([1]), false);
    const SPELLS_2020 = 'https://example.com/2020-12/legacy';
    const legacy = { $id: SPELLS_2020, $schema: 'http://json-schema.org/draft-07/schema#' };
    // read as draft-07, its meta-schema's draft: prefixItems is not a keyword there
    assert.equal(holding(legacy).compile({ $schema: SPELLS_2020, ...TUPLE })([1]), true);
  });

  it('follows a chain of dialects, and stops on a loop as on an unknown dialect', () => {
    const outer = 'https://example.com/outer';
    assert.equal(holding(dialect(MINE), dialect(outer, MINE)).compile({ $schema: outer, ...TUPLE })([1]), false);
    const self = 'https://example.com/self';
    const a = 'https://example.com/a';
    const b = 'https://example.com/b';
    const validator = holding({ $id: self, $schema: self }, { $id: a, $schema: b }, { $id: b, $schema: a });
    for (const uri of [self, a, b]) {
      assert.equal(detectSchemaDraft({ $schema: uri }, { get: (key) => validator.getSchema(key) }), 7, uri);
      assert.equal(validator.compile({ $schema: uri, ...TUPLE })([1]), true, uri);
    }
  });

  it('reads a schema the same whether it was registered before or after its dialect, or compiled beside it', () => {
    for (const uri of [MINE, 'https://example.com/2020-12/my-dialect']) {
      const S = { $id: 'https://example.com/s', $schema: uri, $defs: { t: TUPLE }, $ref: '#/$defs/t', type: 'array' };
      const after = holding(dialect(uri), S);
      const before = holding(S, dialect(uri));
      const answers = [
        after.compile({ $ref: 'https://example.com/s' })([1]),
        before.compile({ $ref: 'https://example.com/s' })([1]),
        before.compile(/** @type {object} */ (before.getSchema('https://example.com/s')))([1]),
        holding().compile({ $schema: uri, $defs: { t: TUPLE }, $ref: '#/$defs/t' }, [dialect(uri)])([1]),
      ];
      assert.deepEqual(answers, [false, false, false, false], uri);
      // a dynamic reference is read in the dialect's draft too: 2020-12 has no $recursiveRef
      const R = { $id: 'https://example.com/rec', $schema: uri, type: 'object', properties: { a: { $recursiveRef: '#' } } };
      assert.deepEqual([holding(dialect(uri), R), holding(R, dialect(uri))]
        .map((validator) => validator.compile({ $ref: 'https://example.com/rec' })({ a: 1 })), [true, true], uri);
    }
  });

  it('resolves a $ref beside an $id by the dialect\'s draft, against the $id', async () => {
    const S = { $id: 'https://example.com/root', $schema: MINE, $defs: { a: { $id: 'sub/a.json', $ref: 'target.json' } }, $ref: 'sub/a.json' };
    const target = { $id: 'https://example.com/sub/target.json', type: 'string' };
    const validate = holding(dialect(MINE), target, S).compile({ $ref: 'https://example.com/root' });
    assert.deepEqual([validate('x'), validate(1)], [true, false]);
    // compileAsync asks only for what 2020-12 reads, the dialect held or loaded first
    for (const held of [true, false]) {
      /** @type {string[]} */
      const asked = [];
      const docs = { 'https://example.com/sub/target.json': { type: 'string' }, ...(held ? {} : { [MINE]: dialect(MINE) }) };
      const loaded = await compileAsync(held ? holding(dialect(MINE)) : holding(), { ...S, $id: 'https://example.com/root' }, {
        loadSchema: async (uri) => {
          asked.push(uri);
          if (uri in docs) return docs[uri];
          throw new Error(`no document at ${uri}`);
        },
      });
      assert.deepEqual([loaded('x'), loaded(1), asked], [true, false,
        held ? ['https://example.com/sub/target.json'] : [MINE, 'https://example.com/sub/target.json']]);
    }
  });

  it('reads a document compileAsync loads that declares no draft under the loaded dialect\'s draft', async () => {
    const docs = {
      [MINE]: dialect(MINE),
      'https://example.com/lib.json': { $defs: { a: { $id: 'sub/a.json', $ref: 't.json' } }, $ref: '#/$defs/a' },
      'https://example.com/sub/t.json': { type: 'string' },
    };
    /** @type {string[]} */
    const asked = [];
    const validate = await compileAsync(holding(), { $id: 'https://example.com/root', $schema: MINE, $ref: 'lib.json' }, {
      loadSchema: async (uri) => {
        asked.push(uri);
        if (uri in docs) return docs[uri];
        throw new Error(`no document at ${uri}`);
      },
    });
    assert.deepEqual([validate('x'), validate(1), asked], [true, false, Object.keys(docs)]);
  });

  it('decides a $ref beside an $id when a schema is registered: before its dialect, by draft-07', () => {
    // The walk that registers the schema reads it as draft-07, where the $ref
    // resolves against the enclosing base: that target is not held, and the
    // compile that reads it is refused, naming it.
    const S = { $id: 'https://example.com/root', $schema: MINE, $defs: { a: { $id: 'sub/a.json', $ref: 'target.json' } }, $ref: 'sub/a.json' };
    const target = { $id: 'https://example.com/sub/target.json', type: 'string' };
    assert.throws(() => holding(S, target, dialect(MINE)).compile({ $ref: 'https://example.com/root' }),
      { name: 'SchemaCompileError', code: 'JK0008', message: /'https:\/\/example\.com\/target\.json#'/ });
  });

  it('reads a dialect compileAsync loads', async () => {
    const DOC = 'https://example.com/loaded-dialect';
    const validate = await compileAsync(holding(), { $schema: DOC, ...TUPLE }, {
      loadSchema: async (uri) => {
        if (uri === DOC) return dialect(DOC);
        throw new Error(`no document at ${uri}`);
      },
    });
    assert.deepEqual([validate([1]), validate(['a'])], [false, true]);
  });

  it('leaves the normalizer, which holds no meta-schemas, reading only names', () => {
    const shape = { $defs: { s: { type: 'object' } }, $ref: '#/$defs/s', properties: { a: { default: 1 } } };
    const fill = (uri) => compileNormalizer({ $schema: uri, ...shape }, { useDefaults: true })({});
    // 2020-12 by name: the $ref applies its siblings, so their default fills
    assert.deepEqual(fill('https://jarenjs.dev/schemas/2020-12/schema'), { a: 1 });
    // an unknown dialect is draft-07 there: the $ref's siblings are ignored
    assert.deepEqual(fill('https://example.com/2020-12/my-dialect'), {});
  });
});

describe('a $vocabulary entry switches a vocabulary on by its exact URI', () => {
  /** A meta-schema extending 2020-12 that declares `vocabulary`. @param {string} id @param {Record<string, boolean>} vocabulary */
  const meta = (id, vocabulary) => ({ ...dialect(id), $vocabulary: {
    'https://json-schema.org/draft/2020-12/vocab/core': true,
    'https://json-schema.org/draft/2020-12/vocab/applicator': true,
    ...vocabulary,
  } });

  it('asserts validation keywords only under the validation vocabulary itself', () => {
    const answer = (vocabulary) => {
      const id = 'https://example.com/vocab-meta';
      return holding(meta(id, vocabulary)).compile({ $schema: id, type: 'string' })(12);
    };
    assert.equal(answer({ 'https://example.com/vocab/validation-extras': true }), true);
    assert.equal(answer({ 'https://example.com/v2/vocab/validation': true }), true);
    assert.equal(answer({}), true);
    assert.equal(answer({ 'https://json-schema.org/draft/2020-12/vocab/validation': true }), false);
    // `false` lets a validator that does not implement it go on: this one does
    assert.equal(answer({ 'https://json-schema.org/draft/2020-12/vocab/validation': false }), false);
    assert.equal(answer({ 'http://json-schema.org/draft/2020-12/vocab/validation#': true }), false);
  });

  it('asserts format only under the format-assertion vocabulary itself', () => {
    const answer = (vocabulary) => {
      const id = 'https://example.com/format-meta';
      const validator = holding(meta(id, { 'https://json-schema.org/draft/2020-12/vocab/validation': true, ...vocabulary }))
        .addFormats(stringFormats);
      return validator.compile({ $schema: id, format: 'email' })('not an email');
    };
    assert.equal(answer({ 'https://example.com/vocab/format-assertion-lite': true }), true);
    assert.equal(answer({}), true);
    assert.equal(answer({ 'https://json-schema.org/draft/2020-12/vocab/format-assertion': true }), false);
    assert.equal(answer({ 'https://json-schema.org/draft/2020-12/vocab/format-assertion': false }), false);
  });
});
