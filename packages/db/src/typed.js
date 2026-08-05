//@ts-check
/**
 * @file The typed-store binding: a zero-cost identity whose ONLY job
 * is carrying the generated `EntityMetaMap` into the type system —
 * `typedStore<EntityMetaMap>(store)` narrows `entity(name)` to the
 * generated document/input shapes and widens `load` results by their
 * include specification. The runtime is the store it was given; every
 * guarantee lives in `types/typed.d.ts` and the generated artifact.
 */

/**
 * Bind a store to its generated entity metadata. Identity at runtime.
 * @template E
 * @param {any} store - an opened store whose model generated `E`
 * @returns {any}
 */
export function typedStore(store) {
  return store;
}
