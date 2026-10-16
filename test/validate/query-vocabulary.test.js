import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

import { JarenValidator } from '@jarenjs/validate';
import draft2020 from '@jarenjs/refs/draft-2020-12';
import jaren2020, { dialect } from '@jarenjs/refs/jaren-2020-12';

const STANDARD = 'https://json-schema.org/draft/2020-12/schema';
const fixtures = new URL('./fixtures/', import.meta.url);
const compiledQueries = JSON.parse(readFileSync(new URL('query-vocabulary/compiled-queries.json', fixtures), 'utf8')).queries;
const formatDir = new URL('../json/fixtures/query-format/valid/', import.meta.url);
const formatQueries = readdirSync(formatDir).sort()
  .map(name => [name, JSON.parse(readFileSync(new URL(name, formatDir), 'utf8'))]);

/** A collecting validator holding the Jaren dialect. */
function withDialect() {
  return new JarenValidator({ collectErrors: true }).addMetaSchema([...jaren2020], dialect);
}

/** The dialect meta-schema as a collecting validator. */
function metaValidator() {
  return withDialect().compile({ $ref: dialect });
}

describe("'$query' vocabulary and the Jaren 2020-12 dialect", () => {

  describe('validating a schema against the dialect', () => {
    it('refuses a malformed $query at the $query member', () => {
      const result = metaValidator()({ $schema: dialect, type: 'object', $query: { $nope: 1 } });
      assert.strictEqual(result.valid, false);
      for (const e of result.errors)
        assert.ok(e.instancePath === '' || e.instancePath === '/$query' || e.instancePath.startsWith('/$query/'), e.instancePath);
      assert.deepStrictEqual(result.errors.filter(e => e.instancePath === '').map(e => e.keyword), ['allOf']);
      assert.ok(result.errors.some(e => e.instancePath === '/$query' && e.keyword === 'oneOf'
        && e.schemaPath === 'https://jarenjs.dev/schemas/jaren-query/0.1#/$defs/queryDocument'));
      assert.ok(result.errors.some(e => e.instancePath === '/$query/$nope'));
    });

    it('refuses a malformed $query in a subschema, located there', () => {
      const result = metaValidator()({
        $schema: dialect,
        properties: { lines: { items: { $query: { $nope: 1 } } } },
        $defs: { money: { $query: { $sum: 1, $nope: 2 } } },
      });
      assert.strictEqual(result.valid, false);
      const located = [...new Set(result.errors.map(e => e.instancePath).filter(p => p.includes('$query')))].sort();
      assert.deepStrictEqual(located.filter(p => p.endsWith('/$query')),
        ['/$defs/money/$query', '/properties/lines/items/$query']);
    });

    it('answers the same through validateSchema', () => {
      const jaren = withDialect();
      assert.strictEqual(jaren.validateSchema({ $schema: dialect, $query: { $nope: 1 } }), false);
      assert.strictEqual(jaren.validateSchema({ $schema: dialect, $query: { $le: ['$.start', '$.end'] } }), true);
    });

    it('still checks every standard 2020-12 keyword', () => {
      const result = metaValidator()({ $schema: dialect, type: 12 });
      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.some(e => e.instancePath === '/type' && e.keyword === 'anyOf'));
    });

    it('accepts every $query document the validator compiles', () => {
      assert.strictEqual(compiledQueries.length, 37);
      const meta = metaValidator();
      const parse = new JarenValidator().addSchema({ $id: 'https://jarenjs.dev/schemas/test/money', type: 'number' });
      for (const query of compiledQueries) {
        const result = meta({ $schema: dialect, $query: query });
        assert.deepStrictEqual(result.errors, [], JSON.stringify(query));
        // Each one compiles as a query: the keyword refuses only a free external.
        try { parse.compile({ $query: query }); }
        catch (e) { assert.match(e.message, /^JQ0005: invalid '\$query' document: '\$minPrice' is neither bound/); }
      }
    });

    it('accepts every valid query-format fixture', () => {
      assert.strictEqual(formatQueries.length, 29);
      const meta = metaValidator();
      for (const [name, query] of formatQueries) {
        const result = meta({ $schema: dialect, properties: { x: { $query: query } } });
        assert.deepStrictEqual(result.errors, [], name);
      }
    });

    it('leaves the plain 2020-12 dialect as it was: $query is an unknown keyword there', () => {
      const jaren = new JarenValidator().addMetaSchema([...draft2020], STANDARD);
      const schema = { $schema: STANDARD, $query: { $nope: 1 } };
      assert.strictEqual(jaren.validateSchema(schema), true);
      assert.throws(() => jaren.compile(schema), { name: 'SchemaCompileError', code: 'JQ0002' });
    });
  });

  describe('compiling a schema that declares the dialect', () => {
    const invoice = {
      type: 'object',
      properties: { lines: { type: 'array', items: { $query: { $gt: ['$.qty', 0] } } } },
      $query: { $eq: ['$.total', { $sum: '$.lines[*].amount' }] },
    };
    const instances = [
      { lines: [{ qty: 1, amount: 2 }], total: 2 },
      { lines: [{ qty: 1, amount: 2 }], total: 3 },
      { lines: [{ qty: 0, amount: 2 }], total: 2 },
      { lines: [], total: 0 },
      { lines: [{ qty: 1, amount: 'x' }], total: 0 },
      'not an object',
    ];
    const answers = [true, false, false, true, false, false];

    it('answers as the plain 2020-12 dialect and as no dialect', () => {
      for (const [label, jaren, schema] of [
        ['jaren dialect, registered', new JarenValidator().addMetaSchema([...jaren2020], dialect), { $schema: dialect, ...invoice }],
        ['jaren dialect, unregistered', new JarenValidator(), { $schema: dialect, ...invoice }],
        ['plain 2020-12', new JarenValidator().addMetaSchema([...draft2020], STANDARD), { $schema: STANDARD, ...invoice }],
        ['no $schema', new JarenValidator(), invoice],
      ]) {
        const validate = jaren.compile(schema);
        assert.deepStrictEqual(instances.map(i => validate(i)), answers, label);
      }
    });

    it('reads the 2020-12 keywords the dialect inherits', () => {
      const jaren = new JarenValidator().addMetaSchema([...jaren2020], dialect);
      const validate = jaren.compile({ $schema: dialect, prefixItems: [{ type: 'string' }], format: 'email' });
      assert.strictEqual(validate([1]), false);
      // format stays an annotation, as under plain 2020-12
      assert.strictEqual(validate(['not an email']), true);
    });

    it('keeps $query asserting under a meta-schema whose $vocabulary omits it', () => {
      const custom = {
        $schema: STANDARD,
        $id: 'https://example.com/no-query-vocabulary',
        $vocabulary: { ...draft2020[0].$vocabulary },
        $dynamicAnchor: 'meta',
        allOf: [{ $ref: STANDARD }],
      };
      const jaren = new JarenValidator().addMetaSchema([custom, ...draft2020], custom.$id);
      const validate = jaren.compile({ $schema: custom.$id, $query: { $le: ['$.start', '$.end'] } });
      assert.strictEqual(validate({ start: 1, end: 2 }), true);
      assert.strictEqual(validate({ start: 3, end: 2 }), false);
    });

    it('reads an unprefixed query as an annotation under every dialect', () => {
      const jaren = withDialect();
      const schema = { $schema: dialect, query: { $nope: 1 } };
      assert.deepStrictEqual(jaren.compile({ $ref: dialect })(schema).errors, []);
      assert.strictEqual(jaren.compile(schema)({ anything: true }).valid, true);
    });

    it('still refuses a malformed $query at compile', () => {
      assert.throws(() => withDialect().compile({ $schema: dialect, $query: { $nope: 1 } }), { name: 'SchemaCompileError', code: 'JQ0002' });
    });
  });

  describe('registration', () => {
    const malformed = { $schema: dialect, $query: { $nope: 1 } };
    const wellFormed = { $schema: dialect, $query: '$.approved' };
    it('works beside the standard 2020-12 bundle in either order, and twice', () => {
      for (const [label, register] of [
        ['standard first', j => j.addMetaSchema([...draft2020], STANDARD).addMetaSchema([...jaren2020], dialect)],
        ['jaren first', j => j.addMetaSchema([...jaren2020], dialect).addMetaSchema([...draft2020], STANDARD)],
        ['jaren twice', j => j.addMetaSchema([...jaren2020], dialect).addMetaSchema([...jaren2020], dialect)],
        ['query grammar copy added first', j => j.addSchema(JSON.parse(JSON.stringify(jaren2020[2]))).addMetaSchema([...jaren2020], dialect)],
      ]) {
        const jaren = register(new JarenValidator());
        assert.strictEqual(jaren.validateSchema(malformed), false, label);
        assert.strictEqual(jaren.validateSchema(wellFormed), true, label);
      }
    });
  });
});

describe('the README example of the Jaren dialect', () => {
  it('runs as written: checked, refused at the misspelled $query, compiled', () => {
    const readme = readFileSync(new URL('../../packages/validate/README.md', import.meta.url), 'utf8');
    const section = readme.slice(readme.indexOf('### Checking `$query` itself'));
    const start = section.indexOf('```js\n') + 6;
    const fence = section.slice(start, section.indexOf('\n```', start));
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', fence], {
      cwd: new URL('../..', import.meta.url), encoding: 'utf8', env: { ...process.env, FORCE_COLOR: '0' },
    });
    assert.strictEqual(out, "true\nfalse [ '/properties/period/$query' ]\ntrue false\n");
  });
});
