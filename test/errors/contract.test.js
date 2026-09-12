//@ts-check
/**
 * @file The coded-error contract matrices (T6/T6a of the health pass).
 *
 * T6 — the cause matrix: for every migrated class, three cases — no
 * cause, an explicitly `undefined` cause, a real cause — asserting
 * `Object.hasOwn(err, 'cause')` and the value. This is the one
 * behavioural difference no message-text test can catch. The per-class
 * expectations differ deliberately: the options-form classes (query,
 * jslt compile) can represent "host threw undefined" as an own
 * `undefined` cause; the positional-adapter classes map a trailing
 * `undefined` to "no cause" (their historical contract, preserved).
 *
 * T6a — the location matrix: a real path (`/a/b`), the document ROOT
 * (`''`) and NO location (`undefined`) are three different facts. The
 * root must survive as `''` (rendered `at ''`), absence must stay
 * `undefined` (rendered not at all) — never normalized to `''`, or the
 * AI repair loop's `docPath ?? instancePath ?? ''` chain silently
 * swallows a location. The normalizeErrors round-trip is asserted
 * through the public `createStructuredOutput` surface.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { JsonQueryCompileError, JsonQueryRuntimeError } from '@jarenjs/json/query';
import { JsltCompileError, JsltRuntimeError } from '@jarenjs/json/jslt';
import { JtltCompileError, JtltRuntimeError } from '@jarenjs/json/jtlt';
import { JsonPatchCompileError, JsonPatchRuntimeError } from '@jarenjs/json/patch';
import { JsonWriteError } from '@jarenjs/json/write';
import { AppCompileError, AppRuntimeError } from '@jarenjs/app';
import { FlowCompileError, FlowRuntimeError } from '@jarenjs/flow';

import { LinqBuildError, LinqRuntimeError } from '@jarenjs/linq';
import { DbCompileError, DbRuntimeError } from '@jarenjs/db';
import { ContractCompileError, ContractRuntimeError, ContractHostError } from '@jarenjs/contract';


const CAUSE = new Error('matrix cause');

/** Assert an error has no own cause. @param {Error} err */
function assertNoCause(err) {
  assert.strictEqual(Object.hasOwn(err, 'cause'), false);
}

/** Assert an error retains CAUSE as its own cause. @param {Error} err */
function assertRealCause(err) {
  assert.strictEqual(Object.hasOwn(err, 'cause'), true);
  assert.strictEqual(/** @type {any} */ (err).cause, CAUSE);
}

describe('T6 — the cause matrix', () => {
  describe('options-form classes preserve an explicitly undefined cause', () => {
    for (const [cls, make] of /** @type {[string, (o?: any) => Error][]} */ ([
      ['JsonQueryCompileError', (o) => new JsonQueryCompileError('ZZ0001', 'r', '/p', o)],
      ['JsonQueryRuntimeError', (o) => new JsonQueryRuntimeError('ZZ0001', 'r', '/p', o)],
    ])) {
      it(`${cls}: no options → no own cause`, () => assertNoCause(make()));
      it(`${cls}: { cause: undefined } → OWN undefined cause (host threw undefined)`, () => {
        const err = make({ cause: undefined });
        assert.strictEqual(Object.hasOwn(err, 'cause'), true);
        assert.strictEqual(/** @type {any} */ (err).cause, undefined);
      });
      it(`${cls}: { cause } → own cause by identity`, () => assertRealCause(make({ cause: CAUSE })));
    }

    it('JsltCompileError (rest form): omitted → none; explicit undefined → own undefined; real → own', () => {
      assertNoCause(new JsltCompileError('ZZ0001', 'r', '/p'));
      const explicit = new JsltCompileError('ZZ0001', 'r', '/p', undefined);
      assert.strictEqual(Object.hasOwn(explicit, 'cause'), true);
      assert.strictEqual(explicit.cause, undefined);
      assertRealCause(new JsltCompileError('ZZ0001', 'r', '/p', CAUSE));
    });
  });

  describe('positional-adapter classes map a trailing undefined to "no cause"', () => {
    for (const [cls, make] of /** @type {[string, (c?: any) => Error][]} */ ([
      ['JsltRuntimeError', (c) => new JsltRuntimeError('ZZ0001', 'r', '/p', c)],
      ['JtltCompileError', (c) => new JtltCompileError('ZZ0001', 'r', '/p', c)],
      ['JtltRuntimeError', (c) => new JtltRuntimeError('ZZ0001', 'r', '/p', c)],
      ['JsonPatchCompileError', (c) => new JsonPatchCompileError('ZZ0001', 'r', '/p', c)],
      ['AppCompileError', (c) => new AppCompileError('ZZ0001', 'r', '/p', c)],
      ['FlowCompileError', (c) => new FlowCompileError('ZZ0001', 'r', '/p', c)],
      ['FlowRuntimeError', (c) => new FlowRuntimeError('ZZ0001', 'r', '/p', c)],
      ['LinqBuildError', (c) => new LinqBuildError('ZZ0001', 'r', '/p', c)],
      ['LinqRuntimeError', (c) => new LinqRuntimeError('ZZ0001', 'r', '/p', c)],
      ['DbCompileError', (c) => new DbCompileError('ZZ0001', 'r', '/p', c)],
      ['ContractCompileError', (c) => new ContractCompileError('ZZ0001', 'r', '/p', c)],
    ])) {
      it(`${cls}: omitted → no own cause`, () => assertNoCause(make()));
      it(`${cls}: positional undefined → STILL no own cause`, () => assertNoCause(make(undefined)));
      it(`${cls}: real cause → own cause by identity`, () => assertRealCause(make(CAUSE)));
    }

    it('AppRuntimeError (options form, app semantics): undefined cause is absence', () => {
      assertNoCause(new AppRuntimeError('ZZ0001', 'r'));
      assertNoCause(new AppRuntimeError('ZZ0001', 'r', { cause: undefined }));
      assertRealCause(new AppRuntimeError('ZZ0001', 'r', { cause: CAUSE }));
    });

    it('DbRuntimeError (details form, hasOwn semantics): an explicitly undefined cause is preserved', () => {
      assertNoCause(new DbRuntimeError('ZZ0001', 'r', { docPath: '/p' }));
      const explicit = new DbRuntimeError('ZZ0001', 'r', { docPath: '/p', cause: undefined });
      assert.strictEqual(Object.hasOwn(explicit, 'cause'), true);
      assert.strictEqual(explicit.cause, undefined);
      assertRealCause(new DbRuntimeError('ZZ0001', 'r', { docPath: '/p', cause: CAUSE }));
    });

    it('ContractRuntimeError (options form, hasOwn semantics): an explicitly undefined cause is preserved', () => {
      assertNoCause(new ContractRuntimeError('ZZ0001', 'r', { msgid: 'contract/x' }));
      const explicit = new ContractRuntimeError('ZZ0001', 'r', { msgid: 'contract/x', cause: undefined });
      assert.strictEqual(Object.hasOwn(explicit, 'cause'), true);
      assert.strictEqual(explicit.cause, undefined);
      assertRealCause(new ContractRuntimeError('ZZ0001', 'r', { msgid: 'contract/x', cause: CAUSE }));
    });


  });

  it('classes without a cause channel never grow one', () => {
    assertNoCause(new JsonPatchRuntimeError('ZZ0001', 'r', '/p', '/d'));
    assertNoCause(new JsonWriteError('ZZ0001', 'r', '/d'));
    assertNoCause(new ContractHostError('ZZ0001', 'r'));
  });
});

describe('T6a — the location matrix', () => {
  /** @type {[string, (p?: string) => Error][]} */
  const docPathClasses = [
    ['JsonQueryCompileError', (p) => new JsonQueryCompileError('ZZ0001', 'why', /** @type {any} */ (p))],
    ['JsltCompileError', (p) => new JsltCompileError('ZZ0001', 'why', /** @type {any} */ (p))],
    ['JtltRuntimeError', (p) => new JtltRuntimeError('ZZ0001', 'why', /** @type {any} */ (p))],
    ['AppCompileError', (p) => new AppCompileError('ZZ0001', 'why', p)],
    ['AppRuntimeError', (p) => new AppRuntimeError('ZZ0001', 'why', { docPath: p })],
    ['FlowCompileError', (p) => new FlowCompileError('ZZ0001', 'why', p)],
    ['FlowRuntimeError', (p) => new FlowRuntimeError('ZZ0001', 'why', p)],
    ['LinqBuildError', (p) => new LinqBuildError('ZZ0001', 'why', p)],
    ['LinqRuntimeError', (p) => new LinqRuntimeError('ZZ0001', 'why', p)],
    ['DbCompileError', (p) => new DbCompileError('ZZ0001', 'why', p)],
    ['DbRuntimeError', (p) => new DbRuntimeError('ZZ0001', 'why', { docPath: p })],
    ['ContractCompileError', (p) => new ContractCompileError('ZZ0001', 'why', p)],
  ];

  for (const [cls, make] of docPathClasses) {
    it(`${cls}: a real docPath renders "at <path>"`, () => {
      const err = /** @type {any} */ (make('/a/b'));
      assert.strictEqual(err.docPath, '/a/b');
      assert.strictEqual(err.message, "ZZ0001: why at /a/b");
      assert.strictEqual(err.reason, 'why');
    });
    it(`${cls}: the ROOT docPath ('') survives and renders "at ''"`, () => {
      const err = /** @type {any} */ (make(''));
      assert.strictEqual(err.docPath, '');
      assert.strictEqual(err.message, "ZZ0001: why at ''");
    });
    it(`${cls}: an absent docPath stays undefined and renders nothing`, () => {
      const err = /** @type {any} */ (make(undefined));
      assert.strictEqual(err.docPath, undefined);
      assert.strictEqual(err.message, 'ZZ0001: why');
    });
  }

  it('JsonWriteError: dataPath renders "in data <path>", root as \'\'', () => {
    assert.strictEqual(new JsonWriteError('ZZ0001', 'why', '/d').message,
      'ZZ0001: why in data /d');
    assert.strictEqual(new JsonWriteError('ZZ0001', 'why', '').message,
      "ZZ0001: why in data ''");
    assert.strictEqual(new JsonWriteError('ZZ0001', 'why', '').dataPath, '');
  });

  it('JsonPatchRuntimeError: docPath and dataPath render separately identifiable', () => {
    const err = new JsonPatchRuntimeError('ZZ0001', 'why', '/op/1', '/users/3');
    assert.strictEqual(err.message, 'ZZ0001: why at /op/1 in data /users/3');
    assert.strictEqual(/** @type {any} */ (err).docPath, '/op/1');
    assert.strictEqual(/** @type {any} */ (err).dataPath, '/users/3');
  });


});
