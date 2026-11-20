//@ts-check
/**
 * @file Every compile refusal names its place one way: `docPath` is a JSON
 * Pointer into the document the place lies in, every token escaped, as a URI
 * fragment alone (`#/…`) in the document the compile was handed and after
 * that document's URI in a document the validator holds. An embedded
 * resource (a subschema with an `$id` of its own) is a place of its
 * document: its `$id` names no place. The grid is every refusal of a place x
 * how the compile reaches it (descent, a pointer `$ref`, a URI `$ref`, into
 * the root resource or an embedded one) x three drafts x the compiled or a
 * held document; a refusal thrown by `compile()` and one thrown by the first
 * call that reaches the place are held to the same spelling. Each `docPath`
 * is read back as a pointer and must reach the very node the refusal is
 * about. A code the grid does not hold is named below with why (no place, or
 * placed by another module), so a new refusal fails until it is placed.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decodeJSONPointerSegment } from '@jarenjs/json/pointer';

import { JarenValidator, VALIDATE_CODES } from '@jarenjs/validate';
import { compileNormalizer } from '@jarenjs/validate/normalize';

const DRAFTS = {
  '2020-12': 'https://json-schema.org/draft/2020-12/schema',
  '2019-09': 'https://json-schema.org/draft/2019-09/schema',
  'draft-07': 'http://json-schema.org/draft-07/schema#',
};
const ROOT = 'https://x.test/root.json';
const N = 'https://x.test/n';
const META = 'https://x.test/meta';
const UNWALKED = 'by a pointer $ref into an embedded resource below a keyword no draft defines';

/** A reference token as a URI fragment spells it: `~` and `/` escaped, then percent-encoded. @param {string} token */
const escaped = (token) => encodeURIComponent(token.replaceAll('~', '~0').replaceAll('/', '~1')).replaceAll('%7E', '~');

/**
 * The node a pointer fragment names in a document.
 * @param {any} document @param {string} fragment - `/a/b`, percent-encoded tokens
 * @returns {any}
 */
function at(document, fragment) {
  let node = document;
  for (const token of fragment.split('/').slice(1)) node = node?.[decodeJSONPointerSegment(decodeURIComponent(token))];
  return node;
}

/**
 * How a compile reaches the refused members, the `properties` of a schema n:
 * the document, the path to n's `properties` in it, and the reference from
 * inside n back to its own member `a`.
 * @type {[string, (members: object, draft: string) => object, string[], string][]}
 */
const REACHES = [
  ['by descent', (members, draft) => ({ $schema: draft, $id: ROOT, properties: { p: { type: 'object', properties: members } } }),
    ['properties', 'p', 'properties'], '#/properties/p/properties/a'],
  ['by descent, without a root $id', (members, draft) => ({ $schema: draft, properties: { p: { type: 'object', properties: members } } }),
    ['properties', 'p', 'properties'], '#/properties/p/properties/a'],
  ['by descent into an embedded resource', (members, draft) => ({ $schema: draft, $id: ROOT, properties: { p: { $id: N, type: 'object', properties: members } } }),
    ['properties', 'p', 'properties'], '#/properties/a'],
  ['by a pointer $ref', (members, draft) => ({ $schema: draft, $id: ROOT, properties: { p: { $ref: '#/$defs/n' } }, $defs: { n: { type: 'object', properties: members } } }),
    ['$defs', 'n', 'properties'], '#/$defs/n/properties/a'],
  ['by a pointer $ref into an embedded resource', (members, draft) => ({ $schema: draft, $id: ROOT, properties: { p: { $ref: '#/$defs/n' } }, $defs: { n: { $id: N, type: 'object', properties: members } } }),
    ['$defs', 'n', 'properties'], '#/properties/a'],
  ['by the URI $ref of an embedded resource', (members, draft) => ({ $schema: draft, $id: ROOT, properties: { p: { $ref: N } }, $defs: { n: { $id: N, type: 'object', properties: members } } }),
    ['$defs', 'n', 'properties'], '#/properties/a'],
  // no walk reads below a keyword no draft defines: the place is named by the reference that reaches it
  [UNWALKED, (members, draft) => ({ $schema: draft, $id: ROOT, properties: { p: { $ref: '#/x-defs/n' } }, 'x-defs': { n: { $id: N, type: 'object', properties: members } } }),
    ['x-defs', 'n', 'properties'], '#/properties/a'],
];

/** @param {number} levels */
const chain = (levels) => {
  /** @type {object} */
  let schema = { type: 'string' };
  for (let i = 0; i < levels; i++) schema = { properties: { x: schema } };
  return schema;
};
const unimplemented = (/** @type {JarenValidator} */ validator) => validator.addMetaSchema({ $schema: DRAFTS['2020-12'], $id: META,
  $vocabulary: { 'https://json-schema.org/draft/2020-12/vocab/core': true, 'https://x.test/vocab/unknown': true } });

/** Where an identifier declared twice is read by no compile. @param {boolean} held @param {string} reach */
const WALKED_ONLY = (held, reach) => held || reach === UNWALKED;

/**
 * Each refusal of a place: its code, n's `properties` holding it (given the
 * reference back to `a`), the node it is about below them (`chain`: a
 * subschema of the chain below `a`), the drafts it is read in, the
 * validator's options, what the validator holds first, and the cells where
 * the shape answers (no compile reads what is refused).
 * @type {{ label: string, code: string, members: (self: string) => Record<string, any>, about: string[]|'chain', drafts?: string[], options?: object, prepare?: (v: JarenValidator) => void, answers?: (held: boolean, reach: string) => boolean }[]}
 */
const REFUSALS = [
  // a held document's identifier two of its places declare is refused only by a compile that reads it
  // (duplicate-identifier.test.js), and no walk registers one below a keyword no draft defines
  { label: '$id declared twice', code: 'JK0012', members: () => ({ a: { $id: 'https://x.test/dup' }, b: { $id: 'https://x.test/dup' } }), about: ['b', '$id'], answers: WALKED_ONLY },
  { label: '$anchor declared twice', code: 'JK0012', members: () => ({ a: { $anchor: 'k' }, b: { $anchor: 'k' } }), about: ['b', '$anchor'], drafts: ['2020-12', '2019-09'], answers: WALKED_ONLY },
  { label: '$id that is no URI', code: 'JK0010', members: () => ({ a: { $id: 'http://[' } }), about: ['a', '$id'] },
  { label: '$ref that is no URI', code: 'JK0010', members: () => ({ a: { $ref: 'http://[' } }), about: ['a', '$ref'] },
  { label: '$ref to a document nothing holds', code: 'JK0009', members: () => ({ a: { $ref: 'https://x.test/missing.json' } }), about: ['a', '$ref'] },
  { label: '$ref pointer that misses', code: 'JK0009', members: () => ({ a: { $ref: '#/nowhere' } }), about: ['a', '$ref'] },
  { label: '$ref to an anchor nothing declares', code: 'JK0009', members: () => ({ a: { $ref: '#nope' } }), about: ['a', '$ref'] },
  { label: 'draft-07 $ref beside an $id', code: 'JK0008', members: () => ({ a: { $id: 'https://x.test/other/', $ref: 'x.json' } }), about: ['a', '$ref'], drafts: ['draft-07'] },
  { label: '$query that does not compile', code: 'JQ0002', members: () => ({ a: { $query: { $bogus: 1 } } }), about: ['a', '$query'] },
  { label: '$recursiveRef other than "#"', code: 'JK0011', members: () => ({ a: { $recursiveRef: '#foo' } }), about: ['a', '$recursiveRef'], drafts: ['2019-09'] },
  { label: '$dynamicRef that is no URI', code: 'JK0010', members: () => ({ a: { $dynamicRef: 'http://[' } }), about: ['a', '$dynamicRef'], drafts: ['2020-12'] },
  { label: '$dynamicRef to a document nothing holds (it named no place)', code: 'JK0009', members: () => ({ a: { $dynamicRef: 'https://x.test/missing.json#m' } }), about: ['a', '$dynamicRef'], drafts: ['2020-12'] },
  { label: '$dynamicRef to an anchor nothing declares (it named no place)', code: 'JK0009', members: () => ({ a: { $dynamicRef: '#nope' } }), about: ['a', '$dynamicRef'], drafts: ['2020-12'] },
  { label: 'keyword value of the wrong shape', code: 'JK0013', members: () => ({ a: { minLength: 'x' } }), about: ['a', 'minLength'] },
  { label: 'pattern that does not compile', code: 'JK0014', members: () => ({ a: { pattern: '[' } }), about: ['a', 'pattern'] },
  { label: 'format no compiler is registered for', code: 'JK0015', members: () => ({ a: { format: 'no-such-format' } }), about: ['a', 'format'], options: { formatAssertion: true, unknownFormats: 'error' } },
  { label: 'subschemas nested past maxSchemaDepth', code: 'JK0017', members: () => ({ a: chain(12) }), about: 'chain', options: { maxSchemaDepth: 8 } },
  { label: 'loop of references (it named no place)', code: 'JK0001', members: (self) => ({ a: { $ref: self } }), about: ['a', '$ref'] },
  { label: 'dialect requiring a vocabulary not implemented', code: 'JK0016', members: () => ({ a: { $schema: META, $id: 'https://x.test/inner' } }), about: ['a', '$schema'], drafts: ['2020-12', '2019-09'], prepare: unimplemented },
];

/**
 * The codes this grid does not hold, each with why: they refuse an option or
 * an argument (no place), an instance a compiled validator meets (a place of
 * the instance), or are placed by another module and pinned with it.
 */
const NOT_PLACES = {
  JK0002: 'an option', JK0003: 'an option', JK0007: 'an argument of compileAsync',
  JK0004: 'a load, placed by compileAsync (compile-async.test.js)', JK0005: 'a load, placed by compileAsync (compile-async.test.js)',
  JK0006: 'a load, placed by compileAsync (compile-async.test.js)',
  JK0101: 'retired', JK0102: 'a strict profile, placed by its derivation',
  JK0103: 'a strict profile, placed by its derivation', JK0104: 'a strict profile, placed by its derivation',
  JK0105: 'a strict profile, placed by its derivation', JK0106: 'a strict profile, placed by its derivation',
  JK0107: 'an argument of a profile derivation', JK0108: 'a strict profile, placed by its derivation',
  JK2001: 'an instance', JK2002: 'an instance', JK2003: 'an instance',
};

/**
 * What the compile, or the first call into the place, throws.
 * @param {object} document @param {boolean} held - Whether the validator holds the document and the compile reaches it by its URI
 * @param {string} draft @param {object} options @param {((v: JarenValidator) => void)|undefined} prepare
 */
function refusal(document, held, draft, options, prepare) {
  let when = 'compile';
  try {
    const validator = new JarenValidator(options);
    prepare?.(validator);
    if (held) validator.addSchema(document);
    const validate = validator.compile(held ? { $schema: draft, properties: { q: { $ref: ROOT } } } : document);
    when = 'call';
    validate(held ? { q: { p: { a: 'x', b: 'x' } } } : { p: { a: 'x', b: 'x' } });
    return { when: 'answers' };
  }
  catch (e) {
    return { when, code: e.code, docPath: e.docPath, message: e.message };
  }
}

describe('a compile refusal names its place by a pointer into its document, every token escaped', () => {
  /** @type {Set<string>} */
  const moments = new Set();
  /** @type {Set<string>} */
  const codes = new Set();
  for (const { label, code, members, about, drafts, options = {}, prepare, answers } of REFUSALS) {
    codes.add(code);
    it(label, () => {
      for (const [draftName, draft] of Object.entries(DRAFTS)) {
        if (drafts !== undefined && !drafts.includes(draftName)) continue;
        for (const [reach, build, toMembers, self] of REACHES) {
          for (const held of [false, true]) {
            if (held && reach.endsWith('without a root $id')) continue;
            const cell = `${draftName}, ${reach}, ${held ? 'in a held document' : 'in the compiled document'}`;
            const own = members(self);
            const document = build(own, draft);
            const got = refusal(document, held, draft, options, prepare);
            if (answers?.(held, reach)) {
              assert.equal(got.when, 'answers', cell);
              continue;
            }
            moments.add(got.when);
            const name = held ? `${ROOT}#` : '#';
            const membersAt = `/${toMembers.map(escaped).join('/')}`;
            assert.equal(got.code, code, cell);
            assert.equal(typeof got.docPath, 'string', cell);
            assert.equal(got.message, `${got.message.slice(0, -got.docPath.length - 4)} at ${got.docPath}`, cell);
            assert.ok(got.docPath.startsWith(`${name}${membersAt}/a`) || got.docPath.startsWith(`${name}${membersAt}/b`), `${cell}: ${got.docPath}`);
            // read back as a pointer, it reaches the node the refusal is about
            const fragment = got.docPath.slice(name.length);
            assert.equal(at(document, membersAt), own, cell);
            if (about === 'chain') {
              const node = at(document, fragment);
              assert.ok(node !== null && typeof node === 'object' && fragment.startsWith(`${membersAt}/a/properties/x`), `${cell}: ${got.docPath}`);
            }
            else {
              assert.equal(got.docPath, `${name}${membersAt}/${about.map(escaped).join('/')}`, cell);
              assert.equal(at(document, fragment), about.reduce((/** @type {any} */ node, key) => node[key], own), cell);
            }
          }
        }
      }
    });
  }

  it('holds to it whether compile() or the first call that reaches the place throws', () => {
    assert.deepEqual([...moments].sort(), ['call', 'compile']);
  });

  it('places every code that refuses a place of a schema, and names why each other code has none', () => {
    const unplaced = Object.keys(VALIDATE_CODES).filter((code) => !codes.has(code) && !Object.hasOwn(NOT_PLACES, code));
    assert.deepEqual(unplaced, []);
    assert.deepEqual(Object.keys(NOT_PLACES).filter((code) => !Object.hasOwn(VALIDATE_CODES, code)), []);
  });
});

describe('the normalizer names the places it refuses as the validator does', () => {
  /** The code and place a compile refuses with. @param {() => unknown} compile */
  const refused = (compile) => {
    try { compile(); }
    catch (e) { return { code: e.code, docPath: e.docPath, located: e.message.endsWith(` at ${e.docPath}`) }; }
    return null;
  };

  it('JK0017, at the first subschema past maxSchemaDepth, in every reach of the grid', () => {
    for (const [reach, build, toMembers] of REACHES) {
      const document = build({ a: chain(12) }, DRAFTS['2020-12']);
      const normalizer = refused(() => compileNormalizer(structuredClone(document), { maxSchemaDepth: 8 }));
      const validator = refused(() => new JarenValidator({ maxSchemaDepth: 8 }).compile(structuredClone(document))({ p: { a: 'x' } }));
      assert.deepEqual(normalizer, validator, reach);
      assert.equal(normalizer?.code, 'JK0017', reach);
      assert.ok(normalizer?.located && normalizer.docPath.startsWith(`#/${toMembers.map(escaped).join('/')}/a/properties/x`), `${reach}: ${normalizer?.docPath}`);
      assert.equal(typeof at(document, normalizer.docPath.slice(1)), 'object', reach);
    }
  });

  it('JK0001, at the reference that closes a loop every call runs into', () => {
    for (const [document, place] of /** @type {[any, string][]} */ ([
      [{ $id: ROOT, allOf: [{ $ref: '#' }] }, '/allOf/0/%24ref'],
      [{ $id: ROOT, $ref: '#/$defs/n', $defs: { n: { allOf: [{ $ref: '#/$defs/n' }] } } }, '/%24defs/n/allOf/0/%24ref'],
      [{ $id: ROOT, $ref: N, $defs: { n: { $id: N, allOf: [{ allOf: [{ $ref: '#' }] }] } } }, '/%24defs/n/allOf/0/allOf/0/%24ref'],
    ])) {
      const normalizer = refused(() => compileNormalizer(structuredClone(document)));
      assert.deepEqual(normalizer, refused(() => new JarenValidator().compile(structuredClone(document))), place);
      assert.deepEqual(normalizer, { code: 'JK0001', docPath: `#${place}`, located: true });
      assert.equal(typeof at(document, place), 'string', place);
    }
  });
});

describe('a refusal names no embedded resource by its URI', () => {
  it('in the message either: it ends with the place it names', () => {
    const document = { $id: ROOT, $defs: { n: { $id: N, properties: { a: { minLength: -1 } } } }, properties: { p: { $ref: N } } };
    assert.throws(() => new JarenValidator().compile(document)({ p: { a: 'x' } }), {
      code: 'JK0013', docPath: '#/%24defs/n/properties/a/minLength',
      message: "JK0013: 'minLength' takes a non-negative integer, got -1; a value of another shape is no constraint the validator reads at #/%24defs/n/properties/a/minLength",
    });
  });

  it('names a reference of a schema of the second argument of compile in that document (it named no place)', () => {
    const extra = () => ({ $id: 'https://x.test/e.json', properties: { a: { $ref: 'https://x.test/missing.json' } } });
    for (const validator of [new JarenValidator(), new JarenValidator().addSchema({ $id: 'https://x.test/h.json', type: 'string' })]) {
      assert.throws(() => validator.compile({ properties: { p: { $ref: 'https://x.test/e.json' } } }, [extra()]), {
        code: 'JK0009', docPath: 'https://x.test/e.json#/properties/a/%24ref',
      });
    }
  });

  it('names what the walk of a second-argument schema or a meta-schema refuses in that document (it named a place of the compiled one)', () => {
    const extra = (/** @type {object} */ properties) => [{ $id: 'https://x.test/e.json', properties }];
    assert.throws(() => new JarenValidator().compile({ type: 'string' }, extra({ a: { $ref: 'http://[' } })), { code: 'JK0010', docPath: 'https://x.test/e.json#/properties/a/%24ref' });
    assert.throws(() => new JarenValidator().compile({ type: 'string' }, extra({ b: { $id: 'http://[' } })), { code: 'JK0010', docPath: 'https://x.test/e.json#/properties/b/%24id' });
    assert.throws(() => new JarenValidator().compile({ type: 'string' }, extra({ a: { $id: 'https://x.test/d' }, b: { $id: 'https://x.test/d' } })),
      { code: 'JK0012', docPath: 'https://x.test/e.json#/properties/b/%24id' });
    const meta = (/** @type {object} */ a) => ({ $schema: DRAFTS['2020-12'], $id: 'https://x.test/m', properties: { a } });
    assert.throws(() => new JarenValidator().addMetaSchema(meta({ $ref: 'http://[' })), { code: 'JK0010', docPath: 'https://x.test/m#/properties/a/%24ref' });
    assert.throws(() => new JarenValidator().addMetaSchema(meta({ $ref: 'https://x.test/missing' })).compile({ $schema: 'https://x.test/m' }),
      { code: 'JK0009', docPath: 'https://x.test/m#/properties/a/%24ref' });
  });

  it('names a target an item reference builds by its place (the item fast path)', () => {
    const items = (/** @type {object} */ defs, /** @type {string} */ ref) => ({ $id: 'https://x.test/h.json', ...defs, items: { $ref: ref } });
    for (const [defs, ref, place] of [
      [{ $defs: { t: { minLength: 'x' } } }, '#/$defs/t', '/%24defs/t/minLength'],
      [{ $defs: { n: { $id: N, $defs: { t: { minLength: 'x' } }, items: { $ref: '#/$defs/t' } } } }, N, '/%24defs/n/%24defs/t/minLength'],
      [{ 'x-defs': { t: { minLength: 'x' } } }, '#/x-defs/t', '/x-defs/t/minLength'],
    ]) {
      const document = items(defs, ref);
      const call = ref === N ? [['a']] : ['a'];
      assert.throws(() => new JarenValidator().compile(structuredClone(document))(call), { code: 'JK0013', docPath: `#${place}` });
      assert.throws(() => new JarenValidator().addSchema(structuredClone(document)).compile({ $ref: 'https://x.test/h.json' })(call),
        { code: 'JK0013', docPath: `https://x.test/h.json#${place}` });
    }
  });

  it('nor a schema of the second argument of compile, which is a document of its own', () => {
    const other = { $id: 'https://x.test/other.json', $defs: { n: { $id: N, properties: { a: { minLength: -1 } } } } };
    assert.throws(() => new JarenValidator().compile({ properties: { p: { $ref: N } } }, [other])({ p: { a: 'x' } }), {
      code: 'JK0013', docPath: 'https://x.test/other.json#/%24defs/n/properties/a/minLength',
    });
  });

  it('names a held document compiled directly by `#`, and by its URI for a compile that reaches it after', () => {
    const document = { properties: { a: { $id: 'https://x.test/inner', minLength: -1 } } };
    const validator = new JarenValidator().addSchema(document, 'https://x.test/k.json');
    assert.throws(() => validator.compile(document), { code: 'JK0013', docPath: '#/properties/a/minLength' });
    assert.throws(() => validator.compile({ $ref: 'https://x.test/k.json' })({ a: 'x' }), {
      code: 'JK0013', docPath: 'https://x.test/k.json#/properties/a/minLength',
    });
    assert.throws(() => validator.compile({ $ref: 'https://x.test/inner' })('x'), {
      code: 'JK0013', docPath: 'https://x.test/k.json#/properties/a/minLength',
    });
  });

  it('nor in a held document named by a plain name alone, whose places lie below that name', () => {
    const validator = new JarenValidator().addSchema({ $id: 'https://x.test/r.json#root', properties: { a: { $id: 'https://x.test/inner', minLength: -1 } } });
    assert.throws(() => validator.compile({ $ref: 'https://x.test/r.json#root' })({ a: 'x' }), {
      code: 'JK0013', docPath: 'https://x.test/r.json#root/properties/a/minLength',
    });
  });
});
