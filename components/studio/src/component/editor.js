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
 * @param {{ value: any, action: string, rows?: number, readonly?: boolean }} options
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
    on: { change: options.action },
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
