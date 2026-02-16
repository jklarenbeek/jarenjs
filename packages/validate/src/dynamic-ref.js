//@ts-check

/**
 * Dynamic Reference Resolution Module
 * 
 * This module handles $recursiveRef (draft 2019-09) and $dynamicRef (draft 2020-12)
 * which require runtime resolution based on dynamic scope.
 * 
 * Key concepts:
 * - $recursiveRef: References the nearest parent schema with $recursiveAnchor: true
 * - $dynamicRef: References the nearest parent schema with matching $dynamicAnchor
 * 
 * Unlike regular $ref, these require runtime resolution because the target depends
 * on the dynamic context where the schema is used.
 */

import { isObjectClass, isStringType } from '@jarenjs/core';

/**
 * DynamicScope tracks the dynamic scope during validation.
 * It maintains stacks of schemas with $recursiveAnchor and $dynamicAnchor.
 */
export class DynamicScope {
  /** @type {Array<{schema: object, path: string}>} Stack of schemas with $recursiveAnchor: true */
  #recursiveAnchors = [];
  
  /** @type {Map<string, Array<{schema: object, path: string}>>} Map of anchor name to stack of schemas with that $dynamicAnchor */
  #dynamicAnchors = new Map();

  constructor() {
    this.#recursiveAnchors = [];
    this.#dynamicAnchors = new Map();
  }

  /**
   * Push a schema onto the dynamic scope if it has a dynamic anchor.
   * Call this when entering a schema during validation.
   * @param {object} schema - The schema object
   * @param {string} path - The schema path/URI
   */
  push(schema, path) {
    if (!isObjectClass(schema)) return;

    // Check for $recursiveAnchor: true (draft 2019-09)
    if (schema.$recursiveAnchor === true) {
      this.#recursiveAnchors.push({ schema, path });
    }

    // Check for $dynamicAnchor (draft 2020-12)
    if (isStringType(schema.$dynamicAnchor)) {
      const anchorName = schema.$dynamicAnchor;
      if (!this.#dynamicAnchors.has(anchorName)) {
        this.#dynamicAnchors.set(anchorName, []);
      }
      this.#dynamicAnchors.get(anchorName).push({ schema, path });
    }
  }

  /**
   * Pop a schema from the dynamic scope.
   * Call this when exiting a schema during validation.
   * @param {object} schema - The schema object
   */
  pop(schema) {
    if (!isObjectClass(schema)) return;

    // Pop $recursiveAnchor if present
    if (schema.$recursiveAnchor === true && this.#recursiveAnchors.length > 0) {
      this.#recursiveAnchors.pop();
    }

    // Pop $dynamicAnchor if present
    if (isStringType(schema.$dynamicAnchor)) {
      const anchorName = schema.$dynamicAnchor;
      const stack = this.#dynamicAnchors.get(anchorName);
      if (stack && stack.length > 0) {
        stack.pop();
      }
    }
  }

  /**
   * Get the current $recursiveAnchor target (nearest parent with $recursiveAnchor: true).
   * Returns null if no $recursiveAnchor is in scope.
   * @returns {{schema: object, path: string}|null}
   */
  getRecursiveAnchorTarget() {
    if (this.#recursiveAnchors.length === 0) return null;
    return this.#recursiveAnchors[this.#recursiveAnchors.length - 1];
  }

  /**
   * Get the current $dynamicAnchor target for the given anchor name.
   * Returns null if no matching $dynamicAnchor is in scope.
   * @param {string} anchorName - The dynamic anchor name
   * @returns {{schema: object, path: string}|null}
   */
  getDynamicAnchorTarget(anchorName) {
    const stack = this.#dynamicAnchors.get(anchorName);
    if (!stack || stack.length === 0) return null;
    return stack[stack.length - 1];
  }

  /**
   * Check if a $recursiveAnchor is currently in scope.
   * @returns {boolean}
   */
  hasRecursiveAnchor() {
    return this.#recursiveAnchors.length > 0;
  }

  /**
   * Check if a $dynamicAnchor with the given name is currently in scope.
   * @param {string} anchorName - The dynamic anchor name
   * @returns {boolean}
   */
  hasDynamicAnchor(anchorName) {
    const stack = this.#dynamicAnchors.get(anchorName);
    return stack && stack.length > 0;
  }
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
 * Check if a schema has $dynamicAnchor.
 * @param {object} schema - The schema object
 * @returns {boolean}
 */
export function hasDynamicAnchor(schema) {
  return isObjectClass(schema) && isStringType(schema.$dynamicAnchor);
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
 * Collect all dynamic anchors from a schema's immediate definitions ($defs/definitions).
 * This is used to find all $dynamicAnchor definitions that should be in scope
 * when following a $ref from this schema.
 * 
 * IMPORTANT: This only collects from the IMMEDIATE $defs of the given schema,
 * not recursively. The dynamic scope should only include anchors from schemas
 * that are "siblings" to the $ref target in the $defs, not from nested $defs
 * of the target schema itself.
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
