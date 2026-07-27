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
 */

import { createMdComponent } from '@jarenjs/md/component';
import { highlightPlugin } from '@jarenjs/md/plugins';
import { mermaidPlugin } from '@jarenjs/mermaid/plugin';

import { RAW, REPO } from '../content/packages.js';

// theme 'host': diagram cssVars reference the site tokens, so memoized
// SVGs follow light/dark live (DESIGN.md §7)
export const md = createMdComponent({ plugins: [highlightPlugin(), mermaidPlugin({ theme: 'host' })] });

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
//
// Absolute URLs, mailto: and in-page #anchors pass through untouched.
// The dialog's title for a navigated document is its repo path — the
// package names belong to the docs page's own buttons.

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

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
  if (typeof href !== 'string' || href === '' || href.startsWith('#')
    || href.startsWith('//') || SCHEME.test(href))
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

/** Walk a vnode, rebuilding only the paths that actually change. */
function rewriteNode(node, base) {
  if (!Array.isArray(node))
    return node;
  const props = node.length > 1 && node[1] !== null && typeof node[1] === 'object'
    && !Array.isArray(node[1]) ? node[1] : null;
  let out = node;
  if (node[0] === 'a' && props !== null) {
    const rewritten = rewriteAnchor(props, base);
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

//#endregion
