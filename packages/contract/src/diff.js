//@ts-check
/**
 * @file `diffContracts(a, b)`: what changed from contract `a` to contract
 * `b`, classified by the published rule table (docs/CONTRACT-FORMAT.md
 * §13, rows R1–R16) into `breaking`, `additive`, `neutral` and `unknown`
 * — where `unknown` is the honest fourth class: a schema construct the
 * checker does not model (`anyOf`, `if`, a changed `pattern`, an external
 * `$ref` that moved) is REPORTED, never silently classed.
 *
 * The schema comparison walks the two sides in parallel over the resolved
 * same-document structure — a bare `{ "$ref": "#/$defs/X" }` hop is
 * followed with the same rules the compiler used — and models exactly the
 * R6 keyword set (`type`, `const`, `enum`, `maximum`, `minimum`,
 * `maxLength`, `minLength`, `pattern`) plus object structure
 * (`properties`, `required`, `additionalProperties`) and `items`. Pure
 * annotations (`title`, `description`, `examples`, `$comment`,
 * `deprecated`) never move a wire byte and are ignored; every other
 * keyword that differs between the two sides lands in `unknown` (R15).
 *
 * A nullable node has two spellings — `type: [T, 'null']` and a
 * two-branch `anyOf`/`oneOf` with a null-only branch — and the walk reads
 * them through `canonicalNullable` (`@jarenjs/core/schema`). Where they
 * accept the same values a respelling is neutral R16, and a change beside
 * it is read on the type-array spelling (its `docPath` names that
 * spelling's keyword). Where they may not (a `$query`, an `enum` or a
 * `$ref` in the branch), nothing is canonicalized and the walk above
 * reports what differs.
 *
 * A `Change`'s `docPath` points into the document that carries it — a
 * removal into `a`, everything else into `b` — composed over the RESOLVED
 * structure, so a constraint reached through a `$ref` reports the path a
 * validator error would name, not the `$defs` entry's.
 */

import { encodeJSONPointerSegment } from '@jarenjs/json/pointer';
import { canonicalizeJson } from '@jarenjs/json/canonical';
import { canonicalNullable, splitNullable } from '@jarenjs/core/schema';
import { collectSameDocumentAnchors, resolveSameDocumentRef } from '@jarenjs/validate/normalize';

import { compileContract } from './compile.js';
import { ContractHostError } from './errors.js';
import { isCompiledContract } from './public.js';
import { pathShape } from '@jarenjs/core/route';

export { isCompatible, compatReason } from './compat.js';

/**
 * @typedef {import('./compile.js').Contract} Contract
 * @typedef {import('./compile.js').CompiledOperation} CompiledOperation
 */

/**
 * One classified change.
 * @typedef {Object} Change
 * @property {string} kind - a stable slug naming what changed (`'operation-removed'`, `'input-narrowed'`, …)
 * @property {string} op - the operation id
 * @property {string} docPath - RFC 6901 pointer to the change (into `a` for a removal, into `b` otherwise)
 * @property {unknown} [from] - the old value, where one exists
 * @property {unknown} [to] - the new value, where one exists
 * @property {string} rule - the §13 row: `'R1'`–`'R16'`
 * @property {string} [note] - the honesty rider some rows carry (R5's "now ignored, not validated")
 * @property {'server'} [audience] - present, under `audience: 'all'`, on every
 *   change of a server-audience operation
 */

/**
 * @typedef {Object} ContractDiff
 * @property {Change[]} breaking
 * @property {Change[]} additive
 * @property {Change[]} neutral
 * @property {Change[]} unknown
 */

/** Keywords compared as constraints (the R6 set). */
const CONSTRAINTS = ['type', 'const', 'enum', 'maximum', 'minimum', 'maxLength', 'minLength', 'pattern'];
const CONSTRAINT_SET = new Set(CONSTRAINTS);

/** Keywords the object-structure pass owns. */
const STRUCTURE = new Set(['properties', 'required', 'additionalProperties', 'items']);

/** Pure annotations — no wire behavior, never reported. */
const ANNOTATIONS = new Set(['title', 'description', 'examples', '$comment', 'deprecated']);

/** Resolution artifacts the parallel walk consults, never compares. */
const RESOLUTION = new Set(['$ref', '$defs', 'definitions', '$anchor', '$id', '$schema']);

/** The stable canonical text of any JSON value (for deep equality). */
const canon = (/** @type {unknown} */ v) => (v === undefined ? 'undefined' : canonicalizeJson(v));

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * One side of the parallel walk: the schema resolution scope.
 * @typedef {{ doc: any, anchors: Map<string, object> }} Side
 */

/**
 * Resolve bare `{ $ref }` hops (same-document only). Returns the resolved
 * node, or a marker for the shapes the walk cannot model.
 * @param {any} node
 * @param {Side} side
 * @returns {{ node: any } | { external: string } | { opaque: true }}
 */
function resolveHops(node, side) {
  const seen = new Set();
  while (isObject(node) && typeof node.$ref === 'string') {
    if (Object.keys(node).length > 1) return { opaque: true }; // $ref with siblings — not modeled
    if (!node.$ref.startsWith('#')) return { external: node.$ref };
    if (seen.has(node)) return { opaque: true };
    seen.add(node);
    const target = resolveSameDocumentRef(node.$ref, side.doc, side.anchors);
    if (target === undefined) return { opaque: true };
    node = target;
  }
  return { node };
}

/**
 * The event sink of one schema comparison.
 * @typedef {Object} Sink
 * @property {(direction: 'narrowed' | 'widened', keyword: string, path: string, from: unknown, to: unknown) => void} constraint
 * @property {(event: 'removed' | 'added-required' | 'added-optional' | 'made-required' | 'made-optional',
 *   direction: 'narrowed' | 'widened' | 'unknown' | null, path: string, member: string, closedBefore: boolean,
 *   catchAll?: string | null) => void} member
 *   `direction` is the AP-aware narrowing/widening reading of the member
 *   event (`null` when it is a no-op, e.g. an unconstrained optional
 *   member added to an open object; `'unknown'` when a constraining
 *   catch-all — named by `catchAll` — judges the member on the other
 *   side); `closedBefore` says whether the object refused unknown members
 *   in `a` (`additionalProperties` or `unevaluatedProperties` false) — an
 *   output member a closed schema never allowed is one the old client's
 *   validator refuses
 * @property {(keyword: string, path: string, from: unknown, to: unknown) => void} unknown
 * @property {(path: string, from: unknown, to: unknown) => void} respelled - a nullable
 *   node respelled between a type array and a two-branch `anyOf`/`oneOf` (R16)
 */

/**
 * Which of the two nullable spellings a node uses.
 * @param {Record<string, any>} node
 * @returns {'anyOf' | 'oneOf' | 'type'}
 */
function nullableSpelling(node) {
  return Array.isArray(node.anyOf) ? 'anyOf' : Array.isArray(node.oneOf) ? 'oneOf' : 'type';
}

/**
 * The index of the non-null branch of a two-branch nullable union — the
 * branch that, paired with a null branch, still reads as nullable (the
 * null-only rule stays @jarenjs/core/schema's own).
 * @param {readonly unknown[]} branches
 * @returns {number}
 */
function nonNullBranch(branches) {
  return branches.findIndex((branch) => splitNullable({ anyOf: [branch, { type: 'null' }] }) !== null);
}

/** The applicators the checker does not model: a constraint may sit inside one. */
const APPLICATORS = ['anyOf', 'oneOf', 'allOf', 'not', 'if', 'then', 'else', 'dependentSchemas'];

/** @param {Record<string, any>} node */
const carriesApplicator = (node) => APPLICATORS.some((key) => node[key] !== undefined);

/**
 * Whether an object schema forbids the members it does not name.
 * @param {Record<string, any>} node
 */
const closedObject = (node) => node.additionalProperties === false || node.unevaluatedProperties === false;

/**
 * The keyword of a catch-all that constrains the members an object schema
 * does not name — a member added beside it may or may not satisfy it,
 * which the checker cannot decide — or `null`.
 * @param {Record<string, any>} node
 * @returns {string | null}
 */
function constrainingCatchAll(node) {
  for (const key of ['additionalProperties', 'unevaluatedProperties']) {
    const value = node[key];
    if (value !== undefined && value !== true && value !== false && !(isObject(value) && Object.keys(value).length === 0)) return key;
  }
  if (isObject(node.patternProperties) && Object.keys(node.patternProperties).length > 0) return 'patternProperties';
  if (node.propertyNames !== undefined && node.propertyNames !== true) return 'propertyNames';
  return null;
}

/**
 * Compare two schema nodes in parallel over the modeled structure.
 * @param {any} aNode
 * @param {any} bNode
 * @param {string} path - pointer relative to the schema roots
 * @param {Side} a
 * @param {Side} b
 * @param {Sink} sink
 * @param {Map<object, Set<object>>} visited - pair memo (recursive schemas terminate)
 */
function compareSchema(aNode, bNode, path, a, b, sink, visited) {
  const ra = resolveHops(aNode, a);
  const rb = resolveHops(bNode, b);
  if ('external' in ra || 'external' in rb) {
    const from = 'external' in ra ? ra.external : undefined;
    const to = 'external' in rb ? rb.external : undefined;
    if (from !== to) sink.unknown('$ref', path, aNode, bNode);
    return;
  }
  if ('opaque' in ra || 'opaque' in rb) {
    if (canon(aNode) !== canon(bNode)) sink.unknown('$ref', path, aNode, bNode);
    return;
  }
  let A = ra.node;
  let B = rb.node;
  // booleans: `true` is the empty schema, `false` accepts nothing
  if (A === false || B === false) {
    if (A === false && B === false) return;
    if (B === false) sink.constraint('narrowed', 'schema', path, A, false);
    else sink.constraint('widened', 'schema', path, false, B);
    return;
  }
  if (A === true) A = {};
  if (B === true) B = {};
  if (!isObject(A) || !isObject(B)) {
    if (canon(A) !== canon(B)) sink.unknown('schema', path, A, B);
    return;
  }
  if (A === B) return;
  let pairs = visited.get(A);
  if (pairs !== undefined && pairs.has(B)) return;
  if (pairs === undefined) visited.set(A, (pairs = new Set()));
  pairs.add(B);

  // A nullable node has two spellings — `type: [T, 'null']` and a
  // two-branch anyOf/oneOf with a null-only branch — and they are one
  // meaning exactly when canonicalNullable can say so (the value sets are
  // equal). A respelling alone is neutral R16; a respelling beside a real
  // change reports both, and the change is read on the one spelling.
  const canonA = canonicalNullable(A);
  const canonB = canonA === null ? null : canonicalNullable(B);
  if (canonA !== null && canonB !== null) {
    const spellingA = nullableSpelling(A);
    const spellingB = nullableSpelling(B);
    // a reorder inside one spelling (a type array's items, a union's
    // branches) is no respelling: silent, as any other reorder is
    if (spellingA !== spellingB) sink.respelled(path, A, B);
    if (canon(canonA) === canon(canonB)) return;
    if (spellingA !== 'type' && spellingB !== 'type') {
      // two unions: compare the non-null branches where they sit, so a
      // change's pointer resolves in the documents
      const ia = nonNullBranch(A[spellingA]);
      const ib = nonNullBranch(B[spellingB]);
      compareSchema(A[spellingA][ia], B[spellingB][ib], `${path}/${spellingB}/${ib}`, a, b, sink, visited);
      return;
    }
    A = canonA;
    B = canonB;
  }

  const keys = new Set([...Object.keys(A), ...Object.keys(B)]);
  let structure = false;
  for (const key of keys) {
    if (ANNOTATIONS.has(key) || RESOLUTION.has(key)) continue;
    if (CONSTRAINT_SET.has(key)) continue; // the constraint pass below
    if (STRUCTURE.has(key)) {
      structure = true;
      continue;
    }
    if (canon(A[key]) !== canon(B[key])) sink.unknown(key, path + '/' + key, A[key], B[key]);
  }
  compareConstraints(A, B, path, sink);
  if (structure) {
    compareObject(A, B, path, a, b, sink, visited);
    if (A.items !== undefined || B.items !== undefined) {
      if (A.items === undefined) sink.constraint('narrowed', 'items', path + '/items', undefined, B.items);
      else if (B.items === undefined) sink.constraint('widened', 'items', path + '/items', A.items, undefined);
      else compareSchema(A.items, B.items, path + '/items', a, b, sink, visited);
    }
  }
}

/**
 * The R6 keyword set, leaf by leaf.
 * @param {Record<string, any>} A
 * @param {Record<string, any>} B
 * @param {string} path
 * @param {Sink} sink
 */
function compareConstraints(A, B, path, sink) {
  // a constraint present on one side only may have moved into an
  // applicator the other side carries (anyOf, allOf, …): which way the
  // accepted values moved cannot be decided, so it is R15, never a guess
  const aApplies = carriesApplicator(A);
  const bApplies = carriesApplicator(B);
  const emit = (/** @type {'narrowed' | 'widened'} */ d, /** @type {string} */ k) => {
    const oneSided = A[k] === undefined ? aApplies : B[k] === undefined ? bApplies : false;
    if (oneSided) sink.unknown(k, path + '/' + k, A[k], B[k]);
    else sink.constraint(d, k, path + '/' + k, A[k], B[k]);
  };

  // type and enum/const compare as value sets: what was removed narrows,
  // what was added widens — an incomparable change (string → integer)
  // honestly reports BOTH
  const sets = [
    ['type', (/** @type {any} */ v) => (v === undefined ? null : Array.isArray(v) ? v : [v])],
    ['enum', (/** @type {any} */ v) => (v === undefined ? null : v)],
    ['const', (/** @type {any} */ v) => (v === undefined ? null : [v])],
  ];
  for (const [key, toSet] of /** @type {[string, (v: any) => any[] | null][]} */ (sets)) {
    if (canon(A[key]) === canon(B[key])) continue;
    const before = toSet(A[key]);
    const after = toSet(B[key]);
    if (before === null) emit('narrowed', key); // unconstrained → constrained
    else if (after === null) emit('widened', key);
    else {
      const beforeTexts = new Set(before.map(canon));
      const afterTexts = new Set(after.map(canon));
      // a type set counts `integer` as inside `number`: every integer is a number
      const covered = (/** @type {string} */ t, /** @type {Set<string>} */ set) => set.has(t)
        || (key === 'type' && t === canon('integer') && set.has(canon('number')));
      if ([...beforeTexts].some((t) => !covered(t, afterTexts))) emit('narrowed', key);
      if ([...afterTexts].some((t) => !covered(t, beforeTexts))) emit('widened', key);
    }
  }

  // numeric/length bounds: which way did the accepted range move?
  for (const [key, tighterWhen] of /** @type {[string, 'lower' | 'higher'][]} */ ([
    ['maximum', 'lower'], ['maxLength', 'lower'], ['minimum', 'higher'], ['minLength', 'higher'],
  ])) {
    const from = A[key];
    const to = B[key];
    if (from === to) continue;
    if (typeof from !== 'number' && from !== undefined) { sink.unknown(key, path + '/' + key, from, to); continue; }
    if (typeof to !== 'number' && to !== undefined) { sink.unknown(key, path + '/' + key, from, to); continue; }
    if (from === undefined) emit('narrowed', key);
    else if (to === undefined) emit('widened', key);
    else if (tighterWhen === 'lower' ? to < from : to > from) emit('narrowed', key);
    else emit('widened', key);
  }

  if (A.pattern !== B.pattern) {
    if (A.pattern === undefined) emit('narrowed', 'pattern');
    else if (B.pattern === undefined) emit('widened', 'pattern');
    else sink.unknown('pattern', path + '/pattern', A.pattern, B.pattern); // two regex languages are not comparable
  }
}

/**
 * Object structure: members, `required`, `additionalProperties`.
 * @param {Record<string, any>} A
 * @param {Record<string, any>} B
 * @param {string} path
 * @param {Side} a
 * @param {Side} b
 * @param {Sink} sink
 * @param {Map<object, Set<object>>} visited
 */
function compareObject(A, B, path, a, b, sink, visited) {
  const aProps = isObject(A.properties) ? A.properties : {};
  const bProps = isObject(B.properties) ? B.properties : {};
  const aReq = new Set(Array.isArray(A.required) ? A.required : []);
  const bReq = new Set(Array.isArray(B.required) ? B.required : []);
  const aClosed = closedObject(A);
  const bClosed = closedObject(B);
  const aCatchAll = aClosed ? null : constrainingCatchAll(A);
  const bCatchAll = bClosed ? null : constrainingCatchAll(B);
  // a member or requirement present on one side only may have moved into
  // an applicator the other side carries: undecidable, R15
  const aApplies = carriesApplicator(A);
  const bApplies = carriesApplicator(B);

  for (const m of new Set([...Object.keys(aProps), ...Object.keys(bProps)])) {
    const at = path + '/properties/' + encodeJSONPointerSegment(m);
    const inA = Object.hasOwn(aProps, m);
    const inB = Object.hasOwn(bProps, m);
    if ((inA && !inB && bApplies) || (!inA && inB && aApplies)) {
      sink.unknown('properties', at, inA ? m : undefined, inB ? m : undefined);
      continue;
    }
    if (inA && !inB) {
      // removed: forbidden under a closed b, unconstrained under an open
      // one, judged by b's catch-all under one that constrains
      sink.member('removed', bClosed ? 'narrowed' : bCatchAll !== null ? 'unknown' : 'widened', at, m, aClosed, bCatchAll);
      continue;
    }
    if (!inA && inB) {
      const unconstrained = bProps[m] === true || (isObject(bProps[m]) && Object.keys(bProps[m]).length === 0);
      if (aCatchAll !== null) sink.member(bReq.has(m) ? 'added-required' : 'added-optional', 'unknown', at, m, aClosed, aCatchAll);
      else if (bReq.has(m)) sink.member('added-required', 'narrowed', at, m, aClosed);
      else if (aClosed) sink.member('added-optional', 'widened', at, m, aClosed); // was forbidden, now allowed
      else sink.member('added-optional', unconstrained ? null : 'narrowed', at, m, aClosed); // was unconstrained
      continue;
    }
    if (!aReq.has(m) && bReq.has(m)) {
      if (aApplies) sink.unknown('required', at, undefined, m);
      else sink.member('made-required', 'narrowed', at, m, aClosed);
    }
    else if (aReq.has(m) && !bReq.has(m)) {
      if (bApplies) sink.unknown('required', at, m, undefined);
      else sink.member('made-optional', 'widened', at, m, aClosed);
    }
    compareSchema(aProps[m], bProps[m], at, a, b, sink, visited);
  }

  // a required name without a properties entry is still a requirement
  for (const m of bReq) {
    if (!aReq.has(m) && !Object.hasOwn(bProps, m) && !Object.hasOwn(aProps, m)) {
      if (aApplies) sink.unknown('required', path + '/required', undefined, m);
      else sink.member('added-required', 'narrowed', path + '/required', m, aClosed);
    }
  }
  for (const m of aReq) {
    if (!bReq.has(m) && !Object.hasOwn(aProps, m) && !Object.hasOwn(bProps, m)) {
      if (bApplies) sink.unknown('required', path + '/required', m, undefined);
      else sink.member('made-optional', 'widened', path + '/required', m, aClosed);
    }
  }

  const aAp = A.additionalProperties === undefined ? true : A.additionalProperties;
  const bAp = B.additionalProperties === undefined ? true : B.additionalProperties;
  if (canon(aAp) !== canon(bAp)) {
    compareSchema(aAp, bAp, path + '/additionalProperties', a, b, sink, visited);
  }
}

//#region the operation walk

/** @param {string} id */
const opPath = (/** @type {string} */ id) => '/operations/' + encodeJSONPointerSegment(id);

/**
 * @param {Change[]} into
 * @param {Change} change
 */
const push = (into, change) => { into.push(change); };

/**
 * The rule table's classification of one rule id.
 * @param {ContractDiff} diff
 * @param {string} rule
 * @returns {Change[]}
 */
function classOf(diff, rule) {
  switch (rule) {
    case 'R2': case 'R7': case 'R9': case 'R11': return diff.additive;
    case 'R13': case 'R16': return diff.neutral;
    case 'R15': return diff.unknown;
    default: return diff.breaking;
  }
}

/**
 * A sink whose events land as classified changes of one operation.
 * @param {ContractDiff} diff
 * @param {string} op
 * @param {string} root - `/operations/<id>/input` or `…/output`
 * @param {'input' | 'output'} what - input maps narrow/widen to R6/R7,
 *   output maps member events to R8/R9 and narrow/widen likewise
 * @returns {Sink}
 */
function schemaSink(diff, op, root, what) {
  // Variance: an input is consumed by the SERVER, so narrowing it refuses
  // what old clients send (breaking) and widening accepts more (additive);
  // an output is consumed by the CLIENT, which validates what it receives
  // against its own contract, so widening hands it values it refuses
  // (breaking — the suite's own client answers JC2053) and narrowing is
  // additive: a client on the wider contract accepts every narrower answer.
  /** @type {(direction: 'narrowed' | 'widened') => [string, string]} */
  const directionRule = (direction) => (what === 'input'
    ? (direction === 'narrowed' ? ['R6', 'input-narrowed'] : ['R7', 'input-widened'])
    : (direction === 'widened' ? ['R8', 'output-widened'] : ['R9', 'output-narrowed']));
  return {
    constraint(direction, keyword, path, from, to) {
      const [rule, kind] = directionRule(direction);
      push(classOf(diff, rule), { kind, op, docPath: root + path, from, to, rule, note: keyword });
    },
    member(event, direction, path, member, closedBefore, catchAll) {
      if (direction === 'unknown' && (what === 'input' || event !== 'removed')) {
        // a catch-all (additionalProperties as a schema, patternProperties,
        // propertyNames) judges the member on the other side: undecidable
        push(diff.unknown, { kind: 'schema-unknown', op, docPath: root + path, from: member, to: member, rule: 'R15', note: catchAll ?? 'additionalProperties' });
        return;
      }
      if (what === 'output') {
        // the consumer's view: a removed or no-longer-guaranteed member
        // breaks a client that reads it, and a new member breaks a client
        // whose schema was closed (its validator refuses the member); on
        // an open schema a new member is additive
        const added = event === 'added-optional' || event === 'added-required';
        const breaking = event === 'removed' || event === 'made-optional' || (added && closedBefore);
        const rule = breaking ? 'R8' : 'R9';
        push(classOf(diff, rule), {
          kind: event === 'removed' ? 'output-member-removed'
            : event === 'made-optional' ? 'output-member-optional'
              : event === 'made-required' ? 'output-member-guaranteed'
                : 'output-member-added',
          op, docPath: root + path, from: member, to: member, rule,
        });
        return;
      }
      if (direction === null) return; // a no-op member event (unconstrained optional member on an open object)
      const [rule, kind] = directionRule(direction);
      push(classOf(diff, rule), { kind, op, docPath: root + path, from: member, to: member, rule, note: event });
    },
    unknown(keyword, path, from, to) {
      push(diff.unknown, { kind: 'schema-unknown', op, docPath: root + path, from, to, rule: 'R15', note: keyword });
    },
    respelled(path, from, to) {
      push(diff.neutral, { kind: 'schema-respelled', op, docPath: root + path, from, to, rule: 'R16' });
    },
  };
}

/**
 * The top-level input members of both sides, by the R4/R5/R7 rows, then
 * the member schemas recursively.
 * @param {ContractDiff} diff
 * @param {CompiledOperation} aOp
 * @param {CompiledOperation} bOp
 * @param {Side} a
 * @param {Side} b
 */
function compareInput(diff, aOp, bOp, a, b) {
  const op = aOp.id;
  const root = opPath(op) + '/input';
  const aEff = aOp.input === null ? null : aOp.input.effective;
  const bEff = bOp.input === null ? null : bOp.input.effective;
  if (aEff === null && bEff === null) return;

  const aProps = aEff !== null && isObject(aEff.properties) ? aEff.properties : {};
  const bProps = bEff !== null && isObject(bEff.properties) ? bEff.properties : {};
  const aReq = new Set(aEff !== null && Array.isArray(aEff.required) ? aEff.required : []);
  const bReq = new Set(bEff !== null && Array.isArray(bEff.required) ? bEff.required : []);
  const bClosed = bEff === null || bEff.additionalProperties === false;

  if (aEff !== null && bEff === null) {
    push(diff.breaking, {
      kind: 'input-removed', op, docPath: root, from: aOp.input?.schema, rule: 'R5',
      note: 'the operation no longer takes input — anything an older client sends is refused',
    });
    return;
  }

  const sink = schemaSink(diff, op, root, 'input');
  const visited = new Map();
  for (const m of new Set([...Object.keys(aProps), ...Object.keys(bProps), ...aReq, ...bReq])) {
    const at = root + '/properties/' + encodeJSONPointerSegment(m);
    const inA = Object.hasOwn(aProps, m) || aReq.has(m);
    const inB = Object.hasOwn(bProps, m) || bReq.has(m);
    if (inA && !inB) {
      if (bClosed) {
        push(diff.breaking, { kind: 'input-member-removed', op, docPath: at, from: m, rule: 'R5' });
      }
      else {
        push(diff.neutral, {
          kind: 'input-member-removed', op, docPath: at, from: m, rule: 'R5',
          note: 'the input schema stays open, so the member is now ignored, not validated',
        });
      }
      continue;
    }
    if (!inA && inB) {
      if (bReq.has(m)) push(diff.breaking, { kind: 'input-required-added', op, docPath: at, to: m, rule: 'R4' });
      else push(diff.additive, { kind: 'input-member-added', op, docPath: at, to: m, rule: 'R7' });
      continue;
    }
    if (!aReq.has(m) && bReq.has(m)) {
      push(diff.breaking, { kind: 'input-required-added', op, docPath: at, from: m, to: m, rule: 'R4' });
    }
    else if (aReq.has(m) && !bReq.has(m)) {
      push(diff.additive, { kind: 'input-member-optional', op, docPath: at, from: m, to: m, rule: 'R7' });
    }
    if (Object.hasOwn(aProps, m) && Object.hasOwn(bProps, m)) {
      compareSchema(aProps[m], bProps[m], '/properties/' + encodeJSONPointerSegment(m), a, b, sink, visited);
    }
  }
  const aAp = aEff === null || aEff.additionalProperties === undefined ? true : aEff.additionalProperties;
  const bAp = bEff.additionalProperties === undefined ? true : bEff.additionalProperties;
  if (canon(aAp) !== canon(bAp)) compareSchema(aAp, bAp, '/additionalProperties', a, b, sink, visited);
}

/**
 * The binding members of R3, plus member locations and the whole-body
 * member — a member that moves (query → header, say) rewrites the wire
 * exactly like a moved path, so it classifies with the binding row.
 * @param {ContractDiff} diff
 * @param {CompiledOperation} aOp
 * @param {CompiledOperation} bOp
 */
function compareBinding(diff, aOp, bOp) {
  const op = aOp.id;
  const emit = (/** @type {string} */ member, /** @type {unknown} */ from, /** @type {unknown} */ to) =>
    push(diff.breaking, { kind: 'binding-changed', op, docPath: opPath(op) + '/http/' + member, from, to, rule: 'R3', note: member });
  if (aOp.kind !== bOp.kind) {
    push(diff.breaking, { kind: 'binding-changed', op, docPath: opPath(op) + '/kind', from: aOp.kind, to: bOp.kind, rule: 'R3', note: 'kind' });
  }
  if (aOp.http.method !== bOp.http.method) emit('method', aOp.http.method, bOp.http.method);
  const aShape = pathShape(aOp.http.template);
  const bShape = pathShape(bOp.http.template);
  if (aShape !== bShape) emit('path', aOp.http.path, bOp.http.path);
  if (aOp.http.status !== bOp.http.status) emit('status', aOp.http.status, bOp.http.status);
  if (aOp.http.media !== bOp.http.media) emit('media', aOp.http.media, bOp.http.media);
  if (aOp.http.opaque !== bOp.http.opaque) emit('media', aOp.http.opaque, bOp.http.opaque);
  if (aOp.http.body !== bOp.http.body) emit('body', aOp.http.body, bOp.http.body);
  for (const m of new Set([...Object.keys(aOp.http.in), ...Object.keys(bOp.http.in)])) {
    const from = aOp.http.in[m];
    const to = bOp.http.in[m];
    if (from !== undefined && to !== undefined && from !== to) {
      push(diff.breaking, {
        kind: 'binding-changed', op, docPath: opPath(op) + '/http/in/' + encodeJSONPointerSegment(m),
        from, to, rule: 'R3', note: `member '${m}' moved`,
      });
    }
  }
}

/**
 * Declared errors: codes and statuses by R10/R11; a changed `details`
 * schema is a construct the table does not model, so it reports (R15).
 * @param {ContractDiff} diff
 * @param {CompiledOperation} aOp
 * @param {CompiledOperation} bOp
 */
function compareErrors(diff, aOp, bOp) {
  const op = aOp.id;
  for (const code of new Set([...Object.keys(aOp.errors), ...Object.keys(bOp.errors)])) {
    const at = opPath(op) + '/errors/' + encodeJSONPointerSegment(code);
    const from = aOp.errors[code];
    const to = bOp.errors[code];
    if (from !== undefined && to === undefined) {
      push(diff.breaking, { kind: 'error-removed', op, docPath: at, from: code, rule: 'R10' });
      continue;
    }
    if (from === undefined && to !== undefined) {
      push(diff.additive, { kind: 'error-added', op, docPath: at, to: code, rule: 'R11' });
      continue;
    }
    if (from === undefined || to === undefined) continue;
    if (from.status !== to.status) {
      push(diff.breaking, { kind: 'error-status-changed', op, docPath: at + '/status', from: from.status, to: to.status, rule: 'R10' });
    }
    if (canon(from.schema) !== canon(to.schema)) {
      push(diff.unknown, {
        kind: 'error-schema-changed', op, docPath: at + '/schema', from: from.schema, to: to.schema,
        rule: 'R15', note: 'the rule table does not model error-schema evolution',
      });
    }
  }
}

/**
 * Policy: `idempotency` by R12, the client-observable rest by R13.
 * @param {ContractDiff} diff
 * @param {CompiledOperation} aOp
 * @param {CompiledOperation} bOp
 */
function comparePolicy(diff, aOp, bOp) {
  const op = aOp.id;
  const at = (/** @type {string} */ m) => opPath(op) + '/policy/' + m;
  const from = aOp.policy;
  const to = bOp.policy;
  if (from.idempotency !== to.idempotency) {
    const tightened = to.idempotency === 'required';
    push(tightened ? diff.breaking : diff.additive, {
      kind: tightened ? 'idempotency-required' : 'idempotency-relaxed',
      op, docPath: at('idempotency'), from: from.idempotency, to: to.idempotency, rule: 'R12',
    });
  }
  const neutral = /** @type {[string, unknown, unknown][]} */ ([
    ['task', from.task, to.task],
    ['retry', from.retry, to.retry],
    ['cache', from.cache, to.cache],
    ['revision', from.revision, to.revision],
  ]);
  for (const [member, before, after] of neutral) {
    if (canon(before) !== canon(after)) {
      push(diff.neutral, { kind: 'policy-changed', op, docPath: at(member), from: before, to: after, rule: 'R13' });
    }
  }
  // a stream's resume policy, heartbeat or patch bound is the stream's
  // behaviour, not its wire shape — neutral, but for one move: a slower
  // heartbeat breaks an older client, whose watchdog, armed from its own
  // contract, declares the stream lost at twice the interval it expects
  const beatBefore = from.stream === null ? null : from.stream.heartbeatMs;
  const beatAfter = to.stream === null ? null : to.stream.heartbeatMs;
  const slower = typeof beatBefore === 'number' && typeof beatAfter === 'number' && beatAfter > beatBefore;
  if (slower) {
    push(diff.breaking, {
      kind: 'heartbeat-slowed', op, docPath: at('stream') + '/heartbeatMs', from: beatBefore, to: beatAfter, rule: 'R13',
      note: 'an older client arms its watchdog from its own contract and reports the stream lost (JC2094) after twice the interval it expects',
    });
  }
  const rest = (/** @type {any} */ stream) => (stream === null || !slower ? stream : { ...stream, heartbeatMs: null });
  if (canon(rest(from.stream)) !== canon(rest(to.stream))) {
    push(diff.neutral, { kind: 'policy-changed', op, docPath: at('stream'), from: from.stream, to: to.stream, rule: 'R13' });
  }
  if ((aOp.doc ?? null) !== (bOp.doc ?? null)) {
    push(diff.neutral, { kind: 'doc-changed', op, docPath: opPath(op) + '/doc', from: aOp.doc, to: bOp.doc, rule: 'R13' });
  }
}

//#endregion

/**
 * @param {unknown} value
 * @returns {Contract}
 */
function asCompiled(value) {
  if (isCompiledContract(value)) return /** @type {Contract} */ (value);
  return compileContract(value); // a document; a bad one refuses with its own JC00xx
}

/**
 * Classify every change from contract `a` to contract `b` by the §13
 * rule table. Takes compiled contracts or raw documents (documents are
 * compiled, so a malformed one refuses with its compile error before any
 * comparison). Operations whose `policy.audience` is `server` on BOTH
 * sides are outside the compatibility surface and are skipped — unless
 * `options.audience` is `'all'`, an internal gate's choice, which runs
 * the same rules on them and marks each of their changes `audience:
 * 'server'`. An audience flip is R14; for public consumers it subsumes
 * the operation's other changes, and under `'all'` they are compared too,
 * each marked `audience: 'server'`.
 * @param {Contract | Record<string, unknown>} a - the contract consumers hold today
 * @param {Contract | Record<string, unknown>} b - the contract they would meet
 * @param {{ audience?: 'public' | 'all' }} [options] - a closed set (`JC1008`)
 * @returns {ContractDiff}
 * @example
 * const { breaking } = diffContracts(v1Doc, v2Doc);
 * if (breaking.length > 0) throw new Error(breaking.map((c) => `${c.rule} ${c.op}: ${c.kind}`).join('\n'));
 */
export function diffContracts(a, b, options = undefined) {
  const audience = diffAudience(options);
  const A = asCompiled(a);
  const B = asCompiled(b);
  /** @type {ContractDiff} */
  const diff = { breaking: [], additive: [], neutral: [], unknown: [] };
  /** @type {Side} */
  const sideA = { doc: A.doc, anchors: collectSameDocumentAnchors(A.doc) };
  /** @type {Side} */
  const sideB = { doc: B.doc, anchors: collectSameDocumentAnchors(B.doc) };

  for (const id of new Set([...A.ids, ...B.ids])) {
    const aOp = Object.hasOwn(A.operations, id) ? A.operations[id] : null;
    const bOp = Object.hasOwn(B.operations, id) ? B.operations[id] : null;
    const marks = CLASSES.map((name) => diff[name].length);
    const server = compareOperation(diff, id, aOp, bOp, sideA, sideB, audience);
    // under `audience: 'all'`, every change of a server operation says so
    if (server) {
      CLASSES.forEach((name, i) => {
        for (let j = marks[i]; j < diff[name].length; j++) diff[name][j].audience = 'server';
      });
    }
  }
  return diff;
}

/** The four classes, in the order a diff lists them. */
const CLASSES = /** @type {const} */ (['breaking', 'additive', 'neutral', 'unknown']);

/**
 * The audience a diff reads: `'public'` by default (server-audience
 * operations are outside the compatibility surface and skipped), or
 * `'all'` for an internal gate, where the same rules run on them too.
 * @param {unknown} options
 * @returns {'public' | 'all'}
 */
function diffAudience(options) {
  if (options === undefined) return 'public';
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new ContractHostError('JC1008', 'diffContracts: options must be an object');
  }
  for (const key of Object.keys(options)) {
    if (key !== 'audience') throw new ContractHostError('JC1008', `diffContracts: options has no member '${key}' (it reads audience)`);
  }
  const audience = /** @type {any} */ (options).audience;
  if (audience === undefined) return 'public';
  if (audience !== 'public' && audience !== 'all') {
    throw new ContractHostError('JC1008', "diffContracts: options.audience is 'public' or 'all'");
  }
  return audience;
}

/**
 * Classify one operation's changes into `diff`. Answers whether the
 * changes it recorded belong to a server-audience operation (only ever
 * true under `audience: 'all'`).
 * @param {ContractDiff} diff
 * @param {string} id
 * @param {CompiledOperation | null} aOp
 * @param {CompiledOperation | null} bOp
 * @param {Side} sideA
 * @param {Side} sideB
 * @param {'public' | 'all'} audience
 * @returns {boolean}
 */
function compareOperation(diff, id, aOp, bOp, sideA, sideB, audience) {
  const all = audience === 'all';
  if (aOp !== null && bOp === null) {
    if (all || aOp.policy.audience !== 'server') {
      push(diff.breaking, { kind: 'operation-removed', op: id, docPath: opPath(id), rule: 'R1' });
    }
    return aOp.policy.audience === 'server';
  }
  if (aOp === null && bOp !== null) {
    if (all || bOp.policy.audience !== 'server') {
      push(diff.additive, { kind: 'operation-added', op: id, docPath: opPath(id), rule: 'R2' });
    }
    return bOp.policy.audience === 'server';
  }
  if (aOp === null || bOp === null) return false;
  if (aOp.policy.audience !== bOp.policy.audience) {
    const narrowed = bOp.policy.audience === 'server';
    push(narrowed ? diff.breaking : diff.additive, {
      kind: narrowed ? 'audience-narrowed' : 'audience-widened',
      op: id, docPath: opPath(id) + '/policy/audience',
      from: aOp.policy.audience, to: bOp.policy.audience, rule: 'R14',
    });
    // for a public client the flip is the whole story; an internal gate
    // also sees what changed inside the operation its server callers used
    if (!all) return false;
    const marks = CLASSES.map((name) => diff[name].length);
    compareInside(diff, id, aOp, bOp, sideA, sideB);
    CLASSES.forEach((name, i) => {
      for (let j = marks[i]; j < diff[name].length; j++) diff[name][j].audience = 'server';
    });
    return false;
  }
  if (aOp.policy.audience === 'server' && !all) return false; // invisible on both sides
  compareInside(diff, id, aOp, bOp, sideA, sideB);
  return aOp.policy.audience === 'server';
}

/**
 * One operation's binding, input, output, errors and policy, both sides present.
 * @param {ContractDiff} diff
 * @param {string} id
 * @param {CompiledOperation} aOp
 * @param {CompiledOperation} bOp
 * @param {Side} sideA
 * @param {Side} sideB
 */
function compareInside(diff, id, aOp, bOp, sideA, sideB) {
  compareBinding(diff, aOp, bOp);
  compareInput(diff, aOp, bOp, sideA, sideB);
  const outSink = schemaSink(diff, id, opPath(id) + '/output', 'output');
  compareSchema(aOp.output.schema, bOp.output.schema, '', sideA, sideB, outSink, new Map());
  compareErrors(diff, aOp, bOp);
  comparePolicy(diff, aOp, bOp);
}
