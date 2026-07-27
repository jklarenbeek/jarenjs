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
 * A DOM control's value is a STRING, and two of these controls carry
 * something else: a select over a non-string enum, and the `json`
 * editor over an arbitrary value. Both round-trip through the JSON text
 * the view model precomputes (`option.key`) or the operator types, and
 * both decode it in a registered event-field extractor —
 * {@link formEventFields}, the format's one sanctioned place for host
 * JavaScript at the DOM boundary (APP-FORMAT §5.4). A host that renders
 * these controls MUST register them.
 *
 * Remaining limitation, documented rather than hidden: a cleared number
 * input writes `null` (which surfaces as a validation error, not a
 * dispatch error).
 */

/** The default action names shared by both factories. */
const DEFAULT_ACTIONS = Object.freeze({
  input: 'form/input',
  check: 'form/check',
  number: 'form/number',
  json: 'form/json',
  add: 'form/add',
  remove: 'form/remove',
});

/**
 * The `$event` field name both JSON-carrying controls request.
 * @see formEventFields
 */
const JSON_FIELD = 'formJsonValue';

/**
 * The event-field extractors the standard form controls need, for
 * `createApp`'s `eventFields` (APP-FORMAT §5.4).
 *
 * One extractor, `formJsonValue`: the control's value parsed as JSON.
 * A select carries `option.key` (the view model's JSON text for the
 * typed enum value) and the `json` editor carries whatever the operator
 * typed. Unparsable text yields `null` rather than throwing, so a
 * half-typed JSON document is a validation problem — visible, fixable —
 * instead of a dispatch error; `json` fields therefore want a schema
 * that rejects `null` if absence is not acceptable.
 *
 * @example
 * createApp(doc, { node, eventFields: { ...formEventFields() } });
 *
 * @returns {Record<string, (event: any) => any>}
 */
export function formEventFields() {
  return {
    [JSON_FIELD]: (event) => {
      const raw = event?.target?.value;
      if (typeof raw !== 'string' || raw.trim() === '') return null;
      try {
        return JSON.parse(raw);
      }
      catch {
        return null;
      }
    },
  };
}

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
 * @property {{addItem?: string, removeItem?: string}} [labels] - Accessible
 *   names for the two symbol buttons. `@jarenjs/forms`'
 *   `formChromeLabels(catalog)` resolves them from a message catalog;
 *   the English defaults apply when absent.
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
  const labels = { addItem: 'Add item', removeItem: 'Remove item', ...options.labels };
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
        // the glyph is decoration; the accessible name is the label
        'aria-label': labels.removeItem,
        title: labels.removeItem,
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

  /**
   * A date-family `<input>`: the text-input binding plus the schema's
   * date bounds as `min`/`max`, so the picker itself refuses an
   * out-of-range date instead of the user finding out on submit. An
   * absent bound evaluates to the empty sequence, which omits the
   * attribute. HTML has no exclusive date bounds, so
   * `formatExclusive*` stays a submit-time check.
   */
  const dateInput = (type, action) => ['input', {
    type,
    value: '$.value',
    placeholder: '$.placeholder',
    readonly: '$.readOnly',
    disabled,
    min: '$.constraints.formatMinimum',
    max: '$.constraints.formatMaximum',
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
            'aria-label': labels.addItem,
            title: labels.addItem,
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
    // select: options are precomputed by the view model, and carry the
    // JSON text of their typed value so the round trip survives the DOM
    {
      match: `${root}..options[*]`,
      body: ['option', { value: '$.key', selected: '$.selected' }, '$.label'],
    },
    {
      match: ctl('select'),
      body: field(['select', {
        disabled,
        on: {
          change: { action: act.json, with: writeWith, event: [JSON_FIELD] },
        },
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
    // structured values: a JSON text editor. The view model precomputes
    // the text (`json`), so the control needs no encoder of its own.
    {
      match: ctl('json'),
      body: field(['textarea', {
        class: `${cls}-json`,
        rows: 4,
        spellcheck: 'false',
        readonly: '$.readOnly',
        disabled,
        on: { change: { action: act.json, with: writeWith, event: [JSON_FIELD] } },
      }, '$.json']),
    },
  ];

  // the text-input family: one rule per control, all through act.input
  for (const type of ['text', 'email', 'url', 'password', 'color']) {
    rules.push({ match: ctl(type), body: field(textInput(type, act.input)) });
  }
  // the date family, which additionally carries its bounds
  for (const type of ['date', 'datetime-local', 'time']) {
    rules.push({ match: ctl(type), body: field(dateInput(type, act.input)) });
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
    // the two JSON-carrying controls (typed select, json editor) share
    // one action: the extractor already produced a JSON value
    [act.json]: {
      patch: [{ op: writeOp, path: target, value: `$event.${JSON_FIELD}` }],
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
