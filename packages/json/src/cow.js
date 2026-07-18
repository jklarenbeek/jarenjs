//#region copy-on-write machinery (package-internal)
// The shared copy-on-write core of the JSON Patch engine (patch.js) and
// the standalone write operations (write.js). Extracted verbatim from
// patch.js. Like segments.js, this module is package-internal and is
// deliberately not listed in the package exports.
//
// An application of writes carries a state `{ root, owned }` where
// `owned` is the set of nodes this application created and may mutate
// freely (`null` = in-place mode: every node is owned). The first write
// along a path shallow-clones the spine from the root down; later writes
// find the spine in the owned set and mutate the clones in place. The
// input document is never touched.
//
// Step encoding shared by the walk/read helpers: a location is a pair of
// parallel arrays `names`/`indexes`.
//   - RFC 6901 form (patch.js, pointer targets): `names[i]` is the
//     decoded token, `indexes[i]` its pre-scanned array-index form
//     (-1 = not a valid index). One token, two forms.
//   - Typed form (JSONPath-derived targets): a name selector stores
//     `names[i] = name, indexes[i] = -1`; an index selector stores
//     `names[i] = null, indexes[i] = index` (negative = from the end).
// `readSteps` resolves either form; the callers own their walk loops so
// each module raises its own error types.

const hasOwn = Object.hasOwn;

export function isJsonObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function isContainer(v) {
  return typeof v === 'object' && v !== null;
}

// A member named '__proto__' must become an own data property, never a
// prototype assignment (the setMember discipline of the query engine).
export function setObjectMember(out, name, value) {
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

// Object spread copies an own '__proto__' data property as an own
// property (CreateDataProperty semantics), so it is pollution-safe here.
export function shallowCloneNode(v) {
  return Array.isArray(v) ? v.slice() : { ...v };
}

export function cloneJson(value) {
  if (!isContainer(value))
    return value;
  if (Array.isArray(value)) {
    const len = value.length;
    const out = new Array(len);
    for (let i = 0; i < len; i++)
      out[i] = cloneJson(value[i]);
    return out;
  }
  const out = {};
  for (const key in value) {
    if (hasOwn(value, key))
      setObjectMember(out, key, cloneJson(value[key]));
  }
  return out;
}

/**
 * The mutable state of one write application. `owned` is the set of
 * nodes this application created and may mutate freely; `null` means
 * in-place mode (every node is owned).
 */
export function makeState(root, owned) {
  return { root, owned };
}

/** Ensure the root is owned before the first write into it. */
export function ownedRoot(state) {
  const root = state.root;
  const owned = state.owned;
  if (owned === null || !isContainer(root) || owned.has(root))
    return root;
  const clone = shallowCloneNode(root);
  owned.add(clone);
  state.root = clone;
  return clone;
}

/**
 * Return an owned version of `child`, writing the clone back into the
 * (already owned) parent slot when one is taken.
 */
export function ownedChild(state, parent, child, key) {
  const owned = state.owned;
  if (owned === null || !isContainer(child) || owned.has(child))
    return child;
  const clone = shallowCloneNode(child);
  owned.add(clone);
  // the slot was just read through hasOwn/index, so plain assignment
  // never reaches a prototype '__proto__' setter
  parent[key] = clone;
  return clone;
}

/**
 * The concrete array index a step addresses in `parent`, or -1 when the
 * step cannot address an array element. Typed index steps resolve
 * negative indexes from the end; the RFC 6901 form never does.
 */
export function stepArrayIndex(parent, name, index) {
  if (name === null)
    return index < 0 ? parent.length + index : index;
  return index;
}

/**
 * Read the location `steps[0..len)` in `root` without cloning anything.
 * Returns the shared NOTHING-style `miss` sentinel value passed in when
 * the location does not exist (callers pick their own sentinel).
 */
export function readSteps(root, names, indexes, len, miss) {
  let v = root;
  for (let i = 0; i < len; i++) {
    if (Array.isArray(v)) {
      const idx = stepArrayIndex(v, names[i], indexes[i]);
      if (idx < 0 || idx >= v.length)
        return miss;
      v = v[idx];
    }
    else if (typeof v === 'object' && v !== null) {
      const name = names[i];
      if (name === null || !hasOwn(v, name))
        return miss;
      v = v[name];
    }
    else {
      return miss;
    }
  }
  return v;
}

//#endregion
