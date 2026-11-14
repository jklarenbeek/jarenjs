//@ts-check
/**
 * @file Every node of every authoring profile declares its JSON kind. A
 * provider's structured output may refuse a schema member without `type`
 * ("Schema type is missing"), so one untyped member makes the whole
 * profile unusable as a response format there. A node passes when it
 * carries `type`, or a `$ref`, `const` or `enum` that pins its kind, or
 * is an `anyOf`/`oneOf` union whose every branch passes (the union's kinds
 * are its branches'; a `type` beside it would make a strict derivation read
 * the branches as members of an object and refuse it, `JK0103`). The
 * branch's schema for a member its enclosing object already declares with
 * a kind passes too: it narrows that typed member (a second typed schema
 * for one member is what a strict derivation refuses, `JK0103`). The
 * boolean subschema `false` admits nothing and passes (`additionalProperties:
 * false` is what strict modes ask for); `true` admits anything unsaid and fails. The walk follows every subschema position
 * (`@jarenjs/core/schema`'s keyword lists, plus `$defs`).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { SCHEMA_VALUE_KEYWORDS, SCHEMA_MAP_KEYWORDS, SCHEMA_LIST_KEYWORDS } from '@jarenjs/core/schema';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** Every authoring profile the packages and components publish. */
function authoringProfiles() {
  const found = [];
  for (const area of ['packages', 'components']) {
    for (const name of readdirSync(join(ROOT, area))) {
      let files = [];
      try { files = readdirSync(join(ROOT, area, name, 'schemas')); }
      catch { continue; }
      for (const file of files) if (file.endsWith('.authoring.schema.json')) found.push(`${area}/${name}/schemas/${file}`);
    }
  }
  return found.sort();
}

/**
 * The pointers of the schema nodes that pin no JSON kind.
 * @param {unknown} schema
 * @returns {string[]}
 */
/** @param {any} node */
function pins(node) {
  if (node === false) return true;
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return false;
  if (node.type !== undefined || typeof node.$ref === 'string' || Object.hasOwn(node, 'const') || Array.isArray(node.enum)) return true;
  return ['anyOf', 'oneOf'].some((key) => Array.isArray(node[key]) && node[key].length > 0 && node[key].every(pins));
}

export function untypedNodes(schema) {
  /** @type {string[]} */
  const out = [];
  const SAME_INSTANCE = new Set(['not', 'if', 'then', 'else', 'allOf', 'anyOf', 'oneOf', 'dependentSchemas']);
  /**
   * @param {any} node
   * @param {string} at
   * @param {Set<string>} declared - members the enclosing object types, for a same-instance branch
   * @param {boolean} narrows - the node is a branch's schema for a member already typed
   */
  const visit = (node, at, declared, narrows) => {
    if (node === true) { out.push(at); return; }
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return;
    if (!narrows && !pins(node)) out.push(at);
    const own = new Set(declared);
    if (node.properties !== null && typeof node.properties === 'object') {
      for (const [name, member] of Object.entries(node.properties)) if (pins(member)) own.add(name);
    }
    const branch = (/** @type {string} */ key) => SAME_INSTANCE.has(key) ? own : new Set();
    for (const key of SCHEMA_VALUE_KEYWORDS) if (Object.hasOwn(node, key)) visit(node[key], `${at}/${key}`, branch(key), false);
    for (const key of [...SCHEMA_MAP_KEYWORDS, '$defs']) {
      if (node[key] !== null && typeof node[key] === 'object') {
        for (const [name, member] of Object.entries(node[key])) {
          visit(member, `${at}/${key}/${name}`, branch(key), key === 'properties' && declared.has(name));
        }
      }
    }
    for (const key of SCHEMA_LIST_KEYWORDS) {
      if (Array.isArray(node[key])) node[key].forEach((member, i) => visit(member, `${at}/${key}/${i}`, branch(key), false));
    }
  };
  visit(schema, '', new Set(), false);
  return out;
}

describe('authoring profiles declare a type on every node', () => {
  const profiles = authoringProfiles();

  it('finds the published profiles', () => {
    assert.ok(profiles.length >= 8, profiles.join(', '));
  });

  for (const path of profiles) {
    it(path, () => {
      const schema = JSON.parse(readFileSync(join(ROOT, path), 'utf8'));
      assert.deepEqual(untypedNodes(schema), []);
    });
  }

  it('the walk reports what it should', () => {
    assert.deepEqual(untypedNodes({
      type: 'object',
      properties: { a: { description: 'any' }, b: { $ref: '#/$defs/x' }, c: { const: 1 }, d: { enum: [1] } },
      allOf: [{ not: { required: ['a'] } }],
      anyOf: [{ type: 'object', properties: { c: { minimum: 0 } } }, { $ref: '#/$defs/x' }],
      oneOf: [{ type: 'object' }, { description: 'untyped' }],
      additionalProperties: false,
      $defs: { x: { type: 'string' }, y: true },
    }), ['/properties/a', '/$defs/y', '/allOf/0', '/allOf/0/not', '/oneOf/1']);
  });
});
