//@ts-check
/**
 * A window onto an app the crew built: the app document mounted with
 * `@jarenjs/app` inside the OS, as its own app with its own state. The
 * document is data the contract validated block by block, so mounting
 * it runs nothing but the app runtime interpreting JSON. A new document
 * (the crew built another block) is a fresh mount; the server render is
 * the app's first frame.
 */

import { createApp } from '@jarenjs/app';

/**
 * @typedef {{ app: any, label?: string }} MiniProps
 */

/** The widget definition. */
export const miniWidget = {
  /**
   * @param {HTMLElement} host @param {MiniProps} props
   * @param {(binding: any, event?: any) => void} _emit @param {{ document?: Document }} [context]
   */
  mount(host, props, _emit, context) {
    const handle = { host, doc: context?.document ?? host.ownerDocument, app: /** @type {any} */ (null), current: null };
    open(handle, props.app);
    return handle;
  },
  /** @param {any} handle @param {MiniProps} props */
  update(handle, props) {
    if (props.app !== handle.current) open(handle, props.app);
  },
  /** @param {any} handle */
  unmount(handle) {
    handle.app?.destroy();
  },
  /** @param {MiniProps} props */
  ssr(props) {
    const app = createApp(props.app, {});
    const vnode = app.getVnode();
    app.destroy();
    return vnode;
  },
};

/** Mount (or remount) a document in the widget's host. @param {any} handle @param {any} doc */
function open(handle, doc) {
  handle.app?.destroy();
  handle.host.textContent = '';
  handle.current = doc;
  // a block that misbehaves stays inside its app: the studio around it goes on
  handle.app = createApp(doc, { node: handle.host, document: handle.doc, onError: () => {} });
}
