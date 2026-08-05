//@ts-check
/**
 * @file The app binding for live queries (LIVE-FORMAT §10): GENERATED
 * documents plus a handler factory — the `fsmToApp` precedent. The db
 * package never imports `@jarenjs/app`; the app document declares a
 * subscription (`APP-FORMAT §5.3`) whose registered handler is
 * `createLiveSubscription(store)`, and a two-line action whose whole
 * body is `{ patch: '$payload' }` — the handler prefixes every op
 * with the declared state path, so the app loop applies live patches
 * with the machinery it already has.
 */

/**
 * Prefix every op path in a live patch with the state slot.
 * @param {any[]} patch
 * @param {string} statePath - JSON Pointer to the slot holding the
 *   live result document
 */
export function prefixLivePatch(patch, statePath) {
  return patch.map((op) => ({
    ...op,
    path: statePath + op.path,
    ...(op.from !== undefined ? { from: statePath + op.from } : {}),
  }));
}

/**
 * The generated documents (§10): a subscription entry and the
 * patch-forwarding action, both plain data for the app document.
 * @param {{ run?: string, action?: string, statePath: string,
 *   collection?: string, query: any, externals?: any, mode?: string,
 *   when?: any }} options
 * @returns {{ subscription: any, actions: any }}
 */
export function liveAppBinding(options) {
  if (typeof options?.statePath !== 'string' || !options.statePath.startsWith('/')) {
    throw new TypeError('liveAppBinding needs a statePath JSON Pointer');
  }
  if (options.query === undefined) {
    throw new TypeError('liveAppBinding needs the query document');
  }
  const run = options.run ?? 'db/live';
  const action = options.action ?? 'db/liveChanged';
  return {
    subscription: {
      run,
      with: {
        action,
        statePath: options.statePath,
        ...(options.collection !== undefined ? { collection: options.collection } : {}),
        query: options.query,
        ...(options.externals !== undefined ? { externals: options.externals } : {}),
        ...(options.mode !== undefined ? { mode: options.mode } : {}),
      },
      ...(options.when !== undefined ? { when: options.when } : {}),
    },
    actions: { [action]: { patch: '$payload' } },
  };
}

/**
 * The subscription handler factory: registers the live query when the
 * subscription starts, dispatches ONE initializing patch (a `replace`
 * of the whole slot), forwards each emission prefixed, and closes on
 * cleanup. An emission error surfaces as a dispatch of
 * `<action>/error` so the app can render it — silence is not an
 * option the format allows.
 * @param {any} store - an open store with capture
 * @returns {(props: any, dispatch: Function) => Function}
 */
export function createLiveSubscription(store) {
  return (props, dispatch) => {
    const { action, statePath, collection, query, externals, mode } = props;
    let closed = false;
    /** @type {any} */
    let live = null;
    const registration = collection !== undefined
      ? store.collection(collection).live(query, { externals, mode })
      : store.live(query, { externals, mode });
    registration.then((handle) => {
      if (closed) {
        handle.close();
        return;
      }
      live = handle;
      dispatch(action, [{ op: 'replace', path: statePath, value: handle.result }]);
      handle.subscribe((event) => {
        if (event.error !== undefined) {
          dispatch(`${action}/error`, {
            code: event.error.code, message: String(event.error.message ?? event.error),
          });
          return;
        }
        dispatch(action, prefixLivePatch(event.patch, statePath));
      });
    }, (error) => {
      if (!closed) {
        dispatch(`${action}/error`, {
          code: error.code, message: String(error.message ?? error),
        });
      }
    });
    return () => {
      closed = true;
      if (live !== null) live.close();
    };
  };
}
