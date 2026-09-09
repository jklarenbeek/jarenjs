//@ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createProgramSession, createLedger, createEnvironment, createHashEmbedder,
  createProgramRunner, compileProgram } from '@jarenjs/ai';
import { compileJsonQuery, analyzeQuery, annotateTypes } from '@jarenjs/json/query';
import { questionStreamScorecard, simulateQuestionStream } from '../../benchmark/lib/question-stream.js';

const PROGRAM = { steps: [{ op: 'select', from: 'data', as: 'result', query: { $sum: '$[*]' } }, { op: 'answer', from: 'result' }] };
async function setup(extra = {}) {
  const embedder = createHashEmbedder({ dims: 32 });
  const ledger = createLedger({ embedder });
  const environment = createEnvironment({ ledger });
  await environment.put('data', '[2,3]', { kind: 'json' });
  let authors = 0;
  const options = { environment, compileQuery: compileJsonQuery,
    author: { author: async () => { authors++; return { value: PROGRAM, attempts: 1 }; } },
    reuse: { environmentId: 'data-v1', schemaVersion: 'program-v1', embedder,
      check: ({ result }) => result.answer.text === '5', ...extra } };
  return { ledger, environment, options, authors: () => authors };
}
describe('verified program reuse', () => {
  it('authors by default and saves calls only with explicit checked reuse', async () => {
    const state = await setup();
    const fresh = createProgramSession({ ...state.options, reuse: undefined });
    await fresh.run('sum'); await fresh.run('sum');
    assert.equal(state.authors(), 2);
    const session = createProgramSession(state.options);
    await session.run('sum');
    const second = await session.run('sum');
    assert.equal(second.reuse.reused, true);
    assert.equal(second.reuse.authorCalls, 0);
    assert.equal(state.authors(), 3);
    assert.equal((await state.ledger.listSkills()).length, 1);
  });
  it('refuses stale schema, environment and tools before execution, with one fallback', async () => {
    for (const drift of [{ schemaVersion: 'v2' }, { environmentId: 'other' }, { tools: ['new'] }]) {
      const state = await setup();
      await createProgramSession(state.options).run('sum');
      const session = createProgramSession({ ...state.options, reuse: { ...state.options.reuse, ...drift } });
      const result = await session.run('sum');
      assert.equal(result.reuse.reused, false);
      assert.equal(result.reuse.fallback, true);
      assert.equal(state.authors(), 2);
      assert.equal((await state.ledger.listMemories()).length, 1);
      assert.equal((await state.ledger.listSkills()).length, 2);
    }
  });
  it('checks suitability before a trap and stores wrong-outcome evidence without editing a success', async () => {
    const state = await setup({ threshold: 0, accept: () => true });
    await createProgramSession(state.options).run('sum');
    const original = structuredClone(await state.ledger.listSkills());
    let executions = 0;
    const actual = createProgramRunner(state.options);
    const result = await createProgramSession({ ...state.options,
      runner: { run: async (...args) => { executions++; return actual.run(...args); } },
      reuse: { ...state.options.reuse, check: ({ reused }) => !reused } }).run('maximum');
    assert.equal(result.reuse.fallback, true);
    assert.equal(executions, 2);
    assert.deepEqual(await state.ledger.getSkill(original[0].id), original[0]);
    assert.equal((await state.ledger.listMemories()).length, 1);
  });
  it('does not execute a similar question without host suitability proof', async () => {
    const state = await setup({ threshold: 0 });
    const session = createProgramSession(state.options);
    await session.run('sum');
    const result = await session.run('sum active');
    assert.equal(result.reuse.reused, false);
    assert.ok(result.reuse.events.some((event) => event.reason === 'unsuitable'));
  });
  it('rejects invalid stored program metadata at the ledger boundary', async () => {
    const { ledger } = await setup();
    const result = await ledger.addSkill({ name: 'bad', when: 'bad', instructions: 'bad', tools: [], program: { version: 2 } });
    assert.ok(result.error);
    assert.equal((await ledger.listSkills()).length, 0);
  });
  it('does not consume stale chunk or map members after a corpus shrinks', async () => {
    const { environment } = await setup();
    const runner = createProgramRunner({ environment, compileQuery: compileJsonQuery,
      client: { complete: async () => ({ message: { content: '1' } }) } });
    const doc = { steps: [
      { op: 'chunk', from: 'data', as: 'pieces', strategy: 'line', size: 200 },
      { op: 'map', from: 'pieces', as: 'found', prompt: 'return one' },
      { op: 'reduce', from: 'found', as: 'sum', query: { $sum: '$[*].value' } },
      { op: 'answer', from: 'sum' },
    ] };
    await environment.put('data', Array(3).fill('x'.repeat(210)).join('\n'), { kind: 'text' });
    assert.equal((await runner.run(doc)).answer.text, '3');
    await environment.put('data', 'x'.repeat(210), { kind: 'text' });
    assert.equal((await runner.run(doc)).answer.text, '1');
    assert.equal((await environment.grep('x', { in: 'data#line:200/' })).matches.length, 1);
  });
});

describe('question-stream economics', () => {
  it('is deterministic and charges wrong and rejected reuse through fallback', async () => {
    const a = await questionStreamScorecard();
    const b = await questionStreamScorecard();
    assert.deepEqual(a, b);
    assert.equal(a.baseline.questions, 25);
    assert.equal(a.selected.threshold, 0.9);
    assert.ok(a.frontier.every((row) => row.accuracy === 1));
    assert.ok(a.frontier.some((row) => row.falseReuse > 0));
    for (const card of a.frontier) {
      for (const row of card.rows.filter((item) => item.falseReuse)) {
        assert.equal(row.fallbackCalls, 1);
        assert.equal(row.executions, 2);
        assert.equal(row.tokens, 205);
      }
    }
    const stale = await simulateQuestionStream({ threshold: 0, stale: true });
    assert.equal(stale.rejectedReuse, 1);
    assert.equal(stale.accuracy, 1);
  });
});

describe('recursive result contracts', () => {
  const plan = (query, outputSchema) => ({ steps: [
    { op: 'map', from: 'data', as: 'pieces', prompt: 'return a number' },
    { op: 'reduce', from: 'pieces', as: 'result', query, ...(outputSchema ? { outputSchema } : {}) },
    { op: 'answer', from: 'result' },
  ] });
  const schema = { type: 'object', required: ['slot', 'value'], properties: { slot: { type: 'string' }, value: {} } };
  const options = { compileQuery: compileJsonQuery, analyzeQuery, annotateTypes, recursive: true };
  it('proves objects and sequences, rejects scalars, and requires a declaration for unknown inference', () => {
    compileProgram(plan({ slot: 'data', value: 2 }), options);
    compileProgram(plan([{ slot: 'data', value: 2 }]), options);
    assert.throws(() => compileProgram(plan(2, schema), options), { code: 'AI0208' });
    assert.throws(() => compileProgram(plan('$[0].value'), options), { code: 'AI0208' });
    compileProgram(plan('$[0].value', schema), options);
  });
  it('refuses a lying declaration before storing or consuming the output', async () => {
    const environment = createEnvironment();
    await environment.put('data', '2', { kind: 'json' });
    const runner = createProgramRunner({ environment, ...options, client: { complete: async () => ({ message: { content: '2' } }) } });
    const result = await runner.run(plan('$[0].value', schema));
    assert.equal(result.ok, false);
    assert.equal(result.errors[0].code, 'AI0209');
    assert.equal(await environment.ledger.getSlot('program/result'), null);
  });
});
