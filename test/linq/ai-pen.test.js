//@ts-check
/** The complete action vocabulary, including real recorded programs and runner behavior. */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as p from '@jarenjs/linq/ai';
import { JarenValidator } from '@jarenjs/validate';
import { compileJsonQuery } from '@jarenjs/json/query';
import { PROGRAM_SCHEMA, PROGRAM_OPS, PROGRAM_EXAMPLE, programSchema, compileProgram, programGate, createEnvironment, createProgramRunner } from '@jarenjs/ai';
import querySchema from '@jarenjs/json/schemas/jaren-query.schema.json' with { type: 'json' };
import { pairwiseProgram, needleProgram, extractingClient } from '../../benchmark/lib/horizon.js';

const validate = new JarenValidator().addSchema(querySchema).compile(programSchema({ queryRef: querySchema.$id }));
const options = { compileQuery: compileJsonQuery, known: ['corpus', 'data'] };
const gate = programGate(options);
const hands = {
  chunk: { op: 'chunk', from: 'corpus', as: 'pieces', strategy: 'line', size: 200 },
  grep: { op: 'grep', from: 'corpus', as: 'hits', pattern: 'REC0000', flags: 'i', limit: 2 },
  select: { op: 'select', from: 'data', as: 'selected', query: { $add: ['$.n', 1] } },
  stat: { op: 'stat', from: 'corpus', as: 'stats' },
  peek: { op: 'peek', from: 'corpus', as: 'meta' },
  map: { op: 'map', from: 'pieces', as: 'found', prompt: 'Return the record as JSON' },
  reduce: { op: 'reduce', from: 'found', as: 'total', query: { $count: '$[*]' }, outputSchema: { type: 'integer' } },
  answer: { op: 'answer', from: 'corpus', chars: 50 },
};
function factory({ op, from, as, ...extra }) {
  if (op === 'reduce') return p.reduce(from, as, extra.query, { outputSchema: extra.outputSchema });
  if (op === 'select') return p.select(from, as, extra.query);
  if (op === 'map') return p.map(from, as, extra.prompt);
  if (op === 'answer') return p.answer(from, extra);
  return p[op](from, as, extra);
}
function rebuild(hand) {
  let pen = p.program(['corpus', 'data']);
  for (const { op, from, as, ...extra } of hand.steps) {
    if (op === 'reduce') pen = pen.reduce(from, as, extra.query, extra.outputSchema ? { outputSchema: extra.outputSchema } : {});
    else if (op === 'select') pen = pen.select(from, as, extra.query);
    else if (op === 'map') pen = pen.map(from, as, extra.prompt);
    else if (op === 'answer') pen = pen.answer(from, extra);
    else pen = pen[op](from, as, extra);
  }
  return pen;
}
async function runner() {
  const environment = createEnvironment();
  // Distinct piece sizes make stat's largest-piece result unambiguous.
  const text = [10, 15, 100].map((n, i) => `{"id":"REC000${i}","value":${n}} ${'pad '.repeat(65 + i * 10)}`).join('\n');
  await environment.put('corpus', text, { kind: 'text' });
  await environment.put('data', JSON.stringify({ n: 2 }), { kind: 'json' });
  return createProgramRunner({ environment, client: extractingClient(), compileQuery: compileJsonQuery });
}
function completeAround(op) {
  if (op === 'chunk') return { steps: [hands.chunk, { op: 'stat', from: 'pieces', as: 'stats' }, { op: 'answer', from: 'stats' }] };
  if (op === 'map' || op === 'reduce') return { steps: [hands.chunk, hands.map, hands.reduce, { op: 'answer', from: 'total' }] };
  if (op === 'answer') return { steps: [hands.answer] };
  return { steps: [hands[op], { op: 'answer', from: hands[op].as }] };
}
const withoutTiming = ({ ms: _ms, ...result }) => result;

describe('AI program pen', () => {
  it('covers every schema operation and every member of each step', () => {
    assert.equal(Object.keys(hands).length, 8);
    assert.deepEqual(Object.keys(hands), PROGRAM_OPS);
    const branches = PROGRAM_SCHEMA.properties.steps.items.anyOf;
    assert.equal(branches.length, Object.keys(hands).length);
    for (const schema of branches) assert.deepEqual(Object.keys(hands[schema.properties.op.const]), Object.keys(schema.properties));
    assert.deepEqual(Object.keys(PROGRAM_SCHEMA.properties), ['steps']);
  });
  for (const [op, handStep] of Object.entries(hands)) {
    it(`${op}: exact factory/fluent output, grammar, compile, gate and scripted runner`, async () => {
      assert.equal(JSON.stringify(factory(handStep)), JSON.stringify(handStep));
      const hand = completeAround(op);
      const pen = rebuild(hand);
      assert.equal(JSON.stringify(pen), JSON.stringify(hand));
      assert.equal(validate(pen.schema), true);
      assert.equal(gate(pen.schema), true);
      assert.equal(compileProgram(pen.schema, options).answer.from, hand.steps.at(-1).from);
      const run = await runner();
      const actual = await run.run(pen.schema);
      const expected = await run.run(hand);
      assert.equal(actual.ok, true, JSON.stringify(actual));
      assert.deepEqual(withoutTiming(actual), withoutTiming(expected));
    });
  }
  for (const [name, hand] of [['author example', PROGRAM_EXAMPLE], ['pairwise', pairwiseProgram()], ['needle', needleProgram({ ids: ['REC0000'] }, 0)]]) {
    it(`${name}: recorded program round-trips and runs identically`, async () => {
      const pen = rebuild(hand);
      assert.equal(JSON.stringify(pen), JSON.stringify(hand));
      assert.equal(validate(pen.schema), true);
      assert.equal(gate(pen.schema), true);
      const run = await runner();
      const actual = await run.run(pen.schema);
      const expected = await run.run(hand);
      assert.equal(actual.ok, true, JSON.stringify(actual));
      assert.deepEqual(withoutTiming(actual), withoutTiming(expected));
      if (name === 'needle') assert.deepEqual(JSON.parse(actual.answer.text), { value: 10 });
      if (name === 'pairwise') assert.deepEqual(JSON.parse(actual.answer.text), { gap: 5, a: 'REC0000', b: 'REC0001' });
    });
  }
  it('captures pure queries without binding an environment into the document', async () => {
    const start = p.program(['data']);
    const pen = start.select('data', 'n', (v) => v.get('n').add(1)).answer('n');
    assert.deepEqual(start.schema, { steps: [] });
    assert.deepEqual(pen.schema, { steps: [{ op: 'select', from: 'data', as: 'n', query: { $add: ["$['n']", 1] } }, { op: 'answer', from: 'n' }] });
    assert.equal((await (await runner()).run(pen.schema)).answer.text, '3');
    assert.throws(() => p.select('data', 'n', (_v, x) => x.unknown), { code: 'JL0104' });
    assert.deepEqual(p.reduce('found', 'n', (v) => v.count()).query, { $count: '$' });
  });
  it('preserves input and builder snapshots and refuses work after answer', () => {
    const options = { strategy: 'line', size: 200 };
    const a = p.program(['corpus']);
    const b = a.step(p.chunk('corpus', 'pieces', options));
    options.size = 500;
    assert.equal(b.schema.steps[0].size, 200);
    assert.deepEqual(a.schema, { steps: [] });
    assert.ok(Object.isFrozen(b.schema.steps[0]));
    assert.equal(Object.isFrozen(options), false);
    const done = b.stat('pieces', 'stats').answer('stats');
    assert.throws(() => done.peek('corpus', 'x'), { code: 'JL0102' });
    assert.deepEqual(p.from(done.schema).schema, done.schema);
    for (const make of [() => p.program([1]), () => p.stat('', 'x'), () => p.chunk('corpus', ''),
      () => p.chunk('corpus', 'x', { content: 'payload' }), () => a.step(null), () => a.step({ op: 'unknown' }),
      () => a.step({ op: 'answer', from: 'corpus', as: 'x' }), () => p.select('data', 'x', undefined)])
      assert.throws(make, { code: 'JL0101' });
  });
  const invalid = {
    chunk: { size: 199 }, grep: { flags: 'g' }, select: { query: { $nope: '$' } }, stat: { from: 'missing' },
    peek: { as: 'UPPER' }, map: { prompt: '' }, reduce: { from: 'pieces' }, answer: { chars: 0 },
  };
  for (const [op, patch] of Object.entries(invalid)) {
    it(`${op}: the target schema/compiler refuses invalid raw emission before any execution`, async () => {
      const hand = structuredClone(completeAround(op));
      const target = hand.steps.find((step) => step.op === op);
      Object.assign(target, patch);
      const emitted = p.from(hand).schema;
      assert.equal(validate(emitted) && gate(emitted) === true, false);
      const result = await (await runner()).run(emitted);
      assert.equal(result.ok, false);
      assert.equal(result.ran, 0);
    });
  }
  it('leaves duplicate names, missing answer and size limits to the real compile/shape boundaries', () => {
    const duplicate = p.program(['data']).stat('data', 'x').peek('data', 'x').answer('x');
    assert.equal(gate(duplicate.schema).errors[0].code, 'AI0202');
    assert.equal(gate(p.program(['data']).stat('data', 'x').schema).errors[0].code, 'AI0203');
    const fat = p.program(['data']).select('data', 'x', { $const: 'x'.repeat(4001) }).answer('x');
    assert.equal(gate(fat.schema).errors[0].code, 'AI0205');
  });
});
