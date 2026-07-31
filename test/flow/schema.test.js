//@ts-check
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { readFileSync } from 'node:fs';

import { JarenValidator } from '@jarenjs/validate';
import { compileFsm } from '@jarenjs/flow';
import {
  downlevelDraft07,
  draftNeutralSubsetViolations,
} from '../json/schema-artifact-helpers.js';

const load = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));

const querySchema = load('../../packages/json/schemas/jaren-query.schema.json');
const querySchema07 = load('../../packages/json/schemas/jaren-query.draft-07.schema.json');
const fsmSchema = load('../../packages/flow/schemas/jaren-fsm.schema.json');
const fsmSchema07 = load('../../packages/flow/schemas/jaren-fsm.draft-07.schema.json');

function compileFsmSchema() {
  return new JarenValidator()
    .addSchema(querySchema)
    .compile(fsmSchema);
}

/**
 * Every ```json block in FLOW-FORMAT.md is a COMPLETE jaren-fsm
 * document by convention (fragments use other fences), so the doc's
 * examples are fixtures: each must validate AND compile.
 */
function formatDocExamples() {
  const md = readFileSync(
    new URL('../../packages/flow/docs/FLOW-FORMAT.md', import.meta.url), 'utf8');
  return [...md.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => JSON.parse(m[1]));
}

describe('the jaren-fsm schema artifact', function () {
  it('accepts every FLOW-FORMAT example, and every example compiles', function () {
    const validate = compileFsmSchema();
    const examples = formatDocExamples();
    assert.ok(examples.length >= 2, 'the format doc carries its worked examples');
    for (const doc of examples) {
      assert.strictEqual(validate(doc), true, 'a FLOW-FORMAT example must validate');
      assert.doesNotThrow(() => compileFsm(doc), 'a FLOW-FORMAT example must compile');
    }
  });

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
    const twin = downlevelDraft07(fsmSchema);
    const mapRefs = (node) => {
      if (Array.isArray(node)) return node.map(mapRefs);
      if (node === null || typeof node !== 'object') return node;
      return Object.fromEntries(Object.entries(node).map(([k, v]) => [
        k,
        k === '$ref' && typeof v === 'string'
          && v.startsWith('https://jarenjs.dev/schemas/jaren-') && !v.endsWith('/draft-07')
          ? `${v}/draft-07`
          : mapRefs(v),
      ]));
    };
    assert.deepStrictEqual(fsmSchema07, mapRefs(twin),
      'regenerate the committed twin from the canonical artifact');
  });

  it('the draft-07 twin validates through the draft-07 query twin', function () {
    const validate = new JarenValidator()
      .addSchema(querySchema07)
      .compile(fsmSchema07);
    for (const doc of formatDocExamples()) {
      assert.strictEqual(validate(doc), true);
    }
    assert.strictEqual(
      validate({ initial: null, states: ['a'], transitions: [{ from: 'a', to: 'a', guard: { $bogus: [1] } }] }),
      false);
  });
});
