//@ts-check
/**
 * @file The error-shape golden: one instance of every coded error class
 * in the suite, constructed with a fixed (code, reason, docPath, cause)
 * tuple and snapshotted field by field. The golden file is the coded
 * error contract made reviewable — a change to any class's name, field
 * set, message composition or cause handling shows up here as a diff of
 * `fixtures/error-shapes.golden.json`, never as a silent drift.
 *
 * Regenerate after an intentional contract change with:
 *   JAREN_UPDATE_GOLDENS=1 node --test test/errors/shape.test.js
 * and review the golden diff line by line.
 *
 * Deliberately absent: `ValidationError` (keyword-keyed, locale-rendered,
 * own `toJSON`), the `LabeledSyntaxError` family (source/position) and
 * josl's line/column family — different shapes for different consumers;
 * they are outside the coded contract by design.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { JsonQueryCompileError, JsonQueryRuntimeError } from '@jarenjs/json/query';
import { JsltCompileError, JsltRuntimeError } from '@jarenjs/json/jslt';
import { JtltCompileError, JtltRuntimeError } from '@jarenjs/json/jtlt';
import { JsonPatchCompileError, JsonPatchRuntimeError } from '@jarenjs/json/patch';
import { JsonWriteError } from '@jarenjs/json/write';
import { AppCompileError, AppRuntimeError } from '@jarenjs/app';
import { FlowCompileError, FlowRuntimeError } from '@jarenjs/flow';
import { AiError } from '@jarenjs/ai';
import { LinqBuildError, LinqRuntimeError } from '@jarenjs/linq';
import { DbCompileError, DbRuntimeError } from '@jarenjs/db';
import { ContractCompileError, ContractRuntimeError, ContractHostError } from '@jarenjs/contract';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN_PATH = path.join(__dirname, 'fixtures', 'error-shapes.golden.json');

// The fixed tuple. Every class receives the same inputs through its own
// public constructor signature, so the golden records what each class
// DOES with them, not what a shared helper would.
const CODE = 'ZZ0042';
const REASON = 'golden reason';
const DOC_PATH = '/golden/doc';
const DATA_PATH = '/golden/data';
const CAUSE = new Error('golden cause');

/**
 * Construct one instance per coded class, each through its current
 * public signature.
 * @returns {[string, Error][]}
 */
function instances() {
  return [
    ['JsonQueryCompileError', new JsonQueryCompileError(CODE, REASON, DOC_PATH, { cause: CAUSE })],
    ['JsonQueryRuntimeError', new JsonQueryRuntimeError(CODE, REASON, DOC_PATH, { cause: CAUSE })],
    ['JsltCompileError', new JsltCompileError(CODE, REASON, DOC_PATH, CAUSE)],
    ['JsltRuntimeError', new JsltRuntimeError(CODE, REASON, DOC_PATH, CAUSE)],
    ['JtltCompileError', new JtltCompileError(CODE, REASON, DOC_PATH, CAUSE)],
    ['JtltRuntimeError', new JtltRuntimeError(CODE, REASON, DOC_PATH, CAUSE)],
    ['JsonPatchCompileError', new JsonPatchCompileError(CODE, REASON, DOC_PATH, CAUSE)],
    ['JsonPatchRuntimeError', new JsonPatchRuntimeError(CODE, REASON, DOC_PATH, DATA_PATH)],
    ['JsonWriteError', new JsonWriteError(CODE, REASON, DATA_PATH)],
    ['AppCompileError', new AppCompileError(CODE, REASON, DOC_PATH, CAUSE)],
    ['AppRuntimeError', new AppRuntimeError(CODE, REASON, { cause: CAUSE })],
    ['FlowCompileError', new FlowCompileError(CODE, REASON, DOC_PATH, CAUSE)],
    ['FlowRuntimeError', new FlowRuntimeError(CODE, REASON, DOC_PATH, CAUSE)],
    ['AiError', new AiError(CODE, REASON, { cause: CAUSE })],
    ['LinqBuildError', new LinqBuildError(CODE, REASON, DOC_PATH, CAUSE)],
    ['LinqRuntimeError', new LinqRuntimeError(CODE, REASON, DOC_PATH, CAUSE)],
    ['DbCompileError', new DbCompileError(CODE, REASON, DOC_PATH, CAUSE)],
    ['DbRuntimeError', new DbRuntimeError(CODE, REASON, { docPath: DOC_PATH, cause: CAUSE })],
    ['ContractCompileError', new ContractCompileError(CODE, REASON, DOC_PATH, CAUSE)],
    ['ContractRuntimeError', new ContractRuntimeError(CODE, REASON, { msgid: 'contract/golden', cause: CAUSE })],
    ['ContractHostError', new ContractHostError(CODE, REASON)],
  ];
}

/**
 * The reviewable projection of one error instance. `causeValue`
 * distinguishes the fixed cause, an unexpected value, and absence;
 * `hasOwnCause` is the presence test the cause contract is defined by.
 * @param {string} cls
 * @param {Error} err
 */
function shapeOf(cls, err) {
  const anyErr = /** @type {any} */ (err);
  return {
    class: cls,
    name: err.name,
    code: anyErr.code,
    docPath: Object.hasOwn(err, 'docPath') ? anyErr.docPath ?? '<undefined>' : '<absent>',
    dataPath: Object.hasOwn(err, 'dataPath') ? anyErr.dataPath ?? '<undefined>' : '<absent>',
    reason: Object.hasOwn(err, 'reason') ? anyErr.reason : '<absent>',
    message: err.message,
    hasOwnCause: Object.hasOwn(err, 'cause'),
    causeValue: Object.hasOwn(err, 'cause')
      ? (anyErr.cause === CAUSE ? '<the fixed cause>' : String(anyErr.cause))
      : '<absent>',
  };
}

describe('coded error shapes (T1 golden)', () => {
  const actual = instances().map(([cls, err]) => shapeOf(cls, err));

  if (process.env.JAREN_UPDATE_GOLDENS) {
    fs.mkdirSync(path.dirname(GOLDEN_PATH), { recursive: true });
    fs.writeFileSync(GOLDEN_PATH, JSON.stringify(actual, null, 2) + '\n');
  }

  const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8'));

  it('covers every coded class exactly once', () => {
    assert.strictEqual(actual.length, 21);
    assert.strictEqual(new Set(actual.map((s) => s.class)).size, 21);
  });

  for (const shape of actual) {
    it(`${shape.class} matches its golden shape`, () => {
      const expected = golden.find((/** @type {any} */ g) => g.class === shape.class);
      assert.ok(expected, `${shape.class} missing from the golden — regenerate deliberately`);
      assert.deepStrictEqual(shape, expected);
    });
  }
});
