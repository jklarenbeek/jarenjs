//@ts-check
/**
 * @file Document assembly: a builder tree in, one standard JSON Schema
 * document out — deep-frozen, `$defs` hoisted, every `$ref` resolved
 * against the definitions reachable from the root. This module reads
 * builder STATE and writes JSON; it imports no engine and constructs no
 * builder, so the pen never learns what a keyword means — the
 * validator's compiler stays the only judge of semantics. It refuses
 * exactly two things a document cannot carry faithfully: a definition
 * spelled twice or referenced but never defined (`JL0103`), and a
 * construct whose emitted form would mean something else (`JL0102`) —
 * closed objects under `allOf`, and a default or coercion in a branch
 * the normalizer never descends.
 */

import { cloneJson, deepFreeze, setObjectMember } from '@jarenjs/core/object';

import { LinqBuildError } from '../errors.js';
import { isSchemaBuilder } from './brand.js';

/** The `type` keyword a kind carries, where it carries one. */
const TYPED = Object.freeze({
  __proto__: null,
  string: 'string', number: 'number', integer: 'integer', boolean: 'boolean',
  null: 'null', object: 'object', record: 'object', array: 'array', tuple: 'array',
});

/** The three keywords `compileNormalizer` acts on. */
const NORMALIZER_KEYS = ['default', 'x-coerce', 'x-trim'];

/** A definition whose body is still being emitted (a cycle in progress). */
const PENDING = Symbol('pending');

/** @param {string} key a JSON pointer token, escaped per RFC 6901 */
const token = (key) => key.replaceAll('~', '~0').replaceAll('/', '~1');

/**
 * A hoisting context one or more roots share: every `named()` builder
 * they reach becomes one entry of a single `$defs` block, in
 * first-reference order. A schema document has one root; a contract
 * document's roots are its operations' `input`, `output` and error
 * schemas, so the same walk hoists a whole contract's definitions to
 * its own root.
 * @returns {any}
 */
export function createHoist() {
  return {
    /** @type {Map<string, any>} definition name → body, in discovery order */
    defs: new Map(),
    /** @type {Map<string, any>} definition name → the builder that owns it */
    owners: new Map(),
    /** @type {Map<string, string>} names demanded by `ref()` → where */
    demanded: new Map(),
  };
}

/**
 * Emit one builder into a shared hoisting context (`emitInto(builder,
 * ctx, at)`): the same walk `assemble` runs, with the definitions
 * landing in the caller's context instead of a private one.
 */
export { emitNode as emitInto };

/**
 * The `$defs` block a context collected, or `null` when it collected
 * none; every name a `ref()` demanded must be answered by then.
 * @param {any} ctx
 * @returns {any}
 */
export function hoistedDefs(ctx) {
  for (const [name, at] of ctx.demanded) {
    if (!ctx.defs.has(name)) {
      throw new LinqBuildError('JL0103',
        `ref('${name}') names no definition in this document — a name is defined by `
        + `named('${name}', …) somewhere the root can reach`, at);
    }
  }
  if (ctx.defs.size === 0) return null;
  const defs = {};
  for (const [name, body] of ctx.defs) setObjectMember(defs, name, body);
  return defs;
}

/**
 * Assemble the document of one builder.
 * @param {any} root - the builder whose document this is
 * @returns {any} the deep-frozen JSON Schema document
 */
export function assemble(root) {
  const ctx = createHoist();
  const doc = emitNode(root, ctx, '');
  const defs = hoistedDefs(ctx);
  if (defs === null) return deepFreeze(doc);
  const out = {};
  setObjectMember(out, '$defs', defs);
  if (typeof doc === 'boolean') {
    // a boolean root with definitions: nothing references them, but a
    // false root cannot carry them either
    throw new LinqBuildError('JL0102',
      'a boolean schema cannot carry $defs; name the root instead');
  }
  for (const key of Object.keys(doc)) setObjectMember(out, key, doc[key]);
  return deepFreeze(out);
}

/**
 * Whether a builder, or anything it reaches, carries a keyword the
 * normalizer acts on. Walked over the builder graph rather than over
 * emitted documents so a cycle in progress is no obstacle.
 * @param {any} builder
 * @param {Set<any>} seen
 * @returns {boolean}
 */
export function reachesNormalizer(builder, seen = new Set()) {
  if (!isSchemaBuilder(builder) || seen.has(builder)) return false;
  seen.add(builder);
  const st = builder.state;
  for (const [key] of st.annotations) {
    if (NORMALIZER_KEYS.includes(key)) return true;
  }
  return children(st).some((child) => reachesNormalizer(child, seen));
}

/** Every builder one state holds directly (lazy thunks resolved). */
function children(st) {
  switch (st.kind) {
    case 'object':
      return [...st.props.map(([, b]) => b), ...st.patterns.map(([, b]) => b),
        ...(st.names === null ? [] : [st.names])];
    case 'array':
      return st.contains === null ? [st.items] : [st.items, st.contains];
    case 'tuple':
      return st.rest === null ? st.items : [...st.items, st.rest];
    case 'record':
      return [st.values];
    case 'union': case 'discriminated': case 'intersection':
      return st.options;
    case 'named':
      return [st.target];
    case 'lazy':
      return [resolveLazy(st, '')];
    case 'when':
      return [st.cond, st.then, st.else].filter((b) => b !== null);
    default:
      return [];
  }
}

/**
 * The builder a `lazy()` stands for — always a named one, because an
 * anonymous recursion has no `$ref` to spell.
 * @param {any} st
 * @param {string} at
 */
function resolveLazy(st, at) {
  const target = st.thunk();
  if (!isSchemaBuilder(target)) {
    throw new LinqBuildError('JL0103',
      'lazy() must return a builder', at);
  }
  if (target.state.kind !== 'named') {
    throw new LinqBuildError('JL0103',
      'lazy() must return a NAMED builder — a recursion is spelled as a $ref, and a '
      + "$ref needs a definition to point at: lazy(() => Node) where Node = named('Node', …)",
      at);
  }
  return target;
}

/**
 * The kind a builder resolves to through `named`/`lazy` wrappers, or
 * `null` when it cannot be known here (a `ref` by name).
 * @param {any} builder
 * @param {string} at
 * @returns {any} the resolved builder, or null
 */
function resolve(builder, at) {
  let current = builder;
  for (let hops = 0; hops < 64; hops++) {
    const st = current.state;
    if (st.kind === 'named') current = st.target;
    else if (st.kind === 'lazy') current = resolveLazy(st, at);
    else return current;
  }
  return null;
}

/**
 * Refuse a normalizer keyword under a branch the normalizer never
 * descends (`anyOf`/`oneOf` options, `if`/`then`/`else`, `contains`,
 * `propertyNames`): a default there is never materialized and a
 * coercion never runs, so a document carrying one would promise a
 * normalization that does not happen.
 * @param {any} builder
 * @param {string} where - the keyword, for the message
 * @param {string} at
 */
function refuseNormalizerUnder(builder, where, at) {
  if (!reachesNormalizer(builder)) return;
  throw new LinqBuildError('JL0102',
    `a default(), coerce() or trim() under ${where} never runs — the normalizer does not `
    + 'descend that branch, so the document would promise a normalization that does not '
    + 'happen; move it to the member that holds the branch, or drop it', at);
}

/**
 * Emit one builder as a schema node, registering definitions as they
 * are discovered.
 * @param {any} builder
 * @param {any} ctx
 * @param {string} at - JSON pointer of this node in the document
 * @returns {any} a plain schema node (object or boolean)
 */
function emitNode(builder, ctx, at) {
  const st = builder.state;
  let node = emitCore(builder, st, ctx, at);
  if (st.nullable) node = nullableOf(node, st);
  if (st.checks.length > 0) {
    node.$query = st.checks.length === 1 ? st.checks[0] : { $and: st.checks };
  }
  for (const [key, value] of st.annotations) setObjectMember(node, key, value);
  return node;
}

/** Fold `null` into a typed node; wrap an untyped one in `anyOf`. */
function nullableOf(node, st) {
  if (TYPED[st.kind] !== undefined) {
    node.type = [TYPED[st.kind], 'null'];
    // a typed enum admits null only when the enum lists it
    if (Array.isArray(node.enum) && !node.enum.includes(null)) node.enum = [...node.enum, null];
    return node;
  }
  if (st.kind === 'enum') {
    if (!st.values.includes(null)) node.enum = [...st.values, null];
    return node;
  }
  if (st.kind === 'literal') return { enum: [st.value, null] };
  return { anyOf: [node, { type: 'null' }] };
}

/** The constraint keywords a builder collected, in the order set. */
function withKeywords(node, st) {
  for (const key of Object.keys(st.keywords)) node[key] = st.keywords[key];
  return node;
}

/**
 * The kind-specific core of a node: `type` and the structural
 * keywords, with the collected constraints after them.
 * @param {any} builder
 * @param {any} st
 * @param {any} ctx
 * @param {string} at
 * @returns {any}
 */
function emitCore(builder, st, ctx, at) {
  switch (st.kind) {
    case 'string': case 'number': case 'integer': case 'boolean': case 'null':
      return withKeywords({ type: st.kind }, st);
    case 'literal':
      return { const: st.value };
    case 'enum':
      return { enum: st.values };
    case 'any':
      return {};
    case 'never':
      return false;
    case 'raw':
      return cloneJson(st.json);
    case 'object': {
      const node = { type: 'object' };
      if (st.props.length > 0) {
        const properties = {};
        const required = [];
        for (const [key, member] of st.props) {
          setObjectMember(properties, key, emitNode(member, ctx, `${at}/properties/${token(key)}`));
          if (!member.state.optional) required.push(key);
        }
        node.properties = properties;
        if (required.length > 0) node.required = required;
      }
      if (!st.open) node.additionalProperties = false;
      if (st.patterns.length > 0) {
        const patternProperties = {};
        for (const [pattern, member] of st.patterns) {
          setObjectMember(patternProperties, pattern,
            emitNode(member, ctx, `${at}/patternProperties/${token(pattern)}`));
        }
        node.patternProperties = patternProperties;
      }
      if (st.names !== null) {
        refuseNormalizerUnder(st.names, 'propertyNames()', `${at}/propertyNames`);
        node.propertyNames = emitNode(st.names, ctx, `${at}/propertyNames`);
      }
      if (st.dependent !== null) node.dependentRequired = cloneJson(st.dependent);
      return withKeywords(node, st);
    }
    case 'record':
      return withKeywords({
        type: 'object',
        additionalProperties: emitNode(st.values, ctx, `${at}/additionalProperties`),
      }, st);
    case 'array': {
      const node = { type: 'array', items: emitNode(st.items, ctx, `${at}/items`) };
      if (st.contains !== null) {
        refuseNormalizerUnder(st.contains, 'contains()', `${at}/contains`);
        node.contains = emitNode(st.contains, ctx, `${at}/contains`);
      }
      return withKeywords(node, st);
    }
    case 'tuple': {
      const node = {
        type: 'array',
        prefixItems: st.items.map((item, i) => emitNode(item, ctx, `${at}/prefixItems/${i}`)),
      };
      if (st.rest !== null) node.items = emitNode(st.rest, ctx, `${at}/items`);
      node.minItems = st.items.length;
      return withKeywords(node, st);
    }
    case 'union': case 'discriminated': {
      const keyword = st.kind === 'union' ? 'anyOf' : 'oneOf';
      const options = st.options.map((option, i) => {
        refuseNormalizerUnder(option, `${st.kind}()`, `${at}/${keyword}/${i}`);
        return emitNode(option, ctx, `${at}/${keyword}/${i}`);
      });
      return { [keyword]: options };
    }
    case 'intersection': {
      const parts = st.options.map((part, i) => {
        const resolved = resolve(part, `${at}/allOf/${i}`);
        if (resolved !== null && resolved.state.kind === 'object' && !resolved.state.open) {
          throw new LinqBuildError('JL0102',
            'closed objects do not intersect — under allOf each part rejects the other\'s '
            + 'members, so the document would accept neither; open() the parts, or merge '
            + 'them with extend()', `${at}/allOf/${i}`);
        }
        return emitNode(part, ctx, `${at}/allOf/${i}`);
      });
      return { allOf: parts };
    }
    case 'when': {
      const node = {};
      refuseNormalizerUnder(st.cond, 'when()', `${at}/if`);
      node.if = emitNode(st.cond, ctx, `${at}/if`);
      if (st.then !== null) {
        refuseNormalizerUnder(st.then, 'then()', `${at}/then`);
        node.then = emitNode(st.then, ctx, `${at}/then`);
      }
      if (st.else !== null) {
        refuseNormalizerUnder(st.else, 'else()', `${at}/else`);
        node.else = emitNode(st.else, ctx, `${at}/else`);
      }
      return node;
    }
    case 'named':
      return define(st.name, st.target, ctx, at);
    case 'lazy': {
      const named = resolveLazy(st, at);
      return define(named.state.name, named.state.target, ctx, at);
    }
    case 'ref':
      if (!ctx.demanded.has(st.name)) ctx.demanded.set(st.name, at);
      return { $ref: `#/$defs/${st.name}` };
    /* c8 ignore next 2 -- states are produced by the builders alone */
    default:
      throw new LinqBuildError('JL0102', `unknown builder kind '${st.kind}'`, at);
  }
}

/**
 * Register a definition on first discovery (its body emitted in place,
 * so a cycle back to it meets the pending entry and stops) and answer
 * the reference to it. The same target under one name is one
 * definition, however many times it is reached; a different target is
 * a collision.
 * @param {string} name
 * @param {any} target
 * @param {any} ctx
 * @param {string} at
 */
function define(name, target, ctx, at) {
  const owner = ctx.owners.get(name);
  if (owner === undefined) {
    ctx.owners.set(name, target);
    ctx.defs.set(name, PENDING);
    ctx.defs.set(name, emitNode(target, ctx, `/$defs/${token(name)}`));
  }
  else if (owner !== target) {
    throw new LinqBuildError('JL0103',
      `two distinct builders are named '${name}' in one document — a $defs entry `
      + 'can hold one definition; rename one of them', at);
  }
  return { $ref: `#/$defs/${name}` };
}
