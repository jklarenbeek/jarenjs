//@ts-check
/**
 * @file @jarenjs/view — the vnode JSON contract, the keyed DOM patcher
 * and the SSR string renderer. See README.md and docs/VIEW-FORMAT.md.
 */

export {
  EMPTY_PROPS,
  h,
  isTextNode,
  isElementNode,
  isSkippedNode,
  isSameNode,
  propsOf,
  keyOf,
  childrenOf,
} from './vnode.js';

export {
  createDomRenderer,
  styleToString,
} from './dom.js';

export {
  renderToString,
  escapeText,
  escapeAttribute,
} from './html.js';
