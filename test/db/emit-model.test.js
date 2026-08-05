//@ts-check
/**
 * @file Entity types from models: the committed oracle regenerates
 * byte-identically (drift fails here, not at a consumer), the model
 * document carries what the design says — closed entity interfaces,
 * optional relation references, the DateTime brand on date-formatted
 * strings, input variants with defaulted members optional and
 * projections unwritable, the typed-store metadata — and the whole
 * build is deterministic and injection-based (db never imports emit).
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';

import { compileEmitModel } from '@jarenjs/emit';
import { typedStore } from '@jarenjs/db/typed';
import { renderTypeScript } from '@jarenjs/emit/typescript';
import { entityEmitModel } from '@jarenjs/db';

import { FIXTURE_MODEL } from './emit-model-fixture.js';

const build = () => entityEmitModel(FIXTURE_MODEL, {
  compile: compileEmitModel,
  source: 'test/db/emit-model-fixture.js',
});
const declarationOf = (model, name) =>
  model.declarations.find((declaration) => declaration.name === name);
const memberOf = (declaration, name) =>
  declaration.type.members.find((member) => member.name === name);

describe('the typed binding', () => {
  it('typedStore is the identity — every guarantee is type-level', () => {
    const store = { marker: true };
    assert.strictEqual(typedStore(store), store);
  });
});

describe('the committed oracle', () => {
  it('regenerates byte-identically from the fixture', () => {
    const committed = fs.readFileSync('test/consumer/db-generated.ts', 'utf8');
    const generated = renderTypeScript(build(), { banner: false });
    assert.ok(committed.endsWith(generated),
      'test/consumer/db-generated.ts drifted — run node scripts/generate-db-fixture.js');
  });

  it('is deterministic: two builds are the same document', () => {
    assert.strictEqual(JSON.stringify(build()), JSON.stringify(build()));
  });
});

describe('what the model document says', () => {
  const model = build();

  it('the compile hook is injected, never imported', async () => {
    assert.throws(() => entityEmitModel(FIXTURE_MODEL, /** @type {any} */ ({})),
      /compileEmitModel/);
    const source = await fs.promises.readFile('packages/db/src/emit-model.js', 'utf8');
    assert.strictEqual(/from '@jarenjs\/emit/.test(source), false,
      'db does not depend on emit; the generator script wires them');
  });

  it('entity interfaces are closed objects with typed members', () => {
    const user = declarationOf(model, 'User');
    assert.strictEqual(user.type.index, undefined,
      'closed: excess-property checking is the point');
    assert.deepStrictEqual(memberOf(user, 'email').type,
      { kind: 'primitive', primitive: 'string' });
    assert.strictEqual(memberOf(user, 'email').required, true);
  });

  it('relation members are optional references, detected through the seam', () => {
    const user = declarationOf(model, 'User');
    const posts = memberOf(user, 'posts');
    assert.deepStrictEqual(posts.type,
      { kind: 'array', items: { kind: 'ref', ref: 'Post' } });
    assert.strictEqual(posts.required, false);
    assert.deepStrictEqual(memberOf(declarationOf(model, 'Post'), 'author').type,
      { kind: 'ref', ref: 'User' });
  });

  it('date-formatted strings carry the DateTime brand; inputs take plain strings', () => {
    assert.deepStrictEqual(
      memberOf(declarationOf(model, 'User'), 'joined').type,
      { kind: 'ref', ref: 'DateTime' });
    assert.deepStrictEqual(
      memberOf(declarationOf(model, 'Post'), 'published').type,
      { kind: 'ref', ref: 'DateTime' });
    assert.deepStrictEqual(
      memberOf(declarationOf(model, 'UserInput'), 'joined').type,
      { kind: 'primitive', primitive: 'string' });
    assert.strictEqual(declarationOf(model, 'DateTime').type.kind, 'intersection');
  });

  it('input variants: defaulted members optional, projections unwritable', () => {
    const input = declarationOf(model, 'UserInput');
    assert.strictEqual(memberOf(input, 'id').required, false, 'uuid default');
    assert.strictEqual(memberOf(input, 'role').required, false, 'value default');
    assert.strictEqual(memberOf(input, 'email').required, true);
    assert.strictEqual(memberOf(input, 'posts'), undefined,
      'a one-to-many projection is not writable');
    const labels = memberOf(input, 'labels');
    assert.strictEqual(labels.required, false);
    assert.strictEqual(labels.type.kind, 'array');
    assert.strictEqual(labels.type.items.kind, 'union',
    'membership attaches by key or document');
    assert.strictEqual(
      memberOf(declarationOf(model, 'PostInput'), 'pid').required, false,
      'auto keys are allocated by the save');
  });

  it('the metadata map binds doc, input, key and relations per entity', () => {
    const meta = declarationOf(model, 'EntityMetaMap');
    const user = memberOf(meta, 'User').type;
    assert.deepStrictEqual(memberOf({ type: user }, 'key').type,
      { kind: 'primitive', primitive: 'string' });
    const relations = memberOf({ type: user }, 'relations').type;
    assert.deepStrictEqual(
      memberOf({ type: memberOf({ type: relations }, 'posts').type }, 'many').type,
      { kind: 'literal', value: true });
    const grade = memberOf(meta, 'Grade').type;
    assert.strictEqual(memberOf({ type: grade }, 'key').type.kind, 'object',
      'a composite key is its parts');
  });
});
