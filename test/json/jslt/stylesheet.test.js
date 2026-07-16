import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import {
  compileJsltStylesheet,
  JsltCompileError,
} from '@jarenjs/json/jslt';
import {
  compileJsonQuery,
  JsonQueryCompileError,
} from '@jarenjs/json/query';
import { JSONPathSyntaxError } from '@jarenjs/json/path';

function compileFails(doc, options, code, docPath, checkCause = null) {
  assert.throws(() => compileJsltStylesheet(doc, options), (error) => {
    assert.strictEqual(error instanceof JsltCompileError, true,
      `expected JsltCompileError, got ${error.name}: ${error.message}`);
    assert.strictEqual(error.code, code);
    if (docPath !== undefined)
      assert.strictEqual(error.docPath, docPath);
    if (checkCause !== null)
      checkCause(error.cause);
    return true;
  });
}

describe('Jaren JSLT stylesheet compilation', () => {
  describe('stylesheet envelopes', () => {
    it('accepts the bare rule-array form and freezes an independent document copy', () => {
      const doc = [{ body: { value: '$.value' } }];
      const transform = compileJsltStylesheet(doc);
      assert.deepStrictEqual(transform({ value: 3 }), { value: 3 });
      assert.notStrictEqual(transform.doc, doc);
      assert.strictEqual(Object.isFrozen(transform.doc), true);
      assert.strictEqual(Object.isFrozen(transform.doc[0]), true);
      assert.strictEqual(Object.isFrozen(transform.doc[0].body), true);
      doc[0].body.value = 9;
      assert.deepStrictEqual(transform({ value: 3 }), { value: 3 });
    });

    it('accepts the 0.1 envelope and its dispositions/mode overrides', () => {
      const transform = compileJsltStylesheet({
        $jslt: '0.1',
        unmatched: 'share',
        modes: {
          copy: { unmatched: 'fresh' },
          strict: { unmatched: 'error' },
        },
        rules: [],
      });
      const data = { value: 1 };
      assert.strictEqual(transform(data), data);
    });

    it('rejects non-stylesheets, incomplete envelopes, and unknown members with JT0001', () => {
      compileFails(null, undefined, 'JT0001', '');
      compileFails(42, undefined, 'JT0001', '');
      compileFails({}, undefined, 'JT0001', '/$jslt');
      compileFails({ $jslt: '0.1' }, undefined, 'JT0001', '/rules');
      compileFails({ $jslt: '0.1', rules: {} }, undefined, 'JT0001', '/rules');
      compileFails({ $jslt: '0.1', rules: [], note: true }, undefined,
        'JT0001', '/note');
    });

    it('rejects unknown versions with JT0004', () => {
      compileFails({ $jslt: '0.2', rules: [] }, undefined, 'JT0004', '/$jslt');
      compileFails({ $jslt: 0.1, rules: [] }, undefined, 'JT0004', '/$jslt');
    });

    it('rejects invalid unmatched and modes shapes with JT0001', () => {
      compileFails({ $jslt: '0.1', rules: [], unmatched: 'copy' }, undefined,
        'JT0001', '/unmatched');
      compileFails({ $jslt: '0.1', rules: [], modes: [] }, undefined,
        'JT0001', '/modes');
      compileFails({ $jslt: '0.1', rules: [], modes: { x: null } }, undefined,
        'JT0001', '/modes/x');
      compileFails({ $jslt: '0.1', rules: [], modes: { x: {} } }, undefined,
        'JT0001', '/modes/x/unmatched');
      compileFails({
        $jslt: '0.1',
        rules: [],
        modes: { x: { unmatched: 'copy' } },
      }, undefined, 'JT0001', '/modes/x/unmatched');
      compileFails({
        $jslt: '0.1',
        rules: [],
        modes: { x: { note: true } },
      }, undefined, 'JT0001', '/modes/x/note');
    });
  });

  describe('rule shapes', () => {
    it('rejects non-object rules, missing bodies, and unknown members with JT0002', () => {
      compileFails({ $jslt: '0.1', rules: [null] }, undefined,
        'JT0002', '/rules/0');
      compileFails({ $jslt: '0.1', rules: [{ match: '$' }] }, undefined,
        'JT0002', '/rules/0/body');
      compileFails({ $jslt: '0.1', rules: [{ body: 1, note: true }] }, undefined,
        'JT0002', '/rules/0/note');
    });

    it('reports exact pointers for invalid mode and priority values', () => {
      compileFails({
        $jslt: '0.1',
        rules: [{ body: 0 }, { body: 1 }, { body: 2, mode: 3 }],
      }, undefined, 'JT0002', '/rules/2/mode');
      compileFails({
        $jslt: '0.1',
        rules: [{ body: 0 }, { body: 1 }, { body: 2, priority: 'high' }],
      }, undefined, 'JT0002', '/rules/2/priority');
      compileFails([{ body: 1, priority: Infinity }], undefined,
        'JT0002', '/0/priority');
    });
  });

  describe('match compilation', () => {
    it('rejects malformed, empty, and open match objects with JT0003', () => {
      compileFails([{ match: 3, body: 1 }], undefined, 'JT0003', '/0/match');
      compileFails([{ match: {}, body: 1 }], undefined, 'JT0003', '/0/match');
      compileFails([{ match: { note: true }, body: 1 }], undefined,
        'JT0003', '/0/match/note');
      compileFails([{ match: { path: 3 }, body: 1 }], undefined,
        'JT0003', '/0/match/path');
      compileFails([{ match: { path: '$', extra: true }, body: 1 }], undefined,
        'JT0003', '/0/match/extra');
    });

    it('wraps invalid JSONPath syntax as JT0003 with its parser cause', () => {
      compileFails([{ match: '$.items[', body: 1 }], undefined,
        'JT0003', '/0/match', (cause) => {
          assert.strictEqual(cause instanceof JSONPathSyntaxError, true);
        });
      compileFails([{
        match: { path: '$.items[' },
        body: 1,
      }], undefined, 'JT0003', '/0/match/path', (cause) => {
        assert.strictEqual(cause instanceof JSONPathSyntaxError, true);
      });
    });

    it('requires a hook for schema matches (JT0006)', () => {
      compileFails([{ match: { schema: true }, body: 1 }], undefined,
        'JT0006', '/0/match/schema');
    });

    it('wraps hook rejection as JT0005 and preserves the cause', () => {
      const cause = new Error('bad schema');
      compileFails([{ match: { schema: { type: 5 } }, body: 1 }], {
        compileTypeTest() {
          throw cause;
        },
      }, 'JT0005', '/0/match/schema', (actual) => {
        assert.strictEqual(actual, cause);
      });
    });

    it('treats a non-predicate hook result as JT0005', () => {
      compileFails([{ match: { schema: true }, body: 1 }], {
        compileTypeTest: () => 'not a function',
      }, 'JT0005', '/0/match/schema', (cause) => {
        assert.strictEqual(cause instanceof TypeError, true);
      });
    });
  });

  describe('body compilation', () => {
    it('composes the rule-body pointer and preserves the query compile error', () => {
      const doc = {
        $jslt: '0.1',
        rules: [{
          body: {
            $for: { x: [1] },
            $where: { $eq: [1] },
            $return: '$x',
          },
        }],
      };
      compileFails(doc, undefined, 'JT0007',
        '/rules/0/body/$where/$eq', (cause) => {
          assert.strictEqual(cause instanceof JsonQueryCompileError, true);
          assert.strictEqual(cause.code, 'JQ0003');
          assert.strictEqual(cause.docPath, '/$where/$eq');
        });
    });

    it('keeps $apply outside the core query vocabulary', () => {
      assert.throws(() => compileJsonQuery({ $apply: ['$'] }), (error) => {
        assert.strictEqual(error instanceof JsonQueryCompileError, true);
        assert.strictEqual(error.code, 'JQ0002');
        return true;
      });
    });

    it('surfaces malformed $apply forms through JT0007/JQ0003', () => {
      for (const body of [
        { $apply: [] },
        { $apply: ['$', '', 'extra'] },
        { $apply: ['$', 3] },
      ]) {
        compileFails([{ body }], undefined, 'JT0007', undefined, (cause) => {
          assert.strictEqual(cause.code, 'JQ0003');
        });
      }
    });
  });

  it('validates maxDepth as a host option', () => {
    assert.throws(() => compileJsltStylesheet([], { maxDepth: -1 }), TypeError);
    assert.throws(() => compileJsltStylesheet([], { maxDepth: 1.5 }), TypeError);
  });
});
