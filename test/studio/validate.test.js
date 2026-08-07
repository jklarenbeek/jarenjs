//@ts-check
/**
 * @file Per-file validation: each kind validated against its OWN grammar;
 * jslt/query COMPILED with the operator registry (so registered ops
 * validate and a real error is its own coded code + docPath); the app
 * render audit; the closed-vs-registry boundary.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { validateFile } from '@jarenjs/studio';
import { createJsltRegistry } from '@jarenjs/json/jslt';

const file = (kind, value) => ({ name: `f.${kind}`, kind, text: JSON.stringify(value) });

describe('state / data — any JSON', () => {
  it('accepts any JSON value', () => {
    assert.strictEqual(validateFile(file('state', { a: 1 })).valid, true);
    assert.strictEqual(validateFile(file('data', [1, 2, 3])).valid, true);
  });
  it('rejects non-JSON text with a docPath-carrying error', () => {
    const r = validateFile({ name: 'x', kind: 'data', text: '{ nope' });
    assert.strictEqual(r.valid, false);
    assert.match(r.errors[0].message, /not valid JSON/);
  });
});

describe('app — meta-schema + render audit', () => {
  it('accepts a minimal valid app (required view present)', () => {
    assert.strictEqual(validateFile(file('app', { view: [] })).valid, true);
  });
  it('rejects a structurally invalid app against the composed meta-schema', () => {
    const r = validateFile(file('app', { notview: 1 }));
    assert.strictEqual(r.valid, false);
    assert.ok(r.total >= 1 && typeof r.errors[0].message === 'string');
  });
  it('catches a document that validates but throws on its first frame (render audit)', () => {
    // structurally a valid stylesheet, but $call names an unregistered
    // function → the audit fails to render the first frame
    const r = validateFile(file('app', {
      state: { n: 1 },
      view: [{ match: '$', body: { $call: ['no_such_fn', '$.n'] } }],
    }));
    assert.strictEqual(r.valid, false);
    assert.match(r.errors[0].message, /render its first frame|failed/i);
    assert.strictEqual(r.errors[0].docPath, '/view');
  });
});

describe('jslt / query — compiled, registered operators included', () => {
  it('accepts a valid stylesheet and a valid query', () => {
    assert.strictEqual(validateFile(file('jslt', [{ match: '$', body: { $mul: ['$', 2] } }])).valid, true);
    assert.strictEqual(validateFile(file('query', { $for: { it: '$[*]' }, $return: '$it' })).valid, true);
  });
  it('surfaces a real error as its own coded code + docPath', () => {
    const r = validateFile(file('query', { x: { $flter: '$' } }));
    assert.strictEqual(r.valid, false);
    assert.strictEqual(r.errors[0].code, 'JQ0002');
    assert.strictEqual(r.errors[0].docPath, '/x');
  });
  it('a registered operator ($npv, $mean) validates WITH the mounted packs and is refused WITHOUT them', () => {
    const npv = file('query', { v: { $npv: ['$.rate', '$.cf[*]'] } });
    assert.strictEqual(validateFile(npv).valid, true, 'the studio mounts the packs by default');
    const empty = createJsltRegistry();
    const refused = validateFile(npv, { operators: empty });
    assert.strictEqual(refused.valid, false, 'a registry without the packs rejects it');
    assert.strictEqual(refused.errors[0].code, 'JQ0002');
  });
});

describe('schema / fsm / dag / model — their own grammar', () => {
  it('schema: an object/boolean schema compiles; a non-schema value does not', () => {
    assert.strictEqual(validateFile(file('schema', { type: 'string' })).valid, true);
    assert.strictEqual(validateFile(file('schema', true)).valid, true);
    assert.strictEqual(validateFile(file('schema', 42)).valid, false);
    assert.strictEqual(validateFile(file('schema', [1, 2])).valid, false);
  });
  it('fsm / dag / model: an empty object fails its required grammar, tagged with the kind', () => {
    for (const kind of ['fsm', 'dag', 'model']) {
      const r = validateFile(file(kind, {}));
      assert.strictEqual(r.kind, kind);
      assert.strictEqual(r.valid, false, `${kind} {} should fail its grammar`);
      assert.ok(r.total >= 1);
    }
  });
  it('an unknown kind is reported, never thrown', () => {
    const r = validateFile({ name: 'x', kind: 'nope', text: '{}' });
    assert.strictEqual(r.valid, false);
    assert.match(r.errors[0].message, /unknown file kind/);
  });
});

describe('memoized on file identity', () => {
  it('re-validating the SAME object is cached; a fresh object re-checks', () => {
    const f = file('app', {
      state: {}, view: [{ match: '$', body: ['p', {}, 'x'] }], actions: {},
    });
    const first = validateFile(f);
    assert.strictEqual(validateFile(f), first,
      'the same file object returns the identical verdict (no recompile)');

    // an edit produces a NEW object, so the verdict must be recomputed —
    // the cache keys identity, never content
    const edited = { ...f, text: '{ not json' };
    const after = validateFile(edited);
    assert.notStrictEqual(after, first);
    assert.strictEqual(after.valid, false, 'the edited file really was re-checked');
  });

  it('the same file under a different operator registry is checked separately', () => {
    const f = file('query', { v: { $npv: ['$.r', '$.f[*]'] } });
    // the default registry mounts the finance pack, so $npv resolves
    assert.strictEqual(validateFile(f).valid, true);
    // an EMPTY registry does not — a cache keyed on the file alone would
    // wrongly hand back the permissive verdict
    const bare = createJsltRegistry();
    assert.strictEqual(validateFile(f, { operators: bare }).valid, false,
      '$npv is unknown without the finance pack');
    assert.strictEqual(validateFile(f).valid, true, 'and the default verdict is intact');
  });
});
