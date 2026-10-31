//@ts-check
/**
 * @file One compile nests subschemas at most `maxSchemaDepth` levels deep
 * (default 128): one level more is refused `JK0017` where the bound is
 * crossed, before the host's call stack can run out, whatever keyword
 * holds the levels and whatever `$schema` the document declares. Data
 * nested inside a schema is walked at any depth, and deep instances are
 * compared at any depth.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { JarenValidator, ValidationOptions } from '@jarenjs/validate';
import { compileAsync } from '@jarenjs/validate/load';

const DRAFTS = [undefined, 'http://json-schema.org/draft-07/schema#',
  'https://json-schema.org/draft/2019-09/schema', 'https://json-schema.org/draft/2020-12/schema'];

/** @type {Record<string, (inner: any) => any>} */
const LEVELS = {
  properties: (s) => ({ properties: { a: s } }),
  items: (s) => ({ items: s }),
  allOf: (s) => ({ allOf: [s] }),
  anyOf: (s) => ({ anyOf: [s] }),
  oneOf: (s) => ({ oneOf: [s] }),
  not: (s) => ({ not: s }),
  then: (s) => ({ if: true, then: s }),
  additionalProperties: (s) => ({ additionalProperties: s }),
  patternProperties: (s) => ({ patternProperties: { '^a': s } }),
  propertyNames: (s) => ({ propertyNames: s }),
  contains: (s) => ({ contains: s }),
};

/**
 * A schema `levels` objects deep: `levels - 1` levels of `keyword` around
 * an integer schema, the `$schema` (when given) on the root.
 * @param {string} keyword @param {number} levels @param {string} [draft]
 * @param {any} [leaf] - The innermost schema
 */
const chain = (keyword, levels, draft = undefined, leaf = { type: 'integer', minimum: 0 }) => {
  /** @type {any} */
  let s = leaf;
  for (let i = 1; i < levels; i++) s = LEVELS[keyword](s);
  return draft === undefined ? s : { $schema: draft, ...s };
};
/** `n` nested `{ a }` objects around `leaf`. @param {number} n @param {unknown} leaf */
const nestObjects = (n, leaf) => {
  /** @type {any} */
  let v = leaf;
  for (let i = 0; i < n; i++) v = { a: v };
  return v;
};
/** `n` nested arrays around `leaf`. @param {number} n @param {unknown} leaf */
const nestArrays = (n, leaf) => {
  /** @type {any} */
  let v = leaf;
  for (let i = 0; i < n; i++) v = [v];
  return v;
};

const REASON = 'the schema nests subschemas more than 128 levels deep, deeper than a small host call stack compiles and validates; raise maxSchemaDepth to compile it';

describe('a compile nests subschemas at most maxSchemaDepth levels', () => {
  it('compiles 128 levels and refuses the 129th, for every keyword and $schema', () => {
    for (const keyword of Object.keys(LEVELS)) {
      for (const draft of DRAFTS) {
        // a keyword the declared draft does not define nests nothing
        if (draft === DRAFTS[1] && keyword === 'propertyNames') continue;
        assert.equal(typeof new JarenValidator().compile(chain(keyword, 128, draft)), 'function', `${keyword} ${draft}`);
        assert.throws(() => new JarenValidator().compile(chain(keyword, 129, draft)),
          { name: 'SchemaCompileError', code: 'JK0017', reason: REASON }, `${keyword} ${draft}`);
      }
    }
  });

  it('builds no level for a lone item type, which the array check holds inline', () => {
    const leaf = { type: 'integer' };
    assert.equal(typeof new JarenValidator().compile(chain('items', 129, undefined, leaf)), 'function');
    assert.throws(() => new JarenValidator().compile(chain('items', 130, undefined, leaf)), { code: 'JK0017' });
    assert.throws(() => new JarenValidator().compile(chain('properties', 129, undefined, leaf)), { code: 'JK0017' });
  });

  it('names the first subschema past the bound', () => {
    const levels = 129;
    let thrown;
    try {
      new JarenValidator().compile({ $id: 'https://depth.test/s', ...chain('properties', levels) });
    }
    catch (error) {
      thrown = error;
    }
    assert.equal(thrown?.docPath, `https://depth.test/s#${'/properties/a'.repeat(128)}`);
    assert.equal(thrown?.message, `JK0017: ${REASON} at ${thrown?.docPath}`);
  });

  it('validates an instance as deep as the deepest schema it compiles', () => {
    const validate = new JarenValidator().compile(chain('properties', 128));
    assert.equal(validate(nestObjects(127, 1)), true);
    assert.equal(validate(nestObjects(127, 'x')), false);
    const collect = new JarenValidator({ collectErrors: true, skipErrors: false }).compile(chain('items', 128));
    assert.equal(collect(nestArrays(127, 'x')).valid, false);
    assert.equal(collect(nestArrays(127, 2)).valid, true);
  });

  it('refuses a deep target that a reference resolves on first use by the first call that reaches it', () => {
    const validator = new JarenValidator().addSchema({ $id: 'https://depth.test/deep', ...chain('properties', 200) });
    const validate = validator.compile({ $ref: 'https://depth.test/deep' });
    assert.throws(() => validate({ a: 1 }), { name: 'SchemaCompileError', code: 'JK0017' });
    const inline = new JarenValidator().compile({ items: { $ref: '#/$defs/d' }, $defs: { d: chain('properties', 200) } });
    assert.equal(inline([]), true, 'a call that does not reach the target answers');
    assert.throws(() => inline([{ a: 1 }]), { name: 'SchemaCompileError', code: 'JK0017' });
  });

  it('leaves a deep part of a held document no compile reaches alone', () => {
    const validator = new JarenValidator().addSchema({ $id: 'https://depth.test/lib', $defs: { shallow: { type: 'string' }, deep: chain('items', 1000) } });
    const validate = validator.compile({ $ref: 'https://depth.test/lib#/$defs/shallow' });
    assert.equal(validate('s'), true);
    assert.equal(validate(1), false);
  });

  it('refuses through compileAsync alike', async () => {
    await assert.rejects(() => compileAsync(new JarenValidator(), chain('allOf', 129), { loadSchema: async () => ({}) }), { code: 'JK0017' });
  });
});

describe('the maxSchemaDepth option', () => {
  it('moves the bound both ways', () => {
    assert.equal(typeof new JarenValidator({ maxSchemaDepth: 3 }).compile(chain('allOf', 3)), 'function');
    assert.throws(() => new JarenValidator({ maxSchemaDepth: 3 }).compile(chain('allOf', 4)),
      { code: 'JK0017', reason: REASON.replace('128', '3') });
    assert.equal(typeof new JarenValidator({ maxSchemaDepth: 160 }).compile(chain('items', 160)), 'function');
    assert.throws(() => new JarenValidator({ maxSchemaDepth: 160 }).compile(chain('items', 161)), { code: 'JK0017' });
  });

  it('is the 14th positional argument of ValidationOptions, 128 by default', () => {
    assert.equal(new ValidationOptions().maxSchemaDepth, 128);
    const options = new ValidationOptions(true, true, false, null, 7, true, null, true, 'ignore', false, 'handrews-01', 256, undefined, 5);
    assert.equal(options.maxSchemaDepth, 5);
    assert.throws(() => new JarenValidator({ validation: options }).compile(chain('allOf', 6)), { code: 'JK0017' });
  });

  it('refuses a value that is not a positive safe integer with JK0002', () => {
    for (const bad of [0, -1, 1.5, '5', NaN, Infinity, 2 ** 53, true]) {
      assert.throws(() => new JarenValidator({ maxSchemaDepth: /** @type {any} */ (bad) }).compile({ type: 'string' }),
        { name: 'SchemaCompileError', code: 'JK0002' }, String(bad));
    }
    assert.throws(() => new JarenValidator({ maxSchemaDepth: 0 }).compile({ type: 'string' }),
      { message: 'JK0002: maxSchemaDepth must be a positive safe integer, got 0' });
    assert.equal(new JarenValidator({ maxSchemaDepth: /** @type {any} */ (null) }).compile(chain('items', 128))([[1]]), true,
      'null is the default');
  });

  it('compiles a raised bound on a host stack deep enough for it', () => {
    const script = `
      import { JarenValidator } from '@jarenjs/validate';
      let s = { type: 'integer' }; let v = 1;
      for (let i = 1; i < 1000; i++) { s = { properties: { a: s } }; v = { a: v }; }
      const codeOf = (f) => { try { return f(); } catch (e) { return e.code ?? e.name; } };
      process.stdout.write(JSON.stringify([
        codeOf(() => new JarenValidator({ maxSchemaDepth: 1000 }).compile(s)(v)),
        codeOf(() => new JarenValidator().compile(s)),
      ]));
    `;
    const child = spawnSync(process.execPath, ['--stack-size=4000', '--input-type=module', '-e', script],
      { encoding: 'utf8', cwd: new URL('../..', import.meta.url), env: { ...process.env, FORCE_COLOR: '0' } });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout, JSON.stringify([true, 'JK0017']));
  });
});

describe('data nested inside a schema is no subschema', () => {
  it('compiles a const, enum, default, examples and unknown keyword holding 100000 levels', () => {
    for (const keyword of ['const', 'default', 'x-data']) {
      assert.equal(typeof new JarenValidator().compile({ [keyword]: nestObjects(100000, 1) }), 'function', keyword);
    }
    for (const keyword of ['enum', 'examples']) {
      assert.equal(typeof new JarenValidator().compile({ [keyword]: [nestObjects(100000, 1)] }), 'function', keyword);
    }
  });

  it('compares a deep instance with a deep const, enum and uniqueItems', () => {
    const constant = new JarenValidator().compile({ const: nestObjects(100000, 1) });
    assert.equal(constant(nestObjects(100000, 1)), true);
    assert.equal(constant(nestObjects(100000, 2)), false);
    const listed = new JarenValidator().compile({ enum: [1, nestArrays(100000, 1)] });
    assert.equal(listed(nestArrays(100000, 1)), true);
    assert.equal(listed(nestArrays(100000, 2)), false);
    const unique = new JarenValidator().compile({ uniqueItems: true });
    assert.equal(unique([nestArrays(100000, 1), nestArrays(100000, 1)]), false);
    assert.equal(unique([nestArrays(100000, 1), nestArrays(100000, 2)]), true);
  });
});

describe('the bound holds on a small host stack', () => {
  it('refuses 20000 and 100000 levels coded, and compares deep data, under --stack-size=500', () => {
    const script = `
      import { JarenValidator } from '@jarenjs/validate';
      const codeOf = (f) => { try { return f(); } catch (e) { return e.code ?? e.name; } };
      const chain = (wrap, n) => { let s = { type: 'integer' }; for (let i = 1; i < n; i++) s = wrap(s); return s; };
      const nest = (n, leaf) => { let v = leaf; for (let i = 0; i < n; i++) v = [v]; return v; };
      const out = [];
      for (const n of [20000, 100000]) {
        for (const wrap of [(s) => ({ properties: { a: s } }), (s) => ({ items: s }), (s) => ({ allOf: [s] })])
          out.push(codeOf(() => typeof new JarenValidator({ collectErrors: true, skipErrors: false }).compile(chain(wrap, n))));
        // the keyword that takes the most stack per level
        out.push(codeOf(() => typeof new JarenValidator({ collectErrors: true, skipErrors: false })
          .compile({ $schema: 'https://json-schema.org/draft/2020-12/schema', ...chain((s) => ({ prefixItems: [s] }), n) })));
        out.push(codeOf(() => new JarenValidator().compile({ uniqueItems: true })([nest(n, 1), nest(n, 1)])));
        out.push(codeOf(() => new JarenValidator().compile({ const: nest(n, 1) })(nest(n, 1))));
      }
      process.stdout.write(JSON.stringify(out));
    `;
    const child = spawnSync(process.execPath, ['--stack-size=500', '--input-type=module', '-e', script],
      { encoding: 'utf8', cwd: new URL('../..', import.meta.url), env: { ...process.env, FORCE_COLOR: '0' } });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout, JSON.stringify(['JK0017', 'JK0017', 'JK0017', 'JK0017', false, true, 'JK0017', 'JK0017', 'JK0017', 'JK0017', false, true]));
  });
});

describe('the root loop check reads a chain of member and item subschemas as before', () => {
  it('passes over a leading branch that passes everything however deep its pass-through chain', () => {
    // `items` of `additionalProperties` of `propertyNames` of `{}` passes everything, so the loop through `$ref` is reached first
    assert.throws(() => new JarenValidator().compile({ allOf: [{ items: { additionalProperties: { propertyNames: {}, unevaluatedItems: true } } }, { $ref: '#' }] }),
      { code: 'JK0001' });
    // a chain ending in an assertion can fail, so it is the branch reached first: the loop is refused only where a call reaches it
    const validate = new JarenValidator().compile({ allOf: [{ additionalProperties: { propertyNames: { items: { type: 'string' } } } }, { $ref: '#' }] });
    assert.throws(() => validate('s'), { code: 'JK2001' });
    // a keyword after a chain that passes everything still asserts
    const after = new JarenValidator().compile({ allOf: [{ items: { items: true }, type: 'string' }, { $ref: '#' }] });
    assert.throws(() => after('s'), { code: 'JK2001' });
    // a member of the chain holding a reference refers somewhere, so it can fail
    const referring = new JarenValidator().compile({ $defs: { t: true }, allOf: [{ items: { items: { $ref: '#/$defs/t' } } }, { $ref: '#' }] });
    assert.throws(() => referring('s'), { code: 'JK2001' });
  });
});
