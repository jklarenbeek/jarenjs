import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createTypeTestCompiler } from '@jarenjs/validate/query';
import {
  compileJsltStylesheet,
  JsltCompileError,
} from '@jarenjs/json/jslt';

import {
  compileArtifact,
  deriveJsltDefs,
  downlevelDraft07,
  draftNeutralSubsetViolations,
} from './schema-artifact-helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemasDir = path.join(__dirname, '..', '..', 'packages', 'json', 'schemas');
const fixturesDir = path.join(__dirname, 'fixtures', 'jslt');

const canonicalQuery = JSON.parse(
  fs.readFileSync(path.join(schemasDir, 'jaren-query.schema.json'), 'utf8'));
const canonicalJslt = JSON.parse(
  fs.readFileSync(path.join(schemasDir, 'jaren-jslt.schema.json'), 'utf8'));
const draft07Jslt = JSON.parse(
  fs.readFileSync(path.join(schemasDir, 'jaren-jslt.draft-07.schema.json'), 'utf8'));

const validators = [
  ['draft 2020-12 (canonical)', compileArtifact(canonicalJslt)],
  ['draft-07 (twin)', compileArtifact(draft07Jslt)],
];
const compileTypeTest = createTypeTestCompiler();

function loadFixtures(kind) {
  const dir = path.join(fixturesDir, kind);
  return fs.readdirSync(dir)
    .filter(name => name.endsWith('.json'))
    .sort()
    .map(name => [
      name,
      JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')),
    ]);
}

describe('Jaren JSLT format schema artifacts', function () {
  it('keeps the canonical schema inside the draft-neutral subset', function () {
    assert.deepStrictEqual(draftNeutralSubsetViolations(canonicalJslt), []);
  });

  it('fails loudly when the pinned query-schema derivation contract changes', function () {
    assert.throws(
      () => deriveJsltDefs({}),
      /missing object \$defs/);
    assert.throws(
      () => deriveJsltDefs({ $defs: {} }),
      /missing \$defs\.expression/);
    assert.throws(
      () => deriveJsltDefs({ $defs: { expression: {}, objectExpression: {} } }),
      /objectExpression\.oneOf is not an array/);
    assert.throws(
      () => deriveJsltDefs({
        $defs: { expression: {}, objectExpression: { oneOf: [] }, applyPhrase: {} },
      }),
      /applyPhrase already exists/);
  });

  it('derives every embedded body definition from the canonical query artifact', function () {
    const derived = deriveJsltDefs(canonicalQuery);
    const actual = {};
    for (const key of Object.keys(derived))
      actual[key] = canonicalJslt.$defs[key];
    assert.deepStrictEqual(actual, derived);
  });

  it('derives the committed draft-07 twin from the canonical JSLT artifact', function () {
    assert.deepStrictEqual(
      downlevelDraft07(canonicalJslt),
      draft07Jslt,
      'jaren-jslt.draft-07.schema.json must equal downlevelDraft07(canonical)');
  });

  it('compiles under both drafts and agrees on a smoke stylesheet', function () {
    for (const [draft, validate] of validators) {
      assert.strictEqual(validate([]), true, `empty stylesheet under ${draft}`);
      assert.strictEqual(
        validate([{ body: { $nope: true } }]),
        false,
        `unknown body operator under ${draft}`);
    }
  });
});

describe('Jaren JSLT format fixtures', function () {
  describe('valid fixtures', function () {
    for (const [name, doc] of loadFixtures('valid')) {
      it(`accepts and compiles ${name}`, function () {
        for (const [draft, validate] of validators)
          assert.strictEqual(validate(doc), true, `${name} under ${draft}`);
        assert.doesNotThrow(() => {
          compileJsltStylesheet(doc, { compileTypeTest });
        });
      });
    }
  });

  describe('schema-invalid fixtures', function () {
    for (const [name, doc] of loadFixtures('invalid')) {
      if (name === 'apply-non-string-mode.json')
        continue;
      it(`rejects ${name} under both drafts and in the compiler`, function () {
        for (const [draft, validate] of validators)
          assert.strictEqual(validate(doc), false, `${name} under ${draft}`);
        assert.throws(
          () => compileJsltStylesheet(doc, { compileTypeTest }),
          JsltCompileError);
      });
    }
  });

  it('leaves the positional $apply mode type to the compiler', function () {
    const doc = loadFixtures('invalid')
      .find(([name]) => name === 'apply-non-string-mode.json')[1];
    for (const [draft, validate] of validators) {
      assert.strictEqual(
        validate(doc),
        true,
        `uniform draft-neutral items cannot distinguish selector from mode under ${draft}`);
    }
    assert.throws(
      () => compileJsltStylesheet(doc, { compileTypeTest }),
      (error) => error instanceof JsltCompileError
        && error.code === 'JT0007'
        && error.cause?.code === 'JQ0003');
  });
});
