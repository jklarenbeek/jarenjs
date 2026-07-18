//@ts-check
/**
 * @file The standard form rules — the shipped JSLT rule set that renders
 * any `@jarenjs/forms` view model (`buildFormViewModel`) to vnodes, and
 * the standard action documents that write user input back into the
 * state. Everything both factories return is PLAIN JSON: no functions,
 * no imports from forms — the rules dispatch on the view-model *shape*
 * (JSONPath filter selectors on `control`), which is the whole point of
 * the format stack.
 *
 * Wiring (see the README for the complete walkthrough):
 *
 *   view:    [...createFormView(), { match: '$', body: [..., { $apply: '$.form' }] }]
 *   actions: { ...createFormActions({ dataPointer: '/data' }) }
 *   options: { viewModel: (state) => ({ form: buildFormViewModel(model, state.data, { rules }) }) }
 *
 * Known 0.1 limitations, documented rather than hidden: select controls
 * write the DOM's string value (string enums recommended); a cleared
 * number input writes `null` (surfaces as a validation error, not a
 * dispatch error); tuple fields render but expose no add/remove.
 */

/** The default action names shared by both factories. */
const DEFAULT_ACTIONS = Object.freeze({
  input: 'form/input',
  check: 'form/check',
  number: 'form/number',
  add: 'form/add',
  remove: 'form/remove',
});

/**
 * Options shared by `createFormView` / `createFormActions`.
 * @typedef {Object} FormViewOptions
 * @property {string} [root] - JSONPath of the form view-model node inside
 *   the view input document (default `'$.form'`).
 * @property {string} [classPrefix] - CSS class prefix (default `'jaren-form'`).
 * @property {Record<string, string>} [actions] - Overrides for the
 *   standard action names (`input`/`check`/`number`/`add`/`remove`).
 * @property {string} [addLabel] - Add-item button text (default `'+'`).
 * @property {string} [removeLabel] - Remove-item button text (default `'×'`).
 * @property {string} [dataPointer] - (actions) JSON Pointer to the form
 *   data inside the app state (default `'/data'`).
 */

/**
 * The standard form rule set: a JSLT rule array rendering a
 * `buildFormViewModel` tree. Concatenate it into an app's view
 * stylesheet and `{"$apply": "<root>"}` the form node from a page rule.
 *
 * @param {FormViewOptions} [options]
 * @returns {any[]} A JSLT rule array (plain JSON).
 */
export function createFormView(options = {}) {
  const root = options.root ?? '$.form';
  const cls = options.classPrefix ?? 'jaren-form';
  const act = { ...DEFAULT_ACTIONS, ...options.actions };
  /** Match any view-model node under `root` with the given control. */
  const ctl = (control) => `${root}..[?@.control == '${control}']`;

  const disabled = { $not: '$.enabled' };

  /** The shared field chrome around one control vnode. */
  const field = (control) => ['div', { class: `${cls}-field`, 'data-pointer': '$.pointer' },
    ['label', {},
      '$.label',
      { $if: ['$.required', ['span', { class: `${cls}-required`, 'aria-hidden': 'true' }, ' *']] },
      control,
    ],
    { $if: ['$.description', ['p', { class: `${cls}-description` }, '$.description']] },
    [{ $apply: '$.errors[*]' }],
    { $if: ['$.removable',
      ['button', {
        type: 'button',
        class: `${cls}-remove`,
        on: { click: { action: act.remove, with: { pointer: '$.pointer' } } },
      }, options.removeLabel ?? '×']] },
  ];

  // every write binding carries the element flag: the standard actions
  // pick RFC 6902 `replace` for array elements (where `add` would
  // insert) and `add` for object members (set-or-replace)
  const writeWith = { pointer: '$.pointer', element: '$.element' };

  /** A typed `<input>` control with the standard input binding. */
  const textInput = (type, action) => ['input', {
    type,
    value: '$.value',
    placeholder: '$.placeholder',
    readonly: '$.readOnly',
    disabled,
    on: { input: { action, with: writeWith } },
  }];

  const rules = [
    // the form root: a section holding the top-level fields
    {
      match: root,
      body: ['section', { class: cls },
        { $if: ['$.label', ['h3', { class: `${cls}-title` }, '$.label']] },
        [{ $apply: '$.children[*]' }],
        [{ $apply: '$.items[*]' }],
      ],
    },
    // nested objects: a fieldset group
    {
      match: ctl('object'),
      body: ['fieldset', { class: `${cls}-group`, 'data-pointer': '$.pointer' },
        { $if: ['$.label', ['legend', {}, '$.label']] },
        [{ $apply: '$.children[*]' }],
        [{ $apply: '$.errors[*]' }],
      ],
    },
    // arrays: expanded items plus the add-item button
    {
      match: ctl('array'),
      body: ['fieldset', { class: `${cls}-array`, 'data-pointer': '$.pointer' },
        { $if: ['$.label', ['legend', {}, '$.label']] },
        [{ $apply: '$.items[*]' }],
        { $if: [{ $exists: '$.addValue' },
          ['button', {
            type: 'button',
            class: `${cls}-add`,
            on: { click: { action: act.add, with: { pointer: '$.pointer', value: '$.addValue' } } },
          }, options.addLabel ?? '+']] },
        [{ $apply: '$.errors[*]' }],
      ],
    },
    // one error line per message
    {
      match: `${root}..errors[*]`,
      body: ['p', { class: `${cls}-error`, role: 'alert' }, '$'],
    },
    // select: options are precomputed by the view model
    {
      match: `${root}..options[*]`,
      body: ['option', { value: '$.value', selected: '$.selected' }, '$.label'],
    },
    {
      match: ctl('select'),
      body: field(['select', {
        disabled,
        on: { change: { action: act.input, with: writeWith } },
      }, [{ $apply: '$.options[*]' }]]),
    },
    // boolean: checkbox with the checked binding
    {
      match: ctl('checkbox'),
      body: field(['input', {
        type: 'checkbox',
        checked: '$.value',
        disabled,
        on: { change: { action: act.check, with: writeWith } },
      }]),
    },
    // free text: textarea with the value as its text child
    {
      match: ctl('textarea'),
      body: field(['textarea', {
        placeholder: '$.placeholder',
        readonly: '$.readOnly',
        disabled,
        on: { input: { action: act.input, with: writeWith } },
      }, '$.value']),
    },
    // numbers: coerced by the standard number action
    { match: ctl('number'), body: field(textInput('number', act.number)) },
    // fixed values render as text
    { match: ctl('const'), body: field(['span', { class: `${cls}-const` }, '$.value']) },
    // the structured-JSON fallback control is out of scope for 0.1
    { match: ctl('json'), body: field(['em', { class: `${cls}-unsupported` }, 'unsupported field']) },
  ];

  // the text-input family: one rule per control, all through act.input
  for (const type of ['text', 'email', 'url', 'password', 'date', 'color']) {
    rules.push({ match: ctl(type), body: field(textInput(type, act.input)) });
  }
  return rules;
}

/**
 * The standard form actions: named query documents that write user
 * input into the form data at `dataPointer + payload.pointer`. RFC 6902
 * `add` is set-or-replace for object members, so untouched (absent)
 * fields are created on first input.
 *
 * @param {FormViewOptions} [options]
 * @returns {Record<string, any>} An `actions` fragment (plain JSON) to
 *   spread into an app document.
 */
export function createFormActions(options = {}) {
  const dataPointer = options.dataPointer ?? '/data';
  const act = { ...DEFAULT_ACTIONS, ...options.actions };
  const target = { $concat: [dataPointer, '$payload.pointer'] };
  // RFC 6902: `add` on an array index INSERTS (shifting later elements);
  // element nodes must be written with `replace` instead. The view-model
  // `element` flag travels through the binding payload.
  const writeOp = { $if: ['$payload.element', 'replace', 'add'] };
  return {
    [act.input]: {
      patch: [{ op: writeOp, path: target, value: '$event.value' }],
    },
    [act.check]: {
      patch: [{ op: writeOp, path: target, value: '$event.checked' }],
    },
    [act.number]: {
      patch: [{
        op: writeOp,
        path: target,
        // a cleared input writes null: a visible validation problem, not
        // a dispatch error
        value: { $if: [{ $ne: ['$event.value', ''] }, { $number: '$event.value' }, null] },
      }],
    },
    [act.add]: {
      patch: [{
        op: 'add',
        path: { $concat: [dataPointer, '$payload.pointer', '/-'] },
        value: '$payload.value',
      }],
    },
    [act.remove]: {
      patch: [{ op: 'remove', path: target }],
    },
  };
}
