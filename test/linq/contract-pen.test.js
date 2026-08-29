//@ts-check
/**
 * @file The contract pen (`@jarenjs/linq/contract`): the runtime half of
 * the agreement.
 *
 * CONTRACT-FORMAT.md's three worked examples are rebuilt through the pen
 * and held BYTE-equal to the doc's own ```json fences — read at test
 * time, never copied — then validated against `jaren-contract` (both
 * drafts), compiled, projected and served. The projection round trip is
 * the pen's own claim made checkable: `publicProjection(compileContract
 * (pen.document))` differs from the pen's document by exactly the
 * defaults the compiler materializes, which `describe().inferred` names.
 *
 * The type half lives in `test/consumer/linq-contract.ts`; the generated
 * projection it reads is regenerated here and compared byte for byte.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';

import { JarenValidator } from '@jarenjs/validate';
import { jsonFormats } from '@jarenjs/formats';
import { compileContract, ContractCompileError } from '@jarenjs/contract';
import { openLocalClient } from '@jarenjs/contract/local';
import { contractTools, publicProjection } from '@jarenjs/contract/project';
import { createToolbox } from '@jarenjs/ai/toolbox';
import { LinqBuildError } from '@jarenjs/linq';
import * as s from '@jarenjs/linq/schema';
import {
  command, defineContract, error, http, read, subscribe, typedClient, typedHandlers, typedTools,
} from '@jarenjs/linq/contract';

import { CORPUS, Catalog, Conflict, Product, Shop } from './contract-corpus.js';
import { HEADER, renderFixture } from '../../scripts/generate-contract-pen-fixture.js';

const FORMAT_DOC = new URL('../../packages/contract/docs/CONTRACT-FORMAT.md', import.meta.url);
const GENERATED = new URL('../consumer/linq-contract-generated.ts', import.meta.url);
const GRAMMAR = new URL('../../packages/contract/schemas/jaren-contract.schema.json', import.meta.url);
const GRAMMAR_07 = new URL('../../packages/contract/schemas/jaren-contract.draft-07.schema.json', import.meta.url);

/** The bytes a document is: JSON text, member order included. @param {any} doc */
const bytes = (doc) => JSON.stringify(doc);

/** @param {URL} url */
const load = (url) => JSON.parse(fs.readFileSync(url, 'utf8'));

/** The format document's ```json fences: complete contracts, in order. */
function formatDocExamples() {
  const md = fs.readFileSync(FORMAT_DOC, 'utf8');
  return [...md.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => JSON.parse(m[1]));
}

/** @param {any} artifact */
const compileGrammar = (artifact) => new JarenValidator().addFormats(jsonFormats).compile(artifact);

/** @param {() => any} fn */
function refusal(fn) {
  try { fn(); }
  catch (err) { return /** @type {any} */ (err); }
  return assert.fail('expected a refusal');
}

describe('the contract pen writes CONTRACT-FORMAT.md\'s worked examples', () => {
  const examples = formatDocExamples();
  const validate = compileGrammar(load(GRAMMAR));
  const validate07 = compileGrammar(load(GRAMMAR_07));

  it('the doc carries exactly the corpus\'s examples', () => {
    assert.strictEqual(examples.length, CORPUS.length,
      'one corpus entry per ```json fence — a new fence needs a new pen build');
  });

  CORPUS.forEach((entry, i) => {
    it(`${entry.name} (${entry.section}) is byte-equal to the doc, validates under both drafts, and compiles`, () => {
      const doc = entry.build().document;
      assert.strictEqual(bytes(doc), bytes(examples[i]), `${entry.name} byte-equal`);
      assert.strictEqual(bytes(entry.build().document), bytes(doc), 'two builds, one document');
      assert.deepStrictEqual(JSON.parse(bytes(doc)), doc, 'plain JSON');
      assert.ok(Object.isFrozen(doc), 'deep-frozen');
      assert.strictEqual(validate(doc), true, `${entry.name} validates under jaren-contract`);
      assert.strictEqual(validate07(doc), true, `${entry.name} validates under the draft-07 twin`);
      assert.doesNotThrow(() => compileContract(doc));
    });

    it(`${entry.name}: the public projection differs by the materialized defaults and nothing else`, () => {
      const doc = entry.build().document;
      const contract = compileContract(doc);
      const projected = publicProjection(contract);
      const described = contract.describe();
      /** @type {Record<string, any>} */
      const inferred = {};
      for (const op of described.operations) inferred[op.id] = op.inferred;

      // strip from the projection exactly what the compiler
      // materialized — what `describe()` marks inferred, the locations
      // §4.1 chose or the template forced, the policy members the source
      // never declared and an error's resolved status — and undo §4.2's
      // path canonicalization. What is left must be the pen's own
      // document, member for member.
      const stripped = { ...projected };
      /** @type {Record<string, any>} */
      const ops = {};
      for (const id of Object.keys(projected.operations)) {
        const op = { ...projected.operations[id] };
        const source = doc.operations[id];
        const marks = inferred[id];
        if (marks.http) delete op.http;
        else {
          const binding = { ...op.http, in: { ...op.http.in } };
          if (marks.status) delete binding.status;
          if (marks.media) delete binding.media;
          binding.path = source.http.path;   // §4.2 canonicalizes `:name`
          for (const member of Object.keys(binding.in)) {
            if (source.http.in !== undefined && source.http.in[member] !== undefined) continue;
            assert.ok(marks.in.includes(member) || binding.in[member] === 'path'
              || member === source.http.body,
              `${id}: '${member}' was placed by the §4.1 rules, not written by the author`);
            delete binding.in[member];
          }
          if (Object.keys(binding.in).length === 0) delete binding.in;
          op.http = binding;
        }
        const policy = { ...op.policy };
        for (const member of Object.keys(policy)) {
          if (source.policy === undefined || source.policy[member] === undefined) {
            delete policy[member];
          }
        }
        if (Object.keys(policy).length === 0) delete op.policy;
        else op.policy = policy;
        if (op.errors !== undefined) {
          /** @type {Record<string, any>} */
          const errors = {};
          for (const code of Object.keys(op.errors)) {
            const entryDecl = { ...op.errors[code] };
            if (source.errors[code].status === undefined) delete entryDecl.status;
            errors[code] = entryDecl;
          }
          op.errors = errors;
        }
        ops[id] = op;
      }
      stripped.operations = ops;
      assert.deepStrictEqual(stripped, JSON.parse(bytes(doc)),
        'the projection materializes defaults and changes nothing else');
      assert.deepStrictEqual(Object.keys(projected), Object.keys(doc),
        'the root member order is §12.1\'s in both');
      if (doc.$defs !== undefined) {
        assert.deepStrictEqual(Object.keys(projected.$defs), Object.keys(doc.$defs),
          '$defs is in first-reference order in both');
      }
    });
  });
});

describe('the contract pen: the member order §12.1 fixes', () => {
  it('root, operation, error, policy and http members are written in the normative order', () => {
    const doc = Shop.document;
    assert.deepStrictEqual(Object.keys(doc),
      ['$contract', 'id', 'version', 'compat', '$defs', 'operations']);
    assert.deepStrictEqual(Object.keys(doc.operations['catalog.load']),
      ['kind', 'input', 'output', 'errors', 'policy', 'http', 'doc']);
    assert.deepStrictEqual(Object.keys(doc.operations['product.save'].errors.conflict),
      ['status', 'schema']);
    assert.deepStrictEqual(Object.keys(doc.operations['product.save'].policy),
      ['task', 'idempotency', 'revision']);
    assert.deepStrictEqual(Object.keys(doc.operations['product.save'].http),
      ['method', 'path', 'in']);
  });

  it('writes the members in the order the format fixes, whatever order they were declared in', () => {
    const scrambled = defineContract({ version: '1', id: 'x' }, {
      a: read({
        doc: 'a',
        http: http({ media: 'application/json', status: 201, path: '/a', method: 'GET' }),
        policy: { audience: 'public', cache: 'revision', task: 'switch' },
        output: true,
        errors: { bad: error({ schema: { type: 'object' }, status: 418 }) },
      }),
    }).document;
    assert.deepStrictEqual(Object.keys(scrambled), ['$contract', 'id', 'version', 'operations']);
    assert.deepStrictEqual(Object.keys(scrambled.operations.a),
      ['kind', 'output', 'errors', 'policy', 'http', 'doc']);
    assert.deepStrictEqual(Object.keys(scrambled.operations.a.policy),
      ['task', 'cache', 'audience']);
    assert.deepStrictEqual(Object.keys(scrambled.operations.a.http),
      ['method', 'path', 'status', 'media']);
    assert.deepStrictEqual(Object.keys(scrambled.operations.a.errors.bad), ['status', 'schema']);
  });

  it('writes no default: a declared policy carries exactly what was written', () => {
    const doc = defineContract({}, { a: command({ output: true }) }).document;
    assert.deepStrictEqual(doc.operations.a, { kind: 'command', output: true });
    const described = compileContract(doc).describe().operations[0];
    assert.strictEqual(described.task, 'exhaust');
    assert.strictEqual(described.inferred.task, true, 'the compiler materialized it, not the pen');
  });

  it('carries the server-side knobs the projection drops, in their §3.1 places', () => {
    const doc = defineContract({}, {
      a: command({
        output: true,
        policy: { limits: { maxBodyBytes: 4096 }, errors: { details: 'full' }, idempotency: 'optional' },
      }),
    }).document;
    assert.deepStrictEqual(Object.keys(doc.operations.a.policy),
      ['idempotency', 'limits', 'errors']);
    const projected = publicProjection(compileContract(doc));
    assert.strictEqual(projected.operations.a.policy.limits, undefined);
    assert.strictEqual(projected.operations.a.policy.errors, undefined);
  });
});

describe('the contract pen hoists $defs to the contract root', () => {
  it('hoists every named builder once, in first-reference order, referenced #/$defs/<name>', () => {
    assert.deepStrictEqual(Object.keys(Shop.document.$defs), ['Catalog', 'Product', 'Conflict']);
    assert.deepStrictEqual(Shop.document.operations['catalog.load'].output,
      { $ref: '#/$defs/Catalog' });
    assert.deepStrictEqual(Shop.document.$defs.Catalog.properties.products.items,
      { $ref: '#/$defs/Product' });
    assert.strictEqual(Shop.document.$defs.Product.$defs, undefined,
      'a definition carries no $defs of its own');
  });

  it('two distinct builders under one name is JL0103', () => {
    const err = refusal(() => defineContract({}, {
      a: read({ output: s.named('Product', s.object({ id: s.string() })) }),
      b: read({ output: s.named('Product', s.object({ id: s.integer() })) }),
    }));
    assert.ok(err instanceof LinqBuildError);
    assert.strictEqual(err.code, 'JL0103');
    assert.match(err.reason, /two distinct builders are named 'Product'/);
  });

  it('a ref() no definition answers is JL0103', () => {
    const err = refusal(() => defineContract({}, {
      a: read({ output: s.object({ p: s.ref('Nope') }) }),
    }));
    assert.strictEqual(err.code, 'JL0103');
  });

  it('one builder reached from several operations is one entry', () => {
    const doc = defineContract({}, {
      a: read({ output: Product }),
      b: command({ input: s.object({ p: Product }).open(), output: Catalog }),
      c: command({ output: true, errors: { conflict: error({ schema: Conflict }) } }),
    }).document;
    assert.deepStrictEqual(Object.keys(doc.$defs), ['Product', 'Catalog', 'Conflict']);
    assert.doesNotThrow(() => compileContract(doc));
  });
});

describe('the contract pen: the refusals it can see earlier than the compiler', () => {
  it('a path template form the format reserves is JL0102, naming the form', () => {
    const cases = [
      ['/a/{id}.json', /whole segment/],
      ['/a/{+id}', /reserved RFC 6570 operator/],
      ['/a/{id*}', /expansion modifier/],
      ['/a/{a,b}', /list or prefix form/],
      ['/a/*', /reserved wildcard/],
      ['/a/:id?', /reserved "\?" modifier/],
      ['/a/', /trailing "\/"/],
      ['a/b', /must start with "\/"/],
      ['/a/{id}/b/{id}', /declared twice/],
      ['/a/{1x}', /must match \[A-Za-z_\]/],
    ];
    for (const [path, message] of cases) {
      const err = refusal(() => http({ method: 'GET', path }));
      assert.strictEqual(err.code, 'JL0102', `${path} refuses`);
      assert.match(err.reason, /** @type {RegExp} */ (message), `${path} names the form`);
      assert.strictEqual(err.docPath, '/path');
    }
  });

  it('the compiler refuses the same template with JC0008 — the pen is earlier, never different', () => {
    const err = refusal(() => compileContract({
      $contract: '0.1',
      operations: { a: { kind: 'read', output: true, http: { method: 'GET', path: '/a/{id}.json' } } },
    }));
    assert.ok(err instanceof ContractCompileError);
    assert.strictEqual(err.code, 'JC0008');
  });

  it('a `:name` template is written as declared, never canonicalized', () => {
    assert.strictEqual(http({ method: 'PUT', path: '/docs/:id' }).path, '/docs/:id');
    const contract = compileContract(CORPUS[2].build().document);
    assert.strictEqual(contract.operations['doc.put'].http.path, '/docs/{id}',
      'the canonical form is the compiler\'s, and the projections\'');
  });

  it('a kind outside the three is JL0102', () => {
    const err = refusal(() => defineContract({}, { a: { kind: 'stream', output: true } }));
    assert.strictEqual(err.code, 'JL0102');
    assert.match(err.reason, /read, command, subscribe/);
  });

  it('a hand-written operation is checked exactly as a declaration is, at its own position', () => {
    // `{ kind, …members }` is a second door into the same emitter. Before
    // it ran the declaration's checks an unknown member was DROPPED (the
    // pen never emitted it and the compiler never saw it) and a non-string
    // `doc` was written into a document `jaren-contract` refuses.
    const cases = [
      [{ kind: 'read', output: true, extra: 1 }, /does not take 'extra'/, '/operations/a/extra'],
      [{ kind: 'read', output: true, doc: 42 }, /doc is a string/, '/operations/a/doc'],
      [{ kind: 'read' }, /needs an output/, '/operations/a/output'],
    ];
    for (const [declared, message, docPath] of cases) {
      const err = refusal(() => defineContract({}, { a: declared }));
      assert.strictEqual(err.code, 'JL0101', JSON.stringify(declared));
      assert.match(err.reason, /** @type {RegExp} */ (message));
      assert.strictEqual(err.docPath, docPath, 'the docPath is the operation\'s, not the spec\'s');
    }
    // the same three through the declaration door: same reasons, and the
    // docPath is relative because a declaration has no id yet
    for (const [spec, message, docPath] of [
      [{ output: true, extra: 1 }, /does not take 'extra'/, '/extra'],
      [{ output: true, doc: 42 }, /doc is a string/, '/doc'],
      [{}, /needs an output/, '/output'],
    ]) {
      const err = refusal(() => read(/** @type {any} */ (spec)));
      assert.strictEqual(err.code, 'JL0101');
      assert.match(err.reason, /** @type {RegExp} */ (message));
      assert.strictEqual(err.docPath, docPath);
    }
    // and a well-formed hand-written operation still emits and compiles
    const doc = defineContract({}, { a: { kind: 'read', output: true, doc: 'ok' } }).document;
    assert.deepStrictEqual(doc.operations.a, { kind: 'read', output: true, doc: 'ok' });
    assert.doesNotThrow(() => compileContract(doc));
  });

  it('a value that is not JSON is JL0101', () => {
    assert.strictEqual(refusal(() => defineContract({}, {
      a: read({ output: { type: 'string', default: () => 1 } }),
    })).code, 'JL0101');
    assert.strictEqual(refusal(() => defineContract({}, {
      a: read({ output: true, http: http({ method: 'GET', path: '/a', in: { x: 'body', y: NaN } }) }),
    })).code, 'JL0101');
  });

  it('the pen refuses its own surface: an unknown member, a policy value outside its set', () => {
    assert.match(refusal(() => http({ method: 'GET', path: '/a', headers: {} })).reason,
      /does not take 'headers'/);
    assert.match(refusal(() => read({ output: true, extra: 1 })).reason, /does not take 'extra'/);
    assert.match(refusal(() => error({ code: 'x' })).reason, /does not take 'code'/);
    assert.match(refusal(() => defineContract({ name: 'x' }, { a: read({ output: true }) })).reason,
      /does not take 'name'/);
    assert.match(refusal(() => defineContract({}, {
      a: read({ output: true, policy: { task: 'queue' } }),
    })).reason, /policy.task is one of switch, exhaust, concat, parallel/);
    assert.match(refusal(() => defineContract({}, {
      a: read({ output: true, policy: { stream: { resume: 'always' } } }),
    })).reason, /policy.stream.resume is snapshot or replay/);
    assert.match(refusal(() => defineContract({}, {
      a: read({ output: true, policy: { revision: '/x' } }),
    })).reason, /policy.revision is "input:<json-pointer>"/);
    assert.match(refusal(() => defineContract({}, { a: read({}) })).reason,
      /needs an output/);
    assert.match(refusal(() => defineContract({}, {})).reason, /at least one operation/);
    assert.match(refusal(() => defineContract({}, {
      a: read({ output: true, errors: { Bad: error({}) } }),
    })).reason, /matches \^\[a-z\]\[a-z0-9-\]\*\$/);
  });

  it('a member mapped to `path` the template does not declare is JL0102', () => {
    const err = refusal(() => http({ method: 'GET', path: '/a', in: { id: 'path' } }));
    assert.strictEqual(err.code, 'JL0102');
    assert.match(err.reason, /the template declares no \{id\}/);
  });

  it('everything the compiler alone can judge stays the compiler\'s', () => {
    // a read that declares idempotency (JC0014), a GET carrying a body
    // member (JC0016) and two operations sharing a route shape (JC0010)
    // all EMIT — the pen writes them, and the compiler refuses them.
    const idempotentRead = defineContract({}, {
      a: read({ output: true, policy: { idempotency: 'required' } }),
    }).document;
    assert.strictEqual(refusal(() => compileContract(idempotentRead)).code, 'JC0014');
    const getBody = defineContract({}, {
      a: read({
        input: s.object({ id: s.string() }).open(),
        output: true,
        http: http({ method: 'GET', path: '/a', in: { id: 'body' } }),
      }),
    }).document;
    assert.strictEqual(refusal(() => compileContract(getBody)).code, 'JC0016');
    const collision = defineContract({}, {
      a: read({ output: true, http: http({ method: 'GET', path: '/a/{x}' }) }),
      b: read({ output: true, http: http({ method: 'GET', path: '/a/{y}' }) }),
    }).document;
    assert.strictEqual(refusal(() => compileContract(collision)).code, 'JC0009');
  });
});

describe('a pen contract is a contract: it serves, invokes and becomes tools', () => {
  it('one invoke round-trips through serveLocal', async () => {
    const compiled = compileContract(Shop.document);
    const product = { id: 1, name: 'Anvil', price: 9.5 };
    const client = typedClient(openLocalClient(compiled, typedHandlers(Shop, {
      'catalog.load': () => ({ revision: 4, products: [product] }),
      'product.save': (input, ctx) => (input.revision === 4
        ? input.product
        : ctx.fail('conflict', {}, { current: product })),
    })), Shop);
    const ok = await client.invoke('product.save', { id: 1, revision: 4, product });
    assert.strictEqual(ok.ok, true);
    assert.deepStrictEqual(ok.value, product);
    const failed = await client.invoke('product.save', { id: 1, revision: 3, product });
    assert.strictEqual(failed.ok, false);
    assert.strictEqual(failed.error.code, 'conflict');
    assert.deepStrictEqual(failed.error.details, { current: product });
    const loaded = await client.invoke('catalog.load', {});
    assert.strictEqual(loaded.ok, true);
    assert.strictEqual(loaded.value.revision, 4);
    client.close();
  });

  it('contractTools over a pen contract registers into a real toolbox', async () => {
    const compiled = compileContract(Shop.document);
    const client = openLocalClient(compiled, {
      'catalog.load': () => ({ revision: 1, products: [] }),
      'product.save': (input) => input.product,
    });
    const tools = typedTools(contractTools(compiled, client), Shop);
    assert.deepStrictEqual(tools.map((t) => t.name), ['catalog_load', 'product_save'],
      'the opaque operation is not a tool');
    const toolbox = createToolbox();
    for (const tool of tools) toolbox.add(tool);
    const product = { id: 2, name: 'Rope', price: 3 };
    const answer = await toolbox.execute('product_save', { id: 2, revision: 1, product });
    assert.strictEqual(answer.ok, true);
    assert.deepStrictEqual(answer.value, product);
    // the tool's input schema stands alone: the $defs it reaches are inlined
    const save = tools.find((t) => t.name === 'product_save');
    assert.deepStrictEqual(Object.keys(save.inputSchema.$defs), ['Product']);
    client.close();
  });

  it('a subscribe operation compiles with the shape §17 forces', () => {
    const Board = s.named('Board', s.object({ seq: s.integer() }).open());
    const doc = defineContract({ id: 'live' }, {
      'board.watch': subscribe({
        input: s.object({ id: s.string() }).open(),
        output: Board,
        policy: { task: 'switch', stream: { resume: 'replay', heartbeatMs: 2000 } },
        http: http({ method: 'GET', path: '/board/{id}' }),
      }),
    }).document;
    assert.deepStrictEqual(Object.keys(doc.operations['board.watch'].policy), ['task', 'stream']);
    const described = compileContract(doc).describe().operations[0];
    assert.strictEqual(described.media, 'text/event-stream', 'the compiler forces it');
    assert.deepStrictEqual(described.stream, { resume: 'replay', heartbeatMs: 2000, maxPatchBytes: null });
    // the pen writes a POST binding the compiler refuses — §17's rule is not the pen's
    const posted = defineContract({}, {
      a: subscribe({ output: true, http: http({ method: 'POST', path: '/a' }) }),
    }).document;
    assert.strictEqual(refusal(() => compileContract(posted)).code, 'JC0019');
  });
});

describe('the contract pen: the generated projection', () => {
  it('the committed fixture is exactly what the generator produces', () => {
    const committed = fs.readFileSync(GENERATED, 'utf8');
    assert.strictEqual(committed, renderFixture(),
      'regenerate with `node scripts/generate-contract-pen-fixture.js`');
    assert.ok(committed.startsWith(HEADER));
  });
});
