//#region Jaren JSLT dispatcher
// Compiles match paths, schema predicates, and query bodies once, then
// evaluates transformations through ranked per-mode dispatch tables.

import {
  compileJSONPath,
  JSONPathSyntaxError,
} from '../path.js';
import {
  appendName,
  compileSegmentP,
  runSegmentsP,
} from '../segments.js';
import {
  CARD_MANY,
  normalizeQuery,
} from '../query/normalize.js';
import {
  compileNode,
  UNBOUND,
} from '../query/compile.js';
import {
  JsonQueryCompileError,
  JsonQueryRuntimeError,
} from '../query/errors.js';
import {
  EMPTY,
  Seq,
  appendItem,
  seqOf,
} from '../query/runtime.js';
import {
  JsltCompileError,
  JsltRuntimeError,
} from './errors.js';

const hasOwn = Object.hasOwn;
const NO_RULE = Symbol('Jslt.NoRule');
const NO_EXTERNAL_VALUES = Object.freeze([]);
// The rebuild prune set of a matched-but-unfired location in an
// all-path-rule share mode: no child continues toward a match. Never
// mutated; rebuild walkers only test membership.
const NO_CHILDREN = new Set();

function composeDocPath(base, inner) {
  return inner.length === 0 ? base : base + inner;
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

// One compiled query per distinct match-path source string: rules across
// modes matching the same path share the object, so the per-call
// `.paths(root)` enumeration is computed once per transform (see
// getQueryPaths), not once per mode.
function compileMatchPath(rule, pathQueryCache) {
  const match = rule.match;
  if (match === null || match.path === null)
    return null;
  const cached = pathQueryCache.get(match.path);
  if (cached !== undefined)
    return cached;
  try {
    const query = compileJSONPath(match.path);
    pathQueryCache.set(match.path, query);
    return query;
  }
  catch (error) {
    if (!(error instanceof JSONPathSyntaxError))
      throw error;
    throw new JsltCompileError('JT0003',
      `invalid match path: ${error.message}`, match.pathDocPath, error);
  }
}

function compileMatchSchema(rule, compileTypeTest) {
  const match = rule.match;
  if (match === null || !match.schemaPresent)
    return null;
  if (compileTypeTest === null) {
    throw new JsltCompileError('JT0006',
      'schema matches require a type-test compiler (options.compileTypeTest)',
      match.schemaDocPath);
  }
  let test;
  try {
    test = compileTypeTest(match.schema, match.schemaDocPath);
  }
  catch (error) {
    throw new JsltCompileError('JT0005',
      `invalid match schema: ${errorText(error)}`, match.schemaDocPath, error);
  }
  if (typeof test !== 'function') {
    const cause = new TypeError('the type-test compiler did not return a predicate function');
    throw new JsltCompileError('JT0005', cause.message, match.schemaDocPath, cause);
  }
  return test;
}

function appendDispatched(acc, selected, targetMode, depth, tctx, dispatch) {
  if (selected === EMPTY)
    return;
  if (selected instanceof Seq) {
    const items = selected.items;
    for (let i = 0; i < items.length; i++)
      appendItem(acc, dispatch(items[i], null, targetMode, depth, tctx));
    return;
  }
  appendItem(acc, dispatch(selected, null, targetMode, depth, tctx));
}

function createApplyEntry(ruleBox, tableBox, targetModes) {
  return {
    result: () => CARD_MANY,
    normalize(arg, docPath, opPath, scope, ctx, helpers) {
      let selector;
      let targetMode = ruleBox.mode;
      if (!Array.isArray(arg)) {
        selector = helpers.normalizeExpr(arg, opPath, scope, ctx);
      }
      else {
        if (arg.length < 1 || arg.length > 2)
          helpers.fail('JQ0003', "'$apply' takes [selector] or [selector, mode]", opPath);
        selector = helpers.normalizeExpr(arg[0], opPath + '/0', scope, ctx);
        if (arg.length === 2) {
          if (typeof arg[1] !== 'string')
            helpers.fail('JQ0003', "the '$apply' mode must be a literal string", opPath + '/1');
          targetMode = arg[1];
        }
      }
      targetModes.add(targetMode);
      const args = [selector];
      if (Array.isArray(arg) && arg.length === 2) // the explicit-mode form
        args.push(helpers.makeRaw(targetMode, opPath + '/1'));
      return { args, card: CARD_MANY };
    },
    compile(gets, args) {
      const selector = args[0];
      const get = gets[0];
      const targetMode = args.length === 2 ? args[1].value : ruleBox.mode;
      // slots are final once normalizeQuery returns; snapshot them here
      const locSlot = ruleBox.locSlot;
      const depthSlot = ruleBox.depthSlot;
      const tctxSlot = ruleBox.tctxSlot;
      const currentPath = selector.kind === 'path'
        && selector.rootSlot === 0
        && selector.external === false;
      const rootPath = selector.kind === 'path'
        && selector.name === 'root'
        && selector.external === true;
      const locatedPath = currentPath || rootPath;
      const segs = locatedPath
        ? selector.segments.map(compileSegmentP)
        : null;

      return (frame) => {
        const tctx = frame[tctxSlot];
        const depth = frame[depthSlot] + 1;
        const dispatch = tableBox.dispatch;
        const acc = [];

        if (tableBox.needsLoc && locatedPath) {
          const baseLoc = currentPath ? frame[locSlot] : '$';
          if (baseLoc !== null) {
            const baseValue = currentPath ? frame[0] : frame[selector.rootSlot];
            const result = runSegmentsP(segs, baseValue, baseLoc, frame[0]);
            const vals = result.vals;
            const paths = result.paths;
            for (let i = 0; i < vals.length; i++)
              appendItem(acc, dispatch(vals[i], paths[i], targetMode, depth, tctx));
            return seqOf(acc);
          }
        }

        appendDispatched(acc, get(frame), targetMode, depth, tctx, dispatch);
        return seqOf(acc);
      };
    },
  };
}

function wrapBodyCompileError(rule, error) {
  throw new JsltCompileError('JT0007',
    `rule body failed to compile: ${error.message}`,
    composeDocPath(rule.bodyDocPath, error.docPath), error);
}

function compileBody(rule, compileTypeTest, tableBox, targetModes) {
  const ruleBox = {
    mode: rule.mode,
    locSlot: -1,
    depthSlot: -1,
    tctxSlot: -1,
  };
  const applyEntry = createApplyEntry(ruleBox, tableBox, targetModes);
  let normalized;
  let bodyGet;
  try {
    normalized = normalizeQuery(rule.body, {
      compileTypeTest,
      extensions: { '$apply': applyEntry },
    });
    ruleBox.locSlot = normalized.frameSize;
    ruleBox.depthSlot = normalized.frameSize + 1;
    ruleBox.tctxSlot = normalized.frameSize + 2;
    bodyGet = compileNode(normalized.root);
  }
  catch (error) {
    if (error instanceof JsonQueryCompileError)
      wrapBodyCompileError(rule, error);
    throw error;
  }

  const userExternals = [];
  let rootSlot = -1;
  let pathSlot = -1;
  let readsPath = false;
  const externals = normalized.externals;
  for (let i = 0; i < externals.length; i++) {
    const external = externals[i];
    if (external.name === 'root') {
      rootSlot = external.slot;
    }
    else if (external.name === 'path') {
      pathSlot = external.slot;
      readsPath = true;
    }
    else {
      userExternals.push(external);
    }
  }

  return {
    bodyGet,
    frameSize: normalized.frameSize,
    locSlot: ruleBox.locSlot,
    depthSlot: ruleBox.depthSlot,
    tctxSlot: ruleBox.tctxSlot,
    rootSlot,
    pathSlot,
    readsPath,
    userExternals,
  };
}

function makeBodyEvaluator(rule, body, userSlots) {
  const {
    bodyGet,
    frameSize,
    locSlot,
    depthSlot,
    tctxSlot,
    rootSlot,
    pathSlot,
  } = body;
  const ruleIndex = rule.index;
  const bodyDocPath = rule.bodyDocPath;
  const ruleDocPath = rule.docPath;
  const userCount = userSlots.length;
  const fullSize = frameSize + 3;

  return (value, loc, depth, tctx) => {
    const frame = new Array(fullSize);
    frame[0] = value;
    const externalValues = tctx.ruleExternalValues[ruleIndex];
    for (let i = 0; i < userCount; i++)
      frame[userSlots[i]] = externalValues[i];
    if (rootSlot >= 0)
      frame[rootSlot] = tctx.root;
    if (pathSlot >= 0)
      frame[pathSlot] = loc;
    frame[locSlot] = loc;
    frame[depthSlot] = depth;
    frame[tctxSlot] = tctx;

    try {
      return bodyGet(frame);
    }
    catch (error) {
      if (error instanceof JsltRuntimeError)
        throw error;
      if (!(error instanceof JsonQueryRuntimeError))
        throw error;
      const location = loc === null ? 'a location-less value' : `location ${loc}`;
      throw new JsltRuntimeError('JT2004',
        `rule ${ruleDocPath} failed at ${location}: ${error.message}`,
        composeDocPath(bodyDocPath, error.docPath), error);
    }
  };
}

function compileRules(model, compileTypeTest, tableBox, targetModes) {
  const rules = model.rules;
  const temporary = new Array(rules.length);
  const externalNames = [];
  const externalNameSet = new Set();
  let readsPath = false;

  const pathQueryCache = new Map();
  let pathRuleCount = 0;
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i];
    const pathQuery = compileMatchPath(rule, pathQueryCache);
    if (pathQuery !== null)
      pathRuleCount++;
    const test = compileMatchSchema(rule, compileTypeTest);
    const body = compileBody(rule, compileTypeTest, tableBox, targetModes);
    readsPath = readsPath || body.readsPath;
    const userExternals = body.userExternals;
    for (let j = 0; j < userExternals.length; j++) {
      const name = userExternals[j].name;
      if (!externalNameSet.has(name)) {
        externalNameSet.add(name);
        externalNames.push(name);
      }
    }
    temporary[i] = { rule, pathQuery, test, body };
  }

  const externalIndexes = new Map();
  for (let i = 0; i < externalNames.length; i++)
    externalIndexes.set(externalNames[i], i);

  const compiled = new Array(rules.length);
  for (let i = 0; i < temporary.length; i++) {
    const item = temporary[i];
    const userExternals = item.body.userExternals;
    const userSlots = new Array(userExternals.length);
    const userIndexes = new Array(userExternals.length);
    for (let j = 0; j < userExternals.length; j++) {
      userSlots[j] = userExternals[j].slot;
      userIndexes[j] = externalIndexes.get(userExternals[j].name);
    }
    const frozenSlots = Object.freeze(userSlots);
    const frozenIndexes = Object.freeze(userIndexes);
    compiled[i] = Object.freeze({
      index: item.rule.index,
      pathQuery: item.pathQuery,
      test: item.test,
      bodyEval: makeBodyEvaluator(item.rule, item.body, frozenSlots),
      userSlots: frozenSlots,
      userIndexes: frozenIndexes,
    });
  }

  return {
    rules: Object.freeze(compiled),
    externals: Object.freeze(externalNames),
    readsPath,
    // rules sharing one match path (across modes, the TOC/render idiom)
    // enumerate it once per transform call through tctx.queryPaths
    sharedQueries: pathRuleCount > pathQueryCache.size,
  };
}

//#region match pre-pass

// A mode's pre-pass is ONE Map from normalized path to a match entry.
// A matched location holds its rule bits directly (a nonzero mask, or a
// Set of ordinals past 32 path rules); a location on the spine of a
// deeper match holds a SpineEntry carrying both its own match (0 or
// undefined when none) and the set of child keys continuing toward a
// match. One lookup per dispatched node answers "does a rule match
// here", "can a rule match below", and "through which children" - so a
// share rebuild copies every other child by reference without building
// its path string. Invariant: every present key's proper ancestors are
// present with their child links, so prefix insertion stops at the
// first present prefix.

class SpineEntry {
  constructor(match, childKey) {
    this.match = match; // 0 (bit mode) / undefined (Set mode) when unmatched
    this.children = new Set([childKey]);
  }
}

// Decode one normalized-path segment `['name']` (with RFC 9535 section
// 2.7 escapes) into the raw member name, or `[123]` into the integer
// index - the exact key forms the built-in rebuild walks with.
function parseSegmentKey(path, start, end) {
  if (path.charCodeAt(start + 1) === 0x27) { // single quote: a member name
    const from = start + 2;
    const to = end - 2;
    let i = from;
    while (i < to && path.charCodeAt(i) !== 0x5C) // backslash
      i++;
    if (i === to)
      return path.slice(from, to);
    let out = path.slice(from, i);
    while (i < to) {
      if (path.charCodeAt(i) !== 0x5C) {
        out += path[i];
        i++;
        continue;
      }
      const esc = path.charCodeAt(i + 1);
      if (esc === 0x75) { // 'u': the \u00XX control-character form
        out += String.fromCharCode(parseInt(path.slice(i + 2, i + 6), 16));
        i += 6;
        continue;
      }
      if (esc === 0x62) out += '\b';
      else if (esc === 0x74) out += '\t';
      else if (esc === 0x6E) out += '\n';
      else if (esc === 0x66) out += '\f';
      else if (esc === 0x72) out += '\r';
      else out += path[i + 1]; // a quote or backslash escapes itself
      i += 2;
    }
    return out;
  }
  let index = 0;
  for (let i = start + 1; i < end - 1; i++)
    index = index * 10 + (path.charCodeAt(i) - 0x30);
  return index;
}

// Link `prefix -> childKey` into the pre-pass map. Returns true when the
// prefix was already present (its ancestors are then already linked).
function addSpineLink(matchMap, prefix, childKey, bitMode) {
  const entry = matchMap.get(prefix);
  if (entry === undefined) {
    matchMap.set(prefix, new SpineEntry(bitMode ? 0 : undefined, childKey));
    return false;
  }
  if (entry instanceof SpineEntry) {
    entry.children.add(childKey);
    return true;
  }
  // a matched-only entry becomes a spine entry keeping its match
  matchMap.set(prefix, new SpineEntry(entry, childKey));
  return true;
}

// Add every proper ancestor of one matched RFC 9535 normalized path,
// with its child link. Segment starts are '[' characters outside a
// quoted name; backslash escapes inside `['...']` skip the escaped code
// unit. Ancestors are linked longest-first so the presence invariant
// makes repeated spines O(1).
function addSpinePrefixes(path, matchMap, bitMode) {
  let positions = null;
  let quoted = false;
  for (let i = 1; i < path.length; i++) {
    const c = path.charCodeAt(i);
    if (quoted) {
      if (c === 0x5C) // backslash
        i++;
      else if (c === 0x27) // single quote
        quoted = false;
    }
    else if (c === 0x27) { // single quote
      quoted = true;
    }
    else if (c === 0x5B) { // '['
      if (positions === null)
        positions = [i];
      else
        positions.push(i);
    }
  }
  if (positions === null)
    return;
  let end = path.length;
  for (let j = positions.length - 1; j >= 0; j--) {
    const start = positions[j];
    const childKey = parseSegmentKey(path, start, end);
    if (addSpineLink(matchMap, path.slice(0, start), childKey, bitMode))
      return;
    end = start;
  }
}

// Every distinct match query enumerates the input once per transform
// call, however many modes (or ranked slots) reference it. Stylesheets
// without duplicate match paths bypass the cache (queryPaths === false).
function getQueryPaths(query, tctx) {
  let cache = tctx.queryPaths;
  if (cache === false)
    return query.paths(tctx.root);
  if (cache === null) {
    cache = new Map();
    tctx.queryPaths = cache;
  }
  const cached = cache.get(query);
  if (cached !== undefined)
    return cached;
  const paths = query.paths(tctx.root);
  cache.set(query, paths);
  return paths;
}

function buildBitPrepass(mode, tctx) {
  const matchMap = new Map();
  const queries = mode.pathQueries;
  for (let ordinal = 0; ordinal < queries.length; ordinal++) {
    const paths = getQueryPaths(queries[ordinal], tctx);
    const bit = 1 << ordinal;
    for (let i = 0; i < paths.length; i++) {
      const path = paths[i];
      const entry = matchMap.get(path);
      if (entry === undefined)
        matchMap.set(path, bit);
      else if (entry instanceof SpineEntry)
        entry.match |= bit;
      else
        matchMap.set(path, entry | bit);
      addSpinePrefixes(path, matchMap, true);
    }
  }
  return matchMap;
}

function buildSetPrepass(mode, tctx) {
  const matchMap = new Map();
  const queries = mode.pathQueries;
  for (let ordinal = 0; ordinal < queries.length; ordinal++) {
    const paths = getQueryPaths(queries[ordinal], tctx);
    for (let i = 0; i < paths.length; i++) {
      const path = paths[i];
      const entry = matchMap.get(path);
      if (entry === undefined) {
        matchMap.set(path, new Set([ordinal]));
      }
      else if (entry instanceof SpineEntry) {
        if (entry.match === undefined)
          entry.match = new Set([ordinal]);
        else
          entry.match.add(ordinal);
      }
      else {
        entry.add(ordinal);
      }
      addSpinePrefixes(path, matchMap, false);
    }
  }
  return matchMap;
}

function buildPrepass(mode, tctx) {
  const prepass = mode.bitMasks
    ? buildBitPrepass(mode, tctx)
    : buildSetPrepass(mode, tctx);
  tctx.prepasses[mode.id] = prepass;
  return prepass;
}

//#region roadmap
// A single-walk multi-pattern path matcher would replace the per-rule
// `.paths(root)` loop here. Schema-aware pruning can join the same mode
// metadata once predicates expose safe descendant impossibility facts.
// Location tracking is intentionally global today; a future reachability
// analysis can specialize it per connected set of modes.
//#endregion

//#endregion

function scanBitRules(mode, value, loc, depth, tctx, mask) {
  const pathBits = mode.pathBits;
  const tests = mode.tests;
  const bodyEvals = mode.bodyEvals;
  for (let i = 0; i < bodyEvals.length; i++) {
    // a zero mask also covers location-less values: no bit can be set
    const bit = pathBits[i];
    if (bit !== 0 && (mask & bit) === 0)
      continue;
    const test = tests[i];
    if (test !== null && !test(value))
      continue;
    return bodyEvals[i](value, loc, depth, tctx);
  }
  return NO_RULE;
}

function scanSetRules(mode, value, loc, depth, tctx, matched) {
  const pathOrdinals = mode.pathOrdinals;
  const tests = mode.tests;
  const bodyEvals = mode.bodyEvals;
  for (let i = 0; i < bodyEvals.length; i++) {
    const ordinal = pathOrdinals[i];
    if (ordinal >= 0 && (matched === undefined || !matched.has(ordinal)))
      continue;
    const test = tests[i];
    if (test !== null && !test(value))
      continue;
    return bodyEvals[i](value, loc, depth, tctx);
  }
  return NO_RULE;
}

function setObjectMember(out, name, value) {
  if (name === '__proto__') {
    Object.defineProperty(out, name, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  else {
    out[name] = value;
  }
}

function describeLocation(loc) {
  return loc === null ? 'a location-less value' : loc;
}

// `children` (a share-mode all-path-rules prune set, null otherwise)
// lists the only keys through which a deeper rule can still match:
// every other child is copied by reference without a dispatch and
// without building its normalized path.
function rebuildObject(value, loc, mode, depth, tctx, dispatchMode, fresh, children) {
  const out = {};
  let changed = fresh;
  for (const key in value) {
    if (!hasOwn(value, key))
      continue;
    if (children !== null && !children.has(key)) {
      setObjectMember(out, key, value[key]);
      continue;
    }
    const childLoc = loc === null ? null : appendName(loc, key);
    const child = dispatchMode(value[key], childLoc, mode, depth + 1, tctx);
    if (child === EMPTY) {
      changed = true;
      continue;
    }
    if (child instanceof Seq) {
      throw new JsltRuntimeError('JT2002',
        `member '${key}' at ${describeLocation(childLoc)} produced ${child.items.length} items`,
        mode.unmatchedPath);
    }
    setObjectMember(out, key, child);
    if (child !== value[key])
      changed = true;
  }
  return changed ? out : value;
}

function rebuildArray(value, loc, mode, depth, tctx, dispatchMode, fresh, children) {
  const out = [];
  let changed = fresh;
  for (let i = 0; i < value.length; i++) {
    if (children !== null && !children.has(i)) {
      out.push(value[i]);
      continue;
    }
    const childLoc = loc === null ? null : loc + '[' + i + ']';
    const child = dispatchMode(value[i], childLoc, mode, depth + 1, tctx);
    if (child === EMPTY) {
      changed = true;
    }
    else if (child instanceof Seq) {
      appendItem(out, child);
      changed = true;
    }
    else {
      out.push(child);
      if (child !== value[i])
        changed = true;
    }
  }
  return changed ? out : value;
}

// The share pruning decision lives in dispatchMode (one pre-pass lookup
// yields the match and the prune set); by the time the built-in rule
// rebuilds, descending is already known to be required or harmless.
function builtIn(value, loc, mode, depth, tctx, dispatchMode, children) {
  if (mode.unmatched === 'error') {
    throw new JsltRuntimeError('JT2003',
      `no rule in mode ${JSON.stringify(mode.name)} matched ${describeLocation(loc)}`,
      mode.unmatchedPath);
  }

  if (typeof value !== 'object' || value === null)
    return value;

  const fresh = mode.unmatched === 'fresh';
  return Array.isArray(value)
    ? rebuildArray(value, loc, mode, depth, tctx, dispatchMode, fresh, children)
    : rebuildObject(value, loc, mode, depth, tctx, dispatchMode, fresh, children);
}

function compileMode(modelMode, compiledRules, id, fallbackUnmatched, fallbackPath) {
  const rankedRules = modelMode === null ? NO_EXTERNAL_VALUES : modelMode.rules;
  const name = modelMode === null ? '' : modelMode.name;
  const unmatched = modelMode === null ? fallbackUnmatched : modelMode.unmatched;
  const unmatchedPath = modelMode === null ? fallbackPath : modelMode.unmatchedPath;
  let pathCount = 0;
  let allPathRules = true;
  for (let i = 0; i < rankedRules.length; i++) {
    const compiled = compiledRules[rankedRules[i].index];
    if (compiled.pathQuery === null)
      allPathRules = false;
    else
      pathCount++;
  }

  const bitMasks = pathCount <= 32;
  const pathBits = bitMasks ? new Array(rankedRules.length) : null;
  const pathOrdinals = bitMasks ? null : new Array(rankedRules.length);
  const pathQueries = new Array(pathCount);
  const tests = new Array(rankedRules.length);
  const bodyEvals = new Array(rankedRules.length);
  const ruleIndexes = new Array(rankedRules.length);
  let ordinal = 0;
  for (let i = 0; i < rankedRules.length; i++) {
    const compiled = compiledRules[rankedRules[i].index];
    if (compiled.pathQuery === null) {
      if (bitMasks)
        pathBits[i] = 0;
      else
        pathOrdinals[i] = -1;
    }
    else {
      pathQueries[ordinal] = compiled.pathQuery;
      if (bitMasks)
        pathBits[i] = 1 << ordinal;
      else
        pathOrdinals[i] = ordinal;
      ordinal++;
    }
    tests[i] = compiled.test;
    bodyEvals[i] = compiled.bodyEval;
    ruleIndexes[i] = compiled.index;
  }

  return Object.freeze({
    id,
    name,
    unmatched,
    unmatchedPath,
    // Every rule of a share-mode chain requires a positional match: a
    // value without a match entry (off-spine, or location-less) can fire
    // nothing here or below and returns by reference without a scan.
    // Covers the zero-rule share mode (vacuously all-path).
    shareAllPaths: unmatched === 'share' && allPathRules,
    bitMasks,
    pathQueries: Object.freeze(pathQueries),
    pathBits: pathBits === null ? null : Object.freeze(pathBits),
    pathOrdinals: pathOrdinals === null ? null : Object.freeze(pathOrdinals),
    tests: Object.freeze(tests),
    bodyEvals: Object.freeze(bodyEvals),
    ruleIndexes: Object.freeze(ruleIndexes),
  });
}

function buildModes(model, compiledRules, targetModes) {
  const modelModes = new Map();
  const names = [];
  for (let i = 0; i < model.modes.length; i++) {
    const mode = model.modes[i];
    modelModes.set(mode.name, mode);
    names.push(mode.name);
  }
  for (const name of targetModes) {
    if (!modelModes.has(name)) {
      modelModes.set(name, null);
      names.push(name);
    }
  }

  const modes = new Map();
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const modelMode = modelModes.get(name);
    const runtime = modelMode === null
      ? Object.freeze({
          ...compileMode(null, compiledRules, i, model.unmatched, model.unmatchedPath),
          name,
        })
      : compileMode(modelMode, compiledRules, i, model.unmatched, model.unmatchedPath);
    modes.set(name, runtime);
  }
  return { modes, count: names.length };
}

function resolveExternalValues(externalNames, compiledRules, ext) {
  const globalValues = new Array(externalNames.length);
  for (let i = 0; i < externalNames.length; i++) {
    const name = externalNames[i];
    globalValues[i] = ext != null && hasOwn(ext, name) ? ext[name] : UNBOUND;
  }

  const ruleValues = new Array(compiledRules.length);
  for (let i = 0; i < compiledRules.length; i++) {
    const indexes = compiledRules[i].userIndexes;
    if (indexes.length === 0) {
      ruleValues[i] = NO_EXTERNAL_VALUES;
      continue;
    }
    const values = new Array(indexes.length);
    for (let j = 0; j < indexes.length; j++)
      values[j] = globalValues[indexes[j]];
    ruleValues[i] = values;
  }
  return ruleValues;
}

/**
 * Compile a normalized stylesheet model into the reusable transformation
 * evaluator and its user-external metadata.
 * @param {object} model - result of normalizeJsltStylesheet
 * @param {object} [options] - compile options
 * @returns {{evaluate: Function, externals: readonly string[]}}
 */
export function compileJsltDispatch(model, options = {}) {
  const compileTypeTest = typeof options.compileTypeTest === 'function'
    ? options.compileTypeTest
    : null;
  const maxDepth = options.maxDepth === undefined ? 1024 : options.maxDepth;
  if (!Number.isInteger(maxDepth) || maxDepth < 0)
    throw new TypeError('options.maxDepth must be a non-negative integer');

  const tableBox = {
    dispatch: null,
    needsLoc: false,
  };
  const targetModes = new Set();
  const compiled = compileRules(model, compileTypeTest, tableBox, targetModes);
  tableBox.needsLoc = model.anyPathRule || compiled.readsPath;
  const built = buildModes(model, compiled.rules, targetModes);
  const modes = built.modes;
  const rootMode = modes.get('');

  function dispatchMode(value, loc, mode, depth, tctx) {
    if (depth > maxDepth) {
      throw new JsltRuntimeError('JT2001',
        `dispatch depth ${depth} exceeded maxDepth ${maxDepth}`,
        mode.unmatchedPath);
    }
    if (depth > tctx.highestDepth)
      tctx.highestDepth = depth;

    // location-less values can never match a path rule; modes reached
    // only through location-less items never pay for a pre-pass
    let match; // rule bit mask (bit mode) or Set of ordinals, or undefined
    let children = null;
    if (loc !== null && mode.pathQueries.length !== 0) {
      let prepass = tctx.prepasses[mode.id];
      if (prepass === undefined)
        prepass = buildPrepass(mode, tctx);
      const entry = prepass.get(loc);
      if (entry !== undefined) {
        if (entry instanceof SpineEntry) {
          match = entry.match;
          children = entry.children;
        }
        else {
          match = entry;
        }
      }
    }
    if (mode.shareAllPaths) {
      // every rule needs a positional match: values without one (and all
      // location-less values) can fire nothing here or anywhere below
      if (children === null) {
        if (match === undefined)
          return value;
      }
      else if (match === undefined || match === 0) {
        // on the spine of a deeper match only: descend without a scan
        return builtIn(value, loc, mode, depth, tctx, dispatchMode, children);
      }
    }
    const matched = mode.bitMasks
      ? scanBitRules(mode, value, loc, depth, tctx, match === undefined ? 0 : match)
      : scanSetRules(mode, value, loc, depth, tctx, match);
    if (matched !== NO_RULE)
      return matched;
    return builtIn(value, loc, mode, depth, tctx, dispatchMode,
      mode.shareAllPaths ? (children === null ? NO_CHILDREN : children) : null);
  }

  function dispatch(value, loc, modeName, depth, tctx) {
    const mode = modes.get(modeName);
    /* c8 ignore next 2 -- every static $apply target is registered at compile time */
    if (mode === undefined)
      throw new Error(`JSLT internal error: mode ${JSON.stringify(modeName)} was not compiled`);
    return dispatchMode(value, loc, mode, depth, tctx);
  }

  tableBox.dispatch = dispatch;
  Object.freeze(tableBox);

  if (rootMode.bodyEvals.length === 0 && rootMode.unmatched === 'share') {
    return Object.freeze({
      evaluate: (data) => data,
      externals: compiled.externals,
    });
  }

  const modeCount = built.count;
  const externalNames = compiled.externals;
  const compiledRules = compiled.rules;
  const sharedQueries = compiled.sharedQueries;
  const rootLoc = tableBox.needsLoc ? '$' : null;
  // the all-unbound resolution is a compile-time constant; calls without
  // user bindings (the common case) share it instead of re-resolving
  const unboundRuleValues = resolveExternalValues(externalNames, compiledRules, null);
  return Object.freeze({
    evaluate(data, ext) {
      const tctx = {
        root: data,
        ruleExternalValues: ext == null || externalNames.length === 0
          ? unboundRuleValues
          : resolveExternalValues(externalNames, compiledRules, ext),
        prepasses: new Array(modeCount),
        queryPaths: sharedQueries ? null : false,
        highestDepth: 0,
      };
      try {
        return dispatchMode(data, rootLoc, rootMode, 0, tctx);
      }
      catch (error) {
        // A synchronous JavaScript stack can be shallower than the
        // language's default 1024-dispatch guard. Never expose the host
        // RangeError for a recursive dispatch chain; preserve JT2001 as
        // the public resource-guard condition.
        if (error instanceof RangeError && tctx.highestDepth > 32) {
          throw new JsltRuntimeError('JT2001',
            `dispatch recursion exhausted the host call stack before maxDepth ${maxDepth}`,
            rootMode.unmatchedPath);
        }
        throw error;
      }
    },
    externals: externalNames,
  });
}

//#endregion
