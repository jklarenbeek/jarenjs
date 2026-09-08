//@ts-check
/**
 * @file Assembly + change classification + describe. Whole-document
 * artifacts (state/data are inputs, not artifacts); the reboot-vs-hot-
 * update datum (structural vs state-only vs none); and the per-file
 * metadata the IDE rail reads. The assembled app document renders its
 * first frame headlessly — the "bootable" proof without a DOM.
 */

import { describe as suite, it } from 'node:test';
import * as assert from 'node:assert';

import { parseProject, assembleArtifacts, classifyChange, describe } from '@jarenjs/studio';
import { contentKey } from '@jarenjs/core/object';
import { compileJsltStylesheet } from '@jarenjs/json/jslt';

/** An app project with a given state and view (the rest fixed). */
const appProject = (state, view) => parseProject({
  project: '0.1',
  files: [
    { name: 'app.json', kind: 'app', text: JSON.stringify({ state, view, actions: { bump: { $add: ['$.n', 1] } } }) },
    { name: 'top.query', kind: 'query', text: JSON.stringify({ mean: { $mean: '$.r[*]' } }) },
    { name: 'seed.data', kind: 'data', text: '{"r":[1,2,3]}' },
  ],
});
const VIEW = [{ match: '$', body: ['p', {}, 'n=', '$.n'] }];
const base = () => appProject({ n: 1 }, VIEW);

suite('assembleArtifacts — whole-document', () => {
  it('turns each runnable file into an artifact and skips state/data inputs', () => {
    const { artifacts, errors } = assembleArtifacts(base());
    assert.deepStrictEqual(errors, []);
    assert.deepStrictEqual(artifacts.map((a) => `${a.name}:${a.kind}:${a.role}`),
      ['app.json:app:application', 'top.query:query:query']);
    assert.deepStrictEqual(artifacts[0].sourceFiles, ['app.json']);
  });

  it('records a per-file error for an unparseable runnable file, without throwing', () => {
    const p = parseProject({ project: '0.1', files: [{ name: 'broken.query', kind: 'query', text: '{ nope' }] });
    const { artifacts, errors } = assembleArtifacts(p);
    assert.deepStrictEqual(artifacts, []);
    assert.strictEqual(errors.length, 1);
    assert.strictEqual(errors[0].file, 'broken.query');
  });

  it('the assembled app document renders its first frame headlessly (bootable)', () => {
    const app = assembleArtifacts(base()).artifacts.find((a) => a.kind === 'app');
    const vnode = compileJsltStylesheet(app.doc.view)(app.doc.state);
    assert.ok(Array.isArray(vnode), 'a vnode tree came out — no DOM needed');
  });
});

suite('classifyChange — reboot vs. hot-update', () => {
  it('a state-only edit is state-only; a view edit is structural; identical is none', () => {
    const start = base();
    assert.strictEqual(classifyChange(start, appProject({ n: 99 }, VIEW)).perArtifact['app.json'], 'state-only');
    assert.strictEqual(classifyChange(start, appProject({ n: 1 }, [{ match: '$', body: ['h1', {}, '$.n'] }])).perArtifact['app.json'], 'structural');
    assert.strictEqual(classifyChange(start, base()).perArtifact['app.json'], 'none');
  });

  it('overall is the worst per-artifact class', () => {
    assert.strictEqual(classifyChange(base(), appProject({ n: 2 }, VIEW)).overall, 'state-only');
    assert.strictEqual(classifyChange(base(), base()).overall, 'none');
  });

  it('a new artifact and a removed artifact are both structural', () => {
    const withExtra = parseProject({ project: '0.1', files: [
      { name: 'a.query', kind: 'query', text: '{"$for":{"it":"$[*]"},"$return":"$it"}' },
      { name: 'b.jslt', kind: 'jslt', text: '[]' }] });
    const withoutB = parseProject({ project: '0.1', files: [
      { name: 'a.query', kind: 'query', text: '{"$for":{"it":"$[*]"},"$return":"$it"}' }] });
    assert.strictEqual(classifyChange(withoutB, withExtra).perArtifact['b.jslt'], 'structural');
    assert.strictEqual(classifyChange(withExtra, withoutB).perArtifact['b.jslt'], 'structural');
  });

  it('a contentKey collision does not classify a changed artifact as unchanged', () => {
    // Two query documents that collide under the 32-bit contentKey
    // fingerprint (the pair pinned in test/core/content-key.test.js). A
    // classification decides reboot-vs-hot-update, so it must use the
    // collision-free semanticKey: this edit is 'structural', not 'none'.
    const colliding = [
      { $for: { it: '$[*]' }, $return: '5ln9p' },
      { $for: { it: '$[*]' }, $return: 'nbe0a' },
    ];
    assert.strictEqual(contentKey(colliding[0]), contentKey(colliding[1]), 'the fixture still collides');
    const q1 = parseProject({ project: '0.1', files: [{ name: 'q', kind: 'query', text: JSON.stringify(colliding[0]) }] });
    const q2 = parseProject({ project: '0.1', files: [{ name: 'q', kind: 'query', text: JSON.stringify(colliding[1]) }] });
    assert.strictEqual(classifyChange(q1, q2).perArtifact.q, 'structural');
    assert.strictEqual(classifyChange(q1, q2).overall, 'structural');
    // and the app path: a colliding STATE edit is still 'state-only', not 'none'
    const a1 = appProject(colliding[0], VIEW);
    const a2 = appProject(colliding[1], VIEW);
    assert.strictEqual(classifyChange(a1, a2).perArtifact['app.json'], 'state-only');
  });

  it('a non-app artifact change is structural (its whole document is structure)', () => {
    const q1 = parseProject({ project: '0.1', files: [{ name: 'q', kind: 'query', text: '{"a":"$.x"}' }] });
    const q2 = parseProject({ project: '0.1', files: [{ name: 'q', kind: 'query', text: '{"a":"$.y"}' }] });
    assert.strictEqual(classifyChange(q1, q2).perArtifact.q, 'structural');
  });

  it('a file kind change is structural even when its JSON is identical', () => {
    const project = (kind) => parseProject({ project: '0.1', files: [{ name: 'file', kind, text: '{}' }] });
    const schema = project('schema');
    const query = project('query');
    const expected = { overall: 'structural', perArtifact: { file: 'structural' } };
    assert.deepStrictEqual(classifyChange(schema, query), expected);
    assert.deepStrictEqual(classifyChange(query, schema), expected);
  });

  it('classifies a file named __proto__ as an own member throughout its lifecycle', () => {
    const empty = parseProject({ project: '0.1', files: [] });
    const project = (text) => parseProject({ project: '0.1', files: [{ name: '__proto__', kind: 'query', text }] });
    const first = project('{}');
    const edited = project('{"value":1}');
    for (const [before, after, change] of [
      [empty, first, 'structural'],
      [first, edited, 'structural'],
      [edited, edited, 'none'],
      [edited, empty, 'structural'],
    ]) {
      const result = classifyChange(before, after);
      assert.strictEqual(result.overall, change);
      assert.deepStrictEqual(result.perArtifact, Object.fromEntries([['__proto__', change]]));
      assert.strictEqual(Object.getPrototypeOf(result.perArtifact), Object.prototype);
    }
  });
});

suite('describe — the file-rail datum', () => {
  it('reports kind, role, validity and the artifact each file belongs to', () => {
    const d = describe(base());
    const byName = Object.fromEntries(d.files.map((f) => [f.name, f]));
    assert.strictEqual(byName['app.json'].role, 'application');
    assert.strictEqual(byName['app.json'].valid, true);
    assert.strictEqual(byName['app.json'].artifact, 'app.json');
    assert.strictEqual(byName['seed.data'].artifact, null, 'a data input is not its own artifact');
    assert.deepStrictEqual(d.layout, { mode: 'classic', ratio: 0.5, autorun: true });
  });

  it('surfaces a file kind error inline (the coded code the strip shows)', () => {
    const p = parseProject({ project: '0.1', files: [{ name: 'bad.query', kind: 'query', text: '{"x":{"$flter":"$"}}' }] });
    const bad = describe(p).files.find((f) => f.name === 'bad.query');
    assert.strictEqual(bad.valid, false);
    assert.strictEqual(bad.errors[0].code, 'JQ0002');
  });
});
