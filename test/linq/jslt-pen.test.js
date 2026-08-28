//@ts-check
/**
 * @file The JSLT pen, held to the format: JSLT-FORMAT Appendix A.1–A.7
 * are rebuilt through the pen and asserted BYTE-EQUAL to the documents
 * in the format doc — read from the doc's fences at test time, never a
 * copy — then validated against both published grammars, compiled with
 * the engine (the schema-pen's type-test hook injected where a `schema`
 * match exists) and run over the appendix's own inputs to its outputs.
 * Beside the appendix: the body capture (externals, the `$$` escape,
 * constructors), `apply`'s two forms and the `[]` refusal, `op` against
 * a registry, the rule and envelope refusals by code, two-run
 * determinism, and the no-engine rule.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { body, apply, op, rule, stylesheet } from '@jarenjs/linq/jslt';
import * as s from '@jarenjs/linq/schema';
import { from, LinqBuildError } from '@jarenjs/linq';
import {
  compileJsltStylesheet, createJsltRegistry, financePack, JsltCompileError, JsltRuntimeError,
} from '@jarenjs/json/jslt';
import { createTypeTestCompiler } from '@jarenjs/validate/query';

import { compileArtifact } from '../json/schema-artifact-helpers.js';

const DOC = new URL('../../packages/json/docs/JSLT-FORMAT.md', import.meta.url);
const SCHEMAS = new URL('../../packages/json/schemas/', import.meta.url);
const JSLT_SRC = new URL('../../packages/linq/src/jslt/', import.meta.url);

const compileTypeTest = createTypeTestCompiler();
const validators = [
  ['2020-12', compileArtifact(JSON.parse(fs.readFileSync(new URL('jaren-jslt.schema.json', SCHEMAS), 'utf8')))],
  ['draft-07', compileArtifact(JSON.parse(fs.readFileSync(new URL('jaren-jslt.draft-07.schema.json', SCHEMAS), 'utf8')))],
];

/** The bytes a document is: JSON text, member order included. @param {any} doc */
const bytes = (doc) => JSON.stringify(doc);

/**
 * The `### A.n` sections of Appendix A: each one's ```json fences in
 * order — the stylesheet, the input, and the output where the doc
 * prints one (A.1's output is the input itself, in prose).
 * @returns {Map<string, any[]>}
 */
function readAppendix() {
  const markdown = fs.readFileSync(DOC, 'utf8');
  const start = markdown.indexOf('\n## Appendix A.');
  const end = markdown.indexOf('\n## Appendix B.', start);
  assert.ok(start !== -1 && end !== -1, 'Appendix A is where the doc keeps it');
  const sections = new Map();
  const heads = [...markdown.slice(start, end).matchAll(/\n### (A\.\d+) /g)];
  heads.forEach((head, i) => {
    const from = start + (head.index ?? 0);
    const to = i + 1 < heads.length ? start + (heads[i + 1].index ?? 0) : end;
    const fences = [...markdown.slice(from, to).matchAll(/```json\n([\s\S]*?)```/g)]
      .map((m) => JSON.parse(m[1]));
    sections.set(head[1], fences);
  });
  return sections;
}

/** Appendix A, rebuilt through the pen — every document from the section's own prose. */
const APPENDIX = {
  'A.1': () => [],
  'A.2': () => [rule('$..price', (v) => v.mul(1.21))],
  'A.3': () => stylesheet([
    rule({ schema: { type: 'object', required: ['isbn'] } },
      (v) => ({ title: v.title, children: [apply(v.chapters.all())] })),
    rule({ schema: { type: 'object', required: ['heading'] } },
      (v) => ({ name: v.heading })),
  ]),
  'A.4': () => stylesheet([
    rule('$', (v) => ({
      toc: [apply(v.sections.all(), 'toc')],
      body: [apply(v.sections.all(), 'render')],
    })),
    rule('$.sections[*]', (v) => ({ ref: v.id, label: v.heading }), { mode: 'toc' }),
    rule('$.sections[*]', (v) => ({ anchor: v.id, heading: v.heading, text: v.text }), { mode: 'render' }),
  ]),
  'A.5': () => stylesheet([
    rule({ schema: { type: 'object', required: ['price'] } },
      (v) => ({ title: v.title, price: v.price, taxed: v.price.mul(1.21) })),
  ], { unmatched: 'fresh' }),
  'A.6': () => stylesheet([
    rule('$', (v) => [apply(v.events.all())]),
    rule({ schema: { type: 'object', required: ['error'] } }, (v) => ({ level: 'fatal', message: v.error })),
    rule({ schema: { type: 'object', required: ['info'] } }, (v) => ({ level: 'note', message: v.info })),
    rule(null, () => ({ level: 'unknown' })),
  ], { unmatched: 'error' }),
  'A.7': () => [rule('$..price', body(
    (v, x) => ({ amount: v.mul(x.rate), currency: x.root.currency, at: x.path }),
    { externals: ['rate'] }))],
};

describe('JSLT-FORMAT Appendix A, rebuilt through the pen', () => {
  const sections = readAppendix();

  it('reads the seven worked examples from the doc', () => {
    assert.deepStrictEqual([...sections.keys()], Object.keys(APPENDIX));
    for (const [name, fences] of sections) {
      assert.ok(fences.length >= 2, `${name} carries a stylesheet and an input`);
    }
  });

  for (const [name, build] of Object.entries(APPENDIX)) {
    it(`${name} is byte-equal to the doc, valid under both grammars, compiles and runs`, () => {
      const [expected, input, output] = sections.get(name);
      const doc = build();
      assert.strictEqual(bytes(doc), bytes(expected), `${name} byte-equal`);
      assert.strictEqual(bytes(build()), bytes(doc), `${name} two runs, one document`);
      assert.deepStrictEqual(JSON.parse(bytes(doc)), doc, 'plain JSON');
      // the envelope is frozen whole; the bare-array form is the rules, each frozen
      for (const part of Array.isArray(doc) ? doc : [doc]) assert.strictEqual(Object.isFrozen(part), true);
      for (const [draft, validate] of validators) {
        assert.strictEqual(validate(doc), true, `${name} under ${draft}`);
      }
      const transform = compileJsltStylesheet(doc, { compileTypeTest });
      if (name === 'A.1') {
        assert.strictEqual(transform(input), input, 'the empty stylesheet is the identity, === included');
        return;
      }
      if (name === 'A.7') {
        assert.deepStrictEqual(transform.externals, ['rate']);
        assert.deepStrictEqual(transform(input, { rate: 1.21 }), output);
        assert.throws(() => transform(input),
          (e) => e instanceof JsltRuntimeError && e.code === 'JT2004' && e.cause?.code === 'JQ2006');
        return;
      }
      const result = transform(input);
      assert.deepStrictEqual(result, output);
      if (name === 'A.2') assert.strictEqual(result.meta, input.meta, 'the untouched subtree is shared');
      if (name === 'A.5') {
        assert.notStrictEqual(result, input);
        assert.notStrictEqual(result.products, input.products);
      }
    });
  }

  it('A.6 without its fallback rule raises JT2003 at the unmatched location', () => {
    const doc = /** @type {any} */ (APPENDIX['A.6']());
    const exhaustive = stylesheet(doc.rules.slice(0, 3), { unmatched: 'error' });
    const [, input] = sections.get('A.6');
    assert.throws(() => compileJsltStylesheet(exhaustive, { compileTypeTest })(input),
      (e) => e instanceof JsltRuntimeError && e.code === 'JT2003' && /\$\['events'\]\[2\]/.test(e.message));
  });

  it('§5.4 — the self-application loop spelled by the pen dies with JT2001, not a stack overflow', () => {
    const loop = stylesheet([rule(null, (v) => apply(v))]);
    assert.strictEqual(bytes(loop), '{"$jslt":"0.1","rules":[{"body":{"$apply":"$"}}]}');
    assert.throws(() => compileJsltStylesheet(loop)({ a: 1 }),
      (e) => e instanceof JsltRuntimeError && e.code === 'JT2001');
  });
});

describe('body() — the shared body capture', () => {
  it('captures over $ with root and path present and no declaration', () => {
    const doc = body((v, x) => ({ me: v, root: x.root.currency, at: x.path, deep: x.root.a.b.at(0) }));
    assert.deepStrictEqual(doc, { me: '$', root: '$root.currency', at: '$path', deep: '$root.a.b[0]' });
    const out = compileJsltStylesheet([rule('$.x', doc)])({ currency: 'EUR', a: { b: [7] }, x: 1 });
    assert.deepStrictEqual(out, { currency: 'EUR', a: { b: [7] }, x: { me: 1, root: 'EUR', at: "$['x']", deep: 7 } });
  });

  it('a declared parameter is an external; an undeclared one is JL0104 with the declaration in the message', () => {
    assert.deepStrictEqual(body((v, x) => v.mul(x.rate), { externals: ['rate'] }), { $mul: ['$', '$rate'] });
    assert.throws(() => body((v, x) => v.mul(x.rate)),
      (e) => e instanceof LinqBuildError && e.code === 'JL0104' && /'rate'/.test(e.message)
        && /body\(fn, \{ externals: \['rate'\] \}\)/.test(e.message));
    assert.throws(() => body((v, x) => x.limit, { externals: ['rate'] }),
      (e) => e.code === 'JL0104' && /'limit'/.test(e.message) && /'root' and 'path' and 'rate'/.test(e.message));
    // root and path are engine-bound: declaring them is the mistake, named
    assert.throws(() => body((v) => v, { externals: ['root'] }), (e) => e.code === 'JL0104' && /engine-bound/.test(e.message));
    assert.throws(() => body((v) => v, { externals: ['path'] }), (e) => e.code === 'JL0104');
    // the options are checked at the door
    assert.throws(() => body((v) => v, { externals: 'rate' }), (e) => e.code === 'JL0101');
    assert.throws(() => body((v) => v, { externals: ['not a name'] }), (e) => e.code === 'JL0101');
    assert.throws(() => body((v) => v, { params: ['rate'] }), (e) => e.code === 'JL0101' && /'params'/.test(e.message));
    assert.throws(() => body('$'), (e) => e.code === 'JL0101' && /callback/.test(e.message));
  });

  it('a returned literal is a constructor, never a folded $const; a string starting $ is escaped', () => {
    const doc = body(() => ({ level: 'unknown', tag: '$literal', meta: { list: [1, 'two'] } }));
    assert.deepStrictEqual(doc, { level: 'unknown', tag: '$$literal', meta: { list: [1, 'two'] } });
    assert.deepStrictEqual(compileJsltStylesheet([rule('$', doc)])({}),
      { level: 'unknown', tag: '$literal', meta: { list: [1, 'two'] } });
    // the chain keeps its own spelling for the same literal
    const chain = /** @type {any} */ (from([{}]).select(() => ({ level: 'unknown' })).explain().document);
    assert.deepStrictEqual(chain.$return, { $const: { level: 'unknown' } });
    // a scalar body, a path body
    assert.strictEqual(body(() => 'hello'), 'hello');
    assert.strictEqual(body((v) => v), '$');
    assert.strictEqual(body(() => '$x'), '$$x');
  });

  it('the document is a value: plain, deep-frozen, not the caller\'s object', () => {
    const list = [1, 2];
    const doc = body(() => ({ list }));
    assert.strictEqual(Object.isFrozen(doc), true);
    assert.strictEqual(Object.isFrozen(doc.list), true);
    assert.notStrictEqual(doc.list, list);
    assert.strictEqual(Object.isFrozen(list), false);
  });

  it('captures nest: a body built inside another callback is its own document; the outer proxies stay live', () => {
    let inner;
    const outer = body((v) => { inner = body((w) => w.x); return { me: v.y }; });
    assert.strictEqual(inner, '$.x');
    assert.deepStrictEqual(outer, { me: '$.y' });
    // and an inner document embedded in the outer literal is DATA there (the $$ escape says so)
    assert.deepStrictEqual(body((v) => ({ doc: body((w) => w.x), me: v.y })), { doc: '$$.x', me: '$.y' });
  });
});

describe('apply() — the two forms and the [] idiom', () => {
  it('spells the selector form, the argument-list form, and composes as an expression', () => {
    assert.deepStrictEqual(body((v) => [apply(v.chapters.all())]), [{ $apply: '$.chapters[*]' }]);
    assert.deepStrictEqual(body(() => [apply('$.chapters[*]')]), [{ $apply: '$.chapters[*]' }]);
    assert.deepStrictEqual(body((v) => [apply(v.sections.all(), 'toc')]), [{ $apply: ['$.sections[*]', 'toc'] }]);
    assert.deepStrictEqual(body(() => [apply('$.x', '')]), [{ $apply: ['$.x', ''] }]);
    assert.deepStrictEqual(body(() => [apply([1, 2])]), [{ $apply: { $const: [1, 2] } }]);
    assert.deepStrictEqual(body((v) => ({ n: apply(v.items.all()).count() })), { n: { $count: { $apply: '$.items[*]' } } });
    assert.deepStrictEqual(body((v, x) => [apply(x.root.items.all())]), [{ $apply: '$root.items[*]' }]);
    // and it runs: a count of dispatched children
    const counted = stylesheet([
      rule('$', (v) => ({ n: apply(v.items.all()).count() })),
      rule('$.items[*]', (v) => v.mul(2)),
    ]);
    assert.deepStrictEqual(compileJsltStylesheet(counted)({ items: [1, 2, 3] }), { n: 3 });
  });

  it('refuses an apply as a bare object member (JL0102) at build time, naming the member and the fix', () => {
    assert.throws(() => body((v) => ({ children: apply(v.chapters.all()) })),
      (e) => e instanceof LinqBuildError && e.code === 'JL0102' && e.docPath === '/children'
        && /exactly one value/.test(e.message) && /children: \[apply/.test(e.message));
    assert.throws(() => body((v) => ({ a: { b: [{ c: apply(v.x) }] } })),
      (e) => e.code === 'JL0102' && e.docPath === '/a/b/0/c');
    // the engine would only say so at RUN time, on the second child
    const hand = [rule({ schema: { type: 'object', required: ['isbn'] } }, { title: '$.title', children: { $apply: '$.chapters[*]' } })];
    const transform = compileJsltStylesheet(hand, { compileTypeTest });
    assert.deepStrictEqual(transform({ isbn: 'x', title: 'T', chapters: [1] }), { title: 'T', children: 1 });
    assert.throws(() => transform({ isbn: 'x', title: 'T', chapters: [1, 2] }),
      (e) => e instanceof JsltRuntimeError && e.code === 'JT2004' && e.cause?.code === 'JQ2001');
  });

  it('is a body-only operator: outside body() JL0102, a non-string mode JL0101, no selector JL0101', () => {
    assert.throws(() => apply('$'), (e) => e.code === 'JL0102' && /inside body\(\)/.test(e.message));
    assert.throws(() => body((v) => [apply(v, v.mode)]), (e) => e.code === 'JL0101' && /literal string/.test(e.message) && /an expression/.test(e.message));
    assert.throws(() => body(() => [apply()]), (e) => e.code === 'JL0101');
    // and the pen judges no arity the engine judges: an argument list of three is the compiler's JQ0003
    assert.throws(() => compileJsltStylesheet([rule('$', { $apply: ['$', 'toc', 'extra'] })]),
      (e) => e instanceof JsltCompileError && e.code === 'JT0007' && e.cause?.code === 'JQ0003');
  });
});

describe('op() — a registered operator, spelled without judging it', () => {
  const sheet = stylesheet([rule('$', (v) => ({ value: op('$npv', [v.rate, v.cashflows.all()]) }))]);
  const input = { rate: 0.1, cashflows: [-100, 60, 60] };

  it('emits the operator document and the registry decides: runs with financePack, JQ0002 without', () => {
    assert.deepStrictEqual(sheet.rules[0].body, { value: { $npv: ['$.rate', '$.cashflows[*]'] } });
    const jslt = createJsltRegistry().use(financePack);
    const out = jslt.compile(sheet)(input);
    assert.ok(Math.abs(out.value - 4.132231404958667) < 1e-12, `npv ${out.value}`);
    assert.throws(() => compileJsltStylesheet(sheet),
      (e) => e instanceof JsltCompileError && e.code === 'JT0007' && e.cause?.code === 'JQ0002');
  });

  it('takes one operand or a list; a name without $ is JL0101; outside any capture JL0005', () => {
    assert.deepStrictEqual(body((v) => op('$sqrt', v.x)), { $sqrt: '$.x' });
    assert.deepStrictEqual(body(() => op('$now')), { $now: [] });
    assert.deepStrictEqual(body((v) => op('$x', [v.a, 1, { k: 'v' }])), { $x: ['$.a', 1, { $const: { k: 'v' } }] });
    assert.throws(() => body(() => op('npv', [])), (e) => e.code === 'JL0101' && /starting with '\$'/.test(e.message));
    assert.throws(() => op('$npv', []), (e) => e.code === 'JL0005');
    // it lifts in a chain capture too — the document is the same; the
    // chain's options carry no operator registry today, so the engine says JQ0002
    const chain = from([input]).select((r) => ({ v: op('$npv', [r.rate, r.cashflows.all()]) }));
    assert.throws(() => chain.explain(), (e) => e.code === 'JQ0002' && e.docPath === '/$return/v');
    assert.throws(() => chain.toArray(), (e) => e.code === 'JQ0002');
  });
});

describe('rule() and stylesheet() — the rule object and the envelope', () => {
  it('emits the members in one order: mode, match, priority, body; $jslt, unmatched, modes, rules', () => {
    const r = rule('$.x', (v) => v, { priority: 2, mode: 'm' });
    assert.deepStrictEqual(Object.keys(r), ['mode', 'match', 'priority', 'body']);
    assert.deepStrictEqual(Object.keys(rule(null, (v) => v)), ['body']);
    const sheet = stylesheet([r], { modes: { m: { unmatched: 'error' } }, unmatched: 'fresh' });
    assert.deepStrictEqual(Object.keys(sheet), ['$jslt', 'unmatched', 'modes', 'rules']);
    assert.deepStrictEqual(sheet, {
      $jslt: '0.1', unmatched: 'fresh', modes: { m: { unmatched: 'error' } },
      rules: [{ mode: 'm', match: '$.x', priority: 2, body: '$' }],
    });
    for (const [draft, validate] of validators) assert.strictEqual(validate(sheet), true, draft);
    assert.doesNotThrow(() => compileJsltStylesheet(sheet));
  });

  it('a match is a path string, { path?, schema? } with a builder or a document, or absent', () => {
    const Book = s.object({ isbn: s.string(), title: s.string() }).open();
    assert.deepStrictEqual(rule({ schema: Book }, (v) => v.title).match, { schema: Book.schema });
    assert.deepStrictEqual(rule({ path: '$.a', schema: { type: 'object' } }, (v) => v).match,
      { path: '$.a', schema: { type: 'object' } });
    assert.deepStrictEqual(rule({ schema: true }, (v) => v).match, { schema: true });
    assert.strictEqual('match' in rule(undefined, (v) => v), false);
    // a builder match compiles with the hook and dispatches by shape
    const sheet = stylesheet([rule({ schema: Book }, (v, x) => ({ t: v.title, r: x.root.isbn, p: x.path }))]);
    for (const [draft, validate] of validators) assert.strictEqual(validate(sheet), true, draft);
    assert.deepStrictEqual(compileJsltStylesheet(sheet, { compileTypeTest })({ isbn: 'i', title: 'T' }), { t: 'T', r: 'i', p: '$' });
    // without the hook the engine says JT0006 — the pen does not
    assert.throws(() => compileJsltStylesheet(sheet), (e) => e instanceof JsltCompileError && e.code === 'JT0006');
  });

  it('refuses what the compiler would refuse and the pen can see: {} (JL0102), the shapes (JL0101)', () => {
    assert.throws(() => rule({}, (v) => v), (e) => e instanceof LinqBuildError && e.code === 'JL0102' && e.docPath === '/match' && /JT0003/.test(e.message));
    assert.throws(() => rule({ paths: '$' }, (v) => v), (e) => e.code === 'JL0101' && e.docPath === '/match/paths');
    assert.throws(() => rule({ path: 42 }, (v) => v), (e) => e.code === 'JL0101' && e.docPath === '/match/path');
    assert.throws(() => rule({ schema: new Date(0) }, (v) => v), (e) => e.code === 'JL0101' && /Date instance/.test(e.message));
    assert.throws(() => rule(42, (v) => v), (e) => e.code === 'JL0101');
    assert.throws(() => rule('$'), (e) => e.code === 'JL0101' && e.docPath === '/body');
    assert.throws(() => rule('$', () => 1n), (e) => e.code === 'JL0005', 'a captured non-JSON is the chain\'s refusal');
    assert.throws(() => rule('$', { $const: Symbol('x') }), (e) => e.code === 'JL0101');
    assert.throws(() => rule('$', (v) => v, { priority: 'high' }), (e) => e.code === 'JL0101' && e.docPath === '/priority');
    assert.throws(() => rule('$', (v) => v, { priority: NaN }), (e) => e.code === 'JL0101');
    assert.throws(() => rule('$', (v) => v, { priority: -0 }), (e) => e.code === 'JL0101');
    assert.throws(() => rule('$', (v) => v, { mode: 1 }), (e) => e.code === 'JL0101' && e.docPath === '/mode');
    assert.throws(() => rule('$', (v) => v, { modes: 'x' }), (e) => e.code === 'JL0101' && /'modes'/.test(e.message));
    assert.throws(() => rule('$', (v) => v, 'toc'), (e) => e.code === 'JL0101');
    assert.throws(() => stylesheet({ rules: [] }), (e) => e.code === 'JL0101' && e.docPath === '/rules');
    assert.throws(() => stylesheet([], { unmatched: 'copy' }), (e) => e.code === 'JL0101' && e.docPath === '/unmatched');
    assert.throws(() => stylesheet([], { version: '0.1' }), (e) => e.code === 'JL0101' && /'version'/.test(e.message));
    assert.throws(() => stylesheet([], { modes: { m: { unmatched: 'share', extra: 1 } } }), (e) => e.code === 'JL0101' && e.docPath === '/modes/m');
    assert.throws(() => stylesheet([], { modes: { m: {} } }), (e) => e.code === 'JL0101');
    assert.throws(() => stylesheet([], { modes: { m: { unmatched: 'x' } } }), (e) => e.code === 'JL0101' && e.docPath === '/modes/m/unmatched');
    assert.throws(() => stylesheet(['$']), (e) => e.code === 'JL0101' && e.docPath === '/rules/0');
    assert.throws(() => stylesheet([{ match: '$' }]), (e) => e.code === 'JL0101' && e.docPath === '/rules/0/body' && /JT0002/.test(e.message));
    // what it does NOT judge: path syntax, the body's operators — the compiler's
    const badPath = stylesheet([rule('$[', (v) => v)]);
    assert.throws(() => compileJsltStylesheet(badPath), (e) => e instanceof JsltCompileError && e.code === 'JT0003');
    const badOp = stylesheet([rule('$', { $frobnicate: 1 })]);
    assert.throws(() => compileJsltStylesheet(badOp), (e) => e instanceof JsltCompileError && e.code === 'JT0007');
  });

  it('a hand-written rule or body rides verbatim, copied and frozen; the envelope is a value', () => {
    const hand = { match: '$..price', body: { $mul: ['$', 2] } };
    const sheet = stylesheet([hand, rule('$', '$')]);
    assert.deepStrictEqual(sheet.rules, [hand, { match: '$', body: '$' }]);
    assert.notStrictEqual(sheet.rules[0], hand);
    assert.strictEqual(Object.isFrozen(sheet.rules[0].body), true);
    assert.strictEqual(Object.isFrozen(hand), false);
    assert.strictEqual(bytes(stylesheet([hand, rule('$', '$')])), bytes(sheet));
    assert.deepStrictEqual(compileJsltStylesheet(sheet)({ price: 3 }), { price: 3 });
  });

  it('the pen imports no engine', () => {
    for (const file of fs.readdirSync(JSLT_SRC)) {
      const source = fs.readFileSync(new URL(file, JSLT_SRC), 'utf8');
      assert.strictEqual(/from '@jarenjs\/(json|validate|emit|db)/.test(source), false, `${file} imports an engine`);
      assert.strictEqual(/from '\.\.\/(sequence|document|async|provider|sources|schema-of)\.js'/.test(source), false, `${file} imports the chain`);
      assert.strictEqual(/from '\.\.\/schema\/(?!brand\.js)/.test(source), false, `${file} imports a schema module other than brand.js`);
    }
    void path;
  });
});
