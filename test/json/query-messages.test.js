//@ts-check
/**
 * @file Query errors carry their sentence as data: a `messageId` from the
 * English catalog (`queryMessagesEn`) and the `params` it was rendered with.
 * `reason` is that rendering, so nothing that reads `reason` changes, and
 * `renderQueryMessage(error, catalog)` renders the same error in another
 * language. The source gate below holds every raise site to the catalog.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

import {
  compileJsonQuery, JsonQueryCompileError, JsonQueryRuntimeError,
  queryCatalogEn, queryMessagesEn, renderQueryMessage,
} from '@jarenjs/json';
import { compileMessageTemplate } from '@jarenjs/core/message';

/** The error a thunk throws. @param {() => unknown} run */
function thrown(run) {
  try { run(); }
  catch (error) { return /** @type {any} */ (error); }
  throw new Error('expected a throw');
}

/** A compile error and a runtime error per message family the engine raises. */
const SAMPLES = [
  () => compileJsonQuery({ $nope: 1 }),
  () => compileJsonQuery({ $ad: [1, 2] }),
  () => compileJsonQuery({ $if: 1 }),
  () => compileJsonQuery({ $add: [1] }),
  () => compileJsonQuery('$undeclared', { externals: [] }),
  () => compileJsonQuery('$undeclared', { externals: ['a', 'b'] }),
  () => compileJsonQuery({ $query: '9.9', $expr: 1 }),
  () => compileJsonQuery({ a: 1, $b: 2 }),
  () => compileJsonQuery({ $for: { x: '$.a' }, $return: '$x', $window: 'bad' }),
  () => compileJsonQuery({ $substring: ['$.s', 1] })({ s: 5 }),
  () => compileJsonQuery({ $add: ['$.a', 1] })({ a: 'x' }),
  () => compileJsonQuery({ $idiv: [1, 0] })(null),
  () => compileJsonQuery({ $year: '$.d' })({ d: 'not a date' }),
  () => compileJsonQuery({ $if: ['$.a[*]', 1, 2] })({ a: [1, 2] }),
  () => compileJsonQuery('$.a')(undefined),
  () => compileJsonQuery('$x', { externals: ['x'] })({}),
];

describe('query errors carry their message as data', () => {
  it('every sampled error names a catalog message, and its reason is that message in English', () => {
    for (const run of SAMPLES) {
      const error = thrown(run);
      assert.ok(error instanceof JsonQueryCompileError || error instanceof JsonQueryRuntimeError, String(error));
      assert.ok(Object.hasOwn(queryMessagesEn, error.messageId), `${error.messageId} is in the catalog`);
      assert.strictEqual(renderQueryMessage(error), error.reason, error.messageId);
      assert.deepStrictEqual(JSON.parse(JSON.stringify(error.params)), error.params, 'params are JSON');
    }
  });

  it('an item met at run time is a message of its own, rendered by the catalog that renders the error', () => {
    const error = thrown(() => compileJsonQuery({ $substring: ['$.s', 1] })({ s: 5 }));
    assert.strictEqual(error.messageId, 'query/expected-string');
    assert.deepStrictEqual(error.params, { got: { messageId: 'query/item/number', params: {} } });
    assert.strictEqual(error.reason, 'expected a string, got a number');
    const shouting = { 'query/expected-string': 'WANTED A STRING, GOT {got}', 'query/item/number': 'A NUMBER' };
    assert.strictEqual(renderQueryMessage(error, shouting), 'WANTED A STRING, GOT A NUMBER');
  });

  it('an alias hint that is a composition is a message of its own, translated with the sentence', () => {
    const error = thrown(() => compileJsonQuery({ $last: '$.a' }));
    assert.strictEqual(error.reason, "unknown operator '$last' (use $head of $reverse)");
    assert.deepStrictEqual(error.params, { key: '$last', use: { messageId: 'query/use/head-of-reverse', params: {} } });
    const dutch = { 'query/unknown-operator-use': "onbekende operator '{key}' (gebruik {use})", 'query/use/head-of-reverse': '$head van $reverse' };
    assert.strictEqual(renderQueryMessage(error, dutch), "onbekende operator '$last' (gebruik $head van $reverse)");
    const single = thrown(() => compileJsonQuery({ $first: '$.a' }));
    assert.deepStrictEqual(single.params, { key: '$first', use: "'$head'" }, 'one operator is its name, in any language');
  });

  it('a catalog missing a message falls back to English, message by message', () => {
    const error = thrown(() => compileJsonQuery({ $substring: ['$.s', 1] })({ s: 5 }));
    assert.strictEqual(renderQueryMessage(error, { 'query/item/number': 'een getal' }), 'expected a string, got een getal');
  });

  it('an error built with the bare constructor carries query/reason, its own English', () => {
    const error = new JsonQueryRuntimeError('JQ2001', 'a host said no', '/x');
    assert.strictEqual(error.messageId, 'query/reason');
    assert.deepStrictEqual(error.params, { reason: 'a host said no' });
    assert.strictEqual(renderQueryMessage(error, { 'query/reason': '{reason}' }), 'a host said no');
    assert.strictEqual(renderQueryMessage({ reason: 'plain' }), 'plain', 'anything with a reason renders');
  });

  it('a JQ-coded formula error names its message too, as its own English', async () => {
    const { compileFormula } = await import('@jarenjs/json/formula');
    const error = thrown(() => compileFormula(/** @type {any} */ ({ id: 'f1' })));
    assert.match(error.code, /^JQ/);
    assert.strictEqual(error.messageId, 'query/reason');
    assert.strictEqual(renderQueryMessage(error), error.reason);
  });

  it('a cause is kept exactly as before: present when given, even undefined', () => {
    const withCause = new JsonQueryCompileError('JQ0009', 'x', '', { cause: undefined, messageId: 'query/reason', params: { reason: 'x' } });
    assert.ok(Object.hasOwn(withCause, 'cause'));
    assert.ok(!Object.hasOwn(new JsonQueryCompileError('JQ0009', 'x', ''), 'cause'));
  });
});

describe('the catalog is the only source of a query message', () => {
  const SRC = new URL('../../packages/json/src/', import.meta.url);
  const files = [
    ...readdirSync(new URL('query/', SRC)).filter((f) => f.endsWith('.js')).map((f) => `query/${f}`),
    ...readdirSync(new URL('jslt/', SRC)).filter((f) => f.endsWith('.js')).map((f) => `jslt/${f}`),
  ];
  const source = Object.fromEntries(files.map((f) => [f, readFileSync(new URL(f, SRC), 'utf8')]));

  it('no raise site builds an English sentence: only the extension helper passes one through', () => {
    const raw = [];
    for (const [file, text] of Object.entries(source)) {
      if (file === 'query/messages.js' || file === 'query/errors.js') continue;
      for (const m of text.matchAll(/new JsonQuery(?:Compile|Runtime)Error\(/g)) {
        const line = text.slice(0, m.index).split('\n').length;
        raw.push(`${file}:${line}`);
      }
    }
    // normalize.js's `fail`, handed to extension operators as their own refusal
    assert.deepStrictEqual(raw.map((at) => at.split(':')[0]), ['query/normalize.js']);
  });

  it('every message id a source names is in the catalog, and every catalog message is named or derived', () => {
    // the database raises one of its own: an aggregate pushed down to SQL that met a null
    const db = readFileSync(new URL('../../packages/db/src/query.js', import.meta.url), 'utf8');
    const named = new Set();
    for (const text of [...Object.values(source), db]) for (const m of text.matchAll(/['"](query\/[a-z/-]*[a-z])['"]/g)) named.add(m[1]);
    for (const id of named) assert.ok(Object.hasOwn(queryMessagesEn, id), `${id} is in the catalog`);
    // the four scalar item kinds come from `query/item/${typeof v}`
    const derived = ['query/item/object', 'query/item/string', 'query/item/number', 'query/item/boolean'];
    for (const id of Object.keys(queryMessagesEn)) {
      assert.ok(named.has(id) || derived.includes(id), `${id} is raised somewhere`);
    }
  });

  it('an alias names one operator or a query/use message, and every query/use message is some alias\'s', async () => {
    const { OPERATOR_ALIASES } = await import('../../packages/json/src/query/normalize.js');
    const hints = new Set();
    for (const [key, target] of Object.entries(OPERATOR_ALIASES)) {
      if (target === null) continue;
      if (target.startsWith('query/use/')) {
        assert.ok(Object.hasOwn(queryMessagesEn, target), `${key}: ${target} is in the catalog`);
        hints.add(target);
      }
      else assert.match(target, /^\$[a-z][a-z-]*$/, `${key} names one operator, or its hint is a message`);
    }
    assert.deepStrictEqual([...hints].sort(), Object.keys(queryMessagesEn).filter((id) => id.startsWith('query/use/')).sort());
  });

  it('every English template compiles and names its parameters', () => {
    for (const [id, template] of Object.entries(queryMessagesEn)) {
      const compiled = compileMessageTemplate(template);
      assert.strictEqual(typeof queryCatalogEn[id], 'function');
      for (const name of compiled.parameters) assert.match(name, /^[a-z]+$/i, `${id}: {${name}}`);
    }
  });
});
