//@ts-check
/**
 * @file `defineApp()` — one `jaren-app` 0.1 document (APP-FORMAT §2),
 * deep-frozen, that `createApp` takes unchanged, and beside it the JSON
 * Schema of its state.
 *
 * The two are answered as two members of ONE result and never merged:
 * the format has no slot for a state schema, and the hook that wants one
 * is `options.validateState` (§6), which is a `createApp` option rather
 * than a document member. `{ document, stateSchema }` is therefore what
 * the pen returns — the document is exactly the format's, and the schema
 * goes where the invariant lives.
 *
 * The initial state is DERIVED from the state builder's `default()`s
 * when the author does not write one: a member contributes its default,
 * an object recurses, and a REQUIRED member that resolves to nothing is
 * `JL0102` naming its pointer — because a state whose required member is
 * absent fails its own `validateState` on the boot transaction, which is
 * a fatal `JA0007` and a bad way to learn about a missing default.
 *
 * `defineApp` also holds one rule §4 leaves to run time: every literal
 * action name the view binds must be declared. The runtime reports an
 * unknown name as `JA2001` per dispatch, silently dropping the user's
 * click; the pen can see the whole document at once and refuses it.
 */

import { deepFreeze, setObjectMember, isJsonObject } from '@jarenjs/core/object';

import { LinqBuildError } from '../errors.js';
import { describeValue, requireJson, requireNameMap } from '../json-boundary.js';
import { isSchemaBuilder, schemaOf } from '../schema/brand.js';
import { ACTION } from './action.js';
import { SUB } from './sub.js';

const APP_VERSION = '0.1';

/** The members `defineApp()` takes. */
const APP_MEMBERS = Object.freeze(['state', 'initial', 'schema', 'view', 'actions', 'subs']);

/** A JSON value, copied: the document is a value of its own. @param {any} v */
const copy = (v) => JSON.parse(JSON.stringify(v));

/**
 * The initial value a schema's `default()`s describe.
 *
 * A `default` answers itself. An object schema recurses: every member
 * that resolves contributes, and a member `required` names but which
 * resolves to nothing is refused. An object resolves when it is
 * required, or when at least one of its own members did — so an
 * optional block of defaults appears and an optional empty one does not.
 *
 * @param {any} schema
 * @param {string} at - the pointer into the state, for the message
 * @param {boolean} needed - whether the parent requires this member
 * @returns {{ has: boolean, value?: any }}
 */
function initialOf(schema, at, needed) {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    return { has: false };
  }
  if (schema.default !== undefined) return { has: true, value: copy(schema.default) };
  if (schema.const !== undefined) return { has: true, value: copy(schema.const) };
  if (!isJsonObject(schema.properties)) return { has: false };

  const required = Array.isArray(schema.required) ? schema.required : [];
  const out = {};
  let any = false;
  for (const [name, member] of Object.entries(schema.properties)) {
    const isRequired = required.includes(name);
    const resolved = initialOf(member, `${at}/${name}`, isRequired);
    if (resolved.has) { setObjectMember(out, name, resolved.value); any = true; continue; }
    if (!isRequired) continue;
    throw new LinqBuildError('JL0102',
      `the initial state cannot be derived: '${at}/${name}' is required and declares no `
      + 'default — give the member a default(), or pass the whole initial state as '
      + "defineApp()'s 'initial'", `${at}/${name}`);
  }
  return needed || any ? { has: true, value: out } : { has: false };
}

/**
 * A literal action name, or `null`: a value starting with `$` is a query
 * expression naming the action at render time, which no pen can resolve.
 * @param {any} value
 * @returns {string | null}
 */
function literalName(value) {
  return typeof value === 'string' && value !== '' && value[0] !== '$' ? value : null;
}

/**
 * Every literal action name the view binds. §4 gives a binding two
 * forms and this reads both: a string under an `on` map (a vnode's
 * event props, VIEW-FORMAT's own member), and an object carrying an
 * `action` member anywhere — that member IS §4's vocabulary, so an
 * object holding one is a binding wherever a widget's `emit` will find
 * it.
 * @param {any} node
 * @param {Set<string>} out
 */
function collectBoundActions(node, out) {
  if (Array.isArray(node)) {
    for (const child of node) collectBoundActions(child, out);
    return;
  }
  if (node === null || typeof node !== 'object') return;
  for (const [key, value] of Object.entries(node)) {
    if (key === 'action') {
      const name = literalName(value);
      if (name !== null) out.add(name);
    }
    if (key === 'on' && isJsonObject(value)) {
      for (const binding of Object.values(value)) {
        const name = literalName(binding);
        if (name !== null) out.add(name);
      }
    }
    collectBoundActions(value, out);
  }
}

/**
 * The `view` member: a JSLT stylesheet, envelope or bare rule array
 * (§2), from the JSLT pen or by hand.
 * @param {any} view
 * @returns {any}
 */
function readView(view) {
  if (view === undefined) {
    throw new LinqBuildError('JL0101',
      'defineApp() needs a view — a JSLT stylesheet, from stylesheet([rule(…)]) or as a '
      + 'bare rule array; the format requires the member and the runtime refuses an app '
      + 'without one (JA0002)', '/view');
  }
  if (!Array.isArray(view) && !isJsonObject(view)) {
    throw new LinqBuildError('JL0101',
      `defineApp() view is a JSLT stylesheet document or a bare rule array, got ${describeValue(view)}`,
      '/view');
  }
  return copy(requireJson(view, 'defineApp() view'));
}

/**
 * Write a `jaren-app` 0.1 document (APP-FORMAT.md §2) and the JSON
 * Schema of its state.
 *
 * @param {any} spec - `{ state, initial?, schema?, view, actions?, subs? }`
 * @returns {{ document: any, stateSchema: any }} the deep-frozen document
 *   and the state's schema (`null` when the state is a plain value with
 *   no `schema` beside it)
 * @throws {LinqBuildError} `JL0101` a value the pen cannot spell;
 *   `JL0102` an initial state no default describes, or a bound action
 *   name `actions` does not declare
 * @example
 * const { document, stateSchema } = defineApp({
 *   state: s.object({ count: s.integer().default(0) }),
 *   view: [rule('$', (v) => ['h1', {}, 'Count: ', v.count])],
 *   actions: { inc: action((st) => transition({ patch: [replace((c) => c.count, st.count.add(1))] })) },
 * });
 * createApp(document, { node, validateState: new JarenValidator().compile(stateSchema) });
 */
export function defineApp(spec) {
  if (!isJsonObject(spec)) {
    throw new LinqBuildError('JL0101',
      `defineApp() takes { state, initial?, schema?, view, actions?, subs? }, got ${describeValue(spec)}`);
  }
  for (const key of Object.keys(spec)) {
    if (!APP_MEMBERS.includes(key)) {
      throw new LinqBuildError('JL0101',
        `defineApp() does not take '${key}' — it takes ${APP_MEMBERS.join(', ')}`, `/${key}`);
    }
  }

  const stateIsBuilder = isSchemaBuilder(spec.state);
  if (stateIsBuilder && spec.schema !== undefined) {
    throw new LinqBuildError('JL0101',
      "defineApp() takes 'schema' beside a state given as a plain JSON value — a state "
      + 'given as a builder IS its schema', '/schema');
  }
  if (spec.schema !== undefined && !isSchemaBuilder(spec.schema)) {
    throw new LinqBuildError('JL0101',
      `defineApp() schema is a schema-pen builder, got ${describeValue(spec.schema)}`, '/schema');
  }
  const stateSchema = stateIsBuilder ? schemaOf(spec.state)
    : spec.schema !== undefined ? schemaOf(spec.schema) : null;

  let state;
  if (spec.initial !== undefined) state = copy(requireJson(spec.initial, 'defineApp() initial'));
  else if (stateIsBuilder) state = initialOf(stateSchema, '', true).value;
  else if (spec.state !== undefined) state = copy(requireJson(spec.state, 'defineApp() state'));

  const view = readView(spec.view);

  /** @type {Record<string, any> | undefined} */
  let actions;
  if (spec.actions !== undefined) {
    if (!isJsonObject(spec.actions)) {
      throw new LinqBuildError('JL0101',
        `defineApp() actions is an object of named action() declarations, got ${describeValue(spec.actions)}`,
        '/actions');
    }
    requireNameMap(spec.actions, 'defineApp() actions', '/actions');
    actions = {};
    for (const [name, declared] of Object.entries(spec.actions)) {
      if (!isJsonObject(declared) || declared[ACTION] !== true) {
        throw new LinqBuildError('JL0101',
          `defineApp() action '${name}' is action((s, x) => transition(…)), got ${describeValue(declared)}`,
          `/actions/${name}`);
      }
      setObjectMember(actions, name, declared.document);
    }
  }

  /** @type {any[] | undefined} */
  let subs;
  if (spec.subs !== undefined) {
    if (!Array.isArray(spec.subs)) {
      throw new LinqBuildError('JL0101',
        `defineApp() subs is an array of sub() declarations, got ${describeValue(spec.subs)}`,
        '/subs');
    }
    subs = spec.subs.map((declared, i) => {
      if (!isJsonObject(declared) || declared[SUB] !== true) {
        throw new LinqBuildError('JL0101',
          `defineApp() subs[${i}] is sub(run, options?), got ${describeValue(declared)}`,
          `/subs/${i}`);
      }
      return { ...declared };
    });
  }

  /** @type {Set<string>} */
  const bound = new Set();
  collectBoundActions(view, bound);
  const declared = Object.keys(actions ?? {});
  for (const name of bound) {
    if (declared.includes(name)) continue;
    throw new LinqBuildError('JL0102',
      `the view binds the action '${name}', which "actions" does not declare — the runtime `
      + 'drops such a dispatch and reports JA2001 (APP-FORMAT §4), so the user\'s click does '
      + `nothing; the declared actions are ${declared.length === 0 ? 'none'
        : declared.map((n) => `'${n}'`).join(', ')}`, '/view');
  }

  const document = { $app: APP_VERSION };
  if (state !== undefined) document.state = state;
  document.view = view;
  if (actions !== undefined) document.actions = actions;
  if (subs !== undefined) document.subs = subs;

  return Object.freeze({
    document: deepFreeze(document),
    stateSchema: stateSchema === null ? null : deepFreeze(copy(stateSchema)),
  });
}
