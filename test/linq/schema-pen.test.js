//@ts-check
/**
 * @file The schema pen, over one corpus, three ways: every entry's
 * builder emits its hand-written document byte-equal, the validator
 * answers the corpus's verdicts over that document, every document is
 * valid under the 2020-12 meta-schema, and the committed generated
 * fixture — emit's declarations for the emitted documents, which the
 * type gate pins `Infer<>`/`Input<>` against — is exactly what the
 * generator produces today. Beside the corpus: the document is a value
 * (frozen, memoized, `toJSON`), the acceptance's own `check()` example,
 * `document()`, and the builders' own refusals by code.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';

import * as s from '@jarenjs/linq/schema';
import { from, fromAsync, LinqBuildError } from '@jarenjs/linq';
import { JarenValidator } from '@jarenjs/validate';
import { compileNormalizer } from '@jarenjs/validate/normalize';
import { createTypeTestCompiler } from '@jarenjs/validate/query';
import { stringFormats, dateTimeFormats } from '@jarenjs/formats';
import { getSchemaDraftByVersion } from '@jarenjs/refs';

import { CORPUS, PEN_NORMALIZE } from './schema-corpus.js';
import { renderFixture } from '../../scripts/generate-schema-pen-fixture.js';

const FIXTURE = new URL('../consumer/linq-schema-generated.ts', import.meta.url);
const PINS = new URL('../consumer/linq-schema.ts', import.meta.url);

const validator = () => new JarenValidator({ formatAssertion: true })
  .addFormats(stringFormats).addFormats(dateTimeFormats);

/** Whether a document carries a keyword the normalizer acts on. */
function carriesNormalizerKeyword(node) {
  if (Array.isArray(node)) return node.some(carriesNormalizerKeyword);
  if (node === null || typeof node !== 'object') return false;
  return Object.keys(node).some((key) =>
    key === 'default' || key === 'x-coerce' || key === 'x-trim'
    || carriesNormalizerKeyword(node[key]));
}

/**
 * The 2020-12 meta-schema as a compiled validator: the main document
 * compiled over the vocabulary documents registered beside it. (The
 * validator's `addMetaSchema(bundle)` route resolves the vocabulary
 * `$ref`s differently and answers `false` for every schema; the direct
 * compile is the route that works, and it is proven load-bearing below.)
 */
const [metaMain, ...metaVocabularies] = getSchemaDraftByVersion(2020).schema;
const metaSchema = new JarenValidator().addSchema(metaVocabularies).compile(metaMain);

describe('the schema pen — every corpus entry, three ways', () => {
  it('the meta-schema check is load-bearing: a wrong schema is refused', () => {
    assert.strictEqual(metaSchema({ type: 42 }), false);
    assert.strictEqual(metaSchema({ type: 'string', minLength: -1 }), false);
    assert.strictEqual(metaSchema({ type: 'string' }), true);
  });

  for (const entry of CORPUS) {
    describe(entry.name, () => {
      const built = entry.build();
      const validate = validator().compile(entry.schema);

      it('emits the hand-written document byte-equal', () => {
        assert.deepStrictEqual(built.schema, entry.schema);
        assert.strictEqual(JSON.stringify(built), JSON.stringify(built.schema));
        assert.deepStrictEqual(JSON.parse(JSON.stringify(built)), entry.schema);
      });

      it('two builds are one document, deep-frozen and memoized', () => {
        assert.deepStrictEqual(entry.build().schema, built.schema);
        assert.strictEqual(built.schema, built.schema);
        if (typeof built.schema === 'object') {
          assert.strictEqual(Object.isFrozen(built.schema), true);
          assert.throws(() => { built.schema.type = 'x'; }, TypeError);
        }
      });

      it('validates against the 2020-12 meta-schema', () => {
        const standalone = s.document(built, { draft: '2020-12' });
        assert.strictEqual(metaSchema(standalone), true);
        assert.strictEqual(metaSchema(built.schema), true);
      });

      it('yields the validator verdicts the corpus states', () => {
        for (const instance of entry.valid) {
          assert.strictEqual(validate(instance), true, `expected valid — ${JSON.stringify(instance)}`);
        }
        for (const instance of entry.invalidShape) {
          assert.strictEqual(validate(instance), false, `expected invalid — ${JSON.stringify(instance)}`);
        }
        for (const instance of entry.invalidWidened) {
          assert.strictEqual(validate(instance), false, `expected invalid (widened) — ${JSON.stringify(instance)}`);
        }
      });

      it('carries the normalize profile exactly when its document holds a normalizer keyword', () => {
        // the plain-named generated declaration is the NORMALIZED shape
        // Infer<> claims only when the generator ran under the profile
        assert.strictEqual(entry.normalize !== undefined, carriesNormalizerKeyword(entry.schema));
        if (entry.normalize !== undefined) assert.strictEqual(entry.normalize, PEN_NORMALIZE);
      });

      if (entry.rawInput !== undefined) {
        it('normalizes every raw input into a valid document', () => {
          const normalize = compileNormalizer(entry.schema, entry.normalize);
          for (const raw of entry.rawInput) {
            assert.strictEqual(validate(normalize(raw)), true,
              `normalizing ${JSON.stringify(raw)} must produce a valid document`);
          }
        });
      }

      it('is pinned in the type gate', () => {
        const pins = fs.readFileSync(PINS, 'utf8');
        const name = entry.name === 'Tree' ? 'Node' : entry.name;
        assert.match(pins, new RegExp(`Equals<Infer<typeof ${name}>, G\\.${entry.name}>`));
        assert.match(pins, new RegExp(`Equals<Input<typeof ${name}>, G\\.${entry.name}(Input)?>`));
      });
    });
  }

  it('the committed generated fixture is exactly what the generator produces today', () => {
    assert.strictEqual(fs.readFileSync(FIXTURE, 'utf8'), renderFixture(),
      'test/consumer/linq-schema-generated.ts is stale — regenerate it with '
      + '`node scripts/generate-schema-pen-fixture.js`');
  });
});

describe('the schema pen — the document is the deliverable', () => {
  it('check() captures the validator README\'s invoice rule through the chain\'s proxy', () => {
    const Invoice = s.object({
      lines: s.array(s.object({ amount: s.number() })),
      total: s.number(),
    }).check((o) => o.total.eq(o.lines.all().amount.sum()));
    assert.deepStrictEqual(Invoice.schema.$query,
      { $eq: ['$.total', { $sum: '$.lines[*].amount' }] });
    const validate = new JarenValidator().compile(Invoice.schema);
    assert.strictEqual(validate({ lines: [{ amount: 12.5 }, { amount: 7.5 }], total: 20 }), true);
    assert.strictEqual(validate({ lines: [{ amount: 12.5 }, { amount: 7.5 }], total: 21 }), false);
  });

  it('check() binds root and path, and nothing else', () => {
    const Line = s.object({ currency: s.string() })
      .check((l, x) => x.root.currency.eq(l.currency).and(x.path.ne('')));
    assert.deepStrictEqual(Line.schema.$query,
      { $and: [{ $eq: ['$root.currency', '$.currency'] }, { $ne: ['$path', ''] }] });
    assert.throws(() => s.object({}).check((o, x) => x.foo.eq(1)),
      (e) => e instanceof LinqBuildError && e.code === 'JL0104' && /'foo'/.test(e.message));
  });

  it('document() adds $schema for a standalone file, and refuses a draft it cannot write', () => {
    const doc = s.document(s.string(), { draft: '2020-12' });
    assert.deepStrictEqual(doc, { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'string' });
    assert.strictEqual(Object.keys(doc)[0], '$schema');
    assert.deepStrictEqual(s.document(s.string()), { type: 'string' });
    assert.throws(() => s.document(s.string(), { draft: /** @type {any} */ ('draft-07') }),
      (e) => e.code === 'JL0102');
  });

  it('structuredClone and JSON.stringify of a builder are the document', () => {
    const b = s.object({ a: s.string().default('x') });
    assert.deepStrictEqual(structuredClone(b.schema), b.schema);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(b)), b.schema);
  });

  it('builders are immutable: every method answers a new builder', () => {
    const a = s.string();
    const b = a.min(3);
    assert.notStrictEqual(a, b);
    assert.deepStrictEqual(a.schema, { type: 'string' });
    assert.deepStrictEqual(b.schema, { type: 'string', minLength: 3 });
    const o = s.object({ a });
    assert.deepStrictEqual(o.open().schema.additionalProperties, undefined);
    assert.strictEqual(o.schema.additionalProperties, false);
  });

  it('a definition reached from two places is hoisted once; the same name twice is a collision', () => {
    const Tag = s.named('Tag', s.string());
    const doc = s.object({ a: Tag, b: s.array(Tag) }).schema;
    assert.deepStrictEqual(Object.keys(doc.$defs), ['Tag']);
    assert.deepStrictEqual(doc.properties.b.items, { $ref: '#/$defs/Tag' });
    const Other = s.named('Tag', s.number());
    assert.throws(() => s.object({ a: Tag, b: Other }).schema,
      (e) => e.code === 'JL0103' && /'Tag'/.test(e.message) && e.docPath === '/properties/b');
    assert.throws(() => s.object({ a: s.ref('Nope') }).schema,
      (e) => e.code === 'JL0103' && /ref\('Nope'\)/.test(e.message));
  });

  it('nullable folds into type, enum and const, and wraps the untyped kinds', () => {
    assert.deepStrictEqual(s.string().nullable().schema, { type: ['string', 'null'] });
    assert.deepStrictEqual(s.enumOf(['a', null]).nullable().schema, { enum: ['a', null] });
    assert.deepStrictEqual(s.literal(1).nullable().schema, { enum: [1, null] });
    assert.deepStrictEqual(s.union([s.string(), s.number()]).nullable().describe('d').schema,
      { anyOf: [{ anyOf: [{ type: 'string' }, { type: 'number' }] }, { type: 'null' }], description: 'd' });
    assert.deepStrictEqual(s.never().nullable().schema, { anyOf: [false, { type: 'null' }] });
    assert.deepStrictEqual(s.any().nullable().schema, { anyOf: [{}, { type: 'null' }] });
  });

  it('union and intersection take hand-written JSON beside builders', () => {
    assert.deepStrictEqual(s.union([s.string(), { type: 'number' }]).schema,
      { anyOf: [{ type: 'string' }, { type: 'number' }] });
    assert.deepStrictEqual(s.intersection([{ minimum: 1 }, true]).schema, { allOf: [{ minimum: 1 }, true] });
  });

  it('a pattern given as a flagless RegExp is taken by its source', () => {
    assert.deepStrictEqual(s.string().pattern(/^a\/b$/).schema, { type: 'string', pattern: '^a\\/b$' });
    assert.throws(() => s.string().pattern(/a/i), (e) => e.code === 'JL0102' && /'i'/.test(e.message));
  });

  it('object reshaping: extend replaces, pick/omit select, partial/required flip', () => {
    const Base = s.object({ id: s.string(), name: s.string() });
    assert.deepStrictEqual(Base.extend({ name: s.number(), x: s.boolean() }).schema.properties,
      { id: { type: 'string' }, name: { type: 'number' }, x: { type: 'boolean' } });
    assert.deepStrictEqual(Base.partial().schema.required, undefined);
    assert.deepStrictEqual(Base.partial().required().schema.required, ['id', 'name']);
    assert.deepStrictEqual(Base.partial().required(['name']).schema.required, ['name']);
    assert.throws(() => Base.pick(['zzz']), (e) => e.code === 'JL0101' && /'zzz'/.test(e.message));
    assert.throws(() => Base.dependentRequired({ id: 'name' }), (e) => e.code === 'JL0101');
  });

  it('a discriminated union needs the tag on every option', () => {
    assert.throws(() => s.discriminated('kind', [s.object({ kind: s.literal('a') }), s.object({ x: s.number() })]),
      (e) => e.code === 'JL0102' && /option 1/.test(e.message));
    assert.throws(() => s.discriminated('kind', [s.string()]), (e) => e.code === 'JL0102');
  });

  it('a when() builder is thenable-shaped and says so when a promise resolves it', async () => {
    const w = s.when(s.string());
    await assert.rejects(Promise.resolve(w), (e) => e.code === 'JL0101' && /not a promise/.test(e.message));
    assert.deepStrictEqual(w.schema, { if: { type: 'string' } });
  });

  it('examples accumulate; meta keeps insertion order; a later annotation replaces an earlier one', () => {
    const b = s.string().example('a').meta({ 'x-a': 1, deprecated: true }).example('b').describe('one').describe('two');
    assert.deepStrictEqual(b.schema,
      { type: 'string', examples: ['a', 'b'], 'x-a': 1, deprecated: true, description: 'two' });
    assert.deepStrictEqual(Object.keys(b.schema), ['type', 'examples', 'x-a', 'deprecated', 'description']);
  });

  it('from() clones the hand-written schema: the document is its own tree', () => {
    const raw = { type: 'object', properties: { a: { type: 'string' } } };
    const doc = s.from(raw).schema;
    assert.deepStrictEqual(doc, raw);
    assert.notStrictEqual(doc.properties, raw.properties);
    raw.properties.a.type = 'number';
    assert.strictEqual(doc.properties.a.type, 'string');
  });

  it('a __proto__ member is data, in properties and in $defs', () => {
    const props = Object.create(null);
    props.__proto__ = s.string();
    const doc = s.object(props).schema;
    assert.deepStrictEqual(Object.keys(doc.properties), ['__proto__']);
    assert.strictEqual(Object.getPrototypeOf(doc.properties), Object.prototype);
    assert.deepStrictEqual(doc.required, ['__proto__']);
  });
});

describe('the schema pen — the chain accepts a builder where a document was', () => {
  const compileTypeTest = createTypeTestCompiler(new JarenValidator());
  const rows = [{ kind: 'a' }, { kind: 1 }, { other: true }, 'x'];
  const Strict = s.object({ kind: s.string() });

  it('ofType/cast unwrap a builder by its brand, on both surfaces', async () => {
    assert.deepStrictEqual(from(rows, { compileTypeTest }).ofType(Strict).toArray(), [{ kind: 'a' }]);
    assert.deepStrictEqual(await fromAsync(rows, { compileTypeTest }).ofType(Strict).toArray(), [{ kind: 'a' }]);
    assert.deepStrictEqual(from(rows, { compileTypeTest }).ofType(Strict).toDocument(),
      from(rows, { compileTypeTest }).ofType(Strict.schema).toDocument());
    assert.throws(() => from(rows, { compileTypeTest }).cast(Strict).toArray(), (e) => e.code === 'JQ2008');
    assert.deepStrictEqual(from([{ kind: 'a' }], { compileTypeTest }).cast(Strict).toArray(), [{ kind: 'a' }]);
  });

  it('a plain document still works unchanged, and a toJSON-carrying object is a schema, not a builder', () => {
    assert.deepStrictEqual(from(rows, { compileTypeTest }).ofType({ type: 'string' }).toArray(), ['x']);
    // a data object with a toJSON member is a schema (used as given, its
    // `type: 'string'` doing the filtering), never a builder to unwrap
    const impostor = { type: 'string', toJSON() { return { type: 'number' }; } };
    assert.strictEqual(s.isSchemaBuilder(impostor), false);
    assert.strictEqual(s.schemaOf(impostor), impostor);
    assert.deepStrictEqual(from(rows, { compileTypeTest }).ofType(impostor).toArray(), ['x']);
    assert.strictEqual(s.isSchemaBuilder(Strict), true);
    assert.strictEqual(s.schemaOf(Strict), Strict.schema);
  });
});

describe('the schema pen — no engine behind it', () => {
  it('imports no validate, emit or db module, and only check.js reaches the capture (through the shared root capture)', async () => {
    const dir = new URL('../../packages/linq/src/schema/', import.meta.url);
    for (const file of fs.readdirSync(dir)) {
      const source = await fs.promises.readFile(new URL(file, dir), 'utf8');
      assert.strictEqual(/from '@jarenjs\/(validate|emit|db)/.test(source), false, `${file} imports an engine`);
      assert.strictEqual(/(expression|capture-root)\.js/.test(source), file === 'check.js', `${file} and the capture machine`);
    }
  });
});
