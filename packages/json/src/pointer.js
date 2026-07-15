import {
  isObjectClass,
  isStringType,
  isNumberType,
  isArrayClass,
  isObjectType,
} from '@jarenjs/core';

/**
 * Parse a JSON Pointer and return the path segments
 * @param {string} pointer - The JSON Pointer string (e.g., "/A/B")
 * @returns {string[]} Array of decoded path segments
 */
export function parseJsonPointer(pointer) {
  if (!pointer || pointer === '') {
    return [];
  }

  // JSON Pointer must start with /
  if (!pointer.startsWith('/')) {
    throw new Error(`Invalid JSON Pointer: '${pointer}' - must start with '/'`);
  }

  // Split by / and decode each segment
  // ~0 is decoded to ~ and ~1 is decoded to /
  return pointer.slice(1).split('/').map(segment =>
    segment.replace(/~1/g, '/').replace(/~0/g, '~')
  );
}

/**
 * Parse a relative JSON Pointer
 * Format: <non-negative-integer>("#"|<json-pointer>)
 * @param {string} pointer - The relative JSON Pointer (e.g., "0/A", "1/B", "0#")
 * @returns {{ levels: number, pointer: string, hash: boolean }} Parsed result
 */
export function parseRelativeJsonPointer(pointer) {
  if (!pointer || pointer === '') {
    throw new Error('Invalid relative JSON Pointer: empty string');
  }

  // Extract the number at the beginning
  const match = pointer.match(/^(\d+)(.*)$/);
  if (!match) {
    throw new Error(`Invalid relative JSON Pointer: '${pointer}' - must start with a number`);
  }

  const levels = parseInt(match[1], 10);
  const rest = match[2];

  // Check if it ends with # (reference to property name)
  if (rest === '#') {
    return { levels, pointer: '', hash: true };
  }

  // Otherwise it should be a JSON Pointer starting with /
  if (rest === '' || rest.startsWith('/')) {
    return { levels, pointer: rest, hash: false };
  }

  throw new Error(`Invalid relative JSON Pointer: '${pointer}'`);
}

/**
 * Get a value from data using a JSON Pointer path
 * @param {any} dataRoot - The root data object
 * @param {string} dataPath - The current data path (for relative pointer resolution)
 * @param {string} pointer - The JSON Pointer
 * @returns {{ value: any, found: boolean }} The resolved value and whether it was found
 */
export function getValueByJsonPointer(dataRoot, dataPath, pointer) {
  try {
    const segments = parseJsonPointer(pointer);
    let current = dataRoot;

    for (const segment of segments) {
      if (current === null || current === undefined) {
        return { value: undefined, found: false };
      }

      if (isArrayClass(current)) {
        const index = parseInt(segment, 10);
        if (isNaN(index) || index < 0 || index >= current.length) {
          return { value: undefined, found: false };
        }
        current = current[index];
      } else if (typeof current === 'object') {
        if (!(segment in current)) {
          return { value: undefined, found: false };
        }
        current = current[segment];
      } else {
        return { value: undefined, found: false };
      }
    }

    return { value: current, found: true };
  } catch (e) {
    return { value: undefined, found: false };
  }
}

/**
 * Get a value from data using a relative JSON Pointer
 * @param {any} dataRoot - The root data object
 * @param {string} dataPath - The current data path (JSON Pointer to current location)
 * @param {string} relativePointer - The relative JSON Pointer
 * @returns {{ value: any, found: boolean }} The resolved value and whether it was found
 */
export function getValueByRelativePointer(dataRoot, dataPath, relativePointer) {
  try {
    const parsed = parseRelativeJsonPointer(relativePointer);

    // Parse the current data path to get our position in the hierarchy
    const currentSegments = parseJsonPointer(dataPath || '');

    // Go up the specified number of levels
    if (parsed.levels > currentSegments.length) {
      return { value: undefined, found: false };
    }

    const targetSegments = currentSegments.slice(0, currentSegments.length - parsed.levels);

    // If hash is true, return the property name (last segment of the target)
    if (parsed.hash) {
      if (targetSegments.length === 0) {
        // We're at the root, return empty string or special marker
        return { value: '', found: true };
      }
      return { value: targetSegments[targetSegments.length - 1], found: true };
    }

    // Navigate to the target location
    let current = dataRoot;
    for (const segment of targetSegments) {
      if (Array.isArray(current)) {
        const index = parseInt(segment, 10);
        if (isNaN(index) || index < 0 || index >= current.length) {
          return { value: undefined, found: false };
        }
        current = current[index];
      } else if (typeof current === 'object' && current !== null) {
        if (!(segment in current)) {
          return { value: undefined, found: false };
        }
        current = current[segment];
      } else {
        return { value: undefined, found: false };
      }
    }

    // Now apply the JSON pointer part
    if (parsed.pointer) {
      const innerResult = getValueByJsonPointer(current, '', parsed.pointer);
      return innerResult;
    }

    return { value: current, found: true };
  } catch (e) {
    return { value: undefined, found: false };
  }
}

/**
 * Resolve a data reference (either JSON Pointer or relative JSON Pointer)
 * @param {any} dataRoot - The root data object
 * @param {string} dataPath - The current data path
 * @param {string} ref - The reference string
 * @returns {{ value: any, found: boolean }} The resolved value and whether it was found
 */
export function resolveDataRef(dataRoot, dataPath, ref) {
  if (!isStringType(ref)) {
    return { value: undefined, found: false };
  }

  // Check if it's a relative JSON Pointer (starts with a digit)
  if (/^\d/.test(ref)) {
    return getValueByRelativePointer(dataRoot, dataPath, ref);
  }

  // Otherwise treat as absolute JSON Pointer (starts with /)
  if (ref.startsWith('/')) {
    return getValueByJsonPointer(dataRoot, dataPath, ref);
  }

  // Empty string or invalid format - treat as reference to root
  if (ref === '') {
    return { value: dataRoot, found: true };
  }

  return { value: undefined, found: false };
}

/**
 * Get a value from data using a relative JSON Pointer
 * @param {any} dataRoot - The root data object
 * @param {string} dataPath - The current data path (JSON Pointer to current location)
 * @param {string} relativePointer - The relative JSON Pointer
 * @returns {{ value: any, found: boolean }} The resolved value and whether it was found
 */
export function resolveRelativePointer(dataRoot, dataPath, relativePointer) {
  try {
    const parsed = parseRelativeJsonPointer(relativePointer);

    // Parse the current data path to get our position in the hierarchy
    const currentSegments = parseJsonPointer(dataPath || '');

    // Go up the specified number of levels
    if (parsed.levels > currentSegments.length) {
      return { value: undefined, found: false };
    }

    const targetSegments = currentSegments.slice(0, currentSegments.length - parsed.levels);

    // If hash is true, return the property name (last segment of the target)
    if (parsed.hash) {
      if (targetSegments.length === 0) {
        // We're at the root, return empty string
        return { value: '', found: true };
      }
      return { value: targetSegments[targetSegments.length - 1], found: true };
    }

    // Navigate to the target location
    let current = dataRoot;
    for (const segment of targetSegments) {
      if (Array.isArray(current)) {
        const index = parseInt(segment, 10);
        if (isNaN(index) || index < 0 || index >= current.length) {
          return { value: undefined, found: false };
        }
        current = current[index];
      } else if (typeof current === 'object' && current !== null) {
        if (!(segment in current)) {
          return { value: undefined, found: false };
        }
        current = current[segment];
      } else {
        return { value: undefined, found: false };
      }
    }

    // Now apply the JSON pointer part
    if (parsed.pointer) {
      const segments = parseJsonPointer(parsed.pointer);
      for (const segment of segments) {
        if (current === null || current === undefined) {
          return { value: undefined, found: false };
        }

        if (Array.isArray(current)) {
          const index = parseInt(segment, 10);
          if (isNaN(index) || index < 0 || index >= current.length) {
            return { value: undefined, found: false };
          }
          current = current[index];
        } else if (typeof current === 'object') {
          if (!(segment in current)) {
            return { value: undefined, found: false };
          }
          current = current[segment];
        } else {
          return { value: undefined, found: false };
        }
      }
    }

    return { value: current, found: true };
  } catch (e) {
    return { value: undefined, found: false };
  }
}
