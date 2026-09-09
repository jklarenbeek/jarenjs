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
import { TRAVERSE_SCHEMA_OBJECTS, TRAVERSE_SCHEMA_MAPS } from './schema-keywords.js';

/**
 * Check if a schema has $recursiveAnchor: true.
 * @param {object} schema - The schema object
 * @returns {boolean}
 */
export function hasRecursiveAnchor(schema) {
  return isObjectClass(schema) && schema.$recursiveAnchor === true;
}

/**
 * Get the $dynamicAnchor name from a schema.
 * @param {object} schema - The schema object
 * @returns {string|null}
 */
export function getDynamicAnchorName(schema) {
  if (!isObjectClass(schema)) return null;
  return isStringType(schema.$dynamicAnchor) ? schema.$dynamicAnchor : null;
}

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
export function collectDynamicAnchorsDeep(schema) {
  const anchors = [];
  if (!isObjectClass(schema)) return anchors;

  const seen = new Set();
  const queue = [{ node: schema, isRoot: true }];
  while (queue.length > 0) {
    const { node, isRoot } = queue.shift();
    if (!isObjectClass(node) && !Array.isArray(node)) continue;
    if (seen.has(node)) continue;
    seen.add(node);

    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; ++i) {
        queue.push({ node: node[i], isRoot: false });
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
        queue.push({ node: node[key], isRoot: false });
      else if (TRAVERSE_SCHEMA_MAPS.includes(key) && isObjectClass(node[key])) {
        for (const child of Object.values(node[key]))
          queue.push({ node: child, isRoot: false });
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
