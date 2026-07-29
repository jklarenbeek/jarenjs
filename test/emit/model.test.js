//@ts-check
/**
 * @file Stage-one behaviour: the flattening decisions that no stylesheet can
 * make for itself — naming, cycles, composition, and honest widening.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';

import { compileEmitModel, EMIT_MODEL_VERSION } from '@jarenjs/emit/model';
import { emitTypeScript } from '@jarenjs/emit/typescript';
import { emitMarkdown } from '@jarenjs/emit/markdown';

const names = (model) => model.declarations.map((d) => d.name);
const decl = (model, name) => model.declarations.find((d) => d.name === name);

describe('compileEmitModel — declarations and naming', () => {
  it('declares $defs in document order, then the root', () => {
    const model = compileEmitModel({
      $defs: { Beta: { type: 'string' }, Alpha: { type: 'number' } },
      type: 'object',
    }, { name: 'Doc' });
    assert.deepStrictEqual(names(model), ['Beta', 'Alpha', 'Doc']);
    assert.strictEqual(model.$emit, EMIT_MODEL_VERSION);
    assert.strictEqual(model.root, 'Doc');
  });

  it('turns an awkward name into a safe identifier', () => {
    const model = compileEmitModel({ $defs: { 'user-account': { type: 'string' } } }, { name: 'R' });
    assert.ok(names(model).includes('UserAccount'));
  });

  it('never collides two declarations onto one name', () => {
    const model = compileEmitModel({
      $defs: { 'user account': { type: 'string' }, 'user-account': { type: 'number' } },
    }, { name: 'R' });
    const declared = names(model);
    assert.strictEqual(new Set(declared).size, declared.length, `collision in ${declared}`);
  });

  it('breaks a self-reference by name instead of recursing forever', () => {
    const model = compileEmitModel({
      type: 'object', properties: { next: { $ref: '#' } },
    }, { name: 'Node' });
    assert.deepStrictEqual(decl(model, 'Node').type.members[0].type, { kind: 'ref', ref: 'Node' });
  });

  it('breaks mutual recursion between $defs', () => {
    const model = compileEmitModel({
      $defs: {
        A: { type: 'object', properties: { b: { $ref: '#/$defs/B' } } },
        B: { type: 'object', properties: { a: { $ref: '#/$defs/A' } } },
      },
      $ref: '#/$defs/A',
    }, { name: 'Root' });
    assert.deepStrictEqual(decl(model, 'A').type.members[0].type, { kind: 'ref', ref: 'B' });
    assert.deepStrictEqual(decl(model, 'B').type.members[0].type, { kind: 'ref', ref: 'A' });
  });
});

describe('compileEmitModel — composition', () => {
  const shape = (schema) => compileEmitModel(schema, { name: 'X' }).declarations.at(-1).type;

  it('maps allOf to an intersection and anyOf/oneOf to a union', () => {
    assert.strictEqual(shape({ allOf: [{ type: 'object' }, { type: 'object' }] }).kind, 'intersection');
    assert.strictEqual(shape({ anyOf: [{ type: 'string' }, { type: 'number' }] }).kind, 'union');
    assert.strictEqual(shape({ oneOf: [{ type: 'string' }, { type: 'number' }] }).kind, 'union');
  });

  it('collapses a union of one and drops never from a union', () => {
    assert.strictEqual(shape({ anyOf: [{ type: 'string' }] }).kind, 'primitive');
    assert.strictEqual(shape({ anyOf: [{ type: 'string' }, false] }).kind, 'primitive');
  });

  it('maps const and enum to literals', () => {
    assert.deepStrictEqual(shape({ const: 7 }), { kind: 'literal', value: 7 });
    assert.strictEqual(shape({ enum: ['a', 'b'] }).kind, 'union');
  });

  it('maps a type union across object and primitive forms', () => {
    const t = shape({ type: ['string', 'null'] });
    assert.strictEqual(t.kind, 'union');
    assert.deepStrictEqual(t.options.map((o) => o.primitive), ['string', 'null']);
  });

  it('widens an index signature to cover the declared members', () => {
    // TypeScript requires it, so a model that did not do this would emit
    // declarations that fail to compile.
    const t = shape({
      type: 'object',
      properties: { a: { type: 'number' } },
      additionalProperties: { type: 'string' },
    });
    assert.strictEqual(t.index.kind, 'union');
  });

  it('reads both tuple spellings', () => {
    assert.strictEqual(shape({ type: 'array', prefixItems: [{ type: 'string' }] }).kind, 'tuple');
    assert.strictEqual(shape({ type: 'array', items: [{ type: 'string' }] }).kind, 'tuple');
    assert.strictEqual(shape({ type: 'array', items: { type: 'string' } }).kind, 'array');
  });
});

describe('compileEmitModel — honest widening', () => {
  it('records the constraints a type cannot carry rather than dropping them', () => {
    const model = compileEmitModel({
      type: 'object',
      properties: { s: { type: 'string', minLength: 2, pattern: '^a', format: 'email' } },
    }, { name: 'X' });
    const member = decl(model, 'X').type.members[0];
    assert.deepStrictEqual(member.constraints.map((c) => c.keyword),
      ['minLength', 'pattern', 'format']);
    assert.match(member.doc.join(' '), /minLength=2/);
  });

  it('says nothing when there is nothing to say', () => {
    const model = compileEmitModel({ type: 'object', properties: { s: { type: 'string' } } }, { name: 'X' });
    assert.deepStrictEqual(decl(model, 'X').type.members[0].doc, []);
  });

  it('leaves an unresolvable $ref as unknown rather than guessing', () => {
    const model = compileEmitModel({
      type: 'object', properties: { x: { $ref: 'https://example.com/other#' } },
    }, { name: 'X' });
    assert.deepStrictEqual(decl(model, 'X').type.members[0].type, { kind: 'unknown' });
  });
});

describe('emitters', () => {
  const schema = {
    $defs: { Id: { type: 'string', description: 'An id' } },
    type: 'object',
    description: 'A user',
    properties: {
      id: { $ref: '#/$defs/Id' },
      role: { enum: ['admin', 'user'] },
      meta: { type: 'object', additionalProperties: { type: 'string' } },
      pair: { type: 'array', prefixItems: [{ type: 'string' }, { type: 'number' }] },
    },
    required: ['id'],
  };

  it('emits TypeScript with interfaces, aliases, unions and optionality', () => {
    const ts = emitTypeScript(schema, { name: 'User' });
    assert.match(ts, /export type Id = string;/);
    assert.match(ts, /export interface User \{/);
    assert.match(ts, /\bid: Id;/);
    assert.match(ts, /role\?: "admin" \| "user";/);
    assert.match(ts, /\[key: string\]: string;/);
    assert.match(ts, /pair\?: \[string, number\];/);
    assert.match(ts, /\* A user/);
  });

  it('emits the same model as Markdown without the model changing', () => {
    // The second target is the evidence that the model is a real contract
    // rather than the TypeScript printer's private state.
    const md = emitMarkdown(schema, { name: 'User' });
    assert.match(md, /^## Id$/m);
    assert.match(md, /^## User$/m);
    assert.match(md, /\| Member \| Type \| Required \|/);
    assert.match(md, /\| `id` \| `Id` \| yes \|/);
    assert.match(md, /"admin" or "user"/);
  });

  it('can omit the banner', () => {
    assert.ok(!emitTypeScript(schema, { name: 'User', banner: false }).startsWith('//'));
  });
});

describe('the model format is a real contract', () => {
  it('validates every model this package produces against its published schema', async () => {
    // If the emitters and the schema can drift, the "published format" claim
    // is decoration. This is what keeps it true.
    const { JarenValidator } = await import('@jarenjs/validate');
    const { readFileSync } = await import('node:fs');
    const modelSchema = JSON.parse(readFileSync(
      new URL('../../packages/emit/schemas/jaren-emit-model.schema.json', import.meta.url), 'utf8'));
    const validate = new JarenValidator({ collectErrors: true }).compile(modelSchema);

    const corpus = [
      { type: 'object', properties: { a: { type: 'string', minLength: 1 } }, required: ['a'] },
      { $defs: { A: { type: 'object', properties: { b: { $ref: '#/$defs/B' } } }, B: { type: 'string' } }, $ref: '#/$defs/A' },
      { type: 'array', prefixItems: [{ type: 'string' }], items: { type: 'number' } },
      { anyOf: [{ type: 'string' }, { type: 'number' }] },
      { allOf: [{ type: 'object' }, { type: 'object', properties: { x: {} } }] },
      { type: 'object', additionalProperties: { type: 'string' } },
      { enum: ['a', 'b'] },
      { type: 'object', properties: { self: { $ref: '#' } } },
    ];
    for (const schema of corpus) {
      const model = compileEmitModel(schema, { name: 'Probe' });
      const result = validate(model);
      assert.strictEqual(result.valid, true,
        `model for ${JSON.stringify(schema)} violates the published format: `
        + JSON.stringify(result.errors.slice(0, 3)));
    }

    // Variant pairs are part of the published format too, so they have to
    // validate against it — including the document-level `variants` flag and
    // the `variant`/`variantOf` members the pair adds.
    const paired = compileEmitModel({
      type: 'object',
      properties: {
        host: { type: 'string', default: 'localhost' },
        port: { type: 'integer', default: 8080 },
      },
    }, { name: 'Probe', normalize: { useDefaults: true, coerceTypes: true } });
    const pairedResult = validate(paired);
    assert.strictEqual(pairedResult.valid, true,
      'a variant model violates the published format: '
      + JSON.stringify(pairedResult.errors.slice(0, 3)));
    assert.strictEqual(paired.variants, true);
    assert.ok(paired.declarations.some((d) => d.variant === 'accepted' && d.variantOf === 'Probe'));
  });
});

describe('the package barrel and third-party models', () => {
  it('re-exports the public surface from the package root', async () => {
    const emit = await import('@jarenjs/emit');
    for (const name of ['compileEmitModel', 'EMIT_MODEL_VERSION',
      'emitTypeScript', 'renderTypeScript', 'TYPESCRIPT_STYLESHEET',
      'emitMarkdown', 'renderMarkdown', 'MARKDOWN_STYLESHEET']) {
      assert.ok(name in emit, `@jarenjs/emit should export ${name}`);
    }
  });

  it('renders a hand-authored model, including forms this compiler never emits', async () => {
    // The model is a published contract, so an emitter must handle every form
    // the format allows — not merely the subset `compileEmitModel` happens to
    // produce. `record` is exactly that case: the analysis pass expresses an
    // open object as `object` + `index`, but another producer may emit
    // `record`, and the emitters have to render it.
    const { renderTypeScript } = await import('@jarenjs/emit/typescript');
    const { renderMarkdown } = await import('@jarenjs/emit/markdown');
    const model = {
      $emit: '0.1', source: null, root: 'Bag',
      declarations: [{
        kind: 'declaration', name: 'Bag', constraints: [], doc: ['A bag'],
        type: { kind: 'record', value: { kind: 'primitive', primitive: 'number' } },
      }, {
        kind: 'declaration', name: 'Mixed', constraints: [], doc: [],
        type: {
          kind: 'intersection',
          parts: [{ kind: 'ref', ref: 'Bag' }, { kind: 'unknown' }],
        },
      }, {
        kind: 'declaration', name: 'Rest', constraints: [], doc: [],
        type: {
          kind: 'tuple',
          items: [{ kind: 'primitive', primitive: 'string' }],
          rest: { kind: 'primitive', primitive: 'number' },
        },
      }, {
        kind: 'declaration', name: 'Nothing', constraints: [], doc: [],
        type: { kind: 'never' },
      }],
    };
    const ts = renderTypeScript(model);
    assert.match(ts, /export type Bag = Record<string, number>;/);
    assert.match(ts, /export type Mixed = Bag & unknown;/);
    assert.match(ts, /export type Rest = \[string, \.\.\.Array<number>\];/);
    assert.match(ts, /export type Nothing = never;/);

    const md = renderMarkdown(model);
    assert.match(md, /map of number/);
    assert.match(md, /Bag and any/);
  });
});

describe('compileEmitModel — accepted and normalized variants', () => {
  const config = {
    type: 'object',
    properties: {
      host: { type: 'string', default: 'localhost' },
      port: { type: 'integer', default: 8080 },
      name: { type: 'string' },
    },
    required: ['name'],
  };
  const withVariants = (schema, normalize, name = 'Config') =>
    compileEmitModel(schema, { name, normalize });

  it('emits no variants at all when normalization is not configured', () => {
    const model = compileEmitModel(config, { name: 'Config' });
    assert.strictEqual(model.variants, undefined);
    assert.ok(model.declarations.every((d) => d.variant === undefined));
  });

  it('marks the pair and links the accepted side to its counterpart', () => {
    const model = withVariants(config, { useDefaults: true });
    assert.strictEqual(model.variants, true);
    const normalized = model.declarations.find((d) => d.variant === 'normalized');
    const accepted = model.declarations.find((d) => d.variant === 'accepted');
    assert.strictEqual(normalized.name, 'Config');
    assert.strictEqual(accepted.name, 'ConfigInput');
    assert.strictEqual(accepted.variantOf, 'Config');
  });

  it('moves a defaulted member from optional on input to present on output', () => {
    // This asymmetry is the entire reason the two variants exist.
    const model = withVariants(config, { useDefaults: true });
    const member = (variant, name) => model.declarations
      .find((d) => d.variant === variant).type.members.find((m) => m.name === name);
    assert.strictEqual(member('normalized', 'host').required, true);
    assert.strictEqual(member('accepted', 'host').required, false);
    // A member without a default is unaffected in either direction.
    assert.strictEqual(member('normalized', 'name').required, true);
    assert.strictEqual(member('accepted', 'name').required, true);
  });

  it('widens the accepted side to what the normalizer converts from', () => {
    const model = withVariants(config, { coerceTypes: true });
    const port = (variant) => model.declarations
      .find((d) => d.variant === variant).type.members.find((m) => m.name === 'port');
    assert.deepStrictEqual(port('normalized').type, { kind: 'primitive', primitive: 'number' });
    assert.deepStrictEqual(port('accepted').type.options.map((o) => o.primitive),
      ['number', 'string']);
  });

  it('twins only the types that actually differ', () => {
    // A schema with one defaulted field must not double every declaration.
    const schema = {
      $defs: {
        Address: { type: 'object', properties: { city: { type: 'string' } } },
        Settings: { type: 'object', properties: { theme: { type: 'string', default: 'dark' } } },
      },
      type: 'object',
      properties: { home: { $ref: '#/$defs/Address' }, settings: { $ref: '#/$defs/Settings' } },
    };
    const model = withVariants(schema, { useDefaults: true }, 'User');
    const twinned = model.declarations
      .filter((d) => d.variant === 'accepted').map((d) => d.variantOf);
    assert.ok(!twinned.includes('Address'), 'Address has no difference and must be shared');
    assert.ok(twinned.includes('Settings'), 'Settings has a default and must be twinned');
    assert.ok(twinned.includes('User'), 'User contains a differing type, so it differs too');
  });

  it('honours a per-node predicate exactly as the normalizer does', () => {
    // The switch resolution is imported from @jarenjs/validate/normalize
    // rather than reimplemented: two copies of this rule would drift, and a
    // variant that disagrees with the normalizer is worse than none.
    const schema = {
      type: 'object',
      properties: {
        a: { type: 'integer', 'x-coerce': true },
        b: { type: 'integer' },
      },
    };
    const model = withVariants(schema, { coerceTypes: (n) => n['x-coerce'] === true });
    const accepted = model.declarations.find((d) => d.variant === 'accepted');
    assert.strictEqual(accepted.type.members.find((m) => m.name === 'a').type.kind, 'union');
    assert.strictEqual(accepted.type.members.find((m) => m.name === 'b').type.kind, 'primitive');
  });

  it('agrees with what compileNormalizer actually does', async () => {
    // The claim the variants make is testable, so it is tested: the value the
    // normalizer produces must satisfy the normalized side, and the value it
    // accepts must satisfy the accepted side.
    const { compileNormalizer } = await import('@jarenjs/validate/normalize');
    const options = { useDefaults: true, coerceTypes: true };
    const normalize = compileNormalizer(config, options);
    const model = withVariants(config, options);

    const raw = { name: 'x', port: '9000' };
    const shaped = normalize(raw);
    // defaulted members are absent on the way in and present on the way out
    assert.strictEqual(Object.hasOwn(raw, 'host'), false);
    assert.strictEqual(Object.hasOwn(shaped, 'host'), true);
    assert.strictEqual(shaped.port, 9000);

    const normalized = model.declarations.find((d) => d.variant === 'normalized');
    for (const m of normalized.type.members) {
      if (!m.required) continue;
      assert.ok(Object.hasOwn(shaped, m.name),
        `${m.name} is required on the normalized side but the normalizer did not produce it`);
    }
  });

  it('renders both sides as TypeScript', () => {
    const ts = emitTypeScript(config, { name: 'Config', normalize: { useDefaults: true, coerceTypes: true } });
    assert.match(ts, /export interface Config \{/);
    assert.match(ts, /export interface ConfigInput \{/);
    assert.match(ts, /\bhost: string;/);        // present after normalizing
    assert.match(ts, /host\?: string \| number \| boolean;/); // optional and widened before
    assert.match(ts, /Accepted input for Config/);
  });

  it('lets the accepted suffix be chosen', () => {
    const model = compileEmitModel(config,
      { name: 'Config', normalize: { useDefaults: true }, variantSuffix: 'Raw' });
    assert.ok(model.declarations.some((d) => d.name === 'ConfigRaw'));
  });
});
