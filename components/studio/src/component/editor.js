//@ts-check
/**
 * @file The editor + rail vnode primitives — the baseline IDE, graduated
 * from the site's studio-kit. Everything is a plain `@jarenjs/view` vnode
 * (a tagged array), so the whole IDE renders through the same JSLT engine
 * the rest of the suite uses; no imperative editor widget, no syntax
 * highlighting (a later concern). The concrete kind→badge map lives here;
 * its colours are in `styles/studio.css`.
 */

/**
 * A baseline code editor: a `<textarea>` with the ergonomics that keep it
 * from fighting the shell (no browser resize — the splitter owns width;
 * spell/autocap/autocorrect off so a mobile keyboard does not rewrite
 * JSON keys). Tab-to-indent and the debounce live in the shell's edit
 * loop; the value is bound to the active file.
 *
 * `inputAction` is load-bearing, not a convenience: this is a CONTROLLED
 * textarea, and the renderer reasserts a control's authoritative value
 * after every settled render. If the document only learned about an edit
 * on `change` (blur), any render in between would rewrite the box with
 * the still-stale text — and writing `.value` clears the browser's
 * dirty-value flag, so `change` would then never fire and the typing
 * would vanish. Publishing each keystroke to the typing buffer keeps the
 * authoritative value equal to what the user typed, so the reassert is a
 * no-op and the caret survives.
 * @param {{ value: any, action: string, inputAction?: string, rows?: number,
 *   readonly?: boolean }} options
 */
export function editorTextarea(options) {
  return ['textarea', {
    class: 'js-editor-input',
    rows: options.rows ?? 20,
    spellcheck: 'false',
    autocapitalize: 'off',
    autocorrect: 'off',
    autocomplete: 'off',
    value: options.value,
    ...(options.readonly === true ? { readonly: '' } : {}),
    on: options.inputAction === undefined
      ? { change: options.action }
      : { input: options.inputAction, change: options.action },
  }];
}

/** One line of the docked error strip. */
export function errorLine(content) {
  return ['p', { class: 'js-errorline' }, content];
}

/**
 * The five concrete kind badge classes (colours are CONSTANTS in
 * studio.css, not aliased status tokens): view (blue), query (cyan),
 * json (slate), model (green), flow (amber).
 */
export const KIND_BADGE = Object.freeze({
  app: 'view', jslt: 'view', query: 'query', state: 'json',
  data: 'json', schema: 'json', model: 'model', fsm: 'flow', dag: 'flow',
});
