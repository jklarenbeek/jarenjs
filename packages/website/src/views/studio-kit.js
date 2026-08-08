//@ts-check
/**
 * @file The shared studio view pieces (extracted when the third studio
 * arrived): the editor textarea (hand-written six times before, same
 * five core props, one site's `readonly` taken as an option), the
 * error line (eight inline sites) and the phone pane switcher. The two
 * existing studios' template pickers differ in match path, mode AND
 * card structure, and the data studio has no picker, so that rule is
 * deliberately NOT extracted.
 *
 * The pane switcher is the site's half of a suite-wide protocol — see
 * `paneSwitcher` below. `@jarenjs/play` and `@jarenjs/studio` build the
 * same bar from their own sources: a published component owns its
 * markup and its stylesheet so it stands alone, which is why the
 * builder is shared by the two studios that live HERE and mirrored,
 * not imported, by the two that ship as packages.
 */

/**
 * The five-prop editor textarea.
 * @param {{ value: string, action: string, rows?: number,
 *   readonly?: boolean }} options
 */
export function editorTextarea(options) {
  return ['textarea', {
    class: 'editor',
    rows: options.rows ?? 22,
    spellcheck: 'false',
    value: options.value,
    ...(options.readonly === true ? { readonly: '' } : {}),
    on: { change: options.action },
  }];
}

/**
 * The error line.
 * @param {any} content - a query expression or literal text
 */
export function errorLine(content) {
  return ['p', { class: 'error-line' }, content];
}

/**
 * The phone pane switcher — a segmented bar that shows ONE pane at a
 * time below the breakpoint, the pattern `@jarenjs/play` established.
 *
 * The protocol is three parts, and every surface implements all three:
 * the pane container carries `data-pane` (the live pane id), this bar
 * carries the studio's own `-panebar` class plus the shared `seg`
 * control classes, and the studio's stylesheet hides the unselected
 * panes inside its `@media (max-width: 1024px)` block. Switching is a
 * SINGLE attribute write on the container — the panes stay mounted, so
 * a hidden editor keeps its caret, its scroll and its undo stack, and
 * nothing re-renders but the bar's two changed buttons.
 *
 * The segments are toggle buttons in a group, not a `tablist`: a pane
 * is a grid area, not a `tabpanel`, so `aria-pressed` states the truth
 * that `aria-selected` would overclaim.
 *
 * @param {{ pane: string, action: string, class: string,
 *   panes: [string, string][] }} options - `pane` is the query
 *   expression holding the live pane id, `panes` the `[id, label]`
 *   pairs in bar order
 */
export function paneSwitcher(options) {
  return ['div', { class: `${options.class} seg`, role: 'group', 'aria-label': 'pane' },
    ...options.panes.map(([id, label]) => ['button', {
      type: 'button',
      class: { $if: [{ $eq: [options.pane, id] }, 'seg-btn active', 'seg-btn'] },
      'aria-pressed': { $if: [{ $eq: [options.pane, id] }, 'true', 'false'] },
      on: { click: { action: options.action, with: id } },
    }, label]),
  ];
}
