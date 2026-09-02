//#region pull helpers shared by the async serializers and readers
// The two facts every pull pipeline in this package relies on, written
// once: closing an upstream iterator exactly once (a consumer that stops
// early, an abort, a throw — never a source read to its end, whose
// `return()` would be a second close), and the rejection an abort
// carries (the signal's own reason, so a caller's `AbortError` is the
// one it sees).

/**
 * Close an iterator once, swallowing what the close throws: a source
 * that refuses its cancel is already gone.
 * @param {Iterator<any> | AsyncIterator<any>} iterator
 * @returns {Promise<void>}
 */
export async function closeIterator(iterator) {
  if (typeof iterator.return !== 'function')
    return;
  try {
    await iterator.return(undefined);
  }
  catch {
    // the upstream refused its close; nothing more can be done for it
  }
}

/**
 * The rejection of an aborted pull: the signal's reason when it has one,
 * else an `AbortError`-named error, as the platform spells it.
 * @param {AbortSignal} signal
 * @returns {unknown}
 */
export function abortedError(signal) {
  if (signal.reason !== undefined)
    return signal.reason;
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

//#endregion
