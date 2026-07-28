//@ts-check
/**
 * @file `@jarenjs/view/helpers` — the shared, view-layer helper kernel:
 * SVG vnode builders over `h()`, the URL policies that guard what may
 * reach an `href`/`src`, and the prefix-driven theme resolver that
 * SVG-emitting components (`@jarenjs/calc`, `@jarenjs/mermaid`, …) build
 * on. Import the whole barrel (`@jarenjs/view/helpers`) or a single module
 * (`@jarenjs/view/helpers/svg`, `@jarenjs/view/helpers/url`,
 * `@jarenjs/view/helpers/theme`).
 */

export { sanitizeHref, sanitizeUrl, encodeUrlAttribute } from './url.js';

export {
  num,
  coord,
  polarPoint,
  anchorForAngle,
  svgRoot,
  group,
  rect,
  circle,
  line,
  path,
  polyline,
  polygon,
  textAt,
  textLines,
  polylinePath,
} from './svg.js';

export { resolveTheme } from './theme.js';
export { measureText, textWidth } from './metrics.js';
