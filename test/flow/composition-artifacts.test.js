import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JarenValidator } from '@jarenjs/validate';
import { compileStatechart, compileWorkflow, lowerWorkflow } from '@jarenjs/flow';
import { transformJson } from '@jarenjs/json/jslt';
import { parseMermaid, toMermaid, diagramDocument } from '@jarenjs/mermaid';
import { downlevelDraft07, mapRefs, draftNeutralSubsetViolations } from '../json/schema-artifact-helpers.js';
import { flowBenchmarkDocument, createFlowBenchmarkTasks, createFlowBenchmarkStore } from '../../benchmark/flow-workflow.js';

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const schema = (name, draft = '') => read(`../../packages/flow/schemas/jaren-${name}${draft}.schema.json`);
const query = (draft = '') => read(`../../packages/json/schemas/jaren-query${draft}.schema.json`);
const jslt = (draft = '') => read(`../../packages/json/schemas/jaren-jslt${draft}.schema.json`);

describe('statechart/workflow grammar artifacts', () => {
  it('the normative documents contain schema-valid, compilable complete examples', () => {
    for (const [name, file, compile] of [['statechart', 'STATECHART', compileStatechart], ['workflow', 'WORKFLOW', compileWorkflow]]) {
      const text = readFileSync(new URL(`../../packages/flow/docs/${file}-FORMAT.md`, import.meta.url), 'utf8');
      const docs = [...text.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => JSON.parse(m[1]));
      assert.ok(docs.length);
      const validate = new JarenValidator().addSchema(query()).addSchema(jslt()).addSchema(schema('dag')).compile(schema(name));
      for (const doc of docs) {
        assert.equal(validate(doc), true);
        assert.doesNotThrow(() => compile(doc, { tasks: { prepare: { version: '1', run: () => ({ ready: true }) } } }));
      }
    }
  });
  for (const name of ['statechart', 'workflow', 'statechart-state']) {
    it(`${name} has a mechanical draft-07 twin in the neutral subset`, () => {
      assert.deepEqual(draftNeutralSubsetViolations(schema(name)), []);
      assert.deepEqual(schema(name, '.draft-07'), mapRefs(downlevelDraft07(schema(name))));
    });
  }
  for (const draft of ['', '.draft-07']) {
    it(`validates the real benchmark and lowered control under ${draft || '2020-12'}`, () => {
      const validator = new JarenValidator().addSchema(query(draft)).addSchema(jslt(draft)).addSchema(schema('dag', draft));
      const validate = validator.compile(schema('workflow', draft));
      assert.equal(validate(flowBenchmarkDocument), true);
      const lowered = lowerWorkflow(flowBenchmarkDocument);
      const chart = new JarenValidator().addSchema(query(draft)).compile(schema('statechart', draft));
      assert.equal(chart(lowered.fsm), true);
      const start = compileStatechart(lowered.fsm).start();
      assert.equal(new JarenValidator().compile(schema('statechart-state', draft))(start.state), true);
      const malformed = structuredClone(flowBenchmarkDocument);
      malformed.states.verify.work.dag.nodes.fsm.kind = 'invented';
      assert.equal(validate(malformed), false);
      malformed.states.verify = { work: { task: 'go' }, then: 'done' };
      assert.equal(validate(malformed), false);
      assert.equal(chart({ $fsm: '0.2', initial: 'a', states: ['a'], transitions: [{ from: 'a', to: 'a', event: 'go', after: 1 }] }), false);
    });
  }
});

describe('Mermaid compound-state projection', () => {
  const forward = read('../../components/mermaid/stylesheets/state-to-statechart.jslt.json');
  const reverse = read('../../components/mermaid/stylesheets/statechart-to-state.jslt.json');
  const text = `stateDiagram-v2
[*] --> Active
state Active {
  [*] --> Editing
  state Editing {
    [*] --> First
    First --> Last : next
    Last --> [*]
  }
  Editing --> Finished : finish
  Finished --> [*]
}
Active --> Outside : leave`;
  it('preserves parent, local initial and terminal states through JSON and Mermaid text', () => {
    const diagram = parseMermaid(text);
    assert.deepEqual(parseMermaid(toMermaid(diagram)).ast, diagram.ast);
    const doc = transformJson(forward, diagram);
    const chart = compileStatechart(doc);
    let state = chart.start().state;
    assert.deepEqual(state.active, ['First']);
    state = chart.step(state, 'next').state;
    assert.deepEqual(state.active, ['Last']);
    state = chart.step(state, 'finish').state;
    assert.deepEqual(state.active, ['Finished']);
    assert.deepEqual(chart.step(state, 'leave').state.active, ['Outside']);
    const printed = toMermaid(diagramDocument('state', {}, transformJson(reverse, doc), {}));
    assert.deepEqual(transformJson(forward, parseMermaid(printed)), doc);
  });
  it('requires a declared initial for each compound scope instead of choosing a child arbitrarily', () => {
    const doc = transformJson(forward, parseMermaid('stateDiagram-v2\n[*] --> A\nstate A {\nstate B\n}'));
    assert.throws(() => compileStatechart(doc), { code: 'JF0020' });
    const labelled = transformJson(forward, parseMermaid('stateDiagram-v2\n[*] --> A : conditional\nA --> [*]'));
    assert.throws(() => compileStatechart(labelled), { code: 'JF0020' });
  });
});

describe('the benchmark harness is a composed workflow consumer', () => {
  it('runs verification concurrently, measures in sequence, waits, retries boundedly, and resumes from a file', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'flow-harness-test-'));
    const calls = [];
    let verifying = 0; let peak = 0; let measuring = 0;
    const execute = async (args) => {
      if (args.includes('--test')) {
        verifying++; peak = Math.max(peak, verifying);
        await new Promise((resolve) => setImmediate(resolve));
        verifying--; return { ok: true };
      }
      assert.equal(verifying, 0, 'measurement waits for both correctness suites');
      assert.equal(measuring++, 0, 'timed children do not compete for the CPU');
      const kind = args.includes('benchmark/flow-fsm.js') ? 'fsm' : 'dag';
      calls.push(kind);
      await new Promise((resolve) => setImmediate(resolve));
      const report = kind === 'fsm' ? { wedge: { guardsSurviveJson: { jaren: true } } } : { sync: [], async: [] };
      writeFileSync(args[args.indexOf('--filepath') + 1], JSON.stringify(report));
      measuring--; return { ok: true };
    };
    try {
      const filename = join(directory, 'runs.json');
      const create = () => compileWorkflow(flowBenchmarkDocument, {
        tasks: createFlowBenchmarkTasks({ execute }), store: createFlowBenchmarkStore(filename),
      });
      const input = { quick: true, review: true };
      assert.deepEqual(lowerWorkflow(flowBenchmarkDocument), lowerWorkflow(structuredClone(flowBenchmarkDocument)));
      const first = await create().run(input, { runId: 'bench' });
      assert.equal(first.status, 'waiting'); assert.equal(peak, 2);
      assert.deepEqual(calls, ['fsm', 'dag']);
      const second = await create().run(input, { runId: 'bench', event: { type: 'retry' } });
      assert.equal(second.status, 'waiting');
      assert.deepEqual(calls, ['fsm', 'dag', 'fsm', 'dag']);
      const end = await create().run(input, { runId: 'bench', event: { type: 'accept' } });
      assert.equal(end.status, 'done'); assert.equal(calls.length, 4);
      assert.equal(end.result.fsm.wedge.guardsSurviveJson.jaren, true);
      assert.equal(createFlowBenchmarkStore(filename).save('bench', first.snapshot, first.snapshot.generation), false);
    }
    finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
