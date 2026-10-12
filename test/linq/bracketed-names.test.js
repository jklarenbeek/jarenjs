//@ts-check
/**
 * @file A member name that needs a bracketed selector comes back as itself.
 * The capture spells a name holding a quote, a backslash or a control
 * character as an escaped RFC 9535 name selector (`['a\n']`); the two places
 * that read such a path back — a patch path lowered to a JSON Pointer and an
 * `include()` pick resolved against the relation table — decoded `\n` as the
 * letter `n`, so a write or a load named a member the caller never wrote.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { replace, add, remove } from '@jarenjs/linq/app';
import { open } from '@jarenjs/linq/db';
import * as m from '@jarenjs/linq/model';
import { nodeDriver } from '@jarenjs/db/node';

const escapePointer = (/** @type {string} */ name) => name.replaceAll('~', '~0').replaceAll('/', '~1');

/** Names that cannot be a dotted shorthand: each control character, and the characters the escape itself uses. */
const NAMES = [
  ...Array.from({ length: 32 }, (_, code) => `a${String.fromCharCode(code)}b`),
  "it's", 'back\\slash', 'both\\\'', 'tilde~slash/', 'tab\tand\nnewline', '\\n', '\\u0001', 'é ', '😀 x',
];

describe('a patch path round-trips the member names it is written from', () => {
  it('every control character, quote and backslash reaches the pointer as itself', () => {
    for (const name of NAMES) {
      assert.strictEqual(replace((/** @type {any} */ c) => c.get(name), 1).path, `/${escapePointer(name)}`, JSON.stringify(name));
      assert.strictEqual(add((/** @type {any} */ c) => c.list.get(name).get('x'), 1).path,
        `/list/${escapePointer(name)}/x`, JSON.stringify(name));
      assert.strictEqual(remove((/** @type {any} */ c) => c.get(name)).path, `/${escapePointer(name)}`, JSON.stringify(name));
    }
  });
});

describe('an include pick finds the relation it names', () => {
  const relations = Object.fromEntries(NAMES.map((name) => [name, m.rel.hasMany('Post', { via: 'authorId', onDelete: 'cascade' })]));
  const User = m.object({ id: m.integer().key(), ...relations });
  const Post = m.object({ pid: m.integer().key(), authorId: m.integer() });

  it('a relation named with a control character, a quote or a backslash loads under that name', async () => {
    const client = await open(m.defineModel({ entities: { User, Post } }), { driver: nodeDriver(), validator: null });
    try {
      for (const name of NAMES) {
        assert.deepStrictEqual(client.entities.User.include((/** @type {any} */ u) => u.get(name)).toSpec(),
          { include: { [name]: true } }, JSON.stringify(name));
      }
    }
    finally { await client.close(); }
  });
});
