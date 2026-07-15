import { describe, it } from 'node:test';
import * as assert from '../assert.node.js';

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  JarenValidator,
} from '@jarenjs/validate';

import * as formats from '@jarenjs/formats';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemasDir = path.join(__dirname, '..', '..', 'packages', 'json', 'schemas');
const fixturesDir = path.join(__dirname, 'fixtures', 'query-format');

const canonicalSchema = JSON.parse(
  fs.readFileSync(path.join(schemasDir, 'jaren-query.schema.json'), 'utf8'));
const draft07Schema = JSON.parse(
  fs.readFileSync(path.join(schemasDir, 'jaren-query.draft-07.schema.json'), 'utf8'));

// Compile one validator per draft artifact. Format assertion is forced on so
// the 'json-path' format asserts identically under both drafts (from draft
// 2020-12 on, format is annotation-only by default).
function compileArtifact(schema) {
  const compiler = new JarenValidator({ formatAssertion: true });
  compiler.addFormats(formats.jsonFormats);
  return compiler.compile(schema);
}

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

/**
 * The documented mechanical downlevel transform (QUERY-FORMAT.md §12.1):
 * swap $schema, rename $defs to definitions, rewrite '#/$defs/' ref targets,
 * suffix the $id with '/draft-07'. Everything else is untouched - that is
 * the point of the draft-neutral keyword subset.
 */
function downlevelDraft07(schema) {
  function walk(node) {
    if (Array.isArray(node)) return node.map(walk);
    if (node === null || typeof node !== 'object') return node;
    const out = {};
    for (const key of Object.keys(node)) {
      const target = key === '$defs' ? 'definitions' : key;
      const value = node[key];
      out[target] = (key === '$ref' && typeof value === 'string')
        ? value.replace('#/$defs/', '#/definitions/')
        : walk(value);
    }
    return out;
  }
  const twin = walk(schema);
  twin.$schema = 'http://json-schema.org/draft-07/schema#';
  twin.$id = schema.$id + '/draft-07';
  return twin;
}

describe('Jaren query format schema artifacts', function () {

  it('should keep the canonical schema inside the draft-neutral subset', function () {
    const forbiddenKeys = [
      'unevaluatedProperties', 'unevaluatedItems',
      '$dynamicRef', '$dynamicAnchor', '$recursiveRef', '$recursiveAnchor',
      'prefixItems', 'definitions',
    ];
    function walk(node, pointer) {
      if (Array.isArray(node)) {
        node.forEach((item, i) => walk(item, `${pointer}/${i}`));
        return;
      }
      if (node === null || typeof node !== 'object') return;
      const keys = Object.keys(node);
      for (const key of forbiddenKeys) {
        assert.isFalse(keys.includes(key), `forbidden keyword '${key}' at ${pointer}`);
      }
      if (keys.includes('$ref') && pointer !== '') {
        assert.deepEqual(keys, ['$ref'], `'$ref' with siblings at ${pointer}`);
      }
      if (keys.includes('items')) {
        assert.isFalse(Array.isArray(node.items), `array-form 'items' at ${pointer}`);
      }
      // '$defs' maps and 'properties' maps hold schema names, not keywords;
      // their values are schemas again, so plain recursion is correct here.
      for (const key of keys) {
        walk(node[key], `${pointer}/${key}`);
      }
    }
    walk(canonicalSchema, '');
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
