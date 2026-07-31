//@ts-check
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { transformJson } from '@jarenjs/json/jslt';
import { JarenValidator } from '@jarenjs/validate';
import { parseMermaid, toMermaid, diagramDocument, compileMermaid } from '@jarenjs/mermaid';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.join(__dirname, '..', '..', 'components', 'mermaid');
const read = (p) => JSON.parse(fs.readFileSync(path.join(pkg, p), 'utf8'));

const toWorkflow = read('stylesheets/state-to-workflow.jslt.json');
const toState = read('stylesheets/workflow-to-state.jslt.json');
const workflowSchema = read('schemas/jaren-workflow.schema.json');

const STATE_SRC = `stateDiagram-v2
  [*] --> Idle
  Idle --> Running : start
  Running --> Idle : stop
  Running --> [*]`;

describe('the state ⇄ workflow semantic projection', function () {
  const validateWorkflow = new JarenValidator().compile(workflowSchema);

  it('projects a state DiagramDocument to a schema-valid workflow', function () {
    const doc = parseMermaid(STATE_SRC);
    const workflow = transformJson(toWorkflow, doc);
    assert.equal(validateWorkflow(workflow), true);
    assert.equal(workflow.initial, 'Idle');
    assert.deepEqual(workflow.states, ['Idle', 'Running']);
    assert.deepEqual(workflow.transitions, [
      { from: 'Idle', event: 'start', to: 'Running' },
      { from: 'Running', event: 'stop', to: 'Idle' },
    ]);
  });

  it('reverses a workflow back to editable Mermaid via toMermaid', function () {
    const workflow = {
      initial: 'Idle',
      states: ['Idle', 'Running'],
      transitions: [
        { from: 'Idle', event: 'start', to: 'Running' },
        { from: 'Running', event: 'stop', to: 'Idle' },
      ],
    };
    const ast = transformJson(toState, workflow);
    const doc = diagramDocument('state', {}, ast, { hash: '0', direction: null, title: null });
    const text = toMermaid(doc);
    assert.match(text, /stateDiagram-v2/);
    assert.match(text, /Idle --> Running : start/);
    // The regenerated text re-parses to a state diagram.
    assert.equal(parseMermaid(text).diagram, 'state');
  });

  it('round-trips text → AST → workflow → AST → toMermaid', function () {
    const doc = parseMermaid(STATE_SRC);
    const workflow = transformJson(toWorkflow, doc);
    const backAst = transformJson(toState, workflow);
    const backDoc = diagramDocument('state', {}, backAst, { hash: '0', direction: null, title: null });
    const text = toMermaid(backDoc);
    const reparsed = parseMermaid(text);
    // The transitions survive the full loop (modulo the [*] pseudo-edges).
    const events = reparsed.ast.transitions.filter((t) => t.event).map((t) => t.event);
    assert.deepEqual(events, ['start', 'stop']);
  });
});

describe('the UML label parts flow into the machine (state → workflow)', function () {
  const src = `stateDiagram-v2
  [*] --> idle
  idle --> busy : start [ready] / fetch
  busy --> idle : stop
  busy --> busy : tick`;

  it('maps guard and effect when present, omits them when not', function () {
    const workflow = transformJson(toWorkflow, parseMermaid(src));
    assert.deepEqual(workflow.transitions, [
      { from: 'idle', event: 'start', guard: 'ready', to: 'busy', effects: [{ run: 'fetch' }] },
      { from: 'busy', event: 'stop', to: 'idle' },
      { from: 'busy', event: 'tick', to: 'busy' },
    ]);
  });

  it('the panel renderer draws the verbatim label, parts and all', function () {
    const svg = compileMermaid(src).toSvgString();
    assert.match(svg, /start \[ready\] \/ fetch/);
  });
});

describe('the machine round-trips through diagram text (workflow → state → workflow)', function () {
  it('string guards and bare run names survive exactly', function () {
    const machine = {
      initial: 'idle',
      states: ['idle', 'busy'],
      transitions: [
        { from: 'idle', event: 'start', guard: '$.context.ready', to: 'busy', effects: [{ run: 'fetch' }] },
        { from: 'busy', event: 'stop', to: 'idle' },
      ],
    };
    const ast = transformJson(toState, machine);
    const text = toMermaid(diagramDocument('state', {}, ast, { hash: '0', direction: null, title: null }));
    assert.match(text, /idle --> busy : start \[\$\.context\.ready\] \/ fetch/);
    const back = transformJson(toWorkflow, parseMermaid(text));
    assert.deepEqual(back, machine, 'text → machine reproduces the document');
  });

  it('structured members print as documented placeholders (lossy on purpose)', function () {
    const machine = {
      initial: 'a',
      states: ['a', 'b'],
      transitions: [{
        from: 'a', event: 'go',
        guard: { $gt: ['$.context.count', 3] },
        to: 'b',
        effects: [{ run: 'notify', with: { to: '$.context.user' } }, { run: 'log' }],
      }],
    };
    const ast = transformJson(toState, machine);
    assert.equal(ast.transitions[1].label, 'go […] / notify, log');
    assert.equal(ast.transitions[1].guard, '…', 'the parts stay consistent with reparsing the label');
    const text = toMermaid(diagramDocument('state', {}, ast, { hash: '0', direction: null, title: null }));
    assert.deepEqual(parseMermaid(text).ast, ast, 'even the lossy print is a parse fixed point');
  });
});

describe('the flowchart ⇄ dag projection pair', function () {
  const toDag = read('stylesheets/flowchart-to-dag.jslt.json');
  const toFlowchart = read('stylesheets/dag-to-flowchart.jslt.json');
  const dagSchema = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', '..', 'packages', 'flow', 'schemas', 'jaren-dag.schema.json'), 'utf8'));
  const querySchema = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', '..', 'packages', 'json', 'schemas', 'jaren-query.schema.json'), 'utf8'));
  const jsltSchema = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', '..', 'packages', 'json', 'schemas', 'jaren-jslt.schema.json'), 'utf8'));

  const DAG = {
    $dag: '0.1',
    nodes: {
      rows: { kind: 'input' },
      adults: { kind: 'query', query: '$' },
      stamp: { kind: 'task', run: 'lookup' },
      view: { kind: 'jslt', stylesheet: [] },
      out: { kind: 'output' },
    },
    edges: [
      { from: 'rows', to: 'adults' },
      { from: 'adults', to: 'view', port: 'people' },
      { from: 'stamp', to: 'view', port: 'extra', select: '$.records' },
      { from: 'view', to: 'out' },
    ],
  };

  it('draws a dag as a flowchart: one shape per kind, ports and selects on the labels', function () {
    const ast = transformJson(toFlowchart, DAG);
    assert.deepEqual(ast.nodes.map((n) => [n.id, n.shape]), [
      ['rows', 'stadium'], ['adults', 'rect'], ['stamp', 'subroutine'],
      ['view', 'round'], ['out', 'doublecircle'],
    ]);
    assert.deepEqual(ast.edges.map((e) => e.label),
      [null, 'people', 'extra · $.records', null]);
    const text = toMermaid(diagramDocument('flowchart', {}, ast, { hash: '0', direction: 'TD', title: null }));
    const reparsed = parseMermaid(text);
    assert.equal(reparsed.diagram, 'flowchart');
    assert.deepEqual(reparsed.ast.nodes.map((n) => n.id), ['rows', 'adults', 'stamp', 'view', 'out']);
  });

  it('projects a flowchart to a schema-valid dag skeleton (task stubs, labels become ports)', function () {
    const fc = parseMermaid('flowchart TD\n  fetch --> parse\n  parse -->|rows| merge\n  lookup -->|extra| merge');
    const dag = transformJson(toDag, fc);
    assert.deepEqual(dag.nodes.fetch, { kind: 'task', run: 'fetch' });
    assert.deepEqual(dag.edges[1], { from: 'parse', to: 'merge', port: 'rows' });
    const validate = new JarenValidator()
      .addSchema(querySchema).addSchema(jsltSchema).compile(dagSchema);
    assert.equal(validate(dag), true, 'the skeleton validates against the jaren-dag schema');
  });

  it('round-trips ids and wiring through the diagram text', function () {
    const ast = transformJson(toFlowchart, DAG);
    const text = toMermaid(diagramDocument('flowchart', {}, ast, { hash: '0', direction: 'TD', title: null }));
    const back = transformJson(toDag, parseMermaid(text));
    assert.deepEqual(Object.keys(back.nodes), Object.keys(DAG.nodes), 'node ids survive');
    assert.deepEqual(
      back.edges.map((e) => [e.from, e.to]),
      DAG.edges.map((e) => [e.from, e.to]),
      'the wiring survives');
  });

  it('a cyclic flowchart projects fine — acyclicity is compileDag\'s job (division of labor)', async function () {
    const { compileDag } = await import('@jarenjs/flow');
    const fc = parseMermaid('flowchart TD\n  a --> b\n  b --> a\n  a --> out');
    const dag = transformJson(toDag, fc);
    assert.equal(typeof dag.nodes.a, 'object', 'the projection does not police cycles');
    dag.nodes.out = { kind: 'output' };
    assert.throws(
      () => compileDag(dag, { tasks: { a: async () => null, b: async () => null } }),
      (err) => /** @type {any} */ (err).code === 'JF0016');
  });
});
