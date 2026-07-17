import { describe, it } from 'node:test';
import * as assert from '../assert.node.js';

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  compileArtifact,
  downlevelDraft07,
  draftNeutralSubsetViolations,
} from './schema-artifact-helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemasDir = path.join(__dirname, '..', '..', 'packages', 'json', 'schemas');
const fixturesDir = path.join(__dirname, 'fixtures', 'query-format');

const canonicalSchema = JSON.parse(
  fs.readFileSync(path.join(schemasDir, 'jaren-query.schema.json'), 'utf8'));
const draft07Schema = JSON.parse(
  fs.readFileSync(path.join(schemasDir, 'jaren-query.draft-07.schema.json'), 'utf8'));

const validators = [
  ['draft 2020-12 (canonical)', compileArtifact(canonicalSchema)],
  ['draft-07 (twin)', compileArtifact(draft07Schema)],
];

function loadFixtures(kind) {
  const dir = path.join(fixturesDir, kind);
  return fs.readdirSync(dir)
    .filter(name => name.endsWith('.json'))
    .sort()
    .map(name => [name, JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))]);
}

describe('Jaren query format schema artifacts', function () {

  it('should keep the canonical schema inside the draft-neutral subset', function () {
    assert.deepEqual(draftNeutralSubsetViolations(canonicalSchema), []);
  });

  it('should derive the committed draft-07 twin from the canonical schema', function () {
    assert.deepEqual(downlevelDraft07(canonicalSchema), draft07Schema,
      'jaren-query.draft-07.schema.json must equal downlevelDraft07(canonical)');
  });

  it('should compile under both drafts and agree on a smoke document', function () {
    for (const [draft, validate] of validators) {
      assert.isTrue(validate('$.store.book[*].title'), `degenerate path under ${draft}`);
      assert.isFalse(validate({ '$nope': 1 }), `unknown operator under ${draft}`);
    }
  });
});

describe('Jaren query format fixtures', function () {

  describe('valid fixtures', function () {
    for (const [name, doc] of loadFixtures('valid')) {
      it(`should accept ${name} under both drafts`, function () {
        for (const [draft, validate] of validators) {
          assert.isTrue(validate(doc), `${name} must validate under ${draft}`);
        }
      });
    }
  });

  describe('invalid fixtures', function () {
    for (const [name, doc] of loadFixtures('invalid')) {
      it(`should reject ${name} under both drafts`, function () {
        for (const [draft, validate] of validators) {
          assert.isFalse(validate(doc), `${name} must fail under ${draft}`);
        }
      });
    }
  });
});
