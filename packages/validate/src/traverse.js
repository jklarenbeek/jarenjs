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
  isStringHtmlIdentifier,
} from '@jarenjs/strings';


function encodeJsonPointerKey(key) {
  return encodeURIComponent(key.replace('~', '~0').replace('/', '~1'));
}

export function encodeJsonPointerPath(path, key, index) {
  return index == null
    ? `${path}/${encodeJsonPointerKey(key)}`
    : `${path}/${encodeJsonPointerKey(key)}/${encodeJsonPointerKey(index)}`;
}

function decodeJsonPointerKey(key) {
  return decodeURIComponent(key.replace('~0', '~').replace('~1', '/'));
}

export function decodeJsonPointerPath(path) {
  // split and remove the leading empty string
  return path.split('/').map(decodeJsonPointerKey).splice(1);
}

export function encodeJsonPointerArray(path, array) {
  return `${path}/${array.map(item => encodeJsonPointerKey(item)).join('/')}`;
}

class JsonPointerOptions {
  constructor(anchorsGlobal = true, anchorsAllowed = true, skipErrors = true) {
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
  const url = !isStringType(refUri) || isStringWhiteSpace(refUri)
    ? new URL(baseUri)
    : !isStringType(baseUri) || isStringWhiteSpace(baseUri)
      ? new URL(refUri)
      : new URL(refUri, baseUri);

  const [uri, fragment] = url.href.split('#');
  const [leftUri, search] = uri.split('?');

  if (!isStringWhiteSpace(fragment)) {
    // this is a sort of $anchor and we are karen about it and thus not use isStringAnchor().
    if (opts.anchorsAllowed == true && isStringHtmlIdentifier(fragment)) {
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
    schemas.set(baseUri, schema);
    return null;
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

    if (isStringType(obj.$id) && !isStringWhiteSpace(obj.$id)) {
      const { id } = createJsonPointer(obj.$id, base, opts);
      if (!schemas.has(id))
        schemas.set(id, obj);
      else if (schemas.get(id) == null)
        schemas.set(id, obj);
      else
        throw new Error(`Schema '${id}' for path '${path}' in '${base}' already exists`);

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

    if (isStringType(obj.$ref) && !isStringWhiteSpace(obj.$ref)) {
      const { id: ref } = createJsonPointer(obj.$ref, baseUri, opts);
      if (!schemas.has(ref))
        schemas.set(ref, null);

      continue;
    }

    // iterate through all properties
    for (const [key, value] of Object.entries(obj)) {
      if (!isObjectClass(value))
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
  const { id: base, leftUri, fragment } = createJsonPointer(refUri, baseUri, opts);
  if (!schemas.has(leftUri))
    throw new Error(`The root of reference: '$ref': '${base}', is not found in init-cache`);

  // get the document from cache
  let schema = schemas.get(leftUri);

  // If there is no fragment, return the whole schema
  if (isStringWhiteSpace(fragment)) {
    return { id: base, schema };
  }

  // Decode and resolve the JSON pointer
  const fragments = decodeJsonPointerPath(fragment);

  // Traverse the schema based on the JSON pointer
  let current = '';
  for (const part of fragments) {
    current = current + '/' + part;
    if (!isBoolOrObjectClass(schema[part]))
      throw new Error(`The '${current}' is not is not a valid schema in '${leftUri}'`);

    schema = schema[part];
  }

  return { id: base, schema };
}

export function restoreSchemaRefsInMap(schemas, opts = new JsonPointerOptions()) {
  for (const [id, item] of schemas.entries()) {
    if (item != null)
      continue;

    const { schema } = resolveRefSchemaShallow(schemas, id, null, opts);
    if (schema == null)
      throw new Error(`Can not resolve schema for '${id}'`);

    schemas.set(id, schema);
  }
}

export class TraverseOptions extends JsonPointerOptions {
  constructor(
    origin = 'https://github.com/jklarenbeek/jaren',
    mergeSchemas = true,
    anchorsGlobal,
    anchorsAllowed,
    skipErrors
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

    result = opts.mergeSchemas == true
      ? { ...item, ...result }
      : { ...item };

    if (!hasSchemaRef(item))
      return { id: base, schema: result };

    delete result.$ref;

    const ref = item.$ref;

    const { id, schema } = resolveRefSchemaShallow(schemas, ref, base, opts);

    if (seen.has(id))
      return { id: base, schema: result };

    seen.add(id);

    queue.push({ item: schema, base: id });
  }

  throw new Error(`The json schema '${baseUri}' can not be resolved!`);
}
