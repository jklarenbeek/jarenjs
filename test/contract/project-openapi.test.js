//@ts-check
/**
 * @file `toOpenApi`: the document equals the golden, renders byte-identical
 * twice, validates against the vendored OpenAPI 3.1 meta-schema with
 * `JarenValidator` (and the validator is proven to actually check: a
 * broken document fails), carries the mapping the format doc §12.2
 * states (paths sorted, parameters from the member locations, the body
 * object, the wire-error responses, the shared binding responses,
 * `x-jaren-policy`, opaque bytes, the `Idempotency-Key` header), and
 * applies the keyword policy — every keyword of the policy has a case:
 * `nullable` mapped, a boolean `required` refused (`JC0060`) or dropped
 * under `lenient`, `$query`/`$data`/`errorMessage`/`x-form`/`x-*`
 * dropped and reported with their `docPath`, `components` refused, an
 * unmappable same-document `$ref` refused or dropped.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

import { JarenValidator } from '@jarenjs/validate';
import { stringFormats } from '@jarenjs/formats';
import { compileContract, ContractCompileError, ContractHostError } from '@jarenjs/contract';
import { toOpenApi } from '@jarenjs/contract/project';

import { load } from './helpers.js';

const shop = load('./fixtures/shop.contract.json');
const GOLDEN = new URL('./fixtures/shop.openapi.json', import.meta.url);

/** The vendored meta-schema (Apache-2.0, see its `$comment`), compiled once. */
const validateOpenApi = new JarenValidator({ collectErrors: true, skipErrors: false })
  .addFormats(stringFormats)
  .compile(load('./fixtures/openapi-3.1.schema.json'));

/**
 * @param {any} op
 * @param {any} [root]
 */
const one = (op, root = {}) => compileContract({ $contract: '0.1', operations: { 'a.b': op }, ...root });

/**
 * A read with one query member carrying `schema` on its member.
 * @param {any} schema - the member schema
 * @param {any} [root]
 */
const withMember = (schema, root) => one({
  kind: 'read',
  input: { type: 'object', properties: { m: schema } },
  output: true,
  http: { method: 'GET', path: '/a' },
}, root);

/** @param {any} doc */
const pretty = (doc) => JSON.stringify(doc, null, 2) + '\n';

describe('toOpenApi — the golden, determinism and validity', () => {
  const contract = compileContract(shop);

  it('equals the golden (regenerate with: node packages/contract/src/cli.js openapi --contract test/contract/fixtures/shop.contract.json --out test/contract/fixtures/shop.openapi.json) and renders byte-identical twice', () => {
    const first = toOpenApi(contract);
    assert.deepStrictEqual(first.dropped, []);
    assert.strictEqual(pretty(first.document), readFileSync(GOLDEN, 'utf8'));
    assert.strictEqual(pretty(toOpenApi(contract).document), pretty(first.document));
  });

  it('validates against the vendored OpenAPI 3.1 meta-schema — and the meta-schema is really applied', () => {
    const { document } = toOpenApi(contract, { info: { title: 'Shop', version: '5' }, servers: [{ url: 'https://shop.example', description: 'prod' }] });
    const verdict = validateOpenApi(document);
    assert.strictEqual(verdict.valid, true, JSON.stringify(verdict.errors?.slice(0, 3)));
    // the control group: the validator must refuse what the schema refuses
    const broken = structuredClone(document);
    broken.paths['/api/catalog'].get.bogus = 1;
    assert.strictEqual(validateOpenApi(broken).valid, false, 'an undeclared operation member (unevaluatedProperties: false through a $ref chain)');
    const noVersion = structuredClone(document);
    delete noVersion.info.version;
    assert.strictEqual(validateOpenApi(noVersion).valid, false, 'info.version is required');
    const badPath = structuredClone(document);
    badPath.paths['api/x'] = badPath.paths['/api/catalog'];
    assert.strictEqual(validateOpenApi(badPath).valid, false, 'a path must start with /');
    const optionalPathParam = structuredClone(document);
    optionalPathParam.paths['/api/images/{id}'].get.parameters[0].required = false;
    assert.strictEqual(validateOpenApi(optionalPathParam).valid, false, 'a path parameter must be required');
    const notSchema = structuredClone(document);
    notSchema.components.schemas.Product = 'nope';
    assert.strictEqual(validateOpenApi(notSchema).valid, false, 'a schema object is an object or a boolean ($dynamicRef meta)');
    assert.strictEqual(validateOpenApi({ openapi: '3.0.0', info: { title: 't', version: '1' }, paths: {} }).valid, false);
  });
});

describe('toOpenApi — the mapping', () => {
  const { document: doc } = toOpenApi(compileContract(shop), { info: { title: 'Shop', version: '5' }, servers: [{ url: 'https://shop.example' }] });
  const paths = /** @type {any} */ (doc.paths);
  const components = /** @type {any} */ (doc.components);

  it('writes the members in order, paths sorted by canonical path then method, info and servers as given', () => {
    assert.deepStrictEqual(Object.keys(doc), ['openapi', 'info', 'servers', 'jsonSchemaDialect', 'paths', 'components']);
    assert.strictEqual(doc.openapi, '3.1.0');
    assert.deepStrictEqual(doc.info, { title: 'Shop', version: '5' });
    assert.deepStrictEqual(doc.servers, [{ url: 'https://shop.example' }]);
    assert.strictEqual(doc.jsonSchemaDialect, 'https://json-schema.org/draft/2020-12/schema');
    assert.deepStrictEqual(Object.keys(paths), ['/api/catalog', '/api/images/{id}', '/api/products', '/api/products/{id}/master', '/product.remove']);
    assert.deepStrictEqual(Object.keys(paths['/api/products/{id}/master'].put),
      ['operationId', 'tags', 'parameters', 'requestBody', 'responses', 'x-jaren-policy']);
    assert.deepStrictEqual(Object.keys(paths['/api/catalog'].get),
      ['operationId', 'summary', 'tags', 'parameters', 'responses', 'x-jaren-policy']);
  });

  it('maps operationId, summary, tags and the parameters by location, path parameters always required', () => {
    const load_ = paths['/api/catalog'].get;
    assert.strictEqual(load_.operationId, 'catalog.load');
    assert.strictEqual(load_.summary, 'The whole catalog snapshot.');
    assert.deepStrictEqual(load_.tags, ['catalog']);
    assert.deepStrictEqual(load_.parameters, [{ name: 'since', in: 'query', required: false, schema: { type: 'string', format: 'date-time' } }]);
    const save = paths['/api/products/{id}/master'].put;
    assert.deepStrictEqual(save.parameters[0], { name: 'id', in: 'path', required: true, schema: { type: 'integer' } });
    assert.deepStrictEqual(save.parameters[1].name, 'Idempotency-Key');
    assert.strictEqual(save.parameters[1].in, 'header');
    assert.strictEqual(save.parameters[1].required, true, 'policy.idempotency required');
    assert.strictEqual(paths['/product.remove'].post.parameters[0].required, false, 'policy.idempotency optional');
    assert.strictEqual(paths['/api/products'].get.parameters.length, 4);
    assert.deepStrictEqual(paths['/api/products'].get.parameters[2].schema, { type: 'array', items: { type: 'string' } });
  });

  it('builds the request body: the object of the body members, the whole input, or a whole-body member', () => {
    const save = paths['/api/products/{id}/master'].put;
    assert.deepStrictEqual(save.requestBody, {
      required: true,
      content: { 'application/json': { schema: {
        type: 'object',
        properties: { revision: { type: 'integer' }, product: { $ref: '#/components/schemas/Product' } },
        required: ['revision', 'product'],
      } } },
    });
    assert.deepStrictEqual(paths['/product.remove'].post.requestBody.content['application/json'].schema,
      { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } }, 'every member in the body: the input schema verbatim');
    assert.strictEqual(paths['/api/catalog'].get.requestBody, undefined);
    const { document: whole } = toOpenApi(one({
      kind: 'command',
      input: { type: 'object', required: ['id', 'doc'], properties: { id: { type: 'string' }, doc: { type: 'array', items: { type: 'object' } }, dry: { type: 'boolean' } }, additionalProperties: false },
      output: true,
      http: { method: 'PUT', path: '/docs/{id}', body: 'doc', in: { dry: 'query' } },
    }));
    const put = /** @type {any} */ (whole.paths)['/docs/{id}'].put;
    assert.deepStrictEqual(put.requestBody, { required: true, content: { 'application/json': { schema: { type: 'array', items: { type: 'object' } } } } });
    const { document: split } = toOpenApi(one({
      kind: 'command',
      input: { type: 'object', properties: { id: { type: 'string' }, a: { type: 'string' }, b: { type: 'integer' } }, additionalProperties: false },
      output: true,
      http: { method: 'POST', path: '/x/{id}' },
    }));
    assert.deepStrictEqual(/** @type {any} */ (split.paths)['/x/{id}'].post.requestBody, {
      required: false,
      content: { 'application/json': { schema: { type: 'object', properties: { a: { type: 'string' }, b: { type: 'integer' } }, additionalProperties: false } } },
    }, 'a split input: the body object carries the input\'s additionalProperties and no empty required');
  });

  it('answers the success response, the declared errors as wire-error schemas by status, and the binding\'s shared responses', () => {
    const save = paths['/api/products/{id}/master'].put;
    assert.deepStrictEqual(Object.keys(save.responses), ['200', '400', '404', '409', '413', '415', '500']);
    assert.deepStrictEqual(save.responses['200'], { description: 'Success', content: { 'application/json': { schema: { $ref: '#/components/schemas/Product' } } } });
    const conflict = save.responses['409'].content['application/json'].schema;
    assert.deepStrictEqual(conflict.properties.code, { type: 'string', enum: ['conflict', 'JC2009'] }, 'the declared code beside the binding\'s 409');
    assert.deepStrictEqual(conflict.properties.details, { $ref: '#/components/schemas/Conflict' });
    assert.deepStrictEqual(conflict.required, ['code', 'message', 'requestId', 'retryable']);
    assert.match(save.responses['409'].description, /Declared failure: conflict \(or the binding's JC2009\)/);
    assert.deepStrictEqual(save.responses['404'].content['application/json'].schema.properties.code.enum, ['not-found', 'JC2001']);
    assert.strictEqual(save.responses['404'].content['application/json'].schema.properties.details, undefined, 'no declared details schema');
    assert.deepStrictEqual(save.responses['400'], { $ref: '#/components/responses/BadRequest' });
    assert.deepStrictEqual(save.responses['415'], { $ref: '#/components/responses/UnsupportedMediaType' });
    assert.deepStrictEqual(save.responses['500'], { $ref: '#/components/responses/InternalError' });
    const load_ = paths['/api/catalog'].get;
    assert.deepStrictEqual(Object.keys(load_.responses), ['200', '400', '404', '409', '413', '500'], 'no 415 without a body, no IdempotencyConflict without idempotency');
    assert.deepStrictEqual(load_.responses['409'].content['application/json'].schema.properties.code.enum, ['stale']);
    assert.deepStrictEqual(Object.keys(components.responses), ['BadRequest', 'NotFound', 'IdempotencyConflict', 'PayloadTooLarge', 'UnsupportedMediaType', 'InternalError']);
    assert.deepStrictEqual(components.responses.BadRequest.content['application/json'].schema.properties.code.enum,
      ['JC2005', 'JC2006', 'JC2007', 'JC2011', 'JC2012', 'JC2015']);
    assert.match(components.responses.NotFound.description, /JC2001/);
  });

  it('rewrites $defs into components.schemas, carries x-jaren-policy verbatim, and maps an opaque operation to bytes', () => {
    assert.deepStrictEqual(Object.keys(components.schemas), ['Catalog', 'Product', 'Conflict']);
    assert.deepStrictEqual(components.schemas.Catalog.properties.products.items, { $ref: '#/components/schemas/Product' });
    assert.deepStrictEqual(paths['/api/products/{id}/master'].put['x-jaren-policy'],
      { task: 'exhaust', idempotency: 'required', cache: 'none', revision: 'input:/revision', retry: { max: 2, on: ['not-found'] } });
    assert.deepStrictEqual(paths['/api/catalog'].get['x-jaren-policy'], { task: 'switch', idempotency: 'none', cache: 'revision' });
    const image = paths['/api/images/{id}'].get;
    assert.deepStrictEqual(image.responses['200'], { description: 'Success', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } });
    assert.strictEqual(image.requestBody, undefined);
  });

  it('handles a $ref input, a 204, a server operation, defaults for info, and no servers', () => {
    const contract = compileContract({
      $contract: '0.1',
      id: 'refs',
      version: '2',
      $defs: { In: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, q: { type: 'integer' } } } },
      operations: {
        'by.ref': { kind: 'command', input: { $ref: '#/$defs/In' }, output: true, http: { method: 'POST', path: '/r', status: 204 } },
        'read.ref': { kind: 'read', input: { $ref: '#/$defs/In' }, output: { type: 'object' }, http: { method: 'GET', path: '/r/{id}' } },
        'only.server': { kind: 'read', output: true, policy: { audience: 'server' }, http: { method: 'GET', path: '/s' } },
      },
    });
    const { document, dropped } = toOpenApi(contract);
    assert.deepStrictEqual(dropped, []);
    assert.deepStrictEqual(document.info, { title: 'refs', version: '2' });
    assert.strictEqual('servers' in document, false);
    const p = /** @type {any} */ (document.paths);
    assert.deepStrictEqual(Object.keys(p), ['/r', '/r/{id}'], 'the server operation is not in the document');
    assert.deepStrictEqual(p['/r'].post.requestBody, { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/In' } } } }, 'a $ref input with every member in the body stays a reference');
    assert.deepStrictEqual(p['/r'].post.responses['204'], { description: 'Success' }, 'a 204 carries no content');
    assert.deepStrictEqual(p['/r/{id}'].get.parameters, [
      { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
      { name: 'q', in: 'query', required: false, schema: { type: 'integer' } },
    ], 'a $ref input is split through its effective schema');
    assert.strictEqual(validateOpenApi(document).valid, true);
  });

  it('refuses a malformed option with JC1008', () => {
    const contract = compileContract(shop);
    for (const options of [{ info: 'Shop' }, { servers: 'x' }, { servers: [{ description: 'no url' }] }, { lenient: 'yes' }, 5]) {
      assert.throws(() => toOpenApi(contract, /** @type {any} */ (options)), (/** @type {any} */ e) => e instanceof ContractHostError && e.code === 'JC1008', JSON.stringify(options));
    }
    assert.throws(() => toOpenApi(/** @type {any} */ (shop)), (/** @type {any} */ e) => e.code === 'JC1008');
  });
});

describe('toOpenApi — the keyword policy', () => {
  it('maps nullable: true into type, and drops nullable: false or a typeless nullable with a report', () => {
    const { document, dropped } = toOpenApi(withMember({ type: 'string', nullable: true }));
    const param = /** @type {any} */ (document.paths)['/a'].get.parameters[0];
    assert.deepStrictEqual(param.schema, { type: ['string', 'null'] });
    assert.deepStrictEqual(dropped, []);
    assert.deepStrictEqual(toOpenApi(withMember({ nullable: true, type: ['string', 'integer'] })).document.paths['/a'].get.parameters[0].schema, { type: ['string', 'integer', 'null'] }, 'an array type, nullable written first');
    assert.deepStrictEqual(toOpenApi(withMember({ type: ['string', 'null'], nullable: true })).document.paths['/a'].get.parameters[0].schema, { type: ['string', 'null'] }, 'null not doubled');
    const off = toOpenApi(withMember({ type: 'string', nullable: false }));
    assert.deepStrictEqual(off.document.paths['/a'].get.parameters[0].schema, { type: 'string' });
    assert.deepStrictEqual(off.dropped, [{ docPath: '/operations/a.b/input/properties/m/nullable', keyword: 'nullable', reason: 'asserts nothing in OpenAPI 3.1 (only nullable: true maps, to "null" in type)' }]);
    const typeless = toOpenApi(withMember({ nullable: true, minLength: 1 }));
    assert.deepStrictEqual(typeless.document.paths['/a'].get.parameters[0].schema, { minLength: 1 });
    assert.strictEqual(typeless.dropped.length, 1);
    assert.match(typeless.dropped[0].reason, /without a type/);
  });

  it('refuses a boolean required (JC0060, at the keyword) unless lenient, then drops and reports it', () => {
    const contract = withMember({ type: 'string', required: true });
    assert.throws(() => toOpenApi(contract), (/** @type {any} */ e) =>
      e instanceof ContractCompileError && e.code === 'JC0060' && e.docPath === '/operations/a.b/input/properties/m/required' && /lenient/.test(e.message));
    const { document, dropped } = toOpenApi(contract, { lenient: true });
    assert.deepStrictEqual(/** @type {any} */ (document.paths)['/a'].get.parameters[0].schema, { type: 'string' });
    assert.deepStrictEqual(dropped.map((d) => [d.docPath, d.keyword]), [['/operations/a.b/input/properties/m/required', 'required']]);
    // the array form is JSON Schema's own and stays
    const arr = toOpenApi(one({ kind: 'command', input: { type: 'object', required: ['x'], properties: { x: { type: 'string' } } }, output: true }));
    assert.deepStrictEqual(/** @type {any} */ (arr.document.paths)['/a.b'].post.requestBody.content['application/json'].schema.required, ['x']);
  });

  it('drops and reports $query, $data, errorMessage, x-form and other x-* keywords with their docPath, wherever they sit', () => {
    const contract = compileContract({
      $contract: '0.1',
      $defs: { Price: { type: 'number', $query: { $ge: ['$', 0] }, 'x-form': { widget: 'money' } } },
      operations: {
        'a.b': {
          kind: 'command',
          input: { type: 'object', properties: { p: { $ref: '#/$defs/Price' }, q: { type: 'string', errorMessage: 'say q', 'x-note': 1 } } },
          output: { type: 'object', properties: { n: { type: 'integer', $data: { minimum: '/p' } } } },
          errors: { bad: { schema: { type: 'string', 'x-form': {} } } },
        },
      },
    });
    const { document, dropped } = toOpenApi(contract);
    assert.deepStrictEqual(dropped.map((d) => `${d.keyword} @ ${d.docPath}`), [
      '$query @ /$defs/Price/$query',
      'x-form @ /$defs/Price/x-form',
      'errorMessage @ /operations/a.b/input/properties/q/errorMessage',
      'x-note @ /operations/a.b/input/properties/q/x-note',
      '$data @ /operations/a.b/output/properties/n/$data',
      'x-form @ /operations/a.b/errors/bad/schema/x-form',
    ]);
    for (const d of dropped) assert.match(d.reason, /Jaren-side/);
    assert.deepStrictEqual(/** @type {any} */ (document.components).schemas.Price, { type: 'number' });
    const body = /** @type {any} */ (document.paths)['/a.b'].post.requestBody.content['application/json'].schema;
    assert.deepStrictEqual(body.properties.q, { type: 'string' });
    assert.strictEqual(JSON.stringify(document).includes('$query'), false);
    assert.strictEqual(JSON.stringify(document).includes('x-form'), false);
  });

  it('refuses a components member inside a schema even under lenient, and an unmappable same-document $ref unless lenient', () => {
    const withComponents = withMember({ type: 'object', components: { schemas: {} } });
    for (const lenient of [false, true]) {
      assert.throws(() => toOpenApi(withComponents, { lenient }), (/** @type {any} */ e) =>
        e instanceof ContractCompileError && e.code === 'JC0060' && e.docPath === '/operations/a.b/input/properties/m/components');
    }
    const anchored = one({
      kind: 'read', output: { $ref: '#anc' }, http: { method: 'GET', path: '/a' },
    }, { $defs: { T: { $anchor: 'anc', type: 'object', properties: { n: { type: 'integer' } } } } });
    assert.throws(() => toOpenApi(anchored), (/** @type {any} */ e) => e.code === 'JC0060' && e.docPath === '/operations/a.b/output/$ref');
    const { document, dropped } = toOpenApi(anchored, { lenient: true });
    assert.deepStrictEqual(dropped.map((d) => d.docPath), ['/operations/a.b/output/$ref']);
    assert.deepStrictEqual(/** @type {any} */ (document.paths)['/a'].get.responses['200'].content['application/json'].schema, {}, 'the reference is dropped, the schema honestly wider');
    // a pointer INTO a def maps; an absolute reference is kept as written
    const deep = toOpenApi(withMember({ $ref: '#/$defs/T/properties/n' }, { $defs: { T: { type: 'object', properties: { n: { type: 'integer' } } } } }));
    assert.deepStrictEqual(deep.document.paths['/a'].get.parameters[0].schema, { $ref: '#/components/schemas/T/properties/n' });
    const external = toOpenApi(compileContract({
      $contract: '0.1',
      operations: { 'a.b': { kind: 'read', output: { $ref: 'https://example.com/schemas/thing.json#/x' }, http: { method: 'GET', path: '/a' } } },
    }, { schemas: [{ $id: 'https://example.com/schemas/thing.json', x: { type: 'string' } }] }));
    assert.deepStrictEqual(/** @type {any} */ (external.document.paths)['/a'].get.responses['200'].content['application/json'].schema, { $ref: 'https://example.com/schemas/thing.json#/x' });
    assert.deepStrictEqual(external.dropped, []);
  });

  it('leaves data keywords and plain annotations alone and walks every schema position', () => {
    const contract = withMember({
      description: 'd', title: 't', deprecated: true,
      enum: [{ nullable: true }, { $ref: '#/$defs/X' }],
      const: { 'x-form': 1 },
      default: { required: true },
      allOf: [{ type: 'object', properties: { a: { type: 'string', nullable: true } } }],
      anyOf: [{ $ref: '#/$defs/X' }],
      items: { type: 'string', nullable: true },
      additionalProperties: { type: 'integer', 'x-a': 1 },
      patternProperties: { '^z': { type: 'string', nullable: true } },
      dependentSchemas: { a: { required: ['b'], 'x-b': 1 } },
      prefixItems: [{ type: 'null', nullable: true }],
      not: { type: 'string', nullable: true },
      definitions: { Old: { type: 'string', nullable: true } },
    }, { $defs: { X: { type: 'integer' } } });
    const { document, dropped } = toOpenApi(contract);
    const schema = /** @type {any} */ (document.paths)['/a'].get.parameters[0].schema;
    assert.deepStrictEqual(schema.enum, [{ nullable: true }, { $ref: '#/$defs/X' }], 'enum is data');
    assert.deepStrictEqual(schema.const, { 'x-form': 1 });
    assert.deepStrictEqual(schema.default, { required: true });
    assert.deepStrictEqual(schema.allOf[0].properties.a, { type: ['string', 'null'] });
    assert.deepStrictEqual(schema.anyOf[0], { $ref: '#/components/schemas/X' });
    assert.deepStrictEqual(schema.items, { type: ['string', 'null'] });
    assert.deepStrictEqual(schema.additionalProperties, { type: 'integer' });
    assert.deepStrictEqual(schema.patternProperties['^z'], { type: ['string', 'null'] });
    assert.deepStrictEqual(schema.dependentSchemas.a, { required: ['b'] });
    assert.deepStrictEqual(schema.prefixItems[0], { type: 'null' }, 'null stays null');
    assert.deepStrictEqual(schema.not, { type: ['string', 'null'] });
    assert.deepStrictEqual(schema.definitions.Old, { type: ['string', 'null'] });
    assert.strictEqual(schema.description, 'd');
    assert.strictEqual(schema.deprecated, true);
    assert.deepStrictEqual(dropped.map((d) => d.docPath), [
      '/operations/a.b/input/properties/m/additionalProperties/x-a',
      '/operations/a.b/input/properties/m/dependentSchemas/a/x-b',
    ]);
  });
});
