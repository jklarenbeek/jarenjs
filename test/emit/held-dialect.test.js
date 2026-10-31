//@ts-check
/**
 * @file A `$schema` naming a custom dialect, read as the validator handed
 * as `dialects` reads it: through the meta-schemas it holds, so a dialect
 * extending 2020-12 types a `$ref`'s siblings beside it and its normalized
 * variants fill the defaults beside a `$ref`. Without `dialects` a `$schema`
 * is read by its name alone, and a custom dialect as draft-07.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { emitTypeScript } from '@jarenjs/emit';
import { JarenValidator } from '@jarenjs/validate';
import { compileNormalizer } from '@jarenjs/validate/normalize';
import { deriveStrictProfile } from '@jarenjs/validate/strict-profile';
import { getSchemaDraftByName } from '@jarenjs/refs';

const D20 = 'https://json-schema.org/draft/2020-12/schema';
const MINE = 'https://example.com/my-dialect';
const OUTER = 'https://example.com/outer';
const validator = new JarenValidator().addSchema({ $id: MINE, $schema: D20 }).addSchema({ $id: OUTER, $schema: MINE });

describe('emit — a held custom dialect', () => {
  const typed = { $defs: { S: { type: 'string' } }, $ref: '#/$defs/S', type: 'integer' };
  const intersected = 'export type S = string;\n\n/**\n * Schema constraints this type cannot express: type="integer"\n */\nexport type T = S & number;\n';

  it('types a $ref\'s siblings as 2020-12 itself does, directly or through a chain', () => {
    assert.equal(emitTypeScript({ $schema: D20, ...typed }, { name: 'T', banner: false }), intersected);
    for (const $schema of [MINE, OUTER]) {
      assert.equal(validator.compile({ $schema, ...typed })('12'), false, $schema);
      assert.equal(emitTypeScript({ $schema, ...typed }, { name: 'T', banner: false, dialects: validator }), intersected, $schema);
      // by name alone: draft-07, the target alone
      assert.equal(emitTypeScript({ $schema, ...typed }, { name: 'T', banner: false }), 'export type S = string;\n\nexport type T = S;\n', $schema);
    }
  });

  it('reads the normalized variants through it: a default beside a $ref fills', () => {
    const schema = { $schema: OUTER, type: 'object', properties: { p: { $ref: '#/$defs/n', default: 2 } }, $defs: { n: { type: 'number' } } };
    const ts = emitTypeScript(schema, { name: 'T', banner: false, dialects: validator, normalize: { useDefaults: true } });
    assert.match(ts, /export interface T \{\n {2}p: N;\n/);
    assert.match(ts, /export interface TInput \{\n {2}p\?: N;\n/);
    assert.equal(emitTypeScript(schema, { name: 'T', banner: false, normalize: { useDefaults: true } }),
      'export type N = number;\n\nexport interface T {\n  p?: N;\n  [key: string]: unknown;\n}\n');
  });

  it('refuses a dialects option that is no validator', () => {
    assert.throws(() => emitTypeScript({ $schema: MINE }, { dialects: {} }), { name: 'TypeError' });
  });
});

describe('the readers of a document under a held dialect read it as the document under the draft the validator reads', () => {
  const D07 = 'http://json-schema.org/draft-07/schema#';
  const D19 = 'https://json-schema.org/draft/2019-09/schema';
  const T = 'https://d.test/';
  const VOCAB = 'https://json-schema.org/draft/2020-12/vocab/';
  /** Each dialect, and the known draft the validator reads it as. @type {Record<string, [any, string]>} */
  const DIALECTS = {
    e20: [{ $id: `${T}e20`, $schema: D20, $dynamicAnchor: 'meta', allOf: [{ $ref: D20 }] }, D20],
    e19: [{ $id: `${T}e19`, $schema: D19, $recursiveAnchor: true, allOf: [{ $ref: D19 }] }, D19],
    chain20: [{ $id: `${T}chain20`, $schema: `${T}e20`, $dynamicAnchor: 'meta', allOf: [{ $ref: `${T}e20` }] }, D20],
    chain19: [{ $id: `${T}chain19`, $schema: `${T}e19`, $recursiveAnchor: true, allOf: [{ $ref: `${T}e19` }] }, D19],
    legacy07: [{ $id: `${T}2020-12/legacy`, $schema: D07 }, D07],
    vocabOff: [{ $id: `${T}vocab-off`, $schema: D20, $dynamicAnchor: 'meta', $vocabulary: { [`${VOCAB}core`]: true, [`${VOCAB}applicator`]: true } }, D20],
    unheld: [null, `${T}unheld`],
  };
  const holder = () => {
    const held = new JarenValidator();
    for (const name of ['draft2020-12', 'draft2019-09']) { const draft = getSchemaDraftByName(name); held.addMetaSchema(draft.schema, draft.draft); }
    for (const [meta] of Object.values(DIALECTS)) if (meta) held.addSchema(structuredClone(meta));
    return held;
  };
  /** Document shapes whose reading depends on the draft, each with instances. @type {Record<string, [(uri: string) => any, unknown[]]>} */
  const BODIES = {
    rootRef: [(S) => ({ $schema: S, $defs: { s: { type: 'object', properties: { a: { type: 'string', default: 'x' } } } }, $ref: '#/$defs/s', properties: { b: { type: 'integer', default: 1 } } }),
      [{}, { a: ' y ', b: '2' }, { b: 'n', c: 1 }, { a: 1 }]],
    nestedRef: [(S) => ({ $schema: S, type: 'object', $defs: { n: { type: 'number' } }, properties: { p: { $ref: '#/$defs/n', type: 'integer', default: 2 }, q: { type: 'string' } } }),
      [{}, { p: '3' }, { p: 1.5, q: ' t ' }, { p: '1.5' }]],
    tuple: [(S) => ({ $schema: S, type: 'object', properties: { t: { type: 'array', prefixItems: [{ type: 'integer' }, { type: 'boolean', default: true }], items: { type: 'string' } } } }),
      [{ t: ['1', 'true', 3] }, { t: [1] }, { t: ['x'] }, {}]],
    nestedDialect: [(S) => ({ type: 'object', properties: { r: { $schema: S, $id: 'https://x.test/r.json', $defs: { s: { type: 'object' } }, $ref: '#/$defs/s', properties: { a: { type: 'integer', default: 1 } } } } }),
      [{ r: {} }, { r: { a: '4' } }, {}, { r: 1 }]],
    idBesideRef: [(S) => ({ $schema: S, $id: 'https://x.test/root.json', $defs: { t: { type: 'string', default: 'z' } }, type: 'object', properties: { q: { $id: 'q.json', $defs: { t: { type: 'integer', default: 7 } }, $ref: '#/$defs/t' }, w: { type: 'object', properties: { q: { $ref: 'q.json' } }, default: {} } } }),
      [{}, { q: '5' }, { q: ' s ' }, { w: {} }]],
  };
  const NORMALIZE = [{ useDefaults: true, coerceTypes: true, trimStrings: true }, { removeAdditional: 'all', useDefaults: true }];
  const VALIDATION = ['type', 'enum', 'const', 'required', 'dependentRequired', 'minLength', 'maxLength', 'minItems', 'maxItems',
    'minProperties', 'maxProperties', 'minContains', 'maxContains', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum',
    'multipleOf', 'uniqueItems', 'pattern'];
  const MARK = 'https://d.test/mark';
  /**
   * A body as the draft the validator reads its dialect as: under a dialect
   * leaving the validation vocabulary out (vocabOff), without the
   * validation keywords below the `$schema` naming it.
   * @param {string} name @param {(uri: string) => any} body
   */
  const translate = (name, body) => {
    if (name !== 'vocabOff') return body(DIALECTS[name][1]);
    /** @param {any} node @param {boolean} off @returns {any} */
    const drop = (node, off) => {
      if (Array.isArray(node)) return node.map((item) => drop(item, off));
      if (node === null || typeof node !== 'object') return node;
      if (node.$schema === MARK) off = true;
      return Object.fromEntries(Object.entries(node).filter(([key]) => !(off && VALIDATION.includes(key)))
        .map(([key, value]) => [key, key === 'default' || key === 'const' || key === 'enum' ? value : drop(value, off)])
        .map(([key, value]) => [key, value === MARK ? DIALECTS[name][1] : value]));
    };
    return drop(body(MARK), false);
  };
  /** @param {() => unknown} fn */
  const outcome = (fn) => { try { return JSON.stringify(fn()); } catch (e) { return `throws ${/** @type {any} */ (e).code ?? /** @type {any} */ (e).name}`; } };

  it('normalizes, emits and derives a strict profile alike, with the option; by name alone, not', () => {
    /** @param {boolean} withOption */
    const census = (withOption) => {
      const counts = { normalized: 0, normalizedDiffer: 0, emitted: 0, emittedDiffer: 0, profiles: 0, profilesDiffer: 0 };
      for (const name of Object.keys(DIALECTS)) for (const [body, instances] of Object.values(BODIES)) {
        const held = holder();
        const uri = DIALECTS[name][0]?.$id ?? DIALECTS[name][1];
        const document = body(uri);
        const translated = translate(name, body);
        const option = withOption ? { dialects: held } : {};
        for (const options of NORMALIZE) for (const instance of instances) {
          counts.normalized++;
          if (outcome(() => compileNormalizer(document, { ...options, ...option })(structuredClone(instance)))
            !== outcome(() => compileNormalizer(translated, options)(structuredClone(instance)))) counts.normalizedDiffer++;
        }
        for (const options of [{}, { normalize: { useDefaults: true, coerceTypes: true } }]) {
          counts.emitted++;
          if (outcome(() => emitTypeScript(document, { name: 'T', ...options, ...option })) !== outcome(() => emitTypeScript(translated, { name: 'T', ...options }))) counts.emittedDiffer++;
        }
        counts.profiles++;
        /** @param {any} schema @param {object} options */
        const profile = (schema, options) => outcome(() => {
          const derived = deriveStrictProfile(schema, options);
          return [derived.schema, instances.map((instance) => outcome(() => derived.fromProfile(derived.toProfile(instance))))];
        }).replaceAll(JSON.stringify(uri), '"$schema"').replaceAll(JSON.stringify(DIALECTS[name][1]), '"$schema"');
        if (profile(document, option) !== profile(translated, {})) counts.profilesDiffer++;
      }
      return counts;
    };
    assert.deepEqual(census(true), { normalized: 280, normalizedDiffer: 0, emitted: 70, emittedDiffer: 0, profiles: 35, profilesDiffer: 0 });
    // the translation is the validator's reading: it answers alike on both
    for (const name of Object.keys(DIALECTS)) for (const [body, instances] of Object.values(BODIES)) {
      const held = holder();
      const uri = DIALECTS[name][0]?.$id ?? DIALECTS[name][1];
      const verdicts = (/** @type {any} */ schema) => outcome(() => { const validate = held.compile(schema); return instances.map((instance) => validate(structuredClone(instance))); });
      assert.equal(verdicts(body(uri)), verdicts(translate(name, body)), `${name} ${body.toString().slice(0, 40)}`);
    }
    // By name alone a custom dialect reads as draft-07, where `prefixItems`
    // is no keyword: the tuple body under each dialect extending 2020-12
    // (e20, chain20, vocabOff) emits an array, not its translation's tuple.
    // Under vocabOff the translation reads no validation keyword, while the
    // name alone reads them: `type` coerces `p` of nestedRef (2 more
    // normalizations differ) where the translation, like draft-07's `$ref`
    // read alone, leaves `b` of rootRef, `a` of nestedDialect and `q` of
    // idBesideRef as sent (3 fewer); the tuple body's profile differs too.
    assert.deepEqual(census(false), { normalized: 280, normalizedDiffer: 70, emitted: 70, emittedDiffer: 46, profiles: 35, profilesDiffer: 21 });
  });
});
