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

  it('reads every other meta-schema json-schema.org publishes for a draft as that draft', () => {
    // Each URI is the `$id` of a meta-schema json-schema.org serves (the
    // draft-next output schema: the JSON Schema Test Suite's copy).
    const published = {
      6: ['http://json-schema.org/draft-06/hyper-schema#', 'http://json-schema.org/draft-06/links#'],
      7: ['http://json-schema.org/draft-07/hyper-schema#', 'http://json-schema.org/draft-07/links#', 'http://json-schema.org/draft-07/hyper-schema-output'],
      2019: ['hyper-schema', 'links', 'meta/hyper-schema', 'output/schema', 'output/hyper-schema']
        .map((name) => `https://json-schema.org/draft/2019-09/${name}`),
      2020: [...['hyper-schema', 'links', 'meta/hyper-schema', 'output/schema'].map((name) => `https://json-schema.org/draft/2020-12/${name}`),
        'https://json-schema.org/draft/next/output/schema'],
    };
    for (const [draft, uris] of Object.entries(published))
      for (const uri of uris) {
        const bare = uri.replace(/#$/, '').replace(/^https?:/, '');
        for (const spelling of [`http:${bare}`, `https:${bare}`, `http:${bare}#`, `https:${bare}#`])
          assert.equal(detectSchemaDraft({ $schema: spelling }), Number(draft), spelling);
      }
    const HYPER_2020 = 'https://json-schema.org/draft/2020-12/hyper-schema';
    const HYPER_2019 = 'https://json-schema.org/draft/2019-09/hyper-schema';
    assert.equal(new JarenValidator().compile({ $schema: HYPER_2020, ...TUPLE })([1]), false);
    const dependent = (uri) => new JarenValidator().compile({ $schema: uri, dependentRequired: { a: ['b'] } })({ a: 1 });
    assert.deepEqual([dependent(HYPER_2019), dependent(HYPER_2020)], [false, false]);
    // a draft-06 or draft-07 meta-schema is a known draft: neither dynamic reference applies anything there
    const recursive = (uri, keyword) => new JarenValidator()
      .compile({ $schema: uri, type: 'object', properties: { a: { [keyword]: '#' } } })({ a: 1 });
    assert.deepEqual([...published[6], ...published[7]].flatMap((uri) => [recursive(uri, '$recursiveRef'), recursive(uri, '$dynamicRef')]),
      Array(10).fill(true));
  });

  it('reads the scheme and host of a dialect URI in any case, its path only as spelled', () => {
    for (const [uri, draft] of [
      ['HTTPS://json-schema.org/draft/2020-12/schema', 2020], ['https://JSON-SCHEMA.org/draft/2020-12/schema', 2020],
      ['Https://Json-Schema.Org/draft/2019-09/meta/core', 2019], ['HTTP://JSON-SCHEMA.ORG/draft-06/schema#', 6],
      ['HTTPS://jarenjs.dev/schemas/2020-12/schema', 2020],
      ['https://json-schema.org/DRAFT/2020-12/schema', 7], ['https://json-schema.org/draft/2020-12/Schema', 7],
    ]) assert.equal(detectSchemaDraft({ $schema: uri }), draft, uri);
    assert.deepEqual(['HTTPS://json-schema.org/draft/2020-12/schema', 'https://JSON-SCHEMA.org/draft/2020-12/schema']
      .map((uri) => new JarenValidator().compile({ $schema: uri, ...TUPLE })([1])), [false, false]);
  });

  it('never asks the host to load a meta-schema json-schema.org publishes, whatever the case of its scheme and host', async () => {
    const asked = [];
    const loadSchema = async (/** @type {string} */ uri) => { asked.push(uri); throw new Error(`no document at ${uri}`); };
    const answers = [];
    for (const uri of ['HTTPS://json-schema.org/draft/2020-12/schema', 'https://json-schema.org/draft/2020-12/hyper-schema'])
      answers.push((await compileAsync(new JarenValidator(), { $schema: uri, ...TUPLE }, { loadSchema }))([1]));
    assert.deepEqual({ asked, answers }, { asked: [], answers: [false, false] });
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

describe('a held schema is named with its scheme and host in any case', () => {
  // RFC 3986 makes the scheme and the host case-insensitive: a URI that
  // differs from a held schema's only there names that schema. Its path and
  // its percent-encodings are compared as written.
  const MINE = 'https://example.com/my-dialect';
  const SPELLINGS = ['HTTPS://EXAMPLE.com/my-dialect', 'https://EXAMPLE.COM/my-dialect', 'Https://Example.Com/my-dialect#'];

  it('reads a $schema naming a held dialect in another case by that dialect (accepted [1] as draft-07)', () => {
    for (const uri of SPELLINGS) {
      assert.deepEqual([[1], ['a']].map(holding(dialect(MINE)).compile({ $schema: uri, ...TUPLE })), [false, true], uri);
      assert.equal(detectSchemaDraft({ $schema: uri }, { get: (key) => holding(dialect(MINE)).getSchema(key) }), 2020, uri);
    }
    // a dialect held under an upper-case $id is named in lower case too
    assert.deepEqual([[1], ['a']].map(holding(dialect('HTTPS://EXAMPLE.COM/my-dialect')).compile({ $schema: MINE, ...TUPLE })), [false, true]);
    // a schema registered under such a $schema reads the same, whichever was registered first
    const S = { $id: 'https://example.com/s', $schema: SPELLINGS[0], ...TUPLE };
    assert.deepEqual([holding(dialect(MINE), S), holding(S, dialect(MINE))]
      .map((validator) => validator.compile({ $ref: 'https://example.com/s' })([1])), [false, false]);
  });

  it('switches vocabularies by the meta-schema a $schema names in another case', () => {
    // a meta-schema that omits the validation vocabulary: type asserts nothing
    const id = 'https://example.com/vocab-meta';
    const meta = { ...dialect(id), $vocabulary: { 'https://json-schema.org/draft/2020-12/vocab/core': true } };
    for (const uri of [id, 'HTTPS://Example.COM/vocab-meta'])
      assert.equal(holding(meta).compile({ $schema: uri, type: 'string' })(12), true, uri);
  });

  it('checks a schema against the held meta-schema its $schema names in another case', () => {
    const validator = new JarenValidator().addMetaSchema(draft2020.schema, draft2020.draft);
    assert.equal(validator.validateSchema({ $schema: 'HTTPS://JSON-SCHEMA.ORG/draft/2020-12/schema', type: 'string' }), true);
    assert.equal(validator.validateSchema({ $schema: 'HTTPS://JSON-SCHEMA.ORG/draft/2020-12/schema', type: 5 }), false);
    assert.equal(validator.getSchema('HTTPS://JSON-SCHEMA.ORG/draft/2020-12/schema'), validator.getSchema(D2020));
  });

  it('asks compileAsync\'s loader for a dialect by its held name, and not at all when it is held', async () => {
    /** @type {string[]} */
    const asked = [];
    const loadSchema = async (/** @type {string} */ uri) => {
      asked.push(uri);
      if (uri === MINE) return dialect(MINE);
      throw new Error(`no document at ${uri}`);
    };
    const loaded = await compileAsync(holding(), { $schema: SPELLINGS[0], ...TUPLE }, { loadSchema });
    const held = await compileAsync(holding(dialect(MINE)), { $schema: SPELLINGS[1], ...TUPLE }, { loadSchema });
    assert.deepEqual([loaded([1]), held([1]), asked], [false, false, [MINE]]);
  });

  it('resolves a $ref in another case to the held schema, in every scheme', () => {
    const v = new JarenValidator().addSchema({ $id: 'https://example.com/x.json', type: 'integer' });
    assert.deepEqual(['1', 1].map(v.compile({ $ref: 'HTTPS://EXAMPLE.com/x.json' })), [false, true]);
    // a scheme the URL standard reads with an opaque host is read by RFC 3986 too
    const tag = new JarenValidator().addSchema({ $id: 'app://Example.COM/x.json', type: 'integer' });
    assert.deepEqual(['1', 1].map(tag.compile({ $ref: 'APP://example.com/x.json' })), [false, true]);
    assert.deepEqual([[1], ['a']].map(holding(dialect('app://example.com/d')).compile({ $schema: 'APP://EXAMPLE.COM/d', ...TUPLE })), [false, true]);
    // an $id inside a document, and a $ref to it, read alike whatever their case
    const inside = { $defs: { x: { $id: 'app://Example.COM/x.json', type: 'integer' } }, properties: { a: { $ref: 'app://example.COM/x.json' } } };
    assert.deepEqual([{ a: '1' }, { a: 1 }].map(new JarenValidator().compile(inside)), [false, true]);
  });

  it('replaces a schema registered again under a key in another case, as under the same key', () => {
    for (const key of ['https://example.com/a', 'HTTPS://EXAMPLE.com/a']) {
      const v = new JarenValidator().addSchema({ type: 'string' }, key).addSchema({ type: 'integer' }, key);
      // answered by the first registration (1 false, 's' true) under the upper-case key
      assert.deepEqual([1, 's'].map(v.compile({ $ref: key })), [true, false], key);
      assert.deepEqual(v.getSchema(key.toLowerCase()), { type: 'integer' }, key);
    }
  });

  it('compares the path and its percent-encodings as written', () => {
    // a dialect named by another path, or another percent-encoding case, is none held: draft-07
    for (const [id, uri] of [[MINE, 'https://example.com/MY-DIALECT'], ['https://example.com/a%2Fb', 'https://example.com/a%2fb']])
      assert.deepEqual([[1], ['a']].map(holding(dialect(id)).compile({ $schema: uri, ...TUPLE })), [true, true], uri);
    // so does a percent-encoding in a host
    assert.deepEqual([[1], ['a']].map(holding(dialect('app://ex%4Ample.com/d')).compile({ $schema: 'app://ex%4ample.com/d', ...TUPLE })), [true, true]);
    // the user part of an authority keeps its case
    assert.deepEqual([[1], ['a']].map(holding(dialect('https://Me@example.com/d')).compile({ $schema: 'https://me@EXAMPLE.com/d', ...TUPLE })), [true, true]);
    // the official names read in any case, as before
    assert.equal(detectSchemaDraft({ $schema: 'HTTPS://JSON-SCHEMA.ORG/draft/2020-12/schema' }), 2020);
    assert.equal(detectSchemaDraft({ $schema: 'https://json-schema.org/draft/2020-12/SCHEMA' }), 7);
  });
});
