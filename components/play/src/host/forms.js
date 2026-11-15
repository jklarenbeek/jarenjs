//@ts-check
/**
 * @file The actions the validate engine's generated form writes its
 * structured buffer (`/play/dataValue`) with, as app action documents.
 */

/** The patch op: a replace at the root pointer or on an array element, an add elsewhere. */
const OP = { $if: [{ $or: ['$payload.element', { $eq: ['$payload.pointer', ''] }] }, 'replace', 'add'] };
const PATH = { $concat: ['/play/dataValue', '$payload.pointer'] };

/**
 * The six standard form actions under play-scoped names (`play/f-input`,
 * `play/f-check`, `play/f-number`, `play/f-json`, `play/f-add`,
 * `play/f-remove`), writing into `/play/dataValue`. Unlike `@jarenjs/app`'s
 * `createFormActions` they treat the root pointer (`''`) as a `replace` (the
 * buffer always exists) and never remove a cleared member: a cleared text
 * control keeps `''`, so clearing a root-level control cannot leave the
 * buffer undefined for the mirror that serializes it.
 *
 * A number control's text is read by `numberValue`, the expression the
 * host's app runtime evaluates: pass `@jarenjs/app`'s `FORM_NUMBER_VALUE`,
 * so the form accepts exactly the number text the standard actions do
 * (`.5`, `-.5`, `01`; a cleared control is `null`).
 * @param {{ numberValue: any }} options
 * @returns {Record<string, { patch: any[] }>}
 */
export function playFormActions({ numberValue }) {
  /** @param {any} value */
  const write = (value) => ({ patch: [{ op: OP, path: PATH, value }] });
  return {
    'play/f-input': write('$event.value'),
    'play/f-check': write('$event.checked'),
    'play/f-number': write(numberValue),
    'play/f-json': write('$event.formJsonValue'),
    'play/f-add': { patch: [{ op: 'add', path: { $concat: ['/play/dataValue', '$payload.pointer', '/-'] }, value: '$payload.value' }] },
    'play/f-remove': { patch: [{ op: 'remove', path: PATH }] },
  };
}

/**
 * The options of `@jarenjs/app`'s `createFormView` for the generated form:
 * the render tree at `$.ui.play.dataForm`, its chrome at
 * `$.ui.play.formLabels` (both as `playDataForm` answers them), writing
 * through the {@link playFormActions}. A host merges the rules in the
 * component's mode: `createFormView(PLAY_FORM_VIEW).map((rule) => ({ ...rule,
 * mode: 'play' }))`.
 */
export const PLAY_FORM_VIEW = /* @__PURE__ */ Object.freeze({
  root: '$.ui.play.dataForm',
  labelsPath: '$.ui.play.formLabels',
  actions: /* @__PURE__ */ Object.freeze({
    input: 'play/f-input', check: 'play/f-check', number: 'play/f-number',
    json: 'play/f-json', add: 'play/f-add', remove: 'play/f-remove',
  }),
});
