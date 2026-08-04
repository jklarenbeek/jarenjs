//@ts-check
/**
 * @file RFC 6902 → dialect JSON-set primitives, so a one-field update
 * does not rewrite a large document. The translation is decided
 * AGAINST THE LIVE DOCUMENT: an RFC 6901 pointer cannot say whether
 * `/a/0` names an array position or an object member called `"0"`, so
 * each segment is discriminated by walking the document the patch was
 * validated against, and the walked state is advanced op by op so a
 * later operation sees what the earlier ones produced.
 *
 * Translatable in 0.1: `replace` anywhere, `add` of an object member,
 * `add` at an array's end (`/-` or the index equal to its length), and
 * `remove`. Everything else — `test`, `move`, `copy`, a mid-array
 * insert (the shift has no single JSON-function spelling) — returns
 * `null` and the store falls back to a whole-document write. The
 * fallback is counted and exposed by the store, measured rather than
 * assumed.
 */

import { applyJSONPatch } from '@jarenjs/json/patch';
import { parseJSONPointer } from '@jarenjs/json/pointer';

/** @typedef {import('./dialect.js').JsonPathSegment} JsonPathSegment */

const ARRAY_INDEX = /^(?:0|[1-9][0-9]*)$/;

/**
 * Discriminate one pointer against the live document into typed
 * segments, stopping before the final segment.
 * @param {any} doc
 * @param {string[]} names - parsed pointer segments
 * @returns {{ segments: JsonPathSegment[], parent: any } | null}
 */
function walkParent(doc, names) {
  /** @type {JsonPathSegment[]} */
  const segments = [];
  let node = doc;
  for (let i = 0; i < names.length - 1; i++) {
    const name = names[i];
    if (Array.isArray(node)) {
      if (!ARRAY_INDEX.test(name)) return null;
      const index = Number(name);
      segments.push({ index });
      node = node[index];
    }
    else if (node !== null && typeof node === 'object') {
      segments.push({ name });
      node = node[name];
    }
    else {
      return null;
    }
  }
  return { segments, parent: node };
}

/**
 * Translate one operation against the current document state.
 * @param {any} op
 * @param {any} doc
 * @returns {{ kind: 'set' | 'remove', segments: JsonPathSegment[],
 *   value?: any } | { kind: 'append', segments: JsonPathSegment[],
 *   value: any } | null}
 */
function translateOp(op, doc) {
  if (op === null || typeof op !== 'object' || typeof op.path !== 'string')
    return null;
  if (op.op !== 'replace' && op.op !== 'add' && op.op !== 'remove') return null;
  let names;
  try {
    names = parseJSONPointer(op.path);
  }
  catch {
    return null;
  }
  // a root write replaces the whole document — that IS the fallback
  if (names.length === 0) return null;
  const walked = walkParent(doc, names);
  if (walked === null) return null;
  const { segments, parent } = walked;
  const last = names[names.length - 1];

  if (Array.isArray(parent)) {
    if (op.op === 'add') {
      if (last === '-' || (ARRAY_INDEX.test(last) && Number(last) === parent.length))
        return { kind: 'append', segments, value: op.value };
      return null; // a mid-array insert shifts neighbours: whole-document
    }
    if (!ARRAY_INDEX.test(last)) return null;
    const indexed = [...segments, { index: Number(last) }];
    return op.op === 'remove'
      ? { kind: 'remove', segments: indexed }
      : { kind: 'set', segments: indexed, value: op.value };
  }
  if (parent !== null && typeof parent === 'object') {
    const named = [...segments, { name: last }];
    return op.op === 'remove'
      ? { kind: 'remove', segments: named }
      : { kind: 'set', segments: named, value: op.value };
  }
  return null;
}

/**
 * Translate a whole patch into a dialect expression builder, or `null`
 * when any operation needs the whole-document fallback. The caller has
 * already applied the patch in memory (the copy-on-write engine
 * validates the RESULT); this translation only decides how the same
 * outcome reaches the database.
 * @param {any[]} ops - RFC 6902 operations, already known applicable
 * @param {any} doc - The stored document the patch applies to
 * @param {any} dialect
 * @returns {{ build: (docColumnSql: string,
 *   parameterIndexBase: number) => { expression: string,
 *   params: string[] } } | null}
 */
export function translatePatch(ops, doc, dialect) {
  /** @type {{ kind: string, pathText: string, value?: any }[]} */
  const steps = [];
  let current = doc;
  for (const op of ops) {
    const translated = translateOp(op, current);
    if (translated === null) return null;
    const pathText = dialect.jsonPathText(translated.segments);
    if (pathText === null) return null;
    steps.push({ kind: translated.kind, pathText, value: translated.value });
    // advance the discrimination state past this op
    current = applyJSONPatch(current, [op]);
  }
  return {
    build(docColumnSql, parameterIndexBase) {
      let expression = docColumnSql;
      /** @type {string[]} */
      const params = [];
      for (const step of steps) {
        if (step.kind === 'remove') {
          expression = dialect.jsonRemove(expression, step.pathText);
          continue;
        }
        const ref = dialect.jsonEncode(
          dialect.parameterRef(parameterIndexBase + params.length, 'value'));
        params.push(JSON.stringify(step.value));
        expression = step.kind === 'append'
          ? dialect.jsonAppend(expression, step.pathText, ref)
          : dialect.jsonSet(expression, step.pathText, ref);
      }
      return { expression, params };
    },
  };
}
