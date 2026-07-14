import {
  isBoolOrObjectClass,
  hasSchemaRef,
} from './tools.js';

import {
  isBoolishType,
} from '@jarenjs/core/number';

import {
  isObjectClass,
  isStringType,
} from '@jarenjs/core';

import {
  isStringWhiteSpace,
} from '@jarenjs/core/string';

import {
  isValidHtmlIdentifier,
} from '@jarenjs/core/text';


function encodeJsonPointerKey(key) {
  return encodeURIComponent(key.replace('~', '~0').replace('/', '~1'));
}

export function encodeJsonPointerPath(path, key, index) {
  return index == null
    ? `${path}/${encodeJsonPointerKey(key)}`
    : `${path}/${encodeJsonPointerKey(key)}/${encodeJsonPointerKey(String(index))}`;
}

function decodeJsonPointerKey(key) {
  return decodeURIComponent(key.replace('~0', '~').replace('~1', '/'));
}

export function decodeJsonPointerPath(path) {
  // split and remove the leading empty string
  return path.split('/').map(decodeJsonPointerKey).splice(1);
}

class JsonPointerOptions {
  constructor(anchorsGlobal = false, anchorsAllowed = true, skipErrors = true) {
    this.anchorsGlobal = anchorsGlobal;
    this.anchorsAllowed = anchorsAllowed;
    this.skipErrors = skipErrors;
  }
}

class JsonPointer {
  constructor(id, search, leftUri, fragment) {
    this.id = id;
    this.search = search;
    this.leftUri = leftUri;
    this.fragment = fragment;
  }
}

export function createJsonPointer(refUri, baseUri, opts = new JsonPointerOptions()) {
  let url;
  try {
    url = !isStringType(refUri) || isStringWhiteSpace(refUri)
      ? new URL(baseUri)
      : !isStringType(baseUri) || isStringWhiteSpace(baseUri)
        ? new URL(refUri)
        : new URL(refUri, baseUri);
  } catch (e) {
    // Handle case where baseUri is a relative reference (not a valid URL)
    // Only apply manual resolution when baseUri is a plain identifier (no scheme, no /)
    const isRelativeBase = isStringType(baseUri) && !/^[a-z][a-z0-9+.-]*:/i.test(baseUri);
    
    if (isStringType(refUri) && isRelativeBase) {
      // If refUri is absolute (has a scheme), use it as-is
      if (/^[a-z][a-z0-9+.-]*:/i.test(refUri)) {
        url = new URL(refUri);
      } else if (refUri.startsWith('#')) {
        // Fragment-only reference: combine with baseUri
        const effectiveBase = baseUri;
        url = new URL(refUri, 'http://example.com/' + effectiveBase);
        // Restore the original baseUri in the result
        const href = url.href.replace('http://example.com/', '');
        const [uri, fragment] = href.split('#');
        return new JsonPointer(
          effectiveBase + refUri,
          undefined,
          effectiveBase + '#',
          fragment || null
        );
      } else if (refUri.includes('#')) {
        // refUri has a fragment: manual resolution
        const [refBase, refFragment] = refUri.split('#');
        const resolvedId = baseUri.endsWith('/') 
          ? baseUri + refBase + '#' + refFragment
          : baseUri + '/' + refBase + '#' + refFragment;
        return new JsonPointer(
          resolvedId,
          undefined,
          baseUri + '#',
          refFragment
        );
      } else {
        // No fragment: simple concatenation
        const resolvedId = baseUri.endsWith('/')
          ? baseUri + refUri
          : baseUri + '/' + refUri;
        return new JsonPointer(resolvedId + '#', undefined, resolvedId + '#', null);
      }
    } else {
      // Re-throw the original error if we can't handle it
      throw e;
    }
  }

  const [uri, fragment] = url.href.split('#');
  const [leftUri, search] = uri.split('?');

  if (!isStringWhiteSpace(fragment)) {
    // this is a sort of $anchor and we are karen about it and thus not use isStringAnchor().
    if (opts.anchorsAllowed == true && isValidHtmlIdentifier(fragment)) {
      return opts.anchorsGlobal == true
        ? new JsonPointer(`#${fragment}`, search, `${leftUri}#`, fragment)
        : new JsonPointer(`${leftUri}#${fragment}`, search, `${leftUri}#`, fragment);
    }
    // or a json pointer
    else if (fragment.startsWith('/')) {
      return new JsonPointer(`${leftUri}#${fragment}`, search, `${leftUri}#`, fragment);
    }
  }
  return new JsonPointer(`${leftUri}#`, search, `${leftUri}#`, null);
}

const TRAVERSE_SCHEMA_OBJECTS = [
  'items', 'prefixItems', 'additionalItems', 'contains', 'unevaluatedItems',
  'additionalProperties', 'propertyNames', 'unevaluatedProperties',
  'not', 'oneOf', 'anyOf', 'allOf', 'if', 'then', 'else',
];
const TRAVERSE_SCHEMA_MAPS = [
  'properties', 'patternProperties',
  'dependencies', 'dependentSchemas', 'dependentRequired',
  'definitions', '$defs', 'components',
];

export function storeSchemaIdsInMap(schemas, baseUri, schema, opts = new JsonPointerOptions()) {
  if (!isObjectClass(schema)) {
    const { id } = createJsonPointer(baseUri, undefined, opts);
    schemas.set(id, schema);
    return id;
  }

  const { id: rootUri } = createJsonPointer(schema.$id, baseUri, opts);
  if (!isStringType(schema.$id) || isStringWhiteSpace(schema.$id)) {
    if (schemas.has(rootUri))
      throw new Error(`Schema '${rootUri}' already exists`);

    schemas.set(rootUri, schema);
  }

  baseUri = rootUri;

  const queue = [{ obj: schema, base: rootUri, path: '#' }];
  while (queue.length > 0) {
    // @ts-ignore
    const { obj, base, path } = queue.shift();

    // Handle $id (draft 6+) or id (draft 4) for identifying subschemas
    const idKeyword = isStringType(obj.$id) ? obj.$id : isStringType(obj.id) ? obj.id : undefined;
    if (isStringType(idKeyword) && !isStringWhiteSpace(idKeyword)) {
      const { id } = createJsonPointer(idKeyword, base, opts);
      if (!schemas.has(id))
        schemas.set(id, obj);
      else if (schemas.get(id) == null)
        schemas.set(id, obj);
      else
        throw new Error(`Schema '${id}' for path '${path}' in '${base}' already exists`);

      // CHECK: Also store under alternate ID (with/without # suffix) for absolute URIs only
      if (!id.startsWith('#')) {
        const altId = id.endsWith('#') ? id.slice(0, -1) : id + '#';
        if (!schemas.has(altId)) {
          schemas.set(altId, obj);
        }
      }

      // we reset the baseUri when the $id property is set.
      baseUri = id;
    }
    else
      baseUri = base;

    if (isStringType(obj.$anchor) && !isStringWhiteSpace(obj.$anchor)) {
      const { id } = createJsonPointer(`#${obj.$anchor}`, baseUri, opts);
      if (!schemas.has(id))
        schemas.set(id, obj);
      else if (schemas.get(id) == null)
        schemas.set(id, obj);
      else
        throw new Error(`Schema '${id}' for path '${path}' in '${base}' already exists`);

      // we reset the baseUri when the $anchor property is set.
      if (!id.startsWith('#')) // except when anchors are global
        baseUri = id;
    }

    // Handle $dynamicAnchor (draft 2020-12) - similar to $anchor but for $dynamicRef
    if (isStringType(obj.$dynamicAnchor) && !isStringWhiteSpace(obj.$dynamicAnchor)) {
      const { id } = createJsonPointer(`#${obj.$dynamicAnchor}`, baseUri, opts);
      if (!schemas.has(id))
        schemas.set(id, obj);
      else if (schemas.get(id) == null)
        schemas.set(id, obj);
      else
        throw new Error(`Schema '${id}' for path '${path}' in '${base}' already exists`);

      // Note: $dynamicAnchor does NOT change the baseUri like $anchor does
      // It's only used for $dynamicRef resolution
    }

    if (isStringType(obj.$ref) && !isStringWhiteSpace(obj.$ref)) {
      const { id: ref } = createJsonPointer(obj.$ref, baseUri, opts);
      if (!schemas.has(ref))
        schemas.set(ref, null);

      // Don't continue here - we need to process other schemas in the same
      // parent object (like definitions) even if this one has a $ref.
      // The $ref just means we don't traverse INTO this object's properties,
      // but siblings should still be processed.
    }

    // iterate through all properties
    for (const [key, value] of Object.entries(obj)) {
      if (!isObjectClass(value) && !Array.isArray(value))
        continue;

      // is the property a schema object to traverse in?
      if (TRAVERSE_SCHEMA_OBJECTS.includes(key)) {
        if (Array.isArray(value)) {
          const len = value.length;
          for (let index = 0; index < len; index++) {
            const item = value[index];
            const nextpath = encodeJsonPointerPath(path, key, index);

            if (isBoolishType(item))
              continue;
            if (!isObjectClass(item)) {
              if (opts.skipErrors === true)
                continue;
              else
                throw new Error(`${nextpath} is not a schema`);
            }

            queue.push({ obj: item, base: baseUri, path: nextpath });
          }
        }
        else {
          const nextpath = encodeJsonPointerPath(path, key);

          queue.push({ obj: value, base: baseUri, path: nextpath });
        }
      }
      // or is the property a map of key and schema objects?
      else if (TRAVERSE_SCHEMA_MAPS.includes(key)) {
        if (Array.isArray(value))
          continue;

        for (const [index, item] of Object.entries(value)) {
          const nextpath = encodeJsonPointerPath(path, key, index);
          if (isBoolishType(item))
            continue;
          if (!isObjectClass(item)) {
            if (opts.skipErrors === true)
              continue;
            else
              throw new Error(`${nextpath} is not a schema`);
          }

          queue.push({ obj: item, base: baseUri, path: nextpath });
        }
      }
    }
  }

  return rootUri;
}

export function resolveRefSchemaShallow(schemas, refUri, baseUri, opts = new JsonPointerOptions()) {
  let { id: base, leftUri, fragment } = createJsonPointer(refUri, baseUri, opts);
  if (!schemas.has(leftUri))
    throw new Error(`The root of reference: '$ref': '${base}', is not found in init-cache`);

  // get the document from cache
  let schema = schemas.get(leftUri);

  // If there is no fragment, return the whole schema
  if (isStringWhiteSpace(fragment)) {
    return { id: base, schema };
  }

  // If the fragment is a plain name anchor (not a JSON pointer starting with /),
  // look it up directly in the schemas map as a location-independent identifier
  if (!fragment.startsWith('/')) {
    // The anchor could be stored as just the fragment (e.g., "#foo") or as a full URI
    // Try the full id first (which includes the base URI)
    if (schemas.has(base)) {
      return { id: base, schema: schemas.get(base) };
    }
    // Try the scoped anchor format: baseUri + fragment (e.g., "https://example.com/schema#foo")
    // This handles anchors stored with anchorsGlobal: false
    const scopedAnchorId = `${leftUri}${fragment}`;
    if (schemas.has(scopedAnchorId)) {
      return { id: scopedAnchorId, schema: schemas.get(scopedAnchorId) };
    }
    // Try just the fragment with hash (global anchor format)
    const fragmentWithHash = `#${fragment}`;
    if (schemas.has(fragmentWithHash)) {
      return { id: fragmentWithHash, schema: schemas.get(fragmentWithHash) };
    }
    // Fall through to JSON pointer traversal for backward compatibility
  }

  // Decode and resolve the JSON pointer
  const fragments = decodeJsonPointerPath(fragment);

  // Traverse the schema based on the JSON pointer
  let current = '';
  for (const part of fragments) {
    current = current + '/' + part;
    if (!isBoolOrObjectClass(schema[part]) && !Array.isArray(schema[part]))
      throw new Error(`The '${current}' is not is not a valid schema in '${leftUri}'`);

    schema = schema[part];
    if (isObjectClass(schema) && isStringType(schema.$id) && !isStringWhiteSpace(schema.$id)) {
      const { id } = createJsonPointer(schema.$id, base, opts);
      base = id;
    }
  }

  return { id: base, schema };
}

export function restoreSchemaRefsInMap(schemas, opts = new JsonPointerOptions()) {
  for (const [id, item] of schemas.entries()) {
    if (item != null)
      continue;

    // Try to use resolveRefSchemaDeep to flatten ref chains
    // This resolves a→b→c into a→c, eliminating chain traversal at validation time
    // If deep resolution fails (e.g., remote ref not loaded yet), fall back to shallow
    try {
      const { id: finalId, schema: finalSchema } = resolveRefSchemaDeep(
        schemas,
        id,
        { $ref: id },
        opts
      );

      if (finalSchema == null)
        throw new Error(`Can not resolve schema for '${id}'`);

      // Store the final resolved schema (flattened ref chain)
      schemas.set(id, finalSchema);

      // Also store under the final ID for direct access if not already present
      if (finalId !== id && !schemas.has(finalId)) {
        schemas.set(finalId, finalSchema);
      }
    } catch (e) {
      // If deep resolution fails (remote ref not loaded), fall back to shallow resolution
      // This preserves the original behavior for unresolved refs
      const { schema } = resolveRefSchemaShallow(schemas, id, null, opts);
      if (schema == null)
        throw new Error(`Can not resolve schema for '${id}'`);

      schemas.set(id, schema);
    }
  }
}

export class TraverseOptions extends JsonPointerOptions {
  constructor(
    origin = 'https://github.com/jklarenbeek/jarenjs',
    mergeSchemas = true,
    anchorsGlobal = false,
    anchorsAllowed = true,
    skipErrors = true
  ) {
    super(anchorsGlobal, anchorsAllowed, skipErrors);
    this.origin = origin,
    this.mergeSchemas = mergeSchemas;
  }
}

export function resolveRefSchemaDeep(schemas, baseUri, refschema, opts = new TraverseOptions()) {
  if (!isObjectClass(refschema))
    return { id: baseUri, schema: refschema };

  if (!hasSchemaRef(refschema))
    return { id: baseUri, schema: refschema };

  const queue = [{ item: refschema, base: baseUri }];
  const seen = new Set();
  let result = {};

  while (queue.length > 0) {
    // @ts-ignore
    const { item, base } = queue.shift();
    if (!isObjectClass(item))
      return { id: base, schema: item };

    // In draft 7 and earlier, $ref completely replaces the schema
    // and all sibling keywords must be ignored. We only keep the $ref
    // to resolve it, discarding all other keywords from this item.
    if (hasSchemaRef(item)) {
      const ref = item.$ref;
      const { id, schema } = resolveRefSchemaShallow(schemas, ref, base, opts);

      if (seen.has(id))
        return { id: base, schema: result };

      seen.add(id);

      queue.push({ item: schema, base: id });
    } else {
      // No $ref in this item, merge as normal
      result = opts.mergeSchemas == true
        ? { ...item, ...result }
        : { ...item };
      return { id: base, schema: result };
    }
  }

  throw new Error(`The json schema '${baseUri}' can not be resolved!`);
}
