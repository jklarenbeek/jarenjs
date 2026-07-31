//@ts-check
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { readFileSync } from 'node:fs';

import { JarenValidator } from '@jarenjs/validate';
import { compileFsm, compileDag } from '@jarenjs/flow';
import {
  downlevelDraft07,
  draftNeutralSubsetViolations,
} from '../json/schema-artifact-helpers.js';

const load = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));

const querySchema = load('../../packages/json/schemas/jaren-query.schema.json');
const querySchema07 = load('../../packages/json/schemas/jaren-query.draft-07.schema.json');
const jsltSchema = load('../../packages/json/schemas/jaren-jslt.schema.json');
const jsltSchema07 = load('../../packages/json/schemas/jaren-jslt.draft-07.schema.json');
const fsmSchema = load('../../packages/flow/schemas/jaren-fsm.schema.json');
const fsmSchema07 = load('../../packages/flow/schemas/jaren-fsm.draft-07.schema.json');
const dagSchema = load('../../packages/flow/schemas/jaren-dag.schema.json');
const dagSchema07 = load('../../packages/flow/schemas/jaren-dag.draft-07.schema.json');

function compileFsmSchema() {
  return new JarenValidator()
    .addSchema(querySchema)
    .compile(fsmSchema);
}

function compileDagSchema() {
  return new JarenValidator()
    .addSchema(querySchema)
    .addSchema(jsltSchema)
    .compile(dagSchema);
}

/** A stub registry satisfying every task node a document declares. */
function stubTasks(doc) {
  /** @type {Record<string, any>} */
  const tasks = {};
  for (const decl of Object.values(doc.nodes ?? {})) {
    if (decl?.kind === 'task') tasks[decl.run] = async () => null;
  }
  return tasks;
}

/**
 * Every ```json block in FLOW-FORMAT.md is a COMPLETE flow document by
 * convention (fragments use other fences): a jaren-dag document when it
 * carries `$dag` (the key is required there), a jaren-fsm document
 * otherwise. The doc's examples are fixtures: each must validate AND
 * compile.
 */
function formatDocExamples() {
  const md = readFileSync(
    new URL('../../packages/flow/docs/FLOW-FORMAT.md', import.meta.url), 'utf8');
  return [...md.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => JSON.parse(m[1]));
}

describe('the FLOW-FORMAT examples are fixtures', function () {
  it('every example validates against its schema and compiles', function () {
    const validateFsm = compileFsmSchema();
    const validateDag = compileDagSchema();
    const examples = formatDocExamples();
    assert.ok(examples.filter((d) => d.$dag === undefined).length >= 2,
      'the format doc carries its fsm worked examples');
    assert.ok(examples.filter((d) => d.$dag !== undefined).length >= 1,
      'the format doc carries its dag worked example');
    for (const doc of examples) {
      if (doc.$dag !== undefined) {
        assert.strictEqual(validateDag(doc), true, 'a FLOW-FORMAT dag example must validate');
        assert.doesNotThrow(() => compileDag(doc, { tasks: stubTasks(doc) }),
          'a FLOW-FORMAT dag example must compile');
      }
      else {
        assert.strictEqual(validateFsm(doc), true, 'a FLOW-FORMAT fsm example must validate');
        assert.doesNotThrow(() => compileFsm(doc), 'a FLOW-FORMAT fsm example must compile');
      }
    }
  });
});

describe('the jaren-fsm schema artifact', function () {
  it('accepts the projection shape: no $fsm, null events and guards', function () {
    const validate = compileFsmSchema();
    assert.strictEqual(validate({
      initial: null,
      states: ['a', 'b'],
      transitions: [{ from: 'a', event: null, guard: null, to: 'b' }],
    }), true);
    assert.strictEqual(validate({
      initial: 'a',
      states: ['a'],
      transitions: [{ from: 'a', event: 'go', guard: 'count > 3', to: 'a' }],
    }), true, 'an opaque display guard is a literal string, structurally valid');
  });

  it('rejects structural mistakes with the composed query grammar', function () {
    const validate = compileFsmSchema();
    assert.strictEqual(validate({}), false, 'the member triple is required');
    assert.strictEqual(validate({ $fsm: '0.2', initial: null, states: [], transitions: [] }),
      false, 'unknown version');
    assert.strictEqual(validate({ initial: null, states: [42], transitions: [] }),
      false, 'a state is a string or an id-carrying object');
    assert.strictEqual(validate({ initial: null, states: ['a'], transitions: [{ from: 'a' }] }),
      false, 'a transition needs its to-state');
    assert.strictEqual(
      validate({ initial: null, states: ['a'], transitions: [{ from: 'a', to: 'a', guard: { $bogus: [1] } }] }),
      false, 'an unknown operator is rejected by the query grammar');
    assert.strictEqual(
      validate({ initial: null, states: [{ id: 'a', entry: [{ with: {} }] }], transitions: [] }),
      false, 'an effect needs its run name');
  });

  it('stays in the draft-neutral subset and its draft-07 twin is in sync', function () {
    assert.deepStrictEqual(draftNeutralSubsetViolations(fsmSchema), []);
    assert.deepStrictEqual(fsmSchema07, mapRefs(downlevelDraft07(fsmSchema)),
      'regenerate the committed twin from the canonical artifact');
  });

  it('the draft-07 twin validates through the draft-07 query twin', function () {
    const validate = new JarenValidator()
      .addSchema(querySchema07)
      .compile(fsmSchema07);
    for (const doc of formatDocExamples().filter((d) => d.$dag === undefined)) {
      assert.strictEqual(validate(doc), true);
    }
    assert.strictEqual(
      validate({ initial: null, states: ['a'], transitions: [{ from: 'a', to: 'a', guard: { $bogus: [1] } }] }),
      false);
  });
});

describe('the jaren-dag schema artifact', function () {
  it('accepts a task-and-select document', function () {
    const validate = compileDagSchema();
    assert.strictEqual(validate({
      $dag: '0.1',
      nodes: {
        rows: { kind: 'input' },
        enrich: { kind: 'task', run: 'lookup', with: { region: 'eu' } },
        out: { kind: 'output' },
      },
      edges: [
        { from: 'rows', to: 'enrich' },
        { from: 'enrich', to: 'out', select: '$.records' },
      ],
    }), true);
  });

  it('rejects structural mistakes with the composed grammars', function () {
    const validate = compileDagSchema();
    assert.strictEqual(validate({ nodes: {}, edges: [] }), false, '$dag is required');
    assert.strictEqual(validate({ $dag: '0.1', nodes: { x: { kind: 'mystery' } }, edges: [] }),
      false, 'unknown node kind');
    assert.strictEqual(validate({ $dag: '0.1', nodes: { x: { kind: 'const' } }, edges: [] }),
      false, 'const needs its value');
    assert.strictEqual(
      validate({ $dag: '0.1', nodes: { x: { kind: 'query', query: { $bogus: [1] } }, o: { kind: 'output' } }, edges: [] }),
      false, 'an unknown operator is rejected by the query grammar');
    assert.strictEqual(
      validate({ $dag: '0.1', nodes: { o: { kind: 'output' } }, edges: [{ from: 'a' }] }),
      false, 'an edge needs its to-node');
    assert.strictEqual(
      validate({ $dag: '0.1', nodes: { o: { kind: 'output' } }, edges: [{ from: 'a', to: 'o', port: '' }] }),
      false, 'a port is non-empty');
  });

  it('stays in the draft-neutral subset and its draft-07 twin is in sync', function () {
    assert.deepStrictEqual(draftNeutralSubsetViolations(dagSchema), []);
    assert.deepStrictEqual(dagSchema07, mapRefs(downlevelDraft07(dagSchema)),
      'regenerate the committed twin from the canonical artifact');
  });

  it('the draft-07 twin validates through the draft-07 grammar twins', function () {
    const validate = new JarenValidator()
      .addSchema(querySchema07)
      .addSchema(jsltSchema07)
      .compile(dagSchema07);
    for (const doc of formatDocExamples().filter((d) => d.$dag !== undefined)) {
      assert.strictEqual(validate(doc), true);
    }
    assert.strictEqual(
      validate({ $dag: '0.1', nodes: { x: { kind: 'mystery' } }, edges: [] }), false);
  });
});

/**
 * Twin refs point at the draft-07 grammar twins. The same transform as
 * the app meta-schema test — a third copy would justify moving it into
 * the shared helpers.
 * @param {any} node
 * @returns {any}
 */
function mapRefs(node) {
  if (Array.isArray(node)) return node.map(mapRefs);
  if (node === null || typeof node !== 'object') return node;
  return Object.fromEntries(Object.entries(node).map(([k, v]) => [
    k,
    k === '$ref' && typeof v === 'string'
      && v.startsWith('https://jarenjs.dev/schemas/jaren-') && !v.endsWith('/draft-07')
      ? `${v}/draft-07`
      : mapRefs(v),
  ]));
}
