//@ts-check

/**
 * Dynamic Reference Resolution Module
 * 
 * This module handles $recursiveRef (draft 2019-09) and $dynamicRef (draft 2020-12)
 * which require runtime resolution based on dynamic scope.
 * 
 * Key concepts:
 * - $recursiveRef: References the outermost schema resource with $recursiveAnchor: true
 * - $dynamicRef: References the outermost schema resource with matching $dynamicAnchor
 * 
 * Unlike regular $ref, these require runtime resolution because the target depends
 * on the dynamic context where the schema is used.
 */

import { isObjectClass, isStringType } from '@jarenjs/core';
import {
  TRAVERSE_SCHEMA_OBJECTS,
  TRAVERSE_SCHEMA_MAPS,
  TRAVERSE_SCHEMA_MAP_MAPS,
  detectSchemaDraft,
  admitsPropertyDependencies,
} from './schema-keywords.js';

/**
 * Whether a dynamic reference is a keyword at a schema location:
 * `$recursiveRef` is one in draft 2019-09 only, `$dynamicRef` from 2020-12
 * on. A document that declares another draft reads it as an unknown
 * keyword, which applies nothing; one that declares none reads both.
 * @param {'$recursiveRef'|'$dynamicRef'} keyword
 * @param {number|null|undefined} declaredDraft - The draft the location's document declares, or null when it declares none
 * @returns {boolean}
 */
export function admitsDynamicReference(keyword, declaredDraft) {
  if (declaredDraft == null) return true;
  return keyword === '$recursiveRef' ? declaredDraft === 2019 : declaredDraft >= 2020;
}

/**
 * Whether a schema object's `$schema` names a draft this package reads by
 * name. Another dialect (a vocabulary metaschema, OpenAPI 3.1's) is read as
 * draft-07 by the declared-draft gates, but its dynamic references are read
 * as in a document that declares no draft.
 * @param {{ $schema: string }} schema
 * @returns {boolean}
 */
export function namesKnownDraft(schema) {
  return detectSchemaDraft(schema) !== 7 || /draft[-/]07/.test(schema.$schema);
}

/**
 * Check if a schema has $recursiveAnchor: true.
 * @param {object} schema - The schema object
 * @returns {boolean}
 */
export function hasRecursiveAnchor(schema) {
  return isObjectClass(schema) && schema.$recursiveAnchor === true;
}

/**
 * Get the $dynamicAnchor name from a schema, spelled as a URI fragment
 * spells it (`a b` is `a%20b`): the dynamic scope is keyed, and a
 * `$dynamicRef`'s fragment compared, in the spelling the schema map keys
 * an anchor by.
 * @param {object} schema - The schema object
 * @returns {string|null}
 */
export function getDynamicAnchorName(schema) {
  if (!isObjectClass(schema)) return null;
  return isStringType(schema.$dynamicAnchor) ? new URL(`#${schema.$dynamicAnchor}`, FRAGMENT_BASE).hash.slice(1) : null;
}

/** Any base: a fragment's spelling does not depend on it. */
const FRAGMENT_BASE = 'urn:x:';

/**
 * Collect ALL dynamic anchors of a schema RESOURCE: every $dynamicAnchor
 * reachable from the given schema without crossing into an embedded
 * resource (a subschema that declares its own $id).
 *
 * Per draft 2020-12, entering a schema resource during evaluation brings
 * every $dynamicAnchor of that resource into the dynamic scope - wherever
 * it sits ($defs, allOf branches, properties, ...), not just at the root.
 *
 * @param {object} schema - The resource root schema object
 * @returns {Array<{name: string, schema: object, validator: (function|null)}>}
 */
export function collectDynamicAnchorsDeep(schema, propertyDependencies = false, declaredDraft = null) {
  const anchors = [];
  if (!isObjectClass(schema)) return anchors;

  const seen = new Set();
  const queue = [{ node: schema, isRoot: true, draft: declaredDraft }];
  while (queue.length > 0) {
    const { node, isRoot, draft: inheritedDraft } = queue.shift();
    if (!isObjectClass(node) && !Array.isArray(node)) continue;
    if (seen.has(node)) continue;
    seen.add(node);
    // The draft a document declares is inherited by everything below it.
    const draft = isStringType(node.$schema) ? detectSchemaDraft(node) : inheritedDraft;

    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; ++i) {
        queue.push({ node: node[i], isRoot: false, draft });
      }
      continue;
    }

    // A nested $id starts a new (embedded) resource - its anchors enter
    // the dynamic scope only when that resource itself is entered.
    if (!isRoot && isStringType(node.$id)) continue;

    const anchorName = getDynamicAnchorName(node);
    if (anchorName) {
      anchors.push({ name: anchorName, schema: node, validator: null });
    }

    for (const key of Object.keys(node)) {
      if (TRAVERSE_SCHEMA_OBJECTS.includes(key))
        queue.push({ node: node[key], isRoot: false, draft });
      else if (TRAVERSE_SCHEMA_MAPS.includes(key) && isObjectClass(node[key])) {
        for (const child of Object.values(node[key]))
          queue.push({ node: child, isRoot: false, draft });
      }
      else if (TRAVERSE_SCHEMA_MAP_MAPS.includes(key) && admitsPropertyDependencies(propertyDependencies, draft) && isObjectClass(node[key])) {
        for (const inner of Object.values(node[key])) {
          if (!isObjectClass(inner)) continue;
          for (const child of Object.values(inner))
            queue.push({ node: child, isRoot: false, draft });
        }
      }
    }
  }

  return anchors;
}

/**
 * Collect all dynamic anchors from a schema's immediate definitions ($defs/definitions).
 * This is used to find all $dynamicAnchor definitions that should be in scope
 * when following a $ref from this schema.
 *
 * IMPORTANT: This only collects from the IMMEDIATE $defs of the given schema,
 * not recursively.
 *
 * @param {object} schema - The schema object
 * @returns {Array<{name: string, schema: object}>} Array of {name, schema} objects
 */
export function collectDynamicAnchors(schema) {
  const anchors = [];
  if (!isObjectClass(schema)) return anchors;

  // Check $defs first (draft 2020-12), then definitions (draft 7 and earlier)
  const defs = schema.$defs || schema.definitions;
  if (isObjectClass(defs)) {
    for (const key of Object.keys(defs)) {
      const def = defs[key];
      if (isObjectClass(def)) {
        // Check if this definition has a $dynamicAnchor
        const anchorName = getDynamicAnchorName(def);
        if (anchorName) {
          anchors.push({ name: anchorName, schema: def, key });
        }
        // Note: We do NOT recurse into nested $defs here.
        // Dynamic anchors from nested $defs of a $ref target should NOT be
        // automatically in scope - they should only be registered when that
        // schema is actually evaluated.
      }
    }
  }

  return anchors;
}
