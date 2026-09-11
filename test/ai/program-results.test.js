//@ts-check
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  createEnvironment, createProgramAuthor, createProgramRunner, createLongHorizonAgent,
  createStructuredOutput, readProgramAnswer,
} from '@jarenjs/ai';
import { compileJsonQuery, analyzeQuery, annotateTypes } from '@jarenjs/json/query';

const queryOptions = { compileQuery: compileJsonQuery, analyzeQuery, annotateTypes };

describe('program result contracts', () => {
  it('returns typed zero accounting and a null answer when compilation fails', async () => {
    const environment = createEnvironment();
    const result = await createProgramRunner({ environment }).run({ steps: [] });
    assert.equal(result.ok, false);
    assert.equal(result.answer, null);
    assert.deepEqual(result.steps, []);
    assert.equal(result.subcalls, 0);
    assert.equal(result.failed, 0);
    assert.equal(result.ran, 0);
  });

  it('reads the full scoped slot while leaving the returned preview bounded', async () => {
    const parent = createEnvironment();
    const environment = createEnvironment({ ledger: parent.ledger, scope: 'child/1/0/' });
    const text = JSON.stringify({ value: 'x'.repeat(3000) });
    await parent.put('data', 'a parent slot with the same name');
    await environment.put('data', text);
    const result = await createProgramRunner({ environment }).run({ steps: [{ op: 'answer', from: 'data' }] });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.answer.truncated, true);
    assert.equal(result.answer.text.length, 2000);
    const full = await readProgramAnswer(environment, result.answer, { maxChars: text.length });
    assert.equal(full.ok, true);
    if (full.ok) {
      assert.equal(full.answer.text, text);
      assert.equal(full.answer.truncated, false);
    }
  });

  it('refuses oversized, missing and changed slots before loading their content', async () => {
    let reads = 0;
    const environment = { ledger: {
      getSlot: async () => ({ size: 4000 }),
      readSlot: async () => { reads++; return 'x'.repeat(4000); },
    } };
    const answer = { slot: 'answer', size: 4000, text: 'preview', truncated: true };
    assert.equal((await readProgramAnswer(environment, answer, { maxChars: 3999 })).ok, false);
    assert.equal((await readProgramAnswer(environment, { ...answer, size: 3000 }, { maxChars: 3000 })).ok, false);
    assert.equal((await readProgramAnswer({ ledger: { ...environment.ledger, getSlot: async () => null } }, answer,
      { maxChars: 4000 })).ok, false);
    assert.equal(reads, 0);
    const changed = { ledger: { ...environment.ledger, readSlot: async () => 'x'.repeat(4001) } };
    assert.equal((await readProgramAnswer(changed, answer, { maxChars: 4000 })).ok, false);
    await assert.rejects(readProgramAnswer(environment, answer, { maxChars: Infinity }), RangeError);
  });
});

describe('the worked recursive program at actual depth', () => {
  for (const depth of [0, 1, 2]) {
    it(`preserves failures, nulls and complete large values at depth ${depth}`, async () => {
      const environment = createEnvironment();
      await environment.put('corpus', ['broken', 'empty', 'record'].map(s => s.padEnd(1800, '.')).join('\n'));
      const value = { id: 'a', value: 1, details: 'x'.repeat(2100) };
      const client = { endpoint: { provider: 'openrouter' }, complete: async ({ messages }) => {
        const example = /right shape:\n([^\n]+)/.exec(messages[0].content);
        if (example) return { message: { content: example[1] } };
        if (messages[1].content.includes('broken')) throw new Error('simulated timeout');
        return { message: { content: JSON.stringify(messages[1].content.includes('empty') ? null : value) } };
      } };
      const agent = createLongHorizonAgent({ environment, client, ...queryOptions, depth,
        createProgramAuthor, createProgramRunner, createStructuredOutput, createEnvironment });
      const result = await agent.run('Collect every record.');
      assert.equal(result.ok, true, JSON.stringify(result.errors));
      assert.equal(result.answer.truncated, true);
      const complete = await readProgramAnswer(environment, result.answer, { maxChars: 10000 });
      assert.equal(complete.ok, true);
      if (!complete.ok) return;
      const items = JSON.parse(complete.answer.text);
      assert.equal(items.length, 3);
      assert.equal(items[0].value, null);
      assert.match(items[0].error, /simulated timeout/);
      assert.equal(items[1].value, null);
      assert.equal(items[1].error, undefined);
      assert.deepEqual(items[2].value, value);
      const leaf = result.trajectory.filter(event => event.kind === 'program' && event.depth === depth);
      assert.equal(leaf.reduce((sum, event) => sum + event.failed, 0), 1);
    });
  }

  it('keeps an oversized child as a diagnostic under an explicit answer limit', async () => {
    const environment = createEnvironment();
    await environment.put('corpus', 'record');
    const client = { endpoint: { provider: 'openrouter' }, complete: async ({ messages }) => ({ message: {
      content: /right shape:\n([^\n]+)/.exec(messages[0].content)?.[1] ?? JSON.stringify('x'.repeat(2100)),
    } }) };
    const result = await createLongHorizonAgent({ environment, client, ...queryOptions, depth: 1,
      maxAnswerChars: 1000, createProgramAuthor, createProgramRunner, createStructuredOutput, createEnvironment,
    }).run('Collect records.');
    assert.equal(result.ok, true);
    const [item] = JSON.parse(result.answer.text);
    assert.equal(item.value, null);
    assert.match(item.error, /1000 character limit/);
    assert.equal(result.trajectory.find(event => event.kind === 'program' && event.depth === 0).failed, 1);
  });
});
