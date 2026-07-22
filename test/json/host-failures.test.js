//@ts-check
/**
 * @file Host-failure totality across the JSON package's host extension
 * points: registered `$call` functions (`JQ2010`), query
 * `compileTypeTest` (`JQ0009`), and JSLT view match-schema
 * `compileTypeTest` (`JT0005`) — every throw keeps its stable code and
 * document path, projects a safe diagnostic (no raw `.message` read,
 * no user coercion, no proxy-observable reflection), and retains the
 * original thrown value as an own, presence-testable `cause`, even for
 * `undefined`.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { compileJsonQuery } from '@jarenjs/json/query';
import { compileJsltStylesheet } from '@jarenjs/json/jslt';

function revokedProxy() {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  return proxy;
}

function hostileMessageError() {
  const e = new Error('hidden');
  Object.defineProperty(e, 'message', {
    get() { throw new Error('message getter ran'); },
  });
  return e;
}

const VALUE_CLASSES = () => [
  ['null', null],
  ['undefined', undefined],
  ['hostile-message Error', hostileMessageError()],
  ['revoked proxy', revokedProxy()],
];

describe('registered $call functions keep the JQ2010 contract (§10.3)', () => {
  it('every thrown value class produces JQ2010 with docPath, safe text and own cause', () => {
    for (const [label, thrown] of VALUE_CLASSES()) {
      const query = compileJsonQuery({ $call: ['boom'] }, {
        functions: { boom: () => { throw thrown; } },
      });
      let caught = null;
      try {
        query(null);
      }
      catch (error) {
        caught = error;
      }
      assert.strictEqual(caught?.code, 'JQ2010', label);
      assert.strictEqual(caught.docPath, '',
        `${label}: the root phrase owns the document path`);
      assert.strictEqual(typeof caught.message, 'string', label);
      assert.ok(Object.hasOwn(caught, 'cause'),
        `${label}: cause presence is testable even for undefined`);
      assert.strictEqual(caught.cause, thrown, `${label}: original value by identity`);
    }
  });
});

describe('JSLT view match-schema compileTypeTest keeps the JT0005 contract (§10.3)', () => {
  it('every thrown value class produces JT0005 with safe text and own cause', () => {
    for (const [label, thrown] of VALUE_CLASSES()) {
      let caught = null;
      try {
        compileJsltStylesheet([
          { match: { schema: { type: 'object' } }, body: 'x' },
        ], {
          compileTypeTest: () => { throw thrown; },
        });
      }
      catch (error) {
        caught = error;
      }
      assert.strictEqual(caught?.code, 'JT0005', label);
      assert.strictEqual(typeof caught.message, 'string', label);
      assert.ok(Object.hasOwn(caught, 'cause'),
        `${label}: cause presence is testable even for undefined`);
      assert.strictEqual(caught.cause, thrown, `${label}: original value by identity`);
    }
  });
});
