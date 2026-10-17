//@ts-check
/**
 * @file A reference is typed by the target the validator reaches: the
 * draft-04 `id` names a schema object only where no known draft is declared,
 * a plain name is matched as the URI spells it, and one spelled as a JSON
 * Pointer names nothing.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { emitTypeScript } from '@jarenjs/emit/typescript';

const D04 = 'http://json-schema.org/draft-04/schema#';
const D07 = 'http://json-schema.org/draft-07/schema#';
const D20 = 'https://json-schema.org/draft/2020-12/schema';

/** The member `y` of the emitted root type. @param {any} schema */
const memberY = (schema) => /y\?: ([^;]+);/.exec(emitTypeScript(schema))?.[1];

describe('emit — the draft-04 id and a plain name\'s spelling', () => {
  it('types a member by an id target where no known draft is declared, and as unknown under draft-07', () => {
    const named = { definitions: { a: { id: '#foo', type: 'integer' } }, properties: { y: { $ref: '#foo' } } };
    assert.equal(memberY(named), 'A');
    assert.equal(memberY({ $schema: D04, ...named }), 'A');
    assert.equal(memberY({ $schema: D07, ...named }), 'unknown');
  });

  it('matches an $anchor as the URI spells it', () => {
    /** @param {string} anchor @param {string} ref */
    const named = (anchor, ref) => ({ $schema: D20, $defs: { a: { $anchor: anchor, type: 'integer' } }, properties: { y: { $ref: ref } } });
    assert.equal(memberY(named('a%20b', '#a%20b')), 'A');
    assert.equal(memberY(named('a%20b', '#a b')), 'A');
    assert.equal(memberY(named('A', '#%41')), 'unknown');
  });

  it('reads a pointer-shaped anchor as no name, and a $dynamicAnchor as one', () => {
    assert.equal(memberY({ $schema: D20, $defs: { a: { $anchor: '/$defs/b', type: 'integer' }, b: { type: 'boolean' } }, properties: { y: { $ref: '#/$defs/b' } } }), 'B');
    assert.equal(memberY({ $schema: D20, $defs: { a: { $dynamicAnchor: 'x', type: 'integer' } }, properties: { y: { $ref: '#x' } } }), 'A');
  });
});
