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
  it('resolves percent-encoded same-document references through the normalizer resolver', () => {
    const model = compileEmitModel({
      $defs: { 'a b': { type: 'integer' } },
      type: 'object',
      properties: { port: { $ref: '#/$defs/a%20b' } },
    });
    assert.deepStrictEqual(decl(model, 'Root').type.members[0].type, { kind: 'ref', ref: 'AB' });
  });

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

  it('steps around reserved names, so bundled models share one name space', () => {
    const schema = { $defs: { Id: { type: 'string' } }, $ref: '#/$defs/Id' };
    const model = compileEmitModel(schema, { name: 'Root', reserved: ['Id', 'Root'] });
    assert.deepStrictEqual(names(model), ['Id2', 'Root2']);
    assert.deepStrictEqual(decl(model, 'Root2').type, { kind: 'ref', ref: 'Id2' });
    assert.strictEqual(model.root, 'Root2');
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

  it('includes pattern values beside typed additional properties in the index', () => {
    const t = shape({
      type: 'object',
      properties: { enabled: { type: 'boolean' } },
      required: ['enabled'],
      patternProperties: { '^x': { type: 'string' } },
      additionalProperties: { type: 'number' },
    });
    assert.deepStrictEqual(t.index, {
      kind: 'union',
      options: [
        { kind: 'primitive', primitive: 'number' },
        { kind: 'primitive', primitive: 'string' },
        { kind: 'primitive', primitive: 'boolean' },
      ],
    });
  });

  it('reads both tuple spellings', () => {
    assert.strictEqual(shape({ type: 'array', prefixItems: [{ type: 'string' }] }).kind, 'tuple');
    assert.strictEqual(shape({ type: 'array', items: [{ type: 'string' }] }).kind, 'tuple');
    assert.strictEqual(shape({ type: 'array', items: { type: 'string' } }).kind, 'array');
  });
});

describe('compileEmitModel — tuple cardinality and rest', () => {
  const shape = (schema) => compileEmitModel(schema, { name: 'X' }).declarations.at(-1).type;

  it('marks only the minItems prefix required and leaves the rest open', () => {
    // JSON Schema accepts shorter and longer arrays: prefixItems constrains
    // the positions that exist, minItems says how many must exist, and an
    // omitted `items` does not close the array.
    const t = shape({ type: 'array', prefixItems: [{ type: 'string' }, { type: 'number' }], minItems: 1 });
    assert.deepStrictEqual(t.items[0], { kind: 'primitive', primitive: 'string' });
    assert.deepStrictEqual(t.items[1],
      { kind: 'optional', item: { kind: 'primitive', primitive: 'number' } });
    assert.deepStrictEqual(t.rest, { kind: 'unknown' });
  });

  it('emits every position optional when minItems is absent', () => {
    const t = shape({ type: 'array', prefixItems: [{ type: 'string' }] });
    assert.strictEqual(t.items[0].kind, 'optional');
  });

  it('closes the tuple only when the schema closes it', () => {
    const closed = shape({
      type: 'array', prefixItems: [{ type: 'string' }], items: false, minItems: 1,
    });
    assert.deepStrictEqual(closed,
      { kind: 'tuple', items: [{ kind: 'primitive', primitive: 'string' }] });
  });

  it('reads the draft-07 rest through additionalItems', () => {
    const t = shape({ type: 'array', items: [{ type: 'string' }], additionalItems: { type: 'number' } });
    assert.deepStrictEqual(t.rest, { kind: 'primitive', primitive: 'number' });
    const open = shape({ type: 'array', items: [{ type: 'string' }] });
    assert.deepStrictEqual(open.rest, { kind: 'unknown' });
  });

  it('collapses an empty prefix with a rest into an array', () => {
    // `[, ...Array<T>]` is not TypeScript; a tuple of nothing-but-rest IS an
    // array, and EMIT-FORMAT §5 makes the collapse a producer obligation.
    assert.deepStrictEqual(shape({ type: 'array', prefixItems: [], items: { type: 'number' } }),
      { kind: 'array', items: { kind: 'primitive', primitive: 'number' } });
    assert.deepStrictEqual(shape({ type: 'array', prefixItems: [], items: false }),
      { kind: 'tuple', items: [] });
  });
});

describe('compileEmitModel — no type inference from applicators', () => {
  const shape = (schema) => compileEmitModel(schema, { name: 'X' }).declarations.at(-1).type;

  it('widens an untyped node with properties to every other JSON kind', () => {
    // `properties` applies only when the value happens to be an object; the
    // validator accepts a primitive without reading it, so inferring
    // `object` emitted a type narrower than the schema.
    const t = shape({ properties: { a: { type: 'string' } }, required: ['a'] });
    assert.strictEqual(t.kind, 'union');
    assert.deepStrictEqual(t.options.map((o) => o.kind),
      ['object', 'array', 'primitive', 'primitive', 'primitive', 'primitive']);
    assert.strictEqual(t.options[0].members[0].required, true);
  });

  it('widens an untyped node with items the same way', () => {
    const t = shape({ items: { type: 'string' } });
    assert.strictEqual(t.kind, 'union');
    assert.deepStrictEqual(t.options.map((o) => o.kind),
      ['array', 'record', 'primitive', 'primitive', 'primitive', 'primitive']);
  });

  it('keeps the declared container when type says so', () => {
    assert.strictEqual(shape({ type: 'object', properties: { a: {} } }).kind, 'object');
  });
});

describe('compileEmitModel — refs', () => {
  it('aliases a root $ref instead of emitting unknown', () => {
    const model = compileEmitModel({
      $defs: { Uuid: { type: 'string' } }, $ref: '#/$defs/Uuid',
    }, { name: 'Id' });
    assert.strictEqual(model.root, 'Id');
    assert.deepStrictEqual(decl(model, 'Id').type, { kind: 'ref', ref: 'Uuid' });
  });

  it('intersects $ref siblings with their target', () => {
    const model = compileEmitModel({
      $defs: { Base: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
      $ref: '#/$defs/Base',
      type: 'object',
      properties: { extra: { type: 'number' } },
      required: ['extra'],
    }, { name: 'X' });
    const t = decl(model, 'X').type;
    assert.strictEqual(t.kind, 'intersection');
    assert.deepStrictEqual(t.parts[0], { kind: 'ref', ref: 'Base' });
    assert.strictEqual(t.parts[1].kind, 'object');
  });

  it('resolves a plain-anchor $ref exactly as the normalizer does', () => {
    const model = compileEmitModel({
      $defs: { Target: { $anchor: 'here', type: 'string' } },
      type: 'object',
      properties: { v: { $ref: '#here' } },
    }, { name: 'X' });
    assert.deepStrictEqual(decl(model, 'X').type.members[0].type, { kind: 'ref', ref: 'Target' });
  });

  it('does not resolve an anchor inside an embedded $id resource', () => {
    // The same-document scope boundary the normalizer uses: a subtree with
    // its own $id is a different resource.
    const model = compileEmitModel({
      $defs: { Other: { $id: 'https://example.com/other', $anchor: 'here', type: 'string' } },
      type: 'object',
      properties: { v: { $ref: '#here' } },
      additionalProperties: false,
    }, { name: 'X' });
    assert.deepStrictEqual(decl(model, 'X').type.members[0].type, { kind: 'unknown' });
  });

  it('leaves a direct self-reference out of the shape', () => {
    const model = compileEmitModel({ $ref: '#' }, { name: 'X' });
    assert.deepStrictEqual(decl(model, 'X').type, { kind: 'unknown' });
  });
});

describe('compileEmitModel — closed and boolean shapes', () => {
  it('emits a closed empty object as a record of never', () => {
    // An empty interface is TypeScript's weak-type escape hatch: a primitive
    // satisfies it, which certifies data the validator rejects.
    const model = compileEmitModel({ type: 'object', additionalProperties: false }, { name: 'X' });
    assert.deepStrictEqual(decl(model, 'X').type, { kind: 'record', value: { kind: 'never' } });
  });

  it('keeps an open empty object an object', () => {
    const model = compileEmitModel({ type: 'object' }, { name: 'X' });
    assert.deepStrictEqual(decl(model, 'X').type,
      { kind: 'object', members: [], index: { kind: 'unknown' } });
  });

  it('declares every boolean $defs name once, even when referenced twice', () => {
    const model = compileEmitModel({
      $defs: { Any: true, None: false },
      type: 'object',
      properties: {
        a: { $ref: '#/$defs/Any' },
        b: { $ref: '#/$defs/Any' },
        c: { $ref: '#/$defs/None' },
      },
    }, { name: 'X' });
    const declared = names(model);
    assert.deepStrictEqual(declared, ['Any', 'None', 'X']);
    assert.strictEqual(new Set(declared).size, declared.length);
    // Both references share the one declaration.
    const members = decl(model, 'X').type.members;
    assert.deepStrictEqual(members[0].type, { kind: 'ref', ref: 'Any' });
    assert.deepStrictEqual(members[1].type, { kind: 'ref', ref: 'Any' });
    assert.deepStrictEqual(members[2].type, { kind: 'ref', ref: 'None' });
  });

  it('emits one declaration for a boolean root under normalization options', () => {
    const model = compileEmitModel(true, { name: 'Anything', normalize: { useDefaults: true } });
    assert.deepStrictEqual(names(model), ['Anything']);
    assert.strictEqual(model.root, 'Anything');
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

  it('records integer-ness, conditionals and the other silent widenings', () => {
    const model = compileEmitModel({
      type: 'object',
      properties: {
        n: { type: 'integer' },
        c: { if: { type: 'string' }, then: { minLength: 1 } },
        x: { not: { const: 'no' } },
        u: { type: 'object', unevaluatedProperties: false },
        p: { type: 'object', patternProperties: { '^x-': { type: 'string' } } },
        d: { type: 'object', dependentSchemas: { a: { required: ['b'] } } },
      },
    }, { name: 'X' });
    const constraintsOf = (name) => decl(model, 'X').type.members
      .find((m) => m.name === name).constraints.map((c) => c.keyword);
    assert.deepStrictEqual(constraintsOf('n'), ['type']);
    assert.deepStrictEqual(constraintsOf('c'), ['if', 'then']);
    assert.deepStrictEqual(constraintsOf('x'), ['not']);
    assert.deepStrictEqual(constraintsOf('u'), ['unevaluatedProperties']);
    assert.deepStrictEqual(constraintsOf('p'), ['patternProperties']);
    assert.deepStrictEqual(constraintsOf('d'), ['dependentSchemas']);
  });

  it('does not record the asserting-nothing forms', () => {
    // A lone then/else is inert, and `unevaluatedProperties: true` allows
    // everything: recording either would claim a constraint that is not there.
    const model = compileEmitModel({
      type: 'object',
      properties: {
        t: { then: { minLength: 1 } },
        u: { type: 'object', unevaluatedProperties: true },
      },
    }, { name: 'X' });
    for (const member of decl(model, 'X').type.members)
      assert.deepStrictEqual(member.constraints, [], member.name);
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
    // An open tuple: prefixItems does not fix the length, and the omitted
    // `items` leaves the array open.
    assert.match(ts, /pair\?: \[string\?, number\?, \.\.\.Array<unknown>\];/);
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

  it('keeps a required member with a default optional on the accepted side', () => {
    // The normalizer materializes the default BEFORE validation runs, so a
    // caller may omit the member even though `required` lists it.
    const model = withVariants({
      type: 'object',
      properties: { retries: { type: 'integer', default: 3 } },
      required: ['retries'],
    }, { useDefaults: true }, 'Job');
    const member = (variant) => model.declarations
      .find((d) => d.variant === variant).type.members[0];
    assert.strictEqual(member('normalized').required, true);
    assert.strictEqual(member('accepted').required, false);
  });

  it('widens an accepted enum by the sources coercion can actually reach', () => {
    const enumConfig = (schema) => withVariants({
      type: 'object', properties: { v: schema },
    }, { coerceTypes: true }).declarations
      .find((d) => d.variant === 'accepted').type.members[0].type;

    // '2' coerces to 2, so the integer enum admits the transport string...
    assert.deepStrictEqual(enumConfig({ type: 'integer', enum: [1, 2] }).options.at(-1),
      { kind: 'primitive', primitive: 'string' });
    // ...but no number ever becomes 'admin', so the string enum widens by
    // nothing at all.
    assert.deepStrictEqual(enumConfig({ type: 'string', enum: ['admin', 'user'] }).options.map((o) => o.kind),
      ['literal', 'literal']);
    // 'true' does coerce into a boolean-typed literal.
    assert.deepStrictEqual(enumConfig({ type: 'boolean', const: true }).options.at(-1),
      { kind: 'primitive', primitive: 'string' });
    // Without a single string-valued type there is no coercion to mirror,
    // so nothing differs and no twin exists at all.
    const typeless = withVariants({
      type: 'object', properties: { v: { enum: [1, 2] } },
    }, { coerceTypes: true });
    assert.ok(!typeless.declarations.some((d) => d.variant === 'accepted'));
  });

  it('does not widen a union-typed scalar — coerceToType never runs on one', () => {
    // buildScalarStep coerces only a single string-valued `type`; mirroring
    // anything else would accept input the normalizer will not convert.
    const model = withVariants({
      type: 'object',
      properties: { v: { type: ['integer', 'string'] } },
    }, { coerceTypes: true });
    assert.ok(!model.declarations.some((d) => d.variant === 'accepted'),
      'a union type coerces nothing, so nothing differs and no twin exists');
  });
});

describe('compileEmitModel — normalization stops at anyOf/oneOf, like the runtime', () => {
  // compileNormalizer does not descend union branches: which branch applies
  // is only known after validating. The variant analysis has to answer
  // exactly the same way, or the generated pair describes runtime behavior
  // that does not happen.

  it('gives no twin to a schema whose only normalization sits under anyOf', () => {
    const model = compileEmitModel({
      type: 'object',
      properties: {
        u: { anyOf: [{ type: 'object', properties: { p: { type: 'string', default: 'x' } } }, { type: 'null' }] },
      },
    }, { name: 'R', normalize: { useDefaults: true } });
    assert.strictEqual(model.variants, true);
    assert.ok(!model.declarations.some((d) => d.variant === 'accepted'),
      'the runtime never materializes that default, so nothing differs');
    // ...and the branch member is not upgraded to required either.
    const u = decl(model, 'R').type.members[0].type;
    assert.strictEqual(u.options[0].members[0].required, false);
  });

  it('points a union branch at the PLAIN reading of a def that differs', async () => {
    const schema = {
      $defs: { D: { type: 'object', properties: { p: { type: 'string', default: 'x' } } } },
      type: 'object',
      properties: {
        direct: { $ref: '#/$defs/D' },
        union: { anyOf: [{ $ref: '#/$defs/D' }, { type: 'null' }] },
      },
    };
    const options = { useDefaults: true };
    const model = compileEmitModel(schema, { name: 'R', normalize: options });

    // The def itself differs, so the pair exists for the direct use...
    const d = decl(model, 'D');
    assert.strictEqual(d.type.members[0].required, true);
    assert.ok(model.declarations.some((day) => day.variantOf === 'D'));

    // ...but the union branch references its as-declared reading, where p is
    // NOT required, because the normalizer does not descend the branch.
    const plain = decl(model, 'DPlain');
    assert.ok(plain, 'the plain reading is its own declaration');
    assert.strictEqual(plain.variant, undefined);
    assert.strictEqual(plain.type.members[0].required, false);
    const union = decl(model, 'R').type.members
      .find((m) => m.name === 'union').type;
    assert.deepStrictEqual(union.options[0], { kind: 'ref', ref: 'DPlain' });

    // The claim is testable against the runtime, so it is tested: normalize
    // leaves the branch value alone, and the plain reading describes it.
    const { compileNormalizer } = await import('@jarenjs/validate/normalize');
    const input = { union: {} };
    const shaped = compileNormalizer(schema, options)(input);
    assert.deepStrictEqual(shaped.union, {},
      'the runtime does not materialize a default under anyOf');
    for (const member of plain.type.members) {
      if (member.required)
        assert.ok(Object.hasOwn(shaped.union, member.name));
    }
  });
});
