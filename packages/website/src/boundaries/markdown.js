//@ts-check
/**
 * One shared Markdown visual component (`@jarenjs/md/component`) for the
 * whole site. The playground's Markdown tab and the docs-page README
 * dialog both derive their vnodes through `md.view(...)`, so they share
 * one memo cache: the same source string renders to the same
 * reference-equal vnode, which the DOM patcher skips in O(1).
 *
 * The mermaid plugin is compiled in so fenced ```mermaid diagrams in
 * fetched READMEs render to inline SVG through @jarenjs/mermaid (the
 * engine dogfooding itself on the live site).
 *
 * It is also the one home for repository URL building: the raw and
 * human-facing bases, the README address for a workspace directory, and
 * the link rewriter that resolves a fetched document's own relative
 * links against them.
 */

import { createMdComponent } from '@jarenjs/md/component';
import { highlightPlugin } from '@jarenjs/md/plugins';
import { mermaidPlugin } from '@jarenjs/mermaid/plugin';

/** The raw-content base every README (and README-relative doc) loads from. */
export const RAW = 'https://raw.githubusercontent.com/jklarenbeek/jarenjs/refs/heads/main';

/** The human-facing GitHub base for repo paths that are not Markdown. */
export const REPO = 'https://github.com/jklarenbeek/jarenjs';

/**
 * A repo-relative path, as a raw URL. Every repo document the site opens
 * is addressed through here or through the link rewriter below — one
 * place builds these URLs, so the docs rail, a rewritten in-document
 * link, the dialog's trail and the fetch handler behind them cannot
 * disagree about where a document lives.
 * @param {string} path - Repo-relative file path.
 * @returns {string}
 */
export const rawUrl = (path) => `${RAW}/${path}`;

/**
 * `rawUrl`'s inverse: the repo-relative path a raw URL addresses, or
 * null for a URL that is not under the raw base at all.
 * @param {string} url
 * @returns {string | null}
 */
export const rawPath = (url) =>
  (url.startsWith(`${RAW}/`) ? url.slice(RAW.length + 1) : null);

/**
 * A workspace directory's README, as a raw URL.
 * @param {string} dir - Repo-relative workspace directory.
 * @returns {string}
 */
export const readmeUrl = (dir) => rawUrl(`${dir}/README.md`);

// theme 'host': diagram cssVars reference the site tokens, so memoized
// SVGs follow light/dark live (docs/DESIGN.md §7)
// headingIds/headingAnchors: every heading gets a GitHub-compatible `id`
// and a copy-a-link affordance, so a committed README's own
// `[see below](#the-section)` links land here exactly as they do on
// GitHub. No `slugPrefix`: the documents this renders are repo-authored,
// so an id they mint is one the site chose to trust. That reasoning is
// what the prefix exists for, and it belongs to the SOURCE, not to this
// component — a surface rendering markdown from anywhere else must set
// the prefix rather than inherit the decision made here.
export const md = createMdComponent({
  plugins: [highlightPlugin(), mermaidPlugin({ theme: 'host', interactive: true })],
  headingIds: true,
  headingAnchors: true,
});

//#region README-relative links
// A fetched README is written for the repository, so its links are
// repo-relative (`./docs/DATES.md`, `../formats`). Rendered verbatim in
// the dialog they resolve against the SITE origin, where none of those
// paths exist — the browser falls through to the 404 page and the
// reader lands back on the home page. This walk rewrites each relative
// anchor into what the reader actually meant:
//
//   *.md            -> stay in the dialog: a `readme/navigate` binding
//                      (preventDefault) that loads the resolved raw URL;
//                      the href still points at the raw file, so
//                      open-in-new-tab keeps working
//   a directory     -> that directory's README.md, in the dialog
//   any other file  -> the human-facing GitHub page, in a new tab
//   the site itself -> close the dialog and route in-app: an absolute
//                      link to a published page would otherwise change
//                      the hash BEHIND the open modal, which reads as a
//                      dead link
//
//   an #anchor      -> stay put: a `readme/anchor` binding
//                      (preventDefault) that scrolls to the heading;
//                      the hash router must never see the fragment
//
// Relative image sources resolve to the raw base the same way, so a
// README's own images load. Other absolute URLs and mailto: pass through
// untouched. The dialog's title for a navigated
// document is its repo path — the package names belong to the docs
// page's own buttons.

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** The published site root: absolute links here route in-app instead. */
const SITE = 'https://jklarenbeek.github.io/jarenjs/';

/** A dot in the last path segment means a file, not a directory —
 * except the all-caps extensionless files (LICENSE) which are files. */
function isDirectoryPath(path) {
  const last = path.slice(path.lastIndexOf('/') + 1);
  if (last === '' || last.includes('.'))
    return last === '';
  return last !== last.toUpperCase();
}

/** The rewritten anchor for a repo-relative href, or null to keep it. */
function rewriteAnchor(props, base) {
  const href = props.href;
  if (typeof href !== 'string' || href === '')
    return null;
  if (href.startsWith('#')) {
    // An in-page fragment, on a hash-routed site. Left alone it sets
    // `location.hash`, which the router reads as a PAGE name: `#setup` is
    // not a known page, so the reader is thrown out of the document they
    // were reading and onto the home page. The fragment is handled here
    // instead — scroll to the heading, leave the route alone.
    return {
      ...props,
      on: {
        click: { action: 'readme/anchor', with: { id: href.slice(1) }, preventDefault: true },
      },
    };
  }
  // Fragment-only mode (no base): every other rewrite here resolves a
  // repo-relative href, and a surface with no repository behind it has
  // nothing to resolve against.
  if (base === null)
    return null;
  if (href.startsWith('//'))
    return null;
  if (href.startsWith(SITE)) {
    // a link to the site the reader is already on: routing behind an
    // open modal is invisible, so close the dialog and navigate
    const hash = href.slice(SITE.length) || '#/';
    return {
      ...props,
      href: hash,
      on: {
        click: { action: 'readme/goto', with: { hash }, preventDefault: true },
      },
    };
  }
  if (SCHEME.test(href))
    return null;
  let resolved;
  try {
    resolved = new URL(href, base).href;
  }
  catch {
    return null;
  }
  const prefix = `${RAW}/`;
  if (!resolved.startsWith(prefix))
    return null;
  const repoPath = resolved.slice(prefix.length).replace(/\/+$/, '');
  if (/\.md$/i.test(repoPath)) {
    return {
      ...props,
      href: resolved,
      on: {
        click: {
          action: 'readme/navigate',
          with: { title: repoPath, url: resolved },
          preventDefault: true,
        },
      },
    };
  }
  if (isDirectoryPath(repoPath)) {
    const title = `${repoPath}/README.md`;
    return {
      ...props,
      href: `${REPO}/tree/main/${repoPath}`,
      on: {
        click: {
          action: 'readme/navigate',
          with: { title, url: `${prefix}${title}` },
          preventDefault: true,
        },
      },
    };
  }
  return { ...props, href: `${REPO}/blob/main/${repoPath}`, target: '_blank', rel: 'noopener' };
}

/** A relative image source, resolved against the raw base, or null. */
function rewriteImage(props, base) {
  const src = props.src;
  if (base === null || typeof src !== 'string' || src === '' || src.startsWith('#')
    || src.startsWith('//') || SCHEME.test(src))
    return null;
  try {
    return { ...props, src: new URL(src, base).href };
  }
  catch {
    return null;
  }
}

/** Walk a vnode, rebuilding only the paths that actually change. */
function rewriteNode(node, base) {
  if (!Array.isArray(node))
    return node;
  // a FRAGMENT — an array of vnodes with no tag — walks from index 0;
  // treating it as a tagged vnode would skip its first child, which is
  // exactly where a document's first list or paragraph lives
  if (typeof node[0] !== 'string') {
    let out = node;
    for (let i = 0; i < node.length; i++) {
      const child = rewriteNode(node[i], base);
      if (child !== node[i]) {
        if (out === node)
          out = node.slice();
        out[i] = child;
      }
    }
    return out;
  }
  const props = node.length > 1 && node[1] !== null && typeof node[1] === 'object'
    && !Array.isArray(node[1]) ? node[1] : null;
  let out = node;
  if (props !== null && (node[0] === 'a' || node[0] === 'img')) {
    const rewritten = node[0] === 'a' ? rewriteAnchor(props, base) : rewriteImage(props, base);
    if (rewritten !== null) {
      out = node.slice();
      out[1] = rewritten;
    }
  }
  for (let i = props !== null ? 2 : 1; i < node.length; i++) {
    const child = rewriteNode(node[i], base);
    if (child !== node[i]) {
      if (out === node)
        out = node.slice();
      out[i] = child;
    }
  }
  return out;
}

/** @type {WeakMap<object, {base: string, article: any}>} per-article memo,
 * so the rewritten tree is as reference-stable as md.view's own output */
const rewriteCache = new WeakMap();

/**
 * The article vnode with its repo-relative links made navigable from
 * the README dialog. Memoized per (article, base): the same fetched
 * source at the same URL yields the same vnode reference, which the
 * DOM patcher skips in O(1) exactly like the unrewritten article.
 * @param {any} article - `md.view(source)` output
 * @param {string|null} base - the raw URL the source was fetched from
 * @returns {any}
 */
export function rewriteReadmeLinks(article, base) {
  if (article === null || typeof base !== 'string')
    return article;
  const cached = rewriteCache.get(article);
  if (cached !== undefined && cached.base === base)
    return cached.article;
  const rewritten = rewriteNode(article, base);
  rewriteCache.set(article, { base, article: rewritten });
  return rewritten;
}

/**
 * An article rendered for any surface OTHER than the README dialog,
 * with its in-page fragments made navigable.
 *
 * A `#fragment` href is inert markup as far as the emitter is concerned,
 * and on a hash-routed site an inert one is worse than useless: clicking
 * it sets `location.hash`, the router reads that as a PAGE name, and the
 * reader is thrown out of the document. The dialog has handled this
 * since heading anchors shipped; every other surface did not, which was
 * a trap waiting for the first document with a table of contents.
 *
 * Footnotes made it a live one: a citation is a link to `#…fn-1` and its
 * back-reference is a link to `#…fnref-1`, so any markdown with a
 * footnote rendered on the play, studio or assistant surfaces carried
 * two fragments that would navigate away from the page. This is the same
 * rewrite the dialog does, minus the repo-relative resolution those
 * surfaces have no base for.
 *
 * @param {any} article - `md.view(source)` output
 * @returns {any}
 */
export function mdArticle(article) {
  if (article === null) return article;
  const cached = fragmentCache.get(article);
  if (cached !== undefined) return cached;
  const rewritten = rewriteNode(article, null);
  fragmentCache.set(article, rewritten);
  return rewritten;
}

/** @type {WeakMap<object, any>} the same per-article memo, for the
 * fragment-only rewrite: reference-stable in, reference-stable out */
const fragmentCache = new WeakMap();

//#endregion
