//@ts-check
/**
 * @file URL safety policies for values written into vnode attributes.
 *
 * A URL that reaches an `href`/`src` can execute script (`javascript:`,
 * `vbscript:`) or smuggle a whole document into the page's origin
 * (`data:text/html`), so every producer that turns *authored* text into a
 * vnode must filter it. This module is the one home for that decision.
 *
 * There are deliberately **two** policies, because the safe answer depends
 * on where the URL came from, and picking the wrong one is the trap this
 * file exists to prevent:
 *
 * - {@link sanitizeHref} is an **allow-list**: only the listed schemes and
 *   anchor/absolute/dot-relative forms survive. Use it for URLs from a
 *   constrained producer that is expected to emit fully-formed links — a
 *   Mermaid `click` directive, say. It rejects a bare relative reference
 *   like `image.png`, which is correct there and wrong for prose.
 * - {@link sanitizeUrl} is a **deny-list**: it rejects the schemes that can
 *   execute or impersonate a document and passes everything else,
 *   including scheme-less relative references. Use it for URLs authored in
 *   ordinary content — Markdown link destinations and image sources — where
 *   `docs/guide.md` and `image.png` must keep working.
 *
 * Both return the trimmed URL or `null`; a `null` means the caller should
 * drop the attribute rather than emit an unsafe one.
 */

/** URL forms permitted on a link `href` by the allow-list policy. */
const RE_SAFE_URL = /^(https?:|mailto:|#|\/|\.)/i;

/** Schemes that can execute script or carry a document of their own. */
const UNSAFE_SCHEMES = new Set(['javascript', 'vbscript', 'data', 'file']);

/**
 * The `data:` payloads an `<img>` legitimately wants. Raster only —
 * `image/svg+xml` is excluded because an SVG document can carry script,
 * and the contexts that make it inert are not ours to assume.
 */
const RE_SAFE_DATA_IMAGE = /^data:image\/(?:gif|png|jpe?g|webp|avif)[;,]/i;

/** Everything RFC 3986 does not allow inside a scheme name. */
const RE_NOT_SCHEME_CHAR = /[^a-z0-9+.-]/gi;

/**
 * The scheme a browser will act on, or `''` when the URL is relative.
 *
 * Characters that cannot occur in a scheme are dropped rather than treated
 * as a mismatch, because a browser drops the whitespace and control
 * characters inside one before resolving the URL: a tab in the middle of
 * `java<TAB>script:` does not stop it navigating as `javascript:`, so a
 * literal comparison would wave it through. A `/` before the colon does
 * keep the URL relative — it is dropped too, but so is the rest of the
 * path, and what remains no longer spells a dangerous scheme.
 *
 * @param {string} url a trimmed URL
 * @returns {string} the lower-cased scheme, without its colon
 */
function schemeOf(url) {
  const colon = url.indexOf(':');
  if (colon < 0) return '';
  return url.slice(0, colon).replace(RE_NOT_SCHEME_CHAR, '').toLowerCase();
}

/**
 * Reject `javascript:`/`data:` and other non-http(s) URLs, returning the
 * trimmed URL when it is safe or `null` otherwise. An **allow-list**: a
 * scheme-less relative reference (`image.png`) is rejected too, so reach
 * for {@link sanitizeUrl} when relative references must survive.
 *
 * @param {any} url
 * @returns {string|null}
 */
export function sanitizeHref(url) {
  if (typeof url !== 'string') return null;
  const trimmed = url.trim();
  return RE_SAFE_URL.test(trimmed) ? trimmed : null;
}

/**
 * Reject only the URL schemes that can execute script or stand in for a
 * document — `javascript:`, `vbscript:`, `file:` and `data:` other than a
 * raster image — and pass everything else through, including scheme-less
 * relative references. The **deny-list** policy for authored content.
 *
 * The scheme is read with {@link schemeOf}, which is deliberately not a
 * literal prefix test — see there for why an embedded tab or NUL does not
 * get a URL past this.
 *
 * @param {any} url
 * @returns {string|null} the trimmed URL, or `null` when it must be dropped
 */
export function sanitizeUrl(url) {
  if (typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (!UNSAFE_SCHEMES.has(schemeOf(trimmed))) return trimmed;
  return RE_SAFE_DATA_IMAGE.test(trimmed) ? trimmed : null;
}
