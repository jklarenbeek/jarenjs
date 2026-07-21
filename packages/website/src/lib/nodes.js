//@ts-check
/**
 * Builders for the kind-tagged render-node vocabulary. Boundaries emit
 * these plain-JSON nodes; the 'ui' view mode renders each kind with one
 * generic rule. This is the site's component library — as data.
 */

/** A row of stat cards. */
export const cards = (items) => ({
  kind: 'cards',
  items: items.map((i) => ({ kind: 'card', ...i, note: i.note ?? null })),
});

/** A titled table; rows are `{ cells: string[], strong?: boolean }`. */
export const table = (title, head, rows, note) => ({
  kind: 'table', title, head, note: note ?? null,
  rows: rows.map((r) => ({ kind: 'row', strong: false, ...r })),
});

/** An informational block with an optional link button. */
export const callout = (title, text, href, link) =>
  ({ kind: 'callout', title, text, href: href ?? null, link: link ?? null });

/** A code block; `badge` renders next to the title. */
export const code = (title, text, badge) =>
  ({ kind: 'code', title: title ?? null, text, badge: badge ?? null });

/** An error block in the engine-error shape (code/docPath/dataPath/position). */
export function error(err, fallbackTitle) {
  const parts = [];
  if (err.code) parts.push(`code: ${err.code}`);
  if (err.docPath !== undefined && err.docPath !== null) {
    parts.push(`docPath: ${err.docPath === '' ? '"" (document root)' : err.docPath}`);
  }
  if (err.dataPath !== undefined && err.dataPath !== null) {
    parts.push(`dataPath: ${err.dataPath === '' ? '"" (document root)' : err.dataPath}`);
  }
  if (typeof err.position === 'number') parts.push(`position: ${err.position}`);
  if (typeof err.line === 'number') parts.push(`line: ${err.line}`);
  if (typeof err.column === 'number') parts.push(`column: ${err.column}`);
  if (err.hint) parts.push(`hint: ${err.hint}`);
  return {
    kind: 'error',
    title: err.code ?? fallbackTitle ?? err.name ?? 'Error',
    message: err.message ?? String(err),
    detail: parts.length > 0 ? parts.join(' · ') : null,
  };
}

/** A collapsible section of further nodes. */
export const details = (summary, items) => ({ kind: 'details', summary, items });

/** An SVG chart card: `vnode` is @jarenjs/charts' projection (charts
 * carry their own internal title; `title` adds a card heading only when
 * the SVG has none). */
export const chart = (title, vnode, note) =>
  ({ kind: 'chart', title: title ?? null, vnode, note: note ?? null });

/** A rendered Markdown preview: `vnode` is @jarenjs/md's projection. */
export const markdown = (title, vnode) =>
  ({ kind: 'markdown', title: title ?? null, vnode });

/** A live search input bound to the given action. */
export const search = (action, value, placeholder) =>
  ({ kind: 'search', action, value, placeholder });

/** A "show more" button bound to the given action. */
export const more = (action, label) => ({ kind: 'more', action, label });
