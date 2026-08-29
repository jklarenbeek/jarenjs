//@ts-check
/**
 * @file The derivation runner (`scripts/lib/derive.js`): one namespace,
 * one bake, several registries.
 *
 * What is asserted here is the MACHINERY, on throwaway fixtures, because
 * the failures the machinery has are the ones a green-looking run hides:
 *
 *  - a marker no registry answers must fail BOTH modes and rewrite
 *    nothing — a run that baked its way past one would print a success
 *    line over text still carrying last month's value;
 *  - two registries claiming one key must be refused, because two
 *    answers to one question is what this whole layer exists to prevent;
 *  - a marker that begins a line inside a paragraph bakes correctly and
 *    then disappears from every rendered page, so `bake` reports it and
 *    the runner treats the report as a failure.
 *
 * The registries themselves are gated beside their sources —
 * `benchmark-facts.test.js` for the measured figures, `pen-index.test.js`
 * for the binder's tables.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NS, runDerivation } from '../../scripts/lib/derive.js';

/** A throwaway root holding one document. */
function fixture(body, name = 'fixture.md') {
  const root = mkdtempSync(join(tmpdir(), 'jaren-derive-'));
  writeFileSync(join(root, name), body);
  return root;
}

/** A registry over one document, with the derivations given. */
const registry = (facts, docs = ['fixture.md'], name = 'fixture') =>
  ({ name, docs: () => docs, facts: () => facts });

const read = (root, name = 'fixture.md') => readFileSync(join(root, name), 'utf8');

describe('the namespace is one, and it is the one every document uses', () => {
  it('is spelled once, here', () => {
    assert.strictEqual(NS, 'fact');
  });
});

describe('a marker no registry answers fails both modes', () => {
  const source = `The figure is <!--${NS}:not.a.real.one-->0.0<!--/${NS}-->x today.\n`;

  it('refuses to rewrite, names the marker, and leaves the file alone', () => {
    const root = fixture(source);
    const report = runDerivation({ root, registries: [registry({})], check: false });
    assert.strictEqual(report.code, 1);
    assert.deepStrictEqual(report.rewritten, []);
    assert.strictEqual(report.unanswered.length, 1);
    assert.match(report.unanswered[0], /nothing derives 'not\.a\.real\.one'/);
    assert.strictEqual(read(root), source, 'nothing is written when one marker cannot be derived');
  });

  it('fails --check the same way', () => {
    assert.strictEqual(runDerivation({
      root: fixture(source), registries: [registry({})], check: true,
    }).code, 1);
  });

  it('reports a derivation that throws rather than baking around it', () => {
    const root = fixture(`The figure is <!--${NS}:boom-->1<!--/${NS}-->x today.\n`);
    const report = runDerivation({
      root,
      registries: [registry({ boom: () => { throw new Error('the suite was never regenerated'); } })],
      check: false,
    });
    assert.strictEqual(report.code, 1);
    assert.match(report.unanswered.join('\n'), /boom: resolver threw — the suite was never regenerated/);
    assert.deepStrictEqual(report.seen, [], 'a derivation that threw is not counted as resolved');
  });
});

describe('two registries cannot claim one key', () => {
  // The failure mode that made one namespace worth having in the first
  // place: two answers to one question, committed, neither wrong on its
  // own. Across separate namespaces this was undetectable.
  it('is refused, naming both', () => {
    const root = fixture(`a <!--${NS}:shared-->1<!--/${NS}--> b\n`);
    assert.throws(() => runDerivation({
      root,
      registries: [registry({ shared: () => '1' }, ['fixture.md'], 'first'),
        registry({ shared: () => '2' }, ['fixture.md'], 'second')],
    }), /two registries derive 'shared': first and second/);
  });
});

describe('the bake is idempotent, and drift is repairable', () => {
  it('writes a moved value once and then changes nothing', () => {
    const root = fixture(`The figure is <!--${NS}:ok-->0.0<!--/${NS}-->x today.\n`);
    const first = runDerivation({ root, registries: [registry({ ok: () => '7.5' })] });
    assert.strictEqual(first.code, 0);
    assert.deepStrictEqual(first.rewritten, ['fixture.md']);
    assert.match(read(root), new RegExp(`<!--${NS}:ok-->7\\.5<!--/${NS}-->`));
    const second = runDerivation({ root, registries: [registry({ ok: () => '7.5' })] });
    assert.deepStrictEqual(second.rewritten, [], 'the bake is idempotent');
    assert.strictEqual(second.passes, 1, 'a settled tree needs one pass');
  });

  it('reports the drift it would repair, and --check repairs nothing', () => {
    const root = fixture(`The figure is <!--${NS}:ok-->0.0<!--/${NS}-->x today.\n`);
    const before = read(root);
    const report = runDerivation({ root, registries: [registry({ ok: () => '7.5' })], check: true });
    assert.strictEqual(report.code, 1);
    assert.strictEqual(report.drift.length, 1);
    assert.match(report.drift[0], /fixture\.md: ok/);
    assert.strictEqual(read(root), before);
  });

  it('a derivation no document carries is unused, and only --check fails on it', () => {
    const root = fixture('nothing derived here\n');
    const write = runDerivation({ root, registries: [registry({ orphan: () => 'x' })] });
    assert.strictEqual(write.code, 0);
    assert.deepStrictEqual(write.unused, ['orphan']);
    assert.strictEqual(runDerivation({
      root, registries: [registry({ orphan: () => 'x' })], check: true,
    }).code, 1);
  });
});

describe('a marker that begins a line is reported, not silently swallowed', () => {
  // A marker at the start of a line inside a paragraph opens a CommonMark
  // HTML block, which swallows the rest of that line: the bytes bake
  // correctly, the file looks right, and every renderer drops the
  // sentence. It is the one failure of this layer a diff cannot show.
  it('counts as unanswered, so nothing is written', () => {
    const source = `A sentence with a derived count\n<!--${NS}:n-->1<!--/${NS}--> of them in it.\n`;
    const root = fixture(source);
    const report = runDerivation({ root, registries: [registry({ n: () => '2' })] });
    assert.strictEqual(report.code, 1);
    assert.deepStrictEqual(report.rewritten, []);
    assert.match(report.unanswered.join('\n'), /starts a line opens an HTML block/);
    assert.strictEqual(read(root), source);
  });

  it('and the same marker with text before it bakes cleanly', () => {
    const root = fixture(`A sentence with <!--${NS}:n-->1<!--/${NS}--> of them in it.\n`);
    const report = runDerivation({ root, registries: [registry({ n: () => '2' })] });
    assert.strictEqual(report.code, 0);
    assert.deepStrictEqual(report.unanswered, []);
  });
});

describe('a derivation that reads its own output settles', () => {
  // The pen index states every document's line count and the binder is
  // one of those documents, so one pass is not enough and an unbounded
  // loop is not acceptable. Digits do not change a line count, so pass
  // two settles.
  it('bakes to a fixed point rather than once', () => {
    const root = fixture(`x\n<!--${NS}:lines-->\n0\n<!--/${NS}-->\n`);
    const facts = { lines: () => `\n${read(root).split('\n').length - 1}\n` };
    const report = runDerivation({ root, registries: [registry(facts)] });
    assert.strictEqual(report.code, 0);
    assert.ok(report.passes >= 1 && report.passes <= 4, `${report.passes} passes`);
    assert.strictEqual(runDerivation({ root, registries: [registry(facts)], check: true }).code, 0,
      'the settled tree is current');
  });

  it('raises rather than writing when a derivation never settles', () => {
    const root = fixture(`a <!--${NS}:tick-->0<!--/${NS}--> b\n`);
    let n = 0;
    assert.throws(() => runDerivation({ root, registries: [registry({ tick: () => String(++n) })] }),
      /did not settle in 4 bake passes/);
  });
});
