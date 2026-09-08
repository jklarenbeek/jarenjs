//@ts-check
/** Rebuild the published templates through every fluent segment and run the same renderer. */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as p from '@jarenjs/linq/jtlt';
import { compileJtltStylesheet, validateJtltTemplate } from '@jarenjs/json/jtlt';
import { JarenValidator } from '@jarenjs/validate';
import latest from '@jarenjs/json/schemas/jaren-jtlt.schema.json' with { type: 'json' };
import old from '@jarenjs/json/schemas/jaren-jtlt.draft-07.schema.json' with { type: 'json' };

const grammars = [latest, old].map((s) => new JarenValidator().compile(s));
const markdown = readFileSync(new URL('../../packages/json/docs/JTLT-FORMAT.md', import.meta.url), 'utf8');
const appendix = markdown.split('## Appendix A.')[1].split('## Appendix B.')[0];
const examples = [...appendix.matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => JSON.parse(m[1]))
  .filter((doc) => Array.isArray(doc) || doc.$jtlt);
const contract = JSON.parse(readFileSync(new URL('../../packages/contract/src/project/typescript.jtlt.json', import.meta.url), 'utf8'));

function segment(value) {
  if (typeof value === 'string') return value.startsWith('$$') ? p.text(value.slice(1)) : value.startsWith('$') ? p.query(value) : p.text(value);
  if (Array.isArray(value)) return value.map(segment);
  if (Object.keys(value).length === 1) {
    if (Object.hasOwn(value, '$raw')) return p.raw(value.$raw);
    if (Object.hasOwn(value, '$json')) return p.json(value.$json);
    if (Object.hasOwn(value, '$apply')) {
      const v = value.$apply;
      return Array.isArray(v) ? p.apply(v[0], v[1]) : p.apply(v);
    }
  }
  return p.query(value);
}
function rebuild(doc) {
  const rules = (Array.isArray(doc) ? doc : doc.rules).map(({ body, ...options }) => p.rule(body.map(segment), options));
  if (Array.isArray(doc)) return p.bare(rules);
  const { $jtlt: _version, rules: _rules, ...options } = doc;
  return p.stylesheet(rules, options);
}
const data = {
  greeting: 'hello', count: 2, flag: true, gap: null, currency: 'EUR',
  store: { book: [{ title: 'A', price: 8.95 }] }, title: 'Q&A', markup: '<b>hi</b>',
  sections: [{ heading: 'Intro', text: 'Hello' }], items: [{ price: 10 }],
  banner: '// generated\n', types: 'type Input = string; type Output = number;\n',
  operations: [{ id: 'load', kind: 'read', input: 'Input', output: 'Output', opaque: false, errors: ['missing'] },
    { id: 'bytes', input: 'Input', opaque: true }],
};

describe('JTLT pen', () => {
  it('has every Appendix A template plus the production contract template', () => assert.equal(examples.length, 8));
  for (const [i, hand] of [...examples, contract].entries()) {
    it(`template ${i + 1}: exact bytes, both grammars, compiler and renderer`, () => {
      const pen = rebuild(hand);
      assert.equal(JSON.stringify(pen), JSON.stringify(hand));
      for (const validate of grammars) assert.equal(validate(pen.schema), true);
      assert.equal(validateJtltTemplate(pen.schema).valid, true);
      assert.equal(compileJtltStylesheet(pen.schema)(data, { rate: 1.21 }), compileJtltStylesheet(hand)(data, { rate: 1.21 }));
      assert.deepEqual(p.from(hand).schema, hand);
    });
  }
  it('captures query-valued members with declared and engine-bound externals', () => {
    const body = [p.text('$cost='), p.query((v, x) => v.get('n').mul(x.rate), { externals: ['rate'] }),
      p.raw((v) => v.get('markup')), p.json((v) => v.get('obj')), p.query((_v, x) => x.root.get('n'))];
    const built = p.stylesheet([p.rule(body, { match: '$' })], { output: 'xml' });
    assert.deepEqual(built.schema.rules[0].body, ['$$cost=', { $mul: ["$['n']", '$rate'] }, { $raw: "$['markup']" }, { $json: "$['obj']" }, "$root['n']"]);
    assert.equal(compileJtltStylesheet(built.schema)({ n: 2, markup: '<b>', obj: { a: 1 } }, { rate: 3 }), '$cost=6<b>{&quot;a&quot;:1}2');
    assert.deepEqual(p.apply((v) => v.get('n')), { $apply: "$['n']" });
    assert.throws(() => p.query((_v, x) => x.absent), { code: 'JL0104' });
  });
  it('updates rules and envelopes immutably while preserving bare lists', () => {
    const body = ['old'];
    const a = p.rule(body);
    const b = a.match({ schema: { type: 'number' } }).mode('m').priority(2).body(['new']);
    body[0] = 'changed';
    assert.deepEqual(a.schema, { body: ['old'] });
    assert.deepEqual(b.schema, { body: ['new'], match: { schema: { type: 'number' } }, mode: 'm', priority: 2 });
    const bare = p.bare().rule(a);
    assert.ok(Array.isArray(bare.schema));
    assert.deepEqual(bare.rules([b]).schema, [b.schema]);
    const envelope = bare.output('xml');
    assert.deepEqual(envelope.schema, { $jtlt: '0.1', output: 'xml', rules: [a.schema] });
    assert.deepEqual(envelope.output('text').rules([]).rule(b.schema).schema.rules, [b.schema]);
    assert.ok(Object.isFrozen(envelope.schema.rules[0].body));
    assert.equal(compileJtltStylesheet(p.stylesheet([p.rule().body(['x'])]).schema)({}), 'x');
  });
  it('rejects unspellable input and delegates template semantics to the compiler', () => {
    const cases = [() => p.text(3), () => p.rule(null), () => p.stylesheet(null), () => p.rule([], { extra: true }),
      () => p.query(3), () => p.query({ a: 1 }), () => p.raw(undefined), () => p.apply('$', 3),
      () => p.bare().output('html'), () => p.query('$', { externals: ['root'] }),
      () => p.query('$', { externals: ['a', 'a'] }), () => p.query('$', { externals: ['bad-name'] })];
    for (const make of cases) assert.throws(make, { code: 'JL0101' });
    const reserved = p.stylesheet([p.rule([]).priority(-1e308)]);
    assert.equal(validateJtltTemplate(reserved.schema).errors[0].code, 'TL0003');
  });
});
