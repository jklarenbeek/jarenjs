//@ts-check
/**
 * @file A document `addSchema` holds answers as the same document compiled
 * with the URI it is held under as its root `$id`, at its root and at every
 * place a reference names below it. A relative root `$id` is resolved once,
 * against the key or, without one, against the origin, as a compile
 * resolves a reference to it. A place a pointer names below an identifier is
 * that place, not the identifier's object: a chain through two such places
 * is no loop.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JarenValidator } from '@jarenjs/validate';
import { compileAsync } from '@jarenjs/validate/load';
import { deriveStrictProfile } from '@jarenjs/validate/strict-profile';
import { embeddedResourceSchemas, placeType } from '../lib/embedded-resources.js';

const D07 = 'http://json-schema.org/draft-07/schema#';
const KEYS = ['http://k.test/dir/key.json', 'jaren-strict:/schema.json'];

/** @param {any} schema @param {string} [key] */
const holding = (schema, key) => new JarenValidator().addSchema(schema, key);
/** @param {(value: unknown) => unknown} validate @param {unknown[]} values */
const verdicts = (validate, values) => values.map((value) => validate(value));
/** @param {() => unknown} fn @returns {string|undefined} */
const codeOf = (fn) => {
  try { fn(); return undefined; }
  catch (e) { return /** @type {any} */ (e).code; }
};

describe('a place a pointer names below an identifier is that place', () => {
  /** A fragment-only `$id` names `y`; `a` reads `y`'s own `x`, a string. */
  const named = () => ({
    type: 'object',
    definitions: { x: { type: 'integer', $id: '#nm' } },
    properties: {
      r: { $ref: '#/definitions/x' },
      y: { $id: '#thing', type: 'object', definitions: { x: { type: 'string' } }, properties: { a: { $ref: '#/properties/y/definitions/x' } } },
    },
  });

  it('compiles a held place below a fragment-only `$id`, as the document compiled directly reads it', () => {
    const key = 'jaren-strict:/schema.json';
    assert.deepEqual(verdicts(holding(named(), key).compile({ $ref: `${key}#/properties/y/properties/a` }), ['s', 1]), [true, false]);
    assert.deepEqual(verdicts(holding(named(), key).compile({ $ref: key }), [{ y: { a: 's' } }, { y: { a: 1 } }]), [true, false]);
    assert.deepEqual(verdicts(new JarenValidator().compile(named()), [{ y: { a: 's' } }, { y: { a: 1 } }]), [true, false]);
  });

  it('derives the strict profile of such a document', () => {
    const profile = deriveStrictProfile(named());
    const strict = new JarenValidator().compile(profile.schema);
    assert.deepEqual([{ r: 1, y: { a: 's' } }, { r: 1, y: { a: 1 } }].map((value) => strict(profile.toProfile(value))), [true, false]);
  });

  for (const id of ['thing.json', '#thing', 'http://o.test/t.json']) {
    it(`follows a chain of two places below \`$id: '${id}'\``, () => {
      const doc = () => ({
        $id: 'http://e.test/s.json',
        properties: { y: { $id: id, definitions: { a: { $ref: 'http://e.test/s.json#/properties/y/definitions/b' }, b: { type: 'string' } } } },
      });
      const direct = new JarenValidator().compile({ ...doc(), properties: { ...doc().properties, p: { $ref: '#/properties/y/definitions/a' } } });
      assert.deepEqual(verdicts(direct, [{ p: 's' }, { p: 1 }]), [true, false]);
      assert.deepEqual(verdicts(holding(doc()).compile({ $ref: 'http://e.test/s.json#/properties/y/definitions/a' }), ['s', 1]), [true, false]);
    });
  }

  it('still refuses a place that refers to itself, and a loop spelled through an identifier', () => {
    const self = named();
    self.properties.y.properties.a = { $ref: '#/properties/y/properties/a' };
    assert.equal(codeOf(() => new JarenValidator().compile(self)), 'JK0001');
    const loop = {
      $id: 'http://e.test/s.json',
      properties: {
        p: { $ref: '#/properties/y/definitions/a' },
        y: { $id: 'thing.json', definitions: { a: { $ref: '#/definitions/b' }, b: { $ref: 'http://e.test/s.json#/properties/y/definitions/a' } } },
      },
    };
    assert.equal(codeOf(() => new JarenValidator().compile(loop)), 'JK0001');
  });
});

describe('a document held under a key reads as one whose root `$id` is the key', () => {
  /** `y`'s relative `$id` names `http://example.com/thing`; `z` reads its `x`, a string. */
  const embedded = () => ({ definitions: { x: { type: 'integer' } }, properties: { y: { $id: 'thing', definitions: { x: { type: 'string' } }, properties: { z: { $ref: '#/definitions/x' } } } } });

  it('resolves an embedded relative `$id` against the key', () => {
    const doc = embedded();
    const validator = holding(doc, 'http://example.com/root.json');
    assert.deepEqual(verdicts(validator.compile({ $ref: 'http://example.com/root.json' }), [{ y: { z: 's' } }, { y: { z: 1 } }]), [true, false]);
    assert.deepEqual(verdicts(validator.compile({ $ref: 'http://example.com/thing#/definitions/x' }), ['s', 1]), [true, false]);
    // the caller's own object is held unchanged and answered
    assert.equal(validator.getSchema('http://example.com/root.json'), doc);
    assert.equal(doc.$id, undefined);
  });

  it('resolves it against the URI a loaded document was retrieved from', async () => {
    const docs = { 'http://example.com/root.json': embedded() };
    const validate = await compileAsync(new JarenValidator(), { $ref: 'http://example.com/root.json' }, { loadSchema: async (uri) => /** @type {any} */ (docs)[uri] });
    assert.deepEqual(verdicts(validate, [{ y: { z: 's' } }, { y: { z: 1 } }]), [true, false]);
  });

  it('resolves a root `$ref` beside the key, or beside a root `$id`, against the document', () => {
    const d = { type: 'object', properties: { a: { type: 'string' } } };
    for (const key of KEYS) {
      for (const schema of [{ $ref: '#/$defs/d', $defs: { d } }, { $schema: D07, $ref: '#/definitions/d', definitions: { d } }]) {
        for (const held of [schema, { ...schema, $id: key }]) {
          const validate = holding(structuredClone(held), key).compile({ $ref: key });
          assert.deepEqual(verdicts(validate, [{ a: 'x' }, { a: 1 }]), [true, false], `${key} ${JSON.stringify(held)}`);
        }
      }
    }
  });
});

describe('a held document\'s root `$ref` read alone resolves in its own document', () => {
  it('does not read the compiling document\'s place of the same pointer', () => {
    const key = 'http://k.test/s.json';
    const compiled = { definitions: { d: { type: 'integer' } }, properties: { p: { $ref: key } } };
    for (const held of [
      { $schema: D07, $id: key, $ref: '#/definitions/d', definitions: { d: { type: 'string' } } },
      { $id: key, $ref: '#/definitions/d', definitions: { d: { type: 'string' } } },
    ]) {
      const validate = holding(held).compile(structuredClone(compiled));
      assert.deepEqual(verdicts(validate, [{ p: 's' }, { p: 1 }]), [true, false], JSON.stringify(held));
    }
  });
});

describe('a document held under a key keeps what its own root declares', () => {
  const K = 'http://k.test/dir/key.json';
  /** `y`'s relative `$id`, and the root's own, decide where `s` is reached. @param {Record<string, unknown>} root */
  const holder = (root) => ({ ...root, definitions: { s: { type: 'string' } }, type: 'object', properties: { a: { $ref: '#/definitions/s' }, y: { $id: 'thing.json', type: 'object', definitions: { s: { type: 'integer' } }, properties: { z: { $ref: '#/definitions/s' } } } } });
  const INSTANCES = [{ a: 's', y: { z: 1 } }, { a: 1, y: { z: 1 } }, { a: 's', y: { z: 's' } }];

  it('names a document whose root `$id` is fragment-only by the key and the name', () => {
    assert.deepEqual(verdicts(holding({ $id: '#node', type: 'string' }, K).compile({ $ref: `${K}#node` }), ['s', 1]), [true, false]);
    assert.deepEqual(verdicts(holding(holder({ $id: '#root' }), K).compile({ $ref: K }), INSTANCES), [true, false, false]);
    const node = { $id: '#node', type: 'object', properties: { next: { $ref: '#node' }, v: { type: 'string' } } };
    assert.deepEqual(verdicts(holding(node, K).compile({ $ref: K }), [{ v: 's', next: { v: 's' } }, { v: 's', next: { v: 1 } }]), [true, false]);
    // without a key, against the origin, as a compile resolves `#node`
    const held = holding(node);
    assert.deepEqual(verdicts(held.compile({ $ref: '#node' }), [{ v: 's', next: { v: 's' } }, { v: 's', next: { v: 1 } }]), [true, false]);
    assert.equal(held.getSchema('#node'), node);
  });

  it('resolves an embedded `$id` against a root draft-04 `id` where no draft is declared', () => {
    const validator = holding(holder({ id: 'http://i.test/x.json' }), K);
    assert.deepEqual(verdicts(validator.compile({ $ref: 'http://i.test/thing.json#/definitions/s' }), [1, 's']), [true, false]);
    assert.deepEqual(verdicts(validator.compile({ $ref: K }), INSTANCES), [true, false, false]);
  });

  it('names a root whose `$id` is no string by the key, as a compile ignores that `$id`', () => {
    assert.deepEqual(verdicts(holding(holder({ $id: 5 }), K).compile({ $ref: K }), INSTANCES), [true, false, false]);
    assert.deepEqual(verdicts(new JarenValidator().compile(holder({ $id: 5 })), INSTANCES), [true, false, false]);
  });

  it('derives the strict profile of a document whose root `$id` is a fragment-only name', () => {
    const profile = deriveStrictProfile(holder({ $id: '#root' }));
    const strict = new JarenValidator().compile(profile.schema);
    assert.deepEqual(INSTANCES.map((value) => strict(profile.toProfile(value))), [true, false, false]);
  });
});

describe('a relative root `$id` is held under the URI a reference resolves it to', () => {
  for (const id of ['sub/t.json', 't.json']) {
    it(`answers a reference to \`${id}\``, () => {
      const doc = { $id: id, type: 'string' };
      const validator = holding(doc);
      assert.deepEqual(verdicts(validator.compile({ properties: { a: { $ref: id } } }), [{ a: 's' }, { a: 1 }]), [true, false]);
      assert.equal(validator.getSchema(id), doc);
      assert.equal(validator.getSchema(`https://github.com/jklarenbeek/${id}`), doc);
    });
  }

  it('resolves it against the key it is held under', () => {
    const validator = holding({ $id: 'sub/t.json', type: 'string' }, 'http://k.test/dir/key.json');
    assert.deepEqual(verdicts(validator.compile({ $ref: 'http://k.test/dir/sub/t.json' }), ['s', 1]), [true, false]);
    assert.deepEqual(verdicts(validator.compile({ $ref: 'http://k.test/dir/key.json' }), ['s', 1]), [true, false]);
  });
});

describe('a held document answers as the document compiled directly (generated)', () => {
  const PLACES = [[], ['r'], ['y'], ['y', 'a'], ['y', 'z'], ['y', 'z', 'b']];
  /** @param {string[]} place */
  const pointer = (place) => place.map((key) => `/properties/${key}`).join('');
  /** @param {(value: unknown) => unknown} validate @param {string[]} path */
  const typeAt = (validate, path) => {
    try { return placeType(/** @type {any} */ (validate), path); }
    catch (e) { return `throws ${/** @type {any} */ (e).code}`; }
  };

  for (const rootReference of [false, true]) {
    it(rootReference ? 'reads a root `$ref` beside the key as the direct compile does' : 'reads every place a pointer names as the direct compile does', () => {
      const counts = { variants: 0, directRefused: 0, places: 0, leaves: 0, same: 0, refused: 0 };
      /** @type {string[]} */
      const wrong = [];
      for (const { schema: plain, leaves, label } of embeddedResourceSchemas()) {
        const D = plain.$defs ? '$defs' : 'definitions';
        const schema = rootReference ? { ...plain, $ref: `#/${D}/x` } : plain;
        const variants = KEYS.map((key) => ({ key, base: key, direct: { ...schema, $id: schema.$id === undefined ? key : new URL(schema.$id, key).href } }));
        if (schema.$id !== undefined) variants.push({ key: /** @type {any} */ (undefined), base: schema.$id, direct: schema });
        for (const { key, base, direct: written } of variants) {
          let direct;
          try { direct = new JarenValidator().compile(structuredClone(written)); }
          catch { counts.directRefused++; continue; }
          counts.variants++;
          const held = holding(structuredClone(schema), key);
          // a root `$ref` read alone in draft-07 skips its siblings: only the root is compared
          for (const place of rootReference ? [[]] : PLACES) {
            const under = rootReference ? [[]] : leaves.filter((leaf) => place.every((name, n) => leaf[n] === name));
            if (under.length === 0) continue;
            counts.places++;
            let validate;
            try { validate = held.compile({ $ref: `${base}#${pointer(place)}` }); }
            catch (e) {
              counts.refused++;
              wrong.push(`${label} ${key} #${pointer(place)}: ${/** @type {Error} */ (e).message}`);
              continue;
            }
            for (const leaf of under) {
              counts.leaves++;
              const want = typeAt(direct, leaf), got = typeAt(validate, leaf.slice(place.length));
              if (want === got) counts.same++;
              else wrong.push(`${label} ${key} #${pointer(place)} ${leaf.join('.')}: ${want} directly, ${got} held`);
            }
          }
        }
      }
      assert.deepEqual(wrong.slice(0, 5), []);
      assert.deepEqual(counts, rootReference
        ? { variants: 2448, directRefused: 432, places: 2448, leaves: 2448, same: 2448, refused: 0 }
        : { variants: 2448, directRefused: 432, places: 13056, leaves: 18768, same: 18768, refused: 0 });
    });
  }
});
