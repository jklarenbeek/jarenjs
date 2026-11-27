//@ts-check
/**
 * @file An app document computes with the operators of the host's
 * registry: `validateFile` reads the app's query and JSLT grammars with
 * the registry's operators beside the core ones, the render audit renders
 * with them, and the document host validates, audits and boots the app
 * with them. A registry that does not mount an operator refuses it as
 * an unknown operator (`JQ0002` at its own place), and a document that
 * names no operator of the registry validates against the published grammars.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { validateFile, fileSkeleton } from '@jarenjs/studio';
import { createStudioDocumentHost, createProjectHost } from '@jarenjs/studio/component';
import { createJsltRegistry, mathPack, financePack, statsPack } from '@jarenjs/json/jslt';
import { renderToString } from '@jarenjs/view';
import { grammarsFor, usesOperator } from '../../components/studio/src/operator-grammar.js';
import { defaultOperators } from '../../components/studio/src/validate.js';
import querySchema from '@jarenjs/json/schemas/jaren-query.schema.json' with { type: 'json' };
import jsltSchema from '@jarenjs/json/schemas/jaren-jslt.schema.json' with { type: 'json' };
import { readFileSync } from 'node:fs';

const site = createJsltRegistry().use(mathPack).use(financePack).use(statsPack);
const math = createJsltRegistry().use(mathPack);
const finance = createJsltRegistry().use(financePack);
const empty = createJsltRegistry();

const appDoc = (/** @type {any} */ body, extra = {}) => ({ state: { xs: [1, 2, 3], n: 16 }, view: [{ match: '$', body }], ...extra });
const file = (/** @type {any} */ doc) => ({ name: 'app.json', kind: 'app', text: JSON.stringify(doc) });
const VALID = { valid: true, kind: 'app', total: 0, errors: [], warnings: [] };
const sqrt = appDoc(['p', {}, { $string: { $sqrt: '$.n' } }]);
const mean = appDoc(['p', {}, { $string: { $mean: '$.xs' } }]);
const pmt = appDoc(['p', {}, 'x'], { actions: { pay: { patch: [{ op: 'replace', path: '/n', value: { $pmt: [0.01, 12, '$.n'] } }] } } });
const pow = appDoc(['p', {}, { $string: { $pow: [2, 10] } }]);

describe('validateFile: an app computes with the registry\'s operators', () => {
  it('a math-pack operator in the view validates under a registry that mounts it', () => {
    assert.deepEqual(validateFile(file(sqrt), { operators: math }), VALID);
    assert.deepEqual(validateFile(file(sqrt), { operators: site }), VALID);
    assert.deepEqual(validateFile(file(pow), { operators: math }), VALID);
  });

  it('the built-in packs are the default registry, as for the query and jslt kinds', () => {
    assert.deepEqual(validateFile(file(sqrt)), VALID);
    assert.deepEqual(validateFile(file(mean)), VALID);
    assert.deepEqual(validateFile(file(pmt)), VALID);
  });

  it('a stats-pack operator in the view and a finance-pack operator in an action validate', () => {
    assert.deepEqual(validateFile(file(mean), { operators: site }), VALID);
    assert.deepEqual(validateFile(file(pmt), { operators: finance }), VALID);
  });

  it('a subscription query computes with a registry operator', () => {
    const doc = appDoc(['p', {}, 'x'], { subs: [{ run: 'tick', when: { $gt: [{ $sqrt: '$.n' }, 1] } }] });
    assert.deepEqual(validateFile(file(doc), { operators: math }), VALID);
  });

  it('the render audit renders with the registry: the first frame is the operator\'s answer', () => {
    // valid means the first frame rendered; an operator the audit lacked would fail the frame
    const failing = appDoc(['p', {}, { $string: { $sqrt: '$.n' } }, { $string: { $div: [1, { $sqrt: '$.none' }] } }]);
    assert.equal(validateFile(file(failing), { operators: math }).valid, true);
    const host = createStudioDocumentHost({ markdown: (s) => ['p', {}, s], diagram: (s) => ['pre', {}, s] });
    assert.deepEqual(host.auditDocumentRender(sqrt, { operators: math }), { widgets: [], problems: [], notes: [] });
    const frame = math.compile(sqrt.view)(sqrt.state);
    assert.equal(renderToString(frame), '<p>4</p>');
  });

  it('an operator the registry does not mount stays refused with the same code and place', () => {
    const refused = (/** @type {string} */ name, /** @type {string} */ reason) => ({
      valid: false, kind: 'app', total: 1, warnings: [],
      errors: [{ code: 'JQ0002', message: `unknown operator '${name}' (${reason})`, docPath: `/view/0/body/2/$string` }],
    });
    assert.deepEqual(validateFile(file(sqrt), { operators: finance }), refused('$sqrt', 'no operator does this in jaren-query'));
    assert.deepEqual(validateFile(file(sqrt), { operators: empty }), refused('$sqrt', 'no operator does this in jaren-query'));
    assert.deepEqual(validateFile(file(mean), { operators: finance }), refused('$mean', "did you mean '$map'?"));
    const action = validateFile(file(pmt), { operators: math });
    assert.deepEqual(action.errors.map((e) => `${e.code} ${e.docPath}`), ['JQ0002 /actions/pay/patch/0/value']);
  });

  it('a registry operator with the wrong operand count is refused', () => {
    for (const operands of [[2], [2, 3, 4]]) {
      const verdict = validateFile(file(appDoc(['p', {}, { $string: { $pow: operands } }])), { operators: math });
      assert.equal(verdict.valid, false, JSON.stringify(operands));
      assert.ok(verdict.errors.every((e) => e.code === null && e.docPath.startsWith('/view/0/body')), JSON.stringify(verdict.errors.slice(0, 3)));
    }
    // a registry operator beside another member is no phrase at all
    assert.equal(validateFile(file(appDoc(['p', {}, { $string: { $sqrt: 16, x: 1 } }])), { operators: math }).valid, false);
    assert.equal(validateFile(file(appDoc(['p', {}, { $string: { $sqrt: 16, $abs: 1 } }])), { operators: math }).valid, false);
  });

  it('a document naming no registry operator, or naming one outside an expression, answers as under the published grammars', () => {
    const docs = [
      JSON.parse(fileSkeleton('app')),
      appDoc(['p', {}, { $string: { $abs: -3 } }]),
      appDoc(['p', {}, { $string: { $abs: [1, 2] } }]),
      appDoc(['p', {}, { $string: { $call: ['twice', 21] } }]),
      { state: {} },
      // a registry operator's name outside an expression (state data, a
      // quoted value): read through the registry's grammar, answered alike
      { state: { $sqrt: 1 }, view: [{ match: '$', body: ['p', {}, 'x'] }] },
      appDoc(['p', {}, { $string: { $const: { $sqrt: 16 } } }]),
    ];
    for (const doc of docs) {
      const core = validateFile(file(doc), { operators: empty });
      assert.deepEqual(validateFile(file(doc), { operators: site }), core, JSON.stringify(doc));
      assert.deepEqual(validateFile(file(doc)), core, JSON.stringify(doc));
    }
    // an unknown operator is refused at its place under every registry; the nearest
    // known operator the compiler names is the registry's
    const typo = file(appDoc(['p', {}, { $string: { $sqrtt: 16 } }]));
    assert.deepEqual(validateFile(typo, { operators: site }).errors,
      [{ code: 'JQ0002', message: "unknown operator '$sqrtt' (did you mean '$sqrt'?)", docPath: '/view/0/body/2/$string' }]);
    assert.deepEqual(validateFile(typo, { operators: empty }).errors.map((e) => `${e.code} ${e.docPath}`), ['JQ0002 /view/0/body/2/$string']);
  });
});

describe('the registry\'s grammars', () => {
  it('with no extension operator they are the published grammar objects themselves', () => {
    assert.equal(grammarsFor(empty.toOptions()).query, querySchema);
    assert.equal(grammarsFor(empty.toOptions()).jslt, jsltSchema);
    assert.equal(grammarsFor(undefined).key, '');
  });

  it('composing a registry\'s grammars leaves the published grammars byte-identical', () => {
    const composed = grammarsFor(site.toOptions());
    assert.notEqual(composed.query, querySchema);
    const published = (/** @type {string} */ name) => JSON.parse(readFileSync(new URL(`../../packages/json/schemas/${name}.schema.json`, import.meta.url), 'utf8'));
    assert.deepEqual(querySchema, published('jaren-query'));
    assert.deepEqual(jsltSchema, published('jaren-jslt'));
    assert.equal(grammarsFor(site.toOptions()).query, composed.query, 'kept per operator set');
  });

  it('each operator gets the operand shape its compile accepts', () => {
    const { query } = grammarsFor(site.toOptions());
    const phrases = query.$defs.objectExpression.oneOf.slice(querySchema.$defs.objectExpression.oneOf.length)
      .map((/** @type {any} */ ref) => query.$defs[ref.$ref.split('/').at(-1)]);
    const shapeOf = (/** @type {string} */ name) => phrases.find((/** @type {any} */ p) => p.propertyNames.enum.includes(name))?.additionalProperties;
    assert.deepEqual(shapeOf('$sqrt'), { $ref: '#/$defs/expression' });
    assert.deepEqual(shapeOf('$pow'), { type: 'array', items: { $ref: '#/$defs/expression' }, minItems: 2, maxItems: 2 });
    assert.deepEqual(shapeOf('$pmt'), { type: 'array', items: { $ref: '#/$defs/expression' }, minItems: 3, maxItems: 3 });
    const all = phrases.flatMap((/** @type {any} */ p) => p.propertyNames.enum).sort();
    assert.deepEqual(all, Object.keys(site.toOptions().extensions).sort());
  });

  it('an operator with its own normalize, a variadic one or a non-expression operand reads its shape from its descriptor', () => {
    const extensions = {
      $own: { params: 'expr', normalize: () => ({ args: [] }) },
      $many: { params: { kinds: ['expr'], min: 1, variadic: true } },
      $named: { params: { kinds: ['name', 'expr'], min: 2 } },
      $quoted: { params: 'raw' },
    };
    const { query } = grammarsFor({ extensions });
    const added = query.$defs.objectExpression.oneOf.slice(querySchema.$defs.objectExpression.oneOf.length)
      .map((/** @type {any} */ ref) => query.$defs[ref.$ref.split('/').at(-1)]);
    assert.deepEqual(added.map((/** @type {any} */ p) => [p.propertyNames.enum, p.additionalProperties]), [
      [['$many'], { type: 'array', items: { $ref: '#/$defs/expression' }, minItems: 1 }],
      [['$named'], { type: 'array', items: true, minItems: 2, maxItems: 2 }],
      [['$own', '$quoted'], true],
    ]);
  });

  it('usesOperator finds a registry operator anywhere in a document, and nothing in its absence', () => {
    const options = math.toOptions();
    assert.equal(usesOperator(sqrt, options), true);
    assert.equal(usesOperator(pmt, options), false);
    assert.equal(usesOperator({ a: [{ b: { $pow: [1, 2] } }] }, options), true);
    assert.equal(usesOperator(sqrt, undefined), false);
    assert.equal(usesOperator('$sqrt', options), false);
  });
});

describe('the document host boots an app with the registry\'s operators', () => {
  const host = createStudioDocumentHost({ markdown: (s) => ['p', {}, s], diagram: (s) => ['pre', {}, s] });

  it('validates and boots under the registry; refuses without one, as before', () => {
    assert.deepEqual(host.validateAppDocument(sqrt, { operators: math }), { valid: true, errors: [], total: 0 });
    const loaded = host.loadStudioDocument(pmt, { operators: finance, schedule: (/** @type {() => void} */ f) => f() });
    assert.equal(loaded.ok, true);
    if (!loaded.ok) return;
    loaded.app.dispatch('pay');
    const payment = -(16 * 0.01) / (1 - 1.01 ** -12);
    assert.ok(Math.abs(loaded.app.getState().n - payment) < 1e-9, String(loaded.app.getState().n));
    loaded.app.destroy();
    const refused = host.loadStudioDocument(sqrt, {});
    assert.equal(refused.ok, false);
    assert.equal(host.validateAppDocument(sqrt).valid, false);
    assert.equal(host.validateAppDocument(sqrt, { operators: finance }).valid, false);
    assert.match(host.auditDocumentRender(sqrt).problems[0], /unknown operator '\$sqrt'/);
  });

  it('the project stage boots with the host\'s registry, else with the one files validate under', () => {
    /** @type {any[]} */
    const seen = [];
    const loadDocument = (/** @type {any} */ _doc, /** @type {any} */ env) => {
      seen.push(env.operators);
      env.onError(new Error('the app reported'));
      return { ok: true, app: null };
    };
    const runners = { runQuery: () => [], runJslt: () => [], runValidation: () => null };
    const props = { doc: sqrt, revision: 1 };
    const stageHost = { ownerDocument: null };
    /** @type {any[]} */
    const emitted = [];
    createProjectHost({ operators: finance, loadDocument, ...runners }).createProjectStageWidget().mount(stageHost, props, (/** @type {any} */ e) => emitted.push(e));
    createProjectHost({ loadDocument, ...runners }).createProjectStageWidget().mount(stageHost, props, () => {});
    assert.equal(seen[0], finance);
    assert.equal(seen[1], defaultOperators);
    // the app's runtime errors reach the stage's error line
    assert.deepEqual(emitted, [{ action: 'project/stage-error', with: null }, { action: 'project/stage-error', with: 'the app reported' }]);
  });
});
