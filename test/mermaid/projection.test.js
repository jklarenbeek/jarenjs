//@ts-check
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { transformJson } from '@jarenjs/json/jslt';
import { JarenValidator } from '@jarenjs/validate';
import { parseMermaid, toMermaid, diagramDocument } from '@jarenjs/mermaid';

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
